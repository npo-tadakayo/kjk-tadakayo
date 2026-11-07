// admin/js/case-copy.js — 「この案件をコピーして、別の事業種別で作る」と「事業所の新規登録」で書く項目の組み立て（2026-11-01）
// 純粋関数のみ（DOM・Firestore に触れない）。Firestore の serverTimestamp() などは引数 now で受け取る。
// テスト: node scripts/test-service-types.mjs
import { normalizeEmail, normalizePhone } from "./normalize.js";
import { isServiceType } from "./service-types.js";

// コピーして作る案件の初期ステータス。
// 既存の新規作成（cases.js）は 1 新規受信 だが、1 のままだと案件一覧の「初期連絡の超過」（申込から5営業日）に
// 数えられてしまう。コピーは同じ事業所・同じ担当者で、もう連絡が取れている前提なので 2 確認中 から始める。
export const COPY_INITIAL_STATUS = 2;

// コピーする項目（同じ事業所・担当者・連絡先・紹介元・担当営業）。見積・出荷・請求・入金・活動・書類はコピーしない
export const COPY_FIELDS = [
  "officeId", "officeName", "corpName", "contactName", "contactEmail", "contactPhone",
  "referralSource", "assignedUserId", "assignedUserName",
];

const s = (v) => (v == null ? "" : String(v)).trim();

/**
 * コピーで作る案件の項目を組み立てる。
 * src: コピー元の案件（_id・caseNumber を含む）／serviceType: 選び直した事業種別（一覧の正式名）
 * sourceServiceType: コピー元が未設定のとき、コピー元に入れる事業種別（必須）。
 *   コピー元が未設定のまま別の案件を作ると、両方の事業所名・メール・電話が同じで「違う事業種別」と判定できず、
 *   重複の候補に出てしまう（独立レビュー P1）。コピー元に入っているときは無視する（コピー元の値を使う）。
 * caseNumber: 払い出した新しい案件番号／now: serverTimestamp() など
 * 戻り値: { ok: true, data, sourceServiceType, setSource } または { ok: false, error }
 *   setSource=true のとき、呼び出し側はコピー元の serviceType を sourceServiceType にする（同じトランザクションで）
 */
export function buildCopiedCase(src, { serviceType, sourceServiceType, caseNumber, now } = {}) {
  if (!src || !src._id) return { ok: false, error: "コピー元の案件が分かりません" };
  const srcType = s(src.serviceType);
  const setSource = !srcType;
  const srcEff = srcType || s(sourceServiceType);
  if (setSource && !isServiceType(srcEff)) return { ok: false, error: "この案件（コピー元）の事業種別を選んでください" };
  if (!isServiceType(serviceType)) return { ok: false, error: "新しい案件の事業種別を選んでください" };
  if (srcEff === serviceType) {
    return { ok: false, error: "コピー元と同じ事業種別です。別の事業種別を選んでください" };
  }
  if (!Number.isInteger(caseNumber) || caseNumber <= 0) return { ok: false, error: "案件番号を払い出せませんでした" };
  const data = {
    caseNumber,
    officeId: src.officeId || null,
    officeName: s(src.officeName),
    corpName: s(src.corpName),
    contactName: s(src.contactName),
    contactEmail: normalizeEmail(src.contactEmail || ""),
    contactPhone: normalizePhone(src.contactPhone || ""),
    referralSource: src.referralSource || null,
    assignedUserId: src.assignedUserId || null,
    assignedUserName: src.assignedUserId ? (src.assignedUserName || null) : null,
    serviceType,
    source: "manual", status: COPY_INITIAL_STATUS,
    copiedFrom: { caseId: src._id, caseNumber: src.caseNumber ?? null },
    receivedAt: now ?? null, updatedAt: now ?? null, cardReaders: [],
    subsidyCategory: null, expectedSubsidyAmount: null, lostReason: null,
    orderedAt: null, completedAt: null,
  };
  return { ok: true, data, sourceServiceType: srcEff, setSource };
}

