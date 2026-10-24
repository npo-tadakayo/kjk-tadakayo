// functions/accept-flow.js — index.js の結線（受注確定・担当通知・承諾書通知・日次まとめ・認可）の判定部分（純粋関数・CommonJS）。
// Firestore・fetch には触れない。index.js が読んだ値を渡して呼ぶ。
// 設計: docs/CRM改善_設計_20261021.md §3（N1〜N4）・§4（Callable の認可）・§5（A）。テスト: node scripts/test-functions-wiring.mjs
"use strict";

// 案件の状態（admin/js/constants.js と同じ番号）
const ST_NEW = 1, ST_CONFIRMING = 2, ST_ORDERED = 3, ST_LOST = 4, ST_DONE = 13;

// ===== 認可（requireStaff の判定部分）=====
// allow: "viewer"（登録済み・有効なら誰でも）／"editor"（閲覧のみ以外）／"admin"（管理者のみ）／
//        "warehouse"（倉庫の画面の Callable。倉庫の人と、管理者・スタッフ・ロール未設定の登録者）
// firestore.rules の isRegistered / isEditor / isAdmin と同じ考え方。
// 2026-10-24 倉庫（設計 docs/倉庫メニュー_設計_20261024.md §9.1）: 倉庫の人（role "warehouse"）は
// "viewer"／"editor"／"admin" のどれでも通さない（従来の「閲覧のみ以外は editor」のままだと、倉庫の人が全 Callable を使えてしまう）。
// 倉庫の人が使えるのは "warehouse" の指定だけ。保管場所ごとの権限は index.js の requireWarehouse（canUseLocation）で見る。
function roleAllows(user, allow = "editor") {
  if (!user || user.active !== true) return false;
  if (user.role === "trainee") return false; // 練習生は本番の操作をどれもできない（2026-10-20 テストモード）
  if (allow === "warehouse") {
    const role = user.role == null ? "" : user.role;
    return role === "warehouse" || role === "admin" || role === "staff" || role === "";
  }
  if (user.role === "warehouse") return false; // 倉庫の人は倉庫の Callable だけ（上の "warehouse"）
  if (allow === "admin") return user.role === "admin";
  if (allow === "editor") return user.role !== "viewer";
  if (allow === "viewer") return true;
  return false; // 不明な指定は通さない（fail-secure）
}

// ===== 受注確定（A）=====

/**
 * 受注確定で案件の状態をどうするか。
 * 1・2（未設定も 1 扱い）→ 3 にする／3 と 5〜12 → 据え置き（null）／
 * 4（失注）・13（完了）→ 再申込として受け付け、3 に戻す（reopenedFrom に元の状態）。2026-10-21 レビュー指摘 4（以前は拒否）。
 * @returns {{ok:true, status:number|null, reopenedFrom:number|null}}
 */
function caseStatusOnAccept(status) {
  const st = Number(status) || ST_NEW;
  if (st === ST_LOST || st === ST_DONE) return { ok: true, status: ST_ORDERED, reopenedFrom: st };
  if (st === ST_NEW || st === ST_CONFIRMING) return { ok: true, status: ST_ORDERED, reopenedFrom: null };
  return { ok: true, status: null, reopenedFrom: null };
}

/** 再申込で案件を再開したときの活動の件名に足す文言。再開でなければ "" */
function reopenLabel(reopenedFrom) {
  if (Number(reopenedFrom) === ST_LOST) return "再申込で再開（失注から）";
  if (Number(reopenedFrom) === ST_DONE) return "再申込で再開（完了から）";
  return "";
}

/**
 * スタッフ経路で案件に書く orderedAt（ミリ秒）。案件にすでに orderedAt があれば null（上書きしない・Web と同じ）。
 * 無ければ受付日（JST 0 時）。2026-10-21 レビュー指摘 5。
 */
function staffOrderedAtMs(kase, receivedDate) {
  if (kase && kase.orderedAt) return null;
  return jstMidnightMs(receivedDate);
}

