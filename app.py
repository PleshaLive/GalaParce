# Файл: app.py (Проверка консистентности имен функций в scoreboard)
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
MAX_CHAT_MESSAGES = 100
MAX_RAW_LOGS = 300
chat_messages = deque(maxlen=MAX_CHAT_MESSAGES)
raw_log_lines = deque(maxlen=MAX_RAW_LOGS)
current_scoreboard_data = {"fields": [], "players": []}
# -------------------------

# --- Regex ---
CHAT_REGEX_SAY = re.compile(
    r"""^\s*(?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?(?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})\s+-\s+\"(?P<player_name_and_tags>.+?<\d+><\[U:\d:\d+\]><\w+>)\"\s+(?:say|say_team)\s+\"(?P<message>.*)\"\s*$""",
    re.VERBOSE | re.IGNORECASE
)
SCOREBOARD_FIELDS_REGEX = re.compile(
    r"""^\s*(?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?(?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})\s+-\s+\"fields\"\s*:\s*\"(?P<field_list>[^\"]*)\"\s*$""",
    re.VERBOSE | re.IGNORECASE
)
SCOREBOARD_PLAYER_REGEX = re.compile(
    r"""^\s*(?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?(?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})\s+-\s+\"player_\d+\"\s*:\s*\"(?P<player_data>[^\"]*)\"\s*$""",
    re.VERBOSE | re.IGNORECASE
)
# -------------------------------------------

# --- Общие CSS и HTML для Навигации ---
BASE_CSS = """<style>:root{--bg-color:#1a1d24;--container-bg:#232730;--container-border:#3b4048;--text-color:#cdd6f4;--text-muted:#a6adc8;--accent-color-1:#89b4fa;--accent-color-2:#a6e3a1;--link-color:var(--accent-color-2);--link-hover-bg:#3e4451;--error-color:#f38ba8;--header-color:var(--accent-color-1);--scrollbar-bg:#313244;--scrollbar-thumb:#585b70;--font-primary:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;--font-mono:'Consolas','Courier New',monospace;}*,*::before,*::after{box-sizing:border-box;}body{font-family:var(--font-primary);background-color:var(--bg-color);color:var(--text-color);margin:0;padding:20px;display:flex;flex-direction:column;min-height:100vh;font-size:16px;}h1{text-align:center;color:var(--header-color);margin:0 0 20px 0;font-weight:600;letter-spacing:1px;}::-webkit-scrollbar{width:8px;}::-webkit-scrollbar-track{background:var(--scrollbar-bg);border-radius:4px;}::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);border-radius:4px;}::-webkit-scrollbar-thumb:hover{background:#6E738D;}.navigation{display:flex;justify-content:center;align-items:center;padding:10px;margin-bottom:25px;background-color:var(--container-bg);border-radius:8px;border:1px solid var(--container-border);box-shadow:0 2px 8px rgba(0,0,0,0.3);}.navigation a{color:var(--link-color);text-decoration:none;margin:0 10px;padding:8px 15px;border-radius:6px;transition:background-color 0.2s ease,color 0.2s ease;font-weight:500;}.navigation a:hover,.navigation a:focus{background-color:var(--link-hover-bg);color:var(--text-color);outline:none;}.nav-separator{color:var(--text-muted);opacity:0.5;}.content-wrapper{background-color:var(--container-bg);border:1px solid var(--container-border);border-radius:8px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.3);flex-grow:1;display:flex;flex-direction:column;min-height:300px;}.status-bar{text-align:center;font-size:0.9em;color:var(--text-muted);padding:15px 0 5px 0;height:20px;}.status-bar .loader{border:3px solid var(--container-border);border-radius:50%;border-top:3px solid var(--accent-color-1);width:14px;height:14px;animation:spin 1s linear infinite;display:inline-block;margin-left:8px;vertical-align:middle;}@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}</style>"""
NAV_HTML = """<nav class="navigation"><a href="/">Полный чат</a><span class="nav-separator">|</span><a href="/messages_only">Только сообщения</a><span class="nav-separator">|</span><a href="/raw_log_viewer">Анализатор Логов</a><span class="nav-separator">|</span><a href="/scoreboard_viewer">Таблица счета</a></nav>"""
# ----------------------------------

