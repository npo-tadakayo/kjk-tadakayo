// バッジの画面（/badges）の「トレーナー条件とトレーナー合格」（2026-11-12）。
// 計画と決定: 06_介護情報基盤事業/docs/トレーナーコース_計画_20261110.md §3・§7（ト1〜ト8）
//   ・条件（appConfig/trainerCriteria・無ければ既定値）／メンバーごとの 伴走支援 n件・登壇 n回・コース修了・判定
//   ・登壇の記録（appConfig/trainerProgram/talks）／合格・取り消しの記録（appConfig/trainerProgram/certs）
//   ・書き込みはすべて Callable（functions/trainer.js の trainer*）。サーバーで権限を確かめる。
//     画面のボタンの出し分けは、押しても通らない操作を押させないための手当て（権限の正本はサーバー）
// 判定は trainer-rules.js（scripts/test-trainer-rules.mjs）。練習モードでは練習DBを読み、代役（practice-stubs-trainer.js）が練習DBに書く。
// 職員の名簿（users）は練習中も本番を読む（練習DBに users は置かない）。
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, getProdFirestore, collection, doc, getDoc, getDocs, onSnapshot, query, where } from "/js/fs.js";
import { getFunctions, httpsCallable } from "/js/fn.js";
import { getMyRole } from "/js/role.js";
import * as T from "/js/trainer-rules.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, "asia-northeast1");
const call = (name, data) => httpsCallable(fns, name)(data).then((r) => r.data);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(m) { const t = $("toast"); if (!t) return; t.textContent = m; t.style.display = "block"; clearTimeout(t._t); t._t = setTimeout(() => { t.style.display = "none"; }, 3000); }
const errText = (e) => String((e && e.message) || e || "").replace(/^FirebaseError:\s*/, "") || "うまくいきませんでした。時間をおいてもう一度お試しください。";
const fmtDate = (ms) => (ms ? new Date(ms + 9 * 3600e3).toISOString().slice(0, 10) : "");

let me = { email: "", role: "" };
let users = [], rosterIds = null, criteriaDoc = null, talks = [], certs = [], courses = {};
let cases = [], checklists = {}, supportByUser = {};
let started = false;

const nameOf = (id) => { const u = users.find((x) => String(x._id).toLowerCase() === String(id).toLowerCase()); return u ? (u.name || u._id) : id; };
const isAdmin = () => me.role === "admin";
const amTrainer = () => T.isTrainerId(me.email, users, rosterIds);
const members = () => users.filter(T.isCandidateUser).sort((a, b) => String(a.name || a._id).localeCompare(String(b.name || b._id), "ja"));

// ---------- 伴走支援の件数（案件と実施の記録を読む） ----------
async function recount() {
  $("tcRecountBtn").disabled = true;
  try {
    const s = await getDocs(query(collection(db, "supportChecklists"), where("performance.mode", "in", T.COUNTED_MODES)));
    checklists = {};
    s.docs.forEach((d) => { checklists[d.id] = d.data(); });
    const snaps = await Promise.all(s.docs.map((d) => getDoc(doc(db, "cases", d.id)).catch(() => null)));
    cases = snaps.filter((x) => x && x.exists()).map((x) => ({ _id: x.id, status: x.data().status, officeId: x.data().officeId || "" }));
    supportByUser = T.countSupportAll(cases, checklists);
  } catch (e) {
    console.warn("[trainer] recount", e.message);
    toast("伴走支援の件数を数えられませんでした（時間をおいて「数え直す」を押してください）");
  } finally {
    $("tcRecountBtn").disabled = false;
  }
  render();
}

function statsOf(id) {
  const key = String(id).toLowerCase();
  return {
    supportCount: supportByUser[key] || 0,
    talkCount: T.countTalks(id, talks),
    courseDone: T.courseDone(courses[key] || null),
  };
}

// ---------- 表示 ----------
function renderCriteria() {
  const c = T.normalizeCriteria(criteriaDoc);
  $("tcCriteria").textContent = T.criteriaText(c) + (criteriaDoc ? "" : "（既定値）");
  $("tcCritEditBtn").style.display = isAdmin() ? "" : "none";
}

