// 供給管理の画面の判定（admin/js/supply-rules.js）と、部品（ship-dup.js・bank-match.js）とのつなぎのテスト。
// node scripts/test-supply-wiring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findDuplicateDrafts, stockAdvice } from "../admin/js/ship-dup.js";
import { decodeBankFile, parseCsv, mapRows, hashRows, buildCandidates, autoSelect } from "../admin/js/bank-match.js";
import {
  dupView, filterDupOnly, othersToCancel, stockAdviceShown, guessMapping, toMapRowsMapping,
  initialSelection, groupByShipment, bankPaymentOf, bankTxnDocOf, remainOf, applyBankPayments,
  payConfirmText, aliasLearnings, invoicePatchOf, paymentRemovalOf,
} from "../admin/js/supply-rules.js";

let n = 0;
const t = async (name, fn) => {
  try { await fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; }
};
const fixture = (f) => readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)));

// ===== 下書きの重複 =====
const S = (id, caseId, status, soNumber, o = {}) => ({ _id: id, caseId, status, soNumber, ...o });
const ships = [
  S("a1", "C1", "draft", "SH-2026-0256"), S("a2", "C1", "draft", "SH-2026-0255"), S("a3", "C1", "requested", "SH-2026-0257"),
  S("b1", "C2", "draft", "SH-2026-0300"), S("b2", "C2", "shipped", "SH-2026-0301"),
  S("x1", "C9", "draft", "SH-2026-0900"),
];

await t("重複の行の印・件数・残す候補", () => {
  const v = dupView(findDuplicateDrafts(ships, { C1: "a3", C2: "b1" }));
  assert.equal(v.count, 3);
  assert.deepEqual([...v.ids].sort(), ["a1", "a2", "a3"]);
  assert.equal(v.byShip.get("a1").keepId, "a3");
  assert.equal(v.byShip.get("a1").group.length, 3);
  assert.equal(v.byShip.has("b1"), false); // 発送済とは重複にしない
  // 案件が別の出荷を指していれば残す候補は無し（人が選ぶ）
  assert.equal(dupView(findDuplicateDrafts(ships, { C1: "zz" })).byShip.get("a1").keepId, null);
  // Map でも渡せる
  assert.equal(dupView(findDuplicateDrafts(ships, new Map([["C1", "a2"]]))).byShip.get("a3").keepId, "a2");
  assert.equal(dupView([]).count, 0);
});

await t("重複だけに絞る（押していなければそのまま）", () => {
  const v = dupView(findDuplicateDrafts(ships, {}));
  assert.equal(filterDupOnly(ships, v, false), ships);
  assert.deepEqual(filterDupOnly(ships, v, true).map((s) => s._id), ["a1", "a2", "a3"]);
});

await t("こちらを残す → ほかの下書き・依頼済を出荷番号の順に1件ずつ", () => {
  const v = dupView(findDuplicateDrafts(ships, { C1: "a3" }));
  assert.deepEqual(othersToCancel(v, "a3").map((s) => s._id), ["a2", "a1"]); // 0255, 0256
  assert.deepEqual(othersToCancel(v, "a2").map((s) => s._id), ["a1", "a3"]);
  assert.deepEqual(othersToCancel(v, "nope"), []);
});

await t("在庫の目安は下書き・依頼済の自社在庫の出荷だけ", () => {
  assert.equal(stockAdviceShown({ status: "draft" }), true);
  assert.equal(stockAdviceShown({ status: "requested", fulfillment: "warehouse" }), true);
  assert.equal(stockAdviceShown({ status: "draft", fulfillment: "direct" }), false); // 直送
  assert.equal(stockAdviceShown({ status: "shipped" }), false);
  assert.equal(stockAdviceShown({}), false); // 状態なし＝発送済扱い
  const products = [{ id: "bt", name: "BT", stockByLocation: { L1: 3, L2: 0 } }];
  const locations = [{ _id: "L1", name: "滋賀" }, { _id: "L2", name: "東京" }];
  assert.equal(stockAdvice([{ sku: "bt", qty: 2 }], products, locations).text, "在庫: 滋賀 3/2台 ✓・東京 0/2台");
});

