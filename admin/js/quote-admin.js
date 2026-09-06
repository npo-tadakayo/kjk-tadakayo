// 見積もりカード — 案件詳細（対応記録タブの先頭）
//
// できること:
//   ・その案件に紐づく見積もり（quotes・mitsumori.html から自動発行）を版が新しい順に一覧表示
//   ・PDFを開く（保存済みの場合）
//   ・事業所へ再送（Cloud Functions の resendQuoteMail を呼ぶ。Storage の保存済みPDFを添付して送る）
//
// 設計の要:
//   ・見積もりは事業所側（mitsumori.html）が作るもの。ここは閲覧・再送のみ（作成・編集はしない）
//   ・quotes は caseId で onSnapshot 購読し、version 降順（新しい版が先頭）で並べる
//   ・品番→表示名は products コレクション（doc id = sku）を一度だけ読み込み、name と
//     connectionLabel(product) を併記する。取得できない品番はそのまま sku を出す

import {
  collection, query, where, onSnapshot, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { connectionLabel, findProduct } from "/js/product-label.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let ctx = null;         // { db, caseId, getCase, toast, userName, functions }
let quotes = [];        // この案件の quotes（version 降順）
let products = [];      // products コレクション全件（一度だけ取得。キャッシュ）
let unsub = null;
const sendingIds = new Set(); // 二重押し防止（再送中の quoteId）

const PLAN_LABELS = { houmon: "訪問・通所・短期滞在系", kyojyu: "居住・入所系", other: "その他" };

const STATUS_META = {
  issued:     { label: "発行済み",     bg: "#E9EEF5", fg: "#2F5878" },
  accepted:   { label: "申し込み済み", bg: "#E8F3EC", fg: "#1F7A4F" },
  superseded: { label: "旧版",         bg: "#F1EEE7", fg: "#7d715b" },
  expired:    { label: "期限切れ",     bg: "#F1EEE7", fg: "#7d715b" },
};

function statusBadge(status) {
  const m = STATUS_META[status] || { label: status || "—", bg: "#F1EEE7", fg: "#7d715b" };
  return `<span class="badge" style="background:${m.bg};color:${m.fg}">${esc(m.label)}</span>`;
}

function ymdJst(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  } catch { return ""; }
}

function yen(n) { return `¥${(Number(n) || 0).toLocaleString("ja-JP")}`; }

// 品番1件 → 「CIR415A（Bluetooth／USB Type-C）」等の表示名（products に無ければ sku のまま）
function productDisplayName(sku) {
  const p = findProduct(sku, products);
  if (!p) return esc(sku);
  const label = connectionLabel(p);
  const name = p.name || sku;
  return label ? `${esc(name)}（${esc(label)}）` : esc(name);
}

function itemsLine(items) {
  if (!Array.isArray(items) || !items.length) return "—";
  return items.map((it) => {
    const subsidyQty = Number(it?.subsidyQty) || 0;
    const extraQty = Number(it?.extraQty) || 0;
    return `${productDisplayName(it?.sku)}：補助対象 ${subsidyQty}台＋追加 ${extraQty}台`;
  }).join("、");
}

function pdfCell(q) {
  if (q.pdfUrl) {
    return `<a class="btn btn-secondary" href="${esc(q.pdfUrl)}" target="_blank" rel="noopener"><i class="ti ti-file-text" aria-hidden="true"></i> PDFを開く</a>`;
  }
  return `<span style="font-size:12px;color:var(--color-ink-muted)">PDF未保存</span>`;
}

// 「内容を変更する」ボタン。出荷が下書きのうちだけ出す（確定後は供給管理の「出荷の修正」で直す）
function reviseBtn(q, isLatest) {
  if (!isLatest) return "";
  if (q.status === "superseded" || q.status === "expired") return "";
  return `<button class="btn btn-secondary" data-revise-id="${esc(q._id)}">
    <i class="ti ti-edit" aria-hidden="true"></i> 内容を変更する
  </button>`;
}

function resendBtn(q) {
  const busy = sendingIds.has(q._id);
  const label = q.mailedAt ? "事業所へ再送" : "事業所へ送付";
  return `<button class="btn btn-secondary" data-resend-id="${esc(q._id)}" ${busy ? "disabled" : ""}>
    <i class="ti ti-send" aria-hidden="true"></i> ${busy ? "送信中..." : label}
  </button>`;
}

function rowHtml(q, isLatest) {
  const plan = PLAN_LABELS[q.plan] || q.plan || "—";
  return `
    <div style="padding:14px 0;border-top:1px solid var(--color-border);${isLatest ? "" : "opacity:.75"}">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
        <strong style="font-size:13.5px">v${esc(q.version ?? "—")}</strong>
        <span style="font-size:13px;color:var(--color-ink-muted)">${esc(q.estNo || "")}</span>
        ${statusBadge(q.status)}
        <span style="font-size:12px;color:var(--color-ink-muted)">発行日 ${esc(ymdJst(q.createdAt)) || "—"}</span>
        <span style="font-size:12px;color:var(--color-ink-muted)">プラン: ${esc(plan)}</span>
      </div>
      <div style="font-size:13px;margin-bottom:8px">${itemsLine(q.items)}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin-bottom:10px">
        <span>合計（税込） <strong>${yen(q.amounts?.totalIncl)}</strong></span>
        <span>自己負担 <strong>${yen(q.amounts?.selfPay)}</strong></span>
        <span style="color:var(--color-ink-muted)">有効期限 ${esc(ymdJst(q.validUntil)) || "—"}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${pdfCell(q)}
        ${resendBtn(q)}
        ${reviseBtn(q, isLatest)}
      </div>
    </div>`;
}