function courseCell(id) {
  const c = courses[String(id).toLowerCase()] || null;
  const w = T.courseWatched(c), q = T.courseQuizPassed(c);
  if (w && q) return '<span class="badge badge-3">修了</span>';
  const parts = [w ? "動画 済" : "動画 まだ", q ? "テスト 合格" : c && c.quiz ? `テスト ${esc(c.quiz.best)}%` : "テスト まだ"];
  return `<span style="font-size:12px">${parts.join("・")}</span>`;
}

function renderTable() {
  const crit = T.normalizeCriteria(criteriaDoc);
  const trainer = amTrainer(), adm = isAdmin();
  const rows = members().map((u) => {
    const s = statsOf(u._id);
    const j = T.judge(s, crit);
    const inRoster = T.isTrainerId(u._id, users, rosterIds);
    const origin = T.certOrigin(u._id, certs, inRoster);
    const last = T.certEventsOf(u._id, certs)[0];
    const self = String(u._id).toLowerCase() === me.email.toLowerCase();
    let status = "";
    if (inRoster) status = `<span class="badge badge-3">トレーナー</span><div style="font-size:12px;color:var(--color-ink-muted)">${esc(T.ORIGIN_LABEL[origin] || "")}${origin !== "initial" && last ? `・${esc(last.date)}` : ""}</div>`;
    else if (origin === "revoked") status = `<span style="font-size:12px;color:var(--color-ink-muted)">取り消し ${esc(last.date)}</span>`;
    else status = '<span style="font-size:12px;color:var(--color-ink-muted)">—</span>';
    const btns = [];
    if (!inRoster) {
      if ((trainer || adm) && !self && j.meets) btns.push(`<button type="button" class="btn btn-primary" data-act="certify" data-id="${esc(u._id)}" style="min-height:40px" data-tip="条件を満たしたこの人を、トレーナー合格にします（認定：あなた）。合格するとトレーナー名簿に入り、評価シートの保存とバッジの付与ができるようになります。自分で自分は合格にできません。"><i class="ti ti-certificate" aria-hidden="true"></i>合格にする</button>`);
      if (adm && !self && !j.meets) btns.push(`<button type="button" class="btn btn-secondary" data-act="discretion" data-id="${esc(u._id)}" style="min-height:40px" data-tip="条件を満たしていない人を、管理者の裁量で合格にします（特別裁量枠）。理由の記入が必須で、通常の合格とは区別して記録します。"><i class="ti ti-star" aria-hidden="true"></i>特別裁量で合格</button>`);
    } else if (adm && !self) {
      btns.push(`<button type="button" class="btn btn-secondary" data-act="revoke" data-id="${esc(u._id)}" style="min-height:40px" data-tip="この人のトレーナー合格を取り消し、トレーナー名簿から外します（管理者だけ・理由必須）。これまでの記録は消えず、「取り消し」の記録が足されます。"><i class="ti ti-certificate-off" aria-hidden="true"></i>取り消す</button>`);
    }
    return `<tr>
      <td><strong>${esc(u.name || u._id)}</strong><div style="font-size:12px;color:var(--color-ink-muted)">${esc(u._id)}</div></td>
      <td>${s.supportCount} / ${crit.supportCount} 件</td>
      <td>${s.talkCount} 回</td>
      <td>${courseCell(u._id)}</td>
      <td>${j.meets ? '<span class="badge badge-3">候補</span>' : `<span style="font-size:12px">${esc(j.label)}</span>`}</td>
      <td>${status}</td>
      <td style="white-space:nowrap">${btns.join(" ")}</td>
    </tr>`;
  });
  $("tcBody").innerHTML = rows.join("") || '<tr><td colspan="7" style="color:var(--color-ink-muted)">メンバーがいません</td></tr>';
  $("tcNote").textContent = (trainer || adm)
    ? "「合格にする」はトレーナーと管理者、「特別裁量で合格」「取り消す」は管理者だけに出ます。自分の行には出ません（自分で自分は合格にできません）。"
    : "合格（認定）は、トレーナーか管理者が行います。";
}

