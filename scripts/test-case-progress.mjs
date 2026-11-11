// 進み具合の帯（admin/js/case-progress.js）の単体テスト。依存なし。node scripts/test-case-progress.mjs
import assert from "node:assert/strict";
import {
  PROGRESS_STEPS, STATUS_TO_STEP, SHIP_STEP, STALE_DEFAULTS, STALE_EXEMPT_STATUSES,
  resolveStaleConfig, statusChangePatch, shipStageOf, stepIndexOfStatus, caseProgress,
  stageSince, stageDays, staleLevel, staleFilterMatch, progressAriaLabel, daysText,
  progressDotsHtml, progressBandHtml, ORDER_LABEL_CONSENT,
} from "../admin/js/case-progress.js";
import { STATUS_LABELS } from "../admin/js/constants.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };
const states = (p) => p.steps.map((s) => s.state[0]).join(""); // d=done c=current t=todo

t("区切りは8つ・順番どおり", () => {
  assert.deepEqual(PROGRESS_STEPS.map((s) => s.label), ["受付", "見積", "発注", "準備", "出荷", "伴走支援", "申請", "完了"]);
  assert.equal(SHIP_STEP, 4);
});

t("13段階 → 区切り（状態だけ）", () => {
  const exp = { 1: 0, 2: 0, 3: 2, 5: 3, 6: 3, 7: 5, 8: 5, 9: 6, 10: 6, 11: 6, 12: 7, 13: 7, 4: -1 };
  for (const [st, i] of Object.entries(exp)) assert.equal(stepIndexOfStatus(Number(st), {}), i, `状態${st}`);
  // 見積もりがあれば 1・2 は「見積」
  assert.equal(stepIndexOfStatus(1, { latestQuoteId: "q1" }), 1);
  assert.equal(stepIndexOfStatus(2, { latestQuoteId: "q1" }), 1);
  assert.equal(stepIndexOfStatus(99, {}), -1);
  // 13段階すべてに対応がある（4 失注は別扱い）
  for (const st of Object.keys(STATUS_LABELS).map(Number)) {
    if (st === 4 || st === 1 || st === 2) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(STATUS_TO_STEP, st), `状態${st}に対応がある`);
  }
});

t("済／いま／まだ（一覧＝出荷を読まない）", () => {
  assert.equal(states(caseProgress({ status: 1 })), "cttttttt");
  assert.equal(states(caseProgress({ status: 2, latestQuoteId: "q" })), "dctttttt");
  assert.equal(states(caseProgress({ status: 3 })), "ddcttttt");
  assert.equal(states(caseProgress({ status: 6 })), "dddctttt");
  // 伴走支援待ち以降は出荷を「済」とみなす
  assert.equal(states(caseProgress({ status: 7 })), "dddddctt");
  assert.equal(states(caseProgress({ status: 10 })), "ddddddct");
  assert.equal(states(caseProgress({ status: 12 })), "dddddddc");
  const done = caseProgress({ status: 13 });
  assert.equal(states(done), "dddddddd"); assert.equal(done.finished, true);
});

t("失注は灰色（すべて lost）", () => {
  const p = caseProgress({ status: 4 });
  assert.equal(p.lost, true); assert.equal(p.current, -1);
  assert.match(progressBandHtml(p, 3, "exempt"), /失注/);
  assert.match(progressDotsHtml(p, null, "exempt"), /cp-lost/);
  assert.equal(progressAriaLabel(p, 3, "exempt"), "進み具合: 失注");
});

