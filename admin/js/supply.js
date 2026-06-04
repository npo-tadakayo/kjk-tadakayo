import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, orderBy, onSnapshot,
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

async function nextSeq(counterId){
  const ref = doc(db,"_counters",counterId);
  return await runTransaction(db, async (tx)=>{
    const s = await tx.get(ref); const v=(s.exists()?s.data().value:0)+1; tx.set(ref,{value:v}); return v;
  });
}
function seqFmt(prefix,n){ return `${prefix}-2026-${String(n).padStart(4,"0")}`; }

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
  ["orderNote","orderShipLabel","orderShipFee","orderShipTo"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("orderTotal").textContent="";
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
    const poNo=await nextSeq("purchaseOrders");
    const poNumber=seqFmt("PO",poNo);
    const total=items.reduce((s,i)=>s+i.qty*i.unitPrice,0);
    await addDoc(collection(db,"purchaseOrders"),{
      poNumber, poNo, orderDate:document.getElementById("orderDate").value||today(),
      supplier:"AB Circle Japan 株式会社", items, total,
      shippingLabel:document.getElementById("orderShipLabel").value.trim(),
      shippingFee:Number(document.getElementById("orderShipFee").value)||0,
      shipTo:document.getElementById("orderShipTo").value.trim(),
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
    // 直送(認定事業所)=卸価格 / 直接(事業所)=エンドユーザー定価 をスナップショット
    const unitPrice = shipType==="dropship" ? (p.wholesale2_10||0) : (p.listPrice||0);
    return {...it, unitPrice};
  });
  if(!items.length){ alert("数量を入力してください"); return; }
  for(const it of items){ const p=products.find(x=>x.id===it.sku);
    if((p.stock||0)<it.qty){ const w=document.getElementById("shipStockWarn");
      w.style.display="block"; w.textContent=`在庫不足: ${p.name}（在庫 ${p.stock||0} / 出荷 ${it.qty}）`; return; } }
  const btn=document.getElementById("saveShipBtn"); btn.disabled=true;
  try{
    const soNumber=seqFmt("SH",await nextSeq("shipments"));
    await addDoc(collection(db,"shipments"),{
      soNumber, shipType, partnerEmail, partnerName,
      status:"shipped",
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

// 案件（事業所の申し込み）→ 直接出荷フォームに取り込み
async function prefillShipFromCase(caseId){
  try{
    const cs=await getDoc(doc(db,"cases",caseId)); if(!cs.exists()){ alert("案件が見つかりません"); return; }
    const c=cs.data();
    let office={};
    if(c.officeId){ try{ const os=await getDoc(doc(db,"offices",c.officeId)); if(os.exists()) office=os.data(); }catch(_){} }
    const tab=document.querySelector('.tab[data-tab="shipments"]'); if(tab) tab.click();
    openShip();
    document.getElementById("shipType").value="direct";
    document.getElementById("shipPartnerWrap").style.display="none";
    document.getElementById("shipCompany").value = c.corpName||office.corpName||"";
    document.getElementById("shipOffice").value  = c.officeName||office.officeName||"";
    document.getElementById("shipPostal").value  = office.zip||office.postal||"";
    document.getElementById("shipAddress").value = c.address||office.address||"";
    document.getElementById("shipContact").value = c.contactName||"";
    document.getElementById("shipPhone").value   = c.contactPhone||office.phone||"";
    (c.cardReaders||[]).forEach(r=>{
      const qty=(Number(r.subsidyQty)||0)+(Number(r.extraQty)||0);
      const sku = r.type==="BT" ? "cir415a-01" : r.type==="USB" ? "cir315a-02" : null;
      if(sku && qty>0){ const inp=document.querySelector(`#shipItems .qty-input[data-sku="${sku}"]`); if(inp) inp.value=qty; }
    });
    toast("案件情報を取り込みました。数量・住所・USB品番をご確認ください");
  }catch(e){ alert(`取り込み失敗: ${e.message}`); }
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

const SHIP_STATUS = { shipped:"発送済", invoiced:"請求済", paid:"入金済", canceled:"キャンセル" };
const SHIP_STATUS_BADGE = { shipped:7, invoiced:9, paid:3, canceled:4 };
function shipTotal(s){ return (s.items||[]).reduce((a,i)=>a+(Number(i.unitPrice)||0)*(Number(i.qty)||0),0); }
function shipTotalIncl(s){ return Math.floor(shipTotal(s)*1.1); }

function renderShipments(ships){
  const body=document.getElementById("shipBody"); const empty=document.getElementById("shipEmpty");
  empty.style.display = ships.length?"none":"block";
  // サマリー（未請求 / 請求済・未入金 / 入金済）
  const active = ships.filter(s=>s.status!=="canceled");
  const unbilled = active.filter(s=>s.status==="shipped");
  const billed = active.filter(s=>s.status==="invoiced");
  const paid = active.filter(s=>s.status==="paid");
  const sumBox=document.getElementById("shipSummary");
  if(sumBox) sumBox.innerHTML = [
    `<div class="alert-chip warn"><i class="ti ti-package-export"></i><div><div class="alert-num">${unbilled.length}</div><div class="alert-label">未請求（発送済）</div></div></div>`,
    `<div class="alert-chip danger"><i class="ti ti-receipt"></i><div><div class="alert-num">${yen(billed.reduce((a,s)=>a+shipTotalIncl(s),0))}</div><div class="alert-label">請求済・未入金（税込）</div></div></div>`,
    `<div class="alert-chip info"><i class="ti ti-cash"></i><div><div class="alert-num">${yen(paid.reduce((a,s)=>a+(Number(s.paymentAmount)||shipTotalIncl(s)),0))}</div><div class="alert-label">入金済（税込）</div></div></div>`,
  ].join("");

  body.innerHTML = ships.map(s=>{
    const summary=(s.items||[]).map(i=>`${i.sku}×${i.qty}`).join(", ");
    const typeBadge = s.shipType==="dropship"
      ? `<span class="badge badge-6">直送(認定)</span>` : `<span class="badge badge-2">直接</span>`;
    const st=s.status||"shipped";
    const stBadge=`<span class="badge badge-${SHIP_STATUS_BADGE[st]||7}">${SHIP_STATUS[st]||st}</span>`;
    const billName = s.shipType==="dropship" ? (s.partnerName||"") : (s.company||s.officeName||"");
    let lifeBtns="";
    if(st==="shipped") lifeBtns=`<button class="btn btn-secondary mark-invoiced" data-id="${s._id}" style="font-size:12px;padding:4px 8px">請求済にする</button>`;
    else if(st==="invoiced") lifeBtns=`<button class="btn btn-primary mark-paid" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-cash"></i>入金記録</button>`;
    else if(st==="paid") lifeBtns=`<span style="font-size:12px;color:var(--color-success)">入金 ${esc(s.paidAt||"")}</span>`;
    return `<tr>
      <td><strong>${esc(s.soNumber)}</strong><div style="margin-top:2px">${typeBadge} ${stBadge}</div></td>
      <td>${esc(s.shipDate||"")}</td>
      <td>${esc(s.officeName)}${s.company?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(s.company)}</div>`:""}<div style="font-size:12px;color:var(--color-ink-muted)">請求先: ${esc(billName)}（${yen(shipTotalIncl(s))}）</div></td>
      <td style="font-size:12px">${esc(summary)}</td>
      <td style="white-space:nowrap">
        ${lifeBtns}
        <a class="btn btn-secondary" href="/supply-print.html?type=invoice&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-receipt"></i>請求書</a>
        <a class="btn btn-secondary" href="/supply-print.html?type=ship&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-text"></i>送付状</a>
        <a class="btn btn-secondary" href="/supply-print.html?type=letterpack&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-fast"></i>宛名</a>
        <button class="btn btn-danger del-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-trash"></i></button>
      </td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".del-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) deleteShipment(s);
  }));
  document.querySelectorAll(".mark-invoiced").forEach(b=>b.addEventListener("click",async()=>{
    await updateDoc(doc(db,"shipments",b.dataset.id),{status:"invoiced",invoicedAt:today(),updatedAt:serverTimestamp()});
    toast("請求済にしました");
  }));
  document.querySelectorAll(".mark-paid").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) recordPayment(s);
  }));
}

