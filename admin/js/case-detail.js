import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, applyViewerMode } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getFunctions, httpsCallable }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { STATUS_LABELS, SOURCE_LABELS, ARCHIVE_REASONS, dupKeys, pairKey,
  referralOptions, referralLabel } from "/js/constants.js";
import { ACTIVITY_ICONS, ACTIVITY_LABELS, AI_TITLES, escHtml, formatDateTime, toDateInput, toYmdJst, calcExpectedDeposit } from "/js/case-detail-util.js";
import { initSupportChecklist } from "/js/support-checklist.js";
import { initConsentCard } from "/js/consent-admin.js";
import { initPreGuideCard } from "/js/pre-guide.js";
import { initQuoteCard } from "/js/quote-admin.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, "asia-northeast1");

const caseId = new URLSearchParams(location.search).get("id");
if (!caseId) { location.href = "/cases.html"; }

// STATUS_LABELS / SOURCE_LABELS は constants.js、ACTIVITY定数・ユーティリティ（escHtml/日付/振込予定日）は case-detail-util.js から import（C2 / C1重複排除）

let currentCase = null;
let latestActivities = [];
let latestSessions = [];
let isAdmin = false;
// 統合（mergeInto）は取り消せないので「閲覧のみ（viewer）」には出さない。
// 完全削除＝管理者のみ／統合＝管理者＋スタッフ（データは消えず対象外になるだけなので削除より1段ゆるい）。
let canMerge = false;
let currentUser = null;
// appConfig/settings（紹介元の一覧などを持つ）。読み込み前は既定値で動く。
let appSettings = {};
// users コレクション（担当営業の候補。doc id = メールアドレス / name・role・active を持つ）
let usersList = [];

function renderCaseHeader(c) {
  document.title = `#${c.caseNumber || "—"} ${c.officeName || ""} — タダカヨ CRM`;
  document.getElementById("caseNumber").textContent = `案件 #${c.caseNumber || "—"}`;
  document.getElementById("caseTitle").textContent = c.officeName || "（事業所名未登録）";

  const metaEl = document.getElementById("caseMeta");
  metaEl.innerHTML = [
    c.corpName ? `<span class="case-meta-item"><i class="ti ti-building" aria-hidden="true"></i>${escHtml(c.corpName)}</span>` : "",
    c.contactName ? `<span class="case-meta-item"><i class="ti ti-user" aria-hidden="true"></i>${escHtml(c.contactName)}</span>` : "",
    c.contactPhone ? `<span class="case-meta-item"><i class="ti ti-phone" aria-hidden="true"></i>${escHtml(c.contactPhone)}</span>` : "",
    c.contactEmail ? `<span class="case-meta-item"><i class="ti ti-mail" aria-hidden="true"></i>${escHtml(c.contactEmail)}</span>` : "",
    `<span class="case-meta-item"><i class="ti ti-tag" aria-hidden="true"></i>${SOURCE_LABELS[c.source] || c.source || "—"}</span>`,
  ].filter(Boolean).join("");

  const statusSel = document.getElementById("statusSelect");
  statusSel.value = String(c.status || 1);
}

// ===== 担当営業（assignedUserId / assignedUserName） =====
// users コレクション（doc id = メールアドレス）から候補を作る。role では絞らない（全員が候補）。
// 一覧・カンバンは assignedUserName を表示するため、保存時は必ず ID と 氏名 の両方を書く。
function userDisplayName(u) { return (u && (u.name || u._id)) || ""; }

function renderAssigneeSelect() {
  const sel = document.getElementById("assigneeSelect");
  if (!sel) return;
  const cur = currentCase?.assignedUserId || "";
  const actives = usersList.filter((u) => u.active !== false)
    .slice().sort((a, b) => userDisplayName(a).localeCompare(userDisplayName(b), "ja"));
  let html = `<option value="">未割当</option>`
    + actives.map((u) => `<option value="${escHtml(u._id)}">${escHtml(userDisplayName(u))}</option>`).join("");
  // 無効化された／削除されたユーザーが割り当て済みの場合も、その人を選択肢に残す
  // （勝手に別の人へ化けたり「未割当」に戻ったりしないように。紹介元と同じ考え方）
  if (cur && !actives.some((u) => u._id === cur)) {
    const known = usersList.find((u) => u._id === cur);
    const name = userDisplayName(known) || currentCase?.assignedUserName || cur;
    html += `<option value="${escHtml(cur)}">${escHtml(name)}（無効）</option>`;
  }
  sel.innerHTML = html;
  sel.value = cur;
}

async function saveAssignee(value) {
  const prevName = currentCase.assignedUserName || "未割当";
  const id = value || null;
  let name = null;
  if (id) {
    const u = usersList.find((x) => x._id === id);
    // users から引けないとき（削除済みなど）は、いま案件に入っている氏名を保つ
    name = userDisplayName(u) || currentCase.assignedUserName || id;
  }
  await updateDoc(doc(db, "cases", caseId), {
    assignedUserId: id, assignedUserName: name, updatedAt: serverTimestamp(),
  });
  currentCase.assignedUserId = id;
  currentCase.assignedUserName = name;
  // 誰がいつ担当を変えたか追えるようにタイムラインへ記録
  await logActivity(`担当営業変更 → ${name || "未割当"}`, `変更前: ${prevName}`);
  showToast(name ? `担当営業を「${name}」にしました` : "担当営業を未割当にしました");
}

// ===== 紹介元（referralSource） =====
// ⚠️ source（LP問い合わせ/見積もり成約/手動登録＝流入経路）とは別物。こちらは「誰の紹介で来たか」。
// 選択肢は appConfig/settings.referralSources（未設定なら REFERRAL_DEFAULTS）。保存する値は id。
function renderReferralSelect() {
  const sel = document.getElementById("referralSelect");
  if (!sel) return;
  const cur = currentCase?.referralSource || "";
  const opts = referralOptions(appSettings);
  let html = `<option value="">—</option>`
    + opts.map((o) => `<option value="${escHtml(o.id)}">${escHtml(o.name)}</option>`).join("");
  // 設定から消された／無効化された紹介元でも、いま入っている値は選択肢に残す（勝手に別の値へ化けないように）
  if (cur && !opts.some((o) => o.id === cur)) {
    html += `<option value="${escHtml(cur)}">${escHtml(referralLabel(cur, appSettings))}（無効）</option>`;
  }
  sel.innerHTML = html;
  sel.value = cur;
}

async function saveReferral(value) {
  const v = value || null;
  await updateDoc(doc(db, "cases", caseId), { referralSource: v, updatedAt: serverTimestamp() });
  currentCase.referralSource = v;
  showToast(v ? `紹介元を「${referralLabel(v, appSettings)}」にしました` : "紹介元を未設定にしました");
}

// 対象外バナー・操作ボタンの表示状態
function renderCaseActions() {
  const c = currentCase;
  const banner = document.getElementById("archivedBanner");
  const archiveBtn = document.getElementById("archiveBtn");
  const unarchiveBtn = document.getElementById("unarchiveBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  if (c.archived) {
    if (banner) {
      banner.style.display = "flex";
      banner.querySelector("span").textContent =
        `この案件は対象外です（${ARCHIVE_REASONS[c.archivedReason] || c.archivedReason || "—"}）` +
        (c.mergedInto ? "／別案件に統合済み" : "");
    }
    if (archiveBtn) archiveBtn.style.display = "none";
    if (unarchiveBtn) unarchiveBtn.style.display = "";
  } else {
    if (banner) banner.style.display = "none";
    if (archiveBtn) archiveBtn.style.display = "";
    if (unarchiveBtn) unarchiveBtn.style.display = "none";
  }
  if (deleteBtn) deleteBtn.style.display = isAdmin ? "" : "none";
}

