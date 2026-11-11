// 倉庫画面（2026-10-24 倉庫メニュー §3・§9）。倉庫の人は Firestore を直接読めないので、
// 表示も操作もすべて Callable（warehouseList / Ship / Handover / Reject / FixTracking）経由。
// 練習モードでは /js/fn.js が practice-stubs.js の代役に差し替える。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "/js/fs.js";
import { gateRole, showAccessDenied } from "/js/role.js";
import { getFunctions, httpsCallable } from "/js/fn.js";
import { ISSUE_REASONS, deliveryModeOf } from "/js/warehouse-rules.js";
import { STEP_LABEL, ACCEPT_DECISIONS, PACK_TYPES, packTypeDefault, sortByDesired } from "/js/ship-steps-rules.js";
import { FILTERS, buildRows, qtyOf, isUnconfirmed, filterRows, sortRows, sameDestCounts, sameDestOf, buildCsv, csvFileName } from "/js/warehouse-sheet.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");
const listFn = httpsCallable(functions, "warehouseList");
const shipFn = httpsCallable(functions, "warehouseShip");
const handoverFn = httpsCallable(functions, "warehouseHandover");
const rejectFn = httpsCallable(functions, "warehouseReject");
const fixFn = httpsCallable(functions, "warehouseFixTracking");
const confirmFn = httpsCallable(functions, "warehouseConfirm");
const noteFn = httpsCallable(functions, "warehouseSetNote");
const acceptFn = httpsCallable(functions, "warehouseAccept"); // 受付（発送可・入荷待ち・発送不可・2026-11-12）

const ALLOWED_ROLES = ["warehouse", "admin", "staff"];
const LOC_KEY = "warehouse.locationId";
const LP_LABEL = { light: "レターパックライト（青）", plus: "レターパックプラス（赤）" };
const FALLBACK_REASONS = [
  { value: "shortage", label: "在庫が足りない" },
  { value: "address", label: "住所・宛先に不備がある" },
  { value: "other", label: "その他" },
];

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function todayJst() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
// Timestamp・{seconds}・ミリ秒・ISO文字列のどれで届いても日時にする
function toMs(t) {
  if (!t) return 0;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (t.seconds != null) return t.seconds * 1000;
  if (t._seconds != null) return t._seconds * 1000;
  const n = new Date(t).getTime();
  return Number.isNaN(n) ? 0 : n;
}
function fmtDT(t) {
  const m = toMs(t);
  return m ? new Date(m).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}
