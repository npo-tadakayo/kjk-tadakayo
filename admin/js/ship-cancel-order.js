// admin/js/ship-cancel-order.js — 認定事業者の受注（partnerOrders）から作った出荷をキャンセルしたときの、受注の戻し先（点検9の続き）。
// 決定（2026-11-13 次田さん）:「その都度、人が選ぶ」＝ キャンセルの画面で、受注をどこへ戻すかを人が選ぶ。
// 純粋関数だけを置く（Firestore にも DOM にも触らない）。テスト: node scripts/test-ship-cancel-order.mjs
// 呼び出し元: supply.js（キャンセルの画面・キャンセルのトランザクション）
//
// 受注の状態（supply.js PO_STATUS）と、出荷とのつながり:
//   received（受付済）  … 認定事業者のポータル・発注ファイルの取り込みで入った直後
//   confirmed（受注確定）… 「出荷へ」で出荷を依頼した時点（shipFromOrder）
//   shipped（出荷済）    … その出荷を「発送済にする」で（markShipped・Functions の倉庫の発送完了）
//   canceled（キャンセル）… 人が受注一覧の選択で変える
// 出荷をキャンセルしても受注の状態は今まで変えていなかった（出荷済・受注確定のまま残っていた）。
// 戻し先は一意に決まらないので、選ばせる。初期値は置かない（選ばないとキャンセルできない）。
// 入金・請求の処理と金額には触れない（ここは読むだけ）。

/** 受注の状態の表示名（supply.js の PO_STATUS と同じ） */
export const ORDER_STATUS_LABEL = { received: "受付済", confirmed: "受注確定", shipped: "出荷済", canceled: "キャンセル" };

/** 戻し先の選択肢（表示順）。初期値は無し */
export const ORDER_RETURN_CHOICES = [
  { value: "confirmed", label: "受注確定に戻す", hint: "受注一覧の「出荷へ」から出し直せます" },
  { value: "received", label: "受付済に戻す", hint: "受注を受け付けた段階に戻します（出し直すかは後で決める）" },
  { value: "canceled", label: "受注もキャンセルにする", hint: "受注そのものを取りやめにします" },
];
const CHOICE_VALUES = ORDER_RETURN_CHOICES.map((c) => c.value);

export const ORDER_RETURN_REQUIRED_MSG = "認定事業者の受注をどこへ戻すかを選んでください";
export const ORDER_RETURN_STALE_MSG = "受注の様子が画面を開いたときと変わっています。画面を閉じて、もう一度キャンセルを開いてください";

/** 認定事業者の受注から作った出荷か（partnerOrderId が入っているか） */
export function isPartnerOrderShipment(s) {
  return !!(s && typeof s.partnerOrderId === "string" && s.partnerOrderId.trim());
}

/** 選んだ戻し先が正しいか。正しければ ""、違えば画面に出す文 */
export function validateOrderReturn(choice) {
  if (!choice) return ORDER_RETURN_REQUIRED_MSG;
  if (!CHOICE_VALUES.includes(choice)) return `受注の戻し先が正しくありません（${String(choice)}）`;
  return "";
}

/**
 * キャンセルのときに受注について何をするかを決める。
 * @param {object} p
 * @param {object} p.ship        キャンセルにする出荷（partnerOrderId）
 * @param {object|null} p.order  受注（読めた中身。無ければ null）
 * @param {object[]} [p.shipments] 同じ受注にひも付く出荷（キャンセルにする出荷を含んでも含まなくてもよい）
 * @returns {{kind:"none"|"missing"|"others"|"ask", others?:string[]}}
 *   none    … 認定事業者の受注から作った出荷ではない（今までどおり。何も聞かない・何も変えない）
 *   missing … 受注が見つからない（消されている）。受注は変えない
 *   others  … 同じ受注にほかの生きた出荷がある。受注は変えない（others に出荷番号）
 *   ask     … 戻し先を人に選ばせる
 */
