// 伴走支援「実施の記録」の純粋関数（誰が・いつ・どの区分で実施したか）。
// support-checklist.js から使う。Firebase に依存しないので node で単体テストできる
// （scripts/test-support-performance.mjs）。
// 運用: CRMの営業担当＝伴走支援者。トレーナーなしのOJTによる認定は認めない
//   ＝区分「トレーニング」はトレーナー必須。

export const MODES = [
  { v: "solo", t: "単独" },
  { v: "training", t: "トレーニング（トレーナー立会い）" },
  { v: "observe", t: "見学" },
];

export function modeLabel(v) {
  const m = MODES.find((x) => x.v === v);
  return m ? m.t.replace(/（.*）/, "") : "";
}

// 入力 → 保存用の performance オブジェクト。エラーなら { error } を返す。
// users は [{ _id(email), name }] 。名前は users から引き直して保存する（画面の表示文字列を信用しない）。
export function buildPerformance(input, users, actor, now) {
  const list = Array.isArray(users) ? users : [];
  const nameOf = (id) => {
    const u = list.find((x) => x._id === id);
    return u ? (u.name || u._id) : id;
  };
  const date = String(input.date || "").trim();
  const performerId = String(input.performerId || "").trim();
  const mode = String(input.mode || "").trim();
  const trainerId = String(input.trainerId || "").trim();
  if (!date) return { error: "実施日を入れてください。" };
  if (!performerId) return { error: "実施者を選んでください。" };
  if (!MODES.some((m) => m.v === mode)) return { error: "区分を選んでください。" };
  if (mode === "training" && !trainerId) {
    return { error: "区分が「トレーニング」のときは、トレーナーを選んでください（トレーナーなしの認定は行いません）。" };
  }
  const companions = mode === "solo" ? "" : String(input.companions || "").trim();
  return {
    performance: {
      date,
      performerId,
      performerName: nameOf(performerId),
      mode,
      trainerId: trainerId || null,
      trainerName: trainerId ? nameOf(trainerId) : "",
      companions,
      note: String(input.note || "").trim(),
      recordedAt: now,
      recordedBy: actor || "",
    },
  };
}

// 保存済みの performance → タブ上部の1行
export function summaryLine(p) {
  if (!p || !p.date) return "";
  const parts = [`実施：${p.date}`, `実施者：${p.performerName || p.performerId || "—"}`, `区分：${modeLabel(p.mode) || "—"}`];
  if (p.trainerName) parts.push(`トレーナー：${p.trainerName}`);
  return parts.join("／");
}
