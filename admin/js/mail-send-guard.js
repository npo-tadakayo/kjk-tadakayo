// 案件のメール送信モーダル（承諾書の署名依頼・事前準備のご案内）の「送信 → 記録」を二重送信させずに結ぶ（2026-11-10・点検4／PR #61 レビュー 中-A・中-B・低-C・低-D、再レビュー 中-1・中-2・低-1）。
// 判定・文言・sessionStorage の読み書きは record-gaps-case.js（node でテスト）。ここは画面の結線だけで、sessionStorage を直接触らない。
//
// ・送信の失敗: 明確な失敗は「送信に失敗しました」。送れたか不明（internal・タイムアウト等）は、次に送る前に確認を1回はさむ
//   （「送れたか不明」の印は sessionStorage にも持つので、再読み込みしても確認が出る）
// ・送信済み・記録だけ失敗: 記録待ちを sessionStorage に持ち、ボタンを「記録だけやり直す」に。閉じても・再読み込みしても
//   開き直せば記録だけやり直す状態で開く。送信を始めてから記録が済むまで、ページを離れるときに確認（beforeunload）
// ・送信中は「×」「キャンセル」を押せない
// ・記録に書く送信日時は、送信が成功した時点の値（やり直しでも同じ）
// ・承諾書の依頼ID（署名ページの URL の鍵）は sessionStorage に入れない。照合用の印 reqKey だけを入れ、
//   画面が読み込んでいる未署名の依頼から同じ印を計算して書き込み先を決める（見つからなければ記録待ちを消して知らせる）。
//   照合はモーダルを開いたときと、承諾書カードを読み込んだとき（reconcilePending）の両方で行う
// ・送信の返事（2026-11-12・点検4 の根本対応）: 新しい sendCaseEmail は、送信後にサーバーで対応記録が書けなくても
//   { ok:true, sent:true, sentAt, recordError } を返す（sendResultOf で読む）。recordError があれば「送信済み・記録だけ失敗」として
//   再送させず、対応記録（gmail_sent）を画面から足す（o.logActivity）。sentAt があれば記録に書く送信日時はサーバーの時刻。
//   古い Functions（sentAt・recordError が無い）では今までどおり端末の時刻を使い、対応記録はサーバーが書いた前提
// import は相対パス（ブラウザでは /js/ 配下として、node のテストでもそのまま読める）

import {
  classifySendOutcome, recordRetryFailedText, RECORD_RETRY_LABEL, CLOSE_WITH_PENDING_RECORD_TEXT,
  RESEND_AFTER_UNKNOWN_CONFIRM_TEXT, savePending, loadPending, clearPending,
  reqKeyOf, matchPendingReq, PENDING_TARGET_MISSING_TEXT,
  markSendUnknown, isSendUnknown, clearSendUnknown,
  sendResultOf, caseMailActivityOf,
} from "./record-gaps-case.js";

// 送った件名・本文（対応記録を画面から足すときに使う）。同じページの中だけに持ち、sessionStorage には入れない
const drafts = new Map();

// 送信中・記録待ちの間だけ beforeunload を付ける（種類＋案件IDごと）
const unloadGuards = new Set();
function onBeforeUnload(e) { e.preventDefault(); e.returnValue = ""; return ""; }
function setUnloadGuard(key, on) {
  const had = unloadGuards.size > 0;
  if (on) unloadGuards.add(key); else unloadGuards.delete(key);
  const has = unloadGuards.size > 0;
  if (has && !had) window.addEventListener("beforeunload", onBeforeUnload);
  if (!has && had) window.removeEventListener("beforeunload", onBeforeUnload);
}

/** 記録待ちがあれば beforeunload を付け直す（ページを開いたとき） */
export function restoreUnloadGuard(kind, caseId) {
  if (loadPending(kind, caseId)) setUnloadGuard(`${kind}:${caseId}`, true);
}