function renderTalks() {
  const adm = isAdmin();
  const rows = talks.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.recordedAt || 0) - (a.recordedAt || 0));
  $("tkEmpty").style.display = rows.length ? "none" : "block";
  $("tkBody").innerHTML = rows.map((t) => `<tr${t.voided ? ' style="opacity:.55"' : ""}>
      <td>${esc(t.date)}</td>
      <td>${esc(t.userName || nameOf(t.userId))}</td>
      <td>${esc(T.talkKindLabel(t.kind))}${t.reason ? `<div style="font-size:12px;color:var(--color-ink-muted)">${esc(t.reason)}</div>` : ""}</td>
      <td>${esc(t.venue)}</td>
      <td style="font-size:12px">${esc(t.recordedByName)}${t.voided ? `<div style="color:var(--color-danger)">取り消し（${esc(t.voidedByName)}：${esc(t.voidReason)}）</div>` : ""}</td>
      <td>${adm && !t.voided ? `<button type="button" class="btn btn-secondary" data-act="voidTalk" data-id="${esc(t._id)}" style="min-height:40px" data-tip="この登壇の記録を取り消します（管理者だけ・理由必須）。記録は消えず、取り消した印が付いて件数から外れます。"><i class="ti ti-x" aria-hidden="true"></i>取り消す</button>` : ""}</td>
    </tr>`).join("");
  const can = isAdmin() || amTrainer();
  $("tkForm").style.display = can ? "" : "none";
  const keep = $("tkUser").value;
  $("tkUser").innerHTML = '<option value="">選んでください</option>' + members().map((u) => `<option value="${esc(u._id)}">${esc(u.name || u._id)}</option>`).join("");
  $("tkUser").value = keep;
}

const KIND_LABEL = { normal: "トレーナー合格（通常）", discretion: "トレーナー合格（特別裁量）" };
function renderCerts() {
  const rows = certs.slice().sort((a, b) => (T.toMs(b.at) || 0) - (T.toMs(a.at) || 0)).map((c) => `<tr>
      <td>${esc(c.date)}</td>
      <td>${esc(c.userName || nameOf(c.userId))}</td>
      <td>${c.type === "revoke" ? '<span class="badge badge-4">取り消し</span>' : c.kind === "discretion" ? '<span class="badge badge-4">特別裁量</span>' : '<span class="badge badge-3">通常</span>'}<div style="font-size:12px;color:var(--color-ink-muted)">${esc(c.type === "revoke" ? "トレーナー合格の取り消し" : KIND_LABEL[c.kind] || "")}</div></td>
      <td>${esc(c.byName)}</td>
      <td style="font-size:12px">${c.type === "revoke" ? "—" : `伴走支援 ${esc(c.supportCount)}件・登壇 ${esc(c.talkCount)}回・コース ${c.courseDone ? "修了" : "未修了"}`}</td>
      <td style="font-size:12px">${esc(c.reason)}</td>
    </tr>`);
  // 名簿にいて合格の記録が無い人＝制度開始時の認定（ト4）
  const initial = T.trainerIds(users, rosterIds).filter((id) => T.certOrigin(id, certs, true) === "initial")
    .map((id) => `<tr><td>—</td><td>${esc(nameOf(id))}</td><td><span class="badge badge-3">制度開始時の認定</span></td><td>—</td><td>—</td><td style="font-size:12px">トレーナー合格の仕組みができる前からのトレーナー</td></tr>`);
  $("ceBody").innerHTML = rows.concat(initial).join("") || '<tr><td colspan="6" style="color:var(--color-ink-muted)">記録はまだありません</td></tr>';
}

function render() {
  if (!started) return;
  renderCriteria();
  renderTable();
  renderTalks();
  renderCerts();
}

// ---------- 確認の小窓（合格・特別裁量・取り消し・登壇の取り消し） ----------
let dlgAction = null;
function openDialog({ title, body, okLabel, reasonLabel, reasonRequired, run }) {
  $("tcDlgTitle").textContent = title;
  $("tcDlgBody").innerHTML = body;
  $("tcDlgOk").innerHTML = okLabel;
  $("tcDlgReasonLabel").textContent = reasonLabel;
  $("tcDlgReason").value = "";
  $("tcDlgErr").textContent = "";
  $("tcDlgOk").disabled = false;
  dlgAction = { run, reasonRequired };
  const d = $("tcDialog");
  if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  $("tcDlgReason").focus();
}
function closeDialog() { const d = $("tcDialog"); if (d.open && typeof d.close === "function") d.close(); else d.removeAttribute("open"); dlgAction = null; }

