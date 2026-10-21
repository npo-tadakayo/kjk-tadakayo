// 画面の結線（波2b）で使う判定ロジック。純粋関数のみ（DOM・Firestore に触れない）。
// 設計: docs/CRM改善_設計_20261021.md §3 N1・§5（A）・§6（W）。テスト: node scripts/test-screen-wiring.mjs
// 呼び出し元: case-detail.js（完了の警告・重複の帯・統合の確認）／kanban.js（完了の警告）／
//             quote-admin.js（受注確定のモーダル）／settings.js（日次まとめのプレビュー）
// import は相対パス（ブラウザでは /js/ 配下として、node のテストでもそのまま読める）。

import { findDuplicateDrafts } from "./ship-dup.js";

// 案件完了の状態番号（constants.js の 13 と同じ。テストで一致を確かめる）
export const CASE_DONE = 13;

// ===== 完了(13)の警告 =====

/** 13 以外 → 13 にする操作か（13 → 13 や 13 から外す操作は false） */
export function isCompleting(prevStatus, newStatus) {
  return Number(newStatus) === CASE_DONE && Number(prevStatus) !== CASE_DONE;
}

/** 確認ダイアログの本文（警告が無ければ ""＝確認を出さない） */
export function completionConfirmText(warnings) {
  const list = (warnings || []).filter(Boolean);
  if (!list.length) return "";
  return "完了にする前に、次の点を確かめてください。\n\n"
    + list.map((w) => `・${w}`).join("\n")
    + "\n\nこのまま完了にしますか？";
}

/** 続行したときに活動の本文へ足す1行（警告が無ければ ""） */
export function completionActivityNote(warnings) {
  const list = (warnings || []).filter(Boolean);
  return list.length ? `警告を確認のうえ完了: ${list.join("／")}` : "";
}

// ===== 出荷の重複の帯（案件詳細の出荷タブ） =====

/**
 * この案件に、まだ発送していない出荷（下書き・依頼済）が2件以上あれば帯の中身を返す（無ければ null）。
 * @param {object[]} shipments  この案件の出荷
 * @param {string} caseId
 * @param {string|null} caseShipmentId  cases.shipmentId（残す候補）
 * @returns {{count:number, soNumbers:string[], keepSo:string|null}|null}
 */
export function caseDuplicateBanner(shipments, caseId, caseShipmentId) {
  const own = (shipments || []).map((s) => ({ ...s, caseId: s?.caseId || caseId }));
  const dup = findDuplicateDrafts(own, { [caseId]: caseShipmentId || "" }).find((d) => d.caseId === caseId);
  if (!dup) return null;
  const keep = dup.keepId ? dup.shipments.find((s) => (s._id ?? s.id) === dup.keepId) : null;
  return {
    count: dup.shipments.length,
    soNumbers: dup.shipments.map((s) => s.soNumber || "番号なし"),
    keepSo: keep ? (keep.soNumber || null) : null,
  };
}

const PRE_SHIP = ["draft", "requested"];
/** 統合後に、この案件の「まだ発送していない出荷」が何件になるか（キャンセル等は数えない） */
export function preShipCountAfterMerge(keepShipments, otherShipments) {
  return [...(keepShipments || []), ...(otherShipments || [])]
    .filter((s) => s && PRE_SHIP.includes(s.status)).length;
}

// ===== 受注確定（スタッフ経路）のモーダル =====

/** 日時 → JST の "YYYY-MM-DD" */
export function todayYmdJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
function isValidYmd(s) {
  const m = YMD.exec(String(s || ""));
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.toISOString().slice(0, 10) === s;
}

/** 受付日の検査（エラー文 or ""）。未来の日付は不可（サーバの checkStaffAccept と同じ規則） */
export function receivedDateError(ymd, todayYmd) {
  if (!ymd) return "受付日を入れてください";
  if (!isValidYmd(ymd)) return "受付日を正しく入れてください（YYYY-MM-DD）";
  if (todayYmd && ymd > todayYmd) return "受付日が未来の日付になっています";
  return "";
}

/** 受付方法（サーバの STAFF_ACCEPT_CHANNELS と同じコード値） */
export const ACCEPT_CHANNELS = [
  { value: "phone", label: "電話" },
  { value: "email", label: "メール" },
  { value: "fax", label: "FAX" },
  { value: "other", label: "その他" },
];
/** 支払方法（Web の申込と同じ after／before） */
export const PAY_METHODS = [
  { value: "after", label: "伴走支援の後に支払う" },
  { value: "before", label: "伴走支援の前に支払う" },
];

/**
 * 同じグループ（quoteGroupId）で、受注確定にできる他の事業所の見積もり一覧（チェック欄の元）。
 * 案件ごとに最新版だけを見て、それが issued のものを残す。対象の見積もり（とその案件）は除く。
 * @param {object[]} groupQuotes  quotes where groupId == gid（_id・caseId・version・status・officeName・estNo）
 * @param {object} current        受注確定にしようとしている見積もり（_id・caseId）
 * @returns {{quoteId:string, caseId:string, label:string, checked:boolean}[]}
 */
