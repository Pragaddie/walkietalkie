const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* -------- ID allocator (digits, no collisions) -------- */
exports.allocateUserIdOnSignup = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated','Login required');

  const userRef = db.collection('users').doc(uid);
  const user = await userRef.get();
  if (user.exists && user.data().userID) return { userID: user.data().userID };

  const metaRef = db.collection('idAllocator').doc('meta'); // {digits: number}
  await db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(metaRef);
    let digits = metaSnap.exists ? (metaSnap.data().digits || 1) : 1;

    let assigned = null;
    for (let tries = 0; tries < 400 && !assigned; tries++) {
      const min = digits === 1 ? 1 : Math.pow(10, digits-1);
      const max = Math.pow(10, digits) - 1;
      const candidate = Math.floor(Math.random() * (max - min + 1)) + min;
      const taken = await tx.get(db.collection('userIdLookup').doc(String(candidate)));
      if (!taken.exists) {
        tx.set(db.collection('userIdLookup').doc(String(candidate)), { uid, at: admin.firestore.FieldValue.serverTimestamp() });
        tx.set(userRef, { userID: candidate }, { merge: true });
        assigned = candidate;
      }
      if (tries > 300) digits = Math.min(50, digits + 1); // widen if crowded
    }

    if (!assigned) {
      digits = Math.min(50, digits + 1);
      tx.set(metaRef, { digits }, { merge: true });
      throw new functions.https.HttpsError('resource-exhausted','Could not allocate ID, try again');
    }
    tx.set(metaRef, { digits }, { merge: true });
  });

  const after = (await userRef.get()).data().userID;
  return { userID: after };
});

/* -------- Friend request -------- */
exports.sendFriendRequest = functions.https.onCall(async (data, context) => {
  const fromUid = context.auth?.uid;
  if (!fromUid) throw new functions.https.HttpsError('unauthenticated','Login required');

  const raw = String(data?.userIdDigits||'').trim();
  if (!/^\d+$/.test(raw)) throw new functions.https.HttpsError('invalid-argument','Digits only');

  // find target by userID
  const qs = await db.collection('users').where('userID','==', Number(raw)).limit(1).get();
  if (qs.empty) throw new functions.https.HttpsError('not-found','No user with that ID');
  const toUid = qs.docs[0].id;
  if (toUid === fromUid) throw new functions.https.HttpsError('failed-precondition','Cannot add yourself');

  // already friends?
  const pairId = [fromUid, toUid].sort().join('_');
  const already = await db.collection('friends').doc(pairId).get();
  if (already.exists) return { message:'WDYM?, He is your buddy already !' };

  // pending?
  const pending = await db.collection('friendRequests')
    .where('fromUid','==',fromUid).where('toUid','==',toUid).where('status','==','pending').limit(1).get();
  if (!pending.empty) return { message:'Request already sent' };

  const from = (await db.collection('users').doc(fromUid).get()).data()||{};
  const to = (await db.collection('users').doc(toUid).get()).data()||{};

  await db.collection('friendRequests').add({
    fromUid, toUid,
    fromUserID: from.userID || null,
    toUserID: to.userID || null,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp()
  });

  return { message:'Request sent' };
});

/* -------- Rooms -------- */
exports.createRoom = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated','Login required');

  const roomName = String(data?.roomName || 'Room').slice(0, 80);
  const ref = await db.collection('rooms').add({
    roomName,
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
    memberUids: [uid],
    memberCount: 1
  });
  return { roomId: ref.id };
});

exports.sendRoomInvite = functions.https.onCall(async (data, context) => {
  const fromUid = context.auth?.uid;
  if (!fromUid) throw new functions.https.HttpsError('unauthenticated','Login required');

  const roomId = String(data?.roomId||'');
  const toUid = String(data?.toUid||'');
  if (!roomId || !toUid) throw new functions.https.HttpsError('invalid-argument','roomId/toUid required');

  const room = await db.collection('rooms').doc(roomId).get();
  if (!room.exists) throw new functions.https.HttpsError('not-found','Room missing');
  const members = room.data().memberUids || [];
  if (!members.includes(fromUid)) throw new functions.https.HttpsError('permission-denied','Only members can invite');

  const from = (await db.collection('users').doc(fromUid).get()).data()||{};
  await db.collection('roomInvites').add({
    roomId,
    roomName: room.data().roomName || 'Room',
    fromUid,
    fromName: from.displayName || 'Friend',
    toUid,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp()
  });
  return { ok:true };
});

exports.respondRoomInvite = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) throw new functions.https.HttpsError('unauthenticated','Login required');

  const inviteId = String(data?.inviteId||'');
  const action = String(data?.action||'').toLowerCase(); // 'accepted' | 'rejected'
  if (!inviteId || !['accepted','rejected'].includes(action))
    throw new functions.https.HttpsError('invalid-argument','Bad action');

  const ref = db.collection('roomInvites').doc(inviteId);
  await db.runTransaction(async (tx)=>{
    const snap = await tx.get(ref);
    if (!snap.exists) throw new functions.https.HttpsError('not-found','Invite missing');
    const inv = snap.data();
    if (inv.toUid !== uid) throw new functions.https.HttpsError('permission-denied','Not your invite');

    // update invite status
    tx.set(ref, { status: action }, { merge: true });

    if (action === 'accepted'){
      const roomRef = db.collection('rooms').doc(inv.roomId);
      const room = await tx.get(roomRef);
      if (!room.exists) throw new functions.https.HttpsError('not-found','Room missing');

      const members = room.data().memberUids || [];
      if (!members.includes(uid)){
        tx.update(roomRef, {
          memberUids: admin.firestore.FieldValue.arrayUnion(uid),
          memberCount: (room.data().memberCount || members.length || 0) + 1
        });
      }
      // create/merge a member profile doc (optional but handy)
      tx.set(roomRef.collection('members').doc(uid), {
        displayName: (await db.collection('users').doc(uid).get()).data()?.displayName || 'User',
        userID: (await db.collection('users').doc(uid).get()).data()?.userID || null,
        online: true,
        joinedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });

  return { ok:true };
});

/* -------- (optional) presence mirror to Firestore for green dots -------- */
exports.mirrorPresence = functions.database.ref('/status/{uid}')
  .onWrite(async (change, context) => {
    const uid = context.params.uid;
    const val = change.after.val();
    const online = !!val && val.state === 'online';
    await db.collection('users').doc(uid).set(
      { online, lastOnlineChange: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return;
  });
