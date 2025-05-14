# Файл: app.py
import logging
import os
import re
import datetime
import html
from collections import deque
import functools # Для functools.wraps

from flask import Flask, request, jsonify, Response, make_response
from flask_cors import CORS
import jwt
import base64

# --- Flask App Setup ---
app = Flask(__name__)

# --- Logging Configuration ---
logging.getLogger('werkzeug').setLevel(logging.WARNING)
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(name)s %(levelname)s %(module)s %(funcName)s L%(lineno)d: %(message)s')
logger = logging.getLogger(__name__)

# --- Конфигурация Расширения ---
TWITCH_EXTENSION_SECRET_B64 = os.environ.get('TWITCH_EXTENSION_SECRET')
EXTENSION_SECRET = None

if not TWITCH_EXTENSION_SECRET_B64:
    logger.critical("КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения TWITCH_EXTENSION_SECRET не установлена!")
else:
    try:
        EXTENSION_SECRET = base64.b64decode(TWITCH_EXTENSION_SECRET_B64)
        logger.info("Секрет расширения Twitch успешно загружен и декодирован.")
    except Exception as e:
        logger.critical(f"Ошибка декодирования TWITCH_EXTENSION_SECRET из Base64: {e}", exc_info=True)
        # В этом случае приложение не сможет аутентифицировать токены.
        # Можно добавить логику остановки приложения или переход в безопасный режим.

# --- CORS Configuration for Production ---
TWITCH_EXTENSION_ID_ENV = os.environ.get('TWITCH_EXTENSION_ID')

if not TWITCH_EXTENSION_ID_ENV:
    logger.warning(
        "Переменная окружения TWITCH_EXTENSION_ID не установлена! "
        "CORS для /chat будет разрешен для '*', что НЕ рекомендуется для продакшена. "
        "Установите TWITCH_EXTENSION_ID в переменных окружения вашего сервера."
    )
    # Если TWITCH_EXTENSION_ID не установлен, расширение Twitch, скорее всего, не сможет подключиться
    # из-за строгой политики Origin, которую ожидает Twitch.
    # Установка "*" здесь - это запасной вариант, чтобы приложение не упало при старте.
    chat_origins_config = "*"
else:
    chat_origins_config = [
        f"https://{TWITCH_EXTENSION_ID_ENV}.ext-twitch.tv",
        "https://supervisor.ext-twitch.tv" # Для Twitch Developer Rig
        # "http://localhost:8080" # Можно добавить для локального тестирования с Twitch Developer Rig через HTTP
    ]

submit_logs_origins_config = "*" # Для логов с игрового сервера; рассмотрите более строгие правила для продакшена

CORS(app, resources={
    r"/chat": {
        "origins": chat_origins_config,
        "methods": ["GET", "OPTIONS"], # Flask-CORS сам обработает OPTIONS
        "allow_headers": ["Authorization", "Content-Type"], # ВАЖНО: Разрешаем необходимые заголовки
        "supports_credentials": True, # Необходимо для Twitch Extensions
        "max_age": 86400 # Опционально: время кеширования preflight ответа браузером
    },
    r"/submit_logs": {
        "origins": submit_logs_origins_config,
        "methods": ["POST", "OPTIONS"],
        "allow_headers": ["Content-Type"]
    },
    r"/gsi": { # Если /gsi это тот же /submit_logs
        "origins": submit_logs_origins_config,
        "methods": ["POST", "OPTIONS"],
        "allow_headers": ["Content-Type"]
    }
}, supports_credentials=True) # supports_credentials=True на глобальном уровне, если нужно для всех ресурсов

# --- Data Storage ---
MAX_CHAT_MESSAGES_DISPLAY = 100
display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY)

