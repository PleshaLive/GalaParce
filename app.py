# Файл: app.py
import logging
import os
import re
import datetime
import html
from collections import deque
import functools # Для functools.wraps

from flask import Flask, request, jsonify, Response, make_response # make_response может понадобиться для других целей
from flask_cors import CORS
import jwt # Библиотека для работы с JWT
import base64 # Для декодирования секрета из Base64

# --- Flask App Setup ---
app = Flask(__name__)

# --- Logging Configuration ---
logging.getLogger('werkzeug').setLevel(logging.WARNING) # Уменьшаем логи werkzeug
logging.basicConfig(level=logging.DEBUG, # Устанавливаем уровень DEBUG для более подробных логов
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

# --- CORS Configuration for Production ---
TWITCH_EXTENSION_ID_ENV = os.environ.get('TWITCH_EXTENSION_ID')

if not TWITCH_EXTENSION_ID_ENV:
    logger.warning(
        "Переменная окружения TWITCH_EXTENSION_ID не установлена! "
        "CORS для /chat будет разрешен для '*', что НЕ рекомендуется для продакшена. "
        "Установите TWITCH_EXTENSION_ID в переменных окружения вашего сервера."
    )
    chat_origins_config = "*"
else:
    chat_origins_config = [
        f"https://{TWITCH_EXTENSION_ID_ENV}.ext-twitch.tv",
        "https://supervisor.ext-twitch.tv" # Для Twitch Developer Rig
    ]

# Для /gsi (и /submit_logs, если он остался как алиас)
# Если вы используете ТОЛЬКО /gsi для приема данных, то и конфигурация для /submit_logs не нужна.
# Этот эндпоинт принимает данные от игры (GSI), поэтому origin может быть не так важен,
# как для /chat, который вызывается из Twitch Extension.
# Рассмотрите добавление других механизмов защиты для /gsi, если это необходимо.
gsi_origins_config = "*"

CORS(app, resources={
    r"/chat": {
        "origins": chat_origins_config,
        "methods": ["GET", "OPTIONS"],
        "allow_headers": ["Authorization", "Content-Type"], # ВАЖНО
        "supports_credentials": True,
        "max_age": 86400
    },
    r"/gsi": { # Единый эндпоинт для приема данных от игры
        "origins": gsi_origins_config,
        "methods": ["POST", "OPTIONS"],
        "allow_headers": ["Content-Type"]
    }
    # Если /submit_logs больше не используется или является синонимом /gsi, его можно убрать отсюда,
    # либо оставить, если он все еще нужен как отдельный маршрут с теми же правилами, что и /gsi.
    # r"/submit_logs": {
    #     "origins": gsi_origins_config, # или submit_logs_origins_config
    #     "methods": ["POST", "OPTIONS"],
    #     "allow_headers": ["Content-Type"]
    # }
}, supports_credentials=True)


# --- Data Storage ---
MAX_CHAT_MESSAGES_DISPLAY = 100 # Максимальное количество сообщений для отображения
display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY)

# --- Regex Definition for Chat (если вы все еще пытаетесь парсить чат из GSI или другого источника) ---
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

# --- Декоратор для проверки JWT ---
def token_required(f):
    @functools.wraps(f)
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
                if not token:
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

