// 伴走支援チェックリスト（事前 / 当日 / アフター）を案件ごとにアプリ内で記録する。
// 出典: 介護情報基盤伴走支援/02_伴走支援/ ＋ ケアプランデータ連携支援/02_伴走支援/。
// 保存先: Firestore `supportChecklists/{caseId}`（documentChecklists と同じ1案件1ドキュメント）。
// 構成（2026-06-07 改訂）: 当日に介護情報基盤とケアプラン連携を両方行う運用に合わせ、
//   事前確認 / 当日 / アフター の各タブに「介護情報基盤」「ケアプラン連携」を併記（独立CPタブは廃止）。
//   証憑写真（ケアプラン連携のライセンス／電子証明書の有効期間）を当日タブで保存（Firebase Storage）。
// 設計方針:
//   - スケルトンは初回1回だけ描画し、値は populate() で流し込む（フォーカス中の要素は上書きしない＝カーソル飛び防止）
//   - 変更は change イベントで該当セクションを merge 保存
//   - 個人情報（パスワード・暗証番号・口座番号）はここに記録しない方針（Pマーク準拠）
//   - 「実施の記録」（誰が・いつ・どの区分で実施したか）は当日タブの先頭。`performance` フィールドに
//     保存ボタンで一括保存（トレーナー必須などの検証があるため、他の項目のような change 即保存にはしない）
//   - 区分＝トレーニングのときは、その下に「トレーニング評価」（8観点・OJT合否・総合判定）を出し
//     supportEvaluations に保存。独り立ち可ならトレーナーがバッジを付与（supportBadges）。
//     判定・検証の純粋関数は support-evaluation.js（scripts/test-support-evaluation.mjs）

import { doc, setDoc, updateDoc, addDoc, getDoc, getDocs, collection, query, where, onSnapshot, serverTimestamp, getProdFirestore, runTransaction }
  from "/js/fs.js";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from "/js/st.js";

import { MODES, buildPerformance, summaryLine, fillPeopleSelect } from "./support-performance.js";
import { ITEMS, GRADES, JUDGEMENTS, judgementLabel, suggestJudgement, buildEvaluation, evaluationId, evaluationEligible,
  buildGrant, badgeHolders, soloWarning, isTrainer } from "./support-evaluation.js";
import { evaluationLine } from "./learning-core.js";
import { QUIZZES } from "./learning-quiz.js";
import { AUTO_SAVE_NOTE, manualSaveNote, saveModeNoteHtml, unsavedSpanHtml, trackUnsaved, shouldRefillForm } from "./save-mode.js";
import { CP_INSTALL_OPTS, CP_SKIP_PRE_TEXT, CP_SKIP_ONSITE_TEXT, cpInstalled, applyCpInstalled } from "./support-cp-install.js";
import { effectiveVisitDate, perfDateDefault, confirmVisitDate, onsiteConfirmSummary, findOnsiteConfirmation, onsiteConfirmActivity } from "./onsite-record.js";
// 当日の記録を「同じ事業所の他の案件にも写す」（2026-11-10・設計書 提案2 案B）。判定・組み立ては onsite-copy.js（scripts/test-onsite-copy.mjs）
import { copyCandidates, copyUnavailableReason, buildCopiedOnsite, hasCopyableContent, overwriteCheck, overwriteConfirmText,
  copyFingerprint, copiedFromRecord, copiedToRecord, copiedFromText, copiedToText, copyActivities, copyResultText, caseLabel, formatJst } from "./onsite-copy.js";
import { STATUS_LABELS } from "./constants.js";
import { serviceTypeLabel } from "./service-types.js";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const STATUS_OPTS = [
  { v: "", t: "未確認" },
  { v: "ok", t: "○ OK" },
  { v: "warn", t: "△ 要対応" },
  { v: "ng", t: "× NG" },
];

// 事前確認（A-3）— 3段階＋メモ
const PRE_ITEMS = [
  { key: "kjId", label: "電子請求受付システムID（KJ＋12桁）が手元にあるか" },
  { key: "password", label: "パスワードを本パスワードへ変更済か（仮のままでない）" },
  { key: "securityMail", label: "セキュリティ用メールアドレス登録済か（OTP受信に必須）" },
  { key: "cert", label: "電子証明書（取得済 / 要取得・取得は1か月程度かかる場合あり）" },
  { key: "network", label: "ネット環境（Wi-Fi/有線・電波の弱い居室を避ける）" },
  { key: "pc", label: "設定用PC（Windows 11＋Microsoft Edge）" },
  { key: "cardReader", label: "カードリーダー（マイナ資格確認アプリ対応・台数）" },
  { key: "subsidyIntent", label: "助成金申請の意向・希望台数" },
];

// 当日工程（介護情報基盤）— チェック＋メモ
const ONSITE_STEPS = [
  { key: "portalReg", label: "初回利用登録（ポータル）" },
  { key: "certInstall", label: "電子証明書 インストール" },
  { key: "mynaApp", label: "マイナ資格確認アプリ 設定" },
  { key: "crConnect", label: "カードリーダー 接続確認" },
  { key: "webSetup", label: "介護WEBサービス 設定（事業所/管理者/一般ユーザ）" },
  { key: "operationTest", label: "動作確認（資格確認テスト）" },
  { key: "userNotice", label: "利用者周知（ポスター/リーフレット案内）" },
];

// 上書きの確認に出す工程名（「初回利用登録（ポータル）のメモ」など）
const STEP_LABELS = Object.fromEntries(ONSITE_STEPS.map((i) => [i.key, i.label]));

// ケアプラン連携 導入作業
const CP_STEPS = [
  { key: "clientInstall", label: "クライアント（製品）DL・インストール" },
  { key: "certInstall", label: "電子証明書 確認 / インストール" },
  { key: "licenseApply", label: "利用申請（規約同意・正常完了表示）" },
  { key: "csvExport", label: "介護ソフトでCSV出力 確認" },
  { key: "csvImport", label: "介護ソフトへCSV取込 確認" },
  { key: "testSend", label: "テスト送受信（可能なら）" },
];

// 個人情報取扱い確認（§6・Pマーク）— 2段階
const PRIVACY_ITEMS = [
  { key: "purpose", label: "取得した情報は支援目的のみに使用（Pマーク規程準拠）" },
  { key: "noSecrets", label: "パスワード・暗証番号・口座番号を記録・保持していない" },
  { key: "noExport", label: "本記録を社外・本来の保管場所外へ持ち出していない" },
];

function statusSelect(id, sec, path) {
  const opts = STATUS_OPTS.map((o) => `<option value="${o.v}">${o.t}</option>`).join("");
  return `<select class="form-control" id="${id}" data-sec="${sec}" data-path="${path}" style="max-width:150px">${opts}</select>`;
}

function row3state(sec, item) {
  const id = `sc-${sec}-${item.key}`;
  return `
    <div class="form-group">
      <label class="form-label" for="${id}">${item.label}</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${statusSelect(id, sec, `${item.key}.status`)}
        <input class="form-control" type="text" data-sec="${sec}" data-path="${item.key}.memo" placeholder="メモ" aria-label="${item.label} のメモ" style="flex:1;min-width:160px">
      </div>
    </div>`;
}

// steps.<key>.done / steps.<key>.memo
function rowStep(sec, item) {
  const id = `sc-${sec}-${item.key}`;
  return `
    <div class="form-group">
      <label class="checklist-check" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="${id}" data-sec="${sec}" data-path="steps.${item.key}.done">
        <span>${item.label}</span>
      </label>
      <input class="form-control" type="text" data-sec="${sec}" data-path="steps.${item.key}.memo" placeholder="メモ（つまずき等）" aria-label="${item.label} のメモ" style="margin-top:6px">
    </div>`;
}

// 「保存しました HH:MM」を出す場所。自動保存のカードごとに1つ置き、変更した欄があるカードの分に出す（markSaved）。
// 同じ sec（cp など）が複数のタブ・カードにまたがるので、2つ目以降は part で id を分ける
function savedSpan(sec, part) {
  return `<span class="sc-saved" id="sc-saved-${sec}${part ? `-${part}` : ""}" aria-live="polite" style="font-size:12px;color:var(--color-ink-muted)"></span>`;
}

// カード見出しの左側（タイトル＋保存のしかたの説明＋未保存の表示）
function cardTitle(title, note, extra = "") {
  return `<div><span style="font-weight:600;font-size:14px">${title}</span>${saveModeNoteHtml(note)}${extra}</div>`;
}

function selectGroup(id, sec, path, label, opts) {
  const o = opts.map((x) => `<option value="${x.v}">${x.t}</option>`).join("");
  return `
    <div class="form-group">
      <label class="form-label" for="${id}">${label}</label>
      <select class="form-control" id="${id}" data-sec="${sec}" data-path="${path}" style="max-width:340px">${o}</select>
    </div>`;
}

// ケアプラン連携が「導入済み」のときに出す省略の表示（support-cp-install.js の applyCpInstalled が切り替える）
function cpSkipNote(text) {
  return `<p data-cp-skip-note style="display:none;font-size:13px;margin:0 0 12px;padding:8px 12px;border-radius:6px;background:var(--color-bg-subtle, #faf7f2)">${text}</p>`;
}

