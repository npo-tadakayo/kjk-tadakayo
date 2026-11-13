// 発送の5段（依頼 → 受付 → 確認 → 発送準備 → 発送完了・2026-11-12）の純粋関数と、画面・代役・Functions の結線の静的検査。
// 対象: admin/js/ship-steps-rules.js（正本）と functions/ship-steps-rules.mjs（同じコピー）、supply.js・warehouse.js・practice-stubs.js・
// functions/ship-steps.js・functions/index.js。Firebase には繋がない。実行: node scripts/test-ship-steps.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const S = await import("../admin/js/ship-steps-rules.js");
const root = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(root(p), "utf8");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

const R = (qty, sku = "cir415a-01") => ({ sku, name: "介護情報基盤 汎用カードリーダ CIR415A", qty });
const req = (o = {}) => ({
  status: "requested", soNumber: "SH-1", officeName: "テスト事業所", postal: "100-0001", address: "東京都千代田区1-1", phone: "03-0000-0000",
  items: [R(2), { sku: "support-fee", name: "伴走支援費", qty: 1, nonStock: true }], originLocationId: "L1",
  desiredDeliveryDate: "2026-11-20", requestedBy: "依頼する人", requestedByEmail: "irai@tadakayo.jp", shipFlow: 2, ...o,
});
// 本番に出す前に依頼した出荷（shipFlow の印なし）
const legacy = (o = {}) => { const s = req(o); delete s.shipFlow; return s; };

t("正本と functions のコピーが同じ", () => {
  assert.equal(read("admin/js/ship-steps-rules.js"), read("functions/ship-steps-rules.mjs"));
  assert.match(read("scripts/check-shared-sync.sh"), /ship-steps-rules\.js functions\/ship-steps-rules\.mjs/);
});

t("段: 状態ごと（既存の出荷は書き換えずに読む）", () => {
  assert.equal(S.stepOf(req({ status: "draft" })), "draft");
  assert.equal(S.stepOf(req()), "accept");                                   // 印のある依頼済で受付前＝受付
  assert.equal(S.stepOf(req({ acceptStatus: "wait" })), "wait");
  assert.equal(S.stepOf(req({ acceptStatus: "ok" })), "confirm");
  assert.equal(S.stepOf(req({ acceptStatus: "ok", finalConfirmedAt: 1 })), "prepare");
  assert.equal(S.stepOf(req({ acceptStatus: "ok", finalConfirmSkipped: true })), "prepare");
  assert.equal(S.stepOf(req({ warehouseIssue: { reason: "shortage" } })), "ng");
  assert.equal(S.stepOf(req({ acceptStatus: "wait", warehouseIssue: { reason: "shortage" } })), "ng"); // 入荷待ちから発送不可
  assert.equal(S.stepOf(req({ deliveryMode: "pickup" })), "prepare");         // 持ち出しは受付・確認を省く
  assert.equal(S.stepOf(req({ fulfillment: "direct" })), "prepare");          // 直送も倉庫を通らない
  assert.equal(S.stepOf(req({ fulfillment: "direct", deliveryMode: "pickup" })), "prepare");
  for (const st of ["shipped", "invoiced", "paid"]) assert.equal(S.stepOf(req({ status: st })), "done");
  assert.equal(S.stepOf({ soNumber: "SH-OLD" }), "done");                     // 状態の無い古い出荷は発送済＝完了
  assert.equal(S.stepOf(req({ status: "canceled" })), "canceled");
  assert.equal(S.stepOf(null), "draft");
});

