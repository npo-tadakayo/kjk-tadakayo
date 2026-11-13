// 伴走支援費の PM 値引き（2026-11-13）の Callable（setQuoteDiscount・setShipmentDiscount）と、
// reviseQuote・受注確定で値引きがどう扱われるかを、Firestore エミュレータに対して実際に動かして確かめる。
// 進め方は scripts/test-order-consent-emu.mjs と同じ（.run() で直接呼ぶ・本番に繋がらない demo- プロジェクト）。
//
//   A. 管理者以外（スタッフ）は拒否・何も書かない
//   B. 見積もりに値引き: 新しい版・前の版は superseded・金額は値引き後・記録（誰が・理由）・下書きの出荷に値引きの行・案件の金額・活動
//   C. 検査: 理由なし・標準額超え・同じ額は拒否／下限を下回る値引きは止めずに belowFloor と ⚠
//   D. 受注確定（staffAcceptQuote）で作る出荷に値引きの行と記録が入る
//   E. 台数を変える改版（reviseQuote）で値引きは外れ、活動に残る
//   F. 出荷に値引き: 請求済は拒否・認定事業者向けは拒否・入れ直しは置き換え（1行）・外す
//   G〜L（独立レビューの直し・2026-11-13）: 見積もりのある下書き・依頼済の出荷は拒否（中-1）／Web の申込で使い直す出荷の値引きは
//     黙って消さず記録（中-1）／記録の無い値引きは行を作らず記録（低-3）／承諾書の取り直しの印（中-3）／同時の値引きは1つだけ通る（中-2）／
//     下書きの出荷の前の値引きを「前の額」に（低-4）
//
// 実行: firebase emulators:exec --only firestore --project demo-pm-discount-test "node scripts/test-pm-discount-emu.mjs"
//   （bash scripts/test-all.sh の2段目でも動く）
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-pm-discount-test";
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
const PM = await import(path.join(FN_DIR, "pm-discount.mjs"));

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
const qd = (id) => db.collection("quotes").doc(id);
const cd = (id) => db.collection("cases").doc(id);
const sd = (id) => db.collection("shipments").doc(id);
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const actsOf = async (caseId) => (await db.collection("activities").where("caseId", "==", caseId).get()).docs.map((d) => d.data());
const quotesOf = async (caseId) => (await db.collection("quotes").where("caseId", "==", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const latestOf = async (caseId) => (await quotesOf(caseId)).sort((a, b) => b.version - a.version)[0];

// BT3台（houmon）: 機器 43,500 ＋ 伴走支援費 50,000 − 金額調整 29,500 ＝ 64,000。標準額 20,500
const calc = Pricing.computeAmounts("houmon", 3, 0, 0, 0);
const AMOUNTS = { readers: calc.devSubsidyIncl, accompanyFee: calc.accFeeIncl, discount: calc.discount, subsidyPartTotal: calc.subsidyPartTotal,
  extraPartTotal: calc.extraPartTotal, totalIncl: calc.totalIncl, grantAmt: calc.grantAmt, selfPay: calc.selfPay };
const ITEMS = [{ sku: Pricing.SKU.BT, connector: null, subsidyQty: 3, extraQty: 0 }];
function quote(caseId, o = {}) {
  return { caseId, caseNumber: 300, estNo: `EST-PM-${caseId}`, version: 1, status: "issued", plan: "houmon", planLabel: calc.plan.label,
    items: ITEMS, amounts: AMOUNTS, validUntil: TS.fromMillis(Date.now() + 10 * 86400000), contactEmail: "", contactName: "担当",
    officeName: `事業所${caseId}`, corpName: "法人", officeId: null, accessToken: "tok", createdAt: TS.now(), ...o };
}
async function seed(items) { const b = db.batch(); for (const [ref, d] of items) b.set(ref, d); await b.commit(); }

await seed([
  [db.collection("users").doc(STAFF), { active: true, role: "staff", name: "職員" }],
  [db.collection("users").doc(ADMIN), { active: true, role: "admin", name: "管理 太郎" }],
  [db.collection("_counters").doc("shipments"), { value: 500 }],
  [db.collection("appConfig").doc("settings"), { orderByConsent: false }],
]);

// ---------- A ----------
section("A. 管理者以外は拒否");
await seed([[cd("cA"), { status: 2, caseNumber: 301 }], [qd("qA"), quote("cA")]]);
let r = await call("setQuoteDiscount", STAFF, { quoteId: "qA", amount: 5500, reason: "x" });
check("スタッフは permission-denied", !r.ok && r.code === "permission-denied", JSON.stringify(r));
check("見積もりは変わらない", (await quotesOf("cA")).length === 1 && !(await get(qd("qA"))).amounts.pmDiscount);
r = await call("setShipmentDiscount", STAFF, { shipmentId: "none", amount: 5500, reason: "x" });
check("出荷もスタッフは permission-denied", !r.ok && r.code === "permission-denied");

// ---------- B ----------
section("B. 見積もりに値引き（下書きの出荷あり）");
await seed([
  [cd("cB"), { status: 3, caseNumber: 302, totalAmount: 64000, expectedSubsidyAmount: 64000 }],
  [qd("qB"), quote("cB", { status: "accepted", shipmentId: "sB", shipmentNo: "SH-PM-B" })],
  [sd("sB"), { soNumber: "SH-PM-B", status: "draft", shipType: "direct", caseId: "cB", quoteId: "qB",
    items: [{ sku: Pricing.SKU.BT, qty: 3, unitPrice: 14500 }, { sku: "support-fee", qty: 1, unitPrice: 50000, nonStock: true }, { sku: "discount", name: "金額調整", qty: 1, unitPrice: -29500, nonStock: true }] }],
]);
r = await call("setQuoteDiscount", ADMIN, { quoteId: "qB", amount: 5500, reason: "3事業所まとめて導入（PM判断）", sendMail: false });
check("通る", r.ok && r.r.ok && r.r.version === 2 && r.r.pmDiscount === 5500 && r.r.belowFloor === false, JSON.stringify(r).slice(0, 300));
const qB1 = await get(qd("qB")), qB2 = await latestOf("cB");
check("前の版は superseded", qB1.status === "superseded");
check("新しい版は accepted のまま・金額は値引き後", qB2.status === "accepted" && qB2.amounts.totalIncl === 58500 && qB2.amounts.grantAmt === 58500
  && qB2.amounts.selfPay === 0 && qB2.amounts.pmDiscount === 5500 && qB2.amounts.accompanyFee === 50000 && qB2.amounts.discount === 29500, JSON.stringify(qB2.amounts));
check("記録: 誰が・理由・標準額・時刻", qB2.pmDiscount && qB2.pmDiscount.byEmail === ADMIN && qB2.pmDiscount.byName === "管理 太郎"
  && qB2.pmDiscount.reason === "3事業所まとめて導入（PM判断）" && qB2.pmDiscount.standardFee === 20500 && qB2.pmDiscount.feeAfter === 15000
  && qB2.pmDiscount.belowFloor === false && qB2.pmDiscount.at instanceof TS, JSON.stringify(qB2.pmDiscount));
const sB = await get(sd("sB"));
const pmRowsB = (sB.items || []).filter((i) => i.pm === true);
check("下書きの出荷に値引きの行が1つ・記録も同じ", pmRowsB.length === 1 && pmRowsB[0].unitPrice === -5500 && pmRowsB[0].sku === "discount"
  && pmRowsB[0].name === PM.PM_DISCOUNT_NAME && sB.pmDiscount && sB.pmDiscount.amount === 5500 && sB.quoteId === qB2.id, JSON.stringify(sB.items));
check("出荷の明細の合計＝見積もりの合計", sB.items.reduce((a, i) => a + i.qty * i.unitPrice, 0) === 58500);
check("行と記録が合う（checkPmRows）", PM.checkPmRows(sB.items, sB.pmDiscount).ok);
const kB = await get(cd("cB"));
check("案件の合計・助成金も値引き後", kB.totalAmount === 58500 && kB.expectedSubsidyAmount === 58500 && kB.latestQuoteId === qB2.id);
const actB = (await actsOf("cB")).find((a) => /伴走支援費を値引き/.test(a.subject));
check("活動: 件名に額と標準→値引き後・本文に理由と判断者", actB && actB.subject.includes("¥5,500・標準 ¥20,500 → ¥15,000") && /理由: 3事業所/.test(actB.body) && /判断: 管理 太郎/.test(actB.body), JSON.stringify(actB));

// ---------- C ----------
section("C. 検査・下限");
r = await call("setQuoteDiscount", ADMIN, { quoteId: qB2.id, amount: 6000, reason: "" });
check("理由なしは拒否", !r.ok && r.code === "invalid-argument" && /理由/.test(r.msg));
r = await call("setQuoteDiscount", ADMIN, { quoteId: qB2.id, amount: 20501, reason: "x" });
check("標準額を超える値引きは拒否", !r.ok && /超えて/.test(r.msg));
r = await call("setQuoteDiscount", ADMIN, { quoteId: qB2.id, amount: 5500, reason: "x" });
check("同じ額は拒否", !r.ok && /同じ/.test(r.msg));
r = await call("setQuoteDiscount", ADMIN, { quoteId: "qB", amount: 1000, reason: "x" });
check("旧版には入れられない", !r.ok && /旧版/.test(r.msg));
r = await call("setQuoteDiscount", ADMIN, { quoteId: qB2.id, amount: 8000, reason: "特別な事情" });
check("下限を下回る値引きはサーバーでは止めない", r.ok && r.r.belowFloor === true, JSON.stringify(r).slice(0, 200));
const qB3 = await latestOf("cB");
check("値引きは置き換え（足さない）", qB3.amounts.pmDiscount === 8000 && qB3.amounts.totalIncl === 56000 && qB3.pmDiscount.belowFloor === true);
const sB3 = await get(sd("sB"));
check("出荷の値引きの行は1つのまま", sB3.items.filter((i) => i.pm).length === 1 && sB3.items.find((i) => i.pm).unitPrice === -8000);
const actB3 = (await actsOf("cB")).find((a) => /値引きを変更/.test(a.subject));
check("活動: 変更・⚠", actB3 && actB3.subject.startsWith("⚠ ") && actB3.subject.includes("¥5,500 → ¥8,000") && /下回ります/.test(actB3.body), JSON.stringify(actB3));

// ---------- D ----------
section("D. 受注確定で作る出荷に値引きの行と記録");
await seed([[cd("cD"), { status: 2, caseNumber: 304, officeName: "事業所D" }], [qd("qD"), quote("cD")]]);
r = await call("setQuoteDiscount", ADMIN, { quoteId: "qD", amount: 3000, reason: "D の値引き" });
check("見積もりに値引き", r.ok);
const qD2 = await latestOf("cD");
r = await call("staffAcceptQuote", STAFF, { quoteId: qD2.id, acceptedName: "山田", channel: "phone", receivedDate: TODAY, payMethod: "after", sendMail: false });
check("受注確定できる", r.ok && r.r.ok, JSON.stringify(r).slice(0, 300));
const shipD = (await db.collection("shipments").where("caseId", "==", "cD").get()).docs.map((d) => d.data())[0];
check("出荷の下書きに値引きの行・記録", shipD && shipD.items.filter((i) => i.pm).length === 1 && shipD.items.find((i) => i.pm).unitPrice === -3000
  && shipD.pmDiscount && shipD.pmDiscount.amount === 3000 && PM.checkPmRows(shipD.items, shipD.pmDiscount).ok, JSON.stringify(shipD && shipD.items));
check("出荷の明細の合計＝見積もりの値引き後の合計", shipD.items.reduce((a, i) => a + i.qty * i.unitPrice, 0) === 61000);

// ---------- E ----------
section("E. 台数を変える改版で値引きは外れる");
r = await call("reviseQuote", STAFF, { quoteId: qB3.id, plan: "houmon", btQty: 2, usbQty: 0, btExtra: 0, usbExtra: 0, reason: "台数を2台に", sendMail: false });
check("改版できる", r.ok && r.r.pmDiscountRemoved === 8000, JSON.stringify(r).slice(0, 300));
const qB4 = await latestOf("cB");
check("新しい版に値引きは無い", !qB4.amounts.pmDiscount && !qB4.pmDiscount && qB4.amounts.totalIncl === Pricing.computeAmounts("houmon", 2, 0, 0, 0).totalIncl);
const sB4 = await get(sd("sB"));
check("下書きの出荷からも値引きの行と記録が消える", !sB4.items.some((i) => i.pm) && !sB4.pmDiscount);
const actB4 = (await actsOf("cB")).find((a) => /見積もりを変更/.test(a.subject) && /値引き（¥8,000）は外れました/.test(a.body));
check("活動に「値引きは外れました」", !!actB4);

// ---------- F ----------
section("F. 出荷に値引き");
const baseItems = [{ sku: Pricing.SKU.BT, qty: 1, unitPrice: 14500 }, { sku: "support-fee", qty: 1, unitPrice: 60000, nonStock: true }, { sku: "discount", name: "金額調整", qty: 1, unitPrice: -10500, nonStock: true }];
await seed([
  [cd("cF"), { status: 5, caseNumber: 306 }],
  [sd("sF"), { soNumber: "SH-PM-F", status: "shipped", shipType: "direct", caseId: "cF", items: baseItems }],
  [sd("sFi"), { soNumber: "SH-PM-Fi", status: "invoiced", shipType: "direct", caseId: "cF", items: baseItems }],
  [sd("sFd"), { soNumber: "SH-PM-Fd", status: "shipped", shipType: "dropship", partnerEmail: "p@example.jp", caseId: "cF", items: baseItems }],
  [sd("sFn"), { soNumber: "SH-PM-Fn", status: "shipped", shipType: "direct", caseId: "cF", items: [{ sku: Pricing.SKU.BT, qty: 1, unitPrice: 14500 }] }],
]);
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sFi", amount: 1000, reason: "x" });
check("請求済は拒否", !r.ok && r.code === "failed-precondition" && /請求書を出す前/.test(r.msg));
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sFd", amount: 1000, reason: "x" });
check("認定事業者向けは拒否", !r.ok && /事業所向け/.test(r.msg));
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sFn", amount: 1000, reason: "x" });
check("伴走支援費の行が無い出荷は拒否", !r.ok && /標準額|伴走支援費/.test(r.msg));
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sF", amount: 4500, reason: "出荷で値引き" });
check("発送済の出荷に入れられる", r.ok && r.r.pmDiscount === 4500 && r.r.standardFee === 49500 && r.r.belowFloor === false, JSON.stringify(r).slice(0, 200));
let sF = await get(sd("sF"));
check("行1つ・記録・合計", sF.items.filter((i) => i.pm).length === 1 && sF.pmDiscount.amount === 4500 && sF.pmDiscount.byEmail === ADMIN
  && sF.items.reduce((a, i) => a + i.qty * i.unitPrice, 0) === 64000 - 4500);
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sF", amount: 6000, reason: "額を直す" });
sF = await get(sd("sF"));
check("入れ直しは置き換え（1行）", r.ok && sF.items.filter((i) => i.pm).length === 1 && sF.items.find((i) => i.pm).unitPrice === -6000 && sF.pmDiscount.amount === 6000);
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sF", remove: true, reason: "取り消し" });
sF = await get(sd("sF"));
check("外すと行も記録も無くなる", r.ok && !sF.items.some((i) => i.pm) && !sF.pmDiscount && sF.items.length === 3);
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sF", remove: true, reason: "もう一度" });
check("値引きの無い出荷を外すのは拒否", !r.ok);
const actsF = (await actsOf("cF")).map((a) => a.subject);
check("活動: 入れた・変えた・外した の3件", actsF.filter((s) => /伴走支援費/.test(s)).length === 3
  && actsF.some((s) => s.startsWith("伴走支援費を値引き（¥4,500")) && actsF.some((s) => /値引きを変更（¥4,500 → ¥6,000/.test(s)) && actsF.some((s) => /値引きを外した（¥6,000）/.test(s)), JSON.stringify(actsF));

// HTTP の関数（acceptQuote）を直接呼ぶ（要求・応答の代役。test-order-consent-web-emu.mjs と同じ）
function http(name, body) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "user-agent": "TestUA", origin: "https://kjk.tadakayo.jp" };
    const req = { method: "POST", body, headers, url: "/", originalUrl: "/", path: "/",
      get: (h) => headers[String(h).toLowerCase()], header: (h) => headers[String(h).toLowerCase()] };
    const done = (o) => { resolve({ status: res.statusCode, body: o }); res.headersSent = true; res.emit("finish"); };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, _h: {}, headersSent: false,
      setHeader(k, v) { this._h[String(k).toLowerCase()] = v; }, getHeader(k) { return this._h[String(k).toLowerCase()]; },
      removeHeader(k) { delete this._h[String(k).toLowerCase()]; }, set(k, v) { this.setHeader(k, v); return this; }, vary() { return this; },
      status(c) { this.statusCode = c; return this; }, json(o) { done(o); return this; }, send(o) { done(o); return this; }, end(o) { done(o ?? null); return this; },
    });
    Promise.resolve(fns[name](req, res)).catch(reject);
  });
}
const DELIVERY = { company: "法人", officeName: "事業所H", postalCode: "100-0001", address: "東京都千代田区1-1", contactName: "受取", phone: "03-0000-0000" };

