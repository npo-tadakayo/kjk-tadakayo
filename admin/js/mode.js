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
import { getFirestore, collection, query, where, getDocs, doc, runTransaction,
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
  "bankTxns", // 入金明細の取り込み記録（2026-10-21 CRM改善）。bankConfig は列割り当ての共有設定なので消さない
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
  // 帯の高さを CSS に渡す。サイドバーは帯の下から画面の下までに収める（crm.css の --mode-bar-h）。
  // 渡さないと、帯の分だけサイドバーの下（ログアウト）が画面の外に出る（2026-10-25）
  const setH = () => document.documentElement.style.setProperty("--mode-bar-h", `${bar.offsetHeight}px`);
  setH();
  if (typeof ResizeObserver === "function") new ResizeObserver(setH).observe(bar);
  else window.addEventListener("resize", setH);
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
 * 人ごとに決まった ID（practice-mine-{UID}-A／-B）で、無ければ作る（ログアウトで消え、次に入るとまた作られる）。
 *
 * 2026-10-21 本番確認で、CRM のタブを複数開いていると 4件できた（練習モードは全タブ共通なので、
 * 切り替えたときに各タブが同時に読み込み直し、それぞれが「まだ無い」と判断して作っていた）。
 * そこで「ID を決めておき、有無の確認と作成を1つのトランザクションで行う」方式にした。
 * タブがいくつあっても、同じ ID の案件は1件しかできない（後から来た方は「もうある」で何もしない）。
 */
export async function ensureMyPracticeCases(user) {
  const email = user?.email;
  if (!email) return 0;
  const db = practiceDb();
  const name = user.displayName || email;
  // ID は Firebase Auth の UID（人ごとに一意）。メールを記号置き換えすると first.last@ と first-last@ が
  // 同じになって他人の案件を「作成済み」と見てしまう（Codex 指摘）。UID が取れないときはメールを壊さずに符号化する
  const key = user.uid || encodeURIComponent(email.toLowerCase()).replace(/%/g, "_").replace(/\./g, "_2E");
  // 1件は準備の始め（担当者決定）、1件は伴走支援待ち
  const plans = [
    { status: 3, label: "A", pref: "東京都", city: "練馬区", memo: "練習用：あなたが担当する案件です。事前確認から進めてみましょう。" },
    { status: 7, label: "B", pref: "大阪府", city: "堺市堺区", memo: "練習用：伴走支援の日程を決めて、記録を残してみましょう。" },
  ];
  let made = 0;
  for (const p of plans) {
    const caseRef = doc(db, "cases", `practice-mine-${key}-${p.label}`);
    const officeRef = doc(db, "offices", `practice-mine-${key}-${p.label}`);
    const actRef = doc(collection(db, "activities"));
    const counter = doc(db, "_counters", "cases");
    const created = await runTransaction(db, async (tx) => {
      const c = await tx.get(caseRef);
      if (c.exists()) return false;
      const s = await tx.get(counter);
      const caseNumber = (s.exists() ? s.data().value : 0) + 1;
      const now = serverTimestamp();
      const officeName = `【練習】あなたの担当 ${p.label} 居宅介護支援事業所`;
      tx.set(counter, { value: caseNumber });
      tx.set(officeRef, {
        corpName: "【練習】株式会社れんしゅう", officeName,
        address: `${p.pref}${p.city}練習町1-2-3`, phone: "000-0000-0000",
        createdAt: now, updatedAt: now, _practiceBy: email,
      });
      tx.set(caseRef, {
        caseNumber, officeId: officeRef.id, officeName, corpName: "【練習】株式会社れんしゅう",
        contactName: "練習 一郎", contactEmail: "renshu@example.jp", contactPhone: "000-0000-0000",
        source: "manual", status: p.status, assignedUserId: email, assignedUserName: name,
        referralSource: null, receivedAt: now, updatedAt: now, cardReaders: [],
        subsidyCategory: null, expectedSubsidyAmount: null, lostReason: null,
        orderedAt: null, completedAt: null, _practiceBy: email,
      });
      tx.set(actRef, {
        caseId: caseRef.id, type: "memo", occurredAt: now, userId: user.uid || "", userName: name,
        subject: "練習用の案件", body: p.memo, attachmentUrls: [], _practiceBy: email,
      });
      return true;
    });
    if (created) made++;
  }
  return made;
}

/**
 * ロールが分かったあとに role.js の gateRole から呼ぶ。
 * 戻り値 false＝このページはここで止める（練習生を練習モードへ読み込み直す等）。
 */
export function setupModeUi(role, user) {
  const isTrainee = role?.role === "trainee";
  const isWarehouse = role?.role === "warehouse"; // 倉庫の人は練習モードを使わない（切り替えを出さない・2026-10-24）
  if (isTrainee && !isPracticeMode()) {
    if (setPracticeMode(true)) { location.reload(); return false; }
    return "no-storage";
  }
  // 倉庫の人は本番だけ。前の人の練習モードの印（crm.mode=practice）がブラウザに残っていたら外して読み込み直す
  // （練習DBの保管場所が見え、練習DBに書いてしまうため・2026-10-24 ブラウザ検証 B2）。外せなければ止める（読み込み直しを繰り返さない）
  if (isWarehouse && isPracticeMode()) {
    if (setPracticeMode(false) && !isPracticeMode()) { location.reload(); return false; }
    return "no-storage";
  }
  onBody(() => {
    if (isPracticeMode()) {
      mountBanner(isTrainee);
    } else if (!isTrainee && !isWarehouse) {
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
