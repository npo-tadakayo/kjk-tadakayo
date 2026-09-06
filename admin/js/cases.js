import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, orderBy, onSnapshot,
  addDoc, setDoc, serverTimestamp, doc, getDoc, runTransaction }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { gateRole, applyViewerMode } from "/js/role.js";
import {
  STATUS_LABELS, SOURCE_LABELS, PHASES, LOST,
  DEADLINE, daysUntilDeadline, resolveDeadline, deadlineLabel,
  ARCHIVE_REASONS, computeDuplicateGroups, pairKey,
  referralOptions, referralLabel,
} from "/js/constants.js";
import { areaOf, REGIONS } from "/js/area.js";

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

// appConfig/settings（紹介元の一覧などを持つ）。読み込み前は既定値で動く。
let appSettings = {};
const REFERRAL_NONE = "__none__"; // 絞り込みの「未設定」

// 紹介元の絞り込みを設定内容から生成（未設定も選べる）
function populateReferralFilter() {
  const sel = document.getElementById("referralFilter");
  if (!sel) return;
  const cur = sel.value;
  const opts = referralOptions(appSettings)
    .map((r) => `<option value="${escHtml(r.id)}">${escHtml(r.name)}</option>`).join("");
  sel.innerHTML = `<option value="">すべての紹介元</option>${opts}` +
    `<option value="${REFERRAL_NONE}">未設定</option>`;
  sel.value = cur;
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

// 事業所（offices）の辞書。案件には住所が無く officeId しか持たないため、
// 都道府県・地域・市町村はここから引く（住所の分解は area.js）。
// cases と offices はどちらが先に届くか決まらないので、両方が届くたびに付け直す。
let officesById = {};
function applyAreas() {
  allCases.forEach((c) => { c._area = areaOf(c, officesById); });
}

const NUMERIC_FIELDS = ["caseNumber", "status"];
const AREA_FIELDS = ["prefecture", "region", "city"];
const DATE_FIELDS = ["receivedAt", "updatedAt"];
function sortValue(c, f) {
  if (DATE_FIELDS.includes(f)) { const v = c[f]; return v?.toMillis ? v.toMillis() : (v ? new Date(v).getTime() : 0); }
  if (NUMERIC_FIELDS.includes(f)) return Number(c[f]) || 0;
  if (f === "source") return SOURCE_LABELS[c.source] || c.source || "";
  if (f === "referralSource") return referralLabel(c.referralSource, appSettings) || "";
  if (f === "assignedUserName") return c.assignedUserName || "";
  // 住所系は案件の項目ではなく事業所から導出した値（_area）で並べる。
  // 未登録は空文字なので、昇順なら先頭・降順なら末尾に固まる（意図どおり）。
  if (AREA_FIELDS.includes(f)) return c._area?.[f] || "";
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
    quoteFilter: document.getElementById("quoteFilter")?.value || "",
    referralFilter: document.getElementById("referralFilter")?.value || "",
    showArchived: !!document.getElementById("showArchived")?.checked,
    regionFilter: document.getElementById("regionFilter")?.value || "",
    prefFilter: document.getElementById("prefFilter")?.value || "",
    cityFilter: document.getElementById("cityFilter")?.value || "",
  };
}

// 住所が未登録の案件を選べるようにする値（空文字だと「すべて」と区別できないため）
const AREA_NONE = "__none__";
function areaMatch(value, selected) {
  if (!selected) return true;
  return selected === AREA_NONE ? !value : value === selected;
}
// 見積もり・申し込みの状態（計画書 §4.4）。latestQuoteId / orderedVia は Functions が
// 見積もり作成・Web申込のときに案件へ書く値。手動で注文ステータスにした案件は orderedVia を持たない。
function quoteMatch(c, selected) {
  if (!selected) return true;
  if (selected === "none") return !c.latestQuoteId;
  if (selected === "ordered_web") return c.orderedVia === "web";
  if (selected === "issued") return !!c.latestQuoteId && !c.orderedAt;
  return true;
}
function matchFilters(c, { search, statusFilter, sourceFilter, quoteFilter, referralFilter, showArchived,
                          regionFilter, prefFilter, cityFilter }) {
  // 対象外（テスト/重複/スパム/採用しない）は既定で非表示。チェック時のみ表示。
  if (c.archived && !showArchived) return false;
  const matchSearch = !search ||
    (c.officeName || "").toLowerCase().includes(search) ||
    (c.corpName || "").toLowerCase().includes(search) ||
    (c.contactName || "").toLowerCase().includes(search);
  const matchStatus = !statusFilter || String(c.status) === statusFilter;
  const matchSource = !sourceFilter || c.source === sourceFilter;
  // 紹介元（referralSource）。SOURCE_LABELS の流入元とは別物。
  const matchReferral = !referralFilter ||
    (referralFilter === REFERRAL_NONE ? !c.referralSource : c.referralSource === referralFilter);
  const a = c._area || {};
  const matchArea = areaMatch(a.region, regionFilter)
    && areaMatch(a.prefecture, prefFilter)
    && areaMatch(a.city, cityFilter);
  return matchSearch && matchStatus && matchSource && quoteMatch(c, quoteFilter) && matchReferral && matchArea;
}

