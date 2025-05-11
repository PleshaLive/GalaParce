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

if (!spectatorVideoEl) {
    console.error("ObserverJS: CRITICAL - Main video element 'spectatorVideo' not found!");
}

const pcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function updatePlayerListAndWebcams() {
    console.log('ObserverJS: updatePlayerListAndWebcams called. Active players:', activePlayers);
    // playerWebcamsContainer.innerHTML = ''; // Очищаем, чтобы избежать дубликатов, но может прерывать потоки. Лучше управлять умнее.

    Object.values(activePlayers).forEach(player => {
        if (!player.webcamId) {
            console.log(`ObserverJS: Player ${player.nickname} has no webcamId yet.`);
            return;
        }

        let playerCamItemId = `player-cam-item-${player.webcamId}`;
        let videoElementId = `video-${player.webcamId}`;
        let playerCamItem = document.getElementById(playerCamItemId);

        if (!playerCamItem) {
            console.log(`ObserverJS: Creating new preview elements for player ${player.nickname} (Webcam ID: ${player.webcamId})`);
            playerCamItem = document.createElement('div');
            playerCamItem.id = playerCamItemId;
            playerCamItem.className = 'player-camera-item';
            
            const h3 = document.createElement('h3');
            h3.textContent = player.nickname;
            playerCamItem.appendChild(h3);

            const videoEl = document.createElement('video');
            videoEl.id = videoElementId;
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            // videoEl.muted = true; // Можно сделать превью без звука
            playerCamItem.appendChild(videoEl);
            player.videoElement = videoEl; // Сохраняем ссылку на элемент

            const watchButton = document.createElement('button');
            watchButton.textContent = `Смотреть ${player.nickname}`;
            watchButton.onclick = () => {
                console.log(`ObserverJS: Clicked "Смотреть ${player.nickname}" (Webcam ID: ${player.webcamId})`);
                if (currentSpectatedWebcamId !== player.webcamId && spectatorVideoEl) {
                     connectToPlayerStream(player.webcamId, player.nickname, spectatorVideoEl);
                     currentSpectatedWebcamId = player.webcamId;
                     spectatingNicknameEl.textContent = player.nickname;
                     spectatingSteamIDEl.textContent = player.steamID || 'N/A';
                } else if (!spectatorVideoEl) {
                    console.error("ObserverJS: Cannot switch main video, spectatorVideoEl is null.");
                }
            };
            playerCamItem.appendChild(watchButton);
            playerWebcamsContainer.appendChild(playerCamItem);

            // Автоматически подключаемся к камере этого игрока для мини-превью
            if (player.videoElement) {
                 console.log(`ObserverJS: Auto-connecting to preview for ${player.nickname}`);
                connectToPlayerStream(player.webcamId, player.nickname, player.videoElement);
            } else {
                console.error(`ObserverJS: videoElement for ${player.nickname} is null immediately after creation.`);
            }
        } else {
            // Элемент уже существует, возможно, обновить имя, если оно могло измениться
             const h3 = playerCamItem.querySelector('h3');
             if (h3 && h3.textContent !== player.nickname) h3.textContent = player.nickname;
             // Если соединение для превью уже есть и работает, не пересоздаем
             if (player.videoElement && player.peerConnection && player.peerConnection.connectionState === 'connected') {
                // console.log(`ObserverJS: Preview for ${player.nickname} already connected.`);
             } else if (player.videoElement && (!player.peerConnection || player.peerConnection.connectionState === 'closed' || player.peerConnection.connectionState === 'failed')) {
                console.log(`ObserverJS: Re-connecting preview for ${player.nickname} (state: ${player.peerConnection?.connectionState})`);
                connectToPlayerStream(player.webcamId, player.nickname, player.videoElement);
             }
        }
    });
}


socket.on('current_players', (playersData) => {
    console.log('ObserverJS: Received current_players:', playersData);
    playersData.forEach(p => {
        if (p.nickname) {
            activePlayers[p.nickname] = { ...activePlayers[p.nickname], ...p }; // Объединяем, чтобы не потерять videoElement/peerConnection
        }
    });
    updatePlayerListAndWebcams();
});

