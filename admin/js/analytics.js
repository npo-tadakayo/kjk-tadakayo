import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { gateRole } from "/js/role.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");

function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._t); t._t = setTimeout(() => { t.style.display = "none"; }, 3000);
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const nf = (n) => Number(n || 0).toLocaleString("ja-JP");
const pct = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;
const pos = (n) => (n ? Number(n).toFixed(1) : "—");

function kpiCard(label, value, sub) {
  return `<div class="card" style="padding:14px 16px">
    <div style="font-size:12px;color:var(--color-ink-muted)">${label}</div>
    <div style="font-size:24px;font-weight:700;font-family:'Noto Serif JP',serif;line-height:1.3">${value}</div>
    ${sub ? `<div style="font-size:11px;color:var(--color-ink-muted)">${sub}</div>` : ""}
  </div>`;
}

function renderKpis(s) {
  const t = s.totals || {};
  document.getElementById("kpiGrid").innerHTML = [
    kpiCard("閲覧数（PV）", nf(t.pv), "28日合計"),
    kpiCard("訪問者", nf(t.users), "28日・ユニーク"),
    kpiCard("セッション", nf(t.sessions), "28日合計"),
    kpiCard("検索クリック", nf(t.clicks), "Search Console"),
    kpiCard("検索表示回数", nf(t.impressions), "Search Console"),
    kpiCard("平均CTR", pct(t.ctr), "クリック率"),
    kpiCard("平均掲載順位", pos(t.position), "検索結果"),
  ].join("");
}

// PV推移の棒グラフ（SVG）
function renderPvChart(daily) {
  const el = document.getElementById("pvChart");
  if (!daily || !daily.length) { el.innerHTML = `<p style="color:var(--color-ink-muted);font-size:13px">データがありません</p>`; return; }
  const W = 720, H = 220, L = 44, R = 12, T = 12, B = 34;
  const PH = H - T - B, PW = W - L - R;
  const max = Math.max(1, ...daily.map((d) => d.pv));
  const n = daily.length;
  const bw = PW / n * 0.7, gap = PW / n;
  const s = [`<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">`];
  for (let g = 0; g <= 4; g++) {
    const v = Math.round(max * g / 4), y = T + PH - PH * g / 4;
    s.push(`<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="#ece7df"/>`);
    s.push(`<text x="${L - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#9a8e78">${nf(v)}</text>`);
  }
  daily.forEach((d, i) => {
    const h = d.pv / max * PH, x = L + gap * i + (gap - bw) / 2, y = T + PH - h;
    s.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="#3F6B8A"><title>${d.date}: ${nf(d.pv)}PV</title></rect>`);
    if (i % 4 === 0 || i === n - 1) {
      s.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="9" fill="#9a8e78">${d.date.slice(5)}</text>`);
    }
  });
  s.push("</svg>");
  el.innerHTML = s.join("");
}

function renderTopPages(rows) {
  const el = document.getElementById("topPages");
  if (!rows || !rows.length) { el.innerHTML = empty(); return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><th style="text-align:left;padding:5px 6px;border-bottom:1px solid var(--color-line)">ページ</th><th style="text-align:right;padding:5px 6px;border-bottom:1px solid var(--color-line)">PV</th></tr>
    ${rows.map((r) => `<tr>
      <td style="padding:5px 6px;border-bottom:1px solid #f0ece6">${esc(r.title || r.path)}<div style="font-size:11px;color:var(--color-ink-muted)">${esc(r.path)}</div></td>
      <td style="padding:5px 6px;text-align:right;border-bottom:1px solid #f0ece6">${nf(r.pv)}</td></tr>`).join("")}
  </table>`;
}

function renderTopQueries(rows) {
  const el = document.getElementById("topQueries");
  if (!rows || !rows.length) { el.innerHTML = empty("Search Console 未連携、または直近データがありません"); return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr>
      <th style="text-align:left;padding:5px 6px;border-bottom:1px solid var(--color-line)">クエリ</th>
      <th style="text-align:right;padding:5px 6px;border-bottom:1px solid var(--color-line)">クリック</th>
      <th style="text-align:right;padding:5px 6px;border-bottom:1px solid var(--color-line)">表示</th>
      <th style="text-align:right;padding:5px 6px;border-bottom:1px solid var(--color-line)">順位</th>
    </tr>
    ${rows.map((r) => `<tr>
      <td style="padding:5px 6px;border-bottom:1px solid #f0ece6">${esc(r.query)}</td>
      <td style="padding:5px 6px;text-align:right;border-bottom:1px solid #f0ece6">${nf(r.clicks)}</td>
      <td style="padding:5px 6px;text-align:right;border-bottom:1px solid #f0ece6">${nf(r.impressions)}</td>
      <td style="padding:5px 6px;text-align:right;border-bottom:1px solid #f0ece6">${pos(r.position)}</td></tr>`).join("")}
  </table>`;
}

function renderChannels(rows) {
  const el = document.getElementById("channels");
  if (!rows || !rows.length) { el.innerHTML = empty(); return; }
  const max = Math.max(1, ...rows.map((r) => r.sessions));
  el.innerHTML = rows.map((r) => `
    <div style="display:flex;align-items:center;gap:10px;margin:5px 0;font-size:13px">
      <div style="width:140px">${esc(r.channel)}</div>
      <div style="flex:1;background:#f0ece6;border-radius:4px;overflow:hidden"><div style="width:${(r.sessions / max * 100).toFixed(1)}%;background:#3F6B8A;height:14px"></div></div>
      <div style="width:60px;text-align:right">${nf(r.sessions)}</div>
    </div>`).join("");
}

function empty(msg) {
  return `<p style="color:var(--color-ink-muted);font-size:13px;padding:8px 0">${msg || "データがありません"}</p>`;
}

function render(s) {
  document.getElementById("loadingEl").style.display = "none";
  if (!s || !s.daily || !s.daily.length) {
    document.getElementById("emptyEl").style.display = "block";
    document.getElementById("content").style.display = "none";
    return;
  }
  document.getElementById("emptyEl").style.display = "none";
  document.getElementById("content").style.display = "block";
  if (s.updatedAt?.toDate) {
    document.getElementById("updatedAt").textContent =
      "最終更新: " + s.updatedAt.toDate().toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  renderKpis(s);
  renderPvChart(s.daily);
  renderTopPages(s.topPages);
  renderTopQueries(s.topQueries);
  renderChannels(s.channels);
}

async function refresh(btn) {
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="ti ti-loader-2 ti-spin" aria-hidden="true"></i> 更新中...';
  try {
    const res = await httpsCallable(functions, "collectAnalyticsNow")();
    const d = res.data || {};
    toast(d.skipped ? `未実行: ${d.skipped}` : `更新しました（${d.days || 0}日分）`);
  } catch (e) {
    toast(`更新に失敗しました: ${e.message || e}`);
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  if (!(await gateRole(db, user))) return;

  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  document.getElementById("refreshBtn").addEventListener("click", (e) => refresh(e.currentTarget));

  onSnapshot(doc(db, "analyticsSummary", "latest"), (snap) => {
    render(snap.exists() ? snap.data() : null);
  }, (err) => {
    document.getElementById("loadingEl").style.display = "none";
    document.getElementById("emptyEl").style.display = "block";
    document.getElementById("emptyMsg").textContent = `読み込みエラー: ${err.message}`;
  });
});
