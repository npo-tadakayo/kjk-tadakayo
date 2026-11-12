// 事業所向けの出荷は送料を請求しない（2026-11-12 次田さん決定）のテスト。node scripts/test-ship-fee.mjs
//
// ここで確かめること
//   ① 判定（billsOffice）は請求書の税基準（priceIsTaxIncluded）・一覧のバッジ（billsPartner の逆）と同じ
//   ② 事業所向け: 配送方法を選んでも送料は 0 円・名目に配送方法と「当法人負担」が入る
//   ③ 認定事業者向け: 今までどおり（料金表の税込実費を税抜に直して入れる・名目も従来の文）
//   ④ 持ち出し → 発送: 事業所向けは 0 円のまま／認定事業者向けはレターパックの送料
//   ⑤ 手入力の確認が出る条件（事業所向け × 送料>0 × 金額を保存するとき だけ）
//   ⑥ 0 円の送料は請求書・領収証に行が出ない
//   ⑦ supply.js / supply.html の配線（自動入力・保存前の確認・持ち出し→発送・説明の一言）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { billsOffice, taxExclOf, autoShipFee, returnToShipFee, needsOfficeFeeConfirm, OFFICE_FEE_CONFIRM }
  from "../admin/js/ship-fee-rules.js";
import { priceIsTaxIncluded, invoiceTotals, renderInvoiceHtml } from "../admin/js/invoice-doc.js";
import { receiptRowsFromShipment } from "../admin/js/subsidy-amounts.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };

const OFFICE = { shipType: "direct", partnerEmail: "" };
const OFFICE_OLD = {};                                               // shipType なし（Web申込の古い出荷など）
const DROP = { shipType: "dropship", partnerEmail: "p@example.jp" };
const STOCK_OLD = { shipType: "stock", partnerEmail: "p@example.jp" }; // 旧 shipType:"stock"（請求先は認定事業者）
const LP = 600, YU = 1100;

t("① 判定は請求書・一覧のバッジと同じ", () => {
  const billsPartner = (s) => s.shipType === "dropship" || !!s.partnerEmail; // supply.js の billsPartner と同じ式
  for (const s of [OFFICE, OFFICE_OLD, DROP, STOCK_OLD, { shipType: "dropship" }, { shipType: "direct", partnerEmail: "x@y" }]) {
    assert.equal(billsOffice(s), priceIsTaxIncluded(s));
    assert.equal(billsOffice(s), !billsPartner(s));
  }
  assert.equal(billsOffice(OFFICE), true);
  assert.equal(billsOffice(OFFICE_OLD), true);
  assert.equal(billsOffice(DROP), false);
  assert.equal(billsOffice(STOCK_OLD), false);
  assert.equal(billsOffice({ shipType: "dropship" }), false); // 直送は partnerEmail が空でも認定事業者向け
});

t("② 事業所向け: レターパック・ゆうパックを選んでも送料は 0 円（名目に配送方法と当法人負担）", () => {
  assert.deepEqual(autoShipFee({ office: true, method: "letterpack", packs: 1, letterpackFee: LP }),
    { fee: 0, label: "レターパック 1通（送料は当法人負担）" });
  assert.deepEqual(autoShipFee({ office: true, method: "letterpack", packs: 3, letterpackFee: LP }),
    { fee: 0, label: "レターパック 3通（送料は当法人負担）" });
  assert.deepEqual(autoShipFee({ office: true, method: "yupack", yupackSize: "80", yupackRegion: "関東", yupackFee: YU }),
    { fee: 0, label: "ゆうパック 80サイズ・関東（送料は当法人負担）" });
  assert.deepEqual(autoShipFee({ office: true, method: "none" }), { fee: 0, label: "郵送なし（手渡し・持参）" });
  assert.equal(autoShipFee({ office: true, method: "" }), null); // 指定しない＝手入力のまま
});

t("③ 認定事業者向け: 今までどおり（料金表の税込を税抜にして入れる）", () => {
  assert.equal(taxExclOf(600), 545);
  assert.equal(taxExclOf(1100), 1000);
  assert.deepEqual(autoShipFee({ office: false, method: "letterpack", packs: 1, letterpackFee: LP }),
    { fee: 545, label: "送料（レターパック 1通）" });
  assert.deepEqual(autoShipFee({ office: false, method: "letterpack", packs: 2, letterpackFee: LP }),
    { fee: taxExclOf(1200), label: "送料（レターパック 2通）" });
  assert.deepEqual(autoShipFee({ office: false, method: "yupack", yupackSize: "60", yupackRegion: "近畿", yupackFee: YU }),
    { fee: 1000, label: "送料（ゆうパック 60サイズ・近畿）" });
  assert.deepEqual(autoShipFee({ office: false, method: "none" }), { fee: 0, label: "郵送なし（手渡し・持参）" });
  assert.equal(autoShipFee({ office: false, method: "" }), null);
});

