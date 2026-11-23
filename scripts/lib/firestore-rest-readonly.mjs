// 本番 Firestore を「読むだけ」で取る小さな道具（2026-11-24・経理への期末報告の答え合わせ用）。
//
// 🔴 書き込みはできない作り: 使う HTTP は GET（documents の一覧）だけ。POST/PATCH/DELETE・commit・runQuery の
//    書き込み系は一切呼ばない。トークンは gcloud のもの（`gcp run tadakayo ...` で動かす前提）。
//
// 値は Firestore REST の型付き JSON を、ふつうの JS の値に直して返す:
//   timestampValue → { _ts: "ISO文字列" }（JST の日付は accounting-rules.js の ymdJst が直す）
//   それ以外は素直に（integer は Number）。
import { execFileSync } from "node:child_process";

export function accessToken() {
  return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
}

export function decodeValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return { _ts: v.timestampValue };
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
export function decodeFields(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) o[k] = decodeValue(v);
  return o;
}

/** コレクションを全部読む（GET の一覧をページ送りで）。各文書に _id を付ける */
export async function listAll(project, collection, { token = accessToken(), database = "(default)" } = {}) {
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/${collection}`;
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 1000; i++) {
    const url = `${base}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const r = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`GET ${collection} → ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const id = d.name.split("/").pop();
      out.push({ _id: id, ...decodeFields(d.fields) });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}
