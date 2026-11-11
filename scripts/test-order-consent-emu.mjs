// 承諾書のサイン＝発注（2026-11-12・第1段）を、Firestore エミュレータに対して実際に動かして確かめる。
// 設計: 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md §7。進め方は scripts/test-warehouse-emu.mjs と同じ（.run() で直接呼ぶ）。
//
// 確かめること
//   A. スイッチがオフ: staffAcceptQuote は今までどおり（承諾書の記録を作らない・承諾書の項目を足さない）
//   B. スイッチがオン: 承諾書の情報が無ければ拒否し、何も書かない
//   C. スイッチがオン: 承諾書の記録（kind:"order"・署名済み・条文 v1.2 の全文・見積もりの焼き込み）と受注確定が同時に入る
//   D. まとめ見積もり: 承諾書1件に全事業所を焼き込み、1回で全部を受注確定
//   E. まとめ見積もりの1件が確認に通らない → どれも受注確定にならず、承諾書の記録も無い
//   F. 書き込みの最後（承諾書の作成）で失敗 → 受注確定も入らない（同じトランザクション）
//   G. 受注後の改版で取り直しの印（orderConsentStale）→ 取り直しで消える／内容が同じ改版では立たない
//   H. 古い版・スイッチオフの取り直しは拒否
//
// 実行（本番に繋がらない demo- プロジェクト。依存は functions/node_modules をそのまま使う）:
//   cd <repo> && firebase emulators:exec --only firestore --project demo-order-consent-test "node scripts/test-order-consent-emu.mjs"
//   （bash scripts/test-all.sh の2段目でも動く）
// 比較用（任意）: ORDER_EMU_FUNCTIONS_DIR=<別の functions フォルダ> ORDER_EMU_DUMP=<出力.json> を渡すと、
//   A（スイッチがオフ）だけを動かし、書き込まれた内容を時刻・ID を伏せて書き出す（main の functions と結果を比べるため）。
// 終了コード: 全部合格 0、1件でも不合格 1。
import { createRequire } from "node:module";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-order-consent-test";
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";
// 外部へは出さない。Chat の投稿先（テスト用の偽 URL）は中身を控えて 200。それ以外は即失敗
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
const crypto = require("crypto");
const db = admin.firestore();
const TS = admin.firestore.Timestamp;

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); console.error(`... ${t}`); } // 進み具合（止まった場所が分かるように）

