// カードリーダーは事業所が自分で購入（0台・伴走支援費だけを請求）の見積もり（2026-11-28）の、エミュレータの要らないテスト。
//   ① 料金（estimate-pricing.js）: computeOwnReaderAmounts・calcFromInput・quoteAmounts・calcOfSavedQuote。3つの写しが同じ
//   ② 回帰: 1台以上の計算・金額の形は今までと同じ（calcFromInput＝computeAmounts・quoteAmounts＝今までの形）
//   ③ 見積書（quote-doc.js）・請求書（invoice-doc.js）・承諾書の印刷（order-consent.js）・承諾書のページ（order-consent-view.js）:
//      0台は伴走支援費の1行＋購入済みの注記・カードリーダーの行なし。1台以上の見積もり・出荷・手で入れた任意の行の HTML は、
//      この機能の前（2026-11-28 時点の main）の出力を固定した scripts/fixtures/own-reader-regression.json と一字一句同じ
//      （マージ後も回帰を見張れるよう、比べ先は git ではなく固定のファイル。作り直すのは意図して見た目を変えたときだけ:
//       node scripts/test-own-reader.mjs --update-snapshot <git の版>  例: --update-snapshot 236c356）
//   ④ 受注確定の確認メール: 0台は購入済みの1行・「カードリーダーの発送と」を出さない。直書きの呼び名が正本と同じ
//   ⑤ 画面の判定: 状態の表示「出荷なし」・受注確定の結果のまとめ
//
// 実行: node scripts/test-own-reader.mjs
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(path.join(root, p), "utf8");
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };
const ta = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };

const P = require(path.join(root, "functions/estimate-pricing.js"));
// --update-snapshot <版> のときだけ git からその版の帳票の部品を読み、固定の出力（fixture）を作り直す
const updIdx = process.argv.indexOf("--update-snapshot");
const SNAP_REV = updIdx > 0 ? (process.argv[updIdx + 1] || "") : "";
const gitSrc = (p) => execFileSync("git", ["-C", root, "show", `${SNAP_REV}:${p}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const FIXTURE = path.join(root, "scripts/fixtures/own-reader-regression.json");

// ---------- ① 料金 ----------
t("3つの写しが同じ（functions・公開ページ・管理画面）", () => {
  const a = read("functions/estimate-pricing.js");
  assert.equal(read("js/estimate-pricing.js"), a);
  assert.equal(read("admin/js/estimate-pricing.js"), a);
});
t("ナガヨシの実例: その他・購入 11,800 → 伴走支援費 30,200・自己負担 0", () => {
  const c = P.computeOwnReaderAmounts("other", 11800);
  assert.equal(c.accFeeIncl, 30200); assert.equal(c.totalIncl, 30200); assert.equal(c.grantAmt, 30200);
  assert.equal(c.selfPay, 0); assert.equal(c.discount, 0); assert.equal(c.devSubsidyIncl, 0); assert.equal(c.subsidyTotal, 0);
  assert.equal(c.ownReaderIncl, 11800);
  assert.deepEqual(P.quoteAmounts(c), { readers: 0, accompanyFee: 30200, discount: 0, subsidyPartTotal: 30200, extraPartTotal: 0,
    totalIncl: 30200, grantAmt: 30200, selfPay: 0, ownReaderIncl: 11800 });
});
t("区分ごとの上限 − 購入額（訪問通所 64,000・居住入所 55,000・その他 42,000）", () => {
  assert.equal(P.computeOwnReaderAmounts("houmon", 14500).accFeeIncl, 49500);
  assert.equal(P.computeOwnReaderAmounts("kyojyu", 6500).accFeeIncl, 48500);
  assert.equal(P.computeOwnReaderAmounts("other", 6500).accFeeIncl, 35500);
});
t("0未満にはしない（購入額が上限以上なら伴走支援費は0）", () => {
  assert.equal(P.computeOwnReaderAmounts("other", 42000).accFeeIncl, 0);
  assert.equal(P.computeOwnReaderAmounts("other", 99999).accFeeIncl, 0);
  assert.equal(P.computeOwnReaderAmounts("other", 99999).totalIncl, 0);
});
t("calcFromInput: 0台＋購入額は通る・検査", () => {
  const ok = P.calcFromInput("other", { ownReader: true, ownReaderIncl: 11800 });
  assert.equal(ok.ok, true); assert.equal(ok.ownReader, true); assert.equal(ok.calc.accFeeIncl, 30200);
  assert.equal(P.calcFromInput("other", { ownReader: true, ownReaderIncl: "11,800円" }).calc.accFeeIncl, 30200);
  for (const [d, re] of [
    [{ btQty: 1, ownReaderIncl: 11800 }, /0台/], [{ btExtra: 2, ownReaderIncl: 11800 }, /0台/],
    [{ ownReaderIncl: 0 }, /1円以上/], [{ ownReaderIncl: 1.5 }, /1円以上/], [{ ownReaderIncl: "-5" }, /1円以上/],
    [{ ownReaderIncl: null }, /1円以上/], [{ ownReaderIncl: [11800] }, /1円以上/], [{ ownReaderIncl: true }, /1円以上/],
    [{ ownReaderIncl: 42000 }, /0円/],
  ]) {
    const r = P.calcFromInput("other", { ownReader: true, ...d });
    assert.equal(r.ok, false, JSON.stringify(d)); assert.match(r.error, re);
  }
  assert.match(P.calcFromInput("nope", { ownReader: true, ownReaderIncl: 1 }).error, /プラン/);
  // ownReader は true（真偽値）のときだけ。"true" の文字などは通常の台数の見積もりとして扱う（0台なら拒否）
  assert.match(P.calcFromInput("other", { ownReader: "true", ownReaderIncl: 11800 }).error, /1台以上/);
});

// ---------- ② 回帰 ----------
t("1台以上: calcFromInput の計算は computeAmounts と同じ・quoteAmounts は今までの形（全区分・全台数）", () => {
  for (const plan of ["houmon", "kyojyu", "other"]) {
    for (let bt = 0; bt <= 3; bt++) for (let usb = 0; usb <= 3; usb++) for (const btx of [0, 2]) for (const usbx of [0, 1]) {
      const r = P.calcFromInput(plan, { btQty: bt, usbQty: usb, btExtra: btx, usbExtra: usbx });
      const c = P.computeAmounts(plan, bt, usb, btx, usbx);
      if (bt + usb < 1 || bt + usb > P.PLANS[plan].maxQty) { assert.equal(r.ok, false); continue; }
      assert.equal(r.ok, true); assert.equal(r.ownReader, false); assert.deepEqual(r.calc, c);
      const old = { readers: c.devSubsidyIncl, accompanyFee: c.accFeeIncl, discount: c.discount, subsidyPartTotal: c.subsidyPartTotal,
        extraPartTotal: c.extraPartTotal, totalIncl: c.totalIncl, grantAmt: c.grantAmt, selfPay: c.selfPay };
      assert.equal(JSON.stringify(P.quoteAmounts(c)), JSON.stringify(old));
      // 保存済みの見積もりからの出し直し（値引き）も今までの数え方と同じ
      const items = P.buildItems({ btQty: bt, usbQty: usb, btExtra: btx, usbExtra: usbx, usbConnector: "C" });
      assert.deepEqual(P.calcOfSavedQuote({ plan, items, amounts: old }), c);
    }
  }
});
await ta("下限（¥15,000）を下回る0台の見積もり: 管理者だけ・根拠必須／30,200円（ナガヨシ）はスタッフでも可（中4・2026-11-28 次田さん決定）", async () => {
  const PM = await import(pathToFileURL(path.join(root, "admin/js/pm-discount.js")).href);
  assert.equal(P.OWN_READER_FLOOR, PM.FLOOR, "下限は pm-discount.js の FLOOR と同じ");
  const c = (own, plan = "other") => P.calcFromInput(plan, { ownReader: true, ownReaderIncl: own }).calc;
  // ナガヨシ: 30,200 は下限以上 → スタッフ・根拠なしで可
  let r = P.checkOwnReaderPolicy({ calc: c(11800), isAdmin: false, basis: "" });
  assert.equal(r.ok, true); assert.equal(r.belowFloor, false);
  // ちょうど 15,000（42,000 − 27,000）は下回らない → スタッフ可
  assert.equal(P.checkOwnReaderPolicy({ calc: c(27000), isAdmin: false }).ok, true);
  // 14,999（42,000 − 27,001）は下回る → スタッフは拒否
  r = P.checkOwnReaderPolicy({ calc: c(27001), isAdmin: false, basis: "領収書あり" });
  assert.equal(r.ok, false); assert.equal(r.belowFloor, true); assert.match(r.error, /管理者だけ/); assert.match(r.error, /¥15,000/);
  // 管理者でも根拠が空・空白だけなら拒否
  for (const b of ["", "   ", null, undefined, 123]) {
    r = P.checkOwnReaderPolicy({ calc: c(27001), isAdmin: true, basis: b });
    assert.equal(r.ok, false, String(b)); assert.match(r.error, /根拠/);
  }
  // 管理者＋根拠で可。根拠は改行を空白に・前後の空白を除き・200字まで
  r = P.checkOwnReaderPolicy({ calc: c(27001), isAdmin: true, basis: "  自費で購入\n領収書あり  " });
  assert.equal(r.ok, true); assert.equal(r.basis, "自費で購入 領収書あり");
  assert.equal(P.cleanOwnReaderBasis("あ".repeat(250)).length, 200);
  // 台数の見積もり（0台でない）は対象外
  assert.equal(P.checkOwnReaderPolicy({ calc: P.computeAmounts("other", 1, 0, 0, 0), isAdmin: false }).ok, true);
});
t("calcOfSavedQuote: 購入額のある見積もりは上限 − 購入額", () => {
  assert.equal(P.calcOfSavedQuote({ plan: "other", items: [], amounts: { ownReaderIncl: 11800 } }).accFeeIncl, 30200);
});
t("calcFromInput: 台数は1つずつ0か確かめる（1 と −1 で合計0にしても通さない）", () => {
  for (const d of [{ btQty: 1, usbQty: -1 }, { btExtra: 2, usbExtra: -2 }, { btQty: "abc" }, { usbQty: 0.5 }]) {
    const r = P.calcFromInput("other", { ownReader: true, ownReaderIncl: 11800, ...d });
    assert.equal(r.ok, false, JSON.stringify(d)); assert.match(r.error, /0台/);
  }
  for (const d of [{ btQty: 0, usbQty: "0" }, { btQty: "", usbQty: null }, {}]) {
    assert.equal(P.calcFromInput("other", { ownReader: true, ownReaderIncl: 11800, ...d }).ok, true, JSON.stringify(d));
  }
  // サーバーは0台のとき品目を空に固定する（入力の台数を buildItems に渡さない）
  const idx0 = read("functions/index.js");
  assert.equal((idx0.match(/const items = ci\.ownReader \? \[\] : Pricing\.buildItems\(/g) || []).length, 2);
  assert.match(read("admin/js/practice-stubs.js"), /const items = ci\.ownReader \? \[\] : P\.buildItems\(/);
});

// ---------- ③ 帳票 ----------
// ブラウザ向けの ESM（/js/... の絶対パスを import する）を、node で読めるように import 先を書き換えて一時フォルダに置く
const tmp = mkdtempSync(path.join(os.tmpdir(), "kjk-own-reader-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 片付けの失敗は無視 */ } });
writeFileSync(path.join(tmp, "fs-stub.mjs"), "export const doc=()=>{};export const getDoc=async()=>({exists:()=>false});export const collection=()=>{};export const getDocs=async()=>({docs:[]});\n");
const adminUrl = (f) => pathToFileURL(path.join(root, "admin/js", f)).href;
function loadable(src, name) {
  const s = src.replace(/from "\/js\/fs\.js"/g, `from "${pathToFileURL(path.join(tmp, "fs-stub.mjs")).href}"`)
    .replace(/from "\/js\/([\w-]+\.js)"/g, (_, f) => `from "${adminUrl(f)}"`)
    .replace(/from "\.\/([\w-]+\.js)"/g, (_, f) => `from "${adminUrl(f)}"`);
  const p = path.join(tmp, name);
  writeFileSync(p, s);
  return import(pathToFileURL(p).href);
}
globalThis.window = { EstimatePricing: P };
const QD = await loadable(read("admin/js/quote-doc.js"), "quote-doc-new.mjs");
const ID = await import(adminUrl("invoice-doc.js"));
const OC = await import(adminUrl("order-consent.js"));
const OCV = await import(adminUrl("order-consent-view.js"));
const { SUPPORT_FEE_LABEL } = await import(adminUrl("support-fee-names.js"));

const created = new Date("2026-11-28T00:00:00+09:00"), until = new Date("2026-12-28T00:00:00+09:00");
const ownQ = { _id: "q1", estNo: "EST-2026-0999", version: 1, plan: "other", planLabel: "その他", items: [],
  amounts: P.quoteAmounts(P.computeOwnReaderAmounts("other", 11800)), createdAt: created, validUntil: until,
  corpName: "株式会社ナガヨシ", officeName: "ナガヨシ福祉用具", contactName: "長吉", createdVia: "staff", createdBy: "staff@tadakayo.jp" };
const normalQs = [
  ["houmon", 3, 0, 0, 0], ["houmon", 1, 1, 1, 0], ["kyojyu", 2, 0, 0, 0], ["other", 1, 0, 0, 0], ["other", 0, 1, 0, 2],
].map(([plan, bt, usb, btx, usbx], i) => ({ ...ownQ, _id: `n${i}`, plan, planLabel: P.PLANS[plan].label,
  items: P.buildItems({ btQty: bt, usbQty: usb, btExtra: btx, usbExtra: usbx, usbConnector: "A" }),
  amounts: P.quoteAmounts(P.computeAmounts(plan, bt, usb, btx, usbx)) }));
// 値引き（PM）の入った1台の見積もり
normalQs.push({ ...normalQs[0], _id: "npm", amounts: { ...normalQs[0].amounts, pmDiscount: 3000, totalIncl: normalQs[0].amounts.totalIncl - 3000, subsidyPartTotal: normalQs[0].amounts.subsidyPartTotal - 3000, grantAmt: normalQs[0].amounts.grantAmt - 3000 } });
const rowsOf = (html) => (html.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || "";
const CONSENT_DOC = { title: "承諾書", sections: [{ title: "第1条", body: "本文" }] };

// ---- 回帰の材料（1台以上の見積もり・出荷・手で入れた任意の行）と、その出力 ----
const RShip = { soNumber: "SH-2026-0701", shipType: "direct", company: "株式会社ナガヨシ", officeName: "ナガヨシ福祉用具", status: "shipped",
  shipDate: "2026-11-28", shippingFee: 0, dueRule: "net14", items: [] };
const regressionShips = [
  { ...RShip, items: [{ sku: "cir415a-01", name: "介護情報基盤 汎用カードリーダ CIR415A", qty: 1, unitPrice: 14500, connection: "Bluetooth／USB Type-C" },
    { sku: "support-fee", name: "接続サポート等経費（伴走支援費・補助対象1台）", qty: 1, unitPrice: 60000, nonStock: true },
    { sku: "discount", name: "金額調整", qty: 1, unitPrice: -32500, nonStock: true }] },
  { ...RShip, shippingFee: 370, shippingLabel: "送料", items: [{ sku: "cir315a-02", name: "CIR315A", qty: 3, unitPrice: 6500 },
    { sku: "support-fee", name: "伴走支援費（補助対象3台）", qty: 1, unitPrice: 50000, nonStock: true },
    { sku: "discount", name: "接続サポート等経費（伴走支援費）の値引き", qty: 1, unitPrice: -2000, nonStock: true, pm: true }] },
  { ...RShip, shipType: "dropship", partnerEmail: "p@example.com", partnerName: "認定", items: [{ sku: "cir415a-01", name: "CIR415A", qty: 2, unitPrice: 9000 }] },
  // 手で入れた任意の行（2026-11-09〜）: 購入額なし／購入額あり（物の出荷なし）／購入額あり＋カードリーダーの行。どれも注記は出さない（今までと同じ）
  { ...RShip, noGoods: true, items: [{ sku: "support-fee", name: "接続サポート等経費（伴走支援費）", qty: 1, unitPrice: 30000, nonStock: true, manual: true }] },
  { ...RShip, noGoods: true, items: [{ sku: "support-fee", name: "接続サポート等経費（伴走支援費）", qty: 1, unitPrice: 30200, nonStock: true, manual: true, priorBuyerReaderCost: 11800 }] },
  { ...RShip, items: [{ sku: "cir415a-01", name: "CIR415A", qty: 1, unitPrice: 14500 },
    { sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 15700, nonStock: true, manual: true, priorBuyerReaderCost: 11800 }] },
];
function regressionOutputs(QDx, IDx, OCx, OCVx) {
  return {
    quoteDoc: normalQs.map((q) => QDx.renderQuoteDocHtml({ quote: q, kase: null, office: null, products: [] })),
    invoice: regressionShips.map((x) => IDx.renderInvoiceHtml(x, {}, { issueDate: "2026年11月28日" })),
    consentPrint: normalQs.map((q) => OCx.buildOrderConsentPrintHtml({ document: CONSENT_DOC, quotes: [q], printedYmd: "2026-11-28" })),
    consentView: normalQs.map((q) => OCVx.orderQuotesTableHtml({ quotes: [{ ...q, items: q.items, amounts: q.amounts }] })),
  };
}
if (SNAP_REV) {
  const QDM = await loadable(gitSrc("admin/js/quote-doc.js"), "quote-doc-snap.mjs");
  const IDM = await loadable(gitSrc("admin/js/invoice-doc.js"), "invoice-doc-snap.mjs");
  await loadable(gitSrc("admin/js/order-consent-rules.js"), "order-consent-rules.js");
  const OCM = await loadable(gitSrc("admin/js/order-consent.js").replace(/from "\.\/order-consent-rules\.js"/, `from "${pathToFileURL(path.join(tmp, "order-consent-rules.js")).href}"`), "order-consent-snap.mjs");
  writeFileSync(path.join(tmp, "order-consent.js"), readFileSync(path.join(tmp, "order-consent-snap.mjs")));
  const OCVM = await loadable(gitSrc("admin/js/order-consent-view.js").replace(/from "\.\/order-consent\.js"/, `from "${pathToFileURL(path.join(tmp, "order-consent-snap.mjs")).href}"`), "order-consent-view-snap.mjs");
  writeFileSync(FIXTURE, JSON.stringify({ note: `test-own-reader.mjs の回帰の比べ先。${SNAP_REV} の帳票の部品で作った出力（作り直すのは意図して見た目を変えたときだけ）`,
    rev: SNAP_REV, ...regressionOutputs(QDM, IDM, OCM, OCVM) }, null, 1) + "\n");
  console.log(`fixture を作り直した: ${FIXTURE}（${SNAP_REV}）`);
}
const SNAP = JSON.parse(readFileSync(FIXTURE, "utf8"));
const NOW = regressionOutputs(QD, ID, OC, OCV);

t("見積書: 0台は伴走支援費の1行（30,200）＋購入済みの注記・カードリーダーの行なし・自己負担 ¥0", () => {
  const h = QD.renderQuoteDocHtml({ quote: ownQ, kase: null, office: null, products: [] });
  const body = rowsOf(h);
  assert.equal((body.match(/<tr/g) || []).length, 1, body);
  assert.ok(body.includes(SUPPORT_FEE_LABEL) && body.includes("¥30,200"));
  assert.ok(body.includes("カードリーダーは事業所さまで購入済み（¥11,800・税込）"), body);
  assert.ok(body.includes("助成金の上限 ¥42,000 から差し引いた額"));
  assert.ok(!/CIR|カードリーダ CIR|補助対象 \d台/.test(body), body);
  assert.ok(h.includes("自己負担 ¥0") && h.includes("−¥30,200"), "助成金充当と自己負担");
  assert.ok(h.includes("本見積書にカードリーダーは含みません"));
  assert.ok(!h.includes("台数や機種の変更ができます"));
});
t("見積書: 0台＋値引きは値引きの行も出す", () => {
  const a = { ...ownQ.amounts, pmDiscount: 5000, totalIncl: 25200, subsidyPartTotal: 25200, grantAmt: 25200 };
  const body = rowsOf(QD.renderQuoteDocHtml({ quote: { ...ownQ, amounts: a }, kase: null, office: null, products: [] }));
  assert.equal((body.match(/<tr/g) || []).length, 2); assert.ok(body.includes("−¥5,000"));
});
t("見積書: 1台以上（値引きありも）の HTML は固定の出力（fixture）と一字一句同じ", () => {
  assert.equal(SNAP.quoteDoc.length, normalQs.length);
  NOW.quoteDoc.forEach((h, i) => assert.equal(h, SNAP.quoteDoc[i], normalQs[i]._id));
});

const ownShip = { soNumber: "SH-2026-0701", shipType: "direct", company: "株式会社ナガヨシ", officeName: "ナガヨシ福祉用具", status: "shipped",
  noGoods: true, shipDate: "2026-11-28", shippingFee: 0, dueRule: "net14",
  items: [{ sku: "support-fee", name: SUPPORT_FEE_LABEL, qty: 1, unitPrice: 30200, nonStock: true, manual: true, manualBy: "x", manualAt: "2026-11-28T00:00:00Z", priorBuyerReaderCost: 11800, ownReader: true }] };
t("請求書: 0台は伴走支援費の1行・購入済みの注記・カードリーダーの行なし・合計 30,200", () => {
  const h = ID.renderInvoiceHtml(ownShip, {}, { issueDate: "2026年11月28日" });
  const body = rowsOf(h);
  assert.equal((body.match(/<tr/g) || []).length, 1, body);
  assert.ok(body.includes(SUPPORT_FEE_LABEL) && body.includes("¥30,200"));
  assert.ok(body.includes("カードリーダーは事業所さまで購入済み（¥11,800・税込）"), body);
  assert.ok(!/CIR|つなぎ方/.test(body));
  assert.equal(ID.invoiceTotals(ownShip).total, 30200);
});
t("請求書: 1台以上の出荷・手で入れた任意の行（購入額あり・カードリーダーの行ありも）は固定の出力と一字一句同じ（注記は出ない）", () => {
  assert.equal(SNAP.invoice.length, regressionShips.length);
  NOW.invoice.forEach((h, i) => { assert.equal(h, SNAP.invoice[i], `ship ${i}`); assert.ok(!h.includes("購入済み"), `ship ${i}`); });
});
t("請求書: 見積もり由来の行でも、カードリーダーの行と並ぶ出荷には注記を出さない", () => {
  const s2 = { ...ownShip, items: [{ sku: "cir415a-01", name: "CIR415A", qty: 1, unitPrice: 14500 }, ...ownShip.items] };
  assert.ok(!ID.renderInvoiceHtml(s2, {}, { issueDate: "2026年11月28日" }).includes("購入済み"));
});
t("承諾書の印刷: 0台は購入済みと伴走支援費のみ・1台以上は固定の出力と同じ", () => {
  const h = OC.buildOrderConsentPrintHtml({ document: CONSENT_DOC, quotes: [ownQ], printedYmd: "2026-11-28" });
  assert.ok(h.includes("カードリーダーは事業所で購入済み（¥11,800・税込）・接続サポート等経費（伴走支援費）のみ"), h.slice(0, 500));
  NOW.consentPrint.forEach((x, i) => assert.equal(x, SNAP.consentPrint[i], normalQs[i]._id));
});
t("承諾書のページ（事業所が開く consent.html）: 0台は 0台・購入済み・伴走支援費のみ／1台以上は固定の出力と同じ", () => {
  const entry = { estNo: ownQ.estNo, version: 1, corpName: ownQ.corpName, officeName: ownQ.officeName, items: [],
    amounts: { readers: 0, accompanyFee: 30200, discount: 0, totalIncl: 30200, grantAmt: 30200, selfPay: 0, ownReaderIncl: 11800 } };
  const h = OCV.orderQuotesTableHtml({ quotes: [entry] });
  assert.ok(h.includes("カードリーダー 0台（事業所さまで購入済み・¥11,800・税込）・接続サポート等経費（伴走支援費）のみ"), h);
  NOW.consentView.forEach((x, i) => assert.equal(x, SNAP.consentView[i], normalQs[i]._id));
});

// ---------- ④ 確認メール ----------
const idx = read("functions/index.js");
function mailFns(src, FlowMod) {
  const i = src.indexOf("function acceptMailText(");
  const j = src.indexOf("// 出荷の「使い直し・重複」の Chat 用の注記");
  assert.ok(i > 0 && j > i, "acceptMailText が見つからない");
  const fmt = src.slice(src.indexOf("function fmtNum("), src.indexOf("\n}\n", src.indexOf("function fmtNum(")) + 2);
  const pay = /const PAY_LABELS = \{[^}]*\};/.exec(src)[0];
  return new Function("Flow", `${fmt}\n${pay}\n${src.slice(i, j)}\nreturn { acceptMailText, acceptMailTextGroup };`)(FlowMod);
}
const Flow = require(path.join(root, "functions/accept-flow.js"));
const M = mailFns(idx, Flow);
t("確認メール: 0台は購入済みの1行・「カードリーダーの発送と」を出さない", () => {
  const m = M.acceptMailText({ q: ownQ, agreedName: "長吉", payKey: "after", delivery: {}, preferredDate: "" });
  assert.ok(m.body.includes("カードリーダー: 事業所さまでご購入済み（¥11,800・税込）。タダカヨからのご請求は接続サポート等経費（伴走支援費）のみです"), m.body);
  assert.ok(m.body.includes("担当スタッフから、伴走支援の日程について"));
  assert.ok(!m.body.includes("カードリーダーの発送と"));
  const g = M.acceptMailTextGroup({ items: [{ q: ownQ, soNumber: "SH-1" }, { q: normalQs[0], soNumber: "SH-2" }], agreedName: "x", payKey: "after", preferredDate: "" });
  assert.ok(g.body.includes("カードリーダーの発送と"), "1件でもカードリーダーがあれば発送の案内を残す");
});
t("確認メールの直書きの呼び名が正本（support-fee-names.js）と同じ", () => {
  const m = /function ownReaderLine\(q\) \{[\s\S]*?\n\}/.exec(idx);
  assert.ok(m && m[0].includes(`ご請求は${SUPPORT_FEE_LABEL}のみです`));
});

// ---------- ⑤ 画面の判定 ----------
const F = await import(adminUrl("ship-flow.js"));
const SR = await import(adminUrl("screen-rules.js"));
t("状態の表示: 物の出荷なしの発送済は「出荷なし」・請求済は「請求済」・普通の発送済は「発送済」", () => {
  assert.equal(F.shipStatusLabelOf({ status: "shipped", noGoods: true }), "出荷なし");
  assert.equal(F.shipStatusLabelOf({ status: "invoiced", noGoods: true }), "請求済");
  assert.equal(F.shipStatusLabelOf({ status: "shipped" }), "発送済");
  assert.equal(F.nextStatus("shipped", "invoice"), "invoiced");
});
t("受注確定の結果のまとめ: すべて物の出荷なしのときだけ noGoods", () => {
  assert.equal(SR.summarizeAcceptResult({ ok: true, results: [{ soNumber: "SH-1", noGoods: true }] }).noGoods, true);
  assert.equal("noGoods" in SR.summarizeAcceptResult({ ok: true, results: [{ soNumber: "SH-1", noGoods: true }, { soNumber: "SH-2" }] }), false);
  assert.equal("noGoods" in SR.summarizeAcceptResult({ ok: true, results: [{ soNumber: "SH-1" }] }), false);
});
t("練習の代役も同じ計算（calcFromInput・calcOfSavedQuote・quoteAmounts）と同じ出荷の扱い", () => {
  const ps = read("admin/js/practice-stubs.js");
  assert.match(ps, /P\.calcFromInput\(planKey, d\)/);
  assert.match(ps, /P\.calcOfSavedQuote\(base\)/);
  assert.match(ps, /priorBuyerReaderCost: ownReader,/);
  assert.match(ps, /P\.checkOwnReaderPolicy\(\{ calc, isAdmin: isAdm, basis: d\.ownReaderBasis \}\)/);
  assert.match(ps, /status: "shipped", noGoods: true/);
});
t("倉庫の一覧（warehouseList）は物の出荷なしを除く", () => {
  assert.match(idx, /const atLoc = \(s\) => s\.fulfillment !== "direct" && !s\.noGoods &&/);
});

console.log(`OK test-own-reader: 合計 ${n} 件合格`);
