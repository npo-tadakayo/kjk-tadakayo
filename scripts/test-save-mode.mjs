// 保存のしかたの表示と未保存の確認（save-mode.js）、および伴走支援チェックリスト・案件詳細への配線のテスト。
// node scripts/test-save-mode.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTO_SAVE_NOTE, UNSAVED_TEXT, manualSaveNote, saveModeNoteHtml, unsavedSpanHtml,
  trackUnsaved, hasUnsaved, onBeforeUnload, bindUnloadGuard } from "../admin/js/save-mode.js";

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
  assert.match(sc, /trackUnsaved\("supportEvaluation", \$\("sc-eval-card"\), "sc-eval-unsaved"\)/);
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
  assert.match(cd, /import \{ trackUnsaved, unsavedSpanHtml \} from "\/js\/save-mode\.js";/);
  for (const k of ['"session"', '"sessionEdit"', '"bank"', '"subsidy"']) assert.ok(cd.includes(`trackUnsaved(${k},`), k);
  assert.match(cd, /merge: true \}\);\n\s+bankUnsaved\?\.clean\(\);\n\s+showToast\("口座情報を保存しました"\)/);
  assert.match(cd, /\}, \{ merge: true \}\);\n\s+subsidyUnsaved\?\.clean\(\);\n\s+showToast\("申請情報を保存しました"\)/);
  assert.match(cd, /sessionUnsaved\?\.clean\(\);\n\s+showToast\("伴走支援セッションを記録しました"\)/);
  assert.match(cd, /sessionEditUnsaved\?\.clean\(\);\n\s+showToast\("伴走支援の記録を更新しました"\)/);
  assert.match(cd, /if \(bankUnsaved\?\.isDirty\(\)\) \{ applyBankType\(\); return; \}/);
  assert.match(cd, /if \(subsidyUnsaved\?\.isDirty\(\)\) return;/);
});

console.log(`test-save-mode: ${n} 件 OK`);
