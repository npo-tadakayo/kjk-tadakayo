// ===== 練習モードの「送ったことにする」代役（2026-10-20） =====
// 練習中は Cloud Functions を一切呼ばない（fn.js が httpsCallable をここへ差し替える）。
// 代役は、本番の Functions が成功したときに Firestore へ残す記録（送付日・活動記録・状態）を
// 練習DBに同じ形で書き、「練習のため送っていません」と知らせる。メール・Chat・PDF保存・AI は動かさない。
//
// 本番の Functions の書き込み内容は functions/index.js の同名の関数に合わせてある。
// 本番側を変えたら、ここも合わせること（練習の画面が本番と違う動きにならないように）。
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, addDoc, updateDoc,
  writeBatch, runTransaction, serverTimestamp, arrayUnion, increment, deleteField, Timestamp }
  from "/js/fs.js";
import { validatePatch, resolveKeep, buildAliases, checkMerge, pickRestorable, canRestoreTo } from "/js/office-merge.js";

function db() { return getFirestore(getApp()); } // 練習モード中なので練習DB
function me() {
  const u = getAuth(getApp()).currentUser;
  return { uid: u?.uid || "", email: u?.email || "", name: u?.displayName || u?.email || "" };
}
function todayJst() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}
const isMail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
const fmtNum = (n) => Number(n || 0).toLocaleString("ja-JP");
const PRACTICE_NOTE = "【練習モード：実際には送信していません】";

/** 画面の下に「送っていません」を出す（各画面のトーストとは別に、取り違えないよう必ず出す） */
export function showPracticeNotice(text) {
  try {
    let el = document.getElementById("practiceNotice");
    if (!el) {
      el = document.createElement("div");
      el.id = "practiceNotice";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.style.cssText = "position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:10001;"
        + "background:#FFF4C2;border:2px solid #C99A00;color:#2C2416;padding:10px 16px;border-radius:8px;"
        + "font-size:14px;font-weight:700;max-width:min(92vw,560px);box-shadow:0 4px 12px rgba(0,0,0,.15);"
        + "font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif";
      document.body.appendChild(el);
    }
    el.textContent = `練習モード：${text}`;
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = "none"; }, 6000);
  } catch (_) {}
}

/** 送るはずだった内容の控え（練習DBの practiceSent）。練習のふり返り用 */
async function logSent(kind, detail) {
  try {
    await addDoc(collection(db(), "practiceSent"), {
      kind, ...detail, sentAt: serverTimestamp(), by: me().email,
    });
  } catch (e) { console.warn("[practice] log", e.message); }
}

async function activity(caseId, type, subject, body, attachmentUrls) {
  if (!caseId) return;
  const u = me();
  await addDoc(collection(db(), "activities"), {
    caseId, type, occurredAt: serverTimestamp(), userId: u.uid, userName: u.email,
    subject, body, attachmentUrls: attachmentUrls || [],
  });
}

function fail(msg) { const e = new Error(msg); e.code = "failed-precondition"; return e; }

// ===== 事業所の編集・統合（updateOffice / mergeOffices / unmergeOffice）の共通部品 =====
// 本物は functions/index.js の同名の Callable。本番側を変えたらここも合わせる。
const OFFICE_REF_COLLS = ["cases", "quotes", "shipments", "leadTokens"]; // officeId で事業所を指す4つ
const OFFICE_EDIT_FIELDS = ["officeName", "corpName", "address", "phone", "postalCode"];
const OFFICE_CASE_CHUNK = 150;   // 案件は「案件の更新＋対応記録」の2書き込み
const OFFICE_BATCH_LIMIT = 400;
const OFFICE_MERGE_MAX_REFS = 5000;
function oErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
async function idsByOffice(coll, officeId) {
  const s = await getDocs(query(collection(db(), coll), where("officeId", "==", officeId)));
  return s.docs.map((d) => d.id);
}
/** 案件の対応記録（本番と同じ文面。type は memo） */
function officeActivity(batch, caseId, subject, body) {
  const u = me();
  batch.set(doc(collection(db(), "activities")), {
    caseId, type: "memo", occurredAt: serverTimestamp(), userId: u.uid, userName: u.name,
    subject, body, attachmentUrls: [],
  });
}
// 住所 → 都道府県・市区町村（functions/index.js の regionFromAddress / splitOfficeAddress と同じ。
// 画面の area.js の parseAddress とは別物なので、本番に合わせてここに写してある）
function regionFromAddress(addr) {
  const a = String(addr || "").replace(/^\s*〒?\s*\d{3}-?\d{4}\s*/, "").replace(/\s+/g, "");
  const m = /^(東京都|北海道|(?:京都|大阪)府|.{2,3}?県)/.exec(a);
  if (!m) return {};
  const rest = a.slice(m[1].length);
  const iShi = rest.indexOf("市"), iGun = rest.indexOf("郡");
  let city = "";
  if (iGun > 0 && (iShi < 0 || iGun < iShi)) {
    const g = /^.+?郡(.+?[町村])/.exec(rest);
    if (g && !g[1].includes("市")) city = g[1];
  }
  if (!city) {
    const c = /^(.+?市.+?区|.+?[市区町村])/.exec(rest);
    if (c) city = c[1];
    if (/^.+?市.+?区$/.test(city) && !/^(札幌|仙台|さいたま|千葉|横浜|川崎|相模原|新潟|静岡|浜松|名古屋|京都|大阪|堺|神戸|岡山|広島|北九州|福岡|熊本)市/.test(city)) {
      city = city.replace(/^(.+?市).*$/, "$1");
    }
  }
  return { prefecture: m[1], city };
}
function splitOfficeAddress(address) {
  const raw = String(address || "").trim();
  const r = regionFromAddress(raw);
  if (!r.prefecture) return { prefecture: "", city: "", addressDetail: raw };
  const a = raw.replace(/^\s*〒?\s*\d{3}-?\d{4}\s*/, "").replace(/\s+/g, "");
  const head = r.prefecture + (r.city || "");
  if (r.city && a.startsWith(head)) return { prefecture: r.prefecture, city: r.city, addressDetail: a.slice(head.length) };
  return { prefecture: r.prefecture, city: "", addressDetail: a.slice(r.prefecture.length) };
}
const OFFICE_ADDR_PARTS = ["prefecture", "city", "addressDetail"];
const OFFICE_LOCK_MS = 5 * 60 * 1000;
const OFFICE_LOCK_BUSY = "ほかの人がこの事業所を更新中です。少し待ってからもう一度お試しください";
function pickOfficeFields(o, fields) {
  const out = {};
  for (const f of fields) out[f] = o && o[f] != null ? String(o[f]) : "";
  return out;
}
// 事業所ごとの作業中の印（本物の lockOffices と同じ。5分で切れる）。check は同じトランザクションの中で状態を確かめ、
// 印と一緒に書く内容 {id: 更新内容} を返してよい
async function lockOffices(ids, kind, check) {
  const lockId = newToken();
  const refs = [...new Set(ids)].sort().map((id) => doc(db(), "offices", id));
  const datas = await runTransaction(db(), async (tx) => {
    const snaps = [];
    for (const r of refs) snaps.push(await tx.get(r));
    const out = {};
    for (const sn of snaps) {
      if (!sn.exists()) { out[sn.id] = null; continue; }
      const L = sn.data().opLock;
      const at = L && L.at && typeof L.at.toMillis === "function" ? L.at.toMillis() : 0;
      if (L && Date.now() - at < OFFICE_LOCK_MS) throw oErr("failed-precondition", OFFICE_LOCK_BUSY);
      out[sn.id] = sn.data();
    }
    const extra = (check ? await check(out, tx) : null) || {};
    const lock = { id: lockId, kind, by: me().email, at: Timestamp.now() };
    for (const sn of snaps) if (sn.exists()) tx.update(sn.ref, { ...(extra[sn.id] || {}), opLock: lock });
    return out;
  });
  return { lockId, datas };
}
async function unlockOffices(ids, lockId) {
  for (const id of [...new Set(ids)]) {
    const ref = doc(db(), "offices", id);
    try {
      await runTransaction(db(), async (tx) => {
        const sn = await tx.get(ref);
        if (sn.exists() && sn.data().opLock && sn.data().opLock.id === lockId) tx.update(ref, { opLock: deleteField() });
      });
    } catch (e) { console.warn("[practice] unlock", e.message); }
  }
}

