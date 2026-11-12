// 点検9（出荷をキャンセルしたあとの案件・2026-11-12）を、Firestore エミュレータに対して実際に動かして確かめる。
// 画面（supply.js doCancelShipment）が書く中身は admin/js/ship-cancel-case.js の純関数で決まるので、ここでは同じ関数で
// キャンセルを書き（読み取り→判定→書き込みを1つのトランザクションで・画面と同じ順番）、そのあと既存の関数
// （staffAcceptQuote・reviseQuote）がその状態を受け付けるかを .run() で直接呼んで確かめる。
// キャンセルの読み書きは、画面と同じくクライアント SDK（職員としてログインした状態）で行い、Firestore のルール
// （firestore.rules）を通す（2026-11-13 小さな指摘7。以前は Admin SDK で書いていてルールを通っていなかった）。
// クライアント SDK は、ルールのテストと同じ作業フォルダ（EMU_RUN_DIR。既定 ${TMPDIR:-/tmp}/kjk-emu-run）の
// @firebase/rules-unit-testing・firebase を使う（リポジトリには入れない。bash scripts/test-all.sh が用意する）。
// 下ごしらえ（案件・見積もり・入金の記録を置く）と、関数（staffAcceptQuote・reviseQuote）は今までどおり Admin SDK。
//
// 確かめること
//   A. 戻したあと: 同じ見積もりで受注確定をやり直せる（新しい下書き・案件は 3・受注日が入る）
//   B. 戻したあと: 見積もりを直せる（reviseQuote が通り、新しい版は発行中）
//   C. 比べ: 戻さない（見積もりが承諾済みのまま）と、受注確定のやり直しも見積もりの修正も止まる＝「発行中に戻す」を選んだ理由
//   D. 入金の記録がある → 案件・見積もりは変えず、保留の対応記録だけ。入金の記録はそのまま
//   E. 一部だけのキャンセル → 何も変えない
//   F. 承諾書で受注した案件 → 取り直しの印（orderConsentStale・理由 ship_canceled）。新しい承諾書で受注確定すると印も理由も消える
//   G. ルールが効いている: 閲覧のみ（viewer）の人はキャンセルを書けない（何も変わらない）
//   H. 認定事業者の受注から作った出荷（2026-11-13「その都度、人が選ぶ」・admin/js/ship-cancel-order.js）:
//      選んだ戻し先（受注確定／受付済／キャンセル）が受注に入り、記録（lastShipCancel・shipCancelLog・出荷の partnerOrderReturn）が残る。
//      選ばないと何も変わらない／viewer は書けない／通常の出荷は受注に触れない／同じ受注にほかの生きた出荷があれば受注は変えない
//
// 実行（本番に繋がらない demo- プロジェクト。依存は functions/node_modules をそのまま使う）:
//   cd <repo> && firebase emulators:exec --only firestore --project demo-ship-cancel-test "node scripts/test-ship-cancel-emu.mjs"
//   （bash scripts/test-all.sh の2段目でも動く）
// 終了コード: 全部合格 0、1件でも不合格 1。
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planShipCancelRevert, revertWrites, holdActivity } from "../admin/js/ship-cancel-case.js";
import { hasActiveOrder, statusChangeGuard } from "../admin/js/order-consent.js";
import { isPartnerOrderShipment, validateOrderReturn, planOrderOnShipCancel, orderReturnWrites } from "../admin/js/ship-cancel-order.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-ship-cancel-test";
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";
// 外部へは出さない。Chat の投稿先（テスト用の偽 URL）は中身を控えて 200。それ以外は即失敗
const HOOK = "https://chat.example.test/hook";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, opts);
  if (u === HOOK) return new Response("{}", { status: 200 });
  return new Response("blocked in test", { status: 503 });
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(REPO, "functions", "index.js"));
const fns = require(path.join(REPO, "functions", "index.js"));
const admin = require("firebase-admin");
const db = admin.firestore();
const TS = admin.firestore.Timestamp;
const FV = admin.firestore.FieldValue;

