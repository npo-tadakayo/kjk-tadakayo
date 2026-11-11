// admin/js/case-progress.js — 案件ごとの進み具合の帯（2026-11-12 次田さん決定・CRM改善2 計画 §3.5 進1・進2）
//
// 13段階の状態（constants.js の STATUS_LABELS）を、8つの大きな区切りにまとめて「済／いま／まだ」で見せる。
//   受付 → 見積 → 発注（承諾書） → 準備 → 出荷 → 伴走支援 → 申請 → 完了
// 同じ状態に長くいる案件（止まっている案件）は、日数で黄色（既定14日）・赤（既定30日）にする。
// 日数は appConfig/settings.stageStale = { warnDays, alertDays } で変えられる（無ければ 14／30）。
// 待ちが長い状態（10 申請完了・採択待ち／11 採択・入金待ち／12 アフターフォロー中）と、失注(4)・完了(13)は色を付けない。
//
// 純粋関数だけを置く（DOM・Firestore に触れない）。HTML を返す関数も文字列を作るだけ。
// テスト: node scripts/test-case-progress.mjs
// 呼び出し元: cases.js（一覧の小さな帯・止まっている案件の絞り込み）／case-detail.js（上の大きな帯）／
//             case-detail.js・kanban.js・cases.js（状態を書くときに statusChangedAt・statusChangedTo を一緒に書く）
//
// 「この状態に何日いるか」の数え方（推測の日数で色を付けない）:
//   1) 案件の statusChangedAt（状態を変えた日時）。一緒に書く statusChangedTo が今の状態と同じときだけ使う
//      （Functions が状態を変えたときは statusChangedAt を書かないため、To が食い違ったら古い値として使わない）
//   2) 案件詳細だけ: 対応記録の最後の「ステータス変更」の日時。その行の変更先が今の状態と同じときだけ使う
//   3) 案件詳細だけ: 状態が「新規受信」で、対応記録に「ステータス変更」が1行も無いときは受信日（一度も変わっていない）
//   どれでも決まらなければ「—」（分からない）。一覧では 1) だけを使う（一覧で対応記録を読まないため）。

import { STATUS_LABELS, LOST } from "./constants.js";

export const PROGRESS_STEPS = [
  { key: "intake",  label: "受付",     tip: "問い合わせを受け、内容と重複を確かめる段階です（状態: 新規受信・確認中で、見積もりがまだ無いとき）。" },
  { key: "quote",   label: "見積",     tip: "見積もりを出して、お返事（発注）を待つ段階です（状態: 新規受信・確認中で、見積もりがあるとき）。" },
  { key: "order",   label: "発注",     tip: "発注を受けて受注確定にした段階です（状態: 受注確定）。" },
  { key: "prep",    label: "準備",     tip: "担当を決め、事前準備を進める段階です（状態: 担当者決定・事前準備中）。" },
  { key: "ship",    label: "出荷",     tip: "カードリーダーなどを発送する段階です。案件詳細では出荷の状態（下書き・依頼済み・発送済み）から決めます。一覧では案件の状態から決めます（伴走支援待ち以降なら済）。" },
  { key: "support", label: "伴走支援", tip: "訪問・オンラインで伴走支援をする段階です（状態: 伴走支援待ち・伴走支援実施済）。" },
  { key: "apply",   label: "申請",     tip: "申請書類をそろえ、申請・採択・入金を待つ段階です（状態: 書類準備完了・申請ガイド中・申請完了・採択待ち・採択・入金待ち）。" },
  { key: "done",    label: "完了",     tip: "アフターフォローをして、案件を完了にする段階です（状態: アフターフォロー中・案件完了）。" },
];
export const SHIP_STEP = 4;
// 承諾書のサイン＝発注（appConfig/settings.orderByConsent）がオンのときの区切りの名前
export const ORDER_LABEL_CONSENT = "発注（承諾書）";
export const ORDER_TIP_CONSENT = "承諾書のサインで発注を受け、受注確定にした段階です（状態: 受注確定）。";

// 状態 → 区切りの番号（1・2 は見積もりの有無で 受付/見積 に分かれるので別扱い。4 失注は無し）
export const STATUS_TO_STEP = { 3: 2, 5: 3, 6: 3, 7: 5, 8: 5, 9: 6, 10: 6, 11: 6, 12: 7, 13: 7 };

