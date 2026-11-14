// admin/js/order-ship-rules.js — 認定事業者の受注（partnerOrders）と出荷のつなぎの判定（純粋 ESM・2026-11-13）
// Firestore にも DOM にも触らない。テスト: node scripts/test-order-ship-rules.mjs
// 呼び出し元: supply.js（受注一覧の「出荷へ」の出し分け・shipFromOrder・shipWithStock＝出荷一覧の「発送済にする」）
//
// 受注の状態: received（受付済）→ confirmed（受注確定）→ shipped（出荷済）／ canceled（キャンセル）
//   ・「出荷へ」を出してよいのは、まだ出荷になっていない生きた受注だけ（received・confirmed）
//   ・出荷を「発送済にする」とき、受注を「出荷済」にしてよいのは received・confirmed だけ
//       canceled … 止める（キャンセル済みの受注を黙って「出荷済」に書き換えない。人が受注を戻すか出荷をキャンセルする）
//       shipped  … すでに出荷済なので書かない（二重に書かない）
//       それ以外（状態が無い・知らない値）… 分からない状態は上書きしない（書かない）
// 倉庫の画面の発送完了（functions/index.js の warehouseComplete と、その練習の代役 practice-stubs.js の whMarkShipped）は
//   orderOnWarehouseDone を使う（2026-11-15）。物はもう出ているので発送の完了は止めず、受注を「出荷済」にするのは
//   received・confirmed のときだけ。キャンセル済みなら受注は書き換えず、出荷に partnerOrderNote（下の定数の文）を残す。
// ⚠️ 正本はこのファイル。functions/order-ship-rules.mjs はバイト単位で同じコピー（scripts/check-shared-sync.sh で照合）。
//    直したら cp admin/js/order-ship-rules.js functions/order-ship-rules.mjs で揃える。

export const ORDER_CANCELED_NO_SHIP_MSG = "この受注はキャンセル済みなので、出荷にできません";
export const ORDER_ALREADY_SHIPPED_MSG = "この受注はすでに出荷済です";
export const ORDER_CANCELED_NO_SHIPPED_MSG =
  "ひも付く受注がキャンセルになっているため、発送済にできません。受注一覧で受注の状態を確かめ（出荷を続けるなら受注を「受注確定」に戻し）、出荷をやめるなら出荷をキャンセルしてください";

export const ORDER_CANCELED_KEPT_NOTE = "受注がキャンセル済みのため受注の状態は変えていません";

const LIVE = ["received", "confirmed"];

/** 受注から出荷を作ってよいか。{ ok, reason } */
export function canShipFromOrder(order) {
  const st = order && order.status;
  if (st === "canceled") return { ok: false, reason: ORDER_CANCELED_NO_SHIP_MSG };
  if (st === "shipped") return { ok: false, reason: ORDER_ALREADY_SHIPPED_MSG };
  return { ok: true, reason: "" };
}

/**
 * 出荷を発送済にするときの、受注の扱い。
 * @returns {{action:"set"|"keep"|"block", reason:string}}
 *   set … 受注を「出荷済」にする ／ keep … 受注は触らない ／ block … 発送済にせず止める（reason を表示）
 */
export function orderOnShipDone(order) {
  if (!order) return { action: "keep", reason: "" };
  const st = order.status;
  if (LIVE.includes(st)) return { action: "set", reason: "" };
  if (st === "canceled") return { action: "block", reason: ORDER_CANCELED_NO_SHIPPED_MSG };
  return { action: "keep", reason: "" };
}

/**
 * 倉庫で発送済・受け渡し済にしたとき（warehouseComplete・練習の whMarkShipped）の、受注の扱い。
 * 物はもう出ているので止めない（block は返さない）。
 * @returns {{action:"set"|"keep", note:string}}
 *   set … 受注を「出荷済」にする ／ keep … 受注は触らない（note が空でなければ出荷に残す）
 */
export function orderOnWarehouseDone(order) {
  if (!order) return { action: "keep", note: "" };
  const st = order.status;
  if (LIVE.includes(st)) return { action: "set", note: "" };
  if (st === "canceled") return { action: "keep", note: ORDER_CANCELED_KEPT_NOTE };
  return { action: "keep", note: "" };
}

// 倉庫が発送したあとの出荷の印（partnerOrderNote）を画面に出すか（2026-11-15 レビュー中-1）。
// 出荷の印は残したまま、警告は「受注がいまもキャンセル済み」のときだけ出す（受注を戻したら出ない）。
// ship … 出荷 ／ order … その出荷の partnerOrderId の受注（いまの状態）。出すなら文、出さないなら ""
export const ORDER_CANCELED_SHIPPED_WARN = "⚠ 受注がキャンセル済みのまま発送されました。受注の状態を確認してください";
export function canceledOrderShipWarn(ship, order) {
  if (!ship || !ship.partnerOrderNote || !ship.partnerOrderId) return "";
  if (!order || order.status !== "canceled") return "";
  return ORDER_CANCELED_SHIPPED_WARN;
}
// 請求書を作る（印刷・メール）・請求済にするときの確認の文。出さないなら ""
export function canceledOrderInvoiceConfirmText(ship, order) {
  if (!canceledOrderShipWarn(ship, order)) return "";
  return `${ORDER_CANCELED_SHIPPED_WARN}\n\n出荷 ${(ship && ship.soNumber) || ""} にひも付く受注はキャンセル済みです。このまま請求を進めますか？`;
}
