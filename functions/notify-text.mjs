// functions/notify-text.mjs — Chat 通知（N1 担当決定・N2/N3 日次まとめ・N4 承諾書の署名完了）の分類と文面。
// 純粋 ESM（firebase に触れない）。index.js（CommonJS）からは import() で遅延ロードして使う。
// 設計: docs/CRM改善_設計_20261021.md §3。テスト: node scripts/test-notify-text.mjs
//
// 🔴 文面に入れてよいのは「案件番号・地域・事業所名・状態・日数」まで。
//    利用者の情報・事業所の連絡先（ご担当者名・電話・メール）・承諾書の確認者名は入れない（CRM で見られる）。
//
// 定数は admin/js/constants.js と同じ値（コピーではなくテストで一致を確かめる）。
// 初期連絡の判定は ./first-contact.mjs（admin/js/first-contact.js とバイト単位で同じ。scripts/check-shared-sync.sh で検査）。

import { countBusinessDaysOver, JP_HOLIDAYS, jstDateString } from "./first-contact.mjs";

// ===== 定数（admin/js/constants.js と一致させる。test-notify-text.mjs が検査）=====
export const STATUS_LABELS = {
  1: "新規受信", 2: "確認中", 3: "受注確定", 4: "失注",
  5: "担当者決定", 6: "事前準備中", 7: "伴走支援待ち",
  8: "伴走支援実施済", 9: "書類準備完了・申請ガイド中",
  10: "申請完了・採択待ち", 11: "採択・入金待ち",
  12: "アフターフォロー中", 13: "案件完了",
};
export const ENGAGED_STATUSES = [3, 5, 6, 7, 8, 9, 10, 11, 12, 13]; // 受注確定以降（画面の「担当営業が決まっていない案件」と同じ）
export const TERMINAL = [4, 13];                                     // 失注・完了（停滞の対象外）
export const ACTIVE_PRE_APPLY = [1, 2, 3, 5, 6, 7, 8, 9];            // 未申請の進行中（期限間近の対象）
export const STALE_DAYS = 7;                                         // 停滞＝最終更新からこの日数以上
export const DEADLINE = new Date("2027-03-12T23:59:59+09:00");       // 申請期限の既定値（settings.subsidyDeadline で上書き）

// ===== 通知だけの定数 =====
export const AWAIT_DEPOSIT_DAYS = 14;   // 入金待ち(11)のまま、この日数以上更新なし
export const DEADLINE_NEAR_DAYS = 30;   // 申請期限まで残りこの日数以下で「期限間近」
export const SECTION_LIMIT = 10;        // 各節に並べる件数の上限（超えた分は「…ほか N 件」）
export const ADMIN_URL = "https://kjk-tadakayo-admin.web.app";

const DAY_MS = 86400000;

/** settings.subsidyDeadline（"YYYY-MM-DD"）があればその日の 23:59:59 JST、なければ既定値。constants.js と同じ規則。 */
export function resolveDeadline(settings) {
  const v = settings && settings.subsidyDeadline;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + "T23:59:59+09:00");
  return DEADLINE;
}

// Firestore Timestamp（toDate / toMillis）・Date・文字列・数値 → ミリ秒。取れなければ null。
function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.toDate === "function") return v.toDate().getTime();
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
// now から見て何日前か（切り捨て。constants.js の daysSince と同じ数え方）。値が無ければ null。
function daysSinceAt(ts, nowMs) {
  const t = toMs(ts);
  return t == null ? null : Math.floor((nowMs - t) / DAY_MS);
}

