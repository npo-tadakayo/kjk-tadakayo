// 担当者の絞り込み（assignee-filter.js）のテスト。node scripts/test-assignee-filter.mjs
import assert from "node:assert/strict";
import { matchAssignee, matchAnyAssignee, toMs, loadPref, savePref, ASSIGNEE_ALL, ASSIGNEE_ME, ASSIGNEE_NONE }
  from "../admin/js/assignee-filter.js";

const me = "Tanaka@tadakayo.jp";
// 全員
assert.equal(matchAssignee("a@tadakayo.jp", ASSIGNEE_ALL, me), true);
assert.equal(matchAssignee(null, ASSIGNEE_ALL, me), true);
// 自分（大文字小文字・前後の空白は同じ人とみなす）
assert.equal(matchAssignee("tanaka@tadakayo.jp", ASSIGNEE_ME, me), true);
assert.equal(matchAssignee(" TANAKA@tadakayo.jp ", ASSIGNEE_ME, me), true);
assert.equal(matchAssignee("sato@tadakayo.jp", ASSIGNEE_ME, me), false);
assert.equal(matchAssignee(null, ASSIGNEE_ME, me), false);
// ログイン中のアドレスが取れていないときに「未割当」が自分扱いにならない
assert.equal(matchAssignee(null, ASSIGNEE_ME, ""), false);
assert.equal(matchAssignee("", ASSIGNEE_ME, undefined), false);
// 未割当
assert.equal(matchAssignee(null, ASSIGNEE_NONE, me), true);
assert.equal(matchAssignee("", ASSIGNEE_NONE, me), true);
assert.equal(matchAssignee("sato@tadakayo.jp", ASSIGNEE_NONE, me), false);
// 特定の人
assert.equal(matchAssignee("sato@tadakayo.jp", "sato@tadakayo.jp", me), true);
assert.equal(matchAssignee("Sato@tadakayo.jp", "sato@tadakayo.jp", me), true);
assert.equal(matchAssignee("tanaka@tadakayo.jp", "sato@tadakayo.jp", me), false);
assert.equal(matchAssignee(null, "sato@tadakayo.jp", me), false);

// 複数（事業所＝その事業所の案件の担当のどれか）
assert.equal(matchAnyAssignee(["sato@tadakayo.jp", "tanaka@tadakayo.jp"], ASSIGNEE_ME, me), true);
assert.equal(matchAnyAssignee(["sato@tadakayo.jp"], ASSIGNEE_ME, me), false);
assert.equal(matchAnyAssignee([], ASSIGNEE_ME, me), false);          // 案件の無い事業所は自分の担当ではない
assert.equal(matchAnyAssignee([], ASSIGNEE_NONE, me), true);         // 案件の無い事業所は未割当
assert.equal(matchAnyAssignee([null, null], ASSIGNEE_NONE, me), true);
assert.equal(matchAnyAssignee([null, "sato@tadakayo.jp"], ASSIGNEE_NONE, me), false); // 1件でも担当がいれば未割当ではない
assert.equal(matchAnyAssignee([], ASSIGNEE_ALL, me), true);

// 日時
assert.equal(toMs(null), 0);
assert.equal(toMs({ toMillis: () => 123 }), 123);
assert.equal(toMs("2026-10-20T00:00:00+09:00"), Date.parse("2026-10-20T00:00:00+09:00"));
assert.equal(toMs("でたらめ"), 0);

// 設定の保存は、ブラウザの保存領域が使えない環境（node・プライベートウィンドウ）でも落ちない
assert.equal(loadPref("x", "既定"), "既定");
savePref("x", "v");

console.log("OK test-assignee-filter: 全件合格");
