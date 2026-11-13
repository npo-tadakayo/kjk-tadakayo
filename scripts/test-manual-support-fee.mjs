// 伴走支援費の任意行（admin/js/manual-support-fee.js）のテスト。node scripts/test-manual-support-fee.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SUPPORT_FEE_SKU, DEFAULT_MANUAL_NAME, MSG, parseYen, yenText, supportFeeRows, hasAutoSupportFee, hasManualSupportFee,
  readerCostOf, exclusion, manualLimit, limitText, validateManual, buildManualItem, manualFormFromItems,
  checkSupportFeeRows, manualActivityText, belowStandardCheck,
} from "../admin/js/manual-support-fee.js";
import Pricing from "../admin/js/estimate-pricing.js";

let n = 0;
const t = (fn) => { fn(); n++; };
const READERS = [Pricing.SKU.BT, Pricing.SKU.USB_A, Pricing.SKU.USB_C];
const auto = { sku: "support-fee", name: "伴走支援費（補助対象1台）", qty: 1, unitPrice: 60000, nonStock: true };
const manual = (o = {}) => ({ sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 30200, nonStock: true, manual: true, manualBy: "a@tadakayo.jp", manualAt: "2026-11-09T00:00:00.000Z", ...o });

// ===== 数値の読み取り =====
t(() => {
  assert.equal(parseYen(30200), 30200);
  assert.equal(parseYen("30,200"), 30200);
  assert.equal(parseYen("¥30200"), 30200);
  assert.equal(parseYen("３０２００"), 30200);
  assert.equal(parseYen(0), 0);
  for (const bad of ["", " ", null, undefined, "abc", "-1", "1.5", 1.5, -3, "30 200x"]) assert.ok(Number.isNaN(parseYen(bad)), `NaN になるはず: ${bad}`);
  assert.equal(yenText(30200), "¥30,200");
});

// ===== 明細の見分け・カードリーダー購入費 =====
t(() => {
  assert.equal(SUPPORT_FEE_SKU, "support-fee");
  assert.equal(supportFeeRows([auto, { sku: "x" }, null]).length, 1);
  assert.equal(hasAutoSupportFee([auto]), true);
  assert.equal(hasAutoSupportFee([manual()]), false);
  assert.equal(hasManualSupportFee([manual()]), true);
  assert.equal(hasManualSupportFee([auto]), false);
  assert.equal(hasAutoSupportFee(undefined), false);
  const items = [
    { sku: Pricing.SKU.BT, qty: 1, unitPrice: 14500 }, { sku: Pricing.SKU.USB_A, qty: 2, unitPrice: 6500 },
    { sku: "other", qty: 5, unitPrice: 100 }, auto, { sku: Pricing.SKU.USB_C, qty: 0, unitPrice: 6500 },
  ];
  assert.equal(readerCostOf(items, READERS), 14500 + 13000);
  assert.equal(readerCostOf([], READERS), 0);
  assert.equal(readerCostOf([{ sku: Pricing.SKU.BT, qty: 1, unitPrice: 14500, nonStock: true }], READERS), 0);
});

// ===== 排他 =====
t(() => {
  let e = exclusion({ autoOn: false, manualOn: false, locked: false });
  assert.deepEqual([e.manualDisabled, e.autoDisabled, e.manualReason, e.autoReason], [false, false, "", ""]);
  e = exclusion({ autoOn: true, manualOn: false });
  assert.equal(e.manualDisabled, true); assert.equal(e.manualReason, MSG.autoPresent); assert.equal(e.autoDisabled, false);
  e = exclusion({ autoOn: false, manualOn: true });
  assert.equal(e.autoDisabled, true); assert.equal(e.autoReason, MSG.manualPresent); assert.equal(e.manualDisabled, false);
  e = exclusion({ autoOn: false, manualOn: false, locked: true }); // 請求書を出した後はどちらも触れない
  assert.equal(e.manualDisabled, true); assert.equal(e.autoDisabled, true);
  assert.equal(exclusion().manualDisabled, false);
  assert.match(MSG.autoPresent, /自動の伴走支援費が入っている/);
});

