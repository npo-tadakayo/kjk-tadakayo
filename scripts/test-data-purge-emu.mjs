// 役目を終えた記録の自動削除（2026-11-19 §C20・functions/data-purge.js）を Firestore のエミュレータで確かめる。
// 本番には繋がない（demo- プロジェクト）。
//
//   A. 消す対象: leadTokens（期限＋7日）／_notifyLog（90日）／_rateLimit（期限）／署名のない承諾書（180日）
//   B. 消してはいけないもの: 期限内／署名済みの承諾書（status signed・signed あり・kind order・紙）／別のコレクション
//   C. dryRun は何も消さずに件数だけ返す
//   D. 「残すもの」が大量にあっても、その先の消す対象まで届く（ページをまたぐ）
//   E. 1つのコレクションで失敗しても、ほかは処理される
//   F. 検索で読んだあとに署名されても、署名済みは消えない（消す直前に読み直す）
//   G. 1日の上限に当たったら途中で止めて capped を返す／翌日に続きができる
//   H. 削除のスイッチ（true だけが有効。"true"・1・文書なし・読めないは無効）
//
// 実行: firebase emulators:exec --only firestore --project demo-data-purge-test "node scripts/test-data-purge-emu.mjs"
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-data-purge-test";
if (!String(process.env.GCLOUD_PROJECT).startsWith("demo-")) { console.error("demo- 以外のプロジェクトでは動かさない"); process.exit(2); }
process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;

const FN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "functions");
const require = createRequire(path.join(FN_DIR, "index.js"));
const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const TS = admin.firestore.Timestamp;
const P = require(path.join(FN_DIR, "data-purge.js"));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2027, 0, 15, 0, 0, 0);
const ago = (days) => TS.fromMillis(NOW - days * DAY);

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); } else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); }
const exists = async (coll, id) => (await db.collection(coll).doc(id).get()).exists;
async function wipe() {
  for (const c of ["leadTokens", "_notifyLog", "_rateLimit", "consentRequests", "cases"]) {
    const s = await db.collection(c).get();
    for (let i = 0; i < s.docs.length; i += 400) {
      const b = db.batch(); s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit();
    }
  }
}

// ---------- 準備 ----------
await wipe();
// leadTokens: 期限＋7日を過ぎたら消す（期限が8日前＝消す／6日前＝残す／未来＝残す）
await db.collection("leadTokens").doc("lt_old").set({ expiresAt: ago(8), officeId: "o1" });
await db.collection("leadTokens").doc("lt_grace").set({ expiresAt: ago(6), officeId: "o1" });
await db.collection("leadTokens").doc("lt_live").set({ expiresAt: TS.fromMillis(NOW + 10 * DAY), officeId: "o1" });
// _notifyLog: 90日
await db.collection("_notifyLog").doc("n_old").set({ kind: "daily", createdAt: ago(91) });
await db.collection("_notifyLog").doc("n_new").set({ kind: "daily", createdAt: ago(89) });
// _rateLimit: expiresAt を過ぎたら
await db.collection("_rateLimit").doc("r_old").set({ kind: "quoteMailTotal", expiresAt: ago(1) });
await db.collection("_rateLimit").doc("r_today").set({ kind: "quoteMailTotal", expiresAt: TS.fromMillis(NOW + 2 * DAY) });
// consentRequests: 署名のないものだけ180日で消す
await db.collection("consentRequests").doc("c_pending_old").set({ status: "pending", createdAt: ago(181), contactName: "テスト" });
await db.collection("consentRequests").doc("c_canceled_old").set({ status: "canceled", createdAt: ago(200) });
await db.collection("consentRequests").doc("c_pending_new").set({ status: "pending", createdAt: ago(179) });
await db.collection("consentRequests").doc("c_signed_old").set({ status: "signed", createdAt: ago(400), signed: { name: "署名者", method: "web", signedAt: ago(399) } });
await db.collection("consentRequests").doc("c_paper_old").set({ status: "signed", createdAt: ago(500), signed: { name: "紙", method: "paper" } });
await db.collection("consentRequests").doc("c_order_old").set({ kind: "order", status: "pending", createdAt: ago(900), signed: { name: "注文者", method: "web_order" } });
await db.collection("consentRequests").doc("c_weird_old").set({ status: "pending", createdAt: ago(300), signed: { name: "状態が古いまま署名だけある" } });
await db.collection("consentRequests").doc("c_nostatus_old").set({ createdAt: ago(300), contactName: "状態なし" }); // 状態が読めないものは消さない
// 別のコレクションは触らない
await db.collection("cases").doc("case_old").set({ caseNumber: 1, receivedAt: ago(1000), officeName: "古い案件" });

