// 供給管理の画面（supply.js・bank-import.js）で使う判定。純粋関数のみ（DOM・Firestore に触れない）。
// 設計: docs/CRM改善_設計_20261021.md §6（重複警告・在庫の目安）・§7（入金明細の取り込み）。
// テスト: node scripts/test-supply-wiring.mjs
// import は相対パス（ブラウザでは /js/ 配下として、node のテストでもそのまま読める）。いずれも firebase を import していない。

import { invoiceTotals } from "./invoice-doc.js";
import { usesWarehouse, shipStatusOf } from "./ship-flow.js";
import { billToKeyOf } from "./bank-match.js";

const idOf = (s) => (s && (s._id ?? s.id)) || "";

// ===== 下書きの重複（§6）=====
/**
 * findDuplicateDrafts の結果を、行の描画で引きやすい形にする。
 * @param {ReturnType<import("./ship-dup.js").findDuplicateDrafts>} dups
 * @returns {{ids:Set<string>, byShip:Map<string,{caseId:string, keepId:string|null, group:object[]}>, count:number}}
 *   count … 重複している出荷の件数（サマリーの「⚠ 下書きの重複 n件」）
 */
export function dupView(dups) {
  const ids = new Set();
  const byShip = new Map();
  for (const d of dups || []) {
    for (const s of d.shipments) {
      ids.add(idOf(s));
      byShip.set(idOf(s), { caseId: d.caseId, keepId: d.keepId, group: d.shipments });
    }
  }
  return { ids, byShip, count: ids.size };
}

/** 「重複だけ表示」の絞り込み。on が偽ならそのまま返す */
export function filterDupOnly(list, view, on) {
  if (!on) return list;
  return (list || []).filter((s) => view.ids.has(idOf(s)));
}

/**
 * 「こちらを残す」を押したとき、キャンセルにする相手（同じ組の残す出荷以外）。出荷番号の昇順。
 * 下書き・依頼済だけ（そのあいだに発送済になった相手はキャンセルの対象にしない）。
 */
export function othersToCancel(view, keepShipId) {
  const e = view.byShip.get(keepShipId);
  if (!e) return [];
  return e.group.filter((s) => idOf(s) !== keepShipId && ["draft", "requested"].includes(shipStatusOf(s)));
}

/** 在庫の目安を出す行か（下書き・依頼済で、自社在庫から出すもの。直送は在庫を使わないので出さない） */
export function stockAdviceShown(s) {
  return ["draft", "requested"].includes(shipStatusOf(s)) && usesWarehouse(s);
}

// ===== 入金明細の取り込み（§7）=====
// 見出しの言葉から列を推し量る（初回だけ。プリセットがあればそちらが優先）
const HEAD = {
  date: /日付|取引日|年月日|勘定日|お取引日|date/i,
  deposit: /入金|預入|お預り|お預入|受入|credit/i,
  withdrawal: /出金|引出|お引出|支払|払出|debit/i,
  amount: /^(?!.*(入金|出金|残高)).*(金額|amount)/i,
  balance: /残高|balance/i,
  payer: /振込依頼人|依頼人|名義|摘要|内容|お取引内容|取引内容|備考|payer|description/i,
};
/**
 * 先頭の行から列の割り当てを推し量る。見出し行が見つからなければ空の割り当て（skip:0）。
 * @param {string[][]} rows parseCsv の結果
 * @returns {{skip:number, mode:"split"|"single", date?:number, payer?:number, amount?:number, deposit?:number, withdrawal?:number, balance?:number}}
 */
export function guessMapping(rows) {
  const lim = Math.min((rows || []).length, 10);
  for (let i = 0; i < lim; i++) {
    const r = rows[i] || [];
    const find = (re, used) => r.findIndex((c, j) => !used.includes(j) && re.test(String(c || "").trim()));
    const used = [];
    const take = (re) => { const j = find(re, used); if (j >= 0) used.push(j); return j; };
    const date = take(HEAD.date);
    if (date < 0) continue;
    const balance = take(HEAD.balance);
    const deposit = take(HEAD.deposit);
    const withdrawal = take(HEAD.withdrawal);
    const amount = deposit < 0 ? take(HEAD.amount) : -1;
    const payer = take(HEAD.payer);
    const m = { skip: i + 1, mode: deposit >= 0 ? "split" : "single", date };
    if (payer >= 0) m.payer = payer;
    if (deposit >= 0) m.deposit = deposit;
    if (withdrawal >= 0) m.withdrawal = withdrawal;
    if (amount >= 0) m.amount = amount;
    if (balance >= 0) m.balance = balance;
    return m;
  }
  return { skip: 0, mode: "split" };
}

