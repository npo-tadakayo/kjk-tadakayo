// admin/js/schedule.js — 予定（訪問カレンダー）。表示専用（書き込みは一切しない）。
// 日付・時刻は案件詳細の「訪問予定日」で入れる（cases.visitDate / visitTimeFrom / visitTimeTo / visitFormat）。
// 日付計算・絞り込み・並び順は schedule-core.js（純粋な関数・scripts/test-schedule.mjs でテスト）。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, applyViewerMode } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot, getDocs, where }
  from "/js/fs.js";
import { STATUS_LABELS } from "/js/constants.js";
import { fillAssigneeSelect } from "/js/assignee-filter.js";
import { areaOf } from "/js/area.js";
import { SHIP_STATUS_LABEL, SHIP_STATUS_BADGE, shipStatusOf } from "/js/ship-flow.js";
import * as S from "/js/schedule-core.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let me = "";
let allCases = [];
let officesById = {};
let allEvents = [];
let userNames = new Map();
let state = S.parseQuery(location.search, S.todayYmdJst());
const prep = new Map(); // caseId -> { quotes, shipments }（日ビューで開いた分だけ読む）
const MAX_IN_MONTH = 3;

// ---------- URL ----------
function syncUrl(push) {
  const url = location.pathname + S.buildQuery(state);
  if (url === location.pathname + location.search) return;
  history[push ? "pushState" : "replaceState"](null, "", url);
}
function go(patch, push = true) {
  state = { ...state, ...patch };
  syncUrl(push);
  render();
}

// ---------- 予定の組み立て ----------
function rebuildEvents() {
  allEvents = S.toEvents(allCases, { officesById, areaOf, userNames });
}
function visibleEvents() {
  const { from, to } = S.rangeOf(state.view, state.date);
  const inPeriod = S.inRange(allEvents, from, to);
  const byPref = S.filterEvents(inPeriod, { pref: state.pref });
  return { byPref, shown: S.filterEvents(byPref, { assignee: state.assignee, myEmail: me }) };
}

// ---------- 1件の表示 ----------
function eventHtml(ev, { withPrep }) {
  const time = ev.timeFrom
    ? `<span class="sch-time">${esc(S.timeLabel(ev.timeFrom, ev.timeTo))}</span>`
    : `<span class="sch-time is-undecided">時刻未定</span>`;
  const fmt = ev.format
    ? `<span class="sch-fmt"><i class="ti ${ev.format === "online" ? "ti-video" : "ti-building"}" aria-hidden="true"></i>${S.FORMAT_LABELS[ev.format]}</span>` : "";
  const stageIcon = { upcoming: "ti-clock", done: "ti-circle-check", check: "ti-alert-circle" }[ev.stage];
  const chip = `<span class="sch-chip sch-${ev.stage}"><i class="ti ${stageIcon}" aria-hidden="true"></i>${esc(STATUS_LABELS[ev.status] || "")}</span>`;
  const name = [ev.corpName, ev.officeName].filter(Boolean).join(" ") || "（事業所名なし）";
  const addr = ev.address
    ? `<span><i class="ti ti-map-pin" aria-hidden="true"></i><a href="${esc(S.googleMapsUrl(ev.address))}" target="_blank" rel="noopener">${esc(ev.address)}<span class="sr-only">（Googleマップを別タブで開く）</span></a></span>` : "";
  const tel = ev.phone
    ? `<span><i class="ti ti-phone" aria-hidden="true"></i><a href="tel:${esc(ev.phone.replace(/[^\d+]/g, ""))}">${esc(ev.phone)}</a></span>` : "";
  const who = `<span><i class="ti ti-user" aria-hidden="true"></i>${esc(ev.assignedUserName || "担当未割当")}</span>`;
  return `
    <article class="sch-event sch-${ev.stage}" data-case="${esc(ev.id)}">
      <div class="sch-event-top">${time}${fmt}${chip}</div>
      <div class="sch-office"><a href="/case-detail.html?id=${esc(ev.id)}">#${esc(ev.caseNumber || "—")} ${esc(name)}</a></div>
      <div class="sch-meta">${who}${addr}${tel}</div>
      ${withPrep ? `<div class="sch-prep" data-prep="${esc(ev.id)}">${prepHtml(ev.id)}</div>` : ""}
      <a class="sch-gcal btn btn-ghost" data-viewer-ok href="${esc(S.googleCalendarUrl(ev))}" target="_blank" rel="noopener"><i class="ti ti-calendar-plus" aria-hidden="true"></i>Googleカレンダーに追加<span class="sr-only">（別タブで開く）</span></a>
    </article>`;
}

