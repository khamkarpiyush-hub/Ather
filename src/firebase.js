import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBBBV5aLg88i6StNKPdbIG3gEgVdfotN0M",
  authDomain: "swarmvault-8bf1e.firebaseapp.com",
  projectId: "swarmvault-8bf1e",
  storageBucket: "swarmvault-8bf1e.firebasestorage.app",
  messagingSenderId: "865109641297",
  appId: "1:865109641297:web:31d03f20f7c186cd199070",
  measurementId: "G-RTKR33FFYB"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);