function checkOnly(sec, id, path, label) {
  return `
    <div class="form-group">
      <label class="checklist-check" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="${id}" data-sec="${sec}" data-path="${path}">
        <span>${label}</span>
      </label>
    </div>`;
}

// ===== 事前確認タブ =====
function cardCpPre() {
  return `
    <div class="card">
      <div class="card-header">
        ${cardTitle("ケアプラン連携 — 事前確認", AUTO_SAVE_NOTE)}
        ${savedSpan("cp")}
      </div>
      <div class="card-body">
        ${selectGroup("sc-cp-installStatus", "cp", "installStatus", "ケアプランデータ連携システムの導入状況", CP_INSTALL_OPTS)}
        ${cpSkipNote(CP_SKIP_PRE_TEXT)}
        <div data-cp-skip>
        <p style="font-size:12px;color:var(--color-ink-muted);margin:0 0 12px">介護情報基盤を入れた事業所はKJ-ID・電子証明書が整っていることが多く、ケアプランデータ連携の導入が容易（同じ電子請求受付システムを使う）。</p>
        ${row3state("cp", { key: "software", label: "介護ソフトが標準仕様に対応しているか" })}
        ${selectGroup("sc-cp-ebilling", "cp", "eBilling", "介護電子請求の有無（電子証明書の種類判定）", [
          { v: "", t: "未確認" },
          { v: "yes", t: "あり（介護保険証明書を流用可・追加費用なし）" },
          { v: "no", t: "なし（介護DX証明書を無料取得）" },
        ])}
        ${selectGroup("sc-cp-cert", "cp", "certType", "電子証明書の種類", [
          { v: "", t: "未確認" },
          { v: "kaigo", t: "介護保険証明書（流用）" },
          { v: "careplan", t: "介護DX証明書（無料・旧称：請求委任事業所用ケアプラン証明書）" },
          { v: "none", t: "未取得" },
        ])}
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-cp-partner">主な連携相手（取引先）の本システム導入状況</label>
          <input class="form-control" type="text" id="sc-cp-partner" data-sec="cp" data-path="partnerStatus">
        </div>
      </div>
    </div>`;
}

function renderPre() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        ${cardTitle("介護情報基盤 — 事前確認（訪問前）", AUTO_SAVE_NOTE)}
        ${savedSpan("pre")}
      </div>
      <div class="card-body">
        <p style="font-size:12px;color:var(--color-ink-muted);margin:0 0 12px">○＝OK／△＝要対応／×＝NG。△・×は訪問前に再発行・証明書取得などの着手を案内する。</p>
        ${PRE_ITEMS.map((i) => row3state("pre", i)).join("")}
        <div class="form-group">
          <label class="form-label" for="sc-pre-requestedActions">事前に着手を依頼したこと（再発行・証明書取得など）</label>
          <textarea class="form-control" id="sc-pre-requestedActions" rows="2" data-sec="pre" data-path="requestedActions"></textarea>
        </div>
      </div>
    </div>
    ${cardCpPre()}`;
}

// ===== 当日タブ =====
function cardVisitInfo() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        ${cardTitle("当日 — 訪問情報", AUTO_SAVE_NOTE)}
        ${savedSpan("onsite")}
      </div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="sc-onsite-visitDate">訪問日</label>
            <input class="form-control" type="date" id="sc-onsite-visitDate" data-sec="onsite" data-path="visitDate">
          </div>
          <div class="form-group">
            <label class="form-label" for="sc-onsite-place">場所</label>
            <select class="form-control" id="sc-onsite-place" data-sec="onsite" data-path="visitPlace">
              <option value="">—</option>
              <option value="office">事業所</option>
              <option value="online">オンライン</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="sc-onsite-from">開始</label>
            <input class="form-control" type="time" id="sc-onsite-from" data-sec="onsite" data-path="visitTimeFrom">
          </div>
          <div class="form-group">
            <label class="form-label" for="sc-onsite-to">終了</label>
            <input class="form-control" type="time" id="sc-onsite-to" data-sec="onsite" data-path="visitTimeTo">
          </div>
        </div>
      </div>
    </div>`;
}

function cardOnsiteSteps() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        ${cardTitle("介護情報基盤 — 当日工程", AUTO_SAVE_NOTE)}
        ${savedSpan("onsite", "steps")}
      </div>
      <div class="card-body">
        ${ONSITE_STEPS.map((i) => rowStep("onsite", i)).join("")}
        <div class="form-group">
          <label class="form-label" for="sc-onsite-notes">当日の所感・特記</label>
          <textarea class="form-control" id="sc-onsite-notes" rows="3" data-sec="onsite" data-path="notes"></textarea>
        </div>
      </div>
    </div>`;
}

function cardCpSteps() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        ${cardTitle("ケアプラン連携 — 導入作業", AUTO_SAVE_NOTE)}
        ${savedSpan("cp", "onsite")}
      </div>
      <div class="card-body">
        ${cpSkipNote(CP_SKIP_ONSITE_TEXT)}
        <div data-cp-skip>
        ${CP_STEPS.map((i) => rowStep("cp", i)).join("")}
        </div>
      </div>
    </div>`;
}

function cardCpEvidence() {
  return `
    <div class="card">
      <div class="card-header">
        ${cardTitle("ケアプラン連携 — 証憑写真（ライセンス／電子証明書の有効期間）", AUTO_SAVE_NOTE)}
      </div>
      <div class="card-body">
        ${cpSkipNote(CP_SKIP_ONSITE_TEXT)}
        <div data-cp-skip>
        <p style="font-size:12px;color:var(--color-ink-muted);margin:0 0 10px">利用申請完了画面・ライセンス情報や、電子証明書の有効期間がわかる画面の写真を保存できます。個人情報（パスワード等）が写り込まないよう注意。</p>
        <input type="file" id="sc-cp-photo-input" accept="image/*" multiple style="display:none">
        <button type="button" class="btn btn-secondary" id="sc-cp-photo-btn" style="min-height:44px">
          <i class="ti ti-camera" aria-hidden="true"></i> 写真を追加
        </button>
        <span id="sc-cp-photo-progress" aria-live="polite" style="display:none;font-size:13px;color:var(--color-ink-muted);margin-left:10px"></span>
        <div id="sc-cp-photos" style="margin-top:10px"></div>
        </div>
      </div>
    </div>`;
}

// ===== 実施の記録（誰が・いつ・どの区分で） =====
// CRMの営業担当＝伴走支援者。トレーナー立会いの OJT を経て「伴走支援者バッジ」を付与する運用。
function cardPerformance() {
  const modes = MODES.map((m) => `
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
          <input type="radio" name="sc-perf-mode" value="${m.v}"> <span>${m.t}</span>
        </label>`).join("");
  return `
    <div class="card" id="sc-perf-card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        ${cardTitle("実施の記録（誰が実施したか）", manualSaveNote("実施の記録を保存"), unsavedSpanHtml("sc-perf-unsaved"))}
        <span id="sc-perf-saved" aria-live="polite" style="font-size:12px;color:var(--color-ink-muted)"></span>
      </div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="sc-perf-date">実施日</label>
            <input class="form-control" type="date" id="sc-perf-date">
          </div>
          <div class="form-group">
            <label class="form-label" for="sc-perf-performer">実施者（既定は担当営業）</label>
            <select class="form-control" id="sc-perf-performer"></select>
          </div>
        </div>
        <div class="form-group">
          <span class="form-label">区分</span>
          <div style="display:flex;gap:16px;flex-wrap:wrap">${modes}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-perf-trainer">トレーナー（区分が「トレーニング」のとき必須。見学の案内役は任意）</label>
          <select class="form-control" id="sc-perf-trainer" style="max-width:340px"></select>
        </div>
        <div class="form-group" id="sc-perf-companions-wrap">
          <label class="form-label" for="sc-perf-companions">同行者（受講者・見学者の名前。複数はカンマ区切り）</label>
          <input class="form-control" type="text" id="sc-perf-companions" placeholder="例: 佐藤, 田中">
          <p style="font-size:12px;color:var(--color-ink-muted);margin:4px 0 0">スタッフ・研修生・見学者の名前のみ。利用者（被保険者）や事業所の個人情報は書かないでください。</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-perf-note">メモ</label>
          <input class="form-control" type="text" id="sc-perf-note" maxlength="200">
        </div>
        <button type="button" class="btn btn-primary" id="sc-perf-save" style="min-height:44px">実施の記録を保存</button>
        <span id="sc-perf-error" role="alert" style="display:none;font-size:13px;color:var(--color-danger);margin-left:10px"></span>
      </div>
    </div>`;
}

