// 倉庫の判定（admin/js/warehouse-rules.js・functions/warehouse-rules.mjs はその同一コピー）の単体テスト。
// node scripts/test-warehouse-rules.mjs　設計: docs/倉庫メニュー_設計_20261024.md §9.5
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as W from "../admin/js/warehouse-rules.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

t("functions 側のコピーと同じ", () => {
  assert.equal(readFileSync(new URL("../admin/js/warehouse-rules.js", import.meta.url), "utf8"),
    readFileSync(new URL("../functions/warehouse-rules.mjs", import.meta.url), "utf8"));
});

t("exports はこれだけ（§9.5）", () => {
  assert.deepEqual(Object.keys(W).sort(), [
    "DELIVERY_MODES", "ISSUE_REASONS", "canPickup", "canUseLocation", "defaultLocationIdOf", "deliveryModeOf", "isWarehouseRole",
    "orderLocations", "projectForWarehouse", "senderForLabel", "shipStatusOf", "stockShortage", "validateIssue", "validatePickup", "warehouseActionable",
  ]);
});

t("DELIVERY_MODES・deliveryModeOf", () => {
  assert.deepEqual(W.DELIVERY_MODES, { ship: "発送", pickup: "持ち出し" });
  assert.equal(W.deliveryModeOf({ deliveryMode: "pickup" }), "pickup");
  assert.equal(W.deliveryModeOf({ deliveryMode: "ship" }), "ship");
  assert.equal(W.deliveryModeOf({}), "ship");          // 未設定は今までどおりの発送
  assert.equal(W.deliveryModeOf({ deliveryMode: "x" }), "ship");
  assert.equal(W.deliveryModeOf(null), "ship");
});

t("ISSUE_REASONS", () => {
  assert.deepEqual(W.ISSUE_REASONS, { shortage: "在庫が足りない", address: "届け先の情報が足りない・違う", other: "その他" });
});

t("isWarehouseRole", () => {
  assert.equal(W.isWarehouseRole({ role: "warehouse" }), true);
  assert.equal(W.isWarehouseRole({ role: "staff" }), false);
  assert.equal(W.isWarehouseRole({}), false);
  assert.equal(W.isWarehouseRole(null), false);
});

t("canUseLocation（倉庫は割り当ての場所だけ・管理者/スタッフ/未設定は全場所・閲覧のみ/練習生は不可）", () => {
  const wh = { active: true, role: "warehouse", locationIds: ["L1", "L2"] };
  assert.equal(W.canUseLocation(wh, "L1"), true);
  assert.equal(W.canUseLocation(wh, "L3"), false);
  assert.equal(W.canUseLocation({ ...wh, active: false }, "L1"), false);
  assert.equal(W.canUseLocation({ active: true, role: "warehouse" }, "L1"), false);           // locationIds なし
  assert.equal(W.canUseLocation({ active: true, role: "warehouse", locationIds: "L1" }, "L1"), false); // 配列でない
  for (const role of ["admin", "staff"]) assert.equal(W.canUseLocation({ active: true, role }, "LX"), true, role);
  assert.equal(W.canUseLocation({ active: true }, "LX"), true);                // role 未設定
  assert.equal(W.canUseLocation({ active: true, role: "" }, "LX"), true);
  for (const role of ["viewer", "trainee", "unknown"]) assert.equal(W.canUseLocation({ active: true, role }, "LX"), false, role);
  assert.equal(W.canUseLocation({ role: "admin" }, "LX"), false);             // active が無い
  assert.equal(W.canUseLocation({ active: "true", role: "admin" }, "LX"), false);
  assert.equal(W.canUseLocation({ active: true, role: "admin" }, ""), false);  // 場所の指定なし
  assert.equal(W.canUseLocation({ active: true, role: "admin" }, 1), false);
  assert.equal(W.canUseLocation(null, "L1"), false);
});

