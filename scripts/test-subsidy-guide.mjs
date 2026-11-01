// 助成金申請の手順（subsidy-guide.js）に画面のスクショが入っていないことの検査。node scripts/test-subsidy-guide.mjs
// 2026-10-29 次田さん判断：画面のスクショは載せない。書類の見本（p09 通帳・p10 指定通知書・p12 領収書）は残す。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderSubsidyGuideHtml } from "../admin/js/subsidy-guide.js";

const src = readFileSync(new URL("../admin/js/subsidy-guide.js", import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

for (const f of ["p14_", "p15_", "p16_", "p17_", "p18_", "p19_", "p21_", "p22_", "p33_"]) {
  ok(!src.includes(`"${f}`), `${f}…の画面スクショを参照している`);
}
const g = { aIncl: 66000, bIncl: 64000, units: 3, readerName: "テスト", corpName: "法人", officeName: "事業所", rcptNo: "RCPT-1", fromInvoice: false };
const html = renderSubsidyGuideHtml(g);
const imgs = [...html.matchAll(/images\/subsidy-guide\/([\w.]+)/g)].map((m) => m[1]).sort();
assert.deepEqual(imgs, ["p09_tsucho.jpg", "p10_shitei.jpg", "p12_ryoshusho.jpg"]); n++;
ok((html.match(/class="sgp"/g) || []).length === 6, "6ページ");
ok(html.includes("6 / 6") && !html.includes("8 / 8"), "ページ表示が実態と合う");
ok(!/P\.[78]\b/.test(html), "存在しないページ（P.7・P.8）を参照している");
// 差し込み値は残っている
ok(html.includes("¥66,000") && html.includes("¥64,000") && html.includes("3 台"), "金額・台数の差し込み");
console.log(`test-subsidy-guide: ${n} checks passed`);
