// functions/practice-seed.js — 学習用テストモードの練習DB（practice）に入れる初期データ（架空）
// 設計: docs/テストモード設計_20261020.md §3.4
//
// ・firebase-admin に依存しない純粋な関数だけを置く（node のテストで単体確認できるようにするため）
// ・日時は JS の Date で返す（Firestore へ書くと Timestamp になる）
// ・本番の人・事業所の名前は一切使わない。事業所は「【練習】」付き、人名は「練習」付き、
//   メールは example.jp、電話は 000-0000-0000。
// ・戻り値は { コレクション名: { ドキュメントID: データ } }（_counters も同じ形）

const Pricing = require("./estimate-pricing"); // 見積もりの価格ロジック（本番の見積もり作成と同じ計算）

const DAY = 86400000;

// ===== 練習用の担当者（架空・users には置かない。案件の担当欄に表示する名前だけ） =====
const TARO = { id: "practice-taro@example.jp", name: "練習 太郎" };
const HANAKO = { id: "practice-hanako@example.jp", name: "練習 花子" };

// 出荷の品名・接続（本番 functions/index.js の PRODUCT_NAMES / CONNECTION_LABELS と同じ表記）
const PRODUCT_NAMES = {
  "cir415a-01": "介護情報基盤 汎用カードリーダ CIR415A",
  "cir315a-02": "介護情報基盤 汎用カードリーダ CIR315A（Type-A）",
  "cir315a-04": "介護情報基盤 汎用カードリーダ CIR315A（Type-C）",
};
const CONNECTION_LABELS = {
  "cir415a-01": "Bluetooth／USB Type-C",
  "cir315a-02": "USB Type-A",
  "cir315a-04": "USB Type-C",
};

// JST の「YYYY-MM-DD」（now から n 日ずらす）
function ymdJst(now, n = 0) {
  return new Date(now.getTime() + n * DAY).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}
const ago = (now, days, hours = 0) => new Date(now.getTime() - days * DAY - hours * 3600000);

// 見積もりの明細（品番ベース）と金額を、本番の staffCreateQuote と同じ計算で作る
function quoteBody(planKey, btQty, usbQty, btExtra, usbExtra, usbConnector) {
  const calc = Pricing.computeAmounts(planKey, btQty, usbQty, btExtra, usbExtra);
  const items = Pricing.buildItems({ btQty, usbQty, btExtra, usbExtra, usbConnector });
  const amounts = {
    readers: calc.devSubsidyIncl, accompanyFee: calc.accFeeIncl, discount: calc.discount,
    subsidyPartTotal: calc.subsidyPartTotal, extraPartTotal: calc.extraPartTotal,
    totalIncl: calc.totalIncl, grantAmt: calc.grantAmt, selfPay: calc.selfPay,
  };
  const cardReaders = [];
  if (btQty > 0 || btExtra > 0) cardReaders.push({ type: "BT", subsidyQty: btQty, extraQty: btExtra });
  if (usbQty > 0 || usbExtra > 0) cardReaders.push({ type: "USB", subsidyQty: usbQty, extraQty: usbExtra, connector: usbConnector || null });
  return { calc, items, amounts, cardReaders };
}

// 見積もりの明細 → 出荷の明細（本番 shipmentItemsFromQuote と同じ形）。
// availableSkus（Set）が渡されたときは、products に無い品番の行を省く（画面で品名が引けない行を作らないため）
function shipmentItems(q, availableSkus) {
  const items = [];
  for (const it of q.items) {
    const qty = (Number(it.subsidyQty) || 0) + (Number(it.extraQty) || 0);
    if (qty <= 0) continue;
    if (availableSkus && !availableSkus.has(it.sku)) continue;
    const unitPrice = it.sku === Pricing.SKU.BT ? Pricing.BT_PRICE : Pricing.USB_PRICE;
    items.push({ sku: it.sku, name: PRODUCT_NAMES[it.sku] || it.sku, qty, unitPrice, connection: CONNECTION_LABELS[it.sku] || "" });
  }
  const fee = Number(q.amounts.accompanyFee) || 0;
  if (fee > 0) {
    const n = q.items.reduce((a, i) => a + (Number(i.subsidyQty) || 0), 0);
    items.push({ sku: "support-fee", name: `伴走支援費（補助対象${n}台）`, qty: 1, unitPrice: fee, nonStock: true });
  }
  const discount = Number(q.amounts.discount) || 0;
  if (discount > 0) items.push({ sku: "discount", name: "金額調整", qty: 1, unitPrice: -discount, nonStock: true });
  return items;
}
// 直送でない出荷は明細が税込・送料0なので、請求総額は明細の合計そのもの
const itemsTotal = (items) => items.reduce((a, i) => a + (Number(i.unitPrice) || 0) * (Number(i.qty) || 0), 0);

