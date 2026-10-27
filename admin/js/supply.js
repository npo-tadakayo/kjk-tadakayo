import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, applyViewerMode } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, query, where, orderBy, onSnapshot,
  addDoc, updateDoc, setDoc, deleteDoc, runTransaction, serverTimestamp, increment, arrayUnion, arrayRemove, deleteField }
  from "/js/fs.js";
import { getFunctions, httpsCallable } from "/js/fn.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
  from "/js/st.js";
import { renderPOHtml, PO_STYLE, DEFAULT_PO_MAIL_SUBJECT, DEFAULT_PO_MAIL_BODY } from "/js/po-doc.js";
import { renderInvoiceHtml, INVOICE_STYLE, invoiceNoOf, offscreenClone, buildOnePagePdf,
  DEFAULT_INVOICE_MAIL_SUBJECT, DEFAULT_INVOICE_MAIL_BODY, invoiceTotals } from "/js/invoice-doc.js";
import { SHIPPING_FEES, unitPriceFor, partnerTierIndex, LETTERPACK_FEE_DEF, YUPACK_SIZES_DEF, YUPACK_REGIONS_DEF, YUPACK_ROWS_DEF } from "/js/supply-pricing.js";
import { parseOrderFile } from "/js/partner-order-import.js";
import { connectionLabel, itemConnection, itemLine, findProduct } from "/js/product-label.js";
import { PREFECTURES } from "/js/area.js";
import { matchAssignee, fillAssigneeSelect, bindPrefSelect } from "/js/assignee-filter.js";
// 出荷の状態・ボタン・在庫の扱いの判定は ship-flow.js が正本（2026-10-21 出荷の二段階化）
import { SHIP_STATUS_LABEL, SHIP_STATUS_BADGE, shipStatusOf, usesWarehouse, stockDeducted, isLocked,
  canDelete, canCancel, nextStatus, shipNotifyShown, shipActions, needsResendPrompt, qtyDelta,
  netPaidOf, CANCEL_BLOCKED_BY_PAYMENT, notifyInFlight, NOTIFY_IN_FLIGHT_MSG, lpPickupNotice, letterPackOrDefault, DEFAULT_LETTERPACK } from "/js/ship-flow.js";
// 下書きの重複警告・在庫の目安（2026-10-21 設計 §6）と入金明細の取り込み（§7）
import { findDuplicateDrafts, stockAdvice } from "/js/ship-dup.js";
import { dupView, filterDupOnly, othersToCancel, stockAdviceShown, invoicePatchOf, paymentRemovalOf, VIEWER_LOCK_SELECTOR } from "/js/supply-rules.js";
import { initBankImport } from "/js/bank-import.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast1");
const sendSupplierOrderFn = httpsCallable(functions, "sendSupplierOrder");
const sendPartnerMailFn = httpsCallable(functions, "sendPartnerMail");
const reportInvoiceFn = httpsCallable(functions, "reportInvoiceToAccounting");
const notifyShipmentFn = httpsCallable(functions, "notifyShipment"); // 出荷指示の投稿（2026-10-19 #4）
const storage = getStorage(app);

let products = [];
let locations = [];          // 保管場所マスタ（2026-09-12 追加）
let transfers = [];          // 保管場所間の移動（2026-09-30 追加）
let currentUser = null;
let appSettings = {};
let shipments = [];          // 出荷一覧（受注タブの入金状況表示に流用）
let partnerOrdersCache = []; // 受注一覧（出荷の更新時に再描画するため保持）
let viewerMode = false;      // 閲覧のみ（viewer）。applyViewerMode が文言で拾えないボタンを自前で止めるため
let shipDeepLinkTried = false; // ?so= の該当行スクロールは最初の描画で1回だけ試す（onSnapshotで何度も再描画されるため）
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
// 供給管理は1ページのまま、URL の ?tab= で2つの入口（在庫・発注／出荷・請求・入金）を開き分ける契約。
// パラメータ名 "tab" と5つの値（inventory/orders/shipments/partnerorders/partners）は
// ダッシュボード側も依存しているので変えないこと。
const VALID_TABS = ["inventory","orders","shipments","partnerorders","partners"];
const TAB_GROUP_TITLE = {
  inventory: "在庫・発注", orders: "在庫・発注",
  shipments: "出荷・請求・入金", partnerorders: "出荷・請求・入金", partners: "出荷・請求・入金",
};
function applyTabHeading(tabName){
  const label = TAB_GROUP_TITLE[tabName] || "在庫・発注";
  const h1 = document.getElementById("pageTitle");
  if (h1) h1.textContent = label;
  document.title = `${label} — タダカヨ CRM`;
}
// タブを開く。URL の ?tab= も history.replaceState で追従させる（リロードしても同じタブが開く）
function activateTab(tabName){
  const btn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  const content = document.getElementById(`tab-${tabName}`);
  if (!btn || !content) return false;
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(x=>x.classList.remove("active"));
  btn.classList.add("active");
  content.classList.add("active");
  applyTabHeading(tabName);
  const url = new URL(location.href);
  url.searchParams.set("tab", tabName);
  history.replaceState(null, "", url);
  return true;
}
function initTabs(){
  document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{
    activateTab(t.dataset.tab);
  }));
  // 直接リンク／帳票ページから「供給管理へ」で戻ったとき、?tab= の値でタブを初期表示する。
  // 不正な値・無指定は従来どおり既定タブ（HTML側で active な inventory）のまま
  const wanted = new URLSearchParams(location.search).get("tab");
  if (wanted && VALID_TABS.includes(wanted)) {
    activateTab(wanted);
  } else {
    const activeTab = document.querySelector(".tab.active");
    applyTabHeading(activeTab ? activeTab.dataset.tab : "inventory");
  }
}

// ===== 保管場所（2026-09-12 追加） =====
// 在庫は「合計 products.stock」と「場所ごと products.stockByLocation」の両方を持つ。
// 合計を残したのは、既存の在庫チェック・表示・請求まわりをそのまま動かすため。
// ★在庫を動かすときは必ず stockPatch() を通すこと。stock だけ動かすと内訳と合計がずれる。
function activeLocations(){ return locations.filter(l=>l.active!==false); }
function defaultLocationId(){ const a=activeLocations(); return ((a.find(l=>l.isDefault)||a[0]||{})._id)||""; }
function locationName(id){ const l=locations.find(x=>x._id===id); return l?(l.name||""):""; }
function locationPref(id){ const l=locations.find(x=>x._id===id); return l?(l.pref||""):""; }
function stockAt(p, locId){ return Number(((p||{}).stockByLocation||{})[locId])||0; }
// 保管場所を作る前に登録された出荷には originLocationId が無い。既定の場所から出したものとして扱う
function shipLocationOf(s){ return (s&&s.originLocationId) || defaultLocationId(); }
function stockPatch(locId, delta){
  const patch = { stock: increment(delta) };
  if(locId) patch[`stockByLocation.${locId}`] = increment(delta);
  return patch;
}
function movement(sku, delta, reason, refNo, locId){
  return { sku, delta, reason, refNo: refNo||"", locationId: locId||"", locationName: locationName(locId),
    createdAt: serverTimestamp(), userName: currentUser.displayName||currentUser.email };
}
function fillLocationSelect(el, selected){
  if(!el) return;
  const list = activeLocations();
  el.innerHTML = list.length
    ? list.map(l=>`<option value="${esc(l._id)}">${esc(l.name)}${l.pref?`（${esc(l.pref)}）`:""}</option>`).join("")
    : '<option value="">保管場所が未登録です</option>';
  const want = (selected && list.some(l=>l._id===selected)) ? selected : defaultLocationId();
  el.value = want;
}
// 保管場所間の移動で「発送済・未到着」の台数（2026-09-30）。合計 stock には含まれ、どの場所の内訳にも入っていない
function transitOf(p){ return Number((p||{}).stockInTransit)||0; }
// 合計と内訳の差＝どの場所に置いたか決まっていない在庫。移行前のぶんがここに出る（移動中は差し引く）
function unassignedStock(p){
  const by=p.stockByLocation||{};
  const assigned=locations.reduce((a,l)=>a+(Number(by[l._id])||0),0);
  return (Number(p.stock)||0) - assigned - transitOf(p);
}
// 保管場所の届け先（発注書の「送付先」・移動の送り先）。住所が無ければ空
function locationShipToText(l){
  if(!l || !(l.address||"").trim()) return "";
  return [ l.postal?`〒${l.postal}`:"", `${l.address||""}　${l.recipient||l.name||""}`.trim(), l.phone?`TEL ${l.phone}`:"" ]
    .filter(Boolean).join("\n");
}
// 保管場所の指定が無い古い発注の入荷先を、届け先の文字に含まれる都道府県から推定する（一意に決まるときだけ）
function guessLocationFromText(text){
  const t=String(text||""); if(!t) return "";
  const hit=activeLocations().filter(l=>l.pref && t.includes(l.pref));
  return hit.length===1 ? hit[0]._id : "";
}
function locationBreakdownHtml(p){
  const by=p.stockByLocation||{};
  const rows=locations.filter(l=>(Number(by[l._id])||0)!==0)
    .map(l=>`${esc(l.name)} <strong>${Number(by[l._id])||0}</strong>`);
  const tr=transitOf(p);
  if(tr!==0) rows.push(`<span style="color:#3a6e9e">移動中 <strong>${tr}</strong></span>`);
  const un=unassignedStock(p);
  if(un!==0) rows.push(`<span style="color:var(--color-danger)">未割当 <strong>${un}</strong></span>`);
  return rows.length?rows.join("<br>"):'<span style="color:var(--color-ink-muted)">—</span>';
}

let editingLoc = null;
function renderLocations(){
  const body=document.getElementById("locationsBody"); if(!body) return;
  body.innerHTML = locations.map(l=>{
    const total=products.reduce((a,p)=>a+stockAt(p,l._id),0);
    return `<tr>
      <td><strong>${esc(l.name)}</strong>${l.isDefault?' <span style="font-size:11px;color:var(--color-ink-muted)">（既定）</span>':""}</td>
      <td>${esc(l.pref||"—")}</td>
      <td style="font-size:12px;line-height:1.6;white-space:pre-line">${l.address?esc(locationShipToText(l)):'<span style="color:var(--color-ink-muted)">未登録（編集から入れられます）</span>'}</td>
      <td class="num">${total} 台</td>
      <td>${l.active===false?'<span style="color:var(--color-ink-muted)">使っていない</span>':"使用中"}</td>
      <td><button class="btn btn-secondary loc-edit" data-id="${esc(l._id)}" style="font-size:12px;padding:4px 10px"><i class="ti ti-pencil" aria-hidden="true"></i> 編集</button></td>
    </tr>`;
  }).join("");
  const empty=document.getElementById("locationsEmpty"); if(empty) empty.style.display=locations.length?"none":"";
  document.querySelectorAll(".loc-edit").forEach(b=>b.addEventListener("click",()=>openLocationModal(locations.find(x=>x._id===b.dataset.id))));
}
function closeLocationModal(){ document.getElementById("locationModal").classList.remove("open"); editingLoc=null; }
function openLocationModal(existing){
  editingLoc = existing || null;
  const pref=document.getElementById("locPref");
  pref.innerHTML='<option value="">選択してください</option>'+PREFECTURES.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
  document.getElementById("locationModalTitle").textContent = existing?"保管場所の編集":"保管場所を追加";
  document.getElementById("locName").value = existing?(existing.name||""):"";
  pref.value = existing?(existing.pref||""):"";
  document.getElementById("locActive").checked = existing? existing.active!==false : true;
  ["Postal","Address","Recipient","Phone"].forEach(k=>{ document.getElementById("loc"+k).value = existing?(existing[k.toLowerCase()]||""):""; });
  document.getElementById("locNameErr").textContent="";
  document.getElementById("locationModal").classList.add("open");
  document.getElementById("locName").focus();
}
async function saveLocation(){
  const name=document.getElementById("locName").value.trim();
  const pref=document.getElementById("locPref").value;
  const active=document.getElementById("locActive").checked;
  const addr={ postal:document.getElementById("locPostal").value.trim(), address:document.getElementById("locAddress").value.trim(),
    recipient:document.getElementById("locRecipient").value.trim(), phone:document.getElementById("locPhone").value.trim() };
  const err=document.getElementById("locNameErr");
  if(!name){ err.textContent="保管場所の名前を入力してください"; return; }
  if(!pref){ err.textContent="都道府県を選んでください（ゆうパックの送料が発地で変わるため）"; return; }
  const btn=document.getElementById("saveLocationBtn"); btn.disabled=true;
  try{
    if(editingLoc){
      await updateDoc(doc(db,"locations",editingLoc._id),{name,pref,active,...addr,updatedAt:serverTimestamp()});
      toast(`保管場所「${name}」を更新しました`);
    }else{
      await addDoc(collection(db,"locations"),{name,pref,active,...addr,
        isDefault: locations.length===0,   // 最初の1件を既定にする
        sort: locations.length, createdAt:serverTimestamp(),
        createdBy: currentUser.displayName||currentUser.email});
      toast(`保管場所「${name}」を追加しました`);
    }
    closeLocationModal();
  }catch(e){ err.textContent=`保存に失敗しました: ${e.message}`; }
  finally{ btn.disabled=false; }
}

// ===== 在庫・商品 =====
function renderProducts(){
  document.getElementById("productsBody").innerHTML = products.map(p=>`
    <tr>
      <td><strong>${esc(p.id)}</strong></td>
      <td>${esc(p.name)}</td>
      <td>${esc(connectionLabel(p)) || "—"}</td>
      <td class="num">${yen(p.wholesale2_10)}</td>
      <td><strong style="font-size:16px">${p.stock||0}</strong> 台</td>
      <td style="font-size:12px;line-height:1.8">${locationBreakdownHtml(p)}</td>
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
  document.getElementById("stockCurrent").textContent = `現在の在庫（全体）：${p.stock||0} 台`;
  const locSel = document.getElementById("stockLocation");
  fillLocationSelect(locSel, null);
  const showAt = ()=>{
    const el=document.getElementById("stockLocationCurrent");
    el.textContent = locSel.value ? `この場所の在庫：${stockAt(p, locSel.value)} 台` : "先に保管場所を登録してください";
  };
  // 保管場所を使う前からあった在庫は「未割当」になっている。合計を動かさずに場所へ移せるようにする
  const un = unassignedStock(p);
  const assignBtn = document.getElementById("stockAssignBtn");
  if(assignBtn){
    assignBtn.style.display = un > 0 ? "" : "none";
    assignBtn.onclick = doAssign;
  }
  const showAtAll = ()=>{
    showAt();
    if(un > 0){
      const el=document.getElementById("stockLocationCurrent");
      el.innerHTML = `${esc(el.textContent)}<br><span style="color:var(--color-danger)">まだ場所が決まっていない在庫が ${un} 台あります。`
        + `「この場所に割り当て」を押すと、合計を増やさずにこの場所の在庫にできます。</span>`;
    }
  };
  locSel.onchange = showAtAll; showAtAll();
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
// 未割当の在庫を保管場所へ移す。★合計(stock)は動かさない（置き場所を決めるだけ）
async function doAssign(){
  const p = products.find(x=>x.id===stockSku); if(!p) return;
  const locId = document.getElementById("stockLocation").value;
  if(!locId){ setStockErr("保管場所を選んでください"); return; }
  const q = parseInt(document.getElementById("stockQty").value, 10);
  if(!Number.isFinite(q) || q<=0){ setStockErr("台数は1以上で入力してください"); return; }
  const un = unassignedStock(p);
  if(q > un){ setStockErr(`まだ場所が決まっていない在庫は ${un} 台です`); return; }
  const btn = document.getElementById("stockAssignBtn"); btn.disabled = true;
  try{
    await updateDoc(doc(db,"products",stockSku), { [`stockByLocation.${locId}`]: increment(q) });
    await addDoc(collection(db,"inventoryMovements"), movement(stockSku, q, "location_assign", "", locId));
    toast(`${p.name} を ${locationName(locId)} に ${q}台 割り当てました（在庫の合計は変わりません）`);
    closeStockModal();
  }catch(e){ setStockErr(`割り当てに失敗しました: ${e.message}`); }
  finally{ btn.disabled = false; }
}

async function doStockAdjust(dir){
  const p = products.find(x=>x.id===stockSku);
  if (!p) return;
  setStockErr("");
  const locId = document.getElementById("stockLocation").value;
  if(!locId){ setStockErr("保管場所を選んでください（未登録なら在庫タブから追加できます）"); return; }
  const q = parseInt(document.getElementById("stockQty").value, 10);
  if (!(q > 0)) { setStockErr("正の整数を入力してください"); return; }
  if (dir === "out" && stockAt(p, locId) < q) { setStockErr(`この場所の在庫が足りません（${locationName(locId)} ${stockAt(p, locId)} 台）`); return; }
  const reason = `${document.getElementById("stockReason").value}_${dir}`;
  const btnIn = document.getElementById("stockInBtn"), btnOut = document.getElementById("stockOutBtn");
  btnIn.disabled = true; btnOut.disabled = true;
  try {
    const delta = dir === "in" ? q : -q;
    await updateDoc(doc(db,"products",stockSku), stockPatch(locId, delta));
    await addDoc(collection(db,"inventoryMovements"), movement(stockSku, delta, reason, "", locId));
    toast(`${p.name}（${locationName(locId)}）を ${dir==="in"?"+":"-"}${q}台 調整しました`);
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
      <th style="text-align:left;font-size:12px;color:var(--color-ink-muted)">つなぎ方</th>
      <th style="width:90px;font-size:12px;color:var(--color-ink-muted)">数量</th></tr></thead>
    <tbody>${products.map(p=>`<tr>
      <td style="font-size:12px">${esc(p.id)}</td>
      <td style="font-size:12px">${esc(p.name)}</td>
      <td style="font-size:12px;white-space:nowrap"><span class="conn-tag">${esc(connectionLabel(p))||"—"}</span></td>
      <td><input class="form-control qty-input" type="number" min="0" value="0" data-sku="${p.id}" style="padding:4px 8px"></td>
    </tr>`).join("")}</tbody></table>`;
}
// 発注の送料欄が applyShipRegion による自動計算値か（人が手で直したら false にして勝手に上書きしない）
let orderShipFeeAuto = false;
function clearOrderShipWarn(){
  const w=document.getElementById("orderShipWarn");
  if(w){ w.style.display="none"; w.innerHTML=""; }
}
// 発注の送料を地域＋台数から求める。100台以上は AB Circle の送料無料
function orderShipCalc(){
  const sel=document.getElementById("orderShipRegion");
  const r=SHIPPING_FEES.find(x=>x.region===sel.value);
  if(!r) return null; // 「選択しない」は手入力を保持
  const qty=collectItems("orderItems").reduce((s,i)=>s+i.qty,0);
  const free=qty>=100;
  return { qty, fee:free?0:r.fee,
    label:free?`送料（${r.region}・100台以上で無料）`:`送料（${r.region}）` };
}
/**
 * 発注の送料を再計算する。
 * fromQty=false（地域セレクトの change）… 従来どおり必ず上書きする
 * fromQty=true （台数の変更）      … 自動計算値のときだけ上書き。手入力済みなら消さずに注意だけ出す
 */
function refreshOrderShipFee(fromQty){
  const c=orderShipCalc();
  if(!c){ clearOrderShipWarn(); return; }
  const feeEl=document.getElementById("orderShipFee"), labelEl=document.getElementById("orderShipLabel");
  if(!fromQty || orderShipFeeAuto){
    feeEl.value=c.fee; labelEl.value=c.label; orderShipFeeAuto=true;
    clearOrderShipWarn(); return;
  }
  // 手で送料を入れている → 勝手に消さない。計算値とズレているときだけ注意を出す
  const warn=document.getElementById("orderShipWarn");
  if(!warn) return;
  if((Number(feeEl.value)||0)===c.fee){ clearOrderShipWarn(); return; }
  warn.innerHTML = `台数 ${c.qty}台 だと送料は <strong>${yen(c.fee)}</strong>（${esc(c.label)}）になります。`
    + `送料が手入力されているため自動では変更していません。`
    + ` <button type="button" class="btn btn-secondary" id="orderShipAutoBtn" style="font-size:12px;padding:4px 8px">自動計算に戻す</button>`;
  warn.style.display="block";
  document.getElementById("orderShipAutoBtn").onclick=()=>{
    feeEl.value=c.fee; labelEl.value=c.label; orderShipFeeAuto=true; clearOrderShipWarn();
  };
}
function applyShipRegion(){ refreshOrderShipFee(false); }
function onOrderQtyInput(){ updateOrderTotal(); refreshOrderShipFee(true); }
// 認定事業者への卸単価（料金・送料設定 appConfig.partnerPricing が正＝AB Circle仕入とは別管理）。
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
      // つなぎ方も一緒に残す。商品マスタを後から直しても「そのとき何を送ったか」がぶれない
      items.push({sku:p.id,name:p.name,qty:q,unitPrice,connection:connectionLabel(p)}); }
  });
  return items;
}

function fillOrderShipTo(){
  const sel=document.getElementById("orderPartnerSelect");
  const p=activePartners.find(x=>x._id===sel.value);
  if(!p) return; // 「手入力」選択時は既存の入力を保持
  // 認定事業者の住所を入れる＝保管場所への納品ではない（2026-09-30）
  const dl=document.getElementById("orderDeliverLoc"); if(dl) dl.value="";
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
  // 既存の下書きの送料は自動計算値か手入力か判別できない → 手入力扱い（勝手に上書きしない）
  orderShipFeeAuto = false;
  clearOrderShipWarn();
  document.getElementById("orderShipTo").value = (o&&o.shipTo) || "";
  document.getElementById("orderTotal").textContent="";
  // 納品先の保管場所（2026-09-30）。新規は既定の保管場所、住所が登録されていれば届け先に入れる
  const dlSel=document.getElementById("orderDeliverLoc");
  // 保存済みの納品先が「使っていない」に変わっていても消さずに残す（黙って別の場所に書き換わらないように・Codex P2）
  const dlList=[...activeLocations()];
  const savedLoc=o&&o.deliverLocationId ? locations.find(l=>l._id===o.deliverLocationId) : null;
  if(savedLoc && !dlList.some(l=>l._id===savedLoc._id)) dlList.push(savedLoc);
  dlSel.innerHTML='<option value="">保管場所以外（認定事業者への直送・手入力）</option>'+
    dlList.map(l=>`<option value="${esc(l._id)}">${esc(l.name)}${l.pref?`（${esc(l.pref)}）`:""}${l.active===false?"［使っていない］":""}</option>`).join("");
  if(o && o.deliverLocationId && !savedLoc){
    // 保管場所そのものが消えている: 名前だけの選択肢で保持する
    dlSel.insertAdjacentHTML("beforeend", `<option value="${esc(o.deliverLocationId)}">${esc(o.deliverLocationName||"（削除された保管場所）")}</option>`);
  }
  dlSel.value = o ? (o.deliverLocationId||"") : defaultLocationId();
  dlSel.onchange=()=>{ const t=locationShipToText(locations.find(l=>l._id===dlSel.value)); if(t) document.getElementById("orderShipTo").value=t; };
  if(!o){ const t=locationShipToText(locations.find(l=>l._id===dlSel.value)); if(t && !document.getElementById("orderShipTo").value) document.getElementById("orderShipTo").value=t; }
  // 直送チェック（確定時に出荷下書きを自動作成）
  const dchk=document.getElementById("orderDropship");
  const dreq=document.getElementById("dropshipReq");
  dchk.checked = !!(o&&o.dropship);
  if(dreq) dreq.style.display = dchk.checked?"":"none";
  const dlWrap=document.getElementById("orderDeliverLocWrap");
  if(dlWrap) dlWrap.style.display = dchk.checked?"none":"";
  dchk.onchange=()=>{ if(dreq) dreq.style.display = dchk.checked?"":"none";
    // 直送は在庫を経由しない＝保管場所への納品ではない
    if(dlWrap) dlWrap.style.display = dchk.checked?"none":"";
    if(dchk.checked) document.getElementById("orderDeliverLoc").value=""; };
  // 認定事業者セレクト（直送時は請求先。選ぶと届け先住所を自動入力・手入力修正も可）
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
  // 台数が変わったら送料も見直す（100台以上の送料無料が反映されないままにならないように）
  document.querySelectorAll("#orderItems .qty-input").forEach(i=>i.addEventListener("input",onOrderQtyInput));
  updateOrderTotal();
  document.getElementById("orderModal").classList.add("open"); }