// ===== 列の割り当て =====
await t("見出しから列を推し量る（UTF-8 の見本・入金と出金が別の列）", () => {
  const { text, encoding } = decodeBankFile(fixture("bank-sample-utf8.csv"));
  assert.equal(encoding, "utf-8");
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c || "").trim() !== ""));
  const g = guessMapping(rows);
  assert.deepEqual(g, { skip: 1, mode: "split", date: 0, payer: 1, deposit: 3, withdrawal: 2, balance: 4 });
  const m = toMapRowsMapping({ ...g, amount: "" });
  assert.ok(m.mapping);
  const r = mapRows(rows, m.mapping);
  assert.equal(r.rows.length, 4);           // 入金4行
  assert.equal(r.skipped.length, 1);        // 出金1行
  assert.equal(r.skipped[0].reason, "出金");
  assert.equal(r.rows[0].amount, 22000);
  assert.equal(r.rows[0].balance, 1022000);
  assert.equal(r.rows[2].code, "0013");     // 名義の先頭の振込人コード
  assert.equal(r.rows[0].code, "0012");     // 「振込 0012…」は先頭の「振込」を読み飛ばして拾う（2026-10-21）
});

await t("Shift_JIS の見本（和暦の日付）", () => {
  const { text, encoding } = decodeBankFile(fixture("bank-sample-sjis.csv"));
  assert.equal(encoding, "shift_jis");
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c || "").trim() !== ""));
  assert.equal(rows[0][0], "お取引日");
  const g = guessMapping(rows);
  assert.deepEqual(g, { skip: 1, mode: "split", date: 0, payer: 1, deposit: 2, withdrawal: 3, balance: 4 });
  const r = mapRows(rows, toMapRowsMapping(g).mapping);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].date, "2026-10-07");
  assert.equal(r.rows[0].code, "0012");
  assert.equal(r.rows[0].payerNorm, "0012テストカイゴジギヨウシヨ");
});

await t("見出しが無ければ空の割り当て・1列の形", () => {
  assert.deepEqual(guessMapping([["2026/10/01", "1000", "ﾃｽﾄ"]]), { skip: 0, mode: "split" });
  assert.deepEqual(guessMapping([["日付", "金額", "名義"]]), { skip: 1, mode: "single", date: 0, payer: 2, amount: 1 });
  assert.deepEqual(toMapRowsMapping({ skip: "1", mode: "single", date: "0", amount: "1", payer: "2", balance: "" }).mapping,
    { skip: 1, date: 0, payer: 2, amount: 1 });
  assert.equal(toMapRowsMapping({ mode: "split", date: "", payer: "1", deposit: "2" }).error, "日付の列を選んでください");
  assert.equal(toMapRowsMapping({ mode: "split", date: "0", payer: "", deposit: "2" }).error, "名義の列を選んでください");
  assert.equal(toMapRowsMapping({ mode: "split", date: "0", payer: "1", deposit: "" }).error, "入金の列を選んでください");
  assert.equal(toMapRowsMapping({ mode: "single", date: "0", payer: "1", amount: "" }).error, "入金額の列を選んでください");
});

// ===== 照合 → 選択 → 記録 =====
// 事業所向け（税込）: 11,000×2 = 22,000
const sh = (id, soNumber, o = {}) => ({ _id: id, soNumber, status: "invoiced", shipType: "direct", company: `法人${id}`,
  items: [{ sku: "bt", qty: 2, unitPrice: 11000 }], shippingFee: 0, ...o });
const openShips = [sh("s12", "SH-2026-0012"), sh("s13", "SH-2026-0013", { items: [{ sku: "bt", qty: 3, unitPrice: 10000 }] })];

