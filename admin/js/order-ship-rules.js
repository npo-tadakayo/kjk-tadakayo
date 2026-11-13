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
// ⚠️ 倉庫の画面の発送完了（functions/index.js の warehouseComplete と、その練習の代役 practice-stubs.js の whMarkShipped）は、
//    まだこの判定を通っていない（Functions は触らない前提。本番と練習は test-record-gaps が同じ形か照合しているので、直すときは3か所いっしょに）。

export const ORDER_CANCELED_NO_SHIP_MSG = "この受注はキャンセル済みなので、出荷にできません";
export const ORDER_ALREADY_SHIPPED_MSG = "この受注はすでに出荷済です";
export const ORDER_CANCELED_NO_SHIPPED_MSG =
  "ひも付く受注がキャンセルになっているため、発送済にできません。受注一覧で受注の状態を確かめ（出荷を続けるなら受注を「受注確定」に戻し）、出荷をやめるなら出荷をキャンセルしてください";

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
