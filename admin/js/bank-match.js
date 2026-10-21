// 銀行の入金明細（CSV）を読み、どの出荷の入金かの候補を出す。純粋関数のみ（DOM・Firestore に触れない）。
// 設計: docs/CRM改善_設計_20261021.md §7（M）。テスト: node scripts/test-bank-match.mjs
// 🔴 確定は必ず人。autoSelect は「選んだ状態にする」だけで、記録は画面の「選んだ n件を入金として記録」で行う。
// import は相対パス（ブラウザでは /js/ 配下として、node のテストでもそのまま読める）。いずれも firebase を import していない。

import { parseCsv } from "./partner-order-import.js";
import { payerCodeOf } from "./invoice-doc.js";
import { payRemainOf } from "./case-complete-check.js";

export { parseCsv };

// 候補の点数（理由つきで見せる）
export const SCORE = { code: 50, amount: 40, alias: 30 };

// ===== 文字コード =====
/**
 * 明細ファイルのバイト列を文字列にする。UTF-8 として正しく読めればそれ、だめなら Shift_JIS（ネットバンキングの多く）。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{text:string, encoding:"utf-8"|"shift_jis"}}
 */
export function decodeBankFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let text, encoding;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    encoding = "utf-8";
  } catch (_) {
    text = new TextDecoder("shift_jis").decode(bytes);
    encoding = "shift_jis";
  }
  return { text: text.replace(/^﻿/, ""), encoding };
}

