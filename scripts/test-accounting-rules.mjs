// 経理への期末報告の集計（admin/js/accounting-rules.js）のテスト。node scripts/test-accounting-rules.mjs
//
// ここで確かめること
//   ① 日付: JST への変換（UTC 14:59 は同じ日・15:00 は翌日）・期首の既定・締め日の検査
//   ② 売上: 請求日 10/31 は入る・11/1 は入らない・キャンセル／下書き／練習データは数えない・直接／直送の分け方・月別
//   ③ 未収金: 一部入金・締め日後の入金は数えない・返金・paidAt だけの旧形式・過入金の充当
//   ④ 未請求出荷: 締め日後に請求済／いまも未請求の分け方・出荷日が締め日後なら出さない
//   ⑤ 在庫: 到着日での数え方（記録 11/1・到着 10/30 は入る）・location_assign は合計を変えない・移動中・未設定・金額
//   ⑥ 未着品: 運送中／未出荷の分け方・届いた発注は出さない・下書きは出さない
//   ⑦ 仕入: 到着日 → 入荷登録の日 → 発注日の順で日付を決める・品代と送料を分ける
//   ⑧ 買掛金: 記録が無ければ未確認（null）・記録があれば締め日までの支払いを差し引く
//   ⑨ 返金・過入金・CSV（BOM・引用符・ファイル名に締め日）
//   ⑩ 画面の配線（ナビ・管理者だけ・CDN を足していない・supply.js の到着日の修正）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ymdJst, addDaysYmd, defaultPeriodStart, periodOf, settlementAt, salesOf, receivablesOf, unbilledOf, inventoryAt, movementYmd,
  openOrdersOf, purchasesOf, payablesOf, refundsOf, unitCostsOf, buildReport, toCsv, reportCsvFiles, billsPartner, UNSET_LOCATION, IN_TRANSIT_LOCATION,
} from "../admin/js/accounting-rules.js";
import { invoiceTotals } from "../admin/js/invoice-doc.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const P = { start: "2025-11-01", cutoff: "2026-10-31" };
const ts = (iso) => ({ toDate: () => new Date(iso) }); // Firestore Timestamp のかわり

// 事業所向け（税込の明細）1台 33,000円＋伴走支援費
const ship = (o) => ({ soNumber: "SH-X", status: "invoiced", shipType: "direct", partnerEmail: "", company: "A事業所",
  items: [{ sku: "cir415a-01", qty: 1, unitPrice: 33000 }], shippingFee: 0, shipDate: "2026-10-20", invoicedAt: "2026-10-25", ...o });

t("① JST の日付（UTC 14:59 は同じ日、15:00 は翌日）", () => {
  assert.equal(ymdJst("2026-10-31"), "2026-10-31");
  assert.equal(ymdJst("2026-10-31T14:59:59.000Z"), "2026-10-31");
  assert.equal(ymdJst("2026-10-31T15:00:00.000Z"), "2026-11-01");
  assert.equal(ymdJst(ts("2026-10-31T15:00:00Z")), "2026-11-01");
  assert.equal(ymdJst({ _ts: "2026-10-31T21:39:30.416Z" }), "2026-11-01"); // PO-0051 の入荷記録（11/1 6:39 JST）
  assert.equal(ymdJst({ seconds: Date.parse("2026-10-31T14:00:00Z") / 1000 }), "2026-10-31");
  assert.equal(ymdJst(new Date("2026-10-31T15:30:00Z")), "2026-11-01");
  assert.equal(ymdJst(""), ""); assert.equal(ymdJst(null), ""); assert.equal(ymdJst("10/31"), "");
});
t("① 期首の既定・日付の足し算・期間の検査", () => {
  assert.equal(defaultPeriodStart("2026-10-31"), "2025-11-01");
  assert.equal(defaultPeriodStart("2027-02-28"), "2026-03-01");
  assert.equal(addDaysYmd("2026-10-31", 1), "2026-11-01");
  assert.deepEqual(periodOf("2026-10-31"), { start: "2025-11-01", cutoff: "2026-10-31" });
  assert.deepEqual(periodOf("2026-10-31", "2026-04-01"), { start: "2026-04-01", cutoff: "2026-10-31" });
  assert.throws(() => periodOf("2026/10/31"));
  assert.throws(() => periodOf("2026-10-31", "2026-11-01"));
});

