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

let activePlayers = {}; 
let currentGsiSpectatedWebcamId = null; 
let currentDisplayedWebcamId = null;  
let pinnedPlayerWebcamId = null;      
let pcForMainVideoToCloseLater = null; // Для отложенного закрытия старого соединения основного видео
let pcForPreviewsToCloseLater = {};   // Для отложенного закрытия старых соединений превью {webcamId: pc}


const observerSessionId = 'obs-' + Math.random().toString(36).substring(2, 9);

console.log('ObserverJS: Initialized. My session ID:', observerSessionId);
if (!spectatorVideoEl) console.error("ObserverJS: CRITICAL - Main video element 'spectatorVideo' not found!");

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

fullscreenBtn.onclick = () => { if (!document.fullscreenElement) { spectatorVideoEl.requestFullscreen().catch(err => { console.error(`ObserverJS: Error fullscreen: ${err.message} (${err.name})`); }); } else { if (document.exitFullscreen) document.exitFullscreen(); } };
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement === spectatorVideoEl) { fullscreenBtn.textContent = 'Выйти из полноэкранного'; console.log('ObserverJS: Entered fullscreen.'); } else { fullscreenBtn.textContent = 'На весь экран'; console.log('ObserverJS: Exited fullscreen.'); if (pinnedPlayerWebcamId) unpinPlayer(); } });
function pinPlayer(webcamId, nickname) { if (!activePlayers[nickname] || activePlayers[nickname].webcamId !== webcamId) { console.warn(`ObserverJS: Pin attempt for ${nickname} (${webcamId}) failed, data mismatch.`); return; } pinnedPlayerWebcamId = webcamId; pinnedNicknameEl.textContent = nickname; pinnedPlayerInfoEl.style.display = 'block'; unpinBtn.style.display = 'inline-block'; console.log(`ObserverJS: Player ${nickname} (Webcam: ${webcamId}) PINNED.`); if (currentDisplayedWebcamId !== webcamId && spectatorVideoEl) { connectToPlayerStream(webcamId, nickname, spectatorVideoEl, activePlayers[nickname]?.showWebcam); currentDisplayedWebcamId = webcamId; } }
function unpinPlayer() { console.log(`ObserverJS: Player UNPINNED.`); pinnedPlayerWebcamId = null; pinnedPlayerInfoEl.style.display = 'none'; unpinBtn.style.display = 'none'; if (currentGsiSpectatedWebcamId && spectatorVideoEl) { const gsiTarget = Object.values(activePlayers).find(p => p.webcamId === currentGsiSpectatedWebcamId); if (gsiTarget) { console.log(`ObserverJS: Unpinned, switching to GSI target: ${gsiTarget.nickname}`); connectToPlayerStream(gsiTarget.webcamId, gsiTarget.nickname, spectatorVideoEl, gsiTarget.showWebcam); currentDisplayedWebcamId = gsiTarget.webcamId; } } else if (spectatorVideoEl) { if (spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState !== 'closed') spectatorVideoEl.linkedPeerConnection.close(); spectatorVideoEl.srcObject = null; currentDisplayedWebcamId = null; } }
unpinBtn.onclick = unpinPlayer;

