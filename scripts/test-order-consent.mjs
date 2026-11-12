// 見積もり必須・承諾書のサイン＝発注（2026-11-12・第1段）のテスト。node scripts/test-order-consent.mjs
// 設計: 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md
//   ①条文: サーバーの正本（functions/consent-document.js）と画面の写し（admin/js/consent-document.js）が一字一句同じ。
//          v1.1 は凍結庫にそのまま（今まで現行だった文面と同じ）。伴走支援だけの承諾書は v1.1 のまま
//   ②判定の純粋関数（functions/accept-rules.js）の単体テスト
//   ③練習モード用の写し（admin/js/order-consent-rules.js）が正本と同じ結果・同じ本文
//   ④画面の判定（admin/js/order-consent.js・constants.js の nextActionFor・record-gaps.js）。スイッチが切れていれば今までどおり
//   ⑤結線（index.js・画面）。スイッチがオフの道に承諾書の処理が混ざっていないか
// 依存なし（Firestore は使わない。エミュレータでの確認は scripts/test-order-consent-emu.mjs）。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const R = require("../functions/accept-rules.js");
const F = require("../functions/accept-flow.js");
const CD = require("../functions/consent-document.js");
const AD = await import("../admin/js/consent-document.js");
const E = await import("../admin/js/order-consent-rules.js");
const S = await import("../admin/js/order-consent.js");
const C = await import("../admin/js/constants.js");
const G = await import("../admin/js/record-gaps.js");

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };
const plain = (o) => JSON.parse(JSON.stringify(o));

