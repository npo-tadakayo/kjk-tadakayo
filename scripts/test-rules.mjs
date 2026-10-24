// セキュリティルールのテスト（2026-10-20 テストモード・練習生ロールの追加に合わせて新設）
//
// 何を確かめるか
//   ・本番DB（(default)・firestore.rules）: 練習生（role=trainee）は自分の users 以外を読み書きできない。
//     staff / viewer / admin / ロール未設定の既存登録者 の権限は今までどおり。
//   ・練習DB（practice・firestore.practice.rules）: @tadakayo.jp（メール確認済み）なら読み書き可。
//     それ以外・未認証は不可。users は誰も読み書きできない。練習DBのルールが本番DBに効いていない。
//   ・Storage（storage.rules）: 練習生は職員向けファイルを読めない・書けない。training/（動画マニュアル）だけ読める。
//
// 実行手順（依存はリポジトリに入れない。本番には繋がらない demo- プロジェクトIDで動かす）
//   1. 作業用フォルダを作り、依存を入れる（リポジトリの外で）
//        mkdir -p <作業用>/rules-test && cd <作業用>/rules-test
//        npm init -y && npm i @firebase/rules-unit-testing firebase
//   2. このファイルを作業用フォルダへコピーする
//        cp <repo>/scripts/test-rules.mjs <作業用>/rules-test/
//   3. エミュレータを起動してテストを流す（Java が要る。Homebrew の openjdk なら PATH に足す）
//        export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
//        RULES_DIR=<repo> firebase emulators:exec --config <repo>/firebase.json \
//          --only firestore,storage --project demo-kjk "node test-rules.mjs"
//      ・RULES_DIR はルールファイルのあるフォルダ（リポジトリの最上位）。未指定ならこのファイルの1つ上。
//      ・firebase.json の firestore は2DBの配列なので、エミュレータは「複数DBは未対応」と警告して
//        firebase.json からはルールを読まない。テストの中で DB ごとにルールを読み込ませるので問題ない
//        （(default) は rules-unit-testing、practice はエミュレータの DB別エンドポイントへ PUT）。
//   終了コード: 全部合格なら 0、1件でも不合格なら 1。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  serverTimestamp,
} from "firebase/firestore";
import { ref, uploadString, getMetadata } from "firebase/storage";

const PROJECT_ID = "demo-kjk";
const RULES_DIR =
  process.env.RULES_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(RULES_DIR, f), "utf8");

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const [fsHost, fsPort] = FS_HOST.split(":");

// ---- 登場人物 ----
const ADMIN = "admin@tadakayo.jp";
const STAFF = "staff@tadakayo.jp";
const VIEWER = "viewer@tadakayo.jp";
const TRAINEE = "trainee@tadakayo.jp";
const LEGACY = "legacy@tadakayo.jp"; // role 未設定の既存登録者（今までどおり登録済み扱いのはず）
const UNREG = "unreg@tadakayo.jp"; // users に登録が無い @tadakayo.jp
const OUTSIDER = "someone@gmail.com";
const INACTIVE = "inactive@tadakayo.jp"; // users に登録はあるが active=false（育成コースの書き込みを拒否するはず）

// ---- 結果の集計 ----
const results = { 本番DB: [], 練習DB: [], Storage: [] };
async function check(group, label, expectOk, fn) {
  try {
    if (expectOk) await assertSucceeds(fn());
    else await assertFails(fn());
    results[group].push([true, label]);
  } catch (e) {
    results[group].push([false, `${label}  ←  ${String(e && e.message).split("\n")[0]}`]);
  }
}

const env = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: { rules: read("firestore.rules"), host: fsHost, port: Number(fsPort) },
  storage: { rules: read("storage.rules") },
});

// 練習DB（practice）にだけ practice ルールを読み込ませる。
// エミュレータは DB ごとのルールを /emulator/v1/projects/{p}/databases/{db}:securityRules で受け付ける
// （2026-10-20 手元の firebase-tools 15.13.0 で、DBごとに別のルールが効くことを確認済み）。
{
  const res = await fetch(
    `http://${FS_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/practice:securityRules`,
    {
      method: "PUT",
      body: JSON.stringify({
        rules: { files: [{ name: "firestore.practice.rules", content: read("firestore.practice.rules") }] },
      }),
    }
  );
  if (!res.ok) {
    console.error("練習DBのルールを読み込めませんでした:", res.status, await res.text());
    process.exit(1);
  }
}

