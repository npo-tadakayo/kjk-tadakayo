import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot,
  addDoc, serverTimestamp, doc, getDoc, runTransaction }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { gateRole } from "/js/role.js";
import {
  STATUS_LABELS, SOURCE_LABELS, PHASES, LOST,
  DEADLINE, daysUntilDeadline, resolveDeadline, deadlineLabel,
  ARCHIVE_REASONS, computeDuplicateGroups,
} from "/js/constants.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = "none"; }, 2500);
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

// ステータス絞り込みをフェーズ別 optgroup で生成（C1/A1）
function populateStatusFilter() {
  const sel = document.getElementById("statusFilter");
  const groups = PHASES.map((p) =>
    `<optgroup label="${p.label}">` +
    p.statuses.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join("") +
    `</optgroup>`).join("");
  sel.innerHTML = `<option value="">すべてのステータス</option>${groups}` +
    `<optgroup label="その他"><option value="${LOST}">${STATUS_LABELS[LOST]}</option></optgroup>`;
}

let deadline = DEADLINE;
function updateDeadlineBanner() {
  const days = daysUntilDeadline(deadline);
  const banner = document.getElementById("deadlineBanner");
  const text = document.getElementById("deadlineText");
  banner.style.display = "flex";
  if (days <= 3) { banner.className = "deadline-banner danger";
    text.textContent = `申請期限まで残り ${days} 日！今すぐ対応が必要な案件を確認してください`; }
  else if (days <= 14) { banner.className = "deadline-banner warn";
    text.textContent = `申請期限まで残り ${days} 日。再申請の余裕がなくなります。早めの申請を`; }
  else if (days <= 30) { banner.className = "deadline-banner warn";
    text.textContent = `申請期限まで残り ${days} 日。書類は揃っていますか？`; }
  else { banner.className = "deadline-banner safe";
    text.textContent = `令和8年度 助成金申請受付中（期限: ${deadlineLabel(deadline)} — あと ${days} 日）`; }
}

let allCases = [];
let sortState = { field: "receivedAt", dir: "desc" };

const NUMERIC_FIELDS = ["caseNumber", "status"];
const DATE_FIELDS = ["receivedAt", "updatedAt"];
function sortValue(c, f) {
  if (DATE_FIELDS.includes(f)) { const v = c[f]; return v?.toMillis ? v.toMillis() : (v ? new Date(v).getTime() : 0); }
  if (NUMERIC_FIELDS.includes(f)) return Number(c[f]) || 0;
  if (f === "source") return SOURCE_LABELS[c.source] || c.source || "";
  if (f === "assignedUserName") return c.assignedUserName || "";
  return (c[f] || "").toString();
}
function sortCases(arr) {
  const { field, dir } = sortState;
  const m = dir === "asc" ? 1 : -1;
  return [...arr].sort((a, b) => {
    const va = sortValue(a, field), vb = sortValue(b, field);
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * m;
    return String(va).localeCompare(String(vb), "ja") * m;
  });
}
function updateSortIndicators() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const ind = th.querySelector(".sort-ind");
    if (!ind) return;
    ind.textContent = th.dataset.sort === sortState.field ? (sortState.dir === "asc" ? "▲" : "▼") : "";
  });
}

function currentFilters() {
  return {
    search: document.getElementById("searchInput").value.toLowerCase(),
    statusFilter: document.getElementById("statusFilter").value,
    sourceFilter: document.getElementById("sourceFilter").value,
    showArchived: !!document.getElementById("showArchived")?.checked,
  };
}
function matchFilters(c, { search, statusFilter, sourceFilter, showArchived }) {
  // 対象外（テスト/重複/スパム/採用しない）は既定で非表示。チェック時のみ表示。
  if (c.archived && !showArchived) return false;
  const matchSearch = !search ||
    (c.officeName || "").toLowerCase().includes(search) ||
    (c.corpName || "").toLowerCase().includes(search) ||
    (c.contactName || "").toLowerCase().includes(search);
  const matchStatus = !statusFilter || String(c.status) === statusFilter;
  const matchSource = !sourceFilter || c.source === sourceFilter;
  return matchSearch && matchStatus && matchSource;
}