t("出荷の状態（案件詳細）", () => {
  assert.equal(shipStageOf(null), "none");
  assert.equal(shipStageOf([{ status: "canceled" }]), "none");
  assert.equal(shipStageOf([{ status: "draft" }]), "draft");
  assert.equal(shipStageOf([{ status: "draft" }, { status: "requested" }]), "requested");
  assert.equal(shipStageOf([{ status: "shipped" }, { status: "paid" }, { status: "canceled" }]), "shipped");
  assert.equal(shipStageOf([{}]), "shipped"); // 状態の無い古い出荷は発送済み扱い
  // 準備中に依頼済み → いまは「出荷」
  const a = caseProgress({ status: 6 }, { shipments: [{ status: "requested" }] });
  assert.equal(a.current, SHIP_STEP); assert.equal(states(a), "ddddcttt");
  // 準備中で発送済み → いまは準備のまま、出荷は済
  const b = caseProgress({ status: 5 }, { shipments: [{ status: "shipped" }] });
  assert.equal(states(b), "dddcdttt");
  // 下書きだけ → 状態どおり
  assert.equal(states(caseProgress({ status: 3 }, { shipments: [{ status: "draft" }] })), "ddcttttt");
  // 伴走支援まで進んだのに発送済みでない → 出荷は「まだ」と注意
  const c = caseProgress({ status: 8 }, { shipments: [{ status: "requested" }] });
  assert.equal(states(c), "ddddtctt"); assert.match(c.steps[SHIP_STEP].note, /発送済みになっていない/);
  assert.match(progressBandHtml(c, 1, "ok"), /cp-attn/);
  // 出荷が無い／空 → 状態だけで決める
  assert.equal(states(caseProgress({ status: 7 }, { shipments: [] })), "dddddctt");
  // 受注確定（発注）のままなら、依頼済みでも発注をいまのまま残す（準備に「済」を付けない）
  const o = caseProgress({ status: 3 }, { shipments: [{ status: "requested" }] });
  assert.equal(states(o), "ddcttttt"); assert.match(o.steps[SHIP_STEP].note, /依頼済み/);
  // 受付・見積の段階では依頼済みでも「出荷」に飛ばさない
  assert.equal(caseProgress({ status: 1 }, { shipments: [{ status: "requested" }] }).current, 0);
  // 完了は全部済
  assert.equal(states(caseProgress({ status: 13 }, { shipments: [{ status: "draft" }] })), "dddddddd");
});

t("承諾書で発注のスイッチ → 区切りの名前", () => {
  assert.equal(caseProgress({ status: 3 }, { orderByConsent: true }).steps[2].label, ORDER_LABEL_CONSENT);
  assert.equal(caseProgress({ status: 3 }).steps[2].label, "発注");
});

t("設定 stageStale", () => {
  assert.deepEqual(resolveStaleConfig(null), STALE_DEFAULTS);
  assert.deepEqual(resolveStaleConfig({}), { warnDays: 14, alertDays: 30 });
  assert.deepEqual(resolveStaleConfig({ stageStale: { warnDays: 7, alertDays: 21 } }), { warnDays: 7, alertDays: 21 });
  assert.deepEqual(resolveStaleConfig({ stageStale: { warnDays: "10", alertDays: "20" } }), { warnDays: 10, alertDays: 20 });
  assert.deepEqual(resolveStaleConfig({ stageStale: { warnDays: 30, alertDays: 14 } }), STALE_DEFAULTS); // 逆は既定
  assert.deepEqual(resolveStaleConfig({ stageStale: { warnDays: 0, alertDays: 5 } }), STALE_DEFAULTS);
  assert.deepEqual(resolveStaleConfig({ stageStale: { warnDays: 1.5, alertDays: 5 } }), STALE_DEFAULTS);
  assert.deepEqual(resolveStaleConfig({ stageStale: { warnDays: 10 } }), { warnDays: 10, alertDays: 30 });
  assert.deepEqual(resolveStaleConfig({ stageStale: { alertDays: 60 } }), { warnDays: 14, alertDays: 60 });
  assert.deepEqual(resolveStaleConfig({ stageStale: { warnDays: 40 } }), STALE_DEFAULTS); // 既定の赤より後ろは採らない
});

