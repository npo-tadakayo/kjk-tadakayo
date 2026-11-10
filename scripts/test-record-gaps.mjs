// 「記録のずれ」の判定（admin/js/record-gaps.js）と、画面へのつなぎのテスト（設計書 CRM改善_設計書_20261110 §3）。
// node scripts/test-record-gaps.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BILLING_MAIL_KIND_LABEL, billingMailActivityOf, mailRecordFailedText, mailSentNotesOf,
  receiptSaveInfoOf, prepaidNoteOf, ymdJstOf, quoteMailNotesOf,
  ORDER_CONFIRMED_STATUS, ORDERED_AT_FILLED_NOTE, orderedAtFillNeeded,
} from "../admin/js/record-gaps.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
let n = 0;
// ソースの照合は、外れたときにファイル全体を出さない（assert.match は入力を丸ごと表示する）
const has = (src, re, msg) => assert.ok(re.test(src), msg || `見つからない: ${re}`);
const hasNot = (src, re, msg) => assert.ok(!re.test(src), msg || `残っている: ${re}`);
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
  has(sp, /import \{ billingMailActivityOf, mailRecordFailedText[^}]*\} from "\/js\/record-gaps\.js"/);
  has(sp, /addDoc, serverTimestamp \} from "\/js\/fs\.js"/);
  // 送信の直後・送付の知らせより前に記録し、失敗は知らせに添える（catch の「送信に失敗しました」に落とさない）
  const send = sp.indexOf("await sendPartnerMailFn(");
  const log = sp.indexOf("await logBillingMailActivity(d, kind");
  const done = sp.indexOf("へ送付しました`");
  assert.ok(send > 0 && log > send && done > log, "送信 → 記録 → 送付の知らせ の順になっていない");
  const fn = sp.slice(sp.indexOf("async function logBillingMailActivity"), sp.indexOf("async function afterInvoiceMailed"));
  has(fn, /try\{/);
  has(fn, /catch\(e\)\{[\s\S]*return mailRecordFailedText\(e\)/);
  const su = read("admin/js/supply.js");
  has(su, /import \{ billingMailActivityOf, mailRecordFailedText, mailSentNotesOf[^}]*\} from "\/js\/record-gaps\.js"/);
  const dun = su.slice(su.indexOf("async function sendDunning"), su.indexOf("// ===== 請求済にする＋経理へ"));
  has(dun, /billingMailActivityOf\(\{ kind:"dunning"/);
  has(dun, /catch\(e2\)\{[\s\S]*mailRecordFailedText\(e2\)/); // 記録の失敗は内側で受ける
  has(su, /payInfo \+= mailSentNotesOf\(s, /);
  hasNot(su, /s\.invoiceMailedAt \? `<div/); // 請求済・入金済の中だけに出していた古い表示は残さない
});

// ===== 点検11: 領収証を送って「キャンセル」した出荷に「送付済み・記録待ち」 =====
t("点検11: 送付済み・未記録は「領収証 送付済み・記録待ち」", () => {
  const s = { status: "paid", receiptMailedAt: "2026-11-10", receiptMailedTo: "office@example.com" };
  assert.equal(receiptSaveInfoOf(s),
    "領収証 送付済み・記録待ち（2026-11-10 に office@example.com へ送付）。「発行を記録」で記録してください");
  assert.match(receiptSaveInfoOf({ status: "paid", receiptMailedAt: "2026-11-10" }), /2026-11-10 に送付）/);
});
t("点検11: 発行済みは「発行済」、キャンセル・未送付は何も出さない", () => {
  assert.equal(receiptSaveInfoOf({ status: "paid", receiptMailedAt: "2026-11-10", receiptIssuedAt: "2026-11-09", receiptNo: "RCPT-2026-0001" }),
    "発行済 2026-11-09（RCPT-2026-0001）");
  assert.equal(receiptSaveInfoOf({ status: "canceled", receiptMailedAt: "2026-11-10" }), "");
  assert.equal(receiptSaveInfoOf({ status: "paid" }), "");
  assert.equal(receiptSaveInfoOf(null), "");
});
t("点検11: 領収証ページのつなぎ（読み込み時と、送信後の確認でキャンセルしたとき）", () => {
  const sp = read("admin/js/supply-print.js");
  has(sp, /receiptSaveInfoOf \} from "\/js\/record-gaps\.js"/);
  const after = sp.slice(sp.indexOf('if(kind === "receipt" && issueSnap)'), sp.indexOf("// 請求書を送ったら、請求済として記録するか確認する"));
  has(after, /if\(!d\.receiptIssuedAt\) showReceiptSaveInfo\(d\)/);
  const load = sp.slice(sp.indexOf('const saveBtn=document.getElementById("rcptSaveBtn")'));
  has(load, /showReceiptSaveInfo\(d\);\s*saveBtn\.addEventListener/);
});

// ===== 点検12: 請求前に入金を記録した出荷でも一覧の行に入金を出す（表示だけ） =====
t("点検12: 発送済で入金があれば出す", () => {
  const p = prepaidNoteOf({ status: "shipped", payments: [{ amount: 30000, date: "2026-11-08" }] });
  assert.equal(p.net, 30000);
  assert.equal(p.text, "入金済 ¥30,000（請求前に記録・2026-11-08）");
  const p2 = prepaidNoteOf({ status: "requested", payments: [{ amount: 10000, date: "2026-11-01" }, { amount: 5000, date: "2026-11-05" }], refunds: [{ amount: 2000 }] });
  assert.equal(p2.text, "入金済 ¥13,000（請求前に記録・2026-11-05・2回・返金差引後）");
  // 旧形式（paymentAmount/paidAt）も読む（ship-flow.js の paymentsOf と同じ）
  assert.equal(prepaidNoteOf({ status: "draft", paymentAmount: 500, paidAt: "2026-10-01" }).text, "入金済 ¥500（請求前に記録・2026-10-01）");
  // 状態が未設定の古い出荷は発送済扱い
  assert.ok(prepaidNoteOf({ payments: [{ amount: 1, date: "" }] }));
  assert.equal(prepaidNoteOf({ payments: [{ amount: 1, date: "" }] }).text, "入金済 ¥1（請求前に記録）");
});
t("点検12: 請求済・入金済は従来の表示のまま（null）、入金なしも null", () => {
  assert.equal(prepaidNoteOf({ status: "invoiced", payments: [{ amount: 1 }] }), null);
  assert.equal(prepaidNoteOf({ status: "paid", payments: [{ amount: 1 }] }), null);
  assert.equal(prepaidNoteOf({ status: "shipped" }), null);
  assert.equal(prepaidNoteOf({ status: "shipped", payments: [] }), null);
  assert.equal(prepaidNoteOf(null), null);
});
t("点検12: 入力の出荷を書き換えない（表示だけ）・画面のつなぎ", () => {
  const s = { status: "shipped", payments: [{ amount: 100, date: "2026-11-01" }] };
  const before = JSON.stringify(s);
  prepaidNoteOf(s);
  assert.equal(JSON.stringify(s), before);
  const su = read("admin/js/supply.js");
  has(su, /const pre = prepaidNoteOf\(s\);\s*if\(pre\) payInfo \+=/);
});

// ===== 点検8: 見積もりの「ご案内メール」の送信記録を一覧に出す =====
// 2026-11-09 15:30 UTC = 2026-11-10 00:30 JST（日本時間で日付を出す）
const ts = (iso) => ({ toDate: () => new Date(iso) });
t("点検8: ご案内メールと見積書PDFの送付を出す（日本時間の日付）", () => {
  const notes = quoteMailNotesOf({
    noticeMailedAt: ts("2026-11-09T15:30:00Z"), noticeMailedTo: "office@example.com",
    mailedAt: ts("2026-11-10T01:00:00Z"), mailedTo: "office@example.com",
  });
  assert.deepEqual(notes.map((x) => x.text), [
    "ご案内メール送信 2026-11-10（office@example.com）",
    "見積書PDFを送付 2026-11-10（office@example.com）",
  ]);
});
t("点検8: 送っていない版は何も出さない・PDFの失敗は警告で出す", () => {
  assert.deepEqual(quoteMailNotesOf({ mailedAt: null, noticeMailedAt: null }), []);
  assert.deepEqual(quoteMailNotesOf(null), []);
  const e = quoteMailNotesOf({ mailError: "Gmail送信に失敗しました（403）" });
  assert.equal(e.length, 1);
  assert.equal(e[0].warn, true);
  assert.equal(e[0].text, "見積書PDFの送付に失敗（Gmail送信に失敗しました（403））");
  // 送れていれば以前の失敗は出さない
  assert.deepEqual(quoteMailNotesOf({ mailedAt: ts("2026-11-10T01:00:00Z"), mailError: "x" }).map((x) => x.key), ["pdf"]);
});
t("点検8: 日付の読み取り（Timestamp・Date・ミリ秒・{seconds}・不正）", () => {
  assert.equal(ymdJstOf(new Date("2026-11-09T15:30:00Z")), "2026-11-10");
  assert.equal(ymdJstOf(Date.parse("2026-11-09T14:59:00Z")), "2026-11-09");
  assert.equal(ymdJstOf({ seconds: Date.parse("2026-11-09T15:00:00Z") / 1000 }), "2026-11-10");
  assert.equal(ymdJstOf("not a date"), "");
  assert.equal(ymdJstOf(null), "");
  assert.equal(quoteMailNotesOf({ noticeMailedAt: "x" })[0].text, "ご案内メール送信 日付不明");
});
t("点検8: 見積もり一覧（quote-admin.js）のつなぎ", () => {
  const qa = read("admin/js/quote-admin.js");
  has(qa, /import \{ quoteMailNotesOf \} from "\/js\/record-gaps\.js"/);
  has(qa, /\$\{mailNotesLine\(q\)\}/);
});

// ===== 点検10: 手で「受注確定」にしたとき受注日を補う =====
t("点検10: 受注日が無い案件を 3 にしたときだけ補う", () => {
  assert.equal(ORDER_CONFIRMED_STATUS, 3);
  assert.equal(orderedAtFillNeeded(2, 3, { status: 2 }), true);
  assert.equal(orderedAtFillNeeded(1, "3", {}), true);       // セレクトの値は文字列
  assert.equal(orderedAtFillNeeded(4, 3, null), true);       // 失注から戻した
  assert.equal(orderedAtFillNeeded(2, 3, { orderedAt: { seconds: 1 } }), false); // すでにある（上書きしない）
  assert.equal(orderedAtFillNeeded(3, 3, {}), false);        // 3 のまま
  assert.equal(orderedAtFillNeeded(2, 5, {}), false);        // 受注確定以外は触らない
  assert.equal(orderedAtFillNeeded(3, 13, {}), false);
});
t("点検10: 案件詳細・カンバンのつなぎ（受注日を書く・対応記録に一言）", () => {
  const cd = read("admin/js/case-detail.js");
  has(cd, /import \{ orderedAtFillNeeded, ORDERED_AT_FILLED_NOTE \} from "\/js\/record-gaps\.js"/);
  has(cd, /const fillOrderedAt = orderedAtFillNeeded\(currentCase\?\.status, newStatus, currentCase\);\s*if \(fillOrderedAt\) patch\.orderedAt = serverTimestamp\(\);/);
  has(cd, /fillOrderedAt \? ORDERED_AT_FILLED_NOTE/);
  has(cd, /if \(fillOrderedAt && currentCase\) currentCase\.orderedAt = new Date\(\);/);
  const kb = read("admin/js/kanban.js");
  has(kb, /const fillOrderedAt = orderedAtFillNeeded\(prev, newStatus, c\);\s*if \(fillOrderedAt\) patch\.orderedAt = serverTimestamp\(\);/);
  has(kb, /ORDERED_AT_FILLED_NOTE/);
  assert.match(ORDERED_AT_FILLED_NOTE, /受注日/);
  // 既存データの一括補正や本番への書き込みスクリプトは作らない
  hasNot(read("admin/js/record-gaps.js"), /updateDoc|setDoc|writeBatch|getDocs/);
});

// ===== 点検7: 練習モードの代役（practice-stubs.js）を本番（functions/index.js）にそろえる =====
// 代役はブラウザ用（firebase の CDN を import する）なので node では読み込めない。ソースを読んで照らし合わせる
const objLiteral = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`));
  assert.ok(m, `${name} が見つからない`);
  return Function(`"use strict"; return (${m[1]});`)();
};
const fnBody = (src, head, next) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `見つからない: ${head}`);
  const j = src.indexOf(next, i + head.length);
  return src.slice(i, j < 0 ? undefined : j);
};
t("点検7: 受注確定で作る出荷の下書きの品名・つなぎ方が本番と同じ", () => {
  const fn = read("functions/index.js");
  const ps = read("admin/js/practice-stubs.js");
  assert.deepEqual(objLiteral(ps, "PRODUCT_NAMES"), objLiteral(fn, "PRODUCT_NAMES"));
  assert.deepEqual(objLiteral(ps, "CONNECTION_LABELS"), objLiteral(fn, "CONNECTION_LABELS"));
  const items = fnBody(ps, "function shipmentItemsFromQuote(P, q)", "\n}\n");
  has(items, /const NAMES = PRODUCT_NAMES;/);
  hasNot(items, /BT_LABEL|USB_LABEL/); // 見積の表示名を下書きの品名に使わない
});
t("点検7: 倉庫で発送済・受け渡し済にしたとき、受注も出荷済にする（本番と同じ）", () => {
  const fn = read("functions/index.js");
  const real = fnBody(fn, "async function warehouseComplete(", "\n}\n");
  has(real, /if \(po && po\.exists\) tx\.update\(po\.ref, \{ status: "shipped"/);
  const ps = read("admin/js/practice-stubs.js");
  const wh = fnBody(ps, "async function whMarkShipped(", "\n}\n");
  has(wh, /const po = cur\.partnerOrderId \? await tx\.get\(doc\(db\(\), "partnerOrders"/);
  has(wh, /if \(po && po\.exists\(\)\) tx\.update\(po\.ref, \{ status: "shipped"/);
  // 読み取り（tx.get）は書き込み（tx.update）より前
  assert.ok(wh.indexOf('"partnerOrders"') < wh.indexOf("tx.update(ref"), "受注の読み取りが書き込みの後にある");
});
t("点検7: 倉庫の発送済・受け渡し済は、本番と同じく対応記録を書かない", () => {
  const fn = read("functions/index.js");
  for (const name of ["warehouseShip", "warehouseHandover"]) {
    const real = fnBody(fn, `exports.${name} = onCall(`, "\n);\n");
    hasNot(real, /activities/, `本番の ${name} が対応記録を書くようになった。練習もそろえること`);
  }
  hasNot(fnBody(fn, "async function warehouseComplete(", "\n}\n"), /activities/);
  const ps = read("admin/js/practice-stubs.js");
  for (const name of ["warehouseShip", "warehouseHandover"]) {
    const stub = fnBody(ps, `  async ${name}(`, "\n  },\n");
    hasNot(stub, /await activity\(/, `練習の ${name} が対応記録を書いている`);
  }
});

// ===== PR #62 独立レビューの指摘への対応（2026-11-10） =====
t("指摘1: キャンセル済み・全額返金は出さない、一部返金は差引額で出す", () => {
  assert.equal(prepaidNoteOf({ status: "canceled", payments: [{ amount: 1000, date: "2026-11-01" }], refunds: [{ amount: 1000 }] }), null);
  assert.equal(prepaidNoteOf({ status: "canceled", payments: [{ amount: 1000, date: "2026-11-01" }] }), null);
  assert.equal(prepaidNoteOf({ status: "shipped", payments: [{ amount: 1000, date: "2026-11-01" }], refunds: [{ amount: 1000 }] }), null);
  assert.equal(prepaidNoteOf({ status: "shipped", payments: [{ amount: 1000 }], refunds: [{ amount: 1500 }] }), null); // 差引マイナス
  const p = prepaidNoteOf({ status: "shipped", payments: [{ amount: 1000, date: "2026-11-01" }], refunds: [{ amount: 300 }] });
  assert.equal(p.net, 700);
  assert.equal(p.text, "入金済 ¥700（請求前に記録・2026-11-01・返金差引後）");
});
t("指摘1: 渡した出荷のオブジェクトを書き換えない（入金・返金・状態に触らない）", () => {
  const cases = [
    { status: "canceled", payments: [{ amount: 1000, date: "2026-11-01" }], refunds: [{ amount: 1000 }] },
    { status: "shipped", payments: [{ amount: 1000, date: "2026-11-01" }], refunds: [{ amount: 300 }] },
    { status: "invoiced", payments: [{ amount: 1 }], dunningSentAt: "2026-11-01" },
  ];
  for (const s of cases) {
    const before = JSON.stringify(s);
    prepaidNoteOf(s); mailSentNotesOf(s); mailSentNotesOf(s, { dunningOnButton: true });
    assert.equal(JSON.stringify(s), before);
  }
});
t("指摘3: 催促ボタンに日付が出ている行では、催促の行を出さない（二重にしない）", () => {
  const s = { status: "invoiced", invoiceMailedAt: "2026-10-20", dunningSentAt: "2026-11-05", dunningCount: 1 };
  assert.deepEqual(mailSentNotesOf(s, { dunningOnButton: true }).map((x) => x.key), ["invoice"]);
  assert.deepEqual(mailSentNotesOf(s).map((x) => x.key), ["invoice", "dunning"]); // ボタンが出ない行（入金済など）では出す
  const su = read("admin/js/supply.js");
  has(su, /const dunningOnButton = st==="invoiced" && od>0 && !!s\.dunningSentAt;\s*payInfo \+= mailSentNotesOf\(s, \{ dunningOnButton \}\)/);
  // ボタンの表示条件（請求済の分岐の中で od>0）と合っていること
  has(su, /\(od>0\?`<button class="btn btn-secondary dun-ship"[^\n]*s\.dunningSentAt\?`（/);
});
t("指摘2: 対応記録のあと cases.updatedAt だけを更新し、失敗は記録の成否にしない", () => {
  const sp = read("admin/js/supply-print.js");
  const fn = sp.slice(sp.indexOf("async function logBillingMailActivity"), sp.indexOf("async function afterInvoiceMailed"));
  has(fn, /try\{ await updateDoc\(doc\(db,"cases",act\.caseId\), \{ updatedAt: serverTimestamp\(\) \}\); \}\s*catch\(e2\)/);
  const su = read("admin/js/supply.js");
  const dun = su.slice(su.indexOf("async function sendDunning"), su.indexOf("// ===== 請求済にする＋経理へ"));
  has(dun, /try\{ await updateDoc\(doc\(db,"cases",act\.caseId\),\{ updatedAt:serverTimestamp\(\) \}\); \}\s*catch\(e3\)/);
  for (const src of [fn, dun]) hasNot(src, /updateDoc\(doc\(db,"cases"[^)]*\),\s*\{[^}]*\b(?!updatedAt)\w+:/, "cases に updatedAt 以外を書いている");
});

console.log(`OK test-record-gaps: ${n} 件合格`);
