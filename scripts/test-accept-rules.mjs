// スタッフ経路の受注確定の拒否条件（functions/accept-rules.js）のテスト。node scripts/test-accept-rules.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { checkStaffAccept, STAFF_ACCEPT_CHANNELS, isValidYmd, jstYmdOf } = require("../functions/accept-rules.js");

let n = 0;
const t = (name, fn) => { fn(); n++; };

// Firestore Timestamp 相当
const ts = (iso) => ({ toMillis: () => Date.parse(iso), toDate: () => new Date(iso) });
// 有効期限 = 2026-10-31 の 15:00 JST（daysFromNow(30) の形）
const quote = { id: "q2", status: "issued", version: 2, validUntil: ts("2026-10-31T15:00:00+09:00") };
const ok = {
  quote, siblings: [{ id: "q1", status: "superseded", version: 1 }, quote],
  kase: { status: 2 }, shipments: [], receivedDate: "2026-10-20", todayYmd: "2026-10-21",
  acceptedName: "山田 花子", channel: "phone",
};
const code = (patch) => { const r = checkStaffAccept({ ...ok, ...patch }); return r.ok ? "ok" : r.code; };

t("正常", () => {
  assert.deepEqual(checkStaffAccept(ok), { ok: true });
  for (const ch of Object.keys(STAFF_ACCEPT_CHANNELS)) assert.equal(code({ channel: ch }), "ok");
  for (const st of [1, 2, 3, 5, 9, 12]) assert.equal(code({ kase: { status: st } }), "ok"); // 5 以上も可（状態は据え置きは呼び出し側）
  assert.equal(code({ shipments: [{ status: "canceled" }] }), "ok"); // キャンセルだけなら可
  assert.equal(code({ quote: { ...quote, validUntil: null } }), "ok"); // 期限なし
});

t("見積もりの状態", () => {
  assert.equal(code({ quote: null }), "quote_not_found");
  assert.equal(code({ quote: { ...quote, status: "accepted" } }), "already_accepted");
  assert.equal(code({ quote: { ...quote, status: "superseded" } }), "not_issued");
  assert.equal(code({ quote: { ...quote, status: "draft" } }), "not_issued");
});

t("旧版", () => {
  const sib = [{ id: "q3", status: "issued", version: 3 }, quote];
  assert.equal(code({ siblings: sib }), "old_version");
  assert.equal(code({ siblings: [quote] }), "ok");
  assert.equal(code({ siblings: undefined }), "ok");
  // 同じ版番号の別ドキュメントは「新しい版」ではない
  assert.equal(code({ siblings: [{ id: "qx", version: 2 }, quote] }), "ok");
});

t("期限切れは受付日で比べる", () => {
  // 有効期限の日（JST 10-31）当日の受付は有効。今日が期限後でも受付日が期限内なら有効
  assert.equal(code({ receivedDate: "2026-10-31", todayYmd: "2026-11-05" }), "ok");
  assert.equal(code({ receivedDate: "2026-11-01", todayYmd: "2026-11-05" }), "expired");
  // UTC では前日になる時刻（10-31 08:00 JST = 10-30 23:00Z）でも JST の日付で判定
  const q = { ...quote, validUntil: ts("2026-10-30T23:00:00Z") };
  assert.equal(code({ quote: q, siblings: [q], receivedDate: "2026-10-31", todayYmd: "2026-10-31" }), "ok");
  // Date・文字列でも読める
  assert.equal(code({ quote: { ...quote, validUntil: new Date("2026-10-15T15:00:00+09:00") } }), "expired");
  assert.equal(code({ quote: { ...quote, validUntil: "2026-10-20" } }), "ok");
  assert.equal(code({ quote: { ...quote, validUntil: "2026-10-19" } }), "expired");
  assert.equal(checkStaffAccept({ ...ok, receivedDate: "2026-11-01", todayYmd: "2026-11-02" }).message,
    "受付日（2026-11-01）が見積もりの有効期限（2026-10-31）を過ぎています");
});

t("受付日が未来・不正", () => {
  assert.equal(code({ receivedDate: "2026-10-22" }), "future_received_date");
  assert.equal(code({ receivedDate: "2026-10-21" }), "ok"); // 今日は可
  for (const bad of ["", null, undefined, "2026/10/20", "20261020", "2026-02-30", "2026-13-01", "R8.10.20"]) {
    assert.equal(code({ receivedDate: bad }), "invalid_received_date", String(bad));
  }
  assert.equal(code({ todayYmd: "" }), "invalid_today");
});

t("申込者名・受付方法", () => {
  assert.equal(code({ acceptedName: "" }), "no_name");
  assert.equal(code({ acceptedName: "  　".replace("　", " ") }), "no_name");
  assert.equal(code({ acceptedName: undefined }), "no_name");
  assert.equal(code({ channel: "web" }), "invalid_channel");
  assert.equal(code({ channel: "" }), "invalid_channel");
  assert.equal(code({ channel: "toString" }), "invalid_channel"); // プロトタイプのキーは不可
});

t("案件の状態 4/13 は拒否しない（再申込として受け付け・3 に戻すのは呼び出し側）", () => {
  assert.equal(code({ kase: null }), "case_not_found");
  assert.equal(code({ kase: { status: 4 } }), "ok");
  assert.equal(code({ kase: { status: "13" } }), "ok");
  // 失注でも、キャンセル以外の出荷があれば従来どおり止める
  assert.equal(code({ kase: { status: 4 }, shipments: [{ status: "draft" }] }), "draft_exists");
});

t("キャンセル以外の出荷あり", () => {
  assert.equal(code({ shipments: [{ status: "draft", soNumber: "SH-2026-0001" }] }), "draft_exists");
  assert.equal(code({ shipments: [{ status: "requested" }, { status: "canceled" }] }), "draft_exists");
  assert.equal(code({ shipments: [{ status: "shipped" }] }), "shipped_exists");
  assert.equal(code({ shipments: [{ status: "draft" }, { status: "paid" }] }), "shipped_exists");
  assert.equal(code({ shipments: [{}] }), "shipped_exists"); // 状態なしの古い出荷は発送済扱い
  assert.ok(checkStaffAccept({ ...ok, shipments: [{ status: "invoiced", soNumber: "SH-2026-0007" }] }).message.includes("SH-2026-0007"));
});

t("補助関数", () => {
  assert.equal(isValidYmd("2028-02-29"), true);
  assert.equal(isValidYmd("2027-02-29"), false);
  assert.equal(jstYmdOf(ts("2026-10-30T15:00:00Z")), "2026-10-31");
  assert.equal(jstYmdOf(null), "");
  assert.equal(jstYmdOf("でたらめ"), "");
});

console.log(`OK test-accept-rules: ${n} 件合格`);
