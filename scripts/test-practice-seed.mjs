// 練習DB（practice）の架空データと初期化処理の検査。node scripts/test-practice-seed.mjs
// firebase-admin・firebase-functions は読み込まない（node_modules が無くても動く）。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildPracticeSeed, extractPracticeSettings, SETTINGS_ALLOW, sanitizeLocation, sanitizeProduct } = require(path.join(root, "functions/practice-seed.js"));
import { STATUS_LABELS, PHASES, LOST, STALE_DAYS } from "../admin/js/constants.js";

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };

const NOW = new Date("2026-10-20T03:00:00+09:00");
const seed = buildPracticeSeed(NOW);
const vals = (c) => Object.values(seed[c]);
const entries = (c) => Object.entries(seed[c]);

// ① 件数
eq(Object.keys(seed.offices).length, 12, "事業所12");
eq(Object.keys(seed.cases).length, 12, "案件12");
eq(Object.keys(seed.shipments).length, 5, "出荷5（2026-10-21 依頼済を追加）");
eq(Object.keys(seed.partners).length, 1, "認定事業者1");
// 見積は「3つの場面（1事業所・同一法人複数・改版済み）」を、改版の2版を含め5件で持つ
eq(Object.keys(seed.quotes).length, 5, "見積5件（3つの場面）");
const actCount = {};
vals("activities").forEach((a) => { actCount[a.caseId] = (actCount[a.caseId] || 0) + 1; });
for (const id of Object.keys(seed.cases)) ok(actCount[id] >= 1 && actCount[id] <= 3, `対応記録は案件ごとに1〜3件 ${id}`);

