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
const escapeHtml = (s)=> (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]) );
const uDot = (online)=> online ? '<span class="u-dot"></span>' : '';

window.addEventListener('DOMContentLoaded', async ()=>{
  app = firebase.initializeApp(firebaseConfig);
  db = firebase.firestore(); rtdb = firebase.database(); auth = firebase.auth();
  functions = firebase.functions(); // set region if needed

  // status pills
  $('netPill').textContent = navigator.onLine ? 'Online' : 'Offline';
  window.addEventListener('online', ()=> $('netPill').textContent='Online');
  window.addEventListener('offline', ()=> $('netPill').textContent='Offline');
  $('micPill').textContent = '—';

  // landing buttons
  $('toLoginBtn').onclick  = ()=>authNav('login');
  $('toSignupBtn').onclick = ()=>authNav('signup');

  // login
  $('loginSubmitBtn').onclick = login;
  $('toResetBtn').onclick = ()=>authNav('reset');
  $('backFromLoginBtn').onclick = ()=>authNav('landing');

  // signup
  $('signupSubmitBtn').onclick = signup;
  $('backFromSignupBtn').onclick = ()=>authNav('landing');

  // reset
  $('resetSubmitBtn').onclick = sendReset;
  $('backFromResetBtn').onclick = ()=>authNav('login');

  // tabs
  document.querySelectorAll('.tab[data-page]').forEach(t=>on(t,'click',()=>setPage(t.dataset.page)));
  $('logoutBtn').onclick = async ()=>{ await auth.signOut(); };

  // friends
  $('addFriendBtn').onclick = onAddFriend;
  $('getIdBtn').onclick = getMyId;

  // groups
  $('createRoomBtn').onclick = onCreateRoom;

  // room
  $('inviteBtn').onclick = onInviteFriend;
  $('leaveBtn').onclick = onLeaveRoom;

  // PTT
  setupPTT();

  // auth state
  auth.onAuthStateChanged(async (user)=>{
    currentUser = user;
    if (!user){
      setAuthUI(true);   // show landing
      teardownAll();
      currentProfile = null;
      updateUserPill(); updateMyIdBadge();
      return;
    }
    setAuthUI(false);
    await ensureUserProfile();
    updateUserPill(); updateMyIdBadge();
    wirePresence();
    listenFriends();
    listenFriendRequests();
    listenRooms();
    listenRoomInvites();
    setPage('home');
  });
});

/* ---------- AUTH UI NAV ---------- */
function authNav(which){
  // 'landing' | 'login' | 'signup' | 'reset'
  ['landing','login','signup','reset'].forEach(p=>{
    show(document.getElementById('page-auth-'+p), p === which);
  });
}
function setAuthUI(needAuth){
  if (needAuth){
    authNav('landing');
  }
  ['home','friends','groups','room'].forEach(p=> show(pageEl(p), false));
  document.querySelectorAll('.tab[data-page]').forEach(t=>{
    t.style.pointerEvents = needAuth ? 'none' : 'auto';
  });
}
function updateUserPill(){
  const id = currentProfile?.userID;
  $('userPill').textContent = 'ID ' + (id || '—');
}
function updateMyIdBadge(){
  $('myIdBadge').textContent = 'Your ID: ' + (currentProfile?.userID || '—');
}

/* ---------- Auth actions ---------- */
async function login(){
  try{
    $('loginMsg').textContent = 'Signing in…';
    await auth.signInWithEmailAndPassword($('loginEmail').value.trim(), $('loginPassword').value);
    $('loginMsg').textContent = '';
  }catch(e){ $('loginMsg').textContent = e.message; }
}
async function signup(){
  try{
    const name = $('signupName').value.trim();
    if (!name){ $('signupMsg').textContent = 'Please choose a username.'; return; }
    $('signupMsg').textContent = 'Creating…';
    await auth.createUserWithEmailAndPassword($('signupEmail').value.trim(), $('signupPassword').value);
    const uid = auth.currentUser.uid;
    await db.collection('users').doc(uid).set({
      displayName: name,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });
    await allocateUserIdIfNeeded();
    $('signupMsg').textContent = 'Done.';
  }catch(e){ $('signupMsg').textContent = e.message; }
}
async function sendReset(){
  try{
    const email = $('resetEmail').value.trim();
    if (!email){ $('resetMsg').textContent = 'Enter your email.'; return; }
    await auth.sendPasswordResetEmail(email);
    $('resetMsg').textContent = 'Reset link sent. Check your email.';
  }catch(e){ $('resetMsg').textContent = e.message; }
}
async function ensureUserProfile(){
  const uid = auth.currentUser.uid;
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists){
    await ref.set({ displayName: 'User', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  }
  await allocateUserIdIfNeeded();
  currentProfile = (await ref.get()).data();
}

/* ---------- Presence (RTDB) ---------- */
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

/* ---------- Friends & Requests ---------- */
function teardownAll(){
  [unsubFriends,unsubFriendReq,unsubRooms,unsubRoomInvites,unsubMembers].forEach(fn=>{ try{ fn && fn(); }catch{} });
  unsubFriends=unsubFriendReq=unsubRooms=unsubRoomInvites=unsubMembers=null;
}
const nameWithDot = (name, online)=> `${escapeHtml(name||'User')}${online ? uDot(true) : ''}`;

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
      const d = s.data()||{}; const nm = d.displayName||'Friend'; const id = d.userID?('#'+d.userID):'';
      const piece = `${nameWithDot(nm, !!d.online)} ${id}`;
      all.push(piece); if (d.online) online.push(piece);
      options.push(`<option value="${s.id}">${escapeHtml(nm)} ${id}</option>`);
    });
    $('friendsList').innerHTML = '• ' + all.join('<br>• ');
    $('homeOnline').innerHTML = online.length ? online.join('<br>') : 'No friends online right now.';
    $('inviteSelect').innerHTML = options.join('');
  });
}

