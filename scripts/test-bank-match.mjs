// 入金明細の取り込み・照合（admin/js/bank-match.js）のテスト。node scripts/test-bank-match.mjs
import assert from "node:assert/strict";
import {
  decodeBankFile, parseCsv, parseBankDate, parseBankAmount, normalizePayer, extractCode, mapRows,
  rowHash, hashRows, buildCandidates, autoSelect, billToKeyOf, SCORE,
  bankTxnIdCandidates, pickFreeTxnId, MAX_TXN_SUFFIX,
} from "../admin/js/bank-match.js";

let n = 0;
const t = async (name, fn) => { await fn(); n++; };
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

await t("Shift_JIS を手で組んだバイト列を読む", () => {
  // 「日付,入金,名義\r\n2026/10/21,22000,0001ﾀﾀﾞｶﾖ\r\n」
  //   日=93FA 付=9574 入=93FC 金=8BE0 名=96BC 義=8B60。半角カナ ﾀ=C0 ﾞ=DE ｶ=B6 ﾖ=D6（0xC0 単独は UTF-8 として不正）
  const bytes = new Uint8Array([
    0x93, 0xFA, 0x95, 0x74, 0x2C, 0x93, 0xFC, 0x8B, 0xE0, 0x2C, 0x96, 0xBC, 0x8B, 0x60, 0x0D, 0x0A,
    ...ascii("2026/10/21,22000,0001"), 0xC0, 0xC0, 0xDE, 0xB6, 0xD6, 0x0D, 0x0A,
  ]);
  const { text, encoding } = decodeBankFile(bytes);
  assert.equal(encoding, "shift_jis");
  assert.equal(text, "日付,入金,名義\r\n2026/10/21,22000,0001ﾀﾀﾞｶﾖ\r\n");
  const rows = parseCsv(text);
  assert.deepEqual(rows, [["日付", "入金", "名義"], ["2026/10/21", "22000", "0001ﾀﾀﾞｶﾖ"]]);
  const m = mapRows(rows, { skip: 1, date: 0, deposit: 1, payer: 2 });
  assert.deepEqual(m.rows, [{ index: 1, date: "2026-10-21", amount: 22000, payer: "0001ﾀﾀﾞｶﾖ", payerNorm: "0001タダカヨ", code: "0001", balance: null }]);
  // ArrayBuffer でも読める
  assert.equal(decodeBankFile(bytes.buffer).encoding, "shift_jis");
});

await t("UTF-8（BOM つき）はそのまま", () => {
  const u = new TextEncoder().encode("﻿日付,金額\n2026-10-21,1000\n");
  const r = decodeBankFile(u);
  assert.equal(r.encoding, "utf-8");
  assert.equal(r.text, "日付,金額\n2026-10-21,1000\n");
});

await t("日付4形式（＋和暦・時刻つき・不正）", () => {
  assert.equal(parseBankDate("2026-10-21"), "2026-10-21");
  assert.equal(parseBankDate("2026/1/5"), "2026-01-05");
  assert.equal(parseBankDate("2026.10.21"), "2026-10-21");
  assert.equal(parseBankDate("20261021"), "2026-10-21");
  assert.equal(parseBankDate("2026年10月21日"), "2026-10-21");
  assert.equal(parseBankDate("R8.10.21"), "2026-10-21");
  assert.equal(parseBankDate("R08/10/21"), "2026-10-21");
  assert.equal(parseBankDate("令和8年10月21日"), "2026-10-21");
  assert.equal(parseBankDate("２０２６／１０／２１"), "2026-10-21"); // 全角
  assert.equal(parseBankDate("2026/10/21 10:15"), "2026-10-21");
  assert.equal(parseBankDate(" 2026-10-21 "), "2026-10-21");
  for (const bad of ["", null, "2026-02-30", "2026/13/01", "10/21", "日付", "202610211", "R8.2.30"]) {
    assert.equal(parseBankDate(bad), "", String(bad));
  }
});

