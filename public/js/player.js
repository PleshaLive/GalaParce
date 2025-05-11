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

function requestPlayerList() { socket.emit('request_player_setup_data'); }
socket.on('connect', () => { nicknameLoadingStatus.textContent = 'Запрос списка игроков...'; startStreamBtn.disabled = true; requestPlayerList(); });
socket.on('player_setup_data_available', (serverPlayers) => {
    const currentSelectedValue = nicknameSelect.value; 
    nicknameSelect.innerHTML = '<option value="" disabled selected>-- Выберите ваш никнейм --</option>';
    let hasAvailablePlayers = false;
    if (serverPlayers && serverPlayers.length > 0) {
        serverPlayers.forEach(player => {
            const option = document.createElement('option');
            option.value = player.steamID || player.name; 
            option.textContent = player.name;
            if (player.isRegistered) { option.textContent += ' (камера активна)'; option.classList.add('registered-player'); }
            option.disabled = player.isRegistered;
            option.dataset.steamid = player.steamID || '';
            option.dataset.name = player.name; 
            nicknameSelect.appendChild(option);
            if (!player.isRegistered) hasAvailablePlayers = true;
        });
        nicknameLoadingStatus.textContent = hasAvailablePlayers ? 'Выберите ваш никнейм.' : 'Все игроки из списка уже с камерами.';
        if (currentSelectedValue) { const existingOption = Array.from(nicknameSelect.options).find(opt => opt.value === currentSelectedValue && !opt.disabled); if (existingOption) nicknameSelect.value = currentSelectedValue; }
    } else { nicknameLoadingStatus.textContent = 'На сервере нет игроков (GSI) или все с камерами.'; }
    checkStartButtonState(); 
});
nicknameSelect.onchange = () => { const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex]; if (selectedOption && selectedOption.dataset.steamid) steamIDInput.value = selectedOption.dataset.steamid; else steamIDInput.value = ''; checkStartButtonState(); if (selectedOption && selectedOption.disabled) statusEl.textContent = "Этот игрок уже зарегистрировал веб-камеру."; else statusEl.textContent = ""; };
function checkStartButtonState() { const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex]; const isPlayerSelectedAndAvailable = selectedOption && selectedOption.value && !selectedOption.disabled; startStreamBtn.disabled = !(localStream && localStream.active && isPlayerSelectedAndAvailable); }
async function populateWebcamList() { try { const devices = await navigator.mediaDevices.enumerateDevices(); const videoDevices = devices.filter(device => device.kind === 'videoinput'); webcamSelect.innerHTML = videoDevices.map(d => `<option value="${d.deviceId}">${d.label||`Камера ${webcamSelect.options.length+1}`}</option>`).join(''); if (videoDevices.length > 0) await startPreview(videoDevices[0].deviceId); else { statusEl.textContent = 'Веб-камеры не найдены.'; checkStartButtonState(); } } catch (e) { statusEl.textContent = 'Ошибка доступа к устройствам: '+e.message; checkStartButtonState(); } }
async function startPreview(deviceId) { if (localStream) { localStream.getTracks().forEach(track => track.stop()); } const constraints = { video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: {ideal:1280}, height: {ideal:720} }, audio: true }; try { localStream = await navigator.mediaDevices.getUserMedia(constraints); const vs = localStream.getVideoTracks()[0]?.getSettings(); if(vs) console.log(`PlayerJS: Actual video res: ${vs.width}x${vs.height}, AR: ${vs.aspectRatio?.toFixed(2)}`); localVideo.srcObject = localStream; statusEl.textContent = 'Предпросмотр камеры активен.'; } catch (e) { statusEl.textContent = 'Ошибка доступа к камере: '+e.message; localStream = null; } checkStartButtonState(); }
webcamSelect.onchange = () => { startPreview(webcamSelect.value); };
startStreamBtn.onclick = () => { const selectedOption = nicknameSelect.options[nicknameSelect.selectedIndex]; if (!selectedOption || !selectedOption.value || selectedOption.disabled) { statusEl.textContent = 'Выберите доступный никнейм.'; return; } currentRegisteredNickname = selectedOption.dataset.name; const steamID = selectedOption.dataset.steamid; if (!localStream || !localStream.active) { statusEl.textContent = 'Веб-камера не активна.'; return; } socket.emit('register_player', { nickname: currentRegisteredNickname, webcamId: myUniqueWebcamId, steamID }); setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = true); startStreamBtn.style.display = 'none'; stopStreamBtn.style.display = 'inline-block'; statusEl.textContent = `Регистрация как ${currentRegisteredNickname}...`; };
stopStreamBtn.onclick = () => { if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; localVideo.srcObject = null; } Object.values(peerConnections).forEach(pc => pc.close()); peerConnections = {}; socket.emit('unregister_player', { nickname: currentRegisteredNickname, webcamId: myUniqueWebcamId }); setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = false); startStreamBtn.style.display = 'inline-block'; stopStreamBtn.style.display = 'none'; statusEl.textContent = 'Камера отключена.'; currentRegisteredNickname = null; checkStartButtonState(); requestPlayerList(); };
socket.on('registration_success', (data) => { statusEl.textContent = `Вы транслируете как ${data.nickname}. Ожидание зрителей...`; setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = true); startStreamBtn.style.display = 'none'; stopStreamBtn.style.display = 'inline-block'; });
socket.on('registration_error', (message) => { statusEl.textContent = `Ошибка регистрации: ${message}`; setupControlsEl.querySelectorAll('select, input').forEach(el => el.disabled = false); startStreamBtn.style.display = 'inline-block'; stopStreamBtn.style.display = 'none'; currentRegisteredNickname = null; checkStartButtonState();});
socket.on('unregistration_success', () => {});
socket.on('webrtc_offer_from_viewer', async ({ offer, viewerWebcamId }) => { if (!localStream) { return; } const pc = new RTCPeerConnection(pcConfig); peerConnections[viewerWebcamId] = pc; pc.onicecandidate = event => { if (event.candidate) { socket.emit('webrtc_ice_candidate', {candidate:event.candidate, targetId:viewerWebcamId, isTargetPlayer:false, senderId:myUniqueWebcamId}); }}; pc.oniceconnectionstatechange = () => { if (['failed','disconnected','closed'].includes(pc.iceConnectionState) && peerConnections[viewerWebcamId]) { peerConnections[viewerWebcamId].close(); delete peerConnections[viewerWebcamId]; }}; pc.onsignalingstatechange = () => {}; pc.onconnectionstatechange = () => {}; try { if (localStream && localStream.getTracks().length > 0) { localStream.getTracks().forEach(track => { pc.addTrack(track, localStream); }); } else { return; } await pc.setRemoteDescription(new RTCSessionDescription(offer)); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit('webrtc_answer', {answer:answer, targetViewerWebcamId:viewerWebcamId, senderPlayerWebcamId:myUniqueWebcamId}); } catch (e) { console.error(`PlayerJS: Error handling offer/answer for ${viewerWebcamId}:`, e); } });
socket.on('webrtc_ice_candidate_from_peer', async ({ candidate, iceSenderId }) => { const viewerWebcamId = iceSenderId; if (peerConnections[viewerWebcamId] && candidate) { try { await peerConnections[viewerWebcamId].addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.error(`PlayerJS: Error adding ICE from ${viewerWebcamId}:`, e); } }});
populateWebcamList();