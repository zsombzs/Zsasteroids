import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, push, query, orderByChild, limitToLast, get, set, onValue, update, remove, serverTimestamp, off, onDisconnect } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyDUvXiYQ2wpN5w3HebNM8CQwRKgkfmGDuc",
  authDomain: "zsasteroids-36cb2.firebaseapp.com",
  databaseURL: "https://zsasteroids-36cb2-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "zsasteroids-36cb2",
  storageBucket: "zsasteroids-36cb2.firebasestorage.app",
  messagingSenderId: "741339302004",
  appId: "1:741339302004:web:46f21e53009f573e03e921",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export { ref, push, query, orderByChild, limitToLast, get, set, onValue, update, remove, serverTimestamp, off, onDisconnect, signInWithPopup, signOut, onAuthStateChanged };
