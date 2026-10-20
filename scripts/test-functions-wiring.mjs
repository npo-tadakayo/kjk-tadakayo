// Functions の結線の判定部分（functions/accept-flow.js）のテスト。node scripts/test-functions-wiring.mjs
// 設計: docs/CRM改善_設計_20261021.md §3〜§5。Firestore には触れない。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const F = require("../functions/accept-flow.js");
const fs = require("node:fs");
const indexSrc = fs.readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const nt = await import("../functions/notify-text.mjs");

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const ts = (iso) => ({ toMillis: () => Date.parse(iso), toDate: () => new Date(iso) });

t("認可: roleAllows", () => {
  const ed = { active: true, role: "staff" }, vw = { active: true, role: "viewer" }, ad = { active: true, role: "admin" };
  assert.equal(F.roleAllows(ed, "editor"), true);
  assert.equal(F.roleAllows(vw, "editor"), false);
  assert.equal(F.roleAllows(vw, "viewer"), true);
  assert.equal(F.roleAllows(ad, "admin"), true);
  assert.equal(F.roleAllows(ed, "admin"), false);
  assert.equal(F.roleAllows({ role: "admin" }, "admin"), false);          // active が無い
  assert.equal(F.roleAllows({ active: "true", role: "admin" }, "admin"), false); // 文字列は不可
  assert.equal(F.roleAllows(null, "viewer"), false);
  assert.equal(F.roleAllows(ad, "unknown"), false);
  assert.equal(F.roleAllows({ active: true }, "editor"), true); // role 未設定は editor 扱い（rules の role != 'viewer' と同じ）
});

t("受注: 案件の状態を 3 にするか（4・13 は再申込で 3 に戻す）", () => {
  for (const s of [1, 2, undefined, null, 0]) assert.deepEqual(F.caseStatusOnAccept(s), { ok: true, status: 3, reopenedFrom: null });
  for (const s of [3, 5, 6, 9, 11, 12]) assert.deepEqual(F.caseStatusOnAccept(s), { ok: true, status: null, reopenedFrom: null });
  assert.deepEqual(F.caseStatusOnAccept(4), { ok: true, status: 3, reopenedFrom: 4 });
  assert.deepEqual(F.caseStatusOnAccept(13), { ok: true, status: 3, reopenedFrom: 13 });
  assert.deepEqual(F.caseStatusOnAccept("13"), { ok: true, status: 3, reopenedFrom: 13 });
  assert.deepEqual(F.caseStatusOnAccept("2"), { ok: true, status: 3, reopenedFrom: null });
  assert.equal(F.reopenLabel(4), "再申込で再開（失注から）");
  assert.equal(F.reopenLabel(13), "再申込で再開（完了から）");
  assert.equal(F.reopenLabel(null), "");
  assert.equal(F.reopenLabel(5), "");
  // 活動の件名
  assert.equal(F.webAcceptSubject("EST-1", "SH-1", false, 4), "お申し込みを受け付けました（EST-1・出荷 SH-1 の下書きを作成・再申込で再開（失注から））");
  assert.equal(F.webAcceptSubject("EST-1", "SH-1", true, 13), "お申し込みを受け付けました（EST-1・既存の出荷 SH-1 を更新・再申込で再開（完了から））");
  assert.equal(F.webAcceptSubject("EST-1", "SH-1", false, null), "お申し込みを受け付けました（EST-1・出荷 SH-1 の下書きを作成）");
  assert.equal(F.staffAcceptSubject("phone", "EST-1", "SH-1", false, 4), "電話で受けたお申し込みを受注確定にしました（EST-1・出荷 SH-1・再申込で再開（失注から））");
  // index.js は拒否の分岐を持たない（4・13 を通す）
  assert.doesNotMatch(indexSrc, /stPlan\.ok/);
  assert.match(indexSrc, /reopenedFrom: stPlan\.reopenedFrom, reopenedAt: now/);
});

t("受注: スタッフ経路の orderedAt は既存を上書きしない", () => {
  assert.equal(F.staffOrderedAtMs({ orderedAt: ts("2026-09-01T00:00:00Z") }, "2026-10-20"), null);
  assert.equal(F.staffOrderedAtMs({}, "2026-10-20"), Date.parse("2026-10-20T00:00:00+09:00"));
  assert.equal(F.staffOrderedAtMs(null, "2026-10-20"), Date.parse("2026-10-20T00:00:00+09:00"));
  assert.equal(F.staffOrderedAtMs({ orderedAt: null }, "2026-10-20"), Date.parse("2026-10-20T00:00:00+09:00"));
  assert.match(indexSrc, /Flow\.staffOrderedAtMs\(kase, who\.receivedDate\)/);
});

