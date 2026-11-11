// 助成金の A・B・X の振り分け（admin/js/subsidy-amounts.js）のテスト。node scripts/test-subsidy-amounts.mjs
// ①共通化の前の領収証・手順PDFの計算（下の OLD_*。2026-11-12 時点の supply-print.js から写したもの）と、
//   1円も変わらないこと（決まった例＋乱数の出荷 2,000 件）
// ②案件の「申請で入れる値」（正本の選び方・対象外の台数・複数出荷・手入力との突き合わせ）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  usageOfItem, taxFnsOf, receiptRowsFromShipment, usageTotalsOf, guideAmountsFromShipment,
  subsidyCountsFromShipment, subsidyCountsFromQuote, shipmentSubsidyAmounts, caseSubsidyAmounts,
  inputMismatches, sourceText, BT_SKU,
} from "../admin/js/subsidy-amounts.js";
import { priceIsTaxIncluded, itemPurposeNote, invoiceTotals } from "../admin/js/invoice-doc.js";
import Pricing from "../admin/js/estimate-pricing.js";

let n = 0;
const t = (fn) => { fn(); n++; };

// ===== 共通化の前の計算（supply-print.js から写したもの。比べるためだけに置く） =====
function OLD_rowsInit(s) {
  const items = s.items || [];
  const rowsInit = items.map(i => {
    const sku = String(i.sku || "");
    const qty = Number(i.qty) || 0, price = Number(i.unitPrice) || 0;
    const note = itemPurposeNote(sku);
    if (sku === "support-fee") return { kind: "B", name: i.name || "介護情報基盤との接続サポート等経費", note, qty, price };
    if (sku === "discount") return { kind: "B", name: i.name || "値引き", note: "", qty, price };
    return { kind: "A",
      name: i.sku ? `カードリーダー（型名: ${i.sku}・マイナ資格確認アプリ対応）` : (i.name || "カードリーダー"),
      note, qty, price };
  });
  if (Number(s.shippingFee) > 0) rowsInit.push({ kind: "X", name: s.shippingLabel || "送料", qty: 1, price: Number(s.shippingFee) });
  return rowsInit;
}
// wireReceiptEditor の recompute（DOM を外して、表示する aIncl・bIncl・xIncl・abIncl・rcptGrand と税抜・税額だけ取り出したもの）
function OLD_recompute(rows, ti) {
  const incl = ti ? (v => v) : (e => e + Math.floor(e * 0.1));
  const taxOf = ti ? (v => Math.floor(v * 10 / 110)) : (e => Math.floor(e * 0.1));
  const exclOf = ti ? (v => v - Math.floor(v * 10 / 110)) : (e => e);
  const sub = { A: 0, B: 0, X: 0 };
  for (const r of rows) { const amt = r.qty * r.price; sub[r.kind] = (sub[r.kind] || 0) + amt; }
  return {
    aExcl: exclOf(sub.A), aTax: taxOf(sub.A), aIncl: incl(sub.A),
    bExcl: exclOf(sub.B), bTax: taxOf(sub.B), bIncl: incl(sub.B), abIncl: incl(sub.A) + incl(sub.B),
    xExcl: exclOf(sub.X), xTax: taxOf(sub.X), xIncl: incl(sub.X), grand: incl(sub.A) + incl(sub.B) + incl(sub.X),
  };
}
function NEW_recompute(rows, ti) {
  const { incl, taxOf, exclOf } = taxFnsOf(ti);
  const sub = { A: 0, B: 0, X: 0 };
  for (const r of rows) { const amt = r.qty * r.price; sub[r.kind] = (sub[r.kind] || 0) + amt; }
  const u = usageTotalsOf(rows, ti);
  assert.deepEqual(u, { A: incl(sub.A), B: incl(sub.B), X: incl(sub.X) }); // usageTotalsOf も同じ値
  return {
    aExcl: exclOf(sub.A), aTax: taxOf(sub.A), aIncl: incl(sub.A),
    bExcl: exclOf(sub.B), bTax: taxOf(sub.B), bIncl: incl(sub.B), abIncl: incl(sub.A) + incl(sub.B),
    xExcl: exclOf(sub.X), xTax: taxOf(sub.X), xIncl: incl(sub.X), grand: incl(sub.A) + incl(sub.B) + incl(sub.X),
  };
}
// subsidyGuideData の「請求書から送るとき」の分岐
function OLD_guide(d) {
  const incl = priceIsTaxIncluded(d);
  const line = (i) => (Number(i.qty) || 0) * (Number(i.unitPrice) || 0);
  const withTax = (sub) => incl ? sub : sub + Math.floor(sub * 0.1);
  const items = d.items || [];
  const isB = (i) => i.sku === "support-fee" || i.sku === "discount";
  const aItems = items.filter(i => !isB(i) && !i.nonStock);
  return { aIncl: withTax(aItems.reduce((n, i) => n + line(i), 0)), bIncl: withTax(items.filter(isB).reduce((n, i) => n + line(i), 0)),
    units: aItems.reduce((n, i) => n + (Number(i.qty) || 0), 0), readerName: [...new Set(aItems.map(i => i.sku).filter(Boolean))].join("／") };
}
const sameAsBefore = (s) => {
  const oldRows = OLD_rowsInit(s), newRows = receiptRowsFromShipment(s);
  assert.deepEqual(newRows, oldRows);
  const ti = priceIsTaxIncluded(s);
  assert.deepEqual(NEW_recompute(newRows, ti), OLD_recompute(oldRows, ti));
  assert.deepEqual(guideAmountsFromShipment(s), OLD_guide(s));
};

