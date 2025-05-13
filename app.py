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
MAX_CHAT_MESSAGES_DISPLAY = 100 # Максимум сообщений в чате для отображения
display_chat_messages = deque(maxlen=MAX_CHAT_MESSAGES_DISPLAY)
# -----------------------

# --- Regex Definition for Chat ---
CHAT_REGEX_SAY = re.compile(
    r"""
    ^\s* # Start of line, optional whitespace
    (?:\d{2}\/\d{2}\/\d{4}\s+-\s+)?          # Optional Date (DD/MM/YYYY - )
    (?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})      # Timestamp (HH:MM:SS.ms)
    \s+-\s+                                      # Separator " - "
    \"(?P<player_name>.+?)<(?P<userid>\d+)><(?P<steamid>\[U:\d:\d+\])><(?P<player_team>\w+)>\" # Player name, userid, steamid, team
    \s+                                          # Space
    (?P<chat_command>say|say_team)               # Chat command: say or say_team (мы будем использовать только 'say')
    \s+                                          # Space
    \"(?P<message>.*)\"                          # Message content within quotes
    \s*$                                         # Optional whitespace, end of line
    """,
    re.VERBOSE | re.IGNORECASE
)
# ----------------------------------------------

# --- HTML and CSS for the Single Chat Page ---
MINIMAL_CHAT_HTML_WITH_CSS = """<!DOCTYPE html><html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS2 Chat</title>
<style>
:root{
    --bg-color:#121212;
    --surface-color:#1E1E1E;
    --primary-text-color:#E0E0E0;
    --secondary-text-color:#A0A0A0;
    --border-color:#333333;
    --accent-color-1:#0DCAF0; /* CT */
    --accent-color-2:#FFC107; /* T */
    --font-primary:'Roboto', 'Segoe UI', Helvetica, Arial, sans-serif;
    --chat-team-ct-color: var(--accent-color-1); 
    --chat-team-t-color: var(--accent-color-2);  
    --chat-sender-default-color: #B0BEC5;
    --player-entry-bg: #282828; /* Background for messages */
}
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
    height: 100vh; 
    margin: 0; 
    overflow: hidden; /* Prevent body scroll, manage scroll in #chat-container */
}
::-webkit-scrollbar{width:8px;}
::-webkit-scrollbar-track{background:var(--surface-color); border-radius:4px;} 
::-webkit-scrollbar-thumb{background:var(--border-color);border-radius:4px;} 
::-webkit-scrollbar-thumb:hover{background:#555;}

.content-wrapper { 
    padding: 10px; 
    margin: 0; 
    flex-grow: 1; 
    display: flex; 
    flex-direction: column;
    overflow: hidden; /* Child #chat-container will manage its own scroll */
}
#chat-container {
    background-color: var(--surface-color); 
    border: 1px solid var(--border-color);   
    border-radius: 8px;
    flex-grow:1;
    overflow-y:auto;
    padding-right:5px;
    display:flex;
    flex-direction:column;
}
#chat-container-inner{
    margin-top:auto; 
    padding-top:10px;
    padding-left:10px; 
    padding-right:5px;
}
.message{
    margin-bottom:8px;
    padding:8px 12px;
    border-radius:6px;
    background-color:var(--player-entry-bg);
    border:1px solid var(--border-color);
    word-wrap:break-word;
    line-height:1.5;
    max-width:98%;
    align-self:flex-start; 
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
    color: var(--chat-sender-default-color);
}
.message .sender.team-ct {color: var(--chat-team-ct-color);}
.message .sender.team-t {color: var(--chat-team-t-color);}
.message .text{color: var(--primary-text-color); display: inline;}

.loading-placeholder{
    align-self:center;
    color:var(--secondary-text-color);
    margin: 20px auto;
    font-size: 0.9em;
}
.status-bar { 
    flex-shrink: 0; 
    height: 40px; 
    padding: 8px 0; 
    background-color: var(--surface-color); 
    border-top: 1px solid var(--border-color); 
    text-align:center;
    font-size:0.85em;
    color:var(--secondary-text-color);
}
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
const chatContainerInner=document.getElementById('chat-container-inner');
const chatContainer=document.getElementById('chat-container');
const statusText=document.getElementById('status-text');
const loadingIndicator=document.getElementById('loading-indicator');
let isFetching=!1,errorCount=0;const MAX_ERRORS=5;

async function fetchMessages(){
    if(isFetching||errorCount>=MAX_ERRORS)return;
    isFetching=!0;
    loadingIndicator.style.display='inline-block';
    try{
        const response=await fetch('/chat');
        if(!response.ok)throw new Error('Ошибка сети: '+response.status);
        const messages=await response.json();
        const isScrolledToBottom=chatContainer.scrollTop+chatContainer.clientHeight>=chatContainer.scrollHeight-30;
        
        chatContainerInner.innerHTML='';
        
        if(messages.length===0){
            chatContainerInner.innerHTML='<div class="message loading-placeholder">Сообщений пока нет.</div>';
        }else{
            messages.forEach(data=>{
                const messageElement=document.createElement('div');
                messageElement.className='message';
                
                const timeSpan=document.createElement('span');
                timeSpan.className='timestamp';
                timeSpan.textContent=\`[\${data.ts}]\`;
                
                const senderSpan=document.createElement('span');
                senderSpan.className='sender';
                senderSpan.textContent=data.sender+': ';
                
                if(data.team==='CT'){senderSpan.classList.add('team-ct');}
                else if(data.team==='T'){senderSpan.classList.add('team-t');}
                
                const textSpan=document.createElement('span');
                textSpan.className='text';
                textSpan.textContent=data.msg;
                
                messageElement.appendChild(timeSpan);
                messageElement.appendChild(senderSpan);
                messageElement.appendChild(textSpan);
                chatContainerInner.appendChild(messageElement);
            });
        }
        if(isScrolledToBottom){
            setTimeout(()=>{chatContainer.scrollTop=chatContainer.scrollHeight},0);
        }
        statusText.textContent='Обновлено: '+new Date().toLocaleTimeString();
        errorCount=0;
    }catch(error){
        console.error('Ошибка:',error);
        statusText.textContent='Ошибка: '+error.message+'. Попытка #'+(errorCount+1);
        errorCount++;
        if(errorCount>=MAX_ERRORS){
            statusText.textContent+=' Автообновление остановлено из-за ошибок.';
            clearInterval(intervalId);
        }
    }finally{
        isFetching=!1;
        loadingIndicator.style.display='none';
    }
}
const intervalId=setInterval(fetchMessages,3000);
setTimeout(fetchMessages,100);
</script>
</body></html>"""
# ----------------------------------------------

