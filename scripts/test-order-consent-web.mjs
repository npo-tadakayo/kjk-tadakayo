// 承諾書のサイン＝発注 第2段（Web の道・2026-11-12）のテスト。node scripts/test-order-consent-web.mjs
// 設計: 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md §4 段2
//   ①判定: checkWebOrderConsentInput（Web の同意の入力）・buildOrderConsentRecord の userAgent。練習用の写しと同じ結果
//   ②文面: 確認メール（consentUrl なしなら main と一字一句同じ・ありなら承諾書のアドレスの1行と「ご発注を承りました」）・活動の件名・アドレス
//   ③公開ページの部品（js/order-consent-page.js）: 条文はサーバーの正本をそのまま全部出す（ページに条文の写しを置かない）・品名が3か所で同じ
//   ④承諾書を開くページ（admin/js/order-consent-view.js）: Web は「オンラインで同意・同意した日時」、紙は「書面で受領・受け取った日・受け取り方」、焼き込んだ見積もりの表
//   ⑤結線: スイッチがオフの道に承諾書の処理が混ざっていない（acceptQuote・webhookMitsumori・mitsumori.html・consent-sign.js）
// 依存なし（Firestore は使わない。エミュレータでの確認は scripts/test-order-consent-web-emu.mjs）。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const R = require("../functions/accept-rules.js");
const F = require("../functions/accept-flow.js");
const CD = require("../functions/consent-document.js");
const E = await import("../admin/js/order-consent-rules.js");
const S = await import("../admin/js/order-consent.js");
const V = await import("../admin/js/order-consent-view.js");

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };
const plain = (o) => JSON.parse(JSON.stringify(o));

// ===== ① 判定 =====
const WCASES = [
  { consent: { agreed: true, version: "1.2" }, signedName: "山田 花子" },
  { consent: undefined, signedName: "山田" },
  { consent: "yes", signedName: "山田" },
  { consent: { agreed: "true", version: "1.2" }, signedName: "山田" },
  { consent: { agreed: true, version: "1.1" }, signedName: "山田" },
  { consent: { agreed: true }, signedName: "山田" },
  { consent: { agreed: true, version: "1.2" }, signedName: "   " },
  { consent: { agreed: true, version: "1.2" }, signedName: "あ".repeat(101) },
];
t("checkWebOrderConsentInput: 同意・版・名前", () => {
  const r = WCASES.map((p) => R.checkWebOrderConsentInput({ ...p, documentVersion: "1.2" }));
  assert.deepEqual(r.map((x) => x.ok ? "ok" : x.code), ["ok", "consent_required", "consent_required", "consent_required",
    "consent_version_mismatch", "consent_version_mismatch", "no_signed_name", "signed_name_too_long"]);
  assert.match(r[4].message, /現在の版 1\.2/);
});
t("練習用の写しも同じ結果", () => {
  WCASES.forEach((p) => assert.deepStrictEqual(E.checkWebOrderConsentInput({ ...p, documentVersion: "1.2" }), R.checkWebOrderConsentInput({ ...p, documentVersion: "1.2" })));
});
t("buildOrderConsentRecord: Web は userAgent を300文字まで入れる。紙・空なら入れない。職員・事業所のメールアドレスは入れない", () => {
  const q = { id: "q", caseId: "c", caseNumber: 1, estNo: "EST-1", version: 2, items: [], amounts: { totalIncl: 1 }, contactEmail: "office@example.test" };
  const w = R.buildOrderConsentRecord({ document: CD.CONSENT_V1_2, quotes: [q], signed: { name: "x", method: "web_order", userAgent: "U".repeat(400) }, createdBy: "web（見積もりページで同意）" });
  assert.equal(w.signed.userAgent.length, 300);
  const { document: _d, ...rest } = w; // 条文の発行者欄（info@tadakayo.jp）は条文そのものなので除く
  assert.ok(!JSON.stringify(rest).includes("@"), "承諾書の文書にメールアドレスが入っている");
  const w2 = R.buildOrderConsentRecord({ document: CD.CONSENT_V1_2, quotes: [q], signed: { name: "x", method: "web_order" } });
  assert.ok(!("userAgent" in w2.signed));
  const p = R.buildOrderConsentRecord({ document: CD.CONSENT_V1_2, quotes: [q], signed: { name: "x", method: "paper_order", receivedDate: "2026-11-12", userAgent: "U" } });
  assert.ok(!("userAgent" in p.signed));
  assert.deepStrictEqual(plain(E.buildOrderConsentRecord({ document: CD.CONSENT_V1_2, quotes: [q], signed: { name: "x", method: "web_order", userAgent: "UA" } })),
    plain(R.buildOrderConsentRecord({ document: CD.CONSENT_V1_2, quotes: [q], signed: { name: "x", method: "web_order", userAgent: "UA" } })));
});