// ===== 出荷の例 =====
const P = Pricing;
const bt = (qty, price = P.BT_PRICE) => ({ sku: P.SKU.BT, name: "CIR415A", qty, unitPrice: price, connection: "Bluetooth／USB Type-C" });
const usbA = (qty, price = P.USB_PRICE) => ({ sku: P.SKU.USB_A, name: "CIR315A", qty, unitPrice: price });
const usbC = (qty, price = P.USB_PRICE) => ({ sku: P.SKU.USB_C, name: "CIR315A-C", qty, unitPrice: price });
const fee = (v, n) => ({ sku: "support-fee", name: `伴走支援費（補助対象${n}台）`, qty: 1, unitPrice: v, nonStock: true });
const manualFee = (v) => ({ sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: v, nonStock: true, manual: true });
const disc = (v) => ({ sku: "discount", name: "金額調整", qty: 1, unitPrice: -v, nonStock: true });
// 見積もりから作る出荷（functions の shipmentItemsFromQuote と同じ形）
function shipFromQuote(plan, b, u, bx = 0, ux = 0, extra = {}) {
  const c = P.computeAmounts(plan, b, u, bx, ux);
  const items = [];
  if (b + bx > 0) items.push(bt(b + bx));
  if (u + ux > 0) items.push(usbA(u + ux));
  if (c.accFeeIncl > 0) items.push(fee(c.accFeeIncl, c.subsidyTotal));
  if (c.discount > 0) items.push(disc(c.discount));
  return { _id: extra._id || "s1", soNumber: extra.soNumber || "SH-2026-0001", status: "shipped", items,
    subsidyCategory: plan, subsidyQty: { bt: b, usb: u }, ...extra, calc: c };
}

// ① 今の領収証と同じ結果になる（決まった例）
const FIXED = [
  shipFromQuote("houmon", 1, 0),                         // BT1台・伴走支援60,000・値引き
  shipFromQuote("houmon", 0, 3),                         // USB3台
  shipFromQuote("houmon", 1, 2, 0, 0, { shippingFee: 520, shippingLabel: "レターパックプラス" }), // 送料あり
  shipFromQuote("kyojyu", 2, 0, 1, 0),                   // 対象外の追加1台
  shipFromQuote("other", 0, 1, 0, 2),
  { _id: "m1", soNumber: "SH-2026-0100", items: [usbA(2), manualFee(30200)] },               // 任意の伴走支援費
  { _id: "d1", soNumber: "SH-2026-0200", shipType: "dropship", partnerEmail: "p@example.jp", items: [bt(3, 11000), usbC(2, 5000)], shippingFee: 1000 }, // 認定事業者（税抜）
  { _id: "e1", soNumber: "SH-2026-0300", items: [] },
  { _id: "n1", soNumber: "SH-2026-0400", items: [{ sku: "", name: "その他", qty: 1, unitPrice: 999 }, { sku: "x", qty: 1, unitPrice: 5, nonStock: true }] },
];
for (const s of FIXED) t(() => sameAsBefore(s));

