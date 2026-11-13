// 伴走支援費の PM 値引き（admin/js/pm-discount.js・functions/pm-discount.mjs はその同一コピー）のテスト。
// node scripts/test-pm-discount.mjs　設計: ENGINEERING_NOTES.md §C15（2026-11-13）
//   ①判定の純粋関数（標準額・検査・下限・行・金額・記録・保存前の照合・活動の文言）
//   ②写しの一致（check-shared-sync.sh と同じ）
//   ③画面の結線（見積もりカード・出荷の画面・見積書・合計見積書・練習モードの代役）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as PM from "../admin/js/pm-discount.js";
import Pricing from "../admin/js/estimate-pricing.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };

const baseAmountsOf = (plan, b, u, bx = 0, ux = 0) => {
  const c = Pricing.computeAmounts(plan, b, u, bx, ux);
  return { readers: c.devSubsidyIncl, accompanyFee: c.accFeeIncl, discount: c.discount, subsidyPartTotal: c.subsidyPartTotal,
    extraPartTotal: c.extraPartTotal, totalIncl: c.totalIncl, grantAmt: c.grantAmt, selfPay: c.selfPay };
};

// ===== ② 写し =====
t("functions 側のコピーとバイト単位で同じ・check-shared-sync.sh に節がある", () => {
  assert.equal(read("admin/js/pm-discount.js"), read("functions/pm-discount.mjs"));
  assert.match(read("scripts/check-shared-sync.sh"), /cmp -s admin\/js\/pm-discount\.js functions\/pm-discount\.mjs/);
});
t("exports（firebase を読まない純粋関数だけ）", () => {
  assert.deepEqual(Object.keys(PM).sort(), [
    "FLOOR", "MAX_REASON", "PM_DISCOUNT_NAME", "PM_DISCOUNT_SKU", "applyToAmounts", "buildPmRecord", "checkPmRows", "floorCheck",
    "MSG_USE_QUOTE", "isPmRow", "pmActivityText", "pmAmountOfItems", "pmApplicableShipment", "pmDiscountRow", "pmRemovedByReviseText", "pmRows",
    "recalcPmRecord", "shipmentPmBlockedByQuote", "standardFeeOf", "standardFeeOfAmounts", "validatePmDiscount", "withoutPmRows", "yenText",
  ].sort());
  assert.ok(!/^import /m.test(read("admin/js/pm-discount.js")));
  assert.equal(PM.PM_DISCOUNT_NAME, "接続サポート等経費（伴走支援費）の値引き");
  assert.equal(PM.PM_DISCOUNT_SKU, "discount");
  assert.equal(PM.FLOOR, 15000);
});

// ===== ① 判定 =====
const reader = (qty) => ({ sku: Pricing.SKU.BT, qty, unitPrice: Pricing.BT_PRICE });
const fee = (v) => ({ sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: v, nonStock: true });
const adj = (v) => ({ sku: "discount", name: "金額調整", qty: 1, unitPrice: -v, nonStock: true });

