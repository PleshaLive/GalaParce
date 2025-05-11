// public/js/observer.js
const socket = io();
const spectatorVideoEl = document.getElementById('spectatorVideo');
const gsiSpectatingNicknameEl = document.getElementById('gsiSpectatingNickname');
const gsiSpectatingSteamIDEl = document.getElementById('gsiSpectatingSteamID');
const pinnedPlayerInfoEl = document.getElementById('pinnedPlayerInfo');
const pinnedNicknameEl = document.getElementById('pinnedNickname');
const unpinBtn = document.getElementById('unpinBtn');
const playerWebcamsContainer = document.getElementById('playerWebcamsContainer');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// Структура activePlayers[nickname]:
// { webcamId, steamID, showWebcam, 
//   videoElement (для превью), peerConnection, stream (MediaStream) }
let activePlayers = {}; 
let currentGsiSpectatedWebcamId = null; 
let currentDisplayedWebcamIdInMainVideo = null;  // Чей webcamId сейчас в #spectatorVideo
let pinnedPlayerWebcamId = null;      

const observerSessionId = 'obs-' + Math.random().toString(36).substring(2, 9);

console.log('ObserverJS: Initialized. My session ID:', observerSessionId);
if (!spectatorVideoEl) console.error("ObserverJS: CRITICAL - Main video element 'spectatorVideo' not found!");

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- Функции управления UI и состоянием (fullscreen, pin/unpin) ---
// (Эти функции остаются такими же, как в ответе #43)
fullscreenBtn.onclick = () => { /* ... как в #43 ... */ if (!document.fullscreenElement) { spectatorVideoEl.requestFullscreen().catch(err => { console.error(`ObserverJS: Error fullscreen: ${err.message} (${err.name})`); }); } else { if (document.exitFullscreen) document.exitFullscreen(); } };
document.addEventListener('fullscreenchange', () => { /* ... как в #43 ... */ if (document.fullscreenElement === spectatorVideoEl) { fullscreenBtn.textContent = 'Выйти из полноэкранного'; } else { fullscreenBtn.textContent = 'На весь экран'; if (pinnedPlayerWebcamId) unpinPlayer(); } });
function pinPlayer(webcamId, nickname) { /* ... как в #43 ... */ if (!activePlayers[nickname] || activePlayers[nickname].webcamId !== webcamId) {return;} pinnedPlayerWebcamId = webcamId; pinnedNicknameEl.textContent = nickname; pinnedPlayerInfoEl.style.display = 'block'; unpinBtn.style.display = 'inline-block'; console.log(`ObserverJS: Player ${nickname} PINNED.`); if (currentDisplayedWebcamIdInMainVideo !== webcamId && spectatorVideoEl) { if (activePlayers[nickname] && activePlayers[nickname].stream && activePlayers[nickname].showWebcam) { console.log(`ObserverJS: Pinning - switching main video to ${nickname}'s existing stream.`); spectatorVideoEl.srcObject = activePlayers[nickname].stream; currentDisplayedWebcamIdInMainVideo = webcamId; } else { console.log(`ObserverJS: Pinning - stream for ${nickname} not ready or not to be shown, (re)connecting.`); connectAndStorePlayerStream(activePlayers[nickname]); currentDisplayedWebcamIdInMainVideo = webcamId; /* connectAndStorePlayerStream вызовет setMainVideo */ } } }
function unpinPlayer() { /* ... как в #43 ... */ console.log(`ObserverJS: Player UNPINNED.`); pinnedPlayerWebcamId = null; pinnedPlayerInfoEl.style.display = 'none'; unpinBtn.style.display = 'none'; if (currentGsiSpectatedWebcamId && spectatorVideoEl) { const gsiTarget = Object.values(activePlayers).find(p => p.webcamId === currentGsiSpectatedWebcamId); if (gsiTarget) { console.log(`ObserverJS: Unpinned, switching to GSI target: ${gsiTarget.nickname}`); setMainVideo(gsiTarget); } } else if (spectatorVideoEl) { spectatorVideoEl.srcObject = null; currentDisplayedWebcamIdInMainVideo = null; } }
unpinBtn.onclick = unpinPlayer;

