// 伴走支援者バッジ台帳（supportBadges）。付与履歴の一覧・特別裁量での付与・CSV 出力。
// 判定・検証・CSV は support-evaluation.js（scripts/test-support-evaluation.mjs）。
// 付与できるのはトレーナーのみ（画面側の制限。firestore.rules は登録スタッフの作成可・訂正削除は管理者のみ）。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, getProdFirestore, collection, doc, getDoc, onSnapshot, addDoc, serverTimestamp }
  from "/js/fs.js";
import { gateRole } from "/js/role.js";
import { buildGrant, badgeHolders, badgesToCsv, trainerIds, isTrainer } from "/js/support-evaluation.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function $(id){ return document.getElementById(id); }
function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function toast(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}

let me = { email: "", name: "" };
let users = [], grants = [], evals = [], rosterIds = null;

function render() {
  const trainers = trainerIds(users, rosterIds).map((id) => (users.find((u) => u._id === id) || {}).name || id);
  $("trainers").textContent = trainers.length ? trainers.join(" ／ ") : "（トレーナーが users に見つかりません）";

  const rows = grants.slice().sort((a, b) => String(b.grantedDate).localeCompare(String(a.grantedDate)));
  $("badgeEmpty").style.display = rows.length ? "none" : "block";
  $("badgeBody").innerHTML = rows.map((g) => `
    <tr>
      <td>${esc(g.grantedDate)}</td>
      <td><strong>${esc(g.userName)}</strong><div style="font-size:12px;color:var(--color-ink-muted)">${esc(g.userId)}</div></td>
      <td>${esc(g.grantedByName)}</td>
      <td>${g.basis === "discretion" ? '<span class="badge badge-4">特別裁量</span>' : '<span class="badge badge-3">評価シート</span>'}</td>
      <td style="font-size:12px">${esc(g.reason)}${g.caseId ? ` <a href="/case-detail.html?id=${encodeURIComponent(g.caseId)}">案件</a>` : ""}</td>
    </tr>`).join("");

  // 付与フォーム: トレーナーだけ。対象は有効ユーザーで未付与の人
  const canGrant = isTrainer(me.email, users, rosterIds);
  $("grantBtn").disabled = !canGrant;
  $("grantBtn").title = canGrant ? "" : "付与できるのはトレーナーのみです";
  const holders = badgeHolders(grants);
  const cand = users.filter((u) => u.active !== false && !holders.has(u._id))
    .sort((a, b) => String(a.name || a._id).localeCompare(String(b.name || b._id), "ja"));
  const keep = $("gUser").value;
  $("gUser").innerHTML = `<option value="">選んでください</option>` + cand.map((u) => `<option value="${esc(u._id)}">${esc(u.name || u._id)}</option>`).join("");
  $("gUser").value = keep;
  refreshBasis();
}

// 根拠の選択肢: 特別裁量 ＋ その人の「独り立ち可」の評価シート
function refreshBasis() {
  const uid = $("gUser").value;
  const opts = evals.filter((e) => e.traineeId === uid && e.judgement === "independent")
    .map((e) => `<option value="ev:${esc(e._id)}">評価シート（${esc(e.date)}・トレーナー ${esc(e.trainerName)}）</option>`).join("");
  const keep = $("gBasis").value;
  $("gBasis").innerHTML = `<option value="">選んでください</option>${opts}<option value="discretion">特別裁量（理由必須・先例にしない）</option>`;
  if ([...$("gBasis").options].some((o) => o.value === keep)) $("gBasis").value = keep;
}

async function grant() {
  const err = $("gError"); err.style.display = "none";
  const b = $("gBasis").value;
  const r = buildGrant({
    userId: $("gUser").value, date: $("gDate").value,
    basis: b.startsWith("ev:") ? "evaluation" : b, evaluationId: b.startsWith("ev:") ? b.slice(3) : null,
    reason: $("gReason").value,
  }, { users, rosterIds, grants, evaluations: evals, actorId: me.email, actor: me.name, now: Date.now() });
  if (r.error) { err.textContent = r.error; err.style.display = "inline"; return; }
  if (!confirm(`${r.grant.userName}さんに伴走支援者バッジを付与します（認定：${r.grant.grantedByName}／${r.grant.basis === "discretion" ? "特別裁量" : "評価シート"}）。よろしいですか？`)) return;
  try {
    await addDoc(collection(db, "supportBadges"), { ...r.grant, createdAt: serverTimestamp() });
    $("gReason").value = ""; $("gUser").value = "";
    toast("付与しました");
    showRoleNote(r.grant);
  } catch (e) {
    err.textContent = "付与に失敗しました（時間をおいて再試行）"; err.style.display = "inline";
    console.error("[badges] grant failed", e);
  }
}

// 付与した人が練習生ロールのままなら、ロールの変更を案内する（自動では変えない。ロールの変更は管理者の操作のまま・2026-10-24 育成コース）
// 練習生は本番を見られないので、スタッフにしないと独り立ちしても案件を担当できない。
function showRoleNote(g) {
  const el = $("gRoleNote");
  const u = users.find((x) => x._id === g.userId);
  if (!u || u.role !== "trainee") { el.style.display = "none"; return; }
  el.innerHTML = `<i class="ti ti-alert-triangle" aria-hidden="true"></i> ${esc(g.userName)}さんは、ロールが「練習生」のままです。ユーザー管理でロールを「スタッフ」に変えてください（練習生のままでは本番の案件を見られません）。<a href="/users.html">ユーザー管理を開く</a>`;
  el.style.display = "block";
  toast(`${g.userName}さんのロールは「練習生」のままです。ユーザー管理でロールを「スタッフ」に変えてください。`);
}

function downloadCsv() {
  const blob = new Blob(["﻿" + badgesToCsv(grants)], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `伴走支援者バッジ台帳_${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  if (!(await gateRole(db, user))) return;
  me = { email: user.email, name: user.displayName || user.email };
  $("userEmail").textContent = me.name;
  $("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  $("gDate").value = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  $("gUser").addEventListener("change", refreshBasis);
  $("grantBtn").addEventListener("click", grant);
  $("csvBtn").addEventListener("click", downloadCsv);
  $("gate").style.display = "none"; $("main").style.display = "block";
  try { const d = await getDoc(doc(db, "appConfig", "supportTrainers")); if (d.exists()) rosterIds = d.data().ids || null; } catch (_) {}
  // 職員の名簿は練習モード中も本番の users（練習DBに users は置かない）
  onSnapshot(collection(getProdFirestore(app), "users"), (s) => { users = s.docs.map((d) => ({ _id: d.id, ...d.data() })); render(); },
    (e) => console.warn("users:", e.message));
  onSnapshot(collection(db, "supportBadges"), (s) => { grants = s.docs.map((d) => ({ _id: d.id, ...d.data() })); render(); });
  onSnapshot(collection(db, "supportEvaluations"), (s) => { evals = s.docs.map((d) => ({ _id: d.id, ...d.data() })); render(); });
});