# --- HTML Шаблон для ГЛАВНОЙ страницы (/) ---
HTML_TEMPLATE_MAIN = """
<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CS2 Chat Viewer</title><style>#chat-container{flex-grow:1;overflow-y:auto;padding-right:10px;display:flex;flex-direction:column;}#chat-container-inner{margin-top:auto;padding-top:10px;}.message{margin-bottom:12px;padding:10px 15px;border-radius:8px;background-color:#2a2e37;border:1px solid #414550;word-wrap:break-word;line-height:1.5;max-width:85%;align-self:flex-start;}.message .timestamp{font-size:0.8em;color:var(--text-muted);margin-right:8px;opacity:0.7;}.message .sender{font-weight:600;color:var(--accent-color-1);margin-right:5px;}.message .text{}.loading-placeholder{align-self:center;color:var(--text-muted);margin-top:20px;}</style></head><body><div class="content-wrapper"><h1>CS2 Chat Viewer (Полный)</h1><div id="chat-container"><div id="chat-container-inner"><div class="message loading-placeholder">Загрузка сообщений...</div></div></div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display: none;" class="loader"></span></div><script>const chatContainerInner=document.getElementById('chat-container-inner');const chatContainer=document.getElementById('chat-container');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;async function fetchMessages(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error(`Ошибка сети: ${response.status}`);const messages=await response.json();const isScrolledToBottom=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;chatContainerInner.innerHTML='';if(messages.length===0){chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>'}else{messages.forEach(data=>{const messageElement=document.createElement('div');messageElement.className='message';const timeSpan=document.createElement('span');timeSpan.className='timestamp';timeSpan.textContent=`[${data.ts}]`;const senderSpan=document.createElement('span');senderSpan.className='sender';senderSpan.textContent=data.sender+':';const textSpan=document.createElement('span');textSpan.className='text';textSpan.textContent=data.msg;messageElement.appendChild(timeSpan);messageElement.appendChild(senderSpan);messageElement.appendChild(textSpan);chatContainerInner.appendChild(messageElement)})}if(isScrolledToBottom){setTimeout(()=>{chatContainer.scrollTop=chatContainer.scrollHeight},0)}statusText.textContent=`Обновлено: ${new Date().toLocaleTimeString()}`;errorCount=0}catch(error){console.error('Ошибка:',error);statusText.textContent=`Ошибка: ${error.message}. #${errorCount+1}`;errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchMessages,3000);setTimeout(fetchMessages,500);</script></body></html>
"""
# ----------------------------------

# --- HTML Шаблон для страницы ТОЛЬКО с ТЕКСТОМ сообщений (/messages_only) ---
HTML_TEMPLATE_MSG_ONLY = """
<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Chat (Только сообщения)</title><style>#messages-list{font-family:var(--font-primary);font-size:1.05em;line-height:1.7;padding:15px;}#messages-list div{margin-bottom:8px;padding-left:10px;border-left:3px solid var(--accent-color-1);}.content-wrapper h1{margin-bottom:20px;}</style></head><body><div class="content-wrapper"><h1>Только сообщения</h1><div id="messages-list">Загрузка...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const container=document.getElementById('messages-list');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;async function fetchMsgOnly(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/chat');if(!response.ok)throw new Error('Network error');const messages=await response.json();const parentScrollTop=container.scrollTop;container.innerHTML='';if(messages.length===0){container.textContent='Нет сообщений.'}else{messages.forEach(data=>{const div=document.createElement('div');div.textContent=data.msg;container.appendChild(div)});window.scrollTo(0,document.body.scrollHeight)}statusText.textContent=`Обновлено: ${new Date().toLocaleTimeString()}`;errorCount=0}catch(error){container.textContent='Ошибка загрузки.';console.error(error);statusText.textContent=`Ошибка: ${error.message}. #${errorCount+1}`;errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchMsgOnly,3000);fetchMsgOnly();</script></body></html>
"""
# ----------------------------------

