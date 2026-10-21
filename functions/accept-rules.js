// functions/accept-rules.js — 電話・メール等で受けた申込を、スタッフが「受注確定」にしてよいかの判定（純粋関数・CommonJS）。
// 設計: docs/CRM改善_設計_20261021.md §5（A）・§9 の 8（期限切れは受付日で比べる）。テスト: node scripts/test-accept-rules.mjs
// staffAcceptQuote（index.js）が tx の中で読んだ値を渡して呼ぶ。Firestore には触れない。
"use strict";

// 受付方法（quotes.acceptedChannel に入るコード値 → 表示名）
const STAFF_ACCEPT_CHANNELS = { phone: "電話", email: "メール", fax: "FAX", other: "その他" };

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
// "YYYY-MM-DD" として正しい日付か（2026-02-30 のような存在しない日は不可）
function isValidYmd(s) {
  const m = YMD.exec(String(s || ""));
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.toISOString().slice(0, 10) === s;
}

// 有効期限（Timestamp / Date / 文字列 / ミリ秒）→ JST の "YYYY-MM-DD"。取れなければ ""
function jstYmdOf(v) {
  if (v == null || v === "") return "";
  let ms;
  if (typeof v.toMillis === "function") ms = v.toMillis();
  else if (typeof v.toDate === "function") ms = v.toDate().getTime();
  else if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "number") ms = v;
  else if (typeof v === "string" && YMD.test(v)) return v;
  else ms = Date.parse(v);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

const ng = (code, message) => ({ ok: false, code, message });

/**
 * スタッフ経路の受注確定の拒否条件。最初に当たったものを返す。
 * @param {object} p
 * @param {object} p.quote         対象の見積もり（id・status・version・validUntil）
 * @param {object[]} p.siblings    同じ案件の見積もり（対象を含んでいてもよい）
 * @param {object} p.kase          案件（status）
 * @param {object[]} p.shipments   同じ案件の出荷（status）
 * @param {string} p.receivedDate  受付日 "YYYY-MM-DD"（電話・メールを受けた日）
 * @param {string} p.todayYmd      今日（JST）"YYYY-MM-DD"
 * @param {string} p.acceptedName  申込者名
 * @param {string} p.channel       受付方法（STAFF_ACCEPT_CHANNELS のキー）
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
function checkStaffAccept({ quote, siblings, kase, shipments, receivedDate, todayYmd, acceptedName, channel } = {}) {
  if (!quote) return ng("quote_not_found", "見積もりが見つかりません");
  if (quote.status === "accepted") return ng("already_accepted", "この見積もりはすでに受注確定（お申し込み済み）です");
  if (quote.status !== "issued") return ng("not_issued", "この見積もりは受注確定にできません（発行中の見積もりではありません）");
  const myVer = Number(quote.version) || 0;
  const newer = (siblings || []).some((s) => s && s.id !== quote.id && (Number(s.version) || 0) > myVer);
  if (newer) return ng("old_version", "新しい版の見積もりがあります。最新の版で受注確定にしてください");

  if (!isValidYmd(receivedDate)) return ng("invalid_received_date", "受付日を正しく入れてください（YYYY-MM-DD）");
  if (!isValidYmd(todayYmd)) return ng("invalid_today", "今日の日付が取れません");
  if (receivedDate > todayYmd) return ng("future_received_date", "受付日が未来の日付になっています");
  // 期限切れは「受付日」で比べる（電話を受けた日に有効なら有効）。有効期限の日（JST）当日の受付は有効
  const until = jstYmdOf(quote.validUntil);
  if (until && receivedDate > until) return ng("expired", `受付日（${receivedDate}）が見積もりの有効期限（${until}）を過ぎています`);

  if (!String(acceptedName || "").trim()) return ng("no_name", "申込者のお名前を入れてください");
  if (!Object.prototype.hasOwnProperty.call(STAFF_ACCEPT_CHANNELS, channel)) {
    return ng("invalid_channel", "受付方法（電話・メール・FAX・その他）を選んでください");
  }

  if (!kase) return ng("case_not_found", "案件が見つかりません");
  // 失注(4)・完了(13)の案件も拒否しない（再申込として受け付け、呼び出し側が案件を 3 に戻す。2026-10-21 レビュー指摘 4）

  // キャンセル以外の出荷がある＝すでに申込を受けている。二重に下書きを作らないため止める
  const live = (shipments || []).filter((s) => s && (s.status || "shipped") !== "canceled");
  if (live.length) {
    const pre = live.every((s) => s.status === "draft" || s.status === "requested");
    const nos = live.map((s) => s.soNumber).filter(Boolean).join("・");
    return pre
      ? ng("draft_exists", `この案件にはすでに出荷の下書き・依頼${nos ? `（${nos}）` : ""}があります。重複していないか確かめてください`)
      : ng("shipped_exists", `この案件はすでに発送済みの出荷${nos ? `（${nos}）` : ""}があります。受注確定は二重になります`);
  }
  return { ok: true };
}

module.exports = { checkStaffAccept, STAFF_ACCEPT_CHANNELS, isValidYmd, jstYmdOf };