// 乱数の出荷 2,000 件（品番・数量・単価・税抜/税込・送料・nonStock・欠けた値を混ぜる）
let seed = 20261112;
const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
const SKUS = [P.SKU.BT, P.SKU.USB_A, P.SKU.USB_C, "support-fee", "discount", "", "other", undefined];
for (let k = 0; k < 2000; k++) {
  const items = [];
  const m = rnd(6);
  for (let j = 0; j < m; j++) {
    const sku = SKUS[rnd(SKUS.length)];
    const it = { sku, qty: rnd(5) === 0 ? "" : rnd(5), unitPrice: rnd(7) === 0 ? undefined : (rnd(3) === 0 ? -rnd(30000) : rnd(70000)) };
    if (rnd(2)) it.name = `品${j}`;
    if (rnd(3) === 0) it.nonStock = true;
    items.push(it);
  }
  const s = { items, shippingFee: rnd(3) === 0 ? rnd(2000) : 0 };
  if (rnd(4) === 0) s.shipType = "dropship";
  if (rnd(6) === 0) s.partnerEmail = "p@example.jp";
  if (rnd(3) === 0) s.shippingLabel = "ゆうパック";
  sameAsBefore(s);
}
n++;

// supply-print.js が共通の関数を使っている（自前の振り分けが残っていない）
t(() => {
  const src = readFileSync(new URL("../admin/js/supply-print.js", import.meta.url), "utf8");
  assert.match(src, /import \{ receiptRowsFromShipment, taxFnsOf, guideAmountsFromShipment \} from "\/js\/subsidy-amounts\.js"/);
  assert.match(src, /rowsInit = receiptRowsFromShipment\(s\);/);
  assert.match(src, /taxFnsOf\(rcptTaxIncluded\)/);
  assert.match(src, /guideAmountsFromShipment\(d\)/);
  assert.ok(!src.includes('if(sku==="support-fee") return { kind:"B"'), "領収証の振り分けが supply-print.js に残っている");
  assert.ok(!src.includes("const withTax = (sub)"), "手順PDFの丸めが supply-print.js に残っている");
});

// ===== 用途区分 =====
t(() => {
  assert.equal(usageOfItem({ sku: "support-fee" }), "B");
  assert.equal(usageOfItem({ sku: "discount" }), "B");
  assert.equal(usageOfItem({ sku: P.SKU.BT }), "A");
  assert.equal(usageOfItem({}), "A");
  assert.equal(usageOfItem(null), "A");
  assert.equal(BT_SKU, P.SKU.BT);
});

// ===== 補助対象の台数 =====
t(() => {
  assert.deepEqual(subsidyCountsFromShipment(shipFromQuote("houmon", 1, 2)), { bt: 1, usb: 2, from: "出荷の補助対象台数" });
  // 任意の伴走支援費（subsidyQty は {0,0}＝保存していない）
  assert.equal(subsidyCountsFromShipment({ items: [usbA(2), manualFee(30200)], subsidyQty: { bt: 0, usb: 0 } }), null);
  // 自動の伴走支援費が無いのに台数だけある（古いデータ）は使わない
  assert.equal(subsidyCountsFromShipment({ items: [usbA(2)], subsidyQty: { bt: 0, usb: 2 } }), null);
  assert.equal(subsidyCountsFromShipment({ items: [] }), null);
  const q = { estNo: "EST-2026-0007", items: [{ sku: P.SKU.BT, subsidyQty: 1, extraQty: 1 }, { sku: P.SKU.USB_C, subsidyQty: 1, extraQty: 0 }] };
  assert.deepEqual(subsidyCountsFromQuote(q), { bt: 1, usb: 1, from: "見積もり EST-2026-0007 の補助対象台数" });
  assert.equal(subsidyCountsFromQuote({ items: [] }), null);
  assert.equal(subsidyCountsFromQuote(null), null);
});

