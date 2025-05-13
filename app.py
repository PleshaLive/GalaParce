# Файл: app.py
import logging
import os
import re
import datetime
import html
import json # Хотя json не используется напрямую в этой версии, он часто нужен для Flask
from collections import deque
from flask import Flask, request, jsonify, Response
from flask_cors import CORS

# --- Flask App Setup ---
app = Flask(__name__)
CORS(app) # Для простоты разработки, в продакшене лучше настроить конкретные origin

# --- Logging Configuration ---
# Устанавливаем уровень логгирования для Werkzeug (встроенный веб-сервер Flask) на WARNING, чтобы избежать лишних сообщений в консоли
logging.getLogger('werkzeug').setLevel(logging.WARNING)
# Настраиваем базовое логгирование для нашего приложения
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s: %(message)s')
logger = logging.getLogger(__name__) # Создаем логгер для нашего приложения

# --- Data Storage ---
MAX_CHAT_MESSAGES_DISPLAY = 100 # Максимальное количество сообщений, хранимых в очереди для отображения
# deque - это двусторонняя очередь, которая автоматически удаляет старые элементы при добавлении новых сверх лимита
display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY)
# ADMIN_NICKNAMES больше не нужен, так как команда !team1 доступна всем
# -----------------------

# --- Regex Definition for Chat ---
# Регулярное выражение для парсинга строк лога чата
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* # Начало строки, опциональные пробелы
    (?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?          # Опциональная дата (ДД/ММ/ГГГГ - )
    (?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})      # Временная метка (ЧЧ:ММ:СС.мс) - именованная группа 'timestamp'
    \s+-\s+                                  # Разделитель " - "
    # Именованные группы для имени игрока, userid, steamid и команды игрока
    \"(?P<player_name>.+?)<(?P<userid>\d+)><(?P<steamid>\[U:\d:\d+\])><(?P<player_team>\w+)>\" 
    \s+                                      # Пробел
    (?P<chat_command>say|say_team)           # Команда чата ('say' или 'say_team') - именованная группа 'chat_command'
    \s+                                      # Пробел
    \"(?P<message>.*)\"                      # Содержимое сообщения в кавычках - именованная группа 'message'
    \s*$                                     # Опциональные пробелы, конец строки
    """,
    re.VERBOSE | re.IGNORECASE # VERBOSE для многострочного регулярного выражения с комментариями, IGNORECASE для регистронезависимости
)
# ----------------------------------------------

# --- HTML, CSS, and JavaScript for the Single Chat Page ---
# Эта большая строка содержит весь HTML, CSS и JS для отображения чата на одной странице
MINIMAL_CHAT_HTML_WITH_CSS = """<!DOCTYPE html><html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS2 Chat</title>
<style>
/* Общие CSS переменные для темы */
:root{
    --bg-color:#121212; /* Цвет фона страницы */
    --surface-color:#1E1E1E; /* Цвет фона для контейнеров, панелей */
    --primary-text-color:#E0E0E0; /* Основной цвет текста */
    --secondary-text-color:#A0A0A0; /* Вторичный цвет текста (например, для временных меток) */
    --border-color:#333333; /* Цвет границ */
    --accent-color-1:#0DCAF0; /* Акцентный цвет 1 (например, для команды CT) */
    --accent-color-2:#FFC107; /* Акцентный цвет 2 (например, для команды T) */
    --font-primary:'Roboto', 'Segoe UI', Helvetica, Arial, sans-serif; /* Основной шрифт */
    /* Цвета для никнеймов команд в чате */
    --chat-team-ct-color: var(--accent-color-1); 
    --chat-team-t-color: var(--accent-color-2);  
    --chat-sender-default-color: #B0BEC5; /* Цвет для наблюдателей или если команда не определена */
    --player-entry-bg: #282828; /* Фон для отдельных сообщений */
}
/* Сброс стилей и базовые стили для body */
*,*::before,*::after{box-sizing:border-box;}
body{
    font-family:var(--font-primary);
    background-color:var(--bg-color);
    color:var(--primary-text-color);
    line-height:1.6; 
    font-weight: 300;
    padding: 0; 
    display: flex; 
    flex-direction: column; 
    height: 100vh; /* Занимает всю высоту вьюпорта */
    margin: 0; 
    overflow: hidden; /* Предотвращает скролл body, скролл будет внутри контейнера чата */
}
/* Стилизация скроллбара */
::-webkit-scrollbar{width:8px;}
::-webkit-scrollbar-track{background:var(--surface-color); border-radius:4px;} 
::-webkit-scrollbar-thumb{background:var(--border-color);border-radius:4px;} 
::-webkit-scrollbar-thumb:hover{background:#555;}

/* Основной контейнер контента */
.content-wrapper { 
    padding: 10px; 
    margin: 0; 
    flex-grow: 1; /* Занимает все доступное пространство по высоте */
    display: flex; 
    flex-direction: column;
    overflow: hidden; 
}
/* Контейнер для отображения чата */
#chat-container {
    background-color: var(--surface-color); 
    border: 1px solid var(--border-color);   
    border-radius: 8px;
    flex-grow:1; /* Занимает все доступное пространство внутри content-wrapper */
    overflow-y:auto; /* Включает вертикальный скролл, если сообщений много */
    padding-right:5px; /* Небольшой отступ справа для скроллбара */
    display:flex;
    flex-direction:column; /* Сообщения будут располагаться сверху вниз */
}
/* Внутренний контейнер для сообщений, позволяет новым сообщениям "прижиматься" к низу */
#chat-container-inner{
    margin-top:auto; /* Прижимает этот блок к низу #chat-container */
    padding-top:10px; /* Отступ сверху внутри этого блока */
    padding-left:10px; 
    padding-right:5px;
}
/* Стили для отдельного сообщения */
.message{
    margin-bottom:8px;
    padding:8px 12px;
    border-radius:6px;
    background-color:var(--player-entry-bg);
    border:1px solid var(--border-color);
    word-wrap:break-word; /* Перенос длинных слов */
    line-height:1.5;
    max-width:98%; /* Сообщение не будет слишком широким */
    align-self:flex-start; /* Выравнивание по левому краю */
    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
}
.message .timestamp{
    font-size:0.75em;
    color:var(--secondary-text-color);
    margin-right:6px;
    opacity:0.7;
}
.message .sender{
    font-weight:500;
    margin-right:5px;
    color: var(--chat-sender-default-color); /* Цвет по умолчанию */
}
/* Специфичные цвета для отправителей из разных команд */
.message .sender.team-ct {color: var(--chat-team-ct-color);}
.message .sender.team-t {color: var(--chat-team-t-color);}
.message .text{color: var(--primary-text-color); display: inline;} /* Текст сообщения */