/** Chat に載せる文字列から書式・メンションに化ける記号を除く（< > * _ ~ `）。 */
export function cleanText(s) {
  return String(s ?? "").replace(/[<>*_~`]/g, "").trim();
}

// 表示名（メールの @ より前を最後の手段にする。アドレスそのものは出さない）
function nameOf(user) {
  if (!user) return "";
  const n = cleanText(user.displayName || user.name || "");
  if (n) return n;
  return cleanText(String(user.email || "").split("@")[0]);
}

/**
 * 本人へのメンション。users/{email}.chatUserId が数字5〜30桁のときだけ `<users/ID>`。
 * それ以外（未設定・形式違い）は「名前さん」（メンションにならない普通の文字）。
 */
export function mentionOf(user) {
  const id = String((user && user.chatUserId) ?? "").trim();
  if (/^\d{5,30}$/.test(id)) return `<users/${id}>`;
  const n = nameOf(user);
  return n ? `${n}さん` : "担当者さん";
}
// メンションなら「<users/ID> さん」、名前ならそのまま（「名前さん」に さん を重ねない）
function calleeOf(user) {
  const m = mentionOf(user);
  return m.startsWith("<users/") ? `${m} さん` : m;
}

/** 通知・集計の対象か（対象外＝アーカイブ済みは除く。統合で畳まれた案件も archived になっている） */
export function isLive(c) {
  return !!c && !c.archived;
}

const emailKey = (e) => String(e || "").trim().toLowerCase();

/**
 * 案件を日次まとめの節に振り分ける。
 * @param {object[]} cases  cases のドキュメント（id か _id・status・assignedUserId・updatedAt・receivedAt/createdAt・archived …）
 * @param {{now?:Date, deadline?:Date, holidays?:string[]}} opts
 * @returns {{deadline:Date, deadlineDays:number, deadlineNearAll:number,
 *   overall:{firstContactOver:Entry[], newUnassigned:Entry[], engagedUnassigned:Entry[], staleUnassigned:Entry[]},
 *   assignees:Object<string,{email:string, newReceived:Entry[], stale:Entry[], awaitingDeposit:Entry[], deadlineNear:Entry[], firstContactOver:Entry[]}>}}
 *   Entry = { c: 案件, days: number|null }（days は節ごとの日数: 超過営業日・更新なしの日数）
 */
export function classifyCases(cases, { now = new Date(), deadline = DEADLINE, holidays = JP_HOLIDAYS } = {}) {
  const nowMs = now.getTime();
  const deadlineDays = Math.ceil((deadline.getTime() - nowMs) / DAY_MS);
  const deadlineNear = deadlineDays <= DEADLINE_NEAR_DAYS;
  const overall = { firstContactOver: [], newUnassigned: [], engagedUnassigned: [], staleUnassigned: [] };
  const assignees = {};
  let deadlineNearAll = 0;
  const bucketOf = (email) => (assignees[emailKey(email)] ||= {
    email: String(email).trim(), newReceived: [], stale: [], awaitingDeposit: [], deadlineNear: [], firstContactOver: [],
  });

  for (const c of cases || []) {
    if (!isLive(c)) continue;
    const st = Number(c.status);
    const assigned = emailKey(c.assignedUserId) !== "";
    const since = daysSinceAt(c.updatedAt, nowMs);
    // 初期連絡の超過: 新規受信(1)のままの案件だけ（確認中(2)以降は連絡済みとみなす）。申込日は receivedAt → createdAt
    const fcOver = st === 1 ? countBusinessDaysOver(c.receivedAt || c.createdAt, now, holidays) : 0;
    const isStale = !TERMINAL.includes(st) && since != null && since >= STALE_DAYS;
    const isNear = deadlineNear && ACTIVE_PRE_APPLY.includes(st);
    if (isNear) deadlineNearAll++;

    if (fcOver > 0) overall.firstContactOver.push({ c, days: fcOver });
    if (!assigned) {
      if (st === 1) overall.newUnassigned.push({ c, days: null });
      if (ENGAGED_STATUSES.includes(st)) overall.engagedUnassigned.push({ c, days: null });
      if (isStale) overall.staleUnassigned.push({ c, days: since });
      continue;
    }
    const b = bucketOf(c.assignedUserId);
    if (st === 1) b.newReceived.push({ c, days: null });
    if (isStale) b.stale.push({ c, days: since });
    if (st === 11 && since != null && since >= AWAIT_DEPOSIT_DAYS) b.awaitingDeposit.push({ c, days: since });
    if (isNear) b.deadlineNear.push({ c, days: null });
    if (fcOver > 0) b.firstContactOver.push({ c, days: fcOver });
  }
  // 担当ごとの空の入れ物は作らないが、念のため全部空のものは落とす
  for (const k of Object.keys(assignees)) if (!assigneeHasItems(assignees[k])) delete assignees[k];
  return { deadline, deadlineDays, deadlineNearAll, overall, assignees };
}

const ASSIGNEE_KEYS = ["newReceived", "stale", "awaitingDeposit", "deadlineNear", "firstContactOver"];
function assigneeHasItems(b) { return !!b && ASSIGNEE_KEYS.some((k) => (b[k] || []).length > 0); }

// 1行: ・#123 【大阪府 豊中市】○○事業所（新規受信）…補足
function lineOf(entry, regionOf, extra) {
  const c = entry.c;
  const region = typeof regionOf === "function" ? cleanText(regionOf(c) || "") : "";
  const office = cleanText(c.officeName) || "(名称未登録)";
  const label = STATUS_LABELS[Number(c.status)] || "?";
  const ex = extra ? extra(entry) : "";
  return `・#${cleanText(c.caseNumber) || "?"} ${region}${office}（${label}）${ex}`;
}
function section(title, entries, regionOf, extra) {
  if (!entries || !entries.length) return "";
  const shown = entries.slice(0, SECTION_LIMIT).map((e) => lineOf(e, regionOf, extra)).join("\n");
  const more = entries.length > SECTION_LIMIT ? `\n…ほか ${entries.length - SECTION_LIMIT} 件` : "";
  return `\n*${title}（${entries.length}件）*\n${shown}${more}`;
}
const fcExtra = (e) => ` 初期連絡 ${e.days}営業日超過`;
const staleExtra = (e) => ` ${e.days}日更新なし`;

/** 申請期限の和文（JST）。例: 2027年3月12日 */
export function deadlineText(deadline) {
  const ymd = jstDateString(deadline instanceof Date ? deadline : DEADLINE) || "";
  const [y, m, d] = ymd.split("-").map(Number);
  return y ? `${y}年${m}月${d}日` : "";
}

/**
 * 全体1通（担当なし・全員で見るもの）。載せるものが無ければ null。
 * @param {ReturnType<typeof classifyCases>} cls
 * @param {{regionOf?:(c:object)=>string}} opts  regionOf は呼び出し側（index.js の offices から【都道府県 市区町村】を作る関数）
 */
export function buildOverallDigest(cls, { regionOf } = {}) {
  const o = cls.overall;
  const body = [
    section("🚨 初期連絡が申込から5営業日を超えた新規受信", o.firstContactOver, regionOf, fcExtra),
    section("⏳ 未割当の新規案件", o.newUnassigned, regionOf),
    section("👤 受注確定以降で担当営業が決まっていない案件", o.engagedUnassigned, regionOf),
    section(`⚠️ 担当なしで${STALE_DAYS}日以上更新なし`, o.staleUnassigned, regionOf, staleExtra),
  ].filter(Boolean);
  if (!body.length) return null;
  const near = cls.deadlineDays <= DEADLINE_NEAR_DAYS ? `・未申請 ${cls.deadlineNearAll} 件` : "";
  return [
    `🗓 *タダカヨCRM 日次フォローアップ*（申請期限 ${deadlineText(cls.deadline)} まで残り ${cls.deadlineDays} 日${near}）`,
    ...body,
    `\n👉 案件一覧: ${ADMIN_URL}/cases.html`,
  ].join("\n");
}

/**
 * 担当ごとの1通（その人の未対応が1件以上のときだけ）。無ければ null。
 * @param {{email?:string, displayName?:string, chatUserId?:string}|null|undefined} user  users/{email}（無い担当は undefined でよい）
 * @param {object} bucket  classifyCases().assignees[メール小文字]
 */
export function buildAssigneeDigest(user, bucket, { regionOf, deadlineDays } = {}) {
  if (!assigneeHasItems(bucket)) return null;
  const who = user || { email: bucket.email };
  const days = Number.isFinite(deadlineDays) ? `（申請期限まで残り ${deadlineDays} 日）` : "";
  const body = [
    section("🚨 初期連絡の期限超過", bucket.firstContactOver, regionOf, fcExtra),
    section("📥 新規受信のまま", bucket.newReceived, regionOf),
    section(`⚠️ ${STALE_DAYS}日以上更新なし`, bucket.stale, regionOf, staleExtra),
    section(`💰 入金待ちが${AWAIT_DEPOSIT_DAYS}日以上`, bucket.awaitingDeposit, regionOf, staleExtra),
    section(`📋 申請期限が近い未申請${days}`, bucket.deadlineNear, regionOf),
  ].filter(Boolean);
  return [
    `🗓 ${calleeOf(who)}、担当案件で対応が必要なものがあります`,
    ...body,
    `\n👉 自分の担当: ${ADMIN_URL}/cases.html?assignee=me`,
  ].join("\n");
}

/**
 * N1 担当が決まったときの本人への通知。
 * @param {{kase:object, assignee?:object, assignedBy?:object|string, regionLabel?:string, caseId?:string}} p
 *   assignee   … users/{担当のメール}（無ければ {email}）
 *   assignedBy … 設定した人（users のドキュメントか表示名）。担当本人と同じなら「自分で設定」としてメンションしない
 */
export function assigneeNoticeText({ kase, assignee, assignedBy, regionLabel, caseId } = {}) {
  const c = kase || {};
  const by = typeof assignedBy === "string" ? { displayName: assignedBy } : (assignedBy || null);
  const self = !!(by && assignee && by.email && emailKey(by.email) === emailKey(assignee.email));
  const head = `👤 担当営業が決まりました [案件 #${cleanText(c.caseNumber) || "?"}]`;
  const who = self
    ? `${nameOf(assignee) || "担当者"}さんが担当になりました（ご自身で設定）`
    : `${calleeOf(assignee || {})}、担当をお願いします${by && nameOf(by) ? `（設定: ${nameOf(by)}）` : ""}`;
  return [head, who, officeLine(c, regionLabel), linkLine(caseId ?? c.id ?? c._id)].filter(Boolean).join("\n");
}

/**
 * N4 承諾書にオンラインで署名されたときの通知。確認者名（署名した人の名前）は載せない。
 * @param {{kase:object, assignee?:object|null, regionLabel?:string, caseId?:string}} p
 */
export function consentSignedText({ kase, assignee, regionLabel, caseId } = {}) {
  const c = kase || {};
  const who = assignee ? `${calleeOf(assignee)}、内容をご確認ください` : "担当: 未割当（担当を決めてください）";
  return [
    `✍️ 承諾書にオンラインで署名されました [案件 #${cleanText(c.caseNumber) || "?"}]`,
    who, officeLine(c, regionLabel), linkLine(caseId ?? c.id ?? c._id),
  ].filter(Boolean).join("\n");
}

function officeLine(c, regionLabel) {
  const label = STATUS_LABELS[Number(c.status)];
  return `事業所: ${cleanText(regionLabel || "")}${cleanText(c.officeName) || "(名称未登録)"}${label ? `（${label}）` : ""}`;
}
function linkLine(id) {
  return id ? `👉 ${ADMIN_URL}/case-detail.html?id=${encodeURIComponent(String(id))}` : "";
}

/**
 * 祝日の表がその日の年まで入っているか（未登録の年は祝日が平日扱いになり、初期連絡の超過が早く出る）。
 * 日次まとめで false のときは管理者向けに「祝日の表を更新して」と添える用途。
 * @param {string|Date} day  "YYYY-MM-DD" または Date（JST で年を取る）
 */
export function holidaysCover(day, holidays = JP_HOLIDAYS) {
  const ymd = typeof day === "string" ? day : jstDateString(day);
  const y = Number(String(ymd || "").slice(0, 4));
  if (!y) return false;
  return (holidays || []).some((h) => Number(String(h).slice(0, 4)) === y);
}