t("② 売上: 締め日 10/31 は入る・11/1 は入らない・期首の前日も入らない", () => {
  const r = salesOf([ship({ soNumber: "a", invoicedAt: "2026-10-31" }), ship({ soNumber: "b", invoicedAt: "2026-11-01" }),
    ship({ soNumber: "c", invoicedAt: "2025-10-31" }), ship({ soNumber: "d", invoicedAt: "2025-11-01", status: "paid" })], P);
  assert.deepEqual(r.rows.map((x) => x.soNumber), ["d", "a"]);
  assert.equal(r.total, 66000);
  assert.equal(r.tax, invoiceTotals(ship({})).tax * 2);
});
t("② 売上: キャンセル・下書き・発送済（未請求）・練習データは数えない", () => {
  const r = salesOf([ship({ status: "canceled" }), ship({ status: "draft" }), ship({ status: "shipped" }), ship({ _practiceBy: "x@tadakayo.jp" }), ship({})], P);
  assert.equal(r.count, 1);
});
t("② 売上: 直接／直送の分け方（invoiceTotals の税基準と同じ）と月別", () => {
  const drop = ship({ soNumber: "p", shipType: "dropship", partnerEmail: "p@x", partnerName: "認定B", invoicedAt: "2026-08-10",
    items: [{ sku: "cir415a-01", qty: 10, unitPrice: 8000 }], shippingFee: 1000 });
  assert.equal(billsPartner(drop), true);
  assert.equal(billsPartner(ship({ shipType: "stock", partnerEmail: "p@x" })), true);
  assert.equal(billsPartner(ship({})), false);
  const r = salesOf([drop, ship({ invoicedAt: "2026-10-01" })], P);
  assert.equal(r.partner.count, 1); assert.equal(r.direct.count, 1);
  assert.equal(r.partner.total, invoiceTotals(drop).total); // 税別 81,000 → 税込 89,100
  assert.equal(r.partner.total, 89100);
  assert.deepEqual(r.byMonth.map((m) => [m.month, m.count]), [["2026-08", 1], ["2026-10", 1]]);
  assert.equal(r.rows[0].billTo, "認定B");
});

t("③ 未収金: 一部入金・締め日後の入金は数えない", () => {
  const s = ship({ payments: [{ amount: 10000, date: "2026-10-31" }, { amount: 23000, date: "2026-11-01" }], status: "paid", paidAt: "2026-11-01" });
  const st = settlementAt(s, "2026-10-31");
  assert.equal(st.paid, 10000); assert.equal(st.balance, 23000);
  const r = receivablesOf([s], P);
  assert.equal(r.count, 1); assert.equal(r.total, 23000);
  assert.equal(r.rows[0].paid, 10000); assert.equal(r.rows[0].paidDate, "2026-11-01");
  // 11/1 の締めなら全額入金で出ない
  assert.equal(receivablesOf([s], { cutoff: "2026-11-01" }).count, 0);
});
t("③ 未収金: 返金（締め日まで）を差し引く・paidAt だけの旧形式は全額入金扱い・充当は請求額から引く", () => {
  const over = ship({ payments: [{ amount: 40000, date: "2026-10-26" }], refunds: [{ amount: 7000, date: "2026-10-30" }], status: "paid" });
  assert.equal(settlementAt(over, "2026-10-31").balance, 0);
  const overLate = ship({ payments: [{ amount: 40000, date: "2026-10-26" }], refunds: [{ amount: 7000, date: "2026-11-02" }], status: "paid" });
  assert.equal(settlementAt(overLate, "2026-10-31").balance, -7000); // 締め日時点では過入金
  const legacy = ship({ status: "paid", paidAt: "2026-10-30" });
  assert.equal(settlementAt(legacy, "2026-10-31").balance, 0);
  assert.equal(settlementAt(legacy, "2026-10-29").balance, 33000);
  const credit = ship({ creditApplied: 3000 });
  assert.equal(settlementAt(credit, "2026-10-31").billable, 30000);
  // 入金の日付が空なら記録した日時（recordedAt）の JST 日付
  const noDate = ship({ payments: [{ amount: 33000, date: "", recordedAt: "2026-10-31T16:00:00Z" }] });
  assert.equal(settlementAt(noDate, "2026-10-31").paid, 0);
  assert.equal(settlementAt(noDate, "2026-11-01").paid, 33000);
});
t("③ 未収金: 請求日が締め日後・キャンセルは出さない", () => {
  assert.equal(receivablesOf([ship({ invoicedAt: "2026-11-01" }), ship({ status: "canceled" })], P).count, 0);
});