// Функция для установки основного видеопотока
function setMainVideo(playerObject) {
    if (!spectatorVideoEl) return;
    if (playerObject && playerObject.stream && playerObject.showWebcam) {
        console.log(`ObserverJS: Setting main video to ${playerObject.nickname}'s stream.`);
        spectatorVideoEl.srcObject = playerObject.stream;
        currentDisplayedWebcamIdInMainVideo = playerObject.webcamId;
        // Обновляем информацию о просматриваемом игроке, если он не закреплен или закреплен этот же
        if (!pinnedPlayerWebcamId || pinnedPlayerWebcamId === playerObject.webcamId) {
             gsiSpectatingNicknameEl.textContent = playerObject.nickname;
             gsiSpectatingSteamIDEl.textContent = playerObject.steamID || 'N/A';
        }
    } else if (playerObject && !playerObject.showWebcam && playerObject.webcamId) {
        console.log(`ObserverJS: Main video target ${playerObject.nickname} has showWebcam=false. Clearing main video.`);
        spectatorVideoEl.srcObject = null; 
        currentDisplayedWebcamIdInMainVideo = playerObject.webcamId; // Запоминаем, что цель была, но не показываем
        // Тут можно показать плейсхолдер "камера отключена администратором"
        if (!pinnedPlayerWebcamId || pinnedPlayerWebcamId === playerObject.webcamId) {
            gsiSpectatingNicknameEl.textContent = `${playerObject.nickname} (камера скрыта)`;
            gsiSpectatingSteamIDEl.textContent = playerObject.steamID || 'N/A';
        }
    } else {
        console.log("ObserverJS: No valid player object or stream to set for main video. Clearing.");
        spectatorVideoEl.srcObject = null;
        currentDisplayedWebcamIdInMainVideo = null;
         if (!pinnedPlayerWebcamId) { // Очищаем инфо только если никто не закреплен
            gsiSpectatingNicknameEl.textContent = 'N/A';
            gsiSpectatingSteamIDEl.textContent = 'N/A';
        }
    }
}


// --- Обновление списка игроков и их превью ---
function updatePlayerListAndWebcams() {
    Object.values(activePlayers).forEach(player => {
        if (!player.webcamId) return; 
        let itemId = `player-cam-item-${player.webcamId}`; let videoId = `video-${player.webcamId}`;
        let itemEl = document.getElementById(itemId);
        if (!itemEl) {
            itemEl = document.createElement('div'); itemEl.id = itemId; itemEl.className = 'player-camera-item';
            const h3 = document.createElement('h3'); h3.textContent = player.nickname; 
            if (player.isRegistered) h3.classList.add('registered-player-h3'); // Используем isRegistered от сервера
            itemEl.appendChild(h3);
            const videoEl = document.createElement('video'); videoEl.id = videoId; videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true; itemEl.appendChild(videoEl);
            player.videoElement = videoEl; // Ссылка на элемент превью
            const controls = document.createElement('div');
            const watchBtn = document.createElement('button'); watchBtn.textContent = `Смотреть`;
            watchBtn.onclick = () => { unpinPlayer(); setMainVideo(player); };
            controls.appendChild(watchBtn);
            const pinFSBtn = document.createElement('button'); pinFSBtn.textContent = `📌 На весь экран`;
            pinFSBtn.onclick = () => { pinPlayer(player.webcamId, player.nickname); if (spectatorVideoEl && !document.fullscreenElement) spectatorVideoEl.requestFullscreen().catch(e=>console.error(`FS error: ${e.message}`)); };
            controls.appendChild(pinFSBtn); itemEl.appendChild(controls); playerWebcamsContainer.appendChild(itemEl);
            
            // Подключаем или переподключаем стрим для превью
            connectAndStorePlayerStream(player); 
        } else { // Элемент уже существует
            const h3 = itemEl.querySelector('h3'); 
            if (h3 && h3.textContent !== player.nickname) h3.textContent = player.nickname;
            if (h3 && player.isRegistered) h3.classList.add('registered-player-h3'); else if (h3) h3.classList.remove('registered-player-h3');
            // Если соединение для превью неактивно или его нет, (пере)подключаем
            if (!player.peerConnection || ['closed', 'failed', 'disconnected'].includes(player.peerConnection.connectionState)) {
                console.log(`ObserverJS: Re-connecting preview for ${player.nickname} (state: ${player.peerConnection?.connectionState})`);
                connectAndStorePlayerStream(player);
            } else if (player.stream && player.videoElement.srcObject !== player.stream) { // Если есть стрим, но он не в элементе
                 player.videoElement.srcObject = player.stream;
            }
        }
    });
    Array.from(playerWebcamsContainer.children).forEach(child => { const wId=child.id.replace('player-cam-item-',''); if(!Object.values(activePlayers).some(p=>p.webcamId===wId))child.remove();});
}

