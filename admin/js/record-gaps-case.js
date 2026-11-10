// 記録のずれを防ぐ判定（2026-11-10・設計書 docs/CRM改善_設計書_20261110.md §3 点検4・点検5）。
// 純粋関数のみ（DOM・Firestore に触れない）。テスト: node scripts/test-record-gaps-case.mjs
// 呼び出し元: consent-admin.js（承諾書の署名依頼メール）／pre-guide.js（事前準備のご案内メール）／
//             case-detail.js（伴走支援の記録を保存したあとの「伴走支援実施済にしますか」）
// import は相対パス（ブラウザでは /js/ 配下として、node のテストでもそのまま読める）。

import { STATUS_ORDER, STATUS_LABELS, LOST } from "./constants.js";

// ===== 点検4: メール送信の成否と、送信記録の成否を分ける =====
// メールは送れたのに記録（mailedAt など）の保存だけ失敗したとき、「送信に失敗しました」と出すと再送＝二重送信を招く。
// 送れたかどうかと、記録できたかどうかを分けて知らせ、記録だけをやり直せるようにする。

/** 記録だけをやり直すボタンの文言 */
export const RECORD_RETRY_LABEL = "記録だけやり直す";

const errText = (e) => String((e && e.message) || e || "不明なエラー");

// 送れたかどうか分からないエラー（2026-11-10 レビュー 中-A）。sendCaseEmail は Gmail で送ったあとに
// 対応記録・cases の更新が失敗しても HttpsError("internal") を投げる（functions/index.js sendCaseEmail）。
// 通信のタイムアウト・接続断も同じく「送れたかもしれない」。Gmail の送信自体の失敗も internal なので区別できない
const AMBIGUOUS_CODES = ["internal", "deadline-exceeded", "unavailable", "unknown"];

/** エラーの code（"functions/internal" のような接頭辞は外す。無ければ ""） */
export function errorCodeOf(err) {
  const c = String((err && err.code) || "");
  return c.includes("/") ? c.slice(c.lastIndexOf("/") + 1) : c;
}

/** 送れたかどうか分からないエラーか（明確な失敗＝invalid-argument・permission-denied 等は false） */
export function isAmbiguousSendError(err) {
  return AMBIGUOUS_CODES.includes(errorCodeOf(err));
}

/** 「送れたか不明」のあと、もう一度送る前に1回はさむ確認 */
export const RESEND_AFTER_UNKNOWN_CONFIRM_TEXT =
  "前回の送信は、送れたかどうか確認できませんでした。すでに送られているかもしれません。\n"
  + "対応記録に「メール送信」の行が出ていないか確かめましたか？\n\n（OK で送信します）";

/**
 * 送信と記録の結果を分類する。
 * @param {{sendError?:unknown, recordError?:unknown}} r  sendError があれば送信の段階で失敗（記録はしていない）
 * @returns {{kind:"ok"|"send_failed"|"send_unknown"|"record_failed", canResend:boolean, confirmBeforeResend:boolean, message:string}}
 *   canResend … 送信ボタンを送信のまま戻してよいか（record_failed では false＝記録だけやり直す）
 *   confirmBeforeResend … 次に送るとき RESEND_AFTER_UNKNOWN_CONFIRM_TEXT を1回はさむ
 */
export function classifySendOutcome({ sendError, recordError } = {}) {
  if (sendError) {
    if (isAmbiguousSendError(sendError)) {
      return {
        kind: "send_unknown", canResend: true, confirmBeforeResend: true,
        message: "送れたかどうか確認できませんでした。\n"
          + `理由: ${errText(sendError)}\n\n`
          + "対応記録に「メール送信」の行が出ていないか確かめてから、もう一度送ってください（出ていれば送信済みです）。",
      };
    }
    return { kind: "send_failed", canResend: true, confirmBeforeResend: false, message: `送信に失敗しました: ${errText(sendError)}` };
  }
  if (recordError) {
    return {
      kind: "record_failed", canResend: false, confirmBeforeResend: false,
      message: "送信済みです。記録だけ失敗しました（再送しないでください）。\n"
        + `理由: ${errText(recordError)}\n\n`
        + `「${RECORD_RETRY_LABEL}」を押すと、メールは送らずに記録だけを保存し直します。`,
    };
  }
  return { kind: "ok", canResend: true, confirmBeforeResend: false, message: "" };
}

/** 記録のやり直しも失敗したときの文言（再送させない） */
export function recordRetryFailedText(err) {
  return `記録のやり直しにも失敗しました（メールは送信済みです。再送しないでください）: ${errText(err)}\n`
    + `時間をおいて「${RECORD_RETRY_LABEL}」をもう一度押してください。`;
}