function updateOrderTotal(){ const items=collectItems("orderItems");
  const total=items.reduce((s,i)=>s+i.qty*i.unitPrice,0);
  document.getElementById("orderTotal").textContent = items.length?`合計(税別): ${yen(total)}`:""; }
async function saveOrder(){
  const items=collectItems("orderItems");
  if(!items.length){ alert("数量を入力してください"); return; }
  if(document.getElementById("orderDropship").checked && !document.getElementById("orderPartnerSelect").value){
    alert("直送する場合は請求先の認定事業者を選択してください"); return; }
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
      deliverLocationId: document.getElementById("orderDropship").checked ? "" : (document.getElementById("orderDeliverLoc").value||""),
      deliverLocationName: document.getElementById("orderDropship").checked ? "" : (locationName(document.getElementById("orderDeliverLoc").value||"")
        || (document.getElementById("orderDeliverLoc").selectedOptions[0]?.textContent||"").replace(/^保管場所以外.*$/,"")),
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
    const summary=(o.items||[]).map(i=>itemLine(i, products)).join("／ ");
    const statusLabel={sent:"発注済",received:"入荷済",draft:"下書き"}[o.status]||o.status;
    const badgeN = o.status==="received"?3 : o.status==="draft"?2 : 7;
    const isDraft = o.status==="draft";
    const sentInfo = o.emailedAt ? `<div style="font-size:12px;color:var(--color-success)">メール送付済</div>` : "";
    // 直送は仕入先から届け先へ直行＝自社在庫を経由しないので「入荷登録」は出さない（在庫の誤加算を防ぐ）
    const deliverLoc = !o.dropship && (o.deliverLocationId || o.receivedLocationId);
    const deliverInfo = deliverLoc ? `<div style="font-size:12px;color:var(--color-ink-muted)">${o.status==="received"?"入荷先":"納品先"} ${esc(locationName(o.receivedLocationId||o.deliverLocationId)||o.receivedLocationName||o.deliverLocationName||"")}</div>` : "";
    const dropInfo = o.dropship ? `<div style="font-size:12px;color:var(--color-ink-muted)">直送（入荷なし）${o.dropshipPartnerName?`／請求先 ${esc(o.dropshipPartnerName)}`:""}</div>` : "";
    return `<tr>
      <td><strong>${esc(o.poNumber)}</strong></td>
      <td>${esc(o.orderDate||"")}${o.desiredDate?`<div style="font-size:12px;color:var(--color-ink-muted)">納期希望 ${esc(o.desiredDate)}</div>`:""}</td>
      <td style="font-size:12px">${esc(summary)}</td>
      <td class="num">${yen(o.total)}</td>
      <td><span class="badge badge-${badgeN}">${statusLabel}</span>${sentInfo}${dropInfo}${deliverInfo}</td>
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
// 案件から出荷を作ったときに、その案件のIDを保存するため覚えておく
// （請求書メールの宛先や、支援報告書の紐付けに使う）
let prefillCaseId = null;
let receivingPO = null;
function closeReceiveModal(){ document.getElementById("receiveModal").classList.remove("open"); receivingPO=null; }
// 入荷はどの保管場所に入れるかで在庫の置き場所が変わるので、確認ダイアログではなく場所を選ばせる
async function receiveOrder(id, orders){
  const o=orders.find(x=>x._id===id); if(!o) return;
  receivingPO = o;
  const lines=(o.items||[]).map(it=>`${esc(it.sku)} × ${Number(it.qty)||0}台`).join("・");
  document.getElementById("receiveSummary").innerHTML =
    `発注 <strong>${esc(o.poNumber||"")}</strong> を入荷登録します。<br>${lines||"（明細がありません）"}`;
  // 入荷先の初期値: 発注時に選んだ納品先 → 届け先の都道府県から推定 → 既定（2026-09-30）
  const guessed = o.deliverLocationId || guessLocationFromText(o.shipTo);
  const recvSel=document.getElementById("receiveLocation");
  fillLocationSelect(recvSel, guessed || null);
  const hint=document.getElementById("receiveHint");
  if(hint){
    const chosen=recvSel.value;
    let msg="", warn=false;
    if(o.deliverLocationId && chosen===o.deliverLocationId){ msg=`「${locationName(chosen)}」を選んでいます（発注のときに選んだ納品先です）`; }
    else if(o.deliverLocationId){ msg=`発注のときの納品先「${o.deliverLocationName||locationName(o.deliverLocationId)||"不明"}」は、いま使っていない保管場所のため選べません。入荷先を確かめて選んでください`; warn=true; }
    else if(guessed && chosen===guessed){ msg=`「${locationName(chosen)}」を選んでいます（発注の届け先の都道府県から選びました。違っていれば変えてください）`; warn=true; }
    hint.textContent=msg; hint.style.color = warn ? "#c87a1f" : "var(--color-ink-muted)"; hint.style.display = msg ? "" : "none";
  }
  document.getElementById("receiveErr").textContent="";
  document.getElementById("receiveModal").classList.add("open");
}
async function doReceive(){
  const o=receivingPO; if(!o) return;
  const locId=document.getElementById("receiveLocation").value;
  const err=document.getElementById("receiveErr");
  if(!locId){ err.textContent="入荷先の保管場所を選んでください（未登録なら在庫タブから追加できます）"; return; }
  const btn=document.getElementById("doReceiveBtn"); btn.disabled=true;
  try{
    for(const it of (o.items||[])){
      const q=Number(it.qty)||0; if(!q) continue;
      await updateDoc(doc(db,"products",it.sku), stockPatch(locId, q));
      await addDoc(collection(db,"inventoryMovements"), movement(it.sku, q, "po_received", o.poNumber, locId));
    }
    await updateDoc(doc(db,"purchaseOrders",o._id),{status:"received",receivedAt:serverTimestamp(),
      receivedLocationId:locId, receivedLocationName:locationName(locId)});
    toast(`${o.poNumber} を ${locationName(locId)} に入荷登録しました`);
    closeReceiveModal();
  }catch(e){ err.textContent=`入荷登録に失敗しました: ${e.message}`; }
  finally{ btn.disabled=false; }
}
// ===== 保管場所間の移動（2026-09-30 追加） =====
// 例: 滋賀のロジスティックセンター → 沖縄のスマイルプラス。
//   発送  : 移動元 stockByLocation を減らし、products.stockInTransit を増やす（合計 stock は変えない）
//   到着  : stockInTransit を減らし、移動先 stockByLocation を増やす
//   取消  : 未到着のときだけ。stockInTransit を減らし、移動元へ戻す
// 在庫の書き込みは stockPatch() を通さない（合計を動かさないため）。代わりに1つのトランザクションで
// 商品・移動の記録（stockTransfers）・在庫の履歴（inventoryMovements）を一緒に書く。
const TR_METHOD_LABEL = { yupack:"ゆうパック", letterpack:"レターパック", carry:"手渡し・持参", other:"その他" };
const TR_STATUS = { in_transit:{label:"移動中",badge:7}, arrived:{label:"到着済",badge:3}, canceled:{label:"取り消し",badge:1} };
function transferItemsLine(t){ return (t.items||[]).map(i=>`${esc(i.sku)} × ${Number(i.qty)||0}台`).join("・"); }
function renderTransfers(){
  const body=document.getElementById("transfersBody"); if(!body) return;
  // 移動中を上に、そのあと新しい順（直近20件）
  const list=[...transfers].sort((a,b)=>{
    const ai=a.status==="in_transit"?0:1, bi=b.status==="in_transit"?0:1; if(ai!==bi) return ai-bi;
    return String(b.transferNumber||"").localeCompare(String(a.transferNumber||""));
  }).slice(0,20);
  body.innerHTML = list.map(t=>{
    const st=TR_STATUS[t.status]||{label:t.status,badge:1};
    const sub=[ t.method?TR_METHOD_LABEL[t.method]||t.method:"", Number(t.shippingFee)>0?`送料 ${yen(t.shippingFee)}`:"", t.tracking?`追跡 ${esc(t.tracking)}`:"" ].filter(Boolean).join("／");
    const arrived = t.status==="arrived" ? `<div style="font-size:12px;color:var(--color-ink-muted)">到着 ${esc(t.arrivedDate||"")}</div>` : "";
    return `<tr>
      <td><strong>${esc(t.transferNumber||"")}</strong></td>
      <td>${esc(t.shippedDate||"")}</td>
      <td>${esc(t.fromLocationName||locationName(t.fromLocationId))} <i class="ti ti-arrow-right" aria-hidden="true"></i> ${esc(t.toLocationName||locationName(t.toLocationId))}</td>
      <td style="font-size:12px">${transferItemsLine(t)}${sub?`<div style="color:var(--color-ink-muted)">${sub}</div>`:""}${t.memo?`<div style="color:var(--color-ink-muted)">${esc(t.memo)}</div>`:""}</td>
      <td><span class="badge badge-${st.badge}">${esc(st.label)}</span>${arrived}</td>
      <td style="white-space:nowrap">${t.status==="in_transit"?`
        <button class="btn btn-primary tr-arrive" data-id="${esc(t._id)}" style="font-size:12px;padding:4px 8px"><i class="ti ti-package-import" aria-hidden="true"></i>到着を登録</button>
        <button class="btn btn-secondary tr-cancel" data-id="${esc(t._id)}" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-back-up" aria-hidden="true"></i>取り消す</button>`:""}</td>
    </tr>`;
  }).join("");
  const empty=document.getElementById("transfersEmpty"); if(empty) empty.style.display=list.length?"none":"";
  body.querySelectorAll(".tr-arrive").forEach(b=>b.addEventListener("click",()=>openArriveModal(transfers.find(x=>x._id===b.dataset.id))));
  body.querySelectorAll(".tr-cancel").forEach(b=>b.addEventListener("click",()=>cancelTransfer(transfers.find(x=>x._id===b.dataset.id))));
}
function closeTransferModal(){ document.getElementById("transferModal").classList.remove("open"); }
function renderTransferItemRows(){
  const from=document.getElementById("trFrom").value;
  // 移動元に在庫がある品番だけ並べる（0台の品番まで出すと入力欄が増えて見づらい）
  const list=products.filter(p=>stockAt(p, from)>0);
  if(!list.length){ document.getElementById("trItems").innerHTML=`<p style="font-size:13px;color:var(--color-ink-muted);margin:0 0 12px">${esc(locationName(from))} には在庫がありません。</p>`; return; }
  document.getElementById("trItems").innerHTML = list.map(p=>{
    const have=stockAt(p, from);
    return `<div class="form-row" style="align-items:center">
      <div class="form-group" style="flex:2"><div style="font-size:13px"><strong>${esc(p.id)}</strong>　${esc(p.name||"")}</div>
        <div style="font-size:12px;color:var(--color-ink-muted)">移動元の在庫 ${have} 台</div></div>
      <div class="form-group" style="flex:1"><label class="form-label" for="trQty-${esc(p.id)}">台数</label>
        <input class="form-control tr-qty" type="number" min="0" max="${have}" step="1" id="trQty-${esc(p.id)}" data-sku="${esc(p.id)}" value="0" ${have>0?"":"disabled"}></div>
    </div>`;
  }).join("");
}
function showTransferToAddr(){
  const l=locations.find(x=>x._id===document.getElementById("trTo").value);
  const t=locationShipToText(l);
  document.getElementById("trToAddr").textContent = t ? `送り先: ${t}` : (l ? "送り先の住所が未登録です（保管場所の「編集」で登録できます）" : "");
}
function openTransferModal(){
  const act=activeLocations();
  if(act.length<2){ alert("保管場所が2つ以上必要です（在庫タブの「保管場所を追加」から登録してください）"); return; }
  const from=document.getElementById("trFrom"), to=document.getElementById("trTo");
  fillLocationSelect(from, null);
  fillLocationSelect(to, (act.find(l=>l._id!==from.value)||{})._id);
  document.getElementById("trDate").value=today();
  document.getElementById("trMethod").value="yupack";
  ["trFee","trTracking","trMemo"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("trErr").textContent="";
  from.onchange=renderTransferItemRows; to.onchange=showTransferToAddr;
  renderTransferItemRows(); showTransferToAddr();
  document.getElementById("transferModal").classList.add("open");
}
async function saveTransfer(){
  const from=document.getElementById("trFrom").value, to=document.getElementById("trTo").value;
  const err=document.getElementById("trErr"); err.textContent="";
  if(!from||!to){ err.textContent="移動元と移動先を選んでください"; return; }
  if(from===to){ err.textContent="移動元と移動先が同じです"; return; }
  const items=[...document.querySelectorAll("#trItems .tr-qty")]
    .map(i=>({sku:i.dataset.sku, qty:Math.floor(Number(i.value)||0)})).filter(i=>i.qty>0);
  if(!items.length){ err.textContent="移動する台数を入力してください"; return; }
  for(const it of items){
    const p=products.find(x=>x.id===it.sku);
    if(stockAt(p,from)<it.qty){ err.textContent=`在庫が足りません: ${it.sku}（${locationName(from)} ${stockAt(p,from)} 台 / 移動 ${it.qty} 台）`; return; }
  }
  const btn=document.getElementById("saveTransferBtn"); btn.disabled=true;
  try{
    const transferNumber=seqFmt("TR", await nextSeq("stockTransfers"));
    const trRef=doc(collection(db,"stockTransfers"));
    const who=currentUser.displayName||currentUser.email;
    await runTransaction(db, async (tx)=>{
      // 画面を開いたあとに別の出荷で減っていないか、書く直前の在庫で確かめ直す
      const snaps=[];
      for(const it of items){ snaps.push([it, await tx.get(doc(db,"products",it.sku))]); }
      for(const [it,snap] of snaps){
        const have=Number(((snap.data()||{}).stockByLocation||{})[from])||0;
        if(have<it.qty) throw new Error(`在庫が足りません: ${it.sku}（${locationName(from)} ${have} 台 / 移動 ${it.qty} 台）`);
      }
      for(const [it,snap] of snaps){
        tx.update(snap.ref, { [`stockByLocation.${from}`]: increment(-it.qty), stockInTransit: increment(it.qty) });
        tx.set(doc(collection(db,"inventoryMovements")), movement(it.sku, -it.qty, "transfer_out", transferNumber, from));
      }
      tx.set(trRef, {
        transferNumber, status:"in_transit",
        fromLocationId:from, fromLocationName:locationName(from), toLocationId:to, toLocationName:locationName(to),
        toShipTo: locationShipToText(locations.find(l=>l._id===to)),
        items, shippedDate:document.getElementById("trDate").value||today(),
        method:document.getElementById("trMethod").value, shippingFee:Number(document.getElementById("trFee").value)||0,
        tracking:document.getElementById("trTracking").value.trim(), memo:document.getElementById("trMemo").value.trim(),
        createdAt:serverTimestamp(), createdBy:who });
    });
    toast(`${transferNumber}：${locationName(from)} → ${locationName(to)} の発送を登録しました（到着したら「到着を登録」）`);
    closeTransferModal();
  }catch(e){ err.textContent=`登録できませんでした: ${e.message}`; }
  finally{ btn.disabled=false; }
}
let arrivingTransfer=null;
function closeArriveModal(){ document.getElementById("arriveModal").classList.remove("open"); arrivingTransfer=null; }
function openArriveModal(t){
  if(!t) return; arrivingTransfer=t;
  document.getElementById("arriveSummary").innerHTML =
    `<strong>${esc(t.transferNumber)}</strong>　${esc(t.fromLocationName)} → <strong>${esc(t.toLocationName)}</strong><br>${transferItemsLine(t)}<br>移動先の在庫に加算します。`;
  document.getElementById("arriveDate").value=today();
  document.getElementById("arriveErr").textContent="";
  document.getElementById("arriveModal").classList.add("open");
}
// 到着・取り消しの共通処理。移動中から出して、to（到着）か from（取り消し）に入れる
async function settleTransfer(t, mode){
  const trRef=doc(db,"stockTransfers",t._id);
  const intoLoc = mode==="arrive" ? t.toLocationId : t.fromLocationId;
  const who=currentUser.displayName||currentUser.email;
  await runTransaction(db, async (tx)=>{
    const cur=await tx.get(trRef);
    if(!cur.exists()) throw new Error("この移動の記録が見つかりません");
    if(cur.data().status!=="in_transit") throw new Error("すでに到着済み・取り消し済みです（画面を更新してください）");
    for(const it of (cur.data().items||[])){
      const q=Number(it.qty)||0; if(!q) continue;
      tx.update(doc(db,"products",it.sku), { stockInTransit: increment(-q), [`stockByLocation.${intoLoc}`]: increment(q) });
      tx.set(doc(collection(db,"inventoryMovements")), movement(it.sku, q, mode==="arrive"?"transfer_in":"transfer_canceled", t.transferNumber, intoLoc));
    }
    tx.update(trRef, mode==="arrive"
      ? { status:"arrived", arrivedDate:document.getElementById("arriveDate").value||today(), arrivedAt:serverTimestamp(), arrivedBy:who }
      : { status:"canceled", canceledAt:serverTimestamp(), canceledBy:who });
  });
}
async function doArrive(){
  const t=arrivingTransfer; if(!t) return;
  const btn=document.getElementById("doArriveBtn"); btn.disabled=true;
  try{ await settleTransfer(t,"arrive"); toast(`${t.transferNumber} の到着を登録しました（${t.toLocationName} の在庫に入りました）`); closeArriveModal(); }
  catch(e){ document.getElementById("arriveErr").textContent=`登録できませんでした: ${e.message}`; }
  finally{ btn.disabled=false; }
}
async function cancelTransfer(t){
  if(!t) return;
  if(!confirm(`${t.transferNumber}（${t.fromLocationName} → ${t.toLocationName}）を取り消します。\n移動中の ${transferItemsLine(t).replace(/<[^>]+>/g,"")} を ${t.fromLocationName} の在庫に戻します。よろしいですか？`)) return;
  try{ await settleTransfer(t,"cancel"); toast(`${t.transferNumber} を取り消しました（${t.fromLocationName} に戻しました）`); }
  catch(e){ alert(`取り消せませんでした: ${e.message}`); }
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

// 直送発注 → 出荷の下書き(draft)を自動生成（在庫は経由しない＝増減なし）。請求先=認定事業者・単価=認定事業者卸
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
// ===== 出荷の二段階化（2026-10-21・案B。元は 2026-10-19 CRM改修 #4・#6・#7 の「発送済にする」の共通部品） =====
// 下書き(draft) ─「出荷を依頼する」→ 依頼済(requested) ─「発送済にする」→ 発送済(shipped)
//   ・「出荷を依頼する」: 希望出荷日・出荷元（必須）・レターパックの種類を確認 → requested にして出荷指示を投稿する。
//      在庫は動かさない（不足は警告だけ）。記録: requestedBy/ByEmail/At
//   ・「発送済にする」: 発送日・出荷元（変えてよい）・追跡番号（任意）を確認 → shipped にして在庫を引き落とす
//      （トランザクションで「依頼済のままか」「在庫が足りるか」を確かめ、不足なら止める）。出荷指示は投稿しない。
//      押した人（shippedBy）と、支払期限の新ルールの印（dueRule:'net14'＝請求書の発行日＋14日）を書く
//   ・「すでに発送済（記録のみ）」: 下書きから依頼を経ずに shipped へ。在庫は引く・出荷指示は送らない（skipped）
//   ・「依頼を取り消す」: requested → draft。出荷指示の投稿の印を消す（消さないと再依頼で投稿されない）
// 経路は3つ（下書きから・出荷の直接登録・認定事業者の受注から）で、どれも依頼の段階を通る（直送も通す・§9 決定6）。
// 状態ごとに押せるボタン・在庫の扱いは ship-flow.js が正本。
const LETTERPACK_TYPE_LABEL = { light:"レターパックライト（青）", plus:"レターパックプラス（赤）" };
function shippedStampPatch(){
  return { shippedBy: currentUser.displayName||currentUser.email, shippedByEmail: currentUser.email||"",
    shippedAt: serverTimestamp(), dueRule: "net14" };
}
// requestSeq … 依頼の番号（依頼のたびに1増やす）。notifyShipment は投稿の結果を書くとき、ロックを取ったときと同じ番号か確かめる
// （送信中に依頼を取り消して依頼し直した場合に、古い送信が「投稿済み」を書き戻して再依頼の投稿が止まるのを防ぐ・Codex 指摘4）
function requestedStampPatch(){
  return { requestedBy: currentUser.displayName||currentUser.email, requestedByEmail: currentUser.email||"",
    requestedAt: serverTimestamp(), requestSeq: increment(1) };
}
function letterPackPatch(v){ return (v==="light"||v==="plus") ? { letterPackType:v } : {}; }
// 出荷指示を投稿して、結果を一言で返す（画面のトーストに足す）。投稿の可否で処理を止めない
async function postShipNotice(shipmentId, opts){
  try{
    const r = await notifyShipmentFn({ shipmentId, resend: !!(opts && opts.resend) });
    const d = (r && r.data) || {};
    if(d.posted) return d.resent ? "出荷指示を再送しました" : "出荷指示を投稿しました";
    return ({
      unset: "出荷指示の投稿先が未設定のため、投稿していません",
      disabled: "出荷指示の投稿先が停止中のため、投稿していません",
      error: "出荷指示の投稿に失敗しました（出荷の行の「出荷指示を再送」でやり直せます）",
      already: "出荷指示は投稿済みです",
      busy: "出荷指示はいま投稿中です",
    })[d.reason] || "出荷指示は投稿していません";
  }catch(e){
    console.warn("notifyShipment:", e);
    return `出荷指示を投稿できませんでした（${e.message||e}）。出荷の行の「出荷指示を再送」でやり直せます`;
  }
}
// 「すでに発送済（記録のみ）」のときに出荷へ書く印（出荷指示を送っていない）。再送ボタンからは後で送れる
function noNoticePatch(){
  return { shipNotifyStatus: "skipped", shipNotifySkippedBy: currentUser.displayName||currentUser.email,
    shipNotifySkippedAt: serverTimestamp() };
}
const NO_NOTICE_MSG = "出荷指示は送っていません（記録のみ）";
// 案件のステータスが「伴走支援実施済」(8) 以降なら、すでにカードリーダーが届いている可能性が高い
async function deliveredHint(s){
  if(!s.caseId) return null;
  try{
    const cs = await getDoc(doc(db,"cases",s.caseId));
    const st = cs.exists() ? Number(cs.data().status) : 0;
    if(st >= 8 && st !== 4) return "この案件はすでに伴走支援が済んでいます。カードリーダーが届いていれば、ここで依頼せず、一覧の「すでに発送済（記録のみ）」を使ってください（出荷指示を二重に送るのを防ぐため）";
  }catch(_){}
  return null;
}

// 出荷指示の再送（明示の操作なので投稿済みでも送る。必ず確認を出す）
async function resendShipNotice(s){
  const msg = s.shipNotifiedAt
    ? `出荷 ${s.soNumber} の出荷指示は ${fmtDT(s.shipNotifiedAt)} に投稿済みです。\nもう一度投稿しますか？（同じ指示が2回届きます）`
    : `出荷 ${s.soNumber} の出荷指示を投稿します。よろしいですか？`;
  if(!confirm(msg)) return;
  toast("出荷指示を投稿しています...");
  toast(await postShipNotice(s._id, { resend: true }));
}

// 依頼・発送済・記録のみの前の確認ダイアログ（3つで共通）。
// OK なら {shipDate, originLocationId, letterPackType, trackingNumber}、やめたら null
//   mode: "request" … 出荷を依頼する（日付は希望出荷日・出荷元は必須・在庫不足は警告だけ・追跡番号は聞かない）
//         "ship"    … 発送済にする（日付は発送日・出荷元は変えてよい・在庫不足なら止める・追跡番号は任意）
//         "record"  … すでに発送済（記録のみ）（"ship" と同じ確認。出荷指示は送らない）
// 以前の「出荷指示を送らない」チェックは廃止した（送らない場合は「すでに発送済（記録のみ）」を使う・2026-10-21）
const SHIP_DIALOG = {
  request: { title:"出荷を依頼する", dateLabel:"希望出荷日", button:"出荷を依頼する",
    note:"「出荷を依頼する」を押すと、出荷指示の投稿先へ指示を投稿します（投稿先が未設定・停止中のときは投稿せず、依頼の記録だけ残ります）。在庫はまだ引き落としません（センターが発送したのを確認して「発送済にする」を押したときに引き落とします）。" },
  ship: { title:"発送済にする", dateLabel:"発送日", button:"発送済にする",
    note:"センターが発送したのを確認してから押してください。在庫を引き落とし、請求の起点になります。出荷指示は投稿しません（依頼のときに投稿済みです）。" },
  record: { title:"すでに発送済（記録のみ）", dateLabel:"発送日", button:"発送済として記録",
    note:"すでに届いている・手渡し済みなどの出荷を、依頼を経ずに発送済として記録します。在庫を引き落とします。出荷指示は送りません。" },
};
let shipDoneCtx = null; // { resolve, items, usesStock, mode }
function askShipDetails({ mode, title, summaryHtml, usesStock, locId, date, letterPackType, trackingNumber, items, hint }){
  const m = SHIP_DIALOG[mode] ? mode : "ship";
  const cfg = SHIP_DIALOG[m];
  return new Promise((resolve)=>{
    if(shipDoneCtx && shipDoneCtx.resolve) shipDoneCtx.resolve(null);
    shipDoneCtx = { resolve, items: items||[], usesStock: !!usesStock, mode: m };
    document.getElementById("shipDoneTitle").textContent = title || cfg.title;
    document.getElementById("shipDoneSummary").innerHTML = summaryHtml || "";
    document.getElementById("shipDoneDateLabel").textContent = cfg.dateLabel;
    document.getElementById("shipDoneDate").value = date || today();
    document.getElementById("shipDoneLp").value = letterPackOrDefault(letterPackType); // 未設定はプラス（赤）
    // 追跡番号は発送済にするとき・記録のみのときだけ（任意）
    document.getElementById("shipDoneTrackWrap").style.display = m==="request" ? "none" : "";
    document.getElementById("shipDoneTrack").value = trackingNumber || "";
    const needLoc = !!usesStock && stockItems(items).length>0;
    document.getElementById("shipDoneOriginWrap").style.display = needLoc ? "" : "none";
    if(needLoc) fillLocationSelect(document.getElementById("shipDoneOrigin"), locId);
    document.getElementById("shipDoneStockNote").textContent = usesStock ? "" : "直送（AB Circleから直接）のため、自社在庫は動きません。";
    document.getElementById("shipDoneNote").textContent = cfg.note;
    document.getElementById("shipDoneBtnLabel").textContent = cfg.button;
    document.getElementById("shipDoneError").style.display = "none";
    // 伴走支援が済んだ案件など、すでに届いている可能性があるときの注意（依頼のときだけ出す）
    const nh = document.getElementById("shipDoneHint");
    nh.textContent = hint || ""; nh.style.display = hint ? "block" : "none";
    updateShipDoneHint();
    updateShipDoneLpNotice();
    document.getElementById("shipDoneModal").classList.add("open");
  });
}
// 確認ダイアログ（出荷を依頼する／発送済にする）の注意。出荷元が滋賀以外で、レターパックの種類が入っているとき（2026-10-27）
function updateShipDoneLpNotice(){
  const el=document.getElementById("shipDoneLpNotice");
  if(!el) return;
  const w=document.getElementById("shipDoneOriginWrap");
  const origin=(w && w.style.display!=="none") ? (document.getElementById("shipDoneOrigin").value||"") : "";
  const letterPack=!!document.getElementById("shipDoneLp").value;
  const msg=lpPickupNotice({ originLocationId:origin, defaultLocationId:defaultLocationId(), letterPack });
  el.textContent=msg; el.style.display=msg?"block":"none";
}
function updateShipDoneHint(){
  updateShipDoneLpNotice();
  if(!shipDoneCtx || !shipDoneCtx.usesStock) return;
  const its = stockItems(shipDoneCtx.items);
  const locId = document.getElementById("shipDoneOrigin").value;
  const verb = shipDoneCtx.mode==="request" ? "発送済にしたときに引き落とします（いまは動かしません）" : "引き落とします";
  document.getElementById("shipDoneStockNote").textContent = its.length
    ? `${locationName(locId)||"保管場所未選択"} の在庫から ${its.map(it=>`${it.sku} × ${it.qty}`).join("・")} を${verb}。`
    : "在庫を使う品目はありません。";
}
function closeShipDone(result){
  document.getElementById("shipDoneModal").classList.remove("open");
  const c = shipDoneCtx; shipDoneCtx = null;
  if(c && c.resolve) c.resolve(result || null);
}
function doShipDone(){
  if(!shipDoneCtx) return;
  const m = shipDoneCtx.mode, cfg = SHIP_DIALOG[m];
  const err = document.getElementById("shipDoneError"); err.style.display = "none";
  const fail = (msg)=>{ err.textContent = msg; err.style.display = "block"; };
  const shipDate = document.getElementById("shipDoneDate").value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)) return fail(`${cfg.dateLabel}を入れてください`);
  const its = shipDoneCtx.usesStock ? stockItems(shipDoneCtx.items) : [];
  let originLocationId = "";
  if(its.length){
    // 依頼のときも出荷元は必須（センターが迷わないように・§9 決定7）。発送済の画面で変えられる
    originLocationId = document.getElementById("shipDoneOrigin").value;
    if(!originLocationId) return fail("出荷元の保管場所を選んでください（未登録なら在庫タブから追加できます）");
    const short = [];
    for(const [sku, q] of Object.entries(qtyBySku(its))){
      const p = products.find(x=>x.id===sku)||{};
      if(stockAt(p, originLocationId) < q) short.push(`${p.name||sku}（${locationName(originLocationId)} ${stockAt(p,originLocationId)} / 出荷 ${q}）`);
    }
    if(short.length){
      // 依頼の時点では止めない（在庫は発送済のときに引く）。発送済・記録のみは止める（最終判定はトランザクションの中）
      if(m!=="request") return fail(`在庫が足りません: ${short.join("、")}。入荷を登録するか、別の保管場所を選んでください。`);
      if(!confirm(`在庫が足りません: ${short.join("、")}\n依頼は出せますが、「発送済にする」の時点で在庫が必要です（足りないと発送済にできません）。依頼を続けますか？`)) return;
    }
  }
  closeShipDone({ shipDate, originLocationId, letterPackType: document.getElementById("shipDoneLp").value || "",
    trackingNumber: m==="request" ? "" : document.getElementById("shipDoneTrack").value.trim() });
}
function shipSummaryHtml(s){
  return `<div><strong>${esc(s.company||s.partnerName||"")}</strong> ${esc(s.officeName||"")}</div>`
    + `<div style="font-size:12px;color:var(--color-ink-muted)">${esc([s.postal?`〒${s.postal}`:"", s.address||""].filter(Boolean).join(" "))}</div>`;
}
function staleMsg(cur){
  return `この出荷はすでに「${SHIP_STATUS[shipStatusOf(cur)]||cur.status}」です（別の人が先に操作した可能性があります）。画面を更新してください`;
}

// 出荷の下書き(draft) → 依頼済(requested)（旧 confirmDraftShipment）。
// 在庫は動かさない。出荷指示を投稿する。トランザクションで「まだ下書きか」を確かめる（2人が同時に押しても依頼は1回）
async function requestDraftShipment(s){
  const usesStock = usesWarehouse(s);
  const hint = await deliveredHint(s);
  const ans = await askShipDetails({ mode:"request", hint: hint||"",
    title: `出荷を依頼する（${s.soNumber||""}）`, summaryHtml: shipSummaryHtml(s),
    usesStock, locId: shipLocationOf(s), date: s.shipDate||today(), letterPackType: s.letterPackType, items: s.items,
  });
  if(!ans) return;
  const its = usesStock ? stockItems(s.items) : [];
  const ref = doc(db,"shipments",s._id);
  try{
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(ref);
      if(!snap.exists()) throw new Error("この出荷は削除されています。画面を更新してください");
      const cur = snap.data();
      if(nextStatus(shipStatusOf(cur),"request")!=="requested") throw new Error(staleMsg(cur));
      tx.update(ref, {
        status:"requested", shipDate:ans.shipDate,
        ...(its.length ? { originLocationId: ans.originLocationId, originLocationName: locationName(ans.originLocationId) } : {}),
        ...letterPackPatch(ans.letterPackType), ...requestedStampPatch(), updatedAt: serverTimestamp() });
    });
  }catch(e){ alert(`出荷の依頼に失敗しました: ${e.message}`); return; }
  const head = `${s.soNumber} の出荷を依頼しました（在庫は発送済にしたときに引き落とします）`;
  toast(`${head}。出荷指示を投稿しています...`);
  toast(`${head}。${await postShipNotice(s._id)}`);
}

// 依頼済(requested) → 発送済(shipped)：markShipped ／ 下書き(draft) → 発送済（記録のみ）：recordShippedDirect。
// 1つのトランザクションで「状態がまだ依頼済（記録のみは下書き）か」「出荷元の在庫が足りるか」を確かめてから、
// 出荷を発送済にして在庫を引き落とす。2人が同時に押しても2回目は状態の確認で止まる（既存バグ3の修正）。
// 認定事業者の受注から作った出荷は、受注の状態も「出荷済」にする（§9 決定5）。出荷指示は投稿しない。
async function shipWithStock(s, action){
  const mode = action==="recordShipped" ? "record" : "ship";
  const usesStock = usesWarehouse(s);
  const ans = await askShipDetails({ mode,
    title: `${SHIP_DIALOG[mode].title}（${s.soNumber||""}）`, summaryHtml: shipSummaryHtml(s),
    usesStock, locId: shipLocationOf(s), date: mode==="record" ? (s.shipDate||today()) : today(),
    letterPackType: s.letterPackType, trackingNumber: s.trackingNumber||"", items: s.items,
  });
  if(!ans) return;
  const ref = doc(db,"shipments",s._id);
  let moved = 0;
  try{
    await runTransaction(db, async (tx)=>{
      moved = 0; // トランザクションは再試行されることがあるので、毎回ここで初期化
      const snap = await tx.get(ref);
      if(!snap.exists()) throw new Error("この出荷は削除されています。画面を更新してください");
      const cur = snap.data();
      if(nextStatus(shipStatusOf(cur), action)!=="shipped") throw new Error(staleMsg(cur));
      // 在庫は最新の明細（cur.items）で引く。読み取りは書き込みより前にまとめて済ませる（Firestore トランザクションの決まり）
      const need = usesWarehouse(cur) ? qtyBySku(cur.items) : {};
      const skus = Object.keys(need).filter(k=>need[k]>0);
      const locId = skus.length ? (ans.originLocationId || shipLocationOf(cur)) : "";
      for(const sku of skus){
        const p = (await tx.get(doc(db,"products",sku))).data()||{};
        const have = Number((p.stockByLocation||{})[locId])||0;
        if(have < need[sku]) throw new Error(`在庫不足: ${p.name||sku}（${locationName(locId)} ${have} / 出荷 ${need[sku]}）。入荷を登録するか、別の保管場所を選んでください`);
      }
      const po = cur.partnerOrderId ? await tx.get(doc(db,"partnerOrders",cur.partnerOrderId)) : null;
      tx.update(ref, {
        status:"shipped", shipDate:ans.shipDate, confirmedAt:serverTimestamp(),
        ...(skus.length ? { originLocationId: locId, originLocationName: locationName(locId) } : {}),
        ...letterPackPatch(ans.letterPackType), ...shippedStampPatch(),
        ...(ans.trackingNumber ? { trackingNumber: ans.trackingNumber } : {}),
        ...(action==="recordShipped" ? noNoticePatch() : {}),
        updatedAt: serverTimestamp() });
      for(const sku of skus){
        tx.update(doc(db,"products",sku), stockPatch(locId, -need[sku]));
        tx.set(doc(collection(db,"inventoryMovements")), movement(sku, -need[sku], "shipment", s.soNumber, locId));
        moved++;
      }
      if(po && po.exists()) tx.update(po.ref, { status:"shipped", updatedAt: serverTimestamp() });
    });
  }catch(e){ alert(`発送済にできませんでした: ${e.message}`); return; }
  const head = `${s.soNumber} を発送済にしました${moved ? "（在庫から引き落としました）" : ""}`;
  toast(action==="recordShipped" ? `${head}。${NO_NOTICE_MSG}` : head);
}
function markShipped(s){ return shipWithStock(s, "markShipped"); }
function recordShippedDirect(s){ return shipWithStock(s, "recordShipped"); }

// 依頼済(requested) → 下書き(draft)。在庫は動かさない（まだ引いていない）。出荷指示の取り消しは人が連絡する。
// 出荷指示の投稿の印（shipNotifiedAt/shipNotifyStatus/shipNotifyLockAt）を消す。
// 消さないと、直して依頼し直したときに notifyShipment が「投稿済み」とみなして投稿しない（functions/index.js notifyShipment）
async function revertToDraft(s){
  if(notifyInFlight(s)){ alert(NOTIFY_IN_FLIGHT_MSG); return; }
  const posted = !!s.shipNotifiedAt;
  if(!confirm(`出荷 ${s.soNumber} の依頼を取り消して、下書きへ戻します。\n`
    + (posted ? `出荷指示は ${fmtDT(s.shipNotifiedAt)} に投稿済みです。センターへ取り消しの連絡をしてください（自動では取り消しません）。\n` : "")
    + `在庫はまだ引き落としていないので動きません。よろしいですか？`)) return;
  const ref = doc(db,"shipments",s._id);
  try{
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(ref);
      if(!snap.exists()) throw new Error("この出荷は削除されています。画面を更新してください");
      const cur = snap.data();
      if(nextStatus(shipStatusOf(cur),"revertToDraft")!=="draft") throw new Error(staleMsg(cur));
      if(notifyInFlight(cur)) throw new Error(NOTIFY_IN_FLIGHT_MSG); // 送信中は取り消さない（Codex 指摘4）
      tx.update(ref, {
        status:"draft", requestRevertedAt: serverTimestamp(), requestRevertedBy: currentUser.displayName||currentUser.email,
        shipNotifiedAt: deleteField(), shipNotifyStatus: deleteField(), shipNotifyLockAt: deleteField(),
        updatedAt: serverTimestamp() });
    });
  }catch(e){ alert(`依頼の取り消しに失敗しました: ${e.message}`); return; }
  toast(`${s.soNumber} を下書きへ戻しました${posted ? "。センターへ出荷指示の取り消しを連絡してください" : ""}`);
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
// ゆうパックの送料は発地で変わる。発送元に選んだ場所の都道府県を出して取り違えを防ぐ。
// 料金表そのものは1つ（滋賀発で作られている）なので、違う発地のときは注意を出す。
function updateShipOriginHint(){
  const el=document.getElementById("shipOriginHint");
  const locId=(document.getElementById("shipOrigin")||{}).value||"";
  const pref=locationPref(locId);
  const opt=document.getElementById("shipYupackOpt");
  if(opt) opt.textContent = pref ? `ゆうパック（まとめ・${pref}発）` : "ゆうパック（まとめ）";
  updateShipLpNotice();
  if(!el) return;
  const m=(document.getElementById("shipMethod")||{}).value||"";
  el.textContent = (m==="yupack" && pref && pref!=="滋賀県")
    ? `※ 送料表は滋賀発の料金です。${pref}発は金額が変わることがあるので、送料欄をご確認ください。`
    : "";
}

// 滋賀（既定の保管場所）以外から出す出荷で、レターパックを選んでいるときの注意（止めずに表示だけ・2026-10-27）。
// レターパックを選んでいる＝配送方法が「レターパック」、または配送方法が未指定で種類の欄（新規登録だけ）に種類が入っている
function updateShipLpNotice(){
  const el=document.getElementById("shipLpNotice");
  if(!el) return;
  const shown=(id)=>{ const w=document.getElementById(id); return !!w && w.style.display!=="none"; };
  const origin = shown("shipOriginWrap") ? ((document.getElementById("shipOrigin")||{}).value||"") : "";
  const method=(document.getElementById("shipMethod")||{}).value||"";
  const lp=(document.getElementById("shipLetterPack")||{}).value||"";
  const letterPack = method==="letterpack" || (method==="" && shown("shipLetterPackWrap") && lp!=="");
  const msg=lpPickupNotice({ originLocationId:origin, defaultLocationId:defaultLocationId(), letterPack });
  el.textContent=msg; el.style.display=msg?"block":"none";
}

// 配送方法に応じて送料・名目を自動入力（手入力は維持）
function recalcShipFee(){
  updateShipOriginHint();
  const method=document.getElementById('shipMethod').value;
  const feeEl=document.getElementById('shipFee'), labelEl=document.getElementById('shipFeeLabel');
  document.getElementById('yupackWrap').style.display = method==='yupack' ? '' : 'none';
  // 料金表（レターパック・ゆうパック）は税込の実費 → 送料欄は税抜なので換算して入れる
  if(method==='letterpack'){
    const packs=Math.max(1,Math.ceil(shipTotalQty()/3));
    feeEl.value=taxExcl(packs*letterpackFee()); labelEl.value=`送料（レターパック ${packs}通）`;
  } else if(method==='none'){
    // 郵送しない（手渡し・持参・現地設置）。送料は 0 円で、出庫の記録だけ残す
    feeEl.value=0; labelEl.value='郵送なし（手渡し・持参）';
    document.getElementById('yupackWrap').style.display='none';
  } else if(method==='yupack'){
    const d=yupackData(); const size=document.getElementById('shipYuSize').value;
    const ri=parseInt(document.getElementById('shipYuRegion').value,10)||0;
    const arr=d.rows[size]||YUPACK_ROWS_DEF[size]||[];
    feeEl.value=taxExcl(Number(arr[ri])||0); labelEl.value=`送料（ゆうパック ${size}サイズ・${d.regions[ri]||""}）`;
  } else return; // 「指定しない」＝手入力のまま。注意の表示もそのまま残す
  // 自動入力した値は必ず税抜なので、税込の入力に対する注意は消す
  const w=document.getElementById('shipFeeWarn'); if(w){ w.style.display="none"; w.innerHTML=""; }
}
// 料金表（レターパック・ゆうパック）に載っている「税込の実費」の候補を作る。
// 送料欄は税抜で入れる決まりなので、この値がそのまま入っていたら税込を打ち間違えた疑いが強い。
// 料金表は appConfig（未設定時は supply-pricing.js のデフォルト）が正＝ここに金額を直書きしない。
function taxInclusiveShipFees(){
  const set=new Set();
  const lp=letterpackFee();
  if(lp>0) for(let n=1;n<=30;n++) set.add(lp*n);       // レターパックは3台ごとに1通＝通数分の倍数になる
  const d=yupackData();
  Object.values(d.rows||{}).forEach(arr=>{
    (Array.isArray(arr)?arr:[]).forEach(v=>{ const n=Number(v)||0; if(n>0) set.add(n); });
  });
  return set;
}
/**
 * 送料欄に税込の実費がそのまま入っていないか確認する（注意を出すだけで、保存は止めない）。
 * 税込候補と「別の税込候補を税抜換算した値」が一致する金額（現行表では 2,500 / 6,000 / 12,000 の3つ）は
 * どちらとも取れるので、断定せず「確認してください」に落とす。
 */
function checkShipFeeTaxIncl(){
  const warn=document.getElementById("shipFeeWarn");
  if(!warn) return;
  const clear=()=>{ warn.style.display="none"; warn.innerHTML=""; };
  const v=Number(document.getElementById("shipFee").value)||0;
  const incl=taxInclusiveShipFees();
  if(!(v>0) || !incl.has(v) || taxExcl(v)===v){ clear(); return; }
  const ambiguous=[...incl].some(x=>taxExcl(x)===v); // 税抜として自動入力されうる値でもある
  const excl=taxExcl(v);
  warn.innerHTML = ambiguous
    ? `${yen(v)} は料金表の<strong>税込</strong>の金額とも、別の便の<strong>税抜</strong>の金額とも一致します。`
      + `送料欄は<strong>税抜</strong>です。税込の実費を打っていないかご確認ください（税込なら税抜は ${yen(excl)}）。`
    : `<strong>税込の金額が入っていませんか？</strong> ${yen(v)} は料金表の<strong>税込</strong>の実費と一致します。`
      + `送料欄は税抜で入力してください（税抜は <strong>${yen(excl)}</strong> です）。`
      + ` <button type="button" class="btn btn-secondary" id="shipFeeToExclBtn" style="font-size:12px;padding:4px 8px">税抜（${yen(excl)}）に直す</button>`;
  warn.style.display="block";
  const btn=document.getElementById("shipFeeToExclBtn");
  if(btn) btn.onclick=()=>{ document.getElementById("shipFee").value=excl; clear(); };
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
  const w=document.getElementById('shipFeeWarn'); if(w){ w.style.display="none"; w.innerHTML=""; }
  document.querySelectorAll('#shipItems .qty-input').forEach(i=>i.addEventListener('input',recalcShipFee));
}

// ===== 出荷モーダル =====
let activePartners = [];
// ===== 出荷の修正 =====
// 登録したあとに数量・送付先・送料を直せるようにする（2026-09-01）。
// 直すときの決めごと:
//   ・出荷種別（＝請求先）はここでは変えない。付け替えは「請求先を変える」ボタン側の担当。
//     あちらは単価を入れ直すかどうかをプレビュー付きで選ばせるので、二重に持たない
//   ・もともと入っていた品番の単価は動かさない。修正は「直す」ためのもので、
//     値段を作り直すためのものではない（直送発注から作った出荷は発注時の単価で入っている）
//   ・請求済・入金済は、請求書を出した後なので金額に関わる欄を触らせない。
//     送付先の書き間違いだけは直せるようにする（金額が変わらないため）
//   ・在庫は「差分」だけ動かす。3→5 なら 2台ぶんだけ引く（発送済にしたときにすでに3台引いてある）
//     下書き・依頼済はまだ在庫を引いていないので、数量を直しても在庫は動かさない（stockDeducted・2026-10-21 既存バグ2）
let editingShip = null;                 // 修正中の出荷（新規登録なら null）
function shipIsLocked(s){ return !!s && isLocked(s); }

// ===== 伴走支援費（電話・紙で受けた案件など、CRMで手作りする出荷の穴埋め・2026-09-14）=====
// Webからのお申し込みは Cloud Functions（shipmentItemsFromQuote）が「カードリーダー」に加えて
// 「伴走支援費」「金額調整」の明細を自動で入れるので、請求書が助成金の上限額（見積もりと同額）になる。
// CRMで手作りする出荷（電話・紙で受けた案件）には同じ仕組みが無かったので、ここで同じ形の明細を作れるようにする。
// 事業所へ直接請求する出荷（direct）だけが対象。認定事業者への直送（dropship）は卸なので対象外。
function subsidyApplicableFor(s){
  return s ? !(s.shipType==="dropship" || s.partnerEmail)
           : document.getElementById("shipType").value!=="dropship";
}
function subsidyEnabled(){
  const el=document.getElementById("shipSubsidyOn");
  return !!(el && el.checked);
}
function fillSubsidyPlanSelect(){
  const el=document.getElementById("shipSubsidyPlan"); const EP=window.EstimatePricing;
  if(!el || !EP) return;
  el.innerHTML = '<option value="">選択してください</option>' +
    Object.keys(EP.PLANS).map(k=>{ const p=EP.PLANS[k];
      return `<option value="${esc(k)}">${esc(p.label)}（上限${yen(p.limit)}・最大${p.maxQty}台）</option>`; }).join("");
}
// 商品欄（#shipItems）に今入っている品番別の台数。伴走支援の既定値・自己負担の計算に使う
function subsidyProductQty(){
  const EP=window.EstimatePricing;
  const qtyOf=(sku)=>{ const inp=document.querySelector(`#shipItems .qty-input[data-sku="${sku}"]`); return inp?(parseInt(inp.value,10)||0):0; };
  if(!EP) return {bt:0, usb:0};
  return { bt: qtyOf(EP.SKU.BT), usb: qtyOf(EP.SKU.USB_A)+qtyOf(EP.SKU.USB_C) };
}
// 補助対象台数の既定値。Bluetoothを優先してプランの最大台数まで割り当て、残り枠をUSBに充当する
function subsidyAutoTargets(){
  const EP=window.EstimatePricing; if(!EP) return null;
  const plan=EP.PLANS[document.getElementById("shipSubsidyPlan").value]; if(!plan) return null;
  const prod=subsidyProductQty();
  const bt=Math.min(prod.bt, plan.maxQty);
  const usb=Math.min(prod.usb, Math.max(0, plan.maxQty-bt));
  return {bt, usb};
}
// 人が手で台数を直したら data-auto="0" が立つ。以後は商品欄が変わっても勝手に上書きしない
function refreshSubsidyAutoDefaults(){
  if(!subsidyEnabled()) return;
  const t=subsidyAutoTargets(); if(!t) return;
  const btEl=document.getElementById("shipSubsidyBt"), usbEl=document.getElementById("shipSubsidyUsb");
  if(btEl && btEl.dataset.auto!=="0") btEl.value=t.bt;
  if(usbEl && usbEl.dataset.auto!=="0") usbEl.value=t.usb;
}
// 伴走支援費まわりの金額（EstimatePricing.computeAmounts の戻り値そのもの）。プラン未選択なら null
function subsidyAmounts(){
  const EP=window.EstimatePricing; if(!EP) return null;
  const planKey=document.getElementById("shipSubsidyPlan").value;
  if(!EP.PLANS[planKey]) return null;
  const btSub=parseInt(document.getElementById("shipSubsidyBt").value,10)||0;
  const usbSub=parseInt(document.getElementById("shipSubsidyUsb").value,10)||0;
  const prod=subsidyProductQty();
  const btExtra=Math.max(0, prod.bt-btSub), usbExtra=Math.max(0, prod.usb-usbSub);
  return EP.computeAmounts(planKey, btSub, usbSub, btExtra, usbExtra);
}
// チェックONなら Cloud Functions の shipmentItemsFromQuote と同じ形の明細（sku/name/qty/unitPrice/nonStock）を返す
function subsidyExtraItems(){
  if(!subsidyEnabled()) return [];
  const a=subsidyAmounts(); if(!a) return [];
  const items=[];
  if(a.accFeeIncl>0) items.push({ sku:"support-fee", name:`伴走支援費（補助対象${a.subsidyTotal}台）`, qty:1, unitPrice:a.accFeeIncl, nonStock:true });
  if(a.discount>0) items.push({ sku:"discount", name:"金額調整", qty:1, unitPrice:-a.discount, nonStock:true });
  return items;
}
// 出荷ドキュメントに保存する伴走支援費の付帯情報（修正で開いたときの復元用。明細そのものは resolveShipItems 側）
function subsidyPatch(){
  return subsidyEnabled()
    ? { subsidyCategory: document.getElementById("shipSubsidyPlan").value||"",
        subsidyQty: { bt: parseInt(document.getElementById("shipSubsidyBt").value,10)||0,
                      usb: parseInt(document.getElementById("shipSubsidyUsb").value,10)||0 } }
    : { subsidyCategory: "", subsidyQty: { bt:0, usb:0 } };
}
function subsidyPlanMissing(){
  if(!subsidyEnabled()) return false;
  const EP=window.EstimatePricing;
  return !(EP && EP.PLANS[document.getElementById("shipSubsidyPlan").value]);
}
// モーダル内訳表示（送料は含まない・カードリーダー＋伴走支援費＋金額調整のみ）
function updateSubsidyBody(){
  const bd=document.getElementById("shipSubsidyBreakdown"); if(!bd) return;
  if(!subsidyEnabled()){ bd.innerHTML=""; return; }
  const a=subsidyAmounts();
  if(!a){ bd.innerHTML=`<span style="color:var(--color-danger)">プランを選んでください</span>`; return; }
  bd.innerHTML = `伴走支援費 ${yen(a.accFeeIncl)}（補助対象${a.subsidyTotal}台）<br>`
    + (a.discount>0 ? `金額調整 −${yen(a.discount)}<br>` : "")
    + `合計（税込） ${yen(a.totalIncl)}<br>`
    + `助成金充当 ${yen(a.grantAmt)}　／　自己負担 ${yen(a.selfPay)}`;
}
// 修正モードで開いたとき、保存済みの出荷から伴走支援費の入力欄を復元する
function restoreSubsidyFromShip(s){
  const items=s.items||[];
  const supportItem=items.find(i=>i.sku==="support-fee");
  const onEl=document.getElementById("shipSubsidyOn"), planEl=document.getElementById("shipSubsidyPlan");
  const btEl=document.getElementById("shipSubsidyBt"), usbEl=document.getElementById("shipSubsidyUsb");
  const EP=window.EstimatePricing;
  onEl.checked=!!supportItem;
  document.getElementById("shipSubsidyBody").style.display = onEl.checked ? "" : "none";
  if(!supportItem){
    planEl.value=""; btEl.value=0; btEl.dataset.auto="1"; usbEl.value=0; usbEl.dataset.auto="1";
    return;
  }
  planEl.value = (s.subsidyCategory && EP && EP.PLANS[s.subsidyCategory]) ? s.subsidyCategory : "";
  if(s.subsidyQty && (Number.isFinite(Number(s.subsidyQty.bt)) || Number.isFinite(Number(s.subsidyQty.usb)))){
    btEl.value=Number(s.subsidyQty.bt)||0; btEl.dataset.auto="0";
    usbEl.value=Number(s.subsidyQty.usb)||0; usbEl.dataset.auto="0";
  }else{
    // 保存値が無い古い出荷: 「伴走支援費（補助対象N台）」の N から逆引き。プランは未選択のまま人に選ばせる
    const m=/補助対象(\d+)台/.exec(supportItem.name||"");
    btEl.value=m?parseInt(m[1],10):0; btEl.dataset.auto="0";
    usbEl.value=0; usbEl.dataset.auto="0";
  }
  // Web申込で作られた出荷（subsidyCategory 未保存）は、紐づく見積もり（quotes）→ 案件（cases）の順にプランと補助対象台数を補う。
  // 非同期なので開いた直後は「プランを選んでください」が一瞬出るが、取れれば自動で埋まり内訳が更新される（2026-09-14）
  if(!planEl.value && (s.quoteId || s.caseId)) inferSubsidyFromLinks(s).catch(()=>{});
}
async function inferSubsidyFromLinks(s){
  const EP=window.EstimatePricing; if(!EP) return;
  const planEl=document.getElementById("shipSubsidyPlan"), btEl=document.getElementById("shipSubsidyBt"), usbEl=document.getElementById("shipSubsidyUsb");
  let plan=null, bt=null, usb=null;
  if(s.quoteId){
    const q=await getDoc(doc(db,"quotes",s.quoteId));
    if(q.exists()){ const d=q.data(); plan=d.plan||null;
      bt=(d.items||[]).filter(i=>i.sku===EP.SKU.BT).reduce((a,i)=>a+(Number(i.subsidyQty)||0),0);
      usb=(d.items||[]).filter(i=>i.sku!==EP.SKU.BT).reduce((a,i)=>a+(Number(i.subsidyQty)||0),0); }
  }
  if(!plan && s.caseId){
    const c=await getDoc(doc(db,"cases",s.caseId));
    if(c.exists()) plan=c.data().subsidyCategory||null;
  }
  if(editingShip!==s) return;           // 別の出荷を開き直していたら触らない
  if(!planEl.value && plan && EP.PLANS[plan]) planEl.value=plan;
  if(bt!==null && (bt||usb)){ btEl.value=bt; usbEl.value=usb; btEl.dataset.auto="0"; usbEl.dataset.auto="0"; }
  updateShipTotal();
}

