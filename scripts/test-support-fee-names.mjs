// 助成金の内訳B「接続サポート等経費」の呼び名の統一（2026-11-15 次田さん決定＝ブランドポリシー）のテスト。
//   node scripts/test-support-fee-names.mjs
// ①正本（admin/js/support-fee-names.js）の値と、写し（functions・公開ページ・pm-discount）の一致
// ②事業所向けの出力（見積書・領収証・手順書・承諾書・見積もりページ・LP）に、表記ゆれ
//   （「伴走支援費」単独・「接続サポート費用」単独・「接続サポート等経費」単独・「接続サポート費」）が残っていない
//   （社内の管理画面・活動の記録・コメントは対象外）
// ③品名を変えても、sku による振り分け・古い出荷の台数の逆引きが壊れない（品名の文字列に依存した判定を増やしていない）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as N from "../admin/js/support-fee-names.js";
import { PM_DISCOUNT_NAME } from "../admin/js/pm-discount.js";
import { usageOfItem, receiptRowsFromShipment, usageTotalsOf } from "../admin/js/subsidy-amounts.js";
import { renderInvoiceHtml, invoiceTotals, priceIsTaxIncluded } from "../admin/js/invoice-doc.js";
import { DEFAULT_MANUAL_NAME, supportFeeRows } from "../admin/js/manual-support-fee.js";
import { renderSubsidyGuideHtml } from "../admin/js/subsidy-guide.js";

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let n = 0;
const t = (name, fn) => { fn(); n++; };

const LABEL = "接続サポート等経費（伴走支援費）";

// 表示のときの正規化の入力（正本と写しの一致・期待値の確認に使う）
const DISPLAY_CASES = [
  { sku: "support-fee", name: "伴走支援費（補助対象3台）" }, { sku: "support-fee", name: "伴走支援費（補助対象12台）" },
  { sku: "support-fee", name: "伴走支援費" }, { sku: "support-fee", name: "伴走支援費", manual: true },
  { sku: "support-fee", name: "伴走支援費（補助対象3台）", manual: true }, { sku: "support-fee", name: "伴走支援サポート費（11月分）" },
  { sku: "support-fee", name: " 伴走支援費" }, { sku: "support-fee", name: "伴走支援費（補助対象台）" }, { sku: "support-fee", name: "" },
  { sku: "support-fee" }, { sku: "support-fee", name: N.supportFeeItemName(2) }, { sku: "discount", name: "伴走支援費" },
  { sku: "cir415a-01", name: "伴走支援費（補助対象3台）" }, null,
];

// ===== ① 正本と写し =====
t("正本の値", () => {
  assert.equal(N.SUPPORT_FEE_LABEL, LABEL);
  assert.equal(N.SUPPORT_FEE_GUIDE_FIELD, "介護情報基盤との接続サポート費用（伴走支援費）");
  assert.equal(N.SUPPORT_FEE_TOTAL_LABEL, "接続サポート等経費（伴走支援費）の合計（対象B）");
  assert.equal(N.SUPPORT_FEE_INTERNAL, "伴走支援費");
  assert.equal(N.supportFeeItemName(3), "接続サポート等経費（伴走支援費・補助対象3台）");
});
t("写し: functions/support-fee-names.js（CommonJS）は正本と同じ値", () => {
  const F = require("../functions/support-fee-names.js");
  assert.equal(F.SUPPORT_FEE_LABEL, N.SUPPORT_FEE_LABEL);
  for (let i = 0; i <= 12; i++) assert.equal(F.supportFeeItemName(i), N.supportFeeItemName(i));
  for (const it of DISPLAY_CASES) assert.equal(F.displaySupportFeeName(it), N.displaySupportFeeName(it), JSON.stringify(it));
});
t("写し: functions/index.js・practice-seed.js は品名を写しから作る（直書きしない）", () => {
  for (const p of ["functions/index.js", "functions/practice-seed.js"]) {
    const s = read(p);
    assert.match(s, /const \{ supportFeeItemName \} = require\("\.\/support-fee-names"\);/, p);
    assert.match(s, /sku: "support-fee", name: supportFeeItemName\(n\)/, p);
    assert.ok(!s.includes("`伴走支援費（補助対象"), `${p} に旧い品名の直書きが残っている`);
  }
});
t("写し: 画面（supply.js・practice-stubs.js）も品名を正本から作る", () => {
  assert.match(read("admin/js/supply.js"), /sku:"support-fee", name:supportFeeItemName\(a\.subsidyTotal\)/);
  assert.match(read("admin/js/practice-stubs.js"), /sku: "support-fee", name: supportFeeItemName\(n\)/);
  for (const p of ["admin/js/supply.js", "admin/js/practice-stubs.js"]) assert.ok(!read(p).includes("`伴走支援費（補助対象"), p);
});
t("写し: 公開ページ（js/order-consent-page.js）の直書きは正本と同じ", () => {
  const s = read("js/order-consent-page.js");
  const m = /var SUPPORT_FEE_LABEL = "([^"]+)";/.exec(s);
  assert.ok(m, "SUPPORT_FEE_LABEL の直書きが無い");
  assert.equal(m[1], N.SUPPORT_FEE_LABEL);
});
t("写し: PM 値引きの行の名前＝呼び名＋「の値引き」", () => {
  assert.equal(PM_DISCOUNT_NAME, N.SUPPORT_FEE_LABEL + "の値引き");
});
t("任意の金額の行の品名の初期値（画面の入力欄の初期値も同じ）", () => {
  assert.equal(DEFAULT_MANUAL_NAME, N.SUPPORT_FEE_LABEL);
  assert.match(read("admin/supply.html"), new RegExp(`id="shipManualName" value="${N.SUPPORT_FEE_LABEL.replace(/[()（）]/g, "\\$&")}"`));
});