// 重複候補カード
async function renderDuplicateCandidates() {
  const card = document.getElementById("dupCandidates");
  const body = document.getElementById("dupCandidatesBody");
  if (!card || !body) return;
  let cands = [];
  try { cands = await loadDuplicateCandidates(); } catch (_) { cands = []; }
  if (!cands.length) { card.style.display = "none"; return; }
  card.style.display = "block";
  // 閲覧のみの人には統合ボタンを出さない（押してから断るのではなく、そもそも出さない）
  const hint = document.getElementById("dupCandidatesHint");
  if (hint && !canMerge) hint.textContent = "メール・電話・事業所名が一致します。";
  body.innerHTML = cands.map((c) => `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 4px;border-top:1px solid var(--color-line)">
      <a href="/case-detail.html?id=${c._id}" style="flex:1;text-decoration:none;color:inherit">
        <strong>#${c.caseNumber || "—"}</strong>
        ${escHtml(c.officeName || "—")}
        <span style="font-size:12px;color:var(--color-ink-muted)">${SOURCE_LABELS[c.source] || c.source || ""} ／ ${STATUS_LABELS[c.status] || ""}</span>
      </a>
      ${canMerge ? `<button class="btn btn-ghost" type="button" data-merge="${c._id}" style="white-space:nowrap">
        <i class="ti ti-arrow-merge" aria-hidden="true"></i>この案件に統合
      </button>` : ""}
    </div>`).join("");
  // 統合ボタン（このカード内に限定）
  body.querySelectorAll("[data-merge]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const other = cands.find((x) => x._id === btn.dataset.merge);
      if (other) mergeInto(other);
    });
  });
}

function renderTimeline(activities) {
  const el = document.getElementById("timelineEl");
  if (!activities.length) {
    el.innerHTML = `<div class="empty-state"><i class="ti ti-notes" aria-hidden="true"></i><p>対応記録がありません</p></div>`;
    return;
  }
  el.innerHTML = `<div class="timeline">${activities.map((a) => `
    <div class="timeline-item">
      <div class="timeline-dot">
        <i class="ti ${ACTIVITY_ICONS[a.type] || "ti-notes"}" aria-hidden="true"></i>
      </div>
      <div class="timeline-content">
        <div class="timeline-meta">
          <span>${ACTIVITY_LABELS[a.type] || a.type}</span>
          <span>${formatDateTime(a.occurredAt)}</span>
          <span>${escHtml(a.userName || a.userId || "")}</span>
        </div>
        ${a.subject ? `<div class="timeline-subject">${escHtml(a.subject)}</div>` : ""}
        ${a.body ? `<div class="timeline-body">${escHtml(a.body)}</div>` : ""}
      </div>
    </div>
  `).join("")}</div>`;
}

function renderDocumentChecklist(cl) {
  const fields = {
    "chk-bankbook": "bankbookReady",
    "chk-service": "serviceConfirmReady",
    "chk-receipt": "receiptReady",
    "chk-webscreen": "webScreenCopyReady",
    "chk-myna": "mynaAppCompatibleConfirmed",
    "chk-portal": "portalAccountAcquired",
  };
  for (const [id, field] of Object.entries(fields)) {
    const chk = document.getElementById(id);
    const statusEl = document.getElementById(`status-${id.replace("chk-", "")}`);
    const val = cl ? cl[field] : false;
    chk.checked = !!val;
    if (val) {
      statusEl.className = "check-done";
      statusEl.innerHTML = `<i class="ti ti-circle-check-filled" aria-hidden="true"></i>`;
    } else {
      statusEl.className = "check-pending";
      statusEl.innerHTML = `<i class="ti ti-circle" aria-hidden="true"></i>`;
    }
  }

  if (cl?.bankAccountInfo) {
    const b = cl.bankAccountInfo;
    document.getElementById("bankType").value = b.bankType || "bank";
    document.getElementById("bankName").value = b.bankName || "";
    document.getElementById("bankCode").value = b.bankCode || "";
    document.getElementById("branchName").value = b.branchName || "";
    document.getElementById("accountType").value = b.accountType || "普通";
    document.getElementById("accountNumber").value = b.accountNumber || "";
    document.getElementById("accountHolder").value = b.accountHolder || "";
  }
  applyBankType();
}

// ゆうちょ銀行は口座の体系が他行と違う（銀行コード＋支店名＋口座番号7桁 ではなく、
// 通帳の「記号5桁」＋「番号8桁」）。同じ欄のまま入力させると、振り込めない口座情報が
// 保存されて助成金が事業所に届かない。銀行種別に合わせて欄の意味を切り替える。
// （HTML に #bankCodeRow の id だけあって切り替えるコードが無かった。2026-08-31 追加）
function applyBankType() {
  const type = document.getElementById("bankType").value;
  const yucho = type === "yucho";

  const bankName = document.getElementById("bankName");
  const bankCode = document.getElementById("bankCode");
  const branchName = document.getElementById("branchName");
  const accountNumber = document.getElementById("accountNumber");
  if (!bankName || !bankCode || !branchName || !accountNumber) return;
  const label = (forId, text) => {
    const el = document.querySelector(`label[for="${forId}"]`);
    if (el) el.textContent = text;
  };

  if (yucho) {
    if (bankName.value !== "ゆうちょ銀行") bankName.value = "ゆうちょ銀行";
    bankName.readOnly = true;
    label("bankCode", "記号（5桁）");
    bankCode.maxLength = 5;
    bankCode.placeholder = "12345";
    const g = branchName.closest(".form-group");
    if (g) g.style.display = "none";
    label("accountNumber", "番号（8桁）");
    accountNumber.maxLength = 8;
    accountNumber.placeholder = "12345678";
  } else {
    bankName.readOnly = false;
    if (bankName.value === "ゆうちょ銀行") bankName.value = "";
    label("bankCode", "銀行コード");
    bankCode.maxLength = 4;
    bankCode.placeholder = "0000";
    const g = branchName.closest(".form-group");
    if (g) g.style.display = "";
    label("accountNumber", "口座番号（7桁）");
    accountNumber.maxLength = 7;
    accountNumber.placeholder = "1234567";
  }

  const note = document.getElementById("bankTypeNote");
  if (note) {
    note.textContent = yucho
      ? "通帳に書かれている「記号」と「番号」をそのまま入れてください（他行から振り込むときの店番・口座番号ではありません）。"
      : "";
    note.style.display = yucho ? "block" : "none";
  }
}

function renderSubsidy(sa) {
  if (!sa) return;
  document.getElementById("subsidyStatus").value = sa.status || "preparing";
  document.getElementById("applicationDate").value = toDateInput(sa.applicationDate);
  document.getElementById("decisionReceivedAt").value = toDateInput(sa.decisionReceivedAt);
  document.getElementById("actualDepositDate").value = toDateInput(sa.actualDepositDate);
  document.getElementById("grantAmount").value = sa.applicationContent?.grantAmount || "";
  document.getElementById("cardReaderCost").value = sa.applicationContent?.cardReaderCost || "";
  document.getElementById("supportCost").value = sa.applicationContent?.supportCost || "";
  document.getElementById("rejectionReason").value = sa.rejectionReason || "";

  updateExpectedDeposit();
  toggleRejectionField();
}

function updateExpectedDeposit() {
  const appDate = document.getElementById("applicationDate").value;
  const d = calcExpectedDeposit(appDate);
  const group = document.getElementById("expectedDepositGroup");
  if (d) {
    group.style.display = "block";
    document.getElementById("expectedDepositDate").textContent =
      `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（申請月翌々月末）`;
  } else {
    group.style.display = "none";
  }
}

function toggleRejectionField() {
  const status = document.getElementById("subsidyStatus").value;
  document.getElementById("rejectionGroup").style.display =
    status === "rejected" ? "block" : "none";
}

// チェックリスト変更を即座に保存
async function saveChecklistField(field, value) {
  const clRef = doc(db, "documentChecklists", caseId);
  await setDoc(clRef, { [field]: value, updatedAt: serverTimestamp() }, { merge: true });
}