// 価格の計算（公開ページ・Functions と同じ estimate-pricing.js）。ES module から読めないので script で読む
let pricingPromise = null;
function loadPricing() {
  if (window.EstimatePricing) return Promise.resolve(window.EstimatePricing);
  if (!pricingPromise) {
    pricingPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/js/estimate-pricing.js";
      s.onload = () => window.EstimatePricing ? resolve(window.EstimatePricing) : reject(new Error("価格の計算を読み込めませんでした"));
      s.onerror = () => reject(new Error("価格の計算を読み込めませんでした"));
      document.head.appendChild(s);
    });
  }
  return pricingPromise;
}

function daysFromNow(n) { return Timestamp.fromDate(new Date(Date.now() + n * 864e5)); }
function newToken() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// functions/index.js の PRODUCT_NAMES / CONNECTION_LABELS / shipmentItemsFromQuote と同じ
function shipmentItemsFromQuote(P, q) {
  const NAMES = { [P.SKU.BT]: P.BT_LABEL, [P.SKU.USB_A]: P.USB_LABEL, [P.SKU.USB_C]: P.USB_LABEL };
  const CONN = { [P.SKU.BT]: "Bluetooth／USB Type-C", [P.SKU.USB_A]: "USB Type-A", [P.SKU.USB_C]: "USB Type-C" };
  const items = [];
  for (const it of (q.items || [])) {
    const qty = (Number(it.subsidyQty) || 0) + (Number(it.extraQty) || 0);
    if (qty <= 0) continue;
    const unitPrice = it.sku === P.SKU.BT ? P.BT_PRICE : P.USB_PRICE;
    items.push({ sku: it.sku, name: NAMES[it.sku] || it.sku, qty, unitPrice, connection: CONN[it.sku] || "" });
  }
  const fee = Number(q.amounts?.accompanyFee) || 0;
  if (fee > 0) {
    const n = (q.items || []).reduce((a, i) => a + (Number(i.subsidyQty) || 0), 0);
    items.push({ sku: "support-fee", name: `伴走支援費（補助対象${n}台）`, qty: 1, unitPrice: fee, nonStock: true });
  }
  const discount = Number(q.amounts?.discount) || 0;
  if (discount > 0) items.push({ sku: "discount", name: "金額調整", qty: 1, unitPrice: -discount, nonStock: true });
  return items;
}

async function quoteCalc(planKey, d) {
  const P = await loadPricing();
  const calc = P.computeAmounts(planKey, d.btQty, d.usbQty, d.btExtra, d.usbExtra);
  if (calc.subsidyTotal < 1) throw fail("補助対象のカードリーダーを1台以上にしてください");
  if (calc.subsidyTotal > calc.plan.maxQty) throw fail(`${calc.plan.label}の補助対象は最大${calc.plan.maxQty}台です`);
  const connector = ["A", "C"].includes(d.usbConnector) ? d.usbConnector : null;
  const items = P.buildItems({ btQty: d.btQty, usbQty: d.usbQty, btExtra: d.btExtra, usbExtra: d.usbExtra, usbConnector: connector });
  const amounts = {
    readers: calc.devSubsidyIncl, accompanyFee: calc.accFeeIncl, discount: calc.discount,
    subsidyPartTotal: calc.subsidyPartTotal, extraPartTotal: calc.extraPartTotal,
    totalIncl: calc.totalIncl, grantAmt: calc.grantAmt, selfPay: calc.selfPay,
  };
  const cardReaders = [];
  const bt = Number(d.btQty) || 0, usb = Number(d.usbQty) || 0, btx = Number(d.btExtra) || 0, usbx = Number(d.usbExtra) || 0;
  if (bt > 0 || btx > 0) cardReaders.push({ type: "BT", subsidyQty: bt, extraQty: btx });
  if (usb > 0 || usbx > 0) cardReaders.push({ type: "USB", subsidyQty: usb, extraQty: usbx, connector });
  return { P, calc, connector, items, amounts, cardReaders };
}

async function nextQuoteNumber() {
  const year = todayJst().slice(0, 4);
  const ref = doc(db(), "_counters", `quotes_${year}`);
  const n = await runTransaction(db(), async (tx) => {
    const d = await tx.get(ref);
    const v = (d.exists() ? d.data().value : 0) + 1;
    tx.set(ref, { value: v });
    return v;
  });
  return `EST-${year}-${String(n).padStart(4, "0")}`;
}

// functions/accept-flow.js の subsidyQtyFromItems と同じ（補助対象の台数。BT 以外は USB に数える）
function subsidyQtyFromItems(items, btSku) {
  const list = Array.isArray(items) ? items : [];
  const sum = (arr) => arr.reduce((a, i) => a + (Number(i && i.subsidyQty) || 0), 0);
  return { bt: sum(list.filter((i) => i && i.sku === btSku)), usb: sum(list.filter((i) => i && i.sku !== btSku)) };
}

// ===== 電話・メールの受注確定（staffAcceptQuote）の判定。functions/accept-rules.js・accept-flow.js と同じ =====
// 本番を変えたらここも合わせる（scripts/test-practice-mode.mjs が文言の一致を一部検査する）
const STAFF_ACCEPT_CHANNELS = { phone: "電話", email: "メール", fax: "FAX", other: "その他" };
const CHANNEL_LABEL = { phone: "電話", email: "メール", fax: "FAX", other: "その他の方法" };
const PAY_LABELS = { after: "伴走支援の後にお支払い", before: "先にお支払い（前払い）" };
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
function isValidYmd(v) {
  const m = YMD.exec(String(v || ""));
  if (!m) return false;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === v;
}
function jstYmdOf(v) {
  if (v == null || v === "") return "";
  let ms;
  if (typeof v.toMillis === "function") ms = v.toMillis();
  else if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "number") ms = v;
  else if (typeof v === "string" && YMD.test(v)) return v;
  else ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms + 9 * 3600e3).toISOString().slice(0, 10) : "";
}
function checkStaffAccept({ quote, siblings, kase, shipments, receivedDate, todayYmd, acceptedName, channel }) {
  const ng = (code, message) => ({ ok: false, code, message });
  if (!quote) return ng("quote_not_found", "見積もりが見つかりません");
  if (quote.status === "accepted") return ng("already_accepted", "この見積もりはすでに受注確定（お申し込み済み）です");
  if (quote.status !== "issued") return ng("not_issued", "この見積もりは受注確定にできません（発行中の見積もりではありません）");
  const myVer = Number(quote.version) || 0;
  if ((siblings || []).some((x) => x && x.id !== quote.id && (Number(x.version) || 0) > myVer)) return ng("old_version", "新しい版の見積もりがあります。最新の版で受注確定にしてください");
  if (!isValidYmd(receivedDate)) return ng("invalid_received_date", "受付日を正しく入れてください（YYYY-MM-DD）");
  if (receivedDate > todayYmd) return ng("future_received_date", "受付日が未来の日付になっています");
  const until = jstYmdOf(quote.validUntil);
  if (until && receivedDate > until) return ng("expired", `受付日（${receivedDate}）が見積もりの有効期限（${until}）を過ぎています`);
  if (!String(acceptedName || "").trim()) return ng("no_name", "申込者のお名前を入れてください");
  if (!Object.prototype.hasOwnProperty.call(STAFF_ACCEPT_CHANNELS, channel)) return ng("invalid_channel", "受付方法（電話・メール・FAX・その他）を選んでください");
  if (!kase) return ng("case_not_found", "案件が見つかりません");
  const live = (shipments || []).filter((x) => x && (x.status || "shipped") !== "canceled");
  if (live.length) {
    const pre = live.every((x) => x.status === "draft" || x.status === "requested");
    const nos = live.map((x) => x.soNumber).filter(Boolean).join("・");
    return pre
      ? ng("draft_exists", `この案件にはすでに出荷の下書き・依頼${nos ? `（${nos}）` : ""}があります。重複していないか確かめてください`)
      : ng("shipped_exists", `この案件はすでに発送済みの出荷${nos ? `（${nos}）` : ""}があります。受注確定は二重になります`);
  }
  return { ok: true };
}
// 案件の状態: 1・2 → 3／4（失注）・13（完了）→ 再申込として 3 に戻す／それ以外は据え置き（accept-flow.js caseStatusOnAccept）
function caseStatusOnAccept(status) {
  const st = Number(status) || 1;
  if (st === 4 || st === 13) return { status: 3, reopenedFrom: st };
  if (st === 1 || st === 2) return { status: 3, reopenedFrom: null };
  return { status: null, reopenedFrom: null };
}
function jstMidnightMs(ymd) {
  if (!isValidYmd(ymd)) return null;
  const m = YMD.exec(ymd);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600e3;
}
function reopenLabel(from) {
  return Number(from) === 4 ? "再申込で再開（失注から）" : Number(from) === 13 ? "再申込で再開（完了から）" : "";
}

