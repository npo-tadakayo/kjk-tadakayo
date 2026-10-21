// 画面の結線（波2b）の判定（admin/js/screen-rules.js）のテスト。node scripts/test-screen-wiring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CASE_DONE, isCompleting, completionConfirmText, completionActivityNote,
  caseDuplicateBanner, preShipCountAfterMerge,
  todayYmdJst, receivedDateError, ACCEPT_CHANNELS, PAY_METHODS,
  buildGroupChoices, buildAcceptPayload, summarizeAcceptResult, dailyPreviewBlocks, acceptMailTo,
} from "../admin/js/screen-rules.js";
import { STATUS_LABELS, TERMINAL } from "../admin/js/constants.js";
import { completionWarnings } from "../admin/js/case-complete-check.js";

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); throw e; }
};

// ---- 完了(13) ----
t("CASE_DONE は constants.js の「案件完了」と一致", () => {
  assert.equal(STATUS_LABELS[CASE_DONE], "案件完了");
  assert.ok(TERMINAL.includes(CASE_DONE));
});

t("13 にするかの判定（文字列のセレクト値でもよい）", () => {
  assert.equal(isCompleting(12, 13), true);
  assert.equal(isCompleting(1, "13"), true);
  assert.equal(isCompleting("3", 13), true);
  assert.equal(isCompleting(13, 13), false);     // 13 のまま
  assert.equal(isCompleting(13, 12), false);     // 13 から外す
  assert.equal(isCompleting(undefined, 13), true);
  assert.equal(isCompleting(12, 4), false);
});

t("確認ダイアログの本文と活動の1行", () => {
  assert.equal(completionConfirmText([]), "");
  assert.equal(completionConfirmText(undefined), "");
  assert.equal(completionActivityNote([]), "");
  const ws = ["出荷の記録がありません", "助成金の申請日が入っていません"];
  const msg = completionConfirmText(ws);
  assert.ok(msg.includes("・出荷の記録がありません\n・助成金の申請日が入っていません"));
  assert.ok(msg.endsWith("\n\nこのまま完了にしますか？"));
  assert.equal(completionActivityNote(ws), "警告を確認のうえ完了: 出荷の記録がありません／助成金の申請日が入っていません");
});

t("波1の completionWarnings と組み合わせて動く（出荷なし・申請情報なし）", () => {
  const ws = completionWarnings({ shipments: [], subsidy: null });
  assert.ok(ws.length >= 2);
  assert.ok(completionConfirmText(ws).length > 0);
  assert.ok(completionActivityNote(ws).startsWith("警告を確認のうえ完了: "));
});

// ---- 出荷の重複の帯 ----
const S = (id, status, soNumber, caseId = "C1") => ({ _id: id, caseId, status, soNumber });
t("下書き・依頼済が2件以上で帯を出す（残す候補は cases.shipmentId）", () => {
  const ships = [S("a", "draft", "SH-2"), S("b", "requested", "SH-1"), S("c", "shipped", "SH-3"), S("d", "canceled", "SH-4")];
  const b = caseDuplicateBanner(ships, "C1", "a");
  assert.deepEqual(b, { count: 2, soNumbers: ["SH-1", "SH-2"], keepSo: "SH-2" });
  assert.equal(caseDuplicateBanner(ships, "C1", "zzz").keepSo, null);
  assert.equal(caseDuplicateBanner(ships, "C1", null).keepSo, null);
});
t("1件だけ・発送済だけなら帯なし", () => {
  assert.equal(caseDuplicateBanner([S("a", "draft", "SH-1"), S("b", "shipped", "SH-2")], "C1", "a"), null);
  assert.equal(caseDuplicateBanner([], "C1", null), null);
  assert.equal(caseDuplicateBanner(undefined, "C1", null), null);
});
t("caseId が欠けた出荷もこの案件の出荷として数える", () => {
  const ships = [{ _id: "a", status: "draft", soNumber: "SH-1" }, { _id: "b", status: "draft", soNumber: "SH-2" }];
  assert.equal(caseDuplicateBanner(ships, "C9", null).count, 2);
});
t("統合後の未発送の件数", () => {
  assert.equal(preShipCountAfterMerge([S("a", "draft")], [S("b", "draft")]), 2);
  assert.equal(preShipCountAfterMerge([S("a", "draft")], [S("b", "shipped"), S("c", "canceled")]), 1);
  assert.equal(preShipCountAfterMerge([S("a", "requested")], [S("b", "draft")]), 2);
  assert.equal(preShipCountAfterMerge(undefined, undefined), 0);
});