// ---- 本番DB の初期データ（ルールを通さずに置く） ----
await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const users = {
    [ADMIN]: { role: "admin", active: true },
    [STAFF]: { role: "staff", active: true },
    [VIEWER]: { role: "viewer", active: true },
    [TRAINEE]: { role: "trainee", active: true },
    [LEGACY]: { active: true },
    [INACTIVE]: { role: "staff", active: false },
  };
  for (const [email, data] of Object.entries(users)) await setDoc(doc(db, "users", email), data);
  const seed = [
    ["cases", "c1"],
    ["shipments", "s1"],
    ["quotes", "q1"],
    ["offices", "o1"],
    ["appConfig", "main"],
    ["partners", "p1@example.com"],
    ["partnerOrders", "po1"],
    ["supportBadges", "b1"],
    ["supportEvaluations", "e1"],
    ["products", "sku1"],
    ["leadTokens", "lt1"],
  ];
  for (const [c, id] of seed) await setDoc(doc(db, c, id), { name: "seed", partnerEmail: "p1@example.com" });
  await setDoc(doc(db, "consentRequests", "tok1"), { status: "pending" });
  // 育成コースの進み具合（1人1文書・ID はメール）
  for (const email of [STAFF, VIEWER, TRAINEE]) await setDoc(doc(db, "learningProgress", email), { name: "seed", lastAt: 1 });
});

// 本番DB のクライアント（rules-unit-testing の認証付きコンテキスト）
const prod = (email, extra = {}) =>
  email
    ? env.authenticatedContext(email, { email, email_verified: true, ...extra }).firestore()
    : env.unauthenticatedContext().firestore();

// 練習DB のクライアント。rules-unit-testing は DB名を指定できないので、
// firebase SDK で getFirestore(app, "practice") を作り、エミュレータへ模擬トークンで繋ぐ。
const practiceApps = [];
let appSeq = 0;
function practice(email, { verified = true } = {}) {
  const app = initializeApp({ projectId: PROJECT_ID }, `practice-${appSeq++}`);
  practiceApps.push(app);
  const db = getFirestore(app, "practice");
  connectFirestoreEmulator(db, fsHost, Number(fsPort), email
    ? { mockUserToken: { sub: email, email, email_verified: verified } }
    : {});
  return db;
}

// =====================================================================
// 本番DB
// =====================================================================
const G = "本番DB";
const newCase = { name: "テスト", updatedAt: 1 };

// staff: 今までどおり読める・書ける
await check(G, "staff は cases を読める", true, () => getDoc(doc(prod(STAFF), "cases/c1")));
await check(G, "staff は cases を一覧できる", true, () => getDocs(collection(prod(STAFF), "cases")));
await check(G, "staff は cases に書ける", true, () => setDoc(doc(prod(STAFF), "cases/new-staff"), newCase));
await check(G, "staff は consentRequests を一覧できる（従来どおり）", true, () => getDocs(collection(prod(STAFF), "consentRequests")));
// 注: 末尾の match /{document=**} が users にも効くので、登録スタッフは他人の users も読める（従来どおり）
await check(G, "staff は他人の users を読める（従来どおり・末尾の {document=**} が効く）", true, () => getDoc(doc(prod(STAFF), "users", VIEWER)));

// viewer: 読めるが書けない（従来どおり）
await check(G, "viewer は cases を読める", true, () => getDoc(doc(prod(VIEWER), "cases/c1")));
await check(G, "viewer は cases に書けない", false, () => setDoc(doc(prod(VIEWER), "cases/new-viewer"), newCase));

// admin: 従来どおり
await check(G, "admin は cases に書ける", true, () => setDoc(doc(prod(ADMIN), "cases/new-admin"), newCase));
await check(G, "admin は他人の users を読める", true, () => getDoc(doc(prod(ADMIN), "users", TRAINEE)));
await check(G, "admin は users を書ける（ロール変更）", true, () => updateDoc(doc(prod(ADMIN), "users", TRAINEE), { role: "trainee" }));

