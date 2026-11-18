// 見積書メールの1日の送信数の上限（2026-11-18 §C19・セキュリティ点検 A2 ②）を、Firestore・Storage のエミュレータで確かめる。
// 本番には繋がない（demo- プロジェクト・外への通信は止める。Gmail と Chat は中身を控えて「送れた」と返すだけ）。
//
//   M. 予約の仕組み（functions/quote-mail-ratelimit.js を直接）
//      30通目まで通り31通目は止まる／別の宛先は別に数える／全体150／並列でもすり抜けない（同じ宛先40件→30件・130通済みの日に別々の宛先40件→20件）
//      ／release で戻る／警報はその日1回だけ／JST の日付で切り替わる／文書IDにアドレスを使わない・expiresAt がある／伏せ字
//   H. 公開の入口 sendQuotePdf を通して
//      正規の流れ（webhookMitsumori→sendQuotePdf）が壊れない／31通目は送らないが見積書は保存される（mailed:false・mailError）
//      ／送信の失敗は数えない／全体の上限で警報が1回だけ（宛先を含まない）／警報が失敗しても本体は落ちない
//      ／まとめ（pdfs[]）は1通と数える／mail:false は数えない／日付が変わると送れる
//
// 実行: firebase emulators:exec --only firestore,storage --project demo-quote-mail-rl-test "node scripts/test-quote-mail-ratelimit-emu.mjs"
//   （bash scripts/test-all.sh の2段目でも動く）
import { createRequire } from "node:module";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST && !process.env.STORAGE_EMULATOR_HOST) {
  console.error("Storage のエミュレータがありません（--only firestore,storage で動かす）"); process.exit(2);
}
process.env.STORAGE_EMULATOR_HOST ||= "http://" + process.env.FIREBASE_STORAGE_EMULATOR_HOST;
process.env.GCLOUD_PROJECT ||= "demo-quote-mail-rl-test";
if (!String(process.env.GCLOUD_PROJECT).startsWith("demo-")) { console.error("demo- 以外のプロジェクトでは動かさない"); process.exit(2); }
process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";

