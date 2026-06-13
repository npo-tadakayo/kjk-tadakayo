import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id)=>document.getElementById(id);
const yen = (n)=>"¥"+Math.round(Number(n)||0).toLocaleString("ja-JP");
function toast(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}

// 商品（認定事業所 卸価格・確定値）税別・数量帯: 1台 / 2〜10台 / 11〜30台 / 31台〜
// 卸は「パススルーではない」（2026-06-13 次田 確定）。タダカヨは AB Circle 仕入(products.wholesale)と
// この卸価格の差益を一定確保する（卸益 概ね BT¥480 / USB¥510）。納品台数で卸価格が変わるテーブル。
// 正本: 介護情報基盤伴走支援/04_認定基準/カードリーダー価格表・送料規定.md §2 / モデル料金表・利益シミュレーション.md
const PRODUCTS = [
  ["cir415a-01","CIR415A-01（BT）",[8000,8000,7530,7530]],
  ["cir315a-02","CIR315A-02（USB Type-A）",[4000,4000,3510,3460]],
  ["cir315a-04","CIR315A-04（USB Type-C）",[4000,4000,3670,3610]],
];
const TIER_KEYS = ["1台","2〜10台","11〜30台","31台〜"];
const REGIONS_DEF = ["近畿","北陸・東海・中国","関東・信越・四国・九州","東北","北海道","沖縄"];
const SIZES = ["60","80","100","120","140","160","170"];
const YU_DEF = {
  "60":[820,920,1020,1120,1520,1360], "80":[1130,1240,1350,1470,1930,1760],
  "100":[1450,1570,1700,1810,2330,2170], "120":[1770,1900,2040,2170,2750,2570],
  "140":[2040,2210,2360,2500,3120,3000], "160":[2290,2470,2630,2800,3460,3410],
  "170":[2620,2810,2980,3170,3860,3880],
};

function renderWhole(pricing){
  $("wholeRows").innerHTML = PRODUCTS.map(([sku,label,def])=>{
    const v = (pricing && pricing[sku]) || def;
    return `<tr><td>${label}</td>` + [0,1,2,3].map(i=>
      `<td><input class="form-control price-num" id="wp_${sku}_${i}" type="number" value="${Number(v[i]??def[i])}"></td>`).join("") + `</tr>`;
  }).join("");
}
function setStandard(){ PRODUCTS.forEach(([sku,,def])=>def.forEach((val,i)=>{ const el=$(`wp_${sku}_${i}`); if(el) el.value=val; })); toast("確定値をセットしました（保存で確定）"); }

function renderYu(table){
  const regions = (table && Array.isArray(table.regions) && table.regions.length===6) ? table.regions : REGIONS_DEF;
  const rows = (table && table.rows) || YU_DEF;
  $("yuHead").innerHTML = `<th>サイズ</th>` + regions.map((r,ri)=>`<th><input class="form-control yu-region" data-ri="${ri}" value="${String(r).replace(/"/g,'&quot;')}" style="width:120px;font-size:12px"></th>`).join("");
  $("yuRows").innerHTML = SIZES.map(sz=>{
    const rv = rows[sz] || YU_DEF[sz];
    return `<tr><td>${sz}サイズ</td>` + regions.map((_,ri)=>`<td><input class="yu-num form-control" id="yu_${sz}_${ri}" type="number" value="${Number(rv[ri]??YU_DEF[sz][ri])}"></td>`).join("") + `</tr>`;
  }).join("");
  // calc selects
  $("yuSize").innerHTML = SIZES.map(s=>`<option value="${s}">${s}サイズ</option>`).join("");
  $("yuRegion").innerHTML = regions.map((r,ri)=>`<option value="${ri}">${String(r)}</option>`).join("");
  $("yuRows").querySelectorAll(".yu-num").forEach(i=>i.addEventListener("input",calcYu));
  $("yuHead").querySelectorAll(".yu-region").forEach(i=>i.addEventListener("input",()=>{ const ri=i.dataset.ri; const opt=$("yuRegion").querySelector(`option[value="${ri}"]`); if(opt) opt.textContent=i.value; }));
  calcYu();
}
function calcYu(){ const sz=$("yuSize").value, ri=$("yuRegion").value; const el=$(`yu_${sz}_${ri}`); $("yuOut").textContent = yen(el?el.value:0); }

function calcLp(){
  const fee=Number($("lpFee").value)||0, qty=Math.max(1,Number($("lpQty").value)||1);
  const tsu=Math.ceil(qty/3);
  $("lpOut").textContent=yen(tsu*fee);
  $("lpDetail").textContent=`（${tsu}通 × ${yen(fee)}）`;
}

async function save(user){
  const partnerPricing={};
  PRODUCTS.forEach(([sku])=>{ partnerPricing[sku]=[0,1,2,3].map(i=>Number($(`wp_${sku}_${i}`).value)||0); });
  const regions = Array.from($("yuHead").querySelectorAll(".yu-region")).map(i=>i.value.trim());
  const rows={}; SIZES.forEach(sz=>{ rows[sz]=regions.map((_,ri)=>Number($(`yu_${sz}_${ri}`).value)||0); });
  const st=$("saveStatus");
  try{
    await setDoc(doc(db,"appConfig","settings"),{
      partnerPricing, letterpackFee:Number($("lpFee").value)||0,
      yupackTable:{ regions, sizes:SIZES, rows, origin:"滋賀県" },
      pricingUpdatedAt: serverTimestamp(), pricingUpdatedBy: user.email,
    },{merge:true});
    st.style.color="var(--color-success)"; st.textContent="保存しました（反映まで最大60秒）"; toast("料金・送料を保存しました");
  }catch(e){ st.style.color="var(--color-danger)"; st.textContent="保存に失敗: "+e.message; }
}

onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user,{adminOnly:true}))) return;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", ()=>signOut(auth).then(()=>location.href="/index.html"));
  let s={}; try{ const ss=await getDoc(doc(db,"appConfig","settings")); s=ss.exists()?ss.data():{}; }catch(_){}
  renderWhole(s.partnerPricing);
  if(typeof s.letterpackFee==="number") $("lpFee").value=s.letterpackFee;
  renderYu(s.yupackTable);
  $("setStdBtn").addEventListener("click", setStandard);
  ["lpFee","lpQty"].forEach(id=>$(id).addEventListener("input", calcLp));
  ["yuSize","yuRegion"].forEach(id=>$(id).addEventListener("change", calcYu));
  $("saveBtn").addEventListener("click", ()=>save(user));
  calcLp();
  $("loadingEl").style.display="none";
  $("app").style.display="block";
});
