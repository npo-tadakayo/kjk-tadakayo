// functions/accept-rules.js — 電話・メール等で受けた申込を、スタッフが「受注確定」にしてよいかの判定（純粋関数・CommonJS）。
// 設計: docs/CRM改善_設計_20261021.md §5（A）・§9 の 8（期限切れは受付日で比べる）。テスト: node scripts/test-accept-rules.mjs
// staffAcceptQuote（index.js）が tx の中で読んだ値を渡して呼ぶ。Firestore には触れない。
"use strict";

// 受付方法（quotes.acceptedChannel に入るコード値 → 表示名）
const STAFF_ACCEPT_CHANNELS = { phone: "電話", email: "メール", fax: "FAX", other: "その他" };

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
// "YYYY-MM-DD" として正しい日付か（2026-02-30 のような存在しない日は不可）
function isValidYmd(s) {
  const m = YMD.exec(String(s || ""));
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.toISOString().slice(0, 10) === s;
}

// 有効期限（Timestamp / Date / 文字列 / ミリ秒）→ JST の "YYYY-MM-DD"。取れなければ ""
function jstYmdOf(v) {
  if (v == null || v === "") return "";
  let ms;
  if (typeof v.toMillis === "function") ms = v.toMillis();
  else if (typeof v.toDate === "function") ms = v.toDate().getTime();
  else if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "number") ms = v;
  else if (typeof v === "string" && YMD.test(v)) return v;
  else ms = Date.parse(v);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

const ng = (code, message) => ({ ok: false, code, message });

/**
 * スタッフ経路の受注確定の拒否条件。最初に当たったものを返す。
 * @param {object} p
 * @param {object} p.quote         対象の見積もり（id・status・version・validUntil）
 * @param {object[]} p.siblings    同じ案件の見積もり（対象を含んでいてもよい）
 * @param {object} p.kase          案件（status）
 * @param {object[]} p.shipments   同じ案件の出荷（status）
 * @param {string} p.receivedDate  受付日 "YYYY-MM-DD"（電話・メールを受けた日）
 * @param {string} p.todayYmd      今日（JST）"YYYY-MM-DD"
 * @param {string} p.acceptedName  申込者名
 * @param {string} p.channel       受付方法（STAFF_ACCEPT_CHANNELS のキー）
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
function checkStaffAccept({ quote, siblings, kase, shipments, receivedDate, todayYmd, acceptedName, channel } = {}) {
  if (!quote) return ng("quote_not_found", "見積もりが見つかりません");
  if (quote.status === "accepted") return ng("already_accepted", "この見積もりはすでに受注確定（お申し込み済み）です");
  if (quote.status !== "issued") return ng("not_issued", "この見積もりは受注確定にできません（発行中の見積もりではありません）");
  const myVer = Number(quote.version) || 0;
  const newer = (siblings || []).some((s) => s && s.id !== quote.id && (Number(s.version) || 0) > myVer);
  if (newer) return ng("old_version", "新しい版の見積もりがあります。最新の版で受注確定にしてください");

  if (!isValidYmd(receivedDate)) return ng("invalid_received_date", "受付日を正しく入れてください（YYYY-MM-DD）");
  if (!isValidYmd(todayYmd)) return ng("invalid_today", "今日の日付が取れません");
  if (receivedDate > todayYmd) return ng("future_received_date", "受付日が未来の日付になっています");
  // 期限切れは「受付日」で比べる（電話を受けた日に有効なら有効）。有効期限の日（JST）当日の受付は有効
  const until = jstYmdOf(quote.validUntil);
  if (until && receivedDate > until) return ng("expired", `受付日（${receivedDate}）が見積もりの有効期限（${until}）を過ぎています`);

  if (!String(acceptedName || "").trim()) return ng("no_name", "申込者のお名前を入れてください");
  if (!Object.prototype.hasOwnProperty.call(STAFF_ACCEPT_CHANNELS, channel)) {
    return ng("invalid_channel", "受付方法（電話・メール・FAX・その他）を選んでください");
  }

  if (!kase) return ng("case_not_found", "案件が見つかりません");
  // 失注(4)・完了(13)の案件も拒否しない（再申込として受け付け、呼び出し側が案件を 3 に戻す。2026-10-21 レビュー指摘 4）

  // キャンセル以外の出荷がある＝すでに申込を受けている。二重に下書きを作らないため止める
  const live = (shipments || []).filter((s) => s && (s.status || "shipped") !== "canceled");
  if (live.length) {
    const pre = live.every((s) => s.status === "draft" || s.status === "requested");
    const nos = live.map((s) => s.soNumber).filter(Boolean).join("・");
    return pre
      ? ng("draft_exists", `この案件にはすでに出荷の下書き・依頼${nos ? `（${nos}）` : ""}があります。重複していないか確かめてください`)
      : ng("shipped_exists", `この案件はすでに発送済みの出荷${nos ? `（${nos}）` : ""}があります。受注確定は二重になります`);
  }
  return { ok: true };
}

// ===== 見積もり必須・承諾書のサイン＝発注（2026-11-12・設計 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md）=====
// 画面の練習モード用の写し admin/js/order-consent-rules.js と同じ結果になること（scripts/test-order-consent.mjs が確かめる）。

// 紙の承諾書の受け取り方（signed.receivedVia）→ 表示名
const ORDER_RECEIVED_VIA = { post: "郵送", fax: "FAX", hand: "手渡し", email: "メール（スキャン）", other: "その他" };
// 受け取り方 → 受注の受付方法（quotes.acceptedChannel。STAFF_ACCEPT_CHANNELS のキー）
function channelOfReceivedVia(via) {
  return via === "fax" ? "fax" : via === "email" ? "email" : "other";
}
const ORDER_METHODS = ["paper_order", "web_order"];

/** 署名者名を整える: 制御文字・改行（\u0000-\u001f・\u007f）を空白にしてから前後の空白を取る（Web・紙の両方・2026-11-12 レビュー 低-2） */
function cleanSignedName(s) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** 承諾書の設定（appConfig/settings.orderByConsent）が入っているか。true のときだけ（未設定・文字列は切） */
function orderByConsentOn(settings) {
  return !!settings && settings.orderByConsent === true;
}

