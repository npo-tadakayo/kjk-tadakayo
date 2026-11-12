// 事業所向けの出荷は送料を請求しない（2026-11-12 次田さん決定）のテスト。node scripts/test-ship-fee.mjs
//
// ここで確かめること
//   ① 判定（billsOffice）は請求書の税基準（priceIsTaxIncluded）・一覧のバッジ（billsPartner の逆）と同じ
//   ② 事業所向け: 配送方法を選んでも送料は 0 円・名目に配送方法と「当法人負担」が入る
//   ③ 認定事業者向け: 今までどおり（料金表の税込実費を税抜に直して入れる・名目も従来の文）
//   ④ 持ち出し → 発送: 事業所向けは 0 円のまま／認定事業者向けはレターパックの送料
//   ⑤ 手入力の確認が出る条件（事業所向け × 送料>0 × 金額を保存するとき だけ）
//   ⑥ 0 円の送料は請求書・領収証に行が出ない
//   ⑦ supply.js / supply.html の配線（自動入力・保存前の確認・持ち出し→発送・説明の一言）
//   ⑧ 送料>0 で保存するときの名目（「当法人負担」を外す・レビュー中-2）
//   ⑨ 出荷種別を変えるときの案内（事業所向けへ＝送料あり／認定事業者向けへ＝送料0円・レビュー中-4）
//   ⑩ 請求済にする・請求書を出すときの確認（レビュー中-1）
//   ⑪ 確認の配線を、判定の関数を通して動かして確かめる（レビュー低-1）
//   ⑫ 出荷の修正で台数を変えて送料が 0 円になるときは確かめる（2026-11-13）
//   ⑬ 請求書の印刷: Ctrl+P（⌘P）でも同じ確認・メニューからの印刷向けに画面の注意（2026-11-13）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { billsOffice, taxExclOf, autoShipFee, returnToShipFee, needsOfficeFeeConfirm, OFFICE_FEE_CONFIRM,
  feeLabelForSave, shipTypeChangeFeeNote, invoiceFeeConfirmText, qtyChangeFeeConfirmText, invoiceFeeNoticeText } from "../admin/js/ship-fee-rules.js";
import { priceIsTaxIncluded, invoiceTotals, renderInvoiceHtml } from "../admin/js/invoice-doc.js";
import { receiptRowsFromShipment } from "../admin/js/subsidy-amounts.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };

const OFFICE = { shipType: "direct", partnerEmail: "" };
const OFFICE_OLD = {};                                               // shipType なし（Web申込の古い出荷など）
const DROP = { shipType: "dropship", partnerEmail: "p@example.jp" };
const STOCK_OLD = { shipType: "stock", partnerEmail: "p@example.jp" }; // 旧 shipType:"stock"（請求先は認定事業者）
const LP = 600, YU = 1100;

t("① 判定は請求書・一覧のバッジと同じ", () => {
  const billsPartner = (s) => s.shipType === "dropship" || !!s.partnerEmail; // supply.js の billsPartner と同じ式
  for (const s of [OFFICE, OFFICE_OLD, DROP, STOCK_OLD, { shipType: "dropship" }, { shipType: "direct", partnerEmail: "x@y" }]) {
    assert.equal(billsOffice(s), priceIsTaxIncluded(s));
    assert.equal(billsOffice(s), !billsPartner(s));
  }
  assert.equal(billsOffice(OFFICE), true);
  assert.equal(billsOffice(OFFICE_OLD), true);
  assert.equal(billsOffice(DROP), false);
  assert.equal(billsOffice(STOCK_OLD), false);
  assert.equal(billsOffice({ shipType: "dropship" }), false); // 直送は partnerEmail が空でも認定事業者向け
});

