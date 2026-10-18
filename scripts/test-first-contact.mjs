// 初期連絡の超過判定（first-contact.js）の境界テスト。node scripts/test-first-contact.mjs
import assert from "node:assert/strict";
import { countBusinessDaysOver, businessDaysElapsed, jstDateString, JP_HOLIDAYS } from "../admin/js/first-contact.js";

// 正午JSTの Date を作る（JST固定。実行環境のTZに依存しない）
const d = (s, t = "12:00:00") => new Date(`${s}T${t}+09:00`);
const over = (a, t) => countBusinessDaysOver(d(a), d(t), JP_HOLIDAYS);
const el = (a, t) => businessDaysElapsed(d(a), d(t), JP_HOLIDAYS);

// 2026-10-16 は金曜
assert.equal(el("2026-10-16", "2026-10-16"), 0);   // 当日申込
assert.equal(el("2026-10-16", "2026-10-17"), 0);   // 土
assert.equal(el("2026-10-16", "2026-10-19"), 1);   // 月 = 1営業日目
assert.equal(el("2026-10-16", "2026-10-20"), 2);   // 火
assert.equal(el("2026-10-16", "2026-10-21"), 3);   // 水 = ちょうど3営業日目
assert.equal(over("2026-10-16", "2026-10-20"), 0); // 火
assert.equal(over("2026-10-16", "2026-10-21"), 0); // 水（ちょうど3営業日＝超過なし）
assert.equal(over("2026-10-16", "2026-10-22"), 1); // 木（4営業日目＝超過1日）
assert.equal(over("2026-10-16", "2026-10-23"), 2); // 金
assert.equal(over("2026-10-16", "2026-10-26"), 3); // 翌週月（6営業日目）
// 土日申込（土=10-17）
assert.equal(over("2026-10-17", "2026-10-21"), 0); // 月1 火2 水3
assert.equal(over("2026-10-17", "2026-10-22"), 1);
assert.equal(over("2026-10-18", "2026-10-22"), 1); // 日申込も同じ
// 申込日より前（時計ずれ）は 0
assert.equal(over("2026-10-20", "2026-10-16"), 0);
// 祝日をまたぐ: 2026-11-03(火・文化の日)。月曜 11-02 申込 → 水1 木2 金3 → 月(11-09)=4
assert.equal(el("2026-11-02", "2026-11-04"), 1);
assert.equal(over("2026-11-02", "2026-11-06"), 0);
assert.equal(over("2026-11-02", "2026-11-09"), 1);
// 祝日を考慮しないと超過になる日が超過にならない（10-12 スポーツの日）: 10-09(金)申込 → 火1 水2 木3 金4
assert.equal(over("2026-10-09", "2026-10-15"), 0);
assert.equal(over("2026-10-09", "2026-10-16"), 1);
// 連休（シルバーウィーク 2026-09-19〜23）: 09-18(金)申込 → 水(24)=1 木2 金3 月(28)=3 火(29)=4
assert.equal(over("2026-09-18", "2026-09-28"), 0);
assert.equal(over("2026-09-18", "2026-09-29"), 1);
// 2027 年: 3/22 振替休日。3/19(金)申込 → 火(23)=1 水2 木3 金(26)=4
assert.equal(over("2027-03-19", "2027-03-25"), 0);
assert.equal(over("2027-03-19", "2027-03-26"), 1);
// 年またぎ: 2026-12-30(水)申込 → 12/31=1, 1/1(祝)除外, 1/4(月)=2, 1/5=3, 1/6=4
assert.equal(over("2026-12-30", "2027-01-05"), 0);
assert.equal(over("2026-12-30", "2027-01-06"), 1);
// JST 判定: UTC では前日になる 2026-10-16 08:00 JST（= 10-15 23:00Z）も 10-16 として扱う
assert.equal(jstDateString(new Date("2026-10-15T23:00:00Z")), "2026-10-16");
assert.equal(over("2026-10-16", "2026-10-21"), countBusinessDaysOver(new Date("2026-10-15T23:00:00Z"), d("2026-10-21")));
// Firestore Timestamp 相当（toDate を持つ）と不正値
assert.equal(countBusinessDaysOver({ toDate: () => d("2026-10-16") }, d("2026-10-22")), 1);
assert.equal(countBusinessDaysOver(null, d("2026-10-22")), 0);
assert.equal(countBusinessDaysOver(d("2026-10-16"), undefined), 0);
// 祝日定数の整合: すべて YYYY-MM-DD・重複なし・指定の4日を含む
assert.ok(JP_HOLIDAYS.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h)));
assert.equal(new Set(JP_HOLIDAYS).size, JP_HOLIDAYS.length);
for (const h of ["2026-10-12", "2026-11-03", "2026-11-23", "2027-11-23"]) assert.ok(JP_HOLIDAYS.includes(h));
console.log("ok");
