// ===== 練習モード（学習用テストモード・2026-10-20） =====
// 設計: docs/テストモード設計_20261020.md
//
// 練習モードのあいだ、画面は Firestore の練習用データベース "practice" だけを読み書きする
// （切り替えそのものは fs.js の getFirestore が行う。各画面の getFirestore(app) は書き換えない）。
//   ・練習生（role: trainee）は常に練習モード。本番はルールで読み書きとも拒否される
//   ・ほかの職員は、サイドバーの「練習モードに入る」で切り替える
//   ・練習中は画面上部に黄色の帯を出し続ける（本番と取り違えないため）
//   ・ログアウトするとき、自分が練習中に作ったデータ（_practiceBy が自分）を消す
//
// モードはブラウザに覚える（全タブ共通）。別のタブで切り替わったら、このタブも読み込み直す
// （本番と練習が1つのタブの中で混ざらないように）。
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, where, limit, getDocs, doc, addDoc, runTransaction,
  writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const PRACTICE_DB = "practice";
const KEY = "crm.mode";

// ログアウトで片付ける対象（練習DBのトップレベルのコレクション）。
// _counters・appConfig は全員で共有する設定なので消さない（fs.js でも作成者を付けない）
export const PRACTICE_CLEANUP_COLLECTIONS = [
  "cases", "activities", "offices", "quotes", "shipments", "sessions", "receipts",
  "inventoryMovements", "purchaseOrders", "partnerOrders", "stockTransfers", "locations",
  "products", "partners", "consentRequests", "documentChecklists", "supportChecklists",
  "supportBadges", "supportEvaluations", "subsidyApplications", "notDuplicates", "practiceSent",
];

// 全タブ共通の localStorage を正とする。使えない環境（プライベートウィンドウ等）だけ sessionStorage を見る
// （両方を見ると、別タブで「本番に戻る」を押してもこのタブの sessionStorage が残って練習のままになる・Codex 指摘）
function sharedStore() {
  try { const s = localStorage; s.getItem(KEY); return s; } catch (_) { return null; }
}
export function isPracticeMode() {
  const ls = sharedStore();
  if (ls) return ls.getItem(KEY) === "practice";
  try { return sessionStorage.getItem(KEY) === "practice"; } catch (_) { return false; }
}

/** 練習モードを覚える／やめる。保存できなかったら false（練習生はそのとき入れない）。 */
export function setPracticeMode(on) {
  let ok = false;
  try {
    const s = sharedStore() || sessionStorage;
    if (on) s.setItem(KEY, "practice"); else s.removeItem(KEY);
    ok = true;
  } catch (_) {}
  try { if (!on) sessionStorage.removeItem(KEY); } catch (_) {}
  return ok && (!on || isPracticeMode());
}

// 別のタブで切り替わったら読み込み直す
const modeAtLoad = isPracticeMode();
try {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && isPracticeMode() !== modeAtLoad) location.reload();
  });
} catch (_) {}

const FONT = "'Hiragino Sans','Noto Sans JP',system-ui,sans-serif";

function onBody(fn) {
  if (document.body) fn(); else document.addEventListener("DOMContentLoaded", fn);
}

/** 練習中の帯（全画面の最上部） */
function mountBanner(isTrainee) {
  if (document.getElementById("practiceBanner")) return;
  const bar = document.createElement("div");
  bar.id = "practiceBanner";
  bar.setAttribute("role", "status");
  bar.style.cssText = "position:sticky;top:0;z-index:10000;background:#FFF4C2;border-bottom:3px solid #C99A00;"
    + "color:#2C2416;font-size:14px;font-weight:700;padding:10px 16px;display:flex;gap:12px;align-items:center;"
    + `justify-content:center;flex-wrap:wrap;font-family:${FONT}`;
  const text = document.createElement("span");
  text.textContent = isTrainee
    ? "練習モード（練習生のアカウント）：ここは練習用のデータです。メール・Chat などは送られません。"
    : "練習モード：本番のデータではありません。メール・Chat などは送られません。";
  bar.appendChild(text);
  if (!isTrainee) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn btn-secondary";
    back.textContent = "本番に戻る";
    back.style.cssText = "min-height:36px;font-size:13px";
    back.addEventListener("click", () => switchMode(false));
    bar.appendChild(back);
  }
  document.body.insertBefore(bar, document.body.firstChild);
}

