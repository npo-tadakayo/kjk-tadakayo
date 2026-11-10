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
  reqKeyOf, matchPendingReq, PENDING_TARGET_MISSING_TEXT, PENDING_RELEASED_CARD_TEXT,
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
t("結線: mail-send-guard.js（sessionStorage を直接触らない・照合は reconcilePending に1本化）", () => {
  const g = src("mail-send-guard.js");
  assert.match(g, /from "\.\/record-gaps-case\.js"/); // 相対パス（node のテストでもそのまま読める）
  const code = g.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // コメントを除いたコード
  assert.ok(!/sessionStorage|setItem|getItem|removeItem/.test(code), "mail-send-guard.js が sessionStorage に直接触れている");
  assert.match(g, /export async function reconcilePending\(kind, caseId, candidateReqIds\)/);
  assert.ok(g.includes("r = await reconcilePending(o.kind, o.caseId, o.candidateReqIds)"));
  assert.ok(!g.includes("unknownSent"), "「送れたか不明」をモジュール変数だけで持っている");
});

// ===== 再レビュー: bindMailSend を偽の DOM で実際に動かす =====
// 依存は増やさない。document・window・sessionStorage・alert・confirm を最小の代役にする。
// 再読み込みは「mail-send-guard.js を ?v=N で読み直す＋ record-gaps-case.js のモジュール変数を空にする（sessionStorage は残す）」で表す
const env = (() => {
  const store = new Map();
  const els = new Map();
  const winLs = new Set();
  const log = [];
  let confirmAns = true;
  let ver = 0;
  const mkEl = (id) => {
    const ls = [];
    const el = { id, disabled: false, value: "", innerHTML: "",
      addEventListener: (_t, f) => ls.push(f),
      click: () => Promise.all(ls.map((f) => f({ target: el, currentTarget: el }))) };
    els.set(id, el);
    return el;
  };
  const install = () => {
    globalThis.sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    globalThis.document = { getElementById: (id) => els.get(id) || null };
    globalThis.window = { addEventListener: (_t, f) => winLs.add(f), removeEventListener: (_t, f) => winLs.delete(f) };
    globalThis.alert = (m) => log.push("ALERT:" + String(m).split("\n")[0]);
    globalThis.confirm = (m) => { log.push("CONFIRM:" + String(m).split("\n")[0]); return confirmAns; };
  };
  return {
    store, els, winLs, log,
    set confirmAns(v) { confirmAns = v; },
    async fresh() { // 新しいページ（sessionStorage も空）
      install(); store.clear(); winLs.clear(); log.length = 0; confirmAns = true;
      _resetPendingMemory();
      return import(`../admin/js/mail-send-guard.js?v=${++ver}`);
    },
    async reload() { // 再読み込み（sessionStorage は残る）
      _resetPendingMemory(); winLs.clear(); log.length = 0;
      return import(`../admin/js/mail-send-guard.js?v=${++ver}`);
    },
    open(guard, { kind = "consent", caseId = "C1", reqId = "REQ_A", cands = ["REQ_A"], send, record } = {}) {
      els.clear();
      ["close", "cancel", "send", "to", "subject", "body"].forEach(mkEl);
      els.get("to").value = "x@example.com";
      const host = { innerHTML: "MODAL" };
      const calls = { send: 0, record: [] };
      guard.bindMailSend({
        kind, caseId, reqId: kind === "consent" ? reqId : undefined, candidateReqIds: cands, host,
        ids: { close: "close", cancel: "cancel", send: "send", fields: ["to", "subject", "body"] },
        readInputs: () => ({ to: els.get("to").value, subject: "s", body: "b" }),
        send: async (p) => { calls.send++; return send ? send(p) : undefined; },
        record: async (to, sentAt, rid) => { calls.record.push([to, sentAt, rid]); return record ? record() : undefined; },
        onDone: (close) => close(),
      });
      return { host, calls };
    },
    click: (id) => els.get(id).click(),
  };
})();
const tick = () => new Promise((r) => setTimeout(r, 15));
const recFail = () => { throw new Error("rec fail"); };
const AMB = () => Object.assign(new Error("INTERNAL"), { code: "functions/internal" });

