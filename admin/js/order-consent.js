// admin/js/order-consent.js — 「見積もり必須・承諾書のサイン＝発注」の画面側の判定と文面（2026-11-12）。
// 設計: 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md（決定は CRM改善2_計画_20261112.md §2.1 発1〜発6）。
// 純粋関数だけを置く（DOM・Firestore に触れない）。テスト: node scripts/test-order-consent.mjs
// 呼び出し元: quote-admin.js（承諾書の印刷・紙の受け取り）／case-detail.js・kanban.js（状態の選択の制限）／consent-admin.js（表示）
//
// スイッチ appConfig/settings.orderByConsent（既定オフ）が切れているあいだ、ここの関数はどれも「今までどおり」を返す。
// 練習モードでは練習DBの appConfig/settings を読む（fs.js が練習DBへ切り替える。本番の設定は読まない・変えない）。
import { orderByConsentOn, ORDER_RECEIVED_VIA, isValidYmd } from "./order-consent-rules.js";

export { orderByConsentOn, ORDER_RECEIVED_VIA };

// ===== 状態の選択の制限（発5）=====
// 受注前（1 新規受信・2 確認中）の案件を、3〜12 に手で進める選択肢を選べなくする（3 だけ止めても 5 に飛ばせば抜けられるため）。
// すでに 3 以上の案件の操作は今までどおり。管理者だけ、理由を書けば変えられる（対応記録に残す）。
// 4（失注）・13（完了）からも、受注前のまま（発注の承諾書 orderConsentToken も受注日 orderedAt も無い）なら 3〜12 へは進めない
// （失注・完了をはさむと承諾書なしで受注確定に進めてしまうため・2026-11-12 レビュー 中-1）。
// 新しい流れを入れる前から受注していた進行中の案件（orderConsentToken は無いが orderedAt がある）は止めない。
export const ORDER_GATED_FROM = [1, 2];
export const ORDER_REOPEN_FROM = [4, 13];
export const ORDER_GATED_TO = [3, 5, 6, 7, 8, 9, 10, 11, 12];
export const STATUS_BLOCKED_TEXT =
  "受注前（新規受信・確認中、または承諾書も受注日も無い失注・完了）の案件は、手で受注確定より先に進められません。"
  + "見積もりカードの「署名済みの承諾書を受け取った（受注確定にする）」で受注確定にしてください（管理者は理由を書けば変えられます）";
export const STATUS_REASON_PROMPT =
  "受注前の案件を、承諾書なしで手で進めます（管理者の例外）。\n理由を入れてください（対応記録に「手動で状態を変更（理由: …）」と残ります）";

/** 受注前として扱うか（1・2 は常に。4・13 は発注の承諾書も受注日も無いとき） */
export function isBeforeOrder(from, caseData) {
  const f = Number(from) || 1;
  if (ORDER_GATED_FROM.includes(f)) return true;
  if (ORDER_REOPEN_FROM.includes(f)) return !(caseData && (caseData.orderConsentToken || caseData.orderedAt));
  return false;
}

/** 手で状態を変えてよいか。{kind:"ok"} ／ {kind:"reason"}（管理者・理由が要る）／ {kind:"blocked", message}。caseData は案件（4・13 の判定に使う） */
export function statusChangeGuard({ from, to, orderByConsent, isAdmin, caseData } = {}) {
  if (!orderByConsent) return { kind: "ok" };
  const t = Number(to);
  if (!isBeforeOrder(from, caseData) || !ORDER_GATED_TO.includes(t)) return { kind: "ok" };
  if (isAdmin) return { kind: "reason", message: STATUS_REASON_PROMPT };
  return { kind: "blocked", message: STATUS_BLOCKED_TEXT };
}

/** 選べなくする状態の番号（管理者は選べる＝空。スイッチが切れていれば空） */
export function blockedStatusOptions({ from, orderByConsent, isAdmin, caseData } = {}) {
  if (!orderByConsent || isAdmin) return [];
  return isBeforeOrder(from, caseData) ? [...ORDER_GATED_TO] : [];
}

