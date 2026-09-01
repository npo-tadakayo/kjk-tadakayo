// 伴走支援承諾書 公開署名ページ（consent.html）
//
// ・ログイン不要。URLの ?t={トークン} が鍵（トークン＝consentRequests のドキュメントID・128bit乱数）
// ・Firestore ルール側で「get のみ・list 不可／署名は pending のときに signed と status だけ」
//   に絞ってある（firestore.rules の consentRequests を参照）
// ・表示する条文は依頼発行時に焼き込まれた全文（document フィールド）。
//   壊れていたら現行版で代替せず、エラーにする（承諾していない文面に署名させない）

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { parseEmbeddedDocument } from "/js/consent-document.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const token = new URLSearchParams(location.search).get("t") || "";

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

function showNotFound() {
  $("loading").style.display = "none";
  $("notfound").style.display = "flex";
}

function fmtDate(v) {
  try {
    const d = v?.toDate ? v.toDate() : new Date(v);
    return d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
}

// 条文部分（署名前・署名後で共通）
function documentHtml(docu, data) {
  return `
    <div class="org"><span class="name">NPO法人タダカヨ</span><span class="biz">介護情報基盤伴走支援事業</span></div>
    <h1>${esc(docu.title)}</h1>
    <div class="h1-rule"></div>

    <div class="addressee">
      <div class="to">${esc(data.officeName || "")}　御中</div>
      ${data.company ? `<div class="sub">${esc(data.company)}</div>` : ""}
      <div class="sub">文書番号: ${esc(data.displayNo || "")}　／　条文の版: ${esc(docu.version)}</div>
    </div>

    <p class="preamble">${esc(docu.preamble)}</p>

    ${docu.sections.map((s) => `
      <section class="sec">
        <h2>${esc(s.title)}</h2>
        <p>${esc(s.body)}</p>
      </section>`).join("")}

    ${docu.terms_url || docu.privacy_url ? `<p class="terms">
      ${docu.terms_url ? `利用規約: <a href="${esc(docu.terms_url)}" target="_blank" rel="noopener">${esc(docu.terms_url)}</a>` : ""}
      ${docu.privacy_url ? `<br>プライバシーポリシー: <a href="${esc(docu.privacy_url)}" target="_blank" rel="noopener">${esc(docu.privacy_url)}</a>` : ""}
    </p>` : ""}
  `;
}

function renderPending(data, docu) {
  $("main").innerHTML = `
    ${documentHtml(docu, data)}

    <div class="consent-box no-print">
      <div class="lead">承諾のご署名</div>
      <p class="statement">${esc(docu.consent_statement)}</p>

      <label class="field" for="signerName">確認者のお名前（フルネーム）<span style="color:var(--red)">＊</span></label>
      <input type="text" id="signerName" autocomplete="name" placeholder="例）介護 太郎"
             value="${esc(data.contactName || "")}">

      <label class="agree" for="agreeCheck">
        <input type="checkbox" id="agreeCheck">
        <span>上記の内容を確認し、承諾します</span>
      </label>

      <button class="primary" id="signBtn" disabled>承諾して署名する</button>
      <div class="err" id="signErr" role="alert"></div>
    </div>

    <p class="issuer">${esc(docu.issuer)}${docu.issuer_detail ? `<br>${esc(docu.issuer_detail)}` : ""}</p>
  `;

  const name = $("signerName"), agree = $("agreeCheck"), btn = $("signBtn"), err = $("signErr");
  const refresh = () => { btn.disabled = !(name.value.trim().length > 0 && agree.checked); };
  name.addEventListener("input", refresh);
  agree.addEventListener("change", refresh);

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "署名を記録しています…";
    err.style.display = "none";
    try {
      await updateDoc(doc(db, "consentRequests", token), {
        status: "signed",
        signed: {
          name: name.value.trim().slice(0, 100),
          signedAt: serverTimestamp(),
          method: "web",
          userAgent: String(navigator.userAgent || "").slice(0, 200),
        },
      });
      const snap = await getDoc(doc(db, "consentRequests", token));
      renderSigned(snap.data(), docu, true);
      window.scrollTo({ top: 0 });
    } catch (e) {
      // すでに署名済み（他の端末で先に署名した等）なら読み直して署名済み画面へ
      try {
        const snap = await getDoc(doc(db, "consentRequests", token));
        if (snap.exists() && snap.data().status === "signed") {
          renderSigned(snap.data(), docu, false);
          return;
        }
      } catch { /* 下のエラー表示に落とす */ }
      err.textContent = "署名を記録できませんでした。通信環境をご確認のうえ、もう一度お試しください。";
      err.style.display = "block";
      btn.textContent = "承諾して署名する";
      btn.disabled = false;
    }
  });
}

function renderSigned(data, docu, justNow) {
  const s = data.signed || {};
  $("main").innerHTML = `
    <div class="donecard">
      <div class="mark">${CHECK_SVG}</div>
      <div class="t">${justNow ? "ご署名ありがとうございました" : "この承諾書は署名済みです"}</div>
      <div class="d">署名の内容は下記のとおり記録されています。このページは同じアドレスでいつでも開けます。</div>
      <div class="signrow">
        <span>確認者　<b>${esc(s.name || "")}</b></span>
        <span>署名日　<b>${esc(fmtDate(s.signedAt))}</b></span>
      </div>
      <div class="done-actions no-print">
        <button class="ghost" onclick="window.print()">この承諾書を印刷 / PDF保存</button>
      </div>
      <p class="keepnote no-print">控えが必要な場合は、印刷またはPDF保存のうえ保管してください。</p>
    </div>

    ${documentHtml(docu, data)}

    <div class="consent-box" style="border-style:solid">
      <div class="lead">承諾文</div>
      <p class="statement" style="margin-bottom:12px">${esc(docu.consent_statement)}</p>
      <div class="signrow" style="border-top:none;padding-top:0;justify-content:flex-start">
        <span>確認者　<b>${esc(s.name || "")}</b></span>
        <span>署名日　<b>${esc(fmtDate(s.signedAt))}</b></span>
        <span style="color:var(--muted);font-size:12.5px">（オンライン署名・条文の版 ${esc(docu.version)}）</span>
      </div>
    </div>

    <p class="issuer">${esc(docu.issuer)}${docu.issuer_detail ? `<br>${esc(docu.issuer_detail)}` : ""}</p>
  `;
}

(async () => {
  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) { showNotFound(); return; }
  let snap;
  try {
    snap = await getDoc(doc(db, "consentRequests", token));
  } catch { showNotFound(); return; }
  if (!snap.exists()) { showNotFound(); return; }

  const data = snap.data();
  const docu = parseEmbeddedDocument(data.document);
  if (!docu || data.status === "canceled") { showNotFound(); return; }

  $("loading").style.display = "none";
  $("main").style.display = "block";
  document.title = `${docu.title} — NPO法人タダカヨ`;

  if (data.status === "signed") renderSigned(data, docu, false);
  else renderPending(data, docu);
})();
