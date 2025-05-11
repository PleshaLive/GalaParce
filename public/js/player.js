// public/js/player.js
const socket = io();
const localVideo = document.getElementById('localVideoPreview');
const nicknameSelect = document.getElementById('nicknameSelect');
const nicknameLoadingStatus = document.getElementById('nicknameLoadingStatus');
const steamIDInput = document.getElementById('steamID');
const webcamSelect = document.getElementById('webcamSelect');
const startStreamBtn = document.getElementById('startStreamBtn');
const statusEl = document.getElementById('status');

let localStream;
let myUniqueWebcamId = 'player-' + Math.random().toString(36).substring(2, 9);
let peerConnections = {}; 

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

socket.on('connect', () => {
    console.log('PlayerJS: Connected to socket. Requesting player setup data.');
    nicknameLoadingStatus.textContent = 'Запрос списка игроков...';
    startStreamBtn.disabled = true;
    socket.emit('request_player_setup_data');
});

socket.on('player_setup_data_available', (serverPlayers) => {
    console.log('PlayerJS: Received player_setup_data_available:', serverPlayers);
    nicknameSelect.innerHTML = '<option value="" disabled selected>-- Выберите ваш никнейм --</option>';
    let hasAvailablePlayers = false;

    if (serverPlayers && serverPlayers.length > 0) {
        serverPlayers.forEach(player => {
            const option = document.createElement('option');
            option.value = player.steamID || player.name; 
            option.textContent = player.name + (player.isRegistered ? ' (камера активна)' : '');
            option.disabled = player.isRegistered;
            option.dataset.steamid = player.steamID || '';
            option.dataset.name = player.name; 
            nicknameSelect.appendChild(option);
            if (!player.isRegistered) hasAvailablePlayers = true;
        });
        nicknameLoadingStatus.textContent = hasAvailablePlayers ? 'Выберите ваш никнейм.' : 'Все игроки из списка уже с камерами.';
    } else {
        nicknameLoadingStatus.textContent = 'На сервере нет игроков (по данным GSI) или все уже с камерами. Убедитесь, что CS2 с GSI запущена и вы в игре/наблюдаете.';
    }
    checkStartButtonState(); 
});

nicknameSelect.onchange = () => {
    const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex];
    if (selectedOption && selectedOption.dataset.steamid) {
        steamIDInput.value = selectedOption.dataset.steamid;
    } else {
        steamIDInput.value = '';
    }
    checkStartButtonState();
    if (selectedOption && selectedOption.disabled) {
        statusEl.textContent = "Этот игрок уже зарегистрировал веб-камеру.";
    } else {
        statusEl.textContent = ""; 
    }
};

function checkStartButtonState() {
    const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex];
    const isPlayerSelectedAndAvailable = selectedOption && selectedOption.value && !selectedOption.disabled;
    startStreamBtn.disabled = !(localStream && localStream.active && isPlayerSelectedAndAvailable);
}

async function populateWebcamList() {
    console.log('PlayerJS: populateWebcamList');
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        webcamSelect.innerHTML = videoDevices.map(d => `<option value="${d.deviceId}">${d.label||`Камера ${webcamSelect.options.length+1}`}</option>`).join('');
        if (videoDevices.length > 0) await startPreview(videoDevices[0].deviceId);
        else { statusEl.textContent = 'Веб-камеры не найдены.'; checkStartButtonState(); }
    } catch (e) { statusEl.textContent = 'Ошибка доступа к устройствам: '+e.message; console.error('PlayerJS: Enum devices error:', e); checkStartButtonState(); }
}

async function startPreview(deviceId) {
    console.log(`PlayerJS: startPreview for deviceId: ${deviceId}`);
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); }
    const constraints = { video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: {ideal:640}, height: {ideal:480} }, audio: true };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
        statusEl.textContent = 'Предпросмотр камеры активен.';
    } catch (e) {
        statusEl.textContent = 'Ошибка доступа к веб-камере: '+e.message; console.error('PlayerJS: getUserMedia error:',e); localStream = null;
    }
    checkStartButtonState();
}

webcamSelect.onchange = () => { console.log('PlayerJS: Webcam changed:', webcamSelect.value); startPreview(webcamSelect.value); };

