// 当日の記録を「同じ事業所の他の案件にも写す」（設計書 2026-11-10 提案2・複写方式）のテスト。
// node scripts/test-onsite-copy.mjs
// 記録の例はすべて架空（利用者氏名・被保険者証番号は使わない）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../admin/js/onsite-copy.js";
import { findOnsiteConfirmation, activityRefLink, onsiteConfirmActivity } from "../admin/js/onsite-record.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`NG: ${name}`); throw e; } };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const SRC_ONSITE = {
  visitDate: "2026-11-12", visitPlace: "office", visitTimeFrom: "10:00", visitTimeTo: "12:00",
  notes: "カードリーダーの台数を確認した",
  steps: {
    portalReg: { done: true, memo: "" },
    certInstall: { done: true, memo: "証明書は前日に取得済み" },
    mynaApp: { done: false, memo: "" },
  },
};

// ===== 候補 =====
t("候補: 同じ officeId の他の案件だけ（自分・別の事業所・対象外にした案件は出さない）・案件番号の順", () => {
  const cur = { _id: "A", officeId: "O1", caseNumber: 12 };
  const cases = [
    { _id: "A", officeId: "O1", caseNumber: 12 },
    { _id: "C", officeId: "O1", caseNumber: 15, serviceType: "訪問介護" },
    { _id: "B", officeId: "O1", caseNumber: 13 },
    { _id: "D", officeId: "O2", caseNumber: 14 },
    { _id: "E", officeId: "O1", caseNumber: 16, archived: true },
    { _id: "F", caseNumber: 17 },
  ];
  assert.deepEqual(C.copyCandidates(cur, cases).map((x) => x._id), ["B", "C"]);
});

t("候補: officeId が無い案件では候補を出さず、理由を出す", () => {
  assert.deepEqual(C.copyCandidates({ _id: "A", officeName: "架空事業所" }, [{ _id: "B", officeName: "架空事業所" }]), []);
  assert.equal(C.copyUnavailableReason({ _id: "A" }), "事業所が未登録のため写せません");
  assert.equal(C.copyUnavailableReason({ _id: "A", officeId: "O1" }), "");
  assert.equal(C.copyUnavailableReason(null), "案件を読み込んでいます");
});

t("低-5: 統合などで対象外（archived）の案件は写し元になれない", () => {
  assert.equal(C.copyUnavailableReason({ _id: "A", officeId: "O1", archived: true }), "統合などで対象外になった案件のため写せません");
});

// ===== 写す内容 =====
t("写すもの: 当日工程のチェック・メモ・所感・訪問日。訪問場所と時刻（除外キー）は写さず写し先の値を残す", () => {
  const target = { visitPlace: "online", visitTimeFrom: "13:00" };
  const out = C.buildCopiedOnsite(SRC_ONSITE, target, {});
  assert.equal(out.visitDate, "2026-11-12");
  assert.equal(out.notes, SRC_ONSITE.notes);
  assert.deepEqual(out.steps.certInstall, { done: true, memo: "証明書は前日に取得済み" });
  assert.equal(out.visitPlace, "online", "写し先の場所を残す");
  assert.equal(out.visitTimeFrom, "13:00");
  assert.equal(out.visitTimeTo, undefined, "写し元の時刻は持ち込まない");
});

t("写し元に無い工程は写し先から消える（onsite の写す部分は丸ごと置き換え）", () => {
  const target = { steps: { userNotice: { done: true, memo: "写し先だけの入力" } } };
  const out = C.buildCopiedOnsite(SRC_ONSITE, target, {});
  assert.equal(out.steps.userNotice, undefined);
});

t("訪問日: 画面に出ている訪問日（引数）を優先する", () => {
  const out = C.buildCopiedOnsite({ steps: {} }, null, { visitDate: "2026-11-20" });
  assert.equal(out.visitDate, "2026-11-20");
  assert.deepEqual(out.steps, {});
});