// ---------- 準備の状況（見積・出荷）----------
function prepHtml(caseId) {
  const p = prep.get(caseId);
  if (!p) return `<span><i class="ti ti-loader-2 ti-spin" aria-hidden="true"></i> 準備の状況を読み込み中</span>`;
  if (p.error) return `<span>準備の状況を読み込めませんでした</span>`;
  const q = S.latestQuote(p.quotes);
  const sh = S.latestShipment(p.shipments);
  const qBadge = q
    ? `<span class="badge ${q.status === "accepted" ? "badge-3" : "badge-2"}">${esc(S.QUOTE_LABELS[q.status] || `見積 ${q.status || ""}`)}</span>`
    : `<span class="badge badge-1">見積 なし</span>`;
  const st = sh ? shipStatusOf(sh) : "";
  const sBadge = sh
    ? `<span class="badge badge-${SHIP_STATUS_BADGE[st] || 2}">出荷 ${esc(SHIP_STATUS_LABEL[st] || st)}</span>`
    : `<span class="badge badge-1">出荷 なし</span>`;
  return `<span>準備の状況</span>${qBadge}${sBadge}`;
}
async function loadPrep(ids) {
  const need = ids.filter((id) => !prep.has(id));
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 10) {
    const chunk = need.slice(i, i + 10);
    try {
      const [qs, ss] = await Promise.all([
        getDocs(query(collection(db, "quotes"), where("caseId", "in", chunk))),
        getDocs(query(collection(db, "shipments"), where("caseId", "in", chunk))),
      ]);
      chunk.forEach((id) => prep.set(id, { quotes: [], shipments: [] }));
      qs.docs.forEach((d) => prep.get(d.data().caseId)?.quotes.push({ _id: d.id, ...d.data() }));
      ss.docs.forEach((d) => prep.get(d.data().caseId)?.shipments.push({ _id: d.id, ...d.data() }));
    } catch (e) {
      console.warn("schedule prep:", e.message);
      chunk.forEach((id) => prep.set(id, { error: true }));
    }
    chunk.forEach((id) => {
      document.querySelectorAll(`[data-prep="${CSS.escape(id)}"]`).forEach((el) => { el.innerHTML = prepHtml(id); });
    });
  }
}

// ---------- 描画 ----------
function renderDay(events) {
  const day = state.date;
  const today = S.todayYmdJst();
  const list = S.sortEvents(events);
  let html = `<h3 class="sch-day-head ${day === today ? "is-today" : ""}">${esc(S.dayLabel(day))}${day === today ? "（今日）" : ""} — ${list.length}件</h3>`;
  html += list.length
    ? `<div class="sch-list">${list.map((e) => eventHtml(e, { withPrep: true })).join("")}</div>`
    : `<div class="sch-empty">この日の訪問予定はありません。</div>`;
  $("schBody").innerHTML = html;
  loadPrep(list.map((e) => e.id));
}
function renderWeek(events) {
  const { from, to } = S.rangeOf("week", state.date);
  const today = S.todayYmdJst();
  const byDate = S.groupByDate(events);
  $("schBody").innerHTML = `<div class="sch-week">${S.daysIn(from, to).map((d) => {
    const list = byDate.get(d) || [];
    return `<section class="sch-week-col" aria-label="${esc(S.dayLabel(d))}">
      <h3 class="sch-day-head ${d === today ? "is-today" : ""}"><a href="#" data-day="${d}">${esc(S.dayLabel(d))}</a>${d === today ? "（今日）" : ""}</h3>
      ${list.length ? `<div class="sch-list">${list.map((e) => eventHtml(e, { withPrep: false })).join("")}</div>` : `<div class="sch-empty">予定なし</div>`}
    </section>`;
  }).join("")}</div>`;
}
function renderMonth(events) {
  const today = S.todayYmdJst();
  const month = state.date.slice(0, 7);
  const byDate = S.groupByDate(events);
  const cells = S.monthGrid(state.date).flat().map((d) => {
    const list = byDate.get(d) || [];
    const shown = list.slice(0, MAX_IN_MONTH).map((e) => {
      const label = `${e.timeFrom || "未定"} ${e.officeName || e.corpName || ""}`;
      return `<div class="sch-cell-ev sch-${e.stage}" title="${esc(label)}">${e.format === "online" ? "◇" : ""}${esc(label)}</div>`;
    }).join("");
    const more = list.length > MAX_IN_MONTH ? `<div class="sch-cell-more">他${list.length - MAX_IN_MONTH}件</div>` : "";
    return `<button type="button" class="sch-cell ${d.slice(0, 7) !== month ? "is-other" : ""} ${d === today ? "is-today" : ""}" data-day="${d}"
      aria-label="${esc(S.dayLabel(d))} ${list.length}件。押すと日の表示に移ります">
      <span class="sch-cell-day">${Number(d.slice(8, 10))}</span>${shown}${more}</button>`;
  }).join("");
  $("schBody").innerHTML = `<div class="sch-month">${S.WEEKDAYS.map((w) => `<div class="sch-month-dow">${w}</div>`).join("")}${cells}</div>
    <p class="page-intro" style="margin-top:8px">◇ はオンラインの予定です。マスを押すと、その日の表示に移ります。</p>`;
}

