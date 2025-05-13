# Файл: app.py
import logging
import os
import re
import datetime
import html
import json
from collections import deque
from flask import Flask, request, jsonify, Response
from flask_cors import CORS

# --- Flask App Setup ---
app = Flask(__name__)
CORS(app)

# --- Logging Configuration ---
logging.getLogger('werkzeug').setLevel(logging.WARNING)
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- Data Storage ---
MAX_CHAT_MESSAGES_DISPLAY = 100 # Максимум для отображаемого чата
MAX_CHAT_MESSAGES_DETECTED = 200 # Максимум для всех обнаруженных чат-записей
MAX_RAW_LOGS = 300
MAX_RAW_SCOREBOARD_INPUTS = 10 # Хранить последние N сырых JSON для scoreboard

# NEW: Переименовано chat_messages и добавлены новые хранилища для "сырых" данных
display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY) # Только 'say' сообщения, обогащенные для UI
all_detected_chat_log_entries = deque(maxlen=MAX_CHAT_MESSAGES_DETECTED) # Все записи, подошедшие под CHAT_REGEX_SAY (сырые данные)
raw_scoreboard_json_inputs = deque(maxlen=MAX_RAW_SCOREBOARD_INPUTS) # Сырые JSON-строки/объекты для scoreboard

raw_log_lines = deque(maxlen=MAX_RAW_LOGS) # Это уже содержит "чистейшие" строки логов
current_scoreboard_data = {"fields": [], "players": []} # Обработанные данные scoreboard
player_nickname_map = {}
# -----------------------