/** サイドバーの「練習モードに入る」（本番のとき・練習生以外） */
function mountEnterButton() {
  const logout = document.getElementById("logoutBtn");
  if (!logout || document.getElementById("practiceEnterBtn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "practiceEnterBtn";
  btn.className = "btn-logout";
  btn.title = "練習モードに入る（本番のデータには触れません）";
  btn.innerHTML = '<i class="ti ti-school" aria-hidden="true"></i><span>練習モードに入る</span>';
  btn.addEventListener("click", () => switchMode(true));
  logout.parentNode.insertBefore(btn, logout);
}

function switchMode(on) {
  const msg = on
    ? "練習モードに入ります。\n練習用のデータに切り替わり、メール・Chat などは送られません。\n（ログアウトすると、練習中に自分が作ったデータは消えます）"
    : "本番に戻ります。ここからの操作は本番のデータに保存されます。";
  if (!confirm(msg)) return;
  if (!setPracticeMode(on)) {
    alert("このブラウザでは設定を保存できないため、切り替えられませんでした（プライベートウィンドウなど）。");
    return;
  }
  location.reload();
}

function practiceDb() {
  return getFirestore(getApp(), PRACTICE_DB);
}

/** 練習中に自分が作ったデータを消す（ログアウト時）。消した件数を返す。 */
export async function cleanupMyPracticeData(email) {
  if (!email) return 0;
  const db = practiceDb();
  // コレクションごとに並べて読む（ログアウトを待たせない）。読めないもの（練習DBが未作成など）は飛ばす
  const counts = await Promise.all(PRACTICE_CLEANUP_COLLECTIONS.map(async (name) => {
    let snap;
    try {
      snap = await getDocs(query(collection(db, name), where("_practiceBy", "==", email)));
    } catch (e) { console.warn("[practice] cleanup read", name, e.message); return 0; }
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
      await b.commit();
    }
    return snap.size;
  }));
  return counts.reduce((a, b) => a + b, 0);
}

/** ログアウトボタンを横取りして、片付けてからログアウトする（練習中だけ） */
function interceptLogout(email) {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest("#logoutBtn");
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    btn.disabled = true;
    const label = btn.querySelector("span") || btn;
    label.textContent = "ログアウトしています…";
    try {
      await cleanupMyPracticeData(email);
    } catch (err) {
      // 消せなくても毎晩3時に全体を初期化するので、ログアウトは止めない
      console.warn("[practice] cleanup failed", err);
    }
    // 次にこのブラウザでログインする人は本番から始める（練習生はログイン後に練習へ戻される）
    setPracticeMode(false);
    await signOut(getAuth(getApp())).catch(() => {});
    location.href = "/index.html";
  }, true);
}

/**
 * 練習生の「あなたの担当」2件（練習モードに入っている全員に用意する）。
 * 自分の担当の案件が2件未満なら、自分の作成として足す（ログアウトで消え、次に入るとまた作られる）。
 */
export async function ensureMyPracticeCases(user) {
  const email = user?.email;
  if (!email) return 0;
  // 毎回あるかを確かめる（夜間・管理者の初期化で消えたあとも、次に開いた画面で作り直すため・Codex 指摘）。
  // 同じ画面の中で二重に作らないよう、確認中はこのページの中だけで印を持つ
  if (ensuring) return 0;
  ensuring = true;
  try {
  const db = practiceDb();
  const mine = await getDocs(query(collection(db, "cases"), where("assignedUserId", "==", email), limit(2)));
  const need = 2 - mine.size;
  const name = user.displayName || email;
  // 1件は準備の始め（担当者決定）、1件は伴走支援待ち
  const plans = [
    { status: 3, label: "A", pref: "東京都", city: "練馬区", memo: "練習用：あなたが担当する案件です。事前確認から進めてみましょう。" },
    { status: 7, label: "B", pref: "大阪府", city: "堺市堺区", memo: "練習用：伴走支援の日程を決めて、記録を残してみましょう。" },
  ].slice(0, Math.max(0, need));
  for (const p of plans) {
    const now = serverTimestamp();
    const counter = doc(db, "_counters", "cases");
    const caseNumber = await runTransaction(db, async (tx) => {
      const s = await tx.get(counter);
      const next = (s.exists() ? s.data().value : 0) + 1;
      tx.set(counter, { value: next });
      return next;
    });
    const officeName = `【練習】あなたの担当 ${p.label} 居宅介護支援事業所`;
    const office = await addDoc(collection(db, "offices"), {
      corpName: "【練習】株式会社れんしゅう", officeName,
      address: `${p.pref}${p.city}練習町1-2-3`, phone: "000-0000-0000",
      createdAt: now, updatedAt: now, _practiceBy: email,
    });
    const c = await addDoc(collection(db, "cases"), {
      caseNumber, officeId: office.id, officeName, corpName: "【練習】株式会社れんしゅう",
      contactName: "練習 一郎", contactEmail: "renshu@example.jp", contactPhone: "000-0000-0000",
      source: "manual", status: p.status, assignedUserId: email, assignedUserName: name,
      referralSource: null, receivedAt: now, updatedAt: now, cardReaders: [],
      subsidyCategory: null, expectedSubsidyAmount: null, lostReason: null,
      orderedAt: null, completedAt: null, _practiceBy: email,
    });
    await addDoc(collection(db, "activities"), {
      caseId: c.id, type: "memo", occurredAt: now, userId: user.uid || "", userName: name,
      subject: "練習用の案件", body: p.memo, attachmentUrls: [], _practiceBy: email,
    });
  }
  return plans.length;
  } finally { ensuring = false; }
}
let ensuring = false;

/**
 * ロールが分かったあとに role.js の gateRole から呼ぶ。
 * 戻り値 false＝このページはここで止める（練習生を練習モードへ読み込み直す等）。
 */
export function setupModeUi(role, user) {
  const isTrainee = role?.role === "trainee";
  if (isTrainee && !isPracticeMode()) {
    if (setPracticeMode(true)) { location.reload(); return false; }
    return "no-storage";
  }
  onBody(() => {
    if (isPracticeMode()) {
      mountBanner(isTrainee);
    } else if (!isTrainee) {
      mountEnterButton();
    }
  });
  // 片付けは表示中のモードに関係なく行う（練習で作ってから「本番に戻る」→ログアウトでも残さない・Codex 指摘）
  interceptLogout(user?.email);
  if (isPracticeMode()) {
    ensureMyPracticeCases(user).catch((e) => console.warn("[practice] ensure cases", e.message));
  }
  return true;
}
