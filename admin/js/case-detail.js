import { normalizeEmail } from "/js/normalize.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, applyViewerMode, isViewer } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, isPracticeMode, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp, writeBatch, runTransaction }
  from "/js/fs.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from "/js/st.js";
import { getFunctions, httpsCallable }
  from "/js/fn.js";
import { STATUS_LABELS, SOURCE_LABELS, ARCHIVE_REASONS, dupKeys, pairKey,
  referralOptions, referralLabel, NEXT_ACTION, nextActionFor, INQUIRY_INTENT_LABELS, LOST, LOST_REASONS, lostReasonLabel } from "/js/constants.js";
import { ACTIVITY_ICONS, ACTIVITY_LABELS, AI_TITLES, escHtml, formatDateTime, toDateInput, toYmdJst, calcExpectedDeposit, askLostReason,
  officeAddressText, mapsSearchUrl } from "/js/case-detail-util.js";
import { visitSummary } from "/js/schedule-core.js";
// 事業種別（cases.serviceType）と「コピーして別の事業種別で作る」（2026-11-01）
import { serviceTypeOptionsHtml, planHintText, isServiceType, isDupExcludedPair } from "/js/service-types.js";
import { buildCopiedCase, copyActivityTexts } from "/js/case-copy.js";
// 連絡先（担当者名・メール・電話）の訂正
import { buildContactUpdate, contactChangeActivity, quoteNeedsEmailFix } from "/js/case-contact.js";
import { initSupportChecklist } from "/js/support-checklist.js";
import { dateDefault, resolveTab, activityRefLink, sessionAnchorId } from "/js/onsite-record.js";
import { trackUnsaved, unsavedSpanHtml, discardUnsaved } from "/js/save-mode.js";
import { initConsentCard } from "/js/consent-admin.js";
import { initPreGuideCard } from "/js/pre-guide.js";
import { shouldAskSupportDone, supportDoneAskText, SUPPORT_DONE_STATUS } from "/js/record-gaps-case.js";
import { initQuoteCard } from "/js/quote-admin.js";
// 「出荷・請求・入金」タブ用。金額計算はここでは行わず、必ず invoiceTotals（正本）を通す
import { invoiceTotals } from "/js/invoice-doc.js";
// 申請タブ「申請で入れる値」（2026-11-12）。A・B・X の振り分けは領収証と同じ正本を通す
import { caseSubsidyAmounts, subsidyCountsFromShipment, subsidyCountsFromQuote, inputMismatches, sourceText } from "/js/subsidy-amounts.js";
import { SHIP_STATUS_LABEL, SHIP_STATUS_BADGE, shipStatusOf, shipStepsDone, isPickup, mailedPendingNotes } from "/js/ship-flow.js";
// 完了(13)の警告・出荷の重複の判定（波1の部品と、画面用の判定 screen-rules.js）
import { completionWarnings } from "/js/case-complete-check.js";
import { isCompleting, completionConfirmText, completionActivityNote,
  caseDuplicateBanner, preShipCountAfterMerge,
  isFinishingSupport, invoicePending, invoicePromptText, invoicePromptUrl, invoicePromptNote } from "/js/screen-rules.js";
// 手で「受注確定」にしたときの受注日の補い（設計書 CRM改善_設計書_20261110 §3 点検10・2026-11-10）
import { orderedAtFillNeeded, ORDERED_AT_FILLED_NOTE } from "/js/record-gaps.js";
import { orderConsentNoticeOf } from "/js/record-gaps.js"; // 承諾書の取り直し（2026-11-12）
// 見積もり必須・承諾書のサイン＝発注（2026-11-12・設定 appConfig/settings.orderByConsent がオンのときだけ画面が変わる）
import { orderByConsentOn, statusChangeGuard, blockedStatusOptions, manualStatusNote } from "/js/order-consent.js";

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
// 「コピーして別の事業種別で作る」＝閲覧のみ以外（書き込みはルールの isEditor と同じ範囲）
let canCopy = false;
let currentUser = null;
let supportChecklist = null; // initSupportChecklist の戻り値（refreshPeople）
// appConfig/settings（紹介元の一覧などを持つ）。読み込み前は既定値で動く。
let appSettings = {};
// 承諾書のサイン＝発注のスイッチ（練習モードでは練習DBの設定。fs.js が切り替える）
const orderOn = () => orderByConsentOn(appSettings);
// users コレクション（担当営業の候補。doc id = メールアドレス / name・role・active を持つ）
let usersList = [];
// 「出荷・請求・入金」タブが購読している shipments のキャッシュ。
// ヘッダー「次の一手」2行目（お金の流れ）が同じデータ・同じ判定関数を再利用するために保持（二重購読しない）。
let shipmentsCache = [];
// 申請情報（subsidyApplications/{caseId}）の購読結果。完了(13)にするときの警告に使う（無ければ null）
let subsidyCache = null;
// 「申請で入れる値」の計算結果（caseSubsidyAmounts の戻り）。手入力の欄との突き合わせに使う（まだ無ければ null）
let subsidyAuto = null;
let subsidyAutoSeq = 0; // 出荷の購読が続けて来たとき、古い読み込みの結果で描き直さないための番号

// 「ご希望」（inquiryIntent）を流入元の隣に表示。「正式に申込みたい」は目立つ色のバッジにする
// （既存の badge-1 の赤系トーンを流用。色の直書きはせず既存の意味色パレットに合わせる）。
function inquiryIntentBadge(intent) {
  const label = INQUIRY_INTENT_LABELS[intent] || intent;
  const cls = intent === "order" ? "badge-1" : "badge-2";
  return `<span class="badge ${cls}">ご希望: ${escHtml(label)}</span>`;
}

// 見出しの1行（法人・担当者・電話・メール・住所・流入元・ご希望）。
// 住所は後から読むので、読み終えたらこの行だけ描き直す（ステータス・訪問予定日の入力は触らない）
function renderCaseMeta(c) {
  const metaEl = document.getElementById("caseMeta");
  metaEl.innerHTML = [
    c.corpName ? `<span class="case-meta-item"><i class="ti ti-building" aria-hidden="true"></i>${escHtml(c.corpName)}</span>` : "",
    c.contactName ? `<span class="case-meta-item"><i class="ti ti-user" aria-hidden="true"></i>${escHtml(c.contactName)}</span>` : "",
    c.contactPhone ? `<span class="case-meta-item"><i class="ti ti-phone" aria-hidden="true"></i>${escHtml(c.contactPhone)}</span>` : "",
    c.contactEmail ? `<span class="case-meta-item"><i class="ti ti-mail" aria-hidden="true"></i>${escHtml(c.contactEmail)}</span>` : "",
    officeAddressItem(),
    `<span class="case-meta-item"><i class="ti ti-tag" aria-hidden="true"></i>${SOURCE_LABELS[c.source] || c.source || "—"}</span>`,
    c.inquiryIntent ? `<span class="case-meta-item">${inquiryIntentBadge(c.inquiryIntent)}</span>` : "",
  ].filter(Boolean).join("");
}

function renderCaseHeader(c) {
  document.title = `#${c.caseNumber || "—"} ${c.officeName || ""} — タダカヨ CRM`;
  document.getElementById("caseNumber").textContent = `案件 #${c.caseNumber || "—"}`;
  document.getElementById("caseTitle").textContent = c.officeName || "（事業所名未登録）";

  renderCaseMeta(c);

  const statusSel = document.getElementById("statusSelect");
  statusSel.value = String(c.status || 1);
  applyStatusGuard(c);
  renderLostReason(c);
  const vd = document.getElementById("visitDateInput");
  if (vd) vd.value = c.visitDate || "";
  renderVisitExtras(c);
}

// 状態の選択の制限（発5・スイッチがオンのとき）。受注前（1・2）の案件は 3〜12 を選べなくする（管理者は選べて、理由を聞く）
function applyStatusGuard(c) {
  const sel = document.getElementById("statusSelect");
  if (!sel) return;
  const blocked = new Set(blockedStatusOptions({ from: c?.status, orderByConsent: orderOn(), isAdmin, caseData: c }).map(String));
  for (const opt of sel.options) {
    const was = opt.dataset.origLabel || opt.textContent;
    opt.dataset.origLabel = was;
    opt.disabled = blocked.has(opt.value);
    opt.textContent = blocked.has(opt.value) ? `${was}（承諾書の受け取りで進みます）` : was;
  }
}

// 訪問の時刻・形式（visitTimeFrom / visitTimeTo "HH:MM"・visitFormat "onsite"|"online"）。日付が空なら無効
function renderVisitExtras(c, force = false) {
  const hasDate = !!c.visitDate;
  [["visitTimeFromInput", c.visitTimeFrom], ["visitTimeToInput", c.visitTimeTo], ["visitFormatSelect", c.visitFormat]].forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (!el || (!force && el === document.activeElement)) return;
    el.value = v || "";
    el.disabled = !hasDate;
    el.title = hasDate ? "" : "先に訪問予定日を入れてください";
  });
}

// 事業所の住所（2026-10-26 前田さんの要望：電話・メールと並べて出す）。
// undefined＝読み込み中（何も出さない）／""＝未登録（事業所の画面で入れてもらう）
let officeAddress;
function officeAddressItem() {
  if (officeAddress === undefined) return "";
  if (!officeAddress) {
    return `<span class="case-meta-item"><i class="ti ti-map-pin" aria-hidden="true"></i><a href="/offices.html">住所未登録（事業所の画面で入力）</a></span>`;
  }
  const url = mapsSearchUrl(officeAddress);
  return `<span class="case-meta-item"><i class="ti ti-map-pin" aria-hidden="true"></i><a href="${escHtml(url)}" target="_blank" rel="noopener" title="Google マップで開く">${escHtml(officeAddress)}</a></span>`;
}
async function loadOfficeAddress(c) {
  if (!c.officeId) { officeAddress = ""; renderCaseMeta(currentCase); return; }
  try {
    const snap = await getDoc(doc(db, "offices", c.officeId));
    officeAddress = snap.exists() ? officeAddressText(snap.data()) : "";
  } catch (_) {
    officeAddress = undefined; // 読めないときは出さない（権限・通信の失敗で「未登録」と誤って出さない）
  }
  renderCaseMeta(currentCase);
}

