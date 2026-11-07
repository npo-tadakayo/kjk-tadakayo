// admin/js/case-contact.js — 案件の連絡先（担当者名・メール・電話）を直すときの、入力の確かめ方と記録の文面
// 純粋関数のみ（DOM・Firestore に触れない）。テスト: node scripts/test-case-contact.mjs
// 経緯: スタッフが自分のメールを案件に入れてしまい、直すのに管理者がデータベースを触る必要があった。
import { normalizeEmail, normalizePhone } from "./normalize.js";

// 直せる項目（画面の表示順）。label は活動メモと画面で使う
export const CONTACT_FIELDS = [
  { key: "contactName", label: "担当者名" },
  { key: "contactEmail", label: "メール" },
  { key: "contactPhone", label: "電話" },
];

export const CONTACT_NAME_MAX = 200;
export const CONTACT_PHONE_MAX = 50;

const s = (v) => (v == null ? "" : String(v)).trim();

// メールとして「ありそう」かだけを見る（1つの @・前に文字・ドメインに . がある・空白なし）。実在の確認はしない
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
export function isPlausibleEmail(v) { return EMAIL_RE.test(v); }

/**
 * 連絡先の変更を組み立てる。
 * current: いまの案件（contactName/contactEmail/contactPhone）／input: 画面で入れた値（入れなかった項目は現状のまま）
 * 戻り値: { ok:true, changes:{項目:{before,after}}, data:{変わった項目だけ} } または { ok:false, error }
 */
export function buildContactUpdate(current, input) {
  const cur = current || {};
  const inp = input || {};
  const before = {
    contactName: s(cur.contactName),
    contactEmail: normalizeEmail(cur.contactEmail),
    contactPhone: normalizePhone(cur.contactPhone),
  };
  const after = {
    contactName: "contactName" in inp ? s(inp.contactName) : before.contactName,
    contactEmail: "contactEmail" in inp ? normalizeEmail(inp.contactEmail) : before.contactEmail,
    contactPhone: "contactPhone" in inp ? normalizePhone(inp.contactPhone) : before.contactPhone,
  };
  if (after.contactName.length > CONTACT_NAME_MAX) {
    return { ok: false, error: `担当者名は${CONTACT_NAME_MAX}文字までです` };
  }
  if (after.contactEmail && !isPlausibleEmail(after.contactEmail)) {
    return { ok: false, error: "メールアドレスの形が正しくありません（例: example@care.jp）" };
  }
  if (after.contactPhone.length > CONTACT_PHONE_MAX) {
    return { ok: false, error: `電話は${CONTACT_PHONE_MAX}文字までです` };
  }
  const changes = {};
  const data = {};
  for (const { key } of CONTACT_FIELDS) {
    // 保存済みの値が全角などでも、直した値と見比べるのは直したあと同士（余計な変更扱いにしない）
    if (before[key] !== after[key]) { changes[key] = { before: before[key], after: after[key] }; data[key] = after[key]; }
  }
  if (!Object.keys(changes).length) return { ok: false, error: "変更がありません" };
  return { ok: true, changes, data };
}

/**
 * 活動メモ（memo）の件名と本文。
 * changes: buildContactUpdate の changes／quoteNos: 宛先も直した見積もり番号の配列（省略可）
 */
export function contactChangeActivity(changes, quoteNos = []) {
  const fields = CONTACT_FIELDS.filter((f) => changes && changes[f.key]);
  const show = (v) => (s(v) ? s(v) : "（空欄）");
  const lines = fields.map((f) => `${f.label}: ${show(changes[f.key].before)} → ${show(changes[f.key].after)}`);
  const nos = [...new Set((quoteNos || []).filter(Boolean))];
  if (nos.length) lines.push(`見積もりの宛先も直しました: ${nos.join("、")}`);
  return {
    subject: `連絡先を訂正（${fields.map((f) => f.label).join("・")}）`,
    body: lines.join("\n"),
  };
}

/**
 * 宛先も直す見積もりか。メールを直した案件で、旧メールのまま・まだ送っていない（mailedAt なし）ものだけ。
 * 送付済みの見積もりは「送った宛先」の記録なので触らない。
 */
export function quoteNeedsEmailFix(q, oldEmail) {
  const old = normalizeEmail(oldEmail);
  if (!old || !q) return false;
  return !q.mailedAt && normalizeEmail(q.contactEmail) === old;
}
