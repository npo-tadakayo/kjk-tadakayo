// 事業種別（admin/js/service-types.js）とコピーで作る案件・事業所の新規登録の項目（admin/js/case-copy.js）のテスト。
// 画面の結線（案件詳細・一覧・カンバン・事業所・帳票）の静的検査も含む。node scripts/test-service-types.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SERVICE_TYPES, SERVICE_TYPE_NAMES, PLAN_LABELS, isServiceType, planOfServiceType, planHintText,
  serviceTypeLabel, serviceTypeBadge, serviceTypeOptionsHtml, differentServiceTypes,
} from "../admin/js/service-types.js";
import {
  buildCopiedCase, copyActivityTexts, COPY_INITIAL_STATUS, COPY_FIELDS,
  buildNewOffice, officeFormFromExisting, OFFICE_FORM_FIELDS,
} from "../admin/js/case-copy.js";
import { computeDuplicateGroups } from "../admin/js/constants.js";
import { normalizeEmail } from "../admin/js/normalize.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
const rd = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

// ===== 選択肢（順番・正式名・最後に「その他」） =====
const EXPECTED = [
  "居宅介護支援", "介護予防支援", "訪問介護", "訪問入浴介護", "訪問看護", "訪問リハビリテーション", "居宅療養管理指導",
  "通所介護", "地域密着型通所介護", "認知症対応型通所介護", "通所リハビリテーション", "短期入所生活介護", "短期入所療養介護",
  "特定施設入居者生活介護", "福祉用具貸与", "特定福祉用具販売", "定期巡回・随時対応型訪問介護看護", "夜間対応型訪問介護",
  "小規模多機能型居宅介護", "看護小規模多機能型居宅介護", "認知症対応型共同生活介護", "地域密着型特定施設入居者生活介護",
  "地域密着型介護老人福祉施設入所者生活介護", "介護老人福祉施設", "介護老人保健施設", "介護医療院",
  "介護予防・日常生活支援総合事業（訪問型サービス）", "介護予防・日常生活支援総合事業（通所型サービス）", "その他",
];
eq(SERVICE_TYPE_NAMES, EXPECTED, "選択肢の順番・名前");
eq(new Set(SERVICE_TYPE_NAMES).size, SERVICE_TYPE_NAMES.length, "重複が無い");
ok(SERVICE_TYPES.every((t) => t.plan in PLAN_LABELS), "plan は houmon/kyojyu/other のどれか");
// プランの目安の対応は見積もりの PLANS のキーと一致している
const pricing = (await import("../functions/estimate-pricing.js")).default;
eq(Object.keys(PLAN_LABELS).sort(), Object.keys(pricing.PLANS).sort(), "PLAN_LABELS のキー＝見積もりの PLANS");
eq(PLAN_LABELS.houmon, pricing.PLANS.houmon.label, "houmon の表示名が見積もりと同じ");

// ===== プランの目安（資料の「分類に注意するサービス」を含む） =====
for (const [name, plan] of [
  ["居宅介護支援", "houmon"], ["居宅療養管理指導", "houmon"], ["地域密着型通所介護", "houmon"],
  ["訪問介護", "houmon"], ["短期入所療養介護", "houmon"], ["小規模多機能型居宅介護", "houmon"],
  ["介護予防支援", "houmon"],
  ["特定施設入居者生活介護", "kyojyu"], ["認知症対応型共同生活介護", "kyojyu"], ["介護老人福祉施設", "kyojyu"],
  ["介護老人保健施設", "kyojyu"], ["介護医療院", "kyojyu"], ["地域密着型介護老人福祉施設入所者生活介護", "kyojyu"],
  ["福祉用具貸与", "other"], ["特定福祉用具販売", "other"], ["その他", "other"],
  ["介護予防・日常生活支援総合事業（訪問型サービス）", "other"],
]) eq(planOfServiceType(name), plan, `プランの目安: ${name}`);
eq(planOfServiceType(""), null, "未設定は null");
eq(planOfServiceType("存在しない種別"), null, "一覧に無い値は null");
eq(planHintText("福祉用具貸与"), "プランの目安：その他", "目安の表示文");
eq(planHintText("居宅介護支援"), "プランの目安：訪問・通所・短期滞在系（居宅介護支援を含む）", "目安の表示文（houmon）");
eq(planHintText(null), "", "未設定は目安を出さない");
ok(isServiceType("訪問看護") && !isServiceType("訪問看護 ") && !isServiceType(null), "isServiceType");

