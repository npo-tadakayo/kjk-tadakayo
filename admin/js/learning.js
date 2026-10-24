// admin/js/learning.js — 育成コース（/learning.html）
// 仕様: docs/伴走支援者育成プログラム_提案_20261024.md §3〜§4（次田さん了承 2026-10-24）
//   - 本人の画面: 7ステップを縦に並べ、いまのステップを開く。動画はその場で再生（video-player.js）、
//     確認テストもその場で受ける（learning-quiz.js）。STEP1 は「約束します」、STEP5 は練習モードの課題を判定
//   - トレーナー・管理者の画面（同じページの下）: 受講中の方の一覧（名前・いまのSTEP・最後に進んだ日・OJTに入れます）
//   - 進み具合は本番DBの learningProgress/{メール}。練習モード中でも getProdFirestore で読み書きする
//     （練習DBは毎晩3時・ログアウトで消えるため）。練習課題の判定だけ練習DB（getFirestore）を読む
//   - 練習生は本番の supportBadges・users・appConfig を読めない。読めなければ黙って表示を省く
//   - 判定・採点・更新値の組み立ては learning-core.js（scripts/test-learning-core.mjs）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, getProdFirestore, isPracticeMode, doc, getDoc, getDocs, setDoc, runTransaction, collection, query, where, serverTimestamp }
  from "/js/fs.js";
import { gateRole, applyViewerMode } from "/js/role.js";
import { setPracticeMode } from "/js/mode.js";
import { mountVideo } from "/js/video-player.js";
import { findVideo } from "/js/video-catalog.js";
import { STEPS, PRACTICE_TASKS, PLEDGE_ITEMS } from "/js/learning-catalog.js";
import { QUIZZES } from "/js/learning-quiz.js";
import { ITEMS, isTrainer } from "/js/support-evaluation.js";
import * as L from "/js/learning-core.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);        // 練習モード中は練習DB（練習課題の判定にだけ使う）
const prod = getProdFirestore(app);  // 進み具合・バッジ・名簿は常に本番DB

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(m, ms = 2600) { const t = $("toast"); t.textContent = m; t.style.display = "block"; clearTimeout(t._t); t._t = setTimeout(() => { t.style.display = "none"; }, ms); }

let me = { email: "", name: "" };
let myRole = null;
let progress = null;      // 自分の learningProgress（無ければ null）
let badge = null;         // 自分のバッジ（supportBadges。読めなければ null）
let lastJudge = null;     // 今回の画面で押した「判定する」の結果
const open = new Set();   // 開いているステップ
const quizState = {};     // { S1: { choices: {問題ID: [{index,text}]}, answers: {}, result } }
let saved = null;        // サーバーに書けたと確かめた進み具合（画面の progress とは分ける。未保存分の送り直しの基準）
let playSeq = 0;         // 動画の読み込みの通し番号（古い読み込みを捨てるため）
let playing = null;       // { stepId, videoId, video, last: { maxPos, at } }

// ---------- 保存（本番DB・変わったところだけ merge） ----------
async function save(r) {
  if (!r || r.error || !r.patch) return false;
  try {
    // サーバーの最新の記録を読んで、達成が減らない形に直してから書く（ほかのタブの合格を古い状態で消さない）
    const ref = doc(prod, "learningProgress", me.email);
    let merged = null;
    await runTransaction(prod, async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists() ? snap.data() : {};
      const g = L.guardPatch(cur, r.patch);
      tx.set(ref, { ...g, updatedAt: serverTimestamp() }, { merge: true });
      merged = L.mergePatch(cur, g);
    });
    saved = merged;
    // 書けてから画面の状態に入れる（失敗したのに「済」に見えて、やり直せなくなるのを防ぐ）。
    // 手元にだけある視聴位置（まだ保存していない分）は残す
    progress = L.mergePatch(merged, { videos: Object.fromEntries(Object.entries(progress?.videos || {})
      .filter(([id, v]) => (Number(v?.maxPos) || 0) > (Number(merged?.videos?.[id]?.maxPos) || 0))) });
    return true;
  } catch (e) {
    console.warn("[learning] save failed", e);
    toast("進み具合を保存できませんでした。通信状態をご確認のうえ、もう一度お試しください。", 4000);
    return false;
  }
}

