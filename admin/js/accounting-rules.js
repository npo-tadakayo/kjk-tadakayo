// 経理への期末報告（決算の数字）の集計。純粋 ESM・firebase を import しない（node でテストする: scripts/test-accounting-rules.mjs）。
// 画面は admin/accounting.html ＋ admin/js/accounting.js、本番の読み取り答え合わせは scripts/accounting-snapshot.mjs。
// 2026-11-24 新設。仕様は ENGINEERING_NOTES.md「§C22 経理への期末報告」。
//
// 決めごと
//   ・日付はすべて JST の YYYY-MM-DD で比べる（文字列の大小で比べられる）。Firestore の timestamp は +9 時間して日付にする。
//   ・「締め日時点」＝締め日の 23:59 JST まで。締め日の当日に起きたことは入る、翌日（11/1）0:00 以降は入らない。
//   ・金額は請求書と同じ invoiceTotals（invoice-doc.js）を必ず通す（税込・消費税）。
//   ・練習モードのデータ（_practiceBy が付いた文書）・キャンセル・下書きは数えない。
import { invoiceTotals, priceIsTaxIncluded, billToForReportOf } from "./invoice-doc.js";
import { dueDateOf } from "./supply-rules.js";

// ===== 日付 =====
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * いろいろな形の日時を JST の YYYY-MM-DD にする。
 *   "YYYY-MM-DD"（すでに日付）→ そのまま ／ Firestore Timestamp（toDate・seconds）・Date・ISO 文字列・{_ts}（REST）→ +9時間の日付
 *   読めないもの → ""
 */
export function ymdJst(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") {
    const s = v.trim();
    if (YMD.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return jstOfMs(Date.parse(s));
    return "";
  }
  if (typeof v === "object") {
    if (typeof v.toDate === "function") return jstOfMs(v.toDate().getTime());
    if (v instanceof Date) return jstOfMs(v.getTime());
    if (typeof v._ts === "string") return jstOfMs(Date.parse(v._ts));
    if (typeof v.seconds === "number") return jstOfMs(v.seconds * 1000);
  }
  if (typeof v === "number") return jstOfMs(v);
  return "";
}
function jstOfMs(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
}
export function addDaysYmd(ymd, n) {
  const m = YMD.exec(String(ymd || ""));
  if (!m) return "";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}
/** 期首の既定＝締め日の翌日の1年前（2026-10-31 → 2025-11-01） */
export function defaultPeriodStart(cutoff) {
  const next = addDaysYmd(cutoff, 1);
  const m = YMD.exec(next);
  if (!m) return "";
  return `${+m[1] - 1}-${m[2]}-${m[3]}`;
}
export const DEFAULT_CUTOFF = "2026-10-31";
const inRange = (d, start, end) => !!d && d >= start && d <= end;
const upTo = (d, end) => !!d && d <= end;

// ===== 対象の選り分け =====
/** 練習モードで作られた文書（本番には無いはずだが、念のため数えない） */
export function isPracticeDoc(d) {
  return !!(d && (d._practiceBy || d.practice === true || d.isPractice === true));
}
const shipStatus = (s) => (s && s.status) || "shipped"; // ship-flow.js の shipStatusOf と同じ（未設定＝発送済の古い出荷）
/** 請求先が認定事業者（卸・直送）か。請求書の税基準（priceIsTaxIncluded）の逆＝supply.js の billsPartner と同じ */
export function billsPartner(s) { return !priceIsTaxIncluded(s); }
export function billKindLabel(s) { return billsPartner(s) ? "直送（認定事業者）" : "直接（事業所）"; }
export const BILLED_STATUSES = ["invoiced", "paid"];
export const SHIPPED_STATUSES = ["shipped", "invoiced", "paid"];

// ===== 入金・返金（締め日時点）=====
const num = (v) => Number(v) || 0;
/** 入金の記録（supply-rules.js の payListOf と同じ。旧形式 paymentAmount も1件として扱う） */
function payList(s) {
  if (Array.isArray(s.payments) && s.payments.length) return s.payments;
  if (num(s.paymentAmount) > 0) return [{ amount: num(s.paymentAmount), date: s.paidAt || "" }];
  return [];
}
// 入金・返金の日付（date が空なら記録した日時 recordedAt の JST 日付）
const entryDate = (p) => ymdJst(p && p.date) || ymdJst(p && p.recordedAt);