// --- Новая функция для установки/поддержания соединения и сохранения потока ---
async function connectAndStorePlayerStream(player) {
    if (!player || !player.webcamId || !player.videoElement) {
        console.warn("ObserverJS: connectAndStorePlayerStream - invalid player object or missing elements.");
        return;
    }
    // Если камера игрока не должна показываться, не устанавливаем соединение
    if (!player.showWebcam) {
        console.log(`ObserverJS: [Preview ${player.nickname}] Webcam is set to NOT SHOW. Clearing video and closing PC if exists.`);
        if (player.peerConnection && player.peerConnection.connectionState !== 'closed') {
            player.peerConnection.close();
            player.peerConnection = null;
        }
        if (player.videoElement) player.videoElement.srcObject = null;
        player.stream = null;
        // Тут можно показать плейсхолдер для превью "камера отключена"
        return;
    }

    // Закрываем существующее соединение, если оно есть и не 'connected'/'connecting' (или если хотим принудительно пересоздать)
    if (player.peerConnection && !['connected', 'connecting'].includes(player.peerConnection.connectionState) ) {
        console.log(`ObserverJS: [Preview ${player.nickname}] Closing existing non-active PC (state: ${player.peerConnection.connectionState}).`);
        player.peerConnection.close();
        player.peerConnection = null;
        player.stream = null;
        if(player.videoElement) player.videoElement.srcObject = null;
    }
    // Если уже есть активное соединение, ничего не делаем
    if (player.peerConnection && ['connected', 'connecting'].includes(player.peerConnection.connectionState)) {
        // console.log(`ObserverJS: [Preview ${player.nickname}] Connection already active or connecting.`);
        if (player.stream && player.videoElement.srcObject !== player.stream) { // Если стрим есть, но не присвоен
             player.videoElement.srcObject = player.stream;
        }
        return;
    }


    console.log(`ObserverJS: [Preview ${player.nickname}] Creating NEW PC.`);
    const pc = new RTCPeerConnection(pcConfig);
    player.peerConnection = pc; // Сохраняем новое соединение
    pc.playerName = player.nickname; // Для логов

    pc.onicecandidate = event => { if (event.candidate) { socket.emit('webrtc_ice_candidate', {candidate:event.candidate, targetId:player.webcamId, isTargetPlayer:true, senderId:observerSessionId}); }};
    
    pc.ontrack = event => {
        console.log(`ObserverJS: [Preview ${player.nickname}] Track RECEIVED:`, event.track); 
        if (event.streams && event.streams[0]) { 
            player.stream = event.streams[0]; // Сохраняем поток
            if (player.videoElement) { // Присваиваем превью
                 if (player.videoElement.srcObject !== player.stream) {
                    player.videoElement.srcObject = player.stream; 
                    player.videoElement.play().catch(e=>console.error(`ObserverJS: Error playing preview for ${player.nickname}:`,e));
                 }
            }
            // Если этот игрок сейчас выбран для основного видео, обновляем и его
            if (currentDisplayedWebcamIdInMainVideo === player.webcamId && spectatorVideoEl && (!pinnedPlayerWebcamId || pinnedPlayerWebcamId === player.webcamId)) {
                if (spectatorVideoEl.srcObject !== player.stream) {
                    console.log(`ObserverJS: Updating main video with newly received stream for ${player.nickname}`);
                    spectatorVideoEl.srcObject = player.stream;
                }
            }
        } else { console.warn(`ObserverJS: [Preview ${player.nickname}] Track event no streams[0].`); player.stream = null; }
    };
    
    pc.onconnectionstatechange = () => { 
        const connState = pc.connectionState;
        console.log(`ObserverJS: [Preview ${player.nickname}] Connection state: ${connState}`); 
        if (['failed','disconnected','closed'].includes(connState)){
            if (player.peerConnection === pc) { // Если это все еще текущий PC для этого игрока
                player.stream = null;
                if (player.videoElement) player.videoElement.srcObject = null;
                // Если этот игрок был на основном экране, и соединение упало
                if (currentDisplayedWebcamIdInMainVideo === player.webcamId && (!pinnedPlayerWebcamId || pinnedPlayerWebcamId === player.webcamId)) {
                    setMainVideo(null); // Очищаем основной экран или переключаемся, если GSI на ком-то другом
                    gsiSpectatingNicknameEl.textContent = `${player.nickname} (соединение потеряно)`;
                }
            }
        }
    };
    // pc.oniceconnectionstatechange и pc.onsignalingstatechange для детального логгирования
    pc.oniceconnectionstatechange = () => { console.log(`ObserverJS: [Preview ${player.nickname}] ICE state: ${pc.iceConnectionState}`); };
    pc.onsignalingstatechange = () => { console.log(`ObserverJS: [Preview ${player.nickname}] Signaling state: ${pc.signalingState}`); };
    
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    try {
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { offer: offer, targetWebcamId: player.webcamId, senderWebcamId: observerSessionId });
    } catch (e) { console.error(`ObserverJS: [Preview ${player.nickname}] Error creating/sending offer:`, e); }
}


