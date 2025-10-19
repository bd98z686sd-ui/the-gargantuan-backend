FROM node:20-slim

# Install ffmpeg + fonts for drawtext/subtitles
RUN apt-get update && apt-get install -y --no-install-recommends     ffmpeg     fonts-dejavu-core     && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev || npm install
COPY . .

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]