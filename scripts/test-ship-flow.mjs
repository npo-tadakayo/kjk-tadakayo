// 出荷の二段階化（ship-flow.js）のテスト。node scripts/test-ship-flow.mjs
import assert from "node:assert/strict";
import {
  SHIP_STATUSES, SHIP_STATUS_LABEL, SHIP_STATUS_BADGE, NOTIFY_STATUSES,
  shipStatusOf, usesWarehouse, stockDeducted, isLocked, canDelete, canCancel,
  nextStatus, notifyOnTransition, deductsOnTransition, shipNotifyShown, primaryAction, shipActions,
  qtyDelta, needsResendPrompt, shipStepsDone, todoCounts, paymentsOf, netPaidOf, CANCEL_BLOCKED_BY_PAYMENT,
  notifyInFlight, NOTIFY_IN_FLIGHT_MSG, LP_PICKUP_NOTICE, lpPickupNotice,
  MAILED_PENDING_LABEL, mailedPendingOf, mailedPendingNotes,
} from "../admin/js/ship-flow.js";

let n = 0;
const t = (fn) => { fn(); n++; };

// ===== 表示名・バッジ =====
t(() => {
  for (const st of SHIP_STATUSES) {
    assert.ok(SHIP_STATUS_LABEL[st], `表示名が無い: ${st}`);
    assert.ok(SHIP_STATUS_BADGE[st], `バッジが無い: ${st}`);
  }
  assert.equal(SHIP_STATUS_LABEL.requested, "依頼済");
  assert.equal(shipStatusOf({}), "shipped");          // 未設定は古い発送済
  assert.equal(shipStatusOf(null), "shipped");
  assert.equal(shipStatusOf({ status: "requested" }), "requested");
});

// ===== stockDeducted: 6状態 × fulfillment(direct / warehouse / 未設定) の18通り =====
const deductedExpect = { draft: false, requested: false, shipped: true, invoiced: true, paid: true, canceled: false };
for (const st of SHIP_STATUSES) {
  for (const f of ["direct", "warehouse", undefined]) {
    t(() => {
      const s = { status: st, ...(f ? { fulfillment: f } : {}) };
      const want = f === "direct" ? false : deductedExpect[st];
      assert.equal(stockDeducted(s), want, `stockDeducted(${st}, ${f ?? "未設定"})`);
      // 発送元の欄・バッジは状態に関係なく fulfillment だけで決まる
      assert.equal(usesWarehouse(s), f !== "direct", `usesWarehouse(${st}, ${f ?? "未設定"})`);
    });
  }
}
t(() => {
  // 状態が未設定（古いデータ）は発送済扱い＝在庫を引いてある
  assert.equal(stockDeducted({}), true);
  assert.equal(stockDeducted({ fulfillment: "direct" }), false);
});

// ===== 既存バグ1・2の再発防止: 下書き・依頼済は削除・数量修正で在庫を動かさない =====
t(() => {
  // 下書きを削除しても在庫は戻さない（Web申込の下書きは fulfillment 無し＝以前は戻していた）
  assert.equal(stockDeducted({ status: "draft" }), false);
  // 下書き・依頼済の数量を直しても差分は空
  assert.deepEqual(qtyDelta({ status: "draft" }, { a: 3 }, { a: 5 }), {});
  assert.deepEqual(qtyDelta({ status: "requested" }, { a: 3 }, { a: 1 }), {});
  // 直送は発送済でも動かさない
  assert.deepEqual(qtyDelta({ status: "shipped", fulfillment: "direct" }, { a: 3 }, { a: 5 }), {});
});

// ===== qtyDelta: 在庫を引いてある出荷だけ差分を返す =====
t(() => {
  assert.deepEqual(qtyDelta({ status: "shipped" }, { a: 3 }, { a: 5 }), { a: 2 });
  assert.deepEqual(qtyDelta({ status: "invoiced" }, { a: 3, b: 1 }, { a: 1 }), { a: -2, b: -1 });
  assert.deepEqual(qtyDelta({ status: "shipped" }, {}, { c: 4 }), { c: 4 });
  assert.deepEqual(qtyDelta({ status: "shipped" }, { a: 2 }, { a: 2 }), {}); // 変わらない品番は入れない
  assert.deepEqual(qtyDelta({ status: "paid" }, null, undefined), {});
});

