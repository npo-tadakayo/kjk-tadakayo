// ===== 練習モードの代役：トレーナー認定（2026-11-12） =====
// 本物は functions/trainer.js の同名の Callable。判定は同じ trainer-rules.js を使い、書き込み先も同じ形
// （appConfig/trainerCriteria・appConfig/supportTrainers・appConfig/trainerProgram/{talks|certs|course}）にする。
// 違いは「練習DBに書く」ことだけ。本番側を変えたらここも合わせること。
// practice-stubs.js の PRACTICE_STUBS に混ぜて使う（fn.js が練習中に httpsCallable をここへ差し替える）。
// 職員の名簿（users）とロールは、練習中も本番の users で決まる（練習DBに users は置かない）。
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, getProdFirestore, collection, doc, getDoc, getDocs, query, where, addDoc,
  setDoc, runTransaction, serverTimestamp } from "/js/fs.js";
import * as T from "/js/trainer-rules.js";
import { showPracticeNotice } from "/js/practice-stubs.js";

const db = () => getFirestore(getApp());          // 練習モード中なので練習DB
const prod = () => getProdFirestore(getApp());    // users だけ
const cfg = (id) => doc(db(), "appConfig", id);
const sub = (name) => collection(db(), "appConfig", "trainerProgram", name);

function err(code, msg) { const e = new Error(msg); e.code = code; return e; }
const fail = (r) => { throw err("failed-precondition", r.error); };

async function loadUsers() {
  const s = await getDocs(collection(prod(), "users"));
  return s.docs.map((d) => ({ _id: d.id, ...d.data() }));
}
// 本物の requireMember と同じ（練習生・倉庫・閲覧のみ・無効は、指定によって止める）
async function member(allow, users) {
  const email = getAuth(getApp()).currentUser?.email || "";
  const u = users.find((x) => x._id === email);
  if (!u || u.active !== true) throw err("permission-denied", "このアプリの利用権限がありません");
  if (u.role === "trainee") throw err("permission-denied", "練習生のアカウントでは、この操作はできません");
  if (u.role === "warehouse") throw err("permission-denied", "この操作をする権限がありません");
  if (allow === "admin" && u.role !== "admin") throw err("permission-denied", "この操作は管理者だけができます");
  if (allow === "editor" && u.role === "viewer") throw err("permission-denied", "この操作をする権限がありません（閲覧のみの利用者はできません）");
  return { email, name: u.name || email, user: u };
}
async function rosterIds() {
  const s = await getDoc(cfg("supportTrainers"));
  return s.exists() && Array.isArray(s.data().ids) ? s.data().ids : null;
}
function actorOf(me, users, ids) {
  return { id: me.email, name: me.name, isAdmin: me.user.role === "admin", isTrainer: T.isTrainerId(me.email, users, ids) };
}
function targetOf(users, userId) {
  const id = String(userId || "").trim().toLowerCase();
  const u = id ? users.find((x) => String(x._id).toLowerCase() === id) : null;
  return u ? { id: u._id, name: u.name || u._id, active: u.active, role: u.role } : null;
}
async function statsFor(email) {
  const [cl, talks, course, crit] = await Promise.all([
    getDocs(query(collection(db(), "supportChecklists"), where("performance.performerId", "==", email))),
    getDocs(query(sub("talks"), where("userId", "==", email))),
    getDoc(doc(db(), "appConfig", "trainerProgram", "course", email)),
    getDoc(cfg("trainerCriteria")),
  ]);
  const checklists = {};
  cl.docs.forEach((d) => { checklists[d.id] = d.data(); });
  const cases = (await Promise.all(cl.docs.map((d) => getDoc(doc(db(), "cases", d.id)))))
    .filter((s) => s.exists()).map((s) => ({ _id: s.id, status: s.data().status, officeId: s.data().officeId || "" }));
  return {
    stats: {
      supportCount: T.countSupport(email, cases, checklists).count,
      talkCount: T.countTalks(email, talks.docs.map((d) => d.data())),
      courseDone: T.courseDone(course.exists() ? course.data() : null),
    },
    criteria: T.normalizeCriteria(crit.exists() ? crit.data() : null),
  };
}

