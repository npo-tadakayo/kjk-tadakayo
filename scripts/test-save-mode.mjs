// 保存のしかたの表示と未保存の確認（save-mode.js）、および伴走支援チェックリスト・案件詳細への配線のテスト。
// node scripts/test-save-mode.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTO_SAVE_NOTE, UNSAVED_TEXT, CONFLICT_TEXT, manualSaveNote, saveModeNoteHtml, unsavedSpanHtml,
  trackUnsaved, hasUnsaved, onBeforeUnload, bindUnloadGuard, discardUnsaved, shouldRefillForm, stableKey } from "../admin/js/save-mode.js";
import { fillPeopleSelect } from "../admin/js/support-performance.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// --- 最小の偽 DOM ---
function fakeEl(id) {
  const ls = {};
  return { id, textContent: "", style: { display: "none" },
    addEventListener(type, fn) { (ls[type] ||= []).push(fn); },
    fire(type, target) { (ls[type] || []).forEach((fn) => fn({ type, target })); } };
}
const fakeDoc = (els) => ({ getElementById: (id) => els[id] || null });
const fakeWin = () => { const w = fakeEl("win"); w.count = 0; const add = w.addEventListener; w.addEventListener = (ty, fn) => { w.count++; add(ty, fn); }; return w; };
const unloadEvent = () => ({ prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } });

t("文言", () => {
  assert.equal(AUTO_SAVE_NOTE, "入力すると自動で保存されます");
  assert.equal(manualSaveNote(), "「保存」を押すと保存されます");
  assert.equal(manualSaveNote("評価を保存"), "「評価を保存」を押すと保存されます");
  assert.equal(UNSAVED_TEXT, "未保存の変更があります");
  assert.match(saveModeNoteHtml(AUTO_SAVE_NOTE), /color:var\(--color-ink-muted\)/);
  assert.match(unsavedSpanHtml("x"), /id="x"[^>]*display:none[^>]*color:var\(--color-danger\)/);
});

t("入力すると「未保存」になり、離れるときに確認が出る。保存に成功したら消える", () => {
  const root = fakeEl("root"), status = fakeEl("st"), win = fakeWin();
  const tr = trackUnsaved("t1", root, "st", { document: fakeDoc({ st: status }), window: win });
  assert.equal(tr.isDirty(), false);
  let e = unloadEvent(); onBeforeUnload(e);
  assert.equal(e.prevented, false, "未保存が無ければ確認を出さない");
  root.fire("input", {});
  assert.equal(tr.isDirty(), true);
  assert.equal(hasUnsaved(), true);
  assert.equal(status.textContent, UNSAVED_TEXT);
  assert.equal(status.style.display, "");
  e = unloadEvent(); onBeforeUnload(e);
  assert.equal(e.prevented, true); assert.equal(e.returnValue, "");
  tr.clean();
  assert.equal(tr.isDirty(), false); assert.equal(hasUnsaved(), false);
  assert.equal(status.textContent, ""); assert.equal(status.style.display, "none");
  e = unloadEvent(); onBeforeUnload(e);
  assert.equal(e.prevented, false);
  root.fire("change", {}); assert.equal(tr.isDirty(), true, "change でも未保存");
  tr.clean();
  tr.mark(); assert.equal(tr.isDirty(), true, "mark() で未保存（写真を外したとき）"); tr.clean();
});

t("match で対象を絞れる。複数の欄は別々に数える", () => {
  const root = fakeEl("r"), win = fakeWin();
  const a = trackUnsaved("a", root, null, { match: (x) => x && x.ok, window: win });
  const b = trackUnsaved("b", fakeEl("r2"), null, { window: win });
  root.fire("input", { ok: false }); assert.equal(a.isDirty(), false);
  root.fire("input", { ok: true }); assert.equal(a.isDirty(), true);
  assert.equal(b.isDirty(), false);
  a.clean(); assert.equal(hasUnsaved(), false);
});

t("beforeunload の登録は1回だけ", () => {
  const w = fakeWin();
  bindUnloadGuard(w); bindUnloadGuard(w);
  assert.ok(w.count <= 1);
});

// --- 伴走支援チェックリスト（support-checklist.js）の配線 ---
const sc = src("../admin/js/support-checklist.js");
const fnBody = (name) => { const i = sc.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return sc.slice(i, sc.indexOf("\nfunction ", i + 1)); };
const cardsOf = (body) => body.split(/<div class="card"/).slice(1);

