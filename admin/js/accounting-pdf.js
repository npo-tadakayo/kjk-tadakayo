// 経理への期末報告の PDF（A4 縦）の中身の HTML。純粋 ESM（DOM も firebase も使わない）。
// 2026-11-24 preview の実機確認で「売上の明細の右端（税込・うち消費税）が切れる」不具合 → 作り直した:
//   ・本文の幅を 186mm に固定（html2pdf の余白 10mm×2 を引いた 190mm より少し狭く）
//   ・表はすべて table-layout:fixed ＋ 列ごとの幅（%・合計 100）。長い名前は折り返す（overflow-wrap:anywhere）
//   ・金額の列は折り返さないが、最長の金額（¥99,999,999）が入る幅を取ってある
// 列の幅の合計が 100% になっていることは scripts/test-accounting-rules.mjs で確かめる（PDF_TABLES）。
import { UNSET_LOCATION } from "./accounting-rules.js";

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
const yen = (n) => (n == null ? "未確認" : `${Number(n) < 0 ? "−" : ""}¥${Math.abs(Number(n) || 0).toLocaleString("ja-JP")}`);
const qty = (n) => `${Number(n || 0).toLocaleString("ja-JP")}台`;

/** html2pdf の設定（余白 上10・右10・下12・左10mm＝本文 190mm 幅に 186mm の本文を置く） */
export const ACCOUNTING_PDF_OPTIONS = (cutoff) => ({
  margin: [10, 10, 12, 10], filename: `経理報告_${String(cutoff || "").replace(/-/g, "")}.pdf`,
  image: { type: "jpeg", quality: 0.95 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
  jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }, pagebreak: { mode: ["css", "legacy"], avoid: "tr" },
});

// 表の定義: [見出し, 幅%, 数値の列か]
export const PDF_TABLES = {
  summary: [["", 4], ["項目", 28], ["件数・台数", 11, 1], ["金額", 14, 1], ["メモ", 43]],
  salesMonth: [["月", 12], ["件数", 8, 1], ["税込合計", 16, 1], ["うち消費税", 14, 1], ["直接（事業所）", 25, 1], ["直送（認定事業者）", 25, 1]],
  sales: [["請求日", 12], ["出荷番号", 15], ["請求先", 35], ["種類", 12], ["税込", 14, 1], ["うち消費税", 12, 1]],
  receivables: [["出荷番号", 13], ["請求日", 10], ["請求先", 23], ["請求額", 11, 1], ["締め日までの入金", 11, 1], ["残高", 11, 1], ["支払期限", 10], ["実際の入金日", 11]],
  unbilled: [["出荷番号", 14], ["出荷日", 11], ["請求先", 32], ["見込み金額", 13, 1], ["区分", 17], ["請求日", 13]],
  inventory: [["保管場所", 30], ["品目", 30], ["台数", 10, 1], ["仕入単価（発注書の単価）", 14, 1], ["金額", 16, 1]],
  openOrders: [["発注番号", 13], ["発注日", 10], ["区分", 15], ["先方出荷日", 10], ["到着日", 13], ["届け先", 18], ["台数", 8, 1], ["金額（税別）", 13, 1]],
  purchases: [["発注番号", 14], ["発注日", 11], ["仕入の日", 11], ["日付の根拠", 18], ["台数", 9, 1], ["品代", 20, 1], ["送料", 17, 1]],
  payables: [["発注番号", 20], ["仕入の日", 16], ["金額", 22, 1], ["支払い", 20, 1], ["未払い", 22, 1]],
  refunds: [["種類", 22], ["日付", 12], ["出荷番号", 15], ["請求先", 35], ["金額", 16, 1]],
};

const TH = "border:1px solid #ccc;background:#F3F0EA;padding:2px 3px;text-align:left;font-weight:600;overflow-wrap:anywhere;word-break:break-all;";
const TD = "border:1px solid #ddd;padding:2px 3px;vertical-align:top;overflow-wrap:anywhere;word-break:break-all;";
const TN = "border:1px solid #ddd;padding:2px 3px;vertical-align:top;text-align:right;white-space:nowrap;overflow:hidden;";
function tbl(kind, rows) {
  const cols = PDF_TABLES[kind];
  const colg = `<colgroup>${cols.map((c) => `<col style="width:${c[1]}%">`).join("")}</colgroup>`;
  const head = `<thead><tr>${cols.map((c) => `<th style="${TH}${c[2] ? "text-align:right;" : ""}">${esc(c[0])}</th>`).join("")}</tr></thead>`;
  const body = rows.map((cells) => `<tr style="page-break-inside:avoid">${cells.map((v, i) => `<td style="${cols[i] && cols[i][2] ? TN : TD}">${v}</td>`).join("")}</tr>`).join("");
  return `<table style="width:100%;table-layout:fixed;border-collapse:collapse;margin:3px 0 9px">${colg}${head}<tbody>${body}</tbody></table>`;
}
const h2 = (t) => `<h2 style="font-size:11.5px;margin:12px 0 3px;padding-left:6px;border-left:3px solid #E33535;page-break-after:avoid">${esc(t)}</h2>`;
const note = (t) => `<p style="color:#6a5e48;margin:0 0 6px">${t}</p>`;
const none = (m) => note(esc(m));

