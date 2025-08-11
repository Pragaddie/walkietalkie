// Basic 1:1 WebRTC with Firestore signaling + push-to-talk (PTT)

let app, db;
let pc;
let localStream;
let micTrack;
let roomRef;
let roomId;
let isCaller = false;
let talking = false;

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

  // --- LOCK the label so it always says TALK ---
  ptt.textContent = "TALK";
  const lockLabel = () => { if (ptt.textContent !== "TALK") ptt.textContent = "TALK"; };
  new MutationObserver(lockLabel).observe(ptt, { childList: true, characterData: true, subtree: true });

  // Prevent long-press selection / context menus for PTT
  ptt.addEventListener('mousedown', (e) => { e.preventDefault(); beginTalk(); }, {passive:false});
  ptt.addEventListener('touchstart', (e) => { e.preventDefault(); beginTalk(); }, {passive:false});

  window.addEventListener('mouseup',   (e) => { e.preventDefault(); endTalk(); }, {passive:false});
  window.addEventListener('touchend',  (e) => { e.preventDefault(); endTalk(); }, {passive:false});

  // Spacebar PTT
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); beginTalk(); }
  }, {passive:false});
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { e.preventDefault(); endTalk(); }
  }, {passive:false});

  // Block context menu specifically on the PTT
  window.addEventListener('contextmenu', (e) => {
    if (e.target && e.target.id === 'pttBtn') e.preventDefault();
  });
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
    pc.addEventListener('track', (ev) => {
      remoteAudio.srcObject = ev.streams[0];
    });

    let candidatesCollection;

    if (create) {
      // Caller creates a room
      roomId = (byId('roomId').value || '').trim() || String(Math.floor(1000 + Math.random()*9000));
      roomRef = db.collection('rooms').doc(roomId);
      await roomRef.set({ created: firebase.firestore.FieldValue.serverTimestamp(), who: (byId('displayName').value||"Caller") });

      candidatesCollection = roomRef.collection('callerCandidates');
      pc.addEventListener('icecandidate', (event) => {
        if (event.candidate) candidatesCollection.add(event.candidate.toJSON());
      });

      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      await roomRef.update({ offer: { type: offer.type, sdp: offer.sdp } });

      roomRef.onSnapshot(async (snap) => {
        const data = snap.data();
        if (!pc.currentRemoteDescription && data?.answer) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          byId('status').textContent = `Connected. Room ${roomId}`;
          byId('pttBtn').disabled = false;
        }
        byId('who').textContent = data?.joiner ? `Partner: ${data.joiner}` : '';
      });

      roomRef.collection('calleeCandidates').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const cand = new RTCIceCandidate(change.doc.data());
            pc.addIceCandidate(cand);
          }
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

      candidatesCollection = roomRef.collection('calleeCandidates');
      pc.addEventListener('icecandidate', (event) => {
        if (event.candidate) candidatesCollection.add(event.candidate.toJSON());
      });

      const roomData = roomSnap.data();
      if (!roomData?.offer) { err("Room has no offer yet. Wait a moment and try again."); return; }
      await pc.setRemoteDescription(new RTCSessionDescription(roomData.offer));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await roomRef.update({ answer: { type: answer.type, sdp: answer.sdp }, joiner: (byId('displayName').value||"Joiner") });

      roomRef.collection('callerCandidates').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const cand = new RTCIceCandidate(change.doc.data());
            pc.addIceCandidate(cand);
          }
        });
      });

      byId('status').textContent = `Connected. Room ${roomId}`;
      byId('pttBtn').disabled = false;
      isCaller = false;
    }
  } catch (e) {
    err(e.message || String(e));
  }
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