/**
 * 記録待ちを照合する（承諾書は書き込み先の依頼を、未署名の候補から印で探す）。
 * モーダルを開いたとき（bindMailSend）と、承諾書カードを読み込んだとき（consent-admin.js の reload）の両方から呼ぶ。
 * 承諾書で一致が無ければ（署名済み・取り消し済み）、記録待ちを消して beforeunload を外し、次の送信の前に確認をはさむ印を付ける。
 * @returns {Promise<{state:"none"|"matched"|"released", pending?:object, targetReqId?:string}>}
 */
export async function reconcilePending(kind, caseId, candidateReqIds) {
  const key = `${kind}:${caseId}`;
  const p0 = loadPending(kind, caseId);
  if (!p0) return { state: "none" };
  if (kind !== "consent") { setUnloadGuard(key, true); return { state: "matched", pending: p0, targetReqId: "" }; }
  let found = null;
  try { found = await matchPendingReq(p0, candidateReqIds || []); } catch { found = null; }
  if (!found) {
    clearPending(kind, caseId);
    setUnloadGuard(key, false);
    markSendUnknown(kind, caseId); // 送れたかどうかは対応記録で確かめてもらう
    return { state: "released" };
  }
  setUnloadGuard(key, true);
  return { state: "matched", pending: p0, targetReqId: found };
}

/**
 * @param {object} o
 * @param {"consent"|"preGuide"} o.kind
 * @param {string} o.caseId
 * @param {string} [o.reqId]            承諾書: いま送ろうとしている依頼ID（同じページのモジュール変数にだけ持つ）
 * @param {string[]} [o.candidateReqIds] 承諾書: 画面が読み込んでいるこの案件の未署名の依頼ID（記録待ちの書き込み先の照合に使う）
 * @param {HTMLElement} o.host          モーダルの器（閉じるときに空にする）
 * @param {{close:string, cancel:string, send:string, fields:string[]}} o.ids
 * @param {() => ({to:string, subject:string, body:string}|null)} o.readInputs  入力が足りなければ null（alert は呼び出し側）
 * @param {(p:{to:string, subject:string, body:string}) => Promise<unknown>} o.send
 * @param {(to:string, sentAtIso:string, reqId?:string) => Promise<unknown>} o.record  reqId は承諾書の書き込み先
 * @param {(act:object, sentAtIso:string) => Promise<unknown>} [o.logActivity]
 *        サーバーが対応記録を書けなかったとき（返事の recordError）に、対応記録を1件足す（act は caseMailActivityOf の形）
 * @param {(close:() => void) => (void|Promise<void>)} o.onDone   記録まで済んだあと（トースト・再描画。閉じるのはここで行う）
 */
