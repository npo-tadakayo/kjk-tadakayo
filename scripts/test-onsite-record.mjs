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
  assert.match(sc, /perfDateDefault\(perf, el\.value, visitDate\(\), \{ dirty: perfUnsaved \? perfUnsaved\.isDirty\(\) : false, lastAuto: perfAutoDate \}\)/);
  assert.match(sc, /\$\("sc-perf-date"\)\.value = \(perf && perf\.date\) \|\| "";/);
  assert.match(cd, /dateDefault\(el\.value, onsiteVisitDate, \{ dirty: !!sessionUnsaved\?\.isDirty\(\), lastAuto: sessionAutoDate \}\)/);
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

// ===== 提案5: 当日の記録を確定 =====
const STEP_KEYS = ["portalReg", "certInstall", "mynaApp", "crConnect", "webSetup", "operationTest", "userNotice"];
const CP_KEYS = ["clientInstall", "certInstall", "licenseApply", "csvExport", "csvImport", "testSend"];

t("確定の要約は訪問日と完了した工程の数だけ（done が true のものだけ数える）", () => {
  const onsite = { visitDate: "2026-11-12", notes: "山田太郎様 宅で実施", steps: {
    portalReg: { done: true, memo: "被保険者番号 1234567890" }, certInstall: { done: true }, mynaApp: { done: false }, crConnect: { memo: "x" } } };
  const cp = { steps: { clientInstall: { done: true } } };
  const r = R.onsiteConfirmSummary({ onsite, cp, visitDate: "2026-11-12", stepKeys: STEP_KEYS, cpStepKeys: CP_KEYS });
  assert.equal(r.subject, "当日の記録を確定（2026-11-12）");
  assert.equal(r.body, "介護情報基盤の当日工程: 2/7 完了\nケアプラン連携の導入作業: 1/6 完了");
  // 所感・メモ（利用者氏名や番号が入りうる）は写さない
  assert.ok(!/山田|1234567890|被保険者/.test(r.subject + r.body));
});

t("ケアプラン連携が導入済みなら省略と書く・工程が空でも 0 件で出る", () => {
  const r = R.onsiteConfirmSummary({ onsite: {}, cp: { installStatus: "installed" }, visitDate: "2026-11-12", stepKeys: STEP_KEYS, cpStepKeys: CP_KEYS, cpInstalled: true });
  assert.equal(r.body, "介護情報基盤の当日工程: 0/7 完了\nケアプラン連携: 導入済みのため省略");
});

t("二重防止: この案件の対応記録に同じ訪問日の確定があれば見つける。別の日・参照なし・伴走支援の参照は見つけない", () => {
  const acts = [
    { _id: "a1", type: "visit", subject: "当日の記録を確定（2026-11-12）" },                                    // 参照なし（既存）
    { _id: "a2", refType: "session", refId: "S1", refDate: "2026-11-12" },
    { _id: "a3", refType: "onsite", refId: "C1", refDate: "2026-11-01" },
  ];
  assert.equal(R.findOnsiteConfirmation(acts, "2026-11-12"), null);
  acts.push({ _id: "a5", refType: "onsite", refId: "C1", refDate: "2026-11-12" });
  assert.equal(R.findOnsiteConfirmation(acts, "2026-11-12")._id, "a5");
  assert.equal(R.findOnsiteConfirmation(acts, "2026-11-01")._id, "a3");
  assert.equal(R.findOnsiteConfirmation(acts, ""), null);
  assert.equal(R.findOnsiteConfirmation(null, "2026-11-12"), null);
});

t("低-2: 案件統合で付け替わった確定（refId が統合元のまま）も同じ訪問日なら記録済みとみなす", () => {
  // 統合後: activities の caseId は残る案件 C1 に付け替わるが、refId は統合元 C9 のまま
  const merged = [{ _id: "m1", caseId: "C1", refType: "onsite", refId: "C9", refDate: "2026-11-12" }];
  assert.equal(R.findOnsiteConfirmation(merged, "2026-11-12")?._id, "m1");
});

t("確定で書く対応記録は既存の種別（訪問・対面）に refType/refId/refDate を付けたもの", () => {
  const summary = { subject: "当日の記録を確定（2026-11-12）", body: "介護情報基盤の当日工程: 7/7 完了" };
  const a = R.onsiteConfirmActivity({ caseId: "C1", visitDate: "2026-11-12", summary, userId: "u1", userName: "次田" });
  assert.deepEqual(a, { caseId: "C1", type: "visit", userId: "u1", userName: "次田", subject: summary.subject, body: summary.body,
    attachmentUrls: [], refType: "onsite", refId: "C1", refDate: "2026-11-12" });
  // 書いた行は二重防止の判定で見つかる
  assert.ok(R.findOnsiteConfirmation([a], "2026-11-12"));
});