t("移行: 印（shipFlow）の無い既存の依頼済は発送準備（今までどおり発送できる）・発送不可の印があれば発送不可", () => {
  assert.equal(S.SHIP_FLOW, 2);
  assert.equal(S.isNewFlow(req()), true);
  assert.equal(S.isNewFlow(legacy()), false);
  assert.equal(S.stepOf(legacy()), "prepare");
  assert.equal(S.stepOf({ status: "requested" }), "prepare");                       // 項目が何も無い古い依頼済
  assert.equal(S.stepOf(legacy({ desiredDeliveryDate: "" })), "prepare");
  assert.equal(S.stepOf(legacy({ warehouseConfirmedAt: 1, warehouseConfirmedBy: "倉庫" })), "prepare"); // 倉庫の「確認済み」あり
  assert.equal(S.stepOf(legacy({ labelPrintedAt: 1 })), "prepare");                  // 宛名印刷済み
  assert.equal(S.stepOf(legacy({ warehouseIssue: { reason: "shortage" } })), "ng");  // 既存の「出荷できない」は今までどおり
  assert.equal(S.stepOf(legacy({ shipFlow: 1 })), "prepare");                        // 印の値が違えば古い扱い
  assert.equal(S.canComplete(legacy()), true);
  assert.equal(S.canAccept(legacy()), false);
  assert.equal(S.canFinalConfirm(legacy({ acceptStatus: "ok" })), false);
  // 印があれば受付と最終確認を通らないと発送できない
  assert.equal(S.canComplete(req()), false);
  assert.equal(S.canComplete(req({ acceptStatus: "ok" })), false);
  assert.equal(S.canComplete(req({ acceptStatus: "ok", finalConfirmedAt: 1 })), true);
});

t("「変更する」で直したら受付に戻すか（印のある依頼済で受付が済んだものだけ）", () => {
  const ok = req({ acceptStatus: "ok", finalConfirmedAt: 1 });
  assert.equal(S.stepResetNeeded(ok, { items: [R(3)] }), true);                        // 台数
  assert.equal(S.stepResetNeeded(ok, { items: [R(2), { sku: "support-fee", qty: 2, nonStock: true }] }), false); // 品物の台数は同じ
  assert.equal(S.stepResetNeeded(ok, { items: [R(2, "cir315a-02")] }), true);          // 種類
  assert.equal(S.stepResetNeeded(ok, { address: "東京都千代田区2-2" }), true);          // 届け先
  assert.equal(S.stepResetNeeded(ok, { desiredDeliveryDate: "2026-11-21" }), true);     // 納品希望日
  assert.equal(S.stepResetNeeded(ok, { originLocationId: "L2" }), true);                // 送付元の倉庫
  assert.equal(S.stepResetNeeded(ok, { address: "東京都千代田区1-1", desiredDeliveryDate: "2026-11-20" }), false); // 変わっていない
  assert.equal(S.stepResetNeeded(req({ acceptStatus: "wait" }), { items: [R(5)] }), true);
  assert.equal(S.stepResetNeeded(req(), { items: [R(5)] }), false);                     // まだ受付前（もともと受付）
  assert.equal(S.stepResetNeeded(legacy({ acceptStatus: "ok" }), { items: [R(5)] }), false); // 印の無い既存の出荷は戻さない
  assert.equal(S.stepResetNeeded(req({ status: "shipped", acceptStatus: "ok" }), { items: [R(5)] }), false);
});

t("最終確認の設定（既定＝行う・省くと発送可でそのまま発送準備）", () => {
  assert.equal(S.finalConfirmOn({}), true);
  assert.equal(S.finalConfirmOn(null), true);
  assert.equal(S.finalConfirmOn({ shipFinalConfirm: true }), true);
  assert.equal(S.finalConfirmOn({ shipFinalConfirm: false }), false);
  assert.equal(S.stepOf(req({ acceptStatus: "ok" }), { finalConfirm: false }), "prepare");
  // 省いて受付した出荷は、あとで設定を戻しても確認待ちに戻らない
  const p = S.acceptPatchOf({ decision: "ok", note: "" }, { finalConfirm: false });
  assert.equal(p.finalConfirmSkipped, true);
  assert.equal(S.stepOf(req(p), { finalConfirm: true }), "prepare");
  assert.equal(S.acceptPatchOf({ decision: "ok", note: "" }, { finalConfirm: true }).finalConfirmSkipped, false);
});

t("件数", () => {
  const c = S.stepCounts([req(), req({ acceptStatus: "wait" }), req({ status: "shipped" }), req({ status: "canceled" }), req({ status: "draft" })]);
  assert.deepEqual(c, { draft: 1, accept: 1, wait: 1, ng: 0, confirm: 0, prepare: 0, done: 1, canceled: 1 });
  assert.deepEqual(S.STEP_LISTS, ["accept", "confirm", "wait", "ng", "prepare", "done", "canceled"]);
});

