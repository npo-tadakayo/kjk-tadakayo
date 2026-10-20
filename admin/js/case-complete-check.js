// 案件を「案件完了(13)」にするときの確認（警告）。純粋関数のみ（DOM・Firestore に触れない）。
// 設計: docs/CRM改善_設計_20261021.md §6（W）。止めずに確認ダイアログで見せる用途。テスト: node scripts/test-case-complete-check.mjs
// 金額は invoice-doc.js の invoiceTotals に一本化（supply.js と同じ）。残額の規則も supply.js の payRemain と同じにすること。
// import は相対パス（ブラウザでは /js/ 配下として、node のテストでもそのまま読める）。

import { invoiceTotals } from "./invoice-doc.js";

const yen = (n) => "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");

/** 出荷の状態（未設定の古い出荷は発送済とみなす。supply.js・case-detail.js と同じ） */
export function shipStatusOf(s) { return (s && s.status) || "shipped"; }

// ===== 入金・残額（supply.js 1732-1747 と同じ規則）=====
// 入金は payments[]。旧形式（paymentAmount の1回きり）は1件の履歴として読み替える
export function payListOf(s) {
  if (Array.isArray(s?.payments) && s.payments.length) return s.payments;
  if (Number(s?.paymentAmount) > 0) return [{ amount: Number(s.paymentAmount), date: s.paidAt || "" }];
  return [];
}
export function paidSumOf(s) { return payListOf(s).reduce((a, p) => a + (Number(p.amount) || 0), 0); }
export function refundSumOf(s) { return (Array.isArray(s?.refunds) ? s.refunds : []).reduce((a, r) => a + (Number(r.amount) || 0), 0); }
export function netPaidOf(s) { return paidSumOf(s) - refundSumOf(s); }
/** 充当後の請求額（税込）＝ 請求額 − 過入金の充当 */
export function billableInclOf(s) { return Math.max(0, invoiceTotals(s).total - (Number(s?.creditApplied) || 0)); }
/** 残額（税込）＝ 充当後の請求額 − 純入金（入金 − 返金）。マイナスにはしない */
export function payRemainOf(s) { return Math.max(0, billableInclOf(s) - netPaidOf(s)); }

const soList = (arr) => arr.map((s) => s.soNumber || "番号なし").join("・");

/**
 * 完了にする前に確かめたいことの一覧（空なら警告なし）。
 * @param {{shipments?:object[], subsidy?:object|null}} p
 *   shipments … この案件の出荷（キャンセル済みは数えない）
 *   subsidy   … subsidyApplications/{caseId}（無ければ null）
 * @returns {string[]}
 */
export function completionWarnings({ shipments, subsidy } = {}) {
  const out = [];
  const live = (shipments || []).filter((s) => s && shipStatusOf(s) !== "canceled");
  const by = (pred) => live.filter(pred);

  // 1. 出荷なし
  if (!live.length) out.push("出荷の記録がありません（カードリーダーを送っていない・別の案件で送った可能性）");
  // 2. 未発送（下書き・依頼済）
  const notShipped = by((s) => ["draft", "requested"].includes(shipStatusOf(s)));
  if (notShipped.length) out.push(`まだ発送していない出荷があります（${soList(notShipped)}）`);
  // 3. 請求書未発行（発送済のまま）
  const notInvoiced = by((s) => shipStatusOf(s) === "shipped");
  if (notInvoiced.length) out.push(`請求書を出していない出荷があります（${soList(notInvoiced)}）`);
  // 4. 入金未了（請求済・入金済で残額あり）
  const unpaid = by((s) => ["invoiced", "paid"].includes(shipStatusOf(s)) && payRemainOf(s) > 0);
  if (unpaid.length) {
    const sum = unpaid.reduce((a, s) => a + payRemainOf(s), 0);
    out.push(`入金が済んでいない出荷があります（${unpaid.map((s) => `${s.soNumber || "番号なし"} 残 ${yen(payRemainOf(s))}`).join("・")}${unpaid.length > 1 ? `／計 ${yen(sum)}` : ""}）`);
  }
  // 5. 領収証未発行（入金済で領収証を出していない）
  const noReceipt = by((s) => shipStatusOf(s) === "paid" && !s.receiptIssuedAt);
  if (noReceipt.length) out.push(`領収証を出していない出荷があります（${soList(noReceipt)}）`);

  const sa = subsidy || {};
  // 6. 申請日未入力
  if (!sa.applicationDate) out.push("助成金の申請日が入っていません（申請情報タブ）");
  // 8. 不採択（このときは助成金の入金は来ないので 7 は出さない）
  if (sa.status === "rejected") {
    out.push("助成金が不採択になっています。事業所へのご案内が済んでいるか確かめてください");
  } else if (!sa.actualDepositDate && sa.status !== "deposited") {
    // 7. 助成金の入金未記録
    out.push("助成金の入金日が記録されていません（申請情報タブ）");
  }
  return out;
}