# --- Log Submission Handler ---
@app.route('/submit_logs', methods=['POST'])
@app.route('/gsi', methods=['POST']) # Keep /gsi if it's a known endpoint for your log source
def receive_and_parse_logs_handler():
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
            if raw_data_fallback:
                log_lines = raw_data_fallback.splitlines()
    else:
        raw_data = request.get_data(as_text=True)
        if raw_data:
            log_lines = raw_data.splitlines()

    if not log_lines:
        return jsonify({"status": "error", "message": "Строки не предоставлены"}), 400
    
    new_display_chat_messages_count = 0

    for line_content in log_lines:
        if not line_content.strip():
            continue
            
        chat_match = CHAT_REGEX_SAY.search(line_content)
        if chat_match:
            extracted_data = chat_match.groupdict()
            chat_command = extracted_data['chat_command'].lower()
            
            # Process only "say" command for general chat display
            if chat_command == "say":
                sender_name_raw = extracted_data['player_name'].strip()
                message_text_raw = extracted_data['message'].strip()
                timestamp_str = extracted_data.get('timestamp', datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])
                player_team_raw = extracted_data['player_team']

                if not message_text_raw: # Skip empty messages
                    continue

                team_identifier = "Other" # Default
                if player_team_raw.upper() == "CT":
                    team_identifier = "CT"
                elif player_team_raw.upper() == "TERRORIST" or player_team_raw.upper() == "T":
                    team_identifier = "T"
                
                message_obj_for_display = {
                    "ts": timestamp_str,
                    "sender": html.escape(sender_name_raw),
                    "msg": html.escape(message_text_raw),
                    "team": team_identifier # For JS to style sender by team
                }
                display_chat_messages.append(message_obj_for_display)
                new_display_chat_messages_count += 1
    
    if new_display_chat_messages_count > 0:
        logger.info(f"Добавлено {new_display_chat_messages_count} 'say' сообщений для чата.")
        
    return jsonify({"status": "success", "message": f"Обработано {len(log_lines)} строк."}), 200
# -----------------------------

# --- API Endpoint for Chat Data ---
@app.route('/chat', methods=['GET'])
def get_structured_chat_data():
    return jsonify(list(display_chat_messages))
# -----------------------------

# --- Main HTML Page Route ---
@app.route('/', methods=['GET'])
def index():
    return Response(MINIMAL_CHAT_HTML_WITH_CSS, mimetype='text/html')
# -----------------------------

# --- Run Application ---
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    # Set debug=False for production if desired
    app.run(host='0.0.0.0', port=port, debug=True) 
# -----------------------------