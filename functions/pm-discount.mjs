// 接続サポート等経費（伴走支援費）の PM 値引きの判定（純粋 ESM・2026-11-13）。
// firebase を import しない（node の単体テスト scripts/test-pm-discount.mjs と Functions から直接読むため）。
// ⚠️ 正本はこのファイル。functions/pm-discount.mjs はバイト単位で同じコピー（scripts/check-shared-sync.sh で照合）。
//    直したら cp admin/js/pm-discount.js functions/pm-discount.mjs で揃える。
//
// 決めごと（PM 提案 2026-11-13・設計は ENGINEERING_NOTES.md §C15）
//   ・標準額（上限 − 機器代＝助成金の内訳 B「接続サポート等経費」）は変えない。値引きは別の項目で、あとから引く
//   ・入れられるのは管理者だけ（サーバーの setQuoteDiscount・setShipmentDiscount が requireStaff allow:"admin" で確かめる）
//   ・理由は必須（500字まで）。値引き後の伴走支援費は0円以上（標準額を超える値引きはエラー）
//   ・値引き後が報酬の下限（FLOOR）を下回るときは、画面で警告して確認を取る。サーバーは止めずに belowFloor を記録する
//   ・明細の行は既存の sku "discount" を使い直す（請求書・領収証・申請の手順書で B に入り、倉庫・在庫・台数から外れる扱いが
//     そのまま効く）。自動の「金額調整」の行とは pm:true で区別する。値引きの行は1出荷・1見積もりに1行まで
//   ・見積もりの computeAmounts（estimate-pricing.js）は変えない。値引きは amounts.pmDiscount に持ち、合計などを値引き後にする
//   ・値引きは税込（事業所向け）の出荷だけ（認定事業者向け＝税抜の卸には入れない）

export const PM_DISCOUNT_SKU = "discount";
export const PM_DISCOUNT_NAME = "接続サポート等経費（伴走支援費）の値引き";
export const FLOOR = 15000;          // 報酬の下限（税込）。これを下回る値引きは確認を取る
export const MAX_REASON = 500;
const B_SKUS = ["support-fee", "discount"];

