// 記録のずれを防ぐ判定（2026-11-10・設計書 docs/CRM改善_設計書_20261110.md §3 点検4・点検5）。
// 純粋関数のみ（DOM・Firestore に触れない）。テスト: node scripts/test-record-gaps-case.mjs
// 呼び出し元: consent-admin.js（承諾書の署名依頼メール）／pre-guide.js（事前準備のご案内メール）／
//             case-detail.js（伴走支援の記録を保存したあとの「伴走支援実施済にしますか」）
// import は相対パス（ブラウザでは /js/ 配下として、node のテストでもそのまま読める）。

import { STATUS_ORDER, STATUS_LABELS, LOST } from "./constants.js";

// ===== 点検4: メール送信の成否と、送信記録の成否を分ける =====
// メールは送れたのに記録（mailedAt など）の保存だけ失敗したとき、「送信に失敗しました」と出すと再送＝二重送信を招く。
// 送れたかどうかと、記録できたかどうかを分けて知らせ、記録だけをやり直せるようにする。

/** 記録だけをやり直すボタンの文言 */
export const RECORD_RETRY_LABEL = "記録だけやり直す";

const errText = (e) => String((e && e.message) || e || "不明なエラー");

// 送れたかどうか分からないエラー（2026-11-10 レビュー 中-A）。通信のタイムアウト・接続断は「送れたかもしれない」。
// 古い sendCaseEmail（2026-11-12 より前）は、Gmail で送ったあとに対応記録・cases の更新が失敗しても HttpsError("internal") を投げ、
// Gmail の送信自体の失敗も internal だったので区別できなかった。
// 新しい sendCaseEmail（functions/case-mail.js）は、送信後の失敗を { ok:true, sent:true, recordError } で返し（sendResultOf で読む）、
// 送る前の失敗・Gmail の 4xx は failed-precondition（はっきりした失敗）、Gmail の 5xx・通信の失敗だけを internal で返す
const AMBIGUOUS_CODES = ["internal", "deadline-exceeded", "unavailable", "unknown"];

/** エラーの code（"functions/internal" のような接頭辞は外す。無ければ ""） */
export function errorCodeOf(err) {
  const c = String((err && err.code) || "");
  return c.includes("/") ? c.slice(c.lastIndexOf("/") + 1) : c;
}

/** 送れたかどうか分からないエラーか（明確な失敗＝invalid-argument・permission-denied 等は false） */
export function isAmbiguousSendError(err) {
  return AMBIGUOUS_CODES.includes(errorCodeOf(err));
}

/** 「送れたか不明」のあと、もう一度送る前に1回はさむ確認 */
export const RESEND_AFTER_UNKNOWN_CONFIRM_TEXT =
  "前回の送信は、送れたかどうか確認できませんでした。すでに送られているかもしれません。\n"
  + "対応記録に「メール送信」の行が出ていないか確かめましたか？\n\n（OK で送信します）";

/**
 * 送信と記録の結果を分類する。
 * @param {{sendError?:unknown, recordError?:unknown}} r  sendError があれば送信の段階で失敗（記録はしていない）
 * @returns {{kind:"ok"|"send_failed"|"send_unknown"|"record_failed", canResend:boolean, confirmBeforeResend:boolean, message:string}}
 *   canResend … 送信ボタンを送信のまま戻してよいか（record_failed では false＝記録だけやり直す）
 *   confirmBeforeResend … 次に送るとき RESEND_AFTER_UNKNOWN_CONFIRM_TEXT を1回はさむ
 */