t("依頼の必須項目（担当者名だけ任意）", () => {
  assert.deepEqual(S.requestMissing(req()), []);
  assert.deepEqual(S.requestMissing(req({ contactName: "" })), []); // 担当者名は任意
  assert.deepEqual(S.requestMissing(req({ items: [{ sku: "support-fee", qty: 1, nonStock: true }] })), ["カードリーダーの種類・台数"]);
  assert.deepEqual(S.requestMissing(req({ officeName: "", company: "" })), ["事業所名"]);
  assert.deepEqual(S.requestMissing(req({ officeName: "", company: "法人" })), []);
  assert.deepEqual(S.requestMissing(req({ postal: "", address: " ", phone: "" })), ["郵便番号", "住所", "電話番号"]);
  assert.deepEqual(S.requestMissing(req({ originLocationId: "" })), ["送付元の倉庫"]);
  assert.deepEqual(S.requestMissing(req({ originLocationId: "", fulfillment: "direct" })), []); // 直送は倉庫を通らない
  assert.deepEqual(S.requestMissing(req({ desiredDeliveryDate: "" })), ["納品希望日"]);
  assert.deepEqual(S.requestMissing(req({ desiredDeliveryDate: "2026-02-30" })), ["納品希望日"]);
  assert.deepEqual(S.requestMissing(req({ requestedBy: "", requestedByEmail: "" })), ["依頼者名"]);
  // 持ち出し: 郵便番号・住所・電話は要らない。持ち出す人と持ち出し予定日は要る
  assert.deepEqual(S.requestMissing(req({ deliveryMode: "pickup", postal: "", address: "", phone: "", pickupByEmail: "m@tadakayo.jp" })), []);
  assert.deepEqual(S.requestMissing(req({ deliveryMode: "pickup", desiredDeliveryDate: "", pickupByEmail: "" })), ["持ち出し予定日（納品希望日）", "持ち出す人"]);
  assert.equal(S.requestMissingText(["納品希望日", "電話番号"]), "依頼に必要な項目が足りません: 納品希望日・電話番号");
  assert.equal(S.requestMissingText([]), "");
});

t("受付の入力", () => {
  const RS = { shortage: "a", address: "b", other: "c" };
  assert.equal(S.validateAccept({ decision: "x" }, RS).ok, false);
  assert.equal(S.validateAccept({ decision: "ng" }, RS).ok, false);              // 理由が要る
  assert.equal(S.validateAccept({ decision: "ng", reason: "zzz" }, RS).ok, false);
  assert.equal(S.validateAccept({ decision: "ng", reason: "other", note: " " }, RS).ok, false); // その他はメモ必須
  assert.deepEqual(S.validateAccept({ decision: "ng", reason: "shortage", note: " 入荷未定 " }, RS),
    { ok: true, decision: "ng", reason: "shortage", note: "入荷未定", shipDate: "" });
  assert.equal(S.validateAccept({ decision: "ok", shipDate: "2026/11/20" }, RS).ok, false);
  assert.deepEqual(S.validateAccept({ decision: "ok", shipDate: "2026-11-18", reason: "shortage" }, RS),
    { ok: true, decision: "ok", reason: "", note: "", shipDate: "2026-11-18" });
  assert.equal(S.validateAccept({ decision: "wait", note: "あ".repeat(201) }, RS).ok, false);
  assert.equal(S.validateAccept({ decision: "wait", note: 1 }, RS).ok, false);
  assert.deepEqual(S.acceptPatchOf({ decision: "wait", note: "12月入荷" }), { acceptStatus: "wait", acceptNote: "12月入荷" });
  assert.deepEqual(S.acceptPatchOf({ decision: "ng", reason: "address", note: "" }), { warehouseIssue: { reason: "address", note: "" } });
  assert.equal(S.acceptPatchOf({ decision: "ok", note: "", shipDate: "2026-11-18" }).shipDate, "2026-11-18");
  assert.ok(!("shipDate" in S.acceptPatchOf({ decision: "ok", note: "" })));
});

