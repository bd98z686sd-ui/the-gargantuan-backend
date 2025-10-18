# The Gargantuan — Backend (with Edit/Delete)
This backend includes:
- Metadata for titles in `uploads/_meta.json`
- Protected edit and delete endpoints
- All upload/generate features with `ADMIN_TOKEN` auth

## Endpoints
- GET /api/posts — lists posts
- POST /api/upload — upload audio (auth required)
- POST /api/generate-video — generate mp4 (auth required)
- PATCH /api/posts/:id — edit title (auth required)
- DELETE /api/posts/:id — delete post (auth required)