t("④ 未請求出荷: 締め日後に請求済／いまも未請求", () => {
  const r = unbilledOf([
    ship({ soNumber: "a", status: "shipped", invoicedAt: "", shipDate: "2026-10-31" }),
    ship({ soNumber: "b", status: "invoiced", invoicedAt: "2026-11-02", shipDate: "2026-10-30" }),
    ship({ soNumber: "c", status: "shipped", invoicedAt: "", shipDate: "2026-11-01" }),   // 出荷が締め日後
    ship({ soNumber: "d", status: "invoiced", invoicedAt: "2026-10-31", shipDate: "2026-10-30" }), // 締め日までに請求
    ship({ soNumber: "e", status: "requested", invoicedAt: "", shipDate: "2026-10-01" }), // まだ発送していない
    ship({ soNumber: "f", status: "canceled", invoicedAt: "", shipDate: "2026-10-01" }),
  ], P);
  assert.deepEqual(r.rows.map((x) => x.soNumber), ["b", "a"]);
  assert.equal(r.later.count, 1); assert.equal(r.still.count, 1);
  assert.equal(r.total, 66000);
});

// 在庫
const LOCS = [{ _id: "L1", name: "ロジ" }, { _id: "L2", name: "沖縄" }];
const mv = (reason, delta, createdAt, o = {}) => ({ sku: "cir415a-01", reason, delta, createdAt: { _ts: createdAt }, locationId: "L1", ...o });
const PO51 = { poNumber: "PO-51", status: "received", orderDate: "2026-10-21", arrivedDate: "2026-10-30", arrivalBasis: "実績",
  items: [{ sku: "cir415a-01", qty: 100, unitPrice: 7050 }], shippingFee: 0, receivedAt: { _ts: "2026-10-31T21:39:30Z" } };
