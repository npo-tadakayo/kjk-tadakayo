// トレーナー認定の判定（admin/js/trainer-rules.js）と結線のテスト。node scripts/test-trainer-rules.mjs
// 計画と決定: 06_介護情報基盤事業/docs/トレーナーコース_計画_20261110.md §7（ト1〜ト8）
// Firestore には触れない（Callable を実際に動かす権限のテストは scripts/test-trainer-emu.mjs）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as T from "../admin/js/trainer-rules.js";
import * as SE from "../admin/js/support-evaluation.js";
import { STATUS_ORDER as CONST_ORDER } from "../admin/js/constants.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const NOW = Date.parse("2026-11-12T03:00:00Z"); // JST 12:00

t("条件: 既定値・壊れた値は既定に戻す", () => {
  assert.deepEqual(T.normalizeCriteria(null), { supportCount: 10, talkCount: 1, combine: "and", requireCourse: true });
  assert.deepEqual(T.normalizeCriteria({ supportCount: "5", talkCount: -1, combine: "x", requireCourse: "yes" }),
    { supportCount: 5, talkCount: 1, combine: "and", requireCourse: true });
  assert.deepEqual(T.normalizeCriteria({ supportCount: 3, talkCount: 0, combine: "or", requireCourse: false }),
    { supportCount: 3, talkCount: 0, combine: "or", requireCourse: false });
  assert.match(T.criteriaText(null), /伴走支援 10件 かつ 登壇（または類似のもの）1回／トレーナーコースの修了が前提/);
  assert.match(T.criteriaText({ combine: "or", requireCourse: false }), /または/);
});

t("条件: 入力の検証", () => {
  assert.ok(T.validateCriteriaInput({ supportCount: 10, talkCount: 1, combine: "and", requireCourse: true }).criteria);
  assert.match(T.validateCriteriaInput({ supportCount: 1.5, talkCount: 1, combine: "and", requireCourse: true }).error, /整数/);
  assert.match(T.validateCriteriaInput({ supportCount: 101, talkCount: 1, combine: "and", requireCourse: true }).error, /0〜100/);
  assert.match(T.validateCriteriaInput({ supportCount: 1, talkCount: 1, combine: "xor", requireCourse: true }).error, /組み合わせ/);
  assert.match(T.validateCriteriaInput({ supportCount: 1, talkCount: 1, combine: "or", requireCourse: "true" }).error, /前提/);
  assert.match(T.validateCriteriaInput({ supportCount: 0, talkCount: 0, combine: "or", requireCourse: false }).error, /両方を 0/);
});

t("ステータス順は constants.js と同じ", () => {
  assert.deepEqual(T.STATUS_ORDER, CONST_ORDER);
  assert.equal(T.statusReached(8), true);
  assert.equal(T.statusReached(13), true);
  assert.equal(T.statusReached(7), false);
  assert.equal(T.statusReached(4), false); // 失注
  assert.equal(T.statusReached("9"), true);
  assert.equal(T.statusReached(undefined), false);
});

