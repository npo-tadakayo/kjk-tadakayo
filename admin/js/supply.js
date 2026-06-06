import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, orderBy, onSnapshot,
  addDoc, updateDoc, setDoc, deleteDoc, runTransaction, serverTimestamp, increment }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { renderPOHtml, PO_STYLE, DEFAULT_PO_MAIL_SUBJECT, DEFAULT_PO_MAIL_BODY } from "/js/po-doc.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");
const sendSupplierOrderFn = httpsCallable(functions, "sendSupplierOrder");

let products = [];
let currentUser = null;
let appSettings = {};
function ordererList(){
  return (Array.isArray(appSettings.poOrderers) && appSettings.poOrderers.length)
    ? appSettings.poOrderers
    : (appSettings.poOrdererName ? [appSettings.poOrdererName] : ["次田 芳尚"]);
}

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
  // 帳票ページから「供給管理へ」で戻ったとき、元のタブ（?tab=）を開く
  const wanted = new URLSearchParams(location.search).get("tab");
  if (wanted){
    const t = document.querySelector(`.tab[data-tab="${wanted}"]`);
    if (t) t.click();
  }
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
        <button class="btn btn-secondary stock-btn" data-sku="${p.id}" style="font-size:12px;padding:4px 10px"><i class="ti ti-adjustments" aria-hidden="true"></i> 在庫調整</button>
      </td>
    </tr>`).join("");
  document.querySelectorAll(".stock-btn").forEach(b=>b.addEventListener("click",()=>openStockModal(b.dataset.sku)));
}

// 在庫調整モーダル（B2: prompt廃止）
let stockSku = null;
function setStockErr(m){
  const e = document.getElementById("stockQtyErr"); if (e) e.textContent = m || "";
  const i = document.getElementById("stockQty"); if (i) i.classList.toggle("has-error", !!m);
}
function closeStockModal(){ document.getElementById("stockModal").classList.remove("open"); stockSku = null; }
function openStockModal(sku){
  const p = products.find(x=>x.id===sku);
  if (!p) return;
  stockSku = sku;
  document.getElementById("stockModalTitle").textContent = `在庫調整：${p.name}`;
  document.getElementById("stockCurrent").textContent = `現在の在庫：${p.stock||0} 台`;
  document.getElementById("stockQty").value = "1";
  document.getElementById("stockReason").value = "manual";
  setStockErr("");
  const m = document.getElementById("stockModal");
  m.classList.add("open");
  document.getElementById("stockInBtn").onclick = ()=>doStockAdjust("in");
  document.getElementById("stockOutBtn").onclick = ()=>doStockAdjust("out");
  document.getElementById("closeStockBtn").onclick = closeStockModal;
  document.getElementById("cancelStockBtn").onclick = closeStockModal;
  m.onclick = (e)=>{ if (e.target === m) closeStockModal(); };
  document.getElementById("stockQty").focus();
}
async function doStockAdjust(dir){
  const p = products.find(x=>x.id===stockSku);
  if (!p) return;
  setStockErr("");
  const q = parseInt(document.getElementById("stockQty").value, 10);
  if (!(q > 0)) { setStockErr("正の整数を入力してください"); return; }
  if (dir === "out" && (p.stock||0) < q) { setStockErr(`在庫不足（現在 ${p.stock||0} 台）`); return; }
  const reason = `${document.getElementById("stockReason").value}_${dir}`;
  const btnIn = document.getElementById("stockInBtn"), btnOut = document.getElementById("stockOutBtn");
  btnIn.disabled = true; btnOut.disabled = true;
  try {
    const delta = dir === "in" ? q : -q;
    await updateDoc(doc(db,"products",stockSku), { stock: increment(delta) });
    await addDoc(collection(db,"inventoryMovements"), {
      sku: stockSku, delta, reason,
      createdAt: serverTimestamp(), userName: currentUser.displayName||currentUser.email });
    toast(`${p.name} を ${dir==="in"?"+":"-"}${q}台 調整しました`);
    closeStockModal();
  } catch(e){ setStockErr(`調整に失敗しました: ${e.message}`); }
  finally { btnIn.disabled = false; btnOut.disabled = false; }
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
// AB Circle 送料表（税別・全国送料一覧 離島込み）。memory reference_abcircle と一致させること
const SHIPPING_FEES = [
  { region:"北海道", fee:1500, note:"北海道" },
  { region:"北東北", fee:1000, note:"青森・岩手・秋田" },
  { region:"南東北", fee:1000, note:"宮城・山形・福島" },
  { region:"関東", fee:900, note:"東京・神奈川・千葉・埼玉・茨城・栃木・群馬" },
  { region:"甲信越", fee:1000, note:"山梨・新潟・長野" },
  { region:"北陸・中部", fee:1000, note:"富山・石川・福井・静岡・愛知・岐阜・三重" },
  { region:"関西", fee:1100, note:"大阪・京都・兵庫・奈良・滋賀・和歌山" },
  { region:"中国・四国", fee:1200, note:"広島・岡山・山口・鳥取・島根・香川・愛媛・高知・徳島" },
  { region:"九州", fee:1300, note:"福岡・佐賀・長崎・熊本・大分・宮崎・鹿児島" },
  { region:"沖縄", fee:1500, note:"沖縄" },
  { region:"その他離島", fee:2500, note:"離島" },
];
function applyShipRegion(){
  const sel=document.getElementById("orderShipRegion");
  const r=SHIPPING_FEES.find(x=>x.region===sel.value);
  if(!r) return; // 「選択しない」は手入力を保持
  document.getElementById("orderShipFee").value=r.fee;
  document.getElementById("orderShipLabel").value=`送料（${r.region}）`;
}
// 数量帯別の卸単価（AB Circle価格表: 1台 / 2-10台 / 11-30台 / 31台以上）
function unitPriceFor(p, qty){
  if(!p) return 0;
  if(qty>=31) return Number(p.wholesale31 ?? p.wholesale11_30 ?? p.wholesale2_10 ?? 0);
  if(qty>=11) return Number(p.wholesale11_30 ?? p.wholesale2_10 ?? 0);
  if(qty>=2)  return Number(p.wholesale2_10 ?? 0);
  return Number(p.wholesale1 ?? p.wholesale2_10 ?? 0);
}
function collectItems(kind){
  const items=[];
  document.querySelectorAll(`#${kind} .qty-input`).forEach(inp=>{
    const q=parseInt(inp.value,10)||0;
    if(q>0){ const p=products.find(x=>x.id===inp.dataset.sku);
      // 発注は数量帯別単価。出荷(shipItems)はsaveShipで単価を上書きするため従来値でよい
      const unitPrice = kind==="orderItems" ? unitPriceFor(p,q) : (p.wholesale2_10||0);
      items.push({sku:p.id,name:p.name,qty:q,unitPrice}); }
  });
  return items;
}