/**
 * 締め日時点の入金・返金・残高。
 *   請求額 billable = 税込合計 − 過入金の充当（creditApplied）
 *   入金 paid = payments[].date ≤ 締め日の合計（payments が無く paidAt ≤ 締め日なら全額入金扱い）
 *   返金 refunded = refunds[].date ≤ 締め日の合計
 *   残高 balance = billable − (paid − refunded)（マイナス＝過入金）
 */
export function settlementAt(s, cutoff) {
  const t = invoiceTotals(s);
  const billable = Math.max(0, t.total - num(s.creditApplied));
  const list = payList(s);
  let paid = 0, lastPaid = "";
  if (list.length) {
    for (const p of list) {
      const d = entryDate(p);
      if (upTo(d, cutoff)) { paid += num(p.amount); if (d > lastPaid) lastPaid = d; }
    }
  } else if (upTo(ymdJst(s.paidAt), cutoff)) {
    paid = billable; lastPaid = ymdJst(s.paidAt);
  }
  let refunded = 0;
  for (const r of (Array.isArray(s.refunds) ? s.refunds : [])) if (upTo(entryDate(r), cutoff)) refunded += num(r.amount);
  return { total: t.total, tax: t.tax, credit: num(s.creditApplied), billable, paid, refunded, balance: billable - (paid - refunded), lastPaid };
}
/** 実際に全額入金された日（いまの記録で。未入金なら ""） */
function actualPaidDate(s) {
  if (shipStatus(s) !== "paid") return "";
  return ymdJst(s.paidAt) || (payList(s).map(entryDate).filter(Boolean).sort().pop() || "");
}

// ===== 1. 売上（期中）=====
export function salesOf(shipments, { start, cutoff }) {
  const rows = shipments
    .filter((s) => !isPracticeDoc(s) && BILLED_STATUSES.includes(shipStatus(s)) && inRange(ymdJst(s.invoicedAt), start, cutoff))
    .map((s) => {
      const t = invoiceTotals(s);
      return { soNumber: s.soNumber || "", invoicedAt: ymdJst(s.invoicedAt), shipDate: ymdJst(s.shipDate), billTo: billToForReportOf(s),
        kind: billKindLabel(s), partner: billsPartner(s), total: t.total, tax: t.tax, sub: t.total - t.tax, status: shipStatus(s) };
    })
    .sort((a, b) => a.invoicedAt.localeCompare(b.invoicedAt) || a.soNumber.localeCompare(b.soNumber));
  const sum = (arr) => ({ count: arr.length, total: arr.reduce((a, r) => a + r.total, 0), tax: arr.reduce((a, r) => a + r.tax, 0) });
  const months = {};
  for (const r of rows) (months[r.invoicedAt.slice(0, 7)] ||= []).push(r);
  const byMonth = Object.keys(months).sort().map((m) => ({ month: m, ...sum(months[m]),
    direct: sum(months[m].filter((r) => !r.partner)), partner: sum(months[m].filter((r) => r.partner)) }));
  return { rows, byMonth, ...sum(rows), direct: sum(rows.filter((r) => !r.partner)), partner: sum(rows.filter((r) => r.partner)) };
}

// ===== 2. 未収金（売掛金）=====
export function receivablesOf(shipments, { cutoff }) {
  const rows = [];
  for (const s of shipments) {
    if (isPracticeDoc(s) || !BILLED_STATUSES.includes(shipStatus(s))) continue;
    const inv = ymdJst(s.invoicedAt);
    if (!upTo(inv, cutoff)) continue;
    const st = settlementAt(s, cutoff);
    if (st.balance <= 0) continue;
    rows.push({ soNumber: s.soNumber || "", invoicedAt: inv, billTo: billToForReportOf(s), kind: billKindLabel(s),
      billed: st.billable, paid: st.paid - st.refunded, balance: st.balance, dueDate: dueDateOf(s) || "", paidDate: actualPaidDate(s) });
  }
  rows.sort((a, b) => a.invoicedAt.localeCompare(b.invoicedAt) || a.soNumber.localeCompare(b.soNumber));
  return { rows, count: rows.length, total: rows.reduce((a, r) => a + r.balance, 0) };
}

