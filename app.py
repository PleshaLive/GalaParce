# Файл: app.py (Версия с исправленным импортом CORS и raw-string для Regex)
from flask import Flask, request, jsonify, Response
from flask_cors import CORS # <--- ИСПРАВЛЕНИЕ: Добавлен импорт CORS
import logging
from collections import deque
import os
import re
import datetime
import html
import json

app = Flask(__name__)
CORS(app) # Теперь эта строка будет работать

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')

# --- Хранилища данных ---
MAX_CHAT_MESSAGES = 100
MAX_RAW_LOGS = 300
chat_messages = deque(maxlen=MAX_CHAT_MESSAGES)
raw_log_lines = deque(maxlen=MAX_RAW_LOGS)
# -------------------------

# --- Regex для парсинга чата ---
# ИСПРАВЛЕНИЕ: Используем raw string (r""") для Regex
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* # Начало строки
    (?P<timestamp>\d{2}:\d{2}\.\d{3})\s+-\s+ # Захват времени (ЧЧ:ММ.мс) и разделителя ' - '
    (?P<player_info>\".+?\"<\d+><\[U:\d:\d+\]><\w+>) # Захват полной информации об игроке в кавычках и <>
    \s+ # Пробел
    (?:say|say_team) # Ищем слово 'say' или 'say_team' (без захвата)
    \s+ # Пробел
    \"(?P<message>[^\"]*)\" # Захватываем текст сообщения в кавычках
    \s*$ # Конец строки
    """,
    re.VERBOSE | re.IGNORECASE
)
# -------------------------------------------

# --- Общие CSS и HTML для Навигации (без изменений) ---
BASE_CSS = """<style>:root{--bg-color:#1a1d24;--container-bg:#232730;--container-border:#3b4048;--text-color:#cdd6f4;--text-muted:#a6adc8;--accent-color-1:#89b4fa;--accent-color-2:#a6e3a1;--link-color:var(--accent-color-2);--link-hover-bg:#3e4451;--error-color:#f38ba8;--header-color:var(--accent-color-1);--scrollbar-bg:#313244;--scrollbar-thumb:#585b70;--font-primary:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;--font-mono:'Consolas','Courier New',monospace;}*,*::before,*::after{box-sizing:border-box;}body{font-family:var(--font-primary);background-color:var(--bg-color);color:var(--text-color);margin:0;padding:20px;display:flex;flex-direction:column;min-height:100vh;font-size:16px;}h1{text-align:center;color:var(--header-color);margin:0 0 20px 0;font-weight:600;letter-spacing:1px;}::-webkit-scrollbar{width:8px;}::-webkit-scrollbar-track{background:var(--scrollbar-bg);border-radius:4px;}::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border-radius:4px;}::-webkit-scrollbar-thumb:hover{background:#6E738D;}.navigation{display:flex;justify-content:center;align-items:center;padding:10px;margin-bottom:25px;background-color:var(--container-bg);border-radius:8px;border:1px solid var(--container-border);box-shadow:0 2px 8px rgba(0,0,0,0.3);}.navigation a{color:var(--link-color);text-decoration:none;margin:0 15px;padding:8px 15px;border-radius:6px;transition:background-color 0.2s ease,color 0.2s ease;font-weight:500;}.navigation a:hover,.navigation a:focus{background-color:var(--link-hover-bg);color:var(--text-color);outline:none;}.nav-separator{color:var(--text-muted);opacity:0.5;}.content-wrapper{background-color:var(--container-bg);border:1px solid var(--container-border);border-radius:8px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.3);flex-grow:1;display:flex;flex-direction:column;min-height:300px;}.status-bar{text-align:center;font-size:0.9em;color:var(--text-muted);padding:15px 0 5px 0;height:20px;}.status-bar .loader{border:3px solid var(--container-border);border-radius:50%;border-top:3px solid var(--accent-color-1);width:14px;height:14px;animation:spin 1s linear infinite;display:inline-block;margin-left:8px;vertical-align:middle;}@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}</style>"""
NAV_HTML = f"""{BASE_CSS}<nav class="navigation"><a href="/">Полный чат</a><span class="nav-separator">|</span><a href="/messages_only">Только сообщения</a><span class="nav-separator">|</span><a href="/raw_log_viewer">Анализатор Логов</a></nav>"""
# ----------------------------------

# --- HTML Шаблоны для страниц (/, /messages_only, /raw_log_viewer) ---
# --- Используются обычные строки """...""", как в предыдущем исправлении ---

HTML_TEMPLATE_MAIN = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CS2 Chat Viewer</title><style>#chat-container{flex-grow:1;overflow-y:auto;padding-right:10px;display:flex;flex-direction:column;}#chat-container-inner{margin-top:auto;padding-top:10px;}.message{margin-bottom:12px;padding:10px 15px;border-radius:8px;background-color:#2a2e37;border:1px solid #414550;word-wrap:break-word;line-height:1.5;max-width:85%;align-self:flex-start;}.message .timestamp{font-size:0.8em;color:var(--text-muted);margin-right:8px;opacity:0.7;}.message .sender{font-weight:600;color:var(--accent-color-1);margin-right:5px;}.message .text{}.loading-placeholder{align-self:center;color:var(--text-muted);margin-top:20px;}</style></head><body><div class="content-wrapper"><h1>CS2 Chat Viewer (Полный)</h1><div id="chat-container"><div id="chat-container-inner"><div class="message loading-placeholder">Загрузка сообщений...</div></div></div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display: none;" class="loader"></span></div><script>const chatContainerInner=document.getElementById('chat-container-inner');const chatContainer=document.getElementById('chat-container');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;async function fetchMessages(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error(`Ошибка сети: ${response.status}`);const messages=await response.json();const isScrolledToBottom=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;chatContainerInner.innerHTML='';if(messages.length===0){chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>'}else{messages.forEach(data=>{const messageElement=document.createElement('div');messageElement.className='message';const timeSpan=document.createElement('span');timeSpan.className='timestamp';timeSpan.textContent=`[${data.ts}]`;const senderSpan=document.createElement('span');senderSpan.className='sender';senderSpan.textContent=data.sender+':';const textSpan=document.createElement('span');textSpan.className='text';textSpan.textContent=data.msg;messageElement.appendChild(timeSpan);messageElement.appendChild(senderSpan);messageElement.appendChild(textSpan);chatContainerInner.appendChild(messageElement)})}if(isScrolledToBottom){setTimeout(()=>{chatContainer.scrollTop=chatContainer.scrollHeight},0)}statusText.textContent=`Обновлено: ${new Date().toLocaleTimeString()}`;errorCount=0}catch(error){console.error('Ошибка:',error);statusText.textContent=`Ошибка: ${error.message}. #${errorCount+1}`;errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchMessages,3000);setTimeout(fetchMessages,500);</script></body></html>"""
HTML_TEMPLATE_MSG_ONLY = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Chat (Только сообщения)</title><style>#messages-list{font-family:var(--font-primary);font-size:1.05em;line-height:1.7;padding:15px;}#messages-list div{margin-bottom:8px;padding-left:10px;border-left:3px solid var(--accent-color-1);}.content-wrapper h1{margin-bottom:20px;}</style></head><body><div class="content-wrapper"><h1>Только сообщения</h1><div id="messages-list">Загрузка...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const container=document.getElementById('messages-list');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;async function fetchMsgOnly(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error('Network error');const messages=await response.json();const parentScrollTop=container.scrollTop;container.innerHTML='';if(messages.length===0){container.textContent='Нет сообщений.'}else{messages.forEach(data=>{const div=document.createElement('div');div.textContent=data.msg;container.appendChild(div)});window.scrollTo(0,document.body.scrollHeight)}statusText.textContent=`Обновлено: ${new Date().toLocaleTimeString()}`;errorCount=0}catch(error){container.textContent='Ошибка загрузки.';console.error(error);statusText.textContent=`Ошибка: ${error.message}. #${errorCount+1}`;errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchMsgOnly,3000);fetchMsgOnly();</script></body></html>"""
HTML_TEMPLATE_LOG_ANALYZER = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Log Analyzer</title><style>.content-wrapper h1{margin-bottom:20px;}#log-analyzer-output{font-family:var(--font-mono);font-size:13px;line-height:1.6;flex-grow:1;overflow-y:auto;padding:10px;background-color:#181a1f;border-radius:6px;}.log-line{margin-bottom:3px;padding:2px 5px;border-radius:3px;white-space:pre-wrap;word-break:break-all;cursor:default;}.log-line.chat{background-color:#36485e;color:#a6e3a1;border-left:3px solid #a6e3a1;}.log-line.kill{background-color:#5c374f;color:#f38ba8;border-left:3px solid #f38ba8;}.log-line.damage{background-color:#6e584c;color:#fab387;}.log-line.grenade{background-color:#3e4b6e;color:#cba6f7;}.log-line.purchase{background-color:#2e535e;color:#89dceb;}.log-line.pickup{background-color:#3e5a6e;color:#94e2d5;}.log-line.connect{color:#a6e3a1;}.log-line.disconnect{color:#f38ba8;}.log-line.system{color:var(--text-muted);font-style:italic;}.log-line.unknown{color:var(--text-muted);opacity:0.8;}</style></head><body><div class="content-wrapper"><h1>Анализатор Логов CS2</h1><div id="log-analyzer-output">Загрузка логов...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const outputContainer=document.getElementById('log-analyzer-output');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;const chatRegex=/(\".+?\"<\d+><\[U:\d:\d+\]><\w+>)\s+(?:say|say_team)\s+\"([^\"]*)\"/i;const killRegex=/killed\s+\".+?\"<\d+>/i;const damageRegex=/attacked\s+\".+?\"<\d+><.+?>.*\(damage\s+\"\d+\"\)/i;const grenadeRegex=/threw\s+(hegrenade|flashbang|smokegrenade|molotov|decoy)/i;const connectRegex=/connected|entered the game/i;const disconnectRegex=/disconnected|left the game/i;const purchaseRegex=/purchased\s+\"(\w+)\"/i;const pickupRegex=/picked up\s+\"(\w+)\"/i;const teamSwitchRegex=/switched team to/i;const nameChangeRegex=/changed name to/i;function getLogLineInfo(line){if(chatRegex.test(line))return{type:'Чат',class:'chat'};if(killRegex.test(line))return{type:'Убийство',class:'kill'};if(damageRegex.test(line))return{type:'Урон',class:'damage'};if(grenadeRegex.test(line))return{type:'Граната',class:'grenade'};if(purchaseRegex.test(line))return{type:'Покупка',class:'purchase'};if(pickupRegex.test(line))return{type:'Подбор',class:'pickup'};if(connectRegex.test(line))return{type:'Подключение',class:'connect'};if(disconnectRegex.test(line))return{type:'Отключение',class:'disconnect'};if(teamSwitchRegex.test(line))return{type:'Смена команды',class:'system'};if(nameChangeRegex.test(line))return{type:'Смена ника',class:'system'};return{type:'Неизвестно/Система',class:'unknown'}}async function fetchAndAnalyzeLogs(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/raw_json');if(!response.ok)throw new Error(`Ошибка сети: ${response.status}`);const logLines=await response.json();const isScrolledToBottom=outputContainer.scrollTop+outputContainer.clientHeight>=outputContainer.scrollHeight-50;outputContainer.innerHTML='';if(logLines.length===0){outputContainer.textContent='Нет данных лога для анализа.'}else{logLines.forEach(line=>{const info=getLogLineInfo(line);const lineDiv=document.createElement('div');lineDiv.className=`log-line ${info.class}`;lineDiv.textContent=line;lineDiv.title=`Тип: ${info.type}`;outputContainer.appendChild(lineDiv)})}if(isScrolledToBottom){setTimeout(()=>{outputContainer.scrollTop=outputContainer.scrollHeight},0)}statusText.textContent=`Обновлено: ${new Date().toLocaleTimeString()} (${logLines.length} строк)`;errorCount=0}catch(error){outputContainer.textContent='Ошибка загрузки или анализа логов.';console.error(error);statusText.textContent=`Ошибка: ${error.message}. #${errorCount+1}`;errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchAndAnalyzeLogs,5000);fetchAndAnalyzeLogs();</script></body></html>"""
# ----------------------------------


# --- Эндпоинты Flask ---

# Эндпоинт для приема строк лога (/submit_logs и /gsi)
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST'])
def receive_and_parse_logs_handler():
    global chat_messages, raw_log_lines
    log_lines = []
    if request.is_json:
        data = request.get_json(); log_lines = data.get('lines', []) if isinstance(data.get('lines'), list) else []
    else:
        raw_data = request.get_data(as_text=True); log_lines = raw_data.splitlines() if raw_data else []

    if not log_lines: return jsonify({"status": "error", "message": "No lines provided"}), 400
    app.logger.info(f"Log Parser: Получено {len(log_lines)} строк лога.")

    if log_lines: raw_log_lines.extend(log_lines) # Сохраняем сырые логи

    new_messages_found_count = 0; parsed_messages_batch = []
    current_time = datetime.datetime.now(datetime.timezone.utc)

    for line in log_lines:
        if not line: continue
        match = CHAT_REGEX_SAY.search(line) # Ищем только строки чата 'say'/'say_team'
        if match:
            extracted_data = match.groupdict()
            player_info_str = extracted_data['player_info']
            name_match = re.search(r'^\"(.*?)\"', player_info_str)
            sender = html.escape(name_match.group(1).strip()) if name_match else html.escape(player_info_str.strip())
            message = html.escape(extracted_data['message'].strip())
            timestamp = extracted_data.get('timestamp', current_time.strftime('%H:%M:%S.%f')[:-3])
            if not message: continue
            message_obj = {"ts": timestamp, "sender": sender, "msg": message}
            parsed_messages_batch.append(message_obj)
            new_messages_found_count += 1

    if parsed_messages_batch:
         chat_messages.extend(parsed_messages_batch) # Добавляем только сообщения чата
         app.logger.info(f"Log Parser: Добавлено {new_messages_found_count} новых ЧАТ сообщений. Всего: {len(chat_messages)}")

    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк, найдено {new_messages_found_count} чат сообщений"}), 200

# Эндпоинт, возвращающий ТОЛЬКО структурированные СООБЩЕНИЯ ЧАТА
@app.route('/chat', methods=['GET'])
def get_structured_chat_data():
    return jsonify(list(chat_messages))

# Эндпоинт, возвращающий СЫРЫЕ СТРОКИ ЛОГА
@app.route('/raw_json', methods=['GET'])
def get_raw_log_lines():
    return jsonify(list(raw_log_lines))

# Эндпоинт для главной страницы (/)
@app.route('/', methods=['GET'])
def index():
    full_html = BASE_CSS + NAV_HTML + HTML_TEMPLATE_MAIN # Собираем полный HTML
    return Response(full_html, mimetype='text/html')

# Эндпоинт для страницы только с текстом сообщений (/messages_only)
@app.route('/messages_only', methods=['GET'])
def messages_only_page():
    full_html = BASE_CSS + NAV_HTML + HTML_TEMPLATE_MSG_ONLY # Собираем полный HTML
    return Response(full_html, mimetype='text/html')

# Эндпоинт для страницы АНАЛИЗАТОРА ЛОГОВ (/raw_log_viewer)
@app.route('/raw_log_viewer', methods=['GET'])
def raw_log_viewer_page():
    full_html = BASE_CSS + NAV_HTML + HTML_TEMPLATE_LOG_ANALYZER # Собираем полный HTML
    return Response(full_html, mimetype='text/html')

# --- Запуск приложения ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False) # debug=False для Railway