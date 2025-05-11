# Используем официальный образ Node.js
FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
CMD [ "node", "server.js" ]