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

console.log(`OK test-mitsumori-layout: ${n} 件合格`);
