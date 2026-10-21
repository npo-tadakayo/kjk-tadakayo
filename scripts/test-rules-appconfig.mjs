// firestore.rules の appConfig / _notifyLog / users.chatUserId の権限テスト（2026-10-21）
//
// 何を確かめるか
//   ・appConfig（settings / simulator / supportTrainers）: staff・viewer は書けない／admin は書ける／登録済みは読める／未登録・未認証は読めない
//   ・_notifyLog: admin でも書けない（Functions だけ）／admin は読める／staff は読めない
//   ・users の chatUserId: staff は書けない／admin は書ける
//   ・承諾書の未認証署名（pending→signed）は従来どおり通る
//   ・bankTxns / bankConfig は editor が書けて viewer は書けない（catch-all のまま）
//
// 実行手順は test-rules-catchall.mjs 冒頭と同じ（作業用ディレクトリで npm i @firebase/rules-unit-testing firebase）
//   RULES_FILE=<repo>/firestore.rules firebase emulators:exec --only firestore --project demo-kjk "node test-rules-appconfig.mjs"
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, addDoc, collection, serverTimestamp } from "firebase/firestore";

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const env = await initializeTestEnvironment({
  projectId: "demo-kjk",
  firestore: { rules: readFileSync(process.env.RULES_FILE, "utf8"), host, port: Number(port) },
});

const ADMIN = "admin@tadakayo.jp", STAFF = "staff@tadakayo.jp", VIEWER = "viewer@tadakayo.jp", NOREG = "noreg@tadakayo.jp";
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "users", ADMIN), { role: "admin", active: true, name: "管理" });
  await setDoc(doc(db, "users", STAFF), { role: "staff", active: true, name: "職員" });
  await setDoc(doc(db, "users", VIEWER), { role: "viewer", active: true, name: "閲覧" });
  await setDoc(doc(db, "appConfig", "settings"), { a: 1 });
  await setDoc(doc(db, "appConfig", "simulator"), { a: 1 });
  await setDoc(doc(db, "appConfig", "supportTrainers"), { a: 1 });
  await setDoc(doc(db, "_notifyLog", "n1"), { a: 1 });
  await setDoc(doc(db, "consentRequests", "tok1"), { status: "pending", name: "x" });
  await setDoc(doc(db, "bankTxns", "t1"), { a: 1 });
  await setDoc(doc(db, "bankConfig", "preset"), { a: 1 });
});
const as = (email) => env.authenticatedContext(email.replace(/[@.]/g, "_"), { email, email_verified: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

let pass = 0, fail = 0;
async function t(label, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${label}`); }
  catch (e) { fail++; console.log(`  ❌ ${label} — ${e.message.split("\n")[0]}`); }
}
const yes = (p) => assertSucceeds(p), no = (p) => assertFails(p);
const DOCS = ["settings", "simulator", "supportTrainers"];

console.log("appConfig");
for (const d of DOCS) {
  await t(`staff は appConfig/${d} を書けない`, () => no(setDoc(doc(as(STAFF), "appConfig", d), { a: 2 })));
  await t(`viewer は appConfig/${d} を書けない`, () => no(setDoc(doc(as(VIEWER), "appConfig", d), { a: 2 })));
  await t(`admin は appConfig/${d} を書ける`, () => yes(setDoc(doc(as(ADMIN), "appConfig", d), { a: 3 })));
}
await t("staff は appConfig を新規作成できない", () => no(setDoc(doc(as(STAFF), "appConfig", "new"), { a: 1 })));
await t("staff は settings を読める", () => yes(getDoc(doc(as(STAFF), "appConfig", "settings"))));
await t("viewer は settings を読める", () => yes(getDoc(doc(as(VIEWER), "appConfig", "settings"))));
await t("未登録の @tadakayo.jp は settings を読めない", () => no(getDoc(doc(as(NOREG), "appConfig", "settings"))));
await t("未認証は settings を読めない", () => no(getDoc(doc(anon(), "appConfig", "settings"))));

console.log("_notifyLog");
await t("admin でも _notifyLog を書けない", () => no(setDoc(doc(as(ADMIN), "_notifyLog", "n2"), { a: 1 })));
await t("admin でも _notifyLog を更新できない", () => no(updateDoc(doc(as(ADMIN), "_notifyLog", "n1"), { a: 2 })));
await t("staff は _notifyLog を書けない", () => no(setDoc(doc(as(STAFF), "_notifyLog", "n3"), { a: 1 })));
await t("admin は _notifyLog を読める", () => yes(getDoc(doc(as(ADMIN), "_notifyLog", "n1"))));
await t("staff は _notifyLog を読めない", () => no(getDoc(doc(as(STAFF), "_notifyLog", "n1"))));
await t("viewer は _notifyLog を読めない", () => no(getDoc(doc(as(VIEWER), "_notifyLog", "n1"))));

console.log("users.chatUserId");
await t("staff は自分の chatUserId を書けない", () => no(updateDoc(doc(as(STAFF), "users", STAFF), { chatUserId: "12345678" })));
await t("staff は他人の chatUserId を書けない", () => no(updateDoc(doc(as(STAFF), "users", VIEWER), { chatUserId: "12345678" })));
await t("viewer は chatUserId を書けない", () => no(updateDoc(doc(as(VIEWER), "users", VIEWER), { chatUserId: "12345678" })));
await t("admin は chatUserId を書ける", () => yes(updateDoc(doc(as(ADMIN), "users", STAFF), { chatUserId: "12345678" })));

console.log("承諾書の未認証署名（従来どおり）");
await t("未認証で pending→signed（許された項目だけ）が通る", () => yes(updateDoc(doc(anon(), "consentRequests", "tok1"), {
  status: "signed",
  signed: { name: "山田", signedAt: serverTimestamp(), method: "web", userAgent: "test" },
})));
await t("署名済みは未認証で書き換えられない", () => no(updateDoc(doc(anon(), "consentRequests", "tok1"), {
  status: "signed",
  signed: { name: "別人", signedAt: serverTimestamp(), method: "web" },
})));

console.log("bankTxns / bankConfig（catch-all のまま）");
await t("staff は bankTxns を書ける", () => yes(addDoc(collection(as(STAFF), "bankTxns"), { a: 1 })));
await t("viewer は bankTxns を書けない", () => no(addDoc(collection(as(VIEWER), "bankTxns"), { a: 1 })));
await t("staff は bankConfig を書ける", () => yes(setDoc(doc(as(STAFF), "bankConfig", "preset"), { a: 2 })));
await t("viewer は bankConfig を書けない", () => no(setDoc(doc(as(VIEWER), "bankConfig", "preset"), { a: 2 })));
await t("viewer は bankTxns を読める", () => yes(getDoc(doc(as(VIEWER), "bankTxns", "t1"))));

await env.cleanup();
console.log(`合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
