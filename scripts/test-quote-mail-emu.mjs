// 公開の見積もりの入口の踏み台メール対策（2026-11-18 セキュリティ点検 A2）を、Firestore・Storage のエミュレータで
// 実際に関数（webhookMitsumori・sendQuotePdf）を動かして確かめる。本番には繋がない（demo- プロジェクト・外への通信は止める）。
//
//   A. PDF でない添付（文章・HTML・data URI の頭付きの文章）・大きすぎる添付は 400。メールは出ない・保存もしない・見積もりも変えない
//   B. 宛先: リクエストに to/email/cc を足しても、見積もりの contactEmail が別でも、届くのは案件に登録済みのアドレスだけ
//   C. ヘッダー: 改行入りの名前でも、ヘッダーの数・名前は増えない（Bcc は出ない）。添付は application/pdf・中身は %PDF-
//   D. 案件にアドレスが無ければ送らない（mailError に理由）
//   E. まとめ（pdfs[]）経路: 1件でも PDF でなければ全体を 400／宛先は先頭の案件のアドレス
//   F. webhookMitsumori: 改行入りの名前・住所は1行にして保存。そのまま正規の流れ（見積もり→PDF送付）で、作った本人に届く
//
// 実行: firebase emulators:exec --only firestore,storage --project demo-quote-mail-test "node scripts/test-quote-mail-emu.mjs"
//   （bash scripts/test-all.sh の2段目でも動く）
import { createRequire } from "node:module";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST && !process.env.STORAGE_EMULATOR_HOST) {
  console.error("Storage のエミュレータがありません（--only firestore,storage で動かす。本番の Storage に書かないため止める）"); process.exit(2);
}
process.env.STORAGE_EMULATOR_HOST ||= "http://" + process.env.FIREBASE_STORAGE_EMULATOR_HOST;
process.env.GCLOUD_PROJECT ||= "demo-quote-mail-test";
if (!String(process.env.GCLOUD_PROJECT).startsWith("demo-")) { console.error("demo- 以外のプロジェクトでは動かさない"); process.exit(2); }
process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT; // 見積書の保存先バケットを demo- のものにする
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";

// 外へは出さない。Gmail の送信だけは中身を控えて「送れた」と返す（実際には送らない）
const sentMails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, opts);
  if (/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/send$/.test(u)) {
    const raw = JSON.parse(opts.body).raw;
    sentMails.push(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return new Response(JSON.stringify({ id: "m" + sentMails.length }), { status: 200 });
  }
  return new Response("blocked in test", { status: 503 });
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(REPO, "functions");
const require = createRequire(path.join(FN_DIR, "index.js"));
// Gmail の鍵（IAM の署名・OAuth のトークン）は代役にする。ほかの用途の GoogleAuth は元のまま
const { GoogleAuth } = require("google-auth-library");
const origGetClient = GoogleAuth.prototype.getClient;
GoogleAuth.prototype.getClient = async function () {
  return {
    async request(o) {
      const u = String(o.url || "");
      if (u.startsWith("https://iamcredentials.googleapis.com/")) return { data: { signedJwt: "test.jwt.sig" } };
      if (u === "https://oauth2.googleapis.com/token") return { data: { access_token: "test-access-token" } };
      throw new Error("テストでは外へ出さない: " + u);
    },
  };
};
void origGetClient;
const fns = require(path.join(FN_DIR, "index.js"));
const admin = require("firebase-admin");
const db = admin.firestore();
await db.collection("_probe").limit(1).get();
process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nonexistent/kjk-test-no-credentials.json";
const TS = admin.firestore.Timestamp;
const bucket = admin.storage().bucket(`${process.env.GOOGLE_CLOUD_PROJECT}.firebasestorage.app`);

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); console.error(`... ${t}`); }