const num = (v) => Number(v) || 0;
export function yenText(n) {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? "−" : ""}¥${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// ===== 明細の見分け =====
export function isPmRow(i) {
  return !!i && String(i.sku || "") === PM_DISCOUNT_SKU && i.pm === true;
}
export function pmRows(items) {
  return (Array.isArray(items) ? items : []).filter(isPmRow);
}
export function withoutPmRows(items) {
  return (Array.isArray(items) ? items : []).filter((i) => !isPmRow(i));
}
// 明細の値引きの額（正の数）。値引きの行が無ければ 0
export function pmAmountOfItems(items) {
  return pmRows(items).reduce((a, i) => a + Math.max(0, -num(i.qty || 1) * num(i.unitPrice)), 0);
}

// ===== 標準額（値引き前の B の合計） =====
// 出荷の明細: 伴走支援費（自動・任意）＋ 金額調整（自動）の合計。値引きの行（pm:true）は数えない
export function standardFeeOf(items) {
  return withoutPmRows(items).reduce((a, i) => {
    if (!i || !B_SKUS.includes(String(i.sku || ""))) return a;
    return a + num(i.qty) * num(i.unitPrice);
  }, 0);
}
// 見積もりの金額（値引き前の computeAmounts の結果、または quotes.amounts）: 伴走支援費 − 金額調整
export function standardFeeOfAmounts(a) {
  const x = a || {};
  return num(x.accompanyFee) - num(x.discount);
}

// ===== 入力の検査 =====
// amount … 値引きの額（税込・整数円）。remove:true のときは外す（amount は見ない）
// 戻り値 { ok, errors[], amount, reason, standardFee, feeAfter, belowFloor }
export function validatePmDiscount({ amount, reason, standardFee, remove = false } = {}) {
  const errors = [];
  const rs = String(reason ?? "").trim();
  if (!rs) errors.push("値引きの理由を入れてください（あとから経緯を追えるようにするためです）");
  else if (rs.length > MAX_REASON) errors.push(`理由は${MAX_REASON}文字以内にしてください`);
  const std = Number(standardFee);
  if (!Number.isFinite(std) || std <= 0) errors.push("伴走支援費（標準額）が無いため、値引きを入れられません");
  let amt = 0;
  if (!remove) {
    amt = typeof amount === "string" && /^\s*\d+\s*$/.test(amount) ? Number(amount) : Number(amount);
    if (!Number.isInteger(amt) || amt < 1) { errors.push("値引きの額は1円以上の整数（税込）で入れてください"); amt = 0; }
    else if (Number.isFinite(std) && amt > std) {
      errors.push(`値引きが伴走支援費の標準額（${yenText(std)}）を超えています。値引き後の伴走支援費はマイナスにできません`);
    }
  }
  const feeAfter = Number.isFinite(std) ? std - amt : 0;
  const fc = floorCheck(feeAfter);
  return { ok: errors.length === 0, errors, amount: amt, reason: rs.slice(0, MAX_REASON),
    standardFee: Number.isFinite(std) ? std : 0, feeAfter, belowFloor: !remove && fc.belowFloor };
}

// 値引き後の伴走支援費が報酬の下限を下回るか（0円までは入れられる。警告と確認だけ）
export function floorCheck(feeAfter) {
  return { belowFloor: num(feeAfter) < FLOOR, floor: FLOOR };
}

// ===== 明細の行・金額 =====
export function pmDiscountRow(amount) {
  return { sku: PM_DISCOUNT_SKU, pm: true, name: PM_DISCOUNT_NAME, qty: 1, unitPrice: -Math.abs(num(amount)), nonStock: true };
}

// 値引き前の見積もりの金額（computeAmounts から作った quotes.amounts の形）に値引きを当てる。pm が 0 なら pmDiscount を外した形を返す。
// 補助対象パート・合計・助成金充当を値引き後にする。自己負担は「補助対象パート − 助成金充当 ＋ 補助対象外」で出し直す
// （補助対象パートは助成金の上限以下なので、値引きしても自己負担は変わらない）
export function applyToAmounts(amounts, pm) {
  const a = { ...(amounts || {}) };
  delete a.pmDiscount;
  const p = Math.max(0, Math.round(num(pm)));
  if (!p) return a;
  const spt = num(a.subsidyPartTotal) - p;
  const grant = Math.min(num(a.grantAmt), spt);
  return { ...a, pmDiscount: p, subsidyPartTotal: spt, totalIncl: num(a.totalIncl) - p, grantAmt: grant,
    selfPay: Math.max(0, spt - grant) + num(a.extraPartTotal) };
}

// 値引きの記録（quotes.pmDiscount・shipments.pmDiscount）。時刻（at）はサーバーが serverTimestamp で足す
export function buildPmRecord({ amount, reason, standardFee, byEmail, byName } = {}) {
  const amt = num(amount), std = num(standardFee);
  return { amount: amt, reason: String(reason ?? "").trim().slice(0, MAX_REASON), standardFee: std, feeAfter: std - amt,
    belowFloor: floorCheck(std - amt).belowFloor, byEmail: String(byEmail || ""), byName: String(byName || byEmail || "") };
}

// ===== 保存前の検査（値引きの行と記録が合っているか・二重に引いていないか） =====
// items … 保存する明細の全部。pmMeta … 出荷・見積もりの pmDiscount の記録（無ければ null）
// 戻り値 { ok, errors[] }
export function checkPmRows(items, pmMeta) {
  const errors = [];
  const rows = pmRows(items);
  if (rows.length > 1) errors.push("伴走支援費の値引きの行は1つまでです（二重に引いています）");
  const metaAmt = pmMeta && num(pmMeta.amount) > 0 ? num(pmMeta.amount) : 0;
  if (rows.length) {
    const r = rows[0];
    if (num(r.qty) !== 1 || !r.nonStock || !(num(r.unitPrice) < 0)) errors.push("伴走支援費の値引きの行の形が正しくありません");
    if (!metaAmt) errors.push("伴走支援費の値引きの行に、値引きの記録（判断した人・理由）がありません");
    else if (-num(r.unitPrice) !== metaAmt) errors.push(`伴走支援費の値引きの行（${yenText(-num(r.unitPrice))}）と記録（${yenText(metaAmt)}）が合いません`);
  } else if (metaAmt) {
    errors.push("値引きの記録があるのに、値引きの行がありません（行が消えています）");
  }
  if (rows.length) {
    const after = standardFeeOf(items) - pmAmountOfItems(items);
    if (after < 0) errors.push(`値引き後の伴走支援費がマイナスになります（標準額 ${yenText(standardFeeOf(items))}・値引き ${yenText(pmAmountOfItems(items))}）。先に値引きを外すか額を直してください`);
  }
  return { ok: errors.length === 0, errors };
}

// 出荷に値引きを入れられるか（事業所向け＝税込の出荷だけ）
export function pmApplicableShipment(s) {
  return !!s && !(s.shipType === "dropship" || s.partnerEmail);
}

// ===== 案件の活動（対応記録）の件名・本文 =====
// target … 「見積もり EST-2026-0001 v3」「出荷 SH-2026-0001」など。prevAmount … 前の値引き（無ければ 0）
// rec … buildPmRecord の結果（外すときは null）
export function pmActivityText({ target = "", prevAmount = 0, rec = null, reason = "", byName = "" } = {}) {
  const prev = num(prevAmount);
  const where = target ? `（${target}）` : "";
  if (!rec || !(num(rec.amount) > 0)) {
    return { subject: `伴走支援費の値引きを外した（${yenText(prev)}）${where}`,
      body: [`理由: ${String(reason).trim()}`, byName ? `判断: ${byName}` : ""].filter(Boolean).join("\n") };
  }
  const head = prev > 0 && prev !== num(rec.amount)
    ? `伴走支援費の値引きを変更（${yenText(prev)} → ${yenText(rec.amount)}・標準 ${yenText(rec.standardFee)} → ${yenText(rec.feeAfter)}）`
    : `伴走支援費を値引き（${yenText(rec.amount)}・標準 ${yenText(rec.standardFee)} → ${yenText(rec.feeAfter)}）`;
  return {
    subject: `${rec.belowFloor ? "⚠ " : ""}${head}${where}`,
    body: [
      `理由: ${rec.reason}`,
      `判断: ${rec.byName || rec.byEmail}${rec.byEmail && rec.byName && rec.byName !== rec.byEmail ? `（${rec.byEmail}）` : ""}`,
      rec.belowFloor
        ? `⚠ 値引き後の伴走支援費 ${yenText(rec.feeAfter)} は、報酬の下限 ${yenText(FLOOR)} を下回ります（承知のうえで入れました）`
        : `値引き後の伴走支援費は報酬の下限 ${yenText(FLOOR)} 以上です`,
    ].join("\n"),
  };
}
// 台数・区分を変えて見積もりを作り直したとき（reviseQuote）に、値引きが外れたことを残す1行
export function pmRemovedByReviseText(amount) {
  return `伴走支援費の値引き（${yenText(amount)}）は外れました（台数・区分が変わったため。必要なら管理者が入れ直してください）`;
}
