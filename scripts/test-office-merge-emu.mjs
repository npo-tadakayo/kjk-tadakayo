// 事業所の編集・統合（updateOffice / mergeOffices / unmergeOffice / findActiveCase / 見積もりの officeId 読み替え）を
// Firestore エミュレータに対して実際に動かして確かめる（独立検証・2026-10-24）。
//
// 実行（本番に繋がらない demo- プロジェクト。依存は functions/node_modules をそのまま使う）:
//   export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
//   cd <repo> && firebase emulators:exec --only firestore --project demo-office-test \
//     "node scripts/test-office-merge-emu.mjs"
// 終了コード: 全部合格 0、1件でも不合格 1。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error("FIRESTORE_EMULATOR_HOST がありません（emulators:exec で動かす）"); process.exit(2); }
process.env.GCLOUD_PROJECT ||= "demo-office-test";
process.env.APPCHECK_ENFORCE = "false";
process.env.CHAT_WEBHOOK_URL = "";
// 外部（Gmail・Chat・Google 認証）へは出さない。エミュレータ以外の fetch は即失敗させる
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url, opts);
  return new Response("blocked in test", { status: 503 });
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(REPO, "functions", "index.js"));
const fns = require(path.join(REPO, "functions", "index.js"));
const admin = require("firebase-admin");
const express = require("express");
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TS = admin.firestore.Timestamp;

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS ${label}`); }
  else { fail++; results.push(`  FAIL ${label} ${detail}`); }
}
function section(t) { results.push(`\n## ${t}`); }

const STAFF = "staff@tadakayo.jp", VIEWER = "viewer@tadakayo.jp", TRAINEE = "trainee@tadakayo.jp";
async function call(name, email, data) {
  try {
    const r = await fns[name].run({ auth: { uid: "uid-" + email, token: { email, name: email } }, data, rawRequest: {} });
    return { ok: true, r };
  } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
async function seedBatch(items) { // [[ref, data]]
  for (let i = 0; i < items.length; i += 450) {
    const b = db.batch();
    for (const [ref, d] of items.slice(i, i + 450)) b.set(ref, d);
    await b.commit();
  }
}
const off = (id) => db.collection("offices").doc(id);
const cs = (id) => db.collection("cases").doc(id);
const get = async (ref) => (await ref.get()).data();
const actCount = async (caseId, re) => (await db.collection("activities").where("caseId", "==", caseId).get())
  .docs.filter((d) => !re || re.test(d.data().subject || "")).length;
const old = TS.fromDate(new Date(Date.now() - 86400000));

// HTTP（onRequest）は express で受けて叩く
const app = express();
app.use(express.json());
app.post("/lp", (req, res) => fns.webhookLpInquiry(req, res));
app.post("/mitsumori", (req, res) => fns.webhookMitsumori(req, res));
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p, body) => { const r = await realFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };

await seedBatch([
  [db.collection("users").doc(STAFF), { active: true, role: "staff", name: "職員" }],
  [db.collection("users").doc(VIEWER), { active: true, role: "viewer", name: "閲覧" }],
  [db.collection("users").doc(TRAINEE), { active: true, role: "trainee", name: "練習" }],
]);

