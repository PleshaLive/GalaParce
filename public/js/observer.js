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
let currentDisplayedWebcamId = null;  // webcamId того, кто сейчас в #spectatorVideo
let pinnedPlayerWebcamId = null;      

// Хранилище для WebRTC соединений, которые должны быть закрыты ПОСЛЕ успешного старта нового.
// Ключ - ID видеоэлемента, значение - RTCPeerConnection.
let pcsWaitingForClosure = {}; 

const observerSessionId = 'obs-' + Math.random().toString(36).substring(2, 9);

console.log('ObserverJS: Initialized. My session ID:', observerSessionId);
if (!spectatorVideoEl) console.error("ObserverJS: CRITICAL - Main video element 'spectatorVideo' not found!");

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- Функции управления UI и состоянием (fullscreen, pin/unpin) ---
// (Эти функции остаются такими же, как в ответе #43, я их здесь сокращу для краткости,
//  но в вашем файле они должны быть полными)
fullscreenBtn.onclick = () => { /* ... как в #43 ... */ if (!document.fullscreenElement) { spectatorVideoEl.requestFullscreen().catch(err => { console.error(`ObserverJS: Error fullscreen: ${err.message} (${err.name})`); }); } else { if (document.exitFullscreen) document.exitFullscreen(); } };
document.addEventListener('fullscreenchange', () => { /* ... как в #43 ... */ if (document.fullscreenElement === spectatorVideoEl) { fullscreenBtn.textContent = 'Выйти из полноэкранного'; console.log('ObserverJS: Entered fullscreen.'); } else { fullscreenBtn.textContent = 'На весь экран'; console.log('ObserverJS: Exited fullscreen.'); if (pinnedPlayerWebcamId) unpinPlayer(); } });
function pinPlayer(webcamId, nickname) { /* ... как в #43 ... */ if (!activePlayers[nickname] || activePlayers[nickname].webcamId !== webcamId) { console.warn(`ObserverJS: Pin attempt for ${nickname} (${webcamId}) failed, data mismatch.`); return; } pinnedPlayerWebcamId = webcamId; pinnedNicknameEl.textContent = nickname; pinnedPlayerInfoEl.style.display = 'block'; unpinBtn.style.display = 'inline-block'; console.log(`ObserverJS: Player ${nickname} (Webcam: ${webcamId}) PINNED.`); if (currentDisplayedWebcamId !== webcamId && spectatorVideoEl) { connectToPlayerStream(webcamId, nickname, spectatorVideoEl, activePlayers[nickname]?.showWebcam); currentDisplayedWebcamId = webcamId; } }
function unpinPlayer() { /* ... как в #43 ... */ console.log(`ObserverJS: Player UNPINNED.`); pinnedPlayerWebcamId = null; pinnedPlayerInfoEl.style.display = 'none'; unpinBtn.style.display = 'none'; if (currentGsiSpectatedWebcamId && spectatorVideoEl) { const gsiTarget = Object.values(activePlayers).find(p => p.webcamId === currentGsiSpectatedWebcamId); if (gsiTarget) { console.log(`ObserverJS: Unpinned, switching to GSI target: ${gsiTarget.nickname}`); connectToPlayerStream(gsiTarget.webcamId, gsiTarget.nickname, spectatorVideoEl, gsiTarget.showWebcam); currentDisplayedWebcamId = gsiTarget.webcamId; } } else if (spectatorVideoEl) { if (spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState !== 'closed') spectatorVideoEl.linkedPeerConnection.close(); spectatorVideoEl.srcObject = null; currentDisplayedWebcamId = null; } }
unpinBtn.onclick = unpinPlayer;
function updatePlayerListAndWebcams() { /* ... как в #43 ... */ Object.values(activePlayers).forEach(player => { if (!player.webcamId) return; let itemId = `player-cam-item-${player.webcamId}`; let videoId = `video-${player.webcamId}`; let itemEl = document.getElementById(itemId); if (!itemEl) { itemEl = document.createElement('div'); itemEl.id = itemId; itemEl.className = 'player-camera-item'; const h3 = document.createElement('h3'); h3.textContent = player.nickname; if (player.webcamId) h3.classList.add('registered-player-h3'); itemEl.appendChild(h3); const videoEl = document.createElement('video'); videoEl.id = videoId; videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true; itemEl.appendChild(videoEl); player.videoElement = videoEl; const controls = document.createElement('div'); const watchBtn = document.createElement('button'); watchBtn.textContent = `Смотреть`; watchBtn.onclick = () => { unpinPlayer(); if (currentDisplayedWebcamId !== player.webcamId && spectatorVideoEl) { connectToPlayerStream(player.webcamId, player.nickname, spectatorVideoEl, player.showWebcam); currentDisplayedWebcamId = player.webcamId; gsiSpectatingNicknameEl.textContent = `${player.nickname} (вручную)`; gsiSpectatingSteamIDEl.textContent = player.steamID || 'N/A'; }}; controls.appendChild(watchBtn); const pinFSBtn = document.createElement('button'); pinFSBtn.textContent = `📌 На весь экран`; pinFSBtn.onclick = () => { pinPlayer(player.webcamId, player.nickname); if (spectatorVideoEl && !document.fullscreenElement) spectatorVideoEl.requestFullscreen().catch(e=>console.error(`FS error: ${e.message}`)); }; controls.appendChild(pinFSBtn); itemEl.appendChild(controls); playerWebcamsContainer.appendChild(itemEl); if (player.videoElement) connectToPlayerStream(player.webcamId, player.nickname, player.videoElement, player.showWebcam); } else { const h3 = itemEl.querySelector('h3'); if (h3 && h3.textContent !== player.nickname) h3.textContent = player.nickname; if (h3 && player.webcamId) h3.classList.add('registered-player-h3'); else if (h3) h3.classList.remove('registered-player-h3'); if (player.videoElement && player.peerConnection && ['connected','connecting'].includes(player.peerConnection.connectionState)) {} else if (player.videoElement) connectToPlayerStream(player.webcamId, player.nickname, player.videoElement, player.showWebcam); } }); Array.from(playerWebcamsContainer.children).forEach(child => { const wId=child.id.replace('player-cam-item-',''); if(!Object.values(activePlayers).some(p=>p.webcamId===wId))child.remove();});}