// 地域→都道府県→市町村の順に絞り込む。上位を選ぶと、下位の選択肢は
// その範囲に実際に案件がある値だけに減る（存在しない組み合わせを選ばせないため）。
function populateAreaFilters() {
  const region = document.getElementById("regionFilter");
  const pref = document.getElementById("prefFilter");
  const city = document.getElementById("cityFilter");
  if (!region || !pref || !city) return;

  const rows = allCases.filter((c) => c.archived ? document.getElementById("showArchived")?.checked : true);
  const hasBlank = rows.some((c) => !c._area?.prefecture);

  const fill = (sel, values, allLabel, noneLabel) => {
    const keep = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>`
      + values.map((v) => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join("")
      + (hasBlank ? `<option value="${AREA_NONE}">${noneLabel}</option>` : "");
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  };

  // 地域は8地方区分の固定順（データに無い地域も並べると選べてしまうので、あるものだけ）
  const regionsPresent = REGIONS.filter((r) => rows.some((c) => c._area?.region === r));
  fill(region, regionsPresent, "すべての地域", "住所が未登録");

  const inRegion = (c) => (!region.value || region.value === AREA_NONE)
    ? true : c._area?.region === region.value;
  const prefs = [...new Set(rows.filter(inRegion).map((c) => c._area?.prefecture).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ja"));
  fill(pref, prefs, "すべての都道府県", "住所が未登録");

  const inPref = (c) => (!pref.value || pref.value === AREA_NONE)
    ? true : c._area?.prefecture === pref.value;
  const cities = [...new Set(rows.filter(inRegion).filter(inPref).map((c) => c._area?.city).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ja"));
  fill(city, cities, "すべての市町村", "住所が未登録");
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
    tbody.innerHTML = ""; // 前回の行を残すと、絞り込みで0件のとき古い行がDOMに居座る
    // B1: 「条件に合致しない」と「そもそも0件」を区別
    const hasFilter = !!(f.search || f.statusFilter || f.sourceFilter || f.quoteFilter || f.referralFilter
      || f.regionFilter || f.prefFilter || f.cityFilter);
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
      <td class="col-office">
        <div style="font-weight:500">${escHtml(c.officeName || "—")}${c.archived ? archivedBadge(c) : ""}</div>
        ${c.corpName ? `<div style="font-size:12px;color:var(--color-ink-muted)">${escHtml(c.corpName)}</div>` : ""}
      </td>
      <td>${escHtml(c.contactName || "") || "—"}</td>
      <td>${escHtml(c._area?.region || "") || areaBlank()}</td>
      <td>${escHtml(c._area?.prefecture || "") || areaBlank()}</td>
      <td>${escHtml(c._area?.city || "") || areaBlank()}</td>
      <td>${SOURCE_LABELS[c.source] || c.source || "—"}</td>
      <td>${escHtml(referralLabel(c.referralSource, appSettings)) || "—"}</td>
      <td><span class="badge badge-${c.status}">${STATUS_LABELS[c.status] || "—"}</span></td>
      <td>${escHtml(c.assignedUserName || "未割当")}</td>
      <td>${formatDate(c.receivedAt)}</td>
      <td>${formatDate(c.updatedAt)}</td>
    </tr>
  `).join("");
}

// 住所が事業所に登録されていないと空になる。「—」だけだと項目自体が無いように見えるので、
// 未登録であることが分かる表示にする（申込フォームが住所を聞いていないため実際に多い）。
function areaBlank() {
  return '<span style="color:var(--color-ink-muted);font-size:12px">未登録</span>';
}

function archivedBadge(c) {
  const label = ARCHIVE_REASONS[c.archivedReason] || "対象外";
  return ` <span style="font-size:11px;font-weight:600;color:#8a6d3b;background:#FCF3E6;border:1px solid #e6cfa0;border-radius:10px;padding:1px 7px;margin-left:6px">対象外・${escHtml(label)}</span>`;
}

// 「重複ではない」と確定したペアキーの集合（notDuplicates 購読で更新）
let dismissedPairs = new Set();

// 重複候補バナー（アクティブ案件のみ・「重複ではない」確定組は除外）
function renderDuplicateBanner() {
  const banner = document.getElementById("dupBanner");
  if (!banner) return;
  const groups = computeDuplicateGroups(allCases.filter((c) => !c.archived), dismissedPairs);
  if (!groups.length) { banner.style.display = "none"; return; }
  const n = groups.reduce((s, g) => s + g.length, 0);
  banner.style.display = "flex";
  document.getElementById("dupBannerText").textContent =
    `重複の可能性がある案件が ${groups.length} 組（計 ${n} 件）あります。統合は各案件の詳細画面から、別事業所なら「重複ではない」で解除できます。`;
  banner._groups = groups;
}