// 数量欄・送料から、実際に保存される明細（単価つき）を組み立てる。合計表示と保存で同じものを使う
function resolveShipItems(){
  // 修正時に「新しく足した品番」へ入れる単価の基準。
  // 古い出荷には shipType:"stock" という今の選択肢に無い値が入っている（SH-2026-0001）。
  // それらも請求先は認定事業者なので、shipType の文字だけで見ずに
  // 「認定事業者に請求する出荷か（partnerEmail があるか）」で卸価格を選ぶ。
  const shipType = editingShip
    ? ((editingShip.shipType==="dropship" || editingShip.partnerEmail) ? "dropship" : "direct")
    : document.getElementById("shipType").value;
  const orig = {};
  (editingShip?.items||[]).forEach(i=>{ orig[i.sku] = i; });
  const productItems = collectItems("shipItems").map(it=>{
    const p = products.find(x=>x.id===it.sku) || {};
    const was = orig[it.sku];
    // 修正時、もともと入っていた品番は当時の単価を保つ。新しく足した品番だけ今の基準で入れる
    const unitPrice = (was && Number(was.unitPrice) >= 0)
      ? Number(was.unitPrice)
      : (shipType==="dropship" ? partnerPriceFor(p, it.qty) : (p.listPrice||0));
    return {...it, unitPrice};
  });
  // 伴走支援費・金額調整（チェックONのときだけ・Webからのお申し込みと同じ形の明細を末尾に足す）
  return productItems.concat(subsidyExtraItems());
}

