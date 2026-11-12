// 承諾書のサイン＝発注: スイッチ（appConfig/settings.orderByConsent）を本番で入れる前の点検（2026-11-12）のテスト。
// node scripts/test-order-consent-switch-ready.mjs（依存なし・Firestore は使わない）
//   ①PR #69 レビュー 中-1（失注・完了をはさんで承諾書なしで 3〜12 へ）が止まっていること（通しの筋書き）
//   ②PR #69 レビュー 中-2（承諾書を開くページで紙をオンライン扱い・見積もりの中身なし）が直っていること
//   ③紙の道の「受注確認のご連絡」（承諾書 v1.2 §6）: メールを送らない・送れないときに Chat と画面で手での連絡を促す
//   ④確認メールの文言: 紙は「ご署名」、Web は「ご同意」、スイッチがオフの文言は一字も変えない
//   ⑤見積もりページの完了の表示: 受注確認のメールを送れなかったときに「お送りしました」と出さない
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const F = require("../functions/accept-flow.js");
const CD = require("../functions/consent-document.js");
const S = await import("../admin/js/order-consent.js");
const V = await import("../admin/js/order-consent-view.js");

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };

// ===== ① 中-1 =====
t("中-1: 新規→失注→（承諾書なしで）伴走支援準備 は止まる。承諾書が入れば進める", () => {
  const on = { orderByConsent: true, isAdmin: false };
  let kase = { status: 2 };
  assert.equal(S.statusChangeGuard({ ...on, from: 2, to: 4, caseData: kase }).kind, "ok", "失注にはできる");
  kase = { status: 4 };
  for (const to of S.ORDER_GATED_TO) assert.equal(S.statusChangeGuard({ ...on, from: 4, to, caseData: kase }).kind, "blocked", `4→${to}`);
  assert.equal(S.statusChangeGuard({ ...on, from: 2, to: 13, caseData: { status: 2 } }).kind, "ok", "完了にはできる");
  for (const to of S.ORDER_GATED_TO) assert.equal(S.statusChangeGuard({ ...on, from: 13, to, caseData: { status: 13 } }).kind, "blocked", `13→${to}`);
  // 承諾書で受注確定（サーバーが orderConsentToken・orderedAt を書く）のあとは、失注から戻しても進める
  kase = { status: 4, orderConsentToken: "t".repeat(32), orderedAt: { seconds: 1 } };
  for (const to of S.ORDER_GATED_TO) assert.equal(S.statusChangeGuard({ ...on, from: 4, to, caseData: kase }).kind, "ok", `承諾あり 4→${to}`);
  // 管理者は理由を書けば例外にできる（止まらずに理由を聞く）
  assert.equal(S.statusChangeGuard({ orderByConsent: true, isAdmin: true, from: 13, to: 5, caseData: { status: 13 } }).kind, "reason");
  // 選択肢: 非管理者は 4・13 でも 3〜12 を選べない
  assert.deepEqual(S.blockedStatusOptions({ orderByConsent: true, isAdmin: false, from: 13, caseData: {} }), S.ORDER_GATED_TO);
});
t("中-1: 状態を変える画面（案件詳細・カンバン・「伴走支援実施済にしますか」）がすべて案件を渡して判定している", () => {
  const cd = read("admin/js/case-detail.js"), kb = read("admin/js/kanban.js");
  const calls = [...cd.matchAll(/statusChangeGuard\(\{[^}]*\}\)/g), ...kb.matchAll(/statusChangeGuard\(\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 3, calls.join("\n"));
  for (const c of calls) assert.match(c, /caseData: (currentCase|c)\b/, c);
  // 案件の状態を書くのは、この2画面の変更処理と、新規作成（1）・コピー（2）だけ（ほかに 3〜12 を書く道が増えていない）
  const writers = [];
  for (const f of ["case-detail.js", "kanban.js", "cases.js", "case-copy.js", "schedule.js", "supply.js", "warehouse.js", "onsite-record.js", "support-checklist.js", "offices.js", "dashboard.js"]) {
    let src = ""; try { src = read(`admin/js/${f}`); } catch { continue; }
    if (/statusChangePatch\(/.test(src) || /status: Number\(newStatus\)|status: newStatus/.test(src)) writers.push(f);
  }
  assert.deepEqual(writers.sort(), ["case-detail.js", "cases.js", "kanban.js"]);
  assert.match(read("admin/js/case-copy.js"), /export const COPY_INITIAL_STATUS = 2;/);
});

// ===== ② 中-2 =====
const ENTRY = { quoteId: "q1", estNo: "EST-2026-0300", version: 2, caseId: "c1", caseNumber: 470, officeName: "事業所A", corpName: "法人A",
  items: [{ sku: "cir415a-01", subsidyQty: 2, extraQty: 1 }], amounts: { readers: 1, accompanyFee: 2, discount: 0, totalIncl: 79200, grantAmt: 64000, selfPay: 15200 } };
t("中-2: 紙で受けた承諾書は「書面でご署名・受け取った日・受け取り方」で出し、オンラインとは出さない", () => {
  const rec = { kind: "order", status: "signed", displayNo: "CST-470", quotes: [ENTRY], document: CD.CONSENT_V1_2,
    signed: { name: "紙 花子", method: "paper_order", receivedDate: "2026-11-10", receivedVia: "post", signedAt: new Date("2026-11-12T01:00:00Z") } };
  const html = V.orderConsentPageHtml(rec, CD.CONSENT_V1_2, "");
  assert.ok(!html.includes("オンライン"), "オンラインと出さない");
  for (const s of ["書面でご署名（郵送で受け取り）", "2026年11月10日", "EST-2026-0300", "第2版", "法人A 事業所A", "CIR415A：3台（補助対象 2台＋追加 1台）", "¥79,200", "自己負担 ¥15,200"]) {
    assert.ok(html.includes(s), s);
  }
});
t("中-2: consent-sign.js は kind order を先に見て、v1.1 の「オンライン署名」の画面（renderSigned）に落とさない", () => {
  const js = read("admin/js/consent-sign.js");
  const iOrder = js.indexOf("if (isOrderConsentRecord(data))"), iSigned = js.indexOf('if (data.status === "signed") renderSigned');
  assert.ok(iOrder > 0 && iSigned > iOrder);
});

// ===== ③ 紙の道の受注確認のご連絡 =====
t("受注確認のメールが出ていない理由（紙の道・スイッチがオンのときだけ）", () => {
  const k = F.orderConsentMailProblemKind;
  assert.equal(k({ orderConsent: false, sendMail: false, to: "", mailed: false }), "", "スイッチがオフ（従来の受注）は何も出さない");
  assert.equal(k({ orderConsent: true, sendMail: true, to: "a@b.test", mailed: true }), "");
  assert.equal(k({ orderConsent: true, sendMail: false, to: "a@b.test", mailed: false }), "not_sent");
  assert.equal(k({ orderConsent: true, sendMail: true, to: "", mailed: false }), "no_address");
  assert.equal(k({ orderConsent: true, sendMail: true, to: "a@b.test", mailed: false }), "failed");
  assert.equal(k(), "");
});
t("Chat の文: 紙の道は「署名済みの承諾書による発注は受注確定」・送らない指定も知らせる・個人名を書かない", () => {
  const a = F.orderConsentMailProblemText("not_sent", [{ caseNumber: 470, estNo: "EST-1" }], { paper: true });
  assert.equal(a, "⚠️ 「確認メールを送る」を外して受注確定にしたため、受注確認のメールを送っていません（案件 #470（EST-1））。署名済みの承諾書による発注は受注確定にしています。手で事業所へ受注確認の連絡をしてください（承諾書 第6条）。");
  assert.match(F.orderConsentMailProblemText("failed", [{ caseNumber: 1, estNo: "E" }]), /承諾書への同意による発注は受け付けています/); // Web は従来の言い方
});
t("staffAcceptQuote: 承諾書の道でメールが出ていなければ Chat に手での連絡を足す（スイッチがオフの道は変わらない）", () => {
  const src = read("functions/index.js");
  const b = src.slice(src.indexOf("exports.staffAcceptQuote = onCall("), src.indexOf("exports.reviseQuote = onCall("));
  assert.match(b, /const orderConsentMailProblem = Flow\.orderConsentMailProblemKind\(\{ orderConsent: !!orderConsent, sendMail: !!sendMail, to, mailed \}\);/);
  assert.match(b, /\(orderConsentMailProblem \? `\\n\$\{Flow\.orderConsentMailProblemText\(orderConsentMailProblem, done\.map\(\(r\) => \(\{ caseNumber: r\.q\.caseNumber, estNo: r\.q\.estNo \}\)\), \{ paper: true \}\)\}` : ""\)/);
  // 判定はメールの処理のあと・Chat の前
  assert.ok(b.indexOf("const orderConsentMailProblem") > b.indexOf("staffAcceptQuote mail error"));
  assert.ok(b.indexOf("const orderConsentMailProblem") < b.indexOf("await notifyChat(await getWebhook(\"crm\")"));
  // 紙の道の確認メールは「ご署名」の文言
  assert.match(b, /const consentPaper = !!orderConsent;/);
  assert.match(b, /acceptMailText\(\{ q: first, agreedName: name, payKey, delivery: await deliveryFromOfficeForQuote\(first\), preferredDate, consentUrl, consentPaper \}\)/);
  assert.match(b, /acceptMailTextGroup\(\{ items: done, agreedName: name, payKey, preferredDate, consentUrl, consentPaper \}\)/);
});
t("画面: 紙の承諾書の受け取りのチェックは「受注確認のメール」・送らない／送れないときは手での連絡を出す", () => {
  assert.equal(S.orderConfirmFollowupText({ ok: true, consentNo: "CST-1", mail: "sent" }), "");
  assert.equal(S.orderConfirmFollowupText({ ok: true, mail: "off" }), "", "従来の受注（承諾書なし）は出さない");
  assert.equal(S.orderConfirmFollowupText({ ok: false, consentNo: "CST-1", mail: "off" }), "");
  assert.match(S.orderConfirmFollowupText({ ok: true, consentNo: "CST-1", mail: "off" }), /第6条/);
  assert.match(S.orderConfirmFollowupText({ ok: true, consentNo: "CST-1", mail: "failed" }), /電話などで受注を確認/);
  const qa = read("admin/js/quote-admin.js");
  assert.match(qa, /> \$\{esc\(PAPER_MAIL_LABEL\)\}\n/);
  assert.match(qa, /\$\{esc\(PAPER_MAIL_NOTE\)\}/);
  assert.match(qa, /orderConfirmFollowupText\(sum\)/);
  // 従来の「受注確定にする（電話・メールで申込を受けた）」の文言はそのまま残っている
  assert.ok((qa.match(/お申し込みの確認メールを事業所へ送る/g) || []).length >= 1);
  assert.match(S.PAPER_MAIL_LABEL, /受注確認のメール/);
});
t("練習の代役: 承諾書で受けたときのメールの件名を本番と同じ「ご発注を承りました」に", () => {
  const ps = read("admin/js/practice-stubs.js");
  assert.match(ps, /const head = orderConsent \? "ご発注を承りました" : "お申し込みを受け付けました";/);
  assert.equal(F.acceptMailWording("https://x/consent?t=0123456789abcdef").subjectHead, "ご発注を承りました");
});

// ===== ④ 確認メールの文言 =====
t("確認メールの文言: オフは従来どおり・Web は「ご同意」・紙は「ご署名」", () => {
  const off = F.acceptMailWording("");
  assert.deepEqual(off, {
    subjectHead: "お申し込みを受け付けました",
    lead: "お申し込みをいただき、ありがとうございます。以下の内容で承りました。",
    consentLine: "",
    changeNote: "台数や機種（Bluetooth／USB、USBの口の形）は、日程の調整をする際に変更できます。",
  });
  assert.deepEqual(F.acceptMailWording("", { paper: true }), off, "承諾書が無ければ紙でも従来どおり");
  const url = "https://kjk-tadakayo-admin.web.app/consent?t=0123456789abcdef0123456789abcdef";
  const web = F.acceptMailWording(url);
  assert.match(web.lead, /へのご同意によるご発注/);
  assert.equal(web.consentLine, `ご同意いただいた承諾書はこちらのアドレスでいつでもご覧いただけます: ${url}`);
  const paper = F.acceptMailWording(url, { paper: true });
  assert.match(paper.lead, /へのご署名によるご発注/);
  assert.ok(!paper.lead.includes("ご同意") && !paper.consentLine.includes("ご同意"));
  assert.ok(paper.consentLine.endsWith(url));
  assert.equal(paper.subjectHead, web.subjectHead);
  assert.equal(paper.changeNote, web.changeNote);
});

// ===== ⑤ 見積もりページの完了の表示 =====
const ctx = vm.createContext({ console });
vm.runInContext(read("js/order-consent-page.js"), ctx);
const P = ctx.OrderConsentPage;
t("見積もりページ: 受注確認のメールを送れなかった（mailed:false）ときは「お送りしました」と出さない", () => {
  const url = "https://kjk-tadakayo-admin.web.app/consent?t=0123456789abcdef0123456789abcdef";
  const ok = P.doneHtml({ consentUrl: url, email: "a@b.test", mailed: true });
  assert.ok(ok.includes("a@b.test 宛にお送りしました"));
  const legacy = P.doneHtml({ consentUrl: url, email: "a@b.test" });
  assert.ok(legacy.includes("宛にお送りしました"), "未指定（二重送信の already など）は従来どおり");
  const ng = P.doneHtml({ consentUrl: url, email: "a@b.test", mailed: false });
  assert.ok(!ng.includes("お送りしました") && ng.includes("担当スタッフから、あらためて受注確認のご連絡"));
  assert.ok(ng.includes(`href="${url}"`));
});
t("見積もりページ（2026-11-12 画面確認）: 二重送信（already）は「すでに受け付けています」・メールを送ったと書かない", () => {
  const url = "https://kjk-tadakayo-admin.web.app/consent?t=0123456789abcdef0123456789abcdef";
  const a = P.doneHtml({ consentUrl: url, email: "a@b.test", already: true });
  assert.ok(a.includes("すでに受け付けています") && !a.includes("受け付けました"));
  assert.ok(!a.includes("お送り") && !a.includes("a@b.test"), "メールを送ったとは書かない");
  assert.ok(a.includes(`href="${url}"`), "承諾書のアドレスは出す");
  const h = read("mitsumori.html");
  assert.match(h, /mailed: data\.mailed, already: data\.status === 'already',/);
});
t("見積もりページ（2026-11-12 画面確認）: 文言（上の承諾書・左のフォームを使わない）", () => {
  assert.ok(P.TEXT.nameNote.includes("上の承諾書") && !P.TEXT.nameNote.includes("下の承諾書"));
  const q = P.quotesHtml([{ estNo: "E-1", version: 1, amounts: { totalIncl: 1 }, items: [] }]);
  assert.ok(q && !q.includes("左の") && q.includes("お見積もりの入力欄で選び直して"));
  const h = read("mitsumori.html");
  assert.ok(!h.includes("左のフォームで"), "申込の画面に「左のフォームで」が残っていない");
});
t("見積もりページ（2026-11-12 画面確認）: エラーの文はボタンの帯の中・読み上げに伝わる", () => {
  const h = read("mitsumori.html");
  const m = h.match(/<div class="modal-actions order-actions">\s*<p id="orderError" role="alert"[^>]*><\/p>\s*<button[^>]*id="orderCancel"/);
  assert.ok(m, "#orderError が .modal-actions（下に貼り付く帯）の中で、ボタンの前にある");
  assert.equal((h.match(/id="orderError"/g) || []).length, 1);
  assert.match(h, /#orderModal \.order-actions \{ flex-wrap: wrap; \}/);
  assert.match(h, /#orderModal\.consent-mode \.modal-btn \{ min-height: 44px; \}/);
});
t("acceptQuote（スイッチがオンの道）: 応答に mailed を足し、ページがそれを渡す。オフの道の応答は変えない", () => {
  const src = read("functions/index.js");
  const b = src.slice(src.indexOf("async function acceptQuoteByConsent("), src.indexOf("exports.acceptQuote = onRequest("));
  assert.match(b, /\{ status: "ok", results: resultsOut, consentUrl, mailed: !mailProblem \}/);
  assert.match(b, /\{ status: "ok", soNumber: outs\[0\]\.soNumber, caseNumber: first\.caseNumber, consentUrl, mailed: !mailProblem \}/);
  const off = src.slice(src.indexOf("exports.acceptQuote = onRequest("), src.indexOf("// ===== 電話・メール等で受けたお申し込みを、スタッフが"));
  assert.ok(off.length > 1000 && !/mailed/.test(off), "オフの道（従来の申込）の応答に mailed を足していない");
  const h = read("mitsumori.html");
  assert.match(h, /consentUrl: data\.consentUrl, email: val\('contactEmail'\), mailed: data\.mailed,/);
  assert.match(h, /<script src="js\/order-consent-page\.js\?v=20261115"><\/script>/);
});

// ===== ⑥ まとめ発注の完了の表示・断られたときの文（2026-11-12 画面確認 低×3）=====
t("見積もりページ: 受け付けた事業所の一覧は「・事業所名（案件#…）」・出荷番号を出さない", () => {
  const names = { Q1: "あおぞら<事業所>", Q2: "ひだまり苑" };
  const res = [{ quoteId: "Q1", caseNumber: 9101, shipmentNo: "SO-1" }, { quoteId: "Q2", caseNumber: 9102, shipmentNo: "SO-2" },
    { quoteId: "Q3", error: "x" }, { quoteId: "Q4", caseNumber: 9104, shipmentNo: "SO-4" }];
  const h = P.doneListHtml(res, (id) => names[id]);
  assert.equal(h, "・あおぞら&lt;事業所&gt;（案件#9101）<br>・ひだまり苑（案件#9102）<br>・案件#9104");
  assert.ok(!h.includes("SO-") && !h.includes("出荷"));
  assert.equal(P.doneListHtml(undefined, null), "");
  assert.equal(P.doneListHtml([{ quoteId: "Q1" }], (id) => names[id]), "・あおぞら&lt;事業所&gt;");
  const m = read("mitsumori.html");
  assert.ok(!m.includes("'（出荷 '"), "完了の表示に出荷番号を出す行が残っていない");
  assert.equal(m.split("OrderConsentPage.doneListHtml(").length - 1, 2, "オン・オフの両方のまとめ申込の完了で使う");
  // オフの道の他の文言は変えていない
  assert.ok(m.includes("お申し込みを受け付けました。</b>（事業所 ${okCount}件"));
  assert.ok(m.includes("受け付けられなかった事業所: ${failedResults.map((r) => esc(officeNameOfQuote(r.quoteId))).join('、')}"));
});
t("見積もりページ: 断られたときの文（職員向けの言い回しを事業所向けに置き換える）", () => {
  const nameOf = (k) => ({ "TKY-2": "ひだまり苑" })[k] || "";
  const staffy = /いただいてください|受注確定|承諾書は1件ずつ|受け取ってください|案件/;
  const a = P.errorText({ code: "already_accepted", message: "この見積もりはすでに受注確定（お申し込み済み）です（TKY-2）", multi: true, nameOfEstNo: nameOf });
  assert.equal(a, "すでにお申し込み済みの事業所「ひだまり苑」が含まれているため、まとめての発注を受け付けられませんでした。お手数ですが、その事業所を外してお見積もりを作り直すか、お電話またはメールでご連絡ください。");
  const a0 = P.errorText({ code: "already_accepted", message: "この見積もりはすでに受注確定（お申し込み済み）です（TKY-9）", multi: true, nameOfEstNo: nameOf });
  assert.ok(a0.startsWith("すでにお申し込み済みの事業所が含まれているため"), "名前が引けなければ「」ごと省く");
  const a1 = P.errorText({ code: "already_accepted", message: "この見積もりはすでに受注確定（お申し込み済み）です（TKY-2）", multi: false, nameOfEstNo: nameOf });
  assert.ok(!a1.includes("まとめて") && !a1.includes("外して") && a1.includes("すでにお申し込み済み"), "1事業所では「まとめて」「外して」と書かない");
  const v = P.errorText({ code: "old_version", message: "新しい版の見積もりがあります。最新の版の承諾書をいただいてください（TKY-2）", multi: true, nameOfEstNo: nameOf });
  assert.ok(v.includes("「ひだまり苑」") && v.includes("まとめての発注"));
  const v1 = P.errorText({ code: "old_version", message: "新しい版の見積もりがあります。最新の版の承諾書をいただいてください（TKY-2）", multi: false, nameOfEstNo: nameOf });
  assert.ok(!v1.includes("まとめて"));
  const all = [a, a0, a1, v, v1, ...["not_issued", "not_group", "group_mismatch", "duplicate_case", "duplicate_quote", "order_by_consent_off"]
    .flatMap((c) => [true, false].map((multi) => P.errorText({ code: c, message: "x（TKY-2）", multi, nameOfEstNo: nameOf })))];
  all.forEach((s) => { assert.ok(s, "空でない"); assert.ok(!staffy.test(s), s); assert.ok(!/@|\d{2,4}-\d{2,4}-\d{3,4}/.test(s), "新しい連絡先を書かない: " + s); });
  // 事業所向けの文のまま出すもの（置き換えない）・code が無いもの（スイッチがオフの道）は "" ＝サーバーの文をそのまま
  for (const c of ["consent_version_mismatch", "consent_required", "no_signed_name", "expired", "failed-precondition", "invalid_quotes", "", undefined]) {
    assert.equal(P.errorText({ code: c, message: "そのままの文（TKY-2）", multi: true, nameOfEstNo: nameOf }), "", String(c));
  }
  const m = read("mitsumori.html");
  assert.match(m, /const friendly = \(data\.code && window\.OrderConsentPage\)\n\s+\? OrderConsentPage\.errorText\(\{ code: data\.code, message: data\.message, multi: offices\.length > 1, nameOfEstNo: officeNameBy \}\) : '';\n\s+show\(friendly \|\| data\.message \|\| 'お申し込みの送信に失敗しました。/);
});
t("サーバーの断りの code（置き換える側の印）が、functions にいまもある", () => {
  const r = read("functions/accept-rules.js"), ix = read("functions/index.js");
  for (const c of ["already_accepted", "old_version", "not_issued", "not_group", "group_mismatch", "duplicate_case", "duplicate_quote"]) assert.ok(r.includes(`ng("${c}"`) || ix.includes(`"${c}"`), c);
  assert.match(r, /ng\("old_version", `新しい版の見積もりがあります。最新の版の承諾書をいただいてください（\$\{label\}）`\)/);
  assert.match(r, /ng\("already_accepted", `この見積もりはすでに受注確定（お申し込み済み）です（\$\{label\}）`\)/);
  assert.match(ix, /res\.status\(code\)\.json\(\{ status: "error", code: \(e\.details && e\.details\.code\) \|\| e\.code, message: e\.message \}\);/);
});

console.log(`OK test-order-consent-switch-ready: ${n} 件合格`);
