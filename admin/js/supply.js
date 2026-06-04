import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, query, orderBy, onSnapshot,
  addDoc, updateDoc, setDoc, deleteDoc, runTransaction, serverTimestamp, increment }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let products = [];
let currentUser = null;

function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function yen(n){return "¥"+Number(n||0).toLocaleString("ja-JP");}
function today(){return new Date().toLocaleDateString("sv-SE");} // YYYY-MM-DD (local)
function fmtDate(ts){ if(!ts) return "—"; const d=ts.toDate?ts.toDate():new Date(ts); return d.toLocaleDateString("ja-JP",{year:"2-digit",month:"numeric",day:"numeric"});}
function toast(m){const t=document.getElementById("toast");t.textContent=m;t.style.display="block";clearTimeout(t._t);t._t=setTimeout(()=>t.style.display="none",2500);}

async function nextNumber(counterId, prefix){
  const ref = doc(db,"_counters",counterId);
  const n = await runTransaction(db, async (tx)=>{
    const s = await tx.get(ref); const v=(s.exists()?s.data().value:0)+1; tx.set(ref,{value:v}); return v;
  });
  return `${prefix}-2026-${String(n).padStart(4,"0")}`;
}

// ===== タブ =====
function initTabs(){
  document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(x=>x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById(`tab-${t.dataset.tab}`).classList.add("active");
  }));
}

// ===== 在庫・商品 =====
function renderProducts(){
  document.getElementById("productsBody").innerHTML = products.map(p=>`
    <tr>
      <td><strong>${esc(p.id)}</strong></td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.connection||"")}</td>
      <td>${yen(p.wholesale2_10)}</td>
      <td><strong style="font-size:16px">${p.stock||0}</strong> 台</td>
      <td>
        <button class="btn btn-secondary stock-btn" data-sku="${p.id}" data-dir="in" style="font-size:12px;padding:4px 8px">＋入庫</button>
        <button class="btn btn-secondary stock-btn" data-sku="${p.id}" data-dir="out" style="font-size:12px;padding:4px 8px">－出庫</button>
      </td>
    </tr>`).join("");
  document.querySelectorAll(".stock-btn").forEach(b=>b.addEventListener("click",()=>adjustStock(b.dataset.sku,b.dataset.dir)));
}

async function adjustStock(sku, dir){
  const p = products.find(x=>x.id===sku);
  const qStr = prompt(`${p.name}\n${dir==="in"?"入庫":"出庫"}する台数を入力してください`, "1");
  if(!qStr) return;
  const q = parseInt(qStr,10);
  if(!(q>0)){ alert("正の整数を入力してください"); return; }
  if(dir==="out" && (p.stock||0)<q){ alert(`在庫不足（現在 ${p.stock||0} 台）`); return; }
  const delta = dir==="in"? q : -q;
  await updateDoc(doc(db,"products",sku),{stock:increment(delta)});
  await addDoc(collection(db,"inventoryMovements"),{
    sku, delta, reason: dir==="in"?"manual_in":"manual_out",
    createdAt:serverTimestamp(), userName: currentUser.displayName||currentUser.email });
  toast(`${p.name} を ${dir==="in"?"+":"-"}${q}台 調整しました`);
}

// ===== 発注モーダル =====
function itemRows(containerId){
  document.getElementById(containerId).innerHTML = `
    <table style="width:100%;margin-bottom:10px"><thead><tr>
      <th style="text-align:left;font-size:12px;color:var(--color-ink-muted)">品番</th>
      <th style="text-align:left;font-size:12px;color:var(--color-ink-muted)">商品</th>
      <th style="width:90px;font-size:12px;color:var(--color-ink-muted)">数量</th></tr></thead>
    <tbody>${products.map(p=>`<tr>
      <td style="font-size:12px">${esc(p.id)}</td>
      <td style="font-size:12px">${esc(p.name)}</td>
      <td><input class="form-control qty-input" type="number" min="0" value="0" data-sku="${p.id}" style="padding:4px 8px"></td>
    </tr>`).join("")}</tbody></table>`;
}
function collectItems(kind){
  const items=[];
  document.querySelectorAll(`#${kind} .qty-input`).forEach(inp=>{
    const q=parseInt(inp.value,10)||0;
    if(q>0){ const p=products.find(x=>x.id===inp.dataset.sku);
      items.push({sku:p.id,name:p.name,qty:q,unitPrice:p.wholesale2_10||0}); }
  });
  return items;
}

