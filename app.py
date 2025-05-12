# Файл: app.py
from flask import Flask, request, jsonify, Response # Добавлен Response для HTML
from flask_cors import CORS
import logging
from collections import deque
import os
import re # Модуль для регулярных выражений
import datetime # Для добавления временных меток
import html # Для экранирования HTML-тегов (безопасность)

app = Flask(__name__)
# Разрешаем CORS на случай, если захотите обращаться к /chat с других доменов
CORS(app)

# Настройка логирования (логи будут видны в консоли Railway)
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')

# Очередь для хранения последних N сообщений чата (в памяти)
MAX_MESSAGES = 100 # Можно настроить количество хранимых сообщений
chat_messages = deque(maxlen=MAX_MESSAGES)

# --- Регулярное выражение для парсинга сообщений чата из лога CS2 ---
# ВАЖНО: Это регулярное выражение - ПРИМЕР! Вам ОБЯЗАТЕЛЬНО нужно
# проверить его на ваших реальных логах CS2 и адаптировать под
# точный формат строк в вашем лог-файле.
CHAT_LOG_REGEX = re.compile(
    r"^\s*(?:\*DEAD\*\s+)?(?P<sender>[^:@]+?)(?:\s*@\s*(?P<team>\w+)\s*)?\s*:\s*(?P<message>.+)\s*$",
    re.IGNORECASE
)
# ---------------------------------------------------------------------

