// 見積もりカード — 案件詳細（対応記録タブの先頭）
//
// できること:
//   ・その案件に紐づく見積もり（quotes）を版が新しい順に一覧表示
//   ・見積もりが無い案件で、スタッフが最初の見積もりを作る（staffCreateQuote）
//   ・各版の「見積書を表示」から /quote-print.html を開き、閲覧・印刷・PDF保存・事業所へ送付ができる
//   ・PDFを開く（保存済みの場合）
//   ・事業所へ再送（Cloud Functions の resendQuoteMail を呼ぶ。Storage の保存済みPDFを添付して送る）
//   ・電話・メール・FAX で受けた申込を「受注確定」にする（staffAcceptQuote。設計 §5 A）
//   ・承諾書のサイン＝発注（2026-11-12・スイッチ orderByConsent がオンのとき）: 上の「受注確定にする」の代わりに
//     「承諾書を印刷」「署名済みの承諾書を受け取った（受注確定にする）」を出す。受注後に見積もりを直して
//     承諾書の取り直しが要る案件（cases.orderConsentStale）には「取り直した承諾書を受け取った」を出す
//
// 設計の要:
//   ・見積もりは事業所側（mitsumori.html）でも、スタッフ（このカード）でも作れる。
//     どちらで作っても quotes の形は同じ（createdVia が "web" / "staff" で区別）
//   ・金額はこの画面では計算しない（サーバの staffCreateQuote / reviseQuote が正）。
//     一覧・見積書はすべて quotes.amounts をそのまま表示する
//   ・quotes は caseId で onSnapshot 購読し、version 降順（新しい版が先頭）で並べる
//   ・品番→表示名は products コレクション（doc id = sku）を一度だけ読み込み、name と
//     connectionLabel(product) を併記する。取得できない品番はそのまま sku を出す

import { normalizeEmail } from "/js/normalize.js";
import {
  collection, query, where, onSnapshot, getDocs, doc, getDoc, setDoc, isPracticeMode, isPracticeRef,
} from "/js/fs.js";
import { httpsCallable } from "/js/fn.js";
import { connectionLabel, findProduct } from "/js/product-label.js";
import { todayYmdJst, ACCEPT_CHANNELS, PAY_METHODS, buildGroupChoices, buildAcceptPayload,
  summarizeAcceptResult, acceptMailTo } from "/js/screen-rules.js";
// ご案内メール・見積書PDFの送付の記録（設計書 CRM改善_設計書_20261110 §3 点検8・2026-11-10）
import { quoteMailNotesOf } from "/js/record-gaps.js";
import { orderConsentNoticeOf } from "/js/record-gaps.js"; // 承諾書の取り直し（2026-11-12）
// 見積もり必須・承諾書のサイン＝発注（2026-11-12・設定 appConfig/settings.orderByConsent がオンのときだけ画面が変わる）
import { RECEIVED_VIA_OPTIONS, buildPaperConsentPayload, buildOrderConsentPrintHtml, orderConsentLine } from "/js/order-consent.js";
import { CONSENT_DOCUMENT } from "/js/consent-document.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let ctx = null;         // { db, caseId, getCase, toast, userName, functions, orderByConsent?: () => boolean, onSettingsChanged?: () => void }
let orderConsentRec = null; // この案件の発注の承諾書（cases.orderConsentToken が指す consentRequests。無ければ null）
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
    return `<a class="btn btn-secondary" href="${esc(q.pdfUrl)}" data-tip="保存済みの見積書 PDF を新しいタブで開きます。" target="_blank" rel="noopener"><i class="ti ti-file-text" aria-hidden="true"></i> PDFを開く</a>`;
  }
  return `<span style="font-size:12px;color:var(--color-ink-muted)">PDF未保存（下の「見積書を表示」からPDFを作れます）</span>`;
}

function quoteDocBtn(q) {
  return `<a class="btn btn-secondary" href="/quote-print.html?quote=${esc(q._id)}" target="_blank" rel="noopener" data-tip="見積書を新しいタブで開きます。印刷・PDF の保存・事業所への送付は、その画面で行います。">
    <i class="ti ti-file-description" aria-hidden="true"></i> 見積書を表示
  </a>`;
}

