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
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

async function populateWebcamList() {
    console.log('PlayerJS: populateWebcamList called');
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        console.log('PlayerJS: Media devices enumerated:', devices);
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        webcamSelect.innerHTML = videoDevices
            .map(device => `<option value="${device.deviceId}">${device.label || `Камера ${webcamSelect.options.length + 1}`}</option>`) // ИСПРАВЛЕННАЯ СТРОКА
            .join('');
        if (videoDevices.length > 0) {
            await startPreview(videoDevices[0].deviceId);
        } else {
            statusEl.textContent = 'Веб-камеры не найдены.';
            console.warn('PlayerJS: No video input devices found.');
        }
    } catch (e) {
        statusEl.textContent = 'Ошибка доступа к устройствам: ' + e.message;
        console.error('PlayerJS: Error enumerating devices:', e);
    }
}

async function startPreview(deviceId) {
    console.log(`PlayerJS: startPreview called for deviceId: ${deviceId}`);
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        console.log('PlayerJS: Stopped previous local stream tracks.');
    }
    const constraints = {
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true
    };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('PlayerJS: Local stream obtained:', localStream);
        if (localStream.getVideoTracks().length > 0) {
            console.log('PlayerJS: Video track present:', localStream.getVideoTracks()[0]);
        }
        if (localStream.getAudioTracks().length > 0) {
            console.log('PlayerJS: Audio track present:', localStream.getAudioTracks()[0]);
        }
        localVideo.srcObject = localStream;
        statusEl.textContent = 'Предпросмотр камеры активен.';
    } catch (e) {
        statusEl.textContent = 'Ошибка доступа к веб-камере: ' + e.message;
        console.error('PlayerJS: Error accessing webcam (getUserMedia):', e);
        localStream = null; // Убедимся, что localStream null, если была ошибка
    }
}

webcamSelect.onchange = () => {
    console.log('PlayerJS: Webcam selection changed to:', webcamSelect.value);
    startPreview(webcamSelect.value);
};

startStreamBtn.onclick = () => {
    console.log('PlayerJS: "Начать Трансляцию" button clicked.');
    const nickname = nicknameInput.value.trim();
    const steamID = steamIDInput.value.trim();
    if (!nickname) {
        statusEl.textContent = 'Пожалуйста, введите никнейм.';
        return;
    }
    if (!localStream) {
        statusEl.textContent = 'Веб-камера не активна или не выбрана. Попробуйте выбрать камеру из списка.';
        console.warn('PlayerJS: Start stream attempt but localStream is null.');
        return;
    }
    if (localStream.getTracks().length === 0) {
        statusEl.textContent = 'В потоке с веб-камеры нет треков. Возможно, доступ не был предоставлен.';
        console.warn('PlayerJS: localStream has no tracks.');
        return;
    }


    console.log(`PlayerJS: Emitting 'register_player' with nickname: ${nickname}, webcamId: ${myUniqueWebcamId}, steamID: ${steamID}`);
    socket.emit('register_player', { nickname, webcamId: myUniqueWebcamId, steamID });
    startStreamBtn.disabled = true;
    nicknameInput.disabled = true;
    steamIDInput.disabled = true;
    statusEl.textContent = `Регистрация как ${nickname}...`;
};

socket.on('registration_success', (data) => {
    console.log('PlayerJS: Registration success:', data);
    statusEl.textContent = `Вы зарегистрированы как ${data.nickname} (ID: ${data.webcamId}). Ожидание зрителей...`;
});

socket.on('registration_error', (message) => {
    console.error('PlayerJS: Registration Error:', message);
    statusEl.textContent = `Ошибка регистрации: ${message}`;
    startStreamBtn.disabled = false;
    nicknameInput.disabled = false;
    steamIDInput.disabled = false;
});