const CHAT_URL = "https://chat.googleapis.com/v1/spaces/TEST-PM/messages?key=test";
const sentMails = [];
const chatPosts = [];
let gmailFails = false, chatFails = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, opts);
  if (/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/[^/]+\/messages\/send$/.test(u)) {
    if (gmailFails) return new Response("backend error", { status: 500 });
    const raw = JSON.parse(opts.body).raw;
    sentMails.push(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return new Response(JSON.stringify({ id: "m" + sentMails.length }), { status: 200 });
  }
  if (u.startsWith("https://chat.googleapis.com/")) {
    chatPosts.push({ url: u, body: JSON.parse(opts.body) });
    return chatFails ? new Response("chat down", { status: 500 }) : new Response("{}", { status: 200 });
  }
  return new Response("blocked in test", { status: 503 });
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(REPO, "functions");
const require = createRequire(path.join(FN_DIR, "index.js"));
const { GoogleAuth } = require("google-auth-library");
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
const fns = require(path.join(FN_DIR, "index.js"));
const RL = require(path.join(FN_DIR, "quote-mail-ratelimit.js")); // index.js と同じモジュール（時計を差し替えると関数にも効く）
const admin = require("firebase-admin");
const db = admin.firestore();
await db.collection("_probe").limit(1).get();
process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nonexistent/kjk-test-no-credentials.json";
const TS = admin.firestore.Timestamp;
const FV = admin.firestore.FieldValue;
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
const rl = (id) => db.collection(RL.RATE_LIMIT_COLLECTION).doc(id);
const filesOf = async (caseId) => (await bucket.getFiles({ prefix: `quotes/${caseId}/` }))[0].map((f) => f.name);
const countOf = async (id) => ((await get(rl(id))) || {}).count || 0;
const totalId = (day) => `quoteMail_${day}`;
const rcptId = (day, email) => `quoteMail_${day}_${RL.recipientKey(email)}`;
const opts = { FieldValue: FV, Timestamp: TS };
// 日付は JST の正午にする（その日の中で動かない）
const at = (ymd) => new Date(`${ymd}T12:00:00+09:00`);
const setDay = (ymd) => { RL.clock.now = () => at(ymd); };

const PDF64 = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1").toString("base64");
const AMOUNTS = { readers: 46200, accompanyFee: 33000, discount: 0, subsidyPartTotal: 79200, extraPartTotal: 0, totalIncl: 79200, grantAmt: 64000, selfPay: 15200 };
function quote(caseId, o = {}) {
  return {
    caseId, caseNumber: 600, estNo: `EST-RL-${caseId}`, version: 1, status: "issued", plan: "houmon", planLabel: "訪問系",
    items: [{ sku: "cir415a-01", connector: null, subsidyQty: 2, extraQty: 0 }], amounts: AMOUNTS,
    validUntil: TS.fromMillis(Date.now() + 10 * 86400000), contactEmail: "office@example.test", contactName: "担当 花子",
    officeName: "事業所", corpName: "テスト法人", officeId: null, accessToken: "tok-" + caseId,
    pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null, createdVia: "web", createdAt: TS.now(), ...o,
  };
}
async function seedQuotes(ids, o = {}) {
  for (let i = 0; i < ids.length; i += 400) {
    const b = db.batch();
    for (const id of ids.slice(i, i + 400)) { b.set(cd(id), { contactEmail: o.contactEmail || "office@example.test", status: "confirming" }); b.set(qd(id), quote(id, o)); }
    await b.commit();
  }
}
const send = (id, extra = {}) => http("sendQuotePdf", { quoteId: id, quoteToken: "tok-" + id, pdfBase64: PDF64, ...extra });

// 警報の投稿先（PM）。getSettings は60秒キャッシュなので、関数を呼ぶ前に置く
await db.collection("appConfig").doc("settings").set({ pmChatWebhookUrl: CHAT_URL });

// ======================= M. 予約の仕組み =======================
section("M1. 同じ宛先は30通まで・31通目は止まる／別の宛先は別に数える");
{
  const now = at("2026-12-01");
  const a = "same@example.test";
  let okN = 0;
  for (let i = 0; i < 30; i++) if ((await RL.reserveQuoteMail(db, a, { now, ...opts })).ok) okN++;
  check("30通目までは予約できる", okN === 30, String(okN));
  const r31 = await RL.reserveQuoteMail(db, a, { now, ...opts });
  check("31通目は rate_limited_recipient", !r31.ok && r31.reason === "rate_limited_recipient", JSON.stringify(r31));
  const rUpper = await RL.reserveQuoteMail(db, " SAME@Example.TEST ", { now, ...opts });
  check("大文字・空白違いも同じ宛先として数える", !rUpper.ok && rUpper.reason === "rate_limited_recipient");
  const rb = await RL.reserveQuoteMail(db, "other@example.test", { now, ...opts });
  check("別の宛先は通る", rb.ok === true);
  check("宛先の文書は30・別の宛先は1", (await countOf(rcptId("20261201", a))) === 30 && (await countOf(rcptId("20261201", "other@example.test"))) === 1);
  check("全体は31（止めた分は数えない）", (await countOf(totalId("20261201"))) === 31, String(await countOf(totalId("20261201"))));
  const ids = (await db.collection(RL.RATE_LIMIT_COLLECTION).get()).docs.map((d) => d.id);
  check("文書IDにメールアドレスが入っていない", ids.every((id) => !id.includes("@") && !id.includes("example")), JSON.stringify(ids));
  const doc = await get(rl(rcptId("20261201", a)));
  check("文書の中身にもアドレスが無い", !JSON.stringify(doc).includes("example.test"));
  check("expiresAt はその日の終わり＋7日（2026-12-09 0:00 JST）",
    doc.expiresAt && doc.expiresAt.toMillis() === new Date("2026-12-09T00:00:00+09:00").getTime(), doc.expiresAt && doc.expiresAt.toDate().toISOString());
  check("全体の文書にも expiresAt", !!(await get(rl(totalId("20261201")))).expiresAt);
}

section("M2. 全体は1日150通・警報はその日1回だけ");
{
  const now = at("2026-12-02");
  let okN = 0;
  for (let i = 0; i < 150; i++) if ((await RL.reserveQuoteMail(db, `t${i}@example.test`, { now, ...opts })).ok) okN++;
  check("別々の宛先150通は予約できる", okN === 150, String(okN));
  const r151 = await RL.reserveQuoteMail(db, "t151@example.test", { now, ...opts });
  check("151通目は rate_limited_total・警報あり", !r151.ok && r151.reason === "rate_limited_total" && r151.alert === true, JSON.stringify(r151));
  const r152 = await RL.reserveQuoteMail(db, "t152@example.test", { now, ...opts });
  check("152通目は警報なし（その日1回だけ）", !r152.ok && r152.reason === "rate_limited_total" && r152.alert === false, JSON.stringify(r152));
  check("全体の数は150のまま", (await countOf(totalId("20261202"))) === 150);
  check("止めた宛先の文書は作らない", !(await get(rl(rcptId("20261202", "t151@example.test")))));
}

section("M3. 並列でも上限をすり抜けない（トランザクション）");
{
  const now = at("2026-12-03");
  const rs = await Promise.all(Array.from({ length: 40 }, () => RL.reserveQuoteMail(db, "par@example.test", { now, ...opts })));
  const okN = rs.filter((r) => r.ok).length;
  check("同じ宛先へ並列40件 → 予約できるのは30件", okN === 30, String(okN));
  check("残り10件は rate_limited_recipient", rs.filter((r) => !r.ok && r.reason === "rate_limited_recipient").length === 10);
  check("宛先の文書の数は30", (await countOf(rcptId("20261203", "par@example.test"))) === 30);

  // 全体: 130通まで済んだ日に、別々の宛先へ並列40件 → 通るのは残りの20件だけ
  // （1つの文書への同時の書き込みが多すぎると、Firestore の再試行が尽きて例外になる＝呼び出し側は「送らない」。並列は40件で確かめる）
  const now2 = at("2026-12-04");
  await rl(totalId("20261204")).set({ kind: "quoteMailTotal", day: "20261204", count: 130 });
  const rs2 = await Promise.all(Array.from({ length: 40 }, (_, i) => RL.reserveQuoteMail(db, `p${i}@example.test`, { now: now2, ...opts })));
  const ok2 = rs2.filter((r) => r.ok).length;
  check("130通済みの日に別々の宛先へ並列40件 → 予約できるのは20件", ok2 === 20, String(ok2));
  check("全体の文書の数は150", (await countOf(totalId("20261204"))) === 150);
  check("並列でも警報は1回だけ", rs2.filter((r) => r.alert === true).length === 1, String(rs2.filter((r) => r.alert === true).length));
}

section("M4. release で戻る（送信の失敗は数えない）／JST の日付");
{
  const now = at("2026-12-05");
  const r = await RL.reserveQuoteMail(db, "rel@example.test", { now, ...opts });
  check("予約で1", r.ok && (await countOf(rcptId("20261205", "rel@example.test"))) === 1 && (await countOf(totalId("20261205"))) === 1);
  await r.release();
  await r.release(); // 2回呼んでも1回分だけ
  check("release で0に戻る（2回呼んでも負にならない）", (await countOf(rcptId("20261205", "rel@example.test"))) === 0 && (await countOf(totalId("20261205"))) === 0);
  check("23:59:59 JST はその日", RL.jstDay(new Date("2026-12-05T23:59:59+09:00")) === "20261205");
  check("0:00 JST で翌日（UTC ではまだ前日の 15:00）", RL.jstDay(new Date("2026-12-05T15:00:00Z")) === "20261206");
  check("UTC の 0:00 前後でも JST の日付", RL.jstDay(new Date("2026-12-05T23:30:00Z")) === "20261206");
  check("伏せ字 a***@d***.jp", RL.maskEmail("abc@domain.co.jp") === "a***@d***.jp", RL.maskEmail("abc@domain.co.jp"));
  check("警報の文面は日付だけ（宛先なし）", RL.totalLimitAlertText("20261205") === "⚠️ 見積書メールの1日の上限（150通）に達しました。公開の入口からの送信が異常に多い可能性があります（2026-12-05）");
  check("定数は 30・150", RL.QUOTE_MAIL_DAILY_PER_RECIPIENT === 30 && RL.QUOTE_MAIL_DAILY_TOTAL === 150);
}

// ======================= H. sendQuotePdf を通して =======================
section("H1. 正規の流れ（webhookMitsumori → sendQuotePdf）が壊れない・1通と数える");
{
  setDay("2026-12-10");
  const r = await http("webhookMitsumori", {
    officeName: "上限確認事業所", corpName: "上限確認法人", contactName: "見積 太郎", email: "flow@example.test",
    phone: "03-0000-0000", postalCode: "100-0001", prefecture: "東京都", city: "千代田区", addressDetail: "1-1",
    subsidyCategory: "houmon", btSubsidyQty: 2, usbSubsidyQty: 0, btExtraQty: 0, usbExtraQty: 0, usbConnector: null,
  });
  check("見積もりができる", r.status === 200 && r.body.quoteId && r.body.quoteToken, JSON.stringify(r.body).slice(0, 160));
  const before = sentMails.length;
  const s = await http("sendQuotePdf", { quoteId: r.body.quoteId, quoteToken: r.body.quoteToken, pdfBase64: "data:application/pdf;base64," + PDF64 });
  check("送れる（200・mailed・mailError なし）", s.status === 200 && s.body.mailed === true && !("mailError" in s.body), JSON.stringify(s.body));
  check("メールは1通", sentMails.length === before + 1);
  check("宛先・全体とも1と数える", (await countOf(rcptId("20261210", "flow@example.test"))) === 1 && (await countOf(totalId("20261210"))) === 1);
  const again = await http("sendQuotePdf", { quoteId: r.body.quoteId, quoteToken: r.body.quoteToken, pdfBase64: PDF64 });
  check("2回目は already（数えない）", again.body.status === "already" && (await countOf(totalId("20261210"))) === 1);
}

section("H2. 同じ宛先の31通目は送らない・見積書は保存される");
{
  setDay("2026-12-11");
  const ids = Array.from({ length: 31 }, (_, i) => `R${i}`);
  await seedQuotes(ids, { contactEmail: "limit@example.test" });
  const before = sentMails.length;
  let okN = 0;
  for (const id of ids.slice(0, 30)) { const s = await send(id); if (s.status === 200 && s.body.mailed === true) okN++; }
  check("30通目まで送れる", okN === 30, String(okN));
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  const s31 = await send("R30");
  console.warn = origWarn;
  check("ログは伏せ字の宛先（l***@e***.test）で、アドレスそのものは出さない",
    warns.some((w) => w.includes("rate_limited_recipient") && w.includes("l***@e***.test")) && !warns.some((w) => w.includes("limit@example.test")), JSON.stringify(warns));
  check("31通目: 200・status ok・mailed:false・mailError=rate_limited_recipient",
    s31.status === 200 && s31.body.status === "ok" && s31.body.mailed === false && s31.body.mailError === "rate_limited_recipient", JSON.stringify(s31.body));
  check("31通目のメールは出ていない", sentMails.length === before + 30, String(sentMails.length - before));
  check("31通目でも PDF の URL を返す（画面で保存できる）", typeof s31.body.pdfUrl === "string" && s31.body.pdfUrl.length > 0);
  const q = await get(qd("R30"));
  check("見積書は保存される（pdfPath・Storage）", !!q.pdfPath && (await filesOf("R30")).length === 1);
  check("mailedAt・mailedTo なし・mailError に職員向けの理由", q.mailedAt === null && q.mailedTo === null && /同じ宛先への1日の送信上限（30通）/.test(q.mailError || ""), q.mailError);
  check("宛先の数は30のまま", (await countOf(rcptId("20261211", "limit@example.test"))) === 30);
  check("全体の上限ではないので警報は出ない", chatPosts.length === 0, String(chatPosts.length));
  await seedQuotes(["R-other"], { contactEmail: "other-limit@example.test" });
  const so = await send("R-other");
  check("別の宛先は送れる", so.body.mailed === true, JSON.stringify(so.body));
}

section("H3. 送信に失敗した分は数えない");
{
  setDay("2026-12-12");
  await seedQuotes(["F1", "F2"], { contactEmail: "fail@example.test" });
  gmailFails = true;
  const s = await send("F1");
  gmailFails = false;
  check("失敗: mailed:false（上限の理由コードは付かない）", s.status === 200 && s.body.mailed === false && !("mailError" in s.body), JSON.stringify(s.body));
  check("失敗した分は数えない（宛先0・全体0）", (await countOf(rcptId("20261212", "fail@example.test"))) === 0 && (await countOf(totalId("20261212"))) === 0);
  const s2 = await send("F2");
  check("次は送れて1と数える", s2.body.mailed === true && (await countOf(totalId("20261212"))) === 1);
}

section("H4. 全体の上限（150）で送らない・警報は1回だけ・宛先を含まない");
{
  setDay("2026-12-13");
  // 149通分は直接置く（同じ数え方の文書）。150通目は通り、151通目から止まる
  await rl(totalId("20261213")).set({ kind: "quoteMailTotal", day: "20261213", count: 149 });
  await seedQuotes(["T150", "T151", "T152"], {});
  await db.collection("quotes").doc("T150").update({ contactEmail: "t150@example.test" });
  await db.collection("quotes").doc("T151").update({ contactEmail: "t151@example.test" });
  await db.collection("quotes").doc("T152").update({ contactEmail: "t152@example.test" });
  const chatBefore = chatPosts.length, before = sentMails.length;
  const s150 = await send("T150");
  check("150通目は送れる", s150.body.mailed === true, JSON.stringify(s150.body));
  const s151 = await send("T151");
  check("151通目: mailed:false・mailError=rate_limited_total", s151.body.status === "ok" && s151.body.mailed === false && s151.body.mailError === "rate_limited_total", JSON.stringify(s151.body));
  check("151通目の見積書は保存される", !!(await get(qd("T151"))).pdfPath && /1日の送信上限（150通）/.test((await get(qd("T151"))).mailError || ""));
  const s152 = await send("T152");
  check("152通目も送らない", s152.body.mailed === false && s152.body.mailError === "rate_limited_total");
  check("メールは150通目の1通だけ", sentMails.length === before + 1);
  const posts = chatPosts.slice(chatBefore);
  check("警報はちょうど1回", posts.length === 1, String(posts.length));
  check("警報の投稿先は設定の PM の Webhook", posts[0] && posts[0].url === CHAT_URL);
  check("警報の文面は上限と日付だけ（アドレスなし）",
    posts[0] && posts[0].body.text === RL.totalLimitAlertText("20261213") && !/@/.test(posts[0].body.text), posts[0] && posts[0].body.text);
  check("全体の文書に alertedAt", !!(await get(rl(totalId("20261213")))).alertedAt);
}

section("H5. 警報の送信に失敗しても本体は落ちない");
{
  setDay("2026-12-14");
  await rl(totalId("20261214")).set({ kind: "quoteMailTotal", day: "20261214", count: 150 });
  await seedQuotes(["W1"], { contactEmail: "w1@example.test" });
  chatFails = true;
  const chatBefore = chatPosts.length;
  const s = await send("W1");
  chatFails = false;
  check("Chat が 500 でも 200・status ok・mailed:false", s.status === 200 && s.body.status === "ok" && s.body.mailed === false && s.body.mailError === "rate_limited_total", JSON.stringify(s.body));
  check("警報は試みた（1回）", chatPosts.length === chatBefore + 1);
  check("見積書は保存される", !!(await get(qd("W1"))).pdfPath);
}

section("H6. まとめ（pdfs[]）は1通と数える・mail:false は数えない");
{
  setDay("2026-12-15");
  await seedQuotes(["G1", "G2"], { contactEmail: "group@example.test" });
  const s = await http("sendQuotePdf", { pdfs: [
    { quoteId: "G1", quoteToken: "tok-G1", pdfBase64: PDF64 },
    { quoteId: "G2", quoteToken: "tok-G2", pdfBase64: PDF64 },
  ] });
  check("まとめて送れる", s.status === 200 && s.body.mailed === true, JSON.stringify(s.body));
  check("宛先1・全体1と数える", (await countOf(rcptId("20261215", "group@example.test"))) === 1 && (await countOf(totalId("20261215"))) === 1);
  await seedQuotes(["N1"], { contactEmail: "nomail@example.test" });
  const n = await send("N1", { mail: false });
  check("mail:false は保存だけで数えない", n.status === 200 && n.body.mailed === false && (await countOf(totalId("20261215"))) === 1);
  // まとめの経路でも上限は効く
  await rl(rcptId("20261215", "group2@example.test")).set({ count: 30 });
  await seedQuotes(["G3", "G4"], { contactEmail: "group2@example.test" });
  const before = sentMails.length;
  const s2 = await http("sendQuotePdf", { pdfs: [
    { quoteId: "G3", quoteToken: "tok-G3", pdfBase64: PDF64 },
    { quoteId: "G4", quoteToken: "tok-G4", pdfBase64: PDF64 },
  ] });
  check("まとめでも上限なら mailed:false・mailError=rate_limited_recipient", s2.body.mailed === false && s2.body.mailError === "rate_limited_recipient", JSON.stringify(s2.body));
  check("メールは出ていない・2件とも保存される", sentMails.length === before && !!(await get(qd("G3"))).pdfPath && !!(await get(qd("G4"))).pdfPath);
}

section("H7. 日付（JST）が変わると、止まっていた宛先も送れる");
{
  RL.clock.now = () => new Date("2026-12-11T23:59:30+09:00");
  await seedQuotes(["D1", "D2"], { contactEmail: "limit@example.test" });
  const s1 = await send("D1");
  check("同じ日（23:59 JST）はまだ止まる", s1.body.mailed === false && s1.body.mailError === "rate_limited_recipient", JSON.stringify(s1.body));
  RL.clock.now = () => new Date("2026-12-12T00:00:05+09:00");
  const s2 = await send("D2");
  check("0:00 JST を過ぎると送れる", s2.body.mailed === true, JSON.stringify(s2.body));
}
RL.clock.now = () => new Date();

console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