/** 送信済み・記録待ちのまま閉じようとしたときの確認文 */
export const CLOSE_WITH_PENDING_RECORD_TEXT =
  "メールは送信済みですが、記録がまだ保存できていません。\n"
  + "閉じても、このタブで同じボタンから開き直せば「記録だけやり直す」から続けられます。メールを再送しないでください。\n\n閉じますか？";

// ===== 記録待ち（送信済み・記録失敗）を覚えておく（2026-11-10 レビュー 中-B） =====
// モーダルを閉じても・再読み込みしても再送させないため、sessionStorage（このタブだけ）に持つ。
// キーは「種類（consent＝承諾書／preGuide＝事前案内）＋案件ID」。値は宛先・送信日時（ISO）と、
// 承諾書なら書き込み先の依頼ID（reqId）だけ。本文・氏名は入れない。
// sessionStorage が使えない（例外を投げる）ときはモジュール変数だけで動く（そのタブを開いている間は効く）

export const PENDING_KINDS = ["consent", "preGuide"];
const memPending = new Map();

/** 記録待ちのキー */
export function pendingKey(kind, caseId) {
  if (!PENDING_KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  return `kjk.mailRecordPending.${kind}.${caseId || ""}`;
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

/** 保存する値をそろえる（余計な値は落とす） */
function pickPending(v) {
  if (!v || typeof v !== "object" || !v.to || !v.sentAt) return null;
  const out = { to: String(v.to), sentAt: String(v.sentAt) };
  if (v.reqId) out.reqId = String(v.reqId);
  return out;
}

/**
 * 記録待ちを保存する。storage は省略時 sessionStorage（テストでは代役を渡す）
 * @param {"consent"|"preGuide"} kind
 * @param {string} caseId
 * @param {{to:string, sentAt:string, reqId?:string}} v
 */
export function savePending(kind, caseId, v, storage) {
  const key = pendingKey(kind, caseId);
  const val = pickPending(v);
  if (!val) return null;
  memPending.set(key, val);
  try { storageOf(storage)?.setItem(key, JSON.stringify(val)); } catch { /* 使えなければモジュール変数だけ */ }
  return val;
}

/** 記録待ちを読む（無ければ null） */
export function loadPending(kind, caseId, storage) {
  const key = pendingKey(kind, caseId);
  try {
    const raw = storageOf(storage)?.getItem(key);
    if (raw) { const v = pickPending(JSON.parse(raw)); if (v) return v; }
  } catch { /* 壊れた値・使えないときはモジュール変数を見る */ }
  return memPending.get(key) || null;
}

/** 記録待ちを消す（記録が成功したとき） */
export function clearPending(kind, caseId, storage) {
  const key = pendingKey(kind, caseId);
  memPending.delete(key);
  try { storageOf(storage)?.removeItem(key); } catch { /* 同上 */ }
}

/** テスト用: モジュール変数の記録待ちを空にする */
export function _resetPendingMemory() { memPending.clear(); }

/** 送信日時（ISO）から、事前案内の送付日（JST の YYYY-MM-DD）を出す */
export function jstDateOf(iso) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

// ===== 点検5: 伴走支援の記録を保存したとき、案件の状態を伴走支援実施済にするか聞く =====

/** 伴走支援実施済（constants.js の 8） */
export const SUPPORT_DONE_STATUS = 8;

// パイプライン順（STATUS_ORDER）で伴走支援実施済より前の状態。失注(4)は末尾にあるので入らない
const BEFORE_SUPPORT_DONE = STATUS_ORDER.slice(0, STATUS_ORDER.indexOf(SUPPORT_DONE_STATUS));

/**
 * 伴走支援の記録を保存したあとに「伴走支援実施済にしますか」と聞くか。
 * 聞く: パイプライン順で伴走支援実施済より前（新規受信〜伴走支援待ち）。
 * 聞かない: 伴走支援実施済以降・完了・失注・対象外（archived）・状態を変えられない人（閲覧のみ）。
 * @param {{status:unknown, archived?:boolean, canChangeStatus?:boolean}} c
 */
export function shouldAskSupportDone({ status, archived = false, canChangeStatus = true } = {}) {
  if (archived || !canChangeStatus) return false;
  const s = Number(status || 1); // 状態が空の案件は新規受信（画面の表示と同じ）
  if (s === LOST) return false;
  return BEFORE_SUPPORT_DONE.includes(s);
}

/** 確認ダイアログの本文 */
export function supportDoneAskText(status) {
  const now = STATUS_LABELS[Number(status || 1)] || "—";
  return `伴走支援の記録を保存しました。\n\n`
    + `案件の状態は「${now}」のままです。「${STATUS_LABELS[SUPPORT_DONE_STATUS]}」にしますか？\n`
    + `（OK で状態を変更します。キャンセルなら変えません）`;
}