ta("動かす: 送信OK・記録NG → 再読み込み → 照合が終わる前に続けて押しても、送信0回・記録1回（送信日時は最初の値）", async () => {
  let guard = await env.fresh();
  let m = env.open(guard, { record: recFail });
  await env.click("send"); await tick();
  assert.equal(m.calls.send, 1);
  const sent1 = m.calls.record[0][1];
  guard = await env.reload();
  guard.restoreUnloadGuard("consent", "C1");
  assert.equal(env.winLs.size, 1, "再読み込み後に beforeunload が付いていない");
  m = env.open(guard, {});
  await Promise.all([env.click("send"), env.click("send"), env.click("send")]);
  await tick();
  assert.equal(m.calls.send, 0);
  assert.equal(m.calls.record.length, 1);
  assert.deepEqual(m.calls.record[0], ["x@example.com", sent1, "REQ_A"]);
  assert.equal(env.winLs.size, 0, "記録が済んでも beforeunload が外れていない");
  assert.equal(env.store.size, 0, "記録が済んでも記録待ちが残っている");
});

ta("動かす: 照合が一致しなかったあとの送信は確認つきで、キャンセルすると送信0回（再読み込みしても）", async () => {
  let guard = await env.fresh();
  env.open(guard, { record: recFail });
  await env.click("send"); await tick();
  guard = await env.reload();
  let m = env.open(guard, { reqId: "REQ_B", cands: ["REQ_B"] }); // 前の依頼は取り消し・作り直し
  await tick();
  assert.ok(env.log.some((l) => l.startsWith("ALERT:前回メールを送った承諾書の依頼が見つかりません")));
  assert.ok(![...env.store.keys()].some((k) => k.startsWith("kjk.mailRecordPending.")), "記録待ちが消えていない");
  assert.equal(env.winLs.size, 0);
  env.confirmAns = false;
  await env.click("send"); await tick();
  assert.equal(m.calls.send, 0);
  assert.ok(env.log.some((l) => l.startsWith("CONFIRM:前回の送信は、送れたかどうか確認できませんでした")));
  // 再読み込みしても、まだ確認が出る（中-2）
  guard = await env.reload();
  env.confirmAns = false;
  m = env.open(guard, { reqId: "REQ_B", cands: ["REQ_B"] });
  await env.click("send"); await tick();
  assert.equal(m.calls.send, 0);
  // 確認のうえ送ると1回だけ送り、不明の印は消える
  env.confirmAns = true;
  await env.click("send"); await tick();
  assert.equal(m.calls.send, 1);
  assert.equal(env.store.size, 0);
});

ta("動かす: 送信中に押す・閉じるでは、送信は1回だけでモーダルも閉じない。送信中は beforeunload が付く", async () => {
  const guard = await env.fresh();
  let release; const gate = new Promise((r) => (release = r));
  const m = env.open(guard, { kind: "preGuide", send: () => gate });
  await tick();
  const p1 = env.click("send"); await tick();
  assert.equal(env.winLs.size, 1, "送信を始めた時点で beforeunload が付いていない（低-1）");
  assert.equal(env.els.get("close").disabled, true);
  assert.equal(env.els.get("cancel").disabled, true);
  await env.click("send"); await env.click("close"); await env.click("cancel");
  assert.equal(m.calls.send, 1);
  assert.equal(m.host.innerHTML, "MODAL");
  release(); await p1; await tick();
  assert.equal(m.calls.record.length, 1);
  assert.equal(env.winLs.size, 0);
  assert.equal(m.host.innerHTML, ""); // 記録まで済んで閉じた
});

