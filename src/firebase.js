import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Paste the config object Firebase gives you when you register a
// "Web app" in your Firebase project (Project settings -> your app).
// These values are safe to be public in client code — they just tell
// your app which Firebase project to talk to. Actual access control
// happens in Firestore's security rules, not here.
const firebaseConfig = {
  apiKey: "AIzaSyAxkzVdcJj7aKjdrfviEdf4zcRD9eFlyKw",
  authDomain: "manifest-80db4.firebaseapp.com",
  projectId: "manifest-80db4",
  storageBucket: "manifest-80db4.firebasestorage.app",
  messagingSenderId: "376238585943",
  appId: "1:376238585943:web:6f7e2ec08c078f0d790b12",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