// ---- 受注確定 ----
t("今日（JST）", () => {
  assert.equal(todayYmdJst(new Date("2026-10-21T14:59:00Z")), "2026-10-21");
  assert.equal(todayYmdJst(new Date("2026-10-21T15:00:00Z")), "2026-10-22"); // JST 0時で日付が変わる
});
t("受付日の検査（未来は不可・存在しない日は不可）", () => {
  assert.equal(receivedDateError("2026-10-21", "2026-10-21"), "");
  assert.equal(receivedDateError("2026-10-01", "2026-10-21"), "");
  assert.match(receivedDateError("2026-10-22", "2026-10-21"), /未来/);
  assert.match(receivedDateError("", "2026-10-21"), /入れて/);
  assert.match(receivedDateError("2026-02-30", "2026-10-21"), /正しく/);
  assert.match(receivedDateError("2026/10/01", "2026-10-21"), /正しく/);
});
t("受付方法・支払方法のコード値はサーバと同じ", () => {
  assert.deepEqual(ACCEPT_CHANNELS.map((c) => c.value), ["phone", "email", "fax", "other"]);
  assert.deepEqual(PAY_METHODS.map((p) => p.value), ["after", "before"]);
});

const Q = (id, caseId, version, status, extra = {}) => ({ _id: id, caseId, version, status, officeName: `事業所${caseId}`, estNo: `EST-${caseId}`, ...extra });
t("同じグループのチェック一覧（案件ごとの最新版が issued のものだけ・自分は除く・既定オン）", () => {
  const gq = [
    Q("q1", "A", 1, "issued", { groupIndex: 0 }),           // 自分
    Q("q2", "B", 1, "superseded", { groupIndex: 1 }),
    Q("q3", "B", 2, "issued", { groupIndex: 1 }),           // B の最新 → 出す
    Q("q4", "C", 1, "accepted", { groupIndex: 2 }),         // 受理済み → 出さない
    Q("q5", "D", 1, "issued", { groupIndex: 3 }),
    Q("q6", "D", 2, "expired", { groupIndex: 3 }),          // D の最新は期限切れ → 出さない
    Q("q7", "E", 1, "issued", { groupIndex: 4 }),
  ];
  const r = buildGroupChoices(gq, { _id: "q1", caseId: "A" });
  assert.deepEqual(r.map((x) => x.quoteId), ["q3", "q7"]);
  assert.ok(r.every((x) => x.checked === true));
  assert.equal(r[0].label, "事業所B（EST-B v2）");
  assert.equal(r[0].caseId, "B");
  assert.deepEqual(buildGroupChoices([], { _id: "q1", caseId: "A" }), []);
  assert.deepEqual(buildGroupChoices(undefined, null), []);
});
t("同じ案件の別の版は出さない（自分の案件は対象外）", () => {
  const r = buildGroupChoices([Q("x1", "A", 3, "issued"), Q("x2", "A", 2, "superseded")], { _id: "zz", caseId: "A" });
  assert.deepEqual(r, []);
});

