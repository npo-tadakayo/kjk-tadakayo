import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
function $(id){ return document.getElementById(id); }
function yen(n){ return "¥" + Math.round(n||0).toLocaleString("ja-JP"); }
function toast(m){ const t=$("toast"); t.textContent=m; t.style.display="block"; clearTimeout(t._t); t._t=setTimeout(()=>t.style.display="none",2500); }

// 定価（税込・固定）
const LIST_BT = 14500, LIST_USB = 6500;
// 区分とカードリーダー組み合わせ（[ラベル, BT台数, USB台数]）
const GROUPS = [
  { key:"houmon", label:"訪問・通所・短期滞在系（上限¥64,000・最大3台）", cap:64000, combos:[
    ["USB×1",0,1],["BT×1",1,0],["USB×2",0,2],["BT×1+USB×1",1,1],["USB×3",0,3],["BT×2",2,0],["BT×1+USB×2",1,2],["BT×2+USB×1",2,1],["BT×3",3,0] ]},
  { key:"kyojyu", label:"居住・入所系（上限¥55,000・最大2台）", cap:55000, combos:[
    ["USB×1",0,1],["BT×1",1,0],["USB×2",0,2],["BT×1+USB×1",1,1],["BT×2",2,0] ]},
  { key:"other", label:"その他（上限¥42,000・最大1台）", cap:42000, combos:[
    ["USB×1",0,1],["BT×1",1,0] ]},
];
const DONATIONS = [3000,4000,5000];
let donation = 5000;

function rowId(gk,i){ return `${gk}_${i}`; }

function renderDonSeg(){
  $("donSeg").innerHTML = DONATIONS.map(d=>`<button class="seg ${d===donation?"active":""}" data-d="${d}" type="button">¥${d.toLocaleString("ja-JP")}</button>`).join("");
  $("donSeg").querySelectorAll(".seg").forEach(b=>b.addEventListener("click",()=>{ donation=Number(b.dataset.d); renderDonSeg(); compute(); }));
}

function renderRows(){
  let html = "";
  for(const g of GROUPS){
    html += `<tr class="sim-grp"><td colspan="6">${g.label}</td></tr>`;
    g.combos.forEach((c,i)=>{
      const id = rowId(g.key,i);
      html += `<tr data-cap="${g.cap}" data-bt="${c[1]}" data-usb="${c[2]}">
        <td>${c[0]}</td>
        <td><input class="form-control sim-num cnt" id="cnt_${id}" type="number" min="0" value="0"></td>
        <td class="rCR">¥0</td><td class="rBan">¥0</td><td class="rPer">¥0</td><td class="rYear">¥0</td>
      </tr>`;
    });
  }
  $("rows").innerHTML = html;
  $("rows").querySelectorAll(".cnt").forEach(inp=>inp.addEventListener("input", compute));
}

function compute(){
  const costBT = Number($("costBT").value)||0;
  const costUSB = Number($("costUSB").value)||0;
  const reward = Number($("reward").value)||0;
  let count=0, crSalesT=0, banSalesT=0, salesT=0, crCostT=0, baseProfit=0; // baseProfit = 寄付抜き
  $("rows").querySelectorAll("tr[data-cap]").forEach(tr=>{
    const cap=Number(tr.dataset.cap), nBT=Number(tr.dataset.bt), nUSB=Number(tr.dataset.usb);
    const q=Number(tr.querySelector(".cnt").value)||0;
    const crSales = nBT*LIST_BT + nUSB*LIST_USB;       // 税込
    const banSales = cap - crSales;                     // 税込
    const crCost = nBT*costBT + nUSB*costUSB;            // 税別
    const perBase = Math.round(cap/1.1) - crCost - reward; // 寄付抜き純利益/件（税別）
    const perProfit = perBase + donation;
    tr.querySelector(".rCR").textContent = yen(crSales);
    tr.querySelector(".rBan").textContent = yen(banSales);
    tr.querySelector(".rPer").textContent = yen(perProfit);
    tr.querySelector(".rYear").textContent = q?yen(perProfit*q):"–";
    count+=q; crSalesT+=crSales*q; banSalesT+=banSales*q; salesT+=cap*q; crCostT+=crCost*q; baseProfit+=perBase*q;
  });
  const rewardT = reward*count, donT = donation*count, profitT = baseProfit + donT;
  $("kCount").textContent = count.toLocaleString("ja-JP")+" 件";
  $("kCR").textContent = yen(crSalesT);
  $("kBan").textContent = yen(banSalesT);
  $("kSales").textContent = yen(salesT);
  $("kProfit").textContent = yen(profitT);
  // 内訳バー（売上合計を基準にスケール）
  const max = Math.max(salesT,1);
  const bars=[
    ["カードリーダー売上", crSalesT, "var(--app-color,#238e3a)"],
    ["伴走支援売上", banSalesT, "#3a6e9e"],
    ["（−）カードリーダー仕入", crCostT, "#c87a1f"],
    ["（−）会員報酬", rewardT, "#b84a4a"],
    ["（＋）寄付収入", donT, "#5a8a3a"],
    ["＝ タダカヨ純利益", profitT, "#6b3a8a"],
  ];
  $("bars").innerHTML = bars.map(([l,v,c])=>`<div class="bar-row"><div>${l}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,v/max*100)}%;background:${c}"></div></div><div style="text-align:right;font-weight:600">${yen(v)}</div></div>`).join("");
  // 寄付3パターン比較
  $("donCompare").innerHTML = DONATIONS.map(d=>{
    const p = baseProfit + d*count;
    return `<div class="box"><div class="lbl">寄付 ¥${d.toLocaleString("ja-JP")}/件 のとき純利益(年)</div><div class="val" style="color:var(--app-color,#238e3a)">${yen(p)}</div><div class="lbl" style="margin-top:2px">寄付収入計 ${yen(d*count)}</div></div>`;
  }).join("");
}

async function save(user){
  const counts={};
  $("rows").querySelectorAll("tr[data-cap]").forEach((tr)=>{ const inp=tr.querySelector(".cnt"); counts[inp.id.replace("cnt_","")] = Number(inp.value)||0; });
  try{
    await setDoc(doc(db,"appConfig","simulator"),{
      counts, donation,
      costBT:Number($("costBT").value)||0, costUSB:Number($("costUSB").value)||0, reward:Number($("reward").value)||0,
      updatedAt: serverTimestamp(), updatedBy: user.email,
    },{merge:true});
    toast("件数を保存しました");
  }catch(e){ toast("保存に失敗: "+e.message); }
}

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user,{adminOnly:true}))) return;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", ()=>signOut(auth).then(()=>location.href="/index.html"));
  renderRows();
  // 保存済みデータの読み込み
  try{
    const snap = await getDoc(doc(db,"appConfig","simulator"));
    if(snap.exists()){
      const s=snap.data();
      if(typeof s.donation==="number" && DONATIONS.includes(s.donation)) donation=s.donation;
      if(s.costBT!=null) $("costBT").value=s.costBT;
      if(s.costUSB!=null) $("costUSB").value=s.costUSB;
      if(s.reward!=null) $("reward").value=s.reward;
      if(s.counts){ for(const [k,v] of Object.entries(s.counts)){ const inp=$("cnt_"+k); if(inp) inp.value=v; } }
    }
  }catch(_){}
  renderDonSeg();
  ["costBT","costUSB","reward"].forEach(id=>$(id).addEventListener("input", compute));
  $("saveBtn").addEventListener("click", ()=>save(user));
  compute();
  $("loadingEl").style.display="none";
  $("app").style.display="block";
});