/**
 * コピー元・コピー先に残す活動（memo）の件名と本文。
 * sourceSet: コピーのときにコピー元の事業種別も入れたなら、その事業種別（sourceUpdate に変更の記録を返す）
 */
export function copyActivityTexts(src, newCaseNumber, serviceType, sourceSet = "") {
  return {
    sourceUpdate: sourceSet ? {
      subject: `事業種別変更 → ${sourceSet}`,
      body: `変更前: 未設定（#${newCaseNumber} をコピーで作るときに設定）`,
    } : null,
    source: {
      subject: `コピーして #${newCaseNumber} を作成（事業種別: ${serviceType}）`,
      body: "同じ事業所・担当者で、別の事業種別の案件を作りました。見積・出荷・請求・入金・活動・書類はコピーしていません。",
    },
    target: {
      subject: `#${src?.caseNumber ?? "—"} からコピー`,
      body: `事業種別: ${serviceType}（コピー元の事業種別: ${s(src?.serviceType) || sourceSet || "未設定"}）`,
    },
  };
}

// 事業所の新規登録で入れる項目（offices の既存の項目名に合わせる。Functions の見積もり作成と同じ形）
export const OFFICE_FORM_FIELDS = [
  "corpName", "officeName", "officeCode", "postalCode", "prefecture", "city", "addressDetail", "phone",
];
const MAX_LEN = 200;

/**
 * 事業所の新規登録の項目を組み立てる。address は prefecture＋city＋addressDetail をつなげたもの
 * （functions/index.js の見積もり作成・areaOf・見積書の宛名と同じ持ち方）。
 * 事業所番号（officeCode）は介護保険の事業所番号（10桁の数字）。空欄可。全角は半角にそろえる。
 */
export function buildNewOffice(input, { now } = {}) {
  const v = {};
  for (const k of OFFICE_FORM_FIELDS) {
    const t = s(input && input[k]);
    if (t.length > MAX_LEN) return { ok: false, error: "200字以内で入れてください" };
    v[k] = t;
  }
  if (!v.officeName) return { ok: false, error: "事業所名を入れてください" };
  v.officeCode = v.officeCode.normalize("NFKC").replace(/[\s-]/g, "");
  if (v.officeCode && !/^\d{10}$/.test(v.officeCode)) return { ok: false, error: "事業所番号は10桁の数字で入れてください" };
  // ハイフンに似た文字（ー −  ‐ ‑ – — ― ｰ など）は半角ハイフンにそろえる（NFKC では変わらないものがある）
  v.postalCode = v.postalCode.normalize("NFKC").replace(/\s/g, "").replace(/[ー−‐‑‒–—―ｰ﹣－]/g, "-");
  if (v.postalCode && !/^\d{3}-?\d{4}$/.test(v.postalCode)) return { ok: false, error: "郵便番号は7桁の数字で入れてください（例: 100-0001）" };
  if (/^\d{7}$/.test(v.postalCode)) v.postalCode = `${v.postalCode.slice(0, 3)}-${v.postalCode.slice(3)}`;
  v.phone = normalizePhone(v.phone);
  const data = {
    ...v,
    address: [v.prefecture, v.city, v.addressDetail].filter(Boolean).join(""),
    createdAt: now ?? null, updatedAt: now ?? null,
  };
  return { ok: true, data };
}

/** 「この事業所の情報で新しい事業所を作る」の入力の初期値。事業所名は元の名前を入れておき、画面で直してもらう
 *  （元と同じ名前のままでは登録しない＝画面側で止める）。事業所番号は事業所ごとに違うので空にする */
export function officeFormFromExisting(o) {
  const x = o || {};
  return {
    corpName: s(x.corpName), officeName: s(x.officeName || x.name), officeCode: "",
    postalCode: s(x.postalCode), prefecture: s(x.prefecture), city: s(x.city),
    // 分けて持っていない古い事業所は address を丸ごと addressDetail に入れる（つなげたとき元の住所に戻る）
    addressDetail: x.prefecture || x.city || x.addressDetail ? s(x.addressDetail) : s(x.address),
    phone: s(x.phone),
  };
}
