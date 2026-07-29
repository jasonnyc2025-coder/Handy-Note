FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js migrate.js ./
COPY migrations ./migrations

EXPOSE 3000

CMD ["node", "server.js"]
