# Файл: app.py
import logging
import os
import re
import datetime
import html
from collections import deque
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import jwt # Библиотека для работы с JWT
import base64 # Для декодирования секрета из Base64

# --- Flask App Setup ---
app = Flask(__name__)
# Настройте CORS более строго для продакшена, разрешая только домены Twitch и ваш Extension ID
# Закомментировано для простоты разработки, но важно для безопасности в продакшене.
# origins = [
#    f"https://{os.environ.get('TWITCH_EXTENSION_ID')}.ext-twitch.tv",
#    "https://supervisor.ext-twitch.tv" # Для Twitch Developer Rig
# ]
# CORS(app, resources={r"/chat": {"origins": origins}}, supports_credentials=True)
CORS(app) # Для простоты разработки пока разрешаем все источники

# --- Logging Configuration ---
# Уменьшаем количество логов от встроенного сервера Flask (werkzeug)
logging.getLogger('werkzeug').setLevel(logging.WARNING)
# Настраиваем формат и уровень логгирования для нашего приложения
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s: %(message)s')
logger = logging.getLogger(__name__) # Создаем экземпляр логгера

# --- Конфигурация Расширения ---
# Получаем секрет расширения Twitch из переменной окружения.
# Это самый безопасный способ хранения секретов.
TWITCH_EXTENSION_SECRET_B64 = os.environ.get('TWITCH_EXTENSION_SECRET')
EXTENSION_SECRET = None # Инициализируем как None

if not TWITCH_EXTENSION_SECRET_B64:
    logger.error("КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения TWITCH_EXTENSION_SECRET не установлена!")
    # В продакшене здесь может быть логика остановки приложения или использование секрета по умолчанию (не рекомендуется для продакшена).
else:
    try:
        # Секрет Twitch хранится в Base64, его нужно декодировать в байты.
        EXTENSION_SECRET = base64.b64decode(TWITCH_EXTENSION_SECRET_B64)
        logger.info("Секрет расширения Twitch успешно загружен и декодирован.")
    except Exception as e:
        logger.error(f"Ошибка декодирования TWITCH_EXTENSION_SECRET из Base64: {e}")
        # Если секрет не может быть декодирован, аутентификация JWT не будет работать.

# --- Data Storage ---
MAX_CHAT_MESSAGES_DISPLAY = 100 # Максимальное количество сообщений, хранимых для отображения
# Используем deque для автоматического удаления старых сообщений при достижении лимита.
display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY)