await t("最初の選択は autoSelect だけ・取込済みは除く", async () => {
  const { text } = decodeBankFile(fixture("bank-sample-sjis.csv"));
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c || "").trim() !== ""));
  const hashed = await hashRows(mapRows(rows, toMapRowsMapping(guessMapping(rows)).mapping).rows);
  const matched = buildCandidates(hashed, openShips);
  const auto = autoSelect(matched);
  assert.deepEqual(auto, [{ rowIndex: 1, shipmentId: "s12" }]);
  const sel = initialSelection(auto, hashed, new Set());
  assert.deepEqual([...sel], [[1, "s12"]]);
  // 二度目の取り込み（bankTxns にある）は選ばない
  assert.equal(initialSelection(auto, hashed, new Set([hashed[0].hash])).size, 0);
});

await t("出荷ごとにまとめる（2回に分けた振込・取込済みは除く）", () => {
  const rows = [
    { index: 3, date: "2026-10-09", amount: 10000, hash: "h3" },
    { index: 1, date: "2026-10-07", amount: 12000, hash: "h1" },
    { index: 2, date: "2026-10-08", amount: 30000, hash: "h2" },
    { index: 4, date: "2026-10-10", amount: 500, hash: "h4" },
  ];
  const sel = new Map([[3, "s12"], [1, "s12"], [2, "s13"], [4, "s13"]]);
  const g = groupByShipment(sel, rows, new Set(["h4"]));
  assert.equal(g.length, 2);
  assert.equal(g[0].shipmentId, "s12");
  assert.deepEqual(g[0].rows.map((r) => r.index), [1, 3]); // 日付順
  assert.equal(g[0].amount, 22000);
  assert.equal(g[1].amount, 30000);                         // 取込済み h4 は足さない
  assert.deepEqual(groupByShipment(new Map([[9, "s12"], [1, ""]]), rows, new Set()), []);
});

await t("入金レコード・bankTxns の形（CSV の他の列は残さない）", () => {
  const row = { index: 1, date: "2026-10-07", amount: 22000, payer: "0012ﾃｽﾄ", payerNorm: "0012テスト", code: "0012", balance: 1088300, hash: "abc" };
  assert.deepEqual(bankPaymentOf(row, { recordedBy: "担当A", recordedAt: "2026-10-21T00:00:00.000Z" }), {
    amount: 22000, date: "2026-10-07", note: "銀行明細取込", recordedBy: "担当A", recordedAt: "2026-10-21T00:00:00.000Z",
    source: "bank_csv", bankTxnId: "abc",
  });
  // 別の振込として記録したとき（取込済みの可能性を人が確かめた）は、書いたIDを入金に残す（取り消しで正しい記録を消すため）
  assert.equal(bankPaymentOf(row, { recordedBy: "担当A", recordedAt: "x" }, "abc-2").bankTxnId, "abc-2");
  assert.deepEqual(bankTxnDocOf(row, sh("s12", "SH-2026-0012"), "担当A"), {
    date: "2026-10-07", amount: 22000, payerNorm: "0012テスト", shipmentId: "s12", soNumber: "SH-2026-0012", confirmedBy: "担当A",
  });
});

const pay = (amount, date = "2026-10-07") => ({ amount, date, note: "銀行明細取込", source: "bank_csv", bankTxnId: "h" });

