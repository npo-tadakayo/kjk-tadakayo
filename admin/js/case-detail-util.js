// 案件詳細の純粋ユーティリティ・定数（state非依存）。case-detail.js から切り出し（C2 / 挙動不変）。

export const ACTIVITY_ICONS = {
  phone_in: "ti-phone-incoming",
  phone_out: "ti-phone-outgoing",
  email_in: "ti-mail-down",
  email_out: "ti-mail-up",
  visit: "ti-map-pin",
  memo: "ti-notes",
  gmail_sent: "ti-mail-forward",
};

export const ACTIVITY_LABELS = {
  phone_in: "電話（着信）",
  phone_out: "電話（発信）",
  email_in: "メール（受信）",
  email_out: "メール（送信）",
  visit: "訪問・対面",
  memo: "メモ",
  gmail_sent: "Gmail送信",
};

export const AI_TITLES = {
  reply_draft: "返信メール下書き", summary_classify: "要約・分類",
  session_report: "伴走報告文", assistant: "AIの回答",
};

export function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDateTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function toDateInput(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0, 10);
}

// 振込予定日: 申請月の翌々月末
export function calcExpectedDeposit(applicationDateStr) {
  if (!applicationDateStr) return null;
  const d = new Date(applicationDateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 3; // +2ヶ月 → 翌々月末 = +3ヶ月の0日
  return new Date(year, month, 0);
}
