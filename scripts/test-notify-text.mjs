// Chat 通知の分類と文面（functions/notify-text.mjs）のテスト。node scripts/test-notify-text.mjs
// 設計: docs/CRM改善_設計_20261021.md §3・§11
import assert from "node:assert/strict";
import * as N from "../functions/notify-text.mjs";
import * as C from "../admin/js/constants.js";
import * as FCadmin from "../admin/js/first-contact.js";
import * as FCfn from "../functions/first-contact.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; };

// JST 正午の Date
const d = (s, time = "12:00:00") => new Date(`${s}T${time}+09:00`);
const daysAgo = (now, k) => new Date(now.getTime() - k * 86400000);
const NOW = d("2026-10-21", "09:00:00"); // 水曜

// ===== 定数が admin/js/constants.js と一致する（コピーしていないことの担保）=====
t("定数の一致", () => {
  assert.deepEqual(N.STATUS_LABELS, C.STATUS_LABELS);
  assert.deepEqual(N.ENGAGED_STATUSES, C.ENGAGED_STATUSES);
  assert.deepEqual(N.TERMINAL, C.TERMINAL);
  assert.deepEqual(N.ACTIVE_PRE_APPLY, C.ACTIVE_PRE_APPLY);
  assert.equal(N.STALE_DAYS, C.STALE_DAYS);
  assert.equal(N.DEADLINE.getTime(), C.DEADLINE.getTime());
});

// ===== resolveDeadline は constants.js と同じ結果 =====
t("resolveDeadline", () => {
  for (const s of [undefined, null, {}, { subsidyDeadline: "2027-02-28" }, { subsidyDeadline: "2027/02/28" },
    { subsidyDeadline: "" }, { subsidyDeadline: 20270228 }, { subsidyDeadline: "2026-12-01" }]) {
    assert.equal(N.resolveDeadline(s).getTime(), C.resolveDeadline(s).getTime(), JSON.stringify(s));
  }
  assert.equal(N.resolveDeadline({ subsidyDeadline: "2027-02-28" }).toISOString(), "2027-02-28T14:59:59.000Z");
});

// ===== functions/first-contact.mjs が admin 側と同じ結果（既存 test-first-contact の代表点）=====
t("first-contact の同一性", () => {
  const pairs = [["2026-10-16", "2026-10-23"], ["2026-10-16", "2026-10-26"], ["2026-11-02", "2026-11-11"],
    ["2026-09-18", "2026-10-01"], ["2025-12-26", "2026-01-13"], ["2026-12-30", "2027-01-12"], ["2027-03-19", "2027-03-30"],
    ["2026-10-20", "2026-10-16"]];
  for (const [a, b] of pairs) {
    assert.equal(FCfn.countBusinessDaysOver(d(a), d(b)), FCadmin.countBusinessDaysOver(d(a), d(b)), `${a}→${b}`);
    assert.equal(FCfn.businessDaysElapsed(d(a), d(b)), FCadmin.businessDaysElapsed(d(a), d(b)), `${a}→${b}`);
  }
  assert.deepEqual(FCfn.JP_HOLIDAYS, FCadmin.JP_HOLIDAYS);
  assert.equal(FCfn.FIRST_CONTACT_LIMIT, FCadmin.FIRST_CONTACT_LIMIT);
  assert.equal(FCfn.countBusinessDaysOver(d("2026-10-16"), d("2026-10-26")), 1);
});

// ===== mentionOf =====
t("mentionOf", () => {
  assert.equal(N.mentionOf({ chatUserId: "12345", displayName: "次田" }), "<users/12345>");
  assert.equal(N.mentionOf({ chatUserId: "1".repeat(30) }), `<users/${"1".repeat(30)}>`);
  assert.equal(N.mentionOf({ chatUserId: 109876543210 }), "<users/109876543210>"); // 数値で入っていても数字なら可
  assert.equal(N.mentionOf({ chatUserId: " 12345 ", displayName: "次田" }), "<users/12345>");
  assert.equal(N.mentionOf({ chatUserId: "1234", displayName: "次田" }), "次田さん");        // 4桁は不可
  assert.equal(N.mentionOf({ chatUserId: "1".repeat(31), displayName: "次田" }), "次田さん"); // 31桁は不可
  assert.equal(N.mentionOf({ chatUserId: "users/12345", displayName: "次田" }), "次田さん");  // 数字のみ
  assert.equal(N.mentionOf({ chatUserId: "all", displayName: "次田" }), "次田さん");
  assert.equal(N.mentionOf({ displayName: "<b>*次田*</b>_~`" }), "b次田/bさん");             // 記号は除去
  assert.equal(N.mentionOf({ displayName: "<users/all>" }), "users/allさん");               // メンションに化けない
  assert.equal(N.mentionOf({ email: "sato@tadakayo.jp" }), "satoさん");                     // users に名前が無い→@の前
  assert.equal(N.mentionOf(null), "担当者さん");
  assert.ok(!N.mentionOf({ email: "sato@tadakayo.jp" }).includes("@"));
});