// ===== ② 事業所向けの出力に表記ゆれが残っていない =====
// コメント（// … ・/* … */・<!-- … -->）を外した本文を調べる。
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");
}
// 表記ゆれを探す。戻り値は見つかった前後の文字列の配列（空なら合格）
function namingIssues(text) {
  const bad = [];
  const around = (i) => text.slice(Math.max(0, i - 15), i + 25).replace(/\s+/g, " ");
  for (const m of text.matchAll(/伴走支援費/g)) {
    const before = text.slice(Math.max(0, m.index - 10), m.index);
    if (!/(接続サポート等経費|接続サポート費用)（$/.test(before)) bad.push(`「伴走支援費」単独: …${around(m.index)}…`);
  }
  for (const m of text.matchAll(/接続サポート費用/g)) {
    if (!text.startsWith("（伴走支援費", m.index + m[0].length)) bad.push(`「接続サポート費用」単独: …${around(m.index)}…`);
  }
  for (const m of text.matchAll(/接続サポート等経費/g)) {
    const after = m.index + m[0].length;
    if (text.startsWith("（伴走支援費", after)) continue;
    if (text[after] === "」") continue; // 助成金の公式の呼び名を「」で引用しているところ（手引きの用途・助成対象の区分）
    bad.push(`「接続サポート等経費」単独: …${around(m.index)}…`);
  }
  for (const m of text.matchAll(/接続サポート費(?!用)/g)) bad.push(`「接続サポート費」: …${around(m.index)}…`);
  return bad;
}
t("表記ゆれの検出そのものが効く（陽性対照）", () => {
  assert.equal(namingIssues("伴走支援費 ¥50,000").length, 1);
  assert.equal(namingIssues("接続サポート費用（税込）").length, 1);
  assert.equal(namingIssues("カードリーダー・接続サポート等経費として").length, 1);
  assert.equal(namingIssues("接続サポート費の申請").length, 1);
  assert.equal(namingIssues(`${LABEL}・${N.SUPPORT_FEE_GUIDE_FIELD}・「接続サポート等経費」・${N.supportFeeItemName(2)}`).length, 0);
  assert.ok(stripComments("a // 伴走支援費\nb").indexOf("伴走支援費") < 0 && stripComments('x="https://a"').includes("https://a"));
});
// 事業所に出る文書・画面（ファイル全体が事業所向け）
const CUSTOMER_FILES = [
  "admin/js/quote-doc.js",        // 見積書（PDF・印刷）
  "admin/js/quote-group-doc.js",  // 法人まとめの見積書
  "admin/js/invoice-doc.js",      // 請求書（品名は出荷の明細）
  "admin/js/subsidy-guide.js",    // 助成金の申請手順書
  "js/order-consent-page.js",     // 承諾書（公開ページ）
  "mitsumori.html",               // 見積もりページ（公開）
  "index.html",                   // LP（公開）
  "scripts/quote-cover/build.mjs", // 合計お見積もりのご案内（法人内ご決裁用・PDF）
];
// 除外する箇所（ファイルごとに、そのままの文字列）。除外は1か所ずつ・必ず実在すること（古い除外が残らないように）
const EXEMPT = {
  // 帯グラフの中の文字（高さ 11mm に統一形が収まらない。凡例で統一形を示す）
  "scripts/quote-cover/build.mjs": ['background:var(--red)">伴走支援費<br>'],
};
for (const p of CUSTOMER_FILES) {
  t(`事業所向け: ${p} に表記ゆれが無い`, () => {
    let text = stripComments(read(p));
    for (const ex of EXEMPT[p] || []) {
      assert.equal(text.split(ex).length - 1, 1, `${p}: 除外する箇所「${ex}」がちょうど1か所ない`);
      text = text.replace(ex, "");
    }
    const bad = namingIssues(text);
    assert.deepEqual(bad, [], `${p}\n${bad.join("\n")}`);
  });
}
// 領収証（supply-print.js は社内の画面も同じファイルにあるので、領収証の描画の範囲だけ）
t("事業所向け: 領収証（supply-print.js の用途区分〜領収証の描画）に表記ゆれが無い", () => {
  const s = read("admin/js/supply-print.js");
  const a = s.indexOf("const RCPT_KINDS="), b = s.indexOf("// ===== 返金明細書");
  assert.ok(a > 0 && b > a, "範囲が見つからない");
  const part = stripComments(s.slice(a, b));
  assert.deepEqual(namingIssues(part), []);
  assert.match(part, /\["B",SUPPORT_FEE_LABEL\]/);
  assert.match(part, /\$\{SUPPORT_FEE_TOTAL_LABEL\}/);
  assert.match(part, /介護情報基盤の導入（カードリーダー・\$\{SUPPORT_FEE_LABEL\}）として/);
});
t("事業所向け: 手順書の出力（描画した HTML）", () => {
  const h = renderSubsidyGuideHtml({ aIncl: 66000, bIncl: 64000, units: 3, readerName: "テスト", corpName: "法人", officeName: "事業所", rcptNo: "R-1", fromInvoice: false });
  assert.deepEqual(namingIssues(h.replace(/<[^>]+>/g, "")), []);
  assert.ok(h.includes(`${N.SUPPORT_FEE_GUIDE_FIELD}・税込の総額`), "申請画面の欄の呼び名");
  assert.ok(h.includes(N.SUPPORT_FEE_TOTAL_LABEL), "領収証のどこか（対象B）");
  assert.ok(h.includes(`${N.SUPPORT_FEE_GUIDE_FIELD}（B）と交付額`), "見出し");
});
t("事業所向け: 承諾書の出力（描画した HTML）", () => {
  globalThis.window = globalThis.window || {};
  // eslint-disable-next-line no-new-func
  const src = read("js/order-consent-page.js");
  const mod = { exports: {} };
  new Function("module", "exports", "window", src)(mod, mod.exports, globalThis.window);
  const P = mod.exports.quotesHtml ? mod.exports : globalThis.window.OrderConsentPage;
  assert.ok(P && P.quotesHtml, "quotesHtml が読めない");
  const h = P.quotesHtml([{ estNo: "EST-1", version: 1, items: [], amounts: { totalIncl: 64000, accompanyFee: 50000, discount: 29500, grantAmt: 64000, selfPay: 0 } }]);
  assert.ok(h.includes(`（うち${LABEL} ¥50,000・金額調整 −¥29,500）`), h);
  assert.deepEqual(namingIssues(h), []);
});
t("事業所向け: 確認メール等の値引きの1行は統一形（functions/index.js）", () => {
  const s = read("functions/index.js");
  assert.equal(s.split(`（${LABEL}から）`).length - 1, 3);
  assert.ok(!/うち伴走支援費/.test(s));
});

