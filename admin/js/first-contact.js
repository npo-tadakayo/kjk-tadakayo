// 初期連絡の期限（申込から5営業日以内）の超過判定。純粋関数のみ（DOM・Firestore に触れない）。
// 決定: 次田さん（常務理事）。通知（メール・Chat）は作らず、案件一覧の画面表示のみ。
// テスト: node scripts/test-first-contact.mjs

export const FIRST_CONTACT_LIMIT = 5; // 営業日

// 日本の祝日（内閣府）。YYYY-MM-DD。土日と重なる日の振替休日・国民の休日も含める。
// 年末年始（12/29〜1/3）は法定の祝日ではないが休業日として扱う（毎年。下の isYearEndHoliday で日付ルール判定）。
// 2028年以降は未登録。年が変わる前に追記すること（未登録の年の祝日は平日扱いになる）。
export const JP_HOLIDAYS = [
  // 2026
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23",
  "2026-03-20", // 春分の日【要確認】官報告示値
  "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-05-06", // 振替休日（5/3が日曜）
  "2026-07-20", "2026-08-11",
  "2026-09-21", // 敬老の日
  "2026-09-22", // 国民の休日（敬老の日と秋分の日に挟まれる）
  "2026-09-23", // 秋分の日【要確認】官報告示値
  "2026-10-12", "2026-11-03", "2026-11-23",
  // 2027
  "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23",
  "2027-03-21", // 春分の日【要確認】官報告示値
  "2027-03-22", // 振替休日（3/21が日曜）
  "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05",
  "2027-07-19", "2027-08-11",
  "2027-09-20", // 敬老の日
  "2027-09-23", // 秋分の日【要確認】官報告示値
  "2027-10-11", "2027-11-03", "2027-11-23",
];

const JST_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Date（または Firestore Timestamp 相当の toDate を持つ値）を JST の "YYYY-MM-DD" にする。不正値は null。 */
export function jstDateString(d) {
  const date = d && typeof d.toDate === "function" ? d.toDate() : d;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return JST_FMT.format(date);
}

function dayNumber(ymd) { // "YYYY-MM-DD" → UTC 0時の通算日
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
/** 年末年始の休業日（12/29〜12/31 と 1/1〜1/3）。年ごとの列挙に頼らず月日で判定する。 */
export function isYearEndHoliday(ymd) {
  const m = Number(ymd.slice(5, 7)), d = Number(ymd.slice(8, 10));
  return (m === 12 && d >= 29) || (m === 1 && d <= 3);
}
function isBusinessDayNum(n, holidaySet) {
  const dow = new Date(n * 86400000).getUTCDay(); // 0=日 6=土
  if (dow === 0 || dow === 6) return false;
  const ymd = new Date(n * 86400000).toISOString().slice(0, 10);
  return !holidaySet.has(ymd) && !isYearEndHoliday(ymd);
}

/**
 * 申込日の「翌営業日」を1営業日目として、today が何営業日目かを返す（申込当日・申込日以前は 0）。
 * 営業日 = 土日・holidays（YYYY-MM-DD の配列）・年末年始（12/29〜1/3）を除く日。日付は JST で判定する。
 */
export function businessDaysElapsed(createdAtDate, today, holidays = JP_HOLIDAYS) {
  const a = jstDateString(createdAtDate), t = jstDateString(today);
  if (!a || !t) return 0;
  const set = new Set(holidays);
  let n = 0;
  for (let x = dayNumber(a) + 1; x <= dayNumber(t); x++) if (isBusinessDayNum(x, set)) n++;
  return n;
}

/**
 * 初期連絡の超過日数（営業日）。
 * 定義: 申込日の翌営業日=1営業日目。5営業日以内（〜5営業日目）は超過なし（0）、
 * 5営業日を超えた＝6営業日目以降が「超過」で、超過日数 = 営業日目 − 5。
 * 例: 金曜申込 → 月=1・火=2・水=3・木=4・金=5（超過なし）・翌月=6（超過1日）。
 */
export function countBusinessDaysOver(createdAtDate, today, holidays = JP_HOLIDAYS) {
  return Math.max(0, businessDaysElapsed(createdAtDate, today, holidays) - FIRST_CONTACT_LIMIT);
}
