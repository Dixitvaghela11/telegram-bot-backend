import fs from 'node:fs';
import path from 'node:path';

import axios from 'axios';
import { nanoid } from 'nanoid';
import mime from 'mime-types';

import { upsertVideo } from './store.js';

function storageDir() {
  const d = (process.env.STORAGE_DIR || '').trim();
  return d ? path.resolve(d) : path.resolve('storage');
}

function ensureStorage() {
  fs.mkdirSync(storageDir(), { recursive: true });
}

export function parseAllowedChatIds(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const ids = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n !== 0);
  return ids.length ? new Set(ids) : null;
}

export function isChatAllowed(allowedSet, chatId) {
  if (!allowedSet) return true;
  return allowedSet.has(chatId);
}

export async function downloadTelegramFile({ botToken, fileId, desiredName }) {
  ensureStorage();

  // 1) getFile -> file_path
  const fileInfo = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, {
    params: { file_id: fileId },
    timeout: 60_000,
  });
  const filePath = fileInfo?.data?.result?.file_path;
  if (!filePath) {
    throw new Error('Telegram getFile returned no file_path');
  }

  // 2) download
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const ext = path.extname(desiredName || '') || path.extname(filePath) || '';
  const safeBase = (desiredName || 'telegram_video').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const outName = `${Date.now()}_${nanoid(10)}_${safeBase}${ext}`;
  const outPath = path.join(storageDir(), outName);

  const resp = await axios.get(url, { responseType: 'stream', timeout: 120_000 });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath);
    resp.data.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
  });

  const stat = fs.statSync(outPath);
  const contentType =
    mime.lookup(outPath) || 'application/octet-stream';

  return {
    localPath: outPath,
    size: stat.size,
    contentType,
  };
}

export async function handleIncomingVideo({ botToken, baseUrl, message }) {
  // message.video or message.document
  const chatId = message.chat.id;
  const from = message.from?.username || message.from?.first_name || 'unknown';

  const video = message.video;
  const doc = message.document;

  const fileId = video?.file_id || doc?.file_id;
  if (!fileId) throw new Error('No file_id');

  const fileName =
    doc?.file_name ||
    (video ? `video_${video.width}x${video.height}_${video.duration}s.mp4` : 'video.mp4');

  const maxMb = Number(process.env.MAX_FILE_MB || '');
  if (Number.isFinite(maxMb) && maxMb > 0) {
    const sizeBytes = Number(video?.file_size || doc?.file_size || 0);
    if (Number.isFinite(sizeBytes) && sizeBytes > maxMb * 1024 * 1024) {
      throw new Error(`File too large. Max allowed is ${maxMb} MB`);
    }
  }

  const dl = await downloadTelegramFile({ botToken, fileId, desiredName: fileName });
  const id = nanoid(12);
  const createdAt = Date.now();

  const entry = {
    id,
    source: 'telegram-bot',
    chatId,
    from,
    telegramFileId: fileId,
    fileName,
    localPath: dl.localPath,
    size: dl.size,
    contentType: dl.contentType,
    createdAt,
    streamUrl: `${baseUrl.replace(/\/+$/, '')}/stream/${id}`,
  };

  upsertVideo(entry);
  return entry;
}

