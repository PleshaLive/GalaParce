// public/js/player.js
const socket = io();
const localVideo = document.getElementById('localVideoPreview');
const nicknameSelect = document.getElementById('nicknameSelect');
const nicknameLoadingStatus = document.getElementById('nicknameLoadingStatus');
const steamIDInput = document.getElementById('steamID');
const webcamSelect = document.getElementById('webcamSelect');
const startStreamBtn = document.getElementById('startStreamBtn');
const stopStreamBtn = document.getElementById('stopStreamBtn');
const statusEl = document.getElementById('status');
const setupControlsEl = document.getElementById('setupControls');

let localStream;
let myUniqueWebcamId = 'player-' + Math.random().toString(36).substring(2, 9);
let peerConnections = {}; 
let currentRegisteredNickname = null;

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function requestPlayerList() {
    console.log('PlayerJS: Requesting player setup data.');
    nicknameLoadingStatus.textContent = 'Запрос списка игроков...';
    socket.emit('request_player_setup_data');
}

socket.on('connect', () => {
    console.log('PlayerJS: Connected to socket.');
    requestPlayerList();
});

socket.on('player_setup_data_available', (serverPlayers) => {
    console.log('PlayerJS: Received player_setup_data_available:', serverPlayers);
    const currentSelectedValue = nicknameSelect.value; 
    nicknameSelect.innerHTML = '<option value="" disabled selected>-- Выберите ваш никнейм --</option>';
    let hasAvailablePlayers = false;

    if (serverPlayers && serverPlayers.length > 0) {
        serverPlayers.forEach(player => {
            const option = document.createElement('option');
            option.value = player.steamID || player.name; 
            option.textContent = player.name;
            if (player.isRegistered) {
                option.textContent += ' (камера активна)';
                option.classList.add('registered-player'); 
            }
            option.disabled = player.isRegistered;
            option.dataset.steamid = player.steamID || '';
            option.dataset.name = player.name; 
            nicknameSelect.appendChild(option);
            if (!player.isRegistered) hasAvailablePlayers = true;
        });
        nicknameLoadingStatus.textContent = hasAvailablePlayers ? 'Выберите ваш никнейм.' : 'Все игроки из списка уже с камерами.';
        if (currentSelectedValue) {
            const existingOption = Array.from(nicknameSelect.options).find(opt => opt.value === currentSelectedValue && !opt.disabled);
            if (existingOption) nicknameSelect.value = currentSelectedValue;
        }
    } else {
        nicknameLoadingStatus.textContent = 'На сервере нет игроков (GSI) или все с камерами. Убедитесь, что CS2 с GSI запущена и вы в игре/наблюдаете.';
    }
    checkStartButtonState(); 
});

nicknameSelect.onchange = () => { 
    const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex]; 
    if (selectedOption && selectedOption.dataset.steamid) steamIDInput.value = selectedOption.dataset.steamid; 
    else steamIDInput.value = ''; 
    checkStartButtonState(); 
    if (selectedOption && selectedOption.disabled) statusEl.textContent = "Этот игрок уже зарегистрировал веб-камеру."; 
    else statusEl.textContent = ""; 
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
    if (localStream) { 
        localStream.getTracks().forEach(track => track.stop()); 
        console.log('PlayerJS: Stopped previous local stream tracks.');
    }

    // --- ИЗМЕНЕНИЕ ЗДЕСЬ для 16:9 ---
    const constraints = { 
        video: { 
            deviceId: deviceId ? { exact: deviceId } : undefined, 
            width: { ideal: 1280 },  // Запрашиваем ширину для 16:9
            height: { ideal: 720 }, // Запрашиваем высоту для 16:9
            // aspectRatio: { ideal: 16/9 } // Можно также использовать это свойство
        }, 
        audio: true 
    };
    // ---------------------------------

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('PlayerJS: Local stream obtained with constraints.', localStream);
        const videoSettings = localStream.getVideoTracks()[0]?.getSettings();
        if (videoSettings) {
            console.log(`PlayerJS: Actual video resolution: ${videoSettings.width}x${videoSettings.height}, Aspect Ratio: ${videoSettings.aspectRatio ? videoSettings.aspectRatio.toFixed(2) : 'N/A'}`);
        }
        localVideo.srcObject = localStream;
        statusEl.textContent = 'Предпросмотр камеры активен.';
    } catch (e) {
        statusEl.textContent = 'Ошибка доступа к веб-камере (возможно, запрошенное разрешение/AR не поддерживается): '+e.message; 
        console.error('PlayerJS: getUserMedia error:',e); 
        localStream = null;
    }
    checkStartButtonState();
}

webcamSelect.onchange = () => { console.log('PlayerJS: Webcam changed:', webcamSelect.value); startPreview(webcamSelect.value); };

startStreamBtn.onclick = () => {
    console.log('PlayerJS: Start Stream button clicked.');
    const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex];
    if (!selectedOption || !selectedOption.value || selectedOption.disabled) { statusEl.textContent = 'Выберите доступный никнейм.'; return; }
    currentRegisteredNickname = selectedOption.dataset.name; 
    const steamID = selectedOption.dataset.steamid;
    if (!localStream || !localStream.active) { statusEl.textContent = 'Веб-камера не активна.'; return; }

    console.log(`PlayerJS: Emitting 'register_player': nickname=${currentRegisteredNickname}, webcamId=${myUniqueWebcamId}, steamID=${steamID}`);
    socket.emit('register_player', { nickname: currentRegisteredNickname, webcamId: myUniqueWebcamId, steamID });
    
    setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = true);
    startStreamBtn.style.display = 'none';
    stopStreamBtn.style.display = 'inline-block';
    statusEl.textContent = `Регистрация как ${currentRegisteredNickname}...`;
};

