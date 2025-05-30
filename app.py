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
logging.basicConfig(level=logging.DEBUG,
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
        "https://supervisor.ext-twitch.tv"
    ]

gsi_origins_config = "*" # Разрешаем с любых источников для /gsi, так как это сервер игры

CORS(app, resources={
    r"/chat": {
        "origins": chat_origins_config,
        "methods": ["GET", "OPTIONS"],
        "allow_headers": ["Authorization", "Content-Type"],
        "supports_credentials": True,
        "max_age": 86400
    },
    r"/gsi": {
        "origins": gsi_origins_config, # Разрешаем POST с любого источника для логов
        "methods": ["POST", "OPTIONS"],
        "allow_headers": ["Content-Type"]
    },
    r"/submit_logs": { # Алиас
        "origins": gsi_origins_config,
        "methods": ["POST", "OPTIONS"],
        "allow_headers": ["Content-Type"]
    }
}, supports_credentials=True)


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

# --- HTML for root URL with Test Button ---
MINIMAL_CHAT_HTML_WITH_CSS = """<!DOCTYPE html><html lang="ru">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS2 Chat Viewer (Сайт)</title>
    <style>
        body{font-family:sans-serif;background-color:#222;color:#eee;margin:0;padding:10px;display:flex;flex-direction:column;height:calc(100vh - 20px);}
        #chat-container{flex-grow:1;overflow-y:auto;border:1px solid #444;padding:10px;background-color:#333;border-radius:5px;margin-bottom:10px;}
        .message{margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid #444;}
        .sender{font-weight:bold;} .team-CT{color:#87CEFA;} .team-T{color:#FFA07A;} .team-Other{color:#D3D3D3;}
        button {padding: 10px 15px; margin-top:10px; background-color: #5a5a5a; color: white; border: none; border-radius: 3px; cursor: pointer;}
        button:hover {background-color: #7a7a7a;}
        #test-message-status {margin-top: 5px; font-size: 0.9em;}
    </style>
</head>
<body>
    <h1>Чат Игры (версия для сайта)</h1>
    <div id="chat-container"><p>Для просмотра чата используйте Twitch Extension. Этот сайт-просмотрщик может быть неактивен из-за настроек безопасности (требуется JWT для /chat).</p></div>
    <button id="sendTestMsgBtn">Отправить тестовое сообщение</button>
    <div id="test-message-status"></div>

    <script>
        const chatContainerSite = document.getElementById('chat-container'); // Переименовал, чтобы не конфликтовать с переменной в Twitch
        const sendTestMsgBtn = document.getElementById('sendTestMsgBtn');
        const testMessageStatus = document.getElementById('test-message-status');

        async function fetchSiteChatMessages() {
            // Эта функция для отображения чата на этой странице, если /chat не требует JWT
            // В текущей конфигурации /chat требует JWT, поэтому эта функция, скорее всего, не получит данные.
            // Оставляю для примера, если вы решите сделать /chat публичным или с другим типом аутентификации для сайта.
            try {
                const response = await fetch('/chat');
                if (response.status === 401) {
                    chatContainerSite.innerHTML = '<p>Ошибка 401: Доступ к /chat с этого сайта ограничен (требуется JWT). Используйте Twitch Extension.</p>';
                    return;
                }
                if (!response.ok) {
                    chatContainerSite.innerHTML = `<p>Не удалось загрузить сообщения с /chat. Статус: ${response.status}</p>`;
                    throw new Error('Network response was not ok: ' + response.statusText);
                }
                const messages = await response.json();
                chatContainerSite.innerHTML = '';
                if (messages.length === 0) {
                    chatContainerSite.innerHTML = '<p>Сообщений пока нет (получено с /chat).</p>';
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
                        chatContainerSite.appendChild(div);
                    });
                    chatContainerSite.scrollTop = chatContainerSite.scrollHeight;
                }
            } catch (error) {
                console.error('Could not fetch messages for site /chat:', error);
                if (chatContainerSite.innerHTML.includes('Ошибка 401')) {
                    // Не перезаписываем сообщение об ошибке 401
                } else {
                    chatContainerSite.innerHTML = '<p>Не удалось загрузить сообщения с /chat.</p>';
                }
            }
        }

        if (sendTestMsgBtn) {
            sendTestMsgBtn.addEventListener('click', async () => {
                testMessageStatus.textContent = 'Отправка тестового сообщения...';
                // Формируем строку лога, которая должна быть распознана вашим CHAT_REGEX_SAY
                const now = new Date();
                const timeString = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
                const testLogString = `${timeString} - "ТестовыйИгрок<[U:1:99999]><CT>" say "Это тестовое сообщение с сайта!"`;

                try {
                    const response = await fetch('/gsi', { // Отправляем на /gsi (или /submit_logs)
                        method: 'POST',
                        headers: {
                            'Content-Type': 'text/plain' // Отправляем как простой текст
                        },
                        body: testLogString // Отправляем одну строку лога
                    });

                    const responseData = await response.json(); // Ожидаем JSON ответ от /gsi
                    if (response.ok && responseData.status === 'success') {
                        testMessageStatus.textContent = 'Тестовое сообщение успешно отправлено на /gsi! (' + responseData.message + ')';
                        // Опционально: обновить чат на этой странице, если он должен показывать изменения
                        // fetchSiteChatMessages(); // Но это не покажет его сразу, т.к. /chat может быть защищен
                    } else {
                        testMessageStatus.textContent = `Ошибка отправки: ${response.status} - ${responseData.message || 'Нет деталей'}`;
                    }
                } catch (error) {
                    console.error('Ошибка при отправке тестового сообщения:', error);
                    testMessageStatus.textContent = 'Критическая ошибка при отправке тестового сообщения.';
                }
            });
        }
        // fetchSiteChatMessages(); // Вызывать при загрузке, если /chat доступен без JWT
    </script>
</body></html>"""

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
            logger.warning(f"Получен невалидный JWT: {e}", exc_info=True) # Добавил exc_info для деталей
            return jsonify({"error": "Невалидный токен авторизации"}), 401
        except Exception as e:
            logger.error(f"Непредвиденная ошибка при декодировании или проверке JWT: {e}", exc_info=True)
            return jsonify({"error": "Ошибка при обработке токена авторизации"}), 500

        return f(*args, **kwargs)
    return decorated