// 保存前に金額が見えるようにする（今までモーダルに合計が無く、保存して一覧で初めて分かる状態だった）
function updateShipTotal(){
  const el=document.getElementById("shipTotalLine"); if(!el) return;
  refreshSubsidyAutoDefaults(); // 商品欄の台数が変わったら伴走支援の既定値も出し直す（手で直した欄は上書きしない）
  updateSubsidyBody();
  const items=resolveShipItems();
  const fee=Number(document.getElementById("shipFee").value)||0;
  // 税基準は請求先で変わる。修正中はその出荷、新規は画面の出荷種別から見る
  const basis = editingShip || { shipType: document.getElementById("shipType").value,
                                 partnerEmail: document.getElementById("shipPartner").value||"" };
  const t = invoiceTotals({ shipType: basis.shipType, partnerEmail: basis.partnerEmail, items, shippingFee: fee });
  const wasIncl = editingShip ? shipTotalIncl(editingShip) : null;
  const now = t.total;
  const diff = (wasIncl!==null && now!==wasIncl)
    ? ` <span style="color:var(--color-warn,#c87a1f);font-weight:700">（登録時 ${yen(wasIncl)} から変わります）</span>` : "";
  el.innerHTML = items.length
    ? (t.taxIncluded
        ? `商品 ${yen(t.goods)}（税込）　＋　送料 ${yen(t.shipIncl)}（税込）　＝　<strong style="font-size:15px">${yen(now)}</strong>（税込・うち消費税 ${yen(t.tax)}）${diff}`
        : `商品 ${yen(t.goods)}　＋　送料 ${yen(fee)}　＋　消費税 ${yen(t.tax)}　＝　<strong style="font-size:15px">${yen(now)}</strong>（税込）${diff}`)
    : `<span style="color:var(--color-ink-muted)">数量を入力すると合計が出ます</span>`;
}

function openShip(existing){
  editingShip = existing || null;
  prefillCaseId = null;   // 案件から開いた場合は prefillShipFromCase が開いた後に入れ直す
  const s = editingShip;
  itemRows("shipItems");
  document.getElementById("shipStockWarn").style.display="none";
  // 請求先プルダウン（有効パートナー）
  document.getElementById("shipPartner").innerHTML = '<option value="">選択してください</option>'+
    activePartners.map(p=>`<option value="${esc(p._id)}">${esc(p.partnerName||p._id)}</option>`).join("");
  initShipFeeControls();
  fillSubsidyPlanSelect();

  const title=document.getElementById("shipModalTitle");
  const label=document.getElementById("saveShipLabel");
  const note=document.getElementById("shipEditNote");
  const typeSel=document.getElementById("shipType");
  const locked = shipIsLocked(s);

  if(!s){
    title.textContent="新規出荷（→認定事業者・事業所）";
    label.textContent="登録して出荷を依頼する";
    note.style.display="none";
    // 既定は「登録して出荷を依頼する」（requested）。すでに届いている出荷だけチェックで発送済として登録（2026-10-21）
    const already=document.getElementById("shipAlreadyShipped"); if(already) already.checked=false;
    document.getElementById("shipDate").value=today();
    ["shipPostal","shipCompany","shipOffice","shipAddress","shipContact","shipPhone","shipEmail"].forEach(id=>document.getElementById(id).value="");
    typeSel.value="direct"; typeSel.disabled=false;
    document.getElementById("shipPartner").disabled=false; // 修正モードで止めたままにしない
    document.getElementById("shipPartnerWrap").style.display="none";
    // 伴走支援費ブロックをまっさらに戻す
    document.getElementById("shipSubsidyOn").checked=false;
    document.getElementById("shipSubsidyBody").style.display="none";
    document.getElementById("shipSubsidyPlan").value="";
    const btEl0=document.getElementById("shipSubsidyBt"), usbEl0=document.getElementById("shipSubsidyUsb");
    btEl0.value=0; btEl0.dataset.auto="1"; usbEl0.value=0; usbEl0.dataset.auto="1";
  }else{
    title.textContent=`出荷の修正（${s.soNumber||""}）`;
    label.textContent="修正を保存";
    document.getElementById("shipDate").value=s.shipDate||today();
    document.getElementById("shipPostal").value=s.postal||"";
    document.getElementById("shipCompany").value=s.company||"";
    document.getElementById("shipOffice").value=s.officeName||"";
    document.getElementById("shipAddress").value=s.address||"";
    document.getElementById("shipContact").value=s.contactName||"";
    document.getElementById("shipPhone").value=s.phone||"";
    document.getElementById("shipEmail").value=s.email||"";
    // 種別（請求先）はここでは変えない。表示だけ合わせて操作させない
    typeSel.value = s.shipType==="dropship" ? "dropship" : "direct";
    typeSel.disabled = true;
    const isDrop = s.shipType==="dropship";
    document.getElementById("shipPartnerWrap").style.display = isDrop ? "" : "none";
    document.getElementById("shipPartner").value = s.partnerEmail||"";
    document.getElementById("shipPartner").disabled = true;
    // 数量を戻す
    (s.items||[]).forEach(i=>{
      const inp=document.querySelector(`#shipItems .qty-input[data-sku="${i.sku}"]`);
      if(inp) inp.value=Number(i.qty)||0;
    });
    // 伴走支援費の入力欄も保存済みの出荷から復元する
    restoreSubsidyFromShip(s);
    // 送料まわり（initShipFeeControls が空にした後に入れ直す）
    document.getElementById("shipMethod").value=s.shippingMethod&&s.shippingMethod!=="manual"?s.shippingMethod:"";
    document.getElementById("shipFee").value=Number(s.shippingFee)||0;
    document.getElementById("shipFeeLabel").value=s.shippingLabel||"";
    document.getElementById("yupackWrap").style.display =
      document.getElementById("shipMethod").value==="yupack" ? "" : "none";

    note.style.display="block";
    note.innerHTML = locked
      ? `この出荷は<strong>${esc(SHIP_STATUS[s.status]||s.status)}</strong>です。請求書を出した後なので、`
        + `<strong>数量・送料・出荷日は変えられません</strong>（請求書に印字される内容のため）。送付先の書き間違いだけ直せます。<br>`
        + `金額を直す必要がある場合は、入金の記録を取り消して請求をやり直すか、この出荷を削除して作り直してください。`
      : `もともと入っている品番の単価は、登録したときのまま変えません（新しく足した品番だけ今の単価が入ります）。<br>`
        + `請求先（出荷種別）を付け替えるときは、このモーダルではなく一覧の<strong>「請求先を変える」</strong>から行ってください。`
        // 在庫を動かすかどうかは「すでに引き落としてあるか」（stockDeducted）で決まる。下書き・依頼済はまだ引いていない
        + (stockDeducted(s) ? `<br>数量を変えると、増減したぶんだけ自社在庫を動かします。`
          : !shipUsedStock(s) ? `<br>この出荷は直送（ABサークルから認定事業者へ直接）のため、数量を変えても自社在庫は動きません。`
          : `<br>この出荷はまだ発送済にしていないため、在庫は引き落としていません。数量を変えても在庫は動きません（発送済にしたときに引き落とします）。`)
        + (shipStatusOf(s)==="requested" ? `<br><strong>出荷を依頼済みです。</strong>数量・送付先を直したら、保存のあとで出荷指示を再送するか聞きます。` : "");
  }

  // 伴走支援費ブロックは事業所へ直接請求する出荷（direct）だけ表示。認定事業者への直送（卸）は対象外
  document.getElementById("shipSubsidyWrap").style.display = subsidyApplicableFor(s) ? "" : "none";

  // 金額に関わる欄のロック（伴走支援費も金額に関わるのでロック対象に含める）
  const moneyIds=["shipFee","shipFeeLabel","shipMethod","shipYuSize","shipYuRegion","shipDate",
    "shipSubsidyOn","shipSubsidyPlan","shipSubsidyBt","shipSubsidyUsb"];
  moneyIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.disabled=locked; });
  document.querySelectorAll("#shipItems .qty-input").forEach(i=>{ i.disabled=locked; });

  // 数量・送料をいじるたびに合計を出し直す
  document.querySelectorAll("#shipItems .qty-input").forEach(i=>i.addEventListener("input",updateShipTotal));
  updateShipTotal(); // 送料欄のリスナーは起動時に1回だけ張る（開くたびに足すと溜まる）

  // 開いてみて「やっぱりこの出荷ごと要らない」となる場面があるので、修正画面からも消せるようにする
  const delBtn=document.getElementById("deleteShipBtn");
  if(delBtn){
    // 削除できるのは下書きだけ（ship-flow.js の canDelete）。以前は修正画面からなら発送済も消せていた
    delBtn.style.display = (s && canDelete(s)) ? "" : "none";
    delBtn.onclick = async ()=>{
      const target=editingShip; if(!target) return;
      // 確認ダイアログと在庫の戻しは deleteShipment 側の作法に任せる。キャンセルしたら画面はそのまま
      const done = await deleteShipment(target);
      if(!done) return;
      document.getElementById("shipModal").classList.remove("open");
      editingShip=null;
    };
  }

  // 発送元の保管場所。直送（自社在庫を通らない）のときは隠す
  const usesStockNow = s ? shipUsedStock(s) : true;
  const ow=document.getElementById("shipOriginWrap");
  if(ow) ow.style.display = usesStockNow ? "" : "none";
  const oSel=document.getElementById("shipOrigin");
  if(oSel){ fillLocationSelect(oSel, s && s.originLocationId); oSel.disabled = locked; }
  updateShipOriginHint();
  // レターパックの種類（新規登録＝その場で発送済になるときだけ聞く。修正では出さない・2026-10-19）
  const lpw=document.getElementById("shipLetterPackWrap");
  if(lpw) lpw.style.display = s ? "none" : "";
  const lpSel=document.getElementById("shipLetterPack");
  if(lpSel && !s) lpSel.value=DEFAULT_LETTERPACK; // 初期値はプラス（赤）・2026-10-21

  document.getElementById("shipModal").classList.add("open");
}

// 在庫を動かす明細だけを取り出す。
// Webからのお申し込みで作った出荷には「伴走支援費」「特別割引」のような品物ではない明細が入る
// （請求書の金額を見積書と合わせるため）。これらは products に無いので、在庫処理から外す。
function stockItems(items){
  return (items||[]).filter(it=> it && !it.nonStock && products.some(p=>p.id===it.sku));
}

// 品番ごとの数量にまとめる（在庫の差分計算用）
function qtyBySku(items){
  const m={}; stockItems(items).forEach(i=>{ m[i.sku]=(m[i.sku]||0)+(Number(i.qty)||0); }); return m;
}

async function saveShip(){
  if(editingShip) return await saveShipEdit();
  const office=document.getElementById("shipOffice").value.trim();
  if(!office){ alert("事業所名を入力してください"); return; }
  const shipType=document.getElementById("shipType").value;
  const partnerEmail = shipType==="dropship" ? document.getElementById("shipPartner").value : "";
  if(shipType==="dropship" && !partnerEmail){ alert("直送の場合は請求先（認定事業者）を選択してください"); return; }
  const partnerName = (activePartners.find(p=>p._id===partnerEmail)||{}).partnerName||"";
  if(subsidyPlanMissing()){ alert("伴走支援費を含める場合はプランを選んでください"); return; }
  const items=resolveShipItems();
  if(!items.length){ alert("数量を入力してください"); return; }
  const originLocationId=(document.getElementById("shipOrigin")||{}).value||"";
  if(stockItems(items).length && !originLocationId){
    alert("発送元の保管場所を選んでください（未登録なら在庫タブから追加できます）"); return; }
  // 既定は「登録して出荷を依頼する」（requested・在庫は動かさない・出荷指示を投稿）。
  // チェック「すでに発送済として登録」のときだけ、従来どおりその場で発送済（在庫を引く・出荷指示は送らない）（2026-10-21）
  const alreadyShipped=!!(document.getElementById("shipAlreadyShipped")||{}).checked;
  const short=[];
  for(const [sku,q] of Object.entries(qtyBySku(items))){ const p=products.find(x=>x.id===sku)||{};
    if(stockAt(p,originLocationId)<q) short.push(`${p.name||sku}（${locationName(originLocationId)} ${stockAt(p,originLocationId)} / 出荷 ${q}）`); }
  if(short.length){
    const w=document.getElementById("shipStockWarn"); w.style.display="block"; w.textContent=`在庫不足: ${short.join("、")}`;
    if(alreadyShipped) return; // 発送済として登録するときは在庫が要る
    if(!confirm(`在庫が足りません: ${short.join("、")}\n依頼は出せますが、「発送済にする」の時点で在庫が必要です（足りないと発送済にできません）。依頼を続けますか？`)) return;
  }
  const shippingMethod=document.getElementById("shipMethod").value||"manual";
  const shippingFee=Number(document.getElementById("shipFee").value)||0;
  const shippingLabel=document.getElementById("shipFeeLabel").value.trim()||(shippingFee>0?"送料":"");
  const shipDateIn=document.getElementById("shipDate").value||today();
  const letterPackType=(document.getElementById("shipLetterPack")||{}).value||"";
  // 押した人・日付・出荷元・種類を確認してから登録する（2026-10-19）
  const lpText = LETTERPACK_TYPE_LABEL[letterPackType] || "未選択";
  const hasStock = stockItems(items).length>0;
  const msg = alreadyShipped
    ? `出荷を「すでに発送済」として登録します（出荷指示は送りません）。\n発送日: ${shipDateIn}`
      + (hasStock ? `\n出荷元: ${locationName(originLocationId)}（在庫から引き落とします）` : "") + `\nレターパック: ${lpText}\nよろしいですか？`
    : `出荷を登録して、出荷を依頼します。\n希望出荷日: ${shipDateIn}`
      + (hasStock ? `\n出荷元: ${locationName(originLocationId)}（在庫は「発送済にする」のときに引き落とします）` : "")
      + `\nレターパック: ${lpText}\n登録すると、出荷指示を投稿します。よろしいですか？`;
  if(!confirm(msg)) return;
  const btn=document.getElementById("saveShipBtn"); btn.disabled=true;
  let newShipId="", soNumber="";
  try{
    soNumber=seqFmt("SH",await nextSeq("shipments"));
    const newRef=doc(collection(db,"shipments"));
    const data={
      soNumber, shipType, partnerEmail, partnerName,
      status: alreadyShipped ? "shipped" : "requested", shippingMethod, shippingFee, shippingLabel,
      ...letterPackPatch(letterPackType),
      ...(alreadyShipped ? { ...shippedStampPatch(), ...noNoticePatch(), confirmedAt: serverTimestamp() } : requestedStampPatch()),
      originLocationId, originLocationName: locationName(originLocationId),
      shipDate:shipDateIn,
      postal:document.getElementById("shipPostal").value.trim(),
      company:document.getElementById("shipCompany").value.trim(),
      officeName:office, address:document.getElementById("shipAddress").value.trim(),
      contactName:document.getElementById("shipContact").value.trim(),
      phone:document.getElementById("shipPhone").value.trim(),
      email:document.getElementById("shipEmail").value.trim(),
      ...(prefillCaseId ? { caseId: prefillCaseId } : {}),
      ...subsidyPatch(),
      items, createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email };
    if(alreadyShipped){
      // 出荷の作成と在庫の引き落としを1つのトランザクションで（在庫は最新の値で確かめる）
      const need=qtyBySku(items);
      await runTransaction(db, async (tx)=>{
        for(const sku of Object.keys(need)){
          const p=(await tx.get(doc(db,"products",sku))).data()||{};
          const have=Number((p.stockByLocation||{})[originLocationId])||0;
          if(have<need[sku]) throw new Error(`在庫不足: ${p.name||sku}（${locationName(originLocationId)} ${have} / 出荷 ${need[sku]}）`);
        }
        tx.set(newRef, data);
        for(const sku of Object.keys(need)){
          tx.update(doc(db,"products",sku), stockPatch(originLocationId,-need[sku]));
          tx.set(doc(collection(db,"inventoryMovements")), movement(sku,-need[sku],"shipment",soNumber,originLocationId));
        }
      });
    }else{
      await setDoc(newRef, data);
    }
    newShipId = newRef.id;
    document.getElementById("shipModal").classList.remove("open");
  }catch(e){ alert(`登録失敗: ${e.message}`); return; } finally{ btn.disabled=false; }
  if(alreadyShipped){
    toast(`出荷 ${soNumber} を発送済として登録しました${hasStock?`（${locationName(originLocationId)||"在庫"}から引落）`:""}。${NO_NOTICE_MSG}`);
    return;
  }
  const head = `出荷 ${soNumber} を登録し、出荷を依頼しました（在庫は発送済にしたときに引き落とします）`;
  toast(`${head}。出荷指示を投稿しています...`);
  toast(`${head}。${await postShipNotice(newShipId)}`);
}