/** 管理者の例外のとき、対応記録に足す1行 */
export function manualStatusNote(reason) {
  return `手動で状態を変更（理由: ${String(reason || "").trim()}）`;
}

// ===== 紙の承諾書の受け取り（発2）=====
export const RECEIVED_VIA_OPTIONS = Object.entries(ORDER_RECEIVED_VIA).map(([value, label]) => ({ value, label }));

/**
 * 「署名済みの承諾書を受け取った（受注確定にする）」の入力 → staffAcceptQuote に渡す値（検査に通らなければ {error}）。
 * 申込者名・受付日は承諾書の署名者名・受け取った日と同じにする（サーバーも承諾書の値で上書きする）。
 */
export function buildPaperConsentPayload(form, todayYmd) {
  const f = form || {};
  const signedName = String(f.signedName || "").trim();
  if (!signedName) return { error: "承諾書に署名した方のお名前を入れてください" };
  if (signedName.length > 100) return { error: "署名者のお名前は100文字までにしてください" };
  if (!isValidYmd(f.receivedDate)) return { error: "承諾書を受け取った日を正しく入れてください（YYYY-MM-DD）" };
  if (isValidYmd(todayYmd) && f.receivedDate > todayYmd) return { error: "承諾書を受け取った日が未来の日付になっています" };
  const receivedVia = Object.prototype.hasOwnProperty.call(ORDER_RECEIVED_VIA, f.receivedVia) ? f.receivedVia : "other";
  if (f.preferredDate && !isValidYmd(f.preferredDate)) return { error: "希望日を正しく入れてください（YYYY-MM-DD）" };
  const channel = receivedVia === "fax" ? "fax" : receivedVia === "email" ? "email" : "other";
  const consent = { signedName: signedName.slice(0, 100), receivedDate: f.receivedDate, receivedVia };
  if (f.reconsent) return { payload: { quoteId: f.quoteId, reconsent: true, consent } };
  return {
    payload: {
      quoteId: f.quoteId,
      acceptedName: consent.signedName, channel, receivedDate: f.receivedDate,
      payMethod: f.payMethod === "before" ? "before" : "after",
      preferredDate: f.preferredDate || "",
      note: String(f.note || "").trim().slice(0, 1000),
      sendMail: !!f.sendMail,
      groupQuoteIds: [...new Set((f.groupQuoteIds || []).filter((id) => id && id !== f.quoteId))],
      consent,
    },
  };
}

// ===== 発注の承諾書の表示 =====
const METHOD_LABEL = { paper_order: "紙", web_order: "オンライン", paper: "紙", web: "オンライン" };
export function consentMethodLabel(method) { return METHOD_LABEL[method] || "—"; }
export function isOrderConsent(r) { return !!r && r.kind === "order"; }

const ymdOf = (ts) => {
  try {
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : (ts ? new Date(ts) : null));
    if (!d || Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  } catch { return ""; }
};

/**
 * 発注の承諾書（consentRequests の kind:"order"）→ 案件詳細に出す1行の材料。
 * 日付は紙なら受け取った日、オンラインなら署名の日時（JST）。
 */
export function orderConsentLine(rec) {
  if (!isOrderConsent(rec)) return null;
  const s = rec.signed || {};
  const paper = s.method === "paper_order";
  const date = paper ? (s.receivedDate || "") : ymdOf(s.signedAt);
  const quotes = (Array.isArray(rec.quotes) ? rec.quotes : []).map((q) => `${q.estNo || "見積"} 第${q.version || "—"}版`);
  const via = paper && s.receivedVia ? `・${ORDER_RECEIVED_VIA[s.receivedVia] || "その他"}` : "";
  return {
    displayNo: rec.displayNo || "",
    signer: s.name || "",
    date,
    method: `${consentMethodLabel(s.method)}${via}`,
    quotes,
    version: (rec.document && rec.document.version) || "",
    retake: !!rec.retakeOf,
    text: `署名者 ${s.name || "—"}／${paper ? "受け取った日" : "署名日"} ${date || "—"}／${consentMethodLabel(s.method)}${via}／${quotes.join("・") || "—"}／条文の版 ${(rec.document && rec.document.version) || "—"}`,
  };
}

