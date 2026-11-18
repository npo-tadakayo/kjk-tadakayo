// functions/data-purge.js — 役目を終えた記録の自動削除（2026-11-19・セキュリティ点検の残件「データ自動削除」）
//
// 目的: 個人情報・連絡先を含みうる「使い終わった記録」を、必要以上に持ち続けない。
//   削除してよいものを、コレクションごとに「条件」で決める。Firestore の TTL（項目に deleteAt を持たせる方式）は
//   使わない。理由: ①承諾書は署名した瞬間に「消さない」へ変わるので、署名と削除が行き違うおそれがある
//   ②既存のデータにも項目を足す作業（バックフィル）が要る。条件で消す掃除なら、どちらも要らない。
//
// 消すもの（RULES）
//   leadTokens       継続リンクの鍵。有効期限（expiresAt・30日）を過ぎて7日たったもの
//   _notifyLog       Chat 通知の二重送信防止の記録。作成から90日たったもの
//   _rateLimit       見積書メールの送信数のカウンタ。その日の終わり＋7日（expiresAt）を過ぎたもの
//   consentRequests  承諾書の依頼のうち「署名のないもの」（status が pending か canceled）で、作成から180日たったもの。
//                    ★署名済み（status:"signed"・signed がある・kind:"order"）は、どんな条件でも消さない
//
// 消さないもの（このファイルでは触らない）: cases・quotes・shipments・activities・offices・署名済みの承諾書ほか全部。
//
// 使い方: purgeExpired(db, { now, dryRun })。dryRun:true なら数えるだけで何も消さない（既定）。
//   本番では appConfig/dataPurge.enabled が true のときだけ消す（index.js の purgeExpiredData）。
"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 400;      // 1回の削除バッチの件数（Firestore の上限500より下）
const MAX_ROUNDS = 25;  // 1コレクションあたりの最大ループ（BATCH × MAX_ROUNDS = 10,000件まで・超えたら次の日に続き）

// field: この項目が「now − ageDays」より古いものが対象。keep(data): false を返したものは消さない。
const RULES = [
  { coll: "leadTokens", field: "expiresAt", ageDays: 7, keep: () => false },
  { coll: "_notifyLog", field: "createdAt", ageDays: 90, keep: () => false },
  { coll: "_rateLimit", field: "expiresAt", ageDays: 0, keep: () => false },
  { coll: "consentRequests", field: "createdAt", ageDays: 180, keep: keepConsent },
];

// 承諾書は「署名のない依頼」だけが対象。少しでも署名の気配があれば残す（安全側）。
function keepConsent(d) {
  if (!d) return true;
  if (d.kind === "order") return true;                 // 発注の承諾書は作った時点で署名済み
  if (d.signed != null) return true;                   // 署名の記録がある
  if (d.status !== "pending" && d.status !== "canceled") return true; // signed・その他の状態は残す
  return false;
}

function toMillis(v) {
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return null;
}

/**
 * 1つのルールを処理する。戻り値 { coll, scanned, would, deleted, kept, capped }
 *   scanned: 期限を過ぎていた件数／would: 消す対象の件数（dryRun でも数える）／deleted: 実際に消した件数（dryRun なら 0）
 *   kept: 条件で残した件数（署名済みの承諾書など）／capped: 上限に当たって途中で止めた（次の日に続きをやる）
 * 「残すもの」が先頭のページを占めても先へ進めるよう、最後に見たドキュメントを目印（カーソル）にして順に読む。
 */
async function purgeRule(db, rule, { now, dryRun }) {
  const cutoff = new Date(now - rule.ageDays * DAY_MS);
  let would = 0, deleted = 0, kept = 0, scanned = 0, capped = false, last = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 単一項目の範囲検索だけ（複合インデックス不要）
    let q = db.collection(rule.coll).where(rule.field, "<", cutoff).orderBy(rule.field).limit(BATCH);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    const targets = [];
    for (const d of snap.docs) {
      scanned++;
      // 取れたドキュメント側の値でも期限を確かめる（Timestamp でない項目のものは触らない）
      const ms = toMillis(d.get(rule.field));
      if (ms == null || ms >= cutoff.getTime()) { kept++; continue; }
      if (rule.keep(d.data())) { kept++; continue; }
      targets.push(d.ref);
    }
    would += targets.length;
    if (!dryRun && targets.length) {
      const batch = db.batch();
      targets.forEach((r) => batch.delete(r));
      await batch.commit();
      deleted += targets.length;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH) break;
    if (round === MAX_ROUNDS - 1) capped = true;
  }
  return { coll: rule.coll, scanned, would, deleted, kept, capped };
}

/** すべてのルールを順に処理する。1つのコレクションで失敗しても、ほかは続ける。 */
async function purgeExpired(db, { now = Date.now(), dryRun = true } = {}) {
  const results = [];
  for (const rule of RULES) {
    try {
      results.push(await purgeRule(db, rule, { now, dryRun }));
    } catch (e) {
      results.push({ coll: rule.coll, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  return { dryRun, results };
}

module.exports = { purgeExpired, purgeRule, RULES, keepConsent, DAY_MS };
