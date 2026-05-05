# Telegram Bot Streaming Backend (Node.js)

This backend lets you **send/forward videos to your Telegram bot** and then **stream them over HTTP** (with Range support for seeking).

## Setup

1. Create a bot with **@BotFather** and copy the token.
2. From `backend/`:

```bash
npm install
copy .env.example .env
```

3. Edit `backend/.env`:
- **`BOT_TOKEN`**: your token
- **`BASE_URL`**: your backend URL (LAN IP is best for Android devices)
- **Render (recommended)**: set **`WEBHOOK_URL`** to your public service URL (example: `https://your-service.onrender.com`)
- **Render disk (recommended)**: set **`DATA_DIR`** and **`STORAGE_DIR`** to your disk mount paths
- Optional: **`ALLOWED_CHAT_IDS`** (recommended)
- Optional: **`API_KEY`** for HTTP endpoints
- Optional: **`MAX_FILE_MB`** (reject large videos early)

## Run

```bash
npm run dev
```

## Render deployment notes

- Create a **Web Service** with:
  - **Root Directory**: `backend`
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
- Add environment variables:
  - **`BOT_TOKEN`**
  - **`BASE_URL`**: `https://<your-service>.onrender.com`
  - **`WEBHOOK_URL`**: `https://<your-service>.onrender.com` (enables webhook mode)
  - **`API_KEY`**: recommended
  - Optional: **`ALLOWED_CHAT_IDS`**, **`MAX_FILE_MB`**
- Add a **Persistent Disk** (recommended) and set:
  - **`DATA_DIR`**: (disk mount) `/var/data`
  - **`STORAGE_DIR`**: (disk mount) `/var/storage`

If you do not configure `WEBHOOK_URL`, the bot will fall back to polling (fine for local dev).

Backend endpoints:
- `GET /health`
- `GET /api/videos`
- `GET /api/videos/:id`
- `GET /stream/:id` (use in your Flutter player)

## Notes

- Files are downloaded into `backend/storage/`
- Metadata is stored in `backend/data/videos.json`
- To restrict uploads: set `ALLOWED_CHAT_IDS` to your chat id(s)

