# Файл: app.py (Версия с доп. страницами /messages_only и /raw_chat_json)
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import logging
from collections import deque
import os
import re
import datetime
import html
import json # Для отображения JSON на странице

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')

MAX_MESSAGES = 100
# Теперь храним словари вместо форматированных строк
chat_messages = deque(maxlen=MAX_MESSAGES)
# Пример объекта: {'ts': '15:12:10', 'sender': 'Player1', 'msg': 'Hello!'}

# --- Регулярное выражение для парсинга сообщений чата ---
# ВАЖНО: Настройте этот Regex под ваши логи!
CHAT_LOG_REGEX = re.compile(
    r"^\s*(?:\*DEAD\*\s+)?(?P<sender>[^:@]+?)(?:\s*@\s*(?P<team>\w+)\s*)?\s*:\s*(?P<message>.+)\s*$",
    re.IGNORECASE
)
# -------------------------------------------

# --- HTML Шаблон для ГЛАВНОЙ страницы (/) ---
HTML_TEMPLATE_MAIN = """
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS2 Chat Viewer</title>
    <style>/* Стили те же, что и раньше (темная тема) */
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Open Sans','Helvetica Neue',sans-serif;background-color:#282c34;color:#abb2bf;margin:0;padding:15px;display:flex;flex-direction:column;height:100vh;box-sizing:border-box}h1{text-align:center;color:#61afef;margin-top:0;margin-bottom:15px;font-weight:500}#chat-container{flex-grow:1;background-color:#21252b;border:1px solid #3b4048;border-radius:8px;padding:15px;overflow-y:auto;margin-bottom:10px;box-shadow:0 4px 10px rgba(0,0,0,0.2);display:flex;flex-direction:column}#chat-container-inner{margin-top:auto}.message{margin-bottom:10px;padding:8px 12px;border-radius:6px;background-color:#2c313a;word-wrap:break-word;line-height:1.5;max-width:90%}.message:last-child{margin-bottom:0}#status{text-align:center;font-size:.9em;color:#6a737d;height:20px;padding-top:5px}.loader{border:3px solid #3b4048;border-radius:50%;border-top:3px solid #61afef;width:14px;height:14px;animation:spin 1s linear infinite;display:inline-block;margin-left:8px;vertical-align:middle}@keyframes spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
    </style>
</head>
<body>
    <h1>CS2 Chat Viewer (Полный)</h1>
    <div id="chat-container">
       <div id="chat-container-inner"> <div class="message" style="align-self: center; color: #6a737d;">Загрузка сообщений...</div>
       </div>
    </div>
    <div id="status">Ожидание данных... <span id="loading-indicator" style="display: none;" class="loader"></span></div>

    <script>
        const chatContainerInner = document.getElementById('chat-container-inner'); // Используем внутренний div
        const chatContainer = document.getElementById('chat-container');
        const statusElement = document.getElementById('status');
        const loadingIndicator = document.getElementById('loading-indicator');
        let isFetching = false, errorCount = 0; const MAX_ERRORS = 5;

        async function fetchMessages() {
            if (isFetching || errorCount >= MAX_ERRORS) return;
            isFetching = true; loadingIndicator.style.display = 'inline-block';

            try {
                const response = await fetch('/chat'); // Запрашиваем структурированные данные
                if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
                const messages = await response.json(); // Получаем массив объектов
                const shouldScroll = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 30;

                chatContainerInner.innerHTML = ''; // Очищаем внутренний div

                if (messages.length === 0) {
                    chatContainerInner.innerHTML = '<div class="message" style="align-self: center; color: #6a737d;">Сообщений пока нет.</div>';
                } else {
                    messages.forEach(data => { // Обрабатываем каждый объект
                        const messageElement = document.createElement('div');
                        messageElement.className = 'message';
                        // Форматируем строку из объекта на клиенте
                        messageElement.textContent = `[${data.ts}] ${data.sender}: ${data.msg}`;
                        chatContainerInner.appendChild(messageElement);
                    });
                }
                if (shouldScroll) chatContainer.scrollTop = chatContainer.scrollHeight;
                statusElement.textContent = `Обновлено: ${new Date().toLocaleTimeString()}`; errorCount = 0;
            } catch (error) {
                console.error('Ошибка:', error); statusElement.textContent = `Ошибка: ${error.message}. #${errorCount+1}`; errorCount++;
                if (errorCount >= MAX_ERRORS) { statusElement.textContent += ' Обновление остановлено.'; clearInterval(intervalId); }
            } finally {
                isFetching = false; loadingIndicator.style.display = 'none';
            }
        }
        const intervalId = setInterval(fetchMessages, 3000); fetchMessages();
    </script>
</body>
</html>
"""
# ----------------------------------