// ---------- G ----------
section("G. 見積もりのある下書き・依頼済の出荷には出荷で入れない（中-1）");
await seed([
  [cd("cG"), { status: 3, caseNumber: 307 }],
  [sd("sGd"), { soNumber: "SH-PM-Gd", status: "draft", shipType: "direct", caseId: "cG", quoteId: "qX", items: baseItems }],
  [sd("sGr"), { soNumber: "SH-PM-Gr", status: "requested", shipType: "direct", caseId: "cG", quoteId: "qX", items: baseItems }],
  [sd("sGs"), { soNumber: "SH-PM-Gs", status: "shipped", shipType: "direct", caseId: "cG", quoteId: "qX", items: baseItems }],
]);
for (const id of ["sGd", "sGr"]) {
  r = await call("setShipmentDiscount", ADMIN, { shipmentId: id, amount: 1000, reason: "x" });
  check(`${id}: 拒否して見積もりカードへ案内`, !r.ok && r.code === "failed-precondition" && r.msg === PM.MSG_USE_QUOTE, JSON.stringify(r));
  check(`${id}: 何も書かない`, !(await get(sd(id))).items.some((i) => i.pm));
}
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sGs", amount: 1000, reason: "発送済なので出荷で" });
check("見積もりのある出荷でも発送済なら出荷に入れられる", r.ok);