// 口座情報保存
async function saveBankInfo() {
  const bankAccountInfo = {
    bankType: document.getElementById("bankType").value,
    bankName: document.getElementById("bankName").value.trim(),
    bankCode: document.getElementById("bankCode").value.trim(),
    branchName: document.getElementById("branchName").value.trim(),
    accountType: document.getElementById("accountType").value,
    accountNumber: document.getElementById("accountNumber").value.trim(),
    accountHolder: document.getElementById("accountHolder").value.trim(),
  };
  const clRef = doc(db, "documentChecklists", caseId);
  await setDoc(clRef, { bankAccountInfo, updatedAt: serverTimestamp() }, { merge: true });
  showToast("口座情報を保存しました");
}

// 申請情報保存
async function saveSubsidyInfo() {
  const appDate = document.getElementById("applicationDate").value;
  const expected = calcExpectedDeposit(appDate);
  const saRef = doc(db, "subsidyApplications", caseId);
  await setDoc(saRef, {
    caseId,
    status: document.getElementById("subsidyStatus").value,
    applicationDate: appDate || null,
    decisionReceivedAt: document.getElementById("decisionReceivedAt").value || null,
    actualDepositDate: document.getElementById("actualDepositDate").value || null,
    expectedDepositDate: expected ? toYmdJst(expected) : null,
    applicationContent: {
      cardReaderCost: Number(document.getElementById("cardReaderCost").value) || null,
      supportCost: Number(document.getElementById("supportCost").value) || null,
      grantAmount: Number(document.getElementById("grantAmount").value) || null,
    },
    rejectionReason: document.getElementById("rejectionReason").value.trim() || null,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  showToast("申請情報を保存しました");
}

// ステータス変更
async function changeStatus(newStatus, userId, userName) {
  await updateDoc(doc(db, "cases", caseId), {
    status: Number(newStatus),
    updatedAt: serverTimestamp(),
  });
  await addDoc(collection(db, "activities"), {
    caseId,
    type: "memo",
    occurredAt: serverTimestamp(),
    userId,
    userName,
    subject: `ステータス変更 → ${STATUS_LABELS[newStatus]}`,
    body: "",
    attachmentUrls: [],
  });
}

// ===== 対象外化 / 解除 / 完全削除 / 統合 =====

async function logActivity(subject, body) {
  await addDoc(collection(db, "activities"), {
    caseId, type: "memo", occurredAt: serverTimestamp(),
    userId: currentUser?.uid || null,
    userName: currentUser?.displayName || currentUser?.email || "",
    subject, body: body || "", attachmentUrls: [],
  });
}

// 対象外（アーカイブ）にする
async function archiveCase(reason, note) {
  await updateDoc(doc(db, "cases", caseId), {
    archived: true, archivedReason: reason,
    archivedAt: serverTimestamp(),
    archivedBy: currentUser?.displayName || currentUser?.email || "",
    updatedAt: serverTimestamp(),
  });
  await logActivity(`対象外に設定（${ARCHIVE_REASONS[reason] || reason}）`, note);
  showToast("対象外にしました");
  setTimeout(() => location.reload(), 600);
}

// 対象外を解除
async function unarchiveCase() {
  await updateDoc(doc(db, "cases", caseId), {
    archived: false, archivedReason: null, mergedInto: null,
    updatedAt: serverTimestamp(),
  });
  await logActivity("対象外を解除", "");
  showToast("対象外を解除しました");
  setTimeout(() => location.reload(), 600);
}

// 完全削除（管理者のみ）。関連ドキュメントもまとめて削除する。
async function hardDeleteCase() {
  if (!isAdmin) { alert("完全削除は管理者のみ可能です"); return; }
  const num = currentCase?.caseNumber || "";
  if (!confirm(`案件 #${num}「${currentCase?.officeName || ""}」を完全に削除します。\nこの操作は元に戻せません。よろしいですか？`)) return;

  try {
    // 関連サブデータ（caseId 参照）を一括削除
    const batch = writeBatch(db);
    for (const col of ["activities", "sessions"]) {
      const snap = await getDocs(query(collection(db, col), where("caseId", "==", caseId)));
      snap.forEach((d) => batch.delete(d.ref));
    }
    for (const col of ["documentChecklists", "subsidyApplications", "supportChecklists"]) {
      batch.delete(doc(db, col, caseId));
    }
    batch.delete(doc(db, "cases", caseId));
    await batch.commit();
    alert(`案件 #${num} を削除しました`);
    location.href = "/cases.html";
  } catch (e) {
    alert(`削除に失敗しました: ${e.message || e}`);
  }
}

// 重複候補（自分以外・アクティブ・キー一致）を取得
async function loadDuplicateCandidates() {
  const myKeys = new Set(dupKeys(currentCase));
  if (!myKeys.size) return [];
  const [snap, ndSnap] = await Promise.all([
    getDocs(collection(db, "cases")),
    getDocs(collection(db, "notDuplicates")),
  ]);
  const dismissed = new Set(ndSnap.docs.map((d) => d.id));
  return snap.docs
    .map((d) => ({ _id: d.id, ...d.data() }))
    .filter((c) => c._id !== caseId && !c.archived
      && dupKeys(c).some((k) => myKeys.has(k))
      && !dismissed.has(pairKey(caseId, c._id)));
}

// ===== 統合（重複案件のマージ） =====
// 統合時に「どちらの値を残すか」を判断する項目の定義。ここに1件足せば、
// 差分検出・選択モーダル・タイムライン記録のすべてが自動で追従する（担当営業だけを特別扱いしない）。
//   id():   食い違い判定に使う識別子（これが違えば「食い違い」）
//   text(): 画面・記録に出す表示名
//   pick(): 採用したときに cases へ書き込むフィールド一式
const MERGE_FIELDS = [
  {
    key: "assigned", label: "担当営業",
    id: (c) => String(c.assignedUserId || c.assignedUserName || "").trim(),
    text: (c) => String(c.assignedUserName || c.assignedUserId || "").trim(),
    pick: (c) => ({ assignedUserId: c.assignedUserId || null, assignedUserName: c.assignedUserName || null }),
  },
  {
    key: "referralSource", label: "紹介元",
    id: (c) => String(c.referralSource || "").trim(),
    text: (c) => referralLabel(c.referralSource, appSettings),
    pick: (c) => ({ referralSource: c.referralSource || null }),
  },
  ...[["contactName", "担当者名"], ["contactEmail", "メール"], ["contactPhone", "電話"], ["corpName", "法人名"]]
    .map(([f, label]) => ({
      key: f, label,
      id: (c) => String(c[f] || "").trim(),
      text: (c) => String(c[f] || "").trim(),
      pick: (c) => ({ [f]: c[f] }),
    })),
];

// 残す側(keep)と消える側(other)の差分を出す。
//   片方だけに値がある → autoFill（選ばせず自動で埋める。従来どおりの挙動）
//   両方に値があって違う → conflicts（どちらを採用するか選ばせる）
function computeMergeDiffs(keep, other) {
  const autoFill = {};
  const autoNotes = [];
  const conflicts = [];
  for (const f of MERGE_FIELDS) {
    const oid = f.id(other);
    if (!oid) continue;                       // 消える側に値なし → 何もしない（残す側を守る）
    const kid = f.id(keep);
    if (!kid) {                               // 片方（消える側）だけ値がある → 自動で補完
      Object.assign(autoFill, f.pick(other));
      autoNotes.push(`${f.label}: ${f.text(other) || "—"}（統合元から補完）`);
      continue;
    }
    if (kid !== oid) {                        // 両方に値があって食い違う → 選択対象
      conflicts.push({ field: f, keepText: f.text(keep) || "—", otherText: f.text(other) || "—" });
    }
  }
  return { autoFill, autoNotes, conflicts };
}

// 統合時に一緒に引き継ぐ「1案件1ドキュメント」のコレクション。
// いずれも doc ID が caseId そのもの（サブコレクションではない）ため、案件を統合しても
// 付いてこず、統合元（対象外になる側）に取り残される＝現場からは「入力したチェックが消えた」ように見える。
// hardDeleteCase() が消しているのと同じ3つ。ここに1行足せば引き継ぎ対象が増える。
const MERGE_DOC_COLLECTIONS = [
  { col: "documentChecklists", label: "書類チェック" },
  { col: "subsidyApplications", label: "申請情報" },
  { col: "supportChecklists", label: "伴走支援チェックリスト（事前・当日・アフター）" },
];

// チェックリスト類をどう引き継ぐかを決める（副作用なし・Firestore を触らない）。
// 方針: 残る側にドキュメントが「無い」ときだけ丸ごと移す。
//   チェックは項目ごとに「誰がいつ確認したか」の意味を持つので、項目単位で機械的に混ぜない。
//   両方にあるときは残る側を必ず優先し（＝上書きしない）、統合元にも記録があった事実を
//   タイムラインに残して人が確認しに行けるようにする。
//   state: { [col]: { keepExists, otherExists } }
function planChecklistCarryOver(state) {
  const moved = [];    // 引き継ぐもの（残る側が空だった）
  const kept = [];     // 引き継がないもの（両方にあるので残る側を優先。人の確認が要る）
  for (const { col, label } of MERGE_DOC_COLLECTIONS) {
    const st = state[col] || {};
    if (!st.otherExists) continue;              // 統合元に無い → 何もしない
    if (st.keepExists) { kept.push(label); continue; }  // 残る側にある → 触らない
    moved.push(label);
  }
  return { moved, kept };
}

// 食い違いの選択モーダル。resolve(選択マップ) / キャンセルは resolve(null)。
// 取り違え防止のため、どちらが残りどちらが消えるかを案件番号＋事業所名つきで明示する。
function openMergeChoiceModal(keep, other, conflicts, autoNotes) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open";
    overlay.id = "mergeChoiceModal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "統合内容の確認");

    const sub = (c) => [c.corpName, c.contactName, c.contactEmail].filter(Boolean).join(" ／ ");
    const rows = conflicts.map((cf) => `
      <fieldset style="border:1px solid var(--color-line);border-radius:var(--radius-md);padding:10px 12px;margin:0 0 10px">
        <legend style="font-size:13px;font-weight:700;padding:0 4px">${escHtml(cf.field.label)}</legend>
        <label style="display:flex;gap:10px;align-items:center;min-height:44px;cursor:pointer">
          <input type="radio" name="mrg-${escHtml(cf.field.key)}" value="keep" checked
                 style="width:20px;height:20px;flex:none">
          <span style="font-size:13px">
            <span style="color:var(--color-success);font-weight:700">残る #${escHtml(keep.caseNumber || "—")}</span>
            <span style="color:var(--color-ink-muted)">（${escHtml(keep.officeName || "事業所名なし")}）</span>
            ： <strong>${escHtml(cf.keepText)}</strong>
          </span>
        </label>
        <label style="display:flex;gap:10px;align-items:center;min-height:44px;cursor:pointer">
          <input type="radio" name="mrg-${escHtml(cf.field.key)}" value="other"
                 style="width:20px;height:20px;flex:none">
          <span style="font-size:13px">
            <span style="color:var(--color-danger);font-weight:700">消える #${escHtml(other.caseNumber || "—")}</span>
            <span style="color:var(--color-ink-muted)">（${escHtml(other.officeName || "事業所名なし")}）</span>
            ： <strong>${escHtml(cf.otherText)}</strong>
          </span>
        </label>
      </fieldset>`).join("");

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2><i class="ti ti-arrow-merge" aria-hidden="true"></i> 統合する内容を選んでください</h2>
          <button class="btn btn-secondary" data-merge-cancel type="button" aria-label="閉じる">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>
        <div class="modal-body">
          <div style="display:grid;gap:8px;margin-bottom:14px">
            <div style="border-left:4px solid var(--color-success);background:var(--color-success-soft);padding:8px 12px;border-radius:6px">
              <div style="font-size:12px;font-weight:700;color:var(--color-success)">
                <i class="ti ti-check" aria-hidden="true"></i> 残る案件（いま開いている案件）
              </div>
              <div style="font-size:14px;font-weight:700">#${escHtml(keep.caseNumber || "—")}　${escHtml(keep.officeName || "（事業所名未登録）")}</div>
              <div style="font-size:12px;color:var(--color-ink-muted)">${escHtml(sub(keep))}</div>
            </div>
            <div style="border-left:4px solid var(--color-danger);background:var(--color-danger-soft);padding:8px 12px;border-radius:6px">
              <div style="font-size:12px;font-weight:700;color:var(--color-danger)">
                <i class="ti ti-archive" aria-hidden="true"></i> 消える案件（対象外「重複」になります）
              </div>
              <div style="font-size:14px;font-weight:700">#${escHtml(other.caseNumber || "—")}　${escHtml(other.officeName || "（事業所名未登録）")}</div>
              <div style="font-size:12px;color:var(--color-ink-muted)">${escHtml(sub(other))}</div>
            </div>
          </div>
          <p style="font-size:13px;font-weight:700;color:var(--color-danger);margin-bottom:10px">
            <i class="ti ti-alert-triangle" aria-hidden="true"></i> この操作は元に戻せません。
          </p>
          <p style="font-size:13px;color:var(--color-ink-muted);margin-bottom:10px">
            値が食い違う項目が ${conflicts.length} 件あります。残す方を選んでください（初期値は「残る案件」の値）。
          </p>
          ${rows}
          ${autoNotes.length ? `
            <div style="font-size:12px;color:var(--color-ink-muted);border-top:1px solid var(--color-line);padding-top:8px">
              <i class="ti ti-info-circle" aria-hidden="true"></i> 空欄のため自動で補完する項目：
              ${escHtml(autoNotes.join(" / "))}
            </div>` : ""}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-merge-cancel type="button">キャンセル</button>
          <button class="btn btn-primary" data-merge-ok type="button">
            <i class="ti ti-arrow-merge" aria-hidden="true"></i>この内容で統合する
          </button>
        </div>
      </div>`;

    const close = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); };

    overlay.querySelectorAll("[data-merge-cancel]").forEach((b) =>
      b.addEventListener("click", () => close(null)));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector("[data-merge-ok]").addEventListener("click", () => {
      const choices = {};
      conflicts.forEach((cf) => {
        const el = overlay.querySelector(`input[name="mrg-${cf.field.key}"]:checked`);
        choices[cf.field.key] = el ? el.value : "keep";
      });
      close(choices);
    });

    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector("input[type=radio]")?.focus();
  });
}

// other を当案件（primary）に統合する（管理者・スタッフのみ）
async function mergeInto(other) {
  if (!canMerge) { alert("案件の統合は管理者・スタッフのみ可能です"); return; }
  const keep = currentCase;
  const { autoFill, autoNotes, conflicts } = computeMergeDiffs(keep, other);

  // 食い違いがあれば選択モーダル、無ければ従来どおり確認ダイアログのみ
  let choices = null;
  if (conflicts.length) {
    choices = await openMergeChoiceModal(keep, other, conflicts, autoNotes);
    if (!choices) return;   // キャンセル
  } else if (!confirm(`案件 #${other.caseNumber || ""}「${other.officeName || ""}」を、この案件 #${keep.caseNumber || ""} に統合します。\n統合元は「対象外（重複）」になります。\nこの操作は元に戻せません。よろしいですか？`)) {
    return;
  }

  // 採用結果を反映（自動補完 → 選択結果 の順に上書き）
  const fill = { ...autoFill };
  const chosenNotes = [];
  conflicts.forEach((cf) => {
    const useOther = choices[cf.field.key] === "other";
    if (useOther) Object.assign(fill, cf.field.pick(other));
    const from = useOther ? other : keep;
    chosenNotes.push(`${cf.field.label}: ${cf.field.text(from) || "—"} を採用`
      + `（${useOther ? `統合元 #${other.caseNumber || "—"}` : `この案件 #${keep.caseNumber || "—"}`}）`);
  });

  try {
    const batch = writeBatch(db);
    // 統合元の記録・セッションを当案件へ付け替え
    for (const col of ["activities", "sessions"]) {
      const snap = await getDocs(query(collection(db, col), where("caseId", "==", other._id)));
      snap.forEach((d) => batch.update(d.ref, { caseId }));
    }

    // チェックリスト類（doc ID = caseId）を引き継ぐ。残る側に無いものだけ移し、絶対に上書きしない。
    const clState = {};
    const clData = {};
    for (const { col } of MERGE_DOC_COLLECTIONS) {
      const [keepSnap, otherSnap] = await Promise.all([
        getDoc(doc(db, col, caseId)),
        getDoc(doc(db, col, other._id)),
      ]);
      clState[col] = { keepExists: keepSnap.exists(), otherExists: otherSnap.exists() };
      if (otherSnap.exists()) clData[col] = otherSnap.data();
    }
    const carry = planChecklistCarryOver(clState);
    for (const { col } of MERGE_DOC_COLLECTIONS) {
      const st = clState[col];
      if (!st.otherExists || st.keepExists) continue;   // 統合元に無い／残る側にある → 触らない
      const data = { ...clData[col] };
      if ("caseId" in data) data.caseId = caseId;       // subsidyApplications は自分の caseId を持つ
      data.mergedFromCaseId = other._id;                // どこから来たかを残す
      data.updatedAt = serverTimestamp();
      batch.set(doc(db, col, caseId), data, { merge: true });
    }
    // 統合元側のドキュメントは消さない（対象外になるだけで参照はされないため、記録として残す）

    fill.updatedAt = serverTimestamp();
    batch.update(doc(db, "cases", caseId), fill);
    // 統合元を対象外（重複）に
    batch.update(doc(db, "cases", other._id), {
      archived: true, archivedReason: "duplicate", mergedInto: caseId,
      archivedAt: serverTimestamp(),
      archivedBy: currentUser?.displayName || currentUser?.email || "",
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
    // 内容差分を失わないよう、統合元の要点と採用結果を当案件のタイムラインに残す
    const detail = [
      `流入元: ${SOURCE_LABELS[other.source] || other.source || "—"}`,
      `ステータス: ${STATUS_LABELS[other.status] || "—"}`,
      `紹介元: ${referralLabel(other.referralSource, appSettings) || "—"}`,
      other.assignedUserName ? `担当営業（統合元）: ${other.assignedUserName}` : "",
      other.contactName ? `担当者: ${other.contactName}` : "",
      other.contactEmail ? `メール: ${other.contactEmail}` : "",
      other.contactPhone ? `電話: ${other.contactPhone}` : "",
      other.subsidyCategory ? `補助区分: ${other.subsidyCategory}` : "",
      other.expectedSubsidyAmount ? `想定補助額: ${other.expectedSubsidyAmount}` : "",
      Array.isArray(other.cardReaders) && other.cardReaders.length
        ? `カードリーダー: ${JSON.stringify(other.cardReaders)}` : "",
      chosenNotes.length ? `\n【食い違いの採用結果】\n${chosenNotes.join("\n")}` : "",
      autoNotes.length ? `\n【自動で補完した項目】\n${autoNotes.join("\n")}` : "",
      carry.moved.length
        ? `\n【統合元から引き継いだチェックリスト】\n${carry.moved.map((l) => `${l}（この案件は未入力だったため、統合元 #${other.caseNumber || "—"} の内容をそのまま引き継ぎました）`).join("\n")}`
        : "",
      carry.kept.length
        ? `\n【引き継がなかったチェックリスト（この案件の入力を優先）】\n`
          + carry.kept.map((l) => `${l}: 統合元 #${other.caseNumber || "—"} にも入力がありました。上書きを避けるため引き継いでいません。内容を確認して必要なら手で入れ直してください。`).join("\n")
        : "",
    ].filter(Boolean).join("\n");
    await logActivity(`重複案件 #${other.caseNumber || ""} を統合`, detail);
    showToast("統合しました");
    setTimeout(() => location.reload(), 700);
  } catch (e) {
    alert(`統合に失敗しました: ${e.message || e}`);
  }
}

// 対応記録追加
async function addActivity(userId, userName) {
  const type = document.getElementById("activityType").value;
  const subject = document.getElementById("activitySubject").value.trim();
  const body = document.getElementById("activityBody").value.trim();
  if (!subject && !body) { alert("件名または内容を入力してください"); return; }

  const btn = document.getElementById("addActivityBtn");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "activities"), {
      caseId,
      type,
      occurredAt: serverTimestamp(),
      userId,
      userName,
      subject,
      body,
      attachmentUrls: [],
    });
    await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });
    document.getElementById("activitySubject").value = "";
    document.getElementById("activityBody").value = "";
    showToast("記録を追加しました");
  } finally {
    btn.disabled = false;
  }
}

