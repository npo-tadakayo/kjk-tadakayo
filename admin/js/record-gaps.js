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

/**
 * 送信と記録の結果を分類する。
 * @param {{sendError?:unknown, recordError?:unknown}} r  sendError があれば送信前に失敗（記録はしていない）
 * @returns {{kind:"ok"|"send_failed"|"record_failed", canResend:boolean, message:string}}
 *   canResend … 送信ボタンをそのまま押させてよいか（record_failed では false＝記録だけやり直す）
 */
export function classifySendOutcome({ sendError, recordError } = {}) {
  if (sendError) {
    return { kind: "send_failed", canResend: true, message: `送信に失敗しました: ${errText(sendError)}` };
  }
  if (recordError) {
    return {
      kind: "record_failed", canResend: false,
      message: "送信済みです。記録だけ失敗しました（再送しないでください）。\n"
        + `理由: ${errText(recordError)}\n\n`
        + `「${RECORD_RETRY_LABEL}」を押すと、メールは送らずに記録だけを保存し直します。`,
    };
  }
  return { kind: "ok", canResend: true, message: "" };
}

/** 記録のやり直しも失敗したときの文言（再送させない） */
export function recordRetryFailedText(err) {
  return `記録のやり直しにも失敗しました（メールは送信済みです。再送しないでください）: ${errText(err)}\n`
    + `時間をおいて「${RECORD_RETRY_LABEL}」をもう一度押してください。`;
}

/** 送信済み・記録待ちのまま閉じようとしたときの確認文 */
export const CLOSE_WITH_PENDING_RECORD_TEXT =
  "メールは送信済みですが、記録がまだ保存できていません。\n"
  + "閉じると画面には「未送付」のまま残ります。閉じたあとにメールを再送しないでください。\n\n閉じますか？";

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