# --- HTML Шаблон страницы для отображения чата ---
# Мы встраиваем HTML/CSS/JS прямо в код Python для простоты.
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS2 Chat Viewer</title>
    <style>
        /* Стили для приятного отображения */
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
            background-color: #282c34; /* Темный фон */
            color: #abb2bf; /* Светлый текст */
            margin: 0;
            padding: 15px;
            display: flex;
            flex-direction: column;
            height: 100vh; /* Занимает всю высоту экрана */
            box-sizing: border-box;
        }
        h1 {
            text-align: center;
            color: #61afef; /* Синий акцент */
            margin-top: 0;
            margin-bottom: 15px;
            font-weight: 500;
        }
        #chat-container {
            flex-grow: 1; /* Занимает все доступное пространство */
            background-color: #21252b; /* Чуть светлее фона */
            border: 1px solid #3b4048;
            border-radius: 8px;
            padding: 15px;
            overflow-y: auto; /* Включает прокрутку по вертикали */
            margin-bottom: 10px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.2);
            /* Порядок сообщений: новые внизу (стандартный чат) */
            display: flex;
            flex-direction: column; /* Сообщения добавляются вниз */
        }
        .message {
            margin-bottom: 10px;
            padding: 8px 12px;
            border-radius: 6px;
            background-color: #2c313a; /* Фон сообщения */
            word-wrap: break-word;
            line-height: 1.5;
            max-width: 90%; /* Чтобы сообщения не растягивались на всю ширину */
        }
        .message:last-child {
             margin-bottom: 0;
        }
        /* Можно добавить стили для сообщений от разных отправителей или команд */
        #status {
            text-align: center;
            font-size: 0.9em;
            color: #6a737d; /* Серый статус */
            height: 20px;
            padding-top: 5px;
        }
        /* Индикатор загрузки */
        .loader {
            border: 3px solid #3b4048; /* Серый фон */
            border-radius: 50%;
            border-top: 3px solid #61afef; /* Синий цвет */
            width: 14px;
            height: 14px;
            animation: spin 1s linear infinite;
            display: inline-block;
            margin-left: 8px;
            vertical-align: middle;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <h1>CS2 Chat Viewer</h1>
    <div id="chat-container">
        <div class="message" style="align-self: center; color: #6a737d;">Загрузка сообщений...</div>
    </div>
    <div id="status">Ожидание данных... <span id="loading-indicator" style="display: none;" class="loader"></span></div>

    <script>
        const chatContainer = document.getElementById('chat-container');
        const statusElement = document.getElementById('status');
        const loadingIndicator = document.getElementById('loading-indicator');
        let isFetching = false;
        let errorCount = 0;
        const MAX_ERRORS = 5; // Остановить запросы после 5 ошибок подряд

        // Функция для запроса и отображения сообщений
        async function fetchMessages() {
            if (isFetching || errorCount >= MAX_ERRORS) return;

            isFetching = true;
            loadingIndicator.style.display = 'inline-block';

            try {
                // Запрос на эндпоинт /chat этого же сервера
                const response = await fetch('/chat'); // Относительный URL

                if (!response.ok) {
                    throw new Error(`Ошибка сети: ${response.status}`);
                }
                const messages = await response.json(); // Получаем массив строк сообщений

                const shouldScroll = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 30; // Проверяем, находился ли пользователь внизу перед обновлением

                // Очищаем контейнер перед добавлением новых данных
                chatContainer.innerHTML = '';

                if (messages.length === 0) {
                     chatContainer.innerHTML = '<div class="message" style="align-self: center; color: #6a737d;">Сообщений пока нет. Настройте отправку логов на /submit_logs.</div>';
                } else {
                    // Добавляем каждое сообщение как отдельный div
                    messages.forEach(msg => {
                        const messageElement = document.createElement('div');
                        messageElement.className = 'message';
                        // Используем textContent для безопасного отображения (предотвращает XSS)
                        messageElement.textContent = msg;
                        chatContainer.appendChild(messageElement); // Добавляем в конец контейнера
                    });
                }

                // Автоматическая прокрутка вниз, если пользователь был внизу
                if (shouldScroll) {
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }

                statusElement.textContent = `Обновлено: ${new Date().toLocaleTimeString()}`;
                errorCount = 0; // Сброс счетчика ошибок при успехе

            } catch (error) {
                console.error('Ошибка при загрузке сообщений:', error);
                statusElement.textContent = `Ошибка: ${error.message}. Попытка #${errorCount + 1}`;
                errorCount++;
                if (errorCount >= MAX_ERRORS) {
                    statusElement.textContent += ' Автообновление остановлено из-за ошибок.';
                    clearInterval(intervalId); // Остановить интервал
                }
            } finally {
                isFetching = false;
                loadingIndicator.style.display = 'none';
            }
        }

        // Устанавливаем интервал для автоматического обновления (каждые 3 секунды)
        const intervalId = setInterval(fetchMessages, 3000); // 3000 мс = 3 сек

        // Выполняем первый запрос при загрузке страницы
        fetchMessages();
    </script>
</body>
</html>
"""
# ----------------------------------

# --- Эндпоинты Flask ---

# Эндпоинт для приема строк лога от клиентской программы
@app.route('/submit_logs', methods=['POST'])
# @app.route('/gsi', methods=['POST']) # Можно оставить и /gsi, если клиент уже настроен на него
def receive_and_parse_logs_handler():
    global chat_messages

    # Определяем, пришли данные в JSON или как raw text
    log_lines = []
    if request.is_json:
        data = request.get_json()
        if 'lines' in data and isinstance(data['lines'], list):
            log_lines = data['lines']
            app.logger.info(f"Log Parser: Получено {len(log_lines)} строк лога через JSON.")
        else:
             app.logger.warning("Log Parser: Получен JSON, но отсутствует ключ 'lines' или это не список.")
             return jsonify({"status": "error", "message": "JSON должен содержать ключ 'lines' со списком строк"}), 400
    else:
        raw_data = request.get_data(as_text=True)
        if raw_data:
            log_lines = raw_data.splitlines()
            app.logger.info(f"Log Parser: Получено {len(log_lines)} строк лога как raw text.")
        else:
            app.logger.warning("Log Parser: Получен не JSON запрос без текстовых данных.")
            return jsonify({"status": "error", "message": "Запрос должен быть JSON с ключом 'lines' или raw text"}), 400

    new_messages_found_count = 0
    parsed_messages_batch = [] # Временный список для сообщений из этой пачки логов

    # Обработка каждой строки лога
    for line in log_lines:
        if not line: continue

        match = CHAT_LOG_REGEX.search(line) # Применяем Regex
        if match:
            # Если строка похожа на сообщение чата
            extracted_data = match.groupdict()
            # Экранируем символы HTML на всякий случай (дополнительная защита от XSS)
            sender = html.escape(extracted_data['sender'].strip())
            message = html.escape(extracted_data['message'].strip())

            # Формируем строку сообщения
            formatted_message = f"{sender}: {message}"
            # Добавляем временную метку сервера (UTC)
            timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S')
            full_message_with_time = f"[{timestamp}] {formatted_message}"

            parsed_messages_batch.append(full_message_with_time)
            new_messages_found_count += 1
        # else:
        #     app.logger.debug(f"Log Parser: Строка не распознана как чат: '{line}'") # Для отладки regex

    # Добавляем все найденные сообщения из этой пачки в основную очередь
    if parsed_messages_batch:
         # Добавляем в конец очереди (справа)
         chat_messages.extend(parsed_messages_batch)
         app.logger.info(f"Log Parser: Добавлено {new_messages_found_count} новых сообщений в очередь чата. Всего: {len(chat_messages)}")

    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк, найдено {new_messages_found_count} сообщений"}), 200


# Эндпоинт для веб-страницы (JavaScript будет запрашивать отсюда)
@app.route('/chat', methods=['GET'])
def get_chat_messages_for_frontend():
    # Возвращаем текущий список сообщений из очереди
    return jsonify(list(chat_messages))


# Эндпоинт для отображения самой веб-страницы
@app.route('/', methods=['GET'])
def index():
    # Возвращаем HTML-код страницы
    return Response(HTML_TEMPLATE, mimetype='text/html')


# --- Запуск приложения ---
if __name__ == '__main__':
    # Railway передает порт через переменную окружения PORT
    port = int(os.environ.get('PORT', 8080))
    # Для Railway используйте Gunicorn в Procfile и debug=False
    app.run(host='0.0.0.0', port=port, debug=False)