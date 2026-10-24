// admin/js/learning-core.js — 育成コースの判定・採点・進み具合の組み立て（純粋関数）
// 画面（learning.js）・評価シート（support-checklist.js）から使う。Firebase に依存しないので
// node で単体テストできる（scripts/test-learning-core.mjs）。
// 仕様: docs/伴走支援者育成プログラム_提案_20261024.md §3〜§4
//
// 進み具合の文書 learningProgress/{メール}（本番DB・1人1文書。提案書 §4.2）
//   { name, startedAt, lastAt,
//     videos:   { "L-A": { maxPos, duration, doneAt }, "G0": {...}, ... }   ← キーは video-catalog.js の動画ID
//     quizzes:  { "S1": { best, lastScore, attempts, lastAt, passedAt }, ... } ← best/lastScore は正答率（0〜100）
//     pledgeAt,                       // STEP1「約束します」を押した日時
//     practice: { checkedAt, items: { firstContact: true, ... }, passedAt, cases },
//     readyForOjtAt,                  // STEP1〜5 が全部済んだ日時（最初の1回だけ入れる）
//     updatedAt }                     // ← これだけは画面側で serverTimestamp を足す
//   日時はミリ秒の数値（Date.now()）。読むときは Timestamp・文字列も受け付ける（toMs）。
//   更新は「変わったところだけ」の patch を setDoc(..., { merge: true }) で書く（他の値を消さない）。
import { STEPS, PRACTICE_TASKS, READY_STEPS, findStep } from "./learning-catalog.js";
import { findVideo } from "./video-catalog.js";
import { STATUS_ORDER, LOST } from "./constants.js";

export const VIDEO_DONE_RATIO = 0.9; // 再生した最大位置が長さの9割以上で「見た」
export const DEFAULT_PASS_RATIO = 0.8;

