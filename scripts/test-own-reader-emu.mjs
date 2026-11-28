// カードリーダーは事業所が自分で購入（タダカヨから出すカードリーダーは0台・伴走支援費だけを請求）の見積もり（2026-11-28）を、
// Firestore エミュレータに対して実際に動かして確かめる。進め方は scripts/test-pm-discount-emu.mjs と同じ（.run() で直接呼ぶ・demo- プロジェクト）。
//
//   A. staffCreateQuote: 0台＋購入額で作れる（実例: 株式会社ナガヨシ・その他・購入 11,800 → 伴走支援費 30,200・自己負担 0）
//   B. 入力の検査（台数と同時・金額なし・小数・上限以上＝伴走支援費0円）は拒否・何も書かない
//   C. staffAcceptQuote: 出荷は「物の出荷なし」で発送済（在庫・出荷指示なし）。明細は伴走支援費の1行だけ（カードリーダーの行なし）
//      → 「請求済にする」（supply-rules の markInvoicedPlanOf）で請求済。請求額は 30,200
//   D. 倉庫の一覧（warehouseList）に出ない
//   E. 値引き（setQuoteDiscount）: 標準額は 30,200。受注確定で出荷に伴走支援費の行と値引きの行
//   F. 改版（reviseQuote）: 1台 → 0台（下書きの出荷が伴走支援費だけに作り直る）／0台 → 1台（元の形に戻る）
//   G. 回帰: 1台の見積もりの金額・形は今までと同じ（ownReaderIncl を持たない）・受注確定の出荷は下書き
//
// 実行: firebase emulators:exec --only firestore --project demo-own-reader-test "node scripts/test-own-reader-emu.mjs"
//   （bash scripts/test-all.sh の2段目でも動く）
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-own-reader-test";
if (!/^demo-/.test(process.env.GCLOUD_PROJECT)) { console.error("demo- のプロジェクトだけで動かす"); process.exit(2); }
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, opts);
  return new Response("blocked in test", { status: 503 }); // 外へは出さない
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(REPO, "functions");
const require = createRequire(path.join(FN_DIR, "index.js"));
const fns = require(path.join(FN_DIR, "index.js"));
const admin = require("firebase-admin");
const db = admin.firestore();
const TS = admin.firestore.Timestamp;
const Pricing = require(path.join(FN_DIR, "estimate-pricing.js"));
const { markInvoicedPlanOf } = await import(path.join(REPO, "admin/js/supply-rules.js"));
const { invoiceTotals } = await import(path.join(REPO, "admin/js/invoice-doc.js"));
const { nextStatus, shipStatusLabelOf, stockDeducted } = await import(path.join(REPO, "admin/js/ship-flow.js"));
const MSF = await import(path.join(REPO, "admin/js/manual-support-fee.js"));

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); console.error(`... ${t}`); }