// ---------- H ----------
section("H. Web の申込で使い直す出荷の値引きは黙って消さない（中-1）");
await db.collection("appConfig").doc("settings").set({ orderByConsent: false }, { merge: true });
await seed([
  [cd("cH"), { status: 2, caseNumber: 308, officeName: "事業所H", shipmentId: "sH" }],
  [qd("qH"), quote("cH", { accessToken: "tok-qH" })],
  [sd("sH"), { soNumber: "SH-PM-H", status: "draft", shipType: "direct", caseId: "cH", items: baseItems }], // 見積もりの無い手作りの下書き
]);
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sH", amount: 2000, reason: "手作りの出荷で値引き" });
check("見積もりの無い下書きには入れられる", r.ok);
r = await http("acceptQuote", { quoteId: "qH", quoteToken: "tok-qH", agreedName: "申込 太郎", agreedPolicy: true, payMethod: "after", delivery: DELIVERY });
check("Web の申込が通る", r.status === 200 && r.body.status === "ok", JSON.stringify(r).slice(0, 300));
const sH = await get(sd("sH"));
check("使い直した出荷は見積もりの明細（値引きの行と記録は外れる）", !sH.items.some((i) => i.pm) && !sH.pmDiscount && sH.quoteId === "qH", JSON.stringify(sH.items));
const actH = (await actsOf("cH")).find((a) => /値引きが出荷に引き継がれませんでした/.test(a.subject));
check("対応記録に「外れました」と額", actH && /¥2,000/.test(actH.body) && /外れました/.test(actH.body), JSON.stringify(actH));