// --- КЛЮЧЕВАЯ ФУНКЦИЯ С ОБНОВЛЕННОЙ ЛОГИКОЙ ---
async function connectToPlayerStream(targetPlayerWebcamId, playerName, videoElement, showWebcamPreference = true) {
    if (!videoElement) { console.error(`ObserverJS: connectToPlayerStream for ${playerName}, videoElement is null.`); return; }
    const videoElementId = videoElement.id; // Используем ID элемента для ключа в pcsWaitingForClosure

    console.log(`ObserverJS: connectToPlayerStream for player ${playerName} (Webcam: ${targetPlayerWebcamId}, ShowPref: ${showWebcamPreference}) on video element ${videoElementId}`);

    // 1. Определяем текущее активное соединение для этого videoElement (если есть)
    const currentPCForThisElement = videoElement.linkedPeerConnection;

    // 2. Если мы собираемся подключить НОВЫЙ webcamId (или тот же, но перезапустить),
    //    и для этого videoElement уже было активное соединение (currentPCForThisElement),
    //    то это currentPCForThisElement становится кандидатом на отложенное закрытие.
    if (currentPCForThisElement && currentPCForThisElement.connectionState !== 'closed') {
        // Если уже есть другое соединение, ожидающее закрытия для этого videoElement, закрываем его немедленно.
        if (pcsWaitingForClosure[videoElementId] && pcsWaitingForClosure[videoElementId] !== currentPCForThisElement) {
            console.log(`ObserverJS: [${videoElementId}] Closing previously marked PC (rapid switch).`);
            pcsWaitingForClosure[videoElementId].close();
        }
        pcsWaitingForClosure[videoElementId] = currentPCForThisElement; // Помечаем текущее для отложенного закрытия
        console.log(`ObserverJS: [${videoElementId}] Marked PC for player ${currentPCForThisElement.playerName || 'Unknown'} for deferred closure.`);
    }
    // НЕ ОЧИЩАЕМ videoElement.srcObject ЗДЕСЬ, чтобы старое видео продолжало показываться.

    // 3. Если нет цели или камера отключена "галочкой"
    if (!targetPlayerWebcamId || !showWebcamPreference) {
        console.warn(`ObserverJS: [${videoElementId}] No target webcam or webcam not shown for ${playerName}. Clearing video.`);
        if (videoElement.srcObject) videoElement.srcObject = null;
        videoElement.linkedPeerConnection = null; // Убираем связь с (возможно) старым PC
        if (videoElement === spectatorVideoEl) currentDisplayedWebcamId = null;

        // Закрываем соединение, которое могло быть помечено для отложенного закрытия, так как нового не будет
        if (pcsWaitingForClosure[videoElementId]) {
            console.log(`ObserverJS: [${videoElementId}] No new stream, closing marked old PC.`);
            pcsWaitingForClosure[videoElementId].close();
            delete pcsWaitingForClosure[videoElementId];
        }
        // Тут можно показать плейсхолдер
        if (!showWebcamPreference && targetPlayerWebcamId) { /* console.log("Show placeholder 'admin disabled'"); */ }
        else { /* console.log("Show placeholder 'no target'"); */ }
        return; 
    }
    
    // 4. Создаем новое WebRTC соединение
    console.log(`ObserverJS: [${videoElementId}] Creating NEW PC for ${playerName} (Webcam: ${targetPlayerWebcamId})`);
    const newPC = new RTCPeerConnection(pcConfig);
    newPC.playerName = playerName; // Добавим имя для логов
    videoElement.linkedPeerConnection = newPC; // Связываем НОВЫЙ pc с элементом

    const playerRef = Object.values(activePlayers).find(p => p.webcamId === targetPlayerWebcamId); 
    if (playerRef) playerRef.peerConnection = newPC; // Обновляем ссылку на PC в activePlayers

    newPC.onicecandidate = event => { /* ... как в #43 ... */ if (event.candidate) { socket.emit('webrtc_ice_candidate', {candidate:event.candidate, targetId:targetPlayerWebcamId, isTargetPlayer:true, senderId:observerSessionId}); }};
    
    newPC.ontrack = event => {
        console.log(`ObserverJS: [${videoElementId}] Track RECEIVED for NEW PC of ${playerName}:`, event.track); 
        if (event.streams && event.streams[0]) { 
            if (videoElement.srcObject !== event.streams[0]) { 
                console.log(`ObserverJS: [${videoElementId}] Assigning NEW stream from ${playerName}. Current srcObject differs.`);
                videoElement.srcObject = event.streams[0]; 
                videoElement.play().catch(e=>console.error(`ObserverJS: Error playing NEW video for ${playerName} on ${videoElementId}:`,e));
                
                // Успешно получили новый поток, теперь можно закрыть старое соединение, если оно было помечено
                if (pcsWaitingForClosure[videoElementId] && pcsWaitingForClosure[videoElementId] !== newPC) {
                    console.log(`ObserverJS: [${videoElementId}] New stream playing. Closing marked old PC for player ${pcsWaitingForClosure[videoElementId].playerName || 'Previous'}.`);
                    pcsWaitingForClosure[videoElementId].close();
                    delete pcsWaitingForClosure[videoElementId];
                }
            } else {
                 console.log(`ObserverJS: [${videoElementId}] Received track for ${playerName}, but srcObject is already the same. This might be a re-negotiation or duplicate track.`);
            }
        } else { 
            console.warn(`ObserverJS: [${videoElementId}] Track event for ${playerName} no streams[0].`);
            // Если новый поток не пришел с треками, старый поток (если был) продолжит показываться.
            // Но мы должны закрыть помеченный для закрытия старый PC, если он был, т.к. новый не удался.
            if (pcsWaitingForClosure[videoElementId] && pcsWaitingForClosure[videoElementId] !== newPC) {
                 console.log(`ObserverJS: [${videoElementId}] New stream failed (no tracks). Closing marked old PC.`);
                 pcsWaitingForClosure[videoElementId].close();
                 delete pcsWaitingForClosure[videoElementId];
            }
        }
    };

    newPC.onconnectionstatechange = () => { 
        const connState = newPC.connectionState;
        console.log(`ObserverJS: [${videoElementId}] NEW PC Connection state for ${playerName}: ${connState}`);
        if (videoElement === spectatorVideoEl && currentDisplayedWebcamId === targetPlayerWebcamId) { // Только если это текущий основной игрок
            const isPinnedThis = pinnedPlayerWebcamId && pinnedPlayerWebcamId === targetPlayerWebcamId;
            if (connState === 'connected' && (!pinnedPlayerWebcamId || isPinnedThis)) {
                gsiSpectatingNicknameEl.textContent = `${playerName} (Подключено)`;
            } else if (['failed','disconnected','closed'].includes(connState)) {
                if (!pinnedPlayerWebcamId || isPinnedThis) {
                    gsiSpectatingNicknameEl.textContent = `${playerName} (${connState})`;
                }
                // Если новое соединение не удалось, и оно было текущим для этого элемента, очищаем видео
                if (videoElement.linkedPeerConnection === newPC) {
                    videoElement.srcObject = null;
                }
                // Также убедимся, что старое отложенное соединение закрыто
                if (pcsWaitingForClosure[videoElementId] && pcsWaitingForClosure[videoElementId] !== newPC) {
                    console.log(`ObserverJS: [${videoElementId}] New connection is ${connState}. Ensuring old marked PC is closed.`);
                    pcsWaitingForClosure[videoElementId].close();
                    delete pcsWaitingForClosure[videoElementId];
                }
            }
        }
    };
    // pc.oniceconnectionstatechange и pc.onsignalingstatechange можно оставить для подробного логгирования как раньше, если нужно
    newPC.oniceconnectionstatechange = () => { console.log(`ObserverJS: [${videoElementId}] NEW PC ICE state for ${playerName}: ${newPC.iceConnectionState}`); };
    newPC.onsignalingstatechange = () => { console.log(`ObserverJS: [${videoElementId}] NEW PC Signaling state for ${playerName}: ${newPC.signalingState}`); };
    
    console.log(`ObserverJS: [${videoElementId}] Adding transceivers for NEW PC of ${playerName}`); 
    newPC.addTransceiver('video', { direction: 'recvonly' }); newPC.addTransceiver('audio', { direction: 'recvonly' });
    try {
        console.log(`ObserverJS: [${videoElementId}] Creating offer for NEW PC of ${playerName}`); const offer = await newPC.createOffer();
        console.log(`ObserverJS: [${videoElementId}] Setting local desc (offer) for NEW PC of ${playerName}`); await newPC.setLocalDescription(offer);
        console.log(`ObserverJS: [${videoElementId}] Sending offer for NEW PC of ${playerName} from ${observerSessionId}`);
        socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: observerSessionId });
    } catch (e) { 
        console.error(`ObserverJS: [${videoElementId}] Error creating/sending offer for NEW PC of ${playerName}:`, e); 
        if(videoElement===spectatorVideoEl && currentDisplayedWebcamId===targetPlayerWebcamId && (!pinnedPlayerWebcamId||pinnedPlayerWebcamId===targetPlayerWebcamId)) gsiSpectatingNicknameEl.textContent=`${playerName} (Ошибка оффера)`;
        // Если оффер не удался, также закрываем старое отложенное соединение
        if (pcsWaitingForClosure[videoElementId] && pcsWaitingForClosure[videoElementId] !== newPC) {
            console.log(`ObserverJS: [${videoElementId}] Offer creation failed for new PC. Closing marked old PC.`);
            pcsWaitingForClosure[videoElementId].close();
            delete pcsWaitingForClosure[videoElementId];
        }
    }
}

