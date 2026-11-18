// 公開の見積もりの入口（sendQuotePdf）から出る見積書メールの「1日の送信数の上限」（2026-11-18・セキュリティ点検 A2 ②・仕様 ENGINEERING_NOTES §C19）。
// 職員が CRM から送るメール（resendQuoteMail・sendCaseEmail・請求書・発注・出荷連絡など）には使わない。
//
//   ① 同じ宛先アドレスへ、1日（JST 0:00〜24:00）30通まで
//   ② 公開の入口からの送信全体で、1日150通まで
//
// 数え方: 送信の直前に Firestore のトランザクションで「予約」する（同時リクエストでもすり抜けない）。
// 送信に失敗したら release() で予約を戻す（失敗は数えない）。まとめて1通で送る経路（pdfs[]）は1通と数える。
// カウンタ文書（_rateLimit）:
//   quoteMail_YYYYMMDD                 … 全体（alertedAt: 全体の上限の警報を出した時刻＝その日1回だけ）
//   quoteMail_YYYYMMDD_<sha256先頭16>  … 宛先別（メールアドレスそのものは文書IDにも中身にも入れない）
// どちらにも expiresAt（その日の終わり＋7日）を入れる（あとで TTL を張れるように。TTL の設定はしていない）。
// 時計は clock.now を差し替えられる（テストで日付をまたぐため。scripts/test-quote-mail-ratelimit-emu.mjs）。

const crypto = require("crypto");

const QUOTE_MAIL_DAILY_PER_RECIPIENT = 30;
const QUOTE_MAIL_DAILY_TOTAL = 150;
const RATE_LIMIT_COLLECTION = "_rateLimit";
const EXPIRE_DAYS_AFTER = 7;

const clock = { now: () => new Date() };

// JST の日付 "YYYYMMDD"
function jstDay(now = clock.now()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
// "YYYYMMDD" → "YYYY-MM-DD"（警報・ログの表示用）
const dayLabel = (day) => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
// その日（JST）の終わり＋EXPIRE_DAYS_AFTER 日の Date
function expiresAtOf(day) {
  const endUtcMs = Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8) + 1) - 9 * 3600 * 1000; // 翌日 0:00 JST
  return new Date(endUtcMs + EXPIRE_DAYS_AFTER * 86400000);
}
// 宛先の鍵: 小文字・前後の空白なしの SHA-256 の先頭16文字
function recipientKey(email) {
  return crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex").slice(0, 16);
}
// ログ用の伏せ字: "abc@domain.co.jp" → "a***@d***.jp"
function maskEmail(email) {
  const e = String(email || "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return "***";
  const local = e.slice(0, at), domain = e.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${domain ? domain[0] : ""}***${tld}`;
}
// 全体の上限に達したときの Chat の文面（宛先・個人情報は入れない）
function totalLimitAlertText(day, total = QUOTE_MAIL_DAILY_TOTAL) {
  return `⚠️ 見積書メールの1日の上限（${total}通）に達しました。公開の入口からの送信が異常に多い可能性があります（${dayLabel(day)}）`;
}
// 画面には出さない、CRM（見積もりの mailError・記録の抜け）に残す職員向けの文
const STAFF_MESSAGES = {
  rate_limited_recipient: `同じ宛先への1日の送信上限（${QUOTE_MAIL_DAILY_PER_RECIPIENT}通）に達したため、見積書メールは送っていません`,
  rate_limited_total: `公開の入口からの1日の送信上限（${QUOTE_MAIL_DAILY_TOTAL}通）に達したため、見積書メールは送っていません`,
  rate_limit_error: "送信数の確認に失敗したため、見積書メールは送っていません",
};

/**
 * 1通分を予約する。
 * 戻り値:
 *   { ok:true, day, release }                       … 送ってよい。送信に失敗したら await release()
 *   { ok:false, reason:"rate_limited_recipient", day } … 同じ宛先の上限
 *   { ok:false, reason:"rate_limited_total", day, alert } … 全体の上限。alert が true のときだけ警報を出す（その日の最初の1回）
 * トランザクションそのものが失敗したら例外（呼び出し側で「送らない」にする）。
 */
async function reserveQuoteMail(db, to, {
  now = clock.now(), perRecipient = QUOTE_MAIL_DAILY_PER_RECIPIENT, total = QUOTE_MAIL_DAILY_TOTAL, FieldValue, Timestamp,
} = {}) {
  const day = jstDay(now);
  const col = db.collection(RATE_LIMIT_COLLECTION);
  const totalRef = col.doc(`quoteMail_${day}`);
  const rcptRef = col.doc(`quoteMail_${day}_${recipientKey(to)}`);
  const expiresAt = Timestamp ? Timestamp.fromDate(expiresAtOf(day)) : expiresAtOf(day);
  const stamp = () => (FieldValue ? FieldValue.serverTimestamp() : new Date());

  const result = await db.runTransaction(async (tx) => {
    const [tSnap, rSnap] = await Promise.all([tx.get(totalRef), tx.get(rcptRef)]);
    const tCount = (tSnap.exists && Number(tSnap.data().count)) || 0;
    const rCount = (rSnap.exists && Number(rSnap.data().count)) || 0;
    if (rCount >= perRecipient) {
      return { ok: false, reason: "rate_limited_recipient", day };
    }
    if (tCount >= total) {
      const alert = !(tSnap.exists && tSnap.data().alertedAt);
      if (alert) tx.set(totalRef, { alertedAt: stamp(), updatedAt: stamp() }, { merge: true });
      return { ok: false, reason: "rate_limited_total", day, alert };
    }
    tx.set(totalRef, { kind: "quoteMailTotal", day, count: tCount + 1, limit: total, expiresAt, updatedAt: stamp() }, { merge: true });
    tx.set(rcptRef, { kind: "quoteMailRecipient", day, count: rCount + 1, limit: perRecipient, expiresAt, updatedAt: stamp() }, { merge: true });
    return { ok: true, day };
  }, { maxAttempts: 30 });

  if (!result.ok) return result;
  let released = false;
  result.release = async () => {
    if (released) return;
    released = true;
    await db.runTransaction(async (tx) => {
      const [tSnap, rSnap] = await Promise.all([tx.get(totalRef), tx.get(rcptRef)]);
      if (tSnap.exists) tx.set(totalRef, { count: Math.max(0, (Number(tSnap.data().count) || 0) - 1), updatedAt: stamp() }, { merge: true });
      if (rSnap.exists) tx.set(rcptRef, { count: Math.max(0, (Number(rSnap.data().count) || 0) - 1), updatedAt: stamp() }, { merge: true });
    }, { maxAttempts: 30 });
  };
  return result;
}

module.exports = {
  QUOTE_MAIL_DAILY_PER_RECIPIENT, QUOTE_MAIL_DAILY_TOTAL, RATE_LIMIT_COLLECTION, EXPIRE_DAYS_AFTER, STAFF_MESSAGES,
  clock, jstDay, dayLabel, expiresAtOf, recipientKey, maskEmail, totalLimitAlertText, reserveQuoteMail,
};
