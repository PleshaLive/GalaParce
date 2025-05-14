# Файл: app.py
import logging
import os
import re
import datetime
import html
from collections import deque
from flask import Flask, request, jsonify, Response, make_response # <--- ИЗМЕНЕНИЕ ЗДЕСЬ
from flask_cors import CORS
import jwt # Библиотека для работы с JWT
import base64 # Для декодирования секрета из Base64

# --- Flask App Setup ---
app = Flask(__name__)

# --- Logging Configuration ---
# Уменьшаем количество логов от встроенного сервера Flask (werkzeug)
logging.getLogger('werkzeug').setLevel(logging.WARNING)
# Настраиваем формат и уровень логгирования для нашего приложения
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s: %(message)s')
logger = logging.getLogger(__name__) # Создаем экземпляр логгера

# --- Конфигурация Расширения ---
# Получаем секрет расширения Twitch из переменной окружения.
TWITCH_EXTENSION_SECRET_B64 = os.environ.get('TWITCH_EXTENSION_SECRET')
EXTENSION_SECRET = None

if not TWITCH_EXTENSION_SECRET_B64:
    logger.error("КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения TWITCH_EXTENSION_SECRET не установлена!")
else:
    try:
        EXTENSION_SECRET = base64.b64decode(TWITCH_EXTENSION_SECRET_B64)
        logger.info("Секрет расширения Twitch успешно загружен и декодирован.")
    except Exception as e:
        logger.error(f"Ошибка декодирования TWITCH_EXTENSION_SECRET из Base64: {e}")

# --- CORS Configuration for Production ---
TWITCH_EXTENSION_ID_ENV = os.environ.get('TWITCH_EXTENSION_ID')

if not TWITCH_EXTENSION_ID_ENV:
    logger.warning("Переменная окружения TWITCH_EXTENSION_ID не установлена! CORS будет разрешен для всех источников для /chat, что НЕ рекомендуется для продакшена.")
    chat_origins = "*"
else:
    chat_origins = [
        f"https://{TWITCH_EXTENSION_ID_ENV}.ext-twitch.tv",
        "https://supervisor.ext-twitch.tv"
    ]

submit_logs_origins = "*" # Для /submit_logs и /gsi оставляем пока так

CORS(app, resources={
    r"/chat": {"origins": chat_origins, "methods": ["GET", "OPTIONS"], "supports_credentials": True},
    r"/submit_logs": {"origins": submit_logs_origins, "methods": ["POST", "OPTIONS"]},
    r"/gsi": {"origins": submit_logs_origins, "methods": ["POST", "OPTIONS"]}
}, supports_credentials=True)


# --- Data Storage ---
MAX_CHAT_MESSAGES_DISPLAY = 100
display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY)