t("伴走支援の件数（ト3）: 案件（事業所）単位・実施済以降・単独と見守り付き・見学は数えない", () => {
  const A = "a@tadakayo.jp";
  const cases = [
    { _id: "c1", status: 8, officeId: "o1" },
    { _id: "c2", status: 13, officeId: "o1" },  // 同じ事業所の2件目 → 数えない
    { _id: "c3", status: 9, officeId: "o2" },   // training → 数える
    { _id: "c4", status: 7, officeId: "o3" },   // 実施済の前 → 数えない
    { _id: "c5", status: 4, officeId: "o4" },   // 失注 → 数えない
    { _id: "c6", status: 10, officeId: "o5" },  // 見学 → 数えない
    { _id: "c7", status: 12, officeId: "o6" },  // 別の人 → 数えない
    { _id: "c8", status: 8, officeId: "" },     // officeId なし → 案件ごとに1件
    { _id: "c9", status: 8 },                   // officeId なし → 案件ごとに1件
    { _id: "c10", status: 11, officeId: "o7" }, // performance なし
  ];
  const cl = {
    c1: { performance: { performerId: A, mode: "solo" } },
    c2: { performance: { performerId: A, mode: "solo" } },
    c3: { performance: { performerId: "A@tadakayo.jp", mode: "training", trainerId: "t@tadakayo.jp" } },
    c4: { performance: { performerId: A, mode: "solo" } },
    c5: { performance: { performerId: A, mode: "solo" } },
    c6: { performance: { performerId: A, mode: "observe" } },
    c7: { performance: { performerId: "b@tadakayo.jp", mode: "solo" } },
    c8: { performance: { performerId: A, mode: "solo" } },
    c9: { performance: { performerId: A, mode: "training" } },
    c10: {},
  };
  const r = T.countSupport(A, cases, cl);
  assert.equal(r.count, 4);
  assert.deepEqual(r.caseIds, ["c1", "c3", "c8", "c9"]);
  assert.equal(T.countSupport("b@tadakayo.jp", cases, cl).count, 1);
  assert.equal(T.countSupport("z@tadakayo.jp", cases, cl).count, 0);
  assert.equal(T.countSupport(A, [], cl).count, 0);
  assert.equal(T.countSupport(A, null, null).count, 0);
  assert.deepEqual(T.countSupportAll(cases, cl), { "a@tadakayo.jp": 4, "b@tadakayo.jp": 1 });
  // トレーナーとして立ち会った分は、立ち会った人（trainerId）の件数にはならない（実施者だけ）
  assert.equal(T.countSupport("t@tadakayo.jp", cases, cl).count, 0);
});

t("登壇の件数: 取り消した記録は数えない", () => {
  const talks = [{ userId: "a@x" }, { userId: "A@x" }, { userId: "a@x", voided: true }, { userId: "b@x" }, null];
  assert.equal(T.countTalks("a@x", talks), 2);
  assert.equal(T.countTalks("b@x", talks), 1);
  assert.equal(T.countTalks("c@x", talks), 0);
});

t("判定（ト1・ト5）: かつ／または・コースの前提", () => {
  const c = T.DEFAULT_CRITERIA;
  let j = T.judge({ supportCount: 10, talkCount: 1, courseDone: true }, c);
  assert.equal(j.meets, true); assert.equal(j.label, "候補");
  j = T.judge({ supportCount: 7, talkCount: 0, courseDone: false }, c);
  assert.equal(j.meets, false);
  assert.deepEqual(j.missing, ["伴走支援 あと3件", "登壇 あと1回", "トレーナーコースの修了"]);
  assert.equal(j.label, "あと：伴走支援 あと3件・登壇 あと1回・トレーナーコースの修了");
  j = T.judge({ supportCount: 12, talkCount: 0, courseDone: true }, c);
  assert.equal(j.meets, false); assert.deepEqual(j.missing, ["登壇 あと1回"]);
  j = T.judge({ supportCount: 12, talkCount: 0, courseDone: true }, { ...c, combine: "or" });
  assert.equal(j.meets, true);
  j = T.judge({ supportCount: 2, talkCount: 0, courseDone: true }, { ...c, combine: "or" });
  assert.deepEqual(j.missing, ["伴走支援 あと8件 または 登壇 あと1回"]);
  j = T.judge({ supportCount: 10, talkCount: 1, courseDone: false }, { ...c, requireCourse: false });
  assert.equal(j.meets, true);
  j = T.judge({ supportCount: 10, talkCount: 1, courseDone: false }, null); // 条件の文書が無い＝既定（コース必須）
  assert.equal(j.meets, false); assert.deepEqual(j.missing, ["トレーナーコースの修了"]);
});

const ADM = { id: "adm@tadakayo.jp", name: "管理", isAdmin: true, isTrainer: false };
const TRN = { id: "trn@tadakayo.jp", name: "トレーナー", isAdmin: false, isTrainer: true };
const STF = { id: "stf@tadakayo.jp", name: "職員", isAdmin: false, isTrainer: false };
const TGT = { id: "new@tadakayo.jp", name: "新人", active: true, role: "staff" };

