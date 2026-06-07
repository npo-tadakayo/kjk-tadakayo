// 伴走支援チェックリスト（事前 / 当日 / アフター）を案件ごとにアプリ内で記録する。
// 出典: 介護情報基盤伴走支援/02_伴走支援/01_伴走支援チェックリスト.md ＋ 02_支援記録テンプレート.md。
// 保存先: Firestore `supportChecklists/{caseId}`（documentChecklists と同じ1案件1ドキュメントのパターン）。
// 設計方針:
//   - スケルトンは初回1回だけ描画し、値は populate() で流し込む（フォーカス中の要素は上書きしない＝カーソル飛び防止）
//   - 変更は change イベントで該当セクションを merge 保存（textarea/text は blur 相当の change で確定）
//   - 個人情報（パスワード・暗証番号・口座番号）はここに記録しない方針（テンプレ §6・Pマーク準拠）

import { doc, setDoc, onSnapshot, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

// 当日工程（B）— チェック＋メモ
const ONSITE_STEPS = [
  { key: "portalReg", label: "初回利用登録（ポータル）" },
  { key: "certInstall", label: "電子証明書 インストール" },
  { key: "mynaApp", label: "マイナ資格確認アプリ 設定" },
  { key: "crConnect", label: "カードリーダー 接続確認" },
  { key: "webSetup", label: "介護WEBサービス 設定（事業所/管理者/一般ユーザ）" },
  { key: "operationTest", label: "動作確認（資格確認テスト）" },
  { key: "userNotice", label: "利用者周知（ポスター/リーフレット案内）" },
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

function savedSpan(sec) {
  return `<span class="sc-saved" id="sc-saved-${sec}" aria-live="polite" style="font-size:12px;color:var(--color-ink-muted)"></span>`;
}

function renderPre() {
  return `
    <div class="card">
      <div class="card-header">
        <span style="font-weight:600;font-size:14px">事前確認（訪問前）</span>
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
    </div>`;
}

function renderOnsite() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        <span style="font-weight:600;font-size:14px">当日 — 訪問情報</span>
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
    </div>
    <div class="card">
      <div class="card-header">
        <span style="font-weight:600;font-size:14px">当日 — 工程チェック</span>
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

function privacyRow(sec, item) {
  const id = `sc-${sec}-${item.key}`;
  return `
    <label class="checklist-check" style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:6px 0">
      <input type="checkbox" id="${id}" data-sec="${sec}" data-path="privacy.${item.key}">
      <span>${item.label}</span>
    </label>`;
}

function renderAfter() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        <span style="font-weight:600;font-size:14px">アフターフォロー</span>
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
    <div class="card">
      <div class="card-header">
        <span style="font-weight:600;font-size:14px">個人情報の取扱い確認（Pマーク準拠）</span>
      </div>
      <div class="card-body">
        ${PRIVACY_ITEMS.map((i) => privacyRow("after", i)).join("")}
      </div>
    </div>`;
}

// path（"a.b.c"）で nested に値を set
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

export function initSupportChecklist(db, caseId, userGetter) {
  const elPre = document.getElementById("tab-pre");
  const elOnsite = document.getElementById("tab-onsite");
  const elAfter = document.getElementById("tab-after");
  if (!elPre || !elOnsite || !elAfter) return; // タブが無ければ何もしない

  // スケルトンを1回だけ描画
  elPre.innerHTML = renderPre();
  elOnsite.innerHTML = renderOnsite();
  elAfter.innerHTML = renderAfter();

  const ref = doc(db, "supportChecklists", caseId);
  const state = { pre: {}, onsite: { steps: {} }, after: { privacy: {} } };

  // 値を流し込む（フォーカス中の要素は上書きしない）
  function populate() {
    document.querySelectorAll("#tab-pre [data-path], #tab-onsite [data-path], #tab-after [data-path]").forEach((el) => {
      if (el === document.activeElement) return;
      const sec = el.dataset.sec;
      const v = getByPath(state[sec], el.dataset.path);
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v == null ? "" : v;
    });
  }

  function markSaved(sec) {
    const el = document.getElementById(`sc-saved-${sec}`);
    if (!el) return;
    const t = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    el.textContent = `保存しました ${t}`;
  }

  // 変更 → 該当セクションを merge 保存
  async function onChange(el) {
    const sec = el.dataset.sec;
    const path = el.dataset.path;
    const value = el.type === "checkbox" ? el.checked : el.value;
    setByPath(state[sec], path, value);
    try {
      await setDoc(ref, { [sec]: state[sec], updatedAt: serverTimestamp() }, { merge: true });
      markSaved(sec);
    } catch (e) {
      const sv = document.getElementById(`sc-saved-${sec}`);
      if (sv) sv.textContent = "保存に失敗しました（時間をおいて再試行）";
      console.error("[supportChecklist] save failed", e);
    }
  }

  [elPre, elOnsite, elAfter].forEach((container) => {
    container.addEventListener("change", (e) => {
      const el = e.target;
      if (el && el.dataset && el.dataset.path) onChange(el);
    });
  });

  onSnapshot(ref, (snap) => {
    const data = snap.exists() ? snap.data() : {};
    state.pre = data.pre || {};
    state.onsite = data.onsite || { steps: {} };
    if (!state.onsite.steps) state.onsite.steps = {};
    state.after = data.after || { privacy: {} };
    if (!state.after.privacy) state.after.privacy = {};
    populate();
  });
}
