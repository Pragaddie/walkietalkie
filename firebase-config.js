// firebase-config.js
// Firebase console → Project Settings → SDK setup & config
const firebaseConfig = {
  apiKey: "AIzaSyDKTzantR1WCJhncafYl7aRYcLlC3WukEY",
  authDomain: "walkie-talkie-ee0e1.firebaseapp.com",
  projectId: "walkie-talkie-ee0e1",
  storageBucket: "walkie-talkie-ee0e1.appspot.com",
  messagingSenderId: "126790852508",
  appId: "1:126790852508:web:a98f7cde9633bd6c4fb259",
  measurementId: "G-E71R78RDTW",
  databaseURL: "https://walkie-talkie-ee0e1-default-rtdb.firebaseio.com"
};

// Optional: STUN/TURN list for WebRTC. If you don't have TURN yet, leave the STUN-only list.
// When you get TURN credentials, replace the placeholders below and KEEP the STUN lines.
window.ICE_SERVERS = [
  // STUN (free, keep these)
  { urls: [ 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302' ] },

  // TURN examples (uncomment and put your real credentials)
  // { urls: 'turn:YOUR_TURN_HOST:3478', username: 'YOUR_USERNAME', credential: 'YOUR_PASSWORD' },
  // { urls: 'turns:YOUR_TURN_HOST:5349?transport=tcp', username: 'YOUR_USERNAME', credential: 'YOUR_PASSWORD' }
];
