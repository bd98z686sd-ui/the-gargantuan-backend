# Gargantuan Backend — S3 Object Storage (R2/B2/S3 compatible)

## Env
ADMIN_TOKEN=your-secret
OPENAI_API_KEY=sk-...
SHORTS_ENABLED=true
SHORTS_MAX_SECONDS=45
PORT=10000
PUBLIC_BASE_URL=https://the-gargantuan-backend.onrender.com  # optional, only used in JSON
# S3 / object storage
S3_ENDPOINT=https://<endpoint>        # e.g. https://<accountid>.r2.cloudflarestorage.com or https://s3.us-west-000.backblazeb2.com
S3_REGION=auto                        # some providers accept 'auto' (R2); use real region for S3/B2
S3_BUCKET=gargantuan
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE=https://cdn.example.com  # public base URL for objects (bucket/domain); if omitted, presigned URLs are returned
S3_FORCE_PATH_STYLE=false             # set true for Backblaze B2 or MinIO