/* Стили для плейсхолдера "Загрузка сообщений" или "Сообщений пока нет" */
.loading-placeholder{
    align-self:center; /* Центрирование плейсхолдера */
    color:var(--secondary-text-color);
    margin: 20px auto;
    font-size: 0.9em;
}
/* Статус-бар внизу страницы */
.status-bar { 
    flex-shrink: 0; /* Не сжимается */
    height: 40px; 
    padding: 8px 0; 
    background-color: var(--surface-color); 
    border-top: 1px solid var(--border-color); 
    text-align:center;
    font-size:0.85em;
    color:var(--secondary-text-color);
}
/* Анимация загрузчика в статус-баре */
.status-bar .loader{
    border:2px solid var(--border-color);
    border-radius:50%;
    border-top:2px solid var(--accent-color-1);
    width:12px;height:12px;
    animation:spin 1s linear infinite;
    display:inline-block;
    margin-left:6px;
    vertical-align:middle;
}
@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}
</style>
</head>
<body>
<div class="content-wrapper">
    <div id="chat-container">
        <div id="chat-container-inner">
            <div class="message loading-placeholder">Загрузка сообщений...</div>
        </div>
    </div>
</div>
<div class="status-bar">
    <span id="status-text">Ожидание данных...</span>
    <span id="loading-indicator" style="display: none;" class="loader"></span>
</div>
<script>
// Получаем ссылки на DOM-элементы
const chatContainerInner=document.getElementById('chat-container-inner');
const chatContainer=document.getElementById('chat-container'); // Основной контейнер с прокруткой
const statusText=document.getElementById('status-text');
const loadingIndicator=document.getElementById('loading-indicator');

// Переменные для управления запросами и ошибками
let isFetchingMessages=!1, messageErrorCount=0; const MAX_MESSAGE_ERRORS=5;
let displayedMessageKeys = new Set(); // Для отслеживания уникальных сообщений на клиенте