const STAFF = "staff@tadakayo.jp", ADMIN = "admin@tadakayo.jp";
async function call(name, email, data) {
  try {
    const r = await fns[name].run({ auth: { uid: "uid-" + email, token: { email, name: email } }, data, rawRequest: {} });
    return { ok: true, r };
  } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
const get = async (ref) => { const s = await ref.get(); return s.exists ? s.data() : null; };
const cd = (id) => db.collection("cases").doc(id);
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const quotesOf = async (caseId) => (await db.collection("quotes").where("caseId", "==", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const latestOf = async (caseId) => (await quotesOf(caseId)).sort((a, b) => b.version - a.version)[0];
const shipsOf = async (caseId) => (await db.collection("shipments").where("caseId", "==", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const actsOf = async (caseId) => (await db.collection("activities").where("caseId", "==", caseId).get()).docs.map((d) => d.data());
const movesCount = async () => (await db.collection("inventoryMovements").get()).size;
async function seed(items) { const b = db.batch(); for (const [ref, d] of items) b.set(ref, d); await b.commit(); }
const READER_SKUS = [Pricing.SKU.BT, Pricing.SKU.USB_A, Pricing.SKU.USB_C];
const accept = (quoteId) => call("staffAcceptQuote", STAFF, { quoteId, acceptedName: "長吉 太郎", channel: "phone", receivedDate: TODAY, payMethod: "after", sendMail: false });

await seed([
  [db.collection("users").doc(STAFF), { active: true, role: "staff", name: "職員" }],
  [db.collection("users").doc(ADMIN), { active: true, role: "admin", name: "管理 太郎" }],
  [db.collection("_counters").doc("shipments"), { value: 700 }],
  [db.collection("appConfig").doc("settings"), { orderByConsent: false }],
  [db.collection("locations").doc("L1"), { name: "東京倉庫", isDefault: true, active: true }],
  [db.collection("products").doc(Pricing.SKU.BT), { name: "CIR415A", stock: 10, stockByLocation: { L1: 10 } }],
  [db.collection("offices").doc("oN"), { officeName: "ナガヨシ福祉用具", corpName: "株式会社ナガヨシ", postalCode: "100-0001", prefecture: "東京都", city: "千代田区", addressDetail: "1-1", phone: "03-0000-0000" }],
]);
const moves0 = await movesCount();

// ---------- A ----------
section("A. 0台＋購入額で見積もりを作る（ナガヨシの実例）");
await seed([[cd("cN"), { status: 2, caseNumber: 801, officeId: "oN", officeName: "ナガヨシ福祉用具", corpName: "株式会社ナガヨシ", contactName: "長吉", contactEmail: "" }]]);
let r = await call("staffCreateQuote", STAFF, { caseId: "cN", plan: "other", btQty: 0, usbQty: 0, btExtra: 0, usbExtra: 0, ownReader: true, ownReaderIncl: 11800, sendMail: false });
check("作れる", r.ok && r.r.ok && r.r.totalIncl === 30200, JSON.stringify(r).slice(0, 300));
const qN1 = await latestOf("cN");
check("金額: 伴走支援費 30,200・合計 30,200・助成金充当 30,200・自己負担 0・購入額 11,800", qN1 && qN1.amounts.accompanyFee === 30200
  && qN1.amounts.totalIncl === 30200 && qN1.amounts.grantAmt === 30200 && qN1.amounts.selfPay === 0 && qN1.amounts.readers === 0
  && qN1.amounts.discount === 0 && qN1.amounts.ownReaderIncl === 11800, JSON.stringify(qN1 && qN1.amounts));
check("見積もりの品目は空（カードリーダーは0台）", Array.isArray(qN1.items) && qN1.items.length === 0, JSON.stringify(qN1.items));
const kN1 = await get(cd("cN"));
check("案件: 合計・助成金・自己負担・カードリーダーなし", kN1.totalAmount === 30200 && kN1.expectedSubsidyAmount === 30200 && kN1.selfPay === 0
  && Array.isArray(kN1.cardReaders) && kN1.cardReaders.length === 0 && kN1.subsidyCategory === "other", JSON.stringify(kN1));
const actN = (await actsOf("cN")).find((a) => /見積もりを作成/.test(a.subject));
check("活動: 事業所が購入（¥11,800）と伴走支援費", actN && /事業所が自分で購入（¥11,800・税込）/.test(actN.body) && /¥30,200/.test(actN.body), JSON.stringify(actN));

// 他の区分（上限 − 購入額）
await seed([[cd("cH"), { status: 2, caseNumber: 802 }], [cd("cK"), { status: 2, caseNumber: 803 }]]);
r = await call("staffCreateQuote", STAFF, { caseId: "cH", plan: "houmon", ownReader: true, ownReaderIncl: "14,500", sendMail: false });
check("訪問・通所: 64,000 − 14,500 ＝ 49,500（金額は「14,500」の文字でも読める）", r.ok && r.r.totalIncl === 49500, JSON.stringify(r).slice(0, 200));
r = await call("staffCreateQuote", STAFF, { caseId: "cK", plan: "kyojyu", ownReader: true, ownReaderIncl: 6500, sendMail: false });
check("居住・入所: 55,000 − 6,500 ＝ 48,500", r.ok && r.r.totalIncl === 48500, JSON.stringify(r).slice(0, 200));

// ---------- B ----------
section("B. 入力の検査（拒否・何も書かない）");
await seed([[cd("cB"), { status: 2, caseNumber: 804 }]]);
const bad = [
  [{ btQty: 1, ownReaderIncl: 11800 }, /台数をすべて0台/],
  [{ usbExtra: 1, ownReaderIncl: 11800 }, /台数をすべて0台/],
  [{ ownReaderIncl: "" }, /1円以上の整数/],
  [{ ownReaderIncl: 0 }, /1円以上の整数/],
  [{ ownReaderIncl: 1180.5 }, /1円以上の整数/],
  [{ ownReaderIncl: -100 }, /1円以上の整数/],
  [{ ownReaderIncl: "abc" }, /1円以上の整数/],
  [{ ownReaderIncl: 42000 }, /伴走支援費が0円/],
  [{ ownReaderIncl: 50000 }, /伴走支援費が0円/],
];
for (const [d, re] of bad) {
  r = await call("staffCreateQuote", STAFF, { caseId: "cB", plan: "other", ownReader: true, sendMail: false, ...d });
  check(`拒否: ${JSON.stringify(d)}`, !r.ok && r.code === "invalid-argument" && re.test(r.msg), JSON.stringify(r));
}
r = await call("staffCreateQuote", STAFF, { caseId: "cB", plan: "other", btQty: 0, usbQty: 0, sendMail: false });
check("チェックなしの0台は今までどおり拒否", !r.ok && /1台以上/.test(r.msg), JSON.stringify(r));
check("拒否のあいだ見積もりは作られていない", (await quotesOf("cB")).length === 0);
r = await call("staffCreateQuote", STAFF, { caseId: "cB", plan: "other", ownReader: true, ownReaderIncl: 41999, sendMail: false });
check("上限ぎりぎり（41,999）は伴走支援費 1 円で作れる", r.ok && r.r.totalIncl === 1, JSON.stringify(r).slice(0, 200));

// ---------- C ----------
section("C. 受注確定 → 物の出荷なし（発送済）→ 請求済");
r = await accept(qN1.id);
check("受注確定できる・結果に noGoods", r.ok && r.r.ok && r.r.results.length === 1 && r.r.results[0].noGoods === true, JSON.stringify(r).slice(0, 300));
const [sN] = await shipsOf("cN");
check("出荷は1件・発送済・noGoods・送料0・郵送なし", sN && sN.status === "shipped" && sN.noGoods === true && sN.shippingMethod === "none"
  && sN.shippingFee === 0 && sN.deliveryMode === "ship", JSON.stringify(sN).slice(0, 400));
check("出荷指示は投稿しない印（skipped）・出荷指示の投稿の記録なし", sN.shipNotifyStatus === "skipped" && !sN.shipNotifiedAt && !sN.requestedAt);
check("支払期限は発行日＋14日（net14）・発送済の記録", sN.dueRule === "net14" && sN.shippedAt instanceof TS && sN.shippedByEmail === STAFF);
check("出荷元なし（倉庫を通らない）", sN.originLocationId === "" && !sN.fulfillment);
const readerRows = sN.items.filter((i) => READER_SKUS.includes(i.sku));
const feeRows = sN.items.filter((i) => i.sku === "support-fee");
check("明細にカードリーダーの行が無い", readerRows.length === 0, JSON.stringify(sN.items));
check("明細は伴走支援費の1行だけ（30,200・名前は事業所向けの呼び名・在庫を使わない）", sN.items.length === 1 && feeRows.length === 1
  && feeRows[0].unitPrice === 30200 && feeRows[0].qty === 1 && feeRows[0].nonStock === true && feeRows[0].name === "接続サポート等経費（伴走支援費）",
  JSON.stringify(sN.items));
check("伴走支援費の行は任意の金額の行の形（購入額 11,800・見積もりから作った印）", feeRows[0].manual === true && feeRows[0].priorBuyerReaderCost === 11800
  && feeRows[0].ownReader === true);
check("任意の行の保存前の検査に通る（区分の上限 − 購入額 以下）", MSF.checkSupportFeeRows(sN.items, { planLimit: 42000, readerSkus: READER_SKUS }).ok);
check("修正の画面で開いても標準額どおり（値引き扱いにならない）", MSF.belowStandardCheck({ amount: 30200, priorBuyerReaderCost: 11800, planLimit: 42000, readerCost: 0, isAdmin: false, memo: "" }).ok);
check("在庫の動きなし（inventoryMovements が増えていない）", (await movesCount()) === moves0);
check("在庫は引いた扱いでも、戻す在庫の行が無い（キャンセルで在庫が増えない）", stockDeducted(sN) === true ? sN.items.every((i) => i.nonStock) : true);
check("状態の表示は「出荷なし」", shipStatusLabelOf(sN) === "出荷なし");
check("請求額（invoiceTotals）は 30,200", invoiceTotals(sN).total === 30200 && invoiceTotals(sN).payable === 30200);
const kN2 = await get(cd("cN"));
check("案件は受注確定（3）・出荷が紐づく", Number(kN2.status) === 3 && kN2.shipmentId === sN.id);
const actAcc = (await actsOf("cN")).find((a) => /受注確定/.test(a.subject));
check("活動: 物の出荷なしとして発送済で登録・次は請求書", actAcc && /物の出荷なし/.test(actAcc.body) && /次は請求書/.test(actAcc.body), JSON.stringify(actAcc));
// 「請求済にする」（画面の markInvoiced がトランザクションの中で使う判定）
check("発送済 → 請求済の遷移が許される", nextStatus(sN.status, "invoice") === "invoiced");
const plan = markInvoicedPlanOf(sN, { invoicedAt: TODAY, dueDate: "2099-01-01", today: TODAY, requireShipped: true });
await db.collection("shipments").doc(sN.id).update(plan.patch);
const sN2 = await get(db.collection("shipments").doc(sN.id));
check("請求済になる（出荷を経ずに請求書を出せる）・残額 30,200", sN2.status === "invoiced" && plan.remain === 30200, JSON.stringify(plan));

// ---------- D ----------
section("D. 倉庫の一覧に出ない");
r = await call("warehouseList", STAFF, { locationId: "L1" });
check("warehouseList が通る", r.ok, JSON.stringify(r).slice(0, 200));
check("物の出荷なしの出荷は倉庫のどの一覧にも無い", r.ok && !JSON.stringify(r.r).includes(sN.soNumber), JSON.stringify(r.r).slice(0, 300));

// ---------- E ----------
section("E. 値引き（管理者）と受注確定");
await seed([[cd("cE"), { status: 2, caseNumber: 805 }]]);
r = await call("staffCreateQuote", STAFF, { caseId: "cE", plan: "other", ownReader: true, ownReaderIncl: 11800, sendMail: false });
const qE1 = await latestOf("cE");
r = await call("setQuoteDiscount", ADMIN, { quoteId: qE1.id, amount: 5000, reason: "PM判断（テスト）", sendMail: false });
check("値引きが入る（標準額 30,200 → 25,200）", r.ok && r.r.pmDiscount === 5000 && r.r.totalIncl === 25200, JSON.stringify(r).slice(0, 300));
const qE2 = await latestOf("cE");
check("新しい版も購入額を持つ・合計 25,200・自己負担 0", qE2.amounts.ownReaderIncl === 11800 && qE2.amounts.totalIncl === 25200
  && qE2.amounts.selfPay === 0 && qE2.pmDiscount && qE2.pmDiscount.standardFee === 30200, JSON.stringify(qE2.amounts));
r = await accept(qE2.id);
const [sE] = await shipsOf("cE");
check("出荷: 伴走支援費 30,200 ＋ 値引き −5,000・カードリーダーの行なし・発送済（出荷なし）", r.ok && sE && sE.status === "shipped" && sE.noGoods === true
  && sE.items.length === 2 && sE.items.some((i) => i.sku === "support-fee" && i.unitPrice === 30200)
  && sE.items.some((i) => i.pm === true && i.unitPrice === -5000) && invoiceTotals(sE).total === 25200, JSON.stringify(sE && sE.items));

// ---------- F ----------
section("F. 改版（1台 ⇄ 0台）");
await seed([[cd("cF"), { status: 2, caseNumber: 806, officeId: "oN" }]]);
r = await call("staffCreateQuote", STAFF, { caseId: "cF", plan: "other", btQty: 1, sendMail: false });
const qF1 = await latestOf("cF");
r = await accept(qF1.id);
let [sF] = await shipsOf("cF");
check("1台の受注確定は今までどおり下書き（カードリーダーの行あり）", sF.status === "draft" && !sF.noGoods && sF.items.some((i) => i.sku === Pricing.SKU.BT));
r = await call("reviseQuote", STAFF, { quoteId: qF1.id, plan: "other", btQty: 0, usbQty: 0, btExtra: 0, usbExtra: 0, ownReader: true, ownReaderIncl: 11800, reason: "事業所が自分で購入済みと判明", sendMail: false });
check("0台へ改版できる・下書きも更新", r.ok && r.r.totalIncl === 30200 && r.r.shipmentUpdated === true, JSON.stringify(r).slice(0, 300));
[sF] = await shipsOf("cF");
check("下書きの出荷は伴走支援費の1行だけになる（30,200・購入額 11,800）", sF.status === "draft" && sF.items.length === 1
  && sF.items[0].sku === "support-fee" && sF.items[0].unitPrice === 30200 && sF.items[0].priorBuyerReaderCost === 11800, JSON.stringify(sF.items));
const actF = (await actsOf("cF")).find((a) => /見積もりを変更/.test(a.subject));
check("活動: 変更後は「カードリーダーは事業所で購入（¥11,800）」", actF && /変更後: カードリーダーは事業所で購入（¥11,800）/.test(actF.body), JSON.stringify(actF));
const qF2 = await latestOf("cF");
r = await call("reviseQuote", STAFF, { quoteId: qF2.id, plan: "other", btQty: 1, usbQty: 0, btExtra: 0, usbExtra: 0, reason: "やはりタダカヨから購入", sendMail: false });
const qF3 = await latestOf("cF");
[sF] = await shipsOf("cF");
check("1台へ戻すと元の形（購入額を持たない・カードリーダー＋伴走支援費＋金額調整）", r.ok && !("ownReaderIncl" in qF3.amounts)
  && qF3.amounts.totalIncl === 42000 && sF.items.some((i) => i.sku === Pricing.SKU.BT) && sF.items.some((i) => i.sku === "support-fee" && !i.manual),
  JSON.stringify({ a: qF3.amounts, items: sF.items }));

// ---------- G ----------
section("G. 回帰: 1台以上の見積もりは今までと同じ");
await seed([[cd("cG"), { status: 2, caseNumber: 807 }]]);
r = await call("staffCreateQuote", STAFF, { caseId: "cG", plan: "houmon", btQty: 2, usbQty: 1, btExtra: 1, usbExtra: 0, usbConnector: "C", sendMail: false });
const qG = await latestOf("cG");
const c = Pricing.computeAmounts("houmon", 2, 1, 1, 0);
const OLD = { readers: c.devSubsidyIncl, accompanyFee: c.accFeeIncl, discount: c.discount, subsidyPartTotal: c.subsidyPartTotal,
  extraPartTotal: c.extraPartTotal, totalIncl: c.totalIncl, grantAmt: c.grantAmt, selfPay: c.selfPay };
check("金額は今までの形と同じ（項目も値も・ownReaderIncl なし）", JSON.stringify(qG.amounts) === JSON.stringify(OLD), JSON.stringify(qG.amounts));
check("品目も今までどおり（BT 2+1・USB Type-C 1）", JSON.stringify(qG.items) === JSON.stringify(Pricing.buildItems({ btQty: 2, usbQty: 1, btExtra: 1, usbExtra: 0, usbConnector: "C" })));
r = await accept(qG.id);
const [sG] = await shipsOf("cG");
check("出荷は下書き・noGoods なし・自動の伴走支援費の行（補助対象3台）", sG.status === "draft" && !sG.noGoods && !sG.shipNotifyStatus
  && sG.items.some((i) => i.sku === "support-fee" && !i.manual && i.name === "接続サポート等経費（伴走支援費・補助対象3台）"), JSON.stringify(sG.items));
check("結果に noGoods は付かない", r.ok && !("noGoods" in r.r.results[0]));

console.log(results.join("\n"));
console.log(`\ntest-own-reader-emu: 合計 ${pass + fail} 件中 ${pass} 件合格・${fail} 件不合格`);
process.exit(fail ? 1 : 0);