// ===== 3. 請求していない出荷 =====
export function unbilledOf(shipments, { cutoff }) {
  const rows = [];
  for (const s of shipments) {
    if (isPracticeDoc(s) || !SHIPPED_STATUSES.includes(shipStatus(s))) continue;
    const sd = ymdJst(s.shipDate);
    if (!upTo(sd, cutoff)) continue;
    const inv = ymdJst(s.invoicedAt);
    if (inv && inv <= cutoff) continue;
    const t = invoiceTotals(s);
    rows.push({ soNumber: s.soNumber || "", shipDate: sd, billTo: billToForReportOf(s), kind: billKindLabel(s),
      total: t.total, invoicedAt: inv, later: !!inv, status: shipStatus(s) });
  }
  rows.sort((a, b) => a.shipDate.localeCompare(b.shipDate) || a.soNumber.localeCompare(b.soNumber));
  const part = (arr) => ({ count: arr.length, total: arr.reduce((a, r) => a + r.total, 0) });
  return { rows, ...part(rows), later: part(rows.filter((r) => r.later)), still: part(rows.filter((r) => !r.later)) };
}

// ===== 発注（仕入）=====
const PO_LIVE = (o) => !isPracticeDoc(o) && o.status !== "draft" && o.status !== "canceled";
/** 実際に届いた日（arrivedDate。無ければ入荷登録の日 receivedAt の JST 日付。どちらも無ければ ""） */
export function poArrivalYmd(o) { return ymdJst(o && o.arrivedDate) || ymdJst(o && o.receivedAt); }
/** 仕入を数える日（到着日 → 入荷登録の日 → 発注日） */
export function poPurchaseYmd(o) { return poArrivalYmd(o) || ymdJst(o && o.orderDate); }
export function poGoodsOf(o) { return (o.items || []).reduce((a, i) => a + num(i.unitPrice) * num(i.qty), 0); }
export function poQtyOf(o) { return (o.items || []).reduce((a, i) => a + num(i.qty), 0); }

/** 品目ごとの仕入単価（締め日までの発注のうち、いちばん新しい発注の明細の unitPrice） */
export function unitCostsOf(purchaseOrders, cutoff) {
  const best = {};
  const list = purchaseOrders.filter((o) => PO_LIVE(o) && upTo(ymdJst(o.orderDate), cutoff))
    .sort((a, b) => ymdJst(a.orderDate).localeCompare(ymdJst(b.orderDate)) || String(a.poNumber || "").localeCompare(String(b.poNumber || "")));
  for (const o of list) for (const it of o.items || []) if (it.sku && num(it.unitPrice) > 0) best[it.sku] = num(it.unitPrice);
  return best;
}

// ===== 4. 在庫（棚卸）=====
export const UNSET_LOCATION = "保管場所未設定";
export const IN_TRANSIT_LOCATION = "保管場所の間を移動中";
/**
 * 在庫の動きを数える日。基本は記録した日（createdAt の JST 日付）。
 * 発注の入荷（reason po_received・refNo＝発注番号）は、その発注に実際の到着日 arrivedDate があればその日。
 */
export function movementYmd(m, poByNumber) {
  if (m && m.reason === "po_received" && m.refNo && poByNumber) {
    const o = poByNumber[m.refNo];
    const a = o && ymdJst(o.arrivedDate);
    if (a) return a;
  }
  return ymdJst(m && m.createdAt);
}
/**
 * 締め日時点の保管場所別・品目別の台数と金額。
 *   ・location_assign（未割当の在庫を場所へ割り当て）は合計を変えない＝「保管場所未設定」から場所へ移す
 *   ・transfer_out / transfer_in / transfer_canceled（保管場所の間の移動）は、途中の分を「移動中」の行に置く
 *   ・保管場所が空の記録は「保管場所未設定」の行
 * opts.arrivalBasis=false にすると到着日の補正をしない（記録日だけで数える・答え合わせ用）
 */
