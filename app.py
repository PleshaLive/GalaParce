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
MAX_CHAT_MESSAGES_DISPLAY = 100
MAX_CHAT_MESSAGES_DETECTED = 200
MAX_RAW_LOGS = 300
MAX_RAW_SCOREBOARD_INPUTS = 10

display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY)
all_detected_chat_log_entries = deque(maxlen=MAX_CHAT_MESSAGES_DETECTED)
raw_scoreboard_json_inputs = deque(maxlen=MAX_RAW_SCOREBOARD_INPUTS)
raw_log_lines = deque(maxlen=MAX_RAW_LOGS)
current_scoreboard_data = {"fields": [], "players": []}
player_nickname_map = {}
# -----------------------

# --- Regex Definitions ---
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* # Start of line, optional whitespace
    (?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?          # Optional Date (DD/MM/YYYY - )
    (?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})      # Timestamp (HH:MM:SS.ms)
    \s+-\s+                                      # Separator " - "
    \"(?P<player_name>.+?)<(?P<userid>\d+)><(?P<steamid>\[U:\d:\d+\])><(?P<player_team>\w+)>\" # Player name, userid, steamid, team
    \s+                                          # Space
    (?P<chat_command>say|say_team)               # Chat command: say or say_team
    \s+                                          # Space
    \"(?P<message>.*)\"                          # Message content within quotes
    \s*$                                         # Optional whitespace, end of line
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
    global current_scoreboard_data, player_nickname_map, raw_scoreboard_json_inputs
    if not json_lines_list_buffer:
        logger.warning("process_json_scoreboard_data вызван с пустым буфером строк.")
        return False
    raw_json_str = "".join(json_lines_list_buffer)
    json_to_parse = re.sub(r',\s*([\}\]])', r'\1', raw_json_str)

    input_data_for_log = json_to_parse
    try:
        input_data_for_log = json.loads(json_to_parse)
    except json.JSONDecodeError:
        pass 

    raw_scoreboard_json_inputs.append({
        "timestamp": datetime.datetime.now().isoformat(),
        "input_data": input_data_for_log
    })

    logger.debug(f"Попытка парсинга JSON для scoreboard (длина {len(json_to_parse)}). Начало: {json_to_parse[:1000]}...")
    try:
        scoreboard_payload = json.loads(json_to_parse) 
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
            logger.warning("Scoreboard JSON ОШИБКА: Список original_fields_from_log пуст.")
            return False

        display_fields = ['nickname'] 
        
        original_accountid_cased = None
        has_accountid_in_original = False
        
        desired_stat_fields = ['team','score', 'kills', 'deaths', 'assists', 'money', 'dmg', 'adr', 'kdr', 'hsp', 'mvp'] 
        
        temp_display_fields = {} 

        for f_val in original_fields_from_log:
            f_val_lower = f_val.lower()
            if f_val_lower == 'accountid':
                original_accountid_cased = f_val
                has_accountid_in_original = True
            if f_val_lower not in ['nickname', 'accountid']:
                temp_display_fields[f_val_lower] = f_val

        for key in desired_stat_fields:
            if key in temp_display_fields:
                display_fields.append(temp_display_fields[key])
        
        current_scoreboard_data['fields'] = display_fields
        new_players_list = []

        for player_log_key, player_values_str_log in log_players_dict_from_json.items():
            if not isinstance(player_values_str_log, str):
                logger.warning(f"Scoreboard JSON: Данные для игрока '{player_log_key}' не строка.")
                continue
            player_values_list = [v.strip() for v in player_values_str_log.split(',')]

            if len(player_values_list) == len(original_fields_from_log):
                player_dict_temp = dict(zip(original_fields_from_log, player_values_list))
                
                acc_id_val = None
                for key_s in player_dict_temp.keys():
                    if key_s.lower() == 'accountid':
                        acc_id_val = player_dict_temp[key_s]
                        break
                
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

