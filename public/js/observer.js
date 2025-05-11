const socket = io();
const spectatorVideoEl = document.getElementById('spectatorVideo');
const gsiSpectatingNicknameEl = document.getElementById('gsiSpectatingNickname');
const gsiSpectatingSteamIDEl = document.getElementById('gsiSpectatingSteamID');
const pinnedPlayerInfoEl = document.getElementById('pinnedPlayerInfo');
const pinnedNicknameEl = document.getElementById('pinnedNickname');
const unpinBtn = document.getElementById('unpinBtn');
const playerWebcamsContainer = document.getElementById('playerWebcamsContainer');
const fullscreenBtn = document.getElementById('fullscreenBtn');
let activePlayers = {}; 
let currentGsiSpectatedWebcamId = null; 
let currentDisplayedWebcamIdInMainVideo = null;  
let pinnedPlayerWebcamId = null;      
let pcForMainVideoToCloseLater = null; 
let pcsForPreviewsToCloseLater = {};   
const observerSessionId = 'obs-' + Math.random().toString(36).substring(2, 9);

if (!spectatorVideoEl) console.error("ObserverJS: CRITICAL - Main video element 'spectatorVideo' not found!");
const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

fullscreenBtn.onclick = () => { if (!document.fullscreenElement) { spectatorVideoEl.requestFullscreen().catch(err => {}); } else { if (document.exitFullscreen) document.exitFullscreen(); } };
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement === spectatorVideoEl) { fullscreenBtn.textContent = 'Выйти из полноэкранного'; } else { fullscreenBtn.textContent = 'На весь экран'; if (pinnedPlayerWebcamId) unpinPlayer(); } });
function pinPlayer(webcamId, nickname) { if (!activePlayers[nickname] || activePlayers[nickname].webcamId !== webcamId) {return;} pinnedPlayerWebcamId = webcamId; pinnedNicknameEl.textContent = nickname; pinnedPlayerInfoEl.style.display = 'block'; unpinBtn.style.display = 'inline-block'; if (currentDisplayedWebcamIdInMainVideo !== webcamId && spectatorVideoEl) { connectToPlayerStream(webcamId, nickname, spectatorVideoEl, activePlayers[nickname]?.showWebcam); currentDisplayedWebcamIdInMainVideo = webcamId; } }
function unpinPlayer() { pinnedPlayerWebcamId = null; pinnedPlayerInfoEl.style.display = 'none'; unpinBtn.style.display = 'none'; if (currentGsiSpectatedWebcamId && spectatorVideoEl) { const gsiTarget = Object.values(activePlayers).find(p => p.webcamId === currentGsiSpectatedWebcamId); if (gsiTarget) { connectToPlayerStream(gsiTarget.webcamId, gsiTarget.nickname, spectatorVideoEl, gsiTarget.showWebcam); currentDisplayedWebcamIdInMainVideo = gsiTarget.webcamId; } } else if (spectatorVideoEl) { if (spectatorVideoEl.linkedPeerConnection && spectatorVideoEl.linkedPeerConnection.connectionState !== 'closed') spectatorVideoEl.linkedPeerConnection.close(); spectatorVideoEl.srcObject = null; currentDisplayedWebcamIdInMainVideo = null; } }
unpinBtn.onclick = unpinPlayer;

