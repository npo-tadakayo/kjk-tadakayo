// 案件詳細の純粋ユーティリティ・定数（state非依存）。case-detail.js から切り出し（C2 / 挙動不変）。

export const ACTIVITY_ICONS = {
  phone_in: "ti-phone-incoming",
  phone_out: "ti-phone-outgoing",
  email_in: "ti-mail-down",
  email_out: "ti-mail-up",
  visit: "ti-map-pin",
  memo: "ti-notes",
  gmail_sent: "ti-mail-forward",
};

export const ACTIVITY_LABELS = {
  phone_in: "電話（着信）",
  phone_out: "電話（発信）",
  email_in: "メール（受信）",
  email_out: "メール（送信）",
  visit: "訪問・対面",
  memo: "メモ",
  gmail_sent: "Gmail送信",
};

export const AI_TITLES = {
  reply_draft: "返信メール下書き", summary_classify: "要約・分類",
  session_report: "伴走報告文", assistant: "AIの回答",
};

export function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDateTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// 日付は必ず日本時間で YYYY-MM-DD にする。
// toISOString() はUTCなので、日本の午前9時前の時刻や「その日の0時」は前日にずれる。
export function toYmdJst(d) {
  return new Date(d).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

export function toDateInput(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return toYmdJst(d);
}

// 振込予定日: 申請月の翌々月末
export function calcExpectedDeposit(applicationDateStr) {
  if (!applicationDateStr) return null;
  const d = new Date(applicationDateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 3; // +2ヶ月 → 翌々月末 = +3ヶ月の0日
  return new Date(year, month, 0);
}

// 失注の理由を聞くモーダル（案件詳細・カンバン共用）。2026-10-19
// 理由コードとメモを返す。キャンセルなら null。DOM は初回に作って使い回す（crm.css の .modal-overlay を使用）。
export function askLostReason(reasons) {
  return new Promise((resolve) => {
    let ov = document.getElementById("lostReasonModal");
    if (!ov) {
      ov = document.createElement("div");
      ov.className = "modal-overlay";
      ov.id = "lostReasonModal";
      ov.setAttribute("role", "dialog");
      ov.setAttribute("aria-modal", "true");
      ov.setAttribute("aria-label", "失注の理由");
      ov.innerHTML = `<div class="modal">
        <div class="modal-header"><h2>失注の理由</h2></div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--color-ink-muted);margin-bottom:10px">失注にする理由を選んでください。あとから案件詳細で確認できます。</p>
          <div class="form-group"><label class="form-label" for="lostReasonSel">理由</label>
            <select class="form-control" id="lostReasonSel"></select></div>
          <div class="form-group"><label class="form-label" for="lostReasonNote">メモ（任意）</label>
            <textarea class="form-control" id="lostReasonNote" rows="2" maxlength="300"></textarea></div>
          <span id="lostReasonErr" role="alert" style="display:none;font-size:13px;color:var(--color-danger)">理由を選んでください</span>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="lostReasonCancel" type="button">キャンセル</button>
          <button class="btn btn-primary" id="lostReasonOk" type="button">失注にする</button>
        </div></div>`;
      document.body.appendChild(ov);
    }
    const sel = ov.querySelector("#lostReasonSel");
    sel.innerHTML = `<option value="">選んでください</option>` +
      Object.entries(reasons).map(([k, v]) => `<option value="${escHtml(k)}">${escHtml(v)}</option>`).join("");
    ov.querySelector("#lostReasonNote").value = "";
    ov.querySelector("#lostReasonErr").style.display = "none";
    ov.classList.add("open");
    sel.focus();
    const done = (val) => {
      ov.classList.remove("open");
      ov.querySelector("#lostReasonOk").onclick = null;
      ov.querySelector("#lostReasonCancel").onclick = null;
      ov.onclick = null;
      resolve(val);
    };
    ov.querySelector("#lostReasonOk").onclick = () => {
      if (!sel.value) { ov.querySelector("#lostReasonErr").style.display = "inline"; return; }
      done({ reason: sel.value, note: ov.querySelector("#lostReasonNote").value.trim() });
    };
    ov.querySelector("#lostReasonCancel").onclick = () => done(null);
    ov.onclick = (e) => { if (e.target === ov) done(null); };
  });
}
