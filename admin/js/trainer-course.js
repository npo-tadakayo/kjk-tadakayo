// admin/js/trainer-course.js — トレーナーコース（/trainer-course.html・2026-11-12）
// 計画と決定: 06_介護情報基盤事業/docs/トレーナーコース_計画_20261110.md §3.5・§7 ト5
//   ・動画は共有ドライブ「トレーナーコース」（CRM ではリンクだけ）。見たことは本人が申告する
//   ・確認テスト（trainer-rules.js の COURSE_QUIZ）。採点と記録はサーバー（trainerCourseSubmit）。画面は答えを送るだけ
//   ・記録の置き場は appConfig/trainerProgram/course/{メール}（読むのは登録スタッフ・書くのは Callable だけ）
//   ・見られるのは練習生以外（トレーナー・候補・管理者）。練習生には案内だけ出す
//   ・練習モードでは練習DBを読み、代役（practice-stubs-trainer.js）が練習DBに書く（本番の修了にはならない）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, isPracticeMode, collection, doc, getDoc, getDocs, query, where } from "/js/fs.js";
import { getFunctions, httpsCallable } from "/js/fn.js";
import { gateRole, showAccessDenied } from "/js/role.js";
import * as T from "/js/trainer-rules.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, "asia-northeast1");
const submit = (data) => httpsCallable(fns, "trainerCourseSubmit")(data).then((r) => r.data);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(m) { const t = $("toast"); t.textContent = m; t.style.display = "block"; clearTimeout(t._t); t._t = setTimeout(() => { t.style.display = "none"; }, 3000); }
const errText = (e) => String((e && e.message) || e || "").replace(/^FirebaseError:\s*/, "") || "うまくいきませんでした。時間をおいてもう一度お試しください。";
const fmt = (v) => { const ms = T.toMs(v); return ms == null ? "" : new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "); };

let me = { email: "" };
let course = null;
let quiz = null; // { order: { 問題ID: [元の番号...] }, answers: {}, result }

function shuffle(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function renderStatus() {
  const done = T.courseDone(course);
  const el = $("status");
  el.className = `tc-status${done ? " done" : ""}`;
  el.innerHTML = done
    ? `<i class="ti ti-circle-check-filled" style="color:#3d7a2a" aria-hidden="true"></i><div><strong>修了しています</strong>（動画 ${esc(fmt(course.watchedAt))}・テスト合格 ${esc(fmt(course.quiz.passedAt))}）</div>`
    : `<i class="ti ti-flag-3" style="color:#c99a00" aria-hidden="true"></i><div><strong>まだ修了していません</strong>（${T.courseWatched(course) ? "動画 済" : "動画 まだ"}・${T.courseQuizPassed(course) ? "テスト 合格" : "テスト まだ"}）。下の1と2を済ませると修了です。</div>`;
}

function renderWatch() {
  const w = T.courseWatched(course);
  $("watchArea").innerHTML = w
    ? `<p><span class="tc-ok"><i class="ti ti-circle-check-filled" aria-hidden="true"></i> 見ました</span>（${esc(fmt(course.watchedAt))} に記録）</p>`
    : `<label class="tc-c" style="max-width:520px"><input type="checkbox" id="watchChk"><span>「01 新人の見守り方」を最後まで見ました</span></label>
       <div class="tc-row"><button type="button" class="btn btn-primary" id="watchBtn" disabled data-tip="動画を最後まで見たことを記録します（自己申告）。押した日時が残ります。記録したあとで取り消すことはできません。"><i class="ti ti-check" aria-hidden="true"></i>見たことを記録する</button></div>`;
  const chk = $("watchChk"), btn = $("watchBtn");
  if (chk && btn) {
    chk.addEventListener("change", () => { btn.disabled = !chk.checked; });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try { const r = await submit({ action: "watched" }); course = r.course; toast("動画を見たことを記録しました"); render(); }
      catch (e) { toast(errText(e)); btn.disabled = false; }
    });
  }
}

