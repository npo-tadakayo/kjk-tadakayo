// 受注と出荷のつなぎ（2026-11-13・小さな残り4件のうち1・2・4）の単体テストと結線の静的検査。
// node scripts/test-order-ship-rules.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canShipFromOrder, orderOnShipDone, orderOnWarehouseDone, ORDER_CANCELED_NO_SHIP_MSG, ORDER_CANCELED_NO_SHIPPED_MSG, ORDER_CANCELED_KEPT_NOTE,
  canceledOrderShipWarn, canceledOrderInvoiceConfirmText, ORDER_CANCELED_SHIPPED_WARN } from "../admin/js/order-ship-rules.js";

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
t("純粋: order-ship-rules.js は firebase を読まない", () => {
  assert.ok(!/firebase|updateDoc|setDoc|runTransaction|addDoc/.test(read("admin/js/order-ship-rules.js").replace(/\/\/.*$/gm, "")));
});

// ===== 3. 倉庫の発送完了（warehouseComplete・練習の whMarkShipped）は受注の状態を見る（2026-11-15） =====
t("倉庫: 受付済・受注確定 → 受注を「出荷済」にする（印は残さない）", () => {
  for (const st of ["received", "confirmed"]) assert.deepEqual(orderOnWarehouseDone({ status: st }), { action: "set", note: "" });
});
t("倉庫: キャンセル済み → 受注は書き換えない・止めない（物は出ている）・出荷に残す文", () => {
  const r = orderOnWarehouseDone({ status: "canceled" });
  assert.equal(r.action, "keep");
  assert.equal(r.note, "受注がキャンセル済みのため受注の状態は変えていません");
  assert.equal(r.note, ORDER_CANCELED_KEPT_NOTE);
});
t("倉庫: 出荷済・状態なし・知らない値・受注なし → 受注には書かない・印も残さない（block は返さない）", () => {
  for (const o of [{ status: "shipped" }, {}, { status: "???" }, null, undefined]) assert.deepEqual(orderOnWarehouseDone(o), { action: "keep", note: "" }, JSON.stringify(o));
});
t("倉庫: どの状態でも block を返さない（画面の orderOnShipDone と違い、発送の完了は止めない）", () => {
  for (const st of ["received", "confirmed", "shipped", "canceled", "", "x"]) assert.notEqual(orderOnWarehouseDone({ status: st }).action, "block");
});
t("Functions のコピーがバイト単位で同じ・check-shared-sync.sh に節がある", () => {
  assert.equal(read("functions/order-ship-rules.mjs"), read("admin/js/order-ship-rules.js"));
  assert.match(read("scripts/check-shared-sync.sh"), /cmp -s admin\/js\/order-ship-rules\.js functions\/order-ship-rules\.mjs/);
});
t("Functions の warehouseComplete と練習の whMarkShipped が orderOnWarehouseDone を通る（無条件の書き込みが無い）", () => {
  const fn = read("functions/index.js");
  const wc = fn.slice(fn.indexOf("async function warehouseComplete"), fn.indexOf("exports.warehouseShip"));
  assert.match(wc, /os\.orderOnWarehouseDone\(po\.data\(\)\)/);
  assert.ok(!/if \(po && po\.exists\) tx\.update\(po\.ref/.test(wc), "本番に無条件の書き込みが残っている");
  const ps = read("admin/js/practice-stubs.js");
  const wh = ps.slice(ps.indexOf("async function whMarkShipped"), ps.indexOf("async function whMarkShipped") + 4000);
  assert.match(wh, /orderOnWarehouseDone\(po\.data\(\)\)/);
  assert.ok(!/if \(po && po\.exists\(\)\) tx\.update\(po\.ref/.test(wh), "練習に無条件の書き込みが残っている");
});


// ===== 4. 受注がキャンセル済みのまま倉庫が発送した出荷を画面で知らせる（2026-11-15 レビュー中-1） =====
const NOTED = { soNumber: "SH-9", partnerOrderId: "po1", partnerOrderNote: ORDER_CANCELED_KEPT_NOTE };
t("警告: 印があり、受注がいまもキャンセル済みのときだけ出す", () => {
  assert.equal(ORDER_CANCELED_SHIPPED_WARN, "⚠ 受注がキャンセル済みのまま発送されました。受注の状態を確認してください");
  assert.equal(canceledOrderShipWarn(NOTED, { status: "canceled" }), ORDER_CANCELED_SHIPPED_WARN);
  // 受注を戻したら出ない（出荷の印は残っていても）
  for (const st of ["received", "confirmed", "shipped", undefined]) assert.equal(canceledOrderShipWarn(NOTED, { status: st }), "", String(st));
  // 印が無い・受注が無い・受注のひも付けが無い
  assert.equal(canceledOrderShipWarn({ ...NOTED, partnerOrderNote: "" }, { status: "canceled" }), "");
  assert.equal(canceledOrderShipWarn(NOTED, null), "");
  assert.equal(canceledOrderShipWarn({ ...NOTED, partnerOrderId: "" }, { status: "canceled" }), "");
  assert.equal(canceledOrderShipWarn(null, { status: "canceled" }), "");
});
t("確認の文: 警告と同じ条件で、出荷番号入り。出さないときは空", () => {
  const a = canceledOrderInvoiceConfirmText(NOTED, { status: "canceled" });
  assert.ok(a.startsWith(ORDER_CANCELED_SHIPPED_WARN) && a.includes("出荷 SH-9") && a.includes("このまま請求を進めますか？"));
  assert.equal(canceledOrderInvoiceConfirmText(NOTED, { status: "confirmed" }), "");
  assert.equal(canceledOrderInvoiceConfirmText({ soNumber: "SH-1", partnerOrderId: "po1" }, { status: "canceled" }), "");
});
t("画面: 出荷一覧の行・受注一覧の行に esc して出す。受注の更新で出荷一覧も描き直す", () => {
  const s = read("admin/js/supply.js");
  assert.match(s, /const orderOfShip = \(s\)=> s && s\.partnerOrderId \? \(partnerOrdersCache\.find\(o=>o\._id===s\.partnerOrderId\)\|\|null\) : null;/);
  assert.match(s, /const poWarn = canceledOrderShipWarn\(s, orderOfShip\(s\)\);/);
  assert.match(s, /color:var\(--color-danger\);font-weight:600"><i class="ti ti-alert-triangle" aria-hidden="true"><\/i> \$\{esc\(poWarn\)\}<\/div>` : "";/);
  assert.match(s, /\$\{issueHtml\}\$\{poWarnHtml\}/);
  const po = s.slice(s.indexOf("function renderPartnerOrders"), s.indexOf("document.querySelectorAll(\".po-status\")"));
  assert.match(po, /const poWarn = rel\.map\(s=>canceledOrderShipWarn\(s, o\)\)\.find\(Boolean\) \|\| "";/);
  assert.match(po, /\$\{poWarn\?`<div class="po-canceled-warn"[^`]*\$\{esc\(poWarn\)\}<\/div>`:""\}/);
  assert.equal((s.match(/\$\{esc\(poWarn\)\}/g) || []).length, 2, "esc を通さずに出している所がある");
  const snap = s.slice(s.indexOf('collection(db,"partnerOrders"),orderBy("createdAt","desc")'));
  assert.match(snap.slice(0, 400), /renderPartnerOrders\(partnerOrdersCache\);\n\s*renderShipmentsView\(\);/);
});
t("画面: 請求済にする（doInvoiceReport）は受注を読み直して確かめ、書き込みより前", () => {
  const s = read("admin/js/supply.js");
  const fn = s.slice(s.indexOf("async function doInvoiceReport"), s.indexOf("async function doInvoiceReport") + 6000);
  assert.match(fn, /if\(!invReportOnly && s\.partnerOrderId && s\.partnerOrderNote\)\{/);
  assert.match(fn, /await getDoc\(doc\(db,"partnerOrders",String\(s\.partnerOrderId\)\)\)/);
  assert.match(fn, /const poAsk = canceledOrderInvoiceConfirmText\(s, po\);\n\s*if\(poAsk && !confirm\(poAsk\)\) return;/);
  assert.ok(fn.indexOf("canceledOrderInvoiceConfirmText") < fn.indexOf("markInvoiced(db"), "確認が請求済の書き込みより後");
});
t("画面: 請求書の印刷・メール（supply-print.js）も確かめる。動き（キャンセル→いいえで止まる・はいで進む・印なしは聞かない）", () => {
  const p = read("admin/js/supply-print.js");
  assert.match(p, /if\(type==="invoice" && !confirmInvoiceCanceledOrder\(\)\) return;\n\s*if\(type==="invoice" && !confirmInvoiceShipFee\(\)\) return;/);
  assert.match(p, /if\(kind==="invoice" && !confirmInvoiceCanceledOrder\(\)\) return;\n\s*if\(kind==="invoice" && !confirmInvoiceShipFee\(\)\) return;/);
  assert.match(p, /docInvoiceOrder=os\.exists\(\)\?os\.data\(\):null;/);
  const head = "function confirmInvoiceCanceledOrder(){";
  const body = p.slice(p.indexOf(head), p.indexOf("\n}\n", p.indexOf(head)) + 3);
  const run = (ship, order, answer) => { const asked = [];
    const ret = new Function("canceledOrderInvoiceConfirmText", "docInvoiceShip", "docInvoiceOrder", "confirm", `${body}\nreturn confirmInvoiceCanceledOrder();`)(
      canceledOrderInvoiceConfirmText, ship, order, (m) => { asked.push(m); return answer; });
    return { ret, asked }; };
  let r = run(NOTED, { status: "canceled" }, false); assert.equal(r.ret, false); assert.equal(r.asked.length, 1);
  r = run(NOTED, { status: "canceled" }, true); assert.equal(r.ret, true);
  r = run(NOTED, { status: "confirmed" }, false); assert.equal(r.ret, true); assert.equal(r.asked.length, 0);
  r = run(null, null, false); assert.equal(r.ret, true);
});
console.log(`order-ship-rules: ${n} 件 合格`);
