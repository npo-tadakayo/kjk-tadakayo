// functions/practice.js — 学習用テストモードの「練習DB（practice）」の初期化
// 設計: docs/テストモード設計_20261020.md §3.3・§6
//
//   resetPractice        … 管理者が「今すぐ初期化」で呼ぶ（callable）
//   nightlyPracticeReset … 毎日 3:00 JST の自動初期化
//
// 🔴 本番DB（既定DB）には「読み取りしかしない」。書き込み・削除は practiceDb にだけ行う。
//    （scripts/test-practice-seed.mjs が、このファイルに本番DBへの書き込みが無いことを文字列で検査する）
// 🔴 練習DBに外部送信先（Chat の Webhook・メール宛先）と印影は写さない。写す項目は practice-seed.js の許可リストで決める。

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { buildPracticeSeed, extractPracticeSettings, sanitizeLocation, sanitizeProduct } = require("./practice-seed");

const REGION = "asia-northeast1";
const PRACTICE_DB_ID = "practice";
// index.js の他の関数と同じ専用SA（datastore.user を持つ。Firestore の権限はプロジェクト単位でDBを区別しない）
const SA_BATCH = "fn-batch-sa@kjk-tadakayo.iam.gserviceaccount.com";

// Firestore の1バッチは500件まで
const BATCH_LIMIT = 500;

// 練習DB（practice）と本番DB（既定）を返す。firebase-admin は index.js が initializeApp 済み
function openDatabases() {
  const { getFirestore } = require("firebase-admin/firestore");
  return { practiceDb: getFirestore(PRACTICE_DB_ID), prodDb: getFirestore() };
}

// 渡された Firestore が練習DBであることを確かめる（取り違えで本番を消さないための最後の砦）。
// DB名が読み取れない実装（テスト用の代役など）のときは確認を省く。
function assertPracticeDb(practiceDb, prodDb) {
  if (!practiceDb || practiceDb === prodDb) throw new Error("練習DBと本番DBが同じです。初期化を中止します");
  const id = practiceDb.databaseId || (practiceDb._databaseId && practiceDb._databaseId.database);
  if (id && id !== PRACTICE_DB_ID) throw new Error(`練習DB（${PRACTICE_DB_ID}）ではありません（${id}）。初期化を中止します`);
}

// 練習DBへ、[{ path: "コレクション/ID", data }] を500件ずつのバッチで書く（practiceDb 専用）
async function writeEntries(practiceDb, entries) {
  let written = 0;
  for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
    const batch = practiceDb.batch();
    for (const e of entries.slice(i, i + BATCH_LIMIT)) batch.set(practiceDb.doc(e.path), e.data);
    await batch.commit();
    written += Math.min(BATCH_LIMIT, entries.length - i);
  }
  return written;
}

// 本番の商品・保管場所・設定を「読むだけ」で取り出す
async function readProdMaster(prodDb) {
  const productsSnap = await prodDb.collection("products").get();
  const locationsSnap = await prodDb.collection("locations").get();
  const settingsSnap = await prodDb.collection("appConfig").doc("settings").get();
  return {
    products: productsSnap.docs.map((d) => ({ id: d.id, data: d.data() })),
    locations: locationsSnap.docs.map((d) => ({ id: d.id, data: d.data() })),
    settings: settingsSnap.exists ? settingsSnap.data() : {},
  };
}

/**
 * 練習DBを空にして、初期データを入れ直す。
 * @param {{prodDb: object, practiceDb: object, now?: Date}} args
 * @returns 件数のまとめ
 */
async function resetPracticeDatabase({ prodDb, practiceDb, now }) {
  assertPracticeDb(practiceDb, prodDb);
  const t0 = now instanceof Date ? now : new Date();

  // ① 練習DBのトップレベルのコレクションをすべて消す（練習中に作られたものも含めて全部）
  const cols = await practiceDb.listCollections();
  for (const col of cols) await practiceDb.recursiveDelete(col);

  // ② 本番から商品・保管場所を写す（読み取りのみ）／設定は許可した項目だけ写す
  const master = await readProdMaster(prodDb);
  const entries = [];
  // 練習生も読むので、人の名前・住所・電話・作成者は持ち込まない（保管場所は ID を保って架空の届け先に置き換え）
  master.products.forEach((p) => entries.push({ path: `products/${p.id}`, data: sanitizeProduct(p.data) }));
  master.locations.forEach((l, i) => entries.push({ path: `locations/${l.id}`, data: sanitizeLocation(l.id, l.data, i) }));
  entries.push({
    path: "appConfig/settings",
    // 経理への報告は宛先が無いと画面で止まるので、架空の経理担当を入れる（送信は画面の代役が止める・本番の宛先は写さない）
    data: {
      ...extractPracticeSettings(master.settings), practice: true, copiedFromProdAt: t0,
      accountingEmail: "keiri-renshu@example.jp", accountingContactName: "練習 経理",
    },
  });

  // ③ 架空データ。出荷の品番は、いま練習DBに写した products にあるものだけを使う
  const seed = buildPracticeSeed(t0, { availableProductIds: master.products.map((p) => p.id) });
  const seedCounts = {};
  for (const [col, docs] of Object.entries(seed)) {
    seedCounts[col] = Object.keys(docs).length;
    for (const [id, data] of Object.entries(docs)) entries.push({ path: `${col}/${id}`, data });
  }

  const written = await writeEntries(practiceDb, entries);
  return {
    deletedCollections: cols.map((c) => c.id),
    copied: { products: master.products.length, locations: master.locations.length, settings: 1 },
    seeded: seedCounts,
    totalWritten: written,
    resetAt: t0.toISOString(),
  };
}

// 呼んだ人が「本番の users/{email} で有効かつ管理者」か。本番DBは読むだけ
async function isActiveAdmin(prodDb, email) {
  if (!email) return false;
  const snap = await prodDb.collection("users").doc(email).get();
  const u = snap.exists ? snap.data() : null;
  return !!u && u.active === true && u.role === "admin";
}

// 管理者の「今すぐ初期化」
exports.resetPractice = onCall(
  { region: REGION, timeoutSeconds: 300, memory: "512MiB", serviceAccount: SA_BATCH },
  async (request) => {
    const email = request.auth?.token?.email || "";
    const { practiceDb, prodDb } = openDatabases();
    if (!(await isActiveAdmin(prodDb, email))) {
      throw new HttpsError("permission-denied", "練習モードの初期化は管理者だけができます");
    }
    try {
      const summary = await resetPracticeDatabase({ prodDb, practiceDb, now: new Date() });
      console.log(`resetPractice by ${email}:`, JSON.stringify(summary));
      return { ok: true, ...summary };
    } catch (e) {
      console.error("resetPractice error:", e);
      throw new HttpsError("internal", `初期化に失敗しました: ${e.message}`);
    }
  }
);

// 毎晩3時（JST）の自動初期化
exports.nightlyPracticeReset = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Asia/Tokyo", region: REGION, timeoutSeconds: 300, memory: "512MiB", serviceAccount: SA_BATCH },
  async () => {
    try {
      const { practiceDb, prodDb } = openDatabases();
      const summary = await resetPracticeDatabase({ prodDb, practiceDb, now: new Date() });
      console.log("nightlyPracticeReset done:", JSON.stringify(summary));
    } catch (e) {
      console.error("nightlyPracticeReset error:", e);
    }
  }
);

// テスト用に純粋な部分も出す（Cloud Functions のエクスポート扱いにはならない：index.js は名前を指定して再エクスポートする）
exports._internal = { resetPracticeDatabase, assertPracticeDb, writeEntries, isActiveAdmin };
