import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
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
  // ロール登録チェック（未登録/停止はログイン不可）
  try {
    const s = await getDoc(doc(db, "users", email));
    if (!s.exists() || s.data().active === false) {
      await signOut(auth);
      throw new Error("このアカウントは登録されていません。管理者にユーザー登録を依頼してください。");
    }
  } catch (e) {
    if (e.message && e.message.includes("登録されていません")) throw e;
    await signOut(auth);
    throw new Error("アクセス権限を確認できませんでした。管理者にお問い合わせください。");
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
