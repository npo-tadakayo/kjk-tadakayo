// 助成金の申請で入れる金額（A＝カードリーダー購入費用・B＝接続サポート等経費・X＝対象外）の振り分け。2026-11-12
// DOM にも firebase にも触れない純粋関数だけ（node の単体テスト scripts/test-subsidy-amounts.mjs から直接読む）。
//
// 使うところ（振り分けの正本はここ。画面ごとに自前で持たない）
//   ・supply-print.js renderReceipt     … 領収証の初期明細（receiptRowsFromShipment）
//   ・supply-print.js wireReceiptEditor … 区分ごとの税込小計の丸め方（taxFnsOf）
//   ・supply-print.js subsidyGuideData  … 請求書から送る「助成金申請の手順」の A・B（guideAmountsFromShipment）
//   ・case-detail.js 申請タブ            … 「申請で入れる値」のカード（caseSubsidyAmounts）
//
// 決定（次田さん 2026-11-12）
//   申1 正本: 領収証を発行済みなら領収証の保存値（receipts/{出荷ID}）、未発行なら出荷の明細。見積もりの金額は使わない
//   申2 補助対象外の追加台数: A と台数は補助対象分だけ。対象外の分は別の行に出す
//   申3 出荷が複数: 合計と出荷ごとの内訳
//   申4 申請情報の手入力の欄は残し、自動の値と違うときに知らせる（自動で書き込まない）
//
// 🔴 出荷のカードリーダーの行（sku cir*）は、補助対象の台数と対象外の台数を足した1行になっている
//   （functions の shipmentItemsFromQuote が subsidyQty＋extraQty をまとめる）。行だけでは区別できない。
//   区別には「補助対象の台数」を別に持っているものを使う: ①出荷の subsidyQty {bt, usb}（自動の伴走支援費のとき保存される）
//   ②出荷に紐づく見積もり（quotes）の items[].subsidyQty。どちらも無いときは推測で分けず「区別できない」と返す。
//   入金・消込（netPaidOf・billableInclOf など）には触れない。
// invoiceTotals は「領収金額の予定（請求額）」の表示のためだけに使う（請求書と同じ計算。入金・消込の関数は呼ばない）
import { priceIsTaxIncluded, itemPurposeNote, invoiceTotals } from "./invoice-doc.js";

export const BT_SKU = "cir415a-01"; // estimate-pricing.js の SKU.BT と同じ（BT 以外のカードリーダーは USB に数える）
const B_SKUS = ["support-fee", "discount"];
const isCanceled = (s) => ((s && s.status) || "shipped") === "canceled";
const num = (v) => Number(v) || 0;

// ===== 明細1行の用途区分 =====
// 伴走支援費（support-fee）と値引き（discount＝伴走支援費から引いている性格）は B、それ以外は A。
// 送料は明細の行ではなく shippingFee に入っているので、ここには来ない（X は receiptRowsFromShipment が足す）
export function usageOfItem(i) {
  return B_SKUS.includes(String((i && i.sku) || "")) ? "B" : "A";
}

// ===== 税込への直し方（領収証の画面と同じ丸め） =====
// 単価が税込のときは足さずに割り戻す。税抜のときは区分ごとの小計に1回だけ10%を足す
export function taxFnsOf(taxIncluded) {
  return taxIncluded
    ? { incl: (v) => v, taxOf: (v) => Math.floor(v * 10 / 110), exclOf: (v) => v - Math.floor(v * 10 / 110) }
    : { incl: (e) => e + Math.floor(e * 0.1), taxOf: (e) => Math.floor(e * 0.1), exclOf: (e) => e };
}

// ===== 領収証の初期明細（発行を記録する前） =====
// 戻り値: [{ kind:"A"|"B"|"X", name, note, qty, price }]。領収証の画面（renderReceipt）がそのまま使う
export function receiptRowsFromShipment(s) {
  const items = (s && s.items) || [];
  const rows = items.map((i) => {
    const sku = String(i.sku || "");
    const qty = Number(i.qty) || 0, price = Number(i.unitPrice) || 0;
    const note = itemPurposeNote(sku);
    if (sku === "support-fee") return { kind: "B", name: i.name || "介護情報基盤との接続サポート等経費", note, qty, price };
    // 値引き（金額調整）は伴走支援費から引いている性格なのでBに入れる。
    // これでA＋B＝実際にお支払いいただいた額＝助成金の申請対象額になる
    if (sku === "discount") return { kind: "B", name: i.name || "値引き", note: "", qty, price };
    return { kind: "A",
      name: i.sku ? `カードリーダー（型名: ${i.sku}・マイナ資格確認アプリ対応）` : (i.name || "カードリーダー"),
      note, qty, price };
  });
  if (Number(s && s.shippingFee) > 0) rows.push({ kind: "X", name: s.shippingLabel || "送料", qty: 1, price: Number(s.shippingFee) }); // 税抜で保存（2026-07-28 統一）
  return rows;
}