function renderQuiz() {
  const q = T.COURSE_QUIZ;
  const rec = course && course.quiz;
  const head = T.courseQuizPassed(course)
    ? `<p><span class="tc-ok"><i class="ti ti-circle-check-filled" aria-hidden="true"></i> 合格しました</span>（${esc(fmt(rec.passedAt))}・最高 ${esc(rec.best)}%・${esc(rec.attempts)}回）。何度でも受け直せます。</p>`
    : `<p>${esc(T.coursePassText(q))}。何度でも受け直せます。${rec ? `（これまで ${esc(rec.attempts)}回・最高 ${esc(rec.best)}%）` : ""}</p>`;
  if (!quiz) {
    $("quizArea").innerHTML = `${head}<div class="tc-row"><button type="button" class="btn btn-primary" id="quizStart" data-tip="確認テストを始めます。選択肢の順番は毎回入れ替わります。"><i class="ti ti-pencil" aria-hidden="true"></i>確認テストを受ける</button></div>`;
    $("quizStart").addEventListener("click", () => {
      quiz = { order: Object.fromEntries(q.questions.map((x) => [x.id, shuffle(x.choices.length)])), answers: {}, result: null };
      renderQuiz();
      const first = document.querySelector('#quizArea input[type="radio"]'); if (first) first.focus();
    });
    return;
  }
  const res = quiz.result;
  const byId = res ? Object.fromEntries(res.results.map((r) => [r.id, r])) : {};
  const body = q.questions.map((x, i) => {
    const r = byId[x.id];
    const choices = quiz.order[x.id].map((idx) => {
      const chosen = quiz.answers[x.id] === idx;
      const cls = r ? (idx === x.answer ? " right" : chosen ? " wrong" : "") : "";
      return `<label class="tc-c${cls}"><input type="radio" name="q-${esc(x.id)}" value="${idx}" data-q="${esc(x.id)}" ${chosen ? "checked" : ""} ${r ? "disabled" : ""}><span>${esc(x.choices[idx])}</span></label>`;
    }).join("");
    const why = r ? `<p class="tc-why" role="note">${r.correct ? '<strong class="tc-ok">正解</strong>' : '<strong style="color:#9b1f1f">不正解</strong>'}　${esc(x.why)}</p>` : "";
    return `<fieldset class="tc-q"><legend>問${i + 1}　${esc(x.q)}</legend>${choices}${why}</fieldset>`;
  }).join("");
  const foot = res
    ? `<p class="tc-ok" role="status" style="${res.passed ? "" : "color:#9b1f1f"}">${res.passed ? "合格です" : "もう少しです"}　${res.correct}／${res.total}問 正解（${res.score}%）</p>
       <div class="tc-row"><button type="button" class="btn btn-secondary" id="quizRetry" data-tip="選択肢の順番を入れ替えて、もう一度受けます。"><i class="ti ti-refresh" aria-hidden="true"></i>もう一度受ける</button>
       <button type="button" class="btn btn-secondary" id="quizClose" data-tip="テストを閉じます。結果はすでに記録されています。">閉じる</button></div>`
    : `<div class="tc-row"><button type="button" class="btn btn-primary" id="quizGrade" data-tip="答えを送って採点します。結果（最高点・回数・合格した日時）が記録されます。"><i class="ti ti-check" aria-hidden="true"></i>答え合わせ</button>
       <span id="quizMsg" role="alert" style="font-size:13px;color:var(--color-danger)"></span></div>`;
  $("quizArea").innerHTML = `${head}${body}${foot}`;
  $("quizArea").querySelectorAll('input[type="radio"]').forEach((el) => el.addEventListener("change", () => {
    quiz.answers[el.dataset.q] = Number(el.value);
    const m = $("quizMsg"); if (m) m.textContent = "";
  }));
  const g = $("quizGrade");
  if (g) g.addEventListener("click", async () => {
    const pre = T.gradeCourseQuiz(quiz.answers);
    if (pre.status === "incomplete") { $("quizMsg").textContent = `まだ答えていない問題があります（${pre.unanswered.length}問）`; return; }
    g.disabled = true;
    try {
      const r = await submit({ action: "quiz", answers: quiz.answers });
      course = r.course; quiz.result = r.result;
      render();
      toast(r.result.passed ? "確認テストに合格しました" : "結果を記録しました");
    } catch (e) { $("quizMsg").textContent = errText(e); g.disabled = false; }
  });
  const rt = $("quizRetry"); if (rt) rt.addEventListener("click", () => { quiz = null; renderQuiz(); $("quizStart").click(); });
  const cl = $("quizClose"); if (cl) cl.addEventListener("click", () => { quiz = null; renderQuiz(); });
}

