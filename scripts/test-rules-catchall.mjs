// firestore.rules の「その他すべて」（catch-all）が、個別の制限を素通りさせていないかのテスト（2026-10-20）
//
// 何を確かめるか
//   ・登録スタッフは users を書けない（他人も自分も・role の書き換えも）。管理者は書ける。本人は onboarding だけ
//   ・leadTokens は誰も書けない（Functions だけ）。get は従来どおり誰でも
//   ・supportBadges は追加だけ（訂正・削除は管理者）。supportEvaluations は削除が管理者だけ
//   ・それ以外の業務データ（案件・出荷・商品・認定事業者・発注の取り込み・見積・承諾書）は従来どおり書ける
//   ・閲覧のみ（viewer）・未登録は従来どおり
//
// 実行手順（依存はリポジトリに入れない。本番に繋がらない demo- プロジェクトIDで動かす）
//   mkdir -p <作業用>/rules-test && cd <作業用>/rules-test && npm init -y && npm i @firebase/rules-unit-testing firebase
//   cp <repo>/scripts/test-rules-catchall.mjs <作業用>/rules-test/
//   export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
//   RULES_FILE=<repo>/firestore.rules firebase emulators:exec --only firestore --project demo-kjk "node test-rules-catchall.mjs"
//   （RULES_FILE を変更前のルールにすると、変わった項目だけが落ちることを比べられる）
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, serverTimestamp } from "firebase/firestore";

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
const env = await initializeTestEnvironment({
  projectId: "demo-kjk",
  firestore: { rules: readFileSync(process.env.RULES_FILE, "utf8"), host, port: Number(port) },
});

