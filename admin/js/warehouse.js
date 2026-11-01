// 倉庫画面（2026-10-24 倉庫メニュー §3・§9）。倉庫の人は Firestore を直接読めないので、
// 表示も操作もすべて Callable（warehouseList / Ship / Handover / Reject / FixTracking）経由。
// 練習モードでは /js/fn.js が practice-stubs.js の代役に差し替える。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "/js/fs.js";
import { gateRole, showAccessDenied } from "/js/role.js";
import { getFunctions, httpsCallable } from "/js/fn.js";
import { ISSUE_REASONS, deliveryModeOf } from "/js/warehouse-rules.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");
const listFn = httpsCallable(functions, "warehouseList");
const shipFn = httpsCallable(functions, "warehouseShip");
const handoverFn = httpsCallable(functions, "warehouseHandover");
const rejectFn = httpsCallable(functions, "warehouseReject");
const fixFn = httpsCallable(functions, "warehouseFixTracking");

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

let data = { sender: null, location: null, locations: [], requested: [], done: [], stock: [] };
let locationId = "";
let current = null; // モーダルで操作中の出荷
let busy = false;

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
      stock: Array.isArray(d.stock) ? d.stock : [],
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

function renderAll() { renderLocSelect(); renderCounts(); renderRequested(); renderDone(); renderStock(); }

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
  $("counts").innerHTML = `<span class="badge badge-1">依頼 ${data.requested.length}件</span>`
    + `<span class="badge badge-2">発送 ${ship}</span><span class="badge badge-2">持ち出し ${pick}</span>`;
}

function requestedSortKey(s) { return String(isPickup(s) ? (s.pickupDate || s.desiredDate || "") : (s.desiredDate || "")) || "9999-99-99"; }

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
      + `${s.desiredDate ? `<br><strong>希望出荷日：</strong>${esc(s.desiredDate)}` : ""}</div>`;
  }
  const meta = [];
  if (mode === "requested") {
    if (!pickup && s.letterPackType) meta.push(`レターパック：${esc(LP_LABEL[s.letterPackType] || s.letterPackType)}`);
    meta.push(`依頼：${esc(s.requestedByName || "—")}（${esc(fmtDT(s.requestedAt))}）`);
  } else {
    if (pickup) meta.push(`受け渡し日：${esc(s.shipDate || "—")}（${esc(s.handedOverByName || "—")}）`);
    else meta.push(`発送日：${esc(s.shipDate || "—")}`, `追跡番号：${esc(s.trackingNumber || "なし")}`);
  }
  if (s.note) meta.push(`メモ：${esc(s.note)}`);
  const issue = s.warehouseIssue && mode === "requested"
    ? `<div class="wh-issue"><strong>倉庫から差し戻し中：</strong>${esc(reasonLabel(s.warehouseIssue.reason))}${s.warehouseIssue.note ? `（${esc(s.warehouseIssue.note)}）` : ""}<br>${esc(s.warehouseIssue.byName || "")} ${esc(fmtDT(s.warehouseIssue.at))}</div>` : "";
  let actions = "";
  if (mode === "requested") {
    actions = `<div class="wh-actions">`
      + (pickup
        ? `<button class="btn btn-primary" type="button" data-act="hand" data-id="${esc(s.id)}"><i class="ti ti-hand-grab" aria-hidden="true"></i>受け渡し済にする</button>`
        : `<button class="btn btn-primary" type="button" data-act="ship" data-id="${esc(s.id)}"><i class="ti ti-truck-delivery" aria-hidden="true"></i>発送済にする</button>`)
      + (pickup ? "" : `<button class="btn btn-secondary" type="button" data-act="print" data-id="${esc(s.id)}"><i class="ti ti-printer" aria-hidden="true"></i>宛名を印刷</button>`)
      + `<button class="btn btn-secondary" type="button" data-act="rej" data-id="${esc(s.id)}"><i class="ti ti-alert-triangle" aria-hidden="true"></i>出荷できない</button></div>`;
  } else if (!pickup) {
    actions = `<div class="wh-actions"><button class="btn btn-secondary" type="button" data-act="fix" data-id="${esc(s.id)}"><i class="ti ti-pencil" aria-hidden="true"></i>追跡番号を直す</button>`
      + `<button class="btn btn-secondary" type="button" data-act="print" data-id="${esc(s.id)}"><i class="ti ti-printer" aria-hidden="true"></i>宛名を印刷</button></div>`;
  }
  return `<div class="card wh-card"><div class="card-body">
    <div class="wh-head">${mode === "requested" && !pickup ? `<label class="wh-pick"><input type="checkbox" data-sel="${esc(s.id)}" aria-label="${esc(s.soNumber || "")}を印刷に選ぶ"></label>` : ""}<span class="wh-so">${esc(s.soNumber || "")}</span>${badge}</div>
    ${dest}${itemsHtml(s)}
    <div class="wh-meta">${meta.join("<br>")}</div>${issue}${actions}</div></div>`;
}