function updatePlayerListAndWebcams() {
    // console.log('ObserverJS: updatePlayerListAndWebcams. Active players:', JSON.parse(JSON.stringify(Object.values(activePlayers).map(p => ({n:p.nickname, w:p.webcamId, s:p.steamID, show: p.showWebcam})))));
    Object.values(activePlayers).forEach(player => {
        if (!player.webcamId) { console.log(`ObserverJS: Player ${player.nickname} no webcamId.`); return; }
        let itemId = `player-cam-item-${player.webcamId}`; let videoId = `video-${player.webcamId}`;
        let itemEl = document.getElementById(itemId);
        if (!itemEl) {
            console.log(`ObserverJS: Creating preview for ${player.nickname} (Webcam: ${player.webcamId})`);
            itemEl = document.createElement('div'); itemEl.id = itemId; itemEl.className = 'player-camera-item';
            const h3 = document.createElement('h3'); h3.textContent = player.nickname; 
            if (player.webcamId) h3.classList.add('registered-player-h3');
            itemEl.appendChild(h3);
            const videoEl = document.createElement('video'); videoEl.id = videoId; videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true; itemEl.appendChild(videoEl);
            player.videoElement = videoEl; 
            const controls = document.createElement('div');
            const watchBtn = document.createElement('button'); watchBtn.textContent = `Смотреть`;
            watchBtn.onclick = () => { console.log(`ObserverJS: Watch click for ${player.nickname}`); unpinPlayer(); if (currentDisplayedWebcamId !== player.webcamId && spectatorVideoEl) { connectToPlayerStream(player.webcamId, player.nickname, spectatorVideoEl, player.showWebcam); currentDisplayedWebcamId = player.webcamId; gsiSpectatingNicknameEl.textContent = `${player.nickname} (выбран вручную)`; gsiSpectatingSteamIDEl.textContent = player.steamID || 'N/A'; }};
            controls.appendChild(watchBtn);
            const pinFSBtn = document.createElement('button'); pinFSBtn.textContent = `📌 На весь экран`;
            pinFSBtn.onclick = () => { console.log(`ObserverJS: Pin & FS click for ${player.nickname}`); pinPlayer(player.webcamId, player.nickname); if (spectatorVideoEl && !document.fullscreenElement) spectatorVideoEl.requestFullscreen().catch(e=>console.error(`ObserverJS: FS error: ${e.message}`)); };
            controls.appendChild(pinFSBtn); itemEl.appendChild(controls); playerWebcamsContainer.appendChild(itemEl);
            if (player.videoElement) { console.log(`ObserverJS: Auto-connecting preview for ${player.nickname}`); connectToPlayerStream(player.webcamId, player.nickname, player.videoElement, player.showWebcam); }
        } else {
            const h3 = itemEl.querySelector('h3'); if (h3 && h3.textContent !== player.nickname) h3.textContent = player.nickname;
            if (h3 && player.webcamId) h3.classList.add('registered-player-h3'); else if (h3) h3.classList.remove('registered-player-h3');
            if (player.videoElement && player.peerConnection && ['connected','connecting'].includes(player.peerConnection.connectionState)) {}
            else if (player.videoElement) { console.log(`ObserverJS: Re-connecting preview for ${player.nickname} (state: ${player.peerConnection?.connectionState})`); connectToPlayerStream(player.webcamId, player.nickname, player.videoElement, player.showWebcam); }
        }
    });
    Array.from(playerWebcamsContainer.children).forEach(child => { const wId = child.id.replace('player-cam-item-',''); if (!Object.values(activePlayers).some(p=>p.webcamId===wId)) { console.log(`ObserverJS: Removing stale preview ${wId}`); child.remove();}});
}

