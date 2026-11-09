// 出荷の「伴走支援費を任意の金額で入れる行」の判定（検証・上限の計算・排他・明細の組み立て）。2026-11-09
// DOM にも firebase にも触れない純粋関数だけ（node の単体テスト scripts/test-manual-support-fee.mjs から直接読む）。
// 画面（supply.js）はここを正本として使い、判定を自前に持たない。
// 設計: docs/設計_伴走支援費の任意行_20261109.md（§3.1 データ／§3.2 排他／§3.4b 上限）
//
// 明細の形（自動の伴走支援費と同じ sku "support-fee" を使う。請求書のB区分・在庫を動かさない扱い・請求書の文言が
// そのまま効くので、それらの既存判定は変えない）:
//   { sku:"support-fee", name:"伴走支援費", qty:1, unitPrice:<税込・整数円>, nonStock:true,
//     manual:true, manualBy:<メール>, manualAt:<ISO>, priorBuyerReaderCost:<任意・整数円>, manualMemo:<任意> }
// 自動の行は manual が無い。伴走支援費の行（sku "support-fee"）は、自動・任意を問わず1出荷に最大1行。

export const SUPPORT_FEE_SKU = "support-fee";
export const DEFAULT_MANUAL_NAME = "伴走支援費";
export const MAX_NAME_LENGTH = 60;
export const MAX_MEMO_LENGTH = 200;

export const MSG = {
  autoPresent: "自動の伴走支援費が入っているため、任意の金額は追加できません（先に自動のチェックを外してください）",
  manualPresent: "任意の金額の伴走支援費が入っているため、自動の伴走支援費は使えません（先に任意のチェックを外してください）",
  limitUnknown: "助成区分を選んでください（区分で入力できる上限が決まります）",
};

// ===== 数値の読み取り =====
// 整数の円だけ受け付ける。"30,200"・"¥30200"・全角数字は読める。小数・負数・空・数字以外は NaN
export function parseYen(v) {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : NaN;
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s円¥￥]/g, "");
  return /^\d+$/.test(s) ? Number(s) : NaN;
}
const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
export function yenText(n) { return `¥${Number(n).toLocaleString("ja-JP")}`; }

// ===== 明細の見分け =====
export function supportFeeRows(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && String(i.sku || "") === SUPPORT_FEE_SKU);
}
export function hasAutoSupportFee(items) { return supportFeeRows(items).some((i) => !i.manual); }
export function hasManualSupportFee(items) { return supportFeeRows(items).some((i) => !!i.manual); }

// カードリーダーの購入費（同じ出荷の明細のうち、readerSkus に入る品番の 数量×単価）。在庫を使わない行は数えない
export function readerCostOf(items, readerSkus) {
  const set = new Set(readerSkus || []);
  return (Array.isArray(items) ? items : []).reduce((a, i) => {
    if (!i || i.nonStock || !set.has(String(i.sku || ""))) return a;
    const q = Number(i.qty) || 0;
    return q > 0 ? a + q * (Number(i.unitPrice) || 0) : a;
  }, 0);
}

// ===== 排他（自動があれば任意は追加不可・逆も同じ） =====
// autoOn / manualOn は画面のチェック、locked は金額がロックされた状態（請求書を出した後など）。
// disabled は「操作できない」、reason はその理由（無効でないときは空）。自動で相手を消すことはしない
export function exclusion({ autoOn, manualOn, locked } = {}) {
  return {
    manualDisabled: !!locked || !!autoOn,
    manualReason: autoOn ? MSG.autoPresent : "",
    autoDisabled: !!locked || !!manualOn,
    autoReason: manualOn ? MSG.manualPresent : "",
  };
}

// ===== 上限 =====
// 上限 = 助成区分の上限 −（先方が購入したカードリーダー費用 ＋ 同じ出荷のカードリーダー購入費）。
// planLimit が無い（区分未選択）ときは known:false＝上限を確認できない（画面は警告だけにする）
export function manualLimit({ planLimit, priorBuyerReaderCost, readerCost } = {}) {
  const pl = Number(planLimit);
  const prior = isBlank(priorBuyerReaderCost) ? 0 : parseYen(priorBuyerReaderCost);
  const reader = Number(readerCost) > 0 ? Number(readerCost) : 0;
  if (!(pl > 0)) return { known: false, limit: null, planLimit: null, prior: Number.isNaN(prior) ? 0 : prior, reader };
  const p = Number.isNaN(prior) ? 0 : prior;
  return { known: true, limit: Math.max(0, pl - p - reader), planLimit: pl, prior: p, reader };
}
export function limitText(lim) {
  if (!lim || !lim.known) return "入力できる上限：未確定（助成区分を選ぶと表示します）";
  return `入力できる上限：${yenText(lim.limit)}`;
}

