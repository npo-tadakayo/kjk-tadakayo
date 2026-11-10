// 「記録のずれ」の判定（設計書 CRM改善_設計書_20261110 §3 全体の点検・2026-11-10）。
// 画面（supply.js / supply-print.js / quote-admin.js / case-detail.js / kanban.js）から呼ぶ純関数だけを置く。
// Firestore にも DOM にも触らない（node scripts/test-record-gaps.mjs でそのまま試せるように）。
import { MAILED_PENDING_LABEL, mailedPendingOf, shipStatusOf, paymentsOf, netPaidOf } from "./ship-flow.js";

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

// ===== 点検12: 請求前に入金を記録した出荷でも、一覧の行に入金を出す（表示だけ） =====
// 出荷一覧の入金・未集金の欄は請求済・入金済の行だけに出していたので、銀行明細の取り込みなどで
// 発送済（未請求）のうちに入金を記録した出荷は、行を見ても入金が分からなかった。
// 入金の記録・消込・状態は一切変えない（ここは読むだけ）。請求済・入金済は従来の表示のまま（null を返す）。
// 金額は ship-flow.js の netPaidOf（入金 − 返金）＝ supply.js の netPaid と同じ数え方。
const yenText = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP"); // supply.js の yen と同じ書き方
export function prepaidNoteOf(s) {
  if (!s) return null;
  const st = shipStatusOf(s);
  if (st === "invoiced" || st === "paid") return null;
  const pays = paymentsOf(s);
  if (!pays.length) return null;
  const net = netPaidOf(s);
  const last = String((pays[pays.length - 1] || {}).date || "");
  const refunded = net !== pays.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  return {
    net, count: pays.length, lastDate: last,
    text: `入金済 ${yenText(net)}（請求前に記録${last ? `・${last}` : ""}${pays.length > 1 ? `・${pays.length}回` : ""}${refunded ? "・返金差引後" : ""}）`,
  };
}

// ===== 点検8: 見積もりの「ご案内メール」の送信記録を見積もり一覧に出す =====
// staffCreateQuote（functions/index.js）が見積もり作成時のご案内メールを送ると quotes に noticeMailedAt / noticeMailedTo を書くが、
// どの画面もこれを表示していなかった（PDF送付の mailedAt / mailedTo は「事業所へ再送」の文言にしか使っていなかった）。
// 日時は Firestore の Timestamp（toDate）・Date・ミリ秒・{seconds} のどれでも読む。日本時間の YYYY-MM-DD で出す。
export function ymdJstOf(ts) {
  if (!ts) return "";
  let d;
  if (typeof ts.toDate === "function") d = ts.toDate();
  else if (ts instanceof Date) d = ts;
  else if (typeof ts === "number") d = new Date(ts);
  else if (ts.seconds != null) d = new Date(Number(ts.seconds) * 1000);
  else if (typeof ts === "string") d = new Date(ts);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
/** @returns {{key:string, text:string, warn?:boolean}[]} 見積もり1版ぶんのメール送付の記録 */
export function quoteMailNotesOf(q) {
  if (!q) return [];
  const out = [];
  const at = (ts) => ymdJstOf(ts) || "日付不明";
  if (q.noticeMailedAt) out.push({ key: "notice", text: `ご案内メール送信 ${at(q.noticeMailedAt)}${q.noticeMailedTo ? `（${q.noticeMailedTo}）` : ""}` });
  if (q.mailedAt) out.push({ key: "pdf", text: `見積書PDFを送付 ${at(q.mailedAt)}${q.mailedTo ? `（${q.mailedTo}）` : ""}` });
  else if (q.mailError) out.push({ key: "pdfError", warn: true, text: `見積書PDFの送付に失敗（${q.mailError}）` });
  return out;
}

// ===== 点検10: 案件を手で「受注確定」にしたとき、受注日（orderedAt）を補う =====
// 受注日は Web の申込・電話等の受注確定（staffAcceptQuote）でしか付かず、ステータスの手変更で「受注確定」にした案件は
// orderedAt が空のまま残り、案件一覧の絞り込み「見積済（未申込）」（latestQuoteId あり・orderedAt なし）に残り続けた。
// 手で 3（受注確定）にした瞬間に、まだ受注日が無ければその操作の日時を受注日にする。すでにあれば上書きしない
// （Web・スタッフ受注と同じく「最初の申込の日を保つ」）。既存データの一括補正はしない。
export const ORDER_CONFIRMED_STATUS = 3;
export const ORDERED_AT_FILLED_NOTE = "受注日が入っていなかったため、この操作の日を受注日として記録しました";
export function orderedAtFillNeeded(prevStatus, newStatus, kase) {
  return Number(newStatus) === ORDER_CONFIRMED_STATUS && Number(prevStatus) !== ORDER_CONFIRMED_STATUS
    && !(kase && kase.orderedAt);
}
