import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ hd: "tadakayo.jp" });

export { app, auth };

export async function login() {
  const result = await signInWithPopup(auth, provider);
  const email = result.user.email || "";
  if (!email.endsWith("@tadakayo.jp")) {
    await signOut(auth);
    throw new Error("@tadakayo.jp のアカウントのみ利用できます");
  }
  return result.user;
}

export async function logout() {
  await signOut(auth);
  location.href = "/index.html";
}

// 認証ガード: 未ログインならログイン画面へリダイレクト
export function requireAuth(callback) {
  onAuthStateChanged(auth, (user) => {
    if (!user || !user.email?.endsWith("@tadakayo.jp")) {
      location.href = "/index.html";
      return;
    }
    callback(user);
  });
}