# --- Regex Definition for Chat ---
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* (?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?      
    (?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})  
    \s+-\s+                                  
    \"(?P<player_name>.+?)<(?P<userid>\d+)><(?P<steamid>\[U:\d:\d+\])><(?P<player_team>\w+)>\"
    \s+                                      
    (?P<chat_command>say|say_team)           
    \s+                                      
    \"(?P<message>.*)\"                      
    \s*$                                     
    """,
    re.VERBOSE | re.IGNORECASE
)
# ----------------------------------------------

# --- HTML (MINIMAL_CHAT_HTML_WITH_CSS остается как плейсхолдер, так как этот файл отвечает за бэкенд) ---
MINIMAL_CHAT_HTML_WITH_CSS = """<!DOCTYPE html><html lang="ru">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS2 Chat Viewer (Сайт)</title>
    <style>body{font-family:sans-serif;background-color:#222;color:#eee;margin:0;padding:10px;display:flex;flex-direction:column;height:100vh;}#chat-container{flex-grow:1;overflow-y:auto;border:1px solid #444;padding:10px;background-color:#333;border-radius:5px;} .message{margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid #444;} .sender{font-weight:bold;} .team-CT{color:#87CEFA;} .team-T{color:#FFA07A;} .team-Other{color:#D3D3D3;}</style>
</head>
<body>
    <h1>Чат Игры (версия для сайта)</h1>
    <div id="chat-container"><p>Загрузка сообщений...</p></div>
    <script>
        const chatContainer = document.getElementById('chat-container');
        async function fetchSiteMessages() {
            try {
                const response = await fetch('/chat');
                if (response.status === 401) { 
                        chatContainer.innerHTML = '<p>Ошибка: Доступ к этому чату с сайта ограничен. Используйте Twitch Extension.</p>';
                        return;
                }
                if (!response.ok) throw new Error('Network response was not ok.');
                const messages = await response.json();
                chatContainer.innerHTML = ''; 
                if (messages.length === 0) {
                    chatContainer.innerHTML = '<p>Сообщений пока нет.</p>';
                } else {
                    messages.forEach(msg => {
                        const div = document.createElement('div');
                        div.classList.add('message');
                        const senderSpan = document.createElement('span');
                        senderSpan.classList.add('sender', 'team-' + msg.team);
                        senderSpan.textContent = msg.sender + ': ';
                        const msgSpan = document.createElement('span');
                        msgSpan.textContent = msg.msg;
                        div.appendChild(senderSpan);
                        div.appendChild(msgSpan);
                        chatContainer.appendChild(div);
                    });
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }
            } catch (error) {
                console.error('Could not fetch messages for site:', error);
                chatContainer.innerHTML = '<p>Не удалось загрузить сообщения.</p>';
            }
        }
        chatContainer.innerHTML = '<p>Для просмотра чата используйте Twitch Extension. Этот сайт-просмотрщик может быть неактивен из-за настроек безопасности (требуется JWT для /chat).</p>';
    </script>
</body></html>"""


# --- Декоратор для проверки JWT ---
def token_required(f):
    def decorated(*args, **kwargs):
        if not EXTENSION_SECRET:
            logger.error("EXTENSION_SECRET не настроен на сервере. Аутентификация невозможна.")
            return jsonify({"error": "Сервер не настроен для аутентификации расширения (отсутствует секрет)"}), 500

        token = None
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            try:
                token = auth_header.split(" ")[1]
            except IndexError:
                logger.warning("Некорректный формат заголовка Authorization. Отсутствует Bearer токен.")
                return jsonify({"error": "Некорректный формат заголовка Authorization"}), 401
        
        if not token:
            logger.warning("Токен авторизации отсутствует в запросе.")
            return jsonify({"error": "Токен авторизации отсутствует"}), 401

        try:
            payload = jwt.decode(token, EXTENSION_SECRET, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            logger.warning("Получен просроченный JWT (ExpiredSignatureError).")
            return jsonify({"error": "Срок действия токена истек"}), 401
        except jwt.InvalidTokenError as e:
            logger.warning(f"Получен невалидный JWT: {e}")
            return jsonify({"error": "Невалидный токен авторизации"}), 401
        
        return f(*args, **kwargs)
    
    decorated.__name__ = f.__name__
    return decorated

# --- Log Submission Handler ---
@app.route('/submit_logs', methods=['POST', 'OPTIONS'])
@app.route('/gsi', methods=['POST', 'OPTIONS'])
def receive_and_parse_logs_handler():
    if request.method == 'OPTIONS':
        return _build_cors_preflight_response()

    global display_chat_messages
    log_lines = []
    
    if request.is_json:
        data = request.get_json()
        if isinstance(data, dict) and 'lines' in data and isinstance(data.get('lines'), list):
            log_lines = data.get('lines', [])
        elif isinstance(data, list):
            log_lines = data
        else:
            logger.warning("Получен JSON, но ключ 'lines' отсутствует, не список, или формат неизвестен.")
            raw_data_fallback = request.get_data(as_text=True)
            if raw_data_fallback: log_lines = raw_data_fallback.splitlines()
    else:
        raw_data = request.get_data(as_text=True)
        if raw_data: log_lines = raw_data.splitlines()

    if not log_lines:
        return jsonify({"status": "error", "message": "Строки не предоставлены или не удалось их извлечь"}), 400
    
    new_messages_added_count = 0

    for line_content in log_lines:
        if not line_content.strip(): continue
            
        chat_match = CHAT_REGEX_SAY.search(line_content)
        if chat_match:
            extracted_data = chat_match.groupdict()
            chat_command_type = extracted_data['chat_command'].lower()
            sender_name_raw = extracted_data['player_name'].strip()
            message_text_raw = extracted_data['message'].strip()
            
            if message_text_raw.lower().startswith("!team1"):
                command_param_part = message_text_raw[len("!team1"):].strip()
                logger.info(f"Пользователь '{sender_name_raw}' выполнил команду !team1 (параметр: '{command_param_part}'). Очистка чата.")
                display_chat_messages.clear()
                
                system_message = {
                    "ts": datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3],
                    "sender": "СИСТЕМА",
                    "msg": f"Чат очищен по команде от {html.escape(sender_name_raw)}. Инфо: {html.escape(command_param_part)}",
                    "team": "Other"
                }
                display_chat_messages.append(system_message)
                new_messages_added_count +=1
                continue

            if chat_command_type == "say":
                timestamp_str = extracted_data.get('timestamp', datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])
                player_team_raw = extracted_data['player_team']
                if not message_text_raw: continue

                team_identifier = "Other"
                if player_team_raw.upper() == "CT": team_identifier = "CT"
                elif player_team_raw.upper() == "TERRORIST" or player_team_raw.upper() == "T": team_identifier = "T"
                
                message_obj_for_display = {
                    "ts": timestamp_str,
                    "sender": html.escape(sender_name_raw),
                    "msg": html.escape(message_text_raw),
                    "team": team_identifier
                }
                display_chat_messages.append(message_obj_for_display)
                new_messages_added_count += 1
    
    if new_messages_added_count > 0:
        logger.info(f"Добавлено {new_messages_added_count} сообщений для чата (включая системные, если были).")
            
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк."}), 200
# -----------------------------

# --- API Endpoint for Chat Data ---
@app.route('/chat', methods=['GET', 'OPTIONS'])
@token_required
def get_structured_chat_data():
    if request.method == 'OPTIONS':
        return _build_cors_preflight_response()
    return jsonify(list(display_chat_messages))
# -----------------------------

# --- Main HTML Page Route ---
@app.route('/', methods=['GET'])
def index():
    return Response(MINIMAL_CHAT_HTML_WITH_CSS, mimetype='text/html')
# -----------------------------

# --- CORS Preflight response builder ---
def _build_cors_preflight_response():
    response = make_response() # Теперь make_response определен
    # Flask-CORS сам управляет этими заголовками на основе конфигурации для ресурса
    # response.headers.add("Access-Control-Allow-Origin", "*") 
    # response.headers.add('Access-Control-Allow-Headers', "*")
    # response.headers.add('Access-Control-Allow-Methods', "*")
    return response

# --- Run Application ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    # Установите ENV_TYPE=production в переменных окружения на Railway для отключения debug режима
    app.run(host='0.0.0.0', port=port, debug=False if os.environ.get('ENV_TYPE') == 'production' else True)
# -----------------------------