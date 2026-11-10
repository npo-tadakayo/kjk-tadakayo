// 当日タブと伴走支援の記録・対応記録をつなぐ判定（2026-11-10・設計書 提案1／提案5）。
// DOM も Firestore も触らない純関数だけを置く（scripts/test-onsite-record.mjs で実行して確かめる）。
//
// 提案1: 当日の「訪問日」を正にして、伴走支援の記録の実施日（新規入力欄）と実施の記録の実施日の
//        **初期値**に使う。欄が空のときだけ入れる。保存済みの performance.date は絶対に書き換えない
//        （トレーニング評価のIDが「案件ID__実施日__実施者」なので、黙って変えると評価が別物になる）。
// 提案5: 対応記録（activities）に任意の refType（"session" | "onsite"。提案2 の複写は "onsiteCopy"）と refId を持たせ、
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
// lastAuto: この欄に最後に自動で入れた値。欄の値がそれと同じ（＝人が入れた値ではない）なら、
//           訪問日が変わったときに新しい訪問日へ置き換える（2026-11-10 レビュー 中-2）
export function dateDefault(current, visitDate, { dirty = false, lastAuto = "" } = {}) {
  if (dirty) return null;
  if (!visitDate) return null;
  const cur = current == null ? "" : String(current).trim();
  if (cur === "") return visitDate;
  if (lastAuto && cur === lastAuto && cur !== visitDate) return visitDate;
  return null;
}

// 実施の記録の実施日の初期値。保存済みの performance に実施日があれば絶対に入れない
export function perfDateDefault(savedPerf, current, visitDate, { dirty = false, lastAuto = "" } = {}) {
  if (savedPerf && savedPerf.date) return null;
  return dateDefault(current, visitDate, { dirty, lastAuto });
}

// 「当日の記録を確定」で使う訪問日。画面の訪問日欄に表示されている値を正にする（表示と保存を食い違わせない）。
// 保存済みの onsite.visitDate と違えば（案件の訪問予定日を表示しているだけ等）、その日を保存してから確定する
export function confirmVisitDate(displayed, saved) {
  const date = displayed == null ? "" : String(displayed).trim();
  if (!date) return { date: "", needsSave: false };
  return { date, needsSave: date !== (saved || "") };
}

const doneCount = (steps, keys) => keys.filter((k) => steps && steps[k] && steps[k].done === true).length;

// 「当日の記録を確定」で対応記録に入れる1行。利用者氏名・被保険者証番号は入れない（件数と日付だけ）
// stepKeys: 介護情報基盤の当日工程のキー／cpStepKeys: ケアプラン連携の導入作業のキー
export function onsiteConfirmSummary({ onsite, cp, visitDate, stepKeys = [], cpStepKeys = [], cpInstalled = false }) {
  const kiban = doneCount(onsite && onsite.steps, stepKeys);
  const lines = [`介護情報基盤の当日工程: ${kiban}/${stepKeys.length} 完了`];
  if (cpInstalled) lines.push("ケアプラン連携: 導入済みのため省略");
  else lines.push(`ケアプラン連携の導入作業: ${doneCount(cp && cp.steps, cpStepKeys)}/${cpStepKeys.length} 完了`);
  return {
    subject: `当日の記録を確定（${visitDate}）`,
    body: lines.join("\n"),
  };
}

// 同じ訪問日の確定が既に対応記録にあるか（あればその行を返す）。
// activities はこの案件の分（caseId で絞って取得したもの）を渡す。refId は見ない
// （案件を統合すると activities の caseId だけ付け替わり、refId は統合元のまま残るため・レビュー 低-2）
export function findOnsiteConfirmation(activities, visitDate) {
  if (!Array.isArray(activities) || !visitDate) return null;
  return activities.find((a) => a && a.refType === "onsite" && a.refDate === visitDate) || null;
}

// 当日の確定を対応記録に書くときの項目（type は既存の「訪問・対面」）
export function onsiteConfirmActivity({ caseId, visitDate, summary, userId = "", userName = "" }) {
  return {
    caseId,
    type: "visit",
    userId,
    userName,
    subject: summary.subject,
    body: summary.body,
    attachmentUrls: [],
    refType: "onsite",
    refId: caseId,
    refDate: visitDate,
  };
}

// 伴走支援の記録の見出しカードの id（対応記録のリンクからスクロールする先）
export const sessionAnchorId = (sessionId) => `session-${sessionId}`;
export const ONSITE_ANCHOR_ID = "tab-onsite";
export const COPY_ANCHOR_ID = "sc-copy-card";

// 対応記録の行から開く先。ref が無い・知らない種類なら null（リンクを出さない）
export function activityRefLink(a) {
  if (!a || typeof a.refId !== "string" || !a.refId) return null;
  if (a.refType === "session") return { label: "伴走支援の記録を開く", tab: "onsite", anchorId: sessionAnchorId(a.refId), fallbackId: ONSITE_ANCHOR_ID };
  if (a.refType === "onsite") return { label: "当日の記録を開く", tab: "onsite", anchorId: ONSITE_ANCHOR_ID, fallbackId: ONSITE_ANCHOR_ID };
  // 当日の記録を他の案件へ写した／他の案件から写した行（提案2・onsite-copy.js の COPY_REF_TYPE）。
  // 「確定」の行ではない（findOnsiteConfirmation は refType "onsite" だけを見る）
  if (a.refType === "onsiteCopy") return { label: "当日の記録を開く", tab: "onsite", anchorId: COPY_ANCHOR_ID, fallbackId: ONSITE_ANCHOR_ID };
  return null;
}

// 旧タブ名 → いまのタブ名（「伴走支援」タブは当日タブの末尾へ移した）
export const TAB_ALIAS = { sessions: "onsite" };
export const resolveTab = (name) => TAB_ALIAS[name] || name;