t("⑤ 在庫: 入荷の記録が 11/1 でも、到着日 10/30 なら 10/31 の在庫に入る", () => {
  const m = mv("po_received", 100, "2026-10-31T21:39:30Z", { refNo: "PO-51" });
  assert.equal(movementYmd(m, { "PO-51": PO51 }), "2026-10-30");
  assert.equal(movementYmd(m, {}), "2026-11-01");
  const r = inventoryAt([m], [PO51], { cutoff: "2026-10-31", locations: LOCS });
  assert.equal(r.total, 100); assert.equal(r.adjusted, 1);
  assert.equal(r.rows[0].location, "ロジ"); assert.equal(r.rows[0].unitCost, 7050); assert.equal(r.amount, 705000);
  assert.equal(inventoryAt([m], [PO51], { cutoff: "2026-10-31", arrivalBasis: false }).total, 0);
  // 到着日が無い発注は記録の日（11/1）で数える
  assert.equal(inventoryAt([m], [{ ...PO51, arrivedDate: "" }], { cutoff: "2026-10-31" }).total, 0);
});
t("⑤ 在庫: 到着日が締め日後なら、記録が締め日前でも入らない", () => {
  const m = mv("po_received", 100, "2026-10-30T01:00:00Z", { refNo: "PO-51" });
  assert.equal(inventoryAt([m], [{ ...PO51, arrivedDate: "2026-11-02" }], { cutoff: "2026-10-31" }).total, 0);
});
t("⑤ 在庫: 割り当て（location_assign）は合計を変えない・未設定の行・移動中の行", () => {
  const ms = [
    mv("po_received", 200, "2026-08-05T09:00:00Z", { locationId: "", refNo: "" }),  // 場所なしで入荷
    mv("location_assign", 150, "2026-09-12T05:00:00Z"),                            // 150台をロジへ割り当て
    mv("shipment", -10, "2026-09-20T05:00:00Z"),
    mv("transfer_out", -30, "2026-10-30T05:00:00Z", { refNo: "TR-1" }),            // ロジ→沖縄へ発送（11/2 着）
    mv("transfer_in", 30, "2026-11-02T05:00:00Z", { refNo: "TR-1", locationId: "L2" }),
  ];
  const r = inventoryAt(ms, [PO51], { cutoff: "2026-10-31", locations: LOCS });
  assert.equal(r.total, 190);
  const by = Object.fromEntries(r.rows.map((x) => [x.location, x.qty]));
  assert.deepEqual(by, { "ロジ": 110, [IN_TRANSIT_LOCATION]: 30, [UNSET_LOCATION]: 50 });
  assert.equal(r.unset, 50); assert.equal(r.transit, 30);
  const after = inventoryAt(ms, [PO51], { cutoff: "2026-11-02", locations: LOCS });
  assert.equal(after.total, 190); assert.equal(after.transit, 0);
  assert.equal(Object.fromEntries(after.rows.map((x) => [x.location, x.qty]))["沖縄"], 30);
});
t("⑤ 在庫: 仕入単価は締め日までに届いた発注のうち、いちばん新しく届いた発注の単価・単価が無い品目は金額なし", () => {
  const pos = [{ poNumber: "PO-1", status: "received", orderDate: "2026-05-01", receivedAt: ts("2026-05-03T01:00:00Z"), items: [{ sku: "a", qty: 1, unitPrice: 7000 }] },
    { poNumber: "PO-2", status: "received", orderDate: "2026-09-01", arrivedDate: "2026-10-10", items: [{ sku: "a", qty: 1, unitPrice: 7050 }] },
    { poNumber: "PO-5", status: "sent", orderDate: "2026-10-20", arrivedDate: "2026-11-02", items: [{ sku: "a", qty: 1, unitPrice: 8000 }] }, // 締め日後に着
    { poNumber: "PO-6", status: "sent", orderDate: "2026-10-25", items: [{ sku: "a", qty: 1, unitPrice: 8500 }] },                         // まだ届いていない
    { poNumber: "PO-3", status: "sent", orderDate: "2026-11-05", items: [{ sku: "a", qty: 1, unitPrice: 9999 }] },
    { poNumber: "PO-4", status: "draft", orderDate: "2026-10-20", arrivedDate: "2026-10-21", items: [{ sku: "a", qty: 1, unitPrice: 1 }] }];
  assert.deepEqual(unitCostsOf(pos, "2026-10-31"), { a: 7050 });
  assert.deepEqual(unitCostsOf(pos, "2026-09-30"), { a: 7000 });
  const r = inventoryAt([mv("manual_in", 3, "2026-10-01T00:00:00Z", { sku: "zzz" })], pos, { cutoff: "2026-10-31", locations: LOCS });
  assert.equal(r.rows[0].amount, null); assert.deepEqual(r.missingCost, ["zzz"]);
});
t("⑤ 在庫: 練習データは数えない", () => {
  assert.equal(inventoryAt([mv("manual_in", 5, "2026-10-01T00:00:00Z", { _practiceBy: "x" })], [], { cutoff: "2026-10-31" }).total, 0);
});