t("warehouseActionable（依頼済・直送でない・出荷元がその場所。未設定は既定の場所）", () => {
  const s = { status: "requested", originLocationId: "L1" };
  assert.equal(W.warehouseActionable(s, "L1", "L9"), true);
  assert.equal(W.warehouseActionable(s, "L2", "L9"), false);
  assert.equal(W.warehouseActionable({ status: "requested" }, "L9", "L9"), true);   // 出荷元が未設定 → 既定
  assert.equal(W.warehouseActionable({ status: "requested" }, "L1", "L9"), false);
  assert.equal(W.warehouseActionable({ ...s, fulfillment: "direct" }, "L1", "L9"), false);
  assert.equal(W.warehouseActionable({ ...s, fulfillment: "warehouse" }, "L1", "L9"), true);
  for (const st of ["draft", "shipped", "invoiced", "paid", "canceled", undefined]) {
    assert.equal(W.warehouseActionable({ ...s, status: st }, "L1", "L9"), false, String(st));
  }
  assert.equal(W.warehouseActionable({ ...s, deliveryMode: "pickup" }, "L1", "L9"), true); // 持ち出しも並べる
  assert.equal(W.warehouseActionable(null, "L1", "L9"), false);
  assert.equal(W.warehouseActionable({ status: "requested" }, "", ""), false);
});

t("projectForWarehouse（W の項目だけ・金額/案件ID/請求を出さない）", () => {
  const s = {
    id: "sh1", soNumber: "SH-2026-0001", status: "requested", deliveryMode: "pickup",
    officeName: "A事業所", company: "A法人", contactName: "山田", postal: "100-0001", address: "東京都千代田区1-1", phone: "03-0000-0000",
    items: [
      { sku: "BT", name: "カードリーダーBT", qty: 2, unitPrice: 9800, amount: 19600 },
      { sku: "support-fee", name: "伴走支援費", qty: 1, unitPrice: 50000 },
      { sku: "discount", name: "割引", qty: 1, unitPrice: -1000 },
      { sku: "X", name: "在庫外", qty: 1, nonStock: true },
      { sku: "USB", name: "USB", qty: 0 },
    ],
    shipDate: "2026-11-01", letterPackType: "plus", shipNote: "午前に", note: "旧メモ",
    requestedBy: "依頼者", requestedByEmail: "irai@tadakayo.jp", requestedAt: ts("2026-10-24T01:00:00Z"),
    pickupByName: "持出太郎", pickupByEmail: "mochi@tadakayo.jp", pickupDate: "2026-11-02",
    warehouseIssue: { reason: "address", note: "番地なし", at: ts("2026-10-24T02:00:00Z"), byEmail: "wh@tadakayo.jp", byName: "倉庫花子" },
    // 返してはいけない項目
    caseId: "c1", caseNumber: 12, quoteId: "q1", estNo: "EST-1", total: 19600, subtotal: 1, tax: 1, invoiceNo: "INV-1",
    payments: [{ amount: 1 }], payMethod: "before", partnerEmail: "p@example.jp", officeId: "o1", shippingFee: 520, billTo: {},
  };
  const w = W.projectForWarehouse(s);
  assert.deepEqual(Object.keys(w).sort(), [
    "address", "company", "contactName", "deliveryMode", "desiredDate", "handedOverAt", "handedOverByName", "id", "items",
    "letterPackType", "note", "officeName", "phone", "pickupByName", "pickupDate", "postalCode", "requestedAt", "requestedByName",
    "shipDate", "soNumber", "status", "trackingNumber", "warehouseIssue",
  ].sort());
  assert.equal(w.id, "sh1");
  assert.equal(w.postalCode, "100-0001");
  assert.deepEqual(w.items, [{ sku: "BT", name: "カードリーダーBT", qty: 2 }]);
  assert.equal(w.desiredDate, "2026-11-01");
  assert.equal(w.shipDate, "");                      // 依頼済の shipDate は希望出荷日
  assert.equal(w.note, "午前に");                    // shipNote を優先
  assert.equal(w.requestedByName, "依頼者");
  assert.equal(w.requestedAt, "2026-10-24T01:00:00.000Z");
  assert.deepEqual(w.warehouseIssue, { reason: "address", note: "番地なし", at: "2026-10-24T02:00:00.000Z", byName: "倉庫花子" });
  const json = JSON.stringify(w);
  for (const bad of ["c1", "q1", "EST-1", "INV-1", "19600", "9800", "50000", "irai@", "mochi@", "wh@", "p@example", "unitPrice", "amount", "caseId"]) {
    assert.ok(!json.includes(bad), `漏れている: ${bad}`);
  }
  // 発送済: shipDate は実際の発送日・desiredDate は空・note は note に戻る・未設定は空文字/null
  const d = W.projectForWarehouse({ status: "shipped", shipDate: "2026-10-20", note: "メモ", trackingNumber: "123",
    handedOverAt: new Date("2026-10-20T03:00:00Z"), handedOverByName: "倉庫" });
  assert.equal(d.shipDate, "2026-10-20"); assert.equal(d.desiredDate, ""); assert.equal(d.note, "メモ");
  assert.equal(d.deliveryMode, "ship"); assert.equal(d.trackingNumber, "123");
  assert.equal(d.handedOverAt, "2026-10-20T03:00:00.000Z"); assert.equal(d.requestedAt, null); assert.equal(d.warehouseIssue, null);
  assert.deepEqual(d.items, []);
  assert.equal(W.projectForWarehouse(null).id, "");
});

