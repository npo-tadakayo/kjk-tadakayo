// 経理への期末報告の数字を、本番 Firestore を「読むだけ」で集計する（画面と同じ accounting-rules.js を使う・2026-11-24）。
//
// 使い方（リポジトリ直下で。タダカヨの gcloud を使うので gcp run で包む）:
//   zsh -ic 'gcp run tadakayo node scripts/accounting-snapshot.mjs'                 締め日 2026-10-31
//   zsh -ic 'gcp run tadakayo node scripts/accounting-snapshot.mjs --cutoff 2026-10-31 --start 2025-11-01 --json'
//   --csv <フォルダ>  項目ごとの CSV を書き出す（画面の CSV と同じ中身。個人情報は含まないが社外に出さない）
//
// 🔴 書き込みはしない。使うのは scripts/lib/firestore-rest-readonly.mjs の GET（文書の一覧）だけ。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { listAll, accessToken } from "./lib/firestore-rest-readonly.mjs";
import { buildReport, inventoryAt, reportCsvFiles, DEFAULT_CUTOFF } from "../admin/js/accounting-rules.js";

const PROJECT = "kjk-tadakayo";
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const cutoff = opt("--cutoff") || DEFAULT_CUTOFF;
const start = opt("--start") || "";
const csvDir = opt("--csv");
const asJson = args.includes("--json");

const token = accessToken();
const [shipments, purchaseOrders, movements, locations, products] = await Promise.all(
  ["shipments", "purchaseOrders", "inventoryMovements", "locations", "products"].map((c) => listAll(PROJECT, c, { token })));
const rep = buildReport({ shipments, purchaseOrders, movements, locations, products: products.map((p) => ({ ...p, id: p._id })) }, { cutoff, start });
// 答え合わせ用: 到着日の補正なし（記録日だけ）と、location_assign を足し算してしまう素朴な数え方
const noAdj = inventoryAt(movements, purchaseOrders, { cutoff, locations, arrivalBasis: false });
const naive = movements.filter((m) => { const d = new Date(Date.parse(m.createdAt?._ts) + 9 * 3600e3).toISOString().slice(0, 10); return d <= cutoff; })
  .reduce((a, m) => { a.total += Number(m.delta) || 0; if (!m.locationId) a.unset += Number(m.delta) || 0; return a; }, { total: 0, unset: 0 });
// いまの在庫（products.stock）と、動きの記録を全部足したもの（今日まで）のずれ
const nowAll = inventoryAt(movements, purchaseOrders, { cutoff: "9999-12-31", locations, arrivalBasis: false });
const productStock = products.reduce((a, p) => a + (Number(p.stock) || 0), 0);

