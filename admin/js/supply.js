import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, orderBy, onSnapshot,
  addDoc, updateDoc, setDoc, deleteDoc, runTransaction, serverTimestamp, increment, arrayUnion }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { renderPOHtml, PO_STYLE, DEFAULT_PO_MAIL_SUBJECT, DEFAULT_PO_MAIL_BODY } from "/js/po-doc.js";
import { renderInvoiceHtml, INVOICE_STYLE, invoiceNoOf,
  DEFAULT_INVOICE_MAIL_SUBJECT, DEFAULT_INVOICE_MAIL_BODY } from "/js/invoice-doc.js";
import { SHIPPING_FEES, unitPriceFor, partnerTierIndex, LETTERPACK_FEE_DEF, YUPACK_SIZES_DEF, YUPACK_REGIONS_DEF, YUPACK_ROWS_DEF } from "/js/supply-pricing.js";
import { parseOrderFile } from "/js/partner-order-import.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");
const sendSupplierOrderFn = httpsCallable(functions, "sendSupplierOrder");
const sendPartnerMailFn = httpsCallable(functions, "sendPartnerMail");
const reportInvoiceFn = httpsCallable(functions, "reportInvoiceToAccounting");

let products = [];
let currentUser = null;
let appSettings = {};
let shipments = [];          // 出荷一覧（受注タブの入金状況表示に流用）
let partnerOrdersCache = []; // 受注一覧（出荷の更新時に再描画するため保持）
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
/** 税込の実費（郵便料金など）を税抜へ。送料は税抜で保存する（2026-07-28 統一） */
function taxExcl(inclusive){ return Math.round((Number(inclusive)||0)/1.1); }

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
      <td class="num">${yen(p.wholesale2_10)}</td>
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
function applyShipRegion(){
  const sel=document.getElementById("orderShipRegion");
  const r=SHIPPING_FEES.find(x=>x.region===sel.value);
  if(!r) return; // 「選択しない」は手入力を保持
  // AB Circle は1便100台以上で送料無料。100台以上のときは地域を選んでも0円にする
  const qty=collectItems("orderItems").reduce((s,i)=>s+i.qty,0);
  const free=qty>=100;
  document.getElementById("orderShipFee").value=free?0:r.fee;
  document.getElementById("orderShipLabel").value=free?`送料（${r.region}・100台以上で無料）`:`送料（${r.region}）`;
}
// 認定事業所への卸単価（料金・送料設定 appConfig.partnerPricing が正＝AB Circle仕入とは別管理）。
// 未設定時は商品マスタの数量帯別卸（unitPriceFor）にフォールバック＝従来挙動を維持。
function partnerPriceFor(p, qty){
  if(!p) return 0;
  const pp = appSettings.partnerPricing && appSettings.partnerPricing[p.id];
  if(Array.isArray(pp) && pp.length>=4){
    const v = Number(pp[partnerTierIndex(qty)]);
    if(v>0) return v;
  }
  return unitPriceFor(p, qty);
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
  // 直送チェック（確定時に出荷下書きを自動作成）
  const dchk=document.getElementById("orderDropship");
  const dreq=document.getElementById("dropshipReq");
  dchk.checked = !!(o&&o.dropship);
  if(dreq) dreq.style.display = dchk.checked?"":"none";
  dchk.onchange=()=>{ if(dreq) dreq.style.display = dchk.checked?"":"none"; };
  // 認定事業所セレクト（直送時は請求先。選ぶと届け先住所を自動入力・手入力修正も可）
  const sel=document.getElementById("orderPartnerSelect");
  sel.innerHTML = '<option value="">（手入力 / 自社で受け取り）</option>'+
    activePartners.map(p=>`<option value="${esc(p._id)}">${esc(p.partnerName||p._id)}</option>`).join("");
  sel.value=(o&&o.dropshipPartnerEmail)||""; sel.onchange=fillOrderShipTo;
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
  if(document.getElementById("orderDropship").checked && !document.getElementById("orderPartnerSelect").value){
    alert("直送する場合は請求先の認定事業所を選択してください"); return; }
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
      dropship:document.getElementById("orderDropship").checked,
      dropshipPartnerEmail:(activePartners.find(p=>p._id===document.getElementById("orderPartnerSelect").value)||{})._id||"",
      dropshipPartnerName:(activePartners.find(p=>p._id===document.getElementById("orderPartnerSelect").value)||{}).partnerName||"",
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
    const sentInfo = o.emailedAt ? `<div style="font-size:12px;color:var(--color-success)">メール送付済</div>` : "";
    // 直送は仕入先から届け先へ直行＝自社在庫を経由しないので「入荷登録」は出さない（在庫の誤加算を防ぐ）
    const dropInfo = o.dropship ? `<div style="font-size:12px;color:var(--color-ink-muted)">直送（入荷なし）${o.dropshipPartnerName?`／請求先 ${esc(o.dropshipPartnerName)}`:""}</div>` : "";
    return `<tr>
      <td><strong>${esc(o.poNumber)}</strong></td>
      <td>${esc(o.orderDate||"")}${o.desiredDate?`<div style="font-size:12px;color:var(--color-ink-muted)">納期希望 ${esc(o.desiredDate)}</div>`:""}</td>
      <td style="font-size:12px">${esc(summary)}</td>
      <td class="num">${yen(o.total)}</td>
      <td><span class="badge badge-${badgeN}">${statusLabel}</span>${sentInfo}${dropInfo}</td>
      <td style="white-space:nowrap">
        <a class="btn btn-secondary" href="/supply-print.html?type=po&id=${o._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-text"></i>発注書</a>
        ${isDraft?`<button class="btn btn-secondary edit-order" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-edit"></i>編集</button>
        <button class="btn btn-primary confirm-order" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-check"></i>確定</button>
        <button class="btn btn-danger del-order" data-id="${o._id}" style="font-size:12px;padding:4px 8px" aria-label="削除"><i class="ti ti-trash"></i></button>`:""}
        ${o.status==="sent"&&!o.dropship?`<button class="btn btn-secondary recv-btn" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-package-import"></i>入荷登録</button>`:""}
        ${o.status==="sent"?`<button class="btn btn-secondary undo-order" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-back-up"></i>下書きに戻す</button>`:""}
      </td></tr>`;
  }).join("");
  document.querySelectorAll(".recv-btn").forEach(b=>b.addEventListener("click",()=>receiveOrder(b.dataset.id,orders)));
  document.querySelectorAll(".undo-order").forEach(b=>b.addEventListener("click",()=>{ const o=orders.find(x=>x._id===b.dataset.id); if(o) revertOrderToDraft(o); }));
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
// 発注済(sent) → 下書き(draft) に戻す（発注を取り消して内容を直すとき）
// 入荷済(received)は在庫が動いているため対象外＝ボタンを出していない
async function revertOrderToDraft(o){
  const warn = [];
  if(o.emailedAt) warn.push("・この発注は仕入先へメール送付済みです。取り消しの連絡はメールで別途行ってください（送付の記録は残ります）");
  if(o.shipmentId) warn.push("・直送の出荷下書きが作成済みです。不要な場合は出荷タブで削除してください（再確定しても二重には作られません）");
  if(!confirm(`発注 ${o.poNumber} を下書きに戻します。編集・削除ができる状態になります。\n${warn.join("\n")}${warn.length?"\n":""}\nよろしいですか？`)) return;
  try{
    await updateDoc(doc(db,"purchaseOrders",o._id),{
      status:"draft", revertedAt:serverTimestamp(), revertedBy:currentUser.displayName||currentUser.email,
      updatedAt:serverTimestamp(), updatedBy:currentUser.displayName||currentUser.email });
    toast(`${o.poNumber} を下書きに戻しました`);
  }catch(e){ alert(`下書きに戻せませんでした: ${e.message}`); }
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
    if(o.dropship && !o.shipmentId){ try{ await createShipmentDraftFromPO(o); }catch(e){ console.warn("出荷下書きの自動生成に失敗", e); } }
    document.getElementById("confirmModal").classList.remove("open");
    confirmingOrder=null;
    toast(o.dropship ? `${o.poNumber} を送信し、直送の出荷下書きを作成しました（在庫は経由しません）` : `${o.poNumber} を発注書添付で送信しました`);
  }catch(e){ err.textContent=`送信に失敗: ${e.message||e}`; err.style.display="block"; }
  finally{ btn.disabled=false; btn.innerHTML=orig; }
}
async function deleteOrder(o){
  if(!confirm(`下書き ${o.poNumber} を削除します。よろしいですか？`)) return;
  try{ await deleteDoc(doc(db,"purchaseOrders",o._id)); toast(`${o.poNumber} を削除しました`); }
  catch(e){ alert(`削除失敗: ${e.message}`); }
}

// 直送発注 → 出荷の下書き(draft)を自動生成（在庫は経由しない＝増減なし）。請求先=認定事業所・単価=認定事業所卸
async function createShipmentDraftFromPO(o){
  const partner = activePartners.find(p=>p._id===o.dropshipPartnerEmail) || {};
  const items=(o.items||[]).map(it=>{ const p=products.find(x=>x.id===it.sku)||{};
    return { sku:it.sku, name:it.name||p.name||it.sku, qty:Number(it.qty)||0, unitPrice:partnerPriceFor(p, Number(it.qty)||0) }; }).filter(it=>it.qty>0);
  if(!items.length) return;
  const soNumber=seqFmt("SH",await nextSeq("shipments"));
  const ref=await addDoc(collection(db,"shipments"),{
    soNumber, status:"draft", shipType:"dropship", fulfillment:"direct",
    partnerEmail:o.dropshipPartnerEmail||"", partnerName:o.dropshipPartnerName||partner.partnerName||"",
    officeName:o.dropshipPartnerName||partner.partnerName||"", company:partner.corpName||"",
    postal:partner.postal||"", address:(o.shipTo||partner.address||""), phone:partner.phone||"",
    items, sourcePO:o._id, poNumber:o.poNumber||"",
    shipDate:today(), createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email });
  await updateDoc(doc(db,"purchaseOrders",o._id),{ shipmentId:ref.id });
}
// 直送の出荷下書き(draft) → 発送済(shipped)に確定。直送のため在庫は動かさない
async function confirmDraftShipment(s){
  if(!confirm(`出荷 ${s.soNumber}（${s.partnerName||s.officeName||""}）を発送済に確定します。\n直送のため在庫は変動しません。よろしいですか？`)) return;
  try{ await updateDoc(doc(db,"shipments",s._id),{ status:"shipped", shipDate:s.shipDate||today(), confirmedAt:serverTimestamp() });
    toast(`${s.soNumber} を発送済に確定しました`); }
  catch(e){ alert(`確定失敗: ${e.message}`); }
}

// ===== 出荷の送料（料金・送料設定 appConfig を優先。デフォルト値・定数は supply-pricing.js） =====
function letterpackFee(){ const v=Number(appSettings.letterpackFee); return v>0?v:LETTERPACK_FEE_DEF; }
function yupackData(){
  const t = appSettings.yupackTable || {};
  return {
    sizes: (Array.isArray(t.sizes)&&t.sizes.length)?t.sizes:YUPACK_SIZES_DEF,
    regions: (Array.isArray(t.regions)&&t.regions.length)?t.regions:YUPACK_REGIONS_DEF,
    rows: (t.rows&&Object.keys(t.rows).length)?t.rows:YUPACK_ROWS_DEF,
  };
}
function shipTotalQty(){
  let n=0; document.querySelectorAll('#shipItems .qty-input').forEach(i=>{ n+=parseInt(i.value,10)||0; }); return n;
}
// 配送方法に応じて送料・名目を自動入力（手入力は維持）
function recalcShipFee(){
  const method=document.getElementById('shipMethod').value;
  const feeEl=document.getElementById('shipFee'), labelEl=document.getElementById('shipFeeLabel');
  document.getElementById('yupackWrap').style.display = method==='yupack' ? '' : 'none';
  // 料金表（レターパック・ゆうパック）は税込の実費 → 送料欄は税抜なので換算して入れる
  if(method==='letterpack'){
    const packs=Math.max(1,Math.ceil(shipTotalQty()/3));
    feeEl.value=taxExcl(packs*letterpackFee()); labelEl.value=`送料（レターパック ${packs}通）`;
  } else if(method==='yupack'){
    const d=yupackData(); const size=document.getElementById('shipYuSize').value;
    const ri=parseInt(document.getElementById('shipYuRegion').value,10)||0;
    const arr=d.rows[size]||YUPACK_ROWS_DEF[size]||[];
    feeEl.value=taxExcl(Number(arr[ri])||0); labelEl.value=`送料（ゆうパック ${size}サイズ・${d.regions[ri]||""}）`;
  }
}
// 出荷モーダルを開くたびに配送方法をリセット＋ゆうパックのサイズ/地域セレクトを最新設定で再構築
function initShipFeeControls(){
  const d=yupackData();
  document.getElementById('shipYuSize').innerHTML=d.sizes.map(s=>`<option value="${s}">${s}サイズ</option>`).join("");
  document.getElementById('shipYuRegion').innerHTML=d.regions.map((r,i)=>`<option value="${i}">${esc(r)}</option>`).join("");
  document.getElementById('shipMethod').value="";
  document.getElementById('shipFee').value="";
  document.getElementById('shipFeeLabel').value="";
  document.getElementById('yupackWrap').style.display="none";
  document.querySelectorAll('#shipItems .qty-input').forEach(i=>i.addEventListener('input',recalcShipFee));
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
  initShipFeeControls();
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
    // 直送(認定事業所)=認定事業所卸(partnerPricing・数量帯別) / 直接(事業所)=エンドユーザー定価 をスナップショット
    const unitPrice = shipType==="dropship" ? partnerPriceFor(p, it.qty) : (p.listPrice||0);
    return {...it, unitPrice};
  });
  if(!items.length){ alert("数量を入力してください"); return; }
  for(const it of items){ const p=products.find(x=>x.id===it.sku);
    if((p.stock||0)<it.qty){ const w=document.getElementById("shipStockWarn");
      w.style.display="block"; w.textContent=`在庫不足: ${p.name}（在庫 ${p.stock||0} / 出荷 ${it.qty}）`; return; } }
  const shippingMethod=document.getElementById("shipMethod").value||"manual";
  const shippingFee=Number(document.getElementById("shipFee").value)||0;
  const shippingLabel=document.getElementById("shipFeeLabel").value.trim()||(shippingFee>0?"送料":"");
  const btn=document.getElementById("saveShipBtn"); btn.disabled=true;
  try{
    const soNumber=seqFmt("SH",await nextSeq("shipments"));
    await addDoc(collection(db,"shipments"),{
      soNumber, shipType, partnerEmail, partnerName,
      status:"shipped", shippingMethod, shippingFee, shippingLabel,
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

const SHIP_STATUS = { draft:"下書き", shipped:"発送済", invoiced:"請求済", paid:"入金済", canceled:"キャンセル" };
const SHIP_STATUS_BADGE = { draft:2, shipped:7, invoiced:9, paid:3, canceled:4 };
// 出荷の金額（送料込み）。送料は税込実費を税抜換算して小計に含め、請求書(renderInvoice)と同じ税計算にする
function shipGoodsExcl(s){ return (s.items||[]).reduce((a,i)=>a+(Number(i.unitPrice)||0)*(Number(i.qty)||0),0); }
// 送料は税抜で保存する（2026-07-28 統一。発注側の送料欄が元から「税別」だったのに揃えた）
function shipFeeExcl(s){ return Number(s.shippingFee)||0; }
function shipSubExcl(s){ return shipGoodsExcl(s)+shipFeeExcl(s); }
function shipTotal(s){ return shipSubExcl(s); }
function shipTotalIncl(s){ const sub=shipSubExcl(s); return sub+Math.floor(sub*0.1); }

// ===== 入金・未集金（2026-07-30 追加）=====
// 入金は payments[] に履歴として積む（部分入金・分割払い対応）。
// 旧形式（paymentAmount/paidAt の1回きり）のデータは1件の履歴として読み替える。
function payList(s){
  if(Array.isArray(s.payments) && s.payments.length) return s.payments;
  if(Number(s.paymentAmount)>0) return [{ amount:Number(s.paymentAmount), date:s.paidAt||"", note:"（旧形式の記録）" }];
  return [];
}
function paidSum(s){ return payList(s).reduce((a,p)=>a+(Number(p.amount)||0),0); }
// 返金（2026-08-01 追加）: 過入金を返した／返品・キャンセルで返した分。入金から差し引いて「純入金」で判定する
function refundList(s){ return Array.isArray(s.refunds)?s.refunds:[]; }
function refundSum(s){ return refundList(s).reduce((a,r)=>a+(Number(r.amount)||0),0); }
function netPaid(s){ return paidSum(s)-refundSum(s); }
// 過入金の充当（2026-08-01 追加）: 前の請求で多く入金された分を、この請求から差し引く
// creditApplied = この請求に充当された額 ／ overpayUsed = この出荷の過入金のうち他の請求へ回した額
function creditApplied(s){ return Number(s.creditApplied)||0; }
// 充当後の請求額（＝相手に実際に支払ってもらう額）
function billableIncl(s){ return Math.max(0, shipTotalIncl(s)-creditApplied(s)); }
function payRemain(s){ return Math.max(0, billableIncl(s)-netPaid(s)); }
// 過入金＝請求額（充当後）より多く入った分（返金済みの分は除く）。うち未充当の残りが次回に回せる金額
function overpayOf(s){ return Math.max(0, netPaid(s)-billableIncl(s)); }
function creditBalanceOf(s){ return Math.max(0, overpayOf(s)-(Number(s.overpayUsed)||0)); }
// 請求先の同一判定キー（直送＝認定事業所のメール／直接＝事業所名）
function billToKey(s){
  return s.shipType==="dropship" ? (s.partnerEmail||s.partnerName||"") : (s.company||s.officeName||"");
}
// ある出荷と同じ請求先で、まだ充当していない過入金がある出荷（古い順＝先に入った分から使う）
function creditSourcesFor(s){
  const key=billToKey(s);
  return shipments
    .filter(x=>x._id!==s._id && x.status!=="canceled" && billToKey(x)===key && creditBalanceOf(x)>0)
    .sort((a,b)=>String(a.shipDate||"").localeCompare(String(b.shipDate||"")));
}
function creditBalanceForBillTo(s){ return creditSourcesFor(s).reduce((a,x)=>a+creditBalanceOf(x),0); }
// 別請求先（グループ会社など）の未充当の過入金（2026-08-12 追加）。
// 自動では絶対に跨がない。充当モーダルで「どの過入金を回すか」を人が選んだときだけ使う。
function crossCreditSourcesFor(s){
  const key=billToKey(s);
  return shipments
    .filter(x=>x._id!==s._id && x.status!=="canceled" && billToKey(x)!==key && creditBalanceOf(x)>0)
    .sort((a,b)=>String(a.shipDate||"").localeCompare(String(b.shipDate||"")));
}
function crossCreditBalanceFor(s){ return crossCreditSourcesFor(s).reduce((a,x)=>a+creditBalanceOf(x),0); }
// 支払期限＝請求月の翌月末（請求書の記載と同じ）。shipments.dueDate があればそれを優先
function dueDateOf(s){
  if(s.dueDate) return s.dueDate;
  const base=s.invoicedAt||s.shipDate||"";
  const m=/^(\d{4})-(\d{2})/.exec(base);
  if(!m) return "";
  const d=new Date(Number(m[1]), Number(m[2])+1, 0); // 翌月末
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
// 期限超過の日数（未超過・期限不明は0）
function overdueDays(s){
  const due=dueDateOf(s);
  if(!due) return 0;
  const diff=Math.floor((new Date(`${today()}T00:00:00`)-new Date(`${due}T00:00:00`))/86400000);
  return diff>0?diff:0;
}
// 未集金＝請求済（invoiced）で残額があるもの。発送済で未請求のものは「未請求」として別に数える
function isUnpaid(s){ return s.status==="invoiced" && payRemain(s)>0; }
function billToOf(s){ return s.shipType==="dropship" ? (s.partnerName||s.partnerEmail||"") : (s.company||s.officeName||""); }
function billToEmailOf(s){
  if(s.shipType==="dropship") return s.partnerEmail||"";
  return s.email||s.contactEmail||"";
}

function renderShipments(ships){
  const body=document.getElementById("shipBody"); const empty=document.getElementById("shipEmpty");
  empty.style.display = ships.length?"none":"block";
  // サマリー（未請求 / 請求済・未入金 / 入金済）
  const active = ships.filter(s=>s.status!=="canceled");
  const drafts = active.filter(s=>s.status==="draft");
  const unbilled = active.filter(s=>s.status==="shipped");
  const billed = active.filter(s=>s.status==="invoiced");
  const paid = active.filter(s=>s.status==="paid");
  const unpaid = active.filter(isUnpaid);
  const overdue = unpaid.filter(s=>overdueDays(s)>0);
  const sumBox=document.getElementById("shipSummary");
  if(sumBox) sumBox.innerHTML = [
    drafts.length?`<div class="alert-chip info"><i class="ti ti-file-pencil"></i><div><div class="alert-num">${drafts.length}</div><div class="alert-label">直送・下書き（要確定）</div></div></div>`:"",
    `<div class="alert-chip warn"><i class="ti ti-package-export"></i><div><div class="alert-num">${unbilled.length}</div><div class="alert-label">未請求（発送済）</div></div></div>`,
    `<div class="alert-chip danger"><i class="ti ti-receipt"></i><div><div class="alert-num">${yen(unpaid.reduce((a,s)=>a+payRemain(s),0))}</div><div class="alert-label">未集金・残額（税込 ${unpaid.length}件）</div></div></div>`,
    overdue.length?`<div class="alert-chip danger"><i class="ti ti-alarm"></i><div><div class="alert-num">${yen(overdue.reduce((a,s)=>a+payRemain(s),0))}</div><div class="alert-label">うち支払期限超過（${overdue.length}件）</div></div></div>`:"",
    `<div class="alert-chip info"><i class="ti ti-cash"></i><div><div class="alert-num">${yen(active.reduce((a,s)=>a+netPaid(s),0))}</div><div class="alert-label">入金済・累計（税込・返金差引後）</div></div></div>`,
    active.some(s=>creditBalanceOf(s)>0)
      ? `<div class="alert-chip warn"><i class="ti ti-arrow-down-circle"></i><div><div class="alert-num">${yen(active.reduce((a,s)=>a+creditBalanceOf(s),0))}</div><div class="alert-label">過入金・未充当（次回請求に充当）</div></div></div>`:"",
  ].join("");
  renderReceivables(unpaid, active);

  body.innerHTML = ships.map(s=>{
    const summary=(s.items||[]).map(i=>`${i.sku}×${i.qty}`).join(", ");
    const typeBadge = s.shipType==="dropship"
      ? `<span class="badge badge-6">直送(認定)</span>` : `<span class="badge badge-2">直接</span>`;
    const st=s.status||"shipped";
    const stBadge=`<span class="badge badge-${SHIP_STATUS_BADGE[st]||7}">${SHIP_STATUS[st]||st}</span>`;
    const billName = billToOf(s);
    // 入金・残額・支払期限（請求済以降のみ表示）
    const done=paidSum(s), remain=payRemain(s), od=overdueDays(s), due=dueDateOf(s);
    let payInfo="";
    if(st==="invoiced"||st==="paid"){
      const dueTxt = due?`期限 ${esc(due)}${od>0?`・<strong style="color:var(--color-danger)">${od}日超過</strong>`:""}` : "";
      const creditTxt = creditApplied(s)>0
        ? `<div style="font-size:12px;color:var(--color-ink-muted)">過入金の充当 −${yen(creditApplied(s))}（請求 ${yen(billableIncl(s))}）</div>` : "";
      const bal=creditBalanceOf(s);
      const balTxt = bal>0 ? `<div style="font-size:12px;color:var(--color-warn,#c87a1f)">過入金 ${yen(bal)}（次回請求に充当できます）</div>` : "";
      const usedTxt = (Number(s.overpayUsed)||0)>0 ? `<div style="font-size:12px;color:var(--color-ink-muted)">過入金 ${yen(Number(s.overpayUsed))} を他の請求に充当済み</div>` : "";
      const refTxt = refundSum(s)>0 ? `<div style="font-size:12px;color:var(--color-danger)">返金 −${yen(refundSum(s))}（${esc(refundList(s).slice(-1)[0]?.date||"")}）</div>` : "";
      const payCount = payList(s).length>1 ? `<div style="font-size:12px;color:var(--color-ink-muted)">入金${payList(s).length}回</div>` : "";
      payInfo = (remain>0
        ? `<div style="font-size:12px;color:var(--color-danger)">未集金 ${yen(remain)}${netPaid(s)>0?`（入金済 ${yen(netPaid(s))}）`:""}</div>${dueTxt?`<div style="font-size:12px;color:var(--color-ink-muted)">${dueTxt}</div>`:""}`
        : `<div style="font-size:12px;color:var(--color-success)">入金済 ${yen(netPaid(s))}${s.paidAt?`（${esc(s.paidAt)}）`:""}</div>`)
        + payCount + refTxt + creditTxt + balTxt + usedTxt
        // 経理への請求書発行報告（未報告なら気づけるように出す）
        + (s.accountingReportedAt
            ? `<div style="font-size:12px;color:var(--color-ink-muted)">経理へ報告済み ${esc(String(s.accountingReportedAt).slice(5))}</div>`
            : `<div style="font-size:12px;color:var(--color-warn,#c87a1f)">経理へ未報告</div>`);
    }
    let lifeBtns="";
    if(st==="draft") lifeBtns=`<button class="btn btn-primary confirm-draft-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-check"></i>出荷を確定</button>`;
    else if(st==="shipped") lifeBtns=`<button class="btn btn-secondary mark-invoiced" data-id="${s._id}" style="font-size:12px;padding:4px 8px">請求済にする</button>`;
    else if(st==="invoiced") lifeBtns=`<button class="btn btn-primary mark-paid" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-cash"></i>入金記録</button>`
      // 同じ請求先の過入金は金額つきで、別請求先（グループ）の分しか無いときは「別請求先」と明示して出す
      + (creditBalanceForBillTo(s)>0
          ? `<button class="btn btn-secondary apply-credit" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-down-circle"></i>過入金を充当（${yen(Math.min(creditBalanceForBillTo(s),remain))}）</button>`
          : (crossCreditBalanceFor(s)>0
              ? `<button class="btn btn-secondary apply-credit" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-down-circle"></i>過入金を充当（別請求先 ${yen(Math.min(crossCreditBalanceFor(s),remain))}）</button>`
              : ""))
      + (od>0?`<button class="btn btn-secondary dun-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-forward"></i>催促メール${s.dunningSentAt?`（${esc(String(s.dunningSentAt).slice(5))}送信済）`:""}</button>`:"")
      // 報告が失敗した／後から報告するとき用（請求済のステータスは変えない）
      + (s.accountingReportedAt?"":`<button class="btn btn-secondary report-acct" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-invoice"></i>経理へ報告</button>`);
    else if(st==="paid") lifeBtns=`<button class="btn btn-secondary mark-paid" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-list-details"></i>入金履歴</button>`;
    return `<tr>
      <td><strong>${esc(s.soNumber)}</strong><div style="margin-top:2px">${typeBadge} ${stBadge}</div></td>
      <td>${esc(s.shipDate||"")}</td>
      <td>${esc(s.officeName)}${s.company?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(s.company)}</div>`:""}<div style="font-size:12px;color:var(--color-ink-muted)">請求先: ${esc(billName)}（${yen(shipTotalIncl(s))}）</div>${payInfo}</td>
      <td style="font-size:12px">${esc(summary)}</td>
      <td style="white-space:nowrap">
        ${lifeBtns}
        <a class="btn btn-secondary" href="/supply-print.html?type=invoice&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-receipt"></i>請求書</a>
        ${st==="paid" ? `<a class="btn btn-secondary" href="/supply-print.html?type=receipt&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-receipt-2"></i>領収書${s.receiptIssuedAt?`（発行済 ${esc(String(s.receiptIssuedAt).slice(5))}）`:""}</a>` : ""}
        ${refundSum(s)>0 ? `<a class="btn btn-secondary" href="/supply-print.html?type=refund&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-back-up"></i>返金明細書${s.refundStatementIssuedAt?`（発行済 ${esc(String(s.refundStatementIssuedAt).slice(5))}）`:""}</a>` : ""}
        <a class="btn btn-secondary" href="/supply-print.html?type=ship&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-text"></i>送付状</a>
        <a class="btn btn-secondary" href="/supply-print.html?type=letterpack&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-fast"></i>宛名</a>
        <button class="btn btn-danger del-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-trash"></i></button>
      </td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".del-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) deleteShipment(s);
  }));
  document.querySelectorAll(".confirm-draft-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) confirmDraftShipment(s);
  }));
  // 請求済にする → 確認ダイアログ（経理への報告を送るか選ぶ）。過入金の充当提案はダイアログ側で行う
  document.querySelectorAll(".mark-invoiced").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) openInvoiceReport(s);
  }));
  // すでに請求済のものを後から経理へ報告する（ステータスは変えない）
  document.querySelectorAll(".report-acct").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) openInvoiceReport(s,{reportOnly:true});
  }));
  document.querySelectorAll(".mark-paid").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) recordPayment(s);
  }));
  document.querySelectorAll(".dun-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) openDunning(s);
  }));
  document.querySelectorAll(".apply-credit").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) openCreditModal(s);
  }));
}