// ===== 日付・金額 =====
const pad2 = (n) => String(n).padStart(2, "0");
function validYmd(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad2(m)}-${pad2(d)}` : "";
}
/**
 * 明細の日付 → "YYYY-MM-DD"（読めなければ ""）。対応する形（後ろに時刻が付いていてもよい）:
 *   ① 2026-10-21 / 2026/10/21 / 2026.10.21（月日は1桁でも可）
 *   ② 20261021
 *   ③ 2026年10月21日
 *   ④ 和暦（令和）R8.10.21 / R08/10/21 / 令和8年10月21日
 */
export function parseBankDate(v) {
  const s = String(v ?? "").normalize("NFKC").trim();
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[\sT])/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})(\d{2})(\d{2})(?:$|\s)/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s))) return validYmd(+m[1], +m[2], +m[3]);
  if ((m = /^(?:R|令和)\s*(\d{1,2})[年./-](\d{1,2})[月./-](\d{1,2})日?(?:$|\s)/i.exec(s))) return validYmd(2018 + Number(m[1]), +m[2], +m[3]);
  return "";
}
/**
 * 明細の金額 → 数値（円）。記号（¥ ￥ , 円 + 空白）を除く。マイナス（- △ ▲ (…)）は負の数。空・読めなければ null。
 */
export function parseBankAmount(v) {
  let s = String(v ?? "").normalize("NFKC").trim();
  if (!s) return null;
  let neg = false;
  if (/^[-−△▲]/.test(s)) { neg = true; s = s.slice(1); }
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[¥￥,，円+\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

// ===== 名義・振込人コード =====
const SMALL_KANA = { ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ", ッ: "ツ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ヮ: "ワ", ヵ: "カ", ヶ: "ケ" };
/**
 * 振込名義の正規化（照合用）。NFKC（半角カナ→全角・全角英数→半角）→ ひらがな→カタカナ → 小書きカナを大きく → 英字は大文字 → 空白を除く。
 */
export function normalizePayer(v) {
  return String(v ?? "").normalize("NFKC")
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL_KANA[c])
    .toUpperCase()
    .replace(/\s+/g, "");
}
/**
 * 振込人コード（請求書番号＝出荷番号の末尾4桁。ご依頼人名の前に付けてもらう）を取り出す。無ければ ""。
 * 先頭の4桁を優先し、無ければ末尾の4桁（名前の後ろに付けた人）を見る。5桁以上の数字の一部は拾わない。
 */
export function extractCode(payer) {
  // 銀行によっては摘要の先頭に「振込」「ﾌﾘｺﾐ」などが付く（2026-10-21 E2E で確認）。読み飛ばしてからコードを探す
  const s = String(payer ?? "").normalize("NFKC").trim().replace(/^(?:振込|振替|入金|フリコミ|フリカエ)[\s　]*/, "");
  let m = /^(\d{4})(?!\d)/.exec(s);
  if (m) return m[1];
  m = /(?<!\d)(\d{4})$/.exec(s);
  return m ? m[1] : "";
}

// ===== 列の割り当て =====
/**
 * CSV の行（parseCsv の結果）を、列の割り当てに従って入金の行にする。出金・0円・日付が読めない行は捨てる（理由つき）。
 * @param {string[][]} rows
 * @param {{skip?:number, date:number, payer:number, amount?:number, deposit?:number, withdrawal?:number, balance?:number}} mapping
 *   skip … 先頭の読み飛ばす行数（見出し）。amount（符号つきの1列）か deposit（入金の列）のどちらかを指定する
 * @returns {{rows:{index:number, date:string, amount:number, payer:string, payerNorm:string, code:string, balance:number|null}[],
 *            skipped:{index:number, reason:string}[]}}
 *   index は元の CSV の行番号（0始まり）
 */
export function mapRows(rows, mapping = {}) {
  const out = [], skipped = [];
  const cell = (r, i) => (Number.isInteger(i) && i >= 0 ? r[i] : undefined);
  (rows || []).forEach((r, index) => {
    if (index < (Number(mapping.skip) || 0)) return;
    const date = parseBankDate(cell(r, mapping.date));
    if (!date) { skipped.push({ index, reason: "日付が読めない" }); return; }
    let amount;
    if (Number.isInteger(mapping.amount)) {
      amount = parseBankAmount(cell(r, mapping.amount));
    } else {
      amount = parseBankAmount(cell(r, mapping.deposit));
      const w = parseBankAmount(cell(r, mapping.withdrawal));
      if ((amount == null || amount === 0) && w) amount = -Math.abs(w);
    }
    if (amount == null) { skipped.push({ index, reason: "金額が読めない" }); return; }
    if (amount < 0) { skipped.push({ index, reason: "出金" }); return; }
    if (amount === 0) { skipped.push({ index, reason: "0円" }); return; }
    const payer = String(cell(r, mapping.payer) ?? "").trim();
    const balance = Number.isInteger(mapping.balance) ? parseBankAmount(cell(r, mapping.balance)) : null;
    out.push({ index, date, amount, payer, payerNorm: normalizePayer(payer), code: extractCode(payer), balance });
  });
  return { rows: out, skipped };
}

// ===== 二重取り込みの防止 =====
/**
 * 明細1行の指紋（SHA-256 の16進）。bankTxns/{hash} のドキュメントIDにする。
 * 日付・金額・正規化名義と、同じファイル内で同じ組み合わせが何回目か（ordinal）から作る。
 * → 同じファイル・期間が重なるファイルを再び取り込んでも同じ値になり、同日・同額・同名義の2回の振込は別の値になる。
 * 残高は入れない（2026-10-21 レビュー指摘）。残高は期間の切り方・出金の有無で同じ入金でも変わることがあり、
 * 入れると同じ入金が別の指紋になって二重に取り込めてしまうため。
 */
export async function rowHash(row, ordinal = 0) {
  const key = [row.date, row.amount, row.payerNorm ?? normalizePayer(row.payer), ordinal].join("|");
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** mapRows の行すべてに hash を付ける（同じ組み合わせの2件目以降は ordinal を進める）。元の配列は変えない。 */
export async function hashRows(rows) {
  const seen = new Map();
  const out = [];
  for (const r of rows || []) {
    const base = [r.date, r.amount, r.payerNorm ?? normalizePayer(r.payer)].join("|");
    const k = seen.get(base) || 0;
    seen.set(base, k + 1);
    out.push({ ...r, hash: await rowHash(r, k) });
  }
  return out;
}

/**
 * bankTxns のドキュメントIDの候補（hash, hash-2, hash-3, …）。
 * 同じ日付・金額・名義の別の振込を別のCSVで取り込むと、指紋（hash）が同じになる（ordinal はファイルの中でしか数えないため）。
 * 人が「別の振込として記録する」と確かめたときは、空いている番号を tx の中で探して使う（2026-10-21 Codex 指摘3）。
 */
export const MAX_TXN_SUFFIX = 20;
export function bankTxnIdCandidates(hash, max = MAX_TXN_SUFFIX) {
  const out = [String(hash)];
  for (let i = 2; i <= max; i++) out.push(`${hash}-${i}`);
  return out;
}
/** 候補のうち最初の空いているID（exists は候補と同じ並びの真偽）。空きが無ければ null */
export function pickFreeTxnId(hash, exists, max = MAX_TXN_SUFFIX) {
  const ids = bankTxnIdCandidates(hash, max);
  for (let i = 0; i < ids.length; i++) if (!(exists && exists[i])) return ids[i];
  return null;
}

// ===== 照合 =====
/** 請求先の同一判定キー（supply.js の billToKey と同じ: 直送＝認定事業者のメール／直接＝事業所名） */
export function billToKeyOf(s) {
  return s.shipType === "dropship" ? (s.partnerEmail || s.partnerName || "") : (s.company || s.officeName || "");
}
const idOf = (s) => (s && (s._id ?? s.id)) || "";
// 入金を待っている出荷（発送済・請求済で残額あり）
function openShipments(shipments) {
  return (shipments || []).filter((s) => s && ["shipped", "invoiced"].includes(s.status || "shipped") && payRemainOf(s) > 0);
}
function aliasKeysFor(aliases, payerNorm) {
  if (!aliases || !payerNorm) return [];
  const v = aliases instanceof Map ? aliases.get(payerNorm) : aliases[payerNorm];
  return Array.isArray(v) ? v : v ? [v] : [];
}

/**
 * 入金の行ごとに、出荷の候補を点数順に並べる（点数 0 の出荷は候補にしない）。
 * @param {object[]} bankRows   mapRows().rows
 * @param {object[]} shipments  出荷（_id か id・soNumber・status・金額の項目）
 * @param {{aliases?:Map<string,string[]>|Object<string,string[]>}} opts
 *   aliases … 名義の学習（正規化した振込名義 → 請求先キー billToKeyOf の配列）。bankConfig に保存したもの
 * @returns {{row:object, candidates:{shipmentId:string, soNumber:string, remain:number, score:number,
 *   codeMatch:boolean, amountMatch:boolean, aliasMatch:boolean, reasons:string[], shipment:object}[]}[]}
 */
export function buildCandidates(bankRows, shipments, { aliases } = {}) {
  const open = openShipments(shipments).map((s) => ({ s, code: payerCodeOf(s), remain: payRemainOf(s), bill: billToKeyOf(s) }));
  return (bankRows || []).map((row) => {
    const learned = aliasKeysFor(aliases, row.payerNorm ?? normalizePayer(row.payer));
    const candidates = [];
    for (const o of open) {
      const codeMatch = !!row.code && row.code === o.code;
      const amountMatch = Number(row.amount) === o.remain;
      const aliasMatch = !!o.bill && learned.includes(o.bill);
      const score = (codeMatch ? SCORE.code : 0) + (amountMatch ? SCORE.amount : 0) + (aliasMatch ? SCORE.alias : 0);
      if (!score) continue;
      const reasons = [];
      if (codeMatch) reasons.push(`振込人コード ${row.code} が一致`);
      if (amountMatch) reasons.push(`金額が残額 ¥${o.remain.toLocaleString("ja-JP")} と一致`);
      if (aliasMatch) reasons.push("過去に同じ名義をこの請求先で記録");
      candidates.push({ shipmentId: idOf(o.s), soNumber: o.s.soNumber || "", remain: o.remain, score,
        codeMatch, amountMatch, aliasMatch, reasons, shipment: o.s });
    }
    candidates.sort((a, b) => b.score - a.score || String(a.soNumber).localeCompare(String(b.soNumber)));
    return { row, candidates };
  });
}

/**
 * 自動で「選んだ状態」にしてよい組だけを返す。
 * 条件: その行で「コードと金額の両方が一致」する候補がちょうど1件で、かつその出荷を「両方一致」で指す行もその1行だけ（1対1）。
 * コードだけ・金額だけの一致や、同じ出荷を2行が指す・1行が2出荷を指すときは選ばない（人が選ぶ）。
 * @param {ReturnType<typeof buildCandidates>} matched
 * @returns {{rowIndex:number, shipmentId:string}[]}
 */
export function autoSelect(matched) {
  const strongOf = (m) => m.candidates.filter((c) => c.codeMatch && c.amountMatch);
  const perShipment = new Map();
  for (const m of matched || []) for (const c of strongOf(m)) perShipment.set(c.shipmentId, (perShipment.get(c.shipmentId) || 0) + 1);
  const out = [];
  for (const m of matched || []) {
    const strong = strongOf(m);
    if (strong.length === 1 && perShipment.get(strong[0].shipmentId) === 1) out.push({ rowIndex: m.row.index, shipmentId: strong[0].shipmentId });
  }
  return out;
}