// ===== isLocked / canDelete / canCancel =====
t(() => {
  const lockedExpect = { draft: false, requested: false, shipped: false, invoiced: true, paid: true, canceled: true };
  const delExpect = { draft: true, requested: false, shipped: false, invoiced: false, paid: false, canceled: false };
  const cancelExpect = { draft: true, requested: true, shipped: true, invoiced: true, paid: false, canceled: false };
  for (const st of SHIP_STATUSES) {
    assert.equal(isLocked({ status: st }), lockedExpect[st], `isLocked(${st})`);
    assert.equal(canDelete({ status: st }), delExpect[st], `canDelete(${st})`);
    assert.equal(canCancel({ status: st }), cancelExpect[st], `canCancel(${st})`);
  }
  assert.equal(canDelete({}), false);   // 未設定＝発送済は削除不可
  assert.equal(canCancel({}), true);
  assert.equal(canDelete(null), false);
  assert.equal(canCancel(null), false);
});

// ===== nextStatus: 許可・不許可 =====
t(() => {
  // 許可
  assert.equal(nextStatus("draft", "request"), "requested");
  assert.equal(nextStatus("requested", "markShipped"), "shipped");
  assert.equal(nextStatus("draft", "recordShipped"), "shipped");
  assert.equal(nextStatus("requested", "revertToDraft"), "draft");
  assert.equal(nextStatus("shipped", "invoice"), "invoiced");
  assert.equal(nextStatus("invoiced", "pay"), "paid");
  for (const st of ["draft", "requested", "shipped", "invoiced"]) assert.equal(nextStatus(st, "cancel"), "canceled");
  assert.equal(nextStatus(undefined, "invoice"), "invoiced"); // 未設定＝発送済
  // 不許可（既存バグ3: 発送済を2回押しても2回目は通らない）
  assert.equal(nextStatus("shipped", "markShipped"), null);
  assert.equal(nextStatus("draft", "markShipped"), null);     // 依頼を経ずに「発送済にする」はできない（記録のみは別の操作）
  assert.equal(nextStatus("requested", "request"), null);     // 二重の依頼
  assert.equal(nextStatus("requested", "recordShipped"), null);
  assert.equal(nextStatus("shipped", "revertToDraft"), null);
  assert.equal(nextStatus("draft", "revertToDraft"), null);
  assert.equal(nextStatus("paid", "cancel"), null);
  assert.equal(nextStatus("canceled", "cancel"), null);
  assert.equal(nextStatus("canceled", "request"), null);
  assert.equal(nextStatus("draft", "invoice"), null);
  assert.equal(nextStatus("requested", "invoice"), null);
  assert.equal(nextStatus("draft", "でたらめ"), null);
});

// ===== notifyOnTransition: 投稿するのは依頼だけ =====
t(() => {
  assert.equal(notifyOnTransition("request"), true);
  for (const a of ["markShipped", "recordShipped", "revertToDraft", "cancel", "invoice", "pay"]) {
    assert.equal(notifyOnTransition(a), false, a);
  }
  assert.equal(deductsOnTransition({}, "markShipped"), true);
  assert.equal(deductsOnTransition({ fulfillment: "direct" }, "markShipped"), false);
  assert.equal(deductsOnTransition({}, "recordShipped"), true);
  assert.equal(deductsOnTransition({}, "request"), false);       // 依頼の時点では引かない
  assert.equal(deductsOnTransition({}, "revertToDraft"), false);
});

// ===== NOTIFY_STATUSES は functions/index.js と同じ値 =====
t(() => {
  assert.deepEqual(NOTIFY_STATUSES, ["requested", "shipped", "invoiced", "paid"]);
});

