// admin/js/emu.js（ローカルのエミュレーター接続）が本番では動かないことのテスト。node scripts/test-emu-guard.mjs
// 条件: hostname が localhost/127.0.0.1 かつ http: かつ（?emu=1 か localStorage の印）。それ以外は何もしない
import assert from "node:assert/strict";
let n = 0, seq = 0;
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.firebaseConfig = { projectId: "kjk-tadakayo", authDomain: "kjk-tadakayo.firebaseapp.com" };
async function load(loc) {
  globalThis.location = loc;
  const m = await import(new URL(`../admin/js/emu.js?case=${++seq}`, import.meta.url));
  return m.EMULATED;
}
const cases = [
  [{ hostname: "kjk-tadakayo-admin.web.app", protocol: "https:", search: "?emu=1" }, "本番のホスト＋?emu=1"],
  [{ hostname: "kjk-tadakayo-admin.firebaseapp.com", protocol: "https:", search: "?emu=1" }, "firebaseapp.com"],
  [{ hostname: "localhost.evil.example", protocol: "http:", search: "?emu=1" }, "localhost で始まる別ホスト"],
  [{ hostname: "localhost", protocol: "https:", search: "?emu=1" }, "localhost でも https"],
  [{ hostname: "127.0.0.1", protocol: "http:", search: "" }, "印も ?emu=1 も無い"],
  [{ hostname: "127.0.0.1", protocol: "http:", search: "?emu=0" }, "?emu=0"],
];
for (const [loc, name] of cases) {
  assert.equal(await load(loc), false, name);
  n++;
}
// 本番のホストで localStorage に印があっても動かない
store.set("kjkEmu", "1");
assert.equal(await load({ hostname: "kjk-tadakayo-admin.web.app", protocol: "https:", search: "" }), false); n++;
assert.equal(firebaseConfig.projectId, "kjk-tadakayo", "本番の設定を書き換えていない"); n++;
// ?emu=0 で印を外す
await load({ hostname: "127.0.0.1", protocol: "http:", search: "?emu=0" });
assert.equal(store.has("kjkEmu"), false); n++;
console.log(`OK test-emu-guard: ${n} 件合格`);
