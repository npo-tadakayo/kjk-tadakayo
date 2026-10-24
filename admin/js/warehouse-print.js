// 倉庫の人用の宛名印刷（2026-10-24）。Firestore は読まない。
// 倉庫の画面が sessionStorage["warehouse.printJob"] に入れた {labels:[W...], sender, locationName} を、
// letterpack-print.js と同じ体裁（A4 上半分に宛名枠＋梱包メモ）で出荷ごとに1ページ描く。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "/js/fs.js";
import { gateRole, showAccessDenied } from "/js/role.js";
import { letterPackOrDefault } from "/js/ship-flow.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const JOB_KEY = "warehouse.printJob";
const TYPE_LABEL = { light: "レターパックライト", plus: "レターパックプラス" };
const ALLOWED_ROLES = ["warehouse", "admin", "staff"];

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function itemsMemo(s) {
  return (Array.isArray(s.items) ? s.items : []).filter((i) => i && Number(i.qty) > 0)
    .map((i) => `${esc(i.sku)}${i.name && i.name !== i.sku ? `（${esc(i.name)}）` : ""} × ${Number(i.qty)}台`).join("<br>");
}

export function renderLabel(s, sender, type, locationName) {
  sender = sender || {};
  const head = TYPE_LABEL[type] || "レターパック（種類が未選択です）";
  const zip = s.postalCode ? `〒${esc(s.postalCode)}` : "〒";
  const person = String(s.contactName || "").trim();
  const fromZip = sender.postalCode ? `〒${esc(sender.postalCode)} ` : "";
  return `
    <div class="paper page lp-${esc(type || "none")}">
    <div class="label">
      <div class="label-head"><span>${esc(head)}</span><small>宛名ラベル</small></div>
      <div class="to">
        <div class="sec">お届け先</div>
        <div class="zip">${zip}</div>
        <div class="addr">${esc(s.address || "")}</div>
        ${s.company ? `<div class="org">${esc(s.company)}</div>` : ""}
        ${s.officeName ? `<div class="org">${esc(s.officeName)}</div>` : ""}
        <div class="name">${person ? esc(person) : "ご担当者"}<span class="sama">様</span></div>
        <div class="tel">TEL ${esc(s.phone || "")}</div>
      </div>
      <div class="from">
        <div class="sec">ご依頼主</div>
        <div>${fromZip}${esc(sender.address || "")}</div>
        <div class="from-name">${esc(sender.name || "")}</div>
        ${sender.phone ? `<div>TEL ${esc(sender.phone)}</div>` : ""}
      </div>
      <div class="so"><span>出荷番号 <strong>${esc(s.soNumber || "")}</strong></span><span>品名: 介護情報基盤 マイナ資格確認 カードリーダー</span></div>
    </div>
    <div class="cut"><span>✂ 上の枠を切り取って、レターパックの宛名面に貼ってください</span></div>
    <div class="memo">
      <div>梱包用のメモ（貼らない）</div>
      <table><tbody>
        <tr><th>出荷番号</th><td>${esc(s.soNumber || "")}</td></tr>
        <tr><th>出荷日</th><td>${esc(s.shipDate || "")}</td></tr>
        <tr><th>出荷元</th><td>${esc(locationName || "")}</td></tr>
        <tr><th>品目</th><td>${itemsMemo(s) || "—"}</td></tr>
        <tr><th>種類</th><td>${esc(TYPE_LABEL[type] || "未選択")}</td></tr>
      </tbody></table>
    </div></div>`;
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
  $("warnBox").innerHTML = msgs.map(esc).join("<br>");
  $("warnBox").style.display = msgs.length ? "block" : "none";
  $("pages").innerHTML = job.labels.map((s) => renderLabel(s, sender, letterPackOrDefault(s.letterPackType), job.locationName)).join("");
  $("countMsg").textContent = `${job.labels.length}件`;
  $("printBtn").addEventListener("click", () => window.print());
});