// ---------- C. dryRun ----------
section("C. dryRun は何も消さない");
const dry = await P.purgeExpired(db, { now: NOW, dryRun: true });
const by = (o, c) => o.results.find((r) => r.coll === c);
check("dryRun: 対象の件数が数えられる（leadTokens 1・_notifyLog 1・_rateLimit 1・consentRequests 2）",
  by(dry, "leadTokens").would === 1 && by(dry, "_notifyLog").would === 1 && by(dry, "_rateLimit").would === 1 && by(dry, "consentRequests").would === 2,
  JSON.stringify(dry.results));
check("dryRun: deleted は 0", dry.results.every((r) => r.deleted === 0));
check("dryRun のあとも全部残っている", (await exists("leadTokens", "lt_old")) && (await exists("_notifyLog", "n_old")) && (await exists("_rateLimit", "r_old")) && (await exists("consentRequests", "c_pending_old")));
check("dryRun 既定は true（引数を省くと消さない）", (await P.purgeExpired(db, { now: NOW })).dryRun === true && (await exists("leadTokens", "lt_old")));

// ---------- A・B. 本番の動き ----------
section("A. 消す対象");
const live = await P.purgeExpired(db, { now: NOW, dryRun: false });
check("leadTokens: 期限＋7日を過ぎたものだけ消えた", !(await exists("leadTokens", "lt_old")));
check("_notifyLog: 91日前は消えた", !(await exists("_notifyLog", "n_old")));
check("_rateLimit: 期限切れは消えた", !(await exists("_rateLimit", "r_old")));
check("承諾書: 署名のない pending（181日）は消えた", !(await exists("consentRequests", "c_pending_old")));
check("承諾書: 署名のない canceled（200日）は消えた", !(await exists("consentRequests", "c_canceled_old")));
check("件数の報告が正しい（deleted: 1・1・1・2）",
  by(live, "leadTokens").deleted === 1 && by(live, "_notifyLog").deleted === 1 && by(live, "_rateLimit").deleted === 1 && by(live, "consentRequests").deleted === 2,
  JSON.stringify(live.results));

section("B. 消してはいけないもの");
check("leadTokens: 期限は過ぎたが7日以内（猶予中）は残る", await exists("leadTokens", "lt_grace"));
check("leadTokens: 期限内は残る", await exists("leadTokens", "lt_live"));
check("_notifyLog: 89日前は残る", await exists("_notifyLog", "n_new"));
check("_rateLimit: 今日のカウンタは残る", await exists("_rateLimit", "r_today"));
check("承諾書: 180日未満の pending は残る", await exists("consentRequests", "c_pending_new"));
check("承諾書: 署名済み（web・400日前）は残る", await exists("consentRequests", "c_signed_old"));
check("承諾書: 紙で取得した署名済み（500日前）は残る", await exists("consentRequests", "c_paper_old"));
check("承諾書: 発注の承諾書（kind:order・900日前）は残る", await exists("consentRequests", "c_order_old"));
check("承諾書: status が pending のままでも signed が付いているものは残る（安全側）", await exists("consentRequests", "c_weird_old"));
check("承諾書: 状態が読めないものは消さない", await exists("consentRequests", "c_nostatus_old"));
check("別のコレクション（cases）は触らない", await exists("cases", "case_old"));
check("残した件数が報告される（承諾書 kept ＝ 2：発注の承諾書と、pending のまま signed が付いているもの。署名済みは読みもしない）", by(live, "consentRequests").kept === 2, JSON.stringify(by(live, "consentRequests")));

// ---------- 2回目は何もしない ----------
section("もう一度回しても壊れない（冪等）");
const again = await P.purgeExpired(db, { now: NOW, dryRun: false });
check("2回目は消す対象が 0", again.results.every((r) => r.would === 0 && r.deleted === 0), JSON.stringify(again.results));

// ---------- D. ページをまたぐ ----------
section("D. 「残すもの」が大量にあっても先へ届く");
await wipe();
{
  // 署名済み（残す）を 900 件、古い順に並べ、そのあとに署名のないもの（消す）を 5 件
  for (let i = 0; i < 900; i += 400) {
    const b = db.batch();
    for (let j = i; j < Math.min(i + 400, 900); j++) {
      b.set(db.collection("consentRequests").doc(`s${String(j).padStart(4, "0")}`), { status: "signed", signed: { name: "x", method: "web" }, createdAt: ago(1000 - j * 0.1) });
    }
    await b.commit();
  }
  const b2 = db.batch();
  for (let k = 0; k < 5; k++) b2.set(db.collection("consentRequests").doc(`p${k}`), { status: "pending", createdAt: ago(185 + k) });
  await b2.commit();
}
const big = await P.purgeExpired(db, { now: NOW, dryRun: false });
const bc = by(big, "consentRequests");
check("署名済み900件が先頭を占めても、署名のない5件が消えた", bc.deleted === 5 && !(await exists("consentRequests", "p0")) && !(await exists("consentRequests", "p4")), JSON.stringify(bc));
check("署名済み900件は1件も消えていない", (await db.collection("consentRequests").where("status", "==", "signed").get()).size === 900);

