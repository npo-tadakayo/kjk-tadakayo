import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getProdFirestore, collection, doc, query, onSnapshot, setDoc, deleteDoc, serverTimestamp }
  from "/js/fs.js";
import { gateRole } from "/js/role.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// ユーザー（ロール）は練習モード中でも常に本番DBで管理する（2026-10-20 テストモード）
const db = getProdFirestore(app);

function $(id){ return document.getElementById(id); }
function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function toast(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}
// 練習生（trainee）＝練習モード固定・本番は読み書きとも不可（firestore.rules）。独り立ちしたら「スタッフ」に変える（2026-10-20）
const ROLE_LABEL={admin:"管理者",staff:"スタッフ",viewer:"閲覧のみ",trainee:"練習生",warehouse:"倉庫"};
const ROLE_BADGE={admin:9,staff:2,viewer:4,trainee:6,warehouse:5};

let usersCache=[], myEmail="", editing=null, locationsCache=[];
const locName=(id)=>(locationsCache.find(l=>l._id===id)||{}).name||id;

function render(list){
  usersCache=list;
  $("usersEmpty").style.display = list.length?"none":"block";
  $("usersBody").innerHTML = list.map(u=>`
    <tr>
      <td><strong>${esc(u.name||"")}</strong>${u._id===myEmail?' <span style="font-size:12px;color:var(--color-primary)">(あなた)</span>':""}</td>
      <td style="font-size:12px">${esc(u._id)}</td>
      <td><span class="badge badge-${ROLE_BADGE[u.role]||2}">${ROLE_LABEL[u.role]||u.role||"—"}</span>${u.role==="warehouse"?`<div style="font-size:12px;color:var(--color-ink-muted)">${(u.locationIds&&u.locationIds.length)?esc(u.locationIds.map(locName).join("・")):'<span style="color:var(--color-danger)">保管場所が未選択</span>'}</div>`:""}</td>
      <td>${u.active!==false?'<span class="badge badge-3">有効</span>':'<span class="badge badge-4">停止</span>'}</td>
      <td>${u.chatUserId?'<span class="badge badge-3">設定済</span>':'<span class="badge badge-4">未設定</span>'}</td>
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

// 倉庫ロールのときだけ、扱える保管場所のチェックを出す（有効な保管場所。すでに選んである停止中の場所も残す）
function renderLocationChecks(selected){
  const sel=new Set(selected);
  const list=locationsCache.filter(l=>l.active!==false||sel.has(l._id));
  $("uLocations").innerHTML = list.length
    ? list.map(l=>`<label style="display:flex;gap:6px;align-items:center;font-size:14px"><input type="checkbox" class="u-loc" value="${esc(l._id)}" ${sel.has(l._id)?"checked":""}>${esc(l.name||l._id)}${l.active===false?"（停止中）":""}</label>`).join("")
    : '<div style="font-size:13px;color:var(--color-ink-muted)">保管場所が登録されていません（在庫・発注の画面で追加できます）</div>';
}
function syncLocationsWrap(){ $("uLocationsWrap").style.display = $("uRole").value==="warehouse" ? "" : "none"; }
function openModal(u){
  u=u||{}; editing=u._id||null;
  $("userModalTitle").textContent = editing?"ユーザーを編集":"ユーザーを追加";
  $("uEmail").value=u._id||""; $("uEmail").disabled=!!editing;
  $("uName").value=u.name||"";
  $("uRole").value=u.role||"staff";
  $("uActive").value=(u.active!==false)?"true":"false";
  $("uChatId").value=u.chatUserId||"";
  renderLocationChecks(u.locationIds||[]);
  syncLocationsWrap();
  $("uError").style.display="none";
  $("userModal").classList.add("open");
}
async function save(){
  const email=$("uEmail").value.trim().toLowerCase();
  const name=$("uName").value.trim();
  const role=$("uRole").value;
  const active=$("uActive").value==="true";
  const chatUserId=$("uChatId").value.trim();
  const err=$("uError"); err.style.display="none";
  if(!/^[^\s@]+@tadakayo\.jp$/.test(email)){ err.textContent="@tadakayo.jp のメールアドレスを入力してください"; err.style.display="block"; return; }
  if(!name){ err.textContent="氏名を入力してください"; err.style.display="block"; return; }
  if(chatUserId && !/^\d{5,30}$/.test(chatUserId)){ err.textContent="Google Chat のユーザーIDは数字5〜30桁で入力してください（不明なら空欄）"; err.style.display="block"; return; }
  if(!editing && usersCache.some(u=>u._id===email)){ err.textContent="このユーザーは既に登録されています"; err.style.display="block"; return; }
  // 自分自身を停止/降格して締め出すのを防ぐ
  if(email===myEmail && (!active || role!=="admin")){
    if(!confirm("自分自身の権限を変更します。管理者でなくなる/停止すると、この画面に入れなくなる可能性があります。続けますか？")) return;
  }
  let locationIds=[];
  if(role==="warehouse"){
    locationIds=[...document.querySelectorAll(".u-loc:checked")].map(c=>c.value);
    if(!locationIds.length){ err.textContent="倉庫の人は、扱える保管場所を1つ以上選んでください"; err.style.display="block"; return; }
  }
  const data={ email, name, role, active, chatUserId, locationIds, updatedAt:serverTimestamp() };
  if(!editing){ data.createdAt=serverTimestamp(); }
  await setDoc(doc(db,"users",email), data, {merge:true});
  $("userModal").classList.remove("open");
  toast(`${name} を保存しました`);
}

// サイドメニューは sidebar.js（SSOT・非module）が #nav に描画する。ここでは扱わない。

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db, user, {adminOnly:true}))) return;
  myEmail=user.email;
  $("userEmail").textContent=user.displayName||user.email;
  $("logoutBtn").addEventListener("click",()=>signOut(auth).then(()=>location.href="/index.html"));
  $("newUserBtn").addEventListener("click",()=>openModal(null));
  $("closeUserBtn").addEventListener("click",()=>$("userModal").classList.remove("open"));
  $("cancelUserBtn").addEventListener("click",()=>$("userModal").classList.remove("open"));
  $("saveUserBtn").addEventListener("click",save);
  $("uRole").addEventListener("change",syncLocationsWrap);
  onSnapshot(query(collection(db,"locations")),(snap)=>{
    locationsCache=snap.docs.map(d=>({_id:d.id,...d.data()})).sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"ja"));
    render(usersCache); // 一覧の保管場所の名前を引き直す
  });
  $("gate").style.display="none"; $("main").style.display="block";
  onSnapshot(query(collection(db,"users")),(snap)=>{
    render(snap.docs.map(d=>({_id:d.id,...d.data()})).sort((a,b)=>(a.role==="admin"?-1:0)-(b.role==="admin"?-1:0)));
  });
});
