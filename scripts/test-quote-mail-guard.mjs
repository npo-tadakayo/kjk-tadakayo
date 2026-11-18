// 公開の見積もりの入口の踏み台メール対策（2026-11-18 セキュリティ点検 A2）と、見積もり画面の XSS 対策（同 A3）を、
// Firebase に繋がずに確かめる。node scripts/test-quote-mail-guard.mjs
//   1. functions/quote-mail-guard.js の純粋関数（PDF の検査・1行化・宛先）
//   2. 結線: sendQuotePdf が検査を通し、宛先を案件の contactEmail に固定し、見積もりの contactEmail を宛先に使っていない
//   3. A3: mitsumori.html の連絡先の欄（renderOfficeDoc）を、悪意ある値で実際に組み立てて、タグが文字として出ること
// エミュレータで実際に関数を動かす確認は scripts/test-quote-mail-emu.mjs。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../functions/quote-mail-guard.js");
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; } };
const b64 = (s) => Buffer.from(s, "latin1").toString("base64");
const PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";

// ---------- 1. 純粋関数 ----------
t("checkQuotePdf: 本物の PDF は通り、きれいな base64 を返す", () => {
  const r = G.checkQuotePdf(b64(PDF));
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.base64, "base64").toString("latin1"), PDF);
});
t("checkQuotePdf: data URI の頭・改行入りの base64 も、中身が PDF なら通す（画面の作り方が変わっても壊れない）", () => {
  const raw = b64(PDF);
  assert.equal(G.checkQuotePdf("data:application/pdf;base64," + raw).ok, true);
  assert.equal(G.checkQuotePdf(raw.replace(/(.{10})/g, "$1\r\n")).ok, true);
});
t("checkQuotePdf: PDF でないもの（文章・HTML・実行ファイル・空）は拒否", () => {
  for (const s of ["hello world", "<html><script>alert(1)</script></html>", "MZ\x90\x00\x03", " %PDF-1.4"]) {
    const r = G.checkQuotePdf(b64(s));
    assert.equal(r.ok, false, s);
  }
  assert.equal(G.checkQuotePdf("").ok, false);
  assert.equal(G.checkQuotePdf(null).ok, false);
  assert.equal(G.checkQuotePdf(12345).ok, false);
});
t("checkQuotePdf: base64 以外の文字が混じっていれば拒否（MIME の区切りを足させない）", () => {
  assert.equal(G.checkQuotePdf(b64(PDF) + "\r\n--tadakayo_po_mixed_boundary\r\n").ok, false);
  assert.equal(G.checkQuotePdf(b64(PDF) + "\"").ok, false);
});
t("checkQuotePdf: 上限（5MB）を超えると拒否・ちょうどは通る", () => {
  assert.equal(G.QUOTE_PDF_MAX_BYTES, 5 * 1024 * 1024);
  const head = Buffer.from("%PDF-1.4\n", "latin1");
  const atMax = Buffer.concat([head, Buffer.alloc(G.QUOTE_PDF_MAX_BYTES - head.length, 0x20)]);
  assert.equal(G.checkQuotePdf(atMax.toString("base64")).ok, true);
  const over = Buffer.concat([atMax, Buffer.from("x")]);
  const r = G.checkQuotePdf(over.toString("base64"));
  assert.equal(r.ok, false);
  assert.match(r.message, /大きすぎ/);
});
t("checkQuotePdf: 本番の見積書の最大（約1.16MB・2026-11-18 実測）の大きさは通る", () => {
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1_164_064, 0x41)]);
  assert.equal(G.checkQuotePdf(big.toString("base64")).ok, true);
});
t("oneLine: CR・LF・タブ・U+2028 を空白にまとめ、長さで切る", () => {
  assert.equal(G.oneLine("山田\r\nBcc: evil@example.test"), "山田 Bcc: evil@example.test");
  assert.equal(G.oneLine("a\u2028b\u2029c\td\u0000e"), "a b c d e");
  assert.equal(G.oneLine("  前後  "), "前後");
  assert.equal(G.oneLine("あ".repeat(80), 60).length, 60);
  assert.equal(G.oneLine("ab😀cd", 3), "ab😀", "サロゲートペア（絵文字）の途中で切らない（R6）");
  assert.equal(G.oneLine("𠮷野家", 1), "𠮷", "4バイトの漢字も1文字として数える");
  assert.ok(!/[\ud800-\udbff]$/.test(G.oneLine("😀".repeat(70), 61)), "末尾に片割れが残らない");
  assert.equal(G.oneLine(null), "");
  assert.equal(G.oneLine(undefined), "");
});
t("quoteMailRecipient: 1つのアドレスの形でなければ空（送らない）", () => {
  assert.equal(G.quoteMailRecipient("office@example.test"), "office@example.test");
  assert.equal(G.quoteMailRecipient("office@example.test\r\nBcc: evil@example.test"), "", "改行を除いても1つのアドレスの形にならない");
  assert.equal(G.quoteMailRecipient(""), "");
  assert.equal(G.quoteMailRecipient("not-an-email"), "");
  assert.equal(G.quoteMailRecipient(undefined), "");
});

