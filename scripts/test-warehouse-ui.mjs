// 倉庫画面（admin/warehouse.html・js/warehouse.js）と練習用代役の静的検査。node scripts/test-warehouse-ui.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const html = readFileSync(root("admin/warehouse.html"), "utf8");
const js = readFileSync(root("admin/js/warehouse.js"), "utf8");
const stubs = readFileSync(root("admin/js/practice-stubs.js"), "utf8");
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// 画面の骨組み
ok(/name="viewport"/.test(html), "viewport が無い");
ok(/\/js\/warehouse\.js" type="module"/.test(html), "warehouse.js を読んでいない");
ok(/sidebar\.js/.test(html) && /mobilenav\.js/.test(html) && /firebase-config\.js/.test(html), "共通スクリプトが足りない");
for (const id of ["gate", "main", "locSelect", "counts", "tab-requested", "tab-done", "tab-stock", "shipModal", "handModal", "rejModal", "fixModal", "toast"]) ok(html.includes(`id="${id}"`), `#${id} が無い`);
for (const t of ["出荷の依頼", "発送済・受け渡し済（30日）", "在庫"]) ok(html.includes(t), `タブ「${t}」が無い`);
ok(/min-height:44px/.test(html), "タップ領域 44px の指定が無い");
ok(!/overflow-x:\s*scroll/.test(html), "横スクロール指定がある");

// 呼び出しは fn.js 経由のみ・5つの Callable
ok(/from "\/js\/fn\.js"/.test(js), "fn.js から httpsCallable を読んでいない");
ok(!/firebase-functions\.js/.test(js), "Functions を直接 import している");
const called = [...js.matchAll(/httpsCallable\(\s*functions\s*,\s*"([^"]+)"/g)].map((m) => m[1]).sort();
assert.deepEqual(called, ["warehouseFixTracking", "warehouseHandover", "warehouseList", "warehouseReject", "warehouseShip"]); n++;
ok(!/getDocs?\(|collection\(|onSnapshot/.test(js), "倉庫の画面が Firestore を直接読んでいる");

// 権限・共有ロジック
ok(/ALLOWED_ROLES = \["warehouse", "admin", "staff"\]/.test(js), "許可ロールが違う");
ok(/showAccessDenied/.test(js), "拒否画面が無い");
ok(!/location\.href\s*=\s*["']\/(?!index)/.test(js), "index 以外へ移している");
ok(/from "\/js\/warehouse-rules\.js"/.test(js), "warehouse-rules を使っていない");

// 画面の挙動
ok(/localStorage/.test(js) && /try \{ return localStorage/.test(js), "保管場所の記憶が try/catch でない");
ok(/function esc\(/.test(js), "esc が無い");
ok(/other/.test(js) && /くわしい内容を書いてください/.test(js), "「その他」の必須チェックが無い");
ok(/発送済にする/.test(js) && /受け渡し済にする/.test(js) && /出荷できない/.test(js) && /追跡番号を直す/.test(js), "ボタンの文言が足りない");
ok(/code === "internal"/.test(js), "internal の言い換えが無い");
// 動的に差し込む文字列はすべて esc を通す（テンプレート内の ${...} のうち生で出してよいものを許可リストで確認）
const rawOk = /\$\{(esc\(|isPickup\(s\) \? esc\(|Number\(|pickup|badge|dest|itemsHtml|meta\.join|issue|actions|infoLine|lines|reasonList|rows|list\.map|data\.|ship\b|pick\b|i === 0|s\.postalCode \?|s\.phone \?|s\.desiredDate \?|s\.warehouseIssue\.note \?|s\.contactName|mode|code|msg|errText|typeof|r && r\.notified|s\.soNumber|k\b|v\b|n\}|id\}|\()/;
for (const m of js.matchAll(/\$\{([^}]*)\}/g)) ok(rawOk.test("${" + m[1] + "}"), `エスケープ未確認の差し込み: ${m[0]}`);

// 練習用の代役（5つ・2スペース字下げ・外へ出ない）
for (const nm of ["warehouseList", "warehouseShip", "warehouseHandover", "warehouseReject", "warehouseFixTracking"]) {
  ok(new RegExp(`^  async ${nm}\\(`, "m").test(stubs), `代役 ${nm} が無い`);
}
ok(/from "\/js\/warehouse-rules\.js"/.test(stubs), "代役が warehouse-rules を使っていない");
const rej = stubs.slice(stubs.indexOf("async warehouseReject("), stubs.indexOf("async warehouseFixTracking("));
ok(/logSent\("warehouseReject"/.test(rej) && /showPracticeNotice/.test(rej) && !/fetch\(/.test(rej), "warehouseReject の代役が Chat を送らない形でない");
const ship = stubs.slice(stubs.indexOf("async function whMarkShipped"), stubs.indexOf("export const PRACTICE_STUBS"));
ok(/stockByLocation\.\$\{locId\}/.test(ship) && /dueRule: "net14"/.test(ship) && /inventoryMovements/.test(ship) && /shippedByEmail/.test(ship) && /runTransaction/.test(ship), "在庫の引き落としが supply.js と同じ形でない");

// 宛名印刷（Firestore を読まない専用ページ・2026-10-24）
const pj = readFileSync(root("admin/js/warehouse-print.js"), "utf8");
const ph = readFileSync(root("admin/warehouse-print.html"), "utf8");
const roleSrc = readFileSync(root("admin/js/role.js"), "utf8");
ok(/data-act="print"/.test(js) && /宛名を印刷/.test(js) && /選んだものをまとめて印刷/.test(js) && /data-sel=/.test(js), "印刷ボタン・まとめて印刷が無い");
ok(/sessionStorage\.setItem\("warehouse\.printJob"/.test(js) && /window\.open\("\/warehouse-print"/.test(js), "印刷ページへ渡していない");
ok(/sessionStorage\.getItem\(JOB_KEY\)/.test(pj) && /warehouse\.printJob/.test(pj), "印刷ページが sessionStorage を読んでいない");
ok(!/getDocs?\(|collection\(|getDoc\(|doc\(/.test(pj), "印刷ページが Firestore を直接読んでいる");
ok(/差出人が設定されていません（管理者に連絡してください）/.test(pj) && /差出人が設定されていません（管理者に連絡してください）/.test(js), "差出人なしの案内が無い");
ok(/window\.print\(\)/.test(pj) && /warehouse-print\.js/.test(ph), "印刷ページの結線が無い");
ok(/ALLOWED_ROLES = \["warehouse", "admin", "staff"\]/.test(pj), "印刷ページの許可ロールが違う");
{
  const m = roleSrc.match(/export function isWarehousePath\(path\)\{ return (\/.+\/)\.test\(/);
  ok(m, "isWarehousePath が見つからない");
  const re = new RegExp(m[1].slice(1, -1));
  for (const y of ["/warehouse", "/warehouse.html", "/warehouse-print", "/warehouse-print.html"]) ok(re.test(y), `${y} が倉庫の画面でない`);
  for (const x of ["/letterpack-print.html", "/warehouse-x", "/supply.html"]) ok(!re.test(x), `${x} が倉庫の画面になっている`);
}
console.log(`OK test-warehouse-ui: ${n} checks passed`);
