// public/js/observerfull.js
const socket = io();
const videoElement = document.getElementById('observerFullVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder'); // Хотя он не будет видимым, ссылка может остаться

let currentPeerConnection = null;
let currentWebcamId = null; // webcamId игрока, к которому пытаемся подключиться
const observerSessionId = 'obs-full-' + Math.random().toString(36).substring(2, 9);

console.log('ObserverFullJS: Initialized. Session ID:', observerSessionId);

if (!videoElement) {
    console.error("ObserverFullJS: CRITICAL - Video element 'observerFullVideo' not found!");
}

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function showTransparentPage() {
    console.log('ObserverFullJS: Showing transparent page.');
    if (videoElement) {
        videoElement.style.display = 'none';
        videoElement.srcObject = null; // Убираем источник, чтобы остановить видео и очистить ресурсы
    }
    if (videoPlaceholder) { // На всякий случай, если он был бы видим
        videoPlaceholder.style.display = 'none';
    }
}

function showVideoElement() {
    console.log('ObserverFullJS: Showing video element.');
    if (videoPlaceholder) {
        videoPlaceholder.style.display = 'none';
    }
    if (videoElement) {
        videoElement.style.display = 'block';
    }
}

async function connectToPlayerStream(targetPlayerWebcamId, playerName, showWebcamPreference = true) {
    console.log(`ObserverFullJS: Attempting to connect to ${playerName} (Webcam: ${targetPlayerWebcamId}), ShowPref: ${showWebcamPreference}`);
    
    if (currentPeerConnection && currentPeerConnection.connectionState !== 'closed') {
        console.log(`ObserverFullJS: Closing existing peer connection (state: ${currentPeerConnection.connectionState})`);
        currentPeerConnection.close();
    }
    currentPeerConnection = null;
    
    // Сначала всегда делаем страницу прозрачной перед новой попыткой
    showTransparentPage(); 

    if (!targetPlayerWebcamId) {
        console.log("ObserverFullJS: No target webcam ID. Page remains transparent.");
        currentWebcamId = null;
        return;
    }

    currentWebcamId = targetPlayerWebcamId; // Запоминаем, к кому пытаемся подключиться

    if (!showWebcamPreference) {
        console.log(`ObserverFullJS: Webcam for ${playerName} is set to not show. Page remains transparent.`);
        // Ничего не показываем, страница уже прозрачная
        return;
    }
    
    // Если должны показать камеру, готовим видео элемент (он еще невидимый, пока нет потока)
    // showVideoElement(); // Пока не показываем, пока нет потока

    console.log(`ObserverFullJS: Creating new RTCPeerConnection for player ${playerName}`);
    const pc = new RTCPeerConnection(pcConfig);
    currentPeerConnection = pc;

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
                console.log(`ObserverFullJS: Stream assigned and playing for ${playerName}`);
                showVideoElement(); // Показываем видео, так как поток пришел
            }
        } else {
            console.warn(`ObserverFullJS: Track event for ${playerName} did not contain streams[0]. Page remains transparent.`);
            showTransparentPage();
        }
    };

    pc.oniceconnectionstatechange = () => {
        const iceState = pc.iceConnectionState;
        console.log(`ObserverFullJS: ICE state with ${playerName}: ${iceState}`);
        if (iceState === 'failed' || iceState === 'disconnected' || iceState === 'closed') {
             if (currentWebcamId === targetPlayerWebcamId) { // Если это все еще актуальный игрок
                console.log(`ObserverFullJS: ICE connection with ${playerName} is ${iceState}. Page becomes transparent.`);
                showTransparentPage();
            }
        }
    };
    pc.onsignalingstatechange = () => console.log(`ObserverFullJS: Signaling state with ${playerName}: ${pc.signalingState}`);
    pc.onconnectionstatechange = () => {
        const connState = pc.connectionState;
        console.log(`ObserverFullJS: Connection state with ${playerName}: ${connState}`);
        if (connState === 'failed' || connState === 'disconnected' || connState === 'closed') {
            if (currentWebcamId === targetPlayerWebcamId) {
                console.log(`ObserverFullJS: Connection with ${playerName} is ${connState}. Page becomes transparent.`);
                showTransparentPage();
            }
        } else if (connState === 'connected') {
            // Видео должно было уже показаться через ontrack, но на всякий случай
            if (videoElement.srcObject) { // Убедимся, что поток есть
                 console.log(`ObserverFullJS: Connection with ${playerName} established. Ensuring video is visible.`);
                showVideoElement();
            }
        }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' }); // Можно убрать, если звук не нужен

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: observerSessionId });
    } catch (e) {
        console.error(`ObserverFullJS: Error creating/sending offer to ${playerName}:`, e);
        showTransparentPage(); // Ошибка при создании оффера - показываем прозрачность
    }
}

socket.on('spectate_change', (data) => {
    // Ожидаем, что сервер будет присылать showWebcam измененным в server.js (как в полном коде #43)
    const { nickname, webcamId, showWebcam } = data; 
    console.log('ObserverFullJS: Received spectate_change:', data);
    
    if (!webcamId) { // Если GSI обсервер никого не смотрит
        connectToPlayerStream(null, 'N/A');
    } else {
        // showWebcam должно приходить от сервера, если нет - считаем true для обратной совместимости
        connectToPlayerStream(webcamId, nickname, showWebcam === undefined ? true : showWebcam);
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
    if (candidate) {
        try { await currentPeerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (e) { console.error(`ObserverFullJS: Error adding ICE from ${iceSenderId}:`, e); }
    }
});

socket.on('connect', () => {
    console.log('ObserverFullJS: Connected to socket server.');
    showTransparentPage(); // При подключении по умолчанию прозрачно, ждем spectate_change
});

socket.on('disconnect', () => {
    console.log('ObserverFullJS: Disconnected from socket server.');
    showTransparentPage();
});