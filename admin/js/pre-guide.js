// 資料の事前送付（事前準備のご案内メール）— 案件詳細の「事前確認」タブ
//
// 伴走支援の訪問・オンライン支援の前に、事業所に「当日までに準備しておくもの」を
// メールで送る。今までこの手段が無く、口頭や個別メールで伝えていた（2026-09-01 新設）。
//
// ・本文は事前確認チェックリスト（support-checklist.js の PRE 8項目）と同じ内容。
//   支援担当者がチェックする項目と、事業所に案内する項目がずれないよう、ここに固定で持つ
// ・送信は既存の sendCaseEmail（タイムラインに自動記録）
// ・送付済みかどうかは cases.preGuideMailedAt で持ち、カードに表示する

import {
  doc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let ctx = null; // { db, caseId, getCase, sendMail, toast }

// 事業所へ案内する準備物。support-checklist.js の PRE_ITEMS と対で保つ
// （あちらは支援者の確認用の文言、こちらは事業所向けの文言）
const GUIDE_ITEMS = [
  "電子請求受付システムのID（KJで始まる14桁）…国保連合会から通知されたものをお手元にご用意ください",
  "電子請求受付システムのパスワード…仮パスワードのままの場合は、本パスワードへの変更をお願いします",
  "セキュリティ用メールアドレスの登録…確認コード（ワンタイムパスワード）の受信に必須です",
  "電子証明書…未取得の場合、発行までに1か月ほどかかることがあります。お早めにご確認ください",
  "インターネット環境…Wi-Fiまたは有線。電波の弱いお部屋は避けてください",
  "設定に使うパソコン…Windows 11 と Microsoft Edge を推奨しています",
  "カードリーダー…マイナ資格確認アプリ対応のもの（当法人でも取扱いがあります）",
  "助成金申請のご意向・ご希望台数…当日にお伺いしますので、ご検討ください",
];

function mailTemplate(c) {
  return {
    subject: `【NPO法人タダカヨ】伴走支援に向けた事前のご準備のお願い（${c.officeName || ""}様）`,
    body:
      `${c.officeName || ""}\n${c.contactName ? c.contactName + " 様" : "ご担当者様"}\n\n` +
      `NPO法人タダカヨです。\n` +
      `介護情報基盤の伴走支援を円滑に進めるため、当日までに以下のご準備をお願いいたします。\n\n` +
      GUIDE_ITEMS.map((t, i) => `${i + 1}. ${t}`).join("\n\n") + `\n\n` +
      `ご不明な点や、ご準備が難しいものがある場合は、このメールへの返信でお知らせください。\n` +
      `当日、伴走支援担当者が一緒に確認いたします。\n\n` +
      `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`,
  };
}

function render() {
  const host = document.getElementById("preGuideCard");
  if (!host) return;
  const c = ctx.getCase() || {};
  const sent = c.preGuideMailedAt || "";
  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-header" style="display:flex;align-items:center;gap:10px">
        <span style="font-weight:600;font-size:14px"><i class="ti ti-mail-fast" aria-hidden="true"></i> 資料の事前送付（準備のご案内）</span>
        ${sent ? `<span class="badge badge-3">送付済み ${esc(String(sent).slice(0, 10))}</span>` : `<span class="badge badge-7">未送付</span>`}
      </div>
      <div class="card-body">
        <p style="font-size:13px;color:var(--color-ink-muted);margin-bottom:10px">
          支援当日までに事業所にご準備いただくもの（下の事前確認チェックリストと同じ8項目）を、メールでご案内します。
        </p>
        <button class="btn ${sent ? "btn-secondary" : "btn-primary"}" id="preGuideMailBtn" type="button">
          <i class="ti ti-send" aria-hidden="true"></i> ${sent ? "もう一度案内を送る" : "準備のご案内を送る"}
        </button>
      </div>
    </div>`;
  document.getElementById("preGuideMailBtn").addEventListener("click", openModal);
}

function openModal() {
  const c = ctx.getCase() || {};
  const t = mailTemplate(c);
  const host = document.getElementById("preGuideModal") || (() => {
    const d = document.createElement("div"); d.id = "preGuideModal"; document.body.appendChild(d); return d;
  })();
  host.innerHTML = `
    <div class="modal-backdrop" style="position:fixed;inset:0;background:rgba(30,25,18,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="modal" style="position:relative;background:var(--color-bg,#FAFAF8);border-radius:16px;max-width:640px;width:100%;max-height:90vh;overflow:auto;padding:0">
        <div style="display:flex;align-items:center;gap:10px;padding:18px 22px;border-bottom:1px solid var(--color-border)">
          <strong style="font-size:15px">事前準備のご案内メール</strong>
          <button id="pgClose" class="btn btn-secondary" style="margin-left:auto" aria-label="閉じる">×</button>
        </div>
        <div style="padding:18px 22px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label class="form-label" for="pgTo">宛先 *</label>
            <input class="form-control" id="pgTo" type="email" value="${esc(c.contactEmail || "")}">
          </div>
          <div>
            <label class="form-label" for="pgSubject">件名 *</label>
            <input class="form-control" id="pgSubject" value="${esc(t.subject)}">
          </div>
          <div>
            <label class="form-label" for="pgBody">本文 *</label>
            <textarea class="form-control" id="pgBody" rows="14" style="font-size:13px">${esc(t.body)}</textarea>
          </div>
          <div style="font-size:12px;color:var(--color-ink-muted)">送信するとタイムラインにも記録されます（sendCaseEmail 経由）</div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;padding:14px 22px;border-top:1px solid var(--color-border)">
          <button class="btn btn-secondary" id="pgCancel">キャンセル</button>
          <button class="btn btn-primary" id="pgSend"><i class="ti ti-send" aria-hidden="true"></i> 送信する</button>
        </div>
      </div>
    </div>`;
  const close = () => { host.innerHTML = ""; };
  document.getElementById("pgClose").addEventListener("click", close);
  document.getElementById("pgCancel").addEventListener("click", close);
  document.getElementById("pgSend").addEventListener("click", async (e) => {
    const to = document.getElementById("pgTo").value.trim();
    const subject = document.getElementById("pgSubject").value.trim();
    const body = document.getElementById("pgBody").value;
    if (!to || !subject || !body) { alert("宛先・件名・本文を入力してください"); return; }
    e.target.disabled = true;
    try {
      await ctx.sendMail({ to, subject, body, caseId: ctx.caseId });
      await updateDoc(doc(ctx.db, "cases", ctx.caseId), {
        preGuideMailedAt: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
        preGuideMailedTo: to,
        updatedAt: serverTimestamp(),
      });
      const c2 = ctx.getCase(); if (c2) c2.preGuideMailedAt = new Date().toISOString();
      ctx.toast("事前準備のご案内を送信しました");
      close();
      render();
    } catch (err) {
      alert(`送信に失敗しました: ${err.message || err}`);
      e.target.disabled = false;
    }
  });
}

export function initPreGuideCard(options) {
  ctx = options;
  const pre = document.getElementById("tab-pre");
  if (!pre) return;
  let host = document.getElementById("preGuideCard");
  if (!host) {
    host = document.createElement("div");
    host.id = "preGuideCard";
    pre.insertBefore(host, pre.firstChild);
  }
  render();
}
