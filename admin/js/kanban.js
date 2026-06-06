import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot,
  doc, updateDoc, addDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  STATUS_LABELS, STATUS_COLORS, SOURCE_LABELS_SHORT, PHASES, LOST,
  phaseOf, phaseEntryStatus, STALE_DAYS, TERMINAL, ACTIVE_PRE_APPLY,
  daysUntilDeadline, daysSince,
} from "/js/constants.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// カンバン列 = 5フェーズ ＋ 失注（別枠）
const COLUMNS = [
  ...PHASES.map((p) => ({ key: `p${p.id}`, label: p.label, color: p.color, statuses: p.statuses, lost: false })),
  { key: "lost", label: STATUS_LABELS[LOST], color: STATUS_COLORS[LOST], statuses: [LOST], lost: true },
];
function columnOf(status) {
  if (Number(status) === LOST) return "lost";
  const ph = phaseOf(status);
  return ph ? `p${ph.id}` : null;
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = "none"; }, 2500);
}

function updateDeadlineBanner() {
  const days = daysUntilDeadline();
  const banner = document.getElementById("deadlineBanner");
  const text = document.getElementById("deadlineText");
  banner.style.display = "flex";
  if (days <= 3) { banner.className = "deadline-banner danger";
    text.textContent = `申請期限まで残り ${days} 日！今すぐ対応が必要な案件を確認してください`; }
  else if (days <= 30) { banner.className = "deadline-banner warn";
    text.textContent = `申請期限まで残り ${days} 日。未申請の案件を優先してください`; }
  else { banner.className = "deadline-banner safe";
    text.textContent = `令和8年度 助成金申請受付中（期限: 2027年3月12日 — あと ${days} 日）`; }
}

let allCases = [];
let currentUser = null;

function isStale(c) {
  if (TERMINAL.includes(c.status)) return false;
  const d = daysSince(c.updatedAt);
  return d !== null && d >= STALE_DAYS;
}

function renderAlerts() {
  const unassigned = allCases.filter((c) => c.status === 1 && !c.assignedUserId).length;
  const stale = allCases.filter(isStale).length;
  const deadlineNear = daysUntilDeadline() <= 30
    ? allCases.filter((c) => ACTIVE_PRE_APPLY.includes(c.status)).length : 0;
  const chips = [
    { cls: unassigned > 0 ? "warn" : "info", icon: "ti-user-question", num: unassigned, label: "未割当の新規案件" },
    { cls: deadlineNear > 0 ? "danger" : "info", icon: "ti-clock-exclamation", num: deadlineNear, label: "未申請（期限対応が必要）" },
    { cls: stale > 0 ? "warn" : "info", icon: "ti-alert-triangle", num: stale, label: `停滞案件（${STALE_DAYS}日以上 未更新）` },
  ];
  document.getElementById("alertBar").innerHTML = chips.map((c) => `
    <div class="alert-chip ${c.cls}"><i class="ti ${c.icon}" aria-hidden="true"></i>
      <div><div class="alert-num">${c.num}</div><div class="alert-label">${c.label}</div></div></div>`).join("");
}

function filteredCases() {
  const search = document.getElementById("searchInput").value.toLowerCase();
  const sourceFilter = document.getElementById("sourceFilter").value;
  return allCases.filter((c) => {
    const ms = !search || (c.officeName || "").toLowerCase().includes(search)
      || (c.corpName || "").toLowerCase().includes(search)
      || (c.contactName || "").toLowerCase().includes(search);
    const mo = !sourceFilter || c.source === sourceFilter;
    return ms && mo;
  });
}

// フェーズ内に複数サブ状態 → セレクトで変更可。単一 → ラベルチップ。
function substatusControl(c, col) {
  if (col.statuses.length > 1) {
    const opts = col.statuses.map((s) =>
      `<option value="${s}" ${s === c.status ? "selected" : ""}>${escHtml(STATUS_LABELS[s])}</option>`).join("");
    return `<select class="substatus" data-id="${c._id}" title="サブ状態を変更"
      onpointerdown="event.stopPropagation()" onmousedown="event.stopPropagation()">${opts}</select>`;
  }
  return `<span class="substatus-chip" style="--c:${col.color}">${escHtml(STATUS_LABELS[c.status] || "")}</span>`;
}