// Функция для запроса и отображения сообщений
async function fetchMessages(){
    if(isFetchingMessages||messageErrorCount>=MAX_MESSAGE_ERRORS)return;
    isFetchingMessages=!0;
    loadingIndicator.style.display='inline-block';
    try{
        const response=await fetch('/chat'); // Запрос на эндпоинт /chat
        if(!response.ok)throw new Error('Ошибка сети: '+response.status);
        const messages=await response.json(); // Получаем сообщения в формате JSON
        
        // Проверяем, нужно ли прокручивать чат вниз после добавления новых сообщений
        const isScrolledToBottom=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;
        
        // Очищаем предыдущие сообщения, если сервер прислал новый набор
        // или если это первый запуск и нужно заменить плейсхолдер
        if (messages.length === 0 && chatContainerInner.children.length > 0 && !chatContainerInner.querySelector('.loading-placeholder')) {
            // Если пришел пустой массив, а до этого были сообщения (не плейсхолдер)
            chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>';
            displayedMessageKeys.clear(); // Очищаем ключи отображенных сообщений
        } else if (messages.length > 0) {
            // Если есть новые сообщения, или если это первая загрузка с сообщениями
            let hasNewMessagesForDOM = false;
            let tempFragment = document.createDocumentFragment(); // Используем DocumentFragment для оптимизации

            messages.forEach(data => {
                const messageKey = \`\${data.ts}-\${data.sender}-\${data.msg}\`; // Уникальный ключ для сообщения
                if (!displayedMessageKeys.has(messageKey)) { // Отображаем только новые сообщения
                    const messageElement=document.createElement('div');
                    messageElement.className='message';
                    
                    const timeSpan=document.createElement('span');
                    timeSpan.className='timestamp';
                    timeSpan.textContent=\`[\${data.ts}]\`;
                    
                    const senderSpan=document.createElement('span');
                    senderSpan.className='sender';
                    senderSpan.textContent=data.sender+': '; // Добавляем двоеточие и пробел после ника
                    // Применяем класс для цвета команды
                    if(data.team==='CT'){senderSpan.classList.add('team-ct');}
                    else if(data.team==='T'){senderSpan.classList.add('team-t');}
                    // (можно добавить 'team-other' для наблюдателей, если нужно)
                    
                    const textSpan=document.createElement('span');
                    textSpan.className='text';
                    textSpan.textContent=data.msg;
                    
                    messageElement.appendChild(timeSpan);
                    messageElement.appendChild(senderSpan);
                    messageElement.appendChild(textSpan);
                    tempFragment.appendChild(messageElement);
                    displayedMessageKeys.add(messageKey);
                    hasNewMessagesForDOM = true;
                }
            });

            if (hasNewMessagesForDOM) {
                 // Если это первая загрузка сообщений и был плейсхолдер, очищаем его
                if (chatContainerInner.querySelector('.loading-placeholder')) {
                    chatContainerInner.innerHTML = '';
                }
                chatContainerInner.appendChild(tempFragment); // Добавляем все новые сообщения разом
            }
             // Ограничиваем количество сообщений в DOM, если их слишком много
            const MAX_MESSAGES_IN_CLIENT_DOM = 100; // Может быть равно или меньше MAX_CHAT_MESSAGES_DISPLAY
            while(chatContainerInner.children.length > MAX_MESSAGES_IN_CLIENT_DOM && chatContainerInner.firstChild.classList.contains('message') && !chatContainerInner.firstChild.classList.contains('loading-placeholder')) {
                // Удаляем самые старые сообщения из DOM и их ключи
                const oldestMessageElement = chatContainerInner.firstChild;
                // Построить ключ для удаления из displayedMessageKeys (сложнее без ID)
                // Для простоты, можно не удалять из displayedMessageKeys, если сервер сам ограничивает историю
                chatContainerInner.removeChild(oldestMessageElement);
            }
        } else if (chatContainerInner.children.length === 0 || chatContainerInner.querySelector('.loading-placeholder')) {
            // Если сообщений нет и был плейсхолдер, или контейнер пуст
             chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>';
        }


        // Прокрутка вниз, если пользователь был внизу
        if(isScrolledToBottom){
            setTimeout(()=>{chatContainer.scrollTop=chatContainer.scrollHeight},0);
        }
        statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();
        messageErrorCount=0; // Сбрасываем счетчик ошибок при успехе
    }catch(error){
        console.error('Ошибка при получении сообщений:',error);
        statusText.textContent='Ошибка: '+error.message+'. Попытка #'+(messageErrorCount+1);
        messageErrorCount++;
        if(messageErrorCount>=MAX_MESSAGE_ERRORS){
            statusText.textContent+=' Автообновление остановлено из-за ошибок.';
            if(intervalId) clearInterval(intervalId); // Останавливаем интервал
        }
    }finally{
        isFetchingMessages=!1;
        loadingIndicator.style.display='none';
    }
}
// Устанавливаем интервал для периодического обновления чата
const intervalId=setInterval(fetchMessages,3000); // Каждые 3 секунды
// Первоначальная загрузка сообщений через небольшую задержку
setTimeout(fetchMessages,100); 
</script>
</body></html>"""
# ----------------------------------------------

# --- Log Submission Handler ---
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST']) # Оставляем /gsi, если это один из источников логов
def receive_and_parse_logs_handler():
    global display_chat_messages # Указываем, что будем изменять глобальную переменную

    log_lines = []
    # Получение строк лога из запроса (JSON или простой текст)
    if request.is_json:
        data = request.get_json()
        if isinstance(data, dict) and 'lines' in data and isinstance(data.get('lines'), list):
            log_lines = data.get('lines', [])
        elif isinstance(data, list): # Если пришел просто список строк
            log_lines = data
        else:
            logger.warning("Получен JSON, но ключ 'lines' отсутствует, не список, или формат неизвестен.")
            # Попытка прочитать тело запроса как текст, если это GSI и не 'lines'
            raw_data_fallback = request.get_data(as_text=True)
            if raw_data_fallback:
                 log_lines = raw_data_fallback.splitlines()
    else: # Если не JSON, читаем как текст
        raw_data = request.get_data(as_text=True)
        if raw_data:
            log_lines = raw_data.splitlines()

    if not log_lines:
        return jsonify({"status": "error", "message": "Строки не предоставлены или не удалось их извлечь"}), 400
    
    new_messages_added_count = 0 # Счетчик добавленных сообщений в этой пачке

    for line_content in log_lines:
        if not line_content.strip(): # Пропускаем пустые строки
            continue
            
        # Пытаемся распарсить строку как чат-сообщение
        chat_match = CHAT_REGEX_SAY.search(line_content)
        if chat_match:
            extracted_data = chat_match.groupdict()
            chat_command_type = extracted_data['chat_command'].lower() # 'say' или 'say_team'
            sender_name_raw = extracted_data['player_name'].strip() # Имя отправителя до экранирования
            message_text_raw = extracted_data['message'].strip()    # Текст сообщения до экранирования
            
            # Проверка на команду !team1 от любого пользователя
            if message_text_raw.lower().startswith("!team1"):
                command_param_part = message_text_raw[len("!team1"):].strip() # Текст после "!team1 "
                logger.info(f"Пользователь '{sender_name_raw}' выполнил команду !team1 (параметр: '{command_param_part}'). Очистка чата.")
                display_chat_messages.clear() # Очищаем очередь сообщений
                
                # Добавляем системное сообщение об очистке
                system_message = {
                    "ts": datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3], # Текущее время
                    "sender": "СИСТЕМА",
                    "msg": f"Чат очищен по команде от {html.escape(sender_name_raw)}. Инфо: {html.escape(command_param_part)}",
                    "team": "Other" # Специальный тип команды для системных сообщений
                }
                display_chat_messages.append(system_message)
                new_messages_added_count +=1 
                continue # Переходим к следующей строке лога, не добавляя саму команду !team1 в чат

            # Обрабатываем только 'say' сообщения для отображения в общем чате
            if chat_command_type == "say":
                timestamp_str = extracted_data.get('timestamp', datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])
                player_team_raw = extracted_data['player_team'] # Команда игрока из лога (например, "CT", "TERRORIST")

                if not message_text_raw: # Пропускаем пустые сообщения
                    continue

                # Определяем идентификатор команды для стилизации на клиенте
                team_identifier = "Other" # По умолчанию
                if player_team_raw.upper() == "CT":
                    team_identifier = "CT"
                elif player_team_raw.upper() == "TERRORIST" or player_team_raw.upper() == "T":
                    team_identifier = "T"
                # Можно добавить другие команды (например, "SPECTATOR") если нужно их по-особому стилизовать
                
                # Создаем объект сообщения для добавления в очередь
                message_obj_for_display = {
                    "ts": timestamp_str,
                    "sender": html.escape(sender_name_raw), # Экранируем HTML-сущности в имени
                    "msg": html.escape(message_text_raw),   # и в сообщении
                    "team": team_identifier # Идентификатор команды для JS на клиенте
                }
                display_chat_messages.append(message_obj_for_display)
                new_messages_added_count += 1
    
    if new_messages_added_count > 0:
        logger.info(f"Добавлено {new_messages_added_count} сообщений для чата (включая системные, если были).")
            
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк."}), 200
# -----------------------------

# --- API Endpoint for Chat Data ---
# Клиент будет запрашивать этот эндпоинт для получения сообщений
@app.route('/chat', methods=['GET'])
def get_structured_chat_data():
    return jsonify(list(display_chat_messages)) # Возвращаем текущий список сообщений как JSON
# -----------------------------

# --- Main HTML Page Route ---
# Отдает основную HTML-страницу с чатом
@app.route('/', methods=['GET'])
def index():
    # Возвращаем HTML-код, определенный в MINIMAL_CHAT_HTML_WITH_CSS
    return Response(MINIMAL_CHAT_HTML_WITH_CSS, mimetype='text/html')
# -----------------------------

# --- Run Application ---
if __name__ == '__main__':
    # Получаем порт из переменной окружения PORT (для платформ типа Railway) или используем 8080 по умолчанию
    port = int(os.environ.get('PORT', 8080))
    # Запускаем Flask-приложение
    # debug=True полезно для разработки, но для продакшена лучше False или контролировать через переменные окружения
    app.run(host='0.0.0.0', port=port, debug=True) 
# -----------------------------
