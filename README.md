# The Gargantuan — Backend (Final)

Express backend for audio uploads, simple spectrum video generation, and a posts feed for the frontend.

## Endpoints
- `GET /` — health
- `POST /api/upload` — multipart upload (`audio` field). Returns `{ filename, url, absoluteUrl }`.
- `POST /api/generate-video` — `{"filename":"<uploaded.mp3>", "title":"The Gargantuan"}` → creates MP4 spectrum.
- `GET /api/posts` — lists `.mp3` and `.mp4`, newest first.
- `GET /api/list` — raw file list (debug).

## Deploy on Render
1. Create a new **Web Service** from this folder (Dockerfile is included).
2. It will build with Node 20 and install ffmpeg.
3. Add a **Disk** at `/app/uploads` if you want files to persist between deploys.
4. After deploy: `https://YOUR-RENDER-URL/api/posts` should return JSON.

## Example usage
Upload:
```bash
curl -X POST -F "audio=@/path/to/audio.mp3" https://YOUR-RENDER-URL/api/upload
```

Generate video:
```bash
curl -X POST -H "Content-Type: application/json"   -d '{"filename":"PASTE_FILENAME_FROM_UPLOAD","title":"The Gargantuan"}'   https://YOUR-RENDER-URL/api/generate-video
```

List posts:
```bash
curl https://YOUR-RENDER-URL/api/posts
```