t("受注: 出荷の項目（新規作成と使い直しで同じものを書く）", () => {
  const q = { id: "q9", caseNumber: 255, estNo: "EST-9", corpName: "法人A", officeName: "事業所A", contactName: "見積の担当",
    plan: "houmon", items: [{ sku: "BT", subsidyQty: 2, extraQty: 1 }, { sku: "USB-C", subsidyQty: 1 }, { sku: "USB-A", subsidyQty: 3 }] };
  const d = { company: "届け先法人", officeName: "届け先事業所", postalCode: "100-0001", address: "東京都千代田区1-1", contactName: "受取人", phone: "03-0000-0000" };
  const f = F.shipmentFieldsFromAccept({ q, delivery: d, shipItems: [{ sku: "BT", qty: 3 }], btSku: "BT", preferredDate: "2026-11-01", payKey: "before", note: "午前希望" });
  assert.deepEqual(f, {
    caseNumber: 255, quoteId: "q9", estNo: "EST-9",
    company: "届け先法人", officeName: "届け先事業所", postal: "100-0001", address: "東京都千代田区1-1",
    contactName: "受取人", phone: "03-0000-0000", items: [{ sku: "BT", qty: 3 }],
    subsidyCategory: "houmon", subsidyQty: { bt: 2, usb: 4 },
    preferredDate: "2026-11-01", payMethod: "before", orderNote: "午前希望",
  });
  // 届け先が空なら見積もりの値で埋める・段取りの項目（状態・番号・出荷元）は含めない
  const g = F.shipmentFieldsFromAccept({ q, delivery: {}, shipItems: [], btSku: "BT", payKey: "after" });
  assert.equal(g.company, "法人A"); assert.equal(g.officeName, "事業所A"); assert.equal(g.contactName, "見積の担当");
  assert.equal(g.postal, ""); assert.equal(g.preferredDate, ""); assert.equal(g.orderNote, "");
  for (const k of ["status", "soNumber", "shipType", "partnerEmail", "shippingMethod", "createdAt", "shipDate", "caseId"]) assert.ok(!(k in g), k);
  assert.equal(F.shipmentFieldsFromAccept({ q, note: "x".repeat(1200), btSku: "BT" }).orderNote.length, 1000);
  assert.deepEqual(F.subsidyQtyFromItems(undefined, "BT"), { bt: 0, usb: 0 });
  // 結線: 使い直しも新規作成も orderFields を書く・reviseQuote は subsidyCategory/subsidyQty も更新
  assert.match(indexSrc, /tx\.update\(db\.collection\("shipments"\)\.doc\(shipId\), \{\s*\.\.\.orderFields,/);
  assert.match(indexSrc, /caseId: q\.caseId, \.\.\.orderFields,/);
  assert.match(indexSrc, /subsidyCategory: planKey \|\| null, subsidyQty: Flow\.subsidyQtyFromItems\(items, Pricing\.SKU\.BT\)/);
});

t("受注: Web の既存出荷の使い直し", () => {
  // 何もない → 新規
  assert.deepEqual(F.planWebShipment([]), { reuse: null, duplicateWarning: false, existingNos: [], extraPre: 0 });
  // キャンセルだけ → 新規・警告なし
  assert.equal(F.planWebShipment([{ id: "a", status: "canceled", soNumber: "SH-1" }]).reuse, null);
  assert.equal(F.planWebShipment([{ id: "a", status: "canceled" }]).duplicateWarning, false);
  // draft がある → 使い直す
  const d = { id: "d", status: "draft", soNumber: "SH-2" };
  assert.equal(F.planWebShipment([d]).reuse.id, "d");
  // requested を draft より優先、cases.shipmentId をさらに優先
  const r = { id: "r", status: "requested", soNumber: "SH-3" };
  assert.equal(F.planWebShipment([d, r]).reuse.id, "r");
  assert.equal(F.planWebShipment([d, r], "d").reuse.id, "d");
  assert.equal(F.planWebShipment([d, r]).extraPre, 1);
  // 発送済以降だけ → 作るが警告
  const s = F.planWebShipment([{ id: "s", status: "shipped", soNumber: "SH-4" }, { id: "p", status: "paid", soNumber: "SH-5" }]);
  assert.equal(s.reuse, null); assert.equal(s.duplicateWarning, true); assert.deepEqual(s.existingNos, ["SH-4", "SH-5"]);
  // status 未設定は発送済扱い
  assert.equal(F.planWebShipment([{ id: "x", soNumber: "SH-6" }]).duplicateWarning, true);
  // 発送済と下書きが両方 → 下書きを使い直す（警告は出さない）
  assert.equal(F.planWebShipment([{ id: "s", status: "shipped" }, d]).reuse.id, "d");
});

t("受注: 受付日（JST）→ 0時の時刻", () => {
  const ms = F.jstMidnightMs("2026-10-21");
  assert.equal(new Date(ms).toISOString(), "2026-10-20T15:00:00.000Z");
  assert.equal(F.jstMidnightMs("2026-01-01"), Date.parse("2026-01-01T00:00:00+09:00"));
  assert.equal(F.jstMidnightMs("2026-02-30"), null);
  assert.equal(F.jstMidnightMs("2026/10/21"), null);
  assert.equal(F.jstMidnightMs(""), null);
  assert.equal(F.jstYmd(new Date("2026-10-20T15:30:00Z")), "2026-10-21"); // JST 0:30
  assert.equal(F.jstYmd(new Date("2026-10-20T14:59:00Z")), "2026-10-20");
});

t("受注: 文言（件名・createdBy・Chat 見出し）", () => {
  assert.equal(F.staffAcceptSubject("phone", "EST-2026-0001", "SH-2026-0012"),
    "電話で受けたお申し込みを受注確定にしました（EST-2026-0001・出荷 SH-2026-0012）");
  assert.match(F.staffAcceptSubject("email", "EST-1", "SH-1"), /^メールで受けた/);
  assert.match(F.staffAcceptSubject("fax", "EST-1", "SH-1", true), /^FAXで受けた.*既存の下書き/);
  assert.equal(F.staffCreatedBy("phone", "a@tadakayo.jp"), "staff（電話の申込）: a@tadakayo.jp");
  assert.equal(F.staffAcceptChatHead("phone", "次田"), "📞 電話で受けたお申し込みを受注確定にしました（操作: 次田）");
  assert.equal(F.staffAcceptChatHead("other", "<b>x</b>"), "📝 その他の方法で受けたお申し込みを受注確定にしました（操作: bx/b）");
});

t("受注: グループの事前確認", () => {
  const q = (id, g, st = "issued") => ({ id, groupId: g, status: st, estNo: `EST-${id}` });
  assert.equal(F.checkAcceptGroup([q("a", "G"), q("b", "G")]).ok, true);
  assert.equal(F.checkAcceptGroup([q("a", "G"), null], ["a", "b"]).message, "見積もりが見つかりません（b）");
  assert.equal(F.checkAcceptGroup([q("a", "G"), q("b", "H")]).ok, false);
  assert.match(F.checkAcceptGroup([q("a", null), q("b", null)]).message, /^この見積もりはグループ（同じ法人の一括見積もり）ではありません/);
  assert.match(F.checkAcceptGroup([q("a", null), q("b", "G")]).message, /グループ.*ではありません/);
  assert.match(F.checkAcceptGroup([q("a", "G"), q("b", "H")]).message, /EST-b/);
  assert.match(F.checkAcceptGroup([q("a", "G"), q("b", "G", "accepted")]).message, /EST-b/);
  assert.equal(F.checkAcceptGroup([]).ok, false);
  // 1件だけ（groupQuoteIds が空）はグループでなくても通す
  assert.deepEqual(F.checkAcceptGroup([q("a", null)]), { ok: true, groupId: null });
  assert.deepEqual(F.checkAcceptGroup([q("a", "G")]), { ok: true, groupId: "G" });
  assert.equal(F.checkAcceptGroup([null], ["a"]).message, "見積もりが見つかりません（a）");
});

t("受注: 確認メールの宛先（案件を優先・無ければ見積もり）", () => {
  assert.equal(F.acceptMailTo("case@example.jp", "quote@example.jp"), "case@example.jp");
  assert.equal(F.acceptMailTo("", "quote@example.jp"), "quote@example.jp");
  assert.equal(F.acceptMailTo("不正な値", "quote@example.jp"), "quote@example.jp");
  assert.equal(F.acceptMailTo(" case@example.jp ", null), "case@example.jp");
  assert.equal(F.acceptMailTo(null, undefined), "");
  // 戻り値に mailed（真偽）・mailError（文字列 or null）を必ず含める
  assert.match(indexSrc, /mailed: mailed === true, mailError: mailError \|\| null/);
  assert.match(indexSrc, /Flow\.acceptMailTo\(done\[0\]\.caseContactEmail, first\.contactEmail\)/);
});

t("新しい版へ出荷の参照を引き継がない（レビュー指摘 3）", () => {
  assert.equal(F.inheritShipmentRef, undefined);
  assert.doesNotMatch(indexSrc, /inheritShipmentRef\(/);
  // createOrUpdateMitsumoriQuote の新しい版（quoteData）に shipmentId を書いていない
  const body = indexSrc.slice(indexSrc.indexOf("const quoteData = {"), indexSrc.indexOf("batch.set(quoteRef, quoteData)"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); // コメントは除く
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /shipmentId|shipmentNo/);
});

t("日次まとめの失敗の後始末（レビュー指摘 8）", () => {
  assert.equal(F.dailyFailureAction({ claimed: false, posted: 0 }), "none");
  assert.equal(F.dailyFailureAction({ claimed: true, posted: 0 }), "delete");
  assert.equal(F.dailyFailureAction({ claimed: true }), "delete");
  assert.equal(F.dailyFailureAction({ claimed: true, posted: 2 }), "partial");
  assert.equal(F.dailyFailureAction(), "none");
  assert.match(indexSrc, /Flow\.dailyFailureAction\(\{ claimed, posted \}\)/);
  assert.match(indexSrc, /if \(act === "delete"\) await logRef\.delete\(\)/);
});

t("requireStaff: users の読み取り失敗は internal に変換（レビュー指摘 9）", () => {
  assert.match(indexSrc, /new HttpsError\("internal", "権限の確認に失敗しました（サービスアカウントの Firestore 読み取り権限を確認）"\)/);
  assert.match(indexSrc, /fn-ai-sa に Firestore の読み取り権限/);
});

t("N1: onCaseAssigned の発火条件（assignedAt の変化で画面の操作と統合を見分ける）", () => {
  const A1 = ts("2026-10-21T01:00:00Z"), A2 = ts("2026-10-21T02:00:00Z");
  const base = { assignedUserId: null, assignedAt: null };
  const scr = { assignedUserId: "a@tadakayo.jp", assignedBy: "b@tadakayo.jp", assignedAt: A1 };
  assert.equal(F.shouldNotifyAssign(base, scr), true);
  assert.equal(F.shouldNotifyAssign(scr, { ...scr, assignedUserId: "A@tadakayo.jp" }), false); // 大文字小文字だけ
  assert.equal(F.shouldNotifyAssign(scr, { ...scr, assignedUserId: null, assignedAt: A2 }), false); // 外した
  assert.equal(F.shouldNotifyAssign(base, { ...scr, archived: true }), false);
  assert.equal(F.shouldNotifyAssign(base, { ...scr, mergedInto: "x" }), false);
  // 統合: 担当だけ書き換わり assignedAt は前のまま（古い assignedBy が残っていても通知しない）
  const old = { assignedUserId: "c@tadakayo.jp", assignedBy: "b@tadakayo.jp", assignedAt: A1 };
  assert.equal(F.shouldNotifyAssign(old, { ...old, assignedUserId: "a@tadakayo.jp" }), false);
  assert.equal(F.shouldNotifyAssign(base, { assignedUserId: "a@tadakayo.jp" }), false); // assignedAt なし
  // 画面で別の人へ（assignedAt が変わる）
  assert.equal(F.shouldNotifyAssign(old, { ...old, assignedUserId: "a@tadakayo.jp", assignedAt: A2 }), true);
  assert.equal(F.assignedAtChanged({ assignedAt: A1 }, { assignedAt: ts("2026-10-21T01:00:00Z") }), false);
});

t("N4: onConsentSigned の発火条件", () => {
  const p = { status: "pending", caseId: "c1" };
  const s = { status: "signed", caseId: "c1", signed: { method: "web", name: "x" } };
  assert.equal(F.shouldNotifyConsent(p, s), true);
  assert.equal(F.shouldNotifyConsent(s, s), false);                       // 署名済み→署名済み
  assert.equal(F.shouldNotifyConsent(p, { ...s, signed: { method: "paper" } }), false);
  assert.equal(F.shouldNotifyConsent(p, { ...s, caseId: "" }), false);
  assert.equal(F.shouldNotifyConsent({}, s), false);                       // 新規作成相当
  assert.equal(F.shouldNotifyConsent(p, { ...s, status: "canceled" }), false);
});

t("N2・N3: 日次の投稿計画（全体＋担当別の宛先）", () => {
  const now = new Date("2026-10-21T00:00:00Z"); // JST 09:00
  const old = ts("2026-10-01T00:00:00Z"), fresh = ts("2026-10-20T00:00:00Z");
  const cases = [
    { id: "1", caseNumber: 1, status: 1, officeId: "o1", officeName: "A事業所", receivedAt: old, updatedAt: old },          // 未割当の新規・初期連絡超過
    { id: "2", caseNumber: 2, status: 5, officeName: "B", assignedUserId: "Taro@tadakayo.jp", updatedAt: old },              // 太郎: 停滞
    { id: "3", caseNumber: 3, status: 1, officeName: "C", assignedUserId: "hana@tadakayo.jp", receivedAt: fresh, updatedAt: fresh }, // 花子: 新規受信
    { id: "4", caseNumber: 4, status: 6, officeName: "D", assignedUserId: "jiro@tadakayo.jp", updatedAt: fresh },             // 次郎: 未対応なし
    { id: "5", caseNumber: 5, status: 1, officeName: "E", assignedUserId: "taro@tadakayo.jp", archived: true, updatedAt: old },// 対象外
  ];
  const users = [
    { email: "taro@tadakayo.jp", name: "太郎", chatUserId: "123456789012" },
    { email: "hana@tadakayo.jp", name: "花子" },
  ];
  const regionOf = (c) => (c.officeId === "o1" ? "【大阪府 豊中市】" : "（地域不明）");
  const plan = F.planDailyPosts(nt, { cases, users, settings: { subsidyDeadline: "2027-03-12" }, now, regionOf });
  assert.ok(plan.overall);
  assert.match(plan.overall, /#1 【大阪府 豊中市】A事業所/);
  assert.match(plan.overall, /2027年3月12日/);
  assert.doesNotMatch(plan.overall, /#5/);
  const emails = plan.assignees.map((a) => a.email.toLowerCase()).sort();
  assert.deepEqual(emails, ["hana@tadakayo.jp", "taro@tadakayo.jp"]); // 次郎は未対応なしで出ない・対象外の #5 は数えない
  const taro = plan.assignees.find((a) => a.email.toLowerCase() === "taro@tadakayo.jp");
  assert.equal(taro.name, "太郎");
  assert.match(taro.text, /<users\/123456789012>/);
  assert.doesNotMatch(taro.text, /#5/);
  const hana = plan.assignees.find((a) => a.name === "花子");
  assert.match(hana.text, /花子さん/);
  assert.doesNotMatch(hana.text, /<users\//);
  // 並び: 全体 → 担当
  const texts = F.dailyPostTexts(plan);
  assert.equal(texts.length, 3);
  assert.equal(texts[0], plan.overall);
  // 期限の設定が効く
  const p2 = F.planDailyPosts(nt, { cases, users, settings: { subsidyDeadline: "2026-11-01" }, now, regionOf });
  assert.match(p2.overall, /2026年11月1日/);
  // 何もない日
  const empty = F.planDailyPosts(nt, { cases: [], users: [], settings: {}, now, regionOf });
  assert.equal(empty.overall, null);
  assert.deepEqual(empty.assignees, []);
  assert.deepEqual(F.dailyPostTexts(empty), []);
  // 祝日の表が無い年は全体に警告（全体が無くても警告だけ出す）
  const y28 = F.planDailyPosts(nt, { cases: [], users: [], settings: {}, now: new Date("2028-01-05T00:00:00Z"), regionOf });
  assert.match(y28.overall, /祝日の表に 2028 年/);
});

t("出荷指示: 取り消し後の古い送信は結果を書かない（requestSeq・Codex 指摘4）", () => {
  const ST = ["requested", "shipped", "invoiced", "paid"];
  assert.equal(F.requestSeqOf({}), 0);
  assert.equal(F.requestSeqOf({ requestSeq: 3 }), 3);
  assert.equal(F.notifyResultWritable({ status: "requested", requestSeq: 2 }, 2, ST), true);
  assert.equal(F.notifyResultWritable({ status: "shipped", requestSeq: 2 }, 2, ST), true);     // 送信中に発送済にした
  assert.equal(F.notifyResultWritable({ status: "draft", requestSeq: 2 }, 2, ST), false);      // 送信中に取り消した
  assert.equal(F.notifyResultWritable({ status: "requested", requestSeq: 3 }, 2, ST), false);  // 取り消し→再依頼した
  assert.equal(F.notifyResultWritable({ status: "canceled", requestSeq: 2 }, 2, ST), false);
  assert.equal(F.notifyResultWritable({ status: "requested" }, 0, ST), true);                  // 番号の無い古い出荷
  assert.equal(F.notifyResultWritable(null, 0, ST), false);
  const now = Date.parse("2026-10-21T10:00:00Z");
  assert.equal(F.notifyInFlight({ shipNotifyLockAt: { toMillis: () => now - 3000 } }, now), true);
  assert.equal(F.notifyInFlight({ shipNotifyLockAt: { toMillis: () => now - 90000 } }, now), false);
  // 古い送信は自分が付けたロックだけ外す（E2E で発見: 外さないと再依頼の投稿が60秒「投稿中」で止まる）
  const mine = { toMillis: () => 1000 }, other = { toMillis: () => 2000 };
  assert.equal(F.ownsNotifyLock({ shipNotifyLockAt: mine }, { toMillis: () => 1000 }), true);
  assert.equal(F.ownsNotifyLock({ shipNotifyLockAt: other }, mine), false);
  assert.equal(F.ownsNotifyLock({ shipNotifyLockAt: null }, mine), false);
  assert.match(indexSrc, /if \(Flow\.ownsNotifyLock\(cur, lockTs\)\) tx\.update\(ref, \{ shipNotifyLockAt: null \}\)/);
  // 結線: ロックで番号を控え、結果の3か所（未設定・失敗・投稿済み）はどれも writeResult（番号の照合つき tx）で書く
  const fn = indexSrc.slice(indexSrc.indexOf("exports.notifyShipment"), indexSrc.indexOf("// ===== LP アクセス解析"));
  assert.match(fn, /return \{ seq: Flow\.requestSeqOf\(d\) \}/);
  assert.match(fn, /Flow\.notifyResultWritable\(cur, gate\.seq, NOTIFY_STATUSES\)/);
  assert.equal((fn.match(/await writeResult\(/g) || []).length, 3);
  assert.match(fn, /const wrote = await writeResult\(/);
  assert.ok(!/await ref\.update\(/.test(fn), "notifyShipment の結果は ref.update で直接書かない");
  assert.match(fn, /取り消し後の古い送信のため記録しない/);
  // ship-flow.js（画面）の notifyInFlight と同じ判定
  const sf = fs.readFileSync(new URL("../admin/js/ship-flow.js", import.meta.url), "utf8");
  assert.match(sf, /export function notifyInFlight/);
  const sup = fs.readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  assert.match(sup, /requestedAt: serverTimestamp\(\), requestSeq: increment\(1\)/);
  assert.match(sup, /if\(notifyInFlight\(cur\)\) throw new Error\(NOTIFY_IN_FLIGHT_MSG\)/);
});

console.log(`OK: test-functions-wiring ${n} 件`);

// ===== 2026-10-21 Codex 指摘: 全件の投稿に失敗したら記録を消して再実行できる =====
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  const i = src.indexOf("exports.dailyFollowup");
  const body = src.slice(i, src.indexOf("exports.previewDailyFollowup"));
  if (!/dailyFailureAction\(\{ claimed, posted \}\) === "delete" && errs\.length\)[\s\S]*?logRef\.delete\(\)/.test(body)) {
    throw new Error("dailyFollowup: 全件失敗時に _notifyLog を消す処理が無い");
  }
  console.log("OK test-functions-wiring 追加: 全件失敗で記録を消す");
}