// ===== ② 文面 =====
t("承諾書のアドレス: 管理画面の /consent?t=（今の署名ページと同じ形）", () => {
  assert.equal(F.orderConsentPageUrl("https://kjk-tadakayo-admin.web.app", "0123456789abcdef0123456789abcdef"),
    "https://kjk-tadakayo-admin.web.app/consent?t=0123456789abcdef0123456789abcdef");
  assert.equal(F.orderConsentPageUrl("https://x/", "abc"), "");
  assert.equal(F.orderConsentPageUrl("https://x/", null), "");
  assert.equal(F.orderConsentPageUrl("https://x/", "a/b?c=dddddddddddddddd"), "");
});
t("活動の件名（Web）", () => {
  assert.equal(F.orderConsentWebSubject("EST-1", "SH-1"), "承諾書にオンラインで同意いただき、受注確定にしました（EST-1・出荷 SH-1 の下書きを作成）");
  assert.equal(F.orderConsentWebSubject("EST-1", "SH-1", true, 4), "承諾書にオンラインで同意いただき、受注確定にしました（EST-1・既存の出荷 SH-1 を更新・再申込で再開（失注から））");
});

// 確認メールの組み立て（index.js の acceptMailText・acceptMailTextGroup をそのまま取り出して動かす）
function mailFns(src, FlowMod) {
  const i = src.indexOf("function acceptMailText(");
  const j = src.indexOf("// 出荷の「使い直し・重複」の Chat 用の注記");
  assert.ok(i > 0 && j > i, "acceptMailText が見つからない");
  const fmt = src.slice(src.indexOf("function fmtNum("), src.indexOf("\n}\n", src.indexOf("function fmtNum(")) + 2);
  const pay = /const PAY_LABELS = \{[^}]*\};/.exec(src)[0];
  // eslint-disable-next-line no-new-func
  return new Function("Flow", `${fmt}\n${pay}\n${src.slice(i, j)}\nreturn { acceptMailText, acceptMailTextGroup };`)(FlowMod);
}
const NEW = mailFns(read("functions/index.js"), F);
let mainSrc = "";
try { mainSrc = execFileSync("git", ["-C", root, "show", "origin/main:functions/index.js"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { /* 無ければ飛ばす */ }
const Q = { estNo: "EST-2026-0001", version: 2, corpName: "テスト法人", officeName: "テスト事業所", amounts: { totalIncl: 79200, grantAmt: 64000, selfPay: 15200 } };
const MAILCASES = [
  { q: Q, agreedName: " 山田 ", payKey: "after", delivery: { postalCode: "100-0001", company: "法人", officeName: "事業所", address: "東京都" }, preferredDate: "11月下旬" },
  { q: { ...Q, corpName: "" }, agreedName: "x", payKey: "before", delivery: null, preferredDate: "" },
];
const GCASES = [{ items: [{ q: Q, soNumber: "SH-1" }, { q: { ...Q, estNo: "EST-2", officeName: "B" }, soNumber: "SH-2" }], agreedName: "y", payKey: "after", preferredDate: "12/1" }];
t("確認メール: consentUrl なしなら main と一字一句同じ（スイッチがオフ）", () => {
  if (!mainSrc) { console.log("  （origin/main が無いので main との比較は飛ばした）"); return; }
  const MAIN = mailFns(mainSrc, F);
  MAILCASES.forEach((c) => assert.deepStrictEqual(NEW.acceptMailText(c), MAIN.acceptMailText(c)));
  GCASES.forEach((c) => assert.deepStrictEqual(NEW.acceptMailTextGroup(c), MAIN.acceptMailTextGroup(c)));
  MAILCASES.forEach((c) => assert.deepStrictEqual(NEW.acceptMailText({ ...c, consentUrl: "" }), MAIN.acceptMailText(c)));
});
t("確認メール: consentUrl ありなら承諾書のアドレスを1行・ご発注を承りました・法人名は NPO法人タダカヨ", () => {
  const url = "https://kjk-tadakayo-admin.web.app/consent?t=0123456789abcdef0123456789abcdef";
  const m = NEW.acceptMailText({ ...MAILCASES[0], consentUrl: url });
  assert.equal(m.subject, "【NPO法人タダカヨ】ご発注を承りました（EST-2026-0001）");
  assert.ok(m.body.includes(`ご同意いただいた承諾書はこちらのアドレスでいつでもご覧いただけます: ${url}`));
  assert.ok(m.body.includes("NPO法人タダカヨ 介護情報基盤伴走支援事業"));
  assert.ok(!m.body.includes("特定非営利活動法人"));
  assert.ok(m.body.includes("あらためて承諾書をご確認いただきます"));
  const g = NEW.acceptMailTextGroup({ ...GCASES[0], consentUrl: url });
  assert.equal(g.subject, "【NPO法人タダカヨ】ご発注を承りました（2事業所分）");
  assert.equal(g.body.split(url).length, 2);
});

// ===== ③ 公開ページの部品 =====
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(read("js/order-consent-page.js"), ctx);
const P = ctx.window.OrderConsentPage;
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
t("公開ページ: 条文（サーバーの正本 v1.2）を全部そのまま出す", () => {
  const html = P.documentHtml(plain(CD.CONSENT_V1_2));
  const d = CD.CONSENT_V1_2;
  for (const s of [d.title, d.preamble, d.consent_statement, d.issuer, d.issuer_detail, d.terms_url, d.privacy_url, ...d.sections.flatMap((x) => [x.title, x.body])]) {
    assert.ok(html.includes(escH(s)), `出ていない: ${s.slice(0, 30)}`);
  }
  assert.ok(html.includes("条文の版 1.2"));
  assert.equal(P.documentHtml({ version: "1.2" }), null);
  assert.equal(P.documentHtml(null), null);
});
t("公開ページ: 条文の写しを置いていない（mitsumori.html・js/order-consent-page.js に条文の本文が無い）", () => {
  const page = read("mitsumori.html") + read("js/order-consent-page.js");
  for (const s of CD.CONSENT_V1_2.sections) assert.ok(!page.includes(s.body.slice(0, 40)), `写しがある: ${s.title}`);
  assert.ok(!page.includes(CD.CONSENT_V1_2.consent_statement.slice(0, 30)));
});
t("品名: 公開ページ・管理画面・Functions で同じ", () => {
  assert.deepStrictEqual(plain(P.PRODUCT_NAMES), plain(S.PRODUCT_NAMES));
  const fn = /const PRODUCT_NAMES = (\{[^}]*\});/.exec(read("functions/index.js"))[1];
  assert.deepStrictEqual(plain(P.PRODUCT_NAMES), new Function(`return ${fn}`)());
  const items = [{ sku: "cir415a-01", subsidyQty: 2, extraQty: 1 }, { sku: "cir315a-04", subsidyQty: 1, extraQty: 0 }, { sku: "cir315a-02", subsidyQty: 0, extraQty: 0 }];
  assert.equal(P.itemsLines(items).join("、"), S.itemsText(items));
});
const ENTRY = R.orderConsentQuoteEntry({ id: "q1", caseId: "c1", caseNumber: 5, estNo: "EST-9", version: 3, officeName: "事業所<A>", corpName: "法人",
  items: [{ sku: "cir415a-01", subsidyQty: 2, extraQty: 1 }], amounts: { readers: 1, accompanyFee: 33000, discount: 1000, totalIncl: 79200, grantAmt: 64000, selfPay: 15200 } });
t("公開ページ: 発注の内容（見積番号・版・事業所・品目・台数・金額）。欠けていれば出さない", () => {
  const h = P.quotesHtml([plain(ENTRY)]);
  for (const s of ["EST-9", "第3版", "事業所&lt;A&gt;", "CIR415A：3台（補助対象 2台＋追加 1台）", "¥79,200", "自己負担 ¥15,200", "金額調整 −¥1,000"]) assert.ok(h.includes(s), s);
  assert.ok(!h.includes("事業所<A>"));
  const g = P.quotesHtml([plain(ENTRY), plain({ ...ENTRY, estNo: "EST-10" })]);
  assert.ok(g.includes("合計（2事業所）") && g.includes("¥158,400"));
  assert.equal(P.quotesHtml([plain(ENTRY), null]), null);
  assert.equal(P.quotesHtml([]), null);
});
t("公開ページ: 送る同意の印・承諾書のアドレスの確認・受け付けた表示", () => {
  assert.deepEqual(plain(P.consentPayload(CD.CONSENT_V1_2)), { agreed: true, version: "1.2" });
  const url = "https://kjk-tadakayo-admin.web.app/consent?t=0123456789abcdef0123456789abcdef";
  assert.equal(P.safeConsentUrl(url), url);
  assert.equal(P.safeConsentUrl("javascript:alert(1)"), "");
  assert.equal(P.safeConsentUrl("http://x/consent?t=0123456789abcdef0123456789abcdef"), "");
  const d = P.doneHtml({ label: "お見積書 EST-1", consentUrl: url, email: "a@b.test" });
  assert.ok(d.includes(`href="${url}"`) && d.includes("ご発注（承諾書への同意）を受け付けました") && d.includes("a@b.test"));
  assert.ok(!P.doneHtml({ consentUrl: "javascript:x" }).includes("href"));
});

// ===== ④ 承諾書を開くページ =====
const REC_WEB = { kind: "order", status: "signed", displayNo: "CST-5", officeName: "事業所A", quotes: [plain(ENTRY)],
  signed: { name: "同意 一郎", method: "web_order", signedAt: new Date("2026-11-12T05:05:00Z"), userAgent: "UA" }, document: CD.CONSENT_V1_2 };
const REC_PAPER = { ...REC_WEB, signed: { name: "紙 花子", method: "paper_order", receivedDate: "2026-11-10", receivedVia: "fax", signedAt: new Date("2026-11-12T01:00:00Z") } };
t("承諾書を開くページ: Web は「オンラインで同意・同意した日時（JST）」", () => {
  const info = V.orderSignInfo(REC_WEB);
  assert.equal(info.paper, false);
  assert.deepEqual(info.rows.map((r) => `${r.label}=${r.value}`), ["署名者=同意 一郎", "同意した日時=2026年11月12日 14:05", "方法=オンラインで同意（見積もりページ）"]);
});
t("承諾書を開くページ: 紙は「書面で受領・受け取った日・受け取り方」（オンラインと出さない・記録した時刻を署名日にしない）", () => {
  const info = V.orderSignInfo(REC_PAPER);
  assert.equal(info.paper, true);
  const txt = info.rows.map((r) => `${r.label}=${r.value}`);
  assert.deepEqual(txt.slice(0, 3), ["署名者=紙 花子", "受け取った日=2026年11月10日", "方法=書面でご署名（FAXで受け取り）"]);
  assert.ok(!txt.join().includes("オンライン"));
  const html = V.orderConsentPageHtml(REC_PAPER, CD.CONSENT_V1_2, "<!--doc-->");
  assert.ok(!html.includes("オンライン") && html.includes("書面で署名・条文の版 1.2"));
});
t("承諾書を開くページ: 焼き込んだ見積もりの表（見積番号・版・事業所・品目・台数・金額）・読むだけ（署名のボタンなし）", () => {
  const html = V.orderConsentPageHtml(REC_WEB, CD.CONSENT_V1_2, "<!--doc-->");
  for (const s of ["EST-9", "第3版", "事業所&lt;A&gt;", "CIR415A：3台（補助対象 2台＋追加 1台）", "¥79,200", "本書に表示する見積書（発注の内容）", "<!--doc-->", "印刷 / PDF保存"]) assert.ok(html.includes(s), s);
  assert.ok(!/signBtn|agreeCheck|signerName/.test(html));
  const g = V.orderQuotesTableHtml({ quotes: [plain(ENTRY), plain({ ...ENTRY, estNo: "EST-10" })] });
  assert.ok(g.includes("合計（2事業所）") && g.includes("¥158,400"));
  assert.match(V.orderQuotesTableHtml({ quotes: [] }), /記録がありません/);
  assert.ok(V.orderConsentPageHtml({ ...REC_WEB, retakeOf: "x" }, CD.CONSENT_V1_2, "").includes("あらためていただいたもの"));
});

// ===== ⑤ 結線 =====
t("acceptQuote: スイッチの確認は最初に1回・オンのときだけ acceptQuoteByConsent。従来の道は consent を読まない", () => {
  const src = read("functions/index.js");
  const a = src.slice(src.indexOf("exports.acceptQuote = onRequest("), src.indexOf("// ===== 電話・メール等で受けたお申し込みを、スタッフが「受注確定」にする"));
  assert.match(a, /if \(await readOrderByConsentFresh\(\)\) \{ await acceptQuoteByConsent\(req, res, body\); return; \}/);
  const mk = "acceptQuoteByConsent(req, res, body); return; }"; const after = a.slice(a.indexOf(mk) + mk.length);
  assert.ok(!/consent/i.test(after.replace(/acceptQuoteByConsent/g, "")), "従来の道に consent が混ざっている");
  const b = src.slice(src.indexOf("async function acceptQuoteByConsent("), src.indexOf("exports.acceptQuote = onRequest("));
  assert.match(b, /checkWebOrderConsentInput\(/);
  assert.match(b, /method: "web_order"/);
  assert.match(b, /actor: \{ kind: "web" \}/);
});
t("webhookMitsumori: スイッチがオフなら応答に承諾書の項目を足さない（空のオブジェクトを広げるだけ）", () => {
  const src = read("functions/index.js");
  assert.match(src, /const consentTop = consentOn \? \{ orderByConsent: true, consentDocument: ORDER_CONSENT_DOCUMENT \} : \{\};/);
  assert.match(src, /const consentOf = \(r\) => \(consentOn \? \{ consentEntry: r\.consentEntry \} : \{\}\);/);
});
t("承諾書の文書に職員・内部のメールアドレスを入れない（Web の道）", () => {
  const src = read("functions/index.js");
  const tx = src.slice(src.indexOf("async function acceptOrderByConsentTransaction("), src.indexOf("async function reconsentTransaction("));
  assert.match(tx, /createdBy: web \? "web（見積もりページで同意）"/);
});
t("mitsumori.html: 同意の印は承諾書の画面を出したときだけ送る・部品を読み込む", () => {
  const h = read("mitsumori.html");
  assert.match(h, /if \(consentDoc\) body\.consent = OrderConsentPage\.consentPayload\(consentDoc\);/);
  assert.match(h, /<script src="js\/order-consent-page\.js\?v=\d+"><\/script>/);
  assert.match(h, /if \(!on && !orderModeOn\) return;/); // オフのままなら文言に触らない
  // オフのときの元の文言はそのまま残っている
  for (const s of ["この内容でお申し込みになりますか？", "お申し込みの確認", "この内容で申し込む", "お申し込み者のお名前", "個人情報保護方針と利用規約への同意にチェックをお願いします"]) assert.ok(h.includes(s), s);
});
t("consent-sign.js: kind order は読むだけの画面。v1.1 の署名ページの道は残っている", () => {
  const js = read("admin/js/consent-sign.js");
  assert.match(js, /if \(isOrderConsentRecord\(data\)\) \{.*renderOrder\(data, docu\); return; \}/);
  const ro = js.slice(js.indexOf("function renderOrder("), js.indexOf("(async () => {"));
  assert.ok(!/updateDoc/.test(ro));
  assert.match(js, /if \(data\.status === "signed"\) renderSigned\(data, docu, false\);\n  else renderPending\(data, docu\);/);
});

console.log(`OK test-order-consent-web: ${n} 件合格`);
