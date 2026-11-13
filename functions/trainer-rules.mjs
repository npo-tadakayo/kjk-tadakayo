// トレーナー認定（条件のチェック・トレーナー合格・特別裁量枠・取り消し・トレーナーコース）の判定（純粋 ESM・2026-11-12）。
// firebase を import しない（node の単体テスト scripts/test-trainer-rules.mjs と Functions から直接読むため）。
// ⚠️ 正本はこのファイル。functions/trainer-rules.mjs はバイト単位で同じコピー（scripts/check-shared-sync.sh と
//    scripts/test-trainer-rules.mjs で照合）。直したら cp admin/js/trainer-rules.js functions/trainer-rules.mjs で揃える。
// 計画と決定: 06_介護情報基盤事業/docs/トレーナーコース_計画_20261110.md §3・§7（ト1〜ト8・次田さん 2026-11-12）
//   ト1 条件は「登壇（または類似）」かつ「伴走支援10件」。数字と組み合わせは appConfig/trainerCriteria で変えられる
//   ト2 登壇の区分＝セミナー／自治体の説明会・研修会の講師／社内勉強会の講師／研修動画の講師役／その他（理由必須）
//   ト3 伴走支援は案件（事業所）単位。本人が実施者・「伴走支援実施済」以降・見守り付き（training）も数える・同じ事業所は1件
//   ト4 今のトレーナー4名はそのまま（記録は「制度開始時の認定」）
//   ト5 トレーナーコース（動画の視聴＋確認テストの合格）を合格の前提にする（設定で外せる）
//   ト7 特別裁量は管理者だけ（理由必須）。通常の合格はトレーナー（または管理者）
//   ト8 取り消しは管理者だけ（理由必須）。記録は消さず「取り消し」を足す
// 事業所名・利用者の情報は、ここで扱う記録に入れない（登壇の「場」は自由記入なので画面で注意を出す）。

// ---------- 条件（appConfig/trainerCriteria） ----------
export const DEFAULT_CRITERIA = Object.freeze({ supportCount: 10, talkCount: 1, combine: "and", requireCourse: true });
export const COMBINES = [
  { v: "and", t: "かつ（両方を満たす）" },
  { v: "or", t: "または（どちらかを満たす）" },
];
const MAX_COUNT = 100;
const isInt = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;

/** 保存されている条件（無い・壊れている項目は既定値）を返す */
export function normalizeCriteria(doc) {
  const d = doc || {};
  const sc = Number(d.supportCount), tc = Number(d.talkCount);
  return {
    supportCount: isInt(sc) ? sc : DEFAULT_CRITERIA.supportCount,
    talkCount: isInt(tc) ? tc : DEFAULT_CRITERIA.talkCount,
    combine: d.combine === "or" ? "or" : d.combine === "and" ? "and" : DEFAULT_CRITERIA.combine,
    requireCourse: typeof d.requireCourse === "boolean" ? d.requireCourse : DEFAULT_CRITERIA.requireCourse,
  };
}

/** 画面の入力 → 保存する条件。エラーなら { error } */
export function validateCriteriaInput(input) {
  const i = input || {};
  const sc = Number(i.supportCount), tc = Number(i.talkCount);
  if (!isInt(sc)) return { error: `伴走支援の必要件数は 0〜${MAX_COUNT} の整数で入れてください。` };
  if (!isInt(tc)) return { error: `登壇の必要回数は 0〜${MAX_COUNT} の整数で入れてください。` };
  if (i.combine !== "and" && i.combine !== "or") return { error: "組み合わせ（かつ／または）を選んでください。" };
  if (typeof i.requireCourse !== "boolean") return { error: "トレーナーコースの修了を前提にするかを選んでください。" };
  if (sc === 0 && tc === 0) return { error: "伴走支援と登壇の両方を 0 にはできません。" };
  return { criteria: { supportCount: sc, talkCount: tc, combine: i.combine, requireCourse: i.requireCourse } };
}

/** 条件の1行（画面の見出し） */
export function criteriaText(c) {
  const k = normalizeCriteria(c);
  const join = k.combine === "or" ? "または" : "かつ";
  return `伴走支援 ${k.supportCount}件 ${join} 登壇（または類似のもの）${k.talkCount}回${k.requireCourse ? "／トレーナーコースの修了が前提" : ""}`;
}

