// functions/trainer.js — トレーナー認定の Callable（2026-11-12）
// 計画と決定: 06_介護情報基盤事業/docs/トレーナーコース_計画_20261110.md §3・§7（ト1〜ト8）
//
//   trainerSaveCriteria … 条件（appConfig/trainerCriteria）を変える。管理者だけ
//   trainerRecordTalk   … 登壇の記録を足す（管理者・トレーナー）／取り消す（action:"void"・管理者だけ・理由必須）
//   trainerCourseSubmit … トレーナーコースの「動画を見た」（action:"watched"）と確認テストの採点（action:"quiz"）。本人だけ
//   trainerCertify      … トレーナー合格。通常＝トレーナーか管理者（条件を満たす人だけ）／特別裁量＝管理者だけ・理由必須。自分は不可
//   trainerRevoke       … 合格の取り消し。管理者だけ・理由必須。名簿から外し、記録は消さず「取り消し」を足す
//                         利用者一覧から消えた（削除）・無効・ロール変更の人も、名簿にいれば取り消せる（2026-11-13 #74 L9）
//
// 置き場（firestore.rules は変えない）:
//   appConfig/trainerCriteria・appConfig/supportTrainers（名簿）・appConfig/trainerProgram/{talks|certs|course}/{id}
//   appConfig の下は「登録スタッフは読める・画面からは書けない（管理者は appConfig/{docId} の1段目だけ書ける）」
//   （firestore.rules の match /appConfig/{docId} と、最後の match /{coll}/{document=**} の書き込み除外）。
//   書き込みはすべてここ（Admin SDK）で、権限をサーバーで確かめてから行う。
// 判定は trainer-rules.mjs（正本 admin/js/trainer-rules.js のコピー・scripts/check-shared-sync.sh で照合）。
// 事業所名・利用者の情報はログに出さない（ログに出すのは件数とメールだけ）。

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
// serverTimestamp は firebase-admin/firestore から取る（admin.firestore.FieldValue は Functions エミュレーターの
// 差し替えの下で undefined になることがあった・2026-11-12 ローカルの画面確認で発見）
const { FieldValue } = require("firebase-admin/firestore");
const Flow = require("./accept-flow"); // roleAllows（index.js の requireStaff と同じ判定）

const REGION = "asia-northeast1";
const SA_BATCH = "fn-batch-sa@kjk-tadakayo.iam.gserviceaccount.com"; // index.js と同じ専用SA（datastore.user）
const OPTS = { region: REGION, timeoutSeconds: 60, serviceAccount: SA_BATCH };

let _tr;
const loadRules = () => (_tr ||= import("./trainer-rules.mjs"));
const fdb = () => admin.firestore();

const ref = {
  criteria: () => fdb().collection("appConfig").doc("trainerCriteria"),
  roster: () => fdb().collection("appConfig").doc("supportTrainers"),
  talks: () => fdb().collection("appConfig").doc("trainerProgram").collection("talks"),
  certs: () => fdb().collection("appConfig").doc("trainerProgram").collection("certs"),
  course: (email) => fdb().collection("appConfig").doc("trainerProgram").collection("course").doc(email),
};