// ===== 事業所 12 件 =====
// 都道府県・市区町村は実在、番地は架空。同一法人は A（3事業所）・C（2事業所）。
const OFFICE_DEFS = [
  // 法人A「【練習】あおぞら福祉会」3事業所（合計見積の練習用）
  { corp: "【練習】あおぞら福祉会", name: "【練習】あおぞら訪問介護ステーション", postal: "530-0001", pref: "大阪府", city: "大阪市北区", detail: "練習町1-2-3" },
  { corp: "【練習】あおぞら福祉会", name: "【練習】あおぞらデイサービス", postal: "530-0002", pref: "大阪府", city: "大阪市北区", detail: "練習町4-5-6" },
  { corp: "【練習】あおぞら福祉会", name: "【練習】あおぞらケアプランセンター", postal: "560-0021", pref: "大阪府", city: "豊中市", detail: "練習台7-8-9" },
  // 単独
  { corp: "【練習】みどりの里株式会社", name: "【練習】みどりの里居宅介護支援", postal: "060-0001", pref: "北海道", city: "札幌市中央区", detail: "練習通1-1-1" },
  // 法人C「【練習】ひだまり介護サービス株式会社」2事業所
  { corp: "【練習】ひだまり介護サービス株式会社", name: "【練習】ひだまり訪問看護ステーション", postal: "460-0001", pref: "愛知県", city: "名古屋市中区", detail: "練習丁目2-2-2" },
  { corp: "【練習】ひだまり介護サービス株式会社", name: "【練習】ひだまりグループホーム", postal: "461-0001", pref: "愛知県", city: "名古屋市東区", detail: "練習丁目3-3-3" },
  // 単独
  { corp: "【練習】さくら会", name: "【練習】さくら通所リハビリ", postal: "980-0001", pref: "宮城県", city: "仙台市青葉区", detail: "練習坂4-4-4" },
  { corp: "【練習】つばさ医療福祉法人", name: "【練習】つばさ特別養護老人ホーム", postal: "730-0001", pref: "広島県", city: "広島市中区", detail: "練習橋5-5-5" },
  { corp: "【練習】はなまる株式会社", name: "【練習】はなまる小規模多機能", postal: "810-0001", pref: "福岡県", city: "福岡市中央区", detail: "練習浜6-6-6" },
  { corp: "【練習】こもれび合同会社", name: "【練習】こもれび訪問リハビリ", postal: "920-0001", pref: "石川県", city: "金沢市", detail: "練習森7-7-7" },
  { corp: "【練習】ほたる福祉事業団", name: "【練習】ほたる居宅介護支援", postal: "700-0001", pref: "岡山県", city: "岡山市北区", detail: "練習川8-8-8" },
  { corp: "【練習】そよかぜ株式会社", name: "【練習】そよかぜ介護老人保健施設", postal: "900-0001", pref: "沖縄県", city: "那覇市", detail: "練習島9-9-9" },
];
const officeId = (i) => `practice-office-${String(i + 1).padStart(2, "0")}`;
const caseId = (i) => `practice-case-${String(i + 1).padStart(2, "0")}`;