function showToast(msg) {
  let toast = document.getElementById("_toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "_toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.setAttribute("aria-atomic", "true");
    Object.assign(toast.style, {
      position: "fixed", bottom: "24px", right: "24px",
      background: "#2C2416", color: "#fff", padding: "10px 18px",
      borderRadius: "8px", fontSize: "13px", zIndex: "9999",
      display: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    });
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.display = "none"; }, 2500);
}

// ===== 伴走支援セッション =====
// 記録した伴走支援セッションは、あとから直せる（2026-09-02 追加）。
// 現場からの要望: 記載漏れの追記や書き間違いの訂正が実際に起きる。
// 誰がいつ直したかは残す（支援の記録なので、黙って書き換わらないようにする）。
let editingSessionId = null;   // 編集中の記録。null なら全部が表示モード
let sessionsCache = [];        // 編集の保存後に描画し直すため保持

function renderSessions(sessions) {
  sessionsCache = sessions;
  const el = document.getElementById("sessionsEl");
  if (!sessions.length) {
    el.innerHTML = `<div class="empty-state"><i class="ti ti-camera" aria-hidden="true"></i><p>伴走支援の記録がありません</p></div>`;
    return;
  }
  el.innerHTML = sessions.map((s) =>
    s._id === editingSessionId ? sessionEditHtml(s) : sessionViewHtml(s)
  ).join("");
  wireSessionButtons();
}