t("stockShortage（出荷元の場所の在庫・商品マスタに無い品番と nonStock は数えない・同じ品番は合算）", () => {
  const P = { BT: { name: "BT", stockByLocation: { L1: 3, L2: 10 } }, USB: { name: "USB", stockByLocation: { L1: 1 } } };
  assert.deepEqual(W.stockShortage([{ sku: "BT", qty: 3 }], P, "L1"), []);
  assert.deepEqual(W.stockShortage([{ sku: "BT", qty: 2 }, { sku: "BT", qty: 2 }], P, "L1"), [{ sku: "BT", name: "BT", need: 4, have: 3 }]);
  assert.deepEqual(W.stockShortage([{ sku: "BT", qty: 4 }], P, "L2"), []);
  assert.deepEqual(W.stockShortage([{ sku: "USB", qty: 1 }], P, "L2"), [{ sku: "USB", name: "USB", need: 1, have: 0 }]);
  assert.deepEqual(W.stockShortage([{ sku: "support-fee", qty: 1 }, { sku: "X", qty: 9, nonStock: true }], P, "L1"), []);
  assert.deepEqual(W.stockShortage([{ sku: "BT", qty: 99, nonStock: true }], P, "L1"), []);
  assert.deepEqual(W.stockShortage([{ sku: "BT", qty: 0 }], P, "L1"), []);
  assert.deepEqual(W.stockShortage(null, P, "L1"), []);
  assert.deepEqual(W.stockShortage([{ sku: "BT", qty: 1 }], { BT: {} }, "L1"), [{ sku: "BT", name: "BT", need: 1, have: 0 }]);
});

t("validatePickup", () => {
  assert.deepEqual(W.validatePickup({ pickupByEmail: "a@tadakayo.jp", pickupDate: "2026-11-02" }), { ok: true });
  assert.equal(W.validatePickup({ pickupByEmail: "", pickupDate: "2026-11-02" }).ok, false);
  assert.equal(W.validatePickup({ pickupByEmail: "x", pickupDate: "2026-11-02" }).ok, false);
  assert.equal(W.validatePickup({ pickupByEmail: "a@tadakayo.jp", pickupDate: "2026/11/02" }).ok, false);
  assert.equal(W.validatePickup({ pickupByEmail: "a@tadakayo.jp", pickupDate: "2026-02-30" }).ok, false);
  assert.equal(W.validatePickup({ pickupByEmail: "a@tadakayo.jp" }).ok, false);
  assert.equal(W.validatePickup().ok, false);
  assert.equal(typeof W.validatePickup({}).error, "string");
});

