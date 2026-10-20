// ===== Firestore の入口（練習モードの切り替え・2026-10-20） =====
// 各画面は Firestore を CDN から直接ではなく、このファイルから import する。
// ここで getFirestore を差し替えるので、各画面の `getFirestore(app)` は書き換えずに
// 練習モードのときだけ練習用データベース（practice）につながる。
//
// 練習DBに「新しく作る」書き込み（addDoc／setDoc（merge なし）／batch.set／transaction.set）には
// 作成者 _practiceBy を付ける。ログアウト時に「自分が作った分」だけを消すため（mode.js）。
// 本番DBへの書き込みには何も足さない。
//
// ⚠ ロールの確認（users）は常に本番DBを読む必要があるので、role.js と auth.js は CDN を直接使う。
//    users を本番で読み書きしたい画面は getProdFirestore(app) を使う。
import * as F from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { isPracticeMode, PRACTICE_DB } from "/js/mode.js";

export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
export { isPracticeMode };

/** 練習モードなら練習DB、そうでなければ本番DB。 */
export function getFirestore(app) {
  return isPracticeMode() ? F.getFirestore(app, PRACTICE_DB) : F.getFirestore(app);
}

/** 常に本番DB（users の読み書き専用。練習中でもロールは本番の users で決まる）。 */
export function getProdFirestore(app) {
  return F.getFirestore(app);
}

// 作成者を付けない共有コレクション（採番・設定。消すと全員の練習が壊れる）
const SHARED = new Set(["_counters", "appConfig"]);

export function isPracticeRef(ref) {
  try { return ref?.firestore?._databaseId?.database === PRACTICE_DB; } catch (_) { return false; }
}

function myEmail() {
  try { return getAuth(getApp()).currentUser?.email || ""; } catch (_) { return ""; }
}

/** 練習DBへの新規作成なら _practiceBy を足したデータを返す（それ以外はそのまま）。 */
const isMerge = (opts) => !!(opts && (opts.merge || opts.mergeFields));
// 作成者を付ける対象か（練習DB・共有コレクション以外・ログイン中）。付けるならそのメールを返す
function taggable(ref) {
  if (!isPracticeRef(ref)) return "";
  const top = String(ref.path || "").split("/")[0];
  if (SHARED.has(top)) return "";
  return myEmail();
}

/** 新規作成が確実な書き込み（addDoc・transaction 内の set）用：作成者を足したデータを返す */
export function tagPractice(ref, data, opts) {
  if (!data || typeof data !== "object" || isMerge(opts)) return data;
  const email = taggable(ref);
  return email ? { ...data, _practiceBy: email } : data;
}

// setDoc・batch.set は「新規作成」とは限らない（上書き・merge もある）。
// 書く前に文書の有無と元の作成者を読み、書いたあとの作成者を決める（Codex 指摘 2026-10-20）:
//   無い → 自分 ／ あって作成者あり → 元の作成者を保つ ／ あって作成者なし（初期データ）→ 付けない
async function ownerAfterWrite(ref) {
  const email = taggable(ref);
  if (!email) return null;
  try {
    const snap = await F.getDoc(ref);
    if (!snap.exists()) return email;
    return snap.get("_practiceBy") || null;
  } catch (_) { return null; }
}

export function addDoc(ref, data) {
  return F.addDoc(ref, tagPractice(ref, data));
}

export async function setDoc(ref, data, opts) {
  const owner = data && typeof data === "object" ? await ownerAfterWrite(ref) : null;
  const d = owner ? { ...data, _practiceBy: owner } : data;
  return opts === undefined ? F.setDoc(ref, d) : F.setDoc(ref, d, opts);
}

export function writeBatch(db) {
  const b = F.writeBatch(db);
  const set = b.set.bind(b);
  const refs = [];
  b.set = (ref, data, opts) => {
    if (taggable(ref)) refs.push(ref);
    if (opts === undefined) set(ref, data); else set(ref, data, opts);
    return b;
  };
  const commit = b.commit.bind(b);
  b.commit = async () => {
    // set の後ろに作成者だけの merge を足す（set の中身は変えない・同じ文書への後勝ち）
    for (const ref of refs) {
      const owner = await ownerAfterWrite(ref);
      if (owner) set(ref, { _practiceBy: owner }, { merge: true });
    }
    return commit();
  };
  return b;
}

export function runTransaction(db, fn, opts) {
  // transaction 内では書いたあとに読めないので、set は新規作成として扱う（採番などの共有コレクションは taggable で除外）
  return F.runTransaction(db, (tx) => {
    const set = tx.set.bind(tx);
    tx.set = (ref, data, o) => { if (o === undefined) set(ref, tagPractice(ref, data)); else set(ref, tagPractice(ref, data, o), o); return tx; };
    return fn(tx);
  }, opts);
}