const tsMs = (v) => {
  if (v == null || v === "") return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.toDate === "function") return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 発注の承諾（承諾書のサイン）として受けてよいかの判定。最初に当たったものを返す。
 * 署名は「発行中・最新版・期限内」の見積もりに対してだけ受ける（発3: 古い版への発注はそもそもできない）。
 * @param {object} p
 * @param {{quote:object, siblings:object[]}[]} p.entries  対象の見積もり（まとめ見積もりは全事業所ぶん）と、その案件の見積もり（版の確認用）
 * @param {"paper_order"|"web_order"} p.method
 * @param {string} p.signedName     署名者名
 * @param {string} [p.receivedDate] 紙の承諾書を受け取った日 "YYYY-MM-DD"（紙のとき必須）
 * @param {string} [p.todayYmd]     今日（JST）
 * @param {number} [p.nowMs]        いまの時刻（Web のとき期限の比較に使う）
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
function checkOrderConsent({ entries, method, signedName, receivedDate, todayYmd, nowMs } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return ng("no_quotes", "承諾書の対象の見積もりがありません");
  if (!ORDER_METHODS.includes(method)) return ng("invalid_method", "承諾書の受け取り方が分かりません");
  const name = cleanSignedName(signedName);
  if (!name) return ng("no_signed_name", "承諾書に署名した方のお名前を入れてください");
  if (name.length > 100) return ng("signed_name_too_long", "署名者のお名前は100文字までにしてください");
  const paper = method === "paper_order";
  if (paper) {
    if (!isValidYmd(receivedDate)) return ng("invalid_consent_date", "承諾書を受け取った日を正しく入れてください（YYYY-MM-DD）");
    if (!isValidYmd(todayYmd)) return ng("invalid_today", "今日の日付が取れません");
    if (receivedDate > todayYmd) return ng("future_consent_date", "承諾書を受け取った日が未来の日付になっています");
  }
  const seenQuote = new Set(), seenCase = new Set();
  for (const e of list) {
    const q = e && e.quote;
    if (!q) return ng("quote_not_found", "見積もりが見つかりません");
    const label = q.estNo || q.id || "見積もり";
    if (seenQuote.has(q.id)) return ng("duplicate_quote", `同じ見積もりが二重に入っています（${label}）`);
    seenQuote.add(q.id);
    if (q.caseId != null) {
      if (seenCase.has(q.caseId)) return ng("duplicate_case", `同じ案件の見積もりが二つ入っています（${label}）`);
      seenCase.add(q.caseId);
    }
    if (q.status === "accepted") return ng("already_accepted", `この見積もりはすでに受注確定（お申し込み済み）です（${label}）`);
    if (q.status !== "issued") return ng("not_issued", `発行中の見積もりではないため、承諾書の対象にできません（${label}）`);
    const myVer = Number(q.version) || 0;
    if ((e.siblings || []).some((s) => s && s.id !== q.id && (Number(s.version) || 0) > myVer)) {
      return ng("old_version", `新しい版の見積もりがあります。最新の版の承諾書をいただいてください（${label}）`);
    }
    if (paper) {
      // 紙は「受け取った日」で比べる（受け取った日に有効なら有効。有効期限の日〔JST〕当日も有効）
      const until = jstYmdOf(q.validUntil);
      if (until && receivedDate > until) return ng("expired", `承諾書を受け取った日（${receivedDate}）が見積もりの有効期限（${until}）を過ぎています（${label}）`);
    } else {
      const ms = tsMs(q.validUntil);
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (ms != null && ms < now) return ng("expired", `見積もりの有効期限が切れています（${label}）`);
    }
  }
  // まとめ見積もり（発6）: 全部が同じグループ（空でない）
  if (list.length > 1) {
    const gid = list[0].quote.groupId || null;
    if (!gid) return ng("not_group", "この見積もりはまとめ見積もり（同じ法人の一括見積もり）ではありません。承諾書は1件ずつ受け取ってください");
    const others = list.filter((e) => (e.quote.groupId || null) !== gid);
    if (others.length) return ng("group_mismatch", `同じまとめ見積もりではない見積もりが含まれています（${others.map((e) => e.quote.estNo || e.quote.id).join("・")}）`);
  }
  return { ok: true };
}