t("日数の色（境界）", () => {
  const cfg = STALE_DEFAULTS;
  assert.equal(staleLevel(3, 13, cfg), "ok");
  assert.equal(staleLevel(3, 14, cfg), "warn");
  assert.equal(staleLevel(3, 29, cfg), "warn");
  assert.equal(staleLevel(3, 30, cfg), "alert");
  assert.equal(staleLevel(3, null, cfg), "unknown"); // 分からないときは色を付けない
  for (const st of [10, 11, 12, 4, 13]) assert.equal(staleLevel(st, 400, cfg), "exempt", `状態${st}は対象外`);
  assert.deepEqual(STALE_EXEMPT_STATUSES.slice().sort((a, b) => a - b), [4, 10, 11, 12, 13]);
  for (const st of [1, 2, 3, 5, 6, 7, 8, 9]) assert.equal(staleLevel(st, 30, cfg), "alert", `状態${st}は対象`);
  assert.equal(staleLevel(3, 7, { warnDays: 7, alertDays: 10 }), "warn");
});

t("絞り込み（黄色以上／赤）", () => {
  assert.equal(staleFilterMatch("ok", ""), true);
  assert.equal(staleFilterMatch("warn", "warn"), true);
  assert.equal(staleFilterMatch("alert", "warn"), true);
  assert.equal(staleFilterMatch("ok", "warn"), false);
  assert.equal(staleFilterMatch("unknown", "warn"), false);
  assert.equal(staleFilterMatch("exempt", "warn"), false);
  assert.equal(staleFilterMatch("warn", "alert"), false);
  assert.equal(staleFilterMatch("alert", "alert"), true);
});

t("日数（日本時間の暦日）", () => {
  const now = new Date("2026-11-12T10:00:00+09:00");
  assert.equal(stageDays(new Date("2026-11-12T00:10:00+09:00"), now), 0);
  assert.equal(stageDays(new Date("2026-11-11T23:59:00+09:00"), now), 1); // 日付が変わったら1日
  assert.equal(stageDays(new Date("2026-10-29T12:00:00+09:00"), now), 14);
  assert.equal(stageDays({ toDate: () => new Date("2026-10-13T09:00:00+09:00") }, now), 30); // Firestore の Timestamp
  assert.equal(stageDays(null, now), null);
  assert.equal(stageDays(new Date("2026-11-20T00:00:00+09:00"), now), 0); // 時計のずれで未来でも負にしない
  assert.equal(daysText(null), "—"); assert.equal(daysText(3), "3日");
});

t("何日いるかの起点", () => {
  const T = (s) => new Date(s);
  // 1) statusChangedAt（変更先が今の状態と同じとき）
  assert.deepEqual(stageSince({ status: 5, statusChangedAt: T("2026-11-01"), statusChangedTo: 5 }), { at: T("2026-11-01"), source: "field" });
  // Functions が状態を変えた（To が食い違う）→ 一覧では分からない
  assert.deepEqual(stageSince({ status: 3, statusChangedAt: T("2026-11-01"), statusChangedTo: 2 }), { at: null, source: null });
  // 既存の案件（項目なし）→ 一覧では分からない（updatedAt は使わない）
  assert.deepEqual(stageSince({ status: 6, updatedAt: T("2026-11-10") }), { at: null, source: null });
  assert.deepEqual(stageSince({ status: 1, receivedAt: T("2026-11-01") }), { at: null, source: null });
  // 2) 案件詳細: 対応記録の最後の「ステータス変更」（変更先が今の状態のとき）
  const acts = [
    { subject: "ステータス変更 → 確認中", occurredAt: T("2026-10-01") },
    { subject: "ステータス変更 確認中 → 事前準備中", occurredAt: T("2026-10-20") }, // カンバンの書き方
    { subject: "メモ", occurredAt: T("2026-11-05") },
  ];
  assert.deepEqual(stageSince({ status: 6 }, { activities: acts }), { at: T("2026-10-20"), source: "activity" });
  // 最後の変更先が今の状態と違う（そのあと Functions が変えた）→ 分からない
  assert.deepEqual(stageSince({ status: 3 }, { activities: acts }), { at: null, source: null });
  // 項目の To が食い違っても、対応記録で分かればそれを使う
  assert.equal(stageSince({ status: 6, statusChangedAt: T("2026-09-01"), statusChangedTo: 2 }, { activities: acts }).source, "activity");
  // 書き込み中（occurredAt がまだ無い）行は飛ばす
  assert.equal(stageSince({ status: 6 }, { activities: [...acts, { subject: "ステータス変更 → 担当者決定", occurredAt: null }] }).source, "activity");
  // 3) 新規受信のまま、ステータス変更が1行も無い → 受信日
  assert.deepEqual(stageSince({ status: 1, receivedAt: T("2026-11-02") }, { activities: [] }), { at: T("2026-11-02"), source: "received" });
  // 新規受信でも、過去にステータス変更がある（戻した）なら受信日は使わない
  assert.equal(stageSince({ status: 1, receivedAt: T("2026-11-02") }, { activities: [{ subject: "ステータス変更 → 新規受信", occurredAt: T("2026-11-05") }] }).at.getTime(), T("2026-11-05").getTime());
  assert.equal(stageSince({ status: 2, receivedAt: T("2026-11-02") }, { activities: [] }).at, null); // 2 は受信日を使わない
});

