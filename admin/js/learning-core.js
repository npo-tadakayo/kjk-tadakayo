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
import { courseDone, courseWatched, courseQuizPassed, trainerIds, assignmentOf, assignmentStale } from "./trainer-rules.js";

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

// ---------- 保存の直前に、サーバーの最新の記録と照らし合わせる（複数タブ対策・Codex 指摘 2026-10-24） ----------
const earliest = (a, b) => { const x = toMs(a), y = toMs(b); return x == null ? (y == null ? null : b) : (y == null ? a : (y < x ? b : a)); };
/**
 * patch（手元の古い状態から作った更新）を、サーバーの最新の記録 server に対して「達成が減らない」形に直す。
 * 合格・見終わり・約束・OJTに入れますの日時は消さない（早い方を残す）。最高点・視聴位置は大きい方。
 * 回数はサーバーの回数に足す。練習課題は一度できたら「できた」のまま。
 */
export function guardPatch(server, patch) {
  const sv = server || {};
  const out = { ...(patch || {}) };
  if (patch?.videos) {
    out.videos = {};
    for (const [id, r] of Object.entries(patch.videos)) {
      const o = sv.videos?.[id] || {};
      out.videos[id] = { ...r, maxPos: Math.max(Number(o.maxPos) || 0, Number(r?.maxPos) || 0), doneAt: earliest(o.doneAt, r?.doneAt) };
    }
  }
  if (patch?.quizzes) {
    out.quizzes = {};
    for (const [k, r] of Object.entries(patch.quizzes)) {
      const o = sv.quizzes?.[k] || {};
      out.quizzes[k] = { ...r, best: Math.max(Number(o.best) || 0, Number(r?.best) || 0),
        attempts: (Number(o.attempts) || 0) + 1, passedAt: earliest(o.passedAt, r?.passedAt) };
    }
  }
  if (patch?.practice) {
    const o = sv.practice || {}, r = patch.practice;
    const items = {};
    for (const t of PRACTICE_TASKS) items[t.key] = o.items?.[t.key] === true || r.items?.[t.key] === true;
    const all = PRACTICE_TASKS.every((t) => items[t.key]);
    out.practice = { ...r, items, passedAt: earliest(o.passedAt, r.passedAt) ?? (all ? r.checkedAt ?? null : null) };
  }
  for (const k of ["pledgeAt", "startedAt", "readyForOjtAt"]) {
    if (k in out || toMs(sv[k]) != null) {
      const v = earliest(sv[k], out[k]);
      if (v == null) delete out[k]; else out[k] = v;
    }
  }
  return out;
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

// ---------- メンバーの一覧（育成 → 独り立ち → トレーナー → トレーナーコース。2026-11-22） ----------
// 育成コースの画面の下（トレーナー・管理者だけ）に出す表と、その CSV。判定は既存の関数をそのまま使う
// （isReadyForOjt・stepStates・reachedStep・lastProgressAt・nextAction／trainer-rules.js の courseDone・trainerIds）。
// 新しいデータは作らない（読むだけ）。管理者が手で済みにした記録には manualClear（at・by・reason）が付いている。
export const ROLE_LABEL = { admin: "管理者", staff: "スタッフ", viewer: "閲覧のみ", trainee: "練習生", warehouse: "倉庫" };
export const MEMBER_EXCLUDED_ROLES = ["warehouse", "viewer"]; // 一覧に入れないロール（育成の記録か名簿があれば入れる）
export const SUPPORT_MODES = ["solo", "training", "observe"]; // 単独・見守り付き・見学
const lowMail = (s) => String(s || "").trim().toLowerCase();

/** 育成（STEP1〜5）の状況。status: "done"（完了）／"partial"（途中）／"none"（未開始） */
export function trainingSummary(progress, quizzes = {}) {
  const p = progress || null;
  const manual = !!(p && p.manualClear);
  const states = stepStates(p, {}, quizzes);
  if (p && isReadyForOjt(p, quizzes)) {
    const ats = states.filter((s) => READY_STEPS.includes(s.step.id)).map((s) => s.at).filter((t) => t != null);
    const at = toMs(p.readyForOjtAt) ?? (ats.length ? Math.max(...ats) : null);
    return { status: "done", label: "完了", at, reached: 5, practice: null, manual };
  }
  const reached = reachedStep(states);
  const touched = !!p && (reached > 0 || lastProgressAt(p) != null
    || Object.values(p.videos || {}).some((v) => Number(v?.maxPos) > 0));
  if (!touched) return { status: "none", label: "未開始", at: null, reached: 0, practice: null, manual };
  let label = reached ? `STEP${reached}まで済` : "STEP1の途中";
  let practice = null;
  if (reached === 4) { // STEP5（練習課題）が残り
    const it = p.practice?.items || {};
    practice = { done: PRACTICE_TASKS.filter((t) => it[t.key] === true).length, total: PRACTICE_TASKS.length };
    label += `（練習課題 ${practice.done}/${practice.total}）`;
  }
  return { status: "partial", label, at: null, reached, practice, manual };
}

/** トレーナーコースの状況（appConfig/trainerProgram/course/{メール}） */
export function courseSummary(course) {
  const c = course || null;
  const manual = !!(c && c.manualClear);
  if (courseDone(c)) return { status: "done", label: "修了", manual };
  if (courseWatched(c)) return { status: "partial", label: "途中（動画だけ）", manual };
  if (courseQuizPassed(c)) return { status: "partial", label: "途中（テストだけ）", manual };
  return { status: "none", label: "未受講", manual };
}

/** 伴走支援の実施記録（supportChecklists.performance）を人ごとに数える。{ [小文字のメール]: { solo, training, observe } }。1案件1件 */
export function countPerformances(checklists) {
  const out = {};
  for (const sc of Object.values(checklists || {})) {
    const p = sc && sc.performance;
    if (!p || !p.performerId || !SUPPORT_MODES.includes(p.mode)) continue;
    const id = lowMail(p.performerId);
    out[id] = out[id] || { solo: 0, training: 0, observe: 0 };
    out[id][p.mode]++;
  }
  return out;
}

/** 担当の案件のうち「伴走支援実施済」以降（失注を除く）の件数。{ [小文字のメール]: 件数 } */
export function countAssignedDone(cases) {
  const out = {};
  for (const c of cases || []) {
    if (!c || !c.assignedUserId || !statusReached(c.status, STATUS_DONE_SUPPORT)) continue;
    const id = lowMail(c.assignedUserId);
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}

/** 担当の案件を数えるときに読む状態（伴走支援実施済とその先。失注は入れない）。Firestore の "in" に渡す */
export const STATUSES_FROM_DONE_SUPPORT = STATUS_ORDER.slice(STATUS_ORDER.indexOf(STATUS_DONE_SUPPORT)).filter((s) => s !== LOST);

/** 独り立ちの記録（supportBadges）を人ごとに1件へ。1人に複数あればいちばん早い認定。Map（小文字のメール → 記録） */
export function earliestBadges(badges) {
  const out = new Map();
  const at = (b) => toMs(b.grantedDate) ?? toMs(b.createdAt) ?? Infinity;
  for (const b of badges || []) {
    const id = lowMail(b && b.userId);
    if (!id) continue;
    const prev = out.get(id);
    if (!prev || at(b) < at(prev)) out.set(id, b);
  }
  return out;
}

/**
 * 一覧の行を組み立てる。対象は users の有効な人（倉庫・閲覧のみは除く）・learningProgress がある人・トレーナー名簿の人。無効（active:false）は出さない。
 * input: { users:[{_id,name,role,active}], progresses:{ [メール]: 文書 }, badges:[supportBadges], rosterIds,
 *          courses:{ [メール]: 文書 }, checklists:{ [caseId]: supportChecklists }, cases:[{_id,status,assignedUserId}],
 *          assignments:{ [メール]: appConfig/trainerProgram/assignments の文書 } }
 *   row.assignment: { trainerId, trainerName, at, byName, note, stale } か null（stale＝担当が名簿にいない・動けない）
 */
export function memberRows(input, quizzes = {}) {
  const i = input || {};
  const users = i.users || [];
  const userOf = new Map(users.map((u) => [lowMail(u._id), u]));
  const progOf = new Map(Object.entries(i.progresses || {}).map(([k, v]) => [lowMail(k), v]));
  const courseOf = new Map(Object.entries(i.courses || {}).map(([k, v]) => [lowMail(k), v]));
  const roster = new Set(trainerIds(users, i.rosterIds).map(lowMail));
  const perf = countPerformances(i.checklists);
  const assigned = countAssignedDone(i.cases);
  const badgeOf = earliestBadges(i.badges);
  const asgOf = new Map(Object.entries(i.assignments || {}).map(([k, v]) => [lowMail(k), v]));
  const ids = new Set();
  // 倉庫・閲覧のみの人は伴走支援をしないので入れない（2026-11-22 次田さん）。育成の記録がある人・名簿の人は下で入る
  for (const u of users) if (u.active !== false && !MEMBER_EXCLUDED_ROLES.includes(u.role)) ids.add(lowMail(u._id));
  for (const id of progOf.keys()) ids.add(id);
  for (const id of roster) ids.add(id);
  const rows = [];
  for (const id of ids) {
    if (!id) continue;
    const u = userOf.get(id);
    if (u && u.active === false) continue;
    const p = progOf.get(id) || null;
    const b = badgeOf.get(id) || null;
    const training = trainingSummary(p, quizzes);
    const sp = perf[id] || { solo: 0, training: 0, observe: 0 };
    rows.push({
      email: u ? u._id : id,
      name: (u && u.name) || (p && p.name) || id,
      role: u ? (u.role || "") : "",
      roleLabel: u ? (ROLE_LABEL[u.role] || u.role || "—") : "（ユーザー管理にいない）",
      training,
      badge: b ? { at: toMs(b.grantedDate) ?? toMs(b.createdAt), by: b.grantedByName || "",
        basis: b.basis === "discretion" ? "特別裁量" : "評価シート" } : null,
      trainer: roster.has(id),
      course: courseSummary(courseOf.get(id) || null),
      support: sp,
      assignedDone: assigned[id] || 0,
      lastAt: lastProgressAt(p),
      assignment: rowAssignment(asgOf.get(id), users, i.rosterIds),
      // 育成が済んでいない人には、独り立ち済でも育成の続きを出す（DM の文面に使う）
      next: nextAction(p, training.status === "done" ? { badge: b } : {}, quizzes),
    });
  }
  const rank = { done: 0, partial: 1, none: 2 };
  return rows.sort((a, b) => (rank[a.training.status] - rank[b.training.status])
    || (b.training.reached - a.training.reached) || ((b.lastAt || 0) - (a.lastAt || 0))
    || String(a.name).localeCompare(String(b.name), "ja"));
}

function rowAssignment(doc, users, rosterIds) {
  const a = assignmentOf(doc);
  return a ? { ...a, stale: assignmentStale(a, users, rosterIds) } : null;
}
/** 担当トレーナーが実際にいるか（名簿から外れた担当は「いない」と数える） */
export const hasTrainer = (r) => !!(r && r.assignment && !r.assignment.stale);

/** 絞り込み（ボタンの順） */
export const MEMBER_FILTERS = [
  { key: "all", label: "全員", test: () => true },
  { key: "done", label: "育成完了", test: (r) => r.training.status === "done" },
  { key: "ojt", label: "OJT待ち", hint: "育成完了で、独り立ちがまだ", test: (r) => r.training.status === "done" && !r.badge },
  { key: "ojtNoTrainer", label: "OJT待ち・担当なし", hint: "OJT待ちで、担当トレーナーが決まっていない（名簿から外れた担当も含む）",
    test: (r) => r.training.status === "done" && !r.badge && !hasTrainer(r) },
  { key: "partial", label: "途中", test: (r) => r.training.status === "partial" },
  { key: "none", label: "未開始", test: (r) => r.training.status === "none" },
  { key: "gap", label: "伴走支援しているのに育成が未完了",
    hint: "実施の記録（単独・見守り付き）があるか、担当の案件が伴走支援実施済以降なのに、STEP1〜5 が済んでいない",
    test: (r) => r.training.status !== "done" && (r.support.solo + r.support.training > 0 || r.assignedDone > 0) },
  { key: "cand", label: "トレーナー候補", hint: "育成完了・独り立ち済で、トレーナーでない",
    test: (r) => r.training.status === "done" && !!r.badge && !r.trainer },
];
export function filterMembers(rows, key) {
  const f = MEMBER_FILTERS.find((x) => x.key === key) || MEMBER_FILTERS[0];
  return (rows || []).filter(f.test);
}

/** CSV の列（列名は固定。Claude が読んで Chat の DM の宛先と文面を作るため、メールアドレスと次にやることを必ず入れる） */
export const MEMBER_CSV_COLUMNS = [
  ["名前", (r) => r.name],
  ["メールアドレス", (r) => r.email],
  ["ロール", (r) => r.roleLabel],
  ["育成", (r) => r.training.label],
  ["育成完了日", (r) => fmtDate(r.training.at)],
  ["育成_管理者の操作で済み", (r) => (r.training.manual ? "はい" : "")],
  ["独り立ち", (r) => (r.badge ? "済" : "まだ")],
  ["独り立ち認定日", (r) => (r.badge ? fmtDate(r.badge.at) : "")],
  ["独り立ち認定者", (r) => (r.badge ? r.badge.by : "")],
  ["独り立ちの根拠", (r) => (r.badge ? r.badge.basis : "")],
  ["トレーナー", (r) => (r.trainer ? "○" : "")],
  ["トレーナーコース", (r) => r.course.label],
  ["トレーナーコース_管理者の操作で済み", (r) => (r.course.manual ? "はい" : "")],
  ["伴走支援_単独", (r) => r.support.solo],
  ["伴走支援_見守り付き", (r) => r.support.training],
  ["伴走支援_見学", (r) => r.support.observe],
  ["担当案件_伴走支援実施済以降", (r) => r.assignedDone],
  ["担当トレーナー", (r) => (r.assignment ? `${r.assignment.trainerName}${r.assignment.stale ? "（名簿にいない）" : ""}` : "")],
  ["担当トレーナーのメール", (r) => (r.assignment ? r.assignment.trainerId : "")],
  ["担当にした日", (r) => (r.assignment ? fmtDate(r.assignment.at) : "")],
  ["最後に進んだ日", (r) => fmtDate(r.lastAt)],
  ["次にやること", (r) => r.next],
];
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 表計算ソフトで式として動かないように
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** CSV の本文（先頭に BOM。改行は CRLF） */
export function memberCsv(rows) {
  const lines = [MEMBER_CSV_COLUMNS.map(([h]) => csvCell(h)).join(",")];
  for (const r of rows || []) lines.push(MEMBER_CSV_COLUMNS.map(([, f]) => csvCell(f(r))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