stopStreamBtn.onclick = () => {
    console.log('PlayerJS: Stop Stream button clicked.');
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        localVideo.srcObject = null;
        console.log('PlayerJS: Local stream stopped.');
    }
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};
    console.log('PlayerJS: All peer connections closed.');

    socket.emit('unregister_player', { nickname: currentRegisteredNickname, webcamId: myUniqueWebcamId });
    
    setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = false);
    startStreamBtn.style.display = 'inline-block';
    stopStreamBtn.style.display = 'none';
    statusEl.textContent = 'Камера отключена. Выберите никнейм и камеру для новой трансляции.';
    currentRegisteredNickname = null;
    checkStartButtonState(); 
    requestPlayerList(); 
};

socket.on('registration_success', (data) => { console.log('PlayerJS: Reg success:', data); statusEl.textContent = `Вы транслируете как ${data.nickname}. Ожидание зрителей...`; setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = true); startStreamBtn.style.display = 'none'; stopStreamBtn.style.display = 'inline-block'; });
socket.on('registration_error', (message) => {
    console.error('PlayerJS: Reg Error:', message); statusEl.textContent = `Ошибка регистрации: ${message}`;
    setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = false);
    startStreamBtn.style.display = 'inline-block'; stopStreamBtn.style.display = 'none';
    currentRegisteredNickname = null; checkStartButtonState();
});
socket.on('unregistration_success', () => {
    console.log('PlayerJS: Unregistration successful from server.');
});

socket.on('webrtc_offer_from_viewer', async ({ offer, viewerWebcamId }) => { console.log(`PlayerJS: Received Offer from viewer ${viewerWebcamId}`, offer); if (!localStream) { console.error("PlayerJS: localStream not available for offer."); return; } const pc = new RTCPeerConnection(pcConfig); peerConnections[viewerWebcamId] = pc; console.log(`PlayerJS: Created PC for viewer ${viewerWebcamId}`); pc.onicecandidate = event => { if (event.candidate) { console.log(`PlayerJS: Sending ICE to viewer ${viewerWebcamId}`, event.candidate); socket.emit('webrtc_ice_candidate', {candidate:event.candidate, targetId:viewerWebcamId, isTargetPlayer:false, senderId:myUniqueWebcamId}); } else { console.log(`PlayerJS: All ICE sent for ${viewerWebcamId}.`);}}; pc.oniceconnectionstatechange = () => { console.log(`PlayerJS: ICE state with ${viewerWebcamId}: ${pc.iceConnectionState}`); if (['failed','disconnected','closed'].includes(pc.iceConnectionState) && peerConnections[viewerWebcamId]) { peerConnections[viewerWebcamId].close(); delete peerConnections[viewerWebcamId]; console.log(`PlayerJS: Connection with ${viewerWebcamId} ended.`); }}; pc.onsignalingstatechange = () => { console.log(`PlayerJS: Signaling state with ${viewerWebcamId}: ${pc.signalingState}`); }; pc.onconnectionstatechange = () => { console.log(`PlayerJS: Connection state with ${viewerWebcamId}: ${pc.connectionState}`); }; try { if (localStream && localStream.getTracks().length > 0) { localStream.getTracks().forEach(track => { console.log(`PlayerJS: Adding track to PC for ${viewerWebcamId}:`, track.kind); pc.addTrack(track, localStream); }); } else { console.error('PlayerJS: localStream missing/no tracks for offer.'); return; } console.log(`PlayerJS: Setting remote desc (offer) from ${viewerWebcamId}`); await pc.setRemoteDescription(new RTCSessionDescription(offer)); console.log(`PlayerJS: Creating answer for ${viewerWebcamId}`); const answer = await pc.createAnswer(); console.log(`PlayerJS: Setting local desc (answer) for ${viewerWebcamId}`); await pc.setLocalDescription(answer); console.log(`PlayerJS: Sending answer to ${viewerWebcamId}`); socket.emit('webrtc_answer', {answer:answer, targetViewerWebcamId:viewerWebcamId, senderPlayerWebcamId:myUniqueWebcamId}); } catch (e) { console.error(`PlayerJS: Error handling offer/answer for ${viewerWebcamId}:`, e); } });
socket.on('webrtc_ice_candidate_from_peer', async ({ candidate, iceSenderId }) => { const viewerWebcamId = iceSenderId; console.log(`PlayerJS: Received ICE from viewer ${viewerWebcamId}:`, candidate); if (peerConnections[viewerWebcamId] && candidate) { try { await peerConnections[viewerWebcamId].addIceCandidate(new RTCIceCandidate(candidate)); console.log(`PlayerJS: Added ICE from ${viewerWebcamId}.`); } catch (e) { console.error(`PlayerJS: Error adding ICE from ${viewerWebcamId}:`, e); } } else { console.warn(`PlayerJS: ICE from ${viewerWebcamId}, but no PC or no candidate data.`); } });

populateWebcamList();
console.log('PlayerJS: Initialized. My webcam ID:', myUniqueWebcamId);