function render() {
  const host = document.getElementById("quoteCard");
  if (!host) return;

  const latest = quotes[0] || null;
  const bodyHtml = quotes.length
    ? quotes.map((q, i) => rowHtml(q, i === 0)).join("")
    : `<p style="font-size:13px;color:var(--color-ink-muted);margin:0">見積もりはまだありません。事業所が見積もりツールで作成すると、ここに並びます。</p>`;

  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:14px">見積もり</span>
        ${latest ? statusBadge(latest.status) : ""}
        <span style="margin-left:auto;font-size:11.5px;color:var(--color-ink-muted)">Webから作成された見積もりが自動で並びます</span>
      </div>
      <div class="card-body">${bodyHtml}</div>
    </div>`;

  wire();
}

function wire() {
  const host = document.getElementById("quoteCard");
  if (!host) return;
  host.querySelectorAll("[data-resend-id]").forEach((btn) => {
    btn.addEventListener("click", () => resend(btn.getAttribute("data-resend-id")));
  });
  host.querySelectorAll("[data-revise-id]").forEach((btn) => {
    btn.addEventListener("click", () => openRevise(btn.getAttribute("data-revise-id")));
  });
  const cancel = document.getElementById("reviseCancel");
  if (cancel) cancel.addEventListener("click", closeRevise);
  const submit = document.getElementById("reviseSubmit");
  if (submit) submit.addEventListener("click", submitRevise);
}

async function resend(quoteId) {
  if (!quoteId || sendingIds.has(quoteId)) return;
  sendingIds.add(quoteId);
  render();
  try {
    const resendQuoteMail = httpsCallable(ctx.functions, "resendQuoteMail");
    await resendQuoteMail({ quoteId });
    ctx.toast("見積書を送りました");
  } catch (e) {
    alert(`送信に失敗しました: ${e.message || e}`);
  } finally {
    sendingIds.delete(quoteId);
    render();
  }
}

// ---- 内容の変更（改版）----
const PLAN_MAX = { houmon: 3, kyojyu: 2, other: 1 };
let revising = null;

function qtyOptions(max, sel) {
  let o = "";
  for (let i = 0; i <= max; i++) o += `<option value="${i}"${Number(sel) === i ? " selected" : ""}>${i}台</option>`;
  return o;
}

function openRevise(quoteId) {
  const q = quotes.find((x) => x._id === quoteId);
  if (!q) return;
  revising = q;
  // 品番から今の構成を読み戻す（BT / USB と、USBの口の形）
  let bt = 0, btx = 0, usb = 0, usbx = 0, connector = "";
  for (const it of (q.items || [])) {
    if (it.sku === "cir415a-01") { bt = Number(it.subsidyQty) || 0; btx = Number(it.extraQty) || 0; }
    else { usb = Number(it.subsidyQty) || 0; usbx = Number(it.extraQty) || 0; connector = it.connector || (it.sku === "cir315a-04" ? "C" : "A"); }
  }
  const host = document.getElementById("reviseModalHost");
  host.innerHTML = `
    <div class="modal-overlay open" id="reviseModal">
      <div class="modal" style="width:min(520px,95vw)">
        <div class="modal-header">
          <h3 style="font-size:15px;margin:0">見積もりの内容を変更（${esc(q.estNo)} v${esc(q.version)} → v${Number(q.version) + 1}）</h3>
        </div>
        <div class="modal-body" style="display:grid;gap:14px">
          <p style="font-size:12.5px;color:var(--color-ink-muted);line-height:1.8;margin:0">
            支援の調整で台数や機種が変わったときに使います。前の版は記録として残ります。
            出荷の下書きがあれば、同じ内容に作り直します。<b>変更後の金額は事業所へメールでお知らせします。</b>
          </p>
          <div>
            <label class="form-label" for="rvPlan">プラン</label>
            <select class="form-control" id="rvPlan">
              <option value="houmon"${q.plan === "houmon" ? " selected" : ""}>訪問・通所・短期滞在系（最大3台）</option>
              <option value="kyojyu"${q.plan === "kyojyu" ? " selected" : ""}>居住・入所系（最大2台）</option>
              <option value="other"${q.plan === "other" ? " selected" : ""}>その他（最大1台）</option>
            </select>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label class="form-label" for="rvBt">CIR415A（Bluetooth）補助対象</label>
              <select class="form-control" id="rvBt">${qtyOptions(3, bt)}</select>
            </div>
            <div>
              <label class="form-label" for="rvBtx">同・追加（自己負担）</label>
              <select class="form-control" id="rvBtx">${qtyOptions(10, btx)}</select>
            </div>
            <div>
              <label class="form-label" for="rvUsb">CIR315A（USB）補助対象</label>
              <select class="form-control" id="rvUsb">${qtyOptions(3, usb)}</select>
            </div>
            <div>
              <label class="form-label" for="rvUsbx">同・追加（自己負担）</label>
              <select class="form-control" id="rvUsbx">${qtyOptions(10, usbx)}</select>
            </div>
          </div>
          <div>
            <label class="form-label" for="rvConn">USBの口の形</label>
            <select class="form-control" id="rvConn">
              <option value=""${!connector ? " selected" : ""}>未定（Type-A で手配）</option>
              <option value="A"${connector === "A" ? " selected" : ""}>Type-A（四角い口）</option>
              <option value="C"${connector === "C" ? " selected" : ""}>Type-C（小さい楕円）</option>
            </select>
          </div>
          <div>
            <label class="form-label" for="rvReason">変更の理由<span style="color:var(--color-primary)">必須</span></label>
            <input class="form-control" id="rvReason" placeholder="例: 支援日程の相談でUSB Type-Cへ変更（〇月〇日 電話）">
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:44px">
            <input type="checkbox" id="rvMail" checked> 変更後の内容を事業所へメールで知らせる
          </label>
          <p id="rvError" style="display:none;color:var(--color-primary);font-size:12.5px;margin:0;line-height:1.7"></p>
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-secondary" id="reviseCancel">やめる</button>
          <button class="btn btn-primary" id="reviseSubmit">この内容で変更する</button>
        </div>
      </div>
    </div>`;
  document.getElementById("reviseCancel").addEventListener("click", closeRevise);
  document.getElementById("reviseSubmit").addEventListener("click", submitRevise);
  document.getElementById("reviseModal").addEventListener("click", (e) => {
    if (e.target.id === "reviseModal") closeRevise();
  });
}

function closeRevise() {
  const host = document.getElementById("reviseModalHost");
  if (host) host.innerHTML = "";
  revising = null;
}

async function submitRevise() {
  if (!revising) return;
  const err = document.getElementById("rvError");
  const show = (m) => { err.textContent = m; err.style.display = "block"; };
  const num = (id) => Number(document.getElementById(id).value) || 0;
  const plan = document.getElementById("rvPlan").value;
  const bt = num("rvBt"), usb = num("rvUsb");
  const reason = (document.getElementById("rvReason").value || "").trim();
  if (!reason) { show("変更の理由をご入力ください（あとから経緯を追えるようにするためです）"); return; }
  if (bt + usb < 1) { show("補助対象のカードリーダーを1台以上にしてください"); return; }
  if (bt + usb > (PLAN_MAX[plan] || 1)) { show(`このプランの補助対象は最大${PLAN_MAX[plan]}台です`); return; }
  const btn = document.getElementById("reviseSubmit");
  btn.disabled = true; btn.textContent = "変更中...";
  try {
    const fn = httpsCallable(ctx.functions, "reviseQuote");
    const r = await fn({
      quoteId: revising._id, plan, btQty: bt, usbQty: usb,
      btExtra: num("rvBtx"), usbExtra: num("rvUsbx"),
      usbConnector: document.getElementById("rvConn").value || null,
      reason, sendMail: document.getElementById("rvMail").checked,
    });
    const d = r.data || {};
    closeRevise();
    ctx.toast(`見積もりを v${d.version} に変更しました`
      + (d.shipmentUpdated ? "（出荷の下書きも更新）" : "")
      + (d.mailed ? "。事業所へメールを送りました" : ""));
  } catch (e) {
    show(e.message || String(e));
    btn.disabled = false; btn.textContent = "この内容で変更する";
  }
}

async function loadProducts() {
  try {
    const snap = await getDocs(collection(ctx.db, "products"));
    products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn("quote card: products load failed", e.message);
    products = [];
  }
}

// ---- 初期化（case-detail.js から呼ぶ）----
export async function initQuoteCard(options) {
  ctx = options;
  const timeline = document.getElementById("tab-timeline");
  if (!timeline) return;
  // 対応記録タブの先頭にカードの器を差し込む
  let host = document.getElementById("quoteCard");
  if (!host) {
    host = document.createElement("div");
    host.id = "quoteCard";
    timeline.insertBefore(host, timeline.firstChild);
  }

  if (!document.getElementById("reviseModalHost")) {
    const mh = document.createElement("div");
    mh.id = "reviseModalHost";
    document.body.appendChild(mh);
  }

  await loadProducts();

  if (unsub) { unsub(); unsub = null; }
  const q = query(collection(ctx.db, "quotes"), where("caseId", "==", ctx.caseId));
  unsub = onSnapshot(q, (qs) => {
    quotes = qs.docs
      .map((d) => ({ _id: d.id, ...d.data() }))
      .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
    render();
  }, (e) => console.warn("quote card: onSnapshot error", e.message));
}