function http(name, body) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "user-agent": "TestUA", origin: "https://kjk.tadakayo.jp" };
    const req = {
      method: "POST", body, headers, url: "/", originalUrl: "/", path: "/",
      get: (h) => headers[String(h).toLowerCase()], header: (h) => headers[String(h).toLowerCase()],
    };
    const done = (o) => { resolve({ status: res.statusCode, body: o }); res.headersSent = true; res.emit("finish"); };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, _h: {}, headersSent: false,
      setHeader(k, v) { this._h[String(k).toLowerCase()] = v; }, getHeader(k) { return this._h[String(k).toLowerCase()]; },
      removeHeader(k) { delete this._h[String(k).toLowerCase()]; }, set(k, v) { this.setHeader(k, v); return this; },
      vary() { return this; },
      status(c) { this.statusCode = c; return this; },
      json(o) { done(o); return this; }, send(o) { done(o); return this; }, end(o) { done(o ?? null); return this; },
    });
    Promise.resolve(fns[name](req, res)).catch(reject);
  });
}
const get = async (ref) => { const s = await ref.get(); return s.exists ? s.data() : null; };
const qd = (id) => db.collection("quotes").doc(id);
const cd = (id) => db.collection("cases").doc(id);
const filesOf = async (caseId) => (await bucket.getFiles({ prefix: `quotes/${caseId}/` }))[0].map((f) => f.name);

// メールを分解する: ヘッダー（最初の空行まで）の名前の並び・値、本文（text/plain）、添付
function parseMail(raw) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const lines = head.split("\r\n");
  const names = lines.map((l) => l.split(":")[0]);
  const hdr = Object.fromEntries(lines.map((l) => { const i = l.indexOf(":"); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
  const all = rest.join("\r\n\r\n");
  const parts = all.split("--tadakayo_po_mixed_boundary");
  const textPart = parts.find((p) => p.includes('Content-Type: text/plain')) || "";
  const text = Buffer.from(textPart.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, "").trim(), "base64").toString("utf8");
  const atts = parts.filter((p) => p.includes("Content-Disposition: attachment")).map((p) => {
    const [ph, pb] = p.split("\r\n\r\n");
    return { head: ph, data: Buffer.from(pb.replace(/\r\n/g, "").trim(), "base64") };
  });
  return { names, hdr, text, atts };
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");
const PDF64 = PDF.toString("base64");
const AMOUNTS = { readers: 46200, accompanyFee: 33000, discount: 0, subsidyPartTotal: 79200, extraPartTotal: 0, totalIncl: 79200, grantAmt: 64000, selfPay: 15200 };
function quote(caseId, o = {}) {
  return {
    caseId, caseNumber: 500, estNo: `EST-QM-${caseId}`, version: 1, status: "issued", plan: "houmon", planLabel: "訪問系",
    items: [{ sku: "cir415a-01", connector: null, subsidyQty: 2, extraQty: 0 }], amounts: AMOUNTS,
    validUntil: TS.fromMillis(Date.now() + 10 * 86400000), contactEmail: "office@example.test", contactName: "担当 花子",
    officeName: "事業所", corpName: "テスト法人", officeId: null, accessToken: "tok-" + caseId,
    pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null, createdVia: "web", createdAt: TS.now(), ...o,
  };
}
async function seed(items) { const b = db.batch(); for (const [ref, d] of items) b.set(ref, d); await b.commit(); }
const send = (id, pdfBase64, extra = {}) => http("sendQuotePdf", { quoteId: id, quoteToken: "tok-" + id, pdfBase64, ...extra });

await seed([
  [cd("A"), { contactEmail: "office@example.test", officeName: "事業所A", status: "confirming" }], [qd("A"), quote("A")],
  [cd("B"), { contactEmail: "office@example.test", officeName: "事業所B", status: "confirming" }],
  [qd("B"), quote("B", { contactEmail: "attacker@example.test", contactName: "山田\r\nBcc: evil@example.test\r\nX-Evil: 1",
    corpName: "法人\nSubject: spam", officeName: "事業所\r\n\r\n--tadakayo_po_mixed_boundary" })],
  [cd("D"), { contactEmail: "", officeName: "事業所D", status: "confirming" }], [qd("D"), quote("D")],
  [cd("G1"), { contactEmail: "group@example.test", status: "confirming" }], [qd("G1"), quote("G1", { contactEmail: "other1@example.test" })],
  [cd("G2"), { contactEmail: "group@example.test", status: "confirming" }], [qd("G2"), quote("G2", { contactEmail: "other2@example.test" })],
]);

// ---------- A ----------
section("A. PDF でない添付・大きすぎる添付は拒否");
{
  const before = sentMails.length;
  const bad = [
    ["文章", Buffer.from("Hello, click http://evil.example/").toString("base64")],
    ["HTML", Buffer.from("<html><body>spam</body></html>").toString("base64")],
    ["data URI の頭付きの文章", "data:application/pdf;base64," + Buffer.from("not a pdf").toString("base64")],
    ["base64 でない文字", PDF64 + "\r\n--tadakayo_po_mixed_boundary\r\nContent-Type: text/html\r\n"],
    ["5MB を超える PDF", Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024, 0x20)]).toString("base64")],
  ];
  for (const [label, b64] of bad) {
    const r = await send("A", b64);
    check(`${label}: 400`, r.status === 400, JSON.stringify(r.body).slice(0, 120));
  }
  check("メールは1通も出ていない", sentMails.length === before, String(sentMails.length - before));
  check("Storage に保存していない", (await filesOf("A")).length === 0);
  const q = await get(qd("A"));
  check("見積もりは変わっていない（pdfPath・mailedAt なし）", q.pdfPath === null && q.mailedAt === null);
}

