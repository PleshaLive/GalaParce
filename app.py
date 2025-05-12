# Файл: app.py (Версия с /raw_json для сырых логов и /raw_log_viewer)
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import logging
from collections import deque
import os
import re
import datetime
import html
import json

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')

# --- Хранилища данных ---
MAX_CHAT_MESSAGES = 100 # Макс. кол-во обработанных сообщений чата
MAX_RAW_LOGS = 250      # Макс. кол-во хранимых сырых строк лога (настройте по нужде)

# Очередь для обработанных сообщений чата (словари)
chat_messages = deque(maxlen=MAX_CHAT_MESSAGES)
# НОВАЯ Очередь для последних полученных сырых строк лога
raw_log_lines = deque(maxlen=MAX_RAW_LOGS)
# -------------------------

# --- Regex для парсинга чата (без изменений) ---
CHAT_REGEX_SAY = re.compile(
    r"""^\s*(?P<timestamp>\d{2}:\d{2}\.\d{3})\s+-\s+(?P<player_info>\".+?\"<\d+><\[U:\d:\d+\]><\w+>)\s+(?:say|say_team)\s+\"(?P<message>[^\"]*)\"\s*$""",
    re.VERBOSE | re.IGNORECASE
)
# -------------------------------------------

# --- Обновленный HTML для Навигации ---
NAV_HTML = """
<style>
    .navigation{text-align: center;padding: 10px 0;margin-bottom: 15px;background-color: #3b4048;border-radius: 5px;}
    .navigation a{color: #98c379;text-decoration: none;margin: 0 10px;padding: 5px 8px;border-radius: 4px;transition: background-color 0.2s ease;font-size: 0.95em;}
    .navigation a:hover,.navigation a:focus{background-color: #4a505a;text-decoration: underline;outline: none;}
</style>
<div class="navigation">
    <a href="/">Полный чат</a> |
    <a href="/messages_only">Только сообщения</a> |
    <a href="/raw_log_viewer">Показать Логи</a>  </div>
"""
# ----------------------------------

