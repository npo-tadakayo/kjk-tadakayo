import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, orderBy, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const caseId = new URLSearchParams(location.search).get("id");

const STATUS_LABELS = {
  1: "新規受信", 2: "確認中", 3: "受注確定", 4: "失注", 5: "担当者決定",
  6: "事前準備中", 7: "伴走支援待ち", 8: "伴走支援実施済", 9: "書類準備完了・申請ガイド中",
  10: "申請完了・採択待ち", 11: "採択・入金待ち", 12: "アフターフォロー中", 13: "案件完了",
};
const SOURCE_LABELS = { lp_inquiry: "LP問い合わせ", mitsumori_quote: "見積もり成約", manual: "手動登録" };
const SUBSIDY_CAT = { houmon: "訪問・通所・短期滞在系（上限¥64,000）", kyojyu: "居住・入所系（上限¥55,000）", other: "その他（上限¥42,000）" };
const ACTIVITY_LABELS = {
  phone_in: "電話（着信）", phone_out: "電話（発信）", email_in: "メール（受信）",
  email_out: "メール（送信）", visit: "訪問・対面", memo: "メモ", gmail_sent: "メール送信",
};

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmt(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
}
function yen(n) { return n ? "¥" + Number(n).toLocaleString("ja-JP") : "—"; }

function kvRows(rows) {
  return `<table class="kv">${rows.filter(Boolean).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function renderReport(c, subsidy, sessions, activities) {
  const crs = (c.cardReaders || []).map((r) =>
    `${r.type === "BT" ? "Bluetooth(CIR415A)" : r.type === "USB" ? "USB(CIR315A)" : r.type} 補助対象${r.subsidyQty || 0}台${r.extraQty ? ` ＋対象外${r.extraQty}台` : ""}`).join("<br>") || "—";

  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });

  const sessionsHtml = sessions.length
    ? sessions.map((s) => `
        <div class="session-item">
          <div class="ti-date">${esc(s.sessionDate || fmtDate(s.createdAt))}　<span class="muted">担当: ${esc(s.userName || "")}</span></div>
          <div class="ti-body">${esc(s.summary || "（記録なし）")}${(s.photoUrls && s.photoUrls.length) ? `<br><span class="muted">写真 ${s.photoUrls.length}枚</span>` : ""}</div>
        </div>`).join("")
    : `<div class="muted">伴走支援の記録はありません。</div>`;

  const actHtml = activities.length
    ? activities.map((a) => `
        <div class="timeline-item">
          <div class="ti-date">${fmt(a.occurredAt)}　<span class="muted">[${ACTIVITY_LABELS[a.type] || a.type}] ${esc(a.userName || "")}</span></div>
          <div class="ti-body">${esc(a.subject || "")}${a.body ? `\n${esc(a.body)}` : ""}</div>
        </div>`).join("")
    : `<div class="muted">対応記録はありません。</div>`;

  document.getElementById("reportBody").innerHTML = `
    <div class="doc-head">
      <div class="doc-brand">
        <div class="svc">タダカヨの介護情報基盤伴走支援</div>
        <div class="org">NPO法人タダカヨ</div>
      </div>
      <div class="doc-title">
        <h1>支援報告書</h1>
        <div class="meta">案件番号 #${esc(c.caseNumber || "—")}<br>発行日: ${today}</div>
      </div>
    </div>

    <h2 class="sec">事業所情報</h2>
    ${kvRows([
      ["法人名", esc(c.corpName || "—")],
      ["事業所名", esc(c.officeName || "—")],
      ["ご担当者", esc(c.contactName || "—")],
      ["電話", esc(c.contactPhone || "—")],
      ["メール", esc(c.contactEmail || "—")],
    ])}

    <h2 class="sec">案件概要</h2>
    ${kvRows([
      ["現在のステータス", esc(STATUS_LABELS[c.status] || "—")],
      ["流入元", esc(SOURCE_LABELS[c.source] || c.source || "—")],
      ["受信日", fmtDate(c.receivedAt)],
      ["補助金区分", esc(SUBSIDY_CAT[c.subsidyCategory] || "—")],
      ["想定補助額", yen(c.expectedSubsidyAmount)],
      ["カードリーダー構成", crs],
    ])}

    <h2 class="sec">補助金申請状況</h2>
    ${subsidy ? kvRows([
      ["申請ステータス", esc(subsidy.status || "—")],
      subsidy.applicationDate ? ["申請日", esc(subsidy.applicationDate)] : null,
      subsidy.grantAmount ? ["交付額", yen(subsidy.grantAmount)] : null,
      subsidy.actualDepositDate ? ["振込確認日", esc(subsidy.actualDepositDate)] : null,
    ]) : `<div class="muted">申請情報は登録されていません。</div>`}

    <h2 class="sec">伴走支援の記録</h2>
    ${sessionsHtml}

    <h2 class="sec">対応履歴</h2>
    ${actHtml}

    <div class="footer">
      本報告書はタダカヨの介護情報基盤伴走支援CRMにより自動生成されました。／ NPO法人タダカヨ
    </div>
  `;
  document.getElementById("loadingEl").style.display = "none";
  document.getElementById("reportBody").style.display = "block";
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) {
    location.href = "/index.html";
    return;
  }
  if (!caseId) { document.getElementById("loadingEl").textContent = "案件IDが指定されていません"; return; }
  document.getElementById("backBtn").setAttribute("href", `/case-detail.html?id=${caseId}`);
  document.getElementById("printBtn").addEventListener("click", () => window.print());

  try {
    const caseSnap = await getDoc(doc(db, "cases", caseId));
    if (!caseSnap.exists()) { document.getElementById("loadingEl").textContent = "案件が見つかりません"; return; }
    const c = caseSnap.data();

    const subSnap = await getDoc(doc(db, "subsidyApplications", caseId));
    const subsidy = subSnap.exists() ? subSnap.data() : null;

    const sessSnap = await getDocs(query(collection(db, "sessions"),
      where("caseId", "==", caseId), orderBy("createdAt", "desc")));
    const sessions = sessSnap.docs.map((d) => d.data());

    const actSnap = await getDocs(query(collection(db, "activities"),
      where("caseId", "==", caseId), orderBy("occurredAt", "desc")));
    const activities = actSnap.docs.map((d) => d.data());

    document.title = `支援報告書 #${c.caseNumber || ""} ${c.officeName || ""}`;
    renderReport(c, subsidy, sessions, activities);
  } catch (e) {
    document.getElementById("loadingEl").textContent = `読み込みに失敗しました: ${e.message}`;
  }
});