function updatePlayerListAndWebcams() {
    Object.values(activePlayers).forEach(player => {
        if (!player.webcamId) return; 
        let itemId = `player-cam-item-${player.webcamId}`; let videoId = `video-${player.webcamId}`;
        let itemEl = document.getElementById(itemId);
        if (!itemEl) {
            itemEl = document.createElement('div'); itemEl.id = itemId; itemEl.className = 'player-camera-item';
            const h3 = document.createElement('h3'); h3.textContent = player.nickname; 
            if (player.isRegistered) h3.classList.add('registered-player-h3'); 
            itemEl.appendChild(h3);
            const videoEl = document.createElement('video'); videoEl.id = videoId; videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true; itemEl.appendChild(videoEl);
            player.videoElement = videoEl; 
            const controls = document.createElement('div');
            const watchBtn = document.createElement('button'); watchBtn.textContent = `Смотреть`;
            watchBtn.onclick = () => { unpinPlayer(); if (currentDisplayedWebcamIdInMainVideo !== player.webcamId && spectatorVideoEl) { connectToPlayerStream(player.webcamId, player.nickname, spectatorVideoEl, player.showWebcam); currentDisplayedWebcamIdInMainVideo = player.webcamId; gsiSpectatingNicknameEl.textContent = `${player.nickname} (вручную)`; gsiSpectatingSteamIDEl.textContent = player.steamID || 'N/A'; }};
            controls.appendChild(watchBtn);
            const pinFSBtn = document.createElement('button'); pinFSBtn.textContent = `📌 На весь экран`;
            pinFSBtn.onclick = () => { pinPlayer(player.webcamId, player.nickname); if (spectatorVideoEl && !document.fullscreenElement) spectatorVideoEl.requestFullscreen().catch(e=>{}); };
            controls.appendChild(pinFSBtn); itemEl.appendChild(controls); playerWebcamsContainer.appendChild(itemEl);
            if (player.videoElement) connectToPlayerStream(player.webcamId, player.nickname, player.videoElement, player.showWebcam); 
        } else { 
            const h3 = itemEl.querySelector('h3'); 
            if (h3 && h3.textContent !== player.nickname) h3.textContent = player.nickname;
            if (h3 && player.isRegistered) h3.classList.add('registered-player-h3'); else if (h3) h3.classList.remove('registered-player-h3');
            if (player.videoElement && player.peerConnection && ['connected','connecting'].includes(player.peerConnection.connectionState)) {}
            else if (player.videoElement) connectToPlayerStream(player.webcamId, player.nickname, player.videoElement, player.showWebcam); 
        }
    });
    Array.from(playerWebcamsContainer.children).forEach(child => { const wId=child.id.replace('player-cam-item-',''); if(!Object.values(activePlayers).some(p=>p.webcamId===wId))child.remove();});
}