// ---------- 上の「次にやること」・進み具合のメーター ----------
function states() { return L.stepStates(progress, { badge }, QUIZZES); }

function renderTop() {
  const st = states();
  $("nextAction").textContent = L.nextAction(progress, { badge }, QUIZZES);
  $("meter").innerHTML = st.map((s) => `<span class="${s.state}"></span>`).join("");
  const n = L.reachedStep(st);
  const ready = L.isReadyForOjt(progress, QUIZZES);
  $("meterText").textContent = badge ? "7つのステップがすべて済みました（独り立ち）"
    : `${n ? `STEP${n} まで済` : "これから STEP1"} ／ 全7ステップ（STEP6 は任意）${ready ? "・OJTに入れます" : ""}`;
  const solo = $("solo");
  if (badge) {
    solo.hidden = false;
    solo.innerHTML = `<i class="ti ti-award" aria-hidden="true"></i><div><strong>独り立ち（伴走支援者バッジ）</strong><br>付与日 ${esc(L.fmtDate(badge.grantedDate) || badge.grantedDate)} ／ 認定したトレーナー ${esc(badge.grantedByName || "")}</div>`;
  } else solo.hidden = true;
}

const STATE_LABEL = { done: "済", current: "いまここ", todo: "まだ", optional: "任意" };

function renderHeads() {
  for (const s of states()) {
    const sec = $(`step-${s.step.id}`);
    if (!sec) continue;
    sec.className = `ls-step is-${s.state}`;
    sec.querySelector(".ls-no").innerHTML = s.state === "done" ? '<i class="ti ti-check" aria-hidden="true"></i><span class="ls-sr">済</span>' : String(s.step.no);
    sec.querySelector(".ls-state").textContent = s.state === "done" && s.at ? `済 ${L.fmtDate(s.at)}` : STATE_LABEL[s.state];
  }
}

// ---------- ステップの中身 ----------
function videoRowsHtml(step, info) {
  if (!step.videos?.length) return "";
  return `<div class="ls-h4"><i class="ti ti-video" aria-hidden="true"></i>動画（最後まで見ると済になります）</div>
    <div class="ls-vlist">${info.videos.map((v) => {
      const meta = findVideo(v.id);
      const st = v.done ? '<span class="vs done"><i class="ti ti-circle-check-filled" aria-hidden="true"></i> 見ました</span>'
        : v.pct ? `<span class="vs">${v.pct}%</span>` : '<span class="vs" style="color:var(--color-ink-muted)">まだ</span>';
      const now = playing && playing.videoId === v.id;
      return `<div class="ls-v">
        <div class="vt">${esc(meta ? `${meta.label}　${meta.title}` : v.id)}<small>${esc(meta?.duration || "")}</small></div>
        ${st}
        <button type="button" class="btn btn-secondary" data-play="${esc(v.id)}" data-step="${esc(step.id)}" aria-label="${esc(meta ? `${meta.label} ${meta.title}` : v.id)} を再生する">
          <i class="ti ti-player-play" aria-hidden="true"></i>${now ? "再生中" : "再生する"}</button>
      </div>`;
    }).join("")}</div>`;
}