// メール送付の記録（ご案内メール・見積書PDF）。どの画面にも出ていなかった（2026-11-10 点検8）
function mailNotesLine(q) {
  const notes = quoteMailNotesOf(q);
  if (!notes.length) return "";
  return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px">${notes.map((n) =>
    `<span style="font-size:12px;color:${n.warn ? "var(--color-danger)" : "var(--color-ink-muted)"}"><i class="ti ti-mail${n.warn ? "-x" : "-check"}" aria-hidden="true"></i> ${esc(n.text)}</span>`).join("")}</div>`;
}

function createdMetaLine(q) {
  const via = q.createdVia === "staff" ? "スタッフ作成" : q.createdVia === "web" ? "Web作成" : (q.createdVia || "—");
  const by = q.createdVia === "staff" && q.createdBy ? `（${esc(q.createdBy)}）` : "";
  return `<span style="font-size:12px;color:var(--color-ink-muted)">作成: ${esc(via)}${by}</span>`;
}

// 「内容を変更する」ボタン。出荷が下書きのうちだけ出す（確定後は供給管理の「出荷の修正」で直す）
function reviseBtn(q, isLatest) {
  if (!isLatest) return "";
  if (q.status === "superseded" || q.status === "expired") return "";
  return `<button class="btn btn-secondary" data-revise-id="${esc(q._id)}" data-tip="台数・機種を変える画面を開きます。保存すると新しい版になり、前の版は記録として残ります。">
    <i class="ti ti-edit" aria-hidden="true"></i> 内容を変更する
  </button>`;
}

// 事業所へ送付する操作。PDFが無いと送りようがないので、無いときは「見積書を表示」へ誘導する
function resendBtn(q) {
  if (!q.pdfPath) {
    return `<a class="btn btn-secondary" href="/quote-print.html?quote=${esc(q._id)}" target="_blank" rel="noopener" data-tip="見積書を新しいタブで開きます。PDF の保存と事業所への送付は、その画面で行います。">
      <i class="ti ti-send" aria-hidden="true"></i> 見積書を表示してPDFを送付
    </a>`;
  }
  const busy = sendingIds.has(q._id);
  const label = q.mailedAt ? "事業所へ再送" : "事業所へ送付";
  return `<button class="btn btn-secondary" data-resend-id="${esc(q._id)}" data-tip="保存済みの見積書 PDF を、案件のメール宛てに事務局から送ります。送った記録は対応記録に残り、取り消せません。" ${busy ? "disabled" : ""}>
    <i class="ti ti-send" aria-hidden="true"></i> ${busy ? "送信中..." : label}
  </button>`;
}

// スイッチ（appConfig/settings.orderByConsent）。練習モードでは練習DBの設定（case-detail.js が読んだ appSettings）
function orderOn() { return !!(ctx && typeof ctx.orderByConsent === "function" && ctx.orderByConsent()); }

function isExpired(q) {
  const d = q.validUntil?.toDate ? q.validUntil.toDate() : (q.validUntil ? new Date(q.validUntil) : null);
  return !!(d && !Number.isNaN(d.getTime()) && d.getTime() < Date.now());
}

// 「受注確定にする」ボタン。最新版で発行済み（issued）のときだけ出す。
// 文言に「確定」を含むので、閲覧のみ（viewer）の人には role.js の applyViewerMode が自動で無効化する。
function acceptBtn(q, isLatest) {
  if (orderOn()) return consentBtns(q, isLatest);
  if (!isLatest || q.status !== "issued") return "";
  const expiredNote = isExpired(q)
    ? `<span style="font-size:12px;color:#8a5a1f">有効期限を過ぎています。申込を受けた日（受付日）が有効期限内のときだけ確定できます</span>`
    : "";
  return `<button class="btn btn-primary" data-accept-id="${esc(q._id)}" data-tip="電話・メール・FAX などで受けた申込を記録する画面を開きます。そこで確定すると出荷の下書きができ、Chat に知らせが出ます。" type="button">
    <i class="ti ti-circle-check" aria-hidden="true"></i> 受注確定にする（電話・メールで申込を受けた）
  </button>${expiredNote}`;
}

// 承諾書のサイン＝発注（スイッチがオンのとき）。発行中の最新版: 「承諾書を印刷」「署名済みの承諾書を受け取った（受注確定にする）」。
// 受注後に直して取り直しが要る最新版（承諾済み）: 「承諾書を印刷（取り直し）」「取り直した承諾書を受け取った」。
// 文言に「受注確定」「受け取った」を含むので、閲覧のみ（viewer）の人には role.js の applyViewerMode が無効化する（「確定」を含む）。
function consentBtns(q, isLatest) {
  if (!isLatest) return "";
  const kase = ctx.getCase ? ctx.getCase() : {};
  if (q.status === "issued") {
    const expiredNote = isExpired(q)
      ? `<span style="font-size:12px;color:#8a5a1f">有効期限を過ぎています。承諾書を受け取った日が有効期限内のときだけ確定できます</span>`
      : "";
    return `<button class="btn btn-secondary" data-print-consent-id="${esc(q._id)}" type="button" data-tip="この見積もりの見積番号・版・品目・台数・金額を載せた承諾書（発注書を兼ねます）を新しいタブで開きます。まとめ見積もりは全事業所を1枚に載せます。印刷してもデータは変わりません。">
      <i class="ti ti-printer" aria-hidden="true"></i> 承諾書を印刷
    </button>
    <button class="btn btn-primary" data-paper-accept-id="${esc(q._id)}" type="button" data-tip="署名済みの承諾書を受け取ったときに使います。署名者のお名前・受け取った日・受け取り方を入れる画面を開き、そこで確定すると承諾書の記録と受注確定が同時に入ります（出荷の下書きができ、Chat に知らせが出ます）。">
      <i class="ti ti-circle-check" aria-hidden="true"></i> 署名済みの承諾書を受け取った（受注確定にする）
    </button>${expiredNote}`;
  }
  if (q.status === "accepted" && kase && kase.orderConsentStale === true) {
    return `<button class="btn btn-secondary" data-print-consent-id="${esc(q._id)}" data-reconsent="1" type="button" data-tip="直したあとの見積もり（この版）で、承諾書を新しいタブで開きます。印刷してもデータは変わりません。">
      <i class="ti ti-printer" aria-hidden="true"></i> 承諾書を印刷（取り直し）
    </button>
    <button class="btn btn-primary" data-reconsent-id="${esc(q._id)}" type="button" data-tip="取り直した承諾書（この版）の署名者のお名前・受け取った日を記録します。前の承諾書は記録として残り、出荷・受注は変わりません。">
      <i class="ti ti-file-check" aria-hidden="true"></i> 取り直した承諾書を受け取った（記録する）
    </button>`;
  }
  return "";
}

function rowHtml(q, isLatest) {
  const plan = PLAN_LABELS[q.plan] || q.plan || "—";
  const expiredTag = isExpired(q) && q.status !== "superseded"
    ? `<span class="badge" style="background:#FFF3E0;color:#8a5a1f">期限切れ</span>` : "";
  return `
    <div style="padding:14px 0;border-top:1px solid var(--color-border);${isLatest ? "" : "opacity:.75"}">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
        <strong style="font-size:13.5px">v${esc(q.version ?? "—")}</strong>
        <span style="font-size:13px;color:var(--color-ink-muted)">${esc(q.estNo || "")}</span>
        ${statusBadge(q.status)}
        ${expiredTag}
        <span style="font-size:12px;color:var(--color-ink-muted)">発行日 ${esc(ymdJst(q.createdAt)) || "—"}</span>
        <span style="font-size:12px;color:var(--color-ink-muted)">プラン: ${esc(plan)}</span>
      </div>
      <div style="font-size:13px;margin-bottom:8px">${itemsLine(q.items)}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin-bottom:8px">
        <span>合計（税込） <strong>${yen(q.amounts?.totalIncl)}</strong></span>
        <span>自己負担 <strong>${yen(q.amounts?.selfPay)}</strong></span>
        <span style="color:var(--color-ink-muted)">有効期限 ${esc(ymdJst(q.validUntil)) || "—"}</span>
      </div>
      ${mailNotesLine(q)}
      <div style="margin-bottom:10px">${createdMetaLine(q)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${quoteDocBtn(q)}
        ${pdfCell(q)}
        ${resendBtn(q)}
        ${reviseBtn(q, isLatest)}
        ${acceptBtn(q, isLatest)}
      </div>
    </div>`;
}

// 「見積もりを作る」ボタン。見積もりが1件も無い案件では主ボタンとして目立たせる
function createQuoteBtn(prominent) {
  return prominent
    ? `<button class="btn btn-primary" id="createQuoteBtn" data-tip="台数・機種を選んで、この案件の見積もりを作る画面を開きます。" type="button" style="font-size:13.5px">
        <i class="ti ti-file-plus" aria-hidden="true"></i> 見積もりを作る
      </button>`
    : `<button class="btn btn-secondary" id="createQuoteBtn" data-tip="台数・機種を選んで、この案件の見積もりを作る画面を開きます。" type="button">
        <i class="ti ti-file-plus" aria-hidden="true"></i> 見積もりを作る
      </button>`;
}

// 同一法人の複数事業所を「まとめて」見積もった案件では、法人あての合計見積書を開くボタンを出す。
// 所属は案件（quoteGroupId）で判定し、無ければ見積もり側の groupId（Web作成時に焼き込まれる）
function groupDocBtn(latest) {
  const gid = ctx?.getCase?.()?.quoteGroupId || latest?.groupId || "";
  if (!gid) return "";
  const caseParam = ctx?.caseId ? `&case=${encodeURIComponent(ctx.caseId)}` : "";
  return `<a class="btn btn-secondary" href="/quote-group-print.html?group=${encodeURIComponent(gid)}${caseParam}" target="_blank" rel="noopener"
             data-tip="同じ法人の事業所ぶんをまとめた合計見積書を、新しいタブで開きます。">
    <i class="ti ti-building-community" aria-hidden="true"></i> 合計見積書（法人まとめ）
  </a>`;
}

function render() {
  const host = document.getElementById("quoteCard");
  if (!host) return;

  const latest = quotes[0] || null;
  const bodyHtml = quotes.length
    ? quotes.map((q, i) => rowHtml(q, i === 0)).join("")
    : `<p style="font-size:13px;color:var(--color-ink-muted);margin:0 0 12px">見積もりはまだありません。電話などで受けた相談から、ここで最初の見積もりを作れます。</p>`;

  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:14px">見積もり</span>
        ${latest ? statusBadge(latest.status) : ""}
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${quotes.length ? groupDocBtn(latest) : ""}
          ${quotes.length && latest?.status !== "accepted" ? createQuoteBtn(false) : ""}
        </span>
      </div>
      <div class="card-body">
        ${orderConsentHtml()}
        ${practiceToggleHtml()}
        ${!quotes.length ? createQuoteBtn(true) : ""}
        ${bodyHtml}
      </div>
    </div>`;

  wire();
}