t("登壇の記録（ト2）: 登録は管理者とトレーナー・その他は理由必須・未来日は不可", () => {
  const ok = { date: "2026-11-01", kind: "seminar", venue: "介護情報基盤セミナー（オンライン）" };
  assert.match(T.buildTalk(ok, { actor: STF, target: TGT, now: NOW }).error, /管理者とトレーナー/);
  const r = T.buildTalk(ok, { actor: TRN, target: TGT, now: NOW });
  assert.equal(r.talk.userId, TGT.id); assert.equal(r.talk.recordedById, TRN.id); assert.equal(r.talk.voided, false);
  assert.ok(T.buildTalk(ok, { actor: ADM, target: TGT, now: NOW }).talk);
  assert.match(T.buildTalk({ ...ok, kind: "other" }, { actor: ADM, target: TGT, now: NOW }).error, /理由/);
  assert.ok(T.buildTalk({ ...ok, kind: "other", reason: "地域ケア会議での説明" }, { actor: ADM, target: TGT, now: NOW }).talk);
  assert.match(T.buildTalk({ ...ok, kind: "x" }, { actor: ADM, target: TGT, now: NOW }).error, /区分/);
  assert.match(T.buildTalk({ ...ok, date: "2026-11-13" }, { actor: ADM, target: TGT, now: NOW }).error, /未来/);
  assert.ok(T.buildTalk({ ...ok, date: "2026-11-12" }, { actor: ADM, target: TGT, now: NOW }).talk); // 当日は可（JST）
  assert.match(T.buildTalk({ ...ok, date: "2026-02-30" }, { actor: ADM, target: TGT, now: NOW }).error, /登壇した日/);
  assert.match(T.buildTalk({ ...ok, venue: " " }, { actor: ADM, target: TGT, now: NOW }).error, /何の場/);
  assert.match(T.buildTalk({ ...ok, venue: "あ".repeat(101) }, { actor: ADM, target: TGT, now: NOW }).error, /100字/);
  assert.match(T.buildTalk(ok, { actor: ADM, target: null, now: NOW }).error, /選んで/);
  assert.match(T.buildTalk(ok, { actor: ADM, target: { ...TGT, role: "trainee" }, now: NOW }).error, /記録できません/);
  assert.equal(T.TALK_KINDS.length, 5);
  assert.equal(T.talkKindLabel("municipal"), "自治体の説明会・研修会の講師");
});

t("登壇の記録の取り消し: 管理者だけ・理由必須・二重は不可", () => {
  const talk = { userId: TGT.id, voided: false };
  assert.match(T.buildTalkVoid({ reason: "誤登録" }, { actor: TRN, talk, now: NOW }).error, /管理者だけ/);
  assert.match(T.buildTalkVoid({ reason: "" }, { actor: ADM, talk, now: NOW }).error, /理由/);
  assert.match(T.buildTalkVoid({ reason: "x" }, { actor: ADM, talk: { voided: true }, now: NOW }).error, /すでに/);
  assert.match(T.buildTalkVoid({ reason: "x" }, { actor: ADM, talk: null, now: NOW }).error, /見つかりません/);
  const r = T.buildTalkVoid({ reason: "誤登録" }, { actor: ADM, talk, now: NOW });
  assert.deepEqual(r.patch, { voided: true, voidedById: ADM.id, voidedByName: "管理", voidedAt: NOW, voidReason: "誤登録" });
});

