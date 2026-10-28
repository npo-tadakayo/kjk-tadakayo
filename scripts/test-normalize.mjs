// メール・電話の全角→半角の正規化テスト。node scripts/test-normalize.mjs
// admin 版（ES module）と functions 版（CommonJS）が同じ結果になることも検査する。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as A from "../admin/js/normalize.js";
import { dupKeys } from "../admin/js/constants.js";
const F = createRequire(import.meta.url)("../functions/normalize.js");

let n = 0;
const both = (fn, input, expected, msg) => {
  assert.equal(A[fn](input), expected, `admin ${fn}: ${msg || JSON.stringify(input)}`);
  assert.equal(F[fn](input), expected, `functions ${fn}: ${msg || JSON.stringify(input)}`);
  n += 2;
};

// メール
both("normalizeEmail", "aoki＠space.ocn.ne.jp", "aoki@space.ocn.ne.jp", "全角＠（#377）");
both("normalizeEmail", "ＡＯＫＩ＠ｓｐａｃｅ．ｏｃｎ．ｎｅ．ｊｐ", "AOKI@space.ocn.ne.jp", "全角英数・全角ドット（大文字小文字は変えない）");
both("normalizeEmail", "a@b.jp　", "a@b.jp", "全角スペース");
both("normalizeEmail", "a @ b.jp", "a@b.jp", "途中の空白");
both("normalizeEmail", "  a@b.jp\n", "a@b.jp", "前後空白・改行");
both("normalizeEmail", "a@b.jp\t\r\n", "a@b.jp", "タブ・CRLF");
both("normalizeEmail", "Tsukuda-Y_1＠Tadakayo.JP", "Tsukuda-Y_1@Tadakayo.JP", "全角＠＋大文字は保つ");
both("normalizeEmail", "ａ－ｂ＠ｘ．ｊｐ", "a-b@x.jp", "全角ハイフン");
both("normalizeEmail", "", ""); both("normalizeEmail", undefined, ""); both("normalizeEmail", null, "");
both("normalizeEmail", "a@b.jp", "a@b.jp", "半角はそのまま");

// 電話
both("normalizePhone", "０９８５－２３－０００１", "0985-23-0001", "全角数字・全角ハイフン");
both("normalizePhone", "0985ー23ー0001", "0985-23-0001", "長音");
for (const d of ["−", "‐", "‑", "‒", "–", "—", "―", "－", "ｰ"]) both("normalizePhone", `0985${d}23${d}0001`, "0985-23-0001", `ダッシュ U+${d.codePointAt(0).toString(16)}`);
both("normalizePhone", "(0985) 23-0001", "(0985)23-0001", "括弧は残し空白だけ消す");
both("normalizePhone", "0985 23　0001", "0985230001", "空白を除去");
both("normalizePhone", "0985--23---0001", "0985-23-0001", "連続ハイフンは1つ");
both("normalizePhone", "-0985-23-0001-", "0985-23-0001", "前後のハイフンを除く");
both("normalizePhone", "+81-985-23-0001", "+81-985-23-0001", "+ はそのまま");
both("normalizePhone", "0985-23-0001（内線12）", "0985-23-0001(内線12)", "内線表記は壊さない（全角括弧は半角に）");
both("normalizePhone", "0985-23-0001 内線12", "0985-23-0001内線12", "文字は消さず空白だけ消す");
both("normalizePhone", "", ""); both("normalizePhone", undefined, "");
both("normalizePhone", "0985-23-0001", "0985-23-0001", "半角はそのまま");

// admin 版と functions 版が全ケースで一致（念のためランダム風の組み合わせも）
const samples = ["ａｂ＠ｃ．ｊｐ", " x@y.jp ", "０３－１２３４－５６７８", "03ー1234ー5678", "(03) 1234-5678", "", "　", "ーー", "－－1－－"];
for (const s of samples) {
  assert.equal(A.normalizeEmail(s), F.normalizeEmail(s)); assert.equal(A.normalizePhone(s), F.normalizePhone(s)); n += 2;
}

// 重複判定キー：全角・半角のゆれで別物にならない
assert.deepEqual(dupKeys({ contactEmail: "Aoki＠Space.ocn.ne.jp ", contactPhone: "０９８５－２３－０００１", officeName: "A" }),
  ["e:aoki@space.ocn.ne.jp", "p:0985230001", "o:A"]); n++;
assert.deepEqual(dupKeys({ contactEmail: "aoki@space.ocn.ne.jp", contactPhone: "0985-23-0001", officeName: "A" }),
  dupKeys({ contactEmail: "aoki＠space.ocn.ne.jp", contactPhone: "０９８５ー２３ー０００１", officeName: "A" })); n++;

console.log(`test-normalize: ${n} checks passed`);
