// 育成コースの確認テスト（learning-quiz.js）の点検。node scripts/test-learning-quiz.mjs
import assert from "node:assert/strict";
import { QUIZZES } from "../admin/js/learning-quiz.js";
import { PLEDGE_ITEMS } from "../admin/js/learning-catalog.js";

const COUNTS = { S1: 10, S2: 6, S3: 8, S4: 6 };
const ids = new Set();
const pos = {};
let total = 0;
for (const [step, n] of Object.entries(COUNTS)) {
  const z = QUIZZES[step];
  assert.ok(z, `${step} がない`);
  assert.ok(z.title, `${step} の title が空`);
  assert.equal(z.questions.length, n, `${step} の問題数`);
  assert.equal(z.pass.ratio, step === "S1" ? 1 : 0.8, `${step} の合格ライン`);
  z.questions.forEach((q, i) => {
    total++;
    assert.ok(!ids.has(q.id), `id 重複: ${q.id}`);
    ids.add(q.id);
    assert.match(q.id, new RegExp(`^${step}-\\d{2}$`), `id の形: ${q.id}`);
    assert.equal(q.id, `${step}-${String(i + 1).padStart(2, "0")}`, `id の連番: ${q.id}`);
    assert.ok(Array.isArray(q.choices) && q.choices.length >= 3 && q.choices.length <= 4, `${q.id} 選択肢の数`);
    q.choices.forEach((c) => assert.ok(typeof c === "string" && c.trim(), `${q.id} 空の選択肢`));
    assert.equal(new Set(q.choices).size, q.choices.length, `${q.id} 選択肢の重複`);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length, `${q.id} answer が範囲外`);
    for (const k of ["q", "why", "src"]) assert.ok(typeof q[k] === "string" && q[k].trim(), `${q.id} ${k} が空`);
    if (step === "S1") assert.equal(q.safety, true, `${q.id} は safety: true`);
    pos[q.answer] = (pos[q.answer] || 0) + 1;
  });
}
assert.deepEqual(Object.keys(QUIZZES).sort(), Object.keys(COUNTS).sort(), "想定外のステップがある");
// 正解の位置の偏り（どれか1つの位置が7割を超えない）
const maxShare = Math.max(...Object.values(pos)) / total;
assert.ok(maxShare <= 0.7, `正解の位置が偏っている: ${JSON.stringify(pos)}`);
// 相談先は「担当トレーナー → TM_介護情報基盤普及推進室」（問9・約束9。PM の Chat ではない）
const s109 = QUIZZES.S1.questions.find((q) => q.id === "S1-09");
assert.equal(s109.answer, 0, "S1-09 の正解は選択肢0のまま");
for (const text of [s109.choices[0], s109.why, PLEDGE_ITEMS[8]]) {
  assert.ok(!text.includes("PM"), `相談先に PM が残っている: ${text}`);
  assert.ok(text.includes("TM_介護情報基盤普及推進室"), `相談先が TM_介護情報基盤普及推進室 でない: ${text}`);
}
console.log(`ok learning-quiz（${total}問）`);