// ===== 出荷1件: 正本＝出荷の明細（領収証は未発行） =====
t(() => {
  const s = shipFromQuote("houmon", 1, 0); // 14,500＋60,000 → 値引き 10,500 → 64,000
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r.source, "shipment");
  assert.equal(r.aTotal, 14500); assert.equal(r.aSubsidy, 14500); assert.equal(r.aExtra, 0);
  assert.equal(r.b, 60000 - 10500); assert.equal(r.ab, 64000); assert.equal(r.x, 0);
  assert.equal(r.split, "none"); assert.equal(r.units, 1); assert.equal(r.subsidyUnits, 1);
  assert.deepEqual(r.skuQty, { [P.SKU.BT]: 1 });
  assert.equal(sourceText(r), "出荷 SH-2026-0001 の明細（領収証は未発行）");
  assert.equal(r.receiptAmountIncl, null);
});
// 送料あり（X は A・B に入らない）
t(() => {
  const s = shipFromQuote("houmon", 1, 2, 0, 0, { shippingFee: 520 });
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r.x, 520); // 領収証の初期明細と同じ（送料は税抜の保存値をそのまま X に入れる）
  assert.equal(r.ab, Math.min(64000, s.calc.subsidyPartTotal));
  assert.equal(r.aSubsidy, 14500 + 6500 * 2);
});
// 対象外の追加台数あり: A と台数は補助対象分だけ、対象外は別
t(() => {
  const s = shipFromQuote("kyojyu", 2, 0, 1, 0); // BT 補助2台＋対象外1台
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r.split, "split");
  assert.equal(r.aTotal, 14500 * 3);
  assert.equal(r.aSubsidy, 14500 * 2); assert.equal(r.aExtra, 14500);
  assert.equal(r.subsidyUnits, 2); assert.equal(r.extraUnits, 1); assert.equal(r.units, 3);
  assert.equal(r.ab, s.calc.subsidyPartTotal); // 見積もりの補助対象パートと一致（55,000）
  assert.equal(r.ab, 55000);
});
// USB の対象外（見積もりの台数で区別）
t(() => {
  const s = shipFromQuote("other", 0, 1, 0, 2);
  delete s.subsidyQty; // 古い出荷: 出荷に台数が無い
  const q = { estNo: "EST-1", items: [{ sku: P.SKU.USB_A, subsidyQty: 1, extraQty: 2 }] };
  const r0 = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r0.split, "unknown"); assert.equal(r0.aSubsidy, null); assert.equal(r0.ab, null);
  assert.match(r0.reason, /区別できません/);
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromQuote(q));
  assert.equal(r.split, "split"); assert.equal(r.aSubsidy, 6500); assert.equal(r.aExtra, 13000);
  assert.equal(r.countsFrom, "見積もり EST-1 の補助対象台数");
});
// 任意の伴走支援費（台数が保存されない）→ 区別できない（推測で分けない）
t(() => {
  const s = { _id: "m1", soNumber: "SH-2026-0100", items: [usbA(2), manualFee(30200)], subsidyQty: { bt: 0, usb: 0 } };
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r.split, "unknown"); assert.equal(r.aTotal, 13000); assert.equal(r.b, 30200);
  assert.equal(r.aSubsidy, null); assert.equal(r.subsidyUnits, null);
});
// 台数が出荷より多い → 区別できない
t(() => {
  const s = { items: [bt(1), fee(60000, 2)], subsidyQty: { bt: 2, usb: 0 } };
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r.split, "unknown"); assert.match(r.reason, /より多く/);
});
// 同じ種類で単価の違う行 → 対象外の金額を区別できない
t(() => {
  const s = { items: [usbA(1, 6500), usbC(1, 6000), fee(55000, 1)], subsidyQty: { bt: 0, usb: 1 } };
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r.split, "unknown"); assert.match(r.reason, /単価の違う行/);
});