// ===== 表示（未設定は「未設定」） =====
eq(serviceTypeLabel({}), "未設定", "未設定");
eq(serviceTypeLabel({ serviceType: "  " }), "未設定", "空白だけは未設定");
eq(serviceTypeLabel({ serviceType: "福祉用具貸与" }), "福祉用具貸与", "表示名");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
ok(serviceTypeBadge({ serviceType: "訪問介護" }, esc).includes(">訪問介護<"), "バッジに名前");
ok(serviceTypeBadge({}, esc).includes("badge-svc-none") && serviceTypeBadge({}, esc).includes("未設定"), "未設定のバッジ");
ok(serviceTypeBadge({ serviceType: "<b>x" }, esc).includes("&lt;b&gt;x"), "バッジはエスケープする");
{
  const h = serviceTypeOptionsHtml("福祉用具貸与", esc);
  ok(h.startsWith('<option value="">未設定</option>'), "先頭は未設定");
  eq((h.match(/<option /g) || []).length, EXPECTED.length + 1, "選択肢の数");
  const h2 = serviceTypeOptionsHtml("旧い名前", esc);
  ok(h2.includes("旧い名前（一覧にない値）"), "一覧に無い現在値も残す");
}

// ===== 重複の候補にしない（同じ事業所の別事業） =====
ok(differentServiceTypes({ serviceType: "福祉用具貸与" }, { serviceType: "特定福祉用具販売" }), "違う種別");
ok(!differentServiceTypes({ serviceType: "福祉用具貸与" }, { serviceType: "福祉用具貸与" }), "同じ種別");
ok(!differentServiceTypes({ serviceType: "福祉用具貸与" }, {}), "片方未設定は従来どおり");
{
  const base = { contactEmail: "a@ex.jp", contactPhone: "03-1111-2222", officeName: "A事業所" };
  const g1 = computeDuplicateGroups([
    { _id: "c1", ...base, serviceType: "福祉用具貸与" },
    { _id: "c2", ...base, serviceType: "特定福祉用具販売" },
  ], new Set());
  eq(g1.length, 0, "別の事業種別は重複グループにしない");
  const g2 = computeDuplicateGroups([
    { _id: "c1", ...base, serviceType: "福祉用具貸与" },
    { _id: "c2", ...base },
  ], new Set());
  eq(g2.length, 1, "片方が未設定なら重複の候補（従来どおり）");
  const g3 = computeDuplicateGroups([
    { _id: "c1", ...base, serviceType: "訪問介護" },
    { _id: "c2", ...base, serviceType: "訪問介護" },
  ], new Set());
  eq(g3.length, 1, "同じ事業種別は重複の候補");
}

