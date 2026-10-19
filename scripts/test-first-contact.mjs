// 初期連絡の超過判定（first-contact.js）の境界テスト。node scripts/test-first-contact.mjs
import assert from "node:assert/strict";
import { countBusinessDaysOver, businessDaysElapsed, jstDateString, isYearEndHoliday, JP_HOLIDAYS } from "../admin/js/first-contact.js";

// 正午JSTの Date を作る（JST固定。実行環境のTZに依存しない）
const d = (s, t = "12:00:00") => new Date(`${s}T${t}+09:00`);
const over = (a, t) => countBusinessDaysOver(d(a), d(t), JP_HOLIDAYS);
const el = (a, t) => businessDaysElapsed(d(a), d(t), JP_HOLIDAYS);

// 5営業日以内は超過なし。年末年始（12/29〜1/3）は毎年休業日（日付ルール判定）。
// 2026-10-16 は金曜
assert.equal(el("2026-10-16", "2026-10-16"), 0);   // 当日申込
assert.equal(el("2026-10-16", "2026-10-17"), 0);   // 土
assert.equal(el("2026-10-16", "2026-10-19"), 1);   // 月 = 1営業日目
assert.equal(el("2026-10-16", "2026-10-20"), 2);   // 火
assert.equal(el("2026-10-16", "2026-10-21"), 3);   // 水
assert.equal(el("2026-10-16", "2026-10-23"), 5);   // 金 = ちょうど5営業日目
assert.equal(over("2026-10-16", "2026-10-21"), 0); // 水（3営業日目）
assert.equal(over("2026-10-16", "2026-10-22"), 0); // 木（4営業日目＝3営業日を超えても超過ではない）
assert.equal(over("2026-10-16", "2026-10-23"), 0); // 金（ちょうど5営業日＝超過なし）
assert.equal(over("2026-10-16", "2026-10-26"), 1); // 翌週月（6営業日目＝超過1日）
assert.equal(over("2026-10-16", "2026-10-27"), 2); // 火
// 土日申込（土=10-17）
assert.equal(over("2026-10-17", "2026-10-23"), 0); // 月1 火2 水3 木4 金5
assert.equal(over("2026-10-17", "2026-10-26"), 1);
assert.equal(over("2026-10-18", "2026-10-26"), 1); // 日申込も同じ
// 申込日より前（時計ずれ）は 0
assert.equal(over("2026-10-20", "2026-10-16"), 0);
// 祝日をまたぐ: 2026-11-03(火・文化の日)。月曜 11-02 申込 → 水4=1 木5=2 金6=3 月9=4 火10=5 水11=6
assert.equal(el("2026-11-02", "2026-11-04"), 1);
assert.equal(over("2026-11-02", "2026-11-10"), 0);
assert.equal(over("2026-11-02", "2026-11-11"), 1);
// 祝日を考慮しないと超過になる日が超過にならない（10-12 スポーツの日）: 10-09(金)申込 → 火13=1 水14 木15 金16 月19=5 火20=6
assert.equal(over("2026-10-09", "2026-10-19"), 0);
assert.equal(over("2026-10-09", "2026-10-20"), 1);
// 連休（シルバーウィーク 2026-09-19〜23）: 09-18(金)申込 → 木24=1 金25=2 月28=3 火29=4 水30=5 木10/1=6
assert.equal(over("2026-09-18", "2026-09-30"), 0);
assert.equal(over("2026-09-18", "2026-10-01"), 1);
// 2027 年: 3/22 振替休日。3/19(金)申込 → 火23=1 水24 木25 金26 月29=5 火30=6
assert.equal(over("2027-03-19", "2027-03-29"), 0);
assert.equal(over("2027-03-19", "2027-03-30"), 1);

// ===== 年末年始（12/29〜1/3 は毎年休業）=====
assert.ok(isYearEndHoliday("2025-12-29") && isYearEndHoliday("2026-01-03") && isYearEndHoliday("2040-12-31") && isYearEndHoliday("2040-01-01"));
assert.ok(!isYearEndHoliday("2025-12-28") && !isYearEndHoliday("2026-01-04") && !isYearEndHoliday("2026-06-30"));
// 2025-12-26(金)申込（祝日表に2025年は無い＝日付ルールだけで判定）: 12/29〜1/3 休み → 1/5(月)=1 火6=2 水7=3 木8=4 金9=5 / 1/12(2026祝・成人の日)除外 → 火13=6
assert.equal(el("2025-12-26", "2025-12-29"), 0);   // 年末年始に入っても進まない
assert.equal(el("2025-12-26", "2026-01-03"), 0);
assert.equal(el("2025-12-26", "2026-01-05"), 1);   // 1/5 月 = 1営業日目
assert.equal(over("2025-12-26", "2026-01-09"), 0); // 金 = 5営業日目
assert.equal(el("2025-12-26", "2026-01-12"), 5);   // 成人の日は休み（進まない）
assert.equal(over("2025-12-26", "2026-01-13"), 1); // 火 = 6営業日目＝超過1日
// 2026-12-24(木)申込: 金25=1 月28=2 / 12/29〜1/3 休み / 月1/4=3 火5=4 水6=5 木7=6
assert.equal(over("2026-12-24", "2027-01-06"), 0);
assert.equal(over("2026-12-24", "2027-01-07"), 1);
// 2026-12-30(水)申込（年末年始の最中）: 1/4(月)=1 … 金1/8=5 / 1/11(祝)除外 → 火1/12=6
assert.equal(el("2026-12-30", "2026-12-31"), 0);
assert.equal(el("2026-12-30", "2027-01-04"), 1);
assert.equal(over("2026-12-30", "2027-01-08"), 0);
assert.equal(over("2026-12-30", "2027-01-11"), 0);
assert.equal(over("2026-12-30", "2027-01-12"), 1);
// 年末年始を営業日として数えていた旧ルールとの差: 12/28(月)申込 → 旧なら火12/29=1…。新は 1/4=1
assert.equal(el("2026-12-28", "2026-12-29"), 0);
assert.equal(el("2026-12-28", "2027-01-04"), 1);
// JST 判定: UTC では前日になる 2026-10-16 08:00 JST（= 10-15 23:00Z）も 10-16 として扱う
assert.equal(jstDateString(new Date("2026-10-15T23:00:00Z")), "2026-10-16");
assert.equal(over("2026-10-16", "2026-10-26"), countBusinessDaysOver(new Date("2026-10-15T23:00:00Z"), d("2026-10-26")));
// Firestore Timestamp 相当（toDate を持つ）と不正値
assert.equal(countBusinessDaysOver({ toDate: () => d("2026-10-16") }, d("2026-10-26")), 1);
assert.equal(countBusinessDaysOver(null, d("2026-10-26")), 0);
assert.equal(countBusinessDaysOver(d("2026-10-16"), undefined), 0);
// 祝日定数の整合: すべて YYYY-MM-DD・重複なし・指定の4日を含む
assert.ok(JP_HOLIDAYS.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h)));
assert.equal(new Set(JP_HOLIDAYS).size, JP_HOLIDAYS.length);
for (const h of ["2026-10-12", "2026-11-03", "2026-11-23", "2027-11-23"]) assert.ok(JP_HOLIDAYS.includes(h));
console.log("ok");
