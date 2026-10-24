// 事業所画面（編集・統合）の静的検査。node scripts/test-office-ui.mjs
// ブラウザ専用の ES module なので、読み込まずにソースの結線だけを確かめる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rd = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const js = rd("admin/js/offices.js"), html = rd("admin/offices.html"), stubs = rd("admin/js/practice-stubs.js");
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

for (const name of ["updateOffice", "mergeOffices", "unmergeOffice"]) {
  ok(new RegExp(`httpsCallable\\(functions, "${name}"\\)`).test(js), `offices.js が ${name} を呼んでいない`);
  ok(new RegExp(`^  async ${name}\\(data\\)`, "m").test(stubs), `練習用の代役が無い: ${name}`);
}
ok(/from "\/js\/fn\.js"/.test(js), "Functions は /js/fn.js 経由にする（練習モードの差し替え）");
ok(!/firebase-functions\.js/.test(js), "offices.js が Functions を CDN から直接読んでいる");
ok(/isViewer\(role\)/.test(js) && /canEdit/.test(js), "閲覧のみの判定が無い");
ok(/g\.key\.startsWith\("o:"\)/.test(js), "マスター未登録（n:）にメニューを出さない判定が無い");
ok(/e\.stopPropagation\(\)/.test(js) && /\.row-menu-btn/.test(js), "…ボタンが行の開閉と分かれていない");
ok(/aria-haspopup="menu"/.test(js), "…ボタンに aria-haspopup が無い");
for (const t of ["編集", "ほかの事業所と統合", "統合を取り消す"]) ok(js.includes(t), `メニュー項目が無い: ${t}`);
for (const t of ["名前が同じ", "電話が同じ", "住所が同じ"]) ok(js.includes(t), `候補の理由が無い: ${t}`);
ok(js.includes("の表示名も変わります"), "編集前の案件数の注意が無い");
ok(js.includes("統合を取り消す") && js.includes("元に戻せます"), "統合の確認に取り消せる旨が無い");
ok(js.includes("統合済み") && /mergedInto/.test(js), "統合済みの扱いが無い");
for (const id of ["dupOnly", "showMerged", "dupBadge", "editModal", "mergeModal", "rowMenu"]) ok(html.includes(`id="${id}"`), `offices.html に ${id} が無い`);
ok(html.includes("重複の候補だけ") && html.includes("統合済みも表示"), "チェックボックスの文言");
ok(/esc\(g\.officeName\)/.test(js), "事業所名をエスケープしていない");
ok(!/cdn\.|https:\/\/[^"]*\.js/.test(html.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@tabler[^"]+/, "")), "offices.html に CDN の追加がある");
ok(!/updateDoc|setDoc|addDoc|writeBatch/.test(js), "offices.js が Firestore を直接書いている（Callable 経由だけにする）");
ok(js.includes("統合を続ける") && js.includes("統合が途中で止まっています"), "途中で止まった統合の表示・操作が無い");
ok(/mergeStatus === "running"/.test(js), "running の判定が無い");
ok(/keep: \{\}/.test(js), "続きの実行は keep を空で呼ぶ");
ok(js.includes("toCasesRenamed") && js.includes("r.data.note"), "toCasesRenamed と note をトーストに出していない");
ok(js.includes("にもとからある案件"), "統合の確認に、残す側の既存案件の名前変更の説明が無い");
ok(/mergeLog/.test(stubs) && !/mergedRefs|mergedCaseSnapshots/.test(stubs.replace(/\/\/.*$/gm, "")), "代役が mergeLog 方式でない");
ok(/opLock/.test(stubs) && /ほかの人がこの事業所を更新中です/.test(stubs), "代役に作業中の印が無い");
ok(/canRestoreTo/.test(stubs) && /toCasesRenamed/.test(stubs), "代役が to の案件・canRestoreTo に対応していない");
console.log(`test-office-ui: ${n} checks passed`);