// role 未設定の既存登録者: 従来どおり登録済み扱い
await check(G, "role 未設定の登録者は cases を読める（従来どおり）", true, () => getDoc(doc(prod(LEGACY), "cases/c1")));
// 注: isEditor() は userData().role を直接読むので、role 未設定だと評価エラー＝書けない（従来どおり。今回は変えない）
await check(G, "role 未設定の登録者は cases に書けない（従来どおり）", false, () => setDoc(doc(prod(LEGACY), "cases/new-legacy"), newCase));

// 練習生: 本番は読み書きとも不可
const denied = ["cases/c1", "shipments/s1", "quotes/q1", "offices/o1", "appConfig/main", "partners/p1@example.com",
  "partnerOrders/po1", "supportBadges/b1", "supportEvaluations/e1",
  // 2026-10-21 CRM改善で増えたコレクション（統合マージで追加）
  "bankTxns/t1", "bankConfig/presets", "_notifyLog/assign_x"];
for (const p of denied) {
  await check(G, `trainee は ${p} を読めない`, false, () => getDoc(doc(prod(TRAINEE), p)));
  await check(G, `trainee は ${p} に書けない`, false, () => setDoc(doc(prod(TRAINEE), p), { name: "x" }));
}
for (const c of ["cases", "shipments", "quotes", "offices", "appConfig", "partners"]) {
  await check(G, `trainee は ${c} を一覧できない`, false, () => getDocs(collection(prod(TRAINEE), c)));
}
await check(G, "trainee は cases を新規作成できない", false, () => setDoc(doc(prod(TRAINEE), "cases/new-trainee"), newCase));
await check(G, "trainee は consentRequests を一覧できない", false, () => getDocs(collection(prod(TRAINEE), "consentRequests")));
await check(G, "trainee は leadTokens を一覧できない", false, () => getDocs(collection(prod(TRAINEE), "leadTokens")));
await check(G, "trainee は自分の partners 登録を作れない", false, () => setDoc(doc(prod(TRAINEE), "partners", TRAINEE), { active: true }));
await check(G, "trainee は partnerOrders を作れない（パートナーでない）", false, () =>
  setDoc(doc(prod(TRAINEE), "partnerOrders/po-t"), { partnerEmail: TRAINEE }));

// 練習生: 自分の users だけは読める・onboardingDismissedAt だけ書ける（従来どおり）
await check(G, "trainee は自分の users を読める", true, () => getDoc(doc(prod(TRAINEE), "users", TRAINEE)));
await check(G, "trainee は他人の users を読めない", false, () => getDoc(doc(prod(TRAINEE), "users", STAFF)));
await check(G, "trainee は users を一覧できない", false, () => getDocs(collection(prod(TRAINEE), "users")));
await check(G, "trainee は自分の onboardingDismissedAt を書ける（従来どおり）", true, () =>
  updateDoc(doc(prod(TRAINEE), "users", TRAINEE), { onboardingDismissedAt: serverTimestamp() }));
await check(G, "trainee は自分の role を書き換えられない", false, () =>
  updateDoc(doc(prod(TRAINEE), "users", TRAINEE), { role: "staff" }));

// 未認証でも通る既存の例外はそのまま（練習生だからといって狭めない）
await check(G, "未認証でも consentRequests を get できる（従来どおり）", true, () => getDoc(doc(prod(null), "consentRequests/tok1")));
await check(G, "未認証でも leadTokens を get できる（従来どおり）", true, () => getDoc(doc(prod(null), "leadTokens/lt1")));
await check(G, "trainee も consentRequests を get できる（URLを知る人＝未認証と同じ）", true, () => getDoc(doc(prod(TRAINEE), "consentRequests/tok1")));
await check(G, "trainee も products を読める（認証済みなら誰でも＝従来どおり）", true, () => getDoc(doc(prod(TRAINEE), "products/sku1")));
await check(G, "trainee は products に書けない", false, () => setDoc(doc(prod(TRAINEE), "products/sku1"), { name: "x" }));

// 未登録・未認証
await check(G, "未登録の @tadakayo.jp は cases を読めない", false, () => getDoc(doc(prod(UNREG), "cases/c1")));
await check(G, "未登録の @tadakayo.jp は cases に書けない", false, () => setDoc(doc(prod(UNREG), "cases/x"), newCase));
await check(G, "未認証は cases を読めない", false, () => getDoc(doc(prod(null), "cases/c1")));
await check(G, "@tadakayo.jp 以外は cases を読めない", false, () => getDoc(doc(prod(OUTSIDER), "cases/c1")));