/**
 * 画面の割り当て（mode つき）を mapRows に渡す形にする。足りなければ error を返す。
 * single … 符号つきの1列（amount）／ split … 入金の列（deposit）＋出金の列（withdrawal・任意）
 */
export function toMapRowsMapping(ui) {
  const n = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? undefined : Number(v));
  const m = { skip: Math.max(0, Number(ui.skip) || 0), date: n(ui.date), payer: n(ui.payer), balance: n(ui.balance) };
  if (ui.mode === "single") m.amount = n(ui.amount);
  else { m.deposit = n(ui.deposit); m.withdrawal = n(ui.withdrawal); }
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  if (!Number.isInteger(m.date)) return { error: "日付の列を選んでください" };
  if (!Number.isInteger(m.payer)) return { error: "名義の列を選んでください" };
  if (ui.mode === "single" ? !Number.isInteger(m.amount) : !Number.isInteger(m.deposit))
    return { error: ui.mode === "single" ? "入金額の列を選んでください" : "入金の列を選んでください" };
  return { mapping: m };
}

/**
 * 最初の選択状態。autoSelect の結果だけを選び、取込済みの行は除く。
 * @param {{rowIndex:number, shipmentId:string}[]} auto  autoSelect の結果
 * @param {object[]} rows  hashRows の結果（index・hash）
 * @param {Set<string>} imported  既に bankTxns にある hash
 * @returns {Map<number,string>} 行番号 → 出荷ID
 */
export function initialSelection(auto, rows, imported) {
  const hashOf = new Map((rows || []).map((r) => [r.index, r.hash]));
  const sel = new Map();
  for (const a of auto || []) {
    if (imported && imported.has(hashOf.get(a.rowIndex))) continue;
    sel.set(a.rowIndex, a.shipmentId);
  }
  return sel;
}

/**
 * 選んだ行を出荷ごとにまとめる（1つの出荷に2回に分けて振り込まれた場合も1回の tx で記録する）。
 * 取込済みの行は除く。
 * @returns {{shipmentId:string, rows:object[], amount:number}[]}  出荷の並びは最初に出てきた順
 */
export function groupByShipment(selection, rows, imported) {
  const byIndex = new Map((rows || []).map((r) => [r.index, r]));
  const out = new Map();
  for (const [idx, sid] of selection || []) {
    const r = byIndex.get(idx);
    if (!sid || !r || (imported && imported.has(r.hash))) continue;
    if (!out.has(sid)) out.set(sid, { shipmentId: sid, rows: [], amount: 0 });
    const g = out.get(sid);
    g.rows.push(r);
    g.amount += Number(r.amount) || 0;
  }
  for (const g of out.values()) g.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.index - b.index);
  return [...out.values()];
}

/** 入金の1件（payments[] に積む形）。recordedAt は ISO 文字列（既存の addPayment と同じ） */
/** txnId … bankTxns に書いたドキュメントID（同じ指紋の別の振込として記録したときは hash-2 など）。省略時は row.hash */
export function bankPaymentOf(row, { recordedBy, recordedAt }, txnId) {
  return { amount: Number(row.amount) || 0, date: row.date, note: "銀行明細取込", recordedBy, recordedAt,
    source: "bank_csv", bankTxnId: txnId || row.hash };
}

/** bankTxns/{hash} に残す最小限（confirmedAt は呼び出し側で serverTimestamp を足す）。CSV の他の列は残さない */
export function bankTxnDocOf(row, shipment, confirmedBy) {
  return { date: row.date, amount: Number(row.amount) || 0, payerNorm: row.payerNorm || "",
    shipmentId: idOf(shipment), soNumber: shipment.soNumber || "", confirmedBy };
}

