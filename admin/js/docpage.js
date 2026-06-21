import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app); // gateRole(db,...) が users コレクションを参照するため必須（未定義だとアクセス拒否される）

// サイドメニューは sidebar.js（SSOT・非module）が #nav に描画する。ここでは扱わない。

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user))) return;
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