/** 見積もりの明細 → 出荷の subsidyQty {bt, usb}（補助対象の台数。BT 以外は USB に数える） */
function subsidyQtyFromItems(items, btSku) {
  const list = Array.isArray(items) ? items : [];
  const sum = (arr) => arr.reduce((a, i) => a + (Number(i && i.subsidyQty) || 0), 0);
  return {
    bt: sum(list.filter((i) => i && i.sku === btSku)),
    usb: sum(list.filter((i) => i && i.sku !== btSku)),
  };
}

/**
 * 申込の内容から決まる出荷の項目（新規作成と使い直しで同じものを書く）。2026-10-21 レビュー指摘 1。
 * 状態・番号・出荷元（shipType・partner・shippingMethod 等）・作成日時・出荷日は「出荷の段取り」の項目なので含めない
 * （使い直しのとき、スタッフが進めた段取りを申込で巻き戻さないため）。
 * @param {object} p
 * @param {object} p.q            見積もり（id・caseNumber・estNo・corpName・officeName・contactName・plan・items）
 * @param {object} p.delivery     届け先（company・officeName・postalCode・address・contactName・phone）
 * @param {object[]} p.shipItems  出荷の明細（shipmentItemsFromQuote の結果）
 * @param {string} p.btSku        BT の品番（Pricing.SKU.BT）
 */
function shipmentFieldsFromAccept({ q, delivery, shipItems, btSku, preferredDate, payKey, note } = {}) {
  const d = delivery || {}, qq = q || {};
  return {
    caseNumber: qq.caseNumber || null, quoteId: qq.id, estNo: qq.estNo || "",
    company: d.company || qq.corpName || "", officeName: d.officeName || qq.officeName || "",
    postal: d.postalCode || "", address: d.address || "",
    contactName: d.contactName || qq.contactName || "", phone: d.phone || "",
    items: shipItems || [],
    // CRM「送付先・数量を直す」の伴走支援費ブロックが復元に使う（2026-09-14）
    subsidyCategory: qq.plan || null,
    subsidyQty: subsidyQtyFromItems(qq.items, btSku),
    preferredDate: preferredDate || "", payMethod: payKey,
    orderNote: String(note || "").slice(0, 1000),
  };
}

const PRE_SHIP = ["draft", "requested"];
const shipStatusOf = (s) => (s && s.status) || "shipped"; // 未設定は発送済扱い（admin/js/ship-flow.js と同じ）

/**
 * Web の申込で、既存の出荷をどう扱うか。
 * - 生きている draft/requested があれば新しく作らず、それを使い直す（cases.shipmentId と同じものを優先）
 * - それが無く、発送済以降（shipped/invoiced/paid）があれば、作成は続けるが duplicateWarning を立てる
 * @param {object[]} shipments  同じ案件の出荷（id・status・soNumber）
 * @param {string|null} preferredId  cases.shipmentId
 * @returns {{reuse:object|null, duplicateWarning:boolean, existingNos:string[]}}
 */
function planWebShipment(shipments, preferredId = null) {
  const live = (shipments || []).filter((s) => s && shipStatusOf(s) !== "canceled");
  const pre = live.filter((s) => PRE_SHIP.includes(shipStatusOf(s)));
  // 請求先を認定事業者（dropship）に変えた出荷は使い直さない。見積の単価は税込、認定事業者向けの明細は税抜として
  // 扱われるため、上書きすると請求額が過大になる（2026-10-21 Codex 指摘）。新しい下書きを作り、重複の印を付ける
  const reusable = pre.filter((s) => (s.shipType || "direct") !== "dropship");
  if (reusable.length) {
    const reuse = reusable.find((s) => preferredId && s.id === preferredId)
      || reusable.find((s) => shipStatusOf(s) === "requested") // 依頼済み（センターへ投稿済み）を優先
      || reusable[0];
    return { reuse, duplicateWarning: false, existingNos: [], extraPre: pre.length - 1 };
  }
  const others = live.filter((s) => !reusable.includes(s));
  return { reuse: null, duplicateWarning: others.length > 0, existingNos: others.map((s) => s.soNumber).filter(Boolean), extraPre: 0 };
}

/** "YYYY-MM-DD"（JST の日付）→ その日の JST 0 時のミリ秒。不正なら null。 */
function jstMidnightMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3600000;
  // 2026-02-30 のような存在しない日は弾く
  const back = new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
  return back === ymd ? ms : null;
}

