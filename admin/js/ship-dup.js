// 出荷の下書きの重複警告と、保管場所ごとの在庫の目安。純粋関数のみ（DOM・Firestore に触れない）。
// 設計: docs/CRM改善_設計_20261021.md §6（W）。テスト: node scripts/test-ship-dup.mjs
// 重複の解消は「キャンセル（理由: 重複登録）」で行う（削除ではない）。ここは見つけるだけ。

// まだ発送していない（重複を数える）出荷の状態
const PRE_SHIP = ["draft", "requested"];
const idOf = (x) => (x && (x._id ?? x.id)) || "";

/**
 * 同じ案件に、まだ発送していない出荷（下書き・依頼済）が2件以上あるものを返す。
 * @param {object[]} shipments  出荷（_id か id・caseId・status・soNumber）
 * @param {Map<string,string>|Object<string,string>} caseShipmentIdMap  案件ID → cases.shipmentId（残す候補）
 * @returns {{caseId:string, shipments:object[], keepId:string|null}[]}
 *   shipments は出荷番号の昇順。keepId は cases.shipmentId がこの組に入っているときだけ（無ければ人が選ぶ）
 */
export function findDuplicateDrafts(shipments, caseShipmentIdMap) {
  const lookup = (cid) => caseShipmentIdMap instanceof Map ? caseShipmentIdMap.get(cid) : (caseShipmentIdMap || {})[cid];
  const byCase = new Map();
  for (const s of shipments || []) {
    if (!s || !s.caseId || !PRE_SHIP.includes(s.status)) continue;
    if (!byCase.has(s.caseId)) byCase.set(s.caseId, []);
    byCase.get(s.caseId).push(s);
  }
  const out = [];
  for (const [caseId, arr] of byCase) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => String(a.soNumber || "").localeCompare(String(b.soNumber || "")));
    const want = lookup(caseId);
    const keepId = want && arr.some((s) => idOf(s) === want) ? want : null;
    out.push({ caseId, shipments: arr, keepId });
  }
  return out.sort((a, b) => String(a.caseId).localeCompare(String(b.caseId)));
}

/**
 * 下書きの明細が、保管場所ごとの在庫で足りるかの目安（引き落としはしない）。
 * @param {object[]} items      出荷の明細（sku・qty・nonStock）
 * @param {object[]} products   商品（id・name/shortName・stockByLocation）
 * @param {object[]} locations  保管場所（_id か id・name・active）。active:false は除く
 * @returns {{text:string, rows:{locationId:string, name:string, ok:boolean, parts:{sku:string, name:string, have:number, need:number}[]}[]}}
 *   text 例: 「在庫: 滋賀 3/2台 ✓・東京 0/2台」（品物が2種類以上なら「滋賀 BT 3/2台、USB 1/1台 ✓」）。対象が無ければ text は ""。
 */
export function stockAdvice(items, products, locations) {
  const plist = products || [];
  // 在庫を動かす明細だけ（supply.js の stockItems と同じ: 品物ではない明細と商品マスタに無い品番は除く）
  const need = new Map();
  for (const it of items || []) {
    if (!it || it.nonStock || !plist.some((p) => p.id === it.sku)) continue;
    need.set(it.sku, (need.get(it.sku) || 0) + (Number(it.qty) || 0));
  }
  const locs = (locations || []).filter((l) => l && l.active !== false);
  if (!need.size || !locs.length) return { text: "", rows: [] };
  const multi = need.size > 1;
  const rows = locs.map((l) => {
    const lid = idOf(l);
    const parts = [...need].map(([sku, q]) => {
      const p = plist.find((x) => x.id === sku) || {};
      return { sku, name: p.shortName || p.name || sku, have: Number((p.stockByLocation || {})[lid]) || 0, need: q };
    });
    return { locationId: lid, name: l.name || "", ok: parts.every((x) => x.have >= x.need), parts };
  });
  const text = "在庫: " + rows.map((r) =>
    `${r.name} ${r.parts.map((x) => `${multi ? x.name + " " : ""}${x.have}/${x.need}台`).join("、")}${r.ok ? " ✓" : ""}`,
  ).join("・");
  return { text, rows };
}
