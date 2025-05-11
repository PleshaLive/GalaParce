const socket = io();
const videoElement = document.getElementById('observerFullVideo');
// const videoPlaceholder = document.getElementById('videoPlaceholder'); // Можно удалить, если плейсхолдер не используется для текста
let activePeerConnection = null; // Активное соединение, которое сейчас показывает видео
let pendingPeerConnection = null; // Соединение, которое настраивается для замены активного
let currentTargetWebcamId = null; // ID вебкамеры, которую мы пытаемся отобразить
const observerSessionId = 'obs-full-' + Math.random().toString(36).substring(2, 9);

if (!videoElement) console.error("ObserverFullJS: Video element not found!");
const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function showTransparentPage() {
    if (videoElement) {
        videoElement.style.display = 'none';
        // videoElement.srcObject = null; // Очистка srcObject будет происходить при фактическом закрытии PC или при явной остановке
    }
    // Если у вас был videoPlaceholder для текста "Нет сигнала", его можно показать здесь
    // if (videoPlaceholder) videoPlaceholder.style.display = 'flex';
    console.log("Showing transparent page, video hidden.");
}

function showVideoElement() {
    // if (videoPlaceholder) videoPlaceholder.style.display = 'none';
    if (videoElement) {
        videoElement.style.display = 'block';
    }
    console.log("Showing video element.");
}

