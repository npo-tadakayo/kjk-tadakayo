// 点検9: 出荷をキャンセルしたあとの案件の扱い（admin/js/ship-cancel-case.js）と、画面へのつなぎのテスト。
// node scripts/test-ship-cancel-case.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REVERT_TO_STATUS, REVERT_FROM_STATUSES, HOLD_PROGRESSED_STATUSES, planShipCancelRevert, revertWrites, holdActivity,
  holdMessage, cancelPreviewText, shipCancelNoticeOf, SHIP_CANCEL_STALE_TEXT,
} from "../admin/js/ship-cancel-case.js";
import { orderConsentNoticeOf, ORDER_CONSENT_STALE_TEXT } from "../admin/js/record-gaps.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const has = (src, re, msg) => assert.ok(re.test(src), msg || `見つからない: ${re}`);
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };

const K = (status, extra = {}) => ({ status, ...extra });
const S = (id, status, extra = {}) => ({ _id: id, soNumber: `SH-${id}`, status, ...extra });

// ===== 判定 =====
t("唯一の下書きをキャンセル（受注確定）→ 戻す", () => {
  assert.deepEqual(planShipCancelRevert({ kase: K(3), shipments: [S("a", "draft")], canceledId: "a" }), { kind: "revert", reasons: [] });
});
t("依頼済をキャンセル（担当者決定・事前準備中）→ 戻す", () => {
  for (const st of [5, 6]) assert.equal(planShipCancelRevert({ kase: K(st), shipments: [S("a", "requested")], canceledId: "a" }).kind, "revert");
});
t("ほかの出荷がキャンセル済みで、最後の1件をキャンセル → 戻す", () => {
  const ships = [S("a", "draft"), S("b", "canceled", { statusBeforeCancel: "draft" })];
  assert.equal(planShipCancelRevert({ kase: K(3), shipments: ships, canceledId: "a" }).kind, "revert");
});
t("一部だけのキャンセル（ほかに生きた出荷）→ 何もしない", () => {
  const ships = [S("a", "draft"), S("b", "draft")];
  assert.equal(planShipCancelRevert({ kase: K(3), shipments: ships, canceledId: "a" }).kind, "none");
  const ships2 = [S("a", "draft"), S("b", "shipped")];
  assert.equal(planShipCancelRevert({ kase: K(3), shipments: ships2, canceledId: "a" }).kind, "none");
});
t("受注前（1・2）・失注・完了・アーカイブ・出荷なし・案件なし → 何もしない", () => {
  for (const st of [1, 2, 4, 13]) assert.equal(planShipCancelRevert({ kase: K(st), shipments: [S("a", "draft")], canceledId: "a" }).kind, "none", String(st));
  assert.equal(planShipCancelRevert({ kase: K(3, { archived: true }), shipments: [S("a", "draft")], canceledId: "a" }).kind, "none");
  assert.equal(planShipCancelRevert({ kase: K(3), shipments: [], canceledId: "a" }).kind, "none");
  assert.equal(planShipCancelRevert({ kase: null, shipments: [S("a", "draft")], canceledId: "a" }).kind, "none");
});
t("発送済をキャンセル → 自動では戻さない（発送）", () => {
  const p = planShipCancelRevert({ kase: K(3), shipments: [S("a", "shipped")], canceledId: "a" });
  assert.deepEqual(p, { kind: "hold", reasons: ["shipped"] });
});
t("前に発送済からキャンセルした出荷がある → 保留", () => {
  const ships = [S("a", "draft"), S("b", "canceled", { statusBeforeCancel: "shipped" })];
  assert.deepEqual(planShipCancelRevert({ kase: K(3), shipments: ships, canceledId: "a" }).reasons, ["shipped"]);
});
t("請求済をキャンセル → 保留（請求・発送）", () => {
  const p = planShipCancelRevert({ kase: K(3), shipments: [S("a", "invoiced", { invoicedAt: "2026-11-01" })], canceledId: "a" });
  assert.deepEqual(p, { kind: "hold", reasons: ["invoice", "shipped"] });
});
t("請求書をメールで送った記録だけがある下書き → 保留（請求）", () => {
  const p = planShipCancelRevert({ kase: K(3), shipments: [S("a", "draft", { invoiceMailedAt: "2026-11-01" })], canceledId: "a" });
  assert.deepEqual(p, { kind: "hold", reasons: ["invoice"] });
});
t("入金が1円でも記録されている（返金済みでも）→ 保留（入金）", () => {
  const p = planShipCancelRevert({ kase: K(3), shipments: [S("a", "draft", { payments: [{ amount: 1, date: "2026-11-01" }], refunds: [{ amount: 1 }] })], canceledId: "a" });
  assert.deepEqual(p, { kind: "hold", reasons: ["payment"] });
  const old = planShipCancelRevert({ kase: K(3), shipments: [S("a", "draft"), S("b", "canceled", { paymentAmount: 500 })], canceledId: "a" });
  assert.deepEqual(old.reasons, ["payment"]); // 旧形式 paymentAmount も入金として数える
});
t("伴走支援待ち以降（7〜12）→ 保留（進んでいる）", () => {
  for (const st of HOLD_PROGRESSED_STATUSES) {
    assert.deepEqual(planShipCancelRevert({ kase: K(st), shipments: [S("a", "draft")], canceledId: "a" }), { kind: "hold", reasons: ["progressed"] }, String(st));
  }
  assert.deepEqual(REVERT_FROM_STATUSES, [3, 5, 6]);
  assert.equal(REVERT_TO_STATUS, 2);
});
t("canceledId を渡さなくても、全部キャンセル済みなら同じ判定（点検の表示用）", () => {
  assert.equal(planShipCancelRevert({ kase: K(3), shipments: [S("a", "canceled", { statusBeforeCancel: "draft" })] }).kind, "revert");
});