# --- Regex Definition for Chat ---
# Регулярное выражение для парсинга строк лога чата.
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* # Начало строки, опциональные пробелы.
    (?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?          # Опциональная дата (ДД/ММ/ГГГГ - ).
    (?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})      # Временная метка (ЧЧ:ММ:СС.мс) - именованная группа 'timestamp'.
    \s+-\s+                                  # Разделитель " - ".
    # Именованные группы для извлечения имени игрока, userid, steamid и команды игрока (например, CT, TERRORIST).
    \"(?P<player_name>.+?)<(?P<userid>\d+)><(?P<steamid>\[U:\d:\d+\])><(?P<player_team>\w+)>\" 
    \s+                                      # Пробел.
    (?P<chat_command>say|say_team)           # Команда чата ('say' или 'say_team') - именованная группа 'chat_command'.
    \s+                                      # Пробел.
    \"(?P<message>.*)\"                      # Содержимое сообщения в кавычках - именованная группа 'message'.
    \s*$                                     # Опциональные пробелы, конец строки.
    """,
    re.VERBOSE | re.IGNORECASE # VERBOSE для многострочного написания и комментариев, IGNORECASE для регистронезависимости.
)
# ----------------------------------------------

# --- HTML (MINIMAL_CHAT_HTML_WITH_CSS остается как плейсхолдер, так как этот файл отвечает за бэкенд) ---
# Этот HTML используется, если кто-то зайдет на корневой URL вашего Flask-приложения.
# Для Twitch Extension используется отдельный фронтенд (ваш .zip архив).
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
                // Этот fetch не будет использовать JWT, так как это просто сайт
                const response = await fetch('/chat'); // Запрос к самому себе, но без JWT
                if (response.status === 401) { // Если сервер теперь требует JWT и для этого доступа
                     chatContainer.innerHTML = '<p>Ошибка: Доступ к этому чату с сайта ограничен. Используйте Twitch Extension.</p>';
                     return;
                }
                if (!response.ok) throw new Error('Network response was not ok.');
                const messages = await response.json();
                chatContainer.innerHTML = ''; // Очищаем
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
        // setInterval(fetchSiteMessages, 5000); // Обновление для сайта
        // fetchSiteMessages(); // Начальная загрузка для сайта
        // Примечание: Если /chat теперь требует JWT, этот сайт-чат перестанет работать без доработок.
        // Для простоты, предполагаем, что JWT проверяется только для запросов с заголовком Authorization.
        // Если вы хотите, чтобы этот сайт-чат работал, вам нужно либо убрать @token_required с /chat,
        // либо сделать отдельный эндпоинт для сайта без JWT, либо сайт должен как-то получать JWT (что нетипично).
        // Пока что, если @token_required активен, этот сайт-чат, скорее всего, не будет получать данные.
        chatContainer.innerHTML = '<p>Для просмотра чата используйте Twitch Extension. Этот сайт-просмотрщик может быть неактивен из-за настроек безопасности.</p>';
    </script>
</body></html>"""


# --- Декоратор для проверки JWT ---
# Этот декоратор будет применяться к эндпоинтам, которые требуют аутентификации.
def token_required(f):
    # functools.wraps(f) можно использовать для сохранения метаданных оригинальной функции, если это важно.
    def decorated(*args, **kwargs):
        if not EXTENSION_SECRET: # Проверяем, был ли секрет загружен из переменных окружения.
            logger.error("EXTENSION_SECRET не настроен на сервере. Аутентификация невозможна.")
            return jsonify({"error": "Сервер не настроен для аутентификации расширения (отсутствует секрет)"}), 500

        token = None
        # Проверяем наличие заголовка Authorization.
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            try:
                # Ожидаем, что токен передается в формате "Bearer <token>".
                token = auth_header.split(" ")[1] 
            except IndexError:
                logger.warning("Некорректный формат заголовка Authorization. Отсутствует Bearer токен.")
                return jsonify({"error": "Некорректный формат заголовка Authorization"}), 401
        
        if not token:
            logger.warning("Токен авторизации отсутствует в запросе.")
            return jsonify({"error": "Токен авторизации отсутствует"}), 401

        try:
            # Верификация и декодирование JWT с использованием секрета расширения.
            # Twitch использует алгоритм HS256 для подписи JWT, передаваемых на фронтенд расширения.
            payload = jwt.decode(token, EXTENSION_SECRET, algorithms=["HS256"])
            
            # Опциональные, но рекомендуемые проверки содержимого payload:
            # if datetime.datetime.utcnow() > datetime.datetime.fromtimestamp(payload.get('exp', 0)):
            #     logger.warning("Получен просроченный JWT (проверка exp).")
            #     return jsonify({"error": "Срок действия токена истек"}), 401
            # logger.info(f"JWT валиден. Роль: {payload.get('role')}, UserID: {payload.get('user_id')}, ChannelID: {payload.get('channel_id')}")

        except jwt.ExpiredSignatureError: # Если токен просрочен.
            logger.warning("Получен просроченный JWT (ExpiredSignatureError).")
            return jsonify({"error": "Срок действия токена истек"}), 401
        except jwt.InvalidTokenError as e: # Любая другая ошибка невалидности токена.
            logger.warning(f"Получен невалидный JWT: {e}")
            return jsonify({"error": "Невалидный токен авторизации"}), 401
        
        return f(*args, **kwargs) # Если токен валиден, передаем управление оригинальной функции.
    
    decorated.__name__ = f.__name__ # Сохраняем имя оригинальной функции для Flask.
    return decorated