function certifyDialog(id, kind) {
  const u = users.find((x) => x._id === id);
  const s = statsOf(id), j = T.judge(s, criteriaDoc);
  const disc = kind === "discretion";
  openDialog({
    title: `${u ? u.name || id : id}さんを${disc ? "特別裁量枠で" : ""}トレーナー合格にします`,
    body: `<p style="margin:0">いまの件数：伴走支援 ${s.supportCount}件・登壇 ${s.talkCount}回・トレーナーコース ${s.courseDone ? "修了" : "未修了"}（${esc(j.meets ? "条件を満たしています" : j.label)}）</p>
      <p style="margin:6px 0 0">認定：あなた（${esc(me.name)}）。合格するとトレーナー名簿に入り、評価シートの保存とバッジの付与ができるようになります。${disc ? "<br><strong>特別裁量枠は理由の記入が必須です。</strong>通常の合格とは区別して記録します。" : ""}</p>`,
    okLabel: disc ? '<i class="ti ti-star" aria-hidden="true"></i>特別裁量で合格にする' : '<i class="ti ti-certificate" aria-hidden="true"></i>合格にする',
    reasonLabel: disc ? "理由（必須）" : "メモ（任意）",
    reasonRequired: disc,
    run: async (reason) => {
      await call("trainerCertify", { userId: id, kind, reason });
      toast(`${u ? u.name || id : id}さんをトレーナー合格にしました`);
    },
  });
}
function revokeDialog(id) {
  const u = users.find((x) => x._id === id);
  openDialog({
    title: `${u ? u.name || id : id}さんのトレーナー合格を取り消します`,
    body: "<p style=\"margin:0\">トレーナー名簿から外れ、評価シートの保存とバッジの付与ができなくなります。これまでの記録は消えず、「取り消し」の記録が足されます。</p>",
    okLabel: '<i class="ti ti-certificate-off" aria-hidden="true"></i>取り消す',
    reasonLabel: "取り消す理由（必須）",
    reasonRequired: true,
    run: async (reason) => { await call("trainerRevoke", { userId: id, reason }); toast("取り消しました"); },
  });
}
function voidTalkDialog(id) {
  const t = talks.find((x) => x._id === id);
  openDialog({
    title: "登壇の記録を取り消します",
    body: `<p style="margin:0">${esc(t ? `${t.date}・${t.userName}・${T.talkKindLabel(t.kind)}` : "")}</p><p style="margin:6px 0 0">記録は消えず、取り消した印が付いて件数から外れます。</p>`,
    okLabel: '<i class="ti ti-x" aria-hidden="true"></i>取り消す',
    reasonLabel: "取り消す理由（必須）",
    reasonRequired: true,
    run: async (reason) => { await call("trainerRecordTalk", { action: "void", talkId: id, reason }); toast("登壇の記録を取り消しました"); },
  });
}

async function addTalk() {
  const err = $("tkErr"); err.textContent = "";
  const input = { userId: $("tkUser").value, date: $("tkDate").value, kind: $("tkKind").value, venue: $("tkVenue").value, reason: $("tkReason").value };
  // 画面でも同じ判定で先に止める（最終の判定はサーバー）
  const pre = T.buildTalk(input, { actor: { id: me.email, isAdmin: isAdmin(), isTrainer: amTrainer() }, target: (() => { const u = users.find((x) => x._id === input.userId); return u ? { id: u._id, name: u.name, active: u.active, role: u.role } : null; })(), now: Date.now() });
  if (pre.error) { err.textContent = pre.error; return; }
  $("tkAddBtn").disabled = true;
  try {
    await call("trainerRecordTalk", input);
    $("tkVenue").value = ""; $("tkReason").value = "";
    toast("登壇を記録しました");
  } catch (e) { err.textContent = errText(e); }
  finally { $("tkAddBtn").disabled = false; }
}

