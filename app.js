// Device UI with internal pages: auth → home (online friends) → friends → groups → room
let app, db, rtdb, auth, functions;
let currentUser = null, currentProfile = null;
let unsubFriends = null, unsubFriendReq = null, unsubRooms = null, unsubRoomInvites = null, unsubMembers = null;

let pc, localStream, micTrack;
let activeRoom = null, talking = false;

// helpers
const $ = (id)=>document.getElementById(id);
const on = (el,ev,cb,opts)=>el.addEventListener(ev,cb,opts||{});
const show = (el,vis)=>{ el.style.display = vis ? 'block' : 'none'; };
const pageEl = (name)=>document.getElementById('page-'+name);

// boot
window.addEventListener('DOMContentLoaded', async ()=>{
  app = firebase.initializeApp(firebaseConfig);
  db = firebase.firestore(); rtdb = firebase.database(); auth = firebase.auth(); functions = firebase.functions();

  // pills
  $('netPill').textContent = navigator.onLine ? 'Online' : 'Offline';
  window.addEventListener('online', ()=> $('netPill').textContent='Online');
  window.addEventListener('offline', ()=> $('netPill').textContent='Offline');

  // auth buttons
  $('loginBtn').onclick = login;
  $('signupBtn').onclick = signup;

  // tabs
  document.querySelectorAll('.tab[data-page]').forEach(t=>on(t,'click',()=>setPage(t.dataset.page)));

  // global actions
  $('logoutBtn').onclick = async ()=>{ await auth.signOut(); };

  // Friends page
  $('addFriendBtn').onclick = onAddFriend;

  // Groups page
  $('createRoomBtn').onclick = onCreateRoom;

  // Room page
  $('inviteBtn').onclick = onInviteFriend;
  $('leaveBtn').onclick = onLeaveRoom;

  // PTT
  setupPTT();

  // auth state
  auth.onAuthStateChanged(async (user)=>{
    currentUser = user;
    if (!user){
      setAuthUI(true);
      teardownAll();
      currentProfile = null; updateUserPill();
      return;
    }
    setAuthUI(false);
    await ensureUserProfile();
    updateUserPill();
    wirePresence();
    // listeners
    listenFriends();
    listenFriendRequests();
    listenRooms();
    listenRoomInvites();
    // land on Home page
    setPage('home');
  });
});

// ===== UI paging
function setAuthUI(isAuthNeeded){
  show(pageEl('auth'), isAuthNeeded);
  const after = !isAuthNeeded;
  ['home','friends','groups','room'].forEach(p=>show(pageEl(p), false));
  document.querySelectorAll('.tab[data-page]').forEach(t=> t.style.pointerEvents = after ? 'auto' : 'none');
}
function setPage(name){
  // tabs state
  document.querySelectorAll('.tab[data-page]').forEach(t=>t.classList.toggle('active', t.dataset.page===name));
  // pages
  ['auth','home','friends','groups','room'].forEach(p=> show(pageEl(p), p===name));
}
function updateUserPill(){
  $('userPill').textContent = currentUser ? (currentProfile?.userID ? `ID ${currentProfile.userID}` : currentUser.email) : '—';
}

