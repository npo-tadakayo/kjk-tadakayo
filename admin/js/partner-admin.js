import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { agreementHTML, briefingHTML } from "/js/partner-doc.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function toast(m){ const t=$("toast"); t.textContent=m; t.style.display="block"; clearTimeout(t._t); t._t=setTimeout(()=>t.style.display="none",2500); }

let partners = [];      // [{email, ...}]
let appSettings = {};
let editingEmail = null;
let currentDoc = null;  // {type, p, filename}

function badge(active){
  return active===false
    ? `<span style="background:#f3f4f6;color:#6b7280;border-radius:999px;padding:2px 9px;font-size:12px">停止</span>`
    : `<span style="background:#e8f5ec;color:#2a7a3b;border-radius:999px;padding:2px 9px;font-size:12px">認定中</span>`;
}
function render(){
  const rows = $("rows");
  $("emptyState").style.display = partners.length ? "none" : "block";
  rows.innerHTML = partners.map(p=>`<tr>
    <td><div style="font-weight:600">${esc(p.company||p.partnerName||"（法人名未設定）")}</div>${p.office?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(p.office)}</div>`:""}</td>
    <td>${esc(p.contact||"")}</td>
    <td style="font-size:12px">${esc(p.email)}</td>
    <td>${badge(p.active)}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-ghost doc-a" data-email="${esc(p.email)}" type="button" style="font-size:12px;padding:5px 10px"><i class="ti ti-file-certificate"></i> 協定書</button>
      <button class="btn btn-ghost doc-b" data-email="${esc(p.email)}" type="button" style="font-size:12px;padding:5px 10px"><i class="ti ti-presentation"></i> 説明資料</button>
    </td>
    <td><button class="btn btn-secondary edit" data-email="${esc(p.email)}" type="button" style="font-size:12px;padding:5px 10px"><i class="ti ti-edit"></i> 編集</button></td>
  </tr>`).join("");
  rows.querySelectorAll(".edit").forEach(b=>b.addEventListener("click",()=>openEdit(b.dataset.email)));
  rows.querySelectorAll(".doc-a").forEach(b=>b.addEventListener("click",()=>openDoc("agreement",b.dataset.email)));
  rows.querySelectorAll(".doc-b").forEach(b=>b.addEventListener("click",()=>openDoc("briefing",b.dataset.email)));
}

function openEdit(email){
  const p = email ? partners.find(x=>x.email===email) : null;
  editingEmail = email || null;
  $("editTitle").textContent = email ? "認定事業所の編集" : "認定事業所の登録";
  $("fEmail").value = p?.email || ""; $("fEmail").readOnly = !!email;
  $("fCompany").value = p?.company || p?.partnerName || "";
  $("fOffice").value = p?.office || "";
  $("fRep").value = p?.rep || "";
  $("fContact").value = p?.contact || "";
  $("fPostal").value = p?.postal || "";
  $("fPhone").value = p?.phone || "";
  $("fAddress").value = p?.address || "";
  $("fPartnerId").value = p?.partnerId || "";
  $("fActive").value = (p?.active===false) ? "false" : "true";
  $("editErr").textContent = "";
  $("editModal").classList.add("open");
}
function closeEdit(){ $("editModal").classList.remove("open"); }

async function saveEdit(user){
  const email = $("fEmail").value.trim().toLowerCase();
  const company = $("fCompany").value.trim();
  if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ $("editErr").textContent="正しいメールアドレスを入力してください"; return; }
  if(!company){ $("editErr").textContent="法人名を入力してください"; return; }
  const data = {
    email, company, partnerName: company,
    office:$("fOffice").value.trim(), rep:$("fRep").value.trim(), contact:$("fContact").value.trim(),
    postal:$("fPostal").value.trim(), phone:$("fPhone").value.trim(), address:$("fAddress").value.trim(),
    partnerId:$("fPartnerId").value.trim(), active: $("fActive").value!=="false",
    updatedAt: serverTimestamp(), updatedBy: user.email,
  };
  try{
    await setDoc(doc(db,"partners",email), data, { merge:true });
    toast("保存しました");
    closeEdit();
    await loadPartners();
  }catch(e){ $("editErr").textContent = "保存に失敗: "+e.message; }
}

function openDoc(type, email){
  const p = partners.find(x=>x.email===email); if(!p) return;
  const html = type==="agreement" ? agreementHTML(p, appSettings) : briefingHTML(p, appSettings);
  const label = type==="agreement" ? "協定書" : "説明資料";
  $("docTitle").textContent = `${label} — ${p.company||p.partnerName||p.email}`;
  $("docPreview").innerHTML = html;
  const safe = (p.company||p.partnerName||"認定事業所").replace(/[\\/:*?"<>|\s]/g,"_");
  currentDoc = { filename: `${label}_${safe}.pdf` };
  $("docModal").classList.add("open");
}
function closeDoc(){ $("docModal").classList.remove("open"); $("docPreview").innerHTML=""; }

function downloadPdf(){
  if(!window.html2pdf){ toast("PDFライブラリの読み込み待ちです。数秒後に再度お試しください"); return; }
  const el = $("docPreview").querySelector(".doc") || $("docPreview");
  const opt = {
    margin:[8,8,10,8], filename: currentDoc?.filename || "document.pdf",
    image:{ type:"jpeg", quality:0.96 },
    html2canvas:{ scale:2, useCORS:true, backgroundColor:"#ffffff" },
    jsPDF:{ unit:"mm", format:"a4", orientation:"portrait" },
    pagebreak:{ mode:["css","legacy"] },
  };
  toast("PDFを生成しています...");
  window.html2pdf().set(opt).from(el).save();
}

async function loadPartners(){
  const snap = await getDocs(collection(db,"partners"));
  partners = snap.docs.map(d=>({ email:d.id, ...d.data() }))
    .sort((a,b)=>(a.company||a.partnerName||"").localeCompare(b.company||b.partnerName||"","ja"));
  render();
}

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user,{adminOnly:true}))) return;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", ()=>signOut(auth).then(()=>location.href="/index.html"));
  try{ const ss=await getDoc(doc(db,"appConfig","settings")); appSettings = ss.exists()?ss.data():{}; }catch(_){}
  $("newBtn").addEventListener("click", ()=>openEdit(null));
  $("editClose").addEventListener("click", closeEdit);
  $("editCancel").addEventListener("click", closeEdit);
  $("editSave").addEventListener("click", ()=>saveEdit(user));
  $("docClose").addEventListener("click", closeDoc);
  $("docCloseBtn").addEventListener("click", closeDoc);
  $("docPdf").addEventListener("click", downloadPdf);
  await loadPartners();
  $("loadingEl").style.display="none";
  $("listCard").style.display="block";
});