# --- Base CSS and Navigation HTML ---
BASE_CSS = """<style>
:root{
    --bg-color:#121212; /* Глубокий темный фон */
    --surface-color:#1E1E1E; /* Фон для карточек/контейнеров */
    --primary-text-color:#E0E0E0; /* Основной светлый текст */
    --secondary-text-color:#A0A0A0; /* Вторичный, менее контрастный текст */
    --border-color:#333333; /* Цвет границ */
    --accent-color-1:#0DCAF0; /* Яркий акцент (например, для CT) - голубой/бирюзовый */
    --accent-color-2:#FFC107; /* Другой яркий акцент (например, для T) - желтый/янтарный */
    --link-color:var(--accent-color-1);
    --link-hover-bg:#2A2A2A;
    --header-color:var(--accent-color-1);
    --font-primary:'Roboto', 'Segoe UI', Helvetica, Arial, sans-serif; /* Более современный шрифт */
    --font-mono:'Fira Code', 'Consolas', 'Courier New', monospace;

    --chat-team-ct-color: var(--accent-color-1); 
    --chat-team-t-color: var(--accent-color-2);  
    --chat-sender-default-color: #B0BEC5; /* Нейтральный для остальных в чате */

    --team-ct-color: var(--accent-color-1);
    --team-t-color: var(--accent-color-2);
    --team-default-header-bg: #2E2E2E;
    --team-ct-header-bg: linear-gradient(to right, #0DCAF0, #0A9EBE);
    --team-t-header-bg: linear-gradient(to right, #FFC107, #FFA000);
    --player-entry-bg: #282828;
    --player-entry-hover-bg: #333;
    --player-name-color: #FFFFFF;
    --stat-value-color: #CFD8DC;
}
*,*::before,*::after{box-sizing:border-box;}
body{font-family:var(--font-primary);background-color:var(--bg-color);color:var(--primary-text-color);margin:0;padding:20px;line-height:1.6; font-weight: 300;}
h1,h2,h3{font-weight:400; letter-spacing: 0.5px;}
h1{text-align:center;color:var(--header-color);margin:0 0 25px 0;font-size: 2.2rem;}
h2{font-size: 1.5rem; color: var(--primary-text-color);}

::-webkit-scrollbar{width:10px;} 
::-webkit-scrollbar-track{background:var(--surface-color); border-radius:5px;} 
::-webkit-scrollbar-thumb{background:var(--border-color);border-radius:5px;} 
::-webkit-scrollbar-thumb:hover{background:#555;}

.navigation{display:flex;justify-content:center;align-items:center;padding:12px 0;margin-bottom:30px;background-color:var(--surface-color);border-radius:8px;border:1px solid var(--border-color);box-shadow:0 4px 15px rgba(0,0,0,0.2);}
.navigation a{color:var(--link-color);text-decoration:none;margin:0 15px;padding:10px 18px;border-radius:6px;transition:background-color 0.2s ease,color 0.2s ease;font-weight:400; letter-spacing: 0.5px;}
.navigation a:hover,.navigation a:focus{background-color:var(--link-hover-bg);color:var(--primary-text-color);outline:none;}
.nav-separator{color:var(--secondary-text-color);opacity:0.6;}
.content-wrapper{background-color:var(--surface-color);border:1px solid var(--border-color);border-radius:12px;padding:25px;box-shadow:0 6px 20px rgba(0,0,0,0.25);flex-grow:1;display:flex;flex-direction:column;min-height:400px;}
.status-bar{text-align:center;font-size:0.95em;color:var(--secondary-text-color);padding:20px 0 10px 0;height:25px;} /* Original height: 25px, padding: 20px 0 10px 0 */
.status-bar .loader{border:3px solid var(--border-color);border-radius:50%;border-top:3px solid var(--accent-color-1);width:16px;height:16px;animation:spin 1s linear infinite;display:inline-block;margin-left:10px;vertical-align:middle;}
@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}
</style>"""
NAV_HTML = """<nav class="navigation">
<a href="/">Полный чат</a><span class="nav-separator">|</span>
<a href="/messages_only">Только сообщения</a><span class="nav-separator">|</span>
<a href="/raw_log_viewer">Анализатор Логов</a><span class="nav-separator">|</span>
<a href="/scoreboard_viewer">Таблица счета</a><span class="nav-separator">|</span>
<a href="/full_json">Все данные (JSON)</a><span class="nav-separator">|</span>
<a href="/chat_only_nicknames">Только Чат (Ники)</a>
</nav>""" # Добавлена ссылка на новую страницу