// ---------- B・C ----------
section("B・C. 宛先は案件のアドレスだけ・ヘッダーは増えない");
{
  const before = sentMails.length;
  const r = await send("B", PDF64, { to: "evil@example.test", email: "evil@example.test", cc: "evil@example.test", mailTo: "evil@example.test" });
  check("正規の PDF は通る（200・mailed）", r.status === 200 && r.body.mailed === true, JSON.stringify(r.body));
  check("メールはちょうど1通", sentMails.length === before + 1);
  const m = parseMail(sentMails[sentMails.length - 1] || "");
  check("To は案件の登録アドレス", m.hdr.To === "office@example.test", m.hdr.To);
  check("Cc は事務局のアドレス（固定）", m.hdr.Cc === "kjk-staff@tadakayo.jp", m.hdr.Cc);
  check("ヘッダーの並びは From/To/Cc/Subject/MIME-Version/Content-Type だけ",
    JSON.stringify(m.names) === JSON.stringify(["From", "To", "Cc", "Subject", "MIME-Version", "Content-Type"]), JSON.stringify(m.names));
  const raw = sentMails[sentMails.length - 1] || "";
  check("リクエストの to・cc（evil）はどのヘッダーにも出ない", !/^[A-Za-z-]+:.*evil@/m.test(raw.split("\r\n\r\n")[0]));
  check("attacker@ はメールのどこにも無い", !raw.includes("attacker@example.test"));
  check("Bcc・X-Evil のヘッダーは無い", !/^Bcc:/mi.test(raw) && !/^X-Evil:/mi.test(raw));
  check("区切り（boundary）は本物の3つ（本文・添付・終わり）だけ", (raw.match(/--tadakayo_po_mixed_boundary/g) || []).length === 3);
  check("本文の宛名は1行（改行入りの名前が行を作らない）", m.text.includes("山田 Bcc: evil@example.test X-Evil: 1 様") && !/^Bcc:/m.test(m.text), m.text.slice(0, 120));
  check("本文の法人名・事業所名も1行", !/^Subject: spam/m.test(m.text) && !m.text.includes("\n--tadakayo_po_mixed_boundary"));
  check("添付は1つ・application/pdf", m.atts.length === 1 && /Content-Type: application\/pdf;/.test(m.atts[0].head), m.atts[0] && m.atts[0].head);
  check("添付の中身は送った PDF そのもの", m.atts[0] && m.atts[0].data.equals(PDF));
  const q = await get(qd("B"));
  check("見積もりの mailedTo は案件のアドレス", q.mailedTo === "office@example.test", q.mailedTo);
  const files = await filesOf("B");
  check("Storage（エミュレータ）に PDF を保存", files.length === 1 && files[0].endsWith(".pdf"), JSON.stringify(files));
  if (files[0]) {
    const [buf] = await bucket.file(files[0]).download();
    check("保存した中身も PDF", buf.equals(PDF));
  }
  const acts = (await db.collection("activities").where("caseId", "==", "B").get()).docs.map((d) => d.data());
  check("活動の記録の宛先も案件のアドレス", acts.some((a) => a.type === "gmail_sent" && a.body.startsWith("宛先: office@example.test")));
}

// ---------- D ----------
section("D. 案件にアドレスが無ければ送らない");
{
  const before = sentMails.length;
  const r = await send("D", PDF64);
  check("200 だが mailed:false", r.status === 200 && r.body.mailed === false, JSON.stringify(r.body));
  check("メールは出ていない", sentMails.length === before);
  const q = await get(qd("D"));
  check("mailError に理由・mailedTo なし", /宛先のメールアドレス/.test(q.mailError || "") && q.mailedTo === null, q.mailError);
}