function quizHtml(step, info) {
  if (!step.quiz) return "";
  const quiz = QUIZZES[step.quiz];
  const head = `<div class="ls-h4"><i class="ti ti-checklist" aria-hidden="true"></i>確認テスト</div>`;
  if (!L.hasQuestions(quiz)) return `${head}<p class="ls-note">確認テストは準備中です。問題ができしだい、ここで受けられます。</p>`;
  const rec = progress?.quizzes?.[step.quiz];
  const status = info.quiz.passed
    ? `<p><span class="ls-ok"><i class="ti ti-circle-check-filled" aria-hidden="true"></i> 合格しました</span>（${esc(L.fmtDate(rec.passedAt))}・最高 ${esc(rec.best)}%・${esc(rec.attempts)}回）。何度でも受け直せます。</p>`
    : `<p>${esc(quiz.questions.length)}問・${esc(L.passRuleText(quiz))}。何度でも受け直せます。${rec ? `（これまで ${esc(rec.attempts)}回・最高 ${esc(rec.best)}%）` : ""}</p>`;
  const qs = quizState[step.quiz];
  if (!qs) return `${head}${status}<div class="ls-row"><button type="button" class="btn btn-primary" data-quiz-start="${esc(step.quiz)}"><i class="ti ti-pencil" aria-hidden="true"></i>確認テストを受ける</button></div>`;
  const res = qs.result;
  const byId = Object.fromEntries((res?.results || []).map((r) => [r.id, r]));
  const body = quiz.questions.map((q, i) => {
    const r = byId[q.id];
    const choices = qs.choices[q.id].map((c) => {
      const chosen = qs.answers[q.id] === c.index;
      const cls = r ? (c.index === q.answer ? " right" : chosen ? " wrong" : "") : "";
      return `<label class="ls-c${cls}"><input type="radio" name="q-${esc(step.quiz)}-${esc(q.id)}" value="${c.index}" data-quiz="${esc(step.quiz)}" data-q="${esc(q.id)}" ${chosen ? "checked" : ""} ${r ? "disabled" : ""}><span>${esc(c.text)}</span></label>`;
    }).join("");
    const why = r ? `<p class="ls-why" role="note">${r.correct ? '<strong class="ls-ok">正解</strong>' : '<strong style="color:#9b1f1f">不正解</strong>'}　${esc(q.why || "")}</p>` : "";
    return `<fieldset class="ls-q"><legend>問${i + 1}　${esc(q.q)}${q.safety ? '<span class="tag">個人情報・安全</span>' : ""}</legend>${choices}${why}</fieldset>`;
  }).join("");
  const foot = res
    ? `<p class="ls-result" role="status">${res.passed ? '<span class="ls-ok">合格です</span>' : "もう少しです"}　${res.correct}／${res.total}問 正解（${res.score}%）${!res.passed && res.safetyMissed.length ? "・個人情報・安全の問題は全問正解が必要です" : ""}</p>
       <div class="ls-row"><button type="button" class="btn btn-secondary" data-quiz-start="${esc(step.quiz)}"><i class="ti ti-refresh" aria-hidden="true"></i>もう一度受ける</button>
       <button type="button" class="btn btn-secondary" data-quiz-close="${esc(step.quiz)}">閉じる</button></div>`
    : `<div class="ls-row"><button type="button" class="btn btn-primary" data-quiz-grade="${esc(step.quiz)}"><i class="ti ti-check" aria-hidden="true"></i>答え合わせ</button>
       <span id="qmsg-${esc(step.quiz)}" role="alert" style="font-size:13px;color:var(--color-danger)"></span></div>`;
  return `${head}${status}<div class="ls-quiz">${body}${foot}</div>`;
}

