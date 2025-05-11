const socket = io();
const spectatorVideoEl = document.getElementById('spectatorVideo');
const spectatingNicknameEl = document.getElementById('spectatingNickname');
const spectatingSteamIDEl = document.getElementById('spectatingSteamID');
const playerWebcamsContainer = document.getElementById('playerWebcamsContainer');

let activePlayers = {}; // { nickname: { webcamId: '...', steamID: '...', videoElement: null, peerConnection: null } }
let currentSpectatedWebcamId = null;
const observerSessionId = 'obs-' + Math.random().toString(36).substring(2, 9); // Уникальный ID для этой сессии обсервера

const pcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function updatePlayerListAndWebcams() {
    playerWebcamsContainer.innerHTML = ''; // Очищаем контейнер
    Object.values(activePlayers).forEach(player => {
        if (!player.webcamId) return;

        let container = document.getElementById(`player-cam-container-${player.webcamId}`);
        if (!container) {
            container = document.createElement('div');
            container.id = `player-cam-container-${player.webcamId}`;
            container.className = 'player-camera-item';
            container.innerHTML = `<h3><span class="math-inline">\{player\.nickname\}</h3\><video id\="video\-</span>{player.webcamId}" autoplay playsinline width="320" height="240"></video>`;
            playerWebcamsContainer.appendChild(container);
            player.videoElement = document.getElementById(`video-${player.webcamId}`);

            // Кнопка для переключения на эту камеру в основном окне
            const watchButton = document.createElement('button');
            watchButton.textContent = `Смотреть ${player.nickname}`;
            watchButton.onclick = () => {
                if (currentSpectatedWebcamId !== player.webcamId) {
                     connectToPlayerStream(player.webcamId, player.nickname, spectatorVideoEl); // В основное окно
                     currentSpectatedWebcamId = player.webcamId;
                     spectatingNicknameEl.textContent = player.nickname;
                     spectatingSteamIDEl.textContent = player.steamID || 'N/A';
                }
            };
            container.appendChild(watchButton);

            // Автоматически подключаемся к камере этого игрока для мини-превью
            connectToPlayerStream(player.webcamId, player.nickname, player.videoElement);
        }
    });
}


socket.on('current_players', (playersData) => {
    console.log('Текущие игроки:', playersData);
    playersData.forEach(p => {
        if (p.nickname) activePlayers[p.nickname] = { ...activePlayers[p.nickname], ...p };
    });
    updatePlayerListAndWebcams();
});

socket.on('player_update', (playerData) => {
    console.log('Обновление игрока:', playerData);
    if (playerData.nickname) {
        activePlayers[playerData.nickname] = { ...activePlayers[playerData.nickname], ...playerData };
    }
    updatePlayerListAndWebcams();
    // Если этот игрок сейчас наблюдается GSI, и у него появился webcamId, подключаемся
    if (spectatingNicknameEl.textContent === playerData.nickname && playerData.webcamId && currentSpectatedWebcamId !== playerData.webcamId) {
        connectToPlayerStream(playerData.webcamId, playerData.nickname, spectatorVideoEl);
        currentSpectatedWebcamId = playerData.webcamId;
    }
});

socket.on('player_left', ({ nickname, webcamId }) => {
    console.log('Игрок вышел:', nickname);
    if (activePlayers[nickname]?.peerConnection) {
        activePlayers[nickname].peerConnection.close();
    }
    const container = document.getElementById(`player-cam-container-${webcamId}`);
    if (container) container.remove();
    delete activePlayers[nickname];

    if (currentSpectatedWebcamId === webcamId) {
        spectatorVideoEl.srcObject = null;
        spectatingNicknameEl.textContent = 'N/A (Игрок вышел)';
        currentSpectatedWebcamId = null;
    }
});