function sessionViewHtml(s) {
  const photos = (s.photoUrls || []).map((u) =>
    `<a href="${u}" target="_blank" rel="noopener"><img class="session-photo" src="${u}" alt="支援写真" loading="lazy"></a>`
  ).join("");
  const edited = s.updatedAt
    ? `<div style="font-size:11px;color:var(--color-ink-muted);margin-top:6px">編集済み ${formatDateTime(s.updatedAt)}${s.updatedBy ? `（${escHtml(s.updatedBy)}）` : ""}</div>`
    : "";
  return `
    <div class="card" style="margin-bottom:var(--space-3)">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
          <strong style="font-size:14px"><i class="ti ti-calendar-event" aria-hidden="true"></i> ${escHtml(s.sessionDate || "日付未設定")}</strong>
          <span style="font-size:12px;color:var(--color-ink-muted);margin-left:auto">${escHtml(s.userName || "")} ・ ${formatDateTime(s.createdAt)}</span>
          <button class="btn btn-secondary sess-edit" data-id="${s._id}" type="button" style="font-size:12px;padding:4px 10px"><i class="ti ti-edit" aria-hidden="true"></i>編集</button>
        </div>
        ${s.summary ? `<div style="font-size:13px;white-space:pre-wrap;margin-bottom:${photos ? "10px" : "0"}">${escHtml(s.summary)}</div>` : ""}
        ${photos ? `<div class="session-photos">${photos}</div>` : ""}
        ${edited}
      </div>
    </div>`;
}