// ===== isLive =====
t("isLive", () => {
  assert.equal(N.isLive({ status: 1 }), true);
  assert.equal(N.isLive({ status: 1, archived: true }), false);
  assert.equal(N.isLive({ status: 1, archived: false }), true);
  assert.equal(N.isLive(null), false);
});

// ===== 分類の境界 =====
const base = (o) => ({ caseNumber: o.id, officeName: `事業所${o.id}`, updatedAt: NOW, receivedAt: d("2026-10-20"), ...o });

t("停滞 6日/7日", () => {
  const cls = N.classifyCases([
    base({ id: "a6", status: 5, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 6) }),
    base({ id: "a7", status: 5, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 7) }),
    base({ id: "u6", status: 2, updatedAt: daysAgo(NOW, 6) }),
    base({ id: "u7", status: 2, updatedAt: daysAgo(NOW, 7) }),
    base({ id: "t13", status: 13, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 30) }), // 完了は対象外
    base({ id: "t4", status: 4, updatedAt: daysAgo(NOW, 30) }),                                 // 失注は対象外
    base({ id: "nu", status: 6, assignedUserId: "a@tadakayo.jp", updatedAt: null }),           // 更新日なしは停滞にしない
  ], { now: NOW });
  assert.deepEqual(cls.assignees["a@tadakayo.jp"].stale.map((e) => e.c.id), ["a7"]);
  assert.equal(cls.assignees["a@tadakayo.jp"].stale[0].days, 7);
  assert.deepEqual(cls.overall.staleUnassigned.map((e) => e.c.id), ["u7"]);
  // Timestamp 相当（toMillis）も読める
  const ts = { toMillis: () => daysAgo(NOW, 8).getTime() };
  const cls2 = N.classifyCases([base({ id: "x", status: 6, assignedUserId: "a@tadakayo.jp", updatedAt: ts })], { now: NOW });
  assert.equal(cls2.assignees["a@tadakayo.jp"].stale[0].days, 8);
});

t("入金待ち 13日/14日", () => {
  const cls = N.classifyCases([
    base({ id: "p13", status: 11, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 13) }),
    base({ id: "p14", status: 11, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 14) }),
    base({ id: "q14", status: 10, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 14) }), // 11 以外は対象外
  ], { now: NOW });
  assert.deepEqual(cls.assignees["a@tadakayo.jp"].awaitingDeposit.map((e) => e.c.id), ["p14"]);
});

t("期限 31日/30日", () => {
  const cases = [
    base({ id: "s1", status: 9, assignedUserId: "a@tadakayo.jp" }),
    base({ id: "s2", status: 10, assignedUserId: "a@tadakayo.jp" }), // 申請済は対象外
    base({ id: "s3", status: 2 }),                                   // 担当なし（全体の件数には入る）
  ];
  const at = (days) => new Date(NOW.getTime() + days * 86400000);
  const c31 = N.classifyCases(cases, { now: NOW, deadline: at(31) });
  assert.equal(c31.deadlineDays, 31);
  assert.equal(c31.assignees["a@tadakayo.jp"], undefined); // 他に何も無いので担当の入れ物も無い
  assert.equal(c31.deadlineNearAll, 0);
  const c30 = N.classifyCases(cases, { now: NOW, deadline: at(30) });
  assert.equal(c30.deadlineDays, 30);
  assert.deepEqual(c30.assignees["a@tadakayo.jp"].deadlineNear.map((e) => e.c.id), ["s1"]);
  assert.equal(c30.deadlineNearAll, 2);
  // 残り日数は切り上げ（画面の daysUntilDeadline と同じ）
  assert.equal(N.classifyCases([], { now: NOW, deadline: new Date(NOW.getTime() + 29.5 * 86400000) }).deadlineDays, 30);
  // 設定値の期限で全体1通の見出しが変わる
  const msg = N.buildOverallDigest(N.classifyCases([base({ id: "z", status: 1 })], { now: NOW,
    deadline: N.resolveDeadline({ subsidyDeadline: "2027-02-28" }) }), {});
  assert.ok(msg.includes("申請期限 2027年2月28日 まで残り 131 日"), msg);
});