// ---------- E. 失敗の切り分け ----------
section("E. 1つのコレクションの失敗が全体を止めない");
{
  const realCollection = db.collection.bind(db);
  db.collection = (name) => { if (name === "_notifyLog") throw new Error("テスト用の失敗"); return realCollection(name); };
  const e = await P.purgeExpired(db, { now: NOW, dryRun: true });
  db.collection = realCollection;
  check("_notifyLog は error として返る", !!by(e, "_notifyLog").error, JSON.stringify(by(e, "_notifyLog")));
  check("ほかのコレクションは結果が返る", e.results.filter((r) => !r.error).length === 3, JSON.stringify(e.results));
}

// ---------- F. 署名との行き違い ----------
section("F. 読んだあとに署名されても、署名済みは消えない");
await wipe();
await db.collection("consentRequests").doc("race_signed").set({ status: "pending", createdAt: ago(300), contactName: "行き違い" });
await db.collection("consentRequests").doc("race_plain").set({ status: "pending", createdAt: ago(300) });
await db.collection("consentRequests").doc("race_canceled").set({ status: "pending", createdAt: ago(300) });
{
  const r = await P.purgeExpired(db, {
    now: NOW, dryRun: false,
    // 検索で読み終わった直後（消す直前）に、利用者が署名したことにする
    afterScan: async (coll) => {
      if (coll !== "consentRequests") return;
      await db.collection("consentRequests").doc("race_signed").update({ status: "signed", signed: { name: "署名者", method: "web", signedAt: ago(0) } });
      await db.collection("consentRequests").doc("race_canceled").update({ status: "signed", signed: { name: "別の署名者", method: "web" } });
    },
  });
  const c = by(r, "consentRequests");
  check("消す直前に署名された2件は残る", (await exists("consentRequests", "race_signed")) && (await exists("consentRequests", "race_canceled")));
  check("署名の中身も壊れていない", (await db.collection("consentRequests").doc("race_signed").get()).data().signed.name === "署名者");
  check("署名のないままだった1件は消える", !(await exists("consentRequests", "race_plain")) && c.deleted === 1, JSON.stringify(c));
}

// ---------- G. 1日の上限 ----------
section("G. 上限に当たったら途中で止める・翌日に続きができる");
await wipe();
for (let i = 0; i < 10; i++) await db.collection("leadTokens").doc(`cap${i}`).set({ expiresAt: ago(10 + i) });
{
  const day1 = await P.purgeExpired(db, { now: NOW, dryRun: false, batchSize: 2, maxRounds: 2 });
  const l1 = by(day1, "leadTokens");
  check("2件×2ページ＝4件で止まり capped が立つ", l1.deleted === 4 && l1.capped === true, JSON.stringify(l1));
  check("残りは6件", (await db.collection("leadTokens").get()).size === 6);
  const day2 = await P.purgeExpired(db, { now: NOW + DAY, dryRun: false, batchSize: 2, maxRounds: 10 });
  const l2 = by(day2, "leadTokens");
  check("翌日に続きをやると全部消え、capped は立たない", l2.deleted === 6 && l2.capped === false && (await db.collection("leadTokens").get()).size === 0, JSON.stringify(l2));
}

// ---------- H. スイッチ ----------
section("H. 削除のスイッチ（isEnabled）");
{
  const snap = (exists, data) => ({ exists, data: () => data });
  check("enabled:true だけが有効", P.isEnabled(snap(true, { enabled: true })) === true);
  check('"true"（文字列）は無効', P.isEnabled(snap(true, { enabled: "true" })) === false);
  check("1 は無効", P.isEnabled(snap(true, { enabled: 1 })) === false);
  check("false は無効", P.isEnabled(snap(true, { enabled: false })) === false);
  check("文書なしは無効", P.isEnabled(snap(false, undefined)) === false);
  check("読めない（例外・undefined）は無効", P.isEnabled({ exists: true, data() { throw new Error("x"); } }) === false && P.isEnabled(undefined) === false);
}

console.log(results.join("\n"));
console.log(`\n合計: ${pass}/${pass + fail} 合格`);
process.exit(fail ? 1 : 0);
