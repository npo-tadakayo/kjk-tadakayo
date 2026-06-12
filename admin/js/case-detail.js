import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getFunctions, httpsCallable }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { STATUS_LABELS, SOURCE_LABELS, ARCHIVE_REASONS, dupKeys } from "/js/constants.js";
import { ACTIVITY_ICONS, ACTIVITY_LABELS, AI_TITLES, escHtml, formatDateTime, toDateInput, calcExpectedDeposit } from "/js/case-detail-util.js";
import { initSupportChecklist } from "/js/support-checklist.js";

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
let currentUser = null;

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
  body.innerHTML = cands.map((c) => `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 4px;border-top:1px solid var(--color-line)">
      <a href="/case-detail.html?id=${c._id}" style="flex:1;text-decoration:none;color:inherit">
        <strong>#${c.caseNumber || "—"}</strong>
        ${escHtml(c.officeName || "—")}
        <span style="font-size:12px;color:var(--color-ink-muted)">${SOURCE_LABELS[c.source] || c.source || ""} ／ ${STATUS_LABELS[c.status] || ""}</span>
      </a>
      <button class="btn btn-ghost" type="button" data-merge="${c._id}" style="white-space:nowrap">
        <i class="ti ti-arrow-merge" aria-hidden="true"></i>この案件に統合
      </button>
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
    expectedDepositDate: expected ? expected.toISOString().slice(0, 10) : null,
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
  const snap = await getDocs(collection(db, "cases"));
  return snap.docs
    .map((d) => ({ _id: d.id, ...d.data() }))
    .filter((c) => c._id !== caseId && !c.archived && dupKeys(c).some((k) => myKeys.has(k)));
}

// other を当案件（primary）に統合する
async function mergeInto(other) {
  if (!confirm(`案件 #${other.caseNumber || ""}「${other.officeName || ""}」を、この案件 #${currentCase.caseNumber || ""} に統合します。\n統合元は「対象外（重複）」になります。よろしいですか？`)) return;
  try {
    const batch = writeBatch(db);
    // 統合元の記録・セッションを当案件へ付け替え
    for (const col of ["activities", "sessions"]) {
      const snap = await getDocs(query(collection(db, col), where("caseId", "==", other._id)));
      snap.forEach((d) => batch.update(d.ref, { caseId }));
    }
    // 当案件に欠けている連絡先を統合元から補完
    const fill = {};
    ["contactName", "contactEmail", "contactPhone", "corpName"].forEach((f) => {
      if (!currentCase[f] && other[f]) fill[f] = other[f];
    });
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
    // 内容差分を失わないよう、統合元の要点を当案件のタイムラインに残す
    const detail = [
      `流入元: ${SOURCE_LABELS[other.source] || other.source || "—"}`,
      `ステータス: ${STATUS_LABELS[other.status] || "—"}`,
      other.contactName ? `担当者: ${other.contactName}` : "",
      other.contactEmail ? `メール: ${other.contactEmail}` : "",
      other.contactPhone ? `電話: ${other.contactPhone}` : "",
      other.subsidyCategory ? `補助区分: ${other.subsidyCategory}` : "",
      other.expectedSubsidyAmount ? `想定補助額: ${other.expectedSubsidyAmount}` : "",
      Array.isArray(other.cardReaders) && other.cardReaders.length
        ? `カードリーダー: ${JSON.stringify(other.cardReaders)}` : "",
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
function renderSessions(sessions) {
  const el = document.getElementById("sessionsEl");
  if (!sessions.length) {
    el.innerHTML = `<div class="empty-state"><i class="ti ti-camera" aria-hidden="true"></i><p>伴走支援の記録がありません</p></div>`;
    return;
  }
  el.innerHTML = sessions.map((s) => {
    const photos = (s.photoUrls || []).map((u) =>
      `<a href="${u}" target="_blank" rel="noopener"><img class="session-photo" src="${u}" alt="支援写真" loading="lazy"></a>`
    ).join("");
    return `
      <div class="card" style="margin-bottom:var(--space-3)">
        <div class="card-body">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong style="font-size:14px"><i class="ti ti-calendar-event" aria-hidden="true"></i> ${escHtml(s.sessionDate || "日付未設定")}</strong>
            <span style="font-size:12px;color:var(--color-ink-muted)">${escHtml(s.userName || "")} ・ ${formatDateTime(s.createdAt)}</span>
          </div>
          ${s.summary ? `<div style="font-size:13px;white-space:pre-wrap;margin-bottom:${photos ? "10px" : "0"}">${escHtml(s.summary)}</div>` : ""}
          ${photos ? `<div class="session-photos">${photos}</div>` : ""}
        </div>
      </div>`;
  }).join("");
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
  if (!myRole) return;
  isAdmin = myRole.role === "admin";
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
  document.getElementById("loadingEl").style.display = "none";
  document.getElementById("mainContent").style.display = "block";
  renderCaseHeader(currentCase);
  renderCaseActions();
  renderDuplicateCandidates();

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