t("送る値の組み立てと検査", () => {
  const base = {
    quoteId: "q1", acceptedName: "  山田 花子 ", channel: "phone", receivedDate: "2026-10-20",
    payMethod: "before", preferredDate: "2026-11-01", note: " メモ ", sendMail: true,
    groupQuoteIds: ["q3", "q1", "q3", "", "q7"],
  };
  const { payload, error } = buildAcceptPayload(base, "2026-10-21");
  assert.equal(error, undefined);
  assert.deepEqual(payload, {
    quoteId: "q1", acceptedName: "山田 花子", channel: "phone", receivedDate: "2026-10-20",
    payMethod: "before", preferredDate: "2026-11-01", note: "メモ", sendMail: true,
    groupQuoteIds: ["q3", "q7"],   // 自分・重複・空は除く
  });
  assert.equal(buildAcceptPayload({ ...base, payMethod: "x" }, "2026-10-21").payload.payMethod, "after");
  assert.equal(buildAcceptPayload({ ...base, preferredDate: "" }, "2026-10-21").payload.preferredDate, "");
  assert.equal(buildAcceptPayload({ ...base, groupQuoteIds: undefined }, "2026-10-21").payload.groupQuoteIds.length, 0);
  assert.match(buildAcceptPayload({ ...base, acceptedName: "  " }, "2026-10-21").error, /お名前/);
  assert.match(buildAcceptPayload({ ...base, channel: "line" }, "2026-10-21").error, /受付方法/);
  assert.match(buildAcceptPayload({ ...base, receivedDate: "2026-10-22" }, "2026-10-21").error, /未来/);
  assert.match(buildAcceptPayload({ ...base, preferredDate: "11/1" }, "2026-10-21").error, /希望日/);
  assert.equal(buildAcceptPayload({ ...base, acceptedName: "あ".repeat(150) }, "2026-10-21").payload.acceptedName.length, 100);
});

t("サーバの戻り値の要約", () => {
  const ok = summarizeAcceptResult({ ok: true, results: [{ quoteId: "q1", shipmentId: "s1", soNumber: "SH-2026-0100" }], partial: false, errors: [] });
  assert.deepEqual(ok, { ok: true, partial: false, soNumbers: ["SH-2026-0100"], errors: [], mail: "off", mailWarning: "" });
  const part = summarizeAcceptResult({ ok: true, results: [{ soNumber: "SH-1" }], partial: true,
    errors: [{ quoteId: "q3", message: "期限切れ" }, "文字列のエラー"] });
  assert.equal(part.ok, true);
  assert.equal(part.partial, true);
  assert.deepEqual(part.errors, ["q3: 期限切れ", "文字列のエラー"]);
  const ng = summarizeAcceptResult({ ok: false, results: [], errors: [{ code: "expired" }] });
  assert.equal(ng.ok, false);
  assert.deepEqual(ng.errors, ["expired"]);
  assert.equal(summarizeAcceptResult(undefined).ok, false);
  // partial が無くても、成功とエラーが混在すれば一部失敗として扱う
  assert.equal(summarizeAcceptResult({ ok: true, results: [{ soNumber: "SH-1" }], errors: ["x"] }).partial, true);
});

// ---- 日次まとめのプレビュー ----
t("プレビューの表示ブロック", () => {
  const b = dailyPreviewBlocks({ overall: "全体の本文", assignees: [
    { email: "a@tadakayo.jp", name: "山田", text: "山田さんの本文" },
    { email: "b@tadakayo.jp", name: "", text: "" },
  ] });
  assert.equal(b.length, 3);
  assert.equal(b[0].text, "全体の本文");
  assert.equal(b[0].empty, false);
  assert.equal(b[1].title, "担当: 山田（a@tadakayo.jp）");
  assert.equal(b[2].title, "担当: b@tadakayo.jp");
  assert.equal(b[2].empty, true);
  const none = dailyPreviewBlocks({ overall: null, assignees: [] });
  assert.equal(none.length, 2);
  assert.ok(none.every((x) => x.empty));
  assert.equal(dailyPreviewBlocks(undefined).length, 2);
});

// ---- 受注確定の確認メールの結果（2026-10-21 レビュー指摘）----
t("確認メールの結果（送った・送れなかった・送らない）", () => {
  const base = { ok: true, results: [{ soNumber: "SH-1" }], errors: [] };
  const sent = summarizeAcceptResult({ ...base, mailed: true, mailError: null }, { sendMail: true });
  assert.equal(sent.mail, "sent");
  assert.equal(sent.mailWarning, "");
  const failed = summarizeAcceptResult({ ...base, mailed: false, mailError: "invalid_grant" }, { sendMail: true });
  assert.equal(failed.ok, true);
  assert.equal(failed.mail, "failed");
  assert.equal(failed.mailWarning, "受注確定は済みました。確認メールは送れませんでした（invalid_grant）。案件のメール送信から送ってください");
  // 送る指定なのにサーバ側で宛先が無かった（mailError なし）
  assert.match(summarizeAcceptResult({ ...base, mailed: false }, { sendMail: true }).mailWarning, /送れませんでした（宛先のメールアドレスがありません）/);
  // 送る指定なし → 何も出さない
  assert.equal(summarizeAcceptResult({ ...base, mailed: false }, { sendMail: false }).mail, "off");
  assert.equal(summarizeAcceptResult({ ...base, mailed: false }).mail, "off");
  // 確定できなかったときはメールの警告を出さない
  assert.equal(summarizeAcceptResult({ ok: false, results: [], errors: ["x"], mailed: false }, { sendMail: true }).mail, "off");
});