// ---------- 登壇の記録（appConfig/trainerProgram/talks/{id}） ----------
export const TALK_KINDS = [
  { v: "seminar", t: "セミナーの登壇" },
  { v: "municipal", t: "自治体の説明会・研修会の講師" },
  { v: "study", t: "社内勉強会の講師" },
  { v: "video", t: "研修動画の講師役" },
  { v: "other", t: "その他（認定者が類似と認めたもの）" },
];
export const talkKindLabel = (v) => (TALK_KINDS.find((k) => k.v === v) || {}).t || "";
export const VENUE_MAX = 100;
export const REASON_MAX = 300;
const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => String(v == null ? "" : v).trim();
const low = (v) => str(v).toLowerCase();

export function todayJst(now = Date.now()) {
  return new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
}
function validYmd(s) {
  if (!ymdRe.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 登壇の記録を組み立てる。ctx: { actor:{ id, name, isAdmin, isTrainer }, target:{ id, name, active, role }, now }
 * 登録できるのは管理者とトレーナー（ト2・計画 §3.2）。
 */
export function buildTalk(input, ctx) {
  const i = input || {}, a = ctx.actor || {}, t = ctx.target;
  if (!a.isAdmin && !a.isTrainer) return { error: "登壇の記録を登録できるのは、管理者とトレーナーだけです。" };
  if (!t) return { error: "登壇した人を選んでください。" };
  if (!isCandidateUser(t)) return { error: "この人の登壇は記録できません（有効なスタッフ・管理者だけです）。" };
  const date = str(i.date);
  if (!validYmd(date)) return { error: "登壇した日を入れてください。" };
  if (date > todayJst(ctx.now)) return { error: "登壇した日が未来になっています。登壇が済んでから記録してください。" };
  const kind = str(i.kind);
  if (!TALK_KINDS.some((k) => k.v === kind)) return { error: "区分を選んでください。" };
  const venue = str(i.venue);
  if (!venue) return { error: "何の場で話したか（会の名前）を入れてください。" };
  if (venue.length > VENUE_MAX) return { error: `何の場で話したかは ${VENUE_MAX}字以内で入れてください。` };
  const reason = str(i.reason);
  if (kind === "other" && !reason) return { error: "区分が「その他」のときは、類似と認めた理由を書いてください。" };
  if (reason.length > REASON_MAX) return { error: `理由は ${REASON_MAX}字以内で書いてください。` };
  return {
    talk: {
      userId: t.id, userName: t.name || t.id, date, kind, venue, reason,
      recordedById: a.id, recordedByName: a.name || a.id, recordedAt: ctx.now,
      voided: false,
    },
  };
}

/** 登壇の記録を取り消す（管理者だけ・理由必須）。消さずに voided を立てる */
export function buildTalkVoid(input, ctx) {
  const a = ctx.actor || {}, talk = ctx.talk;
  if (!a.isAdmin) return { error: "登壇の記録を取り消せるのは管理者だけです。" };
  if (!talk) return { error: "この登壇の記録は見つかりません。画面を更新してください。" };
  if (talk.voided) return { error: "この登壇の記録はすでに取り消されています。" };
  const reason = str(input && input.reason);
  if (!reason) return { error: "取り消す理由を書いてください。" };
  if (reason.length > REASON_MAX) return { error: `理由は ${REASON_MAX}字以内で書いてください。` };
  return { patch: { voided: true, voidedById: a.id, voidedByName: a.name || a.id, voidedAt: ctx.now, voidReason: reason } };
}

export function countTalks(userId, talks) {
  const id = low(userId);
  return (talks || []).filter((t) => t && !t.voided && low(t.userId) === id).length;
}

// ---------- 伴走支援の件数（ト3） ----------
// 案件のステータス順（admin/js/constants.js の STATUS_ORDER と同じ。4＝失注は最後）
export const STATUS_ORDER = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 4];
export const STATUS_LOST = 4;
export const STATUS_DONE_SUPPORT = 8; // 伴走支援実施済
export const COUNTED_MODES = ["solo", "training"]; // 見学（observe）は数えない
export function statusReached(status, target = STATUS_DONE_SUPPORT) {
  const s = Number(status);
  if (s === STATUS_LOST) return false;
  const i = STATUS_ORDER.indexOf(s), t = STATUS_ORDER.indexOf(target);
  return i >= 0 && t >= 0 && i >= t;
}

/**
 * メンバーの伴走支援の件数。
 *   cases: [{ _id, status, officeId }] ／ checklists: { [caseId]: { performance } }（supportChecklists）
 *   数えるもの: performance.performerId が本人・区分が単独かトレーニング（見守り付き）・案件が「伴走支援実施済」以降
 *   同じ事業所（officeId）は1件。officeId の無い古い案件は案件ごとに1件
 * 戻り値: { count, caseIds }（caseIds は数えた案件。事業所ごとに最初の1件）
 */
export function countSupport(userId, cases, checklists) {
  const id = low(userId);
  const offices = new Set(), caseIds = [];
  const sorted = (cases || []).slice().sort((a, b) => String(a._id).localeCompare(String(b._id)));
  for (const c of sorted) {
    if (!c || !c._id) continue;
    const p = checklists && checklists[c._id] && checklists[c._id].performance;
    if (!p || low(p.performerId) !== id || !COUNTED_MODES.includes(p.mode)) continue;
    if (!statusReached(c.status)) continue;
    const key = str(c.officeId) ? `o:${str(c.officeId)}` : `c:${c._id}`;
    if (offices.has(key)) continue;
    offices.add(key);
    caseIds.push(c._id);
  }
  return { count: caseIds.length, caseIds };
}

/** 全メンバーぶんをまとめて数える（画面の表）。{ [小文字のメール]: count } */
export function countSupportAll(cases, checklists) {
  const ids = new Set();
  for (const v of Object.values(checklists || {})) if (v && v.performance && v.performance.performerId) ids.add(low(v.performance.performerId));
  const out = {};
  for (const id of ids) out[id] = countSupport(id, cases, checklists).count;
  return out;
}

// ---------- トレーナーコース（ト5・appConfig/trainerProgram/course/{email}） ----------
// 動画は共有ドライブのトレーナーコース（01 新人の見守り方）。CRM では見たことを本人が申告する。
export const COURSE_FOLDER_URL = "https://drive.google.com/drive/folders/1epP9qHdEY2uXhmz3p3QtiP60EkaEy02Q";
// 確認テスト。台本: 06_介護情報基盤事業/動画_育成_新人の見守り方_20261025/台本.md（v1.1）。形は learning-quiz.js と同じ
//   answer は choices の何番目が正解か（0 から）。画面では選択肢の順番を並べ替えて出す
export const COURSE_QUIZ = {
  title: "トレーナーコースの確認テスト（新人の見守り方）",
  pass: { ratio: 0.8 },
  questions: [
    { id: "T1-01", q: "新しい方が伴走支援に入ることになりました。最初に、管理者がユーザー管理ですることはどれですか。", choices: ["ロールを「スタッフ」にして、すぐ本番の案件を担当してもらう", "ロールを「練習生」にする（練習生は練習モードだけを使い、本番の案件は見られない）", "ロールを「閲覧のみ」にして、本番の案件を見てもらう"], answer: 1, why: "新しい方は、まず管理者がロールを「練習生」にします。練習生は練習モードだけを使い、本番の案件は見られません。", src: "見守り方 場面02" },
    { id: "T1-02", q: "育成コースの画面の「受講中の方の進み具合」で、支援先（OJT）の割り当てはどの方から組みますか。", choices: ["「OJTに入れます」になっている方から", "登録した日が古い方から", "動画を1本でも見た方から"], answer: 0, why: "「OJTに入れます」（STEP1〜5 が済んだ方）から、支援先の割り当てを組みます。「見る」でステップごとの状態とテストの点数も確かめられます。", src: "見守り方 場面03・04" },
    { id: "T1-03", q: "OJTの当日、案件の「当日」タブの「実施の記録」はどう残しますか。", choices: ["区分は「単独」、実施者は自分", "区分は「見学」、実施者は新人の方", "区分は「トレーニング」、実施者は新人の方、トレーナーは自分"], answer: 2, why: "OJTは区分「トレーニング」で、実施者は新人の方、トレーナーは自分です。トレーナーが立ち会わないOJT・見学は評価の対象になりません。", src: "見守り方 場面05" },
    { id: "T1-04", q: "評価シートで「独り立ち可」にできる基準はどれですか。", choices: ["8つの観点のうち半分以上が「ひとりでできる」", "個人情報・安全が「ひとりでできる」、ほかがすべて「助言があればできる」以上、OJTで1回でも合格", "OJTに3回以上立ち会ったこと"], answer: 1, why: "独り立ち可は、④個人情報・安全が◎（ひとりでできる）、ほかがすべて○（助言があればできる）以上、そしてOJTで1回でも合格です。", src: "見守り方 場面06・07" },
    { id: "T1-05", q: "バッジを付与した方のロールが「練習生」のままでした。どうしますか。", choices: ["管理者が、ユーザー管理でロールを「スタッフ」に変える", "そのままでよい（バッジがあれば本番の案件を担当できる）", "バッジを取り消して、もう一度付与する"], answer: 0, why: "練習生のままでは本番の案件を見られません。管理者がユーザー管理でロールを「スタッフ」に変えると、本番の案件を担当できます。", src: "見守り方 場面09" },
    { id: "T1-06", q: "評価や付与の判断で迷いました。どうしますか。", choices: ["自分の判断で、とりあえず「独り立ち可」にしておく", "新人の方に、自分で判定してもらう", "迷ったら TM_介護情報基盤普及推進室で相談する"], answer: 2, why: "評価や付与で迷ったときは、TM_介護情報基盤普及推進室で相談します。", src: "見守り方 場面10" },
  ],
};

/** 採点（learning-core.js の gradeQuiz と同じ考え方）。answers は { 問題ID: 選んだ選択肢の元の番号 } */
export function gradeCourseQuiz(answers, quiz = COURSE_QUIZ) {
  const qs = (quiz && Array.isArray(quiz.questions)) ? quiz.questions : [];
  const a = answers && typeof answers === "object" ? answers : {};
  const results = qs.map((q) => {
    const has = Object.prototype.hasOwnProperty.call(a, q.id) && a[q.id] != null && a[q.id] !== "";
    const chosen = has ? Number(a[q.id]) : null;
    return { id: q.id, chosen, correct: chosen === q.answer };
  });
  const unanswered = results.filter((r) => r.chosen == null || Number.isNaN(r.chosen)).map((r) => r.id);
  const correct = results.filter((r) => r.correct).length;
  const ratio = qs.length ? correct / qs.length : 0;
  const pr = Number(quiz && quiz.pass && quiz.pass.ratio);
  const need = pr > 0 && pr <= 1 ? pr : 0.8;
  return {
    status: !qs.length ? "preparing" : unanswered.length ? "incomplete" : "graded",
    passed: !!qs.length && !unanswered.length && ratio + 1e-9 >= need,
    total: qs.length, correct, score: Math.round(ratio * 100), results, unanswered,
  };
}
export function coursePassText(quiz = COURSE_QUIZ) {
  return `${quiz.questions.length}問・${Math.round((quiz.pass.ratio || 0.8) * 100)}%以上で合格`;
}

/** 確認テストの記録を更新する（最高点・回数・最初に合格した時刻は減らさない） */
export function nextCourseQuiz(prev, result, now) {
  const p = prev || {};
  const passedAt = toMs(p.passedAt) != null ? toMs(p.passedAt) : (result.passed ? now : null);
  return {
    best: Math.max(Number(p.best) || 0, Number(result.score) || 0),
    attempts: (Number(p.attempts) || 0) + 1,
    lastScore: Number(result.score) || 0,
    lastAt: now,
    passedAt,
  };
}
export function courseWatched(course) { return toMs(course && course.watchedAt) != null; }
export function courseQuizPassed(course) { return toMs(course && course.quiz && course.quiz.passedAt) != null; }
export function courseDone(course) { return courseWatched(course) && courseQuizPassed(course); }

// ---------- 判定（チェック画面・合格の前提） ----------
/**
 * stats: { supportCount, talkCount, courseDone } → { meets, supportOk, talkOk, courseOk, missing:[文], label }
 */
export function judge(stats, criteria) {
  const c = normalizeCriteria(criteria);
  const s = stats || {};
  const sc = Number(s.supportCount) || 0, tc = Number(s.talkCount) || 0;
  const supportOk = sc >= c.supportCount, talkOk = tc >= c.talkCount;
  const courseOk = !c.requireCourse || !!s.courseDone;
  const pair = c.combine === "or" ? (supportOk || talkOk) : (supportOk && talkOk);
  const meets = pair && courseOk;
  const missing = [];
  const needS = `伴走支援 あと${c.supportCount - sc}件`, needT = `登壇 あと${c.talkCount - tc}回`;
  if (c.combine === "or") {
    if (!pair) missing.push(`${needS} または ${needT}`);
  } else {
    if (!supportOk) missing.push(needS);
    if (!talkOk) missing.push(needT);
  }
  if (!courseOk) missing.push("トレーナーコースの修了");
  return { meets, supportOk, talkOk, courseOk, missing, label: meets ? "候補" : `あと：${missing.join("・")}` };
}

// ---------- トレーナー名簿（appConfig/supportTrainers.ids） ----------
// admin/js/support-evaluation.js の INITIAL_TRAINER_NAMES・trainerIds と同じ（test-trainer-rules.mjs で照合）。
// 名簿の文書が無いあいだは、初期4名を users の氏名で照合する（ト4）。
export const INITIAL_TRAINER_NAMES = ["蜂須賀大策", "藤田博之", "次田芳尚", "石田祐樹"];
const squash = (s) => String(s || "").replace(/[\s　]/g, "");
export function trainerIds(users, rosterIds) {
  if (Array.isArray(rosterIds) && rosterIds.length) return rosterIds.slice();
  return (users || []).filter((u) => INITIAL_TRAINER_NAMES.includes(squash(u.name))).map((u) => u._id);
}
export function isTrainerId(userId, users, rosterIds) {
  const id = low(userId);
  return !!id && trainerIds(users, rosterIds).some((x) => low(x) === id);
}
/** トレーナーになれる人か（有効・ロールが管理者かスタッフか未設定。閲覧のみ・練習生・倉庫は外す） */
export function isCandidateUser(u) {
  if (!u || u.active === false) return false;
  const r = u.role == null ? "" : u.role;
  return r === "" || r === "staff" || r === "admin";
}

// ---------- 名簿にいるが、トレーナーとして動けない人（#74 レビュー L9・2026-11-13） ----------
// 利用者一覧（users）から消えた（削除）・無効にした・ロールを対象外（閲覧のみ・練習生・倉庫）に変えた人は、
// 名簿に残っていても評価・付与はできない（requireMember と firestore.rules で止まる）が、メンバーの表には出ないので、
// 表とは別に並べて、管理者が取り消せるようにする。自動では外さない（取り消しは管理者の判断・理由と記録を残す）。
export const STALE_LABEL = {
  missing: "利用者一覧にいない（削除）",
  inactive: "無効",
  role: "ロールがトレーナーの対象外（閲覧のみ・練習生・倉庫）",
};
/** [{ id, name, why: "missing"|"inactive"|"role" }]。名簿の文書が無いあいだは初期4名の照合結果から見る */
export function staleRosterEntries(users, rosterIds) {
  const list = users || [];
  const out = [];
  for (const id of trainerIds(list, rosterIds)) {
    const u = list.find((x) => low(x._id) === low(id));
    const why = !u ? "missing" : u.active === false ? "inactive" : !isCandidateUser(u) ? "role" : "";
    if (why) out.push({ id, name: u ? (u.name || u._id) : "", why });
  }
  return out;
}
/**
 * 取り消しの対象を引く。users にいればその人。いなければ（削除された人）名簿にいるメールを対象にし、
 * 名前は合格の記録（events）から引く（無ければメール）。名簿にもいなければ null。
 */
export function revokeTargetOf(users, rosterIds, userId, events) {
  const id = low(userId);
  if (!id) return null;
  const u = (users || []).find((x) => low(x._id) === id);
  if (u) return { id: u._id, name: u.name || u._id, active: u.active, role: u.role };
  const rid = trainerIds(users, rosterIds).find((x) => low(x) === id);
  if (!rid) return null;
  const named = certEventsOf(rid, events).find((e) => str(e.userName) && low(e.userName) !== id);
  return { id: rid, name: named ? str(named.userName) : rid, active: false, role: null, missing: true };
}

// ---------- 合格・取り消しの記録（appConfig/trainerProgram/certs/{id}） ----------
const toMs = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "object" && typeof v.seconds === "number") return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
export { toMs };