// ---------- 日時 ----------
/** 数値・Date・Firestore Timestamp・文字列 → ミリ秒（読めなければ null） */
export function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (typeof v === "string") {
    // "YYYY-MM-DD" は JST の0時として読む（バッジの付与日）
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600e3;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
const JST_DATE = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" });
const JST_DT = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** JST の「2026/10/24」。読めなければ "" */
export function fmtDate(v) { const t = toMs(v); return t == null ? "" : JST_DATE.format(new Date(t)); }
/** JST の「2026/10/24 15:30」。読めなければ "" */
export function fmtDateTime(v) { const t = toMs(v); return t == null ? "" : JST_DT.format(new Date(t)); }

// ---------- 動画 ----------
export function isVideoDone(rec) {
  if (!rec) return false;
  if (toMs(rec.doneAt) != null) return true;
  const d = Number(rec.duration), p = Number(rec.maxPos);
  return d > 0 && p >= d * VIDEO_DONE_RATIO;
}
/** 見た割合（0〜100の整数） */
export function videoPercent(rec) {
  if (!rec) return 0;
  if (isVideoDone(rec) && !(Number(rec.duration) > 0)) return 100;
  const d = Number(rec.duration), p = Number(rec.maxPos);
  if (!(d > 0) || !(p > 0)) return 0;
  return Math.min(100, Math.round((p / d) * 100));
}

/**
 * 再生位置を受け取って、動画の記録を更新する。戻すことはしない（最大位置だけ伸ばす）。
 * 戻り値 { rec, changed, justDone }。pos・duration が読めないときは changed=false。
 */
export function nextVideoRecord(prev, pos, duration, now) {
  const p = Number(pos), d = Number(duration);
  if (!Number.isFinite(p) || p < 0 || !Number.isFinite(d) || d <= 0) return { rec: prev || null, changed: false, justDone: false };
  const prevMax = Number(prev?.maxPos) || 0;
  const maxPos = Math.round(Math.min(d, Math.max(prevMax, p)) * 10) / 10;
  const wasDone = isVideoDone(prev);
  const rec = { maxPos, duration: Math.round(d * 10) / 10, doneAt: prev?.doneAt ?? null };
  if (!wasDone && maxPos >= d * VIDEO_DONE_RATIO) rec.doneAt = now;
  const changed = !prev || maxPos !== prevMax || rec.doneAt !== (prev.doneAt ?? null) || rec.duration !== prev.duration;
  return { rec, changed, justDone: !wasDone && isVideoDone(rec) };
}

/**
 * 保存しすぎないための判定。見終わった瞬間・一時停止／終了（force）は必ず保存。
 * それ以外は、前回の保存から10秒以上進み、かつ5秒以上たったときだけ。
 */
export const VIDEO_SAVE_STEP_SEC = 10;
export const VIDEO_SAVE_MIN_MS = 5000;
export function shouldSaveVideo(last, rec, { justDone = false, force = false, now = 0 } = {}) {
  if (!rec) return false;
  const savedMax = Number(last?.maxPos) || 0;
  if (justDone) return true;
  if (force) return rec.maxPos > savedMax;
  return rec.maxPos - savedMax >= VIDEO_SAVE_STEP_SEC && now - (Number(last?.at) || 0) >= VIDEO_SAVE_MIN_MS;
}

// ---------- 確認テスト ----------
/** 0〜n-1 の並べ替え（Fisher–Yates）。rand は 0以上1未満を返す関数（テストでは固定の値を渡す） */
export function shuffledOrder(n, rand = Math.random) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** 1問の選択肢を並べ替えて返す [{ index: 元の番号, text }] */
export function shuffleChoices(question, rand = Math.random) {
  const ch = question?.choices || [];
  return shuffledOrder(ch.length, rand).map((i) => ({ index: i, text: ch[i] }));
}

export function passRatio(quiz) {
  const r = Number(quiz?.pass?.ratio);
  return r > 0 && r <= 1 ? r : DEFAULT_PASS_RATIO;
}
export function hasQuestions(quiz) { return !!(quiz && Array.isArray(quiz.questions) && quiz.questions.length); }

/** 合格の条件の説明（画面とテストの案内） */
export function passRuleText(quiz) {
  const r = passRatio(quiz);
  const safety = hasQuestions(quiz) && quiz.questions.some((q) => q.safety);
  if (r >= 1) return "全問正解で合格";
  return `${Math.round(r * 100)}%以上で合格${safety ? "（個人情報・安全の問題は全問正解が必要）" : ""}`;
}

/**
 * 採点。answers は { 問題ID: 選んだ選択肢の元の番号 }。
 *   status: "preparing"（問題が無い＝準備中。合格にしない）／"incomplete"（未回答あり）／"graded"
 *   passed: 正答率が pass.ratio 以上、かつ safety:true の問題を全問正解、かつ未回答なし
 */
export function gradeQuiz(quiz, answers) {
  const qs = hasQuestions(quiz) ? quiz.questions : [];
  const a = answers || {};
  if (!qs.length) return { status: "preparing", passed: false, total: 0, correct: 0, score: 0, results: [], safetyMissed: [], unanswered: [] };
  const results = qs.map((q) => {
    const chosen = Object.prototype.hasOwnProperty.call(a, q.id) && a[q.id] != null ? Number(a[q.id]) : null;
    return { id: q.id, chosen, answer: q.answer, correct: chosen === q.answer, safety: !!q.safety, why: q.why || "" };
  });
  const unanswered = results.filter((r) => r.chosen == null).map((r) => r.id);
  const correct = results.filter((r) => r.correct).length;
  const safetyMissed = results.filter((r) => r.safety && !r.correct).map((r) => r.id);
  const ratio = correct / qs.length;
  const passed = !unanswered.length && !safetyMissed.length && ratio + 1e-9 >= passRatio(quiz);
  return {
    status: unanswered.length ? "incomplete" : "graded",
    passed, total: qs.length, correct, score: Math.round(ratio * 100), results, safetyMissed, unanswered,
  };
}

// ---------- 練習課題（STEP5） ----------
// 判定に使うフィールドは実物に合わせる（scripts/test-learning-core.mjs がソースと照合する）
//   事前確認: support-checklist.js の PRE_ITEMS（supportChecklists/{caseId}.pre.<key>.status）
//   当日:     support-checklist.js の ONSITE_STEPS（.onsite.steps.<key>.done）
//   書類:     case-detail.js の renderDocumentChecklist（documentChecklists/{caseId}.<field> が true）
//   実施:     supportChecklists/{caseId}.performance（date・performerId・mode）
//   初期連絡: activities（caseId 一致・type が電話かメール）。練習用の案件に最初から入るメモ（memo）は数えない
//   訪問予定日: cases.visitDate（"YYYY-MM-DD"）／ステータス: cases.status
export const PRE_KEYS = ["kjId", "password", "securityMail", "cert", "network", "pc", "cardReader", "subsidyIntent"];
export const ONSITE_KEYS = ["portalReg", "certInstall", "mynaApp", "crConnect", "webSetup", "operationTest", "userNotice"];
export const DOC_FIELDS = ["bankbookReady", "serviceConfirmReady", "receiptReady", "webScreenCopyReady", "mynaAppCompatibleConfirmed", "portalAccountAcquired"];
export const FIRST_CONTACT_TYPES = ["phone_in", "phone_out", "email_in", "email_out"];
export const STATUS_DONE_SUPPORT = 8; // 伴走支援実施済

function statusReached(status, target) {
  const s = Number(status);
  if (s === LOST) return false;
  const i = STATUS_ORDER.indexOf(s), t = STATUS_ORDER.indexOf(target);
  return i >= 0 && t >= 0 && i >= t;
}

/**
 * 練習DBの自分の担当の案件を見て、6つの課題の可否を返す。課題ごとに、担当の案件のどれか1件でできていれば可。
 * input: { email, cases:[{_id, assignedUserId, status, visitDate}], activities:[{caseId, type}],
 *          supportChecklists:{ [caseId]: {...} }, documentChecklists:{ [caseId]: {...} } }
 * 戻り値: { items: { firstContact: bool, ... }, cases: 担当の件数, done: できた数, total: 6 }
 */
export function judgePractice(input) {
  const email = String(input?.email || "").toLowerCase();
  const mine = (input?.cases || []).filter((c) => email && String(c.assignedUserId || "").toLowerCase() === email);
  const acts = input?.activities || [];
  const scs = input?.supportChecklists || {};
  const dcs = input?.documentChecklists || {};
  const any = (fn) => mine.some((c) => { try { return !!fn(c, scs[c._id] || {}, dcs[c._id] || {}); } catch (_) { return false; } });
  const items = {
    firstContact: any((c) => acts.some((a) => a.caseId === c._id && FIRST_CONTACT_TYPES.includes(a.type))),
    visitDate: any((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c.visitDate || ""))),
    preCheck: any((c, sc) => PRE_KEYS.every((k) => !!(sc.pre && sc.pre[k] && sc.pre[k].status))),
    onsiteDocs: any((c, sc, dc) => ONSITE_KEYS.every((k) => sc.onsite?.steps?.[k]?.done === true) && DOC_FIELDS.every((f) => dc[f] === true)),
    performance: any((c, sc) => { const p = sc.performance; return p && p.date && p.performerId && p.mode; }),
    status: any((c) => statusReached(c.status, STATUS_DONE_SUPPORT)),
  };
  const done = PRACTICE_TASKS.filter((t) => items[t.key]).length;
  return { items, cases: mine.length, done, total: PRACTICE_TASKS.length };
}
export function practicePassed(progress) {
  const it = progress?.practice?.items || {};
  return PRACTICE_TASKS.every((t) => it[t.key] === true);
}