# --- Regex Definition for Chat ---
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* # Начало строки, опциональные пробелы.
    (?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?      # Опциональная дата (ДД/ММ/ГГГГ - ).
    (?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})  # Временная метка (ЧЧ:ММ:СС.мс)
    \s+-\s+                                  # Разделитель " - ".
    \"(?P<player_name>.+?)<(?P<userid>\d+)><(?P<steamid>\[U:\d:\d+\])><(?P<player_team>\w+)>\"
    \s+                                      # Пробел.
    (?P<chat_command>say|say_team)           # Команда чата ('say' или 'say_team')
    \s+                                      # Пробел.
    \"(?P<message>.*)\"                      # Содержимое сообщения в кавычках
    \s*$                                     # Опциональные пробелы, конец строки.
    """,
    re.VERBOSE | re.IGNORECASE
)

# --- HTML (Placeholder for root URL) ---
MINIMAL_CHAT_HTML_WITH_CSS = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CS2 Chat Viewer (Сайт)</title><style>body{font-family:sans-serif;background-color:#222;color:#eee;margin:0;padding:10px;display:flex;flex-direction:column;height:100vh;}#chat-container{flex-grow:1;overflow-y:auto;border:1px solid #444;padding:10px;background-color:#333;border-radius:5px;} .message{margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid #444;} .sender{font-weight:bold;} .team-CT{color:#87CEFA;} .team-T{color:#FFA07A;} .team-Other{color:#D3D3D3;}</style></head><body><h1>Чат Игры (версия для сайта)</h1><div id="chat-container"><p>Для просмотра чата используйте Twitch Extension. Этот сайт-просмотрщик может быть неактивен из-за настроек безопасности (требуется JWT для /chat).</p></div></body></html>"""

# --- Декоратор для проверки JWT (Улучшенное логирование и обработка ошибок) ---
def token_required(f):
    @functools.wraps(f) # Сохраняет метаданные оригинальной функции (имя, docstring и т.д.)
    def decorated(*args, **kwargs):
        logger.info(f"Запрос к защищенному эндпоинту: {request.path}")
        logger.debug(f"Все входящие заголовки: {list(request.headers.items())}")

        if not EXTENSION_SECRET:
            logger.critical("EXTENSION_SECRET не настроен на сервере в момент запроса. Аутентификация невозможна.")
            return jsonify({"error": "Критическая ошибка сервера: секрет расширения не настроен"}), 500

        token = None
        auth_header_value = request.headers.get('Authorization')

        if auth_header_value:
            logger.info(f"Найден заголовок Authorization: '{auth_header_value}'")
            parts = auth_header_value.split(" ")
            if len(parts) == 2 and parts[0].lower() == "bearer":
                token = parts[1]
                if not token: # Если токен пустой после "Bearer "
                    logger.warning("Пустой токен в заголовке Authorization после 'Bearer '.")
                    return jsonify({"error": "Пустой токен в заголовке Authorization"}), 401
                logger.info(f"Извлечен токен (первые 15 символов): {token[:15]}...")
            else:
                logger.warning(f"Некорректный формат заголовка Authorization: '{auth_header_value}'. Ожидался 'Bearer <token>'.")
                return jsonify({"error": "Некорректный формат заголовка Authorization"}), 401
        else:
            logger.warning("Заголовок 'Authorization' отсутствует в запросе.")
            return jsonify({"error": "Заголовок Authorization отсутствует"}), 401

        try:
            payload = jwt.decode(token, EXTENSION_SECRET, algorithms=["HS256"])
            logger.info(f"JWT валиден. Payload: {payload}")
            # Здесь можно добавить проверки для payload, например, payload.get('role') == 'viewer'
            # request.current_user_payload = payload # Опционально: сохранить payload в объекте request для доступа в эндпоинте
        except jwt.ExpiredSignatureError:
            logger.warning("Получен просроченный JWT (ExpiredSignatureError).")
            return jsonify({"error": "Срок действия токена истек"}), 401
        except jwt.InvalidTokenError as e:
            logger.warning(f"Получен невалидный JWT: {e}")
            return jsonify({"error": "Невалидный токен авторизации"}), 401
        except Exception as e:
            logger.error(f"Непредвиденная ошибка при декодировании или проверке JWT: {e}", exc_info=True)
            return jsonify({"error": "Ошибка при обработке токена авторизации"}), 500

        return f(*args, **kwargs)
    return decorated