if (asJson) {
  console.log(JSON.stringify({ rep, noAdj: { total: noAdj.total, unset: noAdj.unset }, naive, nowAll: nowAll.total, productStock }, null, 2));
} else {
  const y = (n) => (n == null ? "未確認" : `${Number(n).toLocaleString("ja-JP")}円`);
  console.log(`経理への期末報告（本番・読み取りのみ） 期首 ${rep.start} 〜 締め日 ${rep.cutoff}`);
  console.log(`  読んだ件数: 出荷 ${shipments.length}／発注 ${purchaseOrders.length}／在庫の動き ${movements.length}／保管場所 ${locations.length}／品目 ${products.length}`);
  console.log("\n[要約]");
  for (const s of rep.summary) console.log(`  ${s.no}. ${s.title}: ${s.count == null ? "未確認" : s.count}${s.unit || "件"}・${y(s.amount)}（${s.note}）`);
  console.log("\n[1] 売上の月別");
  for (const m of rep.sales.byMonth) console.log(`  ${m.month}: ${m.count}件 ${y(m.total)}（消費税 ${y(m.tax)}）直接 ${m.direct.count}件 ${y(m.direct.total)}／直送 ${m.partner.count}件 ${y(m.partner.total)}`);
  console.log(`  計: ${rep.sales.count}件 ${y(rep.sales.total)} 消費税 ${y(rep.sales.tax)}`);
  console.log(`\n[2] 未収金: ${rep.receivables.count}件 ${y(rep.receivables.total)}`);
  console.log(`\n[3] 未請求出荷: ${rep.unbilled.count}件 ${y(rep.unbilled.total)}（締め日後に請求済 ${rep.unbilled.later.count}件 ${y(rep.unbilled.later.total)}／いまも未請求 ${rep.unbilled.still.count}件 ${y(rep.unbilled.still.total)}）`);
  console.log(`\n[4] 在庫（到着日で補正）: ${rep.inventory.total}台 ${y(rep.inventory.amount)}・保管場所未設定 ${rep.inventory.unset}台・移動中 ${rep.inventory.transit}台・到着日で日付を替えた記録 ${rep.inventory.adjusted}件`);
  for (const r of rep.inventory.rows) console.log(`    ${r.location} / ${r.sku}: ${r.qty}台 × ${r.unitCost ?? "?"} = ${r.amount ?? "?"}`);
  console.log(`    補正なし（記録日だけ）: ${noAdj.total}台（保管場所未設定 ${noAdj.unset}台）`);
  console.log(`    素朴な足し算（location_assign も足す）: ${naive.total}台（保管場所未設定 ${naive.unset}台）`);
  console.log(`    参考: 動きの記録を今日まで全部足すと ${nowAll.total}台／品目マスタの在庫 products.stock の合計 ${productStock}台（ずれ ${productStock - nowAll.total}台）`);
  console.log(`\n[5] 未着品: ${rep.openOrders.count}件 ${rep.openOrders.qty}台 ${y(rep.openOrders.amount)}`);
  for (const r of rep.openOrders.rows) console.log(`    ${r.poNumber} 発注 ${r.orderDate} 先方出荷 ${r.supplierShipDate || "—"} 到着 ${r.arrivedDate || "—"}（${r.arrivalBasis || "—"}）${r.state} ${r.qty}台 ${y(r.amount)}`);
  console.log(`\n[6] 仕入: ${rep.purchases.count}件 ${rep.purchases.qty}台 品代 ${y(rep.purchases.goods)} 送料 ${y(rep.purchases.shippingFee)}`);
  for (const r of rep.purchases.rows) console.log(`    ${r.poNumber} ${r.date}（${r.dateBasis}）${r.qty}台 ${y(r.goods)}＋${y(r.shippingFee)}${r.dropship ? " 直送" : ""}`);
  console.log(`\n[7] 買掛金: ${rep.payables.recorded ? `${rep.payables.count}件 ${y(rep.payables.total)}` : "支払いの記録は未登録（未確認）"}`);
  // 点検（独立レビュー 2026-11-24）: 締め日に関係なく、記録そのものの件数
  const live = shipments.filter((x) => !x._practiceBy && x.status !== "canceled" && x.status !== "draft");
  const used = live.filter((x) => (Number(x.overpayUsed) || 0) > 0);
  const credited = live.filter((x) => (Number(x.creditApplied) || 0) > 0 || (Array.isArray(x.creditFrom) && x.creditFrom.length));
  const undatedPay = live.filter((x) => {
    const list = Array.isArray(x.payments) && x.payments.length ? x.payments : (Number(x.paymentAmount) > 0 ? [{ date: x.paidAt || "" }] : []);
    return list.some((p) => !p.date && !p.recordedAt) || (x.status === "paid" && !list.length && !x.paidAt);
  });
  const paidNoInv = live.filter((x) => x.status === "paid" && !x.invoicedAt);
  const fmt = (arr) => `${arr.length}件${arr.length ? `（${arr.map((x) => x.soNumber).join("・")}）` : ""}`;
  console.log(`\n[点検] overpayUsed>0: ${fmt(used)}／充当先（creditApplied か creditFrom あり）: ${fmt(credited)}／日付の無い入金: ${fmt(undatedPay)}／invoicedAt が空の入金済: ${fmt(paidNoInv)}`);
  console.log(`  集計で除いた: 未収金（入金の日付不明）${rep.receivables.undated.length}件／未請求（入金済で請求日なし）${rep.unbilled.paidNoInvoice.length}件／未着品のうち届いたが入荷登録前 ${rep.openOrders.arrivedUnregistered.count}件`);
  console.log(`\n[8] 返金 ${rep.refunds.refunds.length}件 ${y(rep.refunds.refundTotal)}／充当 ${rep.refunds.credits.length}件 ${y(rep.refunds.creditTotal)}／締め日時点の過入金 ${rep.refunds.overpaid.length}件 ${y(rep.refunds.overpaidTotal)}`);
}
if (csvDir) {
  mkdirSync(csvDir, { recursive: true });
  for (const f of reportCsvFiles(rep)) writeFileSync(join(csvDir, f.filename), f.csv);
  console.error(`CSV を ${csvDir} に書き出しました`);
}
