// カードリーダー卸価格を AB Circle 正式回答(2026-06-05)・新版(2026-06-06)へ更新する一回限りスクリプト。
// 卸＝仕入と同額（パススルー・2026-06-11 次田 確定）。
// 正本: 介護情報基盤伴走支援/04_認定基準/カードリーダー価格表・送料規定.md §2
//
// 使い方（プロジェクトは kjk-tadakayo に固定）:
//   cd functions
//   node update-prices.cjs            # ドライラン（現在値の確認のみ・書き込みなし）
//   node update-prices.cjs --apply    # 実際に更新
//
// 認証: ADC（gcloud auth application-default login / tadakayo）または SA。

const admin = require("firebase-admin");
const PROJECT = "kjk-tadakayo";
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

// 数量帯: [1台, 2〜10台, 11〜30台, 31台〜]（税別）
const PRICES = {
  "cir415a-01": [7650, 7520, 7050, 7050], // BT
  "cir315a-02": [3580, 3490, 3000, 2950], // USB-A
  "cir315a-04": [3770, 3680, 3160, 3100], // USB-C
};
const FIELDS = ["wholesale1", "wholesale2_10", "wholesale11_30", "wholesale31"];
const APPLY = process.argv.includes("--apply");

(async () => {
  console.log(`projectId = ${PROJECT} / mode = ${APPLY ? "APPLY（書き込み）" : "DRY-RUN（読み取りのみ）"}`);
  console.log("--- products（仕入＝卸・パススルー） ---");
  for (const [sku, arr] of Object.entries(PRICES)) {
    const ref = db.collection("products").doc(sku);
    const snap = await ref.get();
    const cur = snap.exists ? snap.data() : null;
    const before = cur ? FIELDS.map((f) => cur[f]) : "（ドキュメント無し）";
    console.log(`${sku}: 現在 ${JSON.stringify(before)} → 新 ${JSON.stringify(arr)}${snap.exists ? "" : "  ※docが無いので作成"}`);
    if (APPLY) {
      const data = {}; FIELDS.forEach((f, i) => { data[f] = arr[i]; });
      data.wholesaleUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(data, { merge: true });
    }
  }

  console.log("--- appConfig/settings.partnerPricing（認定事業所卸） ---");
  const sref = db.collection("appConfig").doc("settings");
  const ss = await sref.get();
  const curPP = (ss.exists && ss.data().partnerPricing) || null;
  console.log(`現在: ${JSON.stringify(curPP)}`);
  console.log(`新値: ${JSON.stringify(PRICES)}`);
  if (APPLY) {
    await sref.set({
      partnerPricing: PRICES,
      pricingUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      pricingUpdatedBy: "update-prices.cjs (2026-06 passthrough)",
    }, { merge: true });
  }

  console.log(APPLY ? "✅ 更新しました" : "（ドライラン完了・--apply で書き込み）");
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
