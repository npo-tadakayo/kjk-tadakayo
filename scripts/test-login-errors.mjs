// ログイン失敗の日本語の説明のテスト。node scripts/test-login-errors.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { authErrorCode, loginErrorMessage } from "../admin/js/login-errors.js";

let n = 0;
const t = (c, m) => { assert.ok(c, m); n++; };
const fbErr = (code) => Object.assign(new Error(`Firebase: Error (${code}).`), { code });

// コードの取り出し
t(authErrorCode(fbErr("auth/unauthorized-domain")) === "auth/unauthorized-domain", "code から");
t(authErrorCode(new Error("Firebase: Error (auth/popup-blocked).")) === "auth/popup-blocked", "message から");
t(authErrorCode(new Error("ふつうの日本語")) === "", "コード無し");
t(authErrorCode(null) === "", "null");

// 11/9〜11/11 の事故の表示
{
  const m = loginErrorMessage(fbErr("auth/unauthorized-domain"), "staff");
  t(m.isSystem, "システム側の問題として扱う");
  t(m.text.includes("あなたの操作の問題ではありません"), "本人のせいではないと伝える");
  t(m.text.includes("管理者（次田）"), "職員には連絡先として管理者");
  t(m.text.includes("auth/unauthorized-domain"), "問い合わせ用にコードを添える");
  t(!/Firebase: Error/.test(m.text), "英語の生メッセージを出さない");
  const p = loginErrorMessage(fbErr("auth/unauthorized-domain"), "partner");
  t(p.text.includes("タダカヨの担当者") && !p.text.includes("次田"), "事業者には担当者");
}
// 本人の操作で直るもの
for (const c of ["auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/popup-blocked",
  "auth/network-request-failed", "auth/too-many-requests"]) {
  const m = loginErrorMessage(fbErr(c));
  t(!m.isSystem, `${c} は本人で直せる`);
  t(/[ぁ-ん]/.test(m.text) && !m.text.includes("Firebase"), `${c} は日本語`);
}
// システム側
for (const c of ["auth/internal-error", "auth/operation-not-allowed", "auth/user-disabled"]) {
  t(loginErrorMessage(fbErr(c)).isSystem, `${c} はシステム側`);
}
// 知らないコード
{
  const m = loginErrorMessage(fbErr("auth/something-new"));
  t(m.text.includes("auth/something-new") && m.text.includes("ご連絡ください"), "知らないコードもコードを添えて連絡を促す");
}
// 画面側で作った日本語のエラーはそのまま
t(loginErrorMessage(new Error("@tadakayo.jp のアカウントのみ利用できます")).text === "@tadakayo.jp のアカウントのみ利用できます", "日本語はそのまま");
// 英語の非 Firebase エラーは生で出さない
t(!loginErrorMessage(new Error("Something broke")).text.includes("Something"), "英語の生メッセージは出さない");

// 結線: 2つのログイン画面が e.message を直接出していない
const idx = fs.readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
const par = fs.readFileSync(new URL("../admin/js/partner.js", import.meta.url), "utf8");
t(idx.includes('m.loginErrorMessage(e, "staff")') && idx.includes('import("/js/login-errors.js")'), "管理画面の結線（失敗時だけ読む）");
t(par.includes('m.loginErrorMessage(e, "partner")') && par.includes('import("./login-errors.js")'), "ポータルの結線（失敗時だけ読む）");
t(!/^\s*import .*login-errors/m.test(idx) && !/^import .*login-errors/m.test(par), "静的 import にしない（部品が読めなくてもボタンが動く）");

console.log(`PASS test-login-errors: ${n} 件`);
