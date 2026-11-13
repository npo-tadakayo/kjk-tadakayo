// firestore.rules の「その他すべて」（catch-all）が、個別の制限を素通りさせていないかのテスト（2026-10-20）
//
// 何を確かめるか
//   ・登録スタッフは users を書けない（他人も自分も・role の書き換えも）。管理者は書ける。本人は onboarding だけ
//   ・leadTokens は誰も書けない（Functions だけ）。get は従来どおり誰でも
//   ・supportBadges は追加だけ（訂正・削除は管理者）。supportEvaluations は削除が管理者だけ
//   ・2026-11-13: バッジの追加・評価の作成と上書きは、トレーナー名簿の人だけ（名簿の文書が無いあいだは初期4名を氏名で照合）。
//     バッジの付与者（grantedById）は自分のメールだけ
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
// 2026-11-13 トレーナー: 初期4名（氏名で照合・全角空白入り）・名簿の文書で入る人・初期4名と同じ氏名の閲覧のみ・無効
const TR_INIT = "hachisuka@tadakayo.jp", TR_NEW = "trnew@tadakayo.jp", TR_VIEW = "trview@tadakayo.jp", TR_OFF = "troff@tadakayo.jp";
const TR_HALF = "fujita@tadakayo.jp", TR_NBSP = "ishida2@tadakayo.jp"; // 半角空白・NBSP 入りの氏名（レビュー低1・低3）
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "users", ADMIN), { role: "admin", active: true, name: "管理" });
  await setDoc(doc(db, "users", STAFF), { role: "staff", active: true, name: "職員" });
  await setDoc(doc(db, "users", VIEWER), { role: "viewer", active: true, name: "閲覧" });
  await setDoc(doc(db, "users", OTHER), { role: "staff", active: true, name: "ほか" });
  await setDoc(doc(db, "users", WH), { role: "warehouse", active: true, name: "倉庫", locationIds: ["L1"] });
  await setDoc(doc(db, "users", TR_INIT), { role: "staff", active: true, name: "蜂須賀　大策" });
  await setDoc(doc(db, "users", TR_NEW), { role: "staff", active: true, name: "新トレーナー" });
  await setDoc(doc(db, "users", TR_VIEW), { role: "viewer", active: true, name: "藤田 博之" });
  await setDoc(doc(db, "users", TR_OFF), { role: "staff", active: false, name: "石田祐樹" });
  await setDoc(doc(db, "users", TR_HALF), { role: "staff", active: true, name: "藤田 博之" });
  await setDoc(doc(db, "users", TR_NBSP), { role: "staff", active: true, name: "次田\u00a0芳尚" });
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