/** 承諾書に焼き込む見積もり1件ぶん（あとで見積もりを直しても、署名した内容は変わらない） */
function orderConsentQuoteEntry(q) {
  const qq = q || {};
  const items = (Array.isArray(qq.items) ? qq.items : []).map((i) => ({
    sku: String((i && i.sku) || ""),
    subsidyQty: Number(i && i.subsidyQty) || 0,
    extraQty: Number(i && i.extraQty) || 0,
    ...(i && i.connector ? { connector: String(i.connector) } : {}),
  }));
  const a = qq.amounts || {};
  const num = (v) => Number(v) || 0;
  return {
    quoteId: String(qq.id || ""), estNo: String(qq.estNo || ""), version: Number(qq.version) || 0,
    caseId: String(qq.caseId || ""), caseNumber: qq.caseNumber == null ? null : qq.caseNumber,
    officeName: String(qq.officeName || ""), corpName: String(qq.corpName || ""), plan: qq.plan || null,
    items,
    amounts: {
      readers: num(a.readers), accompanyFee: num(a.accompanyFee), discount: num(a.discount),
      totalIncl: num(a.totalIncl), grantAmt: num(a.grantAmt), selfPay: num(a.selfPay),
    },
  };
}

/** 焼き込んだ見積もりの合計（税込） */
function orderConsentTotal(entries) {
  return (entries || []).reduce((s, e) => s + (Number(e && e.amounts && e.amounts.totalIncl) || 0), 0);
}

