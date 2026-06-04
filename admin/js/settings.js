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
  $("senderName").value = s.senderName || "";
  $("senderPostal").value = s.senderPostal || "";
  $("senderPhone").value = s.senderPhone || "";
  $("senderAddress").value = s.senderAddress || "";
  $("loadingEl").style.display = "none";
  $("form").style.display = "block";

  $("saveBtn").addEventListener("click", async ()=>{
    const st=$("saveStatus");
    try{
      await setDoc(doc(db,"appConfig","settings"),{
        chatWebhookUrl: $("chatWebhookUrl").value.trim(),
        gmailSender: $("gmailSender").value.trim(),
        senderName: $("senderName").value.trim(),
        senderPostal: $("senderPostal").value.trim(),
        senderPhone: $("senderPhone").value.trim(),
        senderAddress: $("senderAddress").value.trim(),
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
