// WebRTC 1:1 + Firestore signaling + PTT + real-time presence

let app, db;
let pc;
let localStream;
let micTrack;
let roomRef;
let roomId;
let talking = false;

// Stable clientId so we can show "You" for yourself
const CLIENT_ID_KEY = "wt_client_id_v1";
const clientId = localStorage.getItem(CLIENT_ID_KEY) || (() => {
  const id = "c_" + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
})();

const rtcConfig = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"] }]
};

const $ = (id) => document.getElementById(id);

window.addEventListener('DOMContentLoaded', async () => {
  app = firebase.initializeApp(firebaseConfig);
  db  = firebase.firestore();

  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  $('securePill').textContent = secure ? "HTTPS" : "HTTP";
  if (!secure) $('securePill').style.color = "#ff9b9b";

  $('createBtn').onclick = () => start(true);
  $('joinBtn').onclick   = () => start(false);

  // PTT wiring (button-only; doesn't block typing in inputs)
  const ptt = $('pttBtn');
  let pttEngaged = false;
  ptt.textContent = "TALK";
  new MutationObserver(() => { if (ptt.textContent !== "TALK") ptt.textContent = "TALK"; })
    .observe(ptt, { childList:true, characterData:true, subtree:true });

  const handleStart = (e)=>{ e.preventDefault(); pttEngaged = true; beginTalk(); };
  const handleEnd   = (e)=>{ if (!pttEngaged) return; e.preventDefault(); pttEngaged = false; endTalk(); };

  ptt.addEventListener('mousedown', handleStart, {passive:false});
  ptt.addEventListener('touchstart', handleStart, {passive:false});
  ptt.addEventListener('mouseup', handleEnd, {passive:false});
  ptt.addEventListener('mouseleave', handleEnd, {passive:false});
  ptt.addEventListener('touchend', handleEnd, {passive:false});
  ptt.addEventListener('touchcancel', handleEnd, {passive:false});
  ptt.addEventListener('contextmenu', (e)=>e.preventDefault());

  window.addEventListener('keydown', (e)=>{
    const t=(e.target.tagName||"").toLowerCase();
    if (t==='input'||t==='textarea') return;
    if (e.code==='Space' && !pttEngaged){ e.preventDefault(); pttEngaged=true; beginTalk(); }
  }, {passive:false});
  window.addEventListener('keyup', (e)=>{
    const t=(e.target.tagName||"").toLowerCase();
    if (t==='input'||t==='textarea') return;
    if (e.code==='Space' && pttEngaged){ e.preventDefault(); pttEngaged=false; endTalk(); }
  }, {passive:false});
});