// ===== 文 =====
t("保留の文: 入金・請求があるときは決まった言い方", () => {
  assert.match(holdMessage(["payment"]), /^入金（請求）があるため自動では戻しません。確認してください（入金の記録がある）$/);
  assert.match(holdMessage(["invoice", "shipped"]), /^入金（請求）があるため自動では戻しません/);
  assert.match(holdMessage(["progressed"]), /^自動では見積もり確認中に戻しません。確認してください（伴走支援待ち以降まで進んでいる）$/);
});
t("キャンセルの画面の予告", () => {
  assert.equal(cancelPreviewText({ kind: "none" }, {}), "");
  assert.match(cancelPreviewText({ kind: "revert" }, {}), /「確認中」.*「発行中」/);
  assert.match(cancelPreviewText({ kind: "revert" }, { orderConsentToken: "t" }), /承諾書は取り直し/);
  assert.match(cancelPreviewText({ kind: "hold", reasons: ["payment"] }, {}), /入金（請求）があるため自動では戻しません/);
});

// ===== 書き込みの中身 =====
const NOW = { __ts: true };
t("戻すときの案件・見積もり・対応記録", () => {
  const kase = { status: 5, orderedAt: { ts: 1 }, shipmentId: "a", orderConsentToken: "tok" };
  const quotes = [
    { id: "q2", status: "accepted", estNo: "EST-1", version: 2, acceptedAt: { ts: 2 }, acceptedBy: "山田", acceptedVia: "staff", shipmentId: "a", shipmentNo: "SH-a", consentToken: "tok" },
    { id: "q1", status: "superseded", estNo: "EST-1", version: 1 },
  ];
  const w = revertWrites({ kase, quotes, ship: S("a", "draft"), by: "鈴木", now: NOW, cancelReason: "事業所の都合", orderedYmd: "2026-11-01" });
  const c = w.casePatch;
  assert.equal(c.status, 2);
  assert.equal(c.statusChangedTo, 2);
  assert.equal(c.statusChangedAt, NOW);
  assert.equal(c.orderedAt, null);
  assert.equal(c.shipmentId, null);
  assert.equal(c.orderConsentStale, true);
  assert.equal(c.orderConsentStaleReason, "ship_canceled");
  assert.deepEqual(c.shipCancelRevert, { at: NOW, by: "鈴木", soNumber: "SH-a", shipId: "a", fromStatus: 5,
    prevOrderedAt: { ts: 1 }, prevShipmentId: "a", quoteIds: ["q2"] });
  assert.equal(w.quotePatches.length, 1, "申し込み済みの版だけ戻す（superseded は触らない）");
  const qp = w.quotePatches[0];
  assert.equal(qp.id, "q2");
  assert.equal(qp.patch.status, "issued");
  assert.equal(qp.patch.shipmentId, null);
  assert.equal(qp.patch.acceptedAt, null);
  assert.equal(qp.patch.revertReason, "ship_canceled");
  assert.deepEqual(qp.patch.prevAccept, { acceptedAt: { ts: 2 }, acceptedBy: "山田", acceptedVia: "staff", shipmentId: "a", shipmentNo: "SH-a", consentToken: "tok" });
  assert.equal(w.activity.subject, "出荷 SH-a のキャンセルで、案件を見積もり確認中に戻しました");
  for (const re of [/操作した人: 鈴木/, /キャンセルした出荷: SH-a（理由: 事業所の都合）/, /5 → 2（確認中）/, /EST-1 第2版 を「申し込み済み」から「発行中」/,
    /受注日 2026-11-01 を外しました/, /承諾書: .*取り直しが要ります/]) assert.match(w.activity.body, re);
});
t("承諾書の無い案件は承諾書の印を立てない・受注日が無ければその行を出さない", () => {
  const w = revertWrites({ kase: { status: 3 }, quotes: [], ship: S("a", "draft"), by: "x", now: NOW });
  assert.equal("orderConsentStale" in w.casePatch, false);
  assert.equal(w.quotePatches.length, 0);
  assert.doesNotMatch(w.activity.body, /受注日|承諾書/);
  assert.match(w.activity.body, /申し込み済みの見積もりはありません/);
});
t("保留の対応記録", () => {
  const a = holdActivity({ ship: S("a", "invoiced"), by: "鈴木", reasons: ["invoice", "shipped"], cancelReason: "誤登録" });
  assert.equal(a.subject, "出荷 SH-a をキャンセル（案件の状態は自動では戻していません）");
  assert.match(a.body, /入金（請求）があるため自動では戻しません。確認してください/);
  assert.match(a.body, /入金・消込は変えていません/);
});