console.log("supportBadges / supportEvaluations（名簿の文書なし＝初期4名を氏名で照合）");
const badge = (by) => ({ userId: "x@tadakayo.jp", grantedById: by, basis: "discretion", reason: "テスト" });
await t("初期トレーナー（氏名・全角空白入り）はバッジを追加できる", () => yes(addDoc(collection(as(TR_INIT), "supportBadges"), badge(TR_INIT))));
await t("半角空白入りの氏名（藤田 博之）の初期トレーナーはバッジを追加・評価を保存できる", async () => { await yes(addDoc(collection(as(TR_HALF), "supportBadges"), badge(TR_HALF))); await yes(setDoc(doc(as(TR_HALF), "supportEvaluations", "e6"), { a: 1 })); });
await t("NBSP 入りの氏名の初期トレーナーも通る（画面の \\s と同じ）", () => yes(addDoc(collection(as(TR_NBSP), "supportBadges"), badge(TR_NBSP))));
await t("初期トレーナーでも、付与者を他人にしたバッジは追加できない", () => no(addDoc(collection(as(TR_INIT), "supportBadges"), badge(STAFF))));
await t("初期トレーナーでも、付与者の欄が無いバッジは追加できない", () => no(addDoc(collection(as(TR_INIT), "supportBadges"), { userId: "x@tadakayo.jp" })));
await t("トレーナーでない staff はバッジを追加できない（2026-11-13〜）", () => no(addDoc(collection(as(STAFF), "supportBadges"), badge(STAFF))));
await t("管理者でもトレーナーでなければバッジを追加できない（画面と同じ）", () => no(addDoc(collection(as(ADMIN), "supportBadges"), badge(ADMIN))));
await t("初期4名と同じ氏名でも閲覧のみはバッジを追加できない", () => no(addDoc(collection(as(TR_VIEW), "supportBadges"), badge(TR_VIEW))));
await t("初期4名と同じ氏名でも無効の人はバッジを追加できない", () => no(addDoc(collection(as(TR_OFF), "supportBadges"), badge(TR_OFF))));
await t("staff はバッジを訂正できない", () => no(updateDoc(doc(as(STAFF), "supportBadges", "b1"), { a: 2 })));
await t("トレーナーもバッジを訂正できない", () => no(updateDoc(doc(as(TR_INIT), "supportBadges", "b1"), { a: 2 })));
await t("staff はバッジを消せない", () => no(deleteDoc(doc(as(STAFF), "supportBadges", "b1"))));
await t("admin はバッジを訂正・削除できる", async () => { await yes(updateDoc(doc(as(ADMIN), "supportBadges", "b1"), { a: 3 })); await yes(deleteDoc(doc(as(ADMIN), "supportBadges", "b1"))); });
await t("初期トレーナーは評価を作成・上書きできる", async () => { await yes(setDoc(doc(as(TR_INIT), "supportEvaluations", "e2"), { a: 1 })); await yes(setDoc(doc(as(TR_INIT), "supportEvaluations", "e1"), { a: 2 })); });
await t("トレーナーでない staff は評価を作成・上書きできない（2026-11-13〜）", async () => { await no(setDoc(doc(as(STAFF), "supportEvaluations", "e3"), { a: 1 })); await no(setDoc(doc(as(STAFF), "supportEvaluations", "e1"), { a: 9 })); });
await t("staff は評価を読める（従来どおり）", () => yes(getDoc(doc(as(STAFF), "supportEvaluations", "e1"))));
await t("staff はバッジを読める（従来どおり）", () => yes(getDocs(collection(as(STAFF), "supportBadges"))));
await t("staff は評価を消せない", () => no(deleteDoc(doc(as(STAFF), "supportEvaluations", "e1"))));
await t("トレーナーも評価を消せない", () => no(deleteDoc(doc(as(TR_INIT), "supportEvaluations", "e1"))));

console.log("supportBadges / supportEvaluations（名簿の文書あり）");
await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "appConfig", "supportTrainers"), { ids: [TR_NEW, "Mixed@tadakayo.jp".toLowerCase(), "gone@tadakayo.jp"] }));
await t("名簿の人はバッジを追加できる", () => yes(addDoc(collection(as(TR_NEW), "supportBadges"), badge(TR_NEW))));
await t("名簿の人は評価を作成・上書きできる", async () => { await yes(setDoc(doc(as(TR_NEW), "supportEvaluations", "e4"), { a: 1 })); await yes(setDoc(doc(as(TR_NEW), "supportEvaluations", "e2"), { a: 2 })); });
await t("名簿から外れた初期トレーナーはバッジを追加できない（名簿の文書が優先）", () => no(addDoc(collection(as(TR_INIT), "supportBadges"), badge(TR_INIT))));
await t("名簿から外れた初期トレーナーは評価を書けない", () => no(setDoc(doc(as(TR_INIT), "supportEvaluations", "e2"), { a: 3 })));
await t("名簿にいても利用者一覧にいない人は書けない", () => no(addDoc(collection(as("gone@tadakayo.jp"), "supportBadges"), badge("gone@tadakayo.jp"))));
await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users", "Mixed@tadakayo.jp"), { role: "staff", active: true, name: "大小" }));
await t("メールの大文字小文字が違っても名簿の人は評価を書ける", () => yes(setDoc(doc(as("Mixed@tadakayo.jp"), "supportEvaluations", "e5"), { a: 1 })));
await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "users", TR_NEW), { role: "staff", active: false, name: "新トレーナー" }));
await t("名簿にいても無効にした人は書けない", () => no(addDoc(collection(as(TR_NEW), "supportBadges"), badge(TR_NEW))));
await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "appConfig", "supportTrainers"), { ids: [] }));
await t("名簿の文書が空なら初期4名の照合に戻る（画面と同じ）", () => yes(addDoc(collection(as(TR_INIT), "supportBadges"), badge(TR_INIT))));
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