// ===== 案件 12 件の定義 =====
// 並び = 事業所の並びと同じ（案件 i ↔ 事業所 i）。status は admin/js/constants.js の STATUS_LABELS に合わせる。
//   1 新規受信 ×3 ／ 2 確認中（止まっている案件）×1 ／ 5・6 準備 ／ 7・8 伴走支援 ／ 9・10 申請〜採択 ／ 13 完了 ／ 4 失注
const CASE_DEFS = [
  { status: 1, source: "lp_inquiry", intent: "consult", assignee: null, contact: "練習 一郎", ageDays: 1, updDays: 1, msg: "カードリーダーの補助金について相談したいです。（練習用の架空データです）" },
  { status: 1, source: "lp_inquiry", intent: "quote", assignee: null, contact: "練習 二郎", ageDays: 1, updDays: 0, msg: "見積書がほしいです。同じ法人の別事業所も検討中です。（練習用の架空データです）" },
  { status: 1, source: "manual", intent: null, assignee: TARO, contact: "練習 三郎", ageDays: 2, updDays: 1, msg: "電話でお問い合わせがありました。（練習用の架空データです）" },
  { status: 2, source: "mitsumori_quote", intent: "quote", assignee: HANAKO, contact: "練習 四郎", ageDays: 20, updDays: 12, msg: "見積もり後、返事待ちのまま止まっています。（練習用：止まっている案件）" },
  { status: 5, source: "mitsumori_quote", intent: "order", assignee: TARO, contact: "練習 五郎", ageDays: 12, updDays: 2, msg: "同じ法人2事業所で申し込みました。（練習用の架空データです）" },
  { status: 6, source: "mitsumori_quote", intent: "order", assignee: HANAKO, contact: "練習 五郎", ageDays: 12, updDays: 3, msg: "同じ法人2事業所で申し込みました。（練習用の架空データです）" },
  { status: 7, source: "lp_inquiry", intent: "order", assignee: TARO, contact: "練習 六郎", ageDays: 25, updDays: 2, msg: "構成を変えて申し込みました。（練習用の架空データです）" },
  { status: 8, source: "lp_inquiry", intent: "order", assignee: HANAKO, contact: "練習 七子", ageDays: 30, updDays: 4, msg: "伴走支援が終わりました。（練習用の架空データです）" },
  { status: 9, source: "manual", intent: null, assignee: TARO, contact: "練習 八子", ageDays: 40, updDays: 3, msg: "申請書類をそろえています。（練習用の架空データです）" },
  { status: 10, source: "lp_inquiry", intent: "order", assignee: HANAKO, contact: "練習 九子", ageDays: 45, updDays: 5, msg: "申請済みで採択待ちです。（練習用の架空データです）" },
  { status: 13, source: "lp_inquiry", intent: "order", assignee: TARO, contact: "練習 十子", ageDays: 70, updDays: 20, msg: "すべて完了しました。（練習用の架空データです）" },
  { status: 4, source: "lp_inquiry", intent: "consult", assignee: null, contact: "練習 十一", ageDays: 35, updDays: 28, msg: "他社を紹介して失注になりました。（練習用の架空データです）" },
];
const CASE_NUMBER_BASE = 900; // 練習の案件番号は #901〜（本番の番号と見分けやすくする）

// 対応記録（案件ごと 1〜3 件）。type は case-detail-util.js の ACTIVITY_LABELS の値に合わせる
const ACTIVITY_DEFS = {
  0: [["email_in", "LP問い合わせ受信", "カードリーダーの補助金について相談がありました。"]],
  1: [["email_in", "LP問い合わせ受信", "見積書の希望がありました。"], ["phone_out", "お電話で確認", "同じ法人の別事業所の台数をうかがいました。"]],
  2: [["phone_in", "電話で問い合わせ", "補助金の対象かどうかの確認でした。"], ["memo", "折り返し予定", "明日の午前に折り返します。"]],
  3: [["phone_out", "見積もりの確認電話", "不在でした。"], ["email_out", "見積もりをご案内", "見積書をメールでお送りしました。"], ["memo", "返事待ち", "1週間以上、返信がありません。"]],
  4: [["phone_out", "お申し込みの確認", "2事業所分をまとめて申し込みいただきました。"], ["email_out", "事前準備のご案内", "承諾書の署名をお願いしました。"]],
  5: [["email_out", "事前準備のご案内", "準備の流れをお送りしました。"], ["phone_out", "日程の相談", "訪問日の候補をうかがいました。"]],
  6: [["visit", "事前の打ち合わせ", "機器の置き場所を確認しました。"], ["memo", "構成を変更", "台数を変えたため見積もりを改版しました。"]],
  7: [["visit", "伴走支援を実施", "カードリーダーの設定を一緒に行いました。"], ["memo", "次の連絡", "申請書類のご案内を送る予定です。"]],
  8: [["email_out", "申請書類のご案内", "必要書類の一覧をお送りしました。"], ["phone_in", "書類の質問", "押印の位置について質問がありました。"]],
  9: [["memo", "申請を完了", "申請を提出したと連絡がありました。"], ["phone_out", "採択結果の確認", "結果が出たら連絡いただく約束です。"]],
  10: [["memo", "入金を確認", "助成金の入金を確認しました。"], ["email_out", "完了のご連絡", "すべての手続きが終わりました。"]],
  11: [["phone_out", "ご案内", "他社（認定パートナー）をご案内しました。"], ["memo", "失注", "理由：他社紹介。"]],
};