// 発注の承諾書（署名者・日付・方法・見積番号と版）と、取り直しのお知らせ。スイッチが切れていても、記録があれば出す
function orderConsentHtml() {
  const kase = ctx.getCase ? ctx.getCase() : {};
  const notice = orderConsentNoticeOf(kase);
  const line = orderConsentLine(orderConsentRec);
  if (!line && !notice) return "";
  const url = kase?.orderConsentToken ? `/consent?t=${encodeURIComponent(kase.orderConsentToken)}${isPracticeMode() ? "&p=1" : ""}` : "";
  return `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
    ${line ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;background:#E8F3EC;border-radius:8px;padding:8px 10px">
      <span><i class="ti ti-signature" aria-hidden="true"></i> <strong>発注の承諾書</strong> ${esc(line.displayNo)}${line.retake ? "（取り直し）" : ""}</span>
      <span style="color:var(--color-ink-muted)">${esc(line.text)}</span>
      ${url ? `<a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener" data-tip="発注の承諾書（署名済み）を新しいタブで開きます。印刷もできます。データは変わりません。" style="margin-left:auto"><i class="ti ti-external-link" aria-hidden="true"></i> 承諾書を開く</a>` : ""}
    </div>` : ""}
    ${notice ? `<div role="status" style="font-size:12.5px;color:#8a5a1f;background:#FFF4E0;border:1px solid #E8B86A;border-radius:8px;padding:8px 10px"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${esc(notice.text)}</div>` : ""}
  </div>`;
}