// ===== 案件詳細のお知らせ（点検） =====
t("戻した案件: 新しい出荷が無いあいだは「送り直して確認」を出す", () => {
  const kase = { status: 2, shipCancelRevert: { soNumber: "SH-a" } };
  const n1 = shipCancelNoticeOf(kase, [S("a", "canceled")]);
  assert.equal(n1.key, "shipCancelReverted");
  assert.equal(n1.warn, false);
  assert.match(n1.text, /SH-a をキャンセルしたため、見積もり確認中に戻しました/);
  assert.equal(shipCancelNoticeOf(kase, [S("a", "canceled"), S("b", "draft")]), null, "新しい申込で下書きができたら消える");
  // 戻したあとで手で受注確定に進めた（出荷はまだ無い）→ 「送り直して確認」は消え、ずれ（全部キャンセルなのに受注確定）として出る
  assert.equal(shipCancelNoticeOf({ ...kase, status: 3 }, [S("a", "canceled")]).key, "shipCancelLegacy");
});
t("全部キャンセルなのに受注確定のまま: 入金があれば保留の文・無ければ前からのキャンセル", () => {
  const hold = shipCancelNoticeOf({ status: 3 }, [S("a", "canceled", { statusBeforeCancel: "draft", payments: [{ amount: 100 }] })]);
  assert.equal(hold.key, "shipCancelHold");
  assert.equal(hold.warn, true);
  assert.match(hold.text, /入金（請求）があるため自動では戻しません。確認してください/);
  const legacy = shipCancelNoticeOf({ status: 5 }, [S("a", "canceled", { statusBeforeCancel: "draft" })]);
  assert.equal(legacy.key, "shipCancelLegacy");
  assert.equal(shipCancelNoticeOf({ status: 3 }, []), null);
  assert.equal(shipCancelNoticeOf({ status: 3 }, [S("a", "draft")]), null);
  assert.equal(shipCancelNoticeOf({ status: 13 }, [S("a", "canceled")]), null);
  assert.equal(shipCancelNoticeOf({ status: 3, archived: true }, [S("a", "canceled")]), null);
});
t("承諾書の印: 出荷キャンセルで立てたときは文を変える", () => {
  assert.equal(orderConsentNoticeOf({ orderConsentStale: true, orderConsentStaleReason: "ship_canceled" }).text, SHIP_CANCEL_STALE_TEXT);
  assert.equal(orderConsentNoticeOf({ orderConsentStale: true }).text, ORDER_CONSENT_STALE_TEXT);
});

// ===== 画面へのつなぎ =====
t("supply.js: キャンセルのトランザクションで判定し、戻す・保留を書く", () => {
  const src = read("admin/js/supply.js");
  has(src, /from "\/js\/ship-cancel-case\.js"/);
  const body = src.slice(src.indexOf("async function doCancelShipment"), src.indexOf("// 出荷の金額。"));
  has(body, /planShipCancelRevert\(\{ kase, shipments:\[\{ _id:s\._id, \.\.\.cur \}, \.\.\.sibs\], canceledId:s\._id \}\)/);
  has(body, /tx\.update\(caseRef, w\.casePatch\)/);
  has(body, /tx\.update\(doc\(db,"quotes",qp\.id\), qp\.patch\)/);
  has(body, /holdActivity\(/);
  // 読み取り（tx.get）がすべて書き込み（tx.update / tx.set）より前
  const lastGet = body.lastIndexOf("tx.get(");
  const firstWrite = Math.min(...["tx.update(", "tx.set("].map((k) => body.indexOf(k)).filter((i) => i >= 0));
  assert.ok(lastGet < firstWrite, "トランザクションの読み取りが書き込みより後にある");
  // 入金・消込の項目には書かない
  for (const k of ["payments", "refunds", "paymentAmount", "creditApplied"]) assert.ok(!new RegExp(`${k}\\s*:`).test(body), `${k} に書いている`);
  has(src, /previewCaseRevert\(s, stockMsg\)/);
});
t("case-detail.js: 次の一手の下にお知らせを出す", () => {
  const src = read("admin/js/case-detail.js");
  has(src, /import \{ shipCancelNoticeOf \} from "\/js\/ship-cancel-case\.js"/);
  has(src, /shipCancelNoticeOf\(currentCase, shipmentsCache\)/);
});

console.log(`ship-cancel-case: ${n} 件 合格`);