t("validateIssue（理由は3つ・メモ200字まで・その他はメモ必須）", () => {
  assert.equal(W.validateIssue({ reason: "shortage", note: "" }).ok, true);
  assert.equal(W.validateIssue({ reason: "address" }).ok, true);
  assert.deepEqual(W.validateIssue({ reason: "address", note: "  番地なし " }), { ok: true, reason: "address", note: "番地なし" });
  assert.equal(W.validateIssue({ reason: "other", note: "" }).ok, false);
  assert.equal(W.validateIssue({ reason: "other", note: "   " }).ok, false);
  assert.equal(W.validateIssue({ reason: "other", note: "箱が破損" }).ok, true);
  assert.equal(W.validateIssue({ reason: "x", note: "a" }).ok, false);
  assert.equal(W.validateIssue({ reason: "toString", note: "a" }).ok, false); // プロトタイプの名前は通さない
  assert.equal(W.validateIssue({ reason: "shortage", note: "あ".repeat(200) }).ok, true);
  assert.equal(W.validateIssue({ reason: "shortage", note: "あ".repeat(201) }).ok, false);
  assert.equal(W.validateIssue({ reason: "shortage", note: 5 }).ok, false);
  assert.equal(W.validateIssue().ok, false);
});

t("orderLocations・defaultLocationIdOf（supply.js と同じ並び: 有効だけ・sort→名前。既定は isDefault、無ければ先頭）", () => {
  const L = [
    { id: "z", name: "Z倉庫", sort: 0 },
    { id: "b", name: "B倉庫", sort: 1 },
    { id: "a", name: "A倉庫", sort: 1 },
    { id: "off", name: "停止", sort: -5, active: false },
    { id: "n", name: "未設定" },               // sort 無し＝0
  ];
  // sort 0 の2つ（未設定・Z倉庫）は名前の localeCompare 順、その後に sort 1 の A倉庫・B倉庫
  const o = W.orderLocations(L).map((l) => l.id);
  const zeroFirst = ["未設定", "Z倉庫"].sort((x, y) => x.localeCompare(y))[0] === "未設定" ? ["n", "z"] : ["z", "n"];
  assert.deepEqual(o.slice(0, 2), zeroFirst);
  assert.deepEqual(o.slice(2), ["a", "b"]);
  assert.ok(!o.includes("off"));
  assert.equal(W.defaultLocationIdOf(L), o[0]);
  assert.equal(W.defaultLocationIdOf([...L, { id: "d", name: "既定", sort: 9, isDefault: true }]), "d");
  assert.equal(W.defaultLocationIdOf([{ id: "d", isDefault: true, active: false }, { id: "x" }]), "x"); // 停止中の既定は使わない
  assert.equal(W.defaultLocationIdOf([{ _id: "u1", name: "画面の形" }]), "u1"); // supply.js の {_id}
  assert.equal(W.defaultLocationIdOf([]), "");
  assert.equal(W.defaultLocationIdOf(null), "");
  assert.deepEqual(L.map((l) => l.id), ["z", "b", "a", "off", "n"]); // 元の配列は並べ替えない
  // 旧 supply.js の決め方（onSnapshot で sort→名前に並べ、有効の中で isDefault か先頭）と同じ結果になる
  const oldSupply = (locs) => {
    const sorted = locs.map((l) => ({ _id: l.id, ...l })).sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name || "").localeCompare(String(b.name || "")));
    const act = sorted.filter((l) => l.active !== false);
    return ((act.find((l) => l.isDefault) || act[0] || {})._id) || "";
  };
  const cases = [L, [...L, { id: "d", name: "既定", sort: 9, isDefault: true }], [{ id: "q", sort: 3 }, { id: "p", sort: 2, active: false }], [],
    [{ id: "m", name: "い", sort: "2" }, { id: "k", name: "あ", sort: 2 }]];
  for (const c of cases) assert.equal(W.defaultLocationIdOf(c), oldSupply(c), JSON.stringify(c));
});

t("supply.js・Functions・練習の代役が同じ既定の場所の決め方を使う（Codex 指摘3）", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  assert.match(sup, /function defaultLocationId\(\)\{ return defaultLocationIdOf\(locations\); \}/);
  const fn = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  assert.match(fn, /defaultId: wr\.defaultLocationIdOf\(all\)/);
  const ps = readFileSync(new URL("../admin/js/practice-stubs.js", import.meta.url), "utf8");
  assert.match(ps, /return defaultLocationIdOf\(locs\)/);
  assert.match(ps, /return orderLocations\(/);
});