function cardHtml(c, col) {
  const since = daysSince(c.updatedAt);
  const stale = isStale(c);
  const src = SOURCE_LABELS_SHORT[c.source];
  return `
    <div class="kanban-card ${stale ? "stale" : ""}" draggable="true" data-id="${c._id}" data-status="${c.status}">
      <div class="kanban-card-num">#${c.caseNumber || "—"}${src ? " · " + src : ""}</div>
      <div class="kanban-card-office">${escHtml(c.officeName || "—")}</div>
      <div class="kanban-card-sub">${substatusControl(c, col)}</div>
      <div class="kanban-card-meta">
        <span><i class="ti ti-user" aria-hidden="true"></i> ${escHtml(c.assignedUserName || "未割当")}</span>
        ${since !== null ? `<span class="${stale ? "stale-flag" : ""}">${stale ? "停滞 " : ""}${since}日前</span>` : ""}
      </div>
    </div>`;
}

function renderBoard() {
  const cases = filteredCases();
  const byCol = {};
  COLUMNS.forEach((col) => { byCol[col.key] = []; });
  cases.forEach((c) => { const k = columnOf(c.status); if (k && byCol[k]) byCol[k].push(c); });
  COLUMNS.forEach((col) => byCol[col.key].sort((a, b) => (a.status - b.status) || ((b.caseNumber || 0) - (a.caseNumber || 0))));

  const board = document.getElementById("kanbanBoard");
  board.classList.add("phase-view");
  board.innerHTML = COLUMNS.map((col) => {
    const cards = byCol[col.key] || [];
    return `
    <div class="kanban-col ${col.lost ? "is-lost" : ""}" data-col="${col.key}">
      <div class="kanban-col-header">
        <span class="kanban-col-title"><span class="dot" style="background:${col.color}"></span>${escHtml(col.label)}</span>
        <span class="kanban-col-count">${cards.length}</span>
      </div>
      <div class="kanban-col-body" data-col="${col.key}">${cards.map((c) => cardHtml(c, col)).join("")}</div>
    </div>`;
  }).join("");
  wireInteractions();
}

let draggedId = null;
function wireInteractions() {
  document.querySelectorAll(".kanban-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggedId = card.dataset.id; card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); draggedId = null; });
    card.addEventListener("click", (e) => {
      if (e.target.closest(".substatus")) return; // セレクト操作は遷移しない
      location.href = `/case-detail.html?id=${card.dataset.id}`;
    });
  });
  document.querySelectorAll(".substatus").forEach((sel) => {
    sel.addEventListener("change", () => changeStatus(sel.dataset.id, Number(sel.value)));
  });
  document.querySelectorAll(".kanban-col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drag-over"); });
    col.addEventListener("drop", (e) => {
      e.preventDefault(); col.classList.remove("drag-over");
      const id = draggedId || e.dataTransfer.getData("text/plain");
      if (!id) return;
      const c = allCases.find((x) => x._id === id);
      if (!c) return;
      const key = col.dataset.col;
      if (columnOf(c.status) === key) return; // 同フェーズ内はサブ状態セレクトで変更
      const target = key === "lost" ? LOST : phaseEntryStatus(Number(key.slice(1)));
      if (target) changeStatus(id, target);
    });
    col.querySelector(".kanban-col-body").addEventListener("dragover", (e) => e.preventDefault());
  });
}

async function changeStatus(id, newStatus) {
  const c = allCases.find((x) => x._id === id);
  if (!c || c.status === newStatus) return;
  const prev = c.status;
  try {
    await updateDoc(doc(db, "cases", id), { status: newStatus, updatedAt: serverTimestamp() });
    await addDoc(collection(db, "activities"), {
      caseId: id, type: "memo", occurredAt: serverTimestamp(),
      userId: currentUser.uid, userName: currentUser.displayName || currentUser.email,
      subject: `ステータス変更 ${STATUS_LABELS[prev]} → ${STATUS_LABELS[newStatus]}`,
      body: "（カンバンで変更）", attachmentUrls: [],
    });
    toast(`#${c.caseNumber} ${c.officeName} → ${STATUS_LABELS[newStatus]}`);
  } catch (e) {
    toast(`変更に失敗しました: ${e.message}`);
  }
}

// 初期化
onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  if (!(await gateRole(db, user))) return;
  currentUser = user;
  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click",
    () => signOut(auth).then(() => location.href = "/index.html"));
  document.getElementById("searchInput").addEventListener("input", renderBoard);
  document.getElementById("sourceFilter").addEventListener("change", renderBoard);
  updateDeadlineBanner();

  const q = query(collection(db, "cases"), orderBy("receivedAt", "desc"));
  onSnapshot(q, (snap) => {
    allCases = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    document.getElementById("loadingEl").style.display = "none";
    document.getElementById("kanbanBoard").style.display = "flex";
    renderAlerts();
    renderBoard();
  });
});