export function inventoryAt(movements, purchaseOrders, { cutoff, locations = [], products = [], arrivalBasis = true } = {}) {
  const poByNumber = {};
  for (const o of purchaseOrders) if (o.poNumber) poByNumber[o.poNumber] = o;
  const locName = {};
  for (const l of locations) locName[l._id] = l.name || l._id;
  const prodName = {};
  for (const p of products) prodName[p.id || p._id] = p.name || p.id || p._id;
  const cost = unitCostsOf(purchaseOrders, cutoff);
  const qty = {}; // key `${locKey}\u0000${sku}`
  const add = (locKey, label, sku, d) => {
    const k = `${locKey}\u0000${sku}`;
    if (!qty[k]) qty[k] = { locKey, location: label, sku, qty: 0 };
    qty[k].qty += d;
  };
  let counted = 0, adjusted = 0;
  for (const m of movements) {
    if (isPracticeDoc(m) || !m.sku) continue;
    const day = arrivalBasis ? movementYmd(m, poByNumber) : ymdJst(m.createdAt);
    if (!upTo(day, cutoff)) continue;
    counted++;
    if (arrivalBasis && day !== ymdJst(m.createdAt)) adjusted++;
    const d = num(m.delta);
    const lk = m.locationId || "";
    const label = lk ? (locName[lk] || m.locationName || lk) : UNSET_LOCATION;
    add(lk || "_unset", label, m.sku, d);
    if (m.reason === "location_assign") add("_unset", UNSET_LOCATION, m.sku, -d);
    if (m.reason === "transfer_out" || m.reason === "transfer_in" || m.reason === "transfer_canceled") add("_transit", IN_TRANSIT_LOCATION, m.sku, -d);
  }
  const order = (r) => (r.locKey === "_unset" ? 2 : r.locKey === "_transit" ? 1 : 0);
  const rows = Object.values(qty).filter((r) => r.qty !== 0)
    .map((r) => ({ ...r, name: prodName[r.sku] || r.sku, unitCost: cost[r.sku] ?? null,
      amount: cost[r.sku] != null ? r.qty * cost[r.sku] : null }))
    .sort((a, b) => order(a) - order(b) || a.location.localeCompare(b.location, "ja") || a.sku.localeCompare(b.sku));
  const total = rows.reduce((a, r) => a + r.qty, 0);
  const amount = rows.reduce((a, r) => a + (r.amount || 0), 0);
  const unset = rows.filter((r) => r.locKey === "_unset").reduce((a, r) => a + r.qty, 0);
  const transit = rows.filter((r) => r.locKey === "_transit").reduce((a, r) => a + r.qty, 0);
  const missingCost = rows.filter((r) => r.unitCost == null).map((r) => r.sku);
  return { rows, total, amount, unset, transit, counted, adjusted, missingCost: [...new Set(missingCost)] };
}

// ===== 5. 届いていない発注（未着品・発注残）=====
export function openOrdersOf(purchaseOrders, { cutoff }) {
  const rows = [];
  for (const o of purchaseOrders) {
    if (!PO_LIVE(o)) continue;
    const od = ymdJst(o.orderDate);
    if (!upTo(od, cutoff)) continue;
    const arr = poArrivalYmd(o);
    if (arr && arr <= cutoff) continue;
    const ssd = ymdJst(o.supplierShipDate);
    const inTransit = upTo(ssd, cutoff);
    rows.push({ poNumber: o.poNumber || "", orderDate: od, supplierShipDate: ssd, arrivedDate: arr, arrivalBasis: o.arrivalBasis || "",
      arrivedTo: o.arrivedTo || o.deliverLocationName || o.receivedLocationName || "", qty: poQtyOf(o), goods: poGoodsOf(o),
      shippingFee: num(o.shippingFee), amount: poGoodsOf(o) + num(o.shippingFee), inTransit, state: inTransit ? "先方出荷済み・運送中" : "未出荷",
      dropship: !!o.dropship });
  }
  rows.sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.poNumber.localeCompare(b.poNumber));
  const part = (arr) => ({ count: arr.length, qty: arr.reduce((a, r) => a + r.qty, 0), amount: arr.reduce((a, r) => a + r.amount, 0) });
  return { rows, ...part(rows), inTransit: part(rows.filter((r) => r.inTransit)), notShipped: part(rows.filter((r) => !r.inTransit)) };
}