function sessionEditHtml(s) {
  const photos = (s.photoUrls || []).map((u) => `
    <div style="position:relative;display:inline-block">
      <img class="session-photo" src="${u}" alt="支援写真" loading="lazy">
      <button class="sess-photo-del" data-url="${u.replace(/"/g, "&quot;")}" type="button" aria-label="この写真を外す"
        style="position:absolute;top:2px;right:2px;width:24px;height:24px;border-radius:50%;border:none;background:rgba(184,74,74,.92);color:#fff;font-size:14px;line-height:1;cursor:pointer">×</button>
    </div>`).join("");
  return `
    <div class="card" style="margin-bottom:var(--space-3);border-color:var(--color-primary)">
      <div class="card-body">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px"><i class="ti ti-edit" aria-hidden="true"></i> この記録を編集しています</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="sessEditDate">実施日</label>
            <input class="form-control" type="date" id="sessEditDate" value="${escHtml(s.sessionDate || "")}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="sessEditSummary">支援内容・メモ</label>
          <textarea class="form-control" id="sessEditSummary" rows="6">${escHtml(s.summary || "")}</textarea>
        </div>
        ${photos ? `<div class="form-group"><label class="form-label">いまの写真（×で外せます）</label><div class="session-photos" id="sessEditPhotos">${photos}</div></div>` : ""}
        <div class="form-group">
          <label class="form-label" for="sessEditAdd">写真を追加</label>
          <input class="form-control" type="file" id="sessEditAdd" accept="image/*" multiple>
        </div>
        <div id="sessEditErr" style="display:none;font-size:13px;color:var(--color-danger);font-weight:600;margin-bottom:8px"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary sess-save" data-id="${s._id}" type="button"><i class="ti ti-check" aria-hidden="true"></i>変更を保存</button>
          <button class="btn btn-secondary sess-cancel" type="button">キャンセル</button>
          <button class="btn btn-danger sess-delete" data-id="${s._id}" type="button" style="margin-left:auto"><i class="ti ti-trash" aria-hidden="true"></i>この記録を削除</button>
        </div>
      </div>
    </div>`;
}

// 編集中に「×」で外した写真のURL。保存するまで実際には消さない
// （添字で持つと、編集中に購読が更新されて配列がずれたとき別の写真を消してしまう）
let removedPhotoUrls = new Set();

function wireSessionButtons() {
  document.querySelectorAll(".sess-edit").forEach((b) => b.addEventListener("click", () => {
    editingSessionId = b.dataset.id;
    removedPhotoUrls = new Set();
    renderSessions(sessionsCache);
  }));
  document.querySelectorAll(".sess-cancel").forEach((b) => b.addEventListener("click", () => {
    editingSessionId = null;
    removedPhotoUrls = new Set();
    renderSessions(sessionsCache);
  }));
  document.querySelectorAll(".sess-photo-del").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.url) removedPhotoUrls.add(b.dataset.url);
    b.closest("div").style.display = "none";
  }));
  document.querySelectorAll(".sess-save").forEach((b) => b.addEventListener("click", () => saveSessionEdit(b.dataset.id)));
  document.querySelectorAll(".sess-delete").forEach((b) => b.addEventListener("click", () => deleteSession(b.dataset.id)));
}

// 編集の保存。写真は「外した分をStorageからも消す」「追加分をアップする」を両方やる。
// Storage の削除に失敗しても記録の更新は通す（記録が直せないほうが困るため）。
async function saveSessionEdit(sessionId) {
  const s0 = sessionsCache.find((x) => x._id === sessionId);
  if (!s0) return;
  const dateEl = document.getElementById("sessEditDate");
  const sumEl = document.getElementById("sessEditSummary");
  const addEl = document.getElementById("sessEditAdd");
  const err = document.getElementById("sessEditErr");
  const btn = document.querySelector(".sess-save");
  err.style.display = "none";

  const sessionDate = dateEl.value;
  const summary = sumEl.value.trim();
  const addFiles = Array.from(addEl.files || []);
  const kept = (s0.photoUrls || []).filter((u) => !removedPhotoUrls.has(u));
  const removed = (s0.photoUrls || []).filter((u) => removedPhotoUrls.has(u));

  if (!sessionDate && !summary && !kept.length && !addFiles.length) {
    err.textContent = "実施日・メモ・写真のいずれかを残してください（全部空にはできません）";
    err.style.display = "block";
    return;
  }

  const orig = btn.innerHTML;
  btn.disabled = true;
  const uploadedRefs = []; // 記録の更新に失敗したら、アップした分は片付ける（宙に浮いた写真を残さない）
  try {
    const urls = [...kept];
    for (let i = 0; i < addFiles.length; i++) {
      btn.innerHTML = `<i class="ti ti-loader-2 ti-spin"></i> 写真をアップ中 ${i + 1}/${addFiles.length}`;
      const f = addFiles[i];
      const safeName = `${Date.now()}_${i}_${f.name.replace(/[^\w.\-]/g, "_")}`;
      const snap = await uploadBytes(storageRef(storage, `sessions/${sessionId}/photos/${safeName}`), f);
      uploadedRefs.push(snap.ref);
      urls.push(await getDownloadURL(snap.ref));
    }

    btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> 保存中...';
    try {
      await updateDoc(doc(db, "sessions", sessionId), {
        sessionDate: sessionDate || "",
        summary,
        photoUrls: urls,
        updatedAt: serverTimestamp(),
        updatedBy: currentUser?.displayName || currentUser?.email || "",
      });
    } catch (e) {
      for (const r of uploadedRefs) { try { await deleteObject(r); } catch (_) { /* 掃除の失敗は無視 */ } }
      throw e;
    }

    // 外した写真は実体も消す（利用者情報が写り込む可能性があるため残さない）
    for (const u of removed) {
      try { await deleteObject(storageRef(storage, u)); } catch (_) { /* 実体が無い等は無視 */ }
    }

    // 何をどう直したかをタイムラインに残す
    await addDoc(collection(db, "activities"), {
      caseId,
      type: "visit",
      occurredAt: serverTimestamp(),
      userId: currentUser?.uid || "",
      userName: currentUser?.displayName || currentUser?.email || "",
      subject: `伴走支援セッションを編集${sessionDate ? `（${sessionDate}）` : ""}`,
      body: summary + (removed.length ? `\n写真${removed.length}枚を削除` : "") + (addFiles.length ? `\n写真${addFiles.length}枚を追加` : ""),
      attachmentUrls: [],
    });
    await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });

    editingSessionId = null;
    removedPhotoUrls = new Set();
    showToast("伴走支援の記録を更新しました");
    renderSessions(latestSessions); // 編集中は購読側の描画を止めているので、ここで戻す
  } catch (e) {
    err.textContent = `保存に失敗しました: ${e.message}`;
    err.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function deleteSession(sessionId) {
  const s0 = sessionsCache.find((x) => x._id === sessionId);
  if (!s0) return;
  const photoNote = (s0.photoUrls || []).length ? `\n添付の写真${s0.photoUrls.length}枚も削除されます。` : "";
  if (!confirm(`${s0.sessionDate || "日付未設定"} の伴走支援の記録を削除します。${photoNote}\nこの操作は元に戻せません。よろしいですか？`)) return;
  try {
    // 先に記録を消し、通ったら写真の実体を消す（逆だと、記録の削除に失敗したとき写真だけ無い記録が残る）
    await deleteDoc(doc(db, "sessions", sessionId));
    for (const u of (s0.photoUrls || [])) {
      try { await deleteObject(storageRef(storage, u)); } catch (_) { /* 実体が無い等は無視 */ }
    }
    await addDoc(collection(db, "activities"), {
      caseId,
      type: "visit",
      occurredAt: serverTimestamp(),
      userId: currentUser?.uid || "",
      userName: currentUser?.displayName || currentUser?.email || "",
      subject: `伴走支援セッションを削除（${s0.sessionDate || "日付未設定"}）`,
      body: s0.summary || "",
      attachmentUrls: [],
    });
    await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });
    editingSessionId = null;
    showToast("伴走支援の記録を削除しました");
    renderSessions(latestSessions); // 編集中は購読側の描画を止めているので、ここで戻す
  } catch (e) {
    alert(`削除に失敗しました: ${e.message}`);
  }
}