const po = (o) => ({ poNumber: "PO-X", status: "sent", orderDate: "2026-10-26", items: [{ sku: "cir415a-01", qty: 100, unitPrice: 7050 }], shippingFee: 0, ...o });
t("⑥ 未着品: 運送中（先方出荷 ≤ 締め日）と未出荷", () => {
  const r = openOrdersOf([
    po({ poNumber: "PO-50", supplierShipDate: "2026-10-29", arrivedDate: "2026-11-02", arrivalBasis: "実績", status: "received" }),
    po({ poNumber: "PO-54", orderDate: "2026-10-30", supplierShipDate: "2026-11-02", arrivedDate: "2026-11-04", items: [{ sku: "c", qty: 1, unitPrice: 3770 }], shippingFee: 900, dropship: true }),
    po({ poNumber: "PO-51", supplierShipDate: "2026-10-29", arrivedDate: "2026-10-30", status: "received" }), // 締め日までに届いて入荷登録済み
    po({ poNumber: "PO-99", orderDate: "2026-11-01" }),                                          // 締め日後の発注
    po({ poNumber: "PO-D", status: "draft" }),
    po({ poNumber: "PO-R", arrivedDate: "", receivedAt: ts("2026-10-31T10:00:00Z"), status: "received" }), // 到着日なし・入荷登録 10/31
    po({ poNumber: "PO-N", arrivedDate: "", supplierShipDate: "" }),                             // 何も無い＝未出荷
  ], P);
  assert.deepEqual(r.rows.map((x) => [x.poNumber, x.state]),
    [["PO-50", "先方出荷済み・運送中"], ["PO-N", "未出荷"], ["PO-54", "未出荷"]]);
  assert.equal(r.inTransit.count, 1); assert.equal(r.notShipped.count, 2);
  assert.equal(r.rows.find((x) => x.poNumber === "PO-54").amount, 4670);
});
t("⑦ 仕入: 日付は 到着日 → 入荷登録の日 → 発注日・品代と送料を分ける", () => {
  const r = purchasesOf([
    po({ poNumber: "A", arrivedDate: "2026-10-30", shippingFee: 1100 }),
    po({ poNumber: "B", arrivedDate: "", receivedAt: ts("2026-10-31T16:00:00Z") }),  // 入荷登録 11/1 JST → 期外
    po({ poNumber: "C", arrivedDate: "", orderDate: "2026-10-01" }),                  // 発注日で数える
    po({ poNumber: "D", arrivedDate: "2026-11-02" }),
    po({ poNumber: "E", status: "draft", arrivedDate: "2026-10-01" }),
  ], P);
  assert.deepEqual(r.rows.map((x) => [x.poNumber, x.date, x.dateBasis]), [["C", "2026-10-01", "発注日"], ["A", "2026-10-30", "到着日（区分なし）"]]);
  assert.equal(r.goods, 1410000); assert.equal(r.shippingFee, 1100);
});
t("⑧ 買掛金: 支払いの記録が無ければ未確認・あれば締め日までの支払いを差し引く", () => {
  const none = payablesOf([po({ arrivedDate: "2026-10-30" })], P);
  assert.equal(none.recorded, false); assert.equal(none.total, null); assert.equal(none.count, null);
  const some = payablesOf([
    po({ poNumber: "A", arrivedDate: "2026-10-30", supplierPaidDate: "2026-10-31", supplierPaidAmount: 705000 }),
    po({ poNumber: "B", arrivedDate: "2026-10-30", supplierPaidDate: "2026-11-05", supplierPaidAmount: 705000 }),
    po({ poNumber: "C", arrivedDate: "2026-11-02" }),
  ], P);
  assert.equal(some.recorded, true); assert.deepEqual(some.rows.map((x) => x.poNumber), ["B"]); assert.equal(some.total, 705000);
});
t("⑨ 返金・充当・締め日時点の過入金", () => {
  const r = refundsOf([
    ship({ soNumber: "a", status: "paid", payments: [{ amount: 33093, date: "2026-07-31" }], refunds: [{ amount: 93, date: "2026-08-01", method: "振込" }], invoicedAt: "2026-07-30" }),
    ship({ soNumber: "b", creditApplied: 500, creditFrom: [{ soNumber: "SH-1", amount: 500 }] }),
    ship({ soNumber: "c", status: "paid", payments: [{ amount: 34000, date: "2026-10-28" }], refunds: [{ amount: 1000, date: "2026-11-03" }] }),
  ], P);
  assert.deepEqual(r.refunds.map((x) => [x.soNumber, x.amount, x.inPeriod]), [["a", 93, true]]);
  assert.deepEqual(r.credits.map((x) => [x.soNumber, x.amount, x.from]), [["b", 500, "SH-1"]]);
  assert.deepEqual(r.overpaid.map((x) => [x.soNumber, x.amount]), [["c", 1000]]);
});
t("⑨ 充当: 充当元の過入金は、締め日までに他の請求へ回した分（overpayUsed・creditFrom）を除く＝二重に出さない", () => {
  const src = ship({ _id: "S1", soNumber: "SRC", status: "paid", payments: [{ amount: 40000, date: "2026-10-10" }], invoicedAt: "2026-10-05", overpayUsed: 7000 });
  const tgt = ship({ _id: "T1", soNumber: "TGT", invoicedAt: "2026-10-20", creditApplied: 7000,
    creditFrom: [{ shipmentId: "S1", soNumber: "SRC", amount: 7000, date: "2026-10-25" }] });
  const r = refundsOf([src, tgt], P);
  assert.deepEqual(r.overpaid, []);                                   // 7,000 の過入金は充当済み
  assert.deepEqual(r.credits.map((x) => [x.soNumber, x.date, x.amount, x.from]), [["TGT", "2026-10-25", 7000, "SRC"]]);
  assert.equal(receivablesOf([src, tgt], P).total, 26000);            // 充当先は 33,000 − 7,000
  // overpayUsed だけ（creditFrom が見つからない古い記録）も充当済みとして扱う
  assert.deepEqual(refundsOf([src], P).overpaid, []);
  // 充当していなければ過入金として出る
  assert.deepEqual(refundsOf([{ ...src, overpayUsed: 0 }], P).overpaid.map((x) => x.amount), [7000]);
});
t("⑨ 充当: 締め日後の充当は、締め日時点の未収金からも過入金からも引かない", () => {
  const src = ship({ _id: "S1", soNumber: "SRC", status: "paid", payments: [{ amount: 40000, date: "2026-10-10" }], invoicedAt: "2026-10-05", overpayUsed: 7000 });
  const tgt = ship({ _id: "T1", soNumber: "TGT", invoicedAt: "2026-10-20", creditApplied: 7000,
    creditFrom: [{ shipmentId: "S1", soNumber: "SRC", amount: 7000, date: "2026-11-05" }] });
  const rc = receivablesOf([src, tgt], P);
  assert.equal(rc.total, 33000);                                      // 締め日時点ではまだ充当していない
  const r = refundsOf([src, tgt], P);
  assert.deepEqual(r.overpaid.map((x) => [x.soNumber, x.amount]), [["SRC", 7000]]);
  assert.deepEqual(r.credits, []);
  // 11/5 締めなら充当済み
  assert.equal(receivablesOf([src, tgt], { cutoff: "2026-11-05" }).total, 26000);
  assert.deepEqual(refundsOf([src, tgt], { start: "2025-11-06", cutoff: "2026-11-05" }).overpaid, []);
  // date の無い古い充当は充当先の請求日で数える／内訳の無い creditApplied も請求日で数える
  assert.equal(settlementAt({ ...tgt, creditFrom: [{ soNumber: "SRC", amount: 7000 }] }, "2026-10-31").credit, 7000);
  assert.equal(settlementAt({ ...tgt, creditFrom: [] }, "2026-10-19").credit, 0);
});
t("⑨ 日付不明: 日付の無い入金・請求日の無い入金済は、黙って未収金・未請求に出さず注記へ", () => {
  const legacy = ship({ soNumber: "OLD", status: "paid", paymentAmount: 33000, paidAt: "" });
  const noRec = ship({ soNumber: "NOREC", status: "invoiced", payments: [{ amount: 10000 }] });
  const rc = receivablesOf([legacy, noRec, ship({ soNumber: "OK" })], P);
  assert.deepEqual(rc.rows.map((x) => x.soNumber), ["OK"]);
  assert.deepEqual(rc.undated, ["NOREC", "OLD"]);
  const ub = unbilledOf([ship({ soNumber: "PAIDNOINV", status: "paid", invoicedAt: "" }), ship({ soNumber: "SH", status: "shipped", invoicedAt: "" })], P);
  assert.deepEqual(ub.rows.map((x) => x.soNumber), ["SH"]);
  assert.deepEqual(ub.paidNoInvoice, ["PAIDNOINV"]);
  const rep = buildReport({ shipments: [legacy, ship({ soNumber: "PAIDNOINV", status: "paid", invoicedAt: "", paidAt: "2026-10-01" })] }, { cutoff: "2026-10-31" });
  assert.match(rep.summary[1].note, /日付不明で除いた 1件（OLD）/);
  assert.match(rep.summary[2].note, /請求日が空で除いた 1件（PAIDNOINV）/);
});
t("⑥ 未着品: 到着日 ≤ 締め日なのに入荷登録前（保管場所へ納品・status sent）は「届いたが入荷登録前」", () => {
  const r = openOrdersOf([
    po({ poNumber: "PO-A", supplierShipDate: "2026-10-28", arrivedDate: "2026-10-30", status: "sent" }),
    po({ poNumber: "PO-B", supplierShipDate: "2026-10-28", arrivedDate: "2026-10-30", status: "sent", dropship: true }), // 直送は入荷登録が無い
    po({ poNumber: "PO-C", supplierShipDate: "2026-10-28", arrivedDate: "2026-10-30", status: "received" }),
  ], P);
  assert.deepEqual(r.rows.map((x) => [x.poNumber, x.state]), [["PO-A", "届いたが入荷登録前"]]);
  assert.equal(r.arrivedUnregistered.count, 1); assert.equal(r.inTransit.count, 0);
  const rep = buildReport({ purchaseOrders: [po({ poNumber: "PO-A", arrivedDate: "2026-10-30", status: "sent" })] }, { cutoff: "2026-10-31" });
  assert.match(rep.summary[4].note, /届いたが入荷登録前 1件/);
});
t("⑨ 要約の8番: 件数と金額の対象をそろえる（返金＋充当＋過入金）", () => {
  const rep = buildReport({ shipments: [
    ship({ soNumber: "a", status: "paid", payments: [{ amount: 33093, date: "2026-10-01" }], refunds: [{ amount: 93, date: "2026-10-02" }] }),
    ship({ soNumber: "c", status: "paid", payments: [{ amount: 34000, date: "2026-10-28" }] }),
  ] }, { cutoff: "2026-10-31" });
  assert.equal(rep.summary[7].count, 2); assert.equal(rep.summary[7].amount, 93 + 1000);
});
t("⑨ CSV: BOM・引用符・改行・ファイル名に締め日", () => {
  const csv = toCsv([{ a: 'x,"y"', b: 1 }], [["見出しA", (r) => r.a], ["B", (r) => r.b]]);
  assert.ok(csv.startsWith("﻿見出しA,B\r\n"));
  assert.ok(csv.includes('"x,""y""",1'));
  const rep = buildReport({ shipments: [ship({})], purchaseOrders: [PO51], movements: [], locations: LOCS }, { cutoff: "2026-10-31" });
  const files = reportCsvFiles(rep);
  assert.deepEqual(files.map((f) => f.key), ["sales", "receivables", "unbilled", "inventory", "openOrders", "purchases", "refunds"]);
  for (const f of files) { assert.ok(f.filename.startsWith("経理報告_20261031_")); assert.ok(f.csv.startsWith("﻿")); }
  assert.equal(rep.summary.length, 8);
  assert.equal(rep.summary[6].amount, null); // 買掛金は未確認
});