export function classifySendOutcome({ sendError, recordError } = {}) {
  if (sendError) {
    if (isAmbiguousSendError(sendError)) {
      return {
        kind: "send_unknown", canResend: true, confirmBeforeResend: true,
        message: "送れたかどうか確認できませんでした。\n"
          + `理由: ${errText(sendError)}\n\n`
          + "対応記録に「メール送信」の行が出ていないか確かめてから、もう一度送ってください（出ていれば送信済みです）。",
      };
    }
    return { kind: "send_failed", canResend: true, confirmBeforeResend: false, message: `送信に失敗しました: ${errText(sendError)}` };
  }
  if (recordError) {
    return {
      kind: "record_failed", canResend: false, confirmBeforeResend: false,
      message: "メールは送信済みです。記録だけ失敗しました（再送しないでください）。\n"
        + `理由: ${errText(recordError)}\n\n`
        + `「${RECORD_RETRY_LABEL}」を押すと、メールは送らずに記録だけを保存し直します。`,
    };
  }
  return { kind: "ok", canResend: true, confirmBeforeResend: false, message: "" };
}

/** 記録のやり直しも失敗したときの文言（再送させない） */
export function recordRetryFailedText(err) {
  return `記録のやり直しにも失敗しました（メールは送信済みです。再送しないでください）: ${errText(err)}\n`
    + `時間をおいて「${RECORD_RETRY_LABEL}」をもう一度押してください。`;
}

/** 送信済み・記録待ちのまま閉じようとしたときの確認文 */
export const CLOSE_WITH_PENDING_RECORD_TEXT =
  "メールは送信済みですが、記録がまだ保存できていません。\n"
  + "閉じても、このタブで同じボタンから開き直せば「記録だけやり直す」から続けられます。メールを再送しないでください。\n\n閉じますか？";

// ===== 記録待ち（送信済み・記録失敗）を覚えておく（2026-11-10 レビュー 中-B） =====
// モーダルを閉じても・再読み込みしても再送させないため、sessionStorage（このタブだけ）に持つ。
// キーは「種類（consent＝承諾書／preGuide＝事前案内）＋案件ID」。保存する値は宛先・送信日時（ISO）と、
// 承諾書なら書き込み先の依頼を照合する印 reqKey（依頼IDの SHA-256 の16進の先頭16文字）だけ。
// 依頼IDそのもの（署名ページの URL の鍵）・本文・氏名は sessionStorage に入れない（2026-11-10 追加修正）。
// 同じページの中ではモジュール変数に依頼IDを持ってよい（照合が要らない）。
// sessionStorage が使えない（例外を投げる）とき・印が計算できない（crypto.subtle が無い）ときはモジュール変数だけで動く

export const PENDING_KINDS = ["consent", "preGuide"];
const memPending = new Map();