await t("残額の再計算と状態（savePayments と同じ規則）", () => {
  // ちょうど → 入金済
  let r = applyBankPayments(sh("s12", "SH-2026-0012"), [pay(22000)]);
  assert.equal(r.remainBefore, 22000);
  assert.equal(r.remainAfter, 0);
  assert.equal(r.patch.status, "paid");
  assert.equal(r.patch.paidAt, "2026-10-07");
  assert.equal(r.patch.paymentAmount, 22000);
  assert.equal(r.patch.refundAmount, 0);
  assert.equal(r.patch.payments.length, 1);
  // 一部 → 請求済のまま・paidAt は空
  r = applyBankPayments(sh("s12", "SH-2026-0012"), [pay(10000)]);
  assert.equal(r.patch.status, "invoiced");
  assert.equal(r.patch.paidAt, "");
  assert.equal(r.remainAfter, 12000);
  // 既存の入金・返金・過入金の充当を含めて計算し直す
  const cur = sh("s12", "SH-2026-0012", { payments: [{ amount: 10000, date: "2026-10-01" }], refunds: [{ amount: 1000 }], creditApplied: 2000 });
  assert.equal(remainOf(cur), 22000 - 2000 - 9000);
  r = applyBankPayments(cur, [pay(11000, "2026-10-09")]);
  assert.equal(r.patch.status, "paid");
  assert.equal(r.patch.paymentAmount, 20000);   // 純額
  assert.equal(r.patch.refundAmount, 1000);
  assert.equal(r.patch.payments.length, 2);
  assert.equal(r.patch.paidAt, "2026-10-09");
  // 過入金
  r = applyBankPayments(sh("s12", "SH-2026-0012"), [pay(25000)]);
  assert.equal(r.patch.status, "paid");
  assert.equal(r.overpay, 3000);
  // 旧形式（paymentAmount だけ）は1件の履歴として残す
  r = applyBankPayments(sh("s12", "SH-2026-0012", { paymentAmount: 2000, paidAt: "2026-09-30" }), [pay(20000)]);
  assert.equal(r.patch.payments.length, 2);
  assert.equal(r.patch.payments[0].note, "（旧形式の記録）");
  assert.equal(r.patch.status, "paid");
  // 発送済（未請求）は状態を変えない
  r = applyBankPayments(sh("s12", "SH-2026-0012", { status: "shipped" }), [pay(22000)]);
  assert.equal(r.patch.status, "shipped");
  assert.equal(r.patch.paidAt, "2026-10-07");
  // 入金済・キャンセル済には記録しない
  assert.throws(() => applyBankPayments(sh("s12", "SH-2026-0012", { status: "paid" }), [pay(1)]));
  assert.throws(() => applyBankPayments(sh("s12", "SH-2026-0012", { status: "canceled" }), [pay(1)]));
});

await t("確認の文（過入金は既存の文・一部入金・未請求）", () => {
  const s = sh("s12", "SH-2026-0012");
  assert.equal(payConfirmText(s, 22000), "");
  assert.match(payConfirmText(s, 25000), /残額 ¥22,000 を超える入金です（¥25,000）。\n差額 ¥3,000 は過入金として記録し、同じ請求先の次回の請求から差し引けます。/);
  assert.match(payConfirmText(s, 10000), /残額 ¥22,000 に満たない入金です（¥10,000）。\n残り ¥12,000 は未集金のまま/);
  assert.match(payConfirmText({ ...s, status: "shipped" }, 22000), /まだ請求済にしていない出荷/);
});

await t("名義の学習（正規化名義 → 請求先キー）", () => {
  const m = aliasLearnings([
    { shipment: sh("s12", "SH-2026-0012"), rows: [{ payerNorm: "テストカイゴ" }, { payerNorm: "テストカイゴ" }, { payerNorm: "" }] },
    { shipment: sh("s13", "SH-2026-0013", { company: "法人s12" }), rows: [{ payerNorm: "テストカイゴ" }] },
    { shipment: { shipType: "dropship", partnerEmail: "p@example.com" }, rows: [{ payerNorm: "サンプル" }] },
    { shipment: { shipType: "direct" }, rows: [{ payerNorm: "ナシ" }] }, // 請求先キーが空
  ]);
  assert.deepEqual([...m], [["テストカイゴ", ["法人s12"]], ["サンプル", ["p@example.com"]]]);
  // 学習した名義は次の照合で候補になる
  const c = buildCandidates([{ index: 1, date: "2026-10-21", amount: 1, payer: "ﾃｽﾄｶｲｺﾞ", payerNorm: "テストカイゴ", code: "" }],
    [sh("s12", "SH-2026-0012")], { aliases: Object.fromEntries(m) });
  assert.equal(c[0].candidates[0].aliasMatch, true);
});