// ① ステータス内訳
const byStatus = {};
vals("cases").forEach((c) => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
eq(byStatus[1], 3, "新規受信(1)×3");
eq(byStatus[LOST], 1, "失注×1");
eq(byStatus[13], 1, "完了(13)×1");
const phaseCount = {};
vals("cases").forEach((c) => { const p = PHASES.find((x) => x.statuses.includes(c.status)); if (p) phaseCount[p.id] = (phaseCount[p.id] || 0) + 1; });
eq(phaseCount[2], 2, "準備フェーズ×2");
eq(phaseCount[3], 2, "伴走支援フェーズ×2");
eq(phaseCount[4], 2, "申請〜採択フェーズ×2");
for (const c of vals("cases")) ok(STATUS_LABELS[c.status], `ステータス番号が定義にある ${c.status}`);
// 失注は理由つき
const lost = vals("cases").find((c) => c.status === LOST);
ok(lost.lostReason && lost.lostReason !== "", "失注に lostReason");
// 止まっている案件（終了していない案件で、最終更新が STALE_DAYS 以上前）がちょうど1件
const staleCases = vals("cases").filter((c) => c.status !== LOST && c.status !== 13
  && Math.floor((NOW - c.updatedAt) / 86400000) >= STALE_DAYS);
eq(staleCases.length, 1, "止まっている案件×1");
// 担当の振り分け
const assignees = new Set(vals("cases").map((c) => c.assignedUserId));
ok(assignees.has(null) && assignees.has("practice-taro@example.jp") && assignees.has("practice-hanako@example.jp"), "担当は 未割当/太郎/花子");
for (const c of vals("cases")) {
  if (c.assignedUserId) ok(/^練習 /.test(c.assignedUserName), "担当名に「練習」");
  else ok(c.assignedUserName == null, "未割当は名前も空");
  ok(/練習/.test(c.contactName), "担当者名に「練習」");
}
// 案件番号は重複しない
eq(new Set(vals("cases").map((c) => c.caseNumber)).size, 12, "案件番号が一意");

// ② 事業所名・法人名
for (const o of vals("offices")) {
  ok(o.officeName.startsWith("【練習】"), `事業所名に【練習】 ${o.officeName}`);
  ok(o.corpName.startsWith("【練習】"), `法人名に【練習】 ${o.corpName}`);
  eq(o.phone, "000-0000-0000", "電話は架空");
}
for (const c of vals("cases")) { ok(c.officeName.startsWith("【練習】")); ok(c.corpName.startsWith("【練習】")); }
// 同一法人で複数事業所（2〜3件）がある
const corpN = {};
vals("offices").forEach((o) => { corpN[o.corpName] = (corpN[o.corpName] || 0) + 1; });
ok(Object.values(corpN).filter((k) => k >= 2).length >= 2, "複数事業所の法人が2つ以上");
ok(Math.max(...Object.values(corpN)) === 3, "3事業所の法人がある");

// ③ メールはすべて example.jp（seed を文字列化して全メールアドレスを走査）
const flat = JSON.stringify(seed);
const mails = flat.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
ok(mails.length > 0, "メールアドレスが含まれる");
for (const m of mails) ok(m.endsWith("@example.jp"), `メールは example.jp: ${m}`);

// ④ 外部送信先・自社ドメインが無い（seed）
for (const bad of ["hooks.googleapis.com", "chat.googleapis.com", "@tadakayo.jp", "tadakayo.jp"]) {
  ok(!flat.includes(bad), `seed に ${bad} が無い`);
}
ok(!/https?:\/\//.test(flat), "seed に URL が無い");

// ④ settings 抽出：Webhook・メール・印影入りのダミー設定を通す
const dummy = {
  chatWebhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t",
  chatWebhookEnabled: true,
  pmChatWebhookUrl: "https://chat.googleapis.com/v1/spaces/BBB/messages?key=k&token=t",
  pmChatWebhookEnabled: false,
  shippingChatWebhookUrl: "https://chat.googleapis.com/v1/spaces/CCC/messages?key=k&token=t",
  shippingChatWebhookEnabled: true,
  accountingChatWebhookUrl: "https://chat.googleapis.com/v1/spaces/DDD/messages?key=k&token=t",
  accountingChatWebhookEnabled: true,
  gmailSender: "kjk-staff@tadakayo.jp", notifyQuoteChat: true,
  supplierEmail: "vendor@example.com", supplierCc: "cc@tadakayo.jp", supplierContact: "仕入先 太郎",
  supplierName: "仕入先株式会社", supplierPostal: "100-0001", supplierAddress: "東京都千代田区",
  accountingEmail: "acc@tadakayo.jp", accountingEmailCc: "cc2@tadakayo.jp", accountingContactName: "経理 花子",
  poSealImage: "data:image/png;base64,AAAA", poSealText: "角印",
  poOrderers: ["発注者 一郎"], poOrdererName: "発注者 一郎", poIssuerRep: "代表 太郎",
  poIssuerName: "NPO法人タダカヨ", poIssuerAddr: "大阪府",
  billingBankName: "テスト銀行", billingAccountNumber: "1234567", billingAccountHolder: "ホルダー",
  invoiceIssuerName: "NPO法人タダカヨ", invoiceRegNo: "T0000000000000",
  invoiceIssuerPostal: "000-0000", invoiceIssuerTel: "00-0000-0000", invoiceIssuerAddress: "大阪府",
  subsidyDeadline: "2027-03-12",
  referralSources: [{ id: "tadakayo", name: "タダカヨ", order: 10, active: true, secretMail: "a@tadakayo.jp" }],
  // 許可リストの項目でも、アドレス・URL が紛れ込んだ文面は落とす
  invoiceMailBody: "経理 kjk@tadakayo.jp まで", dunningMailBody: "詳細は https://example.com を見てください",
  poMailSubject: "発注書のご送付", poMailBody: "いつもお世話になっております。",
  senders: [{ name: "差出人", postal: "000-0000", phone: "00-0000-0000", address: "大阪府", email: "s@tadakayo.jp" }],
  updatedAt: "x", updatedBy: "someone@tadakayo.jp", someFutureKey: "future",
};
const ext = extractPracticeSettings(dummy);
const extJson = JSON.stringify(ext);
for (const bad of ["hooks.googleapis.com", "chat.googleapis.com", "@tadakayo.jp", "data:image", "http://", "https://", "@example.com"]) {
  ok(!extJson.includes(bad), `settings 抽出結果に ${bad} が無い`);
}
for (const k of Object.keys(ext)) ok(SETTINGS_ALLOW.includes(k) || k === "senders", `許可リスト外の項目が写っていない ${k}`);
for (const k of ["chatWebhookUrl", "pmChatWebhookUrl", "shippingChatWebhookUrl", "accountingChatWebhookUrl", "chatWebhookEnabled",
  "gmailSender", "supplierEmail", "accountingEmail", "poSealImage", "billingAccountNumber", "someFutureKey", "updatedBy"]) {
  ok(!(k in ext), `${k} は写らない`);
}
eq(ext.subsidyDeadline, "2027-03-12", "申請期限は写る");
eq(ext.referralSources, [{ id: "tadakayo", name: "タダカヨ", order: 10, active: true }], "紹介元は許可した項目だけ写る");
ok(!("invoiceMailBody" in ext) && !("dunningMailBody" in ext), "アドレス・URL入りの文面は写らない");
eq(ext.senders, [{ name: "差出人", postal: "000-0000", phone: "00-0000-0000", address: "大阪府" }], "差出人はメールを除いて写る");
eq(extractPracticeSettings(null), {}, "設定が無くても落ちない");
eq(extractPracticeSettings({ chatWebhookUrl: "https://chat.googleapis.com/x" }), {}, "許可リスト外だけなら空");

// ⑤ shipments の caseId が seed の案件を指す／状態の内訳
for (const s of vals("shipments")) ok(seed.cases[s.caseId], `出荷の caseId が案件にある ${s.soNumber}`);
eq(vals("shipments").map((s) => s.status).sort(), ["draft", "invoiced", "paid", "requested", "shipped"], "出荷は draft/requested/shipped/invoiced/paid");
{ const r = vals("shipments").find((s) => s.status === "requested"); ok(r.requestSeq === 1 && r.requestedByEmail && r.shipNotifiedAt, "依頼済は依頼の記録（requestSeq・依頼した人・出荷指示の投稿済み）を持つ"); }
for (const s of vals("shipments")) ok(s.items.length > 0 && s.items.every((i) => i.sku && i.qty > 0), "出荷に明細がある");
const paid = vals("shipments").find((s) => s.status === "paid");
eq(paid.payments[0].amount, paid.items.reduce((a, i) => a + i.unitPrice * i.qty, 0), "入金済は請求額と入金額が一致");
// 出荷の品番は products にあるものだけ（引数で与えたとき、無い品番の明細は省く。非在庫行は残る）
const only415 = buildPracticeSeed(NOW, { availableProductIds: ["cir415a-01"] });
for (const s of Object.values(only415.shipments)) for (const i of s.items) ok(i.nonStock || i.sku === "cir415a-01", `products に無い品番は省く ${i.sku}`);
// 案件・見積・出荷の相互参照が整合
for (const [id, q] of entries("quotes")) { ok(seed.cases[q.caseId], `見積の caseId ${id}`); ok(seed.offices[q.officeId], `見積の officeId ${id}`); }
for (const [id, c] of entries("cases")) {
  ok(seed.offices[c.officeId], `案件の officeId ${id}`);
  if (c.latestQuoteId) eq(seed.quotes[c.latestQuoteId].caseId, id, `latestQuoteId が自分の見積 ${id}`);
  if (c.shipmentId) eq(seed.shipments[c.shipmentId].caseId, id, `shipmentId が自分の出荷 ${id}`);
}
for (const a of vals("activities")) ok(seed.cases[a.caseId], "対応記録の caseId");
// 見積の3場面：同一法人（groupId 共有）・改版（v1 差し替え済み→v2）・単独
const groups = {};
vals("quotes").forEach((q) => { if (q.groupId) (groups[q.groupId] = groups[q.groupId] || []).push(q); });
ok(Object.values(groups).some((g) => g.length === 2 && g[0].corpName === g[1].corpName), "同一法人2事業所の見積が groupId を共有");
const v1 = seed.quotes["practice-quote-04-v1"], v2 = seed.quotes["practice-quote-04-v2"];
eq([v1.status, v1.version, v2.version, v2.supersedes], ["superseded", 1, 2, "practice-quote-04-v1"], "改版済み（古い版は差し替え済み）");
eq(v1.estNo, v2.estNo, "改版でも見積番号は引き継ぐ");
ok(vals("quotes").some((q) => !q.groupId && q.version === 1 && q.status === "issued"), "1事業所の見積がある");
// 見積の合計は本番と同じ計算
for (const q of vals("quotes")) ok(q.amounts.totalIncl > 0 && q.amounts.selfPay >= 0, "見積の金額が入っている");
// 認定事業者のIDは example.jp
for (const id of Object.keys(seed.partners)) ok(id.endsWith("@example.jp"), "認定事業者のID");

// 採番：seed の最大値の次から振られる
const maxCase = Math.max(...vals("cases").map((c) => c.caseNumber));
eq(seed._counters.cases.value, maxCase, "案件番号の採番が最大値");
const maxShip = Math.max(...vals("shipments").map((s) => Number(s.soNumber.split("-").pop())));
eq(seed._counters.shipments.value, maxShip, "出荷番号の採番が最大値");
const year = Object.keys(seed._counters).find((k) => k.startsWith("quotes_")).slice(7);
const maxQuote = Math.max(...vals("quotes").map((q) => Number(q.estNo.split("-").pop())));
eq(seed._counters[`quotes_${year}`].value, maxQuote, "見積番号の採番が最大値");

// ⑥ practice.js のソースを読み、本番DB（prodDb / 既定の getFirestore()）への書き込みが無いことを文字列検査
const src = readFileSync(path.join(root, "functions/practice.js"), "utf8");
// コメントを除く（コメントに書いた説明で誤検知しないため）
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const WRITE_RE = /\.(set|update|delete|add|create|recursiveDelete|batch|bulkWriter|runTransaction|bulkWriter|writeEntries)\s*\(/;
const prodLines = code.split("\n").filter((l) => /prodDb/.test(l));
ok(prodLines.length > 0, "prodDb の使用箇所がある");
for (const l of prodLines) ok(!WRITE_RE.test(l), `prodDb の行に書き込みが無い: ${l.trim()}`);
// prodDb を他の関数へ渡している行は、読み取り専用の関数（readProdMaster / isActiveAdmin / assertPracticeDb / resetPracticeDatabase / openDatabases）だけ
const KEYWORDS = new Set(["if", "function", "async", "await", "return"]);
for (const l of prodLines) {
  if (/function\s+\w+\s*\(/.test(l)) continue; // 関数の宣言（引数名としての prodDb）
  for (const m of l.matchAll(/([\w.]+)\s*\(([^()]*prodDb[^()]*)\)/g)) {
    if (KEYWORDS.has(m[1])) continue;
    ok(["readProdMaster", "isActiveAdmin", "assertPracticeDb", "resetPracticeDatabase"].includes(m[1]),
      `prodDb の受け渡し先が許可済み: ${m[1]}`);
  }
}
// prodDb を渡してよい関数の本体に書き込みが無いこと（readProdMaster・isActiveAdmin は .get() だけ）
for (const fn of ["readProdMaster", "isActiveAdmin"]) {
  const m = new RegExp(`async function ${fn}\\([\\s\\S]*?\\n}\\n`).exec(code);
  ok(m, `${fn} が見つかる`);
  ok(!WRITE_RE.test(m[0]), `${fn} に書き込みが無い`);
  ok(/\.get\(\)/.test(m[0]), `${fn} は get() で読む`);
}
// 書き込み・削除は practiceDb にだけ
for (const l of code.split("\n").filter((x) => /recursiveDelete|\.batch\(|writeEntries\(/.test(x))) {
  ok(!/prodDb/.test(l) && /practiceDb|function writeEntries/.test(l), `書き込み系は practiceDb 専用: ${l.trim()}`);
}
// getFirestore は「既定（引数なし）」と「"practice"」の2通りだけ
const gf = code.match(/getFirestore\s*\(([^)]*)\)/g) || [];
for (const g of gf) ok(/getFirestore\(\s*(PRACTICE_DB_ID)?\s*\)/.test(g) || /getFirestore\(\s*"practice"\s*\)/.test(g), `getFirestore は既定か practice のみ: ${g}`);
// 管理者以外を弾く・毎晩3時・region
ok(/permission-denied/.test(code) && /role === "admin"/.test(code) && /active === true/.test(code), "管理者(active & role=admin)だけ実行できる");
ok(/schedule: "0 3 \* \* \*"/.test(code) && /timeZone: "Asia\/Tokyo"/.test(code), "毎日3:00 JST");
ok(/exports\.resetPractice = onCall/.test(code) && /exports\.nightlyPracticeReset = onSchedule/.test(code), "2つを export");
ok(/listCollections\(\)/.test(code), "トップレベルのコレクションを列挙して消す");

// index.js は末尾に2行の再エクスポートを足しただけ
const idx = readFileSync(path.join(root, "functions/index.js"), "utf8");
ok(/exports\.resetPractice = practice\.resetPractice;/.test(idx) && /exports\.nightlyPracticeReset = practice\.nightlyPracticeReset;/.test(idx), "index.js が2つを再エクスポート");

// 料金・送料は数値の構造だけ写す（練習でも本番と同じ金額で出荷・請求できる）
{
  const out = extractPracticeSettings({
    partnerPricing: { "cir415a-01": [13000, 12500, 12000, 11500], "bad sku!": [1, 2], "cir315a-02": [1, "x"] },
    letterpackFee: 600,
    yupackTable: { regions: ["関西", "関東"], sizes: [60, 80], rows: { 60: [900, 1100], 80: [1100, 1300] }, origin: "滋賀県" },
    chatWebhookUrl: "https://chat.googleapis.com/v1/spaces/x",
  });
  ok(JSON.stringify(out.partnerPricing) === JSON.stringify({ "cir415a-01": [13000, 12500, 12000, 11500] }), "partnerPricing は数値だけの品番を写す");
  ok(out.letterpackFee === 600, "letterpackFee を写す");
  ok(out.yupackTable && out.yupackTable.rows[60][1] === 1100 && out.yupackTable.origin === "滋賀県", "yupackTable を写す");
  ok(!("chatWebhookUrl" in out), "Webhook は写さない");
  const bad = extractPracticeSettings({ yupackTable: { regions: ["https://evil.example"], sizes: [60], rows: { 60: [1] } }, letterpackFee: "600" });
  ok(!bad.yupackTable && !("letterpackFee" in bad), "形の崩れた料金・URL入りの地域名は写さない");
}

// 保管場所・商品は人の情報を持ち込まない
{
  const loc = sanitizeLocation("loc1", { name: "佐藤様宅", pref: "大阪府", postal: "530-0001", address: "大阪府大阪市北区梅田1-1", recipient: "佐藤 太郎", phone: "06-1234-5678", createdBy: "x@tadakayo.jp", isDefault: true, sort: 2 }, 0);
  const txt = JSON.stringify(loc);
  ok(!/佐藤|梅田|06-1234|tadakayo|530-0001/.test(txt), "保管場所の実在の名前・住所・電話・作成者を落とす");
  ok(loc.pref === "大阪府" && loc.isDefault === true && loc.sort === 2 && loc.name.startsWith("【練習】"), "保管場所の都道府県・既定・並びは保つ");
  const pr = sanitizeProduct({ name: "カードリーダー", price: 6500, stockByLocation: { loc1: 3 }, createdBy: "a@tadakayo.jp", updatedBy: "b", note: "連絡は https://x.example へ", supplier: { name: "AB", contactEmail: "s@ab.example", phone: "03-1111-2222" } });
  ok(pr.name === "カードリーダー" && pr.price === 6500 && pr.stockByLocation.loc1 === 3, "商品の業務の値は保つ");
  ok(!("createdBy" in pr) && !("updatedBy" in pr) && !("note" in pr) && !("contactEmail" in pr.supplier) && !("phone" in pr.supplier), "商品の作成者・メール・電話・URL入りの値は落とす");
}

console.log(`OK: ${n} checks passed`);