# --- Regex Definitions ---
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* # Start of line, optional whitespace
    (?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?          # Optional Date (DD/MM/YYYY - )
    (?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})      # Timestamp (HH:MM:SS.ms)
    \s+-\s+                                  # Separator " - "
    \"(?P<player_name>.+?)<(?P<userid>\d+)><(?P<steamid>\[U:\d:\d+\])><(?P<player_team>\w+)>\" # Player name, userid, steamid, team
    \s+                                      # Space
    (?P<chat_command>say|say_team)           # Chat command: say or say_team
    \s+                                      # Space
    \"(?P<message>.*)\"                      # Message content within quotes
    \s*$                                     # Optional whitespace, end of line
    """,
    re.VERBOSE | re.IGNORECASE
)

PLAYER_INFO_REGEX = re.compile(
    r"""
    \"(?P<nickname>.+?)
    <\d+>
    <\[U:1:(?P<accountid>\d+)\]>
    <\w+>\"
    """,
    re.VERBOSE | re.IGNORECASE
)
# ----------------------------------------------

temp_json_lines_buffer = []
is_capturing_json_block = False

# --- Вспомогательные функции ---
def strip_log_prefix(log_line_content):
    match_prefix = re.match(r"^(?:\s*(?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?(?:\d{2}:\d{2}:\d{2}\.\d{3}\s+-\s+)?)(.*)$", log_line_content)
    return (match_prefix.group(1) if match_prefix else log_line_content).strip()

def process_json_scoreboard_data(json_lines_list_buffer):
    global current_scoreboard_data, player_nickname_map, raw_scoreboard_json_inputs # Добавлено raw_scoreboard_json_inputs
    if not json_lines_list_buffer:
        logger.warning("process_json_scoreboard_data вызван с пустым буфером строк.")
        return False
    raw_json_str = "".join(json_lines_list_buffer)
    json_to_parse = re.sub(r',\s*([\}\]])', r'\1', raw_json_str)

    # NEW: Сохраняем сырой JSON (или попытку его представить как объект) перед парсингом
    input_data_for_log = json_to_parse
    try:
        # Попытка загрузить как JSON, чтобы сохранить структуру, если это возможно
        # Это делается только для логирования в raw_scoreboard_json_inputs, не для основного парсинга
        input_data_for_log = json.loads(json_to_parse)
    except json.JSONDecodeError:
        pass # Оставляем json_to_parse как строку, если это не валидный JSON

    raw_scoreboard_json_inputs.append({
        "timestamp": datetime.datetime.now().isoformat(),
        "input_data": input_data_for_log # Может быть строкой или словарем/списком
    })

    logger.debug(f"Попытка парсинга JSON для scoreboard (длина {len(json_to_parse)}). Начало: {json_to_parse[:1000]}...")
    try:
        scoreboard_payload = json.loads(json_to_parse) # Основной парсинг для работы
        logger.info("УСПЕХ: JSON-блок scoreboard распарсен.")
        log_fields_str = scoreboard_payload.get("fields")
        log_players_dict_from_json = scoreboard_payload.get("players")
        if not isinstance(log_fields_str, str) or not log_fields_str.strip():
            logger.warning("Scoreboard JSON ОШИБКА: 'fields' отсутствуют, пустые или не являются строкой.")
            return False
        if not isinstance(log_players_dict_from_json, dict):
            logger.warning("Scoreboard JSON ОШИБКА: 'players' отсутствуют или не являются словарем.")
            return False
        original_fields_from_log = [f.strip() for f in log_fields_str.split(',') if f.strip()]
        if not original_fields_from_log:
            logger.warning("Scoreboard JSON ОШИБКА: Список original_fields_from_log пуст после парсинга строки fields.")
            return False
        # ... (остальная логика функции без изменений, как в предыдущих версиях) ...
        display_fields = ['nickname']
        original_accountid_cased = None
        has_accountid_in_original = False
        for f_val in original_fields_from_log:
            if f_val.lower() == 'accountid':
                original_accountid_cased = f_val
                has_accountid_in_original = True
            if f_val.lower() not in ['nickname', 'accountid']:
                display_fields.append(f_val)
        if has_accountid_in_original and original_accountid_cased:
            display_fields.append(original_accountid_cased)
        elif has_accountid_in_original:
             display_fields.append('accountid')
        current_scoreboard_data['fields'] = display_fields
        new_players_list = []
        for player_log_key, player_values_str_log in log_players_dict_from_json.items():
            if not isinstance(player_values_str_log, str):
                logger.warning(f"Scoreboard JSON: Данные для игрока '{player_log_key}' не являются строкой.")
                continue
            player_values_list = [v.strip() for v in player_values_str_log.split(',')]
            if len(player_values_list) == len(original_fields_from_log):
                player_dict_temp = dict(zip(original_fields_from_log, player_values_list))
                acc_id_val = None
                found_accountid_key = None
                for key_s in player_dict_temp.keys(): # Ищем 'accountid' регистронезависимо
                    if key_s.lower() == 'accountid':
                        found_accountid_key = key_s
                        break
                if found_accountid_key: acc_id_val = player_dict_temp.get(found_accountid_key)
                elif original_fields_from_log and original_fields_from_log[0].lower() == 'accountid': acc_id_val = player_dict_temp.get(original_fields_from_log[0])

                if acc_id_val and acc_id_val.strip() and acc_id_val.strip() != "0":
                    nick = player_nickname_map.get(acc_id_val, f"ID:{acc_id_val}")
                    player_dict_temp['nickname'] = nick
                else:
                    player_name_from_stats = player_dict_temp.get('name', 'Spectator/Bot')
                    player_dict_temp['nickname'] = player_name_from_stats if ((not acc_id_val or acc_id_val == "0") and player_name_from_stats != 'Spectator/Bot') else 'Spectator/Bot'
                new_players_list.append(player_dict_temp)
            else:
                logger.warning(f"Scoreboard JSON ОШИБКА ДЛИН: Игрок '{player_log_key}'")
        current_scoreboard_data['players'] = new_players_list
        logger.info(f"Scoreboard успешно обновлен. Игроков: {len(current_scoreboard_data['players'])}")
        return True
    except json.JSONDecodeError as e:
        logger.error(f"JSONDecodeError для scoreboard: {e}. Данные: '{json_to_parse[:500]}...'")
    except Exception as e:
        logger.error(f"Непредвиденная ошибка при обработке JSON scoreboard: {e}", exc_info=True)
    return False
# -----------------------------

# --- Base CSS and Navigation HTML (Без изменений по сравнению с предыдущим ответом) ---
BASE_CSS = """<style>
:root{
    --bg-color:#1a1d24; --container-bg:#232730; --container-border:#3b4048; --text-color:#cdd6f4; --text-muted:#a6adc8;
    --accent-color-1:#89b4fa; --accent-color-2:#a6e3a1; --link-color:var(--accent-color-2); --link-hover-bg:#3e4451;
    --error-color:#f38ba8; --header-color:var(--accent-color-1); --scrollbar-bg:#313244; --scrollbar-thumb:#585b70;
    --font-primary:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; --font-mono:'Consolas','Courier New',monospace;
    --chat-team-ct-color: #89b4fa; --chat-team-t-color: #FFD700; --chat-sender-default-color: var(--accent-color-1);
}
*,*::before,*::after{box-sizing:border-box;}
body{font-family:var(--font-primary);background-color:var(--bg-color);color:var(--text-color);margin:0;padding:20px;display:flex;flex-direction:column;min-height:100vh;font-size:16px;}
h1{text-align:center;color:var(--header-color);margin:0 0 20px 0;font-weight:600;letter-spacing:1px;}
::-webkit-scrollbar{width:8px;} ::-webkit-scrollbar-track{background:var(--scrollbar-bg);border-radius:4px;} ::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border-radius:4px;} ::-webkit-scrollbar-thumb:hover{background:#6E738D;}
.navigation{display:flex;justify-content:center;align-items:center;padding:10px;margin-bottom:25px;background-color:var(--container-bg);border-radius:8px;border:1px solid var(--container-border);box-shadow:0 2px 8px rgba(0,0,0,0.3);}
.navigation a{color:var(--link-color);text-decoration:none;margin:0 10px;padding:8px 15px;border-radius:6px;transition:background-color 0.2s ease,color 0.2s ease;font-weight:500;}
.navigation a:hover,.navigation a:focus{background-color:var(--link-hover-bg);color:var(--text-color);outline:none;}
.nav-separator{color:var(--text-muted);opacity:0.5;}
.content-wrapper{background-color:var(--container-bg);border:1px solid var(--container-border);border-radius:8px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.3);flex-grow:1;display:flex;flex-direction:column;min-height:300px;}
.status-bar{text-align:center;font-size:0.9em;color:var(--text-muted);padding:15px 0 5px 0;height:20px;}
.status-bar .loader{border:3px solid var(--container-border);border-radius:50%;border-top:3px solid var(--accent-color-1);width:14px;height:14px;animation:spin 1s linear infinite;display:inline-block;margin-left:8px;vertical-align:middle;}
@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}
</style>"""
NAV_HTML = """<nav class="navigation">
<a href="/">Полный чат</a><span class="nav-separator">|</span>
<a href="/messages_only">Только сообщения</a><span class="nav-separator">|</span>
<a href="/raw_log_viewer">Анализатор Логов</a><span class="nav-separator">|</span>
<a href="/scoreboard_viewer">Таблица счета</a><span class="nav-separator">|</span>
<a href="/full_json">Все данные (JSON)</a>
</nav>"""

# --- HTML Templates (Без изменений по сравнению с предыдущим ответом) ---
HTML_TEMPLATE_MAIN = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CS2 Chat Viewer</title>
<style>
    #chat-container{flex-grow:1;overflow-y:auto;padding-right:10px;display:flex;flex-direction:column;}
    #chat-container-inner{margin-top:auto;padding-top:10px;}
    .message{margin-bottom:12px;padding:10px 15px;border-radius:8px;background-color:#2a2e37;border:1px solid #414550;word-wrap:break-word;line-height:1.5;max-width:85%;align-self:flex-start;}
    .message .timestamp{font-size:0.8em;color:var(--text-muted);margin-right:8px;opacity:0.7;}
    .message .sender{font-weight:600;margin-right:5px;color: var(--chat-sender-default-color);}
    .message .sender.team-ct {color: var(--chat-team-ct-color);}
    .message .sender.team-t {color: var(--chat-team-t-color);}
    .message .text{}
    .loading-placeholder{align-self:center;color:var(--text-muted);margin-top:20px;}
</style>
</head><body><div class="content-wrapper"><h1>CS2 Chat Viewer (Полный)</h1><div id="chat-container"><div id="chat-container-inner"><div class="message loading-placeholder">Загрузка сообщений...</div></div></div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display: none;" class="loader"></span></div>
<script>
const chatContainerInner=document.getElementById('chat-container-inner');const chatContainer=document.getElementById('chat-container');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;
async function fetchMessages(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error('Ошибка сети: '+response.status);const messages=await response.json();const isScrolledToBottom=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;chatContainerInner.innerHTML='';if(messages.length===0){chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>'}else{messages.forEach(data=>{const messageElement=document.createElement('div');messageElement.className='message';const timeSpan=document.createElement('span');timeSpan.className='timestamp';timeSpan.textContent=`[${data.ts}]`;const senderSpan=document.createElement('span');senderSpan.className='sender';senderSpan.textContent=data.sender+':';if(data.team==='CT'){senderSpan.classList.add('team-ct');}else if(data.team==='T'){senderSpan.classList.add('team-t');}const textSpan=document.createElement('span');textSpan.className='text';textSpan.textContent=data.msg;messageElement.appendChild(timeSpan);messageElement.appendChild(senderSpan);messageElement.appendChild(textSpan);chatContainerInner.appendChild(messageElement)})}if(isScrolledToBottom){setTimeout(()=>{chatContainer.scrollTop=chatContainer.scrollHeight},0)}statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();errorCount=0}catch(error){console.error('Ошибка:',error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}
const intervalId=setInterval(fetchMessages,3000);setTimeout(fetchMessages,500);
</script>
</body></html>"""
HTML_TEMPLATE_MSG_ONLY = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Chat (Только сообщения)</title><style>#messages-list{font-family:var(--font-primary);font-size:1.05em;line-height:1.7;padding:15px;}#messages-list div{margin-bottom:8px;padding-left:10px;border-left:3px solid var(--accent-color-1);}.content-wrapper h1{margin-bottom:20px;}</style></head><body><div class="content-wrapper"><h1>Только сообщения</h1><div id="messages-list">Загрузка...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const container=document.getElementById('messages-list');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;async function fetchMsgOnly(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error('Network error');const messages=await response.json();container.innerHTML='';if(messages.length===0){container.textContent='Нет сообщений.'}else{messages.forEach(data=>{const div=document.createElement('div');div.textContent=data.msg;container.appendChild(div)});window.scrollTo(0,document.body.scrollHeight)}statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();errorCount=0}catch(error){container.textContent='Ошибка загрузки.';console.error(error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchMsgOnly,3000);fetchMsgOnly();</script></body></html>"""
HTML_TEMPLATE_LOG_ANALYZER = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Log Analyzer</title><style>.content-wrapper h1{margin-bottom:20px;}#log-analyzer-output{font-family:var(--font-mono);font-size:13px;line-height:1.6;flex-grow:1;overflow-y:auto;padding:10px;background-color:#181a1f;border-radius:6px;}.log-line{margin-bottom:3px;padding:2px 5px;border-radius:3px;white-space:pre-wrap;word-break:break-all;cursor:default;}.log-line.chat{background-color:#36485e;color:#a6e3a1;border-left:3px solid #a6e3a1;}.log-line.kill{background-color:#5c374f;color:#f38ba8;border-left:3px solid #f38ba8;}.log-line.damage{background-color:#6e584c;color:#fab387;}.log-line.grenade{background-color:#3e4b6e;color:#cba6f7;}.log-line.purchase{background-color:#2e535e;color:#89dceb;}.log-line.pickup{background-color:#3e5a6e;color:#94e2d5;}.log-line.connect{color:#a6e3a1;}.log-line.disconnect{color:#f38ba8;}.log-line.system{color:var(--text-muted);font-style:italic;}.log-line.unknown{color:var(--text-muted);opacity:0.8;}</style></head><body><div class="content-wrapper"><h1>Анализатор Логов CS2</h1><div id="log-analyzer-output">Загрузка логов...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const outputContainer=document.getElementById('log-analyzer-output');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;const chatRegex=/(\\".+?\\"<\\d+><\\[U:\\d:\\d+\\]><\w+>)\\s+(?:say|say_team)\\s+\\"([^\\"]*)\\"/i;const killRegex=/killed\\s+\\".+?\\"<\\d+>/i;const damageRegex=/attacked\\s+\\".+?\\"<\\d+><.+?>.*\\(damage\\s+\\"\\d+\\"\\)/i;const grenadeRegex=/threw\\s+(hegrenade|flashbang|smokegrenade|molotov|decoy)/i;const connectRegex=/connected|entered the game/i;const disconnectRegex=/disconnected|left the game/i;const purchaseRegex=/purchased\\s+\\"(\\w+)\\"/i;const pickupRegex=/picked up\\s+\\"(\\w+)\\"/i;const teamSwitchRegex=/switched team to/i;const nameChangeRegex=/changed name to/i;function getLogLineInfo(line){if(chatRegex.test(line))return{type:'Чат',class:'chat'};if(killRegex.test(line))return{type:'Убийство',class:'kill'};if(damageRegex.test(line))return{type:'Урон',class:'damage'};if(grenadeRegex.test(line))return{type:'Граната',class:'grenade'};if(purchaseRegex.test(line))return{type:'Покупка',class:'purchase'};if(pickupRegex.test(line))return{type:'Подбор',class:'pickup'};if(connectRegex.test(line))return{type:'Подключение',class:'connect'};if(disconnectRegex.test(line))return{type:'Отключение',class:'disconnect'};if(teamSwitchRegex.test(line))return{type:'Смена команды',class:'system'};if(nameChangeRegex.test(line))return{type:'Смена ника',class:'system'};return{type:'Неизвестно/Система',class:'unknown'}}async function fetchAndAnalyzeLogs(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/raw_json');if(!response.ok)throw new Error('Ошибка сети: '+response.status);const logLines=await response.json();const isScrolledToBottom=outputContainer.scrollTop+outputContainer.clientHeight>=outputContainer.scrollHeight-50;outputContainer.innerHTML='';if(logLines.length===0){outputContainer.textContent='Нет данных лога для анализа.'}else{logLines.forEach(line=>{const info=getLogLineInfo(line);const lineDiv=document.createElement('div');lineDiv.className=`log-line ${info.class}`;lineDiv.textContent=line;lineDiv.title=`Тип: ${info.type}`;outputContainer.appendChild(lineDiv)})}if(isScrolledToBottom){setTimeout(()=>{outputContainer.scrollTop=outputContainer.scrollHeight},0)}statusText.textContent='Обновлено: '+new Date().toLocaleTimeString()+` (${logLines.length} строк)`;errorCount=0}catch(error){outputContainer.textContent='Ошибка загрузки или анализа логов.';console.error(error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchAndAnalyzeLogs,5000);fetchAndAnalyzeLogs();</script></body></html>"""
HTML_TEMPLATE_SCOREBOARD = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Scoreboard</title><style>
.content-wrapper h1{margin-bottom:20px;}
.scoreboard-teams-container{display:flex; flex-direction: column; align-items: center; gap: 25px; flex-wrap: nowrap;}
.team-table-wrapper{ width: 95%; margin-bottom: 20px;}
.team-table-wrapper h2{text-align:center;color:var(--text-muted);font-size:1.2em;margin-bottom:10px;}
table.scoreboard{width:100%;border-collapse:collapse;font-size:0.80em;font-family:var(--font-mono);}
.scoreboard th,.scoreboard td{border:1px solid var(--container-border);padding:5px 7px;text-align:left;white-space:nowrap;}
.scoreboard thead th{background-color:#2c313a;color:var(--accent-color-1);position:sticky;top:0;z-index:1;}
.team-ct tbody tr{background-color:rgba(137,180,250,0.07);}
.team-t tbody tr{background-color:rgba(250,173,137,0.07);}
.team-other tbody tr{background-color:rgba(120,120,120,0.07);}
.team-ct thead th{background-color:#3a5a8a;}
.team-t thead th{background-color:#8a5a3a;}
.team-other thead th{background-color:#4a4a4a;}
.scoreboard tbody tr:hover{background-color:var(--link-hover-bg);}
.no-data{text-align:center;padding:20px;color:var(--text-muted);}
.nickname-col{font-weight:bold;color:var(--text-color);}
</style></head><body><div class="content-wrapper"><h1>Таблица счета (Scoreboard)</h1><div class="scoreboard-teams-container" id="scoreboard-teams-container"></div><div id="scoreboard-placeholder" class="no-data">Загрузка данных таблицы счета...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const teamsContainer=document.getElementById('scoreboard-teams-container');const placeholder=document.getElementById('scoreboard-placeholder');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;
function createTeamTableElement(teamName,teamPlayers,fieldsToDisplay,teamClass){const wrapper=document.createElement('div');wrapper.className='team-table-wrapper';const title=document.createElement('h2');title.textContent=teamName;wrapper.appendChild(title);const table=document.createElement('table');table.className='scoreboard '+teamClass;const tableHead=table.createTHead();const tableBody=table.createTBody();const headerRow=tableHead.insertRow();let orderedFields=[...fieldsToDisplay];const nameKeys=['nickname','name','playername','имя','никнейм'];let actualNicknameKey=null;for(const key of nameKeys){const foundKey=orderedFields.find(f=>f.trim().toLowerCase()===key.toLowerCase());if(foundKey){actualNicknameKey=foundKey.trim();orderedFields=[actualNicknameKey,...orderedFields.filter(f=>f.trim().toLowerCase()!==actualNicknameKey.toLowerCase())];break}}orderedFields.forEach(field=>{const cleanFieldKey=field.trim().toLowerCase();if(cleanFieldKey!=='accountid'){const th=document.createElement('th');let headerText=field.trim();if(actualNicknameKey&&cleanFieldKey===actualNicknameKey.toLowerCase()){headerText='Игрок'}th.textContent=headerText;headerRow.appendChild(th)}});teamPlayers.slice(0,10).forEach(player=>{const row=tableBody.insertRow();orderedFields.forEach(fieldKey=>{const cleanFieldKey=fieldKey.trim().toLowerCase();if(cleanFieldKey!=='accountid'){const cell=row.insertCell();const cellValue=player[fieldKey.trim()]!==undefined?player[fieldKey.trim()]:'-';cell.textContent=cellValue;if(actualNicknameKey&&cleanFieldKey===actualNicknameKey.toLowerCase()){cell.classList.add('nickname-col')}}})});wrapper.appendChild(table);return wrapper}
function buildScoreboardTables(data){teamsContainer.innerHTML='';if(!data||!data.fields||data.fields.length===0||!data.players||data.players.length===0){placeholder.textContent='Нет данных об игроках или поля не определены.';teamsContainer.style.display='none'; if(data && data.players && data.players.length === 0) placeholder.textContent='Нет данных об игроках в командах.'; return;}teamsContainer.style.display='flex';placeholder.textContent='';const teamCtId='3';const teamTId='2';const teamCtName='Контр-Террористы (CT)';const teamTName='Террористы (T)';let playersCT=[],playersT=[],otherPlayers=[];if(data.players&&data.players.length>0){data.players.forEach(player=>{const teamFieldValue=player['team']?String(player['team']).trim():null;if(teamFieldValue===teamCtId)playersCT.push(player);else if(teamFieldValue===teamTId)playersT.push(player);else otherPlayers.push(player)})}let displayedSomething=!1;if(playersCT.length>0){teamsContainer.appendChild(createTeamTableElement(teamCtName,playersCT,data.fields,'team-ct'));displayedSomething=!0}if(playersT.length>0){teamsContainer.appendChild(createTeamTableElement(teamTName,playersT,data.fields,'team-t'));displayedSomething=!0}if(otherPlayers.length > 0 && !displayedSomething) { teamsContainer.appendChild(createTeamTableElement('Наблюдатели / Другие',otherPlayers,data.fields,'team-other')); displayedSomething = true; } else if (otherPlayers.length > 0) { teamsContainer.appendChild(createTeamTableElement('Наблюдатели / Другие',otherPlayers,data.fields,'team-other'));} if(!displayedSomething&&data.players&&data.players.length>0){teamsContainer.appendChild(createTeamTableElement('Игроки (команды не определены)',data.players,data.fields,'team-other'));displayedSomething=!0}if(!displayedSomething){placeholder.textContent='Нет данных об игроках в командах.'}}
async function fetchScoreboardData(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/scoreboard_json');if(!response.ok)throw new Error('Ошибка сети: '+response.status);const scoreboardData=await response.json();buildScoreboardTables(scoreboardData);statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();errorCount=0}catch(error){placeholder.textContent='Ошибка загрузки данных таблицы.';console.error(error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchScoreboardData,7000);fetchScoreboardData();</script></body></html>"""

@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST'])
def receive_and_parse_logs_handler():
    # Используем global для доступа к глобальным переменным
    global display_chat_messages, all_detected_chat_log_entries, raw_log_lines, \
           current_scoreboard_data, player_nickname_map, raw_scoreboard_json_inputs, \
           temp_json_lines_buffer, is_capturing_json_block

    log_lines = []
    if request.is_json: # Обработка JSON запросов
        data = request.get_json()
        if isinstance(data, dict) and 'lines' in data and isinstance(data.get('lines'), list):
            log_lines = data.get('lines', [])
        elif isinstance(data, list): # Если пришел просто список строк в JSON
             log_lines = data
        else:
            logger.warning("Получен JSON, но ключ 'lines' отсутствует, не список, или формат неизвестен.")
            raw_data_fallback = request.get_data(as_text=True) # Попытка прочитать как текст
            if raw_data_fallback: log_lines = raw_data_fallback.splitlines()
    else: # Обработка не-JSON (текстовых) запросов
        raw_data = request.get_data(as_text=True)
        if raw_data: log_lines = raw_data.splitlines()

    if not log_lines:
        return jsonify({"status": "error", "message": "Строки не предоставлены или не удалось их извлечь"}), 400
    
    raw_log_lines.extend(log_lines) # Сохраняем все пришедшие строки в их "чистейшем" виде

    # Обновление карты никнеймов
    updated_nick_count = 0
    for line in log_lines:
        if not line: continue
        for match in PLAYER_INFO_REGEX.finditer(line):
            player_info = match.groupdict()
            account_id = player_info.get('accountid')
            nickname = player_info.get('nickname')
            if account_id and nickname and player_nickname_map.get(account_id) != nickname:
                player_nickname_map[account_id] = nickname
                updated_nick_count += 1
    if updated_nick_count > 0:
        logger.info(f"Nickname map updated for {updated_nick_count} players.")

    new_display_chat_messages_count = 0 # Счетчик для сообщений, идущих в UI чат
    newly_added_to_all_detected_chat = 0 # Счетчик для всех обнаруженных чат-записей
    json_block_was_processed_in_this_call = False

    for line_content in log_lines:
        if not line_content.strip(): continue
        
        stripped_content_for_markers = strip_log_prefix(line_content) # Удаляем префикс лога для проверки JSON маркеров

        # Логика захвата JSON-блока для scoreboard
        if not is_capturing_json_block and "JSON_BEGIN{" in stripped_content_for_markers:
            is_capturing_json_block = True
            temp_json_lines_buffer = []
            try:
                actual_part = stripped_content_for_markers.split("JSON_BEGIN{", 1)[1]
                temp_json_lines_buffer.append("{" + actual_part)
            except IndexError:
                logger.warning(f"Malformed JSON_BEGIN line (no content after marker): {line_content}")
                is_capturing_json_block = False; continue
            logger.debug(f"JSON_BEGIN. Buffer started with: {temp_json_lines_buffer[0][:200]}")
            if "}}JSON_END" in temp_json_lines_buffer[0]: # Проверка на однострочный JSON
                end_marker_pos = temp_json_lines_buffer[0].rfind("}}JSON_END")
                temp_json_lines_buffer[0] = temp_json_lines_buffer[0][:end_marker_pos + 2]
                is_capturing_json_block = False
                logger.debug("Однострочный JSON блок будет обработан.")
            else:
                continue # Продолжаем собирать, если блок не завершен
        elif is_capturing_json_block:
            temp_json_lines_buffer.append(stripped_content_for_markers) # Добавляем строку как есть (без префикса)
            logger.debug(f"Added to JSON buffer: {stripped_content_for_markers[:200]}")
            if "}}JSON_END" in stripped_content_for_markers:
                is_capturing_json_block = False
                end_marker_pos = temp_json_lines_buffer[-1].rfind("}}JSON_END")
                if end_marker_pos != -1:
                    temp_json_lines_buffer[-1] = temp_json_lines_buffer[-1][:end_marker_pos + 2]
                logger.debug(f"JSON_END. Buffer finalized. Last part: {temp_json_lines_buffer[-1][:200]}")
            else:
                continue # Продолжаем собирать
        
        # Если блок JSON собран (is_capturing_json_block стало False и буфер не пуст)
        if not is_capturing_json_block and temp_json_lines_buffer:
            if process_json_scoreboard_data(temp_json_lines_buffer):
                json_block_was_processed_in_this_call = True
            temp_json_lines_buffer = [] # Очищаем буфер после обработки
            continue # Переходим к следующей строке лога, т.к. эта часть была JSON-блоком
        
        # Парсинг чат-сообщений (если это не JSON-блок)
        if not is_capturing_json_block:
            chat_match = CHAT_REGEX_SAY.search(line_content) # Используем оригинальную строку с префиксом
            if chat_match:
                extracted_data = chat_match.groupdict()
                chat_command = extracted_data['chat_command'].lower()
                # Для all_detected_chat_log_entries сохраняем неэкранированные данные
                sender_name_raw = extracted_data['player_name'].strip()
                message_text_raw = extracted_data['message'].strip()
                timestamp_str = extracted_data.get('timestamp', datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])
                player_team_raw = extracted_data['player_team']
                steamid_str = extracted_data['steamid']
                userid_str = extracted_data['userid']

                if not message_text_raw: # Пропускаем пустые сообщения
                    continue

                # NEW: Создаем "сырую" запись для all_detected_chat_log_entries
                raw_chat_entry = {
                    "timestamp": timestamp_str,
                    "player_name": sender_name_raw,
                    "message": message_text_raw,
                    "chat_command": chat_command,
                    "player_team_raw": player_team_raw, # Сохраняем как есть из лога
                    "steamid": steamid_str,
                    "userid": userid_str,
                }
                all_detected_chat_log_entries.append(raw_chat_entry)
                newly_added_to_all_detected_chat +=1

                # Фильтруем: обрабатываем для отображения только 'say'
                if chat_command == "say":
                    team_identifier = "Other" # По умолчанию
                    if player_team_raw.upper() == "CT":
                        team_identifier = "CT"
                    elif player_team_raw.upper() == "TERRORIST" or player_team_raw.upper() == "T":
                        team_identifier = "T"
                    # Можно добавить другие команды (например, "SPECTATOR" -> "SPEC") если нужно
                    
                    message_obj_for_display = {
                        "ts": timestamp_str,
                        "sender": html.escape(sender_name_raw), # Экранируем для безопасного отображения в HTML
                        "msg": html.escape(message_text_raw),   # Экранируем для HTML
                        "team": team_identifier # Идентификатор команды для UI
                    }
                    display_chat_messages.append(message_obj_for_display)
                    new_display_chat_messages_count += 1
    
    # Логирование результатов обработки пачки логов
    if new_display_chat_messages_count > 0:
        logger.info(f"Log Parser: Добавлено {new_display_chat_messages_count} сообщений 'say' для отображения в чат.")
    if newly_added_to_all_detected_chat > 0:
        logger.info(f"Log Parser: Обнаружено и сохранено {newly_added_to_all_detected_chat} чат-подобных записей (включая say_team).")
    if json_block_was_processed_in_this_call:
        logger.info("Блок Scoreboard был обработан в этом POST-запросе.")
        
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк."}), 200

# --- Эндпоинты ---
@app.route('/chat', methods=['GET'])
def get_structured_chat_data():
    # Этот эндпоинт используется для отображения чата в UI, поэтому отдает обработанные сообщения
    return jsonify(list(display_chat_messages))

@app.route('/raw_json', methods=['GET'])
def get_raw_log_lines():
    # Этот эндпоинт уже предоставляет "чистейшие" строки логов, как они пришли
    return jsonify(list(raw_log_lines))

@app.route('/scoreboard_json', methods=['GET'])
def get_scoreboard_data():
    # Отдает обработанные данные scoreboard для UI
    return jsonify(current_scoreboard_data)

# NEW: Обновленный /full_json для предоставления "чистейших" данных
@app.route('/full_json', methods=['GET'])
def get_all_data_json():
    all_data = {
        "raw_incoming_logs": list(raw_log_lines),                             # Все строки как есть
        "all_detected_chat_log_entries": list(all_detected_chat_log_entries), # Все, что подошло под CHAT_REGEX_SAY (say и say_team), базовая структура
        "processed_chat_for_display": list(display_chat_messages),            # Отфильтрованные 'say' сообщения, обогащенные для UI
        "raw_scoreboard_json_inputs": list(raw_scoreboard_json_inputs),       # Последние N сырых JSON-строк/объектов для scoreboard
        "processed_scoreboard_data": current_scoreboard_data,                 # Результат парсинга scoreboard
        "player_nickname_map": player_nickname_map                            # Карта никнеймов
    }
    return jsonify(all_data)

# --- HTML Page Routes ---
@app.route('/', methods=['GET'])
def index():
    html_content = BASE_CSS + NAV_HTML + HTML_TEMPLATE_MAIN
    return Response(html_content, mimetype='text/html')

@app.route('/messages_only', methods=['GET'])
def messages_only_page():
    # Этот эндпоинт будет показывать только текстовое содержимое отфильтрованных 'say' сообщений
    html_content = BASE_CSS + NAV_HTML + HTML_TEMPLATE_MSG_ONLY
    return Response(html_content, mimetype='text/html')

@app.route('/raw_log_viewer', methods=['GET'])
def raw_log_viewer_page():
    html_content = BASE_CSS + NAV_HTML + HTML_TEMPLATE_LOG_ANALYZER
    return Response(html_content, mimetype='text/html')

@app.route('/scoreboard_viewer', methods=['GET'])
def scoreboard_viewer_page():
    html_content = BASE_CSS + NAV_HTML + HTML_TEMPLATE_SCOREBOARD
    return Response(html_content, mimetype='text/html')
# ------------------------

# --- Run Application ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=True) # debug=True для разработки
# ---------------------