// ===== 出荷1件: 正本＝領収証の保存値 =====
t(() => {
  const s = shipFromQuote("houmon", 1, 0, 0, 0, { receiptNo: "RCPT-2026-0001", receiptAmountIncl: 64000 });
  // 領収証で値引きを手で直した（出荷の明細と違う）→ 領収証の値を使う
  const receipt = {
    receiptNo: "RCPT-2026-0001", amountIncl: 64000,
    items: [
      { usage: "A", name: "カードリーダー（型名: cir415a-01・…）", qty: 1, unitPrice: 14500 },
      { usage: "B", name: "伴走支援費", qty: 1, unitPrice: 60000 },
      { usage: "B", name: "値引き", qty: 1, unitPrice: -11000 },
    ],
    usageTotalsIncl: { A: 14500, B: 49000, X: 0 },
  };
  const r = shipmentSubsidyAmounts(s, receipt, subsidyCountsFromShipment(s));
  assert.equal(r.source, "receipt");
  assert.equal(r.b, 49000); assert.equal(r.ab, 63500); assert.equal(r.receiptAmountIncl, 64000);
  assert.equal(sourceText(r), "領収証 No.RCPT-2026-0001 の値");
});
// 領収証＋対象外の台数
t(() => {
  const s = shipFromQuote("kyojyu", 2, 0, 1, 0);
  const rows = receiptRowsFromShipment(s);
  const receipt = { receiptNo: "RCPT-X", amountIncl: 69500,
    items: rows.map((r) => ({ usage: r.kind, name: r.name, qty: r.qty, unitPrice: r.price })),
    usageTotalsIncl: usageTotalsOf(rows, true) };
  const r = shipmentSubsidyAmounts(s, receipt, subsidyCountsFromShipment(s));
  assert.equal(r.split, "split"); assert.equal(r.aSubsidy, 29000); assert.equal(r.aExtra, 14500); assert.equal(r.ab, 55000);
  // 領収証のカードリーダーの台数を手で変えていた → 区別できない
  const edited = { ...receipt, items: receipt.items.map((x) => x.usage === "A" ? { ...x, qty: 2 } : x) };
  const r2 = shipmentSubsidyAmounts(s, edited, subsidyCountsFromShipment(s));
  assert.equal(r2.split, "unknown"); assert.match(r2.reason, /領収証のカードリーダーの台数/);
});
// 【中1】領収証で A の単価を直して発行したとき、対象外の分は領収証の単価で引く（出荷の単価は使わない）
t(() => {
  const s = { _id: "r1", soNumber: "SH-R1", receiptNo: "RCPT-R1", items: [bt(3, 14800), fee(55000, 2), disc(26600)], subsidyQty: { bt: 2, usb: 0 } };
  const receipt = { receiptNo: "RCPT-R1", amountIncl: 0,
    items: [
      { usage: "A", name: "カードリーダー（型名: cir415a-01・…）", qty: 3, unitPrice: 14000 },
      { usage: "B", name: "伴走支援費", qty: 1, unitPrice: 55000 },
      { usage: "B", name: "金額調整", qty: 1, unitPrice: -27000 },
    ],
    usageTotalsIncl: { A: 42000, B: 28000, X: 0 } };
  const r = shipmentSubsidyAmounts(s, receipt, subsidyCountsFromShipment(s));
  assert.equal(r.split, "split");
  assert.equal(r.aSubsidy, 28000); assert.equal(r.aExtra, 14000); assert.equal(r.ab, 56000);
  // 領収証の A 行の単価が1種類でない → 区別できない（推測で分けない）
  const mixed = { ...receipt, items: [
    { usage: "A", name: "カードリーダーa", qty: 2, unitPrice: 14000 },
    { usage: "A", name: "カードリーダーb", qty: 1, unitPrice: 14800 },
    receipt.items[1], receipt.items[2]] };
  const r2 = shipmentSubsidyAmounts(s, mixed, subsidyCountsFromShipment(s));
  assert.equal(r2.split, "unknown"); assert.equal(r2.aSubsidy, null);
  assert.match(r2.reason, /領収証のカードリーダーの行の単価が1種類でない/);
  // 対象外が無ければ単価は関係なく、領収証の A をそのまま使う
  const r3 = shipmentSubsidyAmounts({ ...s, subsidyQty: { bt: 3, usb: 0 } }, mixed, { bt: 3, usb: 0, from: "x" });
  assert.equal(r3.split, "none"); assert.equal(r3.aSubsidy, 42000);
});
// 認定事業者（税抜）でも領収証と同じ丸め: 対象外を引いたあとで1回だけ税を足す
t(() => {
  const s = { _id: "d1", shipType: "dropship", partnerEmail: "p@example.jp", items: [bt(3, 11111), fee(50000, 2)], subsidyQty: { bt: 2, usb: 0 } };
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  const { incl } = taxFnsOf(false);
  assert.equal(r.taxIncluded, false);
  assert.equal(r.aTotal, incl(33333)); assert.equal(r.aSubsidy, incl(22222)); assert.equal(r.aSubsidy + r.aExtra, r.aTotal);
});