// 練習モードだけ: 新しい流れ（承諾書のサイン＝発注）を練習DBの設定で入れたり切ったりする。本番の設定は読まない・変えない
function practiceToggleHtml() {
  if (!isPracticeMode()) return "";
  const on = orderOn();
  return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;background:#FFF4C2;border:1px solid #C99A00;border-radius:8px;padding:6px 10px;margin-bottom:10px">
    <span>練習：承諾書のサイン＝発注の流れは <strong>${on ? "オン" : "オフ"}</strong>（練習用の設定。本番の設定とは別です）</span>
    <button class="btn btn-secondary" id="practiceOrderToggle" type="button" style="margin-left:auto" data-tip="練習用の設定だけを切り替えて、画面を読み込み直します。本番の設定は変わりません。練習DBを初期化すると切れた状態に戻ります。">${on ? "練習の流れを切る" : "練習で新しい流れを試す"}</button>
  </div>`;
}

async function togglePracticeOrder() {
  if (!isPracticeMode()) return;
  const ref = doc(ctx.db, "appConfig", "settings");
  if (!isPracticeRef(ref)) { alert("練習DBに切り替わっていないため、切り替えませんでした"); return; } // 本番の設定は変えない
  const on = !orderOn();
  try {
    await setDoc(ref, { orderByConsent: on, orderByConsentFrom: on ? todayYmdJst() : null }, { merge: true });
    ctx.toast(on ? "練習用の設定で、新しい流れ（承諾書のサイン＝発注）を入れました" : "練習用の設定で、新しい流れを切りました");
    setTimeout(() => location.reload(), 500);
  } catch (e) { alert(`切り替えに失敗しました: ${e.message || e}`); }
}

async function loadOrderConsent() {
  const kase = ctx.getCase ? ctx.getCase() : {};
  const token = kase?.orderConsentToken;
  orderConsentRec = null;
  if (!token) return;
  try {
    const snap = await getDoc(doc(ctx.db, "consentRequests", String(token)));
    orderConsentRec = snap.exists() ? { _id: snap.id, ...snap.data() } : null;
  } catch (e) { console.warn("quote card: order consent load failed", e.message); }
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
  host.querySelectorAll("[data-accept-id]").forEach((btn) => {
    btn.addEventListener("click", () => openAccept(btn.getAttribute("data-accept-id")));
  });
  host.querySelectorAll("[data-print-consent-id]").forEach((btn) => {
    btn.addEventListener("click", () => printConsent(btn.getAttribute("data-print-consent-id"), btn.hasAttribute("data-reconsent")));
  });
  host.querySelectorAll("[data-paper-accept-id]").forEach((btn) => {
    btn.addEventListener("click", () => openAccept(btn.getAttribute("data-paper-accept-id"), { paper: true }));
  });
  host.querySelectorAll("[data-reconsent-id]").forEach((btn) => {
    btn.addEventListener("click", () => openAccept(btn.getAttribute("data-reconsent-id"), { paper: true, reconsent: true }));
  });
  document.getElementById("practiceOrderToggle")?.addEventListener("click", togglePracticeOrder);
  const cancel = document.getElementById("reviseCancel");
  if (cancel) cancel.addEventListener("click", closeRevise);
  const submit = document.getElementById("reviseSubmit");
  if (submit) submit.addEventListener("click", submitRevise);
  const createBtn = document.getElementById("createQuoteBtn");
  if (createBtn) createBtn.addEventListener("click", openCreate);
}

async function resend(quoteId) {
  if (!quoteId || sendingIds.has(quoteId)) return;
  sendingIds.add(quoteId);
  render();
  try {
    const resendQuoteMail = httpsCallable(ctx.functions, "resendQuoteMail");
    // 宛先は案件のいまのメールを渡す（「連絡先を直す」で直したあとに、見積もりに残る旧メールへ送らないため。2026-11-02）
    const to = (ctx.getCase ? ctx.getCase() : {})?.contactEmail || "";
    await resendQuoteMail(to ? { quoteId, to } : { quoteId });
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
          <button class="btn btn-secondary" id="reviseCancel" data-tip="やめて閉じます。見積もりは変わりません。">やめる</button>
          <button class="btn btn-primary" id="reviseSubmit" data-tip="新しい版の見積もりを作り、前の版は旧版として残します。出荷の下書きがあれば同じ内容に作り直し、チェックを入れていれば事業所へメールで知らせます。">この内容で変更する</button>
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

// ---- 見積もりを作る（スタッフが電話等で受けた相談から最初の見積もりを作成）----
// フォームは改版モーダルと同じ構成を再利用する（プラン・BT/USB台数・USB接続口・メモ・メール送付）。
// 金額はここでは計算しない（サーバの staffCreateQuote が計算し、結果をトーストで返す）。
function openCreate() {
  const kase = ctx.getCase ? ctx.getCase() : {};
  const contactEmail = normalizeEmail(kase?.contactEmail || kase?.email);
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail);
  const host = document.getElementById("reviseModalHost");
  host.innerHTML = `
    <div class="modal-overlay open" id="createModal">
      <div class="modal" style="width:min(520px,95vw)">
        <div class="modal-header">
          <h3 style="font-size:15px;margin:0">見積もりを作る</h3>
        </div>
        <div class="modal-body" style="display:grid;gap:14px">
          <p style="font-size:12.5px;color:var(--color-ink-muted);line-height:1.8;margin:0">
            電話などで受けたご相談から、最初の見積もりを作ります。金額はこの画面では計算せず、確定額は保存時にサーバで計算します。
          </p>
          <div>
            <label class="form-label" for="cqPlan">プラン</label>
            <select class="form-control" id="cqPlan">
              <option value="houmon">訪問・通所・短期滞在系（最大3台）</option>
              <option value="kyojyu">居住・入所系（最大2台）</option>
              <option value="other">その他（最大1台）</option>
            </select>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label class="form-label" for="cqBt">CIR415A（Bluetooth）補助対象</label>
              <select class="form-control" id="cqBt">${qtyOptions(3, 1)}</select>
            </div>
            <div>
              <label class="form-label" for="cqBtx">同・追加（自己負担）</label>
              <select class="form-control" id="cqBtx">${qtyOptions(10, 0)}</select>
            </div>
            <div>
              <label class="form-label" for="cqUsb">CIR315A（USB）補助対象</label>
              <select class="form-control" id="cqUsb">${qtyOptions(3, 0)}</select>
            </div>
            <div>
              <label class="form-label" for="cqUsbx">同・追加（自己負担）</label>
              <select class="form-control" id="cqUsbx">${qtyOptions(10, 0)}</select>
            </div>
          </div>
          <div>
            <label class="form-label" for="cqConn">USBの口の形</label>
            <select class="form-control" id="cqConn">
              <option value="" selected>未定（Type-A で手配）</option>
              <option value="A">Type-A（四角い口）</option>
              <option value="C">Type-C（小さい楕円）</option>
            </select>
          </div>
          <div>
            <label class="form-label" for="cqNote">メモ（任意）</label>
            <input class="form-control" id="cqNote" placeholder="例: 〇月〇日 電話でのご相談を受けて作成">
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:44px">
            <input type="checkbox" id="cqMail" ${hasEmail ? "checked" : "disabled"}> 見積もりの内容を事業所へメールで知らせる
          </label>
          ${!hasEmail ? `<p style="font-size:12.5px;color:var(--color-primary);margin:0">案件にメールアドレスがありません（送付するには先に案件へ登録してください）</p>` : ""}
          <p id="cqError" style="display:none;color:var(--color-primary);font-size:12.5px;margin:0;line-height:1.7"></p>
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-secondary" id="createCancel" data-tip="やめて閉じます。見積もりは作りません。">やめる</button>
          <button class="btn btn-primary" id="createSubmit" data-tip="見積もりを作り、対応記録に残します。チェックを入れていれば、内容を事業所へメールで知らせます（PDF はまだ作りません）。">この内容で見積もりを作る</button>
        </div>
      </div>
    </div>`;
  document.getElementById("createCancel").addEventListener("click", closeCreate);
  document.getElementById("createSubmit").addEventListener("click", submitCreate);
  document.getElementById("createModal").addEventListener("click", (e) => {
    if (e.target.id === "createModal") closeCreate();
  });
}

function closeCreate() {
  const host = document.getElementById("reviseModalHost");
  if (host) host.innerHTML = "";
}

async function submitCreate() {
  const err = document.getElementById("cqError");
  const show = (m) => { err.textContent = m; err.style.display = "block"; };
  const num = (id) => Number(document.getElementById(id).value) || 0;
  const plan = document.getElementById("cqPlan").value;
  const bt = num("cqBt"), usb = num("cqUsb");
  if (bt + usb < 1) { show("補助対象のカードリーダーを1台以上にしてください"); return; }
  if (bt + usb > (PLAN_MAX[plan] || 1)) { show(`このプランの補助対象は最大${PLAN_MAX[plan]}台です`); return; }
  const btn = document.getElementById("createSubmit");
  btn.disabled = true; btn.textContent = "作成中...";
  try {
    const fn = httpsCallable(ctx.functions, "staffCreateQuote");
    const r = await fn({
      caseId: ctx.caseId, plan, btQty: bt, usbQty: usb,
      btExtra: num("cqBtx"), usbExtra: num("cqUsbx"),
      usbConnector: document.getElementById("cqConn").value || null,
      note: (document.getElementById("cqNote").value || "").trim(),
      sendMail: document.getElementById("cqMail").checked,
    });
    const d = r.data || {};
    closeCreate();
    ctx.toast(`見積もり ${d.estNo || ""} を作成しました`
      + (d.mailed ? "。事業所へメールを送りました" : ""));
  } catch (e) {
    show(e.message || String(e));
    btn.disabled = false; btn.textContent = "この内容で見積もりを作る";
  }
}

// ---- 受注確定（電話・メール・FAX で受けた申込）----
// サーバの staffAcceptQuote が正（拒否条件は functions/accept-rules.js の checkStaffAccept）。
// 画面では入力の形だけ確かめ、サーバのエラー文はそのまま見せる。
let accepting = null;      // モーダルを開いている見積もり
let acceptBusy = false;    // 二重押し防止

// 同じグループの見積もりは「選んだ見積もりの groupId」で引く（2026-10-21 レビュー指摘）。
// 案件の quoteGroupId は別の版・別のグループを指していることがあるので使わない。groupId が無ければ一覧を出さない
async function loadGroupChoices(q) {
  const gid = q.groupId || "";
  if (!gid) return [];
  try {
    const snap = await getDocs(query(collection(ctx.db, "quotes"), where("groupId", "==", gid)));
    return buildGroupChoices(snap.docs.map((d) => ({ _id: d.id, ...d.data() })), q);
  } catch (e) {
    console.warn("quote card: group quotes load failed", e.message);
    return null;   // 読めなかった（一覧は出さず、その旨を表示）
  }
}

let acceptMode = { paper: false, reconsent: false }; // 承諾書の受け取り（スイッチがオンのとき）か、従来の受注確定か

async function openAccept(quoteId, opts = {}) {
  const q = quotes.find((x) => x._id === quoteId);
  if (!q) return;
  accepting = q;
  acceptBusy = false;
  acceptMode = { paper: !!opts.paper, reconsent: !!opts.reconsent };
  if (acceptMode.paper) { await openPaperAccept(q); return; }
  const kase = ctx.getCase ? ctx.getCase() : {};
  // 確認メールの宛先はサーバと同じ規則（案件の contactEmail → 無ければ見積もりの contactEmail）
  const hasEmail = !!acceptMailTo(kase?.contactEmail, q.contactEmail);
  const today = todayYmdJst();
  const host = document.getElementById("reviseModalHost");
  host.innerHTML = `
    <div class="modal-overlay open" id="acceptModal">
      <div class="modal" style="width:min(560px,95vw)">
        <div class="modal-header">
          <h3 style="font-size:15px;margin:0">受注確定にする（${esc(q.estNo || "")} v${esc(q.version ?? "—")}）</h3>
        </div>
        <div class="modal-body" style="display:grid;gap:14px" id="acBody">
          <p style="font-size:12.5px;color:var(--color-ink-muted);line-height:1.8;margin:0">
            電話・メール・FAX などで、この見積もりへのお申し込みを受けたときに使います。
            Web でのお申し込みと同じく、出荷の下書きを作ります（同意のチェックは記録しません）。
          </p>
          ${isExpired(q) ? `<p style="font-size:12.5px;color:#8a5a1f;margin:0;line-height:1.7">この見積もりは有効期限（${esc(ymdJst(q.validUntil))}）を過ぎています。受付日が有効期限内のときだけ確定できます。</p>` : ""}
          <div>
            <label class="form-label" for="acName">申込者のお名前<span style="color:var(--color-primary)">必須</span></label>
            <input class="form-control" id="acName" placeholder="例: 山田 花子（管理者）" maxlength="100">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label class="form-label" for="acChannel">受付方法</label>
              <select class="form-control" id="acChannel">
                ${ACCEPT_CHANNELS.map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join("")}
              </select>
            </div>
            <div>
              <label class="form-label" for="acDate">受付日</label>
              <input class="form-control" id="acDate" type="date" value="${today}" max="${today}">
            </div>
            <div>
              <label class="form-label" for="acPay">お支払い</label>
              <select class="form-control" id="acPay">
                ${PAY_METHODS.map((p) => `<option value="${p.value}">${esc(p.label)}</option>`).join("")}
              </select>
            </div>
            <div>
              <label class="form-label" for="acPreferred">ご希望日（任意）</label>
              <input class="form-control" id="acPreferred" type="date">
            </div>
          </div>
          <div>
            <label class="form-label" for="acNote">メモ（任意）</label>
            <input class="form-control" id="acNote" placeholder="例: 10/21 電話で管理者さまから申込。発送先は事業所あて">
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:44px">
            <input type="checkbox" id="acMail" ${hasEmail ? "checked" : "disabled"}> お申し込みの確認メールを事業所へ送る
          </label>
          ${!hasEmail ? `<p style="font-size:12.5px;color:var(--color-ink-muted);margin:0">案件・見積もりにメールアドレスがないため、確認メールは送れません。</p>` : ""}
          <div id="acGroup"></div>
          <p id="acError" role="alert" style="display:none;color:var(--color-primary);font-size:12.5px;margin:0;line-height:1.7;white-space:pre-wrap"></p>
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end" id="acFooter">
          <button class="btn btn-secondary" id="acceptCancel" data-tip="やめて閉じます。受注確定にはしません。" type="button">やめる</button>
          <button class="btn btn-primary" id="acceptSubmit" data-tip="見積もりを申し込み済みにして出荷の下書きを作り、状態が受注前なら受注確定にします。Chat に知らせが出て、チェックを入れていれば確認メールも送ります。" type="button">受注確定にする</button>
        </div>
      </div>
    </div>`;
  document.getElementById("acceptCancel").addEventListener("click", closeAccept);
  document.getElementById("acceptSubmit").addEventListener("click", submitAccept);
  document.getElementById("acceptModal").addEventListener("click", (e) => {
    if (e.target.id === "acceptModal" && !acceptBusy) closeAccept();
  });

  // 同じグループ（法人まとめ）の他の事業所。既定は全部オン
  const gwrap = document.getElementById("acGroup");
  if (q.groupId) {
    gwrap.innerHTML = `<p style="font-size:12px;color:var(--color-ink-muted);margin:0"><i class="ti ti-loader-2 ti-spin" aria-hidden="true"></i> 同じ法人の事業所を確認しています...</p>`;
    const choices = await loadGroupChoices(q);
    if (accepting !== q) return;   // 読み込み中に閉じられた
    if (choices === null) {
      gwrap.innerHTML = `<p style="font-size:12px;color:var(--color-primary);margin:0">同じ法人の事業所を読み込めませんでした。この事業所だけを確定します。</p>`;
    } else if (!choices.length) {
      gwrap.innerHTML = "";
    } else {
      gwrap.innerHTML = `
        <fieldset style="border:1px solid var(--color-border);border-radius:8px;padding:10px 12px;margin:0">
          <legend style="font-size:13px;font-weight:600;padding:0 4px">同じ法人の事業所もまとめて確定する</legend>
          ${choices.map((c) => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:40px">
              <input type="checkbox" class="ac-group" value="${esc(c.quoteId)}" ${c.checked ? "checked" : ""}> ${esc(c.label)}
            </label>`).join("")}
          <p style="font-size:12px;color:var(--color-ink-muted);margin:4px 0 0">発行済みで最新の版の見積もりだけを出しています。外した事業所は確定しません。</p>
        </fieldset>`;
    }
  }
}