// ---------- I ----------
section("I. 記録の無い値引きは出荷に行を作らない（低-3）");
const amtsI = PM.applyToAmounts(AMOUNTS, 4000);
await seed([[cd("cI"), { status: 2, caseNumber: 309 }], [qd("qI"), quote("cI", { amounts: amtsI })]]); // pmDiscount の記録なし
r = await call("staffAcceptQuote", STAFF, { quoteId: "qI", acceptedName: "山田", channel: "phone", receivedDate: TODAY, payMethod: "after", sendMail: false });
check("受注確定できる", r.ok && r.r.ok, JSON.stringify(r).slice(0, 300));
const shipI = (await db.collection("shipments").where("caseId", "==", "cI").get()).docs.map((d) => d.data())[0];
check("値引きの行も記録も無い", shipI && !shipI.items.some((i) => i.pm) && !shipI.pmDiscount);
const actI = (await actsOf("cI")).find((a) => /値引きが出荷に引き継がれませんでした/.test(a.subject));
check("対応記録に「記録が無いため引き継がれません」", actI && /記録（判断した人・理由）が無いため出荷に引き継がれません/.test(actI.body), JSON.stringify(actI));

// ---------- J ----------
section("J. 承諾書のある案件の出荷に値引き → 取り直しの印（中-3）");
await seed([
  [cd("cJ"), { status: 5, caseNumber: 310, orderConsentToken: "tokJ", orderConsentStale: false }],
  [sd("sJ"), { soNumber: "SH-PM-J", status: "shipped", shipType: "direct", caseId: "cJ", items: baseItems }],
  [cd("cJ2"), { status: 5, caseNumber: 311, orderConsentToken: "tokJ2", orderConsentStale: true, orderConsentStaleReason: "ship_canceled" }],
  [sd("sJ2"), { soNumber: "SH-PM-J2", status: "shipped", shipType: "direct", caseId: "cJ2", items: baseItems }],
  [cd("cJ3"), { status: 5, caseNumber: 312 }],
  [sd("sJ3"), { soNumber: "SH-PM-J3", status: "shipped", shipType: "direct", caseId: "cJ3", items: baseItems }],
]);
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sJ", amount: 3000, reason: "x" });
const kJ = await get(cd("cJ"));
check("印が立つ", r.ok && r.r.orderConsentStale === true && kJ.orderConsentStale === true, JSON.stringify(kJ));
check("活動に取り直しの案内", (await actsOf("cJ")).some((a) => /承諾書の取り直しが要ります/.test(a.body)));
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sJ2", amount: 3000, reason: "x" });
const kJ2 = await get(cd("cJ2"));
check("出荷キャンセルの理由はそのまま", r.ok && kJ2.orderConsentStale === true && kJ2.orderConsentStaleReason === "ship_canceled");
r = await call("setShipmentDiscount", ADMIN, { shipmentId: "sJ3", amount: 3000, reason: "x" });
const kJ3 = await get(cd("cJ3"));
check("承諾書の無い案件には印を足さない", r.ok && !("orderConsentStale" in kJ3) && !("orderConsentStale" in r.r));