t("行の見分け: 自動の金額調整（pm なし）とは別", () => {
  const row = PM.pmDiscountRow(5500);
  assert.deepEqual(row, { sku: "discount", pm: true, name: PM.PM_DISCOUNT_NAME, qty: 1, unitPrice: -5500, nonStock: true });
  assert.equal(PM.isPmRow(row), true);
  assert.equal(PM.isPmRow(adj(100)), false);
  assert.equal(PM.isPmRow({ sku: "discount", pm: "true" }), false);
  assert.equal(PM.isPmRow(null), false);
  const items = [reader(3), fee(50000), adj(29500), row];
  assert.equal(PM.pmRows(items).length, 1);
  assert.equal(PM.withoutPmRows(items).length, 3);
  assert.equal(PM.pmAmountOfItems(items), 5500);
  assert.equal(PM.pmAmountOfItems(undefined), 0);
});
t("標準額: 出荷の明細（B の合計・値引きの行は数えない）と見積もりの金額で同じ", () => {
  for (const [plan, b, u, bx, ux] of [["houmon", 3, 0, 0, 0], ["houmon", 1, 0, 0, 0], ["houmon", 0, 2, 1, 0], ["kyojyu", 2, 0, 0, 3], ["other", 0, 1, 0, 0]]) {
    const a = baseAmountsOf(plan, b, u, bx, ux);
    const c = Pricing.computeAmounts(plan, b, u, bx, ux);
    const items = [reader(b + bx), fee(c.accFeeIncl), ...(c.discount ? [adj(c.discount)] : [])];
    assert.equal(PM.standardFeeOf(items), PM.standardFeeOfAmounts(a), `${plan} ${b}/${u}`);
    assert.equal(PM.standardFeeOf([...items, PM.pmDiscountRow(1000)]), PM.standardFeeOfAmounts(a));
    // 標準額＝上限 − 機器代（補助対象の分）
    assert.equal(PM.standardFeeOfAmounts(a), Math.min(c.plan.limit, c.subsidyPartSubtotal) - c.devSubsidyIncl);
  }
  assert.equal(PM.standardFeeOfAmounts(baseAmountsOf("houmon", 3, 0)), 20500); // 福音会様の例（BT3台）
  // 任意の金額の伴走支援費も B
  assert.equal(PM.standardFeeOf([{ sku: "support-fee", manual: true, qty: 1, unitPrice: 30200, nonStock: true }]), 30200);
});
t("検査: 1円以上の整数・値引き後0円以上・理由必須500字以内", () => {
  const ok = PM.validatePmDiscount({ amount: 5500, reason: "まとめて導入", standardFee: 20500 });
  assert.equal(ok.ok, true); assert.equal(ok.amount, 5500); assert.equal(ok.feeAfter, 15000); assert.equal(ok.belowFloor, false);
  assert.equal(PM.validatePmDiscount({ amount: "5500", reason: "x", standardFee: 20500 }).ok, true);
  for (const bad of [0, -1, 1.5, "abc", "", null, undefined, NaN]) {
    assert.equal(PM.validatePmDiscount({ amount: bad, reason: "x", standardFee: 20500 }).ok, false, `額 ${bad}`);
  }
  const over = PM.validatePmDiscount({ amount: 20501, reason: "x", standardFee: 20500 });
  assert.equal(over.ok, false); assert.match(over.errors[0], /標準額（¥20,500）を超えて/);
  const zero = PM.validatePmDiscount({ amount: 20500, reason: "x", standardFee: 20500 }); // 0円までは可（警告）
  assert.equal(zero.ok, true); assert.equal(zero.feeAfter, 0); assert.equal(zero.belowFloor, true);
  assert.equal(PM.validatePmDiscount({ amount: 100, reason: "  ", standardFee: 20500 }).ok, false);
  assert.equal(PM.validatePmDiscount({ amount: 100, reason: "あ".repeat(500), standardFee: 20500 }).ok, true);
  assert.equal(PM.validatePmDiscount({ amount: 100, reason: "あ".repeat(501), standardFee: 20500 }).ok, false);
  assert.equal(PM.validatePmDiscount({ amount: 100, reason: "x", standardFee: 0 }).ok, false); // 伴走支援費が無い
  // 外すときは額を見ない（理由は要る）
  assert.equal(PM.validatePmDiscount({ remove: true, reason: "やめた", standardFee: 20500 }).ok, true);
  assert.equal(PM.validatePmDiscount({ remove: true, reason: "", standardFee: 20500 }).ok, false);
  assert.equal(PM.validatePmDiscount({ remove: true, reason: "x", standardFee: 20500 }).belowFloor, false);
});
t("下限: ¥15,000 を下回れば belowFloor（ちょうどは下回らない）", () => {
  assert.deepEqual(PM.floorCheck(15000), { belowFloor: false, floor: 15000 });
  assert.equal(PM.floorCheck(14999).belowFloor, true);
  assert.equal(PM.floorCheck(0).belowFloor, true);
  assert.equal(PM.validatePmDiscount({ amount: 5501, reason: "x", standardFee: 20500 }).belowFloor, true);
});
t("金額: 合計・補助対象パート・助成金充当が値引き後。自己負担は変わらない。0 なら元に戻る", () => {
  for (const [plan, b, u, bx, ux] of [["houmon", 3, 0, 0, 0], ["houmon", 1, 0, 2, 0], ["kyojyu", 1, 1, 0, 1], ["other", 1, 0, 0, 0]]) {
    const a = baseAmountsOf(plan, b, u, bx, ux);
    const std = PM.standardFeeOfAmounts(a);
    for (const pm of [1, 5500, std]) {
      if (pm > std) continue;
      const x = PM.applyToAmounts(a, pm);
      assert.equal(x.pmDiscount, pm);
      assert.equal(x.totalIncl, a.totalIncl - pm);
      assert.equal(x.subsidyPartTotal, a.subsidyPartTotal - pm);
      assert.equal(x.grantAmt, a.grantAmt - pm);
      assert.equal(x.selfPay, a.selfPay);
      assert.equal(x.accompanyFee, a.accompanyFee); // 標準額は変えない
      assert.equal(x.discount, a.discount);
      assert.deepEqual(PM.applyToAmounts(a, 0), a);   // 0 は値引き前の形のまま（呼び出し側は値引き前の金額＝computeAmounts から当てる）
    }
  }
  assert.ok(!("pmDiscount" in PM.applyToAmounts(baseAmountsOf("houmon", 1, 0), 0)));
});
t("記録: 誰が・理由・標準額・値引き後・下限", () => {
  const r = PM.buildPmRecord({ amount: 6000, reason: " まとめ ", standardFee: 20500, byEmail: "a@tadakayo.jp", byName: "管理 太郎" });
  assert.deepEqual(r, { amount: 6000, reason: "まとめ", standardFee: 20500, feeAfter: 14500, belowFloor: true, byEmail: "a@tadakayo.jp", byName: "管理 太郎" });
  assert.equal(PM.buildPmRecord({ amount: 1, reason: "x", standardFee: 20500, byEmail: "a@tadakayo.jp" }).byName, "a@tadakayo.jp");
});
t("保存前の照合: 1行まで・記録と額が合う・行が消えていない・マイナスにならない", () => {
  const items = [reader(3), fee(50000), adj(29500)];
  assert.equal(PM.checkPmRows(items, null).ok, true);                                   // 値引きなし
  assert.equal(PM.checkPmRows([...items, PM.pmDiscountRow(5500)], { amount: 5500 }).ok, true);
  const two = PM.checkPmRows([...items, PM.pmDiscountRow(5500), PM.pmDiscountRow(5500)], { amount: 5500 });
  assert.equal(two.ok, false); assert.match(two.errors.join(), /1つまで/);               // 二重に引かない
  assert.match(PM.checkPmRows([...items, PM.pmDiscountRow(5500)], { amount: 3000 }).errors.join(), /合いません/);
  assert.match(PM.checkPmRows([...items, PM.pmDiscountRow(5500)], null).errors.join(), /記録/);
  assert.match(PM.checkPmRows(items, { amount: 5500 }).errors.join(), /行が消えています/); // 「送付先・数量を直す」で消えた
  assert.match(PM.checkPmRows([reader(3), PM.pmDiscountRow(5500)], { amount: 5500 }).errors.join(), /マイナス/); // 伴走支援費を外した
  assert.equal(PM.checkPmRows([...items, { ...PM.pmDiscountRow(5500), nonStock: false }], { amount: 5500 }).ok, false);
  assert.equal(PM.checkPmRows([...items, adj(100)], null).ok, true);                     // 自動の金額調整は対象外
});
t("対象の出荷: 事業所向け（税込）だけ", () => {
  assert.equal(PM.pmApplicableShipment({ shipType: "direct" }), true);
  assert.equal(PM.pmApplicableShipment({}), true);
  assert.equal(PM.pmApplicableShipment({ shipType: "dropship" }), false);
  assert.equal(PM.pmApplicableShipment({ shipType: "stock", partnerEmail: "p@example.jp" }), false);
  assert.equal(PM.pmApplicableShipment(null), false);
});
t("活動の文言: 入れた・変えた・外した・下限を下回る⚠・台数を変えて外れた", () => {
  const rec = PM.buildPmRecord({ amount: 5500, reason: "まとめて導入", standardFee: 20500, byEmail: "a@tadakayo.jp", byName: "管理 太郎" });
  const a = PM.pmActivityText({ target: "見積もり EST-1 v2", rec });
  assert.equal(a.subject, "伴走支援費を値引き（¥5,500・標準 ¥20,500 → ¥15,000）（見積もり EST-1 v2）");
  assert.match(a.body, /理由: まとめて導入/); assert.match(a.body, /判断: 管理 太郎（a@tadakayo\.jp）/); assert.match(a.body, /下限 ¥15,000 以上/);
  const low = PM.buildPmRecord({ amount: 8000, reason: "x", standardFee: 20500, byEmail: "a@tadakayo.jp", byName: "管理 太郎" });
  const c = PM.pmActivityText({ target: "出荷 SH-1", prevAmount: 5500, rec: low });
  assert.equal(c.subject, "⚠ 伴走支援費の値引きを変更（¥5,500 → ¥8,000・標準 ¥20,500 → ¥12,500）（出荷 SH-1）");
  assert.match(c.body, /⚠ 値引き後の伴走支援費 ¥12,500 は、報酬の下限 ¥15,000 を下回ります/);
  const r = PM.pmActivityText({ target: "出荷 SH-1", prevAmount: 5500, rec: null, reason: "PM判断の取り消し", byName: "管理 太郎" });
  assert.equal(r.subject, "伴走支援費の値引きを外した（¥5,500）（出荷 SH-1）");
  assert.equal(r.body, "理由: PM判断の取り消し\n判断: 管理 太郎");
  assert.match(PM.pmRemovedByReviseText(5500), /伴走支援費の値引き（¥5,500）は外れました/);
});

