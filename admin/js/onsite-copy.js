// 当日の記録を「同じ事業所の他の案件にも写す」（2026-11-10・設計書 提案2 案B＝複写方式）。
// DOM も Firestore も触らない純関数だけを置く（scripts/test-onsite-copy.mjs で実行して確かめる）。
//
// しくみ:
//   写し元 supportChecklists/{元の案件ID}.onsite のうち「写す項目」を、写し先 supportChecklists/{先の案件ID}.onsite に書く。
//   写し先には copiedFrom（写し元の案件ID・案件番号・写した日時・写した人・写した内容の指紋）を、
//   写し元には copiedTo.{先の案件ID}（案件番号・写した日時・写した人）を残す。
//   読む側（当日タブ・育成の判定・報告）はこれまでどおり supportChecklists/{案件ID} を読むだけ（変更なし）。
//
// 写すもの: onsite（当日）の節の中身＝当日工程のチェックとメモ（steps.<key>.done / .memo）・当日の所感（notes）・訪問日（visitDate）
// 写さないもの:
//   - onsite 以外の節（COPY_SECTIONS に無いもの）: cp（ケアプラン連携。導入済み欄 cp.installStatus に連動するので案件ごとの値を尊重）、
//     pre（事前確認）、after（アフター）、performance（実施の記録・実施日）、copiedFrom / copiedTo
//   - 別のコレクション: 伴走支援の記録（sessions）、対応記録（activities。「当日の記録を確定」の行を含む）、トレーニング評価
//   - Storage の参照を含む値（写真・ファイル。url / path / gs:// / firebasestorage を持つもの）
//   - COPY_EXCLUDE_KEYS に書いた項目

// 写す節。ここに無い節は一切写さない
export const COPY_SECTIONS = ["onsite"];

// 写さない項目（supportChecklists の文書の中のパス。"onsite.steps.userNotice" のように書くと、その工程だけ写さない）。
// ⚠ 現場に「事業種別ごとに中身が違う工程があるか」を確認中。回答が来たら、その工程のパスをここに足すだけでよい
//   （足した項目は写し先の値がそのまま残り、上書きの確認の件数にも数えない）。
// 訪問場所・時刻は「写すもの」（工程の状態・メモと訪問日）に入っていないので写さない（2026-11-10 の指示どおり）。
export const COPY_EXCLUDE_KEYS = [
  "onsite.visitPlace",
  "onsite.visitTimeFrom",
  "onsite.visitTimeTo",
];

// 対応記録の行の種類（提案5 の "onsite"＝当日の記録を確定 とは別の値。findOnsiteConfirmation は "onsite" だけを見る）
export const COPY_REF_TYPE = "onsiteCopy";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && typeof v.toMillis !== "function" && Object.getPrototypeOf(v) === Object.prototype;

const excludedPath = (path, exclude) => exclude.some((p) => path === p || path.startsWith(`${p}.`));

// Storage の参照を含むか（写真・ファイル）。配列・入れ子も見る
export function hasStorageRef(v) {
  if (typeof v === "string") return /^gs:\/\//.test(v) || /firebasestorage\.googleapis\.com|\.firebasestorage\.app/.test(v);
  if (Array.isArray(v)) return v.some(hasStorageRef);
  if (v && typeof v === "object") {
    if (typeof v.toMillis === "function") return false;
    if (isStorageObj(v)) return true;
    return Object.values(v).some(hasStorageRef);
  }
  return false;
}
function isStorageObj(v) {
  return !!(v && typeof v === "object" && !Array.isArray(v) && (("url" in v && "path" in v) || "storagePath" in v));
}

// 節の中身を「写す部分」と「写し先で残す部分」に分ける（base は "onsite" など）
function split(obj, base, exclude) {
  const copy = {}, keep = {};
  if (!isPlainObject(obj)) return { copy, keep };
  for (const [k, v] of Object.entries(obj)) {
    const path = `${base}.${k}`;
    // 除外の項目・Storage の参照そのもの（写真の {url, path} など）・参照を含む配列や文字列は写し先の値を残す
    if (excludedPath(path, exclude) || isStorageObj(v) || (!isPlainObject(v) && hasStorageRef(v))) { keep[k] = clone(v); continue; }
    if (isPlainObject(v)) {
      // 入れ子（steps など）は中まで分ける（工程1つに写真が付いていても、ほかの工程は写せるように）
      const r = split(v, path, exclude);
      if (Object.keys(r.copy).length) copy[k] = r.copy;
      if (Object.keys(r.keep).length) keep[k] = r.keep;
      continue;
    }
    copy[k] = clone(v);
  }
  return { copy, keep };
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = clone(x); return o; }
  return v;
}