# --- HTML Templates ---
HTML_TEMPLATE_MAIN = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CS2 Chat Viewer</title>
<style>
    #chat-container{flex-grow:1;overflow-y:auto;padding-right:15px;display:flex;flex-direction:column;}
    #chat-container-inner{margin-top:auto;padding-top:15px;}
    .message{margin-bottom:15px;padding:12px 18px;border-radius:10px;background-color:var(--player-entry-bg, #282828);border:1px solid var(--border-color);word-wrap:break-word;line-height:1.6;max-width:90%;align-self:flex-start; box-shadow: 0 2px 5px rgba(0,0,0,0.15);}
    .message .timestamp{font-size:0.85em;color:var(--secondary-text-color);margin-right:10px;opacity:0.8;}
    .message .sender{font-weight:500;margin-right:8px;color: var(--chat-sender-default-color);}
    .message .sender.team-ct {color: var(--chat-team-ct-color);}
    .message .sender.team-t {color: var(--chat-team-t-color);}
    .message .text{color: var(--primary-text-color);}
    .loading-placeholder{align-self:center;color:var(--secondary-text-color);margin-top:25px; font-size: 1.1em;}
</style>
</head><body><div class="content-wrapper"><h1>CS2 Chat Viewer</h1><div id="chat-container"><div id="chat-container-inner"><div class="message loading-placeholder">Загрузка сообщений...</div></div></div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display: none;" class="loader"></span></div>
<script>
const chatContainerInner=document.getElementById('chat-container-inner');const chatContainer=document.getElementById('chat-container');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;
async function fetchMessages(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error('Ошибка сети: '+response.status);const messages=await response.json();const isScrolledToBottom=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;chatContainerInner.innerHTML='';if(messages.length===0){chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>'}else{messages.forEach(data=>{const messageElement=document.createElement('div');messageElement.className='message';const timeSpan=document.createElement('span');timeSpan.className='timestamp';timeSpan.textContent=`[${data.ts}]`;const senderSpan=document.createElement('span');senderSpan.className='sender';senderSpan.textContent=data.sender+':';if(data.team==='CT'){senderSpan.classList.add('team-ct');}else if(data.team==='T'){senderSpan.classList.add('team-t');}const textSpan=document.createElement('span');textSpan.className='text';textSpan.textContent=data.msg;messageElement.appendChild(timeSpan);messageElement.appendChild(senderSpan);messageElement.appendChild(textSpan);chatContainerInner.appendChild(messageElement)})}if(isScrolledToBottom){setTimeout(()=>{chatContainer.scrollTop=chatContainer.scrollHeight},0)}statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();errorCount=0}catch(error){console.error('Ошибка:',error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}
const intervalId=setInterval(fetchMessages,3000);setTimeout(fetchMessages,500);
</script>
</body></html>"""
HTML_TEMPLATE_MSG_ONLY = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Chat (Только сообщения)</title><style>#messages-list{font-family:var(--font-primary);font-size:1.05em;line-height:1.7;padding:15px;}#messages-list div{margin-bottom:8px;padding:10px 15px;border-radius:8px; background-color: var(--player-entry-bg); border-left:4px solid var(--accent-color-1); color: var(--primary-text-color);}.content-wrapper h1{margin-bottom:20px;}</style></head><body><div class="content-wrapper"><h1>Только сообщения</h1><div id="messages-list">Загрузка...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const container=document.getElementById('messages-list');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;async function fetchMsgOnly(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error('Network error');const messages=await response.json();container.innerHTML='';if(messages.length===0){container.textContent='Нет сообщений.'}else{messages.forEach(data=>{const div=document.createElement('div');div.textContent=data.msg;container.appendChild(div)});window.scrollTo(0,document.body.scrollHeight)}statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();errorCount=0}catch(error){container.textContent='Ошибка загрузки.';console.error(error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchMsgOnly,3000);fetchMsgOnly();</script></body></html>"""
HTML_TEMPLATE_LOG_ANALYZER = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Log Analyzer</title><style>.content-wrapper h1{margin-bottom:20px;}#log-analyzer-output{font-family:var(--font-mono);font-size:0.8rem;line-height:1.7;flex-grow:1;overflow-y:auto;padding:15px;background-color:#171717;border-radius:8px; border: 1px solid var(--border-color);}.log-line{margin-bottom:4px;padding:3px 8px;border-radius:4px;white-space:pre-wrap;word-break:break-all;cursor:default; transition: background-color 0.2s;}.log-line:hover{background-color: #2A2A2A;}.log-line.chat{background-color:rgba(13,202,240,0.1);color:#89dceb;border-left:3px solid var(--accent-color-1);}.log-line.kill{background-color:rgba(243,139,168,0.1);color:#f38ba8;border-left:3px solid var(--error-color);}.log-line.damage{background-color:rgba(250,176,135,0.1);color:#fab387;}.log-line.grenade{background-color:rgba(203,166,247,0.1);color:#cba6f7;}.log-line.purchase{background-color:rgba(137,220,235,0.1);color:#89dceb;}.log-line.pickup{background-color:rgba(148,226,213,0.1);color:#94e2d5;}.log-line.connect{color:#a6e3a1;}.log-line.disconnect{color:#f38ba8;}.log-line.system{color:var(--secondary-text-color);font-style:italic;}.log-line.unknown{color:var(--secondary-text-color);opacity:0.7;}</style></head><body><div class="content-wrapper"><h1>Анализатор Логов CS2</h1><div id="log-analyzer-output">Загрузка логов...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const outputContainer=document.getElementById('log-analyzer-output');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;const chatRegex=/(\\".+?\\"<\\d+><\\[U:\\d:\\d+\\]><\w+>)\\s+(?:say|say_team)\\s+\\"([^\\"]*)\\"/i;const killRegex=/killed\\s+\\".+?\\"<\\d+>/i;const damageRegex=/attacked\\s+\\".+?\\"<\\d+><.+?>.*\\(damage\\s+\\"\\d+\\"\\)/i;const grenadeRegex=/threw\\s+(hegrenade|flashbang|smokegrenade|molotov|decoy)/i;const connectRegex=/connected|entered the game/i;const disconnectRegex=/disconnected|left the game/i;const purchaseRegex=/purchased\\s+\\"(\\w+)\\"/i;const pickupRegex=/picked up\\s+\\"(\\w+)\\"/i;const teamSwitchRegex=/switched team to/i;const nameChangeRegex=/changed name to/i;function getLogLineInfo(line){if(chatRegex.test(line))return{type:'Чат',class:'chat'};if(killRegex.test(line))return{type:'Убийство',class:'kill'};if(damageRegex.test(line))return{type:'Урон',class:'damage'};if(grenadeRegex.test(line))return{type:'Граната',class:'grenade'};if(purchaseRegex.test(line))return{type:'Покупка',class:'purchase'};if(pickupRegex.test(line))return{type:'Подбор',class:'pickup'};if(connectRegex.test(line))return{type:'Подключение',class:'connect'};if(disconnectRegex.test(line))return{type:'Отключение',class:'disconnect'};if(teamSwitchRegex.test(line))return{type:'Смена команды',class:'system'};if(nameChangeRegex.test(line))return{type:'Смена ника',class:'system'};return{type:'Неизвестно/Система',class:'unknown'}}async function fetchAndAnalyzeLogs(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/raw_json');if(!response.ok)throw new Error('Ошибка сети: '+response.status);const logLines=await response.json();const isScrolledToBottom=outputContainer.scrollTop+outputContainer.clientHeight>=outputContainer.scrollHeight-50;outputContainer.innerHTML='';if(logLines.length===0){outputContainer.textContent='Нет данных лога для анализа.'}else{logLines.forEach(line=>{const info=getLogLineInfo(line);const lineDiv=document.createElement('div');lineDiv.className=`log-line ${info.class}`;lineDiv.textContent=line;lineDiv.title=`Тип: ${info.type}`;outputContainer.appendChild(lineDiv)})}if(isScrolledToBottom){setTimeout(()=>{outputContainer.scrollTop=outputContainer.scrollHeight},0)}statusText.textContent='Обновлено: '+new Date().toLocaleTimeString()+` (${logLines.length} строк)`;errorCount=0}catch(error){outputContainer.textContent='Ошибка загрузки или анализа логов.';console.error(error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchAndAnalyzeLogs,5000);fetchAndAnalyzeLogs();</script></body></html>"""
HTML_TEMPLATE_SCOREBOARD = """<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS2 Scoreboard</title>
    <style>
        :root { /* Уже определены в BASE_CSS, но для наглядности */
            /* --team-ct-color: #0DCAF0; */
            /* --team-t-color: #FFC107; */
            /* --surface-color: #1E1E1E; */
            /* --primary-text-color: #E0E0E0; */
            /* --secondary-text-color: #A0A0A0; */
            /* --border-color: #333333; */
            /* --player-entry-bg: #282828; */
            /* --player-entry-hover-bg: #333; */
        }
        .scoreboard-page-wrapper {
            padding-top: 20px;
        }
        .scoreboard-title { /* Уже есть h1 в content-wrapper */
            /* text-align: center; color: var(--header-color); margin-bottom: 30px; font-size: 2rem; */
        }
        .scoreboard-teams-container {
            display: flex;
            flex-wrap: wrap; /* Позволяет переносить команды на новую строку на малых экранах */
            gap: 30px; /* Пространство между командами */
            justify-content: center; /* Центрирование команд, если есть место */
        }
        .team-scoreboard {
            background-color: var(--surface-color, #1E1E1E);
            border-radius: 12px;
            border: 1px solid var(--border-color, #333);
            padding: 0; /* Убираем внутренний отступ, он будет в header/list */
            flex: 1; /* Позволяет командам занимать доступное пространство */
            min-width: 300px; /* Минимальная ширина для каждой команды */
            max-width: 600px; /* Максимальная ширина, чтобы не слишком растягивались */
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            overflow: hidden; /* Чтобы border-radius работал с внутренними элементами */
        }
        .team-header {
            padding: 18px 22px;
            color: white;
            display: flex;
            align-items: center;
            justify-content: space-between; /* Имя команды слева, счет справа */
            font-size: 1.4em;
            font-weight: 500;
            border-bottom: 1px solid var(--border-color, #333);
        }
        .team-header.team-ct-header { background: var(--team-ct-header-bg, var(--team-ct-color)); }
        .team-header.team-t-header { background: var(--team-t-header-bg, var(--team-t-color)); }
        .team-header.team-other-header { background: var(--team-default-header-bg, #2E2E2E); }
        
        .team-name-logo { display: flex; align-items: center; gap: 12px; }
        .team-logo { width: 32px; height: 32px; /* или другие размеры */ }
        .team-score-value { font-size: 1.3em; font-weight: bold; }

        .player-list-header, .player-entry {
            display: grid; /* Используем Grid для выравнивания колонок */
            /* Динамически настроим grid-template-columns в JS */
            gap: 10px;
            padding: 10px 22px;
            align-items: center;
            font-family: var(--font-mono, monospace);
            font-size: 0.85rem;
            border-bottom: 1px solid var(--border-color, #333333);
        }
        .player-list-header {
            color: var(--secondary-text-color, #A0A0A0);
            font-weight: bold;
            text-transform: uppercase;
            font-size: 0.75rem;
            letter-spacing: 0.5px;
            background-color: rgba(0,0,0,0.1);
        }
        .player-list .player-entry:last-child {
            border-bottom: none;
        }
        .player-entry {
            color: var(--primary-text-color, #E0E0E0);
            background-color: var(--player-entry-bg, #282828);
            transition: background-color 0.2s ease;
        }
        .player-entry:hover {
            background-color: var(--player-entry-hover-bg, #333);
        }
        .player-name {
            font-weight: 500;
            color: var(--player-name-color, #FFFFFF);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .player-stat {
            text-align: right;
            color: var(--stat-value-color, #CFD8DC);
        }
        .stat-header {
             text-align: right;
        }
        .no-data {
            text-align: center;
            padding: 40px;
            color: var(--secondary-text-color, #A0A0A0);
            font-size: 1.1em;
        }
        /* Адаптивность: на маленьких экранах команды будут друг под другом */
        @media (max-width: 768px) {
            .scoreboard-teams-container {
                flex-direction: column;
                align-items: center; /* Центрируем карточки команд */
            }
            .team-scoreboard {
                width: 100%; /* Занимаем всю ширину */
                max-width: 500px; /* Ограничение, чтобы не было слишком широко на планшетах */
            }
        }
    </style>
</head>
<body>
    <div class="content-wrapper scoreboard-page-wrapper">
        <div class="scoreboard-teams-container" id="scoreboard-teams-container">
            </div>
        <div id="scoreboard-placeholder" class="no-data">Загрузка данных таблицы счета...</div>
    </div>
    <div class="status-bar">
        <span id="status-text">Ожидание данных...</span>
        <span id="loading-indicator" style="display:none;" class="loader"></span>
    </div>

<script>
const teamsContainer = document.getElementById('scoreboard-teams-container');
const placeholder = document.getElementById('scoreboard-placeholder');
const statusText = document.getElementById('status-text');
const loadingIndicator = document.getElementById('loading-indicator');
let isFetchingSb = false, errorCountSb = 0;
const MAX_ERRORS_SB = 5;

const STAT_HEADERS_CONFIG = {
    'team': 'Ком.', 
    'score': 'Очки',
    'kills': 'Уб.',
    'deaths': 'См.',
    'assists': 'Ас.',
    'money': '$',
    'dmg': 'Урон',
    'adr': 'ADR',
    'kdr': 'KDR',
    'hsp': 'HS%',
    'mvp': 'MVP'
};


function createTeamScoreboardElement(teamDisplayName, teamIdName, teamPlayers, fieldsFromServer) {
    const wrapper = document.createElement('div');
    wrapper.className = 'team-scoreboard team-' + teamIdName.toLowerCase(); 

    const header = document.createElement('div');
    header.className = 'team-header team-' + teamIdName.toLowerCase() + '-header';
    
    const teamNameLogoDiv = document.createElement('div');
    teamNameLogoDiv.className = 'team-name-logo';
    const nameH2 = document.createElement('h2');
    nameH2.textContent = teamDisplayName;
    teamNameLogoDiv.appendChild(nameH2);
    header.appendChild(teamNameLogoDiv);
    
    wrapper.appendChild(header);

    const playerListDiv = document.createElement('div');
    playerListDiv.className = 'player-list';

    const displayableFields = fieldsFromServer.filter(f => f.toLowerCase() !== 'nickname' && f.toLowerCase() !== 'accountid');
    
    let gridColumns = "minmax(120px, 1.5fr) "; 
    const statFieldsToDisplay = [];

    for (const fieldKey of displayableFields) {
        if (STAT_HEADERS_CONFIG[fieldKey.toLowerCase()]) {
            gridColumns += "minmax(40px, 0.5fr) "; 
            statFieldsToDisplay.push(fieldKey);
        } else if (fieldKey.toLowerCase() === 'team' && !STAT_HEADERS_CONFIG['team']){ 
        }
    }
    
    const listHeader = document.createElement('div');
    listHeader.className = 'player-list-header';
    listHeader.style.gridTemplateColumns = gridColumns.trim();
    
    const playerNameHeader = document.createElement('span');
    playerNameHeader.className = 'player-name-header';
    playerNameHeader.textContent = 'Игрок';
    listHeader.appendChild(playerNameHeader);

    statFieldsToDisplay.forEach(fieldKey => {
        const statHeader = document.createElement('span');
        statHeader.className = 'stat-header';
        statHeader.textContent = STAT_HEADERS_CONFIG[fieldKey.toLowerCase()] || fieldKey;
        listHeader.appendChild(statHeader);
    });
    playerListDiv.appendChild(listHeader);

    teamPlayers.slice(0, 10).forEach(player => { 
        const entry = document.createElement('div');
        entry.className = 'player-entry';
        entry.style.gridTemplateColumns = gridColumns.trim();

        const nameSpan = document.createElement('span');
        nameSpan.className = 'player-name';
        nameSpan.textContent = player.nickname || 'N/A';
        entry.appendChild(nameSpan);

        statFieldsToDisplay.forEach(fieldKey => {
            const statSpan = document.createElement('span');
            statSpan.className = 'player-stat stat-' + fieldKey.toLowerCase();
            let statValue = '-';
            for (const pKey in player) {
                if (pKey.toLowerCase() === fieldKey.toLowerCase()) {
                    statValue = player[pKey] !== undefined ? player[pKey] : '-';
                    break;
                }
            }
            statSpan.textContent = statValue;
            entry.appendChild(statSpan);
        });
        playerListDiv.appendChild(entry);
    });

    wrapper.appendChild(playerListDiv);
    return wrapper;
}

function buildScoreboardTables(data) {
    teamsContainer.innerHTML = ''; 
    if (!data || !data.fields || data.fields.length === 0 || !data.players || data.players.length === 0) {
        placeholder.textContent = 'Нет данных об игроках или поля не определены.';
        placeholder.style.display = 'block';
        return;
    }
    placeholder.style.display = 'none';

    const teamCtId = '3'; 
    const teamTId = '2';  
    const teamCtName = 'Контр-Террористы';
    const teamTName = 'Террористы';

    let playersCT = [], playersT = [], otherPlayers = [];

    if (data.players && data.players.length > 0) {
        data.players.forEach(player => {
            let teamFieldValue = null;
            for (const key in player) {
                if (key.toLowerCase() === 'team') {
                    teamFieldValue = player[key] ? String(player[key]).trim() : null;
                    break;
                }
            }

            if (teamFieldValue === teamCtId) playersCT.push(player);
            else if (teamFieldValue === teamTId) playersT.push(player);
            else otherPlayers.push(player);
        });
    }

    let displayedSomething = false;
    if (playersCT.length > 0) {
        teamsContainer.appendChild(createTeamScoreboardElement(teamCtName, 'CT', playersCT, data.fields));
        displayedSomething = true;
    }
    if (playersT.length > 0) {
        teamsContainer.appendChild(createTeamScoreboardElement(teamTName, 'T', playersT, data.fields));
        displayedSomething = true;
    }
    
    if (otherPlayers.length > 0) {
         teamsContainer.appendChild(createTeamScoreboardElement('Наблюдатели / Другие', 'Other', otherPlayers, data.fields));
         displayedSomething = true;
    }


    if (!displayedSomething) {
        if (data.players && data.players.length > 0) {
             teamsContainer.appendChild(createTeamScoreboardElement('Игроки (без команды)', 'Other', data.players, data.fields));
        } else {
            placeholder.textContent = 'Нет данных об игроках в командах.';
            placeholder.style.display = 'block';
        }
    }
}

async function fetchScoreboardDataSb() {
    if (isFetchingSb || errorCountSb >= MAX_ERRORS_SB) return;
    isFetchingSb = true;
    loadingIndicator.style.display = 'inline-block';
    try {
        const response = await fetch('/scoreboard_json');
        if (!response.ok) throw new Error('Network error: ' + response.status);
        const scoreboardData = await response.json();
        buildScoreboardTables(scoreboardData);
        statusText.textContent = 'Обновлено: ' + new Date().toLocaleTimeString();
        errorCountSb = 0;
    } catch (error) {
        placeholder.textContent = 'Ошибка загрузки данных таблицы.';
        console.error('Ошибка scoreboard:', error);
        statusText.textContent = 'Ошибка: ' + error.message + '. #' + (errorCountSb + 1);
        errorCountSb++;
        if (errorCountSb >= MAX_ERRORS_SB) {
            statusText.textContent += ' Автообновление остановлено.';
            clearInterval(intervalIdSb);
        }
    } finally {
        isFetchingSb = false;
        loadingIndicator.style.display = 'none';
    }
}
const intervalIdSb = setInterval(fetchScoreboardDataSb, 7000);
fetchScoreboardDataSb(); // Initial fetch
</script>
</body>
</html>
"""

# --- НОВЫЙ CSS ДЛЯ СТРАНИЦЫ "ТОЛЬКО ЧАТ" ---
CHAT_PAGE_SPECIFIC_CSS = """<style>
body { 
    padding: 0; /* Убираем общий padding страницы */
    display: flex; 
    flex-direction: column; 
    height: 100vh; /* Занимаем всю высоту вьюпорта */
    margin: 0; /* Убедимся, что нет отступов у body */
}
.navigation { display: none !important; } /* Скрываем навигацию */
h1 { display: none !important; } /* Скрываем основной заголовок H1 */

.content-wrapper { 
    /* Переопределяем стили для content-wrapper на этой странице */
    padding: 10px; /* Небольшие отступы вокруг основного содержимого (чата) */
    margin: 0; 
    border: none; 
    border-radius: 0; 
    box-shadow: none; 
    
    flex-grow: 1; /* Занимает все доступное пространство по высоте */
    display: flex; 
    flex-direction: column;
    overflow: hidden; /* Предотвращает выход контента за пределы */
}

#chat-container {
    /* flex-grow, overflow-y, display:flex, flex-direction:column - уже есть во встроенных стилях шаблона ниже */
    background-color: var(--surface-color); /* Фон для области чата */
    border: 1px solid var(--border-color);   /* Рамка для области чата */
    border-radius: 8px;                      /* Скругление углов области чата */
    /* padding-right: 15px; - из встроенных стилей, можно оставить или уменьшить если нужно */
}

/* #chat-container-inner стили (margin-top:auto, padding-top) остаются из встроенных */

.status-bar { 
    flex-shrink: 0; /* Статус-бар не будет сжиматься */
    height: 45px; /* Фиксированная высота для статус-бара */
    padding: 10px 0; /* Переопределит padding из BASE_CSS */
    background-color: var(--surface-color); /* Фон для статус-бара */
    border-top: 1px solid var(--border-color); /* Верхняя граница для статус-бара */
    /* text-align, font-size, color - наследуются или остаются из BASE_CSS */
}
</style>"""

# --- НОВЫЙ HTML ШАБЛОН ДЛЯ СТРАНИЦЫ "ТОЛЬКО ЧАТ" ---
HTML_TEMPLATE_CHAT_ONLY_NICKNAMES = """<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CS2 Chat - Только Никнеймы</title>
<style>
  /* Стили из HTML_TEMPLATE_MAIN для чата, они остаются актуальными */
  #chat-container{flex-grow:1;overflow-y:auto;padding-right:15px;display:flex;flex-direction:column;}
  #chat-container-inner{margin-top:auto;padding-top:15px; padding-left:10px; padding-right:5px;}
  .message{margin-bottom:10px;padding:10px 15px;border-radius:8px;background-color:var(--player-entry-bg, #282828);border:1px solid var(--border-color);word-wrap:break-word;line-height:1.5;max-width:95%;align-self:flex-start; box-shadow: 0 1px 3px rgba(0,0,0,0.1);}
  .message .timestamp{font-size:0.8em;color:var(--secondary-text-color);margin-right:8px;opacity:0.75;}
  .message .sender{font-weight:500;margin-right:6px;color: var(--chat-sender-default-color);}
  .message .sender.team-ct {color: var(--chat-team-ct-color);}
  .message .sender.team-t {color: var(--chat-team-t-color);}
  .message .text{color: var(--primary-text-color);}
  .loading-placeholder{align-self:center;color:var(--secondary-text-color);margin-top:20px; font-size: 1em;}
</style>
</head><body>
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
// JavaScript для обновления чата (такой же, как в HTML_TEMPLATE_MAIN)
const chatContainerInner=document.getElementById('chat-container-inner');const chatContainer=document.getElementById('chat-container');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;
async function fetchMessages(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error('Ошибка сети: '+response.status);const messages=await response.json();const isScrolledToBottom=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;chatContainerInner.innerHTML='';if(messages.length===0){chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>'}else{messages.forEach(data=>{const messageElement=document.createElement('div');messageElement.className='message';const timeSpan=document.createElement('span');timeSpan.className='timestamp';timeSpan.textContent=`[${data.ts}]`;const senderSpan=document.createElement('span');senderSpan.className='sender';senderSpan.textContent=data.sender+':';if(data.team==='CT'){senderSpan.classList.add('team-ct');}else if(data.team==='T'){senderSpan.classList.add('team-t');}const textSpan=document.createElement('span');textSpan.className='text';textSpan.textContent=data.msg;messageElement.appendChild(timeSpan);messageElement.appendChild(senderSpan);messageElement.appendChild(textSpan);chatContainerInner.appendChild(messageElement)})}if(isScrolledToBottom){setTimeout(()=>{chatContainer.scrollTop=chatContainer.scrollHeight},0)}statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();errorCount=0}catch(error){console.error('Ошибка:',error);statusText.textContent='Ошибка: '+error.message+'. #'+(errorCount+1);errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}
const intervalId=setInterval(fetchMessages,3000);setTimeout(fetchMessages,500);
</script>
</body></html>"""


# --- Python Code Part 3 (остальная часть app.py) ---
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST'])
def receive_and_parse_logs_handler():
    global display_chat_messages, all_detected_chat_log_entries, raw_log_lines, \
           current_scoreboard_data, player_nickname_map, raw_scoreboard_json_inputs, \
           temp_json_lines_buffer, is_capturing_json_block

    log_lines = []
    if request.is_json:
        data = request.get_json()
        if isinstance(data, dict) and 'lines' in data and isinstance(data.get('lines'), list): log_lines = data.get('lines', [])
        elif isinstance(data, list): log_lines = data
        else:
            logger.warning("Получен JSON, но ключ 'lines' отсутствует, не список, или формат неизвестен.")
            raw_data_fallback = request.get_data(as_text=True)
            if raw_data_fallback: log_lines = raw_data_fallback.splitlines()
    else:
        raw_data = request.get_data(as_text=True)
        if raw_data: log_lines = raw_data.splitlines()

    if not log_lines: return jsonify({"status": "error", "message": "Строки не предоставлены"}), 400
    
    raw_log_lines.extend(log_lines)

    updated_nick_count = 0
    for line in log_lines:
        if not line: continue
        for match in PLAYER_INFO_REGEX.finditer(line):
            player_info = match.groupdict(); account_id = player_info.get('accountid'); nickname = player_info.get('nickname')
            if account_id and nickname and player_nickname_map.get(account_id) != nickname:
                player_nickname_map[account_id] = nickname; updated_nick_count += 1
    if updated_nick_count > 0: logger.info(f"Nickname map updated for {updated_nick_count} players.")

    new_display_chat_messages_count = 0
    newly_added_to_all_detected_chat = 0
    json_block_was_processed_in_this_call = False

    for line_content in log_lines:
        if not line_content.strip(): continue
        
        stripped_content_for_markers = strip_log_prefix(line_content)

        if not is_capturing_json_block and "JSON_BEGIN{" in stripped_content_for_markers:
            is_capturing_json_block = True; temp_json_lines_buffer = []
            try: actual_part = stripped_content_for_markers.split("JSON_BEGIN{", 1)[1]; temp_json_lines_buffer.append("{" + actual_part)
            except IndexError: logger.warning(f"Malformed JSON_BEGIN line: {line_content}"); is_capturing_json_block = False; continue
            if "}}JSON_END" in temp_json_lines_buffer[0]:
                end_pos = temp_json_lines_buffer[0].rfind("}}JSON_END"); temp_json_lines_buffer[0] = temp_json_lines_buffer[0][:end_pos + 2]
                is_capturing_json_block = False
            else: continue 
        elif is_capturing_json_block:
            temp_json_lines_buffer.append(stripped_content_for_markers)
            if "}}JSON_END" in stripped_content_for_markers:
                is_capturing_json_block = False; end_pos = temp_json_lines_buffer[-1].rfind("}}JSON_END")
                if end_pos != -1: temp_json_lines_buffer[-1] = temp_json_lines_buffer[-1][:end_pos + 2]
            else: continue
        
        if not is_capturing_json_block and temp_json_lines_buffer:
            if process_json_scoreboard_data(temp_json_lines_buffer): json_block_was_processed_in_this_call = True
            temp_json_lines_buffer = []; continue
        
        if not is_capturing_json_block:
            chat_match = CHAT_REGEX_SAY.search(line_content)
            if chat_match:
                extracted_data = chat_match.groupdict()
                chat_command = extracted_data['chat_command'].lower()
                sender_name_raw = extracted_data['player_name'].strip()
                message_text_raw = extracted_data['message'].strip()
                timestamp_str = extracted_data.get('timestamp', datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])
                player_team_raw = extracted_data['player_team']
                steamid_str = extracted_data['steamid']
                userid_str = extracted_data['userid']

                if not message_text_raw: continue

                raw_chat_entry = {
                    "timestamp": timestamp_str, "player_name": sender_name_raw,
                    "message": message_text_raw, "chat_command": chat_command,
                    "player_team_raw": player_team_raw, "steamid": steamid_str, "userid": userid_str,
                }
                all_detected_chat_log_entries.append(raw_chat_entry)
                newly_added_to_all_detected_chat +=1

                if chat_command == "say":
                    team_identifier = "Other"
                    if player_team_raw.upper() == "CT": team_identifier = "CT"
                    elif player_team_raw.upper() == "TERRORIST" or player_team_raw.upper() == "T": team_identifier = "T"
                    
                    message_obj_for_display = {
                        "ts": timestamp_str, "sender": html.escape(sender_name_raw),
                        "msg": html.escape(message_text_raw), "team": team_identifier
                    }
                    display_chat_messages.append(message_obj_for_display)
                    new_display_chat_messages_count += 1
    
    if new_display_chat_messages_count > 0: logger.info(f"Добавлено {new_display_chat_messages_count} 'say' сообщений для чата.")
    if newly_added_to_all_detected_chat > 0: logger.info(f"Обнаружено {newly_added_to_all_detected_chat} чат-подобных записей.")
    if json_block_was_processed_in_this_call: logger.info("Блок Scoreboard был обработан.")
        
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк."}), 200

# --- Эндпоинты ---
@app.route('/chat', methods=['GET'])
def get_structured_chat_data(): return jsonify(list(display_chat_messages))

@app.route('/raw_json', methods=['GET'])
def get_raw_log_lines(): return jsonify(list(raw_log_lines))

@app.route('/scoreboard_json', methods=['GET'])
def get_scoreboard_data(): return jsonify(current_scoreboard_data)

@app.route('/full_json', methods=['GET'])
def get_all_data_json():
    return jsonify({
        "raw_incoming_logs": list(raw_log_lines),
        "all_detected_chat_log_entries": list(all_detected_chat_log_entries),
        "processed_chat_for_display": list(display_chat_messages),
        "raw_scoreboard_json_inputs": list(raw_scoreboard_json_inputs),
        "processed_scoreboard_data": current_scoreboard_data,
        "player_nickname_map": player_nickname_map
    })

# --- HTML Page Routes ---
@app.route('/', methods=['GET'])
def index(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_MAIN, mimetype='text/html')
@app.route('/messages_only', methods=['GET'])
def messages_only_page(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_MSG_ONLY, mimetype='text/html')
@app.route('/raw_log_viewer', methods=['GET'])
def raw_log_viewer_page(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_LOG_ANALYZER, mimetype='text/html')
@app.route('/scoreboard_viewer', methods=['GET'])
def scoreboard_viewer_page(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_SCOREBOARD, mimetype='text/html')

# --- НОВЫЙ МАРШРУТ ДЛЯ СТРАНИЦЫ "ТОЛЬКО ЧАТ" ---
@app.route('/chat_only_nicknames', methods=['GET'])
def chat_only_nicknames_page():
    # NAV_HTML здесь не нужен, так как мы не хотим навигацию на этой странице
    return Response(BASE_CSS + CHAT_PAGE_SPECIFIC_CSS + HTML_TEMPLATE_CHAT_ONLY_NICKNAMES, mimetype='text/html')

# --- Run Application ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=True)

# --- END PYTHON CODE ---