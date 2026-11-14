// マニュアル admin/manual.html の「よくある質問（伴走支援）」節のテスト（2026-11-15）。node scripts/test-manual-support-faq.mjs
// 確かめること: ①節が目次の材料（章 h2・sec の data-toc）として揃う ②項目数が決めた数と一致 ③個人情報らしい文字列が無い
// ④正本の Markdown が手元にあれば、載せた項目の数が「回答あり／一部回答あり」の数と一致 ⑤正本の場所と更新日を明記
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let n = 0;
const t = (fn) => { fn(); n++; };
const html = readFileSync(new URL("../admin/manual.html", import.meta.url), "utf8");
const m = html.match(/<section class="chap" id="ch-sfaq">[\s\S]*?<\/section>/);
assert.ok(m, "ch-sfaq の章が無い");
const chap = m[0];
const EXPECT_ITEMS = 14;
const EXPECT_SECS = ["s-sfaq-notice", "s-sfaq-cert", "s-sfaq-login", "s-sfaq-import", "s-sfaq-apply", "s-sfaq-support"];

t(() => { // 章の見出しと、目次に出る sec
  assert.match(chap, /<h2>よくある質問（伴走支援）<\/h2>/);
  for (const id of EXPECT_SECS) assert.match(chap, new RegExp(`<div class="sec" id="${id}" data-toc="[^"]+"`), `${id} に data-toc が無い`);
  assert.equal((chap.match(/data-toc="/g) || []).length, EXPECT_SECS.length);
});
t(() => { // 開閉の項目数（既存の details.faq の仕組み）
  const items = chap.match(/<details class="faq"><summary>/g) || [];
  assert.equal(items.length, EXPECT_ITEMS);
  assert.equal((chap.match(/<details/g) || []).length, (chap.match(/<\/details>/g) || []).length);
  for (const s of chap.match(/<summary>([\s\S]*?)<\/summary>/g)) assert.ok(s.length > 20, "空に近い質問");
});
t(() => { // 章は1か所・id の重複なし
  assert.equal((html.match(/id="ch-sfaq"/g) || []).length, 1);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(new Set(ids).size, ids.length, "id が重複している");
});
t(() => { // 個人情報らしい文字列が無い
  const text = chap.replace(/<[^>]+>/g, " ");
  assert.ok(!/\b\d{10}\b/.test(text), "10桁の数字（被保険者証番号・事業所番号の形）");
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text), "メールアドレス");
  assert.ok(!/0\d{1,4}-\d{1,4}-\d{3,4}/.test(text), "電話番号");
  for (const w of ["藤田", "北区", "苫小牧", "中部サンケア", "善光総研", "TDT-"]) assert.ok(!text.includes(w), `固有名が残っている: ${w}`);
});
t(() => { // 正本の場所と更新日
  assert.match(chap, /02_ケアプー事業\/_共通\/伴走支援FAQ\//);
  assert.match(chap, /更新日: 2026-11-15/);
  assert.match(chap, /更新はそこ。ここは写し/);
});
t(() => { // 正本があれば、載せた数と一致（無いマシンでは飛ばす）
  const src = join(homedir(), "Projects/tadakayo/02_ケアプー事業/_共通/伴走支援FAQ/20261031_伴走支援FAQ_候補一覧.md");
  if (!existsSync(src)) return;
  const rows = readFileSync(src, "utf8").split("\n").filter((l) => /^\| [A-E]\d+ \|/.test(l));
  const ok = rows.filter((l) => /\| (回答あり|一部回答あり)/.test(l));
  assert.equal(ok.length, EXPECT_ITEMS, `正本の「回答あり／一部回答あり」は ${ok.length} 件`);
});
console.log(`manual-support-faq: ${n} tests passed`);