// ===== コピーで作る案件 =====
const src = {
  _id: "SRC", caseNumber: 41, officeId: "OFF1", officeName: "テスト福祉用具", corpName: "株式会社テスト",
  contactName: "山田", contactEmail: "Yamada＠Ex.jp ", contactPhone: "０３－１２３４－５６７８",
  referralSource: "tadakayo", assignedUserId: "fujita@tadakayo.jp", assignedUserName: "藤田",
  serviceType: "福祉用具貸与", status: 11, subsidyCategory: "other", expectedSubsidyAmount: 42000,
  visitDate: "2026-11-05", quoteId: "Q1", orderFields: { a: 1 }, archived: false, inquiryIntent: "order",
};
{
  const NOW = { __ts: 1 };
  const r = buildCopiedCase(src, { serviceType: "特定福祉用具販売", caseNumber: 120, now: NOW });
  ok(r.ok, "コピーできる");
  const d = r.data;
  eq(d.caseNumber, 120, "新しい番号");
  eq(d.serviceType, "特定福祉用具販売", "選び直した事業種別");
  eq(d.status, 2, "確認中から始まる");
  eq(COPY_INITIAL_STATUS, 2, "初期ステータスの定数");
  for (const k of ["officeId", "officeName", "corpName", "contactName", "referralSource", "assignedUserId", "assignedUserName"]) {
    eq(d[k], src[k], `コピーする: ${k}`);
  }
  eq(d.contactEmail, normalizeEmail(src.contactEmail), "メールは normalizeEmail でそろえる（全角＠→半角）");
  ok(!/[＠\s]/.test(d.contactEmail), "メールに全角＠・空白が残らない");
  eq(d.contactPhone, "03-1234-5678", "電話は全角を半角に");
  ok(COPY_FIELDS.every((k) => k in d), "COPY_FIELDS がすべて入っている");
  // コピーしないもの
  for (const k of ["quoteId", "orderFields", "visitDate", "inquiryIntent", "archived"]) ok(!(k in d), `コピーしない: ${k}`);
  eq(d.subsidyCategory, null, "補助区分は新しく（コピーしない）");
  eq(d.expectedSubsidyAmount, null, "想定補助額はコピーしない");
  eq(d.copiedFrom, { caseId: "SRC", caseNumber: 41 }, "コピー元を持つ");
  eq(d.source, "manual", "流入経路は手動登録");
  ok(d.receivedAt === NOW && d.updatedAt === NOW, "受信日時・更新日時は now");
  eq(d.cardReaders, [], "カードリーダーは空");
}
eq(buildCopiedCase(src, { serviceType: "福祉用具貸与", caseNumber: 2, now: null }).ok, false, "同じ事業種別は不可");
eq(buildCopiedCase(src, { serviceType: "", caseNumber: 2 }).error, "事業種別を選んでください", "事業種別が空は不可");
eq(buildCopiedCase(src, { serviceType: "架空の種別", caseNumber: 2 }).ok, false, "一覧に無い事業種別は不可");
eq(buildCopiedCase(src, { serviceType: "訪問介護", caseNumber: 0 }).ok, false, "番号が無いと不可");
eq(buildCopiedCase(null, { serviceType: "訪問介護", caseNumber: 2 }).ok, false, "コピー元が無いと不可");
{
  const r = buildCopiedCase({ _id: "X", caseNumber: 5, assignedUserName: "残骸" }, { serviceType: "訪問介護", caseNumber: 6 });
  ok(r.ok && r.data.assignedUserId === null && r.data.assignedUserName === null, "担当IDが無ければ氏名も入れない");
  ok(r.data.officeId === null && r.data.referralSource === null, "無い項目は null");
}
{
  const t = copyActivityTexts(src, 120, "特定福祉用具販売");
  eq(t.source.subject, "コピーして #120 を作成（事業種別: 特定福祉用具販売）", "コピー元のメモ");
  eq(t.target.subject, "#41 からコピー", "コピー先のメモ");
  ok(t.target.body.includes("福祉用具貸与"), "コピー先のメモにコピー元の事業種別");
}

// ===== 事業所の新規登録 =====
{
  const r = buildNewOffice({
    corpName: " 株式会社テスト ", officeName: "テスト訪問介護", officeCode: "１２３４５６７８９０",
    postalCode: "1000001", prefecture: "東京都", city: "千代田区", addressDetail: "千代田1-1", phone: "０３－１１１１－２２２２",
  }, { now: "NOW" });
  ok(r.ok, "登録できる");
  eq(r.data.corpName, "株式会社テスト", "前後の空白を除く");
  eq(r.data.officeCode, "1234567890", "事業所番号は半角に");
  eq(r.data.postalCode, "100-0001", "郵便番号はハイフンつきに");
  eq(r.data.address, "東京都千代田区千代田1-1", "address は3つをつなげたもの");
  eq(r.data.phone, "03-1111-2222", "電話は半角に");
  eq(Object.keys(r.data).sort(), [...OFFICE_FORM_FIELDS, "address", "createdAt", "updatedAt"].sort(), "項目は既定のものだけ");
}
eq(buildNewOffice({ officeName: " " }).error, "事業所名を入れてください", "事業所名は必須");
eq(buildNewOffice({ officeName: "A", officeCode: "12345" }).ok, false, "事業所番号は10桁");
ok(buildNewOffice({ officeName: "A", officeCode: "" }).ok, "事業所番号は空でもよい");
eq(buildNewOffice({ officeName: "A", postalCode: "12-34" }).ok, false, "郵便番号の形");
eq(buildNewOffice({ officeName: "x".repeat(201) }).ok, false, "200字まで");
{
  const f = officeFormFromExisting({ corpName: "株式会社テスト", officeName: "テスト貸与", officeCode: "1111111111",
    postalCode: "100-0001", prefecture: "東京都", city: "千代田区", addressDetail: "1-1", phone: "03" });
  eq(f.officeCode, "", "事業所番号は引き継がない");
  eq(f.officeName, "テスト貸与", "事業所名は元の名前を入れて直してもらう");
  eq([f.corpName, f.prefecture, f.city, f.addressDetail, f.phone], ["株式会社テスト", "東京都", "千代田区", "1-1", "03"], "法人名・住所・電話を引き継ぐ");
  const g = officeFormFromExisting({ officeName: "古い", address: "大阪府堺市1-2" });
  eq(g.addressDetail, "大阪府堺市1-2", "分けて持っていない住所は addressDetail に丸ごと");
}

