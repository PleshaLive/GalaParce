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
const GSI_AUTH_TOKEN = ""; 

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
    let gsiListChanged = false;
    if (gsiData.allplayers) {
        const currentGsiKeys = Object.keys(gsiData.allplayers).sort().join(',');
        const previousGsiKeys = Object.keys(gsiPlayerNames).sort().join(',');
        if(currentGsiKeys !== previousGsiKeys) gsiListChanged = true;

        for (const steamID in gsiData.allplayers) {
            const playerNameFromGSI = gsiData.allplayers[steamID].name;
            if (playerNameFromGSI) {
                tempGsiPlayerNames[steamID] = playerNameFromGSI;
                if(!gsiListChanged && gsiPlayerNames[steamID] !== playerNameFromGSI) gsiListChanged = true;

                const playerToUpdate = Object.values(players).find(p => p.nickname === playerNameFromGSI && !p.steamID);
                if (playerToUpdate) {
                    playerToUpdate.steamID = steamID;
                    io.emit('player_update', { nickname: playerToUpdate.nickname, webcamId: playerToUpdate.webcamId, steamID: playerToUpdate.steamID, showWebcam: playerToUpdate.showWebcam, isRegistered: !!playerToUpdate.webcamId });
                }
            }
        }
    } else if (Object.keys(gsiPlayerNames).length > 0) {
        gsiListChanged = true;
    }
    gsiPlayerNames = tempGsiPlayerNames; 
    
    if (gsiListChanged) {
        const serverPlayersList = [];
        for (const steamID_ in gsiPlayerNames) {
            const gsiName_ = gsiPlayerNames[steamID_];
            const pEntry = Object.values(players).find(p => (p.steamID === steamID_ || p.nickname === gsiName_) && p.webcamId && p.socketId);
            serverPlayersList.push({ name: gsiName_, steamID: steamID_, isRegistered: !!pEntry, showWebcam: pEntry ? pEntry.showWebcam : true });
        }
        io.emit('player_setup_data_available', serverPlayersList);
    }

    if (newSpectatedSteamID !== currentSpectatedSteamID) {
        currentSpectatedSteamID = newSpectatedSteamID;
        let targetNickname = "Unknown"; let targetWebcamId = null; let targetShowWebcam = true;
        const registeredPlayer = Object.values(players).find(p => p.steamID === currentSpectatedSteamID && p.webcamId);
        if (registeredPlayer) { targetNickname = registeredPlayer.nickname; targetWebcamId = registeredPlayer.webcamId; targetShowWebcam = registeredPlayer.showWebcam; }
        else if (gsiPlayerNames[currentSpectatedSteamID]) targetNickname = gsiPlayerNames[currentSpectatedSteamID];
        console.log(`GSI: Spectate change -> ${targetNickname} (SteamID: ${currentSpectatedSteamID || 'N/A'}, Webcam: ${targetWebcamId || 'N/A'}, Show: ${targetShowWebcam})`);
        io.emit('spectate_change', { steamID: currentSpectatedSteamID, nickname: targetNickname, webcamId: targetWebcamId, showWebcam: targetWebcamId ? targetShowWebcam : false });
    } else if (!newSpectatedSteamID && currentSpectatedSteamID !== null) {
        currentSpectatedSteamID = null; console.log("GSI: Spectate change -> No specific player.");
        io.emit('spectate_change', { steamID: null, nickname: null, webcamId: null, showWebcam: false });
    }
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('Socket.IO: User connected:', socket.id);
    const currentActivePlayersForObservers = Object.values(players).filter(p=>p.webcamId && p.socketId).map(p=>({nickname:p.nickname,webcamId:p.webcamId,steamID:p.steamID,showWebcam:p.showWebcam,isRegistered:true}));
    socket.emit('current_players', currentActivePlayersForObservers);

    socket.on('request_player_setup_data', () => {
        const serverPlayersList = [];
        for (const steamID in gsiPlayerNames) {
            const gsiName = gsiPlayerNames[steamID];
            const pEntry = Object.values(players).find(p => (p.steamID === steamID || p.nickname === gsiName) && p.webcamId && p.socketId);
            serverPlayersList.push({ name: gsiName, steamID: steamID, isRegistered: !!pEntry, showWebcam: pEntry ? pEntry.showWebcam : true });
        }
        socket.emit('player_setup_data_available', serverPlayersList);
    });

    socket.on('register_player', (data) => {
        const { nickname, webcamId, steamID } = data;
        if (!nickname || !webcamId) { socket.emit('registration_error', 'Nickname and webcamId required.'); return; }
        const existingPlayerByReg = Object.values(players).find(p => (p.steamID === steamID || p.nickname === nickname) && p.socketId !== socket.id && p.webcamId );
        if (existingPlayerByReg) { socket.emit('registration_error', `Player ${nickname} (SteamID: ${steamID}) already has an active webcam.`); return; }
        const existingPlayerByWebcamId = Object.values(players).find(p => p.webcamId === webcamId && p.socketId !== socket.id);
        if (existingPlayerByWebcamId) { socket.emit('registration_error', `Webcam ID ${webcamId} is already in use.`); return; }
        for (const oldNickname in players) { if (players[oldNickname].socketId === socket.id) { const oldWebcamId = players[oldNickname].webcamId; delete players[oldNickname]; io.emit('player_left', { nickname: oldNickname, webcamId: oldWebcamId }); break; }}
        players[nickname] = { nickname, webcamId, steamID, socketId: socket.id, showWebcam: true };
        console.log(`Socket.IO: Player registered: ${nickname} (Webcam: ${webcamId}, SteamID: ${steamID || 'N/A'}, Show: true, Socket: ${socket.id})`);
        io.emit('player_update', { nickname, webcamId, steamID: players[nickname].steamID, showWebcam: players[nickname].showWebcam, isRegistered: true });
        socket.emit('registration_success', players[nickname]);
    });

    socket.on('unregister_player', (data) => {
        const { webcamId } = data; 
        let foundPlayerNickname = null;
        for (const nick in players) { if (players[nick].webcamId === webcamId && players[nick].socketId === socket.id) { foundPlayerNickname = nick; break; }}
        if (foundPlayerNickname) {
            console.log(`Socket.IO: Unregistering player ${foundPlayerNickname} (Webcam: ${webcamId})`);
            delete players[foundPlayerNickname];
            io.emit('player_left', { nickname: foundPlayerNickname, webcamId: webcamId });
            socket.emit('unregistration_success'); 
            const serverPlayersList = [];
            for (const steamID_ in gsiPlayerNames) {
                const gsiName_ = gsiPlayerNames[steamID_];
                const pEntry = Object.values(players).find(p => (p.steamID === steamID_ || p.nickname === gsiName_) && p.webcamId && p.socketId);
                serverPlayersList.push({ name: gsiName_, steamID: steamID_, isRegistered: !!pEntry, showWebcam: pEntry ? pEntry.showWebcam : true });
            }
            io.emit('player_setup_data_available', serverPlayersList);
        } else { socket.emit('unregistration_failed', 'Player not found or not yours.'); }
    });
    
    socket.on('set_player_webcam_preference', ({ targetIdentifier, showWebcamState }) => {
        let playerToUpdate = players[targetIdentifier] || Object.values(players).find(p => p.steamID === targetIdentifier && p.webcamId);
        if (playerToUpdate) {
            playerToUpdate.showWebcam = !!showWebcamState;
            console.log(`Socket.IO: Player ${playerToUpdate.nickname} showWebcam set to ${playerToUpdate.showWebcam}`);
            io.emit('player_preference_update', { nickname: playerToUpdate.nickname, steamID: playerToUpdate.steamID, webcamId: playerToUpdate.webcamId, showWebcam: playerToUpdate.showWebcam });
        } else { console.warn(`Socket.IO: set_player_webcam_preference - player ${targetIdentifier} not found.`); }
    });

    socket.on('webrtc_offer', ({ offer, targetWebcamId, senderWebcamId }) => { const targetPlayer = Object.values(players).find(p => p.webcamId === targetWebcamId); if (targetPlayer && targetPlayer.socketId) { io.to(targetPlayer.socketId).emit('webrtc_offer_from_viewer', { offer, viewerWebcamId: senderWebcamId }); } else { socket.emit('webrtc_error', { targetWebcamId, message: 'Target player not found' }); }});
    socket.on('webrtc_answer', ({ answer, targetViewerWebcamId, senderPlayerWebcamId }) => { io.emit('webrtc_answer_to_viewer', { answer, playerWebcamId: senderPlayerWebcamId, viewerWebcamId: targetViewerWebcamId }); });
    socket.on('webrtc_ice_candidate', ({ candidate, targetId, isTargetPlayer, senderId }) => { let recipientSocketId = null; if (isTargetPlayer) { const targetPlayer = Object.values(players).find(p => p.webcamId === targetId); if (targetPlayer && targetPlayer.socketId) recipientSocketId = targetPlayer.socketId; } else { io.emit('webrtc_ice_candidate_to_client', { candidate, forTargetId: targetId, iceSenderId: senderId }); return; } if (recipientSocketId) io.to(recipientSocketId).emit('webrtc_ice_candidate_from_peer', { candidate, iceSenderId: senderId }); });
    socket.on('disconnect', () => {
        console.log('Socket.IO: User disconnected:', socket.id);
        let unregisteredNickname = null; let unregisteredWebcamId = null;
        for (const nickname in players) { if (players[nickname].socketId === socket.id) { unregisteredNickname = nickname; unregisteredWebcamId = players[nickname].webcamId; delete players[nickname]; io.emit('player_left', { nickname: unregisteredNickname, webcamId: unregisteredWebcamId }); const serverPlayersList = []; for (const steamID_ in gsiPlayerNames) { const gsiName_ = gsiPlayerNames[steamID_]; const pEntry = Object.values(players).find(p => (p.steamID === steamID_ || p.nickname === gsiName_) && p.webcamId && p.socketId); serverPlayersList.push({ name: gsiName_, steamID: steamID_, isRegistered: !!pEntry, showWebcam: pEntry ? pEntry.showWebcam : true });} io.emit('player_setup_data_available', serverPlayersList); break; }}
    });
});

server.listen(PORT, () => {
    console.log(`CS2 Observer Cam Server running on http://localhost:${PORT}`);
    const railwayUrl = process.env.RAILWAY_STATIC_URL ? 'https://' + process.env.RAILWAY_STATIC_URL : 'http://<your-deployed-url>';
    console.log(`GSI Endpoint expected at: ${railwayUrl}/gsi`);
});