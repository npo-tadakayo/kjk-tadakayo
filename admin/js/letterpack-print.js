// レターパックの宛名印刷（2026-10-19 CRM改修 #4b）
// 出荷指示の投稿のURL（/letterpack-print.html?id={出荷ID}）から開き、届け先をプレビューしてそのまま A4 に印刷する。
//   ・ライト＝青／プラス＝赤 をページ上で切り替える。選んだ種類は shipments.letterPackType に保存し、次に開いても同じ
//   ・依頼主は 設定の差出人（settings.senders → sender*）→ 請求書の発行者情報 → 既定（NPO法人タダカヨ）の順に使う
//   ・@tadakayo.jp でログインした職員だけ（supply-print.js と同じ認証ガード）
//   ・出荷データには利用者・被保険者の情報は無い。載せるのは事業所側の宛名だけ
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, isViewer } from "/js/role.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, serverTimestamp } from "/js/fs.js";
import { letterPackOrDefault, shipQtySummary } from "/js/ship-flow.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const id = new URLSearchParams(location.search).get("id");

function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// 依頼主の既定（supply-print.js の PO_DEFAULT と同じ発行者。電話は振込の案内と同じ代表番号）
const SENDER_DEFAULT = {
  name: "NPO法人タダカヨ　介護情報基盤伴走支援事業",
  postal: "",
  address: "東京都大田区大森中二丁目1番20-1001号",
  phone: "050-6872-9884",
};
const TYPE_LABEL = { light: "レターパックライト", plus: "レターパックプラス" };

function sendersOf(st){
  st = st || {};
  let list = Array.isArray(st.senders) ? st.senders.filter((x)=>x && (x.name || x.address)) : [];
  if (!list.length && st.senderName) {
    list = [{ name: st.senderName, postal: st.senderPostal || "", address: st.senderAddress || "", phone: st.senderPhone || "" }];
  }
  if (!list.length) {
    list = [{
      name: st.invoiceIssuerName ? `${st.invoiceIssuerName}　介護情報基盤伴走支援事業` : SENDER_DEFAULT.name,
      postal: st.invoiceIssuerPostal || SENDER_DEFAULT.postal,
      address: st.invoiceIssuerAddress || SENDER_DEFAULT.address,
      phone: st.invoiceIssuerTel || SENDER_DEFAULT.phone,
    }];
  }
  return list;
}


export function renderLabel(s, sender, type){
  sender = sender || {};
  const q = shipQtySummary(s.items); // 台数は宛名枠と梱包の確認に大きく出す（2026-10-30）
  const head = TYPE_LABEL[type] || "レターパック（種類が未選択です）";
  const zip = s.postal ? `〒${esc(s.postal)}` : "〒";
  const person = String(s.contactName || "").trim();
  const fromZip = sender.postal ? `〒${esc(sender.postal)} ` : "";
  return `
    <div class="label">
      <div class="label-head"><span>${esc(head)}</span><small>宛名ラベル</small></div>
      <div class="to"><div class="to-grid"><div>
        <div class="sec">お届け先</div>
        <div class="zip">${zip}</div>
        <div class="addr">${esc(s.address || "")}</div>
        ${s.company ? `<div class="org">${esc(s.company)}</div>` : ""}
        ${s.officeName ? `<div class="org">${esc(s.officeName)}</div>` : ""}
        <div class="name">${person ? esc(person) : "ご担当者"}<span class="sama">様</span></div>
        <div class="tel">TEL ${esc(s.phone || "")}</div>
      </div>
      <div class="qtybox" aria-label="内容品と台数">
        <div class="qt-label">内容品・台数</div>
        <div class="qt-num" data-qty-total>${q.total}<small>台</small></div>
        <div class="qt-item">カードリーダー<br>${q.lines.map((l)=>`${esc(l.label)}${q.lines.length > 1 ? ` × ${l.qty}` : ""}`).join("<br>")}</div>
      </div></div></div>
      <div class="from">
        <div class="sec">ご依頼主</div>
        <div>${fromZip}${esc(sender.address || "")}</div>
        <div class="from-name">${esc(sender.name || "")}</div>
        ${sender.phone ? `<div>TEL ${esc(sender.phone)}</div>` : ""}
      </div>
      <div class="so"><span>出荷番号 <strong>${esc(s.soNumber || "")}</strong></span><span>品名: 介護情報基盤 マイナ資格確認 カードリーダー</span></div>
    </div>
    <div class="cut"><span>✂ 上の枠を切り取って、レターパックの宛名面に貼ってください</span></div>
    <div class="pack">
      <div class="pack-title">梱包の確認（貼らない）<span>出荷番号 ${esc(s.soNumber || "")}${s.shipDate ? ` ／ 出荷日 ${esc(s.shipDate)}` : ""}${s.originLocationName ? ` ／ 出荷元 ${esc(s.originLocationName)}` : ""}</span></div>
      <div class="pack-qty">
        <div class="big">${q.total}<small>台</small></div>
        <div class="what"><b>${esc(q.detail || "—")}</b><br>この台数だけ入れてください。ほかの出荷と取り違えないように注意。</div>
      </div>
      <ul class="checks">
        <li><span class="box" aria-hidden="true"></span>箱に入れた台数を数えた（<b>${q.total}台</b>）</li>
        <li><span class="box" aria-hidden="true"></span>品番が合っている（${esc(q.lines.map((l)=>l.label).join("・") || "—")}）</li>
        <li><span class="box" aria-hidden="true"></span>宛名の事業所名と出荷番号が、この紙と合っている</li>
        <li><span class="box" aria-hidden="true"></span>レターパックの種類が合っている（${esc(TYPE_LABEL[type] || "未選択")}）</li>
      </ul>
      <div class="sign"><div>確認した人：</div><div>日付：　　月　　日</div></div>
    </div>`;
}