t("型の検査（レビュー低-1）: 額は number か数字だけの文字列・理由は文字列だけ", () => {
  for (const ok of [5500, "5500", " 5500 "]) assert.equal(PM.validatePmDiscount({ amount: ok, reason: "x", standardFee: 20500 }).ok, true, JSON.stringify(ok));
  for (const bad of [true, false, "1e3", "0x10", [5500], { v: 1 }, "5,500", "5500円", "-5", 5500.5, Infinity]) {
    assert.equal(PM.validatePmDiscount({ amount: bad, reason: "x", standardFee: 20500 }).ok, false, JSON.stringify(bad));
  }
  for (const bad of [5, ["理由"], { r: "理由" }, true, null]) assert.equal(PM.validatePmDiscount({ amount: 100, reason: bad, standardFee: 20500 }).ok, false);
});
t("見積もりのある下書き・依頼済の出荷は出荷に入れない（レビュー中-1）", () => {
  assert.equal(PM.shipmentPmBlockedByQuote({ quoteId: "q", status: "draft" }), true);
  assert.equal(PM.shipmentPmBlockedByQuote({ quoteId: "q", status: "requested" }), true);
  assert.equal(PM.shipmentPmBlockedByQuote({ quoteId: "q", status: "shipped" }), false);
  assert.equal(PM.shipmentPmBlockedByQuote({ quoteId: "q" }), false);           // 状態なし＝発送済
  assert.equal(PM.shipmentPmBlockedByQuote({ status: "draft" }), false);        // 見積もりの無い手作りの出荷
  assert.match(PM.MSG_USE_QUOTE, /見積もりカードの「値引きを入れる」/);
});
t("標準額が変わったときの記録の出し直し（レビュー低-2）", () => {
  const items = [reader(3), fee(50000), adj(29500), PM.pmDiscountRow(5500)];
  const meta = PM.buildPmRecord({ amount: 5500, reason: "x", standardFee: 20500, byEmail: "a@tadakayo.jp" });
  assert.equal(PM.recalcPmRecord(meta, items).changed, false);
  assert.equal(PM.recalcPmRecord(meta, [reader(3), fee(50000), adj(29500)]), null);           // 値引きの行が無い
  // 標準額が 20,500 → 15,500 に下がった（金額調整が増えた）: 値引き後 10,000＝下限を下回る
  const r = PM.recalcPmRecord(meta, [reader(3), fee(50000), adj(34500), PM.pmDiscountRow(5500)]);
  assert.equal(r.changed, true); assert.equal(r.feeAfter, 10000); assert.equal(r.belowFloor, true); assert.equal(r.negative, false);
  assert.equal(r.record.standardFee, 15500); assert.equal(r.record.reason, "x"); assert.equal(r.record.byEmail, "a@tadakayo.jp");
  // マイナスになる
  assert.equal(PM.recalcPmRecord(meta, [reader(3), fee(3000), PM.pmDiscountRow(5500)]).negative, true);
});

