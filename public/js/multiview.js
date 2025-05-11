// public/js/multiview.js
const socket = io();
const observerSessionId = 'obs-multi-' + Math.random().toString(36).substring(2, 9);
console.log('MultiViewJS: Initialized. Session ID:', observerSessionId);

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let playerSlots = {}; // { webcamId: { pc, videoElement, placeholderElement, playerName, showWebcam } }

// Собираем все слоты для игроков
document.querySelectorAll('.player-slot').forEach((slotElement, index) => {
    const videoEl = slotElement.querySelector('video');
    const placeholderEl = slotElement.querySelector('.placeholder-multiview');
    const nameEl = slotElement.querySelector('h4');
    // Генерируем временный ID для слота, пока не привязали игрока
    const slotId = `slot-${index}`; 
    playerSlots[slotId] = { // Используем slotId как временный ключ
        id: slotId,
        videoElement: videoEl,
        placeholderElement: placeholderEl,
        nameElement: nameEl,
        playerName: `Игрок ${index + 1}`, // Временное имя
        webcamId: null, // Будет установлен при привязке игрока
        pc: null,
        showWebcam: true // По умолчанию показываем
    };
    if (nameEl) nameEl.textContent = `Слот ${index + 1}`; // Обновляем заголовок слота
    showPlaceholderInSlot(playerSlots[slotId], 'Ожидание игрока...');
});


function showPlaceholderInSlot(slot, message) {
    if (slot.videoElement) slot.videoElement.style.display = 'none';
    if (slot.placeholderElement) {
        slot.placeholderElement.textContent = message || 'Нет сигнала';
        slot.placeholderElement.style.display = 'flex';
    }
}

function showVideoInSlot(slot) {
    if (slot.placeholderElement) slot.placeholderElement.style.display = 'none';
    if (slot.videoElement) slot.videoElement.style.display = 'block';
}

async function connectToPlayerInSlot(slot, targetPlayerWebcamId, playerName, showWebcamPreference = true) {
    console.log(`MultiViewJS: Slot ${slot.id}: Attempting to connect to ${playerName} (Webcam: ${targetPlayerWebcamId}), ShowPref: ${showWebcamPreference}`);
    
    if (slot.pc && slot.pc.connectionState !== 'closed') {
        console.log(`MultiViewJS: Slot ${slot.id}: Closing existing PC (state: ${slot.pc.connectionState})`);
        slot.pc.close();
    }
    if (slot.videoElement) slot.videoElement.srcObject = null;
    
    slot.webcamId = targetPlayerWebcamId;
    slot.playerName = playerName;
    slot.showWebcam = showWebcamPreference;
    if (slot.nameElement) slot.nameElement.textContent = playerName;


    if (!targetPlayerWebcamId) {
        showPlaceholderInSlot(slot, `${playerName} (нет webcam ID)`);
        return;
    }
    if (!showWebcamPreference) {
        showPlaceholderInSlot(slot, `Камера ${playerName} отключена`);
        return;
    }
    
    showVideoInSlot(slot);

    const pc = new RTCPeerConnection(pcConfig);
    slot.pc = pc;

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', { candidate: event.candidate, targetId: targetPlayerWebcamId, isTargetPlayer: true, senderId: `${observerSessionId}-${slot.id}` });
        }
    };
    pc.ontrack = event => {
        console.log(`MultiViewJS: Slot ${slot.id}: Track RECEIVED from ${playerName}`, event.track);
        if (event.streams && event.streams[0]) {
            if (slot.videoElement.srcObject !== event.streams[0]) {
                slot.videoElement.srcObject = event.streams[0];
                slot.videoElement.play().catch(e => console.error(`MultiViewJS: Slot ${slot.id}: Error playing video:`, e));
                showVideoInSlot(slot);
            }
        } else { showPlaceholderInSlot(slot, `Ошибка потока от ${playerName}`); }
    };
    pc.onconnectionstatechange = () => {
        console.log(`MultiViewJS: Slot ${slot.id} (${playerName}): Connection state: ${pc.connectionState}`);
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            if (slot.webcamId === targetPlayerWebcamId) { // Если это все еще актуальный игрок для этого слота
                 showPlaceholderInSlot(slot, `Связь с ${playerName} потеряна`);
            }
        } else if (pc.connectionState === 'connected') {
            if (slot.showWebcam) showVideoInSlot(slot); // Показываем видео, если должно быть видимо
            else showPlaceholderInSlot(slot, `Камера ${playerName} отключена`);
        }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: `${observerSessionId}-${slot.id}` });
    } catch (e) { console.error(`MultiViewJS: Slot ${slot.id}: Error creating/sending offer:`, e); showPlaceholderInSlot(slot, `Ошибка подключения к ${playerName}`); }
}

// Массив для отслеживания назначенных игроков, чтобы не дублировать
let assignedWebcamIds = new Set();

socket.on('current_players', (playersData) => {
    console.log('MultiViewJS: Received current_players:', playersData);
    assignedWebcamIds.clear(); // Очищаем при полном обновлении
    const availableSlots = Object.values(playerSlots); // Все слоты
    let slotIndex = 0;

    playersData.forEach(player => {
        if (player.webcamId && slotIndex < availableSlots.length) {
            const slot = availableSlots[slotIndex];
            console.log(`MultiViewJS: Assigning ${player.nickname} to slot ${slot.id}`);
            // Предполагаем, что сервер присылает player.showWebcam (нужно будет добавить на сервере)
            connectToPlayerInSlot(slot, player.webcamId, player.nickname, player.showWebcam !== undefined ? player.showWebcam : true);
            assignedWebcamIds.add(player.webcamId);
            slotIndex++;
        }
    });
    // Очищаем оставшиеся слоты, если игроков меньше
    for (let i = slotIndex; i < availableSlots.length; i++) {
        const slot = availableSlots[i];
        if (slot.pc) slot.pc.close();
        if (slot.videoElement) slot.videoElement.srcObject = null;
        if (slot.nameElement) slot.nameElement.textContent = `Слот ${i + 1}`;
        slot.webcamId = null;
        showPlaceholderInSlot(slot, 'Ожидание игрока...');
    }
});

