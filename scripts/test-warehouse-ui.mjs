// 倉庫画面（admin/warehouse.html・js/warehouse.js）と練習用代役の静的検査。node scripts/test-warehouse-ui.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const html = readFileSync(root("admin/warehouse.html"), "utf8");
const js = readFileSync(root("admin/js/warehouse.js"), "utf8");
const stubs = readFileSync(root("admin/js/practice-stubs.js"), "utf8");
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// 画面の骨組み
ok(/name="viewport"/.test(html), "viewport が無い");
ok(/\/js\/warehouse\.js" type="module"/.test(html), "warehouse.js を読んでいない");
ok(/sidebar\.js/.test(html) && /mobilenav\.js/.test(html) && /firebase-config\.js/.test(html), "共通スクリプトが足りない");
for (const id of ["gate", "main", "locSelect", "counts", "tab-requested", "tab-done", "tab-canceled", "tab-stock", "tab-sheet", "sheetBadge", "shipModal", "handModal", "rejModal", "fixModal", "accModal", "toast"]) ok(html.includes(`id="${id}"`), `#${id} が無い`);
for (const t of ["出荷の依頼", "完了（発送済・受け渡し済・30日）", "キャンセル（30日）", "在庫", "一覧"]) ok(html.includes(t), `タブ「${t}」が無い`);
ok(/\/js\/tooltip\.js" type="module"/.test(html), "吹き出し（tooltip.js）を読んでいない");
ok(/min-height:44px/.test(html), "タップ領域 44px の指定が無い");
ok(!/overflow-x:\s*scroll/.test(html), "横スクロール指定がある");

// 呼び出しは fn.js 経由のみ・5つの Callable
ok(/from "\/js\/fn\.js"/.test(js), "fn.js から httpsCallable を読んでいない");
ok(!/firebase-functions\.js/.test(js), "Functions を直接 import している");
const called = [...js.matchAll(/httpsCallable\(\s*functions\s*,\s*"([^"]+)"/g)].map((m) => m[1]).sort();
assert.deepEqual(called, ["warehouseAccept", "warehouseConfirm", "warehouseFixTracking", "warehouseHandover", "warehouseList", "warehouseReject", "warehouseSetNote", "warehouseShip"]); n++;
ok(!/getDocs?\(|collection\(|onSnapshot/.test(js), "倉庫の画面が Firestore を直接読んでいる");

// 権限・共有ロジック
ok(/ALLOWED_ROLES = \["warehouse", "admin", "staff"\]/.test(js), "許可ロールが違う");
ok(/showAccessDenied/.test(js), "拒否画面が無い");
ok(!/location\.href\s*=\s*["']\/(?!index)/.test(js), "index 以外へ移している");
ok(/from "\/js\/warehouse-rules\.js"/.test(js), "warehouse-rules を使っていない");

// 画面の挙動
ok(/localStorage/.test(js) && /try \{ return localStorage/.test(js), "保管場所の記憶が try/catch でない");
ok(/function esc\(/.test(js), "esc が無い");
ok(/other/.test(js) && /くわしい内容を書いてください/.test(js), "「その他」の必須チェックが無い");
ok(/発送済にする/.test(js) && /受け渡し済にする/.test(js) && /出荷できない/.test(js) && /追跡番号を直す/.test(js), "ボタンの文言が足りない");
ok(/code === "internal"/.test(js), "internal の言い換えが無い");
// 動的に差し込む文字列はすべて esc を通す（テンプレート内の ${...} のうち生で出してよいものを許可リストで確認）
const rawOk = /\$\{(esc\(|CSS\.escape\(|pend \&\& pend\.state|pend\.msg|p\.msg|unconf\b|vis\.length|confirmCell|shipCell|dateCell|trackCell|noteCell|sameHtml|head\b|opts\b|arrow\(|sortTh\(|sheet\.|cls\b|attrs\b|label\b|n\}|so\b|id\}|pickup \? "受け渡し済"|checked \? |disabled \? |isPickup\(s\) \? esc\(|Number\(|pickup|badge|dest|itemsHtml|meta\.join|issue|actions|infoLine|lines|reasonList|rows|list\.map|data\.|ship\b|pick\b|i === 0|s\.postalCode \?|s\.phone \?|s\.desiredDate \?|s\.warehouseIssue\.note \?|s\.contactName|mode|code|msg|errText|typeof|r && r\.notified|s\.soNumber|k\b|v\b|n\}|id\}|\(|printBtn\b|readyHtml\b|stepBadge\b|desiredHtml\b|reqStep === "confirm"|ACCEPT_DECISIONS\[decision\])/; // 2026-11-12 発送の5段: どれも esc 済みの部品か定数
for (const m of js.matchAll(/\$\{([^}]*)\}/g)) ok(rawOk.test("${" + m[1] + "}"), `エスケープ未確認の差し込み: ${m[0]}`);

// 練習用の代役（5つ・2スペース字下げ・外へ出ない）
for (const nm of ["warehouseList", "warehouseShip", "warehouseHandover", "warehouseReject", "warehouseFixTracking", "warehouseConfirm", "warehouseSetNote"]) {
  ok(new RegExp(`^  async ${nm}\\(`, "m").test(stubs), `代役 ${nm} が無い`);
}
ok(/from "\/js\/warehouse-rules\.js"/.test(stubs), "代役が warehouse-rules を使っていない");
const rej = stubs.slice(stubs.indexOf("async warehouseReject("), stubs.indexOf("async warehouseFixTracking("));
const fixTail = stubs.slice(stubs.indexOf("async warehouseFixTracking("));
ok(/logSent\("warehouseReject"/.test(rej) && /showPracticeNotice/.test(rej) && !/fetch\(/.test(rej), "warehouseReject の代役が Chat を送らない形でない");
const ship = stubs.slice(stubs.indexOf("async function whMarkShipped"), stubs.indexOf("export const PRACTICE_STUBS"));
ok(/stockByLocation\.\$\{locId\}/.test(ship) && /dueRule: "net14"/.test(ship) && /inventoryMovements/.test(ship) && /shippedByEmail/.test(ship) && /runTransaction/.test(ship), "在庫の引き落としが supply.js と同じ形でない");

// 宛名印刷（Firestore を読まない専用ページ・2026-10-24）
const pj = readFileSync(root("admin/js/warehouse-print.js"), "utf8");
const ph = readFileSync(root("admin/warehouse-print.html"), "utf8");
const roleSrc = readFileSync(root("admin/js/role.js"), "utf8");
ok(/data-act="print"/.test(js) && /宛名を印刷/.test(js) && /選んだものをまとめて印刷/.test(js) && /data-sel=/.test(js), "印刷ボタン・まとめて印刷が無い");
ok(/sessionStorage\.setItem\("warehouse\.printJob"/.test(js) && /window\.open\("\/warehouse-print"/.test(js), "印刷ページへ渡していない");
ok(/sessionStorage\.getItem\(JOB_KEY\)/.test(pj) && /warehouse\.printJob/.test(pj), "印刷ページが sessionStorage を読んでいない");
ok(!/getDocs?\(|collection\(|getDoc\(|doc\(/.test(pj), "印刷ページが Firestore を直接読んでいる");
ok(/差出人が設定されていません（管理者に連絡してください）/.test(pj) && /差出人が設定されていません（管理者に連絡してください）/.test(js), "差出人なしの案内が無い");
ok(/window\.print\(\)/.test(pj) && /warehouse-print\.js/.test(ph), "印刷ページの結線が無い");
ok(/ALLOWED_ROLES = \["warehouse", "admin", "staff"\]/.test(pj), "印刷ページの許可ロールが違う");
{
  const m = roleSrc.match(/export function isWarehousePath\(path\)\{ return (\/.+\/)\.test\(/);
  ok(m, "isWarehousePath が見つからない");
  const re = new RegExp(m[1].slice(1, -1));
  for (const y of ["/warehouse", "/warehouse.html", "/warehouse-print", "/warehouse-print.html"]) ok(re.test(y), `${y} が倉庫の画面でない`);
  for (const x of ["/letterpack-print.html", "/warehouse-x", "/supply.html"]) ok(!re.test(x), `${x} が倉庫の画面になっている`);
}
// ===== 一覧タブ（2026-11-04）=====
import * as S from "../admin/js/warehouse-sheet.js";
ok(/data-tab="sheet"/.test(html) && /id="tab-sheet"/.test(html) && /id="sheetBadge"/.test(html), "一覧タブの骨組みが無い");
ok(/class="tab active"[^>]*data-tab="requested"/.test(html) && /class="tab-content active" id="tab-requested"/.test(html), "タブの既定（出荷の依頼）が変わっている");
ok(/min-width:44px; min-height:44px/.test(html) && /\.wh-tick input \{ width:22px; height:22px/.test(html), "チェックボックスの大きさ（22px・押せる範囲44px）が無い");
ok(/\.table-wrap|class="table-wrap"/.test(js) && /class="table-wrap" id="sheetTable"/.test(js), "表が横スクロール枠（table-wrap）に入っていない");
// 列
for (const col of ["依頼日", "依頼者", "台数", "配送先", "出荷番号", "確認済み", "発送済み", "発送日", "追跡番号", "備考"]) ok(js.includes(col), `列「${col}」が無い`);
ok(/data-confirm=/.test(js) && /data-shipchk=/.test(js) && /data-note=/.test(js), "確認済み・発送済み・備考の入力が無い");
// 既定の絞り込みは「未確認」・選択肢は 未確認／未発送／すべて
ok(/filter: "unconfirmed"/.test(js), "絞り込みの既定が「未確認」でない");
assert.deepEqual(S.FILTERS, { unconfirmed: "未確認", unshipped: "未発送", all: "すべて" }); n++;
ok(/未確認 \$\{unconf\}件/.test(js) && /sheetBadge/.test(js), "未確認の件数バッジが無い");
// 既定の並びは依頼日の古い順・見出しで昇降を切り替え
ok(/key: "requestedAt", dir: "asc"/.test(js) && /sheet\.dir === "asc" \? "desc" : "asc"/.test(js), "並べ替えの既定・切り替えが違う");
// 発送済みのチェックは新しい在庫処理を作らず、既存のモーダルを開く。キャンセルしたら戻る
const shipChk = js.slice(js.indexOf("function onSheetShip("), js.indexOf("async function onSheetNote("));
ok(/cb\.checked = false/.test(shipChk) && /isPickup\(s\) \? openHand : openShip/.test(shipChk) && !/shipFn|handoverFn/.test(shipChk), "発送済みのチェックが既存のモーダルにつながっていない");
// 確認済みは失敗したら元に戻す／備考は離れたら保存（change）・保存中・成功・失敗の表示
const cf = js.slice(js.indexOf("async function onSheetConfirm("), js.indexOf("function onSheetShip("));
ok(/cb\.checked = !want/.test(cf) && /confirmFn\(/.test(cf), "確認済みの失敗時に戻していない");
ok(/textarea\[data-note\]/.test(js) && /保存中…/.test(js) && /保存しました/.test(js) && /保存できませんでした/.test(js), "備考の保存表示が足りない");
ok(/host\.addEventListener\("change"/.test(js), "備考を change（入力欄を離れたとき）で保存していない");
ok(/同じ宛先 \$\{n\}件/.test(js), "「同じ宛先 N件」が無い");
ok(/placeholder="出荷番号・事業所名・宛先・依頼者で探す"/.test(js), "検索ボックスが無い");
ok(/sheet\.keep\.clear\(\); load\(true\)/.test(js), "一覧タブを開いたときに最新へ取り直していない");
// 練習用の代役（Chat 等へ出さない・Firestore の練習 DB だけを書く）
const confStub = stubs.slice(stubs.indexOf("async warehouseConfirm("));
ok(/warehouseConfirmedAt: deleteField\(\)/.test(confStub) && /validateWarehouseNote/.test(confStub) && !/fetch\(/.test(confStub), "練習の代役（確認済み・備考）が本物と同じ形でない");
ok(/"warehouseConfirmedAt", "canceledAt"\]\) if \(w\[k\]\)/.test(stubs), "練習の whWire が確認日時を変換していない");

// --- 純粋関数（warehouse-sheet.js）---
const R = (o) => ({ id: "i", mode: "requested", status: "requested", soNumber: "SH-1", items: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }], requestedAt: "2026-11-02T00:00:00.000Z", ...o });
const rows = S.buildRows(
  [R({ id: "r1", soNumber: "SH-1", requestedAt: "2026-11-03T00:00:00.000Z", postalCode: "100-0001", address: "千代田区1-1", officeName: "あ事業所" }),
   R({ id: "r2", soNumber: "SH-2", requestedAt: "2026-11-01T00:00:00.000Z", warehouseConfirmed: true, postalCode: "1000001", address: "千代田区1‐1", officeName: "あ事業所", items: [{ sku: "A", qty: 5 }] }),
   R({ id: "r3", soNumber: "SH-3", requestedAt: "2026-11-02T00:00:00.000Z", postalCode: "200-0002", address: "別の住所", officeName: "い事業所", requestedByName: "山田" }),
   R({ id: "r4", soNumber: "SH-4", deliveryMode: "pickup", pickupByName: "持出太郎", pickupDate: "2026-11-05" })],
  [R({ id: "d1", mode: "x", status: "shipped", soNumber: "SH-9", shipDate: "2026-11-01", trackingNumber: "123", postalCode: "100-0001", address: "千代田区1-1", officeName: "あ事業所" })],
);
ok(rows.length === 5 && rows[4].mode === "done" && rows[0].mode === "requested", "buildRows");
ok(S.qtyOf(rows[0]) === 3 && S.qtyOf(rows[1]) === 5 && S.qtyOf({}) === 0, "qtyOf");
ok(S.filterRows(rows, "unconfirmed", "").map((s) => s.id).join() === "r1,r3,r4", "未確認の絞り込み");
ok(S.filterRows(rows, "unshipped", "").length === 4 && S.filterRows(rows, "all", "").length === 5, "未発送・すべて");
ok(S.filterRows(rows, "all", "山田").map((s) => s.id).join() === "r3" && S.filterRows(rows, "all", "ＳＨ－9").map((s) => s.id).join() === "d1" && S.filterRows(rows, "all", "sh-9").map((s) => s.id).join() === "d1", "検索（部分一致・全角半角・大文字小文字）");
ok(S.filterRows(rows, "all", "持出").map((s) => s.id).join() === "r4" && S.filterRows(rows, "all", "あ事業所").length === 3, "検索（依頼者・持ち出す人・事業所）");
ok(S.sortRows(rows.slice(0, 3), "requestedAt", "asc").map((s) => s.id).join() === "r2,r3,r1", "依頼日の古い順");
ok(S.sortRows(rows.slice(0, 3), "requestedAt", "desc").map((s) => s.id).join() === "r1,r3,r2", "依頼日の新しい順");
ok(S.sortRows(rows.slice(0, 3), "qty", "desc")[0].id === "r2", "台数の多い順");
const cnt = S.sameDestCounts(rows);
ok(S.sameDestOf(rows[0], cnt) === 2 && S.sameDestOf(rows[1], cnt) === 2, "同じ宛先（郵便番号・ハイフンの違いを吸収・発送済は数えない）");
ok(S.sameDestOf(rows[2], cnt) === 0 && S.sameDestOf(rows[3], cnt) === 0 && S.sameDestOf(rows[4], cnt) === 0, "1件だけ・持ち出し・発送済には出さない");
// CSV
ok(S.csvCell('a"b') === '"a""b"' && S.csvCell("x,y") === '"x,y"' && S.csvCell(null) === '""' && S.csvCell(3) === '"3"', "csvCell の引用");
for (const f of ["=1+1", "+81", "-1", "@SUM(A1)", "\t=x", "\r=x", " =1", "\u3000＝1", "  \t@x", "＋81", "－1", "＠SUM"]) ok(S.csvCell(f).startsWith(`"'`), `式インジェクション対策: ${JSON.stringify(f)}`);
ok(S.csvCell("普通=の文字") === '"普通=の文字"', "途中の = は触らない");
const csv = S.buildCsv(rows.slice(0, 1).concat(rows.slice(3, 5)).map((s) => ({ ...s, warehouseNote: s.id === "r1" ? '=HYPERLINK("x")' : "" })));
ok(csv.charCodeAt(0) === 0xFEFF && csv.includes("\r\n") && csv.endsWith("\r\n"), "CSV は BOM 付き・CRLF");
ok(csv.slice(1).split("\r\n")[0] === S.CSV_HEADER.map((h) => `"${h}"`).join(","), "CSV の見出し");
ok(csv.includes(`"'=HYPERLINK(""x"")"`), "備考の先頭の = に ' を付ける");
ok(csv.includes('"2026-11-03 09:00"') && csv.includes('"受け渡し"') && csv.includes('"123"'), "CSV の日時（JST）・受け渡し・追跡番号");
ok(S.csvFileName("滋賀/ロジ センター", "2026-11-04") === "出荷一覧_滋賀_ロジ_センター_20261104.csv" && S.csvFileName("", "2026-11-04") === "出荷一覧_保管場所_20261104.csv", "CSV のファイル名");
ok(/buildCsv\(vis\)/.test(js) && /sheetVisible\(\)/.test(js) && /\\uFEFF/.test(readFileSync(root("admin/js/warehouse-sheet.js"), "utf8")), "CSV は見えている行から作る");

// --- 要修正（独立レビュー）: 確認済みは依頼のし直し・取り消し・宛先／台数の修正で外れる（supply.js を静的に読む）---
const sup = readFileSync(root("admin/js/supply.js"), "utf8");
const clear = /warehouseConfirmedAt: deleteField\(\), warehouseConfirmedBy: deleteField\(\)/;
{
  const reReq = sup.slice(sup.indexOf("...requestedStampPatch(), warehouseIssue: deleteField()"), sup.indexOf("}catch(e){ alert(`出荷の依頼に失敗しました"));
  ok(clear.test(reReq), "依頼（し直し）で確認済みを消していない");
  const revert = sup.slice(sup.indexOf('status:"draft", requestRevertedAt'), sup.indexOf("依頼の取り消しに失敗しました"));
  ok(clear.test(revert), "依頼の取り消しで確認済みを消していない");
  const edit = sup.slice(sup.indexOf("async function saveShipEdit()"), sup.indexOf("// 案件（事業所の申し込み）→ 直接出荷フォームに取り込み"));
  // 2026-11-12: 受付に戻すとき（stepResetNeeded）も確認済みを消す
ok(/tx\.update\(shipRef, needsResendPrompt\(cur, \{ \.\.\.cur, \.\.\.patch \}\) \|\| back\s*\? \{ \.\.\.patch, \.\.\.\(back \? stepResetPatch\(\) : \{\}\), warehouseConfirmedAt: deleteField\(\), warehouseConfirmedBy: deleteField\(\) \} : patch\)/.test(edit), "宛先・台数の修正で確認済みを消していない");
}
// --- 要修正: 備考の入力は描き直し・更新・失敗で消えない ---
{
  const nb = js.slice(js.indexOf("async function onSheetNote("), js.indexOf("function bindSheet()"));
  ok(nb.indexOf("sheet.pending.set(id, p)") > 0 && nb.indexOf("sheet.pending.set(id, p)") < nb.indexOf("await noteFn("), "保存を送る前に未保存の入力を手元へ入れていない");
  ok(/p\.state = "error"/.test(nb) && !/sheet\.pending\.delete\(id\);\s*setSt\(`保存できませんでした/.test(nb), "保存に失敗しても入力を残していない");
  ok(/const pend = sheet\.pending\.get\(s\.id\)/.test(js) && /const noteVal = pend \? pend\.value/.test(js), "sheetRow が未保存の入力を優先していない");
  ok(/await Promise\.allSettled\(\[\.\.\.sheet\.inflight\]\)/.test(js), "更新ボタンが保存の完了を待っていない");
  ok(/beforeunload/.test(js), "未保存の備考があるまま閉じる警告が無い");
}

console.log(`OK test-warehouse-ui: ${n} checks passed`);