t("確認メールの宛先（案件 → 見積もり・サーバと同じ規則）", () => {
  assert.equal(acceptMailTo("case@example.com", "q@example.com"), "case@example.com");
  assert.equal(acceptMailTo("", "q@example.com"), "q@example.com");
  assert.equal(acceptMailTo(" 不正な値 ", " q@example.com "), "q@example.com");
  assert.equal(acceptMailTo(undefined, null), "");
  // サーバ（functions/accept-flow.js）と同じ結果になる
  const src = readFileSync(fileURLToPath(new URL("../functions/accept-flow.js", import.meta.url)), "utf8");
  assert.match(src, /function acceptMailTo\(caseEmail, quoteEmail\)/);
});

t("quote-admin.js のつなぎ（確認メールの結果・宛先・グループの一覧）", () => {
  const src = readFileSync(fileURLToPath(new URL("../admin/js/quote-admin.js", import.meta.url)), "utf8");
  assert.match(src, /summarizeAcceptResult, acceptMailTo \} from "\/js\/screen-rules\.js"/);
  assert.match(src, /summarizeAcceptResult\(r\.data, \{ sendMail: built\.payload\.sendMail \}\)/);
  assert.match(src, /acceptMailTo\(kase\?\.contactEmail, q\.contactEmail\)/);
  assert.match(src, /sum\.mail === "failed"/);
  assert.match(src, /esc\(sum\.mailWarning\)/);
  // グループの一覧は選んだ見積もりの groupId だけで引く（案件の quoteGroupId は使わない）
  const lg = src.slice(src.indexOf("async function loadGroupChoices"), src.indexOf("async function openAccept"));
  assert.match(lg, /const gid = q\.groupId \|\| "";/);
  assert.doesNotMatch(lg, /quoteGroupId/);
  const oa = src.slice(src.indexOf("async function openAccept"), src.indexOf("function closeAccept"));
  assert.match(oa, /if \(q\.groupId\) \{/);
  assert.doesNotMatch(oa, /quoteGroupId/);
});

t("analytics.js の「今すぐ更新」は管理者だけ", () => {
  const js = readFileSync(fileURLToPath(new URL("../admin/js/analytics.js", import.meta.url)), "utf8");
  const html = readFileSync(fileURLToPath(new URL("../admin/analytics.html", import.meta.url)), "utf8");
  assert.match(html, /id="refreshBtn" type="button" style="display:none"/);
  assert.match(js, /if \(myRole\.role === "admin"\) \{\n\s+refreshBtn\.style\.display = "";\n\s+refreshBtn\.addEventListener/);
  assert.match(js, /refreshBtn\.remove\(\)/);
});

t("案件詳細の重複候補が未定義の変数を見ない（kase → currentCase・2026-10-21 E2E で発見）", () => {
  const cd = readFileSync(new URL("../admin/js/case-detail.js", import.meta.url), "utf8");
  const fn = cd.slice(cd.indexOf("async function loadDuplicateCandidates"), cd.indexOf("// ===== 統合（重複案件のマージ）"));
  assert.ok(fn.length > 100);
  assert.ok(!/\bkase\b/.test(fn.replace(/\/\/.*$/gm, "")), "loadDuplicateCandidates に未定義の kase が残っている");
  assert.match(fn, /currentCase\?\.quoteGroupId/);
  // case-detail.js 全体でも kase を宣言していない（使えば ReferenceError）
  assert.ok(!/\b(?:let|const|var)\s+kase\b/.test(cd));
  assert.ok(!/\bkase\b/.test(cd.replace(/\/\/.*$/gm, "")), "case-detail.js に kase が残っている");
});

console.log(`test-screen-wiring: ${n} 件 OK`);