# --- HTML Шаблон для страницы АНАЛИЗАТОРА ЛОГОВ (/raw_log_viewer) ---
HTML_TEMPLATE_LOG_ANALYZER = """
<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>CS2 Log Analyzer</title><style>.content-wrapper h1{margin-bottom:20px;}#log-analyzer-output{font-family:var(--font-mono);font-size:13px;line-height:1.6;flex-grow:1;overflow-y:auto;padding:10px;background-color:#181a1f;border-radius:6px;}.log-line{margin-bottom:3px;padding:2px 5px;border-radius:3px;white-space:pre-wrap;word-break:break-all;cursor:default;}.log-line.chat{background-color:#36485e;color:#a6e3a1;border-left:3px solid #a6e3a1;}.log-line.kill{background-color:#5c374f;color:#f38ba8;border-left:3px solid #f38ba8;}.log-line.damage{background-color:#6e584c;color:#fab387;}.log-line.grenade{background-color:#3e4b6e;color:#cba6f7;}.log-line.purchase{background-color:#2e535e;color:#89dceb;}.log-line.pickup{background-color:#3e5a6e;color:#94e2d5;}.log-line.connect{color:#a6e3a1;}.log-line.disconnect{color:#f38ba8;}.log-line.system{color:var(--text-muted);font-style:italic;}.log-line.unknown{color:var(--text-muted);opacity:0.8;}</style></head><body><div class="content-wrapper"><h1>Анализатор Логов CS2</h1><div id="log-analyzer-output">Загрузка логов...</div></div><div class="status-bar"><span id="status-text">Ожидание данных...</span><span id="loading-indicator" style="display:none;" class="loader"></span></div><script>const outputContainer=document.getElementById('log-analyzer-output');const statusText=document.getElementById('status-text');const loadingIndicator=document.getElementById('loading-indicator');let isFetching=!1,errorCount=0;const MAX_ERRORS=5;const chatRegex=/(\\".+?\\"<\\d+><\\[U:\\d:\\d+\\]><\\w+>)\\s+(?:say|say_team)\\s+\\"([^\\"]*)\\"/i;const killRegex=/killed\\s+\\".+?\\"<\\d+>/i;const damageRegex=/attacked\\s+\\".+?\\"<\\d+><.+?>.*\\(damage\\s+\\"\\d+\\"\\)/i;const grenadeRegex=/threw\\s+(hegrenade|flashbang|smokegrenade|molotov|decoy)/i;const connectRegex=/connected|entered the game/i;const disconnectRegex=/disconnected|left the game/i;const purchaseRegex=/purchased\\s+\\"(\\w+)\\"/i;const pickupRegex=/picked up\\s+\\"(\\w+)\\"/i;const teamSwitchRegex=/switched team to/i;const nameChangeRegex=/changed name to/i;function getLogLineInfo(line){if(chatRegex.test(line))return{type:'Чат',class:'chat'};if(killRegex.test(line))return{type:'Убийство',class:'kill'};if(damageRegex.test(line))return{type:'Урон',class:'damage'};if(grenadeRegex.test(line))return{type:'Граната',class:'grenade'};if(purchaseRegex.test(line))return{type:'Покупка',class:'purchase'};if(pickupRegex.test(line))return{type:'Подбор',class:'pickup'};if(connectRegex.test(line))return{type:'Подключение',class:'connect'};if(disconnectRegex.test(line))return{type:'Отключение',class:'disconnect'};if(teamSwitchRegex.test(line))return{type:'Смена команды',class:'system'};if(nameChangeRegex.test(line))return{type:'Смена ника',class:'system'};return{type:'Неизвестно/Система',class:'unknown'}}async function fetchAndAnalyzeLogs(){if(isFetching||errorCount>=MAX_ERRORS)return;isFetching=!0;loadingIndicator.style.display='inline-block';try{const response=await fetch('/raw_json');if(!response.ok)throw new Error(`Ошибка сети: ${response.status}`);const logLines=await response.json();const isScrolledToBottom=outputContainer.scrollTop+outputContainer.clientHeight>=outputContainer.scrollHeight-50;outputContainer.innerHTML='';if(logLines.length===0){outputContainer.textContent='Нет данных лога для анализа.'}else{logLines.forEach(line=>{const info=getLogLineInfo(line);const lineDiv=document.createElement('div');lineDiv.className=`log-line ${info.class}`;lineDiv.textContent=line;lineDiv.title=`Тип: ${info.type}`;outputContainer.appendChild(lineDiv)})}if(isScrolledToBottom){setTimeout(()=>{outputContainer.scrollTop=outputContainer.scrollHeight},0)}statusText.textContent=`Обновлено: ${new Date().toLocaleTimeString()} (${logLines.length} строк)`;errorCount=0}catch(error){outputContainer.textContent='Ошибка загрузки или анализа логов.';console.error(error);statusText.textContent=`Ошибка: ${error.message}. #${errorCount+1}`;errorCount++;if(errorCount>=MAX_ERRORS){statusText.textContent+=' Автообновление остановлено.';clearInterval(intervalId)}}finally{isFetching=!1;loadingIndicator.style.display='none'}}const intervalId=setInterval(fetchAndAnalyzeLogs,5000);fetchAndAnalyzeLogs();</script></body></html>
"""
# ----------------------------------