// ===== 請求済にする・入金の取消（2026-10-21 レビュー指摘）=====
await t("請求前に全額入金した出荷は、請求済にしたとき入金済になる", () => {
  // 発送済のまま入金明細で全額記録 → 請求済にする（t.mjs の再現と同じ流れ）
  const s = sh("s12", "SH-2026-0012", { status: "shipped" });
  const after = { ...s, ...applyBankPayments(s, [pay(22000, "2026-10-07")]).patch };
  assert.equal(after.status, "shipped");
  const r = invoicePatchOf(after, { invoicedAt: "2026-10-21", dueDate: "2026-11-04", today: "2026-10-21" });
  assert.equal(r.paid, true);
  assert.deepEqual(r.patch, { status: "paid", invoicedAt: "2026-10-21", dueDate: "2026-11-04", paidAt: "2026-10-07" });
  assert.equal(remainOf({ ...after, ...r.patch }), 0);
  // 過入金でも入金済
  assert.equal(invoicePatchOf({ ...s, payments: [pay(30000)] }, { invoicedAt: "2026-10-21", today: "2026-10-21" }).patch.status, "paid");
  // 一部入金 → 今どおり請求済（paidAt は触らない）・dueDate が空なら書かない
  const p = invoicePatchOf({ ...s, payments: [pay(10000)] }, { invoicedAt: "2026-10-21", dueDate: "", today: "2026-10-21" });
  assert.equal(p.paid, false);
  assert.equal(p.remain, 12000);
  assert.deepEqual(p.patch, { status: "invoiced", invoicedAt: "2026-10-21" });
  // 入金なし → 請求済
  assert.equal(invoicePatchOf(s, { invoicedAt: "2026-10-21", today: "2026-10-21" }).patch.status, "invoiced");
  // 返金を差し引く（入金 22,000・返金 2,000 → 残 2,000 で請求済）
  assert.equal(invoicePatchOf({ ...s, payments: [pay(22000)], refunds: [{ amount: 2000 }] },
    { invoicedAt: "2026-10-21", today: "2026-10-21" }).patch.status, "invoiced");
  // 過入金の充当で残額 0 → 入金済。入金の日付が無ければ today
  const c = invoicePatchOf({ ...s, creditApplied: 22000 }, { invoicedAt: "2026-10-21", today: "2026-10-21" });
  assert.equal(c.patch.status, "paid");
  assert.equal(c.patch.paidAt, "2026-10-21");
  assert.equal(invoicePatchOf({ ...s, payments: [{ amount: 22000, date: "" }] }, { invoicedAt: "2026-10-21", today: "2026-10-22" }).patch.paidAt, "2026-10-22");
  // 旧形式（paymentAmount だけ）も読む
  assert.equal(invoicePatchOf({ ...s, paymentAmount: 22000, paidAt: "2026-10-01" }, { invoicedAt: "2026-10-21", today: "2026-10-21" }).patch.paidAt, "2026-10-01");
});

await t("入金明細から記録した入金を取り消すと bankTxns も消す対象になる", () => {
  const bank = { amount: 22000, date: "2026-10-07", note: "銀行明細取込", source: "bank_csv", bankTxnId: "hash-a", recordedAt: "x1" };
  const hand = { amount: 5000, date: "2026-10-08", note: "", recordedAt: "x2" };
  const s = sh("s12", "SH-2026-0012", { status: "paid", payments: [bank, hand], paidAt: "2026-10-08" });
  const r = paymentRemovalOf(s, { ...bank }, "2026-10-21");
  assert.equal(r.bankTxnId, "hash-a");
  assert.deepEqual(r.patch.payments, [hand]);
  assert.equal(r.patch.status, "invoiced");
  assert.equal(r.patch.paidAt, "");
  assert.equal(r.patch.paymentAmount, 5000);
  // 手入力の入金は bankTxns を触らない。残りで全額なら入金済のまま
  const r2 = paymentRemovalOf(s, { ...hand }, "2026-10-21");
  assert.equal(r2.bankTxnId, null);
  assert.equal(r2.patch.status, "paid");
  assert.equal(r2.patch.paidAt, "2026-10-07");
  // 発送済（未請求）の出荷は状態を変えない
  assert.equal(paymentRemovalOf({ ...s, status: "shipped" }, bank, "2026-10-21").patch.status, "shipped");
  // 最新の記録に無ければ止める（ほかの人が先に取り消した）
  assert.throws(() => paymentRemovalOf({ ...s, payments: [hand] }, bank, "2026-10-21"), /見つかりません/);
  // 旧形式の1件も取り消せる
  const old = { ...sh("s9", "SH-2026-0009"), paymentAmount: 22000, paidAt: "2026-09-01" };
  const r3 = paymentRemovalOf(old, { amount: 22000, date: "2026-09-01", note: "（旧形式の記録）" }, "2026-10-21");
  assert.deepEqual(r3.patch.payments, []);
  assert.equal(r3.patch.status, "invoiced");
});

