// 倉庫の Callable（warehouseList / warehouseShip / warehouseHandover / warehouseReject / warehouseFixTracking）と
// 出荷指示（notifyShipment）の持ち出しの文面を、Firestore エミュレータに対して実際に動かして確かめる（2026-10-24）。
// 設計: docs/倉庫メニュー_設計_20261024.md §9。進め方は scripts/test-office-merge-emu.mjs と同じ（.run() で直接呼ぶ）。
//
// 実行（本番に繋がらない demo- プロジェクト。依存は functions/node_modules をそのまま使う）:
//   export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
//   cd <repo> && firebase emulators:exec --only firestore --project demo-warehouse-test \
//     "node scripts/test-warehouse-emu.mjs"
// 終了コード: 全部合格 0、1件でも不合格 1。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-warehouse-test";
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";
// 外部へは出さない。Chat の投稿先（テスト用の偽 URL）への投稿は中身を控えて 200 を返す。それ以外は即失敗
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
const require = createRequire(path.join(REPO, "functions", "index.js"));
const fns = require(path.join(REPO, "functions", "index.js"));
const admin = require("firebase-admin");
const db = admin.firestore();
const TS = admin.firestore.Timestamp;

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); }

const WH1 = "wh1@tadakayo.jp", WH2 = "wh2@tadakayo.jp", WHOFF = "whoff@tadakayo.jp";
const STAFF = "staff@tadakayo.jp", ADMIN = "admin@tadakayo.jp", LEGACY = "legacy@tadakayo.jp";
const VIEWER = "viewer@tadakayo.jp", TRAINEE = "trainee@tadakayo.jp", MOCHI = "mochi@tadakayo.jp";
async function call(name, email, data) {
  try {
    const r = await fns[name].run({ auth: { uid: "uid-" + email, token: { email, name: email } }, data, rawRequest: {} });
    return { ok: true, r };
  } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
const sh = (id) => db.collection("shipments").doc(id);
const get = async (ref) => (await ref.get()).data();
const prod = async (sku) => get(db.collection("products").doc(sku));
const movesOf = async (refNo) => (await db.collection("inventoryMovements").where("refNo", "==", refNo).get()).docs.map((d) => d.data());
const ymd = (daysAgo) => new Date(Date.now() + 9 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
const TODAY = ymd(0);

async function seed(items) {
  const b = db.batch();
  for (const [ref, d] of items) b.set(ref, d);
  await b.commit();
}
const base = (o) => ({
  status: "requested", soNumber: o.soNumber, officeName: "テスト事業所", company: "テスト法人", contactName: "受取人",
  postal: "100-0001", address: "東京都千代田区1-1", phone: "03-0000-0000",
  items: [{ sku: "BT", name: "カードリーダーBT", qty: 2, unitPrice: 9800, amount: 19600 }, { sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 50000, nonStock: true }],
  caseId: "case-secret", quoteId: "quote-secret", total: 69600, invoiceNo: "INV-SECRET", payMethod: "before",
  requestedBy: "依頼する人", requestedByEmail: STAFF, requestedAt: TS.now(), shipDate: TODAY, letterPackType: "plus",
  ...o,
});

await seed([
  [db.collection("users").doc(WH1), { active: true, role: "warehouse", name: "倉庫1", locationIds: ["L1"] }],
  [db.collection("users").doc(WH2), { active: true, role: "warehouse", name: "倉庫2", locationIds: ["L2"] }],
  [db.collection("users").doc(WHOFF), { active: false, role: "warehouse", name: "倉庫停止", locationIds: ["L1"] }],
  [db.collection("users").doc(STAFF), { active: true, role: "staff", name: "職員", chatUserId: "111111111111" }],
  [db.collection("users").doc(ADMIN), { active: true, role: "admin", name: "管理" }],
  [db.collection("users").doc(LEGACY), { active: true, name: "旧登録" }],
  [db.collection("users").doc(VIEWER), { active: true, role: "viewer", name: "閲覧" }],
  [db.collection("users").doc(TRAINEE), { active: true, role: "trainee", name: "練習" }],
  [db.collection("users").doc(MOCHI), { active: true, role: "staff", name: "持出太郎", chatUserId: "987654321098" }],
  [db.collection("locations").doc("L1"), { name: "東京倉庫", isDefault: true, active: true }],
  [db.collection("locations").doc("L2"), { name: "大阪倉庫", active: true }],
  [db.collection("products").doc("BT"), { name: "カードリーダーBT", stock: 20, stockByLocation: { L1: 10, L2: 10 }, price: 9800 }],
  [db.collection("appConfig").doc("settings"), { shippingChatWebhookUrl: HOOK, shippingChatWebhookEnabled: true }],
  [db.collection("partnerOrders").doc("po1"), { status: "confirmed" }],
  [sh("s1"), base({ soNumber: "SH-1", originLocationId: "L1", originLocationName: "東京倉庫", partnerOrderId: "po1" })],
  [sh("s2"), base({ soNumber: "SH-2", deliveryMode: "pickup", pickupByEmail: MOCHI, pickupByName: "持出太郎", pickupDate: TODAY, letterPackType: null })], // 出荷元なし → 既定 L1
  [sh("s3"), base({ soNumber: "SH-3", originLocationId: "L2", originLocationName: "大阪倉庫" })],
  [sh("s4"), base({ soNumber: "SH-4", originLocationId: "L1", items: [{ sku: "BT", qty: 50 }] })],
  [sh("s5"), base({ soNumber: "SH-5", originLocationId: "L1", items: [{ sku: "BT", qty: 1 }] })],
  [sh("s6"), base({ soNumber: "SH-6", originLocationId: "L1", items: [{ sku: "BT", qty: 1 }] })],
  [sh("s7"), base({ soNumber: "SH-7", originLocationId: "L2", items: [{ sku: "BT", qty: 1 }] })],
  [sh("sd"), base({ soNumber: "SH-D", originLocationId: "L1", fulfillment: "direct" })],
  [sh("sdraft"), base({ soNumber: "SH-DR", originLocationId: "L1", status: "draft" })],
  [sh("done1"), base({ soNumber: "SH-OK", originLocationId: "L1", status: "shipped", shipDate: ymd(5), trackingNumber: "111" })],
  [sh("done2"), base({ soNumber: "SH-OLD", originLocationId: "L1", status: "invoiced", shipDate: ymd(40), trackingNumber: "222" })],
  [sh("done3"), base({ soNumber: "SH-PK", originLocationId: "L1", status: "shipped", shipDate: ymd(3), deliveryMode: "pickup" })],
  [sh("done4"), base({ soNumber: "SH-L2", originLocationId: "L2", status: "paid", shipDate: ymd(2) })],
]);

// ---------- 1. 権限 ----------
section("1. 権限（warehouseList）");
const matrix = [
  [WH1, "L1", true], [WH1, "L2", false], [WH2, "L2", true], [WH2, "L1", false], [WHOFF, "L1", false],
  [STAFF, "L1", true], [STAFF, "L2", true], [ADMIN, "L2", true], [LEGACY, "L1", true],
  [VIEWER, "L1", false], [TRAINEE, "L1", false], ["outsider@example.com", "L1", false], ["unreg@tadakayo.jp", "L1", false],
];
for (const [who, loc, ok] of matrix) {
  const r = await call("warehouseList", who, { locationId: loc });
  check(`${who} ${loc} → ${ok ? "使える" : "permission-denied"}`, ok ? r.ok : (!r.ok && r.code === "permission-denied"), JSON.stringify(r).slice(0, 200));
}
let r = await call("warehouseList", STAFF, { locationId: 5 });
check("locationId が文字列でなければ invalid-argument", !r.ok && r.code === "invalid-argument");
r = await call("warehouseList", STAFF, { locationId: "NOPE" });
check("無い保管場所は not-found", !r.ok && r.code === "not-found", JSON.stringify(r));
// 倉庫の人は既存の Callable（editor）を使えない
r = await call("updateOffice", WH1, { officeId: "x", patch: { phone: "1" } });
check("倉庫の人は updateOffice を使えない", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("notifyShipment", WH1, { shipmentId: "s1" });
check("倉庫の人は notifyShipment を使えない", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("previewDailyFollowup", WH1, {});
check("倉庫の人は admin の Callable を使えない", !r.ok && r.code === "permission-denied");

// ---------- 2. 一覧 ----------
section("2. 一覧（W の項目だけ）");
r = await call("warehouseList", WH1, { locationId: "L1" });
const L = r.r || {};
check("location は東京倉庫", L.location && L.location.id === "L1" && L.location.name === "東京倉庫", JSON.stringify(L.location));
check("locations は扱える場所だけ（WH1 → L1）", JSON.stringify(L.locations) === JSON.stringify([{ id: "L1", name: "東京倉庫" }]), JSON.stringify(L.locations));
const reqNos = (L.requested || []).map((w) => w.soNumber).sort();
check("requested は L1（既定の場所の未設定も含む）の依頼済だけ", JSON.stringify(reqNos) === JSON.stringify(["SH-1", "SH-2", "SH-4", "SH-5", "SH-6"]), JSON.stringify(reqNos));
const doneNos = (L.done || []).map((w) => w.soNumber).sort();
check("done は L1 の直近30日の発送済・受け渡し済", JSON.stringify(doneNos) === JSON.stringify(["SH-OK", "SH-PK"]), JSON.stringify(doneNos));
check("stock は L1 の台数", JSON.stringify(L.stock) === JSON.stringify([{ sku: "BT", name: "カードリーダーBT", qty: 10 }]), JSON.stringify(L.stock));
const json = JSON.stringify(L);
for (const bad of ["case-secret", "quote-secret", "INV-SECRET", "69600", "19600", "9800", "50000", "caseId", "unitPrice", "total", "price", "requestedByEmail", MOCHI]) {
  check(`返す値に ${bad} が無い`, !json.includes(bad));
}
const w2 = (L.requested || []).find((w) => w.soNumber === "SH-2") || {};
check("持ち出しは deliveryMode pickup・pickupByName・pickupDate", w2.deliveryMode === "pickup" && w2.pickupByName === "持出太郎" && w2.pickupDate === TODAY, JSON.stringify(w2));
check("items は sku/name/qty だけ（品物でない行は出さない）", JSON.stringify(w2.items) === JSON.stringify([{ sku: "BT", name: "カードリーダーBT", qty: 2 }]), JSON.stringify(w2.items));
r = await call("warehouseList", ADMIN, { locationId: "L2" });
check("管理者は L2 も見られ、locations は全場所", r.ok && r.r.locations.length === 2 && r.r.requested.map((w) => w.soNumber).sort().join() === "SH-3,SH-7"
  && r.r.done.map((w) => w.soNumber).join() === "SH-L2", JSON.stringify(r.r && [r.r.requested.map((w) => w.soNumber), r.r.done.map((w) => w.soNumber)]));

// ---------- 3. 発送済にする ----------
section("3. warehouseShip");
r = await call("warehouseShip", WH1, { shipmentId: "s3", shipDate: TODAY });
check("WH1 は L2 の出荷を発送済にできない", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("warehouseShip", WH1, { shipmentId: "s1", shipDate: "2026/10/24" });
check("日付の形が違えば invalid-argument", !r.ok && r.code === "invalid-argument");
r = await call("warehouseShip", WH1, { shipmentId: "s1", shipDate: TODAY, letterPackType: "big" });
check("レターパックの種類が違えば invalid-argument", !r.ok && r.code === "invalid-argument");
r = await call("warehouseShip", WH1, { shipmentId: "s2", shipDate: TODAY });
check("持ち出しは発送済にできない（受け渡し済を使う）", !r.ok && r.code === "failed-precondition", JSON.stringify(r));
r = await call("warehouseShip", WH1, { shipmentId: "sd", shipDate: TODAY });
check("直送は扱わない", !r.ok && r.code === "failed-precondition");
r = await call("warehouseShip", WH1, { shipmentId: "sdraft", shipDate: TODAY });
check("下書きは発送済にできない", !r.ok && r.code === "failed-precondition");
r = await call("warehouseShip", VIEWER, { shipmentId: "s1", shipDate: TODAY });
check("閲覧のみは発送済にできない", !r.ok && r.code === "permission-denied");
r = await call("warehouseShip", WH1, { shipmentId: "s1", shipDate: TODAY, trackingNumber: " 1234-5678 ", letterPackType: "light" });
check("WH1 が s1 を発送済にできる", r.ok && r.r.ok === true, JSON.stringify(r));
let s = await get(sh("s1")), p = await prod("BT");
check("状態 shipped・発送日・追跡番号・レターパック", s.status === "shipped" && s.shipDate === TODAY && s.trackingNumber === "1234-5678" && s.letterPackType === "light", JSON.stringify([s.status, s.shipDate, s.trackingNumber, s.letterPackType]));
check("shippedBy*・dueRule net14・confirmedAt・出荷元", s.shippedByEmail === WH1 && s.shippedBy === "倉庫1" && s.dueRule === "net14" && !!s.shippedAt && !!s.confirmedAt && s.originLocationId === "L1" && s.originLocationName === "東京倉庫");
check("在庫: 合計 20→18・L1 10→8・L2 は 10 のまま", p.stock === 18 && p.stockByLocation.L1 === 8 && p.stockByLocation.L2 === 10, JSON.stringify(p));
let mv = await movesOf("SH-1");
check("inventoryMovements: 1件・-2・shipment・L1", mv.length === 1 && mv[0].delta === -2 && mv[0].reason === "shipment" && mv[0].sku === "BT" && mv[0].locationId === "L1" && mv[0].locationName === "東京倉庫" && mv[0].userName === "倉庫1", JSON.stringify(mv));
check("認定事業者の受注も出荷済", (await get(db.collection("partnerOrders").doc("po1"))).status === "shipped");
r = await call("warehouseShip", WH1, { shipmentId: "s1", shipDate: TODAY });
check("もう一度押すと failed-precondition・在庫は動かない", !r.ok && r.code === "failed-precondition" && (await prod("BT")).stockByLocation.L1 === 8);
r = await call("warehouseShip", WH1, { shipmentId: "s4", shipDate: TODAY });
s = await get(sh("s4")); p = await prod("BT");
check("在庫不足は止まる（failed-precondition・在庫不足の文言）", !r.ok && r.code === "failed-precondition" && /在庫不足/.test(r.msg), JSON.stringify(r));
check("在庫不足のとき出荷も在庫も変わらない", s.status === "requested" && p.stockByLocation.L1 === 8 && (await movesOf("SH-4")).length === 0);
r = await call("warehouseShip", WH1, { shipmentId: "nope", shipDate: TODAY });
check("無い出荷は not-found", !r.ok && r.code === "not-found");

// ---------- 4. 受け渡し済にする ----------
section("4. warehouseHandover（持ち出し）");
r = await call("warehouseHandover", WH1, { shipmentId: "s5", date: TODAY });
check("発送の出荷は受け渡し済にできない", !r.ok && r.code === "failed-precondition");
r = await call("warehouseHandover", WH2, { shipmentId: "s2", date: TODAY });
check("WH2 は L1（既定）の持ち出しを扱えない", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("warehouseHandover", WH1, { shipmentId: "s2", date: ymd(1) });
s = await get(sh("s2")); p = await prod("BT");
check("WH1 が s2 を受け渡し済にできる", r.ok && r.r.ok === true, JSON.stringify(r));
check("状態 shipped・shipDate=受け渡し日・handedOver*・shippedBy*", s.status === "shipped" && s.shipDate === ymd(1) && s.handedOverByEmail === WH1 && s.handedOverByName === "倉庫1" && !!s.handedOverAt && s.shippedByEmail === WH1 && s.dueRule === "net14");
check("在庫は既定の場所 L1 から引く（8→6）", p.stockByLocation.L1 === 6 && p.stock === 16, JSON.stringify(p));
mv = await movesOf("SH-2");
check("inventoryMovements: 1件・-2・L1", mv.length === 1 && mv[0].delta === -2 && mv[0].locationId === "L1");
r = await call("warehouseHandover", WH1, { shipmentId: "s2", date: TODAY });
check("二度目は failed-precondition", !r.ok && r.code === "failed-precondition");

// ---------- 5. 出荷できない ----------
section("5. warehouseReject");
r = await call("warehouseReject", WH1, { shipmentId: "s5", reason: "other", note: "" });
check("その他でメモなしは invalid-argument", !r.ok && r.code === "invalid-argument");
r = await call("warehouseReject", WH1, { shipmentId: "s5", reason: "x", note: "a" });
check("不明な理由は invalid-argument", !r.ok && r.code === "invalid-argument");
r = await call("warehouseReject", WH1, { shipmentId: "s3", reason: "shortage", note: "" });
check("WH1 は L2 の出荷を差し戻せない", !r.ok && r.code === "permission-denied");
posted.length = 0;
r = await call("warehouseReject", WH1, { shipmentId: "s5", reason: "address", note: "番地がありません" });
check("差し戻しできる・notified true", r.ok && r.r.ok === true && r.r.notified === true, JSON.stringify(r));
s = await get(sh("s5"));
check("warehouseIssue が記録され、状態は依頼済のまま", s.status === "requested" && s.warehouseIssue && s.warehouseIssue.reason === "address" && s.warehouseIssue.note === "番地がありません" && s.warehouseIssue.byEmail === WH1 && s.warehouseIssue.byName === "倉庫1" && !!s.warehouseIssue.at, JSON.stringify(s.warehouseIssue));
const rt = (posted[0] && posted[0].text) || "";
check("依頼した人へメンション（<users/111111111111>）・理由・倉庫の画面", /<users\/111111111111>/.test(rt) && /届け先の情報が足りない・違う/.test(rt) && /番地がありません/.test(rt) && rt.includes("https://kjk-tadakayo-admin.web.app/warehouse"), rt);
check("差し戻しの投稿に金額・案件ID が無い", !/69600|case-secret|INV-SECRET/.test(rt));
r = await call("warehouseReject", WH1, { shipmentId: "s5", reason: "shortage", note: "" });
check("二重の差し戻しは failed-precondition（記録は最初のまま）", !r.ok && r.code === "failed-precondition" && (await get(sh("s5"))).warehouseIssue.reason === "address", JSON.stringify(r));
check("二重の差し戻しでは投稿しない", posted.length === 1);
r = await call("warehouseList", WH1, { locationId: "L1" });
const w5 = r.r.requested.find((w) => w.soNumber === "SH-5") || {};
check("一覧の warehouseIssue（byEmail は返さない）", w5.warehouseIssue && w5.warehouseIssue.reason === "address" && !("byEmail" in w5.warehouseIssue) && typeof w5.warehouseIssue.at === "string", JSON.stringify(w5.warehouseIssue));
r = await call("warehouseShip", WH1, { shipmentId: "s5", shipDate: TODAY });
check("差し戻し中でも発送済にでき、warehouseIssue は消える", r.ok && !(await get(sh("s5"))).warehouseIssue, JSON.stringify(r));
await db.collection("appConfig").doc("settings").update({ shippingChatWebhookEnabled: false });
posted.length = 0;
r = await call("warehouseReject", STAFF, { shipmentId: "s6", reason: "shortage" });
check("投稿先が停止中なら notified false（記録は残る）", r.ok && r.r.notified === false && (await get(sh("s6"))).warehouseIssue.reason === "shortage" && posted.length === 0, JSON.stringify(r));
await db.collection("appConfig").doc("settings").update({ shippingChatWebhookEnabled: true });

// ---------- 6. 追跡番号の訂正 ----------
section("6. warehouseFixTracking");
r = await call("warehouseFixTracking", WH1, { shipmentId: "done1", trackingNumber: " 999 " });
s = await get(sh("done1"));
check("直近30日の発送済は直せる", r.ok && s.trackingNumber === "999" && s.trackingFixedByEmail === WH1, JSON.stringify(r));
check("追跡番号以外は変えない（状態・在庫）", s.status === "shipped" && (await prod("BT")).stockByLocation.L1 === 5);
r = await call("warehouseFixTracking", WH1, { shipmentId: "done2", trackingNumber: "1" });
check("40日前の出荷は直せない", !r.ok && r.code === "failed-precondition" && (await get(sh("done2"))).trackingNumber === "222", JSON.stringify(r));
r = await call("warehouseFixTracking", WH1, { shipmentId: "done3", trackingNumber: "1" });
check("持ち出しには追跡番号が無い", !r.ok && r.code === "failed-precondition");
r = await call("warehouseFixTracking", WH1, { shipmentId: "done4", trackingNumber: "1" });
check("WH1 は L2 の出荷を直せない", !r.ok && r.code === "permission-denied");
r = await call("warehouseFixTracking", WH1, { shipmentId: "s6", trackingNumber: "1" });
check("依頼済は直せない", !r.ok && r.code === "failed-precondition");
r = await call("warehouseFixTracking", WH1, { shipmentId: "done1" });
check("追跡番号が無ければ invalid-argument", !r.ok && r.code === "invalid-argument");

// ---------- 7. 同時に押す ----------
section("7. 同時に3回押しても在庫は1回だけ引く");
const before7 = await prod("BT");
const rs = await Promise.all([
  call("warehouseShip", WH2, { shipmentId: "s7", shipDate: TODAY }),
  call("warehouseShip", STAFF, { shipmentId: "s7", shipDate: TODAY }),
  call("warehouseShip", ADMIN, { shipmentId: "s7", shipDate: TODAY }),
]);
const after7 = await prod("BT");
check("成功は1回だけ", rs.filter((x) => x.ok).length === 1, JSON.stringify(rs.map((x) => x.ok ? "ok" : x.code)));
check("L2 の在庫は1だけ減る", after7.stockByLocation.L2 === before7.stockByLocation.L2 - 1 && after7.stock === before7.stock - 1, JSON.stringify([before7, after7]));
check("在庫の動きの記録も1件", (await movesOf("SH-7")).length === 1);

// ---------- 8. 出荷指示（notifyShipment）の文面 ----------
section("8. notifyShipment（持ち出し・発送）");
await seed([
  [sh("n1"), base({ soNumber: "SH-N1", deliveryMode: "pickup", pickupByEmail: MOCHI, pickupByName: "持出太郎", pickupDate: "2026-11-05", originLocationId: "L1", originLocationName: "東京倉庫" })],
  [sh("n2"), base({ soNumber: "SH-N2", originLocationId: "L1", originLocationName: "東京倉庫" })],
]);
posted.length = 0;
r = await call("notifyShipment", STAFF, { shipmentId: "n1" });
const pt = (posted[0] && posted[0].text) || "";
check("持ち出しの投稿ができる", r.ok && r.r.posted === true, JSON.stringify(r));
check("【持ち出し】・持ち出す人へメンション・予定日・保管場所・品と数", /【持ち出し】/.test(pt) && /<users\/987654321098>/.test(pt) && /2026-11-05/.test(pt) && /東京倉庫/.test(pt) && /BT（カードリーダーBT） × 2台/.test(pt), pt);
check("持ち出しの投稿にレターパック・追跡番号・宛名印刷が無い", !/レターパック|追跡番号|宛名/.test(pt), pt);
check("持ち出しの投稿の末尾に倉庫の画面", pt.trim().endsWith("🏬 倉庫の画面: https://kjk-tadakayo-admin.web.app/warehouse"), pt.slice(-80));
posted.length = 0;
r = await call("notifyShipment", STAFF, { shipmentId: "n2" });
const st = (posted[0] && posted[0].text) || "";
check("発送の投稿は従来の見出し・レターパック・宛名印刷", /^📦 出荷指示 — SH-N2/.test(st) && /■ レターパックの種類: レターパックプラス（赤）/.test(st) && /🖨 レターパックの宛名印刷:/.test(st) && /👉 CRMの出荷:/.test(st), st);
check("発送の投稿の末尾に倉庫の画面", st.trim().endsWith("🏬 倉庫の画面: https://kjk-tadakayo-admin.web.app/warehouse") && !/【持ち出し】/.test(st), st.slice(-80));
const btns = JSON.stringify(posted[0] && posted[0].cardsV2);
check("カードに「倉庫の画面で開く」ボタン", /倉庫の画面で開く/.test(btns));
// 直送に持ち出しの印が残っていても、持ち出しの文面にしない（canPickup）・倉庫で受け渡しもできない
await seed([[sh("n3"), base({ soNumber: "SH-N3", fulfillment: "direct", deliveryMode: "pickup", pickupByEmail: MOCHI, pickupByName: "持出太郎", pickupDate: "2026-11-05" })]]);
posted.length = 0;
r = await call("notifyShipment", STAFF, { shipmentId: "n3" });
const dt = (posted[0] && posted[0].text) || "";
check("直送＋pickup の出荷指示は発送の文面（【持ち出し】もメンションも無し）", r.ok && /^📦 出荷指示 — SH-N3/.test(dt) && !/【持ち出し】|<users\/987654321098>/.test(dt), dt.slice(0, 120));
r = await call("warehouseHandover", STAFF, { shipmentId: "n3", date: TODAY });
check("直送の持ち出しは受け渡し済にできない", !r.ok && r.code === "failed-precondition", JSON.stringify(r));

// ---------- 9. 場所を指定しないとき（初めて開いたとき・Codex 指摘1）と既定の場所の並び（指摘3） ----------
section("9. locationId が空 → 扱える場所（既定→並びの先頭）を選んで返す");
r = await call("warehouseList", WH1, {});
check("WH1 は空で L1", r.ok && r.r.location.id === "L1", JSON.stringify(r).slice(0, 200));
r = await call("warehouseList", WH2, { locationId: "" });
check("WH2 は空で L2（既定の L1 は扱えないので自分の場所）", r.ok && r.r.location.id === "L2" && r.r.locations.length === 1, JSON.stringify(r).slice(0, 200));
r = await call("warehouseList", STAFF, {});
check("スタッフは空で既定の L1", r.ok && r.r.location.id === "L1");
await db.collection("users").doc("whnone@tadakayo.jp").set({ active: true, role: "warehouse", name: "割当なし", locationIds: [] });
r = await call("warehouseList", "whnone@tadakayo.jp", {});
check("場所の割り当てが無い倉庫の人は permission-denied", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("warehouseList", VIEWER, {});
check("閲覧のみは空でも permission-denied", !r.ok && r.code === "permission-denied");
// 既定の印が無いときは supply.js と同じ並び（sort→名前）の先頭。ID の順ではない
await seed([
  [db.collection("locations").doc("L1"), { name: "東京倉庫", active: true, sort: 2 }],
  [db.collection("locations").doc("L2"), { name: "大阪倉庫", active: true, sort: 1 }],
  [db.collection("locations").doc("L0"), { name: "停止倉庫", active: false, sort: 0, isDefault: true }],
  [sh("sx"), base({ soNumber: "SH-X", items: [{ sku: "BT", qty: 1 }] })], // 出荷元が未設定
]);
r = await call("warehouseList", STAFF, {});
check("isDefault が無い（停止中の既定は除く）→ sort の小さい L2", r.ok && r.r.location.id === "L2" && r.r.locations.map((l) => l.id).join() === "L2,L1", JSON.stringify(r.r && [r.r.location, r.r.locations]));
check("出荷元が未設定の依頼は既定（L2）に並ぶ", r.ok && r.r.requested.some((w) => w.soNumber === "SH-X"));
r = await call("warehouseShip", WH1, { shipmentId: "sx", shipDate: TODAY });
check("WH1 は既定が L2 になった未設定の出荷を発送できない", !r.ok && r.code === "permission-denied", JSON.stringify(r));
const b9 = (await prod("BT")).stockByLocation.L2;
r = await call("warehouseShip", WH2, { shipmentId: "sx", shipDate: TODAY });
check("WH2 が発送でき、L2 から引く", r.ok && (await prod("BT")).stockByLocation.L2 === b9 - 1 && (await get(sh("sx"))).originLocationId === "L2", JSON.stringify(r));

// ---------- 10. 状態が未設定の古い出荷・宛名ラベルの差出人（Codex 指摘3回目 A・C） ----------
section("10. 古い出荷（status なし）と差出人");
await seed([[sh("legacy"), { soNumber: "SH-LEG", originLocationId: "L2", shipDate: ymd(4), trackingNumber: "L1", items: [{ sku: "BT", qty: 1 }], postal: "1", address: "a" }]]);
r = await call("warehouseList", WH2, { locationId: "L2" });
const leg = r.ok && r.r.done.find((w) => w.soNumber === "SH-LEG");
check("status なしの出荷は発送済として done に出る（status: shipped）", !!leg && leg.status === "shipped" && leg.shipDate === ymd(4), JSON.stringify(leg));
check("status なしの出荷は requested に出ない", r.ok && !r.r.requested.some((w) => w.soNumber === "SH-LEG"));
r = await call("warehouseFixTracking", WH2, { shipmentId: "legacy", trackingNumber: "NEW" });
check("status なしの出荷も追跡番号を直せる", r.ok && (await get(sh("legacy"))).trackingNumber === "NEW" && !("status" in (await get(sh("legacy")))), JSON.stringify(r));
r = await call("warehouseShip", WH2, { shipmentId: "legacy", shipDate: TODAY });
check("status なしの出荷は発送済にできない（すでに発送済）", !r.ok && r.code === "failed-precondition");
r = await call("warehouseList", WH2, { locationId: "L2" });
check("差出人: 設定が無ければ印刷ページと同じ既定", r.ok && JSON.stringify(r.r.sender) === JSON.stringify({ name: "NPO法人タダカヨ　介護情報基盤伴走支援事業", postalCode: "", address: "東京都大田区大森中二丁目1番20-1001号", phone: "050-6872-9884" }), JSON.stringify(r.r && r.r.sender));
await db.collection("appConfig").doc("settings").update({ senders: [{ name: "東京センター", postal: "100-0001", address: "千代田区1-1", phone: "03-1111-2222" }, { name: "二件目" }] });
r = await call("warehouseList", WH2, { locationId: "L2" });
check("差出人: 設定の senders の1件目", r.ok && JSON.stringify(r.r.sender) === JSON.stringify({ name: "東京センター", postalCode: "100-0001", address: "千代田区1-1", phone: "03-1111-2222" }), JSON.stringify(r.r && r.r.sender));
const lbl = r.ok && r.r.requested.concat(r.r.done)[0];
check("W に宛名ラベルの項目（postalCode・address・officeName・company・contactName・phone・letterPackType）", !!lbl && ["postalCode", "address", "officeName", "company", "contactName", "phone", "letterPackType"].every((k) => k in lbl), JSON.stringify(lbl));

console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