t("トレーナーコースの確認テスト: 形・採点・記録", () => {
  const q = T.COURSE_QUIZ;
  assert.ok(q.questions.length >= 5);
  const ids = new Set();
  for (const x of q.questions) {
    assert.ok(!ids.has(x.id)); ids.add(x.id);
    assert.ok(Array.isArray(x.choices) && x.choices.length >= 3, x.id);
    assert.ok(Number.isInteger(x.answer) && x.answer >= 0 && x.answer < x.choices.length, x.id);
    assert.ok(x.why && x.src, x.id);
  }
  // 相談先は TM_介護情報基盤普及推進室（台本 v1.1）
  assert.ok(q.questions.some((x) => x.choices[x.answer].includes("TM_介護情報基盤普及推進室")));
  // 正解の位置が偏りすぎていない（全部同じ番号ではない）
  assert.ok(new Set(q.questions.map((x) => x.answer)).size >= 2);
  const all = Object.fromEntries(q.questions.map((x) => [x.id, x.answer]));
  let g = T.gradeCourseQuiz(all);
  assert.equal(g.status, "graded"); assert.equal(g.passed, true); assert.equal(g.score, 100);
  const wrong1 = { ...all, [q.questions[0].id]: (q.questions[0].answer + 1) % 3 };
  g = T.gradeCourseQuiz(wrong1); assert.equal(g.passed, q.questions.length >= 5); // 1問違いは合格（5問以上なら 80%以上）
  const wrong2 = { ...wrong1, [q.questions[1].id]: (q.questions[1].answer + 1) % 3 };
  g = T.gradeCourseQuiz(wrong2); assert.equal(g.passed, false);
  const miss = { ...all }; delete miss[q.questions[2].id];
  g = T.gradeCourseQuiz(miss); assert.equal(g.status, "incomplete"); assert.equal(g.passed, false);
  assert.equal(T.gradeCourseQuiz({ ...all, [q.questions[0].id]: "1" }).results[0].chosen, 1);
  assert.equal(T.gradeCourseQuiz(null).status, "incomplete");
  assert.match(T.coursePassText(), /80%以上/);
  // 記録: 最初に合格した時刻・最高点は減らさない
  let rec = T.nextCourseQuiz(null, { score: 50, passed: false }, 1000);
  assert.deepEqual(rec, { best: 50, attempts: 1, lastScore: 50, lastAt: 1000, passedAt: null });
  rec = T.nextCourseQuiz(rec, { score: 100, passed: true }, 2000);
  assert.equal(rec.passedAt, 2000); assert.equal(rec.best, 100); assert.equal(rec.attempts, 2);
  rec = T.nextCourseQuiz(rec, { score: 33, passed: false }, 3000);
  assert.equal(rec.passedAt, 2000); assert.equal(rec.best, 100); assert.equal(rec.lastScore, 33); assert.equal(rec.attempts, 3);
  assert.equal(T.courseDone({ watchedAt: 1, quiz: rec }), true);
  assert.equal(T.courseDone({ quiz: rec }), false);
  assert.equal(T.courseDone({ watchedAt: 1, quiz: { passedAt: null } }), false);
  assert.equal(T.courseDone({ watchedAt: { seconds: 10, nanoseconds: 0 }, quiz: { passedAt: { toMillis: () => 5 } } }), true);
  assert.equal(T.courseDone(null), false);
});

t("名簿: 初期4名は support-evaluation.js と同じ・名簿が無いときは氏名で照合", () => {
  assert.deepEqual(T.INITIAL_TRAINER_NAMES, SE.INITIAL_TRAINER_NAMES);
  const users = [{ _id: "h@x", name: "蜂須賀 大策" }, { _id: "t@x", name: "次田　芳尚" }, { _id: "a@x", name: "新人" }];
  assert.deepEqual(T.trainerIds(users, null), SE.trainerIds(users, null));
  assert.deepEqual(T.trainerIds(users, ["a@x"]), SE.trainerIds(users, ["a@x"]));
  assert.equal(T.isTrainerId("H@x", users, null), true);
  assert.equal(T.isTrainerId("a@x", users, null), false);
  // 名簿が無い状態で合格 → 初期4名の照合結果＋新しい人（初期の人が外れない）
  assert.deepEqual(T.rosterAfter(users, null, { type: "certify", userId: "a@x" }), ["h@x", "t@x", "a@x"]);
  assert.deepEqual(T.rosterAfter(users, ["h@x", "a@x"], { type: "certify", userId: "A@x" }), ["h@x", "a@x"]); // 二重に入れない
  assert.deepEqual(T.rosterAfter(users, null, { type: "revoke", userId: "t@x" }), ["h@x"]);
  assert.deepEqual(T.rosterAfter(users, [], { type: "revoke", userId: "t@x" }), ["h@x"]); // 空の配列も「名簿なし」と同じ（support-evaluation.js と同じ）
  assert.equal(T.isCandidateUser({ active: true }), true);
  assert.equal(T.isCandidateUser({ active: true, role: "admin" }), true);
  for (const role of ["viewer", "trainee", "warehouse"]) assert.equal(T.isCandidateUser({ active: true, role }), false, role);
  assert.equal(T.isCandidateUser({ active: false, role: "staff" }), false);
});