// ===== トレーニング評価（区分＝トレーニングの実施の記録に対して） =====
// 評価シート（組織体制_素案/トレーニング評価シート_案.md）の8観点。◎ひとりでできる／○助言があればできる／△要練習／×未実施
function cardEvaluation() {
  const gradeOpts = `<option value="">—</option>` + GRADES.map((g) => `<option value="${g}">${g}</option>`).join("");
  const rows = ITEMS.map((i) => `
        <div class="form-group" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <label class="form-label" for="sc-eval-${i.n}" style="flex:1;margin:0">${i.n} ${i.label}${i.n === 4 ? "（◎が必要）" : ""}</label>
          <select class="form-control" id="sc-eval-${i.n}" data-eval-item="${i.n}" style="max-width:90px">${gradeOpts}</select>
        </div>`).join("");
  const judge = `<option value="">選んでください</option>` + JUDGEMENTS.map((j) => `<option value="${j.v}">${j.t}</option>`).join("");
  return `
    <div class="card" id="sc-eval-card" style="margin-bottom:var(--space-4);display:none">
      <div class="card-header">
        ${cardTitle("トレーニング評価（トレーナーが記入）", manualSaveNote("評価を保存"), unsavedSpanHtml("sc-eval-unsaved"))}
        <span id="sc-eval-saved" aria-live="polite" style="font-size:12px;color:var(--color-ink-muted)"></span>
      </div>
      <div class="card-body">
        <p id="sc-eval-who" style="font-size:12px;color:var(--color-ink-muted);margin:0 0 12px"></p>
        <p id="sc-eval-learning" role="status" style="display:none;font-size:13px;margin:0 0 12px;padding:8px 12px;border-radius:6px"></p>
        <p style="font-size:12px;color:var(--color-ink-muted);margin:0 0 12px">◎ひとりでできる ／ ○助言があればできる ／ △要練習 ／ ×未実施。独り立ち可の基準は「④が◎、ほかが全て○以上、OJTで1回でも合格（OK）」。</p>
        ${rows}
        <div class="form-group">
          <span class="form-label">このOJTの合否</span>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="radio" name="sc-eval-ojt" value="ok"> <span>合格（OK）</span></label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="radio" name="sc-eval-ojt" value="ng"> <span>まだ</span></label>
          </div>
        </div>
        <p id="sc-eval-suggest" aria-live="polite" style="font-size:13px;font-weight:600;margin:0 0 8px"></p>
        <div class="form-group">
          <label class="form-label" for="sc-eval-judgement">総合判定（トレーナーが最終決定。上の提案と違ってもよい）</label>
          <select class="form-control" id="sc-eval-judgement" style="max-width:340px">${judge}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-eval-note">所見・次回の課題</label>
          <textarea class="form-control" id="sc-eval-note" rows="2" maxlength="500"></textarea>
          <p style="font-size:12px;color:var(--color-ink-muted);margin:4px 0 0">利用者（被保険者）の個人情報は書かないでください。</p>
        </div>
        <button type="button" class="btn btn-primary" id="sc-eval-save" style="min-height:44px">評価を保存</button>
        <span id="sc-eval-error" role="alert" style="display:none;font-size:13px;color:var(--color-danger);margin-left:10px"></span>
        <div id="sc-eval-badge" style="margin-top:12px;font-size:13px"></div>
      </div>
    </div>`;
}

// ===== 当日の記録を確定（設計書 提案5）=====
// チェックは変更のたびに自動保存されるので、そのたびに対応記録へ入れると行があふれる。
// このボタンを押したときだけ、訪問日と完了した工程の数を対応記録に1行残す（同じ訪問日では1回だけ）
function cardOnsiteConfirm() {
  return `
    <div class="card" id="sc-onsite-confirm-card" style="margin-top:var(--space-4)">
      <div class="card-header">
        ${cardTitle("当日の記録を確定", "押すと対応記録に1行残ります（チェックの内容はそのつど自動で保存されています）")}
      </div>
      <div class="card-body">
        <p style="font-size:12px;color:var(--color-ink-muted);margin:0 0 10px">訪問日と、完了した工程の数を対応記録に残します。同じ訪問日では1回だけ残ります。</p>
        <button type="button" class="btn btn-primary" id="sc-onsite-confirm" style="min-height:44px"><i class="ti ti-circle-check" aria-hidden="true"></i> 当日の記録を確定</button>
        <span id="sc-onsite-confirm-status" role="status" aria-live="polite" style="font-size:13px;margin-left:10px;color:var(--color-ink-muted)"></span>
      </div>
    </div>`;
}

// ===== 同じ事業所の他の案件にも写す（設計書 提案2・複写方式）=====
// 1回の訪問で同じ事業所の複数の案件（事業種別ごとの案件）を支援したとき、当日の記録を他の案件へ写す。
// 写すのは当日工程のチェックとメモ・所感・訪問日だけ（写さない項目は onsite-copy.js の COPY_SECTIONS / COPY_EXCLUDE_KEYS）
function cardCopy() {
  return `
    <div class="card" id="sc-copy-card" style="margin-top:var(--space-4)">
      <div class="card-header">
        ${cardTitle("同じ事業所の他の案件にも写す", "写し先を選んで「写す」を押すと、その案件の当日の記録に書き込みます")}
      </div>
      <div class="card-body">
        <p style="font-size:12px;color:var(--color-ink-muted);margin:0 0 10px">写すのは「介護情報基盤の当日工程」のチェックとメモ、当日の所感、訪問日です。ケアプラン連携（導入済み欄・導入作業・証憑写真）、実施の記録、伴走支援の記録は写しません。写したあと片方だけ直すと内容がずれるので、直すときは写し元を直してもう一度写してください。</p>
        <p id="sc-copy-reason" role="status" style="display:none;font-size:13px;margin:0 0 10px;color:var(--color-ink-muted)"></p>
        <p id="sc-copy-to" style="display:none;font-size:13px;margin:0 0 10px"></p>
        <button type="button" class="btn btn-secondary" id="sc-copy-open" style="min-height:44px;display:none"><i class="ti ti-copy" aria-hidden="true"></i> 同じ事業所の他の案件にも写す</button>
        <div id="sc-copy-panel" style="display:none;margin-top:10px">
          <fieldset style="border:0;padding:0;margin:0">
            <legend class="form-label" style="margin-bottom:6px">写し先（同じ事業所の他の案件）</legend>
            <div id="sc-copy-list" style="font-size:13px"></div>
          </fieldset>
          <button type="button" class="btn btn-primary" id="sc-copy-run" style="min-height:44px;margin-top:8px"><i class="ti ti-copy" aria-hidden="true"></i> 選んだ案件に写す</button>
          <button type="button" class="btn btn-ghost" id="sc-copy-close" style="min-height:44px;margin-top:8px">閉じる</button>
        </div>
        <p id="sc-copy-status" role="status" aria-live="polite" style="font-size:13px;margin:10px 0 0;color:var(--color-ink-muted)"></p>
      </div>
    </div>`;
}

function renderOnsite() {
  return `<div id="sc-copy-banner" role="status" style="display:none;font-size:13px;margin:0 0 var(--space-3);padding:8px 12px;border-radius:6px;background:var(--color-bg-subtle, #faf7f2)"></div><div id="sc-perf-summary" style="display:none;font-size:13px;font-weight:600;margin:0 0 var(--space-3)"></div><div id="sc-perf-warn" role="status" style="display:none;font-size:13px;color:var(--color-danger);background:var(--color-danger-soft);padding:8px 12px;border-radius:6px;margin:0 0 var(--space-3)"></div>${cardPerformance()}${cardEvaluation()}${cardVisitInfo()}${cardOnsiteSteps()}${cardCpSteps()}${cardCpEvidence()}${cardOnsiteConfirm()}`;
}

// ===== アフタータブ =====
function checkRowWithMonth(sec, id, path, monthPath, label) {
  return `
    <div class="form-group">
      <label class="checklist-check" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="${id}" data-sec="${sec}" data-path="${path}">
        <span>${label}</span>
      </label>
      <input class="form-control" type="text" data-sec="${sec}" data-path="${monthPath}" placeholder="確認月（例: 8月）" aria-label="${label} の確認月" style="margin-top:6px;max-width:200px">
    </div>`;
}

