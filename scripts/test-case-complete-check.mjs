// 完了(13)にするときの警告（admin/js/case-complete-check.js）のテスト。node scripts/test-case-complete-check.mjs
import assert from "node:assert/strict";
import { completionWarnings, payRemainOf, billableInclOf, netPaidOf, shipStatusOf } from "../admin/js/case-complete-check.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };

// 事業所への直接販売（明細は税込）: 11,000円×2 + 送料0 = 22,000
const item = [{ sku: "bt", qty: 2, unitPrice: 11000 }];
const ship = (o) => ({ soNumber: "SH-2026-0001", shipType: "direct", items: item, shippingFee: 0, ...o });
const SA_OK = { status: "deposited", applicationDate: "2026-10-01", actualDepositDate: "2026-12-25" };
const has = (arr, word) => arr.some((w) => w.includes(word));

t("すべて済んでいれば警告なし", () => {
  const s = ship({ status: "paid", payments: [{ amount: 22000 }], receiptIssuedAt: "2026-11-01" });
  assert.deepEqual(completionWarnings({ shipments: [s], subsidy: SA_OK }), []);
  // 入金日だけ記録されて状態が採択のままでも、入金日があれば警告しない
  assert.deepEqual(completionWarnings({ shipments: [s], subsidy: { ...SA_OK, status: "adopted" } }), []);
});

t("1. 出荷なし（キャンセルだけも出荷なし）", () => {
  assert.ok(has(completionWarnings({ shipments: [], subsidy: SA_OK }), "出荷の記録がありません"));
  assert.ok(has(completionWarnings({ shipments: [ship({ status: "canceled" })], subsidy: SA_OK }), "出荷の記録がありません"));
  assert.ok(has(completionWarnings({ subsidy: SA_OK }), "出荷の記録がありません"));
});

t("2. 未発送（下書き・依頼済）", () => {
  const w = completionWarnings({ shipments: [ship({ status: "draft" }), ship({ status: "requested", soNumber: "SH-2026-0002" })], subsidy: SA_OK });
  assert.ok(has(w, "まだ発送していない出荷があります（SH-2026-0001・SH-2026-0002）"), w.join("\n"));
  assert.equal(w.length, 1); // 下書きは請求・入金の警告を重ねない
});

t("3. 請求書未発行（状態なしの古い出荷も発送済扱い）", () => {
  assert.ok(has(completionWarnings({ shipments: [ship({ status: "shipped" })], subsidy: SA_OK }), "請求書を出していない"));
  assert.ok(has(completionWarnings({ shipments: [ship({})], subsidy: SA_OK }), "請求書を出していない"));
  assert.equal(shipStatusOf({}), "shipped");
});

t("4. 入金未了（部分入金・返金・過入金の充当）", () => {
  const part = ship({ status: "invoiced", payments: [{ amount: 10000 }] });
  assert.equal(payRemainOf(part), 12000);
  assert.ok(has(completionWarnings({ shipments: [part], subsidy: SA_OK }), "SH-2026-0001 残 ¥12,000"));
  // 返金は純入金から引く: 22,000 入金 − 2,000 返金 → 残 2,000
  const ref = ship({ status: "paid", payments: [{ amount: 22000 }], refunds: [{ amount: 2000 }], receiptIssuedAt: "x" });
  assert.equal(netPaidOf(ref), 20000);
  assert.equal(payRemainOf(ref), 2000);
  assert.ok(has(completionWarnings({ shipments: [ref], subsidy: SA_OK }), "残 ¥2,000"));
  // 過入金の充当 5,000 → 請求 17,000。17,000 入金で残 0
  const cr = ship({ status: "paid", creditApplied: 5000, payments: [{ amount: 17000 }], receiptIssuedAt: "x" });
  assert.equal(billableInclOf(cr), 17000);
  assert.equal(payRemainOf(cr), 0);
  assert.deepEqual(completionWarnings({ shipments: [cr], subsidy: SA_OK }), []);
  // 旧形式（paymentAmount）も入金として数える
  const old = ship({ status: "paid", paymentAmount: 22000, receiptIssuedAt: "x" });
  assert.equal(payRemainOf(old), 0);
  // 過入金でも残額はマイナスにしない
  assert.equal(payRemainOf(ship({ status: "paid", payments: [{ amount: 30000 }] })), 0);
  // 認定事業者向け（税抜）: 10,000×2 + 送料 1,000 → 21,000 + 税 2,100 = 23,100
  const dp = ship({ status: "invoiced", shipType: "dropship", partnerEmail: "p@example.jp", items: [{ sku: "bt", qty: 2, unitPrice: 10000 }], shippingFee: 1000 });
  assert.equal(payRemainOf(dp), 23100);
  // 2件なら合計も出す
  const w = completionWarnings({ shipments: [part, dp], subsidy: SA_OK });
  assert.ok(has(w, "計 ¥35,100"), w.join("\n"));
});

t("5. 領収証未発行", () => {
  const s = ship({ status: "paid", payments: [{ amount: 22000 }] });
  assert.ok(has(completionWarnings({ shipments: [s], subsidy: SA_OK }), "領収証を出していない出荷があります（SH-2026-0001）"));
});

t("6〜8. 助成金", () => {
  const s = ship({ status: "paid", payments: [{ amount: 22000 }], receiptIssuedAt: "x" });
  // 申請情報が無い → 申請日・入金日の両方
  const none = completionWarnings({ shipments: [s], subsidy: null });
  assert.ok(has(none, "申請日が入っていません") && has(none, "入金日が記録されていません"));
  assert.equal(none.length, 2);
  // 申請済・入金日なし
  const ap = completionWarnings({ shipments: [s], subsidy: { status: "applied", applicationDate: "2026-10-01" } });
  assert.deepEqual(ap, ["助成金の入金日が記録されていません（申請情報タブ）"]);
  // 状態が入金済なら入金日が空でも出さない
  assert.deepEqual(completionWarnings({ shipments: [s], subsidy: { status: "deposited", applicationDate: "2026-10-01" } }), []);
  // 不採択 → 不採択の警告のみ（入金未記録は出さない）
  const rj = completionWarnings({ shipments: [s], subsidy: { status: "rejected", applicationDate: "2026-10-01" } });
  assert.equal(rj.length, 1);
  assert.ok(has(rj, "不採択"));
});

t("8種類が同時に出る", () => {
  const w = completionWarnings({ shipments: [], subsidy: { status: "rejected" } });
  assert.equal(w.length, 3); // 出荷なし・申請日・不採択
  const all = completionWarnings({
    shipments: [ship({ status: "draft" }), ship({ status: "shipped" }), ship({ status: "invoiced" }),
      ship({ status: "paid", payments: [{ amount: 22000 }] })],
    subsidy: {},
  });
  assert.equal(all.length, 6); // 未発送・未請求・入金未了・領収証・申請日・入金日
});

console.log(`OK test-case-complete-check: ${n} 件合格`);