// 本物の seed を組み立てる。
// now: 基準時刻（Date）／ opts.availableProductIds: products にある品番の配列（省略時は固定の品番をそのまま使う）
function buildPracticeSeed(now, opts = {}) {
  const t0 = now instanceof Date ? now : new Date();
  const year = ymdJst(t0).slice(0, 4);
  const avail = Array.isArray(opts.availableProductIds) ? new Set(opts.availableProductIds) : null;

  const seed = {
    offices: {}, cases: {}, activities: {}, quotes: {}, shipments: {}, partners: {}, _counters: {},
  };

  // --- 事業所 ---
  OFFICE_DEFS.forEach((o, i) => {
    seed.offices[officeId(i)] = {
      corpName: o.corp, officeName: o.name,
      postalCode: o.postal, prefecture: o.pref, city: o.city, addressDetail: o.detail,
      address: [o.pref, o.city, o.detail].filter(Boolean).join(""),
      phone: "000-0000-0000", website: "",
      createdAt: ago(t0, CASE_DEFS[i].ageDays + 1), updatedAt: ago(t0, CASE_DEFS[i].updDays),
    };
  });

  // --- 案件 ---
  CASE_DEFS.forEach((c, i) => {
    const o = OFFICE_DEFS[i];
    seed.cases[caseId(i)] = {
      caseNumber: CASE_NUMBER_BASE + i + 1,
      officeId: officeId(i), officeName: o.name, corpName: o.corp,
      contactName: c.contact, contactEmail: `practice-office${String(i + 1).padStart(2, "0")}@example.jp`, contactPhone: "000-0000-0000",
      source: c.source, inquiryIntent: c.intent, referralSource: null,
      status: c.status,
      assignedUserId: c.assignee ? c.assignee.id : null,
      assignedUserName: c.assignee ? c.assignee.name : null,
      receivedAt: ago(t0, c.ageDays), updatedAt: ago(t0, c.updDays),
      message: c.msg,
      cardReaders: [], subsidyCategory: null, expectedSubsidyAmount: null,
      lostReason: null, orderedAt: null, completedAt: null,
    };
  });
  // 失注（理由つき）・完了
  Object.assign(seed.cases[caseId(11)], {
    lostReason: "referred_partner", lostReasonNote: "近隣の認定パートナーをご案内（練習用）",
  });
  seed.cases[caseId(10)].completedAt = ago(t0, 20);

  // --- 見積もり ---
  // 5件: ①1事業所（案件4・発行済み）②同一法人2事業所（案件5・6が quoteGroupId を共有）③改版済み（案件7：v1=差し替え済み→v2）
  const quoteBase = (i, estNo, version, q, extra) => ({
    caseId: caseId(i), officeId: officeId(i), caseNumber: CASE_NUMBER_BASE + i + 1,
    estNo, version,
    items: q.items, amounts: q.amounts,
    status: "issued", supersedes: null,
    createdVia: "staff", createdBy: TARO.id,
    contactEmail: seed.cases[caseId(i)].contactEmail, contactName: seed.cases[caseId(i)].contactName,
    officeName: OFFICE_DEFS[i].name, corpName: OFFICE_DEFS[i].corp,
    accessToken: `practice-token-${estNo}-v${version}`, // 練習用の固定値（本物の鍵ではない）
    pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null,
    ...extra,
  });
  const putQuote = (id, i, estNo, version, planKey, qty, extra) => {
    const q = quoteBody(planKey, ...qty);
    const body = quoteBase(i, estNo, version, q, extra);
    body.plan = planKey; body.planLabel = q.calc.plan.label;
    seed.quotes[id] = body;
    return q;
  };
  const est = (n) => `EST-${year}-${String(n).padStart(4, "0")}`;
  // ① 1事業所
  const q1 = putQuote("practice-quote-01", 3, est(1), 1, "houmon", [1, 1, 0, 0, "C"], {
    createdAt: ago(t0, 15), validUntil: new Date(t0.getTime() + 15 * DAY),
  });
  // ② 同一法人2事業所（groupId 共有）
  const grp = "practice-group-01";
  const q2a = putQuote("practice-quote-02", 4, est(2), 1, "houmon", [1, 0, 0, 0, null], {
    createdAt: ago(t0, 11), validUntil: new Date(t0.getTime() + 19 * DAY),
    status: "accepted", acceptedAt: ago(t0, 9), acceptedBy: "練習 五郎", payMethod: "after",
    groupId: grp, groupIndex: 1, groupSize: 2,
  });
  const q2b = putQuote("practice-quote-03", 5, est(3), 1, "kyojyu", [1, 1, 0, 0, "A"], {
    createdAt: ago(t0, 11), validUntil: new Date(t0.getTime() + 19 * DAY),
    status: "accepted", acceptedAt: ago(t0, 9), acceptedBy: "練習 五郎", payMethod: "after",
    groupId: grp, groupIndex: 2, groupSize: 2,
  });
  // ③ 改版済み（v1 は差し替え済み・v2 が有効）
  putQuote("practice-quote-04-v1", 6, est(4), 1, "houmon", [1, 0, 0, 0, null], {
    createdAt: ago(t0, 24), validUntil: new Date(t0.getTime() + 6 * DAY),
    status: "superseded", supersededAt: ago(t0, 20),
  });
  const q4v2 = putQuote("practice-quote-04-v2", 6, est(4), 2, "houmon", [1, 1, 0, 0, "C"], {
    createdAt: ago(t0, 20), validUntil: new Date(t0.getTime() + 10 * DAY),
    status: "accepted", acceptedAt: ago(t0, 18), acceptedBy: "練習 六郎", payMethod: "after",
    supersedes: "practice-quote-04-v1", reason: "台数を増やしたいとのご要望のため（練習用）",
  });

  // 案件側の見積もり情報（本番の staffCreateQuote / reviseQuote が案件へ書く項目に合わせる）
  const caseQuote = (i, quoteId, q, planKey) => Object.assign(seed.cases[caseId(i)], {
    latestQuoteId: quoteId, quoteIssuedAt: seed.quotes[quoteId].createdAt,
    subsidyPlan: q.calc.plan.label, cardReaders: q.cardReaders, subsidyCategory: planKey,
    expectedSubsidyAmount: q.calc.grantAmt, totalAmount: q.calc.totalIncl,
    specialDiscount: q.calc.discount, selfPay: q.calc.selfPay,
  });
  caseQuote(3, "practice-quote-01", q1, "houmon");
  caseQuote(4, "practice-quote-02", q2a, "houmon");
  caseQuote(5, "practice-quote-03", q2b, "kyojyu");
  caseQuote(6, "practice-quote-04-v2", q4v2, "houmon");
  // 合計見積（同一法人）の練習用に、案件5・6は同じ quoteGroupId を持つ
  seed.cases[caseId(4)].quoteGroupId = grp;
  seed.cases[caseId(5)].quoteGroupId = grp;
  // 申し込み済みの案件は受注確定の印を持つ
  [[4, "practice-quote-02"], [5, "practice-quote-03"], [6, "practice-quote-04-v2"]].forEach(([i, qid]) => {
    Object.assign(seed.cases[caseId(i)], { orderedAt: seed.quotes[qid].acceptedAt, orderedVia: "staff" });
  });

  // --- 出荷 4 件（下書き・発送済・請求済・入金済）---
  let shipSeq = 0;
  const shipBase = (i, quoteId, q, status, extra) => {
    shipSeq += 1;
    const items = shipmentItems(q, avail);
    return {
      soNumber: `SH-${year}-${String(shipSeq).padStart(4, "0")}`, status,
      shipType: "direct", partnerEmail: "", partnerName: "",
      caseId: caseId(i), caseNumber: CASE_NUMBER_BASE + i + 1,
      quoteId: quoteId || null, estNo: quoteId ? seed.quotes[quoteId].estNo : "",
      company: OFFICE_DEFS[i].corp, officeName: OFFICE_DEFS[i].name,
      postal: OFFICE_DEFS[i].postal, address: seed.offices[officeId(i)].address,
      contactName: CASE_DEFS[i].contact, phone: "000-0000-0000",
      items, shippingMethod: "manual", shippingFee: 0, shippingLabel: "",
      payMethod: "after",
      createdAt: ago(t0, 8), createdBy: "練習（架空データ）",
      ...extra,
    };
  };
  // 下書き（案件7：改版後の見積もりから）
  const s1 = shipBase(6, "practice-quote-04-v2", q4v2, "draft", { shipDate: ymdJst(t0, 3) });
  seed.shipments["practice-ship-01"] = s1;
  seed.quotes["practice-quote-04-v2"].shipmentId = "practice-ship-01";
  seed.quotes["practice-quote-04-v2"].shipmentNo = s1.soNumber;
  seed.cases[caseId(6)].shipmentId = "practice-ship-01";
  // 発送済（案件8）
  seed.shipments["practice-ship-02"] = shipBase(7, null, q4v2, "shipped", {
    shipDate: ymdJst(t0, -6), confirmedAt: ago(t0, 6), shippedAt: ago(t0, 6),
    shippedBy: TARO.name, shippedByEmail: TARO.id, dueRule: "net14",
    letterPackType: "plus",
  });
  // 請求済（案件9）
  seed.shipments["practice-ship-03"] = shipBase(8, null, q1, "invoiced", {
    shipDate: ymdJst(t0, -14), confirmedAt: ago(t0, 14), shippedAt: ago(t0, 14),
    shippedBy: HANAKO.name, shippedByEmail: HANAKO.id, dueRule: "net14",
    invoicedAt: ymdJst(t0, -12),
  });
  // 入金済（案件10）
  const paidShip = shipBase(9, null, q2a, "paid", {
    shipDate: ymdJst(t0, -30), confirmedAt: ago(t0, 30), shippedAt: ago(t0, 30),
    shippedBy: TARO.name, shippedByEmail: TARO.id, dueRule: "net14",
    invoicedAt: ymdJst(t0, -28),
  });
  const paidAmount = itemsTotal(paidShip.items);
  Object.assign(paidShip, {
    payments: [{ amount: paidAmount, date: ymdJst(t0, -20), note: "練習用の入金", recordedBy: "練習（架空データ）", recordedAt: ago(t0, 20) }],
    paymentAmount: paidAmount, paidAt: ymdJst(t0, -20),
  });
  seed.shipments["practice-ship-04"] = paidShip;
  // 案件側から出荷への参照
  seed.cases[caseId(7)].shipmentId = "practice-ship-02";
  seed.cases[caseId(8)].shipmentId = "practice-ship-03";
  seed.cases[caseId(9)].shipmentId = "practice-ship-04";

  // --- 対応記録 ---
  let aSeq = 0;
  Object.keys(ACTIVITY_DEFS).forEach((k) => {
    const i = Number(k);
    const c = CASE_DEFS[i];
    const person = c.assignee || TARO;
    ACTIVITY_DEFS[k].forEach(([type, subject, body], j) => {
      aSeq += 1;
      seed.activities[`practice-activity-${String(aSeq).padStart(2, "0")}`] = {
        caseId: caseId(i), type, subject, body,
        // 1件目が一番古い。最後の1件が案件の最終更新（updDays）と同じ頃
        occurredAt: ago(t0, c.updDays + (ACTIVITY_DEFS[k].length - 1 - j)),
        userId: person.id, userName: person.name, attachmentUrls: [],
      };
    });
  });

  // --- 認定事業者（架空。ドキュメントID＝メール）---
  seed.partners["practice-partner@example.jp"] = {
    email: "practice-partner@example.jp",
    company: "【練習】認定パートナー株式会社", partnerName: "【練習】認定パートナー株式会社",
    office: "【練習】認定パートナー 大阪営業所", rep: "練習 代表", contact: "練習 担当",
    postal: "540-0001", phone: "000-0000-0000", address: "大阪府大阪市中央区練習町1-1-1",
    partnerId: "PRACTICE-001", active: true,
    updatedAt: ago(t0, 30), updatedBy: "練習（架空データ）",
  };

  // --- 採番（seed の最大値の次から振られるように、いまの最大値を value に入れる）---
  seed._counters.cases = { value: CASE_NUMBER_BASE + CASE_DEFS.length };
  seed._counters.shipments = { value: shipSeq };
  seed._counters[`quotes_${year}`] = { value: 4 }; // EST-…-0001〜0004 を使用済み

  return seed;
}