// ---- 署名済みの承諾書を受け取った（受注確定にする）／取り直した承諾書を受け取った（2026-11-12）----
// サーバーの staffAcceptQuote が承諾書の記録と受注確定を1つの処理で作る（判定は functions/accept-rules.js の checkOrderConsent）。
async function openPaperAccept(q) {
  const kase = ctx.getCase ? ctx.getCase() : {};
  const re = acceptMode.reconsent;
  const hasEmail = !!acceptMailTo(kase?.contactEmail, q.contactEmail);
  const today = todayYmdJst();
  const submitTip = re
    ? "取り直した承諾書を記録し、承諾書の取り直しのお知らせを消します。出荷・受注は変わりません。対応記録に残ります。"
    : "承諾書の記録と受注確定を同時に入れます（見積もりを申し込み済みにし、出荷の下書きを作り、受注前なら状態を受注確定に）。Chat に知らせが出て、チェックを入れていれば確認メールも送ります。どちらか片方だけが入ることはありません。";
  const host = document.getElementById("reviseModalHost");
  host.innerHTML = `
    <div class="modal-overlay open" id="acceptModal">
      <div class="modal" style="width:min(560px,95vw)">
        <div class="modal-header">
          <h3 style="font-size:15px;margin:0">${re ? "取り直した承諾書を受け取った" : "署名済みの承諾書を受け取った（受注確定にする）"}（${esc(q.estNo || "")} v${esc(q.version ?? "—")}）</h3>
        </div>
        <div class="modal-body" style="display:grid;gap:14px" id="acBody">
          <p style="font-size:12.5px;color:var(--color-ink-muted);line-height:1.8;margin:0">
            ${re
              ? "受注のあとで見積もりを直したため、この版で承諾書を取り直したときに使います。前の承諾書は記録として残ります。出荷・受注の内容は変わりません。"
              : "「承諾書を印刷」で渡した承諾書（発注書を兼ねます）に、事業所の方が署名して戻してくださったときに使います。承諾書の記録と受注確定を同時に入れ、出荷の下書きを作ります。"}
            承諾書に書かれた見積番号・版が、この見積もり（${esc(q.estNo || "")} 第${esc(q.version ?? "—")}版）と同じか確かめてください。
          </p>
          ${!re && isExpired(q) ? `<p style="font-size:12.5px;color:#8a5a1f;margin:0;line-height:1.7">この見積もりは有効期限（${esc(ymdJst(q.validUntil))}）を過ぎています。承諾書を受け取った日が有効期限内のときだけ確定できます。</p>` : ""}
          <div>
            <label class="form-label" for="acName">承諾書に署名した方のお名前<span style="color:var(--color-primary)">必須</span></label>
            <input class="form-control" id="acName" placeholder="例: 山田 花子（管理者）" maxlength="100">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label class="form-label" for="acDate">承諾書を受け取った日<span style="color:var(--color-primary)">必須</span></label>
              <input class="form-control" id="acDate" type="date" value="${today}" max="${today}">
            </div>
            <div>
              <label class="form-label" for="acVia">受け取り方</label>
              <select class="form-control" id="acVia">
                ${RECEIVED_VIA_OPTIONS.map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join("")}
              </select>
            </div>
            ${re ? "" : `<div>
              <label class="form-label" for="acPay">お支払い</label>
              <select class="form-control" id="acPay">
                ${PAY_METHODS.map((p) => `<option value="${p.value}">${esc(p.label)}</option>`).join("")}
              </select>
            </div>
            <div>
              <label class="form-label" for="acPreferred">ご希望日（任意）</label>
              <input class="form-control" id="acPreferred" type="date">
            </div>`}
          </div>
          ${re ? "" : `<div>
            <label class="form-label" for="acNote">メモ（任意）</label>
            <input class="form-control" id="acNote" placeholder="例: 11/12 FAXで受領。発送先は事業所あて">
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:44px">
            <input type="checkbox" id="acMail" ${hasEmail ? "checked" : "disabled"}> お申し込みの確認メールを事業所へ送る
          </label>
          ${!hasEmail ? `<p style="font-size:12.5px;color:var(--color-ink-muted);margin:0">案件・見積もりにメールアドレスがないため、確認メールは送れません。</p>` : ""}`}
          <div id="acGroup"></div>
          <p id="acError" role="alert" style="display:none;color:var(--color-primary);font-size:12.5px;margin:0;line-height:1.7;white-space:pre-wrap"></p>
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end" id="acFooter">
          <button class="btn btn-secondary" id="acceptCancel" data-tip="やめて閉じます。何も記録しません。" type="button">やめる</button>
          <button class="btn btn-primary" id="acceptSubmit" type="button" data-tip="${esc(submitTip)}">${re ? "記録する" : "受注確定にする"}</button>
        </div>
      </div>
    </div>`;
  document.getElementById("acceptCancel").addEventListener("click", closeAccept);
  document.getElementById("acceptSubmit").addEventListener("click", submitAccept);
  document.getElementById("acceptModal").addEventListener("click", (e) => {
    if (e.target.id === "acceptModal" && !acceptBusy) closeAccept();
  });
  if (re || !q.groupId) return;
  // まとめ見積もり（発6）: 承諾書1枚で全事業所を受注確定にする。既定は全部オン
  const gwrap = document.getElementById("acGroup");
  gwrap.innerHTML = `<p style="font-size:12px;color:var(--color-ink-muted);margin:0"><i class="ti ti-loader-2 ti-spin" aria-hidden="true"></i> 同じ法人の事業所を確認しています...</p>`;
  const choices = await loadGroupChoices(q);
  if (accepting !== q) return;
  if (choices === null) {
    gwrap.innerHTML = `<p style="font-size:12px;color:var(--color-primary);margin:0">同じ法人の事業所を読み込めませんでした。この事業所だけを確定します。</p>`;
  } else if (!choices.length) {
    gwrap.innerHTML = "";
  } else {
    gwrap.innerHTML = `
      <fieldset style="border:1px solid var(--color-border);border-radius:8px;padding:10px 12px;margin:0">
        <legend style="font-size:13px;font-weight:600;padding:0 4px">承諾書に載っている同じ法人の事業所</legend>
        ${choices.map((c) => `
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:40px">
            <input type="checkbox" class="ac-group" value="${esc(c.quoteId)}" ${c.checked ? "checked" : ""}> ${esc(c.label)}
          </label>`).join("")}
        <p style="font-size:12px;color:var(--color-ink-muted);margin:4px 0 0">承諾書1枚に載っている事業所をすべて選んでください。選んだ事業所は1回でまとめて受注確定になります（1件でも確認に通らなければ、どれも確定しません）。</p>
      </fieldset>`;
  }
}

