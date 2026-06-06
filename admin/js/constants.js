// admin/js/constants.js — 案件ステータス等の定義の単一情報源（SSOT / C1）
// 13ステータスの数値はそのまま。表示・整理のため 5 フェーズに束ねる。
// 旧: cases.js / kanban.js / dashboard.js に重複していた定義をここへ集約。

export const STATUS_LABELS = {
  1: "新規受信", 2: "確認中", 3: "受注確定", 4: "失注",
  5: "担当者決定", 6: "事前準備中", 7: "伴走支援待ち",
  8: "伴走支援実施済", 9: "書類準備完了・申請ガイド中",
  10: "申請完了・採択待ち", 11: "採択・入金待ち",
  12: "アフターフォロー中", 13: "案件完了",
};

export const STATUS_COLORS = {
  1: "#1d4ed8", 2: "#0369a1", 3: "#15803d", 4: "#6b7280", 5: "#0f766e",
  6: "#c2410c", 7: "#b45309", 8: "#4d7c0f", 9: "#7c3aed", 10: "#a21caf",
  11: "#be185d", 12: "#be123c", 13: "#065f46",
};

export const LOST = 4; // 失注（別枠・どのフェーズからも遷移しうる）

// 5フェーズ（13ステータスを束ねる）。失注(4)は別枠。
export const PHASES = [
  { id: 1, label: "受付・受注",     color: "#1d4ed8", statuses: [1, 2, 3] },
  { id: 2, label: "準備",           color: "#0f766e", statuses: [5, 6] },
  { id: 3, label: "伴走支援",       color: "#15803d", statuses: [7, 8] },
  { id: 4, label: "申請・採択",     color: "#7c3aed", statuses: [9, 10, 11] },
  { id: 5, label: "完了・フォロー", color: "#065f46", statuses: [12, 13] },
];

const _statusToPhase = {};
PHASES.forEach((p) => p.statuses.forEach((s) => { _statusToPhase[s] = p; }));

// status番号 → フェーズ定義（失注など該当なしは null）
export function phaseOf(status) { return _statusToPhase[Number(status)] || null; }
// フェーズの先頭ステータス（フェーズ間ドラッグ時の遷移先）
export function phaseEntryStatus(phaseId) {
  const p = PHASES.find((x) => x.id === Number(phaseId));
  return p ? p.statuses[0] : null;
}

// パイプライン順（フェーズ1→5、失注は末尾）。サブ状態の順序も保持。
export const STATUS_ORDER = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 4];

export const SOURCE_LABELS = {
  lp_inquiry: "LP問い合わせ", mitsumori_quote: "見積もり成約", manual: "手動登録",
};
export const SOURCE_LABELS_SHORT = {
  lp_inquiry: "LP", mitsumori_quote: "見積", manual: "手動",
};

// 申請期限（将来 B4 で設定化予定）
export const DEADLINE = new Date("2027-03-12T23:59:59+09:00");
export const STALE_DAYS = 7;                          // 停滞とみなす最終更新からの日数
export const TERMINAL = [4, 13];                      // 失注・完了（停滞/アラート対象外）
export const ACTIVE_PRE_APPLY = [1, 2, 3, 5, 6, 7, 8, 9]; // 未申請の進行中

// 共通ヘルパ
export function daysUntilDeadline() {
  return Math.ceil((DEADLINE - new Date()) / 86400000);
}
export function daysSince(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
