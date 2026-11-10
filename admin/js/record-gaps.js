// 「記録のずれ」の判定（設計書 CRM改善_設計書_20261110 §3 全体の点検・2026-11-10）。
// 画面（supply.js / supply-print.js / quote-admin.js / case-detail.js / kanban.js）から呼ぶ純関数だけを置く。
// Firestore にも DOM にも触らない（node scripts/test-record-gaps.mjs でそのまま試せるように）。
import { MAILED_PENDING_LABEL, mailedPendingOf } from "./ship-flow.js";

// ===== 点検3: 請求書・領収証・催促のメールを、案件の対応記録（activities）に残す =====
// 送信は Cloud Functions の sendPartnerMail が行い、出荷には invoiceMailedAt / receiptMailedAt / dunningSentAt を書くが、
// 案件の対応記録には何も残らなかった。送信が成功したあと、画面から1件足す。
// 書式は sendCaseEmail（functions/index.js）の送信記録に合わせる: type "gmail_sent"・件名「メール送信: …」・本文「宛先: …」
export const BILLING_MAIL_KIND_LABEL = { invoice: "請求書", receipt: "領収証", dunning: "お支払いのお願い（催促）" };

/**
 * 対応記録に足す1件。案件にひも付かない出荷（caseId なし）は null（記録先が無い）。
 * @param {{kind:string, ship:object, to:string, cc?:string, subject:string, body?:string, attachments?:string[]}} a
 */
export function billingMailActivityOf({ kind, ship, to, cc, subject, body, attachments } = {}) {
  const s = ship || {};
  if (!s.caseId) return null;
  const label = BILLING_MAIL_KIND_LABEL[kind] || "メール";
  const att = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
  const lines = [
    `宛先: ${to || ""}${cc ? `（CC ${cc}）` : ""}`,
    `出荷 ${s.soNumber || "（番号なし）"} の${label}をメールで送付`,
    att.length ? `添付: ${att.join("・")}` : "",
  ].filter(Boolean);
  return {
    caseId: s.caseId, type: "gmail_sent",
    subject: `メール送信: ${subject || label}`,
    body: lines.join("\n") + (body ? `\n\n${body}` : ""),
    attachmentUrls: [],
  };
}

/**
 * メールは送れたが、対応記録だけ書けなかったときの知らせ（二重送信を招かないよう「送信済み」をはっきり書く）。
 * 送信の失敗（「送信に失敗しました」）とは分けて出す。
 */
export function mailRecordFailedText(err) {
  const msg = (err && (err.message || String(err))) || "不明なエラー";
  return `メールは送信済みです。案件の対応記録への記録だけ失敗しました（${msg}）。\n`
    + "もう一度送らないでください。必要なら案件詳細の対応記録に手で残してください";
}

/**
 * 出荷一覧の行に出す「送付済み」の記録。状態を問わず出す（発送済でも請求書を送っていれば出す）。
 * 以前は請求済・入金済の行の中だけに出していたので、発送済（未請求）の行では見えなかった。
 * @returns {{key:string, text:string}[]}
 */
export function mailSentNotesOf(s) {
  if (!s) return [];
  const md = (v) => String(v || "").slice(5); // YYYY-MM-DD → MM-DD（一覧の他の日付と同じ短さ）
  const out = [];
  if (s.invoiceMailedAt) out.push({ key: "invoice", text: `請求書をメール送付済み ${md(s.invoiceMailedAt)}` });
  if (s.receiptMailedAt) out.push({ key: "receipt", text: `領収証をメール送付済み ${md(s.receiptMailedAt)}` });
  if (s.dunningSentAt) {
    const n = Number(s.dunningCount) || 0;
    out.push({ key: "dunning", text: `催促メール送信済み ${md(s.dunningSentAt)}${n > 1 ? `（${n}回目）` : ""}` });
  }
  return out;
}

// ===== 点検11: 領収証を送ったあとの確認で「キャンセル」を押した出荷に「送付済み・記録待ち」と出す =====
// 一覧のバッジ・案件詳細の出荷カードは PR #58 の mailedPendingNotes（ship-flow.js）で出ている。
// 領収証ページの「発行を記録」の横は、発行済みのときしか状態を出しておらず、送ったのに何も出なかった。
// 判定は mailedPendingOf と同じ（キャンセルした出荷・発行済みは「記録待ち」にしない）。
export function receiptSaveInfoOf(s) {
  if (!s) return "";
  if (s.receiptIssuedAt) return `発行済 ${s.receiptIssuedAt}（${s.receiptNo || ""}）`;
  if (mailedPendingOf(s).receipt) {
    return `領収証 ${MAILED_PENDING_LABEL}（${s.receiptMailedAt}${s.receiptMailedTo ? ` に ${s.receiptMailedTo} へ送付` : " に送付"}）。`
      + "「発行を記録」で記録してください";
  }
  return "";
}