t("自動保存のカードはどれも、そのカードの中に「保存しました」の表示がある（当日タブのケアプラン連携を含む）", () => {
  const fns = ["renderPre", "cardCpPre", "cardVisitInfo", "cardOnsiteSteps", "cardCpSteps", "cardCpAfter", "renderAfter"];
  let checked = 0;
  for (const f of fns) {
    for (const card of cardsOf(fnBody(f))) {
      const autosaves = /data-sec=|rowStep\(|row3state\(|checkOnly\(|checkRowWithMonth\(|selectGroup\(/.test(card);
      if (!autosaves) continue;
      checked++;
      assert.match(card, /savedSpan\(/, `${f} のカードに保存表示が無い`);
      assert.match(card, /cardTitle\("[^"]+", AUTO_SAVE_NOTE\)/, `${f} のカードに「自動で保存」の説明が無い`);
    }
  }
  assert.ok(checked >= 8, `自動保存のカード数: ${checked}`);
  assert.match(fnBody("cardCpSteps"), /savedSpan\("cp", "onsite"\)/);
});

t("保存表示の id は重ならない", () => {
  const ids = [...sc.matchAll(/savedSpan\("([a-z]+)"(?:, "([a-z]+)")?\)/g)].map((m) => m[1] + (m[2] ? `-${m[2]}` : ""));
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
  assert.match(sc, /id="sc-saved-\$\{sec\}\$\{part \? `-\$\{part\}` : ""\}"/);
});

t("保存表示は変更した欄のカードに出す（sec ごとの id で探さない）", () => {
  assert.match(sc, /const card = el && el\.closest \? el\.closest\("\.card"\) : null;/);
  assert.match(sc, /card\.querySelector\("\.sc-saved"\)/);
  assert.match(sc, /await saveSection\(sec\);\n\s+markSaved\(el\);/);
  assert.ok(!/markSaved\(sec/.test(sc), "sec で markSaved していない");
});

t("実施の記録・トレーニング評価は保存ボタンの説明と未保存の表示がある", () => {
  assert.match(fnBody("cardPerformance"), /cardTitle\("実施の記録（誰が実施したか）", manualSaveNote\("実施の記録を保存"\), unsavedSpanHtml\("sc-perf-unsaved"\)\)/);
  assert.match(fnBody("cardPerformance"), /<div class="card" id="sc-perf-card"/);
  assert.match(fnBody("cardEvaluation"), /cardTitle\("トレーニング評価（トレーナーが記入）", manualSaveNote\("評価を保存"\), unsavedSpanHtml\("sc-eval-unsaved"\)\)/);
  assert.match(sc, /trackUnsaved\("supportPerformance", \$\("sc-perf-card"\), "sc-perf-unsaved"\)/);
  assert.match(sc, /trackUnsaved\("supportEvaluation", \$\("sc-eval-card"\), "sc-eval-unsaved",\n\s+\{ active: \(\) => isTrainer\(actorId\(\), users\(\), rosterIds\) \}\)/);
  assert.match(sc, /perf = r\.performance;\n\s+perfUnsaved\.clean\(\);/);
  assert.match(sc, /evalUnsaved\.clean\(\);\n\s+\$\("sc-eval-saved"\)\.textContent = `保存しました/);
  assert.match(sc, /if \(!perfUnsaved\.isDirty\(\) && !\(document\.activeElement/, "未保存の実施の記録を上書きしない");
  // 見出しのタイトルは全部 cardTitle を通す（説明の付け忘れが無い）
  assert.equal((sc.match(/<span style="font-weight:600;font-size:14px">/g) || []).length, 1);
});

// --- 案件詳細（case-detail.js / case-detail.html）の配線 ---
const cd = src("../admin/js/case-detail.js");
const html = src("../admin/case-detail.html");
t("伴走支援の記録・振込口座・申請情報は「保存」を押す説明と未保存の表示がある", () => {
  for (const [title, btn, id] of [["伴走支援セッションを記録", "伴走支援を記録", "sessionUnsaved"],
    ["振込口座情報（事業所側）", "保存", "bankUnsaved"], ["補助金申請ステータス", "保存", "subsidyUnsaved"]]) {
    const i = html.indexOf(`<span style="font-weight:600;font-size:14px">${title}</span>`);
    assert.ok(i >= 0, title);
    const head = html.slice(i, html.indexOf("</div>", i));
    assert.ok(head.includes(manualSaveNote(btn)), `${title} の説明`);
    assert.ok(head.includes(`id="${id}"`), `${title} の未保存の表示`);
  }
  const j = html.indexOf("補助金申請 書類チェックリスト</span>");
  assert.ok(html.slice(j, html.indexOf("</div>", j)).includes(AUTO_SAVE_NOTE));
});
t("案件詳細の保存ボタンの欄を見張り、保存に成功したら消す・入力途中を上書きしない", () => {
  assert.match(cd, /import \{ trackUnsaved, unsavedSpanHtml, discardUnsaved \} from "\/js\/save-mode\.js";/);
  for (const k of ['"session"', '"sessionEdit"', '"bank"', '"subsidy"']) assert.ok(cd.includes(`trackUnsaved(${k},`), k);
  assert.match(cd, /merge: true \}\);\n\s+bankUnsaved\?\.clean\(\);\n\s+showToast\("口座情報を保存しました"\)/);
  assert.match(cd, /\}, \{ merge: true \}\);\n\s+subsidyUnsaved\?\.clean\(\);\n\s+showToast\("申請情報を保存しました"\)/);
  assert.match(cd, /sessionUnsaved\?\.clean\(\);\n\s+showToast\("伴走支援セッションを記録しました"\)/);
  assert.match(cd, /sessionEditUnsaved\?\.clean\(\);\n\s+showToast\("伴走支援の記録を更新しました"\)/);
  assert.match(cd, /if \(bankUnsaved\?\.isDirty\(\)\) \{ applyBankType\(\); return; \}/);
  assert.match(cd, /if \(subsidyUnsaved\?\.isDirty\(\)\) return;/);
});


// ===== 独立レビューの指摘への対応（2026-11-10） =====
// 書き込み回数を数える表示欄
function countingEl(id) {
  const el = { id, style: { display: "none" }, writes: 0, _t: "" };
  Object.defineProperty(el, "textContent", { get() { return this._t; }, set(v) { this._t = v; this.writes++; } });
  return el;
}
// 値のある入力欄（偽）
const field = (v = "") => ({ value: v });

t("指摘1: 評価IDが変わったら未保存の入力を捨てて流し込み直す／変わらなければ入力を残す", () => {
  const card = fakeEl("card"), status = countingEl("st");
  const tr = trackUnsaved("eval1", card, status, { window: fakeWin() });
  const saved = { "case1__2026-11-10__a": { s1: "○" }, "case1__2026-11-10__b": { s1: "◎" } };
  const score = field();
  // renderEval と同じ使い方: 流し込んでよいときだけ保存済みの値を入れる
  const render = (id, focused = false) => { if (shouldRefillForm(tr, id, focused, "取り消しました")) score.value = (saved[id] || {}).s1 || ""; };
  render("case1__2026-11-10__a");
  assert.equal(score.value, "○");
  score.value = "×"; card.fire("change", {});              // A の評価を入力（未保存）
  render("case1__2026-11-10__a");                           // 同じ評価ID（自動保存の通知など）
  assert.equal(score.value, "×", "評価IDが同じなら入力は残る");
  assert.equal(tr.isDirty(), true);
  render("case1__2026-11-10__a", true);
  assert.equal(score.value, "×");
  render("case1__2026-11-10__b", true);                     // 実施者を B に変えて保存（入力中でも）
  assert.equal(score.value, "◎", "評価IDが変わったら B の保存済みの値に流し込み直す");
  assert.equal(tr.isDirty(), false, "A の未保存は捨てる");
  assert.equal(status.textContent, "取り消しました", "捨てたことを画面に出す");
  assert.equal(status.style.display, "");
  render("case1__2026-11-11__b");                           // 実施日の変更（未保存なし）でも流し込む
  assert.equal(score.value, "");
  card.fire("input", {}); assert.equal(status.textContent, UNSAVED_TEXT, "次の入力で表示は「未保存」に戻る");
  tr.clean();
});
t("指摘1: renderEval が shouldRefillForm（評価ID）で流し込みを決めている", () => {
  const body = sc.slice(sc.indexOf("function renderEval()"), sc.indexOf("async function saveEvaluation"));
  assert.match(body, /const refill = shouldRefillForm\(evalUnsaved, myEvalId\(\), focused, "[^"]+"\);/);
  assert.match(body, /if \(refill\) \{\n\s+ITEMS\.forEach/);
});

t("指摘2: active() が false の間（トレーナーでない人）は入力しても未保存にならない", () => {
  let trainer = false;
  const card = fakeEl("c"), status = countingEl("s");
  const tr = trackUnsaved("eval2", card, status, { active: () => trainer, window: fakeWin() });
  card.fire("change", {}); card.fire("input", {});
  assert.equal(tr.isDirty(), false);
  assert.equal(status.writes, 0, "表示も出さない");
  let e = unloadEvent(); onBeforeUnload(e); assert.equal(e.prevented, false, "離れるときの確認も出ない");
  trainer = true;
  card.fire("change", {});
  assert.equal(tr.isDirty(), true);
  tr.clean();
  // renderEval でもトレーナーでなければ消す
  const body = sc.slice(sc.indexOf("function renderEval()"), sc.indexOf("async function saveEvaluation"));
  assert.match(body, /if \(!canSave\) evalUnsaved\.clean\(\);/);
});

t("指摘3: 未保存の間に他の人の更新で値が変わったら知らせる（自分の書き込みでは出さない）", () => {
  const root = fakeEl("r"), status = countingEl("s");
  const tr = trackUnsaved("bank3", root, status, { window: fakeWin() });
  tr.observe({ bankName: "A銀行", bankCode: "0001" });            // 最初の値
  root.fire("input", {});                                          // 入力（未保存）
  assert.equal(tr.observe({ bankCode: "0001", bankName: "A銀行", updatedAt: { toMillis: () => 5 } }), false,
    "キーの順番・updatedAt が違うだけなら同じ");
  assert.equal(tr.observe({ bankName: "A銀行", bankCode: "0001", x: 1 }, { own: true }), false, "自分の書き込みでは出さない");
  assert.equal(status.textContent, UNSAVED_TEXT);
  assert.equal(tr.observe({ bankName: "B銀行", bankCode: "0001", x: 1 }), true, "他の人の更新");
  assert.equal(status.textContent, `${UNSAVED_TEXT}。${CONFLICT_TEXT}`);
  assert.equal(tr.observe({ bankName: "B銀行", bankCode: "0001", x: 1 }), true, "消えずに残る");
  tr.clean();
  assert.equal(status.textContent, ""); assert.equal(status.style.display, "none");
  tr.observe({ bankName: "C銀行" });                                // 未保存でなければ出さない
  assert.equal(status.textContent, "");
  assert.equal(stableKey({ b: 1, a: [1, { d: 2, c: 3 }] }), stableKey({ a: [1, { c: 3, d: 2 }], b: 1 }));
});
t("指摘3: 口座・申請情報・実施の記録・評価で hasPendingWrites を渡して observe している", () => {
  assert.match(cd, /bankUnsaved\?\.observe\(cl\?\.bankAccountInfo \|\| null, \{ own \}\);\n\s+if \(bankUnsaved\?\.isDirty\(\)\)/);
  assert.match(cd, /subsidyUnsaved\?\.observe\(sa \|\| null, \{ own \}\);/);
  assert.match(cd, /renderDocumentChecklist\(snap\.exists\(\) \? snap\.data\(\) : null, !!snap\.metadata\?\.hasPendingWrites\)/);
  assert.match(cd, /renderSubsidy\(subsidyCache, !!snap\.metadata\?\.hasPendingWrites\)/);
  assert.match(sc, /perfUnsaved\.observe\(perf, \{ own: !!\(snap\.metadata && snap\.metadata\.hasPendingWrites\) \}\)/);
  assert.match(sc, /evalsOwn = !!\(snap\.metadata && snap\.metadata\.hasPendingWrites\)/);
  assert.match(sc, /evalUnsaved\.observe\(ev \|\| null, \{ own: evalsOwn \}\)/);
});

// 本物の <select> のように、選択肢に無い値は入らない偽の select
function fakeSelect() {
  let v = "";
  return { innerHTML: "", get value() { return v; },
    set value(x) { v = x === "" || this.innerHTML.includes(`value="${x}"`) ? x : ""; } };
}
t("指摘4: 職員一覧が後から届いたら、未保存でも選択肢を作り、選んでいる値は保つ", () => {
  const sel = fakeSelect();
  fillPeopleSelect(sel, [], "a@tadakayo.jp", false, false);           // 一覧が届く前
  assert.equal(sel.innerHTML.includes("山田"), false);
  const users = [{ _id: "a@tadakayo.jp", name: "山田" }, { _id: "b@tadakayo.jp", name: "鈴木" }];
  fillPeopleSelect(sel, users, "a@tadakayo.jp", false, true);         // 未保存のまま一覧が届く
  assert.ok(sel.innerHTML.includes(">山田<") && sel.innerHTML.includes(">鈴木<"), "選択肢ができる");
  assert.equal(sel.value, "a@tadakayo.jp", "選んでいなければ既定（担当営業）");
  sel.value = "b@tadakayo.jp";                                          // 利用者が B を選ぶ（未保存）
  fillPeopleSelect(sel, [...users, { _id: "c@tadakayo.jp", name: "佐藤" }], "a@tadakayo.jp", false, true);
  assert.equal(sel.value, "b@tadakayo.jp", "選んでいる値は保つ");
  assert.ok(sel.innerHTML.includes(">佐藤<"));
  fillPeopleSelect(sel, users, "a@tadakayo.jp", false, false);        // 未保存でなければ保存済みの値
  assert.equal(sel.value, "a@tadakayo.jp");
  const tsel = fakeSelect();
  fillPeopleSelect(tsel, users, "", true, true);
  assert.ok(tsel.innerHTML.startsWith(`<option value="">—</option>`)); assert.equal(tsel.value, "");
  fillPeopleSelect(tsel, [{ _id: "x<y", name: "<b>" }], "x<y", true, false);
  assert.ok(tsel.innerHTML.includes("&lt;b&gt;"), "名前はエスケープする");
});
t("指摘4: refreshPeople は未保存なら選択肢だけ作り直す", () => {
  assert.match(sc, /refreshPeople\(\) \{ if \(perfUnsaved\.isDirty\(\)\) fillPerfOptions\(true\); else fillPerfForm\(\);/);
  assert.match(sc, /function fillPerfForm\(\) \{\n\s+fillPerfOptions\(false\);/);
});

t("指摘5: discardUnsaved のあとは離れるときの確認が出ない／削除・対象外・ログアウト・案件なしで移動の前に呼ぶ", () => {
  const root = fakeEl("r");
  const tr = trackUnsaved("nav5", root, null, { window: fakeWin() });
  root.fire("input", {});
  let e = unloadEvent(); onBeforeUnload(e); assert.equal(e.prevented, true);
  discardUnsaved();
  e = unloadEvent(); onBeforeUnload(e); assert.equal(e.prevented, false);
  assert.equal(tr.isDirty(), false);
  assert.match(cd, /discardUnsaved\(\);[^\n]*\n\s+location\.href = "\/cases\.html";/);
  assert.equal((cd.match(/discardUnsaved\(\);[^\n]*\n\s+location\.href = "\/cases\.html";/g) || []).length, 2, "削除・案件なし");
  assert.equal((cd.match(/discardUnsaved\(\);\n\s+setTimeout\(\(\) => location\.reload\(\), 600\);/g) || []).length, 1);
  assert.equal((cd.match(/discardUnsaved\(\);[^\n]*\n\s+setTimeout\(\(\) => location\.reload\(\), 600\);/g) || []).length, 2, "対象外にする・解除");
  assert.match(cd, /signOut\(auth\)\.then\(\(\) => \{ discardUnsaved\(\); location\.href = "\/index\.html"; \}\)/);
  assert.match(cd, /if \(invUrl\) \{ if \(invTab\) invTab\.location\.href = invUrl; else location\.href = invUrl; \}/, "請求書への移動は確認が出るまま");
});

t("指摘6: 未保存の文言は状態が変わったときだけ書き込む", () => {
  const root = fakeEl("r"), status = countingEl("s");
  const tr = trackUnsaved("aria6", root, status, { window: fakeWin() });
  for (let i = 0; i < 5; i++) root.fire("input", {});
  root.fire("change", {}); tr.mark();
  assert.equal(status.writes, 1, `書き込み回数 ${status.writes}`);
  tr.observe({ a: 1 }); tr.observe({ a: 1 });
  assert.equal(status.writes, 1);
  tr.clean(); tr.clean();
  assert.equal(status.writes, 2);
});

console.log(`test-save-mode: ${n} 件 OK`);
