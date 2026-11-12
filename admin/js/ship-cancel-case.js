// admin/js/ship-cancel-case.js — 出荷をキャンセルしたあとの案件の扱い（点検9・2026-11-12 次田さん決定）。
// 決定:「出荷をキャンセルした後は、見積書の送付、およびその見積もりで良いかの確認となります。」
//   ＝ 案件を「確認中」（2・見積もりを送って返事を待つ段階）に戻し、見積もりは「発行中」に戻して、もう一度送って確認を取り直す。
// 純粋関数だけを置く（Firestore にも DOM にも触らない）。テスト: node scripts/test-ship-cancel-case.mjs
// 呼び出し元: supply.js（出荷のキャンセルのトランザクション・キャンセルの画面の予告）／case-detail.js（次の一手の下のお知らせ）
//
// 戻すのは次のすべてに当てはまるときだけ（それ以外は戻さない）:
//   ・案件にひも付く出荷が全部キャンセル（一部だけのキャンセルは戻さない）
//   ・発送したことのある出荷が無い（キャンセル前の状態 statusBeforeCancel が発送済・請求済・入金済のものも含めて無い）
//   ・入金の記録が1件も無い（返金済みでも「入金があった」として扱う）・請求書を発行・送付した記録が無い
//   ・案件が 3 受注確定・5 担当者決定・6 事前準備中
// 入金・請求・発送の記録がある、または 7 伴走支援待ち以降の案件は「自動では戻さない」（保留）。画面に理由を出し、対応記録に残す。
// 入金・消込の処理と金額には触れない（ここは読むだけ）。
import { shipStatusOf, paymentsOf } from "./ship-flow.js";

export const REVERT_TO_STATUS = 2;              // 確認中（見積もりを送って返事を待つ段階）
export const REVERT_FROM_STATUSES = [3, 5, 6];  // 受注確定・担当者決定・事前準備中
export const HOLD_PROGRESSED_STATUSES = [7, 8, 9, 10, 11, 12]; // 伴走支援待ち以降（日程が決まっている・支援が進んでいる）
const ENGAGED = [...REVERT_FROM_STATUSES, ...HOLD_PROGRESSED_STATUSES];
const SHIPPED_LIKE = ["shipped", "invoiced", "paid"];
const INVOICED_LIKE = ["invoiced", "paid"];

export const HOLD_REASON_TEXT = {
  payment: "入金の記録がある",
  invoice: "請求書を発行（送付）している",
  shipped: "発送したあとにキャンセルした出荷がある",
  progressed: "伴走支援待ち以降まで進んでいる",
};
export const SHIP_CANCEL_STALE_TEXT =
  "承諾書の取り直しが要ります（出荷をキャンセルして見積もり確認中に戻したため、前の承諾書の発注は取り消しになりました）";

/** キャンセル前の状態も含めて「その出荷の状態」（キャンセル済みは statusBeforeCancel を見る） */
function effectiveStatus(s) {
  const st = shipStatusOf(s);
  return st === "canceled" ? (s.statusBeforeCancel || "") : st;
}
function hasPayment(s) {
  return paymentsOf(s).some((p) => (Number(p && p.amount) || 0) > 0);
}
function hasInvoice(s) {
  return !!(s.invoicedAt || s.invoiceMailedAt) || INVOICED_LIKE.includes(effectiveStatus(s));
}
function wasShipped(s) {
  return SHIPPED_LIKE.includes(effectiveStatus(s));
}

/**
 * キャンセル後の案件の扱いを決める。
 * @param {object} p
 * @param {object} p.kase        案件（status・archived）
 * @param {object[]} p.shipments 同じ案件の出荷（キャンセルにする出荷はキャンセル前の状態のままでよい）
 * @param {string} [p.canceledId] いまキャンセルにする出荷の id（_id か id）。この出荷はキャンセル済みとして数える
 * @returns {{kind:"none"|"revert"|"hold", reasons:string[]}}
 *   none   … 何もしない（ほかに生きた出荷がある・受注前／失注／完了・アーカイブ）
 *   revert … 確認中に戻す
 *   hold   … 自動では戻さない（reasons に HOLD_REASON_TEXT のキー）
 */
