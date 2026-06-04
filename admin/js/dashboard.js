import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot }
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
const STATUS_ORDER = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 4];
const STATUS_COLORS = {
  1:"#1d4ed8",2:"#0369a1",3:"#15803d",4:"#6b7280",5:"#0f766e",6:"#c2410c",
  7:"#b45309",8:"#4d7c0f",9:"#7c3aed",10:"#a21caf",11:"#be185d",12:"#be123c",13:"#065f46",
};
const SOURCE_LABELS = { lp_inquiry: "LP問い合わせ", mitsumori_quote: "見積もり成約", manual: "手動登録" };

const DEADLINE = new Date("2027-03-12T23:59:59+09:00");
const ENGAGED = [3, 5, 6, 7, 8, 9, 10, 11, 12, 13]; // 受注確定以降
const APPLIED = [10, 11, 12, 13];
const ADOPTED = [11, 12, 13];

function yen(n) { return "¥" + Number(n || 0).toLocaleString("ja-JP"); }

function updateDeadlineBanner() {
  const days = Math.ceil((DEADLINE - new Date()) / 86400000);
  const banner = document.getElementById("deadlineBanner");
  banner.style.display = "flex";
  banner.className = days <= 3 ? "deadline-banner danger" : days <= 30 ? "deadline-banner warn" : "deadline-banner safe";
  document.getElementById("deadlineText").textContent =
    `令和8年度 助成金申請受付中（期限: 2027年3月12日 — あと ${days} 日）`;
}

function statCard(icon, num, label, color) {
  return `<div class="stat-card">
    <div class="stat-icon" style="color:${color}"><i class="ti ${icon}" aria-hidden="true"></i></div>
    <div><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>
  </div>`;
}

function barRow(label, count, total, color) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return `<div class="bar-row">
    <div class="bar-label">${label}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="bar-count">${count}</div>
  </div>`;
}

function render(cases) {
  const total = cases.length;
  const cnt = (arr) => cases.filter((c) => arr.includes(c.status)).length;
  const engaged = cnt(ENGAGED);
  const applied = cnt(APPLIED);
  const adopted = cnt(ADOPTED);
  const completed = cases.filter((c) => c.status === 13).length;
  const lost = cases.filter((c) => c.status === 4).length;

  // 補助金想定額合計（失注を除く）
  const subsidyTotal = cases.filter((c) => c.status !== 4)
    .reduce((s, c) => s + (Number(c.expectedSubsidyAmount) || 0), 0);
  // カードリーダー台数（失注を除く）
  let bt = 0, usb = 0;
  cases.filter((c) => c.status !== 4).forEach((c) => {
    (c.cardReaders || []).forEach((r) => {
      const q = (Number(r.subsidyQty) || 0) + (Number(r.extraQty) || 0);
      if (r.type === "BT") bt += q; else if (r.type === "USB") usb += q;
    });
  });

  document.getElementById("statGrid").innerHTML = [
    statCard("ti-inbox", total, "総案件数", "#3a6e9e"),
    statCard("ti-checkbox", engaged, "受注（確定以降）", "#238e3a"),
    statCard("ti-file-check", applied, "申請完了以降", "#a21caf"),
    statCard("ti-flag-check", completed, "案件完了", "#065f46"),
    statCard("ti-circle-x", lost, "失注", "#6b7280"),
    statCard("ti-cash", yen(subsidyTotal), "想定補助額合計", "#c87a1f"),
    statCard("ti-device-mobile", `BT ${bt} / USB ${usb}`, "カードリーダー台数", "#3a6e9e"),
  ].join("");

  // ファネル
  const funnel = [
    ["問い合わせ・見積もり", total, "#3a6e9e"],
    ["受注確定以降", engaged, "#238e3a"],
    ["申請完了以降", applied, "#a21caf"],
    ["採択以降", adopted, "#be185d"],
    ["案件完了", completed, "#065f46"],
  ];
  document.getElementById("funnelEl").innerHTML =
    funnel.map(([l, n, c]) => barRow(l, n, total, c)).join("");

  // ステータス別
  document.getElementById("statusBreakdown").innerHTML =
    STATUS_ORDER.map((s) => barRow(STATUS_LABELS[s], cases.filter((c) => c.status === s).length, total, STATUS_COLORS[s])).join("");

  // 流入元別
  const sources = ["lp_inquiry", "mitsumori_quote", "manual"];
  const srcColors = { lp_inquiry: "#3a6e9e", mitsumori_quote: "#238e3a", manual: "#9a8e78" };
  document.getElementById("sourceBreakdown").innerHTML =
    sources.map((s) => barRow(SOURCE_LABELS[s], cases.filter((c) => c.source === s).length, total, srcColors[s])).join("");
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) {
    location.href = "/index.html";
    return;
  }
  if (!(await gateRole(db, user))) return;
  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click",
    () => signOut(auth).then(() => location.href = "/index.html"));
  updateDeadlineBanner();

  const q = query(collection(db, "cases"), orderBy("receivedAt", "desc"));
  onSnapshot(q, (snap) => {
    const cases = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    document.getElementById("loadingEl").style.display = "none";
    document.getElementById("dashContent").style.display = "block";
    render(cases);
  });
});
