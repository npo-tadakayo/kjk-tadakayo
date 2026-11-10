// 記録のずれ（設計書 §3 点検4・点検5）の判定（admin/js/record-gaps-case.js）と結線のテスト。
// node scripts/test-record-gaps-case.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  classifySendOutcome, recordRetryFailedText, RECORD_RETRY_LABEL, CLOSE_WITH_PENDING_RECORD_TEXT,
  SUPPORT_DONE_STATUS, shouldAskSupportDone, supportDoneAskText,
  errorCodeOf, isAmbiguousSendError, RESEND_AFTER_UNKNOWN_CONFIRM_TEXT,
  pendingKey, savePending, loadPending, clearPending, _resetPendingMemory, jstDateOf,
  reqKeyOf, matchPendingReq, PENDING_TARGET_MISSING_TEXT,
} from "../admin/js/record-gaps-case.js";
import { STATUS_LABELS, LOST, STATUS_ORDER } from "../admin/js/constants.js";
import { SUPPORT_DONE } from "../admin/js/screen-rules.js";

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

// ===== レビュー 中-A: 送れたかどうか分からないエラー =====
const fnErr = (code, message = "x") => Object.assign(new Error(message), { code });

t("internal／deadline-exceeded／unavailable／unknown は「送れたか不明」（functions/ 接頭辞つきも）", () => {
  for (const c of ["internal", "deadline-exceeded", "unavailable", "unknown",
    "functions/internal", "functions/deadline-exceeded", "functions/unavailable", "functions/unknown"]) {
    const o = classifySendOutcome({ sendError: fnErr(c, "送信処理に失敗しました: boom") });
    assert.equal(o.kind, "send_unknown", c);
    assert.equal(o.canResend, true);
    assert.equal(o.confirmBeforeResend, true);
    assert.match(o.message, /^送れたかどうか確認できませんでした/);
    assert.match(o.message, /対応記録に「メール送信」の行が出ていないか確かめてから、もう一度送ってください/);
    assert.ok(!o.message.includes("送信に失敗しました:"), c); // 「失敗」と言い切らない（理由の文には含まれうるので先頭で判定）
    assert.equal(isAmbiguousSendError(fnErr(c)), true);
  }
});

t("明確な失敗（invalid-argument・permission-denied・unauthenticated・failed-precondition 等）は「送信に失敗しました」のまま", () => {
  for (const c of ["invalid-argument", "permission-denied", "unauthenticated", "failed-precondition",
    "functions/invalid-argument", "functions/permission-denied", "not-found", "resource-exhausted"]) {
    const o = classifySendOutcome({ sendError: fnErr(c, "だめ") });
    assert.equal(o.kind, "send_failed", c);
    assert.equal(o.confirmBeforeResend, false);
    assert.equal(o.message, "送信に失敗しました: だめ");
  }
  // code の無いエラー（入力チェックなど）も明確な失敗
  assert.equal(classifySendOutcome({ sendError: new Error("q") }).kind, "send_failed");
  assert.equal(errorCodeOf(fnErr("functions/internal")), "internal");
  assert.equal(errorCodeOf(null), "");
  assert.match(RESEND_AFTER_UNKNOWN_CONFIRM_TEXT, /すでに送られているかもしれません/);
  assert.match(RESEND_AFTER_UNKNOWN_CONFIRM_TEXT, /対応記録/);
});

// ===== レビュー 中-B・低-D・追加修正: 記録待ちの保存・復元・消去（依頼IDは sessionStorage に入れない） =====
const fakeStorage = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("x"); } };
const SENT = "2026-11-10T02:30:00.000Z";
const REQ = "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0"; // 署名ページの URL の鍵に当たる値（テスト用の架空の値）
const allStored = (st) => [...st.m.values()].join("\n");

t("キーは種類＋案件ID・知らない種類は例外", () => {
  assert.equal(pendingKey("consent", "C1"), "kjk.mailRecordPending.consent.C1");
  assert.equal(pendingKey("preGuide", "C1"), "kjk.mailRecordPending.preGuide.C1");
  assert.throws(() => pendingKey("invoice", "C1"));
});

const asyncTests = [];
const ta = (name, fn) => asyncTests.push([name, fn]);