function openOrder(){ itemRows("orderItems"); document.getElementById("orderDate").value=today();
  document.getElementById("orderNote").value=""; document.getElementById("orderTotal").textContent="";
  document.querySelectorAll("#orderItems .qty-input").forEach(i=>i.addEventListener("input",updateOrderTotal));
  document.getElementById("orderModal").classList.add("open"); }
function updateOrderTotal(){ const items=collectItems("orderItems");
  const total=items.reduce((s,i)=>s+i.qty*i.unitPrice,0);
  document.getElementById("orderTotal").textContent = items.length?`合計(税別): ${yen(total)}`:""; }
async function saveOrder(){
  const items=collectItems("orderItems");
  if(!items.length){ alert("数量を入力してください"); return; }
  const btn=document.getElementById("saveOrderBtn"); btn.disabled=true;
  try{
    const poNumber=await nextNumber("purchaseOrders","PO");
    const total=items.reduce((s,i)=>s+i.qty*i.unitPrice,0);
    await addDoc(collection(db,"purchaseOrders"),{
      poNumber, orderDate:document.getElementById("orderDate").value||today(),
      supplier:"AB Circle Japan 株式会社", items, total,
      status:"sent", note:document.getElementById("orderNote").value.trim(),
      createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email });
    document.getElementById("orderModal").classList.remove("open");
    toast(`発注 ${poNumber} を登録しました`);
  }catch(e){ alert(`登録失敗: ${e.message}`);} finally{ btn.disabled=false; }
}