// ---------- K ----------
section("K. 同時の値引きは1つだけ通る（トランザクション・中-2）");
await seed([[cd("cK"), { status: 2, caseNumber: 313 }], [qd("qK"), quote("cK")]]);
const [k1, k2] = await Promise.all([
  call("setQuoteDiscount", ADMIN, { quoteId: "qK", amount: 1000, reason: "1つめ" }),
  call("setQuoteDiscount", ADMIN, { quoteId: "qK", amount: 2000, reason: "2つめ" }),
]);
const qsK = await quotesOf("cK");
check("片方だけ通る", [k1, k2].filter((x) => x.ok).length === 1, JSON.stringify([k1, k2]).slice(0, 300));
check("版は2つ（v1 superseded・v2 だけ生きている）", qsK.length === 2 && qsK.filter((q) => q.status === "issued").length === 1 && qsK.find((q) => q.version === 1).status === "superseded");
const failedK = [k1, k2].find((x) => !x.ok);
check("負けた方は旧版の理由で止まる", failedK && /旧版/.test(failedK.msg), JSON.stringify(failedK));

// ---------- L ----------
section("L. 下書きの出荷の前の値引きを「前の額」に（低-4）");
await seed([
  [cd("cL"), { status: 3, caseNumber: 314 }],
  [qd("qL"), quote("cL", { status: "accepted", shipmentId: "sL", shipmentNo: "SH-PM-L" })],
  [sd("sL"), { soNumber: "SH-PM-L", status: "draft", shipType: "direct", caseId: "cL", quoteId: "qL",
    items: [{ sku: Pricing.SKU.BT, qty: 3, unitPrice: 14500 }, { sku: "support-fee", qty: 1, unitPrice: 50000, nonStock: true }, { sku: "discount", name: "金額調整", qty: 1, unitPrice: -29500, nonStock: true }, PM.pmDiscountRow(2000)],
    pmDiscount: { amount: 2000, reason: "前からの値引き" } }],
]);
r = await call("setQuoteDiscount", ADMIN, { quoteId: "qL", amount: 3000, reason: "見積もりで入れ直す" });
check("通る", r.ok, JSON.stringify(r).slice(0, 200));
const actL = (await actsOf("cL")).find((a) => /伴走支援費/.test(a.subject));
check("活動の件名は「¥2,000 → ¥3,000」の変更", actL && actL.subject.includes("値引きを変更（¥2,000 → ¥3,000"), JSON.stringify(actL));
const sL = await get(sd("sL"));
check("出荷の値引きの行は1つ（¥3,000）", sL.items.filter((i) => i.pm).length === 1 && sL.items.find((i) => i.pm).unitPrice === -3000 && sL.pmDiscount.amount === 3000);

console.log(results.join("\n"));
console.log(`\ntest-pm-discount-emu: 合計 ${pass + fail} 件中 ${pass} 件合格・${fail} 件不合格`);
process.exit(fail ? 1 : 0);