startStreamBtn.onclick = () => {
    console.log('PlayerJS: Start Stream button clicked.');
    const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex];
    if (!selectedOption || !selectedOption.value || selectedOption.disabled) { statusEl.textContent = 'Выберите доступный никнейм.'; return; }
    const nickname = selectedOption.dataset.name;
    const steamID = selectedOption.dataset.steamid;
    if (!localStream || !localStream.active) { statusEl.textContent = 'Веб-камера не активна.'; return; }

    console.log(`PlayerJS: Emitting 'register_player': nickname=${nickname}, webcamId=${myUniqueWebcamId}, steamID=${steamID}`);
    socket.emit('register_player', { nickname, webcamId: myUniqueWebcamId, steamID });
    startStreamBtn.disabled = true; nicknameSelect.disabled = true; steamIDInput.disabled = true; webcamSelect.disabled = true;
    statusEl.textContent = `Регистрация как ${nickname}...`;
};

socket.on('registration_success', (data) => { console.log('PlayerJS: Reg success:', data); statusEl.textContent = `Зарегистрированы как ${data.nickname}. Ожидание зрителей...`; });
socket.on('registration_error', (message) => {
    console.error('PlayerJS: Reg Error:', message); statusEl.textContent = `Ошибка регистрации: ${message}`;
    nicknameSelect.disabled = false; steamIDInput.disabled = false; webcamSelect.disabled = false;
    checkStartButtonState();
});

socket.on('webrtc_offer_from_viewer', async ({ offer, viewerWebcamId }) => {
    console.log(`PlayerJS: Received Offer from viewer ${viewerWebcamId}`, offer);
    if (!localStream) { console.error("PlayerJS: localStream not available for offer."); return; }
    const pc = new RTCPeerConnection(pcConfig); peerConnections[viewerWebcamId] = pc;
    console.log(`PlayerJS: Created PC for viewer ${viewerWebcamId}`);
    pc.onicecandidate = event => { if (event.candidate) { console.log(`PlayerJS: Sending ICE to viewer ${viewerWebcamId}`, event.candidate); socket.emit('webrtc_ice_candidate', {candidate:event.candidate, targetId:viewerWebcamId, isTargetPlayer:false, senderId:myUniqueWebcamId}); } else { console.log(`PlayerJS: All ICE sent for ${viewerWebcamId}.`);}};
    pc.oniceconnectionstatechange = () => { console.log(`PlayerJS: ICE state with ${viewerWebcamId}: ${pc.iceConnectionState}`); if (['failed','disconnected','closed'].includes(pc.iceConnectionState) && peerConnections[viewerWebcamId]) { peerConnections[viewerWebcamId].close(); delete peerConnections[viewerWebcamId]; console.log(`PlayerJS: Connection with ${viewerWebcamId} ended.`); }};
    pc.onsignalingstatechange = () => { console.log(`PlayerJS: Signaling state with ${viewerWebcamId}: ${pc.signalingState}`); };
    pc.onconnectionstatechange = () => { console.log(`PlayerJS: Connection state with ${viewerWebcamId}: ${pc.connectionState}`); };
    try {
        if (localStream && localStream.getTracks().length > 0) { localStream.getTracks().forEach(track => { console.log(`PlayerJS: Adding track to PC for ${viewerWebcamId}:`, track.kind); pc.addTrack(track, localStream); }); }
        else { console.error('PlayerJS: localStream missing/no tracks for offer.'); return; }
        console.log(`PlayerJS: Setting remote desc (offer) from ${viewerWebcamId}`); await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`PlayerJS: Creating answer for ${viewerWebcamId}`); const answer = await pc.createAnswer();
        console.log(`PlayerJS: Setting local desc (answer) for ${viewerWebcamId}`); await pc.setLocalDescription(answer);
        console.log(`PlayerJS: Sending answer to ${viewerWebcamId}`); socket.emit('webrtc_answer', {answer:answer, targetViewerWebcamId:viewerWebcamId, senderPlayerWebcamId:myUniqueWebcamId});
    } catch (e) { console.error(`PlayerJS: Error handling offer/answer for ${viewerWebcamId}:`, e); }
});
socket.on('webrtc_ice_candidate_from_peer', async ({ candidate, iceSenderId }) => {
    const viewerWebcamId = iceSenderId;
    console.log(`PlayerJS: Received ICE from viewer ${viewerWebcamId}:`, candidate);
    if (peerConnections[viewerWebcamId] && candidate) {
         try { await peerConnections[viewerWebcamId].addIceCandidate(new RTCIceCandidate(candidate)); console.log(`PlayerJS: Added ICE from ${viewerWebcamId}.`); }
         catch (e) { console.error(`PlayerJS: Error adding ICE from ${viewerWebcamId}:`, e); }
    } else { console.warn(`PlayerJS: ICE from ${viewerWebcamId}, but no PC or no candidate data.`); }
});

populateWebcamList();
console.log('PlayerJS: Initialized. My webcam ID:', myUniqueWebcamId);