t("移り変わり: 受付できる段・確認できる段・発送できる段", () => {
  assert.equal(S.canAccept(req()), true);
  assert.equal(S.canAccept(req({ acceptStatus: "wait" })), true);
  for (const s of [req({ acceptStatus: "ok" }), req({ warehouseIssue: { reason: "x" } }), req({ deliveryMode: "pickup" }), req({ status: "shipped" }), req({ status: "draft" })]) {
    assert.equal(S.canAccept(s), false, JSON.stringify(s.acceptStatus || s.status));
  }
  assert.equal(S.canFinalConfirm(req({ acceptStatus: "ok" })), true);
  assert.equal(S.canFinalConfirm(req({ acceptStatus: "ok", finalConfirmedAt: 1 })), false);
  assert.equal(S.canFinalConfirm(req({ acceptStatus: "ok" }), { finalConfirm: false }), false);
  assert.equal(S.canComplete(req({ acceptStatus: "ok", finalConfirmedAt: 1 })), true);
  assert.equal(S.canComplete(req({ deliveryMode: "pickup" })), true);
  assert.equal(S.canComplete(req()), false);
  assert.match(S.completeBlockedText(req()), /受付/);
  assert.match(S.completeBlockedText(req({ acceptStatus: "ok" })), /最終確認/);
  assert.match(S.completeBlockedText(req({ acceptStatus: "wait" })), /入荷待ち/);
  assert.equal(S.completeBlockedText(req({ acceptStatus: "ok", finalConfirmedAt: 1 })), "");
});

t("梱包の種別と送料の通数（1〜6台＝レターパックプラス・7台以上＝ゆうパック・6台で1通）", () => {
  for (const q of [1, 2, 3, 6]) assert.equal(S.packTypeDefault(q), "plus");
  for (const q of [7, 8, 30]) assert.equal(S.packTypeDefault(q), "yupack");
  assert.equal(S.packTypeOf(req()), "plus");
  assert.equal(S.packTypeOf(req({ items: [R(7)] })), "yupack");
  assert.equal(S.packTypeOf(req({ letterPackType: "light" })), "light");     // 既存の出荷はレターパックの種類を読む
  assert.equal(S.packTypeOf(req({ packType: "yupack", letterPackType: "plus" })), "yupack"); // 倉庫が選んだ種別が先
  assert.equal(S.packTypeOf(req({ packType: "bogus", items: [R(9)] })), "yupack");
  assert.deepEqual([0, 1, 3, 4, 6, 7, 12, 13].map(S.letterpackCount), [1, 1, 1, 1, 1, 2, 2, 3]);
  assert.equal(S.LP_PER_PACK, 6);
  assert.equal(S.readerQty([R(2), R(3, "cir315a-02"), { sku: "discount", qty: 1 }, { sku: "x", qty: 1, nonStock: true }]), 5);
});

t("発送準備の並び: 納品希望日の早い順（無いものは後ろ）→ 依頼の古い順", () => {
  const a = req({ soNumber: "A", desiredDeliveryDate: "2026-11-25", requestedAt: 1 });
  const b = req({ soNumber: "B", desiredDeliveryDate: "2026-11-20", requestedAt: 5 });
  const c = req({ soNumber: "C", desiredDeliveryDate: "", requestedAt: 0 });
  const d = req({ soNumber: "D", desiredDeliveryDate: "2026-11-20", requestedAt: 2 });
  const e = req({ soNumber: "E", desiredDeliveryDate: "", deliveryMode: "pickup", pickupDate: "2026-11-19", requestedAt: 9 }); // 古い持ち出しは予定日
  assert.deepEqual(S.sortByDesired([a, b, c, d, e]).map((x) => x.soNumber), ["E", "D", "B", "A", "C"]);
  assert.deepEqual(S.sortByDesired([{ desiredDeliveryDate: "2026-11-02", requestedAt: "2026-11-01T00:00:00Z", soNumber: "x" },
    { desiredDeliveryDate: "2026-11-02", requestedAt: "2026-10-01T00:00:00Z", soNumber: "y" }]).map((x) => x.soNumber), ["y", "x"]); // ISO 文字列も読む
});