const STAFF = "staff@tadakayo.jp", ADMIN = "admin@tadakayo.jp";
async function call(name, email, data) {
  try {
    const r = await fns[name].run({ auth: { uid: "uid-" + email, token: { email, name: email } }, data, rawRequest: {} });
    return { ok: true, r };
  } catch (e) { return { ok: false, code: e.code, msg: e.message, details: e.details }; }
}
const get = async (ref) => { const s = await ref.get(); return s.exists ? s.data() : null; };
const qd = (id) => db.collection("quotes").doc(id);
const cd = (id) => db.collection("cases").doc(id);
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const ymd = (daysAgo) => new Date(Date.now() + 9 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
const counter = async () => ((await get(db.collection("_counters").doc("shipments"))) || {}).value || 0;
const setSwitch = (on) => db.collection("appConfig").doc("settings").set({ orderByConsent: on, chatWebhookUrl: HOOK }, { merge: true });
const consentsOf = async (caseId) => (await db.collection("consentRequests").where("caseIds", "array-contains", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const allConsents = async () => (await db.collection("consentRequests").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const shipsOf = async (caseId) => (await db.collection("shipments").where("caseId", "==", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const actsOf = async (caseId) => (await db.collection("activities").where("caseId", "==", caseId).get()).docs.map((d) => d.data());

const AMOUNTS = { readers: 46200, accompanyFee: 33000, discount: 0, subsidyPartTotal: 79200, extraPartTotal: 0, totalIncl: 79200, grantAmt: 64000, selfPay: 15200 };
function quote(id, caseId, o = {}) {
  return {
    caseId, caseNumber: o.caseNumber || 100, estNo: o.estNo || `EST-T-${id}`, version: 1, status: "issued",
    plan: "houmon", items: [{ sku: "cir415a-01", subsidyQty: 2, extraQty: 0 }], amounts: AMOUNTS,
    validUntil: TS.fromMillis(Date.now() + 10 * 86400000), contactEmail: "", contactName: "担当 花子",
    officeName: o.officeName || `事業所${id}`, corpName: "テスト法人", officeId: null, accessToken: "tok-" + id,
    createdAt: TS.now(), ...o,
  };
}
async function seed(items) {
  const b = db.batch();
  for (const [ref, d] of items) b.set(ref, d);
  await b.commit();
}

await seed([
  [db.collection("users").doc(STAFF), { active: true, role: "staff", name: "職員" }],
  [db.collection("users").doc(ADMIN), { active: true, role: "admin", name: "管理" }],
  [db.collection("_counters").doc("shipments"), { value: 100 }],
]);

// 時刻・ID を伏せて並べ直す（main との比較用）
function norm(v) {
  if (v == null) return v;
  if (v instanceof TS || (typeof v.toMillis === "function")) return "<ts>";
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
  return v;
}

// ---------- A. スイッチがオフ（今までどおり）----------
section("A. スイッチがオフ: 今までどおり");
await setSwitch(false);
await seed([[cd("cA"), { status: 2, caseNumber: 201, officeName: "事業所A" }], [qd("qA"), quote("qA", "cA", { caseNumber: 201 })]]);
const c0 = await counter();
let r = await call("staffAcceptQuote", STAFF, {
  quoteId: "qA", acceptedName: "山田 花子", channel: "phone", receivedDate: TODAY, payMethod: "after", sendMail: false,
  // オフのときは承諾書の情報を渡しても使わない（記録を作らない）
  consent: { signedName: "使わない", receivedDate: TODAY, receivedVia: "fax" },
});
check("受注確定できる", r.ok && r.r.ok === true, JSON.stringify(r).slice(0, 300));
const qA = await get(qd("qA")), kA = await get(cd("cA"));
check("見積もりは accepted・acceptedVia staff", qA.status === "accepted" && qA.acceptedVia === "staff");
check("見積もりに承諾書の項目が無い", !("consentToken" in qA));
check("案件は 3・承諾書の項目が無い", kA.status === 3 && !("orderConsentToken" in kA) && !("orderConsentStale" in kA) && !("orderConsentAt" in kA));
check("申込者名は acceptedName（承諾書の名前を使っていない）", qA.acceptedBy === "山田 花子");
check("承諾書の記録は作らない", (await allConsents()).length === 0);
check("出荷の下書きが1件・番号が1つ進む", (await shipsOf("cA")).length === 1 && (await counter()) === c0 + 1);
check("戻り値に承諾書の項目が無い", r.ok && !("consentToken" in r.r) && !("displayNo" in r.r));
const actA = await actsOf("cA");
check("対応記録は従来の件名", actA.length === 1 && actA[0].subject.startsWith("電話で受けたお申し込みを受注確定にしました"), JSON.stringify(actA.map((a) => a.subject)));
if (DUMP) {
  const ships = await shipsOf("cA");
  writeFileSync(DUMP, JSON.stringify(norm({
    quote: qA, kase: kA, ships: ships.map(({ id, ...x }) => x), acts: actA, ret: { ...r.r, results: r.r.results.map(({ shipmentId, ...x }) => x) },
    consents: await allConsents(), counterDelta: (await counter()) - c0,
  }), null, 2));
  console.log(`dumped: ${DUMP}`);
  console.log(results.join("\n"));
  console.log(`\n合計: ${pass}/${pass + fail} 合格`);
  process.exit(fail ? 1 : 0);
}
// 取り直しはスイッチがオフなら拒否
r = await call("staffAcceptQuote", STAFF, { quoteId: "qA", reconsent: true, consent: { signedName: "x", receivedDate: TODAY } });
check("H: スイッチがオフの取り直しは拒否", !r.ok && r.code === "failed-precondition", JSON.stringify(r));

// ---------- B. スイッチがオン・承諾書の情報なし ----------
section("B. スイッチがオン: 承諾書の情報が無ければ拒否");
await setSwitch(true);
await seed([[cd("cB"), { status: 1, caseNumber: 202, officeName: "事業所B" }], [qd("qB"), quote("qB", "cB", { caseNumber: 202 })]]);
const cB0 = await counter();
r = await call("staffAcceptQuote", STAFF, { quoteId: "qB", acceptedName: "山田", channel: "phone", receivedDate: TODAY, payMethod: "after", sendMail: false });
check("consent が無ければ failed-precondition（consent_required）", !r.ok && r.code === "failed-precondition" && r.details && r.details.code === "consent_required", JSON.stringify(r));
r = await call("staffAcceptQuote", STAFF, { quoteId: "qB", payMethod: "after", sendMail: false, consent: { signedName: "  ", receivedDate: TODAY } });
check("署名者名が空なら invalid-argument", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
r = await call("staffAcceptQuote", STAFF, { quoteId: "qB", payMethod: "after", sendMail: false, consent: { signedName: "山田", receivedDate: "2026-02-30" } });
check("受け取った日が正しくなければ invalid-argument", !r.ok && r.code === "invalid-argument", JSON.stringify(r));
const future = new Date(Date.now() + 9 * 3600000 + 2 * 86400000).toISOString().slice(0, 10);
r = await call("staffAcceptQuote", STAFF, { quoteId: "qB", payMethod: "after", sendMail: false, consent: { signedName: "山田", receivedDate: future } });
check("受け取った日が未来なら拒否", !r.ok && r.code === "failed-precondition", JSON.stringify(r));
check("拒否したあと、見積もり・案件・出荷・承諾書は何も変わっていない",
  (await get(qd("qB"))).status === "issued" && (await get(cd("cB"))).status === 1 && (await shipsOf("cB")).length === 0
  && (await consentsOf("cB")).length === 0 && (await counter()) === cB0);

// ---------- C. スイッチがオン・紙の承諾書 ----------
section("C. スイッチがオン: 承諾書の記録と受注確定が同時に入る");
posted.length = 0;
r = await call("staffAcceptQuote", STAFF, {
  quoteId: "qB", payMethod: "before", preferredDate: "", note: "FAXで受領", sendMail: false,
  // acceptedName・channel・receivedDate は承諾書の値で上書きされる
  acceptedName: "別の名前", channel: "phone", receivedDate: ymd(3),
  consent: { signedName: "鈴木 一郎（管理者）", receivedDate: ymd(1), receivedVia: "fax" },
});
check("受注確定できる", r.ok && r.r.ok === true && r.r.results.length === 1, JSON.stringify(r).slice(0, 400));
const tokC = r.ok ? r.r.consentToken : "";
check("戻り値に承諾書のトークン（128bit＝16進32文字）と表示番号", /^[0-9a-f]{32}$/.test(tokC) && /^CST-202/.test(r.r.displayNo || ""), JSON.stringify(r.r));
const recC = await get(db.collection("consentRequests").doc(tokC));
check("承諾書: kind order・status signed", recC && recC.kind === "order" && recC.status === "signed");
check("承諾書: 条文 v1.2 の全文（題名・§6・同意文）", recC && recC.document.version === "1.2" && /発注書を兼ねます/.test(recC.document.title)
  && recC.document.sections.length === 7 && /発注したものとします/.test(recC.document.sections[5].body));
check("承諾書: 見積もりの焼き込み（見積番号・版・案件・事業所・品目・金額）", recC && recC.quotes.length === 1 && recC.quotes[0].quoteId === "qB"
  && recC.quotes[0].estNo === "EST-T-qB" && recC.quotes[0].version === 1 && recC.quotes[0].caseId === "cB"
  && recC.quotes[0].items[0].subsidyQty === 2 && recC.quotes[0].amounts.totalIncl === 79200 && recC.totalIncl === 79200, JSON.stringify(recC && recC.quotes));
check("承諾書: signed（署名者・紙・受け取った日・受け取り方・サーバー時刻）", recC && recC.signed.name === "鈴木 一郎（管理者）"
  && recC.signed.method === "paper_order" && recC.signed.receivedDate === ymd(1) && recC.signed.receivedVia === "fax"
  && recC.signed.signedAt instanceof TS && !("recordedBy" in recC.signed), JSON.stringify(recC && recC.signed));
// 条文（document）には法人の窓口 info@ が載るので除いて見る。職員のアドレスは条文の外にも中にも入らない
check("承諾書: 職員のメールアドレスが入っていない（トークンを知れば読めるため）", recC && !/@/.test(JSON.stringify({ ...recC, document: null })) && !JSON.stringify(recC).includes(STAFF) && !("createdBy" in recC));
check("承諾書: caseId・caseIds", recC && recC.caseId === "cB" && JSON.stringify(recC.caseIds) === JSON.stringify(["cB"]));
const qB = await get(qd("qB")), kB = await get(cd("cB"));
check("見積もり: accepted・acceptedVia consent_paper・consentToken", qB.status === "accepted" && qB.acceptedVia === "consent_paper" && qB.consentToken === tokC);
check("見積もり: 申込者名・受付日・受付方法は承諾書から", qB.acceptedBy === "鈴木 一郎（管理者）" && qB.acceptedReceivedDate === ymd(1) && qB.acceptedChannel === "fax");
check("案件: 状態3・orderConsentToken・orderConsentAt・取り直しの印なし", kB.status === 3 && kB.orderConsentToken === tokC && kB.orderConsentAt instanceof TS && kB.orderConsentStale === false);
check("案件: 受注日＝受け取った日（JST 0時）", kB.orderedAt && new Date(kB.orderedAt.toMillis() + 9 * 3600000).toISOString().slice(0, 10) === ymd(1));
const shB = await shipsOf("cB");
check("出荷の下書きが1件", shB.length === 1 && shB[0].status === "draft" && shB[0].quoteId === "qB");
const actB = await actsOf("cB");
check("記録した職員は見積もり・案件・対応記録の側に残る", qB.acceptedByStaff === STAFF && kB.orderConfirmedBy === STAFF);
check("対応記録: 承諾書で受注確定の件名", actB.some((a) => /^署名済みの承諾書（FAX）を受け取り、受注確定にしました（EST-T-qB・出荷 SH-/.test(a.subject)), JSON.stringify(actB.map((a) => a.subject)));
check("Chat: 承諾書の見出し（署名者名は載せない）", posted.some((p) => /署名済みの承諾書を受け取り、受注確定にしました/.test(p.text) && !p.text.includes("鈴木")), JSON.stringify(posted).slice(0, 300));
r = await call("staffAcceptQuote", STAFF, { quoteId: "qB", payMethod: "after", sendMail: false, consent: { signedName: "鈴木", receivedDate: TODAY } });
check("同じ見積もりの二重の受注確定は拒否", !r.ok && r.code === "failed-precondition", JSON.stringify(r));
check("二重の受注確定を拒否しても承諾書は1件のまま", (await consentsOf("cB")).length === 1);

// ---------- D. まとめ見積もり ----------
section("D. まとめ見積もり: 承諾書1件に全事業所");
await seed([
  [cd("cD1"), { status: 2, caseNumber: 301, officeName: "事業所D1" }], [cd("cD2"), { status: 1, caseNumber: 302, officeName: "事業所D2" }],
  [qd("qD1"), quote("qD1", "cD1", { caseNumber: 301, groupId: "G1", groupIndex: 0 })],
  [qd("qD2"), quote("qD2", "cD2", { caseNumber: 302, groupId: "G1", groupIndex: 1, amounts: { ...AMOUNTS, totalIncl: 50000, selfPay: 5000 } })],
]);
const cD0 = await counter();
r = await call("staffAcceptQuote", STAFF, { quoteId: "qD1", groupQuoteIds: ["qD2"], payMethod: "after", sendMail: false,
  consent: { signedName: "法人 太郎", receivedDate: TODAY, receivedVia: "post" } });
check("まとめて受注確定できる（2件）", r.ok && r.r.results.length === 2 && r.r.partial === false, JSON.stringify(r).slice(0, 300));
const tokD = r.ok ? r.r.consentToken : "";
const recD = await get(db.collection("consentRequests").doc(tokD));
check("承諾書は1件・2事業所を焼き込み・合計", recD && recD.quotes.length === 2 && recD.quoteGroupId === "G1" && recD.totalIncl === 129200
  && JSON.stringify(recD.caseIds) === JSON.stringify(["cD1", "cD2"]), JSON.stringify(recD && { q: recD.quotes.map((q) => q.quoteId), t: recD.totalIncl }));
const kD1 = await get(cd("cD1")), kD2 = await get(cd("cD2"));
check("両方の案件が状態3・同じ承諾書", kD1.status === 3 && kD2.status === 3 && kD1.orderConsentToken === tokD && kD2.orderConsentToken === tokD);
check("出荷の番号は2つ進む（重ならない）", (await counter()) === cD0 + 2 && (await shipsOf("cD1"))[0].soNumber !== (await shipsOf("cD2"))[0].soNumber);
check("まとめの承諾書は受け取った全事業所で探せる（caseIds）", (await consentsOf("cD2")).length === 1);

// ---------- E. まとめの1件が通らない → どれも入らない ----------
section("E. まとめ見積もりの1件が確認に通らない");
await seed([
  [cd("cE1"), { status: 2, caseNumber: 401 }], [cd("cE2"), { status: 2, caseNumber: 402 }],
  [qd("qE1"), quote("qE1", "cE1", { caseNumber: 401, groupId: "G2" })],
  // 有効期限が3日前（受け取った日＝今日では期限切れ）
  [qd("qE2"), quote("qE2", "cE2", { caseNumber: 402, groupId: "G2", validUntil: TS.fromMillis(Date.now() - 3 * 86400000) })],
]);
const cE0 = await counter(), nConsE = (await allConsents()).length;
r = await call("staffAcceptQuote", STAFF, { quoteId: "qE1", groupQuoteIds: ["qE2"], payMethod: "after", sendMail: false,
  consent: { signedName: "法人 次郎", receivedDate: TODAY } });
check("期限切れが1件あれば全体を拒否", !r.ok && r.code === "failed-precondition" && /有効期限/.test(r.msg), JSON.stringify(r));
check("どちらの見積もりも issued のまま・案件も2のまま",
  (await get(qd("qE1"))).status === "issued" && (await get(qd("qE2"))).status === "issued"
  && (await get(cd("cE1"))).status === 2 && (await get(cd("cE2"))).status === 2);
check("承諾書の記録は増えない・出荷も番号も増えない", (await allConsents()).length === nConsE && (await shipsOf("cE1")).length === 0 && (await counter()) === cE0);

// ---------- F. 書き込みの最後で失敗 → どちらも入らない ----------
section("F. 承諾書の作成で失敗したら、受注確定も入らない");
await seed([[cd("cF"), { status: 2, caseNumber: 501 }], [qd("qF"), quote("qF", "cF", { caseNumber: 501 })]]);
const FIXED = "ab".repeat(16);
await db.collection("consentRequests").doc(FIXED).set({ kind: "dummy", note: "トークンの衝突を起こすための先客" });
const realRandom = crypto.randomBytes;
crypto.randomBytes = (n, ...rest) => (n === 16 && rest.length === 0 ? Buffer.alloc(16, 0xab) : realRandom(n, ...rest));
const cF0 = await counter();
try {
  r = await call("staffAcceptQuote", STAFF, { quoteId: "qF", payMethod: "after", sendMail: false, consent: { signedName: "田中", receivedDate: TODAY } });
} finally { crypto.randomBytes = realRandom; }
check("承諾書の作成（同じトークンの先客）で失敗する", !r.ok, JSON.stringify(r).slice(0, 300));
check("見積もりは issued のまま・案件は2のまま・出荷なし・番号も進まない",
  (await get(qd("qF"))).status === "issued" && (await get(cd("cF"))).status === 2 && !(await get(cd("cF"))).orderConsentToken
  && (await shipsOf("cF")).length === 0 && (await counter()) === cF0);
check("先客の文書は書き換わっていない", (await get(db.collection("consentRequests").doc(FIXED))).kind === "dummy");
check("対応記録も残らない", (await actsOf("cF")).length === 0);

// ---------- G. 受注後の改版と取り直し ----------
section("G. 受注後の改版で取り直しの印 → 取り直しで消える");
// cB は C で承諾書つきで受注確定済み。台数を変えて改版
r = await call("reviseQuote", STAFF, { quoteId: "qB", plan: "houmon", btQty: 3, usbQty: 0, btExtra: 0, usbExtra: 0, reason: "台数を3台に", sendMail: false });
check("改版できる（出荷は下書きなので作り直し）", r.ok && r.r.version === 2 && r.r.orderConsentStale === true, JSON.stringify(r).slice(0, 300));
let kG = await get(cd("cB"));
check("案件に orderConsentStale: true", kG.orderConsentStale === true);
const qBv2 = (await db.collection("quotes").where("caseId", "==", "cB").where("version", "==", 2).get()).docs[0];
check("新しい版は accepted（受注は止めない）", qBv2 && qBv2.data().status === "accepted");
check("対応記録に取り直しの注意", (await actsOf("cB")).some((a) => /承諾書の取り直しが要ります/.test(a.body || "")));
// 古い版（v1）での取り直しは拒否
r = await call("staffAcceptQuote", STAFF, { quoteId: "qB", reconsent: true, consent: { signedName: "鈴木", receivedDate: TODAY } });
check("H: 旧版の取り直しは拒否", !r.ok && r.code === "failed-precondition", JSON.stringify(r));
const cG0 = await counter();
r = await call("staffAcceptQuote", STAFF, { quoteId: qBv2.id, reconsent: true, consent: { signedName: "鈴木 一郎", receivedDate: TODAY, receivedVia: "email" } });
check("新しい版で取り直しできる", r.ok && r.r.reconsent === true && /^[0-9a-f]{32}$/.test(r.r.consentToken), JSON.stringify(r).slice(0, 300));
kG = await get(cd("cB"));
const recG = r.ok ? await get(db.collection("consentRequests").doc(r.r.consentToken)) : null;
check("案件: 印が消え、新しい承諾書を指す", kG.orderConsentStale === false && kG.orderConsentToken === (r.r && r.r.consentToken) && kG.status === 3);
check("新しい承諾書: 第2版を焼き込み・前の承諾書を retakeOf に", recG && recG.quotes[0].version === 2 && recG.quotes[0].items[0].subsidyQty === 3 && recG.retakeOf === tokC);
check("前の承諾書は残っている", !!(await get(db.collection("consentRequests").doc(tokC))));
check("取り直しでは出荷・番号は変わらない", (await shipsOf("cB")).length === 1 && (await counter()) === cG0);
check("見積もりに consentToken（新しい承諾書）", (await get(qd(qBv2.id))).consentToken === r.r.consentToken);
check("取り直しの承諾書にも職員のメールアドレスが入っていない", recG && !/@/.test(JSON.stringify({ ...recG, document: null })) && !JSON.stringify(recG).includes(STAFF));
const nConsG = (await consentsOf("cB")).length;
r = await call("staffAcceptQuote", STAFF, { quoteId: qBv2.id, reconsent: true, consent: { signedName: "鈴木 一郎", receivedDate: TODAY } });
check("取り直しの二度押しは「すでに取り直し済み」で止める", !r.ok && r.code === "failed-precondition" && r.details && r.details.code === "already_retaken", JSON.stringify(r));
check("二度押しで承諾書は増えない", (await consentsOf("cB")).length === nConsG);
// 内容が同じ改版（理由だけ）では印は立たない
r = await call("reviseQuote", STAFF, { quoteId: qBv2.id, plan: "houmon", btQty: 3, usbQty: 0, btExtra: 0, usbExtra: 0, reason: "メモだけ", sendMail: false });
check("品目・台数・金額が同じ改版では印を立てない", r.ok && r.r.orderConsentStale === false && (await get(cd("cB"))).orderConsentStale === false, JSON.stringify(r).slice(0, 200));
// 承諾書の無い案件（A・スイッチオフで受注）の改版は印の項目を足さない
r = await call("reviseQuote", STAFF, { quoteId: "qA", plan: "houmon", btQty: 1, usbQty: 0, btExtra: 0, usbExtra: 0, reason: "台数変更", sendMail: false });
check("承諾書の無い案件の改版は今までどおり（orderConsentStale を足さない）", r.ok && !("orderConsentStale" in r.r) && !("orderConsentStale" in (await get(cd("cA")))), JSON.stringify(r).slice(0, 200));

// ---------- H. 古い版への発注 ----------
section("H. 古い版の見積もりへの承諾書は受けない");
await seed([
  [cd("cH"), { status: 2, caseNumber: 601 }],
  [qd("qH1"), quote("qH1", "cH", { caseNumber: 601, version: 1 })],
  [qd("qH2"), quote("qH2", "cH", { caseNumber: 601, version: 2 })],
]);
r = await call("staffAcceptQuote", STAFF, { quoteId: "qH1", payMethod: "after", sendMail: false, consent: { signedName: "古い", receivedDate: TODAY } });
check("旧版への承諾書は拒否", !r.ok && r.code === "failed-precondition" && /新しい版/.test(r.msg), JSON.stringify(r));
check("何も書かない", (await get(qd("qH1"))).status === "issued" && (await consentsOf("cH")).length === 0);

// スイッチを切ったら、紙の道は今までどおりに戻る
await setSwitch(false);
r = await call("staffAcceptQuote", STAFF, { quoteId: "qH2", acceptedName: "電話の方", channel: "phone", receivedDate: TODAY, payMethod: "after", sendMail: false });
check("スイッチを切ると承諾書なしで受注確定（今までどおり）", r.ok && (await get(qd("qH2"))).acceptedVia === "staff" && (await consentsOf("cH")).length === 0, JSON.stringify(r).slice(0, 200));

console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