// ===== 未集金一覧（認定事業所・事業所ごとの残額と最長超過日数）=====
function renderReceivables(unpaid, active){
  const box=document.getElementById("arSummary");
  if(!box) return;
  // 請求先ごとの未充当の過入金（未集金が無くても残高は見せる）
  const creditByBill=new Map();
  (active||[]).forEach(s=>{
    const bal=creditBalanceOf(s); if(!(bal>0)) return;
    const key=billToOf(s)||"（請求先未設定）";
    const cur=creditByBill.get(key)||{ credit:0, ships:[] };
    cur.credit+=bal; cur.ships.push(s); creditByBill.set(key,cur);
  });
  if(!unpaid.length && !creditByBill.size){ box.innerHTML=`<div class="card" style="padding:12px;font-size:13px;color:var(--color-ink-muted)"><i class="ti ti-circle-check" aria-hidden="true"></i> 未集金はありません（請求済のものはすべて入金済）</div>`; return; }
  // 請求先ごとに集約（残額の多い順・超過があるものを上に）
  const byBill=new Map();
  unpaid.forEach(s=>{
    const key=billToOf(s)||"（請求先未設定）";
    const cur=byBill.get(key)||{ name:key, email:billToEmailOf(s), remain:0, count:0, maxOverdue:0, oldestDue:"", ships:[] };
    cur.remain+=payRemain(s); cur.count++; cur.email=cur.email||billToEmailOf(s);
    const od=overdueDays(s); if(od>cur.maxOverdue){ cur.maxOverdue=od; cur.oldestDue=dueDateOf(s); }
    cur.ships.push(s);
    byBill.set(key,cur);
  });
  // 過入金だけある請求先も行として出す（次回請求で引く分が見えるように）
  creditByBill.forEach((v,key)=>{ if(!byBill.has(key)) byBill.set(key,{ name:key, email:billToEmailOf(v.ships[0]), remain:0, count:0, maxOverdue:0, oldestDue:"", ships:[] }); });
  const rows=[...byBill.values()].sort((a,b)=>(b.maxOverdue-a.maxOverdue)||(b.remain-a.remain)).map(r=>{
    const c=creditByBill.get(r.name);
    return `<tr>
      <td><strong>${esc(r.name)}</strong>${r.email?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(r.email)}</div>`:""}</td>
      <td class="num"><strong>${yen(r.remain)}</strong></td>
      <td class="num">${c?`<strong style="color:var(--color-warn,#c87a1f)">−${yen(c.credit)}</strong><div style="font-size:12px;color:var(--color-ink-muted)">${c.ships.map(s=>esc(s.soNumber)).join(", ")}</div>`:"—"}</td>
      <td class="num">${yen(Math.max(0, r.remain-(c?c.credit:0)))}</td>
      <td>${r.count?(r.count+"件"):"—"}<div style="font-size:12px;color:var(--color-ink-muted)">${r.ships.map(s=>esc(s.soNumber)).join(", ")}</div></td>
      <td>${r.maxOverdue>0
        ? `<span class="badge badge-4">${r.maxOverdue}日超過</span><div style="font-size:12px;color:var(--color-ink-muted)">期限 ${esc(r.oldestDue)}</div>`
        : `<span style="font-size:12px;color:var(--color-ink-muted)">${r.count?"期限内":"未集金なし"}</span>`}</td>
    </tr>`;
  }).join("");
  box.innerHTML=`<div class="card"><div class="table-wrap">
    <table><thead><tr><th>請求先</th><th class="num">未集金・残額（税込）</th><th class="num">過入金（充当できる分）</th><th class="num">差引後の請求</th><th>対象の出荷</th><th>支払期限</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${creditByBill.size?`<p style="font-size:12px;color:var(--color-ink-muted);padding:8px 12px;margin:0">過入金は請求済の行の「過入金を充当」で差し引けます（「請求済にする」を押したときにも確認が出ます）。</p>`:""}
  </div>`;
}

// ===== 入金の記録（部分入金・履歴・取消）=====
let payingShip=null;
function recordPayment(s){
  payingShip=s;
  const total=shipTotalIncl(s), done=paidSum(s), ref=refundSum(s), remain=payRemain(s);
  document.getElementById("payModalTitle").textContent=`入金・返金の記録（${s.soNumber}）`;
  document.getElementById("payBillTo").textContent=`${billToOf(s)}／請求額（税込）${yen(total)}`
    + (creditApplied(s)>0?`　過入金の充当 −${yen(creditApplied(s))} → ${yen(billableIncl(s))}`:"");
  document.getElementById("paySummary").innerHTML=
    `入金合計 <strong>${yen(done)}</strong>${ref>0?`　／　返金 <strong style="color:var(--color-danger)">−${yen(ref)}</strong>　／　純入金 <strong>${yen(netPaid(s))}</strong>`:""}`
    + `　／　残額 <strong style="color:${remain>0?"var(--color-danger)":"var(--color-success)"}">${yen(remain)}</strong>`
    + (dueDateOf(s)?`　／　支払期限 ${esc(dueDateOf(s))}${overdueDays(s)>0?`（<strong style="color:var(--color-danger)">${overdueDays(s)}日超過</strong>）`:""}`:"");
  // 過入金の案内（この出荷で多く入っている分 ／ 同じ請求先の分 ／ 別請求先＝グループ会社の分）
  const myBal=creditBalanceOf(s), billBal=creditBalanceForBillTo(s), crossBal=crossCreditBalanceFor(s);
  const cbox=document.getElementById("payCredit");
  const cbtn=document.getElementById("applyCreditBtn");
  if(myBal>0){
    cbox.style.display="block";
    cbox.innerHTML=`<strong>過入金 ${yen(myBal)}</strong> があります（請求額を超えて入金された分・二重に入金された場合も同じ扱いです）。`
      + `<br>選べる対応は2つです。<strong>①次回の請求から差し引く</strong>（次の請求を「請求済」にしたときに確認が出ます）／<strong>②返金する</strong>（下の「返金を記録する」に既定でこの金額が入っています）。`;
    cbtn.style.display="none";
  }else if((billBal>0||crossBal>0) && remain>0){
    cbox.style.display="block";
    cbox.innerHTML= billBal>0
      ? `${esc(billToOf(s))} には未充当の<strong>過入金 ${yen(billBal)}</strong>があります。この請求から <strong>${yen(Math.min(billBal,remain))}</strong> を差し引けます。`
        + (crossBal>0?`<br>別の請求先にも過入金 ${yen(crossBal)} があります（グループ会社間で回す場合は充当画面で選べます）。`:"")
      : `${esc(billToOf(s))} 自身の過入金はありませんが、<strong>別の請求先に過入金 ${yen(crossBal)}</strong> があります。グループ会社間で回す場合は充当画面で充当元を選んでください。`;
    cbtn.style.display="";
  }else{
    cbox.style.display="none";
    cbtn.style.display="none";
  }
  // 入金と返金を日付順にまとめて表示（入金が複数回・返金ありでも通帳のように追える）
  const list=payList(s), rlist=refundList(s);
  const hist=[
    ...list.map((p,i)=>({kind:"pay", idx:i, date:p.date||"", amount:Number(p.amount)||0, note:p.note||""})),
    ...rlist.map((r,i)=>({kind:"refund", idx:i, date:r.date||"", amount:Number(r.amount)||0,
      note:[r.method?`返金方法: ${r.method}`:"", r.note||""].filter(Boolean).join(" / ")})),
  ].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  let run=0;
  document.getElementById("payHistory").innerHTML = hist.length
    ? `<div class="table-wrap"><table style="width:100%;font-size:13px"><thead><tr><th style="text-align:left">日付</th><th style="text-align:left">区分</th><th class="num">金額</th><th class="num">純入金の累計</th><th style="text-align:left">備考</th><th>操作</th></tr></thead><tbody>${
        hist.map(h=>{
          run += h.kind==="pay" ? h.amount : -h.amount;
          return `<tr><td>${esc(h.date||"—")}</td>
          <td>${h.kind==="pay"?`<span class="badge badge-3">入金</span>`:`<span class="badge badge-4">返金</span>`}</td>
          <td class="num" style="${h.kind==="refund"?"color:var(--color-danger)":""}">${h.kind==="refund"?"−":""}${yen(h.amount)}</td>
          <td class="num">${yen(run)}</td>
          <td style="font-size:12px">${esc(h.note)}</td>
          <td style="white-space:nowrap"><button class="btn btn-danger ${h.kind==="pay"?"pay-del":"refund-del"}" data-idx="${h.idx}" style="font-size:11px;padding:2px 8px" aria-label="この記録を取り消す"><i class="ti ti-x" aria-hidden="true"></i> 取消</button></td></tr>`;
        }).join("")
      }</tbody></table></div>`
    : `<p style="font-size:13px;color:var(--color-ink-muted);margin:0">入金・返金の記録はまだありません</p>`;
  document.getElementById("payAmount").value = remain>0?String(remain):"";
  document.getElementById("payDate").value = today();
  document.getElementById("payNote").value = "";
  document.getElementById("refundAmount").value = creditBalanceOf(s)>0?String(creditBalanceOf(s)):"";
  document.getElementById("refundDate").value = today();
  document.getElementById("refundNote").value = "";
  document.getElementById("payError").style.display="none";
  document.querySelectorAll(".pay-del").forEach(b=>b.addEventListener("click",()=>deletePayment(Number(b.dataset.idx))));
  document.querySelectorAll(".refund-del").forEach(b=>b.addEventListener("click",()=>deleteRefund(Number(b.dataset.idx))));
  document.getElementById("payModal").classList.add("open");
}
// payments[] / refunds[] を書き戻し、残額0で入金済・残ありは請求済のまま（部分入金）に整える
async function savePayments(s, list, msg, refunds){
  const rlist = refunds || refundList(s);
  const sum=list.reduce((a,p)=>a+(Number(p.amount)||0),0);
  const rsum=rlist.reduce((a,r)=>a+(Number(r.amount)||0),0);
  const net=sum-rsum;
  const remain=shipTotalIncl(s)-creditApplied(s)-net; // 過入金の充当分・返金分を差し引いた残額で判定
  const lastDate=list.length?(list[list.length-1].date||today()):"";
  await updateDoc(doc(db,"shipments",s._id),{
    payments:list,
    refunds:rlist,
    paymentAmount:net,                          // 旧フィールドは純額で同期（集計・請求書との互換）
    refundAmount:rsum,
    paidAt: remain<=0 ? lastDate : "",
    status: remain<=0 ? "paid" : "invoiced",
    updatedAt:serverTimestamp(), updatedBy:currentUser.displayName||currentUser.email });
  document.getElementById("payModal").classList.remove("open");
  payingShip=null;
  toast(msg);
}
// 返金の記録（過入金を返した／返品・キャンセルで返した）
async function addRefund(){
  const s=payingShip; if(!s) return;
  const err=document.getElementById("payError"); err.style.display="none";
  const amt=parseInt(String(document.getElementById("refundAmount").value).replace(/[^0-9]/g,""),10);
  const date=document.getElementById("refundDate").value;
  if(!(amt>0)){ err.textContent="返金額を入力してください（1円以上）"; err.style.display="block"; return; }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ err.textContent="返金日を選んでください"; err.style.display="block"; return; }
  const bal=creditBalanceOf(s);
  if(amt>bal){
    const over=amt-bal;
    if(!confirm(`未充当の過入金は ${yen(bal)} です。${yen(amt)} を返金すると ${yen(over)} 分だけ入金が請求額を下回り、この出荷は「請求済（未集金 ${yen(over)}）」に戻ります。\n\n返品・キャンセルに伴う返金ならこのまま進めてください（出荷そのものを取り消す場合は、出荷の削除でキャンセルしてください）。\n\n続けますか？`)) return;
  }
  const list=refundList(s).concat([{ amount:amt, date,
    method:document.getElementById("refundMethod").value||"振込",
    note:document.getElementById("refundNote").value.trim(),
    recordedBy:currentUser.displayName||currentUser.email, recordedAt:new Date().toISOString() }]);
  const btn=document.getElementById("saveRefundBtn"); btn.disabled=true;
  try{ await savePayments(s, payList(s), `返金を記録しました（${yen(amt)}）`, list); }
  catch(e){ err.textContent=`記録に失敗: ${e.message}`; err.style.display="block"; }
  finally{ btn.disabled=false; }
}
async function deleteRefund(idx){
  const s=payingShip; if(!s) return;
  const list=refundList(s).slice();
  const r=list[idx]; if(!r) return;
  if(!confirm(`${r.date||""} の返金 ${yen(Number(r.amount)||0)} を取り消します。よろしいですか？`)) return;
  list.splice(idx,1);
  try{ await savePayments(s, payList(s), "返金の記録を取り消しました", list); }
  catch(e){ alert(`取消に失敗: ${e.message}`); }
}
async function addPayment(){
  const s=payingShip; if(!s) return;
  const err=document.getElementById("payError"); err.style.display="none";
  const amt=parseInt(String(document.getElementById("payAmount").value).replace(/[^0-9]/g,""),10);
  const date=document.getElementById("payDate").value;
  if(!(amt>0)){ err.textContent="入金額を入力してください（1円以上）"; err.style.display="block"; return; }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ err.textContent="入金日を選んでください"; err.style.display="block"; return; }
  const remain=payRemain(s);
  if(amt>remain && !confirm(`残額 ${yen(remain)} を超える入金です（${yen(amt)}）。\n差額 ${yen(amt-remain)} は過入金として記録し、同じ請求先の次回の請求から差し引けます。\n\nこの金額で記録しますか？`)) return;
  const list=payList(s).concat([{ amount:amt, date, note:document.getElementById("payNote").value.trim(),
    recordedBy:currentUser.displayName||currentUser.email, recordedAt:new Date().toISOString() }]);
  const btn=document.getElementById("savePayBtn"); btn.disabled=true;
  try{ await savePayments(s, list, `入金を記録しました（${yen(amt)}）`); }
  catch(e){ err.textContent=`記録に失敗: ${e.message}`; err.style.display="block"; }
  finally{ btn.disabled=false; }
}
async function deletePayment(idx){
  const s=payingShip; if(!s) return;
  const list=payList(s).slice();
  const p=list[idx]; if(!p) return;
  if(!confirm(`${p.date||""} の入金 ${yen(Number(p.amount)||0)} を取り消します。よろしいですか？`)) return;
  list.splice(idx,1);
  try{ await savePayments(s, list, "入金の記録を取り消しました"); }
  catch(e){ alert(`取消に失敗: ${e.message}`); }
}

// ===== 過入金を次回の請求に充当する =====
// 充当元を人が選ぶ方式（2026-08-12 変更）。同じ請求先の過入金は既定でチェック済み・古い分から自動配分し、
// 別請求先（グループ会社）の過入金は「選べるが既定はオフ」にする＝勝手に他社の入金を回さない。
// 充当元には overpayUsed を積み、充当先には creditApplied と充当元の内訳（creditFrom）を残す。
let creditTargetShip=null;
function openCreditModal(s){
  creditTargetShip=s;
  const remain=payRemain(s);
  const same=creditSourcesFor(s), cross=crossCreditSourcesFor(s);
  if(!(same.length||cross.length)){ alert("充当できる過入金がありません（どの請求先にも未充当の過入金がない状態です）"); return; }
  if(!(remain>0)){ alert(`${s.soNumber} は残額がないため充当できません`); return; }
  document.getElementById("creditTargetInfo").innerHTML =
    `<strong>${esc(s.soNumber)}</strong>（${esc(billToOf(s))}）／請求額（税込）${yen(shipTotalIncl(s))}`
    + (creditApplied(s)>0?`　既に充当 −${yen(creditApplied(s))}`:"")
    + `　／　<strong>残額 ${yen(remain)}</strong>`;
  // 同じ請求先の分は残額を埋めるまで古い順に自動で金額を入れておく（今までの挙動と同じ結果になる）
  let fill=remain;
  const row=(x,cross)=>{
    const bal=creditBalanceOf(x);
    const pre=cross?0:Math.min(bal,fill);
    if(!cross) fill-=pre;
    return `<tr data-id="${x._id}">
      <td><input type="checkbox" class="cs-use" ${pre>0?"checked":""} aria-label="${esc(x.soNumber)} を充当元にする"></td>
      <td><strong>${esc(x.soNumber)}</strong><div style="font-size:12px;color:var(--color-ink-muted)">${esc(x.shipDate||"")}</div></td>
      <td>${esc(billToOf(x))}<div>${cross?`<span class="badge badge-4">別請求先</span>`:`<span class="badge badge-3">同じ請求先</span>`}</div></td>
      <td class="num">${yen(bal)}</td>
      <td><input class="form-control cs-amt num" type="number" min="0" step="1" max="${bal}" value="${pre}" style="width:120px" aria-label="${esc(x.soNumber)} から充当する金額"></td>
    </tr>`;
  };
  document.getElementById("creditSourceBody").innerHTML =
    same.map(x=>row(x,false)).join("") + cross.map(x=>row(x,true)).join("");
  document.getElementById("creditCrossNote").style.display = cross.length?"block":"none";
  document.getElementById("creditError").style.display="none";
  recalcCredit();
  document.getElementById("creditModal").classList.add("open");
}
// 充当額の合計と充当後の残額を出す（イベントは初期化時に1度だけ張る）
function recalcCredit(){
  const s=creditTargetShip; if(!s) return;
  const remain=payRemain(s);
  let sum=0;
  document.querySelectorAll("#creditSourceBody tr").forEach(tr=>{
    const on=tr.querySelector(".cs-use").checked;
    const amt=Number(tr.querySelector(".cs-amt").value)||0;
    if(on) sum+=amt;
    tr.querySelector(".cs-amt").disabled=!on;
  });
  const over=sum>remain;
  document.getElementById("creditSumInfo").innerHTML =
    `充当額の合計 <strong style="color:${over?"var(--color-danger)":"inherit"}">${yen(sum)}</strong>`
    + `　／　充当後の残額 <strong>${yen(Math.max(0,remain-sum))}</strong>`
    + (over?`　<strong style="color:var(--color-danger)">残額を超えています</strong>`:"");
  document.getElementById("doApplyCreditBtn").disabled = !(sum>0) || over;
}
async function doApplyCredit(){
  const s=creditTargetShip; if(!s) return;
  const err=document.getElementById("creditError"); err.style.display="none";
  const picks=[];
  document.querySelectorAll("#creditSourceBody tr").forEach(tr=>{
    if(!tr.querySelector(".cs-use").checked) return;
    const amt=Number(tr.querySelector(".cs-amt").value)||0;
    if(amt>0) picks.push({ id:tr.dataset.id, amount:amt });
  });
  if(!picks.length){ err.textContent="充当元を選び、金額を入れてください"; err.style.display="block"; return; }
  const remain=payRemain(s);
  const use=picks.reduce((a,p)=>a+p.amount,0);
  if(use>remain){ err.textContent=`充当額の合計（${yen(use)}）が残額（${yen(remain)}）を超えています`; err.style.display="block"; return; }
  // 充当元の残高チェック＋別請求先が混ざる場合は必ず確認する（グループ間で回す判断は人が明示する）
  const srcs=picks.map(p=>({ ...p, ship:shipments.find(x=>x._id===p.id) })).filter(x=>x.ship);
  for(const x of srcs){
    if(x.amount>creditBalanceOf(x.ship)){
      err.textContent=`${x.ship.soNumber} の未充当の過入金（${yen(creditBalanceOf(x.ship))}）を超えています`; err.style.display="block"; return;
    }
  }
  const crossList=srcs.filter(x=>billToKey(x.ship)!==billToKey(s));
  if(crossList.length){
    const d=crossList.map(x=>`　・${x.ship.soNumber}（${billToOf(x.ship)}）から ${yen(x.amount)}`).join("\n");
    if(!confirm(`別の請求先の過入金を ${billToOf(s)} の請求に充当します（グループ会社間の充当）。\n\n${d}\n\n請求書には充当元の請求先名が印字されます。相手先の合意が取れている場合のみ進めてください。\n\n続けますか？`)) return;
  }
  const btn=document.getElementById("doApplyCreditBtn"); btn.disabled=true;
  try{
    const from=[];
    for(const x of srcs){
      await updateDoc(doc(db,"shipments",x.id),{
        overpayUsed:(Number(x.ship.overpayUsed)||0)+x.amount,
        updatedAt:serverTimestamp(), updatedBy:currentUser.displayName||currentUser.email });
      from.push({ shipmentId:x.id, soNumber:x.ship.soNumber||"", amount:x.amount, date:today(),
        fromBillTo:billToOf(x.ship), crossBillTo:billToKey(x.ship)!==billToKey(s),
        appliedBy:currentUser.displayName||currentUser.email });
    }
    const applied=creditApplied(s)+use;
    const newRemain=Math.max(0, shipTotalIncl(s)-applied-netPaid(s));
    const lastPay=payList(s).slice(-1)[0];
    await updateDoc(doc(db,"shipments",s._id),{
      creditApplied:applied,
      creditFrom:(Array.isArray(s.creditFrom)?s.creditFrom:[]).concat(from),
      status: newRemain<=0 ? "paid" : "invoiced",
      paidAt: newRemain<=0 ? (lastPay?.date || today()) : "",
      updatedAt:serverTimestamp(), updatedBy:currentUser.displayName||currentUser.email });
    document.getElementById("creditModal").classList.remove("open");
    document.getElementById("payModal").classList.remove("open");
    creditTargetShip=null; payingShip=null;
    toast(`過入金 ${yen(use)} を ${s.soNumber} に充当しました${newRemain<=0?"（入金済になりました）":""}`);
  }catch(e){ err.textContent=`充当に失敗: ${e.message}`; err.style.display="block"; }
  finally{ btn.disabled=false; }
}

// ===== 未集金の催促メール（期限超過の請求先へ・発注書メールと同じGmail基盤）=====
const DEFAULT_DUNNING_SUBJECT = "【ご確認のお願い】お振込みの状況について（{{請求先}}）";
const DEFAULT_DUNNING_BODY = `{{請求先}}
ご担当者様

いつもお世話になっております。NPO法人タダカヨです。

下記のご請求につきまして、本日時点でお振込みの確認ができておりません。
恐れ入りますが、ご確認いただけますでしょうか。

　請求書番号：{{請求書番号}}
　ご請求金額（税込）：{{金額}}
　お支払期限：{{支払期限}}

行き違いでお振込みいただいておりましたら申し訳ございません。
その場合は本メールをご放念ください。

ご不明点がございましたら、本メールにご返信ください。
よろしくお願いいたします。

--
NPO法人タダカヨ 介護情報基盤事務局`;
let dunningShip=null;
async function openDunning(s){
  dunningShip=s;
  let st={};
  try{ const ss=await getDoc(doc(db,"appConfig","settings")); st=ss.exists()?ss.data():{}; }catch(_){}
  const invNo=(s.soNumber||"").replace(/^SH/,"INV");
  const fill=(t)=>String(t||"")
    .split("{{請求先}}").join(billToOf(s))
    .split("{{請求書番号}}").join(invNo)
    .split("{{出荷番号}}").join(s.soNumber||"")
    .split("{{金額}}").join("¥"+payRemain(s).toLocaleString("ja-JP"))
    .split("{{支払期限}}").join(dueDateOf(s)||"（未設定）")
    .split("{{超過日数}}").join(String(overdueDays(s)));
  document.getElementById("dunTo").value = billToEmailOf(s)||"";
  document.getElementById("dunSubject").value = fill(st.dunningMailSubject || DEFAULT_DUNNING_SUBJECT);
  document.getElementById("dunBody").value = fill(st.dunningMailBody || DEFAULT_DUNNING_BODY);
  document.getElementById("dunInfo").textContent =
    `${s.soNumber}／${billToOf(s)}／未集金 ${yen(payRemain(s))}（税込）／支払期限 ${dueDateOf(s)||"未設定"}・${overdueDays(s)}日超過`;
  document.getElementById("dunError").style.display="none";
  document.getElementById("dunModal").classList.add("open");
}
async function sendDunning(){
  const s=dunningShip; if(!s) return;
  const to=document.getElementById("dunTo").value.trim();
  const subject=document.getElementById("dunSubject").value.trim();
  const body=document.getElementById("dunBody").value;
  const err=document.getElementById("dunError"); err.style.display="none";
  if(!to||!subject||!body.trim()){ err.textContent="宛先・件名・本文は必須です"; err.style.display="block"; return; }
  const btn=document.getElementById("sendDunBtn"); const orig=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2 ti-spin"></i> 送信中...';
  try{
    await sendPartnerMailFn({ to, subject, body, shipmentId:s._id, kind:"dunning" });
    document.getElementById("dunModal").classList.remove("open");
    dunningShip=null;
    toast(`${s.soNumber} の催促メールを送信しました`);
  }catch(e){ err.textContent=`送信に失敗: ${e.message||e}`; err.style.display="block"; }
  finally{ btn.disabled=false; btn.innerHTML=orig; }
}

// ===== 請求済にする＋経理へ請求書発行を報告（2026-08-11 追加）=====
// Google Chat の Webhook はファイルを添付できない仕様のため、PDFはメールに添付し Chat にはリンクを載せる。
// 「経理へ報告する」を外せば報告なしで請求済にできる（再発行のときはこちら）。
let invReportShip = null;
let invReportOnly = false; // true = すでに請求済のものを後から報告する（ステータスは変えない）
async function openInvoiceReport(s, opts){
  invReportShip = s;
  invReportOnly = !!(opts && opts.reportOnly);
  let st = {};
  try{ const ss=await getDoc(doc(db,"appConfig","settings")); st=ss.exists()?ss.data():{}; }catch(_){}
  const invNo = invoiceNoOf(s);
  // 金額は一覧と同じ billableIncl（＝税込合計−過入金の充当）を使う。
  // invoice-doc.js の invoiceTotals().payable と同値だが、一覧表示とズレないよう supply.js 側の関数を正とする
  const amountText = yen(billableIncl(s));
  // 請求月: 新規はこれから請求済にするので当日。後追い報告は既存の請求日を使う（請求書の記載とズレないように）
  const invoicedAt = invReportOnly ? (s.invoicedAt || today()) : today();
  // 支払期限は請求書の記載（請求月の翌月末）と一致させる
  const due = dueDateOf({ ...s, status:"invoiced", invoicedAt }) || "";
  const deliverTo = [s.company, s.officeName].filter(Boolean).join(" / ");
  const contactName = (st.accountingContactName || "").trim();
  const acctEmail = (st.accountingEmail || "").trim();
  const webhook = (st.accountingChatWebhookUrl || "").trim();

  const fill=(t)=>String(t||"")
    .split("{{経理担当}}").join(contactName || "経理ご担当")
    .split("{{請求書番号}}").join(invNo)
    .split("{{請求先}}").join(billToOf(s))
    .split("{{納品先}}").join(deliverTo)
    .split("{{請求金額}}").join(amountText)
    .split("{{支払期限}}").join(due || "（未設定）")
    .split("{{出荷番号}}").join(s.soNumber||"")
    .split("{{出荷日}}").join(s.shipDate||"");

  document.getElementById("invReportTitle").textContent = invReportOnly
    ? `経理へ報告（${s.soNumber}）` : `請求済にする（${s.soNumber}）`;
  document.getElementById("invReportSummary").innerHTML =
    `<div><strong>請求書番号</strong>　${esc(invNo)}</div>`
    + `<div><strong>請求先</strong>　${esc(billToOf(s))}</div>`
    + (deliverTo?`<div><strong>納品先</strong>　${esc(deliverTo)}</div>`:"")
    + `<div><strong>請求金額（税込）</strong>　${esc(amountText)}</div>`
    + `<div><strong>支払期限</strong>　${esc(due||"（未設定）")}</div>`
    + (s.accountingReportedAt
        ? `<div style="color:var(--color-warn,#c87a1f);margin-top:4px"><i class="ti ti-alert-triangle"></i> この出荷は ${esc(s.accountingReportedAt)} に経理へ報告済みです（再発行ならチェックを外してください）</div>`
        : "");

  // 報告先の表示（未設定なら設定画面へ促す）
  const destParts = [];
  if(webhook) destParts.push("経理スペースへChat投稿"); else destParts.push("Chat未設定（投稿しません）");
  if(acctEmail) destParts.push(`${acctEmail} へPDF添付メール${contactName?`（${contactName}さん）`:""}`);
  else destParts.push("経理メール未設定（送信しません）");
  const ready = !!(webhook || acctEmail);
  document.getElementById("invReportDest").innerHTML = ready
    ? esc(destParts.join(" ／ "))
    : `<span style="color:var(--color-danger)">報告先が未設定です。「設定」画面の「経理への請求書発行報告」で登録してください</span>`;

  const cb = document.getElementById("invReportSend");
  // 再発行（すでに報告済み）と報告先未設定のときは既定OFF。それ以外はON
  // 後追い報告は「報告する」以外の用がないので常にON・チェックボックス自体を隠す
  cb.checked = ready && (invReportOnly || !s.accountingReportedAt);
  cb.disabled = !ready;
  // 報告先が未設定のときは後追い報告でも表示する（理由がわからないと直せないため）
  cb.closest("label").style.display = (invReportOnly && ready) ? "none" : "flex";
  document.getElementById("invReportSubject").value = fill(st.invoiceMailSubject || DEFAULT_INVOICE_MAIL_SUBJECT);
  document.getElementById("invReportBody").value = fill(st.invoiceMailBody || DEFAULT_INVOICE_MAIL_BODY);
  // PDF生成の対象。請求書の発行日は請求済にする当日＝請求書PDFの記載と支払期限を揃える
  document.getElementById("invReportPreview").innerHTML =
    `<style>${INVOICE_STYLE}</style>` + renderInvoiceHtml({ ...s, invoicedAt }, st);
  document.getElementById("invReportError").style.display="none";
  syncInvReportFields();
  document.getElementById("invReportModal").classList.add("open");
}
// 「経理へ報告する」のON/OFFで、メール件名・本文・プレビューの表示とボタン名を切り替える
function syncInvReportFields(){
  const on = document.getElementById("invReportSend").checked;
  document.getElementById("invReportFields").style.display = on ? "block" : "none";
  document.getElementById("doInvReportBtn").innerHTML = invReportOnly
    ? '<i class="ti ti-send" aria-hidden="true"></i>経理へ報告する'
    : (on ? '<i class="ti ti-send" aria-hidden="true"></i>請求済にして報告'
          : '<i class="ti ti-check" aria-hidden="true"></i>請求済にする（報告なし）');
}
async function doInvoiceReport(){
  const s = invReportShip; if(!s) return;
  const send = document.getElementById("invReportSend").checked;
  const subject = document.getElementById("invReportSubject").value.trim();
  const body = document.getElementById("invReportBody").value;
  const err = document.getElementById("invReportError"); err.style.display="none";
  if(send && (!subject || !body.trim())){ err.textContent="件名・本文は必須です"; err.style.display="block"; return; }
  if(invReportOnly && !send){ err.textContent="報告先が未設定です。「設定」画面で登録してください"; err.style.display="block"; return; }
  const btn = document.getElementById("doInvReportBtn"); const orig = btn.innerHTML;
  btn.disabled = true;
  try{
    // 1) まず請求済にする（報告が失敗しても請求済の記録は残す）。後追い報告のときは状態を変えない
    let cur;
    if(invReportOnly){
      cur = { ...s };
    }else{
      btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> 請求済にしています...';
      const invoicedAt = today();
      await updateDoc(doc(db,"shipments",s._id),{ status:"invoiced", invoicedAt, updatedAt:serverTimestamp() });
      cur = { ...s, status:"invoiced", invoicedAt };
    }

    // 2) 経理へ報告（PDFはブラウザで生成 → 関数がStorage保存・メール添付・Chat投稿）
    let warn = [];
    if(send){
      btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> 請求書PDFを作成中...';
      const el = document.querySelector("#invReportPreview .inv");
      if(!el) throw new Error("請求書プレビューが見つかりません");
      const invNo = invoiceNoOf(s);
      const filename = `${invNo}.pdf`;
      const opt = { margin:[10,8,10,8], filename, image:{type:"jpeg",quality:0.95},
        html2canvas:{scale:2,useCORS:true,backgroundColor:"#ffffff"}, jsPDF:{unit:"mm",format:"a4",orientation:"portrait"} };
      const dataUri = await window.html2pdf().set(opt).from(el).outputPdf("datauristring");
      const pdfBase64 = String(dataUri).split(",")[1] || "";
      btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> 経理へ報告中...';
      const res = await reportInvoiceFn({
        shipmentId: s._id, pdfBase64, filename, subject, body,
        invNo, billName: billToOf(s),
        deliverTo: [s.company, s.officeName].filter(Boolean).join(" / "),
        amountText: yen(billableIncl(s)),
        dueDate: dueDateOf(cur) || "",
        soNumber: s.soNumber || "", shipDate: s.shipDate || "",
      });
      warn = (res && res.data && res.data.warnings) || [];
    }

    document.getElementById("invReportModal").classList.remove("open");
    const wasReportOnly = invReportOnly;
    invReportShip = null;
    if(warn.length) toast(`経理への報告に一部失敗しました: ${warn[0]}`);
    else if(wasReportOnly) toast("経理へ報告しました");
    else if(send) toast("請求済にして経理へ報告しました");
    else toast("請求済にしました（経理への報告なし）");
    if(warn.length) console.warn("経理報告の警告:", warn);

    // 3) 同じ請求先に未充当の過入金があれば、その場で「次回の請求から引く」を提案する（従来の挙動を維持）
    if(!wasReportOnly && creditBalanceForBillTo(cur)>0) openCreditModal(cur);
  }catch(e){
    err.textContent = `失敗: ${e.message||e}`; err.style.display="block";
  }finally{ btn.disabled=false; btn.innerHTML=orig; }
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
    // この受注に紐づく出荷の請求・入金状況（受注一覧からも入金確認できるように）
    const rel=shipments.filter(s=>s.partnerOrderId===o._id && s.status!=="canceled");
    const relRemain=rel.reduce((a,s)=>a+payRemain(s),0);
    const relOverdue=rel.some(s=>isUnpaid(s)&&overdueDays(s)>0);
    const payCell = !rel.length ? `<span style="font-size:12px;color:var(--color-ink-muted)">—</span>`
      : rel.some(s=>s.status==="shipped") && relRemain===0 ? `<span style="font-size:12px;color:var(--color-ink-muted)">未請求</span>`
      : relRemain>0
        ? `<div style="font-size:12px;color:var(--color-danger)">未集金 ${yen(relRemain)}${relOverdue?"（期限超過）":""}</div><div style="font-size:12px;color:var(--color-ink-muted)">${rel.map(s=>esc(s.soNumber)).join(", ")}</div>`
        : `<div style="font-size:12px;color:var(--color-success)">入金済 ${yen(rel.reduce((a,s)=>a+netPaid(s),0))}</div><div style="font-size:12px;color:var(--color-ink-muted)">${rel.map(s=>esc(s.soNumber)).join(", ")}</div>`;
    return `<tr>
      <td>${o.soNumber?`<strong>${esc(o.soNumber)}</strong><div style="font-size:12px;color:var(--color-ink-muted)">${fmtDT(o.createdAt)}</div>`:fmtDT(o.createdAt)}${o.partnerOrderNo?`<div style="font-size:12px;color:var(--color-ink-muted)">先方No: ${esc(o.partnerOrderNo)}</div>`:""}</td>
      <td>${esc(o.partnerName||o.partnerEmail||"")}</td>
      <td>${esc(sh.officeName||"")}${sh.company?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(sh.company)}</div>`:""}</td>
      <td style="font-size:12px">${esc(sum)}</td>
      <td><select class="form-control po-status" data-id="${o._id}" style="padding:4px 8px;font-size:12px">${opts}</select></td>
      <td>${payCell}</td>
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

/* ===== 発注ファイル（CSV/JSON）の取込 — 仕様書§3 =====
   認定事業所ポータルを使わず、メールでファイルを送ってくる相手の受け口。
   パースと検証は partner-order-import.js（副作用なし・単体テスト済み）に分離している。 */
let importCandidates = [];

function openImportModal(){
  importCandidates = [];
  document.getElementById("importFiles").value = "";
  document.getElementById("importErrors").style.display = "none";
  document.getElementById("importPreview").style.display = "none";
  document.getElementById("importEmpty").style.display = "none";
  document.getElementById("doImportBtn").disabled = true;
  document.getElementById("importModal").classList.add("open");
}
function closeImportModal(){ document.getElementById("importModal").classList.remove("open"); }

async function onImportFilesPicked(e){
  const files = [...(e.target.files || [])];
  const errors = [];
  const orders = [];
  const findProduct = (sku)=> products.find(p=>p.id===sku);

  for(const f of files){
    const text = await f.text();
    const r = parseOrderFile(f.name, text, findProduct);
    r.errors.forEach(msg=>errors.push(`${f.name}: ${msg}`));
    orders.push(...r.orders);
  }
  // 同じ発注番号が既に取り込まれていないか（二重取込の防止）
  const dup = new Set();
  for(const o of orders){
    const q = await getDocs(query(collection(db,"partnerOrders"),where("partnerOrderNo","==",o.partnerOrderNo)));
    if(!q.empty) dup.add(o.partnerOrderNo);
  }
  dup.forEach(no=>errors.push(`発注番号 ${no} はすでに取り込み済みです（重複のため登録しません）`));
  importCandidates = orders.filter(o=>!dup.has(o.partnerOrderNo));

  const errBox = document.getElementById("importErrors");
  errBox.style.display = errors.length ? "block" : "none";
  errBox.innerHTML = errors.map(esc).join("<br>");

  const has = importCandidates.length > 0;
  document.getElementById("importPreview").style.display = has ? "block" : "none";
  document.getElementById("importEmpty").style.display = (!has && files.length) ? "block" : "none";
  document.getElementById("doImportBtn").disabled = !has;
  document.getElementById("importBody").innerHTML = importCandidates.map(o=>{
    const sum = o.items.map(i=>`${i.sku}×${i.qty}`).join(", ");
    const sh = o.shipping || {};
    return `<tr>
      <td>${esc(o.partnerOrderNo)}<div style="font-size:12px;color:var(--color-ink-muted)">${esc(o.partnerId||"")}</div></td>
      <td>${esc(o.partnerEmail||"")}</td>
      <td>${esc(sh.officeName||"")}<div style="font-size:12px;color:var(--color-ink-muted)">${esc(sh.address||"")}</div></td>
      <td style="font-size:12px">${esc(sum)}</td>
      <td>${esc(o.desiredDeliveryDate||"—")}</td>
    </tr>`;
  }).join("");
}

async function runImport(){
  const btn = document.getElementById("doImportBtn");
  btn.disabled = true;
  try{
    for(const o of importCandidates){
      // 認定事業所名は partners マスタから解決（メール一致・無ければファイルの値のまま）
      const partner = activePartners.find(p=>p._id===o.partnerEmail) || {};
      const soNumber = seqFmt("SO", await nextSeq("partnerOrders"));
      await addDoc(collection(db,"partnerOrders"),{
        soNumber, partnerOrderNo:o.partnerOrderNo,
        partnerId:o.partnerId||"", partnerEmail:o.partnerEmail||"",
        partnerName:partner.partnerName||o.partnerName||"",
        contact:o.contact, items:o.items, shipping:o.shipping,
        orderDate:o.orderDate||"", desiredDeliveryDate:o.desiredDeliveryDate||"",
        isSubsidyApplied:!!o.isSubsidyApplied, subsidyCategory:o.subsidyCategory||"",
        note:o.note||"", source:o.source, status:"received",
        createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email,
      });
    }
    toast(`${importCandidates.length}件の受注を取り込みました`);
    closeImportModal();
  }catch(e){
    const errBox = document.getElementById("importErrors");
    errBox.style.display="block"; errBox.textContent=`登録に失敗しました: ${e.message}`;
  }finally{ btn.disabled = false; }
}

// 受注（認定事業所）→ 出荷（直送）へ変換
async function shipFromOrder(o){
  const sh=o.shipping||{};
  const items=(o.items||[]).map(it=>{
    const p=products.find(x=>x.id===it.sku)||{};
    return { sku:it.sku, name:it.name||p.name||it.sku, qty:Number(it.qty)||0, unitPrice:partnerPriceFor(p, Number(it.qty)||0) };
  }).filter(it=>it.qty>0);
  if(!items.length){ alert("発注内容が空です"); return; }
  for(const it of items){ const p=products.find(x=>x.id===it.sku);
    if(!p || (p.stock||0)<it.qty){ alert(`在庫不足: ${it.name}（在庫 ${p?p.stock||0:0} / 必要 ${it.qty}）。先に在庫を補充してください`); return; } }
  if(!confirm(`受注（${o.partnerName||o.partnerEmail}）を直送出荷として登録します。\n送付先: ${sh.officeName||""}\n在庫から引き落とします。よろしいですか？`)) return;
  try{
    const soNumber=seqFmt("SH",await nextSeq("shipments"));
    const packs=Math.max(1,Math.ceil(items.reduce((a,i)=>a+i.qty,0)/3));
    await addDoc(collection(db,"shipments"),{
      soNumber, shipType:"dropship", partnerEmail:o.partnerEmail||"", partnerName:o.partnerName||"",
      status:"shipped", partnerOrderId:o._id,
      shippingMethod:"letterpack", shippingFee:taxExcl(packs*letterpackFee()), shippingLabel:`送料（レターパック ${packs}通）`,
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
        <button class="btn btn-secondary guide-partner" data-email="${esc(p._id)}" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-forward"></i>発注案内${p.guideSentAt?`（済 ${esc(p.guideSentAt.slice(5).replace("-","/"))}）`:""}</button>
        <a class="btn btn-secondary" href="/supply-print.html?type=plabel&pid=${encodeURIComponent(p._id)}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-fast"></i>宛名</a>
        <button class="btn btn-secondary toggle-partner" data-email="${esc(p._id)}" data-active="${p.active!==false}" style="font-size:12px;padding:4px 8px">${p.active!==false?"停止":"有効化"}</button>
        <button class="btn btn-danger del-partner" data-email="${esc(p._id)}" data-name="${esc(p.partnerName||"")}" style="font-size:12px;padding:4px 8px"><i class="ti ti-trash"></i></button>
      </td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".edit-partner").forEach(b=>b.addEventListener("click",()=>{
    const p=partnersCache.find(x=>x._id===b.dataset.email); if(p) openPartnerModal(p);
  }));
  document.querySelectorAll(".guide-partner").forEach(b=>b.addEventListener("click",()=>{
    const p=partnersCache.find(x=>x._id===b.dataset.email); if(p) openGuideMail(p);
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

// ===== 発注方法のご案内メール（認定事業所へ・催促メールと同じGmail基盤）=====
const PORTAL_URL = "https://kjk-tadakayo-admin.web.app/partner";
const ORDER_TEMPLATE_URL = "https://kjk.tadakayo.jp/発注テンプレート.csv";
const DEFAULT_GUIDE_SUBJECT = "【タダカヨ】カードリーダーのご発注方法のご案内（{{事業所名}}）";
const DEFAULT_GUIDE_BODY = `{{事業所名}}
ご担当者様

いつもお世話になっております。NPO法人タダカヨです。
カードリーダーのご発注方法をご案内いたします。
下記のどちらか、ご都合のよい方法でご発注ください。

■ 方法1: 発注ポータルから（おすすめ）
次のURLを開き、Googleアカウントでログインしてご発注いただけます。
　{{ポータルURL}}
　ログイン用メールアドレス: {{ログインメール}}
　※上記メールアドレスのGoogleアカウントでログインしてください。
　　別のアドレスではログインできません（変更をご希望の場合はご連絡ください）。
　※ログイン後、画面の案内に沿って品目・数量・お届け先をご入力ください。

■ 方法2: 発注ファイルをメールで送る
ポータルをお使いにならない場合は、次のテンプレート（CSV）にご記入のうえ、
本メールへの返信に添付してお送りください。
　テンプレート: {{テンプレートURL}}
　※1行目が項目名、2行目が記入例です。記入例を書き換えてお使いください。
　※複数の品目をご注文の場合は、同じ発注番号で行を分けてご記入ください。

ご不明な点がございましたら、本メールにご返信ください。
よろしくお願いいたします。

--
NPO法人タダカヨ 介護情報基盤事務局`;
let guidingPartner=null;
async function openGuideMail(p){
  guidingPartner=p;
  let st={};
  try{ const ss=await getDoc(doc(db,"appConfig","settings")); st=ss.exists()?ss.data():{}; }catch(_){}
  const fill=(t)=>String(t||"")
    .split("{{事業所名}}").join(p.partnerName||"")
    .split("{{法人名}}").join(p.corpName||"")
    .split("{{ログインメール}}").join(p._id||"")
    .split("{{ポータルURL}}").join(PORTAL_URL)
    .split("{{テンプレートURL}}").join(ORDER_TEMPLATE_URL);
  document.getElementById("guideTo").value = p._id||"";
  // 連絡用メールがログイン用と別に登録されていれば CC に入れておく（不要なら消せる）
  document.getElementById("guideCc").value = (p.contactEmail && p.contactEmail!==p._id) ? p.contactEmail : "";
  document.getElementById("guideSubject").value = fill(st.guideMailSubject || DEFAULT_GUIDE_SUBJECT);
  document.getElementById("guideBody").value = fill(st.guideMailBody || DEFAULT_GUIDE_BODY);
  document.getElementById("guideInfo").textContent =
    `${p.partnerName||""}${p.corpName?`（${p.corpName}）`:""}／ログイン用メール ${p._id}`
    + (p.guideSentAt?`／前回送信 ${p.guideSentAt}`:"");
  document.getElementById("guideError").style.display="none";
  document.getElementById("guideModal").classList.add("open");
}
async function sendGuideMail(){
  const p=guidingPartner; if(!p) return;
  const to=document.getElementById("guideTo").value.trim();
  const cc=document.getElementById("guideCc").value.trim();
  const subject=document.getElementById("guideSubject").value.trim();
  const body=document.getElementById("guideBody").value;
  const err=document.getElementById("guideError"); err.style.display="none";
  if(!to||!subject||!body.trim()){ err.textContent="宛先・件名・本文は必須です"; err.style.display="block"; return; }
  const btn=document.getElementById("sendGuideBtn"); const orig=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='<i class="ti ti-loader-2 ti-spin"></i> 送信中...';
  try{
    await sendPartnerMailFn({ to, cc: cc||undefined, subject, body, kind:"guide" });
    const day=today();
    await updateDoc(doc(db,"partners",p._id),{
      guideSentAt: day,
      guideMailLog: arrayUnion({ to, cc, subject, sentAt: day, sentBy: currentUser.displayName||currentUser.email }),
      updatedAt: serverTimestamp(),
    });
    document.getElementById("guideModal").classList.remove("open");
    guidingPartner=null;
    toast(`${p.partnerName||to} へ発注方法のご案内を送信しました`);
  }catch(e){ err.textContent=`送信に失敗: ${e.message||e}`; err.style.display="block"; }
  finally{ btn.disabled=false; btn.innerHTML=orig; }
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
  ["shipMethod","shipYuSize","shipYuRegion"].forEach(id=>document.getElementById(id).addEventListener("change",recalcShipFee));

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
  // 出荷一覧（受注タブの入金状況にも使うので保持して再描画する）
  onSnapshot(query(collection(db,"shipments"),orderBy("createdAt","desc")),(snap)=>{
    shipments=snap.docs.map(d=>({_id:d.id,...d.data()}));
    renderShipments(shipments);
    if(partnerOrdersCache.length) renderPartnerOrders(partnerOrdersCache);
  });
  // 受注（認定事業所から）
  onSnapshot(query(collection(db,"partnerOrders"),orderBy("createdAt","desc")),(snap)=>{
    partnerOrdersCache=snap.docs.map(d=>({_id:d.id,...d.data()}));
    renderPartnerOrders(partnerOrdersCache);
  });
  // 入金の記録モーダル
  document.getElementById("closePayBtn").addEventListener("click",()=>document.getElementById("payModal").classList.remove("open"));
  document.getElementById("cancelPayBtn").addEventListener("click",()=>document.getElementById("payModal").classList.remove("open"));
  document.getElementById("savePayBtn").addEventListener("click",addPayment);
  document.getElementById("applyCreditBtn").addEventListener("click",()=>{ if(payingShip) openCreditModal(payingShip); });
  document.getElementById("saveRefundBtn").addEventListener("click",addRefund);
  // 過入金の充当モーダル（イベントは1度だけ張る。行の中身は開くたびに差し替える）
  const closeCredit=()=>{ document.getElementById("creditModal").classList.remove("open"); creditTargetShip=null; };
  document.getElementById("closeCreditBtn").addEventListener("click",closeCredit);
  document.getElementById("cancelCreditBtn").addEventListener("click",closeCredit);
  document.getElementById("creditSourceBody").addEventListener("input",recalcCredit);
  document.getElementById("creditSourceBody").addEventListener("change",recalcCredit);
  document.getElementById("doApplyCreditBtn").addEventListener("click",doApplyCredit);
  // 請求済にする＋経理へ報告モーダル
  document.getElementById("closeInvReportBtn").addEventListener("click",()=>document.getElementById("invReportModal").classList.remove("open"));
  document.getElementById("cancelInvReportBtn").addEventListener("click",()=>document.getElementById("invReportModal").classList.remove("open"));
  document.getElementById("invReportSend").addEventListener("change",syncInvReportFields);
  document.getElementById("doInvReportBtn").addEventListener("click",doInvoiceReport);
  // 催促メールモーダル
  document.getElementById("closeDunBtn").addEventListener("click",()=>document.getElementById("dunModal").classList.remove("open"));
  document.getElementById("cancelDunBtn").addEventListener("click",()=>document.getElementById("dunModal").classList.remove("open"));
  document.getElementById("sendDunBtn").addEventListener("click",sendDunning);
  // 発注方法のご案内メールモーダル
  document.getElementById("closeGuideBtn").addEventListener("click",()=>document.getElementById("guideModal").classList.remove("open"));
  document.getElementById("cancelGuideBtn").addEventListener("click",()=>document.getElementById("guideModal").classList.remove("open"));
  document.getElementById("sendGuideBtn").addEventListener("click",sendGuideMail);
  // 発注ファイル（CSV/JSON）の取込 — 仕様書§3
  document.getElementById("importOrderBtn").addEventListener("click",openImportModal);
  document.getElementById("closeImportBtn").addEventListener("click",closeImportModal);
  document.getElementById("cancelImportBtn").addEventListener("click",closeImportModal);
  document.getElementById("importFiles").addEventListener("change",onImportFilesPicked);
  document.getElementById("doImportBtn").addEventListener("click",runImport);
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