// ===== ① 条文 =====
t("条文 v1.2: サーバーの正本と画面の写しが一字一句同じ", () => {
  assert.deepStrictEqual(plain(AD.CONSENT_DOCUMENT), plain(CD.CONSENT_V1_2));
  assert.equal(CD.ORDER_CONSENT_DOCUMENT, CD.CONSENT_V1_2);
  assert.equal(AD.CONSENT_DOCUMENT.version, "1.2");
});
t("条文 v1.1: サーバーの写しと画面の凍結庫が一字一句同じ・伴走支援だけの承諾書は v1.1", () => {
  const v11 = AD.CONSENT_ARCHIVE.find((d) => d.version === "1.1");
  assert.deepStrictEqual(plain(v11), plain(CD.CONSENT_V1_1));
  assert.equal(AD.SUPPORT_CONSENT_DOCUMENT, v11);
  assert.equal(CD.SUPPORT_CONSENT_DOCUMENT, CD.CONSENT_V1_1);
  assert.deepEqual(AD.CONSENT_ARCHIVE.map((d) => d.version), ["1.1", "1.0"]);
});
t("条文 v1.1 は今まで（main）の現行の文面と同じ（凍結）", () => {
  // git が使えない環境では飛ばさずに失敗させない（ソースから main の文面を読む）
  let old = null;
  try { old = execFileSync("git", ["-C", root, "show", "origin/main:admin/js/consent-document.js"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (_) { old = null; }
  if (old == null || !old.includes('version: "1.1"') || old.includes('version: "1.2"')) return; // main がすでに 1.2 のときは比べない
  const cur = read("admin/js/consent-document.js");
  const block = (src, startRe) => { const i = src.search(startRe); const j = src.indexOf("\n};\n", i); return src.slice(i, j); };
  const oldBody = block(old, /export const CONSENT_DOCUMENT = \{/).replace(/^export const CONSENT_DOCUMENT = /, "");
  const curBody = block(cur, /export const CONSENT_ARCHIVE = \[\n  \{\n    version: "1\.1"/);
  const norm = (x) => x.replace(/\s+/g, "");
  assert.ok(norm(curBody).includes(norm(oldBody).slice(1, -1)), "凍結した v1.1 が main の現行の文面と違う");
});
t("条文 v1.2: 変えたのは題名・§6・同意文と、§7 の書面の扱いの1文だけ", () => {
  const a = CD.CONSENT_V1_1, b = CD.CONSENT_V1_2;
  assert.notEqual(a.title, b.title);
  assert.match(b.title, /発注書を兼ねます/);
  assert.notEqual(a.consent_statement, b.consent_statement);
  assert.match(b.consent_statement, /見積書の内容で発注し/);
  assert.equal(a.sections.length, b.sections.length);
  a.sections.forEach((s, i) => {
    if (s.key === "purchase") { assert.notDeepEqual(s, b.sections[i]); assert.match(b.sections[i].title, /発注/); }
    else if (s.key === "record") {
      // §7: 紙の発注では署名済みの紙を当法人が受け取るため、書面の扱いの1文だけを替えた（ほかは v1.1 と同じ）
      const OLD = "書面でご署名いただいた場合、原本は事業所へお渡しし、伴走支援担当者は持ち帰りません。";
      const NEW = "書面でご署名いただいた場合は、署名済みの書面またはその写しを当法人が受け取り、本書の記録として保管します。控えは事業所にて保管してください。";
      assert.ok(s.body.includes(OLD) && !b.sections[i].body.includes(OLD));
      assert.equal(b.sections[i].body, s.body.replace(OLD, NEW));
      assert.equal(b.sections[i].title, s.title);
    } else assert.deepStrictEqual(s, b.sections[i]);
  });
  for (const k of ["preamble", "terms_url", "privacy_url", "issuer", "issuer_detail"]) assert.equal(a[k], b[k]);
  assert.ok(!new RegExp("特定非営利活動法人" + "タダカヨ").test(JSON.stringify(b)), "法人名は NPO法人タダカヨ");
});

// ===== ② 判定の純粋関数 =====
const ts = (iso) => ({ toMillis: () => Date.parse(iso), toDate: () => new Date(iso) });
const Q = (o = {}) => ({ id: "q1", caseId: "c1", estNo: "EST-1", version: 2, status: "issued", validUntil: ts("2026-11-30T15:00:00+09:00"), ...o });
const base = {
  entries: [{ quote: Q(), siblings: [{ id: "q0", version: 1, status: "superseded" }, Q()] }],
  method: "paper_order", signedName: "山田 花子", receivedDate: "2026-11-12", todayYmd: "2026-11-12", nowMs: Date.parse("2026-11-12T10:00:00+09:00"),
};
const code = (impl, patch) => { const r = impl.checkOrderConsent({ ...base, ...patch }); return r.ok ? "ok" : r.code; };
const CASES = [
  {},
  { entries: [] },
  { method: "web" },
  { signedName: "  " },
  { signedName: "あ".repeat(101) },
  { receivedDate: "2026-02-30" },
  { receivedDate: "2026-11-13" },
  { todayYmd: "" },
  { entries: [{ quote: null, siblings: [] }] },
  { entries: [{ quote: Q({ status: "accepted" }), siblings: [] }] },
  { entries: [{ quote: Q({ status: "superseded" }), siblings: [] }] },
  { entries: [{ quote: Q(), siblings: [{ id: "q9", version: 3 }] }] },
  { receivedDate: "2026-11-30", todayYmd: "2026-11-30" },  // 期限の日（JST）当日は有効
  { receivedDate: "2026-12-01", todayYmd: "2026-12-01" },   // 期限切れ
  { entries: [{ quote: Q({ validUntil: null }), siblings: [] }] },
  { method: "web_order", nowMs: Date.parse("2026-11-30T15:00:01+09:00") }, // Web は時刻で比べる
  { method: "web_order", receivedDate: "" },
  { entries: [{ quote: Q(), siblings: [] }, { quote: Q(), siblings: [] }] },                                       // 同じ見積もり
  { entries: [{ quote: Q({ groupId: "G" }), siblings: [] }, { quote: Q({ id: "q2", groupId: "G" }), siblings: [] }] }, // 同じ案件
  { entries: [{ quote: Q(), siblings: [] }, { quote: Q({ id: "q2", caseId: "c2" }), siblings: [] }] },               // グループでない
  { entries: [{ quote: Q({ groupId: "G" }), siblings: [] }, { quote: Q({ id: "q2", caseId: "c2", groupId: "H" }), siblings: [] }] },
  { entries: [{ quote: Q({ groupId: "G" }), siblings: [] }, { quote: Q({ id: "q2", caseId: "c2", groupId: "G" }), siblings: [] }] },
  { entries: [{ quote: Q({ groupId: "G" }), siblings: [] }, { quote: Q({ id: "q2", caseId: "c2", groupId: "G", status: "accepted" }), siblings: [] }] },
];
const EXPECT = ["ok", "no_quotes", "invalid_method", "no_signed_name", "signed_name_too_long", "invalid_consent_date",
  "future_consent_date", "invalid_today", "quote_not_found", "already_accepted", "not_issued", "old_version", "ok", "expired", "ok",
  "expired", "ok", "duplicate_quote", "duplicate_case", "not_group", "group_mismatch", "ok", "already_accepted"];
t("checkOrderConsent: 見積もりの状態・版・期限・署名者名・紙の受取日・まとめの整合", () => {
  assert.equal(CASES.length, EXPECT.length);
  CASES.forEach((p, i) => assert.equal(code(R, p), EXPECT[i], `case ${i}: ${JSON.stringify(p).slice(0, 120)}`));
  assert.match(R.checkOrderConsent({ ...base, ...CASES[13] }).message, /有効期限（2026-11-30）/);
});
t("orderConsentQuoteEntry: 焼き込む項目（品目・金額）だけを、数に直して持つ", () => {
  const e = R.orderConsentQuoteEntry({ id: "q1", estNo: "EST-1", version: "2", caseId: "c1", caseNumber: 7, officeName: "A", corpName: "法人",
    plan: "houmon", items: [{ sku: "cir415a-01", subsidyQty: "2", extraQty: 1, unitPrice: 999 }, { sku: "cir315a-04", subsidyQty: 1, connector: "C" }],
    amounts: { totalIncl: "79200", selfPay: 100, accompanyFee: 33000, extra: 5 }, accessToken: "秘密" });
  assert.deepEqual(e, {
    quoteId: "q1", estNo: "EST-1", version: 2, caseId: "c1", caseNumber: 7, officeName: "A", corpName: "法人", plan: "houmon",
    items: [{ sku: "cir415a-01", subsidyQty: 2, extraQty: 1 }, { sku: "cir315a-04", subsidyQty: 1, extraQty: 0, connector: "C" }],
    amounts: { readers: 0, accompanyFee: 33000, discount: 0, totalIncl: 79200, grantAmt: 0, selfPay: 100 },
  });
  assert.ok(!JSON.stringify(e).includes("秘密"), "見積もりの accessToken を承諾書に入れない");
});
const DOC = CD.ORDER_CONSENT_DOCUMENT;
const rec = (o = {}) => R.buildOrderConsentRecord({
  document: DOC, quotes: [{ id: "q1", caseId: "c1", caseNumber: 12, estNo: "EST-1", version: 2, officeName: "A事業所", corpName: "法人", contactName: "担当", items: [], amounts: { totalIncl: 1000 } }],
  groupId: null, signed: { name: " 山田 ", method: "paper_order", receivedDate: "2026-11-12", receivedVia: "fax", recordedBy: "s@tadakayo.jp" }, createdBy: "s@tadakayo.jp", ...o,
});
t("buildOrderConsentRecord: kind order・署名済み・条文全文・焼き込み・表示番号", () => {
  const r = rec();
  assert.equal(r.kind, "order"); assert.equal(r.status, "signed");
  assert.equal(r.document, DOC);
  assert.equal(r.caseId, "c1"); assert.deepEqual(r.caseIds, ["c1"]);
  assert.equal(r.displayNo, "CST-12");
  assert.equal(r.totalIncl, 1000);
  assert.deepEqual(r.signed, { name: "山田", method: "paper_order", receivedDate: "2026-11-12", receivedVia: "fax" });
  // 気づき-5: 承諾書の文書（トークンを知っていれば誰でも読める）に職員のメールアドレスを入れない
  assert.ok(!/@/.test(JSON.stringify({ ...r, document: null })), "承諾書に @ を含む値がある");
  assert.ok(!("createdBy" in r) && !("recordedBy" in r.signed));
  assert.equal(r.quoteGroupId, null);
  assert.ok(!("retakeOf" in r));
  assert.equal(rec({ retakeOf: "abc" }).retakeOf, "abc");
  assert.equal(rec({ signed: { name: "x", method: "paper_order", receivedDate: "2026-11-12", receivedVia: "どこか" } }).signed.receivedVia, "other");
  const w = rec({ signed: { name: "x", method: "web_order" } });
  assert.deepEqual(w.signed, { name: "x", method: "web_order" }); // Web には受取日・記録者を入れない
  const g = rec({ quotes: [{ id: "a", caseId: "c1", caseNumber: 1, officeName: "A", amounts: { totalIncl: 10 } }, { id: "b", caseId: "c2", caseNumber: 2, officeName: "B", amounts: { totalIncl: 20 } }], groupId: "G" });
  assert.equal(g.displayNo, "CST-1-G2"); assert.equal(g.officeName, "Aほか1事業所"); assert.equal(g.totalIncl, 30); assert.deepEqual(g.caseIds, ["c1", "c2"]); assert.equal(g.quoteGroupId, "G");
});
t("orderConsentStaleAfterRevise: 品目・台数・合計が変われば取り直し", () => {
  const e = { items: [{ sku: "a", subsidyQty: 2, extraQty: 0 }, { sku: "b", subsidyQty: 1, extraQty: 0 }], amounts: { totalIncl: 100 } };
  assert.equal(R.orderConsentStaleAfterRevise(e, { items: [{ sku: "b", subsidyQty: 1 }, { sku: "a", subsidyQty: 2, connector: "A" }], amounts: { totalIncl: 100 } }), false); // 並びと口の形の項目だけの違いは同じ
  assert.equal(R.orderConsentStaleAfterRevise(e, { items: [{ sku: "a", subsidyQty: 3 }, { sku: "b", subsidyQty: 1 }], amounts: { totalIncl: 100 } }), true);
  assert.equal(R.orderConsentStaleAfterRevise(e, { items: e.items, amounts: { totalIncl: 101 } }), true);
  assert.equal(R.orderConsentStaleAfterRevise(e, { items: [{ sku: "c", subsidyQty: 2 }, { sku: "b", subsidyQty: 1 }], amounts: { totalIncl: 100 } }), true);
  assert.equal(R.orderConsentStaleAfterRevise(null, { items: [], amounts: {} }), true);
});
const RC = { quote: Q({ status: "accepted" }), siblings: [], kase: { orderConsentToken: "t", orderConsentStale: true }, signedName: "山田", receivedDate: "2026-11-12", todayYmd: "2026-11-12" };
const RCASES = [{}, { quote: null }, { quote: Q() }, { siblings: [{ id: "x", version: 9 }] }, { kase: null }, { kase: {} }, { signedName: "" },
  { receivedDate: "x" }, { receivedDate: "2026-11-13" },
  { kase: { orderConsentToken: "t" } }, { kase: { orderConsentToken: "t", orderConsentStale: false } }]; // 低-3: 取り直し済みの二度押し
const REXP = ["ok", "quote_not_found", "not_accepted", "old_version", "case_not_found", "no_order_consent", "no_signed_name", "invalid_consent_date", "future_consent_date",
  "already_retaken", "already_retaken"];
t("checkOrderReconsent: 受注済み・最新版・発注の承諾がある案件だけ", () => {
  RCASES.forEach((p, i) => { const r = R.checkOrderReconsent({ ...RC, ...p }); assert.equal(r.ok ? "ok" : r.code, REXP[i], `case ${i}`); });
});
t("orderByConsentOn・channelOfReceivedVia", () => {
  assert.equal(R.orderByConsentOn({ orderByConsent: true }), true);
  for (const v of [undefined, null, {}, { orderByConsent: "true" }, { orderByConsent: 1 }, { orderByConsent: false }]) assert.equal(R.orderByConsentOn(v), false);
  assert.equal(R.channelOfReceivedVia("fax"), "fax"); assert.equal(R.channelOfReceivedVia("email"), "email");
  assert.equal(R.channelOfReceivedVia("post"), "other"); assert.equal(R.channelOfReceivedVia("hand"), "other");
  for (const k of ["post", "fax", "hand", "email", "other"]) assert.ok(R.ORDER_RECEIVED_VIA[k]);
});
t("onConsentSigned: 発注の承諾書（kind order）は通知の対象外（受注の処理が通知するため）", () => {
  const p = { status: "pending", caseId: "c" }, s = { status: "signed", caseId: "c", signed: { method: "web" } };
  assert.equal(F.shouldNotifyConsent(p, s), true);                       // 従来の承諾書は今までどおり
  assert.equal(F.shouldNotifyConsent({ ...p, kind: "order" }, { ...s, kind: "order" }), false);
  assert.equal(F.shouldNotifyConsent(p, { ...s, kind: "order" }), false);
});
t("活動の件名・Chat の見出し", () => {
  assert.equal(F.orderConsentAcceptSubject("fax", "EST-1", "SH-1"), "署名済みの承諾書（FAX）を受け取り、受注確定にしました（EST-1・出荷 SH-1）");
  assert.equal(F.orderConsentAcceptSubject("x", "EST-1", "SH-1", 4), "署名済みの承諾書（その他）を受け取り、受注確定にしました（EST-1・出荷 SH-1・再申込で再開（失注から））");
  assert.match(F.orderConsentChatHead("次田<b>"), /操作: 次田b/);
  assert.equal(F.orderReconsentSubject("EST-1", 3), "承諾書を取り直しました（EST-1 第3版）");
});

// ===== ③ 練習モード用の写しが正本と同じ =====
t("写し（admin/js/order-consent-rules.js）の本文が正本（functions/accept-rules.js）の該当部分と同じ", () => {
  const cjs = read("functions/accept-rules.js"), esm = read("admin/js/order-consent-rules.js");
  const sec = (src) => { const i = src.indexOf("// 紙の承諾書の受け取り方"); const j = src.search(/\n(module\.exports = \{|export \{)/); return src.slice(i, j).trim(); };
  assert.ok(sec(cjs).length > 1000);
  assert.equal(sec(esm), sec(cjs));
  const helpers = (src) => src.slice(src.indexOf("const YMD = "), src.indexOf("const ng = (code, message)"));
  assert.equal(helpers(esm), helpers(cjs));
});
t("写しが正本と同じ結果（同じ入力で全部）", () => {
  CASES.forEach((p) => assert.deepStrictEqual(E.checkOrderConsent({ ...base, ...p }), R.checkOrderConsent({ ...base, ...p })));
  RCASES.forEach((p) => assert.deepStrictEqual(E.checkOrderReconsent({ ...RC, ...p }), R.checkOrderReconsent({ ...RC, ...p })));
  const args = { document: DOC, quotes: [{ id: "a", caseId: "c", items: [{ sku: "x", subsidyQty: 1 }], amounts: { totalIncl: 5 } }], groupId: "G", signed: { name: "n", method: "paper_order", receivedDate: "2026-11-12", receivedVia: "post", recordedBy: "r" }, createdBy: "r", retakeOf: "t" };
  assert.deepStrictEqual(plain(E.buildOrderConsentRecord(args)), plain(R.buildOrderConsentRecord(args)));
  assert.equal(E.orderConsentStaleAfterRevise({ items: [], amounts: { totalIncl: 1 } }, { items: [], amounts: { totalIncl: 2 } }), true);
  assert.deepStrictEqual(E.ORDER_RECEIVED_VIA, R.ORDER_RECEIVED_VIA);
});

// ===== ④ 画面の判定 =====
t("状態の選択の制限: スイッチがオフなら何も変えない", () => {
  for (let f = 1; f <= 13; f++) for (let to = 1; to <= 13; to++) {
    assert.deepEqual(S.statusChangeGuard({ from: f, to, orderByConsent: false, isAdmin: false }), { kind: "ok" });
  }
  assert.deepEqual(S.blockedStatusOptions({ from: 1, orderByConsent: false, isAdmin: false }), []);
});
t("状態の選択の制限: 受注前（1・2）→ 3〜12 は止める。4・13・すでに3以上は今までどおり。管理者は理由", () => {
  for (const f of [1, 2, "1", undefined]) {
    for (const to of [3, 5, 6, 7, 8, 9, 10, 11, 12, "3"]) {
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false }).kind, "blocked", `${f}→${to}`);
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: true }).kind, "reason");
    }
    for (const to of [1, 2, 4, 13]) assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false }).kind, "ok");
  }
  for (const f of [3, 5, 8, 12]) for (let to = 1; to <= 13; to++) assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false }).kind, "ok");
  assert.deepEqual(S.blockedStatusOptions({ from: 2, orderByConsent: true, isAdmin: false }), [3, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(S.blockedStatusOptions({ from: 2, orderByConsent: true, isAdmin: true }), []);
  assert.deepEqual(S.blockedStatusOptions({ from: 3, orderByConsent: true, isAdmin: false }), []);
  // 中-1: 失注(4)・完了(13)をはさんでも、承諾書も受注日も無ければ 3〜12 へ進めない
  for (const f of [4, 13]) {
    for (const to of [3, 5, 8, 12]) {
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false, caseData: {} }).kind, "blocked", `${f}→${to} 受注前`);
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false }).kind, "blocked", `${f}→${to} 案件なし`);
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: true, caseData: {} }).kind, "reason");
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false, caseData: { orderConsentToken: "t" } }).kind, "ok", "発注の承諾がある");
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false, caseData: { orderedAt: { seconds: 1 } } }).kind, "ok", "前から受注していた進行中の案件");
      assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: false, isAdmin: false, caseData: {} }).kind, "ok", "スイッチがオフ");
    }
    for (const to of [1, 2, 4, 13]) assert.equal(S.statusChangeGuard({ from: f, to, orderByConsent: true, isAdmin: false, caseData: {} }).kind, "ok");
    assert.deepEqual(S.blockedStatusOptions({ from: f, orderByConsent: true, isAdmin: false, caseData: {} }), [3, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(S.blockedStatusOptions({ from: f, orderByConsent: true, isAdmin: false, caseData: { orderedAt: 1 } }), []);
    assert.deepEqual(S.blockedStatusOptions({ from: f, orderByConsent: true, isAdmin: true, caseData: {} }), []);
  }
  // 1・2 は承諾書・受注日の有無にかかわらず受注前（従来どおり）
  assert.equal(S.statusChangeGuard({ from: 2, to: 3, orderByConsent: true, isAdmin: false, caseData: { orderedAt: 1 } }).kind, "blocked");
  assert.equal(S.manualStatusNote(" 紙の承諾書を後日回収 "), "手動で状態を変更（理由: 紙の承諾書を後日回収）");
});
t("次の一手: スイッチがオフなら NEXT_ACTION のまま（全状態）", () => {
  for (let st = 1; st <= 13; st++) {
    assert.equal(C.nextActionFor(st, { orderConsentToken: "x" }, { orderByConsent: false }), C.NEXT_ACTION[st] || null);
    assert.equal(C.nextActionFor(st, {}), C.NEXT_ACTION[st] || null);
  }
});
t("次の一手: スイッチがオン → 状態2は承諾待ち・状態5は発注の承諾がある案件だけ署名依頼を出さない", () => {
  assert.match(C.nextActionFor(2, {}, { orderByConsent: true }).text, /見積もりの承諾（発注）を待ち/);
  assert.ok(!/署名依頼/.test(C.nextActionFor(5, { orderConsentToken: "t" }, { orderByConsent: true }).text));
  assert.equal(C.nextActionFor(5, {}, { orderByConsent: true }), C.NEXT_ACTION[5]);     // 移行: 発注の承諾が無い案件は従来どおり
  assert.match(C.NEXT_ACTION[5].text, /承諾書の署名依頼/);
  for (const st of [1, 3, 6, 7, 8, 9, 10, 11, 12, 13, 4]) assert.equal(C.nextActionFor(st, { orderConsentToken: "t" }, { orderByConsent: true }), C.NEXT_ACTION[st] || null);
});
t("点検: 取り直しが要る案件だけ出す", () => {
  assert.equal(G.orderConsentNoticeOf({}), null);
  assert.equal(G.orderConsentNoticeOf({ orderConsentStale: false }), null);
  assert.equal(G.orderConsentNoticeOf({ orderConsentStale: true, archived: true }), null);
  assert.match(G.orderConsentNoticeOf({ orderConsentStale: true }).text, /承諾書の取り直しが要ります/);
});
t("紙の承諾書の入力 → staffAcceptQuote に渡す値", () => {
  const f = { quoteId: "q1", signedName: " 鈴木 ", receivedDate: "2026-11-12", receivedVia: "fax", payMethod: "before", note: " メモ ", sendMail: true, groupQuoteIds: ["q2", "q1", "q2", ""] };
  const r = S.buildPaperConsentPayload(f, "2026-11-12");
  assert.deepEqual(r.payload, {
    quoteId: "q1", acceptedName: "鈴木", channel: "fax", receivedDate: "2026-11-12", payMethod: "before", preferredDate: "", note: "メモ",
    sendMail: true, groupQuoteIds: ["q2"], consent: { signedName: "鈴木", receivedDate: "2026-11-12", receivedVia: "fax" },
  });
  assert.equal(S.buildPaperConsentPayload({ ...f, receivedVia: "post" }, "2026-11-12").payload.channel, "other");
  assert.equal(S.buildPaperConsentPayload({ ...f, receivedVia: "?" }, "2026-11-12").payload.consent.receivedVia, "other");
  assert.match(S.buildPaperConsentPayload({ ...f, signedName: "" }, "2026-11-12").error, /お名前/);
  assert.match(S.buildPaperConsentPayload({ ...f, receivedDate: "2026-11-13" }, "2026-11-12").error, /未来/);
  assert.match(S.buildPaperConsentPayload({ ...f, receivedDate: "11/12" }, "2026-11-12").error, /正しく/);
  assert.match(S.buildPaperConsentPayload({ ...f, preferredDate: "x" }, "2026-11-12").error, /希望日/);
  assert.deepEqual(S.buildPaperConsentPayload({ ...f, reconsent: true }, "2026-11-12").payload,
    { quoteId: "q1", reconsent: true, consent: { signedName: "鈴木", receivedDate: "2026-11-12", receivedVia: "fax" } });
});
t("発注の承諾書の1行（署名者・日付・方法・見積番号と版）", () => {
  assert.equal(S.orderConsentLine(null), null);
  assert.equal(S.orderConsentLine({ status: "signed" }), null); // 従来の承諾書は対象外
  const l = S.orderConsentLine({ kind: "order", displayNo: "CST-12", document: { version: "1.2" }, quotes: [{ estNo: "EST-1", version: 2 }],
    signed: { name: "山田", method: "paper_order", receivedDate: "2026-11-10", receivedVia: "post" } });
  assert.equal(l.text, "署名者 山田／受け取った日 2026-11-10／紙・郵送／EST-1 第2版／条文の版 1.2");
  const w = S.orderConsentLine({ kind: "order", quotes: [], signed: { name: "x", method: "web_order", signedAt: new Date("2026-11-11T16:00:00Z") } });
  assert.equal(w.date, "2026-11-12"); assert.equal(w.method, "オンライン");
});
t("承諾書の印刷: 見積番号・版・品目・台数・金額。まとめは全事業所を1枚に。HTML を壊す文字を逃がす", () => {
  const html = S.buildOrderConsentPrintHtml({ document: DOC, printedYmd: "2026-11-12", quotes: [
    { estNo: "EST-2026-0001", version: 3, officeName: "A<事業所>", corpName: "法人&", items: [{ sku: "cir415a-01", subsidyQty: 2, extraQty: 1 }], amounts: { totalIncl: 79200, selfPay: 15200 } },
    { estNo: "EST-2026-0002", version: 1, officeName: "B", items: [{ sku: "cir315a-04", subsidyQty: 1 }], amounts: { totalIncl: 50000, selfPay: 5000 } },
  ] });
  for (const s of ["EST-2026-0001", "第3版", "EST-2026-0002", "第1版", "¥79,200", "¥50,000", "¥129,200", "合計（2事業所）", "CIR415A：3台（補助対象 2台＋追加 1台）",
    "CIR315A（Type-C）：1台（補助対象 1台）", "A&lt;事業所&gt;", "法人&amp; 御中", DOC.title, DOC.consent_statement, DOC.sections[5].body, "条文の版 1.2", "印刷日 2026-11-12"]) {
    assert.ok(html.includes(s), `印刷に無い: ${s}`);
  }
  assert.ok(!html.includes("<事業所>"));
  assert.ok(html.includes("署名済みの書面またはその写しを当法人が受け取り"), "印刷に §7 の新しい文が出る");
  assert.ok(!html.includes("原本は事業所へお渡しし"), "印刷に §7 の古い文が出ない");
  assert.ok(!/<script/i.test(html), "印刷の HTML にスクリプトを入れない");
  assert.ok(!html.includes("練習モード"));
  assert.ok(S.buildOrderConsentPrintHtml({ document: DOC, quotes: [], practice: true }).includes("練習モードで作った承諾書"));
  const one = S.buildOrderConsentPrintHtml({ document: DOC, quotes: [{ estNo: "E", version: 1, officeName: "A", corpName: "法人", items: [], amounts: {} }] });
  assert.ok(!one.includes("合計（"));
});

