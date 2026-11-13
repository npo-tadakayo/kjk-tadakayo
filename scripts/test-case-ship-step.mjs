// 案件詳細の出荷タブの「発送の段」バッジ（admin/js/case-ship-step.js・2026-11-13）の単体テストと結線の静的検査。
// 表示だけの変更なので、書き込み（updateDoc など）が増えていないことも見る。実行: node scripts/test-case-ship-step.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shipStepBadgeHtml, shipWaitLabel, STEP_TIPS } from "../admin/js/case-ship-step.js";
import { stepOf, STEP_LABEL, STEP_BADGE, STEP_KEYS } from "../admin/js/ship-steps-rules.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };
const req = (o = {}) => ({ status: "requested", soNumber: "SH-1", shipFlow: 2, items: [], ...o });
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const label = (s, o) => { const h = shipStepBadgeHtml(s, { esc, ...o }); const m = h.match(/>([^<]*)<\/span>$/); return m ? m[1] : ""; };

t("依頼済でない出荷には出さない（下書き・発送済・請求済・入金済・キャンセル・状態なし）", () => {
  for (const st of ["draft", "shipped", "invoiced", "paid", "canceled", undefined]) assert.equal(shipStepBadgeHtml(req({ status: st }), { esc }), "", String(st));
  assert.equal(shipStepBadgeHtml(null), "");
});
t("新しい流れ: 受付待ち → 受付", () => assert.equal(label(req()), STEP_LABEL.accept));
t("新しい流れ: 入荷待ち", () => assert.equal(label(req({ acceptStatus: "wait" })), STEP_LABEL.wait));
t("新しい流れ: 発送可で最終確認前 → 確認待ち", () => assert.equal(label(req({ acceptStatus: "ok" })), STEP_LABEL.confirm));
t("新しい流れ: 最終確認済 → 発送準備", () => assert.equal(label(req({ acceptStatus: "ok", finalConfirmedAt: 1 })), STEP_LABEL.prepare));
t("最終確認を行わない設定（finalConfirm:false）なら 発送可 → 発送準備", () => assert.equal(label(req({ acceptStatus: "ok" }), { finalConfirm: false }), STEP_LABEL.prepare));
t("倉庫の差し戻し（warehouseIssue）→ 発送不可", () => assert.equal(label(req({ warehouseIssue: { reason: "shortage" } })), STEP_LABEL.ng));
t("古い流れ（印なしの依頼済）→ 発送準備（倉庫がそのまま発送済にできる）", () => { const s = req(); delete s.shipFlow; assert.equal(label(s), STEP_LABEL.prepare); });
t("持ち出し・直送 → 発送準備", () => {
  assert.equal(label(req({ deliveryMode: "pickup" })), STEP_LABEL.prepare);
  assert.equal(label(req({ fulfillment: "direct" })), STEP_LABEL.prepare);
});
t("一覧と同じ判定: すべての組み合わせで stepOf と同じ段・同じ色になる", () => {
  for (const flow of [2, undefined]) for (const acc of [undefined, "ok", "wait"]) for (const conf of [true, false]) for (const fcA of [undefined, 1]) for (const wi of [undefined, { reason: "other" }]) {
    const s = req({ shipFlow: flow, acceptStatus: acc, finalConfirmedAt: fcA, warehouseIssue: wi });
    const step = stepOf(s, { finalConfirm: conf });
    const h = shipStepBadgeHtml(s, { finalConfirm: conf, esc });
    assert.ok(h.includes(`badge-${STEP_BADGE[step]}`) && h.includes(`>${STEP_LABEL[step]}<`), JSON.stringify(s));
  }
});
t("ツールチップ（data-tip）が付き、HTML をエスケープする", () => {
  assert.ok(shipStepBadgeHtml(req(), { esc }).includes(`data-tip="${esc(STEP_TIPS.accept)}"`));
  const h = shipStepBadgeHtml(req(), { esc: (v) => "<" + v + ">" });
  assert.ok(h.includes("&lt;") === false && h.includes("<" + STEP_TIPS.accept + ">"));
});
t("ツールチップはすべての段にある", () => { for (const k of STEP_KEYS) assert.ok(STEP_TIPS[k], k); });

const detail = read("admin/js/case-detail.js");
const supply = read("admin/js/supply.js");
t("結線: 案件詳細が shipStepBadgeHtml を import し、出荷カードの先頭行で呼ぶ", () => {
  assert.match(detail, /import \{ shipStepBadgeHtml, shipWaitLabel \} from "\/js\/case-ship-step\.js"/);
  assert.match(detail, /shipStepBadgeHtml\(s, \{ finalConfirm: finalConfirmOn\(appSettings\), esc: escHtml \}\)/);
});
t("結線: 供給管理は STEP_TIPS を同じ部品から読む（二重定義しない）", () => {
  assert.match(supply, /import \{ STEP_TIPS \} from "\/js\/case-ship-step\.js"/);
  assert.ok(!/const STEP_TIPS\s*=/.test(supply));
});
t("書き込みなし: case-ship-step.js は firebase を読まず、書き込み API を含まない", () => {
  const src = read("admin/js/case-ship-step.js");
  assert.ok(!/firebase|updateDoc|setDoc|runTransaction|addDoc|deleteDoc/.test(src.replace(/\/\/.*$/gm, "")));
});
// ===== 案件詳細「次にやること」の待ちの文言（2026-11-13・段と食い違わない） =====
t("待ちの文言: 受付待ち・入荷待ち・確認待ち・発送準備が段に合う（「倉庫の発送待ち」に固定しない）", () => {
  assert.equal(shipWaitLabel(req()), "倉庫の受付待ち");
  assert.equal(shipWaitLabel(req({ acceptStatus: "wait" })), "在庫の入荷待ち");
  assert.match(shipWaitLabel(req({ acceptStatus: "ok" })), /最終確認/);
  assert.equal(shipWaitLabel(req({ acceptStatus: "ok", finalConfirmedAt: 1 })), "倉庫で発送の準備中");
  assert.equal(shipWaitLabel(req({ acceptStatus: "ok" }), { finalConfirm: false }), "倉庫で発送の準備中");
  assert.match(shipWaitLabel(req({ warehouseIssue: { reason: "x" } })), /発送不可/);
});
t("待ちの文言: 持ち出し・印の無い既存の依頼済は準備中（受け渡し／発送）", () => {
  assert.equal(shipWaitLabel(req({ deliveryMode: "pickup" })), "倉庫で受け渡しの準備中");
  assert.equal(shipWaitLabel(req({ shipFlow: undefined })), "倉庫で発送の準備中");
});
t("待ちの文言: どの段でも「倉庫の発送待ち」は出さず、バッジの段と同じ判定（stepOf）を使う", () => {
  for (const o of [{}, { acceptStatus: "wait" }, { acceptStatus: "ok" }, { acceptStatus: "ok", finalConfirmedAt: 1 }, { deliveryMode: "pickup" }, { warehouseIssue: { reason: "x" } }]) {
    assert.ok(!shipWaitLabel(req(o)).includes("倉庫の発送待ち"), JSON.stringify(o));
  }
  const cd = read("admin/js/case-detail.js");
  const fn = cd.slice(cd.indexOf("function shipNextAction(s)"), cd.indexOf("function shipNextActionHtml(s)"));
  assert.match(fn, /shipWaitLabel\(s, stepOpts\)/);
  assert.ok(!fn.includes("倉庫の発送待ち"));
});
console.log(`\n${n} passed`);