// ===== 案件: 複数の出荷（合計と内訳）・キャンセルは除く・交付見込み =====
t(() => {
  const s1 = shipFromQuote("houmon", 1, 0, 0, 0, { _id: "a", soNumber: "SH-A" });
  const s2 = { _id: "b", soNumber: "SH-B", status: "invoiced", items: [usbA(1)] , subsidyQty: { bt: 0, usb: 0 } }; // 追加購入（伴走支援費なし）
  const s3 = shipFromQuote("houmon", 1, 0, 0, 0, { _id: "c", soNumber: "SH-C", status: "canceled" });
  const plan = P.PLANS.houmon;
  const res = caseSubsidyAmounts([s1, s2, s3], { plan, countsById: { b: { bt: 0, usb: 0, from: "x" } } });
  assert.equal(res.rows.length, 2); assert.equal(res.canceledCount, 1);
  // s2 は台数 {0,0} を渡しているので、1台とも対象外
  assert.equal(res.rows[1].split, "split"); assert.equal(res.rows[1].aSubsidy, 0); assert.equal(res.rows[1].aExtra, 6500);
  assert.equal(res.known, true);
  assert.equal(res.total.aTotal, 14500 + 6500); assert.equal(res.total.aSubsidy, 14500); assert.equal(res.total.aExtra, 6500);
  assert.equal(res.total.b, 49500); assert.equal(res.total.ab, 64000); assert.equal(res.total.grant, 64000);
  assert.deepEqual(res.total.skuQty, { [P.SKU.BT]: 1, [P.SKU.USB_A]: 1 });
  // 1件でも区別できないと、合計の A・A＋B・交付見込みは出さない
  const res2 = caseSubsidyAmounts([s1, s2], { plan });
  assert.equal(res2.known, false); assert.equal(res2.total.aSubsidy, null); assert.equal(res2.total.grant, null);
  assert.equal(res2.total.b, 49500); // B は区別に関係なく出せる
  // 区分が分からないと交付見込みは出さない
  assert.equal(caseSubsidyAmounts([s1], {}).total.grant, null);
  // 上限で頭打ち
  const big = { _id: "z", items: [bt(1), fee(60000, 1)], subsidyQty: { bt: 1, usb: 0 } };
  assert.equal(caseSubsidyAmounts([big], { plan }).total.grant, 64000);
  assert.equal(caseSubsidyAmounts([big], { plan }).total.ab, 74500);
  assert.equal(caseSubsidyAmounts([], { plan }).rows.length, 0);
});

// ===== 【中2】領収金額の予定＝請求額（invoiceTotals の payable）。A・B は送料に関係なく変わらない =====
t(() => {
  const s = shipFromQuote("houmon", 1, 2, 0, 0, { _id: "p1", soNumber: "SH-P1", shippingFee: 800 }); // 税込出荷・送料¥800
  const r = shipmentSubsidyAmounts(s, null, subsidyCountsFromShipment(s));
  assert.equal(r.plannedIncl, invoiceTotals(s).payable);
  assert.equal(r.plannedIncl, 64000 + 880);          // 送料は税込に直して足す（明細の合計 64,800 ではない）
  assert.notEqual(r.plannedIncl, r.aTotal + r.b + r.x);
  assert.equal(r.ab, 64000); assert.equal(r.x, 800);  // A・B・A＋B は送料で変わらない
  // 領収証を発行済みなら予定は出さない（領収証の保存値を使う）
  const rows = receiptRowsFromShipment(s);
  const rc = { receiptNo: "RCPT-P1", amountIncl: 64880, items: rows.map((x) => ({ usage: x.kind, name: x.name, qty: x.qty, unitPrice: x.price })), usageTotalsIncl: usageTotalsOf(rows, true) };
  const r2 = shipmentSubsidyAmounts(s, rc, subsidyCountsFromShipment(s));
  assert.equal(r2.plannedIncl, null); assert.equal(r2.receiptAmountIncl, 64880);
  // 過入金の充当も請求書と同じに引かれる
  const sc = { ...s, creditApplied: 1000 };
  assert.equal(shipmentSubsidyAmounts(sc, null, subsidyCountsFromShipment(sc)).plannedIncl, invoiceTotals(sc).payable);
});
// 複数出荷: 未発行の出荷の請求額の合計／発行済みは領収証の額の合計（分けて数える）
t(() => {
  const s1 = shipFromQuote("houmon", 1, 0, 0, 0, { _id: "a", soNumber: "SH-A", shippingFee: 800 });
  const s2 = { _id: "b", soNumber: "SH-B", items: [usbA(1)], shippingFee: 370 };
  const s3 = shipFromQuote("houmon", 0, 1, 0, 0, { _id: "c", soNumber: "SH-C" });
  const rows3 = receiptRowsFromShipment(s3);
  const rc3 = { receiptNo: "RCPT-C", amountIncl: 64000, items: rows3.map((x) => ({ usage: x.kind, name: x.name, qty: x.qty, unitPrice: x.price })), usageTotalsIncl: usageTotalsOf(rows3, true) };
  const res = caseSubsidyAmounts([s1, s2, s3], { receiptsById: { c: rc3 } });
  assert.equal(res.rows[0].plannedIncl, invoiceTotals(s1).payable);
  assert.equal(res.rows[1].plannedIncl, invoiceTotals(s2).payable);
  assert.equal(res.total.plannedIncl, invoiceTotals(s1).payable + invoiceTotals(s2).payable);
  assert.equal(res.total.plannedIncl, (64000 + 880) + (6500 + 407));
  assert.equal(res.total.plannedCount, 2);
  assert.equal(res.total.receiptAmountIncl, 64000); assert.equal(res.total.receiptCount, 1);
  const none = caseSubsidyAmounts([s3], { receiptsById: { c: rc3 } });
  assert.equal(none.total.plannedIncl, null); assert.equal(none.total.plannedCount, 0);
});

