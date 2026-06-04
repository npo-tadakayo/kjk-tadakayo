import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot,
  addDoc, serverTimestamp, getDocs, limit, doc, runTransaction }
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

const SOURCE_LABELS = {
  lp_inquiry: "LP問い合わせ",
  mitsumori_quote: "見積もり成約",
  manual: "手動登録",
};

// 申請期限: 2027-03-12
const DEADLINE = new Date("2027-03-12T23:59:59+09:00");

function daysUntilDeadline() {
  return Math.ceil((DEADLINE - new Date()) / (1000 * 60 * 60 * 24));
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function updateDeadlineBanner() {
  const days = daysUntilDeadline();
  const banner = document.getElementById("deadlineBanner");
  const text = document.getElementById("deadlineText");
  banner.style.display = "flex";
  if (days <= 3) {
    banner.className = "deadline-banner danger";
    text.textContent = `申請期限まで残り ${days} 日！今すぐ対応が必要な案件を確認してください`;
  } else if (days <= 14) {
    banner.className = "deadline-banner warn";
    text.textContent = `申請期限まで残り ${days} 日。再申請の余裕がなくなります。早めの申請を`;
  } else if (days <= 30) {
    banner.className = "deadline-banner warn";
    text.textContent = `申請期限まで残り ${days} 日。書類は揃っていますか？`;
  } else {
    banner.className = "deadline-banner safe";
    text.textContent = `令和8年度 助成金申請受付中（期限: 2027年3月12日 — あと ${days} 日）`;
  }
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

function renderCases() {
  const search = document.getElementById("searchInput").value.toLowerCase();
  const statusFilter = document.getElementById("statusFilter").value;
  const sourceFilter = document.getElementById("sourceFilter").value;

  const filtered = sortCases(allCases.filter((c) => {
    const matchSearch = !search ||
      (c.officeName || "").toLowerCase().includes(search) ||
      (c.corpName || "").toLowerCase().includes(search) ||
      (c.contactName || "").toLowerCase().includes(search);
    const matchStatus = !statusFilter || String(c.status) === statusFilter;
    const matchSource = !sourceFilter || c.source === sourceFilter;
    return matchSearch && matchStatus && matchSource;
  }));

  const tbody = document.getElementById("casesBody");
  const table = document.getElementById("casesTable");
  const empty = document.getElementById("emptyEl");
  const loading = document.getElementById("loadingEl");

  loading.style.display = "none";

  if (filtered.length === 0) {
    table.style.display = "none";
    empty.style.display = "block";
    return;
  }

  table.style.display = "table";
  empty.style.display = "none";

  tbody.innerHTML = filtered.map((c) => `
    <tr onclick="location.href='/case-detail.html?id=${c._id}'">
      <td><strong>#${c.caseNumber || "—"}</strong></td>
      <td>
        <div style="font-weight:500">${escHtml(c.officeName || "—")}</div>
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 現在の絞り込み結果をCSV出力（Excel対応・UTF-8 BOM付き）
function getFilteredCases() {
  const search = document.getElementById("searchInput").value.toLowerCase();
  const statusFilter = document.getElementById("statusFilter").value;
  const sourceFilter = document.getElementById("sourceFilter").value;
  return allCases.filter((c) => {
    const matchSearch = !search ||
      (c.officeName || "").toLowerCase().includes(search) ||
      (c.corpName || "").toLowerCase().includes(search) ||
      (c.contactName || "").toLowerCase().includes(search);
    const matchStatus = !statusFilter || String(c.status) === statusFilter;
    const matchSource = !sourceFilter || c.source === sourceFilter;
    return matchSearch && matchStatus && matchSource;
  });
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtFull(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit" });
}

function exportCsv() {
  const rows = getFilteredCases();
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
  a.href = url;
  a.download = `案件一覧_${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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

async function createCase(user) {
  const officeName = document.getElementById("officeName").value.trim();
  if (!officeName) {
    alert("事業所名を入力してください");
    return;
  }

  const btn = document.getElementById("saveNewCaseBtn");
  btn.disabled = true;
  btn.textContent = "登録中...";

  try {
    const now = serverTimestamp();
    const officeRef = await addDoc(collection(db, "offices"), {
      corpName: document.getElementById("corpName").value.trim(),
      officeName,
      phone: document.getElementById("contactPhone").value.trim(),
      createdAt: now,
      updatedAt: now,
    });

    const caseNumber = await getNextCaseNumber();

    const caseRef = await addDoc(collection(db, "cases"), {
      caseNumber,
      officeId: officeRef.id,
      officeName,
      corpName: document.getElementById("corpName").value.trim(),
      contactName: document.getElementById("contactName").value.trim(),
      contactEmail: document.getElementById("contactEmail").value.trim(),
      contactPhone: document.getElementById("contactPhone").value.trim(),
      source: "manual",
      status: 1,
      assignedUserId: null,
      assignedUserName: null,
      receivedAt: now,
      updatedAt: now,
      cardReaders: [],
      subsidyCategory: null,
      expectedSubsidyAmount: null,
      lostReason: null,
      orderedAt: null,
      completedAt: null,
    });

    const memo = document.getElementById("newCaseMemo").value.trim();
    if (memo) {
      await addDoc(collection(db, "activities"), {
        caseId: caseRef.id,
        type: "memo",
        occurredAt: now,
        userId: user.uid,
        userName: user.displayName || user.email,
        subject: "初回メモ",
        body: memo,
        attachmentUrls: [],
      });
    }

    closeModal();
    location.href = `/case-detail.html?id=${caseRef.id}`;
  } catch (e) {
    alert(`登録に失敗しました: ${e.message}`);
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
  ["corpName","officeName","contactName","contactPhone","contactEmail","newCaseMemo"]
    .forEach((id) => { document.getElementById(id).value = ""; });
}

// 初期化
onAuthStateChanged(auth, (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) {
    location.href = "/index.html";
    return;
  }

  document.getElementById("userEmail").textContent = user.displayName || user.email;

  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  document.getElementById("newCaseBtn").addEventListener("click", openModal);
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  document.getElementById("cancelModalBtn").addEventListener("click", closeModal);
  document.getElementById("saveNewCaseBtn").addEventListener("click", () => createCase(user));
  document.getElementById("newCaseModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  document.getElementById("searchInput").addEventListener("input", renderCases);
  document.getElementById("statusFilter").addEventListener("change", renderCases);
  document.getElementById("sourceFilter").addEventListener("change", renderCases);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
  document.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const f = th.dataset.sort;
    if (sortState.field === f) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    else sortState = { field: f, dir: DATE_FIELDS.includes(f) || NUMERIC_FIELDS.includes(f) ? "desc" : "asc" };
    updateSortIndicators();
    renderCases();
  }));
  updateSortIndicators();

  updateDeadlineBanner();

  // リアルタイム購読
  const q = query(collection(db, "cases"), orderBy("receivedAt", "desc"));
  onSnapshot(q, (snap) => {
    allCases = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    renderCases();
  });
});