function fillOrderShipTo(){
  const sel=document.getElementById("orderPartnerSelect");
  const p=activePartners.find(x=>x._id===sel.value);
  if(!p) return; // 「手入力」選択時は既存の入力を保持
  const name=p.corpName ? `${p.corpName}　${p.partnerName||""}`.trim() : (p.partnerName||"");
  const lines=[ p.postal?`〒${p.postal}`:"", `${p.address||""}　${name}`.trim() ].filter(Boolean);
  document.getElementById("orderShipTo").value=lines.join("\n");
}
let editingOrderId = null;
function openOrder(o){
  o = o || null;
  editingOrderId = o ? o._id : null;
  document.getElementById("orderModalTitle").textContent = o ? `発注の編集（${o.poNumber||"下書き"}）` : "新規発注（→AB Circle）";
  document.getElementById("saveOrderBtn").innerHTML = o
    ? '<i class="ti ti-device-floppy" aria-hidden="true"></i>下書きを更新'
    : '<i class="ti ti-device-floppy" aria-hidden="true"></i>下書きとして保存';
  itemRows("orderItems");
  document.getElementById("orderDate").value = (o&&o.orderDate) || today();
  document.getElementById("orderDesiredDate").value = (o&&o.desiredDate) || "";
  document.getElementById("orderNote").value = (o&&o.note) || "";
  document.getElementById("orderShipLabel").value = (o&&o.shippingLabel) || "";
  document.getElementById("orderShipFee").value = (o&&o.shippingFee) || "";
  document.getElementById("orderShipTo").value = (o&&o.shipTo) || "";
  document.getElementById("orderTotal").textContent="";
  // 認定事業所セレクト（選ぶと送付先を自動入力・手入力修正も可）
  const sel=document.getElementById("orderPartnerSelect");
  sel.innerHTML = '<option value="">（手入力 / 自社で受け取り）</option>'+
    activePartners.map(p=>`<option value="${esc(p._id)}">${esc(p.partnerName||p._id)}</option>`).join("");
  sel.value=""; sel.onchange=fillOrderShipTo;
  // お届け地域セレクト（送料自動入力）
  const rsel=document.getElementById("orderShipRegion");
  rsel.innerHTML='<option value="">選択しない（手入力）</option>'+
    SHIPPING_FEES.map(r=>`<option value="${r.region}">${r.region}（${r.note}）— ¥${r.fee.toLocaleString("ja-JP")}</option>`).join("");
  rsel.value=""; rsel.onchange=applyShipRegion;
  // 発注者セレクト（設定の発注者一覧から選択）
  const osel=document.getElementById("orderOrderer");
  const olist=ordererList();
  osel.innerHTML=olist.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  osel.value=(o&&o.ordererName) || olist[0] || "";
  // 編集時は既存の数量を反映
  if(o && Array.isArray(o.items)){ o.items.forEach(it=>{ const inp=document.querySelector(`#orderItems .qty-input[data-sku="${it.sku}"]`); if(inp) inp.value=it.qty; }); }
  document.querySelectorAll("#orderItems .qty-input").forEach(i=>i.addEventListener("input",updateOrderTotal));
  updateOrderTotal();
  document.getElementById("orderModal").classList.add("open"); }