export const STALE_DEFAULTS = Object.freeze({ warnDays: 14, alertDays: 30 });
// 色を付けない状態（待ちが長い段階と、失注・完了）
export const STALE_EXEMPT_STATUSES = [10, 11, 12, LOST, 13];
const SHIPPED_LIKE = ["shipped", "invoiced", "paid"]; // 発送済み以降（請求済み・入金済みも発送は済んでいる）
const DAY_MS = 86400000;
const JST_MS = 9 * 3600000;

/** 設定（appConfig/settings.stageStale）→ { warnDays, alertDays }。正の整数で warn < alert のときだけ採る */
export function resolveStaleConfig(settings) {
  const s = settings && settings.stageStale;
  if (!s || typeof s !== "object") return { ...STALE_DEFAULTS };
  const w = Number(s.warnDays), a = Number(s.alertDays);
  const ok = (n) => Number.isInteger(n) && n > 0 && n <= 3650;
  if (ok(w) && ok(a) && w < a) return { warnDays: w, alertDays: a };
  if (ok(w) && !s.alertDays && w < STALE_DEFAULTS.alertDays) return { warnDays: w, alertDays: STALE_DEFAULTS.alertDays };
  if (ok(a) && !s.warnDays && STALE_DEFAULTS.warnDays < a) return { warnDays: STALE_DEFAULTS.warnDays, alertDays: a };
  return { ...STALE_DEFAULTS };
}

/** 状態を書くときに一緒に書く項目（ts は serverTimestamp() など） */
export function statusChangePatch(newStatus, ts) {
  return { statusChangedAt: ts, statusChangedTo: Number(newStatus) };
}