// ---- 育成コースの進み具合（learningProgress・2026-10-24） ----
const LP = (email) => ["learningProgress", email];
const lpData = { videos: { "L-A": { maxPos: 10, duration: 150, doneAt: null } }, lastAt: 2 };
await check(G, "staff は自分の learningProgress を読める", true, () => getDoc(doc(prod(STAFF), ...LP(STAFF))));
await check(G, "staff は自分の learningProgress を更新できる", true, () => setDoc(doc(prod(STAFF), ...LP(STAFF)), lpData, { merge: true }));
await check(G, "admin は自分の learningProgress を新しく作れる", true, () => setDoc(doc(prod(ADMIN), ...LP(ADMIN)), lpData));
await check(G, "viewer も自分の learningProgress は書ける（自分の学習の記録）", true, () => setDoc(doc(prod(VIEWER), ...LP(VIEWER)), lpData, { merge: true }));
await check(G, "staff は他人の learningProgress に書けない", false, () => setDoc(doc(prod(STAFF), ...LP(VIEWER)), lpData, { merge: true }));
await check(G, "staff は他人の learningProgress を新しく作れない", false, () => setDoc(doc(prod(STAFF), ...LP("nobody@tadakayo.jp")), lpData));
await check(G, "staff は他人の learningProgress を読める（トレーナーの一覧）", true, () => getDoc(doc(prod(STAFF), ...LP(TRAINEE))));
await check(G, "staff は learningProgress を一覧できる", true, () => getDocs(collection(prod(STAFF), "learningProgress")));
await check(G, "trainee は自分の learningProgress を読める", true, () => getDoc(doc(prod(TRAINEE), ...LP(TRAINEE))));
await check(G, "trainee は自分の learningProgress を更新できる", true, () => setDoc(doc(prod(TRAINEE), ...LP(TRAINEE)), lpData, { merge: true }));
await check(G, "trainee は他人の learningProgress を読めない", false, () => getDoc(doc(prod(TRAINEE), ...LP(STAFF))));
await check(G, "trainee は他人の learningProgress に書けない", false, () => setDoc(doc(prod(TRAINEE), ...LP(STAFF)), lpData, { merge: true }));
await check(G, "trainee は learningProgress を一覧できない", false, () => getDocs(collection(prod(TRAINEE), "learningProgress")));
await check(G, "trainee も自分の learningProgress は消せない", false, () => deleteDoc(doc(prod(TRAINEE), ...LP(TRAINEE))));
await check(G, "staff も自分の learningProgress は消せない", false, () => deleteDoc(doc(prod(STAFF), ...LP(STAFF))));
await check(G, "admin は他人の learningProgress を消せる", true, () => deleteDoc(doc(prod(ADMIN), ...LP(VIEWER))));
await check(G, "未登録の @tadakayo.jp は自分の learningProgress を作れない", false, () => setDoc(doc(prod(UNREG), ...LP(UNREG)), lpData));
await check(G, "未登録の @tadakayo.jp は他人の learningProgress を読めない", false, () => getDoc(doc(prod(UNREG), ...LP(STAFF))));
await check(G, "無効（active=false）の登録者は自分の learningProgress を作れない", false, () => setDoc(doc(prod(INACTIVE), ...LP(INACTIVE)), lpData));
await check(G, "@tadakayo.jp 以外は自分のメールの learningProgress も作れない", false, () => setDoc(doc(prod(OUTSIDER), ...LP(OUTSIDER)), lpData));
await check(G, "未認証は learningProgress を読めない", false, () => getDoc(doc(prod(null), ...LP(STAFF))));

