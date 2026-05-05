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
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const got = (req.header('x-api-key') || '').trim();
  if (got && got === API_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/health', (_, res) =>
  res.json({
    ok: true,
    mode: WEBHOOK_URL ? 'webhook' : 'polling',
    hasApiKey: Boolean(API_KEY),
  }),
);

app.get('/api/videos', requireApiKey, (_, res) => {
  const items = listVideos().map((v) => ({
    id: v.id,
    fileName: v.fileName,
    size: v.size,
    createdAt: v.createdAt,
    streamUrl: v.streamUrl,
    contentType: v.contentType,
    from: v.from,
    chatId: v.chatId,
  }));
  res.json(items);
});

app.get('/api/videos/:id', requireApiKey, (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  res.json(v);
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

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply(
    'Send or forward a video to me. I will download it and create a streaming link.\n\n' +
      `Backend: ${BASE_URL}\n` +
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
    const entry = await handleIncomingVideo({
      botToken: BOT_TOKEN,
      baseUrl: BASE_URL,
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

// Telegram bot: webhook (recommended on Render) or polling (local dev).
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
        const telegramPath = `/telegram/webhook/${BOT_TOKEN}`;
        const webhookUrl = `${WEBHOOK_URL.replace(/\/+$/, '')}${telegramPath}`;

        // Telegraf provides Express middleware.
        app.use(telegramPath, express.json(), bot.webhookCallback(telegramPath));

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

