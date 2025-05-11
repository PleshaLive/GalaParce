// public/js/player.js
const socket = io();
const localVideo = document.getElementById('localVideoPreview');
const nicknameInput = document.getElementById('nickname');
const steamIDInput = document.getElementById('steamID');
const webcamSelect = document.getElementById('webcamSelect');
const startStreamBtn = document.getElementById('startStreamBtn');
const statusEl = document.getElementById('status');

let localStream;
let myUniqueWebcamId = 'player-' + Math.random().toString(36).substring(2, 9);
let peerConnections = {}; // { viewerWebcamId: RTCPeerConnection }

const pcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] // Google STUN сервер
};

async function populateWebcamList() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        webcamSelect.innerHTML = videoDevices
            .map(device => `<option value="${device.deviceId}">${device.label || `Камера ${webcamSelect.options.length + 1}`}</option>`) // ИСПРАВЛЕННАЯ СТРОКА
            .join('');
        if (videoDevices.length > 0) {
            await startPreview(videoDevices[0].deviceId);
        }
    } catch (e) {
        statusEl.textContent = 'Ошибка доступа к устройствам: ' + e.message;
        console.error(e);
    }
}

async function startPreview(deviceId) {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    const constraints = {
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true // Можно добавить аудио
    };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
        statusEl.textContent = 'Предпросмотр камеры активен.';
    } catch (e) {
        statusEl.textContent = 'Ошибка доступа к веб-камере: ' + e.message;
        console.error(e);
    }
}

webcamSelect.onchange = () => startPreview(webcamSelect.value);

startStreamBtn.onclick = () => {
    const nickname = nicknameInput.value.trim();
    const steamID = steamIDInput.value.trim();
    if (!nickname) {
        statusEl.textContent = 'Пожалуйста, введите никнейм.';
        return;
    }
    if (!localStream) {
        statusEl.textContent = 'Веб-камера не активна.';
        return;
    }

    socket.emit('register_player', { nickname, webcamId: myUniqueWebcamId, steamID });
    startStreamBtn.disabled = true;
    nicknameInput.disabled = true;
    steamIDInput.disabled = true;
    statusEl.textContent = `Регистрация как ${nickname}...`;
};

socket.on('registration_success', (data) => {
    statusEl.textContent = `Вы зарегистрированы как ${data.nickname} (ID: ${data.webcamId}). Ожидание зрителей...`;
});

socket.on('registration_error', (message) => {
    statusEl.textContent = `Ошибка регистрации: ${message}`;
    startStreamBtn.disabled = false;
    nicknameInput.disabled = false;
    steamIDInput.disabled = false;
});

socket.on('webrtc_offer_from_viewer', async ({ offer, viewerWebcamId }) => {
    console.log(`Получен WebRTC offer от зрителя ${viewerWebcamId}`);
    if (!localStream) {
        console.error("Локальный поток недоступен для отправки.");
        return;
    }

    const pc = new RTCPeerConnection(pcConfig);
    peerConnections[viewerWebcamId] = pc;

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = event => {
        if (event.candidate) {
            console.log(`Отправка ICE candidate зрителю ${viewerWebcamId}`);
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                targetId: viewerWebcamId,
                isTargetPlayer: false
            });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`Player's ICE state with ${viewerWebcamId}: ${pc.iceConnectionState}`);
         if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
            if (peerConnections[viewerWebcamId]) {
                peerConnections[viewerWebcamId].close();
                delete peerConnections[viewerWebcamId];
                console.log(`Соединение с ${viewerWebcamId} закрыто/оборвано.`);
            }
        }
    };

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log(`Отправка WebRTC answer зрителю ${viewerWebcamId}`);
        socket.emit('webrtc_answer', {
            answer: answer,
            targetViewerWebcamId: viewerWebcamId,
            senderPlayerWebcamId: myUniqueWebcamId
        });
    } catch (e) {
        console.error('Ошибка при создании/отправке answer:', e);
    }
});

socket.on('webrtc_ice_candidate_from_peer', async ({ candidate, forTargetId, senderWebcamId }) => {
    if (forTargetId === myUniqueWebcamId && peerConnections[senderWebcamId]) {
         try {
             console.log(`Игрок ${myUniqueWebcamId} получил ICE candidate от зрителя ${senderWebcamId}`);
             await peerConnections[senderWebcamId].addIceCandidate(new RTCIceCandidate(candidate));
         } catch (e) {
             console.error('Ошибка добавления ICE candidate от зрителя:', e);
         }
    } else if (peerConnections[forTargetId]) {
         try {
             console.log(`Игрок ${myUniqueWebcamId} получил ICE candidate (вероятно, свой собственный через сервер) для зрителя ${forTargetId}`);
             await peerConnections[forTargetId].addIceCandidate(new RTCIceCandidate(candidate));
         } catch (e) {
             console.error('Ошибка добавления ICE candidate (отраженный):', e);
         }
    }
});

populateWebcamList();