function updateOrderTotal(){ const items=collectItems("orderItems");
  const total=items.reduce((s,i)=>s+i.qty*i.unitPrice,0);
  document.getElementById("orderTotal").textContent = items.length?`合計(税別): ${yen(total)}`:""; }
async function saveOrder(){
  const items=collectItems("orderItems");
  if(!items.length){ alert("数量を入力してください"); return; }
  const btn=document.getElementById("saveOrderBtn"); btn.disabled=true;
  try{
    const total=items.reduce((s,i)=>s+i.qty*i.unitPrice,0);
    const data={
      orderDate:document.getElementById("orderDate").value||today(),
      desiredDate:document.getElementById("orderDesiredDate").value||"",
      supplier:"AB Circle Japan 株式会社", items, total,
      ordererName:document.getElementById("orderOrderer").value||"",
      shippingLabel:document.getElementById("orderShipLabel").value.trim(),
      shippingFee:Number(document.getElementById("orderShipFee").value)||0,
      shipTo:document.getElementById("orderShipTo").value.trim(),
      note:document.getElementById("orderNote").value.trim(),
      updatedAt:serverTimestamp(), updatedBy:currentUser.displayName||currentUser.email };
    if(editingOrderId){
      await updateDoc(doc(db,"purchaseOrders",editingOrderId), data);
      toast("下書きを更新しました");
    }else{
      const poNo=await nextSeq("purchaseOrders");
      const poNumber=seqFmt("PO",poNo);
      await addDoc(collection(db,"purchaseOrders"),{
        ...data, poNumber, poNo, status:"draft",
        createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email });
      toast(`下書き ${poNumber} を保存しました`);
    }
    document.getElementById("orderModal").classList.remove("open");
    editingOrderId=null;
  }catch(e){ alert(`保存失敗: ${e.message}`);} finally{ btn.disabled=false; }
}