// ===== 手入力の欄との突き合わせ（申4） =====
t(() => {
  const s1 = shipFromQuote("houmon", 1, 0);
  const res = caseSubsidyAmounts([s1], { plan: P.PLANS.houmon });
  let m = inputMismatches({ cardReaderCost: "14500", supportCost: 49500, grantAmount: "" }, res);
  assert.deepEqual(m, { cardReaderCost: null, supportCost: null, grantAmount: null });
  m = inputMismatches({ cardReaderCost: "43,500", supportCost: 50000, grantAmount: 60000 }, res);
  assert.equal(m.cardReaderCost.auto, 14500);
  assert.equal(m.cardReaderCost.text, "出荷の明細の値（A・補助対象分）は ¥14,500 です（この欄は ¥43,500）");
  assert.equal(m.supportCost.auto, 49500);
  assert.equal(m.grantAmount.auto, 64000);
  // 交付額は決定後に見込みと違うことがあるので文言が違う（黄色は出す）
  assert.equal(m.grantAmount.text, "交付見込み（¥64,000）と違います。決定通知の額なら、このままで大丈夫です");
  assert.equal(inputMismatches({ grantAmount: "64,000" }, res).grantAmount, null);
  // 領収証が正本のときは「領収証の」
  const r = { receiptNo: "R1", usageTotalsIncl: { A: 14500, B: 49500, X: 0 }, items: [{ usage: "A", qty: 1, unitPrice: 14500 }, { usage: "B", qty: 1, unitPrice: 49500 }] };
  const res2 = caseSubsidyAmounts([s1], { plan: P.PLANS.houmon, receiptsById: { s1: r } });
  assert.match(inputMismatches({ supportCost: 1 }, res2).supportCost.text, /^領収証の値（B）は ¥49,500 です/);
  // 区別できないときは A を比べない（B は比べる）
  const s2 = { _id: "m", items: [usbA(2), manualFee(30200)] };
  const res3 = caseSubsidyAmounts([s2], { plan: P.PLANS.houmon });
  m = inputMismatches({ cardReaderCost: 1, supportCost: 1, grantAmount: 1 }, res3);
  assert.equal(m.cardReaderCost, null); assert.equal(m.grantAmount, null); assert.equal(m.supportCost.auto, 30200);
  // 出荷が無ければ何も比べない
  assert.deepEqual(inputMismatches({ cardReaderCost: 1 }, caseSubsidyAmounts([], {})), { cardReaderCost: null, supportCost: null, grantAmount: null });
});

// ===== 入金・消込に触れていない =====
t(() => {
  const src = readFileSync(new URL("../admin/js/subsidy-amounts.js", import.meta.url), "utf8");
  for (const w of ["netPaidOf(", "billableInclOf(", "payments", "refunds", "creditApplied", "firebasejs", "getDoc(", "document."]) {
    assert.ok(!src.includes(w), `subsidy-amounts.js に ${w} がある`);
  }
});

console.log(`test-subsidy-amounts: 合計 ${n}/${n} 合格（うち乱数の出荷 2,000 件を共通化前の計算と照合）`);