export function planOrderOnShipCancel({ ship, order, shipments = [] } = {}) {
  if (!isPartnerOrderShipment(ship)) return { kind: "none" };
  if (!order) return { kind: "missing" };
  const id = ship._id || ship.id || null;
  const others = (shipments || []).filter((x) => x && (x._id || x.id) !== id
    && x.partnerOrderId === ship.partnerOrderId && x.status !== "canceled");
  if (others.length) return { kind: "others", others: others.map((x) => x.soNumber || x._id || x.id || "") };
  return { kind: "ask" };
}

/**
 * 戻し先を選んだときに書く中身（Firestore の書き込みは呼び出し側）。
 * @param {object} p
 * @param {object} p.order    受注（status・soNumber・partnerOrderNo・partnerName）
 * @param {object} p.ship     キャンセルにする出荷（soNumber・_id/id）
 * @param {string} p.choice   ORDER_RETURN_CHOICES の value
 * @param {string} p.by       操作した人
 * @param {*} p.now           サーバー時刻の印（serverTimestamp()）
 * @param {string} p.nowIso   いまの時刻（ISO 文字列。配列の中にはサーバー時刻を入れられないため）
 * @param {string} [p.cancelReason] キャンセルの理由（「理由・一言」）
 * @returns {{orderPatch:object, logEntry:object, shipPatch:object, text:string}}
 *   orderPatch は lastShipCancel まで（shipCancelLog への追記は呼び出し側で arrayUnion(logEntry)）
 */
export function orderReturnWrites({ order, ship, choice, by, now, nowIso, cancelReason = "" } = {}) {
  const bad = validateOrderReturn(choice);
  if (bad) throw new Error(bad);
  const o = order || {};
  const s = ship || {};
  const from = o.status || "";
  const so = s.soNumber || "（番号なし）";
  const label = ORDER_RETURN_CHOICES.find((c) => c.value === choice).label;
  const text = `認定事業者の受注${o.soNumber ? ` ${o.soNumber}` : ""}: ${ORDER_STATUS_LABEL[from] || from || "—"} → ${ORDER_STATUS_LABEL[choice]}（${label}・${by || "—"} が選択）`;
  const logEntry = {
    at: nowIso || "", by: by || "", shipId: s._id || s.id || "", shipSoNumber: s.soNumber || "",
    from, to: choice, choiceLabel: label, cancelReason: cancelReason || "",
  };
  const orderPatch = {
    status: choice, updatedAt: now,
    lastShipCancel: { at: now, by: by || "", shipId: logEntry.shipId, shipSoNumber: logEntry.shipSoNumber,
      from, to: choice, choiceLabel: label, cancelReason: cancelReason || "" },
  };
  const shipPatch = {
    partnerOrderReturn: { orderId: s.partnerOrderId || "", orderSoNumber: o.soNumber || "", from, to: choice, choiceLabel: label, by: by || "" },
  };
  return { orderPatch, logEntry, shipPatch, text: `出荷 ${so} のキャンセルで、${text}` };
}

/** 受注一覧に出す、最後の出荷キャンセルの一行（無ければ ""） */
export function lastShipCancelNote(order) {
  const l = order && order.lastShipCancel;
  if (!l || !l.to) return "";
  return `出荷 ${l.shipSoNumber || ""} のキャンセルで「${ORDER_STATUS_LABEL[l.to] || l.to}」に（${l.by || "—"}）`;
}

/** キャンセルした出荷の行に出す一言（無ければ ""） */
export function shipOrderReturnNote(ship) {
  const r = ship && ship.partnerOrderReturn;
  if (!r || !r.to) return "";
  return `受注${r.orderSoNumber ? ` ${r.orderSoNumber}` : ""}は「${ORDER_STATUS_LABEL[r.to] || r.to}」に（${r.by || "—"}）`;
}
