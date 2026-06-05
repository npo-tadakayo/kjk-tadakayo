import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, orderBy, onSnapshot,
  addDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let products = [];
let me = null;       // { email, partnerName, partnerId }
let unsubHistory = null;

function $(id){ return document.getElementById(id); }
function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function show(view){
  ["loginView","denyView","appView"].forEach(v=>{ $(v).style.display = v===view ? "flex" : "none"; });
  document.body.classList.toggle("po-app", view==="appView"); // モバイルヘッダーは appView 時のみ表示
}
function toast(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}
function fmt(ts){ if(!ts) return "—"; const d=ts.toDate?ts.toDate():new Date(ts); return d.toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}

const STATUS_LABELS = { received:"受付済", confirmed:"受注確定", shipped:"出荷済", canceled:"キャンセル" };

async function loadProducts(){
  const snap = await getDoc(doc(db,"products","cir415a-01")); // 存在確認用（ルールread:auth）
  // 全商品取得
  const { getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const all = await getDocs(collection(db,"products"));
  products = all.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>a.id.localeCompare(b.id));
}

function renderItemInputs(){
  $("orderItems").innerHTML = `<table style="width:100%"><thead><tr>
    <th style="text-align:left;font-size:12px;color:var(--color-ink-muted)">商品</th>
    <th style="text-align:left;font-size:12px;color:var(--color-ink-muted)">接続</th>
    <th style="width:90px;font-size:12px;color:var(--color-ink-muted)">数量</th></tr></thead>
    <tbody>${products.map(p=>`<tr>
      <td style="font-size:13px">${esc(p.name)}</td>
      <td style="font-size:12px;color:var(--color-ink-muted)">${esc(p.connection||"")}</td>
      <td><input class="form-control qty" type="number" min="0" value="0" data-sku="${p.id}" data-name="${esc(p.name)}" style="padding:4px 8px"></td>
    </tr>`).join("")}</tbody></table>`;
}

function collectItems(){
  const items=[];
  document.querySelectorAll("#orderItems .qty").forEach(inp=>{
    const q=parseInt(inp.value,10)||0; if(q>0) items.push({sku:inp.dataset.sku,name:inp.dataset.name,qty:q});
  });
  return items;
}

async function submitOrder(){
  const office=$("poOffice").value.trim();
  const items=collectItems();
  const err=$("poError"); err.style.display="none";
  if(!office){ err.textContent="送付先の事業所名を入力してください"; err.style.display="block"; return; }
  if(!items.length){ err.textContent="商品の数量を1台以上入力してください"; err.style.display="block"; return; }

  const btn=$("submitOrderBtn"); btn.disabled=true;
  const st=$("poStatus"); st.style.color="var(--color-ink-muted)"; st.innerHTML='<i class="ti ti-loader-2 ti-spin"></i> 送信中...';
  try{
    await addDoc(collection(db,"partnerOrders"),{
      partnerEmail: me.email, partnerName: me.partnerName||"", partnerId: me.partnerId||"",
      items,
      shipping:{
        company:$("poCompany").value.trim(), officeName:office,
        postal:$("poPostal").value.trim(), address:$("poAddress").value.trim(),
        contactName:$("poContact").value.trim(), phone:$("poPhone").value.trim(),
      },
      desiredDeliveryDate:$("poDelivery").value||"",
      subsidyCategory:$("poSubsidy").value||"",
      note:$("poNote").value.trim(),
      status:"received", createdAt:serverTimestamp(),
    });
    st.style.color="var(--color-success)"; st.innerHTML='<i class="ti ti-circle-check"></i> 発注を受け付けました。タダカヨより追ってご連絡します。';
    ["poCompany","poOffice","poPostal","poAddress","poContact","poPhone","poDelivery","poNote"].forEach(id=>$(id).value="");
    $("poSubsidy").value=""; renderItemInputs();
    toast("発注を送信しました");
  }catch(e){
    st.style.color="var(--color-danger)"; st.textContent=`送信に失敗しました: ${e.message}`;
  }finally{ btn.disabled=false; }
}

function renderHistory(orders){
  const body=$("historyBody"); $("historyEmpty").style.display = orders.length?"none":"block";
  body.innerHTML = orders.map(o=>{
    const sum=(o.items||[]).map(i=>`${i.name.replace(/介護情報基盤 汎用カードリーダ /,"")}×${i.qty}`).join("<br>");
    return `<tr>
      <td>${fmt(o.createdAt)}</td>
      <td>${esc(o.shipping?.officeName||"")}</td>
      <td style="font-size:12px">${sum}</td>
      <td><span class="badge badge-${o.status==="shipped"?3:o.status==="canceled"?4:2}">${STATUS_LABELS[o.status]||o.status}</span></td>
    </tr>`;
  }).join("");
}

function startApp(){
  show("appView");
  const mt=document.querySelector(".mh-title"); if(mt) mt.textContent="認定事業所ポータル"; // モバイルヘッダーのタイトル
  $("partnerInfo").textContent = `${me.partnerName||""}（${me.email}）`;
  renderItemInputs();
  $("submitOrderBtn").addEventListener("click", submitOrder);
  // 自分の発注履歴（partnerEmail一致のみルールで許可）
  const q = query(collection(db,"partnerOrders"), where("partnerEmail","==",me.email), orderBy("createdAt","desc"));
  if(unsubHistory) unsubHistory();
  unsubHistory = onSnapshot(q,(snap)=>renderHistory(snap.docs.map(d=>({_id:d.id,...d.data()}))),
    (e)=>console.warn("history error",e.message));
}

$("loginBtn").addEventListener("click", async ()=>{
  $("loginError").style.display="none";
  try{ await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch(e){ $("loginError").textContent=`ログインに失敗しました: ${e.message}`; $("loginError").style.display="block"; }
});
$("logoutBtn").addEventListener("click", ()=>signOut(auth));
$("denyLogout").addEventListener("click", ()=>signOut(auth));

onAuthStateChanged(auth, async (user)=>{
  if(!user){ show("loginView"); return; }
  // 許可リスト確認（partners/{email}）
  try{
    const psnap = await getDoc(doc(db,"partners",user.email));
    if(!psnap.exists() || psnap.data().active!==true){
      $("denyEmail").textContent=user.email; show("denyView"); return;
    }
    const p=psnap.data();
    me={ email:user.email, partnerName:p.partnerName||p.name||"", partnerId:p.partnerId||"" };
    await loadProducts();
    startApp();
  }catch(e){
    $("denyEmail").textContent=user.email + `（${e.message}）`; show("denyView");
  }
});
