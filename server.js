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
const GSI_AUTH_TOKEN = "YOUR_SECRET_GSI_TOKEN"; // << ЗАМЕНИТЕ НА ВАШ ТОКЕН

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

let players = {};
let currentSpectatedSteamID = null;
let gsiPlayerNames = {};

app.post('/gsi', (req, res) => {
    const gsiData = req.body;

    if (GSI_AUTH_TOKEN && (!gsiData.auth || gsiData.auth.token !== GSI_AUTH_TOKEN)) {
        console.warn('GSI: Unauthorized request received.');
        return res.status(401).send('Unauthorized');
    }

    // console.log('GSI data received:', JSON.stringify(gsiData, null, 2)); // DEBUG: лог всех данных GSI

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

        console.log(`GSI: Observer is now spectating: ${targetNickname} (SteamID: ${currentSpectatedSteamID || 'N/A'}, WebcamID: ${targetWebcamId || 'N/A'})`);
        io.emit('spectate_change', {
            steamID: currentSpectatedSteamID,
            nickname: targetNickname,
            webcamId: targetWebcamId
        });
    } else if (!newSpectatedSteamID && currentSpectatedSteamID !== null) {
        currentSpectatedSteamID = null;
        console.log("GSI: Observer is no longer spectating a specific player.");
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
        console.log(`Socket.IO: Received register_player attempt:`, data);
        if (!nickname || !webcamId) {
            socket.emit('registration_error', 'Nickname and webcamId are required.');
            console.warn(`Socket.IO: Registration failed for socket ${socket.id}: Nickname or webcamId missing.`);
            return;
        }

        if (players[nickname] && players[nickname].socketId !== socket.id) {
            socket.emit('registration_error', `Nickname ${nickname} is already in use by another session.`);
            console.warn(`Socket.IO: Registration failed for ${nickname}: Nickname in use by another session.`);
            return;
        }
        const existingPlayerByWebcamId = Object.values(players).find(p => p.webcamId === webcamId && p.nickname !== nickname);
        if (existingPlayerByWebcamId) {
             socket.emit('registration_error', `Webcam ID ${webcamId} is already in use by player ${existingPlayerByWebcamId.nickname}.`);
             console.warn(`Socket.IO: Registration failed for ${nickname}: Webcam ID ${webcamId} in use.`);
             return;
        }

        players[nickname] = {
            nickname,
            webcamId,
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
            console.log(`Socket.IO: Forwarding WebRTC offer from sender ${senderWebcamId} (viewer) to player ${targetPlayer.nickname} (socket ${targetPlayer.socketId}) for webcam ${targetWebcamId}`);
            io.to(targetPlayer.socketId).emit('webrtc_offer_from_viewer', { offer, viewerWebcamId: senderWebcamId });
        } else {
            console.warn(`Socket.IO: WebRTC Offer - Player with webcamId ${targetWebcamId} not found or not connected. Offer from ${senderWebcamId}.`);
            socket.emit('webrtc_error', { targetWebcamId, message: 'Target player not found or not connected.'});
        }
    });

    socket.on('webrtc_answer', ({ answer, targetViewerWebcamId, senderPlayerWebcamId }) => {
        console.log(`Socket.IO: Forwarding WebRTC answer from player ${senderPlayerWebcamId} to viewer ${targetViewerWebcamId}`);
        io.emit('webrtc_answer_to_viewer', { answer, playerWebcamId: senderPlayerWebcamId, viewerWebcamId: targetViewerWebcamId });
    });

    socket.on('webrtc_ice_candidate', ({ candidate, targetId, isTargetPlayer, senderId }) => {
        // console.log(`Socket.IO: Received ICE candidate from ${senderId} for ${targetId} (isTargetPlayer: ${isTargetPlayer})`); // DEBUG: Log all ICE
        let recipientSocketId = null;
        if (isTargetPlayer) {
            const targetPlayer = Object.values(players).find(p => p.webcamId === targetId);
            if (targetPlayer && targetPlayer.socketId) {
                recipientSocketId = targetPlayer.socketId;
                // console.log(`Socket.IO: ICE for player ${targetPlayer.nickname} (socket ${recipientSocketId}).`);
            }
        } else {
            // console.log(`Socket.IO: ICE for viewer ${targetId}. Broadcasting 'webrtc_ice_candidate_to_client'.`);
            io.emit('webrtc_ice_candidate_to_client', { candidate, forTargetId: targetId, iceSenderId: senderId });
            return; 
        }

        if (recipientSocketId) {
            io.to(recipientSocketId).emit('webrtc_ice_candidate_from_peer', { candidate, iceSenderId: senderId });
        } else {
            // console.warn(`Socket.IO: ICE Candidate - Recipient for targetId ${targetId} (isTargetPlayer: ${isTargetPlayer}) not found.`);
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket.IO: User disconnected:', socket.id);
        for (const nickname in players) {
            if (players[nickname].socketId === socket.id) {
                console.log(`Socket.IO: Player ${nickname} (Webcam: ${players[nickname].webcamId}) disconnected.`);
                const { webcamId } = players[nickname];
                delete players[nickname];
                io.emit('player_left', { nickname, webcamId });
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`CS2 Observer Cam Server is running on http://localhost:${PORT}`);
    console.log(`GSI Endpoint will be on http://<your-railway-app-public-url>/gsi`);
});