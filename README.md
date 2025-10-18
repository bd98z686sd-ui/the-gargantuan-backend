# Gargantuan Backend — S3 + Metadata

Env (Render → Settings → Environment):
PORT=10000
ADMIN_TOKEN=your-secret
PUBLIC_BASE_URL=https://the-gargantuan-backend.onrender.com
OPENAI_API_KEY=sk-...            # for Shorts
SHORTS_ENABLED=true
SHORTS_MAX_SECONDS=45

# R2 / S3
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=gargantuan
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE=https://pub-....r2.dev
S3_FORCE_PATH_STYLE=false