t("初期連絡の超過（金曜受付→翌々週で超過・状態2は対象外）", () => {
  const cases = [
    base({ id: "f1", status: 1, receivedAt: d("2026-10-16") }),                                  // 金曜受付・担当なし
    base({ id: "f2", status: 1, receivedAt: d("2026-10-16"), assignedUserId: "a@tadakayo.jp" }), // 金曜受付・担当あり
    base({ id: "f3", status: 2, receivedAt: d("2026-10-01") }),                                  // 確認中は対象外
    base({ id: "f4", status: 1, receivedAt: null, createdAt: d("2026-10-16") }),                 // receivedAt が無ければ createdAt
  ];
  const fri = N.classifyCases(cases, { now: d("2026-10-23", "18:00:00") }); // 翌週の金曜＝ちょうど5営業日
  assert.equal(fri.overall.firstContactOver.length, 0);
  const mon = N.classifyCases(cases, { now: d("2026-10-26", "09:00:00") }); // 翌々週の月曜＝6営業日目
  assert.deepEqual(mon.overall.firstContactOver.map((e) => e.c.id), ["f1", "f2", "f4"]);
  assert.equal(mon.overall.firstContactOver[0].days, 1);
  assert.deepEqual(mon.assignees["a@tadakayo.jp"].firstContactOver.map((e) => e.c.id), ["f2"]);
  // 祝日の表を渡せる（空の表なら 10-12 が平日扱いになり早く超過する）
  const c = [base({ id: "h", status: 1, receivedAt: d("2026-10-09") })];
  assert.equal(N.classifyCases(c, { now: d("2026-10-19") }).overall.firstContactOver.length, 0);
  assert.equal(N.classifyCases(c, { now: d("2026-10-19"), holidays: [] }).overall.firstContactOver.length, 1);
});

t("archived 除外", () => {
  const cls = N.classifyCases([
    base({ id: "x1", status: 1, archived: true, receivedAt: d("2026-09-01"), updatedAt: daysAgo(NOW, 30) }),
    base({ id: "x2", status: 3, archived: true }),
    base({ id: "x3", status: 11, archived: true, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 30) }),
  ], { now: NOW, deadline: new Date(NOW.getTime() + 5 * 86400000) });
  const o = cls.overall;
  assert.equal(o.firstContactOver.length + o.newUnassigned.length + o.engagedUnassigned.length + o.staleUnassigned.length, 0);
  assert.deepEqual(cls.assignees, {});
  assert.equal(cls.deadlineNearAll, 0);
  assert.equal(N.buildOverallDigest(cls, {}), null);
});

t("状態1未割当と状態3未割当の振り分け", () => {
  const cls = N.classifyCases([
    base({ id: "n1", status: 1 }),
    base({ id: "n2", status: 2 }),                                 // 確認中・未割当はどちらでもない
    base({ id: "n3", status: 3 }),
    base({ id: "n5", status: 5, assignedUserId: "" }),             // 空文字も未割当
    base({ id: "n13", status: 13 }),                               // 画面と同じ定義（ENGAGED に 13 が入っている）
    base({ id: "n4", status: 4 }),                                 // 失注は対象外
    base({ id: "a1", status: 1, assignedUserId: "a@tadakayo.jp" }), // 担当ありの新規は担当の通知へ
    base({ id: "a3", status: 3, assignedUserId: "a@tadakayo.jp" }),
  ], { now: NOW });
  assert.deepEqual(cls.overall.newUnassigned.map((e) => e.c.id), ["n1"]);
  assert.deepEqual(cls.overall.engagedUnassigned.map((e) => e.c.id), ["n3", "n5", "n13"]);
  assert.deepEqual(cls.assignees["a@tadakayo.jp"].newReceived.map((e) => e.c.id), ["a1"]);
});