t("状態を書くときの項目", () => {
  assert.deepEqual(statusChangePatch("7", "TS"), { statusChangedAt: "TS", statusChangedTo: 7 });
});

t("読み上げの文", () => {
  const p = caseProgress({ status: 3 });
  assert.equal(progressAriaLabel(p, 12, "ok"), "進み具合: 8段階中3番目 発注。この段階に12日");
  assert.equal(progressAriaLabel(p, null, "unknown"), "進み具合: 8段階中3番目 発注。この段階の日数は不明");
  assert.equal(progressAriaLabel(p, 31, "alert"), "進み具合: 8段階中3番目 発注。この段階に31日。止まっています（赤）");
  assert.match(progressAriaLabel(caseProgress({ status: 13 }), 3, "exempt"), /8段階すべて済/);
});

t("HTML（文字の差し込みはエスケープ・済はチェック・いまは aria-current）", () => {
  const p = caseProgress({ status: 6 });
  const band = progressBandHtml(p, 15, "warn", { sinceSource: "field" });
  assert.match(band, /aria-current="step"/);
  assert.equal((band.match(/ti-check/g) || []).length, 3); // 受付・見積・発注 が済
  assert.match(band, /この段階に 15日/);
  assert.match(band, /cp-lv-warn/);
  assert.match(band, /data-tip=/);
  assert.match(band, /aria-label="進み具合: 8段階中4番目 準備。この段階に15日。止まりかけています（黄）"/);
  const unknown = progressBandHtml(p, null, "unknown", { sinceSource: null });
  assert.match(unknown, /この段階に —/);
  const mini = progressDotsHtml(p, 31, "alert");
  assert.equal((mini.match(/cp-dot /g) || []).length, 8);
  assert.match(mini, /aria-hidden="true"/);
  assert.match(mini, /31日/);
  assert.equal(progressDotsHtml(caseProgress({ status: 99 }), 1, "ok"), "");
  assert.ok(!/<script/i.test(progressBandHtml(p, 1, "ok", { sinceSource: '"><script>' })));
});

// 画面の JS が、使っている case-progress.js の関数をすべて取り込んでいる（2026-11-12 レビュー 高: cases.js で statusChangePatch の取り込み漏れ）
{
  const fs = await import("node:fs");
  const mod = await import("../admin/js/case-progress.js");
  const names = Object.keys(mod);
  for (const f of ["admin/js/cases.js", "admin/js/case-detail.js", "admin/js/kanban.js"]) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*"\/js\/case-progress\.js"/);
    assert.ok(m, `${f} が case-progress.js を取り込んでいる`);
    const imported = new Set(m[1].split(",").map((x) => x.trim()).filter(Boolean));
    const body = src.replace(m[0], "");
    for (const nm of names) {
      if (new RegExp(`\\b${nm}\\s*\\(`).test(body)) assert.ok(imported.has(nm), `${f} は ${nm} を使っているので取り込みが要る`);
    }
  }
  n++;
}

console.log(`test-case-progress: ${n} 件 合格`);
