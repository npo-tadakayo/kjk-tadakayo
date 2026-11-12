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
import { priceIsTaxIncluded, invoiceTotals } from "./invoice-doc.js";
import { isLocked } from "./ship-flow.js";

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

function yen(n) { const v = Number(n || 0); return (v < 0 ? "−" : "") + "¥" + Math.abs(v).toLocaleString("ja-JP"); }
const OFFICE_FEE_SUFFIX = `（${OFFICE_FEE_NOTE}）`;

/**
 * 保存する送料の名目。事業所向けで送料が 0 円より大きいまま保存するときは、「（送料は当法人負担）」を外して
 * 「送料（レターパック 1通）」の形に直す（請求書に「…当法人負担 ¥660」と印字されないように・2026-11-12 レビュー中-2）。
 * 「当法人負担」の名目を使うのは送料が 0 円のときだけ。それ以外（認定事業者向け・0円・手で書いた名目）はそのまま。
 */
export function feeLabelForSave({ office, fee, label }) {
  const l = String(label || "").trim();
  if (!office || !((Number(fee) || 0) > 0) || !l.endsWith(OFFICE_FEE_SUFFIX)) return l;
  const base = l.slice(0, -OFFICE_FEE_SUFFIX.length).trim();
  return base ? `送料（${base}）` : "送料";
}

/**
 * 出荷種別（請求先）を変えるときに確認の文へ添える一言（金額は自動では変えない）。
 *   ・事業所向けへ変える × 送料あり ＝ 送料を請求しない決まりの案内（2026-11-12）
 *   ・認定事業者向けへ変える × 送料0円 × 郵送する出荷 ＝ 送料を入れる案内（2026-11-12 レビュー中-4）
 * どちらでもなければ ""。
 */
export function shipTypeChangeFeeNote({ from, to }) {
  const fee = Number(from && from.shippingFee) || 0;
  const wasOffice = billsOffice(from || {}), nowOffice = billsOffice(to || {});
  if (nowOffice && !wasOffice && fee > 0)
    return `送料 ${yen(fee)}（税抜）が残っています。事業所向けの出荷では送料を請求しない決まりです。請求しない場合は、変更のあと「送付先・数量を直す」で送料を0円にしてください。`;
  if (!nowOffice && wasOffice && fee === 0 && (from && from.shippingMethod) !== "none")
    return "送料が0円です。認定事業者向けは送料を請求する運用です。変更のあと「送付先・数量を直す」で送料を入れてください。";
  return "";
}

/**
 * 請求済にする・請求書を出す（印刷/PDF・メール）ときの確認の文。出さないときは null（2026-11-12 レビュー中-1）。
 * 事業所向けで送料が 0 円より大きく、まだ金額を直せる（請求済・入金済・キャンセルでない）出荷だけ。止めはしない。
 */
export function invoiceFeeConfirmText(s) {
  if (!s || !billsOffice(s) || isLocked(s)) return null;
  const t = invoiceTotals(s);
  if (!(t.shipExcl > 0)) return null;
  return `事業所向けの出荷では送料を請求しない決まりです。送料 ${yen(t.shipIncl)}（税込・税抜 ${yen(t.shipExcl)}）を請求しますか？`
    + `\n（請求しないなら「キャンセル」を押し、出荷を修正して送料を0円にしてください）`;
}

/**
 * 出荷の修正で台数を変えて、配送方法から送料を入れ直すときの確認の文。出さないときは null（2026-11-13）。
 * 既に送料が入っている（0円より大きい）出荷で、入れ直すと送料が 0 円になるときだけ確かめる
 * （＝事業所向けの決まりで 0 円になる場合。以前は確認なしで 0 円になっていた）。
 * 新規登録・送料0円の出荷・入れ直しても送料が残る（認定事業者向けの通数の増減など）ときは出さない。
 * @param {object} p
 * @param {boolean} p.editing    既存の出荷の修正か
 * @param {number}  p.currentFee いま送料欄に入っている送料（税抜）
 * @param {number}  p.nextFee    入れ直したときの送料（税抜。autoShipFee の fee）
 */
export function qtyChangeFeeConfirmText({ editing, currentFee, nextFee }) {
  const cur = Number(currentFee) || 0, next = Number(nextFee) || 0;
  if (!editing || !(cur > 0) || next !== 0) return null;
  return `台数を変えたので送料を入れ直します。\n事業所向けの出荷では送料を請求しない決まりのため、送料 ${yen(cur)}（税抜）が 0 円になります。0 円にしますか？`
    + `\n（「キャンセル」を押すと、送料は ${yen(cur)} のまま残します。このあと台数を変えても、この画面を閉じるまでは聞きません）`;
}
