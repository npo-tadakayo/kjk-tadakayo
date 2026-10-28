// 事業所マスター。offices と cases を読み、事業所単位で案件をまとめて見る。
// アーカイブ済み・失注・完了の案件も含める（過去分を探すのが目的）。
// 編集・統合・統合の取り消しは「…」メニューから（閲覧のみの人には出さない）。書き込みは必ず Callable
// （updateOffice / mergeOffices / unmergeOffice）経由。画面から offices・cases を直接書かない。
// officeId の無い案件は事業所名の文字列でまとめ、「（マスター未登録）」として出す。
import { normalizePhone } from "/js/normalize.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, onSnapshot } from "/js/fs.js";
import { gateRole, isViewer } from "/js/role.js";
import { STATUS_LABELS, LOST, lostReasonLabel, ARCHIVE_REASONS } from "/js/constants.js";
import { areaOf, parseAddress, PREFECTURES } from "/js/area.js";
import { matchAnyAssignee, fillAssigneeSelect, bindPrefSelect, loadPref, savePref } from "/js/assignee-filter.js";
import { getFunctions, httpsCallable } from "/js/fn.js";
import { EDITABLE_FIELDS, validatePatch, resolveKeep, dupCandidates, dupGroupCount, checkMerge } from "/js/office-merge.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");
const updateOfficeFn = httpsCallable(functions, "updateOffice");
const mergeOfficesFn = httpsCallable(functions, "mergeOffices");
const unmergeOfficeFn = httpsCallable(functions, "unmergeOffice");

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function ms(ts) { return !ts ? 0 : ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : new Date(ts).getTime() || 0); }
function ymd(t) { return t ? new Date(t).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }) : "—"; }

let offices = null, cases = null; // どちらも届いてから描画
let myEmail = "";
let canEdit = false; // 閲覧のみ（viewer）は「…」メニューを出さない（サーバーでも拒否される）
let dupMap = {};     // 事業所ID → 重複の候補 [{id, reasons}]（統合済みを除いて数える）