socket.on('spectate_change', (data) => {
    const { steamID, nickname, webcamId } = data;
    console.log('GSI Spectate Change:', data);

    if (!webcamId) {
        spectatingNicknameEl.textContent = nickname || 'Свободная камера/Нет цели';
        spectatingSteamIDEl.textContent = steamID || 'N/A';
        if (currentSpectatedWebcamId && activePlayers[Object.keys(activePlayers).find(n => activePlayers[n].webcamId === currentSpectatedWebcamId)]?.peerConnection === spectatorVideoEl.linkedPeerConnection) {
             if(spectatorVideoEl.linkedPeerConnection) spectatorVideoEl.linkedPeerConnection.close();
             spectatorVideoEl.srcObject = null;
        }
        currentSpectatedWebcamId = null;
        return;
    }

    if (currentSpectatedWebcamId === webcamId && spectatorVideoEl.srcObject) {
        spectatingNicknameEl.textContent = nickname; // Обновить имя, если вдруг изменилось
        spectatingSteamIDEl.textContent = steamID || 'N/A';
        return; // Уже смотрим этого игрока
    }

    spectatingNicknameEl.textContent = `${nickname} (Подключение...)`;
    spectatingSteamIDEl.textContent = steamID || 'N/A';
    connectToPlayerStream(webcamId, nickname, spectatorVideoEl);
    currentSpectatedWebcamId = webcamId;
});