async function saveCriteria() {
  const err = $("tcCritErr"); err.textContent = "";
  const input = { supportCount: Number($("tcSupport").value), talkCount: Number($("tcTalk").value), combine: $("tcCombine").value, requireCourse: $("tcCourse").checked };
  const v = T.validateCriteriaInput(input);
  if (v.error) { err.textContent = v.error; return; }
  if (!confirm(`条件を「${T.criteriaText(v.criteria)}」にします。よろしいですか？`)) return;
  $("tcCritSaveBtn").disabled = true;
  try { await call("trainerSaveCriteria", input); $("tcCritForm").hidden = true; toast("条件を保存しました"); }
  catch (e) { err.textContent = errText(e); }
  finally { $("tcCritSaveBtn").disabled = false; }
}
function openCriteria() {
  const c = T.normalizeCriteria(criteriaDoc);
  $("tcSupport").value = c.supportCount; $("tcTalk").value = c.talkCount;
  $("tcCombine").value = c.combine; $("tcCourse").checked = c.requireCourse;
  $("tcCritErr").textContent = "";
  $("tcCritForm").hidden = false;
}

function wire() {
  $("tcCombine").innerHTML = T.COMBINES.map((c) => `<option value="${c.v}">${esc(c.t)}</option>`).join("");
  $("tkKind").innerHTML = '<option value="">選んでください</option>' + T.TALK_KINDS.map((k) => `<option value="${k.v}">${esc(k.t)}</option>`).join("");
  $("tkDate").value = T.todayJst();
  $("tcCritEditBtn").addEventListener("click", openCriteria);
  $("tcCritCancelBtn").addEventListener("click", () => { $("tcCritForm").hidden = true; });
  $("tcCritSaveBtn").addEventListener("click", saveCriteria);
  $("tcRecountBtn").addEventListener("click", recount);
  $("tkAddBtn").addEventListener("click", addTalk);
  $("tcDlgCancel").addEventListener("click", closeDialog);
  $("tcDlgOk").addEventListener("click", async () => {
    if (!dlgAction) return;
    const reason = $("tcDlgReason").value.trim();
    if (dlgAction.reasonRequired && !reason) { $("tcDlgErr").textContent = "理由を書いてください。"; return; }
    $("tcDlgOk").disabled = true;
    try { await dlgAction.run(reason); closeDialog(); }
    catch (e) { $("tcDlgErr").textContent = errText(e); $("tcDlgOk").disabled = false; }
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b || !$("tcArea").contains(b)) return;
    const id = b.dataset.id;
    if (b.dataset.act === "certify") certifyDialog(id, "normal");
    else if (b.dataset.act === "discretion") certifyDialog(id, "discretion");
    else if (b.dataset.act === "revoke") revokeDialog(id);
    else if (b.dataset.act === "voidTalk") voidTalkDialog(id);
  });
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp") || started) return;
  const r = await getMyRole(db, user.email);
  if (!r || !r.active || r.role === "trainee" || r.role === "warehouse") return; // 画面のゲートは badges.js（role.js）
  if (!$("tcArea")) return;
  me = { email: user.email, role: r.role, name: r.name || user.displayName || user.email };
  started = true;
  wire();
  $("tcLoading").style.display = "block";
  const prog = (name) => collection(db, "appConfig", "trainerProgram", name);
  const list = (s) => s.docs.map((d) => ({ _id: d.id, ...d.data() }));
  const warn = (what) => (e) => console.warn(`[trainer] ${what}:`, e.message);
  onSnapshot(collection(getProdFirestore(app), "users"), (s) => { users = list(s); render(); }, warn("users"));
  onSnapshot(doc(db, "appConfig", "supportTrainers"), (s) => { rosterIds = s.exists() && Array.isArray(s.data().ids) ? s.data().ids : null; render(); }, warn("roster"));
  onSnapshot(doc(db, "appConfig", "trainerCriteria"), (s) => { criteriaDoc = s.exists() ? s.data() : null; render(); }, warn("criteria"));
  onSnapshot(prog("talks"), (s) => { talks = list(s); render(); }, warn("talks"));
  onSnapshot(prog("certs"), (s) => { certs = list(s); render(); }, warn("certs"));
  onSnapshot(prog("course"), (s) => { courses = {}; s.docs.forEach((d) => { courses[d.id.toLowerCase()] = d.data(); }); render(); }, warn("course"));
  await recount();
  $("tcLoading").style.display = "none";
  $("tcArea").style.display = "block";
});