function openDupModal() {
  const groups = document.getElementById("dupBanner")?._groups || [];
  const body = document.getElementById("dupModalBody");
  body.innerHTML = groups.map((g, i) => `
    <div style="border:1px solid var(--color-line);border-radius:8px;padding:10px 12px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-weight:600;font-size:13px;flex:1">重複候補 ${i + 1}（${g.length}件）</span>
        <button type="button" class="btn btn-ghost not-dup-btn" data-ids="${g.map((c) => c._id).join(",")}" style="font-size:12px;white-space:nowrap">
          <i class="ti ti-circle-x" aria-hidden="true"></i>重複ではない
        </button>
      </div>
      ${g.map((c) => `
        <a href="/case-detail.html?id=${c._id}" style="display:flex;gap:10px;align-items:center;padding:6px 4px;text-decoration:none;color:inherit;border-top:1px solid var(--color-line)">
          <strong style="min-width:46px">#${c.caseNumber || "—"}</strong>
          <span style="flex:1">${escHtml(c.officeName || "—")}${c.corpName ? ` <span style="color:var(--color-ink-muted);font-size:12px">${escHtml(c.corpName)}</span>` : ""}</span>
          <span style="font-size:12px;color:var(--color-ink-muted)">${SOURCE_LABELS[c.source] || c.source || ""}</span>
          <span class="badge badge-${c.status}" style="font-size:11px">${STATUS_LABELS[c.status] || ""}</span>
        </a>`).join("")}
    </div>`).join("");
  body.querySelectorAll(".not-dup-btn").forEach((btn) => {
    btn.addEventListener("click", () => markNotDuplicate(btn.dataset.ids.split(",")));
  });
  document.getElementById("dupModal").classList.add("open");
}
function closeDupModal() { document.getElementById("dupModal").classList.remove("open"); }

// グループ内の全ペアを「重複ではない」として記録（以後この組は重複候補に出ない）
async function markNotDuplicate(ids) {
  if (!Array.isArray(ids) || ids.length < 2) return;
  const user = auth.currentUser;
  try {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        await setDoc(doc(db, "notDuplicates", pairKey(ids[i], ids[j])), {
          a: ids[i], b: ids[j],
          dismissedBy: user?.displayName || user?.email || "",
          dismissedAt: serverTimestamp(),
        });
      }
    }
    toast("「重複ではない」として記録しました");
    closeDupModal();
  } catch (e) {
    toast(`記録に失敗しました: ${e.message}`);
  }
}

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
  const headers = ["案件番号","事業所名","法人名","担当者","地域","都道府県","市町村","電話","メール","流入元","紹介元",
    "ステータス","担当営業","補助金区分","想定補助額","受信日時","最終更新"];
  const lines = [headers.join(",")];
  rows.forEach((c) => {
    lines.push([
      c.caseNumber || "", c.officeName || "", c.corpName || "", c.contactName || "",
      c._area?.region || "", c._area?.prefecture || "", c._area?.city || "",
      c.contactPhone || "", c.contactEmail || "", SOURCE_LABELS[c.source] || c.source || "",
      referralLabel(c.referralSource, appSettings),
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
      referralSource: null, // 紹介元は未設定で作る（案件詳細で選ぶ。決め打ちしない）
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
  const myRole = await gateRole(db, user);
  if (!myRole) return;
  applyViewerMode(myRole);

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
  document.getElementById("quoteFilter")?.addEventListener("change", renderCases);
  document.getElementById("referralFilter")?.addEventListener("change", renderCases);
  document.getElementById("showArchived")?.addEventListener("change", () => { populateAreaFilters(); renderCases(); });
  // 上位を変えたら下位の選択肢を作り直す（存在しない組み合わせを残さない）
  document.getElementById("regionFilter")?.addEventListener("change", () => { populateAreaFilters(); renderCases(); });
  document.getElementById("prefFilter")?.addEventListener("change", () => { populateAreaFilters(); renderCases(); });
  document.getElementById("cityFilter")?.addEventListener("change", renderCases);
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
  populateReferralFilter();
  try {
    const ss = await getDoc(doc(db, "appConfig", "settings"));
    if (ss.exists()) {
      appSettings = ss.data();
      deadline = resolveDeadline(appSettings); updateDeadlineBanner();
      populateReferralFilter();
      if (allCases.length) renderCases(); // 一覧描画後に届いた場合だけ再描画
    }
  } catch (_) {}

  // 「重複ではない」確定ペアを購読（重複候補から除外する）
  onSnapshot(collection(db, "notDuplicates"), (snap) => {
    dismissedPairs = new Set(snap.docs.map((d) => d.id));
    renderDuplicateBanner();
  });

  // 住所は事業所側にあるので一緒に購読する（案件だけでは都道府県が出せない）
  onSnapshot(collection(db, "offices"), (snap) => {
    officesById = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    if (allCases.length) { applyAreas(); populateAreaFilters(); renderCases(); }
  });

  const q = query(collection(db, "cases"), orderBy("receivedAt", "desc"));
  onSnapshot(q, (snap) => {
    allCases = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    applyAreas();
    populateAreaFilters();
    renderCases();
    renderDuplicateBanner();
  });
});
