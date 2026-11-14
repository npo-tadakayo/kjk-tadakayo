// 助成金の内訳B「接続サポート等経費」の呼び名（正本・純粋 ESM・2026-11-15 次田さん決定＝ブランドポリシー）。
//
// 事業所に出る書類・画面・メール（請求書の品名・領収証・助成金の申請手順書・見積書・承諾書・見積もりページ）では、
// 「接続サポート等経費（伴走支援費）」と括弧書きで「伴走支援費」を必ず添える。
//   理由: 「接続サポート」だけだと業者が全部やるイメージになる（タダカヨは「共に設定する伴走支援」を伝えたい）。
//         一方、助成金の申請画面・領収書の用途は「接続サポート等経費」なので、事業所が照らし合わせられるよう残す。
// 社内の CRM 画面（出荷・見積もりの管理画面・活動の記録・Chat）は、これまでどおり「伴走支援費」でよい（SUPPORT_FEE_INTERNAL）。
//
// 写し（import できない場所は直書きして、scripts/test-support-fee-names.mjs で一致を確かめる）:
//   ・functions/index.js・functions/practice-seed.js の出荷の明細の品名（CommonJS から同期で使うため）
//   ・js/order-consent-page.js（公開ページ・外部を読み込まない）・mitsumori.html（公開ページ）
//   ・admin/js/pm-discount.js の PM_DISCOUNT_NAME（＝SUPPORT_FEE_LABEL＋「の値引き」。functions へバイト単位で写すので import しない）
//
// ⚠ 品名の文字列で行を見分けない。伴走支援費の行は sku "support-fee"（値引きは "discount"）で見分ける。
//   保存済みの出荷の品名（旧「伴走支援費（補助対象N台）」「伴走支援費」）はそのまま読める（書き換えない）。
//   supply.js の古い出荷の台数の逆引き（/補助対象(\d+)台/）が新しい品名でも効くよう「補助対象N台」は残す。

/** 事業所向けの呼び名（見積書・領収証・承諾書・見積もりページ） */
export const SUPPORT_FEE_LABEL = "接続サポート等経費（伴走支援費）";
/** 助成金の申請手順書で、申請画面の入力欄を指すときの呼び名 */
export const SUPPORT_FEE_GUIDE_FIELD = "介護情報基盤との接続サポート費用（伴走支援費）";
/** 領収証の集計欄・手順書の「領収証のどこか」（対象B） */
export const SUPPORT_FEE_TOTAL_LABEL = "接続サポート等経費（伴走支援費）の合計（対象B）";
/** 社内（CRM の管理画面・活動の記録）の呼び名。事業所向けの出力には使わない */
export const SUPPORT_FEE_INTERNAL = "伴走支援費";

/** 自動の伴走支援費の行の品名（請求書・領収証にそのまま出る）。n＝補助対象の台数 */
export function supportFeeItemName(n) {
  return `接続サポート等経費（伴走支援費・補助対象${n}台）`;
}
