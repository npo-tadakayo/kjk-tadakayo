// 見積もりページ（mitsumori.html）の見た目の小さな直し（2026-11-13）。node scripts/test-mitsumori-layout.mjs
// 実ブラウザ（390 幅）での確認は別に行った。ここでは CSS・文言が戻っていないかを文字で確かめる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const h = readFileSync(new URL("../mitsumori.html", import.meta.url), "utf8");
const css = [...h.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n"); // ページの style をすべて
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };
const rule = (sel) => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(css); return m ? m[1] : null; };

t("指摘1: 完了表示の枠は長い半角英数字を枠の中で折り返す", () => {
  const r = rule(".order-done");
  assert.ok(r, ".order-done の指定がある");
  assert.match(r, /overflow-wrap:\s*anywhere/);
  assert.match(r, /min-width:\s*0/);
});

t("指摘9: 申込の画面のボタンは、スイッチのオン・オフに関わらず 44px 以上", () => {
  assert.match(rule("#orderModal .modal-btn") || "", /min-height:\s*44px/);
  assert.equal(rule("#orderModal.consent-mode .modal-btn"), null, "オンのときだけの指定は残さない");
  assert.match(h, /<button type="button" class="modal-btn modal-btn-ok" id="orderSubmit">/);
  assert.match(h, /<button type="button" class="modal-btn modal-btn-cancel" id="orderCancel">/);
});

t("指摘10: 入力前の案内は、横並びでは「左」、820px 以下（縦並び）では「上」のフォーム", () => {
  assert.ok(!h.includes("        左のフォームに事業所さま情報を"), "「左」決め打ちの文言が残っていない");
  assert.match(h, /<span class="lock-dir-wide">左<\/span><span class="lock-dir-narrow">上<\/span>のフォームに事業所さま情報をご入力いただき、/);
  assert.match(rule(".lock-dir-narrow") || "", /display:\s*none/);
  const m = /@media \(max-width: 820px\) \{([\s\S]*?)\n    \}/.exec(css);
  assert.ok(m, "820px の切り替え（縦並び）がある");
  assert.match(m[1], /\.app-body \{ flex-direction: column;/);
  assert.match(m[1], /\.lock-dir-wide \{ display: none; \}/);
  assert.match(m[1], /\.lock-dir-narrow \{ display: inline; \}/);
});

console.log(`OK test-mitsumori-layout: ${n} 件合格`);