function renderCounts(events) {
  const rows = S.countByAssignee(events);
  $("schCounts").innerHTML = `<span class="sch-count">この期間 <b>${events.length}</b>件</span>`
    + rows.map((r) => `<span class="sch-count">${esc(r.name)} <b>${r.count}</b>件</span>`).join("");
}

function fillPrefSelect() {
  const sel = $("prefFilter");
  const prefs = S.prefecturesOf(allEvents);
  if (state.pref && !prefs.includes(state.pref)) prefs.push(state.pref); // 選んだ県が今は無くても保つ
  sel.innerHTML = `<option value="">すべての都道府県</option>`
    + prefs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  sel.value = state.pref;
}

function render() {
  $("schTitle").textContent = S.titleOf(state.view, state.date);
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  $("assigneeFilter").value = state.assignee;
  if ($("assigneeFilter").value !== state.assignee) $("assigneeFilter").value = "";
  const { byPref, shown } = visibleEvents();
  renderCounts(byPref); // 担当者の分布を見るため、担当の絞り込みはかけない（都道府県のみ）
  if (state.view === "month") renderMonth(shown);
  else if (state.view === "week") renderWeek(shown);
  else renderDay(shown);
}

// ---------- 初期化 ----------
onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  const myRole = await gateRole(db, user);
  if (!myRole) return;
  applyViewerMode(myRole);
  me = user.email;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));

  $("prevBtn").addEventListener("click", () => go({ date: S.shiftDate(state.view, state.date, -1) }));
  $("nextBtn").addEventListener("click", () => go({ date: S.shiftDate(state.view, state.date, 1) }));
  $("todayBtn").addEventListener("click", () => go({ date: S.todayYmdJst() }));
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => go({ view: b.dataset.view })));
  $("assigneeFilter").addEventListener("change", (e) => {
    e.target.dataset.pref = e.target.value;
    go({ assignee: e.target.value }, false);
  });
  $("prefFilter").addEventListener("change", (e) => go({ pref: e.target.value }, false));
  $("schBody").addEventListener("click", (e) => {
    const t = e.target.closest("[data-day]");
    if (!t) return;
    e.preventDefault();
    go({ view: "day", date: t.dataset.day });
  });
  window.addEventListener("popstate", () => { state = S.parseQuery(location.search, S.todayYmdJst()); render(); });

  const refresh = () => {
    rebuildEvents();
    // 再構築では「いまの絞り込み」を優先する（初期値の URL に引き戻さない）
    $("assigneeFilter").dataset.pref = state.assignee;
    // 選択肢の名前も予定と同じ表示名にそろえる（メールアドレスを出さない）
    fillAssigneeSelect($("assigneeFilter"), allCases.map((c) => ({
      ...c, assignedUserName: S.assigneeNameOf(c.assignedUserId, c.assignedUserName, userNames) })), user.email);
    state.assignee = $("assigneeFilter").value;
    fillPrefSelect();
    $("loadingEl").style.display = "none";
    $("schBody").style.display = "block";
    render();
  };
  // 担当者名の対応表（users の doc id=メール・name）。読めなければ案件の名前だけで補う
  let usersList = [];
  try {
    usersList = (await getDocs(collection(db, "users"))).docs.map((d) => ({ _id: d.id, ...d.data() }));
  } catch (_) { usersList = []; }
  onSnapshot(collection(db, "offices"), (snap) => {
    officesById = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    if (allCases.length) refresh();
  });
  onSnapshot(query(collection(db, "cases"), orderBy("receivedAt", "desc")), (snap) => {
    allCases = snap.docs.map((d) => ({ _id: d.id, ...d.data() })).filter((c) => !c.archived);
    userNames = S.buildUserNames(usersList, allCases);
    refresh();
  });
});