async function connectToPlayerStream(targetPlayerWebcamId, playerName, showWebcamPreference = true) {
    console.log(`Attempting to connect to: ${targetPlayerWebcamId}, current target: ${currentTargetWebcamId}, activePC: ${activePeerConnection?.targetWebcamId}, pendingPC: ${pendingPeerConnection?.targetWebcamId}`);

    // Если мы уже пытаемся подключиться или подключены к этому же webcamId
    if (currentTargetWebcamId === targetPlayerWebcamId && targetPlayerWebcamId !== null) {
        if (pendingPeerConnection && pendingPeerConnection.targetWebcamId === targetPlayerWebcamId) {
            console.log("Connection attempt already pending for", targetPlayerWebcamId);
            return; // Настройка уже идет
        }
        if (activePeerConnection && activePeerConnection.targetWebcamId === targetPlayerWebcamId &&
            (activePeerConnection.connectionState === 'connected' || activePeerConnection.connectionState === 'connecting')) {
            console.log("Already active or connecting to", targetPlayerWebcamId);
            if (videoElement.srcObject && videoElement.style.display === 'none') {
                showVideoElement(); // Убедимся, что видео показывается, если оно уже есть
            }
            return;
        }
    }

    const oldTargetWebcamId = currentTargetWebcamId;
    currentTargetWebcamId = targetPlayerWebcamId; // Оптимистично обновляем ID целевой камеры

    // Если есть ожидающее соединение (pendingPeerConnection) для *другой* цели, закроем его
    if (pendingPeerConnection && pendingPeerConnection.targetWebcamId !== targetPlayerWebcamId) {
        console.log("New target, closing previous pending PC for", pendingPeerConnection.targetWebcamId);
        pendingPeerConnection.close();
        pendingPeerConnection = null;
    }

    // Обработка остановки стрима или если вебкамера отключена настройкой
    if (!targetPlayerWebcamId || !showWebcamPreference) {
        console.log(`Stopping stream. Target: ${targetPlayerWebcamId}, ShowPref: ${showWebcamPreference}. Cleaning up.`);
        if (pendingPeerConnection) {
            console.log("Closing pending PC:", pendingPeerConnection.targetWebcamId);
            pendingPeerConnection.close();
            pendingPeerConnection = null;
        }
        if (activePeerConnection) {
            console.log("Closing active PC:", activePeerConnection.targetWebcamId);
            activePeerConnection.close();
            activePeerConnection = null;
        }
        if (videoElement) videoElement.srcObject = null; // Явно очищаем видео
        showTransparentPage();
        currentTargetWebcamId = null; // Сбрасываем текущую цель
        return;
    }

    console.log("Proceeding to establish new connection for", targetPlayerWebcamId);

    const pc = new RTCPeerConnection(pcConfig);
    pc.targetWebcamId = targetPlayerWebcamId; // Сохраняем ID для легкого доступа
    pc.playerName = playerName;

    // Новое соединение становится "ожидающим"
    // Если уже было другое pending соединение (не должно быть после проверки выше, но на всякий случай)
    if (pendingPeerConnection && pendingPeerConnection !== pc) {
        console.warn("Unexpected existing pending PC, closing it:", pendingPeerConnection.targetWebcamId);
        pendingPeerConnection.close();
    }
    pendingPeerConnection = pc;

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                targetId: pc.targetWebcamId,
                isTargetPlayer: true,
                senderId: observerSessionId
            });
        }
    };

    pc.ontrack = event => {
        console.log(`Ontrack for PC target: ${pc.targetWebcamId}. Current overall target: ${currentTargetWebcamId}. This PC is pending: ${pendingPeerConnection === pc}`);

        // Убедимся, что трек пришел для актуального соединения и цели
        if (pc !== pendingPeerConnection || pc.targetWebcamId !== currentTargetWebcamId) {
            console.log("Ontrack for stale or mismatched PC. Ignoring. Closing this PC if not active.", pc.targetWebcamId);
            if (pc !== activePeerConnection && pc.connectionState !== 'closed') {
                 pc.close(); // Закрываем, если это "заблудившийся" трек для неактуального PC
            }
            return;
        }

        if (event.streams && event.streams[0]) {
            console.log("Valid stream received for", pc.targetWebcamId);
            if(videoElement.srcObject !== event.streams[0]) { // Избегаем лишних присвоений, если объект тот же
                 videoElement.srcObject = event.streams[0];
            }
            videoElement.play().catch(e => {
                console.error("Error playing video for " + pc.targetWebcamId + ":", e);
                if (pendingPeerConnection === pc) pendingPeerConnection = null;
                if (activePeerConnection === pc) activePeerConnection = null; // Если это был активный, он больше не активен
                if(pc.connectionState !== 'closed') pc.close();
                if (currentTargetWebcamId === pc.targetWebcamId) showTransparentPage(); // Показать фон, если текущая цель не удалась
            });
            showVideoElement();

            // Новый стрим активен. Закрываем *предыдущее* активное соединение.
            if (activePeerConnection && activePeerConnection !== pc) {
                console.log("New stream active for", pc.targetWebcamId, ". Closing old active PC for", activePeerConnection.targetWebcamId);
                activePeerConnection.close();
            }
            activePeerConnection = pc; // Этот PC теперь активный
            pendingPeerConnection = null; // Больше не ожидающий
        } else {
            console.warn("Ontrack event without valid stream for", pc.targetWebcamId);
            if (pendingPeerConnection === pc) pendingPeerConnection = null;
            if(pc.connectionState !== 'closed') pc.close(); // Закрываем этот неудачный PC
            // Если этот PC должен был стать активным для currentTargetWebcamId, и нет другого активного PC, показать фон
            if (currentTargetWebcamId === pc.targetWebcamId && activePeerConnection !== pc) {
                 if (!activePeerConnection || activePeerConnection.targetWebcamId !== currentTargetWebcamId) {
                    showTransparentPage();
                 }
            }
        }
    };

    const handleConnectionFailure = (failedPc, type) => {
        console.log(`Connection failure (${type}) for PC target: ${failedPc.targetWebcamId}. State: ${failedPc.connectionState || failedPc.iceConnectionState}`);
        let wasPending = false;
        let wasActive = false;

        if (pendingPeerConnection === failedPc) {
            pendingPeerConnection = null;
            wasPending = true;
        }
        if (activePeerConnection === failedPc) {
            activePeerConnection = null;
            wasActive = true;
        }

        if(failedPc.connectionState !== 'closed') {
            failedPc.close();
        }

        // Если соединение, которое было активным (или должно было стать активным для текущей цели) разорвалось
        if ((wasActive || wasPending) && currentTargetWebcamId === failedPc.targetWebcamId) {
            // И нет другого активного соединения для этой же цели
            if (!activePeerConnection || activePeerConnection.targetWebcamId !== currentTargetWebcamId) {
                console.log("Active/Pending PC failed for current target, showing transparent page.");
                if(videoElement) videoElement.srcObject = null;
                showTransparentPage();
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log(`ICE state for PC target ${pc.targetWebcamId}: ${state}`);
        if (['failed', 'disconnected', 'closed'].includes(state)) {
            handleConnectionFailure(pc, `ICE ${state}`);
        }
    };

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`Connection state for PC target ${pc.targetWebcamId}: ${state}`);
        if (['failed', 'disconnected', 'closed'].includes(state)) {
            handleConnectionFailure(pc, `Connection ${state}`);
        } else if (state === 'connected') {
            // Если это pending PC и он стал connected, ontrack должен был уже сделать его active.
            // Если это active PC (например, переподключился) и видео скрыто, покажем его.
            if (pc === activePeerConnection && videoElement.srcObject && videoElement.style.display === 'none') {
                 console.log("Active PC re-connected, ensuring video is visible for", pc.targetWebcamId);
                 showVideoElement();
            }
        }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    try {
        console.log("Creating offer for", pc.targetWebcamId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', {
            offer: offer,
            targetWebcamId: pc.targetWebcamId,
            senderWebcamId: observerSessionId
        });
    } catch (e) {
        console.error("Error creating offer for " + pc.targetWebcamId + ":", e);
        if (pendingPeerConnection === pc) pendingPeerConnection = null;
        if(pc.connectionState !== 'closed') pc.close();
        // Если этот неудачный PC был для текущей цели, и нет другого активного, показать фон
        if (currentTargetWebcamId === pc.targetWebcamId && (!activePeerConnection || activePeerConnection.targetWebcamId !== currentTargetWebcamId)) {
            showTransparentPage();
        }
    }
}