// ===== ③ 結線 =====
t("見積もりカード: 管理者だけ・setQuoteDiscount・下限の確認・改版で外れる案内", () => {
  const qa = read("admin/js/quote-admin.js");
  assert.match(qa, /from "\/js\/pm-discount\.js"/);
  assert.match(qa, /function pmDiscountBtn\(q, isLatest\) \{\n\s+if \(!isLatest \|\| !isAdminNow\(\)\) return "";/);
  assert.match(qa, /httpsCallable\(ctx\.functions, "setQuoteDiscount"\)/);
  assert.match(qa, /document\.getElementById\("pmSubmit"\)\.disabled = !v\.ok \|\| ackNeeded;/); // 承知のチェックが入るまで送れない
  assert.match(qa, /値引きは外れます/);
  assert.match(read("admin/js/case-detail.js"), /isAdmin: \(\) => isAdmin,/);
});
t("出荷の画面: 値引きの行を引き継ぐ・保存前に照合・管理者だけ setShipmentDiscount", () => {
  const js = read("admin/js/supply.js"), html = read("admin/supply.html");
  assert.match(js, /\.concat\(subsidyExtraItems\(\), manualSupportItems\(\)\)\.concat\(pmDiscountItems\(\)\);/);
  assert.equal((js.match(/const pe=pmSaveError\(items\); if\(pe\)\{ alert\(pe\); return; \}/g) || []).length, 2, "新規・修正の両方の保存で照合していない");
  assert.match(js, /checkPmRows\(items, editingShip \? \(editingShip\.pmDiscount\|\|null\) : null\)/);
  assert.match(js, /httpsCallable\(functions, "setShipmentDiscount"\)/);
  assert.match(js, /document\.getElementById\("shipPmSave"\)\.disabled = !v\.ok \|\| ackNeeded;/);
  // 見積もりのある下書き・依頼済は値引きの欄を出さず案内（中-1）／標準額が変わったら記録を出し直す（低-2）
  assert.match(js, /const can = isAdminUser && !shipIsLocked\(s\) && std>0 && !byQuote;/);
  assert.match(js, /: byQuote \? PM_MSG_USE_QUOTE/);
  assert.match(js, /const pr = recalcPmRecord\(s0\.pmDiscount\|\|null, items\);/);
  assert.match(js, /if\(pr\.negative\)\{ alert\(/);
  assert.match(js, /if\(pr\.belowFloor && !confirm\(/);
  assert.match(js, /patch\.pmDiscount = \{ \.\.\.pr\.record, recalculatedBy:/);
  for (const id of ["shipPmBox", "shipPmLine", "shipPmForm", "shipPmAmount", "shipPmReason", "shipPmAck", "shipPmAckWrap", "shipPmSave", "shipPmRemove", "shipPmPreview", "shipPmNote", "shipPmAckText"]) {
    assert.ok(html.includes(`id="${id}"`), `supply.html に ${id} が無い`);
  }
});
t("見積書: 保存値との照合は値引きを足し戻す・明細と合計欄に1行／合計見積書も足す", () => {
  const qd = read("admin/js/quote-doc.js");
  assert.match(qd, /if \(c\.totalIncl - pm !== Number\(a\.totalIncl\) \|\| c\.selfPay !== Number\(a\.selfPay\) \|\| c\.discount !== Number\(a\.discount \|\| 0\)\) return null;/);
  assert.match(qd, /if \(pm > 0\) r\.push\(row\(`<strong>\$\{esc\(PM_DISCOUNT_NAME\)\}<\/strong>`/);
  assert.match(qd, /\$\{pmRow\}/);
  const gd = read("admin/js/quote-group-doc.js");
  assert.match(gd, /"discount", "pmDiscount", "extraPartTotal"/);
  assert.match(gd, /\$\{pmRow\}/);
});
t("練習モードの代役: 新しい Callable 2本・管理者だけ・本番と同じ判定", () => {
  const ps = read("admin/js/practice-stubs.js");
  assert.match(ps, /^\s{2}async setQuoteDiscount\(d\) \{\n\s+const u = await practiceAdmin\(\);/m);
  assert.match(ps, /^\s{2}async setShipmentDiscount\(d\) \{\n\s+const u = await practiceAdmin\(\);/m);
  assert.match(ps, /import \* as PM from "\/js\/pm-discount\.js";/);
  assert.match(ps, /if \(pmDiscount > 0\) items\.push\(PM\.pmDiscountRow\(pmDiscount\)\);/);
  assert.match(ps, /user\.role !== "admin"/);
  // 本番と同じ直し（中-1・中-3・低-3・低-4・低-5）
  assert.match(ps, /if \(PM\.shipmentPmBlockedByQuote\(s\)\) throw fail\(PM\.MSG_USE_QUOTE\);/);
  assert.match(ps, /const rs = reviseConsentStale\(kase, true\);/);
  assert.match(ps, /const pmDiscount = Number\(q\.amounts\?\.pmDiscount\) > 0 && q\.pmDiscount && Number\(q\.pmDiscount\.amount\) === Number\(q\.amounts\.pmDiscount\)/);
  assert.match(ps, /const prevForText = shipmentId && shipStatus === "draft" && shipPm > 0 \? shipPm : prevPm;/);
  assert.match(ps, /const prevPm = Math\.max\(Number\(base\.amounts\?\.pmDiscount\) \|\| 0, shipmentId && shipStatus === "draft" \? shipPm : 0\);/);
});
t("estimate-pricing.js（3か所）と公開ページは変えていない（値引きは別の項目）", () => {
  for (const p of ["functions/estimate-pricing.js", "js/estimate-pricing.js", "admin/js/estimate-pricing.js"]) assert.ok(!/pmDiscount|pm-discount/.test(read(p)), p);
  for (const p of ["mitsumori.html", "js/order-consent-page.js"]) assert.ok(!/pmDiscount|pm-discount/.test(read(p)), p);
});

console.log(`OK test-pm-discount: ${n} 件合格`);