function renderCases() {
  const f = currentFilters();
  const filtered = sortCases(allCases.filter((c) => matchFilters(c, f)));

  const tbody = document.getElementById("casesBody");
  const table = document.getElementById("casesTable");
  const empty = document.getElementById("emptyEl");
  document.getElementById("loadingEl").style.display = "none";

  if (filtered.length === 0) {
    table.style.display = "none";
    empty.style.display = "block";
    // B1: 「条件に合致しない」と「そもそも0件」を区別
    const hasFilter = !!(f.search || f.statusFilter || f.sourceFilter);
    const msg = empty.querySelector("p");
    if (msg) msg.textContent = hasFilter
      ? "条件に合う案件がありません（検索・絞り込みを変えてみてください）"
      : (allCases.length === 0 ? "案件がまだ登録されていません" : "案件がありません");
    return;
  }

  table.style.display = "table";
  empty.style.display = "none";

  tbody.innerHTML = filtered.map((c) => `
    <tr tabindex="0" role="link" data-href="/case-detail.html?id=${c._id}" aria-label="案件 #${c.caseNumber || ""} ${escHtml(c.officeName || "")} の詳細を開く"${c.archived ? ' style="opacity:.55"' : ""}>
      <td><strong>#${c.caseNumber || "—"}</strong></td>
      <td>
        <div style="font-weight:500">${escHtml(c.officeName || "—")}${c.archived ? archivedBadge(c) : ""}</div>
        ${c.corpName ? `<div style="font-size:12px;color:var(--color-ink-muted)">${escHtml(c.corpName)}</div>` : ""}
      </td>
      <td>${SOURCE_LABELS[c.source] || c.source || "—"}</td>
      <td><span class="badge badge-${c.status}">${STATUS_LABELS[c.status] || "—"}</span></td>
      <td>${escHtml(c.assignedUserName || "未割当")}</td>
      <td>${formatDate(c.receivedAt)}</td>
      <td>${formatDate(c.updatedAt)}</td>
    </tr>
  `).join("");
}

function archivedBadge(c) {
  const label = ARCHIVE_REASONS[c.archivedReason] || "対象外";
  return ` <span style="font-size:11px;font-weight:600;color:#8a6d3b;background:#FCF3E6;border:1px solid #e6cfa0;border-radius:10px;padding:1px 7px;margin-left:6px">対象外・${escHtml(label)}</span>`;
}

// 重複候補バナー（アクティブ案件のみ対象）
function renderDuplicateBanner() {
  const banner = document.getElementById("dupBanner");
  if (!banner) return;
  const groups = computeDuplicateGroups(allCases.filter((c) => !c.archived));
  if (!groups.length) { banner.style.display = "none"; return; }
  const n = groups.reduce((s, g) => s + g.length, 0);
  banner.style.display = "flex";
  document.getElementById("dupBannerText").textContent =
    `重複の可能性がある案件が ${groups.length} 組（計 ${n} 件）あります。統合は各案件の詳細画面から行えます。`;
  banner._groups = groups;
}

function openDupModal() {
  const groups = document.getElementById("dupBanner")?._groups || [];
  const body = document.getElementById("dupModalBody");
  body.innerHTML = groups.map((g, i) => `
    <div style="border:1px solid var(--color-line);border-radius:8px;padding:10px 12px;margin-bottom:10px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">重複候補 ${i + 1}（${g.length}件）</div>
      ${g.map((c) => `
        <a href="/case-detail.html?id=${c._id}" style="display:flex;gap:10px;align-items:center;padding:6px 4px;text-decoration:none;color:inherit;border-top:1px solid var(--color-line)">
          <strong style="min-width:46px">#${c.caseNumber || "—"}</strong>
          <span style="flex:1">${escHtml(c.officeName || "—")}${c.corpName ? ` <span style="color:var(--color-ink-muted);font-size:12px">${escHtml(c.corpName)}</span>` : ""}</span>
          <span style="font-size:12px;color:var(--color-ink-muted)">${SOURCE_LABELS[c.source] || c.source || ""}</span>
          <span class="badge badge-${c.status}" style="font-size:11px">${STATUS_LABELS[c.status] || ""}</span>
        </a>`).join("")}
    </div>`).join("");
  document.getElementById("dupModal").classList.add("open");
}
function closeDupModal() { document.getElementById("dupModal").classList.remove("open"); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 案件行（tr[data-href]）をマウス／キーボード両方で開けるように（WCAG 2.1.1 キーボード操作）
document.addEventListener("click", (e) => {
  const tr = e.target.closest('tr[data-href]');
  if (tr) location.href = tr.dataset.href;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const tr = e.target.closest('tr[data-href]');
    if (tr && document.activeElement === tr) { e.preventDefault(); location.href = tr.dataset.href; }
  }
});