// 失注の理由の表示（ステータス横）。失注でなければ隠す。既存の失注案件は「未記入」。
function renderLostReason(c) {
  const el = document.getElementById("lostReasonInfo");
  if (!el) return;
  if (Number(c.status) !== LOST) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "inline";
  el.textContent = `理由: ${lostReasonLabel(c)}${c.lostReasonNote ? `（${c.lostReasonNote}）` : ""}`;
}

// ===== 訪問予定日（visitDate: "YYYY-MM-DD" の文字列） =====
// 担当営業と同じ作法で、誰がいつ何日に変えたかをタイムラインに残す。
async function saveVisitDate(value) {
  await flushVisitLog(); // 保留中の時刻・形式の記録を先に書く（記録の順序を保つ）
  const v = value || null;
  const before = visitSnapshot();
  // 日付を消したら時刻・形式も外す（日付の無い時刻だけが残らないように）
  const upd = v ? { visitDate: v, updatedAt: serverTimestamp() }
    : { visitDate: null, visitTimeFrom: null, visitTimeTo: null, visitFormat: null, updatedAt: serverTimestamp() };
  await updateDoc(doc(db, "cases", caseId), upd);
  const { updatedAt: _u, ...patch } = upd;
  Object.assign(currentCase, patch);
  renderVisitExtras(currentCase, true);
  supportChecklist?.refreshVisitDate?.(); // 当日タブの訪問日欄（未保存の表示）と実施日の初期値を新しい日へ（レビュー 中-3）
  await logActivity(`訪問予定日変更 → ${v || "未設定"}`, `変更前: ${before.visitDate || "未設定"}`);
  showToast(v ? `訪問予定日を ${v} にしました` : "訪問予定日を未設定にしました");
}

function visitSnapshot() {
  return {
    visitDate: currentCase.visitDate || "", visitTimeFrom: currentCase.visitTimeFrom || "",
    visitTimeTo: currentCase.visitTimeTo || "", visitFormat: currentCase.visitFormat || "",
  };
}

// 時刻・形式の変更。保存はその都度、活動記録は最後の変更から約2秒まとめて1件にする
// （開始→終了→形式と続けて入れても記録が増えない）。変更前は最初の変更前、変更後は最後の値。
const VISIT_LOG_DELAY_MS = 2000;
let pendingVisitLog = null; // { before, timer }