t("合格（ト5・ト7）: 通常はトレーナーか管理者で条件を満たす人だけ・特別裁量は管理者だけ・自分は不可", () => {
  const meet = { supportCount: 10, talkCount: 1, courseDone: true };
  const ctx = (o) => ({ actor: TRN, target: TGT, inRoster: false, stats: meet, criteria: null, now: NOW, ...o });
  let r = T.buildCertify({ userId: TGT.id, kind: "normal" }, ctx());
  assert.equal(r.cert.type, "certify"); assert.equal(r.cert.kind, "normal");
  assert.equal(r.cert.date, "2026-11-12"); assert.equal(r.cert.byId, TRN.id);
  assert.equal(r.cert.supportCount, 10); assert.equal(r.cert.talkCount, 1); assert.equal(r.cert.courseDone, true); assert.equal(r.cert.meets, true);
  assert.deepEqual(r.cert.criteria, T.DEFAULT_CRITERIA);
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ actor: STF })).error, /トレーナーと管理者だけ/);
  assert.ok(T.buildCertify({ kind: "normal" }, ctx({ actor: ADM })).cert);
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ stats: { supportCount: 9, talkCount: 1, courseDone: true } })).error, /条件を満たしていません（伴走支援 あと1件）/);
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ stats: { supportCount: 10, talkCount: 1, courseDone: false } })).error, /トレーナーコースの修了/);
  // 特別裁量
  assert.match(T.buildCertify({ kind: "discretion", reason: "長年の実績" }, ctx({ stats: {} })).error, /管理者だけ/);
  assert.match(T.buildCertify({ kind: "discretion", reason: "" }, ctx({ actor: ADM, stats: {} })).error, /理由/);
  r = T.buildCertify({ kind: "discretion", reason: "研修講師の実績が十分" }, ctx({ actor: ADM, stats: { supportCount: 3, talkCount: 0, courseDone: false } }));
  assert.equal(r.cert.kind, "discretion"); assert.equal(r.cert.meets, false); assert.equal(r.cert.supportCount, 3); assert.equal(r.cert.reason, "研修講師の実績が十分");
  // 自分で自分は不可（管理者でも・特別裁量でも）
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ actor: TRN, target: { ...TGT, id: "TRN@tadakayo.jp" } })).error, /自分で自分/);
  assert.match(T.buildCertify({ kind: "discretion", reason: "x" }, ctx({ actor: ADM, target: { ...TGT, id: ADM.id } })).error, /自分で自分/);
  // すでにトレーナー・対象外のロール・種類なし
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ inRoster: true })).error, /すでにトレーナー/);
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ target: { ...TGT, role: "viewer" } })).error, /トレーナーにできません/);
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ target: { ...TGT, active: false } })).error, /トレーナーにできません/);
  assert.match(T.buildCertify({ kind: "" }, ctx()).error, /種類/);
  assert.match(T.buildCertify({ kind: "normal" }, ctx({ target: null })).error, /選んで/);
  assert.match(T.buildCertify({ kind: "normal", reason: "あ".repeat(301) }, ctx()).error, /300字/);
});

