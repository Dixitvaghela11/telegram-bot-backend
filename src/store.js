import fs from 'node:fs';
import path from 'node:path';

function dataDir() {
  const d = (process.env.DATA_DIR || '').trim();
  return d ? path.resolve(d) : path.resolve('data');
}

function dbPath() {
  return path.join(dataDir(), 'videos.json');
}

function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

function loadAll() {
  ensureDataDir();
  const p = dbPath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(items) {
  ensureDataDir();
  const p = dbPath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function listVideos() {
  const items = loadAll();
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return items;
}

export function getVideo(id) {
  return loadAll().find((v) => v.id === id) || null;
}

export function upsertVideo(video) {
  const items = loadAll();
  const idx = items.findIndex((v) => v.id === video.id);
  if (idx >= 0) items[idx] = video;
  else items.push(video);
  saveAll(items);
  return video;
}