t("折り返し: 合計欄の幅は呼び名が1行に収まる 330px（見積書と見積もりページで同じ。狭い画面では親の幅まで）", () => {
  // 2026-11-15 ヘッドレス Chrome で実測: 330px なら「接続サポート等経費（伴走支援費）・税込 ¥150,000」が1行、270px だと2行
  assert.match(read("admin/js/quote-doc.js"), /\.qdoc-totals\{width:330px;\}/);
  assert.match(read("mitsumori.html"), /\.est-totals \{ width: 330px; max-width: 100%; \}/);
});

// ===== ③ 品名に依存した判定を増やしていない・古い出荷も読める =====
t("表示のときの正規化（displaySupportFeeName）: 旧い自動の品名だけ新しい呼び名に・それ以外はそのまま", () => {
  const D = N.displaySupportFeeName;
  assert.equal(D({ sku: "support-fee", name: "伴走支援費（補助対象3台）" }), "接続サポート等経費（伴走支援費・補助対象3台）");
  assert.equal(D({ sku: "support-fee", name: "伴走支援費（補助対象12台）" }), "接続サポート等経費（伴走支援費・補助対象12台）");
  assert.equal(D({ sku: "support-fee", name: "伴走支援費" }), LABEL);
  assert.equal(D({ sku: "support-fee", name: "伴走支援費", manual: true }), "伴走支援費");                 // 任意の金額の行は触らない
  assert.equal(D({ sku: "support-fee", name: "伴走支援費（補助対象3台）", manual: true }), "伴走支援費（補助対象3台）");
  assert.equal(D({ sku: "support-fee", name: "伴走支援サポート費（11月分）" }), "伴走支援サポート費（11月分）"); // 人が直した品名は触らない
  assert.equal(D({ sku: "support-fee", name: " 伴走支援費" }), " 伴走支援費");
  assert.equal(D({ sku: "support-fee", name: "伴走支援費（補助対象台）" }), "伴走支援費（補助対象台）");
  assert.equal(D({ sku: "support-fee", name: "" }), "");
  assert.equal(D({ sku: "support-fee" }), undefined);
  assert.equal(D({ sku: "support-fee", name: N.supportFeeItemName(2) }), N.supportFeeItemName(2));
  assert.equal(D({ sku: "discount", name: "伴走支援費" }), "伴走支援費");                                  // sku が違えば触らない
  assert.equal(D({ sku: "cir415a-01", name: "伴走支援費（補助対象3台）" }), "伴走支援費（補助対象3台）");
  assert.equal(D(null), undefined);
});
// デプロイ前に作った（旧い品名の）出荷から、請求書と領収証を出す
const BT3 = { sku: "cir415a-01", name: "介護情報基盤 汎用カードリーダ CIR415A", qty: 3, unitPrice: 14500 };
const oldShip = (fee) => ({ soNumber: "SH-2026-0999", shipType: "direct", company: "テスト事業所", items: [BT3, fee, { sku: "discount", name: "金額調整", qty: 1, unitPrice: -29500, nonStock: true }] });
t("旧い品名の出荷: 請求書の明細は新しい呼び名で出る・保存値は変わらない・合計は変わらない", () => {
  const fee = { sku: "support-fee", name: "伴走支援費（補助対象3台）", qty: 1, unitPrice: 50000, nonStock: true };
  const s = oldShip(fee);
  const before = JSON.stringify(s);
  const h = renderInvoiceHtml(s, {}, { issueDate: "2026年11月15日" });
  assert.ok(h.includes("<td>接続サポート等経費（伴走支援費・補助対象3台）<"), "請求書の明細が新しい呼び名になっていない");
  assert.ok(!h.includes(">伴走支援費（補助対象3台）<"), "請求書に旧い品名が残っている");
  assert.equal(JSON.stringify(s), before, "出荷のデータを書き換えている");
  assert.equal(invoiceTotals(s).total, 64000);
  // 新しい品名の出荷と同じ請求書になる（品名以外は1文字も同じ）
  const s2 = oldShip({ ...fee, name: N.supportFeeItemName(3) });
  assert.equal(renderInvoiceHtml(s2, {}, { issueDate: "2026年11月15日" }), h);
});
t("旧い品名の出荷: 領収証の初期明細も新しい呼び名・明細合計＝請求書の合計（旧・新・任意の行で同じ）", () => {
  for (const fee of [
    { sku: "support-fee", name: "伴走支援費（補助対象3台）", qty: 1, unitPrice: 50000, nonStock: true },
    { sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 50000, nonStock: true },
    { sku: "support-fee", name: N.supportFeeItemName(3), qty: 1, unitPrice: 50000, nonStock: true },
    { sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 50000, nonStock: true, manual: true },
  ]) {
    const s = oldShip(fee);
    const rows = receiptRowsFromShipment(s);
    const b = rows.find((r) => r.kind === "B" && r.price === 50000);
    assert.equal(b.name, fee.manual ? "伴走支援費" : N.displaySupportFeeName(fee));
    const u = usageTotalsOf(rows, priceIsTaxIncluded(s));
    assert.equal(u.A + u.B + u.X, invoiceTotals(s).total, fee.name);
    assert.equal(u.B, 20500, fee.name);
  }
});
t("振り分けは sku で決まる（品名が旧・新・任意のどれでも B）", () => {
  for (const name of ["伴走支援費（補助対象3台）", "伴走支援費", N.supportFeeItemName(3), N.SUPPORT_FEE_LABEL, "なんでも"]) {
    assert.equal(usageOfItem({ sku: "support-fee", name, qty: 1, unitPrice: 1 }), "B", name);
  }
  assert.equal(usageOfItem({ sku: "cir415a-01", name: N.supportFeeItemName(3), qty: 1, unitPrice: 1 }), "A"); // 品名に呼び名が入っていても sku が機器なら A
  assert.equal(supportFeeRows([{ sku: "support-fee", name: "伴走支援費（補助対象2台）" }, { sku: "support-fee", name: N.supportFeeItemName(2) }]).length, 2);
});
t("領収証の行: 旧い自動の品名は表示のとき新しい呼び名に・品名の無い行は既定の名前", () => {
  const rows = receiptRowsFromShipment({ items: [
    { sku: "support-fee", name: "伴走支援費（補助対象3台）", qty: 1, unitPrice: 50000 },
    { sku: "support-fee", name: "", qty: 1, unitPrice: 1000 },
  ] });
  assert.equal(rows[0].name, "接続サポート等経費（伴走支援費・補助対象3台）");
  assert.equal(rows[1].name, N.SUPPORT_FEE_LABEL); // 2026-11-15 レビュー中-2: 品名の無い行は事業所向けの呼び名
  assert.ok(rows.every((r) => r.kind === "B"));
});
t("古い出荷の台数の逆引き（supply.js の /補助対象(\\d+)台/）は旧・新どちらの品名でも効く", () => {
  const src = read("admin/js/supply.js");
  assert.ok(src.includes("const m=/補助対象(\\d+)台/.exec(supportItem.name||\"\");"), "逆引きの正規表現が変わっている");
  const re = /補助対象(\d+)台/;
  assert.equal(re.exec("伴走支援費（補助対象2台）")[1], "2");
  assert.equal(re.exec(N.supportFeeItemName(2))[1], "2");
});
t("品名で見分ける検査そのものが効く（陽性対照）", () => {
  const probe = (code) => /\/\^?(伴走支援費|接続サポート)[^/\n]*\/[gimsuy]*\.(test|exec)\(/.test(code) || /\.match\(\s*\/\^?(伴走支援費|接続サポート)/.test(code);
  assert.ok(probe('if (/伴走支援費/.test(i.name))'));
  assert.ok(probe('const m=/^伴走支援費（補助対象(\\d+)台）$/.exec(name)'));
  assert.ok(probe('String(i.name).match(/接続サポート/)'));
  assert.ok(!probe('const m=/補助対象(\\d+)台/.exec(supportItem.name||"")'));
});
t("品名の文字列で伴走支援費の行を見分けるコードを足していない（admin/js・functions・js）", () => {
  const files = ["admin/js/supply.js", "admin/js/subsidy-amounts.js", "admin/js/manual-support-fee.js", "admin/js/pm-discount.js",
    "admin/js/ship-flow.js", "admin/js/invoice-doc.js", "admin/js/supply-print.js", "functions/index.js", "js/order-consent-page.js"];
  for (const p of files) {
    const s = stripComments(read(p));
    assert.ok(!/(includes|startsWith|indexOf|endsWith)\(\s*["'`](伴走支援費|接続サポート)/.test(s), `${p}: 品名の文字列で見分けている`);
    assert.ok(!/===\s*["'`](伴走支援費|接続サポート)/.test(s), `${p}: 品名の文字列と比べている`);
    // 正規表現リテラルで品名を見る形（/伴走支援費…/.test( ・ .exec( ・ .match(/…/)）。
    // 例外: 表示のときの正規化（support-fee-names.js の OLD_ITEM_NAME＝この判定の正本・sku と manual を先に見る）は対象ファイルに入れていない
    assert.ok(!/\/\^?(伴走支援費|接続サポート)[^/\n]*\/[gimsuy]*\.(test|exec)\(/.test(s), `${p}: 正規表現リテラルで品名を見ている（.test/.exec）`);
    assert.ok(!/\.match\(\s*\/\^?(伴走支援費|接続サポート)/.test(s), `${p}: 正規表現リテラルで品名を見ている（.match）`);
  }
});

console.log(`OK test-support-fee-names: 合計 ${n} 件合格`);
