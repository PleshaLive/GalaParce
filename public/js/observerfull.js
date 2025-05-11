const socket = io();
const videoElement = document.getElementById('observerFullVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');
let currentPeerConnection = null;
let currentWebcamId = null; 
const observerSessionId = 'obs-full-' + Math.random().toString(36).substring(2, 9);

if (!videoElement) console.error("ObserverFullJS: Video element not found!");
const pcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function showTransparentPage() { if (videoElement) { videoElement.style.display = 'none'; videoElement.srcObject = null; } if (videoPlaceholder) videoPlaceholder.style.display = 'none'; }
function showVideoElement() { if (videoPlaceholder) videoPlaceholder.style.display = 'none'; if (videoElement) videoElement.style.display = 'block';}

async function connectToPlayerStream(targetPlayerWebcamId, playerName, showWebcamPreference = true) {
    if (currentPeerConnection && currentPeerConnection.connectionState !== 'closed') currentPeerConnection.close();
    currentPeerConnection = null; showTransparentPage(); 
    if (!targetPlayerWebcamId) { currentWebcamId = null; return; }
    currentWebcamId = targetPlayerWebcamId;
    if (!showWebcamPreference) return;
    const pc = new RTCPeerConnection(pcConfig); currentPeerConnection = pc;
    pc.onicecandidate = event => { if (event.candidate) socket.emit('webrtc_ice_candidate', { candidate: event.candidate, targetId: targetPlayerWebcamId, isTargetPlayer: true, senderId: observerSessionId }); };
    pc.ontrack = event => { if (event.streams && event.streams[0]) { if (videoElement.srcObject !== event.streams[0]) { videoElement.srcObject = event.streams[0]; videoElement.play().catch(e => {}); showVideoElement(); }} else showTransparentPage();};
    pc.oniceconnectionstatechange = () => { const iceState = pc.iceConnectionState; if (['failed','disconnected','closed'].includes(iceState)) if (currentWebcamId === targetPlayerWebcamId) showTransparentPage();};
    pc.onsignalingstatechange = () => {};
    pc.onconnectionstatechange = () => { const connState = pc.connectionState; if (['failed','disconnected','closed'].includes(connState)) if (currentWebcamId === targetPlayerWebcamId) showTransparentPage(); else if (connState === 'connected') if (videoElement.srcObject) showVideoElement(); };
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('webrtc_offer', { offer: offer, targetWebcamId: targetPlayerWebcamId, senderWebcamId: observerSessionId }); } 
    catch (e) { showTransparentPage(); }
}
socket.on('spectate_change', (data) => { const { nickname, webcamId, showWebcam } = data; if (!webcamId) connectToPlayerStream(null, 'N/A'); else connectToPlayerStream(webcamId, nickname, showWebcam === undefined ? true : showWebcam);});
socket.on('webrtc_answer_to_viewer', async ({ answer, playerWebcamId, viewerWebcamId }) => { if (viewerWebcamId !== observerSessionId || !currentPeerConnection || playerWebcamId !== currentWebcamId) return; if (currentPeerConnection.signalingState === 'have-local-offer' || currentPeerConnection.signalingState === 'stable') { try { await currentPeerConnection.setRemoteDescription(new RTCSessionDescription(answer)); } catch (e) {}} else {}});
socket.on('webrtc_ice_candidate_to_client', async ({ candidate, forTargetId, iceSenderId }) => { if (forTargetId !== observerSessionId || !currentPeerConnection || iceSenderId !== currentWebcamId ) return; if (candidate) { try { await currentPeerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}}});
socket.on('connect', () => { showTransparentPage(); });
socket.on('disconnect', () => { showTransparentPage(); });