// ===== 承諾書の印刷（見積番号・版・品目・台数・金額入り。まとめ見積もりは全事業所を1枚に）=====
// 品番 → 表示名（functions/index.js の PRODUCT_NAMES と同じ）
export const PRODUCT_NAMES = {
  "cir415a-01": "介護情報基盤 汎用カードリーダ CIR415A",
  "cir315a-02": "介護情報基盤 汎用カードリーダ CIR315A（Type-A）",
  "cir315a-04": "介護情報基盤 汎用カードリーダ CIR315A（Type-C）",
};
const escH = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const yenH = (n) => `¥${(Number(n) || 0).toLocaleString("ja-JP")}`;

/** 見積もり1件の品目の行（「CIR415A … 補助対象 2台＋追加 1台」） */
export function itemsText(items, nameOf = (sku) => PRODUCT_NAMES[sku] || sku) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.map((i) => {
    const sub = Number(i && i.subsidyQty) || 0, ext = Number(i && i.extraQty) || 0;
    if (sub + ext <= 0) return "";
    return `${nameOf(i.sku)}：${sub + ext}台（補助対象 ${sub}台${ext ? `＋追加 ${ext}台` : ""}）`;
  }).filter(Boolean);
  return rows.length ? rows.join("、") : "—";
}

/**
 * 印刷用の承諾書の HTML（新しいタブに書き込む。外部の読み込みなし）。
 * @param {object} p
 * @param {object} p.document  条文（admin/js/consent-document.js の CONSENT_DOCUMENT＝v1.2）
 * @param {object[]} p.quotes  見積もり（_id または id・estNo・version・officeName・corpName・items・amounts・validUntil）
 * @param {string} [p.printedYmd]
 * @param {(sku:string)=>string} [p.nameOf]
 * @param {boolean} [p.practice] 練習モードの印を付ける
 */
