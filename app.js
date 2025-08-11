// Basic 1:1 WebRTC with Firestore signaling + push-to-talk (PTT) + presence list

let app, db;
let pc;
let localStream;
let micTrack;
let roomRef;
let roomId;
let isCaller = false;
let talking = false;
let heartbeatTimer = null;

// persistent client ID for "You"
const CLIENT_ID_KEY = "wt_client_id_v1";
const clientId = localStorage.getItem(CLIENT_ID_KEY) || (() => {
  const id = "c_" + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
})();

const rtcConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ]
};

const $ = (id) => document.getElementById(id);
const byId = $;

window.addEventListener('DOMContentLoaded', async () => {
  // Firebase init
  app = firebase.initializeApp(firebaseConfig);
  db  = firebase.firestore();

  // UI
  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  byId('securePill').textContent = secure ? "HTTPS" : "HTTP";
  if (!secure) byId('securePill').style.color = "#ff9b9b";

  byId('createBtn').onclick = () => start(true);
  byId('joinBtn').onclick   = () => start(false);

  // Push-to-talk
  const ptt = byId('pttBtn');
  let pttEngaged = false;

  // Keep label always "TALK"
  ptt.textContent = "TALK";
  const lockLabel = () => { if (ptt.textContent !== "TALK") ptt.textContent = "TALK"; };
  new MutationObserver(lockLabel).observe(ptt, { childList: true, characterData: true, subtree: true });

  // Start only if press begins on the button
  const handleStart = (e) => { e.preventDefault(); pttEngaged = true; beginTalk(); };
  const handleEnd   = (e) => { if (!pttEngaged) return; e.preventDefault(); pttEngaged = false; endTalk(); };

  ptt.addEventListener('mousedown', handleStart, {passive:false});
  ptt.addEventListener('touchstart', handleStart, {passive:false});
  ptt.addEventListener('mouseup', handleEnd, {passive:false});
  ptt.addEventListener('mouseleave', handleEnd, {passive:false});
  ptt.addEventListener('touchend', handleEnd, {passive:false});
  ptt.addEventListener('touchcancel', handleEnd, {passive:false});
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());

  // Spacebar PTT (ignore when typing)
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.code === 'Space' && !pttEngaged) { e.preventDefault(); pttEngaged = true; beginTalk(); }
  }, {passive:false});
  window.addEventListener('keyup', (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.code === 'Space' && pttEngaged) { e.preventDefault(); pttEngaged = false; endTalk(); }
  }, {passive:false});
});

async function start(create) {
  try {
    byId('status').textContent = "Status: Requesting microphone...";
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    byId('micPill').textContent = "Mic: OK";
    micTrack = localStream.getAudioTracks()[0];

    pc = new RTCPeerConnection(rtcConfig);

    // Add *disabled* mic initially (enable only while talking)
    micTrack.enabled = false;
    pc.addTrack(micTrack, localStream);

    // Play remote audio
    const remoteAudio = byId('remoteAudio');
    pc.addEventListener('track', (ev) => { remoteAudio.srcObject = ev.streams[0]; });

    if (create) {
      // Caller creates a room
      roomId = (byId('roomId').value || '').trim() || String(Math.floor(1000 + Math.random()*9000));
      roomRef = db.collection('rooms').doc(roomId);
      await roomRef.set({ created: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });

      // Local ICE → Firestore
      const callerCands = roomRef.collection('callerCandidates');
      pc.addEventListener('icecandidate', (event) => { if (event.candidate) callerCands.add(event.candidate.toJSON()); });

      // Create offer
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      await roomRef.set({ offer: { type: offer.type, sdp: offer.sdp } }, { merge: true });

      // Wait for answer
      roomRef.onSnapshot(async (snap) => {
        const data = snap.data();
        if (!pc.currentRemoteDescription && data?.answer) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          byId('status').textContent = `Connected. Room ${roomId}`;
          byId('pttBtn').disabled = false;
        }
      });

      // Remote ICE from callee
      roomRef.collection('calleeCandidates').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
        });
      });

      isCaller = true;
      byId('status').textContent = `Room created: ${roomId}. Waiting for partner…`;
      byId('roomId').value = roomId;
    } else {
      // Joiner joins an existing room
      roomId = (byId('roomId').value || '').trim();
      if (!roomId) { err("Enter the room code to join."); return; }

      roomRef = db.collection('rooms').doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) { err("Room not found. Ask your friend to Create first."); return; }

      // Local ICE → Firestore
      const calleeCands = roomRef.collection('calleeCandidates');
      pc.addEventListener('icecandidate', (event) => { if (event.candidate) calleeCands.add(event.candidate.toJSON()); });

      // Apply remote offer
      const roomData = roomSnap.data();
      if (!roomData?.offer) { err("Room has no offer yet. Wait a moment and try again."); return; }
      await pc.setRemoteDescription(new RTCSessionDescription(roomData.offer));

      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await roomRef.set({ answer: { type: answer.type, sdp: answer.sdp } }, { merge: true });

      byId('status').textContent = `Connected. Room ${roomId}`;
      byId('pttBtn').disabled = false;

      // Remote ICE from caller
      roomRef.collection('callerCandidates').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
        });
      });

      isCaller = false;
    }

    // Register presence AFTER roomRef is known (both create/join)
    await registerPresence();

  } catch (e) {
    err(e.message || String(e));
  }
}

async function registerPresence() {
  const nameRaw = (byId('displayName').value || "").trim();
  const displayName = nameRaw || "Guest";
  const pRef = roomRef.collection('participants').doc(clientId);

  // Add/mark online
  await pRef.set({
    name: displayName,
    online: true,
    active: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Heartbeat
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    pRef.set({ active: firebase.firestore.FieldValue.serverTimestamp(), online: true }, { merge: true });
  }, 25000); // every 25s

  // On unload, set offline (or delete)
  const clean = async () => {
    try { await pRef.set({ online: false, active: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch {}
  };
  window.addEventListener('beforeunload', clean);
  window.addEventListener('pagehide', clean);

  // Subscribe to list and render
  roomRef.collection('participants').orderBy('active', 'desc').onSnapshot((snap) => {
    const items = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      const isSelf = (doc.id === clientId);
      const label = isSelf ? "You" : (d.name || "Guest");
      // Optionally gray out offline
      const offline = d.online === false;
      items.push(offline ? `${label} (offline)` : label);
    });
    byId('party').textContent = items.length ? `In room: ${items.join(', ')}` : 'In room: —';
  });
}

function beginTalk() {
  if (!pc || !micTrack) return;
  if (talking) return;
  talking = true;
  micTrack.enabled = true;                 // unmute while held
  byId('pttBtn').classList.add('talking'); // color only; label stays "TALK"
}

function endTalk() {
  if (!pc || !micTrack) return;
  if (!talking) return;
  talking = false;
  micTrack.enabled = false;                // mute when released
  byId('pttBtn').classList.remove('talking');
}

function err(msg) {
  byId('errors').textContent = msg;
  console.error(msg);
  byId('pttBtn').disabled = true;
}