socket.on('webrtc_offer_from_viewer', async ({ offer, viewerWebcamId }) => {
    console.log(`PlayerJS: Received WebRTC offer from viewer ${viewerWebcamId}`, offer);
    if (!localStream) {
        console.error("PlayerJS: localStream not available to send when offer received.");
        return;
    }

    console.log(`PlayerJS: Creating RTCPeerConnection for viewer ${viewerWebcamId}`);
    const pc = new RTCPeerConnection(pcConfig);
    peerConnections[viewerWebcamId] = pc;

    pc.onicecandidate = event => {
        if (event.candidate) {
            console.log(`PlayerJS: Sending ICE candidate to viewer ${viewerWebcamId}:`, event.candidate);
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                targetId: viewerWebcamId,
                isTargetPlayer: false, // Цель - зритель
                senderId: myUniqueWebcamId
            });
        } else {
            console.log(`PlayerJS: All ICE candidates sent for viewer ${viewerWebcamId}.`);
        }
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log(`PlayerJS: ICE connection state with viewer ${viewerWebcamId}: ${pc.iceConnectionState}`);
         if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
            if (peerConnections[viewerWebcamId]) {
                peerConnections[viewerWebcamId].close();
                delete peerConnections[viewerWebcamId];
                console.log(`PlayerJS: Connection with viewer ${viewerWebcamId} closed/failed.`);
            }
        }
    };
    pc.onsignalingstatechange = () => {
        console.log(`PlayerJS: Signaling state with viewer ${viewerWebcamId}: ${pc.signalingState}`);
    };
    pc.onconnectionstatechange = () => {
        console.log(`PlayerJS: Connection state with viewer ${viewerWebcamId}: ${pc.connectionState}`);
    };

    try {
        if (localStream && localStream.getTracks().length > 0) {
            localStream.getTracks().forEach(track => {
                console.log(`PlayerJS: Adding track to PC for viewer ${viewerWebcamId}:`, track);
                pc.addTrack(track, localStream);
            });
        } else {
            console.error('PlayerJS: localStream is null or has no tracks when trying to add tracks for offer.');
            // Можно попробовать создать оффер без треков, если это допустимо (обычно нет для видео)
            // или просто вернуть ошибку / не продолжать.
            return;
        }

        console.log(`PlayerJS: Setting remote description (offer) from viewer ${viewerWebcamId}`);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        console.log(`PlayerJS: Creating answer for viewer ${viewerWebcamId}`);
        const answer = await pc.createAnswer();
        console.log(`PlayerJS: Setting local description (answer) for viewer ${viewerWebcamId}`);
        await pc.setLocalDescription(answer);

        console.log(`PlayerJS: Sending WebRTC answer to viewer ${viewerWebcamId}:`, answer);
        socket.emit('webrtc_answer', {
            answer: answer,
            targetViewerWebcamId: viewerWebcamId,
            senderPlayerWebcamId: myUniqueWebcamId
        });
    } catch (e) {
        console.error(`PlayerJS: Error handling offer or creating/sending answer for viewer ${viewerWebcamId}:`, e);
    }
});

socket.on('webrtc_ice_candidate_from_peer', async ({ candidate, iceSenderId }) => {
    // iceSenderId это viewerWebcamId
    const viewerWebcamId = iceSenderId;
    console.log(`PlayerJS: Received ICE candidate from viewer ${viewerWebcamId}:`, candidate);

    if (peerConnections[viewerWebcamId] && candidate) {
         try {
             await peerConnections[viewerWebcamId].addIceCandidate(new RTCIceCandidate(candidate));
             console.log(`PlayerJS: Added ICE candidate from viewer ${viewerWebcamId}.`);
         } catch (e) {
             console.error(`PlayerJS: Error adding ICE candidate from viewer ${viewerWebcamId}:`, e);
         }
    } else {
        console.warn(`PlayerJS: Received ICE candidate but no PC for viewer ${viewerWebcamId} or no candidate data.`);
    }
});

populateWebcamList();
console.log('PlayerJS: Initialized. My webcam ID:', myUniqueWebcamId);