socket.on('player_update', (playerData) => {
    console.log('ObserverJS: Received player_update:', playerData);
    if (playerData.nickname) {
        activePlayers[playerData.nickname] = { ...activePlayers[playerData.nickname], ...playerData };
    }
    updatePlayerListAndWebcams();
    
    if (spectatingNicknameEl.textContent === playerData.nickname && playerData.webcamId && 
        currentSpectatedWebcamId !== playerData.webcamId && spectatorVideoEl) {
        console.log(`ObserverJS: Spectated player ${playerData.nickname} updated with webcamId, connecting to main video.`);
        connectToPlayerStream(playerData.webcamId, playerData.nickname, spectatorVideoEl);
        currentSpectatedWebcamId = playerData.webcamId;
    }
});

socket.on('player_left', ({ nickname, webcamId }) => {
    console.log(`ObserverJS: Received player_left: ${nickname} (Webcam ID: ${webcamId})`);
    if (activePlayers[nickname]) {
        if (activePlayers[nickname].peerConnection) {
            console.log(`ObserverJS: Closing peer connection for left player ${nickname}`);
            activePlayers[nickname].peerConnection.close();
        }
        const playerCamItem = document.getElementById(`player-cam-item-${webcamId}`);
        if (playerCamItem) {
            console.log(`ObserverJS: Removing DOM elements for left player ${nickname}`);
            playerCamItem.remove();
        }
        delete activePlayers[nickname];
    }

    if (currentSpectatedWebcamId === webcamId && spectatorVideoEl) {
        spectatorVideoEl.srcObject = null;
        spectatingNicknameEl.textContent = 'N/A (Игрок вышел)';
        currentSpectatedWebcamId = null;
        console.log(`ObserverJS: Main spectated player ${nickname} left.`);
    }
});

socket.on('spectate_change', (data) => {
    const { steamID, nickname, webcamId } = data;
    console.log('ObserverJS: Received spectate_change:', data);

    if (!spectatorVideoEl) {
        console.error("ObserverJS: Cannot process spectate_change, main video element 'spectatorVideoEl' is missing.");
        return;
    }

    if (!webcamId) { // Если нет webcamId (например, свободная камера)
        spectatingNicknameEl.textContent = nickname || 'Свободная камера/Нет цели';
        spectatingSteamIDEl.textContent = steamID || 'N/A';
        if (spectatorVideoEl.linkedPeerConnection) {
             console.log(`ObserverJS: Spectate change to no target, closing main video PC.`);
             spectatorVideoEl.linkedPeerConnection.close();
             // spectatorVideoEl.linkedPeerConnection = null; // Разрываем связь
        }
        spectatorVideoEl.srcObject = null;
        currentSpectatedWebcamId = null;
        return;
    }

    // Если уже смотрим этого игрока и соединение активно
    if (currentSpectatedWebcamId === webcamId && spectatorVideoEl.srcObject && 
        spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState === 'connected') {
        console.log(`ObserverJS: Already spectating ${nickname} (Webcam ID: ${webcamId}) and connected.`);
        spectatingNicknameEl.textContent = nickname; // На случай если только имя изменилось
        spectatingSteamIDEl.textContent = steamID || 'N/A';
        return;
    }
    
    console.log(`ObserverJS: Spectate change requires switching main video to ${nickname} (Webcam ID: ${webcamId})`);
    spectatingNicknameEl.textContent = `${nickname} (Подключение...)`;
    spectatingSteamIDEl.textContent = steamID || 'N/A';
    connectToPlayerStream(webcamId, nickname, spectatorVideoEl);
    currentSpectatedWebcamId = webcamId;
});