socket.on('player_update', (playerData) => {
    console.log('MultiViewJS: Received player_update:', playerData);
    if (!playerData.webcamId) return;

    // Пытаемся найти слот, уже занятый этим игроком
    let existingSlot = Object.values(playerSlots).find(s => s.webcamId === playerData.webcamId);

    if (existingSlot) { // Игрок уже в слоте, возможно, обновить данные (например, showWebcam)
        console.log(`MultiViewJS: Updating player ${playerData.nickname} in slot ${existingSlot.id}`);
        connectToPlayerInSlot(existingSlot, playerData.webcamId, playerData.nickname, playerData.showWebcam !== undefined ? playerData.showWebcam : true);
    } else if (!assignedWebcamIds.has(playerData.webcamId)) { // Новый игрок, ищем свободный слот
        let freeSlot = Object.values(playerSlots).find(s => !s.webcamId);
        if (freeSlot) {
            console.log(`MultiViewJS: Assigning new player ${playerData.nickname} to free slot ${freeSlot.id}`);
            connectToPlayerInSlot(freeSlot, playerData.webcamId, playerData.nickname, playerData.showWebcam !== undefined ? playerData.showWebcam : true);
            assignedWebcamIds.add(playerData.webcamId);
        } else {
            console.log(`MultiViewJS: No free slot for new player ${playerData.nickname}`);
        }
    }
});

socket.on('player_left', ({ nickname, webcamId }) => {
    console.log('MultiViewJS: Received player_left:', nickname, webcamId);
    const slot = Object.values(playerSlots).find(s => s.webcamId === webcamId);
    if (slot) {
        console.log(`MultiViewJS: Player ${nickname} left from slot ${slot.id}`);
        if (slot.pc) slot.pc.close();
        if (slot.videoElement) slot.videoElement.srcObject = null;
        if (slot.nameElement) slot.nameElement.textContent = `Слот (Освобожден)`; // Обновляем заголовок слота
        slot.webcamId = null; // Освобождаем слот
        showPlaceholderInSlot(slot, 'Игрок отключился');
        assignedWebcamIds.delete(webcamId);
    }
});


socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => {
    // viewerWebcamId для multiview будет `${observerSessionId}-${slot.id}`
    const slotId = viewerWebcamId.replace(`${observerSessionId}-`, '');
    const slot = Object.values(playerSlots).find(s => s.id === slotId && s.webcamId === playerWebcamId);

    if (!slot || !slot.pc) return;
    console.log(`MultiViewJS: Slot ${slot.id}: Received answer from player ${playerWebcamId}`);
    if (slot.pc.signalingState === 'have-local-offer' || slot.pc.signalingState === 'stable') {
        try { await slot.pc.setRemoteDescription(new RTCSessionDescription(answer)); }
        catch (e) { console.error(`MultiViewJS: Slot ${slot.id}: Error setting remote desc (answer):`, e); }
    } else { console.warn(`MultiViewJS: Slot ${slot.id}: Answer received, but PC signalingState is ${slot.pc.signalingState}.`); }
});

socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => {
    // forTargetId для multiview будет `${observerSessionId}-${slot.id}`
    // iceSenderId это playerWebcamId
    const slotId = forTargetId.replace(`${observerSessionId}-`, '');
    const slot = Object.values(playerSlots).find(s => s.id === slotId && s.webcamId === iceSenderId);
    
    if (!slot || !slot.pc || !candidate) return;
    // console.log(`MultiViewJS: Slot ${slot.id}: Received ICE from player ${iceSenderId}`);
    try { await slot.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.error(`MultiViewJS: Slot ${slot.id}: Error adding ICE:`, e); }
});

socket.on('player_preference_update', ({ nickname, steamID, webcamId, showWebcam }) => {
    console.log('MultiViewJS: Received player_preference_update:', { nickname, webcamId, showWebcam });
    const slotToUpdate = Object.values(playerSlots).find(s => s.webcamId === webcamId);
    if (slotToUpdate) {
        console.log(`MultiViewJS: Updating showWebcam preference for ${nickname} in slot ${slotToUpdate.id} to ${showWebcam}`);
        slotToUpdate.showWebcam = showWebcam;
        // Переподключаем или показываем/скрываем видео
        if (showWebcam) {
            if (slotToUpdate.pc && (slotToUpdate.pc.connectionState === 'connected' || slotToUpdate.pc.connectionState === 'connecting')) {
                showVideoInSlot(slotToUpdate); // Просто показываем, если уже есть соединение
            } else {
                connectToPlayerInSlot(slotToUpdate, slotToUpdate.webcamId, slotToUpdate.playerName, true); // Переподключаем
            }
        } else {
            showPlaceholderInSlot(slotToUpdate, `Камера ${slotToUpdate.playerName} отключена`);
            if (slotToUpdate.pc && slotToUpdate.pc.connectionState !== 'closed') { // Закрываем соединение, если оно не нужно
                slotToUpdate.pc.close();
                slotToUpdate.pc = null; // Чтобы при следующем апдейте пересоздалось, если showWebcam станет true
            }
        }
    }
});

socket.on('connect', () => {
    console.log('MultiViewJS: Connected to socket server.');
    // Запросить всех текущих игроков при подключении
    // Сервер уже должен прислать 'current_players' сам
});