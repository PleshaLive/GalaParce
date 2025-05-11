# Используем официальный образ Node.js
FROM node:18-alpine

# Устанавливаем рабочую директорию в контейнере
WORKDIR /usr/src/app

# Копируем package.json и package-lock.json (или yarn.lock)
# Это делается отдельно, чтобы использовать кэширование слоев Docker
COPY package*.json ./

# Устанавливаем зависимости приложения (только production, если нет devDependencies для сборки)
RUN npm install --omit=dev --no-audit --no-fund

# Копируем исходный код приложения
COPY . .

# Приложение будет слушать на порту, указанном Railway (через переменную PORT)
# EXPOSE 3001 # Не обязательно, Railway сделает это сам, если PORT задан

# Команда для запуска приложения
CMD [ "node", "server.js" ]