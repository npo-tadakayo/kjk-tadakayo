// 出荷の下書きの重複・在庫の目安（admin/js/ship-dup.js）のテスト。node scripts/test-ship-dup.mjs
import assert from "node:assert/strict";
import { findDuplicateDrafts, stockAdvice } from "../admin/js/ship-dup.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };

const S = (id, caseId, status, soNumber) => ({ _id: id, caseId, status, soNumber });

t("重複の検出（draft/requested だけ数える）", () => {
  const ships = [
    S("a1", "C1", "draft", "SH-2026-0256"), S("a2", "C1", "draft", "SH-2026-0255"), S("a3", "C1", "requested", "SH-2026-0257"),
    S("b1", "C2", "draft", "SH-2026-0300"), S("b2", "C2", "shipped", "SH-2026-0301"),   // 発送済とは重複にしない
    S("c1", "C3", "draft", "SH-2026-0400"), S("c2", "C3", "canceled", "SH-2026-0401"),  // キャンセルは数えない
    S("d1", null, "draft", "SH-2026-0500"), S("d2", null, "draft", "SH-2026-0501"),     // 案件なしは対象外
  ];
  const r = findDuplicateDrafts(ships, { C1: "a3" });
  assert.equal(r.length, 1);
  assert.equal(r[0].caseId, "C1");
  assert.deepEqual(r[0].shipments.map((s) => s.soNumber), ["SH-2026-0255", "SH-2026-0256", "SH-2026-0257"]);
  assert.equal(r[0].keepId, "a3");
});

t("残す候補は cases.shipmentId（組に無ければ null）", () => {
  const ships = [S("x1", "K", "draft", "SH-1"), S("x2", "K", "draft", "SH-2")];
  assert.equal(findDuplicateDrafts(ships, { K: "zzz" })[0].keepId, null);
  assert.equal(findDuplicateDrafts(ships, {})[0].keepId, null);
  assert.equal(findDuplicateDrafts(ships, undefined)[0].keepId, null);
  assert.equal(findDuplicateDrafts(ships, new Map([["K", "x2"]]))[0].keepId, "x2"); // Map でもよい
  // id（_id でない）でも読める
  assert.equal(findDuplicateDrafts([{ id: "y1", caseId: "K", status: "draft" }, { id: "y2", caseId: "K", status: "requested" }], { K: "y1" })[0].keepId, "y1");
});

t("重複なし", () => {
  assert.deepEqual(findDuplicateDrafts([], {}), []);
  assert.deepEqual(findDuplicateDrafts(null, null), []);
  assert.deepEqual(findDuplicateDrafts([S("a", "C", "draft"), S("b", "D", "draft")], {}), []);
});

t("複数の案件は案件ID順", () => {
  const r = findDuplicateDrafts([S("1", "Z", "draft"), S("2", "Z", "draft"), S("3", "A", "requested"), S("4", "A", "draft")], {});
  assert.deepEqual(r.map((g) => g.caseId), ["A", "Z"]);
});

// ===== 在庫の目安 =====
const locations = [
  { _id: "shiga", name: "滋賀", active: true },
  { _id: "tokyo", name: "東京" },
  { _id: "old", name: "旧倉庫", active: false }, // 無効は出さない
];
const products = [
  { id: "bt", name: "カードリーダー（Bluetooth）", shortName: "BT", stockByLocation: { shiga: 3, tokyo: 0, old: 99 } },
  { id: "usb", name: "カードリーダー（USB）", shortName: "USB", stockByLocation: { shiga: 1 } },
];

t("在庫の目安（1品番）", () => {
  const r = stockAdvice([{ sku: "bt", qty: 2 }], products, locations);
  assert.equal(r.text, "在庫: 滋賀 3/2台 ✓・東京 0/2台");
  assert.deepEqual(r.rows.map((x) => [x.locationId, x.ok]), [["shiga", true], ["tokyo", false]]);
  // ちょうど同数は足りる
  assert.equal(stockAdvice([{ sku: "bt", qty: 3 }], products, locations).rows[0].ok, true);
  assert.equal(stockAdvice([{ sku: "bt", qty: 4 }], products, locations).rows[0].ok, false);
});

t("在庫の目安（同じ品番の行は合算・品物でない明細は除く）", () => {
  const items = [
    { sku: "bt", qty: 1 }, { sku: "bt", qty: 1 },
    { sku: "support-fee", qty: 1, unitPrice: 5000, nonStock: true },
    { sku: "discount", qty: 1, unitPrice: -1000, nonStock: true },
    { sku: "unknown", qty: 5 }, // 商品マスタに無い品番
  ];
  assert.equal(stockAdvice(items, products, locations).text, "在庫: 滋賀 3/2台 ✓・東京 0/2台");
});

t("在庫の目安（2品番）", () => {
  const r = stockAdvice([{ sku: "bt", qty: 2 }, { sku: "usb", qty: 1 }], products, locations);
  assert.equal(r.text, "在庫: 滋賀 BT 3/2台、USB 1/1台 ✓・東京 BT 0/2台、USB 0/1台");
});

t("在庫の目安（対象なし）", () => {
  assert.deepEqual(stockAdvice([{ sku: "support-fee", qty: 1, nonStock: true }], products, locations), { text: "", rows: [] });
  assert.deepEqual(stockAdvice([{ sku: "bt", qty: 1 }], products, []), { text: "", rows: [] });
  assert.deepEqual(stockAdvice(null, null, null), { text: "", rows: [] });
  // stockByLocation が無い商品は 0 台
  assert.equal(stockAdvice([{ sku: "x", qty: 1 }], [{ id: "x", name: "X" }], [{ id: "L", name: "L" }]).text, "在庫: L 0/1台");
});

console.log(`OK test-ship-dup: ${n} 件合格`);