t("持ち出しの依頼は送料を「郵送なし」と同じ 0 円にする（Codex 指摘2）", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  const rf = sup.slice(sup.indexOf("function recalcShipFee"), sup.indexOf("function taxInclusiveShipFees"));
  assert.match(rf, /method==='none'\)\{[\s\S]*?feeEl\.value=0; labelEl\.value='郵送なし（手渡し・持参）'/);
  const rq = sup.slice(sup.indexOf("async function requestDraftShipment"), sup.indexOf("// 依頼済(requested) → 発送済"));
  assert.match(rq, /ans\.deliveryMode==="pickup" && !isLocked\(cur\)\s*\? \{ shippingFee:0, shippingLabel:"郵送なし（手渡し・持参）" \}/);
  assert.match(rq, /shippingMethod:"none", \.\.\.noPostage/);
  assert.match(rq, /feeZeroed = ans\.deliveryMode==="pickup" && !isLocked\(cur\) && Number\(cur\.shippingFee\)>0/);
  assert.match(rq, /送料を0円にしました/);
});

t("倉庫の画面: 保存した場所が無い・使えないときはサーバーが選んだ場所を使い保存し直す（Codex 指摘1）", () => {
  const wh = readFileSync(new URL("../admin/js/warehouse.js", import.meta.url), "utf8");
  assert.match(wh, /code === "permission-denied" \|\| code === "not-found"\)\) \{ locationId = ""; res = await listFn\(\{ locationId \}\)/);
  assert.match(wh, /if \(data\.location && data\.location\.id\) \{ locationId = data\.location\.id; saveLoc\(locationId\); \}/);
});

