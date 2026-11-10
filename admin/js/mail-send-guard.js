// 案件のメール送信モーダル（承諾書の署名依頼・事前準備のご案内）の「送信 → 記録」を二重送信させずに結ぶ（2026-11-10・点検4／PR #61 レビュー 中-A・中-B・低-C・低-D）。
// 判定・文言・記録待ちの保存は record-gaps-case.js（node でテスト）。ここは画面の結線だけ。
//
// ・送信の失敗: 明確な失敗は「送信に失敗しました」。送れたか不明（internal・タイムアウト等）は、次に送る前に確認を1回はさむ
// ・送信済み・記録だけ失敗: 記録待ちを sessionStorage に持ち、ボタンを「記録だけやり直す」に。閉じても・再読み込みしても
//   開き直せば記録だけやり直す状態で開く。記録待ちの間はページを離れるときに確認（beforeunload）
// ・送信中は「×」「キャンセル」を押せない
// ・記録に書く送信日時は、送信が成功した時点の値（やり直しでも同じ）
// ・承諾書の依頼ID（署名ページの URL の鍵）は sessionStorage に入れない。照合用の印 reqKey だけを入れ、開いたとき
//   画面が読み込んでいる未署名の依頼から同じ印を計算して書き込み先を決める（見つからなければ記録待ちを消して知らせる）

import {
  classifySendOutcome, recordRetryFailedText, RECORD_RETRY_LABEL, CLOSE_WITH_PENDING_RECORD_TEXT,
  RESEND_AFTER_UNKNOWN_CONFIRM_TEXT, savePending, loadPending, clearPending,
  reqKeyOf, matchPendingReq, PENDING_TARGET_MISSING_TEXT,
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
 * @param {string} [o.reqId]            承諾書: いま送ろうとしている依頼ID（同じページのモジュール変数にだけ持つ）
 * @param {string[]} [o.candidateReqIds] 承諾書: 画面が読み込んでいるこの案件の未署名の依頼ID（記録待ちの書き込み先の照合に使う）
 * @param {HTMLElement} o.host          モーダルの器（閉じるときに空にする）
 * @param {{close:string, cancel:string, send:string, fields:string[]}} o.ids
 * @param {() => ({to:string, subject:string, body:string}|null)} o.readInputs  入力が足りなければ null（alert は呼び出し側）
 * @param {(p:{to:string, subject:string, body:string}) => Promise<unknown>} o.send
 * @param {(to:string, sentAtIso:string, reqId?:string) => Promise<unknown>} o.record  reqId は承諾書の書き込み先
 * @param {(close:() => void) => (void|Promise<void>)} o.onDone   記録まで済んだあと（トースト・再描画。閉じるのはここで行う）
 */
export function bindMailSend(o) {
  const key = `${o.kind}:${o.caseId}`;
  const $ = (id) => document.getElementById(id);
  const btnSend = $(o.ids.send), btnClose = $(o.ids.close), btnCancel = $(o.ids.cancel);
  let busy = false;
  let pending = null;       // 記録待ち（{to, sentAt, reqId?, reqKey?}）
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
  const finish = async () => {
    clearPending(o.kind, o.caseId);
    setUnloadGuard(key, false);
    pending = null;
    await o.onDone(close);
  };

  btnClose?.addEventListener("click", close);
  btnCancel?.addEventListener("click", close);

  // 開いたとき: 記録待ちがあれば、最初から「記録だけやり直す」。承諾書は書き込み先の依頼を照合してから
  const ready = (async () => {
    const p0 = loadPending(o.kind, o.caseId);
    if (!p0) return;
    if (o.kind === "consent") {
      setBusy(true);
      let found = null;
      try { found = await matchPendingReq(p0, o.candidateReqIds || []); } catch { found = null; }
      setBusy(false);
      if (!found) { // 取り消し・署名済み等で記録先が無い: 記録待ちを消し、次の送信は確認をはさむ
        clearPending(o.kind, o.caseId);
        setUnloadGuard(key, false);
        unknownSent.add(key);
        alert(PENDING_TARGET_MISSING_TEXT);
        return;
      }
      targetReqId = found;
    }
    pending = p0;
    showRetry();
    setUnloadGuard(key, true);
  })();

  btnSend.addEventListener("click", async () => {
    await ready;
    if (busy) return;
    if (pending) { // 送信済み・記録待ち: 記録だけやり直す（メールは送らない・送信日時は最初の値）
      setBusy(true);
      try { await o.record(pending.to, pending.sentAt, targetReqId || undefined); }
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
    targetReqId = o.reqId || "";
    // 承諾書は依頼IDの印（reqKey）を作ってから記録待ちを保存する（sessionStorage には印だけ。依頼IDはモジュール変数だけ）
    const reqKey = o.reqId ? await reqKeyOf(o.reqId) : "";
    const v = { to: p.to, sentAt, ...(o.reqId ? { reqId: o.reqId } : {}), ...(reqKey ? { reqKey } : {}) };
    pending = savePending(o.kind, o.caseId, v) || v; // 保存できなくても、このモーダルでは再送させない
    setUnloadGuard(key, true);
    try {
      await o.record(p.to, sentAt, targetReqId || undefined);
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
