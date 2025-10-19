# The Gargantuan Backend (ffmpeg upgrade)

Real spectral video generation with optional burned-in captions (Whisper).

## Deploy on Render (Docker)
1) Create a **Docker** Web Service on Render from this repo.
2) No build command needed (Dockerfile included). Start command auto: `node server.js`.
3) Set env vars:
   - ADMIN_TOKEN
   - OPENAI_API_KEY (optional, for captions)
   - S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET
   - S3_PUBLIC_BASE
   - PORT=10000
4) Deploy.

## Endpoints
- `POST /api/upload` (auth) — `audio` or `image` file → R2 + post
- `GET /api/posts` — list active posts
- `DELETE /api/posts/:id` (auth) — soft delete
- `POST /api/posts/:id/restore` (auth) — restore
- `POST /api/generate-video` (auth) — body `{ filename, title?, whisper? }`
  - Downloads audio from R2
  - (Optional) transcribes with Whisper to SRT
  - Renders 1080x1920 blue canvas + central waveform + title + (optional) subtitles
  - Uploads MP4 `video/...mp4` to R2 and updates the post

## Notes
- Uses **-filter_complex only** to avoid the `-vf/-af` conflict.
- Font: DejaVu installed via Docker for drawtext/subtitles.
- If you need captions but don’t want Whisper, set `whisper:false` (default) and it will render without subtitles.