// ===== Auth
async function login(){
  try{
    await auth.signInWithEmailAndPassword($('email').value.trim(), $('password').value);
    $('authMsg').textContent = 'Logged in.';
  }catch(e){ $('authMsg').textContent = e.message; }
}
async function signup(){
  try{
    await auth.createUserWithEmailAndPassword($('email').value.trim(), $('password').value);
    await allocateUserIdIfNeeded();
    $('authMsg').textContent = 'Signed up.';
  }catch(e){ $('authMsg').textContent = e.message; }
}
async function ensureUserProfile(){
  const uid = auth.currentUser.uid;
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists){
    await ref.set({ displayName: auth.currentUser.email.split('@')[0], createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  }
  await allocateUserIdIfNeeded();
  currentProfile = (await ref.get()).data();
}

// ===== Presence (RTDB presence → mirrored by CF)
function wirePresence(){
  const uid = auth.currentUser.uid;
  const statusRef = rtdb.ref('/status/'+uid);
  const infoRef = rtdb.ref('.info/connected');
  infoRef.on('value', async (snap)=>{
    if (!snap.val()) return;
    await statusRef.onDisconnect().set({ state:'offline', lastChanged: firebase.database.ServerValue.TIMESTAMP }).catch(()=>{});
    statusRef.set({ state:'online', lastChanged: firebase.database.ServerValue.TIMESTAMP });
  });
}

// ===== Friends & Requests
function teardownAll(){
  [unsubFriends,unsubFriendReq,unsubRooms,unsubRoomInvites,unsubMembers].forEach(fn=>{ try{ fn && fn(); }catch{} });
  unsubFriends=unsubFriendReq=unsubRooms=unsubRoomInvites=unsubMembers=null;
}

function listenFriends(){
  if (unsubFriends) unsubFriends();
  const uid = auth.currentUser.uid;
  const q = db.collection('friends').where('uids','array-contains', uid);
  unsubFriends = q.onSnapshot(async (qs)=>{
    const friendUids = [];
    qs.forEach(doc=>{ const uids = doc.data().uids||[]; const other = uids.find(x=>x!==uid); if (other) friendUids.push(other); });
    if (!friendUids.length){
      $('friendsList').textContent='—'; $('homeOnline').textContent='—'; $('inviteSelect').innerHTML='';
      return;
    }
    const snaps = await Promise.all(friendUids.map(f=>db.collection('users').doc(f).get()));
    const all=[], online=[], options=[];
    snaps.forEach(s=>{
      const d = s.data()||{}; const n = d.displayName||'Friend'; const id = d.userID?('#'+d.userID):''; const dot = d.online?'●':'○';
      all.push(`${dot} ${n} ${id}`); if (d.online) online.push(`${n} ${id}`); options.push(`<option value="${s.id}">${n} ${id}</option>`);
    });
    $('friendsList').textContent = all.join(', ');
    $('homeOnline').textContent = online.length ? online.join(', ') : 'No friends online right now.';
    $('inviteSelect').innerHTML = options.join('');
  });
}

function listenFriendRequests(){
  if (unsubFriendReq) unsubFriendReq();
  const uid = auth.currentUser.uid;
  const q = db.collection('friendRequests').where('toUid','==',uid).where('status','==','pending').orderBy('createdAt','desc');
  unsubFriendReq = q.onSnapshot((qs)=>{
    if (qs.empty){ $('friendReqList').textContent='—'; return; }
    const rows=[];
    qs.forEach(doc=>{
      const d = doc.data();
      rows.push(`<div>From <b>${d.fromUserID ? '#'+d.fromUserID : 'user'}</b>
        <button class="btn" data-acc="${doc.id}">Accept</button>
        <button class="btn" data-rej="${doc.id}">Reject</button></div>`);
    });
    $('friendReqList').innerHTML = rows.join('');
    $('friendReqList').querySelectorAll('[data-acc]').forEach(b=>on(b,'click',()=>respondFriendReq(b.dataset.acc,'accepted')));
    $('friendReqList').querySelectorAll('[data-rej]').forEach(b=>on(b,'click',()=>respondFriendReq(b.dataset.rej,'rejected')));
  });
}

async function onAddFriend(){
  $('addFriendMsg').textContent='';
  const raw = $('addFriendInput').value.trim();
  if (!raw){ $('addFriendMsg').textContent='Enter an ID.'; return; }
  if (!/^\d+$/.test(raw)){ $('addFriendMsg').textContent='Digits only.'; return; }
  try{
    const send = functions.httpsCallable('sendFriendRequest');
    const res = await send({ userIdDigits: raw });
    $('addFriendMsg').textContent = res.data.message || 'Request sent.';
    $('addFriendInput').value='';
  }catch(e){ $('addFriendMsg').textContent = e.message; }
}

async function respondFriendReq(reqId, action){
  try{
    const ref = db.collection('friendRequests').doc(reqId);
    const snap = await ref.get(); if (!snap.exists) return;
    const d = snap.data();
    if (action==='accepted'){
      const pairId = [d.fromUid,d.toUid].sort().join('_');
      await db.collection('friends').doc(pairId).set({ uids:[d.fromUid,d.toUid], createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
      await ref.set({ status:'accepted' }, { merge:true });
    }else{
      await ref.set({ status:'rejected' }, { merge:true });
    }
  }catch(e){ console.error(e); }
}

// ===== Groups (rooms + invites)
function listenRooms(){
  if (unsubRooms) unsubRooms();
  const uid = auth.currentUser.uid;
  const q = db.collection('rooms').where('memberUids','array-contains', uid).orderBy('createdAt','desc');
  unsubRooms = q.onSnapshot((qs)=>{
    if (qs.empty){ $('roomsList').textContent='—'; return; }
    const out=[];
    qs.forEach(doc=>{
      const d = doc.data(); const name = d.roomName || 'Room';
      out.push(`<div><b>${escapeHtml(name)}</b> <span class="hint">(Members: ${d.memberCount||1})</span> <button class="btn" data-open="${doc.id}">Open</button></div>`);
    });
    $('roomsList').innerHTML = out.join('');
    $('roomsList').querySelectorAll('[data-open]').forEach(b=>on(b,'click',()=>enterRoom(b.dataset.open)));
  });
}

function listenRoomInvites(){
  if (unsubRoomInvites) unsubRoomInvites();
  const uid = auth.currentUser.uid;
  const q = db.collection('roomInvites').where('toUid','==', uid).where('status','==','pending').orderBy('createdAt','desc');
  unsubRoomInvites = q.onSnapshot((qs)=>{
    if (qs.empty){ $('invitesList').textContent='—'; return; }
    const rows=[];
    qs.forEach(doc=>{
      const d = doc.data();
      rows.push(`<div>Invite to <b>${escapeHtml(d.roomName||'Room')}</b> from <b>${escapeHtml(d.fromName||'Friend')}</b>
        <button class="btn" data-acc="${doc.id}">Join</button>
        <button class="btn" data-rej="${doc.id}">Reject</button></div>`);
    });
    $('invitesList').innerHTML = rows.join('');
    $('invitesList').querySelectorAll('[data-acc]').forEach(b=>on(b,'click',()=>respondInvite(b.dataset.acc,'accepted')));
    $('invitesList').querySelectorAll('[data-rej]').forEach(b=>on(b,'click',()=>respondInvite(b.dataset.rej,'rejected')));
  });
}

async function respondInvite(inviteId, action){
  try{
    await functions.httpsCallable('respondRoomInvite')({ inviteId, action });
  }catch(e){ console.error(e); }
}

async function onCreateRoom(){
  $('groupsMsg').textContent='';
  const name = $('roomNameInput').value.trim();
  if (!name){ $('groupsMsg').textContent='Enter a group name.'; return; }
  try{
    const res = await functions.httpsCallable('createRoom')({ roomName:name });
    $('roomNameInput').value=''; $('groupsMsg').textContent='Group created.';
    await enterRoom(res.data.roomId);
  }catch(e){ $('groupsMsg').textContent = e.message; }
}

async function enterRoom(roomId){
  activeRoom = { roomId };
  setPage('room'); $('errors').textContent=''; $('status').textContent='Status: Loading…'; $('pttBtn').disabled = true;

  if (unsubMembers) unsubMembers();
  const memCol = db.collection('rooms').doc(roomId).collection('members');
  unsubMembers = memCol.onSnapshot((qs)=>{
    const names=[], online=[];
    qs.forEach(doc=>{ const d=doc.data()||{}; const n=d.displayName||'User'; names.push(n); if (d.online) online.push(n); });
    $('memberCounts').textContent = `Members: ${qs.size} (Online: ${online.length})`;
    $('memberNames').textContent = names.join(', ') || '—';
  });

  const r = await db.collection('rooms').doc(roomId).get();
  $('roomHeader').textContent = r.exists ? (r.data().roomName || 'Room') : 'Room';

  const uid = auth.currentUser.uid;
  await memCol.doc(uid).set({
    displayName: currentProfile?.displayName || auth.currentUser.email.split('@')[0],
    userID: currentProfile?.userID || null,
    online: true,
    joinedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge:true });

  try{
    await setupMedia();
    await startPttSignaling(roomId);
    $('pttBtn').disabled = false;
  }catch(e){ $('errors').textContent = e.message; }
}

async function onLeaveRoom(){
  if (!activeRoom) return;
  teardownWebRTC();
  const uid = auth.currentUser.uid;
  const memCol = db.collection('rooms').doc(activeRoom.roomId).collection('members');
  await memCol.doc(uid).set({ online:false }, { merge:true });
  await memCol.doc(uid).delete().catch(()=>{});
  activeRoom = null;
  if (unsubMembers){ try{unsubMembers();}catch{} unsubMembers=null; }
  setPage('groups');
}

// ===== Callables
async function allocateUserIdIfNeeded(){
  const uid = auth.currentUser.uid;
  const doc = await db.collection('users').doc(uid).get();
  if (doc.exists && doc.data().userID) return;
  await functions.httpsCallable('allocateUserIdOnSignup')({});
}

// ===== PTT / WebRTC (1:1 baseline)
function setupPTT(){
  const ptt = $('pttBtn'); let down = false;
  const begin = e=>{ e.preventDefault(); if(!down){down=true; beginTalk();} };
  const end = e=>{ e.preventDefault(); if(down){down=false; endTalk();} };
  on(ptt,'mousedown',begin); on(ptt,'touchstart',begin,{passive:false});
  on(ptt,'mouseup',end); on(ptt,'mouseleave',end); on(ptt,'touchend',end); on(ptt,'touchcancel',end);
  window.addEventListener('keydown',(e)=>{ if(e.code==='Space'&&!down){ const t=(e.target.tagName||'').toLowerCase(); if (t==='input'||t==='textarea') return; e.preventDefault(); down=true; beginTalk(); } },{passive:false});
  window.addEventListener('keyup',(e)=>{ if(e.code==='Space'&&down){ const t=(e.target.tagName||'').toLowerCase(); if (t==='input'||t==='textarea') return; e.preventDefault(); down=false; endTalk(); } },{passive:false});
}

async function setupMedia(){
  $('micPill').textContent = '…';
  localStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true }, video:false });
  $('micPill').textContent = 'OK';
  micTrack = localStream.getAudioTracks()[0];
}

