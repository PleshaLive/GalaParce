// public/js/observer.js
const socket = io();
const spectatorVideoEl = document.getElementById('spectatorVideo');
const spectatingNicknameEl = document.getElementById('spectatingNickname');
const spectatingSteamIDEl = document.getElementById('spectatingSteamID');
const playerWebcamsContainer = document.getElementById('playerWebcamsContainer');

let activePlayers = {}; // { nickname: { webcamId: '...', steamID: '...', videoElement: null, peerConnection: null } }
let currentSpectatedWebcamId = null; // webcamId игрока, чей поток в основном <video>
const observerSessionId = 'obs-' + Math.random().toString(36).substring(2, 9);

console.log('ObserverJS: Initialized. My session ID:', observerSessionId);
if (!spectatorVideoEl) console.error("ObserverJS: CRITICAL - Main video element 'spectatorVideo' not found!");

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function updatePlayerListAndWebcams() {
    console.log('ObserverJS: updatePlayerListAndWebcams. Active players:', JSON.parse(JSON.stringify(Object.values(activePlayers).map(p => ({n:p.nickname, w:p.webcamId, s:p.steamID})))));
    Object.values(activePlayers).forEach(player => {
        if (!player.webcamId) { console.log(`ObserverJS: Player ${player.nickname} no webcamId.`); return; }
        let playerCamItemId = `player-cam-item-${player.webcamId}`;
        let videoElementId = `video-${player.webcamId}`;
        let playerCamItem = document.getElementById(playerCamItemId);

        if (!playerCamItem) {
            console.log(`ObserverJS: Creating preview for ${player.nickname} (Webcam: ${player.webcamId})`);
            playerCamItem = document.createElement('div'); playerCamItem.id = playerCamItemId; playerCamItem.className = 'player-camera-item';
            const h3 = document.createElement('h3'); h3.textContent = player.nickname; playerCamItem.appendChild(h3);
            const videoEl = document.createElement('video'); videoEl.id = videoElementId; videoEl.autoplay = true; videoEl.playsInline = true; playerCamItem.appendChild(videoEl);
            player.videoElement = videoEl; 
            const watchButton = document.createElement('button'); watchButton.textContent = `Смотреть ${player.nickname}`;
            watchButton.onclick = () => {
                console.log(`ObserverJS: Watch button click for ${player.nickname} (Webcam: ${player.webcamId})`);
                if (currentSpectatedWebcamId !== player.webcamId && spectatorVideoEl) {
                     connectToPlayerStream(player.webcamId, player.nickname, spectatorVideoEl);
                     currentSpectatedWebcamId = player.webcamId; spectatingNicknameEl.textContent = player.nickname; spectatingSteamIDEl.textContent = player.steamID || 'N/A';
                } else if (!spectatorVideoEl) console.error("ObserverJS: Main video element missing for watch button.");
            };
            playerCamItem.appendChild(watchButton); playerWebcamsContainer.appendChild(playerCamItem);
            if (player.videoElement) { console.log(`ObserverJS: Auto-connecting preview for ${player.nickname}`); connectToPlayerStream(player.webcamId, player.nickname, player.videoElement); }
            else console.error(`ObserverJS: videoElement for ${player.nickname} null after creation.`);
        } else {
            const h3 = playerCamItem.querySelector('h3'); if (h3 && h3.textContent !== player.nickname) h3.textContent = player.nickname;
            if (player.videoElement && player.peerConnection && ['connected', 'connecting'].includes(player.peerConnection.connectionState)) { /* Already good */ }
            else if (player.videoElement) { console.log(`ObserverJS: Re-connecting preview for ${player.nickname} (state: ${player.peerConnection?.connectionState})`); connectToPlayerStream(player.webcamId, player.nickname, player.videoElement); }
        }
    });
}