// ===== 6. 仕入（期中）=====
export function purchasesOf(purchaseOrders, { start, cutoff }) {
  const rows = purchaseOrders.filter((o) => PO_LIVE(o) && inRange(poPurchaseYmd(o), start, cutoff))
    .map((o) => ({ poNumber: o.poNumber || "", orderDate: ymdJst(o.orderDate), date: poPurchaseYmd(o),
      dateBasis: ymdJst(o.arrivedDate) ? `到着日（${o.arrivalBasis || "区分なし"}）` : ymdJst(o.receivedAt) ? "入荷登録の日" : "発注日",
      qty: poQtyOf(o), goods: poGoodsOf(o), shippingFee: num(o.shippingFee), dropship: !!o.dropship,
      arrivedTo: o.arrivedTo || o.receivedLocationName || o.deliverLocationName || "" }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.poNumber.localeCompare(b.poNumber));
  return { rows, count: rows.length, qty: rows.reduce((a, r) => a + r.qty, 0), goods: rows.reduce((a, r) => a + r.goods, 0),
    shippingFee: rows.reduce((a, r) => a + r.shippingFee, 0) };
}

// ===== 7. 仕入先への未払い（買掛金）=====
// 支払いの記録（purchaseOrders.supplierPaidDate・supplierPaidAmount）はまだ無い。記録が1件も無いあいだは「未確認」。
// 記録が入りはじめたら: 締め日までに届いた発注（品代＋送料・税別）− 締め日までの支払い額 を未払いとして出す。
export function payablesOf(purchaseOrders, { cutoff }) {
  const live = purchaseOrders.filter(PO_LIVE);
  const recorded = live.some((o) => o.supplierPaidDate || o.supplierPaidAmount != null);
  if (!recorded) return { recorded: false, rows: [], count: null, total: null };
  const rows = [];
  for (const o of live) {
    const d = poPurchaseYmd(o);
    if (!upTo(d, cutoff)) continue;
    const owed = poGoodsOf(o) + num(o.shippingFee);
    const paid = upTo(ymdJst(o.supplierPaidDate), cutoff) ? num(o.supplierPaidAmount) : 0;
    if (owed - paid > 0) rows.push({ poNumber: o.poNumber || "", date: d, owed, paid, balance: owed - paid, paidDate: ymdJst(o.supplierPaidDate) });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.poNumber.localeCompare(b.poNumber));
  return { recorded: true, rows, count: rows.length, total: rows.reduce((a, r) => a + r.balance, 0) };
}

// ===== 8. 返金・過入金 =====
export function refundsOf(shipments, { start, cutoff }) {
  const refunds = [], credits = [], overpaid = [];
  for (const s of shipments) {
    if (isPracticeDoc(s) || shipStatus(s) === "canceled" || shipStatus(s) === "draft") continue;
    for (const r of (Array.isArray(s.refunds) ? s.refunds : [])) {
      const d = entryDate(r);
      if (upTo(d, cutoff)) refunds.push({ soNumber: s.soNumber || "", date: d, billTo: billToForReportOf(s), amount: num(r.amount),
        method: r.method || "", inPeriod: inRange(d, start, cutoff) });
    }
    const inv = ymdJst(s.invoicedAt);
    if (num(s.creditApplied) > 0 && upTo(inv, cutoff)) {
      credits.push({ soNumber: s.soNumber || "", date: inv, billTo: billToForReportOf(s), amount: num(s.creditApplied),
        from: (Array.isArray(s.creditFrom) ? s.creditFrom : []).map((c) => c.soNumber).filter(Boolean).join("・"), inPeriod: inRange(inv, start, cutoff) });
    }
    if (BILLED_STATUSES.includes(shipStatus(s)) && upTo(inv, cutoff)) {
      const st = settlementAt(s, cutoff);
      if (st.balance < 0) overpaid.push({ soNumber: s.soNumber || "", date: inv, billTo: billToForReportOf(s), amount: -st.balance });
    }
  }
  const by = (a, b) => a.date.localeCompare(b.date) || a.soNumber.localeCompare(b.soNumber);
  refunds.sort(by); credits.sort(by); overpaid.sort(by);
  const sum = (arr) => arr.reduce((a, r) => a + r.amount, 0);
  return { refunds, credits, overpaid, refundTotal: sum(refunds), creditTotal: sum(credits), overpaidTotal: sum(overpaid) };
}

// ===== まとめ =====
/** 締め日・期首を確かめて返す（おかしければ Error） */
export function periodOf(cutoff, start) {
  const c = String(cutoff || "").trim();
  if (!YMD.test(c)) throw new Error("締め日を YYYY-MM-DD で入れてください");
  const s = String(start || "").trim() || defaultPeriodStart(c);
  if (!YMD.test(s)) throw new Error("期首を YYYY-MM-DD で入れてください");
  if (s > c) throw new Error("期首が締め日より後になっています");
  return { start: s, cutoff: c };
}
export function buildReport({ shipments = [], purchaseOrders = [], movements = [], locations = [], products = [] }, { cutoff, start } = {}) {
  const p = periodOf(cutoff, start);
  const sales = salesOf(shipments, p);
  const receivables = receivablesOf(shipments, p);
  const unbilled = unbilledOf(shipments, p);
  const inventory = inventoryAt(movements, purchaseOrders, { ...p, locations, products });
  const openOrders = openOrdersOf(purchaseOrders, p);
  const purchases = purchasesOf(purchaseOrders, p);
  const payables = payablesOf(purchaseOrders, p);
  const refunds = refundsOf(shipments, p);
  const summary = [
    { no: 1, title: "売上（期中・請求日で数える）", count: sales.count, amount: sales.total, note: `うち消費税 ${sales.tax.toLocaleString("ja-JP")}円` },
    { no: 2, title: "未収金（売掛金）", count: receivables.count, amount: receivables.total, note: "締め日までの入金・返金を差し引いた残り" },
    { no: 3, title: "請求していない出荷", count: unbilled.count, amount: unbilled.total, note: `締め日後に請求済 ${unbilled.later.count}件／いまも未請求 ${unbilled.still.count}件` },
    { no: 4, title: "在庫（棚卸）", count: inventory.total, unit: "台", amount: inventory.amount, note: `仕入単価（発注書の単価）で計算${inventory.unset ? `・保管場所未設定 ${inventory.unset}台` : ""}` },
    { no: 5, title: "届いていない発注（未着品）", count: openOrders.count, amount: openOrders.amount, note: `運送中 ${openOrders.inTransit.count}件／未出荷 ${openOrders.notShipped.count}件・${openOrders.qty}台` },
    { no: 6, title: "仕入（期中）", count: purchases.count, amount: purchases.goods + purchases.shippingFee, note: `品代 ${purchases.goods.toLocaleString("ja-JP")}円＋送料 ${purchases.shippingFee.toLocaleString("ja-JP")}円（税別）` },
    { no: 7, title: "仕入先への未払い（買掛金）", count: payables.count, amount: payables.total, note: payables.recorded ? "締め日までに届いた発注 − 支払い" : "支払いの記録は未登録（未確認）" },
    { no: 8, title: "返金・過入金", count: refunds.refunds.length + refunds.credits.length + refunds.overpaid.length,
      amount: refunds.refundTotal, note: `返金 ${refunds.refundTotal.toLocaleString("ja-JP")}円・充当 ${refunds.creditTotal.toLocaleString("ja-JP")}円・締め日時点の過入金 ${refunds.overpaidTotal.toLocaleString("ja-JP")}円` },
  ];
  return { ...p, sales, receivables, unbilled, inventory, openOrders, purchases, payables, refunds, summary };
}

// ===== CSV =====
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** BOM 付き UTF-8 の CSV 文字列（Excel で文字化けしない）。cols = [[見出し, 行→値], ...] */
export function toCsv(rows, cols) {
  const lines = [cols.map((c) => csvCell(c[0])).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c[1](r))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
/** 項目ごとの CSV（ファイル名に締め日）。返り値 [{ key, filename, csv }] */
export function reportCsvFiles(rep) {
  const c = rep.cutoff.replace(/-/g, "");
  const f = (key, label, rows, cols) => ({ key, filename: `経理報告_${c}_${label}.csv`, csv: toCsv(rows, cols) });
  const yenOrBlank = (v) => (v == null ? "未確認" : v);
  return [
    f("sales", "1_売上明細", rep.sales.rows, [["請求日", (r) => r.invoicedAt], ["出荷番号", (r) => r.soNumber], ["請求先", (r) => r.billTo],
      ["請求先の種類", (r) => r.kind], ["出荷日", (r) => r.shipDate], ["税込金額", (r) => r.total], ["うち消費税", (r) => r.tax], ["税抜金額", (r) => r.sub]]),
    f("receivables", "2_未収金", rep.receivables.rows, [["出荷番号", (r) => r.soNumber], ["請求日", (r) => r.invoicedAt], ["請求先", (r) => r.billTo],
      ["請求額", (r) => r.billed], ["締め日までの入金", (r) => r.paid], ["残高", (r) => r.balance], ["支払期限", (r) => r.dueDate], ["実際の入金日", (r) => r.paidDate]]),
    f("unbilled", "3_未請求出荷", rep.unbilled.rows, [["出荷番号", (r) => r.soNumber], ["出荷日", (r) => r.shipDate], ["請求先", (r) => r.billTo],
      ["請求先の種類", (r) => r.kind], ["見込み金額（税込）", (r) => r.total], ["区分", (r) => (r.later ? "締め日後に請求済" : "いまも未請求")], ["請求日", (r) => r.invoicedAt]]),
    f("inventory", "4_在庫", rep.inventory.rows, [["保管場所", (r) => r.location], ["品目コード", (r) => r.sku], ["品名", (r) => r.name], ["台数", (r) => r.qty],
      ["仕入単価（発注書の単価）", (r) => yenOrBlank(r.unitCost)], ["金額", (r) => yenOrBlank(r.amount)]]),
    f("openOrders", "5_未着品", rep.openOrders.rows, [["発注番号", (r) => r.poNumber], ["発注日", (r) => r.orderDate], ["区分", (r) => r.state],
      ["先方出荷日", (r) => r.supplierShipDate], ["到着日", (r) => r.arrivedDate], ["到着日の区分", (r) => r.arrivalBasis], ["届け先", (r) => r.arrivedTo],
      ["台数", (r) => r.qty], ["品代（税別）", (r) => r.goods], ["送料（税別）", (r) => r.shippingFee], ["金額（税別）", (r) => r.amount]]),
    f("purchases", "6_仕入", rep.purchases.rows, [["発注番号", (r) => r.poNumber], ["発注日", (r) => r.orderDate], ["仕入の日", (r) => r.date], ["日付の根拠", (r) => r.dateBasis],
      ["届け先", (r) => r.arrivedTo], ["直送", (r) => (r.dropship ? "直送" : "")], ["台数", (r) => r.qty], ["品代（税別）", (r) => r.goods], ["送料（税別）", (r) => r.shippingFee]]),
    f("refunds", "8_返金・過入金", [
      ...rep.refunds.refunds.map((r) => ({ ...r, type: "返金", memo: r.method })),
      ...rep.refunds.credits.map((r) => ({ ...r, type: "過入金の充当", memo: r.from ? `充当元 ${r.from}` : "" })),
      ...rep.refunds.overpaid.map((r) => ({ ...r, type: "締め日時点の過入金（未返金・未充当）", memo: "" })),
    ], [["種類", (r) => r.type], ["日付", (r) => r.date], ["出荷番号", (r) => r.soNumber], ["請求先", (r) => r.billTo], ["金額", (r) => r.amount], ["メモ", (r) => r.memo]]),
  ];
}
