# The Gargantuan Backend (v1.1.0 Hybrid)

## Run on Render
- Set WORKER_MODE=render
- Fill environment variables from .env.example
- Deploy normally

## Run locally
```bash
npm install
cp .env.example .env
npm start         # starts API
npm run worker    # runs local worker to process jobs
