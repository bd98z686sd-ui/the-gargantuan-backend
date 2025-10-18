# The Gargantuan — Backend (Auth Enabled)

Express backend for audio uploads, spectrum video generation, and a posts feed.
Includes optional admin auth via `x-admin-token` header controlled by `ADMIN_TOKEN` env var.

## Endpoints
- `GET /` — health
- `GET /api/health` — json health
- `GET /api/posts` — lists `.mp3` and `.mp4`, newest first
- `POST /api/upload` — multipart (`audio` field) — **requires token if `ADMIN_TOKEN` is set**
- `POST /api/generate-video` — `{"filename":"<uploaded.mp3>","title":"..."}` — **requires token if `ADMIN_TOKEN` is set**
- `GET /api/list` — raw files list (debug)

## Environment
- `PORT` (default `10000`)
- `UPLOAD_DIR` (default `./uploads`)
- `PUBLIC_BASE_URL` (optional absolute URL used in responses)
- `ADMIN_TOKEN` (optional; if set, protects publish endpoints)

## Deploy on Render
1. Create a new **Web Service** from this folder (Dockerfile included).
2. Add **Environment Variables** you want, e.g.:
   - `ADMIN_TOKEN=supersecret`
   - `PUBLIC_BASE_URL=https://the-gargantuan-backend.onrender.com`
3. Add a **Disk** mounted at `/app/uploads` to persist files.
4. After deploy, test:
   ```bash
   curl https://YOUR-RENDER-URL/api/health
   curl https://YOUR-RENDER-URL/api/posts
   ```

## Publish from CLI
```bash
# Upload (with admin token)
curl -X POST -H "x-admin-token: supersecret"   -F "audio=@/path/to/audio.mp3" https://YOUR-RENDER-URL/api/upload

# Generate video (with admin token)
curl -X POST -H "Content-Type: application/json" -H "x-admin-token: supersecret"   -d '{"filename":"PASTE_FILENAME","title":"The Gargantuan"}'   https://YOUR-RENDER-URL/api/generate-video
```