function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._t); t._t = setTimeout(() => { t.style.display = "none"; }, 4000); }
// サーバーの文言はそのまま出す。internal 等の想定外は言い換える
function errText(e) {
  const code = String((e && e.code) || "").replace(/^functions\//, "");
  const msg = String((e && e.message) || e || "");
  if (!msg || code === "internal" || code === "unavailable" || code === "deadline-exceeded" || /^(INTERNAL|internal)$/i.test(msg)) {
    return "うまくいきませんでした。少し待ってからもう一度お試しください（続くときは管理者に連絡してください）";
  }
  return msg;
}
function reasonList() {
  const R = ISSUE_REASONS;
  let list = [];
  if (Array.isArray(R)) list = R.map((x) => typeof x === "string" ? { value: x, label: x } : { value: x.value || x.key || x.id, label: x.label || x.name });
  else if (R && typeof R === "object") list = Object.entries(R).map(([k, v]) => ({ value: k, label: typeof v === "string" ? v : (v && v.label) || k }));
  list = list.filter((x) => x.value && x.label);
  return list.length ? list : FALLBACK_REASONS;
}
function reasonLabel(v) { const r = reasonList().find((x) => x.value === v); return r ? r.label : (v || ""); }
const isPickup = (s) => deliveryModeOf(s) === "pickup";

let data = { sender: null, location: null, locations: [], requested: [], done: [], canceled: [], stock: [], finalConfirm: true };
// 「出荷の依頼」タブの中の段（受付・確認待ち・入荷待ち・発送不可・発送準備）。最初は件数のある段（受付 → 発送準備の順）
const REQ_STEPS = ["accept", "confirm", "wait", "ng", "prepare"];
const STEP_NOTE = {
  accept: "在庫と照らして「受付する」から、発送可・入荷待ち・発送不可を選びます。依頼した人に Chat で知らせます。",
  confirm: "依頼した人の最終確認（OK・変更・キャンセル）を待っています。OK が出ると発送準備に移ります。",
  wait: "入荷を待っている依頼です。在庫がそろったものは緑の枠で出ます。そろったら「受付する」で「発送可」にします。",
  ng: "発送不可を知らせた依頼です。依頼した人が倉庫を選び直すか、直して依頼し直すのを待っています。",
  prepare: "納品希望日の早い順です。宛名を印刷して梱包し、発送したら「発送済にする」（持ち出しは「受け渡し済にする」）。",
};
let reqStep = "";
let locationId = "";
let current = null; // モーダルで操作中の出荷
let busy = false;
// 一覧タブの状態（絞り込み・検索・並べ替え・「確認済みにしたあとも、この画面を開いている間は残す行」）
const sheet = { filter: "unconfirmed", q: "", key: "requestedAt", dir: "asc", keep: new Set(),
  // 備考の未保存の入力（id → { value, state: "saving"|"error", msg }）。保存が終わるまで画面の描き直しでも消えない／失敗しても入力した文を残す
  pending: new Map(), inflight: new Set() };

function readSavedLoc() { try { return localStorage.getItem(LOC_KEY) || ""; } catch (_) { return ""; } }
function saveLoc(v) { try { localStorage.setItem(LOC_KEY, v); } catch (_) {} }

// ---- 読み込み ----
async function load(keepToast, retried) {
  const main = $("main");
  main.classList.add("wh-loading");
  try {
    let res;
    try {
      res = await listFn({ locationId }); // 空なら、サーバーが扱える場所（既定→並びの先頭）を選んで location に返す
    } catch (e) {
      // 保存しておいた場所が使えなくなった（割り当ての変更・停止）→ 一度だけ空で取り直す（2026-10-24 Codex 指摘1）
      const code = String((e && e.code) || "").replace(/^functions\//, "");
      if (!retried && locationId && (code === "permission-denied" || code === "not-found")) { locationId = ""; res = await listFn({ locationId }); }
      else throw e;
    }
    const d = (res && res.data) || {};
    data = {
      sender: d.sender || null,
      location: d.location || null,
      locations: Array.isArray(d.locations) ? d.locations : [],
      requested: Array.isArray(d.requested) ? d.requested : [],
      done: Array.isArray(d.done) ? d.done : [],
      canceled: Array.isArray(d.canceled) ? d.canceled : [],
      stock: Array.isArray(d.stock) ? d.stock : [],
      finalConfirm: d.finalConfirm !== false,
    };
    // サーバーが選んだ場所を使い、保存し直す（保存した場所が無い・一覧に無いとき）
    if (data.location && data.location.id) { locationId = data.location.id; saveLoc(locationId); }
    else if (!data.locations.some((l) => l.id === locationId) && data.locations[0]) { locationId = data.locations[0].id; saveLoc(locationId); }
    renderAll();
  } catch (e) {
    if (!keepToast) toast(errText(e));
    $("tab-requested").innerHTML = `<div class="wh-empty">読み込めませんでした。<br>${esc(errText(e))}</div>`;
  } finally {
    main.classList.remove("wh-loading");
  }
}

function renderAll() { renderLocSelect(); renderCounts(); renderRequested(); renderDone(); renderCanceled(); renderStock(); renderSheet(); }
// W の段（サーバーが step を付けて返す。無い古い返事は受付とみなす）
const stepOfW = (s) => s.step || "accept";
function stepCountsW() {
  const c = Object.fromEntries(REQ_STEPS.map((k) => [k, 0]));
  for (const s of data.requested) if (c[stepOfW(s)] != null) c[stepOfW(s)]++;
  return c;
}

function renderLocSelect() {
  const sel = $("locSelect");
  const locs = data.locations;
  sel.innerHTML = locs.map((l) => `<option value="${esc(l.id)}">${esc(l.name || l.id)}</option>`).join("") || `<option value="">（保管場所がありません）</option>`;
  sel.value = locationId;
  sel.disabled = locs.length <= 1;
}

function renderCounts() {
  const ship = data.requested.filter((s) => !isPickup(s)).length;
  const pick = data.requested.filter(isPickup).length;
  const unconf = data.requested.filter((s) => !s.warehouseConfirmed).length;
  const sc = stepCountsW();
  $("counts").innerHTML = `<span class="badge badge-1">依頼 ${data.requested.length}件</span>`
    + `<span class="badge badge-5">受付 ${Number(sc.accept)}件</span><span class="badge badge-3">発送準備 ${Number(sc.prepare)}件</span>`
    + `<span class="badge badge-1">未確認 ${unconf}件</span>`
    + `<span class="badge badge-2">発送 ${ship}</span><span class="badge badge-2">持ち出し ${pick}</span>`;
  const sb = $("sheetBadge");
  sb.textContent = `未確認 ${unconf}`; sb.style.display = unconf > 0 ? "" : "none";
}


function itemsHtml(s) {
  const items = Array.isArray(s.items) ? s.items : [];
  if (!items.length) return "";
  return `<ul class="wh-items">${items.map((i) => `<li>${esc(i.name || i.sku)} × ${Number(i.qty) || 0}</li>`).join("")}</ul>`;
}

function card(s, mode) {
  const pickup = isPickup(s);
  const badge = pickup ? `<span class="badge badge-6">持ち出し</span>` : `<span class="badge badge-5">発送</span>`;
  let dest;
  if (pickup) {
    dest = `<div class="wh-dest"><strong>持ち出す人：</strong>${esc(s.pickupByName || "—")}<br><strong>予定日：</strong>${esc(s.pickupDate || "—")}</div>`;
  } else {
    const lines = [s.company, s.officeName, s.contactName ? `${s.contactName} 様` : ""].filter(Boolean).map(esc).join("<br>");
    dest = `<div class="wh-dest">${lines}<br>${s.postalCode ? "〒" + esc(s.postalCode) + " " : ""}${esc(s.address || "")}${s.phone ? `<br>電話 ${esc(s.phone)}` : ""}`
      + `${s.desiredDate ? `<br><strong>出荷予定日：</strong>${esc(s.desiredDate)}` : ""}</div>`;
  }
  // 納品希望日（2026-11-12 送1）。発送準備はこの日の早い順
  const desiredHtml = mode === "requested" && s.desiredDeliveryDate ? `<div class="wh-desired">納品希望日：${esc(s.desiredDeliveryDate)}</div>` : "";
  const step = mode === "requested" ? stepOfW(s) : mode;
  const readyHtml = step === "wait" && s.stockReady ? `<div class="wh-ready"><i class="ti ti-circle-check" aria-hidden="true"></i> 在庫がそろいました。「受付する」で発送可にできます</div>` : "";
  const meta = [];
  if (mode === "requested") {
    if (!pickup && s.letterPackType) meta.push(`レターパック：${esc(LP_LABEL[s.letterPackType] || s.letterPackType)}`);
    meta.push(`依頼：${esc(s.requestedByName || "—")}（${esc(fmtDT(s.requestedAt))}）`);
    if (s.acceptStatus && s.acceptedByName) meta.push(`受付：${esc(ACCEPT_DECISIONS[s.acceptStatus] || s.acceptStatus)}（${esc(s.acceptedByName)}）${s.acceptNote ? `・${esc(s.acceptNote)}` : ""}`);
  } else if (mode === "canceled") {
    meta.push(`キャンセル：${esc(fmtDT(s.canceledAt))}`, `理由：${esc(s.cancelReason || "—")}`);
  } else {
    if (pickup) meta.push(`受け渡し日：${esc(s.shipDate || "—")}（${esc(s.handedOverByName || "—")}）`);
    else meta.push(`発送日：${esc(s.shipDate || "—")}`, `追跡番号：${esc(s.trackingNumber || "なし")}`);
  }
  if (s.note) meta.push(`メモ：${esc(s.note)}`);
  const issue = s.warehouseIssue && mode === "requested"
    ? `<div class="wh-issue"><strong>倉庫から差し戻し中：</strong>${esc(reasonLabel(s.warehouseIssue.reason))}${s.warehouseIssue.note ? `（${esc(s.warehouseIssue.note)}）` : ""}<br>${esc(s.warehouseIssue.byName || "")} ${esc(fmtDT(s.warehouseIssue.at))}</div>` : "";
  let actions = "";
  const printBtn = pickup ? "" : `<button class="btn btn-secondary" type="button" data-act="print" data-id="${esc(s.id)}" data-tip="宛名ラベルと梱包の確認をA4で印刷します"><i class="ti ti-printer" aria-hidden="true"></i>宛名を印刷</button>`;
  if (mode === "requested" && (step === "accept" || step === "wait")) {
    actions = `<div class="wh-actions"><button class="btn btn-primary" type="button" data-act="acc" data-id="${esc(s.id)}" data-tip="在庫と照らして、発送可・入荷待ち・発送不可のどれかを選びます。依頼した人に Chat で知らせます"><i class="ti ti-clipboard-check" aria-hidden="true"></i>受付する</button>${printBtn}</div>`;
  } else if (mode === "requested" && step !== "prepare") {
    actions = printBtn ? `<div class="wh-actions">${printBtn}</div>` : "";
  } else if (mode === "requested") {
    actions = `<div class="wh-actions">`
      + (pickup
        ? `<button class="btn btn-primary" type="button" data-act="hand" data-id="${esc(s.id)}" data-tip="持ち出す人に渡したら押します。在庫を引き、依頼した人に Chat で知らせます"><i class="ti ti-hand-grab" aria-hidden="true"></i>受け渡し済にする</button>`
        : `<button class="btn btn-primary" type="button" data-act="ship" data-id="${esc(s.id)}" data-tip="発送日・種別・問い合わせ番号を入れて発送済にします。在庫を引き、依頼した人に Chat で知らせます"><i class="ti ti-truck-delivery" aria-hidden="true"></i>発送済にする</button>`)
      + printBtn
      + `<button class="btn btn-secondary" type="button" data-act="rej" data-id="${esc(s.id)}" data-tip="発送できなくなったときに、理由を選んで依頼した人に知らせます"><i class="ti ti-alert-triangle" aria-hidden="true"></i>出荷できない</button></div>`;
  } else if (mode === "canceled") {
    actions = "";
  } else if (!pickup) {
    actions = `<div class="wh-actions"><button class="btn btn-secondary" type="button" data-act="fix" data-id="${esc(s.id)}"><i class="ti ti-pencil" aria-hidden="true"></i>追跡番号を直す</button>`
      + `<button class="btn btn-secondary" type="button" data-act="print" data-id="${esc(s.id)}"><i class="ti ti-printer" aria-hidden="true"></i>宛名を印刷</button></div>`;
  }
  const stepBadge = mode === "requested" ? `<span class="badge badge-2">${esc(STEP_LABEL[step] || "")}</span>` : "";
  return `<div class="card wh-card${readyHtml ? " is-ready" : ""}"><div class="card-body">
    <div class="wh-head">${mode === "requested" && !pickup ? `<label class="wh-pick"><input type="checkbox" data-sel="${esc(s.id)}" aria-label="${esc(s.soNumber || "")}を印刷に選ぶ"></label>` : ""}<span class="wh-so">${esc(s.soNumber || "")}</span>${badge}${stepBadge}</div>
    ${desiredHtml}${readyHtml}${dest}${itemsHtml(s)}
    <div class="wh-meta">${meta.join("<br>")}</div>${issue}${actions}</div></div>`;
}

function renderRequested() {
  const sc = stepCountsW();
  if (!reqStep || !REQ_STEPS.includes(reqStep)) reqStep = REQ_STEPS.find((k) => sc[k] > 0 && (k === "accept" || k === "prepare")) || "accept";
  // 段ごとの並び: 納品希望日の早い順（同じなら依頼の古い順・2026-11-12 送1）
  const list = sortByDesired(data.requested.filter((s) => stepOfW(s) === reqStep));
  const chips = `<div class="wh-steps" role="group" aria-label="段で切り替え">${REQ_STEPS.map((k) =>
    `<button type="button" class="btn ${k === reqStep ? "btn-primary" : "btn-secondary"}" data-step="${esc(k)}" aria-pressed="${k === reqStep}" data-tip="${esc(STEP_NOTE[k])}">${esc(STEP_LABEL[k])} <span class="badge badge-2">${Number(sc[k])}</span></button>`).join("")}</div>`
    + `<p class="wh-step-note">${esc(STEP_NOTE[reqStep])}${reqStep === "confirm" && !data.finalConfirm ? "（いまは最終確認を省く設定です）" : ""}</p>`;
  const hasShip = list.some((s) => !isPickup(s));
  const bar = hasShip ? `<div class="wh-actions" style="margin-bottom:12px"><button class="btn btn-secondary" type="button" id="bulkPrint" data-tip="チェックを入れた出荷の宛名を、まとめて印刷します"><i class="ti ti-printer" aria-hidden="true"></i>選んだものをまとめて印刷</button></div>` : "";
  $("tab-requested").innerHTML = chips + bar + (list.length ? list.map((s) => card(s, "requested")).join("")
    : `<div class="wh-empty"><i class="ti ti-circle-check" style="font-size:32px" aria-hidden="true"></i><br>${esc(STEP_LABEL[reqStep])}の出荷はありません</div>`);
}
function renderCanceled() {
  $("tab-canceled").innerHTML = data.canceled.length ? data.canceled.map((s) => card(s, "canceled")).join("")
    : `<div class="wh-empty">直近30日にキャンセルした出荷はありません</div>`;
}
function renderDone() {
  const list = [...data.done].sort((a, b) => String(b.shipDate || "").localeCompare(String(a.shipDate || "")));
  $("tab-done").innerHTML = list.length ? list.map((s) => card(s, "done")).join("")
    : `<div class="wh-empty">直近30日の発送済・受け渡し済はありません</div>`;
}
function renderStock() {
  const rows = data.stock.map((r) => `<tr><td>${esc(r.name || r.sku)}<br><span class="wh-meta">${esc(r.sku)}</span></td><td class="num">${Number(r.qty) || 0} 台</td></tr>`).join("");
  $("tab-stock").innerHTML = rows
    ? `<div class="card"><div class="table-wrap"><table class="wh-stock"><thead><tr><th>商品</th><th class="num">数量</th></tr></thead><tbody>${rows}</tbody></table></div></div>
       <p class="wh-meta">在庫の見るだけの一覧です。入荷や棚卸の登録はスタッフが行います。</p>`
    : `<div class="wh-empty">この保管場所の在庫はありません</div>`;
}

// ---- 一覧タブ（2026-11-04）。行・絞り込み・並べ替え・CSV の判定は /js/warehouse-sheet.js（純粋関数）----
const SORT_LABEL = { requestedAt: "依頼日", qty: "台数" };
function sheetRowsAll() { return buildRows(data.requested, data.done); }
// いま見えている行（絞り込み＋検索＋並べ替え）。確認済みにした行は、絞り込みが「未確認」でもこの画面を開いている間は残す（押し間違いを戻せるように）
function sheetVisible() {
  const all = sheetRowsAll();
  const shown = filterRows(all, sheet.filter, sheet.q);
  const extra = filterRows(all, "all", sheet.q).filter((s) => sheet.keep.has(s.id) && !shown.includes(s));
  return sortRows([...shown, ...extra], sheet.key, sheet.dir);
}
function tick(attrs, label, checked, disabled) {
  return `<label class="wh-tick"><input type="checkbox" ${attrs} aria-label="${esc(label)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}></label>`;
}
function sheetRow(s, counts) {
  const pickup = isPickup(s);
  const done = s.mode === "done";
  const so = s.soNumber || "";
  const id = esc(s.id);
  let dest;
  if (pickup) {
    dest = `<strong>受け渡し</strong><br>${esc(s.pickupByName || "—")}<br>${esc((done ? s.shipDate : s.pickupDate) || "—")}`;
  } else {
    const lines = [s.company, s.officeName, s.contactName ? `${s.contactName} 様` : ""].filter(Boolean).map(esc).join("<br>");
    dest = `${lines}<br>${s.postalCode ? "〒" + esc(s.postalCode) + " " : ""}${esc(s.address || "")}${s.phone ? `<br>電話 ${esc(s.phone)}` : ""}`;
  }
  const n = sameDestOf(s, counts);
  const sameHtml = n ? `<br><span class="badge badge-2 wh-same">同じ宛先 ${n}件</span>` : "";
  const confirmCell = done
    ? tick("", `${so}は確認済み`, true, true)
    : tick(`data-confirm="${id}"`, `${so}を確認済みにする`, !!s.warehouseConfirmed, false)
      + (s.warehouseConfirmed && s.warehouseConfirmedByName ? `<br><span class="wh-meta">${esc(s.warehouseConfirmedByName)}</span>` : "");
  const shipCell = done
    ? tick("", `${so}は${pickup ? "受け渡し済" : "発送済"}`, true, true)
    : tick(`data-shipchk="${id}"`, `${so}を${pickup ? "受け渡し済" : "発送済"}にする`, false, false);
  const dateCell = done ? esc(s.shipDate || "—") : (s.desiredDate ? `<span class="wh-meta">希望 ${esc(s.desiredDate)}</span>` : "—");
  const trackCell = done && !pickup ? esc(s.trackingNumber || "なし") : "—";
  const pend = sheet.pending.get(s.id); // 未保存（保存中・失敗）の入力があれば、サーバーの値より優先して出す
  const noteVal = pend ? pend.value : (s.warehouseNote || "");
  const stText = pend ? (pend.state === "saving" ? "保存中…" : `保存できませんでした：${pend.msg}`) : "";
  const noteCell = `<textarea class="form-control wh-note" rows="2" maxlength="500" data-note="${id}" aria-label="${esc(so)}の備考">${esc(noteVal)}</textarea><span class="wh-note-st${pend && pend.state === "error" ? " err" : ""}" data-notest="${id}" aria-live="polite">${esc(stText)}</span>`;
  const cls = done ? "is-done" : (s.warehouseConfirmed ? "" : "is-unconfirmed");
  return `<tr class="${cls}"><td>${esc(fmtDT(s.requestedAt))}</td><td>${esc(s.requestedByName || "—")}</td><td>${Number(qtyOf(s))}</td>`
    + `<td>${dest}${sameHtml}</td><td><strong>${esc(so)}</strong></td><td class="chk">${confirmCell}</td><td class="chk">${shipCell}</td>`
    + `<td>${dateCell}</td><td>${trackCell}</td><td>${noteCell}</td></tr>`;
}
function renderSheet() {
  const host = $("tab-sheet");
  if (!host.querySelector("#sheetBar")) {
    host.innerHTML = `<div class="wh-sheet-bar" id="sheetBar">
      <label for="sheetFilter" style="font-size:13px;font-weight:700">絞り込み</label>
      <select id="sheetFilter" class="form-control" style="width:auto"></select>
      <input type="search" id="sheetQ" class="form-control" placeholder="出荷番号・事業所名・宛先・依頼者で探す" aria-label="出荷番号・事業所名・宛先・依頼者で探す" autocomplete="off">
      <button class="btn btn-secondary" id="sheetCsv" type="button" style="min-height:44px"><i class="ti ti-download" aria-hidden="true"></i>CSVでダウンロード</button>
      <span class="wh-sheet-count" id="sheetCount" aria-live="polite"></span>
    </div>
    <div class="card"><div class="table-wrap" id="sheetTable"></div></div>
    <p class="wh-meta">「確認済み」は、依頼の内容を見て確かめたときに入れます。「発送済み」を入れると、発送日などを入れる画面が開きます（受け渡しは「受け渡し済にする」の画面）。備考は、入力欄から出ると自動で保存されます。</p>`;
  }
  const all = sheetRowsAll();
  const cnt = { unconfirmed: all.filter(isUnconfirmed).length, unshipped: all.filter((s) => s.mode === "requested").length, all: all.length };
  const opts = Object.entries(FILTERS).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}（${Number(cnt[k])}件）</option>`).join("");
  const fsel = $("sheetFilter");
  fsel.innerHTML = opts; fsel.value = sheet.filter;
  const vis = sheetVisible();
  $("sheetCount").textContent = `${vis.length}件を表示`;
  const counts = sameDestCounts(all);
  const arrow = (k) => (sheet.key === k ? (sheet.dir === "asc" ? "▲" : "▼") : "");
  const sortTh = (k) => `<th aria-sort="${sheet.key === k ? (sheet.dir === "asc" ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${esc(k)}">${esc(SORT_LABEL[k])} ${arrow(k)}</button></th>`;
  const head = `<tr>${sortTh("requestedAt")}<th>依頼者</th>${sortTh("qty")}<th>配送先</th><th>出荷番号</th><th class="chk">確認済み</th><th class="chk">発送済み</th><th>発送日</th><th>追跡番号</th><th>備考（倉庫用）</th></tr>`;
  const rows = vis.map((s) => sheetRow(s, counts)).join("");
  $("sheetTable").innerHTML = `<table class="wh-sheet"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="10" class="wh-empty">${sheet.filter === "unconfirmed" && !sheet.q ? "未確認の出荷はありません" : "該当する出荷はありません"}</td></tr>`}</tbody></table>`;
}
function downloadCsv() {
  const vis = sheetVisible();
  if (!vis.length) return toast("ダウンロードする行がありません");
  const text = buildCsv(vis);
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = csvFileName(data.location && data.location.name, todayJst());
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${vis.length}件をダウンロードしました`);
}

async function onSheetConfirm(cb) {
  const id = cb.dataset.confirm, want = cb.checked;
  const s = find(id); if (!s) return;
  cb.disabled = true;
  try {
    await confirmFn({ shipmentId: id, confirmed: want });
    s.warehouseConfirmed = want;
    s.warehouseConfirmedByName = want ? ((auth.currentUser && (auth.currentUser.displayName || auth.currentUser.email)) || "") : "";
    s.warehouseConfirmedAt = want ? new Date().toISOString() : null;
    if (want) sheet.keep.add(id); else sheet.keep.delete(id);
    renderCounts(); renderSheet();
  } catch (e) {
    cb.checked = !want; cb.disabled = false;
    toast(errText(e));
    const code = String((e && e.code) || "").replace(/^functions\//, "");
    if (code === "failed-precondition" || code === "not-found") load(true); // 先に別の人が操作していた → 最新にする
  }
}
function onSheetShip(cb) {
  const s = find(cb.dataset.shipchk);
  cb.checked = false; // 発送済みになるのは、モーダルで登録できたあと。キャンセルしたらチェックは入らない
  if (!s) return;
  (isPickup(s) ? openHand : openShip)(s);
}
async function onSheetNote(ta) {
  const id = ta.dataset.note;
  const s = find(id); if (!s) return;
  const value = ta.value.trim();
  const pend = sheet.pending.get(id);
  const same = value === String(s.warehouseNote || "");
  const setSt = (msg, err) => {
    const el = document.querySelector(`[data-notest="${CSS.escape(id)}"]`);
    if (el) { el.textContent = msg; el.classList.toggle("err", !!err); }
  };
  if (!pend && same) return; // 変わっていなければ保存しない
  if (pend && pend.state === "error" && same) { sheet.pending.delete(id); setSt("", false); return; } // 失敗した入力を、元の文に戻した
  if (pend && pend.state === "saving") { pend.value = value; return; } // 保存中なら、終わったあとに最新の入力でもう一度保存する
  const p = { value, state: "saving", msg: "" };
  sheet.pending.set(id, p); // 送る前に手元へ入れる（描き直し・更新・別の行の操作で入力が消えない）
  setSt("保存中…", false);
  const run = (async () => {
    for (;;) {
      const sent = p.value;
      try {
        await noteFn({ shipmentId: id, note: sent });
        s.warehouseNote = sent;
      } catch (e) {
        p.state = "error"; p.msg = errText(e); // 入力した文は pending に残す。失敗が分かる表示を出す
        setSt(`保存できませんでした：${p.msg}`, true);
        return;
      }
      if (p.value === sent) {
        sheet.pending.delete(id);
        setSt("保存しました", false);
        setTimeout(() => { const el = document.querySelector(`[data-notest="${CSS.escape(id)}"]`); if (el && el.textContent === "保存しました") el.textContent = ""; }, 3000);
        return;
      }
    }
  })();
  sheet.inflight.add(run);
  run.finally(() => sheet.inflight.delete(run));
}
function bindSheet() {
  const host = $("tab-sheet");
  host.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("input[data-confirm]")) onSheetConfirm(t);
    else if (t.matches("input[data-shipchk]")) onSheetShip(t);
    else if (t.matches("textarea[data-note]")) onSheetNote(t);
    else if (t.id === "sheetFilter") { sheet.filter = t.value; sheet.keep.clear(); renderSheet(); }
  });
  host.addEventListener("input", (e) => {
    if (e.target.id !== "sheetQ") return;
    sheet.q = e.target.value; // 検索欄・絞り込みは作り直さず、表だけ描き直す
    renderSheet();
  });
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (b) {
      const k = b.dataset.sort;
      if (sheet.key === k) sheet.dir = sheet.dir === "asc" ? "desc" : "asc"; else { sheet.key = k; sheet.dir = "asc"; }
      return renderSheet();
    }
    if (e.target.closest("#sheetCsv")) downloadCsv();
  });
}
// ---- モーダル ----
function open(id) { $(id).classList.add("open"); }
function close(id) { $(id).classList.remove("open"); current = null; busy = false; }
function showErr(id, msg) { const e = $(id); e.textContent = msg; e.style.display = msg ? "block" : "none"; }
const find = (id) => data.requested.find((s) => s.id === id) || data.done.find((s) => s.id === id) || data.canceled.find((s) => s.id === id);
const infoLine = (s) => `${s.soNumber || ""}　${isPickup(s) ? esc(s.pickupByName || "") : esc(s.officeName || "")}`;

function openShip(s) {
  current = s; showErr("shipErr", "");
  $("shipInfo").innerHTML = infoLine(s);
  // 種別の初期値: 1〜6台＝レターパックプラス、7台以上＝ゆうパック（元払い）。保存した種別があればそれ（2026-11-12 送4）
  const qty = (Array.isArray(s.items) ? s.items : []).reduce((a, i) => a + (Number(i.qty) || 0), 0);
  $("shipDate").value = todayJst(); $("shipTracking").value = "";
  $("shipPack").value = PACK_TYPES[s.packType] ? s.packType : (qty >= 7 ? "yupack" : (s.letterPackType === "light" ? "light" : packTypeDefault(qty)));
  open("shipModal");
}
function openAcc(s) {
  current = s; showErr("accErr", "");
  $("accInfo").innerHTML = infoLine(s);
  $("accDecisions").innerHTML = Object.entries(ACCEPT_DECISIONS).map(([k, v], i) =>
    `<label class="wh-radio"><input type="radio" name="accDecision" value="${esc(k)}"${i === 0 ? " checked" : ""}>${esc(v)}</label>`).join("");
  $("accReasons").innerHTML = reasonList().map((r, i) =>
    `<label class="wh-radio"><input type="radio" name="accReason" value="${esc(r.value)}"${i === 0 ? " checked" : ""}>${esc(r.label)}</label>`).join("");
  $("accShipDate").value = s.desiredDate || ""; $("accNote").value = "";
  syncAcc();
  open("accModal");
}
function syncAcc() {
  const d = (document.querySelector('input[name="accDecision"]:checked') || {}).value || "ok";
  $("accOkWrap").style.display = d === "ok" ? "" : "none";
  $("accNgWrap").style.display = d === "ng" ? "" : "none";
  $("accHint").textContent = d === "ok"
    ? (data.finalConfirm ? "依頼した人に「発送可・最終確認をしてください」と知らせます。OK が出たら発送準備に入ります。" : "依頼した人に「発送可」と知らせ、そのまま発送準備に入ります。")
    : d === "wait" ? "依頼した人に「入荷待ち」と知らせます。依頼はそのまま残ります。在庫がそろったらもう一度「受付する」で発送可にします。"
      : "依頼した人に「発送不可」と理由を知らせます。依頼した人が倉庫を選び直すか、直して依頼し直します。";
}
function doAcc() {
  const s = current; if (!s) return;
  const decision = (document.querySelector('input[name="accDecision"]:checked') || {}).value || "";
  const reason = (document.querySelector('input[name="accReason"]:checked') || {}).value || "";
  const note = $("accNote").value.trim();
  if (decision === "ng" && reason === "other" && !note) return showErr("accErr", "「その他」のときは、メモに理由を書いてください");
  const payload = { shipmentId: s.id, decision, note };
  if (decision === "ng") payload.reason = reason;
  if (decision === "ok" && $("accShipDate").value) payload.shipDate = $("accShipDate").value;
  return run("accOk", "accErr", "accModal", () => acceptFn(payload),
    (r) => `${s.soNumber || ""} を「${ACCEPT_DECISIONS[decision]}」にしました${r && r.notified === false ? "（依頼した人への通知は送れませんでした。直接伝えてください）" : "。依頼した人に知らせました"}`);
}
function openHand(s) {
  current = s; showErr("handErr", "");
  $("handInfo").innerHTML = infoLine(s);
  $("handDate").value = todayJst();
  open("handModal");
}
function openRej(s) {
  current = s; showErr("rejErr", "");
  $("rejInfo").innerHTML = infoLine(s);
  $("rejReasons").innerHTML = reasonList().map((r, i) =>
    `<label class="wh-radio"><input type="radio" name="rejReason" value="${esc(r.value)}"${i === 0 ? " checked" : ""}>${esc(r.label)}</label>`).join("");
  $("rejNote").value = "";
  open("rejModal");
}
function openFix(s) {
  current = s; showErr("fixErr", "");
  $("fixInfo").innerHTML = infoLine(s);
  $("fixTracking").value = s.trackingNumber || "";
  open("fixModal");
}

// 登録ボタンの共通処理（二重押し防止・結果のトースト・一覧の読み直し）
async function run(btnId, errId, modalId, call, okMsg) {
  if (busy) return;
  busy = true; showErr(errId, "");
  const btn = $(btnId); btn.disabled = true;
  try {
    const res = await call();
    close(modalId);
    toast(typeof okMsg === "function" ? okMsg(res && res.data) : okMsg);
    await load(true);
  } catch (e) {
    showErr(errId, errText(e));
  } finally {
    busy = false; btn.disabled = false;
  }
}

function doShip() {
  const s = current; if (!s) return;
  const date = $("shipDate").value;
  if (!date) return showErr("shipErr", "発送日を入れてください");
  const payload = { shipmentId: s.id, shipDate: date, packType: $("shipPack").value };
  const tr = $("shipTracking").value.trim(); if (tr) payload.trackingNumber = tr;
  return run("shipOk", "shipErr", "shipModal", () => shipFn(payload),
    (r) => `${s.soNumber || ""} を発送済にしました${r && r.notified ? "。依頼した人に知らせました" : ""}`);
}
function doHand() {
  const s = current; if (!s) return;
  const date = $("handDate").value;
  if (!date) return showErr("handErr", "受け渡し日を入れてください");
  return run("handOk", "handErr", "handModal", () => handoverFn({ shipmentId: s.id, date }), `${s.soNumber || ""} を受け渡し済にしました`);
}
function doReject() {
  const s = current; if (!s) return;
  const sel = document.querySelector('input[name="rejReason"]:checked');
  const reason = sel ? sel.value : "";
  const note = $("rejNote").value.trim();
  if (!reason) return showErr("rejErr", "理由を選んでください");
  if (reason === "other" && !note) return showErr("rejErr", "「その他」のときは、くわしい内容を書いてください");
  return run("rejOk", "rejErr", "rejModal", () => rejectFn({ shipmentId: s.id, reason, note }),
    (r) => r && r.notified === false ? `${s.soNumber || ""} を差し戻しました（依頼した人への通知は送れませんでした。直接伝えてください）` : `${s.soNumber || ""} を差し戻し、依頼した人に知らせました`);
}
function doFix() {
  const s = current; if (!s) return;
  const tr = $("fixTracking").value.trim();
  // 空にすると追跡番号を消す（誤って登録した番号の取り消し。サーバーは空を許している）
  if (!tr && !confirm("追跡番号を消します。よろしいですか？")) return;
  return run("fixOk", "fixErr", "fixModal", () => fixFn({ shipmentId: s.id, trackingNumber: tr }), tr ? "追跡番号を直しました" : "追跡番号を消しました");
}

// 宛名の印刷。Firestore を読まない専用ページ（/warehouse-print）へ、いま画面にある W を sessionStorage で渡す
function printLabels(list) {
  if (!list.length) return toast("印刷する出荷を選んでください");
  if (!data.sender) toast("差出人が設定されていません（管理者に連絡してください）。お届け先だけ印刷します");
  try {
    // 印刷ページは「この人が作った印刷データ」だけを出す（同じタブで別の人がログインしたときに見えないように・Codex 指摘）
    sessionStorage.setItem("warehouse.printJob", JSON.stringify({
      uid: (auth.currentUser && auth.currentUser.uid) || "",
      labels: list, sender: data.sender || null, locationName: (data.location && data.location.name) || "",
    }));
  } catch (_) { return toast("このブラウザでは印刷の準備ができませんでした"); }
  window.open("/warehouse-print", "_blank");
}

function switchTab(name) {
  document.querySelectorAll(".wh-tabs .tab").forEach((t) => {
    const on = t.dataset.tab === name; t.classList.toggle("active", on); t.setAttribute("aria-selected", on ? "true" : "false");
  });
  for (const n of ["requested", "done", "canceled", "stock", "sheet"]) $(`tab-${n}`).classList.toggle("active", n === name);
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  const role = await gateRole(db, user);
  if (!role) return;
  if (!ALLOWED_ROLES.includes(role.role)) {
    showAccessDenied(user.email, "この画面は倉庫の担当・スタッフ・管理者のみ利用できます",
      "閲覧のみ・練習生のアカウントでは、倉庫の画面を使えません。必要なときは管理者に依頼してください。");
    return;
  }
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", () => {
    try { sessionStorage.removeItem("warehouse.printJob"); } catch (_) { /* 使えないブラウザでは何もしない */ }
    signOut(auth).then(() => location.href = "/index.html");
  });
  $("gate").style.display = "none"; $("main").style.display = "block";
  locationId = readSavedLoc();
  $("locSelect").addEventListener("change", (e) => { locationId = e.target.value; saveLoc(locationId); load(); });
  $("reloadBtn").addEventListener("click", async () => {
    if (sheet.inflight.size) await Promise.allSettled([...sheet.inflight]); // 備考の保存が終わってから読み直す（入力を静かに失わない）
    sheet.keep.clear(); load();
  });
  window.addEventListener("beforeunload", (e) => { if (sheet.pending.size) { e.preventDefault(); e.returnValue = ""; } }); // 保存できていない備考があるまま閉じない
  document.querySelectorAll(".wh-tabs .tab").forEach((t) => t.addEventListener("click", () => {
    switchTab(t.dataset.tab);
    if (t.dataset.tab === "sheet") { sheet.keep.clear(); load(true); } // 一覧を開くたびに最新にする（依頼が入った分が出る）
  }));
  bindSheet();
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => close(b.dataset.close)));
  $("tab-requested").addEventListener("click", (e) => {
    const sb = e.target.closest("button[data-step]");
    if (sb) { reqStep = sb.dataset.step; return renderRequested(); }
    if (e.target.closest("#bulkPrint")) {
      const ids = [...document.querySelectorAll("#tab-requested input[data-sel]:checked")].map((c) => c.dataset.sel);
      return printLabels(ids.map(find).filter(Boolean));
    }
    onCardClick(e);
  });
  $("tab-done").addEventListener("click", onCardClick);
  $("shipOk").addEventListener("click", doShip);
  $("accOk").addEventListener("click", doAcc);
  $("accDecisions").addEventListener("change", syncAcc);
  $("handOk").addEventListener("click", doHand);
  $("rejOk").addEventListener("click", doReject);
  $("fixOk").addEventListener("click", doFix);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".modal-overlay.open").forEach((m) => close(m.id)); });
  await load();
});

function onCardClick(e) {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const s = find(b.dataset.id); if (!s) return;
  if (b.dataset.act === "print") return printLabels([s]);
  ({ ship: openShip, hand: openHand, rej: openRej, fix: openFix, acc: openAcc })[b.dataset.act]?.(s);
}