// --- Обработчики событий Socket.IO ---
socket.on('current_players', (playersData) => { 
    console.log('ObserverJS: Received current_players:', playersData); 
    const newActivePlayers = {};
    playersData.forEach(p => {
        if (p.nickname) {
            newActivePlayers[p.nickname] = { 
                ...(activePlayers[p.nickname] || {}), // Сохраняем существующие pc/stream/videoElement если есть
                ...p, 
                showWebcam: p.showWebcam === undefined ? true : p.showWebcam 
            };
        }
    }); 
    activePlayers = newActivePlayers;
    updatePlayerListAndWebcams(); 
});

socket.on('player_update', (playerData) => { 
    console.log('ObserverJS: Received player_update:', playerData); 
    if (playerData.nickname) {
        activePlayers[playerData.nickname] = { 
            ...(activePlayers[playerData.nickname] || {}), 
            ...playerData, 
            showWebcam: playerData.showWebcam === undefined ? true : playerData.showWebcam 
        };
        updatePlayerListAndWebcams(); // Обновит или создаст превью и соединение
    }
    if (pinnedPlayerWebcamId && activePlayers[playerData.nickname] && activePlayers[playerData.nickname].webcamId === pinnedPlayerWebcamId) {
        pinnedNicknameEl.textContent = playerData.nickname;
    }
    // Если обновился игрок, который сейчас на основном экране (и не закреплен другой)
    if (currentDisplayedWebcamIdInMainVideo === playerData.webcamId && (!pinnedPlayerWebcamId || pinnedPlayerWebcamId === playerData.webcamId)) {
        if (activePlayers[playerData.nickname]) {
             setMainVideo(activePlayers[playerData.nickname]);
        }
    }
});

socket.on('player_left', ({ nickname, webcamId }) => { 
    console.log(`ObserverJS: Received player_left: ${nickname} (Webcam: ${webcamId})`); 
    const playerThatLeft = activePlayers[nickname];
    if (playerThatLeft) {
        if (playerThatLeft.peerConnection) { playerThatLeft.peerConnection.close(); }
        const item = document.getElementById(`player-cam-item-${webcamId}`); 
        if (item) item.remove(); 
        delete activePlayers[nickname];
    } 
    if (pinnedPlayerWebcamId === webcamId) { console.log(`ObserverJS: Pinned player ${nickname} left.`); unpinPlayer(); } 
    if (currentDisplayedWebcamIdInMainVideo === webcamId) { 
        console.log(`ObserverJS: Main displayed player ${nickname} left.`);
        setMainVideo(null); // Очищаем основной экран
        // Пытаемся переключиться на текущую цель GSI, если не был никто закреплен
        if (!pinnedPlayerWebcamId && currentGsiSpectatedWebcamId) {
            const gsiTarget = Object.values(activePlayers).find(p => p.webcamId === currentGsiSpectatedWebcamId);
            if (gsiTarget) setMainVideo(gsiTarget);
        }
    }
    if (currentGsiSpectatedWebcamId === webcamId) { currentGsiSpectatedWebcamId = null; gsiSpectatingNicknameEl.textContent = 'N/A'; gsiSpectatingSteamIDEl.textContent = 'N/A'; }
});

