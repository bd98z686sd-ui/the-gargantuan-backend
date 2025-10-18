FROM node:20-slim

# ffmpeg for video generation
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci || npm install

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