t("除外キー: 一覧に工程のパスを足すだけで、その工程は写さず写し先の値が残る", () => {
  const ex = [...C.COPY_EXCLUDE_KEYS, "onsite.steps.certInstall"];
  const target = { steps: { certInstall: { done: false, memo: "事業種別で違う" } } };
  const out = C.buildCopiedOnsite(SRC_ONSITE, target, { exclude: ex });
  assert.deepEqual(out.steps.certInstall, { done: false, memo: "事業種別で違う" });
  assert.deepEqual(out.steps.portalReg, { done: true, memo: "" });
  // 除外した工程は、上書きの件数の判定にも入らない
  assert.equal(C.copyablePart({ steps: { certInstall: { done: true } } }, "onsite", ex).steps, undefined);
});

t("除外キーの既定: 訪問場所・開始・終了。写す節は onsite だけ（cp・performance などは写さない）", () => {
  assert.deepEqual(C.COPY_EXCLUDE_KEYS, ["onsite.visitPlace", "onsite.visitTimeFrom", "onsite.visitTimeTo"]);
  assert.deepEqual(C.COPY_SECTIONS, ["onsite"]);
  assert.deepEqual(C.copyablePart({ installStatus: "installed", steps: { a: { done: true } } }, "cp"), {});
  assert.deepEqual(C.copyablePart({ date: "2026-11-12" }, "performance"), {});
});

t("Storage の参照（写真・ファイル）は写さず、写し先の値を残す", () => {
  const s = { steps: { portalReg: { done: true, photo: { url: "https://firebasestorage.googleapis.com/v0/b/x/o/p.jpg", path: "documents/A/p.jpg" } } },
    files: [{ url: "u", path: "documents/A/f.pdf" }], link: "gs://bucket/a.jpg" };
  const out = C.buildCopiedOnsite(s, { files: [{ url: "u2", path: "documents/B/g.pdf" }] }, {});
  assert.equal(out.steps.portalReg.done, true, "同じ工程のチェックは写す");
  assert.equal(out.steps.portalReg.photo, undefined, "写真は写さない");
  assert.deepEqual(out.files, [{ url: "u2", path: "documents/B/g.pdf" }], "写し先の写真を残す");
  assert.equal(out.link, undefined);
  assert.equal(C.hasStorageRef("https://firebasestorage.googleapis.com/x"), false, "本文の中の URL は参照扱いしない（中-1）");
  assert.equal(C.hasStorageRef("gs://bucket/a.jpg"), true);
  assert.equal(C.hasStorageRef({ storagePath: "documents/A/a.jpg" }), true);
  assert.equal(C.hasStorageRef("ふつうのメモ"), false);
});

t("中-1: メモ本文に firebasestorage の URL があっても、そのメモは写り、写し先の同じ工程のメモは写し元の値になる", () => {
  const url = "https://firebasestorage.googleapis.com/v0/b/x/o/a.pdf";
  const s = { steps: { portalReg: { done: true, memo: `手順 ${url} 参照` } }, notes: `資料 ${url}` };
  const out = C.buildCopiedOnsite(s, { steps: { portalReg: { done: false, memo: "先のメモ" } } }, {});
  assert.deepEqual(out.steps.portalReg, { done: true, memo: `手順 ${url} 参照` });
  assert.equal(out.notes, `資料 ${url}`);
});

t("低-3: 写し元に訪問日が無く画面の欄も空なら、写し先の保存済みの訪問日を残す", () => {
  const out = C.buildCopiedOnsite({ steps: { portalReg: { done: true } } }, { visitDate: "2026-11-05" }, { visitDate: "" });
  assert.equal(out.visitDate, "2026-11-05");
  const chk = C.overwriteCheck({ onsite: { visitDate: "2026-11-05" } }, "A", out);
  assert.equal(chk.needsConfirm, false, "訪問日は消えないので上書きに数えない");
  // 写し元に訪問日があれば、写し先の訪問日は写し元の値になる（上書きに数える）
  const out2 = C.buildCopiedOnsite({ visitDate: "2026-11-12" }, { visitDate: "2026-11-05" }, {});
  assert.equal(out2.visitDate, "2026-11-12");
  assert.deepEqual(C.overwriteCheck({ onsite: { visitDate: "2026-11-05" } }, "A", out2).paths, ["visitDate"]);
});

