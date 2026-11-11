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

import { normalizeEmail } from "/js/normalize.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteField, query, where,
  serverTimestamp,
} from "/js/fs.js";
import { isPracticeMode } from "/js/mode.js";
// ここで発行する「伴走支援だけの承諾書」は v1.1 のまま（2026-11-12）。発注書を兼ねる v1.2 はサーバーが受注確定と同時に作る
// （consentRequests の kind:"order"）。発注の承諾書がある案件では、このカードはその承諾書を「署名済み」として出す。
import { SUPPORT_CONSENT_DOCUMENT as CONSENT_DOCUMENT } from "/js/consent-document.js";
import { isOrderConsent, orderConsentLine, ORDER_RECEIVED_VIA } from "/js/order-consent.js";
import { bindMailSend, restoreUnloadGuard, reconcilePending } from "/js/mail-send-guard.js";
import { PENDING_RELEASED_CARD_TEXT } from "/js/record-gaps-case.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let ctx = null;          // { db, caseId, getCase, sendMail, toast, userName, orderByConsent?: () => boolean }
let pendingNotice = "";   // 記録待ちを解除したときにカードへ出す1行（PENDING_RELEASED_CARD_TEXT）
let requests = [];       // この案件の consentRequests（作成日降順）
let openedQrToken = null;

function newToken() {
  const bytes = new Uint8Array(16); // 128bit
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 練習モードで作った依頼は練習DBにあるので、署名ページに「練習」の印（p=1）を付けて渡す（2026-10-20）
function signUrl(token) { return `${location.origin}/consent?t=${token}${isPracticeMode() ? "&p=1" : ""}`; }

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
  // 発注の承諾書（2026-11-12）: まとめ見積もりでは先頭の案件の caseId で作るので、ほかの事業所の案件からは
  // cases.orderConsentToken で直接読む
  const tok = ctx.getCase()?.orderConsentToken;
  if (tok && !requests.some((r) => r._id === tok)) {
    try {
      const s = await getDoc(doc(ctx.db, "consentRequests", String(tok)));
      if (s.exists()) requests.unshift({ _id: s.id, ...s.data() });
    } catch (e) { console.warn("consent card: order consent load failed", e.message); }
  }
  // 送信済み・記録待ちの依頼が署名済み・取り消し済みになっていたら、記録待ちを解除してカードに1行で知らせる
  // （署名済みのカードには「メールで依頼を送る」が無く、モーダルからは解除できないため。2026-11-10 再レビュー 中-1）
  try {
    const rc = await reconcilePending("consent", ctx.caseId, pendingReqIds());
    if (rc.state === "released") pendingNotice = PENDING_RELEASED_CARD_TEXT;
  } catch { /* 照合できなくてもカードは出す */ }
  render();
}

// この案件の未署名の依頼ID（記録待ちの書き込み先の照合に使う。署名済み・取り消し済みは入れない）
function pendingReqIds() {
  return requests.filter((x) => x.status === "pending").map((x) => x._id);
}