socket.on('current_players', (playersData) => {
    console.log('ObserverJS: Received current_players:', playersData);
    playersData.forEach(p => { if (p.nickname) activePlayers[p.nickname] = { ...(activePlayers[p.nickname] || {}), ...p }; });
    updatePlayerListAndWebcams();
});
socket.on('player_update', (playerData) => {
    console.log('ObserverJS: Received player_update:', playerData);
    if (playerData.nickname) activePlayers[playerData.nickname] = { ...(activePlayers[playerData.nickname] || {}), ...playerData };
    updatePlayerListAndWebcams();
    if (spectatingNicknameEl.textContent === playerData.nickname && playerData.webcamId && currentSpectatedWebcamId !== playerData.webcamId && spectatorVideoEl) {
        console.log(`ObserverJS: Spectated ${playerData.nickname} updated, connecting main video.`);
        connectToPlayerStream(playerData.webcamId, playerData.nickname, spectatorVideoEl); currentSpectatedWebcamId = playerData.webcamId;
    }
});
socket.on('player_left', ({ nickname, webcamId }) => {
    console.log(`ObserverJS: Received player_left: ${nickname} (Webcam: ${webcamId})`);
    if (activePlayers[nickname]) {
        if (activePlayers[nickname].peerConnection) { console.log(`ObserverJS: Closing PC for left player ${nickname}`); activePlayers[nickname].peerConnection.close(); }
        const playerCamItem = document.getElementById(`player-cam-item-${webcamId}`);
        if (playerCamItem) { console.log(`ObserverJS: Removing DOM for left player ${nickname}`); playerCamItem.remove(); }
        delete activePlayers[nickname];
    }
    if (currentSpectatedWebcamId === webcamId && spectatorVideoEl) {
        spectatorVideoEl.srcObject = null; spectatingNicknameEl.textContent = 'N/A (Игрок вышел)'; currentSpectatedWebcamId = null;
        console.log(`ObserverJS: Main spectated player ${nickname} left.`);
    }
});
socket.on('spectate_change', (data) => {
    const { steamID, nickname, webcamId } = data;
    console.log('ObserverJS: Received spectate_change:', data);
    if (!spectatorVideoEl) { console.error("ObserverJS: Main video element missing for spectate_change."); return; }
    if (!webcamId) {
        spectatingNicknameEl.textContent = nickname || 'Свободная камера/Нет цели'; spectatingSteamIDEl.textContent = steamID || 'N/A';
        if (spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState !== 'closed') { console.log(`ObserverJS: Spectate to no target, closing main video PC.`); spectatorVideoEl.linkedPeerConnection.close(); }
        spectatorVideoEl.srcObject = null; currentSpectatedWebcamId = null; return;
    }
    if (currentSpectatedWebcamId === webcamId && spectatorVideoEl.srcObject && spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState === 'connected') {
        console.log(`ObserverJS: Already spectating ${nickname} & connected.`); spectatingNicknameEl.textContent = nickname; spectatingSteamIDEl.textContent = steamID || 'N/A'; return;
    }
    console.log(`ObserverJS: Spectate change to ${nickname} (Webcam: ${webcamId}), connecting main video.`);
    spectatingNicknameEl.textContent = `${nickname} (Подключение...)`; spectatingSteamIDEl.textContent = steamID || 'N/A';
    connectToPlayerStream(webcamId, nickname, spectatorVideoEl); currentSpectatedWebcamId = webcamId;
});

async function connectToPlayerStream(targetPlayerWebcamId, playerName, videoElement) {
    if (!videoElement) { console.error(`ObserverJS: connectToPlayerStream for ${playerName}, but videoElement is null.`); return; }
    console.log(`ObserverJS: connectToPlayerStream for player ${playerName} (Webcam: ${targetPlayerWebcamId}) on video element ${videoElement.id}`);
    if (!targetPlayerWebcamId) { console.warn(`ObserverJS: No webcamId for ${playerName}. Cannot connect to ${videoElement.id}.`); videoElement.srcObject = null; return; }
    if (videoElement.linkedPeerConnection && videoElement.linkedPeerConnection.connectionState !== 'closed') { console.log(`ObserverJS: Closing existing PC for ${videoElement.id} (state: ${videoElement.linkedPeerConnection.connectionState})`); videoElement.linkedPeerConnection.close(); }
    
    console.log(`ObserverJS: Creating new PC for ${playerName} on ${videoElement.id}`);
    const pc = new RTCPeerConnection(pcConfig); videoElement.linkedPeerConnection = pc;
    const playerRef = Object.values(activePlayers).find(p => p.webcamId === targetPlayerWebcamId);
    if (playerRef) playerRef.peerConnection = pc;

    pc.onicecandidate = event => {
        if (event.candidate) { console.log(`ObserverJS: Sending ICE to player ${targetPlayerWebcamId} from ${observerSessionId}:`,event.candidate); socket.emit('webrtc_ice_candidate', {candidate:event.candidate, targetId:targetPlayerWebcamId, isTargetPlayer:true, senderId:observerSessionId}); }
        else { console.log(`ObserverJS: All ICE sent for ${targetPlayerWebcamId} on ${videoElement.id}.`);}
    };
    pc.ontrack = event => {
        console.log(`ObserverJS: Track RECEIVED from ${playerName} for ${videoElement.id}:`, event.track); console.log(`ObserverJS: Streams for track:`, event.streams);
        if (event.streams && event.streams[0]) { if (videoElement.srcObject !== event.streams[0]) { videoElement.srcObject = event.streams[0]; console.log(`ObserverJS: Assigned stream from ${playerName} to ${videoElement.id}`); videoElement.play().catch(e=>console.error(`ObserverJS: Error playing video for ${playerName} on ${videoElement.id}:`,e));}}
        else { console.warn(`ObserverJS: Track event for ${playerName} on ${videoElement.id} no streams[0].`);}
    };
    pc.oniceconnectionstatechange = () => { console.log(`ObserverJS: ICE state with ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id}: ${pc.iceConnectionState}`); if(videoElement===spectatorVideoEl && pc.iceConnectionState==='connected') spectatingNicknameEl.textContent=`${playerName} (Подключено)`; if(['failed','disconnected','closed'].includes(pc.iceConnectionState)){ console.log(`ObserverJS: Connection to ${playerName} for ${videoElement.id} ${pc.iceConnectionState}.`); if(videoElement.linkedPeerConnection===pc){ if(videoElement.srcObject)videoElement.srcObject=null; if(videoElement===spectatorVideoEl && currentSpectatedWebcamId===targetPlayerWebcamId) spectatingNicknameEl.textContent=`${playerName} (Отключено)`;}}};
    pc.onsignalingstatechange = () => { console.log(`ObserverJS: Signaling state with ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id}: ${pc.signalingState}`); };
    pc.onconnectionstatechange = () => { console.log(`ObserverJS: Connection state with ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id}: ${pc.connectionState}`); if(videoElement===spectatorVideoEl && pc.connectionState==='connected') spectatingNicknameEl.textContent=`${playerName} (Подключено)`; else if(videoElement===spectatorVideoEl && ['failed','disconnected','closed'].includes(pc.connectionState)){ if(currentSpectatedWebcamId===targetPlayerWebcamId) spectatingNicknameEl.textContent=`${playerName} (${pc.connectionState})`; }};

    console.log(`ObserverJS: Adding transceivers for ${playerName} on ${videoElement.id}`);
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    try {
        console.log(`ObserverJS: Creating offer for ${playerName} on ${videoElement.id}`); const offer = await pc.createOffer();
        console.log(`ObserverJS: Setting local desc (offer) for ${playerName} on ${videoElement.id}`); await pc.setLocalDescription(offer);
        console.log(`ObserverJS: Sending offer to ${playerName} from ${observerSessionId}:`, offer);
        socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: observerSessionId });
    } catch (e) { console.error(`ObserverJS: Error creating/sending offer to ${playerName} on ${videoElement.id}:`, e); if(videoElement===spectatorVideoEl)spectatingNicknameEl.textContent=`${playerName} (Ошибка оффера)`;}
}

socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => {
    if (viewerWebcamId !== observerSessionId) return;
    console.log(`ObserverJS: Received answer from player ${playerWebcamId}:`, answer);
    let targetPC = null;
    const playerEntryForAnswer = Object.values(activePlayers).find(p => p.webcamId === playerWebcamId);
    if (spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.localDescription && currentSpectatedWebcamId === playerWebcamId) { targetPC = spectatorVideoEl.linkedPeerConnection; console.log(`ObserverJS: Answer for main video from ${playerWebcamId}.`); }
    else if (playerEntryForAnswer && playerEntryForAnswer.peerConnection && playerEntryForAnswer.peerConnection.localDescription) { targetPC = playerEntryForAnswer.peerConnection; console.log(`ObserverJS: Answer for preview from ${playerWebcamId}.`);}
    if (targetPC) { if (targetPC.signalingState === 'have-local-offer' || targetPC.signalingState === 'stable') { try { console.log(`ObserverJS: Setting remote desc (answer) from ${playerWebcamId}. Signaling state: ${targetPC.signalingState}`); await targetPC.setRemoteDescription(new RTCSessionDescription(answer)); console.log(`ObserverJS: Remote desc (answer) from ${playerWebcamId} set.`); } catch (e) { console.error(`ObserverJS: Error setting remote desc (answer) from ${playerWebcamId}:`,e);}} else { console.warn(`ObserverJS: Received answer from ${playerWebcamId}, but PC signalingState is ${targetPC.signalingState}.`);}}
    else { console.warn(`ObserverJS: Answer from ${playerWebcamId}, but no matching PC with localDescription.`);}
});
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => {
    if (forTargetId !== observerSessionId) return;
    console.log(`ObserverJS: Received ICE from player ${iceSenderId} for my session ${observerSessionId}:`, candidate);
    let targetPC = null;
    const playerEntryForIce = Object.values(activePlayers).find(p => p.webcamId === iceSenderId);
    if (spectatorVideoEl.linkedPeerConnection && currentSpectatedWebcamId === iceSenderId) { targetPC = spectatorVideoEl.linkedPeerConnection; } 
    else if (playerEntryForIce && playerEntryForIce.peerConnection) { targetPC = playerEntryForIce.peerConnection; }
    if (targetPC && candidate) { try { await targetPC.addIceCandidate(new RTCIceCandidate(candidate)); console.log(`ObserverJS: Added ICE from player ${iceSenderId}.`); } catch (e) { console.error(`ObserverJS: Error adding ICE from ${iceSenderId}:`,e);}}
    else { console.warn(`ObserverJS: ICE from ${iceSenderId}, but no active PC or no candidate data.`);}
});
socket.on('webrtc_error', (data) => {
    console.error('ObserverJS: Received webrtc_error from server:', data);
    if (data.targetWebcamId === currentSpectatedWebcamId && spectatorVideoEl) { spectatingNicknameEl.textContent = `${spectatingNicknameEl.textContent} (Ошибка: ${data.message})`;}
});