// ===== 提案5: 対応記録のリンク先 =====
t("ref のある行のリンク先（伴走支援の記録→その記録、当日→当日タブの先頭）", () => {
  assert.deepEqual(R.activityRefLink({ refType: "session", refId: "S1" }),
    { label: "伴走支援の記録を開く", tab: "onsite", anchorId: "session-S1", fallbackId: "tab-onsite" });
  assert.deepEqual(R.activityRefLink({ refType: "onsite", refId: "C1" }),
    { label: "当日の記録を開く", tab: "onsite", anchorId: "tab-onsite", fallbackId: "tab-onsite" });
  assert.equal(R.sessionAnchorId("S1"), "session-S1");
});

t("ref の無い既存の行・知らない種類・refId 空にはリンクを出さない", () => {
  for (const a of [{}, { type: "visit" }, { refType: "session" }, { refType: "session", refId: "" }, { refType: "quote", refId: "Q1" }, null])
    assert.equal(R.activityRefLink(a), null);
});

// ===== 提案5: 画面の配線 =====
t("伴走支援の記録の追加・編集の対応記録に ref を付ける（追加は既存の1回の書き込みに足すだけ）", () => {
  const add = cd.slice(cd.indexOf("async function addSession("), cd.indexOf("// ===== AIアシスタント ====="));
  assert.equal((add.match(/addDoc\(collection\(db, "activities"\)/g) || []).length, 1, "追加で対応記録を2回書いている");
  assert.match(add, /refType: "session", refId: sessRef\.id/);
  const edit = cd.slice(cd.indexOf("async function saveSessionEdit("), cd.indexOf("async function deleteSession("));
  assert.match(edit, /refType: "session", refId: sessionId/);
  const del = cd.slice(cd.indexOf("async function deleteSession("), cd.indexOf("function applySessionDateDefault"));
  assert.ok(!/refType/.test(del), "削除した記録へのリンクは付けない");
});

t("伴走支援の記録のカード（表示・編集とも）にリンク先の id がある", () => {
  const n2 = (cd.match(/<div class="card" id="\$\{escHtml\(sessionAnchorId\(s\._id\)\)\}"/g) || []).length;
  assert.equal(n2, 2);
});

t("対応記録の一覧にリンクを出し、押すと当日タブへ切り替えてスクロールする", () => {
  assert.match(cd, /\$\{refLinkHtml\(a\)\}/);
  assert.match(cd, /data-ref-type="\$\{escHtml\(a\.refType\)\}" data-ref-id="\$\{escHtml\(a\.refId\)\}"/);
  const open = cd.slice(cd.indexOf("function openActivityRef("), cd.indexOf("function openActivityRef(") + 500);
  assert.match(open, /activateTab\(link\.tab\);/);
  assert.match(open, /document\.getElementById\(link\.anchorId\) \|\| document\.getElementById\(link\.fallbackId\)/);
  assert.match(cd, /closest\("\.act-ref-open"\)/);
});

t("当日タブに「当日の記録を確定」。二重防止は押した時点で読み直し、自動保存は変えない", () => {
  assert.match(sc, /\$\{cardCpEvidence\(\)\}\$\{cardOnsiteConfirm\(\)\}`;/);
  assert.match(sc, /id="sc-onsite-confirm"/);
  const body = sc.slice(sc.indexOf("async function confirmOnsite("), sc.indexOf("const confirmBtn ="));
  assert.match(body, /getDocs\(query\(collection\(db, "activities"\), where\("caseId", "==", caseId\)\)\)/);
  assert.match(body, /if \(findOnsiteConfirmation\(acts, d\)\) \{ showConfirmStatus\(`記録済み/);
  assert.ok(body.indexOf("findOnsiteConfirmation") < body.indexOf("addDoc("), "書く前に確かめる");
  assert.match(sc, /async function saveSection\(sec\) \{\n\s+await setDoc\(ref, \{ \[sec\]: state\[sec\], updatedAt: serverTimestamp\(\) \}, \{ merge: true \}\);\n\s+\}/);
  assert.match(cd, /supportChecklist\?\.setActivities\?\.\(latestActivities\);/);
});

// ===== 独立レビューの指摘（2026-11-10） =====
t("中-2: 自動で入れた値のままの欄は、訪問日を直すと新しい訪問日に置き換わる", () => {
  // 11-12 を自動で入れた欄 → 訪問日を 11-15 に直す
  assert.equal(R.dateDefault("2026-11-12", "2026-11-15", { lastAuto: "2026-11-12" }), "2026-11-15");
  assert.equal(R.perfDateDefault(null, "2026-11-12", "2026-11-15", { lastAuto: "2026-11-12" }), "2026-11-15");
});
t("中-2: 人が入れた値・未保存の欄・保存済みの performance.date は置き換えない", () => {
  assert.equal(R.dateDefault("2026-11-10", "2026-11-15", { lastAuto: "2026-11-12" }), null, "人が入れた値");
  assert.equal(R.dateDefault("2026-11-12", "2026-11-15", { lastAuto: "2026-11-12", dirty: true }), null, "未保存");
  assert.equal(R.dateDefault("2026-11-12", "2026-11-15"), null, "自動で入れていない欄");
  assert.equal(R.perfDateDefault({ date: "2026-11-12" }, "2026-11-12", "2026-11-15", { lastAuto: "2026-11-12" }), null, "保存済み");
  assert.equal(R.dateDefault("2026-11-12", "", { lastAuto: "2026-11-12" }), null, "訪問日が空になっても消さない");
});
t("中-2: 配線は両方の欄とも最後に自動で入れた値を覚えて渡す", () => {
  assert.match(sc, /lastAuto: perfAutoDate \}\);\n\s+if \(v\) \{ el\.value = v; perfAutoDate = v; \}/);
  assert.match(cd, /lastAuto: sessionAutoDate \}\);\n\s+if \(v\) \{ el\.value = v; sessionAutoDate = v; \}/);
});