t("写す内容が無ければ写さない", () => {
  assert.equal(C.hasCopyableContent({ steps: {} }, ""), false);
  assert.equal(C.hasCopyableContent({ steps: { a: { done: false, memo: "" } }, visitPlace: "office" }, ""), false, "場所だけでは写さない");
  assert.equal(C.hasCopyableContent({ steps: {} }, "2026-11-12"), true);
  assert.equal(C.hasCopyableContent({ steps: { a: { done: true } } }, ""), true);
});

// ===== 上書きの判定 =====
const newOnsite = C.buildCopiedOnsite(SRC_ONSITE, null, {});

t("上書き: 写し先が空なら確認しない", () => {
  assert.deepEqual(C.overwriteCheck(null, "A", newOnsite), { needsConfirm: false, count: 0, paths: [] });
  assert.equal(C.overwriteCheck({ onsite: { steps: { portalReg: { done: false, memo: "" } } } }, "A", newOnsite).needsConfirm, false, "false・空文字は入力なし");
});

t("上書き: 写し元由来でない入力があれば、変わる入力の件数つきで確認する", () => {
  const tdoc = { onsite: { notes: "写し先で書いた所感", steps: { userNotice: { done: true }, portalReg: { done: true } } } };
  const r = C.overwriteCheck(tdoc, "A", newOnsite);
  assert.equal(r.needsConfirm, true);
  assert.deepEqual(r.paths, ["notes", "steps.userNotice.done"], "同じ値（portalReg）は数えない");
  assert.equal(r.count, 2);
});

t("上書き: 写し先の除外キー（場所・時刻）だけの入力では確認しない", () => {
  assert.equal(C.overwriteCheck({ onsite: { visitPlace: "online", visitTimeFrom: "09:00" } }, "A", newOnsite).needsConfirm, false);
});

t("もう一度写す: 前回の複写のあと写し先が変わっていなければ確認しない", () => {
  const prevOnsite = C.buildCopiedOnsite({ ...SRC_ONSITE, notes: "前回の所感" }, null, {});
  const tdoc = { onsite: prevOnsite, copiedFrom: C.copiedFromRecord({ sourceCaseId: "A", sourceCaseNumber: 12, nowMs: 0, newOnsite: prevOnsite }) };
  const r = C.overwriteCheck(tdoc, "A", newOnsite);
  assert.equal(r.needsConfirm, false);
  assert.equal(C.changedSinceCopy(tdoc), false);
});

t("もう一度写す: 前回の複写のあと写し先で変更されていれば確認する", () => {
  const prevOnsite = C.buildCopiedOnsite(SRC_ONSITE, null, {});
  const cf = C.copiedFromRecord({ sourceCaseId: "A", sourceCaseNumber: 12, nowMs: 0, newOnsite: prevOnsite });
  const edited = { ...prevOnsite, steps: { ...prevOnsite.steps, mynaApp: { done: true, memo: "写し先で直した" } } };
  const tdoc = { onsite: edited, copiedFrom: cf };
  assert.equal(C.changedSinceCopy(tdoc), true);
  const r = C.overwriteCheck(tdoc, "A", newOnsite);
  assert.equal(r.needsConfirm, true);
  assert.equal(r.count, 2, "mynaApp の done と memo");
});

t("もう一度写す: 別の案件から写した記録なら、写し元由来でない入力として確認する", () => {
  const other = C.buildCopiedOnsite({ steps: { userNotice: { done: true } } }, null, {});
  const tdoc = { onsite: other, copiedFrom: C.copiedFromRecord({ sourceCaseId: "Z", sourceCaseNumber: 99, nowMs: 0, newOnsite: other }) };
  assert.equal(C.overwriteCheck(tdoc, "A", newOnsite).needsConfirm, true);
});