t("担当別（大文字小文字違いのメール・users に無い担当）", () => {
  const cls = N.classifyCases([
    base({ id: "m1", status: 1, assignedUserId: "Sato@tadakayo.jp" }),
    base({ id: "m2", status: 1, assignedUserId: " sato@TADAKAYO.jp " }),
    base({ id: "m3", status: 1, assignedUserId: "ghost@tadakayo.jp" }),
  ], { now: NOW });
  assert.deepEqual(Object.keys(cls.assignees).sort(), ["ghost@tadakayo.jp", "sato@tadakayo.jp"]);
  assert.equal(cls.assignees["sato@tadakayo.jp"].newReceived.length, 2);
  // users にいる人（Chat ID あり）→ メンション
  const users = { "sato@tadakayo.jp": { email: "sato@tadakayo.jp", displayName: "佐藤", chatUserId: "112233445566" } };
  const m1 = N.buildAssigneeDigest(users["sato@tadakayo.jp"], cls.assignees["sato@tadakayo.jp"], { deadlineDays: 142 });
  assert.ok(m1.startsWith("🗓 <users/112233445566> さん、"), m1);
  assert.ok(m1.includes("*📥 新規受信のまま（2件）*"));
  // users に無い担当 → メンションにせず「@の前さん」。メールアドレスは載せない
  const m2 = N.buildAssigneeDigest(undefined, cls.assignees["ghost@tadakayo.jp"], {});
  assert.ok(m2.startsWith("🗓 ghostさん、"), m2);
  assert.ok(!m2.includes("@"));
  assert.ok(!m2.includes("<users/"));
});

t("0件なら null", () => {
  const cls = N.classifyCases([], { now: NOW });
  assert.equal(N.buildOverallDigest(cls, {}), null);
  assert.equal(N.buildAssigneeDigest({ displayName: "佐藤" }, undefined, {}), null);
  assert.equal(N.buildAssigneeDigest({ displayName: "佐藤" },
    { email: "s", newReceived: [], stale: [], awaitingDeposit: [], deadlineNear: [], firstContactOver: [] }, {}), null);
  // 担当済みで動いている案件だけなら全体は null
  const cls2 = N.classifyCases([base({ id: "ok", status: 6, assignedUserId: "a@tadakayo.jp" })], { now: NOW });
  assert.equal(N.buildOverallDigest(cls2, {}), null);
  assert.deepEqual(cls2.assignees, {});
});

t("10件超で「ほか」", () => {
  const many = (k) => Array.from({ length: k }, (_, i) => base({ id: `c${i + 1}`, status: 1 }));
  const m10 = N.buildOverallDigest(N.classifyCases(many(10), { now: NOW }), {});
  assert.ok(!m10.includes("ほか"));
  assert.ok(m10.includes("#c10 "));
  const m12 = N.buildOverallDigest(N.classifyCases(many(12), { now: NOW }), {});
  assert.ok(m12.includes("*⏳ 未割当の新規案件（12件）*"));
  assert.ok(m12.includes("#c10 ") && !m12.includes("#c11 "));
  assert.ok(m12.includes("…ほか 2 件"));
});

// ===== 文面に連絡先・確認者名・利用者情報が入らない =====
const SECRET = {
  contactName: "山田花子", contactEmail: "hanako@example.jp", contactPhone: "090-1234-5678", phone: "06-1111-2222",
  email: "office@example.jp", signerName: "確認者太郎", confirmerName: "確認者太郎", userName: "利用者一郎",
  address: "大阪府豊中市1-2-3", message: "利用者一郎さんの件",
};
const leaks = (text) => Object.values(SECRET).filter((v) => text.includes(v));

t("文面に連絡先・確認者名を含めない", () => {
  const cases = [
    base({ id: "L1", status: 1, receivedAt: d("2026-10-01"), updatedAt: daysAgo(NOW, 20), ...SECRET }),
    base({ id: "L2", status: 11, assignedUserId: "a@tadakayo.jp", updatedAt: daysAgo(NOW, 20), ...SECRET }),
    base({ id: "L3", status: 1, assignedUserId: "a@tadakayo.jp", receivedAt: d("2026-10-01"), ...SECRET }),
  ];
  const cls = N.classifyCases(cases, { now: NOW, deadline: new Date(NOW.getTime() + 10 * 86400000) });
  const regionOf = () => "【大阪府 豊中市】";
  const all = N.buildOverallDigest(cls, { regionOf });
  const mine = N.buildAssigneeDigest({ displayName: "佐藤", chatUserId: "123456" }, cls.assignees["a@tadakayo.jp"],
    { regionOf, deadlineDays: cls.deadlineDays });
  const kase = { id: "CASEID", caseNumber: 123, officeName: "○○訪問介護事業所", status: 3, ...SECRET };
  const assign = N.assigneeNoticeText({ kase, assignee: { email: "a@tadakayo.jp", displayName: "佐藤", chatUserId: "123456" },
    assignedBy: { email: "t@tadakayo.jp", displayName: "次田" }, regionLabel: "【大阪府 豊中市】" });
  const consent = N.consentSignedText({ kase: { ...kase, status: 5 }, assignee: { displayName: "佐藤", chatUserId: "123456" },
    regionLabel: "【大阪府 豊中市】" });
  for (const text of [all, mine, assign, consent]) {
    assert.deepEqual(leaks(text), [], text);
    assert.ok(!/\d{2,4}-\d{2,4}-\d{3,4}/.test(text), "電話番号の形が入っている: " + text);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), "メールアドレスが入っている: " + text);
  }
  assert.ok(all.includes("・#L1 【大阪府 豊中市】事業所L1（新規受信） 初期連絡"), all);
  assert.ok(mine.includes("💰 入金待ちが14日以上（1件）"));
  assert.ok(mine.includes("📋 申請期限が近い未申請（申請期限まで残り 10 日）"));
});

