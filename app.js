/* ===== Walkie-Talkie app.js (audio autoplay fix + clean auth + invites/rooms) ===== */

let app, db, rtdb, auth, functions;
let currentUser = null, currentProfile = null;

let unsubFriends = null, unsubFriendReq = null, unsubRooms = null, unsubRoomInvites = null, unsubMembers = null;

let pc, localStream, micTrack;
let activeRoom = null, talking = false;

/* ---------- tiny helpers ---------- */
const $ = (id)=>document.getElementById(id);
const on = (el,ev,cb,opts)=>el && el.addEventListener(ev,cb,opts||{});
const show = (el,vis)=>{ if(!el) return; el.style.display = vis ? 'block' : 'none'; };
const pageEl = (name)=>$('page-'+name);
const escapeHtml = (s)=> (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const uDot = (onl)=> onl ? '<span class="u-dot"></span>' : '';
const nameWithDot = (nm,onl)=> `${escapeHtml(nm||'User')}${onl?uDot(true):''}`;

/* hide landing when logged in */
function toggleAuthLanding(loggedIn){
  const landing = $('page-auth-landing');
  if (!landing) return;
  landing.style.display = loggedIn ? 'none' : 'block';
  // optional greeting block (if present)
  const ctas = $('authCtas'), greet = $('authGreet'), hi = $('hiName');
  if (ctas && greet){
    ctas.style.display = loggedIn ? 'none' : 'flex';
    greet.style.display = loggedIn ? 'grid' : 'none';
    if (loggedIn && hi) hi.textContent = (currentProfile?.displayName || 'Friend');
  }
}

/* ---------- boot ---------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  // guard
  if (!window.firebase || !firebase.initializeApp){ alert('Firebase SDK not loaded'); throw new Error('Firebase SDK not loaded'); }
  if (typeof firebaseConfig === 'undefined'){ alert('firebase-config.js must load before app.js'); throw new Error('config missing'); }

  app = firebase.initializeApp(firebaseConfig);
  db = firebase.firestore(); rtdb = firebase.database(); auth = firebase.auth();
  functions = firebase.functions();

  // status pills
  $('netPill').textContent = navigator.onLine ? 'Online' : 'Offline';
  window.addEventListener('online', ()=> $('netPill').textContent='Online');
  window.addEventListener('offline', ()=> $('netPill').textContent='Offline');
  $('micPill').textContent = '—';

  // auth landing buttons
  on($('toLoginBtn'),'click', ()=>authNav('login'));
  on($('toSignupBtn'),'click',()=>authNav('signup'));

  // login/signup/reset
  on($('loginSubmitBtn'),'click', login);
  on($('toResetBtn'),'click',   ()=>authNav('reset'));
  on($('backFromLoginBtn'),'click',  ()=>authNav('landing'));
  on($('signupSubmitBtn'),'click', signup);
  on($('backFromSignupBtn'),'click', ()=>authNav('landing'));
  on($('resetSubmitBtn'),'click', sendReset);
  on($('backFromResetBtn'),'click',  ()=>authNav('login'));

  // tabs + logout
  document.querySelectorAll('.tab[data-page]').forEach(t=>on(t,'click',()=>setPage(t.dataset.page)));
  on($('logoutBtn'),'click', async ()=>{ try{ await auth.signOut(); }catch{} });

  // friends / groups / room
  on($('addFriendBtn'),'click', onAddFriend);
  on($('getIdBtn'),'click', getMyId);
  on($('createRoomBtn'),'click', onCreateRoom);
  on($('inviteBtn'),'click', onInviteFriend);
  on($('leaveBtn'),'click', onLeaveRoom);

  // PTT
  setupPTT();

  // auth state
  auth.onAuthStateChanged(async (user)=>{
    currentUser = user;

    if (!user){
      setAuthUI(true);
      teardownAll();
      currentProfile = null;
      updateUserPill(); updateMyIdBadge();
      toggleAuthLanding(false);    // show landing when logged out
      return;
    }

    setAuthUI(false);
    await ensureUserProfile();
    updateUserPill(); updateMyIdBadge();
    wirePresence();

    listenFriends();
    listenFriendRequests();        // simple queries (no composite index)
    listenRoomInvites();           // simple queries (no composite index)
    listenRooms();                 // simple query + client sort

    setPage('home');
    toggleAuthLanding(true);       // hide landing when logged in
  });
});

/* ---------- AUTH UI NAV ---------- */
function authNav(which){
  ['landing','login','signup','reset'].forEach(p=> show($('page-auth-'+p), p===which));
}
function setAuthUI(needAuth){
  if (needAuth) authNav('landing');
  ['home','friends','groups','room'].forEach(p=> show(pageEl(p), false));
  document.querySelectorAll('.tab[data-page]').forEach(t=> t.style.pointerEvents = needAuth ? 'none' : 'auto');
}
function updateUserPill(){
  $('userPill').textContent = 'ID ' + (currentProfile?.userID || '—');
}
function updateMyIdBadge(){
  if ($('myIdBadge')) $('myIdBadge').textContent = 'Your ID: ' + (currentProfile?.userID || '—');
}

/* ---------- Auth actions ---------- */
async function login(){
  try{
    $('loginMsg').textContent='Signing in…';
    await auth.signInWithEmailAndPassword($('loginEmail').value.trim(), $('loginPassword').value);
    $('loginMsg').textContent='';
  }catch(e){ $('loginMsg').textContent = e.message; }
}
async function signup(){
  try{
    const name = $('signupName').value.trim();
    if (!name){ $('signupMsg').textContent='Please choose a username.'; return; }
    $('signupMsg').textContent='Creating…';
    await auth.createUserWithEmailAndPassword($('signupEmail').value.trim(), $('signupPassword').value);
    const uid = auth.currentUser.uid;
    await db.collection('users').doc(uid).set({
      displayName: name,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });
    await allocateUserIdIfNeeded();
    $('signupMsg').textContent='Done.';
  }catch(e){ $('signupMsg').textContent = e.message; }
}
async function sendReset(){
  try{
    const email = $('resetEmail').value.trim();
    if (!email){ $('resetMsg').textContent='Enter your email.'; return; }
    await auth.sendPasswordResetEmail(email);
    $('resetMsg').textContent='Reset link sent. Check your email.';
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

function listenFriends(){
  if (unsubFriends) unsubFriends();
  const uid = auth.currentUser.uid;
  const q = db.collection('friends').where('uids','array-contains', uid);
  unsubFriends = q.onSnapshot(async (qs)=>{
    const friendUids = [];
    qs.forEach(doc=>{ const arr = doc.data().uids||[]; const other = arr.find(x=>x!==uid); if (other) friendUids.push(other); });
    if (!friendUids.length){
      if ($('friendsList')) $('friendsList').textContent='—';
      if ($('homeOnline')) $('homeOnline').textContent='—';
      if ($('inviteSelect')) $('inviteSelect').innerHTML='';
      return;
    }
    const snaps = await Promise.all(friendUids.map(f=>db.collection('users').doc(f).get()));
    const all=[], online=[], options=[];
    snaps.forEach(s=>{
      const d = s.data()||{}; const nm = d.displayName || 'Friend'; const id = d.userID ? (' #'+d.userID) : '';
      const piece = `${nameWithDot(nm, !!d.online)}${id}`;
      all.push(piece); if (d.online) online.push(piece);
      options.push(`<option value="${s.id}">${escapeHtml(nm)}${id}</option>`);
    });
    if ($('friendsList')) $('friendsList').innerHTML = '• ' + all.join('<br>• ');
    if ($('homeOnline'))  $('homeOnline').innerHTML  = online.length ? online.join('<br>') : 'No friends online right now.';
    if ($('inviteSelect')) $('inviteSelect').innerHTML = options.join('');
  });
}

function listenFriendRequests(){
  if (unsubFriendReq) unsubFriendReq();
  const uid = auth.currentUser.uid;

  // simple equality query; filter/sort client-side
  const q = db.collection('friendRequests').where('toUid','==', uid);

  unsubFriendReq = q.onSnapshot(async (qs)=>{
    const docs = qs.docs
      .map(d => ({ id:d.id, ...d.data() }))
      .filter(d => (d.status || 'pending') === 'pending')
      .sort((a,b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
      .reverse();

    if (!docs.length){ if ($('friendReqList')) $('friendReqList').textContent='—'; return; }

    const rows = await Promise.all(docs.map(async d=>{
      let fromName = 'Friend', fromOnline=false;
      try { const s = await db.collection('users').doc(d.fromUid).get(); const x = s.data()||{}; fromName = x.displayName||fromName; fromOnline = !!x.online; } catch {}
      const idText = d.fromUserID ? ` #${d.fromUserID}` : '';
      return `<div>From <b>${nameWithDot(fromName, fromOnline)}</b><span class="hint">${idText}</span>
        <button class="btn" data-acc="${d.id}">Accept</button>
        <button class="btn" data-rej="${d.id}">Reject</button></div>`;
    }));

    if ($('friendReqList')){
      $('friendReqList').innerHTML = rows.join('');
      $('friendReqList').querySelectorAll('[data-acc]').forEach(b=>on(b,'click',()=>respondFriendReq(b.dataset.acc,'accepted')));
      $('friendReqList').querySelectorAll('[data-rej]').forEach(b=>on(b,'click',()=>respondFriendReq(b.dataset.rej,'rejected')));
    }
  });
}

async function onAddFriend(){
  if (!$('addFriendInput')) return;
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
      const pairId = [d.fromUid, d.toUid].sort().join('_');
      await db.collection('friends').doc(pairId).set({
        uids:[d.fromUid, d.toUid],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
      await ref.set({ status:'accepted' }, { merge:true });
    }else{
      await ref.set({ status:'rejected' }, { merge:true });
    }
  }catch(e){ console.error(e); }
}

/* ---------- Groups (rooms) ---------- */
function setPage(name){
  document.querySelectorAll('.tab[data-page]').forEach(t=>t.classList.toggle('active', t.dataset.page===name));
  ['home','friends','groups','room'].forEach(p=> show(pageEl(p), p===name));
}

/* rooms list without composite index; sort on client */
function listenRooms(){
  if (unsubRooms) unsubRooms();
  const uid = auth.currentUser.uid;
  const q = db.collection('rooms').where('memberUids','array-contains', uid);

  unsubRooms = q.onSnapshot((qs)=>{
    if (!$('roomsList')) return;

    const docs = qs.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b)=> (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

    if (!docs.length){ $('roomsList').textContent = '—'; return; }

    const out = docs.map(d =>
      `<div><b>${escapeHtml(d.roomName || 'Room')}</b>
        <span class="hint">(Members: ${d.memberCount || (d.memberUids?.length || 1)})</span>
        <button class="btn" data-open="${d.id}">Open</button>
       </div>`
    );

    $('roomsList').innerHTML = out.join('');
    $('roomsList').querySelectorAll('[data-open]')
      .forEach(b => b.onclick = () => enterRoom(b.dataset.open));
  });
}

/* invites list (simple query) */
function listenRoomInvites(){
  if (unsubRoomInvites) unsubRoomInvites();
  const uid = auth.currentUser.uid;
  const q = db.collection('roomInvites').where('toUid','==', uid);

  unsubRoomInvites = q.onSnapshot((qs)=>{
    if (!$('invitesList')) return;

    const docs = qs.docs
      .map(d => ({ id:d.id, ...d.data() }))
      .filter(d => (d.status || 'pending') === 'pending')
      .sort((a,b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

    if (!docs.length){ $('invitesList').textContent='—'; return; }

    const rows = docs.map(d=>{
      const from = d.fromName || 'Friend';
      return `<div>Invite to <b>${escapeHtml(d.roomName||'Room')}</b> from <b>${escapeHtml(from)}</b>
        <button class="btn" data-acc="${d.id}">Join</button>
        <button class="btn" data-rej="${d.id}">Reject</button></div>`;
    });

    $('invitesList').innerHTML = rows.join('');
    $('invitesList').querySelectorAll('[data-acc]').forEach(b=>on(b,'click',()=>respondInvite(b.dataset.acc,'accepted')));
    $('invitesList').querySelectorAll('[data-rej]').forEach(b=>on(b,'click',()=>respondInvite(b.dataset.rej,'rejected')));
  });
}

/* accept invite → go in immediately */
async function respondInvite(inviteId, action){
  try{
    const snap = await db.collection('roomInvites').doc(inviteId).get();
    const roomId = snap.exists ? (snap.data().roomId || null) : null;

    await functions.httpsCallable('respondRoomInvite')({ inviteId, action });

    if (action === 'accepted' && roomId){
      await enterRoom(roomId);
    }
  }catch(e){
    console.error(e);
  }
}

async function onCreateRoom(){
  if (!$('roomNameInput')) return;
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
  if (!activeRoom || !$('inviteSelect')) return;
  const toUid = $('inviteSelect').value;
  if (!toUid) return;
  try{
    await functions.httpsCallable('sendRoomInvite')({ roomId: activeRoom.roomId, toUid });
  }catch(e){ if ($('errors')) $('errors').textContent = e.message; }
}

async function enterRoom(roomId){
  activeRoom = { roomId };
  setPage('room');
  if ($('errors')) $('errors').textContent='';
  if ($('status')) $('status').textContent='Status: Loading…';
  if ($('pttBtn')) $('pttBtn').disabled = true;

  if (unsubMembers) unsubMembers();
  const memCol = db.collection('rooms').doc(roomId).collection('members');
  unsubMembers = memCol.onSnapshot((qs)=>{
    if (!$('memberCounts') || !$('memberNames')) return;
    const names=[], onlines=[];
    qs.forEach(doc=>{ const d=doc.data()||{}; const nm=d.displayName||'User'; names.push(nameWithDot(nm, !!d.online)); if (d.online) onlines.push(nm); });
    $('memberCounts').textContent = `Members: ${qs.size} (Online: ${onlines.length})`;
    $('memberNames').innerHTML = names.join('<br>') || '—';
  });

  const r = await db.collection('rooms').doc(roomId).get();
  if ($('roomHeader')) $('roomHeader').textContent = r.exists ? (r.data().roomName||'Room') : 'Room';

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
    if ($('pttBtn')) $('pttBtn').disabled = false;
  }catch(e){ if ($('errors')) $('errors').textContent = e.message; }
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

/* ---------- IDs / callables ---------- */
async function allocateUserIdIfNeeded(){
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const doc = await db.collection('users').doc(uid).get();
  if (doc.exists && doc.data().userID) return;
  try{ await functions.httpsCallable('allocateUserIdOnSignup')({}); }
  catch(e){ console.warn('ID allocation failed:', e); }
}
async function getMyId(){
  if (!auth.currentUser){ if ($('getIdMsg')) $('getIdMsg').textContent='Please log in first.'; return; }
  if ($('getIdMsg')) $('getIdMsg').textContent='Checking…';
  try{
    await allocateUserIdIfNeeded();
    const uid = auth.currentUser.uid;
    const snap = await db.collection('users').doc(uid).get();
    currentProfile = snap.data();
    updateUserPill(); updateMyIdBadge();
    if ($('getIdMsg')) $('getIdMsg').textContent = currentProfile?.userID ? `Your ID is ${currentProfile.userID}` : 'Still no ID — check Functions deploy.';
  }catch(e){ if ($('getIdMsg')) $('getIdMsg').textContent = `Couldn’t get ID: ${e.message}`; }
}

/* ---------- PTT / WebRTC (with autoplay fix) ---------- */
function setupPTT(){
  const ptt = $('pttBtn'); if (!ptt) return;
  let down = false;
  const begin = e=>{ e.preventDefault(); if(!down){down=true; beginTalk();} };
  const end   = e=>{ e.preventDefault(); if(down){down=false; endTalk();} };
  on(ptt,'mousedown',begin); on(ptt,'touchstart',begin,{passive:false});
  on(ptt,'mouseup',end); on(ptt,'mouseleave',end); on(ptt,'touchend',end); on(ptt,'touchcancel',end);
  window.addEventListener('keydown',(e)=>{ if(e.code==='Space'&&!down){ const t=(e.target.tagName||'').toLowerCase(); if (t==='input'||t==='textarea') return; e.preventDefault(); down=true; beginTalk(); } },{passive:false});
  window.addEventListener('keyup',(e)=>{ if(e.code==='Space'&&down){ const t=(e.target.tagName||'').toLowerCase(); if (t==='input'||t==='textarea') return; e.preventDefault(); down=false; endTalk(); } },{passive:false});
}
async function setupMedia(){
  $('micPill').textContent='…';
  localStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true }, video:false });
  $('micPill').textContent='OK';
  micTrack = localStream.getAudioTracks()[0];
}

/* Autoplay-safe + TURN-ready signaling */
async function startPttSignaling(roomId){
  // Use global ICE servers if provided (window.ICE_SERVERS), otherwise STUN-only.
  const ICE_SERVERS = (window.ICE_SERVERS && Array.isArray(window.ICE_SERVERS) && window.ICE_SERVERS.length)
    ? window.ICE_SERVERS
    : [{ urls: [ 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302' ] }];

  const rtcConfig = { iceServers: ICE_SERVERS };
  pc = new RTCPeerConnection(rtcConfig);

  micTrack.enabled = false;
  pc.addTrack(micTrack, localStream);

  if ($('status')) $('status').textContent='Status: Signaling…';

  const remoteAudio = $('remoteAudio');
  if (remoteAudio){
    remoteAudio.autoplay = true;
    remoteAudio.playsInline = true;
    remoteAudio.muted = false;
  }

  function ensureAudioPlayback(){
    if (!remoteAudio) return;
    remoteAudio.play().catch(()=>{
      let gate = document.getElementById('unmuteGate');
      if (!gate){
        gate = document.createElement('button');
        gate.id = 'unmuteGate';
        gate.className = 'btn';
        gate.textContent = 'Tap to enable sound';
        gate.style.marginTop = '8px';
        const holder = $('page-room') || document.body;
        holder.appendChild(gate);
        gate.onclick = () => remoteAudio.play().then(()=> gate.remove()).catch(()=>{});
      }
    });
  }

  pc.addEventListener('track', (ev)=>{
    if (remoteAudio){
      remoteAudio.srcObject = ev.streams[0];
      ensureAudioPlayback();
    }
  });

  pc.oniceconnectionstatechange = ()=>{
    const s = pc.iceConnectionState;
    if ($('status')) $('status').textContent = 'ICE: ' + s;
  };
  pc.onconnectionstatechange = ()=>{
    const s = pc.connectionState;
    if ($('status')) $('status').textContent = 'Peer: ' + s;
  };

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
        if ($('status')) $('status').textContent='Status: Connected';
        if ($('pttBtn')) $('pttBtn').disabled=false;
        ensureAudioPlayback();
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
        if ($('status')) $('status').textContent='Status: Connected';
        if ($('pttBtn')) $('pttBtn').disabled=false;
        ensureAudioPlayback();
      }
    });
    callerCands.onSnapshot((qs)=>qs.docChanges().forEach(ch=>{
      if (ch.type==='added'){ pc.addIceCandidate(new RTCIceCandidate(ch.doc.data())); }
    }));
  }

  // If ICE can’t connect in ~10s, hint TURN
  setTimeout(()=>{
    if (pc && ['failed','disconnected'].includes(pc.iceConnectionState)){
      const hint = 'No audio? Your networks may need a TURN server.';
      if ($('errors')) $('errors').textContent = hint;
    }
  }, 10000);
}

function beginTalk(){ if (!pc || !micTrack || talking) return; talking=true; micTrack.enabled=true; $('pttBtn') && $('pttBtn').classList.add('talking'); }
function endTalk(){ if (!pc || !micTrack || !talking) return; talking=false; micTrack.enabled=false; $('pttBtn') && $('pttBtn').classList.remove('talking'); }
function teardownWebRTC(){
  try{ if (pc){ pc.getSenders().forEach(s=>{try{s.track&&s.track.stop();}catch{}}); pc.close(); } }catch{}
  pc=null; localStream=null; micTrack=null; talking=false;
  if ($('pttBtn')) $('pttBtn').disabled=true;
  if ($('status')) $('status').textContent='Status: Idle';
  $('pttBtn') && $('pttBtn').classList.remove('talking');
}
