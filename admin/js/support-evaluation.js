// 伴走支援者トレーニングの評価・バッジの純粋関数（判定・検証・CSV）。
// support-checklist.js（評価入力・付与）と badges.js（台帳・特別裁量・CSV）から使う。
// Firebase に依存しないので node で単体テストできる（scripts/test-support-evaluation.mjs）。
// 仕様の正本: 組織体制_素案_20261018/トレーニング評価シート_案.md・バッジ台帳.md（次田さん決定 2026-10-18）
//   - 独り立ち可＝④個人情報・安全が◎、ほかが全て○以上、かつOJTで1回でも合格（OK）
//   - トレーナー立会いなしのOJT・見学は評価の対象外
//   - バッジは進呈制（トレーナーのうち1名が付与）。特別裁量は理由必須・先例にしない

export const ITEMS = [
  { n: 1, label: "事前準備" },
  { n: 2, label: "設定の手順" },
  { n: 3, label: "ケアプー（連携）" },
  { n: 4, label: "個人情報・安全" },
  { n: 5, label: "説明・声かけ" },
  { n: 6, label: "トラブル時の対応" },
  { n: 7, label: "記録（CRM）" },
  { n: 8, label: "助成金の案内" },
];
export const SAFETY_ITEM = 4;

// ◎ひとりでできる ／ ○助言があればできる ／ △要練習 ／ × 未実施
export const GRADES = ["◎", "○", "△", "×"];
const RANK = { "◎": 3, "○": 2, "△": 1, "×": 0 };

export const JUDGEMENTS = [
  { v: "independent", t: "独り立ち可（バッジ付与）" },
  { v: "retrain", t: "もう一度トレーニング" },
  { v: "hold", t: "保留（要相談）" },
];
export const judgementLabel = (v) => (JUDGEMENTS.find((j) => j.v === v) || {}).t || "";

// 初期トレーナー4名（バッジ台帳.md）。users の name から空白を除いて照合する。
// appConfig/supportTrainers.ids（メールの配列）があればそちらを優先する。
export const INITIAL_TRAINER_NAMES = ["蜂須賀大策", "藤田博之", "次田芳尚", "石田祐樹"];
const squash = (s) => String(s || "").replace(/[\s　]/g, "");

export function trainerIds(users, rosterIds) {
  if (Array.isArray(rosterIds) && rosterIds.length) return rosterIds.slice();
  return (users || []).filter((u) => INITIAL_TRAINER_NAMES.includes(squash(u.name))).map((u) => u._id);
}
export function isTrainer(userId, users, rosterIds) {
  return !!userId && trainerIds(users, rosterIds).includes(userId);
}

// 自動判定の提案。ojtOk＝この回または過去の評価でOJT合格（OK）が1回でもあるか。
// 未入力があれば incomplete（判定しない）。保留は人が選ぶものなので提案しない。
export function suggestJudgement(scores, ojtOk) {
  const s = scores || {};
  if (ITEMS.some((i) => !(s[i.n] in RANK))) return "incomplete";
  const safetyOk = s[SAFETY_ITEM] === "◎";
  const othersOk = ITEMS.filter((i) => i.n !== SAFETY_ITEM).every((i) => RANK[s[i.n]] >= RANK["○"]);
  return safetyOk && othersOk && !!ojtOk ? "independent" : "retrain";
}

export const evaluationId = (caseId, date, traineeId) => `${caseId}__${date}__${traineeId}`;

// performance は第1段階の実施の記録（保存済み）。評価の対象は「トレーニング」＋トレーナーありのみ。
export function evaluationEligible(perf) {
  return !!(perf && perf.mode === "training" && perf.trainerId && perf.performerId && perf.date);
}