async function connectToPlayerStream(targetPlayerWebcamId, playerName, videoElement, showWebcamPreference = true) {
    if (!videoElement) { console.error(`ObserverJS: connectToPlayerStream for ${playerName}, but videoElement is null.`); return; }
    console.log(`ObserverJS: connectToPlayerStream for player ${playerName} (Webcam: ${targetPlayerWebcamId}, ShowPref: ${showWebcamPreference}) on video element ${videoElement.id}`);
    
    if (!targetPlayerWebcamId) { 
        console.warn(`ObserverJS: No webcamId for ${playerName}. Clearing video for ${videoElement.id}.`);
        if (videoElement.linkedPeerConnection && videoElement.linkedPeerConnection.connectionState !== 'closed') {
            videoElement.linkedPeerConnection.close();
        }
        videoElement.srcObject = null; 
        videoElement.linkedPeerConnection = null;
        if (videoElement === spectatorVideoEl) currentDisplayedWebcamId = null;
        // Тут можно показать плейсхолдер, если нужно
        return; 
    }

    // Отложенное закрытие для этого конкретного videoElement
    let pcToCloseLater = null;
    if (videoElement === spectatorVideoEl) {
        if (pcForMainVideoToCloseLater && pcForMainVideoToCloseLater.connectionState !== 'closed') {
            console.log(`ObserverJS: Main video - closing previously marked pcToCloseLater.`);
            pcForMainVideoToCloseLater.close(); // Закрываем предыдущий "отложенный", если был новый вызов
        }
        pcToCloseLater = pcForMainVideoToCloseLater; // Сохраняем ссылку на текущий отложенный (если есть)
        pcForMainVideoToCloseLater = videoElement.linkedPeerConnection; // Новый кандидат на отложенное закрытие
    } else { // Для превью
        if (pcForPreviewsToCloseLater[videoElement.id] && pcForPreviewsToCloseLater[videoElement.id].connectionState !== 'closed') {
            console.log(`ObserverJS: Preview ${videoElement.id} - closing previously marked pcToCloseLater.`);
            pcForPreviewsToCloseLater[videoElement.id].close();
        }
        pcToCloseLater = pcForPreviewsToCloseLater[videoElement.id];
        pcForPreviewsToCloseLater[videoElement.id] = videoElement.linkedPeerConnection;
    }
    // Не закрываем pcForMainVideoToCloseLater или pcForPreviewsToCloseLater[videoElement.id] немедленно


    if (!showWebcamPreference) {
        console.log(`ObserverJS: Webcam for ${playerName} (${targetPlayerWebcamId}) on ${videoElement.id} is set to NOT SHOW. Clearing video.`);
        if (videoElement.linkedPeerConnection && videoElement.linkedPeerConnection.connectionState !== 'closed') {
             videoElement.linkedPeerConnection.close(); // Закрываем текущее, если было
        }
        videoElement.srcObject = null;
        videoElement.linkedPeerConnection = null;
        // Тут можно показать плейсхолдер "камера отключена администратором"
        if (pcForMainVideoToCloseLater && pcForMainVideoToCloseLater !== videoElement.linkedPeerConnection) { // Закрываем старый, если он был и не этот
             console.log(`ObserverJS: Closing old main video PC as new target is 'no show'.`);
             pcForMainVideoToCloseLater.close(); pcForMainVideoToCloseLater = null;
        }
        if (pcForPreviewsToCloseLater[videoElement.id] && pcForPreviewsToCloseLater[videoElement.id] !== videoElement.linkedPeerConnection) {
            console.log(`ObserverJS: Closing old preview PC for ${videoElement.id} as new target is 'no show'.`);
            pcForPreviewsToCloseLater[videoElement.id].close(); delete pcForPreviewsToCloseLater[videoElement.id];
        }
        return;
    }
    
    console.log(`ObserverJS: Creating new PC for ${playerName} on ${videoElement.id}`);
    const pc = new RTCPeerConnection(pcConfig); 
    videoElement.linkedPeerConnection = pc; // Связываем НОВЫЙ pc с элементом

    const playerRef = Object.values(activePlayers).find(p => p.webcamId === targetPlayerWebcamId); 
    if (playerRef) playerRef.peerConnection = pc; // Обновляем ссылку на PC в activePlayers

    pc.onicecandidate = event => { /* ... как в #37 ... */ };
    pc.ontrack = event => {
        console.log(`ObserverJS: Track RECEIVED from ${playerName} for ${videoElement.id}:`, event.track); 
        if (event.streams && event.streams[0]) { 
            if (videoElement.srcObject !== event.streams[0]) { 
                videoElement.srcObject = event.streams[0]; 
                console.log(`ObserverJS: Assigned NEW stream from ${playerName} to ${videoElement.id}`); 
                videoElement.play().catch(e=>console.error(`ObserverJS: Error playing NEW video for ${playerName} on ${videoElement.id}:`,e));
                // Теперь закрываем старое соединение, если оно было отмечено
                let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcForPreviewsToCloseLater[videoElement.id];
                if (oldPcToClose && oldPcToClose !== pc && oldPcToClose.connectionState !== 'closed') { // Убедимся, что не закрываем сами себя
                    console.log(`ObserverJS: New stream for ${videoElement.id} is playing. Closing marked old PC.`);
                    oldPcToClose.close();
                    if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null;
                    else delete pcForPreviewsToCloseLater[videoElement.id];
                }
            }
        } else { 
            console.warn(`ObserverJS: Track event for ${playerName} on ${videoElement.id} no streams[0].`);
            // Если новый поток не пришел с треками, возможно, стоит закрыть старый, если он был отмечен
            let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcForPreviewsToCloseLater[videoElement.id];
            if (oldPcToClose && oldPcToClose !== pc && oldPcToClose.connectionState !== 'closed') {
                 console.log(`ObserverJS: New stream failed (no tracks). Closing marked old PC for ${videoElement.id}.`);
                 oldPcToClose.close();
                 if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null;
                 else delete pcForPreviewsToCloseLater[videoElement.id];
            }
        }
    };
    pc.oniceconnectionstatechange = () => { /* ... как в #37, но можно добавить закрытие oldPcToClose при 'failed' нового ... */ };
    pc.onsignalingstatechange = () => { /* ... как в #37 ... */ };
    pc.onconnectionstatechange = () => { 
        const connState = pc.connectionState;
        console.log(`ObserverJS: Connection state with ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id}: ${connState}`); 
        const mainVid = videoElement === spectatorVideoEl;
        const isCurrentMain = mainVid && currentDisplayedWebcamId === targetPlayerWebcamId;
        const isPinnedCurrent = pinnedPlayerWebcamId && pinnedPlayerWebcamId === targetPlayerWebcamId;

        if (mainVid && connState === 'connected' && (!pinnedPlayerWebcamId || isPinnedCurrent)) {
            gsiSpectatingNicknameEl.textContent = `${playerName} (Подключено)`;
        } else if (mainVid && ['failed','disconnected','closed'].includes(connState)) {
            if (!pinnedPlayerWebcamId || isPinnedCurrent) {
                gsiSpectatingNicknameEl.textContent = `${playerName} (${connState})`;
            }
            // Если новое соединение не удалось, убедимся, что старое отложенное соединение закрыто
            let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcForPreviewsToCloseLater[videoElement.id];
            if (oldPcToClose && oldPcToClose !== pc && oldPcToClose.connectionState !== 'closed') {
                 console.log(`ObserverJS: New connection for ${videoElement.id} is ${connState}. Closing marked old PC.`);
                 oldPcToClose.close();
                 if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null;
                 else delete pcForPreviewsToCloseLater[videoElement.id];
            }
        }
    };
    
    console.log(`ObserverJS: Adding transceivers for ${playerName} on ${videoElement.id}`); 
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    try {
        // ... (остальная часть try-catch как в #37) ...
        console.log(`ObserverJS: Creating offer for ${playerName} on ${videoElement.id}`); const offer = await pc.createOffer();
        console.log(`ObserverJS: Setting local desc (offer) for ${playerName} on ${videoElement.id}`); await pc.setLocalDescription(offer);
        console.log(`ObserverJS: Sending offer to ${playerName} from ${observerSessionId}:`, offer);
        socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: observerSessionId });
    } catch (e) { 
        console.error(`ObserverJS: Error creating/sending offer to ${playerName} on ${videoElement.id}:`, e); 
        if(videoElement===spectatorVideoEl && currentDisplayedWebcamId===targetPlayerWebcamId && (!pinnedPlayerWebcamId||pinnedPlayerWebcamId===targetPlayerWebcamId)) gsiSpectatingNicknameEl.textContent=`${playerName} (Ошибка оффера)`;
        // Также закрыть отложенный старый PC, если новый оффер не удался
        let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcForPreviewsToCloseLater[videoElement.id];
        if (oldPcToClose && oldPcToClose !== pc && oldPcToClose.connectionState !== 'closed') {
            console.log(`ObserverJS: Offer creation failed for new PC. Closing marked old PC for ${videoElement.id}.`);
            oldPcToClose.close();
            if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null;
            else delete pcForPreviewsToCloseLater[videoElement.id];
        }
    }
}