function cardCpAfter() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        ${cardTitle("ケアプラン連携 — ライセンス・運用・アフター", AUTO_SAVE_NOTE)}
        ${savedSpan("cp", "after")}
      </div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="sc-cp-applyDate">利用申請日</label>
            <input class="form-control" type="date" id="sc-cp-applyDate" data-sec="cp" data-path="applyDate">
          </div>
          <div class="form-group">
            <label class="form-label" for="sc-cp-renewal">更新月（毎年・自動更新なし）</label>
            <input class="form-control" type="text" id="sc-cp-renewal" data-sec="cp" data-path="renewalMonth" placeholder="例: 5月" aria-label="更新月">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-cp-device">1事業所1端末の運用担当者・端末</label>
          <input class="form-control" type="text" id="sc-cp-device" data-sec="cp" data-path="opDevice">
        </div>
        ${checkOnly("cp", "sc-cp-first", "afterFirstExchange", "初回の予定送信／実績受信が業務で回っている")}
        ${checkOnly("cp", "sc-cp-linked", "afterPartnerLinked", "主要な取引先との連携が成立している")}
        ${checkOnly("cp", "sc-cp-renew", "afterRenewalNoticed", "毎年の更新申請が必要なことを事業所へ申し送り済")}
      </div>
    </div>`;
}

function renderAfter() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        ${cardTitle("介護情報基盤 — アフターフォロー", AUTO_SAVE_NOTE)}
        ${savedSpan("after")}
      </div>
      <div class="card-body">
        ${checkRowWithMonth("after", "sc-after-review", "reviewConfirmed.done", "reviewConfirmed.month", "審査・決定通知を確認（申請月の翌月）")}
        ${checkRowWithMonth("after", "sc-after-deposit", "depositConfirmed.done", "depositConfirmed.month", "振込を確認（翌々月／期末2-3月申請は4月末まで）")}
        <div class="form-group">
          <label class="checklist-check" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" id="sc-after-migration" data-sec="after" data-path="dataMigrationDone">
            <span>市町村のデータ移行 完了を確認（完了まで実閲覧は不可）</span>
          </label>
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-after-followup">アフターフォロー経過（日付・手段・内容）</label>
          <textarea class="form-control" id="sc-after-followup" rows="3" data-sec="after" data-path="followupNotes" placeholder="例) 7/10 電話：現場の一般ユーザが資格確認できているか確認、問題なし"></textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="sc-after-settlement">定着状況（現場が使えているか）</label>
            <input class="form-control" type="text" id="sc-after-settlement" data-sec="after" data-path="settlement">
          </div>
          <div class="form-group">
            <label class="form-label" for="sc-after-satisfaction">満足度（5段階 or 口頭メモ）</label>
            <input class="form-control" type="text" id="sc-after-satisfaction" data-sec="after" data-path="satisfaction">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-after-next">次のアクション・申し送り</label>
          <textarea class="form-control" id="sc-after-next" rows="2" data-sec="after" data-path="nextActions"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label" for="sc-after-tax">消費税の仕入控除税額報告（事業完了年度の翌々年度4/30まで）の要否・期限メモ</label>
          <input class="form-control" type="text" id="sc-after-tax" data-sec="after" data-path="taxReportMemo">
        </div>
      </div>
    </div>
    ${cardCpAfter()}
    <div class="card">
      <div class="card-header">
        ${cardTitle("個人情報の取扱い確認（Pマーク準拠）", AUTO_SAVE_NOTE)}
        ${savedSpan("after", "privacy")}
      </div>
      <div class="card-body">
        ${PRIVACY_ITEMS.map((i) => `
          <label class="checklist-check" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:6px 0">
            <input type="checkbox" id="sc-after-${i.key}" data-sec="after" data-path="privacy.${i.key}">
            <span>${i.label}</span>
          </label>`).join("")}
      </div>
    </div>`;
}