t("取り消し（ト8）: 管理者だけ・理由必須・自分と最後の1人は不可", () => {
  const ctx = (o) => ({ actor: ADM, target: TGT, inRoster: true, rosterSize: 5, now: NOW, ...o });
  assert.match(T.buildRevoke({ reason: "x" }, ctx({ actor: TRN })).error, /管理者だけ/);
  assert.match(T.buildRevoke({ reason: "" }, ctx()).error, /理由/);
  assert.match(T.buildRevoke({ reason: "x" }, ctx({ inRoster: false })).error, /いまトレーナーではありません/);
  assert.match(T.buildRevoke({ reason: "x" }, ctx({ rosterSize: 1 })).error, /最後の1人/);
  assert.match(T.buildRevoke({ reason: "x" }, ctx({ target: { ...TGT, id: ADM.id } })).error, /自分自身/);
  const r = T.buildRevoke({ reason: "活動休止のため" }, ctx());
  assert.deepEqual({ type: r.cert.type, userId: r.cert.userId, byId: r.cert.byId, reason: r.cert.reason, date: r.cert.date },
    { type: "revoke", userId: TGT.id, byId: ADM.id, reason: "活動休止のため", date: "2026-11-12" });
});

t("認定の出どころ（ト4）: 名簿にいて合格の記録が無ければ「制度開始時の認定」", () => {
  const ev = [
    { userId: "a@x", type: "certify", kind: "normal", at: 1000 },
    { userId: "a@x", type: "revoke", at: 2000 },
    { userId: "b@x", type: "certify", kind: "discretion", at: 1500 },
    { userId: "c@x", type: "revoke", at: 1000 },
    { userId: "c@x", type: "certify", kind: "normal", at: 3000 },
  ];
  assert.equal(T.certOrigin("a@x", ev, false), "revoked");
  assert.equal(T.certOrigin("b@x", ev, true), "discretion");
  assert.equal(T.certOrigin("c@x", ev, true), "normal");
  assert.equal(T.certOrigin("h@x", ev, true), "initial");
  assert.equal(T.certOrigin("z@x", ev, false), null);
  assert.equal(T.ORIGIN_LABEL.initial, "制度開始時の認定");
  assert.deepEqual(T.certEventsOf("a@x", ev).map((e) => e.type), ["revoke", "certify"]);
});

t("Functions のコピーが正本と同じ（バイト単位）", () => {
  assert.equal(read("functions/trainer-rules.mjs"), read("admin/js/trainer-rules.js"));
  assert.match(read("scripts/check-shared-sync.sh"), /trainer-rules\.js functions\/trainer-rules\.mjs/);
});

