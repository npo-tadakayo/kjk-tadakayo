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

  return { PLANS, BT_LABEL, USB_LABEL, BT_PRICE, USB_PRICE, ACCOMPANY_FEE, SKU, usbSku, computeAmounts, buildItems };
});