ta("印 reqKey は SHA-256 の16進の先頭16文字（依頼IDそのものではない）", async () => {
  const k = await reqKeyOf(REQ);
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(k, createHash("sha256").update(REQ).digest("hex").slice(0, 16));
  assert.ok(!REQ.includes(k));
  assert.equal(await reqKeyOf(REQ), k); // 同じ値なら同じ印
  assert.notEqual(await reqKeyOf(REQ + "x"), k);
});

ta("保存した JSON に依頼IDの生の値が含まれない（宛先・送信日時・reqKey だけ）", async () => {
  _resetPendingMemory();
  const st = fakeStorage();
  const reqKey = await reqKeyOf(REQ);
  const mem = savePending("consent", "C1", { to: "a@example.com", sentAt: SENT, reqId: REQ, reqKey, body: "本文", name: "氏名" }, st);
  assert.equal(mem.reqId, REQ); // 同じページの中（モジュール変数）には持つ
  const raw = st.getItem(pendingKey("consent", "C1"));
  assert.ok(!raw.includes(REQ), "依頼IDの生の値が sessionStorage に入っている");
  assert.ok(!allStored(st).includes(REQ));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["reqKey", "sentAt", "to"]);
  assert.ok(!raw.includes("本文") && !raw.includes("氏名"));
});

ta("再読み込み後: 印が一致する依頼があれば復元される（書き込み先はその依頼）", async () => {
  _resetPendingMemory();
  const st = fakeStorage();
  savePending("consent", "C1", { to: "a@example.com", sentAt: SENT, reqId: REQ, reqKey: await reqKeyOf(REQ) }, st);
  _resetPendingMemory(); // 再読み込み＝モジュール変数が空
  const p = loadPending("consent", "C1", st);
  assert.deepEqual(p, { to: "a@example.com", sentAt: SENT, reqKey: await reqKeyOf(REQ) });
  assert.equal(await matchPendingReq(p, ["other_req", REQ]), REQ);
  // 送信日時は最初の値のまま（承諾書の mailedAt に書く値）
  assert.equal(p.sentAt, SENT);
});

ta("印が一致する依頼が無ければ復元しない（呼び出し側が記録待ちを消す）", async () => {
  _resetPendingMemory();
  const st = fakeStorage();
  savePending("consent", "C1", { to: "a@example.com", sentAt: SENT, reqId: REQ, reqKey: await reqKeyOf(REQ) }, st);
  _resetPendingMemory();
  const p = loadPending("consent", "C1", st);
  assert.equal(await matchPendingReq(p, ["other_req"]), null); // 取り消された・署名済みで候補から外れた
  assert.equal(await matchPendingReq(p, []), null);
  clearPending("consent", "C1", st);
  assert.equal(loadPending("consent", "C1", st), null);
  assert.equal(st.m.size, 0);
  // 同じページの中（reqId をモジュール変数に持つ）なら、ID そのものの一致で決まる
  _resetPendingMemory();
  const mem = savePending("consent", "C2", { to: "a@example.com", sentAt: SENT, reqId: REQ }, null);
  assert.equal(await matchPendingReq(mem, [REQ]), REQ);
  assert.equal(await matchPendingReq(mem, ["other_req"]), null);
  assert.equal(await matchPendingReq(null, [REQ]), null);
});

ta("crypto.subtle が無くても落ちない（印は作らず、sessionStorage にも書かずモジュール変数だけ）", async () => {
  _resetPendingMemory();
  assert.equal(await reqKeyOf(REQ, null), "");
  assert.equal(await reqKeyOf(REQ, { digest() { throw new Error("NotSupported"); } }), "");
  assert.equal(await reqKeyOf(REQ, {}), "");
  const st = fakeStorage();
  const mem = savePending("consent", "C3", { to: "a@example.com", sentAt: SENT, reqId: REQ, reqKey: "" }, st);
  assert.equal(st.m.size, 0, "印が無いのに sessionStorage へ書いている");
  assert.deepEqual(loadPending("consent", "C3", st), mem); // 同じページの中では効く
  assert.equal(await matchPendingReq(mem, [REQ], null), REQ);
  // 印しか無い記録待ちを、印を計算できない環境で照合しても落ちない（一致しない＝null）
  assert.equal(await matchPendingReq({ to: "a", sentAt: SENT, reqKey: "0123456789abcdef" }, [REQ], null), null);
});