await t("supply.js のつなぎ（請求済にする・入金の取消）", () => {
  const src = readFileSync(fileURLToPath(new URL("../admin/js/supply.js", import.meta.url)), "utf8");
  assert.match(src, /import \{[^}]*invoicePatchOf, paymentRemovalOf[^}]*\} from "\/js\/supply-rules\.js"/);
  // 請求済にするは tx で最新を読んで invoicePatchOf の結果を書く（status:"invoiced" の決め打ちが残っていない）
  assert.match(src, /invoicePatchOf\(latest, \{ invoicedAt, dueDate, today: today\(\) \}\)/);
  assert.doesNotMatch(src, /updateDoc\(doc\(db,"shipments",s\._id\),\{ status:"invoiced", invoicedAt/);
  // 入金の取消は同じ tx で bankTxns を消す
  const del = src.slice(src.indexOf("async function deletePayment"), src.indexOf("// ===== 過入金を次回の請求に充当する"));
  assert.match(del, /runTransaction\(db/);
  assert.match(del, /paymentRemovalOf\(/);
  assert.match(del, /if\(bankTxnId\) tx\.delete\(doc\(db,"bankTxns",bankTxnId\)\)/);
});

await t("取込済みの可能性: 自動では選ばないが、人が選べば記録の対象になる（Codex 指摘3の結線）", async () => {
  const src = readFileSync(new URL("../admin/js/bank-import.js", import.meta.url), "utf8");
  assert.match(src, /initialSelection\(autoSelect\(matched\), hashed, imported\)/);       // 自動選択からは除く
  assert.match(src, /groupByShipment\(selection, hashed, recordedNow\)/);                  // 人が選んだものは対象
  assert.match(src, /別の振込として記録しますか？/);
  assert.match(src, /bankTxnIdCandidates\(r\.hash\)/);
  assert.match(src, /bankPaymentOf\(r, \{ recordedBy: by, recordedAt \}, txnIds\[i\]\)/);
  assert.match(src, /tx\.set\(doc\(db, "bankTxns", txnIds\[i\]\)/);
  assert.ok(!/取込済み \$\{imported\.size\}/.test(src));
});

await t("閲覧のみ: 供給管理の操作ボタンをクラスで止める（E2E で発見）", async () => {
  const { VIEWER_LOCK_SELECTOR } = await import("../admin/js/supply-rules.js");
  const src = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  // supply.js の行ボタン（class="btn … xxx" data-id）で、見るだけのもの以外はすべて止める対象に入っている
  const READ_ONLY = new Set(["mark-paid", "keep-dup-x"]);
  const classes = new Set([...src.matchAll(/class="btn btn-[a-z]+ ([a-z-]+)" data-(?:id|idx|sku)/g)].map((m) => m[1]));
  const missing = [...classes].filter((c) => !READ_ONLY.has(c) && !VIEWER_LOCK_SELECTOR.includes(`button.${c}`));
  assert.deepEqual(missing, [], `止める対象に無い操作ボタン: ${missing.join(",")}`);
  for (const c of ["request-ship", "mark-shipped", "cancel-ship", "keep-dup", "revert-draft"]) assert.ok(VIEWER_LOCK_SELECTOR.includes(`button.${c}`));
  assert.ok(VIEWER_LOCK_SELECTOR.includes("#newShipBtn"));
  assert.ok(!VIEWER_LOCK_SELECTOR.includes("mark-paid"));
  assert.match(src, /if\(viewerMode\) lockViewerButtons\(\);/);
});

console.log(`OK test-supply-wiring: ${n} 件合格`);
