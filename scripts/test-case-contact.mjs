// 連絡先を直す（admin/js/case-contact.js）のテスト。画面の結線の静的検査も含む。node scripts/test-case-contact.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildContactUpdate, contactChangeActivity, quoteNeedsEmailFix, isPlausibleEmail } from "../admin/js/case-contact.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
const rd = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

const cur = { contactName: "山田 花子", contactEmail: "hiroyuki-fujita@tadakayo.jp", contactPhone: "03-1234-5678" };

// ===== 変更の組み立て =====
{
  const r = buildContactUpdate(cur, { contactEmail: "yamada@care.jp" });
  ok(r.ok, "メールだけ直せる");
  eq(r.data, { contactEmail: "yamada@care.jp" }, "変わった項目だけ data に入る");
  eq(r.changes, { contactEmail: { before: "hiroyuki-fujita@tadakayo.jp", after: "yamada@care.jp" } }, "changes に前後が入る");
}
// 正規化（全角・空白）
{
  const r = buildContactUpdate(cur, { contactEmail: " ｙａｍａｄａ＠ｃａｒｅ．ｊｐ ", contactPhone: "０３ー９９９９ー０００１" });
  ok(r.ok, "全角でも通る");
  eq(r.data, { contactEmail: "yamada@care.jp", contactPhone: "03-9999-0001" }, "メール・電話は半角に直して保存");
}
// 名前は前後の空白を除く
eq(buildContactUpdate(cur, { contactName: "  山田 太郎 " }).data, { contactName: "山田 太郎" }, "名前は trim");
// 不正なメール
for (const bad of ["abc", "a@b", "@care.jp", "a@@care.jp", "a@care.", "a@.jp", "a@care..jp", "a@b@c.jp"]) {
  const r = buildContactUpdate(cur, { contactEmail: bad });
  ok(!r.ok && /メール/.test(r.error), `不正なメールは通さない: ${bad}`);
}
ok(isPlausibleEmail("a.b+c@sub.care.co.jp"), "サブドメイン・記号は通る");
// 空のメールは許す（メールなしにする）
{
  const r = buildContactUpdate(cur, { contactEmail: "" });
  ok(r.ok, "メールを空にできる");
  eq(r.data, { contactEmail: "" }, "空文字で保存");
  eq(r.changes.contactEmail.after, "", "after は空");
}
// 空→値
{
  const r = buildContactUpdate({ contactName: "", contactEmail: "", contactPhone: "" }, { contactEmail: "a@care.jp" });
  ok(r.ok && r.changes.contactEmail.before === "", "空から入れられる");
}
// 変更なし
for (const inp of [{}, { contactEmail: cur.contactEmail }, { contactName: " 山田 花子 ", contactPhone: "０３－１２３４－５６７８" }]) {
  const r = buildContactUpdate(cur, inp);
  ok(!r.ok && r.error === "変更がありません", "変更なしはエラー");
}
// 保存済みが全角でも、直したあとの値が同じなら変更なし
ok(!buildContactUpdate({ contactEmail: "ａ＠care.jp" }, { contactEmail: "a@care.jp" }).ok, "保存済みが全角でも正規化して比べる");
// 長さ
ok(!buildContactUpdate(cur, { contactName: "あ".repeat(201) }).ok, "名前201文字は不可");
ok(buildContactUpdate(cur, { contactName: "あ".repeat(200) }).ok, "名前200文字は可");
// 引数が無くても落ちない
ok(!buildContactUpdate(null, null).ok, "null でも落ちない");
// current の値が未設定でも比べられる
ok(buildContactUpdate({}, { contactName: "A" }).ok, "未設定から入れられる");

// ===== 活動メモの文面 =====
{
  const a = contactChangeActivity({ contactEmail: { before: "old@a.jp", after: "new@a.jp" } });
  eq(a.subject, "連絡先を訂正（メール）", "1項目の件名");
  eq(a.body, "メール: old@a.jp → new@a.jp", "1項目の本文");
}
{
  const a = contactChangeActivity({
    contactPhone: { before: "1", after: "2" },
    contactName: { before: "甲", after: "乙" },
    contactEmail: { before: "a@a.jp", after: "b@b.jp" },
  });
  eq(a.subject, "連絡先を訂正（担当者名・メール・電話）", "3項目の件名は表示順");
  eq(a.body.split("\n"), ["担当者名: 甲 → 乙", "メール: a@a.jp → b@b.jp", "電話: 1 → 2"], "3項目の本文は1行ずつ");
}
{
  const a = contactChangeActivity({ contactEmail: { before: "", after: "x@a.jp" } });
  eq(a.body, "メール: （空欄） → x@a.jp", "空欄→値は（空欄）と書く");
  const b = contactChangeActivity({ contactEmail: { before: "x@a.jp", after: "" } });
  eq(b.body, "メール: x@a.jp → （空欄）", "値→空欄も（空欄）");
}
{
  const a = contactChangeActivity({ contactEmail: { before: "o@a.jp", after: "n@a.jp" } }, ["EST-2026-0232", "EST-2026-0232", "EST-2026-0233"]);
  eq(a.body.split("\n")[1], "見積もりの宛先も直しました: EST-2026-0232、EST-2026-0233", "見積もり番号は重複を除いて並べる");
}

// ===== 宛先も直す見積もり =====
ok(quoteNeedsEmailFix({ contactEmail: "o@a.jp", mailedAt: null }, "o@a.jp"), "未送付・旧メールは対象");
ok(quoteNeedsEmailFix({ contactEmail: "ｏ＠a.jp" }, "o@a.jp"), "全角で保存された旧メールも対象");
ok(!quoteNeedsEmailFix({ contactEmail: "o@a.jp", mailedAt: { seconds: 1 } }, "o@a.jp"), "送付済みは対象外");
ok(!quoteNeedsEmailFix({ contactEmail: "z@a.jp" }, "o@a.jp"), "別のメールは対象外");
ok(!quoteNeedsEmailFix({ contactEmail: "" }, ""), "旧メールが空なら対象外");

// ===== 画面の結線（静的検査） =====
const js = rd("admin/js/case-detail.js");
const html = rd("admin/case-detail.html");
ok(/from "\/js\/case-contact\.js"/.test(js), "case-detail.js が case-contact.js を読んでいる");
ok(/id="editContactBtn"/.test(html) && /連絡先を直す/.test(html), "ボタンがある");
ok(/id="editContactModal"/.test(html), "モーダルがある");
ok(/editContactBtn"\)\?\.addEventListener\("click", openEditContactModal\)/.test(js), "ボタンが結ばれている");
const body = js.slice(js.indexOf("async function saveContact"), js.indexOf("// 対象外バナー・操作ボタンの表示状態"));
ok(/runTransaction\(db/.test(body) && /tx\.update\(caseRef/.test(body) && /tx\.set\(actRef/.test(body), "案件・活動を1つのトランザクションで書く");
ok(/buildContactUpdate\(snap\.data\(\)/.test(body), "トランザクション内で読み直して作り直す");
ok(/where\("caseId", "==", caseId\)/.test(body), "見積もりは案件で絞る");

console.log(`OK test-case-contact: ${n} checks passed`);