async function addSession(userId, userName) {
  const dateEl = document.getElementById("sessionDate");
  const summaryEl = document.getElementById("sessionSummary");
  const filesEl = document.getElementById("sessionPhotos");
  const sessionDate = dateEl.value;
  const summary = summaryEl.value.trim();
  const files = Array.from(filesEl.files || []);
  if (!sessionDate && !summary && !files.length) {
    alert("実施日・メモ・写真のいずれかを入力してください");
    return;
  }

  const btn = document.getElementById("addSessionBtn");
  const progress = document.getElementById("sessionUploadProgress");
  btn.disabled = true;
  progress.style.display = files.length ? "block" : "none";

  try {
    // 先にセッションdocを作成（IDをStorageパスに使う）
    const sessRef = await addDoc(collection(db, "sessions"), {
      caseId,
      sessionDate: sessionDate || "",
      summary,
      userId,
      userName,
      photoUrls: [],
      createdAt: serverTimestamp(),
    });

    // 写真をStorageへアップロード（sessions/{sessionId}/photos/{name}）
    const urls = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const safeName = `${Date.now()}_${i}_${f.name.replace(/[^\w.\-]/g, "_")}`;
      const path = `sessions/${sessRef.id}/photos/${safeName}`;
      const snap = await uploadBytes(storageRef(storage, path), f);
      urls.push(await getDownloadURL(snap.ref));
    }
    if (urls.length) {
      await updateDoc(doc(db, "sessions", sessRef.id), { photoUrls: urls });
    }

    // タイムラインにも記録（種別: 訪問・対面）
    await addDoc(collection(db, "activities"), {
      caseId,
      type: "visit",
      occurredAt: serverTimestamp(),
      userId,
      userName,
      subject: `伴走支援セッション${sessionDate ? `（${sessionDate}）` : ""}`,
      body: summary + (urls.length ? `\n写真${urls.length}枚を添付` : ""),
      attachmentUrls: urls,
    });
    await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });

    dateEl.value = ""; summaryEl.value = ""; filesEl.value = "";
    const pc = document.getElementById("photoCount"); if (pc) pc.textContent = "";
    showToast("伴走支援セッションを記録しました");
  } catch (e) {
    alert(`記録に失敗しました: ${e.message}`);
  } finally {
    btn.disabled = false;
    progress.style.display = "none";
  }
}

// ===== AIアシスタント =====
const aiAssistFn = httpsCallable(functions, "aiAssist");

function buildAiContext() {
  const c = currentCase || {};
  const crs = (c.cardReaders || []).map((r) =>
    `${r.type}×${(Number(r.subsidyQty) || 0) + (Number(r.extraQty) || 0)}台`).join(", ");
  return {
    officeName: c.officeName, corpName: c.corpName, contactName: c.contactName,
    source: SOURCE_LABELS[c.source] || c.source,
    statusLabel: STATUS_LABELS[c.status] || "",
    subsidyPlan: c.subsidyPlan || "", cardReaders: crs,
    message: c.message || "",
    timeline: latestActivities.map((a) =>
      `[${ACTIVITY_LABELS[a.type] || a.type}] ${a.subject || ""} ${a.body || ""}`.trim()),
    sessionNotes: latestSessions.map((s) =>
      `${s.sessionDate || ""} ${s.summary || ""}`.trim()).filter(Boolean),
  };
}

let lastAiTask = null;

async function runAi(task) {
  const loading = document.getElementById("aiLoading");
  const wrap = document.getElementById("aiResultWrap");
  const btns = document.querySelectorAll(".ai-btn");
  btns.forEach((b) => (b.disabled = true));
  loading.style.display = "block";
  wrap.style.display = "none";
  try {
    const question = document.getElementById("aiQuestion").value.trim();
    const res = await aiAssistFn({ task, context: buildAiContext(), question });
    const text = res?.data?.text || "（応答が空でした）";
    lastAiTask = task;
    document.getElementById("aiResultTitle").textContent = AI_TITLES[task] || "生成結果";
    document.getElementById("aiResult").textContent = text;
    // 返信下書きのときだけ「送信欄へ転記」を出す
    document.getElementById("aiToComposerBtn").style.display = task === "reply_draft" ? "" : "none";
    wrap.style.display = "block";
  } catch (e) {
    document.getElementById("aiResultTitle").textContent = "エラー";
    document.getElementById("aiResult").textContent =
      `AI処理に失敗しました: ${e.message || e}`;
    wrap.style.display = "block";
  } finally {
    loading.style.display = "none";
    btns.forEach((b) => (b.disabled = false));
  }
}

function copyAiResult() {
  const text = document.getElementById("aiResult").textContent;
  navigator.clipboard.writeText(text).then(() => showToast("コピーしました"));
}

// AI返信下書きを送信欄へ転記（件名/本文を分離）
function aiResultToComposer() {
  const text = document.getElementById("aiResult").textContent || "";
  const m = text.match(/件名[:：]\s*(.+)/);
  let subject = "", body = text;
  if (m) {
    subject = m[1].trim();
    body = text.replace(/件名[:：].*(\r?\n)+/, "").replace(/^本文[:：]\s*/m, "").trim();
  }
  if (subject) document.getElementById("mailSubject").value = subject;
  document.getElementById("mailBody").value = body;
  if (currentCase?.contactEmail && !document.getElementById("mailTo").value) {
    document.getElementById("mailTo").value = currentCase.contactEmail;
  }
  document.getElementById("mailBody").scrollIntoView({ behavior: "smooth", block: "center" });
  showToast("送信欄に転記しました");
}

// メール送信
const sendCaseEmailFn = httpsCallable(functions, "sendCaseEmail");
async function sendMail() {
  const to = document.getElementById("mailTo").value.trim();
  const subject = document.getElementById("mailSubject").value.trim();
  const body = document.getElementById("mailBody").value.trim();
  const status = document.getElementById("mailStatus");
  if (!to || !subject || !body) {
    status.style.color = "var(--color-danger)";
    status.textContent = "宛先・件名・本文をすべて入力してください";
    return;
  }
  if (!confirm(`このメールを送信します。よろしいですか？\n\n宛先: ${to}\n件名: ${subject}`)) return;

  const btn = document.getElementById("sendMailBtn");
  btn.disabled = true;
  status.style.color = "var(--color-ink-muted)";
  status.innerHTML = '<i class="ti ti-loader-2 ti-spin" aria-hidden="true"></i> 送信中...';
  try {
    await sendCaseEmailFn({ to, subject, body, caseId });
    status.style.color = "var(--color-success)";
    status.innerHTML = '<i class="ti ti-circle-check" aria-hidden="true"></i> 送信しました（タイムラインに記録）';
    document.getElementById("mailSubject").value = "";
    document.getElementById("mailBody").value = "";
    showToast("メールを送信しました");
  } catch (e) {
    status.style.color = "var(--color-danger)";
    status.textContent = `送信に失敗しました: ${e.message || e}`;
  } finally {
    btn.disabled = false;
  }
}