/** PDF の本文（ルートの div 1つ）。nowJst は作成日時の表示（"YYYY-MM-DD HH:MM"） */
export function accountingPdfHtml(r, nowJst) {
  const st = "box-sizing:border-box;width:186mm;font-family:'Noto Sans JP','Hiragino Sans',system-ui,sans-serif;color:#2C2416;font-size:8.5px;line-height:1.5;background:#fff;";
  let h = `<div style="${st}">`;
  h += `<div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #E33535;padding-bottom:6px;margin-bottom:8px;gap:8px">
    <div><div style="font-size:16px;font-weight:700">経理への期末報告</div><div>期首 ${esc(r.start)} 〜 締め日 ${esc(r.cutoff)}（締め日 23:59 JST 時点）</div></div>
    <div style="text-align:right;color:#6a5e48">NPO法人タダカヨ 介護情報基盤 伴走支援<br>作成 ${esc(nowJst || "")} JST</div></div>`;
  h += h2("要約") + tbl("summary", r.summary.map((s) => [s.no, esc(s.title),
    s.count == null ? "未確認" : `${s.count.toLocaleString("ja-JP")}${s.unit || "件"}`, yen(s.amount), esc(s.note)]));
  h += note("金額は請求書と同じ計算（税込）。仕入・未着品は発注書の金額（税別）。練習モードのデータ・キャンセル・下書きは含みません。請求したあとにキャンセルした出荷は過去の売上からも消えます。");
  const S = r.sales;
  h += h2("1. 売上（期中・月別）") + tbl("salesMonth", [...S.byMonth, { month: "合計", ...S }].map((m) =>
    [esc(m.month), m.count, yen(m.total), yen(m.tax), `${m.direct.count}件 ${yen(m.direct.total)}`, `${m.partner.count}件 ${yen(m.partner.total)}`]));
  h += h2("1. 売上の明細") + (S.count ? tbl("sales", S.rows.map((x) => [esc(x.invoicedAt), esc(x.soNumber), esc(x.billTo), esc(x.kind), yen(x.total), yen(x.tax)])) : none("ありません"));
  const R = r.receivables;
  h += h2(`2. 未収金（売掛金） ${R.count}件 ${yen(R.total)}`) + (R.count ? tbl("receivables",
    R.rows.map((x) => [esc(x.soNumber), esc(x.invoicedAt), esc(x.billTo), yen(x.billed), yen(x.paid), yen(x.balance), esc(x.dueDate), esc(x.paidDate || "—")])) : none("ありません"))
    + (R.undated && R.undated.length ? note(`入金の日付が分からないため除いた出荷 ${R.undated.length}件: ${esc(R.undated.join("・"))}`) : "");
  const U = r.unbilled;
  h += h2(`3. 請求していない出荷 ${U.count}件 ${yen(U.total)}（締め日後に請求済 ${U.later.count}件／いまも未請求 ${U.still.count}件）`) + (U.count ? tbl("unbilled",
    U.rows.map((x) => [esc(x.soNumber), esc(x.shipDate), esc(x.billTo), yen(x.total), x.later ? "締め日後に請求済" : "いまも未請求", esc(x.invoicedAt || "—")])) : none("ありません"))
    + (U.paidNoInvoice && U.paidNoInvoice.length ? note(`入金済なのに請求日が空のため除いた出荷 ${U.paidNoInvoice.length}件: ${esc(U.paidNoInvoice.join("・"))}`) : "");
  const I = r.inventory;
  h += h2(`4. 在庫（棚卸） ${qty(I.total)} ${yen(I.amount)}`) + (I.rows.length ? tbl("inventory",
    I.rows.map((x) => [esc(x.location), `${esc(x.name)}<br><span style="color:#6a5e48">${esc(x.sku)}</span>`, qty(x.qty), x.unitCost == null ? "—" : yen(x.unitCost), x.amount == null ? "—" : yen(x.amount)])) : none("ありません"))
    + note(`発注の入荷は実際に届いた日で数えています（${I.adjusted}件）。${I.unset ? `${UNSET_LOCATION} ${I.unset}台${I.unset < 0 ? "（記録のずれ）" : ""}。` : ""}`);
  const O = r.openOrders;
  h += h2(`5. 届いていない発注（未着品） ${O.count}件 ${qty(O.qty)} ${yen(O.amount)}`) + (O.count ? tbl("openOrders",
    O.rows.map((x) => [esc(x.poNumber), esc(x.orderDate), esc(x.state), esc(x.supplierShipDate || "—"), esc(`${x.arrivedDate || "—"}${x.arrivalBasis ? `（${x.arrivalBasis}）` : ""}`), esc(x.arrivedTo), qty(x.qty), yen(x.amount)])) : none("ありません"));
  const P = r.purchases;
  h += h2(`6. 仕入（期中） ${P.count}件 品代 ${yen(P.goods)}・送料 ${yen(P.shippingFee)}（税別）`) + (P.count ? tbl("purchases",
    P.rows.map((x) => [esc(x.poNumber), esc(x.orderDate), esc(x.date), esc(x.dateBasis), qty(x.qty), yen(x.goods), yen(x.shippingFee)])) : none("ありません"));
  const Y = r.payables;
  h += h2("7. 仕入先への未払い（買掛金）") + (Y.recorded ? (Y.count ? tbl("payables",
    Y.rows.map((x) => [esc(x.poNumber), esc(x.date), yen(x.owed), yen(x.paid), yen(x.balance)])) : none("ありません")) : none("支払いの記録は未登録です（未払いの一覧・金額は未確認）。"));
  const F = r.refunds;
  const frows = [...F.refunds.map((x) => ["返金", x]), ...F.credits.map((x) => ["過入金の充当", x]), ...F.overpaid.map((x) => ["締め日時点の過入金", x])];
  h += h2("8. 返金・過入金") + (frows.length ? tbl("refunds", frows.map(([k, x]) => [k, esc(x.date), esc(x.soNumber), esc(x.billTo), yen(x.amount)])) : none("ありません"));
  return h + "</div>";
}
