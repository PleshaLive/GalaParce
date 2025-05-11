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

const PORT = process.env.PORT || 3001; // Railway установит PORT, локально будет 3001
const GSI_AUTH_TOKEN = "YOUR_SECRET_GSI_TOKEN"; // Замените на ваш секретный токен из GSI .cfg файла

app.use(bodyParser.json({ limit: '10mb' })); // CS2 GSI шлет JSON, увеличим лимит на всякий случай
app.use(express.static('public')); // Сервируем статичные файлы (HTML, JS, CSS из папки public)

let players = {}; // Хранилище игроков: { nickname: { webcamId: 'uniqueWebcamId', steamID: 'optionalSteamID', socketId: 'playerSocketId' } }
let currentSpectatedSteamID = null;
let gsiPlayerNames = {}; // Хранилище имен из GSI: { steamID: 'gsiName' } - для сопоставления

// --- Эндпоинт для CS2 Game State Integration (GSI) ---
app.post('/gsi', (req, res) => {
    const gsiData = req.body;

    // 1. Аутентификация GSI запроса (опционально, но рекомендуется для безопасности)
    if (GSI_AUTH_TOKEN && (!gsiData.auth || gsiData.auth.token !== GSI_AUTH_TOKEN)) {
        console.warn('GSI: Unauthorized request received.');
        return res.status(401).send('Unauthorized');
    }

    // console.log('GSI data received:', JSON.stringify(gsiData, null, 2)); // Для отладки - выводит много данных

    let newSpectatedSteamID = null;

    // 2. Определение наблюдаемого игрока по данным GSI
    // Предполагается, что GSI данные отправляются клиентом игры, который является обсервером.
    // `gsiData.player` будет содержать информацию об обсервере.
    // `gsiData.player.spectarget` будет содержать SteamID64 того, за кем наблюдает обсервер.
    if (gsiData.player && gsiData.player.steamid && gsiData.player.activity === 'playing') { // Убедимся, что отправитель GSI в игре
        if (gsiData.player.spectarget) {
            newSpectatedSteamID = gsiData.player.spectarget;
        }
    }

    // 3. Обновление и сохранение имен игроков из GSI (allplayers)
    // Это полезно для сопоставления SteamID с никнеймами, если игроки не указали SteamID при регистрации камеры.
    if (gsiData.allplayers) {
        for (const steamID in gsiData.allplayers) {
            const playerNameFromGSI = gsiData.allplayers[steamID].name;
            if (playerNameFromGSI) {
                gsiPlayerNames[steamID] = playerNameFromGSI;

                // Попытка автоматически связать SteamID с уже зарегистрированным игроком по никнейму, если SteamID еще не указан
                const playerToUpdate = Object.values(players).find(p => p.nickname === playerNameFromGSI && !p.steamID);
                if (playerToUpdate) {
                    playerToUpdate.steamID = steamID;
                    console.log(`Auto-linked SteamID ${steamID} to player ${playerToUpdate.nickname} via GSI name match.`);
                    // Оповестить клиентов об обновлении steamID у игрока (если нужно)
                    io.emit('player_update', { nickname: playerToUpdate.nickname, webcamId: playerToUpdate.webcamId, steamID: playerToUpdate.steamID });
                }
            }
        }
    }

    // 4. Если наблюдаемый игрок изменился, оповестить клиентов через WebSocket
    if (newSpectatedSteamID !== currentSpectatedSteamID) {
        currentSpectatedSteamID = newSpectatedSteamID;
        let targetNickname = "Unknown";
        let targetWebcamId = null;

        // Ищем никнейм и webcamId наблюдаемого игрока в нашем реестре `players`
        const registeredPlayer = Object.values(players).find(p => p.steamID === currentSpectatedSteamID);
        if (registeredPlayer) {
            targetNickname = registeredPlayer.nickname;
            targetWebcamId = registeredPlayer.webcamId;
        } else if (gsiPlayerNames[currentSpectatedSteamID]) {
            // Если игрока нет в нашем реестре, но есть его имя из GSI
            targetNickname = gsiPlayerNames[currentSpectatedSteamID];
        }

        console.log(`Observer is now spectating: ${targetNickname} (SteamID: ${currentSpectatedSteamID || 'N/A'}, WebcamID: ${targetWebcamId || 'N/A'})`);
        io.emit('spectate_change', {
            steamID: currentSpectatedSteamID,
            nickname: targetNickname,
            webcamId: targetWebcamId // Отправляем webcamId, если он известен
        });
    } else if (!newSpectatedSteamID && currentSpectatedSteamID !== null) {
        // Если обсервер больше не следит за конкретным игроком (например, свободная камера или карта)
        currentSpectatedSteamID = null;
        console.log("Observer is no longer spectating a specific player.");
        io.emit('spectate_change', { steamID: null, nickname: null, webcamId: null });
    }

    res.status(200).send('OK'); // Отвечаем CS2, что данные приняты
});