// --- Остальные обработчики событий Socket.IO ---
// (Код для 'current_players', 'player_update', 'player_left', 'spectate_change', 
// 'webrtc_answer_to_viewer', 'webrtc_ice_candidate_to_client', 'player_preference_update', 'webrtc_error' 
// остается таким же, как в ПОЛНОМ КОДЕ ответа #43)
// Я скопирую их сюда для полноты, убедитесь, что они используют обновленную connectToPlayerStream с showWebcamPreference.
socket.on('current_players', (playersData) => { console.log('ObserverJS: Received current_players:', playersData); const newActive = {}; playersData.forEach(p=>{if(p.nickname)newActive[p.nickname]={...(activePlayers[p.nickname]||{}),...p, showWebcam: p.showWebcam === undefined ? true : p.showWebcam}}); activePlayers=newActive; updatePlayerListAndWebcams(); });
socket.on('player_update', (playerData) => { console.log('ObserverJS: Received player_update:', playerData); if(playerData.nickname){activePlayers[playerData.nickname]={...(activePlayers[playerData.nickname]||{}),...playerData, showWebcam: playerData.showWebcam === undefined ? true : playerData.showWebcam}; updatePlayerListAndWebcams();} if(pinnedPlayerWebcamId&&activePlayers[playerData.nickname]&&activePlayers[playerData.nickname].webcamId===pinnedPlayerWebcamId)pinnedNicknameEl.textContent=playerData.nickname;});
socket.on('player_left', ({ nickname, webcamId }) => { console.log(`ObserverJS: Received player_left: ${nickname} (Webcam: ${webcamId})`); const playerThatLeft = activePlayers[nickname]; if(playerThatLeft){if(playerThatLeft.peerConnection)playerThatLeft.peerConnection.close(); const item=document.getElementById(`player-cam-item-${webcamId}`); if(item)item.remove(); delete activePlayers[nickname];} if(pinnedPlayerWebcamId===webcamId){console.log(`ObserverJS: Pinned player ${nickname} left.`);unpinPlayer();} if(currentDisplayedWebcamId===webcamId&&spectatorVideoEl){if(!pinnedPlayerWebcamId){if(currentGsiSpectatedWebcamId){const target=Object.values(activePlayers).find(p=>p.webcamId===currentGsiSpectatedWebcamId);if(target)connectToPlayerStream(target.webcamId,target.nickname,spectatorVideoEl, target.showWebcam);else spectatorVideoEl.srcObject=null;}else spectatorVideoEl.srcObject=null;}} if(currentGsiSpectatedWebcamId===webcamId){currentGsiSpectatedWebcamId=null;gsiSpectatingNicknameEl.textContent='N/A';gsiSpectatingSteamIDEl.textContent='N/A';}});
socket.on('spectate_change', (data) => { const { steamID, nickname, webcamId, showWebcam } = data; console.log('ObserverJS: Received GSI spectate_change:', data); gsiSpectatingNicknameEl.textContent = nickname || 'N/A'; gsiSpectatingSteamIDEl.textContent = steamID || 'N/A'; currentGsiSpectatedWebcamId = webcamId; if (!spectatorVideoEl) { console.error("ObserverJS: Main video element missing for spectate_change."); return; } if (pinnedPlayerWebcamId) { console.log(`ObserverJS: GSI to ${nickname}, but ${pinnedPlayerWebcamId} pinned. Main video NOT switched.`); return; } if (!webcamId) { console.log("ObserverJS: GSI to no player/no webcam. Clearing main video."); connectToPlayerStream(null, 'N/A', spectatorVideoEl, false); currentDisplayedWebcamId = null; return; } if (currentDisplayedWebcamId === webcamId && spectatorVideoEl.srcObject && spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState === 'connected') { console.log(`ObserverJS: GSI to ${nickname}, already displaying.`); return; } console.log(`ObserverJS: GSI change. Switching main video to ${nickname} (Webcam: ${webcamId})`); connectToPlayerStream(webcamId, nickname, spectatorVideoEl, showWebcam); currentDisplayedWebcamId = webcamId; });
socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => { if (viewerWebcamId !== observerSessionId) return; console.log(`ObserverJS: Received answer from player ${playerWebcamId}:`, answer); let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===playerWebcamId); if (spectatorVideoEl.linkedPeerConnection && currentDisplayedWebcamId===playerWebcamId && spectatorVideoEl.linkedPeerConnection.localDescription) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection && pEntry.peerConnection.localDescription) targetPC = pEntry.peerConnection; if (targetPC) { if (targetPC.signalingState==='have-local-offer'||targetPC.signalingState==='stable') { try { await targetPC.setRemoteDescription(new RTCSessionDescription(answer)); console.log(`ObserverJS: Remote desc (answer) from ${playerWebcamId} set for PC linked to ${targetPC.videoElement ? targetPC.videoElement.id : 'unknown'}.`); } catch (e) { console.error(`ObserverJS: Error setting remote desc (answer) from ${playerWebcamId}:`,e);}} else { console.warn(`ObserverJS: Answer from ${playerWebcamId}, but PC signalingState is ${targetPC.signalingState}.`);}} else { console.warn(`ObserverJS: Answer from ${playerWebcamId}, but no matching PC or wrong state.`);} });
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => { if (forTargetId !== observerSessionId) return; let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===iceSenderId); if (spectatorVideoEl.linkedPeerConnection && currentDisplayedWebcamId === iceSenderId) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection) targetPC = pEntry.peerConnection; if (targetPC && candidate) { try { await targetPC.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.error(`ObserverJS: Error adding ICE from ${iceSenderId}:`,e);}} });
socket.on('player_preference_update', ({ nickname, webcamId, showWebcam }) => { console.log('ObserverJS: Received player_preference_update:', { nickname, webcamId, showWebcam }); const playerToUpdate = Object.values(activePlayers).find(p => p.webcamId === webcamId); if (playerToUpdate) { playerToUpdate.showWebcam = showWebcam; if (currentDisplayedWebcamId === webcamId && spectatorVideoEl) { connectToPlayerStream(webcamId, playerToUpdate.nickname, spectatorVideoEl, showWebcam); } if (playerToUpdate.videoElement) { connectToPlayerStream(webcamId, playerToUpdate.nickname, playerToUpdate.videoElement, showWebcam); } const checkbox = document.querySelector(`.show-webcam-toggle[data-webcamid="${webcamId}"]`); if (checkbox) checkbox.checked = showWebcam; }});
socket.on('webrtc_error', (data) => { console.error('ObserverJS: Received webrtc_error from server:', data); if (data.targetWebcamId === currentDisplayedWebcamId && spectatorVideoEl && (!pinnedPlayerWebcamId||pinnedPlayerWebcamId===data.targetWebcamId)) gsiSpectatingNicknameEl.textContent = `${gsiSpectatingNicknameEl.textContent} (Ошибка: ${data.message})`;});