function deepMerge(a, b) {
  const out = clone(a);
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

// 写す部分だけを取り出す（section は "onsite"）
export function copyablePart(sectionData, section = "onsite", exclude = COPY_EXCLUDE_KEYS) {
  if (!COPY_SECTIONS.includes(section)) return {};
  return split(sectionData, section, exclude).copy;
}

// 値の入っている末端だけを "steps.portalReg.done" → true の形で並べる（false・空文字・null は「入力なし」と同じ扱い）
export function filledLeaves(obj, base = "") {
  const out = {};
  const walk = (x, p) => {
    if (isPlainObject(x)) { for (const [k, v] of Object.entries(x)) walk(v, p ? `${p}.${k}` : k); return; }
    if (x === false || x == null) return;
    if (typeof x === "string" && x.trim() === "") return;
    if (Array.isArray(x) && !x.length) return;
    out[p] = typeof x === "string" ? x.trim() : x;
  };
  walk(obj, base);
  return out;
}

// 写す部分の指紋（キーの順番・false と未入力の違いに左右されない）。写したあと写し先で変えられたかの判定に使う
export function copyFingerprint(sectionData, section = "onsite", exclude = COPY_EXCLUDE_KEYS) {
  const leaves = filledLeaves(copyablePart(sectionData, section, exclude));
  return JSON.stringify(Object.keys(leaves).sort().map((k) => [k, leaves[k]]));
}

// 写し先に書く onsite を組み立てる。写す部分は写し元の値で置き換え、写さない部分は写し先の値を残す。
// visitDate: 写し元の画面に出ている訪問日（保存済みの onsite.visitDate と違う場合はこちらを使う）
export function buildCopiedOnsite(sourceOnsite, targetOnsite, { visitDate = "", exclude = COPY_EXCLUDE_KEYS } = {}) {
  const src = isPlainObject(sourceOnsite) ? sourceOnsite : {};
  const copy = split(src, "onsite", exclude).copy;
  if (visitDate && !excludedPath("onsite.visitDate", exclude)) copy.visitDate = visitDate;
  const keep = split(isPlainObject(targetOnsite) ? targetOnsite : {}, "onsite", exclude).keep;
  const onsite = deepMerge(copy, keep);
  if (!isPlainObject(onsite.steps)) onsite.steps = {};
  return onsite;
}

// 写すものがあるか（写し元に入力が1つも無ければ写さない）
export function hasCopyableContent(sourceOnsite, visitDate = "") {
  if (visitDate) return true;
  return Object.keys(filledLeaves(copyablePart(sourceOnsite))).length > 0;
}

/**
 * 上書きの確認が要るか。
 * targetDoc: 写し先の supportChecklists の中身（無ければ null）／sourceCaseId: 写し元の案件ID／newOnsite: これから書く onsite
 * 確認が要るのは、写し先に「書くと変わる入力」があり、かつ次のどちらか:
 *   (a) 写し元由来でない入力（copiedFrom が無い、または別の案件から写したもの）
 *   (b) 同じ写し元から写したあと、写し先で変更された（指紋が違う）
 * 戻り値: { needsConfirm, count, paths }（count は上書きされる入力の数）
 */
export function overwriteCheck(targetDoc, sourceCaseId, newOnsite) {
  const t = targetDoc || {};
  const cur = filledLeaves(copyablePart(t.onsite));
  const next = filledLeaves(copyablePart(newOnsite));
  const paths = Object.keys(cur).filter((p) => next[p] !== cur[p]).sort();
  const cf = t.copiedFrom;
  const unchangedSinceCopy = !!(cf && cf.caseId === sourceCaseId && typeof cf.fingerprint === "string"
    && cf.fingerprint === copyFingerprint(t.onsite));
  const needsConfirm = paths.length > 0 && !unchangedSinceCopy;
  return { needsConfirm, count: needsConfirm ? paths.length : 0, paths: needsConfirm ? paths : [] };
}

// 写したあと写し先で変更されたか（写し先の画面で「写したあと変更あり」と出す）
export function changedSinceCopy(targetDoc) {
  const cf = targetDoc && targetDoc.copiedFrom;
  if (!cf || typeof cf.fingerprint !== "string") return false;
  return cf.fingerprint !== copyFingerprint(targetDoc.onsite);
}

// 写し先の候補: 同じ officeId の他の案件（自分・統合などで対象外にした案件は出さない）。案件番号の順
export function copyCandidates(currentCase, cases) {
  const officeId = currentCase && currentCase.officeId;
  if (!officeId) return [];
  return (Array.isArray(cases) ? cases : [])
    .filter((c) => c && c._id && c._id !== currentCase._id && c.officeId === officeId && !c.archived)
    .sort((a, b) => (Number(a.caseNumber) || 0) - (Number(b.caseNumber) || 0));
}

// ボタンを出せない理由（出せるなら ""）
export function copyUnavailableReason(currentCase) {
  if (!currentCase) return "案件を読み込んでいます";
  if (!currentCase.officeId) return "事業所が未登録のため写せません";
  return "";
}

// 案件番号の表示（"#12"）
export const caseLabel = (n) => `#${n == null || n === "" ? "—" : n}`;

// 日時の表示（日本時間・"2026-11-10 14:03"）
export function formatJst(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms + 9 * 3600e3);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 写し先に残す印
export function copiedFromRecord({ sourceCaseId, sourceCaseNumber, nowMs, actorName = "", actorId = "", newOnsite }) {
  return {
    caseId: sourceCaseId,
    caseNumber: sourceCaseNumber ?? null,
    copiedAtMs: nowMs,
    copiedBy: actorName,
    copiedById: actorId,
    fingerprint: copyFingerprint(newOnsite),
  };
}

// 写し元に残す印（copiedTo.{先の案件ID} に入れる）
export function copiedToRecord({ targetCaseNumber, nowMs, actorName = "", actorId = "" }) {
  return { caseNumber: targetCaseNumber ?? null, copiedAtMs: nowMs, copiedBy: actorName, copiedById: actorId };
}

// 写し先の当日タブに出す一言
export function copiedFromText(targetDoc) {
  const cf = targetDoc && targetDoc.copiedFrom;
  if (!cf || !cf.caseId) return "";
  const when = formatJst(cf.copiedAtMs);
  const who = cf.copiedBy ? `・${cf.copiedBy}` : "";
  const changed = changedSinceCopy(targetDoc) ? "。写したあと、この案件で変更があります" : "";
  return `${caseLabel(cf.caseNumber)} から写した記録（${when}${who}）${changed}`;
}

// 写し元の当日タブに出す一言
export function copiedToText(sourceDoc) {
  const ct = sourceDoc && sourceDoc.copiedTo;
  if (!isPlainObject(ct)) return "";
  const list = Object.values(ct).filter((x) => x && typeof x === "object")
    .sort((a, b) => (Number(a.caseNumber) || 0) - (Number(b.caseNumber) || 0));
  if (!list.length) return "";
  return `${list.map((x) => `${caseLabel(x.caseNumber)}（${formatJst(x.copiedAtMs)}）`).join("・")}へ写した`;
}

// 上書きの確認の文面。checks: [{ caseNumber, count }]（count>0 のものだけ）
export function overwriteConfirmText(checks) {
  const lines = checks.filter((c) => c.count > 0).map((c) => `${caseLabel(c.caseNumber)}: ${c.count}件`);
  if (!lines.length) return "";
  return `写し先の入力が上書きされます。\n${lines.join("\n")}\n\nよろしいですか？`;
}

// 対応記録の1行（写し元・写し先それぞれ）。利用者氏名・被保険者証番号は入れない（案件番号と日付だけ）
const NOT_COPIED = "ケアプラン連携・実施の記録・伴走支援の記録・写真は写していません。";
export function copyActivities({ sourceCaseId, sourceCaseNumber, targets, visitDate, userId = "", userName = "" }) {
  const nums = targets.map((t) => caseLabel(t.caseNumber)).join("・");
  const vd = visitDate ? `（訪問日 ${visitDate}）` : "";
  const base = { type: "memo", userId, userName, attachmentUrls: [], refType: COPY_REF_TYPE, refDate: visitDate || "" };
  return {
    source: {
      ...base, caseId: sourceCaseId, refId: sourceCaseId,
      subject: `当日の記録を ${nums} へ写した${vd}`,
      body: `写した項目: 当日工程のチェックとメモ・当日の所感・訪問日。${NOT_COPIED}`,
    },
    target: (t) => ({
      ...base, caseId: t.caseId, refId: t.caseId, copyFromCaseId: sourceCaseId,
      subject: `${caseLabel(sourceCaseNumber)} から当日の記録を写した${vd}`,
      body: `写した項目: 当日工程のチェックとメモ・当日の所感・訪問日。${NOT_COPIED}`,
    }),
  };
}

// 複数の写し先の結果のまとめ（途中で失敗しても、どこまで写せたかを出す）
// results: [{ caseNumber, ok, error }]
export function copyResultText(results, sourceLogError = "") {
  const ok = results.filter((r) => r.ok);
  const ng = results.filter((r) => !r.ok);
  const parts = [];
  if (ok.length) parts.push(`写しました: ${ok.map((r) => caseLabel(r.caseNumber)).join("・")}`);
  if (ng.length) parts.push(`写せませんでした: ${ng.map((r) => `${caseLabel(r.caseNumber)}（${r.error || "失敗"}）`).join("・")}`);
  if (sourceLogError) parts.push(`この案件の対応記録への記録に失敗しました（${sourceLogError}）`);
  return { text: parts.join("。"), allOk: !ng.length && !sourceLogError && ok.length > 0 };
}