t("低-1: 末端が配列でも、同じ中身なら上書きに数えない", () => {
  const tdoc = { onsite: { steps: { a: { tags: ["x", "y"] } } } };
  const next = C.buildCopiedOnsite({ steps: { a: { tags: ["x", "y"] } } }, tdoc.onsite, {});
  assert.equal(C.overwriteCheck(tdoc, "A", next).needsConfirm, false);
  const next2 = C.buildCopiedOnsite({ steps: { a: { tags: ["x"] } } }, tdoc.onsite, {});
  assert.deepEqual(C.overwriteCheck(tdoc, "A", next2).paths, ["steps.a.tags"]);
});

t("低-2: 除外キーをあとで足しても、過去の複写は「写したあと変更あり」にならない", () => {
  const prev = C.buildCopiedOnsite(SRC_ONSITE, null, {});
  const cf = C.copiedFromRecord({ sourceCaseId: "A", sourceCaseNumber: 12, nowMs: 0, newOnsite: prev });
  assert.deepEqual(cf.excludeKeys, C.COPY_EXCLUDE_KEYS, "写した時点の除外キーを残す");
  // 「写した時点の一覧」には visitPlace が無く、そのあと一覧に足された、という状況を再現する
  const past = ["onsite.visitTimeFrom", "onsite.visitTimeTo"];
  const written = { ...prev, visitPlace: "office" };
  const old = C.copiedFromRecord({ sourceCaseId: "A", sourceCaseNumber: 12, nowMs: 0, newOnsite: written, exclude: past });
  assert.notEqual(old.fingerprint, C.copyFingerprint(written), "今の一覧で計算すると指紋は違う");
  assert.equal(C.changedSinceCopy({ onsite: written, copiedFrom: old }), false, "保存されている一覧で計算し直すので変更なし");
  assert.equal(C.overwriteCheck({ onsite: written, copiedFrom: old }, "A", newOnsiteFor(written)).needsConfirm, false);
  // 写したあと本当に変えたときは、変更ありになる
  assert.equal(C.changedSinceCopy({ onsite: { ...written, notes: "変えた" }, copiedFrom: old }), true);
  // excludeKeys を持たない古い記録は今の一覧で比べる
  const legacy = { caseId: "A", fingerprint: C.copyFingerprint(prev) };
  assert.equal(C.changedSinceCopy({ onsite: prev, copiedFrom: legacy }), false);
});
function newOnsiteFor(prev) { return C.buildCopiedOnsite({ ...SRC_ONSITE, notes: "新しい所感" }, prev, {}); }

t("指紋: キーの順番・false と未入力の違い・除外キーの変更に左右されない", () => {
  const a = { steps: { a: { done: true, memo: "x" }, b: { done: false } }, visitPlace: "office" };
  const b = { visitPlace: "online", steps: { a: { memo: "x", done: true } } };
  assert.equal(C.copyFingerprint(a), C.copyFingerprint(b));
  assert.notEqual(C.copyFingerprint(a), C.copyFingerprint({ steps: { a: { done: true, memo: "y" } } }));
});