// タブ切替
function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// 初期化
onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) {
    location.href = "/index.html";
    return;
  }
  const myRole = await gateRole(db, user);
  applyViewerMode(myRole);
  if (!myRole) return;
  isAdmin = myRole.role === "admin";
  canMerge = myRole.role === "admin" || myRole.role === "staff";
  currentUser = user;

  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));

  initTabs();

  // 伴走チェックリスト（事前/当日/アフター・ケアプラン連携統合）をタブに描画・購読
  initSupportChecklist(db, caseId, storage);

  // 案件データ読み込み
  const caseSnap = await getDoc(doc(db, "cases", caseId));
  if (!caseSnap.exists()) {
    alert("案件が見つかりません");
    location.href = "/cases.html";
    return;
  }

  currentCase = { _id: caseSnap.id, ...caseSnap.data() };

  // 紹介元の選択肢（appConfig/settings.referralSources）。取得に失敗しても既定値で動く。
  try {
    const ss = await getDoc(doc(db, "appConfig", "settings"));
    if (ss.exists()) appSettings = ss.data();
  } catch (_) {}

  // 担当営業の候補（users）。取得に失敗しても「未割当＋現在の担当」だけで動く。
  try {
    const us = await getDocs(collection(db, "users"));
    usersList = us.docs.map((d) => ({ _id: d.id, ...d.data() }));
  } catch (_) { usersList = []; }

  document.getElementById("loadingEl").style.display = "none";
  document.getElementById("mainContent").style.display = "block";
  renderCaseHeader(currentCase);
  // 伴走支援承諾書カード（事前確認タブの先頭）。メールは既存の sendCaseEmail を流用
  initConsentCard({
    db, caseId,
    getCase: () => ({ ...currentCase, email: currentCase.contactEmail || currentCase.email || "" }),
    sendMail: (payload) => sendCaseEmailFn(payload),
    toast: showToast,
    userName: currentUser?.displayName || currentUser?.email || "",
  }).catch((e) => console.warn("consent card init:", e.message));
  // 資料の事前送付カード（承諾書カードの上に出る。挿入順で先頭になるよう後から init）
  initPreGuideCard({
    db, caseId,
    getCase: () => currentCase,
    sendMail: (payload) => sendCaseEmailFn(payload),
    toast: showToast,
  });
  // 見積もりカード（対応記録タブの先頭）。事業所側の見積もりツールで作成された quotes を表示・再送
  initQuoteCard({
    db, caseId,
    getCase: () => currentCase,
    toast: showToast,
    userName: currentUser?.displayName || currentUser?.email || "",
    functions,
  }).catch((e) => console.warn("quote card init:", e.message));
  renderAssigneeSelect();
  renderReferralSelect();
  renderCaseActions();
  renderDuplicateCandidates();

  // 担当営業の変更（ID と 氏名 の両方を保存＋タイムラインに記録）
  document.getElementById("assigneeSelect")?.addEventListener("change", async (e) => {
    const sel = e.target;
    const prev = currentCase.assignedUserId || "";
    sel.disabled = true;
    try {
      await saveAssignee(sel.value);
      renderAssigneeSelect();   // 無効ユーザーから外れた場合に選択肢を作り直す
    } catch (err) {
      sel.value = prev;
      alert(`担当営業の保存に失敗しました: ${err.message || err}`);
    } finally {
      sel.disabled = false;
    }
  });

  // 紹介元の変更（値は id を保存。表示名は保存しない）
  document.getElementById("referralSelect")?.addEventListener("change", async (e) => {
    const sel = e.target;
    const prev = currentCase.referralSource || "";
    sel.disabled = true;
    try {
      await saveReferral(sel.value);
    } catch (err) {
      sel.value = prev;
      alert(`紹介元の保存に失敗しました: ${err.message || err}`);
    } finally {
      sel.disabled = false;
    }
  });

  // ステータス変更
  document.getElementById("statusSelect").addEventListener("change", async (e) => {
    await changeStatus(e.target.value, user.uid, user.displayName || user.email);
    showToast(`ステータスを「${STATUS_LABELS[e.target.value]}」に変更しました`);
  });

  // 対象外にする（理由モーダル）
  const archiveModal = document.getElementById("archiveModal");
  document.getElementById("archiveBtn")?.addEventListener("click", () => archiveModal?.classList.add("open"));
  document.getElementById("archiveCancelBtn")?.addEventListener("click", () => archiveModal?.classList.remove("open"));
  archiveModal?.addEventListener("click", (e) => { if (e.target === e.currentTarget) archiveModal.classList.remove("open"); });
  document.getElementById("archiveConfirmBtn")?.addEventListener("click", () => {
    const reason = document.getElementById("archiveReason").value;
    const note = document.getElementById("archiveNote").value.trim();
    archiveModal?.classList.remove("open");
    archiveCase(reason, note);
  });
  document.getElementById("unarchiveBtn")?.addEventListener("click", unarchiveCase);
  document.getElementById("deleteBtn")?.addEventListener("click", hardDeleteCase);

  // 対応記録追加
  document.getElementById("addActivityBtn").addEventListener("click", () => addActivity(user.uid, user.displayName || user.email));

  // 伴走支援セッション追加
  document.getElementById("addSessionBtn").addEventListener("click", () => addSession(user.uid, user.displayName || user.email));

  // 写真: カメラ撮影 / 選択
  const photoInput = document.getElementById("sessionPhotos");
  const photoCount = document.getElementById("photoCount");
  document.getElementById("cameraBtn").addEventListener("click", () => {
    photoInput.setAttribute("capture", "environment"); // スマホはカメラ起動
    photoInput.removeAttribute("multiple");
    photoInput.click();
  });
  document.getElementById("galleryBtn").addEventListener("click", () => {
    photoInput.removeAttribute("capture");
    photoInput.setAttribute("multiple", "multiple");
    photoInput.click();
  });
  photoInput.addEventListener("change", () => {
    const n = (photoInput.files || []).length;
    photoCount.textContent = n ? `${n}枚 選択中` : "";
  });

  // 書類チェック
  document.querySelectorAll("[data-field]").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const field = chk.dataset.field;
      await saveChecklistField(field, chk.checked);
      const statusKey = chk.id.replace("chk-", "");
      const statusEl = document.getElementById(`status-${statusKey}`);
      if (chk.checked) {
        statusEl.className = "check-done";
        statusEl.innerHTML = `<i class="ti ti-circle-check-filled" aria-hidden="true"></i>`;
      } else {
        statusEl.className = "check-pending";
        statusEl.innerHTML = `<i class="ti ti-circle" aria-hidden="true"></i>`;
      }
    });
  });

  document.getElementById("saveBankBtn").addEventListener("click", saveBankInfo);
  document.getElementById("bankType").addEventListener("change", applyBankType);

  // 申請情報
  document.getElementById("applicationDate").addEventListener("change", updateExpectedDeposit);
  document.getElementById("subsidyStatus").addEventListener("change", toggleRejectionField);
  document.getElementById("saveSubsidyBtn").addEventListener("click", saveSubsidyInfo);

  // 書類チェックリスト購読
  onSnapshot(doc(db, "documentChecklists", caseId), (snap) => {
    renderDocumentChecklist(snap.exists() ? snap.data() : null);
  });

  // 申請情報購読
  onSnapshot(doc(db, "subsidyApplications", caseId), (snap) => {
    renderSubsidy(snap.exists() ? snap.data() : null);
  });

  // タイムライン購読
  const actQ = query(
    collection(db, "activities"),
    where("caseId", "==", caseId),
    orderBy("occurredAt", "desc")
  );
  onSnapshot(actQ, (snap) => {
    latestActivities = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    renderTimeline(latestActivities);
  });

  // 伴走支援セッション購読
  const sessQ = query(
    collection(db, "sessions"),
    where("caseId", "==", caseId),
    orderBy("createdAt", "desc")
  );
  onSnapshot(sessQ, (snap) => {
    latestSessions = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    // 編集中に描き直すと、入力途中の文字が元の値で上書きされて消える。
    // その間は手元のキャッシュだけ更新し、編集を終えてから描き直す。
    if (editingSessionId) { sessionsCache = latestSessions; return; }
    renderSessions(latestSessions);
  });

  // AIアシスタント
  document.querySelectorAll(".ai-btn").forEach((b) =>
    b.addEventListener("click", () => runAi(b.dataset.task)));
  document.getElementById("aiCopyBtn").addEventListener("click", copyAiResult);
  document.getElementById("aiToComposerBtn").addEventListener("click", aiResultToComposer);

  // メール送信
  if (currentCase?.contactEmail) {
    document.getElementById("mailTo").value = currentCase.contactEmail;
  }
  document.getElementById("sendMailBtn").addEventListener("click", sendMail);

  // 報告書PDF
  document.getElementById("reportBtn").setAttribute("href", `/report.html?id=${caseId}`);
  // この案件から出荷を作成（直接出荷フォームへ取り込み）
  document.getElementById("shipFromCaseBtn").setAttribute("href", `/supply.html?ship=${caseId}`);
});
