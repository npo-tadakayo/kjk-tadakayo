// カードリーダーの「接続のしかた」を、品番から人が読める形にする。
//
// なぜ必要か:
//   品番（cir415a-01 など）だけでは、USB接続なのか Bluetooth なのか、
//   USBなら端子が Type-A か Type-C かが分からない。事業所のパソコンに挿さるかどうかは
//   ここで決まるので、出荷・請求・送付状のどこを見ても分かる状態にする（2026-09-01）。
//
// 商品マスタ（products）の2フィールドから作る:
//   connection … "USB" / "Bluetooth+USB"     ＝ 接続の方式
//   connector  … "USB Type-A" / "USB Type-C" ＝ ケーブルの端子
//
// 実データ（2026-09-01 時点）:
//   cir315a-02  USB / USB Type-A        → USB Type-A
//   cir315a-04  USB / USB Type-C        → USB Type-C
//   cir415a-01  Bluetooth+USB / Type-C  → Bluetooth／USB Type-C
//     ※ CIR415A は Bluetooth 接続の機種で、USB Type-C でもつなげる（充電も同じ端子）。
//        商品名に型が入っていない唯一の機種なので、ここが無いと本当に判別できない。

/** 商品マスタ1件 → 「USB Type-A」「Bluetooth／USB Type-C」などの表示用ラベル */
export function connectionLabel(product) {
  if (!product) return "";
  const conn = String(product.connection || "").trim();
  const connector = String(product.connector || "").trim();
  if (!conn && !connector) return "";
  // Bluetooth 機は「無線でつながる」ことが先。USB端子は併記する
  if (/bluetooth/i.test(conn)) {
    return connector ? `Bluetooth／${connector}` : "Bluetooth";
  }
  // USB機は端子（A か C か）が知りたい情報そのもの
  return connector || conn;
}

/** 明細1行の接続方式。新しい明細には保存時に焼き込む。古い明細は商品マスタから引く */
export function itemConnection(item, products) {
  const saved = String(item?.connection || "").trim();
  if (saved) return saved;
  return connectionLabel(findProduct(item?.sku, products));
}

/** 明細1行 → 「cir415a-01（Bluetooth／USB Type-C）× 3」 */
export function itemLine(item, products) {
  const sku = String(item?.sku || "");
  const label = itemConnection(item, products);
  return `${sku}${label ? `（${label}）` : ""} × ${Number(item?.qty) || 0}`;
}

/** 品番から商品マスタを引く（マスタから消えた品番は null） */
export function findProduct(sku, products) {
  if (!sku || !Array.isArray(products)) return null;
  return products.find((p) => p.id === sku || p.sku === sku) || null;
}