async function renderMine() {
  try {
    const [cl, talks, crit] = await Promise.all([
      getDocs(query(collection(db, "supportChecklists"), where("performance.performerId", "==", me.email))),
      getDocs(query(collection(db, "appConfig", "trainerProgram", "talks"), where("userId", "==", me.email))),
      getDoc(doc(db, "appConfig", "trainerCriteria")),
    ]);
    const checklists = {}; cl.docs.forEach((d) => { checklists[d.id] = d.data(); });
    const snaps = await Promise.all(cl.docs.map((d) => getDoc(doc(db, "cases", d.id)).catch(() => null)));
    const cases = snaps.filter((s) => s && s.exists()).map((s) => ({ _id: s.id, status: s.data().status, officeId: s.data().officeId || "" }));
    const c = T.normalizeCriteria(crit.exists() ? crit.data() : null);
    const stats = { supportCount: T.countSupport(me.email, cases, checklists).count, talkCount: T.countTalks(me.email, talks.docs.map((d) => d.data())), courseDone: T.courseDone(course) };
    const j = T.judge(stats, c);
    const li = (ok, text) => `<li><i class="ti ${ok ? "ti-circle-check-filled" : "ti-circle"}" style="color:${ok ? "#2f6420" : "#9a8e78"}" aria-hidden="true"></i><span>${esc(text)}</span></li>`;
    $("mineArea").innerHTML = `<p style="margin:0 0 6px">条件：${esc(T.criteriaText(c))}</p>
      <ul class="tc-stats">
        ${li(j.supportOk, `伴走支援 ${stats.supportCount} / ${c.supportCount} 件（案件〔事業所〕単位・あなたが実施者で「伴走支援実施済」以降）`)}
        ${li(j.talkOk, `登壇（または類似のもの） ${stats.talkCount} / ${c.talkCount} 回（記録するのは管理者・トレーナー）`)}
        ${c.requireCourse ? li(j.courseOk, `トレーナーコース ${stats.courseDone ? "修了" : "未修了"}`) : ""}
      </ul>
      <p style="margin:6px 0 0">${j.meets ? '<span class="tc-ok">条件を満たしています（候補）。</span>トレーナーか管理者に、トレーナー合格（認定）を依頼してください。' : `いまの判定：${esc(j.label)}`}</p>`;
  } catch (e) {
    console.warn("[trainer-course] mine", e.message);
    $("mineArea").innerHTML = '<p style="color:var(--color-ink-muted)">件数を読み込めませんでした。時間をおいて画面を開き直してください。</p>';
  }
}

function render() { renderStatus(); renderWatch(); renderQuiz(); renderMine(); }

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  const role = await gateRole(db, user);
  if (!role) return;
  if (role.role === "trainee") {
    showAccessDenied(user.email, "トレーナーコースは、練習生の方は対象外です", "いまは育成コース（サイドメニューの「育成コース」）を進めてください。独り立ちしたあと、トレーナーを目指すときに受けられます。");
    return;
  }
  me = { email: user.email };
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  $("folderLink").href = T.COURSE_FOLDER_URL;
  $("practiceNote").hidden = !isPracticeMode();
  try { const s = await getDoc(doc(db, "appConfig", "trainerProgram", "course", user.email)); course = s.exists() ? s.data() : null; }
  catch (e) { console.warn("[trainer-course] course", e.message); }
  $("gate").style.display = "none";
  $("doc").style.display = "block";
  render();
});
