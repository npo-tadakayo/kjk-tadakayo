// 育成コースの純粋関数（admin/js/learning-core.js）と目録（learning-catalog.js）のテスト。
// node scripts/test-learning-core.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STEPS, PRACTICE_TASKS, READY_STEPS, PLEDGE_ITEMS, findStep } from "../admin/js/learning-catalog.js";
import { findVideo } from "../admin/js/video-catalog.js";
import { QUIZZES } from "../admin/js/learning-quiz.js";
import * as L from "../admin/js/learning-core.js";
import {
  toMs, fmtDate, isVideoDone, videoPercent, nextVideoRecord, shouldSaveVideo,
  shuffledOrder, shuffleChoices, gradeQuiz, passRuleText,
  judgePractice, PRE_KEYS, ONSITE_KEYS, DOC_FIELDS,
  stepStates, reachedStep, isReadyForOjt, nextAction, canPledge,
  mergePatch, applyVideo, applyQuiz, applyPledge, applyPractice,
  listRow, evaluationLine, lastProgressAt,
} from "../admin/js/learning-core.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); throw e; } };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- テスト用の問題（本物の QUIZZES は別の担当が作成中。空でも壊れないことは下で確かめる） ----
const QZ = {
  S1: { title: "約束", pass: { ratio: 1 }, questions: [
    { id: "S1-01", q: "q1", choices: ["正", "誤", "誤"], answer: 0, why: "w1", safety: true },
    { id: "S1-02", q: "q2", choices: ["誤", "正"], answer: 1, why: "w2", safety: true },
  ] },
  S2: { title: "基盤", pass: { ratio: 0.8 }, questions: [
    ...[1, 2, 3, 4].map((i) => ({ id: `S2-0${i}`, q: "q", choices: ["a", "b", "c"], answer: 0, why: "" })),
    { id: "S2-05", q: "安全", choices: ["a", "b"], answer: 1, why: "", safety: true },
  ] },
  S3: { pass: { ratio: 0.8 }, questions: [{ id: "S3-01", q: "q", choices: ["a", "b"], answer: 0 }] },
  S4: { pass: { ratio: 0.8 }, questions: [{ id: "S4-01", q: "q", choices: ["a", "b"], answer: 0 }] },
};
const ME = { email: "tanaka@example.jp", name: "田中 花子" };
const NOW = Date.UTC(2026, 9, 24, 3, 0, 0); // 2026-10-24 12:00 JST

