import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const NAV = [
  ["/dashboard.html","ti-chart-bar","ダッシュボード"],
  ["/cases.html","ti-layout-list","案件一覧"],
  ["/kanban.html","ti-layout-kanban","カンバン"],
  ["/supply.html","ti-package","供給管理"],
  ["/simulator.html","ti-calculator","売上シミュレーター"],
  ["/partner-admin.html","ti-certificate","認定事業所"],
  ["/settings.html","ti-settings","設定"],
  ["/users.html","ti-users","ユーザー管理"],
];
function renderNav(){
  const path = location.pathname;
  const el = document.getElementById("nav");
  if(!el) return;
  el.innerHTML = NAV.map(([h,i,l])=>`<a class="nav-item" href="${h}"><i class="ti ${i}" aria-hidden="true"></i>${l}</a>`).join("")
    + `<div style="height:1px;background:var(--color-line);margin:8px 12px"></div>`
    + `<a class="nav-item ${path.includes("manual")?"active":""}" href="/manual.html"><i class="ti ti-book-2" aria-hidden="true"></i>マニュアル</a>`
    + `<a class="nav-item ${path.includes("engineering")?"active":""}" href="/engineering.html"><i class="ti ti-notebook" aria-hidden="true"></i>エンジニアノート</a>`;
}

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user))) return;
  renderNav();
  const ue = document.getElementById("userEmail"); if(ue) ue.textContent = user.displayName || user.email;
  const lo = document.getElementById("logoutBtn"); if(lo) lo.addEventListener("click", ()=>signOut(auth).then(()=>location.href="/index.html"));
  const gate = document.getElementById("gate"); if(gate) gate.style.display="none";
  const doc = document.getElementById("doc"); if(doc) doc.style.display="block";
  // Mermaid（図がある場合のみ）
  if(document.querySelector(".mermaid")){
    try{
      const m = (await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")).default;
      m.initialize({ startOnLoad:true, theme:"neutral", securityLevel:"loose" });
      await m.run({ querySelector:".mermaid" });
    }catch(e){ console.warn("mermaid init failed", e); }
  }
});