async function flushVisitLog() {
  const p = pendingVisitLog;
  if (!p) return;
  pendingVisitLog = null;
  clearTimeout(p.timer);
  const after = visitSnapshot();
  if (JSON.stringify(p.before) === JSON.stringify(after)) return; // 元に戻したときは記録しない
  try {
    await logActivity(`訪問予定を変更 → ${visitSummary(after)}`, `変更前: ${visitSummary(p.before)}`);
  } catch (e) { console.warn("visit log:", e.message); }
}
window.addEventListener("pagehide", () => { flushVisitLog(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushVisitLog(); });

async function saveVisitExtras() {
  const before = pendingVisitLog ? pendingVisitLog.before : visitSnapshot();
  const from = document.getElementById("visitTimeFromInput").value || "";
  let to = document.getElementById("visitTimeToInput").value || "";
  const fmt = document.getElementById("visitFormatSelect").value || "";
  if (!from) to = ""; // 開始が無いのに終了だけは持たない
  if (from && to && to <= from) throw new Error("終了時刻は開始時刻より後にしてください");
  const patch = { visitTimeFrom: from || null, visitTimeTo: to || null, visitFormat: fmt || null };
  await updateDoc(doc(db, "cases", caseId), { ...patch, updatedAt: serverTimestamp() });
  Object.assign(currentCase, patch);
  if (!from) document.getElementById("visitTimeToInput").value = ""; // 開始を消したら終了も外れる
  if (pendingVisitLog) clearTimeout(pendingVisitLog.timer);
  pendingVisitLog = { before, timer: setTimeout(flushVisitLog, VISIT_LOG_DELAY_MS) };
  showToast(`訪問予定を ${visitSummary(visitSnapshot())} にしました`);
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
  // assignedBy / assignedAt は「誰が担当を決めたか」。Functions（onCaseAssigned）がこれで
  // 画面からの割り当てを見分け、自分で自分を担当にしたときはメンションしない（設計 §3 N1）。
  // ⚠️ 統合（mergeInto）で担当を書き換えるときは assignedBy を書かない（通知を出さないため）。
  await updateDoc(doc(db, "cases", caseId), {
    assignedUserId: id, assignedUserName: name, updatedAt: serverTimestamp(),
    assignedBy: currentUser?.email || null, assignedAt: serverTimestamp(),
  });
  currentCase.assignedUserId = id;
  currentCase.assignedUserName = name;
  // 誰がいつ担当を変えたか追えるようにタイムラインへ記録
  await logActivity(`担当営業変更 → ${name || "未割当"}`, `変更前: ${prevName}`);
  showToast(name ? `担当営業を「${name}」にしました` : "担当営業を未割当にしました");
}

// ===== 紹介元（referralSource） =====
// ⚠️ source（LP問い合わせ/見積もり作成/手動登録＝流入経路）とは別物。こちらは「誰の紹介で来たか」。
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

// ===== 事業種別（serviceType・2026-11-01） =====
// 1事業（事業種別）＝1案件。値は service-types.js の正式名。未設定は null。
// 「プランの目安」は表示するだけ（subsidyCategory などを自動で書き換えない）。
function renderServiceTypeSelect() {
  const sel = document.getElementById("serviceTypeSelect");
  if (!sel) return;
  const cur = currentCase?.serviceType || "";
  sel.innerHTML = serviceTypeOptionsHtml(cur, escHtml);
  sel.value = cur;
  const hint = document.getElementById("servicePlanHint");
  if (hint) hint.textContent = planHintText(cur);
}

async function saveServiceType(value) {
  const prev = currentCase.serviceType || "";
  const v = value || null;
  if (v && !isServiceType(v) && v !== prev) throw new Error("一覧にない事業種別です");
  await updateDoc(doc(db, "cases", caseId), { serviceType: v, updatedAt: serverTimestamp() });
  currentCase.serviceType = v;
  // 誰がいつ事業種別を変えたか追えるように、担当営業と同じ作法でタイムラインへ記録
  await logActivity(`事業種別変更 → ${v || "未設定"}`, `変更前: ${prev || "未設定"}`);
  showToast(v ? `事業種別を「${v}」にしました` : "事業種別を未設定にしました");
}

// ===== この案件をコピーして、別の事業種別で作る（2026-11-01） =====
// 案件番号は _counters/cases の連番。既存の新規作成と同じくトランザクションで払い出し、
// 新しい案件・コピー元とコピー先の対応記録（2件）も同じトランザクションで書く（番号だけ進んで案件が無い、を作らない）。
function openCopyCaseModal() {
  const c = currentCase;
  document.getElementById("copyCaseFrom").innerHTML =
    `コピー元: <strong>#${escHtml(c.caseNumber || "—")} ${escHtml(c.officeName || "")}</strong>（事業種別: ${escHtml(c.serviceType || "未設定")}）`;
  const sel = document.getElementById("copyServiceType");
  sel.innerHTML = serviceTypeOptionsHtml("", escHtml, { emptyLabel: "選んでください" });
  // コピー元と同じ事業種別は選べないようにする
  [...sel.options].forEach((o) => { if (o.value && o.value === c.serviceType) o.disabled = true; });
  sel.value = "";
  // コピー元が未設定なら、コピー元の事業種別も選んでもらう（同じトランザクションでコピー元にも書く）
  const srcGroup = document.getElementById("copySourceTypeGroup");
  const srcSel = document.getElementById("copySourceType");
  const needSource = !c.serviceType;
  srcGroup.style.display = needSource ? "" : "none";
  srcSel.innerHTML = serviceTypeOptionsHtml("", escHtml, { emptyLabel: "選んでください" });
  srcSel.value = "";
  document.getElementById("copyPlanHint").textContent = "";
  document.getElementById("copyCaseError").style.display = "none";
  document.getElementById("copyCaseModal").classList.add("open");
  sel.focus();
}
function closeCopyCaseModal() { document.getElementById("copyCaseModal").classList.remove("open"); }

async function copyCaseWithServiceType() {
  const errEl = document.getElementById("copyCaseError");
  const serviceType = document.getElementById("copyServiceType").value;
  const sourceServiceType = currentCase.serviceType ? "" : document.getElementById("copySourceType").value;
  const pre = buildCopiedCase(currentCase, { serviceType, sourceServiceType, caseNumber: 1, now: null }); // 番号を払い出す前に入力だけ確かめる
  if (!pre.ok) { errEl.textContent = pre.error; errEl.style.display = "block"; return; }
  const btn = document.getElementById("copyCaseConfirmBtn");
  btn.disabled = true;
  try {
    const src = currentCase;
    const counterRef = doc(db, "_counters", "cases");
    const newRef = doc(collection(db, "cases"));
    const srcActRef = doc(collection(db, "activities"));
    const newActRef = doc(collection(db, "activities"));
    const srcRef = doc(db, "cases", caseId);
    const srcTypeActRef = doc(collection(db, "activities"));
    const userId = currentUser?.uid || null;
    const userName = currentUser?.displayName || currentUser?.email || "";
    let srcTypeSet = "";
    const newNumber = await runTransaction(db, async (tx) => {
      // コピー元はトランザクションの中で読み直す（画面を開いたあとに別の人が事業種別を入れていても、その値で判定する）
      const srcSnap = await tx.get(srcRef);
      if (!srcSnap.exists()) throw new Error("コピー元の案件が見つかりません");
      const fresh = { ...src, ...srcSnap.data(), _id: caseId };
      const snap = await tx.get(counterRef);
      const next = (snap.exists() ? snap.data().value : 0) + 1;
      const now = serverTimestamp();
      const built = buildCopiedCase(fresh, { serviceType, sourceServiceType, caseNumber: next, now });
      if (!built.ok) throw new Error(built.error);
      srcTypeSet = built.setSource ? built.sourceServiceType : "";
      const texts = copyActivityTexts(fresh, next, serviceType, srcTypeSet);
      tx.set(counterRef, { value: next });
      tx.set(newRef, built.data);
      if (srcTypeSet) {
        tx.update(srcRef, { serviceType: srcTypeSet, updatedAt: now });
        tx.set(srcTypeActRef, { caseId, type: "memo", occurredAt: now, userId, userName,
          subject: texts.sourceUpdate.subject, body: texts.sourceUpdate.body, attachmentUrls: [] });
      }
      tx.set(srcActRef, { caseId, type: "memo", occurredAt: now, userId, userName,
        subject: texts.source.subject, body: texts.source.body, attachmentUrls: [] });
      tx.set(newActRef, { caseId: newRef.id, type: "memo", occurredAt: now, userId, userName,
        subject: texts.target.subject, body: texts.target.body, attachmentUrls: [] });
      return next;
    });
    closeCopyCaseModal();
    showToast(`案件 #${newNumber}（${serviceType}）を作りました`);
    location.href = `/case-detail.html?id=${newRef.id}`;
  } catch (e) {
    errEl.textContent = `作成できませんでした: ${e.message || e}`;
    errEl.style.display = "block";
    btn.disabled = false;
  }
}

// ===== 連絡先（担当者名・メール・電話）を直す =====
// 案件の更新・活動メモ・（メールを直したときは）未送付の見積もりの宛先を、1つのトランザクションで書く。
// 見積もりは「この案件の、旧メールのまま、まだ送っていない」ものだけ。送付済みは送った宛先の記録なので触らない。
// 練習モードも同じ道（fs.js が練習DBへ向ける。transaction 内の set には作成者の印が付く）。
function openEditContactModal() {
  const c = currentCase;
  document.getElementById("editContactName").value = c.contactName || "";
  document.getElementById("editContactEmail").value = c.contactEmail || "";
  document.getElementById("editContactPhone").value = c.contactPhone || "";
  document.getElementById("editContactError").style.display = "none";
  document.getElementById("editContactConfirmBtn").disabled = false;
  document.getElementById("editContactModal").classList.add("open");
  document.getElementById("editContactName").focus();
}
function closeEditContactModal() { document.getElementById("editContactModal").classList.remove("open"); }

async function saveContact() {
  const errEl = document.getElementById("editContactError");
  const input = {
    contactName: document.getElementById("editContactName").value,
    contactEmail: document.getElementById("editContactEmail").value,
    contactPhone: document.getElementById("editContactPhone").value,
  };
  const pre = buildContactUpdate(currentCase, input);
  if (!pre.ok) { errEl.textContent = pre.error; errEl.style.display = "block"; return; }
  const btn = document.getElementById("editContactConfirmBtn");
  btn.disabled = true;
  try {
    const caseRef = doc(db, "cases", caseId);
    const actRef = doc(collection(db, "activities"));
    const userId = currentUser?.uid || null;
    const userName = currentUser?.displayName || currentUser?.email || "";
    // 見積もりは先に探す（トランザクションの中では検索できないため）。中で1件ずつ読み直して、条件を確かめ直す
    const oldEmail = pre.changes.contactEmail ? pre.changes.contactEmail.before : "";
    let quoteRefs = [];
    if (pre.changes.contactEmail && oldEmail) {
      const qs = await getDocs(query(collection(db, "quotes"), where("caseId", "==", caseId)));
      quoteRefs = qs.docs.filter((d) => quoteNeedsEmailFix(d.data(), oldEmail)).map((d) => d.ref);
    }
    let result = null;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists()) throw new Error("案件が見つかりません");
      // 画面を開いたあとに誰かが直していても、いまの値と見比べて作り直す
      const built = buildContactUpdate(snap.data(), input);
      if (!built.ok) throw new Error(built.error);
      const fixedNos = [];
      const quoteTargets = [];
      for (const ref of quoteRefs) {
        const qs = await tx.get(ref);
        if (qs.exists() && built.changes.contactEmail && quoteNeedsEmailFix(qs.data(), built.changes.contactEmail.before)) {
          quoteTargets.push(ref);
          fixedNos.push(qs.data().estNo);
        }
      }
      const now = serverTimestamp();
      const texts = contactChangeActivity(built.changes, fixedNos);
      tx.update(caseRef, { ...built.data, updatedAt: now });
      for (const ref of quoteTargets) tx.update(ref, { contactEmail: built.data.contactEmail });
      tx.set(actRef, { caseId, type: "memo", occurredAt: now, userId, userName,
        subject: texts.subject, body: texts.body, attachmentUrls: [] });
      result = { data: built.data, quoteCount: quoteTargets.length };
    });
    // 「メール送信」の宛先が旧メールのままなら、直したメールに差し替える
    if ("contactEmail" in result.data) {
      const mailTo = document.getElementById("mailTo");
      if (mailTo && normalizeEmail(mailTo.value) === normalizeEmail(currentCase.contactEmail)) mailTo.value = result.data.contactEmail;
    }
    Object.assign(currentCase, result.data);
    renderCaseMeta(currentCase);
    closeEditContactModal();
    showToast(result.quoteCount ? `連絡先を直しました（見積もり${result.quoteCount}件の宛先も直しました）` : "連絡先を直しました");
  } catch (e) {
    const denied = e?.code === "permission-denied" || /insufficient permissions/i.test(e?.message || "");
    errEl.textContent = denied ? "保存できませんでした: この操作の権限がありません" : `保存できませんでした: ${e.message || e}`;
    errEl.style.display = "block";
    btn.disabled = false;
  }
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
  // コピーは閲覧のみに出さない（文言に「コピー」を含み、role.js の自動無効化の対象外になるため）。
  // 対象外（統合済み・重複など）の案件からは作らない
  const copyBtn = document.getElementById("copyCaseBtn");
  if (copyBtn) copyBtn.style.display = canCopy && !c.archived ? "" : "none";
  // 連絡先の訂正は閲覧のみに出さない（文言が「直す」で role.js の自動無効化に掛からないため、JS で隠す）
  const editContactBtn = document.getElementById("editContactBtn");
  if (editContactBtn) editContactBtn.style.display = canCopy && !c.archived ? "" : "none";
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
      ${canMerge ? `<button class="btn btn-ghost" type="button" data-merge="${c._id}" data-tip="その案件の対応記録・伴走支援の記録・見積もり・出荷をこの案件へ移し、その案件は対象外（重複）にします。押すと確認が出ます。元に戻せません。" style="white-space:nowrap">
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
        ${refLinkHtml(a)}
      </div>
    </div>
  `).join("")}</div>`;
}

// 元の記録（伴走支援の記録・当日）への参照がある行に「〜を開く」を出す（2026-11-10・設計書 提案5）。
// 参照の無い既存の行には何も出さない
function refLinkHtml(a) {
  const link = activityRefLink(a);
  if (!link) return "";
  return `<div style="margin-top:6px"><button type="button" class="btn btn-ghost act-ref-open" data-tip="当日タブへ切り替えて、この行のもとになった記録を開きます。データは変わりません。" data-ref-type="${escHtml(a.refType)}" data-ref-id="${escHtml(a.refId)}" style="font-size:12px;padding:4px 10px"><i class="ti ti-external-link" aria-hidden="true"></i> ${escHtml(link.label)}</button></div>`;
}

// 当日タブへ切り替えて、該当の記録（無ければ当日タブの先頭）へスクロールする
function openActivityRef(refType, refId) {
  const link = activityRefLink({ refType, refId });
  if (!link) return;
  activateTab(link.tab);
  const el = document.getElementById(link.anchorId) || document.getElementById(link.fallbackId);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// own: 自分の書き込みの通知か（snap.metadata.hasPendingWrites）。未保存の間に他の人が口座情報を変えたかの判定に使う
function renderDocumentChecklist(cl, own = false) {
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

  // 入力途中（未保存）の口座情報は、書類チェックの保存などで届いた値で上書きしない。
  // その間に他の人が口座情報を変えたら「他の人が更新しました」と出す（流し込みは止めたまま）
  bankUnsaved?.observe(cl?.bankAccountInfo || null, { own });
  if (bankUnsaved?.isDirty()) { applyBankType(); return; }
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

function renderSubsidy(sa, own = false) {
  subsidyUnsaved?.observe(sa || null, { own }); // 未保存の間に他の人が更新したら知らせる
  if (!sa) return;
  if (subsidyUnsaved?.isDirty()) return; // 入力途中（未保存）の申請情報は上書きしない
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
  updateSubsidyDiffs();
}

// ===== 申請で入れる値（読み取り専用・2026-11-12 次田さん決定 申1〜申4） =====
// 正本: 領収証を発行済みなら receipts/{出荷ID} の保存値、未発行なら出荷の明細（見積もりの金額は使わない）。
// 補助対象外の追加台数は、出荷の subsidyQty → 紐づく見積もりの subsidyQty（台数だけ）で区別する。どちらも無ければ区別しない。
// ここでは何も書き込まない（申請情報の手入力の欄は残し、違うときに黄色で知らせるだけ）。入金・消込には触れない。
async function refreshSubsidyAuto(shipments) {
  const seq = ++subsidyAutoSeq;
  const receiptsById = {}, countsById = {};
  const live = (shipments || []).filter((s) => (s.status || "shipped") !== "canceled");
  await Promise.all(live.map(async (s) => {
    if (s.receiptNo || s.receiptIssuedAt) {
      try {
        const r = await getDoc(doc(db, "receipts", s._id));
        if (r.exists()) receiptsById[s._id] = r.data();
      } catch (e) { console.warn("receipts read:", e.message || e); }
    }
    if (!subsidyCountsFromShipment(s) && s.quoteId) {
      try {
        const q = await getDoc(doc(db, "quotes", s.quoteId));
        const c = q.exists() ? subsidyCountsFromQuote(q.data()) : null;
        if (c) countsById[s._id] = c;
      } catch (e) { console.warn("quotes read:", e.message || e); }
    }
  }));
  if (seq !== subsidyAutoSeq) return; // もっと新しい購読の結果がある
  const EP = window.EstimatePricing;
  const planKey = currentCase?.subsidyCategory || live.map((s) => s.subsidyCategory).find((k) => k) || "";
  const plan = EP && EP.PLANS[planKey] ? EP.PLANS[planKey] : null;
  subsidyAuto = caseSubsidyAmounts(shipments, { receiptsById, countsById, plan });
  renderSubsidyAuto(subsidyAuto);
  updateSubsidyDiffs();
}

function subsidyModelText(skuQty) {
  const NAMES = { "cir415a-01": "CIR415A（Bluetooth／USB Type-C）", "cir315a-02": "CIR315A（USB Type-A）", "cir315a-04": "CIR315A（USB Type-C）" };
  return Object.entries(skuQty || {}).map(([k, v]) => `${NAMES[k] || k}×${v}台`).join("、") || "—";
}
function saYen(v) { return v === null || v === undefined ? "—" : yen(v); }

function renderSubsidyAuto(res) {
  const body = document.getElementById("subsidyAutoBody");
  if (!body) return;
  if (!res || !res.rows.length) {
    body.innerHTML = `<p class="sa-muted">この案件に紐づいた出荷がないため、まだ出せません（出荷を作ると、その明細から出します）。</p>`
      + (res && res.canceledCount ? `<p class="sa-muted">キャンセルした出荷 ${res.canceledCount}件は数えていません。</p>` : "");
    return;
  }
  const t = res.total;
  const multi = res.rows.length > 1;
  const unknownRows = res.rows.filter((r) => r.split === "unknown");
  const unitsText = t.subsidyUnits === null
    ? `${t.units}台（補助対象分を区別できません）`
    : `${t.subsidyUnits}台`;
  const grantText = t.grant !== null ? yen(t.grant)
    : (!res.plan ? "—（助成区分が未設定）" : "—（補助対象分を区別できないため出せません）");
  const tableOf = (x, isTotal) => {
    const aText = x.aSubsidy === null ? `${yen(x.aTotal)}<span class="sa-tag">対象外を含む</span>` : yen(x.aSubsidy);
    const rows = [
      `<tr class="sa-main"><th>A カードリーダー購入費用（税込・補助対象分）</th><td class="num">${aText}</td></tr>`,
      `<tr><th>台数と機種</th><td>${escHtml(subsidyModelText(x.skuQty))}<br><span class="sa-muted">補助対象 ${escHtml(x.subsidyUnits === null ? "区別できません" : x.subsidyUnits + "台")}</span></td></tr>`,
      `<tr class="sa-main"><th>B 接続サポート等経費（税込・伴走支援費と値引きを反映）</th><td class="num">${yen(x.b)}</td></tr>`,
      `<tr class="sa-main"><th>A＋B（助成金の申請対象額）</th><td class="num"><strong>${saYen(x.ab)}</strong></td></tr>`,
    ];
    if (isTotal) rows.push(`<tr><th>交付見込み（A＋B と助成区分の上限${res.plan ? " " + yen(res.plan.limit) : ""} の小さい方）</th><td class="num">${grantText}</td></tr>`);
    if (x.aExtra) rows.push(`<tr class="sa-extra"><th>対象外 カードリーダーの追加${x.extraUnits ? ` ${x.extraUnits}台` : ""}（申請に入れない）</th><td class="num">${yen(x.aExtra)}</td></tr>`);
    if (x.x) rows.push(`<tr class="sa-extra"><th>対象外 送料など（申請に入れない）</th><td class="num">${yen(x.x)}</td></tr>`);
    if (!isTotal && x.receiptAmountIncl !== null) rows.push(`<tr class="sa-extra"><th>領収金額（領収証に保存された額）</th><td class="num">${yen(x.receiptAmountIncl)}</td></tr>`);
    if (!isTotal && x.plannedIncl !== null && x.plannedIncl !== undefined) rows.push(`<tr class="sa-extra"><th>領収金額の予定（請求額・税込）</th><td class="num">${yen(x.plannedIncl)}</td></tr>`);
    return `<table class="sa-table">${rows.join("")}</table>`;
  };
  const srcLine = (r) => `<p class="sa-src"><i class="ti ti-file-check" aria-hidden="true"></i> ${escHtml(sourceText(r))}${r.status ? `（${escHtml(SHIP_STATUS_JA[r.status] || r.status)}）` : ""}${r.countsFrom ? `　／　補助対象の台数: ${escHtml(r.countsFrom)}` : ""}</p>`;
  let html = "";
  if (!multi) {
    html += srcLine(res.rows[0]) + tableOf(t, true);
    const r0 = res.rows[0];
    if (r0.receiptAmountIncl !== null) html += `<p class="sa-muted" style="margin-top:6px">領収金額（領収証に保存された額）: ${yen(r0.receiptAmountIncl)}</p>`;
    else html += `<p class="sa-muted" style="margin-top:6px">領収金額の予定（請求額・税込）: ${yen(r0.plannedIncl)}（請求書と同じ額。入金を確かめて領収証を発行すると、領収証の値に切り替わります）</p>`;
  } else {
    html += `<p class="sa-src">出荷 ${res.rows.length}件の合計です（キャンセルを除く）。出荷ごとの内訳は下にあります。</p>` + tableOf(t, true);
    if (t.receiptAmountIncl !== null) html += `<p class="sa-muted" style="margin-top:6px">領収金額の合計（領収証に保存された額・${t.receiptCount}件）: ${yen(t.receiptAmountIncl)}</p>`;
    if (t.plannedIncl !== null) html += `<p class="sa-muted" style="margin-top:6px">領収金額の予定の合計（領収証が未発行の出荷の請求額・税込・${t.plannedCount}件）: ${yen(t.plannedIncl)}</p>`;
    html += `<div class="sa-breakdown">` + res.rows.map((r) => `<h4>${escHtml(r.soNumber || "（番号なし）")}</h4>${srcLine(r)}${tableOf(r, false)}`).join("") + `</div>`;
  }
  const notes = [];
  for (const r of unknownRows) notes.push(`${escHtml(r.soNumber || "出荷")}: ${escHtml(r.reason)}。A は対象外の分を含んだ額を出しています。申請の前に台数を確かめてください。`);
  if (res.dropship) notes.push("認定事業者への卸（税抜の単価）の出荷が含まれています。事業所が申請する金額は、認定事業者が事業所に出す領収証の額です。");
  if (res.canceledCount) notes.push(`キャンセルした出荷 ${res.canceledCount}件は数えていません。`);
  if (notes.length) html += notes.map((x) => `<p class="sa-note"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${x}</p>`).join("");
  body.innerHTML = html;
}

// 手入力の欄（A・B・交付額）と自動の値が違うとき、その欄を黄色にして自動の値を出す。値は書き込まない
function updateSubsidyDiffs() {
  const ids = ["cardReaderCost", "supportCost", "grantAmount"];
  const inputs = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value ?? ""]));
  const m = inputMismatches(inputs, subsidyAuto);
  for (const id of ids) {
    const el = document.getElementById(id), note = document.getElementById(id + "Diff");
    if (!el || !note) continue;
    const d = m[id];
    el.classList.toggle("sa-diff-input", !!d);
    note.hidden = !d;
    note.textContent = d ? d.text : "";
  }
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

// ===== 出荷・請求・入金タブ（読み取り専用） =====
// 金額を動かす操作は複製しない。ここは「見せる」「/supply.html・/supply-print.html へ飛ばす」だけ。
// 状態の日本語・バッジ色・ステッパーの判定は admin/js/ship-flow.js が正本（供給管理と同じものを import する・2026-10-21）。
// 計算ロジックは複製せず invoiceTotals を必ず通す。
const SHIP_STATUS_JA = SHIP_STATUS_LABEL;
const SHIP_STATUS_BADGE_NO = SHIP_STATUS_BADGE;
function yen(n) { return "¥" + Number(n || 0).toLocaleString("ja-JP"); }
function shipCreatedAtMs(s) { return s.createdAt?.toMillis ? s.createdAt.toMillis() : 0; }

// 5段ステッパー（依頼 → 発送 → 請求書 → 入金 → 領収証）。各段の完了判定は ship-flow.js の shipStepsDone
function shipStepperHtml(s) {
  const done = shipStepsDone(s);
  const steps = [
    { key: "requested", label: "依頼" },
    { key: "shipped", label: "発送" },
    { key: "invoiced", label: "請求書" },
    { key: "paid", label: "入金" },
    { key: "receipt", label: "領収証" },
  ];
  return `<div class="ship-steps">` + steps.map((st, i) => {
    const sep = i > 0 ? `<div class="ship-step-sep${done[st.key] && done[steps[i - 1].key] ? " done" : ""}"></div>` : "";
    return sep + `<div class="ship-step${done[st.key] ? " done" : ""}"><i class="ti ti-${done[st.key] ? "circle-check-filled" : "circle"}" aria-hidden="true"></i> ${st.label}</div>`;
  }).join("") + `</div>`;
}

// 出荷1件の「次にやること」判定（状態ごとに1つだけ）。このタブのカード（shipCardHtml）と、
// 案件詳細ヘッダー「次の一手」2行目（お金の流れ）が共通で使う（2026-09-14・コピーせず共通化）。
// supply.html?tab=shipments&so=… は別担当が実装中の契約（案件詳細からは触らず、遷移先の URL 形式だけ合わせる）
function shipNextAction(s) {
  const st = shipStatusOf(s);
  const soUrl = `/supply.html?tab=shipments&so=${encodeURIComponent(s.soNumber || "")}`;
  const receiptUrl = `/supply-print.html?type=receipt&id=${s._id}`;
  // 出荷の二段階化（2026-10-21）: 下書きは「出荷を依頼する」。依頼済は倉庫の担当が発送して「発送済」にするので、
  // 依頼した人は押す操作がない（waiting: 状態の案内だけ・2026-11-08）。
  // 在庫・出荷指示が動く操作なので、ここでは押させず供給管理の該当行へ飛ばす
  if (st === "draft") return { label: "出荷を依頼する", icon: "send", url: soUrl, external: false };
  if (st === "requested") {
    // 倉庫から差し戻されているときは「待ち」ではなく、直して再送する案内（押す操作は供給管理の行で行う）
    if (s.warehouseIssue) return { label: "倉庫から差し戻し：直して再送してください", icon: "alert-triangle", url: soUrl, external: false, waiting: true, issue: true };
    return { label: isPickup(s) ? "倉庫の受け渡し待ち" : "倉庫の発送待ち", icon: "truck-delivery", url: soUrl, external: false, waiting: true };
  }
  // 「請求書を出す」の飛び先は screen-rules.js の invoicePromptUrl が正本（出荷の画面の「請求済にする」へ・2026-11-10 そろえた）
  if (st === "shipped") return { label: "請求書を出す", icon: "file-invoice", url: invoicePromptUrl({ notInvoiced: [s] }), external: false };
  if (st === "invoiced") return { label: "入金を記録する", icon: "cash", url: soUrl, external: false };
  if (st === "paid") {
    if (!s.receiptIssuedAt) return { label: "領収証を出す", icon: "receipt-2", url: receiptUrl, external: true };
    return { done: true }; // お金の流れは完了
  }
  return null; // canceled: 主ボタンなし
}

function shipNextActionHtml(s) {
  const a = shipNextAction(s);
  if (!a) return ""; // canceled
  if (a.done) {
    return `<span class="ship-next-msg"><i class="ti ti-circle-check" aria-hidden="true"></i> お金の流れは完了しています。申請情報タブへ進んでください。</span>`;
  }
  if (a.waiting) {
    if (a.issue) {
      return `<span class="ship-next-msg" style="color:var(--color-danger);font-weight:600"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${a.label}。 <a href="${a.url}">出荷の行を開く</a></span>`;
    }
    return `<span class="ship-next-msg"><i class="ti ti-truck-delivery" aria-hidden="true"></i> ${a.label}です（${isPickup(s) ? "受け渡し" : "発送済"}は倉庫の担当が押します）。 <a href="${a.url}">出荷の行を開く</a></span>`;
  }
  const targetAttrs = a.external ? ` target="_blank" rel="noopener"` : "";
  const tip = SHIP_NEXT_TIPS[a.label] || "";
  const tipAttr = tip ? ` data-tip="${escHtml(tip)}"` : "";
  return `<a class="btn btn-primary" href="${a.url}"${targetAttrs}${tipAttr}><i class="ti ti-${a.icon}" aria-hidden="true"></i> ${a.label}</a>`;
}
// 上のボタンの説明の吹き出し（admin/js/tooltip.js・2026-11-12）。どれもリンクで、ここでは何も書き込まない
const SHIP_NEXT_TIPS = {
  "出荷を依頼する": "出荷・請求・入金の画面で、この出荷の行を開きます。出荷の依頼はその画面で行います（ここを押しただけでは何も変わりません）。",
  "請求書を出す": "出荷・請求・入金の画面で、この出荷の行を開きます。請求書の発行と「請求済にする」はその画面で行います。",
  "入金を記録する": "出荷・請求・入金の画面で、この出荷の行を開きます。入金の記録はその画面で行います。",
  "領収証を出す": "領収証の画面を新しいタブで開きます。発行・印刷はその画面で行います。",
};
// 送付済み・記録待ち（メールで送ったが「請求済にする」「発行を記録」がまだ・2026-11-10）。判定は ship-flow.js の mailedPendingNotes
function shipMailedPendingHtml(s) {
  return mailedPendingNotes(s).map((n) =>
    `<div class="ship-next-msg" style="color:var(--color-warn,#c87a1f);margin-top:4px"><i class="ti ti-mail-check" aria-hidden="true"></i> ${escHtml(n.label)}：${escHtml(n.hint)}</div>`).join("");
}

// 未完了（canceled 以外・領収証未発行）の出荷一覧
function shipPendingList(ships) {
  return ships.filter((s) => {
    const a = shipNextAction(s);
    return !!a && !a.done;
  });
}

function shipCardHtml(s) {
  const st = shipStatusOf(s);
  const canceled = st === "canceled";
  const totals = invoiceTotals(s);
  const soUrl = `/supply.html?tab=shipments&so=${encodeURIComponent(s.soNumber || "")}`;
  const invUrl = `/supply-print.html?type=invoice&id=${s._id}`;
  const receiptUrl = `/supply-print.html?type=receipt&id=${s._id}`;
  const links = [`<a class="btn btn-secondary" href="${soUrl}" data-tip="出荷・請求・入金の画面で、この出荷の行を開きます。" style="font-size:12px;padding:6px 12px"><i class="ti ti-list" aria-hidden="true"></i> 一覧で開く</a>`];
  if (st === "invoiced" || st === "paid") {
    links.push(`<a class="btn btn-secondary" href="${invUrl}" data-tip="請求書を新しいタブで開きます。" target="_blank" rel="noopener" style="font-size:12px;padding:6px 12px"><i class="ti ti-file-invoice" aria-hidden="true"></i> 請求書PDF</a>`);
  }
  if (st === "paid") {
    links.push(`<a class="btn btn-secondary" href="${receiptUrl}" data-tip="領収証の画面を新しいタブで開きます。" target="_blank" rel="noopener" style="font-size:12px;padding:6px 12px"><i class="ti ti-receipt-2" aria-hidden="true"></i> 領収証PDF</a>`);
  }
  return `
    <div class="ship-card${canceled ? " is-canceled" : ""}">
      <div class="ship-card-head">
        <span class="ship-no">${escHtml(s.soNumber || "—")}</span>
        <span class="badge badge-${SHIP_STATUS_BADGE_NO[st] || 7}">${SHIP_STATUS_JA[st] || st}</span>
        <span class="ship-origin"><i class="ti ti-map-pin" aria-hidden="true"></i> ${escHtml(s.originLocationName || "—")}</span>
        <span class="ship-amount">${yen(totals.payable)}（税込）</span>
      </div>
      ${canceled
        ? `<p style="font-size:13px;color:var(--color-ink-muted);margin:0">この出荷はキャンセルされています。</p>`
        : shipStepperHtml(s)
          + `<div class="ship-next">${shipNextActionHtml(s)}${shipMailedPendingHtml(s)}</div>`
      }
      <div class="ship-links">${links.join("")}</div>
    </div>`;
}

function renderShippingTab(ships) {
  const loadingEl = document.getElementById("shippingLoading");
  const errorEl = document.getElementById("shippingError");
  const emptyEl = document.getElementById("shippingEmpty");
  const listEl = document.getElementById("shippingList");
  if (loadingEl) loadingEl.style.display = "none";
  if (errorEl) errorEl.style.display = "none";
  if (!ships.length) {
    if (emptyEl) emptyEl.style.display = "block";
    if (listEl) listEl.innerHTML = "";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  const sorted = [...ships].sort((a, b) => shipCreatedAtMs(b) - shipCreatedAtMs(a));
  if (listEl) listEl.innerHTML = sorted.map(shipCardHtml).join("");
}

function renderShippingError() {
  const loadingEl = document.getElementById("shippingLoading");
  const errorEl = document.getElementById("shippingError");
  const emptyEl = document.getElementById("shippingEmpty");
  const listEl = document.getElementById("shippingList");
  if (loadingEl) loadingEl.style.display = "none";
  if (emptyEl) emptyEl.style.display = "none";
  if (listEl) listEl.innerHTML = "";
  if (errorEl) errorEl.style.display = "block";
}

// ===== 出荷の重複の帯（出荷タブの一覧の上。設計 §6 W） =====
// 同じ案件に、まだ発送していない出荷（下書き・依頼済）が2件以上あれば警告する。
// 解消（1件を残し、ほかを「重複登録」でキャンセル）は供給管理で行う。ここは知らせるだけ。
function renderShipDupBanner(ships) {
  const listEl = document.getElementById("shippingList");
  if (!listEl) return;
  let el = document.getElementById("shipDupBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "shipDupBanner";
    el.setAttribute("role", "status");
    listEl.parentNode.insertBefore(el, listEl);
  }
  const b = caseDuplicateBanner(ships, caseId, currentCase?.shipmentId || null);
  if (!b) { el.style.display = "none"; el.innerHTML = ""; return; }
  const soLink = (so) => `/supply.html?tab=shipments&so=${encodeURIComponent(so)}`;
  const target = b.keepSo || b.soNumbers[0];
  el.style.cssText = "display:block;background:#FFF3E0;border:1px solid #E0B070;border-radius:8px;"
    + "padding:10px 14px;margin-bottom:var(--space-3);font-size:13px;line-height:1.8;color:#5a3d12";
  el.innerHTML = `<i class="ti ti-alert-triangle" aria-hidden="true"></i>
    <strong>まだ発送していない出荷が ${b.count} 件あります</strong>（${b.soNumbers.map(escHtml).join("・")}）。
    二重に送らないよう、1件だけ残して、ほかは理由「重複登録」でキャンセルしてください。
    ${b.keepSo ? `<br>残す候補: ${escHtml(b.keepSo)}（案件に結び付いている出荷）` : ""}
    <div style="margin-top:6px"><a class="btn btn-secondary" href="${soLink(target)}" data-tip="出荷・請求・入金の画面で出荷を開きます。重複している出荷のキャンセルは、その画面で行います。" style="font-size:12px;padding:6px 12px">
      <i class="ti ti-list-check" aria-hidden="true"></i> 供給管理で選ぶ</a></div>`;
}

// ===== 次の一手（案件ヘッダー最下部・タブの上。2026-09-14） =====
// ステータス→次にやることは NEXT_ACTION（constants.js）が正本。マニュアル §0 表1 と同じ内容を指す。
function renderNextStep() {
  const wrap = document.getElementById("nextStep");
  if (!wrap || !currentCase) return;
  // スイッチがオンのときは状態2・5 の文言を差し替える（nextActionFor・constants.js）。オフなら NEXT_ACTION のまま
  const na = nextActionFor(currentCase.status, currentCase, { orderByConsent: orderOn() });
  if (!na) { wrap.style.display = "none"; wrap.innerHTML = ""; return; } // 13完了・4失注は非表示

  // 2行目（お金の流れ）: B1「出荷・請求・入金」タブと同じデータ・同じ判定（shipNextAction）を再利用。
  // 未完了の出荷が複数あるときは、直近に作られた出荷を代表として出す（一覧内の並び順=作成日時降順と揃える）。
  const pending = shipPendingList(shipmentsCache)
    .sort((a, b) => shipCreatedAtMs(b) - shipCreatedAtMs(a));
  const moneyHtml = pending.length
    ? (() => {
        const s = pending[0];
        const a = shipNextAction(s);
        return `<div class="next-step-money">
          <i class="ti ti-coin-yen" aria-hidden="true"></i>
          お金の流れ：${a.waiting ? `${escHtml(a.label)}（${escHtml(s.soNumber || "—")}）` : `次は「${escHtml(a.label)}」（${escHtml(s.soNumber || "—")}）`}
          <a href="#" id="nextStepMoneyLink">出荷・請求・入金タブへ</a>
        </div>`;
      })()
    : "";

  wrap.style.display = "flex";
  wrap.innerHTML = `
    <div class="next-step-row">
      <i class="ti ti-arrow-big-right-line" aria-hidden="true"></i>
      <span class="next-step-label">次の一手</span>
      <span class="next-step-text">${escHtml(na.text)}</span>
      <button type="button" class="btn btn-primary" id="nextStepBtn" data-tip="次にやることの場所（タブ・入力欄）へ移ります。押しただけではデータは変わりません。">${escHtml(na.button)}</button>
    </div>${moneyHtml}${(() => {
      const n = orderConsentNoticeOf(currentCase);
      return n ? `<div class="next-step-money" role="status" style="color:#8a5a1f"><i class="ti ti-alert-triangle" aria-hidden="true"></i> ${escHtml(n.text)}（対応記録タブの見積もりから）</div>` : "";
    })()}`;

  document.getElementById("nextStepBtn")?.addEventListener("click", () => {
    if (na.tab) activateTab(na.tab);
    if (na.focus) {
      const el = document.getElementById(na.focus);
      if (el) { el.focus(); el.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
  });
  document.getElementById("nextStepMoneyLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    activateTab("shipping");
  });
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
  bankUnsaved?.clean();
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
  subsidyUnsaved?.clean();
  showToast("申請情報を保存しました");
}

// ステータス変更
// lost: 失注にするときの { reason, note }（それ以外は null）。失注から戻すときは理由を消す。
// warnNote: 完了(13)の警告を確認して続行したときの1行（completionActivityNote の戻り。無ければ ""）
async function changeStatus(newStatus, userId, userName, lost = null, warnNote = "", manualNote = "") {
  const patch = { status: Number(newStatus), updatedAt: serverTimestamp() };
  // 13 以外 → 13 にしたときだけ完了日時を残す（13 のまま保存し直しても上書きしない）
  if (isCompleting(currentCase?.status, newStatus)) patch.completedAt = serverTimestamp();
  // 手で受注確定(3)にしたとき、受注日が無ければこの操作の日時を受注日にする（すでにあれば上書きしない・2026-11-10 点検10）
  const fillOrderedAt = orderedAtFillNeeded(currentCase?.status, newStatus, currentCase);
  if (fillOrderedAt) patch.orderedAt = serverTimestamp();
  if (lost) {
    patch.lostReason = lost.reason; patch.lostReasonNote = lost.note || null;
  } else if (Number(currentCase?.status) === LOST) {
    patch.lostReason = null; patch.lostReasonNote = null;
  }
  await updateDoc(doc(db, "cases", caseId), patch);
  // 画面内の案件にも受注日を入れておく（同じ画面で 3→他→3 と変えたときに、補った受注日を上書きしないため）
  if (fillOrderedAt && currentCase) currentCase.orderedAt = new Date();
  if (lost) { currentCase.lostReason = lost.reason; currentCase.lostReasonNote = lost.note || null; }
  else if (patch.lostReason === null) { currentCase.lostReason = null; currentCase.lostReasonNote = null; }
  // 活動の記録だけが失敗しても、ステータスはもう変わっている。画面を元に戻さず知らせるだけにする（2026-11-08 レビュー指摘）
  try {
    await addDoc(collection(db, "activities"), {
      caseId,
      type: "memo",
      occurredAt: serverTimestamp(),
      userId,
      userName,
      subject: `ステータス変更 → ${STATUS_LABELS[newStatus]}`,
      body: lost ? `失注の理由: ${LOST_REASONS[lost.reason]}${lost.note ? `（${lost.note}）` : ""}`
        : [manualNote, warnNote, fillOrderedAt ? ORDERED_AT_FILLED_NOTE : ""].filter(Boolean).join("\n"),
      attachmentUrls: [],
    });
  } catch (err) {
    console.warn("ステータス変更の記録に失敗", err);
    showToast(`ステータスは変更しましたが、対応記録への記録に失敗しました: ${err.message || err}`);
  }
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
  discardUnsaved(); // 自分で操作した読み直しでは「未保存」の確認を出さない
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
  discardUnsaved();
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
    discardUnsaved(); // 案件はもう無いので、未保存の確認を出さずに一覧へ
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
      // 同一法人のまとめ見積もり（quoteGroupId が同じ）は、意図して分けた別事業所なので重複候補にしない（2026-09-14）
      // ⚠️ 以前は未定義の変数 kase を見ていて ReferenceError になり、候補が常に0件（統合ボタンが出ない）だった（2026-10-21 E2E で発見）
      && !(currentCase?.quoteGroupId && c.quoteGroupId && c.quoteGroupId === currentCase.quoteGroupId)
      && dupKeys(c).some((k) => myKeys.has(k))
      // 同じ事業所の別事業（事業種別が両方入っていて違う）は、1事業＝1案件で意図して分けたので重複候補にしない（2026-11-01）
      // コピーでつながった組（copiedFrom.caseId が相手）も同じ（レビュー P1）
      && !isDupExcludedPair(currentCase, c)
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
  // 事業種別（2026-11-01）。重複の統合で両方に違う値が入っていれば、どちらを残すか選ばせる
  {
    key: "serviceType", label: "事業種別",
    id: (c) => String(c.serviceType || "").trim(),
    text: (c) => String(c.serviceType || "").trim(),
    pick: (c) => ({ serviceType: c.serviceType || null }),
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
          <button class="btn btn-secondary" data-merge-cancel type="button" data-tip="やめて閉じます。統合はしません。" aria-label="閉じる">
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
          <button class="btn btn-secondary" data-merge-cancel type="button" data-tip="やめて閉じます。統合はしません。">キャンセル</button>
          <button class="btn btn-primary" data-merge-ok type="button" data-tip="選んだ内容でこの案件に統合します。統合元は対象外（重複）になり、元に戻せません。">
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
    // 統合元の記録・セッション・見積もり・出荷を当案件へ付け替え（見積もり・出荷は計画書 §4.4）
    let otherShipments = [];
    for (const col of ["activities", "sessions", "quotes", "shipments"]) {
      const snap = await getDocs(query(collection(db, col), where("caseId", "==", other._id)));
      if (col === "shipments") otherShipments = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
      snap.forEach((d) => batch.update(d.ref, { caseId, caseNumber: keep.caseNumber ?? null }));
    }
    // 付け替えの結果、まだ発送していない出荷（下書き・依頼済）が2件以上になるなら先に知らせる（設計 §5 再発防止）。
    // やめたら何も書かない（batch は commit 前なので捨てるだけ）
    const preShip = preShipCountAfterMerge(shipmentsCache, otherShipments);
    if (preShip >= 2 && !confirm(
      `統合すると、この案件に「まだ発送していない出荷（下書き・依頼済）」が ${preShip} 件になります。\n`
      + "統合のあと、供給管理で1件だけ残し、ほかは理由「重複登録」でキャンセルしてください。\n\n"
      + "このまま統合しますか？")) {
      return;
    }
    // 見積もり・Web申込の目印（案件一覧の絞り込みと見積もりカードが見る値）は、残る側に無いときだけ引き継ぐ
    for (const k of ["latestQuoteId", "quoteIssuedAt", "orderedAt", "orderedVia"]) {
      if (keep[k] == null && other[k] != null) fill[k] = other[k];
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
// 保存ボタンの欄の「未保存の変更があります」とページを離れるときの確認（save-mode.js）。init で作る
let sessionUnsaved = null, sessionEditUnsaved = null, bankUnsaved = null, subsidyUnsaved = null;
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
    <div class="card" id="${escHtml(sessionAnchorId(s._id))}" style="margin-bottom:var(--space-3)">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
          <strong style="font-size:14px"><i class="ti ti-calendar-event" aria-hidden="true"></i> ${escHtml(s.sessionDate || "日付未設定")}</strong>
          <span style="font-size:12px;color:var(--color-ink-muted);margin-left:auto">${escHtml(s.userName || "")} ・ ${formatDateTime(s.createdAt)}</span>
          <button class="btn btn-secondary sess-edit" data-tip="この伴走支援の記録を直す欄を開きます。「変更を保存」を押すまで保存されません。" data-id="${s._id}" type="button" style="font-size:12px;padding:4px 10px"><i class="ti ti-edit" aria-hidden="true"></i>編集</button>
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
      <button class="sess-photo-del" data-tip="この写真を外します。「変更を保存」を押したときに写真が削除されます。" data-url="${u.replace(/"/g, "&quot;")}" type="button" aria-label="この写真を外す"
        style="position:absolute;top:2px;right:2px;width:24px;height:24px;border-radius:50%;border:none;background:rgba(184,74,74,.92);color:#fff;font-size:14px;line-height:1;cursor:pointer">×</button>
    </div>`).join("");
  return `
    <div class="card" id="${escHtml(sessionAnchorId(s._id))}" style="margin-bottom:var(--space-3);border-color:var(--color-primary)">
      <div class="card-body">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px"><i class="ti ti-edit" aria-hidden="true"></i> この記録を編集しています（「変更を保存」を押すと保存されます）${unsavedSpanHtml("sessEditUnsaved")}</div>
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
          <button class="btn btn-primary sess-save" data-tip="直した実施日・メモ・写真を保存し、対応記録に1行残します。外した写真はこのとき削除されます。" data-id="${s._id}" type="button"><i class="ti ti-check" aria-hidden="true"></i>変更を保存</button>
          <button class="btn btn-secondary sess-cancel" data-tip="直した内容を捨てて、編集をやめます。" type="button">キャンセル</button>
          <button class="btn btn-danger sess-delete" data-tip="この伴走支援の記録と写真を削除し、削除したことを対応記録に残します。押すと確認が出ます。元に戻せません。" data-id="${s._id}" type="button" style="margin-left:auto"><i class="ti ti-trash" aria-hidden="true"></i>この記録を削除</button>
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
    sessionEditUnsaved?.clean();
    renderSessions(sessionsCache);
  }));
  document.querySelectorAll(".sess-cancel").forEach((b) => b.addEventListener("click", () => {
    editingSessionId = null;
    removedPhotoUrls = new Set();
    sessionEditUnsaved?.clean();
    renderSessions(sessionsCache);
  }));
  document.querySelectorAll(".sess-photo-del").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.url) removedPhotoUrls.add(b.dataset.url);
    b.closest("div").style.display = "none";
    sessionEditUnsaved?.mark();
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
      refType: "session", refId: sessionId, // 対応記録から編集後の記録を開く（提案5）
    });
    await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });

    editingSessionId = null;
    removedPhotoUrls = new Set();
    sessionEditUnsaved?.clean();
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
    sessionEditUnsaved?.clean();
    showToast("伴走支援の記録を削除しました");
    renderSessions(latestSessions); // 編集中は購読側の描画を止めているので、ここで戻す
  } catch (e) {
    alert(`削除に失敗しました: ${e.message}`);
  }
}

// 伴走支援の記録（新規入力欄）の実施日が空なら、当日タブの訪問日を初期値に入れる（2026-11-10・設計書 提案1）。
// 入っている値・触って未保存の欄は変えない。値を入れるだけでは「未保存」にしない（input/change を起こさない）
// 訪問日を直したら、自動で入れた値のまま（sessionAutoDate と同じ）の欄は新しい訪問日へ置き換える（実施の記録と同じ方式）
let onsiteVisitDate = "";
let sessionAutoDate = "";
function applySessionDateDefault() {
  const el = document.getElementById("sessionDate");
  if (!el || el === document.activeElement) return;
  const v = dateDefault(el.value, onsiteVisitDate, { dirty: !!sessionUnsaved?.isDirty(), lastAuto: sessionAutoDate });
  if (v) { el.value = v; sessionAutoDate = v; }
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
      refType: "session", refId: sessRef.id, // 対応記録から当日タブのこの記録を開く（提案5）
    });
    await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });

    dateEl.value = ""; summaryEl.value = ""; filesEl.value = "";
    const pc = document.getElementById("photoCount"); if (pc) pc.textContent = "";
    sessionUnsaved?.clean();
    showToast("伴走支援セッションを記録しました");
    applySessionDateDefault(); // 次の記録の実施日も当日の訪問日から（clean の後＝未保存のままだと入らない・レビュー 中-1）
  } catch (e) {
    alert(`記録に失敗しました: ${e.message}`);
    return;
  } finally {
    btn.disabled = false;
    progress.style.display = "none";
  }
  askSupportDone();
}

// 伴走支援の記録を保存したあと、案件の状態が伴走支援実施済より前なら「伴走支援実施済にしますか」と聞く（2026-11-10・設計書 §3 点検5）。
// 自動では変えない。OK のときだけ、ヘッダーの状態の選択を 8 にして change を起こし、既存の状態変更の処理
// （請求書の確認・対応記録・次の一手）をそのまま通す。判定は record-gaps-case.js の shouldAskSupportDone
function askSupportDone() {
  const sel = document.getElementById("statusSelect");
  if (!sel || sel.disabled || !currentCase) return;
  if (!shouldAskSupportDone({ status: currentCase.status, archived: !!currentCase.archived, canChangeStatus: canCopy })) return;
  // 受注前の案件は、承諾書のサイン＝発注のスイッチがオンなら手で進めないので聞かない（発5）
  if (statusChangeGuard({ from: currentCase.status, to: SUPPORT_DONE_STATUS, orderByConsent: orderOn(), isAdmin, caseData: currentCase }).kind !== "ok") return;
  if (!confirm(supportDoneAskText(currentCase.status))) return;
  sel.value = String(SUPPORT_DONE_STATUS);
  sel.dispatchEvent(new Event("change"));
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
  const to = normalizeEmail(document.getElementById("mailTo").value);
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

// タブ切替（「次の一手」ボタンからの遷移と、タブクリックの両方がここを通る＝2026-09-14）
function activateTab(name) {
  const tabName = resolveTab(name); // 旧「伴走支援」タブ（sessions）は当日タブの末尾へ移した（2026-11-10）
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === tabName;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
  document.getElementById(`tab-${tabName}`)?.classList.add("active");
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
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
  canCopy = !isViewer(myRole);
  currentUser = user;

  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => { discardUnsaved(); location.href = "/index.html"; }));
  // ↑ ログアウトしたあとに確認で「このページに留まる」を選ぶと、ログアウト済みの画面が残るため、確認を出さない

  initTabs();

  // 伴走チェックリスト（事前/当日/アフター・ケアプラン連携統合）をタブに描画・購読
  // 実施の記録（誰が実施したか）用に、案件の担当営業と users を渡す（どちらも後で読み込まれる）
  supportChecklist = initSupportChecklist(db, caseId, storage, {
    getCase: () => currentCase,
    getUsers: () => usersList,
    getActor: () => currentUser?.displayName || currentUser?.email || "",
    getActorId: () => currentUser?.email || "",
    getActorUid: () => currentUser?.uid || "",
    // 「同じ事業所の他の案件にも写す」（提案2）は閲覧のみ以外（コピーで案件を作るのと同じ範囲）
    canEdit: () => canCopy,
    onVisitDate: (d) => { onsiteVisitDate = d || ""; applySessionDateDefault(); },
  });

  // 案件データ読み込み
  const caseSnap = await getDoc(doc(db, "cases", caseId));
  if (!caseSnap.exists()) {
    alert("案件が見つかりません");
    discardUnsaved();
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
  // 練習モードでは、自分と架空の担当者（初期データの「練習 太郎」「練習 花子」）を候補にする
  // （練習DBに users は置かない。本番の職員名簿を練習に出さない）
  if (isPracticeMode()) {
    usersList = [
      { _id: currentUser.email, name: currentUser.displayName || currentUser.email, active: true },
      { _id: "practice-taro@example.jp", name: "練習 太郎", active: true },
      { _id: "practice-hanako@example.jp", name: "練習 花子", active: true },
    ];
  } else try {
    const us = await getDocs(collection(db, "users"));
    usersList = us.docs.map((d) => ({ _id: d.id, ...d.data() }));
  } catch (_) { usersList = []; }

  if (supportChecklist) supportChecklist.refreshPeople(); // 実施者・トレーナーの選択肢
  document.getElementById("loadingEl").style.display = "none";
  document.getElementById("mainContent").style.display = "block";
  renderCaseHeader(currentCase);
  loadOfficeAddress(currentCase); // 事業所の住所は別に読んで、見出しに足す（待たない）
  renderNextStep(); // 次の一手（まだ shipmentsCache が空でも1行目は出せる。2行目は購読が来てから更新）
  // 伴走支援承諾書カード（事前確認タブの先頭）。メールは既存の sendCaseEmail を流用
  initConsentCard({
    db, caseId,
    getCase: () => ({ ...currentCase, email: currentCase.contactEmail || currentCase.email || "" }),
    sendMail: (payload) => sendCaseEmailFn(payload),
    toast: showToast,
    userName: currentUser?.displayName || currentUser?.email || "",
    orderByConsent: orderOn, // 承諾書のサイン＝発注のスイッチ（2026-11-12）
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
    orderByConsent: orderOn, // 承諾書のサイン＝発注のスイッチ（2026-11-12）
  }).catch((e) => console.warn("quote card init:", e.message));
  renderAssigneeSelect();
  renderReferralSelect();
  renderServiceTypeSelect();
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

  // 訪問予定日の変更（保存＋タイムラインに記録）
  document.getElementById("visitDateInput")?.addEventListener("change", async (e) => {
    const inp = e.target;
    const prev = currentCase.visitDate || "";
    inp.disabled = true;
    try {
      await saveVisitDate(inp.value);
    } catch (err) {
      inp.value = prev;
      alert(`訪問予定日の保存に失敗しました: ${err.message || err}`);
    } finally {
      inp.disabled = false;
    }
  });

  // 訪問の時刻・形式の変更（保存＋タイムラインに記録）
  // ・保存は直列化する（並行しても、毎回「そのとき欄にある最新の値」で書くので後の値が先の値で上書きされない）
  // ・欄は無効化も描き直しもしない（保存中に次の欄を入力できる）。失敗したときだけ、失敗した欄を保存済みの値へ戻す
  const VISIT_FIELD = { visitTimeFromInput: "visitTimeFrom", visitTimeToInput: "visitTimeTo", visitFormatSelect: "visitFormat" };
  let visitSaveChain = Promise.resolve();
  Object.keys(VISIT_FIELD).forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      const el = e.target;
      visitSaveChain = visitSaveChain.then(() => saveVisitExtras()).catch((err) => {
        alert(`訪問の時刻・形式の保存に失敗しました: ${err.message || err}`);
        el.value = currentCase[VISIT_FIELD[id]] || "";
      });
    });
  });

  // 事業種別の変更（保存＋タイムラインに記録）
  document.getElementById("serviceTypeSelect")?.addEventListener("change", async (e) => {
    const sel = e.target;
    const prev = currentCase.serviceType || "";
    sel.disabled = true;
    try {
      await saveServiceType(sel.value);
      renderServiceTypeSelect(); // 一覧にない値から外れた場合に選択肢を作り直す
    } catch (err) {
      sel.value = prev;
      alert(`事業種別の保存に失敗しました: ${err.message || err}`);
    } finally {
      sel.disabled = false;
    }
  });

  // この案件をコピーして、別の事業種別で作る
  document.getElementById("editContactBtn")?.addEventListener("click", openEditContactModal);
  document.getElementById("editContactCloseBtn")?.addEventListener("click", closeEditContactModal);
  document.getElementById("editContactCancelBtn")?.addEventListener("click", closeEditContactModal);
  document.getElementById("editContactModal")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeEditContactModal(); });
  ["editContactName", "editContactEmail", "editContactPhone"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => { document.getElementById("editContactError").style.display = "none"; });
  });
  document.getElementById("editContactConfirmBtn")?.addEventListener("click", saveContact);
  document.getElementById("copyCaseBtn")?.addEventListener("click", openCopyCaseModal);
  document.getElementById("copyCaseCloseBtn")?.addEventListener("click", closeCopyCaseModal);
  document.getElementById("copyCaseCancelBtn")?.addEventListener("click", closeCopyCaseModal);
  document.getElementById("copyCaseModal")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeCopyCaseModal(); });
  document.getElementById("copySourceType")?.addEventListener("change", () => {
    document.getElementById("copyCaseError").style.display = "none";
  });
  document.getElementById("copyServiceType")?.addEventListener("change", (e) => {
    document.getElementById("copyPlanHint").textContent = planHintText(e.target.value);
    document.getElementById("copyCaseError").style.display = "none";
  });
  document.getElementById("copyCaseConfirmBtn")?.addEventListener("click", copyCaseWithServiceType);

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
    let lost = null;
    let warnNote = "";
    // 承諾書のサイン＝発注（発5・スイッチがオンのとき）: 受注前の案件を手で 3〜12 に進めない。管理者は理由を書けば変えられる
    let manualNote = "";
    const guard = statusChangeGuard({ from: currentCase.status, to: e.target.value, orderByConsent: orderOn(), isAdmin, caseData: currentCase });
    if (guard.kind === "blocked") { alert(guard.message); e.target.value = String(currentCase.status || 1); return; }
    if (guard.kind === "reason") {
      const reason = (prompt(guard.message, "") || "").trim();
      if (!reason) { e.target.value = String(currentCase.status || 1); return; } // キャンセル・空欄は変えない
      manualNote = manualStatusNote(reason);
    }
    if (Number(e.target.value) === LOST) {
      lost = await askLostReason(LOST_REASONS);
      if (!lost) { e.target.value = String(currentCase.status || 1); return; } // キャンセル
    }
    // 完了(13)にするときは、出荷・請求・入金・申請情報の取りこぼしを確認（止めずに確認だけ。設計 §6 W）
    if (isCompleting(currentCase.status, e.target.value)) {
      const warnings = completionWarnings({ shipments: shipmentsCache, subsidy: subsidyCache });
      const msg = completionConfirmText(warnings);
      if (msg && !confirm(msg)) { e.target.value = String(currentCase.status || 1); return; } // キャンセル
      warnNote = completionActivityNote(warnings);
    }
    // 伴走支援実施済(8)以降にしたときは、請求書を出していない出荷を知らせる（止めない・2026-11-08）。
    // ポップアップを止められないよう、OK を押したその場で空のタブを開き、保存のあとで行き先を入れる
    let invTab = null, invUrl = "";
    if (isFinishingSupport(currentCase.status, e.target.value)) {
      const pend = invoicePending(shipmentsCache);
      const msg = invoicePromptText(pend);
      if (msg) {
        const ok = confirm(msg);
        warnNote = invoicePromptNote(pend, ok);
        if (ok) { invUrl = invoicePromptUrl(pend); invTab = window.open("about:blank", "_blank"); }
      }
    }
    try {
      await changeStatus(e.target.value, user.uid, user.displayName || user.email, lost, warnNote, manualNote);
    } catch (err) {
      if (invTab) invTab.close();
      e.target.value = String(currentCase.status || 1);
      alert(`ステータスの変更に失敗しました: ${err.message || err}`);
      return;
    }
    if (invUrl) { if (invTab) invTab.location.href = invUrl; else location.href = invUrl; }
    currentCase.status = Number(e.target.value);
    applyStatusGuard(currentCase);
    renderLostReason(currentCase);
    renderNextStep(); // 次の一手を即座に更新
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
  // 保存ボタンの欄（伴走支援の記録・その編集・振込口座・申請情報）の未保存の表示と、ページを離れるときの確認
  sessionUnsaved = trackUnsaved("session", document.getElementById("addSessionBtn").closest(".card"), "sessionUnsaved");
  sessionEditUnsaved = trackUnsaved("sessionEdit", document.getElementById("sessionsEl"), "sessEditUnsaved",
    { match: (t) => !!(t && t.closest && t.closest("#sessEditDate, #sessEditSummary, #sessEditAdd")) });
  bankUnsaved = trackUnsaved("bank", document.getElementById("saveBankBtn").closest(".card"), "bankUnsaved");
  subsidyUnsaved = trackUnsaved("subsidy", document.getElementById("saveSubsidyBtn").closest(".card"), "subsidyUnsaved");

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
  for (const id of ["cardReaderCost", "supportCost", "grantAmount"]) document.getElementById(id).addEventListener("input", updateSubsidyDiffs);

  // 書類チェックリスト購読
  onSnapshot(doc(db, "documentChecklists", caseId), (snap) => {
    renderDocumentChecklist(snap.exists() ? snap.data() : null, !!snap.metadata?.hasPendingWrites);
  });

  // 申請情報購読
  onSnapshot(doc(db, "subsidyApplications", caseId), (snap) => {
    subsidyCache = snap.exists() ? snap.data() : null;
    renderSubsidy(subsidyCache, !!snap.metadata?.hasPendingWrites);
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
    supportChecklist?.setActivities?.(latestActivities); // 当日タブの「記録済み」の表示
  });
  // 対応記録の「当日の記録を開く」「伴走支援の記録を開く」（一覧は描き直されるので親で受ける）
  document.getElementById("timelineEl").addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".act-ref-open");
    if (b) openActivityRef(b.dataset.refType, b.dataset.refId);
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

  // 出荷・請求・入金タブ購読（読み取り専用。orderBy は付けない＝複合インデックス不要。並びはクライアント側で createdAt 降順）
  const shipQ = query(collection(db, "shipments"), where("caseId", "==", caseId));
  onSnapshot(shipQ, (snap) => {
    shipmentsCache = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    renderShippingTab(shipmentsCache);
    renderShipDupBanner(shipmentsCache);
    renderNextStep(); // 次の一手2行目（お金の流れ）を同じデータで更新
    refreshSubsidyAuto(shipmentsCache).catch((e) => console.warn("subsidy auto:", e.message || e)); // 申請タブ「申請で入れる値」
  }, (err) => {
    console.warn("shipments subscribe:", err.message || err);
    renderShippingError();
    const sab = document.getElementById("subsidyAutoBody");
    if (sab) sab.innerHTML = `<p class="sa-muted">出荷を読み込めなかったため、申請で入れる値を出せません。ページを読み込み直してください。</p>`;
  });
  document.getElementById("shipFromCaseBtn2")?.setAttribute("href", `/supply.html?ship=${caseId}`);

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