t("② 事業所向け: レターパック・ゆうパックを選んでも送料は 0 円（名目に配送方法と当法人負担）", () => {
  assert.deepEqual(autoShipFee({ office: true, method: "letterpack", packs: 1, letterpackFee: LP }),
    { fee: 0, label: "レターパック 1通（送料は当法人負担）" });
  assert.deepEqual(autoShipFee({ office: true, method: "letterpack", packs: 3, letterpackFee: LP }),
    { fee: 0, label: "レターパック 3通（送料は当法人負担）" });
  assert.deepEqual(autoShipFee({ office: true, method: "yupack", yupackSize: "80", yupackRegion: "関東", yupackFee: YU }),
    { fee: 0, label: "ゆうパック 80サイズ・関東（送料は当法人負担）" });
  assert.deepEqual(autoShipFee({ office: true, method: "none" }), { fee: 0, label: "郵送なし（手渡し・持参）" });
  assert.equal(autoShipFee({ office: true, method: "" }), null); // 指定しない＝手入力のまま
});

t("③ 認定事業者向け: 今までどおり（料金表の税込を税抜にして入れる）", () => {
  assert.equal(taxExclOf(600), 545);
  assert.equal(taxExclOf(1100), 1000);
  assert.deepEqual(autoShipFee({ office: false, method: "letterpack", packs: 1, letterpackFee: LP }),
    { fee: 545, label: "送料（レターパック 1通）" });
  assert.deepEqual(autoShipFee({ office: false, method: "letterpack", packs: 2, letterpackFee: LP }),
    { fee: taxExclOf(1200), label: "送料（レターパック 2通）" });
  assert.deepEqual(autoShipFee({ office: false, method: "yupack", yupackSize: "60", yupackRegion: "近畿", yupackFee: YU }),
    { fee: 1000, label: "送料（ゆうパック 60サイズ・近畿）" });
  assert.deepEqual(autoShipFee({ office: false, method: "none" }), { fee: 0, label: "郵送なし（手渡し・持参）" });
  assert.equal(autoShipFee({ office: false, method: "" }), null);
});

t("④ 持ち出し → 発送: 事業所向けは 0 円のまま・認定事業者向けはレターパックの送料", () => {
  const o = returnToShipFee({ office: true, packs: 2, letterpackFee: LP });
  assert.deepEqual(o.patch, { shippingMethod: "letterpack", shippingFee: 0, shippingLabel: "レターパック 2通（送料は当法人負担）" });
  assert.match(o.confirmText, /送料は請求しません（0円のまま/);
  assert.match(o.doneText, /送料は当法人負担・0円/);
  const p = returnToShipFee({ office: false, packs: 2, letterpackFee: LP });
  assert.deepEqual(p.patch, { shippingMethod: "letterpack", shippingFee: taxExclOf(1200), shippingLabel: "送料（レターパック 2通）" });
  assert.equal(p.confirmText, null); // 認定事業者向けの確認の文は supply.js の従来の文
  assert.match(p.doneText, /送料を「送料（レターパック 2通）」にしました/);
});

t("⑤ 手入力の確認が出る条件", () => {
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: 545 }), true);
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: "1" }), true);
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: 0 }), false);
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: "" }), false);
  assert.equal(needsOfficeFeeConfirm({ office: false, fee: 545 }), false);         // 認定事業者向けは出さない
  assert.equal(needsOfficeFeeConfirm({ office: true, fee: 545, savesMoney: false }), false); // 請求書の後（金額を保存しない）
  assert.equal(OFFICE_FEE_CONFIRM, "事業所向けの出荷では送料を請求しない決まりです。請求しますか？");
});

t("⑥ 0 円の送料は請求書・領収証に行が出ない（送料>0 のときだけ）", () => {
  const items = [{ sku: "cir415a-01", name: "CIR415A", qty: 1, unitPrice: 14500 }];
  const a = autoShipFee({ office: true, method: "letterpack", packs: 1, letterpackFee: LP });
  const s0 = { soNumber: "SH-2026-0999", ...OFFICE, items, shippingFee: a.fee, shippingLabel: a.label, status: "paid" };
  assert.equal(invoiceTotals(s0).total, 14500);
  const html = renderInvoiceHtml(s0, {});
  assert.ok(!html.includes("当法人負担"), "請求書に 0 円の送料の行が出ている");
  assert.ok(!receiptRowsFromShipment(s0).some(r => r.kind === "X"), "領収証に 0 円の送料の行が出ている");
  // 認定事業者向けは今までどおり行が出る
  const p = autoShipFee({ office: false, method: "letterpack", packs: 1, letterpackFee: LP });
  const s1 = { soNumber: "SH-2026-0998", ...DROP, items, shippingFee: p.fee, shippingLabel: p.label };
  assert.ok(renderInvoiceHtml(s1, {}).includes("送料（レターパック 1通）"));
});