// ---- 目録 ----
t("7ステップ・ID・番号・動画の割当て", () => {
  assert.deepEqual(STEPS.map((s) => s.id), ["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
  assert.deepEqual(STEPS.map((s) => s.no), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(findStep("S1").videos, ["L-A", "L-B", "G-A"]);
  assert.deepEqual(findStep("S2").videos, ["G0"]);
  assert.deepEqual(findStep("S3").videos, ["G1", "G2", "G3"]);
  assert.deepEqual(findStep("S4").videos, ["U1", "U2", "U7", "U8"]);
  assert.equal(findStep("S1").pledge, true);
  assert.equal(findStep("S5").practice, true);
  assert.equal(findStep("S6").optional, true);
  assert.equal(findStep("S7").ojt, true);
  assert.deepEqual(READY_STEPS, ["S1", "S2", "S3", "S4", "S5"]);
  assert.equal(PLEDGE_ITEMS.length, 10);
  assert.match(findStep("S4").note, /旧画面/);
  for (const s of STEPS) for (const id of s.videos || []) assert.ok(findVideo(id), `${s.id}: 動画 ${id} が目録に無い`);
  for (const s of STEPS) for (const k of ["title", "desc", "time"]) assert.ok(s[k], `${s.id}: ${k} が空`);
});
t("STEP1〜4 のテストは QUIZZES のキー（本物の learning-quiz.js）", () => {
  for (const s of STEPS.filter((x) => x.quiz)) assert.ok(QUIZZES[s.quiz], `${s.id}: QUIZZES.${s.quiz} が無い`);
  assert.deepEqual(STEPS.filter((x) => x.quiz).map((x) => x.id), ["S1", "S2", "S3", "S4"]);
});
t("画面の文言に「Pマーク取得」・正式名称の法人名を書かない", () => {
  for (const f of ["../admin/js/learning-catalog.js", "../admin/js/learning-core.js", "../admin/js/learning.js", "../admin/learning.html"]) {
    const s = src(f);
    assert.ok(!/Pマーク取得|プライバシーマーク取得/.test(s), `${f} に「Pマーク取得」`);
    assert.ok(!/特定非営利活動法人/.test(s), `${f} に正式名称の法人名`);
  }
});

// ---- 日時 ----
t("toMs は数値・Date・Timestamp・文字列を読む", () => {
  assert.equal(toMs(5), 5);
  assert.equal(toMs(new Date(7)), 7);
  assert.equal(toMs({ toMillis: () => 9 }), 9);
  assert.equal(toMs({ seconds: 2, nanoseconds: 0 }), 2000);
  assert.equal(toMs("2026-10-24"), Date.UTC(2026, 9, 23, 15)); // JST の0時
  assert.equal(toMs(null), null); assert.equal(toMs(""), null); assert.equal(toMs("x"), null); assert.equal(toMs(NaN), null);
  assert.equal(fmtDate("2026-10-24"), "2026/10/24");
  assert.equal(fmtDate(NOW), "2026/10/24");
  assert.equal(fmtDate(null), "");
});

// ---- 動画 ----
t("見たかどうか（最大位置が長さの9割以上）", () => {
  assert.equal(isVideoDone(null), false);
  assert.equal(isVideoDone({ maxPos: 89, duration: 100 }), false);
  assert.equal(isVideoDone({ maxPos: 90, duration: 100 }), true);
  assert.equal(isVideoDone({ maxPos: 0, duration: 0, doneAt: 1 }), true); // 済の日時があれば済
  assert.equal(videoPercent({ maxPos: 45, duration: 100 }), 45);
  assert.equal(videoPercent({ maxPos: 200, duration: 100 }), 100);
  assert.equal(videoPercent(undefined), 0);
});
t("再生位置の記録は伸びるだけ・9割で doneAt が入る・戻さない", () => {
  let r = nextVideoRecord(null, 30, 200, 1);
  assert.deepEqual(r.rec, { maxPos: 30, duration: 200, doneAt: null });
  assert.equal(r.changed, true); assert.equal(r.justDone, false);
  r = nextVideoRecord(r.rec, 10, 200, 2); // 巻き戻しても最大位置は減らない
  assert.equal(r.rec.maxPos, 30); assert.equal(r.changed, false);
  r = nextVideoRecord(r.rec, 180, 200, 3);
  assert.equal(r.rec.doneAt, 3); assert.equal(r.justDone, true);
  r = nextVideoRecord(r.rec, 200, 200, 4); // 済の日時は最初のまま
  assert.equal(r.rec.doneAt, 3); assert.equal(r.justDone, false); assert.equal(r.rec.maxPos, 200);
  assert.equal(nextVideoRecord(null, 5, NaN, 1).changed, false);   // 長さが読めない（読み込み前）
  assert.equal(nextVideoRecord(null, 5, Infinity, 1).changed, false);
  assert.equal(nextVideoRecord({ maxPos: 1, duration: 10 }, -1, 10, 1).changed, false);
  assert.equal(nextVideoRecord(null, 999, 100, 1).rec.maxPos, 100); // 長さで頭打ち
});
t("保存しすぎない（10秒進み・5秒以上あける。済・一時停止は保存）", () => {
  const rec = { maxPos: 25, duration: 100, doneAt: null };
  assert.equal(shouldSaveVideo({ maxPos: 20, at: 0 }, rec, { now: 10000 }), false); // 5秒しか進んでいない
  assert.equal(shouldSaveVideo({ maxPos: 10, at: 8000 }, rec, { now: 10000 }), false); // 2秒しかあいていない
  assert.equal(shouldSaveVideo({ maxPos: 10, at: 0 }, rec, { now: 10000 }), true);
  assert.equal(shouldSaveVideo({ maxPos: 24, at: 9999 }, rec, { justDone: true, now: 10000 }), true);
  assert.equal(shouldSaveVideo({ maxPos: 24, at: 9999 }, rec, { force: true, now: 10000 }), true);
  assert.equal(shouldSaveVideo({ maxPos: 25, at: 0 }, rec, { force: true, now: 10000 }), false); // 進んでいない
  assert.equal(shouldSaveVideo(null, null, {}), false);
});

// ---- テスト（採点・並べ替え） ----
t("選択肢の並べ替えは乱数で決まり、元の番号を保つ", () => {
  assert.deepEqual(shuffledOrder(3, () => 0), [1, 2, 0]);
  assert.deepEqual(shuffledOrder(3, () => 0.999), [0, 1, 2]);
  const seq = [0.5, 0.1]; let i = 0;
  const o = shuffledOrder(3, () => seq[i++]);
  assert.deepEqual([...o].sort(), [0, 1, 2]);
  const ch = shuffleChoices(QZ.S1.questions[0], () => 0);
  assert.deepEqual(ch.map((c) => c.index), [1, 2, 0]);
  assert.equal(ch.find((c) => c.index === 0).text, "正");
  assert.deepEqual(shuffleChoices({}, Math.random), []);
  assert.deepEqual(shuffledOrder(0), []);
});
t("問題が空なら「準備中」で合格にしない（本物の QUIZZES が空でも壊れない）", () => {
  for (const k of ["S1", "S2", "S3", "S4"]) {
    const r = gradeQuiz({ ...QUIZZES[k], questions: [] }, {});
    assert.equal(r.status, "preparing"); assert.equal(r.passed, false);
  }
  assert.equal(gradeQuiz(undefined, undefined).status, "preparing");
  assert.equal(gradeQuiz({ questions: null }, {}).passed, false);
});
t("採点: 8割で合格・安全の問題は全問正解が必要・未回答は合格にしない", () => {
  const all = { "S2-01": 0, "S2-02": 0, "S2-03": 0, "S2-04": 0, "S2-05": 1 };
  let r = gradeQuiz(QZ.S2, all);
  assert.equal(r.status, "graded"); assert.equal(r.passed, true); assert.equal(r.score, 100);
  r = gradeQuiz(QZ.S2, { ...all, "S2-01": 1 }); // 4/5=80% → 合格
  assert.equal(r.score, 80); assert.equal(r.passed, true);
  r = gradeQuiz(QZ.S2, { ...all, "S2-01": 1, "S2-02": 2 }); // 60% → 不合格
  assert.equal(r.passed, false);
  r = gradeQuiz(QZ.S2, { ...all, "S2-05": 0 }); // 80% でも安全の問題を間違えたら不合格
  assert.equal(r.score, 80); assert.equal(r.passed, false); assert.deepEqual(r.safetyMissed, ["S2-05"]);
  r = gradeQuiz(QZ.S2, { "S2-01": 0 });
  assert.equal(r.status, "incomplete"); assert.equal(r.passed, false); assert.equal(r.unanswered.length, 4);
  r = gradeQuiz(QZ.S1, { "S1-01": 0, "S1-02": 0 }); // ratio 1 は全問正解
  assert.equal(r.passed, false); assert.equal(r.score, 50);
  assert.equal(gradeQuiz(QZ.S1, { "S1-01": "0", "S1-02": "1" }).passed, true); // 画面の値（文字列）でもよい
  assert.equal(r.results[1].why, "w2");
  assert.equal(passRuleText(QZ.S1), "全問正解で合格");
  assert.equal(passRuleText(QZ.S2), "80%以上で合格（個人情報・安全の問題は全問正解が必要）");
  assert.equal(passRuleText(QZ.S3), "80%以上で合格");
  assert.equal(passRuleText({ pass: {} }), "80%以上で合格");
});

// ---- 練習課題 ----
const CID = "practice-mine-uid-A";
const fullPre = Object.fromEntries(PRE_KEYS.map((k) => [k, { status: "ok" }]));
const fullOnsite = { steps: Object.fromEntries(ONSITE_KEYS.map((k) => [k, { done: true }])) };
const fullDocs = Object.fromEntries(DOC_FIELDS.map((f) => [f, true]));
const practiceInput = (over = {}) => ({
  email: ME.email,
  cases: [{ _id: CID, assignedUserId: ME.email, status: 8, visitDate: "2026-11-09" }, { _id: "other", assignedUserId: "x@example.jp", status: 13, visitDate: "2026-11-01" }],
  activities: [{ caseId: CID, type: "memo" }, { caseId: CID, type: "phone_out" }],
  supportChecklists: { [CID]: { pre: fullPre, onsite: fullOnsite, performance: { date: "2026-11-09", performerId: ME.email, mode: "training" } } },
  documentChecklists: { [CID]: fullDocs },
  ...over,
});
t("課題の判定に使うフィールドは実物（support-checklist.js・case-detail.js）と同じ", () => {
  const sc = src("../admin/js/support-checklist.js");
  const block = (name) => sc.slice(sc.indexOf(`const ${name} = [`), sc.indexOf("];", sc.indexOf(`const ${name} = [`)));
  assert.deepEqual([...block("PRE_ITEMS").matchAll(/key: "([^"]+)"/g)].map((m) => m[1]), PRE_KEYS);
  assert.deepEqual([...block("ONSITE_STEPS").matchAll(/key: "([^"]+)"/g)].map((m) => m[1]), ONSITE_KEYS);
  assert.match(sc, /data-path="steps\.\$\{item\.key\}\.done"/);
  assert.match(sc, /\$\{item\.key\}\.status/);
  assert.match(sc, /perf = data\.performance \|\| null;/);
  const cd = src("../admin/js/case-detail.js");
  const fn = cd.slice(cd.indexOf("function renderDocumentChecklist"), cd.indexOf("if (cl?.bankAccountInfo)"));
  assert.deepEqual([...fn.matchAll(/"chk-[a-z]+": "([^"]+)"/g)].map((m) => m[1]), DOC_FIELDS);
  assert.match(cd, /visitDate: v, updatedAt/);
  const html = src("../admin/case-detail.html");
  for (const v of ["phone_in", "phone_out", "email_in", "email_out"]) assert.match(html, new RegExp(`<option value="${v}">`));
  // 練習用の案件に最初から入るのは memo（数えない）／担当は assignedUserId=メール
  const mode = src("../admin/js/mode.js");
  assert.match(mode, /type: "memo", occurredAt: now/);
  assert.match(mode, /assignedUserId: email/);
});
t("6つの課題が全部できている", () => {
  const r = judgePractice(practiceInput());
  assert.deepEqual(r.items, { firstContact: true, visitDate: true, preCheck: true, onsiteDocs: true, performance: true, status: true });
  assert.equal(r.cases, 1); assert.equal(r.done, 6); assert.equal(r.total, 6);
});
t("何もしていない練習用の案件（最初のメモだけ・伴走支援待ち）は全部まだ", () => {
  const r = judgePractice({ email: ME.email, cases: [{ _id: CID, assignedUserId: ME.email, status: 7 }], activities: [{ caseId: CID, type: "memo" }] });
  assert.equal(r.done, 0);
  assert.ok(Object.values(r.items).every((v) => v === false));
});
t("課題ごとの欠け", () => {
  const sc = practiceInput().supportChecklists[CID];
  const without = (k) => { const pre = { ...fullPre }; delete pre[k]; return pre; };
  assert.equal(judgePractice(practiceInput({ activities: [{ caseId: CID, type: "memo" }, { caseId: "other", type: "phone_in" }] })).items.firstContact, false);
  assert.equal(judgePractice(practiceInput({ cases: [{ _id: CID, assignedUserId: ME.email, status: 8, visitDate: null }] })).items.visitDate, false);
  assert.equal(judgePractice(practiceInput({ supportChecklists: { [CID]: { ...sc, pre: without("pc") } } })).items.preCheck, false);
  assert.equal(judgePractice(practiceInput({ supportChecklists: { [CID]: { ...sc, pre: { ...fullPre, cert: { status: "", memo: "x" } } } } })).items.preCheck, false);
  assert.equal(judgePractice(practiceInput({ documentChecklists: { [CID]: { ...fullDocs, receiptReady: false } } })).items.onsiteDocs, false);
  assert.equal(judgePractice(practiceInput({ supportChecklists: { [CID]: { ...sc, onsite: { steps: { ...fullOnsite.steps, userNotice: { done: false } } } } } })).items.onsiteDocs, false);
  assert.equal(judgePractice(practiceInput({ supportChecklists: { [CID]: { ...sc, performance: { date: "2026-11-09", mode: "solo" } } } })).items.performance, false);
  for (const [s, ok] of [[7, false], [8, true], [9, true], [13, true], [4, false], [3, false]]) {
    assert.equal(judgePractice(practiceInput({ cases: [{ _id: CID, assignedUserId: ME.email, status: s }] })).items.status, ok, `status ${s}`);
  }
  // 他人の担当の案件は見ない・メールの大文字小文字は区別しない
  assert.equal(judgePractice(practiceInput({ email: "other@example.jp" })).cases, 0);
  assert.equal(judgePractice(practiceInput({ email: "TANAKA@example.jp" })).cases, 1);
  assert.equal(judgePractice({}).done, 0);
  assert.equal(judgePractice(null).done, 0);
});

// ---- 進み具合の組み立て ----
// STEP1〜4 を全部済にした進み具合（ステップの順に作る）
function progressThrough(lastStep) {
  let p = null;
  for (const s of STEPS) {
    if (s.no > lastStep || s.optional || s.ojt) continue;
    for (const id of s.videos || []) p = applyVideo(p, ME, id, { maxPos: 100, duration: 100, doneAt: NOW }, NOW, QZ).next;
    if (s.quiz) {
      const ans = Object.fromEntries(QZ[s.quiz].questions.map((q) => [q.id, q.answer]));
      p = applyQuiz(p, ME, s.quiz, gradeQuiz(QZ[s.quiz], ans), NOW, QZ).next;
    }
    if (s.pledge) p = applyPledge(p, ME, NOW, QZ).next;
    if (s.practice) p = applyPractice(p, ME, judgePractice(practiceInput()), NOW, QZ).next;
  }
  return p;
}
t("はじめて（文書なし）: STEP1 がいまここ・次は動画「伴走支援者になるまで」", () => {
  const st = stepStates(null, {}, QZ);
  assert.deepEqual(st.map((s) => s.state), ["current", "todo", "todo", "todo", "todo", "optional", "todo"]);
  assert.equal(reachedStep(st), 0);
  assert.equal(isReadyForOjt(null, QZ), false);
  assert.equal(nextAction(null, {}, QZ), "STEP1「はじめに」：動画「はじめに 伴走支援者になるまで」を最後まで見る");
});
t("動画を入れると名前・始めた日・最後に進んだ日が付く／他の動画を消さない", () => {
  const a = applyVideo(null, ME, "L-A", { maxPos: 10, duration: 150, doneAt: null }, NOW, QZ);
  assert.deepEqual(a.patch, { videos: { "L-A": { maxPos: 10, duration: 150, doneAt: null } }, lastAt: NOW, name: ME.name, startedAt: NOW });
  const b = applyVideo(a.next, ME, "L-B", { maxPos: 5, duration: 230, doneAt: null }, NOW + 1, QZ);
  assert.equal(b.patch.startedAt, undefined); // 始めた日は最初のまま（patch に入れない）
  assert.equal(b.patch.name, undefined);
  assert.deepEqual(Object.keys(b.next.videos), ["L-A", "L-B"]);
  assert.equal(b.next.startedAt, NOW);
  assert.deepEqual(applyVideo(a.next, ME, "", null, NOW, QZ).patch, null);
});
t("テストの記録: 最高点を残す・回数を数える・最初に合格した日時を残す", () => {
  const bad = gradeQuiz(QZ.S2, { "S2-01": 0, "S2-02": 1, "S2-03": 1, "S2-04": 0, "S2-05": 1 }); // 60%
  const good = gradeQuiz(QZ.S2, { "S2-01": 0, "S2-02": 0, "S2-03": 0, "S2-04": 0, "S2-05": 1 }); // 100%
  let r = applyQuiz(null, ME, "S2", bad, 1, QZ);
  assert.deepEqual(r.next.quizzes.S2, { best: 60, lastScore: 60, attempts: 1, lastAt: 1, passedAt: null });
  r = applyQuiz(r.next, ME, "S2", good, 2, QZ);
  assert.deepEqual(r.next.quizzes.S2, { best: 100, lastScore: 100, attempts: 2, lastAt: 2, passedAt: 2 });
  r = applyQuiz(r.next, ME, "S2", bad, 3, QZ);
  assert.deepEqual(r.next.quizzes.S2, { best: 100, lastScore: 60, attempts: 3, lastAt: 3, passedAt: 2 }); // 合格は消えない
  assert.equal(applyQuiz(r.next, ME, "S2", gradeQuiz(QZ.S2, {}), 4, QZ).patch, null); // 未回答は記録しない
  assert.equal(applyQuiz(r.next, ME, "S2", gradeQuiz({ questions: [] }, {}), 4, QZ).patch, null); // 準備中も記録しない
});
t("約束は動画3本＋テスト合格のあと・2回押しても最初の日時", () => {
  let p = null;
  assert.equal(canPledge(p, QZ), false);
  assert.ok(applyPledge(p, ME, NOW, QZ).error);
  for (const id of ["L-A", "L-B", "G-A"]) p = applyVideo(p, ME, id, { maxPos: 95, duration: 100, doneAt: 5 }, NOW, QZ).next;
  assert.equal(canPledge(p, QZ), false);
  assert.match(nextAction(p, {}, QZ), /^STEP1「はじめに」：確認テストを受ける（全問正解で合格）$/);
  p = applyQuiz(p, ME, "S1", gradeQuiz(QZ.S1, { "S1-01": 0, "S1-02": 1 }), NOW, QZ).next;
  assert.equal(canPledge(p, QZ), true);
  assert.equal(nextAction(p, {}, QZ), "STEP1「はじめに」：10の約束を読んで「約束します」を押す");
  const r = applyPledge(p, ME, NOW + 5, QZ);
  assert.equal(r.patch.pledgeAt, NOW + 5);
  assert.equal(applyPledge(r.next, ME, NOW + 9, QZ).patch, null);
  assert.equal(stepStates(r.next, {}, QZ)[0].state, "done");
  assert.equal(stepStates(r.next, {}, QZ)[0].at, NOW + 5);
});
t("問題が準備中のあいだは STEP を済にしない・次にやることは「準備中」", () => {
  let p = null;
  for (const id of ["L-A", "L-B", "G-A"]) p = applyVideo(p, ME, id, { maxPos: 95, duration: 100, doneAt: 5 }, NOW, QUIZZES).next;
  const emptyQ = { S1: { ...QUIZZES.S1, questions: [] } };
  assert.equal(stepStates(p, {}, emptyQ)[0].state, "current");
  assert.equal(nextAction(p, {}, emptyQ), "STEP1「はじめに」：確認テストは準備中です。できしだい受けてください");
});
t("STEP3 の途中: 動画1本見たところ", () => {
  let p = progressThrough(2);
  p = applyVideo(p, ME, "G1", { maxPos: 618, duration: 618, doneAt: NOW }, NOW, QZ).next;
  p = applyVideo(p, ME, "G2", { maxPos: 100, duration: 350, doneAt: null }, NOW, QZ).next;
  const st = stepStates(p, {}, QZ);
  assert.deepEqual(st.map((s) => s.state), ["done", "done", "current", "todo", "todo", "optional", "todo"]);
  assert.equal(st[2].videos[1].pct, 29);
  assert.equal(reachedStep(st), 2);
  assert.equal(nextAction(p, {}, QZ), "STEP3「伴走支援の手順」：動画「PART2 アプリ＋ICカードリーダー編」を最後まで見る");
  assert.deepEqual(evaluationLine(p, null, QZ), { text: "育成コース：STEP2まで済。OJTの前の学習（STEP1〜5）が済んでいません（評価の保存はできます）", warn: true });
});
t("練習の判定: 一度できた課題は消えない・全部で STEP5 済・OJTに入れます（readyForOjtAt は1回だけ）", () => {
  let p = progressThrough(4);
  assert.match(nextAction(p, {}, QZ), /^STEP5「練習モードで実技」：練習モードで課題をこなして「判定する」を押す（残り6つ）$/);
  const part = judgePractice(practiceInput({ documentChecklists: {} })); // 書類だけまだ
  let r = applyPractice(p, ME, part, NOW, QZ);
  assert.equal(r.next.practice.items.onsiteDocs, false);
  assert.equal(r.next.practice.passedAt, null);
  assert.equal(r.patch.readyForOjtAt, undefined);
  assert.match(nextAction(r.next, {}, QZ), /残り1つ/);
  // ログアウトで練習データが消えたあと（何もない）に判定しても、できた課題は残る
  r = applyPractice(r.next, ME, judgePractice({ email: ME.email, cases: [] }), NOW + 1, QZ);
  assert.equal(r.next.practice.items.firstContact, true);
  assert.equal(r.next.practice.cases, 0);
  r = applyPractice(r.next, ME, judgePractice(practiceInput()), NOW + 2, QZ);
  assert.equal(r.next.practice.passedAt, NOW + 2);
  assert.equal(r.patch.readyForOjtAt, NOW + 2);
  assert.equal(isReadyForOjt(r.next, QZ), true);
  const st = stepStates(r.next, {}, QZ);
  assert.deepEqual(st.map((s) => s.state), ["done", "done", "done", "done", "done", "optional", "current"]);
  assert.equal(reachedStep(st), 5);
  assert.equal(nextAction(r.next, {}, QZ), "OJTに入れます。トレーナーに連絡して、支援先でのOJT（評価シート）の日程を決めてください。");
  assert.deepEqual(evaluationLine(r.next, null, QZ), { text: "育成コース：STEP5まで済（OJTに入れます）", warn: false });
  const again = applyVideo(r.next, ME, "U9", { maxPos: 1, duration: 10, doneAt: null }, NOW + 3, QZ);
  assert.equal(again.patch.readyForOjtAt, undefined);
  assert.equal(again.next.readyForOjtAt, NOW + 2);
});
t("バッジ付与済み: STEP7 済・独り立ち", () => {
  const p = progressThrough(5);
  const badge = { userId: ME.email, grantedDate: "2026-11-10", grantedByName: "山田 太郎" };
  const st = stepStates(p, { badge }, QZ);
  assert.equal(st[6].state, "done");
  assert.equal(st[6].at, toMs("2026-11-10"));
  assert.equal(reachedStep(st), 7);
  assert.equal(nextAction(p, { badge }, QZ), "独り立ちしました。伴走支援者として、単独で伴走支援を担当できます。");
  assert.deepEqual(evaluationLine(p, badge, QZ), { text: "育成コース：独り立ち（バッジ付与 2026/11/10）", warn: false });
  // 学習の記録が無くてもバッジ（特別裁量など）があれば独り立ち
  assert.equal(listRow(null, { badge, email: ME.email, name: ME.name }, QZ).stepLabel, "独り立ち");
});
t("評価シートの1行（記録なし）", () => {
  const r = evaluationLine(null, null, QZ);
  assert.equal(r.warn, true);
  assert.match(r.text, /まだ始めていません/);
  assert.match(r.text, /評価の保存はできます/);
  assert.match(evaluationLine({ videos: {} }, null, QZ).text, /STEP1の途中/);
});
t("トレーナーの一覧の1行", () => {
  const p = progressThrough(5);
  const row = listRow(p, { email: ME.email }, QZ);
  assert.equal(row.name, ME.name);
  assert.equal(row.stepLabel, "STEP7　OJT（スキルチェック）");
  assert.equal(row.ready, true); assert.equal(row.reached, 5); assert.equal(row.lastAt, NOW);
  const none = listRow(null, { email: "new@example.jp", name: "新人 さん" }, QZ);
  assert.equal(none.stepLabel, "まだ始めていません"); assert.equal(none.started, false); assert.equal(none.name, "新人 さん");
  assert.equal(none.lastAt, null);
  assert.equal(lastProgressAt({ quizzes: { S1: { lastAt: 7 } }, videos: { x: { doneAt: 9 } } }), 9);
  assert.equal(lastProgressAt({ updatedAt: { toMillis: () => 11 } }), 11);
});
t("mergePatch は入れ子の map を重ねる（Firestore の merge と同じ）・配列や Timestamp は置き換え", () => {
  const ts = { toMillis: () => 1 };
  const m = mergePatch({ a: { x: 1, y: 2 }, b: [1], c: ts, d: 1 }, { a: { y: 3 }, b: [2], c: { toMillis: () => 2 } });
  assert.deepEqual(m.a, { x: 1, y: 3 }); assert.deepEqual(m.b, [2]); assert.equal(m.c.toMillis(), 2); assert.equal(m.d, 1);
  assert.deepEqual(mergePatch(null, { a: 1 }), { a: 1 });
});

// ---- 画面のつなぎ（ソースの点検） ----
t("learning.js は本番DBに進み具合を書き、練習DBは判定で読むだけ", () => {
  const js = src("../admin/js/learning.js");
  assert.match(js, /from "\/js\/fs\.js"/);
  assert.ok(!js.includes("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"), "Firestore を CDN から直接読んでいる");
  assert.match(js, /getProdFirestore\(app\)/);
  assert.match(js, /doc\(prod, "learningProgress", /);
  assert.ok(!/doc\(db, "learningProgress"/.test(js), "learningProgress を練習DB側で開いている");
  assert.match(js, /\{ merge: true \}/);
  assert.match(js, /gateRole\(/); assert.match(js, /applyViewerMode\(/);
  assert.match(js, /mountVideo\(/);
  assert.match(js, /ログアウトの前に/);
  assert.ok(!/localStorage/.test(js), "localStorage を使っている");
  const html = src("../admin/learning.html");
  assert.match(html, /<script src="\/js\/learning\.js" type="module"><\/script>/);
  assert.match(html, /<script src="\/js\/sidebar\.js"><\/script>/);
  assert.match(html, /href="\/css\/crm\.css"/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  const sb = src("../admin/js/sidebar.js");
  const help = sb.slice(sb.indexOf("var HELP = ["), sb.indexOf("];", sb.indexOf("var HELP = [")));
  assert.match(help, /\["\/learning\.html", "ti-school", "育成コース"\],\s*\n\s*\["\/videos\.html"/);
});
t("評価シート・バッジ台帳・マニュアル・ルールのつなぎ", () => {
  const sc = src("../admin/js/support-checklist.js");
  assert.match(sc, /evaluationLine\(/);
  assert.match(sc, /"learningProgress"/);
  assert.match(sc, /getProdFirestore\(/);
  const bj = src("../admin/js/badges.js");
  assert.match(bj, /u\.role !== "trainee"/);
  assert.match(bj, /ロールを「スタッフ」に変えてください/);
  const man = src("../admin/manual.html");
  assert.match(man, /id="s-learning"/);
  assert.match(man, /href="\/learning\.html"/);
  const rules = src("../firestore.rules");
  assert.match(rules, /match \/learningProgress\/\{email\}/);
  assert.match(rules, /"appConfig", "_notifyLog", "learningProgress"\]/);
});

t("保存は書けてから画面に入れる・古い動画の読み込みを捨てる（Codex 指摘 2026-10-24）", () => {
  const js = src("../admin/js/learning.js");
  const body = js.slice(js.indexOf("async function save("), js.indexOf("function states()"));
  assert.ok(body.indexOf("runTransaction(") > 0 && body.indexOf("runTransaction(") < body.indexOf("progress = L.mergePatch(merged"), "保存の前に progress を書き換えている");
  assert.match(body, /L\.guardPatch\(cur, r\.patch\)/);
  assert.ok(!/progress = r\.next/.test(body), "失敗しても r.next を入れている");
  assert.match(js, /const seq = \+\+playSeq;/);
  assert.match(js, /if \(seq !== playSeq\)/);
  assert.match(js, /if \(!ok\) \{ p\.last = prev; return; \}/);
});

t("guardPatch: 古いタブからの保存で達成が巻き戻らない", () => {
  const server = { quizzes: { S1: { best: 100, attempts: 2, passedAt: 1000, lastScore: 100 } }, videos: { "L-A": { maxPos: 150, duration: 150, doneAt: 900 } },
    practice: { items: { firstContact: true, visitDate: true }, passedAt: null }, pledgeAt: 1100, startedAt: 500 };
  const stale = { quizzes: { S1: { best: 60, attempts: 1, passedAt: null, lastScore: 60, lastAt: 2000 } }, videos: { "L-A": { maxPos: 30, duration: 150, doneAt: null } },
    practice: { items: { firstContact: false, visitDate: false, preCheck: true }, checkedAt: 2000, passedAt: null }, startedAt: 1900, lastAt: 2000 };
  const g = L.guardPatch(server, stale);
  assert.equal(g.quizzes.S1.best, 100); assert.equal(g.quizzes.S1.passedAt, 1000); assert.equal(g.quizzes.S1.attempts, 3); assert.equal(g.quizzes.S1.lastScore, 60);
  assert.equal(g.videos["L-A"].maxPos, 150); assert.equal(g.videos["L-A"].doneAt, 900);
  assert.equal(g.practice.items.firstContact, true); assert.equal(g.practice.items.preCheck, true);
  assert.equal(g.pledgeAt, 1100); assert.equal(g.startedAt, 500); assert.equal(g.lastAt, 2000);
  // サーバーが空なら patch のまま（はじめての保存）
  const first = L.guardPatch({}, { quizzes: { S2: { best: 83, attempts: 1, passedAt: 3000 } }, startedAt: 3000 });
  assert.equal(first.quizzes.S2.passedAt, 3000); assert.equal(first.quizzes.S2.attempts, 1); assert.equal(first.startedAt, 3000);
  assert.ok(!("pledgeAt" in first));
});

console.log(`test-learning-core: ${n} 件 OK`);
