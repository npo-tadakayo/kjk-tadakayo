// 領収証の送料の税基準（2026-11-12 是正）のテスト。node scripts/test-receipt-shipping.mjs
//
// 是正前: 送料は税抜で保存（shipments.shippingFee・2026-07-28 統一）しているのに、事業所向け（単価が税込）の領収証では
//   その税抜の額をそのまま「税込」の列に入れていた。例: 送料 税抜745円 → 領収証の税込の列に ¥745（正しくは ¥820）。
//   領収金額（実入金から自動）は正しいが、明細合計が請求額より少なくなり、書面に
//   「領収金額が明細合計を上回っています（差 ¥75）。明細をご確認ください。」と印字されていた。
// 是正後: 事業所向けは請求書（invoiceTotals の shipIncl）と同じ丸めで税込に直す。認定事業者向け（税抜の列）は税抜のまま。
//
// ここで確かめること
//   ① 送料あり・なし × 請求先（事業所／認定事業者）で、領収証の明細合計（区分ごとの税込小計の和）が請求書の合計と一致する
//   ② 過入金の充当ありでも、明細合計−領収金額（自動）＝充当額（書面の注記は「充当」になり「上回っています」にならない）
//   ③ A・B（助成金の申請額）は送料で変わらない
//   ④ 是正前に記録した領収証（送料が税抜のまま）を開いたときだけ注意を出す
//   ⑤ supply-print.js が注意を出す配線になっている
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  receiptRowsFromShipment, receiptShippingPrice, receiptShippingWarning, usageTotalsOf,
} from "../admin/js/subsidy-amounts.js";
import { invoiceTotals, priceIsTaxIncluded } from "../admin/js/invoice-doc.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); throw e; } };

const BT = { sku: "cir415a-01", name: "CIR415A", qty: 1, unitPrice: 14500 };
const FEE = { sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 60000 };
const DISC = { sku: "discount", name: "値引き", qty: 1, unitPrice: -10500 };
const office = (extra = {}) => ({ soNumber: "SH-2026-0900", items: [BT, FEE, DISC], ...extra });                 // 事業所向け（税込）
const dealer = (extra = {}) => ({ soNumber: "SH-2026-0901", shipType: "dropship", partnerEmail: "p@example.jp",   // 認定事業者向け（税抜）
  items: [{ sku: "cir415a-01", name: "CIR415A", qty: 3, unitPrice: 11000 }], ...extra });

// 領収証の画面と同じ計算（wireReceiptEditor の recompute → itemsTotal、renderReceipt の autoAmount）
function receiptOf(s, paid) {
  const rows = receiptRowsFromShipment(s);
  const u = usageTotalsOf(rows, priceIsTaxIncluded(s));
  const itemsTotal = u.A + u.B + u.X;
  const billable = Math.max(0, invoiceTotals(s).payable);
  const autoAmount = Math.max(0, Math.min(paid, billable));
  return { rows, u, itemsTotal, billable, autoAmount };
}

// ===== ① 明細合計＝請求書の合計 =====
t("事業所向け・送料あり（ゆうパック 税抜745円）", () => {
  const s = office({ shippingFee: 745, shippingLabel: "送料（ゆうパック 60サイズ・近畿）" });
  const r = receiptOf(s, 64820);
  const x = r.rows.find((row) => row.kind === "X");
  assert.equal(x.price, 820);                     // 税抜745円 → 税込820円（請求書の送料の行と同じ）
  assert.equal(x.price, invoiceTotals(s).shipIncl);
  assert.equal(r.u.X, 820);
  assert.equal(r.itemsTotal, 64820);
  assert.equal(r.itemsTotal, invoiceTotals(s).total);
  assert.equal(r.autoAmount, r.itemsTotal);       // 領収金額＝明細合計＝請求額（差の注記が出ない）
});
t("事業所向け・送料あり（レターパック 税込600円→税抜545円で保存）", () => {
  const s = office({ shippingFee: 545 });
  const r = receiptOf(s, 64600);
  assert.equal(r.u.X, 600);                       // 実費の600円に戻る
  assert.equal(r.itemsTotal, invoiceTotals(s).total);
});
t("事業所向け・送料なし", () => {
  const s = office({ shippingFee: 0 });
  const r = receiptOf(s, 64000);
  assert.equal(r.rows.some((row) => row.kind === "X"), false);
  assert.equal(receiptShippingPrice(s), 0);
  assert.equal(r.itemsTotal, 64000);
  assert.equal(r.itemsTotal, invoiceTotals(s).total);
});
t("認定事業者向け・送料あり（税抜の列なので税抜のまま）", () => {
  const s = dealer({ shippingFee: 1100 });
  const r = receiptOf(s, 37510);
  const x = r.rows.find((row) => row.kind === "X");
  assert.equal(x.price, 1100);                    // 列が税抜なので 1,100 のまま
  assert.equal(r.u.X, 1210);                      // 区分の税込小計で10%が乗る
  assert.equal(r.itemsTotal, invoiceTotals(s).total); // 33,000＋1,100＝34,100 ×1.1＝37,510
  assert.equal(r.itemsTotal, 37510);
});
t("認定事業者向け・送料なし", () => {
  const s = dealer({ shippingFee: 0 });
  const r = receiptOf(s, 36300);
  assert.equal(r.itemsTotal, invoiceTotals(s).total);
  assert.equal(r.itemsTotal, 36300);
});
// 乱数: 送料・単価・数量・請求先を混ぜても、明細合計＝請求書の合計（端数の出にくい10円単位の単価・数量に限る）
t("乱数 1,000 件（10円単位の単価）", () => {
  let seed = 20261112;
  const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
  for (let k = 0; k < 1000; k++) {
    const items = [];
    for (let j = 0, m = 1 + rnd(3); j < m; j++) items.push({ sku: rnd(2) ? "cir415a-01" : "usb-a", qty: 1 + rnd(3), unitPrice: 10 * (100 + rnd(2000)) });
    if (rnd(2)) items.push({ sku: "support-fee", qty: 1, unitPrice: 10 * (1000 + rnd(6000)) });
    const s = { items, shippingFee: rnd(2) ? 1 + rnd(3000) : 0 };
    if (rnd(3) === 0) { s.shipType = "dropship"; s.partnerEmail = "p@example.jp"; }
    const r = receiptOf(s, 0);
    if (priceIsTaxIncluded(s)) assert.equal(r.itemsTotal, invoiceTotals(s).total, JSON.stringify(s));
    else assert.ok(Math.abs(r.itemsTotal - invoiceTotals(s).total) <= 1, JSON.stringify(s)); // 税抜は区分ごとの切り捨てで最大1円
  }
});