// ⑩ 配線
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
t("⑩ ナビに「経理報告」（管理者だけ）・画面は管理者だけ・CDN を新たに足さない", () => {
  const nav = read("admin/js/sidebar.js");
  assert.ok(nav.includes('"/accounting.html"') && nav.includes("経理報告"));
  assert.match(nav, /adminOnly/);
  const html = read("admin/accounting.html");
  const js = read("admin/js/accounting.js");
  assert.match(js, /gateRole\([^)]*adminOnly:\s*true/);
  assert.ok(html.includes("/js/vendor/html2pdf.bundle.min.js"));
  const ext = [...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ext, []);
  assert.ok(js.includes("/js/accounting-rules.js"));
  assert.ok(!/addDoc|updateDoc|setDoc|deleteDoc|runTransaction|writeBatch/.test(js), "経理報告の画面は読むだけ");
});
t("⑩ supply.js: 到着日の表示・管理者だけの修正（在庫・状態は動かさない）・入荷登録で届いた日を保存", () => {
  const js = read("admin/js/supply.js");
  const html = read("admin/supply.html");
  assert.ok(html.includes('id="receiveArrivedDate"'));
  assert.ok(html.includes('id="arrivalModal"'));
  const recv = js.slice(js.indexOf("async function doReceive"), js.indexOf("// ===== 保管場所間の移動"));
  assert.match(recv, /arrivedDate/); assert.match(recv, /arrivalBasis:\s*"実績"/);
  const save = js.slice(js.indexOf("async function saveArrival"), js.indexOf("// ===== 到着日の修正ここまで"));
  assert.ok(save.length > 0);
  assert.match(save, /arrivalRecordedAt:\s*serverTimestamp\(\)/);
  assert.match(save, /arrivalRecordedBy/);
  assert.ok(!/stockPatch|inventoryMovements|status\s*:/.test(save), "到着日の修正は在庫・状態を動かさない");
  assert.match(save, /isAdminUser/);
  assert.match(save, /arrivalBasis==="実績" && arrivedDate > today\(\)/, "到着日の修正でも未来の日付を「実績」にできない");
});

console.log(`合計: ${n}/${n} 合格（accounting-rules）`);