t("古い形式（生の reqId 入り）を読むと捨てる", () => {
  _resetPendingMemory();
  const st = fakeStorage();
  st.setItem(pendingKey("consent", "C4"), JSON.stringify({ to: "a@example.com", sentAt: SENT, reqId: REQ }));
  assert.equal(loadPending("consent", "C4", st), null);
  assert.equal(st.m.size, 0, "古い形式が残っている");
  // 壊れた値も捨てる
  st.setItem(pendingKey("consent", "C4"), "{壊れ");
  assert.equal(loadPending("consent", "C4", st), null);
  assert.equal(st.m.size, 0);
});

t("事前案内: 保存 → 復元 → 消去（sessionStorage の代役）", () => {
  _resetPendingMemory();
  const st = fakeStorage();
  const v = savePending("preGuide", "C1", { to: "a@example.com", sentAt: SENT, body: "本文" }, st);
  assert.deepEqual(v, { to: "a@example.com", sentAt: SENT });
  assert.deepEqual(Object.keys(JSON.parse(st.getItem(pendingKey("preGuide", "C1")))).sort(), ["sentAt", "to"]);
  _resetPendingMemory();
  assert.deepEqual(loadPending("preGuide", "C1", st), { to: "a@example.com", sentAt: SENT });
  assert.equal(loadPending("consent", "C1", st), null);   // 種類が違えば別物
  assert.equal(loadPending("preGuide", "C2", st), null);  // 案件が違えば別物
  clearPending("preGuide", "C1", st);
  assert.equal(loadPending("preGuide", "C1", st), null);
  assert.equal(savePending("preGuide", "C1", { to: "a@example.com" }, st), null); // 送信日時が無いものは保存しない
});

t("sessionStorage が例外を投げても落ちず、モジュール変数で動く", () => {
  _resetPendingMemory();
  assert.doesNotThrow(() => savePending("preGuide", "C9", { to: "b@example.com", sentAt: SENT }, throwing));
  assert.deepEqual(loadPending("preGuide", "C9", throwing), { to: "b@example.com", sentAt: SENT });
  assert.doesNotThrow(() => clearPending("preGuide", "C9", throwing));
  assert.equal(loadPending("preGuide", "C9", throwing), null);
  savePending("consent", "C9", { to: "b@example.com", sentAt: SENT }, null);
  assert.equal(loadPending("consent", "C9", null).to, "b@example.com");
  _resetPendingMemory();
});

t("やり直しでも送信日時は最初の値のまま（事前案内の送付日は送信時の JST 日付）", () => {
  _resetPendingMemory();
  const st = fakeStorage();
  const sentAt = "2026-11-10T14:59:00.000Z"; // JST 11/10 23:59
  savePending("preGuide", "C1", { to: "a@example.com", sentAt }, st);
  _resetPendingMemory();
  assert.equal(loadPending("preGuide", "C1", st).sentAt, sentAt);
  assert.equal(jstDateOf(loadPending("preGuide", "C1", st).sentAt), "2026-11-10");
  assert.equal(jstDateOf("2026-11-10T15:00:00.000Z"), "2026-11-11");
  assert.match(PENDING_TARGET_MISSING_TEXT, /記録先が無い/);
  assert.match(PENDING_TARGET_MISSING_TEXT, /対応記録/);
});

