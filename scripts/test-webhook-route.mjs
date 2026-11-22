// Chat の投稿先の解決（functions/webhook-route.js）と、各通知がどの投稿先を使うかのテスト。node scripts/test-webhook-route.mjs
// 2026-11-22 受付通知（reception）・今日の対応（daily）を追加。Firestore・Secret には触れない。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const W = require("../functions/webhook-route.js");
const idx = fs.readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const settingsJs = fs.readFileSync(new URL("../admin/js/settings.js", import.meta.url), "utf8");
const seed = fs.readFileSync(new URL("../functions/practice-seed.js", import.meta.url), "utf8");

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const R = W.resolveWebhook;
const TM = "https://chat.googleapis.com/v1/spaces/TM/messages?x";
const RC = "https://chat.googleapis.com/v1/spaces/RC/messages?x";
const DY = "https://chat.googleapis.com/v1/spaces/DY/messages?x";
const SEC = "https://chat.googleapis.com/v1/spaces/SECRET/messages?x";

t("従来の kind は挙動を変えない", () => {
  assert.equal(R("crm", { chatWebhookUrl: TM }, SEC), TM);
  assert.equal(R("crm", {}, SEC), SEC);
  assert.equal(R("crm", { chatWebhookEnabled: false, chatWebhookUrl: TM }, SEC), "");
  assert.equal(R("pm", {}, SEC), "");
  assert.equal(R("pm", { chatWebhookUrl: TM }, SEC), "");             // pm は crm に回さない（従来どおり）
  assert.equal(R("shipping", { shippingChatWebhookUrl: TM }, ""), TM);
  assert.equal(R("accounting", { accountingChatWebhookEnabled: false, accountingChatWebhookUrl: TM }, ""), "");
  assert.equal(R("unknown", { chatWebhookUrl: TM }, SEC), "");
  assert.equal(R("crm", null, SEC), SEC);
});

t("受付通知: 設定があればそこへ", () => {
  assert.equal(R("reception", { receptionChatWebhookUrl: RC, chatWebhookUrl: TM }, SEC), RC);
  assert.equal(R("reception", { receptionChatWebhookUrl: `  ${RC}  `, chatWebhookUrl: TM }, SEC), RC);
});
t("受付通知: 空欄なら CRM通知の投稿先、それも空なら Secret（通知を止めない）", () => {
  assert.equal(R("reception", { chatWebhookUrl: TM }, SEC), TM);
  assert.equal(R("reception", { receptionChatWebhookUrl: "  ", chatWebhookUrl: TM }, SEC), TM);
  assert.equal(R("reception", {}, SEC), SEC);
});
t("受付通知: 停止なら投稿しない（CRM通知にも回さない）", () => {
  assert.equal(R("reception", { receptionChatWebhookEnabled: false, receptionChatWebhookUrl: RC, chatWebhookUrl: TM }, SEC), "");
  assert.equal(R("reception", { receptionChatWebhookEnabled: false, chatWebhookUrl: TM }, SEC), "");
});
t("受付通知: 空欄で CRM通知が停止なら投稿しない", () => {
  assert.equal(R("reception", { chatWebhookEnabled: false, chatWebhookUrl: TM }, SEC), "");
});
t("今日の対応: 受付通知と同じ規則", () => {
  assert.equal(R("daily", { dailyChatWebhookUrl: DY, receptionChatWebhookUrl: RC, chatWebhookUrl: TM }, SEC), DY);
  assert.equal(R("daily", { receptionChatWebhookUrl: RC, chatWebhookUrl: TM }, SEC), TM); // 受付通知には回さない
  assert.equal(R("daily", {}, SEC), SEC);
  assert.equal(R("daily", { dailyChatWebhookEnabled: false, chatWebhookUrl: TM }, SEC), "");
});
t("Secret を読む kind", () => {
  assert.deepEqual([...W.KINDS_USING_CRM_SECRET].sort(), ["crm", "daily", "reception"]);
  for (const k of Object.keys(W.WEBHOOK_FALLBACK)) assert.ok(W.KINDS_USING_CRM_SECRET.includes(k), k);
});