t("Chat の文面は短く、事業所の担当者名・電話番号・番地を書かない", () => {
  const base = { soNumber: "SH-9", region: "【大阪府 豊中市】", qty: 3, desiredDeliveryDate: "2026-11-20", requester: "<users/111>", url: "https://example.test/x" };
  const texts = {
    request: S.shipStepChatText("request", { ...base, locationName: "滋賀" }),
    pickup: S.shipStepChatText("request", { ...base, pickup: true, pickupBy: "<users/222>", locationName: "滋賀" }),
    ok: S.shipStepChatText("ok", { ...base, finalConfirm: true }),
    okSkip: S.shipStepChatText("ok", { ...base, finalConfirm: false }),
    wait: S.shipStepChatText("wait", { ...base, note: "12月入荷" }),
    ng: S.shipStepChatText("ng", { ...base, reasonLabel: "在庫がなく、納品希望日に間に合わない" }),
    done: S.shipStepChatText("done", { ...base, packLabel: "レターパックプラス", trackingNumber: "1234", shipDate: "2026-11-18" }),
    doneP: S.shipStepChatText("done", { ...base, pickup: true, shipDate: "2026-11-18" }),
  };
  for (const [k, x] of Object.entries(texts)) {
    assert.ok(x.split("\n").length <= 5, `${k}: 長い`);
    assert.match(x, /SH-9 【大阪府 豊中市】 3台/, k);
    assert.match(x, /<users\/111>/, k);
    assert.match(x, /👉 CRMで見る: https:\/\/example\.test\/x$/, k);
  }
  assert.match(texts.request, /^📦 出荷の依頼 — /);
  assert.match(texts.request, /納品希望日: 2026-11-20/);
  assert.match(texts.pickup, /^📦 【持ち出し】/);
  assert.match(texts.pickup, /持ち出す人: <users\/222>/);
  assert.match(texts.ok, /最終確認/);
  assert.doesNotMatch(texts.okSkip, /最終確認/);
  assert.match(texts.wait, /12月入荷/);
  assert.match(texts.ng, /理由: 在庫がなく/);
  assert.match(texts.done, /問い合わせ番号: 1234/);
  assert.match(texts.doneP, /受け渡し日: 2026-11-18/);
  assert.match(S.shipStepChatText("request", { ...base, region: "" }), /（地域不明）/);
  assert.equal(S.shipStepChatText("unknown", base), "");
});

// ---- 結線（静的検査） ----
const sup = read("admin/js/supply.js");
const wh = read("admin/js/warehouse.js");
const stubs = read("admin/js/practice-stubs.js");
const fn = read("functions/index.js");
const fs1 = read("functions/ship-steps.js");