async function connectToPlayerStream(targetPlayerWebcamId, playerName, videoElement, showWebcamPreference = true) {
    if (!videoElement) return; 
    const videoElementId = videoElement.id;
    const currentPCForThisElement = videoElement.linkedPeerConnection;
    if (videoElement === spectatorVideoEl) { if (pcForMainVideoToCloseLater && pcForMainVideoToCloseLater !== currentPCForThisElement && pcForMainVideoToCloseLater.connectionState !== 'closed') pcForMainVideoToCloseLater.close(); pcForMainVideoToCloseLater = currentPCForThisElement; } 
    else { const previewId = videoElementId; if (pcsForPreviewsToCloseLater[previewId] && pcsForPreviewsToCloseLater[previewId] !== currentPCForThisElement && pcsForPreviewsToCloseLater[previewId].connectionState !== 'closed') pcsForPreviewsToCloseLater[previewId].close(); pcsForPreviewsToCloseLater[previewId] = currentPCForThisElement; }
    if (!targetPlayerWebcamId || !showWebcamPreference) { if (videoElement.srcObject) videoElement.srcObject = null; videoElement.linkedPeerConnection = null; if (videoElement === spectatorVideoEl) currentDisplayedWebcamIdInMainVideo = null; let pcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcsForPreviewsToCloseLater[videoElementId]; if (pcToClose && pcToClose.connectionState !== 'closed') pcToClose.close(); if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null; else delete pcsForPreviewsToCloseLater[videoElementId]; return; }
    const newPC = new RTCPeerConnection(pcConfig); newPC.playerName = playerName; videoElement.linkedPeerConnection = newPC;
    const playerRef = Object.values(activePlayers).find(p => p.webcamId === targetPlayerWebcamId); if (playerRef) playerRef.peerConnection = newPC;
    newPC.onicecandidate = event => { if (event.candidate) { socket.emit('webrtc_ice_candidate', {candidate:event.candidate, targetId:targetPlayerWebcamId, isTargetPlayer:true, senderId:observerSessionId}); }};
    newPC.ontrack = event => { if (event.streams && event.streams[0]) { if (videoElement.srcObject !== event.streams[0]) { videoElement.srcObject = event.streams[0]; videoElement.play().catch(e=>{}); let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcsForPreviewsToCloseLater[videoElementId]; if (oldPcToClose && oldPcToClose !== newPC && oldPcToClose.connectionState !== 'closed') { oldPcToClose.close(); if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null; else delete pcsForPreviewsToCloseLater[videoElementId];}}} else { let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcsForPreviewsToCloseLater[videoElementId]; if (oldPcToClose && oldPcToClose !== newPC && oldPcToClose.connectionState !== 'closed') { oldPcToClose.close(); if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null; else delete pcsForPreviewsToCloseLater[videoElementId];}}};
    newPC.onconnectionstatechange = () => { const connState = newPC.connectionState; const mainVid = videoElement===spectatorVideoEl; const isCurrentMain = mainVid && currentDisplayedWebcamIdInMainVideo===targetPlayerWebcamId; const isPinnedCurrent = pinnedPlayerWebcamId && pinnedPlayerWebcamId===targetPlayerWebcamId; if(isCurrentMain && connState==='connected' && (!pinnedPlayerWebcamId || isPinnedCurrent)) gsiSpectatingNicknameEl.textContent=`${playerName} (Подключено)`; else if(isCurrentMain && ['failed','disconnected','closed'].includes(connState)){ if(!pinnedPlayerWebcamId || isPinnedCurrent) gsiSpectatingNicknameEl.textContent=`${playerName} (${connState})`; if (videoElement.linkedPeerConnection === newPC) videoElement.srcObject = null; let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcsForPreviewsToCloseLater[videoElementId]; if (oldPcToClose && oldPcToClose !== newPC && oldPcToClose.connectionState !== 'closed') { oldPcToClose.close(); if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null; else delete pcsForPreviewsToCloseLater[videoElementId];}}};
    newPC.oniceconnectionstatechange = () => {}; newPC.onsignalingstatechange = () => {}; 
    newPC.addTransceiver('video', { direction: 'recvonly' }); newPC.addTransceiver('audio', { direction: 'recvonly' });
    try { const offer = await newPC.createOffer(); await newPC.setLocalDescription(offer); socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: observerSessionId }); } 
    catch (e) { if(videoElement===spectatorVideoEl && currentDisplayedWebcamIdInMainVideo===targetPlayerWebcamId && (!pinnedPlayerWebcamId||pinnedPlayerWebcamId===targetPlayerWebcamId)) gsiSpectatingNicknameEl.textContent=`${playerName} (Ошибка оффера)`; let oldPcToClose = (videoElement === spectatorVideoEl) ? pcForMainVideoToCloseLater : pcsForPreviewsToCloseLater[videoElementId]; if (oldPcToClose && oldPcToClose !== newPC && oldPcToClose.connectionState !== 'closed') { oldPcToClose.close(); if (videoElement === spectatorVideoEl) pcForMainVideoToCloseLater = null; else delete pcsForPreviewsToCloseLater[videoElementId];}}
}
socket.on('current_players', (playersData) => { const newActive = {}; playersData.forEach(p=>{if(p.nickname)newActive[p.nickname]={...(activePlayers[p.nickname]||{}),...p, showWebcam: p.showWebcam === undefined ? true : p.showWebcam}}); activePlayers=newActive; updatePlayerListAndWebcams(); });
socket.on('player_update', (playerData) => { if(playerData.nickname){activePlayers[playerData.nickname]={...(activePlayers[playerData.nickname]||{}),...playerData, showWebcam: playerData.showWebcam === undefined ? true : playerData.showWebcam}; updatePlayerListAndWebcams();} if(pinnedPlayerWebcamId&&activePlayers[playerData.nickname]&&activePlayers[playerData.nickname].webcamId===pinnedPlayerWebcamId)pinnedNicknameEl.textContent=playerData.nickname; if (currentDisplayedWebcamIdInMainVideo === playerData.webcamId && (!pinnedPlayerWebcamId || pinnedPlayerWebcamId === playerData.webcamId)) { if (activePlayers[playerData.nickname]) setMainVideo(activePlayers[playerData.nickname]);}});
socket.on('player_left', ({ nickname, webcamId }) => { const playerThatLeft = activePlayers[nickname]; if(playerThatLeft){if(playerThatLeft.peerConnection)playerThatLeft.peerConnection.close(); const item=document.getElementById(`player-cam-item-${webcamId}`); if(item)item.remove(); delete activePlayers[nickname];} if(pinnedPlayerWebcamId===webcamId)unpinPlayer(); if(currentDisplayedWebcamIdInMainVideo===webcamId&&spectatorVideoEl){if(!pinnedPlayerWebcamId){if(currentGsiSpectatedWebcamId){const target=Object.values(activePlayers).find(p=>p.webcamId===currentGsiSpectatedWebcamId);if(target)setMainVideo(target);else setMainVideo(null);}else setMainVideo(null);}} if(currentGsiSpectatedWebcamId===webcamId){currentGsiSpectatedWebcamId=null;gsiSpectatingNicknameEl.textContent='N/A';gsiSpectatingSteamIDEl.textContent='N/A';}});
socket.on('spectate_change', (data) => { const { steamID, nickname, webcamId, showWebcam } = data; gsiSpectatingNicknameEl.textContent = nickname || 'N/A'; gsiSpectatingSteamIDEl.textContent = steamID || 'N/A'; currentGsiSpectatedWebcamId = webcamId; if (!spectatorVideoEl) return; if (pinnedPlayerWebcamId) return; if (!webcamId) { setMainVideo(null); return; } const targetPlayer = Object.values(activePlayers).find(p => p.webcamId === webcamId); if (targetPlayer) { const effectiveShowWebcam = showWebcam !== undefined ? showWebcam : targetPlayer.showWebcam; targetPlayer.showWebcam = effectiveShowWebcam; setMainVideo(targetPlayer); } else { setMainVideo(null); gsiSpectatingNicknameEl.textContent = `${nickname} (нет активной камеры)`; }});
socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => { if (viewerWebcamId !== observerSessionId) return; let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===playerWebcamId); if (spectatorVideoEl.linkedPeerConnection && currentDisplayedWebcamIdInMainVideo===playerWebcamId && spectatorVideoEl.linkedPeerConnection.localDescription) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection && pEntry.peerConnection.localDescription) targetPC = pEntry.peerConnection; if (targetPC) { if (targetPC.signalingState==='have-local-offer'||targetPC.signalingState==='stable') { try { await targetPC.setRemoteDescription(new RTCSessionDescription(answer)); } catch (e) {}} else {}}});
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => { if (forTargetId !== observerSessionId) return; let targetPC = null; const pEntry = Object.values(activePlayers).find(p=>p.webcamId===iceSenderId); if (spectatorVideoEl.linkedPeerConnection && currentDisplayedWebcamIdInMainVideo === iceSenderId) targetPC = spectatorVideoEl.linkedPeerConnection; else if (pEntry && pEntry.peerConnection) targetPC = pEntry.peerConnection; if (targetPC && candidate) { try { await targetPC.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}} });
socket.on('player_preference_update', ({ nickname, webcamId, showWebcam }) => { const playerToUpdate = Object.values(activePlayers).find(p => p.webcamId === webcamId); if (playerToUpdate) { playerToUpdate.showWebcam = showWebcam; if (currentDisplayedWebcamIdInMainVideo === webcamId && spectatorVideoEl) setMainVideo(playerToUpdate); if (playerToUpdate.videoElement) { if (showWebcam && (!playerToUpdate.peerConnection || playerToUpdate.peerConnection.connectionState === 'closed')) connectToPlayerStream(playerToUpdate.webcamId, playerToUpdate.nickname, playerToUpdate.videoElement, true); else if (!showWebcam && playerToUpdate.peerConnection) { playerToUpdate.peerConnection.close(); playerToUpdate.peerConnection = null; playerToUpdate.stream = null; playerToUpdate.videoElement.srcObject = null; } else if (showWebcam && playerToUpdate.stream && playerToUpdate.videoElement.srcObject !== playerToUpdate.stream) playerToUpdate.videoElement.srcObject = playerToUpdate.stream; } const checkbox = document.querySelector(`.show-webcam-toggle[data-webcamid="${webcamId}"]`); if (checkbox) checkbox.checked = showWebcam; }});
socket.on('webrtc_error', (data) => { if (data.targetWebcamId === currentDisplayedWebcamIdInMainVideo && spectatorVideoEl && (!pinnedPlayerWebcamId||pinnedPlayerWebcamId===data.targetWebcamId)) gsiSpectatingNicknameEl.textContent = `${gsiSpectatingNicknameEl.textContent} (Ошибка: ${data.message})`;});