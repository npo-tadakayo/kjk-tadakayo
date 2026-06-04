import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");

function $(id){ return document.getElementById(id); }
function toast(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}

const NAV = [
  ["/dashboard.html","ti-chart-bar","ダッシュボード"],
  ["/cases.html","ti-layout-list","案件一覧"],
  ["/kanban.html","ti-layout-kanban","カンバン"],
  ["/supply.html","ti-package","供給管理"],
  ["/settings.html","ti-settings","設定"],
];
function renderNav(active){
  $("nav").innerHTML = NAV.map(([h,i,l])=>`<a class="nav-item ${h===active?"active":""}" href="${h}"><i class="ti ${i}" aria-hidden="true"></i>${l}</a>`).join("")
    + `<div style="height:1px;background:var(--color-line);margin:8px 12px"></div>`
    + `<a class="nav-item" href="/manual.html"><i class="ti ti-book-2" aria-hidden="true"></i>マニュアル</a>`
    + `<a class="nav-item" href="/engineering.html"><i class="ti ti-notebook" aria-hidden="true"></i>エンジニアノート</a>`;
}

function escAttr(s){ return String(s||"").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
function addSenderRow(d){
  const wrap=document.createElement("div");
  wrap.className="sender-row";
  wrap.style.cssText="border:1px solid var(--color-line);border-radius:8px;padding:10px 12px;margin-bottom:8px";
  wrap.innerHTML=`
    <div style="display:flex;gap:8px;align-items:flex-end">
      <div class="form-group" style="flex:1;margin:0"><label class="form-label">差出人名</label><input class="form-control s-name" type="text" value="${escAttr(d.name)}" placeholder="NPO法人タダカヨ 介護情報基盤伴走支援事業"></div>
      <button class="btn btn-danger s-del" type="button" style="font-size:12px;padding:6px 10px"><i class="ti ti-trash" aria-hidden="true"></i></button>
    </div>
    <div class="form-row" style="margin-top:8px">
      <div class="form-group" style="margin:0"><label class="form-label">郵便番号</label><input class="form-control s-postal" type="text" value="${escAttr(d.postal)}" placeholder="000-0000"></div>
      <div class="form-group" style="margin:0"><label class="form-label">電話番号</label><input class="form-control s-phone" type="text" value="${escAttr(d.phone)}"></div>
    </div>
    <div class="form-group" style="margin:8px 0 0"><label class="form-label">住所</label><input class="form-control s-address" type="text" value="${escAttr(d.address)}"></div>`;
  wrap.querySelector(".s-del").addEventListener("click",()=>wrap.remove());
  $("sendersList").appendChild(wrap);
}
function renderSenders(list){ $("sendersList").innerHTML=""; (list.length?list:[{}]).forEach(addSenderRow); }
function collectSenders(){
  return Array.from(document.querySelectorAll("#sendersList .sender-row")).map(r=>({
    name:r.querySelector(".s-name").value.trim(),
    postal:r.querySelector(".s-postal").value.trim(),
    phone:r.querySelector(".s-phone").value.trim(),
    address:r.querySelector(".s-address").value.trim(),
  })).filter(s=>s.name||s.address||s.postal||s.phone);
}

const testFn = httpsCallable(functions, "testChatNotify");

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  renderNav("/settings.html");
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", ()=>signOut(auth).then(()=>location.href="/index.html"));

  const snap = await getDoc(doc(db,"appConfig","settings"));
  const s = snap.exists() ? snap.data() : {};
  $("chatWebhookUrl").value = s.chatWebhookUrl || "";
  $("gmailSender").value = s.gmailSender || "kjk-staff@tadakayo.jp";
  // 差出人リスト（旧単一値があれば移行）
  let senders = Array.isArray(s.senders) ? s.senders.slice() : [];
  if (!senders.length && s.senderName) senders = [{ name:s.senderName, postal:s.senderPostal||"", address:s.senderAddress||"", phone:s.senderPhone||"" }];
  renderSenders(senders);
  $("addSenderBtn").addEventListener("click", ()=>{ addSenderRow({}); });
  // 発注書（発行元・発注者）
  $("poIssuerName").value = s.poIssuerName || "";
  $("poIssuerAddr").value = s.poIssuerAddr || "";
  $("poIssuerRep").value = s.poIssuerRep || "";
  $("poOrdererName").value = s.poOrdererName || "";
  $("poSealText").value = s.poSealText || "";
  $("invoiceIssuerName").value = s.invoiceIssuerName || "";
  $("invoiceRegNo").value = s.invoiceRegNo || "";
  $("loadingEl").style.display = "none";
  $("form").style.display = "block";

  $("saveBtn").addEventListener("click", async ()=>{
    const st=$("saveStatus");
    try{
      await setDoc(doc(db,"appConfig","settings"),{
        chatWebhookUrl: $("chatWebhookUrl").value.trim(),
        gmailSender: $("gmailSender").value.trim(),
        senders: collectSenders(),
        poIssuerName: $("poIssuerName").value.trim(),
        poIssuerAddr: $("poIssuerAddr").value.trim(),
        poIssuerRep: $("poIssuerRep").value.trim(),
        poOrdererName: $("poOrdererName").value.trim(),
        poSealText: $("poSealText").value.trim(),
        invoiceIssuerName: $("invoiceIssuerName").value.trim(),
        invoiceRegNo: $("invoiceRegNo").value.trim(),
        updatedAt: serverTimestamp(), updatedBy: user.email,
      },{merge:true});
      st.style.color="var(--color-success)"; st.textContent="保存しました（反映まで最大60秒）";
      toast("設定を保存しました");
    }catch(e){ st.style.color="var(--color-danger)"; st.textContent=`保存に失敗: ${e.message}`; }
  });

  $("testBtn").addEventListener("click", async ()=>{
    const st=$("saveStatus"); st.style.color="var(--color-ink-muted)"; st.innerHTML='<i class="ti ti-loader-2 ti-spin"></i> 送信中...';
    try{ await testFn({}); st.style.color="var(--color-success)"; st.textContent="Chatにテスト通知を送信しました（保存済みURLへ）"; }
    catch(e){ st.style.color="var(--color-danger)"; st.textContent=`テスト失敗: ${e.message}`; }
  });
});
