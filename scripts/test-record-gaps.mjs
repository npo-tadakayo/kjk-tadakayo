// 「記録のずれ」の判定（admin/js/record-gaps.js）と、画面へのつなぎのテスト（設計書 CRM改善_設計書_20261110 §3）。
// node scripts/test-record-gaps.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BILLING_MAIL_KIND_LABEL, billingMailActivityOf, mailRecordFailedText, mailSentNotesOf,
} from "../admin/js/record-gaps.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`NG ${name}`); throw e; }
};

// ===== 点検3: 請求書・領収証・催促のメールを対応記録に残す =====
t("点検3: 案件にひも付く出荷は gmail_sent の記録を作る", () => {
  const a = billingMailActivityOf({
    kind: "invoice", ship: { caseId: "c1", soNumber: "SH-2026-0001" },
    to: "office@example.com", cc: "cc@example.com", subject: "【NPO法人タダカヨ】請求書のご送付（SH-2026-0001）",
    body: "本文", attachments: ["INV-2026-0001.pdf", "", "お振込方法のご案内"],
  });
  assert.equal(a.caseId, "c1");
  assert.equal(a.type, "gmail_sent"); // sendCaseEmail と同じ種類（案件詳細で「Gmail送信」と出る）
  assert.equal(a.subject, "メール送信: 【NPO法人タダカヨ】請求書のご送付（SH-2026-0001）");
  assert.match(a.body, /^宛先: office@example\.com（CC cc@example\.com）\n/);
  assert.match(a.body, /出荷 SH-2026-0001 の請求書をメールで送付/);
  assert.match(a.body, /添付: INV-2026-0001\.pdf・お振込方法のご案内\n\n本文$/); // 空の添付名は落とす
  assert.deepEqual(a.attachmentUrls, []);
});
t("点検3: 案件にひも付かない出荷（認定事業者の受注など）は記録しない", () => {
  assert.equal(billingMailActivityOf({ kind: "receipt", ship: { soNumber: "SH-1" }, to: "a@b.c", subject: "x" }), null);
  assert.equal(billingMailActivityOf({ kind: "receipt", ship: null, to: "a@b.c", subject: "x" }), null);
  assert.equal(billingMailActivityOf(), null);
});
t("点検3: 3種類の表示名と、CC・本文なし", () => {
  assert.deepEqual(Object.keys(BILLING_MAIL_KIND_LABEL).sort(), ["dunning", "invoice", "receipt"]);
  const a = billingMailActivityOf({ kind: "dunning", ship: { caseId: "c", soNumber: "SH-9" }, to: "x@y.z", subject: "催促" });
  assert.equal(a.body, "宛先: x@y.z\n出荷 SH-9 のお支払いのお願い（催促）をメールで送付");
});
t("点検3: 記録だけ失敗したときの文は「送信済み」と「送り直さない」を必ず含む", () => {
  const m = mailRecordFailedText(new Error("permission-denied"));
  assert.match(m, /メールは送信済みです/);
  assert.match(m, /記録だけ失敗/);
  assert.match(m, /permission-denied/);
  assert.match(m, /もう一度送らないでください/);
  assert.doesNotMatch(m, /送信に失敗/); // 送信の失敗と取り違えない
  assert.match(mailRecordFailedText(null), /不明なエラー/);
});
t("点検3: 送付済みの記録は状態を問わず出す（発送済でも出る）", () => {
  for (const status of ["draft", "requested", "shipped", "invoiced", "paid", "canceled", undefined]) {
    const notes = mailSentNotesOf({ status, invoiceMailedAt: "2026-11-10" });
    assert.deepEqual(notes, [{ key: "invoice", text: "請求書をメール送付済み 11-10" }], `状態 ${status}`);
  }
  assert.deepEqual(mailSentNotesOf({ status: "paid", receiptMailedAt: "2026-11-09", dunningSentAt: "2026-11-01", dunningCount: 2 }).map((x) => x.text),
    ["領収証をメール送付済み 11-09", "催促メール送信済み 11-01（2回目）"]);
  assert.deepEqual(mailSentNotesOf({ dunningSentAt: "2026-11-01", dunningCount: 1 }).map((x) => x.text), ["催促メール送信済み 11-01"]);
  assert.deepEqual(mailSentNotesOf({ status: "shipped" }), []);
  assert.deepEqual(mailSentNotesOf(null), []);
});
t("点検3: 画面のつなぎ（supply-print.js・supply.js）", () => {
  const sp = read("admin/js/supply-print.js");
  assert.match(sp, /import \{ billingMailActivityOf, mailRecordFailedText \} from "\/js\/record-gaps\.js"/);
  assert.match(sp, /addDoc, serverTimestamp \} from "\/js\/fs\.js"/);
  // 送信の直後・送付の知らせより前に記録し、失敗は知らせに添える（catch の「送信に失敗しました」に落とさない）
  const send = sp.indexOf("await sendPartnerMailFn(");
  const log = sp.indexOf("await logBillingMailActivity(d, kind");
  const done = sp.indexOf("へ送付しました`");
  assert.ok(send > 0 && log > send && done > log, "送信 → 記録 → 送付の知らせ の順になっていない");
  const fn = sp.slice(sp.indexOf("async function logBillingMailActivity"), sp.indexOf("async function afterInvoiceMailed"));
  assert.match(fn, /try\{/);
  assert.match(fn, /catch\(e\)\{[\s\S]*return mailRecordFailedText\(e\)/);
  const su = read("admin/js/supply.js");
  assert.match(su, /import \{ billingMailActivityOf, mailRecordFailedText, mailSentNotesOf \} from "\/js\/record-gaps\.js"/);
  const dun = su.slice(su.indexOf("async function sendDunning"), su.indexOf("// ===== 請求済にする＋経理へ"));
  assert.match(dun, /billingMailActivityOf\(\{ kind:"dunning"/);
  assert.match(dun, /catch\(e2\)\{[\s\S]*mailRecordFailedText\(e2\)/); // 記録の失敗は内側で受ける
  assert.match(su, /payInfo \+= mailSentNotesOf\(s\)/);
  assert.doesNotMatch(su, /s\.invoiceMailedAt \? `<div/); // 請求済・入金済の中だけに出していた古い表示は残さない
});

console.log(`OK test-record-gaps: ${n} 件合格`);