/**
 * 承諾書の記録（consentRequests/{token}・kind:"order"）の中身。時刻（signedAt・createdAt）は呼び出し側が足す。
 * @param {object} p
 * @param {object} p.document   条文の全文（functions/consent-document.js の ORDER_CONSENT_DOCUMENT）
 * @param {object[]} p.quotes   見積もり（Firestore のデータ + id）
 * @param {string|null} p.groupId
 * @param {{name:string, method:string, receivedDate?:string, receivedVia?:string}} p.signed
 * @param {string|null} [p.retakeOf]  受注後に改版して取り直したときの、前の承諾書のトークン
 * ⚠️ 職員のメールアドレス（記録した人など）は入れない（2026-11-12 レビュー 気づき-5）。承諾書の文書はトークンを知っていれば
 *    誰でも読める（第2段では事業所にトークンを渡す）ため。記録した職員は、案件の対応記録（activities.userName）と
 *    見積もり（acceptedByStaff）・案件（orderConfirmedBy）の側に残る。
 */
function buildOrderConsentRecord({ document, quotes, groupId, signed, retakeOf = null } = {}) {
  const entries = (quotes || []).map(orderConsentQuoteEntry);
  const first = entries[0] || {};
  const firstQ = (quotes || [])[0] || {};
  const s = signed || {};
  const sig = { name: cleanSignedName(s.name).slice(0, 100), method: s.method };
  if (s.method === "paper_order") {
    sig.receivedDate = s.receivedDate;
    sig.receivedVia = Object.prototype.hasOwnProperty.call(ORDER_RECEIVED_VIA, s.receivedVia) ? s.receivedVia : "other";
  }
  // Web（見積もりページで同意・第2段）: 同意した端末のブラウザの情報（あれば）。時刻はサーバーの時刻を呼び出し側が足す
  if (s.method === "web_order" && s.userAgent) sig.userAgent = String(s.userAgent).slice(0, 300);
  const rec = {
    kind: "order",
    caseId: first.caseId || "",                                   // 案件の承諾書の欄（caseId で探す）に出すため。まとめは先頭の案件
    caseIds: entries.map((e) => e.caseId).filter(Boolean),
    displayNo: `CST-${String(first.caseNumber != null ? first.caseNumber : (first.caseId || "")).slice(0, 12)}${entries.length > 1 ? `-G${entries.length}` : ""}`,
    officeName: entries.length > 1 ? `${first.officeName}ほか${entries.length - 1}事業所` : (first.officeName || ""),
    company: first.corpName || "",
    contactName: String(firstQ.contactName || ""),
    status: "signed",
    document,
    quotes: entries,
    quoteGroupId: groupId || null,
    totalIncl: orderConsentTotal(entries),
    signed: sig,
  };
  if (retakeOf) rec.retakeOf = String(retakeOf);
  return rec;
}

const itemsKey = (items) => (Array.isArray(items) ? items : [])
  .map((i) => `${(i && i.sku) || ""}:${Number(i && i.subsidyQty) || 0}+${Number(i && i.extraQty) || 0}`)
  .sort().join("|");

/**
 * 受注後に見積もりを直したとき、承諾書の取り直しが要るか（発3）。
 * 承諾書に焼き込んだその案件の見積もりと、新しい版の品目・台数・合計（税込）を比べ、違えば true。
 * 焼き込んだものが見つからなければ true（取り直しを促す側に倒す）。
 */
function orderConsentStaleAfterRevise(signedEntry, next) {
  if (!signedEntry) return true;
  const n = next || {};
  if (itemsKey(signedEntry.items) !== itemsKey(n.items)) return true;
  const a = Number(signedEntry.amounts && signedEntry.amounts.totalIncl) || 0;
  const b = Number(n.amounts && n.amounts.totalIncl) || 0;
  return a !== b;
}