function renderOrders(orders){
  const body=document.getElementById("ordersBody"); const empty=document.getElementById("ordersEmpty");
  empty.style.display = orders.length?"none":"block";
  body.innerHTML = orders.map(o=>{
    const summary=(o.items||[]).map(i=>`${i.sku}×${i.qty}`).join(", ");
    const statusLabel={sent:"発注済",received:"入荷済",draft:"下書き"}[o.status]||o.status;
    const badgeN = o.status==="received"?3 : o.status==="draft"?2 : 7;
    const isDraft = o.status==="draft";
    const sentInfo = o.emailedAt ? `<div style="font-size:11px;color:var(--color-success)">メール送付済</div>` : "";
    return `<tr>
      <td><strong>${esc(o.poNumber)}</strong></td>
      <td>${esc(o.orderDate||"")}${o.desiredDate?`<div style="font-size:11px;color:var(--color-ink-muted)">納期希望 ${esc(o.desiredDate)}</div>`:""}</td>
      <td style="font-size:12px">${esc(summary)}</td>
      <td>${yen(o.total)}</td>
      <td><span class="badge badge-${badgeN}">${statusLabel}</span>${sentInfo}</td>
      <td style="white-space:nowrap">
        <a class="btn btn-secondary" href="/supply-print.html?type=po&id=${o._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-text"></i>発注書</a>
        ${isDraft?`<button class="btn btn-secondary edit-order" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-edit"></i>編集</button>
        <button class="btn btn-primary confirm-order" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-check"></i>確定</button>
        <button class="btn btn-danger del-order" data-id="${o._id}" style="font-size:12px;padding:4px 8px" aria-label="削除"><i class="ti ti-trash"></i></button>`:""}
        ${o.status==="sent"?`<button class="btn btn-secondary recv-btn" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-package-import"></i>入荷登録</button>`:""}
      </td></tr>`;
  }).join("");
  document.querySelectorAll(".recv-btn").forEach(b=>b.addEventListener("click",()=>receiveOrder(b.dataset.id,orders)));
  document.querySelectorAll(".edit-order").forEach(b=>b.addEventListener("click",()=>{ const o=orders.find(x=>x._id===b.dataset.id); if(o) openOrder(o); }));
  document.querySelectorAll(".confirm-order").forEach(b=>b.addEventListener("click",()=>{ const o=orders.find(x=>x._id===b.dataset.id); if(o) confirmOrder(o); }));
  document.querySelectorAll(".del-order").forEach(b=>b.addEventListener("click",()=>{ const o=orders.find(x=>x._id===b.dataset.id); if(o) deleteOrder(o); }));
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
// 下書き → 確定して送付（発注書PDFを添付してABサークルへメール）
let confirmingOrder = null;
async function confirmOrder(o){
  confirmingOrder = o;
  let s = {};
  try{ const ss=await getDoc(doc(db,"appConfig","settings")); s = ss.exists()?ss.data():{}; }catch(_){}
  const supplierName = s.supplierName || "AB Circle Japan 株式会社";
  const supplierContact = s.supplierContact || "野田 様";
  const summary = (o.items||[]).map(i=>`${i.name} × ${i.qty}`).join("\n");
  const fill = (t)=> String(t||"")
    .split("{{発注番号}}").join(o.poNumber||"")
    .split("{{品目}}").join(summary)
    .split("{{金額}}").join("¥"+Number(o.total||0).toLocaleString("ja-JP")+"（税別）")
    .split("{{希望納期}}").join(o.desiredDate||"（指定なし）")
    .split("{{発行日}}").join(o.orderDate||"")
    .split("{{担当者}}").join(supplierContact)
    .split("{{仕入先名}}").join(supplierName);
  document.getElementById("cfTo").value = s.supplierEmail || "h.noda@abcircle.com";
  document.getElementById("cfCc").value = s.supplierCc || "n.taniguchi@abcircle.com, s.oda@abcircle.co.jp";
  document.getElementById("cfSubject").value = fill(s.poMailSubject || DEFAULT_PO_MAIL_SUBJECT);
  document.getElementById("cfBody").value = fill(s.poMailBody || DEFAULT_PO_MAIL_BODY);
  document.getElementById("cfError").style.display="none";
  document.getElementById("cfPreview").innerHTML = `<style>${PO_STYLE}</style>` + renderPOHtml(o, s);
  document.getElementById("confirmModalTitle").textContent = `確定して送付（${o.poNumber}）`;
  document.getElementById("confirmModal").classList.add("open");
}
async function sendConfirmedOrder(){
  const o = confirmingOrder; if(!o) return;
  const to = document.getElementById("cfTo").value.trim();
  const cc = document.getElementById("cfCc").value.trim();
  const subject = document.getElementById("cfSubject").value.trim();
  const body = document.getElementById("cfBody").value;
  const err = document.getElementById("cfError"); err.style.display="none";
  if(!to || !subject || !body.trim()){ err.textContent="宛先・件名・本文は必須です"; err.style.display="block"; return; }
  const btn=document.getElementById("sendConfirmBtn"); const orig=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2 ti-spin"></i> PDF生成中...';
  try{
    const el = document.querySelector("#cfPreview .po");
    if(!el) throw new Error("発注書プレビューが見つかりません");
    const opt = { margin:[10,8,10,8], filename:`${o.poNumber}.pdf`, image:{type:"jpeg",quality:0.95},
      html2canvas:{scale:2,useCORS:true,backgroundColor:"#ffffff"}, jsPDF:{unit:"mm",format:"a4",orientation:"portrait"} };
    const dataUri = await window.html2pdf().set(opt).from(el).outputPdf("datauristring");
    const pdfBase64 = String(dataUri).split(",")[1] || "";
    btn.innerHTML='<i class="ti ti-loader-2 ti-spin"></i> 送信中...';
    await sendSupplierOrderFn({ to, cc, subject, body, pdfBase64, filename:`${o.poNumber}.pdf`, poId:o._id });
    document.getElementById("confirmModal").classList.remove("open");
    confirmingOrder=null;
    toast(`${o.poNumber} を発注書添付で送信しました`);
  }catch(e){ err.textContent=`送信に失敗: ${e.message||e}`; err.style.display="block"; }
  finally{ btn.disabled=false; btn.innerHTML=orig; }
}
async function deleteOrder(o){
  if(!confirm(`下書き ${o.poNumber} を削除します。よろしいですか？`)) return;
  try{ await deleteDoc(doc(db,"purchaseOrders",o._id)); toast(`${o.poNumber} を削除しました`); }
  catch(e){ alert(`削除失敗: ${e.message}`); }
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
    // 直送(認定事業所)=卸価格(数量帯別) / 直接(事業所)=エンドユーザー定価 をスナップショット
    const unitPrice = shipType==="dropship" ? unitPriceFor(p, it.qty) : (p.listPrice||0);
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
    return { sku:it.sku, name:it.name||p.name||it.sku, qty:Number(it.qty)||0, unitPrice:unitPriceFor(p, Number(it.qty)||0) };
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
  if(!(await gateRole(db,user))) return;
  currentUser=user;
  document.getElementById("userEmail").textContent=user.displayName||user.email;
  document.getElementById("logoutBtn").addEventListener("click",()=>signOut(auth).then(()=>location.href="/index.html"));
  initTabs();
  try{ const ss=await getDoc(doc(db,"appConfig","settings")); appSettings = ss.exists()?ss.data():{}; }catch(_){}

  document.getElementById("newOrderBtn").addEventListener("click",()=>openOrder());
  document.getElementById("closeOrderBtn").addEventListener("click",()=>document.getElementById("orderModal").classList.remove("open"));
  document.getElementById("cancelOrderBtn").addEventListener("click",()=>document.getElementById("orderModal").classList.remove("open"));
  document.getElementById("saveOrderBtn").addEventListener("click",saveOrder);
  document.getElementById("closeConfirmBtn").addEventListener("click",()=>document.getElementById("confirmModal").classList.remove("open"));
  document.getElementById("cancelConfirmBtn").addEventListener("click",()=>document.getElementById("confirmModal").classList.remove("open"));
  document.getElementById("sendConfirmBtn").addEventListener("click",sendConfirmedOrder);
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