async function start(create) {
  try {
    // 1) Establish roomRef FIRST (so presence starts immediately)
    if (create) {
      roomId = ($('roomId').value || '').trim() || String(Math.floor(100000 + Math.random()*900000));
      roomRef = db.collection('rooms').doc(roomId);
      await roomRef.set({ created: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
      $('roomId').value = roomId;
      $('status').textContent = `Room created: ${roomId}. Waiting for partner…`;
    } else {
      roomId = ($('roomId').value || '').trim();
      if (!roomId) return err("Enter the room code to join.");
      roomRef = db.collection('rooms').doc(roomId);
      const snap = await roomRef.get();
      if (!snap.exists) return err("Room not found. Ask your friend to Create first.");
      $('status').textContent = `Joining room ${roomId}…`;
    }

    // 2) Start presence (mandatory, real-time)
    await registerPresenceListeners();

    // 3) Then get mic and set up WebRTC
    $('status').textContent = "Status: Requesting microphone…";
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true }, video:false });
    $('micPill').textContent = "Mic: OK";
    micTrack = localStream.getAudioTracks()[0];

    pc = new RTCPeerConnection(rtcConfig);
    micTrack.enabled = false;            // hold-to-talk only
    pc.addTrack(micTrack, localStream);

    const remoteAudio = $('remoteAudio');
    pc.addEventListener('track', (ev)=>{ remoteAudio.srcObject = ev.streams[0]; });

    if (create) {
      const cands = roomRef.collection('callerCandidates');
      pc.addEventListener('icecandidate', (event)=>{ if (event.candidate) cands.add(event.candidate.toJSON()); });

      const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:false });
      await pc.setLocalDescription(offer);
      await roomRef.set({ offer: { type:offer.type, sdp:offer.sdp } }, { merge:true });

      roomRef.onSnapshot(async (snap)=>{
        const data = snap.data();
        if (!pc.currentRemoteDescription && data?.answer) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          $('status').textContent = `Connected. Room ${roomId}`;
          $('pttBtn').disabled = false;
        }
      });

      roomRef.collection('calleeCandidates').onSnapshot((snapshot)=>{
        snapshot.docChanges().forEach((ch)=>{
          if (ch.type==='added') pc.addIceCandidate(new RTCIceCandidate(ch.doc.data()));
        });
      });

    } else {
      const roomData = (await roomRef.get()).data();
      if (!roomData?.offer) return err("Room has no offer yet. Wait a moment and try again.");

      const cands = roomRef.collection('calleeCandidates');
      pc.addEventListener('icecandidate', (event)=>{ if (event.candidate) cands.add(event.candidate.toJSON()); });

      await pc.setRemoteDescription(new RTCSessionDescription(roomData.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await roomRef.set({ answer: { type:answer.type, sdp:answer.sdp } }, { merge:true });

      roomRef.collection('callerCandidates').onSnapshot((snapshot)=>{
        snapshot.docChanges().forEach((ch)=>{
          if (ch.type==='added') pc.addIceCandidate(new RTCIceCandidate(ch.doc.data()));
        });
      });

      $('status').textContent = `Connected. Room ${roomId}`;
      $('pttBtn').disabled = false;
    }

  } catch (e) {
    err(e.message || String(e));
  }
}

/* ===== Presence (count + names, live) ===== */
let heartbeatTimer = null;
function userDisplayName() {
  const raw = ($('displayName').value || '').trim();
  return raw || "Guest";
}

async function registerPresenceListeners() {
  const pRef = roomRef.collection('participants').doc(clientId);

  // Set self online immediately
  await pRef.set({
    name: userDisplayName(),
    online: true,
    active: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge:true });

  // Update name live as user types (debounced)
  let nameTimer = null;
  $('displayName').addEventListener('input', ()=>{
    clearTimeout(nameTimer);
    nameTimer = setTimeout(()=> {
      pRef.set({ name: userDisplayName(), active: firebase.firestore.FieldValue.serverTimestamp(), online:true }, { merge:true });
    }, 250);
  });

  // Heartbeat so you don't go stale
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(()=> {
    pRef.set({ active: firebase.firestore.FieldValue.serverTimestamp(), online:true }, { merge:true });
  }, 20000);

  // Mark offline on unload
  const clean = async () => {
    try { await pRef.set({ online:false, active: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); } catch {}
  };
  window.addEventListener('beforeunload', clean);
  window.addEventListener('pagehide', clean);

  // Real-time list (no orderBy needed → avoids index issues)
  roomRef.collection('participants').onSnapshot((snap)=>{
    const entries = [];
    snap.forEach(doc=>{
      const d = doc.data() || {};
      const isSelf = (doc.id === clientId);
      const label = isSelf ? "You" : (d.name || "Guest");
      if (d.online !== false) entries.push(label);
    });

    // Update UI (mandatory)
    $('partyCount').textContent = `In room: ${entries.length}`;
    $('partyList').textContent = entries.length ? entries.join(', ') : '—';
  });
}

/* ===== PTT ===== */
function beginTalk() {
  if (!pc || !micTrack) return;
  if (talking) return;
  talking = true;
  micTrack.enabled = true;
  $('pttBtn').classList.add('talking'); // color only; label stays "TALK"
}
function endTalk() {
  if (!pc || !micTrack) return;
  if (!talking) return;
  talking = false;
  micTrack.enabled = false;
  $('pttBtn').classList.remove('talking');
}

/* ===== Err ===== */
function err(msg) {
  $('errors').textContent = msg;
  console.error(msg);
  $('pttBtn').disabled = true;
}
