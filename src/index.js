import fs from 'node:fs';
import path from 'node:path';

import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { Telegraf } from 'telegraf';

import { getVideo, listVideos } from './store.js';
import { handleIncomingVideo, isChatAllowed, parseAllowedChatIds } from './telegram.js';

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PORT = Number(process.env.PORT || 8787);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_KEY = (process.env.API_KEY || '').trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').trim();
const allowedChats = parseAllowedChatIds(process.env.ALLOWED_CHAT_IDS);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN. Create backend/.env from backend/.env.example');
  process.exit(1);
}

const app = express();
// Needed on Render (behind proxy) so req.protocol uses X-Forwarded-Proto.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Telegram bot instance.
const bot = new Telegraf(BOT_TOKEN);

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const got = (req.header('x-api-key') || '').trim();
  if (got && got === API_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Telegram webhook route (defined BEFORE app.listen).
//
// Flow:
// - Telegram POSTs update JSON to: /telegram/webhook/<BOT_TOKEN>
// - Express passes JSON body to Telegraf via bot.handleUpdate(...)
// - We separately call setWebhook(WEBHOOK_URL + telegramPath) on startup.
const telegramPath = `/telegram/webhook/${BOT_TOKEN}`; // NO "bot" prefix in path.
if (WEBHOOK_URL) {
  // WEBHOOK_URL should be only host, no token/path.
  if (WEBHOOK_URL.includes(BOT_TOKEN) || WEBHOOK_URL.includes('/telegram/webhook/')) {
    console.warn(
      'WEBHOOK_URL looks wrong. It should be like https://your-app.onrender.com (no token/path). Got:',
      WEBHOOK_URL,
    );
  }
  console.log('Webhook endpoint ready:', telegramPath);
  app.post(telegramPath, express.json(), (req, res) => {
    bot.handleUpdate(req.body, res);
  });
}

function publicBaseUrl(req) {
  // Prefer explicit env for stable absolute links.
  const explicit = (WEBHOOK_URL || BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  // Otherwise derive from current request.
  const proto = (req.header('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = (req.header('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function attachStreamUrl(req, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const id = obj.id?.toString?.() ?? '';
  if (!id) return obj;
  const base = publicBaseUrl(req);
  if (!base) return obj;
  return { ...obj, streamUrl: `${base}/stream/${id}` };
}

app.get('/health', (_, res) =>
  res.json({
    ok: true,
    mode: WEBHOOK_URL ? 'webhook' : 'polling',
    hasApiKey: Boolean(API_KEY),
  }),
);

app.get('/api/videos', requireApiKey, (_, res) => {
  try {
    const items = listVideos().map((v) =>
      attachStreamUrl(
        _,
        {
          id: v.id,
          fileName: v.fileName,
          size: v.size,
          createdAt: v.createdAt,
          streamUrl: v.streamUrl,
          contentType: v.contentType,
          from: v.from,
          chatId: v.chatId,
          chatTitle: v.chatTitle,
          chatType: v.chatType,
        },
      ),
    );
    res.json(items);
  } catch (e) {
    console.error('GET /api/videos failed', e);
    res.status(500).json({ error: 'internal', message: String(e?.message || e) });
  }
});

app.get('/api/videos/:id', requireApiKey, (req, res) => {
  try {
    const v = getVideo(req.params.id);
    if (!v) return res.status(404).json({ error: 'not_found' });
    return res.json(attachStreamUrl(req, v));
  } catch (e) {
    console.error('GET /api/videos/:id failed', e);
    return res.status(500).json({ error: 'internal', message: String(e?.message || e) });
  }
});

// Debug: check Telegram webhook status on production.
// Keep behind API key when enabled.
app.get('/debug/telegram/webhook', requireApiKey, async (_req, res) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    res.json(j);
  } catch (e) {
    console.error('GET /debug/telegram/webhook failed', e);
    res.status(500).json({ error: 'internal', message: String(e?.message || e) });
  }
});

// Direct streaming from disk with Range support.
app.get('/stream/:id', requireApiKey, (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).end();
  const filePath = v.localPath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = v.contentType || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(v.fileName || path.basename(filePath))}"`,
  );

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Range: bytes=start-end
  const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
  if (!m) {
    res.status(416).end();
    return;
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : Math.min(start + 2 * 1024 * 1024 - 1, fileSize - 1);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize) {
    res.status(416).end();
    return;
  }
  const safeEnd = Math.min(end, fileSize - 1);
  const chunkSize = safeEnd - start + 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${fileSize}`);
  res.setHeader('Content-Length', chunkSize);
  fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
});

app.listen(PORT, () => {
  console.log(`HTTP server: ${BASE_URL} (port ${PORT})`);
  if (API_KEY) console.log('HTTP API key: enabled');
  if (allowedChats) console.log(`Allowed chat IDs: ${Array.from(allowedChats).join(', ')}`);
  if (WEBHOOK_URL) console.log(`Telegram bot: webhook mode (${WEBHOOK_URL})`);
  else console.log('Telegram bot: polling mode');
});

bot.start(async (ctx) => {
  const publicUrl = (WEBHOOK_URL || BASE_URL).replace(/\/+$/, '');
  await ctx.reply(
    'Send or forward a video to me. I will download it and create a streaming link.\n\n' +
      `Backend: ${publicUrl}\n` +
      'Tip: Set ALLOWED_CHAT_IDS in .env to restrict who can upload.',
  );
});

bot.on(['video', 'document'], async (ctx) => {
  const msg = ctx.message;
  const chatId = msg.chat.id;
  if (!isChatAllowed(allowedChats, chatId)) {
    await ctx.reply('Not allowed.');
    return;
  }

  // Only accept videos or video-like documents.
  if (msg.document) {
    const mime = (msg.document.mime_type || '').toLowerCase();
    const name = (msg.document.file_name || '').toLowerCase();
    const isVideo = mime.startsWith('video/') || name.endsWith('.mp4') || name.endsWith('.mkv');
    if (!isVideo) {
      await ctx.reply('Send a video file (mp4/mkv) or a Telegram video.');
      return;
    }
  }

  await ctx.reply('Downloading…');
  try {
    const publicUrl = (WEBHOOK_URL || BASE_URL).replace(/\/+$/, '');
    const entry = await handleIncomingVideo({
      botToken: BOT_TOKEN,
      baseUrl: publicUrl,
      message: msg,
    });
    await ctx.reply(
      `Ready.\n\nName: ${entry.fileName}\nSize: ${entry.size} bytes\n\nStream: ${entry.streamUrl}`,
      { disable_web_page_preview: true },
    );
  } catch (e) {
    await ctx.reply(`Failed: ${e?.message || e}`);
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startTelegramBotWithRetry() {
  // Keep HTTP server alive even if Telegram is temporarily unreachable.
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      if (WEBHOOK_URL) {
        const webhookUrl = `${WEBHOOK_URL.replace(/\/+$/, '')}${telegramPath}`;
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`Telegram bot: webhook set (${webhookUrl})`);
        return;
      }

      await bot.launch();
      console.log('Telegram bot: polling started');
      return;
    } catch (e) {
      const waitMs = Math.min(60_000, 2000 * attempt);
      console.error(`Telegram bot start failed (attempt ${attempt}). Retrying in ${waitMs}ms`, e);
      await sleep(waitMs);
    }
  }
}

startTelegramBotWithRetry().catch((e) => console.error('Telegram bot start loop failed', e));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