function renderRequested() {
  const list = [...data.requested].sort((a, b) => requestedSortKey(a).localeCompare(requestedSortKey(b)) || toMs(a.requestedAt) - toMs(b.requestedAt));
  const hasShip = list.some((s) => !isPickup(s));
  const bar = hasShip ? `<div class="wh-actions" style="margin-bottom:12px"><button class="btn btn-secondary" type="button" id="bulkPrint"><i class="ti ti-printer" aria-hidden="true"></i>選んだものをまとめて印刷</button></div>` : "";
  $("tab-requested").innerHTML = bar + (list.length ? list.map((s) => card(s, "requested")).join("")
    : `<div class="wh-empty"><i class="ti ti-circle-check" style="font-size:32px" aria-hidden="true"></i><br>いま出荷の依頼はありません</div>`);
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

// ---- モーダル ----
function open(id) { $(id).classList.add("open"); }
function close(id) { $(id).classList.remove("open"); current = null; busy = false; }
function showErr(id, msg) { const e = $(id); e.textContent = msg; e.style.display = msg ? "block" : "none"; }
const find = (id) => data.requested.find((s) => s.id === id) || data.done.find((s) => s.id === id);
const infoLine = (s) => `${s.soNumber || ""}　${isPickup(s) ? esc(s.pickupByName || "") : esc(s.officeName || "")}`;

function openShip(s) {
  current = s; showErr("shipErr", "");
  $("shipInfo").innerHTML = infoLine(s);
  $("shipDate").value = todayJst(); $("shipTracking").value = ""; $("shipLp").value = s.letterPackType || "";
  open("shipModal");
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
  const payload = { shipmentId: s.id, shipDate: date };
  const tr = $("shipTracking").value.trim(); if (tr) payload.trackingNumber = tr;
  const lp = $("shipLp").value; if (lp) payload.letterPackType = lp;
  return run("shipOk", "shipErr", "shipModal", () => shipFn(payload), `${s.soNumber || ""} を発送済にしました`);
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
  for (const n of ["requested", "done", "stock"]) $(`tab-${n}`).classList.toggle("active", n === name);
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
  $("reloadBtn").addEventListener("click", () => load());
  document.querySelectorAll(".wh-tabs .tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => close(b.dataset.close)));
  $("tab-requested").addEventListener("click", (e) => {
    if (e.target.closest("#bulkPrint")) {
      const ids = [...document.querySelectorAll("#tab-requested input[data-sel]:checked")].map((c) => c.dataset.sel);
      return printLabels(ids.map(find).filter(Boolean));
    }
    onCardClick(e);
  });
  $("tab-done").addEventListener("click", onCardClick);
  $("shipOk").addEventListener("click", doShip);
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
  ({ ship: openShip, hand: openHand, rej: openRej, fix: openFix })[b.dataset.act]?.(s);
}
