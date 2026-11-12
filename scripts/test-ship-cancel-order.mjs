// 点検9の続き（2026-11-13「その都度、人が選ぶ」）: 認定事業者の受注から作った出荷をキャンセルしたときの受注の戻し先
// （admin/js/ship-cancel-order.js）と、画面へのつなぎのテスト。
// node scripts/test-ship-cancel-order.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ORDER_STATUS_LABEL, ORDER_RETURN_CHOICES, ORDER_RETURN_REQUIRED_MSG, isPartnerOrderShipment, validateOrderReturn,
  planOrderOnShipCancel, orderReturnWrites, lastShipCancelNote, shipOrderReturnNote,
} from "../admin/js/ship-cancel-order.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const has = (src, re, msg) => assert.ok(re.test(src), msg || `見つからない: ${re}`);
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };

const S = (id, status, extra = {}) => ({ _id: id, soNumber: `SH-${id}`, status, ...extra });
const PO = (status, extra = {}) => ({ status, soNumber: "SO-2026-0001", partnerOrderNo: "P-1", partnerName: "認定A", ...extra });
const NOW = { __ts: "server" };

// ===== 受注から作った出荷か =====
t("partnerOrderId があれば受注から作った出荷", () => {
  assert.equal(isPartnerOrderShipment(S("a", "requested", { partnerOrderId: "po1" })), true);
});
t("partnerOrderId が無い・空・空白・文字列でない・出荷なし → 通常の出荷", () => {
  for (const s of [S("a", "draft"), S("a", "draft", { partnerOrderId: "" }), S("a", "draft", { partnerOrderId: "  " }),
    S("a", "draft", { partnerOrderId: null }), S("a", "draft", { partnerOrderId: 1 }), null, undefined]) {
    assert.equal(isPartnerOrderShipment(s), false, JSON.stringify(s));
  }
});

// ===== 選択肢と検証 =====
t("選択肢は 受注確定に戻す／受付済に戻す／受注もキャンセル の3つ（この順）", () => {
  assert.deepEqual(ORDER_RETURN_CHOICES.map((c) => c.value), ["confirmed", "received", "canceled"]);
  for (const c of ORDER_RETURN_CHOICES) assert.ok(ORDER_STATUS_LABEL[c.value], c.value);
  assert.ok(!ORDER_RETURN_CHOICES.some((c) => c.value === "shipped"), "出荷済のままは選べない");
});
t("選ばないとキャンセルできない（初期値なし）", () => {
  assert.equal(validateOrderReturn(""), ORDER_RETURN_REQUIRED_MSG);
  assert.equal(validateOrderReturn(undefined), ORDER_RETURN_REQUIRED_MSG);
  assert.equal(validateOrderReturn(null), ORDER_RETURN_REQUIRED_MSG);
});
t("知らない値・出荷済は通さない", () => {
  for (const v of ["shipped", "draft", "CONFIRMED", "x"]) assert.match(validateOrderReturn(v), /正しくありません/, v);
});
t("3つの値は通る", () => {
  for (const v of ["confirmed", "received", "canceled"]) assert.equal(validateOrderReturn(v), "", v);
});