t("中-1: 伴走支援の記録を追加したあと、未保存を消してから実施日の初期値を入れる", () => {
  const add = cd.slice(cd.indexOf("async function addSession("), cd.indexOf("// ===== AIアシスタント ====="));
  const clean = add.indexOf("sessionUnsaved?.clean();");
  const fill = add.indexOf("applySessionDateDefault();");
  assert.ok(clean > 0 && fill > clean, "applySessionDateDefault が clean より前にある");
  // 未保存のままなら入らない（順番が逆だと初期値が入らない理由）
  assert.equal(R.dateDefault("", "2026-11-12", { dirty: true }), null);
  assert.equal(R.dateDefault("", "2026-11-12", { dirty: false }), "2026-11-12");
});

t("中-3: 確定は画面の訪問日欄の値を使い、保存済みと違えば保存してから確定する", () => {
  assert.deepEqual(R.confirmVisitDate("2026-11-15", ""), { date: "2026-11-15", needsSave: true });
  assert.deepEqual(R.confirmVisitDate("2026-11-15", "2026-11-12"), { date: "2026-11-15", needsSave: true });
  assert.deepEqual(R.confirmVisitDate("2026-11-12", "2026-11-12"), { date: "2026-11-12", needsSave: false });
  assert.deepEqual(R.confirmVisitDate("", "2026-11-12"), { date: "", needsSave: false });
  const body = sc.slice(sc.indexOf("async function confirmOnsite("), sc.indexOf("const confirmBtn ="));
  assert.match(body, /confirmVisitDate\(\(\$\("sc-onsite-visitDate"\) \|\| \{\}\)\.value, state\.onsite\.visitDate\)/);
  assert.match(body, /if \(vd\.needsSave\) \{ state\.onsite\.visitDate = d; await saveSection\("onsite"\); \}/);
});
t("中-3: ヘッダーの訪問予定日を保存したら、当日タブの表示と初期値を更新する", () => {
  const save = cd.slice(cd.indexOf("async function saveVisitDate("), cd.indexOf("function visitSnapshot("));
  assert.ok(save.indexOf("supportChecklist?.refreshVisitDate?.();") > save.indexOf("Object.assign(currentCase, patch);"));
  assert.match(sc, /refreshVisitDate\(\) \{ fillOnsiteDefaults\(\); notifyVisitDate\(\); \}/);
});

t("低-1: 届いた performance を先に更新してから populate（実施日の初期値の判定）", () => {
  const snap = sc.slice(sc.lastIndexOf("onSnapshot(ref, (snap) => {"));
  const i = snap.indexOf("perf = data.performance || null;");
  const j = snap.indexOf("populate();");
  assert.ok(i > 0 && j > i, "perf の更新が populate より後");
});

console.log(`ok ${n} tests`);