await t("金額の記号除去・出金", () => {
  assert.equal(parseBankAmount("22,000"), 22000);
  assert.equal(parseBankAmount("¥22,000"), 22000);
  assert.equal(parseBankAmount("￥２２，０００円"), 22000);
  assert.equal(parseBankAmount("+22000"), 22000);
  assert.equal(parseBankAmount("-5,000"), -5000);
  assert.equal(parseBankAmount("△5,000"), -5000);
  assert.equal(parseBankAmount("▲5000"), -5000);
  assert.equal(parseBankAmount("(5,000)"), -5000);
  assert.equal(parseBankAmount(""), null);
  assert.equal(parseBankAmount("abc"), null);
});

await t("mapRows（入金/出金の列・符号つきの列・捨てる行）", () => {
  const rows = [
    ["日付", "摘要", "お預入れ", "お引出し", "残高"],
    ["2026/10/21", "振込 0001ﾀﾀﾞｶﾖ", "22,000", "", "122,000"],
    ["2026/10/21", "ATM", "", "10,000", "112,000"],   // 出金
    ["合計", "", "22,000", "10,000", ""],             // 日付が読めない
    ["2026/10/22", "利息", "0", "", "112,000"],        // 0円
    ["2026/10/22", "ｶ)ｻﾝﾌﾟﾙ", "abc", "", ""],          // 金額が読めない
  ];
  const m = mapRows(rows, { skip: 1, date: 0, payer: 1, deposit: 2, withdrawal: 3, balance: 4 });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].balance, 122000);
  assert.equal(m.rows[0].code, "0001"); // 「振込 0001…」は先頭の「振込」を読み飛ばして拾う（2026-10-21）
  assert.deepEqual(m.skipped.map((s) => [s.index, s.reason]), [[2, "出金"], [3, "日付が読めない"], [4, "0円"], [5, "金額が読めない"]]);
  // 符号つきの1列
  const m2 = mapRows([["2026-10-21", "-3000", "A"], ["2026-10-21", "3000", "B"]], { date: 0, amount: 1, payer: 2 });
  assert.deepEqual(m2.rows.map((r) => r.payer), ["B"]);
  assert.deepEqual(m2.skipped, [{ index: 0, reason: "出金" }]);
});

await t("normalizePayer", () => {
  assert.equal(normalizePayer("ｼﾔ)ﾀﾀﾞｶﾖ ｶｲｺﾞ"), "シヤ)タダカヨカイゴ");
  assert.equal(normalizePayer("ｼｬ)ﾀﾀﾞｶﾖ"), normalizePayer("シヤ）タダカヨ")); // 小書き・全角括弧も同じに
  assert.equal(normalizePayer("たろう　ﾔﾏﾀﾞ"), "タロウヤマダ");                 // ひらがな・全角空白
  assert.equal(normalizePayer("ｷｯﾁﾝ abc"), "キツチンABC");
  assert.equal(normalizePayer(null), "");
});

await t("extractCode", () => {
  assert.equal(extractCode("0001ﾀﾀﾞｶﾖ"), "0001");
  assert.equal(extractCode("0256 ｶ)ｾｲｼﾕｶｲ"), "0256");
  assert.equal(extractCode("０２５６ｶ)ｾｲｼﾕｶｲ"), "0256");     // 全角数字
  assert.equal(extractCode("ｶ)ｾｲｼﾕｶｲ 0256"), "0256");        // 後ろに付けた人
  assert.equal(extractCode("12345ｶ)ｾｲｼﾕｶｲ"), "");            // 5桁の一部は拾わない
  assert.equal(extractCode("ｶ)ｾｲｼﾕｶｲ"), "");
  assert.equal(extractCode("振込 0012ﾃｽﾄ"), "0012");            // 先頭の「振込」は読み飛ばす
  assert.equal(extractCode("ﾌﾘｺﾐ 0013ｶ)ﾃｽﾄ"), "0013");        // 半角カナの「ﾌﾘｺﾐ」も
  assert.equal(extractCode("振込ｶ)ﾃｽﾄ"), "");                   // コードが無ければ空
  assert.equal(extractCode(""), "");
});

