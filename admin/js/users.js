import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, query, onSnapshot, setDoc, deleteDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { gateRole } from "/js/role.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function $(id){ return document.getElementById(id); }
function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function toast(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}
const ROLE_LABEL={admin:"管理者",staff:"スタッフ",viewer:"閲覧のみ"};
const ROLE_BADGE={admin:9,staff:2,viewer:4};

let usersCache=[], myEmail="", editing=null;

function render(list){
  usersCache=list;
  $("usersEmpty").style.display = list.length?"none":"block";
  $("usersBody").innerHTML = list.map(u=>`
    <tr>
      <td><strong>${esc(u.name||"")}</strong>${u._id===myEmail?' <span style="font-size:11px;color:var(--color-primary)">(あなた)</span>':""}</td>
      <td style="font-size:12px">${esc(u._id)}</td>
      <td><span class="badge badge-${ROLE_BADGE[u.role]||2}">${ROLE_LABEL[u.role]||u.role||"—"}</span></td>
      <td>${u.active!==false?'<span class="badge badge-3">有効</span>':'<span class="badge badge-4">停止</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary edit-u" data-email="${esc(u._id)}" style="font-size:12px;padding:4px 8px"><i class="ti ti-edit"></i>編集</button>
        <button class="btn btn-danger del-u" data-email="${esc(u._id)}" data-name="${esc(u.name||u._id)}" style="font-size:12px;padding:4px 8px" ${u._id===myEmail?"disabled title='自分は削除できません'":""}><i class="ti ti-trash"></i></button>
      </td>
    </tr>`).join("");
  document.querySelectorAll(".edit-u").forEach(b=>b.addEventListener("click",()=>{
    const u=usersCache.find(x=>x._id===b.dataset.email); if(u) openModal(u);
  }));
  document.querySelectorAll(".del-u").forEach(b=>b.addEventListener("click",async()=>{
    if(b.dataset.email===myEmail){ alert("自分自身は削除できません"); return; }
    if(!confirm(`「${b.dataset.name}」を削除します。このユーザーはログインできなくなります。よろしいですか？`)) return;
    await deleteDoc(doc(db,"users",b.dataset.email)); toast("削除しました");
  }));
}

function openModal(u){
  u=u||{}; editing=u._id||null;
  $("userModalTitle").textContent = editing?"ユーザーを編集":"ユーザーを追加";
  $("uEmail").value=u._id||""; $("uEmail").disabled=!!editing;
  $("uName").value=u.name||"";
  $("uRole").value=u.role||"staff";
  $("uActive").value=(u.active!==false)?"true":"false";
  $("uError").style.display="none";
  $("userModal").classList.add("open");
}
async function save(){
  const email=$("uEmail").value.trim().toLowerCase();
  const name=$("uName").value.trim();
  const role=$("uRole").value;
  const active=$("uActive").value==="true";
  const err=$("uError"); err.style.display="none";
  if(!/^[^\s@]+@tadakayo\.jp$/.test(email)){ err.textContent="@tadakayo.jp のメールアドレスを入力してください"; err.style.display="block"; return; }
  if(!name){ err.textContent="氏名を入力してください"; err.style.display="block"; return; }
  if(!editing && usersCache.some(u=>u._id===email)){ err.textContent="このユーザーは既に登録されています"; err.style.display="block"; return; }
  // 自分自身を停止/降格して締め出すのを防ぐ
  if(email===myEmail && (!active || role!=="admin")){
    if(!confirm("自分自身の権限を変更します。管理者でなくなる/停止すると、この画面に入れなくなる可能性があります。続けますか？")) return;
  }
  const data={ email, name, role, active, updatedAt:serverTimestamp() };
  if(!editing){ data.createdAt=serverTimestamp(); }
  await setDoc(doc(db,"users",email), data, {merge:true});
  $("userModal").classList.remove("open");
  toast(`${name} を保存しました`);
}

const NAV=[["/dashboard.html","ti-chart-bar","ダッシュボード"],["/cases.html","ti-layout-list","案件一覧"],
  ["/kanban.html","ti-layout-kanban","カンバン"],["/supply.html","ti-package","供給管理"],
  ["/simulator.html","ti-calculator","売上シミュレーター"],
  ["/partner-admin.html","ti-certificate","認定事業所"],
  ["/pricing.html","ti-coin","料金・送料"],
  ["/settings.html","ti-settings","設定"],["/users.html","ti-users","ユーザー管理"]];
function renderNav(){
  $("nav").innerHTML = NAV.map(([h,i,l])=>`<a class="nav-item ${h==="/users.html"?"active":""}" href="${h}"><i class="ti ${i}" aria-hidden="true"></i>${l}</a>`).join("")
    + `<div style="height:1px;background:var(--color-line);margin:8px 12px"></div>`
    + `<a class="nav-item" href="/manual.html"><i class="ti ti-book-2" aria-hidden="true"></i>マニュアル</a>`
    + `<a class="nav-item" href="/engineering.html"><i class="ti ti-notebook" aria-hidden="true"></i>エンジニアノート</a>`;
}

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db, user, {adminOnly:true}))) return;
  myEmail=user.email;
  renderNav();
  $("userEmail").textContent=user.displayName||user.email;
  $("logoutBtn").addEventListener("click",()=>signOut(auth).then(()=>location.href="/index.html"));
  $("newUserBtn").addEventListener("click",()=>openModal(null));
  $("closeUserBtn").addEventListener("click",()=>$("userModal").classList.remove("open"));
  $("cancelUserBtn").addEventListener("click",()=>$("userModal").classList.remove("open"));
  $("saveUserBtn").addEventListener("click",save);
  $("gate").style.display="none"; $("main").style.display="block";
  onSnapshot(query(collection(db,"users")),(snap)=>{
    render(snap.docs.map(d=>({_id:d.id,...d.data()})).sort((a,b)=>(a.role==="admin"?-1:0)-(b.role==="admin"?-1:0)));
  });
});
