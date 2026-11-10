// 案件のメール送信モーダル（承諾書の署名依頼・事前準備のご案内）の「送信 → 記録」を二重送信させずに結ぶ（2026-11-10・点検4／PR #61 レビュー 中-A・中-B・低-C・低-D）。
// 判定・文言・記録待ちの保存は record-gaps-case.js（node でテスト）。ここは画面の結線だけ。
//
// ・送信の失敗: 明確な失敗は「送信に失敗しました」。送れたか不明（internal・タイムアウト等）は、次に送る前に確認を1回はさむ
// ・送信済み・記録だけ失敗: 記録待ちを sessionStorage に持ち、ボタンを「記録だけやり直す」に。閉じても・再読み込みしても
//   開き直せば記録だけやり直す状態で開く。記録待ちの間はページを離れるときに確認（beforeunload）
// ・送信中は「×」「キャンセル」を押せない
// ・記録に書く送信日時は、送信が成功した時点の値（やり直しでも同じ）

import {
  classifySendOutcome, recordRetryFailedText, RECORD_RETRY_LABEL, CLOSE_WITH_PENDING_RECORD_TEXT,
  RESEND_AFTER_UNKNOWN_CONFIRM_TEXT, savePending, loadPending, clearPending,
} from "/js/record-gaps-case.js";

// 送れたか不明のあと、次に送る前に確認をはさむ印（種類＋案件ID）。モーダルを閉じても残す
const unknownSent = new Set();

// 記録待ちの間だけ beforeunload を付ける（種類＋案件IDごと）
const unloadGuards = new Set();
function onBeforeUnload(e) { e.preventDefault(); e.returnValue = ""; return ""; }
function setUnloadGuard(key, on) {
  const had = unloadGuards.size > 0;
  if (on) unloadGuards.add(key); else unloadGuards.delete(key);
  const has = unloadGuards.size > 0;
  if (has && !had) window.addEventListener("beforeunload", onBeforeUnload);
  if (!has && had) window.removeEventListener("beforeunload", onBeforeUnload);
}

/** 記録待ちがあれば beforeunload を付け直す（ページを開いたとき・モーダルを開いたとき） */
export function restoreUnloadGuard(kind, caseId) {
  if (loadPending(kind, caseId)) setUnloadGuard(`${kind}:${caseId}`, true);
}

/**
 * @param {object} o
 * @param {"consent"|"preGuide"} o.kind
 * @param {string} o.caseId
 * @param {string} [o.reqId]          承諾書の依頼ID（記録待ちがほかの依頼のものなら使わない）
 * @param {HTMLElement} o.host        モーダルの器（閉じるときに空にする）
 * @param {{close:string, cancel:string, send:string, fields:string[]}} o.ids
 * @param {() => ({to:string, subject:string, body:string}|null)} o.readInputs  入力が足りなければ null（alert は呼び出し側）
 * @param {(p:{to:string, subject:string, body:string}) => Promise<unknown>} o.send
 * @param {(to:string, sentAtIso:string) => Promise<unknown>} o.record
 * @param {() => (void|Promise<void>)} o.onDone   記録まで済んだあと（トースト・再描画。閉じるのはここで行う）
 */
export function bindMailSend(o) {
  const key = `${o.kind}:${o.caseId}`;
  const $ = (id) => document.getElementById(id);
  const btnSend = $(o.ids.send), btnClose = $(o.ids.close), btnCancel = $(o.ids.cancel);
  let busy = false;
  let pending = loadPending(o.kind, o.caseId);
  if (pending && o.reqId && pending.reqId && pending.reqId !== o.reqId) pending = null; // 別の依頼の記録待ちは使わない

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
  const finish = async () => {
    clearPending(o.kind, o.caseId);
    setUnloadGuard(key, false);
    pending = null;
    await o.onDone(close);
  };

  if (pending) { showRetry(); setUnloadGuard(key, true); }
  btnClose?.addEventListener("click", close);
  btnCancel?.addEventListener("click", close);
  btnSend.addEventListener("click", async () => {
    if (busy) return;
    if (pending) { // 送信済み・記録待ち: 記録だけやり直す（メールは送らない・送信日時は最初の値）
      setBusy(true);
      try { await o.record(pending.to, pending.sentAt); }
      catch (err) { alert(recordRetryFailedText(err)); setBusy(false); return; }
      setBusy(false);
      await finish();
      return;
    }
    const p = o.readInputs();
    if (!p) return;
    if (unknownSent.has(key) && !confirm(RESEND_AFTER_UNKNOWN_CONFIRM_TEXT)) return;
    setBusy(true);
    try {
      await o.send(p);
    } catch (err) {
      const out = classifySendOutcome({ sendError: err });
      if (out.confirmBeforeResend) unknownSent.add(key); else unknownSent.delete(key);
      setBusy(false);
      alert(out.message);
      return;
    }
    unknownSent.delete(key);
    const sentAt = new Date().toISOString(); // 送信が成功した時点（やり直しでも同じ値を書く）
    const v = { to: p.to, sentAt, ...(o.reqId ? { reqId: o.reqId } : {}) };
    pending = savePending(o.kind, o.caseId, v) || v; // 保存できなくても、このモーダルでは再送させない
    setUnloadGuard(key, true);
    try {
      await o.record(p.to, sentAt);
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