/** その人の記録を新しい順に */
export function certEventsOf(userId, events) {
  const id = low(userId);
  return (events || []).filter((e) => e && low(e.userId) === id)
    .sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0));
}

/**
 * 名簿の上での認定の出どころ。
 *   "normal"／"discretion"（最後の記録が合格）・"initial"（名簿にいて合格の記録が無い＝制度開始時の認定）・
 *   "revoked"（最後の記録が取り消し）・null（記録なし・名簿にもいない）
 */
export function certOrigin(userId, events, inRoster) {
  const last = certEventsOf(userId, events)[0];
  if (last && last.type === "certify") return last.kind === "discretion" ? "discretion" : "normal";
  if (inRoster) return "initial"; // 取り消しの後に名簿へ戻った（手作業）場合も、合格の記録が無ければここ
  if (last && last.type === "revoke") return "revoked";
  return null;
}
export const ORIGIN_LABEL = {
  initial: "制度開始時の認定",
  normal: "トレーナー合格（通常）",
  discretion: "トレーナー合格（特別裁量）",
  revoked: "取り消し",
};

/**
 * 合格（認定）を組み立てる。
 *   input: { userId, kind: "normal"|"discretion", reason }
 *   ctx:   { actor:{ id, name, isAdmin, isTrainer }, target:{ id, name, active, role }, inRoster, stats, criteria, now }
 * 戻り値: { cert } か { error }
 */
