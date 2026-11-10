// ケアプラン連携の「導入状況」（support-cp-install.js と support-checklist.js の配線）のテスト。
// node scripts/test-support-cp-install.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CP_INSTALL_OPTS, CP_SKIP_PRE_TEXT, CP_SKIP_ONSITE_TEXT, cpInstalled, applyCpInstalled } from "../admin/js/support-cp-install.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// --- 純粋関数 ---
t("選択肢は 未確認／未導入（今回導入する）／導入済み", () => {
  assert.deepEqual(CP_INSTALL_OPTS.map((o) => o.v), ["", "new", "installed"]);
  assert.deepEqual(CP_INSTALL_OPTS.map((o) => o.t), ["未確認", "未導入（今回導入する）", "導入済み"]);
  assert.equal(CP_SKIP_ONSITE_TEXT, "ケアプランデータ連携システムは導入済みのため、当日の作業は省略します");
});
t("導入済みだけが true。installStatus が無い既存の案件・未確認・未導入は false", () => {
  assert.equal(cpInstalled({ installStatus: "installed" }), true);
  for (const cp of [undefined, null, {}, { steps: {} }, { installStatus: "" }, { installStatus: "new" }]) assert.equal(cpInstalled(cp), false);
});

// --- 畳む／戻す（最小の偽 DOM） ---
function fakeRoot() {
  const mk = (initial) => ({ style: { display: initial } });
  const skip = [mk(""), mk(""), mk("")];   // 工程・証憑・事前確認の欄（初期表示は見える）
  const notes = [mk("none"), mk("none")]; // 省略の表示（初期は隠れている）
  return {
    skip, notes,
    querySelectorAll(sel) {
      if (sel === "[data-cp-skip]") return skip;
      if (sel === "[data-cp-skip-note]") return notes;
      return [];
    },
  };
}
t("導入済みのときは欄を畳み、省略の表示を出す", () => {
  const r = fakeRoot();
  applyCpInstalled(r, cpInstalled({ installStatus: "installed" }));
  assert.ok(r.skip.every((e) => e.style.display === "none"));
  assert.ok(r.notes.every((e) => e.style.display === ""));
});
t("無い／未確認／未導入のときは全部出る（導入済みを外せば元どおり）", () => {
  for (const cp of [{}, { installStatus: "" }, { installStatus: "new" }]) {
    const r = fakeRoot();
    applyCpInstalled(r, true);
    applyCpInstalled(r, cpInstalled(cp));
    assert.ok(r.skip.every((e) => e.style.display === ""));
    assert.ok(r.notes.every((e) => e.style.display === "none"));
  }
  applyCpInstalled(null, true); // root が無くても落ちない
});

// --- support-checklist.js の配線 ---
const sc = src("../admin/js/support-checklist.js");
const fnBody = (name) => { const i = sc.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return sc.slice(i, sc.indexOf("\nfunction ", i + 1)); };
t("事前確認カードの先頭に導入状況（cp.installStatus）があり、対応ソフト・電子請求・証明書の種類は畳む対象", () => {
  const pre = fnBody("cardCpPre");
  assert.match(pre, /selectGroup\("sc-cp-installStatus", "cp", "installStatus", "[^"]+", CP_INSTALL_OPTS\)/);
  const skipStart = pre.indexOf("<div data-cp-skip>");
  assert.ok(pre.indexOf("installStatus") < skipStart, "導入状況は畳む範囲の外（先頭）");
  const skipped = pre.slice(skipStart, pre.indexOf("</div>\n        <div class=\"form-group\">", skipStart));
  for (const p of ['key: "software"', '"eBilling"', '"certType"']) assert.ok(skipped.includes(p), `${p} が畳む範囲にない`);
  assert.ok(!skipped.includes("partnerStatus"), "取引先の導入状況は畳まない");
  assert.match(pre, /cpSkipNote\(CP_SKIP_PRE_TEXT\)/);
});
t("当日の導入作業（6工程）と証憑写真は畳む対象で、省略の表示がある", () => {
  const steps = fnBody("cardCpSteps");
  assert.ok(steps.indexOf("<div data-cp-skip>") < steps.indexOf('CP_STEPS.map((i) => rowStep("cp", i))'));
  assert.match(steps, /cpSkipNote\(CP_SKIP_ONSITE_TEXT\)/);
  const ev = fnBody("cardCpEvidence");
  assert.ok(ev.indexOf("<div data-cp-skip>") < ev.indexOf('id="sc-cp-photo-btn"'));
  assert.ok(ev.indexOf("<div data-cp-skip>") < ev.indexOf('id="sc-cp-photos"'));
  assert.match(ev, /cpSkipNote\(CP_SKIP_ONSITE_TEXT\)/);
});
t("アフタータブ（cardCpAfter）は変えない＝畳まない", () => {
  assert.ok(!fnBody("cardCpAfter").includes("data-cp-skip"));
});
t("読み込み時と導入状況の変更時に切り替える（データは消さない）", () => {
  assert.match(sc, /fillOnsiteDefaults\(\);\n\s+renderPhotos\(\);\n\s+syncCpInstalled\(\);/);
  assert.match(sc, /if \(sec === "cp" && path === "installStatus"\) syncCpInstalled\(\);/);
  assert.match(sc, /applyCpInstalled\(root, cpInstalled\(state\.cp\)\)/);
  const sync = sc.slice(sc.indexOf("function syncCpInstalled"), sc.indexOf("}", sc.indexOf("function syncCpInstalled")) + 1);
  assert.ok(!/delete|= \{\}|setDoc|saveSection/.test(sync), "畳むときに保存・削除しない");
});
t("完了判定・育成の判定は導入状況を見ない", () => {
  for (const f of ["../admin/js/case-complete-check.js", "../admin/js/learning-core.js"]) assert.ok(!src(f).includes("installStatus"), f);
});

console.log(`test-support-cp-install: ${n} 件 OK`);