t("canPickup（直送は持ち出しにできない・Codex 指摘2回目）", () => {
  assert.equal(W.canPickup({}), true);
  assert.equal(W.canPickup({ fulfillment: "warehouse" }), true);
  assert.equal(W.canPickup({ fulfillment: "direct" }), false);
  assert.equal(W.canPickup({ fulfillment: "direct", deliveryMode: "pickup" }), false);
  assert.equal(W.canPickup(null), false);
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  assert.match(sup, /allowPickup: canPickup\(s\), pickupUsers/);
  assert.match(sup, /if\(ans\.deliveryMode==="pickup" && !canPickup\(s\)\)\{ alert\(/);
  const fn = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  assert.match(fn, /const deliveryMode = wr\.canPickup\(s\) \? wr\.deliveryModeOf\(s\) : "ship"/);
  const ps = readFileSync(new URL("../admin/js/practice-stubs.js", import.meta.url), "utf8");
  assert.match(ps, /expectMode === "pickup" && !canPickup\(cur\)\) throw fail\(/);
});

t("持ち出し → 発送で依頼し直すと送料をレターパックに戻し、確認を出す（Codex 指摘2回目）", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  const rq = sup.slice(sup.indexOf("async function requestDraftShipment"), sup.indexOf("// 依頼済(requested) → 発送済"));
  assert.match(rq, /const backToShip = ans\.deliveryMode==="ship" && isPickup\(s\) && !isLocked\(s\)/);
  assert.match(rq, /shippingMethod:"letterpack", shippingFee: taxExcl\(lpPacks\*letterpackFee\(\)\), shippingLabel:`送料（レターパック \$\{lpPacks\}通）`/);
  assert.match(rq, /if\(backToShip && !confirm\(`持ち出しから発送に変えました。送料を確認してください。/);
  assert.match(rq, /const restore = backToShip && isPickup\(cur\) && !isLocked\(cur\) \? lpPatch : \{\}/);
  assert.match(rq, /deliveryMode:"ship", \.\.\.letterPackPatch\(ans\.letterPackType\), \.\.\.restore/);
  // 受注から出荷を作るときと同じ計算（3台で1通・税抜）
  assert.match(sup, /const packs=Math\.max\(1,Math\.ceil\(items\.reduce\(\(a,i\)=>a\+i\.qty,0\)\/3\)\);/);
  assert.match(sup, /shippingMethod:"letterpack", shippingFee:taxExcl\(packs\*letterpackFee\(\)\), shippingLabel:`送料（レターパック \$\{packs\}通）`/);
});

t("持ち出す人の候補は本番DBの users から読む（練習モードでも空にならない・Codex 指摘2回目）", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  const lp = sup.slice(sup.indexOf("async function loadPickupUsers"), sup.indexOf("async function loadPickupUsers") + 400);
  assert.match(lp, /getDocs\(collection\(getProdFirestore\(app\),"users"\)\)/);
  assert.doesNotMatch(lp, /setDoc|updateDoc|addDoc|deleteDoc/);
  assert.match(sup, /import \{ getFirestore, getProdFirestore, collection,/);
  const fsSrc = readFileSync(new URL("../admin/js/fs.js", import.meta.url), "utf8");
  assert.match(fsSrc, /export function getProdFirestore\(app\) \{\s*return F\.getFirestore\(app\);/);
});

t("倉庫の人は練習モードの印が残っていても本番に戻して読み込み直す（ブラウザ検証 B2）", () => {
  const md = readFileSync(new URL("../admin/js/mode.js", import.meta.url), "utf8");
  const fn = md.slice(md.indexOf("export function setupModeUi"));
  assert.match(fn, /if \(isWarehouse && isPracticeMode\(\)\) \{\s*if \(setPracticeMode\(false\) && !isPracticeMode\(\)\) \{ location\.reload\(\); return false; \}\s*return "no-storage";/);
  // 練習モードの UI（ensureMyPracticeCases など）より前で止める
  assert.ok(fn.indexOf("isWarehouse && isPracticeMode()") < fn.indexOf("onBody("));
  assert.ok(fn.indexOf("isWarehouse && isPracticeMode()") < fn.indexOf("ensureMyPracticeCases"));
});

t("練習の代役の whMs は ISO 文字列も読む（ブラウザ検証 B3）", () => {
  const ps = readFileSync(new URL("../admin/js/practice-stubs.js", import.meta.url), "utf8");
  const src = ps.slice(ps.indexOf("function whMs(t)"), ps.indexOf("async function whLocations"));
  const whMs = new Function(`${src}; return whMs;`)();
  assert.equal(whMs("2026-10-24T01:00:00.000Z"), Date.parse("2026-10-24T01:00:00.000Z"));
  assert.equal(whMs("いつか"), 0);
  assert.equal(whMs(123), 123);
  assert.equal(whMs({ toMillis: () => 5 }), 5);
  assert.equal(whMs({ seconds: 2 }), 2000);
  assert.equal(whMs(null), 0);
  // projectForWarehouse の出力（ISO）を通すと元の時刻に戻る
  const w = W.projectForWarehouse({ status: "requested", requestedAt: { toMillis: () => 1761267600000 } });
  assert.equal(whMs(w.requestedAt), 1761267600000);
});

{
  const SF = await import("../admin/js/ship-flow.js");
  t("shipStatusOf は ship-flow.js と同じ", () => {
    for (const s of [{}, null, undefined, { status: "" }, { status: "requested" }, { status: "paid" }, { status: "draft" }]) {
      assert.equal(W.shipStatusOf(s), SF.shipStatusOf(s), JSON.stringify(s));
    }
    assert.equal(W.shipStatusOf({}), "shipped");
    const w = W.projectForWarehouse({ shipDate: "2026-10-01", trackingNumber: "1" });
    assert.equal(w.status, "shipped"); assert.equal(w.shipDate, "2026-10-01"); assert.equal(w.desiredDate, "");
    const fn = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
    assert.match(fn, /WAREHOUSE_DONE_STATUSES\.includes\(wr\.shipStatusOf\(s\)\)/);
    assert.match(fn, /WAREHOUSE_DONE_STATUSES\.includes\(wr\.shipStatusOf\(cur\)\)/);
    const ps = readFileSync(new URL("../admin/js/practice-stubs.js", import.meta.url), "utf8");
    assert.equal((ps.match(/\["shipped", "invoiced", "paid"\]\.includes\(shipStatusOf\(s\)\)/g) || []).length, 2);
  });
}

t("senderForLabel は letterpack-print.js の差出人の決め方（sendersOf の1件目）と同じ（Codex 指摘3回目 C）", () => {
  const lp = readFileSync(new URL("../admin/js/letterpack-print.js", import.meta.url), "utf8");
  const def = lp.slice(lp.indexOf("const SENDER_DEFAULT"), lp.indexOf("const TYPE_LABEL"));
  const fnSrc = lp.slice(lp.indexOf("function sendersOf(st)"), lp.indexOf("function itemsMemo"));
  const sendersOf = new Function(`${def}\n${fnSrc}\nreturn sendersOf;`)();
  const cases = [
    {}, null,
    { senders: [{ name: "A", postal: "100-0001", address: "東京", phone: "03" }, { name: "B" }] },
    { senders: [{}, { address: "住所だけ" }] },
    { senders: [], senderName: "旧", senderPostal: "1", senderAddress: "旧住所", senderPhone: "2" },
    { invoiceIssuerName: "NPO法人タダカヨ", invoiceIssuerPostal: "143-0015", invoiceIssuerAddress: "大田区", invoiceIssuerTel: "050" },
    { invoiceIssuerAddress: "住所だけ" },
  ];
  for (const st of cases) {
    const x = sendersOf(st)[0];
    assert.deepEqual(W.senderForLabel(st), { name: x.name || "", postalCode: x.postal || "", address: x.address || "", phone: x.phone || "" }, JSON.stringify(st));
  }
  assert.deepEqual(Object.keys(W.senderForLabel({})).sort(), ["address", "name", "phone", "postalCode"]);
  const fn = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  assert.match(fn, /const sender = wr\.senderForLabel\(await getSettings\(\)\)/);
  const ps = readFileSync(new URL("../admin/js/practice-stubs.js", import.meta.url), "utf8");
  assert.match(ps, /sender: senderForLabel\(st\)/);
});

t("W に宛名ラベルの項目がそろう（Codex 指摘3回目 C）", () => {
  const w = W.projectForWarehouse({ status: "requested", postal: "1", address: "a", officeName: "o", company: "c", contactName: "n", phone: "p", letterPackType: "plus" });
  for (const [k, v] of Object.entries({ postalCode: "1", address: "a", officeName: "o", company: "c", contactName: "n", phone: "p", letterPackType: "plus" })) assert.equal(w[k], v, k);
});

t("新規出荷の送付方法（発送／持ち出し・Codex 指摘3回目 B）", () => {
  const html = readFileSync(new URL("../admin/supply.html", import.meta.url), "utf8");
  for (const id of ["shipDeliveryMode", "shipPickupWrap", "shipPickupBy", "shipLetterPackRow"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<option value="pickup">持ち出し（倉庫から直接持っていく）<\/option>/);
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  const ss = sup.slice(sup.indexOf("async function saveShip()"), sup.indexOf("// 出荷の修正を保存する"));
  assert.match(ss, /validatePickup\(\{ pickupByEmail, pickupDate: shipDateIn \}\)/);
  assert.match(ss, /const shippingMethod=pickup \? "none"/);
  assert.match(ss, /const shippingFee=pickup \? 0/);
  assert.match(ss, /const shippingLabel=pickup \? "郵送なし（手渡し・持参）"/);
  assert.match(ss, /const letterPackType=pickup \? ""/);
  assert.match(ss, /deliveryMode,\s*\.\.\.\(pickup \? \{ pickupByEmail, pickupByName, pickupDate: shipDateIn \} : \{\}\)/);
  // 出荷指示を投稿するのは登録の後（送付方法がデータに入ってから）
  assert.ok(ss.indexOf("deliveryMode,") < ss.indexOf("postShipNotice(newShipId)"));
  const sync = sup.slice(sup.indexOf("function syncShipDeliveryMode"), sup.indexOf("async function saveShip()"));
  assert.match(sync, /if\(pickup\)\{ m\.value="none"; recalcShipFee\(\); \}/);
  assert.match(sync, /else if\(m\.value==="none"\)\{ m\.value="letterpack"; recalcShipFee\(\); \}/);
  const rs = sup.slice(sup.indexOf("async function resetShipDeliveryMode"), sup.indexOf("function syncShipDeliveryMode"));
  assert.match(rs, /await loadPickupUsers\(\)/); // 本番の users から（練習モードでも候補がある）
  assert.match(sup, /if\(!s\) resetShipDeliveryMode\(\);/);
  assert.match(sup, /getElementById\("shipDeliveryMode"\)\?\.addEventListener\("change",\(\)=>syncShipDeliveryMode\(true\)\)/);
});

console.log(`OK: test-warehouse-rules ${n} 件`);