export function buildOrderConsentPrintHtml({ document: d, quotes, printedYmd = "", nameOf, practice = false } = {}) {
  const list = Array.isArray(quotes) ? quotes : [];
  const corp = (list.find((q) => q && q.corpName) || {}).corpName || "";
  const total = list.reduce((s, q) => s + (Number(q && q.amounts && q.amounts.totalIncl) || 0), 0);
  const self = list.reduce((s, q) => s + (Number(q && q.amounts && q.amounts.selfPay) || 0), 0);
  const rows = list.map((q) => `
      <tr>
        <td>${escH(q.estNo || "")}<br><span class="sub">第${escH(q.version ?? "—")}版${ymdOf(q.validUntil) ? `・有効期限 ${escH(ymdOf(q.validUntil))}` : ""}</span></td>
        <td>${escH(q.officeName || "")}</td>
        <td>${escH(itemsText(q.items, nameOf))}</td>
        <td class="num">${yenH(q.amounts && q.amounts.totalIncl)}<br><span class="sub">自己負担 ${yenH(q.amounts && q.amounts.selfPay)}</span></td>
      </tr>`).join("");
  const sections = (d && Array.isArray(d.sections) ? d.sections : [])
    .map((s) => `<h3>${escH(s.title)}</h3><p>${escH(s.body)}</p>`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escH(d && d.title)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: "Hiragino Sans","Noto Sans JP",sans-serif; color:#1a1613; font-size:10.5pt; line-height:1.7; margin:0; }
  .wrap { max-width: 182mm; margin: 0 auto; padding: 8mm 0; }
  h1 { font-size: 14pt; text-align:center; margin: 0 0 4mm; }
  h2 { font-size: 11pt; margin: 5mm 0 2mm; border-bottom:1px solid #999; }
  h3 { font-size: 10.5pt; margin: 3mm 0 1mm; }
  p { margin: 0 0 2mm; }
  table { width:100%; border-collapse: collapse; font-size: 9.5pt; }
  th, td { border:1px solid #999; padding: 4px 6px; vertical-align: top; text-align:left; }
  th { background:#f1eee7; }
  td.num { text-align:right; white-space:nowrap; }
  .sub { font-size: 8.5pt; color:#555; }
  .to { font-size: 11pt; margin-bottom: 3mm; }
  .sign { margin-top: 5mm; border:1.5px solid #333; padding: 4mm 5mm; }
  .sign .line { display:flex; gap:6mm; margin: 3mm 0; align-items:flex-end; }
  .sign .line span.l { min-width: 28mm; }
  .sign .line span.b { flex:1; border-bottom: 1px solid #333; height: 7mm; }
  .note { font-size: 9pt; color:#444; }
  .practice { border:2px solid #C99A00; background:#FFF4C2; padding: 2mm 4mm; font-weight:700; margin-bottom: 3mm; }
  .tools { text-align:right; margin-bottom: 4mm; }
  @media print { .tools { display:none; } }
</style></head><body><div class="wrap">
  <div class="tools"><button type="button" onclick="window.print()">印刷する</button></div>
  ${practice ? `<div class="practice">練習モードで作った承諾書です（本番の発注には使えません）</div>` : ""}
  <h1>${escH(d && d.title)}</h1>
  <div class="to">${escH(corp)} 御中${list.length > 1 ? `（${list.length}事業所）` : list[0] && list[0].officeName ? `　${escH(list[0].officeName)}` : ""}</div>
  <h2>本書に表示する見積書（発注の内容）</h2>
  <table>
    <thead><tr><th style="width:22%">見積番号・版</th><th style="width:22%">事業所</th><th>品目・台数</th><th style="width:18%">金額（税込）</th></tr></thead>
    <tbody>${rows}</tbody>
    ${list.length > 1 ? `<tfoot><tr><th colspan="3" style="text-align:right">合計（${list.length}事業所）</th><td class="num"><strong>${yenH(total)}</strong><br><span class="sub">自己負担 ${yenH(self)}</span></td></tr></tfoot>` : ""}
  </table>
  <p class="note">見積書の内容（品目・台数・金額）が変わった場合は、変更後の見積書であらためて本書をいただきます。</p>
  ${d && d.preamble ? `<p>${escH(d.preamble)}</p>` : ""}
  ${sections}
  <h2>確認・承諾</h2>
  <p>${escH(d && d.consent_statement)}</p>
  <p class="note">利用規約: ${escH(d && d.terms_url)}　／　プライバシーポリシー: ${escH(d && d.privacy_url)}</p>
  <div class="sign">
    <div class="line"><span class="l">署名日</span><span class="b"></span><span>年</span><span class="b" style="flex:.4"></span><span>月</span><span class="b" style="flex:.4"></span><span>日</span></div>
    <div class="line"><span class="l">事業所名</span><span class="b"></span></div>
    <div class="line"><span class="l">ご署名（お名前）</span><span class="b"></span></div>
    <div class="line"><span class="l">役職</span><span class="b"></span></div>
  </div>
  <p class="note" style="margin-top:3mm">ご署名のうえ、FAX・郵送・メール（読み取った画像）のいずれかでお送りください。届いた日をもって発注を受け付け、受注確認のご連絡をお送りします。</p>
  <p class="note">${escH(d && d.issuer)}<br>${escH(d && d.issuer_detail)}</p>
  <p class="note">条文の版 ${escH(d && d.version)}${printedYmd ? `　／　印刷日 ${escH(printedYmd)}` : ""}</p>
</div></body></html>`;
}