// 承諾書を印刷（見積番号・版・品目・台数・金額入り。まとめ見積もりは全事業所を1枚に）。データは変えない
async function printConsent(quoteId, reconsent = false) {
  const q = quotes.find((x) => x._id === quoteId);
  if (!q) return;
  const w = window.open("", "_blank"); // ポップアップを止められないよう、押したその場で開く
  if (!w) { alert("新しいタブを開けませんでした（ポップアップの許可を確かめてください）"); return; }
  let list = [q];
  if (!reconsent && q.groupId) {
    try {
      const snap = await getDocs(query(collection(ctx.db, "quotes"), where("groupId", "==", q.groupId)));
      const others = buildGroupChoices(snap.docs.map((d) => ({ _id: d.id, ...d.data() })), q).map((c) => c.quoteId);
      const byId = new Map(snap.docs.map((d) => [d.id, { _id: d.id, ...d.data() }]));
      list = [q, ...others.map((id) => byId.get(id)).filter(Boolean)];
    } catch (e) { console.warn("quote card: group quotes for consent print failed", e.message); }
  }
  const nameOf = (sku) => { const p = findProduct(sku, products); return (p && p.name) || sku; };
  w.document.open();
  w.document.write(buildOrderConsentPrintHtml({ document: CONSENT_DOCUMENT, quotes: list, printedYmd: todayYmdJst(), nameOf, practice: isPracticeMode() }));
  w.document.close();
}