// 明細（{kind, qty, price}）→ 区分ごとの税込小計 { A, B, X }。領収証の画面の aIncl・bIncl・xIncl と同じ値
export function usageTotalsOf(rows, taxIncluded) {
  const { incl } = taxFnsOf(taxIncluded);
  const sub = { A: 0, B: 0, X: 0 };
  for (const r of rows || []) { const k = (r && r.kind) || "A"; sub[k] = (sub[k] || 0) + num(r.qty) * num(r.price); }
  return { A: incl(sub.A), B: incl(sub.B), X: incl(sub.X) };
}

// ===== 請求書から送る「助成金申請の手順」の A・B（領収証の明細欄が無いとき） =====
// 在庫を動かさない行（nonStock）のうち B でないものは A に数えない（これまでの subsidyGuideData と同じ）
export function guideAmountsFromShipment(d) {
  const items = (d && d.items) || [];
  const incl = taxFnsOf(priceIsTaxIncluded(d)).incl;
  const line = (i) => num(i.qty) * num(i.unitPrice);
  const aItems = items.filter((i) => usageOfItem(i) === "A" && !i.nonStock);
  const bItems = items.filter((i) => usageOfItem(i) === "B");
  return {
    aIncl: incl(aItems.reduce((n, i) => n + line(i), 0)),
    bIncl: incl(bItems.reduce((n, i) => n + line(i), 0)),
    units: aItems.reduce((n, i) => n + num(i.qty), 0),
    readerName: [...new Set(aItems.map((i) => i.sku).filter(Boolean))].join("／"),
  };
}

// ===== 補助対象の台数（区別に使う） =====
// 出荷の subsidyQty は「自動の伴走支援費」のときだけ台数が入る。任意の金額の伴走支援費・伴走支援費なしは {0,0} で、
// 「0台」ではなく「保存していない」なので使わない
export function subsidyCountsFromShipment(s) {
  const q = s && s.subsidyQty;
  if (!q || typeof q !== "object") return null;
  const bt = num(q.bt), usb = num(q.usb);
  if (bt + usb <= 0) return null;
  const hasAutoFee = ((s && s.items) || []).some((i) => i && i.sku === "support-fee" && !i.manual);
  if (!hasAutoFee) return null;
  return { bt, usb, from: "出荷の補助対象台数" };
}
// 見積もり（quotes）の items[{sku, subsidyQty, extraQty}] → 補助対象の台数。金額は使わない（台数だけ）
export function subsidyCountsFromQuote(q) {
  const items = (q && Array.isArray(q.items)) ? q.items : null;
  if (!items || !items.length) return null;
  const bt = items.filter((i) => i && i.sku === BT_SKU).reduce((a, i) => a + num(i.subsidyQty), 0);
  const usb = items.filter((i) => i && i.sku !== BT_SKU).reduce((a, i) => a + num(i.subsidyQty), 0);
  if (bt + usb <= 0) return null;
  return { bt, usb, from: q.estNo ? `見積もり ${q.estNo} の補助対象台数` : "見積もりの補助対象台数" };
}