t("結線: index.js は末尾に require と exports を足すだけ・Callable は全部先頭で認可", () => {
  const idx = read("functions/index.js");
  const names = ["trainerSaveCriteria", "trainerRecordTalk", "trainerCourseSubmit", "trainerCertify", "trainerRevoke"];
  assert.match(idx, /const trainer = require\("\.\/trainer"\);/);
  for (const nm of names) assert.match(idx, new RegExp(`exports\\.${nm} = trainer\\.${nm};`));
  const src = read("functions/trainer.js");
  const parts = src.split(/(?=^exports\.[A-Za-z]+ = onCall\()/m).slice(1);
  assert.deepEqual(parts.map((p) => p.match(/^exports\.([A-Za-z]+)/)[1]).sort(), names.slice().sort());
  for (const p of parts) {
    const head = p.slice(0, p.indexOf("async (request) => {") + 120);
    assert.match(head, /const me = await requireMember\(request, "(admin|editor|viewer)"\);/, p.slice(0, 40));
  }
  // 条件・取り消しは管理者だけ（サーバーで）
  assert.match(src, /exports\.trainerSaveCriteria = onCall\(OPTS, async \(request\) => \{\n\s+const me = await requireMember\(request, "admin"\)/);
  assert.match(src, /exports\.trainerRevoke = onCall\(OPTS, async \(request\) => \{\n\s+const me = await requireMember\(request, "admin"\)/);
  // requireMember は練習生を分かる文言で拒否し、roleAllows を通す
  assert.match(src, /user\.role === "trainee"/);
  assert.match(src, /Flow\.roleAllows\(user, allow\)/);
  // 書き込み先は appConfig の下だけ（cases・supportChecklists は読むだけ）
  const writes = [...src.matchAll(/\b(?:tx\.(?:set|update)|\.add|\.set|\.update)\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  for (const w of writes) assert.ok(/^(ref\.|cref|tref|\{)/.test(w), `appConfig 以外への書き込みかもしれない: ${w}`);
  assert.doesNotMatch(src, /collection\("(cases|supportChecklists|users)"\)[^;]*\.(set|update|add|delete)\(/);
  // 練習DBは開かない
  assert.doesNotMatch(src, /getFirestore\(\s*["']practice/);
});

t("画面: 新しいボタンには説明の吹き出し（data-tip）・参照する id が HTML にある・tooltip.js を読み込む", () => {
  const pairs = [["admin/badges.html", "admin/js/trainer-badges.js"], ["admin/trainer-course.html", "admin/js/trainer-course.js"]];
  for (const [h, j] of pairs) {
    const html = read(h), js = read(j);
    assert.match(html, /<script src="\/js\/tooltip\.js" type="module"><\/script>/, h);
    for (const id of new Set([...js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]))) {
      // JS が後から描く要素（innerHTML の中）は JS の中にある
      assert.ok(html.includes(`id="${id}"`) || js.includes(`id="${id}"`), `${j} の #${id} が無い`);
    }
    // JS が描くボタン・リンクのボタンにはすべて data-tip
    for (const m of js.matchAll(/<button [^>]*>/g)) assert.match(m[0], /data-tip="/, `${j}: ${m[0].slice(0, 60)}`);
  }
  // badges.html のトレーナー認定の節のボタンはすべて data-tip（既存の付与フォームのボタンは対象外）
  const bh = read("admin/badges.html");
  const sec = bh.slice(bh.indexOf("トレーナー認定（2026-11-12"), bh.indexOf("</dialog>"));
  for (const m of sec.matchAll(/<button [^>]*>/g)) {
    assert.match(m[0], /data-tip="/, m[0].slice(0, 60));
  }
  const th = read("admin/trainer-course.html");
  for (const m of th.matchAll(/<(button|a) [^>]*class="(?:[^"]* )?(?:btn|tc-link)(?: [^"]*)?"[^>]*>/g)) assert.match(m[0], /data-tip="/, m[0].slice(0, 60));
  // 書き込みは Callable だけ（画面から Firestore に書かない）
  for (const j of ["admin/js/trainer-badges.js", "admin/js/trainer-course.js"]) {
    assert.doesNotMatch(read(j), /\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\b/, j);
  }
  // サイドバー: 練習生にはトレーナーコースを出さない
  const sb = read("admin/js/sidebar.js");
  assert.match(sb, /\["\/trainer-course\.html", "ti-certificate", "トレーナーコース"\]/);
  assert.match(sb, /if \(trainee && it\[0\] === "\/trainer-course\.html"\) return;/);
  // 育成コースの画面からはトレーナーコースの画面へ案内する（見守りの案内を分けた）
  assert.match(read("admin/learning.html"), /href="\/trainer-course\.html"/);
  // 練習モード: 代役は練習DBの同じ置き場に書く
  const st = read("admin/js/practice-stubs-trainer.js");
  for (const nm of ["trainerSaveCriteria", "trainerRecordTalk", "trainerCourseSubmit", "trainerCertify", "trainerRevoke"]) assert.match(st, new RegExp(`async ${nm}\\(`));
  assert.match(st, /collection\(db\(\), "appConfig", "trainerProgram", name\)/);
});

console.log(`合計: ${n}/${n} 合格`);
