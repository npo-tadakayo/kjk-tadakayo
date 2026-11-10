// 「請求済にする」の書き込み（2026-11-10 共通化）。
// 出荷の画面（supply.js の「請求済にする」）と、印刷画面（supply-print.js の請求書メール送付後の確認）が同じ処理を呼ぶ。
// 書く内容の規則は supply-rules.js の invoicePatchOf（請求前に全額入金済みなら入金済にする）が正本。
// 練習モードでも fs.js が練習DBへ向けるので、このままで同じ流れになる。
import { doc, runTransaction, serverTimestamp } from "/js/fs.js";
import { invoicePatchOf } from "/js/supply-rules.js";
import { shipStatusOf } from "/js/ship-flow.js";

export const NOT_SHIPPED_MSG = "この出荷はもう発送済（未請求）ではありません（ほかの画面で請求済などにした可能性があります）";

/**
 * 出荷を請求済にする（最新の記録をトランザクションで読んで書く）。
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} shipmentId
 * @param {{invoicedAt:string, dueDate?:string, today:string, requireShipped?:boolean}} o
 *   requireShipped … 最新の状態が発送済でなければ書かずに NOT_SHIPPED_MSG で止める（印刷画面から呼ぶとき）
 * @returns {Promise<{latest:object, patch:object, paid:boolean, remain:number}>}
 */
export async function markInvoiced(db, shipmentId, { invoicedAt, dueDate, today, requireShipped = false }) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, "shipments", shipmentId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("出荷が見つかりません");
    const latest = { _id: shipmentId, ...snap.data() };
    if (requireShipped && shipStatusOf(latest) !== "shipped") throw new Error(NOT_SHIPPED_MSG);
    const out = invoicePatchOf(latest, { invoicedAt, dueDate, today });
    tx.update(ref, { ...out.patch, updatedAt: serverTimestamp() });
    return { latest, ...out };
  });
}