function pledgeHtml(step, info) {
  if (!step.pledge) return "";
  const list = `<ol class="ls-pledge">${PLEDGE_ITEMS.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
  const head = `<div class="ls-h4"><i class="ti ti-shield-check" aria-hidden="true"></i>伴走支援者の約束（10項目）</div>`;
  if (info.pledge.done) return `${head}${list}<p><span class="ls-ok"><i class="ti ti-circle-check-filled" aria-hidden="true"></i> 約束しました</span>（${esc(L.fmtDateTime(progress.pledgeAt))}）</p>`;
  const can = L.canPledge(progress, QUIZZES);
  return `${head}${list}
    <p>${can ? "上の10の約束を守ることを確かめて、「約束します」を押してください。押した日時を記録します。" : "STEP1 の動画3本を見て、確認テストに合格すると押せます。"}</p>
    <div class="ls-row"><button type="button" class="btn btn-primary" data-pledge ${can ? "" : "disabled"}><i class="ti ti-heart-handshake" aria-hidden="true"></i>約束します</button></div>`;
}

function practiceHtml(step, info) {
  if (!step.practice) return "";
  const items = info.practice.items;
  const list = `<ul class="ls-tasks">${PRACTICE_TASKS.map((t) => `<li class="${items[t.key] ? "ok" : "ng"}">
      <i class="ti ${items[t.key] ? "ti-circle-check-filled" : "ti-circle"}" aria-hidden="true"></i>
      <span>${esc(t.label)}${items[t.key] ? '<span class="ls-sr">（できました）</span>' : ""}<small>${esc(t.hint)}</small></span></li>`).join("")}</ul>`;
  const checked = info.practice.checkedAt ? `<p style="font-size:12.5px;color:var(--color-ink-muted)">前回の判定：${esc(L.fmtDateTime(info.practice.checkedAt))}${lastJudge ? `（今回：担当の案件 ${lastJudge.cases}件・この判定でできた課題 ${lastJudge.done}／${lastJudge.total}）` : ""}</p>` : "";
  const head = `<div class="ls-h4"><i class="ti ti-list-check" aria-hidden="true"></i>練習の課題（6つ）</div>`;
  if (info.practice.passed) return `${head}${list}${checked}<p><span class="ls-ok"><i class="ti ti-circle-check-filled" aria-hidden="true"></i> 6つの課題がすべてできました</span></p>`;
  if (!isPracticeMode()) {
    return `${head}${list}${checked}
      <div class="ls-warn">いまは<strong>本番</strong>の画面です。練習モードに入ると「あなたの担当」の練習用の案件が2件用意されます。そこで課題をこなしてから、この画面に戻って「判定する」を押してください。</div>
      <div class="ls-row"><button type="button" class="btn btn-secondary" data-practice-enter><i class="ti ti-school" aria-hidden="true"></i>練習モードに入る</button></div>`;
  }
  return `${head}${list}${checked}
    <div class="ls-warn"><strong>ログアウトの前に「判定する」を押してください。</strong>練習のデータはログアウトすると消えます（判定の結果は本番に残ります）。一度できた課題は、あとで練習のデータが消えても「できた」のままです。</div>
    <div class="ls-row">
      <a class="btn btn-secondary" href="/cases.html"><i class="ti ti-layout-list" aria-hidden="true"></i>練習用の案件を開く</a>
      <button type="button" class="btn btn-primary" data-practice-judge><i class="ti ti-zoom-check" aria-hidden="true"></i>判定する</button>
      <span id="pmsg" role="status" aria-live="polite" style="font-size:13px"></span>
    </div>`;
}

function ojtHtml(step) {
  if (!step.ojt) return "";
  const ready = L.isReadyForOjt(progress, QUIZZES);
  const items = `<ol class="ls-pledge">${ITEMS.map((i) => `<li>${esc(i.label)}${i.n === 4 ? "（◎が必要）" : ""}</li>`).join("")}</ol>`;
  let st;
  if (badge) st = `<p><span class="ls-ok"><i class="ti ti-award" aria-hidden="true"></i> 独り立ち</span>（付与日 ${esc(L.fmtDate(badge.grantedDate) || badge.grantedDate)}・認定したトレーナー ${esc(badge.grantedByName || "")}）</p>`;
  else if (ready) st = `<div class="ls-warn" style="background:#e8f5ec;border-left-color:#3d7a2a"><strong>OJTに入れます。</strong>トレーナーに連絡して、支援先でのOJTの日程を決めてください。</div>`;
  else st = `<p class="ls-note">STEP1〜5 が済むと「OJTに入れます」になります（評価シートの入力は、STEP1〜5 が済む前でもトレーナーが行えます）。</p>`;
  return `<div class="ls-h4"><i class="ti ti-clipboard-check" aria-hidden="true"></i>評価シートの8つの観点（◎ひとりでできる／○助言があればできる／△要練習／×未実施）</div>${items}
    <p>独り立ち可の基準は「④個人情報・安全が◎、ほかがすべて○以上、OJTで1回でも合格」です。トレーナーが立ち会わないOJT・見学は評価の対象になりません。バッジは、トレーナーのうち1名が付与します（バッジは単独で伴走支援を担当できる資格です）。</p>${st}`;
}

function restHtml(step, info) {
  let h = "";
  if (step.reading?.length) h += `<div class="ls-h4"><i class="ti ti-book" aria-hidden="true"></i>読むもの</div><ul class="ls-pledge">${step.reading.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="ls-note">${esc(step.readingWhere || "")}</p>`;
  h += quizHtml(step, info) + pledgeHtml(step, info) + practiceHtml(step, info) + ojtHtml(step);
  return h;
}

function stepInfoOf(id) { return states().find((s) => s.step.id === id); }

function renderStepParts(id) {
  const s = stepInfoOf(id);
  if (!s) return;
  const v = $(`vids-${id}`); if (v) v.innerHTML = videoRowsHtml(s.step, s);
  const r = $(`rest-${id}`); if (r) r.innerHTML = restHtml(s.step, s);
}
// 再生中は動画の行だけ描き直す（テストの回答中の選択を消さない）
function renderVids(id) {
  const s = stepInfoOf(id);
  const v = $(`vids-${id}`); if (s && v) v.innerHTML = videoRowsHtml(s.step, s);
}

function buildSteps() {
  const st = states();
  $("steps").innerHTML = st.map((s) => {
    const id = s.step.id;
    const isOpen = open.has(id);
    return `<section class="ls-step is-${s.state}" id="step-${id}" aria-labelledby="head-${id}">
      <button type="button" class="ls-head" id="head-${id}" aria-expanded="${isOpen}" aria-controls="body-${id}" data-toggle="${id}">
        <span class="ls-no"></span>
        <span class="ls-ht"><span class="ls-title">STEP${s.step.no}　${esc(s.step.title)}</span><span class="ls-sub">${s.step.optional ? "必須ではありません" : `目安 ${esc(s.step.time)}`}</span></span>
        <span class="ls-state"></span>
        <i class="ti ti-chevron-down ls-chev" aria-hidden="true"></i>
      </button>
      <div class="ls-body" id="body-${id}" ${isOpen ? "" : "hidden"}>
        <p>${esc(s.step.desc)}</p>
        ${s.step.note ? `<p class="ls-note">${esc(s.step.note)}</p>` : ""}
        <div id="vids-${id}"></div>
        <div class="ls-player" id="player-${id}" hidden></div>
        <div id="rest-${id}"></div>
      </div>
    </section>`;
  }).join("");
  for (const s of st) renderStepParts(s.step.id);
  renderHeads();
}

function refresh(ids) {
  renderTop();
  renderHeads();
  (ids || STEPS.map((s) => s.id)).forEach(renderStepParts);
}

// ---------- 動画（最大位置を記録・保存しすぎない） ----------
async function flushVideo(force = true) {
  if (!playing) return;
  const rec = progress?.videos?.[playing.videoId];
  if (L.shouldSaveVideo(playing.last, rec, { force, now: Date.now() })) {
    const p = playing, prev = p.last;
    p.last = { maxPos: rec.maxPos, at: Date.now() };
    if (!(await save(L.applyVideo(progress, me, p.videoId, rec, Date.now(), QUIZZES)))) p.last = prev; // 失敗したら次の機会に送り直す
  }
}

async function play(stepId, videoId) {
  if (playing) {
    try { playing.video?.pause(); } catch (_) {}
    await flushVideo(true);
    const prevBox = $(`player-${playing.stepId}`);
    if (prevBox && playing.stepId !== stepId) { prevBox.innerHTML = ""; prevBox.hidden = true; }
  }
  const box = $(`player-${stepId}`);
  box.hidden = false;
  // 読み込みのたびに新しい入れ物と通し番号を使う。読み込み中に別の動画を選んだとき、
  // 古い読み込みが後から終わっても、いまの動画の表示を上書きしない（古い入れ物はもう画面に無い）
  const seq = ++playSeq;
  box.innerHTML = "";
  const slot = document.createElement("div");
  box.appendChild(slot);
  // 基準は「保存できた位置」。画面にだけある未保存の位置を基準にすると、通信が戻っても送り直さない（Codex 指摘）
  const startMax = Number(saved?.videos?.[videoId]?.maxPos) || 0;
  playing = { stepId, videoId, video: null, last: { maxPos: startMax, at: Date.now() } };
  renderVids(stepId);
  const video = await mountVideo(slot, videoId, { autoplay: true });
  if (seq !== playSeq) {
    if (video) { try { video.pause(); video.removeAttribute("src"); video.querySelectorAll("source").forEach((x) => x.remove()); video.load(); } catch (_) {} }
    slot.remove();
    return;
  }
  if (!video || !playing || playing.videoId !== videoId) return;
  playing.video = video;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  video.addEventListener("timeupdate", () => {
    if (!playing || playing.video !== video) return;
    const now = Date.now();
    const r = L.nextVideoRecord(progress?.videos?.[videoId], video.currentTime, video.duration, now);
    if (!r.changed) return;
    if (L.shouldSaveVideo(playing.last, r.rec, { justDone: r.justDone, now })) {
      const p = playing, prev = p.last;
      p.last = { maxPos: r.rec.maxPos, at: now };
      progress = L.mergePatch(progress, { videos: { [videoId]: r.rec } }); // 画面の中の視聴位置は先に進める（保存は下で）
      save(L.applyVideo(progress, me, videoId, r.rec, now, QUIZZES)).then((ok) => {
        if (!ok) { p.last = prev; return; } // 失敗したら、止めたとき・次の区切りで送り直す
        if (r.justDone) { toast("動画を最後まで見ました（済）"); refresh(); }
      });
      if (!r.justDone) renderVids(stepId);
    } else {
      progress = L.mergePatch(progress, { videos: { [videoId]: r.rec } }); // 画面の中だけ（次の保存でまとめて書く）
    }
  });
  video.addEventListener("pause", () => { flushVideo(true).then(() => renderVids(stepId)); });
  video.addEventListener("ended", () => { flushVideo(true).then(() => refresh()); });
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushVideo(true); });
window.addEventListener("pagehide", () => { flushVideo(true); });

// ---------- テスト ----------
function startQuiz(key) {
  const quiz = QUIZZES[key];
  if (!L.hasQuestions(quiz)) return;
  quizState[key] = { choices: Object.fromEntries(quiz.questions.map((q) => [q.id, L.shuffleChoices(q)])), answers: {}, result: null };
}
async function gradeQuiz(key, stepId) {
  const qs = quizState[key];
  const res = L.gradeQuiz(QUIZZES[key], qs.answers);
  if (res.status === "incomplete") {
    const m = $(`qmsg-${key}`); if (m) m.textContent = `まだ答えていない問題があります（${res.unanswered.length}問）`;
    return;
  }
  if (res.status !== "graded") return;
  qs.result = res;
  const ok = await save(L.applyQuiz(progress, me, key, res, Date.now(), QUIZZES));
  if (!ok) qs.result = null; // 保存できなかったら、答えはそのままで「答え合わせ」に戻して送り直してもらう
  refresh();
  if (!ok) { const m = $(`qmsg-${key}`); if (m) m.textContent = "結果を保存できませんでした。通信状態をご確認のうえ、もう一度「答え合わせ」を押してください。"; return; }
  const sec = $(`rest-${stepId}`)?.querySelector(".ls-result");
  if (sec) sec.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- 練習課題の判定（練習DBを読んで、結果だけ本番に書く） ----------
async function judge() {
  const msg = $("pmsg");
  if (!isPracticeMode()) return;
  if (msg) msg.textContent = "判定しています…";
  try {
    const cs = await getDocs(query(collection(db, "cases"), where("assignedUserId", "==", me.email)));
    const cases = cs.docs.map((d) => ({ _id: d.id, ...d.data() }));
    const activities = [], supportChecklists = {}, documentChecklists = {};
    await Promise.all(cases.map(async (c) => {
      const [a, s, dc] = await Promise.all([
        getDocs(query(collection(db, "activities"), where("caseId", "==", c._id))),
        getDoc(doc(db, "supportChecklists", c._id)),
        getDoc(doc(db, "documentChecklists", c._id)),
      ]);
      a.docs.forEach((x) => activities.push({ ...x.data(), caseId: c._id }));
      if (s.exists()) supportChecklists[c._id] = s.data();
      if (dc.exists()) documentChecklists[c._id] = dc.data();
    }));
    lastJudge = L.judgePractice({ email: me.email, cases, activities, supportChecklists, documentChecklists });
    const ok = await save(L.applyPractice(progress, me, lastJudge, Date.now(), QUIZZES));
    refresh();
    if (!ok) {
      // 保存できなかったことを隠さない（練習のデータはログアウトで消えるので、ここで送り直してもらう）
      const m = $("pmsg");
      if (m) m.textContent = "判定の結果を保存できませんでした。ログアウトせずに、もう一度「判定する」を押してください。";
      return;
    }
    toast(L.practicePassed(progress) ? "6つの課題がすべてできました（STEP5 済）" : `判定しました（できた課題 ${PRACTICE_TASKS.filter((t) => progress.practice.items[t.key]).length}／6）`);
  } catch (e) {
    console.warn("[learning] judge failed", e);
    if (msg) msg.textContent = "判定できませんでした。時間をおいてもう一度押してください。";
  }
}

// ---------- 画面の操作 ----------
function focusEl(sel) {
  const el = document.querySelector(sel);
  if (!el) return false;
  if (!el.matches("button, input, a, [tabindex]")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: false });
  return true;
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t || !$("doc").contains(t)) return;
  if (t.dataset.toggle) {
    const id = t.dataset.toggle;
    const isOpen = t.getAttribute("aria-expanded") === "true";
    t.setAttribute("aria-expanded", String(!isOpen));
    $(`body-${id}`).hidden = isOpen;
    if (isOpen) open.delete(id); else open.add(id);
    return;
  }
  if (t.dataset.play) { play(t.dataset.step, t.dataset.play); return; }
  // 描き直すと押したボタンが消えるので、キーボードで続けられるよう次に使う所へフォーカスを移す（独立検証の所見）
  if (t.dataset.quizStart) { const k = t.dataset.quizStart; startQuiz(k); renderStepParts(stepOfQuiz(k)); focusEl(`input[data-quiz="${k}"]`); return; }
  if (t.dataset.quizClose) { const k = t.dataset.quizClose; delete quizState[k]; renderStepParts(stepOfQuiz(k)); focusEl(`[data-quiz-start="${k}"]`); return; }
  if (t.dataset.quizGrade) {
    const k = t.dataset.quizGrade;
    t.disabled = true; await gradeQuiz(k, stepOfQuiz(k)); t.disabled = false;
    focusEl(`#rest-${stepOfQuiz(k)} .ls-result`) || focusEl(`[data-quiz-grade="${k}"]`);
    return;
  }
  if (t.hasAttribute("data-pledge")) {
    t.disabled = true;
    const r = L.applyPledge(progress, me, Date.now(), QUIZZES);
    if (r.error) { toast(r.error); t.disabled = false; return; }
    if (await save(r)) toast("約束しました。STEP1 が済みました");
    refresh();
    return;
  }
  if (t.hasAttribute("data-practice-judge")) { t.disabled = true; await judge(); t.disabled = false; return; }
  if (t.hasAttribute("data-practice-enter")) {
    if (!confirm("練習モードに入ります。\n練習用のデータに切り替わり、メール・Chat などは送られません。\n（ログアウトすると、練習中に自分が作ったデータは消えます）")) return;
    if (!setPracticeMode(true)) { alert("このブラウザでは設定を保存できないため、切り替えられませんでした（プライベートウィンドウなど）。"); return; }
    location.reload();
    return;
  }
  if (t.dataset.who) { toggleDetail(t); return; }
});
document.addEventListener("change", (e) => {
  const r = e.target;
  if (r && r.dataset && r.dataset.quiz && quizState[r.dataset.quiz]) {
    quizState[r.dataset.quiz].answers[r.dataset.q] = Number(r.value);
    const m = $(`qmsg-${r.dataset.quiz}`); if (m) m.textContent = "";
  }
});
const stepOfQuiz = (key) => (STEPS.find((s) => s.quiz === key) || {}).id;