// ===== 上限（設計 §3.4b。助成区分の上限は estimate-pricing.js の PLANS が正本） =====
t(() => {
  const L = (o) => manualLimit(o);
  // ナガヨシ様: その他 42,000 − 先方購入 11,800 = 30,200
  assert.equal(L({ planLimit: Pricing.PLANS.other.limit, priorBuyerReaderCost: 11800 }).limit, 30200);
  // 欄が空なら助成区分の絶対上限
  assert.equal(L({ planLimit: 64000 }).limit, 64000);
  assert.equal(L({ planLimit: 64000, priorBuyerReaderCost: "" }).limit, 64000);
  // 同じ出荷のカードリーダー購入費 A も引く
  assert.equal(L({ planLimit: 64000, priorBuyerReaderCost: 5000, readerCost: 14500 }).limit, 64000 - 5000 - 14500);
  // 引き過ぎても負にしない
  assert.equal(L({ planLimit: 42000, priorBuyerReaderCost: 50000 }).limit, 0);
  // 区分未選択は上限を確認できない
  for (const pl of [null, undefined, 0, NaN, ""]) { const r = L({ planLimit: pl }); assert.equal(r.known, false); assert.equal(r.limit, null); }
  assert.equal(limitText(L({ planLimit: 42000, priorBuyerReaderCost: 11800 })), "入力できる上限：¥30,200");
  assert.match(limitText(L({})), /未確定/);
  assert.equal(Pricing.PLANS.houmon.limit, 64000); assert.equal(Pricing.PLANS.kyojyu.limit, 55000); assert.equal(Pricing.PLANS.other.limit, 42000);
});

// ===== 入力の検査 =====
t(() => {
  const base = { amount: 30200, name: "伴走支援費", priorBuyerReaderCost: 11800, planLimit: 42000, readerCost: 0 };
  let v = validateManual(base);
  assert.equal(v.ok, true); assert.deepEqual(v.errors, []); assert.deepEqual(v.warnings, []);
  assert.equal(v.amount, 30200); assert.equal(v.limit.limit, 30200);
  // 上限ちょうどは通る・1円超えは通らない（警告でなく保存不可）
  assert.equal(validateManual({ ...base, amount: 30201 }).ok, false);
  assert.match(validateManual({ ...base, amount: 30201 }).errors.join(""), /上限を超えています.*¥30,200/);
  // 上限0（購入費で枠を使い切り）
  v = validateManual({ ...base, priorBuyerReaderCost: 42000, amount: 1 });
  assert.equal(v.ok, false); assert.match(v.errors.join(""), /上限が0円/);
  // 金額・品名の不正
  for (const amount of ["", 0, -5, 12.5, "abc", null]) assert.equal(validateManual({ ...base, amount }).ok, false, `amount=${amount}`);
  assert.equal(validateManual({ ...base, name: "  " }).ok, false);
  assert.equal(validateManual({ ...base, name: "あ".repeat(61) }).ok, false);
  assert.equal(validateManual({ ...base, name: "あ".repeat(60) }).ok, true);
  // 先方購入費の不正
  assert.equal(validateManual({ ...base, priorBuyerReaderCost: "x" }).ok, false);
  assert.equal(validateManual({ ...base, priorBuyerReaderCost: -1 }).ok, false);
  assert.equal(validateManual({ ...base, priorBuyerReaderCost: "" }).ok, true);
  // 区分が未選択＝上限が決まらない: 保存できない（区分を空にして上限を逃れられないように）
  v = validateManual({ ...base, planLimit: null, amount: 1000000 });
  assert.equal(v.ok, false); assert.ok(v.errors.includes(MSG.limitUnknown));
  // 同じ出荷のカードリーダー購入費 A を含めて上限を計算する
  v = validateManual({ amount: 49500, name: "伴走支援費", planLimit: 64000, readerCost: 14500 });
  assert.equal(v.ok, true); assert.equal(v.limit.limit, 49500);
  assert.equal(validateManual({ amount: 49501, name: "伴走支援費", planLimit: 64000, readerCost: 14500 }).ok, false);
});