export function buildCertify(input, ctx) {
  const i = input || {}, a = ctx.actor || {}, t = ctx.target;
  const kind = i.kind === "discretion" ? "discretion" : i.kind === "normal" ? "normal" : "";
  if (!kind) return { error: "合格の種類（通常／特別裁量）を選んでください。" };
  if (kind === "discretion" && !a.isAdmin) return { error: "特別裁量枠で合格にできるのは管理者だけです。" };
  if (kind === "normal" && !a.isAdmin && !a.isTrainer) return { error: "トレーナー合格にできるのは、トレーナーと管理者だけです。" };
  if (!t) return { error: "合格にする人を選んでください。" };
  if (low(t.id) === low(a.id)) return { error: "自分で自分を合格にすることはできません。ほかのトレーナーか管理者に依頼してください。" };
  if (!isCandidateUser(t)) return { error: "この人はトレーナーにできません（有効なスタッフ・管理者だけです。閲覧のみ・練習生・倉庫のロールは対象外）。" };
  if (ctx.inRoster) return { error: "この人はすでにトレーナーです。" };
  const reason = str(i.reason);
  if (reason.length > REASON_MAX) return { error: `理由は ${REASON_MAX}字以内で書いてください。` };
  const criteria = normalizeCriteria(ctx.criteria);
  const s = ctx.stats || {};
  const j = judge(s, criteria);
  if (kind === "normal" && !j.meets) return { error: `条件を満たしていません（${j.missing.join("・")}）。条件を満たしていない人は、管理者が特別裁量枠で合格にできます。` };
  if (kind === "discretion" && !reason) return { error: "特別裁量枠で合格にするときは、理由を書いてください。" };
  return {
    cert: {
      type: "certify", kind, userId: t.id, userName: t.name || t.id,
      date: todayJst(ctx.now), at: ctx.now,
      byId: a.id, byName: a.name || a.id,
      supportCount: Number(s.supportCount) || 0, talkCount: Number(s.talkCount) || 0, courseDone: !!s.courseDone,
      meets: j.meets, criteria, reason,
    },
  };
}

