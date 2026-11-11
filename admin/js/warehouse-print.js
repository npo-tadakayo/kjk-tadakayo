// 倉庫の人用の宛名印刷（2026-10-24）。Firestore は読まない。
// 倉庫の画面が sessionStorage["warehouse.printJob"] に入れた {labels:[W...], sender, locationName} を、
// letterpack-print.js と同じ体裁（縦14.5cm×横12.5cm の宛名枠＋梱包の確認）で出荷ごとに1ページ描く。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "/js/fs.js";
import { gateRole, showAccessDenied } from "/js/role.js";

import { renderLabel, fitLabel, labelTypeOf } from "/js/letterpack-label.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const JOB_KEY = "warehouse.printJob";
const ALLOWED_ROLES = ["warehouse", "admin", "staff"];

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// 1出荷＝A4 1ページ。宛名枠と梱包の確認は出荷の宛名印刷（letterpack-print）と同じ部品で描く（2026-11-01 倉庫の統合）。
// 倉庫のデータは出荷元を持たないので、印刷を頼んだ保管場所の名前を出荷元として入れる
export function renderPage(s, sender, type, locationName) {
  const t = type === "light" || type === "plus" ? type : "none";
  return `<div class="paper page lp-${t}">${renderLabel({ ...s, originLocationName: s.originLocationName || locationName || "" }, sender, type)}</div>`;
}

function readJob() {
  try { const j = JSON.parse(sessionStorage.getItem(JOB_KEY) || "null"); return j && Array.isArray(j.labels) ? j : null; } catch (_) { return null; }
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  const role = await gateRole(db, user);
  if (!role) return;
  if (!ALLOWED_ROLES.includes(role.role)) {
    showAccessDenied(user.email, "この画面は倉庫の担当・スタッフ・管理者のみ利用できます");
    return;
  }
  let job = readJob();
  // 別の人が作った印刷データは使わない（同じタブでログインし直した場合など）。消してから「ありません」と出す
  if (job && job.uid !== user.uid) { try { sessionStorage.removeItem(JOB_KEY); } catch (_) { /* 何もしない */ } job = null; }
  if (!job || !job.labels.length) { $("pages").innerHTML = `<div class="paper"><div class="loading">印刷する宛名がありません。倉庫の画面から「宛名を印刷」を押してください。</div></div>`; return; }
  const sender = job.sender || null;
  const msgs = [];
  if (!sender) msgs.push("差出人が設定されていません（管理者に連絡してください）。お届け先だけ印刷します。");
  const bad = job.labels.filter((s) => !s.postalCode || !s.address || !s.phone).map((s) => s.soNumber || "");
  if (bad.length) msgs.push(`届け先の郵便番号・住所・電話のいずれかが空です: ${bad.join("、")}。内容を確かめてから印刷してください。`);
  $("pages").innerHTML = job.labels.map((s) => renderPage(s, sender, labelTypeOf(s), job.locationName)).join("");
  // 宛名が長くて枠に収まらない出荷（品名・台数が切れる）。出荷の宛名印刷と同じく警告し、印刷前に確認する
  const overflow = [];
  document.querySelectorAll("#pages .label").forEach((el, i) => { if (!fitLabel(el)) overflow.push(job.labels[i].soNumber || `${i + 1}件目`); });
  if (overflow.length) msgs.push(`宛名が長く、宛名枠（縦14.5cm×横12.5cm）に収まりません: ${overflow.join("、")}。このまま印刷すると品名・台数が切れます。依頼した人に、送付先を短くしてもらってください。`);
  $("warnBox").innerHTML = msgs.map(esc).join("<br>");
  $("warnBox").style.display = msgs.length ? "block" : "none";
  $("countMsg").textContent = `${job.labels.length}件`;
  $("printBtn").addEventListener("click", () => {
    if (overflow.length && !confirm("宛名が宛名枠に収まらず、品名・台数が切れる出荷があります。このまま印刷しますか？")) return;
    window.print();
  });
});
