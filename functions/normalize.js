// functions/normalize.js — admin/js/normalize.js と同じ規則の CommonJS 版（正本は admin 側）。
// 同じ結果になることは scripts/test-normalize.mjs が同じケースで検査する。
function normalizeEmail(s) {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
}
function normalizePhone(s) {
  return String(s ?? "").normalize("NFKC")
    .replace(/[ー−‐‑‒–—―－ｰ]/g, "-")
    .replace(/\s+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
module.exports = { normalizeEmail, normalizePhone };
