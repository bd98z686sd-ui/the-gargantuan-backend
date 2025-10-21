FROM node:20
WORKDIR /app
COPY package.json ./
RUN npm install --package-lock-only || true && npm ci || npm install
COPY . .
EXPOSE 10000
CMD ["node","server.js"]