// ===== 出荷1件の「申請で入れる値」 =====
// s: 出荷 ／ receipt: receipts/{出荷ID}（無ければ null）／ counts: 補助対象の台数 {bt, usb, from}（無ければ null）
// 戻り値の split:
//   "none"     … 対象外の台数は無い（A は全部が補助対象）
//   "split"    … 対象外の台数を分けた（aSubsidy＋aExtra＝A）
//   "unknown"  … 補助対象の台数が分からない／明細と合わないので分けていない（aSubsidy は null）
export function shipmentSubsidyAmounts(s, receipt = null, counts = null) {
  const taxIncl = priceIsTaxIncluded(s);
  const { incl } = taxFnsOf(taxIncl);
  const fromReceipt = !!(receipt && (receipt.usageTotalsIncl || Array.isArray(receipt.items)));
  const rows = fromReceipt
    ? (receipt.items || []).map((r) => ({ kind: r.usage || "A", name: r.name || "", qty: num(r.qty), price: num(r.unitPrice) }))
    : receiptRowsFromShipment(s);
  const computed = usageTotalsOf(rows, taxIncl);
  const totals = fromReceipt && receipt.usageTotalsIncl
    ? { A: num(receipt.usageTotalsIncl.A), B: num(receipt.usageTotalsIncl.B), X: num(receipt.usageTotalsIncl.X) }
    : computed;

  // 機種と台数は出荷の明細から（領収証の品名には型名が文章で入るだけなので）
  const readers = ((s && s.items) || []).filter((i) => i && usageOfItem(i) === "A" && !i.nonStock && num(i.qty) > 0);
  const skuQty = {};
  for (const i of readers) skuQty[i.sku || "（品番なし）"] = (skuQty[i.sku || "（品番なし）"] || 0) + num(i.qty);
  const btRows = readers.filter((i) => i.sku === BT_SKU), usbRows = readers.filter((i) => i.sku !== BT_SKU);
  const btQty = btRows.reduce((a, i) => a + num(i.qty), 0), usbQty = usbRows.reduce((a, i) => a + num(i.qty), 0);
  const units = btQty + usbQty;
  const aRowsQty = rows.filter((r) => r.kind === "A").reduce((a, r) => a + num(r.qty), 0);

  let split = "none", reason = "", subsidyUnits = units, extraUnits = 0, aSubsidy = totals.A, aExtra = 0;
  const extraBt = counts ? btQty - num(counts.bt) : 0, extraUsb = counts ? usbQty - num(counts.usb) : 0;
  const onePrice = (list) => { const ps = [...new Set(list.map((i) => num(i.unitPrice)))]; return ps.length === 1 ? ps[0] : null; };
  if (!counts) {
    split = "unknown";
    reason = "補助対象の台数が出荷にも見積もりにも保存されていないため、補助対象外の追加台数があるかどうかを区別できません";
  } else if (extraBt < 0 || extraUsb < 0) {
    split = "unknown";
    reason = `${counts.from}（Bluetooth ${num(counts.bt)}台・USB ${num(counts.usb)}台）が出荷の台数（Bluetooth ${btQty}台・USB ${usbQty}台）より多く、区別できません`;
  } else if (fromReceipt && aRowsQty !== units) {
    split = "unknown";
    reason = `領収証のカードリーダーの台数（${aRowsQty}台）が出荷の台数（${units}台）と違うため、区別できません`;
  } else if (extraBt + extraUsb > 0) {
    // 単価: 領収証が正本のときは領収証の A 行の単価（発行のときに直していることがあるため。出荷の単価は使わない）。
    //   領収証の A 行には品番が無く機種ごとに分けられないので、A 行の単価が1種類のときだけ使う。
    //   出荷の明細が正本のときは、機種ごとに出荷の行の単価（それぞれ1種類のときだけ）
    let pBt, pUsb, priceReason;
    if (fromReceipt) {
      const ps = [...new Set(rows.filter((r) => r.kind === "A" && num(r.qty) > 0).map((r) => num(r.price)))];
      pBt = pUsb = ps.length === 1 ? ps[0] : null;
      priceReason = "領収証のカードリーダーの行の単価が1種類でないため、対象外の分の金額を区別できません";
    } else {
      pBt = extraBt > 0 ? onePrice(btRows) : 0; pUsb = extraUsb > 0 ? onePrice(usbRows) : 0;
      priceReason = "同じ種類のカードリーダーに単価の違う行があり、対象外の分の金額を区別できません";
    }
    if (pBt === null || pUsb === null) {
      split = "unknown";
      reason = priceReason;
    } else {
      // 区分Aの小計（税込みに直す前）から対象外の分を引き、領収証と同じ丸めで税込みに直す。aSubsidy＋aExtra＝A になる
      const aRaw = rows.filter((r) => r.kind === "A").reduce((a, r) => a + num(r.qty) * num(r.price), 0);
      const extraRaw = extraBt * pBt + extraUsb * pUsb;
      aSubsidy = incl(aRaw - extraRaw);
      aExtra = totals.A - aSubsidy;
      split = "split"; subsidyUnits = units - extraBt - extraUsb; extraUnits = extraBt + extraUsb;
    }
  }
  if (split === "unknown") { aSubsidy = null; aExtra = null; subsidyUnits = null; extraUnits = null; }
  return {
    shipmentId: (s && (s._id || s.id)) || "", soNumber: (s && s.soNumber) || "", status: (s && s.status) || "shipped",
    source: fromReceipt ? "receipt" : "shipment",
    receiptNo: fromReceipt ? (receipt.receiptNo || (s && s.receiptNo) || "") : "",
    receiptAmountIncl: fromReceipt ? num(receipt.amountIncl || (s && s.receiptAmountIncl)) : null,
    // 領収証が未発行のときの「領収金額の予定」＝請求書と同じ請求額（送料の消費税・過入金の充当を含む）。A・B には関係しない
    plannedIncl: fromReceipt ? null : invoiceTotals(s).payable,
    taxIncluded: taxIncl,
    aTotal: totals.A, aSubsidy, aExtra, b: totals.B, x: totals.X,
    ab: aSubsidy === null ? null : aSubsidy + totals.B,
    units, subsidyUnits, extraUnits, skuQty,
    split, reason, countsFrom: counts ? counts.from : "",
  };
}