// ===== 画面の結線（静的検査） =====
const cd = rd("admin/js/case-detail.js"), cdh = rd("admin/case-detail.html");
ok(/from "\/js\/service-types\.js"/.test(cd) && /from "\/js\/case-copy\.js"/.test(cd), "案件詳細が一覧と組み立てを読む");
ok(cdh.includes('id="serviceTypeSelect"') && cdh.includes('id="servicePlanHint"'), "案件詳細に事業種別の選択と目安");
ok(/事業種別変更 → /.test(cd) && /変更前: /.test(cd), "事業種別の変更を対応記録に残す");
ok(!/subsidyCategory:\s*plan/.test(cd), "プランの目安で subsidyCategory を書き換えない");
ok(cdh.includes('id="copyCaseBtn"') && cdh.includes('id="copyCaseModal"'), "コピーのボタンとモーダル");
ok(/runTransaction\(db,/.test(cd) && /doc\(db, "_counters", "cases"\)/.test(cd), "コピーの番号は _counters/cases をトランザクションで払い出す");
ok(/canCopy = !isViewer\(myRole\)/.test(cd), "コピーは閲覧のみに出さない");
ok(/!differentServiceTypes\(currentCase, c\)/.test(cd), "案件詳細の重複候補から別の事業種別を外す");
ok(/key: "serviceType", label: "事業種別"/.test(cd), "重複の統合で事業種別の食い違いを選ばせる");
const cs = rd("admin/js/cases.js"), kb = rd("admin/js/kanban.js"), of = rd("admin/js/offices.js");
ok(/serviceTypeBadge\(c, escHtml\)/.test(cs), "案件一覧にラベル");
ok(/serviceTypeBadge\(c, escHtml\)/.test(kb), "カンバンにラベル");
ok(/serviceTypeBadge\(c, esc\)/.test(of) && of.includes("<th>事業種別</th>"), "事業所画面の案件の並びにラベル");
ok(/"事業種別"\];/.test(cs), "CSV の最後に事業種別");
ok(rd("admin/cases.html").includes('id="newServiceType"'), "新規案件で事業種別を選べる");
// 事業所の新規登録
const ofh = rd("admin/offices.html"), oc = rd("admin/js/office-create.js");
ok(ofh.includes('id="newOfficeBtn"') && ofh.includes('id="newOfficeModal"'), "事業所の登録ボタンとモーダル");
for (const id of ["nfCorpName", "nfOfficeName", "nfOfficeCode", "nfPostalCode", "nfPrefecture", "nfCity", "nfAddressDetail", "nfPhone"]) {
  ok(ofh.includes(`id="${id}"`), `事業所の登録の入力欄: ${id}`);
}
ok(/\$\("newOfficeBtn"\)\.style\.display = canEdit/.test(of), "登録ボタンは閲覧のみに出さない");
ok(of.includes("この事業所の情報で新しい事業所を作る"), "…メニューにコピーの項目");
ok(/addDoc\(collection\(db, "offices"\)/.test(oc) && !/updateDoc|setDoc|deleteDoc|writeBatch|runTransaction/.test(oc), "office-create.js は offices への追加だけ");
ok(/from "\/js\/fs\.js"/.test(oc), "office-create.js は fs.js 経由（練習モード）");
// 帳票
const sp = rd("admin/js/supply-print.js"), inv = rd("admin/js/invoice-doc.js");
ok(/docServiceType \? `<div class="meta">事業種別: /.test(sp), "領収証に事業種別（未設定なら出さない）");
ok(/serviceType: docServiceType/.test(sp), "請求書に事業種別を渡す");
ok(/opts\.serviceType \? `<div class="meta">事業種別: /.test(inv), "請求書の描画は渡されたときだけ出す");
ok(!/serviceType/.test(inv.slice(inv.indexOf("export function invoiceTotals"), inv.indexOf("export function invoiceTotals") + 3000).split("\nexport function ")[0]), "invoiceTotals は事業種別に触れない");

console.log(`OK test-service-types: ${n} checks passed`);