// =====================================================================
// 練習DB
// =====================================================================
const P = "練習DB";
for (const [who, email] of [["staff", STAFF], ["viewer", VIEWER], ["trainee", TRAINEE], ["未登録の @tadakayo.jp", UNREG]]) {
  await check(P, `${who} は練習DBの cases に書ける`, true, () => setDoc(doc(practice(email), "cases", `p-${who}`), newCase));
  await check(P, `${who} は練習DBの cases を読める`, true, () => getDoc(doc(practice(email), "cases", `p-${who}`)));
}
await check(P, "trainee は練習DBの cases を一覧できる", true, () => getDocs(collection(practice(TRAINEE), "cases")));
await check(P, "trainee は練習DBの shipments/quotes に書ける", true, async () => {
  const db = practice(TRAINEE);
  await setDoc(doc(db, "shipments/ps1"), { name: "x" });
  return setDoc(doc(db, "quotes/pq1"), { name: "x" });
});
await check(P, "trainee は練習DBのサブコレクションにも書ける", true, () => setDoc(doc(practice(TRAINEE), "cases/p-trainee/activities/a1"), { memo: "x" }));
await check(P, "メール未確認の @tadakayo.jp は読めない", false, () => getDoc(doc(practice(STAFF, { verified: false }), "cases/p-staff")));
await check(P, "メール未確認の @tadakayo.jp は書けない", false, () => setDoc(doc(practice(STAFF, { verified: false }), "cases/x"), newCase));
await check(P, "@tadakayo.jp 以外は読めない", false, () => getDoc(doc(practice(OUTSIDER), "cases/p-staff")));
await check(P, "@tadakayo.jp 以外は書けない", false, () => setDoc(doc(practice(OUTSIDER), "cases/x"), newCase));
await check(P, "未認証は読めない", false, () => getDoc(doc(practice(null), "cases/p-staff")));
await check(P, "未認証は書けない", false, () => setDoc(doc(practice(null), "cases/x"), newCase));
await check(P, "users は staff でも読めない", false, () => getDoc(doc(practice(STAFF), "users", STAFF)));
await check(P, "users は staff でも書けない", false, () => setDoc(doc(practice(STAFF), "users", STAFF), { role: "admin", active: true }));
await check(P, "users は trainee でも書けない", false, () => setDoc(doc(practice(TRAINEE), "users", TRAINEE), { role: "admin", active: true }));
await check(P, "users を一覧できない", false, () => getDocs(collection(practice(STAFF), "users")));
await check(P, "users の下のサブコレクションにも書けない", false, () => setDoc(doc(practice(STAFF), "users", STAFF, "x", "y"), { a: 1 }));
// 2026-10-21 統合マージ: CRM改善の新しいコレクションも練習DBで使える（入金明細の取り込み・設定）。_notifyLog だけは閉じる
await check(P, "trainee は練習DBの bankTxns に書ける", true, () => setDoc(doc(practice(TRAINEE), "bankTxns/h1"), { amount: 1000 }));
await check(P, "trainee は練習DBの bankConfig に書ける", true, () => setDoc(doc(practice(TRAINEE), "bankConfig/presets"), { a: 1 }));
await check(P, "staff は練習DBの appConfig を読める", true, () => getDoc(doc(practice(STAFF), "appConfig/settings")));
await check(P, "練習DBの _notifyLog は staff でも読めない", false, () => getDoc(doc(practice(STAFF), "_notifyLog/x")));
await check(P, "練習DBの _notifyLog は staff でも書けない", false, () => setDoc(doc(practice(STAFF), "_notifyLog/x"), { a: 1 }));
await check(P, "練習DBの _notifyLog を一覧できない", false, () => getDocs(collection(practice(STAFF), "_notifyLog")));

// 練習DBのルールが本番DBに効いていない（同じエミュレータ・同じプロジェクトで、本番DBでは拒否される）
await check(P, "【分離】本番DBでは trainee は cases を読めない", false, () => getDoc(doc(prod(TRAINEE), "cases/c1")));
await check(P, "【分離】本番DBでは trainee は cases に書けない", false, () => setDoc(doc(prod(TRAINEE), "cases/p-leak"), newCase));
await check(P, "【分離】本番DBでは未登録の @tadakayo.jp は読めない", false, () => getDoc(doc(prod(UNREG), "cases/c1")));
await check(P, "【分離】練習DBで書いた cases/p-trainee は本番DBに無い", true, async () => {
  let snap;
  await env.withSecurityRulesDisabled(async (ctx) => { snap = await getDoc(doc(ctx.firestore(), "cases/p-trainee")); });
  if (snap.exists()) throw new Error("本番DBに練習の書き込みが入っている");
});
await check(P, "【分離】本番DBの cases/c1 は練習DBに無い", true, async () => {
  const snap = await getDoc(doc(practice(STAFF), "cases/c1"));
  if (snap.exists()) throw new Error("練習DBに本番のデータが見えている");
});

