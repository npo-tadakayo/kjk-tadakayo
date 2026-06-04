import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot,
  doc, updateDoc, addDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const STATUS_LABELS = {
  1: "新規受信", 2: "確認中", 3: "受注確定", 4: "失注",
  5: "担当者決定", 6: "事前準備中", 7: "伴走支援待ち",
  8: "伴走支援実施済", 9: "書類準備完了・申請ガイド中",
  10: "申請完了・採択待ち", 11: "採択・入金待ち",
  12: "アフターフォロー中", 13: "案件完了",
};
// パイプライン順（失注は末尾）
const COLUMN_ORDER = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 4];
const STATUS_COLORS = {
  1:"#1d4ed8", 2:"#0369a1", 3:"#15803d", 4:"#6b7280", 5:"#0f766e",
  6:"#c2410c", 7:"#b45309", 8:"#4d7c0f", 9:"#7c3aed", 10:"#a21caf",
  11:"#be185d", 12:"#be123c", 13:"#065f46",
};
const SOURCE_LABELS = { lp_inquiry: "LP", mitsumori_quote: "見積", manual: "手動" };

const DEADLINE = new Date("2027-03-12T23:59:59+09:00");
const STALE_DAYS = 7;            // 停滞とみなす最終更新からの日数
const TERMINAL = [4, 13];        // 失注・完了（停滞・アラート対象外）
const ACTIVE_PRE_APPLY = [1, 2, 3, 5, 6, 7, 8, 9]; // 未申請の進行中

function daysUntilDeadline() {
  return Math.ceil((DEADLINE - new Date()) / 86400000);
}
function daysSince(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function escHtml(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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
  const unassigned = allCases.filter(c => c.status === 1 && !c.assignedUserId).length;
  const stale = allCases.filter(isStale).length;
  const deadlineNear = daysUntilDeadline() <= 30
    ? allCases.filter(c => ACTIVE_PRE_APPLY.includes(c.status)).length : 0;

  const chips = [
    { cls: unassigned > 0 ? "warn" : "info", icon: "ti-user-question",
      num: unassigned, label: "未割当の新規案件" },
    { cls: deadlineNear > 0 ? "danger" : "info", icon: "ti-clock-exclamation",
      num: deadlineNear, label: "未申請（期限対応が必要）" },
    { cls: stale > 0 ? "warn" : "info", icon: "ti-alert-triangle",
      num: stale, label: `停滞案件（${STALE_DAYS}日以上 未更新）` },
  ];
  document.getElementById("alertBar").innerHTML = chips.map(c => `
    <div class="alert-chip ${c.cls}">
      <i class="ti ${c.icon}" aria-hidden="true"></i>
      <div><div class="alert-num">${c.num}</div><div class="alert-label">${c.label}</div></div>
    </div>`).join("");
}

function renderBoard() {
  const search = document.getElementById("searchInput").value.toLowerCase();
  const sourceFilter = document.getElementById("sourceFilter").value;

  const filtered = allCases.filter(c => {
    const matchSearch = !search ||
      (c.officeName || "").toLowerCase().includes(search) ||
      (c.corpName || "").toLowerCase().includes(search) ||
      (c.contactName || "").toLowerCase().includes(search);
    const matchSource = !sourceFilter || c.source === sourceFilter;
    return matchSearch && matchSource;
  });

  const byStatus = {};
  COLUMN_ORDER.forEach(s => { byStatus[s] = []; });
  filtered.forEach(c => { (byStatus[c.status] || (byStatus[c.status] = [])).push(c); });

  const board = document.getElementById("kanbanBoard");
  board.innerHTML = COLUMN_ORDER.map(s => {
    const cards = byStatus[s] || [];
    return `
    <div class="kanban-col" data-status="${s}">
      <div class="kanban-col-header">
        <span class="kanban-col-title"><span class="dot" style="background:${STATUS_COLORS[s]}"></span>${STATUS_LABELS[s]}</span>
        <span class="kanban-col-count">${cards.length}</span>
      </div>
      <div class="kanban-col-body" data-status="${s}">
        ${cards.map(cardHtml).join("")}
      </div>
    </div>`;
  }).join("");

  wireDnd();
}

function cardHtml(c) {
  const since = daysSince(c.updatedAt);
  const stale = isStale(c);
  return `
    <div class="kanban-card ${stale ? "stale" : ""}" draggable="true"
         data-id="${c._id}" data-status="${c.status}">
      <div class="kanban-card-num">#${c.caseNumber || "—"} ${SOURCE_LABELS[c.source] ? "· " + SOURCE_LABELS[c.source] : ""}</div>
      <div class="kanban-card-office">${escHtml(c.officeName || "—")}</div>
      <div class="kanban-card-meta">
        <span><i class="ti ti-user" aria-hidden="true"></i> ${escHtml(c.assignedUserName || "未割当")}</span>
        ${since !== null ? `<span class="${stale ? "stale-flag" : ""}">${stale ? "停滞 " : ""}${since}日前</span>` : ""}
      </div>
    </div>`;
}

let draggedId = null;

function wireDnd() {
  document.querySelectorAll(".kanban-card").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      draggedId = card.dataset.id;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      draggedId = null;
    });
    card.addEventListener("click", () => {
      location.href = `/case-detail.html?id=${card.dataset.id}`;
    });
  });

  document.querySelectorAll(".kanban-col").forEach(col => {
    const body = col.querySelector(".kanban-col-body");
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove("drag-over");
    });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = draggedId || e.dataTransfer.getData("text/plain");
      const newStatus = Number(col.dataset.status);
      if (id) changeStatus(id, newStatus);
    });
    // bodyにもdropを通す
    body.addEventListener("dragover", (e) => e.preventDefault());
  });
}

async function changeStatus(id, newStatus) {
  const c = allCases.find(x => x._id === id);
  if (!c || c.status === newStatus) return;
  const prev = c.status;
  try {
    await updateDoc(doc(db, "cases", id), {
      status: newStatus,
      updatedAt: serverTimestamp(),
    });
    await addDoc(collection(db, "activities"), {
      caseId: id,
      type: "memo",
      occurredAt: serverTimestamp(),
      userId: currentUser.uid,
      userName: currentUser.displayName || currentUser.email,
      subject: `ステータス変更 ${STATUS_LABELS[prev]} → ${STATUS_LABELS[newStatus]}`,
      body: "（カンバンで変更）",
      attachmentUrls: [],
    });
    toast(`#${c.caseNumber} ${c.officeName} → ${STATUS_LABELS[newStatus]}`);
  } catch (e) {
    toast(`変更に失敗しました: ${e.message}`);
  }
}

// 初期化
onAuthStateChanged(auth, (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) {
    location.href = "/index.html";
    return;
  }
  currentUser = user;
  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click",
    () => signOut(auth).then(() => location.href = "/index.html"));
  document.getElementById("searchInput").addEventListener("input", renderBoard);
  document.getElementById("sourceFilter").addEventListener("change", renderBoard);

  updateDeadlineBanner();

  const q = query(collection(db, "cases"), orderBy("receivedAt", "desc"));
  onSnapshot(q, (snap) => {
    allCases = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    document.getElementById("loadingEl").style.display = "none";
    document.getElementById("kanbanBoard").style.display = "flex";
    renderAlerts();
    renderBoard();
  });
});