// ===== 認可（index.js の requireStaff と同じ考え方。練習生・倉庫・未登録・無効は通さない） =====
async function requireMember(request, allow = "editor") {
  const email = String(request.auth?.token?.email || "").trim();
  if (!email || !email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
  let snap;
  try {
    snap = await fdb().collection("users").doc(email).get();
    if (!snap.exists && email.toLowerCase() !== email) snap = await fdb().collection("users").doc(email.toLowerCase()).get();
  } catch (e) {
    console.error("trainer: users の読み取りに失敗", e && e.code);
    throw new HttpsError("internal", "権限の確認に失敗しました");
  }
  const user = snap.exists ? snap.data() : null;
  if (user && user.role === "trainee") {
    throw new HttpsError("permission-denied", "練習生のアカウントでは本番の操作はできません（練習モードで操作してください）");
  }
  if (!Flow.roleAllows(user, allow)) {
    throw new HttpsError("permission-denied", allow === "admin" ? "この操作は管理者だけができます"
      : "この操作をする権限がありません（閲覧のみ・倉庫・未登録・無効の利用者はできません）");
  }
  return { email: snap.id, user, name: user.name || email };
}

async function loadUsers() {
  const s = await fdb().collection("users").get();
  return s.docs.map((d) => ({ _id: d.id, ...d.data() }));
}
async function loadRosterIds(tx) {
  const s = tx ? await tx.get(ref.roster()) : await ref.roster().get();
  return s.exists && Array.isArray(s.data().ids) ? s.data().ids : null;
}
function actorOf(me, users, rosterIds, tr) {
  return { id: me.email, name: me.name, isAdmin: me.user.role === "admin", isTrainer: tr.isTrainerId(me.email, users, rosterIds) };
}
function targetOf(users, userId) {
  const id = String(userId || "").trim().toLowerCase();
  if (!id) return null;
  const u = users.find((x) => String(x._id).toLowerCase() === id);
  return u ? { id: u._id, name: u.name || u._id, active: u.active, role: u.role } : null;
}
const fail = (r) => { throw new HttpsError("failed-precondition", r.error); };

// その人の件数（伴走支援・登壇）とコースの修了を、本番の記録から数える（画面の数字を信用しない）
async function statsFor(email, tr) {
  const [cl, talks, course, criteriaSnap] = await Promise.all([
    fdb().collection("supportChecklists").where("performance.performerId", "==", email).get(),
    ref.talks().where("userId", "==", email).get(),
    ref.course(email).get(),
    ref.criteria().get(),
  ]);
  const checklists = {};
  cl.docs.forEach((d) => { checklists[d.id] = d.data(); });
  const caseRefs = cl.docs.map((d) => fdb().collection("cases").doc(d.id));
  const caseSnaps = caseRefs.length ? await fdb().getAll(...caseRefs) : [];
  const cases = caseSnaps.filter((s) => s.exists).map((s) => ({ _id: s.id, status: s.get("status"), officeId: s.get("officeId") || "" }));
  return {
    stats: {
      supportCount: tr.countSupport(email, cases, checklists).count,
      talkCount: tr.countTalks(email, talks.docs.map((d) => d.data())),
      courseDone: tr.courseDone(course.exists ? course.data() : null),
    },
    criteria: tr.normalizeCriteria(criteriaSnap.exists ? criteriaSnap.data() : null),
  };
}

// 入力 { supportCount, talkCount, combine:"and"|"or", requireCourse:boolean } → { ok, criteria }
exports.trainerSaveCriteria = onCall(OPTS, async (request) => {
  const me = await requireMember(request, "admin");
  const tr = await loadRules();
  const r = tr.validateCriteriaInput(request.data || {});
  if (r.error) fail(r);
  await ref.criteria().set({ ...r.criteria, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.email, updatedByName: me.name });
  console.log("trainerSaveCriteria", me.email, JSON.stringify(r.criteria));
  return { ok: true, criteria: r.criteria };
});

// 入力 { userId, date, kind, venue, reason } → { ok, id }
//      { action:"void", talkId, reason }（管理者だけ）→ { ok }
exports.trainerRecordTalk = onCall(OPTS, async (request) => {
  const me = await requireMember(request, "editor");
  const tr = await loadRules();
  const data = request.data || {};
  const users = await loadUsers();
  const rosterIds = await loadRosterIds();
  const actor = actorOf(me, users, rosterIds, tr);
  const now = Date.now();
  if (data.action === "void") {
    const id = String(data.talkId || "");
    if (!id || id.includes("/")) throw new HttpsError("invalid-argument", "取り消す記録を指定してください");
    const tref = ref.talks().doc(id);
    await fdb().runTransaction(async (tx) => {
      const s = await tx.get(tref);
      const r = tr.buildTalkVoid({ reason: data.reason }, { actor, talk: s.exists ? s.data() : null, now });
      if (r.error) fail(r);
      tx.update(tref, r.patch);
    });
    console.log("trainerRecordTalk void", me.email, id);
    return { ok: true };
  }
  const r = tr.buildTalk(data, { actor, target: targetOf(users, data.userId), now });
  if (r.error) fail(r);
  const d = await ref.talks().add({ ...r.talk, createdAt: FieldValue.serverTimestamp() });
  console.log("trainerRecordTalk add", me.email, "→", r.talk.userId, r.talk.kind);
  return { ok: true, id: d.id };
});

// 入力 { action:"watched" } または { action:"quiz", answers:{ 問題ID: 選択肢の元の番号 } }
// → { ok, course, result?:{ passed, score, correct, total, results:[{id, correct}] } }
exports.trainerCourseSubmit = onCall(OPTS, async (request) => {
  const me = await requireMember(request, "viewer"); // 練習生以外のスタッフなら誰でも受けられる（本人の記録だけ）
  const tr = await loadRules();
  const data = request.data || {};
  const now = Date.now();
  const cref = ref.course(me.email);
  if (data.action !== "watched" && data.action !== "quiz") throw new HttpsError("invalid-argument", "操作を指定してください");
  let result = null;
  if (data.action === "quiz") {
    result = tr.gradeCourseQuiz(data.answers);
    if (result.status !== "graded") throw new HttpsError("failed-precondition", `まだ答えていない問題があります（${result.unanswered.length}問）`);
  }
  const course = await fdb().runTransaction(async (tx) => {
    const s = await tx.get(cref);
    const cur = s.exists ? s.data() : {};
    const next = { userId: me.email, userName: me.name, watchedAt: tr.toMs(cur.watchedAt), quiz: cur.quiz || null };
    if (data.action === "watched" && next.watchedAt == null) next.watchedAt = now;
    if (result) next.quiz = tr.nextCourseQuiz(cur.quiz, result, now);
    tx.set(cref, { ...next, updatedAt: FieldValue.serverTimestamp() });
    return next;
  });
  return { ok: true, course, result: result && { passed: result.passed, score: result.score, correct: result.correct, total: result.total, results: result.results.map((x) => ({ id: x.id, correct: x.correct })) } };
});

// 入力 { userId, kind:"normal"|"discretion", reason } → { ok, id, cert }
exports.trainerCertify = onCall(OPTS, async (request) => {
  const me = await requireMember(request, "editor");
  const tr = await loadRules();
  const data = request.data || {};
  const users = await loadUsers();
  const target = targetOf(users, data.userId);
  const { stats, criteria } = target ? await statsFor(target.id, tr) : { stats: {}, criteria: null };
  const now = Date.now();
  const cref = ref.certs().doc();
  const out = await fdb().runTransaction(async (tx) => {
    const rosterIds = await loadRosterIds(tx);
    const actor = actorOf(me, users, rosterIds, tr);
    const inRoster = !!target && tr.isTrainerId(target.id, users, rosterIds);
    const r = tr.buildCertify(data, { actor, target, inRoster, stats, criteria, now });
    if (r.error) fail(r);
    const ids = tr.rosterAfter(users, rosterIds, r.cert);
    tx.set(cref, { ...r.cert, createdAt: FieldValue.serverTimestamp() });
    tx.set(ref.roster(), { ids, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.email }, { merge: true });
    return r.cert;
  });
  console.log("trainerCertify", me.email, "→", out.userId, out.kind, `support=${out.supportCount} talk=${out.talkCount} course=${out.courseDone}`);
  return { ok: true, id: cref.id, cert: out };
});

// 入力 { userId, reason } → { ok, id }
exports.trainerRevoke = onCall(OPTS, async (request) => {
  const me = await requireMember(request, "admin");
  const tr = await loadRules();
  const data = request.data || {};
  const users = await loadUsers();
  // 利用者一覧から消えた人（削除）も、名簿にいれば取り消せる（#74 レビュー L9・2026-11-13）。名前は合格の記録から引く
  const uid = String(data.userId || "").trim();
  const inUsers = !!targetOf(users, uid);
  const events = !uid || inUsers || uid.includes("/") ? []
    : (await ref.certs().where("userId", "in", [...new Set([uid, uid.toLowerCase()])]).get()).docs.map((d) => d.data());
  const now = Date.now();
  const cref = ref.certs().doc();
  let target = null;
  const out = await fdb().runTransaction(async (tx) => {
    const rosterIds = await loadRosterIds(tx);
    const actor = actorOf(me, users, rosterIds, tr);
    target = tr.revokeTargetOf(users, rosterIds, uid, events);
    const inRoster = !!target && tr.isTrainerId(target.id, users, rosterIds);
    const r = tr.buildRevoke(data, { actor, target, inRoster, ...tr.revokeCounts(users, rosterIds, target && target.id), now });
    if (r.error) fail(r);
    tx.set(cref, { ...r.cert, createdAt: FieldValue.serverTimestamp() });
    tx.set(ref.roster(), { ids: tr.rosterAfter(users, rosterIds, r.cert), updatedAt: FieldValue.serverTimestamp(), updatedBy: me.email }, { merge: true });
    return r.cert;
  });
  console.log("trainerRevoke", me.email, "→", out.userId, target && target.missing ? "(利用者一覧にいない人)" : "");
  return { ok: true, id: cref.id };
});
