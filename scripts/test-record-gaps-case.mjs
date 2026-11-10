// 記録のずれ（設計書 §3 点検4・点検5）の判定（admin/js/record-gaps.js）と結線のテスト。
// node scripts/test-record-gaps-case.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifySendOutcome, recordRetryFailedText, RECORD_RETRY_LABEL, CLOSE_WITH_PENDING_RECORD_TEXT,
} from "../admin/js/record-gaps.js";

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); throw e; }
};
const src = (p) => readFileSync(fileURLToPath(new URL(`../admin/js/${p}`, import.meta.url)), "utf8");

// ===== 点検4: 送信の成否と記録の成否を分ける =====
t("送信も記録も成功 → ok", () => {
  const o = classifySendOutcome({});
  assert.equal(o.kind, "ok"); assert.equal(o.message, "");
  assert.equal(classifySendOutcome().kind, "ok");
});

t("送信に失敗 → 送信に失敗しました（再送してよい）", () => {
  const o = classifySendOutcome({ sendError: new Error("quota") });
  assert.equal(o.kind, "send_failed");
  assert.equal(o.canResend, true);
  assert.equal(o.message, "送信に失敗しました: quota");
  // 文字列のエラーでも読める
  assert.equal(classifySendOutcome({ sendError: "x" }).message, "送信に失敗しました: x");
});

t("送信済み・記録だけ失敗 → 再送させない文言", () => {
  const o = classifySendOutcome({ recordError: new Error("permission-denied") });
  assert.equal(o.kind, "record_failed");
  assert.equal(o.canResend, false);
  assert.match(o.message, /^送信済みです。記録だけ失敗しました（再送しないでください）/);
  assert.match(o.message, /permission-denied/);
  assert.ok(o.message.includes(RECORD_RETRY_LABEL));
  assert.ok(!o.message.includes("送信に失敗しました"));
});

t("送信の失敗が先（送信に失敗したら記録はしていない）", () => {
  assert.equal(classifySendOutcome({ sendError: "a", recordError: "b" }).kind, "send_failed");
});

t("やり直しの失敗・閉じるときの確認も再送させない", () => {
  assert.match(recordRetryFailedText(new Error("offline")), /再送しないでください/);
  assert.match(recordRetryFailedText(new Error("offline")), /offline/);
  assert.match(CLOSE_WITH_PENDING_RECORD_TEXT, /再送しないでください/);
});

for (const [file, btnId, fields] of [
  ["consent-admin.js", "consentMailSend", ["cmTo", "cmSubject", "cmBody"]],
  ["pre-guide.js", "pgSend", ["pgTo", "pgSubject", "pgBody"]],
]) {
  t(`結線: ${file} は送信と記録を別の try に分けている`, () => {
    const s = src(file);
    assert.match(s, /import \{[^}]*classifySendOutcome[^}]*\} from "\/js\/record-gaps\.js"/);
    const i = s.indexOf(`getElementById("${btnId}")`);
    assert.ok(i > 0, "送信ボタンの処理が見つからない");
    const h = s.slice(i, i + 2500);
    // 記録待ちのときはメールを送らず記録だけ
    const retry = h.indexOf("if (sentTo)");
    const send = h.indexOf("await ctx.sendMail(");
    assert.ok(retry > 0 && send > retry, "記録だけやり直す分岐が送信より前にない");
    assert.ok(!h.slice(retry, send).includes("sendMail"), "記録だけやり直す分岐でメールを送っている");
    // 送信の catch は sendError、記録の catch は recordError
    assert.match(h, /classifySendOutcome\(\{ sendError: err \}\)/);
    assert.match(h, /classifySendOutcome\(\{ recordError: err \}\)/);
    assert.ok(h.indexOf("sendError") < h.indexOf("sentTo = to"), "送信成功の印より前に送信の失敗を処理していない");
    assert.ok(h.indexOf("sentTo = to") < h.indexOf("await record(to)"), "記録の前に送信済みの印を付けていない");
    // 記録だけ失敗したら、ボタンを「記録だけやり直す」にし、宛先・件名・本文を触れなくする
    assert.ok(h.includes("RECORD_RETRY_LABEL"));
    for (const f of fields) assert.ok(h.includes(`"${f}"`), `${f} を止めていない`);
    // 旧来の「送信も記録もまとめて送信に失敗」は残っていない
    assert.ok(!s.includes("alert(`送信に失敗しました: ${err.message || err}`)"));
    // 記録待ちのまま閉じるときは確認
    assert.match(s, /if \(sentTo && !confirm\(CLOSE_WITH_PENDING_RECORD_TEXT\)\) return;/);
  });
}

console.log(`OK test-record-gaps-case (${n} 件)`);
