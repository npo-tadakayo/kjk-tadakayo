// 倉庫画面「一覧」タブの純粋関数（2026-11-04）。DOM・firebase を import しない（node の単体テスト scripts/test-warehouse-ui.mjs から直接読む）。
// 行（row）は warehouseList が返す W（requested／done）に mode ("requested"|"done") を足したもの。
import { deliveryModeOf } from "./warehouse-rules.js";

export const FILTERS = { unconfirmed: "未確認", unshipped: "未発送", all: "すべて" };

// Timestamp・{seconds}・ミリ秒・ISO文字列のどれでも ms にする（無ければ 0）
export function toMs(t) {
  if (!t) return 0;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (t.seconds != null) return t.seconds * 1000;
  if (t._seconds != null) return t._seconds * 1000;
  const n = new Date(t).getTime();
  return Number.isNaN(n) ? 0 : n;
}

// 行をつくる。requested／done の W に mode を付ける
export function buildRows(requested, done) {
  return [
    ...(Array.isArray(requested) ? requested : []).map((s) => ({ ...s, mode: "requested" })),
    ...(Array.isArray(done) ? done : []).map((s) => ({ ...s, mode: "done" })),
  ];
}

// 台数＝品目の qty の合計（行ごと）
export function qtyOf(s) {
  return (Array.isArray(s && s.items) ? s.items : []).reduce((a, i) => a + (Number(i && i.qty) || 0), 0);
}

// 未確認＝依頼済で確認済みでない
export const isUnconfirmed = (s) => s.mode === "requested" && !s.warehouseConfirmed;

export function filterRows(rows, filter, query) {
  let out = rows;
  if (filter === "unconfirmed") out = out.filter(isUnconfirmed);
  else if (filter === "unshipped") out = out.filter((s) => s.mode === "requested");
  const q = norm(query);
  if (q) out = out.filter((s) => searchText(s).includes(q));
  return out;
}

function norm(v) { return String(v == null ? "" : v).normalize("NFKC").toLowerCase().replace(/\s+/g, ""); }
// 検索の対象: 出荷番号・事業所名・宛先（法人・宛名・住所・郵便番号・電話）・依頼者（受け渡しは持ち出す人）
function searchText(s) {
  return norm([s.soNumber, s.officeName, s.company, s.contactName, s.address, s.postalCode, s.phone, s.requestedByName, s.pickupByName].join(" "));
}

// 並べ替え。key: "requestedAt" | "qty"。dir: "asc" | "desc"。同じなら出荷番号順
export function sortRows(rows, key, dir) {
  const sign = dir === "desc" ? -1 : 1;
  const val = (s) => (key === "qty" ? qtyOf(s) : toMs(s.requestedAt));
  return [...rows].sort((a, b) => (val(a) - val(b)) * sign || String(a.soNumber || "").localeCompare(String(b.soNumber || "")));
}

// 同じ宛先（郵便番号＋住所＋事業所名が同じ）の依頼済の件数。受け渡し（持ち出し）は宛先が無いので数えない。
// 戻り値は Map<キー, 件数>。destKey が空のものは入らない
export function destKey(s) {
  if (!s || deliveryModeOf(s) === "pickup") return "";
  const k = [s.postalCode, s.address, s.officeName].map((v) => norm(v).replace(/[〒\-ー−‐―]/g, "")).join("|");
  return k === "||" ? "" : k;
}
export function sameDestCounts(rows) {
  const m = new Map();
  for (const s of rows) {
    if (s.mode !== "requested") continue;
    const k = destKey(s);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
export function sameDestOf(s, counts) {
  if (s.mode !== "requested") return 0;
  const n = counts.get(destKey(s)) || 0;
  return n >= 2 ? n : 0;
}

// ---- CSV ----
// セルを CSV 用にする。先頭が = + - @ タブ 改行 のものは先頭に ' を付ける（表計算ソフトで式として実行されないように）。
// すべて "..." で囲み、中の " は "" にする
export function csvCell(v) {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r\n]/.test(t)) t = "'" + t;
  return `"${t.replace(/"/g, '""')}"`;
}
export const CSV_HEADER = ["依頼日", "依頼者", "台数", "送付方法", "郵便番号", "住所", "事業所名", "宛名", "電話", "出荷番号", "確認済み", "確認した人", "発送済み", "発送日", "追跡番号", "備考"];

// JST の "YYYY-MM-DD HH:mm"
export function fmtJstDateTime(t) {
  const ms = toMs(t);
  if (!ms) return "";
  return new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}

export function csvRow(s) {
  const pickup = deliveryModeOf(s) === "pickup";
  const done = s.mode === "done";
  return [
    fmtJstDateTime(s.requestedAt), s.requestedByName || "", qtyOf(s),
    pickup ? "受け渡し" : "発送",
    pickup ? "" : s.postalCode || "", pickup ? "" : s.address || "",
    pickup ? "" : s.officeName || "", pickup ? s.pickupByName || "" : [s.company, s.contactName].filter(Boolean).join(" "), pickup ? "" : s.phone || "",
    s.soNumber || "",
    done || s.warehouseConfirmed ? "済" : "", s.warehouseConfirmedByName || "",
    done ? "済" : "", done ? s.shipDate || "" : "", s.trackingNumber || "", s.warehouseNote || "",
  ];
}
// 先頭に BOM（Excel・Google スプレッドシートで文字化けしない）。改行は CRLF
export function buildCsv(rows) {
  return "\uFEFF" + [CSV_HEADER, ...rows.map(csvRow)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
// 出荷一覧_保管場所名_YYYYMMDD.csv（ファイル名に使えない文字は _ に）
export function csvFileName(locationName, ymd) {
  const loc = String(locationName || "").replace(/[\\/:*?"<>|\s]+/g, "_") || "保管場所";
  return `出荷一覧_${loc}_${String(ymd || "").replace(/-/g, "")}.csv`;
}