async function startPttSignaling(roomId){
  const rtcConfig = { iceServers: [
    { urls: [ 'stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478' ] }
    // TODO: TURN for reliability
  ]};
  pc = new RTCPeerConnection(rtcConfig);
  micTrack.enabled = false;
  pc.addTrack(micTrack, localStream);

  $('status').textContent = 'Status: Signaling…';

  const remoteAudio = $('remoteAudio');
  pc.addEventListener('track', (ev)=>{ remoteAudio.srcObject = ev.streams[0]; });

  const roomRef = db.collection('rooms').doc(roomId);
  const callerCands = roomRef.collection('callerCandidates');
  const calleeCands = roomRef.collection('calleeCandidates');

  const uid = auth.currentUser.uid;
  const roomSnap = await roomRef.get();
  const memberUids = roomSnap.data()?.memberUids || [];
  const otherUid = memberUids.find(x=>x!==uid);
  const amCaller = uid < (otherUid||'z');

  if (amCaller){
    pc.addEventListener('icecandidate', (e)=>{ if(e.candidate) callerCands.add(e.candidate.toJSON()); });
    const offer = await pc.createOffer({ offerToReceiveAudio:true });
    await pc.setLocalDescription(offer);
    await roomRef.set({ offer: { type:offer.type, sdp:offer.sdp } }, { merge:true });
    roomRef.onSnapshot(async (snap)=>{
      const data = snap.data();
      if (!pc.currentRemoteDescription && data?.answer){
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        $('status').textContent = 'Status: Connected';
        $('pttBtn').disabled = false;
      }
    });
    calleeCands.onSnapshot((qs)=>qs.docChanges().forEach(ch=>{
      if (ch.type==='added'){ pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())); }
    }));
  }else{
    pc.addEventListener('icecandidate', (e)=>{ if(e.candidate) calleeCands.add(e.candidate.toJSON()); });
    roomRef.onSnapshot(async (snap)=>{
      const data = snap.data();
      if (data?.offer && !pc.currentRemoteDescription){
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await roomRef.set({ answer: { type:answer.type, sdp:answer.sdp } }, { merge:true });
        $('status').textContent = 'Status: Connected';
        $('pttBtn').disabled = false;
      }
    });
    callerCands.onSnapshot((qs)=>qs.docChanges().forEach(ch=>{
      if (ch.type==='added'){ pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())); }
    }));
  }
}

function beginTalk(){ if (!pc || !micTrack || talking) return; talking=true; micTrack.enabled=true; $('pttBtn').classList.add('talking'); }
function endTalk(){ if (!pc || !micTrack || !talking) return; talking=false; micTrack.enabled=false; $('pttBtn').classList.remove('talking'); }
function teardownWebRTC(){
  try{ if (pc){ pc.getSenders().forEach(s=>{try{s.track&&s.track.stop();}catch{}}); pc.close(); } }catch{}
  pc=null; localStream=null; micTrack=null; talking=false;
  $('pttBtn').disabled=true; $('status').textContent='Status: Idle'; $('pttBtn').classList.remove('talking');
}

// utils
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