// ===== N1 担当決定の文面 =====
t("assigneeNoticeText", () => {
  const kase = { caseNumber: 123, officeName: "○○訪問介護事業所", status: 3 };
  const s = N.assigneeNoticeText({ kase, caseId: "abc", regionLabel: "【大阪府 豊中市】",
    assignee: { email: "Sato@tadakayo.jp", displayName: "佐藤", chatUserId: "123456789" },
    assignedBy: { email: "tsukuda@tadakayo.jp", displayName: "次田" } });
  assert.equal(s, [
    "👤 担当営業が決まりました [案件 #123]",
    "<users/123456789> さん、担当をお願いします（設定: 次田）",
    "事業所: 【大阪府 豊中市】○○訪問介護事業所（受注確定）",
    "👉 https://kjk-tadakayo-admin.web.app/case-detail.html?id=abc",
  ].join("\n"));
  // 自分で自分を担当にした → メンションしない（メールの大文字小文字は同一視）
  const self = N.assigneeNoticeText({ kase, caseId: "abc",
    assignee: { email: "Sato@tadakayo.jp", displayName: "佐藤", chatUserId: "123456789" },
    assignedBy: { email: "sato@tadakayo.jp", displayName: "佐藤" } });
  assert.ok(!self.includes("<users/"), self);
  assert.ok(self.includes("佐藤さんが担当になりました（ご自身で設定）"));
  // Chat ID なし → 名前さん。設定者が文字列でもよい
  const noid = N.assigneeNoticeText({ kase, assignee: { email: "x@tadakayo.jp", displayName: "小谷" }, assignedBy: "次田" });
  assert.ok(noid.includes("小谷さん、担当をお願いします（設定: 次田）"), noid);
  assert.ok(!noid.includes("さんさん"));
  // 事業所名の記号はメンション・太字に化けない
  const bad = N.assigneeNoticeText({ kase: { ...kase, officeName: "<users/all> *太字*" }, assignee: { displayName: "佐藤" } });
  assert.ok(!bad.includes("<users/all>") && !bad.includes("*"), bad);
});

// ===== N4 承諾書の署名完了 =====
t("consentSignedText", () => {
  const kase = { caseNumber: 7, officeName: "△△", status: 5, id: "cid" };
  const s = N.consentSignedText({ kase, assignee: { displayName: "佐藤", chatUserId: "99999" }, regionLabel: "【滋賀県 大津市】" });
  assert.equal(s, [
    "✍️ 承諾書にオンラインで署名されました [案件 #7]",
    "<users/99999> さん、内容をご確認ください",
    "事業所: 【滋賀県 大津市】△△（担当者決定）",
    "👉 https://kjk-tadakayo-admin.web.app/case-detail.html?id=cid",
  ].join("\n"));
  const none = N.consentSignedText({ kase, assignee: null });
  assert.ok(none.includes("担当: 未割当"));
});

// ===== holidaysCover =====
t("holidaysCover", () => {
  assert.equal(N.holidaysCover("2026-10-21"), true);
  assert.equal(N.holidaysCover("2027-12-31"), true);
  assert.equal(N.holidaysCover("2028-01-05"), false);
  assert.equal(N.holidaysCover(d("2027-06-01")), true);
  assert.equal(N.holidaysCover(new Date("2027-12-31T15:30:00Z")), false); // JST では 2028-01-01
  assert.equal(N.holidaysCover("でたらめ"), false);
});

console.log(`OK test-notify-text: ${n} 件合格`);