// ===== 結線 =====
t("結線: mail-send-guard.js（送信と記録を分ける・記録待ち・送信中・送信日時）", () => {
  const g = src("mail-send-guard.js");
  assert.match(g, /from "\/js\/record-gaps-case\.js"/);
  const i = g.indexOf('btnSend.addEventListener("click"');
  assert.ok(i > 0);
  const h = g.slice(i);
  // 記録待ちのときはメールを送らず記録だけ（送信日時は最初の値）
  const retry = h.indexOf("if (pending)");
  const send = h.indexOf("await o.send(p)");
  assert.ok(retry > 0 && send > retry);
  assert.ok(!h.slice(retry, send).includes("o.send("), "記録だけやり直す分岐でメールを送っている");
  assert.ok(h.slice(retry, send).includes("o.record(pending.to, pending.sentAt, targetReqId || undefined)"));
  // 送れたか不明のあとは確認をはさむ
  assert.ok(h.indexOf("RESEND_AFTER_UNKNOWN_CONFIRM_TEXT") < send);
  assert.match(h, /classifySendOutcome\(\{ sendError: err \}\)/);
  assert.match(h, /classifySendOutcome\(\{ recordError: err \}\)/);
  // 送信成功 → 記録待ちを保存 → 記録。保存できなくても再送させない
  const save = h.indexOf("savePending(");
  assert.ok(send < save && save < h.indexOf("await o.record(p.to, sentAt, targetReqId || undefined)"));
  assert.ok(h.includes("|| v;"));
  // 記録が済んだら消し、beforeunload を外す
  assert.match(g, /clearPending\(o\.kind, o\.caseId\);\n\s*setUnloadGuard\(key, false\);/);
  assert.match(g, /addEventListener\("beforeunload", onBeforeUnload\)/);
  assert.match(g, /removeEventListener\("beforeunload", onBeforeUnload\)/);
  // 送信中は ×・キャンセルを押せない
  assert.match(g, /if \(btnClose\) btnClose\.disabled = b;/);
  assert.match(g, /if \(btnCancel\) btnCancel\.disabled = b;/);
  assert.match(g, /const close = \(\) => \{\n\s*if \(busy\) return;/);
  // 開いたとき記録待ちなら、最初から記録だけやり直す（承諾書は印で書き込み先を照合し、無ければ消して知らせ、次の送信は確認）
  const rd = g.slice(g.indexOf("const ready = (async () => {"), i);
  assert.ok(rd.includes("matchPendingReq(p0, o.candidateReqIds || [])"));
  assert.match(rd, /if \(!found\) \{[^}]*clearPending\(o\.kind, o\.caseId\);[^}]*unknownSent\.add\(key\);[^}]*alert\(PENDING_TARGET_MISSING_TEXT\);/s);
  assert.ok(rd.indexOf("targetReqId = found") < rd.indexOf("showRetry()"));
  assert.ok(h.startsWith('btnSend.addEventListener("click", async () => {\n    await ready;'));
  // 保存するのは印（reqKey）を作ってから。sessionStorage への書き込みは record-gaps-case.js の savePending だけ
  assert.ok(h.indexOf("await reqKeyOf(o.reqId)") < save);
  const code = g.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // コメントを除いたコード
  assert.ok(!/sessionStorage|setItem/.test(code), "mail-send-guard.js が sessionStorage に直接書いている");
});

