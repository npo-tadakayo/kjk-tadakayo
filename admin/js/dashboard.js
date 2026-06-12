import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot, doc, getDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { STATUS_LABELS, STATUS_COLORS, SOURCE_LABELS, PHASES, LOST, DEADLINE, daysUntilDeadline, resolveDeadline, deadlineLabel }
  from "/js/constants.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ファネル用グルーピング（ダッシュボード固有）
const ENGAGED = [3, 5, 6, 7, 8, 9, 10, 11, 12, 13]; // 受注確定以降
const APPLIED = [10, 11, 12, 13];
const ADOPTED = [11, 12, 13];

function yen(n) { return "¥" + Number(n || 0).toLocaleString("ja-JP"); }

let deadline = DEADLINE;
function updateDeadlineBanner() {
  const days = daysUntilDeadline(deadline);
  const banner = document.getElementById("deadlineBanner");
  banner.style.display = "flex";
  banner.className = days <= 3 ? "deadline-banner danger" : days <= 30 ? "deadline-banner warn" : "deadline-banner safe";
  document.getElementById("deadlineText").textContent =
    `令和8年度 助成金申請受付中（期限: ${deadlineLabel(deadline)} — あと ${days} 日）`;
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

// 月次の新規案件推移（直近6か月・receivedAt 基準）— B3
function monthlyTrend(cases) {
  const now = new Date();
  const months = [];
  const idx = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    idx[key] = months.length;
    months.push({ key, label: `${d.getMonth() + 1}月`, count: 0 });
  }
  cases.forEach((c) => {
    const ts = c.receivedAt; if (!ts) return;
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (key in idx) months[idx[key]].count++;
  });
  return months;
}
function renderTrend(cases) {
  const months = monthlyTrend(cases);
  const max = Math.max(1, ...months.map((m) => m.count));
  const el = document.getElementById("trendChart");
  if (months.every((m) => m.count === 0)) {
    el.innerHTML = `<div class="empty-state" style="padding:20px"><i class="ti ti-chart-bar" aria-hidden="true"></i><p>直近6か月の新規案件はまだありません</p></div>`;
    return;
  }
  el.innerHTML = `<div style="display:flex;align-items:flex-end;gap:10px;height:150px">${months.map((m) => {
    const h = Math.max(2, Math.round((m.count / max) * 120));
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%">
      <div style="font-size:12px;font-weight:600">${m.count}</div>
      <div style="width:100%;max-width:44px;height:${h}px;background:linear-gradient(180deg,#4a86c4,#3a6e9e);border-radius:4px 4px 0 0" title="${m.label} ${m.count}件"></div>
      <div style="font-size:12px;color:var(--color-ink-muted)">${m.label}</div>
    </div>`;
  }).join("")}</div>`;
}

function render(cases) {
  const total = cases.length;
  const cnt = (arr) => cases.filter((c) => arr.includes(c.status)).length;
  const engaged = cnt(ENGAGED);
  const applied = cnt(APPLIED);
  const adopted = cnt(ADOPTED);
  const completed = cases.filter((c) => c.status === 13).length;
  const lost = cases.filter((c) => c.status === LOST).length;

  const subsidyTotal = cases.filter((c) => c.status !== LOST)
    .reduce((s, c) => s + (Number(c.expectedSubsidyAmount) || 0), 0);
  let bt = 0, usb = 0;
  cases.filter((c) => c.status !== LOST).forEach((c) => {
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

  // フェーズ別（5フェーズ＋失注）— A1
  const phaseRows = PHASES.map((p) =>
    barRow(p.label, cases.filter((c) => p.statuses.includes(c.status)).length, total, p.color));
  phaseRows.push(barRow(STATUS_LABELS[LOST], lost, total, STATUS_COLORS[LOST]));
  document.getElementById("statusBreakdown").innerHTML = phaseRows.join("");

  // 流入元別
  const sources = ["lp_inquiry", "mitsumori_quote", "manual"];
  const srcColors = { lp_inquiry: "#3a6e9e", mitsumori_quote: "#238e3a", manual: "#9a8e78" };
  document.getElementById("sourceBreakdown").innerHTML =
    sources.map((s) => barRow(SOURCE_LABELS[s], cases.filter((c) => c.source === s).length, total, srcColors[s])).join("");

  renderTrend(cases);
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  if (!(await gateRole(db, user))) return;
  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click",
    () => signOut(auth).then(() => location.href = "/index.html"));
  updateDeadlineBanner();
  try { const ss = await getDoc(doc(db, "appConfig", "settings")); if (ss.exists()) { deadline = resolveDeadline(ss.data()); updateDeadlineBanner(); } } catch (_) {}

  const q = query(collection(db, "cases"), orderBy("receivedAt", "desc"));
  onSnapshot(q, (snap) => {
    const cases = snap.docs.map((d) => ({ _id: d.id, ...d.data() })).filter((c) => !c.archived);
    document.getElementById("loadingEl").style.display = "none";
    document.getElementById("dashContent").style.display = "block";
    render(cases);
  });
});