t("供給管理: 依頼で必須項目を確かめ、段のリスト・最終確認・選び直し・完了リストのボタンがある", () => {
  const rq = sup.slice(sup.indexOf("async function requestDraftShipment"), sup.indexOf("// 依頼済(requested) → 発送済"));
  assert.match(rq, /requestMissing\(\{ \.\.\.s, deliveryMode: ans\.deliveryMode, desiredDeliveryDate: ans\.desiredDeliveryDate/);
  assert.match(rq, /desiredDeliveryDate: ans\.desiredDeliveryDate/);
  assert.match(rq, /\.\.\.stepResetPatch\(\)/);
  assert.match(sup, /function revertToDraft[\s\S]*?\.\.\.stepResetPatch\(\)/);
  assert.match(sup, /const missing = requestMissing\(\{ items, deliveryMode, pickupByEmail, desiredDeliveryDate: desiredIn/); // 新規登録の依頼
  assert.match(sup, /requestMissing\(\{ \.\.\.sh, items, deliveryMode:"ship"/); // 受注から依頼
  assert.match(sup, /finalConfirmedAt: serverTimestamp\(\), finalConfirmedBy:/);
  assert.match(sup, /if\(!canFinalConfirm\(cur, \{ finalConfirm: finalConfirmNow\(\) \}\)\) throw/); // トランザクションの中で段を確かめる
  for (const c of ["final-ok", "reselect-ship"]) assert.match(sup, new RegExp(`class="btn [^"]*${c}"`), c);
  assert.match(sup, /ship-step-chip" data-step="\$\{esc\(k\)\}" aria-pressed="\$\{on\}" data-tip=/);
  assert.match(sup, /請求書を出す/); assert.match(sup, /入金の画面を開く/); assert.match(sup, /領収証を出す/);
  assert.match(sup, /const shipStepDoneFn = httpsCallable\(functions, "shipStepDone"\)/);
  // 新しいボタンには吹き出しの説明（data-tip）・title は使わない
  for (const label of ["OK（発送準備へ）", "倉庫を選び直して依頼し直す", "変更する", "請求書を出す", "入金の画面を開く"]) {
    const i = sup.indexOf(`</i>${label}<`); assert.ok(i > 0, label);
    const tag = sup.slice(Math.max(sup.lastIndexOf("<button", i), sup.lastIndexOf("<a ", i)), i);
    assert.match(tag, /data-tip="/, `${label} に data-tip が無い`);
  }
  assert.match(read("admin/supply.html"), /\/js\/tooltip\.js" type="module"/);
  assert.match(read("admin/supply.html"), /id="shipDoneDesired"/);
  assert.match(read("admin/supply.html"), /id="shipDesired"/);
  // 送料は6台で1通（3台の計算が残っていない）
  assert.doesNotMatch(sup, /Math\.ceil\([^)]*\/3\)/);
  assert.doesNotMatch(read("admin/js/pricing.js"), /Math\.ceil\(qty\/3\)/);
  assert.match(read("admin/js/supply-rules.js"), /"final-ok", "reselect-ship"/); // 閲覧のみは押せない
  // 設定
  assert.match(read("admin/settings.html"), /id="shipFinalConfirm"/);
  assert.match(read("admin/js/settings.js"), /\$\("shipFinalConfirm"\)\.checked = s\.shipFinalConfirm !== false;/);
  assert.match(read("admin/js/settings.js"), /shipFinalConfirm: \$\("shipFinalConfirm"\)\.checked,/);
});

t("倉庫の画面: 段の切り替え・受付・種別・Firestore を直接読まない", () => {
  assert.match(wh, /const acceptFn = httpsCallable\(functions, "warehouseAccept"\)/);
  assert.match(wh, /const REQ_STEPS = \["accept", "confirm", "wait", "ng", "prepare"\]/);
  assert.match(wh, /sortByDesired\(data\.requested\.filter/);
  assert.match(wh, /packType: \$\("shipPack"\)\.value/);
  assert.match(wh, /data-act="acc"/);
  assert.doesNotMatch(wh, /getDocs?\(|collection\(|onSnapshot/);
  for (const label of ["受付する", "発送済にする", "受け渡し済にする", "出荷できない"]) {
    const i = wh.indexOf(`></i>${label}</button>`); assert.ok(i > 0, label);
    assert.match(wh.slice(wh.lastIndexOf("<button", i), i), /data-tip="/, `${label} に data-tip が無い`);
  }
});

t("練習の代役: 受付・発送完了の知らせ・依頼の必須項目・発送準備の段だけ発送", () => {
  assert.match(stubs, /^  async warehouseAccept\(/m);
  assert.match(stubs, /^  async shipStepDone\(/m);
  const ac = stubs.slice(stubs.indexOf("async warehouseAccept("), stubs.indexOf("async shipStepDone("));
  assert.doesNotMatch(ac, /fetch\(/); assert.match(ac, /logSent\("warehouseAccept"/);
  assert.match(stubs, /if \(!canComplete\(cur, \{ finalConfirm: fc \}\)\) throw fail\(completeBlockedText/);
  assert.match(stubs, /const missing = requestMissing\(s\);/);
  assert.match(stubs, /async function whNotifyDone[\s\S]*?if \(s\.shipDoneNotifiedAt\) return/);
});

t("Functions: 新しいファイル・認可・状態の確認・index.js の結線", () => {
  assert.match(fs1, /const me = await requireWarehouse\(request\); \/\/ 認可を最初に/);
  assert.match(fs1, /if \(!ss\.canAccept\(cur, \{ finalConfirm: fc \}\)\)/);
  assert.match(fs1, /if \(!wr\.canUseLocation\(me\.user, locId\)\) throw new HttpsError\("permission-denied"/);
  assert.match(fs1, /const me = await requireStaff\(request, \{ allow: "editor" \}\);/); // shipStepDone は職員だけ
  assert.match(fs1, /if \(cur\.shipDoneNotifiedAt\) return "already";/);
  assert.match(fs1, /getWebhook\("shipping"\)/); // 投稿先は今のまま
  assert.match(fn, /exports\.warehouseAccept = ShipSteps\.warehouseAccept;/);
  assert.match(fn, /exports\.shipStepDone = ShipSteps\.shipStepDone;/);
  assert.match(fn, /if \(!ss\.canComplete\(cur, \{ finalConfirm: fc \}\)\) throw new HttpsError\("failed-precondition", ss\.completeBlockedText/);
  assert.match(fn, /done = await ShipSteps\.notifyShipDone\(shipmentId, me\)/);
  assert.doesNotMatch(fn, /function shipmentChatMessage/);
  // 請求・入金の計算には触れていない（このファイルに invoiceTotals・netPaidOf を書き足していない）
  assert.doesNotMatch(fs1, /invoiceTotals|netPaidOf|billableIncl|payments/);
});

{
  // 依頼済にする道はすべて requestedStampPatch を通り、そこで印を付ける
  assert.match(sup, /requestedAt: serverTimestamp\(\), requestSeq: increment\(1\), shipFlow: SHIP_FLOW \};/);
  const paths = [...sup.matchAll(/status:\s*"requested"/g)].length;
  assert.ok(paths >= 2);
  for (const m of sup.matchAll(/status:\s*alreadyShipped \? "shipped" : "requested"[\s\S]{0,1200}/g)) assert.match(m[0], /requestedStampPatch\(\)/);
  assert.match(sup, /status:"requested", partnerOrderId:o\._id,[\s\S]{0,900}requestedStampPatch\(\)/);
  assert.match(sup, /requestedStampPatch\(\), warehouseIssue: deleteField\(\)/); // 下書きから依頼
  // 変更で受付へ戻す
  assert.match(sup, /const back = stepResetNeeded\(cur, patch\);/);
  assert.match(sup, /\.\.\.\(back \? stepResetPatch\(\) : \{\}\)/);
  // 段の無い返事は発送準備
  assert.match(wh, /const stepOfW = \(s\) => s\.step \|\| "prepare";/);
  // サーバーの必須項目の確認は印のある依頼だけ／発送完了の知らせは24時間以内
  assert.match(fn, /!d\.shipNotifiedAt && ssRules\.isNewFlow\(d\)\)/);
  assert.match(fs1, /if \(!ms \|\| Date\.now\(\) - ms > SHIP_DONE_WINDOW_MS\) return "old";/);
  assert.match(fs1, /const SHIP_DONE_WINDOW_MS = 24 \* 3600 \* 1000;/);
  assert.match(stubs, /if \(!shippedRecently\(s\)\) return \{ notified: false, skipped: "old" \};/);
  assert.match(stubs, /!s\.shipNotifiedAt && isNewFlow\(s\)\)/);
}
{
  // 画面の部品は "/js/…" で読み合うので、node では file: の URL に置き換えて読む
  const src = read("admin/js/letterpack-label.js").replace('"/js/ship-flow.js"', JSON.stringify(root("admin/js/ship-flow.js").href));
  const L = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
  assert.equal(L.labelTypeOf({ packType: "yupack", letterPackType: "plus" }), "yupack");
  assert.equal(L.labelTypeOf({ packType: "light" , letterPackType: "light" }), "light");
  assert.equal(L.labelTypeOf({}), "plus");
  const html = L.renderLabel({ soNumber: "SH-Y", items: [R(8)], packType: "yupack" }, {}, "yupack");
  assert.doesNotMatch(html, /レターパック/);
  assert.match(html, /ゆうパック（元払い）/);
  assert.match(L.renderLabel({ soNumber: "SH-P", items: [R(1)] }, {}, "plus"), /レターパックプラス/);
  assert.match(read("admin/js/warehouse-print.js"), /renderPage\(s, sender, labelTypeOf\(s\)/);
  assert.match(read("admin/js/letterpack-print.js"), /let type = labelTypeOf\(s\);/);
  assert.match(read("admin/js/supply-print.js"), /type==="letterpack" && d\.packType==="yupack"/);
  n++; console.log("  ok レビュー #76 の直し（静的検査・宛名）");
}
{
  const { pmDiscountRow } = await import("../admin/js/pm-discount.js");
  const reader = { sku: "cir315a-02", name: "CIR315A", qty: 3, unitPrice: 6500 };
  const fee = { sku: "support-fee", qty: 1, unitPrice: 50000, nonStock: true };
  t("伴走支援費の PM 値引きの行は台数（readerQty）に入らない・受付に戻す判定にも出ない（2026-11-13）", () => {
    assert.equal(S.readerQty([reader, fee, pmDiscountRow(5500)]), 3);
    assert.equal(S.readerQty([reader, fee]), S.readerQty([reader, fee, pmDiscountRow(1)]));
  });
}
console.log(`OK test-ship-steps: ${n} 件 合格`);