t("⑦ supply.js / supply.html の配線", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  // 自動入力は autoShipFee に任せる（請求先は修正中の出荷 or 画面の出荷種別から）
  const rf = sup.slice(sup.indexOf("function recalcShipFee"), sup.indexOf("function taxInclusiveShipFees"));
  assert.match(rf, /autoShipFee\(\{ office: shipModalBillsOffice\(\), method,/);
  assert.doesNotMatch(rf, /taxExcl\(/); // 料金表の金額を直に入れる箇所が残っていない
  const mb = sup.slice(sup.indexOf("function shipModalBillsOffice"), sup.indexOf("function recalcShipFee"));
  assert.match(mb, /editingShip \|\|/);
  assert.match(mb, /return billsOffice\(basis\);/);
  // 出荷種別を変えたら送料を入れ直す（配送方法を選んでいるときだけ）
  assert.match(sup, /if\(document\.getElementById\("shipMethod"\)\.value\) recalcShipFee\(\);/);
  // 保存前の確認（新規・修正の両方）
  const ns = sup.slice(sup.indexOf("async function saveShip()"), sup.indexOf("async function saveShip()") + 9000);
  assert.match(ns, /needsOfficeFeeConfirm\(\{ office: billsOffice\(\{ shipType, partnerEmail \}\), fee: shippingFee \}\)/);
  assert.match(sup, /needsOfficeFeeConfirm\(\{ office: billsOffice\(s0\), fee: patch\.shippingFee \}\)/);
  // 持ち出し → 発送
  const rq = sup.slice(sup.indexOf("async function requestDraftShipment"), sup.indexOf("// 依頼済(requested) → 発送済"));
  assert.match(rq, /const lpOffice = billsOffice\(s\);/);
  assert.match(rq, /\(feeRestored \? `。\$\{lpBack\.doneText\}` : ""\)/);
  // 認定事業者の受注から作る直送の出荷は今までどおりレターパックの送料
  assert.match(sup, /shipType:"dropship", partnerEmail:o\.partnerEmail\|\|""[\s\S]{0,300}shippingFee:taxExcl\(packs\*letterpackFee\(\)\)/);
  const html = readFileSync(new URL("../admin/supply.html", import.meta.url), "utf8");
  assert.match(html, /<strong>事業所向けの出荷は送料を請求しません<\/strong>（タダカヨの負担）/);
  assert.match(html, /id="shipMethod" data-tip="事業所向けの出荷は送料を請求しません/);
});

t("⑧ 送料>0 のまま保存するときは「当法人負担」を外す・0円のときだけ当法人負担の名目", () => {
  assert.equal(feeLabelForSave({ office: true, fee: 600, label: "レターパック 1通（送料は当法人負担）" }), "送料（レターパック 1通）");
  assert.equal(feeLabelForSave({ office: true, fee: 1000, label: "ゆうパック 80サイズ・関東（送料は当法人負担）" }), "送料（ゆうパック 80サイズ・関東）");
  assert.equal(feeLabelForSave({ office: true, fee: 0, label: "レターパック 1通（送料は当法人負担）" }), "レターパック 1通（送料は当法人負担）");
  assert.equal(feeLabelForSave({ office: true, fee: 600, label: "送料（特急）" }), "送料（特急）");          // 手で書いた名目は触らない
  assert.equal(feeLabelForSave({ office: false, fee: 545, label: "送料（レターパック 1通）" }), "送料（レターパック 1通）");
  // 直したあとの名目で請求書に「当法人負担」が出ない
  const s = { soNumber: "SH-2026-0997", ...OFFICE, items: [{ sku: "x", qty: 1, unitPrice: 1000 }], shippingFee: 600,
    shippingLabel: feeLabelForSave({ office: true, fee: 600, label: "レターパック 1通（送料は当法人負担）" }) };
  const html = renderInvoiceHtml(s, {});
  assert.ok(html.includes("送料（レターパック 1通）") && !html.includes("当法人負担"));
});

t("⑨ 出荷種別を変えるときの案内", () => {
  const off0 = { ...OFFICE, shippingFee: 0, shippingMethod: "letterpack" };
  const off6 = { ...OFFICE, shippingFee: 600, shippingMethod: "letterpack" };
  const drop0 = { ...DROP, shippingFee: 0, shippingMethod: "letterpack" };
  const drop5 = { ...DROP, shippingFee: 545, shippingMethod: "letterpack" };
  assert.match(shipTypeChangeFeeNote({ from: off0, to: DROP }), /^送料が0円です。認定事業者向けは送料を請求する運用です。/);
  assert.equal(shipTypeChangeFeeNote({ from: off6, to: DROP }), "");                     // 送料が入っていれば何も言わない
  assert.equal(shipTypeChangeFeeNote({ from: { ...off0, shippingMethod: "none" }, to: DROP }), ""); // 郵送しない出荷は0円で正しい
  assert.match(shipTypeChangeFeeNote({ from: drop5, to: OFFICE }), /送料 ¥545（税抜）が残っています。事業所向けの出荷では送料を請求しない決まりです/);
  assert.equal(shipTypeChangeFeeNote({ from: drop0, to: OFFICE }), "");
  assert.equal(shipTypeChangeFeeNote({ from: off0, to: OFFICE }), "");                    // 同じ種別のまま
  assert.equal(shipTypeChangeFeeNote({ from: drop5, to: DROP }), "");
});

t("⑩ 請求済にする・請求書を出すときの確認", () => {
  const items = [{ sku: "x", qty: 1, unitPrice: 1000 }];
  const ask = invoiceFeeConfirmText({ ...OFFICE, items, shippingFee: 600, status: "shipped" });
  assert.equal(ask, "事業所向けの出荷では送料を請求しない決まりです。送料 ¥660（税込・税抜 ¥600）を請求しますか？\n（請求しないなら「キャンセル」を押し、出荷を修正して送料を0円にしてください）");
  assert.equal(invoiceFeeConfirmText({ ...OFFICE, items, shippingFee: 0, status: "shipped" }), null);
  assert.equal(invoiceFeeConfirmText({ ...DROP, items, shippingFee: 545, status: "shipped" }), null);
  for (const status of ["invoiced", "paid", "canceled"])                                 // 金額を直せない出荷には出さない
    assert.equal(invoiceFeeConfirmText({ ...OFFICE, items, shippingFee: 600, status }), null);
  assert.equal(invoiceFeeConfirmText(null), null);
});

// ⑪ 画面のコードから確認の部分を取り出し、判定の関数と confirm の代役をつないで動かす
function extract(src, start, end) {
  const i = src.indexOf(start); assert.ok(i >= 0, `見つからない: ${start}`);
  const j = src.indexOf(end, i); assert.ok(j > i, `終わりが見つからない: ${end}`);
  return src.slice(i, j);
}
t("⑪ 確認の配線を判定の関数で動かす（新規・修正・請求時・種別変更）", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  const prt = readFileSync(new URL("../admin/js/supply-print.js", import.meta.url), "utf8");
  const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
  const run = (code, vars, answer) => {
    const asked = [];
    const confirm = (m) => { asked.push(m); return answer; };
    const names = Object.keys(vars);
    const ret = new Function(...names, "confirm", "billsOffice", "needsOfficeFeeConfirm", "feeLabelForSave",
      "invoiceFeeConfirmText", "shipTypeChangeFeeNote", "OFFICE_FEE_CONFIRM", "yen",
      `${code}\n;return "続行";`)(...names.map(k => vars[k]), confirm, billsOffice, needsOfficeFeeConfirm, feeLabelForSave,
      invoiceFeeConfirmText, shipTypeChangeFeeNote, OFFICE_FEE_CONFIRM, yen);
    return { ret, asked };
  };
  // 新規: 名目を直してから確認。確認の文に直したあとの名目が出る。キャンセルで止まる・事業所向け0円と認定事業者向けは聞かない
  const nsLabel = extract(sup, "const shippingLabel=noGoods ?", "const letterPackType=");
  const nsAsk = extract(sup, "  // 事業所向けの出荷に送料を入れて保存するときは確かめる", "  if(!confirm(msg)) return;");
  const fakeDoc = (label) => ({ getElementById: () => ({ value: label }) });
  const newShip = (shipType, partnerEmail, shippingFee, label, answer) => run(
    `${nsLabel.replace(/^const /, "var ")}\n${nsAsk}\nreturn "続行:"+shippingLabel;`,
    { document: fakeDoc(label), noGoods: false, pickup: false, shipType, partnerEmail, shippingFee }, answer);
  let r = newShip("direct", "", 600, "レターパック 1通（送料は当法人負担）", false);
  assert.equal(r.ret, undefined); assert.equal(r.asked.length, 1);
  assert.ok(r.asked[0].startsWith(OFFICE_FEE_CONFIRM) && r.asked[0].includes("「送料（レターパック 1通）」"));
  r = newShip("direct", "", 600, "レターパック 1通（送料は当法人負担）", true);
  assert.equal(r.ret, "続行:送料（レターパック 1通）");
  r = newShip("direct", "", 0, "レターパック 1通（送料は当法人負担）", false);
  assert.equal(r.ret, "続行:レターパック 1通（送料は当法人負担）"); assert.equal(r.asked.length, 0);
  r = newShip("dropship", "p@example.jp", 545, "送料（レターパック 1通）", false);
  assert.equal(r.ret, "続行:送料（レターパック 1通）"); assert.equal(r.asked.length, 0);
  // 修正: 名目を直してから確認
  const ed = extract(sup, "    // 事業所向けで送料>0 のまま保存するときは「当法人負担」の名目を外す", "  const btn=document.getElementById(\"saveShipBtn\")");
  const edCode = ed.trim().replace(/\}\s*$/, "");
  const edit = (s0, fee, label, answer) => { const patch = { shippingFee: fee, shippingLabel: label };
    const out = run(`${edCode}\nreturn "続行:"+patch.shippingLabel;`, { s0, patch }, answer); return out; };
  r = edit(OFFICE, 600, "レターパック 1通（送料は当法人負担）", false);
  assert.equal(r.ret, undefined); assert.ok(r.asked[0].includes("「送料（レターパック 1通）」"));
  r = edit(OFFICE, 600, "レターパック 1通（送料は当法人負担）", true); assert.equal(r.ret, "続行:送料（レターパック 1通）");
  r = edit(DROP, 545, "送料（レターパック 1通）", false); assert.equal(r.asked.length, 0); assert.equal(r.ret, "続行:送料（レターパック 1通）");
  // 請求済にする（supply.js doInvoiceReport）
  const inv = extract(sup, "    const feeAsk = invoiceFeeConfirmText(s);", "  }\n  const btn = document.getElementById(\"doInvReportBtn\")");
  const items = [{ sku: "x", qty: 1, unitPrice: 1000 }];
  r = run(inv, { s: { ...OFFICE, items, shippingFee: 600, status: "shipped" } }, false); assert.equal(r.ret, undefined); assert.equal(r.asked.length, 1);
  r = run(inv, { s: { ...OFFICE, items, shippingFee: 600, status: "shipped" } }, true); assert.equal(r.ret, "続行");
  r = run(inv, { s: { ...DROP, items, shippingFee: 545, status: "shipped" } }, false); assert.equal(r.ret, "続行"); assert.equal(r.asked.length, 0);
  assert.ok(sup.indexOf("const feeAsk = invoiceFeeConfirmText(s);") < sup.indexOf("const r = await markInvoiced(db, s._id"), "確認は請求済にする前");
  // 請求書の印刷・メール（supply-print.js）
  const cf = extract(prt, "function confirmInvoiceShipFee(){", "// 発行するとき、担当営業が空なら知らせる");
  const pr = (ship, answer) => run(`var docInvoiceShip=__s;\n${cf}\nreturn confirmInvoiceShipFee();`, { __s: ship }, answer);
  assert.equal(pr({ ...OFFICE, items, shippingFee: 600, status: "shipped" }, false).ret, false);
  assert.equal(pr({ ...OFFICE, items, shippingFee: 600, status: "shipped" }, true).ret, true);
  assert.equal(pr({ ...OFFICE, items, shippingFee: 600, status: "invoiced" }, false).ret, true);
  assert.equal(pr(null, false).ret, true);
  assert.match(prt, /if\(type==="invoice" && !confirmInvoiceShipFee\(\)\) return;\n    try\{ document\.activeElement/);
  assert.match(prt, /if\(kind==="invoice" && !confirmInvoiceShipFee\(\)\) return;\n    const to = normalizeEmail/);
  assert.match(prt, /docInvoiceShip = type==="invoice" \? d : null;/);
  // 種別変更（doChangeShipType）
  const stc = extract(sup, "  const stcFeeNote = shipTypeChangeFeeNote(", "  if(!confirm(msg)) return;\n  const btn=document.getElementById(\"doStcBtn\")");
  const change = (s, newType, partnerId) => run(`${stc}\nreturn msg;`,
    { s, newType, partnerId, items: s.items || [], before: 0, after: 0, partner: {},
      SHIP_TYPE_LABEL: { direct: "事業所へ", dropship: "認定事業者へ" } }, true).ret;
  assert.match(change({ ...OFFICE, shippingFee: 0, shippingMethod: "letterpack" }, "dropship", "p@example.jp"), /送料が0円です。認定事業者向けは送料を請求する運用です/);
  assert.match(change({ ...DROP, shippingFee: 545, shippingMethod: "letterpack" }, "direct", ""), /事業所向けの出荷では送料を請求しない決まりです/);
  assert.doesNotMatch(change({ ...DROP, shippingFee: 545, shippingMethod: "letterpack" }, "dropship", "p@example.jp"), /送料/);
});

t("⑫ 台数を変えて送料が0円になるときの確認（判定）", () => {
  // 修正中・送料あり・入れ直すと0円 → 聞く
  const a = qtyChangeFeeConfirmText({ editing: true, currentFee: 745, nextFee: 0 });
  assert.ok(a && a.includes("¥745") && a.includes("0 円にしますか"));
  assert.equal(qtyChangeFeeConfirmText({ editing: true, currentFee: "745", nextFee: 0 }) !== null, true); // 入力欄の文字列でも
  // 新規登録・送料0円・入れ直しても送料が残る（認定事業者の通数の増減）→ 聞かない
  assert.equal(qtyChangeFeeConfirmText({ editing: false, currentFee: 745, nextFee: 0 }), null);
  assert.equal(qtyChangeFeeConfirmText({ editing: true, currentFee: 0, nextFee: 0 }), null);
  assert.equal(qtyChangeFeeConfirmText({ editing: true, currentFee: "", nextFee: 0 }), null);
  assert.equal(qtyChangeFeeConfirmText({ editing: true, currentFee: 545, nextFee: 1091 }), null);
});

t("⑫ 台数を変えて送料が0円になるときの確認（supply.js の配線）", () => {
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  // 台数の入力からは fromQty=true で呼ぶ。配送方法などの change は event が渡るので true にならない
  assert.match(sup, /qty-input'\)\.forEach\(i=>i\.addEventListener\('input',\(\)=>recalcShipFee\(true\)\)\)/);
  assert.match(sup, /function recalcShipFee\(fromQty\)\{/);
  assert.match(sup, /if\(fromQty===true\)\{/);
  // 開くたびに答えを消す
  assert.match(sup, /editingShip = existing \|\| null;\n  shipQtyFeeAnswer = null;/);
  // 配線を動かす: 「キャンセル」なら送料・名目はそのまま、2回目は聞かない／「OK」なら0円
  const body = extract(sup, "  if(fromQty===true){", "  feeEl.value=a.fee; labelEl.value=a.label;");
  const sim = (answer, times) => {
    const feeEl = { value: "745" }, labelEl = { value: "送料（レターパック 1通）" };
    const st = { shipQtyFeeAnswer: null };
    let asked = 0;
    const once = new Function("fromQty", "a", "feeEl", "labelEl", "editingShip", "st", "confirm", "qtyChangeFeeConfirmText", "updateShipTotal",
      body.replace(/shipQtyFeeAnswer/g, "st.shipQtyFeeAnswer") + "\n  feeEl.value=a.fee; labelEl.value=a.label; return \"入れ直した\";");
    let ret;
    for (let i = 0; i < times; i++)
      ret = once(true, { fee: 0, label: "レターパック 1通（送料は当法人負担）" }, feeEl, labelEl, { _id: "x" }, st,
        () => { asked++; return answer; }, qtyChangeFeeConfirmText, () => {});
    return { ret, asked, fee: feeEl.value, label: labelEl.value };
  };
  let r = sim(false, 3);
  assert.equal(r.asked, 1); assert.equal(r.fee, "745"); assert.equal(r.label, "送料（レターパック 1通）"); assert.equal(r.ret, undefined);
  r = sim(true, 1);
  assert.equal(r.asked, 1); assert.equal(r.fee, 0); assert.equal(r.ret, "入れ直した");
});

t("⑬ 請求書の印刷: Ctrl+P でも同じ確認・画面の注意", () => {
  const prt = readFileSync(new URL("../admin/js/supply-print.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../admin/supply-print.html", import.meta.url), "utf8");
  const items = [{ sku: "x", qty: 1, unitPrice: 1000 }];
  // 注意の文は確認と同じ条件
  for (const s of [{ ...OFFICE, items, shippingFee: 600, status: "shipped" }, { ...OFFICE, items, shippingFee: 600, status: "invoiced" },
    { ...OFFICE, items, shippingFee: 0, status: "shipped" }, { ...DROP, items, shippingFee: 545, status: "shipped" }, null]) {
    assert.equal(invoiceFeeNoticeText(s) === null, invoiceFeeConfirmText(s) === null);
  }
  const note = invoiceFeeNoticeText({ ...OFFICE, items, shippingFee: 600, status: "shipped" });
  assert.ok(note.includes("¥660") && note.includes("Ctrl+P") && note.includes("メニューから印刷したときは確認が出ません"));
  // Ctrl+P の判定
  const isP = new Function(`${extract(prt, "function isPrintShortcut(e){", "\n}")}\n}\nreturn isPrintShortcut;`)();
  assert.equal(isP({ ctrlKey: true, key: "p" }), true);
  assert.equal(isP({ metaKey: true, key: "P" }), true);
  assert.equal(isP({ ctrlKey: true, shiftKey: true, key: "p" }), false); // Ctrl+Shift+P はブラウザの別機能
  assert.equal(isP({ key: "p" }), false);
  assert.equal(isP({ ctrlKey: true, key: "s" }), false);
  // 配線: ボタンと Ctrl+P は同じ startPrint を通す・ブラウザの印刷は止める
  assert.match(prt, /document\.getElementById\("printBtn"\)\.addEventListener\("click",startPrint\);/);
  assert.match(prt, /if\(!isPrintShortcut\(e\)\) return;\n    e\.preventDefault\(\);\n    if\(document\.getElementById\("body"\)\.style\.display!=="none"\) startPrint\(\);/);
  assert.match(prt, /const feeNoteText = invoiceFeeNoticeText\(docInvoiceShip\);/);
  // 注意は印刷に出ない
  assert.match(html, /<div class="fee-notice" id="feeNotice" role="note"><\/div>/);
  assert.match(html, /@media print\{\.toolbar\{display:none;\}\.fee-notice\{display:none !important;\}/);
});

console.log(`OK: test-ship-fee ${n} 件合格`);