export function bindMailSend(o) {
  const key = `${o.kind}:${o.caseId}`;
  const $ = (id) => document.getElementById(id);
  const btnSend = $(o.ids.send), btnClose = $(o.ids.close), btnCancel = $(o.ids.cancel);
  let busy = false;
  let pending = null;       // 記録待ち（{to, sentAt, reqId?, reqKey?, tl?}）tl＝対応記録もまだ
  let targetReqId = "";     // 承諾書: 記録の書き込み先（照合して決まった依頼ID）

  const setBusy = (b) => {
    busy = b;
    btnSend.disabled = b;
    if (btnClose) btnClose.disabled = b;
    if (btnCancel) btnCancel.disabled = b;
  };
  const showRetry = () => {
    o.ids.fields.forEach((id) => { const el = $(id); if (el) el.disabled = true; });
    if (pending?.to && $(o.ids.fields[0])) $(o.ids.fields[0]).value = pending.to;
    btnSend.innerHTML = `<i class="ti ti-refresh" aria-hidden="true"></i> ${RECORD_RETRY_LABEL}`;
  };
  const close = () => {
    if (busy) return;
    if (pending && !confirm(CLOSE_WITH_PENDING_RECORD_TEXT)) return;
    o.host.innerHTML = "";
  };
  // 記録: 対応記録がまだなら先に足し（足せたら tl を外して保存し直す＝やり直しで二重に足さない）、そのあと mailedAt 等
  const doRecord = async (to, sentAt) => {
    if (pending?.tl && o.logActivity) {
      const d = drafts.get(key) || {};
      await o.logActivity(caseMailActivityOf({ kind: o.kind, caseId: o.caseId, to, subject: d.subject, body: d.body }), sentAt);
      const { tl: _done, ...rest } = pending;
      pending = savePending(o.kind, o.caseId, rest) || rest;
    }
    await o.record(to, sentAt, targetReqId || undefined);
  };
  const finish = async () => {
    drafts.delete(key);
    clearPending(o.kind, o.caseId);
    setUnloadGuard(key, false);
    pending = null;
    await o.onDone(close);
  };

  btnClose?.addEventListener("click", close);
  btnCancel?.addEventListener("click", close);

  // 開いたとき: 記録待ちがあれば、最初から「記録だけやり直す」。承諾書は書き込み先の依頼を照合してから。
  // 照合が終わるまでは busy（送信ボタン・×・キャンセルを押せない）
  setBusy(true);
  const ready = (async () => {
    let r = { state: "none" };
    try { r = await reconcilePending(o.kind, o.caseId, o.candidateReqIds); } catch { r = { state: "none" }; }
    setBusy(false);
    if (r.state === "released") { alert(PENDING_TARGET_MISSING_TEXT); return; }
    if (r.state === "matched") {
      pending = r.pending;
      targetReqId = r.targetReqId || "";
      showRetry();
    }
  })();

  btnSend.addEventListener("click", async () => {
    await ready; // 照合が終わる前に押されたら、終わるのを待ってから（続けて押されても、先頭の1回だけが進む）
    if (busy) return;
    if (pending) { // 送信済み・記録待ち: 記録だけやり直す（メールは送らない・送信日時は最初の値）
      setBusy(true);
      try { await doRecord(pending.to, pending.sentAt); }
      catch (err) { alert(recordRetryFailedText(err)); setBusy(false); return; }
      setBusy(false);
      await finish();
      return;
    }
    const p = o.readInputs();
    if (!p) return;
    if (isSendUnknown(o.kind, o.caseId)) {
      if (!confirm(RESEND_AFTER_UNKNOWN_CONFIRM_TEXT)) return;
      clearSendUnknown(o.kind, o.caseId); // 確認のうえ送り直す
    }
    setBusy(true);
    setUnloadGuard(key, true); // 送信を始めた時点から（失敗したら外す）
    let res;
    try {
      res = await o.send(p);
    } catch (err) {
      const out = classifySendOutcome({ sendError: err });
      if (out.confirmBeforeResend) markSendUnknown(o.kind, o.caseId); else clearSendUnknown(o.kind, o.caseId);
      setUnloadGuard(key, false);
      setBusy(false);
      alert(out.message);
      return;
    }
    clearSendUnknown(o.kind, o.caseId);
    const srv = sendResultOf(res);
    // 送信が成功した時点（やり直しでも同じ値を書く）。新しい Functions はサーバーの時刻、古い Functions は端末の時刻
    const sentAt = srv.sentAt || new Date().toISOString();
    targetReqId = o.reqId || "";
    drafts.set(key, { subject: p.subject, body: p.body });
    // 送信成功の直後、印の計算を待たずに記録待ちへ（承諾書は依頼IDがあり印が無いので、この時点ではモジュール変数だけ）
    // サーバーが対応記録を書けなかった（recordError）ときは tl を付け、記録の段で画面から足す
    const v = { to: p.to, sentAt, ...(o.reqId ? { reqId: o.reqId } : {}), ...(srv.recordError ? { tl: true } : {}) };
    pending = savePending(o.kind, o.caseId, v) || v; // 保存できなくても、このモーダルでは再送させない
    // 承諾書は依頼IDの印（reqKey）ができてから sessionStorage へ（依頼IDそのものは入れない）
    if (o.reqId) {
      const reqKey = await reqKeyOf(o.reqId);
      if (reqKey) pending = savePending(o.kind, o.caseId, { ...v, reqKey }) || pending;
    }
    try {
      await doRecord(p.to, sentAt);
    } catch (err) {
      setBusy(false);
      showRetry();
      alert(classifySendOutcome({ recordError: err }).message);
      return;
    }
    setBusy(false);
    await finish();
  });
}