export function planShipCancelRevert({ kase, shipments, canceledId = null } = {}) {
  const none = { kind: "none", reasons: [] };
  if (!kase || kase.archived) return none;
  const list = (shipments || []).filter(Boolean);
  if (!list.length) return none;
  const idOf = (s) => s._id || s.id || null;
  const isCanceledNow = (s) => (canceledId && idOf(s) === canceledId) || shipStatusOf(s) === "canceled";
  if (list.some((s) => !isCanceledNow(s))) return none; // 一部だけのキャンセル
  const st = Number(kase.status);
  if (!ENGAGED.includes(st)) return none; // 1・2（受注前）・4（失注）・13（完了）は触らない
  // いまキャンセルにする出荷は「キャンセル前の状態」をそのまま effectiveStatus に使う（キャンセル前なので status がそのまま）
  const reasons = [];
  if (list.some(hasPayment)) reasons.push("payment");
  if (list.some(hasInvoice)) reasons.push("invoice");
  if (list.some(wasShipped)) reasons.push("shipped");
  if (HOLD_PROGRESSED_STATUSES.includes(st)) reasons.push("progressed");
  return reasons.length ? { kind: "hold", reasons } : { kind: "revert", reasons: [] };
}

/** 保留の理由の文（「入金の記録がある・請求書を…」） */
export function holdReasonsText(reasons) {
  return (reasons || []).map((r) => HOLD_REASON_TEXT[r] || r).join("・");
}

/** 保留のときに画面に出す文。入金・請求があるときは決まった言い方にする */
export function holdMessage(reasons) {
  const rs = reasons || [];
  const money = rs.includes("payment") || rs.includes("invoice");
  const head = money
    ? "入金（請求）があるため自動では戻しません。確認してください"
    : "自動では見積もり確認中に戻しません。確認してください";
  return `${head}（${holdReasonsText(rs)}）`;
}

/**
 * 確認中に戻すときに書く中身（Firestore の書き込みは呼び出し側）。
 * @param {object} p
 * @param {object} p.kase          案件（status・orderedAt・shipmentId・orderConsentToken）
 * @param {object[]} p.quotes      同じ案件の見積もり（id・status・estNo・version・acceptedAt ほか）
 * @param {object} p.ship          キャンセルにする出荷（soNumber・_id/id）
 * @param {string} p.by            操作した人（表示名かメール）
 * @param {*} p.now                サーバー時刻の印（serverTimestamp()）
 * @param {string} [p.cancelReason] キャンセルの理由
 * @param {string} [p.orderedYmd]  外す受注日の表示用（YYYY-MM-DD・無ければ空）
 * @returns {{casePatch:object, quotePatches:{id:string, patch:object}[], activity:{subject:string, body:string}}}
 */
export function revertWrites({ kase, quotes, ship, by, now, cancelReason = "", orderedYmd = "" } = {}) {
  const k = kase || {};
  const s = ship || {};
  const so = s.soNumber || "（番号なし）";
  const accepted = (quotes || []).filter((q) => q && q.status === "accepted");
  const fromStatus = Number(k.status) || null;
  const consent = !!k.orderConsentToken;
  const casePatch = {
    status: REVERT_TO_STATUS, statusChangedAt: now, statusChangedTo: REVERT_TO_STATUS, // 進み具合の帯（case-progress.js statusChangePatch と同じ2項目）
    orderedAt: null,      // 「見積もり発行済（未申込）」の絞り込みに戻す。前の受注日は shipCancelRevert に残す
    shipmentId: null,     // キャンセル済みの出荷を指したままにしない（次の申込で新しい下書きを作る）
    // 申込の経路も外す。残すと案件一覧の「Web申込済」の絞り込み（cases.js quoteMatch）に出続けるため（2026-11-13 小さな指摘5）。
    // 前の値は shipCancelRevert.prevOrderedVia に残す。次に申し込まれたら Functions が "web"／"staff" を書き直す
    orderedVia: null,
    updatedAt: now,
    shipCancelRevert: {
      at: now, by: by || "", soNumber: s.soNumber || "", shipId: s._id || s.id || "",
      fromStatus, prevOrderedAt: k.orderedAt || null, prevShipmentId: k.shipmentId || null,
      prevOrderedVia: k.orderedVia || null,
      quoteIds: accepted.map((q) => q.id),
    },
  };
  if (consent) Object.assign(casePatch, { orderConsentStale: true, orderConsentStaleReason: "ship_canceled" });
  const quotePatches = accepted.map((q) => ({
    id: q.id,
    patch: {
      status: "issued", shipmentId: null, shipmentNo: null, acceptedAt: null, acceptedBy: null,
      revertedAt: now, revertedBy: by || "", revertReason: "ship_canceled",
      prevAccept: {
        acceptedAt: q.acceptedAt || null, acceptedBy: q.acceptedBy || null, acceptedVia: q.acceptedVia || null,
        shipmentId: q.shipmentId || null, shipmentNo: q.shipmentNo || null, consentToken: q.consentToken || null,
      },
    },
  }));
  const qText = accepted.length
    ? accepted.map((q) => `${q.estNo || q.id}${q.version ? ` 第${q.version}版` : ""}`).join("・")
      + " を「申し込み済み」から「発行中」に戻しました。見積書をもう一度送って、この内容でよいか確認してください"
      + "（有効期限が切れていれば、見積もりを直して送り直します）"
    : "申し込み済みの見積もりはありません。見積もりを作って送り、この内容でよいか確認してください";
  const lines = [
    `操作した人: ${by || "—"}`,
    `キャンセルした出荷: ${so}${cancelReason ? `（理由: ${cancelReason}）` : ""}`,
    `案件の状態: ${fromStatus ?? "—"} → ${REVERT_TO_STATUS}（確認中）`,
    `見積もり: ${qText}`,
    k.orderedAt ? `受注日${orderedYmd ? ` ${orderedYmd}` : ""} を外しました（前の受注日は案件の記録に残しています）` : "",
    consent ? "承諾書: 前の承諾書の発注は取り消しになりました。もう一度承諾書をいただいてください（取り直しが要ります）" : "",
  ].filter(Boolean);
  return {
    casePatch, quotePatches,
    activity: { subject: `出荷 ${so} のキャンセルで、案件を見積もり確認中に戻しました`, body: lines.join("\n") },
  };
}

