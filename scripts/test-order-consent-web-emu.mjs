// 承諾書のサイン＝発注 第2段（Web の道・2026-11-12）を、Firestore エミュレータに対して実際に動かして確かめる。
// 設計: 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md §4 段2・§7。進め方は scripts/test-order-consent-emu.mjs と同じ
// （関数を直接呼ぶ。acceptQuote・webhookMitsumori は HTTP の関数なので、要求と応答の代役を渡す）。
//
// 確かめること
//   A. スイッチがオフ: acceptQuote（1件・まとめ）と webhookMitsumori は今までどおり（承諾書の記録なし・応答に承諾書の項目なし・
//      consent を送っても使わない）。ORDER_EMU_DUMP を渡すと書き込みと応答を書き出す（main の functions と突き合わせる）
//   B. スイッチがオン: 同意（consent）が無い・版が違う・名前が無い → 拒否し、何も書かない
//   C. スイッチがオン: 承諾書の記録（kind order・web_order・署名者名・サーバー時刻・userAgent・条文 v1.2 全文・見積もりの焼き込み）と
//      受注確定（accepted・consent_web・出荷の下書き・状態3）が同時に入る。応答に承諾書のアドレス。二重送信は already（2件目を作らない）
//   D. まとめ見積もり: 承諾書1件に全事業所。1回で全部が受注確定
//   E. まとめの1件が期限切れ → どれも受注確定にならず、承諾書も無い（番号も進まない）
//   F. 古い版（superseded・新しい版がある）・鍵（quoteToken）違い → 拒否
//   G. webhookMitsumori（スイッチがオン）: 応答に orderByConsent・条文 v1.2 の全文・各見積もりの「承諾書に焼き込む形」
//
// 実行（本番に繋がらない demo- プロジェクト。依存は functions/node_modules）:
//   cd <repo> && firebase emulators:exec --only firestore --project demo-order-consent-web-test "node scripts/test-order-consent-web-emu.mjs"
//   （bash scripts/test-all.sh の2段目でも動く）
// 比較用: ORDER_EMU_FUNCTIONS_DIR=<main の functions> ORDER_EMU_DUMP=<出力.json> で A だけを動かして書き出す。
// 終了コード: 全部合格 0、1件でも不合格 1。
import { createRequire } from "node:module";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-order-consent-web-test";
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";
const HOOK = "https://chat.example.test/hook";
const posted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, opts);
  if (u === HOOK) { posted.push(JSON.parse(opts.body)); return new Response("{}", { status: 200 }); }
  return new Response("blocked in test", { status: 503 });
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = process.env.ORDER_EMU_FUNCTIONS_DIR ? path.resolve(process.env.ORDER_EMU_FUNCTIONS_DIR) : path.join(REPO, "functions");
const DUMP = process.env.ORDER_EMU_DUMP || "";
const require = createRequire(path.join(FN_DIR, "index.js"));
const fns = require(path.join(FN_DIR, "index.js"));
const admin = require("firebase-admin");
const db = admin.firestore();
await db.collection("_probe").limit(1).get(); // 先に Firestore（エミュレータ）につないでおく
// メールは送らない: Gmail の鍵を取りに行く GoogleAuth が手元の認証情報を拾わないよう、存在しない鍵のファイルを指す（Admin SDK を初期化したあとで差し替える）
// （確認メールは「送れなかった」としてログに出るだけ。応答・書き込みには影響しない）
process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nonexistent/kjk-test-no-credentials.json";
const TS = admin.firestore.Timestamp;

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); console.error(`... ${t}`); }

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TestUA";
// HTTP の関数を直接呼ぶ（要求・応答の代役）
function http(name, body) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "user-agent": UA, origin: "https://kjk.tadakayo.jp" };
    const req = {
      method: "POST", body, headers, url: "/", originalUrl: "/", path: "/",
      get: (h) => headers[String(h).toLowerCase()], header: (h) => headers[String(h).toLowerCase()],
    };
    const done = (o) => { resolve({ status: res.statusCode, body: o }); res.headersSent = true; res.emit("finish"); };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, _h: {}, headersSent: false,
      setHeader(k, v) { this._h[String(k).toLowerCase()] = v; }, getHeader(k) { return this._h[String(k).toLowerCase()]; },
      removeHeader(k) { delete this._h[String(k).toLowerCase()]; }, set(k, v) { this.setHeader(k, v); return this; },
      vary() { return this; },
      status(c) { this.statusCode = c; return this; },
      json(o) { done(o); return this; },
      send(o) { done(o); return this; },
      end(o) { done(o ?? null); return this; },
    });
    Promise.resolve(fns[name](req, res)).catch(reject);
  });
}
const get = async (ref) => { const s = await ref.get(); return s.exists ? s.data() : null; };
const qd = (id) => db.collection("quotes").doc(id);
const cd = (id) => db.collection("cases").doc(id);
const counter = async () => ((await get(db.collection("_counters").doc("shipments"))) || {}).value || 0;
const setSwitch = (on) => db.collection("appConfig").doc("settings").set({ orderByConsent: on, chatWebhookUrl: HOOK }, { merge: true });
const consentsOf = async (caseId) => (await db.collection("consentRequests").where("caseIds", "array-contains", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const allConsents = async () => (await db.collection("consentRequests").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const shipsOf = async (caseId) => (await db.collection("shipments").where("caseId", "==", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const actsOf = async (caseId) => (await db.collection("activities").where("caseId", "==", caseId).get()).docs.map((d) => d.data());

const AMOUNTS = { readers: 46200, accompanyFee: 33000, discount: 0, subsidyPartTotal: 79200, extraPartTotal: 0, totalIncl: 79200, grantAmt: 64000, selfPay: 15200 };
function quote(id, caseId, o = {}) {
  return {
    caseId, caseNumber: o.caseNumber || 100, estNo: o.estNo || `EST-W-${id}`, version: 1, status: "issued",
    plan: "houmon", planLabel: "訪問系", items: [{ sku: "cir415a-01", connector: null, subsidyQty: 2, extraQty: 0 }], amounts: AMOUNTS,
    validUntil: TS.fromMillis(Date.now() + 10 * 86400000), contactEmail: "", contactName: "担当 花子",
    officeName: o.officeName || `事業所${id}`, corpName: "テスト法人", officeId: null, accessToken: "tok-" + id,
    createdVia: "web", createdAt: TS.now(), ...o,
  };
}
async function seed(items) { const b = db.batch(); for (const [ref, d] of items) b.set(ref, d); await b.commit(); }
const DELIVERY = { company: "テスト法人", officeName: "事業所", postalCode: "100-0001", address: "東京都千代田区1-1", contactName: "担当", phone: "0300000000" };
const webBody = (quoteId, o = {}) => ({
  quoteId, quoteToken: "tok-" + quoteId, agreedName: "申込 太郎", agreedPolicy: true, payMethod: "after",
  preferredDate: "11月下旬", note: "テスト", delivery: DELIVERY, ...o,
});

// 時刻・ID を伏せて並べ直す（main との比較用）
const MASK = new Set(["caseId", "quoteId", "quoteToken", "groupId", "officeId", "shipmentId", "accessToken", "validUntil", "leadToken", "supersedes"]);
function norm(v, k = "") {
  if (v == null) return v;
  if (MASK.has(k) && typeof v === "string") return "<id>";
  if (v instanceof TS || (typeof v.toMillis === "function")) return "<ts>";
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, norm(v[kk], kk)]));
  return v;
}

await seed([[db.collection("_counters").doc("shipments"), { value: 300 }]]);

// ---------- A. スイッチがオフ ----------
section("A. スイッチがオフ: 今までどおり");
await setSwitch(false);
await seed([
  [cd("wA"), { status: 2, caseNumber: 701, officeName: "事業所A", contactEmail: "" }], [qd("wqA"), quote("wqA", "wA", { caseNumber: 701 })],
  [cd("wG1"), { status: 2, caseNumber: 702 }], [qd("wqG1"), quote("wqG1", "wG1", { caseNumber: 702, groupId: "GRP-A", groupIndex: 0, groupSize: 2 })],
  [cd("wG2"), { status: 1, caseNumber: 703 }], [qd("wqG2"), quote("wqG2", "wG2", { caseNumber: 703, groupId: "GRP-A", groupIndex: 1, groupSize: 2 })],
]);
const cA0 = await counter();
posted.length = 0;
// オフのときは consent を送っても使わない
let r = await http("acceptQuote", webBody("wqA", { consent: { agreed: true, version: "1.2" } }));
check("1件: 200 ok", r.status === 200 && r.body.status === "ok", JSON.stringify(r));
check("1件: 応答に承諾書のアドレスが無い", !("consentUrl" in r.body));
const rA1 = r.body;
const qA = await get(qd("wqA")), kA = await get(cd("wA"));
check("1件: 見積もりは accepted・acceptedVia web・consentToken なし", qA.status === "accepted" && qA.acceptedVia === "web" && !("consentToken" in qA));
check("1件: 案件は 3・承諾書の項目なし", kA.status === 3 && !("orderConsentToken" in kA));
r = await http("acceptQuote", { quotes: [{ quoteId: "wqG1", quoteToken: "tok-wqG1" }, { quoteId: "wqG2", quoteToken: "tok-wqG2" }],
  deliveryMode: "each", payMethod: "before", agreedName: "まとめ 花子", agreedPolicy: true, preferredDate: "", note: "" });
check("まとめ: 200 ok（2件）", r.status === 200 && r.body.status === "ok" && r.body.results.length === 2, JSON.stringify(r));
const rA2 = r.body;
check("承諾書の記録は作らない", (await allConsents()).length === 0);
check("出荷は3件・番号は3つ進む", (await shipsOf("wA")).length + (await shipsOf("wG1")).length + (await shipsOf("wG2")).length === 3 && (await counter()) === cA0 + 3);
const actA = await actsOf("wA");
check("対応記録は従来の件名（お申し込みを受け付けました）", actA.length === 1 && actA[0].subject.startsWith("お申し込みを受け付けました"), JSON.stringify(actA.map((a) => a.subject)));
const chatA = posted.map((p) => p.text || "");
check("Chat は従来の見出し", chatA.length === 2 && chatA[0].startsWith("🎉 お申し込みを受け付けました") && chatA[1].startsWith("🛒 お申し込み（2事業所"), JSON.stringify(chatA).slice(0, 300));
// 二重送信は already（従来どおり）
r = await http("acceptQuote", webBody("wqA"));
check("同じ見積もりの再送は already", r.status === 200 && r.body.status === "already", JSON.stringify(r));
const rA3 = r.body;
// 見積もりの登録の応答に承諾書の項目が無い
const wmBody = { officeName: "見積事業所W", email: "w1@example.test", corpName: "見積法人", contactName: "見積 太郎", phone: "0311112222",
  postalCode: "1000001", prefecture: "東京都", city: "千代田区", addressDetail: "1-1", subsidyCategory: "houmon",
  btSubsidyQty: 2, usbSubsidyQty: 1, btExtraQty: 0, usbExtraQty: 1, usbConnector: "C", intent: "order" };
r = await http("webhookMitsumori", wmBody);
check("見積もりの登録（1件）: 応答に承諾書の項目が無い", r.status === 200 && r.body.status === "ok" && !("orderByConsent" in r.body) && !("consentDocument" in r.body) && !("consentEntry" in r.body), JSON.stringify(r).slice(0, 300));
const rA4 = r.body;
r = await http("webhookMitsumori", { email: "w2@example.test", corpName: "見積法人2", contactName: "見積 次郎", phone: "0311113333",
  offices: [
    { officeName: "まとめ事業所1", subsidyCategory: "houmon", btSubsidyQty: 1, usbSubsidyQty: 0, btExtraQty: 0, usbExtraQty: 0, prefecture: "東京都", city: "港区", addressDetail: "1" },
    { officeName: "まとめ事業所2", subsidyCategory: "kyojyu", btSubsidyQty: 0, usbSubsidyQty: 2, btExtraQty: 0, usbExtraQty: 0, usbConnector: "A", prefecture: "東京都", city: "港区", addressDetail: "2" },
  ] });
check("見積もりの登録（まとめ）: 応答に承諾書の項目が無い", r.status === 200 && r.body.status === "ok" && !("orderByConsent" in r.body)
  && r.body.quotes.every((q) => !("consentEntry" in q)), JSON.stringify(r).slice(0, 300));
const rA5 = r.body;
if (DUMP) {
  const dump = {
    responses: [rA1, rA2, rA3, rA4, rA5],
    quotes: { wqA: await get(qd("wqA")), wqG1: await get(qd("wqG1")), wqG2: await get(qd("wqG2")) },
    cases: { wA: await get(cd("wA")), wG1: await get(cd("wG1")), wG2: await get(cd("wG2")) },
    ships: (await Promise.all(["wA", "wG1", "wG2"].map(shipsOf))).map((l) => l.map(({ id, ...x }) => x)),
    acts: await Promise.all(["wA", "wG1", "wG2"].map(actsOf)),
    chat: chatA, consents: await allConsents(), counterDelta: (await counter()) - cA0,
  };
  writeFileSync(DUMP, JSON.stringify(norm(dump), null, 2));
  console.log(`dumped: ${DUMP}`);
  console.log(results.join("\n"));
  console.log(`\n合計: ${pass}/${pass + fail} 合格`);
  process.exit(fail ? 1 : 0);
}

const CD = require(path.join(FN_DIR, "consent-document.js"));
const R = require(path.join(FN_DIR, "accept-rules.js"));
const plain = (o) => JSON.parse(JSON.stringify(o));

// ---------- B. スイッチがオン・同意なし ----------
section("B. スイッチがオン: 同意が無ければ拒否");
await setSwitch(true);
await seed([[cd("wB"), { status: 2, caseNumber: 711, officeName: "事業所B" }], [qd("wqB"), quote("wqB", "wB", { caseNumber: 711 })]]);
const cB0 = await counter();
r = await http("acceptQuote", webBody("wqB"));
check("consent が無い → 400 consent_required", r.status === 400 && r.body.code === "consent_required", JSON.stringify(r));
r = await http("acceptQuote", webBody("wqB", { consent: { agreed: false, version: "1.2" } }));
check("agreed が true でない → 400 consent_required", r.status === 400 && r.body.code === "consent_required", JSON.stringify(r));
r = await http("acceptQuote", webBody("wqB", { consent: { agreed: true, version: "1.1" } }));
check("版が違う → 400 consent_version_mismatch", r.status === 400 && r.body.code === "consent_version_mismatch", JSON.stringify(r));
r = await http("acceptQuote", webBody("wqB", { agreedName: "  ", consent: { agreed: true, version: "1.2" } }));
check("名前が空 → 400", r.status === 400 && r.body.status === "error", JSON.stringify(r));
r = await http("acceptQuote", { quotes: [{ quoteId: "wqB", quoteToken: "tok-wqB" }], agreedName: "x", payMethod: "after" });
check("まとめの形でも consent が無ければ拒否", r.status === 400 && r.body.code === "consent_required", JSON.stringify(r));
check("拒否したあと、何も変わっていない", (await get(qd("wqB"))).status === "issued" && (await get(cd("wB"))).status === 2
  && (await shipsOf("wB")).length === 0 && (await consentsOf("wB")).length === 0 && (await counter()) === cB0);

// ---------- C. スイッチがオン・1件 ----------
section("C. スイッチがオン: 承諾書の記録と受注確定が同時に入る（1件）");
posted.length = 0;
r = await http("acceptQuote", webBody("wqB", { agreedName: "  同意 一郎  ", payMethod: "before", consent: { agreed: true, version: "1.2" } }));
check("200 ok", r.status === 200 && r.body.status === "ok", JSON.stringify(r));
const urlC = r.body.consentUrl || "";
const tokC = (/consent\?t=([0-9a-f]{32})$/.exec(urlC) || [])[1] || "";
check("応答の consentUrl は管理画面の /consent?t=（128bit）", urlC.startsWith("https://kjk-tadakayo-admin.web.app/consent?t=") && !!tokC, urlC);
const recC = await get(db.collection("consentRequests").doc(tokC));
check("承諾書: kind order・status signed", recC && recC.kind === "order" && recC.status === "signed");
check("承諾書: signed.method web_order・署名者名（前後の空白なし）・サーバー時刻・userAgent",
  recC.signed.method === "web_order" && recC.signed.name === "同意 一郎" && recC.signed.signedAt instanceof TS && recC.signed.userAgent === UA
  && !("receivedDate" in recC.signed) && !("recordedBy" in recC.signed), JSON.stringify(recC.signed));
check("承諾書: 条文 v1.2 の全文", JSON.stringify(plain(recC.document)) === JSON.stringify(plain(CD.CONSENT_V1_2)));
check("承諾書: 見積もりの焼き込み（見積番号・版・事業所・品目・金額）", recC.quotes.length === 1 && recC.quotes[0].estNo === "EST-W-wqB"
  && recC.quotes[0].version === 1 && recC.quotes[0].officeName === "事業所wqB" && recC.quotes[0].items[0].subsidyQty === 2
  && recC.quotes[0].amounts.totalIncl === 79200 && recC.totalIncl === 79200);
check("承諾書: createdVia acceptQuote・createdBy web", recC.createdVia === "acceptQuote" && /^web/.test(recC.createdBy));
const qB = await get(qd("wqB")), kB = await get(cd("wB"));
check("見積もり: accepted・acceptedVia consent_web・consentToken・agreedPolicy true",
  qB.status === "accepted" && qB.acceptedVia === "consent_web" && qB.consentToken === tokC && qB.agreedPolicy === true && qB.acceptedBy === "同意 一郎");
check("案件: 3・orderConsentToken・orderConsentAt・orderConsentStale false・受注日・orderedVia web",
  kB.status === 3 && kB.orderConsentToken === tokC && kB.orderConsentAt instanceof TS && kB.orderConsentStale === false
  && kB.orderedAt instanceof TS && kB.orderedVia === "web");
check("出荷の下書きが1件・番号が1つ進む", (await shipsOf("wB")).length === 1 && (await counter()) === cB0 + 1);
const actB = await actsOf("wB");
check("対応記録: 承諾書にオンラインで同意・承諾書の番号", actB.length === 1 && actB[0].subject.startsWith("承諾書にオンラインで同意いただき、受注確定にしました")
  && actB[0].body.includes(recC.displayNo) && actB[0].body.includes("条文の版 1.2"), JSON.stringify(actB).slice(0, 300));
check("Chat: ご発注（承諾書への同意）・承諾書の番号・署名者名は載せない", posted.length === 1 && posted[0].text.startsWith("🎉 ご発注（承諾書への同意）を受け付けました")
  && posted[0].text.includes(recC.displayNo) && !posted[0].text.includes("同意 一郎"), JSON.stringify(posted).slice(0, 300));
// 二重送信
r = await http("acceptQuote", webBody("wqB", { consent: { agreed: true, version: "1.2" } }));
check("再送は already・同じ承諾書のアドレス・2件目を作らない", r.status === 200 && r.body.status === "already" && r.body.consentUrl === urlC
  && (await consentsOf("wB")).length === 1 && (await shipsOf("wB")).length === 1, JSON.stringify(r));

// ---------- D. まとめ見積もり ----------
section("D. まとめ見積もり: 承諾書1件・全事業所を受注確定");
await seed([
  [cd("wD1"), { status: 2, caseNumber: 721 }], [qd("wqD1"), quote("wqD1", "wD1", { caseNumber: 721, groupId: "GRP-D", officeName: "まとめD1" })],
  [cd("wD2"), { status: 1, caseNumber: 722 }], [qd("wqD2"), quote("wqD2", "wD2", { caseNumber: 722, groupId: "GRP-D", officeName: "まとめD2",
    items: [{ sku: "cir315a-04", connector: "C", subsidyQty: 1, extraQty: 1 }] })],
]);
const cD0 = await counter();
posted.length = 0;
r = await http("acceptQuote", { quotes: [{ quoteId: "wqD1", quoteToken: "tok-wqD1" }, { quoteId: "wqD2", quoteToken: "tok-wqD2" }],
  deliveryMode: "single", delivery: DELIVERY, payMethod: "after", agreedName: "まとめ 同意", agreedPolicy: true, consent: { agreed: true, version: "1.2" } });
check("200 ok・2件", r.status === 200 && r.body.status === "ok" && r.body.results.length === 2, JSON.stringify(r));
const tokD = (/t=([0-9a-f]{32})$/.exec(r.body.consentUrl || "") || [])[1];
const recD = await get(db.collection("consentRequests").doc(tokD || "x"));
check("承諾書1件に2事業所・グループ・合計", recD && recD.quotes.length === 2 && recD.quoteGroupId === "GRP-D" && recD.caseIds.join(",") === "wD1,wD2"
  && recD.totalIncl === 79200 * 2 && /-G2$/.test(recD.displayNo), JSON.stringify(recD || {}).slice(0, 300));
check("2件とも accepted・同じ consentToken", (await get(qd("wqD1"))).consentToken === tokD && (await get(qd("wqD2"))).consentToken === tokD
  && (await get(qd("wqD2"))).acceptedVia === "consent_web");
check("2件とも案件は 3・同じ orderConsentToken", (await get(cd("wD1"))).status === 3 && (await get(cd("wD2"))).orderConsentToken === tokD);
check("出荷は2件・番号は2つ進む・お届け先は1か所", (await shipsOf("wD1")).length === 1 && (await shipsOf("wD2")).length === 1 && (await counter()) === cD0 + 2);
check("Chat は1通（まとめ）", posted.length === 1 && posted[0].text.startsWith("🛒 ご発注（承諾書への同意・2事業所"), JSON.stringify(posted).slice(0, 200));

// ---------- E. まとめの1件が期限切れ ----------
section("E. まとめの1件が通らない → どれも入らない");
await seed([
  [cd("wE1"), { status: 2, caseNumber: 731 }], [qd("wqE1"), quote("wqE1", "wE1", { caseNumber: 731, groupId: "GRP-E" })],
  [cd("wE2"), { status: 2, caseNumber: 732 }], [qd("wqE2"), quote("wqE2", "wE2", { caseNumber: 732, groupId: "GRP-E", validUntil: TS.fromMillis(Date.now() - 86400000) })],
]);
const cE0 = await counter();
r = await http("acceptQuote", { quotes: [{ quoteId: "wqE1", quoteToken: "tok-wqE1" }, { quoteId: "wqE2", quoteToken: "tok-wqE2" }],
  deliveryMode: "each", payMethod: "after", agreedName: "期限 切れ", consent: { agreed: true, version: "1.2" } });
check("409・期限切れの文言", r.status === 409 && /有効期限/.test(r.body.message || ""), JSON.stringify(r));
check("どちらも issued のまま・承諾書なし・出荷なし・番号は進まない", (await get(qd("wqE1"))).status === "issued" && (await get(qd("wqE2"))).status === "issued"
  && (await consentsOf("wE1")).length === 0 && (await shipsOf("wE1")).length === 0 && (await counter()) === cE0);

// ---------- F. 古い版・鍵違い ----------
section("F. 古い版・鍵違いは受けない");
await seed([
  [cd("wF"), { status: 2, caseNumber: 741 }],
  [qd("wqF1"), quote("wqF1", "wF", { caseNumber: 741, version: 1, status: "superseded" })],
  [qd("wqF2"), quote("wqF2", "wF", { caseNumber: 741, version: 2 })],
  [cd("wF3"), { status: 2, caseNumber: 742 }],
  // 発行中のまま新しい版がある（本来は起きないが、版の確認を Web でも行うことを確かめる）
  [qd("wqF3a"), quote("wqF3a", "wF3", { caseNumber: 742, version: 1 })], [qd("wqF3b"), quote("wqF3b", "wF3", { caseNumber: 742, version: 2 })],
]);
r = await http("acceptQuote", webBody("wqF1", { consent: { agreed: true, version: "1.2" } }));
check("superseded（古い版）→ 409", r.status === 409 && /新しい見積もり/.test(r.body.message || ""), JSON.stringify(r));
r = await http("acceptQuote", webBody("wqF3a", { consent: { agreed: true, version: "1.2" } }));
check("新しい版がある発行中の古い版 → 409 old_version", r.status === 409 && r.body.code === "old_version", JSON.stringify(r));
r = await http("acceptQuote", webBody("wqF2", { quoteToken: "wrong", consent: { agreed: true, version: "1.2" } }));
check("鍵違い → 403", r.status === 403, JSON.stringify(r));
check("何も書かない", (await consentsOf("wF")).length === 0 && (await consentsOf("wF3")).length === 0 && (await get(qd("wqF2"))).status === "issued");

// ---------- G. 見積もりの登録の応答（スイッチがオン）----------
section("G. 見積もりの登録: スイッチがオンなら条文と焼き込む形を返す");
r = await http("webhookMitsumori", { ...wmBody, email: "w3@example.test", officeName: "見積事業所G" });
check("1件: orderByConsent true・条文 v1.2 の全文", r.status === 200 && r.body.orderByConsent === true
  && JSON.stringify(r.body.consentDocument) === JSON.stringify(plain(CD.CONSENT_V1_2)), JSON.stringify(r).slice(0, 200));
const qG = await get(qd(r.body.quoteId));
check("1件: consentEntry は承諾書に焼き込む形と同じ（orderConsentQuoteEntry）",
  JSON.stringify(r.body.consentEntry) === JSON.stringify(plain(R.orderConsentQuoteEntry({ id: r.body.quoteId, ...qG }))), JSON.stringify(r.body.consentEntry));
const rG = await http("webhookMitsumori", { ...wmBody, email: "w3@example.test", officeName: "見積事業所G" });
check("同じ内容の再送（duplicate）でも条文と焼き込む形", rG.body.status === "duplicate" && rG.body.orderByConsent === true && rG.body.consentEntry && rG.body.consentEntry.quoteId === r.body.quoteId, JSON.stringify(rG.body).slice(0, 200));
r = await http("webhookMitsumori", { email: "w4@example.test", corpName: "見積法人G", contactName: "見積 三郎", phone: "0311114444",
  offices: [
    { officeName: "Gまとめ1", subsidyCategory: "houmon", btSubsidyQty: 1, usbSubsidyQty: 0, btExtraQty: 0, usbExtraQty: 0, prefecture: "東京都", city: "港区", addressDetail: "1" },
    { officeName: "Gまとめ2", subsidyCategory: "houmon", btSubsidyQty: 2, usbSubsidyQty: 0, btExtraQty: 1, usbExtraQty: 0, prefecture: "東京都", city: "港区", addressDetail: "2" },
  ] });
check("まとめ: orderByConsent・各見積もりに consentEntry", r.status === 200 && r.body.orderByConsent === true && r.body.consentDocument.version === "1.2"
  && r.body.quotes.length === 2 && r.body.quotes.every((q) => q.consentEntry && q.consentEntry.quoteId === q.quoteId && q.consentEntry.estNo === q.estNo), JSON.stringify(r).slice(0, 300));
// 見積もりの登録 → そのまま Web で発注（画面と同じ流れ）
const gq = r.body.quotes;
r = await http("acceptQuote", { quotes: gq.map((q) => ({ quoteId: q.quoteId, quoteToken: q.quoteToken })), deliveryMode: "each", payMethod: "after",
  agreedName: "流れ 確認", consent: { agreed: true, version: r.body.consentDocument.version } });
check("登録した見積もりで、そのまま発注できる", r.status === 200 && r.body.status === "ok" && !!r.body.consentUrl, JSON.stringify(r).slice(0, 300));
const tokG = (/t=([0-9a-f]{32})$/.exec(r.body.consentUrl || "") || [])[1];
const recG = await get(db.collection("consentRequests").doc(tokG || "x"));
check("焼き込んだ内容が、見積もりの登録で画面に返した内容と同じ", recG && JSON.stringify(recG.quotes) === JSON.stringify(gq.map((q) => q.consentEntry)), JSON.stringify(recG && recG.quotes).slice(0, 300));

// スイッチを切ると今までどおり
await setSwitch(false);
await seed([[cd("wH"), { status: 2, caseNumber: 751 }], [qd("wqH"), quote("wqH", "wH", { caseNumber: 751 })]]);
r = await http("acceptQuote", webBody("wqH"));
check("スイッチを切ると同意なしで受注確定（今までどおり）", r.status === 200 && r.body.status === "ok" && (await get(qd("wqH"))).acceptedVia === "web" && (await consentsOf("wH")).length === 0, JSON.stringify(r));

console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
