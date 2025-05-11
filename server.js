// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Для разработки; в продакшене ограничьте
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;
// Устанавливаем пустую строку, чтобы НЕ использовать GSI токен.
// Если решите использовать, впишите сюда токен и такой же в CS2 GSI .cfg файл.
const GSI_AUTH_TOKEN = ""; // РАБОТА БЕЗ ТОКЕНА

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

let players = {}; // { nickname: { webcamId, steamID, socketId } }
let currentSpectatedSteamID = null;
let gsiPlayerNames = {}; // { steamID: 'gsiName' } - обновляется при каждом GSI POST

app.post('/gsi', (req, res) => {
    const gsiData = req.body;

    // Проверка токена, только если GSI_AUTH_TOKEN не пустой на сервере
    if (GSI_AUTH_TOKEN) { 
        if (!gsiData.auth || gsiData.auth.token !== GSI_AUTH_TOKEN) {
            console.warn('GSI: Unauthorized request. Token mismatch or missing from client.');
            return res.status(401).send('Unauthorized');
        }
    }
    // Если GSI_AUTH_TOKEN пустой, проверка выше не выполняется, запросы принимаются.

    // console.log('GSI data received at:', new Date().toISOString()); // Лог времени получения GSI
    // if (gsiData.allplayers) {
    //     console.log('GSI allplayers:', JSON.stringify(gsiData.allplayers, null, 2));
    // } else {
    //     console.log('GSI: No allplayers data in this payload.');
    // }


    let newSpectatedSteamID = null;
    if (gsiData.player && gsiData.player.steamid && gsiData.player.activity === 'playing') {
        if (gsiData.player.spectarget) newSpectatedSteamID = gsiData.player.spectarget;
    }

    // Обновление gsiPlayerNames при каждом валидном GSI запросе
    const tempGsiPlayerNames = {};
    if (gsiData.allplayers) {
        for (const steamID in gsiData.allplayers) {
            const playerNameFromGSI = gsiData.allplayers[steamID].name;
            if (playerNameFromGSI) {
                tempGsiPlayerNames[steamID] = playerNameFromGSI;
                // Попытка авто-связывания SteamID с уже зарегистрированным игроком по нику (если SteamID еще не связан)
                const playerToUpdate = Object.values(players).find(p => p.nickname === playerNameFromGSI && !p.steamID);
                if (playerToUpdate) {
                    playerToUpdate.steamID = steamID;
                    console.log(`GSI: Auto-linked SteamID ${steamID} to player ${playerToUpdate.nickname}.`);
                    io.emit('player_update', { nickname: playerToUpdate.nickname, webcamId: playerToUpdate.webcamId, steamID: playerToUpdate.steamID });
                }
            }
        }
    }
    gsiPlayerNames = tempGsiPlayerNames; // Перезаписываем свежими данными
    // console.log('GSI: Updated gsiPlayerNames:', gsiPlayerNames);


    if (newSpectatedSteamID !== currentSpectatedSteamID) {
        currentSpectatedSteamID = newSpectatedSteamID;
        let targetNickname = "Unknown"; let targetWebcamId = null;
        const registeredPlayer = Object.values(players).find(p => p.steamID === currentSpectatedSteamID);
        if (registeredPlayer) { targetNickname = registeredPlayer.nickname; targetWebcamId = registeredPlayer.webcamId; }
        else if (gsiPlayerNames[currentSpectatedSteamID]) targetNickname = gsiPlayerNames[currentSpectatedSteamID];
        console.log(`GSI: Spectate change -> ${targetNickname} (SteamID: ${currentSpectatedSteamID || 'N/A'}, Webcam: ${targetWebcamId || 'N/A'})`);
        io.emit('spectate_change', { steamID: currentSpectatedSteamID, nickname: targetNickname, webcamId: targetWebcamId });
    } else if (!newSpectatedSteamID && currentSpectatedSteamID !== null) {
        currentSpectatedSteamID = null;
        console.log("GSI: Spectate change -> No specific player.");
        io.emit('spectate_change', { steamID: null, nickname: null, webcamId: null });
    }
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('Socket.IO: User connected:', socket.id);
    const currentActivePlayers = Object.values(players).filter(p => p.webcamId && p.socketId).map(p => ({ nickname: p.nickname, webcamId: p.webcamId, steamID: p.steamID }));
    socket.emit('current_players', currentActivePlayers); // Для observer.js

    socket.on('request_player_setup_data', () => {
        console.log(`Socket.IO: Received request_player_setup_data from socket ${socket.id}. Current gsiPlayerNames:`, gsiPlayerNames);
        const serverPlayersList = [];
        for (const steamID in gsiPlayerNames) { // Используем актуальный gsiPlayerNames
            const gsiName = gsiPlayerNames[steamID];
            // Проверка, зарегистрирован ли игрок (по SteamID или по никнейму с активным сокетом)
            const isRegisteredBySteamID = Object.values(players).some(p => p.steamID === steamID && p.socketId);
            const isRegisteredByNickname = players[gsiName] && players[gsiName].socketId;
            
            serverPlayersList.push({
                name: gsiName,
                steamID: steamID,
                isRegistered: isRegisteredBySteamID || isRegisteredByNickname 
            });
        }
        console.log(`Socket.IO: Sending player_setup_data_available with ${serverPlayersList.length} GSI players.`);
        socket.emit('player_setup_data_available', serverPlayersList);
    });

    socket.on('register_player', (data) => {
        const { nickname, webcamId, steamID } = data;
        console.log(`Socket.IO: register_player attempt:`, data);
        if (!nickname || !webcamId) { socket.emit('registration_error', 'Nickname and webcamId are required.'); console.warn(`Socket.IO: Reg failed (socket ${socket.id}): Nickname/webcamId missing.`); return; }
        
        const existingPlayer = Object.values(players).find(p => ((p.nickname === nickname && p.steamID === steamID) || (p.steamID && p.steamID === steamID)) && p.socketId !== socket.id );
        if (existingPlayer) {
            socket.emit('registration_error', `Player ${nickname} (SteamID: ${steamID}) is already registered by another session.`);
            console.warn(`Socket.IO: Reg failed for ${nickname}: Player already registered by another session.`);
            return;
        }
        const existingPlayerByWebcamId = Object.values(players).find(p => p.webcamId === webcamId && p.socketId !== socket.id);
        if (existingPlayerByWebcamId) {
             socket.emit('registration_error', `Webcam ID ${webcamId} is already in use by player ${existingPlayerByWebcamId.nickname}.`);
             console.warn(`Socket.IO: Reg failed for ${nickname}: Webcam ID ${webcamId} in use.`);
             return;
        }

        players[nickname] = { nickname, webcamId, steamID, socketId: socket.id };
        console.log(`Socket.IO: Player registered/updated: ${nickname} (Webcam: ${webcamId}, SteamID: ${steamID || 'N/A'}, Socket: ${socket.id})`);
        io.emit('player_update', { nickname, webcamId, steamID: players[nickname].steamID });
        socket.emit('registration_success', players[nickname]);
    });

    socket.on('webrtc_offer', ({ offer, targetWebcamId, senderWebcamId }) => {
        const targetPlayer = Object.values(players).find(p => p.webcamId === targetWebcamId);
        if (targetPlayer && targetPlayer.socketId) { console.log(`Socket.IO: Signaling: Forwarding Offer from ${senderWebcamId} to ${targetPlayer.nickname}`); io.to(targetPlayer.socketId).emit('webrtc_offer_from_viewer', { offer, viewerWebcamId: senderWebcamId }); }
        else { console.warn(`Socket.IO: Signaling: Offer - Target ${targetWebcamId} not found. From ${senderWebcamId}.`); socket.emit('webrtc_error', { targetWebcamId, message: 'Target player not found' }); }
    });
    socket.on('webrtc_answer', ({ answer, targetViewerWebcamId, senderPlayerWebcamId }) => { console.log(`Socket.IO: Signaling: Forwarding Answer from ${senderPlayerWebcamId} to ${targetViewerWebcamId}`); io.emit('webrtc_answer_to_viewer', { answer, playerWebcamId: senderPlayerWebcamId, viewerWebcamId: targetViewerWebcamId }); });
    socket.on('webrtc_ice_candidate', ({ candidate, targetId, isTargetPlayer, senderId }) => {
        let recipientSocketId = null;
        if (isTargetPlayer) { const targetPlayer = Object.values(players).find(p => p.webcamId === targetId); if (targetPlayer && targetPlayer.socketId) recipientSocketId = targetPlayer.socketId; }
        else { io.emit('webrtc_ice_candidate_to_client', { candidate, forTargetId: targetId, iceSenderId: senderId }); return; }
        if (recipientSocketId) io.to(recipientSocketId).emit('webrtc_ice_candidate_from_peer', { candidate, iceSenderId: senderId });
    });
    socket.on('disconnect', () => {
        console.log('Socket.IO: User disconnected:', socket.id);
        for (const nickname in players) { if (players[nickname].socketId === socket.id) { const { webcamId } = players[nickname]; console.log(`Socket.IO: Player ${nickname} (Webcam: ${webcamId}) disconnected.`); delete players[nickname]; io.emit('player_left', { nickname, webcamId }); break; } }
    });
});

server.listen(PORT, () => {
    console.log(`CS2 Observer Cam Server running on http://localhost:${PORT}`);
    console.log(`GSI Endpoint: ${process.env.RAILWAY_STATIC_URL ? 'https://' + process.env.RAILWAY_STATIC_URL : 'http://<your-deployed-url>'}/gsi`);
});