// supply.js の payList と同じ（旧形式は1件の履歴として読み替える）
function payListOf(s) {
  if (Array.isArray(s.payments) && s.payments.length) return s.payments;
  if (Number(s.paymentAmount) > 0) return [{ amount: Number(s.paymentAmount), date: s.paidAt || "", note: "（旧形式の記録）" }];
  return [];
}
const sum = (a) => a.reduce((x, p) => x + (Number(p.amount) || 0), 0);
/** 残額（supply.js の payRemain と同じ: 充当後の請求額 − 純入金。マイナスにしない） */
export function remainOf(s) {
  const refunds = Array.isArray(s.refunds) ? s.refunds : [];
  const billable = Math.max(0, invoiceTotals(s).total - (Number(s.creditApplied) || 0));
  return Math.max(0, billable - (sum(payListOf(s)) - sum(refunds)));
}

/**
 * 最新の出荷に入金を足したときの更新内容（supply.js の savePayments と同じ規則・同じフィールド）。
 * ただし発送済（未請求）の出荷は状態を変えない（請求済にする＝経理への報告を飛ばさないため）。
 * @returns {{patch:object, remainBefore:number, remainAfter:number, overpay:number}}
 *   patch は updatedAt・updatedBy を含まない（呼び出し側で足す）
 */
export function applyBankPayments(cur, payments) {
  const st = shipStatusOf(cur);
  if (!["shipped", "invoiced"].includes(st)) throw new Error(`この出荷は「${st}」のため入金を記録できません`);
  const remainBefore = remainOf(cur);
  const list = payListOf(cur).concat(payments);
  const rlist = Array.isArray(cur.refunds) ? cur.refunds : [];
  const net = sum(list) - sum(rlist);
  const remain = invoiceTotals(cur).total - (Number(cur.creditApplied) || 0) - net;
  const lastDate = list.length ? (list[list.length - 1].date || "") : "";
  const patch = {
    payments: list,
    refunds: rlist,
    paymentAmount: net,
    refundAmount: sum(rlist),
    paidAt: remain <= 0 ? lastDate : "",
    status: st === "shipped" ? "shipped" : (remain <= 0 ? "paid" : "invoiced"),
  };
  return { patch, remainBefore, remainAfter: Math.max(0, remain), overpay: Math.max(0, -remain) };
}

// ===== 請求済にする・入金の取消（2026-10-21 レビュー指摘）=====
// supply.js の savePayments と同じ規則の残額（マイナスあり）: 請求額 − 過入金の充当 − （入金 − 返金）
function signedRemain(s, list, rlist) {
  return invoiceTotals(s).total - (Number(s.creditApplied) || 0) - (sum(list) - sum(rlist));
}

/**
 * 「請求済にする」で書く内容。請求前に全額入金されていた出荷（残額 0 以下）は、そのまま入金済にする。
 * 入金済の paidAt は savePayments と同じ（最後の入金の日付・無ければ today）。残額があれば今どおり請求済。
 * @param {object} cur 最新の出荷
 * @param {{invoicedAt:string, dueDate?:string, today:string}} o
 * @returns {{patch:object, paid:boolean, remain:number}} patch は updatedAt を含まない
 */
export function invoicePatchOf(cur, { invoicedAt, dueDate, today }) {
  const list = payListOf(cur);
  const rlist = Array.isArray(cur.refunds) ? cur.refunds : [];
  const remain = signedRemain(cur, list, rlist);
  const patch = { status: "invoiced", invoicedAt, ...(dueDate ? { dueDate } : {}) };
  const paid = remain <= 0;
  if (paid) {
    patch.status = "paid";
    patch.paidAt = list.length ? (list[list.length - 1].date || today) : today;
  }
  return { patch, paid, remain: Math.max(0, remain) };
}

// 同じ入金か（画面を開いた時点の記録と、最新の記録を突き合わせる）
function samePayment(a, b) {
  if (!a || !b) return false;
  if (a.bankTxnId || b.bankTxnId) return a.bankTxnId === b.bankTxnId;
  return (Number(a.amount) || 0) === (Number(b.amount) || 0) && (a.date || "") === (b.date || "")
    && (a.recordedAt || "") === (b.recordedAt || "") && (a.note || "") === (b.note || "");
}

/**
 * 入金の記録を1件取り消すときの書き込み内容（savePayments と同じ規則・同じフィールド）。
 * 銀行明細から記録した入金（bankTxnId あり）なら、取り込み記録 bankTxns/{bankTxnId} も消す対象として返す
 * （消さないと、その明細を取り込み直せない）。発送済（未請求）の出荷は状態を変えない。
 * @param {object} cur 最新の出荷
 * @param {object} target 取り消す入金（画面に出していた記録）
 * @param {string} today YYYY-MM-DD（入金の日付が空のときの paidAt）
 * @returns {{patch:object, bankTxnId:string|null}}  patch は updatedAt・updatedBy を含まない
 */
