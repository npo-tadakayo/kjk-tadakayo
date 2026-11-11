// 管理画面（firebase.json の hosting target "admin"）のセキュリティヘッダーのテスト（2026-11-12）。
// node scripts/test-admin-security-headers.mjs
// ・必須のヘッダーがそろっていること（リリース前チェックの6項目＋既存の2つが変わっていないこと）
// ・CSP（いまは Report-Only）が、管理画面の HTML / JS が実際に読み込んでいる外部の先を許可していること
//   （新しい CDN を足したのに CSP を直し忘れる、を防ぐ）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fb = JSON.parse(fs.readFileSync(path.join(REPO, "firebase.json"), "utf8"));

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

const admin = fb.hosting.find((h) => h.target === "admin");
assert.ok(admin, "hosting に target admin がありません");
const all = (admin.headers || []).find((h) => h.source === "**");
assert.ok(all, "admin の headers に source ** がありません");
const H = Object.fromEntries(all.headers.map(({ key, value }) => [key.toLowerCase(), value]));

t("既存の2つは変えていない", () => {
  assert.equal(H["cache-control"], "no-cache, max-age=0");
  // signInWithPopup のポップアップと親画面がやりとりするため same-origin にはしない
  assert.equal(H["cross-origin-opener-policy"], "same-origin-allow-popups");
});

t("リリース前チェックの必須ヘッダーがそろっている", () => {
  assert.equal(H["x-content-type-options"], "nosniff");
  assert.equal(H["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(H["x-robots-tag"], "noindex, nofollow");
  assert.ok(H["permissions-policy"], "Permissions-Policy がありません");
  assert.ok(H["content-security-policy"] || H["content-security-policy-report-only"], "CSP がありません");
});

t("X-Frame-Options と frame-ancestors（自分自身の iframe を壊さない）", () => {
  // supply-print.js は report.html を画面外の iframe で開いて PDF にする → DENY にすると壊れる
  const selfFrames = fs.readFileSync(path.join(REPO, "admin/js/supply-print.js"), "utf8").includes('createElement("iframe")');
  assert.ok(["DENY", "SAMEORIGIN"].includes(H["x-frame-options"]), "X-Frame-Options は DENY か SAMEORIGIN");
  if (selfFrames) assert.equal(H["x-frame-options"], "SAMEORIGIN", "管理画面が自分を iframe に入れているので SAMEORIGIN");
});

t("Permissions-Policy: マイク・位置情報・決済・USB は止める／カメラは自分のページだけ", () => {
  const pp = H["permissions-policy"];
  for (const f of ["microphone=()", "geolocation=()", "payment=()", "usb=()"]) assert.ok(pp.includes(f), f);
  // supply.html の写真の欄（<input type=file capture>）を念のため止めない。第三者の iframe からは使わせない
  assert.ok(pp.includes("camera=(self)"), "camera=(self)");
});

// ---- CSP の中身 ----
const cspText = H["content-security-policy"] || H["content-security-policy-report-only"];
const csp = Object.fromEntries(cspText.split(";").map((s) => s.trim()).filter(Boolean).map((d) => {
  const [name, ...vals] = d.split(/\s+/); return [name, vals];
}));
const allows = (dir, origin) => (csp[dir] || csp["default-src"] || []).includes(origin);

t("CSP の土台（ふさぐべきもの）", () => {
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'self'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'self'"]);
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.ok(!cspText.includes("'unsafe-eval'"), "unsafe-eval は入れない");
  assert.ok(!/(^|\s)\*(\s|;|$)/.test(cspText), "ワイルドカード * だけの許可は入れない");
});

// 管理画面の HTML / JS / CSS を全部読み、外部から読み込んでいる先を集める
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" ? [] : walk(p);
    return /\.(html|js|css|mjs)$/.test(e.name) ? [p] : [];
  });
}
const files = walk(path.join(REPO, "admin"));
const origin = (u) => new URL(u).origin;
const found = { "script-src": new Set(), "style-src": new Set() };
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  for (const m of s.matchAll(/<script[^>]+src="(https:\/\/[^"]+)"/g)) found["script-src"].add(origin(m[1]));
  for (const m of s.matchAll(/(?:from\s*|import\s*\(?\s*)["'](https:\/\/[^"']+)["']/g)) found["script-src"].add(origin(m[1]));
  for (const m of s.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(https:\/\/[^"]+)"/g)) found["style-src"].add(origin(m[1]));
  for (const m of s.matchAll(/@import\s+url\(['"]?(https:\/\/[^'")]+)/g)) found["style-src"].add(origin(m[1]));
}

t("管理画面が読み込む外部のスクリプトは全部 script-src にある", () => {
  assert.ok(found["script-src"].size >= 2, "スクリプトの読み込み先を拾えていない（正規表現が古い？）");
  for (const o of found["script-src"]) assert.ok(allows("script-src", o), `script-src に ${o} がありません`);
});

t("管理画面が読み込む外部のスタイルは全部 style-src にある", () => {
  assert.ok(found["style-src"].size >= 2, "スタイルの読み込み先を拾えていない");
  for (const o of found["style-src"]) assert.ok(allows("style-src", o), `style-src に ${o} がありません`);
  // Google Fonts の CSS が読むフォント本体と、tabler-icons の CSS が読むフォント
  if (found["style-src"].has("https://fonts.googleapis.com")) assert.ok(allows("font-src", "https://fonts.gstatic.com"));
  if (found["style-src"].has("https://cdn.jsdelivr.net")) assert.ok(allows("font-src", "https://cdn.jsdelivr.net"));
});

t("Firebase（ログイン・Firestore・Storage・Functions）の通信先", () => {
  const cfg = fs.readFileSync(path.join(REPO, "admin/js/firebase-config.js"), "utf8");
  const authDomain = cfg.match(/authDomain:\s*"([^"]+)"/)[1];
  assert.ok(allows("frame-src", `https://${authDomain}`), "signInWithPopup の iframe（authDomain）");
  assert.ok(allows("script-src", "https://apis.google.com"), "signInWithPopup が読む gapi");
  for (const o of ["https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com",
    "https://firestore.googleapis.com", "https://firebasestorage.googleapis.com",
    "https://asia-northeast1-kjk-tadakayo.cloudfunctions.net"]) assert.ok(allows("connect-src", o), `connect-src に ${o}`);
  assert.ok(allows("media-src", "https://firebasestorage.googleapis.com"), "研修動画（Storage の mp4/vtt）");
  assert.ok(allows("img-src", "https://firebasestorage.googleapis.com"), "証憑写真（Storage）");
});

t("公開ページ（lp）のヘッダーは変えていない", () => {
  const lp = fb.hosting.find((h) => h.target === "lp");
  const lpAll = lp.headers.find((h) => h.source === "**");
  const keys = lpAll.headers.map((h) => h.key);
  for (const k of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"]) {
    assert.ok(keys.includes(k), `lp に ${k}`);
  }
});

console.log(`OK test-admin-security-headers: ${n} 件合格（外部スクリプト ${found["script-src"].size} 先・外部スタイル ${found["style-src"].size} 先を照合）`);