async function connectToPlayerStream(targetPlayerWebcamId, playerName, videoElement) {
    if (!videoElement) {
        console.error(`ObserverJS: Attempt to connect stream for ${playerName} (Webcam: ${targetPlayerWebcamId}), but videoElement is null.`);
        return;
    }
    console.log(`ObserverJS: connectToPlayerStream called for player ${playerName} (Webcam ID: ${targetPlayerWebcamId}) on video element ${videoElement.id}`);

    if (!targetPlayerWebcamId) {
        console.warn(`ObserverJS: No targetPlayerWebcamId for player ${playerName}. Cannot connect stream to ${videoElement.id}.`);
        videoElement.srcObject = null;
        return;
    }

    // Закрываем предыдущее соединение для этого videoElement, если оно есть и не закрыто
    if (videoElement.linkedPeerConnection && videoElement.linkedPeerConnection.connectionState !== 'closed') {
        console.log(`ObserverJS: Closing existing peer connection for video element ${videoElement.id} (state: ${videoElement.linkedPeerConnection.connectionState})`);
        videoElement.linkedPeerConnection.close();
    }
    
    console.log(`ObserverJS: Creating new RTCPeerConnection for player ${playerName} (Webcam ID: ${targetPlayerWebcamId}) on ${videoElement.id}`);
    const pc = new RTCPeerConnection(pcConfig);
    videoElement.linkedPeerConnection = pc; // Связываем PC с этим конкретным видео элементом

    // Обновляем ссылку на PC в activePlayers, если это превью
    if (videoElement.id !== 'spectatorVideo') {
        const playerRef = Object.values(activePlayers).find(p => p.webcamId === targetPlayerWebcamId);
        if (playerRef) {
            playerRef.peerConnection = pc;
        }
    }

    pc.onicecandidate = event => {
        if (event.candidate) {
            console.log(`ObserverJS: Sending ICE candidate to player ${targetPlayerWebcamId} from ${observerSessionId}:`, event.candidate);
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                targetId: targetPlayerWebcamId,
                isTargetPlayer: true, // Цель - игрок
                senderId: observerSessionId
            });
        } else {
            console.log(`ObserverJS: All ICE candidates sent for player ${targetPlayerWebcamId} on ${videoElement.id}.`);
        }
    };

    pc.ontrack = event => {
        console.log(`ObserverJS: Track RECEIVED from player ${playerName} (Webcam ID: ${targetPlayerWebcamId}) for video element ${videoElement.id}:`, event.track);
        console.log(`ObserverJS: Streams associated with track:`, event.streams);
        if (event.streams && event.streams[0]) {
            if (videoElement.srcObject !== event.streams[0]) {
                videoElement.srcObject = event.streams[0];
                console.log(`ObserverJS: Assigned stream from ${playerName} to video element ${videoElement.id}`);
                videoElement.play().catch(e => console.error(`ObserverJS: Error playing video for ${playerName} on ${videoElement.id}:`, e));
            }
        } else {
            console.warn(`ObserverJS: Track event for ${playerName} on ${videoElement.id} did not contain streams[0].`);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ObserverJS: ICE connection state with player ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id}: ${pc.iceConnectionState}`);
        if (videoElement === spectatorVideoEl && pc.iceConnectionState === 'connected') {
            spectatingNicknameEl.textContent = `${playerName} (Подключено)`;
        }
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
            console.log(`ObserverJS: Connection to ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id} failed/closed/disconnected.`);
            if (videoElement.linkedPeerConnection === pc) { // Только если это всё ещё текущее соединение для этого элемента
                 if (videoElement.srcObject) videoElement.srcObject = null; // Очищаем видео, если оно было
                 // videoElement.linkedPeerConnection = null; // Разрываем связь только если мы не собираемся переподключаться
                if (videoElement === spectatorVideoEl && currentSpectatedWebcamId === targetPlayerWebcamId) {
                    spectatingNicknameEl.textContent = `${playerName} (Отключено)`;
                    // currentSpectatedWebcamId = null; // Не сбрасываем, чтобы попытаться переключиться при GSI
                }
            }
        }
    };
    pc.onsignalingstatechange = () => {
        console.log(`ObserverJS: Signaling state with player ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id}: ${pc.signalingState}`);
    };
     pc.onconnectionstatechange = () => {
        console.log(`ObserverJS: Connection state with player ${playerName} (${targetPlayerWebcamId}) for ${videoElement.id}: ${pc.connectionState}`);
        if (videoElement === spectatorVideoEl && pc.connectionState === 'connected') {
            spectatingNicknameEl.textContent = `${playerName} (Подключено)`;
        } else if (videoElement === spectatorVideoEl && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed')) {
            if (currentSpectatedWebcamId === targetPlayerWebcamId) { // Если это все еще активный спектатор
                 spectatingNicknameEl.textContent = `${playerName} (${pc.connectionState})`;
            }
        }
    };

    // Зритель хочет ПОЛУЧАТЬ медиа
    console.log(`ObserverJS: Adding transceivers to PC for player ${playerName} on ${videoElement.id}`);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    try {
        console.log(`ObserverJS: Creating offer for player ${playerName} (Webcam ID: ${targetPlayerWebcamId}) on ${videoElement.id}`);
        const offer = await pc.createOffer();
        console.log(`ObserverJS: Setting local description (offer) for player ${playerName} on ${videoElement.id}`);
        await pc.setLocalDescription(offer);

        console.log(`ObserverJS: Sending WebRTC offer to player ${playerName} (Webcam ID: ${targetPlayerWebcamId}) from ${observerSessionId}:`, offer);
        socket.emit('webrtc_offer', {
            offer: offer,
            targetWebcamId: targetPlayerWebcamId,
            senderWebcamId: observerSessionId
        });
    } catch (e) {
        console.error(`ObserverJS: Error creating/sending offer to player ${playerName} on ${videoElement.id}:`, e);
        if (videoElement === spectatorVideoEl) spectatingNicknameEl.textContent = `${playerName} (Ошибка оффера)`;
    }
}

socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => {
    if (viewerWebcamId !== observerSessionId) return; // Ответ не для этой сессии обсервера

    console.log(`ObserverJS: Received WebRTC answer from player ${playerWebcamId}:`, answer);
    
    let targetPC = null;
    // Ищем PC, соответствующий этому ответу
    if (currentSpectatedWebcamId === playerWebcamId && spectatorVideoEl.linkedPeerConnection && 
        (spectatorVideoEl.linkedPeerConnection.signalingState === 'have-local-offer' || spectatorVideoEl.linkedPeerConnection.signalingState === 'stable')) {
        targetPC = spectatorVideoEl.linkedPeerConnection;
        console.log(`ObserverJS: Answer is for main video feed from ${playerWebcamId}.`);
    } else {
        const playerEntry = Object.values(activePlayers).find(p => p.webcamId === playerWebcamId);
        if (playerEntry && playerEntry.peerConnection && 
            (playerEntry.peerConnection.signalingState === 'have-local-offer' || playerEntry.peerConnection.signalingState === 'stable')) {
            targetPC = playerEntry.peerConnection;
            console.log(`ObserverJS: Answer is for preview video feed from ${playerWebcamId}.`);
        }
    }

    if (targetPC) {
        try {
            console.log(`ObserverJS: Setting remote description (answer) from player ${playerWebcamId}. Current signaling state: ${targetPC.signalingState}`);
            await targetPC.setRemoteDescription(new RTCSessionDescription(answer));
            console.log(`ObserverJS: Remote description (answer) from player ${playerWebcamId} set successfully.`);
        } catch (e) {
            console.error(`ObserverJS: Error setting remote description (answer) from player ${playerWebcamId}:`, e);
        }
    } else {
         console.warn(`ObserverJS: Received answer from player ${playerWebcamId}, but no matching RTCPeerConnection found or it's in an unexpected state.`);
    }
});