// ===== primaryAction =====
t(() => {
  assert.equal(primaryAction({ status: "draft" }).key, "request");
  assert.equal(primaryAction({ status: "draft" }).label, "出荷を依頼する");
  assert.equal(primaryAction({ status: "requested" }).key, "markShipped");
  assert.equal(primaryAction({ status: "requested" }).label, "発送済にする");
  assert.equal(primaryAction({ status: "shipped" }).key, "invoice");
  assert.equal(primaryAction({}).key, "invoice");
  assert.equal(primaryAction({ status: "invoiced" }).key, "pay");
  assert.equal(primaryAction({ status: "paid" }).key, "receipt");
  assert.equal(primaryAction({ status: "paid", receiptIssuedAt: "2026-10-21" }), null);
  assert.equal(primaryAction({ status: "canceled" }), null);
  assert.equal(primaryAction(null), null);
});

// ===== shipActions =====
t(() => {
  const draft = shipActions({ status: "draft" });
  assert.ok(draft.includes("request") && draft.includes("recordShipped") && draft.includes("delete") && draft.includes("cancel"));
  assert.ok(!draft.includes("markShipped") && !draft.includes("resendNotice") && !draft.includes("revertToDraft"));

  // requested: revertToDraft と resendNotice があり、delete が無い
  const req = shipActions({ status: "requested" });
  assert.ok(req.includes("revertToDraft"));
  assert.ok(req.includes("resendNotice"));
  assert.ok(!req.includes("delete"));
  assert.ok(req.includes("markShipped") && req.includes("cancel") && req.includes("edit"));
  assert.ok(!req.includes("request") && !req.includes("recordShipped"));
  assert.equal(req.filter((a) => a === "resendNotice").length, 1); // 二重に入らない

  const shipped = shipActions({ status: "shipped", dueRule: "net14" });
  assert.ok(shipped.includes("invoice") && shipped.includes("resendNotice") && shipped.includes("cancel"));
  assert.ok(!shipped.includes("delete") && !shipped.includes("markShipped"));
  // 古い発送済（出荷指示の仕組みの前）には再送を出さない
  assert.ok(!shipActions({ status: "shipped" }).includes("resendNotice"));

  const paid = shipActions({ status: "paid" });
  assert.ok(!paid.includes("cancel") && !paid.includes("delete"));
  assert.deepEqual(shipActions({ status: "canceled" }), []);
  assert.deepEqual(shipActions(null), []);
});

// ===== shipNotifyShown =====
t(() => {
  assert.equal(shipNotifyShown({ status: "draft" }), false);
  assert.equal(shipNotifyShown({ status: "requested" }), true);
  assert.equal(shipNotifyShown({ status: "shipped" }), false);              // 古い発送済
  assert.equal(shipNotifyShown({ status: "shipped", dueRule: "net14" }), true);
  assert.equal(shipNotifyShown({ status: "invoiced", shipNotifiedAt: 1 }), true);
  assert.equal(shipNotifyShown({ status: "paid", shipNotifyStatus: "skipped" }), true);
  assert.equal(shipNotifyShown({ status: "canceled", shipNotifiedAt: 1 }), false);
  assert.equal(shipNotifyShown(null), false);
});

// ===== needsResendPrompt =====
t(() => {
  const base = { status: "requested", address: "大阪府豊中市1-1", officeName: "A事業所", phone: "06",
    items: [{ sku: "cir415a-01", qty: 2 }, { sku: "support-fee", qty: 1, nonStock: true }] };
  assert.equal(needsResendPrompt(base, { ...base }), false);                                  // 何も変えていない
  assert.equal(needsResendPrompt(base, { ...base, address: "大阪府豊中市2-2" }), true);        // 送付先
  assert.equal(needsResendPrompt(base, { ...base, contactName: "田中" }), true);
  assert.equal(needsResendPrompt(base, { ...base, items: [{ sku: "cir415a-01", qty: 3 }] }), true); // 数量
  assert.equal(needsResendPrompt(base, { ...base, items: [{ sku: "cir415a-01", qty: 2 }] }), false); // 品物ではない明細だけの違い
  assert.equal(needsResendPrompt(base, { ...base, email: "x@example.jp" }), false);           // メールは指示に載らない
  assert.equal(needsResendPrompt(base, { ...base, address: " 大阪府豊中市1-1 " }), false);   // 前後の空白だけ
  // 依頼済以外は聞かない
  assert.equal(needsResendPrompt({ ...base, status: "draft" }, { ...base, address: "x" }), false);
  assert.equal(needsResendPrompt({ ...base, status: "shipped" }, { ...base, address: "x" }), false);
  assert.equal(needsResendPrompt(null, base), false);
});