// ---------- トレーナー・管理者の一覧 ----------
let rows = [];
function detailHtml(row) {
  return `<ul class="ls-mini">${row.states.map((s) => {
    const ic = s.state === "done" ? "ti-circle-check-filled" : s.state === "current" ? "ti-player-play" : s.state === "optional" ? "ti-circle-dashed" : "ti-circle";
    const q = s.quiz && s.quiz.best != null ? `・テスト最高 ${s.quiz.best}%` : "";
    return `<li><i class="ti ${ic}" aria-hidden="true" style="color:${s.state === "done" ? "#2f6420" : "var(--color-ink-muted)"}"></i><span>STEP${s.step.no} ${esc(s.step.title)}：${esc(STATE_LABEL[s.state])}${s.at ? ` ${esc(L.fmtDate(s.at))}` : ""}${esc(q)}</span></li>`;
  }).join("")}</ul>`;
}
function toggleDetail(btn) {
  const tr = $(`detail-${btn.dataset.who}`);
  if (!tr) return;
  const isOpen = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!isOpen));
  btn.innerHTML = isOpen ? '<i class="ti ti-chevron-down" aria-hidden="true"></i>見る' : '<i class="ti ti-chevron-up" aria-hidden="true"></i>閉じる';
  tr.hidden = isOpen;
}
function renderTrainer() {
  const body = $("trainerBody");
  if (!rows.length) { body.innerHTML = `<p class="ls-note">まだ受講中の方はいません。</p>`; return; }
  body.innerHTML = `<table class="ls-tbl"><thead><tr><th scope="col">名前</th><th scope="col">いまのSTEP</th><th scope="col">最後に進んだ日</th><th scope="col">OJTに入れます</th><th scope="col"><span class="ls-sr">進み具合</span></th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr>
      <td class="who"><strong>${esc(r.name)}</strong><small>${esc(r.email)}</small></td>
      <td data-k="いまのSTEP">${esc(r.stepLabel)}</td>
      <td data-k="最後に進んだ日">${r.lastAt ? esc(L.fmtDate(r.lastAt)) : "—"}</td>
      <td data-k="OJT">${r.badge ? `<span class="ls-chip badge"><i class="ti ti-award" aria-hidden="true"></i> 独り立ち ${esc(L.fmtDate(r.badge.grantedDate) || "")}</span>` : r.ready ? '<span class="ls-chip"><i class="ti ti-check" aria-hidden="true"></i> OJTに入れます</span>' : '<span class="ls-chip no">まだ</span>'}</td>
      <td><button type="button" class="btn btn-secondary" data-who="${i}" aria-expanded="false" aria-controls="detail-${i}" aria-label="${esc(r.name)}さんの進み具合を見る"><i class="ti ti-chevron-down" aria-hidden="true"></i>見る</button></td>
    </tr>
    <tr class="ls-detail" id="detail-${i}" hidden><td colspan="5">${detailHtml(r)}</td></tr>`).join("")}
    </tbody></table>`;
}

