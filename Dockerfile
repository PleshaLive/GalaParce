# Используем официальный образ Node.js
FROM node:18-alpine

# Устанавливаем рабочую директорию в контейнере
WORKDIR /usr/src/app

# Копируем package.json и package-lock.json (или yarn.lock)
COPY package*.json ./

# Устанавливаем зависимости приложения
RUN npm install --production

# Копируем исходный код приложения
COPY . .

# Приложение будет слушать на порту, указанном Railway (через переменную PORT)
# EXPOSE 3001 # Не обязательно, Railway сделает это сам

# Команда для запуска приложения
CMD [ "node", "server.js" ]