// ===== shipStepsDone（5段・canceled・領収証の有無） =====
t(() => {
  const F = { requested: false, shipped: false, invoiced: false, paid: false, receipt: false };
  assert.deepEqual(shipStepsDone({ status: "draft" }), F);
  assert.deepEqual(shipStepsDone({ status: "requested" }), { ...F, requested: true });
  assert.deepEqual(shipStepsDone({ status: "shipped" }), { ...F, requested: true, shipped: true });
  assert.deepEqual(shipStepsDone({}), { ...F, requested: true, shipped: true });    // 古い発送済も依頼の段は済み
  assert.deepEqual(shipStepsDone({ status: "invoiced" }), { ...F, requested: true, shipped: true, invoiced: true });
  assert.deepEqual(shipStepsDone({ status: "paid" }), { requested: true, shipped: true, invoiced: true, paid: true, receipt: false });
  assert.deepEqual(shipStepsDone({ status: "paid", receiptIssuedAt: "2026-10-21" }),
    { requested: true, shipped: true, invoiced: true, paid: true, receipt: true });
  // 領収証の印だけあっても入金済でなければ済にしない
  assert.equal(shipStepsDone({ status: "invoiced", receiptIssuedAt: "2026-10-21" }).receipt, false);
  assert.deepEqual(shipStepsDone({ status: "canceled", receiptIssuedAt: "x" }), F);
  assert.equal(Object.keys(shipStepsDone({ status: "draft" })).length, 5);
});

// ===== todoCounts =====
t(() => {
  const ships = [
    { status: "draft" }, { status: "draft" },
    { status: "requested" },
    { status: "shipped" }, {},                       // 未設定は発送済
    { status: "invoiced" },
    { status: "paid" }, { status: "paid", receiptIssuedAt: "2026-10-01" },
    { status: "canceled" },
  ];
  assert.deepEqual(todoCounts(ships), { draft: 2, requested: 1, unbilled: 2, unpaid: 1, noReceipt: 1 });
  assert.deepEqual(todoCounts([]), { draft: 0, requested: 0, unbilled: 0, unpaid: 0, noReceipt: 0 });
  assert.deepEqual(todoCounts(null), { draft: 0, requested: 0, unbilled: 0, unpaid: 0, noReceipt: 0 });
});

// ===== 入金が残っている出荷はキャンセルできない（Codex 指摘2）・発送済でも入金の履歴を出す（指摘1）=====
t(() => {
  const pay = [{ amount: 5000, date: "2026-10-20", bankTxnId: "h1" }];
  assert.equal(netPaidOf({ payments: pay }), 5000);
  assert.equal(netPaidOf({ payments: pay, refunds: [{ amount: 5000 }] }), 0);
  assert.equal(netPaidOf({ paymentAmount: 3000 }), 3000);            // 旧形式
  assert.equal(netPaidOf(null), 0);
  assert.equal(paymentsOf({ paymentAmount: 3000 }).length, 1);
  for (const st of ["draft", "requested", "shipped", "invoiced"]) {
    assert.equal(canCancel({ status: st, payments: pay }), false, `入金ありの ${st} はキャンセル不可`);
    assert.equal(canCancel({ status: st, payments: pay, refunds: [{ amount: 5000 }] }), true, `全額返金済の ${st} はキャンセル可`);
    assert.equal(canCancel({ status: st, payments: [] }), true);
  }
  assert.ok(!shipActions({ status: "invoiced", payments: pay }).includes("cancel"));
  assert.match(CANCEL_BLOCKED_BY_PAYMENT, /先に入金を取り消すか返金を記録/);
  // 発送済（未請求）: 入金があれば payHistory を出す・無ければ出さない。主ボタン（請求済にする）は変わらない
  assert.ok(shipActions({ status: "shipped", payments: pay }).includes("payHistory"));
  assert.ok(!shipActions({ status: "shipped" }).includes("payHistory"));
  assert.ok(!shipActions({ status: "invoiced", payments: pay }).includes("payHistory")); // 請求済は既存の「入金を記録する」
  assert.equal(primaryAction({ status: "shipped", payments: pay }).key, "invoice");
});

