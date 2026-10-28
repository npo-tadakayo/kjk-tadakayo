// admin/js/schedule-core.js — 予定（訪問カレンダー）の純粋な関数（画面・Firestore に依存しない）
// テスト: node scripts/test-schedule.mjs
//
// 日付はすべて "YYYY-MM-DD"（JST の暦日）の文字列で扱い、曜日・加減算は UTC の Date で計算する
// （端末のタイムゾーンに左右されない）。週は日曜始まり（ケアプー記録の予定カレンダーと同じ）。
import { matchAssignee } from "./assignee-filter.js";
import { parseAddress } from "./area.js";

export const VIEWS = ["day", "week", "month"];
export const DEFAULT_VIEW = "day";
export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
export const FORMAT_LABELS = { onsite: "対面", online: "オンライン" };

// ---------- 日付 ----------
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(s) {
  const m = YMD.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s;
}
const toDate = (ymd) => { const m = YMD.exec(ymd); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); };
const fromDate = (d) => d.toISOString().slice(0, 10);

/** JST の今日（UTC 15:00 以降は翌日になる） */
export function todayYmdJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
export function addDays(ymd, n) {
  const d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return fromDate(d);
}
/** 0=日 … 6=土 */
export function weekdayOf(ymd) { return toDate(ymd).getUTCDay(); }
export function startOfWeek(ymd) { return addDays(ymd, -weekdayOf(ymd)); }
export function startOfMonth(ymd) { return ymd.slice(0, 8) + "01"; }
export function endOfMonth(ymd) {
  const d = toDate(ymd);
  return fromDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}
/** 月の加減算。日は 1 日に寄せる（月またぎ・年またぎで日が溢れないように） */
export function addMonths(ymd, n) {
  const d = toDate(ymd);
  return fromDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
}

