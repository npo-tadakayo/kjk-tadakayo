// 助成金の内訳B「接続サポート等経費」の呼び名（CommonJS の写し・2026-11-15）。
// 正本は admin/js/support-fee-names.js（ESM）。functions は CommonJS で、出荷の明細を作る shipmentItemsFromQuote（同期）から使うため、
// import() ではなく require できる写しを置く。値の一致は scripts/test-support-fee-names.mjs が確かめる（違っていたら正本に合わせる）。
// ⚠ 品名の文字列で行を見分けない（伴走支援費の行は sku "support-fee"）。

const SUPPORT_FEE_LABEL = "接続サポート等経費（伴走支援費）";

/** 自動の伴走支援費の行の品名（請求書・領収証にそのまま出る）。n＝補助対象の台数 */
function supportFeeItemName(n) {
  return `接続サポート等経費（伴走支援費・補助対象${n}台）`;
}

// 表示のときの品名の正規化（正本 admin/js/support-fee-names.js の displaySupportFeeName と同じ・2026-11-15）。保存値は変えない
const OLD_ITEM_NAME = /^伴走支援費(?:（補助対象(\d+)台）)?$/;
function displaySupportFeeName(item) {
  const name = item ? item.name : undefined;
  if (!item || String(item.sku || "") !== "support-fee" || item.manual) return name;
  const m = OLD_ITEM_NAME.exec(String(name == null ? "" : name));
  if (!m) return name;
  return m[1] !== undefined ? supportFeeItemName(m[1]) : SUPPORT_FEE_LABEL;
}

module.exports = { SUPPORT_FEE_LABEL, supportFeeItemName, displaySupportFeeName };