async function loadTrainer(users, grants) {
  let docs = [];
  try {
    const s = await getDocs(collection(prod, "learningProgress"));
    docs = s.docs.map((d) => ({ _id: d.id, ...d.data() }));
  } catch (e) { console.warn("[learning] list", e.message); }
  const byEmail = new Map(docs.map((d) => [d._id, d]));
  // まだ始めていない練習生も一覧に出す（ユーザー管理で「練習生」にした方）
  for (const u of users) if (u.role === "trainee" && u.active !== false && !byEmail.has(u._id)) byEmail.set(u._id, null);
  rows = [...byEmail.entries()].map(([email, p]) => {
    const u = users.find((x) => x._id === email);
    const b = grants.find((g) => g.userId === email) || null;
    return L.listRow(p, { email, name: (u && u.name) || email, badge: b }, QUIZZES);
  }).sort((a, b) => (!!a.badge - !!b.badge) || (b.ready - a.ready) || (b.reached - a.reached) || ((b.lastAt || 0) - (a.lastAt || 0)));
  renderTrainer();
}

// ---------- はじまり ----------
onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  myRole = await gateRole(db, user);
  if (!myRole) return;
  applyViewerMode(myRole);
  me = { email: user.email, name: myRole.name || user.displayName || user.email };
  const ue = $("userEmail"); if (ue) ue.textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));

  try {
    const s = await getDoc(doc(prod, "learningProgress", me.email));
    progress = s.exists() ? s.data() : null;
    saved = progress;
  } catch (e) { console.warn("[learning] progress", e.message); progress = null; }
  // 練習生は本番のバッジ・名簿・設定を読めない（ルール）。読めなければ表示を省く
  let grants = [];
  try { const s = await getDocs(collection(prod, "supportBadges")); grants = s.docs.map((d) => ({ _id: d.id, ...d.data() })); } catch (_) {}
  badge = grants.find((g) => g.userId === me.email) || null;

  const cur = states().find((s) => s.state === "current");
  if (cur) open.add(cur.step.id);
  $("gate").style.display = "none";
  $("doc").style.display = "block";
  renderTop();
  buildSteps();

  // トレーナー（appConfig/supportTrainers・users の氏名）と管理者には一覧を出す
  if (myRole.role === "trainee") return;
  let users = [], rosterIds = null;
  try { const s = await getDocs(collection(prod, "users")); users = s.docs.map((d) => ({ _id: d.id, ...d.data() })); } catch (_) {}
  try { const d = await getDoc(doc(prod, "appConfig", "supportTrainers")); if (d.exists()) rosterIds = d.data().ids || null; } catch (_) {}
  if (myRole.role === "admin" || isTrainer(me.email, users, rosterIds)) {
    $("trainerSec").hidden = false;
    await loadTrainer(users, grants);
  }
});

