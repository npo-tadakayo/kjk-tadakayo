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

// ===== 2026-10-21 Codex 指摘: 請求先が認定事業者（dropship）の下書きは Web 申込で使い直さない =====
{
  const { createRequire } = await import("node:module");
  const F2 = createRequire(import.meta.url)("../functions/accept-flow.js");
  const p1 = F2.planWebShipment([{ id: "d1", status: "draft", shipType: "dropship", soNumber: "SH-2026-0001" }], null);
  if (p1.reuse !== null || p1.duplicateWarning !== true || p1.existingNos[0] !== "SH-2026-0001") throw new Error("dropship の下書きを使い直している");
  const p2 = F2.planWebShipment([{ id: "d1", status: "draft", shipType: "dropship" }, { id: "d2", status: "draft", shipType: "direct" }], "d1");
  if (!p2.reuse || p2.reuse.id !== "d2") throw new Error("direct の下書きを使い直していない");
  const p3 = F2.planWebShipment([{ id: "d3", status: "requested" }], null);
  if (!p3.reuse || p3.reuse.id !== "d3") throw new Error("shipType 未設定（direct 扱い）の依頼済を使い直していない");
  console.log("OK test-functions-wiring 追加: dropship の下書きは使い直さない");
}

// ===== 2026-10-24 事業所の編集・統合（設計 docs/顧客情報の修正メニュー_設計_20261024.md §7）=====
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  const blockOf = (name) => {
    const i = src.indexOf(`exports.${name} = onCall(`);
    if (i < 0) throw new Error(`${name}: exports.${name} = onCall( が無い`);
    const j = src.indexOf("\nexports.", i + 10);
    return src.slice(i, j < 0 ? undefined : j);
  };
  for (const name of ["updateOffice", "mergeOffices", "unmergeOffice"]) {
    const b = blockOf(name);
    if (!/region: "asia-northeast1"/.test(b)) throw new Error(`${name}: region が asia-northeast1 でない`);
    if (!/serviceAccount: SA_BATCH/.test(b)) throw new Error(`${name}: Firestore を読み書きできる SA（SA_BATCH）でない`);
    if (!/await requireStaff\(request, \{ allow: "editor" \}\)/.test(b)) throw new Error(`${name}: requireStaff(editor) が無い`);
    // 認可を最初に（入力を見る前に）
    if (b.indexOf("requireStaff") > b.indexOf("request.data")) throw new Error(`${name}: requireStaff より前に入力を読んでいる`);
  }
  // 判定は office-merge.mjs（正本 admin/js/office-merge.js のコピー）を import() で使う
  if (!/import\("\.\/office-merge\.mjs"\)/.test(src)) throw new Error("office-merge.mjs を import() していない");
  const mb = blockOf("mergeOffices");
  for (const col of ["cases", "quotes", "shipments", "leadTokens"]) {
    if (!new RegExp(`"${col}"`).test(src.slice(src.indexOf("OFFICE_MOVE_COLLECTIONS ="), src.indexOf("OFFICE_MOVE_COLLECTIONS =") + 120))) throw new Error(`付け替え対象に ${col} が無い`);
  }
  if (!/om\.checkMerge\(from, to, fromId, toId\)/.test(mb)) throw new Error("mergeOffices: checkMerge を使っていない");
  if (!/mergeStatus: "running"/.test(mb) || !/mergeStatus: "done"/.test(mb)) throw new Error("mergeOffices: running → done の段取りが無い");
  // 取り消し用の記録は事業所の文書ではなくサブコレクション mergeLog に（文書の上限 1MiB を超えないように）
  if (!/collection\("mergeLog"\)/.test(mb) || !/snapshots/.test(mb)) throw new Error("mergeOffices: 取り消し用の記録（mergeLog）が無い");
  if (/mergedRefs|mergedCaseSnapshots/.test(mb)) throw new Error("mergeOffices: 記録を事業所の文書に入れている");
  // 作業中の印（同じ事業所への操作を1つずつ）
  if (!/lockOffices\(\[fromId, toId\], "merge"/.test(mb)) throw new Error("mergeOffices: from と to に印を取っていない");
  if (!/finally \{\s*await unlockOffices\(\[fromId, toId\], lockId\)/.test(mb)) throw new Error("mergeOffices: finally で印を外していない");
  if (!/mergedInto", "==", fromId/.test(mb)) throw new Error("mergeOffices: from へ統合中の処理を確かめていない");
  if (/consentRequests/.test(mb)) throw new Error("mergeOffices: 承諾書に触れている");
  const ub = blockOf("unmergeOffice");
  if (!/om\.pickRestorable\(ids, cur, toId\)/.test(ub)) throw new Error("unmergeOffice: いまも残す側を指すものだけ戻していない");
  if (!/f\.mergeStatus !== "done"/.test(ub)) throw new Error("unmergeOffice: done 以外を断っていない");
  if (!/t && t\.mergedInto/.test(ub)) throw new Error("unmergeOffice: 統合先がさらに統合済みのときに断っていない");
  if (!/om\.canRestoreTo\(to, wrote\)/.test(ub)) throw new Error("unmergeOffice: to が編集されていないときだけ戻す判定が無い");
  if (!/lockOffices\(\[fromId, toId\], "unmerge"/.test(ub)) throw new Error("unmergeOffice: 印を取っていない");
  const eb = blockOf("updateOffice");
  if (!/om\.validatePatch\(patch\)/.test(eb)) throw new Error("updateOffice: validatePatch を使っていない");
  if (!/om\.buildAliases\(/.test(eb)) throw new Error("updateOffice: 旧名を aliases に足していない");
  if (!/lockOffices\(\[officeId\], "update"/.test(eb)) throw new Error("updateOffice: 印を取っていない");
  if (!/const o = datas\[officeId\]/.test(eb)) throw new Error("updateOffice: 印を取った中で読んだ値で案件を直していない");
  // findActiveCase は完全一致を先に・無ければ aliases
  const fa = src.slice(src.indexOf("async function findActiveCase"), src.indexOf("async function issueLeadToken"));
  if (!/om\.nameMatchesOffice\(officeName, c\.officeName, office\)/.test(fa)) throw new Error("findActiveCase: aliases で一致を見ていない");
  if (fa.indexOf("exact") > fa.indexOf("nameMatchesOffice")) throw new Error("findActiveCase: 完全一致より先に aliases を見ている");
  // 見積もり作成は mergedInto をたどって残る側に読み替えてから officeId を使う
  const cq = src.slice(src.indexOf("async function createOrUpdateMitsumoriQuote"), src.indexOf("exports.webhookMitsumori"));
  const iRes = cq.indexOf("resolveMergedIdAsync"), iUse = cq.indexOf("const quoteData");
  if (iRes < 0 || iRes > iUse) throw new Error("createOrUpdateMitsumoriQuote: officeId を使う前に統合先へ読み替えていない");
  console.log("OK test-functions-wiring 追加: 事業所の編集・統合（3つの Callable・findActiveCase・見積もり作成）");
}

// ===== 2026-10-24 倉庫（設計 docs/倉庫メニュー_設計_20261024.md §9）=====
{
  const { createRequire } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const F3 = createRequire(import.meta.url)("../functions/accept-flow.js");
  const src = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  // roleAllows の表: 倉庫の人は viewer/editor/admin のどれも通らず、"warehouse" だけ通る
  const roles = { admin: "admin", staff: "staff", none: undefined, empty: "", viewer: "viewer", trainee: "trainee", warehouse: "warehouse", other: "unknown" };
  const expect = {
    //            viewer editor admin  warehouse
    admin:     [true,  true,  true,  true],
    staff:     [true,  true,  false, true],
    none:      [true,  true,  false, true],
    empty:     [true,  true,  false, true],
    viewer:    [true,  false, false, false],
    trainee:   [false, false, false, false],
    warehouse: [false, false, false, true],
    other:     [true,  true,  false, false], // 不明なロールは従来どおり（viewer/editor は通る）・倉庫は通さない
  };
  const allows = ["viewer", "editor", "admin"];
  for (const [k, role] of Object.entries(roles)) {
    const u = role === undefined ? { active: true } : { active: true, role };
    allows.forEach((a, i) => {
      if (F3.roleAllows(u, a) !== expect[k][i]) throw new Error(`roleAllows(${k}, ${a}) が ${!expect[k][i]}`);
    });
    if (F3.roleAllows(u, "warehouse") !== expect[k][3]) throw new Error(`roleAllows(${k}, warehouse) が ${!expect[k][3]}`);
    for (const a of [...allows, "warehouse"]) if (F3.roleAllows({ ...u, active: false }, a)) throw new Error(`無効な ${k} が ${a} を通る`);
  }
  if (F3.roleAllows({ active: true, role: "warehouse", locationIds: ["L1"] }, "editor")) throw new Error("倉庫の人が editor を通る");
  if (F3.roleAllows(null, "warehouse")) throw new Error("null が warehouse を通る");

  const blockOf = (name) => {
    const i = src.indexOf(`exports.${name} = onCall(`);
    if (i < 0) throw new Error(`${name}: exports.${name} = onCall( が無い`);
    const j = src.indexOf("\nexports.", i + 10);
    return src.slice(i, j < 0 ? undefined : j);
  };
  for (const name of ["warehouseList", "warehouseShip", "warehouseHandover", "warehouseReject", "warehouseFixTracking"]) {
    const b = blockOf(name);
    if (!/region: "asia-northeast1"/.test(b)) throw new Error(`${name}: region が asia-northeast1 でない`);
    if (!/serviceAccount: SA_BATCH/.test(b)) throw new Error(`${name}: SA_BATCH でない`);
    if (!/const me = await requireWarehouse\(request\)/.test(b)) throw new Error(`${name}: requireWarehouse が無い`);
    if (b.indexOf("requireWarehouse") > b.indexOf("request.data")) throw new Error(`${name}: 認可より前に入力を読んでいる`);
    if (/requireStaff\(request, \{ allow: "editor" \}\)/.test(b)) throw new Error(`${name}: editor の認可（倉庫の人が使えない）`);
  }
  // requireWarehouse は requireStaff("warehouse") ＋ canUseLocation
  const rw = src.slice(src.indexOf("async function requireWarehouse"), src.indexOf("// ===== App Check"));
  if (!/requireStaff\(request, \{ allow: "warehouse" \}\)/.test(rw)) throw new Error("requireWarehouse: allow warehouse でない");
  if (!/wr\.canUseLocation\(me\.user, locationId\)/.test(rw)) throw new Error("requireWarehouse: canUseLocation を使っていない");
  if (!/import\("\.\/warehouse-rules\.mjs"\)/.test(src)) throw new Error("warehouse-rules.mjs を import() していない");
  // 一覧は保管場所を確かめ、W（projectForWarehouse）だけを返す
  const lb = blockOf("warehouseList");
  if (!/assertWarehouseLocation\(me, locationId\)/.test(lb)) throw new Error("warehouseList: 保管場所の権限を確かめていない");
  if ((lb.match(/wr\.projectForWarehouse\(s\)/g) || []).length !== 2) throw new Error("warehouseList: requested/done を projectForWarehouse で返していない");
  if (!/wr\.warehouseActionable\(s, locationId, locs\.defaultId\)/.test(lb)) throw new Error("warehouseList: warehouseActionable を使っていない");
  // 発送・受け渡しは共通のトランザクション（supply.js の発送済にすると同じ結果）
  const wc = src.slice(src.indexOf("async function warehouseComplete"), src.indexOf("exports.warehouseShip"));
  for (const [re, what] of [
    [/db\.runTransaction\(/, "トランザクション"],
    [/cur\.status !== "requested"/, "依頼済のままかの確認"],
    [/wr\.stockShortage\(cur\.items, productsBySku, locId\)/, "在庫不足の確認"],
    [/wr\.canUseLocation\(me\.user, locId\)/, "出荷元の場所の権限"],
    [/stock: admin\.firestore\.FieldValue\.increment\(-need\[sku\]\)/, "合計の在庫"],
    [/patch\[`stockByLocation\.\$\{locId\}`\] = admin\.firestore\.FieldValue\.increment\(-need\[sku\]\)/, "場所の在庫"],
    [/collection\("inventoryMovements"\)/, "在庫の動きの記録"],
    [/reason: "shipment", refNo: cur\.soNumber/, "理由と参照番号"],
    [/dueRule: "net14"/, "dueRule"],
    [/shippedBy: me\.name, shippedByEmail: me\.email, shippedAt: now/, "shippedBy*"],
    [/warehouseIssue: admin\.firestore\.FieldValue\.delete\(\)/, "差し戻しを消す"],
    [/po\.ref, \{ status: "shipped"/, "認定事業者の受注も出荷済に"],
  ]) if (!re.test(wc)) throw new Error(`warehouseComplete: ${what}が無い`);
  if (!/warehouseComplete\(me, shipmentId, "ship"/.test(blockOf("warehouseShip"))) throw new Error("warehouseShip: 発送で呼んでいない");
  const hb = blockOf("warehouseHandover");
  if (!/warehouseComplete\(me, shipmentId, "pickup"/.test(hb)) throw new Error("warehouseHandover: 持ち出しで呼んでいない");
  if (!/handedOverAt: now, handedOverByEmail: me\.email, handedOverByName: me\.name/.test(hb)) throw new Error("warehouseHandover: 受け渡しの記録が無い");
  const rb = blockOf("warehouseReject");
  if (!/wr\.validateIssue\(/.test(rb)) throw new Error("warehouseReject: validateIssue を使っていない");
  if (!/if \(cur\.warehouseIssue\) throw/.test(rb)) throw new Error("warehouseReject: 二重の差し戻しを止めていない");
  if (!/getWebhook\("shipping"\)/.test(rb)) throw new Error("warehouseReject: 出荷指示と同じ投稿先でない");
  if (!/chatMentionFor\(s\.requestedByEmail/.test(rb)) throw new Error("warehouseReject: 依頼した人へメンションしていない");
  if (!/notified: true/.test(rb) || !/notified: false/.test(rb)) throw new Error("warehouseReject: notified を返していない");
  const fb = blockOf("warehouseFixTracking");
  if (!/cur\.shipDate >= since/.test(fb)) throw new Error("warehouseFixTracking: 30日の制限が無い");
  if (!/WAREHOUSE_DONE_DAYS = 30/.test(src)) throw new Error("30日の定数が無い");
  // notifyShipment: 持ち出しの文面・倉庫の画面へのリンク・倉庫の人は投稿できない
  if (!/const WAREHOUSE_URL = `\$\{CRM_BASE_URL\}\/warehouse`/.test(src)) throw new Error("WAREHOUSE_URL が無い");
  const sm = src.slice(src.indexOf("function shipmentChatMessage"), src.indexOf("async function chatMentionFor"));
  if ((sm.match(/🏬 倉庫の画面: \$\{WAREHOUSE_URL\}/g) || []).length !== 2) throw new Error("出荷指示: 発送・持ち出しの両方に倉庫の画面へのリンクが無い");
  if (!/【持ち出し】/.test(sm)) throw new Error("出荷指示: 持ち出しの文面が無い");
  const nb = blockOf("notifyShipment");
  if (!/ud\.role === "warehouse"/.test(nb)) throw new Error("notifyShipment: 倉庫の人を止めていない");
  if (!/chatMentionFor\(s\.pickupByEmail, s\.pickupByName\)/.test(nb)) throw new Error("notifyShipment: 持ち出す人へメンションしていない");
  console.log("OK test-functions-wiring 追加: 倉庫（roleAllows の表・5つの Callable・出荷指示の文面）");
}
