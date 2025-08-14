// Firebase Cloud Functions: userID allocator (shortest length first), room creation with hidden numeric codes,
// friend requests, invites, presence mirroring, and room auto-cleanup.

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();
const rtdb = admin.database();

// ---------- Helpers
function padLeft(numStr, len){
  // We allow leading zeros for L>=2; for L=1 we avoid '0' unless needed (configurable)
  if (numStr.length >= len) return numStr;
  return '0'.repeat(len - numStr.length) + numStr;
}
async function txGetOrCreate(refPath, initial){
  const ref = db.doc(refPath);
  await db.runTransaction(async (t)=>{
    const snap = await t.get(ref);
    if (!snap.exists) t.set(ref, initial);
  });
  return db.doc(refPath).get();
}

// ---------- UserID allocator
exports.allocateUserIdOnSignup = functions.https.onCall(async (data, context)=>{
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in first.');
  const uid = context.auth.uid;
  const userRef = db.collection('users').doc(uid);
  const u = await userRef.get();
  if (u.exists && u.data().userID){ return { userID: u.data().userID }; }

  const stateRef = db.collection('idAllocator').doc('state');
  await txGetOrCreate('idAllocator/state', { currentLength: 1, issuedCountForLength: 0 });

  let assigned = null;
  await db.runTransaction(async (t)=>{
    const state = await t.get(stateRef);
    let { currentLength, issuedCountForLength } = state.data();
    const maxForLength = currentLength === 1 ? 9 /*1-9*/ : Math.pow(10, currentLength);

    // If exhausted, advance length
    if (issuedCountForLength >= maxForLength){
      currentLength += 1;
      issuedCountForLength = 0;
    }

    // Try random candidates within this length
    const attempts = 20;
    for (let i=0;i<attempts;i++){
      let candidateNum;
      if (currentLength === 1){
        candidateNum = Math.floor(Math.random()*9)+1; // 1..9
      }else{
        candidateNum = Math.floor(Math.random()*Math.pow(10,currentLength));
      }
      const candidate = currentLength===1 ? String(candidateNum) : padLeft(String(candidateNum), currentLength);
      const claimRef = db.collection('idAllocator').doc(`assigned_${candidate}`);
      const claim = await t.get(claimRef);
      if (!claim.exists){
        // Reserve
        t.set(claimRef, { uid, length: currentLength, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        // Map for reverse lookup (userID -> uid)
        t.set(db.collection('userIdLookup').doc(candidate), { uid });
        // Write to user
        t.set(userRef, { userID: candidate }, { merge: true });
        // Update state
        t.set(stateRef, { currentLength, issuedCountForLength: issuedCountForLength + 1 }, { merge: true });
        assigned = candidate;
        break;
      }
    }
    if (!assigned) throw new functions.https.HttpsError('resource-exhausted','Could not allocate ID, retry.');
  });
  return { userID: assigned };
});

// ---------- Friend requests
exports.sendFriendRequest = functions.https.onCall( async (data, context)=>{
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in first.');
  const fromUid = context.auth.uid;
  const digits = (data.userIdDigits||'').replace(/\D/g,'');
  if (!digits) throw new functions.https.HttpsError('invalid-argument','Provide a numeric ID.');

  const lookup = await db.collection('userIdLookup').doc(digits).get();
  if (!lookup.exists) throw new functions.https.HttpsError('not-found','No user with that ID.');
  const toUid = lookup.data().uid;
  if (toUid === fromUid) throw new functions.https.HttpsError('failed-precondition',"You can't add yourself.");

  // Already friends?
  const pairId = [fromUid,toUid].sort().join('_');
  const pairRef = db.collection('friends').doc(pairId);
  const pairSnap = await pairRef.get();
  if (pairSnap.exists) return { message: "WDYM? He is your buddy already !" };

  // Pending request?
  const existing = await db.collection('friendRequests')
    .where('fromUid','==',fromUid).where('toUid','==',toUid).where('status','==','pending').limit(1).get();
  if (!existing.empty) return { message: 'Request already pending.' };

  const from = await db.collection('users').doc(fromUid).get();
  const to = await db.collection('users').doc(toUid).get();
  await db.collection('friendRequests').add({
    fromUid, toUid, fromUserID: from.data()?.userID || null, toUserID: to.data()?.userID || null,
    status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { message: 'Friend request sent.' };
});

// ---------- Room creation with hidden numeric code + invites
exports.createRoom = functions.https.onCall(async (data, context)=>{
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in first.');
  const uid = context.auth.uid;
  const roomName = (data.roomName||'').toString().slice(0,64).trim();
  if (!roomName) throw new functions.https.HttpsError('invalid-argument','Room name required.');

  // allocate roomCode
  const stateRef = db.collection('roomCodeAllocator').doc('state');
  await txGetOrCreate('roomCodeAllocator/state', { currentLength: 6, issuedCountForLength: 0 }); // start with 6 digits for rooms
  let roomCode = null, roomId = null;
  await db.runTransaction(async (t)=>{
    const state = await t.get(stateRef);
    let { currentLength, issuedCountForLength } = state.data();
    const maxForLength = Math.pow(10, currentLength);
    if (issuedCountForLength >= maxForLength){
      currentLength += 1;
      issuedCountForLength = 0;
    }
    const attempts = 20;
    for (let i=0;i<attempts;i++){
      const candidateNum = Math.floor(Math.random()*Math.pow(10,currentLength));
      const candidate = (currentLength===1) ? String(candidateNum) : (''+candidateNum).padStart(currentLength,'0');
      const claimRef = db.collection('roomCodeAllocator').doc(`assigned_${candidate}`);
      const claim = await t.get(claimRef);
      if (!claim.exists){
        // Create room document
        const ref = db.collection('rooms').doc();
        t.set(ref, {
          roomName, roomCode: candidate, createdBy: uid, createdAt: admin.firestore.FieldValue.serverTimestamp(),
          memberUids: [uid], memberCount: 1, active: true
        });
        // index
        t.set(claimRef, { roomId: ref.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        // add creator as member
        const prof = await db.collection('users').doc(uid).get();
        t.set(ref.collection('members').doc(uid), {
          displayName: prof.data()?.displayName || 'User',
          userID: prof.data()?.userID || null,
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
          online: true
        });
        roomCode = candidate;
        roomId = ref.id;
        // update state
        t.set(stateRef, { currentLength, issuedCountForLength: issuedCountForLength + 1 }, { merge: true });
        break;
      }
    }
    if (!roomId) throw new functions.https.HttpsError('resource-exhausted','Could not allocate room code, retry.');
  });
  return { roomId, roomCode };
});

exports.sendRoomInvite = functions.https.onCall(async (data, context)=>{
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in first.');
  const fromUid = context.auth.uid;
  const roomId = (data.roomId||'').toString();
  const toUid = (data.toUid||'').toString();
  if (!roomId || !toUid) throw new functions.https.HttpsError('invalid-argument','roomId and toUid required.');

  const roomRef = db.collection('rooms').doc(roomId);
  const room = await roomRef.get();
  if (!room.exists) throw new functions.https.HttpsError('not-found','Room not found.');
  if (!(room.data().memberUids||[]).includes(fromUid)) throw new functions.https.HttpsError('permission-denied','Only members can invite.');

  const from = await db.collection('users').doc(fromUid).get();
  const invite = await db.collection('roomInvites').add({
    roomId, roomName: room.data().roomName, toUid, fromUid, fromName: from.data()?.displayName || 'User',
    status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { inviteId: invite.id };
});

exports.respondRoomInvite = functions.https.onCall(async (data, context)=>{
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated','Sign in first.');
  const uid = context.auth.uid;
  const inviteId = (data.inviteId||'').toString();
  const action = (data.action||'').toString(); // accepted | rejected
  const invRef = db.collection('roomInvites').doc(inviteId);
  const inv = await invRef.get();
  if (!inv.exists) throw new functions.https.HttpsError('not-found','Invite not found.');
  const d = inv.data();
  if (d.toUid !== uid) throw new functions.https.HttpsError('permission-denied','Not your invite.');
  if (d.status !== 'pending') return { ok:true };

  const roomRef = db.collection('rooms').doc(d.roomId);
  if (action === 'accepted'){
    await db.runTransaction(async (t)=>{
      const room = await t.get(roomRef);
      if (!room.exists) throw new functions.https.HttpsError('not-found','Room not found.');
      const memberUids = room.data().memberUids || [];
      if (!memberUids.includes(uid)){
        memberUids.push(uid);
        t.set(roomRef, { memberUids, memberCount: memberUids.length }, { merge:true });
        const prof = await db.collection('users').doc(uid).get();
        t.set(roomRef.collection('members').doc(uid), {
          displayName: prof.data()?.displayName || 'User',
          userID: prof.data()?.userID || null,
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
          online: true
        });
      }
      t.set(invRef, { status: 'accepted' }, { merge:true });
    });
  }else{
    await invRef.set({ status: 'rejected' }, { merge:true });
  }
  return { ok:true };
});

// ---------- Presence mirroring: RTDB /status/{uid} -> Firestore /users/{uid}.online
exports.mirrorPresence = functions.database.ref('/status/{uid}').onWrite(async (change, context)=>{
  const uid = context.params.uid;
  const online = change.after.exists() && change.after.val() && change.after.val().state === 'online';
  await db.collection('users').doc(uid).set({ online }, { merge:true });
});

// ---------- Room cleanup when last member leaves
exports.roomMembersWatcher = functions.firestore.document('rooms/{roomId}/members/{uid}').onWrite(async (change, context)=>{
  const roomId = context.params.roomId;
  const roomRef = db.collection('rooms').doc(roomId);
  const memRef = roomRef.collection('members');
  const memSnap = await memRef.get();
  const count = memSnap.size;
  await roomRef.set({ memberCount: count, memberUids: memSnap.docs.map(d=>d.id) }, { merge:true });
  if (count === 0){
    // delete subcollections (signals, members, invites, candidates, etc.) and the room doc
    // Use recursive delete if available
    const { getFirestore } = require('firebase-admin/firestore');
    const firestore = getFirestore();
    await firestore.recursiveDelete(roomRef);
  }
});