const ADMIN = "admin@tadakayo.jp", STAFF = "staff@tadakayo.jp", VIEWER = "viewer@tadakayo.jp", OTHER = "other@tadakayo.jp";
const NOREG = "noreg@tadakayo.jp", PARTNER = "partner@example.jp";
const WH = "wh@tadakayo.jp"; // 2026-10-24 倉庫（role=warehouse）
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "users", ADMIN), { role: "admin", active: true, name: "管理" });
  await setDoc(doc(db, "users", STAFF), { role: "staff", active: true, name: "職員" });
  await setDoc(doc(db, "users", VIEWER), { role: "viewer", active: true, name: "閲覧" });
  await setDoc(doc(db, "users", OTHER), { role: "staff", active: true, name: "ほか" });
  await setDoc(doc(db, "users", WH), { role: "warehouse", active: true, name: "倉庫", locationIds: ["L1"] });
  await setDoc(doc(db, "partners", PARTNER), { active: true });
  await setDoc(doc(db, "leadTokens", "tok1"), { a: 1 });
  await setDoc(doc(db, "supportBadges", "b1"), { a: 1 });
  await setDoc(doc(db, "supportEvaluations", "e1"), { a: 1 });
  await setDoc(doc(db, "cases", "c1"), { status: 1 });
});
const as = (email) => env.authenticatedContext(email.replace(/[@.]/g, "_"), { email, email_verified: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

let pass = 0, fail = 0;
async function t(label, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${label}`); }
  catch (e) { fail++; console.log(`  ❌ ${label} — ${e.message.split("\n")[0]}`); }
}
const yes = (p) => assertSucceeds(p), no = (p) => assertFails(p);

console.log("users（ユーザー登録）");
await t("staff は自分の role を admin に書き換えられない", () => no(updateDoc(doc(as(STAFF), "users", STAFF), { role: "admin" })));
await t("staff は他人の users を書けない", () => no(updateDoc(doc(as(STAFF), "users", OTHER), { active: false })));
await t("staff は users を新しく作れない", () => no(setDoc(doc(as(STAFF), "users", "new@tadakayo.jp"), { role: "admin", active: true })));
await t("staff は他人の users を消せない", () => no(deleteDoc(doc(as(STAFF), "users", OTHER))));
await t("staff は自分の onboardingDismissedAt は書ける（従来どおり）", () => yes(updateDoc(doc(as(STAFF), "users", STAFF), { onboardingDismissedAt: serverTimestamp() })));
await t("admin は users を作れる・書き換えられる・消せる", async () => {
  const db = as(ADMIN);
  await yes(setDoc(doc(db, "users", "new2@tadakayo.jp"), { role: "staff", active: true }, { merge: true }));
  await yes(updateDoc(doc(db, "users", "new2@tadakayo.jp"), { role: "viewer" }));
  await yes(deleteDoc(doc(db, "users", "new2@tadakayo.jp")));
});
await t("staff は users を読める（従来どおり・担当営業の候補）", () => yes(getDocs(collection(as(STAFF), "users"))));
await t("viewer は users を書けない（従来どおり）", () => no(updateDoc(doc(as(VIEWER), "users", VIEWER), { role: "admin" })));

console.log("leadTokens");
await t("staff は leadTokens を書けない（Functions だけ）", () => no(setDoc(doc(as(STAFF), "leadTokens", "tok2"), { a: 1 })));
await t("staff は leadTokens を書き換えられない", () => no(updateDoc(doc(as(STAFF), "leadTokens", "tok1"), { a: 2 })));
await t("未認証でも leadTokens を get できる（従来どおり）", () => yes(getDoc(doc(anon(), "leadTokens", "tok1"))));

console.log("supportBadges / supportEvaluations");
await t("staff はバッジを追加できる（従来どおり）", () => yes(addDoc(collection(as(STAFF), "supportBadges"), { a: 1 })));
await t("staff はバッジを訂正できない", () => no(updateDoc(doc(as(STAFF), "supportBadges", "b1"), { a: 2 })));
await t("staff はバッジを消せない", () => no(deleteDoc(doc(as(STAFF), "supportBadges", "b1"))));
await t("admin はバッジを訂正・削除できる", async () => { await yes(updateDoc(doc(as(ADMIN), "supportBadges", "b1"), { a: 3 })); await yes(deleteDoc(doc(as(ADMIN), "supportBadges", "b1"))); });
await t("staff は評価を作成・上書きできる（従来どおり）", async () => { await yes(setDoc(doc(as(STAFF), "supportEvaluations", "e2"), { a: 1 })); await yes(setDoc(doc(as(STAFF), "supportEvaluations", "e1"), { a: 2 })); });
await t("staff は評価を消せない", () => no(deleteDoc(doc(as(STAFF), "supportEvaluations", "e1"))));
await t("admin は評価を消せる", () => yes(deleteDoc(doc(as(ADMIN), "supportEvaluations", "e1"))));

console.log("それ以外の業務データ（従来どおり）");
await t("staff は案件を書ける", () => yes(updateDoc(doc(as(STAFF), "cases", "c1"), { status: 2 })));
await t("staff は案件の下のサブコレクションも書ける", () => yes(setDoc(doc(as(STAFF), "cases", "c1", "notes", "n1"), { a: 1 })));
await t("staff は出荷・商品・認定事業者・見積・承諾書を書ける", async () => {
  const db = as(STAFF);
  await yes(setDoc(doc(db, "shipments", "s1"), { a: 1 }));
  await yes(setDoc(doc(db, "products", "p1"), { a: 1 }));
  await yes(setDoc(doc(db, "partners", "x@example.jp"), { active: true }));
  await yes(setDoc(doc(db, "quotes", "q1"), { a: 1 }));
  await yes(setDoc(doc(db, "consentRequests", "r1"), { status: "pending" }));
});
await t("staff は認定事業者の発注を取り込める（partnerOrders の作成）", () => yes(addDoc(collection(as(STAFF), "partnerOrders"), { partnerEmail: PARTNER })));
await t("認定事業者は自分の発注を作れる（従来どおり）", () => yes(addDoc(collection(as(PARTNER), "partnerOrders"), { partnerEmail: PARTNER })));
await t("viewer は案件を読めるが書けない", async () => { await yes(getDoc(doc(as(VIEWER), "cases", "c1"))); await no(updateDoc(doc(as(VIEWER), "cases", "c1"), { status: 3 })); });
await t("未登録の @tadakayo.jp は案件を読めない", () => no(getDoc(doc(as(NOREG), "cases", "c1"))));
await t("未認証は案件を読めない", () => no(getDoc(doc(anon(), "cases", "c1"))));

console.log("倉庫（role=warehouse・2026-10-24）: catch-all でも書けない・読めない");
await t("warehouse は案件を読めない・書けない", async () => { await no(getDoc(doc(as(WH), "cases", "c1"))); await no(updateDoc(doc(as(WH), "cases", "c1"), { status: 3 })); });
await t("warehouse は出荷・商品・在庫の動き・保管場所に書けない", async () => {
  const db = as(WH);
  await no(setDoc(doc(db, "shipments", "s1"), { status: "shipped" }));
  await no(setDoc(doc(db, "products", "p1"), { stock: 999 }));
  await no(addDoc(collection(db, "inventoryMovements"), { delta: -1 }));
  await no(setDoc(doc(db, "locations", "L1"), { name: "x" }));
});
await t("warehouse は自分の role・locationIds を書き換えられない", () => no(updateDoc(doc(as(WH), "users", WH), { role: "admin", locationIds: ["L1", "L2"] })));
await t("warehouse は users を一覧できない", () => no(getDocs(collection(as(WH), "users"))));
await t("warehouse は自分の users を読める", () => yes(getDoc(doc(as(WH), "users", WH))));
await t("staff は倉庫の人の users を読める（従来どおり）", () => yes(getDoc(doc(as(STAFF), "users", WH))));

await env.cleanup();
console.log(`合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