// ===== 送信中の「依頼を取り消す」を止める（Codex 指摘4）=====
t(() => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const lock = (sec) => ({ toMillis: () => now - sec * 1000 });
  assert.equal(notifyInFlight({ status: "requested", shipNotifyLockAt: lock(5) }, now), true);
  assert.equal(notifyInFlight({ status: "requested", shipNotifyLockAt: lock(61) }, now), false);   // 60秒を過ぎたロックは無視
  assert.equal(notifyInFlight({ status: "requested", shipNotifyLockAt: lock(5), shipNotifiedAt: "x" }, now), false); // 投稿済み
  assert.equal(notifyInFlight({ status: "requested", shipNotifyLockAt: null }, now), false);
  assert.equal(notifyInFlight({ status: "requested" }, now), false);
  assert.equal(notifyInFlight(null, now), false);
  assert.match(NOTIFY_IN_FLIGHT_MSG, /送信中/);
});

console.log(`OK test-ship-flow: ${n}件 全件合格`);

// ===== 2026-10-21 Codex 指摘: 希望出荷日だけ変えても再送を確認する =====
{
  const before = { status: "requested", address: "架空市1-1", shipDate: "2026-10-22", items: [{ sku: "bt", qty: 1 }] };
  assert.equal(needsResendPrompt(before, { ...before, shipDate: "2026-10-25" }), true);
  assert.equal(needsResendPrompt(before, { ...before }), false);
  assert.equal(needsResendPrompt({ ...before, status: "draft" }, { ...before, status: "draft", shipDate: "2026-10-25" }), false);
  console.log("OK test-ship-flow 追加: 希望出荷日の変更で再送を確認");
}