t("低-3: 確認の文面に上書き・消去される項目の名前（多いときは先頭3件＋ほか◯件）", () => {
  const labels = { portalReg: "初回利用登録（ポータル）", certInstall: "電子証明書 インストール" };
  assert.equal(C.pathLabel("visitDate"), "訪問日");
  assert.equal(C.pathLabel("notes"), "所感");
  assert.equal(C.pathLabel("steps.portalReg.memo", labels), "初回利用登録（ポータル）のメモ");
  assert.equal(C.pathLabel("steps.certInstall.done", labels), "電子証明書 インストールのチェック");
  const s = C.overwriteConfirmText([{ caseNumber: 13, count: 5,
    paths: ["notes", "steps.certInstall.done", "steps.portalReg.memo", "steps.x.done", "visitDate"] }], labels);
  assert.match(s, /#13: 5件（所感・電子証明書 インストールのチェック・初回利用登録（ポータル）のメモ ほか2件）/);
  assert.match(C.overwriteConfirmText([{ caseNumber: 14, count: 1, paths: ["visitDate"] }]), /#14: 1件（訪問日）/);
});

t("確認の文面: 件数つき。件数0の写し先は出さない", () => {
  const s = C.overwriteConfirmText([{ caseNumber: 13, count: 2 }, { caseNumber: 14, count: 0 }]);
  assert.match(s, /写し先の入力が上書きされます/);
  assert.match(s, /#13: 2件/);
  assert.doesNotMatch(s, /#14/);
  assert.equal(C.overwriteConfirmText([{ caseNumber: 14, count: 0 }]), "");
});

// ===== 写した印 =====
t("写した印: 写し先に「#12 から写した記録（日時・人）」、写し元に「#13・#14 へ写した（日時）」", () => {
  const ms = Date.UTC(2026, 10, 10, 5, 3); // JST 2026-11-10 14:03
  const cf = C.copiedFromRecord({ sourceCaseId: "A", sourceCaseNumber: 12, nowMs: ms, actorName: "練習 太郎", newOnsite });
  assert.equal(C.copiedFromText({ onsite: newOnsite, copiedFrom: cf }), "#12 から写した記録（2026-11-10 14:03・練習 太郎）");
  const edited = { ...newOnsite, notes: "変えた" };
  assert.match(C.copiedFromText({ onsite: edited, copiedFrom: cf }), /写したあと、この案件で変更があります/);
  const to = { B: C.copiedToRecord({ targetCaseNumber: 14, nowMs: ms }), C: C.copiedToRecord({ targetCaseNumber: 13, nowMs: ms }) };
  assert.equal(C.copiedToText({ copiedTo: to }), "#13（2026-11-10 14:03）・#14（2026-11-10 14:03）へ写した");
  assert.equal(C.copiedFromText({}), "");
  assert.equal(C.copiedToText({}), "");
});

// ===== 対応記録 =====
const acts = C.copyActivities({ sourceCaseId: "A", sourceCaseNumber: 12, targets: [{ caseId: "B", caseNumber: 13 }, { caseId: "C", caseNumber: 15 }],
  visitDate: "2026-11-12", userId: "u1", userName: "練習 太郎" });

t("対応記録: 写し元と写し先にそれぞれ1行。refType は確定（onsite）と別の値", () => {
  assert.equal(C.COPY_REF_TYPE, "onsiteCopy");
  assert.equal(acts.source.caseId, "A");
  assert.equal(acts.source.refType, "onsiteCopy");
  assert.equal(acts.source.subject, "当日の記録を #13・#15 へ写した（訪問日 2026-11-12）");
  const tb = acts.target({ caseId: "B", caseNumber: 13 });
  assert.equal(tb.caseId, "B");
  assert.equal(tb.refType, "onsiteCopy");
  assert.equal(tb.copyFromCaseId, "A");
  assert.equal(tb.subject, "#12 から当日の記録を写した（訪問日 2026-11-12）");
  assert.match(tb.body, /写していません/);
});

t("findOnsiteConfirmation は複写の行を「確定済み」と誤認しない（同じ訪問日でも）", () => {
  const rows = [acts.source, acts.target({ caseId: "B", caseNumber: 13 })];
  assert.equal(findOnsiteConfirmation(rows, "2026-11-12"), null);
  // 確定の行が並んでいれば、そちらだけを拾う
  const confirm = onsiteConfirmActivity({ caseId: "A", visitDate: "2026-11-12", summary: { subject: "s", body: "b" } });
  assert.equal(findOnsiteConfirmation([...rows, confirm], "2026-11-12"), confirm);
});

t("対応記録の複写の行から当日タブ（写すカード）を開ける", () => {
  const link = activityRefLink(acts.target({ caseId: "B", caseNumber: 13 }));
  assert.equal(link.tab, "onsite");
  assert.equal(link.anchorId, "sc-copy-card");
  assert.equal(link.fallbackId, "tab-onsite");
});

// ===== 途中で失敗したとき =====
t("結果: 途中で失敗しても、写せた案件と写せなかった案件を両方出す", () => {
  const r = C.copyResultText([{ caseNumber: 13, ok: true }, { caseNumber: 15, ok: false, error: "権限がありません" }]);
  assert.equal(r.allOk, false);
  assert.equal(r.text, "写しました: #13。写せませんでした: #15（権限がありません）");
  assert.equal(C.copyResultText([{ caseNumber: 13, ok: true }]).allOk, true);
  assert.equal(C.copyResultText([{ caseNumber: 13, ok: true }], "x").allOk, false, "写し元の記録の失敗も成功扱いにしない");
  assert.equal(C.copyResultText([]).allOk, false);
});

t("日時の表示は日本時間", () => {
  assert.equal(C.formatJst(Date.UTC(2026, 10, 9, 15, 30)), "2026-11-10 00:30");
  assert.equal(C.formatJst(undefined), "");
});

// ===== 画面への組み込み（ソースの照合）=====
const sc = src("../admin/js/support-checklist.js");
const cd = src("../admin/js/case-detail.js");

t("import している名前が onsite-copy.js から export されている", () => {
  const m = sc.match(/import \{([^}]+)\} from "\.\/onsite-copy\.js"/);
  assert.ok(m, "support-checklist.js が onsite-copy.js を読む");
  for (const name of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
    assert.equal(typeof C[name], "function", `${name} が export されていない`);
  }
});

t("写し先の onsite は丸ごと置き換え（update/set）、写し元には copiedTo だけを足す。cp・performance は書かない", () => {
  const run = sc.slice(sc.indexOf("async function runCopy("), sc.indexOf("const copyOpenBtn")).replace(/\/\/.*$/gm, "");
  assert.match(run, /const payload = \{ onsite: newOnsite, copiedFrom, updatedAt: serverTimestamp\(\) \};/);
  assert.match(run, /tx\.update\(ref, \{ \[`copiedTo\.\$\{p\.t\._id\}`\]/);
  assert.doesNotMatch(run, /performance|evidencePhotos|installStatus/);
  assert.doesNotMatch(run, /refType: "onsite"/);
});

t("未保存の入力（保存中・保存失敗）があるときは写さない", () => {
  const run = sc.slice(sc.indexOf("async function runCopy("), sc.indexOf("const copyOpenBtn"));
  const i = run.indexOf("Promise.allSettled([...pendingSaves])");
  const oc = sc.slice(sc.indexOf("async function onChange("), sc.indexOf("// 証憑写真アップロード"));
  assert.ok(oc.indexOf("const settle = startSave(sec);") < oc.indexOf("await saveSection(sec);"), "入力の変更による保存を見張っている");
  assert.match(oc, /settle\(true\);/);
  assert.match(oc, /settle\(false\);/);
  // 低-4: 見るのは onsite の節だけ。失敗は「後から始めた保存」の成功で解消（順番で判定）。待つのは上限つき
  assert.match(sc, /if \(sec !== "onsite"\) return \(\) => \{\};/);
  assert.match(sc, /const onsiteSaveFailed = \(\) => failedSeq > okSeq;/);
  assert.match(sc, /const SAVE_WAIT_MS = 10000;/);
  assert.match(run, /保存が終わらないため写せません。通信を確かめてください/);
  const j = run.indexOf("if (onsiteSaveFailed())");
  const k = run.indexOf("runTransaction(");
  assert.ok(i > 0 && j > i && k > j);
});

t("確認のあとに写し先が変わっていたら、その案件は写さない（トランザクションの中で指紋を比べる）", () => {
  const run = sc.slice(sc.indexOf("async function runCopy("), sc.indexOf("const copyOpenBtn"));
  assert.match(run, /if \(copyFingerprint\(tdoc && tdoc\.onsite\) !== p\.expected\) throw/);
});

t("閲覧のみの人には写すボタンを出さない（case-detail.js が canEdit を渡す）", () => {
  assert.match(cd, /canEdit: \(\) => canCopy,/);
  assert.match(sc, /閲覧のみの権限では写せません/);
});

console.log(`ok ${n} tests`);