ta("動かす: 送信の失敗で beforeunload が外れる。送れたか不明の印は \"1\" だけ、再読み込み後も確認が出る（中-2）", async () => {
  let guard = await env.fresh();
  let m = env.open(guard, { kind: "preGuide", caseId: "C7", send: () => { throw AMB(); } });
  await tick();
  await env.click("send"); await tick();
  assert.equal(env.winLs.size, 0);
  assert.deepEqual([...env.store.entries()], [["kjk.mailUnknown.preGuide.C7", "1"]]);
  guard = await env.reload();
  env.confirmAns = false;
  m = env.open(guard, { kind: "preGuide", caseId: "C7" });
  await env.click("send"); await tick();
  assert.equal(m.calls.send, 0, "再読み込み後に確認なしで送れてしまう");
  assert.ok(env.log.some((l) => l.startsWith("CONFIRM:前回の送信は")));
  // 明確な失敗なら印は付かない
  guard = await env.fresh();
  m = env.open(guard, { kind: "preGuide", caseId: "C8", send: () => { throw Object.assign(new Error("x"), { code: "functions/invalid-argument" }); } });
  await tick(); await env.click("send"); await tick();
  assert.equal(env.store.size, 0);
});

ta("動かす: 保存される値は、記録待ち＝to・sentAt・reqKey だけ（依頼IDの生の値なし）", async () => {
  const guard = await env.fresh();
  env.open(guard, { reqId: "tok_secret_REQ_A", cands: ["tok_secret_REQ_A"], record: recFail });
  await tick(); await env.click("send"); await tick();
  const vals = [...env.store.values()];
  assert.equal(vals.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(vals[0])).sort(), ["reqKey", "sentAt", "to"]);
  assert.ok(!vals[0].includes("tok_secret_REQ_A"));
  assert.ok(!vals[0].includes("本文") && !vals[0].includes("\"b\""));
});

ta("動かす: 中-1 署名済み・取り消し済みでモーダルを開けなくても、カードの読み込み（reconcilePending）で記録待ちとキーが消え、beforeunload も外れる", async () => {
  let guard = await env.fresh();
  env.open(guard, { record: recFail });
  await tick(); await env.click("send"); await tick();
  guard = await env.reload();
  guard.restoreUnloadGuard("consent", "C1"); // initConsentCard
  assert.equal(env.winLs.size, 1);
  // 事業所が署名した＝未署名の候補に一致が無い
  const r = await guard.reconcilePending("consent", "C1", []);
  assert.equal(r.state, "released");
  assert.ok(![...env.store.keys()].some((k) => k.startsWith("kjk.mailRecordPending.")));
  assert.equal(env.winLs.size, 0, "解除しても beforeunload が残っている");
  // 次の送信の前には確認をはさむ（送れたかどうかは対応記録で確かめる）
  assert.equal(env.store.get("kjk.mailUnknown.consent.C1"), "1");
  assert.match(PENDING_RELEASED_CARD_TEXT, /署名済み・取り消し済みのため、記録待ちを解除しました/);
  // 一致する依頼があれば消さない
  guard = await env.fresh();
  env.open(guard, { record: recFail });
  await tick(); await env.click("send"); await tick();
  guard = await env.reload();
  const r2 = await guard.reconcilePending("consent", "C1", ["REQ_A"]);
  assert.equal(r2.state, "matched");
  assert.equal(r2.targetReqId, "REQ_A");
  assert.equal(env.winLs.size, 1);
});

for (const [file, kind, btnId] of [["consent-admin.js", "consent", "consentMailSend"], ["pre-guide.js", "preGuide", "pgSend"]]) {
  t(`結線: ${file} は bindMailSend を使い、自分ではまとめて送らない`, () => {
    const s = src(file);
    assert.match(s, /import \{ bindMailSend, restoreUnloadGuard(, reconcilePending)? \} from "\/js\/mail-send-guard\.js"/);
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
  assert.ok(ca.includes('return requests.filter((x) => x.status === "pending").map((x) => x._id);'));
  assert.ok(ca.includes("candidateReqIds: pendingReqIds(),"));
  // 中-1: カードの読み込みでも照合し、解除したら1行で知らせる
  const rl = ca.slice(ca.indexOf("async function reload()"), ca.indexOf("function pendingReqIds()"));
  assert.ok(rl.indexOf('reconcilePending("consent", ctx.caseId, pendingReqIds())') < rl.indexOf("render();"));
  assert.ok(rl.includes("pendingNotice = PENDING_RELEASED_CARD_TEXT"));
  assert.ok(ca.includes("${esc(pendingNotice)}"));
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