for (const [file, kind, btnId] of [["consent-admin.js", "consent", "consentMailSend"], ["pre-guide.js", "preGuide", "pgSend"]]) {
  t(`結線: ${file} は bindMailSend を使い、自分ではまとめて送らない`, () => {
    const s = src(file);
    assert.match(s, /import \{ bindMailSend, restoreUnloadGuard \} from "\/js\/mail-send-guard\.js"/);
    assert.ok(s.includes(`kind: "${kind}", caseId: ctx.caseId`));
    assert.ok(s.includes(`send: "${btnId}"`));
    assert.ok(s.includes(`restoreUnloadGuard("${kind}", ctx.caseId)`));
    assert.ok(!s.includes("alert(`送信に失敗しました: ${err.message || err}`)"));
    assert.equal((s.match(/ctx\.sendMail\(/g) || []).length, 1);
  });
}
t("結線: 承諾書の mailedAt は送信時刻（serverTimestamp ではない）・事前案内は送信時の JST 日付", () => {
  const ca = src("consent-admin.js");
  assert.ok(ca.includes('updateDoc(doc(ctx.db, "consentRequests", reqId || r._id), { mailedAt: new Date(sentAtIso), mailedTo: to })'));
  assert.ok(ca.includes('candidateReqIds: requests.filter((x) => x.status === "pending").map((x) => x._id)'));
  assert.ok(src("pre-guide.js").includes("preGuideMailedAt: jstDateOf(sentAtIso)"));
});

// ===== 点検5: 伴走支援の記録を保存したとき「伴走支援実施済にしますか」 =====
t("SUPPORT_DONE_STATUS は constants.js の「伴走支援実施済」・screen-rules.js の SUPPORT_DONE と一致", () => {
  assert.equal(STATUS_LABELS[SUPPORT_DONE_STATUS], "伴走支援実施済");
  assert.equal(SUPPORT_DONE_STATUS, SUPPORT_DONE);
});

t("伴走支援実施済より前（新規受信〜伴走支援待ち）では聞く", () => {
  for (const s of [1, 2, 3, 5, 6, 7]) assert.equal(shouldAskSupportDone({ status: s }), true, `status ${s}`);
  assert.equal(shouldAskSupportDone({ status: "7" }), true);       // セレクトの文字列でもよい
  assert.equal(shouldAskSupportDone({ status: undefined }), true); // 状態なし＝新規受信
  // パイプライン順で 8 より前のものと一致（失注は末尾なので入らない）
  const before = STATUS_ORDER.slice(0, STATUS_ORDER.indexOf(8));
  assert.deepEqual(before, [1, 2, 3, 5, 6, 7]);
});

t("伴走支援実施済以降・完了・失注では聞かない", () => {
  for (const s of [8, 9, 10, 11, 12, 13]) assert.equal(shouldAskSupportDone({ status: s }), false, `status ${s}`);
  assert.equal(shouldAskSupportDone({ status: LOST }), false);
  assert.equal(shouldAskSupportDone({ status: 99 }), false); // 知らない値は聞かない
});

t("対象外（archived）・閲覧のみでは聞かない", () => {
  assert.equal(shouldAskSupportDone({ status: 7, archived: true }), false);
  assert.equal(shouldAskSupportDone({ status: 7, canChangeStatus: false }), false);
  assert.equal(shouldAskSupportDone(), true); // 引数なし＝新規受信・変更可
});

t("確認文に今の状態と変更先が入る", () => {
  const m = supportDoneAskText(7);
  assert.ok(m.includes("「伴走支援待ち」のまま"));
  assert.ok(m.includes("「伴走支援実施済」にしますか"));
  assert.ok(m.includes("キャンセルなら変えません"));
});

t("結線: case-detail.js は保存成功のあとだけ聞き、既存の状態変更の処理を通す", () => {
  const s = src("case-detail.js");
  assert.match(s, /import \{ shouldAskSupportDone, supportDoneAskText, SUPPORT_DONE_STATUS \} from "\/js\/record-gaps-case\.js"/);
  const a = s.indexOf("async function addSession(");
  const b = s.indexOf("\nfunction askSupportDone(", a);
  assert.ok(a > 0 && b > a);
  const body = s.slice(a, b);
  // 失敗したら聞かない（catch で return）。聞くのは finally のあと
  assert.match(body, /alert\(`記録に失敗しました: \$\{e\.message\}`\);\n\s*return;/);
  assert.ok(body.lastIndexOf("askSupportDone();") > body.indexOf("} finally {"));
  const ask = s.slice(b, b + 1200);
  assert.ok(ask.includes("shouldAskSupportDone({ status: currentCase.status, archived: !!currentCase.archived, canChangeStatus: canCopy })"));
  assert.ok(ask.includes("if (!confirm(supportDoneAskText(currentCase.status))) return;"));
  // 自分で書き込まない。ヘッダーの状態の選択に change を起こす（請求書の確認・対応記録は既存の処理に任せる）
  assert.ok(ask.includes('sel.dispatchEvent(new Event("change"))'));
  assert.ok(!/updateDoc|changeStatus\(/.test(ask.slice(0, ask.indexOf("dispatchEvent"))));
  // 既存の状態変更の処理は statusSelect の change で動いている
  assert.match(s, /getElementById\("statusSelect"\)\.addEventListener\("change", async \(e\) => \{/);
});

for (const [name, fn] of asyncTests) {
  try { await fn(); n++; } catch (e) { console.error(`✗ ${name}`); throw e; }
}

console.log(`OK test-record-gaps-case (${n} 件)`);
