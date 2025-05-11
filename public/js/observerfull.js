// public/js/observerfull.js
const socket = io();
const videoElement = document.getElementById('observerFullVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');

let currentPeerConnection = null;
let currentWebcamId = null;
const observerSessionId = 'obs-full-' + Math.random().toString(36).substring(2, 9);

console.log('ObserverFullJS: Initialized. Session ID:', observerSessionId);

if (!videoElement) {
    console.error("ObserverFullJS: CRITICAL - Video element 'observerFullVideo' not found!");
}

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function showPlaceholder(message) {
    if (videoElement) videoElement.style.display = 'none';
    if (videoPlaceholder) {
        videoPlaceholder.textContent = message || 'Нет сигнала / Камера отключена';
        videoPlaceholder.style.display = 'flex';
    }
}

function showVideo() {
    if (videoPlaceholder) videoPlaceholder.style.display = 'none';
    if (videoElement) videoElement.style.display = 'block';
}

async function connectToPlayerStream(targetPlayerWebcamId, playerName, showWebcamPreference = true) {
    console.log(`ObserverFullJS: Attempting to connect to ${playerName} (Webcam: ${targetPlayerWebcamId}), ShowPref: ${showWebcamPreference}`);
    
    if (currentPeerConnection && currentPeerConnection.connectionState !== 'closed') {
        console.log(`ObserverFullJS: Closing existing peer connection (state: ${currentPeerConnection.connectionState})`);
        currentPeerConnection.close();
    }
    currentPeerConnection = null;
    videoElement.srcObject = null; // Очищаем предыдущий поток

    if (!targetPlayerWebcamId) {
        console.log("ObserverFullJS: No target webcam ID to connect to.");
        showPlaceholder('Нет цели для отображения');
        currentWebcamId = null;
        return;
    }

    // Проверяем "галочку" (предполагается, что сервер пришлет эту информацию)
    if (!showWebcamPreference) {
        console.log(`ObserverFullJS: Webcam for ${playerName} is set to not show. Displaying placeholder.`);
        showPlaceholder(`Камера игрока ${playerName} отключена`);
        currentWebcamId = targetPlayerWebcamId; // Запоминаем, на кого смотрим, даже если камера не показана
        return;
    }
    
    showVideo(); // Показываем видео элемент, скрываем плейсхолдер

    console.log(`ObserverFullJS: Creating new RTCPeerConnection for player ${playerName}`);
    const pc = new RTCPeerConnection(pcConfig);
    currentPeerConnection = pc;
    currentWebcamId = targetPlayerWebcamId;

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', { candidate: event.candidate, targetId: targetPlayerWebcamId, isTargetPlayer: true, senderId: observerSessionId });
        }
    };

    pc.ontrack = event => {
        console.log(`ObserverFullJS: Track RECEIVED from ${playerName}`, event.track);
        if (event.streams && event.streams[0]) {
            if (videoElement.srcObject !== event.streams[0]) {
                videoElement.srcObject = event.streams[0];
                videoElement.play().catch(e => console.error(`ObserverFullJS: Error playing video for ${playerName}:`, e));
                console.log(`ObserverFullJS: Stream assigned for ${playerName}`);
                showVideo();
            }
        } else {
            console.warn(`ObserverFullJS: Track event for ${playerName} did not contain streams[0].`);
            showPlaceholder(`Ошибка потока от ${playerName}`);
        }
    };

    pc.oniceconnectionstatechange = () => console.log(`ObserverFullJS: ICE state with ${playerName}: ${pc.iceConnectionState}`);
    pc.onsignalingstatechange = () => console.log(`ObserverFullJS: Signaling state with ${playerName}: ${pc.signalingState}`);
    pc.onconnectionstatechange = () => {
        console.log(`ObserverFullJS: Connection state with ${playerName}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
            if (currentWebcamId === targetPlayerWebcamId) { // Если это все еще актуальный игрок
                showPlaceholder(`Соединение с ${playerName} потеряно`);
            }
        } else if (pc.connectionState === 'connected') {
            showVideo();
        }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: observerSessionId });
    } catch (e) {
        console.error(`ObserverFullJS: Error creating/sending offer to ${playerName}:`, e);
        showPlaceholder(`Ошибка подключения к ${playerName}`);
    }
}

socket.on('spectate_change', (data) => {
    const { nickname, webcamId, showWebcam } = data; // Ожидаем, что сервер будет присылать showWebcam
    console.log('ObserverFullJS: Received spectate_change:', data);
    
    if (!webcamId) {
        connectToPlayerStream(null, 'N/A'); // Очистить видео, показать плейсхолдер "нет цели"
    } else {
        connectToPlayerStream(webcamId, nickname, showWebcam);
    }
});

socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => {
    if (viewerWebcamId !== observerSessionId || !currentPeerConnection || playerWebcamId !== currentWebcamId) return;
    console.log(`ObserverFullJS: Received answer from player ${playerWebcamId}`);
    if (currentPeerConnection.signalingState === 'have-local-offer' || currentPeerConnection.signalingState === 'stable') {
        try {
            await currentPeerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (e) { console.error(`ObserverFullJS: Error setting remote desc (answer) from ${playerWebcamId}:`, e); }
    } else { console.warn(`ObserverFullJS: Answer from ${playerWebcamId}, but PC signalingState is ${currentPeerConnection.signalingState}.`);}
});

socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => {
    if (forTargetId !== observerSessionId || !currentPeerConnection || iceSenderId !== currentWebcamId ) return;
    // console.log(`ObserverFullJS: Received ICE from player ${iceSenderId}`);
    if (candidate) {
        try { await currentPeerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (e) { console.error(`ObserverFullJS: Error adding ICE from ${iceSenderId}:`, e); }
    }
});

socket.on('connect', () => {
    console.log('ObserverFullJS: Connected to socket server.');
    // Можно запросить текущего наблюдаемого игрока, если сервер это поддерживает
    // socket.emit('request_current_spectator_info'); // Пример
});

socket.on('disconnect', () => {
    console.log('ObserverFullJS: Disconnected from socket server.');
    showPlaceholder('Нет соединения с сервером');
});