// 出荷の元（どの値を使ったか）を人が読める1行に
export function sourceText(r) {
  return r.source === "receipt"
    ? `領収証 No.${r.receiptNo || "（番号なし）"} の値`
    : `出荷 ${r.soNumber || "（番号なし）"} の明細（領収証は未発行）`;
}

// ===== 案件の「申請で入れる値」（出荷が複数なら合計＋内訳） =====
// shipments: 案件の出荷 ／ receiptsById: { 出荷ID: receipt } ／ countsById: { 出荷ID: counts }（出荷に無いとき見積もりから補ったもの）
// plan: { limit, label }（助成区分の上限。分からなければ null）
export function caseSubsidyAmounts(shipments, { receiptsById = {}, countsById = {}, plan = null } = {}) {
  const live = (shipments || []).filter((s) => s && !isCanceled(s));
  const rows = live.map((s) => {
    const id = s._id || s.id || "";
    const counts = subsidyCountsFromShipment(s) || countsById[id] || null;
    return shipmentSubsidyAmounts(s, receiptsById[id] || null, counts);
  });
  const known = rows.length > 0 && rows.every((r) => r.split !== "unknown");
  const sum = (k) => rows.reduce((a, r) => a + num(r[k]), 0);
  const total = {
    aTotal: sum("aTotal"), b: sum("b"), x: sum("x"), units: sum("units"),
    aSubsidy: known ? sum("aSubsidy") : null, aExtra: known ? sum("aExtra") : null,
    subsidyUnits: known ? sum("subsidyUnits") : null, extraUnits: known ? sum("extraUnits") : null,
  };
  total.ab = known ? total.aSubsidy + total.b : null;
  // 領収金額: 発行済みの出荷は領収証の額、未発行の出荷は請求額（予定）。それぞれの合計と件数
  const unissued = rows.filter((r) => r.plannedIncl !== null), issued = rows.filter((r) => r.receiptAmountIncl !== null);
  total.plannedIncl = unissued.length ? unissued.reduce((a, r) => a + num(r.plannedIncl), 0) : null;
  total.plannedCount = unissued.length;
  total.receiptAmountIncl = issued.length ? issued.reduce((a, r) => a + num(r.receiptAmountIncl), 0) : null;
  total.receiptCount = issued.length;
  // 交付見込み＝A＋B と助成区分の上限の小さい方（estimate-pricing.js の grantAmt と同じ考え方）
  total.grant = (known && plan && num(plan.limit) > 0) ? Math.min(num(plan.limit), total.ab) : null;
  const skuQty = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.skuQty)) skuQty[k] = (skuQty[k] || 0) + v;
  total.skuQty = skuQty;
  const dropship = rows.some((r) => !r.taxIncluded);
  return { rows, total, known, plan, dropship, canceledCount: (shipments || []).filter((s) => s && isCanceled(s)).length };
}

// ===== 手入力の欄と自動の値の突き合わせ（申4） =====
// inputs: { cardReaderCost, supportCost, grantAmount }（画面の欄の値。空は比べない）
// 戻り値: { cardReaderCost: {auto, text} | null, ... }。違う欄だけ値が入る。自動の値が出せない欄は比べない
export function inputMismatches(inputs, result) {
  const out = { cardReaderCost: null, supportCost: null, grantAmount: null };
  if (!result || !result.rows || !result.rows.length) return out;
  const word = result.rows.every((r) => r.source === "receipt") ? "領収証"
    : result.rows.every((r) => r.source === "shipment") ? "出荷の明細" : "領収証と出荷の明細";
  const t = result.total;
  const check = (key, auto, label) => {
    const raw = inputs && inputs[key];
    if (raw === null || raw === undefined || String(raw).trim() === "" || auto === null || auto === undefined) return;
    const v = Number(String(raw).replace(/[,，¥￥円\s]/g, ""));
    if (!Number.isFinite(v) || v === auto) return;
    out[key] = { auto, text: `${word}の${label}は ¥${auto.toLocaleString("ja-JP")} です（この欄は ¥${v.toLocaleString("ja-JP")}）` };
  };
  check("cardReaderCost", t.aSubsidy, "値（A・補助対象分）");
  check("supportCost", t.b, "値（B）");
  // 交付額は決定後に見込みと正当に違うことがあるので、文言を変える（黄色は出す）
  const g = inputs && inputs.grantAmount;
  if (!(g === null || g === undefined || String(g).trim() === "") && t.grant !== null && t.grant !== undefined) {
    const v = Number(String(g).replace(/[,，¥￥円\s]/g, ""));
    if (Number.isFinite(v) && v !== t.grant) {
      out.grantAmount = { auto: t.grant, text: `交付見込み（¥${t.grant.toLocaleString("ja-JP")}）と違います。決定通知の額なら、このままで大丈夫です` };
    }
  }
  return out;
}
