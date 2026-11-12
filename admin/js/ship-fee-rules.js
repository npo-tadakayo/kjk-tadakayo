// 出荷の送料（請求する送料）の決まり（2026-11-12 次田さん決定: 事業所へ直接売るときは、タダカヨからの発送の送料を取らない）
//
// ・事業所へ請求する出荷＝ 送料は請求しない。配送方法（レターパック・ゆうパック）を選んでも送料欄は 0 円のまま。
//   名目には配送方法と「送料は当法人負担」を入れる（請求書・領収証には送料が0より大きいときだけ行が出るので、0円の行は出ない）。
//   手で金額を入れたときは、保存の前に確認を出す（止めはしない。例外の余地を残す）。
// ・認定事業者へ請求する出荷（卸・直送）＝ 今までどおり。料金表（税込の実費）を税抜に直して送料欄に入れる（仕入れ送料の転嫁）。
//
// 「事業所へ請求するか」の判定は、請求書の税基準（invoice-doc.js の priceIsTaxIncluded＝supply.js の billsPartner の逆）と同じ。
// 新しい判定は作らない（ズレると請求書と送料の扱いが食い違う）。
//
// ※ 倉庫の「発送済にする」で選ぶ配送の種別（レターパックプラス6台で1通・7台以上はゆうパック）は、
//    荷物をどう送るかの話で、ここ（請求の送料）とは別。ここでは扱わない。
import { priceIsTaxIncluded } from "./invoice-doc.js";

/** 事業所へ請求する出荷か（＝認定事業者に請求する出荷ではない）。請求書の判定と同じ */
export function billsOffice(s) { return priceIsTaxIncluded(s); }

/** 料金表（税込の実費）→ 送料欄（税抜）。supply.js の taxExcl と同じ丸め */
export function taxExclOf(inclusive) { return Math.round((Number(inclusive) || 0) / 1.1); }

export const OFFICE_FEE_NOTE = "送料は当法人負担";
/** 事業所向けの出荷に手で送料を入れて保存するときの確認 */
export const OFFICE_FEE_CONFIRM = "事業所向けの出荷では送料を請求しない決まりです。請求しますか？";

/**
 * 配送方法を選んだときに送料欄・名目に入れる値。null は「入れない（手入力のまま）」。
 * @param {object} p
 * @param {boolean} p.office          事業所へ請求する出荷か（billsOffice）
 * @param {string}  p.method          "letterpack" | "yupack" | "none" | ""（指定しない）
 * @param {number}  p.packs           レターパックの通数（letterpackCount の結果）
 * @param {number}  p.letterpackFee   レターパック1通の料金（税込の実費）
 * @param {string}  p.yupackSize      ゆうパックのサイズ
 * @param {string}  p.yupackRegion    ゆうパックのお届け地域の名前
 * @param {number}  p.yupackFee       ゆうパックの料金（税込の実費）
 * @returns {{fee:number,label:string}|null}
 */
export function autoShipFee({ office, method, packs, letterpackFee, yupackSize, yupackRegion, yupackFee }) {
  if (method === "none") return { fee: 0, label: "郵送なし（手渡し・持参）" };
  if (method === "letterpack") {
    const n = Number(packs) || 0;
    return office
      ? { fee: 0, label: `レターパック ${n}通（${OFFICE_FEE_NOTE}）` }
      : { fee: taxExclOf(n * (Number(letterpackFee) || 0)), label: `送料（レターパック ${n}通）` };
  }
  if (method === "yupack") {
    const where = `${yupackSize}サイズ・${yupackRegion || ""}`;
    return office
      ? { fee: 0, label: `ゆうパック ${where}（${OFFICE_FEE_NOTE}）` }
      : { fee: taxExclOf(Number(yupackFee) || 0), label: `送料（ゆうパック ${where}）` };
  }
  return null; // 「指定しない」＝手入力のまま
}

/**
 * 持ち出し → 発送 で依頼し直すときに入れ直す送料と、確認の文。
 * 事業所向け＝0円のまま（名目だけレターパックにする）。認定事業者向け＝今までどおりレターパックの送料。
 */
export function returnToShipFee({ office, packs, letterpackFee }) {
  const a = autoShipFee({ office, method: "letterpack", packs, letterpackFee });
  const patch = { shippingMethod: "letterpack", shippingFee: a.fee, shippingLabel: a.label };
  const confirmText = office
    ? `持ち出しから発送に変えました。\n事業所向けの出荷なので、送料は請求しません（0円のまま・名目は「${a.label}」）。この内容で依頼します。\nゆうパックなど別の送り方のときは、依頼のあと「送付先・数量を直す」で配送方法を直してください。`
    : null; // 認定事業者向けの文は supply.js 側（今までどおり）
  const doneText = office
    ? `持ち出しから発送に変えました（送料は当法人負担・0円）`
    : `持ち出しから発送に変えたため、送料を「${a.label}」にしました`;
  return { patch, confirmText, doneText };
}

/**
 * 保存の前に「送料を請求しますか？」の確認を出すか。
 * 事業所へ請求する出荷で、送料（請求に載る額）が 0 より大きいときだけ。
 * 持ち出し・物の出荷なし（送料を0円にして保存する）・請求書を出した後（金額を保存しない）は出さない。
 */
export function needsOfficeFeeConfirm({ office, fee, savesMoney = true }) {
  return !!office && !!savesMoney && (Number(fee) || 0) > 0;
}