// ===== 本番の appConfig/settings から、練習DBへ写してよい項目だけを取り出す（許可リスト方式）=====
// ・ここに書いた項目以外は、本番に増えても写らない（新しい項目はデフォルトで除外される）
// ・値が URL・メールアドレスに見える文字列は、許可リストの項目でも落とす（文面にアドレスが紛れ込んでも漏れない）
// ・Chat の Webhook（4種）とその停止スイッチ、メールの送り先・送信元・仕入先アドレス、印影（poSealImage）は
//   許可リストに無いので写らない
const SETTINGS_ALLOW = [
  "subsidyDeadline",                                  // 申請期限（画面のカウントダウン）
  "referralSources",                                  // 紹介元の選択肢
  "invoiceIssuerName", "invoiceRegNo", "invoiceIssuerPostal", "invoiceIssuerTel", "invoiceIssuerAddress", // 請求書の発行者
  "poIssuerName", "poIssuerAddr", "poSealText",       // 発注書の発行者（印影の画像は写さない）
  "supplierName", "supplierPostal", "supplierAddress", // 仕入先の社名・住所（メールアドレス・担当者は写さない）
  "poMailSubject", "poMailBody",                      // 発注メールの文面
  "invoiceMailSubject", "invoiceMailBody",            // 請求メールの文面
  "dunningMailSubject", "dunningMailBody",            // 催促メールの文面
];
// 住所ブロック（レターパックの差出人など）の中で写してよい項目
const SENDER_ALLOW = ["name", "postal", "phone", "address"];
// 参考: 写さない代表的な項目（テストと報告用。判定は許可リストだけで行う）
const SETTINGS_DENY_EXAMPLES = [
  "chatWebhookUrl", "chatWebhookEnabled", "pmChatWebhookUrl", "pmChatWebhookEnabled",
  "shippingChatWebhookUrl", "shippingChatWebhookEnabled", "accountingChatWebhookUrl", "accountingChatWebhookEnabled",
  "gmailSender", "notifyQuoteChat", "supplierEmail", "supplierCc", "supplierContact",
  "accountingEmail", "accountingEmailCc", "accountingContactName",
  "poSealImage", "poOrderers", "poOrdererName", "poIssuerRep",
  "billingBankName", "billingBranchName", "billingAccountType", "billingAccountNumber", "billingAccountHolder",
  "updatedAt", "updatedBy",
];