socket.on('spectate_change', (data) => {
    const { nickname, webcamId, showWebcam } = data;
    console.log("Socket event: spectate_change", data);
    connectToPlayerStream(webcamId, nickname, showWebcam === undefined ? true : showWebcam);
});

socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => {
    if (viewerWebcamId !== observerSessionId) return;

    const targetPC = (pendingPeerConnection?.targetWebcamId === playerWebcamId) ? pendingPeerConnection :
                     ((activePeerConnection?.targetWebcamId === playerWebcamId) ? activePeerConnection : null);

    if (!targetPC) {
        console.log("Received answer for unknown or stale PC:", playerWebcamId);
        return;
    }
    if (targetPC.signalingState === 'closed') {
        console.log("Received answer for PC that is already closed:", playerWebcamId);
        return;
    }

    console.log("Received answer for", playerWebcamId, ". PC target:", targetPC.targetWebcamId, ". Current signaling state:", targetPC.signalingState);
    if (targetPC.signalingState === 'have-local-offer' || targetPC.signalingState === 'stable') { // stable - если оффер был "переотправлен"
        try {
            await targetPC.setRemoteDescription(new RTCSessionDescription(answer));
            console.log("Remote description set for", playerWebcamId);
        } catch (e) {
            console.error(`Error setting remote description for ${playerWebcamId} (PC target ${targetPC.targetWebcamId}):`, e);
            // Этот PC не смог обработать ответ, считаем его неудачным
            if (pendingPeerConnection === targetPC) pendingPeerConnection = null;
            if (activePeerConnection === targetPC) {
                activePeerConnection = null;
                 if (currentTargetWebcamId === targetPC.targetWebcamId) { // Если он был активным для текущей цели
                    if(videoElement) videoElement.srcObject = null;
                    showTransparentPage();
                 }
            }
            if(targetPC.connectionState !== 'closed') targetPC.close();
        }
    } else {
        console.warn("Received answer for", playerWebcamId, "but PC signaling state is", targetPC.signalingState);
    }
});

socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => {
    if (forTargetId !== observerSessionId) return;

    const targetPC = (pendingPeerConnection?.targetWebcamId === iceSenderId) ? pendingPeerConnection :
                     ((activePeerConnection?.targetWebcamId === iceSenderId) ? activePeerConnection : null);

    if (!targetPC) {
        // console.log("Received ICE for unknown or stale PC from sender:", iceSenderId); // Может быть много логов
        return;
    }
    if (targetPC.signalingState === 'closed') {
        // console.log("Received ICE for PC that is already closed:", iceSenderId);
        return;
    }

    if (candidate) {
        try {
            await targetPC.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            // console.error(`Error adding ICE candidate from ${iceSenderId} for PC target ${targetPC.targetWebcamId}:`, e); // Может быть много логов
        }
    }
});

socket.on('connect', () => {
    console.log("Socket connected to server (observerfull).");
    // При подключении, сервер может прислать 'spectate_change'.
    // Сбрасываем локальное состояние на случай переподключения.
    if(pendingPeerConnection) { pendingPeerConnection.close(); pendingPeerConnection = null;}
    if(activePeerConnection) { activePeerConnection.close(); activePeerConnection = null;}
    currentTargetWebcamId = null;
    if(videoElement) videoElement.srcObject = null;
    showTransparentPage();
});

socket.on('disconnect', () => {
    console.log("Socket disconnected from server (observerfull). Cleaning up connections.");
    if (pendingPeerConnection) {
        pendingPeerConnection.close();
        pendingPeerConnection = null;
    }
    if (activePeerConnection) {
        activePeerConnection.close();
        activePeerConnection = null;
    }
    currentTargetWebcamId = null;
    if(videoElement) videoElement.srcObject = null; // Очищаем видео при дисконнекте
    showTransparentPage();
});