const FIELD_LABELS = { officeName: "事業所名", corpName: "法人名", address: "住所", phone: "電話", postalCode: "郵便番号" };
const REASON_LABELS = { name: "名前が同じ", phone: "電話が同じ", address: "住所が同じ" };
const fieldKeys = () => EDITABLE_FIELDS.map((f) => (typeof f === "string" ? f : f.key));
function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._t); t._t = setTimeout(() => { t.style.display = "none"; }, 3500); }
// 入力の誤りの文言に出る項目名（officeName など）を画面の呼び名に直す
const plainField = (m) => Object.keys(FIELD_LABELS).reduce((t, k) => t.split(k).join(FIELD_LABELS[k]), String(m || ""));
// サーバーの想定外の失敗（internal 等）は英語の短い語しか返らないので、言い換えて出す
const errText = (e) => {
  const code = String((e && e.code) || "").replace(/^functions\//, "");
  const msg = String((e && e.message) || e || "");
  if (!msg || code === "internal" || code === "unavailable" || code === "deadline-exceeded" || /^(INTERNAL|internal)$/.test(msg)) {
    return "うまくいきませんでした。少し待ってからもう一度お試しください（続くときは管理者に連絡してください）";
  }
  return msg;
};

// 並び順。同じ値のときは事業所名順
const byName = (a, b) => String(a.officeName).localeCompare(String(b.officeName), "ja");
const prefIdx = (p) => { const i = PREFECTURES.indexOf(p); return i < 0 ? 99 : i; };
const SORTS = {
  updatedDesc: (a, b) => b.updated - a.updated,
  updatedAsc: (a, b) => a.updated - b.updated,
  office: () => 0,
  corp: (a, b) => String(a.corpName || "").localeCompare(String(b.corpName || ""), "ja"),
  pref: (a, b) => prefIdx(a.pref) - prefIdx(b.pref),
  count: (a, b) => b.cases.length - a.cases.length,
};
const open = new Set();            // 開いている行のキー

// 事業所単位にまとめる
function buildGroups() {
  const byId = Object.fromEntries(offices.map((o) => [o._id, o]));
  const groups = new Map();
  const get = (key, init) => { if (!groups.has(key)) groups.set(key, { key, cases: [], ...init() }); return groups.get(key); };
  offices.forEach((o) => get("o:" + o._id, () => {
    const a = areaOf({ officeId: o._id }, byId);
    return { registered: true, office: o, corpName: o.corpName || "", officeName: o.officeName || o.name || "", address: o.address || "", pref: a.prefecture, city: a.city };
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

  // 担当は「その事業所の案件のどれかの担当営業」で見る（未割当＝どの案件にも担当がいない）
  fillAssigneeSelect($("assigneeFilter"), cases, myEmail);
  const asg = $("assigneeFilter").value;
  const cmp = SORTS[$("sortSelect").value] || SORTS.updatedDesc;
  const q = $("searchInput").value.trim().toLowerCase(), pf = sel.value;
  // 重複の候補は、統合済みを除いた事業所どうしで数える
  const live = offices.filter((o) => !o.mergedInto);
  dupMap = {};
  live.forEach((o) => { const c = dupCandidates(o, live).filter((x) => x.id !== o._id); if (c.length) dupMap[o._id] = c; });
  const dupN = dupGroupCount(live);
  $("dupBadge").textContent = `重複の候補 ${dupN}組`;
  $("dupBadge").style.display = dupN ? "" : "none";
  const showMerged = $("showMerged").checked, dupOnly = $("dupOnly").checked;
  const rows = groups.filter((g) => {
    if (g.office && g.office.mergedInto && g.office.mergeStatus !== "running" && !showMerged) return false; // 途中で止まった統合は常に出す（続きを実行できるように）
    if (dupOnly && !(g.office && dupMap[g.office._id])) return false;
    if (pf && (pf === "__none__" ? g.pref : g.pref !== pf)) return false;
    if (!matchAnyAssignee(g.cases.map((c) => c.assignedUserId), asg, myEmail)) return false;
    return !q || [g.officeName, g.corpName, g.address].some((v) => String(v || "").toLowerCase().includes(q));
  }).sort((a, b) => cmp(a, b) || byName(a, b));

  $("countLabel").textContent = `${rows.length}事業所`;
  $("emptyEl").style.display = rows.length ? "none" : "block";
  $("officesTable").style.display = rows.length ? "table" : "none";
  $("menuTh").style.display = canEdit ? "" : "none";
  const cols = canEdit ? 8 : 7;
  const mergedTo = (g) => { const t = g.office && g.office.mergedInto; if (!t) return ""; if (g.office.mergeStatus === "running") return "統合が途中で止まっています"; const x = offices.find((o) => o._id === t); return `${x ? x.officeName || "" : "別の事業所"}に統合済み`; };
  const menuCell = (g) => !canEdit ? "" : g.key.startsWith("o:") && g.office
    ? `<td style="text-align:right"><button type="button" class="btn btn-secondary row-menu-btn" data-office="${esc(g.office._id)}" aria-haspopup="menu" aria-label="${esc(g.officeName)}の操作メニュー" style="padding:4px 10px"><i class="ti ti-dots" aria-hidden="true"></i></button></td>`
    : "<td></td>"; // マスター未登録（n:）は直す対象の事業所が無いのでメニューなし
  $("officesBody").innerHTML = rows.map((g) => `
    <tr data-key="${esc(g.key)}" tabindex="0" role="button" aria-expanded="${open.has(g.key)}" style="cursor:pointer${g.office && g.office.mergedInto ? ";opacity:.55" : ""}">
      <td>${esc(g.corpName) || "—"}</td>
      <td style="font-weight:500">${esc(g.officeName)}${g.registered ? "" : ' <span class="badge badge-2" style="font-size:11px">（マスター未登録）</span>'}${mergedTo(g) ? ` <span class="badge badge-2" style="font-size:11px">${esc(mergedTo(g))}</span>` : ""}${g.office && dupMap[g.office._id] ? ' <span class="badge badge-2" style="font-size:11px">重複の候補</span>' : ""}</td>
      <td>${esc(g.pref) || '<span style="color:var(--color-ink-muted);font-size:12px">未登録</span>'}</td>
      <td>${esc(g.city) || '<span style="color:var(--color-ink-muted);font-size:12px">未登録</span>'}</td>
      <td>${g.cases.length}</td>
      <td>${g.latest ? `<span class="badge badge-${esc(g.latest.status)}">${esc(statusText(g.latest))}</span>` : "—"}</td>
      <td>${ymd(g.updated)}</td>${menuCell(g)}
    </tr>
    ${open.has(g.key) ? `<tr><td colspan="${cols}" style="background:var(--color-bg, #faf8f5);padding:var(--space-3) var(--space-5)">${caseRows(g)}</td></tr>` : ""}`).join("");
}

// ===== 「…」メニュー =====
let menuOfficeId = null, menuBtn = null;
function closeMenu() { const m = $("rowMenu"); m.style.display = "none"; if (menuBtn) menuBtn.setAttribute("aria-expanded", "false"); menuBtn = null; }
function openMenu(btn) {
  const id = btn.dataset.office, o = offices.find((x) => x._id === id);
  if (!o) return;
  if (menuBtn === btn) { closeMenu(); return; }
  closeMenu();
  menuOfficeId = id; menuBtn = btn; btn.setAttribute("aria-expanded", "true");
  const m = $("rowMenu");
  const item = (act, icon, text) => `<button type="button" role="menuitem" data-act="${act}" class="btn" style="display:flex;width:100%;justify-content:flex-start;gap:8px;background:none;min-height:44px"><i class="ti ti-${icon}" aria-hidden="true"></i>${text}</button>`;
  m.innerHTML = o.mergedInto
    ? (o.mergeStatus === "running" ? item("resume", "player-play", "統合を続ける") : item("unmerge", "arrow-back-up", "統合を取り消す"))
    : item("edit", "pencil", "編集") + item("merge", "git-merge", "ほかの事業所と統合");
  m.style.display = "block";
  const r = btn.getBoundingClientRect();
  m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + "px";
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + "px";
  const first = m.querySelector("button"); if (first) first.focus();
}

function setModal(id, on) { $(id).classList.toggle("open", on); }

// ===== 編集 =====
let editId = null;
function openEdit(id) {
  const o = offices.find((x) => x._id === id); if (!o) return;
  editId = id;
  $("efOfficeName").value = o.officeName || ""; $("efCorpName").value = o.corpName || "";
  $("efPostalCode").value = o.postalCode || ""; $("efAddress").value = o.address || ""; $("efPhone").value = o.phone || "";
  $("efError").style.display = "none";
  updateEditNotice(); setModal("editModal", true); $("efOfficeName").focus();
}
function editPatch() {
  const o = offices.find((x) => x._id === editId) || {};
  const vals = { officeName: $("efOfficeName").value, corpName: $("efCorpName").value, postalCode: $("efPostalCode").value, address: $("efAddress").value, phone: normalizePhone($("efPhone").value) };
  const patch = {};
  Object.keys(vals).forEach((k) => { if (vals[k].trim() !== String(o[k] || "").trim()) patch[k] = vals[k]; });
  return patch;
}
function updateEditNotice() {
  $("efError").style.display = "none"; // 入力し直したら前のエラーは消す
  const p = editPatch(), n = cases.filter((c) => c.officeId === editId).length, el = $("efNotice");
  const show = ("officeName" in p || "corpName" in p) && n > 0;
  el.style.display = show ? "block" : "none";
  el.textContent = show ? `この事業所の案件 ${n} 件の表示名も変わります` : "";
}
async function saveEdit() {
  const patch = editPatch();
  if (!Object.keys(patch).length) { setModal("editModal", false); return; }
  const v = validatePatch(patch);
  if (!v.ok) { $("efError").textContent = plainField(v.error); $("efError").style.display = "block"; return; }
  const btn = $("editSaveBtn"); btn.disabled = true;
  try {
    const r = await updateOfficeFn({ officeId: editId, patch: v.patch });
    setModal("editModal", false);
    const n = r.data && r.data.casesUpdated;
    toast(n ? `事業所を直しました（案件 ${n} 件の表示名も更新）` : "事業所を直しました");
  } catch (e) { $("efError").textContent = plainField(errText(e)); $("efError").style.display = "block"; }
  finally { btn.disabled = false; }
}

// ===== 統合 =====
// 開いた行を「残す側（to）」、選んだ相手を「消える側（from）」を既定にする。入れ替えボタンで逆にできる。
let mg = { toId: null, fromId: null, step: 1 };
function officeLine(o) { return `<strong>${esc(o.officeName || "（名前なし）")}</strong>${o.corpName ? `　<span style="color:var(--color-ink-muted)">${esc(o.corpName)}</span>` : ""}<br><span style="font-size:12px;color:var(--color-ink-muted)">${esc(o.address || "住所なし")}　${esc(o.phone || "電話なし")}</span>`; }
function openMerge(id) { mg = { toId: id, fromId: null, step: 1 }; renderMerge(); setModal("mergeModal", true); }
function caseCount(id) { return cases.filter((c) => c.officeId === id).length; }
function renderMerge() {
  const body = $("mergeBody"), foot = $("mergeFooter");
  const to = offices.find((x) => x._id === mg.toId);
  if (!to) { setModal("mergeModal", false); return; }
  if (mg.step === 1) {
    $("mergeTitle").textContent = "ほかの事業所と統合（1/2 相手を選ぶ）";
    const live = offices.filter((o) => !o.mergedInto && o._id !== mg.toId);
    const cand = (dupMap[mg.toId] || []).map((c) => ({ ...c, o: live.find((x) => x._id === c.id) })).filter((c) => c.o);
    body.innerHTML = `<p style="font-size:13px;margin:0 0 12px">残す事業所：${officeLine(to)}<br><span style="font-size:12px;color:var(--color-ink-muted)">この事業所にまとめます。相手を選んだあと、次の画面で残す側を入れ替えることもできます。</span></p>
      <h3 style="font-size:14px;margin:0 0 6px">重複の候補</h3>
      ${cand.length ? cand.map((c) => `<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;border:1px solid var(--color-line);border-radius:8px;padding:8px 12px;margin-bottom:6px">
        <div>${officeLine(c.o)}<br>${c.reasons.map((r) => `<span class="badge badge-2" style="font-size:11px">${esc(REASON_LABELS[r] || r)}</span>`).join(" ")}</div>
        <button type="button" class="btn btn-secondary" data-pick="${esc(c.id)}">この事業所を選ぶ</button></div>`).join("") : '<p style="font-size:13px;color:var(--color-ink-muted)">重複の候補は見つかりませんでした。下の検索から選べます。</p>'}
      <h3 style="font-size:14px;margin:14px 0 6px">事業所を探す</h3>
      <input type="search" class="form-control" id="mgSearch" placeholder="事業所名・法人名・住所で検索" aria-label="統合する相手を検索">
      <div id="mgResults" style="margin-top:8px;max-height:240px;overflow-y:auto"></div>`;
    foot.innerHTML = `<button class="btn btn-secondary" type="button" data-mg="cancel">キャンセル</button>`;
    const draw = () => {
      const q = $("mgSearch").value.trim().toLowerCase();
      const list = !q ? [] : live.filter((o) => [o.officeName, o.corpName, o.address].some((v) => String(v || "").toLowerCase().includes(q))).slice(0, 30);
      $("mgResults").innerHTML = q ? (list.length ? list.map((o) => `<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;padding:6px 4px;border-bottom:1px solid var(--color-line)"><div>${officeLine(o)}</div><button type="button" class="btn btn-secondary" data-pick="${esc(o._id)}">この事業所を選ぶ</button></div>`).join("") : '<p style="font-size:13px;color:var(--color-ink-muted)">見つかりません</p>') : "";
    };
    $("mgSearch").addEventListener("input", draw);
    return;
  }
  // 2/2: 左右に並べて、項目ごとに残す値を選ぶ。from = 消える側、to = 残す側
  const from = offices.find((x) => x._id === mg.fromId);
  $("mergeTitle").textContent = "ほかの事業所と統合（2/2 残す内容を決める）";
  const rows = fieldKeys().map((k) => {
    const a = String(to[k] || "").trim(), b = String(from[k] || "").trim();
    const pickFrom = !a && !!b; // 片方だけ値があれば、その値を残す
    return `<tr><th scope="row" style="text-align:left;white-space:nowrap">${esc(FIELD_LABELS[k] || k)}</th>
      <td style="white-space:normal;word-break:break-all"><label style="display:flex;gap:6px;align-items:flex-start;min-height:36px"><input type="radio" name="keep-${esc(k)}" value="to" ${pickFrom ? "" : "checked"}><span>${esc(a) || '<span style="color:var(--color-ink-muted)">（空）</span>'}</span></label></td>
      <td style="white-space:normal;word-break:break-all"><label style="display:flex;gap:6px;align-items:flex-start;min-height:36px"><input type="radio" name="keep-${esc(k)}" value="from" ${pickFrom ? "checked" : ""}><span>${esc(b) || '<span style="color:var(--color-ink-muted)">（空）</span>'}</span></label></td></tr>`;
  }).join("");
  const n = caseCount(from._id);
  body.innerHTML = `<p style="font-size:13px;margin:0 0 10px"><strong>左の事業所が残り、右の事業所は統合済みとして一覧から隠れます。</strong>残したい側が逆なら「左右を入れ替える」を押してください。</p>
    <div class="table-wrap"><table style="width:100%"><thead><tr><th></th>
      <th style="text-align:left;white-space:normal;word-break:break-all">残す事業所（左）<br><span style="font-weight:400;font-size:12px">${esc(to.officeName || "")}</span></th>
      <th style="text-align:left;white-space:normal;word-break:break-all">消える事業所（右）<br><span style="font-weight:400;font-size:12px">${esc(from.officeName || "")}</span></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p style="font-size:13px;margin:12px 0 0">残す内容を項目ごとに選んでください（片方だけに値があるときは、その値を選んであります）。<br><strong>右の事業所の案件 ${n} 件が、左の事業所へ移ります。</strong></p>`;
  foot.innerHTML = `<button class="btn btn-secondary" type="button" data-mg="back">相手を選び直す</button>
    <button class="btn btn-secondary" type="button" data-mg="swap"><i class="ti ti-arrows-exchange" aria-hidden="true"></i>左右を入れ替える</button>
    <button class="btn btn-primary" type="button" data-mg="run"><i class="ti ti-git-merge" aria-hidden="true"></i>この内容で統合する</button>`;
}
async function runMerge() {
  const to = offices.find((x) => x._id === mg.toId), from = offices.find((x) => x._id === mg.fromId);
  const keep = {};
  fieldKeys().forEach((k) => { const r = document.querySelector(`input[name="keep-${k}"]:checked`); keep[k] = r ? r.value : "to"; });
  const chk = checkMerge(from, to, mg.fromId, mg.toId);
  if (chk && chk.ok === false) { toast(chk.error || "この組み合わせは統合できません"); return; }
  const n = caseCount(mg.fromId);
  if (!confirm(`「${from.officeName || ""}」を「${to.officeName || ""}」に統合します。\n案件 ${n} 件が「${to.officeName || ""}」へ移り、「${from.officeName || ""}」は一覧から隠れます。\n\n「${to.officeName || ""}」にもとからある案件も、事業所名が変わる場合は選んだ名前に変わります。\n\n統合したあとでも、一覧の「統合済みも表示」から「統合を取り消す」で元に戻せます。\n統合しますか？`)) return;
  const btn = document.querySelector('[data-mg="run"]'); if (btn) btn.disabled = true;
  try {
    const r = await mergeOfficesFn({ fromId: mg.fromId, toId: mg.toId, keep });
    setModal("mergeModal", false);
    toast(mergeToastText(r.data, "統合しました"));
  } catch (e) { toast(errText(e)); if (btn) btn.disabled = false; }
}
// 途中で止まった統合の続き。続きのときサーバーは keep を見ない（前回 to に書いた値を使う）
async function runResume(id) {
  const o = offices.find((x) => x._id === id); if (!o || !o.mergedInto) return;
  const t = offices.find((x) => x._id === o.mergedInto);
  if (!confirm(`「${o.officeName || ""}」を「${t ? t.officeName || "" : "別の事業所"}」へ統合する処理が途中で止まっています。\n続きを実行して統合を終わらせます。よろしいですか？`)) return;
  try {
    const r = await mergeOfficesFn({ fromId: id, toId: o.mergedInto, keep: {} });
    toast(mergeToastText(r.data, "統合を続けて完了しました"));
  } catch (e) { toast(errText(e)); }
}
function mergeToastText(d, head) {
  const m = (d && d.moved) || {};
  const ren = d && d.toCasesRenamed ? `。残す側の案件 ${d.toCasesRenamed} 件の事業所名も合わせました` : "";
  return `${head}（案件 ${m.cases || 0} 件・見積もり ${m.quotes || 0} 件・出荷 ${m.shipments || 0} 件を移しました${ren}）`;
}
async function runUnmerge(id) {
  const o = offices.find((x) => x._id === id); if (!o) return;
  if (!confirm(`「${o.officeName || ""}」の統合を取り消します。\n統合のときに移した案件などを、「${o.officeName || ""}」に戻します（そのあと別の事業所へ動かしたものは戻しません）。\n取り消しますか？`)) return;
  try {
    const r = await unmergeOfficeFn({ fromId: id });
    const x = (r.data && r.data.restored) || {};
    const note = r.data && r.data.note ? `。${r.data.note}` : "";
    toast(`統合を取り消しました（案件 ${x.cases || 0} 件を戻しました）${note}`);
  } catch (e) { toast(errText(e)); }
}

function toggleRow(tr) {
  const k = tr.dataset.key;
  if (!k) return;
  if (open.has(k)) open.delete(k); else open.add(k);
  render();
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  const role = await gateRole(db, user);
  if (!role) return;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  $("gate").style.display = "none"; $("main").style.display = "block";
  $("searchInput").addEventListener("input", render);
  $("prefFilter").addEventListener("change", render);
  myEmail = user.email;
  canEdit = !isViewer(role);
  for (const [id, key] of [["dupOnly", "offices.dupOnly"], ["showMerged", "offices.showMerged"]]) {
    $(id).checked = loadPref(key, "") === "1";
    $(id).addEventListener("change", () => { savePref(key, $(id).checked ? "1" : ""); render(); });
  }
  bindPrefSelect($("assigneeFilter"), "offices.assignee", render);
  bindPrefSelect($("sortSelect"), "offices.sort", render);
  $("officesBody").addEventListener("click", (e) => {
    const mb = e.target.closest(".row-menu-btn");
    if (mb) { e.stopPropagation(); openMenu(mb); return; } // 行の開閉はしない
    if (e.target.closest("a")) return; const tr = e.target.closest("tr[data-key]"); if (tr) toggleRow(tr);
  });
  $("rowMenu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = menuOfficeId, act = b.dataset.act, btn = menuBtn;
    closeMenu(); if (btn) btn.focus();
    if (act === "edit") openEdit(id); else if (act === "merge") openMerge(id); else if (act === "unmerge") runUnmerge(id); else if (act === "resume") runResume(id);
  });
  $("rowMenu").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { const b = menuBtn; closeMenu(); if (b) b.focus(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...$("rowMenu").querySelectorAll("button")], i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  });
  document.addEventListener("click", (e) => { if (menuBtn && !e.target.closest("#rowMenu") && !e.target.closest(".row-menu-btn")) closeMenu(); });
  ["efOfficeName", "efCorpName"].forEach((id) => $(id).addEventListener("input", updateEditNotice));
  $("editSaveBtn").addEventListener("click", saveEdit);
  $("editCancelBtn").addEventListener("click", () => setModal("editModal", false));
  $("editCloseBtn").addEventListener("click", () => setModal("editModal", false));
  $("mergeCloseBtn").addEventListener("click", () => setModal("mergeModal", false));
  $("mergeBody").addEventListener("click", (e) => { const p = e.target.closest("[data-pick]"); if (p) { mg.fromId = p.dataset.pick; mg.step = 2; renderMerge(); } });
  $("mergeFooter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mg]"); if (!b) return;
    const a = b.dataset.mg;
    if (a === "cancel") setModal("mergeModal", false);
    else if (a === "back") { mg.step = 1; renderMerge(); }
    else if (a === "swap") { [mg.toId, mg.fromId] = [mg.fromId, mg.toId]; renderMerge(); }
    else if (a === "run") runMerge();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { setModal("editModal", false); setModal("mergeModal", false); } });
  $("officesBody").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-key]"); if (tr && e.target === tr) { e.preventDefault(); toggleRow(tr); }
  });
  onSnapshot(collection(db, "offices"), (s) => { offices = s.docs.map((d) => ({ _id: d.id, id: d.id, ...d.data() })); render(); },
    (e) => { console.error("[offices] offices read failed", e); });
  onSnapshot(collection(db, "cases"), (s) => { cases = s.docs.map((d) => ({ _id: d.id, ...d.data() })); render(); },
    (e) => { console.error("[offices] cases read failed", e); });
});
