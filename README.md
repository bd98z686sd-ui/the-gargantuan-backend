# The Gargantuan Backend — Spectral + R2

## Required Env (Render → Settings → Environment)
```
PORT=10000
ADMIN_TOKEN=change-me
PUBLIC_BASE_URL=https://the-gargantuan-backend.onrender.com

# Shorts (optional)
OPENAI_API_KEY=sk-...
SHORTS_ENABLED=true
SHORTS_MAX_SECONDS=45

# Cloudflare R2 (S3-compatible)
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=gargantuan
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE=https://pub-xxxxxxxxxxxxxxxxxxxxxxx.r2.dev
S3_FORCE_PATH_STYLE=false
```
## Endpoints
- `GET /api/health`
- `POST /api/upload` (header `x-admin-token`) form field `audio`
- `GET /api/posts`
- `POST /api/meta`  body `{ filename, title, tagline }`
- `POST /api/soft-delete`  body `{ filenames: string[] }`
- `POST /api/restore`      body `{ filenames: string[] }`
- `POST /api/generate-video`  body `{ filename, title? }`

## Notes
- Metadata is kept in `meta/_posts.json` (in R2) with `{ items: { [key]: {title,tagline} }, deleted: { [key]: true } }`.
- Soft-delete hides posts from `/api/posts`. Restore removes the flag.
- Spectral video uses ffmpeg showspectrum; output stored in `video/<base>.mp4`.