// 出荷の修正を保存する。
// 在庫は「発送済にしたときとの差分」だけ動かす。発送済にしたときにすでに引いてあるので、
// 全量を引き直すと二重に減る（3→5 に直したら引くのは 2台）。
// 下書き・依頼済はまだ在庫を引いていないので、数量を直しても在庫は動かさない（発送済にしたとき最新の数量で全量を引く）。
// 以前は下書きでも差分を動かしていたため、確定のときにもう一度全量を引いて二重に減っていた（2026-10-21 既存バグ2）。
// 判定は ship-flow.js の qtyDelta（stockDeducted が偽なら空）。
async function saveShipEdit(){
  const s0 = editingShip; if(!s0) return;
  const locked = shipIsLocked(s0);
  const office=document.getElementById("shipOffice").value.trim();
  if(!office){ alert("事業所名を入力してください"); return; }

  // 送付先はどの状態でも直せる（金額が変わらないため）
  const patch = {
    postal:document.getElementById("shipPostal").value.trim(),
    company:document.getElementById("shipCompany").value.trim(),
    officeName:office,
    address:document.getElementById("shipAddress").value.trim(),
    contactName:document.getElementById("shipContact").value.trim(),
    phone:document.getElementById("shipPhone").value.trim(),
    email:document.getElementById("shipEmail").value.trim(),
    updatedAt:serverTimestamp(),
    updatedBy:currentUser.displayName||currentUser.email,
  };

  let items=null, delta={};
  if(!locked){
    if(subsidyPlanMissing()){ alert("伴走支援費を含める場合はプランを選んでください"); return; }
    patch.shipDate = document.getElementById("shipDate").value||today(); // 出荷日は請求書に印字されるのでロック外のときだけ
    items=resolveShipItems();
    if(!items.length){ alert("数量を入力してください"); return; }
    delta=qtyDelta(s0, qtyBySku(s0.items), qtyBySku(items));

    // 増やすぶんだけ在庫が要る（在庫を引いていない出荷＝下書き・依頼済・直送はそもそも動かさない）。
    // ここは画面上の早めの確認。最終判定は下のトランザクション内で最新在庫を読んで行う
    {
      for(const sku of Object.keys(delta)){
        if(delta[sku]<=0) continue;
        const p=products.find(x=>x.id===sku)||{};
        if((p.stock||0)<delta[sku]){
          const w=document.getElementById("shipStockWarn");
          w.style.display="block";
          w.textContent=`在庫不足: ${p.name||sku}（在庫 ${p.stock||0} / 追加で必要 ${delta[sku]}）`;
          return;
        }
      }
    }
    Object.assign(patch,{
      items,
      shippingMethod:document.getElementById("shipMethod").value||"manual",
      shippingFee:Number(document.getElementById("shipFee").value)||0,
      shippingLabel:document.getElementById("shipFeeLabel").value.trim()
        ||((Number(document.getElementById("shipFee").value)||0)>0?"送料":""),
      ...subsidyPatch(),
    });
  }

  const btn=document.getElementById("saveShipBtn"); btn.disabled=true;
  try{
    // 出荷・在庫・履歴を1つのトランザクションで書く。
    // 差分は「開いた時点の items」ではなく、いま Firestore にある items から計算し直す
    // （別タブで先に直されていたら二重に在庫を動かしてしまうため）。
    const shipRef=doc(db,"shipments",s0._id);
    let moved=0;
    await runTransaction(db, async (tx)=>{
      const snap=await tx.get(shipRef);
      if(!snap.exists()) throw new Error("この出荷は削除されています。画面を更新してください");
      const cur=snap.data();
      const a=cur.updatedAt?.toMillis?.()||0, b=s0.updatedAt?.toMillis?.()||0;
      if(a!==b) throw new Error("他の人が先にこの出荷を変更しています。画面を更新してから直してください");
      delta={}; moved=0; // トランザクションは再試行されることがあるので、毎回ここで初期化
      if(items){
        // いまの状態（cur）で判定する。開いている間に発送済になっていたら、そこからの差分を動かす
        delta=qtyDelta(cur, qtyBySku(cur.items), qtyBySku(items));
        {
          // 読み取りは書き込みより前にまとめて済ませる（Firestore トランザクションの決まり）
          for(const sku of Object.keys(delta)){
            if(delta[sku]<=0) continue;
            const p=(await tx.get(doc(db,"products",sku))).data()||{};
            const have=Number((p.stockByLocation||{})[shipLocationOf(cur)])||0;
            if(have<delta[sku]) throw new Error(`在庫不足: ${p.name||sku}（${locationName(shipLocationOf(cur))} ${have} / 追加で必要 ${delta[sku]}）`);
          }
        }
      }
      tx.update(shipRef, patch);
      // 在庫の差分を反映（増やしたら引く／減らしたら戻す）。何が動いたか履歴にも残す
      if(items){
        for(const sku of Object.keys(delta)){
          const d=delta[sku]; if(!d) continue;
          tx.update(doc(db,"products",sku), stockPatch(shipLocationOf(cur), -d));
          tx.set(doc(collection(db,"inventoryMovements")), movement(sku, -d, "shipment_edit", s0.soNumber, shipLocationOf(cur)));
          moved++;
        }
      }
    });
    document.getElementById("shipModal").classList.remove("open");
    editingShip=null;
    toast(locked
      ? `出荷 ${s0.soNumber} の送付先を直しました`
      : `出荷 ${s0.soNumber} を修正しました${moved?"（在庫も差分を調整）":""}`);
  }catch(e){ alert(`修正の保存に失敗しました: ${e.message}`); btn.disabled=false; return; }
  btn.disabled=false;
  // 依頼済の出荷の数量・送付先を直したら、センターが古い内容で動かないよう出荷指示の再送を聞く
  if(needsResendPrompt(s0, { ...s0, ...patch })){
    const q = s0.shipNotifiedAt
      ? `出荷 ${s0.soNumber} の出荷指示は ${fmtDT(s0.shipNotifiedAt)} に投稿済みです（直す前の内容）。\n直した内容で出荷指示を再送しますか？`
      : `出荷 ${s0.soNumber} の出荷指示はまだ投稿されていません。\n直した内容で出荷指示を投稿しますか？`;
    if(confirm(q)){
      toast("出荷指示を投稿しています...");
      toast(await postShipNotice(s0._id, { resend: true }));
    }
  }
}

// 案件（事業所の申し込み）→ 直接出荷フォームに取り込み
async function prefillShipFromCase(caseId){
  try{
    const cs=await getDoc(doc(db,"cases",caseId)); if(!cs.exists()){ alert("案件が見つかりません"); return; }
    const c=cs.data();
    const tab=document.querySelector('.tab[data-tab="shipments"]'); if(tab) tab.click();
    // Web申込などで既にこの案件の出荷下書き・依頼済の出荷があれば、それを開く（二重作成の防止・計画書 §4.4）。
    // 依頼済（requested）も「まだ発送していない生きた出荷」なので同じ扱い（2026-10-21）
    const drafts=await getDocs(query(collection(db,"shipments"),where("caseId","==",caseId),where("status","in",["draft","requested"])));
    if(!drafts.empty){
      const d=drafts.docs.find(x=>x.data().status==="draft") || drafts.docs[0];
      openShip({_id:d.id,...d.data()});
      toast(d.data().status==="requested"
        ? `この案件の出荷 ${d.data().soNumber||""} はすでに依頼済みです（新しく作らず、こちらを確認してください）`
        : `この案件の出荷下書き ${d.data().soNumber||""} を開きました（新しく作らず、こちらを確認して出荷を依頼してください）`);
      return;
    }
    let office={};
    if(c.officeId){ try{ const os=await getDoc(doc(db,"offices",c.officeId)); if(os.exists()) office=os.data(); }catch(_){} }
    openShip();
    document.getElementById("shipType").value="direct";
    document.getElementById("shipPartnerWrap").style.display="none";
    document.getElementById("shipCompany").value = c.corpName||office.corpName||"";
    document.getElementById("shipOffice").value  = c.officeName||office.officeName||"";
    document.getElementById("shipPostal").value  = office.zip||office.postal||"";
    document.getElementById("shipAddress").value = c.address||office.address||"";
    document.getElementById("shipContact").value = c.contactName||"";
    document.getElementById("shipPhone").value   = c.contactPhone||office.phone||"";
    document.getElementById("shipEmail").value   = c.contactEmail||office.email||"";
    prefillCaseId = caseId;   // 保存時に出荷へ持たせる
    (c.cardReaders||[]).forEach(r=>{
      const qty=(Number(r.subsidyQty)||0)+(Number(r.extraQty)||0);
      const sku = r.type==="BT" ? "cir415a-01" : r.type==="USB" ? "cir315a-02" : null;
      if(sku && qty>0){ const inp=document.querySelector(`#shipItems .qty-input[data-sku="${sku}"]`); if(inp) inp.value=qty; }
    });
    // 案件に助成区分が入っていれば「伴走支援費を含める」を最初からオンにする（2026-09-22）。
    // TAKE4 の3件（SH-2026-0029〜0031）が、チェックを入れ忘れてカードリーダー代だけの請求書になったため。
    // 区分は案件の subsidyCategory、補助対象台数は上で入れた数量から自動（refreshSubsidyAutoDefaults）。
    const EP=window.EstimatePricing;
    if(EP && c.subsidyCategory && EP.PLANS[c.subsidyCategory]
       && document.getElementById("shipSubsidyWrap").style.display!=="none"){
      document.getElementById("shipSubsidyOn").checked=true;
      document.getElementById("shipSubsidyBody").style.display="";
      document.getElementById("shipSubsidyPlan").value=c.subsidyCategory;
      refreshSubsidyAutoDefaults();
    }
    updateShipTotal();
    toast("案件情報を取り込みました。数量・住所・USB品番と、伴走支援費の内訳をご確認ください");
  }catch(e){ alert(`取り込み失敗: ${e.message}`); }
}

// 自社の倉庫を通る出荷か（発送元の欄・「自社在庫から発送」のバッジ用）。ship-flow.js の usesWarehouse。
//   fulfillment:"direct"    … 直送発注から自動生成。在庫を通らない
//   fulfillment:"warehouse" … 出荷モーダルから登録。自社在庫から出す
//   未設定（古いデータ・Web申込の下書き）… 自社在庫から出す（従来どおり）
// ⚠️ 在庫を「戻す・差分を動かす」かどうかはこれではなく stockDeducted で決める（下書き・依頼済はまだ引いていない）。
//   以前は削除・数量修正でもこれを使っていたため、Web申込の下書きを消すと引いていない在庫が戻っていた（2026-10-21 既存バグ1・2）
function shipUsedStock(s){ return usesWarehouse(s); }

// 削除できるのは下書きだけ（ship-flow.js の canDelete）。下書きはまだ在庫を引いていないので在庫は戻さない。
// 状態はトランザクションの中で確かめ直す（開いている間に別の人が依頼・発送済にしていたら消さない）
async function deleteShipment(s){
  if(!canDelete(s)){
    alert(shipStatusOf(s)==="requested"
      ? `出荷 ${s.soNumber} は出荷を依頼済みのため削除できません。先に「依頼を取り消す」で下書きへ戻してください。`
      : `出荷 ${s.soNumber} は${SHIP_STATUS[shipStatusOf(s)]||""}のため削除できません。取り消すときは「キャンセルにする」を使ってください。`);
    return false;
  }
  const restores = stockDeducted(s); // 下書きは常に false（念のため判定は正本に任せる）
  const msg = `出荷 ${s.soNumber}（${s.officeName}）を削除します。\n`
    + (restores ? `引き落とした在庫は元に戻します。` : `下書きのため在庫は引き落としていません（在庫は動きません）。`)
    + `よろしいですか？`;
  if(!confirm(msg)) return false;
  try{
    const ref=doc(db,"shipments",s._id);
    await runTransaction(db, async (tx)=>{
      const snap=await tx.get(ref);
      if(!snap.exists()) throw new Error("この出荷はすでに削除されています");
      const cur=snap.data();
      if(!canDelete(cur)) throw new Error(`この出荷は「${SHIP_STATUS[shipStatusOf(cur)]||cur.status}」になっています。画面を更新してください`);
      if(stockDeducted(cur)){
        const backTo = shipLocationOf(cur);
        for(const it of stockItems(cur.items)){
          tx.update(doc(db,"products",it.sku), stockPatch(backTo, it.qty));
          tx.set(doc(collection(db,"inventoryMovements")), movement(it.sku, it.qty, "shipment_canceled", s.soNumber, backTo));
        }
      }
      tx.delete(ref);
    });
    toast(restores ? `出荷 ${s.soNumber} を削除し、在庫を戻しました` : `出荷 ${s.soNumber} を削除しました（在庫は動かしていません）`);
    return true;
  }catch(e){ alert(`削除失敗: ${e.message}`); return false; }
}

// 表示名・バッジは ship-flow.js（依頼済 requested を含む）。このファイルでは従来の名前で参照する
const SHIP_STATUS = SHIP_STATUS_LABEL;