// Получение ICE кандидатов от ИГРОКА (отправленных через сервер)
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => {
    // forTargetId - это ID сессии обсервера (observerSessionId)
    // iceSenderId - это webcamId игрока, который отправил этот кандидат

    if (forTargetId !== observerSessionId) {
        // Этот кандидат не для текущей сессии обсервера
        return;
    }

    console.log(`ObserverJS: Received ICE candidate from player ${iceSenderId} for my session ${observerSessionId}:`, candidate);

    let targetPC = null;
    if (currentSpectatedWebcamId === iceSenderId && spectatorVideoEl.linkedPeerConnection) {
        targetPC = spectatorVideoEl.linkedPeerConnection;
    } else {
        const playerSendingCandidate = Object.values(activePlayers).find(p => p.webcamId === iceSenderId);
        if (playerSendingCandidate && playerSendingCandidate.peerConnection) {
            targetPC = playerSendingCandidate.peerConnection;
        }
    }

    if (targetPC && candidate) {
        try {
            await targetPC.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`ObserverJS: Added ICE candidate from player ${iceSenderId}.`);
        } catch (e) {
            console.error(`ObserverJS: Error adding ICE candidate from player ${iceSenderId}:`, e);
        }
    } else {
        console.warn(`ObserverJS: Received ICE from player ${iceSenderId}, but no active PeerConnection or no candidate data.`);
    }
});

socket.on('webrtc_error', (data) => {
    console.error('ObserverJS: Received webrtc_error from server:', data);
    // Можно отобразить ошибку пользователю, если это касается основного видео
    if (data.targetWebcamId === currentSpectatedWebcamId && spectatorVideoEl) {
        spectatingNicknameEl.textContent = `${spectatingNicknameEl.textContent} (Ошибка: ${data.message})`;
    }
});