async function recordPayment(s){
  const def=shipTotalIncl(s);
  const amtStr=prompt(`入金額（税込）を入力してください\n${s.soNumber} / 請求先: ${s.shipType==="dropship"?s.partnerName:(s.company||s.officeName)}`, String(def));
  if(amtStr===null) return;
  const amt=parseInt(String(amtStr).replace(/[^0-9]/g,""),10);
  if(!(amt>=0)){ alert("金額を正しく入力してください"); return; }
  const dateStr=prompt("入金日（YYYY-MM-DD）", today());
  if(dateStr===null) return;
  await updateDoc(doc(db,"shipments",s._id),{status:"paid",paymentAmount:amt,paidAt:dateStr,updatedAt:serverTimestamp()});
  toast(`入金を記録しました（${yen(amt)}）`);
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
    const shipBtn = o.status==="shipped"
      ? `<span style="font-size:12px;color:var(--color-success)">出荷済</span>`
      : `<button class="btn btn-primary po-ship" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-truck-delivery"></i>出荷へ</button>`;
    return `<tr>
      <td>${fmtDT(o.createdAt)}</td>
      <td>${esc(o.partnerName||o.partnerEmail||"")}</td>
      <td>${esc(sh.officeName||"")}${sh.company?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(sh.company)}</div>`:""}</td>
      <td style="font-size:12px">${esc(sum)}</td>
      <td><select class="form-control po-status" data-id="${o._id}" style="padding:4px 8px;font-size:12px">${opts}</select></td>
      <td>${shipBtn}</td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".po-status").forEach(sel=>sel.addEventListener("change",async()=>{
    await updateDoc(doc(db,"partnerOrders",sel.dataset.id),{status:sel.value,updatedAt:serverTimestamp()});
    toast("受注ステータスを更新しました");
  }));
  document.querySelectorAll(".po-ship").forEach(b=>b.addEventListener("click",()=>{
    const o=orders.find(x=>x._id===b.dataset.id); if(o) shipFromOrder(o);
  }));
}