function getFilteredCases() {
  const f = currentFilters();
  return allCases.filter((c) => matchFilters(c, f));
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmtFull(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function exportCsv() {
  const rows = getFilteredCases();
  if (rows.length === 0) { toast("出力対象の案件がありません"); return; }
  const headers = ["案件番号","事業所名","法人名","担当者","電話","メール","流入元",
    "ステータス","担当スタッフ","補助金区分","想定補助額","受信日時","最終更新"];
  const lines = [headers.join(",")];
  rows.forEach((c) => {
    lines.push([
      c.caseNumber || "", c.officeName || "", c.corpName || "", c.contactName || "",
      c.contactPhone || "", c.contactEmail || "", SOURCE_LABELS[c.source] || c.source || "",
      STATUS_LABELS[c.status] || "", c.assignedUserName || "未割当",
      c.subsidyCategory || "", c.expectedSubsidyAmount || "",
      fmtFull(c.receivedAt), fmtFull(c.updatedAt),
    ].map(csvCell).join(","));
  });
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toLocaleDateString("ja-JP").replace(/\//g, "");
  a.href = url; a.download = `案件一覧_${today}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function getNextCaseNumber() {
  const counterRef = doc(db, "_counters", "cases");
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists() ? snap.data().value : 0) + 1;
    tx.set(counterRef, { value: next });
    return next;
  });
}

function setFieldError(id, msg) {
  const el = document.getElementById(id + "Err");
  if (el) el.textContent = msg || "";
  const input = document.getElementById(id);
  if (input) input.classList.toggle("has-error", !!msg);
}

async function createCase(user) {
  const officeName = document.getElementById("officeName").value.trim();
  setFieldError("officeName", "");
  if (!officeName) {
    setFieldError("officeName", "事業所名を入力してください");
    document.getElementById("officeName").focus();
    return;
  }

  const btn = document.getElementById("saveNewCaseBtn");
  btn.disabled = true;
  btn.textContent = "登録中...";

  try {
    const now = serverTimestamp();
    const corpName = document.getElementById("corpName").value.trim();
    const officeRef = await addDoc(collection(db, "offices"), {
      corpName, officeName,
      phone: document.getElementById("contactPhone").value.trim(),
      createdAt: now, updatedAt: now,
    });
    const caseNumber = await getNextCaseNumber();
    const caseRef = await addDoc(collection(db, "cases"), {
      caseNumber, officeId: officeRef.id, officeName, corpName,
      contactName: document.getElementById("contactName").value.trim(),
      contactEmail: document.getElementById("contactEmail").value.trim(),
      contactPhone: document.getElementById("contactPhone").value.trim(),
      source: "manual", status: 1, assignedUserId: null, assignedUserName: null,
      receivedAt: now, updatedAt: now, cardReaders: [],
      subsidyCategory: null, expectedSubsidyAmount: null, lostReason: null,
      orderedAt: null, completedAt: null,
    });
    const memo = document.getElementById("newCaseMemo").value.trim();
    if (memo) {
      await addDoc(collection(db, "activities"), {
        caseId: caseRef.id, type: "memo", occurredAt: now,
        userId: user.uid, userName: user.displayName || user.email,
        subject: "初回メモ", body: memo, attachmentUrls: [],
      });
    }
    location.href = `/case-detail.html?id=${caseRef.id}`;
  } catch (e) {
    toast(`登録に失敗しました: ${e.message}`);
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-check"></i>登録する';
  }
}

function openModal() {
  document.getElementById("newCaseModal").classList.add("open");
  document.getElementById("officeName").focus();
}
function closeModal() {
  document.getElementById("newCaseModal").classList.remove("open");
  setFieldError("officeName", "");
  ["corpName","officeName","contactName","contactPhone","contactEmail","newCaseMemo"]
    .forEach((id) => { document.getElementById(id).value = ""; });
}

// 初期化
onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  if (!(await gateRole(db, user))) return;

  document.getElementById("userEmail").textContent = user.displayName || user.email;
  populateStatusFilter();

  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  document.getElementById("newCaseBtn").addEventListener("click", openModal);
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
  document.getElementById("saveNewCaseBtn").addEventListener("click", () => createCase(user));
  document.getElementById("newCaseModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  document.getElementById("searchInput").addEventListener("input", renderCases);
  document.getElementById("statusFilter").addEventListener("change", renderCases);
  document.getElementById("sourceFilter").addEventListener("change", renderCases);
  document.getElementById("showArchived")?.addEventListener("change", renderCases);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
  document.getElementById("dupCheckBtn")?.addEventListener("click", openDupModal);
  document.getElementById("dupModalClose")?.addEventListener("click", closeDupModal);
  document.getElementById("dupModal")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeDupModal(); });
  document.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const f = th.dataset.sort;
    if (sortState.field === f) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    else sortState = { field: f, dir: DATE_FIELDS.includes(f) || NUMERIC_FIELDS.includes(f) ? "desc" : "asc" };
    updateSortIndicators();
    renderCases();
  }));
  updateSortIndicators();
  updateDeadlineBanner();
  try { const ss = await getDoc(doc(db, "appConfig", "settings")); if (ss.exists()) { deadline = resolveDeadline(ss.data()); updateDeadlineBanner(); } } catch (_) {}

  const q = query(collection(db, "cases"), orderBy("receivedAt", "desc"));
  onSnapshot(q, (snap) => {
    allCases = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    renderCases();
    renderDuplicateBanner();
  });
});
