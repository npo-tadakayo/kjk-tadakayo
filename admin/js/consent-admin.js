// 伴走支援承諾書 — CRM側（案件詳細・事前確認タブの先頭カード）
//
// できること:
//   ・署名依頼の発行（トークンURLの生成。条文全文をその時点の版で焼き込む）
//   ・依頼メールの送信（既存の sendCaseEmail を流用＝タイムラインにも自動で残る）
//   ・URLコピー／QRコード表示（当日・リモートで事業所のスマホに読ませる用）
//   ・署名状態の表示（未依頼／依頼済み／署名済み）
//   ・紙で取得した場合の手動記録（method:"paper" の署名済みドキュメントを作る）
//
// 設計の要:
//   ・トークン＝consentRequests のドキュメントID（crypto 128bit・base64url）。URLが鍵
//   ・条文は発行時に全文を焼き込む（consent-document.js の注記を参照）
//   ・署名そのものは公開ページ（consent.html）が行う。ここでは作成・取消・閲覧だけ

import {
  collection, doc, getDocs, setDoc, updateDoc, deleteField, query, where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { CONSENT_DOCUMENT } from "/js/consent-document.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let ctx = null;          // { db, caseId, getCase, sendMail, toast, userName }
let requests = [];       // この案件の consentRequests（作成日降順）
let openedQrToken = null;

function newToken() {
  const bytes = new Uint8Array(16); // 128bit
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signUrl(token) { return `${location.origin}/consent?t=${token}`; }

function fmt(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch { return ""; }
}

async function reload() {
  const qs = await getDocs(query(collection(ctx.db, "consentRequests"), where("caseId", "==", ctx.caseId)));
  requests = qs.docs
    .map((d) => ({ _id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  render();
}

function current() {
  return requests.find((r) => r.status === "signed") || requests.find((r) => r.status === "pending") || null;
}

// ---- QR 描画（自己ホストの qrcode-generator。CDNは読まない）----
function qrSvg(text, sizePx) {
  const q = window.qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const cell = Math.floor(sizePx / (n + 8));
  const margin = cell * 4;
  const size = cell * n + margin * 2;
  let rects = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) rects += `<rect x="${margin + c * cell}" y="${margin + r * cell}" width="${cell}" height="${cell}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="署名ページの二次元バーコード"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#1a1613">${rects}</g></svg>`;
}

// ---- 表示 ----
function statusBadge(r) {
  if (!r) return `<span class="badge" style="background:var(--color-bg-alt,#F1EEE7);color:var(--color-ink-muted,#7d715b)">未依頼</span>`;
  if (r.status === "signed") {
    const m = r.signed?.method === "paper" ? "紙" : "オンライン";
    return `<span class="badge" style="background:#E8F3EC;color:#1F7A4F">署名済み（${m}・${fmt(r.signed?.signedAt)}）</span>`;
  }
  return `<span class="badge" style="background:#FBF3E4;color:#B45309">依頼済み・署名待ち（${fmt(r.createdAt)} 発行）</span>`;
}

function render() {
  const host = document.getElementById("consentCard");
  if (!host) return;
  const r = current();
  const url = r ? signUrl(r._id) : "";

  let bodyHtml = "";
  if (!r) {
    bodyHtml = `
      <p style="font-size:13px;color:var(--color-ink-muted);margin:0 0 12px">
        伴走支援を始める前に、事業所から承諾書（条文の版 ${esc(CONSENT_DOCUMENT.version)}）をいただきます。
        署名はオンライン（メール・当日画面・二次元バーコード）と紙のどちらでも取れます。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="consentIssueBtn"><i class="ti ti-signature" aria-hidden="true"></i> 署名を依頼する</button>
        <button class="btn btn-secondary" id="consentPaperBtn"><i class="ti ti-file-text" aria-hidden="true"></i> 紙で取得済みを記録</button>
      </div>`;
  } else if (r.status === "pending") {
    bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input class="form-control" readonly value="${esc(url)}" id="consentUrlBox"
                 style="flex:1;min-width:240px;font-size:12px" aria-label="署名ページのアドレス">
          <button class="btn btn-secondary" id="consentCopyBtn"><i class="ti ti-copy" aria-hidden="true"></i> コピー</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary" id="consentMailBtn"><i class="ti ti-mail" aria-hidden="true"></i> メールで依頼を送る</button>
          <button class="btn btn-secondary" id="consentQrBtn"><i class="ti ti-qrcode" aria-hidden="true"></i> 二次元バーコードを表示</button>
          <a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener"><i class="ti ti-external-link" aria-hidden="true"></i> 署名ページを開く</a>
          <button class="btn btn-secondary" id="consentCancelBtn" style="margin-left:auto;color:var(--color-danger)">依頼を取り消す</button>
        </div>
        <div id="consentQrWrap" style="display:${openedQrToken === r._id ? "flex" : "none"};flex-direction:column;align-items:center;gap:8px;padding:14px;background:#fff;border:1px solid var(--color-border);border-radius:12px">
          <div id="consentQrBox">${openedQrToken === r._id ? qrSvg(url, 220) : ""}</div>
          <div style="font-size:12px;color:var(--color-ink-muted)">事業所のスマートフォンで読み取ると署名ページが開きます（当日・リモート用）</div>
        </div>
      </div>`;
  } else {
    bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:14px">確認者 <strong>${esc(r.signed?.name || "")}</strong>　／　署名日 <strong>${esc(fmt(r.signed?.signedAt))}</strong>　／　条文の版 ${esc(r.document?.version || "")}</div>
        ${r.signed?.method === "paper"
          ? `<div style="font-size:12.5px;color:var(--color-ink-muted)">紙で取得（原本は事業所へお渡し済み）。記録者: ${esc(r.signed?.recordedBy || "")}</div>`
          : `<div style="display:flex;gap:8px;flex-wrap:wrap">
               <a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener"><i class="ti ti-external-link" aria-hidden="true"></i> 署名済みの承諾書を開く</a>
               <button class="btn btn-secondary" id="consentCopyBtn"><i class="ti ti-copy" aria-hidden="true"></i> URLをコピー</button>
             </div>
             <div style="font-size:12px;color:var(--color-ink-muted)">同じURLでいつでも表示・印刷できます（事業所の控えも同じURLです）</div>`}
      </div>`;
  }

  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:14px">伴走支援承諾書</span>
        ${statusBadge(r)}
        <span style="margin-left:auto;font-size:11.5px;color:var(--color-ink-muted)">署名をいただいてから伴走支援を始めます</span>
      </div>
      <div class="card-body">${bodyHtml}</div>
    </div>`;

  wire(r, url);
}

function wire(r, url) {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };

  on("consentIssueBtn", issue);
  on("consentPaperBtn", recordPaper);
  on("consentCopyBtn", async () => {
    try { await navigator.clipboard.writeText(url); ctx.toast("署名ページのURLをコピーしました"); }
    catch { const box = document.getElementById("consentUrlBox"); if (box) { box.select(); document.execCommand("copy"); ctx.toast("URLをコピーしました"); } }
  });
  on("consentQrBtn", () => { openedQrToken = openedQrToken === r._id ? null : r._id; render(); });
  on("consentMailBtn", () => openMailModal(r, url));
  on("consentCancelBtn", async () => {
    if (!confirm("この署名依頼を取り消します。送付済みのURLは開けなくなります。よろしいですか？")) return;
    await updateDoc(doc(ctx.db, "consentRequests", r._id), { status: "canceled", canceledAt: serverTimestamp(), canceledBy: ctx.userName });
    ctx.toast("署名依頼を取り消しました");
    await reload();
  });
}

// ---- 発行 ----
async function issue() {
  const c = ctx.getCase();
  const token = newToken();
  await setDoc(doc(ctx.db, "consentRequests", token), {
    caseId: ctx.caseId,
    displayNo: `CST-${String(c.caseNo ?? ctx.caseId).slice(0, 12)}`,
    officeName: c.officeName || "",
    company: c.corpName || c.company || "",
    contactName: c.contactName || "",
    email: c.contactEmail || c.email || "",
    status: "pending",
    document: CONSENT_DOCUMENT,          // ★この時点の条文全文を焼き込む
    createdAt: serverTimestamp(),
    createdBy: ctx.userName,
  });
  ctx.toast("署名依頼を発行しました");
  await reload();
}

// ---- 紙での取得を記録 ----
async function recordPaper() {
  const c = ctx.getCase();
  const name = prompt("紙の承諾書に署名した確認者のお名前を入力してください", c.contactName || "");
  if (!name || !name.trim()) return;
  const dateStr = prompt("署名日（YYYY-MM-DD）", new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }));
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { alert("日付は YYYY-MM-DD の形式で入力してください"); return; }
  const token = newToken();
  await setDoc(doc(ctx.db, "consentRequests", token), {
    caseId: ctx.caseId,
    displayNo: `CST-${String(c.caseNo ?? ctx.caseId).slice(0, 12)}`,
    officeName: c.officeName || "",
    company: c.corpName || c.company || "",
    contactName: c.contactName || "",
    email: c.contactEmail || c.email || "",
    status: "signed",
    document: CONSENT_DOCUMENT,
    signed: { name: name.trim().slice(0, 100), signedDate: dateStr, method: "paper", recordedBy: ctx.userName, signedAt: serverTimestamp() },
    createdAt: serverTimestamp(),
    createdBy: ctx.userName,
  });
  ctx.toast("紙での取得を記録しました（原本は事業所へお渡しください）");
  await reload();
}

// ---- 依頼メール ----
function mailTemplate(c, url) {
  return {
    subject: `【NPO法人タダカヨ】伴走支援承諾書のご確認のお願い（${c.officeName || ""}様）`,
    body:
      `${c.officeName || ""}\n${c.contactName ? c.contactName + " 様" : "ご担当者様"}\n\n` +
      `NPO法人タダカヨです。\n` +
      `介護情報基盤の伴走支援を始めるにあたり、支援の進め方と個人情報の取扱いを\n` +
      `まとめた「承諾書」のご確認をお願いしております。\n\n` +
      `下記のページを開き、内容をご確認のうえ、お名前を入力してご署名ください。\n` +
      `スマートフォンからもご署名いただけます（3分ほどで終わります）。\n\n` +
      `▼承諾書のご確認・ご署名はこちら\n${url}\n\n` +
      `ご不明な点は、このメールへの返信でお気軽にお尋ねください。\n\n` +
      `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`,
  };
}

function openMailModal(r, url) {
  const c = ctx.getCase();
  const t = mailTemplate(c, url);
  const host = document.getElementById("consentMailModal");
  host.innerHTML = `
    <div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(30,25,18,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="modal" style="position:relative;background:var(--color-bg,#FAFAF8);border-radius:16px;max-width:640px;width:100%;max-height:90vh;overflow:auto;padding:0">
        <div style="display:flex;align-items:center;gap:10px;padding:18px 22px;border-bottom:1px solid var(--color-border)">
          <strong style="font-size:15px">承諾書の署名依頼メール</strong>
          <button id="consentMailClose" class="btn btn-secondary" style="margin-left:auto" aria-label="閉じる">×</button>
        </div>
        <div style="padding:18px 22px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label class="form-label" for="cmTo">宛先 *</label>
            <input class="form-control" id="cmTo" type="email" value="${esc(c.contactEmail || c.email || "")}">
          </div>
          <div>
            <label class="form-label" for="cmSubject">件名 *</label>
            <input class="form-control" id="cmSubject" value="${esc(t.subject)}">
          </div>
          <div>
            <label class="form-label" for="cmBody">本文 *</label>
            <textarea class="form-control" id="cmBody" rows="12" style="font-size:13px">${esc(t.body)}</textarea>
          </div>
          <div style="font-size:12px;color:var(--color-ink-muted)">送信するとタイムラインにも記録されます（sendCaseEmail 経由）</div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;padding:14px 22px;border-top:1px solid var(--color-border)">
          <button class="btn btn-secondary" id="consentMailCancel">キャンセル</button>
          <button class="btn btn-primary" id="consentMailSend"><i class="ti ti-send" aria-hidden="true"></i> 送信する</button>
        </div>
      </div>
    </div>`;
  const close = () => { host.innerHTML = ""; };
  document.getElementById("consentMailClose").addEventListener("click", close);
  document.getElementById("consentMailCancel").addEventListener("click", close);
  document.getElementById("consentMailSend").addEventListener("click", async (e) => {
    const to = document.getElementById("cmTo").value.trim();
    const subject = document.getElementById("cmSubject").value.trim();
    const body = document.getElementById("cmBody").value;
    if (!to || !subject || !body) { alert("宛先・件名・本文を入力してください"); return; }
    e.target.disabled = true;
    try {
      await ctx.sendMail({ to, subject, body, caseId: ctx.caseId });
      await updateDoc(doc(ctx.db, "consentRequests", r._id), { mailedAt: serverTimestamp(), mailedTo: to });
      ctx.toast("署名依頼メールを送信しました");
      close();
      await reload();
    } catch (err) {
      alert(`送信に失敗しました: ${err.message || err}`);
      e.target.disabled = false;
    }
  });
}

// ---- 初期化（case-detail.js から呼ぶ）----
export async function initConsentCard(options) {
  ctx = options;
  const pre = document.getElementById("tab-pre");
  if (!pre) return;
  // 事前確認タブの先頭にカードの器を差し込む（support-checklist の描画を壊さない）
  let host = document.getElementById("consentCard");
  if (!host) {
    host = document.createElement("div");
    host.id = "consentCard";
    pre.insertBefore(host, pre.firstChild);
  }
  if (!document.getElementById("consentMailModal")) {
    const m = document.createElement("div");
    m.id = "consentMailModal";
    document.body.appendChild(m);
  }
  await reload();
}