await t("rowHash の決定性", async () => {
  const r = { date: "2026-10-21", amount: 22000, payerNorm: "0001タダカヨ", balance: null };
  const h1 = await rowHash(r), h2 = await rowHash({ ...r });
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2);                                      // 同じ行は同じ値
  assert.notEqual(h1, await rowHash(r, 1));                  // 2件目は別の値
  assert.notEqual(h1, await rowHash({ ...r, amount: 22001 }));
  // 残高は指紋に入れない（同じ入金が、期間の切り方で残高だけ違うファイルに出ても同じ値＝二重に取り込めない）
  assert.equal(h1, await rowHash({ ...r, balance: 100 }));
  assert.equal(h1, await rowHash({ ...r, balance: 999999 }));
  assert.notEqual(h1, await rowHash({ ...r, date: "2026-10-22" }));
  assert.notEqual(h1, await rowHash({ ...r, payerNorm: "0002タダカヨ" }));
  // payerNorm が無ければ payer から作る（同じ値になる）
  assert.equal(h1, await rowHash({ date: r.date, amount: r.amount, payer: "0001ﾀﾀﾞｶﾖ", balance: null }));
  // 同じファイルに同日・同額・同名義が2件 → 別の値。ファイルを取り込み直しても同じ並び
  const rows = [r, { ...r }, { ...r, amount: 5000 }];
  const a = await hashRows(rows), b = await hashRows(rows);
  assert.notEqual(a[0].hash, a[1].hash);
  assert.deepEqual(a.map((x) => x.hash), b.map((x) => x.hash));
  assert.equal(a[0].hash, h1);
  assert.equal(rows[0].hash, undefined); // 元の配列は変えない
  // 残高だけ違う2行は「同じ組み合わせの2件目」として数える（1件目は残高の違うファイルの1件目と同じ値）
  const c = await hashRows([{ ...r, balance: 100 }, { ...r, balance: 200 }]);
  assert.equal(c[0].hash, h1);
  assert.equal(c[1].hash, await rowHash(r, 1));
  const d = await hashRows([{ ...r, balance: 5555 }]);
  assert.equal(d[0].hash, c[0].hash);
});

// ===== 照合 =====
// 事業所向け（税込）: 11,000×2 = 22,000
const sh = (id, soNumber, o = {}) => ({ _id: id, soNumber, status: "invoiced", shipType: "direct", company: `法人${id}`,
  items: [{ sku: "bt", qty: 2, unitPrice: 11000 }], shippingFee: 0, ...o });
const row = (index, payer, amount) => ({ index, date: "2026-10-21", amount, payer, payerNorm: normalizePayer(payer), code: extractCode(payer), balance: null });

await t("候補の点数と理由", () => {
  const ships = [
    sh("s1", "SH-2026-0001"),
    sh("s2", "SH-2026-0002"),
    sh("s3", "SH-2026-0003", { status: "paid", payments: [{ amount: 22000 }] }), // 入金済は候補にしない
    sh("s4", "SH-2026-0004", { status: "draft" }),                               // 下書きは候補にしない
    sh("s5", "SH-2026-0005", { payments: [{ amount: 12000 }] }),                 // 部分入金 → 残 10,000
  ];
  const m = buildCandidates([row(1, "0001ﾀﾀﾞｶﾖ", 22000), row(2, "ﾀﾀﾞｶﾖ", 10000)], ships, { aliases: { "タダカヨ": ["法人s2"] } });
  const c1 = m[0].candidates;
  assert.equal(c1[0].shipmentId, "s1");
  assert.equal(c1[0].score, SCORE.code + SCORE.amount);
  assert.deepEqual(c1[0].reasons, ["振込人コード 0001 が一致", "金額が残額 ¥22,000 と一致"]);
  assert.deepEqual(c1.map((c) => c.shipmentId), ["s1", "s2"]); // s2 は金額だけ一致
  assert.ok(!c1.some((c) => ["s3", "s4"].includes(c.shipmentId)));
  // 2行目: コードなし。金額は s5 の残額、名義の学習は s2
  const c2 = m[1].candidates;
  assert.deepEqual(c2.map((c) => [c.shipmentId, c.score]), [["s5", SCORE.amount], ["s2", SCORE.alias]]);
  assert.equal(c2[1].reasons[0], "過去に同じ名義をこの請求先で記録");
  // aliases は Map でもよい
  const mm = buildCandidates([row(2, "ﾀﾀﾞｶﾖ", 1)], ships, { aliases: new Map([["タダカヨ", ["法人s2"]]]) });
  assert.deepEqual(mm[0].candidates.map((c) => c.shipmentId), ["s2"]);
  assert.equal(billToKeyOf({ shipType: "dropship", partnerEmail: "p@x.jp", company: "X" }), "p@x.jp");
});