// ===== 出荷のキャンセル（2026-09-14 追加）=====
// 「この出荷を削除」は下書きだけに絞ったので、発送済・請求済を取り消すときはこちらを使う。
// 削除と違って記録（理由・元の状態）を残したまま status:"canceled" にする。
// 在庫を戻す作法は deleteShipment に合わせ、stockPatch/movement 経由・逐次 updateDoc で行う。
const CANCEL_REASONS = ["事業所の都合","重複登録","誤登録","その他"];
let cancelTargetShip = null;
// 在庫を戻すのは、すでに引き落としてある出荷（発送済・請求済・入金済かつ自社在庫から）だけ。
// 依頼済はまだ引いていないので戻さない（戻すと水増しになる・2026-10-21）
function cancelShipUsesStock(s){ return stockDeducted(s); }
// opts: { reason, note } … 重複の解消（「こちらを残す」）から開くときに理由「重複登録」を選んだ状態にする
function openCancelShipModal(s, opts){
  opts = opts || {};
  if(!canCancel(s)){
    alert(netPaidOf(s)>0 ? `出荷 ${s.soNumber}：${CANCEL_BLOCKED_BY_PAYMENT}` : `出荷 ${s.soNumber} は${SHIP_STATUS[shipStatusOf(s)]||""}のためキャンセルにできません`);
    return; }
  cancelTargetShip = s;
  document.getElementById("cancelShipInfo").innerHTML =
    `<strong>${esc(s.soNumber)}</strong>（${esc(s.officeName||s.partnerName||"")}）／現在の状態: ${esc(SHIP_STATUS[s.status]||s.status)}`;
  let stockMsg;
  if(s.status==="draft"){
    stockMsg = "下書きのため在庫は動きません。";
  } else if(s.status==="requested"){
    stockMsg = "まだ発送済にしていないため、在庫は引き落としていません（戻しません）。<br>"
      + "<strong>出荷指示はすでに投稿済みです。</strong>センターへ取り消しの連絡をしてください（自動では取り消しません）。";
  } else if(!shipUsedStock(s)){
    stockMsg = "直送のため在庫は動きません。";
  } else {
    const lines = stockItems(s.items).map(it=>`${it.sku} × ${it.qty}`).join("・");
    stockMsg = `${esc(locationName(shipLocationOf(s))||"自社在庫")} に ${esc(lines||"（在庫品なし）")} を戻します。`;
  }
  if(s.status==="invoiced"){
    stockMsg += "<br>請求書を送っている場合は、先方への取り消し連絡は別途行ってください。";
  }
  document.getElementById("cancelShipStockNote").innerHTML = stockMsg;
  const reasonSel = document.getElementById("cancelReason");
  reasonSel.innerHTML = CANCEL_REASONS.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join("");
  if(opts.reason && CANCEL_REASONS.includes(opts.reason)) reasonSel.value = opts.reason;
  document.getElementById("cancelNote").value = opts.note || "";
  document.getElementById("cancelShipError").style.display = "none";
  document.getElementById("cancelShipModal").classList.add("open");
}
function closeCancelShipModal(){
  document.getElementById("cancelShipModal").classList.remove("open");
  cancelTargetShip = null;
  dupCancelCtx = null; // 閉じたら重複の解消の続きもやめる（1件ずつ人が確かめる）
}
// ===== 下書きの重複の解消（2026-10-21 設計 §6）=====
// 「こちらを残す」= 同じ案件のほかの下書き・依頼済を、既存のキャンセルの画面で理由「重複登録」にして1件ずつキャンセルする。
// 🔴 削除はしない（記録を残す）。複数あれば、1件キャンセルするたびに次の1件の画面を開く。
let dupCancelCtx = null; // { keepSo, queue: 出荷[] }
function keepDuplicate(keepId){
  const view = lastDupView;
  const keep = shipments.find(x=>x._id===keepId);
  if(!keep || !view) return;
  const others = othersToCancel(view, keepId);
  if(!others.length){ toast("キャンセルにする重複の相手がありません"); return; }
  const first = others[0];
  const keepSo = keep.soNumber||"";
  openCancelShipModal(first, { reason:"重複登録", note:`重複（${keepSo} を残す）` });
  dupCancelCtx = { keepSo, queue: others.slice(1) };
}
function openNextDupCancel(ctx){
  if(!ctx || !ctx.queue.length) return;
  // 最新の状態で開き直す（そのあいだに発送済・キャンセル済になったものは飛ばす）
  const queue = ctx.queue.map(q=>shipments.find(x=>x._id===q._id)||q).filter(q=>canCancel(q) && ["draft","requested"].includes(shipStatusOf(q)));
  if(!queue.length) return;
  openCancelShipModal(queue[0], { reason:"重複登録", note:`重複（${ctx.keepSo} を残す）` });
  dupCancelCtx = { keepSo: ctx.keepSo, queue: queue.slice(1) };
}
async function doCancelShipment(){
  const s = cancelTargetShip; if(!s) return;
  const err = document.getElementById("cancelShipError"); err.style.display = "none";
  const reason = document.getElementById("cancelReason").value;
  const note = document.getElementById("cancelNote").value.trim();
  let usesStock = cancelShipUsesStock(s);
  const btn = document.getElementById("doCancelShipBtn"); btn.disabled = true;
  try{
    // 状態の確かめ・キャンセル・在庫の戻しを1つのトランザクションで行う
    // （開いている間に別の人が発送済にしていた／先にキャンセルしていた、で在庫を戻し損ねる・二重に戻すのを防ぐ）
    const ref = doc(db,"shipments",s._id);
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(ref);
      if(!snap.exists()) throw new Error("この出荷は削除されています。画面を更新してください");
      const cur = snap.data();
      if(shipStatusOf(cur)!==shipStatusOf(s) || !nextStatus(shipStatusOf(cur),"cancel"))
        throw new Error(`この出荷は「${SHIP_STATUS[shipStatusOf(cur)]||cur.status}」になっています。画面を更新してください`);
      // 開いている間に入金が記録された場合も止める（返金していない入金を残したままキャンセルにしない・Codex 指摘2）
      if(netPaidOf(cur)>0) throw new Error(CANCEL_BLOCKED_BY_PAYMENT);
      usesStock = cancelShipUsesStock(cur);
      tx.update(ref, {
        status: "canceled", statusBeforeCancel: shipStatusOf(cur),
        canceledAt: serverTimestamp(), canceledBy: currentUser.displayName||currentUser.email,
        cancelReason: reason, cancelNote: note, updatedAt: serverTimestamp(),
      });
      if(usesStock){
        const backTo = shipLocationOf(cur);
        for(const it of stockItems(cur.items)){
          tx.update(doc(db,"products",it.sku), stockPatch(backTo, it.qty));
          tx.set(doc(collection(db,"inventoryMovements")), movement(it.sku, it.qty, "shipment_canceled", s.soNumber, backTo));
        }
      }
    });
    const dupNext = dupCancelCtx; // 閉じると消えるので先に控える
    closeCancelShipModal();
    toast(`${s.soNumber} をキャンセルにしました（${usesStock?"在庫を戻しました":"在庫は動いていません"}）${dupNext&&dupNext.queue.length?`。続けて重複の残り ${dupNext.queue.length}件を確かめます`:""}`);
    openNextDupCancel(dupNext);
  }catch(e){ err.textContent = `キャンセルに失敗: ${e.message}`; err.style.display = "block"; }
  finally{ btn.disabled = false; }
}
// 出荷の金額。**計算は invoice-doc.js の invoiceTotals に一本化した**（2026-09-13）。
// 事業所向けは明細が税込・認定事業者向けは税抜と基準が違うので、ここで自前に計算しない。
function shipFeeExcl(s){ return Number(s.shippingFee)||0; }   // 送料は常に税抜で保存（2026-07-28 統一）
function shipGoodsExcl(s){ return invoiceTotals(s).goodsExcl; }
function shipSubExcl(s){ return invoiceTotals(s).sub; }
function shipTotalIncl(s){ return invoiceTotals(s).total; }

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
// 請求先の同一判定キー（直送＝認定事業者のメール／直接＝事業所名）
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
// 支払期限（請求書の記載と同じ）。
//   ① shipments.dueDate があればそれを最優先（請求済にしたときに確定値を保存する）
//   ② dueRule:'net14'（2026-10-19 以降に「発送済にする」を押した出荷）＝ 請求書の発行日＋14日（納品日＝発行日）
//   ③ それ以外（従来の出荷）＝ 請求月の翌月末。すでに発送済み・請求済みの出荷の期限は変えない
//   請求書の文言は invoice-doc.js の paymentDueText と同じ規則にすること
function addDaysYmd(ymd, n){
  const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd||""));
  if(!m) return "";
  return new Date(Date.UTC(Number(m[1]), Number(m[2])-1, Number(m[3])+n)).toISOString().slice(0,10);
}
// ISO文字列（UTC）を日本時間の「YYYY-MM-DD HH:MM」にする（追跡写真の登録時刻の表示用）
function jstDateTime(iso){
  const d=new Date(iso||"");
  if(Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("sv-SE",{timeZone:"Asia/Tokyo"}).slice(0,16);
}
function dueDateOf(s){
  if(s.dueDate) return s.dueDate;
  const base=s.invoicedAt||s.shipDate||"";
  if(s.dueRule==="net14") return addDaysYmd(base, 14);
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
// バッジ表示用。認定事業者に請求する出荷かどうか。
// 古い出荷には今の選択肢に無い shipType:"stock" が入っていて、それも請求先は認定事業者なので
// partnerEmail の有無まで見る。※ 請求先名そのもの（billToOf）の解釈は従来のまま変えない。
function billsPartner(s){ return s.shipType==="dropship" || !!s.partnerEmail; }
function billToOf(s){ return s.shipType==="dropship" ? (s.partnerName||s.partnerEmail||"") : (s.company||s.officeName||""); }
function billToEmailOf(s){
  if(s.shipType==="dropship") return s.partnerEmail||"";
  return s.email||s.contactEmail||"";
}

// 深いリンクの契約: supply.html?tab=shipments&so=SH-2026-0013 で開いたとき、
// 出荷一覧の該当行（soNumber一致）へスクロールし、一時的に強調する。見つからなければ何もしない（エラーを出さない）。
// パラメータ名は "so"・値は soNumber で固定（案件詳細タブなど他画面が依存するため変えないこと）。
function scrollToShipmentFromUrl(){
  const so = new URLSearchParams(location.search).get("so");
  if(!so) return;
  let row;
  try{ row = document.querySelector(`#shipBody tr[data-so="${CSS.escape(so)}"]`); }catch(_){ row = null; }
  if(!row) return;
  row.scrollIntoView({behavior:"smooth", block:"center"});
  // 既存のCSS変数（薄い警告色）でひと目でわかるよう3秒ほど背景を付ける
  row.style.transition = "background-color .3s";
  row.style.backgroundColor = "var(--color-warning-soft)";
  setTimeout(()=>{ row.style.backgroundColor = ""; }, 3000);
}
// 出荷指示の投稿状況（2026-10-19 #4）。出すかどうかは ship-flow.js の shipNotifyShown（依頼済は必ず出す。
// 発送済以降は新ルール以降の出荷か、投稿を試みた出荷だけ。それより前の出荷は仕組みが無かったので「未投稿」と出さない）
function shipNotifyHtml(s){
  if(!shipNotifyShown(s)) return "";
  if(s.shipNotifiedAt) return `<div style="font-size:12px;color:var(--color-ink-muted)">出荷指示：投稿済 ${esc(fmtDT(s.shipNotifiedAt))}</div>`;
  if(s.shipNotifyStatus==="skipped") return `<div style="font-size:12px;color:var(--color-ink-muted)">出荷指示：送らない（記録のみ${s.shipNotifySkippedBy?`・${esc(s.shipNotifySkippedBy)}`:""}）</div>`;
  const why = ({ unset:"投稿先が未設定", disabled:"投稿先が停止中", error:"投稿に失敗" })[s.shipNotifyStatus] || "";
  return `<div style="font-size:12px;color:var(--color-danger);font-weight:600">出荷指示：未投稿${why?`（${esc(why)}）`:""}</div>`;
}
// 追跡番号・写真の要約（入っている分だけ出す）
function trackingHtml(s){
  const n = Array.isArray(s.trackingPhotos) ? s.trackingPhotos.length : 0;
  const parts = [];
  if(s.trackingNumber) parts.push(`追跡番号 ${esc(s.trackingNumber)}`);
  if(n) parts.push(`写真 ${n}枚`);
  if(s.letterPackType) parts.push(esc(LETTERPACK_TYPE_LABEL[s.letterPackType]||""));
  return parts.length ? `<div style="font-size:12px;color:var(--color-ink-muted)">${parts.join("・")}</div>` : "";
}

// ===== 追跡番号の写真（2026-10-19 #5） =====
// Storage: shipments/{shipmentId}/tracking/{file}（storage.rules で @tadakayo.jp の職員だけ読み書き）
// shipments.trackingPhotos = [{path, uploadedAt(ISO文字列), uploadedBy}] ／ 任意の shipments.trackingNumber（手入力）
let trackShipId = null;
function trackShipOf(id){ return shipments.find(x=>x._id===id) || null; }
function openTrackModal(s){
  trackShipId = s._id;
  document.getElementById("trackTitle").textContent = `追跡番号の写真（${s.soNumber||""}）`;
  document.getElementById("trackNumber").value = s.trackingNumber || "";
  document.getElementById("trackFiles").value = "";
  document.getElementById("trackError").style.display = "none";
  document.getElementById("trackStatus").textContent = "";
  renderTrackPhotos();
  document.getElementById("trackModal").classList.add("open");
}
function closeTrackModal(){ document.getElementById("trackModal").classList.remove("open"); trackShipId = null; }
async function renderTrackPhotos(){
  const box = document.getElementById("trackPhotos");
  const s = trackShipOf(trackShipId);
  const list = (s && Array.isArray(s.trackingPhotos)) ? s.trackingPhotos : [];
  if(!list.length){ box.innerHTML = `<div style="font-size:12px;color:var(--color-ink-muted)">まだ写真はありません。</div>`; return; }
  const forId = trackShipId;
  box.innerHTML = list.map((p,i)=>`<figure style="margin:0;width:120px">
      <a data-i="${i}" class="track-open" target="_blank" rel="noopener" style="display:block;width:120px;height:120px;border:1px solid var(--color-line);border-radius:8px;overflow:hidden;background:#f3f1ec">
        <img data-i="${i}" alt="追跡番号の写真 ${i+1}" style="width:100%;height:100%;object-fit:cover"></a>
      <figcaption style="font-size:11px;color:var(--color-ink-muted);line-height:1.4;margin-top:2px">${esc(jstDateTime(p.uploadedAt))}<br>${esc(p.uploadedBy||"")}</figcaption>
      <button class="btn btn-secondary track-del" data-i="${i}" type="button" style="font-size:11px;padding:2px 8px;margin-top:2px"><i class="ti ti-trash" aria-hidden="true"></i>この写真を削除</button>
    </figure>`).join("");
  list.forEach(async (p,i)=>{
    try{
      const url = await getDownloadURL(storageRef(storage, p.path));
      if(trackShipId!==forId) return;
      const img = box.querySelector(`img[data-i="${i}"]`); if(img) img.src = url;
      const a = box.querySelector(`a.track-open[data-i="${i}"]`); if(a) a.href = url;
    }catch(e){ console.warn("tracking photo:", e.message); }
  });
  box.querySelectorAll(".track-del").forEach(b=>b.addEventListener("click",()=>deleteTrackPhoto(list[Number(b.dataset.i)])));
}
async function uploadTrackPhotos(){
  const s = trackShipOf(trackShipId); if(!s) return;
  const files = Array.from(document.getElementById("trackFiles").files || []);
  const err = document.getElementById("trackError"); err.style.display = "none";
  if(!files.length) return;
  const bad = files.find(f=>!/^image\//.test(f.type||"") || f.size >= 20*1024*1024);
  if(bad){ err.textContent = `画像（20MB未満）だけ追加できます: ${bad.name}`; err.style.display = "block"; return; }
  const status = document.getElementById("trackStatus");
  const who = currentUser.displayName||currentUser.email;
  let done = 0;
  try{
    for(const f of files){
      status.textContent = `アップロード中… ${done+1} / ${files.length}`;
      const ext = (String(f.name||"").match(/\.([A-Za-z0-9]{1,5})$/)||[])[1] || (f.type.split("/")[1]||"jpg");
      const path = `shipments/${s._id}/tracking/${Date.now()}_${done}.${ext.toLowerCase()}`;
      await uploadBytes(storageRef(storage, path), f, { contentType: f.type });
      await updateDoc(doc(db,"shipments",s._id), {
        trackingPhotos: arrayUnion({ path, uploadedAt: new Date().toISOString(), uploadedBy: who }),
        updatedAt: serverTimestamp() });
      done++;
    }
    status.textContent = `${done}枚を追加しました`;
  }catch(e){
    err.textContent = `追加に失敗しました（${done}枚まで保存済み）: ${e.message}`; err.style.display = "block"; status.textContent = "";
  }
  document.getElementById("trackFiles").value = "";
  // onSnapshot で shipments が更新されるのを少し待ってから描き直す
  setTimeout(renderTrackPhotos, 600);
}
async function deleteTrackPhoto(p){
  const s = trackShipOf(trackShipId); if(!s || !p) return;
  if(!confirm("この写真を削除します。元に戻せません。よろしいですか？")) return;
  const err = document.getElementById("trackError"); err.style.display = "none";
  try{
    await updateDoc(doc(db,"shipments",s._id), { trackingPhotos: arrayRemove(p), updatedAt: serverTimestamp() });
    try{ await deleteObject(storageRef(storage, p.path)); }catch(e){ console.warn("delete tracking photo object:", e.message); }
  }catch(e){ err.textContent = `削除に失敗しました: ${e.message}`; err.style.display = "block"; return; }
  setTimeout(renderTrackPhotos, 600);
}
async function saveTrackNumber(){
  const s = trackShipOf(trackShipId); if(!s) return;
  const v = document.getElementById("trackNumber").value.trim();
  const err = document.getElementById("trackError"); err.style.display = "none";
  try{
    await updateDoc(doc(db,"shipments",s._id), { trackingNumber: v, updatedAt: serverTimestamp() });
    document.getElementById("trackStatus").textContent = v ? "追跡番号を保存しました" : "追跡番号を消しました";
  }catch(e){ err.textContent = `保存に失敗しました: ${e.message}`; err.style.display = "block"; }
}

// ===== 出荷の一覧の担当絞り込み・並び替え（2026-10-20） =====
// 出荷そのものは担当を持たないので、元の案件（caseId）の担当営業で見る。
// 受注タブの入金状況は全件の shipments を使うので、ここでは表示用に絞った配列だけを作る。
let caseOwners = {};   // caseId → assignedUserId
let casesForOwners = []; // 担当の選択肢を作るための案件（担当の id と氏名だけ使う）
let ownersState = "loading"; // 担当情報（案件）の読み込み状態: loading / ok / error
let caseShipmentIds = {}; // caseId → cases.shipmentId（下書きの重複で「残す候補」にする・2026-10-21）
let dupOnly = false;      // サマリーの「⚠ 下書きの重複」を押したら重複している行だけに絞る
let lastDupView = null;   // 最後に描いた重複の情報（「こちらを残す」で使う）
const SHIP_SORTS = {
  createdDesc: null, // Firestore の並び（createdAt の新しい順）のまま
  shipDateDesc: (a,b)=>String(b.shipDate||"").localeCompare(String(a.shipDate||"")),
  shipDateAsc: (a,b)=>String(a.shipDate||"").localeCompare(String(b.shipDate||"")),
  // 期限の無いもの（未請求など）は後ろへ
  dueAsc: (a,b)=>String(dueDateOf(a)||"9999").localeCompare(String(dueDateOf(b)||"9999")),
  // キャンセル・下書き・未請求は未集金ではない（上の未集金の集計と同じ isUnpaid で判定）
  remainDesc: (a,b)=>(isUnpaid(b)?payRemain(b):0)-(isUnpaid(a)?payRemain(a):0),
  billTo: (a,b)=>String(billToOf(a)).localeCompare(String(billToOf(b)),"ja"),
};
function renderShipmentsView(){
  const asg=document.getElementById("shipAssigneeFilter")?.value||"";
  const cmp=SHIP_SORTS[document.getElementById("shipSortSelect")?.value||""];
  // 担当で絞っているのに担当が判定できないときは、0件と誤って見せずにその旨を出す
  if(asg && ownersState!=="ok"){
    const msg = ownersState==="error"
      ? "担当の情報（案件）を取得できませんでした。「担当：全員」に切り替えるか、画面を開き直してください。"
      : "担当の情報を読み込んでいます…";
    document.getElementById("shipSummary").innerHTML=`<div class="alert-chip ${ownersState==="error"?"danger":"info"}"><i class="ti ti-${ownersState==="error"?"alert-triangle":"loader-2"}" aria-hidden="true"></i><div><div class="alert-label">${msg}</div></div></div>`;
    const ar=document.getElementById("arSummary"); if(ar) ar.innerHTML="";
    document.getElementById("shipBody").innerHTML="";
    document.getElementById("shipEmpty").style.display="none";
    return;
  }
  let list=shipments.filter(s=>matchAssignee(caseOwners[s.caseId], asg, currentUser?.email));
  // 下書きの重複は担当の絞り込みのあとで数える（同じ案件の出荷は同じ担当なので組が割れない）
  const dv = dupView(findDuplicateDrafts(list, caseShipmentIds));
  lastDupView = dv;
  if(dupOnly && !dv.count) dupOnly = false; // 解消し終えたら絞り込みを外す
  list = filterDupOnly(list, dv, dupOnly);
  if(cmp) list=[...list].sort(cmp);
  renderShipments(list, dv);
}

function renderShipments(ships, dv){
  dv = dv || dupView([]);
  const body=document.getElementById("shipBody"); const empty=document.getElementById("shipEmpty");
  empty.style.display = ships.length?"none":"block";
  // サマリー（未請求 / 請求済・未入金 / 入金済）
  const active = ships.filter(s=>s.status!=="canceled");
  const drafts = active.filter(s=>s.status==="draft");
  const requested = active.filter(s=>s.status==="requested");
  const unbilled = active.filter(s=>s.status==="shipped");
  const billed = active.filter(s=>s.status==="invoiced");
  const paid = active.filter(s=>s.status==="paid");
  const unpaid = active.filter(isUnpaid);
  const overdue = unpaid.filter(s=>overdueDays(s)>0);
  const sumBox=document.getElementById("shipSummary");
  if(sumBox) sumBox.innerHTML = [
    // 下書きの重複（2026-10-21 §6）。押すと重複している行だけに絞る（もう一度押すと戻る）
    dv.count?`<button type="button" class="alert-chip warn dup-filter" aria-pressed="${dupOnly}" style="cursor:pointer;font:inherit;text-align:left${dupOnly?";outline:2px solid var(--color-warning)":""}" title="${dupOnly?"押すと全件の表示に戻ります":"押すと重複している出荷だけを表示します"}"><i class="ti ti-alert-triangle" aria-hidden="true"></i><div><div class="alert-num">${dv.count}件</div><div class="alert-label">⚠ 下書きの重複${dupOnly?"（絞り込み中・押すと戻る）":"（押すと絞り込み）"}</div></div></button>`:"",
    drafts.length?`<div class="alert-chip info"><i class="ti ti-file-pencil"></i><div><div class="alert-num">${drafts.length}</div><div class="alert-label">出荷の下書き（依頼が必要）</div></div></div>`:"",
    // 依頼済＝出荷指示を出してセンターの発送を待っているもの。発送されたら「発送済にする」を押す（2026-10-21）
    requested.length?`<div class="alert-chip warn"><i class="ti ti-truck-loading"></i><div><div class="alert-num">${requested.length}</div><div class="alert-label">出荷依頼中（センターの発送待ち）</div></div></div>`:"",
    `<div class="alert-chip warn"><i class="ti ti-package-export"></i><div><div class="alert-num">${unbilled.length}</div><div class="alert-label">未請求（発送済）</div></div></div>`,
    `<div class="alert-chip danger"><i class="ti ti-receipt"></i><div><div class="alert-num">${yen(unpaid.reduce((a,s)=>a+payRemain(s),0))}</div><div class="alert-label">未集金・残額（税込 ${unpaid.length}件）</div></div></div>`,
    overdue.length?`<div class="alert-chip danger"><i class="ti ti-alarm"></i><div><div class="alert-num">${yen(overdue.reduce((a,s)=>a+payRemain(s),0))}</div><div class="alert-label">うち支払期限超過（${overdue.length}件）</div></div></div>`:"",
    `<div class="alert-chip info"><i class="ti ti-cash"></i><div><div class="alert-num">${yen(active.reduce((a,s)=>a+netPaid(s),0))}</div><div class="alert-label">入金済・累計（税込・返金差引後）</div></div></div>`,
    active.some(s=>creditBalanceOf(s)>0)
      ? `<div class="alert-chip warn"><i class="ti ti-arrow-down-circle"></i><div><div class="alert-num">${yen(active.reduce((a,s)=>a+creditBalanceOf(s),0))}</div><div class="alert-label">過入金・未充当（次回請求に充当）</div></div></div>`:"",
  ].join("");
  renderReceivables(unpaid, active);

  body.innerHTML = ships.map(s=>{
    // 品番だけでは USB か Bluetooth か、端子が A か C か分からないので接続方式を併記する
    const summary=(s.items||[]).map(i=>{
      // 伴走支援費・金額調整は品番ではなく品名（i.name）で出す（"support-fee" では意味が伝わらない）
      if(i.nonStock) return `<div style="margin-bottom:2px"><strong>${esc(i.name||i.sku)}</strong> ${i.unitPrice<0?"−":""}${yen(Math.abs(i.unitPrice||0))}</div>`;
      const conn=itemConnection(i, products);
      return `<div style="margin-bottom:2px"><strong>${esc(i.sku)}</strong> × ${Number(i.qty)||0}`
        + (conn?`<div class="conn-tag">${esc(conn)}</div>`:"")+`</div>`;
    }).join("");
    // 「誰に請求するか」と「どこから発送したか」は別の軸。1つのバッジに混ぜると実態とずれる。
    //   請求先: shipType（ただし古い "stock" は partnerEmail の有無で判断する）
    //   発送元: fulfillment（自社在庫を通ったか＝在庫を戻すかどうかの根拠でもある）
    const typeBadge = (billsPartner(s)
        ? `<span class="badge badge-6">認定事業者へ請求</span>`
        : `<span class="badge badge-2">事業所へ請求</span>`)
      + (shipUsedStock(s)
        ? ` <span class="badge badge-2">自社在庫から発送</span>`
        : ` <span class="badge badge-7">AB Circleから直送</span>`);
    const st=s.status||"shipped";
    const stBadge=`<span class="badge badge-${SHIP_STATUS_BADGE[st]||7}">${SHIP_STATUS[st]||st}</span>`;
    // 下書きの重複（同じ案件に下書き・依頼済が2件以上）。残す候補＝案件に結びついている出荷（cases.shipmentId）
    const dup = dv.byShip.get(s._id);
    const dupBadge = dup
      ? ` <span class="badge badge-1" title="同じ案件に、まだ発送していない出荷が${dup.group.length}件あります">重複</span>`
        + (dup.keepId===s._id ? ` <span class="badge badge-3" title="案件に結びついている出荷です">おすすめ</span>` : "")
      : "";
    const keepBtn = dup && !viewerMode
      ? `<button class="btn btn-secondary keep-dup" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="同じ案件のほかの出荷を、理由「重複登録」で1件ずつキャンセルにします（削除はしません）"><i class="ti ti-circle-check"></i>こちらを残す${dup.keepId===s._id?"（おすすめ）":""}</button>`
      : "";
    // 在庫の目安（下書き・依頼済で自社在庫から出すものだけ。引き落としはしない）
    const adviceTxt = stockAdviceShown(s) ? stockAdvice(s.items, products, locations).text : "";
    const adviceHtml = adviceTxt ? `<div style="font-size:12px;color:var(--color-ink-muted);margin-top:4px">${esc(adviceTxt)}</div>` : "";
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
        // 請求先への帳票メール送付の記録（supply-print のメール送付が書く）
        + (s.invoiceMailedAt ? `<div style="font-size:12px;color:var(--color-ink-muted)">請求書をメール送付済み ${esc(String(s.invoiceMailedAt).slice(5))}</div>` : "")
        + (s.receiptMailedAt ? `<div style="font-size:12px;color:var(--color-ink-muted)">領収証をメール送付済み ${esc(String(s.receiptMailedAt).slice(5))}</div>` : "")
        // 経理への請求書発行報告（未報告なら気づけるように出す）
        + (s.accountingReportedAt
            ? `<div style="font-size:12px;color:var(--color-ink-muted)">経理へ報告済み ${esc(String(s.accountingReportedAt).slice(5))}</div>`
            : `<div style="font-size:12px;color:var(--color-warn,#c87a1f)">経理へ未報告</div>`);
    }
    let lifeBtns="";
    // 帳票リンク・修正／種別変更／削除は全状態で共通（表示条件は元のまま）。
    // 状態ごとに並び順だけ変えられるよう部品化する（2026-09-14 ボタン文言・並び順の整理）。
    const docInvoice = `<a class="btn btn-secondary" href="/supply-print.html?type=invoice&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-receipt"></i>請求書</a>`;
    const docReceipt = st==="paid" ? `<a class="btn btn-secondary" href="/supply-print.html?type=receipt&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-receipt-2"></i>領収証${s.receiptIssuedAt?`（発行済 ${esc(String(s.receiptIssuedAt).slice(5))}）`:""}</a>` : "";
    const docRefund = refundSum(s)>0 ? `<a class="btn btn-secondary" href="/supply-print.html?type=refund&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-back-up"></i>返金明細書${s.refundStatementIssuedAt?`（発行済 ${esc(String(s.refundStatementIssuedAt).slice(5))}）`:""}</a>` : "";
    const docShipnote = `<a class="btn btn-secondary" href="/supply-print.html?type=ship&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-text"></i>送付状</a>`;
    const docLetterpack = `<a class="btn btn-secondary" href="/supply-print.html?type=letterpack&id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-fast"></i>宛名</a>`
      // A4に印刷してレターパックに貼る宛名ページ（出荷指示の投稿にも載るURL・2026-10-19 #4b）
      + `<a class="btn btn-secondary" href="/letterpack-print.html?id=${s._id}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px"><i class="ti ti-printer"></i>宛名印刷（A4）</a>`;
    // 発送済以降: 追跡番号の写真・出荷指示の再送（2026-10-19 #4・#5）
    const shippedLike = st==="shipped"||st==="invoiced"||st==="paid";
    const trackBtn = shippedLike ? `<button class="btn btn-secondary track-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-camera"></i>追跡番号の写真${Array.isArray(s.trackingPhotos)&&s.trackingPhotos.length?`（${s.trackingPhotos.length}）`:""}</button>` : "";
    const notifyBtn = shipNotifyShown(s) ? `<button class="btn btn-secondary resend-notify" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-send"></i>${s.shipNotifiedAt?"出荷指示をもう一度投稿":"出荷指示を再送"}</button>` : "";
    const editBtn = `<button class="btn btn-secondary edit-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="${shipIsLocked(s)?"請求済のため送付先のみ修正できます":"数量・送付先・送料を修正"}"><i class="ti ti-edit"></i>送付先・数量を直す</button>`;
    const typeBtn = `<button class="btn btn-secondary type-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="出荷種別（請求先）を変更"><i class="ti ti-switch-horizontal"></i>請求先を変える</button>`;
    // 状態ごとに出してよい操作は ship-flow.js の shipActions が正本（削除は下書きだけ・キャンセルは入金済とキャンセル済以外）
    const acts = shipActions(s);
    const delBtn = acts.includes("delete") ? `<button class="btn btn-danger del-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="この出荷を削除"><i class="ti ti-trash"></i>この出荷を削除</button>` : "";
    const cancelBtn = acts.includes("cancel") ? `<button class="btn btn-secondary cancel-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="${st==="requested"?"記録を残したままキャンセルにします（在庫はまだ引いていないので戻しません）":"記録を残したまま在庫を戻してキャンセルにします"}"><i class="ti ti-ban"></i>キャンセルにする</button>` : "";
    if(st==="draft"){
      // 流れの順: 出荷を依頼する →（帳票を見る）→ 送付先・数量を直す → 請求先を変える → すでに発送済（記録のみ）→ キャンセルにする → この出荷を削除
      lifeBtns = `<button class="btn btn-primary request-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-send"></i>出荷を依頼する</button>`
        + keepBtn
        + docInvoice + docLetterpack + docShipnote + docRefund
        + editBtn + typeBtn
        // すでに届いている出荷（伴走支援が済んだ案件など）だけに使う小さなボタン。依頼を経ずに発送済へ・出荷指示は送らない
        + `<button class="btn btn-secondary record-shipped" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="すでに届いている出荷を、出荷指示を送らずに発送済として記録します（在庫は引き落とします）"><i class="ti ti-check"></i>すでに発送済（記録のみ）</button>`
        + cancelBtn + delBtn;
    } else if(st==="requested"){
      // 流れの順: 発送済にする → 出荷指示を再送 →（帳票）→ 送付先・数量を直す → 請求先を変える → 依頼を取り消す → キャンセルにする
      // 削除は出さない（出荷指示を投稿済みのため。取り消してから下書きで削除する）
      lifeBtns = `<button class="btn btn-primary mark-shipped" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="センターが発送したのを確認してから押してください（在庫を引き落とします）"><i class="ti ti-truck-delivery"></i>発送済にする</button>`
        + keepBtn
        + notifyBtn
        + docLetterpack + docShipnote + docInvoice + docRefund
        + editBtn + typeBtn
        + `<button class="btn btn-secondary revert-draft" data-id="${s._id}" style="font-size:12px;padding:4px 8px" title="依頼を取り消して下書きへ戻します（取り消しの連絡は人が行います）"><i class="ti ti-arrow-back-up"></i>依頼を取り消す</button>`
        + cancelBtn;
    } else if(st==="shipped"){
      // 流れの順: 請求書を確認 → 請求済にする → 送付先・数量を直す →（宛名・送付状）→ 請求先を変える → キャンセルにする
      // 発送済の「次の一手」は請求済にする＝赤（下書きの「出荷を依頼する」・請求済の「入金を記録する」と同じ扱い・2026-09-14）
      lifeBtns = `<button class="btn btn-primary mark-invoiced" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-invoice"></i>請求済にする</button>`
        + docInvoice
        + (s.shipNotifiedAt ? "" : notifyBtn) + trackBtn
        + editBtn + docLetterpack + docShipnote + docRefund + (s.shipNotifiedAt ? notifyBtn : "")
        // 請求前に入金を記録した出荷（銀行明細の取り込みなど）は、入金の履歴を開いて確かめ・取り消せる。状態は変えない（Codex 指摘1）
        + (acts.includes("payHistory") ? `<button class="btn btn-secondary mark-paid" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-list-details"></i>入金の履歴（${payList(s).length}件）</button>` : "")
        + typeBtn + cancelBtn;
    } else if(st==="invoiced"){
      // 流れの順: 入金を記録する →（過入金を充当）→ 請求書 → 経理へ報告する → 催促メールを送る →（返金明細）→ 宛名・送付状 → 送付先・数量を直す → 請求先を変える → キャンセルにする
      lifeBtns = `<button class="btn btn-primary mark-paid" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-cash"></i>入金を記録する</button>`
        // 同じ請求先の過入金は金額つきで、別請求先（グループ）の分しか無いときは「別請求先」と明示して出す
        + (creditBalanceForBillTo(s)>0
            ? `<button class="btn btn-secondary apply-credit" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-down-circle"></i>過入金を充当（${yen(Math.min(creditBalanceForBillTo(s),remain))}）</button>`
            : (crossCreditBalanceFor(s)>0
                ? `<button class="btn btn-secondary apply-credit" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-arrow-down-circle"></i>過入金を充当（別請求先 ${yen(Math.min(crossCreditBalanceFor(s),remain))}）</button>`
                : ""))
        + docInvoice
        // 報告が失敗した／後から報告するとき用（請求済のステータスは変えない）
        + (s.accountingReportedAt?"":`<button class="btn btn-secondary report-acct" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-file-invoice"></i>経理へ報告する</button>`)
        + (od>0?`<button class="btn btn-secondary dun-ship" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-mail-forward"></i>催促メールを送る${s.dunningSentAt?`（${esc(String(s.dunningSentAt).slice(5))}送信済）`:""}</button>`:"")
        + docRefund + docLetterpack + docShipnote + trackBtn + notifyBtn
        + editBtn + typeBtn + cancelBtn;
    } else if(st==="paid"){
      // 流れの順: 領収証 → 入金の履歴を見る →（返金明細）→ 請求書・宛名・送付状 → 送付先・数量を直す → 請求先を変える
      // 入金がある出荷はキャンセル不可（返金の手続きが先＝既存の返金フローに任せる）。削除も不可
      lifeBtns = docReceipt
        + `<button class="btn btn-secondary mark-paid" data-id="${s._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-list-details"></i>入金の履歴を見る</button>`
        + docRefund + docInvoice + docLetterpack + docShipnote + trackBtn + notifyBtn
        + editBtn + typeBtn;
    } else {
      // canceled: 記録として残すだけ。帳票リンク・修正系のボタンは出さず、理由を小さく表示する
      lifeBtns = `<div style="font-size:12px;color:var(--color-ink-muted)">理由: ${esc(s.cancelReason||"-")}${s.cancelNote?`・${esc(s.cancelNote)}`:""}</div>`;
    }
    // data-so: 深いリンク（?so=SH-2026-0013）で該当行を見つけてスクロールするための目印
    // canceled は行全体を薄くして「終わった記録」だと分かるようにする（既存の muted 変数・opacity のみ・新規色は使わない）
    return `<tr data-so="${esc(s.soNumber)}"${st==="canceled"?' style="opacity:.55"':""}>
      <td><strong>${esc(s.soNumber)}</strong><div style="margin-top:2px">${typeBadge} ${stBadge}${dupBadge}</div></td>
      <td>${esc(s.shipDate||"")}</td>
      <td>${esc(s.officeName)}${s.company?`<div style="font-size:12px;color:var(--color-ink-muted)">${esc(s.company)}</div>`:""}<div style="font-size:12px;color:var(--color-ink-muted)">請求先: ${esc(billName)}（${yen(shipTotalIncl(s))}）</div>${payInfo}${shipNotifyHtml(s)}${trackingHtml(s)}</td>
      <td style="font-size:12px">${summary}${adviceHtml}</td>
      <td>
        <!-- ボタンが増えて右にはみ出し、削除が画面外で押せなくなっていた（2026-09-01）。
             横スクロールに頼らず、収まらなければ折り返して必ず全部見えるようにする。 -->
        <div class="row-actions">
        ${lifeBtns}
        </div>
      </td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".del-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) deleteShipment(s);
  }));
  // 下書きの重複: サマリーで絞り込み・行の「こちらを残す」
  document.querySelectorAll("#shipSummary .dup-filter").forEach(b=>b.addEventListener("click",()=>{
    dupOnly = !dupOnly; renderShipmentsView();
  }));
  document.querySelectorAll(".keep-dup").forEach(b=>b.addEventListener("click",()=>keepDuplicate(b.dataset.id)));
  document.querySelectorAll(".cancel-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) openCancelShipModal(s);
  }));
  document.querySelectorAll(".edit-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id);
    if(!s) return;
    // 出荷タブを開いた状態でモーダルを出す（別タブから押されても迷子にならないように）
    const tab=document.querySelector('.tab[data-tab="shipments"]'); if(tab && !tab.classList.contains("active")) tab.click();
    openShip(s);
  }));
  document.querySelectorAll(".type-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) openShipTypeModal(s);
  }));
  document.querySelectorAll(".track-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) openTrackModal(s);
  }));
  document.querySelectorAll(".resend-notify").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) resendShipNotice(s);
  }));
  // 出荷の二段階化（2026-10-21）: 依頼する → 発送済にする ／ 記録のみ ／ 依頼を取り消す
  document.querySelectorAll(".request-ship").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) requestDraftShipment(s);
  }));
  document.querySelectorAll(".mark-shipped").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) markShipped(s);
  }));
  document.querySelectorAll(".record-shipped").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) recordShippedDirect(s);
  }));
  document.querySelectorAll(".revert-draft").forEach(b=>b.addEventListener("click",()=>{
    const s=ships.find(x=>x._id===b.dataset.id); if(s) revertToDraft(s);
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

// ===== 出荷種別（請求先）の変更 =====
// 種別を間違えたときに出荷を作り直さずに直せるようにする。
// 【在庫について】在庫の増減は shipType ではなく「どの経路で出荷を作ったか」で決まっている。
//   ・出荷モーダルから登録（saveShip）＝ 種別に関わらず自社在庫から引き落とし済み
//   ・直送発注から自動生成（createShipmentDraftFromPO / fulfillment:"direct"）＝ 在庫を経由しない
//   したがって種別を切り替えても在庫の実態は変わらない＝在庫は動かさない（画面にもその旨を明示する）。
// 変わるのは「請求先」と「単価の基準」だけなので、そこだけをプレビュー付きで変更する。
const SHIP_TYPE_LABEL = { direct:"事業所へ（タダカヨの在庫から発送・その事業所に請求）", dropship:"認定事業者へ（AB Circleから直送・認定事業者に請求）" };
let typeChangingShip = null;
// 変更後の種別に合わせて単価を入れ直した明細を返す（reprice=false なら今の単価のまま）
function repricedShipItems(s, newType, reprice){
  return (s.items||[]).map(it=>{
    if(!reprice) return {...it};
    const p=products.find(x=>x.id===it.sku);
    if(!p) return {...it}; // 商品マスタから消えている場合は今の単価を保つ
    const qty=Number(it.qty)||0;
    const unitPrice = newType==="dropship" ? partnerPriceFor(p, qty) : (Number(p.listPrice)||0);
    return {...it, unitPrice};
  });
}
function stcSelectedType(){ return document.getElementById("stcType").value; }
function renderShipTypePreview(){
  const s=typeChangingShip; if(!s) return;
  const newType=stcSelectedType();
  document.getElementById("stcPartnerWrap").style.display = newType==="dropship" ? "" : "none";
  const reprice=document.getElementById("stcReprice").checked;
  const next=repricedShipItems(s,newType,reprice);
  document.getElementById("stcPreviewBody").innerHTML = next.map((it,i)=>{
    const cur=Number((s.items||[])[i]?.unitPrice)||0;
    const nv=Number(it.unitPrice)||0;
    const conn=itemConnection(it, products);
    return `<tr><td>${esc(it.sku)}${conn?`<div class="conn-tag">${esc(conn)}</div>`:""}</td><td class="num">${Number(it.qty)||0}</td>
      <td class="num">${yen(cur)}</td>
      <td class="num"${nv!==cur?' style="font-weight:700;color:var(--color-warn,#c87a1f)"':''}>${yen(nv)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" style="color:var(--color-ink-muted)">明細がありません</td></tr>`;
  const before=shipTotalIncl(s);
  const after=shipTotalIncl({...s, items:next});
  document.getElementById("stcTotal").innerHTML =
    `請求額（税込・送料込み）: ${yen(before)} → <span style="color:${after!==before?"var(--color-warn,#c87a1f)":"inherit"}">${yen(after)}</span>`;
}
function openShipTypeModal(s){
  typeChangingShip=s;
  const cur=s.shipType==="dropship"?"dropship":"direct";
  document.getElementById("stcTitle").textContent=`出荷種別（請求先）の変更（${s.soNumber||""}）`;
  document.getElementById("stcCurrent").innerHTML =
    `現在: <strong>${esc(SHIP_TYPE_LABEL[cur])}</strong>／請求先 <strong>${esc(billToOf(s)||"（未設定）")}</strong>`;
  const err=document.getElementById("stcError"); err.style.display="none"; err.textContent="";
  // 請求済・入金済は請求書を出した後なので金額・請求先を動かさない（作り直しの案内に留める）
  const locked = s.status==="invoiced" || s.status==="paid" || s.status==="canceled";
  const lockBox=document.getElementById("stcLocked");
  lockBox.style.display = locked?"block":"none";
  lockBox.innerHTML = locked
    ? `この出荷は<strong>${esc(SHIP_STATUS[s.status]||s.status)}</strong>のため、種別・請求先は変更できません。`
      + `請求先を間違えていた場合は、入金の記録を取り消して請求をやり直すか、出荷を削除して作り直してください。`
    : "";
  document.getElementById("stcForm").style.display = locked?"none":"";
  document.getElementById("doStcBtn").disabled = locked;
  if(locked){ document.getElementById("shipTypeModal").classList.add("open"); return; }
  document.getElementById("stcType").value=cur;
  document.getElementById("stcReprice").checked=true;
  document.getElementById("stcPartner").innerHTML = '<option value="">選択してください</option>'+
    activePartners.map(p=>`<option value="${esc(p._id)}">${esc(p.partnerName||p._id)}</option>`).join("");
  document.getElementById("stcPartner").value = (cur==="dropship" && s.partnerEmail) ? s.partnerEmail : "";
  renderShipTypePreview();
  document.getElementById("shipTypeModal").classList.add("open");
}
async function doChangeShipType(){
  const s=typeChangingShip; if(!s) return;
  const err=document.getElementById("stcError"); err.style.display="none"; err.textContent="";
  const newType=stcSelectedType();
  const partnerId = newType==="dropship" ? document.getElementById("stcPartner").value : "";
  if(newType==="dropship" && !partnerId){
    err.textContent="直送の場合は請求先（認定事業者）を選択してください"; err.style.display="block"; return; }
  const partner=activePartners.find(p=>p._id===partnerId)||{};
  const items=repricedShipItems(s,newType,document.getElementById("stcReprice").checked);
  const before=shipTotalIncl(s), after=shipTotalIncl({...s, items});
  const msg=`出荷 ${s.soNumber} の種別を\n  ${SHIP_TYPE_LABEL[s.shipType==="dropship"?"dropship":"direct"]}\n→ ${SHIP_TYPE_LABEL[newType]}\n`
    + `に変更します。請求先は「${newType==="dropship"?(partner.partnerName||partnerId):(s.company||s.officeName||"")}」になります。\n`
    + `請求額（税込）: ${yen(before)} → ${yen(after)}\n在庫は変動しません。よろしいですか？`;
  if(!confirm(msg)) return;
  const btn=document.getElementById("doStcBtn"); btn.disabled=true;
  try{
    await updateDoc(doc(db,"shipments",s._id),{
      shipType:newType,
      partnerEmail: newType==="dropship" ? partnerId : "",
      partnerName: newType==="dropship" ? (partner.partnerName||"") : "",
      items,
      shipTypeChangedFrom: s.shipType||"",
      shipTypeChangedAt: serverTimestamp(),
      shipTypeChangedBy: currentUser.displayName||currentUser.email,
      updatedAt: serverTimestamp(), updatedBy: currentUser.displayName||currentUser.email });
    document.getElementById("shipTypeModal").classList.remove("open");
    typeChangingShip=null;
    toast(`${s.soNumber} の出荷種別を変更しました（在庫は変動なし）`);
  }catch(e){ err.textContent=`変更に失敗しました: ${e.message}`; err.style.display="block"; }
  finally{ btn.disabled=false; }
}

// ===== 未集金一覧（認定事業者・事業所ごとの残額と最長超過日数）=====
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
          <td style="white-space:nowrap"><button class="btn btn-danger ${h.kind==="pay"?"pay-del":"refund-del"}" data-idx="${h.idx}" style="font-size:11px;padding:2px 8px" aria-label="この記録を取り消す"><i class="ti ti-x" aria-hidden="true"></i> ${h.kind==="pay"?"入金を取り消す":"返金を取り消す"}</button></td></tr>`;
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
    // 発送済（未請求）の出荷は状態を変えない（請求済にする・経理への報告を飛ばさない。supply-rules の applyBankPayments と同じ）
    status: shipStatusOf(s)==="shipped" ? "shipped" : (remain<=0 ? "paid" : "invoiced"),
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
  if(!confirm(`${p.date||""} の入金 ${yen(Number(p.amount)||0)} を取り消します。よろしいですか？`
    + (p.bankTxnId ? "\n\n入金明細から記録した入金です。取り消すと、その明細はもう一度取り込めるようになります。" : ""))) return;
  // 入金明細から記録した入金は、取り込み記録 bankTxns/{bankTxnId} も同じ tx で消す（2026-10-21 レビュー指摘）。
  // 残すと「取込済み」と判定され、取り消した明細を取り込み直せなかった
  try{
    await runTransaction(db, async (tx)=>{
      const ref = doc(db,"shipments",s._id);
      const snap = await tx.get(ref);
      if(!snap.exists()) throw new Error("出荷が見つかりません");
      const { patch, bankTxnId } = paymentRemovalOf({ _id:s._id, ...snap.data() }, p, today());
      tx.update(ref, { ...patch, updatedAt:serverTimestamp(), updatedBy:currentUser.displayName||currentUser.email });
      if(bankTxnId) tx.delete(doc(db,"bankTxns",bankTxnId));
    });
    document.getElementById("payModal").classList.remove("open");
    payingShip=null;
    toast(p.bankTxnId ? "入金の記録を取り消しました（この明細はもう一度取り込めます）" : "入金の記録を取り消しました");
  }
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
let invReportCtx = null; // { id, st, salesRepName, invoicedAt } 開いた請求書の描画材料
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
  // 請求書の発行日: 新規は入力欄（既定は今日・2026-10-19 #6）。後追い報告は既存の請求日を使う（請求書の記載とズレないように）
  const dateIn = document.getElementById("invReportDate");
  document.getElementById("invReportDateWrap").style.display = invReportOnly ? "none" : "";
  if(!invReportOnly) dateIn.value = today();
  const invoicedAt = invReportOnly ? (s.invoicedAt || today()) : dateIn.value;
  // 支払期限は請求書の記載と一致させる（dueRule:'net14' は発行日＋14日・従来は請求月の翌月末）
  const due = dueDateOf({ ...s, status:"invoiced", invoicedAt }) || "";
  const deliverTo = [s.company, s.officeName].filter(Boolean).join(" / ");
  const contactName = (st.accountingContactName || "").trim();
  const acctEmail = (st.accountingEmail || "").trim();
  // 経理の投稿先は設定画面の「有効／停止」に従う（未定義は有効。停止中は投稿しない＝functions の resolveWebhook と同じ）
  const webhook = st.accountingChatWebhookEnabled === false ? "" : (st.accountingChatWebhookUrl || "").trim();

  // dueOverride: 発行日を入れ直したときの支払期限（renderInvReportDated から渡す）
  const fill=(t, dueOverride)=>String(t||"")
    .split("{{経理担当}}").join(contactName || "経理ご担当")
    .split("{{請求書番号}}").join(invNo)
    .split("{{請求先}}").join(billToOf(s))
    .split("{{納品先}}").join(deliverTo)
    .split("{{請求金額}}").join(amountText)
    .split("{{支払期限}}").join((dueOverride ?? due) || "（未設定）")
    .split("{{出荷番号}}").join(s.soNumber||"")
    .split("{{出荷日}}").join(s.shipDate||"");

  document.getElementById("invReportTitle").textContent = invReportOnly
    ? `経理へ報告（${s.soNumber}）` : `請求済にする（${s.soNumber}）`;
  // 発行日を変えたら、支払期限・メール本文・プレビューの請求書を描き直す（下の renderInvReportDated）
  invReportFill = { fill, contactName, deliverTo, amountText, invNo };
  document.getElementById("invReportSummary").innerHTML =
    `<div><strong>請求書番号</strong>　${esc(invNo)}</div>`
    + `<div><strong>請求先</strong>　${esc(billToOf(s))}</div>`
    + (deliverTo?`<div><strong>納品先</strong>　${esc(deliverTo)}</div>`:"")
    + `<div><strong>請求金額（税込）</strong>　${esc(amountText)}</div>`
    + `<div><strong>支払期限</strong>　<span id="invReportDue">${esc(due||"（未設定）")}</span>${s.dueRule==="net14"?`<span style="font-size:12px;color:var(--color-ink-muted)">（請求書の発行日から14日）</span>`:""}</div>`
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
  invReportFill.lastSubject = document.getElementById("invReportSubject").value;
  invReportFill.lastBody = document.getElementById("invReportBody").value;
  // PDF生成の対象。請求書の発行日は請求済にする当日＝請求書PDFの記載と支払期限を揃える
  // 書面の「担当」は案件の担当営業（無ければ空欄のまま）。
  // ⚠ この関数には送付先担当者の contactName が既にあるので別名にする
  let salesRepName = "";
  if(s.caseId){
    try{ const cs = await getDoc(doc(db,"cases",s.caseId)); if(cs.exists()) salesRepName = cs.data().assignedUserName || ""; }catch(_){}
  }
  // PDF はこの文脈からその場で作り直す（プレビュー枠の中身を使うと、更新前に押したとき前の案件の請求書が入る・2026-10-09）
  invReportCtx = { id: s._id, st, salesRepName, invoicedAt };
  document.getElementById("invReportPreview").innerHTML =
    `<style>${INVOICE_STYLE}</style>` + renderInvoiceHtml({ ...s, invoicedAt, dueDate: due }, st, { products, contactName: salesRepName, issueDate: jpYmd(invoicedAt) });
  document.getElementById("invReportError").style.display="none";
  syncInvReportFields();
  document.getElementById("invReportModal").classList.add("open");
}
// "YYYY-MM-DD" → "YYYY年M月D日"（請求書の発行日の表記。supply-print.js の jpDateOf と同じ）
function jpYmd(ymd){ const m=String(ymd||"").match(/^(\d{4})-(\d{2})-(\d{2})/); return m?`${+m[1]}年${+m[2]}月${+m[3]}日`:""; }
let invReportFill = null; // { fill, lastSubject, lastBody, ... } 発行日を変えたときの差し込み直し用
// 発行日の入力が変わったら、支払期限・メールの件名本文（手で直していなければ）・プレビューの請求書を描き直す
function renderInvReportDated(){
  const s = invReportShip; if(!s || invReportOnly || !invReportCtx || invReportCtx.id!==s._id) return;
  const invoicedAt = document.getElementById("invReportDate").value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(invoicedAt)) return;
  invReportCtx.invoicedAt = invoicedAt;
  const due = dueDateOf({ ...s, status:"invoiced", invoicedAt }) || "";
  const dueEl = document.getElementById("invReportDue"); if(dueEl) dueEl.textContent = due || "（未設定）";
  if(invReportFill){
    const st = invReportCtx.st || {};
    // 件名・本文は {{支払期限}} を含むので作り直す。ただし手で直した後なら上書きしない
    const subjEl = document.getElementById("invReportSubject"), bodyEl = document.getElementById("invReportBody");
    const subj = invReportFill.fill(st.invoiceMailSubject || DEFAULT_INVOICE_MAIL_SUBJECT, due);
    const body = invReportFill.fill(st.invoiceMailBody || DEFAULT_INVOICE_MAIL_BODY, due);
    if(subjEl.value === invReportFill.lastSubject){ subjEl.value = subj; invReportFill.lastSubject = subj; }
    if(bodyEl.value === invReportFill.lastBody){ bodyEl.value = body; invReportFill.lastBody = body; }
  }
  document.getElementById("invReportPreview").innerHTML =
    `<style>${INVOICE_STYLE}</style>` + renderInvoiceHtml({ ...s, invoicedAt, dueDate: due }, invReportCtx.st, { products, contactName: invReportCtx.salesRepName, issueDate: jpYmd(invoicedAt) });
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
  // 請求書の発行日（2026-10-19 #6）。後追い報告では使わない（既存の請求日のまま）
  const issueYmd = invReportOnly ? "" : document.getElementById("invReportDate").value;
  if(!invReportOnly){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(issueYmd)){ err.textContent="請求書の発行日を入れてください"; err.style.display="block"; return; }
    if(s.shipDate && issueYmd < s.shipDate
      && !confirm(`請求書の発行日（${issueYmd}）が出荷日（${s.shipDate}）より前です。このまま請求済にしますか？`)) return;
    // 入力欄を変えたのに描き直しが走っていない場合に備えて、PDF の描画材料もこの日付にそろえる
    if(invReportCtx && invReportCtx.id===s._id) invReportCtx.invoicedAt = issueYmd;
  }
  const btn = document.getElementById("doInvReportBtn"); const orig = btn.innerHTML;
  btn.disabled = true;
  try{
    // 1) まず請求済にする（報告が失敗しても請求済の記録は残す）。後追い報告のときは状態を変えない
    let cur;
    let paidOnInvoice = false; // 請求前に全額入金されていて、請求済にした時点で入金済になったか
    if(invReportOnly){
      cur = { ...s };
    }else{
      btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> 請求済にしています...';
      const invoicedAt = issueYmd;
      // 支払期限は請求済にした時点で確定値として保存する（以後、計算の規則が変わっても請求書の記載とずれない）
      const dueDate = dueDateOf({ ...s, status:"invoiced", invoicedAt }) || "";
      // 請求前に入金明細などで全額入っていた出荷は、請求済にした時点で入金済にする（2026-10-21 レビュー指摘）。
      // 残額は最新の記録で判定する（画面を開いたあとに入金が記録されている場合があるため tx で読む）
      const r = await runTransaction(db, async (tx)=>{
        const ref = doc(db,"shipments",s._id);
        const snap = await tx.get(ref);
        if(!snap.exists()) throw new Error("出荷が見つかりません");
        const latest = { _id:s._id, ...snap.data() };
        const out = invoicePatchOf(latest, { invoicedAt, dueDate, today: today() });
        tx.update(ref, { ...out.patch, updatedAt:serverTimestamp() });
        return { latest, ...out };
      });
      paidOnInvoice = r.paid;
      cur = { ...r.latest, ...r.patch };
    }

    // 2) 経理へ報告（PDFはブラウザで生成 → 関数がStorage保存・メール添付・Chat投稿）
    let warn = [];
    if(send){
      btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> 請求書PDFを作成中...';
      const invNo = invoiceNoOf(s);
      // プレビュー枠ではなく、この出荷のデータから請求書を作り直す。別の案件の請求書が混ざらないよう番号も照合する
      if(!invReportCtx || invReportCtx.id !== s._id) throw new Error("請求書の準備が終わっていません。いったん閉じて開き直してください");
      if(!document.getElementById("invoice-pdf-style")){
        const stEl = document.createElement("style"); stEl.id = "invoice-pdf-style"; stEl.textContent = INVOICE_STYLE; document.head.appendChild(stEl);
      }
      const freshHost = document.createElement("div");
      const pdfInvoicedAt = cur.invoicedAt || invReportCtx.invoicedAt;
      freshHost.innerHTML = renderInvoiceHtml({ ...s, invoicedAt: pdfInvoicedAt, dueDate: dueDateOf({ ...cur, invoicedAt: pdfInvoicedAt }) || "" }, invReportCtx.st,
        { products, contactName: invReportCtx.salesRepName, issueDate: jpYmd(pdfInvoicedAt) });
      const el = freshHost.querySelector(".inv");
      if(!el) throw new Error("請求書を作れませんでした");
      if(!el.textContent.includes(invNo)) throw new Error(`請求書の番号が一致しません（${invNo}）。いったん閉じて開き直してください`);
      const filename = `${invNo}.pdf`;
      // プレビュー枠（高さ360px・スクロール）のまま描くと右端が切れ、フッターが2ページ目に出ていた（2026-10-01）。
      // 画面外に複製して A4 1枚に収めてから PDF にする
      const { clone: pdfEl, cleanup: pdfCleanup } = offscreenClone(el);
      let dataUri;
      try { dataUri = await buildOnePagePdf(pdfEl); }
      finally { pdfCleanup(); }
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
    else if(paidOnInvoice && send) toast("請求済にして経理へ報告しました。全額入金済みのため「入金済」にしました");
    else if(paidOnInvoice) toast("請求済にしました（経理への報告なし）。全額入金済みのため「入金済」にしました");
    else if(send) toast("請求済にして経理へ報告しました");
    else toast("請求済にしました（経理への報告なし）");
    if(warn.length) console.warn("経理報告の警告:", warn);

    // 3) 同じ請求先に未充当の過入金があれば、その場で「次回の請求から引く」を提案する（従来の挙動を維持）
    if(!wasReportOnly && creditBalanceForBillTo(cur)>0) openCreditModal(cur);
  }catch(e){
    err.textContent = `失敗: ${e.message||e}`; err.style.display="block";
  }finally{ btn.disabled=false; btn.innerHTML=orig; }
}

// ===== 受注（認定事業者から）=====
const PO_STATUS = { received:"受付済", confirmed:"受注確定", shipped:"出荷済", canceled:"キャンセル" };
function fmtDT(ts){ if(!ts) return "—"; const d=ts.toDate?ts.toDate():new Date(ts); return d.toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});}
function renderPartnerOrders(orders){
  document.getElementById("poEmpty").style.display = orders.length?"none":"block";
  document.getElementById("poBody").innerHTML = orders.map(o=>{
    const sum=(o.items||[]).map(i=>itemLine(i, products)).join("／ ");
    const sh=o.shipping||{};
    const opts=Object.entries(PO_STATUS).map(([k,v])=>`<option value="${k}" ${o.status===k?"selected":""}>${v}</option>`).join("");
    // この受注に紐づく出荷の請求・入金状況（受注一覧からも入金確認できるように）
    const rel=shipments.filter(s=>s.partnerOrderId===o._id && s.status!=="canceled");
    // ひも付く生きた出荷（キャンセル以外）があるときは「出荷へ」を出さない（同じ受注から出荷が2つできるのを防ぐ・2026-10-21）
    const relLabel = rel.length ? (SHIP_STATUS[shipStatusOf(rel[0])]||"") : "";
    const shipBtn = rel.length
      ? `<span style="font-size:12px;color:${rel.some(s=>s.status==="draft"||s.status==="requested")?"var(--color-ink-muted)":"var(--color-success)"}">出荷 ${esc(relLabel)}</span>`
      : o.status==="shipped"
      ? `<span style="font-size:12px;color:var(--color-success)">出荷済</span>`
      : `<button class="btn btn-primary po-ship" data-id="${o._id}" style="font-size:12px;padding:4px 8px"><i class="ti ti-truck-delivery"></i>出荷へ</button>`;
    const relRemain=rel.reduce((a,s)=>a+payRemain(s),0);
    const relOverdue=rel.some(s=>isUnpaid(s)&&overdueDays(s)>0);
    const payCell = !rel.length ? `<span style="font-size:12px;color:var(--color-ink-muted)">—</span>`
      // 依頼済（センターの発送待ち）も、まだ請求していないので未請求として出す（2026-10-21）
      : rel.some(s=>s.status==="shipped"||s.status==="requested"||s.status==="draft") && relRemain===0 ? `<span style="font-size:12px;color:var(--color-ink-muted)">未請求</span>`
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
   認定事業者ポータルを使わず、メールでファイルを送ってくる相手の受け口。
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
    const sum = o.items.map(i=>itemLine(i, products)).join("／ ");
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
      // 認定事業者名は partners マスタから解決（メール一致・無ければファイルの値のまま）
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

// 受注（認定事業者）→ 出荷へ変換。ほかの経路と同じく「出荷を依頼する」として登録する（2026-10-21・§9 決定5・6）。
//   ・出荷は依頼済(requested)で作り、出荷指示を投稿する。在庫は動かさない（発送済にしたときに引く）
//   ・受注の状態は、依頼の時点で「受注確定」(confirmed)、出荷を「発送済にする」で「出荷済」(shipped)（markShipped が書く）
//   ・同じ受注にひも付く生きた出荷（キャンセル以外）があれば、新しく作らない
async function shipFromOrder(o){
  const sh=o.shipping||{};
  const items=(o.items||[]).map(it=>{
    const p=products.find(x=>x.id===it.sku)||{};
    return { sku:it.sku, name:it.name||p.name||it.sku, qty:Number(it.qty)||0, unitPrice:partnerPriceFor(p, Number(it.qty)||0) };
  }).filter(it=>it.qty>0);
  if(!items.length){ alert("発注内容が空です"); return; }
  if(stockItems(items).length && !defaultLocationId()){ alert("保管場所が登録されていません。先に在庫タブで追加してください"); return; }
  try{
    const ex=await getDocs(query(collection(db,"shipments"),where("partnerOrderId","==",o._id)));
    const live=ex.docs.filter(d=>d.data().status!=="canceled");
    if(live.length){
      alert(`この受注にはすでに出荷 ${live.map(d=>d.data().soNumber||"").join("・")}（${SHIP_STATUS[shipStatusOf(live[0].data())]||""}）があります。出荷一覧で確認してください。`);
      return;
    }
  }catch(e){ alert(`既存の出荷を確認できませんでした: ${e.message}`); return; }
  // 希望出荷日・出荷元・レターパックの種類を確認してから登録する（在庫不足は警告だけ・依頼の確認ダイアログ）
  const ans = await askShipDetails({ mode:"request",
    title: `受注から出荷を依頼する（${o.partnerName||o.partnerEmail||""}）`,
    summaryHtml: `<div>受注（${esc(o.partnerName||o.partnerEmail||"")}）を出荷として登録し、出荷を依頼します。</div>`
      + `<div><strong>送付先</strong>　${esc(sh.company||"")} ${esc(sh.officeName||"")}</div>`
      + `<div style="font-size:12px;color:var(--color-ink-muted)">${esc([sh.postal?`〒${sh.postal}`:"", sh.address||""].filter(Boolean).join(" "))}</div>`,
    usesStock: true, locId: defaultLocationId(), date: today(), letterPackType: "", items,
  });
  if(!ans) return;
  const fromLoc = ans.originLocationId || defaultLocationId();
  let newShipId="", soNumber="";
  try{
    soNumber=seqFmt("SH",await nextSeq("shipments"));
    const packs=Math.max(1,Math.ceil(items.reduce((a,i)=>a+i.qty,0)/3));
    const newRef = await addDoc(collection(db,"shipments"),{
      soNumber, shipType:"dropship", partnerEmail:o.partnerEmail||"", partnerName:o.partnerName||"",
      status:"requested", partnerOrderId:o._id,
      originLocationId: fromLoc, originLocationName: locationName(fromLoc),
      shippingMethod:"letterpack", shippingFee:taxExcl(packs*letterpackFee()), shippingLabel:`送料（レターパック ${packs}通）`,
      shipDate:ans.shipDate, postal:sh.postal||"", company:sh.company||"", officeName:sh.officeName||"",
      address:sh.address||"", contactName:sh.contactName||"", phone:sh.phone||"",
      ...(o.desiredDeliveryDate ? { desiredDeliveryDate:o.desiredDeliveryDate } : {}),
      ...letterPackPatch(ans.letterPackType), ...requestedStampPatch(),
      items, createdAt:serverTimestamp(), createdBy:currentUser.displayName||currentUser.email });
    newShipId = newRef.id;
    await updateDoc(doc(db,"partnerOrders",o._id),{status:"confirmed",updatedAt:serverTimestamp()});
  }catch(e){ alert(`出荷登録失敗: ${e.message}`); return; }
  const head = `受注から出荷を依頼しました（${soNumber}・在庫は発送済にしたときに引き落とします）`;
  toast(`${head}。出荷指示を投稿しています...`);
  toast(`${head}。${await postShipNotice(newShipId)}`);
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
  document.getElementById("partnerModalTitle").textContent = editingPartnerId?"認定事業者を編集":"認定事業者を追加";
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
  if(!name){ err.textContent="認定事業者名を入力してください"; err.style.display="block"; return; }
  if(!editingPartnerId && partnersCache.some(p=>p._id===email)){ err.textContent="このメールは既に登録されています"; err.style.display="block"; return; }
  if(!editingPartnerId && email.endsWith("@tadakayo.jp") &&
     !confirm("@tadakayo.jp は職員アカウントです。認定事業者として登録しますか？")) return;
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

// ===== 発注方法のご案内メール（認定事業者へ・催促メールと同じGmail基盤）=====
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

// 閲覧のみ（viewer）: 文言で拾えない操作ボタンをクラスで止める（あとから描かれる行にも効かせる）。
// 属性しか変えないので MutationObserver（childList）が自分を呼び直すことはない
function lockViewerButtons(){
  const run=()=>document.querySelectorAll(VIEWER_LOCK_SELECTOR).forEach(b=>{
    if(b.disabled) return;
    b.disabled=true; b.setAttribute("aria-disabled","true");
    b.title="閲覧のみの権限では操作できません"; b.style.opacity="0.45"; b.style.pointerEvents="none";
  });
  run();
  new MutationObserver(run).observe(document.body,{ childList:true, subtree:true });
}
// ===== 初期化 =====
onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  const myRole = await gateRole(db,user);
  if(!myRole) return;
  viewerMode = applyViewerMode(myRole);
  if(viewerMode) lockViewerButtons();
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
  document.getElementById("newShipBtn").addEventListener("click",()=>openShip());
  const closeShip=()=>{ document.getElementById("shipModal").classList.remove("open"); editingShip=null; };
  document.getElementById("closeShipBtn").addEventListener("click",closeShip);
  document.getElementById("cancelShipBtn").addEventListener("click",closeShip);
  document.getElementById("saveShipBtn").addEventListener("click",saveShip);
  // 新規登録の「すでに発送済として登録」に合わせて保存ボタンの文言を変える（2026-10-21）
  document.getElementById("shipAlreadyShipped")?.addEventListener("change",(e)=>{
    if(editingShip) return;
    document.getElementById("saveShipLabel").textContent = e.target.checked ? "発送済として登録" : "登録して出荷を依頼する";
  });
  document.getElementById("shipFee").addEventListener("input",updateShipTotal);
  document.getElementById("shipType").addEventListener("change",(e)=>{
    document.getElementById("shipPartnerWrap").style.display = e.target.value==="dropship"?"":"none";
    // 伴走支援費は事業所へ直接請求する出荷（direct）だけ。直送（dropship）へ切り替えたら畳んでチェックも外す
    const isDrop = e.target.value==="dropship";
    document.getElementById("shipSubsidyWrap").style.display = isDrop ? "none" : "";
    if(isDrop){
      document.getElementById("shipSubsidyOn").checked=false;
      document.getElementById("shipSubsidyBody").style.display="none";
    }
    updateShipTotal();
  });
  document.getElementById("shipSubsidyOn").addEventListener("change",(e)=>{
    document.getElementById("shipSubsidyBody").style.display = e.target.checked ? "" : "none";
    if(e.target.checked){
      refreshSubsidyAutoDefaults();
      // 既存の出荷でチェックを入れ直したとき、区分が空なら紐づく見積もり／案件から引く（2026-09-22）。
      // restoreSubsidyFromShip は伴走支援費の行が無い出荷では早期 return するため、ここで補う。
      const planEl=document.getElementById("shipSubsidyPlan");
      if(!planEl.value && editingShip && (editingShip.quoteId || editingShip.caseId)) inferSubsidyFromLinks(editingShip).catch(()=>{});
    }
    updateShipTotal();
  });
  document.getElementById("shipSubsidyPlan").addEventListener("change",()=>{ refreshSubsidyAutoDefaults(); updateShipTotal(); });
  ["shipSubsidyBt","shipSubsidyUsb"].forEach(id=>document.getElementById(id)
    .addEventListener("input",(e)=>{ e.target.dataset.auto="0"; updateShipTotal(); }));
  ["shipMethod","shipYuSize","shipYuRegion"].forEach(id=>document.getElementById(id).addEventListener("change",recalcShipFee));
  // 送料欄（税抜）に税込の実費が打たれていないか、手入力のときだけ確認する
  document.getElementById("shipFee").addEventListener("input",checkShipFeeTaxIncl);
  // 発注の送料を手で直したら、以後は台数変更で勝手に上書きしない
  ["orderShipFee","orderShipLabel"].forEach(id=>document.getElementById(id)
    .addEventListener("input",()=>{ orderShipFeeAuto=false; }));
  // 出荷種別（請求先）の変更モーダル
  const closeStc=()=>{ document.getElementById("shipTypeModal").classList.remove("open"); typeChangingShip=null; };
  document.getElementById("closeStcBtn").addEventListener("click",closeStc);
  document.getElementById("cancelStcBtn").addEventListener("click",closeStc);
  document.getElementById("stcType").addEventListener("change",renderShipTypePreview);
  document.getElementById("stcReprice").addEventListener("change",renderShipTypePreview);
  document.getElementById("doStcBtn").addEventListener("click",doChangeShipType);

  // products（リアルタイム・在庫反映）
  let prefilled=false;
  const shipCaseId = new URLSearchParams(location.search).get("ship");
  onSnapshot(query(collection(db,"products")),(snap)=>{
    products=snap.docs.map(d=>({_id:d.id,id:d.id,...d.data()})).sort((a,b)=>a.id.localeCompare(b.id));
    renderProducts();
    renderLocations();   // 保管場所の「在庫合計」は商品側の数字から出しているので、ここでも描き直す
    if(shipCaseId && !prefilled){ prefilled=true; prefillShipFromCase(shipCaseId); }
  });
  // 保管場所（在庫の内訳・出荷元の選択肢に使う）
  onSnapshot(query(collection(db,"locations")),(snap)=>{
    locations=snap.docs.map(d=>({_id:d.id,...d.data()}))
      .sort((a,b)=>(Number(a.sort)||0)-(Number(b.sort)||0)||String(a.name||"").localeCompare(String(b.name||"")));
    renderLocations(); renderProducts(); renderTransfers();
  });
  // 保管場所間の移動（2026-09-30）
  onSnapshot(query(collection(db,"stockTransfers")),(snap)=>{
    transfers=snap.docs.map(d=>({_id:d.id,...d.data()}));
    renderTransfers();
  }, (e)=>console.warn("stockTransfers:", e.message));
  // 発注一覧
  onSnapshot(query(collection(db,"purchaseOrders"),orderBy("createdAt","desc")),(snap)=>{
    renderOrders(snap.docs.map(d=>({_id:d.id,...d.data()})));
  });
  // 出荷一覧（受注タブの入金状況にも使うので保持して再描画する）
  onSnapshot(query(collection(db,"shipments"),orderBy("createdAt","desc")),(snap)=>{
    shipments=snap.docs.map(d=>({_id:d.id,...d.data()}));
    renderShipmentsView();
    if(partnerOrdersCache.length) renderPartnerOrders(partnerOrdersCache);
    if(!shipDeepLinkTried){ shipDeepLinkTried=true; scrollToShipmentFromUrl(); }
  });
  // 出荷の担当＝元の案件の担当営業（絞り込み用）
  {
    const asgSel=document.getElementById("shipAssigneeFilter");
    bindPrefSelect(asgSel, "supply.ship.assignee", renderShipmentsView);
    bindPrefSelect(document.getElementById("shipSortSelect"), "supply.ship.sort", renderShipmentsView);
    // ホームから来たときはホームで見ていた範囲（自分／全員）、特定の出荷（?so=）を開きに来たときは全員で開く（覚え直さない）
    const sp=new URLSearchParams(location.search);
    if(sp.get("assignee")==="me"){ asgSel.value="__me"; asgSel.dataset.pref="__me"; }
    else if(sp.get("assignee")==="all" || sp.get("so")){ asgSel.value=""; asgSel.dataset.pref=""; }
    onSnapshot(collection(db,"cases"),(snap)=>{
      casesForOwners=snap.docs.map(d=>({_id:d.id,assignedUserId:d.data().assignedUserId||null,assignedUserName:d.data().assignedUserName||null}));
      caseOwners=Object.fromEntries(casesForOwners.map(c=>[c._id,c.assignedUserId]));
      // 下書きの重複で「残す候補」にする出荷（案件に結びついている shipmentId）
      caseShipmentIds=Object.fromEntries(snap.docs.filter(d=>d.data().shipmentId).map(d=>[d.id,d.data().shipmentId]));
      ownersState="ok";
      fillAssigneeSelect(asgSel, casesForOwners, currentUser?.email);
      renderShipmentsView();
    }, (e)=>{ console.warn("cases (担当の絞り込み):", e.message); ownersState="error"; renderShipmentsView(); });
  }
  // 受注（認定事業者から）
  onSnapshot(query(collection(db,"partnerOrders"),orderBy("createdAt","desc")),(snap)=>{
    partnerOrdersCache=snap.docs.map(d=>({_id:d.id,...d.data()}));
    renderPartnerOrders(partnerOrdersCache);
  });
  // 保管場所・入荷先のモーダル
  document.getElementById("newLocationBtn").addEventListener("click",()=>openLocationModal(null));
  document.getElementById("saveLocationBtn").addEventListener("click",saveLocation);
  document.getElementById("closeLocationBtn").addEventListener("click",closeLocationModal);
  document.getElementById("cancelLocationBtn").addEventListener("click",closeLocationModal);
  document.getElementById("doReceiveBtn").addEventListener("click",doReceive);
  // 保管場所間の移動
  document.getElementById("newTransferBtn").addEventListener("click",openTransferModal);
  document.getElementById("saveTransferBtn").addEventListener("click",saveTransfer);
  document.getElementById("closeTransferBtn").addEventListener("click",closeTransferModal);
  document.getElementById("cancelTransferBtn").addEventListener("click",closeTransferModal);
  document.getElementById("doArriveBtn").addEventListener("click",doArrive);
  document.getElementById("closeArriveBtn").addEventListener("click",closeArriveModal);
  document.getElementById("cancelArriveBtn").addEventListener("click",closeArriveModal);
  document.getElementById("closeReceiveBtn").addEventListener("click",closeReceiveModal);
  document.getElementById("cancelReceiveBtn").addEventListener("click",closeReceiveModal);
  document.getElementById("shipOrigin").addEventListener("change",updateShipOriginHint);
  ["shipMethod","shipLetterPack"].forEach(id=>document.getElementById(id).addEventListener("change",updateShipLpNotice));

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
  // 出荷のキャンセルモーダル（2026-09-14 追加）
  document.getElementById("closeCancelShipBtn").addEventListener("click",closeCancelShipModal);
  document.getElementById("cancelCancelShipBtn").addEventListener("click",closeCancelShipModal);
  document.getElementById("doCancelShipBtn").addEventListener("click",doCancelShipment);
  // 入金明細の取り込み（2026-10-21 §7）。閲覧のみの人はボタンを押せない
  initBankImport({ db, getShipments: ()=>shipments, getUser: ()=>currentUser, toast, isViewer: viewerMode });
  // 請求済にする＋経理へ報告モーダル
  document.getElementById("closeInvReportBtn").addEventListener("click",()=>document.getElementById("invReportModal").classList.remove("open"));
  document.getElementById("cancelInvReportBtn").addEventListener("click",()=>document.getElementById("invReportModal").classList.remove("open"));
  document.getElementById("invReportSend").addEventListener("change",syncInvReportFields);
  document.getElementById("doInvReportBtn").addEventListener("click",doInvoiceReport);
  document.getElementById("invReportDate").addEventListener("change",renderInvReportDated);
  // 発送済にする前の確認（出荷日・出荷元・レターパックの種類・2026-10-19）
  document.getElementById("closeShipDoneBtn").addEventListener("click",()=>closeShipDone(null));
  document.getElementById("cancelShipDoneBtn").addEventListener("click",()=>closeShipDone(null));
  document.getElementById("doShipDoneBtn").addEventListener("click",doShipDone);
  document.getElementById("shipDoneOrigin").addEventListener("change",updateShipDoneHint);
  document.getElementById("shipDoneLp").addEventListener("change",updateShipDoneLpNotice);
  // 追跡番号の写真（2026-10-19）
  document.getElementById("closeTrackBtn").addEventListener("click",closeTrackModal);
  document.getElementById("cancelTrackBtn").addEventListener("click",closeTrackModal);
  document.getElementById("trackFiles").addEventListener("change",uploadTrackPhotos);
  document.getElementById("saveTrackNumberBtn").addEventListener("click",saveTrackNumber);
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