/** 表示期間 [from, to]（両端含む）。月は前後の月の日も含めて週単位で埋める */
export function rangeOf(view, ymd) {
  if (view === "week") { const s = startOfWeek(ymd); return { from: s, to: addDays(s, 6) }; }
  if (view === "month") {
    const s = startOfWeek(startOfMonth(ymd));
    const e = addDays(startOfWeek(endOfMonth(ymd)), 6);
    return { from: s, to: e };
  }
  return { from: ymd, to: ymd };
}
/** 期間を日の配列に */
export function daysIn(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
/** 月グリッド（週ごとの配列） */
export function monthGrid(ymd) {
  const { from, to } = rangeOf("month", ymd);
  const days = daysIn(from, to);
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}
/** 前へ／次へ */
export function shiftDate(view, ymd, dir) {
  if (view === "month") return addMonths(ymd, dir);
  if (view === "week") return addDays(ymd, 7 * dir);
  return addDays(ymd, dir);
}

// ---------- URL ----------
export function parseQuery(search, today) {
  const p = new URLSearchParams(search || "");
  const v = p.get("view");
  const d = p.get("date");
  return {
    view: VIEWS.includes(v) ? v : DEFAULT_VIEW,
    date: isYmd(d) ? d : today,
    assignee: p.get("assignee") || "",
    pref: p.get("pref") || "",
  };
}
/** 既定値と同じものは省かない（共有したときに同じ表示になるよう view と date は常に付ける） */
export function buildQuery({ view, date, assignee, pref }) {
  const p = new URLSearchParams();
  p.set("view", VIEWS.includes(view) ? view : DEFAULT_VIEW);
  p.set("date", date);
  if (assignee) p.set("assignee", assignee);
  if (pref) p.set("pref", pref);
  return "?" + p.toString();
}

// ---------- 予定（案件）----------
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHhmm = (s) => HHMM.test(String(s || ""));
const hhmmOrNull = (s) => (isHhmm(s) ? s : null);
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 色分けの段階。これから(3,5,6,7) / 済み(8〜13) / 要確認(1,2 など)。失注(4)は表示しない(null) */
export function stageOf(status) {
  const s = Number(status);
  if (s === 4) return null;
  if ([3, 5, 6, 7].includes(s)) return "upcoming";
  if (s >= 8 && s <= 13) return "done";
  return "check";
}
export const STAGE_LABELS = { upcoming: "これから", done: "済み", check: "要確認" };

// ---------- 担当者の名前 ----------
export const UNREGISTERED_ASSIGNEE = "担当者（未登録）";
const normId = (s) => String(s || "").trim().toLowerCase();
/**
 * 担当者 id（メール）→ 名前の対応表。users（doc id=メール・name）を優先し、
 * 足りない分は名前の入っている案件から補う。
 */
export function buildUserNames(users, cases) {
  const m = new Map();
  for (const c of cases || []) {
    const id = normId(c && c.assignedUserId);
    if (id && c.assignedUserName && !m.has(id)) m.set(id, c.assignedUserName);
  }
  for (const u of users || []) {
    const id = normId(u && (u._id || u.id || u.email));
    if (id && u.name) m.set(id, u.name);
  }
  return m;
}
/** 表示する担当者名。案件の名前 → 対応表 → 「担当者（未登録）」。id が無ければ ""。メールアドレスは返さない */
export function assigneeNameOf(id, name, userNames) {
  if (!normId(id)) return "";
  const n = String(name || "").trim();
  if (n && n.includes("@") === false) return n;
  return (userNames && userNames.get(normId(id))) || UNREGISTERED_ASSIGNEE;
}

/** cases → 予定。訪問予定日が正しい形で、失注・対象外でないものだけ */
export function toEvents(cases, { officesById = {}, areaOf, userNames } = {}) {
  const out = [];
  for (const c of cases || []) {
    if (!c || c.archived || !isYmd(c.visitDate)) continue;
    const stage = stageOf(c.status);
    if (!stage) continue;
    const office = officesById[c.officeId] || null;
    const address = (office && office.address) || c.address || "";
    const area = areaOf ? areaOf(c, officesById) : parseAddress(address);
    const from = hhmmOrNull(c.visitTimeFrom);
    out.push({
      id: c._id,
      caseNumber: c.caseNumber || 0,
      date: c.visitDate,
      timeFrom: from,
      timeTo: from ? hhmmOrNull(c.visitTimeTo) : null, // 開始が無いのに終了だけ、は使わない
      format: c.visitFormat === "online" || c.visitFormat === "onsite" ? c.visitFormat : "",
      assignedUserId: c.assignedUserId || "",
      assignedUserName: assigneeNameOf(c.assignedUserId, c.assignedUserName, userNames),
      corpName: c.corpName || "",
      officeName: c.officeName || "",
      address,
      prefecture: (area && area.prefecture) || "",
      phone: c.contactPhone || "",
      status: Number(c.status),
      stage,
    });
  }
  return out;
}

/** 並び：時刻あり（早い順）→ 時刻未定。同じなら案件番号 */
export function sortEvents(events) {
  return [...events].sort((a, b) => {
    if (a.timeFrom && b.timeFrom) {
      if (a.timeFrom !== b.timeFrom) return a.timeFrom < b.timeFrom ? -1 : 1;
    } else if (a.timeFrom || b.timeFrom) {
      return a.timeFrom ? -1 : 1;
    }
    return (a.caseNumber || 0) - (b.caseNumber || 0);
  });
}

/** 担当者・都道府県での絞り込み（担当は assignee-filter.js の matchAssignee と同じ規則） */
export function filterEvents(events, { assignee = "", pref = "", myEmail = "" } = {}) {
  return events.filter((e) => matchAssignee(e.assignedUserId, assignee, myEmail)
    && (!pref || e.prefecture === pref));
}

export function inRange(events, from, to) {
  return events.filter((e) => e.date >= from && e.date <= to);
}
export function groupByDate(events) {
  const m = new Map();
  for (const e of sortEvents(events)) {
    if (!m.has(e.date)) m.set(e.date, []);
    m.get(e.date).push(e);
  }
  return m;
}
/** 担当者別の件数（多い順。未割当は最後） */
export function countByAssignee(events) {
  const m = new Map();
  for (const e of events) {
    const key = (e.assignedUserId || "").trim().toLowerCase();
    const cur = m.get(key) || { id: key, name: e.assignedUserName || "担当未割当", count: 0 };
    if (!cur.name || cur.name === "担当未割当") cur.name = e.assignedUserName || cur.name;
    cur.count += 1;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => {
    if (!a.id !== !b.id) return a.id ? -1 : 1;
    return b.count - a.count || a.name.localeCompare(b.name, "ja");
  });
}
/** 予定に出てくる都道府県（絞り込みの選択肢用） */
export function prefecturesOf(events) {
  return [...new Set(events.map((e) => e.prefecture).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
}

// ---------- 表示用の文字列 ----------
/** "15:00〜16:00" / "15:00〜" / "時刻未定" */
export function timeLabel(timeFrom, timeTo) {
  if (!timeFrom) return "時刻未定";
  return timeTo ? `${timeFrom}〜${timeTo}` : `${timeFrom}〜`;
}
/** 一覧・カンバン用 "10/28" または "10/28 15:00"（日付が無ければ ""） */
export function visitShort(visitDate, timeFrom) {
  if (!isYmd(visitDate)) return "";
  const md = `${Number(visitDate.slice(5, 7))}/${Number(visitDate.slice(8, 10))}`;
  return isHhmm(timeFrom) ? `${md} ${timeFrom}` : md;
}
/** 一覧用 "2026/10/28" または "2026/10/28 15:00" */
export function visitFull(visitDate, timeFrom) {
  if (!visitDate) return "";
  const d = String(visitDate).replace(/-/g, "/");
  return isHhmm(timeFrom) ? `${d} ${timeFrom}` : d;
}
/** 案件詳細の活動記録用 "2026/10/28 15:00〜16:00（対面）" */
export function visitSummary({ visitDate, visitTimeFrom, visitTimeTo, visitFormat }) {
  if (!visitDate) return "未設定";
  let s = String(visitDate).replace(/-/g, "/");
  if (isHhmm(visitTimeFrom)) s += ` ${visitTimeFrom}〜${isHhmm(visitTimeTo) ? visitTimeTo : ""}`;
  if (FORMAT_LABELS[visitFormat]) s += `（${FORMAT_LABELS[visitFormat]}）`;
  return s;
}
export function dayLabel(ymd) {
  return `${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日（${WEEKDAYS[weekdayOf(ymd)]}）`;
}
export function titleOf(view, ymd) {
  if (view === "month") return `${ymd.slice(0, 4)}年${Number(ymd.slice(5, 7))}月`;
  if (view === "week") {
    const { from, to } = rangeOf("week", ymd);
    return `${from.slice(0, 4)}年${dayLabel(from).replace(/（.）/, "")}〜${dayLabel(to).replace(/（.）/, "")}`;
  }
  return `${ymd.slice(0, 4)}年${dayLabel(ymd)}`;
}

// ---------- Google カレンダー ----------
const compactDate = (ymd) => ymd.replace(/-/g, "");
function compactDateTime(ymd, minutes) {
  let d = ymd; let m = minutes;
  while (m >= 1440) { d = addDays(d, 1); m -= 1440; }
  return `${compactDate(d)}T${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}00`;
}
/**
 * dates パラメータ。時刻が無ければ終日（終了日は翌日＝排他的）、
 * 終了が無い（または開始以前）なら開始 + 60 分。
 */
export function googleCalendarDates(date, timeFrom, timeTo) {
  if (!isHhmm(timeFrom)) return `${compactDate(date)}/${compactDate(addDays(date, 1))}`;
  const s = minutesOf(timeFrom);
  const e = isHhmm(timeTo) && minutesOf(timeTo) > s ? minutesOf(timeTo) : s + 60;
  return `${compactDateTime(date, s)}/${compactDateTime(date, e)}`;
}
export function googleCalendarUrl(ev) {
  const title = `訪問 ${[ev.corpName, ev.officeName].filter(Boolean).join(" ")}`.trim();
  const details = [
    ev.assignedUserName ? `担当: ${ev.assignedUserName}` : "",
    ev.phone ? `電話: ${ev.phone}` : "",
    FORMAT_LABELS[ev.format] ? `形式: ${FORMAT_LABELS[ev.format]}` : "",
    `案件 #${ev.caseNumber || ""}`,
  ].filter(Boolean).join("\n");
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: googleCalendarDates(ev.date, ev.timeFrom, ev.timeTo),
    ctz: "Asia/Tokyo",
    location: ev.address || "",
    details,
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
export function googleMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// ---------- 準備の状況（日ビュー）----------
/** quotes から最新（version が大きい。無ければ先頭） */
export function latestQuote(quotes) {
  if (!quotes || !quotes.length) return null;
  return [...quotes].sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))[0];
}
export const QUOTE_LABELS = { issued: "見積 発行済み", accepted: "見積 受注確定", superseded: "見積 旧版", expired: "見積 期限切れ" };
/** 出荷：キャンセルを除いて、いちばん進んでいるもの */
const SHIP_ORDER = ["draft", "requested", "shipped", "invoiced", "paid"];
export function latestShipment(shipments) {
  const live = (shipments || []).filter((s) => s && s.status !== "canceled");
  if (!live.length) return null;
  return live.reduce((a, b) => (SHIP_ORDER.indexOf(b.status || "shipped") > SHIP_ORDER.indexOf(a.status || "shipped") ? b : a));
}

/** 担当の絞り込みの値。選択肢に無い（担当案件が無くなった等）ときだけ「全員」に戻す。選択肢の再構築では、いまの値を優先する */
export function pickAssignee(wanted, optionValues) {
  if (!wanted) return "";
  return (optionValues || []).includes(wanted) ? wanted : "";
}