function closeAccept() {
  if (acceptBusy) return;
  const host = document.getElementById("reviseModalHost");
  if (host) host.innerHTML = "";
  accepting = null;
}

async function submitAccept() {
  if (!accepting || acceptBusy) return;
  const err = document.getElementById("acError");
  const show = (m) => { err.textContent = m; err.style.display = "block"; };
  err.style.display = "none";
  const val = (id) => (document.getElementById(id)?.value || "");
  const built = acceptMode.paper ? buildPaperConsentPayload({
    quoteId: accepting._id,
    reconsent: acceptMode.reconsent,
    signedName: val("acName"),
    receivedDate: val("acDate"),
    receivedVia: val("acVia"),
    payMethod: val("acPay"),
    preferredDate: val("acPreferred"),
    note: val("acNote"),
    sendMail: !!document.getElementById("acMail")?.checked,
    groupQuoteIds: [...document.querySelectorAll("#acGroup .ac-group:checked")].map((x) => x.value),
  }, todayYmdJst()) : buildAcceptPayload({
    quoteId: accepting._id,
    acceptedName: val("acName"),
    channel: val("acChannel"),
    receivedDate: val("acDate"),
    payMethod: val("acPay"),
    preferredDate: val("acPreferred"),
    note: val("acNote"),
    sendMail: !!document.getElementById("acMail")?.checked,
    groupQuoteIds: [...document.querySelectorAll("#acGroup .ac-group:checked")].map((x) => x.value),
  }, todayYmdJst());
  if (built.error) { show(built.error); return; }

  const btn = document.getElementById("acceptSubmit");
  const cancel = document.getElementById("acceptCancel");
  acceptBusy = true;
  btn.disabled = true; btn.textContent = "確定中...";
  if (cancel) cancel.disabled = true;
  try {
    const fn = httpsCallable(ctx.functions, "staffAcceptQuote");
    const r = await fn(built.payload);
    if (acceptMode.reconsent) {
      acceptBusy = false;
      showReconsentResult(r.data || {});
      ctx.toast("取り直した承諾書を記録しました");
      return;
    }
    const sum = summarizeAcceptResult(r.data, { sendMail: built.payload.sendMail });
    if (r.data && r.data.displayNo) sum.consentNo = r.data.displayNo;
    acceptBusy = false;
    showAcceptResult(sum);
    if (sum.ok) {
      ctx.toast(`受注確定にしました（出荷番号 ${sum.soNumbers.join("・") || "—"}）`
        + (sum.mail === "sent" ? "。確認メールを送りました" : sum.mail === "failed" ? "。確認メールは送れませんでした" : ""));
    }
  } catch (e) {
    // サーバの拒否理由（期限切れ・受理済みなど）はそのまま見せる
    acceptBusy = false;
    show(e.message || String(e));
    btn.disabled = false; btn.textContent = acceptMode.reconsent ? "記録する" : "受注確定にする";
    if (cancel) cancel.disabled = false;
  }
}

