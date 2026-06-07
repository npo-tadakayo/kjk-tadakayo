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

import { doc, setDoc, onSnapshot, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

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

function savedSpan(sec) {
  return `<span class="sc-saved" id="sc-saved-${sec}" aria-live="polite" style="font-size:12px;color:var(--color-ink-muted)"></span>`;
}

function selectGroup(id, sec, path, label, opts) {
  const o = opts.map((x) => `<option value="${x.v}">${x.t}</option>`).join("");
  return `
    <div class="form-group">
      <label class="form-label" for="${id}">${label}</label>
      <select class="form-control" id="${id}" data-sec="${sec}" data-path="${path}" style="max-width:340px">${o}</select>
    </div>`;
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
        <span style="font-weight:600;font-size:14px">ケアプラン連携 — 事前確認</span>
        ${savedSpan("cp")}
      </div>
      <div class="card-body">
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
        <span style="font-weight:600;font-size:14px">介護情報基盤 — 事前確認（訪問前）</span>
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
    </div>`;
}

function cardOnsiteSteps() {
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header">
        <span style="font-weight:600;font-size:14px">介護情報基盤 — 当日工程</span>
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
        <span style="font-weight:600;font-size:14px">ケアプラン連携 — 導入作業</span>
      </div>
      <div class="card-body">
        ${CP_STEPS.map((i) => rowStep("cp", i)).join("")}
      </div>
    </div>`;
}

function cardCpEvidence() {
  return `
    <div class="card">
      <div class="card-header">
        <span style="font-weight:600;font-size:14px">ケアプラン連携 — 証憑写真（ライセンス／電子証明書の有効期間）</span>
      </div>
      <div class="card-body">
        <p style="font-size:12px;color:var(--color-ink-muted);margin:0 0 10px">利用申請完了画面・ライセンス情報や、電子証明書の有効期間がわかる画面の写真を保存できます。個人情報（パスワード等）が写り込まないよう注意。</p>
        <input type="file" id="sc-cp-photo-input" accept="image/*" multiple style="display:none">
        <button type="button" class="btn btn-secondary" id="sc-cp-photo-btn" style="min-height:44px">
          <i class="ti ti-camera" aria-hidden="true"></i> 写真を追加
        </button>
        <span id="sc-cp-photo-progress" aria-live="polite" style="display:none;font-size:13px;color:var(--color-ink-muted);margin-left:10px"></span>
        <div id="sc-cp-photos" style="margin-top:10px"></div>
      </div>
    </div>`;
}

function renderOnsite() {
  return `${cardVisitInfo()}${cardOnsiteSteps()}${cardCpSteps()}${cardCpEvidence()}`;
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
        <span style="font-weight:600;font-size:14px">ケアプラン連携 — ライセンス・運用・アフター</span>
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
        <span style="font-weight:600;font-size:14px">介護情報基盤 — アフターフォロー</span>
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
        <span style="font-weight:600;font-size:14px">個人情報の取扱い確認（Pマーク準拠）</span>
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

export function initSupportChecklist(db, caseId, storage) {
  const elPre = document.getElementById("tab-pre");
  const elOnsite = document.getElementById("tab-onsite");
  const elAfter = document.getElementById("tab-after");
  if (!elPre || !elOnsite || !elAfter) return; // タブが無ければ何もしない

  // スケルトンを1回だけ描画（ケアプラン連携は各フェーズに統合）
  elPre.innerHTML = renderPre();
  elOnsite.innerHTML = renderOnsite();
  elAfter.innerHTML = renderAfter();

  const ref = doc(db, "supportChecklists", caseId);
  const state = { pre: {}, onsite: { steps: {} }, after: { privacy: {} }, cp: { steps: {}, evidencePhotos: [] } };

  function populate() {
    document.querySelectorAll("#tab-pre [data-path], #tab-onsite [data-path], #tab-after [data-path]").forEach((el) => {
      if (el === document.activeElement) return;
      const sec = el.dataset.sec;
      const v = getByPath(state[sec], el.dataset.path);
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v == null ? "" : v;
    });
    renderPhotos();
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

  function markSaved(sec) {
    const el = document.getElementById(`sc-saved-${sec}`);
    if (!el) return;
    const t = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    el.textContent = `保存しました ${t}`;
  }

  async function saveSection(sec) {
    await setDoc(ref, { [sec]: state[sec], updatedAt: serverTimestamp() }, { merge: true });
  }

  async function onChange(el) {
    const sec = el.dataset.sec;
    const path = el.dataset.path;
    const value = el.type === "checkbox" ? el.checked : el.value;
    setByPath(state[sec], path, value);
    try {
      await saveSection(sec);
      markSaved(sec === "cp" ? "cp" : sec);
    } catch (e) {
      const sv = document.getElementById(`sc-saved-${sec === "cp" ? "cp" : sec}`);
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
    populate();
  });
}