// --- Логика WebSocket (Socket.IO) для взаимодействия с клиентами ---
io.on('connection', (socket) => {
    console.log('User connected to WebSocket:', socket.id);

    // При подключении нового пользователя, отправляем ему текущий список "активных" игроков с веб-камерами
    const currentActivePlayers = Object.values(players)
        .filter(p => p.webcamId && p.socketId) // Отправляем только тех, у кого есть webcamId и активный сокет
        .map(p => ({ nickname: p.nickname, webcamId: p.webcamId, steamID: p.steamID }));
    socket.emit('current_players', currentActivePlayers);

    // Игрок регистрирует свою веб-камеру и никнейм
    socket.on('register_player', (data) => { // Ожидаем { nickname: 'name', webcamId: 'id', steamID: 'optionalSteamID' }
        const { nickname, webcamId, steamID } = data;
        if (!nickname || !webcamId) {
            socket.emit('registration_error', 'Nickname and webcamId are required.');
            console.warn(`Registration failed for socket ${socket.id}: Nickname or webcamId missing.`);
            return;
        }

        // Проверка, не занят ли никнейм другим активным сокетом
        if (players[nickname] && players[nickname].socketId !== socket.id) {
            socket.emit('registration_error', `Nickname ${nickname} is already in use by another session.`);
            console.warn(`Registration failed for ${nickname}: Nickname already in use by another session.`);
            return;
        }
        // Проверка, не используется ли webcamId другим активным игроком
        const existingPlayerByWebcamId = Object.values(players).find(p => p.webcamId === webcamId && p.nickname !== nickname);
        if (existingPlayerByWebcamId) {
             socket.emit('registration_error', `Webcam ID ${webcamId} is already in use by player ${existingPlayerByWebcamId.nickname}.`);
             console.warn(`Registration failed for ${nickname}: Webcam ID ${webcamId} already in use.`);
             return;
        }


        players[nickname] = {
            nickname,
            webcamId,
            steamID: steamID || (gsiPlayerNames && Object.keys(gsiPlayerNames).find(sid => gsiPlayerNames[sid] === nickname)) || players[nickname]?.steamID || null,
            socketId: socket.id // Сохраняем ID сокета для прямой связи
        };
        console.log(`Player registered/updated: ${nickname} (Webcam: ${webcamId}, SteamID: ${players[nickname].steamID}, Socket: ${socket.id})`);
        
        // Оповещаем всех клиентов об обновлении списка игроков
        io.emit('player_update', { nickname, webcamId, steamID: players[nickname].steamID });
        socket.emit('registration_success', players[nickname]); // Подтверждение успешной регистрации клиенту
    });

    // --- Сигнализация WebRTC ---
    // Зритель (клиент со страницы observer.html) отправляет оффер игроку (клиент со страницы player.html)
    socket.on('webrtc_offer', ({ offer, targetWebcamId, senderWebcamId }) => {
        const targetPlayer = Object.values(players).find(p => p.webcamId === targetWebcamId);
        if (targetPlayer && targetPlayer.socketId) {
            console.log(`Forwarding WebRTC offer from sender ${senderWebcamId} to player ${targetPlayer.nickname} (socket ${targetPlayer.socketId}) for webcam ${targetWebcamId}`);
            // Пересылаем оффер конкретному сокету игрока
            io.to(targetPlayer.socketId).emit('webrtc_offer_from_viewer', { offer, viewerWebcamId: senderWebcamId });
        } else {
            console.warn(`WebRTC Offer: Player with webcamId ${targetWebcamId} not found or not connected.`);
            // Можно отправить ошибку обратно отправителю оффера
            socket.emit('webrtc_error', { targetWebcamId, message: 'Target player not found or not connected.'});
        }
    });

    // Игрок (клиент player.html) отправляет ответ (answer) зрителю (клиент observer.html)
    socket.on('webrtc_answer', ({ answer, targetViewerWebcamId, senderPlayerWebcamId }) => {
        // Ответ должен быть направлен конкретному зрителю.
        // Так как зрители не "регистрируются" с socketId в `players`, мы просто эмитим событие,
        // а клиентская сторона зрителя должна проверить, предназначен ли этот ответ для него.
        console.log(`Forwarding WebRTC answer from player ${senderPlayerWebcamId} to viewer ${targetViewerWebcamId}`);
        io.emit('webrtc_answer_to_viewer', { answer, playerWebcamId: senderPlayerWebcamId, viewerWebcamId: targetViewerWebcamId });
    });

    // Обмен ICE кандидатами между пирами (игрок <-> зритель)
    socket.on('webrtc_ice_candidate', ({ candidate, targetId, isTargetPlayer, senderId }) => {
        // targetId - это webcamId или sessionId цели (игрока или зрителя)
        // senderId - это webcamId или sessionId отправителя
        // isTargetPlayer - флаг, указывающий, является ли цель игроком (true) или зрителем (false)
        
        let recipientSocketId = null;
        if (isTargetPlayer) { // Если цель - игрок
            const targetPlayer = Object.values(players).find(p => p.webcamId === targetId);
            if (targetPlayer && targetPlayer.socketId) {
                recipientSocketId = targetPlayer.socketId;
            }
        } else { // Если цель - зритель
            // Для зрителей у нас нет прямого map webcamId -> socketId на сервере.
            // Поэтому мы бродкастим событие, а нужный клиент-зритель его обработает.
            // console.log(`Broadcasting ICE candidate from ${senderId} for viewer ${targetId}`);
            io.emit('webrtc_ice_candidate_to_client', { candidate, forTargetId: targetId, iceSenderId: senderId });
            return; // Выходим, так как уже отправили
        }

        if (recipientSocketId) {
            // console.log(`Forwarding ICE candidate from ${senderId} to specific socket ${recipientSocketId} (target ${targetId})`);
            io.to(recipientSocketId).emit('webrtc_ice_candidate_from_peer', { candidate, iceSenderId: senderId });
        } else {
            // console.warn(`ICE Candidate: Recipient for targetId ${targetId} (isTargetPlayer: ${isTargetPlayer}) not found.`);
        }
    });

    // Обработка отключения пользователя
    socket.on('disconnect', () => {
        console.log('User disconnected from WebSocket:', socket.id);
        for (const nickname in players) {
            if (players[nickname].socketId === socket.id) {
                console.log(`Player ${nickname} (Webcam: ${players[nickname].webcamId}) disconnected.`);
                const { webcamId } = players[nickname]; // Сохраняем webcamId перед удалением
                delete players[nickname];
                io.emit('player_left', { nickname, webcamId }); // Оповещаем всех клиентов, что игрок ушел
                break;
            }
        }
    });
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`CS2 Observer Cam Server is running on http://localhost:${PORT}`);
    console.log(`GSI Endpoint will be on http://<your-railway-app-public-url>/gsi`);
    console.log(`Player setup page: http://localhost:${PORT}/player.html`);
    console.log(`Observer page: http://localhost:${PORT}/observer.html`);
});