// ===== 何をするか =====
t("通常の出荷 → none（何も聞かない）", () => {
  assert.deepEqual(planOrderOnShipCancel({ ship: S("a", "shipped"), order: PO("shipped") }), { kind: "none" });
});
t("受注が見つからない → missing（受注は変えない）", () => {
  assert.equal(planOrderOnShipCancel({ ship: S("a", "shipped", { partnerOrderId: "po1" }), order: null }).kind, "missing");
});
t("同じ受注にほかの生きた出荷がある → others", () => {
  const ship = S("a", "requested", { partnerOrderId: "po1" });
  const p = planOrderOnShipCancel({ ship, order: PO("confirmed"), shipments: [ship, S("b", "draft", { partnerOrderId: "po1" })] });
  assert.deepEqual(p, { kind: "others", others: ["SH-b"] });
});
t("ほかの出荷がキャンセル済み・別の受注・自分自身だけ → ask", () => {
  const ship = S("a", "shipped", { partnerOrderId: "po1" });
  const ships = [ship, S("b", "canceled", { partnerOrderId: "po1" }), S("c", "draft", { partnerOrderId: "po2" }), S("d", "draft")];
  assert.deepEqual(planOrderOnShipCancel({ ship, order: PO("shipped"), shipments: ships }), { kind: "ask" });
  assert.deepEqual(planOrderOnShipCancel({ ship, order: PO("shipped") }), { kind: "ask" });
});
t("id で自分を外す（_id でも id でも）", () => {
  const ship = { id: "a", soNumber: "SH-a", status: "requested", partnerOrderId: "po1" };
  assert.equal(planOrderOnShipCancel({ ship, order: PO("confirmed"), shipments: [{ ...ship }] }).kind, "ask");
});

// ===== 書く中身 =====
t("受注確定に戻す: 受注の状態・最後のキャンセル・記録の1行・出荷側の記録", () => {
  const w = orderReturnWrites({ order: PO("shipped"), ship: S("a", "shipped", { partnerOrderId: "po1" }), choice: "confirmed",
    by: "職員 太郎", now: NOW, nowIso: "2026-11-13T01:00:00.000Z", cancelReason: "事業所の都合・電話で" });
  assert.equal(w.orderPatch.status, "confirmed");
  assert.equal(w.orderPatch.updatedAt, NOW);
  assert.deepEqual(w.orderPatch.lastShipCancel, { at: NOW, by: "職員 太郎", shipId: "a", shipSoNumber: "SH-a",
    from: "shipped", to: "confirmed", choiceLabel: "受注確定に戻す", cancelReason: "事業所の都合・電話で" });
  assert.deepEqual(w.logEntry, { at: "2026-11-13T01:00:00.000Z", by: "職員 太郎", shipId: "a", shipSoNumber: "SH-a",
    from: "shipped", to: "confirmed", choiceLabel: "受注確定に戻す", cancelReason: "事業所の都合・電話で" });
  assert.deepEqual(w.shipPatch, { partnerOrderReturn: { orderId: "po1", orderSoNumber: "SO-2026-0001", from: "shipped", to: "confirmed",
    choiceLabel: "受注確定に戻す", by: "職員 太郎" } });
  assert.match(w.text, /出荷 SH-a のキャンセルで、認定事業者の受注 SO-2026-0001: 出荷済 → 受注確定（受注確定に戻す・職員 太郎 が選択）/);
});
t("受付済に戻す・受注もキャンセル", () => {
  for (const [choice, label] of [["received", "受付済"], ["canceled", "キャンセル"]]) {
    const w = orderReturnWrites({ order: PO("confirmed"), ship: S("a", "requested", { partnerOrderId: "po1" }), choice, by: "x", now: NOW, nowIso: "z" });
    assert.equal(w.orderPatch.status, choice);
    assert.equal(w.logEntry.from, "confirmed");
    assert.match(w.text, new RegExp(`受注確定 → ${label}`));
  }
});
t("戻し先が無い・正しくない → 書かない（例外）", () => {
  assert.throws(() => orderReturnWrites({ order: PO("shipped"), ship: S("a", "shipped"), choice: "", by: "x", now: NOW }), /選んでください/);
  assert.throws(() => orderReturnWrites({ order: PO("shipped"), ship: S("a", "shipped"), choice: "shipped", by: "x", now: NOW }), /正しくありません/);
});
t("配列（shipCancelLog）に入れる記録にはサーバー時刻の印を入れない", () => {
  const w = orderReturnWrites({ order: PO("shipped"), ship: S("a", "shipped", { partnerOrderId: "po1" }), choice: "received", by: "x", now: NOW, nowIso: "iso" });
  assert.ok(!Object.values(w.logEntry).includes(NOW));
});
t("入金・請求・在庫の項目は書かない", () => {
  const w = orderReturnWrites({ order: PO("shipped"), ship: S("a", "invoiced", { partnerOrderId: "po1" }), choice: "canceled", by: "x", now: NOW, nowIso: "i" });
  const keys = [...Object.keys(w.orderPatch), ...Object.keys(w.shipPatch)];
  for (const k of ["payments", "refunds", "paymentAmount", "creditApplied", "invoicedAt", "status" + "BeforeCancel", "stockByLocation"]) {
    assert.ok(!keys.includes(k), k);
  }
  assert.deepEqual(Object.keys(w.shipPatch), ["partnerOrderReturn"], "出荷には partnerOrderReturn だけ足す");
});
t("一覧の一言", () => {
  assert.equal(lastShipCancelNote({}), "");
  assert.equal(lastShipCancelNote(null), "");
  assert.equal(lastShipCancelNote({ lastShipCancel: { shipSoNumber: "SH-a", to: "received", by: "太郎" } }), "出荷 SH-a のキャンセルで「受付済」に（太郎）");
  assert.equal(shipOrderReturnNote({}), "");
  assert.equal(shipOrderReturnNote({ partnerOrderReturn: { orderSoNumber: "SO-1", to: "canceled", by: "花子" } }), "受注 SO-1は「キャンセル」に（花子）");
});