async function connectToPlayerStream(targetPlayerWebcamId, playerName, videoElement) {
    if (!targetPlayerWebcamId) {
        console.warn(`Нет webcamId для игрока ${playerName}`);
        if (videoElement) videoElement.srcObject = null;
        return;
    }

    // Если уже есть активное соединение для этого videoElement, закрываем его
    if (videoElement.linkedPeerConnection) {
        videoElement.linkedPeerConnection.close();
    }
    console.log(`Попытка подключения к ${playerName} (Webcam ID: ${targetPlayerWebcamId}) для элемента ${videoElement.id}`);

    const pc = new RTCPeerConnection(pcConfig);
    videoElement.linkedPeerConnection = pc; // Связываем PC с видео элементом

    let playerRef = Object.values(activePlayers).find(p => p.webcamId === targetPlayerWebcamId);
    if (playerRef) {
        playerRef.peerConnection = pc; // Также сохраняем в общем реестре
    }


    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                targetId: targetPlayerWebcamId, // ID игрока, которому отправляем
                isTargetPlayer: true // Цель - игрок
            });
        }
    };

    pc.ontrack = event => {
        console.log(`Трек получен от ${playerName} для ${videoElement.id}:`, event.streams[0]);
        if (videoElement.srcObject !== event.streams[0]) {
            videoElement.srcObject = event.streams[0];
            videoElement.play().catch(e => console.error("Ошибка воспроизведения видео:", e));
            if (videoElement === spectatorVideoEl) {
                spectatingNicknameEl.textContent = playerName; // Обновляем имя в главном окне
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`Observer's ICE state with <span class="math-inline">\{playerName\} \(</span>{targetPlayerWebcamId}) for ${videoElement.id}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
            if (videoElement.srcObject && videoElement.linkedPeerConnection === pc) { // Только если это всё ещё текущее соединение для этого элемента
                 videoElement.srcObject = null;
                 console.log(`Соединение с ${playerName} для ${videoElement.id} закрыто/оборвано.`);
            }
             if (videoElement.linkedPeerConnection === pc) videoElement.linkedPeerConnection = null; // Разрываем связь
             if (playerRef && playerRef.peerConnection === pc) playerRef.peerConnection = null;

             // Если это был основной поток, и он оборвался
             if (videoElement === spectatorVideoEl && currentSpectatedWebcamId === targetPlayerWebcamId) {
                currentSpectatedWebcamId = null;
                spectatingNicknameEl.textContent = `${playerName} (Отключено)`;
             }
        } else if (pc.iceConnectionState === 'connected' && videoElement === spectatorVideoEl) {
             spectatingNicknameEl.textContent = playerName; // Обновляем имя в главном окне
        }
    };

    // Зритель хочет ПОЛУЧАТЬ медиа
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        console.log(`Отправка WebRTC offer игроку ${playerName} (Webcam ID: ${targetPlayerWebcamId}) от ${observerSessionId}`);
        socket.emit('webrtc_offer', {
            offer: offer,
            targetWebcamId: targetPlayerWebcamId, // Кому (игроку)
            senderWebcamId: observerSessionId   // От кого (от этого клиента-обсервера)
        });
    } catch (e) {
        console.error(`Ошибка создания/отправки offer игроку ${playerName}:`, e);
         if (videoElement === spectatorVideoEl) spectatingNicknameEl.textContent = `${playerName} (Ошибка)`;
    }
}

// Получение ответа от игрока
socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => {
    if (viewerWebcamId !== observerSessionId) return; // Ответ не для этой сессии обсервера

    console.log(`Получен WebRTC answer от игрока ${playerWebcamId}`);

    // Найти правильный peerConnection. Это может быть основной или один из мини-превью.
    let targetPC = null;
    if (currentSpectatedWebcamId === playerWebcamId && spectatorVideoEl.linkedPeerConnection && 
        (spectatorVideoEl.linkedPeerConnection.signalingState === 'have-local-offer' || spectatorVideoEl.linkedPeerConnection.signalingState === 'stable' /* re-negotiation */)) {
        targetPC = spectatorVideoEl.linkedPeerConnection;
    } else {
        const playerEntry = Object.values(activePlayers).find(p => p.webcamId === playerWebcamId);
        if (playerEntry && playerEntry.peerConnection && (playerEntry.peerConnection.signalingState === 'have-local-offer' || playerEntry.peerConnection.signalingState === 'stable')) {
            targetPC = playerEntry.peerConnection;
        }
    }

    if (targetPC) {
        try {
            await targetPC.setRemoteDescription(new RTCSessionDescription(answer));
            console.log(`Remote description установлен для соединения с ${playerWebcamId}`);
        } catch (e) {
            console.error(`Ошибка установки remote description от ${playerWebcamId}:`, e);
        }
    } else {
         console.warn(`Получен answer от ${playerWebcamId}, но подходящий RTCPeerConnection не найден или в неверном состоянии.`);
    }
});

// Получение ICE кандидатов (от игрока или от себя через сервер)
socket.on('webrtc_ice_candidate_from_peer', async ({ candidate, forTargetId, senderWebcamId }) => {
    // Кандидат предназначен для этой сессии обсервера (observerSessionId)
    // senderWebcamId - это ID игрока, от которого пришел кандидат
    let targetPC = null;
    if (forTargetId === observerSessionId) { // Кандидат для меня от игрока senderWebcamId
        if (currentSpectatedWebcamId === senderWebcamId && spectatorVideoEl.linkedPeerConnection) {
            targetPC = spectatorVideoEl.linkedPeerConnection;
        } else {
             const playerEntry = Object.values(activePlayers).find(p => p.webcamId === senderWebcamId);
             if (playerEntry && playerEntry.peerConnection) targetPC = playerEntry.peerConnection;
        }
    }
    // Мой собственный кандидат, отраженный от сервера (isTargetPlayer=true, targetId=playerWebcamId)
    else {
         const playerIsTarget = Object.values(activePlayers).find(p => p.webcamId === forTargetId);
         if (playerIsTarget && playerIsTarget.peerConnection) {
            targetPC = playerIsTarget.peerConnection; // Кандидат для игрока forTargetId
         }
    }


    if (targetPC && candidate) {
        try {
            // console.log(`Обсервер ${observerSessionId} получил ICE candidate (от ${senderWebcamId} для ${forTargetId}). Добавление...`);
            await targetPC.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Ошибка добавления ICE candidate от peer:', e);
        }
    }
});


// Простая CSS для `public/css/style.css`
// body { font-family: Arial, sans-serif; margin: 15px; background-color: #282c34; color: #abb2bf; }
// h1, h2, h3 { color: #61afef; }
// input, select, button { padding: 10px; margin: 5px; border-radius: 4px; border: 1px solid #3b4048; background-color: #323840; color: #abb2bf; }
// button { cursor: pointer; background-color: #61afef; color: #282c34; }
// button:disabled { background-color: #4f5660; cursor: not-allowed; }
// video { border: 1px solid #61afef; background-color: #000; margin-bottom: 10px; }
// #playerWebcamsContainer { display: flex; flex-wrap: wrap; gap: 15px; margin-top: 20px; }
// .player-camera-item { border: 1px solid #4f5660; padding: 10px; border-radius: 5px; background-color: #323840; }
// #status { margin-top: 10px; font-style: italic; color: #e5c07b;}