function showReconsentResult(d) {
  const body = document.getElementById("acBody");
  const footer = document.getElementById("acFooter");
  if (!body || !footer) return;
  body.innerHTML = `
    <p style="font-size:14px;font-weight:600;margin:0;color:#1F7A4F"><i class="ti ti-circle-check" aria-hidden="true"></i> 取り直した承諾書を記録しました</p>
    <p style="font-size:13px;margin:0;line-height:1.8">承諾書: ${esc(d.displayNo || "")}。承諾書の取り直しのお知らせは消えます（画面を読み込み直すと反映されます）。</p>`;
  footer.innerHTML = `<button class="btn btn-secondary" id="acceptClose" data-tip="結果の表示を閉じ、画面を読み込み直します。" type="button">閉じる</button>`;
  document.getElementById("acceptClose").addEventListener("click", () => { closeAccept(); location.reload(); });
}

// 結果をモーダルの中に出す（出荷番号と、次にやること）。閉じるボタンだけにする
function showAcceptResult(sum) {
  const body = document.getElementById("acBody");
  const footer = document.getElementById("acFooter");
  if (!body || !footer) return;
  const soLinks = sum.soNumbers.map((so) =>
    `<a href="/supply.html?tab=shipments&so=${encodeURIComponent(so)}">${esc(so)}</a>`).join("・");
  body.innerHTML = `
    ${sum.ok ? `
      <p style="font-size:14px;font-weight:600;margin:0;color:#1F7A4F"><i class="ti ti-circle-check" aria-hidden="true"></i> 受注確定にしました</p>
      <p style="font-size:13px;margin:0;line-height:1.8">出荷番号: ${soLinks || "—"}</p>
      ${sum.consentNo ? `<p style="font-size:13px;margin:0;line-height:1.8"><i class="ti ti-signature" aria-hidden="true"></i> 承諾書の記録: ${esc(sum.consentNo)}（受注確定と同時に入れました。画面を読み込み直すと、見積もりカードの上に出ます）</p>` : ""}
      <p style="font-size:13px;margin:0;line-height:1.8"><strong>供給管理で出荷を依頼してください。</strong>（出荷の下書きができています）</p>
      ${sum.mail === "sent" ? `<p style="font-size:13px;margin:0;line-height:1.8"><i class="ti ti-mail-check" aria-hidden="true"></i> 事業所へ確認メールを送りました</p>` : ""}
      ${sum.mail === "failed" ? `
        <div id="acMailWarn" role="alert" style="font-size:13px;line-height:1.8;color:#8a5a1f;background:#FFF4E0;border:1px solid #E8B86A;border-radius:8px;padding:10px 12px">
          <strong><i class="ti ti-alert-triangle" aria-hidden="true"></i> 確認メールは送れていません</strong><br>${esc(sum.mailWarning)}
        </div>` : ""}`
    : `<p style="font-size:14px;font-weight:600;margin:0;color:var(--color-primary)">受注確定にできませんでした</p>`}
    ${sum.errors.length ? `
      <div style="font-size:12.5px;color:var(--color-primary);line-height:1.7">
        ${sum.partial ? "一部の事業所は確定できませんでした:<br>" : ""}
        ${sum.errors.map((m) => `・${esc(m)}`).join("<br>")}
      </div>` : ""}`;
  footer.innerHTML = `<button class="btn btn-secondary" id="acceptClose" data-tip="結果の表示を閉じます。何も変わりません。" type="button">閉じる</button>`;
  document.getElementById("acceptClose").addEventListener("click", closeAccept);
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
  await loadOrderConsent();

  if (unsub) { unsub(); unsub = null; }
  const q = query(collection(ctx.db, "quotes"), where("caseId", "==", ctx.caseId));
  unsub = onSnapshot(q, (qs) => {
    quotes = qs.docs
      .map((d) => ({ _id: d.id, ...d.data() }))
      .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
    render();
  }, (e) => console.warn("quote card: onSnapshot error", e.message));
}
