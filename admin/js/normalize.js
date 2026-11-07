// admin/js/normalize.js — メールアドレス・電話番号の全角を半角に直す（純粋関数）
// 正本。functions/normalize.js は同じ中身の CommonJS（scripts/test-normalize.mjs で同じ結果になることを検査）。
// 経緯: 2026-10-28 案件 #377 のメールが全角「＠」で登録され、見積書の送付が「宛先メールアドレスが不正です」で失敗した。
// 保存する直前・送信する直前に通す（表示だけ直さない）。

/** メール: NFKC（全角英数・＠・．など→半角）→ 空白をすべて除去 → trim。大文字小文字は変えない */
export function normalizeEmail(s) {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
}

/** 電話: NFKC → 長音・ダッシュ類を "-" → 空白除去 → 連続 "-" を1つに → 前後の "-" を除く。空白以外は消さない（内線表記を壊さない） */
export function normalizePhone(s) {
  return String(s ?? "").normalize("NFKC")
    .replace(/[ー−‐‑‒–—―－ｰ]/g, "-")
    .replace(/\s+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
