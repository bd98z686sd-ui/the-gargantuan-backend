FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
# Use npm install directly to avoid errors when npm ci fails due to missing
# package-lock.json.  npm install will generate a lockfile and install
# dependencies in one step.
RUN npm install
COPY . .
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
