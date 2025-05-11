const socket = io();
const observerSessionId = 'obs-multi-' + Math.random().toString(36).substring(2, 9);
const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let playerSlotsData = {}; 

document.querySelectorAll('.player-slot').forEach((slotElement) => {
    const videoEl = slotElement.querySelector('video');
    const placeholderEl = slotElement.querySelector('.placeholder-multiview');
    const nameEl = slotElement.querySelector('h4');
    const slotId = slotElement.id; 
    playerSlotsData[slotId] = { id: slotId, videoElement: videoEl, placeholderElement: placeholderEl, nameElement: nameEl, webcamId: null, pc: null, playerName: nameEl.textContent, showWebcam: true };
    showPlaceholderInSlot(playerSlotsData[slotId], 'Ожидание игрока...');
});

function showPlaceholderInSlot(slot, message) { if (slot.videoElement) slot.videoElement.style.display = 'none'; if (slot.placeholderElement) { slot.placeholderElement.textContent = message || 'Нет сигнала'; slot.placeholderElement.style.display = 'flex'; }}
function showVideoInSlot(slot) { if (slot.placeholderElement) slot.placeholderElement.style.display = 'none'; if (slot.videoElement) slot.videoElement.style.display = 'block';}

async function connectToPlayerInSlot(slot, targetPlayerWebcamId, playerName, showWebcamPreference = true) {
    if (slot.pc && slot.pc.connectionState !== 'closed') slot.pc.close();
    if (slot.videoElement) slot.videoElement.srcObject = null;
    slot.webcamId = targetPlayerWebcamId; slot.playerName = playerName; slot.showWebcam = showWebcamPreference;
    if (slot.nameElement) slot.nameElement.textContent = playerName || slot.id;
    if (!targetPlayerWebcamId) { showPlaceholderInSlot(slot, `${playerName || slot.id} (нет webcam ID)`); return; }
    if (!showWebcamPreference) { showPlaceholderInSlot(slot, `Камера ${playerName} откл.`); return; }
    showVideoInSlot(slot);
    const pc = new RTCPeerConnection(pcConfig); slot.pc = pc;
    pc.onicecandidate = event => { if (event.candidate) socket.emit('webrtc_ice_candidate', { candidate: event.candidate, targetId: targetPlayerWebcamId, isTargetPlayer: true, senderId: `${observerSessionId}-${slot.id}` }); };
    pc.ontrack = event => { if (event.streams && event.streams[0]) { if (slot.videoElement.srcObject !== event.streams[0]) { slot.videoElement.srcObject = event.streams[0]; slot.videoElement.play().catch(e => {}); showVideoInSlot(slot); }} else showPlaceholderInSlot(slot, `Ошибка потока от ${playerName}`); };
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) if (slot.webcamId === targetPlayerWebcamId) showPlaceholderInSlot(slot, `Связь с ${playerName} ${pc.connectionState}`); else if (pc.connectionState === 'connected') if (slot.showWebcam) showVideoInSlot(slot); else showPlaceholderInSlot(slot, `Камера ${playerName} откл.`);};
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: `${observerSessionId}-${slot.id}` }); } 
    catch (e) { showPlaceholderInSlot(slot, `Ошибка подкл. к ${playerName}`); }
}

let assignedWebcamIds = new Set();
let allServerPlayers = []; // Храним всех игроков с сервера

function assignPlayersToSlots() {
    const availableSlots = Object.values(playerSlotsData);
    let slotIndex = 0;
    assignedWebcamIds.clear(); 
    // Сначала пытаемся заполнить слоты игроками, которые уже были в них (если они еще есть)
    availableSlots.forEach(slot => { 
        if (slot.webcamId && allServerPlayers.some(p => p.webcamId === slot.webcamId)) {
            const player = allServerPlayers.find(p => p.webcamId === slot.webcamId);
            if(player) {
                connectToPlayerInSlot(slot, player.webcamId, player.nickname, player.showWebcam);
                assignedWebcamIds.add(player.webcamId);
            }
        } else { // Очищаем слот, если предыдущего игрока нет или он уже не должен быть здесь
            if(slot.pc) slot.pc.close(); slot.videoElement.srcObject = null; slot.webcamId = null;
            slot.nameElement.textContent = slot.id.replace('slot-','Слот ');
            showPlaceholderInSlot(slot, 'Ожидание игрока...');
        }
    });
    // Затем заполняем оставшиеся пустые слоты оставшимися игроками
    allServerPlayers.forEach(player => {
        if (player.webcamId && !assignedWebcamIds.has(player.webcamId)) {
            const freeSlot = availableSlots.find(s => !s.webcamId); // Ищем первый свободный слот
            if (freeSlot) {
                connectToPlayerInSlot(freeSlot, player.webcamId, player.nickname, player.showWebcam);
                assignedWebcamIds.add(player.webcamId);
            }
        }
    });
}

socket.on('current_players', (playersData) => { allServerPlayers = playersData; assignPlayersToSlots(); });
socket.on('player_update', (playerData) => { 
    const existingIdx = allServerPlayers.findIndex(p => p.webcamId === playerData.webcamId || p.nickname === playerData.nickname);
    if (existingIdx > -1) allServerPlayers[existingIdx] = {...allServerPlayers[existingIdx], ...playerData};
    else allServerPlayers.push(playerData);
    assignPlayersToSlots(); 
});
socket.on('player_left', ({ nickname, webcamId }) => { allServerPlayers = allServerPlayers.filter(p => p.webcamId !== webcamId); assignPlayersToSlots();});
socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => { const slotId = viewerWebcamId.replace(`${observerSessionId}-`, ''); const slot = playerSlotsData[slotId]; if (!slot || !slot.pc || slot.webcamId !== playerWebcamId) return; if (slot.pc.signalingState === 'have-local-offer' || slot.pc.signalingState === 'stable') { try { await slot.pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch (e) {}}});
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => { const slotId = forTargetId.replace(`${observerSessionId}-`, ''); const slot = playerSlotsData[slotId]; if (!slot || !slot.pc || slot.webcamId !== iceSenderId || !candidate) return; try { await slot.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}});
socket.on('player_preference_update', ({ nickname, webcamId, showWebcam }) => { const playerToUpdate = allServerPlayers.find(p => p.webcamId === webcamId); if(playerToUpdate) playerToUpdate.showWebcam = showWebcam; assignPlayersToSlots(); });
socket.on('connect', () => {});