t("④ 持ち出し → 発送: 事業所向けは 0 円のまま・認定事業者向けはレターパックの送料", () => {
  const o = returnToShipFee({ office: true, packs: 2, letterpackFee: LP });
  assert.deepEqual(o.patch, { shippingMethod: "letterpack", shippingFee: 0, shippingLabel: "レターパック 2通（送料は当法人負担）" });
  assert.match(o.confirmText, /送料は請求しません（0円のまま/);
  assert.match(o.doneText, /送料は当法人負担・0円/);
  const p = returnToShipFee({ office: false, packs: 2, letterpackFee: LP });
  assert.deepEqual(p.patch, { shippingMethod: "letterpack", shippingFee: taxExclOf(1200), shippingLabel: "送料（レターパック 2通）" });
  assert.equal(p.confirmText, null); // 認定事業者向けの確認の文は supply.js の従来の文
  assert.match(p.doneText, /送料を「送料（レターパック 2通）」にしました/);
});

t("⑤ 手入力の確認が出る条件", () => {
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: 545 }), true);
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: "1" }), true);
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: 0 }), false);
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: "" }), false);
  assert.equal(needsOfficeFeeConfirm({ office: false, fee: 545 }), false);         // 認定事業者向けは出さない
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: 545, savesMoney: false }), false); // 請求書の後（金額を保存しない）
  assert.equal(OFFICE_FEE_CONFIRM, "事業所向けの出荷では送料を請求しない決まりです。請求しますか？");
});

t("⑥ 0 円の送料は請求書・領収証に行が出ない（送料>0 のときだけ）", () => {
  const items = [{ sku: "cir415a-01", name: "CIR415A", qty: 1, unitPrice: 14500 }];
  const a = autoShipFee({ office: true, method: "letterpack", packs: 1, letterpackFee: LP });
  const s0 = { soNumber: "SH-2026-0999", ...OFFICE, items, shippingFee: a.fee, shippingLabel: a.label, status: "paid" };
  assert.equal(invoiceTotals(s0).total, 14500);
  const html = renderInvoiceHtml(s0, {});
  assert.ok(!html.includes("当法人負担"), "請求書に 0 円の送料の行が出ている");
  assert.ok(!receiptRowsFromShipment(s0).some(r => r.kind === "X"), "領収証に 0 円の送料の行が出ている");
  // 認定事業者向けは今までどおり行が出る
  const p = autoShipFee({ office: false, method: "letterpack", packs: 1, letterpackFee: LP });
  const s1 = { soNumber: "SH-2026-0998", ...DROP, items, shippingFee: p.fee, shippingLabel: p.label };
  assert.ok(renderInvoiceHtml(s1, {}).includes("送料（レターパック 1通）"));
});

t("⑦ supply.js / supply.html の配線", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  // 自動入力は autoShipFee に任せる（請求先は修正中の出荷 or 画面の出荷種別から）
  const rf = sup.slice(sup.indexOf("function recalcShipFee"), sup.indexOf("function taxInclusiveShipFees"));
  assert.match(rf, /autoShipFee\(\{ office: shipModalBillsOffice\(\), method,/);
  assert.doesNotMatch(rf, /taxExcl\(/); // 料金表の金額を直に入れる箇所が残っていない
  const mb = sup.slice(sup.indexOf("function shipModalBillsOffice"), sup.indexOf("function recalcShipFee"));
  assert.match(mb, /editingShip \|\|/);
  assert.match(mb, /return billsOffice\(basis\);/);
  // 出荷種別を変えたら送料を入れ直す（配送方法を選んでいるときだけ）
  assert.match(sup, /if\(document\.getElementById\("shipMethod"\)\.value\) recalcShipFee\(\);/);
  // 保存前の確認（新規・修正の両方）
  const ns = sup.slice(sup.indexOf("async function saveShip()"), sup.indexOf("async function saveShip()") + 9000);
  assert.match(ns, /needsOfficeFeeConfirm\(\{ office: billsOffice\(\{ shipType, partnerEmail \}\), fee: shippingFee \}\)/);
  assert.match(sup, /needsOfficeFeeConfirm\(\{ office: billsOffice\(s0\), fee: patch\.shippingFee \}\)/);
  // 持ち出し → 発送
  const rq = sup.slice(sup.indexOf("async function requestDraftShipment"), sup.indexOf("// 依頼済(requested) → 発送済"));
  assert.match(rq, /const lpOffice = billsOffice\(s\);/);
  assert.match(rq, /\(feeRestored \? `。\$\{lpBack\.doneText\}` : ""\)/);
  // 認定事業者の受注から作る直送の出荷は今までどおりレターパックの送料
  assert.match(sup, /shipType:"dropship", partnerEmail:o\.partnerEmail\|\|""[\s\S]{0,300}shippingFee:taxExcl\(packs\*letterpackFee\(\)\)/);
  const html = readFileSync(new URL("../admin/supply.html", import.meta.url), "utf8");
  assert.match(html, /<strong>事業所向けの出荷は送料を請求しません<\/strong>（タダカヨの負担）/);
  assert.match(html, /id="shipMethod" data-tip="事業所向けの出荷は送料を請求しません/);
});

console.log(`OK: test-ship-fee ${n} 件合格`);