# --- Log Submission Handler ---
# Этот эндпоинт принимает логи от игрового сервера.
# ВАЖНО: Этот эндпоинт также нуждается в защите (например, через секретный ключ, известный только игровому серверу и этому приложению),
# так как JWT от Twitch Extension сюда обычно не передается. Пока оставляем без такой защиты для простоты.
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST']) # Дополнительный маршрут, если GSI приходит сюда же.
def receive_and_parse_logs_handler():
    global display_chat_messages # Указываем, что будем изменять глобальную переменную.
    log_lines = []
    
    # Логика получения строк лога из тела запроса (JSON или простой текст).
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
        if not line_content.strip(): continue # Пропускаем пустые строки.
            
        chat_match = CHAT_REGEX_SAY.search(line_content) # Пытаемся найти совпадение с регулярным выражением чата.
        if chat_match:
            extracted_data = chat_match.groupdict() # Извлекаем именованные группы.
            chat_command_type = extracted_data['chat_command'].lower()
            sender_name_raw = extracted_data['player_name'].strip()
            message_text_raw = extracted_data['message'].strip()
            
            # Проверка на команду !team1 от любого пользователя для очистки чата.
            if message_text_raw.lower().startswith("!team1"):
                command_param_part = message_text_raw[len("!team1"):].strip() 
                logger.info(f"Пользователь '{sender_name_raw}' выполнил команду !team1 (параметр: '{command_param_part}'). Очистка чата.")
                display_chat_messages.clear() # Очищаем очередь сообщений.
                
                # Добавляем системное сообщение об очистке.
                system_message = {
                    "ts": datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3],
                    "sender": "СИСТЕМА",
                    "msg": f"Чат очищен по команде от {html.escape(sender_name_raw)}. Инфо: {html.escape(command_param_part)}",
                    "team": "Other" 
                }
                display_chat_messages.append(system_message)
                new_messages_added_count +=1 
                continue # Переходим к следующей строке лога, не добавляя саму команду.

            # Обрабатываем только 'say' сообщения для отображения в общем чате (если это не была команда !team1).
            if chat_command_type == "say":
                timestamp_str = extracted_data.get('timestamp', datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])
                player_team_raw = extracted_data['player_team']
                if not message_text_raw: continue # Пропускаем пустые сообщения.

                team_identifier = "Other" # Команда по умолчанию.
                if player_team_raw.upper() == "CT": team_identifier = "CT"
                elif player_team_raw.upper() == "TERRORIST" or player_team_raw.upper() == "T": team_identifier = "T"
                
                message_obj_for_display = {
                    "ts": timestamp_str,
                    "sender": html.escape(sender_name_raw), # Экранируем HTML для безопасности.
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
# Этот эндпоинт будет использоваться Twitch Extension для получения сообщений чата.
# Декоратор @token_required обеспечивает проверку JWT перед доступом.
@app.route('/chat', methods=['GET'])
@token_required 
def get_structured_chat_data():
    return jsonify(list(display_chat_messages))
# -----------------------------

# --- Main HTML Page Route ---
# Этот эндпоинт отдает HTML-страницу, если кто-то зайдет на корневой URL вашего сервера.
# Он не используется Twitch Extension напрямую, но может быть полезен для отладки.
@app.route('/', methods=['GET'])
def index():
    return Response(MINIMAL_CHAT_HTML_WITH_CSS, mimetype='text/html')
# -----------------------------

# --- Run Application ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080)) # Порт для Railway или локально.
    # debug=True полезно для разработки. В продакшене установите в False или управляйте через переменные окружения.
    app.run(host='0.0.0.0', port=port, debug=True) 
# -----------------------------