// Обработчики socket.on 'current_players', 'player_update', 'player_left', 'spectate_change', 
// 'webrtc_answer_to_viewer', 'webrtc_ice_candidate_to_client', 'webrtc_error'
// остаются такими же, как в ПОЛНОМ КОДЕ ответа #37 (они уже включают console.log и базовую логику).
// Скопируйте их оттуда. Для краткости здесь не повторяю.
// Я вставил их из предыдущего ответа #37 для полноты:
socket.on('current_players', (playersData) => { console.log('ObserverJS: Received current_players:', playersData); const newActive = {}; playersData.forEach(p=>{if(p.nickname)newActive[p.nickname]={...(activePlayers[p.nickname]||{}),...p, showWebcam: p.showWebcam === undefined ? true : p.showWebcam}}); activePlayers=newActive; updatePlayerListAndWebcams(); });
socket.on('player_update', (playerData) => { console.log('ObserverJS: Received player_update:', playerData); if(playerData.nickname){activePlayers[playerData.nickname]={...(activePlayers[playerData.nickname]||{}),...playerData, showWebcam: playerData.showWebcam === undefined ? true : playerData.showWebcam}; updatePlayerListAndWebcams();} if(pinnedPlayerWebcamId&&activePlayers[playerData.nickname]&&activePlayers[playerData.nickname].webcamId===pinnedPlayerWebcamId)pinnedNicknameEl.textContent=playerData.nickname;});
socket.on('player_left', ({ nickname, webcamId }) => { console.log(`ObserverJS: Received player_left: ${nickname} (Webcam: ${webcamId})`); if(activePlayers[nickname]){if(activePlayers[nickname].peerConnection)activePlayers[nickname].peerConnection.close(); const item=document.getElementById(`player-cam-item-${webcamId}`); if(item)item.remove(); delete activePlayers[nickname];} if(pinnedPlayerWebcamId===webcamId){console.log(`ObserverJS: Pinned player ${nickname} left.`);unpinPlayer();} if(currentDisplayedWebcamId===webcamId&&spectatorVideoEl){if(!pinnedPlayerWebcamId){if(currentGsiSpectatedWebcamId){const target=Object.values(activePlayers).find(p=>p.webcamId===currentGsiSpectatedWebcamId);if(target)connectToPlayerStream(target.webcamId,target.nickname,spectatorVideoEl, target.showWebcam);else spectatorVideoEl.srcObject=null;}else spectatorVideoEl.srcObject=null;}} if(currentGsiSpectatedWebcamId===webcamId){currentGsiSpectatedWebcamId=null;gsiSpectatingNicknameEl.textContent='N/A';gsiSpectatingSteamIDEl.textContent='N/A';}});
socket.on('spectate_change', (data) => { const { steamID, nickname, webcamId, showWebcam } = data; console.log('ObserverJS: Received GSI spectate_change:', data); gsiSpectatingNicknameEl.textContent = nickname || 'N/A'; gsiSpectatingSteamIDEl.textContent = steamID || 'N/A'; currentGsiSpectatedWebcamId = webcamId; if (!spectatorVideoEl) { console.error("ObserverJS: Main video element missing for spectate_change."); return; } if (pinnedPlayerWebcamId) { console.log(`ObserverJS: GSI to ${nickname}, but ${pinnedPlayerWebcamId} pinned. Main video NOT switched.`); return; } if (!webcamId) { console.log("ObserverJS: GSI to no player/no webcam. Clearing main video."); if (spectatorVideoEl.linkedPeerConnection&&spectatorVideoEl.linkedPeerConnection.connectionState !== 'closed')spectatorVideoEl.linkedPeerConnection.close(); spectatorVideoEl.srcObject = null; currentDisplayedWebcamId = null; return; } if (currentDisplayedWebcamId === webcamId && spectatorVideoEl.srcObject && spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState === 'connected') { console.log(`ObserverJS: GSI to ${nickname}, already displaying.`); return; } console.log(`ObserverJS: GSI change. Switching main video to ${nickname} (Webcam: ${webcamId})`); connectToPlayerStream(webcamId, nickname, spectatorVideoEl, showWebcam); currentDisplayedWebcamId = webcamId; });
socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => { if (viewerWebcamId !== observerSessionId) return; console.log(`ObserverJS: Received answer from player ${playerWebcamId}:`, answer); let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===playerWebcamId); if (spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.localDescription && currentDisplayedWebcamId===playerWebcamId) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection && pEntry.peerConnection.localDescription) targetPC = pEntry.peerConnection; if (targetPC) { if (targetPC.signalingState==='have-local-offer'||targetPC.signalingState==='stable') { try { await targetPC.setRemoteDescription(new RTCSessionDescription(answer)); console.log(`ObserverJS: Remote desc (answer) from ${playerWebcamId} set for PC linked to ${targetPC.videoElement ? targetPC.videoElement.id : 'unknown'}.`); } catch (e) { console.error(`ObserverJS: Error setting remote desc (answer) from ${playerWebcamId}:`,e);}} else { console.warn(`ObserverJS: Answer from ${playerWebcamId}, but PC signalingState is ${targetPC.signalingState}.`);}} else { console.warn(`ObserverJS: Answer from ${playerWebcamId}, but no matching PC or wrong state.`);} });
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => { if (forTargetId !== observerSessionId) return; let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===iceSenderId); if (spectatorVideoEl.linkedPeerConnection && currentDisplayedWebcamId === iceSenderId) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection) targetPC = pEntry.peerConnection; if (targetPC && candidate) { try { await targetPC.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.error(`ObserverJS: Error adding ICE from ${iceSenderId}:`,e);}} });
socket.on('player_preference_update', ({ nickname, webcamId, showWebcam }) => { console.log('ObserverJS: Received player_preference_update:', { nickname, webcamId, showWebcam }); const playerToUpdate = Object.values(activePlayers).find(p => p.webcamId === webcamId); if (playerToUpdate) { playerToUpdate.showWebcam = showWebcam; if (currentDisplayedWebcamId === webcamId && spectatorVideoEl) { connectToPlayerStream(webcamId, playerToUpdate.nickname, spectatorVideoEl, showWebcam); } if (playerToUpdate.videoElement) { connectToPlayerStream(webcamId, playerToUpdate.nickname, playerToUpdate.videoElement, showWebcam); } const checkbox = document.querySelector(`.show-webcam-toggle[data-webcamid="${webcamId}"]`); if (checkbox) checkbox.checked = showWebcam; }});
socket.on('webrtc_error', (data) => { console.error('ObserverJS: Received webrtc_error from server:', data); if (data.targetWebcamId === currentDisplayedWebcamId && spectatorVideoEl && (!pinnedPlayerWebcamId||pinnedPlayerWebcamId===data.targetWebcamId)) gsiSpectatingNicknameEl.textContent = `${gsiSpectatingNicknameEl.textContent} (Ошибка: ${data.message})`;});