// ---------- E ----------
section("E. まとめ（pdfs[]）経路");
{
  const before = sentMails.length;
  const r1 = await http("sendQuotePdf", { pdfs: [
    { quoteId: "G1", quoteToken: "tok-G1", pdfBase64: PDF64 },
    { quoteId: "G2", quoteToken: "tok-G2", pdfBase64: Buffer.from("not a pdf").toString("base64") },
  ] });
  check("1件でも PDF でなければ 400", r1.status === 400, JSON.stringify(r1.body));
  check("メールは出ていない・保存もしていない", sentMails.length === before && (await filesOf("G1")).length === 0);
  const r2 = await http("sendQuotePdf", { to: "evil@example.test", pdfs: [
    { quoteId: "G1", quoteToken: "tok-G1", pdfBase64: PDF64, to: "evil@example.test" },
    { quoteId: "G2", quoteToken: "tok-G2", pdfBase64: PDF64 },
  ] });
  check("両方 PDF なら 200・mailed", r2.status === 200 && r2.body.mailed === true, JSON.stringify(r2.body));
  const m = parseMail(sentMails[sentMails.length - 1] || "");
  check("宛先は先頭の案件の登録アドレス（見積もりの other1/other2・リクエストの evil ではない）", m.hdr.To === "group@example.test", m.hdr.To);
  check("添付2つ・どちらも application/pdf", m.atts.length === 2 && m.atts.every((a) => /application\/pdf/.test(a.head)));
}

// ---------- F ----------
section("F. webhookMitsumori → sendQuotePdf（正規の流れ）");
{
  const r = await http("webhookMitsumori", {
    officeName: "改行\r\n事業所", corpName: "改行\n法人", contactName: "見積\r\nBcc: evil@example.test", email: "maker@example.test",
    phone: "03-0000-0000", postalCode: "100-0001", prefecture: "東京都", city: "千代田区", addressDetail: "1-1\r\n2-2",
    subsidyCategory: "houmon", btSubsidyQty: 2, usbSubsidyQty: 0, btExtraQty: 0, usbExtraQty: 0, usbConnector: null,
  });
  check("見積もりができる（200）", r.status === 200 && r.body.quoteId && r.body.quoteToken, JSON.stringify(r.body).slice(0, 200));
  if (r.body.quoteId) {
    const q = await get(qd(r.body.quoteId));
    const c = await get(cd(q.caseId));
    check("見積もりの名前の欄に改行が無い", !/[\r\n]/.test(q.contactName + q.officeName + q.corpName), JSON.stringify([q.contactName, q.officeName, q.corpName]));
    check("案件の名前の欄に改行が無い", !/[\r\n]/.test(c.contactName + c.officeName + c.corpName));
    check("案件のアドレスは入力したアドレス", c.contactEmail === "maker@example.test");
    const off = await get(db.collection("offices").doc(c.officeId));
    check("事業所の住所に改行が無い", !/[\r\n]/.test(off.address + off.addressDetail), off.address);
    const before = sentMails.length;
    const s = await http("sendQuotePdf", { quoteId: r.body.quoteId, quoteToken: r.body.quoteToken, pdfBase64: "data:application/pdf;base64," + PDF64 });
    check("画面と同じ送り方（data URI の頭付きでも）で送れる", s.status === 200 && s.body.mailed === true, JSON.stringify(s.body));
    const m = parseMail(sentMails[before] || "");
    check("見積もりを作った本人（入力したアドレス）に届く", m.hdr.To === "maker@example.test", m.hdr.To);
    check("ヘッダーは6つのまま", m.names.length === 6, JSON.stringify(m.names));
    check("本文の宛名は1行", m.text.includes("見積 Bcc: evil@example.test 様"));
    const again = await http("sendQuotePdf", { quoteId: r.body.quoteId, quoteToken: r.body.quoteToken, pdfBase64: PDF64 });
    check("2回目は already（二重送信しない・従来どおり）", again.status === 200 && again.body.status === "already");
    const wrong = await http("sendQuotePdf", { quoteId: r.body.quoteId, quoteToken: "x".repeat(32), pdfBase64: PDF64 });
    check("トークン違いは 403（従来どおり）", wrong.status === 403);
  }
}

console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