function renderOrders(orders){
  const body=document.getElementById("ordersBody"); const empty=document.getElementById("ordersEmpty");
  empty.style.display = orders.length?"none":"block";
  body.innerHTML = orders.map(o=>{
    const summary=(o.items||[]).map(i=>`${i.sku}×${i.qty}`).join(", ");
    const statusLabel={sent:"発注済",received:"入荷済",draft:"下書き"}[o.status]||o.status;
    return `<tr>
      <td><strong>${esc(o.poNumber)}</strong></td>
      <td>${esc(o.orderDate||"")}</td>
      <td style="font-size:12px">${esc(summary)}</td>
      <td>${yen(o.total)}</td>
      <td><span class="badge badge-${o.status==="received"?3:2}">${statusLabel}</span></td>
      <td style="white-space:nowrap">
        <a class="btn btn-secondary" href="/supply-print.html?type=po&id=${o._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-text"></i>発注書</a>
        ${o.status!=="received"?`<button class="btn btn-secondary recv-btn" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-package-import"></i>入荷登録</button>`:""}
      </td></tr>`;
  }).join("");
  document.querySelectorAll(".recv-btn").forEach(b=>b.addEventListener("click",()=>receiveOrder(b.dataset.id,orders)));
}
async function receiveOrder(id, orders){
  const o=orders.find(x=>x._id===id);
  if(!confirm(`発注 ${o.poNumber} を入荷登録します。在庫に加算されます。よろしいですか？`)) return;
  try{
    for(const it of (o.items||[])){ await updateDoc(doc(db,"products",it.sku),{stock:increment(it.qty)});
      await addDoc(collection(db,"inventoryMovements"),{sku:it.sku,delta:it.qty,reason:"po_received",refNo:o.poNumber,createdAt:serverTimestamp(),userName:currentUser.displayName||currentUser.email}); }
    await updateDoc(doc(db,"purchaseOrders",id),{status:"received",receivedAt:serverTimestamp()});
    toast(`${o.poNumber} を入荷登録しました`);
  }catch(e){ alert(`入荷登録失敗: ${e.message}`);}
}

// ===== 出荷モーダル =====
let activePartners = [];
function openShip(){ itemRows("shipItems"); document.getElementById("shipDate").value=today();
  ["shipPostal","shipCompany","shipOffice","shipAddress","shipContact","shipPhone"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("shipStockWarn").style.display="none";
  document.getElementById("shipType").value="direct";
  // 請求先プルダウン（有効パートナー）
  document.getElementById("shipPartner").innerHTML = '<option value="">選択してください</option>'+
    activePartners.map(p=>`<option value="${esc(p._id)}">${esc(p.partnerName||p._id)}</option>`).join("");
  document.getElementById("shipPartnerWrap").style.display="none";
  document.getElementById("shipModal").classList.add("open"); }

async function saveShip(){
  const office=document.getElementById("shipOffice").value.trim();
  if(!office){ alert("事業所名を入力してください"); return; }
  const shipType=document.getElementById("shipType").value;
  const partnerEmail = shipType==="dropship" ? document.getElementById("shipPartner").value : "";
  if(shipType==="dropship" && !partnerEmail){ alert("直送の場合は請求先（認定事業所）を選択してください"); return; }
  const partnerName = (activePartners.find(p=>p._id===partnerEmail)||{}).partnerName||"";
  const items=collectItems("shipItems").map(it=>{
    const p=products.find(x=>x.id===it.sku)||{};
    return {...it, unitPrice: p.wholesale2_10||0}; // 卸価格(税別)をスナップショット
  });
  if(!items.length){ alert("数量を入力してください"); return; }
  for(const it of items){ const p=products.find(x=>x.id===it.sku);
    if((p.stock||0)<it.qty){ const w=document.getElementById("shipStockWarn");
      w.style.display="block"; w.textContent=`在庫不足: ${p.name}（在庫 ${p.stock||0} / 出荷 ${it.qty}）`; return; } }
  const btn=document.getElementById("saveShipBtn"); btn.disabled=true;
  try{
    const soNumber=await nextNumber("shipments","SH");
    await addDoc(collection(db,"shipments"),{
      soNumber, shipType, partnerEmail, partnerName,
      shipDate:document.getElementById("shipDate").value||today(),
      postal:document.getElementById("shipPostal").value.trim(),
      company:document.getElementById("shipCompany").value.trim(),
      officeName:office, address:document.getElementById("shipAddress").value.trim(),
      contactName:document.getElementById("shipContact").value.trim(),
      phone:document.getElementById("shipPhone").value.trim(),
      items, createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email });
    for(const it of items){ await updateDoc(doc(db,"products",it.sku),{stock:increment(-it.qty)});
      await addDoc(collection(db,"inventoryMovements"),{sku:it.sku,delta:-it.qty,reason:"shipment",refNo:soNumber,createdAt:serverTimestamp(),userName:currentUser.displayName||currentUser.email}); }
    document.getElementById("shipModal").classList.remove("open");
    toast(`出荷 ${soNumber} を登録しました（在庫から引落）`);
  }catch(e){ alert(`登録失敗: ${e.message}`);} finally{ btn.disabled=false; }
}

async function deleteShipment(s){
  if(!confirm(`出荷 ${s.soNumber}（${s.officeName}）を削除します。\n引き落とした在庫は元に戻します。よろしいですか？`)) return;
  try{
    for(const it of (s.items||[])){ await updateDoc(doc(db,"products",it.sku),{stock:increment(it.qty)});
      await addDoc(collection(db,"inventoryMovements"),{sku:it.sku,delta:it.qty,reason:"shipment_canceled",refNo:s.soNumber,createdAt:serverTimestamp(),userName:currentUser.displayName||currentUser.email}); }
    await deleteDoc(doc(db,"shipments",s._id));
    toast(`出荷 ${s.soNumber} を削除し、在庫を戻しました`);
  }catch(e){ alert(`削除失敗: ${e.message}`); }
}

function renderShipments(ships){
  const body=document.getElementById("shipBody"); const empty=document.getElementById("shipEmpty");
  empty.style.display = ships.length?"none":"block";
  body.innerHTML = ships.map(s=>{
    const summary=(s.items||[]).map(i=>`${i.sku}×${i.qty}`).join(", ");
    const typeBadge = s.shipType==="dropship"
      ? `<span class="badge badge-6">直送(認定)</span>` : `<span class="badge badge-2">直接</span>`;
    const invoiceBtn = s.shipType==="dropship"
      ? `<a class="btn btn-secondary" href="/supply-print.html?type=invoice&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-receipt"></i>請求書</a>` : "";
    return `<tr>
      <td><strong>${esc(s.soNumber)}</strong><div style="margin-top:2px">${typeBadge}</div></td>
      <td>${esc(s.shipDate||"")}</td>
      <td>${esc(s.officeName)}${s.company?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(s.company)}</div>`:""}${s.partnerName?`<div style="font-size:12px;color:var(--color-ink-muted)">請求: ${esc(s.partnerName)}</div>`:""}</td>
      <td style="font-size:12px">${esc(summary)}</td>
      <td style="white-space:nowrap">
        <a class="btn btn-secondary" href="/supply-print.html?type=ship&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-text"></i>送付状</a>
        <a class="btn btn-secondary" href="/supply-print.html?type=letterpack&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-fast"></i>宛名</a>
        ${invoiceBtn}
        <button class="btn btn-danger del-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-trash"></i></button>
      </td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".del-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) deleteShipment(s);
  }));
}

// ===== 受注（認定事業所から）=====
const PO_STATUS = { received:"受付済", confirmed:"受注確定", shipped:"出荷済", canceled:"キャンセル" };
function fmtDT(ts){ if(!ts) return "—"; const d=ts.toDate?ts.toDate():new Date(ts); return d.toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}
function renderPartnerOrders(orders){
  document.getElementById("poEmpty").style.display = orders.length?"none":"block";
  document.getElementById("poBody").innerHTML = orders.map(o=>{
    const sum=(o.items||[]).map(i=>`${i.sku||""}×${i.qty}`).join(", ");
    const sh=o.shipping||{};
    const opts=Object.entries(PO_STATUS).map(([k,v])=>`<option value="${k}" ${o.status===k?"selected":""}>${v}</option>`).join("");
    return `<tr>
      <td>${fmtDT(o.createdAt)}</td>
      <td>${esc(o.partnerName||o.partnerEmail||"")}</td>
      <td>${esc(sh.officeName||"")}${sh.company?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(sh.company)}</div>`:""}</td>
      <td style="font-size:12px">${esc(sum)}</td>
      <td><select class="form-control po-status" data-id="${o._id}" style="padding:4px 8px;font-size:12px">${opts}</select></td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".po-status").forEach(sel=>sel.addEventListener("change",async()=>{
    await updateDoc(doc(db,"partnerOrders",sel.dataset.id),{status:sel.value,updatedAt:serverTimestamp()});
    toast("受注ステータスを更新しました");
  }));
}

// ===== パートナー管理 =====
let partnersCache = [];
function renderPartners(partners){
  partnersCache = partners;
  document.getElementById("partnersEmpty").style.display = partners.length?"none":"block";
  document.getElementById("partnersBody").innerHTML = partners.map(p=>`
    <tr>
      <td><strong>${esc(p._id)}</strong></td>
      <td>${esc(p.partnerName||"")}</td>
      <td>${p.active?'<span class="badge badge-3">有効</span>':'<span class="badge badge-4">停止</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary toggle-partner" data-email="${esc(p._id)}" data-active="${p.active}" style="font-size:12px;padding:4px 8px">${p.active?"停止する":"有効化"}</button>
        <button class="btn btn-danger del-partner" data-email="${esc(p._id)}" data-name="${esc(p.partnerName||"")}" style="font-size:12px;padding:4px 8px"><i class="ti ti-trash" aria-hidden="true"></i>削除</button>
      </td>
    </tr>`).join("");
  document.querySelectorAll(".toggle-partner").forEach(b=>b.addEventListener("click",async()=>{
    await updateDoc(doc(db,"partners",b.dataset.email),{active: b.dataset.active!=="true"});
    toast("パートナー状態を更新しました");
  }));
  document.querySelectorAll(".del-partner").forEach(b=>b.addEventListener("click",async()=>{
    if(!confirm(`「${b.dataset.name||b.dataset.email}」を許可リストから完全に削除します。\nこのアカウントはポータルにログインできなくなります。よろしいですか？`)) return;
    await deleteDoc(doc(db,"partners",b.dataset.email));
    toast("パートナーを削除しました");
  }));
}
async function addPartner(){
  const email=document.getElementById("prEmail").value.trim().toLowerCase();
  const name=document.getElementById("prName").value.trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ alert("正しいメールアドレスを入力してください"); return; }
  if(!name){ alert("認定事業所名を入力してください"); return; }
  if(email.endsWith("@tadakayo.jp")){
    if(!confirm("@tadakayo.jp は職員（管理側）アカウントです。認定事業所ポータルのパートナーとして登録しますか？\n通常は認定事業所さま自身のGoogleアカウント（gmail等）を登録します。")) return;
  }
  if(partnersCache.some(p=>p._id===email)){ alert("このメールは既に登録されています"); return; }
  await setDoc(doc(db,"partners",email),{
    email, partnerName:name, active:true, createdAt:serverTimestamp(),
    createdBy: currentUser.displayName||currentUser.email });
  document.getElementById("prEmail").value=""; document.getElementById("prName").value="";
  toast(`${name} を許可リストに追加しました`);
}

// ===== 初期化 =====
onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  currentUser=user;
  document.getElementById("userEmail").textContent=user.displayName||user.email;
  document.getElementById("logoutBtn").addEventListener("click",()=>signOut(auth).then(()=>location.href="/index.html"));
  initTabs();

  document.getElementById("newOrderBtn").addEventListener("click",openOrder);
  document.getElementById("closeOrderBtn").addEventListener("click",()=>document.getElementById("orderModal").classList.remove("open"));
  document.getElementById("cancelOrderBtn").addEventListener("click",()=>document.getElementById("orderModal").classList.remove("open"));
  document.getElementById("saveOrderBtn").addEventListener("click",saveOrder);
  document.getElementById("newShipBtn").addEventListener("click",openShip);
  document.getElementById("closeShipBtn").addEventListener("click",()=>document.getElementById("shipModal").classList.remove("open"));
  document.getElementById("cancelShipBtn").addEventListener("click",()=>document.getElementById("shipModal").classList.remove("open"));
  document.getElementById("saveShipBtn").addEventListener("click",saveShip);
  document.getElementById("shipType").addEventListener("change",(e)=>{
    document.getElementById("shipPartnerWrap").style.display = e.target.value==="dropship"?"":"none";
  });

  // products（リアルタイム・在庫反映）
  onSnapshot(query(collection(db,"products")),(snap)=>{
    products=snap.docs.map(d=>({_id:d.id,id:d.id,...d.data()})).sort((a,b)=>a.id.localeCompare(b.id));
    renderProducts();
  });
  // 発注一覧
  onSnapshot(query(collection(db,"purchaseOrders"),orderBy("createdAt","desc")),(snap)=>{
    renderOrders(snap.docs.map(d=>({_id:d.id,...d.data()})));
  });
  // 出荷一覧
  onSnapshot(query(collection(db,"shipments"),orderBy("createdAt","desc")),(snap)=>{
    renderShipments(snap.docs.map(d=>({_id:d.id,...d.data()})));
  });
  // 受注（認定事業所から）
  onSnapshot(query(collection(db,"partnerOrders"),orderBy("createdAt","desc")),(snap)=>{
    renderPartnerOrders(snap.docs.map(d=>({_id:d.id,...d.data()})));
  });
  // パートナー名簿
  document.getElementById("addPartnerBtn").addEventListener("click",addPartner);
  onSnapshot(query(collection(db,"partners")),(snap)=>{
    const list=snap.docs.map(d=>({_id:d.id,...d.data()}));
    activePartners = list.filter(p=>p.active!==false);
    renderPartners(list);
  });
});