// ---------- ステップの状態 ----------
export function quizPassed(progress, key) { return toMs(progress?.quizzes?.[key]?.passedAt) != null; }

/**
 * 1ステップの中身（済か・いつ済んだか・内訳）。
 * ctx: { badge }（supportBadges の本人の付与記録。STEP7 はこれで済）、quizzes: QUIZZES
 */
export function stepInfo(step, progress, ctx = {}, quizzes = {}) {
  const p = progress || {};
  if (step.optional) return { done: false, at: null, optional: true };
  if (step.ojt) {
    const b = ctx.badge || null;
    return { done: !!b, at: b ? (toMs(b.grantedDate) ?? toMs(b.createdAt)) : null, badge: b };
  }
  const times = [];
  const videos = (step.videos || []).map((id) => {
    const rec = p.videos?.[id];
    const done = isVideoDone(rec);
    if (done) times.push(toMs(rec.doneAt));
    return { id, done, pct: videoPercent(rec) };
  });
  let quiz = null;
  if (step.quiz) {
    const q = quizzes[step.quiz];
    const rec = p.quizzes?.[step.quiz] || {};
    const passed = quizPassed(p, step.quiz);
    if (passed) times.push(toMs(rec.passedAt));
    quiz = { key: step.quiz, passed, preparing: !hasQuestions(q), best: rec.best ?? null, attempts: rec.attempts || 0, passedAt: rec.passedAt ?? null };
  }
  let pledge = null;
  if (step.pledge) {
    pledge = { done: toMs(p.pledgeAt) != null, at: p.pledgeAt ?? null };
    if (pledge.done) times.push(toMs(p.pledgeAt));
  }
  let practice = null;
  if (step.practice) {
    const passed = practicePassed(p);
    practice = { passed, items: { ...(p.practice?.items || {}) }, checkedAt: p.practice?.checkedAt ?? null };
    if (passed) times.push(toMs(p.practice?.passedAt) ?? toMs(p.practice?.checkedAt));
  }
  const done = videos.every((v) => v.done) && (!quiz || quiz.passed) && (!pledge || pledge.done) && (!practice || practice.passed);
  const ts = times.filter((t) => t != null);
  return { done, at: done && ts.length ? Math.max(...ts) : null, videos, quiz, pledge, practice };
}

