// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Для разработки; в продакшене ограничьте конкретным доменом
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;
// Установите ваш секретный токен здесь.
// Если вы НЕ ХОТИТЕ использовать токен, оставьте эту строку пустой (GSI_AUTH_TOKEN = "";)
// И ОБЯЗАТЕЛЬНО удалите/закомментируйте секцию 'auth' в вашем CS2 GSI .cfg файле.
// Для публичных URL рекомендуется использовать токен.
const GSI_AUTH_TOKEN = "YOUR_SECRET_GSI_TOKEN_HERE"; // << ЗАМЕНИТЕ ИЛИ ОСТАВЬТЕ ПУСТЫМ

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

let players = {}; // { nickname: { webcamId, steamID, socketId } }
let currentSpectatedSteamID = null;
let gsiPlayerNames = {}; // { steamID: 'gsiName' }

app.post('/gsi', (req, res) => {
    const gsiData = req.body;

    // Проверка токена, если он задан на сервере
    if (GSI_AUTH_TOKEN) { // Эта проверка сработает, только если GSI_AUTH_TOKEN не пустой
        if (!gsiData.auth || gsiData.auth.token !== GSI_AUTH_TOKEN) {
            console.warn('GSI: Unauthorized request. Token mismatch or missing from client.');
            return res.status(401).send('Unauthorized');
        }
    }

    // console.log('GSI data received:', JSON.stringify(gsiData, null, 2)); // DEBUG

    let newSpectatedSteamID = null;
    if (gsiData.player && gsiData.player.steamid && gsiData.player.activity === 'playing') {
        if (gsiData.player.spectarget) {
            newSpectatedSteamID = gsiData.player.spectarget;
        }
    }

    if (gsiData.allplayers) {
        for (const steamID in gsiData.allplayers) {
            const playerNameFromGSI = gsiData.allplayers[steamID].name;
            if (playerNameFromGSI) {
                gsiPlayerNames[steamID] = playerNameFromGSI;
                const playerToUpdate = Object.values(players).find(p => p.nickname === playerNameFromGSI && !p.steamID);
                if (playerToUpdate) {
                    playerToUpdate.steamID = steamID;
                    console.log(`GSI: Auto-linked SteamID ${steamID} to player ${playerToUpdate.nickname}.`);
                    io.emit('player_update', { nickname: playerToUpdate.nickname, webcamId: playerToUpdate.webcamId, steamID: playerToUpdate.steamID });
                }
            }
        }
    }

    if (newSpectatedSteamID !== currentSpectatedSteamID) {
        currentSpectatedSteamID = newSpectatedSteamID;
        let targetNickname = "Unknown";
        let targetWebcamId = null;
        const registeredPlayer = Object.values(players).find(p => p.steamID === currentSpectatedSteamID);
        if (registeredPlayer) {
            targetNickname = registeredPlayer.nickname;
            targetWebcamId = registeredPlayer.webcamId;
        } else if (gsiPlayerNames[currentSpectatedSteamID]) {
            targetNickname = gsiPlayerNames[currentSpectatedSteamID];
        }
        console.log(`GSI: Spectate change -> ${targetNickname} (SteamID: ${currentSpectatedSteamID || 'N/A'}, Webcam: ${targetWebcamId || 'N/A'})`);
        io.emit('spectate_change', { steamID: currentSpectatedSteamID, nickname: targetNickname, webcamId: targetWebcamId });
    } else if (!newSpectatedSteamID && currentSpectatedSteamID !== null) {
        currentSpectatedSteamID = null;
        console.log("GSI: Spectate change -> No specific player (free cam/overview).");
        io.emit('spectate_change', { steamID: null, nickname: null, webcamId: null });
    }
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('Socket.IO: User connected:', socket.id);
    const currentActivePlayers = Object.values(players)
        .filter(p => p.webcamId && p.socketId)
        .map(p => ({ nickname: p.nickname, webcamId: p.webcamId, steamID: p.steamID }));
    socket.emit('current_players', currentActivePlayers);

    socket.on('register_player', (data) => {
        const { nickname, webcamId, steamID } = data;
        console.log(`Socket.IO: register_player attempt:`, data);
        if (!nickname || !webcamId) {
            socket.emit('registration_error', 'Nickname and webcamId are required.');
            console.warn(`Socket.IO: Reg failed (socket ${socket.id}): Nickname/webcamId missing.`);
            return;
        }
        if (players[nickname] && players[nickname].socketId !== socket.id) {
            socket.emit('registration_error', `Nickname ${nickname} is already in use by another session.`);
            return;
        }
        const existingPlayerByWebcamId = Object.values(players).find(p => p.webcamId === webcamId && p.nickname !== nickname);
        if (existingPlayerByWebcamId) {
             socket.emit('registration_error', `Webcam ID ${webcamId} is already in use by player ${existingPlayerByWebcamId.nickname}.`);
             return;
        }
        players[nickname] = {
            nickname, webcamId,
            steamID: steamID || (gsiPlayerNames && Object.keys(gsiPlayerNames).find(sid => gsiPlayerNames[sid] === nickname)) || players[nickname]?.steamID || null,
            socketId: socket.id
        };
        console.log(`Socket.IO: Player registered/updated: ${nickname} (Webcam: ${webcamId}, SteamID: ${players[nickname].steamID}, Socket: ${socket.id})`);
        io.emit('player_update', { nickname, webcamId, steamID: players[nickname].steamID });
        socket.emit('registration_success', players[nickname]);
    });

    socket.on('webrtc_offer', ({ offer, targetWebcamId, senderWebcamId }) => {
        const targetPlayer = Object.values(players).find(p => p.webcamId === targetWebcamId);
        if (targetPlayer && targetPlayer.socketId) {
            console.log(`Socket.IO: Signaling: Forwarding WebRTC offer from ${senderWebcamId} to player ${targetPlayer.nickname} (${targetPlayer.socketId})`);
            io.to(targetPlayer.socketId).emit('webrtc_offer_from_viewer', { offer, viewerWebcamId: senderWebcamId });
        } else {
            console.warn(`Socket.IO: Signaling: WebRTC Offer - Target player ${targetWebcamId} not found/connected. Offer from ${senderWebcamId}.`);
            socket.emit('webrtc_error', { targetWebcamId, message: 'Target player not found or not connected.'});
        }
    });

    socket.on('webrtc_answer', ({ answer, targetViewerWebcamId, senderPlayerWebcamId }) => {
        console.log(`Socket.IO: Signaling: Forwarding WebRTC answer from player ${senderPlayerWebcamId} to viewer ${targetViewerWebcamId}`);
        io.emit('webrtc_answer_to_viewer', { answer, playerWebcamId: senderPlayerWebcamId, viewerWebcamId: targetViewerWebcamId });
    });

    socket.on('webrtc_ice_candidate', ({ candidate, targetId, isTargetPlayer, senderId }) => {
        // console.log(`Socket.IO: Signaling: ICE from ${senderId} for ${targetId} (isTargetPlayer: ${isTargetPlayer})`); // DEBUG
        let recipientSocketId = null;
        if (isTargetPlayer) {
            const targetPlayer = Object.values(players).find(p => p.webcamId === targetId);
            if (targetPlayer && targetPlayer.socketId) recipientSocketId = targetPlayer.socketId;
        } else {
            io.emit('webrtc_ice_candidate_to_client', { candidate, forTargetId: targetId, iceSenderId: senderId });
            return; 
        }
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('webrtc_ice_candidate_from_peer', { candidate, iceSenderId: senderId });
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket.IO: User disconnected:', socket.id);
        for (const nickname in players) {
            if (players[nickname].socketId === socket.id) {
                const { webcamId } = players[nickname];
                console.log(`Socket.IO: Player ${nickname} (Webcam: ${webcamId}) disconnected.`);
                delete players[nickname];
                io.emit('player_left', { nickname, webcamId });
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`CS2 Observer Cam Server is running on http://localhost:${PORT}`);
    console.log(`GSI Endpoint configured for http://<your-railway-app-public-url>/gsi`);
});