# --- HTML Шаблон для страницы ТАБЛИЦЫ СЧЕТА (/scoreboard_viewer) ---
HTML_TEMPLATE_SCOREBOARD = """
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>CS2 Scoreboard</title>
    <style>
        .content-wrapper h1 { margin-bottom: 20px; }
        .scoreboard-teams-container { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .team-table-wrapper { flex: 1; min-width: 45%; }
        .team-table-wrapper h2 { text-align: center; color: var(--text-muted); font-size: 1.2em; margin-bottom: 10px; }
        table.scoreboard { width: 100%; border-collapse: collapse; font-size: 0.85em; font-family: var(--font-mono); }
        .scoreboard th, .scoreboard td { border: 1px solid var(--container-border); padding: 6px 8px; text-align: left; white-space: nowrap; }
        .scoreboard thead th { background-color: #2c313a; color: var(--accent-color-1); position: sticky; top: 0; z-index: 1; }
        .team-ct tbody tr { background-color: rgba(137, 180, 250, 0.1); }
        .team-t tbody tr { background-color: rgba(250, 173, 137, 0.1); }
        .team-ct thead th { background-color: #3a5a8a; }
        .team-t thead th { background-color: #8a5a3a; }
        .scoreboard tbody tr:hover { background-color: var(--link-hover-bg); }
        .no-data { text-align: center; padding: 20px; color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="content-wrapper">
        <h1>Таблица счета (Scoreboard)</h1>
        <div class="scoreboard-teams-container" id="scoreboard-teams-container">
        </div>
        <div id="scoreboard-placeholder" class="no-data">Загрузка данных таблицы счета...</div>
    </div>
    <div class="status-bar">
        <span id="status-text">Ожидание данных...</span>
        <span id="loading-indicator" style="display: none;" class="loader"></span>
    </div>
    <script>
        const teamsContainer = document.getElementById('scoreboard-teams-container');
        const placeholder = document.getElementById('scoreboard-placeholder');
        const statusText = document.getElementById('status-text');
        const loadingIndicator = document.getElementById('loading-indicator');
        let isFetching = false, errorCount = 0; const MAX_ERRORS = 5;

        function createTeamTable(teamId, teamName, teamPlayers, fields, teamClass) {
            const wrapper = document.createElement('div'); wrapper.className = 'team-table-wrapper';
            const title = document.createElement('h2'); title.textContent = teamName; wrapper.appendChild(title);
            const table = document.createElement('table'); table.className = `scoreboard ${teamClass}`;
            const tableHead = table.createTHead(); const tableBody = table.createTBody();
            const headerRow = tableHead.insertRow();
            fields.forEach(field => { const th = document.createElement('th'); th.textContent = field.trim(); headerRow.appendChild(th); });
            teamPlayers.slice(0, 5).forEach(player => { // Отображаем до 5 игроков
                const row = tableBody.insertRow();
                fields.forEach(fieldKey => {
                    const cell = row.insertCell();
                    cell.textContent = player[fieldKey.trim()] !== undefined ? player[fieldKey.trim()] : '-';
                });
            });
            wrapper.appendChild(table); return wrapper;
        }

        function buildTable(data) { // ИМЯ ФУНКЦИИ buildTable
            teamsContainer.innerHTML = '';
            if (!data || !data.fields || data.fields.length === 0) {
                placeholder.textContent = 'Нет данных для отображения.'; teamsContainer.style.display = 'none'; return;
            }
            teamsContainer.style.display = 'flex'; placeholder.textContent = '';
            
            // Убедитесь, что эти ID команд соответствуют данным, приходящим в поле 'team'
            const teamTerroristId = '2'; // Пример ID для Террористов
            const teamCTId = '3';       // Пример ID для Контр-Террористов
            // Имена для отображения
            const teamTerroristName = 'Террористы';
            const teamCTName = 'Контр-Террористы';

            let playersT = [], playersCT = [], otherPlayers = [];
            if (data.players && data.players.length > 0) {
                data.players.forEach(player => {
                    const teamFieldValue = player['team'] ? player['team'].trim() : null;
                    if (teamFieldValue === teamTerroristId) playersT.push(player);
                    else if (teamFieldValue === teamCTId) playersCT.push(player);
                    else otherPlayers.push(player);
                });
            }
            
            if (playersT.length > 0 || playersCT.length > 0 ) { // Показываем, если есть хотя бы одна команда
                 if (playersT.length > 0) {
                    teamsContainer.appendChild(createTeamTable(teamTerroristId, teamTerroristName, playersT, data.fields, 'team-t'));
                 }
                 if (playersCT.length > 0) {
                    teamsContainer.appendChild(createTeamTable(teamCTId, teamCTName, playersCT, data.fields, 'team-ct'));
                 }
                 // Вы можете решить, как отображать otherPlayers, если это необходимо
                 if (otherPlayers.length > 0 && (playersT.length === 0 && playersCT.length === 0)) { // Если только "другие" игроки
                    teamsContainer.appendChild(createTeamTable('other', 'Другие/Нераспределенные', otherPlayers, data.fields, 'team-other'));
                 } else if (otherPlayers.length > 0) {
                    app.logger.info("Есть нераспределенные игроки, но они не отображаются отдельной таблицей, т.к. есть основные команды.");
                 }

            } else if (otherPlayers.length > 0) { // Если нет основных команд, но есть "другие"
                 teamsContainer.appendChild(createTeamTable('other', 'Игроки (команда не определена)', otherPlayers, data.fields, 'team-other'));
            }
            else { placeholder.textContent = 'Нет данных об игроках в командах.'; }
        }

        async function fetchScoreboardData() {
            if (isFetching || errorCount >= MAX_ERRORS) return;
            isFetching = true; loadingIndicator.style.display = 'inline-block';
            try {
                const response = await fetch('/scoreboard_json');
                if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
                const scoreboardData = await response.json();
                buildTable(scoreboardData); // ВЫЗОВ buildTable
                statusText.textContent = `Обновлено: ${new Date().toLocaleTimeString()}`; errorCount = 0;
            } catch (error) {
                placeholder.textContent = 'Ошибка загрузки данных таблицы.'; console.error(error);
                statusText.textContent = `Ошибка: ${error.message}. #${errorCount+1}`; errorCount++;
                if (errorCount >= MAX_ERRORS) { statusText.textContent += ' Автообновление остановлено.'; clearInterval(intervalId); }
            } finally {
                isFetching = false; loadingIndicator.style.display = 'none';
            }
        }
        const intervalId = setInterval(fetchScoreboardData, 7000);
        fetchScoreboardData();
    </script>
</body>
</html>
"""