/** 7ステップの状態。state: "done"（済）／"current"（いまここ）／"todo"（まだ）／"optional"（任意） */
export function stepStates(progress, ctx = {}, quizzes = {}) {
  let currentSet = false;
  return STEPS.map((step) => {
    const info = stepInfo(step, progress, ctx, quizzes);
    let state;
    if (info.done) state = "done";
    else if (info.optional) state = "optional";
    else if (!currentSet) { state = "current"; currentSet = true; }
    else state = "todo";
    return { step, state, ...info };
  });
}

/** 先頭から続けて済んだ最後の STEP の番号（任意の STEP6 は飛ばす）。1つも済んでいなければ 0 */
export function reachedStep(states) {
  let n = 0;
  for (const s of states) {
    if (s.state === "optional") continue;
    if (s.state !== "done") break;
    n = s.step.no;
  }
  return n;
}

/** OJTに入れるか（STEP1〜5 が全部済。STEP6 は任意） */
export function isReadyForOjt(progress, quizzes = {}) {
  return READY_STEPS.every((id) => stepInfo(findStep(id), progress, {}, quizzes).done);
}

function videoName(id) { const v = findVideo(id); return v ? `${v.label} ${v.title}` : id; }

/** 画面の上に出す「次にやること」1行 */
export function nextAction(progress, ctx = {}, quizzes = {}) {
  if (ctx.badge) return "独り立ちしました。伴走支援者として、単独で伴走支援を担当できます。";
  const states = stepStates(progress, ctx, quizzes);
  const cur = states.find((s) => s.state === "current");
  if (!cur) return "すべてのステップが済みました。";
  const head = `STEP${cur.step.no}「${cur.step.title}」：`;
  if (cur.step.ojt) return "OJTに入れます。トレーナーに連絡して、支援先でのOJT（評価シート）の日程を決めてください。";
  const v = (cur.videos || []).find((x) => !x.done);
  if (v) return `${head}動画「${videoName(v.id)}」を最後まで見る`;
  if (cur.quiz && !cur.quiz.passed) {
    const q = quizzes[cur.quiz.key];
    if (cur.quiz.preparing) return `${head}確認テストは準備中です。できしだい受けてください`;
    return `${head}確認テストを受ける（${passRuleText(q)}）`;
  }
  if (cur.pledge && !cur.pledge.done) return `${head}10の約束を読んで「約束します」を押す`;
  if (cur.practice && !cur.practice.passed) {
    const left = PRACTICE_TASKS.filter((t) => cur.practice.items[t.key] !== true).length;
    return `${head}練習モードで課題をこなして「判定する」を押す（残り${left}つ）`;
  }
  return head;
}

// ---------- 進み具合の更新値（patch） ----------
const isPlain = (o) => o && typeof o === "object" && !Array.isArray(o) && !(o instanceof Date) && typeof o.toMillis !== "function";
/** Firestore の setDoc(merge) と同じ考え方で patch を重ねる（入れ子の map は中身ごとに重ねる） */
export function mergePatch(base, patch) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlain(v) && isPlain(out[k]) ? mergePatch(out[k], v) : v;
  }
  return out;
}

// どの更新にも付ける共通の値（名前・始めた日・最後に進んだ日）と「OJTに入れます」の日時
function finish(progress, patch, me, now, quizzes) {
  const p = progress || {};
  const full = { ...patch, lastAt: now };
  if (me?.name && p.name !== me.name) full.name = me.name;
  if (toMs(p.startedAt) == null) full.startedAt = now;
  const next = mergePatch(p, full);
  if (toMs(p.readyForOjtAt) == null && isReadyForOjt(next, quizzes)) {
    full.readyForOjtAt = now;
    next.readyForOjtAt = now;
  }
  return { patch: full, next };
}

/** 動画の記録（nextVideoRecord の rec）を入れる */
export function applyVideo(progress, me, videoId, rec, now, quizzes = {}) {
  if (!videoId || !rec) return { patch: null, next: progress || {} };
  return finish(progress, { videos: { [videoId]: rec } }, me, now, quizzes);
}

