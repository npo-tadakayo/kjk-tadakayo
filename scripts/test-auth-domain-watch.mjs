// 毎朝の承認済みドメイン点検（functions/auth-domain-watch.js）のテスト。node scripts/test-auth-domain-watch.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { REQUIRED_DOMAINS as CORE } from "./lib/auth-domains-core.mjs";
const W = createRequire(import.meta.url)("../functions/auth-domain-watch.js");

let n = 0;
const t = (c, m) => { assert.ok(c, m); n++; };
const cfg = (list) => ({ name: "projects/677262660109/config", authorizedDomains: list });

t(JSON.stringify([...W.REQUIRED_DOMAINS]) === JSON.stringify([...CORE]), "必須4件が scripts/lib と一致");
t(W.alertText({ list: [...CORE, "x.web.app"] }) === null, "正常なら知らせない");
{
  const s = W.alertText({ list: ["kjk-tadakayo-admin--x.web.app"] });
  t(s && s.includes("4 件抜けて"), "事故の状態は4件欠けと知らせる");
  t(s.includes("kjk-tadakayo-admin.web.app"), "抜けたアドレスを書く");
  t(s.includes("新しくログインする人"), "誰が困るかを書く");
  t(s.includes("auth-domains.mjs"), "直し方を書く");
}
t(W.alertText({ list: [] }).includes("4 件"), "空でも知らせる");
t(W.alertText({ error: "HTTP 403 forbidden" }).includes("点検できませんでした"), "読めないときも知らせる");
t(W.domainsFromConfig(cfg(["a"])).length === 1, "config から一覧");
t(W.domainsFromConfig({ name: "projects/p/config" }).length === 0, "authorizedDomains 無し＝空");
assert.throws(() => W.domainsFromConfig({ error: {} })); n++;
assert.throws(() => W.domainsFromConfig(null)); n++;

const idx = fs.readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const m = /exports\.dailyAuthDomainCheck = onSchedule\(\s*\{([^}]*)\}/.exec(idx);
t(m, "関数が定義されている");
t(m[1].includes('"0 8 * * *"') && m[1].includes("Asia/Tokyo") && m[1].includes("SA_BATCH"), "毎朝8時JST・fn-batch-sa");
{
  const body = idx.slice(idx.indexOf("exports.dailyAuthDomainCheck"), idx.indexOf("\n);\n", idx.indexOf("exports.dailyAuthDomainCheck")));
  const req = /client\.request\(([\s\S]*?)\);/.exec(body);
  t(req && req[1].includes("identitytoolkit") && !/method/.test(req[1]), "config は GET（method 指定なし）で読むだけ");
  t((body.match(/client\.request\(/g) || []).length === 1, "Google API への呼び出しは1回だけ");
  t(!/PATCH|PUT|DELETE|updateMask|setIamPolicy/i.test(body), "書き込み系の語が無い");
  t(/if \(!res\.ok\) throw/.test(body), "Chat に届かなければエラーにする");
}

console.log(`PASS test-auth-domain-watch: ${n} 件`);
