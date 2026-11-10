// 当日タブと伴走支援の記録・対応記録をつなぐ判定（2026-11-10・設計書 提案1／提案5）。
// DOM も Firestore も触らない純関数だけを置く（scripts/test-onsite-record.mjs で実行して確かめる）。
//
// 提案1: 当日の「訪問日」を正にして、伴走支援の記録の実施日（新規入力欄）と実施の記録の実施日の
//        **初期値**に使う。欄が空のときだけ入れる。保存済みの performance.date は絶対に書き換えない
//        （トレーニング評価のIDが「案件ID__実施日__実施者」なので、黙って変えると評価が別物になる）。
// 提案5: 対応記録（activities）に任意の refType（"session" | "onsite"）と refId を持たせ、
//        一覧から当日タブの該当の場所を開けるようにする。既存の記録（ref なし）はそのまま。

// 当日の訪問日。保存済みの onsite.visitDate を正とし、無ければ当日タブの訪問日欄に初期表示している
// 案件の訪問予定日（cases.visitDate）を使う（画面で「訪問日」として見えている値と同じにする）
export function effectiveVisitDate(onsite, caseDoc) {
  const saved = onsite && typeof onsite.visitDate === "string" ? onsite.visitDate.trim() : "";
  if (saved) return saved;
  const planned = caseDoc && typeof caseDoc.visitDate === "string" ? caseDoc.visitDate.trim() : "";
  return planned;
}

// 入力欄に初期値を入れるか。入れるなら入れる値、入れないなら null。
// current: いま欄に入っている値／dirty: 利用者が触って未保存（自分で消した場合も含む）
export function dateDefault(current, visitDate, { dirty = false } = {}) {
  if (dirty) return null;
  if (current != null && String(current).trim() !== "") return null;
  if (!visitDate) return null;
  return visitDate;
}

// 実施の記録の実施日の初期値。保存済みの performance に実施日があれば絶対に入れない
export function perfDateDefault(savedPerf, current, visitDate, { dirty = false } = {}) {
  if (savedPerf && savedPerf.date) return null;
  return dateDefault(current, visitDate, { dirty });
}

// 旧タブ名 → いまのタブ名（「伴走支援」タブは当日タブの末尾へ移した）
export const TAB_ALIAS = { sessions: "onsite" };
export const resolveTab = (name) => TAB_ALIAS[name] || name;