// ===== 明細の組み立て =====
t(() => {
  const it = buildManualItem({ amount: "30,200", name: " 伴走支援費 ", priorBuyerReaderCost: 11800, memo: "先方のリーダー購入費を差し引いた額", by: "a@tadakayo.jp", at: "2026-11-09T01:00:00.000Z" });
  assert.deepEqual(it, { sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 30200, nonStock: true, manual: true,
    manualBy: "a@tadakayo.jp", manualAt: "2026-11-09T01:00:00.000Z", priorBuyerReaderCost: 11800, manualMemo: "先方のリーダー購入費を差し引いた額" });
  const min = buildManualItem({ amount: 100, name: "伴走支援費", by: "a@x", at: "t" });
  assert.equal("priorBuyerReaderCost" in min, false); assert.equal("manualMemo" in min, false);
  assert.equal(buildManualItem({ amount: 0, name: "x" }), null);
  assert.equal(buildManualItem({ amount: 100, name: "" }), null);
  assert.equal(buildManualItem({ amount: "abc", name: "x" }), null);
  // 先方購入費 0 も記録する（入れていない＝キー無し と区別）
  assert.equal(buildManualItem({ amount: 100, name: "x", priorBuyerReaderCost: 0 }).priorBuyerReaderCost, 0);
  // 修正で開いたときに入力欄へ戻す
  const f = manualFormFromItems([{ sku: "a", qty: 1 }, it]);
  assert.deepEqual([f.amount, f.name, f.priorBuyerReaderCost, f.memo, f.manualBy], [30200, "伴走支援費", 11800, "先方のリーダー購入費を差し引いた額", "a@tadakayo.jp"]);
  assert.equal(manualFormFromItems([auto]), null);
  assert.equal(DEFAULT_MANUAL_NAME, "伴走支援費");
});

// ===== 保存時の検査（画面の検査だけに頼らない） =====
t(() => {
  const ok = (items, o) => checkSupportFeeRows(items, { planLimit: 42000, readerSkus: READERS, ...o });
  assert.equal(ok([manual()]).ok, true);
  assert.equal(ok([auto]).ok, true);                       // 自動だけ（Web申込の出荷）は従来どおり
  assert.equal(ok([]).ok, true);
  assert.equal(ok([auto, manual()]).ok, false);            // 自動＋任意＝二重計上
  assert.equal(ok([manual(), manual()]).ok, false);        // 任意が2行
  assert.equal(ok([auto, auto]).ok, false);                // 自動が2行も保存しない
  assert.match(ok([auto, manual()]).errors.join(""), /1出荷に1行/);
  // 任意行の形
  assert.equal(ok([manual({ unitPrice: 0 })]).ok, false);
  assert.equal(ok([manual({ unitPrice: 1.5 })]).ok, false);
  assert.equal(ok([manual({ qty: 2 })]).ok, false);
  assert.equal(ok([manual({ nonStock: false })]).ok, false);
  assert.equal(ok([manual({ name: " " })]).ok, false);
  // 上限（先方購入費つき）
  assert.equal(ok([manual({ unitPrice: 30200, priorBuyerReaderCost: 11800 })]).ok, true);
  assert.equal(ok([manual({ unitPrice: 30201, priorBuyerReaderCost: 11800 })]).ok, false);
  // 同じ出荷のカードリーダー購入費 A
  const rd = { sku: Pricing.SKU.BT, qty: 1, unitPrice: 14500 };
  assert.equal(ok([rd, manual({ unitPrice: 27500 })]).ok, true);
  assert.equal(ok([rd, manual({ unitPrice: 27501 })]).ok, false);
  // 区分未選択（planLimit なし）の任意行は保存しない。任意行が無ければ従来どおり
  assert.equal(ok([manual({ unitPrice: 999999 })], { planLimit: null }).ok, false);
  assert.equal(ok([auto], { planLimit: null }).ok, true);
});

// ===== 活動の文言 =====
t(() => {
  const it = buildManualItem({ amount: 30200, name: "伴走支援費", priorBuyerReaderCost: 11800, memo: "差し引いた額", by: "a", at: "t" });
  const a = manualActivityText(it);
  assert.equal(a.subject, "伴走支援費を任意の金額で設定（¥30,200）");
  assert.match(a.body, /先方が購入したカードリーダー費用: ¥11,800/); assert.match(a.body, /メモ: 差し引いた額/);
  assert.equal(manualActivityText(it, { removed: true }).subject, "任意の伴走支援費を外した");
});