export const PRACTICE_STUBS = {
  // AI アシスタント（Vertex AI）は動かさない
  async aiAssist({ task }) {
    showPracticeNotice("AIアシスタントは練習中は動きません");
    return { task, text: "（練習モード）AIアシスタントは練習中は動かしません。\n本番では、ここに案件の内容から作った文章（要約・返信の下書きなど）が表示されます。内容を確かめてから使ってください。" };
  },

  // 案件からのメール送信（承諾書の依頼・事前資料の送付もこれを使う）
  async sendCaseEmail({ to, subject, body, caseId }) {
    if (!isMail(to)) throw fail("宛先メールアドレスが不正です");
    await activity(caseId, "gmail_sent", `メール送信: ${subject || ""}`, `${PRACTICE_NOTE}\n宛先: ${to}\n\n${body || ""}`);
    if (caseId) await updateDoc(doc(db(), "cases", caseId), { updatedAt: serverTimestamp() });
    await logSent("caseEmail", { to, subject: subject || "", caseId: caseId || null });
    showPracticeNotice(`メールは送っていません（宛先 ${to}）。送ったことにして記録しました`);
    return { ok: true, id: "practice" };
  },

  // 仕入先（AB Circle）への発注メール
  async sendSupplierOrder({ to, cc, subject, poId }) {
    if (poId) {
      const now = serverTimestamp();
      await updateDoc(doc(db(), "purchaseOrders", poId), { status: "sent", emailedTo: to || "", emailedCc: cc || "", emailedAt: now, confirmedAt: now });
    }
    await logSent("supplierOrder", { to: to || "", subject: subject || "", poId: poId || null });
    showPracticeNotice("仕入先への発注メールは送っていません。送ったことにして記録しました");
    return { ok: true, id: "practice" };
  },

  // 認定事業者・請求先へのメール（請求書・領収証・督促・発注案内）
  async sendPartnerMail({ to, subject, shipmentId, kind }) {
    if (shipmentId) {
      const day = todayJst();
      const k = kind || "mail";
      const update = { mailLog: arrayUnion({ kind: k, to: to || "", subject: subject || "", sentAt: day, sentBy: me().email }), updatedAt: serverTimestamp() };
      if (k === "dunning") { update.dunningSentAt = day; update.dunningCount = increment(1); }
      if (k === "invoice") { update.invoiceMailedAt = day; update.invoiceMailedTo = to || ""; }
      if (k === "receipt") { update.receiptMailedAt = day; update.receiptMailedTo = to || ""; }
      await updateDoc(doc(db(), "shipments", shipmentId), update);
    }
    await logSent("partnerMail", { to: to || "", subject: subject || "", kind: kind || "mail", shipmentId: shipmentId || null });
    showPracticeNotice(`メールは送っていません（宛先 ${to || "—"}）。送ったことにして記録しました`);
    return { ok: true, id: "practice" };
  },

  // 経理への請求書発行の報告（メール＋Chat）。請求書PDFは保存しない
  async reportInvoiceToAccounting({ shipmentId, invNo, amountText }) {
    if (!shipmentId) throw fail("shipmentId は必須です");
    const day = todayJst();
    const email = me().email;
    await updateDoc(doc(db(), "shipments", shipmentId), {
      accountingReportedAt: day, accountingReportedBy: email, accountingReportCount: increment(1),
      accountingReportLog: arrayUnion({ reportedAt: day, reportedBy: email, mailed: true, mailedTo: "（練習）", posted: true, invNo: invNo || "", amountText: amountText || "" }),
      updatedAt: serverTimestamp(),
    });
    await logSent("accountingReport", { shipmentId, invNo: invNo || "", amountText: amountText || "" });
    showPracticeNotice("経理へのメール・Chat は送っていません。報告したことにして記録しました");
    return { mailed: true, posted: true, warnings: [] };
  },

  // 出荷指示の Chat 投稿
  async notifyShipment({ shipmentId, resend }) {
    const ref = doc(db(), "shipments", shipmentId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return { posted: false, reason: "not-found" };
    const s = snap.data();
    // 本番（functions/index.js の NOTIFY_STATUSES）と同じ: 依頼済（requested）以降が対象。下書き・キャンセルは止める（2026-10-21 出荷の二段階化）
    if (!["requested", "shipped", "invoiced", "paid"].includes(s.status)) throw fail("出荷を依頼していない出荷（下書き・キャンセル）は投稿できません");
    if (s.shipNotifiedAt && !resend) return { posted: false, reason: "already" };
    const u = me();
    const now = serverTimestamp();
    await updateDoc(ref, {
      shipNotifiedAt: now, shipNotifiedBy: u.name, shipNotifiedByEmail: u.email,
      shipNotifyStatus: "posted", shipNotifyError: deleteField(), shipNotifyAttemptAt: now, shipNotifyLockAt: null,
      shipNotifyCount: increment(1),
    });
    await activity(s.caseId, "memo", `出荷指示: 投稿しました${resend ? "（再送）" : ""}（${s.soNumber || ""}）`,
      `${PRACTICE_NOTE}\n出荷指示の投稿先へ、出荷 ${s.soNumber || ""} の指示を投稿したことにしました（投稿者: ${u.name}）。`);
    await logSent("shipNotice", { shipmentId, soNumber: s.soNumber || "", resend: !!resend });
    showPracticeNotice("出荷指示の Chat は投稿していません。投稿したことにして記録しました");
    return { posted: true, resent: !!resend };
  },

  // 設定画面の「テスト送信」
  async testChatNotify({ kind }) {
    showPracticeNotice(`Chat のテスト送信（${kind || "crm"}）は送っていません`);
    return { ok: true };
  },

  // 見積書PDFの再送
  async resendQuoteMail({ quoteId, to: toOverride }) {
    const ref = doc(db(), "quotes", String(quoteId));
    const snap = await getDoc(ref);
    if (!snap.exists()) throw fail("見積もりが見つかりません");
    const q = snap.data();
    if (!q.pdfPath) throw fail("この見積もりのPDFは保存されていません（見積書の画面で「PDFを保存」してから再送してください）");
    const to = String(toOverride || q.contactEmail || "").trim();
    if (!isMail(to)) throw fail("宛先メールアドレスが不正です");
    const now = serverTimestamp();
    await updateDoc(ref, { mailedAt: now, mailedTo: to, mailError: null });
    await activity(q.caseId, "gmail_sent", `メール送信: 【再送】お見積書（${q.estNo}）`, `${PRACTICE_NOTE}\n宛先: ${to}（見積書PDF添付）`);
    await updateDoc(doc(db(), "cases", q.caseId), { updatedAt: now });
    await logSent("quoteResend", { to, quoteId, estNo: q.estNo || "" });
    showPracticeNotice(`見積書のメールは送っていません（宛先 ${to}）。送ったことにして記録しました`);
    return { ok: true, id: "practice" };
  },

  // 見積書PDFの保存・送付（quote-print.html）。PDFは保存しない（練習の印として pdfPath だけ付ける）
  async saveQuotePdf({ quoteId, mail }) {
    const ref = doc(db(), "quotes", String(quoteId));
    const snap = await getDoc(ref);
    if (!snap.exists()) throw fail("見積もりが見つかりません");
    const q = snap.data();
    const path = "(practice)";
    const wantsMail = mail !== false;
    if (wantsMail && q.mailedAt) {
      await updateDoc(ref, { pdfPath: path, pdfUrl: null });
      return { ok: true, status: "already", pdfUrl: null, mailed: false };
    }
    if (wantsMail && isMail(q.contactEmail)) {
      const now = serverTimestamp();
      await updateDoc(ref, { pdfPath: path, pdfUrl: null, mailedAt: now, mailedTo: q.contactEmail, mailError: null });
      await activity(q.caseId, "gmail_sent", `メール送信: お見積書（${q.estNo}）`, `${PRACTICE_NOTE}\n宛先: ${q.contactEmail}（見積書PDF添付・スタッフ送付）`);
      await logSent("quotePdf", { to: q.contactEmail, quoteId, estNo: q.estNo || "" });
      showPracticeNotice(`見積書のPDFは保存せず、メールも送っていません（宛先 ${q.contactEmail}）`);
      return { ok: true, status: "ok", pdfUrl: null, mailed: true };
    }
    await updateDoc(ref, { pdfPath: path, pdfUrl: null });
    showPracticeNotice("見積書のPDFは保存していません（保存したことにしました）");
    return { ok: true, status: "ok", pdfUrl: null, mailed: false };
  },

  // スタッフが最初の見積もりを作る（functions/index.js の staffCreateQuote と同じ記録）
  async staffCreateQuote(d) {
    const { caseId, plan, note, sendMail } = d;
    if (!caseId) throw fail("caseId は必須です");
    const planKey = ["houmon", "kyojyu", "other"].includes(plan) ? plan : null;
    if (!planKey) throw fail("プランの指定が不正です");
    const caseSnap = await getDoc(doc(db(), "cases", String(caseId)));
    if (!caseSnap.exists()) throw fail("案件が見つかりません");
    const kase = { id: caseSnap.id, ...caseSnap.data() };
    const { calc, connector, items, amounts, cardReaders } = await quoteCalc(planKey, d);

    const sib = await getDocs(query(collection(db(), "quotes"), where("caseId", "==", kase.id)));
    const siblings = sib.docs.map((x) => ({ id: x.id, ...x.data() })).sort((a, b) => (b.version || 0) - (a.version || 0));
    const latest = siblings[0] || null;
    if (siblings.some((s) => s.status === "accepted")) {
      throw fail("この案件は申し込み済みの見積もりがあります。見積もりカードの「内容を変更する」から改版してください。");
    }
    let office = null;
    if (kase.officeId) { const od = await getDoc(doc(db(), "offices", kase.officeId)); if (od.exists()) office = od.data(); }
    const corpName = kase.corpName || office?.corpName || "";
    const officeName = kase.officeName || office?.officeName || "";
    const contactEmail = kase.contactEmail || "", contactName = kase.contactName || "";
    const u = me();
    const now = serverTimestamp();
    const estNo = latest?.estNo || await nextQuoteNumber();
    const version = (latest?.version || 0) + 1;
    const quoteRef = doc(collection(db(), "quotes"));
    const b = writeBatch(db());
    for (const s of siblings) if (s.status === "issued") b.update(doc(db(), "quotes", s.id), { status: "superseded", supersededAt: now });
    b.set(quoteRef, {
      caseId: kase.id, officeId: kase.officeId || null, caseNumber: kase.caseNumber || null,
      estNo, version, plan: planKey, planLabel: calc.plan.label, items, amounts,
      status: "issued", supersedes: latest ? latest.id : null,
      validUntil: daysFromNow(30), createdVia: "staff", createdBy: u.email, createdAt: now,
      contactEmail, contactName, officeName, corpName,
      accessToken: newToken(), pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null,
      note: String(note || "").slice(0, 1000),
    });
    const caseUpdate = {
      latestQuoteId: quoteRef.id, quoteIssuedAt: now, updatedAt: now,
      subsidyPlan: calc.plan.label, cardReaders, subsidyCategory: planKey,
      expectedSubsidyAmount: calc.grantAmt, totalAmount: calc.totalIncl,
      specialDiscount: calc.discount, selfPay: calc.selfPay,
    };
    if (Number(kase.status) === 1) caseUpdate.status = 2; // 新規受信 → 確認中（本番と同じ）
    b.update(doc(db(), "cases", kase.id), caseUpdate);
    b.set(doc(collection(db(), "activities")), {
      caseId: kase.id, type: "memo", occurredAt: now, userId: u.uid, userName: u.email,
      subject: `見積もりを作成（${estNo}・v${version}・スタッフ）`,
      body: `プラン: ${calc.plan.label}\n構成: ${cardReaders.map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`).join(", ")}${connector ? `（USB ${connector === "C" ? "Type-C" : "Type-A"}）` : ""}\n合計（税込）: ¥${fmtNum(calc.totalIncl)}／自己負担: ¥${fmtNum(calc.selfPay)}`
        + (note ? `\nメモ: ${String(note).trim()}` : ""),
      attachmentUrls: [],
    });
    await b.commit();
    let mailed = false;
    if (sendMail && isMail(contactEmail)) {
      await updateDoc(quoteRef, { noticeMailedAt: serverTimestamp(), noticeMailedTo: contactEmail });
      await activity(kase.id, "gmail_sent", `メール送信: お見積り内容のご案内（${estNo} v${version}）`, `${PRACTICE_NOTE}\n宛先: ${contactEmail}`);
      await logSent("quoteNotice", { to: contactEmail, estNo, version });
      mailed = true;
    }
    showPracticeNotice(mailed ? `見積もりを作りました。案内メールは送っていません（宛先 ${contactEmail}）` : "見積もりを作りました（練習用のデータです）");
    return { ok: true, quoteId: quoteRef.id, estNo, version, totalIncl: calc.totalIncl, mailed };
  },

  // 見積もりの改版（functions/index.js の reviseQuote と同じ記録）
  async reviseQuote(d) {
    const { quoteId, plan, reason, sendMail } = d;
    if (!quoteId) throw fail("quoteId は必須です");
    if (!reason || !String(reason).trim()) throw fail("変更の理由をご入力ください（あとから経緯を追えるようにするためです）");
    const baseSnap = await getDoc(doc(db(), "quotes", String(quoteId)));
    if (!baseSnap.exists()) throw fail("見積もりが見つかりません");
    const base = { id: baseSnap.id, ...baseSnap.data() };
    const planKey = ["houmon", "kyojyu", "other"].includes(plan) ? plan : base.plan;
    const { P, calc, items, amounts, cardReaders } = await quoteCalc(planKey, d);

    let shipmentId = base.shipmentId || null, shipStatus = null;
    if (shipmentId) {
      const sh = await getDoc(doc(db(), "shipments", shipmentId));
      shipStatus = sh.exists() ? (sh.data().status || null) : null;
      // 依頼済（requested）も止める（本番の reviseQuote と同じ・2026-10-21 出荷の二段階化）
      if (sh.exists() && shipStatus === "requested") {
        throw fail(`この見積もりの出荷（${sh.data().soNumber}）はすでに出荷を依頼済みです（出荷指示を投稿済み）。見積もりを作り直すときは、先に供給管理の出荷一覧で「依頼を取り消す」（下書きへ戻す）をしてから、もう一度やり直してください。センターへの取り消しの連絡もお願いします。`);
      }
      if (sh.exists() && shipStatus !== "draft") {
        throw fail(`この見積もりの出荷（${sh.data().soNumber}）はすでに「${shipStatus}」です。見積もりの作り直しではなく、供給管理の「出荷の修正」で直してください。`);
      }
    }
    const u = me();
    const now = serverTimestamp();
    const estNo = base.estNo;
    const version = (Number(base.version) || 1) + 1;
    const quoteRef = doc(collection(db(), "quotes"));
    const b = writeBatch(db());
    const sib = await getDocs(query(collection(db(), "quotes"), where("caseId", "==", base.caseId)));
    for (const x of sib.docs) {
      const st = x.data().status;
      if (st === "issued" || st === "accepted") b.update(x.ref, { status: "superseded", supersededAt: now });
    }
    b.set(quoteRef, {
      caseId: base.caseId, officeId: base.officeId || null, caseNumber: base.caseNumber || null,
      estNo, version, plan: planKey, planLabel: calc.plan.label, items, amounts,
      status: base.status === "accepted" ? "accepted" : "issued",
      supersedes: base.id, reason: String(reason).trim().slice(0, 500),
      validUntil: daysFromNow(30), createdVia: "staff", createdBy: u.email, createdAt: now,
      contactEmail: base.contactEmail || "", contactName: base.contactName || "",
      officeName: base.officeName || "", corpName: base.corpName || "",
      accessToken: newToken(), pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null,
      shipmentId: shipmentId || null, shipmentNo: base.shipmentNo || null,
      payMethod: base.payMethod || null, delivery: base.delivery || null,
      acceptedAt: base.acceptedAt || null, acceptedBy: base.acceptedBy || null,
    });
    b.update(doc(db(), "cases", base.caseId), {
      latestQuoteId: quoteRef.id, quoteIssuedAt: now, updatedAt: now,
      subsidyPlan: calc.plan.label, cardReaders, subsidyCategory: planKey,
      expectedSubsidyAmount: calc.grantAmt, totalAmount: calc.totalIncl,
      specialDiscount: calc.discount, selfPay: calc.selfPay,
    });
    if (shipmentId && shipStatus === "draft") {
      b.update(doc(db(), "shipments", shipmentId), {
        items: shipmentItemsFromQuote(P, { items, amounts }), quoteId: quoteRef.id, estNo,
        subsidyCategory: planKey || null, subsidyQty: subsidyQtyFromItems(items, P.SKU.BT),
        updatedAt: now, updatedBy: u.email,
      });
    }
    const before = (base.items || []).map((i) => `${i.sku}×${(Number(i.subsidyQty) || 0) + (Number(i.extraQty) || 0)}`).join("・");
    const after = items.map((i) => `${i.sku}×${(Number(i.subsidyQty) || 0) + (Number(i.extraQty) || 0)}`).join("・");
    b.set(doc(collection(db(), "activities")), {
      caseId: base.caseId, type: "memo", occurredAt: now, userId: u.uid, userName: u.email,
      subject: `見積もりを変更（${estNo} v${base.version} → v${version}）`,
      body: `理由: ${String(reason).trim()}\n変更前: ${before}（¥${fmtNum(Number(base.amounts?.totalIncl || 0))}）\n`
        + `変更後: ${after}（¥${fmtNum(calc.totalIncl)}）`
        + (shipmentId && shipStatus === "draft" ? `\n出荷 ${base.shipmentNo || ""} の下書きも新しい内容に更新しました。` : ""),
      attachmentUrls: [],
    });
    await b.commit();
    let mailed = false;
    if (sendMail !== false && isMail(base.contactEmail)) {
      await activity(base.caseId, "gmail_sent", `メール送信: 【変更後】お見積もり（${estNo} v${version}）`, `${PRACTICE_NOTE}\n宛先: ${base.contactEmail}`);
      await logSent("quoteRevise", { to: base.contactEmail, estNo, version });
      mailed = true;
    }
    showPracticeNotice(mailed ? `見積もりを改版しました。変更のメールは送っていません（宛先 ${base.contactEmail}）` : "見積もりを改版しました（練習用のデータです）");
    return { ok: true, quoteId: quoteRef.id, version, totalIncl: calc.totalIncl, mailed, shipmentUpdated: !!(shipmentId && shipStatus === "draft") };
  },

  // 電話・メール・FAX で受けた申込を受注確定にする（functions/index.js の staffAcceptQuote と同じ記録・2026-10-21）。
  // 確認メール・Chat は送らない。戻り値の形は本物と同じ {ok, results:[{quoteId, shipmentId, soNumber}], partial, errors, mailed, mailError}
  async staffAcceptQuote(d) {
    const { quoteId, acceptedName, channel, receivedDate, payMethod, preferredDate, note, sendMail, groupQuoteIds } = d;
    if (!quoteId || typeof quoteId !== "string") throw fail("quoteId は必須です");
    const name = String(acceptedName || "").trim().slice(0, 100);
    if (!name) throw fail("申込者のお名前を入れてください");
    if (!Object.prototype.hasOwnProperty.call(STAFF_ACCEPT_CHANNELS, channel)) throw fail("受付方法（電話・メール・FAX・その他）を選んでください");
    if (!isValidYmd(receivedDate)) throw fail("受付日を正しく入れてください（YYYY-MM-DD）");
    if (preferredDate && !isValidYmd(preferredDate)) throw fail("希望日を正しく入れてください（YYYY-MM-DD）");
    const payKey = payMethod === "before" ? "before" : "after";
    const memo = String(note || "").trim().slice(0, 1000);
    const extra = Array.isArray(groupQuoteIds) ? groupQuoteIds.filter((x) => typeof x === "string" && x && x !== quoteId) : [];
    const ids = [quoteId, ...new Set(extra)];
    if (ids.length > 20) throw fail("一度に受注確定にできるのは20件までです");
    const pre = await Promise.all(ids.map(async (id) => { const x = await getDoc(doc(db(), "quotes", id)); return x.exists() ? { id: x.id, ...x.data() } : null; }));
    if (!pre[0]) throw fail("見積もりが見つかりません");
    if (pre.length > 1) {
      if (pre.some((q) => !q)) throw fail("見積もりが見つかりません");
      const gid = pre[0].groupId || null;
      if (!gid) throw fail("この見積もりはグループ（同じ法人の一括見積もり）ではありません。ほかの見積もりと一緒には受注確定にできないので、1件ずつ受注確定にしてください");
      if (pre.some((q) => (q.groupId || null) !== gid)) throw fail("同じグループ（同じ法人の一括見積もり）ではない見積もりが含まれています");
    }
    const P = await loadPricing();
    const u = me();
    const done = [], errors = [];
    for (const pq of pre) {
      try {
        let office = null;
        if (pq.officeId) { const od = await getDoc(doc(db(), "offices", pq.officeId)); if (od.exists()) office = od.data(); }
        const dl = {
          company: pq.corpName || office?.corpName || "", officeName: pq.officeName || office?.officeName || "",
          postalCode: office?.postalCode || "", address: office?.address || "", contactName: pq.contactName || "", phone: office?.phone || "",
        };
        const shipList = await getDocs(query(collection(db(), "shipments"), where("caseId", "==", pq.caseId)));
        const sibList = await getDocs(query(collection(db(), "quotes"), where("caseId", "==", pq.caseId)));
        const r = await runTransaction(db(), async (tx) => {
          const qRef = doc(db(), "quotes", pq.id);
          const qs = await tx.get(qRef);
          if (!qs.exists()) throw fail("見積もりが見つかりません");
          const q = { id: qs.id, ...qs.data() };
          const caseRef = doc(db(), "cases", String(q.caseId));
          const cs = await tx.get(caseRef);
          const kase = cs.exists() ? cs.data() : null;
          const chk = checkStaffAccept({
            quote: q, siblings: sibList.docs.map((x) => ({ id: x.id, ...x.data() })), kase,
            shipments: shipList.docs.map((x) => ({ id: x.id, ...x.data() })),
            receivedDate, todayYmd: todayJst(), acceptedName: name, channel,
          });
          if (!chk.ok) throw fail(chk.message);
          const cRef = doc(db(), "_counters", "shipments");
          const c = await tx.get(cRef);
          const n = (c.exists() ? c.data().value : 0) + 1;
          const soNumber = `SH-${todayJst().slice(0, 4)}-${String(n).padStart(4, "0")}`;
          const now = serverTimestamp();
          const shipRef = doc(collection(db(), "shipments"));
          tx.set(cRef, { value: n });
          tx.set(shipRef, {
            soNumber, status: "draft", shipType: "direct", partnerEmail: "", partnerName: "", caseId: q.caseId,
            caseNumber: q.caseNumber || null, quoteId: q.id, estNo: q.estNo || "",
            company: dl.company, officeName: dl.officeName, postal: dl.postalCode, address: dl.address,
            contactName: dl.contactName, phone: dl.phone, items: shipmentItemsFromQuote(P, q),
            subsidyCategory: q.plan || null, subsidyQty: subsidyQtyFromItems(q.items, P.SKU.BT),
            preferredDate: preferredDate || "", payMethod: payKey, orderNote: memo,
            shippingMethod: "manual", shippingFee: 0, shippingLabel: "", shipDate: todayJst(),
            createdAt: now, createdBy: `staff（${CHANNEL_LABEL[channel] || "その他の方法"}の申込）: ${u.email}`,
          });
          tx.update(qRef, {
            status: "accepted", acceptedAt: now, shipmentId: shipRef.id, shipmentNo: soNumber,
            acceptedBy: name, payMethod: payKey, delivery: dl,
            acceptedVia: "staff", acceptedChannel: channel, acceptedReceivedDate: receivedDate,
            acceptedByStaff: u.email, agreedName: name, agreedPolicy: null,
          });
          const stp = caseStatusOnAccept(kase && kase.status);
          const cu = { updatedAt: now, shipmentId: shipRef.id, payMethod: payKey, orderedVia: "staff", orderConfirmedAt: now, orderConfirmedBy: u.email };
          if (stp.status != null) cu.status = stp.status;
          if (stp.reopenedFrom) Object.assign(cu, { reopenedFrom: stp.reopenedFrom, reopenedAt: now });
          if (!(kase && kase.orderedAt)) cu.orderedAt = Timestamp.fromMillis(jstMidnightMs(receivedDate));
          tx.update(caseRef, cu);
          const re = reopenLabel(stp.reopenedFrom);
          tx.set(doc(collection(db(), "activities")), {
            caseId: q.caseId, type: "memo", occurredAt: now, userId: u.uid || null, userName: u.email,
            subject: `${CHANNEL_LABEL[channel] || "その他の方法"}で受けたお申し込みを受注確定にしました（${q.estNo || "見積"}・出荷 ${soNumber}${re ? `・${re}` : ""}）`,
            body: `申込者: ${name}\n受付方法: ${STAFF_ACCEPT_CHANNELS[channel]}\n受付日: ${receivedDate}\n支払方法: ${PAY_LABELS[payKey]}\n`
              + `出荷 ${soNumber} の下書きを作成\n` + (stp.status != null ? "" : `案件の状態は据え置き（${kase && kase.status}）\n`)
              + (preferredDate ? `ご希望日: ${preferredDate}\n` : "") + (memo ? `メモ: ${memo}\n` : ""),
            attachmentUrls: [],
          });
          return { q, soNumber, shipRefId: shipRef.id, caseContactEmail: (kase && kase.contactEmail) || "" };
        });
        done.push({ ...r, quoteId: pq.id });
      } catch (e) {
        errors.push({ quoteId: pq.id, code: e.code || "error", message: e.message || String(e) });
      }
    }
    if (!done.length) throw fail(errors.map((e) => e.message).join("／"));
    let mailed = false, mailError = null;
    const to = String(done[0].caseContactEmail || done[0].q.contactEmail || "").trim();
    if (sendMail && !to) mailError = "宛先のメールアドレスが案件にも見積もりにも登録されていないため、確認メールは送っていません";
    if (sendMail && to) {
      for (const r of done) await activity(r.q.caseId, "gmail_sent", `メール送信: 【NPO法人タダカヨ】お申し込みを受け付けました（${r.q.estNo}）`, `${PRACTICE_NOTE}\n宛先: ${to}（受注確定の確認メール）`);
      await logSent("staffAccept", { to, quoteIds: done.map((r) => r.quoteId), channel });
      mailed = true;
    }
    await logSent("staffAcceptChat", { quoteIds: done.map((r) => r.quoteId), channel });
    showPracticeNotice(mailed ? `受注確定にしました。確認メール・Chat は送っていません（宛先 ${to}）` : "受注確定にしました。Chat の通知は送っていません");
    return {
      ok: true, results: done.map((r) => ({ quoteId: r.quoteId, shipmentId: r.shipRefId, soNumber: r.soNumber })),
      partial: errors.length > 0, errors, mailed, mailError,
    };
  },

  // 日次まとめのプレビュー（設定画面・管理者）。本物は本番の案件を読んで本文を作る。
  // 練習中は本番のデータを読まないので、練習であることを示す本文だけを返す（形は本物と同じ {overall, assignees}）
  async previewDailyFollowup() {
    showPracticeNotice("日次まとめのプレビューは練習中は本番のデータを読みません");
    return {
      overall: "（練習モード）日次まとめのプレビューは、本番の案件データから作ります。練習中は本番のデータを読まないため表示しません。\n本番モードに戻ってから押してください。毎朝の投稿も本番の案件だけが対象で、練習用のデータは載りません。",
      assignees: [],
    };
  },

  // 事業所の編集（functions/index.js の updateOffice と同じ記録）。名前を変えたら案件の写しも直す
  async updateOffice(data) {
    const { officeId, patch } = data;
    if (!officeId || typeof officeId !== "string") throw oErr("invalid-argument", "officeId は必須です");
    const v = validatePatch(patch);
    if (!v.ok) throw oErr("invalid-argument", v.error);
    const p = v.patch;
    const ref = doc(db(), "offices", officeId);
    const { lockId, datas } = await lockOffices([officeId], "update", (d) => {
      const cur = d[officeId];
      if (!cur) throw oErr("not-found", "事業所が見つかりません");
      if (cur.mergedInto) throw oErr("failed-precondition", "統合済みの事業所は編集できません（残す側の事業所を編集してください）");
      return null;
    });
    try {
      const o = datas[officeId];
      const oldName = o.officeName || "", oldCorp = o.corpName || "";
      const newName = "officeName" in p ? p.officeName : oldName;
      const newCorp = "corpName" in p ? p.corpName : oldCorp;
      const nameChanged = newName !== oldName, corpChanged = newCorp !== oldCorp;
      const u = me();
      let casesUpdated = 0;
      if (nameChanged || corpChanged) {
        const cs = await getDocs(query(collection(db(), "cases"), where("officeId", "==", officeId)));
        const targets = cs.docs.filter((d) => (d.data().officeName || "") !== newName || (d.data().corpName || "") !== newCorp);
        for (let i = 0; i < targets.length; i += OFFICE_CASE_CHUNK) {
          const batch = writeBatch(db());
          for (const d of targets.slice(i, i + OFFICE_CASE_CHUNK)) {
            batch.update(d.ref, { officeName: newName, corpName: newCorp, updatedAt: serverTimestamp() });
            if (nameChanged && (d.data().officeName || "") !== newName) {
              officeActivity(batch, d.id, `事業所名を変更：${oldName || "（事業所名なし）"} → ${newName}（${u.name}）`,
                `事業所画面で事業所名を変更したため、この案件の事業所名の表示も変えました（実行者: ${u.name}）。`);
            }
          }
          await batch.commit();
        }
        casesUpdated = targets.length;
      }
      const upd = { ...p, updatedAt: serverTimestamp(), updatedBy: u.email };
      if (nameChanged) upd.aliases = buildAliases({ aliases: o.aliases, officeName: oldName }, {}, newName);
      if ("address" in p && p.address !== String(o.address || "").trim()) Object.assign(upd, splitOfficeAddress(p.address));
      await updateDoc(ref, { ...upd, opLock: deleteField() });
      showPracticeNotice(`事業所を直しました（案件 ${casesUpdated} 件の表示名も更新）`);
      return { ok: true, casesUpdated };
    } finally {
      await unlockOffices([officeId], lockId);
    }
  },

  // 事業所の統合（from を to にまとめる）。途中で止まっても、同じ fromId・toId でもう一度呼べば続きから終わる
  // （続きのときは keep を見ない）。取り消し用の記録は offices/{fromId}/mergeLog に分けて残す
  async mergeOffices(data) {
    const { fromId, toId, keep } = data;
    const c0 = checkMerge(null, null, fromId, toId);
    if (!c0.ok && c0.code === "invalid-argument") throw oErr(c0.code, c0.error);
    const k = keep == null ? {} : keep;
    if (typeof k !== "object" || Array.isArray(k)) throw oErr("invalid-argument", "残す値の指定（keep）の形が正しくありません");
    for (const [f, side] of Object.entries(k)) {
      if (!OFFICE_EDIT_FIELDS.includes(f)) throw oErr("invalid-argument", `この項目は指定できません: ${f}`);
      if (side !== "from" && side !== "to") throw oErr("invalid-argument", `${f} の残す側は "from" か "to" で指定してください`);
    }
    let total = 0;
    for (const col of OFFICE_REF_COLLS) total += (await idsByOffice(col, fromId)).length;
    if (total > OFFICE_MERGE_MAX_REFS) throw oErr("failed-precondition", `付け替える記録が多すぎます（${total}件・上限${OFFICE_MERGE_MAX_REFS}件）。管理者に相談してください`);

    const u = me();
    const fromRef = doc(db(), "offices", fromId), toRef = doc(db(), "offices", toId);
    let resumed = false;
    // この事業所へ統合中の事業所の候補。ブラウザ用 SDK の tx.get() は Query を受け取れないので、
    // 候補はトランザクションの外で集め、中では1件ずつ文書として読み直して確かめる（Codex 指摘・2026-10-24）
    const incIds = (await getDocs(query(collection(db(), "offices"), where("mergedInto", "==", fromId)))).docs.map((x) => x.id);
    const { lockId } = await lockOffices([fromId, toId], "merge", async (d, tx) => {
      const from = d[fromId], to = d[toId];
      const chk = checkMerge(from, to, fromId, toId);
      if (!chk.ok) throw oErr(chk.code, chk.error);
      const inc = [];
      for (const id of incIds) inc.push(await tx.get(doc(db(), "offices", id)));
      if (inc.some((x) => x.exists() && x.data().mergedInto === fromId && x.data().mergeStatus === "running")) {
        throw oErr("failed-precondition", "この事業所へ統合する処理が途中のままです。先にそちらの統合を完了させてください");
      }
      if (chk.resume) { resumed = true; return null; }
      const kept = resolveKeep(from, to, k);
      const toUpd = { ...kept, aliases: buildAliases(to, from, kept.officeName), updatedAt: serverTimestamp(), updatedBy: u.email };
      if (kept.address !== String(to.address || "").trim()) {
        const fromHasParts = from.prefecture || from.city || from.addressDetail;
        Object.assign(toUpd, kept.address === String(from.address || "").trim() && fromHasParts
          ? pickOfficeFields(from, OFFICE_ADDR_PARTS)
          : splitOfficeAddress(kept.address));
      }
      const before = { ...pickOfficeFields(to, [...OFFICE_EDIT_FIELDS, ...OFFICE_ADDR_PARTS]), aliases: Array.isArray(to.aliases) ? to.aliases : [] };
      const wrote = pickOfficeFields({ ...to, ...toUpd }, [...OFFICE_EDIT_FIELDS, ...OFFICE_ADDR_PARTS]);
      return {
        [toId]: toUpd,
        [fromId]: {
          mergedInto: toId, mergeStatus: "running", mergedAt: serverTimestamp(), mergedBy: u.email, mergedByName: u.name,
          archived: true, archivedBeforeMerge: from.archived === true,
          mergeRunId: newToken(), mergeCounts: { cases: 0, quotes: 0, shipments: 0, leadTokens: 0, toCases: 0 },
          mergeToBefore: before, mergeWrote: wrote,
        },
      };
    });
    try {
      const [fromNow, toNow] = await Promise.all([getDoc(fromRef), getDoc(toRef)]);
      const F = fromNow.data(), T = toNow.data();
      const runId = F.mergeRunId;
      if (!runId) throw oErr("failed-precondition", "統合の記録（mergeRunId）がありません。管理者に相談してください");
      const fromName = F.officeName || "";
      const finalName = T.officeName || "", finalCorp = T.corpName || "";
      const logRef = () => doc(collection(db(), "offices", fromId, "mergeLog"));

      // to にもともとあった案件の写しも直す（名前・法人名が統合で変わったとき）
      const before = F.mergeToBefore || {};
      if (F.mergeToBefore && ((before.officeName || "") !== finalName || (before.corpName || "") !== finalCorp)) {
        const nameChanged = (before.officeName || "") !== finalName;
        const snap = await getDocs(query(collection(db(), "cases"), where("officeId", "==", toId)));
        const targets = snap.docs.filter((d) => (d.data().officeName || "") !== finalName || (d.data().corpName || "") !== finalCorp);
        for (let i = 0; i < targets.length; i += OFFICE_CASE_CHUNK) {
          const part = targets.slice(i, i + OFFICE_CASE_CHUNK);
          const batch = writeBatch(db());
          const snaps = {};
          for (const d of part) {
            const c = d.data();
            snaps[d.id] = { officeName: c.officeName || "", corpName: c.corpName || "" };
            batch.update(d.ref, { officeName: finalName, corpName: finalCorp, updatedAt: serverTimestamp() });
            if (nameChanged && (c.officeName || "") !== finalName) {
              officeActivity(batch, d.id, `事業所名を変更（統合）：${c.officeName || "（事業所名なし）"} → ${finalName}（${u.name}）`,
                `「${fromName}」との統合で事業所名を「${finalName}」にしたため、この案件の事業所名の表示も変えました（実行者: ${u.name}）。`);
            }
          }
          batch.set(logRef(), { runId, kind: "toCases", ids: part.map((d) => d.id), snapshots: snaps, at: serverTimestamp() });
          batch.update(fromRef, { "mergeCounts.toCases": increment(part.length) });
          await batch.commit();
        }
      }

      for (let round = 0; round < 3; round++) {
        let movedAny = false;
        for (const col of OFFICE_REF_COLLS) {
          const snap = await getDocs(query(collection(db(), col), where("officeId", "==", fromId)));
          if (snap.empty) continue;
          movedAny = true;
          const chunk = col === "cases" ? OFFICE_CASE_CHUNK : OFFICE_BATCH_LIMIT - 2;
          for (let i = 0; i < snap.docs.length; i += chunk) {
            const part = snap.docs.slice(i, i + chunk);
            const batch = writeBatch(db());
            const log = { runId, kind: col, ids: part.map((d) => d.id), at: serverTimestamp() };
            if (col === "cases") log.snapshots = {};
            for (const d of part) {
              if (col === "cases") {
                const c = d.data();
                log.snapshots[d.id] = { officeName: c.officeName || "", corpName: c.corpName || "" };
                batch.update(d.ref, { officeId: toId, officeName: finalName, corpName: finalCorp, updatedAt: serverTimestamp() });
                officeActivity(batch, d.id, `事業所を統合：${fromName || "（事業所名なし）"} → ${finalName}（${u.name}）`,
                  `重複していた事業所「${fromName}」を「${finalName}」に統合したため、この案件の事業所を付け替えました（実行者: ${u.name}）。`);
              } else {
                batch.update(d.ref, { officeId: toId }); // 発行済みの書類の宛名は変えない
              }
            }
            batch.set(logRef(), log);
            batch.update(fromRef, { [`mergeCounts.${col}`]: increment(part.length) });
            await batch.commit();
          }
        }
        if (!movedAny) break;
      }
      await updateDoc(fromRef, { mergeStatus: "done", mergeDoneAt: serverTimestamp() });
      const counts = (await getDoc(fromRef)).data().mergeCounts || {};
      const moved = {};
      for (const col of OFFICE_REF_COLLS) moved[col] = Number(counts[col]) || 0;
      showPracticeNotice("事業所を統合しました（「統合を取り消す」で戻せます）");
      return { ok: true, moved, toCasesRenamed: Number(counts.toCases) || 0, resumed };
    } finally {
      await unlockOffices([fromId, toId], lockId);
    }
  },

  // 統合の取り消し。統合のあとに別の事業所へ動かしたものは触らない。
  // 残す側は、統合のあと編集されていなければ統合前に戻す（canRestoreTo）
  async unmergeOffice(data) {
    const { fromId } = data;
    if (!fromId || typeof fromId !== "string") throw oErr("invalid-argument", "fromId は必須です");
    const fromRef = doc(db(), "offices", fromId);
    const pre = await getDoc(fromRef);
    if (!pre.exists()) throw oErr("not-found", "事業所が見つかりません");
    if (!pre.data().mergedInto) throw oErr("failed-precondition", "この事業所は統合されていません");
    const toId = String(pre.data().mergedInto);
    const toRef = doc(db(), "offices", toId);
    const { lockId, datas } = await lockOffices([fromId, toId], "unmerge", (d) => {
      const f = d[fromId], t = d[toId];
      if (!f) throw oErr("not-found", "事業所が見つかりません");
      if (f.mergedInto !== toId) throw oErr("failed-precondition", "統合の状態が変わりました。画面を読み直してください");
      if (f.mergeStatus !== "done") throw oErr("failed-precondition", "統合の処理が途中です。もう一度統合を実行して完了させてから取り消してください");
      if (t && t.mergedInto) throw oErr("failed-precondition", "統合先の事業所がさらに別の事業所に統合されています。先にそちらを取り消してください");
      return null;
    });
    try {
      const from = datas[fromId], to = datas[toId];
      const runId = from.mergeRunId;
      if (!runId) throw oErr("failed-precondition", "取り消しに使う統合の記録がありません（古い形式の統合です）。管理者に相談してください");
      const fromName = from.officeName || "", fromCorp = from.corpName || "";
      const toName = to ? (to.officeName || "") : "";
      const u = me();
      const logs = await getDocs(query(collection(db(), "offices", fromId, "mergeLog"), where("runId", "==", runId)));
      const idsOf = {}, snaps = {};
      for (const kd of [...OFFICE_REF_COLLS, "toCases"]) { idsOf[kd] = []; snaps[kd] = {}; }
      for (const l of logs.docs) {
        const L = l.data();
        if (!idsOf[L.kind]) continue;
        for (const id of Array.isArray(L.ids) ? L.ids : []) if (typeof id === "string" && id) idsOf[L.kind].push(id);
        Object.assign(snaps[L.kind], L.snapshots || {});
      }
      const readOfficeIds = async (col, ids) => {
        const cur = new Map(), docs = new Map();
        for (const id of ids) {
          const sn = await getDoc(doc(db(), col, id));
          if (sn.exists()) { cur.set(id, sn.data().officeId); docs.set(id, sn); }
        }
        return { cur, docs };
      };
      const plan = {};
      let totalRefs = 0, totalBack = 0, alreadyBack = 0;
      for (const col of OFFICE_REF_COLLS) {
        const ids = [...new Set(idsOf[col])];
        const { cur, docs } = await readOfficeIds(col, ids);
        const back = pickRestorable(ids, cur, toId);
        plan[col] = { back, docs };
        totalRefs += ids.length; totalBack += back.length;
        alreadyBack += ids.filter((id) => cur.get(id) === fromId).length;
      }
      if (totalRefs > 0 && totalBack === 0 && alreadyBack === 0) {
        throw oErr("failed-precondition", "戻せる案件・書類がありません（統合のあとに、すべて別の事業所へ動いています）。取り消しは行っていません");
      }
      const restored = {};
      for (const col of OFFICE_REF_COLLS) {
        const { back, docs } = plan[col];
        const chunk = col === "cases" ? OFFICE_CASE_CHUNK : OFFICE_BATCH_LIMIT;
        for (let i = 0; i < back.length; i += chunk) {
          const batch = writeBatch(db());
          for (const id of back.slice(i, i + chunk)) {
            const ref = docs.get(id).ref;
            if (col === "cases") {
              const sn = snaps.cases[id] || {};
              batch.update(ref, {
                officeId: fromId,
                officeName: typeof sn.officeName === "string" ? sn.officeName : fromName,
                corpName: typeof sn.corpName === "string" ? sn.corpName : fromCorp,
                updatedAt: serverTimestamp(),
              });
              officeActivity(batch, id, `事業所の統合を取り消し：${toName || "（事業所名なし）"} → ${fromName}（${u.name}）`,
                `事業所「${fromName}」の「${toName}」への統合を取り消したため、この案件の事業所を元に戻しました（実行者: ${u.name}）。`);
            } else {
              batch.update(ref, { officeId: fromId });
            }
          }
          await batch.commit();
        }
        restored[col] = back.length;
      }
      let toRestored = false, toCasesRestored = 0, note = "";
      const wrote = from.mergeWrote || null, before = from.mergeToBefore || null;
      if (to && before && canRestoreTo(to, wrote)) {
        // 本番（functions/index.js unmergeOffice）と同じ: to の名前を戻すときは、いま to にある案件すべての写しを戻した値にそろえる
        // （統合で直した案件だけ戻すと、あとから別の統合で入った案件が統合の名前のまま残る）
        const bName = before.officeName || "", bCorp = before.corpName || "";
        if (bName !== (wrote.officeName || "") || bCorp !== (wrote.corpName || "")) {
          const tsnap = await getDocs(query(collection(db(), "cases"), where("officeId", "==", toId)));
          const backTo = tsnap.docs.filter((d) => (d.data().officeName || "") !== bName || (d.data().corpName || "") !== bCorp);
          for (let i = 0; i < backTo.length; i += OFFICE_CASE_CHUNK) {
            const batch = writeBatch(db());
            for (const d of backTo.slice(i, i + OFFICE_CASE_CHUNK)) {
              const c = d.data();
              batch.update(d.ref, { officeName: bName, corpName: bCorp, updatedAt: serverTimestamp() });
              if ((c.officeName || "") !== bName) {
                officeActivity(batch, d.id, `事業所名を戻す（統合の取り消し）：${c.officeName || "（事業所名なし）"} → ${bName}（${u.name}）`,
                  `「${fromName}」との統合を取り消したため、この案件の事業所名の表示を統合前に戻しました（実行者: ${u.name}）。`);
              }
            }
            await batch.commit();
          }
          toCasesRestored = backTo.length;
        }
        const back = {};
        for (const f of [...OFFICE_EDIT_FIELDS, ...OFFICE_ADDR_PARTS]) back[f] = before[f] == null ? "" : before[f];
        await updateDoc(toRef, { ...back, updatedAt: serverTimestamp(), updatedBy: u.email });
        toRestored = true;
      } else if (to) {
        note = "残す側の事業所は統合のあとに編集されているため、事業所名・住所などは統合前に戻していません";
      }
      const del = deleteField();
      await updateDoc(fromRef, {
        mergedInto: del, mergeStatus: del, mergedAt: del, mergedBy: del, mergedByName: del, mergeDoneAt: del,
        mergeRunId: del, mergeCounts: del, mergeToBefore: del, mergeWrote: del, archivedBeforeMerge: del,
        archived: from.archivedBeforeMerge === true ? true : del,
        unmergedAt: serverTimestamp(), unmergedBy: u.email,
        lastUnmerge: { toId, runId, mergedAt: from.mergedAt || null, mergedBy: from.mergedBy || null, restored, toRestored },
        updatedAt: serverTimestamp(),
      });
      showPracticeNotice("統合を取り消しました");
      return { ok: true, restored, toRestored, toCasesRestored, note };
    } finally {
      await unlockOffices([fromId, toId], lockId);
    }
  },

  // アクセス解析の手動更新（GA4 の取り込み）
  async collectAnalyticsNow() {
    showPracticeNotice("アクセス解析の更新は練習中は行いません");
    return { skipped: "練習モードでは更新しません" };
  },
};