// URL・メールアドレス・Webhook・トークンに見える文字列か
const SENSITIVE_RE = /https?:\/\/|hooks\.googleapis|chat\.googleapis|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|AIza[0-9A-Za-z_-]{20,}|ya29\.|Bearer\s/i;
const isSensitiveText = (v) => typeof v === "string" && SENSITIVE_RE.test(v);

function extractPracticeSettings(settings) {
  const src = settings && typeof settings === "object" ? settings : {};
  const out = {};
  for (const key of SETTINGS_ALLOW) {
    if (!(key in src)) continue;
    const v = src[key];
    if (key === "referralSources") {
      if (!Array.isArray(v)) continue;
      out[key] = v.filter((r) => r && typeof r === "object").map((r) => ({
        id: String(r.id ?? ""), name: String(r.name ?? ""), order: Number(r.order) || 0, active: r.active !== false,
      })).filter((r) => !isSensitiveText(r.id) && !isSensitiveText(r.name));
      continue;
    }
    if (typeof v === "string" && !isSensitiveText(v)) out[key] = v;
  }
  // 料金・送料（数値だけの構造。練習でも本番と同じ金額で出荷・請求できるように・Codex 指摘 2026-10-20）
  //   partnerPricing: { 品番: [1台, 2〜10台, 11〜30台, 31台〜] }／letterpackFee: 数値
  //   yupackTable: { regions: [地域名], sizes: [サイズ], rows: { サイズ: [地域ごとの料金] }, origin: 発送地 }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const safeStr = (v) => (typeof v === "string" && !isSensitiveText(v) && v.length <= 100 ? v : null);
  if (src.partnerPricing && typeof src.partnerPricing === "object" && !Array.isArray(src.partnerPricing)) {
    const pp = {};
    for (const [sku, arr] of Object.entries(src.partnerPricing)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(sku) || !Array.isArray(arr)) continue;
      const vals = arr.slice(0, 10).map(num);
      if (vals.length && vals.every((v) => v !== null)) pp[sku] = vals;
    }
    if (Object.keys(pp).length) out.partnerPricing = pp;
  }
  if (num(src.letterpackFee) !== null) out.letterpackFee = src.letterpackFee;
  const yt = src.yupackTable;
  if (yt && typeof yt === "object" && Array.isArray(yt.regions) && Array.isArray(yt.sizes) && yt.rows && typeof yt.rows === "object") {
    const regions = yt.regions.map(safeStr);
    const sizes = yt.sizes.map((v) => (num(v) !== null ? v : safeStr(v)));
    if (regions.every((v) => v !== null) && sizes.every((v) => v !== null)) {
      const rows = {};
      for (const sz of sizes) {
        const r = yt.rows[sz];
        if (Array.isArray(r) && r.every((v) => num(v) !== null)) rows[sz] = r.slice(0, regions.length);
      }
      out.yupackTable = { regions, sizes, rows, ...(safeStr(yt.origin) ? { origin: yt.origin } : {}) };
    }
  }
  // 差出人の住所ブロック（senders）：許可した項目だけ・URL/メールに見える値は落とす
  if (Array.isArray(src.senders)) {
    out.senders = src.senders.filter((r) => r && typeof r === "object").map((r) => {
      const o = {};
      for (const k of SENDER_ALLOW) if (typeof r[k] === "string" && !isSensitiveText(r[k])) o[k] = r[k];
      return o;
    }).filter((o) => Object.keys(o).length);
  }
  return out;
}