// ---- クライアント SDK（ルールを通す）。ルールのテストと同じ作業フォルダの部品を使う ----
const EMU_RUN_DIR = process.env.EMU_RUN_DIR || path.join(process.env.TMPDIR || "/tmp", "kjk-emu-run");
let RUT, CF;
try {
  const reqRun = createRequire(path.join(EMU_RUN_DIR, "package.json"));
  RUT = reqRun("@firebase/rules-unit-testing");
  CF = reqRun("firebase/firestore");
} catch (e) {
  console.error(`クライアント SDK が見つからない（${EMU_RUN_DIR} に @firebase/rules-unit-testing と firebase が要る。`
    + "bash scripts/test-all.sh で用意されるか、そのフォルダで npm i @firebase/rules-unit-testing firebase）:", e.message);
  process.exit(2);
}
const [EMU_HOST, EMU_PORT] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
const testEnv = await RUT.initializeTestEnvironment({
  projectId: process.env.GCLOUD_PROJECT,
  firestore: { rules: readFileSync(path.join(REPO, "firestore.rules"), "utf8"), host: EMU_HOST, port: Number(EMU_PORT) },
});
const clientDb = (email) => testEnv.authenticatedContext("uid-" + email, { email, email_verified: true }).firestore();

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); console.error(`... ${t}`); }