function current() {
  // 発注の承諾書（cases.orderConsentToken が指すもの）があれば、それを先に出す（発注の承諾書が伴走支援の承諾も兼ねる）
  const tok = ctx.getCase()?.orderConsentToken;
  const order = tok ? requests.find((r) => r._id === tok && r.status === "signed") : null;
  return order || requests.find((r) => r.status === "signed") || requests.find((r) => r.status === "pending") || null;
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
  if (r.status === "signed" && isOrderConsent(r)) {
    const line = orderConsentLine(r);
    return `<span class="badge" style="background:#E8F3EC;color:#1F7A4F">発注の承諾書・署名済み（${esc(line.method)}・${esc(line.date)}）</span>`;
  }
  if (r.status === "signed") {
    const m = r.signed?.method === "paper" ? "紙" : "オンライン";
    return `<span class="badge" style="background:#E8F3EC;color:#1F7A4F">署名済み（${m}・${fmt(r.signed?.signedAt)}）</span>`;
  }
  // 発行しただけでは「依頼した」ことにならない（2026-10-24 藤田さん指摘）。実際に渡した方法が記録されているときだけ「依頼済み」
  if (r.mailedAt) return `<span class="badge" style="background:#FBF3E4;color:#B45309">依頼メール送信済み・署名待ち（${fmt(r.mailedAt)} 送信）</span>`;
  if (r.handedOutAt) return `<span class="badge" style="background:#FBF3E4;color:#B45309">${r.handedOutVia === "qr" ? "二次元バーコードで依頼中" : "署名ページを案内中"}・署名待ち（${fmt(r.handedOutAt)}）</span>`;
  return `<span class="badge" style="background:#F1EEE7;color:#7d715b">依頼方法未決定（署名URLは${fmt(r.createdAt)}に発行・まだ誰にも送っていません）</span>`;
}

// 渡し方の記録（メール以外）。表示のためだけの印なので、失敗しても操作は止めない
async function markHandout(r, via) {
  if (r.mailedAt || r.handedOutAt) return;
  try {
    await updateDoc(doc(ctx.db, "consentRequests", r._id), { handedOutAt: serverTimestamp(), handedOutVia: via });
    await reload();
  } catch { /* 表示用の印のみ */ }
}