# --- HTML Шаблоны для /, /messages_only (без изменений, кроме вставки NAV_HTML) ---
HTML_TEMPLATE_MAIN = f"""<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CS2 Chat Viewer</title><style>body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Open Sans','Helvetica Neue',sans-serif;background-color:#282c34;color:#abb2bf;margin:0;padding:15px;display:flex;flex-direction:column;height:100vh;box-sizing:border-box}}h1{{text-align:center;color:#61afef;margin-top:0;margin-bottom:15px;font-weight:500}}#chat-container{{flex-grow:1;background-color:#21252b;border:1px solid #3b4048;border-radius:8px;padding:15px;overflow-y:auto;margin-bottom:10px;box-shadow:0 4px 10px rgba(0,0,0,0.2);display:flex;flex-direction:column}}#chat-container-inner{{margin-top:auto}}.message{{margin-bottom:10px;padding:8px 12px;border-radius:6px;background-color:#2c313a;word-wrap:break-word;line-height:1.5;max-width:90%}}.message:last-child{{margin-bottom:0}}#status{{text-align:center;font-size:.9em;color:#6a737d;height:20px;padding-top:5px}}.loader{{border:3px solid #3b4048;border-radius:50%;border-top:3px solid #61afef;width:14px;height:14px;animation:spin 1s linear infinite;display:inline-block;margin-left:8px;vertical-align:middle}}@keyframes spin{{0%{{transform:rotate(0)}}100%{{transform:rotate(360deg)}}}}</style></head><body>{NAV_HTML}<h1>CS2 Chat Viewer (Полный)</h1><div id="chat-container"><div id="chat-container-inner"><div class="message" style="align-self: center; color: #6a737d;">Загрузка сообщений...</div></div></div><div id="status">Ожидание данных... <span id="loading-indicator" style="display: none;" class="loader"></span></div><script>const chatContainerInner=document.getElementById('chat-container-inner');const chatContainer=document.getElementById('chat-container');const statusElement=document.getElementById('status');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;async function fetchMessages(){{if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{{const response=await fetch('/chat');if(!response.ok)throw new Error(`Ошибка сети: ${{response.status}}`);const messages=await response.json();const shouldScroll=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;chatContainerInner.innerHTML='';if(messages.length===0){{chatContainerInner.innerHTML='<div class="message" style="align-self: center; color: #6a737d;">Сообщений пока нет.</div>'}}else{{messages.forEach(data=>{{const messageElement=document.createElement('div');messageElement.className='message';messageElement.textContent=`[${{data.ts}}] ${{data.sender}}: ${{data.msg}}`;chatContainerInner.appendChild(messageElement)}})}}if(shouldScroll)chatContainer.scrollTop=chatContainer.scrollHeight;statusElement.textContent=`Обновлено: ${{new Date().toLocaleTimeString()}}`;errorCount=0}}catch(error){{console.error('Ошибка:',error);statusElement.textContent=`Ошибка: ${{error.message}}. #${{errorCount+1}}`;errorCount++;if(errorCount>=MAX_ERRORS){{statusElement.textContent+=' Обновление остановлено.';clearInterval(intervalId)}}}}finally{{isFetching=!1;loadingIndicator.style.display='none'}}}}const intervalId=setInterval(fetchMessages,3000);fetchMessages();</script></body></html>"""
HTML_TEMPLATE_MSG_ONLY = f"""<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Chat (Только сообщения)</title><style>body{{font-family:monospace;background-color:#1e1e1e;color:#d4d4d4;padding:10px;font-size:14px;line-height:1.6;}}h1 {{ color: #61afef; text-align: center; font-weight: 500; font-family: sans-serif; margin-top: 0; margin-bottom: 15px; }} #messages {{ background-color: #282c34; padding: 15px; border-radius: 5px; min-height: 50vh; }} #messages div {{ margin-bottom: 5px; }} </style></head><body>{NAV_HTML}<h1>Только сообщения</h1><div id="messages">Загрузка...</div><script>const container=document.getElementById('messages');async function fetchMsgOnly(){{try{{const response=await fetch('/chat');if(!response.ok)throw new Error('Network error');const messages=await response.json();container.innerHTML='';if(messages.length===0){{container.textContent='Нет сообщений.'}}else{{messages.forEach(data=>{{const div=document.createElement('div');div.textContent=data.msg;container.appendChild(div)}});window.scrollTo(0,document.body.scrollHeight)}}}}catch(error){{container.textContent='Ошибка загрузки.';console.error(error)}}}}setInterval(fetchMsgOnly,3000);fetchMsgOnly();</script></body></html>"""
# ----------------------------------