/** 保留のときの対応記録（案件の状態・見積もりは変えない） */
export function holdActivity({ ship, by, reasons, cancelReason = "" } = {}) {
  const so = (ship && ship.soNumber) || "（番号なし）";
  return {
    subject: `出荷 ${so} をキャンセル（案件の状態は自動では戻していません）`,
    body: [
      `操作した人: ${by || "—"}`,
      `キャンセルした出荷: ${so}${cancelReason ? `（理由: ${cancelReason}）` : ""}`,
      holdMessage(reasons),
      "見積もり確認中に戻すか、返金・請求の取り消しが要るかを確かめてください（入金・消込は変えていません）",
    ].join("\n"),
  };
}

/** キャンセルの画面に出す予告（何が起きるか）。plan は planShipCancelRevert の結果 */
export function cancelPreviewText(plan, kase) {
  if (!plan || plan.kind === "none") return "";
  if (plan.kind === "hold") return `この出荷で案件の出荷はすべてキャンセルになりますが、${holdMessage(plan.reasons)}`;
  return "この出荷で案件の出荷はすべてキャンセルになります。案件を「確認中」（見積もりを送って確認する段階）に戻し、"
    + "申し込み済みの見積もりを「発行中」に戻します（対応記録に残ります）"
    + (kase && kase.orderConsentToken ? "。承諾書は取り直しになります" : "");
}

/**
 * 案件詳細に出すお知らせ（記録のずれの点検）。出荷は案件詳細で読んだもの。
 *   ・確認中に戻した案件（まだ新しい出荷が無い）… 見積もりを送り直して確認する、と出す
 *   ・出荷が全部キャンセルなのに受注確定以降のままの案件 … 保留の理由か、この仕組みより前のキャンセルである旨を出す
 * @returns {{key:string, warn:boolean, text:string}|null}
 */
export function shipCancelNoticeOf(kase, shipments) {
  if (!kase || kase.archived) return null;
  const list = (shipments || []).filter(Boolean);
  const live = list.filter((s) => shipStatusOf(s) !== "canceled");
  const st = Number(kase.status);
  if (st === REVERT_TO_STATUS && kase.shipCancelRevert && !live.length) {
    const so = kase.shipCancelRevert.soNumber || "";
    return { key: "shipCancelReverted", warn: false,
      text: `出荷${so ? ` ${so} ` : ""}をキャンセルしたため、見積もり確認中に戻しました。見積書をもう一度送って、この内容でよいか確認してください` };
  }
  if (!list.length || live.length || !ENGAGED.includes(st)) return null;
  const plan = planShipCancelRevert({ kase, shipments: list });
  if (plan.kind === "hold") {
    return { key: "shipCancelHold", warn: true, text: `出荷がすべてキャンセルになっています。${holdMessage(plan.reasons)}` };
  }
  // 戻せる条件なのに受注確定以降のまま＝この仕組みが入る前にキャンセルした案件、または戻したあとで手で状態を進めた案件（自動では直さない）
  return { key: "shipCancelLegacy", warn: true,
    text: "出荷がすべてキャンセルになっていますが、案件は受注確定以降のままです。"
      + "見積もり確認中に戻すか、出荷を作り直すかを確かめてください" };
}