await t("autoSelect: 1対1のときだけ選ぶ", () => {
  const ships = [sh("s1", "SH-2026-0001"), sh("s2", "SH-2026-0002")];
  const m = buildCandidates([row(1, "0001ﾀﾀﾞｶﾖ", 22000), row(2, "0002ｻﾝﾌﾟﾙ", 22000)], ships);
  assert.deepEqual(autoSelect(m), [{ rowIndex: 1, shipmentId: "s1" }, { rowIndex: 2, shipmentId: "s2" }]);
});

await t("autoSelect: コードだけ一致・金額だけ一致なら選ばない", () => {
  const ships = [sh("s1", "SH-2026-0001")];
  assert.deepEqual(autoSelect(buildCandidates([row(1, "0001ﾀﾀﾞｶﾖ", 20000)], ships)), []); // コードだけ
  assert.deepEqual(autoSelect(buildCandidates([row(1, "ﾀﾀﾞｶﾖ", 22000)], ships)), []);     // 金額だけ
  assert.deepEqual(autoSelect(buildCandidates([row(1, "ﾀﾀﾞｶﾖ", 22000)], ships, { aliases: { "タダカヨ": ["法人s1"] } })), []); // 金額＋名義でも選ばない
});

await t("autoSelect: 同じ金額・同じコードが2件なら選ばない", () => {
  // 同じ出荷を指す行が2つ（同じ振込が2回）→ どちらも選ばない
  const ships = [sh("s1", "SH-2026-0001")];
  assert.deepEqual(autoSelect(buildCandidates([row(1, "0001ﾀﾀﾞｶﾖ", 22000), row(2, "0001ﾀﾀﾞｶﾖ", 22000)], ships)), []);
  // 末尾4桁が同じ別年の出荷が2件・同じ残額 → 1行が2出荷を指すので選ばない
  const ships2 = [sh("a", "SH-2026-0001"), sh("b", "SH-2027-0001")];
  const m2 = buildCandidates([row(1, "0001ﾀﾀﾞｶﾖ", 22000)], ships2);
  assert.equal(m2[0].candidates.length, 2);
  assert.deepEqual(autoSelect(m2), []);
  // 同じ金額の出荷が2件でも、コードで1件に絞れれば選ぶ
  const ships3 = [sh("a", "SH-2026-0001"), sh("b", "SH-2026-0002")];
  assert.deepEqual(autoSelect(buildCandidates([row(1, "0002ﾀﾀﾞｶﾖ", 22000)], ships3)), [{ rowIndex: 1, shipmentId: "b" }]);
  assert.deepEqual(autoSelect([]), []);
  assert.deepEqual(autoSelect(undefined), []);
});

await t("同じ指紋の別の振込（別のCSV）: 取り込み記録のIDは hash, hash-2, -3 … の空きを使う（Codex 指摘3）", async () => {
  const r = { date: "2026-10-21", amount: 22000, payerNorm: "0001タダカヨ" };
  // 別々のCSVの1行目どうしは ordinal が同じ 0 なので指紋が一致する（これが誤判定の原因。画面では「取込済みの可能性」として人に選ばせる）
  const [a] = await hashRows([{ ...r, index: 1 }]), [b] = await hashRows([{ ...r, index: 7 }]);
  assert.equal(a.hash, b.hash);
  const ids = bankTxnIdCandidates("h");
  assert.equal(ids.length, MAX_TXN_SUFFIX);
  assert.deepEqual(ids.slice(0, 3), ["h", "h-2", "h-3"]);
  assert.equal(pickFreeTxnId("h", []), "h");
  assert.equal(pickFreeTxnId("h", [true]), "h-2");
  assert.equal(pickFreeTxnId("h", [true, true]), "h-3");
  assert.equal(pickFreeTxnId("h", [true, false, true]), "h-2");      // 途中が空いていればそこ（取り消した番号を使い直す）
  assert.equal(pickFreeTxnId("h", Array(MAX_TXN_SUFFIX).fill(true)), null);
});

console.log(`OK test-bank-match: ${n} 件合格`);