/** テストの結果を入れる。最高点を残す・回数を数える・最初に合格した日時を残す。graded 以外は入れない */
export function applyQuiz(progress, me, key, result, now, quizzes = {}) {
  if (!key || !result || result.status !== "graded") return { patch: null, next: progress || {} };
  const prev = progress?.quizzes?.[key] || {};
  const rec = {
    best: Math.max(Number(prev.best) || 0, result.score),
    lastScore: result.score,
    attempts: (Number(prev.attempts) || 0) + 1,
    lastAt: now,
    passedAt: prev.passedAt ?? (result.passed ? now : null),
  };
  return finish(progress, { quizzes: { [key]: rec } }, me, now, quizzes);
}

/** STEP1 の「約束します」を押せるか（STEP1 の動画3本とテストが済んでいること） */
export function canPledge(progress, quizzes = {}) {
  const info = stepInfo(findStep("S1"), progress, {}, quizzes);
  return info.videos.every((v) => v.done) && !!info.quiz?.passed;
}
/** 「約束します」。押せないときは error。2回目以降は最初の日時のまま（patch なし） */
export function applyPledge(progress, me, now, quizzes = {}) {
  if (toMs(progress?.pledgeAt) != null) return { patch: null, next: progress };
  if (!canPledge(progress, quizzes)) return { error: "STEP1 の動画3本と確認テストが済んでから押せます。", patch: null, next: progress || {} };
  return finish(progress, { pledgeAt: now }, me, now, quizzes);
}

/** 練習課題の判定結果（judgePractice の戻り）を入れる。一度できた課題は「できた」のまま（練習のデータは消えるため） */
export function applyPractice(progress, me, judged, now, quizzes = {}) {
  const prev = progress?.practice || {};
  const items = {};
  for (const t of PRACTICE_TASKS) items[t.key] = prev.items?.[t.key] === true || judged?.items?.[t.key] === true;
  const all = PRACTICE_TASKS.every((t) => items[t.key]);
  const practice = { checkedAt: now, items, cases: Number(judged?.cases) || 0, passedAt: prev.passedAt ?? (all ? now : null) };
  return finish(progress, { practice }, me, now, quizzes);
}

// ---------- 一覧・評価シートの1行 ----------
/** 最後に進んだ日時（lastAt が無い古い文書は中の日時から拾う） */
export function lastProgressAt(progress) {
  const p = progress || {};
  const ts = [toMs(p.lastAt), toMs(p.updatedAt), toMs(p.pledgeAt), toMs(p.practice?.checkedAt)];
  for (const v of Object.values(p.videos || {})) ts.push(toMs(v?.doneAt));
  for (const q of Object.values(p.quizzes || {})) ts.push(toMs(q?.lastAt), toMs(q?.passedAt));
  const ok = ts.filter((t) => t != null);
  return ok.length ? Math.max(...ok) : null;
}

/** トレーナーの一覧の1行 */
export function listRow(progress, ctx = {}, quizzes = {}) {
  const states = stepStates(progress, ctx, quizzes);
  const cur = states.find((s) => s.state === "current");
  const ready = isReadyForOjt(progress, quizzes);
  let stepLabel;
  if (ctx.badge) stepLabel = "独り立ち";
  else if (!progress) stepLabel = "まだ始めていません";
  else if (cur) stepLabel = `STEP${cur.step.no}　${cur.step.title}`;
  else stepLabel = "すべて済";
  return {
    name: progress?.name || ctx.name || ctx.email || "",
    email: ctx.email || "",
    stepNo: ctx.badge ? 8 : cur ? cur.step.no : 8,
    stepLabel, reached: reachedStep(states), ready, badge: ctx.badge || null,
    lastAt: lastProgressAt(progress), started: !!progress, states,
  };
}

/** 評価シートの入力欄に出す1行（警告のみ・保存は止めない） */
export function evaluationLine(progress, badge, quizzes = {}) {
  if (badge) return { text: `育成コース：独り立ち（バッジ付与 ${fmtDate(badge.grantedDate) || badge.grantedDate || ""}）`, warn: false };
  if (!progress) return { text: "育成コース：まだ始めていません。OJTの前の学習（STEP1〜5）が済んでいません（評価の保存はできます）", warn: true };
  if (isReadyForOjt(progress, quizzes)) return { text: "育成コース：STEP5まで済（OJTに入れます）", warn: false };
  const n = reachedStep(stepStates(progress, {}, quizzes));
  return {
    text: `育成コース：${n ? `STEP${n}まで済` : "STEP1の途中"}。OJTの前の学習（STEP1〜5）が済んでいません（評価の保存はできます）`,
    warn: true,
  };
}