export function buildGroupChoices(groupQuotes, current) {
  const latestByCase = new Map();
  for (const q of groupQuotes || []) {
    if (!q || !q.caseId) continue;
    const prev = latestByCase.get(q.caseId);
    if (!prev || (Number(q.version) || 0) > (Number(prev.version) || 0)) latestByCase.set(q.caseId, q);
  }
  const out = [];
  for (const q of latestByCase.values()) {
    if (q.status !== "issued") continue;
    if (current && (q._id === current._id || q.caseId === current.caseId)) continue;
    out.push({
      quoteId: q._id,
      caseId: q.caseId,
      label: `${q.officeName || "（事業所名なし）"}${q.estNo ? `（${q.estNo} v${q.version ?? "—"}）` : ""}`,
      checked: true,
      groupIndex: Number(q.groupIndex) || 0,
    });
  }
  return out.sort((a, b) => a.groupIndex - b.groupIndex || a.label.localeCompare(b.label, "ja"))
    .map(({ groupIndex, ...rest }) => rest);
}

/**
 * モーダルの入力 → staffAcceptQuote に渡す値（検査に通らなければ {error}）。
 * groupQuoteIds は「対象の見積もり以外」で、チェックした同じグループの見積もり。
 */
export function buildAcceptPayload(form, todayYmd) {
  const f = form || {};
  const acceptedName = String(f.acceptedName || "").trim();
  if (!acceptedName) return { error: "申込者のお名前を入れてください" };
  if (!ACCEPT_CHANNELS.some((c) => c.value === f.channel)) return { error: "受付方法を選んでください" };
  const dErr = receivedDateError(f.receivedDate, todayYmd);
  if (dErr) return { error: dErr };
  if (f.preferredDate && !isValidYmd(f.preferredDate)) return { error: "希望日を正しく入れてください（YYYY-MM-DD）" };
  return {
    payload: {
      quoteId: f.quoteId,
      acceptedName: acceptedName.slice(0, 100),
      channel: f.channel,
      receivedDate: f.receivedDate,
      payMethod: f.payMethod === "before" ? "before" : "after",
      preferredDate: f.preferredDate || "",
      note: String(f.note || "").trim().slice(0, 1000),
      sendMail: !!f.sendMail,
      groupQuoteIds: [...new Set((f.groupQuoteIds || []).filter((id) => id && id !== f.quoteId))],
    },
  };
}

/**
 * 受注確定の確認メールの宛先（サーバ functions/accept-flow.js の acceptMailTo と同じ規則）。
 * 案件の contactEmail を優先し、無ければ見積もりの contactEmail。メールアドレスの形でなければ ""。
 */
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function acceptMailTo(caseEmail, quoteEmail) {
  for (const v of [caseEmail, quoteEmail]) {
    const e = String(v || "").trim();
    if (MAIL_RE.test(e)) return e;
  }
  return "";
}

/**
 * staffAcceptQuote の戻り値 → 画面に出す結果（成功の行・失敗の行・確認メールの結果）。
 * @param {{ok?:boolean, results?:{quoteId,shipmentId,soNumber}[], partial?:boolean, errors?:any[], mailed?:boolean, mailError?:string|null}} r
 * @param {{sendMail?:boolean}} [opt] 確認メールを送る指定で確定したか
 * @returns {{ok:boolean, partial:boolean, soNumbers:string[], errors:string[], mail:"sent"|"failed"|"off", mailWarning:string}}
 *   mail … sent=送った／failed=送る指定だったのに送れなかった（受注確定は済み）／off=送る指定なし・確定できなかった
 */
export function summarizeAcceptResult(r, opt = {}) {
  const d = r || {};
  const results = Array.isArray(d.results) ? d.results : [];
  const errors = (Array.isArray(d.errors) ? d.errors : []).map((e) =>
    typeof e === "string" ? e : [e?.quoteId, e?.message || e?.code].filter(Boolean).join(": "));
  const soNumbers = results.map((x) => x?.soNumber).filter(Boolean);
  const ok = !!d.ok && results.length > 0;
  let mail = "off";
  if (ok && d.mailed === true) mail = "sent";
  else if (ok && opt.sendMail) mail = "failed";
  const reason = String(d.mailError || "").trim() || "宛先のメールアドレスがありません";
  return {
    ok,
    partial: !!d.partial || (results.length > 0 && errors.length > 0),
    soNumbers,
    errors,
    mail,
    mailWarning: mail === "failed"
      ? `受注確定は済みました。確認メールは送れませんでした（${reason}）。案件のメール送信から送ってください`
      : "",
  };
}

// ===== 日次まとめのプレビュー（設定画面） =====

/**
 * previewDailyFollowup の戻り値 → 表示ブロック（見出し・本文）。
 * @param {{overall:string|null, assignees:{email,name,text}[]}} data
 * @returns {{title:string, text:string, empty:boolean}[]}
 */
export function dailyPreviewBlocks(data) {
  const d = data || {};
  const blocks = [{
    title: "全体のまとめ（CRM通知の投稿先へ1通）",
    text: d.overall || "投稿する内容はありません（この日は全体のまとめを投稿しません）",
    empty: !d.overall,
  }];
  const list = Array.isArray(d.assignees) ? d.assignees : [];
  if (!list.length) {
    blocks.push({ title: "担当ごとのまとめ", text: "未対応の案件がある担当はいません（担当ごとの投稿はありません）", empty: true });
  }
  for (const a of list) {
    blocks.push({
      title: `担当: ${a?.name || a?.email || "（名前なし）"}${a?.email && a?.name ? `（${a.email}）` : ""}`,
      text: a?.text || "",
      empty: !a?.text,
    });
  }
  return blocks;
}