# --- Log Submission Handler ---
@app.route('/submit_logs', methods=['POST']) # Flask-CORS обработает OPTIONS
@app.route('/gsi', methods=['POST'])       # Flask-CORS обработает OPTIONS
def receive_and_parse_logs_handler():
    global display_chat_messages
    log_lines = []
    
    content_type = request.headers.get('Content-Type', '').lower()
    logger.info(f"Запрос к /submit_logs (или /gsi). Content-Type: {content_type}")

    if 'application/json' in content_type:
        try:
            data = request.get_json()
            if isinstance(data, dict) and 'lines' in data and isinstance(data.get('lines'), list):
                log_lines = data.get('lines', [])
            elif isinstance(data, list):
                log_lines = [str(item) for item in data] # Убедимся, что все элементы - строки
            else:
                logger.warning(f"Получен JSON, но формат не соответствует ожидаемому (dict с 'lines' или list). Data: {data}")
                raw_data_fallback = request.get_data(as_text=True) # Попробуем как текст
                if raw_data_fallback: log_lines = raw_data_fallback.splitlines()
        except Exception as e:
            logger.error(f"Ошибка при парсинге JSON в /submit_logs: {e}", exc_info=True)
            raw_data_fallback = request.get_data(as_text=True) # Попробуем как текст при ошибке JSON
            if raw_data_fallback: log_lines = raw_data_fallback.splitlines()
    else: # Если не JSON, читаем как простой текст
        raw_data = request.get_data(as_text=True)
        if raw_data:
            log_lines = raw_data.splitlines()
        else:
            logger.warning("Получен пустой запрос или не удалось извлечь данные как текст.")

    if not log_lines:
        logger.warning("Не предоставлены строки логов или не удалось их извлечь.")
        return jsonify({"status": "error", "message": "Строки не предоставлены или не удалось их извлечь"}), 400
    
    logger.info(f"Получено {len(log_lines)} строк для обработки.")
    new_messages_added_count = 0

    for i, line_content in enumerate(log_lines):
        if not isinstance(line_content, str):
            logger.warning(f"Строка {i+1} не является строкой, пропускается: {line_content}")
            continue
        if not line_content.strip():
            logger.debug(f"Строка {i+1} пустая, пропускается.")
            continue
            
        logger.debug(f"Обработка строки {i+1}: {line_content[:100]}...") # Логируем начало строки
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
                    "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3], # UTC время
                    "sender": "СИСТЕМА",
                    "msg": f"Чат очищен по команде от {html.escape(sender_name_raw)}. Инфо: {html.escape(command_param_part)}",
                    "team": "Other"
                }
                display_chat_messages.append(system_message)
                new_messages_added_count +=1
                continue

            if chat_command_type == "say":
                timestamp_str = extracted_data.get('timestamp', datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3])
                player_team_raw = extracted_data['player_team']
                
                if not message_text_raw:
                    logger.debug("Пустое 'say' сообщение, пропускается.")
                    continue

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
                logger.debug(f"Добавлено сообщение от {sender_name_raw}: {message_text_raw[:50]}...")
        else:
            logger.debug(f"Строка не соответствует CHAT_REGEX_SAY: {line_content[:100]}...")
    
    if new_messages_added_count > 0:
        logger.info(f"Добавлено {new_messages_added_count} новых сообщений для чата. Всего в очереди: {len(display_chat_messages)}.")
    else:
        logger.info("Новых сообщений для чата не добавлено по результатам обработки этих логов.")
            
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк, добавлено {new_messages_added_count} сообщений."}), 200

# --- API Endpoint for Chat Data ---
@app.route('/chat', methods=['GET']) # Flask-CORS обработает OPTIONS
@token_required
def get_structured_chat_data():
    logger.info(f"Запрос к /chat. Отправка {len(display_chat_messages)} сообщений.")
    try:
        # Логируем перед отправкой, если есть подозрения на проблемы с jsonify
        # logger.debug(f"Содержимое display_chat_messages перед jsonify: {list(display_chat_messages)}")
        response_data = list(display_chat_messages)
        return jsonify(response_data)
    except Exception as e:
        logger.error(f"Ошибка при сериализации сообщений чата в jsonify: {e}", exc_info=True)
        return jsonify({"error": "Ошибка сервера при формировании ответа чата"}), 500

# --- Main HTML Page Route ---
@app.route('/', methods=['GET'])
def index():
    return Response(MINIMAL_CHAT_HTML_WITH_CSS, mimetype='text/html')

# --- Run Application ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    # Для продакшена debug=False. Управляется через переменную окружения ENV_TYPE.
    # Если ENV_TYPE не 'production', то debug=True.
    is_production = os.environ.get('ENV_TYPE', 'production').lower() == 'production'
    logger.info(f"Запуск Flask приложения. Порт: {port}. Режим отладки: {not is_production}.")
    app.run(host='0.0.0.0', port=port, debug=not is_production)