function listenFriendRequests(){
  if (unsubFriendReq) unsubFriendReq();
  const uid = auth.currentUser.uid;
  const q = db.collection('friendRequests').where('toUid','==',uid).where('status','==','pending').orderBy('createdAt','desc');
  unsubFriendReq = q.onSnapshot(async (qs)=>{
    if (qs.empty){ $('friendReqList').textContent='—'; return; }
    const rows = await Promise.all(qs.docs.map(async doc=>{
      const d = doc.data();
      let fromName = 'Friend', fromOnline=false;
      try { const s = await db.collection('users').doc(d.fromUid).get(); const x = s.data()||{}; fromName = x.displayName||fromName; fromOnline = !!x.online; } catch {}
      const idText = d.fromUserID ? ` #${d.fromUserID}` : '';
      return `<div>From <b>${nameWithDot(fromName, fromOnline)}</b><span class="hint">${idText}</span>
        <button class="btn" data-acc="${doc.id}">Accept</button>
        <button class="btn" data-rej="${doc.id}">Reject</button></div>`;
    }));
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
    $('addFriendMsg').textContent = res.data?.message || 'Request sent.';
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

/* ---------- Groups ---------- */
function setPage(name){
  document.querySelectorAll('.tab[data-page]').forEach(t=>t.classList.toggle('active', t.dataset.page===name));
  ['home','friends','groups','room'].forEach(p=> show(pageEl(p), p===name));
}
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
      const from = d.fromName || 'Friend';
      rows.push(`<div>Invite to <b>${escapeHtml(d.roomName||'Room')}</b> from <b>${escapeHtml(from)}</b>
        <button class="btn" data-acc="${doc.id}">Join</button>
        <button class="btn" data-rej="${doc.id}">Reject</button></div>`);
    });
    $('invitesList').innerHTML = rows.join('');
    $('invitesList').querySelectorAll('[data-acc]').forEach(b=>on(b,'click',()=>respondInvite(b.dataset.acc,'accepted')));
    $('invitesList').querySelectorAll('[data-rej]').forEach(b=>on(b,'click',()=>respondInvite(b.dataset.rej,'rejected')));
  });
}
async function respondInvite(inviteId, action){
  try{ await functions.httpsCallable('respondRoomInvite')({ inviteId, action }); }
  catch(e){ console.error(e); }
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
async function onInviteFriend(){
  if (!activeRoom) return;
  const toUid = $('inviteSelect').value;
  if (!toUid){ return; }
  try{
    await functions.httpsCallable('sendRoomInvite')({ roomId: activeRoom.roomId, toUid });
  }catch(e){
    $('errors').textContent = e.message;
  }
}
async function enterRoom(roomId){
  activeRoom = { roomId };
  setPage('room'); $('errors').textContent=''; $('status').textContent='Status: Loading…'; $('pttBtn').disabled = true;

  if (unsubMembers) unsubMembers();
  const memCol = db.collection('rooms').doc(roomId).collection('members');
  unsubMembers = memCol.onSnapshot((qs)=>{
    const names=[], online=[];
    qs.forEach(doc=>{ const d=doc.data()||{}; const nm=d.displayName||'User'; names.push(nameWithDot(nm, !!d.online)); if (d.online) online.push(nm); });
    $('memberCounts').textContent = `Members: ${qs.size} (Online: ${online.length})`;
    $('memberNames').innerHTML = names.join('<br>') || '—';
  });

  const r = await db.collection('rooms').doc(roomId).get();
  $('roomHeader').textContent = r.exists ? (r.data().roomName || 'Room') : 'Room';

  const uid = auth.currentUser.uid;
  await memCol.doc(uid).set({
    displayName: currentProfile?.displayName || 'User',
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

/* ---------- Callables (IDs) ---------- */
async function allocateUserIdIfNeeded(){
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const doc = await db.collection('users').doc(uid).get();
  if (doc.exists && doc.data().userID) return;
  try{ await functions.httpsCallable('allocateUserIdOnSignup')({}); }
  catch(e){ console.warn('ID allocation failed:', e); }
}
async function getMyId(){
  if (!auth.currentUser){ $('getIdMsg').textContent = 'Please log in first.'; return; }
  $('getIdMsg').textContent = 'Checking…';
  try{
    await allocateUserIdIfNeeded();
    const uid = auth.currentUser.uid;
    const snap = await db.collection('users').doc(uid).get();
    currentProfile = snap.data();
    updateUserPill(); updateMyIdBadge();
    $('getIdMsg').textContent = currentProfile?.userID ? `Your ID is ${currentProfile.userID}` : 'Still no ID — check Functions deploy.';
  }catch(e){ $('getIdMsg').textContent = `Couldn’t get ID: ${e.message}`; }
}

/* ---------- PTT / WebRTC ---------- */
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
