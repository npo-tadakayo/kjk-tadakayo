// ローカルの Firebase エミュレーターにつなぐ（総合テスト専用・2026-10-21）
//
// 動くのは次の条件が「すべて」そろったときだけ。本番（*.web.app・独自ドメイン）では何もしない。
//   1. location.hostname が localhost / 127.0.0.1 のどちらか（完全一致）
//   2. location.protocol が http:（本番は https のみ）
//   3. URL に ?emu=1 がある、またはこのブラウザの localStorage に印（kjkEmu=1）がある
//      （?emu=1 で印を付け、?emu=0 で外す。画面遷移のリンクに ?emu=1 が付かなくても続くように）
// 条件がそろったら firebaseConfig の projectId を demo-kjk に差し替える（demo- で始まるプロジェクトは
// エミュレーター専用で、本番につながる経路を持たない）。差し替え後にもう一度 demo- を確かめてから接続する。
//
// 使い方: 各画面のモジュールが共通で読む role.js（と consent-sign.js・auth.js）の先頭で
//   import "/js/emu.js";
// とするだけ。依存モジュールは読み込み側より先に評価されるので、画面の getFirestore 等より前に接続が済む。
// 本番では SDK を余計に読み込まない（条件が真のときだけ動的 import）。
/* global firebaseConfig */

const EMU_HOSTS = ["localhost", "127.0.0.1"];
const EMU_PROJECT = "demo-kjk";

function wantsEmu() {
  if (typeof location === "undefined") return false;
  if (!EMU_HOSTS.includes(location.hostname)) return false;   // 確認1: ホスト名
  if (location.protocol !== "http:") return false;
  let flag = false;
  try {
    const q = new URLSearchParams(location.search).get("emu");
    if (q === "1") localStorage.setItem("kjkEmu", "1");
    if (q === "0") localStorage.removeItem("kjkEmu");
    flag = q === "1" || localStorage.getItem("kjkEmu") === "1";
  } catch (_) { flag = new URLSearchParams(location.search).get("emu") === "1"; }
  return flag;
}

export const EMULATED = wantsEmu();

if (EMULATED) {
  // 確認2: 接続の直前にもう一度ホスト名を確かめ、projectId を demo- に差し替えたことを確かめる
  if (!EMU_HOSTS.includes(location.hostname)) throw new Error("emu: 本番のホストではエミュレーターにつながない");
  firebaseConfig.projectId = EMU_PROJECT;
  firebaseConfig.authDomain = `${EMU_PROJECT}.firebaseapp.com`;
  firebaseConfig.storageBucket = `${EMU_PROJECT}.appspot.com`;
  if (!String(firebaseConfig.projectId).startsWith("demo-")) throw new Error("emu: projectId が demo- ではない");

  const V = "https://www.gstatic.com/firebasejs/10.12.2";
  const [{ initializeApp }, A, F, Fn, S] = await Promise.all([
    import(`${V}/firebase-app.js`), import(`${V}/firebase-auth.js`), import(`${V}/firebase-firestore.js`),
    import(`${V}/firebase-functions.js`), import(`${V}/firebase-storage.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const h = location.hostname;
  A.connectAuthEmulator(A.getAuth(app), `http://${h}:9099`, { disableWarnings: true });
  F.connectFirestoreEmulator(F.getFirestore(app), h, 8080);
  Fn.connectFunctionsEmulator(Fn.getFunctions(app, "asia-northeast1"), h, 5001);
  S.connectStorageEmulator(S.getStorage(app), h, 9199);
  console.warn(`[emu] Firebase エミュレーターに接続しました（project=${EMU_PROJECT}）`);
}