// ===== 入力の検査（画面の入力欄の値を渡す） =====
// 戻り値 { ok, errors[], warnings[], amount, name, prior, limit }。ok でなければ保存できない
export function validateManual({ amount, name, priorBuyerReaderCost, planLimit, readerCost } = {}) {
  const errors = [], warnings = [];
  const nm = String(name ?? "").trim();
  if (!nm) errors.push("品名を入力してください");
  else if (nm.length > MAX_NAME_LENGTH) errors.push(`品名は${MAX_NAME_LENGTH}文字以内にしてください`);

  const amt = parseYen(amount);
  if (isBlank(amount)) errors.push("金額（税込）を入力してください");
  else if (Number.isNaN(amt) || amt < 1) errors.push("金額は1円以上の整数（税込）で入力してください");

  let prior = null;
  if (!isBlank(priorBuyerReaderCost)) {
    prior = parseYen(priorBuyerReaderCost);
    if (Number.isNaN(prior)) { errors.push("先方が購入したカードリーダー費用は0円以上の整数で入力してください"); prior = null; }
  }

  const limit = manualLimit({ planLimit, priorBuyerReaderCost: prior === null ? "" : prior, readerCost });
  if (limit.known) {
    if (!Number.isNaN(amt) && amt >= 1 && amt > limit.limit) {
      errors.push(limit.limit > 0
        ? `金額が上限を超えています。入力できる上限は ${yenText(limit.limit)} です`
          + `（助成区分の上限 ${yenText(limit.planLimit)} − カードリーダー購入費 ${yenText(limit.prior + limit.reader)}）`
        : `上限が0円のため、伴走支援費は入れられません（助成区分の上限 ${yenText(limit.planLimit)} − カードリーダー購入費 ${yenText(limit.prior + limit.reader)}）`);
    }
  } else {
    // 区分が未選択だと上限が決まらず、上限を超える金額を止められない。区分を選ぶまで保存できない（2026-11-09 レビュー指摘）
    errors.push(MSG.limitUnknown);
  }
  return { ok: errors.length === 0, errors, warnings,
    amount: Number.isNaN(amt) ? null : amt, name: nm, prior, limit };
}

// ===== 明細の組み立て =====
// 金額・品名が読めないときは null（画面の合計表示用。保存の可否は validateManual が決める）
export function buildManualItem({ amount, name, priorBuyerReaderCost, memo, by, at } = {}) {
  const amt = parseYen(amount);
  const nm = String(name ?? "").trim();
  if (Number.isNaN(amt) || amt < 1 || !nm) return null;
  const item = { sku: SUPPORT_FEE_SKU, name: nm, qty: 1, unitPrice: amt, nonStock: true, manual: true,
    manualBy: String(by || ""), manualAt: at || new Date().toISOString() };
  const prior = isBlank(priorBuyerReaderCost) ? NaN : parseYen(priorBuyerReaderCost);
  if (!Number.isNaN(prior)) item.priorBuyerReaderCost = prior;
  const mm = String(memo ?? "").trim().slice(0, MAX_MEMO_LENGTH);
  if (mm) item.manualMemo = mm;
  return item;
}

// 修正で開いたとき、保存済みの任意行から入力欄の値を戻す
export function manualFormFromItems(items) {
  const row = supportFeeRows(items).find((i) => i.manual);
  if (!row) return null;
  return { amount: Number(row.unitPrice) || 0, name: row.name || DEFAULT_MANUAL_NAME,
    priorBuyerReaderCost: row.priorBuyerReaderCost ?? "", memo: row.manualMemo || "",
    manualBy: row.manualBy || "", manualAt: row.manualAt || "" };
}

// ===== 保存時の検査（画面の検査だけに頼らない。保存する明細そのものを検べる） =====
// items … 保存する明細の全部。planLimit … 助成区分の上限（未選択は null）。readerSkus … カードリーダーの品番
// 戻り値 { ok, errors[] }。次を満たさなければ保存しない:
//   ・伴走支援費の行（sku "support-fee"）は最大1行（自動・任意を問わない＝二重計上の防止）
//   ・任意の行の形（数量1・在庫を使わない・金額は1円以上の整数・品名あり）
//   ・任意の行があるときは助成区分が必要（planLimit が無ければ拒否）で、金額は上限以下
export function checkSupportFeeRows(items, { planLimit, readerSkus } = {}) {
  const errors = [];
  const rows = supportFeeRows(items);
  if (rows.length > 1) errors.push("伴走支援費の行は1出荷に1行までです（自動と任意を同時に入れられません）");
  const manual = rows.filter((r) => r.manual);
  if (manual.length > 1) errors.push("任意の金額の伴走支援費は1出荷に1行までです");
  for (const r of manual) {
    const amt = parseYen(r.unitPrice);
    if (Number.isNaN(amt) || amt < 1) errors.push("任意の伴走支援費の金額は1円以上の整数（税込）にしてください");
    if (Number(r.qty) !== 1) errors.push("任意の伴走支援費の数量は1にしてください");
    if (!r.nonStock) errors.push("任意の伴走支援費は在庫を動かさない行にしてください");
    if (!String(r.name || "").trim()) errors.push("任意の伴走支援費の品名を入力してください");
    if (!(Number(planLimit) > 0)) errors.push(MSG.limitUnknown);
    const rest = (Array.isArray(items) ? items : []).filter((i) => i !== r);
    const lim = manualLimit({ planLimit, priorBuyerReaderCost: r.priorBuyerReaderCost ?? "", readerCost: readerCostOf(rest, readerSkus) });
    if (lim.known && !Number.isNaN(amt) && amt > lim.limit) {
      errors.push(`任意の伴走支援費が上限を超えています（入力できる上限 ${yenText(lim.limit)}・入力 ${yenText(amt)}）`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// 活動（案件の対応記録）の件名・本文。2026-11-09 次田さん決定の文言
export function manualActivityText(item, { removed } = {}) {
  if (removed) return { subject: "任意の伴走支援費を外した", body: "" };
  const lines = [];
  if (item.name && item.name !== DEFAULT_MANUAL_NAME) lines.push(`品名: ${item.name}`);
  if (item.priorBuyerReaderCost !== undefined) lines.push(`先方が購入したカードリーダー費用: ${yenText(item.priorBuyerReaderCost)}`);
  if (item.manualMemo) lines.push(`メモ: ${item.manualMemo}`);
  return { subject: `伴走支援費を任意の金額で設定（${yenText(item.unitPrice)}）`, body: lines.join("\n") };
}