/**
 * Web の発注（見積もりページで承諾書に同意する・第2段）の入力の確認。acceptQuote がスイッチがオンのときだけ使う。
 * consent は {agreed:true, version:"1.2"}。画面に出した条文の版が、いまサーバーが焼き込む版（documentVersion）と違えば拒否する
 * （見せた文面と記録する文面が違う事故を防ぐ。ページを読み込み直してもらう）。文言は事業所に見せるもの。
 * @param {{consent:object, documentVersion:string, signedName:string}} p
 */
function checkWebOrderConsentInput({ consent, documentVersion, signedName } = {}) {
  const c = consent && typeof consent === "object" ? consent : null;
  if (!c || c.agreed !== true) {
    return ng("consent_required", "承諾書（発注書を兼ねます）へのご同意が必要です。お手数ですが、ページを読み込み直し、承諾書をご確認のうえ同意してください");
  }
  if (String(c.version || "") !== String(documentVersion || "")) {
    return ng("consent_version_mismatch", `承諾書の版が新しくなっています（現在の版 ${documentVersion}）。お手数ですが、ページを読み込み直し、最新の承諾書をご確認ください`);
  }
  const name = cleanSignedName(signedName);
  if (!name) return ng("no_signed_name", "承諾書に同意される方のお名前をご入力ください");
  if (name.length > 100) return ng("signed_name_too_long", "お名前は100文字までにしてください");
  return { ok: true };
}

/**
 * 受注後に改版した見積もりで、承諾書を取り直してよいか（受注済み・最新版・案件に発注の承諾がある）。
 * @param {{quote:object, siblings:object[], kase:object, signedName:string, receivedDate:string, todayYmd:string}} p
 */
function checkOrderReconsent({ quote, siblings, kase, signedName, receivedDate, todayYmd } = {}) {
  if (!quote) return ng("quote_not_found", "見積もりが見つかりません");
  if (quote.status !== "accepted") return ng("not_accepted", "受注確定の前の見積もりです。取り直しではなく「署名済みの承諾書を受け取った」で受注確定にしてください");
  const myVer = Number(quote.version) || 0;
  if ((siblings || []).some((s) => s && s.id !== quote.id && (Number(s.version) || 0) > myVer)) {
    return ng("old_version", "新しい版の見積もりがあります。最新の版で承諾書を取り直してください");
  }
  if (!kase) return ng("case_not_found", "案件が見つかりません");
  if (!kase.orderConsentToken) return ng("no_order_consent", "この案件には発注の承諾書がありません（取り直しは、承諾書で受注確定にした案件だけです）");
  // 取り直しが済んでいる（印が立っていない）ときは止める。二度押しで承諾書が2件できないように（2026-11-12 レビュー 低-3）
  if (kase.orderConsentStale !== true) return ng("already_retaken", "この案件の承諾書はすでに取り直し済みです（取り直しが要るのは、受注後に見積もりの内容が変わったときだけです）");
  const name = cleanSignedName(signedName);
  if (!name) return ng("no_signed_name", "承諾書に署名した方のお名前を入れてください");
  if (name.length > 100) return ng("signed_name_too_long", "署名者のお名前は100文字までにしてください");
  if (!isValidYmd(receivedDate)) return ng("invalid_consent_date", "承諾書を受け取った日を正しく入れてください（YYYY-MM-DD）");
  if (!isValidYmd(todayYmd)) return ng("invalid_today", "今日の日付が取れません");
  if (receivedDate > todayYmd) return ng("future_consent_date", "承諾書を受け取った日が未来の日付になっています");
  return { ok: true };
}

module.exports = {
  checkStaffAccept, STAFF_ACCEPT_CHANNELS, isValidYmd, jstYmdOf,
  ORDER_RECEIVED_VIA, channelOfReceivedVia, orderByConsentOn, checkOrderConsent, orderConsentQuoteEntry,
  orderConsentTotal, buildOrderConsentRecord, orderConsentStaleAfterRevise, checkOrderReconsent, checkWebOrderConsentInput, cleanSignedName,
};