/** 記録待ちのキー */
export function pendingKey(kind, caseId) {
  if (!PENDING_KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  return `kjk.mailRecordPending.${kind}.${caseId || ""}`;
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

function subtleOf(subtle) {
  if (subtle !== undefined) return subtle;
  try { return globalThis.crypto?.subtle || null; } catch { return null; }
}

/**
 * 依頼IDから照合用の印を作る（SHA-256 の16進の先頭16文字）。計算できなければ ""。
 * @param {string} reqId
 * @param {SubtleCrypto|null} [subtle]  省略時 globalThis.crypto.subtle（テストでは null を渡して「無い」環境にする）
 */
export async function reqKeyOf(reqId, subtle) {
  const s = subtleOf(subtle);
  if (!reqId || !s || typeof s.digest !== "function") return "";
  try {
    const buf = await s.digest("SHA-256", new TextEncoder().encode(String(reqId)));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch { return ""; }
}

// sessionStorage に書く値（宛先・送信日時・reqKey・tl だけ。reqId・件名・本文は決して入れない）
// tl … 対応記録（activities の gmail_sent）がまだ書けていない印（サーバーが recordError を返したとき。2026-11-12）
function storedValueOf(v) {
  const out = { to: String(v.to), sentAt: String(v.sentAt) };
  if (v.reqKey) out.reqKey = String(v.reqKey);
  if (v.tl) out.tl = true;
  return out;
}

/**
 * 記録待ちを保存する。storage は省略時 sessionStorage（テストでは代役を渡す）。
 * 承諾書（reqId あり）で印 reqKey が無いときは、照合できないので sessionStorage には書かずモジュール変数だけ。
 * @param {"consent"|"preGuide"} kind
 * @param {string} caseId
 * @param {{to:string, sentAt:string, reqId?:string, reqKey?:string, tl?:boolean}} v  tl＝対応記録がまだ（サーバーの recordError）
 * @returns {{to:string, sentAt:string, reqId?:string, reqKey?:string, tl?:boolean}|null}  モジュール変数に持った値（reqId を含みうる）
 */
export function savePending(kind, caseId, v, storage) {
  const key = pendingKey(kind, caseId);
  if (!v || typeof v !== "object" || !v.to || !v.sentAt) return null;
  const mem = { to: String(v.to), sentAt: String(v.sentAt) };
  if (v.reqId) mem.reqId = String(v.reqId);
  if (v.reqKey) mem.reqKey = String(v.reqKey);
  if (v.tl) mem.tl = true;
  memPending.set(key, mem);
  if (mem.reqId && !mem.reqKey) return mem; // 印が無い承諾書は sessionStorage に書かない
  try { storageOf(storage)?.setItem(key, JSON.stringify(storedValueOf(mem))); } catch { /* 使えなければモジュール変数だけ */ }
  return mem;
}

/**
 * 記録待ちを読む（無ければ null）。同じページの中のモジュール変数を先に見る。
 * sessionStorage に古い形式（生の reqId 入り）が残っていたら、読んだ時点で捨てる。
 */
export function loadPending(kind, caseId, storage) {
  const key = pendingKey(kind, caseId);
  if (memPending.has(key)) return memPending.get(key);
  let st = null;
  try { st = storageOf(storage); } catch { st = null; }
  try {
    const raw = st?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || "reqId" in v || !v.to || !v.sentAt) { // 古い形式・壊れた値は捨てる
      try { st.removeItem(key); } catch { /* 同上 */ }
      return null;
    }
    return storedValueOf(v);
  } catch {
    try { st?.removeItem(key); } catch { /* 同上 */ }
    return null;
  }
}

/** 記録待ちを消す（記録が成功したとき・記録先が見つからないとき） */
export function clearPending(kind, caseId, storage) {
  const key = pendingKey(kind, caseId);
  memPending.delete(key);
  try { storageOf(storage)?.removeItem(key); } catch { /* 同上 */ }
}

/**
 * 承諾書の記録待ちの書き込み先を、画面が読み込んでいる依頼（未署名）の ID から探す。
 * モジュール変数の reqId があればそのまま照合、無ければ印 reqKey を各候補から計算して照合する。
 * @param {{reqId?:string, reqKey?:string}|null} pending
 * @param {string[]} candidateIds  この案件の未署名の依頼ID
 * @param {SubtleCrypto|null} [subtle]
 * @returns {Promise<string|null>}  一致した依頼ID（無ければ null）
 */
export async function matchPendingReq(pending, candidateIds, subtle) {
  if (!pending) return null;
  const ids = (candidateIds || []).filter(Boolean).map(String);
  if (pending.reqId) return ids.includes(pending.reqId) ? pending.reqId : null;
  if (!pending.reqKey) return null;
  for (const id of ids) {
    if ((await reqKeyOf(id, subtle)) === pending.reqKey) return id;
  }
  return null;
}

/** 記録待ちの書き込み先（依頼）が見つからないときの文言 */
export const PENDING_TARGET_MISSING_TEXT =
  "前回メールを送った承諾書の依頼が見つかりません（取り消された・署名済みになった等）。\n"
  + "前回の送信の記録先が無いため、記録待ちは消しました。\n"
  + "対応記録に「メール送信」の行が出ているか確かめてください。出ていれば送信済みです。";

/** テスト用: モジュール変数の記録待ちを空にする */
export function _resetPendingMemory() { memPending.clear(); memUnknown.clear(); }

/** カードに出す1行: 記録待ちの依頼が署名済み・取り消し済みで、記録待ちを解除したとき */
export const PENDING_RELEASED_CARD_TEXT =
  "前回メールを送った依頼は署名済み・取り消し済みのため、記録待ちを解除しました。対応記録に「メール送信」の行があるか確かめてください。";

// ===== 「送れたか不明」の印（2026-11-10 再レビュー 中-2） =====
// 再読み込みしても次の送信の前に確認をはさむため、sessionStorage にも持つ。キーは kjk.mailUnknown.{kind}.{caseId}、
// 値は "1" だけ（宛先・依頼ID・本文は入れない）。sessionStorage が使えなければモジュール変数だけ
const memUnknown = new Set();

/** 「送れたか不明」の印のキー */
export function unknownKey(kind, caseId) {
  if (!PENDING_KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  return `kjk.mailUnknown.${kind}.${caseId || ""}`;
}

/** 「送れたか不明」の印を付ける */
export function markSendUnknown(kind, caseId, storage) {
  const key = unknownKey(kind, caseId);
  memUnknown.add(key);
  try { storageOf(storage)?.setItem(key, "1"); } catch { /* 使えなければモジュール変数だけ */ }
}

/** 「送れたか不明」の印があるか */
export function isSendUnknown(kind, caseId, storage) {
  const key = unknownKey(kind, caseId);
  if (memUnknown.has(key)) return true;
  try { return storageOf(storage)?.getItem(key) === "1"; } catch { return false; }
}

/** 「送れたか不明」の印を消す（送信成功・確認のうえ送り直した・記録待ちに移ったとき） */
export function clearSendUnknown(kind, caseId, storage) {
  const key = unknownKey(kind, caseId);
  memUnknown.delete(key);
  try { storageOf(storage)?.removeItem(key); } catch { /* 同上 */ }
}

// ===== sendCaseEmail の返事を読む（2026-11-12・点検4 の根本対応） =====
// 新しい Functions: { ok:true, sent:true, id, sentAt, recordError? }（functions/case-mail.js）。
// 古い Functions: { ok:true, id }（sentAt・recordError が無い）→ sentAt は ""（呼び出し側が端末の時刻を使う）・recordError は ""。
// どちらの組み合わせでも動くよう、無いもの・壊れた値は「無い」として扱う。

/**
 * @param {unknown} res  httpsCallable の結果（{ data }）か、data そのもの
 * @returns {{sentAt:string, recordError:string}}  sentAt＝サーバーが送信に成功した時刻（ISO・無ければ ""）
 *   recordError＝送信は済んだが、サーバーで対応記録が書けなかった理由（無ければ ""）
 */
export function sendResultOf(res) {
  const d = res && typeof res === "object" && "data" in res ? res.data : res;
  const out = { sentAt: "", recordError: "" };
  if (!d || typeof d !== "object") return out;
  if (typeof d.sentAt === "string") {
    const ms = Date.parse(d.sentAt);
    if (Number.isFinite(ms)) out.sentAt = new Date(ms).toISOString();
  }
  if (d.recordError != null && d.recordError !== false && String(d.recordError).trim()) {
    out.recordError = String(d.recordError).trim().slice(0, 300);
  }
  return out;
}

/** 件名が手元に無いとき（再読み込みのあと）に対応記録へ書く名前 */
export const CASE_MAIL_KIND_LABEL = { consent: "承諾書の署名依頼メール", preGuide: "事前準備のご案内メール", free: "メール" };

/**
 * サーバーで書けなかった対応記録を、画面から1件足すときの中身（occurredAt・userId・userName は呼び出し側）。
 * 書式は sendCaseEmail の送信記録と同じ（type "gmail_sent"・件名「メール送信: …」・本文「宛先: …」）に、画面から記録した旨を1行足す。
 * 件名・本文は同じページの中にしか持たない（sessionStorage に入れない）ので、再読み込みのあとは種類の名前と注記だけになる。
 * @param {{kind?:string, caseId:string, to:string, subject?:string, body?:string}} a
 */
export function caseMailActivityOf({ kind = "free", caseId, to, subject, body } = {}) {
  const note = "（送信後にサーバーで対応記録を書けなかったため、画面から記録しました）";
  const head = `宛先: ${to || ""}\n${note}`;
  return {
    caseId, type: "gmail_sent",
    subject: `メール送信: ${subject || CASE_MAIL_KIND_LABEL[kind] || CASE_MAIL_KIND_LABEL.free}`,
    body: body ? `${head}\n\n${body}` : `${head}\n（本文は画面に残っていないため記録していません）`,
    attachmentUrls: [],
  };
}

/** 案件詳細の自由文面のメールで、対応記録だけ書けなかったときの確認（OK で記録だけやり直す・メールは送らない） */
export function freeMailRecordRetryText(err) {
  return "メールは送信済みです。対応記録への記録だけ失敗しました（再送しないでください）。\n"
    + `理由: ${errText(err)}\n\n`
    + "OK で、メールは送らずに対応記録だけをもう一度保存します。";
}

/** 送信日時（ISO）から、事前案内の送付日（JST の YYYY-MM-DD）を出す */
export function jstDateOf(iso) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

// ===== 点検5: 伴走支援の記録を保存したとき、案件の状態を伴走支援実施済にするか聞く =====

/** 伴走支援実施済（constants.js の 8） */
export const SUPPORT_DONE_STATUS = 8;

/** 受注確定（constants.js の 3） */
export const ORDER_CONFIRMED_STATUS = 3;

// 聞く状態: パイプライン順（STATUS_ORDER）で受注確定〜伴走支援実施済の手前（受注確定・担当者決定・事前準備中・伴走支援待ち）。
// 受注前（新規受信・確認中）は聞かない（2026-11-10 次田さん決定）。受注確定を通らずに実施済へ進むと受注日 orderedAt が付かず、
// 「見積もり発行済（未申込）」の絞り込みに残るため。失注(4)は STATUS_ORDER の末尾にあるので入らない
const ASK_SUPPORT_DONE = STATUS_ORDER.slice(
  STATUS_ORDER.indexOf(ORDER_CONFIRMED_STATUS), STATUS_ORDER.indexOf(SUPPORT_DONE_STATUS));

/**
 * 伴走支援の記録を保存したあとに「伴走支援実施済にしますか」と聞くか。
 * 聞く: 受注確定・担当者決定・事前準備中・伴走支援待ち。
 * 聞かない: 受注前（新規受信・確認中・状態が空）・伴走支援実施済以降・完了・失注・対象外（archived）・
 *          状態を変えられない人（閲覧のみ）。聞かないときも記録の保存はそのまま（追加の文言も出さない）。
 * @param {{status:unknown, archived?:boolean, canChangeStatus?:boolean}} c
 */
export function shouldAskSupportDone({ status, archived = false, canChangeStatus = true } = {}) {
  if (archived || !canChangeStatus) return false;
  const s = Number(status || 1); // 状態が空の案件は新規受信（画面の表示と同じ）＝受注前なので聞かない
  if (s === LOST) return false;
  return ASK_SUPPORT_DONE.includes(s);
}

/** 確認ダイアログの本文 */
export function supportDoneAskText(status) {
  const now = STATUS_LABELS[Number(status || 1)] || "—";
  return `伴走支援の記録を保存しました。\n\n`
    + `案件の状態は「${now}」のままです。「${STATUS_LABELS[SUPPORT_DONE_STATUS]}」にしますか？\n`
    + `（OK で状態を変更します。キャンセルなら変えません）`;
}