// ===== 本番の保管場所・商品を練習DBへ写すときの加工（Codex 指摘 2026-10-20）=====
// 練習DBは本番を見られない練習生も読むので、人の名前・住所・電話・作成者を持ち込まない。
// 保管場所は ID・都道府県・有効/既定・並び順だけ残し（商品の場所別在庫の参照を保つ）、名前と届け先は架空にする。
const PRACTICE_PREF_DEFAULT = "滋賀県";
function sanitizeLocation(id, data, index) {
  const d = data && typeof data === "object" ? data : {};
  const pref = typeof d.pref === "string" && /^[^\s@/:]{2,4}[都道府県]$/.test(d.pref) ? d.pref : PRACTICE_PREF_DEFAULT;
  return {
    name: `【練習】保管場所${index + 1}（${pref}）`, pref,
    active: d.active !== false, isDefault: d.isDefault === true, sort: Number.isFinite(d.sort) ? d.sort : index,
    postal: "000-0000", address: `${pref}練習町${index + 1}-2-3`, recipient: "練習 保管担当", phone: "000-0000-0000",
  };
}
// 商品は品名・価格・在庫などの業務の値だけ。作成者・更新者・メールアドレスや URL に見える値は落とす（入れ子も）
const PERSON_KEY_RE = /(By|Email|email|Mail|Phone|phone|Contact|contact)$/;
function sanitizeProduct(data) {
  const clean = (v, depth) => {
    if (depth > 5) return undefined;
    if (typeof v === "string") return isSensitiveText(v) ? undefined : v;
    if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
    if (v && typeof v === "object") {
      if (typeof v.toDate === "function" || typeof v.toMillis === "function") return v; // Timestamp はそのまま
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (PERSON_KEY_RE.test(k)) continue;
        const c = clean(x, depth + 1);
        if (c !== undefined) o[k] = c;
      }
      return o;
    }
    return v;
  };
  return clean(data && typeof data === "object" ? data : {}, 0);
}

module.exports = {
  buildPracticeSeed, extractPracticeSettings, sanitizeLocation, sanitizeProduct,
  SETTINGS_ALLOW, SENDER_ALLOW, SETTINGS_DENY_EXAMPLES, CASE_NUMBER_BASE,
};
