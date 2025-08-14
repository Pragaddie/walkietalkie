// firebase-config.js
// Firebase console → Project Settings → SDK setup & config
const firebaseConfig = {
  apiKey: "AIzaSyDKTzantR1WCJhncafYl7aRYcLlC3WukEY",
  authDomain: "walkie-talkie-ee0e1.firebaseapp.com",
  projectId: "walkie-talkie-ee0e1",

  // Use the standard bucket form:
  storageBucket: "walkie-talkie-ee0e1.appspot.com",

  messagingSenderId: "126790852508",
  appId: "1:126790852508:web:a98f7cde9633bd6c4fb259",
  measurementId: "G-E71R78RDTW",

  // IMPORTANT: the missing comma above is what broke initialization
  databaseURL: "https://walkie-talkie-ee0e1-default-rtdb.firebaseio.com"
};
