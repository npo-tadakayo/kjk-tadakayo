// sendCaseEmail の「準備 → 送信 → 対応記録」（functions/case-mail.js）のテスト。node scripts/test-case-mail.mjs
// Gmail・Firestore には繋がない（送信は偽の post、記録は偽の record で差し替える）。メールは1通も送らない。
// 2026-11-12・設計書 CRM改善_設計書_20261110 §3 点検4 の根本対応
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { runCaseMail, CaseMailError, shortReason, DEFINITE_FAIL_STATUSES, RECORD_TIMEOUT_MS } = require("../functions/case-mail.js");
const indexSrc = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");

let n = 0;
const ta = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const quiet = () => {};
const NOW = new Date("2026-11-12T01:23:45.678Z");
const okRes = (body = { id: "m1" }) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const ngRes = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "err" });
// 呼ばれた順を残す偽物一式
function deps(over = {}) {
  const calls = [];
  const d = {
    prepare: async () => { calls.push("prepare"); return { raw: "R" }; },
    post: async (p) => { calls.push(`post:${p.raw}`); return okRes(); },
    record: async ({ sentAt }) => { calls.push(`record:${sentAt}`); },
    touch: async () => { calls.push("touch"); },
    now: () => NOW,
    logError: quiet,
    ...over,
  };
  return { d, calls };
}
const rejectsWith = async (p, code) => {
  try { await p; } catch (e) {
    assert.ok(e instanceof CaseMailError, `CaseMailError でない: ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail("投げなかった");
};

await ta("送信も記録も成功 → { ok, sent, id, sentAt }（recordError なし）・記録→更新日時の順", async () => {
  const { d, calls } = deps();
  const r = await runCaseMail(d);
  assert.deepEqual(r, { ok: true, sent: true, id: "m1", sentAt: NOW.toISOString() });
  assert.deepEqual(calls, ["prepare", "post:R", `record:${NOW.toISOString()}`, "touch"]);
});

await ta("送信後に対応記録が失敗 → 投げずに recordError（短い理由）。更新日時は触らない", async () => {
  const { d, calls } = deps({ record: async () => { throw Object.assign(new Error("PERMISSION_DENIED: x".repeat(40)), { code: 7 }); } });
  const r = await runCaseMail(d);
  assert.equal(r.ok, true); assert.equal(r.sent, true); assert.equal(r.sentAt, NOW.toISOString()); assert.equal(r.id, "m1");
  assert.match(r.recordError, /^対応記録の書き込みに失敗しました（7: PERMISSION_DENIED/);
  assert.ok(r.recordError.length < 160, "理由が長すぎる");
  assert.ok(!calls.includes("touch"));
});

await ta("案件の更新日時だけの失敗は recordError にしない", async () => {
  const { d } = deps({ touch: async () => { throw new Error("NOT_FOUND"); } });
  const r = await runCaseMail(d);
  assert.equal(r.recordError, undefined);
  assert.equal(r.sent, true);
});

await ta("応答の本文が読めなくても送信済み（id は空）", async () => {
  const { d, calls } = deps({ post: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); }, text: async () => "" }) });
  const r = await runCaseMail(d);
  assert.equal(r.sent, true); assert.equal(r.id, ""); assert.equal(r.recordError, undefined);
  assert.ok(calls.some((c) => c.startsWith("record:")));
});

await ta("案件なし（record を渡さない）→ 記録はせず送信済み", async () => {
  const { d } = deps({ record: null, touch: null });
  const r = await runCaseMail(d);
  assert.deepEqual(r, { ok: true, sent: true, id: "m1", sentAt: NOW.toISOString() });
});

await ta("送る前の失敗（設定・トークン）→ failed-precondition・送信も記録もしない", async () => {
  const { d, calls } = deps({ prepare: async () => { throw new Error("token"); } });
  const e = await rejectsWith(runCaseMail(d), "failed-precondition");
  assert.match(e.message, /メールは送っていません/);
  assert.deepEqual(calls, []);
});

await ta("Gmail が 400・401・403・404・429 → failed-precondition（はっきりした失敗）・記録しない", async () => {
  assert.deepEqual(DEFINITE_FAIL_STATUSES, [400, 401, 403, 404, 429]);
  for (const st of [400, 401, 403, 404, 429]) {
    const { d, calls } = deps({ post: async () => ngRes(st) });
    const e = await rejectsWith(runCaseMail(d), "failed-precondition");
    assert.match(e.message, new RegExp(`Gmail送信に失敗しました（${st}）`));
    assert.ok(!calls.some((c) => c.startsWith("record")));
  }
});

await ta("Gmail がそれ以外の 4xx（408・499 など途中の機器）・5xx・0・通信そのものの失敗 → internal（送れたか不明）・記録しない", async () => {
  for (const post of [async () => ngRes(408), async () => ngRes(499), async () => ngRes(409), async () => ngRes(500), async () => ngRes(503),
    async () => ({ ok: false, text: async () => "" }), async () => { throw new Error("ECONNRESET"); }]) {
    const { d, calls } = deps({ post });
    await rejectsWith(runCaseMail(d), "internal");
    assert.ok(!calls.some((c) => c.startsWith("record")));
  }
});

await ta("対応記録が止まり続けたら打ち切って recordError（関数のタイムアウト＝送れたか不明にしない）。既定は15秒", async () => {
  assert.equal(RECORD_TIMEOUT_MS, 15000);
  const { d, calls } = deps({ record: () => new Promise(() => {}), recordTimeoutMs: 30 });
  const t0 = Date.now();
  const r = await runCaseMail(d);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.sent, true); assert.equal(r.sentAt, NOW.toISOString());
  assert.match(r.recordError, /^対応記録の書き込みに失敗しました（deadline-exceeded: 対応記録の書き込みが0秒で終わりませんでした）$/);
  assert.ok(!calls.includes("touch"));
  // 更新日時が止まり続けても打ち切り、recordError にはしない
  const x = deps({ touch: () => new Promise(() => {}), recordTimeoutMs: 30 });
  const r2 = await runCaseMail(x.d);
  assert.equal(r2.recordError, undefined);
  // 時間内に終われば打ち切らない（タイマーが残って node が止まらない、ということもない）
  const y = deps({ record: () => new Promise((ok) => setTimeout(ok, 5)), recordTimeoutMs: 200 });
  assert.equal((await runCaseMail(y.d)).recordError, undefined);
});

await ta("shortReason: code を前に付け、長い文は切る", async () => {
  assert.equal(shortReason(Object.assign(new Error("x"), { code: "aborted" })), "aborted: x");
  assert.equal(shortReason(new Error("a\n  b")), "a b");
  assert.equal(shortReason(new Error("y".repeat(300))).length, 121);
});

await ta("結線: sendCaseEmail は runCaseMail を通し、CaseMailError の code をそのまま HttpsError にする", async () => {
  const i = indexSrc.indexOf("exports.sendCaseEmail = onCall(");
  const j = indexSrc.indexOf("exports.sendSupplierOrder = onCall(");
  const fn = indexSrc.slice(i, j);
  assert.ok(indexSrc.includes('const CaseMail = require("./case-mail");'));
  assert.ok(fn.includes("return await CaseMail.runCaseMail({"));
  assert.ok(fn.includes("if (e instanceof CaseMail.CaseMailError) throw new HttpsError(e.code, e.message);"));
  // 送信前の検証は今までどおり（宛先・件名・本文・形式・認可）
  assert.ok(fn.indexOf('requireStaff(request, { allow: "editor" })') < fn.indexOf("runCaseMail"));
  assert.ok(fn.indexOf('"宛先・件名・本文は必須です"') < fn.indexOf("runCaseMail"));
  // 対応記録の書式は変えない（画面の点検3・record-gaps.js が合わせている）
  assert.ok(fn.includes('type: "gmail_sent"'));
  assert.ok(fn.includes("subject: `メール送信: ${subject}`, body: `宛先: ${to}\\n\\n${body}`"));
  // 送信後に Firestore を直接 await していない（記録は record / touch の中だけ）
  assert.equal((fn.match(/await db\./g) || []).length, 0);
});

console.log(`合計: ${n}/${n} 合格（test-case-mail）`);