const STAFF = "staff@tadakayo.jp";
const VIEWER = "viewer@tadakayo.jp";
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
const setSwitch = (on) => db.collection("appConfig").doc("settings").set({ orderByConsent: on, chatWebhookUrl: HOOK }, { merge: true });
const shipsOf = async (caseId) => (await db.collection("shipments").where("caseId", "==", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const actsOf = async (caseId) => (await db.collection("activities").where("caseId", "==", caseId).get()).docs.map((d) => d.data());
const quotesOf = async (caseId) => (await db.collection("quotes").where("caseId", "==", caseId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

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
async function seed(items) { const b = db.batch(); for (const [ref, d] of items) b.set(ref, d); await b.commit(); }
const accept = (quoteId, extra = {}) => call("staffAcceptQuote", STAFF, {
  quoteId, acceptedName: "山田 花子", channel: "phone", receivedDate: TODAY, payMethod: "after", sendMail: false, ...extra });

// 画面（supply.js doCancelShipment）と同じ手順: 一覧を先に読み → トランザクションで読み直し → 判定 → 書き込み。
// 読み書きはクライアント SDK（as の人としてログイン）で行い、ルールを通す
async function cancelLikeScreen(shipId, { revert = true, by = "職員 太郎", reason = "事業所の都合", as = STAFF } = {}) {
  const cdb = clientDb(as);
  const { doc: cdoc, collection: ccol, query: cquery, where: cwhere, getDoc: cgetDoc, getDocs: cgetDocs, runTransaction: crun,
    serverTimestamp: cnow } = CF;
  const shipRef = cdoc(cdb, "shipments", shipId);
  const pre = (await cgetDoc(shipRef)).data();
  const sibIds = (await cgetDocs(cquery(ccol(cdb, "shipments"), cwhere("caseId", "==", pre.caseId)))).docs.map((d) => d.id).filter((id) => id !== shipId);
  const quoteIds = (await cgetDocs(cquery(ccol(cdb, "quotes"), cwhere("caseId", "==", pre.caseId)))).docs.map((d) => d.id);
  let plan = { kind: "none", reasons: [] };
  await crun(cdb, async (tx) => {
    const cur = (await tx.get(shipRef)).data();
    const caseRef = cdoc(cdb, "cases", pre.caseId);
    const cSnap = await tx.get(caseRef);
    const kase = cSnap.exists() ? cSnap.data() : null;
    const sibs = [], quotes = [];
    for (const id of sibIds) { const d = await tx.get(cdoc(cdb, "shipments", id)); if (d.exists()) sibs.push({ _id: d.id, ...d.data() }); }
    for (const id of quoteIds) { const d = await tx.get(cdoc(cdb, "quotes", id)); if (d.exists()) quotes.push({ id: d.id, ...d.data() }); }
    plan = revert ? planShipCancelRevert({ kase, shipments: [{ _id: shipId, ...cur }, ...sibs], canceledId: shipId }) : { kind: "none", reasons: [] };
    tx.update(shipRef, { status: "canceled", statusBeforeCancel: cur.status, canceledAt: cnow(), canceledBy: by,
      cancelReason: reason, cancelNote: "", updatedAt: cnow() });
    const actBase = { caseId: pre.caseId, type: "memo", occurredAt: cnow(), userId: "uid-x", userName: by, attachmentUrls: [] };
    if (plan.kind === "revert") {
      const w = revertWrites({ kase, quotes, ship: { _id: shipId, ...cur }, by, now: cnow(), cancelReason: reason });
      tx.update(caseRef, w.casePatch);
      for (const qp of w.quotePatches) tx.update(cdoc(cdb, "quotes", qp.id), qp.patch);
      tx.set(cdoc(ccol(cdb, "activities")), { ...actBase, ...w.activity });
    } else if (plan.kind === "hold") {
      tx.set(cdoc(ccol(cdb, "activities")), { ...actBase, ...holdActivity({ ship: { _id: shipId, ...cur }, by, reasons: plan.reasons, cancelReason: reason }) });
      tx.update(caseRef, { updatedAt: cnow() });
    }
  });
  return plan;
}

await seed([
  [db.collection("users").doc(STAFF), { active: true, role: "staff", name: "職員" }],
  [db.collection("users").doc(VIEWER), { active: true, role: "viewer", name: "閲覧のみ" }],
  [db.collection("_counters").doc("shipments"), { value: 100 }],
]);
await setSwitch(false);

// ---------- A. 戻したあと、受注確定をやり直せる ----------
section("A. 出荷キャンセル → 確認中に戻す → 同じ見積もりで受注確定をやり直す");
await seed([[cd("cA"), { status: 2, caseNumber: 301, officeName: "事業所A" }], [qd("qA"), quote("qA", "cA", { caseNumber: 301 })]]);
let r = await accept("qA");
check("最初の受注確定", r.ok, JSON.stringify(r).slice(0, 200));
let kA = await get(cd("cA"));
const ship1 = (await shipsOf("cA"))[0];
check("受注確定: 案件3・受注日あり・下書き1件", kA.status === 3 && kA.orderedAt instanceof TS && ship1 && ship1.status === "draft");
await cd("cA").update({ status: 5 }); // 担当者決定まで進んだ案件
let plan = await cancelLikeScreen(ship1.id);
check("判定は revert", plan.kind === "revert", JSON.stringify(plan));
kA = await get(cd("cA"));
let qA = await get(qd("qA"));
check("案件: 状態2（確認中）・帯の項目", kA.status === 2 && kA.statusChangedTo === 2 && kA.statusChangedAt instanceof TS);
check("案件: 受注日・出荷のひも付けを外し、前の値を記録に残す", kA.orderedAt === null && kA.shipmentId === null
  && kA.shipCancelRevert && kA.shipCancelRevert.prevOrderedAt instanceof TS && kA.shipCancelRevert.prevShipmentId === ship1.id
  && kA.shipCancelRevert.fromStatus === 5 && kA.shipCancelRevert.soNumber === ship1.soNumber && kA.shipCancelRevert.by === "職員 太郎");
check("案件: 承諾書の無い案件には承諾書の印を立てない", !("orderConsentStale" in kA));
check("案件: 申込の経路（orderedVia）を外し、前の値を記録に残す（小さな指摘5）", kA.orderedVia === null && kA.shipCancelRevert.prevOrderedVia === "staff");
check("見積もり: 発行中・出荷のひも付けなし・前の申込は prevAccept に", qA.status === "issued" && qA.shipmentId === null && qA.acceptedAt === null
  && qA.prevAccept && qA.prevAccept.shipmentId === ship1.id && qA.prevAccept.acceptedBy === "山田 花子" && qA.revertReason === "ship_canceled");
const actA = await actsOf("cA");
check("対応記録: 誰が・どの出荷のキャンセルで戻したか", actA.some((a) => a.subject === `出荷 ${ship1.soNumber} のキャンセルで、案件を見積もり確認中に戻しました`
  && /操作した人: 職員 太郎/.test(a.body) && /理由: 事業所の都合/.test(a.body) && a.occurredAt instanceof TS), JSON.stringify(actA.map((a) => a.subject)));
r = await accept("qA", { acceptedName: "山田 花子（再）" });
check("やり直しの受注確定が通る", r.ok && r.r.ok === true, JSON.stringify(r).slice(0, 300));
const shipsA = await shipsOf("cA");
const ship2 = shipsA.find((s) => s.id !== ship1.id);
kA = await get(cd("cA")); qA = await get(qd("qA"));
check("新しい下書きが1件増える（キャンセル済みは残る）", shipsA.length === 2 && ship2 && ship2.status === "draft" && shipsA.find((s) => s.id === ship1.id).status === "canceled");
check("案件: 3・受注日が入り直す・新しい出荷にひも付く", kA.status === 3 && kA.orderedAt instanceof TS && kA.shipmentId === ship2.id);
check("見積もり: 申し込み済み・新しい出荷", qA.status === "accepted" && qA.shipmentId === ship2.id && qA.acceptedBy === "山田 花子（再）");

// ---------- B. 戻したあと、見積もりを直せる ----------
section("B. 出荷キャンセル → 確認中に戻す → 見積もりを直す（reviseQuote）");
await seed([[cd("cB"), { status: 2, caseNumber: 302, officeName: "事業所B" }], [qd("qB"), quote("qB", "cB", { caseNumber: 302 })]]);
r = await accept("qB");
const shipB = (await shipsOf("cB"))[0];
plan = await cancelLikeScreen(shipB.id);
check("判定は revert", plan.kind === "revert");
r = await call("reviseQuote", STAFF, { quoteId: "qB", plan: "houmon", btQty: 1, usbQty: 0, btExtra: 0, usbExtra: 0, reason: "台数を1台に", sendMail: false });
check("見積もりを直せる", r.ok && r.r.ok === true, JSON.stringify(r).slice(0, 300));
const qsB = await quotesOf("cB");
const v2 = qsB.find((q) => q.version === 2);
check("新しい版は発行中・旧版は superseded・出荷のひも付けなし", v2 && v2.status === "issued" && v2.shipmentId === null
  && qsB.find((q) => q.id === "qB").status === "superseded", JSON.stringify(qsB.map((q) => [q.id, q.version, q.status])));
r = await accept(v2.id);
check("新しい版で受注確定できる", r.ok && (await get(cd("cB"))).status === 3, JSON.stringify(r).slice(0, 200));

// ---------- C. 比べ: 見積もりを承諾済みのままにすると、止まる ----------
section("C. 比べ: 戻さない（承諾済みのまま）と受注確定のやり直しも見積もりの修正も止まる");
await seed([[cd("cC"), { status: 2, caseNumber: 303, officeName: "事業所C" }], [qd("qC"), quote("qC", "cC", { caseNumber: 303 })]]);
r = await accept("qC");
const shipC = (await shipsOf("cC"))[0];
await cancelLikeScreen(shipC.id, { revert: false });
r = await accept("qC");
check("承諾済みのままだと受注確定のやり直しは拒否（already_accepted）", !r.ok && r.code === "failed-precondition", JSON.stringify(r).slice(0, 200));
r = await call("reviseQuote", STAFF, { quoteId: "qC", plan: "houmon", btQty: 1, usbQty: 0, btExtra: 0, usbExtra: 0, reason: "x", sendMail: false });
check("承諾済みのまま（キャンセル済みの出荷を指す）だと見積もりの修正も拒否", !r.ok && r.code === "failed-precondition", JSON.stringify(r).slice(0, 200));

// ---------- D. 入金の記録がある → 戻さない ----------
section("D. 入金の記録がある出荷（全額返金済み）をキャンセル → 自動では戻さない");
await seed([[cd("cD"), { status: 2, caseNumber: 304, officeName: "事業所D" }], [qd("qD"), quote("qD", "cD", { caseNumber: 304 })]]);
r = await accept("qD");
const shipD = (await shipsOf("cD"))[0];
const PAY = [{ amount: 1000, date: "2026-11-01" }], REF = [{ amount: 1000, date: "2026-11-02" }];
await db.collection("shipments").doc(shipD.id).update({ payments: PAY, refunds: REF });
plan = await cancelLikeScreen(shipD.id);
check("判定は hold（payment）", plan.kind === "hold" && plan.reasons.includes("payment"), JSON.stringify(plan));
const kD = await get(cd("cD")), qD = await get(qd("qD")), sD = await get(db.collection("shipments").doc(shipD.id));
check("案件・見積もりはそのまま", kD.status === 3 && kD.orderedAt instanceof TS && !kD.shipCancelRevert && qD.status === "accepted");
check("入金・返金の記録はそのまま", JSON.stringify(sD.payments) === JSON.stringify(PAY) && JSON.stringify(sD.refunds) === JSON.stringify(REF));
check("保留の対応記録", (await actsOf("cD")).some((a) => /自動では戻していません/.test(a.subject) && /入金（請求）があるため自動では戻しません。確認してください/.test(a.body)));

// ---------- E. 一部だけのキャンセル → 何もしない ----------
section("E. 一部だけのキャンセル（ほかに生きた出荷がある）");
await seed([[cd("cE"), { status: 2, caseNumber: 305, officeName: "事業所E" }], [qd("qE"), quote("qE", "cE", { caseNumber: 305 })]]);
r = await accept("qE");
await db.collection("shipments").doc("shipE2").set({ soNumber: "SH-E2", caseId: "cE", status: "draft", createdAt: TS.now() });
const shipE = (await shipsOf("cE")).find((s) => s.id !== "shipE2");
plan = await cancelLikeScreen(shipE.id);
check("判定は none・案件と見積もりはそのまま", plan.kind === "none" && (await get(cd("cE"))).status === 3 && (await get(qd("qE"))).status === "accepted");

// ---------- F. 承諾書で受注した案件 ----------
section("F. 承諾書で受注した案件 → 取り直しの印 → 新しい承諾書で受注確定すると印が消える");
await setSwitch(true);
await seed([[cd("cF"), { status: 2, caseNumber: 306, officeName: "事業所F" }], [qd("qF"), quote("qF", "cF", { caseNumber: 306 })]]);
r = await call("staffAcceptQuote", STAFF, { quoteId: "qF", payMethod: "after", sendMail: false, consent: { signedName: "鈴木 一郎", receivedDate: TODAY, receivedVia: "fax" } });
check("承諾書で受注確定", r.ok, JSON.stringify(r).slice(0, 200));
const tok1 = r.ok ? r.r.consentToken : "";
const shipF = (await shipsOf("cF"))[0];
plan = await cancelLikeScreen(shipF.id);
let kF = await get(cd("cF"));
check("判定は revert・承諾書の印（理由 ship_canceled）・承諾書のトークンは残す", plan.kind === "revert" && kF.status === 2
  && kF.orderConsentStale === true && kF.orderConsentStaleReason === "ship_canceled" && kF.orderConsentToken === tok1);
check("戻した案件（実際の保存値）は受注前: 失注→受注確定を手で選べない", !hasActiveOrder(kF)
  && statusChangeGuard({ from: 4, to: 3, orderByConsent: true, isAdmin: false, caseData: { ...kF, status: 4 } }).kind === "blocked");
check("見積もりは発行中（前の承諾書のトークンは prevAccept に）", (await get(qd("qF"))).status === "issued" && (await get(qd("qF"))).prevAccept.consentToken === tok1);
r = await call("staffAcceptQuote", STAFF, { quoteId: "qF", payMethod: "after", sendMail: false, consent: { signedName: "鈴木 一郎", receivedDate: TODAY, receivedVia: "post" } });
kF = await get(cd("cF"));
check("新しい承諾書で受注確定 → 新しいトークン・印が消える・案件3", r.ok && kF.orderConsentToken && kF.orderConsentToken !== tok1
  && kF.orderConsentStale === false && kF.status === 3, JSON.stringify(r).slice(0, 300));
check("印を下ろしたら理由（orderConsentStaleReason）も消える（小さな指摘4）", !("orderConsentStaleReason" in kF));
check("取り直しで受注確定したあとは通常どおり（有効な受注として数える）", hasActiveOrder(kF)
  && statusChangeGuard({ from: 4, to: 3, orderByConsent: true, isAdmin: false, caseData: { ...kF, status: 4 } }).kind === "ok");
await setSwitch(false);

// ---------- G. ルールが効いていること ----------
section("G. 閲覧のみ（viewer）の人はキャンセルを書けない（ルールを通している確かめ）");
await seed([[cd("cG"), { status: 2, caseNumber: 307, officeName: "事業所G" }], [qd("qG"), quote("qG", "cG", { caseNumber: 307 })]]);
r = await accept("qG");
const shipG = (await shipsOf("cG"))[0];
let gErr = null;
try { await cancelLikeScreen(shipG.id, { as: VIEWER }); } catch (e) { gErr = e; }
check("viewer: 拒否される（permission-denied）", !!gErr && /permission|PERMISSION_DENIED/i.test(String(gErr.code || gErr.message)), String(gErr && (gErr.code || gErr.message)));
check("viewer: 出荷・案件・見積もりは何も変わらない", (await get(db.collection("shipments").doc(shipG.id))).status === "draft"
  && (await get(cd("cG"))).status === 3 && (await get(qd("qG"))).status === "accepted");
plan = await cancelLikeScreen(shipG.id);
check("同じ出荷を職員（staff）なら戻せる", plan.kind === "revert" && (await get(cd("cG"))).status === 2);

// ---------- H. 認定事業者の受注から作った出荷 ----------
// 画面（supply.js doCancelShipment）と同じ手順: 戻し先の検証 → 同じ受注の出荷を先に読む → トランザクションで出荷・受注を読み直し → 判定 → 書き込み
async function cancelPartnerLikeScreen(shipId, { choice = "", by = "職員 太郎", reason = "事業所の都合", as = STAFF, openKind = "ask" } = {}) {
  const cdb = clientDb(as);
  const { doc: cdoc, collection: ccol, query: cquery, where: cwhere, getDoc: cgetDoc, getDocs: cgetDocs, runTransaction: crun,
    serverTimestamp: cnow, arrayUnion: cunion } = CF;
  const shipRef = cdoc(cdb, "shipments", shipId);
  const pre = (await cgetDoc(shipRef)).data();
  if (isPartnerOrderShipment(pre) && openKind === "ask") { const bad = validateOrderReturn(choice); if (bad) throw new Error(bad); }
  const poSibIds = isPartnerOrderShipment(pre)
    ? (await cgetDocs(cquery(ccol(cdb, "shipments"), cwhere("partnerOrderId", "==", pre.partnerOrderId)))).docs.map((d) => d.id).filter((id) => id !== shipId)
    : [];
  let orderPlan = { kind: "none" };
  await crun(cdb, async (tx) => {
    const cur = (await tx.get(shipRef)).data();
    let poRef = null, order = null;
    if (isPartnerOrderShipment(cur)) {
      poRef = cdoc(cdb, "partnerOrders", cur.partnerOrderId);
      const ps = await tx.get(poRef);
      order = ps.exists() ? ps.data() : null;
      const sibs = [];
      for (const id of poSibIds) { const d = await tx.get(cdoc(cdb, "shipments", id)); if (d.exists()) sibs.push({ _id: d.id, ...d.data() }); }
      orderPlan = planOrderOnShipCancel({ ship: { _id: shipId, ...cur }, order, shipments: sibs });
      if (orderPlan.kind !== openKind) throw new Error("stale");
    }
    const w = orderPlan.kind === "ask"
      ? orderReturnWrites({ order, ship: { _id: shipId, ...cur }, choice, by, now: cnow(), nowIso: new Date().toISOString(), cancelReason: reason })
      : null;
    tx.update(shipRef, { status: "canceled", statusBeforeCancel: cur.status, canceledAt: cnow(), canceledBy: by,
      cancelReason: reason, cancelNote: "", updatedAt: cnow(), ...(w ? w.shipPatch : {}) });
    if (w) tx.update(poRef, { ...w.orderPatch, shipCancelLog: cunion(w.logEntry) });
  });
  return orderPlan;
}
const pod = (id) => db.collection("partnerOrders").doc(id);
const sd = (id) => db.collection("shipments").doc(id);
const poSeed = (id, status) => [pod(id), { soNumber: `SO-T-${id}`, partnerOrderNo: `P-${id}`, partnerEmail: "p@example.test", partnerName: "認定A",
  status, items: [{ sku: "cir415a-01", qty: 1 }], createdAt: TS.now() }];
const shipSeed = (id, poId, status, extra = {}) => [sd(id), { soNumber: `SH-${id}`, shipType: "dropship", partnerOrderId: poId, status,
  items: [{ sku: "cir415a-01", name: "R", qty: 1, unitPrice: 1000 }], createdAt: TS.now(), ...extra }];

section("H1. 依頼済の出荷（受注確定）をキャンセル → 「受注確定に戻す」");
await seed([poSeed("po1", "confirmed"), shipSeed("sh1", "po1", "requested")]);
plan = await cancelPartnerLikeScreen("sh1", { choice: "confirmed" });
let po = await get(pod("po1")), sh = await get(sd("sh1"));
check("判定は ask・出荷はキャンセル", plan.kind === "ask" && sh.status === "canceled" && sh.statusBeforeCancel === "requested");
check("受注: 受注確定・最後のキャンセル（誰が・何を選んだか・サーバー時刻）", po.status === "confirmed" && po.lastShipCancel
  && po.lastShipCancel.by === "職員 太郎" && po.lastShipCancel.to === "confirmed" && po.lastShipCancel.from === "confirmed"
  && po.lastShipCancel.choiceLabel === "受注確定に戻す" && po.lastShipCancel.shipSoNumber === "SH-sh1" && po.lastShipCancel.at instanceof TS
  && po.updatedAt instanceof TS, JSON.stringify(po.lastShipCancel));
check("受注: 記録（shipCancelLog）に1行", Array.isArray(po.shipCancelLog) && po.shipCancelLog.length === 1 && po.shipCancelLog[0].to === "confirmed"
  && po.shipCancelLog[0].by === "職員 太郎" && /^\d{4}-\d{2}-\d{2}T/.test(po.shipCancelLog[0].at) && po.shipCancelLog[0].cancelReason === "事業所の都合");
check("出荷: partnerOrderReturn に戻し先", sh.partnerOrderReturn && sh.partnerOrderReturn.orderId === "po1" && sh.partnerOrderReturn.to === "confirmed"
  && sh.partnerOrderReturn.orderSoNumber === "SO-T-po1" && sh.partnerOrderReturn.by === "職員 太郎");
check("受注の発注内容・相手はそのまま", po.partnerEmail === "p@example.test" && po.items.length === 1 && po.soNumber === "SO-T-po1");

section("H2. 発送済の出荷（受注 出荷済）をキャンセル → 「受付済に戻す」。2回目のキャンセルで記録が積み重なる");
await seed([poSeed("po2", "shipped"), shipSeed("sh2", "po2", "shipped")]);
plan = await cancelPartnerLikeScreen("sh2", { choice: "received" });
po = await get(pod("po2"));
check("受注: 出荷済 → 受付済", plan.kind === "ask" && po.status === "received" && po.lastShipCancel.from === "shipped" && po.lastShipCancel.to === "received");
await seed([shipSeed("sh2b", "po2", "requested")]);
await pod("po2").update({ status: "confirmed" });
plan = await cancelPartnerLikeScreen("sh2b", { choice: "canceled", by: "職員 花子" });
po = await get(pod("po2"));
check("2回目: 受注もキャンセル・記録は2行（古い行も残る）", po.status === "canceled" && po.shipCancelLog.length === 2
  && po.shipCancelLog[0].to === "received" && po.shipCancelLog[1].to === "canceled" && po.shipCancelLog[1].by === "職員 花子"
  && po.lastShipCancel.by === "職員 花子", JSON.stringify(po.shipCancelLog));

section("H3. 戻し先を選ばない → 何も変わらない");
await seed([poSeed("po3", "shipped"), shipSeed("sh3", "po3", "shipped")]);
let hErr = null;
try { await cancelPartnerLikeScreen("sh3", { choice: "" }); } catch (e) { hErr = e; }
check("選ばないと止まる", !!hErr && /選んでください/.test(hErr.message), String(hErr && hErr.message));
check("出荷・受注はそのまま", (await get(sd("sh3"))).status === "shipped" && (await get(pod("po3"))).status === "shipped" && !(await get(pod("po3"))).lastShipCancel);

section("H4. 閲覧のみ（viewer）→ 書けない");
hErr = null;
try { await cancelPartnerLikeScreen("sh3", { choice: "confirmed", as: VIEWER }); } catch (e) { hErr = e; }
check("viewer: 拒否される（permission-denied）", !!hErr && /permission|PERMISSION_DENIED/i.test(String(hErr.code || hErr.message)), String(hErr && (hErr.code || hErr.message)));
check("viewer: 出荷・受注は何も変わらない", (await get(sd("sh3"))).status === "shipped" && (await get(pod("po3"))).status === "shipped"
  && !(await get(sd("sh3"))).partnerOrderReturn);

section("H5. 通常の出荷（受注から作っていない）→ 受注に触れない");
await seed([poSeed("po5", "shipped"), [sd("sh5"), { soNumber: "SH-sh5", shipType: "office", status: "requested", items: [], createdAt: TS.now() }]]);
plan = await cancelPartnerLikeScreen("sh5", { openKind: "none" });
check("判定は none・出荷はキャンセル・partnerOrderReturn なし", plan.kind === "none" && (await get(sd("sh5"))).status === "canceled"
  && !("partnerOrderReturn" in (await get(sd("sh5")))));
check("受注はそのまま", (await get(pod("po5"))).status === "shipped" && !(await get(pod("po5"))).lastShipCancel);

section("H6. 同じ受注にほかの生きた出荷がある → 受注は変えない");
await seed([poSeed("po6", "confirmed"), shipSeed("sh6a", "po6", "requested"), shipSeed("sh6b", "po6", "draft")]);
plan = await cancelPartnerLikeScreen("sh6a", { openKind: "others" });
check("判定は others・出荷はキャンセル・受注はそのまま", plan.kind === "others" && (await get(sd("sh6a"))).status === "canceled"
  && (await get(pod("po6"))).status === "confirmed" && !(await get(pod("po6"))).lastShipCancel);

section("H7. 画面を開いたあとで、同じ受注に生きた出荷が増えた → 止まる（何も変わらない）");
await seed([poSeed("po7", "confirmed"), shipSeed("sh7", "po7", "requested")]);
// 画面を開いたとき（ask）のあとに別の出荷ができた。同じ受注の出荷の一覧は先に読むので、ここでは一覧に入る前に作る
await seed([shipSeed("sh7b", "po7", "draft")]);
hErr = null;
try { await cancelPartnerLikeScreen("sh7", { choice: "confirmed", openKind: "ask" }); } catch (e) { hErr = e; }
check("食い違いで止まる", !!hErr && /stale/.test(hErr.message), String(hErr && hErr.message));
check("出荷・受注はそのまま", (await get(sd("sh7"))).status === "requested" && !(await get(pod("po7"))).lastShipCancel);

await testEnv.cleanup();
console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