socket.on('spectate_change', (data) => { 
    const { steamID, nickname, webcamId, showWebcam } = data; 
    console.log('ObserverJS: Received GSI spectate_change:', data); 
    gsiSpectatingNicknameEl.textContent = nickname || 'N/A'; 
    gsiSpectatingSteamIDEl.textContent = steamID || 'N/A'; 
    currentGsiSpectatedWebcamId = webcamId; 

    if (!spectatorVideoEl) { console.error("ObserverJS: Main video element missing for spectate_change."); return; } 
    if (pinnedPlayerWebcamId) { console.log(`ObserverJS: GSI to ${nickname}, but player ${pinnedNicknameEl.textContent} is pinned. Main video NOT switched.`); return; } 
    
    if (!webcamId) { // GSI обсервер никого не смотрит или у игрока нет webcamId
        console.log("ObserverJS: GSI spectate change to no specific player or player without webcam. Clearing main video."); 
        setMainVideo(null);
        return; 
    }
    
    const targetPlayer = Object.values(activePlayers).find(p => p.webcamId === webcamId);
    if (targetPlayer) {
        // Передаем showWebcam от GSI, если есть, иначе из данных игрока
        const effectiveShowWebcam = showWebcam !== undefined ? showWebcam : targetPlayer.showWebcam;
        console.log(`ObserverJS: GSI change. Switching main video to ${targetPlayer.nickname} (ShowPref: ${effectiveShowWebcam})`);
        targetPlayer.showWebcam = effectiveShowWebcam; // Обновляем на всякий случай, если GSI прислал актуальное
        setMainVideo(targetPlayer);
    } else {
        console.warn(`ObserverJS: GSI spectate change to ${nickname}, but player not found in activePlayers. Clearing main video.`);
        setMainVideo(null);
         gsiSpectatingNicknameEl.textContent = `${nickname} (нет активной камеры)`;
    }
});

socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => { /* ... как в #43 ... */ if (viewerWebcamId !== observerSessionId) return; let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===playerWebcamId); if (spectatorVideoEl.linkedPeerConnection && currentDisplayedWebcamIdInMainVideo===playerWebcamId && spectatorVideoEl.linkedPeerConnection.localDescription) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection && pEntry.peerConnection.localDescription) targetPC = pEntry.peerConnection; if (targetPC) { if (targetPC.signalingState==='have-local-offer'||targetPC.signalingState==='stable') { try { await targetPC.setRemoteDescription(new RTCSessionDescription(answer)); } catch (e) { console.error(`ObserverJS: Error setting remote desc (answer) from ${playerWebcamId}:`,e);}} else { console.warn(`ObserverJS: Answer from ${playerWebcamId}, but PC signalingState is ${targetPC.signalingState}.`);}} else { console.warn(`ObserverJS: Answer from ${playerWebcamId}, but no matching PC or wrong state.`);} });
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => { /* ... как в #43 ... */ if (forTargetId !== observerSessionId) return; let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===iceSenderId); if (spectatorVideoEl.linkedPeerConnection && currentDisplayedWebcamIdInMainVideo === iceSenderId) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection) targetPC = pEntry.peerConnection; if (targetPC && candidate) { try { await targetPC.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.error(`ObserverJS: Error adding ICE from ${iceSenderId}:`,e);}} });
socket.on('player_preference_update', ({ nickname, webcamId, showWebcam }) => { /* ... как в #43 ... */ console.log('ObserverJS: Received player_preference_update:', { nickname, webcamId, showWebcam }); const playerToUpdate = Object.values(activePlayers).find(p => p.webcamId === webcamId); if (playerToUpdate) { playerToUpdate.showWebcam = showWebcam; if (currentDisplayedWebcamIdInMainVideo === webcamId && spectatorVideoEl) { setMainVideo(playerToUpdate); } if (playerToUpdate.videoElement) { if (showWebcam && (!playerToUpdate.peerConnection || playerToUpdate.peerConnection.connectionState === 'closed')) connectAndStorePlayerStream(playerToUpdate); else if (!showWebcam && playerToUpdate.peerConnection) { playerToUpdate.peerConnection.close(); playerToUpdate.peerConnection = null; playerToUpdate.stream = null; playerToUpdate.videoElement.srcObject = null; /* Показать плейсхолдер для превью */ } else if (showWebcam && playerToUpdate.stream && playerToUpdate.videoElement.srcObject !== playerToUpdate.stream) playerToUpdate.videoElement.srcObject = playerToUpdate.stream; } const checkbox = document.querySelector(`.show-webcam-toggle[data-webcamid="${webcamId}"]`); if (checkbox) checkbox.checked = showWebcam; }});
socket.on('webrtc_error', (data) => { /* ... как в #43 ... */ console.error('ObserverJS: Received webrtc_error from server:', data); if (data.targetWebcamId === currentDisplayedWebcamIdInMainVideo && spectatorVideoEl && (!pinnedPlayerWebcamId||pinnedPlayerWebcamId===data.targetWebcamId)) gsiSpectatingNicknameEl.textContent = `${gsiSpectatingNicknameEl.textContent} (Ошибка: ${data.message})`;});