# --- HTML Шаблон для страницы ТОЛЬКО с ТЕКСТОМ сообщений (/messages_only) ---
HTML_TEMPLATE_MSG_ONLY = """
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8"><title>CS2 Chat (Только сообщения)</title>
    <style>
         body{font-family:monospace;background-color:#1e1e1e;color:#d4d4d4;padding:10px;font-size:14px;line-height:1.6;}
         div { margin-bottom: 5px; }
    </style>
</head>
<body>
    <div id="messages">Загрузка...</div>
    <script>
        const container = document.getElementById('messages');
        async function fetchMsgOnly() {
            try {
                const response = await fetch('/chat'); // Получаем те же данные
                if (!response.ok) throw new Error('Network error');
                const messages = await response.json(); // Массив объектов
                container.innerHTML = ''; // Очищаем
                if (messages.length === 0) {
                    container.textContent = 'Нет сообщений.';
                } else {
                    messages.forEach(data => {
                        const div = document.createElement('div');
                        // Отображаем ТОЛЬКО текст сообщения
                        div.textContent = data.msg;
                        container.appendChild(div);
                    });
                    // Прокрутка вниз
                    window.scrollTo(0, document.body.scrollHeight);
                }
            } catch (error) { container.textContent = 'Ошибка загрузки.'; console.error(error); }
        }
        setInterval(fetchMsgOnly, 3000); fetchMsgOnly();
    </script>
</body>
</html>
"""
# ----------------------------------

# --- HTML Шаблон для страницы с "чистым" JSON (/raw_chat_json) ---
HTML_TEMPLATE_RAW_JSON = """
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>CS2 Chat (Raw JSON)</title>
    <style>
        body { font-family: monospace; background-color: #1e1e1e; color: #d4d4d4; }
        pre { white-space: pre-wrap; word-wrap: break-word; }
    </style>
</head>
<body>
    <h1>Чистые данные из /chat (JSON)</h1>
    <pre id="json-data">Загрузка...</pre>
    <script>
        const preElement = document.getElementById('json-data');
        async function fetchRawJson() {
            try {
                const response = await fetch('/chat');
                if (!response.ok) throw new Error('Network error');
                const data = await response.json();
                // Отображаем JSON красиво отформатированным
                preElement.textContent = JSON.stringify(data, null, 2); // 2 пробела для отступа
            } catch (error) { preElement.textContent = 'Ошибка загрузки JSON.'; console.error(error); }
        }
        // Обновляем JSON раз в 5 секунд (можно реже)
        setInterval(fetchRawJson, 5000); fetchRawJson();
    </script>
</body>
</html>
"""
# ----------------------------------


# --- Эндпоинты Flask ---

# Эндпоинт для приема строк лога (/submit_logs и /gsi)
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST'])
def receive_and_parse_logs_handler():
    global chat_messages
    log_lines = []
    # (Код получения log_lines из request остался тем же)
    if request.is_json:
        data = request.get_json(); log_lines = data.get('lines', []) if isinstance(data.get('lines'), list) else []
    else:
        raw_data = request.get_data(as_text=True); log_lines = raw_data.splitlines() if raw_data else []

    if not log_lines: return jsonify({"status": "error", "message": "No lines provided"}), 400
    app.logger.info(f"Log Parser: Получено {len(log_lines)} строк лога.")

    new_messages_found_count = 0
    parsed_messages_batch = []
    current_time = datetime.datetime.now(datetime.timezone.utc) # Время получения пачки

    for line in log_lines:
        if not line: continue
        match = CHAT_LOG_REGEX.search(line)
        if match:
            extracted_data = match.groupdict()
            sender = html.escape(extracted_data['sender'].strip())
            message = html.escape(extracted_data['message'].strip())

            # Создаем СЛОВАРЬ сообщения
            message_obj = {
                "ts": current_time.strftime('%H:%M:%S'), # Время в формате ЧЧ:ММ:СС
                "sender": sender,
                "msg": message
            }
            parsed_messages_batch.append(message_obj)
            new_messages_found_count += 1
        # else: app.logger.debug(f"Log Parser: Строка не распознана: '{line}'")

    if parsed_messages_batch:
         # Добавляем объекты в очередь
         chat_messages.extend(parsed_messages_batch)
         app.logger.info(f"Log Parser: Добавлено {new_messages_found_count} новых сообщений. Всего: {len(chat_messages)}")

    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк, найдено {new_messages_found_count} сообщений"}), 200


# Эндпоинт, возвращающий структурированные данные чата (список объектов)
@app.route('/chat', methods=['GET'])
def get_structured_chat_data():
    # Возвращаем список словарей как JSON
    return jsonify(list(chat_messages))


# Эндпоинт для главной страницы (/) - использует HTML_TEMPLATE_MAIN
@app.route('/', methods=['GET'])
def index():
    return Response(HTML_TEMPLATE_MAIN, mimetype='text/html')


# НОВЫЙ Эндпоинт для страницы только с текстом сообщений (/messages_only)
@app.route('/messages_only', methods=['GET'])
def messages_only_page():
    return Response(HTML_TEMPLATE_MSG_ONLY, mimetype='text/html')


# НОВЫЙ Эндпоинт для страницы с "чистым" JSON (/raw_chat_json)
@app.route('/raw_chat_json', methods=['GET'])
def raw_chat_json_page():
     # Эта страница просто отображает JSON, который можно получить и напрямую по /chat
    return Response(HTML_TEMPLATE_RAW_JSON, mimetype='text/html')


# --- Запуск приложения ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)