// ===== ② 過入金の充当あり =====
t("事業所向け・送料あり・過入金の充当 3,000円", () => {
  const s = office({ shippingFee: 745, creditApplied: 3000 });
  const r = receiptOf(s, 61820);                  // 充当後の請求額だけ振り込まれた
  assert.equal(r.billable, 61820);
  assert.equal(r.autoAmount, 61820);
  // 明細合計−領収金額＝充当額ちょうど → 書面の注記は「過入金のお預かり分を充当」だけ（「上回っています」は出ない）
  assert.equal(r.itemsTotal - r.autoAmount, 3000);
});
t("認定事業者向け・送料あり・過入金の充当 2,000円", () => {
  const s = dealer({ shippingFee: 1100, creditApplied: 2000 });
  const r = receiptOf(s, 40000);                  // 多めに入金（過入金ぶんは領収金額に入れない）
  assert.equal(r.billable, 35510);
  assert.equal(r.autoAmount, 35510);
  assert.equal(r.itemsTotal - r.autoAmount, 2000);
});

// ===== ③ A・B は送料で変わらない =====
t("A・B は送料の有無で同じ", () => {
  const a = receiptOf(office({ shippingFee: 0 }), 0).u, b = receiptOf(office({ shippingFee: 745 }), 0).u;
  assert.equal(a.A, b.A); assert.equal(a.B, b.B);
  assert.equal(b.A + b.B, 64000);
});

// ===== ④ 記録済みの領収証の注意 =====
t("是正前に記録した領収証（送料 ¥745 が税込の列）だけ注意を出す", () => {
  const s = office({ shippingFee: 745 });
  const oldRows = [{ kind: "A", qty: 1, price: 14500 }, { kind: "B", qty: 1, price: 49500 }, { kind: "X", name: "送料", qty: 1, price: 745 }];
  const w = receiptShippingWarning(oldRows, s);
  assert.ok(w);
  assert.equal(w.actual, 745); assert.equal(w.expected, 820);
  assert.match(w.body, /¥745/); assert.match(w.body, /¥820/);
  // 直した明細・新しい初期明細では出さない
  assert.equal(receiptShippingWarning(receiptRowsFromShipment(s), s), null);
  assert.equal(receiptShippingWarning([...oldRows.slice(0, 2), { kind: "X", qty: 1, price: 820 }], s), null);
  // 送料の行が無い・送料が0・認定事業者向けでは出さない
  assert.equal(receiptShippingWarning(oldRows.slice(0, 2), s), null);
  assert.equal(receiptShippingWarning(oldRows, office({ shippingFee: 0 })), null);
  assert.equal(receiptShippingWarning([{ kind: "X", qty: 1, price: 1100 }], dealer({ shippingFee: 1100 })), null);
  // 手で別の額に直してある（税抜と同じではない）なら、人の判断を尊重して出さない
  assert.equal(receiptShippingWarning([{ kind: "X", qty: 1, price: 900 }], s), null);
});

// ===== ⑤ 配線 =====
t("supply-print.js が出荷を注意の関数に渡している", () => {
  const src = readFileSync(new URL("../admin/js/supply-print.js", import.meta.url), "utf8");
  assert.match(src, /function receiptWarnings\(rows, ship\)/);
  assert.match(src, /receiptShippingWarning\(rs, ship\)/);
  assert.match(src, /receiptWarnings\(rows, rcptShipment\)/);
  assert.match(src, /rcptShipment = s;/);
  // 領収証の明細に税抜の送料をそのまま入れる書き方が残っていない
  assert.ok(!/price:\s*Number\(s\.shippingFee\)/.test(src));
  const lib = readFileSync(new URL("../admin/js/subsidy-amounts.js", import.meta.url), "utf8");
  assert.ok(!/kind: "X"[^\n]*price: Number\(s\.shippingFee\)/.test(lib));
});

console.log(`test-receipt-shipping: 合計 ${n}/${n} 合格`);