# --- GSI Data Handler (бывший Log Submission Handler) ---
# Маршрут /submit_logs оставлен как алиас для /gsi для обратной совместимости, если он где-то использовался.
# Если вы точно используете только /gsi, алиас можно убрать.
@app.route('/gsi', methods=['POST'])
@app.route('/submit_logs', methods=['POST']) # Алиас, если нужен
def gsi_data_handler(): # Переименована для ясности, что это для GSI
    global display_chat_messages
    
    content_type = request.headers.get('Content-Type', '').lower()
    logger.info(f"Запрос к /gsi. Content-Type: {content_type}")

    # Если вы ожидаете ТОЛЬКО GSI (который обычно JSON), то эта логика упрощается.
    # Ваш предыдущий лог показывал, что GSI приходит как JSON, но ваш код пытался его парсить как массив строк.
    if 'application/json' not in content_type:
        logger.warning(f"/gsi: получен не JSON Content-Type: {content_type}. Попытка обработать как текст.")
        # Если это не JSON, возможно, это просто строки чата, отправленные как текст.
        # Но вы сказали, что используете только /gsi для GSI.
        # Для GSI здесь должна быть ошибка, если это не JSON.
        # return jsonify({"status": "error", "message": "Ожидается Content-Type application/json для GSI"}), 415

    gsi_payload = None
    try:
        gsi_payload = request.get_json()
        if not gsi_payload: # Если пришел пустой JSON {} или null
            logger.warning("/gsi: получен пустой JSON объект от request.get_json().")
            # Попробуем прочитать тело запроса как текст на случай, если это не JSON или пустой JSON
            raw_data_text = request.get_data(as_text=True)
            if raw_data_text:
                logger.info(f"/gsi: Тело запроса, прочитанное как текст: {raw_data_text[:200]}...")
                # Здесь вы можете решить, что делать с этим текстом.
                # Для GSI это не ожидается. Для логов чата - можно было бы разбить на строки.
            return jsonify({"status": "error", "message": "Получен пустой или некорректный JSON"}), 400
    except Exception as e:
        logger.error(f"Ошибка при парсинге JSON в /gsi: {e}", exc_info=True)
        # Попробуем прочитать тело запроса как текст, если парсинг JSON не удался
        raw_data_text = request.get_data(as_text=True)
        if raw_data_text:
            logger.info(f"/gsi: Тело запроса (при ошибке JSON), прочитанное как текст: {raw_data_text[:200]}...")
        return jsonify({"status": "error", "message": "Ошибка парсинга JSON"}), 400

    logger.info(f"Успешно получены и распарсены GSI данные (начало): {str(gsi_payload)[:500]}...")
    new_messages_added_count = 0

    # --- Логика обработки GSI данных для извлечения "сообщений" ---
    # ПРЕДУПРЕЖДЕНИЕ: Стандартный GSI CS2/CS:GO НЕ СОДЕРЖИТ СООБЩЕНИЙ ИГРОВОГО ЧАТА.
    # Этот блок должен быть адаптирован под то, какие именно "события" вы хотите извлекать из GSI
    # и представлять в виде сообщений.
    #
    # Пример: если бы мы хотели логировать фазу игры как системное сообщение
    # (это очень упрощенно и будет генерировать много сообщений без доп. логики)
    if isinstance(gsi_payload, dict) and 'map' in gsi_payload and isinstance(gsi_payload['map'], dict) and 'phase' in gsi_payload['map']:
        current_phase = gsi_payload['map']['phase']
        # Чтобы избежать дублирования, нужна логика отслеживания предыдущего состояния
        # Например, можно хранить последнее отправленное системное сообщение о фазе
        # и отправлять новое, только если фаза изменилась и прошло какое-то время.
        # Для простоты примера, мы можем просто добавить это как есть, но это не идеально.
        
        # Простой пример:
        # system_message_text = f"Текущая фаза игры: {current_phase}"
        # system_message_obj = {
        #     "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3],
        #     "sender": "СИСТЕМА GSI",
        #     "msg": html.escape(system_message_text),
        #     "team": "Other"
        # }
        # display_chat_messages.append(system_message_obj)
        # new_messages_added_count += 1
        # logger.info(f"Добавлено системное сообщение из GSI: {system_message_text}")
        pass # Удалите pass и реализуйте вашу логику извлечения сообщений из GSI

    # Если вы все еще хотите пытаться применить CHAT_REGEX_SAY к каким-то текстовым полям из GSI,
    # вам нужно будет найти эти поля в gsi_payload и передать их в CHAT_REGEX_SAY.
    # Например, если бы GSI содержал поле 'all_chat_lines' в виде списка строк (чего он не делает):
    # if isinstance(gsi_payload, dict) and 'all_chat_lines' in gsi_payload and isinstance(gsi_payload['all_chat_lines'], list):
    #     for line_content in gsi_payload['all_chat_lines']:
    #         if not isinstance(line_content, str): continue
    #         # ... (далее ваша логика с CHAT_REGEX_SAY, как была раньше) ...
    #         pass


    if new_messages_added_count > 0:
        logger.info(f"Добавлено {new_messages_added_count} 'сообщений' из GSI. Всего в очереди: {len(display_chat_messages)}.")
    else:
        logger.info("Новых 'сообщений' для чата не извлечено или не сформировано из этих GSI данных.")
            
    return jsonify({"status": "success", "message": f"GSI данные получены, сформировано {new_messages_added_count} 'сообщений'."}), 200

# --- API Endpoint for Chat Data ---
@app.route('/chat', methods=['GET'])
@token_required
def get_structured_chat_data():
    logger.info(f"Запрос к /chat. Отправка {len(display_chat_messages)} сообщений.")
    try:
        response_data = list(display_chat_messages)
        # logger.debug(f"Содержимое display_chat_messages перед jsonify: {response_data}")
        return jsonify(response_data)
    except Exception as e:
        logger.error(f"Критическая ошибка в get_structured_chat_data при jsonify: {e}", exc_info=True)
        return jsonify({"error": "Ошибка сервера при формировании ответа чата"}), 500

# --- Main HTML Page Route ---
@app.route('/', methods=['GET'])
def index():
    return Response(MINIMAL_CHAT_HTML_WITH_CSS, mimetype='text/html')

# --- Run Application ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    is_production = os.environ.get('ENV_TYPE', 'production').lower() == 'production'
    # Устанавливаем уровень логирования DEBUG, если не продакшн, для более детальных логов во время разработки
    if not is_production:
        logging.getLogger().setLevel(logging.DEBUG)
        for handler in logging.getLogger().handlers:
            handler.setLevel(logging.DEBUG)
        logger.info("Режим отладки включен, уровень логирования установлен на DEBUG.")

    logger.info(f"Запуск Flask приложения. Порт: {port}. Режим отладки (Flask debug prop): {not is_production}.")
    app.run(host='0.0.0.0', port=port, debug=not is_production)