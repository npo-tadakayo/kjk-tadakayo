// 事業所マスター（読み取り専用ビュー）。offices と cases を読み、事業所単位で案件をまとめて見る。
// アーカイブ済み・失注・完了の案件も含める（過去分を探すのが目的）。編集機能は持たない。
// officeId の無い案件は事業所名の文字列でまとめ、「（マスター未登録）」として出す。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { gateRole } from "/js/role.js";
import { STATUS_LABELS, LOST, lostReasonLabel, ARCHIVE_REASONS } from "/js/constants.js";
import { areaOf, parseAddress, PREFECTURES } from "/js/area.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function ms(ts) { return !ts ? 0 : ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : new Date(ts).getTime() || 0); }
function ymd(t) { return t ? new Date(t).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—"; }

let offices = null, cases = null; // どちらも届いてから描画
const open = new Set();            // 開いている行のキー

// 事業所単位にまとめる
function buildGroups() {
  const byId = Object.fromEntries(offices.map((o) => [o._id, o]));
  const groups = new Map();
  const get = (key, init) => { if (!groups.has(key)) groups.set(key, { key, cases: [], ...init() }); return groups.get(key); };
  offices.forEach((o) => get("o:" + o._id, () => {
    const a = areaOf({ officeId: o._id }, byId);
    return { registered: true, corpName: o.corpName || "", officeName: o.officeName || o.name || "", address: o.address || "", pref: a.prefecture, city: a.city };
  }));
  cases.forEach((c) => {
    let g;
    if (c.officeId && byId[c.officeId]) g = groups.get("o:" + c.officeId);
    else if (c.officeId) { // officeId はあるが offices に無い
      g = get("o:" + c.officeId, () => {
        const a = parseAddress(c.address || "");
        return { registered: true, corpName: c.corpName || "", officeName: c.officeName || "", address: c.address || "", pref: a.prefecture, city: a.city };
      });
    } else { // マスター未登録: 事業所名の文字列でまとめる
      const nm = (c.officeName || "").trim();
      g = get("n:" + nm, () => {
        const a = parseAddress(c.address || "");
        return { registered: false, corpName: c.corpName || "", officeName: nm || "（事業所名なし）", address: c.address || "", pref: a.prefecture, city: a.city };
      });
    }
    g.cases.push(c);
  });
  groups.forEach((g) => {
    g.cases.sort((a, b) => (ms(b.receivedAt || b.createdAt)) - (ms(a.receivedAt || a.createdAt)));
    g.latest = g.cases[0] || null;
    g.updated = Math.max(0, ...g.cases.map((c) => ms(c.updatedAt)), ms((byId[g.key.slice(2)] || {}).updatedAt));
  });
  return [...groups.values()];
}

function statusText(c) {
  if (!c) return "—";
  return (STATUS_LABELS[c.status] || "—") + (Number(c.status) === LOST ? `（${lostReasonLabel(c)}）` : "");
}

function caseRows(g) {
  if (!g.cases.length) return `<div style="font-size:13px;color:var(--color-ink-muted)">この事業所の案件はまだありません</div>`;
  return `<table style="width:100%"><thead><tr><th>案件番号</th><th>ステータス</th><th>担当営業</th><th>受信日</th><th>訪問予定日</th><th></th></tr></thead><tbody>`
    + g.cases.map((c) => `<tr>
      <td><a href="/case-detail.html?id=${encodeURIComponent(c._id)}"><strong>#${esc(c.caseNumber || "—")}</strong></a></td>
      <td><span class="badge badge-${esc(c.status)}">${esc(STATUS_LABELS[c.status] || "—")}</span>${Number(c.status) === LOST ? ` <span style="font-size:12px;color:var(--color-ink-muted)">${esc(lostReasonLabel(c))}</span>` : ""}</td>
      <td>${esc(c.assignedUserName || "未割当")}</td>
      <td>${ymd(ms(c.receivedAt || c.createdAt))}</td>
      <td>${c.visitDate ? esc(c.visitDate.replace(/-/g, "/")) : "—"}</td>
      <td>${c.archived ? `<span style="font-size:11px;color:#8a6d3b">対象外・${esc(ARCHIVE_REASONS[c.archivedReason] || "その他")}</span>` : ""}</td>
    </tr>`).join("") + `</tbody></table>`;
}

let groups = [];
function render() {
  if (!offices || !cases) return;
  groups = buildGroups();
  // 都道府県の選択肢（あるものだけ・北から順）
  const prefs = PREFECTURES.filter((p) => groups.some((g) => g.pref === p));
  const sel = $("prefFilter"), keep = sel.value;
  sel.innerHTML = `<option value="">すべての都道府県</option>` + prefs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")
    + (groups.some((g) => !g.pref) ? `<option value="__none__">住所が未登録</option>` : "");
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";

  const q = $("searchInput").value.trim().toLowerCase(), pf = sel.value;
  const rows = groups.filter((g) => {
    if (pf && (pf === "__none__" ? g.pref : g.pref !== pf)) return false;
    return !q || [g.officeName, g.corpName, g.address].some((v) => String(v || "").toLowerCase().includes(q));
  }).sort((a, b) => b.updated - a.updated || String(a.officeName).localeCompare(String(b.officeName), "ja"));

  $("countLabel").textContent = `${rows.length}事業所`;
  $("emptyEl").style.display = rows.length ? "none" : "block";
  $("officesTable").style.display = rows.length ? "table" : "none";
  $("officesBody").innerHTML = rows.map((g) => `
    <tr data-key="${esc(g.key)}" tabindex="0" role="button" aria-expanded="${open.has(g.key)}" style="cursor:pointer">
      <td>${esc(g.corpName) || "—"}</td>
      <td style="font-weight:500">${esc(g.officeName)}${g.registered ? "" : ' <span class="badge badge-2" style="font-size:11px">（マスター未登録）</span>'}</td>
      <td>${esc(g.pref) || '<span style="color:var(--color-ink-muted);font-size:12px">未登録</span>'}</td>
      <td>${esc(g.city) || '<span style="color:var(--color-ink-muted);font-size:12px">未登録</span>'}</td>
      <td>${g.cases.length}</td>
      <td>${g.latest ? `<span class="badge badge-${esc(g.latest.status)}">${esc(statusText(g.latest))}</span>` : "—"}</td>
      <td>${ymd(g.updated)}</td>
    </tr>
    ${open.has(g.key) ? `<tr><td colspan="7" style="background:var(--color-bg, #faf8f5);padding:var(--space-3) var(--space-5)">${caseRows(g)}</td></tr>` : ""}`).join("");
}

function toggleRow(tr) {
  const k = tr.dataset.key;
  if (!k) return;
  if (open.has(k)) open.delete(k); else open.add(k);
  render();
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  if (!(await gateRole(db, user))) return;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  $("gate").style.display = "none"; $("main").style.display = "block";
  $("searchInput").addEventListener("input", render);
  $("prefFilter").addEventListener("change", render);
  $("officesBody").addEventListener("click", (e) => { if (e.target.closest("a")) return; const tr = e.target.closest("tr[data-key]"); if (tr) toggleRow(tr); });
  $("officesBody").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-key]"); if (tr && e.target === tr) { e.preventDefault(); toggleRow(tr); }
  });
  onSnapshot(collection(db, "offices"), (s) => { offices = s.docs.map((d) => ({ _id: d.id, ...d.data() })); render(); },
    (e) => { console.error("[offices] offices read failed", e); });
  onSnapshot(collection(db, "cases"), (s) => { cases = s.docs.map((d) => ({ _id: d.id, ...d.data() })); render(); },
    (e) => { console.error("[offices] cases read failed", e); });
});