// =====================================================================
// Storage
// =====================================================================
const S = "Storage";
const files = {
  photo: "sessions/sess1/photos/p1.jpg",
  report: "reports/r1.pdf",
  document: "documents/c1/f1.pdf",
  invoice: "invoices/s1/inv.pdf",
  quote: "quotes/c1/q1.pdf",
  tracking: "shipments/s1/tracking/t1.jpg",
  training: "training/manual.mp4",
};
await env.clearStorage();
await env.withSecurityRulesDisabled(async (ctx) => {
  for (const p of Object.values(files)) await uploadString(ref(ctx.storage(), p), "seed");
});
const st = (email) =>
  email ? env.authenticatedContext(email, { email, email_verified: true }).storage() : env.unauthenticatedContext().storage();
const img = { contentType: "image/jpeg" };

for (const [k, p] of Object.entries(files)) {
  if (k === "training") continue;
  await check(S, `trainee は ${p} を読めない`, false, () => getMetadata(ref(st(TRAINEE), p)));
}
await check(S, "trainee は training/（動画マニュアル）を読める", true, () => getMetadata(ref(st(TRAINEE), files.training)));
await check(S, "trainee は訪問写真を置けない", false, () => uploadString(ref(st(TRAINEE), "sessions/sess1/photos/t.jpg"), "x", "raw", img));
await check(S, "trainee は報告書を置けない", false, () => uploadString(ref(st(TRAINEE), "reports/t.pdf"), "x"));
await check(S, "trainee は書類を置けない", false, () => uploadString(ref(st(TRAINEE), "documents/c1/t.pdf"), "x"));
await check(S, "trainee は追跡番号の写真を置けない", false, () => uploadString(ref(st(TRAINEE), "shipments/s1/tracking/t.jpg"), "x", "raw", img));

for (const [k, p] of Object.entries(files)) {
  await check(S, `staff は ${p} を読める（従来どおり）`, true, () => getMetadata(ref(st(STAFF), p)));
}
await check(S, "viewer は請求書PDFを読める（従来どおり）", true, () => getMetadata(ref(st(VIEWER), files.invoice)));
await check(S, "users の無い @tadakayo.jp も訪問写真を読める（従来どおり）", true, () => getMetadata(ref(st(UNREG), files.photo)));
await check(S, "users の無い @tadakayo.jp も見積PDFを読める（従来どおり）", true, () => getMetadata(ref(st(UNREG), files.quote)));
await check(S, "staff は訪問写真を置ける（従来どおり）", true, () => uploadString(ref(st(STAFF), "sessions/sess1/photos/s.jpg"), "x", "raw", img));
await check(S, "staff は追跡番号の写真を置ける（従来どおり）", true, () => uploadString(ref(st(STAFF), "shipments/s1/tracking/s.jpg"), "x", "raw", img));
await check(S, "viewer は追跡番号の写真を置けない（従来どおり）", false, () => uploadString(ref(st(VIEWER), "shipments/s1/tracking/v.jpg"), "x", "raw", img));
await check(S, "staff も請求書PDFは置けない（従来どおり）", false, () => uploadString(ref(st(STAFF), "invoices/s1/x.pdf"), "x"));
await check(S, "staff も training/ には置けない（従来どおり）", false, () => uploadString(ref(st(STAFF), "training/x.mp4"), "x"));
await check(S, "@tadakayo.jp 以外は訪問写真を読めない", false, () => getMetadata(ref(st(OUTSIDER), files.photo)));
await check(S, "@tadakayo.jp 以外は training/ を読めない", false, () => getMetadata(ref(st(OUTSIDER), files.training)));
await check(S, "未認証は請求書PDFを読めない", false, () => getMetadata(ref(st(null), files.invoice)));

// ---- 後始末と結果 ----
for (const app of practiceApps) await deleteApp(app);
await env.cleanup();

let failed = 0;
for (const [group, list] of Object.entries(results)) {
  const ok = list.filter(([p]) => p).length;
  console.log(`\n## ${group}: ${ok}/${list.length} 合格`);
  for (const [p, label] of list) {
    console.log(`${p ? "  ✅" : "  ❌"} ${label}`);
    if (!p) failed++;
  }
}
const total = Object.values(results).reduce((n, l) => n + l.length, 0);
console.log(`\n合計: ${total - failed}/${total} 合格`);
process.exit(failed ? 1 : 0);