export const TRAINER_PRACTICE_STUBS = {
  // 本物: trainerSaveCriteria（管理者だけ）
  async trainerSaveCriteria(data) {
    const users = await loadUsers();
    const me = await member("admin", users);
    const r = T.validateCriteriaInput(data);
    if (r.error) fail(r);
    await setDoc(cfg("trainerCriteria"), { ...r.criteria, updatedAt: serverTimestamp(), updatedBy: me.email, updatedByName: me.name });
    showPracticeNotice("条件を保存しました（練習用のデータです）");
    return { ok: true, criteria: r.criteria };
  },
  // 本物: trainerRecordTalk（登録＝管理者・トレーナー／取り消し＝管理者だけ）
  async trainerRecordTalk(data) {
    const users = await loadUsers();
    const me = await member("editor", users);
    const actor = actorOf(me, users, await rosterIds());
    const now = Date.now();
    if (data.action === "void") {
      const id = String(data.talkId || "");
      if (!id || id.includes("/")) throw err("invalid-argument", "取り消す記録を指定してください");
      const ref = doc(sub("talks"), id);
      await runTransaction(db(), async (tx) => {
        const s = await tx.get(ref);
        const r = T.buildTalkVoid({ reason: data.reason }, { actor, talk: s.exists() ? s.data() : null, now });
        if (r.error) fail(r);
        tx.update(ref, r.patch);
      });
      return { ok: true };
    }
    const r = T.buildTalk(data, { actor, target: targetOf(users, data.userId), now });
    if (r.error) fail(r);
    const d = await addDoc(sub("talks"), { ...r.talk, createdAt: serverTimestamp() });
    showPracticeNotice("登壇を記録しました（練習用のデータです）");
    return { ok: true, id: d.id };
  },
  // 本物: trainerCourseSubmit（本人だけ・"watched"／"quiz"）
  async trainerCourseSubmit(data) {
    const users = await loadUsers();
    const me = await member("viewer", users);
    const now = Date.now();
    if (data.action !== "watched" && data.action !== "quiz") throw err("invalid-argument", "操作を指定してください");
    let result = null;
    if (data.action === "quiz") {
      result = T.gradeCourseQuiz(data.answers);
      if (result.status !== "graded") throw err("failed-precondition", `まだ答えていない問題があります（${result.unanswered.length}問）`);
    }
    const ref = doc(db(), "appConfig", "trainerProgram", "course", me.email);
    const course = await runTransaction(db(), async (tx) => {
      const s = await tx.get(ref);
      const cur = s.exists() ? s.data() : {};
      const next = { userId: me.email, userName: me.name, watchedAt: T.toMs(cur.watchedAt), quiz: cur.quiz || null };
      if (data.action === "watched" && next.watchedAt == null) next.watchedAt = now;
      if (result) next.quiz = T.nextCourseQuiz(cur.quiz, result, now);
      tx.set(ref, { ...next, updatedAt: serverTimestamp() });
      return next;
    });
    return { ok: true, course, result: result && { passed: result.passed, score: result.score, correct: result.correct, total: result.total, results: result.results.map((x) => ({ id: x.id, correct: x.correct })) } };
  },
  // 本物: trainerCertify（通常＝トレーナーか管理者・特別裁量＝管理者だけ・自分は不可）
  async trainerCertify(data) {
    const users = await loadUsers();
    const me = await member("editor", users);
    const target = targetOf(users, data.userId);
    const { stats, criteria } = target ? await statsFor(target.id) : { stats: {}, criteria: null };
    const now = Date.now();
    const cref = doc(sub("certs"));
    const cert = await runTransaction(db(), async (tx) => {
      const rs = await tx.get(cfg("supportTrainers"));
      const ids = rs.exists() && Array.isArray(rs.data().ids) ? rs.data().ids : null;
      const r = T.buildCertify(data, { actor: actorOf(me, users, ids), target, inRoster: !!target && T.isTrainerId(target.id, users, ids), stats, criteria, now });
      if (r.error) fail(r);
      tx.set(cref, { ...r.cert, createdAt: serverTimestamp() });
      tx.set(cfg("supportTrainers"), { ids: T.rosterAfter(users, ids, r.cert), updatedAt: serverTimestamp(), updatedBy: me.email }, { merge: true });
      return r.cert;
    });
    showPracticeNotice(`${cert.userName}さんをトレーナー合格にしました（練習用のデータです。本番の名簿は変わりません）`);
    return { ok: true, id: cref.id, cert };
  },
  // 本物: trainerRevoke（管理者だけ・理由必須）
  async trainerRevoke(data) {
    const users = await loadUsers();
    const me = await member("admin", users);
    // 本物と同じ: 利用者一覧から消えた人も、名簿にいれば取り消せる（名前は合格の記録から・2026-11-13 #74 L9）
    const uid = String(data.userId || "").trim();
    const events = !uid || targetOf(users, uid) || uid.includes("/") ? []
      : (await getDocs(query(sub("certs"), where("userId", "in", [...new Set([uid, uid.toLowerCase()])])))).docs.map((d) => d.data());
    const now = Date.now();
    const cref = doc(sub("certs"));
    await runTransaction(db(), async (tx) => {
      const rs = await tx.get(cfg("supportTrainers"));
      const ids = rs.exists() && Array.isArray(rs.data().ids) ? rs.data().ids : null;
      const target = T.revokeTargetOf(users, ids, uid, events);
      const r = T.buildRevoke(data, { actor: actorOf(me, users, ids), target, inRoster: !!target && T.isTrainerId(target.id, users, ids), ...T.revokeCounts(users, ids, target && target.id), now });
      if (r.error) fail(r);
      tx.set(cref, { ...r.cert, createdAt: serverTimestamp() });
      tx.set(cfg("supportTrainers"), { ids: T.rosterAfter(users, ids, r.cert), updatedAt: serverTimestamp(), updatedBy: me.email }, { merge: true });
    });
    showPracticeNotice("トレーナー合格を取り消しました（練習用のデータです。本番の名簿は変わりません）");
    return { ok: true, id: cref.id };
  },
};
