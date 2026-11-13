// トレーナー認定の Callable（functions/trainer.js の trainer*）を Firestore エミュレータに対して実際に動かし、
// サーバーでの権限（管理者／トレーナー／自分自身でないこと）と、書いた記録・名簿を確かめる（2026-11-12）。
// 進め方は scripts/test-warehouse-emu.mjs と同じ（.run() で直接呼ぶ）。
//
// 実行（本番に繋がらない demo- プロジェクト。依存は functions/node_modules をそのまま使う）:
//   export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
//   cd <repo> && firebase emulators:exec --only firestore --project demo-trainer-test "node scripts/test-trainer-emu.mjs"
// 終了コード: 全部合格 0、1件でも不合格 1。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-trainer-test";
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, opts);
  return new Response("blocked in test", { status: 503 });
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(REPO, "functions", "index.js"));
const fns = require(path.join(REPO, "functions", "index.js"));
const admin = require("firebase-admin");
const db = admin.firestore();
const T = await import(path.join(REPO, "admin", "js", "trainer-rules.js"));

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (process.env.TRAINER_EMU_VERBOSE) console.error(`   ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); console.error(`… ${t}`); } // 途中で止まったときに場所が分かるよう、見出しだけ先に出す

const ADMIN = "admin@tadakayo.jp", T1 = "hachisuka@tadakayo.jp", T2 = "fujita@tadakayo.jp";
const CAND = "cand@tadakayo.jp", STAFF = "staff@tadakayo.jp", LEGACY = "legacy@tadakayo.jp";
const VIEWER = "viewer@tadakayo.jp", TRAINEE = "trainee@tadakayo.jp", WH = "wh@tadakayo.jp", OFF = "off@tadakayo.jp";
async function call(name, email, data) {
  try {
    const r = await fns[name].run({ auth: { uid: "uid-" + email, token: { email, name: email } }, data, rawRequest: {} });
    return { ok: true, r };
  } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
const cfg = db.collection("appConfig");
const prog = cfg.doc("trainerProgram");
const roster = async () => { const s = await cfg.doc("supportTrainers").get(); return s.exists ? s.data().ids : null; };
const certs = async () => (await prog.collection("certs").get()).docs.map((d) => d.data());
const talksOf = async (u) => (await prog.collection("talks").where("userId", "==", u).get()).docs.map((d) => ({ _id: d.id, ...d.data() }));

// ---- 初期データ ----
const b = db.batch();
const users = [
  [ADMIN, { active: true, role: "admin", name: "管理 太郎" }],
  [T1, { active: true, role: "staff", name: "蜂須賀 大策" }],   // 初期トレーナー（氏名で照合）
  [T2, { active: true, role: "staff", name: "藤田　博之" }],    // 初期トレーナー（全角スペース）
  [CAND, { active: true, role: "staff", name: "候補 花子" }],
  [STAFF, { active: true, role: "staff", name: "職員 次郎" }],
  [LEGACY, { active: true, name: "ロール未設定" }],
  [VIEWER, { active: true, role: "viewer", name: "閲覧" }],
  [TRAINEE, { active: true, role: "trainee", name: "練習" }],
  [WH, { active: true, role: "warehouse", name: "倉庫", locationIds: ["L1"] }],
  [OFF, { active: false, role: "staff", name: "無効" }],
];
for (const [id, d] of users) b.set(db.collection("users").doc(id), d);
// 候補: 10の事業所で伴走支援実施済（単独8・見守り付き2）＋同じ事業所の2件目・見学・実施済の前（数えない）
for (let i = 1; i <= 10; i++) {
  b.set(db.collection("cases").doc(`c${i}`), { status: i % 2 ? 8 : 12, officeId: `o${i}` });
  b.set(db.collection("supportChecklists").doc(`c${i}`), { performance: { performerId: CAND, mode: i <= 8 ? "solo" : "training", date: "2026-10-01", trainerId: i > 8 ? T1 : null } });
}
b.set(db.collection("cases").doc("c11"), { status: 9, officeId: "o1" });
b.set(db.collection("supportChecklists").doc("c11"), { performance: { performerId: CAND, mode: "solo" } });
b.set(db.collection("cases").doc("c12"), { status: 8, officeId: "o12" });
b.set(db.collection("supportChecklists").doc("c12"), { performance: { performerId: CAND, mode: "observe" } });
b.set(db.collection("cases").doc("c13"), { status: 7, officeId: "o13" });
b.set(db.collection("supportChecklists").doc("c13"), { performance: { performerId: CAND, mode: "solo" } });
// 職員: 3件だけ
for (let i = 21; i <= 23; i++) {
  b.set(db.collection("cases").doc(`c${i}`), { status: 13, officeId: `o${i}` });
  b.set(db.collection("supportChecklists").doc(`c${i}`), { performance: { performerId: STAFF, mode: "solo" } });
}
await b.commit();
const casesBefore = (await db.collection("cases").get()).size;

const ALL = Object.fromEntries(T.COURSE_QUIZ.questions.map((q) => [q.id, q.answer]));
const WRONG = Object.fromEntries(T.COURSE_QUIZ.questions.map((q) => [q.id, (q.answer + 1) % q.choices.length]));

section("条件の設定（trainerSaveCriteria・管理者だけ）");
let r = await call("trainerSaveCriteria", T1, { supportCount: 5, talkCount: 1, combine: "and", requireCourse: true });
check("トレーナー（管理者でない）は変えられない", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("trainerSaveCriteria", TRAINEE, { supportCount: 5, talkCount: 1, combine: "and", requireCourse: true });
check("練習生は変えられない", !r.ok && r.code === "permission-denied" && /練習生/.test(r.msg));
r = await call("trainerSaveCriteria", ADMIN, { supportCount: 0, talkCount: 0, combine: "and", requireCourse: true });
check("管理者でも不正な値は failed-precondition", !r.ok && r.code === "failed-precondition");
check("文書が無いあいだは作られない（既定値で動く）", !(await cfg.doc("trainerCriteria").get()).exists);
r = await call("trainerSaveCriteria", ADMIN, { supportCount: 10, talkCount: 1, combine: "and", requireCourse: true });
const crit = (await cfg.doc("trainerCriteria").get()).data();
check("管理者は保存できる", r.ok && crit.supportCount === 10 && crit.combine === "and" && crit.requireCourse === true && crit.updatedBy === ADMIN, JSON.stringify(r));

section("登壇の記録（trainerRecordTalk・管理者とトレーナー）");
const talk = { userId: CAND, date: "2026-10-20", kind: "municipal", venue: "市の介護事業所向け説明会" };
r = await call("trainerRecordTalk", STAFF, talk);
check("トレーナーでない職員は登録できない", !r.ok && r.code === "failed-precondition" && /管理者とトレーナー/.test(r.msg), JSON.stringify(r));
r = await call("trainerRecordTalk", VIEWER, talk);
check("閲覧のみは登録できない", !r.ok && r.code === "permission-denied");
r = await call("trainerRecordTalk", WH, talk);
check("倉庫の人は登録できない", !r.ok && r.code === "permission-denied");
r = await call("trainerRecordTalk", T2, { ...talk, kind: "other" });
check("その他は理由がないと登録できない", !r.ok && r.code === "failed-precondition" && /理由/.test(r.msg));
r = await call("trainerRecordTalk", T1, talk);
const talkId = r.ok && r.r.id;
let tl = await talksOf(CAND);
check("初期トレーナー（名簿の文書なし・氏名で照合）は登録できる", r.ok && tl.length === 1 && tl[0].recordedById === T1 && tl[0].kind === "municipal", JSON.stringify(r));
r = await call("trainerRecordTalk", T1, { ...talk, date: "2026-10-21", kind: "seminar", venue: "誤登録" });
const wrongId = r.ok && r.r.id;
r = await call("trainerRecordTalk", T1, { action: "void", talkId: wrongId, reason: "誤登録" });
check("トレーナーは登壇の記録を取り消せない", !r.ok && r.code === "failed-precondition" && /管理者だけ/.test(r.msg));
r = await call("trainerRecordTalk", ADMIN, { action: "void", talkId: wrongId, reason: "" });
check("取り消しは理由が必須", !r.ok && r.code === "failed-precondition");
r = await call("trainerRecordTalk", ADMIN, { action: "void", talkId: wrongId, reason: "日付の誤り" });
tl = await talksOf(CAND);
check("管理者は理由を書いて取り消せる（記録は消えない）", r.ok && tl.length === 2 && tl.find((x) => x._id === wrongId).voided === true && T.countTalks(CAND, tl) === 1, JSON.stringify(r));
r = await call("trainerRecordTalk", ADMIN, { action: "void", talkId: "a/b", reason: "x" });
check("おかしな ID は invalid-argument", !r.ok && r.code === "invalid-argument");

section("トレーナーコース（trainerCourseSubmit・本人だけ）");
r = await call("trainerCourseSubmit", TRAINEE, { action: "watched" });
check("練習生は受けられない（本番）", !r.ok && r.code === "permission-denied");
r = await call("trainerCourseSubmit", WH, { action: "watched" });
check("倉庫の人は受けられない", !r.ok && r.code === "permission-denied");
r = await call("trainerCourseSubmit", CAND, { action: "quiz", answers: { "T1-01": 1 } });
check("答えていない問題があると failed-precondition", !r.ok && r.code === "failed-precondition");
r = await call("trainerCourseSubmit", CAND, { action: "quiz", answers: WRONG });
check("不合格の結果も記録される", r.ok && r.r.result.passed === false && r.r.course.quiz.attempts === 1 && r.r.course.quiz.passedAt == null, JSON.stringify(r));
r = await call("trainerCourseSubmit", CAND, { action: "huh" });
check("知らない操作は invalid-argument", !r.ok && r.code === "invalid-argument");

section("トレーナー合格（trainerCertify）");
r = await call("trainerCertify", T1, { userId: CAND, kind: "normal" });
check("コースが未修了だと通常の合格にできない", !r.ok && r.code === "failed-precondition" && /トレーナーコースの修了/.test(r.msg), JSON.stringify(r));
r = await call("trainerCourseSubmit", CAND, { action: "watched" });
const w1 = r.ok && r.r.course.watchedAt;
r = await call("trainerCourseSubmit", CAND, { action: "quiz", answers: ALL });
check("合格すると最初に合格した時刻が入る", r.ok && r.r.result.passed === true && r.r.course.quiz.passedAt > 0 && r.r.course.quiz.attempts === 2 && r.r.course.watchedAt === w1, JSON.stringify(r));
r = await call("trainerCourseSubmit", CAND, { action: "watched" });
check("「見た」を押し直しても最初の時刻のまま", r.ok && r.r.course.watchedAt === w1);
const courseDoc = (await prog.collection("course").doc(CAND).get()).data();
check("コースの記録は appConfig/trainerProgram/course/{メール}", T.courseDone(courseDoc) && courseDoc.userId === CAND);

r = await call("trainerCertify", STAFF, { userId: CAND, kind: "normal" });
check("トレーナーでない職員は合格にできない", !r.ok && r.code === "failed-precondition" && /トレーナーと管理者だけ/.test(r.msg));
r = await call("trainerCertify", VIEWER, { userId: CAND, kind: "normal" });
check("閲覧のみは合格にできない", !r.ok && r.code === "permission-denied");
r = await call("trainerCertify", T1, { userId: CAND, kind: "discretion", reason: "実績" });
check("トレーナーは特別裁量を使えない（管理者だけ）", !r.ok && r.code === "failed-precondition" && /管理者だけ/.test(r.msg));
check("ここまで名簿の文書は作られていない", (await roster()) === null);
r = await call("trainerCertify", T1, { userId: CAND, kind: "normal" });
let rs = await roster();
let cs = await certs();
check("条件を満たした候補をトレーナーが合格にできる", r.ok && r.r.cert.kind === "normal", JSON.stringify(r));
check("記録: 合格日・認定者・種類・件数（事業所単位で10）・登壇1・コース修了", cs.length === 1 && cs[0].type === "certify" && cs[0].byId === T1 && cs[0].supportCount === 10 && cs[0].talkCount === 1 && cs[0].courseDone === true && /^\d{4}-\d{2}-\d{2}$/.test(cs[0].date), JSON.stringify(cs));
check("名簿ができ、初期の2名（氏名で照合）が外れずに候補が入る", Array.isArray(rs) && rs.length === 3 && rs.includes(T1) && rs.includes(T2) && rs.includes(CAND), JSON.stringify(rs));
r = await call("trainerCertify", T2, { userId: CAND, kind: "normal" });
check("すでにトレーナーの人は合格にできない", !r.ok && /すでにトレーナー/.test(r.msg));
r = await call("trainerCertify", CAND, { userId: CAND, kind: "normal" });
check("自分で自分は合格にできない", !r.ok && /自分で自分/.test(r.msg));
r = await call("trainerCertify", ADMIN, { userId: ADMIN, kind: "discretion", reason: "x" });
check("管理者でも自分を特別裁量で合格にできない", !r.ok && /自分で自分/.test(r.msg));
r = await call("trainerCertify", CAND, { userId: STAFF, kind: "normal" });
check("合格したばかりのトレーナーでも、条件を満たさない人は通常の合格にできない", !r.ok && /条件を満たしていません（伴走支援 あと7件・登壇 あと1回・トレーナーコースの修了）/.test(r.msg), JSON.stringify(r));
r = await call("trainerCertify", ADMIN, { userId: STAFF, kind: "discretion", reason: "" });
check("特別裁量は理由が必須", !r.ok && /理由/.test(r.msg));
r = await call("trainerCertify", ADMIN, { userId: VIEWER, kind: "discretion", reason: "x" });
check("閲覧のみのロールの人はトレーナーにできない", !r.ok && /トレーナーにできません/.test(r.msg));
r = await call("trainerCertify", ADMIN, { userId: OFF, kind: "discretion", reason: "x" });
check("無効の人はトレーナーにできない", !r.ok && /トレーナーにできません/.test(r.msg));
r = await call("trainerCertify", ADMIN, { userId: "nobody@tadakayo.jp", kind: "discretion", reason: "x" });
check("登録の無い人は選べない", !r.ok && /選んで/.test(r.msg));
r = await call("trainerCertify", ADMIN, { userId: STAFF, kind: "discretion", reason: "自治体研修の講師を長く務めている" });
cs = await certs();
const disc = cs.find((c) => c.userId === STAFF);
check("管理者は条件を満たさない人を特別裁量で合格にできる（通常と区別して記録）", r.ok && disc && disc.kind === "discretion" && disc.meets === false && disc.supportCount === 3 && disc.reason === "自治体研修の講師を長く務めている", JSON.stringify(r));
rs = await roster();
check("名簿に入る", rs.includes(STAFF) && rs.length === 4);
r = await call("trainerRecordTalk", CAND, { userId: LEGACY, date: "2026-11-01", kind: "study", venue: "社内勉強会" });
check("合格した人は登壇の記録を登録できるようになる", r.ok, JSON.stringify(r));

section("取り消し（trainerRevoke・管理者だけ）");
r = await call("trainerRevoke", T1, { userId: CAND, reason: "x" });
check("トレーナーは取り消せない", !r.ok && r.code === "permission-denied");
r = await call("trainerRevoke", ADMIN, { userId: CAND, reason: " " });
check("理由が必須", !r.ok && r.code === "failed-precondition");
r = await call("trainerRevoke", ADMIN, { userId: LEGACY, reason: "x" });
check("トレーナーでない人は取り消せない", !r.ok && /いまトレーナーではありません/.test(r.msg));
r = await call("trainerRevoke", ADMIN, { userId: CAND, reason: "本人の申し出で休止" });
rs = await roster(); cs = await certs();
check("取り消すと名簿から外れる", r.ok && !rs.includes(CAND) && rs.length === 3, JSON.stringify({ r, rs }));
check("記録は消さず「取り消し」を足す", cs.filter((c) => c.userId === CAND).length === 2 && cs.some((c) => c.userId === CAND && c.type === "revoke" && c.reason === "本人の申し出で休止" && c.byId === ADMIN));
check("出どころの判定は「取り消し」", T.certOrigin(CAND, cs, false) === "revoked" && T.certOrigin(T1, cs, true) === "initial" && T.certOrigin(STAFF, cs, true) === "discretion");
r = await call("trainerRecordTalk", CAND, { userId: LEGACY, date: "2026-11-01", kind: "study", venue: "社内勉強会" });
check("取り消された人は登壇の記録を登録できない", !r.ok && /管理者とトレーナー/.test(r.msg));
r = await call("trainerCertify", T1, { userId: CAND, kind: "normal" });
check("取り消したあと、条件を満たしていれば合格にし直せる", r.ok && (await roster()).includes(CAND), JSON.stringify(r));

section("利用者一覧から消えた・無効の人を名簿から取り消す（#74 レビュー L9・2026-11-13）");
const GONE = "gone@tadakayo.jp";
await db.collection("users").doc(GONE).set({ active: true, role: "staff", name: "退職 予定" });
r = await call("trainerCertify", ADMIN, { userId: GONE, kind: "discretion", reason: "テスト" });
check("（準備）特別裁量で名簿に入れる", r.ok && (await roster()).includes(GONE), JSON.stringify(r));
await db.collection("users").doc(GONE).delete();
let usersNow = (await db.collection("users").get()).docs.map((d) => ({ _id: d.id, ...d.data() }));
check("名簿に残っている動けない人として拾える", T.staleRosterEntries(usersNow, await roster()).some((x) => x.id === GONE && x.why === "missing"));
r = await call("trainerRevoke", T1, { userId: GONE, reason: "退職" });
check("トレーナーは取り消せない（管理者だけ）", !r.ok && r.code === "permission-denied");
r = await call("trainerRevoke", ADMIN, { userId: GONE, reason: "" });
check("理由が必須", !r.ok && r.code === "failed-precondition" && /理由/.test(r.msg), JSON.stringify(r));
const before = (await roster()).length;
r = await call("trainerRevoke", ADMIN, { userId: GONE.toUpperCase(), reason: "退職のため" });
rs = await roster(); cs = await certs();
const gRev = cs.find((c) => c.userId === GONE && c.type === "revoke");
check("利用者一覧にいない人も、管理者は理由を書いて名簿から取り消せる", r.ok && !rs.includes(GONE) && rs.length === before - 1, JSON.stringify({ r, rs }));
check("取り消しの記録の名前は合格の記録から（メールの大文字小文字は名簿のまま）", gRev && gRev.userName === "退職 予定" && gRev.reason === "退職のため" && gRev.byId === ADMIN, JSON.stringify(gRev));
check("合格の記録は消えない", cs.some((c) => c.userId === GONE && c.type === "certify"));
r = await call("trainerRevoke", ADMIN, { userId: GONE, reason: "二度目" });
check("名簿にも利用者一覧にもいない人は取り消せない", !r.ok && /選んで/.test(r.msg), JSON.stringify(r));
r = await call("trainerRevoke", ADMIN, { userId: "a/b", reason: "x" });
check("おかしな ID は取り消せない", !r.ok && r.code === "failed-precondition");
await db.collection("users").doc(T2).update({ active: false });
usersNow = (await db.collection("users").get()).docs.map((d) => ({ _id: d.id, ...d.data() }));
check("無効にした人も拾える", T.staleRosterEntries(usersNow, await roster()).some((x) => x.id === T2 && x.why === "inactive"));
r = await call("trainerRevoke", ADMIN, { userId: T2, reason: "無効にしたため" });
check("無効にした人も名簿から取り消せる", r.ok && !(await roster()).includes(T2), JSON.stringify(r));
r = await call("trainerRecordTalk", T2, { userId: LEGACY, date: "2026-11-01", kind: "study", venue: "社内勉強会" });
check("無効の人は（名簿に関係なく）操作できない", !r.ok && r.code === "permission-denied");

section("書き込みは appConfig の下だけ");
check("案件の件数は変わらない", (await db.collection("cases").get()).size === casesBefore);
const cl1 = (await db.collection("supportChecklists").doc("c1").get()).data();
check("伴走支援の記録は書き換えない", cl1.performance.performerId === CAND && Object.keys(cl1).length === 1);

console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