// ===== 標準額（入力できる上限）より下げるのは管理者だけ・理由（メモ）必須（2026-11-13） =====
t(() => {
  const base = { planLimit: 64000, priorBuyerReaderCost: 11800, readerCost: 0 };   // 標準額 52,200
  assert.equal(belowStandardCheck({ ...base, amount: 52200, isAdmin: false }).ok, true);           // 標準額ちょうどは誰でも
  assert.equal(belowStandardCheck({ ...base, amount: 52200, isAdmin: false }).below, false);
  const ed = belowStandardCheck({ ...base, amount: 40000, isAdmin: false, memo: "理由" });
  assert.equal(ed.ok, false); assert.match(ed.errors[0], /管理者だけ/); assert.equal(ed.standard, 52200);
  const adNo = belowStandardCheck({ ...base, amount: 40000, isAdmin: true, memo: " " });
  assert.equal(adNo.ok, false); assert.match(adNo.errors[0], /メモに理由/);
  assert.equal(belowStandardCheck({ ...base, amount: 40000, isAdmin: true, memo: "PM判断 11/19" }).ok, true);
  // 前から入っている額のまま（住所だけ直すなど）は問わない
  assert.equal(belowStandardCheck({ ...base, amount: 40000, isAdmin: false, unchanged: true }).ok, true);
  // 区分未選択（上限が決まらない）・金額が読めないときは、この判定では止めない（validateManual が止める）
  assert.equal(belowStandardCheck({ amount: 1, planLimit: null, isAdmin: false }).ok, true);
  assert.equal(belowStandardCheck({ ...base, amount: "abc", isAdmin: false }).ok, true);
  // 画面がこの判定を使っている
  const js = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  assert.match(js, /const b = belowStandardCheck\(\{ \.\.\.f, isAdmin: isAdminUser, memo: document\.getElementById\("shipManualMemo"\)\.value, unchanged \}\);/);
  assert.match(js, /isAdminUser = myRole\.role==="admin";/);
});

// ===== 結線: 画面（supply.js・supply.html）とつながっていること =====
const read = (f) => readFileSync(new URL(`../admin/${f}`, import.meta.url), "utf8");
t(() => {
  const js = read("js/supply.js"), html = read("supply.html");
  for (const id of ["shipManualOn", "shipManualBody", "shipManualPlan", "shipManualAmount", "shipManualName", "shipManualPrior", "shipManualMemo", "shipManualLimit", "shipManualError"]) {
    assert.ok(html.includes(`id="${id}"`), `supply.html に ${id} が無い`);
  }
  assert.match(js, /from "\/js\/manual-support-fee\.js"/);
  // 明細の組み立て・金額ロック・保存時の検査・修正で開いたときの復元・活動の記録
  assert.match(js, /\.concat\(subsidyExtraItems\(\), manualSupportItems\(\)\)/);
  for (const id of ["shipManualOn", "shipManualAmount", "shipManualPrior"]) assert.ok(js.includes(`"${id}"`), `supply.js に ${id} が無い`);
  assert.match(js, /checkSupportFeeRows\(items,/);
  assert.equal((js.match(/manualSaveError\(items\)/g) || []).length >= 2, true, "新規・修正の両方の保存で検査していない");
  // 物の出荷が無い出荷（伴走支援費だけ）は出荷指示を投稿しない: 新規は発送済で登録・依頼と再送は止める
  assert.match(js, /const noGoods = shipQtySummary\(items\)\.total===0;/);
  assert.match(js, /alreadyShipped = noGoods \|\|/);
  assert.equal((js.match(/shipQtySummary\(s\.items\)\.total===0/g) || []).length >= 2, true, "依頼・再送の止めが無い");
  assert.match(js, /restoreManualFromShip\(/);
  assert.match(js, /manualActivityText\(/);
});

console.log(`OK ${n} グループ`);
