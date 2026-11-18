// 公開の見積もりの入口（webhookMitsumori → sendQuotePdf）を、踏み台メールに使わせないための検査（2026-11-18・セキュリティ点検 A2）。
// Firebase に触らない純粋関数だけを置く（scripts/test-quote-mail-guard.mjs で確かめる）。
//
//   checkQuotePdf      … ブラウザから渡された base64 が「本当に PDF で、大きすぎない」かを確かめ、正規化した base64 を返す
//   oneLine            … メールのヘッダー・本文の1行に入る文字列から、改行・制御文字を除き、長さに上限を付ける
//   quoteMailRecipient … 見積書の送り先（見積もりに保存した contactEmail）が1つのアドレスの形かを確かめる

// 1通あたりの上限（デコード後）。本番の見積書 PDF（quotes/ 186件・2026-11-18 実測）は 中央値 約0.44MB・最大 約1.16MB。
// その4倍強の 5MB を上限にする（正規の見積書は通り、大きなファイルを運ばせない）。
const QUOTE_PDF_MAX_BYTES = 5 * 1024 * 1024;

const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * ブラウザから来た base64 を検査する。
 * 戻り値 { ok:true, buf, base64 } ／ { ok:false, message }
 *   - base64 の文字以外が入っていれば拒否（data URI の頭・改行・空白は取り除いてから見る）
 *   - デコード後の先頭が "%PDF-" でなければ拒否
 *   - デコード後が QUOTE_PDF_MAX_BYTES を超えれば拒否
 * base64 は Buffer から作り直した「きれいな形」を返す（添付・保存にはこちらを使う）。
 */
function checkQuotePdf(input, { maxBytes = QUOTE_PDF_MAX_BYTES } = {}) {
  if (typeof input !== "string" || !input) return { ok: false, message: "PDFが空です" };
  let s = input;
  if (s.startsWith("data:")) { const i = s.indexOf(","); s = i >= 0 ? s.slice(i + 1) : ""; }
  s = s.replace(/\s+/g, "");
  // 長さで先に弾く（デコードする前に。base64 は 4文字で3バイト）
  if (s.length > Math.ceil(maxBytes / 3) * 4 + 4) return { ok: false, message: `PDFが大きすぎます（${Math.round(maxBytes / 1024 / 1024)}MB以下）` };
  // 画面（jsPDF の datauristring）は標準の base64 を送る。それ以外の文字（MIME の区切りに使える - _ " など）は拒否
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return { ok: false, message: "PDFの形式が正しくありません" };
  const buf = Buffer.from(s, "base64");
  if (!buf.length) return { ok: false, message: "PDFが空です" };
  if (buf.length > maxBytes) return { ok: false, message: `PDFが大きすぎます（${Math.round(maxBytes / 1024 / 1024)}MB以下）` };
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, message: "PDFの形式が正しくありません" };
  return { ok: true, buf, base64: buf.toString("base64") };
}

/**
 * 1行の文字列にする。CR・LF・タブなどの制御文字（U+0000〜U+001F・U+007F〜U+009F）と、
 * 行・段落の区切り（U+2028・U+2029）を空白1つにまとめ、前後の空白を落とし、max 文字で切る。
 */
function oneLine(s, max = 100) {
  const t = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  // サロゲートペア（絵文字・一部の漢字）の途中で切らないよう、文字（コードポイント）単位で切る
  return Array.from(t).slice(0, max).join("");
}

/**
 * 見積書の送り先の検査。呼び出し側は「見積もりに保存した contactEmail」だけを渡す
 * （リクエストの値は渡さない＝公開の入口から宛先を差し替えられないように）。
 * 形が正しくなければ ""（＝送らない）。
 */
function quoteMailRecipient(caseContactEmail) {
  const e = oneLine(caseContactEmail, 254).replace(/\s+/g, "");
  return MAIL_RE.test(e) ? e : "";
}

module.exports = { QUOTE_PDF_MAX_BYTES, checkQuotePdf, oneLine, quoteMailRecipient };
