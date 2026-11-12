// レターパックの宛名印刷（2026-10-19 CRM改修 #4b）
// 出荷指示の投稿のURL（/letterpack-print.html?id={出荷ID}）から開き、届け先をプレビューしてそのまま A4 に印刷する。
//   ・ライト＝青／プラス＝赤 をページ上で切り替える。選んだ種類は shipments.letterPackType に保存し、次に開いても同じ
//   ・依頼主は 設定の差出人（settings.senders → sender*）→ 請求書の発行者情報 → 既定（NPO法人タダカヨ）の順に使う
//   ・出荷元の保管場所に「宛名ラベルのご依頼主」があれば、それを選択肢の先頭（既定）にする（2026-11-01）。
//     出荷元が無い古い出荷は既定の保管場所、直送（AB Circle から直接）は保管場所を通らないので使わない
//   ・@tadakayo.jp でログインした職員だけ（supply-print.js と同じ認証ガード）
//   ・出荷データには利用者・被保険者の情報は無い。載せるのは事業所側の宛名だけ
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, isViewer } from "/js/role.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, updateDoc, serverTimestamp } from "/js/fs.js";
import { renderLabel, fitLabel as fitLabelEl, labelTypeOf } from "/js/letterpack-label.js";
import { locationSender, defaultLocationIdOf } from "/js/warehouse-rules.js";

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
  phone: "050-8894-9502",
};

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


// 宛名枠に収まるか（お届け先・ご依頼主を縮めて収める。収まらなければ false）。中身は letterpack-label.js
function fitLabel(){ return fitLabelEl(document.querySelector(".label")); }

// 出荷元の保管場所（直送は null。出荷元が未設定の古い出荷は既定の保管場所＝supply.js の shipLocationOf と同じ）
function originLocationOf(s, locations){
  if (!s || s.fulfillment === "direct") return null;
  const id = s.originLocationId || defaultLocationIdOf(locations);
  return (locations || []).find((l) => l.id === id) || null;
}
// ご依頼主の選択肢: 保管場所のご依頼主（あれば先頭）＋ 設定の差出人（sendersOf）。読めない・未設定なら従来どおり
function labelSendersOf(st, location){
  const base = sendersOf(st);
  const ls = locationSender(location);
  if (!ls) return base;
  return [{ name: ls.name, postal: ls.postalCode, address: ls.address, phone: ls.phone, fromLocation: location.name || "保管場所" }, ...base];
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
    let loc = null;
    try {
      const ls = await getDocs(collection(db, "locations"));
      loc = originLocationOf(s, ls.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (_) {} // 読めなければ設定の差出人だけ（従来どおり）
    const senders = labelSendersOf(st, loc);
    const sel = document.getElementById("senderSel");
    sel.innerHTML = senders.map((x, i) => `<option value="${i}">${esc(x.name || "(無名)")}${x.fromLocation ? `（出荷元: ${esc(x.fromLocation)}）` : ""}</option>`).join("");
    if (senders.length > 1) document.getElementById("senderWrap").style.display = "inline-flex";

    // 戻り先は出荷一覧の該当行（?so= の深いリンク）
    if (s.soNumber) document.getElementById("backBtn").href = `/supply.html?tab=shipments&so=${encodeURIComponent(s.soNumber)}`;
    document.title = `宛名 ${s.soNumber || ""} — タダカヨ CRM`;

    let labelFits = true;
    let type = labelTypeOf(s); // 未設定はプラス（赤）・2026-10-21。種別がゆうパックならゆうパック（2026-11-12）
    const draw = () => {
      setTheme(type);
      document.getElementById("body").innerHTML = renderLabel(s, senders[Number(sel.value) || 0], type);
      labelFits = fitLabel();
      const warn = document.getElementById("warnBox");
      const miss = [!s.postal && "郵便番号", !s.address && "住所", !s.phone && "電話"].filter(Boolean);
      const msgs = [];
      if (!type) msgs.push("レターパックの種類（ライト／プラス）を上で選んでください。選ぶと色が変わり、この出荷に保存されます。");
      if (!labelFits) msgs.push("宛名（住所・法人名・事業所名）が長く、宛名枠（縦14.5cm×横12.5cm）に収まりません。このまま印刷すると品名・台数が切れます。出荷の「送付先・数量を直す」で短くしてください。");
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
      if (!labelFits && !confirm("宛名が宛名枠に収まらず、品名・台数が切れます。このまま印刷しますか？")) return;
      window.print();
    });
  } catch (e) {
    loading.textContent = `読み込み失敗: ${e.message}`;
  }
});
