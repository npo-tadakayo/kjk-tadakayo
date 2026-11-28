// 見積もりの価格ロジック（正本）。
// 公開ページ（mitsumori.html）と Cloud Functions の両方から同じ計算を使うために1ファイルにしてある。
// ・ブラウザ: <script src="js/estimate-pricing.js"> で window.EstimatePricing に入る
// ・Functions: require("./estimate-pricing") で同じオブジェクトが返る
// ⚠ js/estimate-pricing.js は本ファイルのコピー。変えたら scripts/check-pricing-sync.sh で一致を確認する。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EstimatePricing = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PLANS = {
    houmon: { label: "訪問・通所・短期滞在系（居宅介護支援を含む）", maxQty: 3, limit: 64000 },
    kyojyu: { label: "居住・入所系",                                  maxQty: 2, limit: 55000 },
    other:  { label: "その他",                                        maxQty: 1, limit: 42000 },
  };
  const BT_LABEL  = "AB Circle CIR415A カードリーダー（Bluetooth）";
  const USB_LABEL = "AB Circle CIR315A カードリーダー（USB-A/C）";
  const BT_PRICE  = 14500;  // 税込
  const USB_PRICE = 6500;   // 税込
  // 伴走支援費（税込・補助対象台数別）
  const ACCOMPANY_FEE = { 1: 60000, 2: 55000, 3: 50000 };

  // 品番（products マスタ）との対応。見積もりの明細は品番で持つ（機種変更・新機種に耐えるため）
  const SKU = {
    BT: "cir415a-01",          // Bluetooth／USB Type-C
    USB_A: "cir315a-02",       // USB Type-A
    USB_C: "cir315a-04",       // USB Type-C
  };
  function usbSku(connector) {
    return connector === "C" ? SKU.USB_C : SKU.USB_A; // 未定（null）は Type-A を仮置き。改版で直せる
  }

  function computeAmounts(planKey, btQty, usbQty, btExtra, usbExtra) {
    const plan = PLANS[planKey];
    if (!plan) throw new Error(`unknown plan: ${planKey}`);
    btQty = Number(btQty) || 0; usbQty = Number(usbQty) || 0;
    btExtra = Number(btExtra) || 0; usbExtra = Number(usbExtra) || 0;
    const subsidyTotal = btQty + usbQty;
    const extraTotal   = btExtra + usbExtra;

    // 補助対象パート（税込・定価）
    const btSubtotal  = BT_PRICE  * btQty;
    const usbSubtotal = USB_PRICE * usbQty;
    const devSubsidyIncl = btSubtotal + usbSubtotal;
    // 伴走支援費（税込・補助対象台数別）
    const accFeeIncl = subsidyTotal > 0
      ? (ACCOMPANY_FEE[subsidyTotal] || ACCOMPANY_FEE[plan.maxQty] || 0)
      : 0;
    const subsidyPartSubtotal = devSubsidyIncl + accFeeIncl;
    // 特別割引（補助金上限ぴったりに収めるための調整）
    const discount = Math.max(0, subsidyPartSubtotal - plan.limit);
    const subsidyPartTotal = subsidyPartSubtotal - discount;
    const grantAmt = Math.min(plan.limit, subsidyPartTotal);

    // 補助対象外パート（税込・定価・そのまま自己負担）
    const btExtraSubtotal  = BT_PRICE  * btExtra;
    const usbExtraSubtotal = USB_PRICE * usbExtra;
    const extraPartTotal   = btExtraSubtotal + usbExtraSubtotal;

    const totalIncl = subsidyPartTotal + extraPartTotal;
    const selfPay = Math.max(0, subsidyPartTotal - grantAmt) + extraPartTotal;

    return {
      plan, btQty, usbQty, btExtra, usbExtra, subsidyTotal, extraTotal,
      btSubtotal, usbSubtotal, devSubsidyIncl, accFeeIncl,
      subsidyPartSubtotal, discount, subsidyPartTotal,
      btExtraSubtotal, usbExtraSubtotal, extraPartTotal,
      totalIncl, grantAmt, selfPay,
    };
  }

  // 見積もりの明細（品番ベース）を作る。usbConnector: "A" | "C" | null
  function buildItems({ btQty, usbQty, btExtra, usbExtra, usbConnector }) {
    const items = [];
    if ((Number(btQty) || 0) > 0 || (Number(btExtra) || 0) > 0) {
      items.push({ sku: SKU.BT, connector: null, subsidyQty: Number(btQty) || 0, extraQty: Number(btExtra) || 0 });
    }
    if ((Number(usbQty) || 0) > 0 || (Number(usbExtra) || 0) > 0) {
      items.push({ sku: usbSku(usbConnector), connector: usbConnector || null, subsidyQty: Number(usbQty) || 0, extraQty: Number(usbExtra) || 0 });
    }
    return items;
  }

  // ===== カードリーダーは事業所が自分で購入（タダカヨから機器を出さない＝0台）の見積もり（2026-11-28）=====
  // 伴走支援費 ＝ 助成区分の上限 − 事業所が買ったカードリーダーの金額（税込）。0未満にはしない。自己負担は0円（助成金の範囲内）。
  // 戻り値は computeAmounts と同じ形（台数・機器代は0）に ownReaderIncl（事業所が買った金額）を足したもの。
  // 例: その他（上限42,000）で事業所が11,800円で購入 → 伴走支援費 30,200・合計 30,200・助成金充当 30,200・自己負担 0
  function parseOwnReaderIncl(v) {
    if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : NaN;
    if (typeof v !== "string") return NaN;
    const s = v.trim().replace(/[,，円¥￥\s]/g, "");
    return /^\d{1,9}$/.test(s) ? Number(s) : NaN;
  }
  function computeOwnReaderAmounts(planKey, ownReaderIncl) {
    const plan = PLANS[planKey];
    if (!plan) throw new Error(`unknown plan: ${planKey}`);
    const own = Math.max(0, Math.round(Number(ownReaderIncl) || 0));
    const accFeeIncl = Math.max(0, plan.limit - own);
    return {
      plan, btQty: 0, usbQty: 0, btExtra: 0, usbExtra: 0, subsidyTotal: 0, extraTotal: 0,
      btSubtotal: 0, usbSubtotal: 0, devSubsidyIncl: 0, accFeeIncl,
      subsidyPartSubtotal: accFeeIncl, discount: 0, subsidyPartTotal: accFeeIncl,
      btExtraSubtotal: 0, usbExtraSubtotal: 0, extraPartTotal: 0,
      totalIncl: accFeeIncl, grantAmt: accFeeIncl, selfPay: 0, ownReaderIncl: own,
    };
  }
  // 見積もりの入力（台数、または「事業所が購入」＋金額）を確かめて金額を出す。画面の計算は信じず、サーバー
  // （staffCreateQuote・reviseQuote）と練習の代役がここを通す。d … { btQty, usbQty, btExtra, usbExtra, ownReader, ownReaderIncl }
  // 戻り値 { ok:true, calc, ownReader } ／ { ok:false, error }
  function calcFromInput(planKey, d) {
    const plan = PLANS[planKey];
    if (!plan) return { ok: false, error: "プランの指定が不正です" };
    const x = d || {};
    if (x.ownReader === true) {
      // 台数は1つずつ0か確かめる（合計で見ると 1 と −1 で0になってしまう・2026-11-28 レビュー中3）。未入力（空）は0とみなす
      const nonZero = ["btQty", "usbQty", "btExtra", "usbExtra"].some((k) => x[k] != null && x[k] !== "" && Number(x[k]) !== 0);
      if (nonZero) return { ok: false, error: "「カードリーダーは事業所が自分で購入」のときは、カードリーダーの台数をすべて0台にしてください" };
      const own = parseOwnReaderIncl(x.ownReaderIncl);
      if (!(own >= 1)) return { ok: false, error: "事業所が購入したカードリーダーの金額（税込）を、1円以上の整数で入れてください" };
      const calc = computeOwnReaderAmounts(planKey, own);
      if (calc.accFeeIncl < 1) {
        return { ok: false, error: `カードリーダーの金額が助成金の上限（¥${plan.limit.toLocaleString("ja-JP")}）以上のため、伴走支援費が0円になります。この見積もりは作れません` };
      }
      return { ok: true, calc, ownReader: true };
    }
    const calc = computeAmounts(planKey, x.btQty, x.usbQty, x.btExtra, x.usbExtra);
    if (calc.subsidyTotal < 1) return { ok: false, error: "補助対象のカードリーダーを1台以上にしてください" };
    if (calc.subsidyTotal > plan.maxQty) return { ok: false, error: `${plan.label}の補助対象は最大${plan.maxQty}台です` };
    return { ok: true, calc, ownReader: false };
  }
  // ===== 0台の見積もりで伴走支援費が報酬の下限を下回るとき（2026-11-28 次田さん決定・レビュー中4）=====
  // 伴走支援費（＝上限 − 購入額）が OWN_READER_FLOOR 円を下回る見積もりは、管理者だけが作成・改定できる。そのときは購入額の根拠が必須。
  // 下限は PM 値引きの報酬の下限（FLOOR・税込）と同じ値（scripts/test-own-reader.mjs が一致を確かめる）
  const OWN_READER_FLOOR = 15000;
  const OWN_READER_BASIS_MAX = 200;
  // 購入額の根拠（任意の短い文。例「自費で購入 11,800円・領収書あり」）。前後の空白を除き、改行は空白にして200字まで
  function cleanOwnReaderBasis(v) {
    return typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, OWN_READER_BASIS_MAX) : "";
  }
  // calc … calcFromInput の calc（0台のときだけ判定する）。isAdmin … 操作する人が管理者か。basis … 根拠の欄の値
  // 戻り値 { ok, error, belowFloor, basis }
  function checkOwnReaderPolicy({ calc, isAdmin, basis } = {}) {
    const b = cleanOwnReaderBasis(basis);
    if (!calc || !(Number(calc.ownReaderIncl) > 0)) return { ok: true, belowFloor: false, basis: "" };
    const fee = Number(calc.accFeeIncl) || 0;
    const belowFloor = fee < OWN_READER_FLOOR;
    const floorText = `¥${OWN_READER_FLOOR.toLocaleString("ja-JP")}`;
    if (belowFloor && !isAdmin) {
      return { ok: false, belowFloor, basis: b, error: `伴走支援費（接続サポート等経費）が ${floorText} を下回る見積もり（伴走支援費 ¥${fee.toLocaleString("ja-JP")}）は、管理者だけが作成・変更できます。購入額をもう一度確かめるか、管理者に依頼してください` };
    }
    if (belowFloor && !b) {
      return { ok: false, belowFloor, basis: b, error: `伴走支援費が ${floorText} を下回るため、購入額の根拠（例: 自費で購入 11,800円・領収書あり）を入れてください` };
    }
    return { ok: true, belowFloor, basis: b };
  }

  // 計算結果 → quotes.amounts の形。事業所が購入した見積もりだけ ownReaderIncl を持つ（無い見積もりの形は今までと同じ）
  function quoteAmounts(calc) {
    const a = {
      readers: calc.devSubsidyIncl, accompanyFee: calc.accFeeIncl, discount: calc.discount,
      subsidyPartTotal: calc.subsidyPartTotal, extraPartTotal: calc.extraPartTotal,
      totalIncl: calc.totalIncl, grantAmt: calc.grantAmt, selfPay: calc.selfPay,
    };
    if (Number(calc.ownReaderIncl) > 0) a.ownReaderIncl = Number(calc.ownReaderIncl);
    return a;
  }
  // 保存済みの見積もり（plan・items・amounts）の値引き前の金額を、料金の正本で出し直す（値引き・見積書の照合用）
  function calcOfSavedQuote(q) {
    const own = Number(q && q.amounts && q.amounts.ownReaderIncl) || 0;
    if (own > 0) return computeOwnReaderAmounts(q.plan, own);
    let bt = 0, usb = 0, btx = 0, usbx = 0;
    const items = q && Array.isArray(q.items) ? q.items : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (it.sku === SKU.BT) { bt += Number(it.subsidyQty) || 0; btx += Number(it.extraQty) || 0; }
      else { usb += Number(it.subsidyQty) || 0; usbx += Number(it.extraQty) || 0; }
    }
    return computeAmounts(q && q.plan, bt, usb, btx, usbx);
  }

  return { PLANS, BT_LABEL, USB_LABEL, BT_PRICE, USB_PRICE, ACCOMPANY_FEE, SKU, usbSku, computeAmounts, buildItems,
    parseOwnReaderIncl, computeOwnReaderAmounts, calcFromInput, quoteAmounts, calcOfSavedQuote,
    OWN_READER_FLOOR, OWN_READER_BASIS_MAX, cleanOwnReaderBasis, checkOwnReaderPolicy };
});