/**
 * 取り消しを組み立てる（管理者だけ・理由必須・最後の1人は取り消せない）。
 *   ctx: { actor, target, inRoster, rosterSize, now }
 */
export function buildRevoke(input, ctx) {
  const a = ctx.actor || {}, t = ctx.target;
  if (!a.isAdmin) return { error: "トレーナー合格を取り消せるのは管理者だけです。" };
  if (!t) return { error: "取り消す人を選んでください。" };
  if (low(t.id) === low(a.id)) return { error: "自分自身のトレーナー合格は取り消せません。別の管理者に依頼してください。" };
  if (!ctx.inRoster) return { error: "この人はいまトレーナーではありません。" };
  if ((Number(ctx.rosterSize) || 0) <= 1) return { error: "最後の1人のトレーナーは取り消せません（トレーナーがいなくなると評価・バッジの付与ができなくなります）。" };
  const reason = str(input && input.reason);
  if (!reason) return { error: "取り消す理由を書いてください。" };
  if (reason.length > REASON_MAX) return { error: `理由は ${REASON_MAX}字以内で書いてください。` };
  return {
    cert: {
      type: "revoke", kind: null, userId: t.id, userName: t.name || t.id,
      date: todayJst(ctx.now), at: ctx.now, byId: a.id, byName: a.name || a.id, reason,
    },
  };
}

/** 合格・取り消しのあとの名簿（いまの名簿＝名簿の文書が無ければ初期4名の照合結果を起点にする） */
export function rosterAfter(users, rosterIds, change) {
  const cur = trainerIds(users, rosterIds);
  const id = str(change && change.userId);
  if (!id) return cur;
  if (change.type === "certify") return cur.some((x) => low(x) === low(id)) ? cur : [...cur, id];
  if (change.type === "revoke") return cur.filter((x) => low(x) !== low(id));
  return cur;
}