// 受注（認定事業所）→ 出荷（直送）へ変換
async function shipFromOrder(o){
  const sh=o.shipping||{};
  const items=(o.items||[]).map(it=>{
    const p=products.find(x=>x.id===it.sku)||{};
    return { sku:it.sku, name:it.name||p.name||it.sku, qty:Number(it.qty)||0, unitPrice:p.wholesale2_10||0 };
  }).filter(it=>it.qty>0);
  if(!items.length){ alert("発注内容が空です"); return; }
  for(const it of items){ const p=products.find(x=>x.id===it.sku);
    if(!p || (p.stock||0)<it.qty){ alert(`在庫不足: ${it.name}（在庫 ${p?p.stock||0:0} / 必要 ${it.qty}）。先に在庫を補充してください`); return; } }
  if(!confirm(`受注（${o.partnerName||o.partnerEmail}）を直送出荷として登録します。\n送付先: ${sh.officeName||""}\n在庫から引き落とします。よろしいですか？`)) return;
  try{
    const soNumber=seqFmt("SH",await nextSeq("shipments"));
    await addDoc(collection(db,"shipments"),{
      soNumber, shipType:"dropship", partnerEmail:o.partnerEmail||"", partnerName:o.partnerName||"",
      status:"shipped", partnerOrderId:o._id,
      shipDate:today(), postal:sh.postal||"", company:sh.company||"", officeName:sh.officeName||"",
      address:sh.address||"", contactName:sh.contactName||"", phone:sh.phone||"",
      items, createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email });
    for(const it of items){ await updateDoc(doc(db,"products",it.sku),{stock:increment(-it.qty)});
      await addDoc(collection(db,"inventoryMovements"),{sku:it.sku,delta:-it.qty,reason:"shipment",refNo:soNumber,createdAt:serverTimestamp(),userName:currentUser.displayName||currentUser.email}); }
    await updateDoc(doc(db,"partnerOrders",o._id),{status:"shipped",updatedAt:serverTimestamp()});
    toast(`受注を出荷登録しました（${soNumber}）`);
  }catch(e){ alert(`出荷登録失敗: ${e.message}`); }
}

