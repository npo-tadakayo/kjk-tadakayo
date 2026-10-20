// 練習モード（学習用テストモード）の「漏れ」検査。node scripts/test-practice-mode.mjs
// 画面が本番へ直接つながる経路（Firestore・Functions・Storage の CDN を直接 import）が、
// 決めた例外以外に残っていないこと、練習中に呼ばれうる Functions すべてに代役があることを確かめる。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../admin/", import.meta.url));
const files = [
  ...readdirSync(join(ROOT, "js")).filter((f) => f.endsWith(".js")).map((f) => `js/${f}`),
  ...readdirSync(ROOT).filter((f) => f.endsWith(".html")),
];
const src = Object.fromEntries(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

const CDN = (m) => `https://www.gstatic.com/firebasejs/10.12.2/firebase-${m}.js`;

// 1) Firestore を CDN から直接読むのは、本番の users を見る必要があるもの・ログイン前の公開ページ・入口そのものだけ
const FS_ALLOWED = new Set([
  "js/fs.js",          // 入口そのもの
  "js/mode.js",        // 入口の下（練習DBを名指しで開く）
  "js/role.js",        // ロールは本番の users で決まる
  "js/auth.js",        // ログイン時の users 確認
  "js/consent-sign.js",// 事業所が開く署名ページ（ログインなし・本番の依頼を読む）
  "js/partner.js",     // 認定事業者ポータル（職員の練習モードと無関係）
]);
for (const [f, s] of Object.entries(src)) {
  if (s.includes(CDN("firestore"))) ok(FS_ALLOWED.has(f), `${f} が Firestore を CDN から直接 import している（/js/fs.js を使う）`);
}
// 例外の中で、練習DBを使うべき業務データを読んでいないか（role/auth は users だけ）
for (const f of ["js/role.js", "js/auth.js"]) {
  const names = [...src[f].matchAll(/(?:doc|collection)\(\s*[A-Za-z_]+\s*,\s*"([^"]+)"/g)].map((m) => m[1]);
  ok(names.every((n) => n === "users"), `${f} が users 以外を読んでいる: ${names.join(",")}`);
}

// 2) Functions を CDN から直接読むのは入口（fn.js）と、練習DBだけを初期化する settings.js の resetPractice だけ
for (const [f, s] of Object.entries(src)) {
  if (!s.includes(CDN("functions"))) continue;
  ok(f === "js/fn.js" || f === "js/settings.js", `${f} が Functions を CDN から直接 import している（/js/fn.js を使う）`);
}
{
  const s = src["js/settings.js"];
  const real = [...s.matchAll(/realCallable\(\s*functions\s*,\s*"([^"]+)"/g)].map((m) => m[1]);
  ok(real.length === 1 && real[0] === "resetPractice", `settings.js の realCallable は resetPractice だけ: ${real}`);
}

// 3) Storage に書く経路は st.js 経由だけ（video-player.js は動画を読むだけ）
for (const [f, s] of Object.entries(src)) {
  if (!s.includes(CDN("storage"))) continue;
  ok(f === "js/st.js" || f === "js/video-player.js", `${f} が Storage を CDN から直接 import している（/js/st.js を使う）`);
}
ok(!/uploadBytes|deleteObject/.test(src["js/video-player.js"]), "video-player.js が Storage に書いている");

// 4) 画面から呼ぶ Functions（httpsCallable の名前）すべてに練習用の代役がある
const stubSrc = src["js/practice-stubs.js"];
const stubNames = new Set([...stubSrc.matchAll(/^\s{2}async ([A-Za-z]+)\(/gm)].map((m) => m[1]));
const called = new Set();
for (const [f, s] of Object.entries(src)) {
  for (const m of s.matchAll(/httpsCallable\(\s*[A-Za-z_.]+\s*,\s*"([^"]+)"/g)) called.add(m[1]);
}
ok(called.size >= 12, `httpsCallable の呼び出しが想定より少ない（${called.size}）`);
for (const n of called) ok(stubNames.has(n), `練習用の代役が無い Functions: ${n}`);

// 5) fn.js は練習中に本物を呼ばない（isPracticeMode で分岐し、代役が無ければエラー）
ok(/if \(!isPracticeMode\(\)\) return FN\.httpsCallable/.test(src["js/fn.js"]), "fn.js の分岐が無い");
ok(/throw new Error\(`練習モードでは/.test(src["js/fn.js"]), "fn.js が代役の無い呼び出しを止めていない");

// 6) 代役は fetch などで外へ出ない
ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(stubSrc), "practice-stubs.js が外部へ通信している");

// 7) 作成者の印（_practiceBy）を付けない共有コレクション
ok(/SHARED = new Set\(\["_counters", "appConfig"\]\)/.test(src["js/fs.js"]), "fs.js の共有コレクションの指定が変わっている");

// 8) 練習生のロールが選べる
ok(/value="trainee"/.test(src["users.html"]), "ユーザー管理に練習生が無い");

// 9) 本番の Callable はすべて練習生を拒否する（SDK から直接呼ばれても本番を触らせない）
{
  const fnRoot = fileURLToPath(new URL("../functions/", import.meta.url));
  const idx = readFileSync(join(fnRoot, "index.js"), "utf8");
  const parts = idx.split(/(?=^exports\.[A-Za-z]+ = onCall\()/m).slice(1);
  ok(parts.length >= 11, `index.js の onCall が想定より少ない（${parts.length}）`);
  for (const part of parts) {
    const name = part.match(/^exports\.([A-Za-z]+)/)[1];
    const head = part.slice(0, part.indexOf("async (request) => {") + 200);
    // aiAssist は Firestore を読めない SA で動き、本番のデータに触れないので例外（index.js のコメント参照）
    if (name === "aiAssist") { ok(!/await rejectTrainee/.test(head), "aiAssist は rejectTrainee を呼ばない（SA の権限）"); continue; }
    ok(/await rejectTrainee\(request\);/.test(head), `${name} が練習生を拒否していない`);
  }
  const an = readFileSync(join(fnRoot, "analytics.js"), "utf8");
  ok(/role === "trainee"/.test(an.slice(an.indexOf("exports.collectAnalyticsNow"))), "collectAnalyticsNow が練習生を拒否していない");
}

// 10) 練習で作った署名依頼は練習DBで開く（p=1）。本番の署名ページの既定は本番DBのまま
ok(/isPracticeLink \? getFirestore\(app, "practice"\) : getFirestore\(app\)/.test(src["js/consent-sign.js"]), "署名ページの練習DB切替が無い");
ok(/isPracticeMode\(\) \? "&p=1" : ""/.test(src["js/consent-admin.js"]), "署名URLに練習の印が付かない");

console.log(`OK test-practice-mode: ${checks} checks passed（呼び出し ${called.size} 種・代役 ${stubNames.size} 種）`);
