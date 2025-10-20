# Build step
FROM node:20

WORKDIR /app
COPY . .

RUN npm install --package-lock-only || true && npm ci || npm install

EXPOSE 10000
CMD ["node", "server.js"]
