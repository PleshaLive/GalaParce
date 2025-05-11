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
// Установлена пустая строка для работы БЕЗ GSI токена.
// Убедитесь, что в вашем CS2 GSI .cfg файле ОТСУТСТВУЕТ или закомментирована секция 'auth'.
const GSI_AUTH_TOKEN = ""; 

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// Структура объекта players:
// players = {
//   "NicknameИгрока": {
//     webcamId: "некий_id_камеры",
//     steamID: "его_steam_id",
//     socketId: "id_его_сокет_соединения",
//     showWebcam: true // true - показывать камеру, false - показывать плейсхолдер/альфу
//   }
// }
let players = {}; 
let currentSpectatedSteamID = null;
let gsiPlayerNames = {}; // { steamID: 'gsiName' } - обновляется при каждом GSI POST

app.post('/gsi', (req, res) => {
    const gsiData = req.body;

    if (GSI_AUTH_TOKEN) { 
        if (!gsiData.auth || gsiData.auth.token !== GSI_AUTH_TOKEN) {
            console.warn('GSI: Unauthorized request. Token mismatch or missing from client.');
            return res.status(401).send('Unauthorized');
        }
    }

    // console.log('GSI data received:', new Date().toISOString()); 
    // if (gsiData.allplayers) console.log('GSI allplayers keys:', Object.keys(gsiData.allplayers));

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
                // Попытка авто-связывания SteamID с уже зарегистрированным игроком по нику
                const playerToUpdate = Object.values(players).find(p => p.nickname === playerNameFromGSI && !p.steamID);
                if (playerToUpdate) {
                    playerToUpdate.steamID = steamID;
                    console.log(`GSI: Auto-linked SteamID ${steamID} to player ${playerToUpdate.nickname}.`);
                    io.emit('player_update', { 
                        nickname: playerToUpdate.nickname, 
                        webcamId: playerToUpdate.webcamId, 
                        steamID: playerToUpdate.steamID,
                        showWebcam: playerToUpdate.showWebcam, // Передаем актуальный статус
                        isRegistered: !!playerToUpdate.webcamId 
                    });
                }
            }
        }
    }
    // Сравнение для определения, изменился ли список игроков GSI значительно
    const oldGsiKeys = Object.keys(gsiPlayerNames).sort().join(',');
    const newGsiKeys = Object.keys(tempGsiPlayerNames).sort().join(',');
    const gsiListChanged = oldGsiKeys !== newGsiKeys;

    gsiPlayerNames = tempGsiPlayerNames; 
    
    // Если список игроков GSI изменился, возможно, стоит оповестить клиентов на странице player.html
    // чтобы они могли обновить свой выпадающий список.
    if (gsiListChanged) {
        console.log('GSI: Player list from GSI changed. Current gsiPlayerNames:', gsiPlayerNames);
        // Отправляем обновленный список всем, кто может быть на странице player.html
        const serverPlayersList = [];
        for (const steamID_ in gsiPlayerNames) {
            const gsiName_ = gsiPlayerNames[steamID_];
            const pEntry = Object.values(players).find(p => p.steamID === steamID_ || p.nickname === gsiName_);
            serverPlayersList.push({ 
                name: gsiName_, 
                steamID: steamID_, 
                isRegistered: !!(pEntry && pEntry.webcamId && pEntry.socketId),
                showWebcam: pEntry ? pEntry.showWebcam : true 
            });
        }
        io.emit('player_setup_data_available', serverPlayersList); // Используем io.emit для отправки всем
    }


    if (newSpectatedSteamID !== currentSpectatedSteamID) {
        currentSpectatedSteamID = newSpectatedSteamID;
        let targetNickname = "Unknown"; 
        let targetWebcamId = null;
        let targetShowWebcam = true; // По умолчанию true, если игрок не зарегистрирован или нет предпочтения

        const registeredPlayer = Object.values(players).find(p => p.steamID === currentSpectatedSteamID && p.webcamId);
        if (registeredPlayer) { 
            targetNickname = registeredPlayer.nickname; 
            targetWebcamId = registeredPlayer.webcamId;
            targetShowWebcam = registeredPlayer.showWebcam;
        } else if (gsiPlayerNames[currentSpectatedSteamID]) {
            targetNickname = gsiPlayerNames[currentSpectatedSteamID];
            // Если игрок есть в GSI, но не регистрировал камеру, showWebcam остается true (показываем плейсхолдер "нет камеры")
        }
        console.log(`GSI: Spectate change -> ${targetNickname} (SteamID: ${currentSpectatedSteamID || 'N/A'}, Webcam: ${targetWebcamId || 'N/A'}, Show: ${targetShowWebcam})`);
        io.emit('spectate_change', { 
            steamID: currentSpectatedSteamID, 
            nickname: targetNickname, 
            webcamId: targetWebcamId,
            showWebcam: targetShowWebcam // Передаем состояние "галочки"
        });
    } else if (!newSpectatedSteamID && currentSpectatedSteamID !== null) {
        currentSpectatedSteamID = null;
        console.log("GSI: Spectate change -> No specific player.");
        io.emit('spectate_change', { steamID: null, nickname: null, webcamId: null, showWebcam: false });
    }
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('Socket.IO: User connected:', socket.id);
    // Отправляем текущий список активных (с веб-камерой) игроков для observer.js и multiview.js
    const currentActivePlayersForObservers = Object.values(players)
        .filter(p => p.webcamId && p.socketId)
        .map(p => ({ 
            nickname: p.nickname, 
            webcamId: p.webcamId, 
            steamID: p.steamID,
            showWebcam: p.showWebcam, // Передаем состояние "галочки"
            isRegistered: true 
        }));
    socket.emit('current_players', currentActivePlayersForObservers);

    socket.on('request_player_setup_data', () => {
        console.log(`Socket.IO: Received request_player_setup_data from ${socket.id}. Current gsiPlayerNames:`, Object.keys(gsiPlayerNames).length);
        const serverPlayersList = [];
        for (const steamID in gsiPlayerNames) {
            const gsiName = gsiPlayerNames[steamID];
            const pEntry = Object.values(players).find(p => (p.steamID === steamID || p.nickname === gsiName) && p.webcamId && p.socketId);
            serverPlayersList.push({ 
                name: gsiName, 
                steamID: steamID, 
                isRegistered: !!pEntry,
                showWebcam: pEntry ? pEntry.showWebcam : true // Если игрок не регистрировался, по умолчанию показываем
            });
        }
        console.log(`Socket.IO: Sending player_setup_data_available with ${serverPlayersList.length} GSI players to ${socket.id}.`);
        socket.emit('player_setup_data_available', serverPlayersList);
    });

    socket.on('register_player', (data) => {
        const { nickname, webcamId, steamID } = data;
        console.log(`Socket.IO: register_player attempt:`, data, `from socket ${socket.id}`);
        if (!nickname || !webcamId) { socket.emit('registration_error', 'Nickname and webcamId required.'); return; }
        
        const existingPlayerByReg = Object.values(players).find(p => (p.steamID === steamID || p.nickname === nickname) && p.socketId !== socket.id && p.webcamId );
        if (existingPlayerByReg) { socket.emit('registration_error', `Player ${nickname} (SteamID: ${steamID}) already has an active webcam.`); return; }
        
        const existingPlayerByWebcamId = Object.values(players).find(p => p.webcamId === webcamId && p.socketId !== socket.id);
        if (existingPlayerByWebcamId) { socket.emit('registration_error', `Webcam ID ${webcamId} is already in use.`); return; }
        
        for (const oldNickname in players) {
            if (players[oldNickname].socketId === socket.id) {
                console.log(`Socket.IO: Player ${oldNickname} (socket ${socket.id}) is re-registering. Removing old entry.`);
                const oldWebcamId = players[oldNickname].webcamId;
                delete players[oldNickname];
                io.emit('player_left', { nickname: oldNickname, webcamId: oldWebcamId });
                break; 
            }
        }

        players[nickname] = { 
            nickname, webcamId, steamID, 
            socketId: socket.id,
            showWebcam: true // По умолчанию камера показывается
        };
        console.log(`Socket.IO: Player registered: ${nickname} (Webcam: ${webcamId}, SteamID: ${steamID || 'N/A'}, Show: true, Socket: ${socket.id})`);
        io.emit('player_update', { 
            nickname, webcamId, 
            steamID: players[nickname].steamID, 
            showWebcam: players[nickname].showWebcam,
            isRegistered: true 
        });
        socket.emit('registration_success', players[nickname]);
    });

    socket.on('unregister_player', (data) => {
        const { webcamId } = data; // Используем webcamId для надежности
        console.log(`Socket.IO: Received unregister_player for webcamId: ${webcamId} from socket ${socket.id}`);
        let foundPlayerNickname = null;
        for (const nick in players) {
            if (players[nick].webcamId === webcamId && players[nick].socketId === socket.id) {
                foundPlayerNickname = nick; break;
            }
        }
        if (foundPlayerNickname) {
            console.log(`Socket.IO: Unregistering player ${foundPlayerNickname} (Webcam: ${webcamId})`);
            delete players[foundPlayerNickname];
            io.emit('player_left', { nickname: foundPlayerNickname, webcamId: webcamId });
            socket.emit('unregistration_success'); 
            
            const serverPlayersList = []; // Обновляем список для player_setup_data
            for (const steamID_ in gsiPlayerNames) {
                const gsiName_ = gsiPlayerNames[steamID_];
                const pEntry = Object.values(players).find(p => (p.steamID === steamID_ || p.nickname === gsiName_) && p.webcamId && p.socketId);
                serverPlayersList.push({ name: gsiName_, steamID: steamID_, isRegistered: !!pEntry, showWebcam: pEntry ? pEntry.showWebcam : true });
            }
            io.emit('player_setup_data_available', serverPlayersList);
        } else {
            console.warn(`Socket.IO: unregister_player - player with webcamId ${webcamId} and socket ${socket.id} not found.`);
            socket.emit('unregistration_failed', 'Player not found or not yours.');
        }
    });
    
    // Новый обработчик для установки предпочтения показа веб-камеры ("галочка")
    socket.on('set_player_webcam_preference', ({ targetIdentifier, showWebcamState }) => {
        // targetIdentifier может быть nickname или steamID
        console.log(`Socket.IO: Received set_player_webcam_preference for ${targetIdentifier} to ${showWebcamState}`);
        let playerToUpdate = null;
        
        // Ищем игрока по nickname или steamID
        playerToUpdate = players[targetIdentifier] || Object.values(players).find(p => p.steamID === targetIdentifier && p.webcamId);

        if (playerToUpdate) {
            playerToUpdate.showWebcam = !!showWebcamState; // Приводим к boolean
            console.log(`Socket.IO: Player ${playerToUpdate.nickname} showWebcam set to ${playerToUpdate.showWebcam}`);
            io.emit('player_preference_update', { 
                nickname: playerToUpdate.nickname, 
                steamID: playerToUpdate.steamID,
                webcamId: playerToUpdate.webcamId,
                showWebcam: playerToUpdate.showWebcam 
            });
        } else {
            console.warn(`Socket.IO: set_player_webcam_preference - player ${targetIdentifier} not found.`);
        }
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
        let unregisteredNickname = null; let unregisteredWebcamId = null;
        for (const nickname in players) { 
            if (players[nickname].socketId === socket.id) { 
                unregisteredNickname = nickname; unregisteredWebcamId = players[nickname].webcamId;
                console.log(`Socket.IO: Player ${nickname} (Webcam: ${players[nickname].webcamId}) disconnected due to socket disconnect.`); 
                delete players[nickname]; 
                io.emit('player_left', { nickname: unregisteredNickname, webcamId: unregisteredWebcamId }); 
                const serverPlayersList = [];
                for (const steamID_ in gsiPlayerNames) {
                    const gsiName_ = gsiPlayerNames[steamID_];
                    const pEntry = Object.values(players).find(p => (p.steamID === steamID_ || p.nickname === gsiName_) && p.webcamId && p.socketId);
                    serverPlayersList.push({ name: gsiName_, steamID: steamID_, isRegistered: !!pEntry, showWebcam: pEntry ? pEntry.showWebcam : true });
                }
                io.emit('player_setup_data_available', serverPlayersList);
                break; 
            } 
        }
    });
});

server.listen(PORT, () => {
    console.log(`CS2 Observer Cam Server running on http://localhost:${PORT}`);
    const railwayUrl = process.env.RAILWAY_STATIC_URL ? 'https://' + process.env.RAILWAY_STATIC_URL : 'http://<your-deployed-url>';
    console.log(`GSI Endpoint expected at: ${railwayUrl}/gsi`);
});