# --- GSI / Log Data Handler (для текстовых логов CS2) ---
@app.route('/gsi', methods=['POST'])
@app.route('/submit_logs', methods=['POST']) # Алиас
def gsi_data_handler():
    global display_chat_messages
    log_lines = []
    
    content_type = request.headers.get('Content-Type', '').lower()
    logger.info(f"Запрос к /gsi. Content-Type: '{content_type}'")

    try:
        raw_data_text = request.get_data(as_text=True)
        if raw_data_text:
            log_lines = raw_data_text.splitlines()
            logger.info(f"/gsi: Тело запроса успешно прочитано как текст, получено {len(log_lines)} строк.")
            if len(log_lines) > 0:
                 logger.debug(f"/gsi: Первая полученная строка: {log_lines[0][:200]}...")
        else:
            logger.warning("/gsi: Тело запроса пустое при чтении как текст.")
            return jsonify({"status": "success", "message": "Получен пустой запрос."}), 200
    except Exception as e:
        logger.error(f"Ошибка при чтении тела запроса как текст в /gsi: {e}", exc_info=True)
        return jsonify({"status": "error", "message": "Ошибка при чтении тела запроса"}), 400

    if not log_lines: # Эта проверка может быть избыточной, если пустой запрос уже обработан выше
        logger.info("/gsi: Нет строк для обработки после чтения тела запроса.")
        return jsonify({"status": "success", "message": "Нет строк для обработки."}), 200

    new_messages_added_count = 0
    for i, line_content in enumerate(log_lines):
        if not isinstance(line_content, str):
            logger.warning(f"Элемент {i+1} в log_lines не является строкой, пропускается: {type(line_content)}")
            continue
        if not line_content.strip():
            logger.debug(f"Строка {i+1} пустая, пропускается.")
            continue
            
        logger.debug(f"Обработка строки {i+1}: {line_content[:100]}...")
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
                    "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3],
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
                    logger.debug(f"Пустое 'say' сообщение от {sender_name_raw}, пропускается.")
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
@app.route('/chat', methods=['GET'])
@token_required
def get_structured_chat_data():
    logger.info(f"Запрос к /chat. Отправка {len(display_chat_messages)} сообщений.")
    try:
        response_data = list(display_chat_messages)
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
    if not is_production:
        logging.getLogger().setLevel(logging.DEBUG)
        for handler in logging.getLogger().handlers:
            handler.setLevel(logging.DEBUG)
        logger.info("Режим отладки Flask включен, уровень логирования установлен на DEBUG для всех хендлеров.")
    else:
        logger.info("Режим продакшена Flask.")

    logger.info(f"Запуск Flask приложения. Порт: {port}. Режим отладки Flask (app.debug): {not is_production}.")
    app.run(host='0.0.0.0', port=port, debug=not is_production)