// ===== パートナー管理 =====
let partnersCache = [];
function renderPartners(partners){
  partnersCache = partners;
  document.getElementById("partnersEmpty").style.display = partners.length?"none":"block";
  document.getElementById("partnersBody").innerHTML = partners.map(p=>{
    const addr=[p.postal?("〒"+p.postal):"",p.address||""].filter(Boolean).join(" ");
    const contacts=(p.contacts||[]).map(c=>esc(c.name||"")).filter(Boolean).join("、");
    return `<tr>
      <td><strong>${esc(p.partnerName||"")}</strong>${p.corpName?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(p.corpName)}</div>`:""}<div style="font-size:12px;color:var(--color-ink-muted)">${esc(p._id)}</div></td>
      <td style="font-size:12px">${esc(addr)||"—"}${p.phone?`<div>TEL ${esc(p.phone)}</div>`:""}${p.contactEmail?`<div>${esc(p.contactEmail)}</div>`:""}</td>
      <td style="font-size:12px">${contacts||"—"}</td>
      <td>${p.active!==false?'<span class="badge badge-3">有効</span>':'<span class="badge badge-4">停止</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary edit-partner" data-email="${esc(p._id)}" style="font-size:12px;padding:4px 8px"><i class="ti ti-edit"></i>編集</button>
        <a class="btn btn-secondary" href="/supply-print.html?type=plabel&pid=${encodeURIComponent(p._id)}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-fast"></i>宛名</a>
        <button class="btn btn-secondary toggle-partner" data-email="${esc(p._id)}" data-active="${p.active!==false}" style="font-size:12px;padding:4px 8px">${p.active!==false?"停止":"有効化"}</button>
        <button class="btn btn-danger del-partner" data-email="${esc(p._id)}" data-name="${esc(p.partnerName||"")}" style="font-size:12px;padding:4px 8px"><i class="ti ti-trash"></i></button>
      </td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".edit-partner").forEach(b=>b.addEventListener("click",()=>{
    const p=partnersCache.find(x=>x._id===b.dataset.email); if(p) openPartnerModal(p);
  }));
  document.querySelectorAll(".toggle-partner").forEach(b=>b.addEventListener("click",async()=>{
    await updateDoc(doc(db,"partners",b.dataset.email),{active: b.dataset.active!=="true"});
    toast("状態を更新しました");
  }));
  document.querySelectorAll(".del-partner").forEach(b=>b.addEventListener("click",async()=>{
    if(!confirm(`「${b.dataset.name||b.dataset.email}」を完全に削除します。ポータルにログインできなくなります。よろしいですか？`)) return;
    await deleteDoc(doc(db,"partners",b.dataset.email));
    toast("削除しました");
  }));
}

// 担当者行
function contactRow(c){
  c=c||{};
  const wrap=document.createElement("div");
  wrap.className="contact-row";
  wrap.style.cssText="display:flex;gap:6px;margin-bottom:6px;align-items:center";
  wrap.innerHTML=`
    <input class="form-control c-name" type="text" placeholder="氏名" value="${esc(c.name||'').replace(/"/g,'&quot;')}" style="flex:1;padding:5px 8px">
    <input class="form-control c-phone" type="text" placeholder="電話" value="${esc(c.phone||'').replace(/"/g,'&quot;')}" style="flex:1;padding:5px 8px">
    <input class="form-control c-email" type="text" placeholder="メール" value="${esc(c.email||'').replace(/"/g,'&quot;')}" style="flex:1;padding:5px 8px">
    <button class="btn btn-danger c-del" type="button" style="padding:5px 8px"><i class="ti ti-x"></i></button>`;
  wrap.querySelector(".c-del").addEventListener("click",()=>wrap.remove());
  document.getElementById("prContacts").appendChild(wrap);
}
let editingPartnerId=null;
function openPartnerModal(p){
  p=p||{};
  editingPartnerId = p._id || null;
  document.getElementById("partnerModalTitle").textContent = editingPartnerId?"認定事業所を編集":"認定事業所を追加";
  document.getElementById("prEmail").value = p._id||"";
  document.getElementById("prEmail").disabled = !!editingPartnerId; // メール=IDは編集不可
  document.getElementById("prName").value = p.partnerName||"";
  document.getElementById("prCorp").value = p.corpName||"";
  document.getElementById("prPostal").value = p.postal||"";
  document.getElementById("prPhone").value = p.phone||"";
  document.getElementById("prAddress").value = p.address||"";
  document.getElementById("prMail").value = p.contactEmail||"";
  document.getElementById("prContacts").innerHTML="";
  (p.contacts&&p.contacts.length?p.contacts:[{}]).forEach(contactRow);
  document.getElementById("prError").style.display="none";
  document.getElementById("partnerModal").classList.add("open");
}
async function savePartner(){
  const email=document.getElementById("prEmail").value.trim().toLowerCase();
  const name=document.getElementById("prName").value.trim();
  const err=document.getElementById("prError"); err.style.display="none";
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ err.textContent="正しいログインメールを入力してください"; err.style.display="block"; return; }
  if(!name){ err.textContent="認定事業所名を入力してください"; err.style.display="block"; return; }
  if(!editingPartnerId && partnersCache.some(p=>p._id===email)){ err.textContent="このメールは既に登録されています"; err.style.display="block"; return; }
  if(!editingPartnerId && email.endsWith("@tadakayo.jp") &&
     !confirm("@tadakayo.jp は職員アカウントです。認定事業所として登録しますか？")) return;
  const contacts=Array.from(document.querySelectorAll("#prContacts .contact-row")).map(r=>({
    name:r.querySelector(".c-name").value.trim(), phone:r.querySelector(".c-phone").value.trim(), email:r.querySelector(".c-email").value.trim(),
  })).filter(c=>c.name||c.phone||c.email);
  const data={
    email, partnerName:name,
    corpName:document.getElementById("prCorp").value.trim(),
    postal:document.getElementById("prPostal").value.trim(),
    address:document.getElementById("prAddress").value.trim(),
    phone:document.getElementById("prPhone").value.trim(),
    contactEmail:document.getElementById("prMail").value.trim(),
    contacts,
    updatedAt:serverTimestamp(),
  };
  if(!editingPartnerId){ data.active=true; data.createdAt=serverTimestamp(); data.createdBy=currentUser.displayName||currentUser.email; }
  await setDoc(doc(db,"partners",email), data, {merge:true});
  document.getElementById("partnerModal").classList.remove("open");
  toast(`${name} を保存しました`);
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
  let prefilled=false;
  const shipCaseId = new URLSearchParams(location.search).get("ship");
  onSnapshot(query(collection(db,"products")),(snap)=>{
    products=snap.docs.map(d=>({_id:d.id,id:d.id,...d.data()})).sort((a,b)=>a.id.localeCompare(b.id));
    renderProducts();
    if(shipCaseId && !prefilled){ prefilled=true; prefillShipFromCase(shipCaseId); }
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
  document.getElementById("newPartnerBtn").addEventListener("click",()=>openPartnerModal(null));
  document.getElementById("closePartnerBtn").addEventListener("click",()=>document.getElementById("partnerModal").classList.remove("open"));
  document.getElementById("cancelPartnerBtn").addEventListener("click",()=>document.getElementById("partnerModal").classList.remove("open"));
  document.getElementById("savePartnerBtn").addEventListener("click",savePartner);
  document.getElementById("addContactBtn").addEventListener("click",()=>contactRow({}));
  onSnapshot(query(collection(db,"partners")),(snap)=>{
    const list=snap.docs.map(d=>({_id:d.id,...d.data()}));
    activePartners = list.filter(p=>p.active!==false);
    renderPartners(list);
  });
});