export function paymentRemovalOf(cur, target, today) {
  const list = payListOf(cur).slice();
  const i = list.findIndex((p) => samePayment(p, target));
  if (i < 0) throw new Error("取り消す入金が見つかりません（ほかの人が先に変えた可能性があります）。画面を開き直してください");
  const [removed] = list.splice(i, 1);
  const rlist = Array.isArray(cur.refunds) ? cur.refunds : [];
  const remain = signedRemain(cur, list, rlist);
  const lastDate = list.length ? (list[list.length - 1].date || today) : "";
  const st = shipStatusOf(cur);
  const patch = {
    payments: list,
    refunds: rlist,
    paymentAmount: sum(list) - sum(rlist),
    refundAmount: sum(rlist),
    paidAt: remain <= 0 ? lastDate : "",
    status: st === "shipped" ? "shipped" : (remain <= 0 ? "paid" : "invoiced"),
  };
  return { patch, bankTxnId: removed.bankTxnId || null };
}

const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
/**
 * 記録の前に確かめる文（不要なら ""）。過入金は既存の addPayment と同じ文。
 * 一部入金・未請求の出荷にも一言添える。
 */
export function payConfirmText(shipment, amount) {
  const remain = remainOf(shipment);
  const head = `${shipment.soNumber || ""}：`;
  const parts = [];
  if (amount > remain) {
    parts.push(`${head}残額 ${yen(remain)} を超える入金です（${yen(amount)}）。\n差額 ${yen(amount - remain)} は過入金として記録し、同じ請求先の次回の請求から差し引けます。`);
  } else if (amount < remain) {
    parts.push(`${head}残額 ${yen(remain)} に満たない入金です（${yen(amount)}）。\n残り ${yen(remain - amount)} は未集金のまま残ります（一部入金）。`);
  }
  if (shipStatusOf(shipment) === "shipped") {
    parts.push(`${head}まだ請求済にしていない出荷です。入金は記録しますが、状態は「発送済」のままです（請求済にする・経理への報告は別に行ってください）。`);
  }
  return parts.join("\n\n");
}

/**
 * 名義の学習（正規化名義 → 請求先キーの配列）に足すもの。名義が空・請求先キーが空のものは除く。
 * @param {{rows:object[], shipment:object}[]} confirmed
 * @returns {Map<string,string[]>}
 */
export function aliasLearnings(confirmed) {
  const out = new Map();
  for (const g of confirmed || []) {
    const key = billToKeyOf(g.shipment || {});
    if (!key) continue;
    for (const r of g.rows || []) {
      if (!r.payerNorm) continue;
      const arr = out.get(r.payerNorm) || [];
      if (!arr.includes(key)) arr.push(key);
      out.set(r.payerNorm, arr);
    }
  }
  return out;
}

// ===== 閲覧のみ（viewer）で止めるボタン（2026-10-21 E2E で発見）=====
// role.js の applyViewerMode は文言で書き込み系を見分けるが、「出荷を依頼する」「発送済にする」「新規出荷」
// 「キャンセルにする」（キャンセルは閉じるボタンと同じ語なので残す側）などを拾えず、viewer が押せていた
// （保存はルールで拒否されるが、押してからエラーで気づく）。供給管理の操作ボタンはクラスで止める。
// 「入金の履歴を見る」（mark-paid）は見るだけなので止めない（中の記録ボタンは文言で止まる）。
export const VIEWER_LOCK_SELECTOR = [
  "#newShipBtn", "#newOrderBtn", "#newTransferBtn", "#newLocationBtn", "#newPartnerBtn", "#importOrderBtn",
  ...["request-ship", "mark-shipped", "record-shipped", "revert-draft", "resend-notify", "mark-invoiced", "edit-ship",
    "type-ship", "cancel-ship", "del-ship", "keep-dup", "track-ship", "track-del", "report-acct", "dun-ship", "apply-credit",
    "pay-del", "refund-del", "po-ship", "confirm-order", "undo-order", "edit-order", "del-order", "recv-btn",
    "tr-arrive", "tr-cancel", "loc-edit", "stock-btn", "edit-partner", "del-partner", "toggle-partner", "guide-partner", "c-del",
  ].map((c) => `button.${c}`),
].join(",");