# --- НОВЫЙ HTML Шаблон для страницы с СЫРЫМИ ЛОГАМИ (/raw_log_viewer) ---
HTML_TEMPLATE_RAW_LOGS = f"""
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>CS2 Raw Logs</title>
    <style>
        body {{ font-family: monospace; background-color: #1e1e1e; color: #d4d4d4; padding: 15px; }}
        h1 {{ color: #61afef; text-align: center; font-weight: 500; font-family: sans-serif; margin-top: 0; margin-bottom: 15px;}}
        pre {{ font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; background-color: #282c34; padding: 15px; border-radius: 5px; border: 1px solid #3b4048; max-height: 70vh; overflow-y: auto; }}
        /* Используем стили из NAV_HTML */
    </style>
</head>
<body>
    {NAV_HTML} {/* Вставляем навигацию сюда */}
    <h1>Последние полученные строки лога</h1>
    <pre id="log-data">Загрузка...</pre>
    <script>
        const preElement = document.getElementById('log-data');
        async function fetchRawLogs() {{
            try {{
                // Запрашиваем данные с НОВОГО эндпоинта /raw_json
                const response = await fetch('/raw_json');
                if (!response.ok) throw new Error('Network error');
                const data = await response.json(); // Ожидаем массив строк
                // Отображаем строки лога, каждая на новой строке
                preElement.textContent = data.join('\\n'); // Объединяем массив строк через перевод строки
                // Прокрутка к последним логам (в самый низ <pre>)
                preElement.scrollTop = preElement.scrollHeight;
            }} catch (error) {{ preElement.textContent = 'Ошибка загрузки сырых логов.'; console.error(error); }}
        }}
        // Обновляем логи каждые 5 секунд
        setInterval(fetchRawLogs, 5000);
        fetchRawLogs(); // Первый запуск
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
    global chat_messages, raw_log_lines # Добавили raw_log_lines
    log_lines = []
    # Код получения log_lines из request
    if request.is_json:
        data = request.get_json(); log_lines = data.get('lines', []) if isinstance(data.get('lines'), list) else []
    else:
        raw_data = request.get_data(as_text=True); log_lines = raw_data.splitlines() if raw_data else []

    if not log_lines: return jsonify({"status": "error", "message": "No lines provided"}), 400
    app.logger.info(f"Log Parser: Получено {len(log_lines)} строк лога.")

    # --- НОВОЕ: Сохраняем сырые логи ---
    if log_lines:
        raw_log_lines.extend(log_lines)
    # ---------------------------------

    new_messages_found_count = 0
    parsed_messages_batch = []
    current_time = datetime.datetime.now(datetime.timezone.utc)

    # Обработка каждой строки лога для извлечения чата
    for line in log_lines:
        if not line: continue
        match = CHAT_REGEX_SAY.search(line) # Используем точный Regex для 'say'
        if match:
            # Если строка точно соответствует формату чата
            extracted_data = match.groupdict()
            player_info_str = extracted_data['player_info']
            name_match = re.search(r'^\"(.*?)\"', player_info_str)
            sender = html.escape(name_match.group(1).strip()) if name_match else html.escape(player_info_str.strip())
            message = html.escape(extracted_data['message'].strip())
            timestamp = extracted_data.get('timestamp', current_time.strftime('%H:%M:%S.%f')[:-3])

            if not message: continue # Пропускаем пустые

            message_obj = {"ts": timestamp, "sender": sender, "msg": message}
            parsed_messages_batch.append(message_obj)
            new_messages_found_count += 1
            app.logger.info(f"Log Parser: Распознано ЧАТ сообщение: [{timestamp}] {sender}: {message}")
        # else: app.logger.debug(f"Log Parser: Строка не является 'say' чатом: '{line}'")

    # Добавляем найденные сообщения чата в очередь chat_messages
    if parsed_messages_batch:
         chat_messages.extend(parsed_messages_batch)
         app.logger.info(f"Log Parser: Добавлено {new_messages_found_count} новых ЧАТ сообщений. Всего: {len(chat_messages)}")

    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк, найдено {new_messages_found_count} чат сообщений"}), 200


# Эндпоинт, возвращающий ТОЛЬКО структурированные СООБЩЕНИЯ ЧАТА
@app.route('/chat', methods=['GET'])
def get_structured_chat_data():
    return jsonify(list(chat_messages))


# --- НОВЫЙ Эндпоинт, возвращающий СЫРЫЕ СТРОКИ ЛОГА ---
@app.route('/raw_json', methods=['GET'])
def get_raw_log_lines():
    return jsonify(list(raw_log_lines))
# ---------------------------------------------------------


# Эндпоинт для главной страницы (/)
@app.route('/', methods=['GET'])
def index():
    return Response(HTML_TEMPLATE_MAIN, mimetype='text/html')


# Эндпоинт для страницы только с текстом сообщений (/messages_only)
@app.route('/messages_only', methods=['GET'])
def messages_only_page():
    return Response(HTML_TEMPLATE_MSG_ONLY, mimetype='text/html')


# --- НОВЫЙ Эндпоинт для страницы отображения СЫРЫХ ЛОГОВ ---
@app.route('/raw_log_viewer', methods=['GET'])
def raw_log_viewer_page():
     # Эта страница использует /raw_json для получения данных
    return Response(HTML_TEMPLATE_RAW_LOGS, mimetype='text/html')
# ------------------------------------------------------------


# --- Запуск приложения ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)