/** Date → JST の "YYYY-MM-DD" */
function jstYmd(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

// 受付方法の表示（accept-rules.js の STAFF_ACCEPT_CHANNELS と同じキー）
const CHANNEL_LABEL = { phone: "電話", email: "メール", fax: "FAX", other: "その他の方法" };
const CHANNEL_EMOJI = { phone: "📞", email: "📧", fax: "📠", other: "📝" };

/**
 * スタッフ受注の活動の件名。例「電話で受けたお申し込みを受注確定にしました（EST-2026-0001・出荷 SH-2026-0012）」
 * 失注・完了からの再開は末尾に「・再申込で再開（失注から）」を足す。
 */
function staffAcceptSubject(channel, estNo, soNumber, reused = false, reopenedFrom = null) {
  const how = CHANNEL_LABEL[channel] || "その他の方法";
  const ship = soNumber ? `・出荷 ${soNumber}${reused ? "（既存の下書きを使用）" : ""}` : "";
  const re = reopenLabel(reopenedFrom);
  return `${how}で受けたお申し込みを受注確定にしました（${estNo || "見積"}${ship}${re ? `・${re}` : ""}）`;
}

/** Web の申込の活動の件名。再開なら「・再申込で再開（…から）」を足す */
function webAcceptSubject(estNo, soNumber, reused = false, reopenedFrom = null) {
  const ship = reused ? `既存の出荷 ${soNumber} を更新` : `出荷 ${soNumber} の下書きを作成`;
  const re = reopenLabel(reopenedFrom);
  return `お申し込みを受け付けました（${estNo || "見積"}・${ship}${re ? `・${re}` : ""}）`;
}

/** スタッフ受注の出荷の createdBy */
function staffCreatedBy(channel, email) {
  return `staff（${CHANNEL_LABEL[channel] || "その他の方法"}の申込）: ${email}`;
}

/** スタッフ受注の Chat の見出し。例「📞 電話で受けたお申し込みを受注確定にしました（操作: 次田）」 */
function staffAcceptChatHead(channel, operatorName) {
  const how = CHANNEL_LABEL[channel] || "その他の方法";
  return `${CHANNEL_EMOJI[channel] || "📝"} ${how}で受けたお申し込みを受注確定にしました（操作: ${String(operatorName || "").replace(/[<>*_~`]/g, "")}）`;
}

/**
 * 受注確定の対象の事前確認（tx の前）。quotes[0] が画面で選んだ見積もり、残りが groupQuoteIds の見積もり。
 * - 1件だけ（groupQuoteIds が空）… 存在すれば通す（グループでなくてよい。状態の確認は tx の checkStaffAccept）
 * - 複数 … 全件が存在し、同じ groupId（空でない）で、issued であること
 *   対象の見積もりに groupId が無いのに groupQuoteIds があるときは「グループではありません」で拒否（2026-10-21 レビュー指摘 7）
 * @param {object[]} quotes  [{id, groupId, status}]（存在しないものは null）
 */
function checkAcceptGroup(quotes, ids) {
  if (!Array.isArray(quotes) || !quotes.length) return { ok: false, message: "見積もりが指定されていません" };
  const missing = quotes.findIndex((q) => !q);
  if (missing >= 0) return { ok: false, message: `見積もりが見つかりません（${ids ? ids[missing] : missing}）` };
  if (quotes.length === 1) return { ok: true, groupId: quotes[0].groupId || null };
  const gid = quotes[0].groupId || null;
  if (!gid) {
    return { ok: false, message: "この見積もりはグループ（同じ法人の一括見積もり）ではありません。ほかの見積もりと一緒には受注確定にできないので、1件ずつ受注確定にしてください" };
  }
  const others = quotes.filter((q) => (q.groupId || null) !== gid);
  if (others.length) {
    return { ok: false, message: `同じグループ（同じ法人の一括見積もり）ではない見積もりが含まれています（${others.map((q) => q.estNo || q.id).join("・")}）` };
  }
  const notIssued = quotes.filter((q) => q.status !== "issued");
  if (notIssued.length) {
    return { ok: false, message: `発行中ではない見積もりが含まれています（${notIssued.map((q) => q.estNo || q.id).join("・")}）` };
  }
  return { ok: true, groupId: gid };
}

// ※ inheritShipmentRef（新しい版へ shipmentId/shipmentNo を引き継ぐ）は 2026-10-21 レビュー指摘 3 で廃止。
//   申込のトランザクションが案件の出荷を使い直すので不要で、残すと未申込の版の reviseQuote が出荷の下書きを上書きしていた。

// ===== N1 担当が決まったら本人に通知 =====
const emailKey = (e) => String(e || "").trim().toLowerCase();

/**
 * onCaseAssigned の発火条件（担当が変わった・空でない・対象外でない・統合元でない・画面の担当保存である）。
 * 「画面からの担当変更」と「統合による書き換え」は assignedAt が before→after で変わったかで見分ける（司令塔との約束 2026-10-21）。
 * 画面の saveAssignee は担当を変えるたびに assignedBy と assignedAt（serverTimestamp）を必ず書く。
 * 統合（case-detail.js mergeInto）は担当を写すだけで assignedAt を書かないので、古い assignedBy が残っていても通知しない。
 * ⚠️ 画面以外（Claude の crm スキル等）で担当を変えるときも assignedBy・assignedAt を書かないと通知されない。
 */
function shouldNotifyAssign(before, after) {
  const b = before || {}, a = after || {};
  const to = emailKey(a.assignedUserId);
  if (!to) return false;                       // 担当を外した
  if (emailKey(b.assignedUserId) === to) return false; // 変わっていない
  if (a.archived) return false;                 // 対象外（統合元もここに入る）
  if (a.mergedInto) return false;               // 統合元
  if (!assignedAtChanged(b, a)) return false;   // 統合などで担当だけ書き換わった
  return true;
}

function tsKey(v) {
  if (v == null) return "";
  if (typeof v.toMillis === "function") return String(v.toMillis());
  if (v instanceof Date) return String(v.getTime());
  return String(v);
}
/** assignedAt が今回の更新で変わったか（Timestamp の比較）。after に無ければ false */
function assignedAtChanged(before, after) {
  const a = tsKey((after || {}).assignedAt);
  return a !== "" && a !== tsKey((before || {}).assignedAt);
}

// ===== N4 承諾書の署名完了 =====
/** onConsentSigned の発火条件（pending → signed・オンライン署名・案件あり） */
function shouldNotifyConsent(before, after) {
  const b = before || {}, a = after || {};
  return b.status === "pending" && a.status === "signed"
    && !!a.signed && a.signed.method === "web" && !!a.caseId;
}

// ===== N2・N3 日次まとめ =====
/**
 * 日次まとめの投稿計画（全体1通＋担当ごと1通）。投稿はしない。
 * @param {object} nt  notify-text.mjs のモジュール（import() の結果）
 * @param {{cases:object[], users:object[], settings:object, now?:Date, regionOf?:Function}} p
 *   users は {email(=doc id), name, displayName, chatUserId, ...}
 * @returns {{overall:string|null, assignees:{email:string, name:string, text:string}[]}}
 */
function planDailyPosts(nt, { cases, users, settings, now = new Date(), regionOf } = {}) {
  const cls = nt.classifyCases(cases || [], { now, deadline: nt.resolveDeadline(settings || {}) });
  let overall = nt.buildOverallDigest(cls, { regionOf });
  if (!nt.holidaysCover(now)) {
    const warn = `⚠️ 祝日の表に ${jstYmd(now).slice(0, 4)} 年の分がありません（初期連絡の超過が早めに出ます）。functions/first-contact.mjs と admin/js/first-contact.js に追記してください`;
    overall = overall ? `${overall}\n\n${warn}` : warn;
  }
  const userMap = new Map((users || []).map((u) => [emailKey(u.email || u.id || u._id), u]));
  const assignees = [];
  for (const [key, bucket] of Object.entries(cls.assignees || {})) {
    const u = userMap.get(key);
    const user = u ? { ...u, email: u.email || bucket.email } : null;
    const text = nt.buildAssigneeDigest(user, bucket, { regionOf, deadlineDays: cls.deadlineDays });
    if (!text) continue;
    const name = String((u && (u.displayName || u.name)) || bucket.email.split("@")[0]);
    assignees.push({ email: bucket.email, name, text });
  }
  assignees.sort((a, b) => a.name.localeCompare(b.name, "ja") || a.email.localeCompare(b.email));
  return { overall: overall || null, assignees };
}

/** 日次まとめの投稿の並び（全体が先・担当ごとが後。空は除く） */
function dailyPostTexts(plan) {
  return [plan && plan.overall, ...((plan && plan.assignees) || []).map((a) => a.text)].filter(Boolean);
}

/**
 * 日次まとめが途中で例外になったときの _notifyLog/daily_日付 の後始末（2026-10-21 レビュー指摘 8）。
 * - 記録を作っていない … "none"
 * - 1件も投稿していない … "delete"（記録を消して、次の再実行で投稿できるようにする）
 * - 1件以上投稿済み … "partial"（消すと再実行で二重投稿になるので残す）
 */
function dailyFailureAction({ claimed, posted } = {}) {
  if (!claimed) return "none";
  return (Number(posted) || 0) > 0 ? "partial" : "delete";
}

/**
 * 受注確定の確認メールの宛先（2026-10-21 レビュー指摘 6）。案件の contactEmail を優先し、無ければ見積もりの contactEmail。
 * メールアドレスの形でなければ ""。
 */
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function acceptMailTo(caseEmail, quoteEmail) {
  for (const v of [caseEmail, quoteEmail]) {
    const e = String(v || "").trim();
    if (MAIL_RE.test(e)) return e;
  }
  return "";
}

// ===== 出荷指示の投稿と「依頼の取り消し」の競合（2026-10-21 Codex 指摘4）=====
// 依頼のたびに画面が shipments.requestSeq を1増やす。notifyShipment はロックを取るときに requestSeq を控え、
// 投稿後に結果（shipNotifiedAt など）を書くのは「まだ依頼済以上で、requestSeq が控えた値と同じ」ときだけ。
// 投稿中に依頼を取り消して（下書きへ）→ 依頼し直した場合、古い送信が shipNotifiedAt を書き戻すと
// 再依頼の投稿が「投稿済み」とみなされて止まるため。
// ⚠️ statuses は index.js の NOTIFY_STATUSES（admin/js/ship-flow.js と同じ値）を渡す
function requestSeqOf(s) { return Number(s && s.requestSeq) || 0; }
function notifyResultWritable(cur, seqAtLock, statuses) {
  if (!cur) return false;
  if (!(statuses || []).includes(cur.status)) return false;
  return requestSeqOf(cur) === (Number(seqAtLock) || 0);
}
// 出荷に残っているロックが、この送信が付けたものか（Timestamp 同士を比べる）
function ownsNotifyLock(cur, lockTs) {
  const l = cur && cur.shipNotifyLockAt;
  if (!l || !lockTs) return false;
  if (typeof l.isEqual === "function") return l.isEqual(lockTs);
  const ms = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : NaN);
  return ms(l) === ms(lockTs);
}
// 画面の「依頼を取り消す」を止めるか（送信中＝ロックが60秒以内で、まだ投稿済みの印が無い）
function notifyInFlight(s, nowMs = Date.now()) {
  if (!s || s.shipNotifiedAt) return false;
  const l = s.shipNotifyLockAt;
  const ms = l && typeof l.toMillis === "function" ? l.toMillis() : (typeof l === "number" ? l : 0);
  return !!ms && nowMs - ms < 60000;
}

module.exports = {
  requestSeqOf,
  notifyResultWritable,
  notifyInFlight,
  ownsNotifyLock,
  roleAllows,
  caseStatusOnAccept, reopenLabel, staffOrderedAtMs, subsidyQtyFromItems, shipmentFieldsFromAccept,
  planWebShipment, jstMidnightMs, jstYmd,
  CHANNEL_LABEL, staffAcceptSubject, webAcceptSubject, staffCreatedBy, staffAcceptChatHead, checkAcceptGroup,
  acceptMailTo,
  shouldNotifyAssign, assignedAtChanged,
  shouldNotifyConsent,
  planDailyPosts, dailyPostTexts, dailyFailureAction,
};
