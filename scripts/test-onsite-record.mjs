// 当日タブと伴走支援の記録の統合（設計書 2026-11-10 提案1）・対応記録から当日の記録を開く（提案5）のテスト。
// node scripts/test-onsite-record.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as R from "../admin/js/onsite-record.js";
import { evaluationId } from "../admin/js/support-evaluation.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ===== 提案1: 初期値の判定 =====
t("訪問日は保存済みの onsite.visitDate を正にし、無ければ案件の訪問予定日", () => {
  assert.equal(R.effectiveVisitDate({ visitDate: "2026-11-12" }, { visitDate: "2026-11-01" }), "2026-11-12");
  assert.equal(R.effectiveVisitDate({}, { visitDate: "2026-11-01" }), "2026-11-01");
  assert.equal(R.effectiveVisitDate({ visitDate: "" }, { visitDate: "2026-11-01" }), "2026-11-01");
  assert.equal(R.effectiveVisitDate(null, null), "");
  assert.equal(R.effectiveVisitDate({ steps: {} }, {}), "");
});

t("初期値は欄が空のときだけ入る", () => {
  assert.equal(R.dateDefault("", "2026-11-12"), "2026-11-12");
  assert.equal(R.dateDefault(undefined, "2026-11-12"), "2026-11-12");
  assert.equal(R.dateDefault("  ", "2026-11-12"), "2026-11-12");
});

t("既に値がある欄は変えない・訪問日が無ければ何もしない・触って未保存なら入れない", () => {
  assert.equal(R.dateDefault("2026-10-01", "2026-11-12"), null);
  assert.equal(R.dateDefault("", ""), null);
  assert.equal(R.dateDefault("", "2026-11-12", { dirty: true }), null, "自分で消した欄に入れ直さない");
});

t("実施の記録: 保存済みの performance.date は絶対に書き換えない", () => {
  const saved = { date: "2026-10-30", performerId: "a@tadakayo.jp", mode: "training" };
  // 画面の欄が空でも（読み込み直後など）、保存済みの実施日があれば入れない
  assert.equal(R.perfDateDefault(saved, "", "2026-11-12"), null);
  assert.equal(R.perfDateDefault(saved, "2026-10-30", "2026-11-12"), null);
  // 評価IDが変わらないこと（初期値を入れなかった＝実施日は保存済みのまま）
  const id = evaluationId("CASE1", saved.date, saved.performerId);
  assert.equal(id, evaluationId("CASE1", "2026-10-30", "a@tadakayo.jp"));
});

t("実施の記録: 未保存（performance なし／実施日が空）で欄が空なら訪問日を入れる", () => {
  assert.equal(R.perfDateDefault(null, "", "2026-11-12"), "2026-11-12");
  assert.equal(R.perfDateDefault({ date: "" }, "", "2026-11-12"), "2026-11-12");
  assert.equal(R.perfDateDefault(null, "2026-11-01", "2026-11-12"), null, "入力済みは変えない");
  assert.equal(R.perfDateDefault(null, "", "2026-11-12", { dirty: true }), null, "触って未保存なら入れない");
});

t("旧「伴走支援」タブの指定は当日タブへ読み替える", () => {
  assert.equal(R.resolveTab("sessions"), "onsite");
  for (const k of ["timeline", "pre", "onsite", "documents", "shipping", "subsidy", "after", "ai"]) assert.equal(R.resolveTab(k), k);
});

// ===== 提案1: 画面の配線 =====
const html = src("../admin/case-detail.html");
const cd = src("../admin/js/case-detail.js");
const sc = src("../admin/js/support-checklist.js");

t("タブの並びは 対応記録 → 事前確認 → 当日 → 書類 → 出荷 → 申請 → アフター → AI（伴走支援タブは無い）", () => {
  const tabs = [...html.matchAll(/class="tab[^"]*" role="tab" data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["timeline", "pre", "onsite", "documents", "shipping", "subsidy", "after", "ai"]);
  assert.ok(!html.includes('id="tab-sessions"'));
  assert.match(html, /<button class="tab active" role="tab" data-tab="timeline" aria-selected="true">/, "既定は対応記録");
  assert.match(html, /<div class="tab-content active" id="tab-timeline">/);
});

t("伴走支援の記録は当日タブの末尾（チェックリストの下）にある", () => {
  const i = html.indexOf('id="tab-onsite"');
  const j = html.indexOf("<!-- 書類チェックタブ -->");
  const onsite = html.slice(i, j);
  const ck = onsite.indexOf('id="onsiteChecklist"');
  for (const id of ["sessionDate", "sessionSummary", "addSessionBtn", "sessionUnsaved", "sessionsEl", "sessionPhotos", "cameraBtn", "galleryBtn"]) {
    const k = onsite.indexOf(`id="${id}"`);
    assert.ok(k > ck && ck >= 0, `${id} が当日タブのチェックリストの下に無い`);
  }
});

t("案件詳細の HTML に同じ id が2つ無い", () => {
  const ids = [...html.matchAll(/\sid="([^"$]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((x, k) => ids.indexOf(x) !== k);
  assert.deepEqual(dup, []);
});

t("チェックリストは #onsiteChecklist にだけ描く（伴走支援の記録を消さない）", () => {
  assert.match(sc, /const elOnsite = document\.getElementById\("onsiteChecklist"\) \|\| document\.getElementById\("tab-onsite"\);/);
  assert.match(sc, /elOnsite\.innerHTML = renderOnsite\(\);/);
});

t("初期値の配線: 実施の記録・伴走支援の記録とも純関数を通し、保存済みの実施日は流し込みで戻す", () => {
  assert.match(sc, /perfDateDefault\(perf, el\.value, visitDate\(\), \{ dirty: perfUnsaved \? perfUnsaved\.isDirty\(\) : false \}\)/);
  assert.match(sc, /\$\("sc-perf-date"\)\.value = \(perf && perf\.date\) \|\| "";/);
  assert.match(cd, /dateDefault\(el\.value, onsiteVisitDate, \{ dirty: !!sessionUnsaved\?\.isDirty\(\) \}\)/);
  assert.match(cd, /onVisitDate: \(d\) => \{ onsiteVisitDate = d \|\| ""; applySessionDateDefault\(\); \}/);
  // 初期値を入れるだけでは未保存にしない（イベントを起こさない）
  for (const body of [sc.slice(sc.indexOf("function applyPerfDateDefault"), sc.indexOf("function applyPerfDateDefault") + 600),
    cd.slice(cd.indexOf("function applySessionDateDefault"), cd.indexOf("async function addSession"))]) {
    assert.ok(!/dispatchEvent|\.mark\(\)/.test(body), "初期値でイベント・未保存を起こしている");
  }
});

t("PR #57 の未保存の見張りはそのまま（伴走支援の記録とその編集）", () => {
  assert.match(cd, /sessionUnsaved = trackUnsaved\("session", document\.getElementById\("addSessionBtn"\)\.closest\("\.card"\), "sessionUnsaved"\);/);
  assert.match(cd, /sessionEditUnsaved = trackUnsaved\("sessionEdit", document\.getElementById\("sessionsEl"\), "sessEditUnsaved",/);
});

console.log(`ok ${n} tests`);