// priorOk: 同じ受講者の過去の評価に OK があるか
export function buildEvaluation(input, perf, ctx) {
  if (!evaluationEligible(perf)) return { error: "評価できるのは、区分が「トレーニング」でトレーナーが入った実施の記録だけです（トレーナーなしのOJT・見学は対象外）。" };
  const scores = {};
  for (const i of ITEMS) {
    const g = input.scores && input.scores[i.n];
    if (!(g in RANK)) return { error: `「${i.n} ${i.label}」の評価（◎○△×）を選んでください。` };
    scores[i.n] = g;
  }
  if (input.ojtResult !== "ok" && input.ojtResult !== "ng") return { error: "OJTの合否（OK／まだ）を選んでください。" };
  if (!JUDGEMENTS.some((j) => j.v === input.judgement)) return { error: "総合判定を選んでください。" };
  const suggested = suggestJudgement(scores, input.ojtResult === "ok" || !!ctx.priorOk);
  return {
    evaluation: {
      caseId: ctx.caseId,
      date: perf.date,
      traineeId: perf.performerId,
      traineeName: perf.performerName || perf.performerId,
      trainerId: perf.trainerId,
      trainerName: perf.trainerName || perf.trainerId,
      scores,
      ojtResult: input.ojtResult,
      suggested,
      judgement: input.judgement,
      overridden: suggested !== input.judgement, // トレーナーが提案と違う判定にした
      note: String(input.note || "").trim(),
      recordedAt: ctx.now,
      recordedBy: ctx.actor || "",
    },
  };
}

// バッジ保持者（userId の集合）
export function badgeHolders(grants) {
  return new Set((grants || []).map((g) => g.userId));
}

// バッジ付与。付与できるのはトレーナーのみ。
//   basis=evaluation: 根拠は評価シート（評価が「独り立ち可」であること）
//   basis=discretion: 特別裁量。理由必須（先例にしない）
export function buildGrant(input, ctx) {
  const { users, rosterIds, grants, evaluations } = ctx;
  const nameOf = (id) => { const u = (users || []).find((x) => x._id === id); return u ? (u.name || u._id) : id; };
  if (!isTrainer(ctx.actorId, users, rosterIds)) return { error: "バッジを付与できるのはトレーナーだけです。" };
  if (!input.userId) return { error: "対象の人を選んでください。" };
  if (badgeHolders(grants).has(input.userId)) return { error: "この人にはすでにバッジを付与済みです。" };
  if (!input.date) return { error: "付与日を入れてください。" };
  const g = {
    userId: input.userId,
    userName: nameOf(input.userId),
    grantedDate: input.date,
    grantedById: ctx.actorId,
    grantedByName: nameOf(ctx.actorId),
    basis: input.basis,
    evaluationId: null,
    caseId: null,
    reason: String(input.reason || "").trim(),
    recordedAt: ctx.now,
    recordedBy: ctx.actor || "",
  };
  if (input.basis === "discretion") {
    if (!g.reason) return { error: "特別裁量で付与するときは、理由を書いてください（先例にはしません）。" };
    return { grant: g };
  }
  if (input.basis === "evaluation") {
    const ev = (evaluations || []).find((e) => e._id === input.evaluationId);
    if (!ev) return { error: "根拠の評価シートが見つかりません。" };
    if (ev.traineeId !== input.userId) return { error: "評価シートの受講者と、付与する人が一致しません。" };
    if (ev.judgement !== "independent") return { error: "評価シートの総合判定が「独り立ち可」ではありません。" };
    g.evaluationId = ev._id;
    g.caseId = ev.caseId;
    return { grant: g };
  }
  return { error: "根拠（評価シート／特別裁量）を選んでください。" };
}

// 単独実施の警告（ブロックはしない）。実施者がバッジ未保持なら文言を返す。
export function soloWarning(perf, grants) {
  if (!perf || perf.mode !== "solo") return "";
  if (badgeHolders(grants).has(perf.performerId)) return "";
  return `注意：実施者（${perf.performerName || perf.performerId}）は伴走支援者バッジ未付与です。単独での実施は、バッジ付与後が原則です（記録は保存されています）。`;
}

// 台帳CSV（Excel で文字化けしないよう BOM は呼び出し側で付ける）
const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function badgesToCsv(grants) {
  const head = ["付与日", "対象", "対象メール", "認定したトレーナー", "根拠区分", "根拠・理由", "評価記録（案件ID）", "評価記録ID"];
  const rows = (grants || []).slice().sort((a, b) => String(a.grantedDate).localeCompare(String(b.grantedDate)))
    .map((g) => [
      g.grantedDate, g.userName, g.userId, g.grantedByName,
      g.basis === "discretion" ? "特別裁量" : "評価シート",
      g.reason, g.caseId || "", g.evaluationId || "",
    ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