// ---------- 1. updateOffice ----------
section("1. updateOffice");
await seedBatch([
  [off("U1"), { officeName: "旧名事業所", corpName: "旧法人", address: "", phone: "0311112222" }],
  [cs("u1a"), { officeId: "U1", officeName: "旧名事業所", corpName: "旧法人", status: 2 }],
  [cs("u1b"), { officeId: "U1", officeName: "旧名事業所", corpName: "旧法人", status: 4, archived: true }],
  [cs("u1x"), { officeId: "OTHER", officeName: "旧名事業所", corpName: "旧法人", status: 2 }],
  [off("UM"), { officeName: "統合済み", mergedInto: "U1", mergeStatus: "done" }],
]);
let r = await call("updateOffice", VIEWER, { officeId: "U1", patch: { officeName: "x" } });
check("viewer rejected permission-denied", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("updateOffice", TRAINEE, { officeId: "U1", patch: { officeName: "x" } });
check("trainee rejected permission-denied", !r.ok && r.code === "permission-denied", JSON.stringify(r));
r = await call("updateOffice", "outsider@example.com", { officeId: "U1", patch: { officeName: "x" } });
check("non-tadakayo rejected", !r.ok && r.code === "permission-denied");
r = await call("updateOffice", STAFF, { officeId: "UM", patch: { officeName: "x" } });
check("merged office cannot be edited", !r.ok && r.code === "failed-precondition", JSON.stringify(r));
r = await call("updateOffice", STAFF, { officeId: "U1", patch: { mergedInto: "x" } });
check("non-editable field rejected", !r.ok && r.code === "invalid-argument");
r = await call("updateOffice", STAFF, { officeId: "U1", patch: { officeName: "新名事業所", corpName: "新法人" } });
check("name+corp update ok, casesUpdated=2", r.ok && r.r.casesUpdated === 2, JSON.stringify(r));
let a = await get(cs("u1a")), b = await get(cs("u1b")), x = await get(cs("u1x")), o = await get(off("U1"));
check("active case renamed", a.officeName === "新名事業所" && a.corpName === "新法人");
check("archived/lost case renamed", b.officeName === "新名事業所" && b.corpName === "新法人");
check("other office case untouched", x.officeName === "旧名事業所");
check("old name in aliases", Array.isArray(o.aliases) && o.aliases.includes("旧名事業所"), JSON.stringify(o.aliases));
check("activity on name change (1 each)", (await actCount("u1a")) === 1 && (await actCount("u1b")) === 1);
r = await call("updateOffice", STAFF, { officeId: "U1", patch: { phone: "0399998888" } });
check("phone-only: casesUpdated=0, no new activity", r.ok && r.r.casesUpdated === 0 && (await actCount("u1a")) === 1);
r = await call("updateOffice", STAFF, { officeId: "U1", patch: { corpName: "新新法人" } });
a = await get(cs("u1a"));
check("corp-only: cases updated, no activity", r.ok && r.r.casesUpdated === 2 && a.corpName === "新新法人" && (await actCount("u1a")) === 1, JSON.stringify(r));
r = await call("updateOffice", STAFF, { officeId: "U1", patch: { address: "大阪府豊中市新千里東町1-2-3" } });
o = await get(off("U1"));
check("address split into pref/city/detail", o.prefecture === "大阪府" && o.city === "豊中市" && o.addressDetail === "新千里東町1-2-3", JSON.stringify([o.prefecture, o.city, o.addressDetail]));
r = await call("updateOffice", STAFF, { officeId: "U1", patch: { officeName: "  " } });
check("empty name rejected", !r.ok && r.code === "invalid-argument");
r = await call("updateOffice", STAFF, { officeId: "NOPE", patch: { phone: "1" } });
check("missing office not-found", !r.ok && r.code === "not-found");

// ---------- 2. merge ----------
section("2. mergeOffices A→B");
await seedBatch([
  [off("A"), { officeName: "Aの名前", corpName: "A法人", phone: "0611112222", address: "大阪府吹田市1-1", prefecture: "大阪府", city: "吹田市", addressDetail: "1-1", aliases: ["A旧名"] }],
  [off("B"), { officeName: "Bの名前", corpName: "B法人", phone: "", address: "大阪府豊中市2-2", aliases: [] }],
  [off("C"), { officeName: "C事業所" }],
  [cs("a1"), { officeId: "A", officeName: "Aの名前", corpName: "A法人", status: 2, contactEmail: "m@ex.jp", receivedAt: old }],
  [cs("a2"), { officeId: "A", officeName: "Aの写し違い", corpName: "A法人", status: 2 }],
  [cs("a3"), { officeId: "A", officeName: "Aの名前", corpName: "A法人", status: 4, archived: true }],
  [cs("b1"), { officeId: "B", officeName: "Bの名前", corpName: "B法人", status: 2 }],
  [db.collection("quotes").doc("qa1"), { officeId: "A", officeName: "Aの名前", corpName: "A法人" }],
  [db.collection("shipments").doc("sa1"), { officeId: "A", officeName: "Aの名前" }],
  [db.collection("leadTokens").doc("la1"), { officeId: "A", caseId: "a1" }],
]);
r = await call("mergeOffices", VIEWER, { fromId: "A", toId: "B" });
check("viewer cannot merge", !r.ok && r.code === "permission-denied");
r = await call("mergeOffices", STAFF, { fromId: "A", toId: "B", keep: { officeName: "to", phone: "from", address: "from" } });
check("merge ok", r.ok, JSON.stringify(r));
check("moved counts", r.ok && JSON.stringify(r.r.moved) === JSON.stringify({ cases: 3, quotes: 1, shipments: 1, leadTokens: 1 }) && r.r.resumed === false, JSON.stringify(r.r));
let A = await get(off("A")), B = await get(off("B"));
check("B kept values", B.officeName === "Bの名前" && B.phone === "0611112222" && B.address === "大阪府吹田市1-1" && B.prefecture === "大阪府" && B.city === "吹田市", JSON.stringify(B));
check("B aliases include A names", B.aliases.includes("Aの名前") && B.aliases.includes("A旧名"), JSON.stringify(B.aliases));
check("A mergedInto/archived/done", A.mergedInto === "B" && A.archived === true && A.mergeStatus === "done" && A.archivedBeforeMerge === false);
const moved = await Promise.all(["a1", "a2", "a3"].map((id) => get(cs(id))));
check("cases moved + renamed", moved.every((c) => c.officeId === "B" && c.officeName === "Bの名前" && c.corpName === "B法人"));
const q = await get(db.collection("quotes").doc("qa1")), s = await get(db.collection("shipments").doc("sa1")), lt = await get(db.collection("leadTokens").doc("la1"));
check("quote/shipment/leadToken officeId moved", q.officeId === "B" && s.officeId === "B" && lt.officeId === "B");
check("quote/shipment names untouched", q.officeName === "Aの名前" && q.corpName === "A法人" && s.officeName === "Aの名前");
check("per-case merge activity", (await actCount("a1", /統合/)) === 1 && (await actCount("a3", /統合/)) === 1 && (await actCount("b1")) === 0);
const logsOf = async (id, runId) => (await off(id).collection("mergeLog").where("runId", "==", runId).get()).docs.map((d) => d.data());
let logsA = await logsOf("A", A.mergeRunId);
check("snapshots stored in mergeLog subcollection", logsA.some((l) => l.kind === "cases" && l.snapshots?.a2?.officeName === "Aの写し違い"), JSON.stringify(logsA).slice(0, 300));
check("office doc keeps only counts (no mergedRefs/snapshots)", !A.mergedRefs && !A.mergedCaseSnapshots && A.mergeCounts?.cases === 3 && A.mergeCounts?.leadTokens === 1, JSON.stringify(A.mergeCounts));
check("lock released after merge", !A.opLock && !B.opLock);
check("to's names unchanged → no toCases renamed", r.r.toCasesRenamed === 0 && (await get(cs("b1"))).officeName === "Bの名前");

// ---------- 3. refusals ----------
section("3. merge refusals");
await seedBatch([[off("D"), { officeName: "D" }], [off("E"), { officeName: "E" }]]);
r = await call("mergeOffices", STAFF, { fromId: "D", toId: "D" }); check("A==B invalid-argument", !r.ok && r.code === "invalid-argument");
r = await call("mergeOffices", STAFF, { fromId: "D", toId: "ZZZ" }); check("missing not-found", !r.ok && r.code === "not-found");
r = await call("mergeOffices", STAFF, { fromId: "D", toId: "A" }); check("to already merged refused", !r.ok && r.code === "failed-precondition");
r = await call("mergeOffices", STAFF, { fromId: "A", toId: "E" }); check("from merged elsewhere refused", !r.ok && r.code === "failed-precondition");
r = await call("mergeOffices", STAFF, { fromId: "A", toId: "B" }); check("already done refused", !r.ok && r.code === "failed-precondition");
r = await call("mergeOffices", STAFF, { fromId: "D", toId: "E", keep: { mergedInto: "from" } }); check("bad keep field refused", !r.ok && r.code === "invalid-argument");
check("refusals wrote nothing to D", !(await get(off("D"))).mergedInto);

// ---------- 4. resume ----------
section("4. resume after partial failure");
await seedBatch([
  [off("R1"), { officeName: "R1名", corpName: "R法人", mergedInto: "R2", mergeStatus: "running", archived: true, archivedBeforeMerge: false,
    mergeRunId: "run-r", mergeCounts: { cases: 2, quotes: 0, shipments: 0, leadTokens: 0, toCases: 0 },
    mergeToBefore: { officeName: "R2名", corpName: "R2法人", address: "", phone: "", postalCode: "", prefecture: "", city: "", addressDetail: "", aliases: [] },
    mergeWrote: { officeName: "R2名", corpName: "R2法人", address: "", phone: "", postalCode: "", prefecture: "", city: "", addressDetail: "" },
    opLock: { id: "dead", kind: "merge", by: STAFF, at: TS.fromDate(new Date(Date.now() - 6 * 60 * 1000)) } }], // 落ちた実行の古い印（5分超）
  [off("R1").collection("mergeLog").doc("l1"), { runId: "run-r", kind: "cases", ids: ["r1", "r2"], snapshots: { r1: { officeName: "R1名", corpName: "R法人" }, r2: { officeName: "R1名", corpName: "R法人" } } }],
  [off("R2"), { officeName: "R2名", corpName: "R2法人", aliases: ["R1名"] }],
  [cs("r1"), { officeId: "R2", officeName: "R2名", corpName: "R2法人" }],
  [cs("r2"), { officeId: "R2", officeName: "R2名", corpName: "R2法人" }],
  [cs("r3"), { officeId: "R1", officeName: "R1名", corpName: "R法人" }],
  [cs("r4"), { officeId: "R1", officeName: "R1名", corpName: "R法人" }],
  [db.collection("quotes").doc("rq"), { officeId: "R1" }],
]);
r = await call("mergeOffices", STAFF, { fromId: "R1", toId: "R2", keep: { officeName: "from", corpName: "from" } });
check("resume ok resumed=true (stale lock expired)", r.ok && r.r.resumed === true, JSON.stringify(r));
const R2 = await get(off("R2"));
check("resume ignores keep (to's values not rewritten)", R2.officeName === "R2名" && R2.corpName === "R2法人", JSON.stringify(R2));
check("resume totals cases=4 quotes=1", r.ok && r.r.moved.cases === 4 && r.r.moved.quotes === 1, JSON.stringify(r.r?.moved));
check("no duplicate activity on already-moved", (await actCount("r1")) === 0 && (await actCount("r3")) === 1);
check("R1 done", (await get(off("R1"))).mergeStatus === "done");

// ---------- 5. unmerge ----------
section("5. unmergeOffice A");
await cs("a2").update({ officeId: "C", officeName: "C事業所" }); // 統合後に別へ動かした
r = await call("unmergeOffice", TRAINEE, { fromId: "A" }); check("trainee cannot unmerge", !r.ok && r.code === "permission-denied");
r = await call("unmergeOffice", STAFF, { fromId: "A" });
check("unmerge ok counts", r.ok && JSON.stringify(r.r.restored) === JSON.stringify({ cases: 2, quotes: 1, shipments: 1, leadTokens: 1 }), JSON.stringify(r));
const a1 = await get(cs("a1")), a2 = await get(cs("a2")), a3 = await get(cs("a3"));
check("restored cases back to A with snapshot names", a1.officeId === "A" && a1.officeName === "Aの名前" && a3.officeId === "A");
check("moved-elsewhere case untouched", a2.officeId === "C" && a2.officeName === "C事業所");
A = await get(off("A"));
check("A archived removed, merge fields cleared", A.archived === undefined && !A.mergedInto && !A.mergeRunId && !A.mergeCounts && A.lastUnmerge?.toId === "B" && !A.opLock, JSON.stringify(A));
check("mergeLog kept after unmerge (history)", (await logsOf("A", A.lastUnmerge?.runId)).length > 0);
check("to unchanged since merge → toRestored", r.r.toRestored === true && r.r.note === "", JSON.stringify(r.r));
B = await get(off("B"));
check("B master restored to pre-merge values", B.phone === "" && B.address === "大阪府豊中市2-2" && B.officeName === "Bの名前", JSON.stringify(B));
check("unmerge activities written", (await actCount("a1", /取り消し/)) === 1 && (await actCount("a2", /取り消し/)) === 0);
check("b1 untouched", (await get(cs("b1"))).officeId === "B");
// archivedBeforeMerge
await seedBatch([[off("H1"), { officeName: "H1", archived: true }], [off("H2"), { officeName: "H2" }]]);
await call("mergeOffices", STAFF, { fromId: "H1", toId: "H2" });
r = await call("unmergeOffice", STAFF, { fromId: "H1" });
check("archivedBeforeMerge restores archived=true", r.ok && (await get(off("H1"))).archived === true);
r = await call("unmergeOffice", STAFF, { fromId: "H1" }); check("unmerge on non-merged refused", !r.ok && r.code === "failed-precondition");
r = await call("unmergeOffice", STAFF, { fromId: "R1" }); check("unmerge R1 ok", r.ok);

// ---------- 6. findActiveCase via LP inquiry ----------
section("6. findActiveCase (webhookLpInquiry)");
await seedBatch([
  [off("F1"), { officeName: "F旧名ケア" }], [off("F2"), { officeName: "F新センター" }],
  [cs("f1"), { officeId: "F1", officeName: "F旧名ケア", status: 2, contactEmail: "f@ex.jp", receivedAt: old, source: "lp_inquiry" }],
]);
r = await call("mergeOffices", STAFF, { fromId: "F1", toId: "F2" });
let h = await post("/lp", { email: "f@ex.jp", officeName: "F旧名ケア", name: "担当" });
check("old name inquiry attaches to case under F2", h.status === 200 && h.json?.existing === true && h.json?.caseId === "f1", JSON.stringify(h));
h = await post("/lp", { email: "f@ex.jp", officeName: "Ｆ旧名 ケア", name: "担当" });
check("normalized (全角/空白) old name also attaches", h.json?.caseId === "f1", JSON.stringify(h));
// exact-name precedence: older exact case vs newer alias case
await seedBatch([
  [off("G1"), { officeName: "G本体", aliases: ["G別名"] }],
  [cs("g_exact"), { officeId: "G9", officeName: "G別名", status: 2, contactEmail: "g@ex.jp", receivedAt: TS.fromDate(new Date(Date.now() - 3 * 86400000)), source: "x" }],
  [cs("g_alias"), { officeId: "G1", officeName: "G本体", status: 2, contactEmail: "g@ex.jp", receivedAt: old, source: "x" }],
]);
h = await post("/lp", { email: "g@ex.jp", officeName: "G別名", name: "担当" });
check("exact name match wins over alias match", h.json?.caseId === "g_exact", JSON.stringify(h.json));
h = await post("/lp", { email: "f@ex.jp", officeName: "全く新しい事業所", name: "担当" });
check("brand-new name creates new case", h.status === 200 && !h.json?.existing && h.json?.caseId && h.json.caseId !== "f1", JSON.stringify(h.json));

// ---------- 7. mitsumori leadToken → merged office ----------
section("7. createOrUpdateMitsumoriQuote officeId resolution");
const tok = "ab".repeat(16);
await seedBatch([
  [off("M1"), { officeName: "M1", prefecture: "" }], [off("M2"), { officeName: "M2", prefecture: "大阪府" }],
  [cs("m1"), { officeId: "M1", officeName: "M1", status: 2, contactEmail: "mm@ex.jp", receivedAt: old, caseNumber: 9001 }],
]);
await call("mergeOffices", STAFF, { fromId: "M1", toId: "M2" });
await db.collection("leadTokens").doc(tok).set({ caseId: "m1", officeId: "M1", email: "mm@ex.jp", prefill: {}, expiresAt: TS.fromDate(new Date(Date.now() + 86400000)), usedFor: [] });
h = await post("/mitsumori", { token: tok, email: "mm@ex.jp", officeName: "M1", subsidyCategory: "houmon", btSubsidyQty: 1, prefecture: "大阪府", city: "豊中市" });
const qid = h.json?.quoteId;
const qd = qid ? await get(db.collection("quotes").doc(qid)) : null;
check("quote officeId resolved to M2", h.status === 200 && qd?.officeId === "M2", JSON.stringify({ h, off: qd?.officeId }));

// ---------- 8. >400 cases batching ----------
section("8. batching 450 cases");
const big = [[off("BIG"), { officeName: "大量元", corpName: "大" }], [off("BIGT"), { officeName: "大量先" }]];
for (let i = 0; i < 450; i++) big.push([cs(`big${i}`), { officeId: "BIG", officeName: "大量元", corpName: "大" }]);
await seedBatch(big);
r = await call("updateOffice", STAFF, { officeId: "BIG", patch: { officeName: "大量元2" } });
check("updateOffice 450 cases", r.ok && r.r.casesUpdated === 450, JSON.stringify(r));
r = await call("mergeOffices", STAFF, { fromId: "BIG", toId: "BIGT" });
check("merge 450 cases", r.ok && r.r.moved.cases === 450, JSON.stringify(r));
const left = (await db.collection("cases").where("officeId", "==", "BIG").get()).size;
check("none left on BIG", left === 0);
r = await call("unmergeOffice", STAFF, { fromId: "BIG" });
check("unmerge 450 cases", r.ok && r.r.restored.cases === 450 && (await get(cs("big449"))).officeName === "大量元2", JSON.stringify(r));

// ---------- 9. adversarial ----------
section("9. adversarial");
// 9a. >5000 refs refused
const many = [[off("N1"), { officeName: "N1" }], [off("N2"), { officeName: "N2" }]];
for (let i = 0; i < 5001; i++) many.push([db.collection("leadTokens").doc(`n${i}`), { officeId: "N1" }]);
await seedBatch(many);
r = await call("mergeOffices", STAFF, { fromId: "N1", toId: "N2" });
check(">5000 refs refused before writing", !r.ok && r.code === "failed-precondition" && !(await get(off("N1"))).mergedInto, JSON.stringify(r));
// 9b. double-click: two concurrent merges of the same pair
const dbl = [[off("P1"), { officeName: "P1" }], [off("P2"), { officeName: "P2" }]];
for (let i = 0; i < 20; i++) dbl.push([cs(`p${i}`), { officeId: "P1", officeName: "P1" }]);
await seedBatch(dbl);
const [d1, d2] = await Promise.all([call("mergeOffices", STAFF, { fromId: "P1", toId: "P2" }), call("mergeOffices", STAFF, { fromId: "P1", toId: "P2" })]);
let dupActs = 0; for (let i = 0; i < 20; i++) dupActs += Math.max(0, (await actCount(`p${i}`)) - 1);
check("concurrent double merge: no duplicate activities", dupActs === 0, `results=${JSON.stringify([d1.ok, d2.ok, d1.r?.resumed, d2.r?.resumed])} extraActivities=${dupActs}`);
// 9c. chain: A→B then B→C, then unmerge A
await seedBatch([[off("K1"), { officeName: "K1" }], [off("K2"), { officeName: "K2" }], [off("K3"), { officeName: "K3" }],
  [cs("k1"), { officeId: "K1", officeName: "K1" }]]);
await call("mergeOffices", STAFF, { fromId: "K1", toId: "K2" });
await call("mergeOffices", STAFF, { fromId: "K2", toId: "K3" });
r = await call("unmergeOffice", STAFF, { fromId: "K1" });
const k1 = await get(off("K1"));
check("unmerge of A after B→C refused (to is merged)", !r.ok && r.code === "failed-precondition" && /統合先の事業所がさらに別の事業所に統合されています/.test(r.msg) && k1.mergedInto === "K2", JSON.stringify(r));
check("unmerge of A after B→C does not silently drop refs", !(r.ok && r.r.restored.cases === 0 && !k1.mergedRefs),
  `unmerge=${JSON.stringify(r)} k1 case now at ${(await get(cs("k1"))).officeId}; K1 archived=${k1.archived} mergedRefs=${JSON.stringify(k1.mergedRefs)}`);
// 9d. snapshot doc size: 2,000 cases with long names (under the 5,000 cap)
const longName = "長".repeat(200);
const sz = [[off("S1"), { officeName: "S1" }], [off("S2"), { officeName: "S2" }]];
for (let i = 0; i < 2000; i++) sz.push([cs(`s${i}`), { officeId: "S1", officeName: longName, corpName: longName }]);
await seedBatch(sz);
r = await call("mergeOffices", STAFF, { fromId: "S1", toId: "S2" });
const s1 = await get(off("S1"));
check("2,000 long-name cases merge completes (doc size)", r.ok && s1.mergeStatus === "done", `merge=${JSON.stringify(r).slice(0, 300)} status=${s1.mergeStatus} movedSoFar=${s1.mergedRefs?.cases?.length}`);
r = await call("mergeOffices", STAFF, { fromId: "S1", toId: "S2" });
check("...second call on a done merge is refused (already merged)", !r.ok && r.code === "failed-precondition", JSON.stringify(r).slice(0, 200));
const s1logs = await logsOf("S1", s1.mergeRunId);
check("2,000 cases: mergeLog docs each ≤ 400 ids, total 2,000", s1logs.length >= 14 && s1logs.every((l) => l.ids.length <= 400) && s1logs.reduce((n, l) => n + l.ids.length, 0) === 2000, `docs=${s1logs.length}`);
r = await call("unmergeOffice", STAFF, { fromId: "S1" });
check("2,000 cases: unmerge restores all with long names", r.ok && r.r.restored.cases === 2000 && (await get(cs("s1999"))).officeName === longName, JSON.stringify(r).slice(0, 200));

// ---------- 10. fixes of 2026-10-24 review ----------
section("10. to's own cases renamed on merge / restored on unmerge (Codex P2)");
await seedBatch([
  [off("T1"), { officeName: "正しい名前", corpName: "正しい法人" }],
  [off("T2"), { officeName: "間違った名前", corpName: "", phone: "0612345678" }],
  [cs("t1"), { officeId: "T1", officeName: "正しい名前", corpName: "正しい法人" }],
  [cs("t2a"), { officeId: "T2", officeName: "間違った名前", corpName: "" }],
  [cs("t2b"), { officeId: "T2", officeName: "間違った名前(写し)", corpName: "" }],
]);
r = await call("mergeOffices", STAFF, { fromId: "T1", toId: "T2", keep: { officeName: "from", corpName: "from" } });
check("merge ok, toCasesRenamed=2", r.ok && r.r.toCasesRenamed === 2 && r.r.moved.cases === 1, JSON.stringify(r));
let t2a = await get(cs("t2a")), t2b = await get(cs("t2b"));
check("to's own cases got the kept names", t2a.officeName === "正しい名前" && t2a.corpName === "正しい法人" && t2b.officeName === "正しい名前");
check("to's own cases: rename activity", (await actCount("t2a", /事業所名を変更（統合）/)) === 1);
let T1 = await get(off("T1"));
check("toCases snapshot in mergeLog", (await logsOf("T1", T1.mergeRunId)).some((l) => l.kind === "toCases" && l.snapshots?.t2b?.officeName === "間違った名前(写し)"));
r = await call("unmergeOffice", STAFF, { fromId: "T1" });
t2a = await get(cs("t2a")); t2b = await get(cs("t2b"));
check("unmerge restores to master + to's case names", r.ok && r.r.toRestored === true && r.r.toCasesRestored === 2
  && (await get(off("T2"))).officeName === "間違った名前" && t2a.officeName === "間違った名前" && t2b.officeName === "間違った名前" && t2a.corpName === "", JSON.stringify(r));
// ↑ t2b は統合前「間違った名前(写し)」だったが、取り消しでは to の案件をすべて戻した to の値にそろえる（事業所と案件の名前を一致させる）
check("t1 back on T1 with its name", (await get(cs("t1"))).officeId === "T1" && (await get(cs("t1"))).officeName === "正しい名前");
// to edited after merge → to not restored, note returned
await seedBatch([
  [off("V1"), { officeName: "V正" }], [off("V2"), { officeName: "V誤", phone: "" }],
  [cs("v1"), { officeId: "V1", officeName: "V正" }], [cs("v2"), { officeId: "V2", officeName: "V誤" }],
]);
await call("mergeOffices", STAFF, { fromId: "V1", toId: "V2", keep: { officeName: "from" } });
r = await call("updateOffice", STAFF, { officeId: "V2", patch: { phone: "0300000000" } });
check("edit to after merge ok", r.ok, JSON.stringify(r));
r = await call("unmergeOffice", STAFF, { fromId: "V1" });
const V2 = await get(off("V2"));
check("to edited after merge → toRestored=false + note, values kept", r.ok && r.r.toRestored === false && /編集されている/.test(r.r.note)
  && V2.officeName === "V正" && V2.phone === "0300000000" && (await get(cs("v2"))).officeName === "V正", JSON.stringify(r));

section("10b. A→B (rename) → C→B (no rename) → undo A→B (Codex P2 2nd)");
await seedBatch([
  [off("QA"), { officeName: "QA正式名", corpName: "QA法人" }],
  [off("QB"), { officeName: "QB仮名", corpName: "" }],
  [off("QC"), { officeName: "QC別名", corpName: "" }],
  [cs("qa1"), { officeId: "QA", officeName: "QA正式名", corpName: "QA法人" }],
  [cs("qb1"), { officeId: "QB", officeName: "QB仮名", corpName: "" }],
  [cs("qc1"), { officeId: "QC", officeName: "QC別名", corpName: "" }],
]);
r = await call("mergeOffices", STAFF, { fromId: "QA", toId: "QB", keep: { officeName: "from", corpName: "from" } });
check("A→B with rename ok", r.ok && (await get(off("QB"))).officeName === "QA正式名", JSON.stringify(r));
r = await call("mergeOffices", STAFF, { fromId: "QC", toId: "QB" });
check("C→B without rename ok", r.ok && (await get(cs("qc1"))).officeName === "QA正式名", JSON.stringify(r));
r = await call("unmergeOffice", STAFF, { fromId: "QA" });
const QB = await get(off("QB"));
const underB = (await db.collection("cases").where("officeId", "==", "QB").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
check("undo A→B: B master restored", r.ok && r.r.toRestored === true && QB.officeName === "QB仮名" && QB.corpName === "", JSON.stringify(r));
check("undo A→B: every case under B matches B's master (incl. the one from C)",
  underB.length === 2 && underB.every((c) => c.officeName === QB.officeName && (c.corpName || "") === (QB.corpName || "")), JSON.stringify(underB));
const qa1 = await get(cs("qa1"));
check("undo A→B: A's case back on A with its name", qa1.officeId === "QA" && qa1.officeName === "QA正式名" && qa1.corpName === "QA法人");
check("undo A→B: rename-back activity on qc1", (await actCount("qc1", /事業所名を戻す（統合の取り消し）/)) === 1);

section("11. lease lock (Codex P2 / verifier)");
const BUSY = "ほかの人がこの事業所を更新中です。少し待ってからもう一度お試しください";
await seedBatch([[off("L1"), { officeName: "L1", opLock: { id: "x", kind: "merge", by: "other@tadakayo.jp", at: TS.now() } }], [off("L2"), { officeName: "L2" }]]);
r = await call("updateOffice", STAFF, { officeId: "L1", patch: { phone: "1" } });
check("edit during another op refused with busy message", !r.ok && r.code === "failed-precondition" && r.msg === BUSY, JSON.stringify(r));
r = await call("mergeOffices", STAFF, { fromId: "L2", toId: "L1" });
check("merge into a locked office refused, nothing written", !r.ok && r.msg === BUSY && !(await get(off("L2"))).mergedInto, JSON.stringify(r));
await off("L1").update({ opLock: { id: "x", kind: "merge", by: "other@tadakayo.jp", at: TS.fromDate(new Date(Date.now() - 5 * 60 * 1000 - 1000)) } });
r = await call("updateOffice", STAFF, { officeId: "L1", patch: { phone: "1" } });
check("stale lock (>5 min) does not block; lock removed after", r.ok && !(await get(off("L1"))).opLock, JSON.stringify(r));
// concurrent double edit: one wins, one busy (or both succeed sequentially); activities not duplicated
await seedBatch([[off("W1"), { officeName: "W旧" }], [cs("w1"), { officeId: "W1", officeName: "W旧" }]]);
const [e1, e2] = await Promise.all([call("updateOffice", STAFF, { officeId: "W1", patch: { officeName: "W新" } }), call("updateOffice", STAFF, { officeId: "W1", patch: { officeName: "W新" } })]);
check("double edit: ≤1 rename activity, no error other than busy", (await actCount("w1")) === 1 && [e1, e2].every((x) => x.ok || x.msg === BUSY), JSON.stringify([e1, e2]));
// concurrent double unmerge
await seedBatch([[off("X1"), { officeName: "X1" }], [off("X2"), { officeName: "X2" }], [cs("x1"), { officeId: "X1", officeName: "X1" }]]);
await call("mergeOffices", STAFF, { fromId: "X1", toId: "X2" });
const [u1, u2] = await Promise.all([call("unmergeOffice", STAFF, { fromId: "X1" }), call("unmergeOffice", STAFF, { fromId: "X1" })]);
check("double unmerge: one ok, other refused; 1 unmerge activity", [u1, u2].filter((x) => x.ok).length === 1 && (await actCount("x1", /取り消し/)) === 1 && (await get(cs("x1"))).officeId === "X1", JSON.stringify([u1, u2]));

section("12. refusals added 2026-10-24");
// from is the target of a still-running merge
await seedBatch([
  [off("Y0"), { officeName: "Y0", mergedInto: "Y1", mergeStatus: "running", mergeRunId: "ry" }],
  [off("Y1"), { officeName: "Y1" }], [off("Y2"), { officeName: "Y2" }],
]);
r = await call("mergeOffices", STAFF, { fromId: "Y1", toId: "Y2" });
check("merge refused when from is target of a running merge", !r.ok && r.code === "failed-precondition" && !(await get(off("Y1"))).mergedInto && !(await get(off("Y1"))).opLock, JSON.stringify(r));
// all refs moved elsewhere → unmerge refused, records kept
await seedBatch([[off("Z1"), { officeName: "Z1" }], [off("Z2"), { officeName: "Z2" }], [off("Z3"), { officeName: "Z3" }], [cs("z1"), { officeId: "Z1", officeName: "Z1" }]]);
await call("mergeOffices", STAFF, { fromId: "Z1", toId: "Z2" });
await cs("z1").update({ officeId: "Z3" });
r = await call("unmergeOffice", STAFF, { fromId: "Z1" });
const Z1 = await get(off("Z1"));
check("unmerge with 0 restorable refused, merge records kept", !r.ok && r.code === "failed-precondition" && Z1.mergedInto === "Z2" && Z1.mergeRunId && (await logsOf("Z1", Z1.mergeRunId)).length === 1 && !Z1.opLock, JSON.stringify(r));

server.close();
console.log(results.join("\n"));
console.log(`\n合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