function toDate(ts) {
  if (!ts) return null;
  try {
    const d = ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
    return Number.isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

/** 出荷の一覧 → "none"（出荷が無い・すべてキャンセル）／"draft"／"requested"／"shipped"（すべて発送済み以降） */
export function shipStageOf(shipments) {
  const live = (shipments || []).filter((s) => s && ((s.status || "shipped") !== "canceled"));
  if (!live.length) return "none";
  const st = (s) => s.status || "shipped"; // 状態の無い古い出荷は発送済み扱い（case-complete-check.js と同じ）
  if (live.every((s) => SHIPPED_LIKE.includes(st(s)))) return "shipped";
  if (live.some((s) => st(s) === "requested")) return "requested";
  return "draft";
}

/** 状態だけから決まる区切りの番号（-1 = 失注・分からない） */
export function stepIndexOfStatus(status, kase) {
  const st = Number(status);
  if (st === 1 || st === 2) return kase && kase.latestQuoteId ? 1 : 0;
  return Object.prototype.hasOwnProperty.call(STATUS_TO_STEP, st) ? STATUS_TO_STEP[st] : -1;
}

/**
 * 案件 → 帯の材料。
 * @param {object} kase 案件（status・latestQuoteId を見る）
 * @param {{shipments?: object[]|null, orderByConsent?: boolean}} opt
 *   shipments: 案件詳細で読んだ出荷（null/undefined なら案件の状態だけで決める＝一覧）
 * @returns {{lost:boolean, finished:boolean, current:number, total:number,
 *   steps:{key:string,label:string,tip:string,state:"done"|"current"|"todo",note:string}[]}}
 */
export function caseProgress(kase, { shipments = null, orderByConsent = false } = {}) {
  const status = Number(kase && kase.status);
  const total = PROGRESS_STEPS.length;
  const base = PROGRESS_STEPS.map((s) => ({
    key: s.key,
    label: s.key === "order" && orderByConsent ? ORDER_LABEL_CONSENT : s.label,
    tip: s.key === "order" && orderByConsent ? ORDER_TIP_CONSENT : s.tip,
    state: "todo", note: "",
  }));
  if (status === LOST) return { lost: true, finished: false, current: -1, total, steps: base };
  let cur = stepIndexOfStatus(status, kase);
  if (cur < 0) return { lost: false, finished: false, current: -1, total, steps: base }; // 分からない状態
  const finished = status === 13;

  // 出荷の区切り（案件の状態から決めたもの）。出荷を読んだときは上書きする
  let shipState = cur > SHIP_STEP ? "done" : "todo";
  let shipNote = "";
  const ship = shipments == null ? null : shipStageOf(shipments);
  if (ship && ship !== "none") {
    if (ship === "shipped") { shipState = "done"; shipNote = "発送済みです"; }
    else if (cur > SHIP_STEP) { shipState = "todo"; shipNote = ship === "requested" ? "依頼済みで、まだ発送済みになっていない出荷があります" : "下書きのままの出荷があります"; }
    else if (cur >= 2 && ship === "requested") { cur = SHIP_STEP; shipNote = "出荷を依頼済みです（発送待ち）"; }
    else if (ship === "draft") shipNote = "出荷は下書きです";
    else if (ship === "requested") shipNote = "出荷を依頼済みです（発送待ち）";
  }

  const steps = base.map((s, i) => ({
    ...s,
    state: finished || i < cur ? "done" : (i === cur ? "current" : "todo"),
  }));
  // 出荷の区切りだけは並び順でなく出荷の状態で決める（いまが出荷のときと、完了のときを除く）
  if (!finished && cur !== SHIP_STEP) steps[SHIP_STEP].state = shipState;
  steps[SHIP_STEP].note = shipNote;
  return { lost: false, finished, current: cur, total, steps };
}

/**
 * いまの状態になった日時。{ at: Date|null, source: "field"|"activity"|"received"|null }
 * activities を渡さなければ案件の項目だけで決める（一覧）。
 */
export function stageSince(kase, { activities = null } = {}) {
  const status = Number(kase && kase.status);
  if (!kase || !status) return { at: null, source: null };
  const f = toDate(kase.statusChangedAt);
  if (f && Number(kase.statusChangedTo) === status) return { at: f, source: "field" };
  if (!Array.isArray(activities)) return { at: null, source: null };
  const changes = activities
    .filter((a) => a && typeof a.subject === "string" && a.subject.startsWith("ステータス変更"))
    .map((a) => ({ a, d: toDate(a.occurredAt) }))
    .filter((x) => x.d)
    .sort((x, y) => y.d - x.d);
  if (changes.length) {
    const subj = changes[0].a.subject;
    const to = subj.slice(subj.lastIndexOf("→") + 1).trim();
    return to === STATUS_LABELS[status] ? { at: changes[0].d, source: "activity" } : { at: null, source: null };
  }
  if (status === 1) {
    const r = toDate(kase.receivedAt) || toDate(kase.createdAt);
    if (r) return { at: r, source: "received" };
  }
  return { at: null, source: null };
}

/** 日数（日本時間の暦日の差。当日は0）。分からなければ null */
export function stageDays(at, now = new Date()) {
  const d = toDate(at);
  if (!d) return null;
  const day = (x) => Math.floor((x.getTime() + JST_MS) / DAY_MS);
  return Math.max(0, day(now) - day(d));
}

/** 止まり具合: "alert"（赤）／"warn"（黄）／"ok"／"exempt"（色を付けない状態）／"unknown"（日数が分からない） */
export function staleLevel(status, days, cfg = STALE_DEFAULTS) {
  if (STALE_EXEMPT_STATUSES.includes(Number(status))) return "exempt";
  if (days == null) return "unknown";
  if (days >= cfg.alertDays) return "alert";
  if (days >= cfg.warnDays) return "warn";
  return "ok";
}

/** 一覧の絞り込み（"" すべて／"warn" 黄色以上／"alert" 赤） */
export function staleFilterMatch(level, filter) {
  if (!filter) return true;
  if (filter === "alert") return level === "alert";
  if (filter === "warn") return level === "warn" || level === "alert";
  return true;
}

const LEVEL_TEXT = { alert: "止まっています（赤）", warn: "止まりかけています（黄）" };

/** 読み上げ用の文（例「進み具合: 8段階中3番目 発注。この段階に12日」） */
export function progressAriaLabel(p, days, level) {
  if (!p) return "進み具合: 不明";
  if (p.lost) return "進み具合: 失注";
  if (p.current < 0) return "進み具合: 不明";
  const name = p.steps[p.current].label;
  const head = p.finished ? `進み具合: 8段階すべて済（${name}）` : `進み具合: ${p.total}段階中${p.current + 1}番目 ${name}`;
  const d = p.finished ? "" : (days == null ? "。この段階の日数は不明" : `。この段階に${days}日`);
  const lv = LEVEL_TEXT[level] ? `。${LEVEL_TEXT[level]}` : "";
  return head + d + lv;
}

/** 日数の表示（null は「—」） */
export function daysText(days) { return days == null ? "—" : `${days}日`; }

/** 「何日いるか」の数え方の説明（吹き出し用） */
export function sinceSourceText(src) {
  if (src === "field") return "状態を変えた日から数えています。";
  if (src === "activity") return "対応記録の最後の「ステータス変更」の日から数えています。";
  if (src === "received") return "受信日から数えています（まだ一度も状態を変えていません）。";
  return "状態が変わった日が記録されていないため、日数は分かりません（自動で状態が変わった案件や、この仕組みを入れる前に状態を変えた案件）。次に状態を変えた日から数え始めます。";
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const STATE_JA = { done: "済", current: "いま", todo: "まだ" };

/** 一覧の小さな帯（点8つ＋日数）。行全体の aria-label に同じ内容を入れるので、ここは読み上げない */
export function progressDotsHtml(p, days, level, cfg = STALE_DEFAULTS) {
  if (!p || (!p.lost && p.current < 0)) return "";
  const tipHead = progressAriaLabel(p, days, level).replace(/^進み具合: /, "");
  const tip = `進み具合: ${tipHead}${p.lost ? "" : `。${cfg.warnDays}日で黄色、${cfg.alertDays}日で赤になります（申請・採択待ち・入金待ち・アフターフォロー・完了は対象外）`}`;
  const dots = p.steps.map((s) => `<span class="cp-dot cp-${p.lost ? "lost" : s.state}"></span>`).join("");
  const right = p.lost ? `<span class="cp-mini-lost">失注</span>`
    : (p.finished ? "" : `<span class="cp-days cp-lv-${level}">${level === "alert" || level === "warn" ? '<i class="ti ti-alert-triangle" aria-hidden="true"></i>' : ""}${esc(daysText(days))}</span>`);
  return `<div class="cp-mini" aria-hidden="true" data-tip="${esc(tip)}"><span class="cp-dots">${dots}</span>${right}</div>`;
}

/** 案件詳細の大きな帯 */
export function progressBandHtml(p, days, level, { sinceSource = null, cfg = STALE_DEFAULTS } = {}) {
  if (!p) return "";
  const aria = progressAriaLabel(p, days, level);
  if (p.lost) {
    return `<div class="cp-band cp-band-lost" role="group" aria-label="${esc(aria)}">
      <div class="cp-head"><span class="cp-title">進み具合</span><span class="cp-lost-tag"><i class="ti ti-circle-x" aria-hidden="true"></i> 失注</span></div>
      <ol class="cp-steps">${p.steps.map((s) => `<li class="cp-step cp-lost"><span class="cp-mark" aria-hidden="true"></span><span class="cp-label">${esc(s.label)}</span></li>`).join("")}</ol>
    </div>`;
  }
  if (p.current < 0) return "";
  const lvText = level === "alert" ? `${cfg.alertDays}日以上止まっています` : level === "warn" ? `${cfg.warnDays}日以上止まっています` : "";
  const daysTip = `${sinceSourceText(sinceSource)}${level === "exempt" ? "この状態は待ちが長いので、色は付けません。" : `${cfg.warnDays}日で黄色、${cfg.alertDays}日で赤になります。`}`;
  const steps = p.steps.map((s, i) => {
    const tip = `${i + 1}. ${s.label}（${STATE_JA[s.state]}）: ${s.tip}${s.note ? `　いま: ${s.note}` : ""}`;
    const mark = s.state === "done" ? '<i class="ti ti-check" aria-hidden="true"></i>' : (s.state === "current" ? '<i class="ti ti-point-filled" aria-hidden="true"></i>' : "");
    const cur = s.state === "current" ? ' aria-current="step"' : "";
    return `<li class="cp-step cp-${s.state}${s.note && s.key === "ship" && s.state === "todo" && p.current > SHIP_STEP ? " cp-attn" : ""}"${cur} tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(`${s.label}: ${STATE_JA[s.state]}${s.note ? `（${s.note}）` : ""}`)}"><span class="cp-mark" aria-hidden="true">${mark}</span><span class="cp-label">${esc(s.label)}</span><span class="cp-state" aria-hidden="true">${STATE_JA[s.state]}</span></li>`;
  }).join("");
  const daysHtml = p.finished ? `<span class="cp-days-big cp-lv-ok">すべて済</span>`
    : `<span class="cp-days-big cp-lv-${level}" tabindex="0" data-tip="${esc(daysTip)}">${level === "alert" || level === "warn" ? '<i class="ti ti-alert-triangle" aria-hidden="true"></i> ' : ""}この段階に ${esc(daysText(days))}${lvText ? `（${lvText}）` : ""}</span>`;
  return `<div class="cp-band" role="group" aria-label="${esc(aria)}">
    <div class="cp-head"><span class="cp-title">進み具合</span><span class="cp-pos">${p.finished ? "" : `${p.total}段階中 ${p.current + 1}番目`}</span>${daysHtml}</div>
    <ol class="cp-steps">${steps}</ol>
  </div>`;
}
