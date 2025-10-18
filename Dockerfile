FROM debian:12-slim

RUN apt-get update && apt-get install -y   curl ca-certificates gnupg &&   mkdir -p /etc/apt/keyrings &&   curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg &&   echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list &&   apt-get update && apt-get install -y nodejs ffmpeg &&   rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ENV PORT=10000
EXPOSE 10000
CMD ["npm","start"]