# --- Эндпоинты Flask ---
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST'])
def receive_and_parse_logs_handler():
    global chat_messages, raw_log_lines, current_scoreboard_data
    log_lines = []
    if request.is_json:
        data = request.get_json(); log_lines = data.get('lines', []) if isinstance(data.get('lines'), list) else []
    else:
        raw_data = request.get_data(as_text=True); log_lines = raw_data.splitlines() if raw_data else []

    if not log_lines: return jsonify({"status": "error", "message": "No lines provided"}), 400
    app.logger.info(f"Log Parser: Получено {len(log_lines)} строк лога.")

    if log_lines: raw_log_lines.extend(log_lines)

    new_chat_messages_count = 0; parsed_chat_batch = []
    new_scoreboard_data_parsed = False; temp_scoreboard_players = []
    current_parsing_time = datetime.datetime.now(datetime.timezone.utc)

    for line in log_lines:
        if not line: continue
        chat_match = CHAT_REGEX_SAY.search(line)
        if chat_match:
            extracted_data = chat_match.groupdict()
            player_name_and_tags_str = extracted_data['player_name_and_tags']
            name_match = re.search(r'^([^\<]+)', player_name_and_tags_str)
            sender = html.escape(name_match.group(1).strip()) if name_match else html.escape(player_name_and_tags_str.strip())
            message = html.escape(extracted_data['message'].strip())
            timestamp = extracted_data.get('timestamp')
            if not message: continue
            message_obj = {"ts": timestamp, "sender": sender, "msg": message}
            parsed_chat_batch.append(message_obj); new_chat_messages_count += 1
            app.logger.info(f"Log Parser: Распознано ЧАТ сообщение: [{timestamp}] {sender}: {message}")
            continue
        fields_match = SCOREBOARD_FIELDS_REGEX.search(line)
        if fields_match:
            field_list_str = fields_match.group('field_list')
            current_scoreboard_data['fields'] = [f.strip() for f in field_list_str.split(',') if f.strip()]
            current_scoreboard_data['players'] = []; temp_scoreboard_players = []
            new_scoreboard_data_parsed = True
            app.logger.info(f"Scoreboard: Обновлены поля: {current_scoreboard_data['fields']}")
            continue
        player_match = SCOREBOARD_PLAYER_REGEX.search(line)
        if player_match and current_scoreboard_data['fields']:
            player_data_str = player_match.group('player_data')
            player_values = [v.strip() for v in player_data_str.split(',')]
            if len(player_values) == len(current_scoreboard_data['fields']):
                player_dict = dict(zip(current_scoreboard_data['fields'], player_values))
                temp_scoreboard_players.append(player_dict); new_scoreboard_data_parsed = True
            else: app.logger.warning(f"Scoreboard: Несовпадение кол-ва значений и полей. Строка: {line}")
            continue
    if parsed_chat_batch:
         chat_messages.extend(parsed_chat_batch)
    if temp_scoreboard_players:
        current_scoreboard_data['players'].extend(temp_scoreboard_players)
        app.logger.info(f"Scoreboard: Добавлено/обновлено {len(temp_scoreboard_players)} игроков.")
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк, {new_chat_messages_count} чат, scoreboard parsed: {new_scoreboard_data_parsed}"}), 200

@app.route('/chat', methods=['GET'])
def get_structured_chat_data(): return jsonify(list(chat_messages))

@app.route('/raw_json', methods=['GET'])
def get_raw_log_lines(): return jsonify(list(raw_log_lines))

@app.route('/scoreboard_json', methods=['GET'])
def get_scoreboard_data(): return jsonify(current_scoreboard_data)

@app.route('/', methods=['GET'])
def index(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_MAIN, mimetype='text/html')

@app.route('/messages_only', methods=['GET'])
def messages_only_page(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_MSG_ONLY, mimetype='text/html')

@app.route('/raw_log_viewer', methods=['GET'])
def raw_log_viewer_page(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_LOG_ANALYZER, mimetype='text/html')

@app.route('/scoreboard_viewer', methods=['GET'])
def scoreboard_viewer_page(): return Response(BASE_CSS + NAV_HTML + HTML_TEMPLATE_SCOREBOARD, mimetype='text/html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)