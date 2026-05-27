import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, addDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const caseId = new URLSearchParams(location.search).get("id");
if (!caseId) { location.href = "/cases.html"; }

const STATUS_LABELS = {
  1: "新規受信", 2: "確認中", 3: "受注確定", 4: "失注",
  5: "担当者決定", 6: "事前準備中", 7: "伴走支援待ち",
  8: "伴走支援実施済", 9: "書類準備完了・申請ガイド中",
  10: "申請完了・採択待ち", 11: "採択・入金待ち",
  12: "アフターフォロー中", 13: "案件完了",
};

const SOURCE_LABELS = {
  lp_inquiry: "LP問い合わせ",
  mitsumori_quote: "見積もり成約",
  manual: "手動登録",
};

const ACTIVITY_ICONS = {
  phone_in: "ti-phone-incoming",
  phone_out: "ti-phone-outgoing",
  email_in: "ti-mail-down",
  email_out: "ti-mail-up",
  visit: "ti-map-pin",
  memo: "ti-notes",
  gmail_sent: "ti-mail-forward",
};

const ACTIVITY_LABELS = {
  phone_in: "電話（着信）",
  phone_out: "電話（発信）",
  email_in: "メール（受信）",
  email_out: "メール（送信）",
  visit: "訪問・対面",
  memo: "メモ",
  gmail_sent: "Gmail送信",
};

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function toDateInput(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0, 10);
}

// 振込予定日: 申請月の翌々月末
function calcExpectedDeposit(applicationDateStr) {
  if (!applicationDateStr) return null;
  const d = new Date(applicationDateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 3; // +2ヶ月 → 翌々月末 = +3ヶ月の0日
  return new Date(year, month, 0);
}

let currentCase = null;

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

  document.getElementById("userEmail").textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));

  initTabs();

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

  // ステータス変更
  document.getElementById("statusSelect").addEventListener("change", async (e) => {
    await changeStatus(e.target.value, user.uid, user.displayName || user.email);
    showToast(`ステータスを「${STATUS_LABELS[e.target.value]}」に変更しました`);
  });

  // 対応記録追加
  document.getElementById("addActivityBtn").addEventListener("click", () => addActivity(user.uid, user.displayName || user.email));

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
    renderTimeline(snap.docs.map((d) => ({ _id: d.id, ...d.data() })));
  });
});
