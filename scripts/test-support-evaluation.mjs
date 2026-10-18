// 評価・バッジ（support-evaluation.js）の単体テスト。node scripts/test-support-evaluation.mjs
import assert from "node:assert/strict";
import { suggestJudgement, buildEvaluation, buildGrant, soloWarning, badgesToCsv, isTrainer, trainerIds, ITEMS } from "../admin/js/support-evaluation.js";

const all = (g, over = {}) => Object.fromEntries(ITEMS.map((i) => [i.n, over[i.n] || g]));

// --- 判定ロジックの境界 ---
assert.equal(suggestJudgement(all("○", { 4: "◎" }), true), "independent");  // ④◎・他○・OK
assert.equal(suggestJudgement(all("◎"), true), "independent");               // 全部◎
assert.equal(suggestJudgement(all("○", { 4: "◎" }), false), "retrain");      // OJT未OK
assert.equal(suggestJudgement(all("○"), true), "retrain");                   // ④が○（◎でない）
assert.equal(suggestJudgement(all("◎", { 4: "○" }), true), "retrain");       // ④が○
assert.equal(suggestJudgement(all("◎", { 7: "△" }), true), "retrain");       // 他に△
assert.equal(suggestJudgement(all("◎", { 8: "×" }), true), "retrain");       // 他に×
assert.equal(suggestJudgement(all("◎", { 4: "△" }), true), "retrain");
assert.equal(suggestJudgement({ ...all("◎"), 3: undefined }, true), "incomplete"); // 未入力
assert.equal(suggestJudgement({}, true), "incomplete");

// --- 評価の保存対象 ---
const perf = { mode: "training", date: "2026-10-18", performerId: "a@x", performerName: "山田", trainerId: "t@x", trainerName: "次田" };
const ctx = { caseId: "C1", now: 1, actor: "次田", priorOk: false };
const input = (o = {}) => ({ scores: all("○", { 4: "◎" }), ojtResult: "ok", judgement: "independent", note: "", ...o });
const ok = buildEvaluation(input(), perf, ctx);
assert.equal(ok.evaluation.suggested, "independent");
assert.equal(ok.evaluation.overridden, false);
assert.equal(buildEvaluation(input({ judgement: "retrain" }), perf, ctx).evaluation.overridden, true);
assert.equal(buildEvaluation(input({ ojtResult: "ng" }), perf, ctx).evaluation.suggested, "retrain");
assert.equal(buildEvaluation(input({ ojtResult: "ng" }), perf, { ...ctx, priorOk: true }).evaluation.suggested, "independent"); // 過去にOK
assert.match(buildEvaluation(input({ scores: { ...all("○"), 4: undefined } }), perf, ctx).error, /4 個人情報/);
assert.match(buildEvaluation(input({ ojtResult: "" }), perf, ctx).error, /合否/);
assert.match(buildEvaluation(input({ judgement: "" }), perf, ctx).error, /総合判定/);
assert.match(buildEvaluation(input(), { ...perf, mode: "solo" }, ctx).error, /対象外/);
assert.match(buildEvaluation(input(), { ...perf, mode: "observe" }, ctx).error, /対象外/);
assert.match(buildEvaluation(input(), { ...perf, trainerId: null }, ctx).error, /対象外/);

// --- トレーナー名簿 ---
const users = [{ _id: "t@x", name: "次田 芳尚" }, { _id: "h@x", name: "蜂須賀　大策" }, { _id: "a@x", name: "山田" }];
assert.deepEqual(trainerIds(users, null).sort(), ["h@x", "t@x"]);
assert.equal(isTrainer("a@x", users, null), false);
assert.deepEqual(trainerIds(users, ["a@x"]), ["a@x"]); // 名簿ドキュメント優先

// --- バッジ付与 ---
const evs = [{ _id: "E1", traineeId: "a@x", caseId: "C1", judgement: "independent" }, { _id: "E2", traineeId: "a@x", judgement: "retrain" }];
const g = (i, c = {}) => buildGrant({ userId: "a@x", date: "2026-10-18", basis: "evaluation", evaluationId: "E1", ...i },
  { users, rosterIds: null, grants: [], evaluations: evs, actorId: "t@x", actor: "次田", now: 1, ...c });
assert.equal(g({}).grant.grantedByName, "次田 芳尚");
assert.equal(g({}).grant.caseId, "C1");
assert.match(g({}, { actorId: "a@x" }).error, /トレーナーだけ/);
assert.match(g({ evaluationId: "E2" }).error, /独り立ち可/);
assert.match(g({ evaluationId: "nope" }).error, /見つかりません/);
assert.match(g({}, { grants: [{ userId: "a@x" }] }).error, /済み/);
assert.match(g({ basis: "discretion", reason: " " }).error, /理由/);
assert.equal(g({ basis: "discretion", reason: "トレーニングなしで実施済み" }).grant.evaluationId, null);
assert.match(g({ basis: "" }).error, /根拠/);

// --- 単独警告 ---
assert.match(soloWarning({ mode: "solo", performerId: "a@x", performerName: "山田" }, []), /未付与/);
assert.equal(soloWarning({ mode: "solo", performerId: "a@x" }, [{ userId: "a@x" }]), "");
assert.equal(soloWarning({ mode: "training", performerId: "a@x" }, []), "");

// --- CSV ---
const csv = badgesToCsv([{ grantedDate: "2026-10-18", userName: "山田", userId: "a@x", grantedByName: "次田", basis: "discretion", reason: 'a,"b"' }]);
assert.match(csv, /^付与日,対象,/);
assert.match(csv, /特別裁量,"a,""b"""/);
console.log("ok");