// ===== 結線: どの通知がどの投稿先か（振り分け表 2026-11-22）=====
// 関数ごとに、その定義の範囲（次の exports. まで）にある getWebhook の kind を数える
function exportBody(name) {
  const i = idx.indexOf(`exports.${name} =`);
  assert.ok(i >= 0, `${name} が無い`);
  const j = idx.indexOf("\nexports.", i + 10);
  return idx.slice(i, j < 0 ? undefined : j);
}
function fnBody(name) {
  const i = idx.indexOf(`async function ${name}(`);
  assert.ok(i >= 0, `${name} が無い`);
  const j = idx.indexOf("\nexports.", i);
  const k = idx.indexOf("\nasync function ", i + 10);
  return idx.slice(i, Math.min(...[j, k].filter((x) => x > 0)));
}
const kinds = (src) => [...src.matchAll(/getWebhook\("([a-z]+)"\)/g)].map((m) => m[1]);
const ROUTES = {
  webhookLpInquiry: ["reception", "reception"],        // 新規LP問い合わせ・既存の案件に追記
  webhookMitsumori: ["reception", "reception"],        // 見積もり作成（設定 notifyQuoteChat のときだけ）
  acceptQuote: ["reception", "reception"],             // お申し込み（複数・1件）
  staffAcceptQuote: ["reception"],                     // 受注確定にしました
  dailyFollowup: ["daily"],                            // 日次フォローアップ
  onCaseAssigned: ["reception"],                       // 担当営業が決まりました
  onConsentSigned: ["reception"],                      // 承諾書にオンラインで署名されました
  dailyAuthDomainCheck: ["pm", "crm"],                 // 点検の警報は従来どおり
};
for (const [name, want] of Object.entries(ROUTES)) {
  t(`結線: ${name} → ${want.join(",")}`, () => assert.deepEqual(kinds(exportBody(name)), want));
}
t("結線: ご発注（承諾書への同意）→ reception", () => assert.deepEqual(kinds(fnBody("acceptQuoteByConsent")), ["reception"]));
t("結線: CRM の自動通知で crm を直接使うのは点検の警報だけ", () => {
  assert.equal(kinds(idx).filter((k) => k === "crm").length, 1);
});
t("結線: reception・daily を使う関数は Secret CHAT_WEBHOOK_URL を宣言している", () => {
  for (const name of [...Object.keys(ROUTES), "testChatNotify"]) {
    const b = exportBody(name);
    const head = b.slice(0, b.indexOf("async"));
    assert.ok(/secrets:\s*\[[^\]]*CHAT_WEBHOOK_URL/.test(head), name);
  }
  // acceptQuoteByConsent は acceptQuote から呼ばれる
  assert.ok(exportBody("acceptQuote").includes("acceptQuoteByConsent("));
});
t("結線: Secret を読む kind を使う export はすべて Secret を宣言している（ROUTES に無い関数も）", () => {
  // getWebhook("crm"|"reception"|"daily") を含む補助関数（トップレベルの async function）→ それを呼ぶ export へ辿る
  const re = new RegExp(`getWebhook\\("(${W.KINDS_USING_CRM_SECRET.join("|")})"\\)`);
  const helpers = [...idx.matchAll(/\nasync function (\w+)\(/g)].map((m) => m[1]).filter((h) => re.test(fnBody(h)));
  // トップレベルの宣言（exports. / function / async function / const / let / class）の境目で区切る
  // （export の後ろに置かれた補助関数の本文を、その export のものと数えない）
  const chunks = idx.split(/\n(?=(?:exports\.|async function |function |const |let |class ))/).filter((c) => c.startsWith("exports."));
  let checked = 0;
  for (const c of chunks) {
    const name = /^exports\.(\w+)/.exec(c)[1];
    const uses = re.test(c) || helpers.some((h) => new RegExp(`\\b${h}\\(`).test(c));
    if (!uses) continue;
    const head = c.slice(0, c.indexOf("async"));
    assert.ok(/secrets:\s*\[[^\]]*CHAT_WEBHOOK_URL/.test(head), `${name} に secrets: [CHAT_WEBHOOK_URL] が無い`);
    checked++;
  }
  assert.ok(checked >= Object.keys(ROUTES).length, `検査した関数が少ない（${checked}）`);
});
t("テスト送信: 受付通知・今日の対応を選べる", () => {
  const m = /const WEBHOOK_KIND_LABELS = \{([^}]*)\}/.exec(idx);
  assert.ok(m && /reception:/.test(m[1]) && /daily:/.test(m[1]));
});

// ===== 設定画面・練習用データ =====
t("設定画面: 6行（kind と項目名が functions と一致）", () => {
  for (const [kind, f] of Object.entries(W.WEBHOOK_FIELDS)) {
    const re = new RegExp(`kind:"${kind}"[^}]*url:"${f.url}"[^}]*en:"${f.enabled}"`);
    assert.ok(re.test(settingsJs), kind);
  }
  for (const [kind, to] of Object.entries(W.WEBHOOK_FALLBACK)) {
    assert.ok(new RegExp(`kind:"${kind}"[^}]*fallback:"${to}"`).test(settingsJs), `fallback ${kind}`);
  }
});
t("練習用データ: 新しい投稿先は写さない項目に入っている", () => {
  for (const k of ["receptionChatWebhookUrl", "receptionChatWebhookEnabled", "dailyChatWebhookUrl", "dailyChatWebhookEnabled"]) {
    assert.ok(seed.includes(`"${k}"`), k);
  }
  const P = require("../functions/practice-seed.js");
  if (typeof P.extractPracticeSettings === "function") {
    const out = P.extractPracticeSettings({ receptionChatWebhookUrl: RC, dailyChatWebhookUrl: DY });
    assert.equal(out.receptionChatWebhookUrl, undefined);
    assert.equal(out.dailyChatWebhookUrl, undefined);
  }
});

console.log(`test-webhook-route: ${n} 件 OK`);