// path（"a.b.c"）で nested に値を set / get
function setByPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
function getByPath(obj, path) {
  return path.split(".").reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

// opts.getCase()  : 案件（assignedUserId / assignedUserName）／ opts.getUsers() : users の一覧
// opts.getActor() : 記録者の表示名。案件・users は init の後で読み込まれるので、
// 戻り値の refreshPeople() を読み込み後に呼ぶ（実施者・トレーナーの選択肢を作る）。
export function initSupportChecklist(db, caseId, storage, opts = {}) {
  const elPre = document.getElementById("tab-pre");
  // 当日タブはチェックリスト（ここで描く）と、その下の「伴走支援の記録」（case-detail.js）の2段。
  // 伴走支援の記録を消さないよう、チェックリストは #onsiteChecklist にだけ描く（無い古い画面ではタブ全体）
  const elOnsite = document.getElementById("onsiteChecklist") || document.getElementById("tab-onsite");
  const elAfter = document.getElementById("tab-after");
  if (!elPre || !elOnsite || !elAfter) return { refreshPeople() {}, setActivities() {}, refreshVisitDate() {} }; // タブが無ければ何もしない

  // スケルトンを1回だけ描画（ケアプラン連携は各フェーズに統合）
  elPre.innerHTML = renderPre();
  elOnsite.innerHTML = renderOnsite();
  elOnsite.insertAdjacentHTML("beforeend", cardCopy()); // 同じ事業所の他の案件にも写す（当日の記録を確定の下）
  elAfter.innerHTML = renderAfter();

  const ref = doc(db, "supportChecklists", caseId);
  const state = { pre: {}, onsite: { steps: {} }, after: { privacy: {} }, cp: { steps: {}, evidencePhotos: [] } };
  let docData = {}; // 届いた文書の中身そのまま（写した印 copiedFrom / copiedTo の表示に使う）

  function populate() {
    document.querySelectorAll("#tab-pre [data-path], #tab-onsite [data-path], #tab-after [data-path]").forEach((el) => {
      if (el === document.activeElement) return;
      const sec = el.dataset.sec;
      const v = getByPath(state[sec], el.dataset.path);
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v == null ? "" : v;
    });
    fillOnsiteDefaults();
    renderPhotos();
    syncCpInstalled();
    notifyVisitDate();
  }

  // 当日の訪問日（保存済みの onsite.visitDate、無ければ訪問日欄に初期表示している案件の訪問予定日）。
  // 実施の記録の実施日と、伴走支援の記録の実施日（case-detail.js・opts.onVisitDate）の初期値に使う
  const visitDate = () => effectiveVisitDate(state.onsite, opts.getCase ? opts.getCase() : null);
  function notifyVisitDate() {
    applyPerfDateDefault();
    refreshConfirmStatus();
    if (opts.onVisitDate) opts.onVisitDate(visitDate());
  }

  // ケアプラン連携が「導入済み」なら、事前確認の一部と当日の工程・証憑を畳む（データは消さない）
  function syncCpInstalled() {
    [elPre, elOnsite].forEach((root) => applyCpInstalled(root, cpInstalled(state.cp)));
  }

  // 当日タブの訪問日・時刻・場所は、保存済みの値が空のときだけ案件の値を初期表示する（二重入力を減らす）。
  // 保存済みの値は上書きしない。ここで表示しただけの値は保存しない（入力欄を触ったときに初めて保存される）
  function fillOnsiteDefaults() {
    const c = opts.getCase ? opts.getCase() : null;
    if (!c) return;
    const defaults = {
      visitDate: c.visitDate || "",
      visitTimeFrom: c.visitTimeFrom || "",
      visitTimeTo: c.visitTimeTo || "",
      visitPlace: c.visitFormat === "online" ? "online" : (c.visitFormat === "onsite" ? "office" : ""),
    };
    document.querySelectorAll("#tab-onsite [data-path]").forEach((el) => {
      if (el === document.activeElement || !(el.dataset.path in defaults)) return;
      if (getByPath(state.onsite, el.dataset.path)) return; // 保存済み
      el.value = defaults[el.dataset.path];
    });
  }

  function renderPhotos() {
    const el = document.getElementById("sc-cp-photos");
    if (!el) return;
    const photos = Array.isArray(state.cp.evidencePhotos) ? state.cp.evidencePhotos : [];
    if (!photos.length) {
      el.innerHTML = `<span style="font-size:12px;color:var(--color-ink-muted)">写真はまだありません</span>`;
      return;
    }
    el.innerHTML = photos.map((p, i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--color-line)">
        <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(p.url)}" alt="証憑写真${i + 1}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--color-line)">
        </a>
        <span style="flex:1;font-size:12px;color:var(--color-ink-muted);word-break:break-all">${escapeHtml(p.name || "")}</span>
        <button type="button" class="sc-photo-del btn btn-ghost" data-idx="${i}" aria-label="この写真を削除" style="min-width:44px;min-height:44px">
          <i class="ti ti-trash" aria-hidden="true"></i>
        </button>
      </div>`).join("");
  }

  // ----- 実施の記録 -----
  let perf = null; // 保存済みの performance
  let perfUnsaved = null; // 実施の記録の未保存の見張り（下で作る。populate が先に呼ばれても落ちないよう let）
  const $ = (id) => document.getElementById(id);

  function renderPerfSummary() {
    const el = $("sc-perf-summary");
    if (!el) return;
    const line = summaryLine(perf);
    el.textContent = line;
    el.style.display = line ? "block" : "none";
  }

  function syncPerfMode() {
    const mode = (document.querySelector('input[name="sc-perf-mode"]:checked') || {}).value || "";
    const wrap = $("sc-perf-companions-wrap");
    if (wrap) wrap.style.display = mode === "solo" ? "none" : "";
  }

  // 実施者・トレーナーの選択肢を作る。実施者の既定＝担当営業。保存済みの記録があればそれを優先。
  // keepCurrent=true（未保存の入力がある）ときは、いま選んでいる値を保ったまま選択肢だけ作り直す
  // （職員一覧が届く前に入力を始めても、選択肢が空のまま残らないように）
  function fillPerfOptions(keepCurrent) {
    const c = (opts.getCase ? opts.getCase() : null) || {};
    const list = (opts.getUsers ? opts.getUsers() : []) || [];
    fillPeopleSelect($("sc-perf-performer"), list, (perf && perf.performerId) || c.assignedUserId || "", false, keepCurrent);
    fillPeopleSelect($("sc-perf-trainer"), list, (perf && perf.trainerId) || "", true, keepCurrent);
  }

  function fillPerfForm() {
    fillPerfOptions(false);
    $("sc-perf-date").value = (perf && perf.date) || "";
    $("sc-perf-companions").value = (perf && perf.companions) || "";
    $("sc-perf-note").value = (perf && perf.note) || "";
    const radio = document.querySelector(`input[name="sc-perf-mode"][value="${(perf && perf.mode) || ""}"]`);
    if (radio) radio.checked = true;
    syncPerfMode();
    applyPerfDateDefault();
  }

  // 実施日が空なら当日の訪問日を初期値に入れる。保存済みの実施日（perf.date）は書き換えない
  // （評価IDが caseId__実施日__実施者 のため）。値を入れるだけでは「未保存」にしない（input/change を起こさない）
  // 訪問日を直したら、自動で入れた実施日（perfAutoDate と同じ値のまま）は新しい訪問日へ置き換える。人が入れた値は変えない
  let perfAutoDate = "";
  function applyPerfDateDefault() {
    const el = $("sc-perf-date");
    if (!el || el === document.activeElement) return;
    const v = perfDateDefault(perf, el.value, visitDate(), { dirty: perfUnsaved ? perfUnsaved.isDirty() : false, lastAuto: perfAutoDate });
    if (v) { el.value = v; perfAutoDate = v; }
  }

  async function savePerformance() {
    const errEl = $("sc-perf-error");
    const checked = document.querySelector('input[name="sc-perf-mode"]:checked');
    const r = buildPerformance({
      date: $("sc-perf-date").value,
      performerId: $("sc-perf-performer").value,
      mode: checked ? checked.value : "",
      trainerId: $("sc-perf-trainer").value,
      companions: $("sc-perf-companions").value,
      note: $("sc-perf-note").value,
    }, (opts.getUsers ? opts.getUsers() : []) || [], opts.getActor ? opts.getActor() : "", Date.now());
    if (r.error) {
      errEl.textContent = r.error;
      errEl.style.display = "inline";
      return; // 保存しない
    }
    errEl.style.display = "none";
    const sv = $("sc-perf-saved");
    try {
      // 既存の pre/onsite/cp/after を壊さないよう merge で書く
      await setDoc(ref, { performance: r.performance, updatedAt: serverTimestamp() }, { merge: true });
      perf = r.performance;
      perfUnsaved.clean();
      renderPerfSummary();
      renderPerfWarn();
      await loadPriorOk();
      renderEval();
      if (sv) sv.textContent = `保存しました ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (e) {
      if (sv) sv.textContent = "保存に失敗しました（時間をおいて再試行）";
      console.error("[supportChecklist] performance save failed", e);
    }
  }

  elOnsite.addEventListener("change", (e) => {
    if (e.target && e.target.name === "sc-perf-mode") syncPerfMode();
  });
  // 実施の記録・トレーニング評価は保存ボタン。未保存の間は表示し、ページを離れるときに確認を出す（save-mode.js）
  perfUnsaved = trackUnsaved("supportPerformance", $("sc-perf-card"), "sc-perf-unsaved");
  // トレーナーでない人は評価を保存できないので、評価欄に触っても未保存にしない（消せない表示と離れるときの確認を出さない）
  const evalUnsaved = trackUnsaved("supportEvaluation", $("sc-eval-card"), "sc-eval-unsaved",
    { active: () => isTrainer(actorId(), users(), rosterIds) });
  const perfSaveBtn = $("sc-perf-save");
  if (perfSaveBtn) perfSaveBtn.addEventListener("click", savePerformance);

  // ----- トレーニング評価・バッジ -----
  let grants = [];      // supportBadges 全件（付与履歴）
  let caseEvals = [];   // この案件の評価（supportEvaluations・caseId 一致）
  let evalsOwn = false; // 最後に届いた評価の通知が自分の書き込みか（hasPendingWrites）
  let rosterIds = null; // appConfig/supportTrainers.ids（任意）。無ければ初期トレーナー4名を名前で照合
  getDoc(doc(db, "appConfig", "supportTrainers")).then((d) => { if (d.exists()) rosterIds = d.data().ids || null; renderEval(); }).catch(() => {});
  const users = () => (opts.getUsers ? opts.getUsers() : []) || [];
  const actorId = () => (opts.getActorId ? opts.getActorId() : "");
  const myEvalId = () => (evaluationEligible(perf) ? evaluationId(caseId, perf.date, perf.performerId) : "");

  function renderPerfWarn() {
    const el = $("sc-perf-warn");
    if (!el) return;
    const w = soloWarning(perf, grants); // 単独でバッジ未付与の人。ブロックはしない
    el.textContent = w;
    el.style.display = w ? "block" : "none";
  }

  function evalScoresFromForm() {
    const scores = {};
    document.querySelectorAll("#sc-eval-card [data-eval-item]").forEach((el) => { if (el.value) scores[el.dataset.evalItem] = el.value; });
    return scores;
  }
  const ojtFromForm = () => ((document.querySelector('input[name="sc-eval-ojt"]:checked') || {}).value || "");

  // この受講者の「他の評価」でOJT合格があるか（1回でも合格があれば可）
  let priorOk = false;
  async function loadPriorOk() {
    if (!evaluationEligible(perf)) { priorOk = false; return; }
    try {
      const snap = await getDocs(query(collection(db, "supportEvaluations"), where("traineeId", "==", perf.performerId)));
      priorOk = snap.docs.some((d) => d.id !== myEvalId() && d.data().ojtResult === "ok");
    } catch (_) { priorOk = false; }
  }

  function updateSuggest() {
    const el = $("sc-eval-suggest");
    if (!el) return;
    const sg = suggestJudgement(evalScoresFromForm(), ojtFromForm() === "ok" || priorOk);
    el.textContent = sg === "incomplete" ? "自動判定：8観点がそろうと提案します"
      : `自動判定の提案：${judgementLabel(sg)}${priorOk && ojtFromForm() !== "ok" ? "（過去のOJTで合格あり）" : ""}`;
    return sg;
  }

  function renderBadgeBox() {
    const el = $("sc-eval-badge");
    if (!el) return;
    if (!evaluationEligible(perf)) { el.innerHTML = ""; return; }
    const holder = grants.find((g) => g.userId === perf.performerId);
    const ev = caseEvals.find((e) => e._id === myEvalId());
    if (holder) {
      // 練習生ロールのままなら、ロールの変更を案内する（自動では変えない・2026-10-24 育成コース）
      const u = users().find((x) => x._id === holder.userId);
      const roleNote = u && u.role === "trainee"
        ? `<div style="margin-top:6px;color:var(--color-danger)">${escapeHtml(holder.userName)}さんのロールは「練習生」のままです。ユーザー管理でロールを「スタッフ」に変えてください。</div>` : "";
      el.innerHTML = `<strong>伴走支援者バッジ：付与済み</strong>（${escapeHtml(holder.grantedDate)}／認定：${escapeHtml(holder.grantedByName)}／${holder.basis === "discretion" ? "特別裁量" : "評価シート"}）${roleNote}`;
    } else if (ev && ev.judgement === "independent") {
      el.innerHTML = isTrainer(actorId(), users(), rosterIds)
        ? `<button type="button" class="btn btn-secondary" id="sc-badge-grant" style="min-height:44px"><i class="ti ti-award" aria-hidden="true"></i> ${escapeHtml(ev.traineeName)}さんにバッジを付与する（認定：あなた）</button> <span id="sc-badge-msg" role="alert" style="font-size:13px;color:var(--color-danger)"></span>`
        : `<span style="color:var(--color-ink-muted)">この評価は「独り立ち可」です。バッジの付与はトレーナーが行います。</span>`;
    } else {
      el.innerHTML = `<span style="color:var(--color-ink-muted)">バッジ：未付与（総合判定が「独り立ち可」で評価を保存すると、トレーナーが付与できます）</span>`;
    }
  }

  // 受講者の育成コースの進み具合（本番DB learningProgress・2026-10-24）。警告のみで、評価の保存は止めない
  // （実績のある人・特別裁量の人を締め出さないため。提案書 §3）
  let learning = { id: "", data: null, loaded: false };
  function renderLearningLine() {
    const el = $("sc-eval-learning");
    if (!el) return;
    if (!evaluationEligible(perf)) { el.style.display = "none"; return; }
    const neutral = (text) => { el.textContent = text; el.style.display = "block"; el.style.background = "var(--color-bg-subtle, #faf7f2)"; };
    if (learning.id !== perf.performerId) {
      // 受講者が変わったら、前の人の状態をすぐ消す（読み終わるまで別の人の「OJTに入れます」が見えないように）
      const id = perf.performerId;
      learning = { id, data: null, loaded: false };
      neutral("育成コースの進み具合を読み込んでいます…");
      getDoc(doc(getProdFirestore(db.app), "learningProgress", id))
        .then((d) => { if (learning.id === id) { learning = { id, data: d.exists() ? d.data() : null, loaded: true }; renderLearningLine(); } })
        .catch((e) => {
          console.warn("[supportChecklist] learningProgress", e.message);
          if (learning.id !== id) return;
          learning = { id: "", data: null, loaded: false }; // 次に描くときに読み直す
          neutral("育成コースの進み具合を読めませんでした（評価の保存には影響しません）。");
        });
      return;
    }
    if (!learning.loaded) return;
    const holder = grants.find((g) => g.userId === perf.performerId) || null;
    const line = evaluationLine(learning.data, holder, QUIZZES);
    el.textContent = line.text;
    el.style.display = "block";
    el.style.background = line.warn ? "var(--color-warning-soft, #fff7e0)" : "var(--color-success-soft, #e8f5ec)";
  }

  function renderEval() {
    const card = $("sc-eval-card");
    if (!card) return;
    if (!evaluationEligible(perf)) { card.style.display = "none"; evalUnsaved.clean(); return; } // トレーナーなし・見学・単独は対象外（隠れた欄の未保存は数えない）
    card.style.display = "";
    $("sc-eval-who").textContent = `受講者：${perf.performerName}／トレーナー：${perf.trainerName}／実施日：${perf.date}`;
    renderLearningLine();
    const canSave = isTrainer(actorId(), users(), rosterIds);
    if (!canSave) evalUnsaved.clean();
    // 受講者・実施日が変わって評価IDが変わったら、前の人の未保存の入力は捨てて流し込み直す
    // （残すと「評価を保存」で別の人の評価IDに前の人の点数が書かれる）
    const focused = !!(document.activeElement && document.activeElement.id && document.activeElement.id.startsWith("sc-eval-"));
    const refill = shouldRefillForm(evalUnsaved, myEvalId(), focused, "受講者または実施日が変わったため、保存していない評価の入力を取り消しました");
    const ev = caseEvals.find((e) => e._id === myEvalId());
    evalUnsaved.observe(ev || null, { own: evalsOwn }); // 未保存の間に他の人が更新したら知らせる
    if (refill) {
      ITEMS.forEach((i) => { $(`sc-eval-${i.n}`).value = (ev && ev.scores && ev.scores[i.n]) || ""; });
      const r = document.querySelector(`input[name="sc-eval-ojt"][value="${(ev && ev.ojtResult) || ""}"]`);
      document.querySelectorAll('input[name="sc-eval-ojt"]').forEach((x) => { x.checked = false; });
      if (r) r.checked = true;
      $("sc-eval-judgement").value = (ev && ev.judgement) || "";
      $("sc-eval-note").value = (ev && ev.note) || "";
    }
    $("sc-eval-save").disabled = !canSave;
    $("sc-eval-save").title = canSave ? "" : "評価を保存できるのはトレーナーのみです";
    $("sc-eval-saved").textContent = ev ? `保存済み（${judgementLabel(ev.judgement)}）` : (canSave ? "" : "評価の保存はトレーナーのみ");
    updateSuggest();
    renderBadgeBox();
  }

  async function saveEvaluation() {
    const errEl = $("sc-eval-error");
    if (!isTrainer(actorId(), users(), rosterIds)) { errEl.textContent = "評価を保存できるのはトレーナーだけです。"; errEl.style.display = "inline"; return; }
    await loadPriorOk();
    const r = buildEvaluation({
      scores: evalScoresFromForm(), ojtResult: ojtFromForm(),
      judgement: $("sc-eval-judgement").value, note: $("sc-eval-note").value,
    }, perf, { caseId, now: Date.now(), actor: opts.getActor ? opts.getActor() : "", priorOk });
    if (r.error) { errEl.textContent = r.error; errEl.style.display = "inline"; return; }
    errEl.style.display = "none";
    try {
      // 同じ案件・日付・受講者の評価は上書き（OJT 1回＝シート1枚）
      await setDoc(doc(db, "supportEvaluations", myEvalId()), { ...r.evaluation, updatedAt: serverTimestamp() });
      evalUnsaved.clean();
      $("sc-eval-saved").textContent = `保存しました ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (e) {
      errEl.textContent = "保存に失敗しました（時間をおいて再試行）"; errEl.style.display = "inline";
      console.error("[supportChecklist] evaluation save failed", e);
    }
  }

  async function grantBadge() {
    const msg = $("sc-badge-msg");
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST の今日
    const r = buildGrant({ userId: perf.performerId, date: today, basis: "evaluation", evaluationId: myEvalId() },
      { users: users(), rosterIds, grants, evaluations: caseEvals, actorId: actorId(), actor: opts.getActor ? opts.getActor() : "", now: Date.now() });
    if (r.error) { if (msg) msg.textContent = r.error; return; }
    if (!confirm(`${r.grant.userName}さんに伴走支援者バッジを付与します（認定：${r.grant.grantedByName}）。よろしいですか？`)) return;
    try {
      await addDoc(collection(db, "supportBadges"), { ...r.grant, createdAt: serverTimestamp() });
    } catch (e) {
      if (msg) msg.textContent = "付与に失敗しました（時間をおいて再試行）";
      console.error("[supportChecklist] badge grant failed", e);
    }
  }

  elOnsite.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.closest && t.closest("#sc-eval-card")) updateSuggest();
  });
  const evalSaveBtn = $("sc-eval-save");
  if (evalSaveBtn) evalSaveBtn.addEventListener("click", saveEvaluation);
  elOnsite.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("#sc-badge-grant")) grantBadge();
  });

  onSnapshot(collection(db, "supportBadges"), (snap) => { grants = snap.docs.map((d) => ({ _id: d.id, ...d.data() })); renderPerfWarn(); renderBadgeBox(); }, () => {});
  onSnapshot(query(collection(db, "supportEvaluations"), where("caseId", "==", caseId)),
    (snap) => { caseEvals = snap.docs.map((d) => ({ _id: d.id, ...d.data() })); evalsOwn = !!(snap.metadata && snap.metadata.hasPendingWrites); renderEval(); }, () => {});

  // 変更した欄があるカードの「保存しました」に出す。cp は事前確認・当日・アフターの3タブにまたがるため、
  // sec ごとの id（sc-saved-cp は事前確認の見出しにしか無い）で探すと別タブに出てしまっていた（2026-11-10 修正）
  function savedSpanFor(el) {
    const card = el && el.closest ? el.closest(".card") : null;
    return (card && card.querySelector(".sc-saved")) || document.getElementById(`sc-saved-${el.dataset.sec}`);
  }
  function markSaved(el) {
    const sv = savedSpanFor(el);
    if (!sv) return;
    const t = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    sv.textContent = `保存しました ${t}`;
  }

  // 当日（onsite）の節の書き込み中の保存（他の案件へ写す前に、終わるのを待つ）と、保存が失敗したままか。
  // 写すのは onsite だけなので、事前確認・アフター・ケアプラン連携の保存は見ない（レビュー 低-4）。
  // onsite の保存は節を丸ごと書くので、失敗のあとに「後から始めた保存」が成功すれば失敗は解消（順番で判定）
  const pendingSaves = new Set();
  let saveSeq = 0, okSeq = 0, failedSeq = 0;
  const onsiteSaveFailed = () => failedSeq > okSeq;
  const SAVE_WAIT_MS = 10000; // 保存の完了待ちの上限
  async function saveSection(sec) {
    await setDoc(ref, { [sec]: state[sec], updatedAt: serverTimestamp() }, { merge: true });
  }
  // 入力の変更による保存を見張る（書き込み中の一覧に入れ、終わったら外す。失敗したら印を付ける）。
  // 戻り値の settle(ok) を保存の成否が分かったところで呼ぶ
  function startSave(sec) {
    if (sec !== "onsite") return () => {};
    const seq = ++saveSeq;
    let done;
    const p = new Promise((r) => { done = r; });
    pendingSaves.add(p);
    return (ok) => {
      if (ok) okSeq = Math.max(okSeq, seq); else failedSeq = Math.max(failedSeq, seq);
      pendingSaves.delete(p); done();
    };
  }

  async function onChange(el) {
    const sec = el.dataset.sec;
    const path = el.dataset.path;
    const value = el.type === "checkbox" ? el.checked : el.value;
    setByPath(state[sec], path, value);
    if (sec === "cp" && path === "installStatus") syncCpInstalled();
    const settle = startSave(sec);
    try {
      await saveSection(sec);
      markSaved(el);
      settle(true);
    } catch (e) {
      settle(false);
      const sv = savedSpanFor(el);
      if (sv) sv.textContent = "保存に失敗しました（時間をおいて再試行）";
      console.error("[supportChecklist] save failed", e);
    }
  }

  // 証憑写真アップロード（Storage: documents/{caseId}/cp-evidence-... ＝既存storage.rules許可済み）
  async function onPhotoSelect(files) {
    if (!files.length || !storage) return;
    const prog = document.getElementById("sc-cp-photo-progress");
    const btn = document.getElementById("sc-cp-photo-btn");
    if (btn) btn.disabled = true;
    if (prog) { prog.style.display = "inline"; prog.textContent = `アップロード中… 0/${files.length}`; }
    if (!Array.isArray(state.cp.evidencePhotos)) state.cp.evidencePhotos = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const safe = `cp-evidence-${Date.now()}_${i}_${f.name.replace(/[^\w.\-]/g, "_")}`;
        const path = `documents/${caseId}/${safe}`;
        const snap = await uploadBytes(storageRef(storage, path), f);
        const url = await getDownloadURL(snap.ref);
        state.cp.evidencePhotos.push({ url, name: f.name, path, uploadedAt: Date.now() });
        if (prog) prog.textContent = `アップロード中… ${i + 1}/${files.length}`;
      }
      await saveSection("cp");
      renderPhotos();
      if (prog) prog.textContent = "アップロード完了";
    } catch (e) {
      if (prog) prog.textContent = "アップロードに失敗しました";
      console.error("[supportChecklist] photo upload failed", e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function onPhotoDelete(idx) {
    const photos = state.cp.evidencePhotos || [];
    const p = photos[idx];
    if (!p) return;
    photos.splice(idx, 1);
    renderPhotos();
    try {
      await saveSection("cp");
      if (p.path && storage) { try { await deleteObject(storageRef(storage, p.path)); } catch (_) { /* 既に無い場合は無視 */ } }
    } catch (e) {
      console.error("[supportChecklist] photo delete failed", e);
    }
  }

  // 入力変更（data-path を持つ要素のみ）
  [elPre, elOnsite, elAfter].forEach((container) => {
    container.addEventListener("change", (e) => {
      const el = e.target;
      if (el && el.dataset && el.dataset.path) onChange(el);
    });
  });

  // 写真の追加・削除（当日タブ内）
  const photoBtn = document.getElementById("sc-cp-photo-btn");
  const photoInput = document.getElementById("sc-cp-photo-input");
  if (photoBtn && photoInput) {
    photoBtn.addEventListener("click", () => photoInput.click());
    photoInput.addEventListener("change", async () => {
      await onPhotoSelect(Array.from(photoInput.files || []));
      photoInput.value = "";
    });
  }
  elOnsite.addEventListener("click", (e) => {
    const del = e.target.closest && e.target.closest(".sc-photo-del");
    if (del) onPhotoDelete(Number(del.dataset.idx));
  });

  // ----- 当日の記録を確定 -----
  let knownActivities = null; // case-detail.js が対応記録の購読から渡す（setActivities）
  let confirmBusy = false;
  function showConfirmStatus(text, isError = false) {
    const el = $("sc-onsite-confirm-status");
    if (!el) return;
    el.style.color = isError ? "var(--color-danger)" : "var(--color-ink-muted)";
    el.textContent = text;
  }
  function refreshConfirmStatus() {
    if (confirmBusy || !knownActivities) return;
    const d = visitDate();
    showConfirmStatus(findOnsiteConfirmation(knownActivities, d) ? `記録済み（訪問日 ${d}）` : "");
  }
  async function confirmOnsite() {
    if (confirmBusy) return;
    // 画面の訪問日欄に表示されている値で確定する（表示と保存を食い違わせない・レビュー 中-3）
    const vd = confirmVisitDate(($("sc-onsite-visitDate") || {}).value, state.onsite.visitDate);
    const d = vd.date;
    if (!d) { showConfirmStatus("訪問日を入れてから確定してください", true); return; }
    const btn = $("sc-onsite-confirm");
    confirmBusy = true;
    if (btn) btn.disabled = true;
    try {
      // 二重に足さない: 押した時点の対応記録を読み直して確かめる（購読の到着待ちで漏れないように）
      const snap = await getDocs(query(collection(db, "activities"), where("caseId", "==", caseId)));
      const acts = snap.docs.map((x) => ({ _id: x.id, ...x.data() }));
      if (findOnsiteConfirmation(acts, d)) { showConfirmStatus(`記録済み（訪問日 ${d}）`); return; }
      // 訪問日欄の値が保存済みと違う（案件の訪問予定日を出しているだけ等）なら、その日を訪問日として保存する
      if (vd.needsSave) { state.onsite.visitDate = d; await saveSection("onsite"); }
      const summary = onsiteConfirmSummary({
        onsite: state.onsite, cp: state.cp, visitDate: d,
        stepKeys: ONSITE_STEPS.map((i) => i.key), cpStepKeys: CP_STEPS.map((i) => i.key), cpInstalled: cpInstalled(state.cp),
      });
      await addDoc(collection(db, "activities"), {
        ...onsiteConfirmActivity({ caseId, visitDate: d, summary,
          userId: opts.getActorUid ? opts.getActorUid() : "", userName: opts.getActor ? opts.getActor() : "" }),
        occurredAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });
      showConfirmStatus(`対応記録に残しました（訪問日 ${d}）`);
    } catch (e) {
      showConfirmStatus("記録に失敗しました（時間をおいて再試行）", true);
      console.error("[supportChecklist] onsite confirm failed", e);
    } finally {
      confirmBusy = false;
      if (btn) btn.disabled = false;
    }
  }
  const confirmBtn = $("sc-onsite-confirm");
  if (confirmBtn) confirmBtn.addEventListener("click", confirmOnsite);

  // ----- 同じ事業所の他の案件にも写す（設計書 提案2）-----
  let copyBusy = false;
  let copyCands = [];
  const canEdit = () => (opts.canEdit ? !!opts.canEdit() : true);
  function showCopyStatus(text, isError = false) {
    const el = $("sc-copy-status");
    if (!el) return;
    el.style.color = isError ? "var(--color-danger)" : "var(--color-ink-muted)";
    el.textContent = text;
  }
  // 写した印（写し先: 「#◯◯ から写した記録」／写し元: 「#◯◯・#△△ へ写した」）
  function renderCopyMarks() {
    const from = copiedFromText(docData);
    const to = copiedToText(docData);
    const banner = $("sc-copy-banner");
    if (banner) {
      banner.textContent = [from, to].filter(Boolean).join("／");
      banner.style.display = from || to ? "block" : "none";
    }
    const toEl = $("sc-copy-to");
    if (toEl) { toEl.textContent = to; toEl.style.display = to ? "block" : "none"; }
  }
  // ボタンを出すか。事業所が未登録（officeId なし）なら理由を出す。閲覧のみの人には出さない
  function renderCopyAvailability() {
    const btn = $("sc-copy-open"), reasonEl = $("sc-copy-reason");
    if (!btn || !reasonEl) return;
    const c = opts.getCase ? opts.getCase() : null;
    const reason = !canEdit() ? "閲覧のみの権限では写せません" : copyUnavailableReason(c);
    reasonEl.textContent = reason;
    reasonEl.style.display = reason ? "block" : "none";
    btn.style.display = reason ? "none" : "";
    if (reason) { const panel = $("sc-copy-panel"); if (panel) panel.style.display = "none"; }
  }
  async function openCopyPanel() {
    const c = opts.getCase ? opts.getCase() : null;
    const reason = copyUnavailableReason(c);
    if (reason) { renderCopyAvailability(); return; }
    const panel = $("sc-copy-panel"), list = $("sc-copy-list");
    panel.style.display = "block";
    list.textContent = "同じ事業所の案件を読み込んでいます…";
    try {
      const snap = await getDocs(query(collection(db, "cases"), where("officeId", "==", c.officeId)));
      copyCands = copyCandidates(c, snap.docs.map((d) => ({ _id: d.id, ...d.data() })));
    } catch (e) {
      copyCands = [];
      list.textContent = "案件を読み込めませんでした（時間をおいて再試行）";
      console.error("[supportChecklist] copy candidates failed", e);
      return;
    }
    if (!copyCands.length) { list.textContent = "同じ事業所の他の案件はありません"; $("sc-copy-run").disabled = true; return; }
    $("sc-copy-run").disabled = false;
    const prev = (docData && docData.copiedTo) || {};
    list.innerHTML = copyCands.map((x) => {
      const last = prev[x._id] ? `（前回 ${escapeHtml(formatJst(prev[x._id].copiedAtMs))} に写した）` : "";
      return `
        <label class="checklist-check" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;min-height:44px">
          <input type="checkbox" data-copy-target="${escapeHtml(x._id)}">
          <span><strong>${escapeHtml(caseLabel(x.caseNumber))}</strong> ${escapeHtml(serviceTypeLabel(x))}／${escapeHtml(STATUS_LABELS[Number(x.status)] || "状態不明")}${last}</span>
        </label>`;
    }).join("");
  }

  async function runCopy() {
    if (copyBusy) return;
    const c = opts.getCase ? opts.getCase() : null;
    if (copyUnavailableReason(c) || !canEdit()) { renderCopyAvailability(); return; }
    const ids = Array.from(document.querySelectorAll("#sc-copy-list [data-copy-target]:checked")).map((x) => x.dataset.copyTarget);
    const targets = copyCands.filter((x) => ids.includes(x._id));
    if (!targets.length) { showCopyStatus("写し先を選んでください", true); return; }
    const btn = $("sc-copy-run");
    copyBusy = true;
    if (btn) btn.disabled = true;
    try {
      // 未保存の入力が写し元にあるときは、先に保存させる（保存中なら終わるまで待つ。失敗していたら写さない）
      if (pendingSaves.size) {
        showCopyStatus("入力を保存しています…");
        let timer;
        const finished = await Promise.race([
          Promise.allSettled([...pendingSaves]).then(() => true),
          new Promise((r) => { timer = setTimeout(() => r(false), SAVE_WAIT_MS); }),
        ]);
        clearTimeout(timer);
        if (!finished) { showCopyStatus("保存が終わらないため写せません。通信を確かめてください", true); return; }
      }
      if (onsiteSaveFailed()) { showCopyStatus("保存できていない入力があります。入力し直して「保存しました」と出てから写してください", true); return; }
      // 画面の訪問日欄に出ている日を正にする（「当日の記録を確定」と同じ。案件の訪問予定日を出しているだけなら先に保存する）
      const vd = confirmVisitDate(($("sc-onsite-visitDate") || {}).value, state.onsite.visitDate);
      if (!hasCopyableContent(state.onsite, vd.date)) { showCopyStatus("写す内容がありません（当日工程・所感・訪問日が空です）", true); return; }
      if (vd.needsSave) { state.onsite.visitDate = vd.date; await saveSection("onsite"); }

      // 写し先を読んで、上書きになる入力の件数を数える
      showCopyStatus("写し先を確かめています…");
      const reads = await Promise.all(targets.map((t) => getDoc(doc(db, "supportChecklists", t._id))));
      const plans = targets.map((t, i) => {
        const tdoc = reads[i].exists() ? reads[i].data() : null;
        const chk = overwriteCheck(tdoc, caseId, buildCopiedOnsite(state.onsite, tdoc && tdoc.onsite, { visitDate: vd.date }));
        return { t, count: chk.count, paths: chk.paths, caseNumber: t.caseNumber, expected: copyFingerprint(tdoc && tdoc.onsite) };
      });
      const names = targets.map((t) => caseLabel(t.caseNumber)).join("・");
      const msg = overwriteConfirmText(plans, STEP_LABELS) || `${names} へ当日の記録を写します。よろしいですか？`;
      if (!confirm(msg)) { showCopyStatus("写すのをやめました"); return; }

      const actorName = opts.getActor ? opts.getActor() : "";
      const actorId = opts.getActorId ? opts.getActorId() : "";
      const userId = opts.getActorUid ? opts.getActorUid() : "";
      const nowMs = Date.now();
      const acts = copyActivities({ sourceCaseId: caseId, sourceCaseNumber: c.caseNumber, targets: targets.map((t) => ({ caseId: t._id, caseNumber: t.caseNumber })),
        visitDate: vd.date, userId, userName: actorName });
      const results = [];
      // 1件ずつ書く（1件の写し先・写し元の印・写し先の対応記録を1つのトランザクションで）。途中で失敗しても残りは続け、結果を全部出す
      for (const [i, p] of plans.entries()) {
        showCopyStatus(`写しています… ${i + 1}/${plans.length}`);
        const tRef = doc(db, "supportChecklists", p.t._id);
        try {
          await runTransaction(db, async (tx) => {
            const srcSnap = await tx.get(ref);
            const tSnap = await tx.get(tRef);
            if (!srcSnap.exists()) throw new Error("写し元の記録が見つかりません");
            const tdoc = tSnap.exists() ? tSnap.data() : null;
            // 確認のあとに写し先が変わっていたら、確かめていない入力を上書きしないよう止める
            if (copyFingerprint(tdoc && tdoc.onsite) !== p.expected) throw new Error("確認のあとに写し先が変更されました。もう一度写してください");
            const newOnsite = buildCopiedOnsite(srcSnap.data().onsite, tdoc && tdoc.onsite, { visitDate: vd.date });
            const copiedFrom = { ...copiedFromRecord({ sourceCaseId: caseId, sourceCaseNumber: c.caseNumber, nowMs, actorName, actorId, newOnsite }), copiedAt: serverTimestamp() };
            const payload = { onsite: newOnsite, copiedFrom, updatedAt: serverTimestamp() };
            // onsite は丸ごと置き換える（merge だと写し元に無い工程が写し先に残る）。ほかの節（cp・performance など）は触らない
            if (tSnap.exists()) tx.update(tRef, payload); else tx.set(tRef, payload);
            tx.update(ref, { [`copiedTo.${p.t._id}`]: { ...copiedToRecord({ targetCaseNumber: p.t.caseNumber, nowMs, actorName, actorId }), copiedAt: serverTimestamp() } });
            tx.set(doc(collection(db, "activities")), { ...acts.target({ caseId: p.t._id, caseNumber: p.t.caseNumber }), occurredAt: serverTimestamp() });
            tx.update(doc(db, "cases", p.t._id), { updatedAt: serverTimestamp() });
          });
          results.push({ caseNumber: p.t.caseNumber, ok: true });
        } catch (e) {
          results.push({ caseNumber: p.t.caseNumber, ok: false, error: e && e.message ? e.message : "失敗" });
          console.error("[supportChecklist] copy failed", p.t._id, e);
        }
      }
      // 写し元の対応記録（写せた案件だけを書く）
      let sourceLogError = "";
      const okTargets = plans.filter((p, i) => results[i].ok).map((p) => ({ caseId: p.t._id, caseNumber: p.t.caseNumber }));
      if (okTargets.length) {
        try {
          const srcAct = copyActivities({ sourceCaseId: caseId, sourceCaseNumber: c.caseNumber, targets: okTargets, visitDate: vd.date, userId, userName: actorName }).source;
          await addDoc(collection(db, "activities"), { ...srcAct, occurredAt: serverTimestamp() });
          await updateDoc(doc(db, "cases", caseId), { updatedAt: serverTimestamp() });
        } catch (e) {
          sourceLogError = "時間をおいて対応記録にメモを残してください";
          console.error("[supportChecklist] copy source activity failed", e);
        }
      }
      const r = copyResultText(results, sourceLogError);
      showCopyStatus(r.text, !r.allOk);
      if (okTargets.length) await openCopyPanel(); // 「前回写した」の表示を新しくする
    } catch (e) {
      showCopyStatus("写せませんでした（時間をおいて再試行）", true);
      console.error("[supportChecklist] copy failed", e);
    } finally {
      copyBusy = false;
      if (btn) btn.disabled = !copyCands.length;
    }
  }
  const copyOpenBtn = $("sc-copy-open");
  if (copyOpenBtn) copyOpenBtn.addEventListener("click", openCopyPanel);
  const copyRunBtn = $("sc-copy-run");
  if (copyRunBtn) copyRunBtn.addEventListener("click", runCopy);
  const copyCloseBtn = $("sc-copy-close");
  if (copyCloseBtn) copyCloseBtn.addEventListener("click", () => { $("sc-copy-panel").style.display = "none"; });
  renderCopyAvailability();

  onSnapshot(ref, (snap) => {
    const data = snap.exists() ? snap.data() : {};
    state.pre = data.pre || {};
    state.onsite = data.onsite || { steps: {} };
    if (!state.onsite.steps) state.onsite.steps = {};
    state.after = data.after || { privacy: {} };
    if (!state.after.privacy) state.after.privacy = {};
    state.cp = data.cp || { steps: {}, evidencePhotos: [] };
    if (!state.cp.steps) state.cp.steps = {};
    if (!Array.isArray(state.cp.evidencePhotos)) state.cp.evidencePhotos = [];
    // 保存済みの実施の記録を先に更新する（populate → 実施日の初期値の判定が古い perf を見ないように・レビュー 低-1）
    perf = data.performance || null;
    docData = data;
    populate();
    renderCopyMarks();
    // 実施の記録は入力途中の内容を上書きしない（フォーカスが記録欄にあるときは流し込まない）
    perfUnsaved.observe(perf, { own: !!(snap.metadata && snap.metadata.hasPendingWrites) }); // 未保存の間に他の人が更新したら知らせる
    renderPerfSummary();
    renderPerfWarn();
    loadPriorOk().then(renderEval);
    // 未保存の変更があるときも流し込まない（同じ文書の自動保存のたびに、入力途中の実施の記録が保存済みの値に戻っていた）
    if (!perfUnsaved.isDirty() && !(document.activeElement && document.activeElement.id && document.activeElement.id.startsWith("sc-perf-"))) fillPerfForm();
  });

  return {
    // 対応記録の購読が届くたびに呼ぶ（「記録済み」の表示）
    setActivities(list) { knownActivities = Array.isArray(list) ? list : []; refreshConfirmStatus(); },
    // 案件の訪問予定日（ヘッダー）を変えたあとに呼ぶ。当日タブの訪問日欄（未保存の表示）と、実施日の初期値を新しい日へ
    refreshVisitDate() { fillOnsiteDefaults(); notifyVisitDate(); },
    refreshPeople() { if (perfUnsaved.isDirty()) fillPerfOptions(true); else fillPerfForm(); renderEval(); renderPerfWarn(); fillOnsiteDefaults(); notifyVisitDate(); renderCopyAvailability(); } };
}
