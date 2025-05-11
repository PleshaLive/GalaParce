const socket = io();
const videoElement = document.getElementById('observerFullVideo');
// const videoPlaceholder = document.getElementById('videoPlaceholder'); // Закомментировано, так как не используется активно для текста

let activePeerConnection = null; // Активное соединение, которое сейчас показывает видео
let pendingPeerConnection = null; // Соединение, которое настраивается для замены активного
let currentTargetWebcamId = null; // ID вебкамеры, которую мы пытаемся отобразить
const observerSessionId = 'obs-full-' + Math.random().toString(36).substring(2, 9);

if (!videoElement) console.error("ObserverFullJS: CRITICAL - Video element 'observerFullVideo' not found!");

const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function showTransparentPage() {
    if (videoElement) {
        videoElement.style.display = 'none';
        // videoElement.srcObject = null; // Очистка srcObject происходит при закрытии PC или явной остановке
    }
    // Если бы videoPlaceholder использовался для текста "Нет сигнала", его можно было бы показать здесь:
    // if (videoPlaceholder) videoPlaceholder.style.display = 'flex';
    console.log("Showing transparent page (video hidden).");
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
                showVideoElement(); // Убедимся, что видео показывается
            }
            return;
        }
    }

    // const oldTargetWebcamId = currentTargetWebcamId; // Если понадобится для отладки
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
    if (pendingPeerConnection && pendingPeerConnection !== pc) { // Должно было быть закрыто выше, если цель изменилась
        console.warn("Unexpected existing pending PC while creating new one, closing it:", pendingPeerConnection.targetWebcamId);
        pendingPeerConnection.close();
    }
    pendingPeerConnection = pc;

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', {
                candidate: event.candidate,
                targetId: pc.targetWebcamId, // Используем pc.targetWebcamId
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
                 pc.close();
            }
            return;
        }

        if (event.streams && event.streams[0]) {
            console.log("Valid stream received for", pc.targetWebcamId);
            const newStream = event.streams[0];
            pc.stream = newStream; // Сохраняем ссылку на поток в объекте PC на всякий случай

            const oldActivePcToClose = activePeerConnection;

            if (videoElement.srcObject !== newStream) {
                videoElement.srcObject = newStream;
            }
            // videoElement.muted = true; // Если нужно принудительно выключить звук

            videoElement.play().then(() => {
                console.log("Video play() promise resolved for", pc.targetWebcamId);
                showVideoElement(); // Убедимся, что видеоэлемент видим

                const onPlayingHandler = () => {
                    console.log("Video 'playing' event fired for", pc.targetWebcamId);
                    videoElement.removeEventListener('playing', onPlayingHandler);

                    if (oldActivePcToClose && oldActivePcToClose !== pc) {
                        console.log("New stream confirmed playing for", pc.targetWebcamId, ". Closing old active PC for", oldActivePcToClose.targetWebcamId);
                        oldActivePcToClose.close();
                    }
                    activePeerConnection = pc;
                    if (pendingPeerConnection === pc) {
                        pendingPeerConnection = null;
                    }
                };
                videoElement.addEventListener('playing', onPlayingHandler);

            }).catch(e => {
                console.error("Error on video.play() for " + pc.targetWebcamId + ":", e);

                if (videoElement.srcObject === newStream) {
                    videoElement.srcObject = null;
                }

                if (pendingPeerConnection === pc) {
                    pendingPeerConnection = null;
                }
                if (pc.connectionState !== 'closed') {
                    pc.close();
                }

                if (currentTargetWebcamId === pc.targetWebcamId) {
                    if (!oldActivePcToClose || oldActivePcToClose.targetWebcamId !== currentTargetWebcamId) {
                        console.log("Play failed for new stream, and no valid old stream for current target. Showing transparent.");
                        showTransparentPage();
                    } else if (oldActivePcToClose && oldActivePcToClose.stream && videoElement.srcObject !== oldActivePcToClose.stream) {
                        // Попытка восстановить старый поток, если он был затер и play() нового не удался
                        console.log("Play failed for new stream, attempting to restore previous stream for " + oldActivePcToClose.targetWebcamId);
                        videoElement.srcObject = oldActivePcToClose.stream;
                        videoElement.play().catch(restoreErr => console.error("Error restoring old stream:", restoreErr));
                        showVideoElement(); // Убедимся, что видео снова показывается
                    }
                }
            });
        } else {
            console.warn("Ontrack event without valid stream for", pc.targetWebcamId);
            if (pendingPeerConnection === pc) pendingPeerConnection = null;
            if (pc.connectionState !== 'closed') pc.close();
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

        if (failedPc.connectionState !== 'closed') {
            failedPc.close();
        }

        if ((wasActive || wasPending) && currentTargetWebcamId === failedPc.targetWebcamId) {
            if (!activePeerConnection || activePeerConnection.targetWebcamId !== currentTargetWebcamId) {
                console.log("Critical PC failed for current target, showing transparent page.");
                if (videoElement) videoElement.srcObject = null;
                showTransparentPage();
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        // console.log(`ICE state for PC target ${pc.targetWebcamId}: ${state}`); // Может быть слишком много логов
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
            if (pc === activePeerConnection && videoElement.srcObject && videoElement.style.display === 'none') {
                 console.log("Active PC re-connected/confirmed, ensuring video is visible for", pc.targetWebcamId);
                 showVideoElement();
            } else if (pc === pendingPeerConnection && pc.targetWebcamId === currentTargetWebcamId) {
                // Если pending стал connected, ontrack должен был уже обработать.
                // Это состояние полезно для отладки.
                console.log("Pending PC for", pc.targetWebcamId, "is now 'connected'. Ontrack should follow if not already processed.");
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
        if (pc.connectionState !== 'closed') pc.close();
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
    if (targetPC.signalingState === 'have-local-offer' || targetPC.signalingState === 'stable') {
        try {
            await targetPC.setRemoteDescription(new RTCSessionDescription(answer));
            console.log("Remote description set for", playerWebcamId);
        } catch (e) {
            console.error(`Error setting remote description for ${playerWebcamId} (PC target ${targetPC.targetWebcamId}):`, e);
            if (pendingPeerConnection === targetPC) pendingPeerConnection = null;
            if (activePeerConnection === targetPC) {
                activePeerConnection = null;
                 if (currentTargetWebcamId === targetPC.targetWebcamId) {
                    if (videoElement) videoElement.srcObject = null;
                    showTransparentPage();
                 }
            }
            if (targetPC.connectionState !== 'closed') targetPC.close();
        }
    } else {
        console.warn("Received answer for", playerWebcamId, "but PC signaling state is", targetPC.signalingState, "(expected have-local-offer or stable)");
    }
});

socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => {
    if (forTargetId !== observerSessionId) return;

    const targetPC = (pendingPeerConnection?.targetWebcamId === iceSenderId) ? pendingPeerConnection :
                     ((activePeerConnection?.targetWebcamId === iceSenderId) ? activePeerConnection : null);

    if (!targetPC) {
        // console.log("Received ICE for unknown or stale PC from sender:", iceSenderId); // Очень много логов может быть
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
            // console.error(`Error adding ICE candidate from ${iceSenderId} for PC target ${targetPC.targetWebcamId}:`, e); // Много логов
        }
    }
});

socket.on('connect', () => {
    console.log("Socket connected to server (observerfull).");
    if (pendingPeerConnection) { pendingPeerConnection.close(); pendingPeerConnection = null; }
    if (activePeerConnection) { activePeerConnection.close(); activePeerConnection = null; }
    currentTargetWebcamId = null;
    if (videoElement) videoElement.srcObject = null;
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
    if (videoElement) videoElement.srcObject = null;
    showTransparentPage();
});