// ---------- 2. 結線（functions/index.js）----------
const src = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const h0 = readFileSync(new URL("../mitsumori.html", import.meta.url), "utf8");
const sq = src.slice(src.indexOf("exports.sendQuotePdf"), src.indexOf("// ===== 申し込みを受ける"));
t("結線: sendQuotePdf の両方の経路で checkQuotePdf を通し、元の pdfBase64 を保存・添付に使っていない", () => {
  assert.equal((sq.match(/QuoteGuard\.checkQuotePdf\(/g) || []).length, 2, "まとめ・単一の2か所");
  assert.ok(!/storeQuotePdfFile\([^)]*,\s*pdfBase64\)/.test(sq), "単一経路で生の pdfBase64 を保存していない");
  assert.ok(!/contentBase64:\s*pdfBase64\s*\}/.test(sq.slice(sq.indexOf("従来の単一見積もり経路"))), "単一経路で生の pdfBase64 を添付していない");
  assert.match(sq, /contentBase64: pdf\.base64/);
  assert.match(sq, /storeQuotePdfFile\(q\.caseId, filename, pdf\.base64\)/);
});
t("結線: sendQuotePdf の宛先は見積もりに保存した contactEmail（quoteSavedEmail）。案件の contactEmail・リクエストの値を宛先にしない（R1）", () => {
  assert.ok(!/body\.(to|email|cc)\b/.test(sq), "リクエストの to/email/cc を読んでいない");
  assert.ok(!/quoteCaseEmail/.test(src), "案件のアドレスを宛先にする関数は残っていない");
  assert.equal((sq.match(/const to = quoteSavedEmail\(q\);/g) || []).length, 1, "単一経路");
  assert.match(sq, /saves\.map\(\(\{ q \}\) => quoteSavedEmail\(q\)\)/, "まとめ経路");
  const fn = src.slice(src.indexOf("function quoteSavedEmail"), src.indexOf("function quoteMailText"));
  assert.match(fn, /QuoteGuard\.quoteMailRecipient\(normalizeEmail\(q && q\.contactEmail\)\)/);
  assert.ok(!/collection\("cases"\)/.test(fn));
  assert.match(sq, /mimeType: "application\/pdf"/);
});
t("R2: 画面は mailed===true か already のときだけ「お送りしました」（まとめ・単一とも）", () => {
  const send1 = h0.slice(h0.indexOf("async function sendQuotePdfToOffice"), h0.indexOf("async function sendQuotePdfsToOffice"));
  const sendN = h0.slice(h0.indexOf("async function sendQuotePdfsToOffice"), h0.indexOf("async function sendQuotePdfsToOffice") + 4000);
  assert.match(send1, /res\.ok && \(data\.mailed \|\| data\.status === 'already'\)/);
  assert.equal((sendN.match(/data\.mailed === true \|\| data\.status === 'already'/g) || []).length, 2, "1枚ずつ・まとめての2か所");
  assert.ok(!/data\.status === 'ok'/.test(sendN), "status:ok だけで成功にしない");
});
t("結線: buildRawMessage はヘッダーの値（From/To/Cc/Subject）を1行にする・添付の種別は形を確かめる", () => {
  const bm = src.slice(src.indexOf("function buildRawMessage"), src.indexOf("exports.sendCaseEmail"));
  assert.match(bm, /const hv = \(s\) => QuoteGuard\.oneLine\(s, 2000\)/);
  assert.match(bm, /`To: \$\{hv\(to\)\}`/);
  assert.match(bm, /`Cc: \$\{hv\(cc\)\}`/);
  assert.match(bm, /encWord\(hv\(subject\)\)/);
  assert.match(bm, /<\$\{hv\(sender\)\}>/);
  assert.match(bm, /\/\^\[A-Za-z0-9\.\+-\]\+\\\/\[A-Za-z0-9\.\+-\]\+\$\/\.test\(att\.mimeType/);
});
t("結線: 見積もり作成は名前・住所の欄を1行にしてから使う", () => {
  const cq = src.slice(src.indexOf("async function createOrUpdateMitsumoriQuote"), src.indexOf("exports.webhookMitsumori"));
  const iL = cq.indexOf("const L = QuoteGuard.oneLine"), iUse = cq.indexOf("const officeName = input.officeName");
  assert.ok(iL > 0 && iL < iUse);
  for (const k of ["officeName", "corpName", "contactName", "postalCode", "prefecture", "city", "addressDetail", "website"]) {
    assert.match(cq, new RegExp(`${k}: L\\(input\\.${k}, \\d+\\)`), k);
  }
  assert.match(cq, /normalizeEmail\(L\(input\.email, 254\)\)/);
  assert.match(cq, /normalizePhone\(L\(input\.phone, 30\)\)/);
});

// ---------- 3. A3: mitsumori.html の連絡先の欄 ----------
const h = readFileSync(new URL("../mitsumori.html", import.meta.url), "utf8");
const escSrc = /function esc\(t\) \{[^\n]*\}/.exec(h)[0];
const esc = new Function(`${escSrc}; return esc;`)();
t("A3: esc() は & < > \" ' を実体参照にする", () => {
  assert.equal(esc(`<img src=x onerror="alert(1)">&'`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
  assert.equal(esc(null), "");
});
t("A3: 連絡先の欄（prevContact）に入れる5つの値は、すべて esc() を通している", () => {
  const i0 = h.indexOf("const contactLines = [];"), i1 = h.indexOf(".innerHTML = contactLines.join('<br>');");
  assert.ok(i0 > 0 && i1 > i0);
  const block = h.slice(i0, i1);
  const pushes = block.match(/\.push\([^\n]*\);/g) || [];
  assert.equal(pushes.length, 6, "contactLines 3か所（郵便番号・住所・担当者名）＋ tellinks 2か所（電話・メール）＋ tellinks をまとめる1か所");
  for (const p of pushes) {
    if (p === ".push(tellinks.join(' ／ '));") continue; // tellinks の中身は下で esc 済み
    assert.match(p, /esc\(/, p);
  }
});
t("A3: 悪意ある名前・住所・電話・メール・郵便番号を入れて組み立てると、タグにならず文字として出る", () => {
  // renderOfficeDoc の連絡先の部分を、ページのコードそのままで動かす（DOM は代役）
  const i0 = h.indexOf("    const contactName = val('contactName');");
  const i1 = h.indexOf(".innerHTML = contactLines.join('<br>');") + ".innerHTML = contactLines.join('<br>');".length;
  const code = h.slice(i0, i1);
  const XSS = `<img src=x onerror=alert(1)>`;
  const fields = { contactName: XSS, contactTel: `0"><script>alert(2)</script>`, contactEmail: `a@b.c<svg onload=alert(3)>` };
  const out = {};
  const document = { getElementById: (id) => { out[id] = out[id] || {}; return out[id]; } };
  const val = (id) => fields[id] || "";
  const o = { s: "0", postalCode: `<b onmouseover=alert(4)>100</b>`, prefecture: "東京都", city: `<iframe src=javascript:alert(5)>`, addressDetail: "1-1", officePhone: "" };
  new Function("document", "val", "esc", "o", "s", code)(document, val, esc, o, "0");
  const html = out.prevContact0.innerHTML;
  assert.ok(html, "prevContact0 に書いた");
  assert.ok(!/<(img|script|svg|iframe|b)\b/i.test(html), `タグが残っていない: ${html}`);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(3\)&gt;/);
  assert.match(html, /〒&lt;b onmouseover=alert\(4\)&gt;100&lt;\/b&gt;/);
  assert.match(html, /&lt;iframe src=javascript:alert\(5\)&gt;/);
  assert.equal((html.match(/<br>/g) || []).length, 3, "行の区切り（<br>）だけはタグのまま");
});
t("A3: 普通の値の見た目は変わらない", () => {
  const i0 = h.indexOf("    const contactName = val('contactName');");
  const i1 = h.indexOf(".innerHTML = contactLines.join('<br>');") + ".innerHTML = contactLines.join('<br>');".length;
  const out = {};
  const document = { getElementById: (id) => { out[id] = out[id] || {}; return out[id]; } };
  const fields = { contactName: "多田 佳代", contactTel: "050-0000-0000", contactEmail: "office@example.test" };
  const o = { s: "0", postalCode: "100-0001", prefecture: "東京都", city: "千代田区", addressDetail: "1-1", officePhone: "" };
  new Function("document", "val", "esc", "o", "s", h.slice(i0, i1))(document, (id) => fields[id] || "", esc, o, "0");
  assert.equal(out.prevContact0.innerHTML,
    "〒100-0001<br>東京都千代田区1-1<br>ご担当：多田 佳代 様<br>TEL: 050-0000-0000 ／ office@example.test");
});

console.log(`OK test-quote-mail-guard: ${n} 件合格`);
