// 承認済みドメインの計算（ネットワーク無し）のテスト。node scripts/test-auth-domains.mjs
// 2026-11-09 の事故（PATCH で一覧が丸ごと置き換わり、本番ドメインが抜けた）を繰り返さないための検査。
import assert from "node:assert/strict";
import {
  REQUIRED_DOMAINS, normalizeDomain, isAllowedToAdd, missingRequired, planAdd, planRemove,
} from "./lib/auth-domains-core.mjs";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };
const throws = (fn, re, msg) => { assert.throws(fn, re, msg); n++; };

const R = [...REQUIRED_DOMAINS];
const CH = "kjk-tadakayo-admin--verify-1111-abcd1234.web.app";

// --- normalizeDomain ---
eq(normalizeDomain("https://Kjk-Tadakayo-Admin.web.app/login?x=1"), "kjk-tadakayo-admin.web.app", "URL→ホスト");
eq(normalizeDomain("localhost"), "localhost", "localhost");
eq(normalizeDomain("localhost:5000"), "localhost", "ポートを落とす");
eq(normalizeDomain(" example.jp. "), "example.jp", "前後空白・末尾ドット");
eq(normalizeDomain(""), null, "空");
eq(normalizeDomain("foo"), null, "ラベル1つ");
eq(normalizeDomain("a b.jp"), null, "空白入り");
eq(normalizeDomain("-a.jp"), null, "先頭ハイフン");

// --- missingRequired ---
eq(missingRequired(R), [], "4件そろい");
eq(missingRequired([]), R, "空なら4件とも欠け");
eq(missingRequired(["KJK-TADAKAYO.WEB.APP"]).length, 3, "大文字小文字を区別しない");

// --- planAdd: 事故の再現（一覧が空のところへチャンネルだけ足す） ---
{
  const p = planAdd([], [CH]);
  eq(p.restoredRequired, R, "空の一覧なら必須4件を戻す");
  eq(p.added, [CH], "チャンネルを足す");
  ok(missingRequired(p.next).length === 0, "結果に必須4件がそろう");
  ok(p.changed, "変更あり");
}
// 事故後の状態（チャンネルだけ入っている）に別のチャンネルを足す
{
  const p = planAdd([CH], ["kjk-tadakayo-admin--other-1111-zz.web.app"]);
  ok(p.next.includes(CH) && p.next.includes("kjk-tadakayo-admin--other-1111-zz.web.app"), "既存も新規も残る");
  eq(p.restoredRequired.length, 4, "必須を戻す");
}
// 今ある分は1件も消えない・順序は今の一覧が先頭
{
  const cur = [...R, CH, "extra.example.jp"];
  const p = planAdd(cur, ["admin.kjk.tadakayo.jp"]);
  eq(p.next.slice(0, cur.length), cur, "今の一覧が先頭のまま");
  eq(p.next.length, cur.length + 1, "1件だけ増える");
}
// 重複・すでにある分は変更なし
{
  const p = planAdd([...R, CH], [CH, "https://" + CH + "/"]);
  ok(!p.changed, "すでにあるなら変更なし");
  eq(p.added, [], "足すものなし");
}
// 引数なし add = 必須4件を戻すだけ
{
  const p = planAdd(["kjk-tadakayo.web.app", CH], []);
  eq(p.restoredRequired.length, 3, "欠けた3件を戻す");
  ok(p.changed, "変更あり");
}
// 広すぎる名前は足せない（承認済みドメインはサブドメインにも効く）
for (const bad of ["web.app", "firebaseapp.com", "com", "evil.web.app", "kjk-tadakayo.web.app.evil.com", "tadakayo.jp.evil.com"]) {
  throws(() => planAdd(R, [bad]), /足せません|形が正しくありません/, `${bad} は足せない`);
}
for (const good of ["localhost", CH, "kjk-tadakayo-admin.web.app", "admin.kjk.tadakayo.jp"]) {
  ok(isAllowedToAdd(normalizeDomain(good)), `${good} は足せる`);
}
throws(() => planAdd(R, ["not a domain"]), /形が正しくありません/, "不正な形は拒否");

// --- planRemove ---
{
  const p = planRemove([...R, CH], [CH]);
  eq(p.next, R, "チャンネルだけ消える");
  eq(p.removed, [CH], "消したもの");
}
for (const d of R) {
  throws(() => planRemove([...R, CH], [d]), /消せません/, `必須 ${d} は消せない`);
  throws(() => planRemove([...R], ["https://" + d.toUpperCase() + "/"]), /消せません/, `URL形でも必須 ${d} は消せない`);
}
{
  const p = planRemove([...R], ["nothere.web.app"]);
  ok(!p.changed, "無いものを消しても変更なし");
  eq(p.notFound, ["nothere.web.app"], "notFound に入る");
}
throws(() => planRemove([CH, "x.web.app"], ["x.web.app"]), /欠けています/, "必須が欠けた一覧からは消さない（先に add で戻す）");

console.log(`PASS test-auth-domains: ${n} 件`);