function setTheme(type){
  document.body.classList.toggle("lp-light", type === "light");
  document.body.classList.toggle("lp-plus", type === "plus");
  document.getElementById("lpLight").checked = type === "light";
  document.getElementById("lpPlus").checked = type === "plus";
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  const role = await gateRole(db, user);
  if (!role) return;
  const loading = document.getElementById("loadingEl");
  if (!id) { loading.textContent = "出荷IDがありません（URLを確かめてください）"; return; }
  try {
    const snap = await getDoc(doc(db, "shipments", id));
    if (!snap.exists()) { loading.textContent = "出荷が見つかりません"; return; }
    const s = snap.data();
    let st = {};
    try { const ss = await getDoc(doc(db, "appConfig", "settings")); st = ss.exists() ? ss.data() : {}; } catch (_) {}
    const senders = sendersOf(st);
    const sel = document.getElementById("senderSel");
    sel.innerHTML = senders.map((x, i) => `<option value="${i}">${esc(x.name || "(無名)")}</option>`).join("");
    if (senders.length > 1) document.getElementById("senderWrap").style.display = "inline-flex";

    // 戻り先は出荷一覧の該当行（?so= の深いリンク）
    if (s.soNumber) document.getElementById("backBtn").href = `/supply.html?tab=shipments&so=${encodeURIComponent(s.soNumber)}`;
    document.title = `宛名 ${s.soNumber || ""} — タダカヨ CRM`;

    let type = letterPackOrDefault(s.letterPackType); // 未設定はプラス（赤）・2026-10-21
    const draw = () => {
      setTheme(type);
      document.getElementById("body").innerHTML = renderLabel(s, senders[Number(sel.value) || 0], type);
      const warn = document.getElementById("warnBox");
      const miss = [!s.postal && "郵便番号", !s.address && "住所", !s.phone && "電話"].filter(Boolean);
      const msgs = [];
      if (!type) msgs.push("レターパックの種類（ライト／プラス）を上で選んでください。選ぶと色が変わり、この出荷に保存されます。");
      if (miss.length) msgs.push(`届け先の${miss.join("・")}が入っていません。出荷の「送付先・数量を直す」で入れてから印刷してください。`);
      warn.innerHTML = msgs.map(esc).join("<br>");
      warn.style.display = msgs.length ? "block" : "none";
    };
    loading.style.display = "none";
    document.getElementById("body").style.display = "block";
    draw();
    sel.addEventListener("change", draw);

    const msg = document.getElementById("saveMsg");
    document.querySelectorAll('input[name="lpType"]').forEach((r) => r.addEventListener("change", async () => {
      if (!r.checked) return;
      type = r.value;
      draw();
      if (isViewer(role)) { msg.textContent = "閲覧のみのため保存していません"; return; }
      msg.textContent = "保存中…";
      try {
        await updateDoc(doc(db, "shipments", id), { letterPackType: type, updatedAt: serverTimestamp() });
        s.letterPackType = type;
        msg.textContent = "この出荷に保存しました";
      } catch (e) {
        msg.textContent = `保存できませんでした（${e.message}）`;
      }
    }));
    document.getElementById("printBtn").addEventListener("click", () => {
      if (!type && !confirm("レターパックの種類が未選択です。このまま印刷しますか？")) return;
      window.print();
    });
  } catch (e) {
    loading.textContent = `読み込み失敗: ${e.message}`;
  }
});