// ===== 画面へのつなぎ =====
t("supply.html: 戻し先の欄（最初は隠す）", () => {
  const html = read("admin/supply.html");
  has(html, /id="cancelOrderReturnGroup" style="display:none/);
  has(html, /id="cancelOrderReturnChoices"/);
});
t("supply.js: 画面を開くとき受注から作った出荷だけ選択肢を出し、ラジオは初期値なし", () => {
  const src = read("admin/js/supply.js");
  has(src, /from "\/js\/ship-cancel-order\.js"/);
  has(src, /if\(isPartnerOrderShipment\(s\)\) previewOrderReturn\(s\);/);
  const prev = src.slice(src.indexOf("async function previewOrderReturn"), src.indexOf("function selectedOrderReturn"));
  assert.ok(prev.length > 0);
  assert.ok(!/checked/.test(prev), "初期値（checked）を置いている");
});
t("supply.js: キャンセルのトランザクションで受注を読み直し、選んだ戻し先を書く", () => {
  const src = read("admin/js/supply.js");
  const body = src.slice(src.indexOf("async function doCancelShipment"), src.indexOf("// 出荷の金額。"));
  has(body, /validateOrderReturn\(orderChoice\)/);
  has(body, /planOrderOnShipCancel\(\{ ship:\{ _id:s\._id, \.\.\.cur \}, order, shipments: poSibs \}\)/);
  has(body, /if\(orderPlan\.kind!==cancelOrderPlanKind\) throw new Error\(ORDER_RETURN_STALE_MSG\)/);
  has(body, /tx\.update\(poRef, \{ \.\.\.orderW\.orderPatch, shipCancelLog: arrayUnion\(orderW\.logEntry\) \}\)/);
  has(body, /\.\.\.\(orderW \? orderW\.shipPatch : \{\}\)/);
  // 読み取りがすべて書き込みより前
  const lastGet = body.lastIndexOf("tx.get(");
  const firstWrite = Math.min(...["tx.update(", "tx.set("].map((k) => body.indexOf(k)).filter((i) => i >= 0));
  assert.ok(lastGet < firstWrite, "トランザクションの読み取りが書き込みより後にある");
  // 在庫を戻す処理は今までどおり
  has(body, /if\(usesStock\)\{\s*const backTo = shipLocationOf\(cur\);/);
  has(body, /movement\(it\.sku, it\.qty, "shipment_canceled", s\.soNumber, backTo\)/);
  for (const k of ["payments", "refunds", "paymentAmount", "creditApplied"]) assert.ok(!new RegExp(`${k}\\s*:`).test(body), `${k} に書いている`);
});

console.log(`ship-cancel-order: ${n} 件 合格`);
