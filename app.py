# Файл: app.py (Версия с обработкой /submit_logs и /gsi)
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import logging
from collections import deque
import os
import re
import datetime
import html

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')

MAX_MESSAGES = 100
chat_messages = deque(maxlen=MAX_MESSAGES)

# --- Регулярное выражение для парсинга сообщений чата из лога CS2 ---
# ВАЖНО: Настройте этот Regex под ваши логи!
CHAT_LOG_REGEX = re.compile(
    r"^\s*(?:\*DEAD\*\s+)?(?P<sender>[^:@]+?)(?:\s*@\s*(?P<team>\w+)\s*)?\s*:\s*(?P<message>.+)\s*$",
    re.IGNORECASE
)
# -------------------------------------------

# --- HTML Шаблон страницы для отображения чата ---
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
        #status {
            text-align: center;
            font-size: 0.9em;
            color: #6a737d; /* Серый статус */
            height: 20px;
            padding-top: 5px;
        }
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
        const MAX_ERRORS = 5;

        async function fetchMessages() {
            if (isFetching || errorCount >= MAX_ERRORS) return;
            isFetching = true;
            loadingIndicator.style.display = 'inline-block';

            try {
                const response = await fetch('/chat');
                if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
                const messages = await response.json();
                const shouldScroll = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 30;
                chatContainer.innerHTML = '';

                if (messages.length === 0) {
                     chatContainer.innerHTML = '<div class="message" style="align-self: center; color: #6a737d;">Сообщений пока нет. Настройте отправку логов.</div>';
                } else {
                    messages.forEach(msg => {
                        const messageElement = document.createElement('div');
                        messageElement.className = 'message';
                        messageElement.textContent = msg;
                        chatContainer.appendChild(messageElement);
                    });
                }
                if (shouldScroll) chatContainer.scrollTop = chatContainer.scrollHeight;
                statusElement.textContent = `Обновлено: ${new Date().toLocaleTimeString()}`;
                errorCount = 0;
            } catch (error) {
                console.error('Ошибка при загрузке сообщений:', error);
                statusElement.textContent = `Ошибка: ${error.message}. Попытка #${errorCount + 1}`;
                errorCount++;
                if (errorCount >= MAX_ERRORS) {
                    statusElement.textContent += ' Автообновление остановлено.';
                    clearInterval(intervalId);
                }
            } finally {
                isFetching = false;
                loadingIndicator.style.display = 'none';
            }
        }
        const intervalId = setInterval(fetchMessages, 3000);
        fetchMessages();
    </script>
</body>
</html>
"""
# ----------------------------------

# --- Эндпоинты Flask ---

# Эндпоинт для приема строк лога от клиентской программы
# Теперь слушает ОБА пути: /submit_logs и /gsi
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST']) # <--- ИЗМЕНЕНИЕ ЗДЕСЬ
def receive_and_parse_logs_handler():
    global chat_messages # Убеждаемся, что используем глобальную переменную

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
    parsed_messages_batch = []

    for line in log_lines:
        if not line: continue

        match = CHAT_LOG_REGEX.search(line)
        if match:
            extracted_data = match.groupdict()
            sender = html.escape(extracted_data['sender'].strip())
            message = html.escape(extracted_data['message'].strip())
            formatted_message = f"{sender}: {message}"
            timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S')
            full_message_with_time = f"[{timestamp}] {formatted_message}"
            parsed_messages_batch.append(full_message_with_time)
            new_messages_found_count += 1
        # else:
        #     app.logger.debug(f"Log Parser: Строка не распознана как чат: '{line}'")

    if parsed_messages_batch:
         chat_messages.extend(parsed_messages_batch)
         app.logger.info(f"Log Parser: Добавлено {new_messages_found_count} новых сообщений в очередь чата. Всего: {len(chat_messages)}")

    # Отвечаем успехом (200 ОК) при успешной обработке
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк, найдено {new_messages_found_count} сообщений"}), 200


# Эндпоинт для веб-страницы (JavaScript будет запрашивать отсюда)
@app.route('/chat', methods=['GET'])
def get_chat_messages_for_frontend():
    return jsonify(list(chat_messages))


# Эндпоинт для отображения самой веб-страницы
@app.route('/', methods=['GET'])
def index():
    return Response(HTML_TEMPLATE, mimetype='text/html')


# --- Запуск приложения ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    # Для Railway используйте Gunicorn в Procfile и debug=False
    app.run(host='0.0.0.0', port=port, debug=False)