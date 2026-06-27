// Update these values if using a separate Firebase project
firebase.initializeApp({
  apiKey:            "AIzaSyCPHQOA9sv8XHCfxs13ZGWpB6bCKdbODzs",
  authDomain:        "bdg-predictor-e3287.firebaseapp.com",
  projectId:         "bdg-predictor-e3287",
  storageBucket:     "bdg-predictor-e3287.firebasestorage.app",
  messagingSenderId: "629519960544",
  appId:             "1:629519960544:web:822d2c36bf7c7251cc4385"
});

const auth = firebase.auth();
const db   = firebase.firestore();