function render() {
  const host = document.getElementById("consentCard");
  if (!host) return;
  const r = current();
  const url = r ? signUrl(r._id) : "";

  let bodyHtml = "";
  // 承諾書のサイン＝発注のスイッチがオンで、まだ発注の承諾書が無い案件: 新しい流れの案内を1行（ボタンは移行中の案件のために残す）
  const orderNote = (!r || r.status !== "signed") && typeof ctx.orderByConsent === "function" && ctx.orderByConsent()
    ? `<p style="font-size:12.5px;color:#2F5878;background:#E9EEF5;border-radius:8px;padding:8px 10px;margin:0 0 10px">
        新しい流れでは、承諾書（発注書を兼ねます）は見積もりの承諾のときにいただきます（対応記録タブの見積もりの「承諾書を印刷」）。
        ここからの署名依頼は、承諾書なしで受注確定になっている案件のためのものです。</p>`
    : "";
  if (r && r.status === "signed" && isOrderConsent(r)) {
    const line = orderConsentLine(r);
    const paper = r.signed?.method === "paper_order";
    bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:14px">確認者 <strong>${esc(line.signer)}</strong>　／　${paper ? "受け取った日" : "署名日"} <strong>${esc(line.date)}</strong>　／　条文の版 ${esc(line.version)}</div>
        <div style="font-size:12.5px;color:var(--color-ink-muted)">発注の承諾書 ${esc(line.displayNo)}（${esc(line.quotes.join("・"))}）。${paper
          ? `紙で受け取り（${esc(ORDER_RECEIVED_VIA[r.signed?.receivedVia] || "その他")}）。記録した職員は対応記録に残っています`
          : "オンラインで同意"}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-secondary" href="${esc(url)}" data-tip="発注の承諾書（署名済み）を新しいタブで開きます。印刷もできます。データは変わりません。" target="_blank" rel="noopener"><i class="ti ti-external-link" aria-hidden="true"></i> 承諾書を開く</a>
        </div>
      </div>`;
  } else if (!r) {
    bodyHtml = `
      <p style="font-size:13px;color:var(--color-ink-muted);margin:0 0 12px">
        伴走支援を始める前に、事業所から承諾書（条文の版 ${esc(CONSENT_DOCUMENT.version)}）をいただきます。
        署名はオンライン（メール・当日画面・二次元バーコード）と紙のどちらでも取れます。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="consentIssueBtn" data-tip="署名ページのアドレスを発行します。発行しただけでは事業所へ届きません（メール・二次元バーコード・署名ページで渡します）。"><i class="ti ti-signature" aria-hidden="true"></i> 署名を依頼する</button>
        <button class="btn btn-secondary" id="consentPaperBtn" data-tip="紙で署名をもらったことを記録します。確認者のお名前と署名日を聞かれます。"><i class="ti ti-file-text" aria-hidden="true"></i> 紙で取得済みを記録</button>
      </div>`;
  } else if (r.status === "pending") {
    bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input class="form-control" readonly value="${esc(url)}" id="consentUrlBox"
                 style="flex:1;min-width:240px;font-size:12px" aria-label="署名ページのアドレス">
          <button class="btn btn-secondary" id="consentCopyBtn" data-tip="署名ページのアドレスをコピーします。"><i class="ti ti-copy" aria-hidden="true"></i> コピー</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary" id="consentMailBtn" data-tip="署名のお願いメールの宛先と文面を確かめる画面を開きます。送るのはその画面の「送信する」です。"><i class="ti ti-mail" aria-hidden="true"></i> メールで依頼を送る</button>
          <button class="btn btn-secondary" id="consentQrBtn" data-tip="署名ページの二次元バーコードを出す・しまうを切り替えます。事業所のスマートフォンで読み取ると署名ページが開きます。"><i class="ti ti-qrcode" aria-hidden="true"></i> 二次元バーコードを表示</button>
          <a class="btn btn-secondary" id="consentOpenLink" data-tip="署名ページを新しいタブで開きます（当日その場で署名してもらうとき）。" href="${esc(url)}" target="_blank" rel="noopener"><i class="ti ti-external-link" aria-hidden="true"></i> 署名ページを開く</a>
          <button class="btn btn-secondary" id="consentCancelBtn" data-tip="この署名依頼を取り消します。送ったアドレスは開けなくなり、元に戻せません。押すと確認が出ます。" style="margin-left:auto;color:var(--color-danger)">依頼を取り消す</button>
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
               <a class="btn btn-secondary" href="${esc(url)}" data-tip="署名済みの承諾書を新しいタブで開きます。印刷もできます。" target="_blank" rel="noopener"><i class="ti ti-external-link" aria-hidden="true"></i> 署名済みの承諾書を開く</a>
               <button class="btn btn-secondary" id="consentCopyBtn" data-tip="署名ページのアドレスをコピーします。"><i class="ti ti-copy" aria-hidden="true"></i> URLをコピー</button>
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
      <div class="card-body">${pendingNotice
        ? `<div role="status" style="font-size:12.5px;color:var(--color-warning,#B45309);background:#FBF3E4;border-radius:8px;padding:8px 10px;margin-bottom:10px">${esc(pendingNotice)}</div>`
        : ""}${orderNote}${bodyHtml}</div>
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
  on("consentQrBtn", () => { openedQrToken = openedQrToken === r._id ? null : r._id; render(); if (openedQrToken) markHandout(r, "qr"); });
  on("consentOpenLink", () => markHandout(r, "link"));
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
  const btn = document.getElementById("consentIssueBtn");
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
  const c = ctx.getCase();
  const token = newToken();
  await setDoc(doc(ctx.db, "consentRequests", token), {
    caseId: ctx.caseId,
    displayNo: `CST-${String(c.caseNumber ?? ctx.caseId).slice(0, 12)}`,
    officeName: c.officeName || "",
    company: c.corpName || c.company || "",
    contactName: c.contactName || "",
    status: "pending",
    document: CONSENT_DOCUMENT,          // ★この時点の条文全文を焼き込む
    createdAt: serverTimestamp(),
    createdBy: ctx.userName,
  });
  ctx.toast("署名依頼を発行しました");
  await reload();
  } catch (e) { alert(`発行に失敗しました: ${e.message}`); }
  finally { if (btn) btn.disabled = false; }
}

// ---- 紙での取得を記録 ----
async function recordPaper() {
  const btn = document.getElementById("consentPaperBtn");
  if (btn?.disabled) return;
  const c = ctx.getCase();
  const name = prompt("紙の承諾書に署名した確認者のお名前を入力してください", c.contactName || "");
  if (!name || !name.trim()) return;
  const dateStr = prompt("署名日（YYYY-MM-DD）", new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }));
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { alert("日付は YYYY-MM-DD の形式で入力してください"); return; }
  if (btn) btn.disabled = true;
  try {
  const token = newToken();
  await setDoc(doc(ctx.db, "consentRequests", token), {
    caseId: ctx.caseId,
    displayNo: `CST-${String(c.caseNumber ?? ctx.caseId).slice(0, 12)}`,
    officeName: c.officeName || "",
    company: c.corpName || c.company || "",
    contactName: c.contactName || "",
    status: "signed",
    document: CONSENT_DOCUMENT,
    signed: { name: name.trim().slice(0, 100), signedDate: dateStr, method: "paper", recordedBy: ctx.userName, signedAt: serverTimestamp() },
    createdAt: serverTimestamp(),
    createdBy: ctx.userName,
  });
  ctx.toast("紙での取得を記録しました（原本は事業所へお渡しください）");
  await reload();
  } catch (e) { alert(`記録に失敗しました: ${e.message}`); }
  finally { if (btn) btn.disabled = false; }
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
          <button id="consentMailClose" data-tip="送らずに閉じます。" class="btn btn-secondary" style="margin-left:auto" aria-label="閉じる">×</button>
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
          <button class="btn btn-secondary" id="consentMailCancel" data-tip="送らずに閉じます。">キャンセル</button>
          <button class="btn btn-primary" id="consentMailSend" data-tip="事務局から承諾書の署名のお願いメールを送り、送った日時を記録します。対応記録にも残り、取り消せません（「記録だけやり直す」のときはメールは送りません）。"><i class="ti ti-send" aria-hidden="true"></i> 送信する</button>
        </div>
      </div>
    </div>`;
  // 送信 → 記録は mail-send-guard.js（送信と記録の成否を分ける・記録待ちを覚える・送信中は閉じさせない。2026-11-10 点検4）。
  // mailedAt は送信が成功した時点の時刻（記録だけやり直しても同じ値）
  bindMailSend({
    kind: "consent", caseId: ctx.caseId, reqId: r._id, host,
    // 記録待ちの書き込み先の照合に使う（この案件の未署名の依頼。取り消し・署名済みは入れない）
    candidateReqIds: pendingReqIds(),
    ids: { close: "consentMailClose", cancel: "consentMailCancel", send: "consentMailSend", fields: ["cmTo", "cmSubject", "cmBody"] },
    readInputs: () => {
      const to = normalizeEmail(document.getElementById("cmTo").value);
      const subject = document.getElementById("cmSubject").value.trim();
      const body = document.getElementById("cmBody").value;
      if (!to || !subject || !body) { alert("宛先・件名・本文を入力してください"); return null; }
      return { to, subject, body };
    },
    send: ({ to, subject, body }) => ctx.sendMail({ to, subject, body, caseId: ctx.caseId }),
    // reqId は照合で決まった書き込み先（記録待ちを開き直したとき、いま開いている依頼と違うことがある）
    record: (to, sentAtIso, reqId) => updateDoc(doc(ctx.db, "consentRequests", reqId || r._id), { mailedAt: new Date(sentAtIso), mailedTo: to }),
    onDone: async (close) => {
      pendingNotice = ""; // 新しく送って記録まで済んだら、前回の解除のお知らせは消す
      ctx.toast("署名依頼メールを送信しました");
      close();
      await reload();
    },
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
  restoreUnloadGuard("consent", ctx.caseId); // 送信済み・記録待ちのまま再読み込みしたときも、離れる前に確認
  await reload();
}