// ===== ⑤ 結線 =====
const idx = read("functions/index.js");
const fnBody = (name) => { const i = idx.indexOf(`exports.${name} = `); const j = idx.indexOf("\nexports.", i + 10); return idx.slice(i, j); };
t("staffAcceptQuote: スイッチを毎回読み直し、オンのときだけ承諾書の道。オフの道は従来の acceptQuoteTransaction", () => {
  const b = fnBody("staffAcceptQuote");
  assert.match(b, /const orderOn = await readOrderByConsentFresh\(\);/);
  assert.match(b, /if \(orderOn\) \{/);
  assert.match(b, /consent_required/);
  assert.match(b, /if \(orderConsent\) \{[\s\S]*acceptOrderByConsentTransaction\(/);
  assert.match(b, /\} else \{\n\s+for \(const pq of pre\) \{[\s\S]*acceptQuoteTransaction\(\{/);
  assert.match(idx, /async function readOrderByConsentFresh\(\) \{\n[\s\S]{0,200}collection\("appConfig"\)\.doc\("settings"\)\.get\(\)/); // 60秒キャッシュを使わない
});
t("acceptQuote（Web）: 承諾書の処理はスイッチがオンのときの入口1行だけ（第2段で追加。中身は acceptQuoteByConsent・test-order-consent-web.mjs）", () => {
  const b = fnBody("acceptQuote").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // 注記の行は見ない
  const gate = "if (await readOrderByConsentFresh()) { await acceptQuoteByConsent(req, res, body); return; }";
  assert.equal(b.split(gate).length, 2, "入口の1行が無い");
  // 入口の次の「オフなのに consent が付いていたら 409」（第2段・レビュー 中-1）も除いて見る
  const offBlock = /if \(body\.consent != null\) \{\n\s+res\.status\(409\)\.json\(\{ status: "error", code: "order_by_consent_off"[^\n]*\n\s+return;\n\s+\}\n/;
  assert.match(b, offBlock);
  assert.ok(!/acceptOrderByConsentTransaction|orderByConsent|consent/i.test(b.replace(gate, "").replace(offBlock, "").replace(/agreedPolicy/g, "")), "従来の Web の道に承諾書の処理が入っている");
});
t("承諾書の記録と受注確定は同じトランザクション（tx.create）", () => {
  const i = idx.indexOf("async function acceptOrderByConsentTransaction"), j = idx.indexOf("\n}\n", i);
  const b = idx.slice(i, j);
  assert.match(b, /db\.runTransaction\(async \(tx\) => \{/);
  assert.match(b, /tx\.get\(db\.collection\("appConfig"\)\.doc\("settings"\)\)/);   // 設定もトランザクションの中で確かめる
  assert.match(b, /checkOrderConsent\(/);
  assert.match(b, /acceptTxWrite\(tx, st,/);
  assert.match(b, /tx\.create\(db\.collection\("consentRequests"\)\.doc\(token\), rec\)/);
  assert.equal((b.match(/db\.runTransaction/g) || []).length, 1);
});
t("reviseQuote: 発注の承諾書がある案件だけ orderConsentStale を書く", () => {
  const b = fnBody("reviseQuote");
  assert.match(b, /if \(kaseR && kaseR\.orderConsentToken\) \{/);
  assert.match(b, /\.\.\.\(consentStale == null \? \{\} : \{ orderConsentStale: consentStale \}\)/);
});
t("reviseConsentStale: 出荷キャンセルの印は内容が同じ改版でも下ろさない・それ以外は理由を消す（小さな指摘4）。写しも同じ", () => {
  const cases = [
    [{ orderConsentStale: true, orderConsentStaleReason: "ship_canceled" }, false, { stale: true, clearReason: false }],
    [{ orderConsentStale: true, orderConsentStaleReason: "ship_canceled" }, true, { stale: true, clearReason: false }],
    [{ orderConsentStale: false, orderConsentStaleReason: "ship_canceled" }, false, { stale: false, clearReason: true }], // 取り直し済みの名残り
    [{ orderConsentStale: false, orderConsentStaleReason: "ship_canceled" }, true, { stale: true, clearReason: true }],  // ← 以前は文言が誤った
    [{ orderConsentStale: true }, false, { stale: false, clearReason: true }],
    [{}, true, { stale: true, clearReason: true }],
    [null, false, { stale: false, clearReason: true }],
  ];
  for (const [k, c, want] of cases) {
    assert.deepEqual(R.reviseConsentStale(k, c), want, JSON.stringify([k, c]));
    assert.deepEqual(E.reviseConsentStale(k, c), want, "練習用の写しも同じ");
  }
  // 改版で立てた印の文言は「見積もりを直した」側になる（出荷キャンセルの文言にならない）
  const k = { orderConsentStale: false, orderConsentStaleReason: "ship_canceled" };
  const r = R.reviseConsentStale(k, true);
  const after = { ...k, orderConsentStale: r.stale };
  if (r.clearReason) delete after.orderConsentStaleReason;
  assert.equal(G.orderConsentNoticeOf(after).text, G.ORDER_CONSENT_STALE_TEXT);
});
t("印を下ろす・改版で書くときは理由（orderConsentStaleReason）も消す（Functions・練習モード）", () => {
  const ix = read("functions/index.js");
  assert.match(ix, /orderConsentToken: consent\.token, orderConsentAt: now, orderConsentStale: false,\n    orderConsentStaleReason: admin\.firestore\.FieldValue\.delete\(\) \}\);/);
  assert.match(ix, /tx\.update\(caseRef, \{ orderConsentToken: token, orderConsentAt: now, orderConsentStale: false,\n      orderConsentStaleReason: admin\.firestore\.FieldValue\.delete\(\), updatedAt: now \}\);/);
  const b = fnBody("reviseQuote");
  assert.match(b, /const rs = reviseConsentStale\(kaseR, orderConsentStaleAfterRevise\(entry, \{ items, amounts \}\)\);/);
  assert.match(b, /\.\.\.\(consentClearReason \? \{ orderConsentStaleReason: admin\.firestore\.FieldValue\.delete\(\) \} : \{\}\),/);
  const ps = read("admin/js/practice-stubs.js");
  assert.match(ps, /orderConsentToken: consent\.token, orderConsentAt: now, orderConsentStale: false, orderConsentStaleReason: deleteField\(\) \}/);
  assert.match(ps, /orderConsentToken: token, orderConsentAt: now, orderConsentStale: false, orderConsentStaleReason: deleteField\(\), updatedAt: now \}/);
  assert.match(ps, /const rs = reviseConsentStale\(kaseR, orderConsentStaleAfterRevise\(entry, \{ items, amounts \}\)\);/);
  assert.match(ps, /\.\.\.\(consentClearReason \? \{ orderConsentStaleReason: deleteField\(\) \} : \{\}\),/);
});
t("練習モードの代役: 練習DBの設定で同じ道（承諾書の記録と受注確定を1つの処理で）", () => {
  const ps = read("admin/js/practice-stubs.js");
  assert.match(ps, /async function practiceOrderOn\(\) \{\n\s+try \{ const s = await getDoc\(doc\(db\(\), "appConfig", "settings"\)\)/);
  assert.match(ps, /if \(orderConsent\) \{[\s\S]*const r = await runTransaction\(db\(\), async \(tx\) => \{[\s\S]*checkOrderConsent\([\s\S]*tx\.set\(consentRef, rec\);/);
  assert.match(ps, /orderConsentStaleAfterRevise\(entry, \{ items, amounts \}\)/);
  assert.match(ps, /from "\/js\/order-consent-rules\.js"/);
  const qa = read("admin/js/quote-admin.js");
  assert.match(qa, /if \(!isPracticeMode\(\)\) return;\n\s+const ref = doc\(ctx\.db, "appConfig", "settings"\);\n\s+if \(!isPracticeRef\(ref\)\)/); // 練習DBのときだけ書く
});
t("画面: スイッチが切れていれば従来のボタン・選択肢のまま", () => {
  const qa = read("admin/js/quote-admin.js");
  assert.match(qa, /function acceptBtn\(q, isLatest\) \{\n\s+if \(orderOn\(\)\) return consentBtns\(q, isLatest\);/);
  assert.match(qa, /受注確定にする（電話・メールで申込を受けた）/);    // 従来のボタンは残す（オフのとき）
  const cd = read("admin/js/case-detail.js");
  assert.match(cd, /const orderOn = \(\) => orderByConsentOn\(appSettings\);/);
  assert.match(cd, /const guard = statusChangeGuard\(\{ from: currentCase\.status, to: e\.target\.value, orderByConsent: orderOn\(\), isAdmin, caseData: currentCase \}\);/);
  const kb = read("admin/js/kanban.js");
  assert.match(kb, /const guard = statusChangeGuard\(\{ from: prev, to: newStatus, orderByConsent: orderOn\(\), isAdmin: isAdminUser, caseData: c \}\);/);
  assert.match(kb, /blockedStatusOptions\(\{ from: c\.status, orderByConsent: orderOn\(\), isAdmin: isAdminUser, caseData: c \}\)/);
  assert.match(cd, /blockedStatusOptions\(\{ from: c\?\.status, orderByConsent: orderOn\(\), isAdmin, caseData: c \}\)/);
  const ca = read("admin/js/consent-admin.js");
  assert.match(ca, /import \{ SUPPORT_CONSENT_DOCUMENT as CONSENT_DOCUMENT \} from "\/js\/consent-document\.js";/); // 伴走支援だけの承諾書は v1.1 のまま
});
t("練習DBへ写す設定に orderByConsent を入れない（本番のスイッチを練習へ持ち込まない）", () => {
  const seed = read("functions/practice-seed.js");
  const allow = seed.slice(seed.indexOf("const SETTINGS_ALLOW = ["), seed.indexOf("];", seed.indexOf("const SETTINGS_ALLOW = [")));
  assert.ok(!/orderByConsent/.test(allow));
});

console.log(`OK test-order-consent: ${n} 件合格`);
