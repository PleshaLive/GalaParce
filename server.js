// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3001;
const GSI_AUTH_TOKEN = ""; // РАБОТА БЕЗ ТОКЕНА

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

let players = {}; 
let currentSpectatedSteamID = null;
let gsiPlayerNames = {}; 

app.post('/gsi', (req, res) => {
    const gsiData = req.body;
    if (GSI_AUTH_TOKEN) { 
        if (!gsiData.auth || gsiData.auth.token !== GSI_AUTH_TOKEN) {
            console.warn('GSI: Unauthorized request.'); return res.status(401).send('Unauthorized');
        }
    }
    let newSpectatedSteamID = null;
    if (gsiData.player && gsiData.player.steamid && gsiData.player.activity === 'playing') {
        if (gsiData.player.spectarget) newSpectatedSteamID = gsiData.player.spectarget;
    }
    const tempGsiPlayerNames = {};
    if (gsiData.allplayers) {
        for (const steamID in gsiData.allplayers) {
            const playerNameFromGSI = gsiData.allplayers[steamID].name;
            if (playerNameFromGSI) {
                tempGsiPlayerNames[steamID] = playerNameFromGSI;
                const playerToUpdate = Object.values(players).find(p => p.nickname === playerNameFromGSI && !p.steamID);
                if (playerToUpdate) {
                    playerToUpdate.steamID = steamID;
                    io.emit('player_update', { nickname: playerToUpdate.nickname, webcamId: playerToUpdate.webcamId, steamID: playerToUpdate.steamID });
                }
            }
        }
    }
    gsiPlayerNames = tempGsiPlayerNames; 
    if (newSpectatedSteamID !== currentSpectatedSteamID) {
        currentSpectatedSteamID = newSpectatedSteamID;
        let targetNickname = "Unknown"; let targetWebcamId = null;
        const registeredPlayer = Object.values(players).find(p => p.steamID === currentSpectatedSteamID);
        if (registeredPlayer) { targetNickname = registeredPlayer.nickname; targetWebcamId = registeredPlayer.webcamId; }
        else if (gsiPlayerNames[currentSpectatedSteamID]) targetNickname = gsiPlayerNames[currentSpectatedSteamID];
        console.log(`GSI: Spectate change -> ${targetNickname} (SteamID: ${currentSpectatedSteamID || 'N/A'}, Webcam: ${targetWebcamId || 'N/A'})`);
        io.emit('spectate_change', { steamID: currentSpectatedSteamID, nickname: targetNickname, webcamId: targetWebcamId });
    } else if (!newSpectatedSteamID && currentSpectatedSteamID !== null) {
        currentSpectatedSteamID = null; console.log("GSI: Spectate change -> No specific player.");
        io.emit('spectate_change', { steamID: null, nickname: null, webcamId: null });
    }
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('Socket.IO: User connected:', socket.id);
    const currentActivePlayers = Object.values(players).filter(p=>p.webcamId && p.socketId).map(p=>({nickname:p.nickname, webcamId:p.webcamId, steamID:p.steamID}));
    socket.emit('current_players', currentActivePlayers);

    socket.on('request_player_setup_data', () => {
        const serverPlayersList = [];
        for (const steamID in gsiPlayerNames) {
            const gsiName = gsiPlayerNames[steamID];
            const isRegistered = Object.values(players).some(p => (p.steamID === steamID || p.nickname === gsiName) && p.socketId && p.webcamId);
            serverPlayersList.push({ name: gsiName, steamID: steamID, isRegistered: isRegistered });
        }
        socket.emit('player_setup_data_available', serverPlayersList);
    });

    socket.on('register_player', (data) => {
        const { nickname, webcamId, steamID } = data;
        if (!nickname || !webcamId) { socket.emit('registration_error', 'Nickname and webcamId required.'); return; }
        const existingPlayerByReg = Object.values(players).find(p => (p.steamID === steamID || p.nickname === nickname) && p.socketId !== socket.id && p.webcamId);
        if (existingPlayerByReg) { socket.emit('registration_error', `Player ${nickname} (SteamID: ${steamID}) already has an active webcam.`); return; }
        const existingPlayerByWebcamId = Object.values(players).find(p => p.webcamId === webcamId && p.socketId !== socket.id);
        if (existingPlayerByWebcamId) { socket.emit('registration_error', `Webcam ID ${webcamId} is already in use.`); return; }
        
        // Удаляем старую регистрацию этого сокета, если была (полезно при переподвязке)
        for (const oldNickname in players) {
            if (players[oldNickname].socketId === socket.id) {
                console.log(`Socket.IO: Player ${oldNickname} (socket ${socket.id}) is re-registering. Removing old entry.`);
                const oldWebcamId = players[oldNickname].webcamId;
                delete players[oldNickname];
                io.emit('player_left', { nickname: oldNickname, webcamId: oldWebcamId }); // Сообщаем, что старая "ушла"
                break; 
            }
        }

        players[nickname] = { nickname, webcamId, steamID, socketId: socket.id };
        console.log(`Socket.IO: Player registered: ${nickname} (Webcam: ${webcamId}, SteamID: ${steamID || 'N/A'}, Socket: ${socket.id})`);
        io.emit('player_update', { nickname, webcamId, steamID: players[nickname].steamID, isRegistered: true });
        socket.emit('registration_success', players[nickname]);
    });

    // НОВЫЙ ОБРАБОТЧИК для отключения камеры игроком
    socket.on('unregister_player', (data) => {
        const { nickname, webcamId } = data; // nickname может быть не точным, если он менялся, webcamId надежнее
        console.log(`Socket.IO: Received unregister_player for webcamId: ${webcamId}, nickname: ${nickname}`);
        
        let foundPlayerNickname = null;
        for (const nick in players) {
            if (players[nick].webcamId === webcamId && players[nick].socketId === socket.id) {
                foundPlayerNickname = nick;
                break;
            }
        }

        if (foundPlayerNickname) {
            console.log(`Socket.IO: Unregistering player ${foundPlayerNickname} (Webcam: ${webcamId})`);
            delete players[foundPlayerNickname];
            io.emit('player_left', { nickname: foundPlayerNickname, webcamId: webcamId });
            socket.emit('unregistration_success'); // Оповещаем клиента об успехе
             // Обновляем список доступных игроков для всех клиентов на странице player.html
            const serverPlayersList = [];
            for (const steamID_ in gsiPlayerNames) {
                const gsiName_ = gsiPlayerNames[steamID_];
                const isRegistered_ = Object.values(players).some(p => (p.steamID === steamID_ || p.nickname === gsiName_) && p.socketId && p.webcamId);
                serverPlayersList.push({ name: gsiName_, steamID: steamID_, isRegistered: isRegistered_ });
            }
            io.emit('player_setup_data_available', serverPlayersList); // Отправляем всем, т.к. доступность изменилась

        } else {
            console.warn(`Socket.IO: unregister_player - player with webcamId ${webcamId} and socket ${socket.id} not found.`);
            socket.emit('unregistration_failed', 'Player not found or not yours.');
        }
    });

    socket.on('webrtc_offer', ({ offer, targetWebcamId, senderWebcamId }) => { /* ... код как в #37 ... */ });
    socket.on('webrtc_answer', ({ answer, targetViewerWebcamId, senderPlayerWebcamId }) => { /* ... код как в #37 ... */ });
    socket.on('webrtc_ice_candidate', ({ candidate, targetId, isTargetPlayer, senderId }) => { /* ... код как в #37 ... */ });
    socket.on('disconnect', () => {
        console.log('Socket.IO: User disconnected:', socket.id);
        let unregisteredNickname = null;
        let unregisteredWebcamId = null;
        for (const nickname in players) { 
            if (players[nickname].socketId === socket.id) { 
                unregisteredNickname = nickname;
                unregisteredWebcamId = players[nickname].webcamId;
                console.log(`Socket.IO: Player ${nickname} (Webcam: ${players[nickname].webcamId}) disconnected due to socket disconnect.`); 
                delete players[nickname]; 
                io.emit('player_left', { nickname: unregisteredNickname, webcamId: unregisteredWebcamId }); 
                // Обновляем список доступных игроков для всех клиентов на странице player.html
                const serverPlayersList = [];
                for (const steamID_ in gsiPlayerNames) {
                    const gsiName_ = gsiPlayerNames[steamID_];
                    const isRegistered_ = Object.values(players).some(p => (p.steamID === steamID_ || p.nickname === gsiName_) && p.socketId && p.webcamId);
                    serverPlayersList.push({ name: gsiName_, steamID: steamID_, isRegistered: isRegistered_ });
                }
                io.emit('player_setup_data_available', serverPlayersList);
                break; 
            } 
        }
    });
});
// Копипаст WebRTC обработчиков из предыдущего ответа #37:
io.on('connection', (socket) => {
    // ... (все предыдущие обработчики внутри io.on('connection', ...) остаются)
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
});


server.listen(PORT, () => {
    console.log(`CS2 Observer Cam Server running on http://localhost:${PORT}`);
    const railwayUrl = process.env.RAILWAY_STATIC_URL ? 'https://' + process.env.RAILWAY_STATIC_URL : 'http://<your-deployed-url>';
    console.log(`GSI Endpoint expected at: ${railwayUrl}/gsi`);
});