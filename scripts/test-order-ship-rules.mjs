// 受注と出荷のつなぎ（2026-11-13・小さな残り4件のうち1・2・4）の単体テストと結線の静的検査。
// node scripts/test-order-ship-rules.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canShipFromOrder, orderOnShipDone, ORDER_CANCELED_NO_SHIP_MSG, ORDER_CANCELED_NO_SHIPPED_MSG } from "../admin/js/order-ship-rules.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };

// ===== 1. キャンセル済みの受注は出荷にできない =====
t("受付済・受注確定の受注は出荷にできる", () => {
  for (const st of ["received", "confirmed"]) assert.deepEqual(canShipFromOrder({ status: st }), { ok: true, reason: "" });
});
t("キャンセル済みの受注は出荷にできない（理由つき）", () => {
  const r = canShipFromOrder({ status: "canceled" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ORDER_CANCELED_NO_SHIP_MSG);
});
t("出荷済の受注は出荷にできない", () => assert.equal(canShipFromOrder({ status: "shipped" }).ok, false));
t("受注一覧: キャンセル済みの行は「出荷へ」ボタンを出さず「キャンセル済み」と出す", () => {
  const s = read("admin/js/supply.js");
  const fn = s.slice(s.indexOf("function renderPartnerOrders"), s.indexOf("document.querySelectorAll(\".po-status\")"));
  assert.match(fn, /o\.status==="canceled"\s*\n?\s*\? `<span[^>]*>キャンセル済み<\/span>`/);
  // ボタンの生成は「キャンセル済み」の分岐より後ろにしか無い
  assert.ok(fn.indexOf("キャンセル済み") < fn.indexOf("po-ship"));
});
t("shipFromOrder も入口で止める（ボタン以外の経路・古い画面でも出荷を作らない）", () => {
  const s = read("admin/js/supply.js");
  const fn = s.slice(s.indexOf("async function shipFromOrder"), s.indexOf("async function shipFromOrder") + 700);
  assert.match(fn, /canShipFromOrder\(o\)/);
});

// ===== 2. 「発送済にする」は受注の状態を見る =====
t("受付済・受注確定 → 受注を「出荷済」にする", () => {
  for (const st of ["received", "confirmed"]) assert.equal(orderOnShipDone({ status: st }).action, "set");
});
t("キャンセル済み → 止める（理由つき）", () => {
  const r = orderOnShipDone({ status: "canceled" });
  assert.equal(r.action, "block");
  assert.equal(r.reason, ORDER_CANCELED_NO_SHIPPED_MSG);
});
t("すでに出荷済・状態なし・知らない値・受注なし → 受注には書かない", () => {
  for (const o of [{ status: "shipped" }, {}, { status: "???" }, null, undefined]) assert.equal(orderOnShipDone(o).action, "keep", JSON.stringify(o));
});
t("supply.js の発送済にする（shipWithStock）が、無条件の書き込みをやめて判定を通っている", () => {
  const s = read("admin/js/supply.js");
  const fn = s.slice(s.indexOf("async function shipWithStock"), s.indexOf("function markShipped(s)"));
  assert.match(fn, /orderOnShipDone\(/);
  assert.match(fn, /poPlan\.action==="block"\) throw new Error\(poPlan\.reason\)/);
  assert.match(fn, /poPlan\.action==="set"\) tx\.update\(po\.ref/);
  assert.ok(!/if\(po && po\.exists\(\)\) tx\.update\(po\.ref, \{ status:"shipped"/.test(fn), "無条件の書き込みが残っている");
});
t("練習の代役（practice-stubs.js の倉庫の発送）は本番の Functions と同じ形のまま（test-record-gaps が照合）＝この判定を通さない", () => {
  assert.ok(!read("admin/js/practice-stubs.js").includes("order-ship-rules"));
});
t("純粋: order-ship-rules.js は firebase を読まない", () => {
  assert.ok(!/firebase|updateDoc|setDoc|runTransaction|addDoc/.test(read("admin/js/order-ship-rules.js").replace(/\/\/.*$/gm, "")));
});
t("Functions・rules は変えていない前提の目印: functions/index.js の warehouse 側はこの判定をまだ通らない（既知の限界）", () => {
  assert.ok(!read("functions/index.js").includes("order-ship-rules"));
});

console.log(`order-ship-rules: ${n} 件 合格`);