// ===== 2026-10-21 レターパックの初期値はプラス（赤）=====
{
  const { letterPackOrDefault, DEFAULT_LETTERPACK } = await import("../admin/js/ship-flow.js");
  const { readFileSync } = await import("node:fs");
  assert.equal(DEFAULT_LETTERPACK, "plus");
  assert.equal(letterPackOrDefault(undefined), "plus");
  assert.equal(letterPackOrDefault(""), "plus");
  assert.equal(letterPackOrDefault("light"), "light");   // ライトを選んで保存したものはそのまま
  assert.equal(letterPackOrDefault("plus"), "plus");
  const html = readFileSync(new URL("../admin/supply.html", import.meta.url), "utf8");
  assert.equal((html.match(/<option value="plus" selected>/g) || []).length, 2); // 新規登録・発送の確認の2か所
  const sup = readFileSync(new URL("../admin/js/supply.js", import.meta.url), "utf8");
  assert.match(sup, /shipDoneLp"\)\.value = letterPackOrDefault\(letterPackType\)/);
  assert.match(sup, /lpSel\.value=DEFAULT_LETTERPACK/);
  const lp = readFileSync(new URL("../admin/js/letterpack-print.js", import.meta.url), "utf8");
  assert.match(lp, /let type = letterPackOrDefault\(s\.letterPackType\)/);
  // ===== レターパックの注意（滋賀以外の保管場所） =====
t(() => {
  const base = { defaultLocationId: "shiga", letterPack: true };
  assert.equal(lpPickupNotice({ ...base, originLocationId: "okinawa" }), LP_PICKUP_NOTICE);   // 滋賀以外 × レターパック → 注意
  assert.equal(lpPickupNotice({ ...base, originLocationId: "shiga" }), "");                    // 滋賀 → 出さない
  assert.equal(lpPickupNotice({ ...base, originLocationId: "okinawa", letterPack: false }), ""); // レターパックでなければ出さない
  assert.equal(lpPickupNotice({ ...base, originLocationId: "" }), "");                         // 出荷元が未選択なら出さない
  assert.equal(lpPickupNotice({ originLocationId: "okinawa", defaultLocationId: "", letterPack: true }), ""); // 既定が無ければ判定しない
  assert.match(LP_PICKUP_NOTICE, /持ち出し/);
});

console.log("OK test-ship-flow 追加: レターパックの初期値はプラス");
}

// ===== 2026-10-30 台数を目立たせる改修（出荷指示・宛名印刷）=====
{
  const { shipQtySummary } = await import("../admin/js/ship-flow.js");
  const { readFileSync } = await import("node:fs");
  const R = (sku, name, qty, extra = {}) => ({ sku, name, qty, ...extra });
  // 1品番・1台
  let q = shipQtySummary([R("cir415a-01", "介護情報基盤 汎用カードリーダ CIR415A", 1)]);
  assert.equal(q.total, 1);
  assert.equal(q.detail, "CIR415A × 1");
  // 伴走支援費・金額調整・在庫を使わない行・0台は数えない
  q = shipQtySummary([
    R("cir415a-01", "介護情報基盤 汎用カードリーダ CIR415A", 3),
    R("support-fee", "伴走支援費", 1), R("discount", "金額調整", 1),
    R("x-1", "サービス", 2, { nonStock: true }), R("cir315a-02", "介護情報基盤 汎用カードリーダ CIR315A（Type-A）", 0),
  ]);
  assert.equal(q.total, 3);
  assert.equal(q.lines.length, 1);
  // 2品番は品番ごとと合計
  q = shipQtySummary([R("cir415a-01", "介護情報基盤 汎用カードリーダ CIR415A", 2), R("cir315a-02", "介護情報基盤 汎用カードリーダ CIR315A（Type-A）", 1)]);
  assert.equal(q.total, 3);
  assert.equal(q.detail, "CIR415A × 2・CIR315A（Type-A） × 1");
  // 品名が無ければ品番
  assert.equal(shipQtySummary([R("abc", "", 2)]).detail, "abc × 2");
  assert.deepEqual(shipQtySummary(undefined), { lines: [], total: 0, detail: "" });
  // Functions の複製が admin と同じ中身（BEGIN〜END）
  const pick = (src) => src.split("// BEGIN shipQtySummary\n")[1].split("// END shipQtySummary")[0].replace("export function", "function");
  const fl = readFileSync(new URL("../admin/js/ship-flow.js", import.meta.url), "utf8");
  const fn = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
  assert.equal(pick(fn), pick(fl));
  // 出荷の依頼の知らせ（2026-11-12 から短い文面・送6）: 見出しの行に台数を出す（ship-steps-rules の shipStepChatText）
  const SS = await import("../admin/js/ship-steps-rules.js");
  const head = SS.shipStepChatText("request", { soNumber: "SH-1", region: "【大阪府 豊中市】", qty: 3, desiredDeliveryDate: "2026-11-20", requester: "<users/1>" }).split("\n")[0];
  assert.match(head, /SH-1 【大阪府 豊中市】 3台$/);
  // 宛名印刷: 宛名枠の台数と梱包の確認（チェック4つ）
  // 宛名ラベルの部品は letterpack-label.js（2026-11-01 倉庫の宛名印刷と共通化）。印刷ページ側は lpPage
  const lp = readFileSync(new URL("../admin/js/letterpack-label.js", import.meta.url), "utf8");
  const lpPage = readFileSync(new URL("../admin/js/letterpack-print.js", import.meta.url), "utf8");
  assert.match(lp, /import \{ shipQtySummary \} from "\/js\/ship-flow\.js"/);
  assert.match(lpPage, /import \{ renderLabel, fitLabel as fitLabelEl \} from "\/js\/letterpack-label\.js"/);
  // 宛名枠は郵便局の依頼で 上から お届け先 → ご依頼主 → 品名（台数）の順（2026-10-30）
  assert.match(lp, /class="item-qty"/);
  const iTo = lp.indexOf('<div class="to">'), iFrom = lp.indexOf('<div class="from">'), iItem = lp.indexOf('<div class="item">');
  assert.ok(iTo > 0 && iTo < iFrom && iFrom < iItem, "宛名枠の並びは お届け先 → ご依頼主 → 品名");
  assert.match(lp, /data-qty-total>\$\{q\.total\}<small>台<\/small>/);
  assert.equal((lp.match(/<li><span class="box"/g) || []).length, 4);
  assert.match(lp, /確認した人：/);
  const lph = readFileSync(new URL("../admin/css/letterpack-label.css", import.meta.url), "utf8");
  for (const page of ["letterpack-print.html", "warehouse-print.html"]) {
    assert.match(readFileSync(new URL(`../admin/${page}`, import.meta.url), "utf8"), /<link rel="stylesheet" href="\/css\/letterpack-label\.css">/, page);
  }
  assert.match(lph, /\.label\{width:125mm;height:145mm;/); // レターパックの宛名面の枠（縦14.5cm×横12.5cm）
  // A4 の幅（約794px）は max-width:820px にも当たるため、印刷用に寸法を固定し直していること（Codex 指摘 #33）
  assert.match(lph.slice(lph.indexOf('@media print')), /\.label\{width:125mm;height:145mm;min-height:0;\}/);
  assert.match(lph, /\.pack\{/);
  // 長い宛名は お届け先・ご依頼主 を縮めて枠に収め、収まらなければ警告と印刷前の確認（Codex 指摘 #33）
  assert.match(lp, /export function fitLabel\(el\)/);
  assert.match(lpPage, /labelFits = fitLabel\(\);/);
  assert.match(lpPage, /if \(!labelFits && !confirm\(/);
  // 倉庫の宛名印刷も同じ部品で描き、収まらなければ警告と印刷前の確認（2026-11-01）
  const wp = readFileSync(new URL("../admin/js/warehouse-print.js", import.meta.url), "utf8");
  assert.match(wp, /import \{ renderLabel, fitLabel \} from "\/js\/letterpack-label\.js"/);
  assert.match(wp, /if \(!fitLabel\(el\)\)/);
  assert.match(wp, /if \(overflow\.length && !confirm\(/);
  assert.match(lph, /\.label\.measure\{width:125mm !important;height:145mm !important;/);
  console.log("OK test-ship-flow 追加: 台数を目立たせる（出荷指示・宛名印刷）");
}

// ===== 2026-10-24 送付方法「持ち出し」（倉庫メニュー §9.2）=====
{
  const F = await import("../admin/js/ship-flow.js");
  const pick = { status: "shipped", deliveryMode: "pickup" };
  assert.equal(F.isPickup({ deliveryMode: "pickup" }), true);
  assert.equal(F.isPickup({ deliveryMode: "ship" }), false);
  assert.equal(F.isPickup({}), false);                 // 未設定は発送
  assert.equal(F.isPickup(null), false);
  assert.equal(F.shipStatusLabelOf(pick), "受け渡し済");
  assert.equal(F.shipStatusLabelOf({ status: "shipped" }), "発送済");
  assert.equal(F.shipStatusLabelOf({ status: "invoiced", deliveryMode: "pickup" }), "請求済");
  assert.equal(F.shipStatusLabelOf({ status: "requested", deliveryMode: "pickup" }), "依頼済");
  assert.equal(F.markShippedLabel({ deliveryMode: "pickup" }), "受け渡し済にする");
  assert.equal(F.markShippedLabel({}), "発送済にする");
  assert.equal(F.recordShippedLabel({ deliveryMode: "pickup" }), "すでに受け渡し済（記録のみ）");
  assert.equal(F.recordShippedLabel({}), "すでに発送済（記録のみ）");
  const pa = F.primaryAction({ status: "requested", deliveryMode: "pickup" });
  assert.equal(pa.key, "markShipped");                 // 遷移・在庫は発送済と同じ
  assert.equal(pa.label, "受け渡し済にする");
  assert.equal(F.primaryAction({ status: "requested" }).label, "発送済にする");
  assert.equal(F.nextStatus("requested", "markShipped"), "shipped");
  assert.equal(F.stockDeducted(pick), true);
  console.log("OK test-ship-flow 追加: 持ち出し");
}

// ===== 送付済み・記録待ち（2026-11-10）=====
{
  // 請求書: 送ったが請求済でない
  assert.deepEqual(mailedPendingOf({ status: "shipped", invoiceMailedAt: "2026-11-10" }), { invoice: true, receipt: false });
  assert.deepEqual(mailedPendingOf({ status: "requested", invoiceMailedAt: "2026-11-10" }), { invoice: true, receipt: false });
  // 請求済・入金済になっていれば出さない
  assert.equal(mailedPendingOf({ status: "invoiced", invoiceMailedAt: "2026-11-10" }).invoice, false);
  assert.equal(mailedPendingOf({ status: "paid", invoiceMailedAt: "2026-11-10", receiptIssuedAt: "2026-11-10" }).invoice, false);
  // 領収証: 送ったが発行の記録が無い
  assert.deepEqual(mailedPendingOf({ status: "paid", receiptMailedAt: "2026-11-10" }), { invoice: false, receipt: true });
  assert.equal(mailedPendingOf({ status: "paid", receiptMailedAt: "2026-11-10", receiptIssuedAt: "2026-11-10" }).receipt, false);
  // 送っていなければ出さない・キャンセルは出さない
  assert.deepEqual(mailedPendingOf({ status: "shipped" }), { invoice: false, receipt: false });
  assert.deepEqual(mailedPendingOf({ status: "canceled", invoiceMailedAt: "x", receiptMailedAt: "y" }), { invoice: false, receipt: false });
  // 「発行済み」「請求済」の判定自体は変えていない（送付だけでは丸が埋まらない）
  const s = { status: "paid", receiptMailedAt: "2026-11-10" };
  assert.equal(shipStepsDone(s).receipt, false);
  assert.equal(todoCounts([s]).noReceipt, 1);
  assert.equal(todoCounts([{ status: "shipped", invoiceMailedAt: "2026-11-10" }]).unbilled, 1);
  const notes = mailedPendingNotes({ status: "paid", receiptMailedAt: "2026-11-10" });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].label, `領収証 ${MAILED_PENDING_LABEL}`);
  assert.ok(notes[0].hint.includes("発行を記録"));
  assert.ok(mailedPendingNotes({ status: "shipped", invoiceMailedAt: "2026-11-10" })[0].hint.includes("請求済にする"));
  assert.deepEqual(mailedPendingNotes(null), []);
  // 2026-11-10 レビュー指摘3: 下書き・依頼済は「発送後に」の案内（その状態では「請求済にする」のボタンが出ない）
  for (const st of ["draft", "requested"]) {
    const h = mailedPendingNotes({ status: st, invoiceMailedAt: "2026-11-10" })[0].hint;
    assert.ok(h.includes("発送後に「請求済にする」で記録"), st);
    assert.ok(!h.includes("出荷の画面の「請求済にする」"), st);
  }
  assert.ok(mailedPendingNotes({ status: "shipped", invoiceMailedAt: "2026-11-10" })[0].hint.includes("出荷の画面の「請求済にする」"));
  // 指摘1: 発行日は送付日に合わせる旨
  assert.ok(mailedPendingNotes({ status: "shipped", invoiceMailedAt: "2026-11-10" })[0].hint.includes("発行日は送付日に合わせます"));
  console.log("OK test-ship-flow 追加: 送付済み・記録待ち");
}
