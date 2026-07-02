import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderPOHtml } from "/js/po-doc.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const params = new URLSearchParams(location.search);
const type = params.get("type"); // po | ship
const id = params.get("id");

function esc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function yen(n){return "¥"+Number(n||0).toLocaleString("ja-JP");}
const today = new Date().toLocaleDateString("ja-JP",{year:"numeric",month:"long",day:"numeric"});

// 発注元（NPO法人タダカヨ）情報の既定値。設定(appConfig/settings.po*)で上書き可
const PO_DEFAULT = {
  issuerName: "NPO法人タダカヨ",
  issuerAddrLabel: "事務所所在地：",
  issuerAddr: "東京都大田区大森中二丁目1番20-1001号",
  issuerRep: "理事長：佐藤 拡史",
  ordererName: "次田 芳尚",
  sealText: "次田",
};
// 発注書の描画は po-doc.js の renderPOHtml に統合（確定プレビューと共通化）
function renderPO(o, st){ return renderPOHtml(o, st); }

function renderShip(s){
  const rows=(s.items||[]).map(i=>`<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="num">${i.qty}</td></tr>`).join("");
  const addr=[s.postal?`〒${esc(s.postal)}`:"",esc(s.address||"")].filter(Boolean).join(" ");
  return `
    <div class="doc-head"><div></div>
      <div class="issuer"><div class="org">NPO法人タダカヨ</div>介護情報基盤伴走支援事業<br>発行日: ${today}</div></div>
    <h1 class="title">送　付　状</h1>
    <div class="to">${esc(s.company||"")}${s.company?"<br>":""}${esc(s.officeName||"")} 御中</div>
    <div class="meta">${addr}${s.contactName?`　／　ご担当: ${esc(s.contactName)} 様`:""}</div>
    <div class="meta">出荷番号: ${esc(s.soNumber)}　／　出荷日: ${esc(s.shipDate||"")}</div>
    <p style="margin-top:16px">平素より大変お世話になっております。下記のとおり送付いたします。ご査収のほどよろしくお願い申し上げます。</p>
    <table class="items"><thead><tr><th>品番</th><th>商品名</th><th style="width:80px">数量</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p style="font-size:12px;color:var(--muted)">※ 不足・破損等ございましたらタダカヨ事務局までご連絡ください。</p>
    <div class="footer">NPO法人タダカヨ　介護情報基盤伴走支援事業　／　お問い合わせ: kjk-staff@tadakayo.jp</div>`;
}

// レターパックプラス(赤) 宛名ラベル：実物の記入欄を再現。A4に印刷→切り取り線で切って貼付
function zipBoxes(postal, n=7){
  const d=(postal||"").replace(/[^0-9]/g,"").padEnd(n," ").slice(0,n).split("");
  return `<span class="zip">${d.map(x=>`<span class="zbox">${x.trim()||"&nbsp;"}</span>`).join("")}</span>`;
}
function renderLetterpack(s, sender, variant){
  sender = sender || {};
  const isLight = variant === "light";
  const brandName = isLight ? "レターパックライト" : "レターパックプラス";
  const price = isLight ? "430円" : "600円";
  const colorName = isLight ? "青" : "赤";
  const fromName = sender.name || "";
  const fromPostal = sender.postal || "";
  const fromAddr = sender.address || "";
  const fromPhone = sender.phone || "";
  const toName = `${esc(s.company?s.company+"　":"")}${esc(s.officeName||"")}`;
  return `
    <div class="lp-note">A4で印刷 → 切り取り線（- - -）で切り取り → <strong>${brandName}（${colorName}）の宛名面にそのまま直接貼り付け</strong>てください。</div>
    <div class="lp-label ${isLight?"blue":""}">
      <div class="lp-brand">${brandName}　宛名ラベル <span>${price}</span></div>

      <div class="lp-sec">お届け先</div>
      <div class="lp-row"><span class="lp-k">郵便番号</span><span class="lp-zipmark">〒</span>${zipBoxes(s.postal)}</div>
      <div class="lp-row tall"><span class="lp-k">ご住所</span><span class="lp-v lp-addr">${esc(s.address||"")}</span></div>
      <div class="lp-row big"><span class="lp-k">お名前</span><span class="lp-v lp-name">${toName} <span class="lp-keisho">御中</span></span></div>
      <div class="lp-row"><span class="lp-k">電話番号</span><span class="lp-v">${esc(s.phone||"")}</span></div>

      <div class="lp-sec">ご依頼主</div>
      <div class="lp-row"><span class="lp-k">郵便番号</span><span class="lp-zipmark">〒</span>${zipBoxes(fromPostal)}</div>
      <div class="lp-row"><span class="lp-k">ご住所</span><span class="lp-v">${esc(fromAddr)}</span></div>
      <div class="lp-row"><span class="lp-k">お名前</span><span class="lp-v">${esc(fromName)}</span></div>
      <div class="lp-row"><span class="lp-k">電話番号</span><span class="lp-v">${esc(fromPhone)}</span></div>

      <div class="lp-sec">品名（内容品）</div>
      <div class="lp-row"><span class="lp-v">介護情報基盤 マイナ資格確認 カードリーダー</span></div>
    </div>
    <p style="font-size:11px;color:var(--muted);margin-top:14px">※ ラベルサイズは実物のレターパック宛名欄に合わせています。上部で種別（赤/青）と差出人を切り替えできます。差出人は「設定」で登録します。</p>`;
}

// 請求書（見積書の赤系を踏襲・認定事業所向け／卸価格・税別→税込）
function renderInvoice(s, st){
  st = st || {};
  const items=s.items||[];
  const goodsExcl=items.reduce((a,i)=>a+(Number(i.unitPrice)||0)*(Number(i.qty)||0),0);
  const shipFeeIncl=Number(s.shippingFee)||0;
  const shipExcl=Math.round(shipFeeIncl/1.1); // 送料は税込実費→税抜換算して10%対象明細に計上
  const sub=goodsExcl+shipExcl;
  const tax=Math.floor(sub*0.1); const total=sub+tax;
  const invNo=(s.soNumber||"").replace(/^SH/,"INV");
  const billName = s.shipType==="dropship" ? (s.partnerName||"") : (s.company||s.officeName||"");
  const issuerName = st.invoiceIssuerName || "NPO法人タダカヨ";
  const regNo = st.invoiceRegNo || "";
  const regLine = regNo
    ? `登録番号: <strong>${esc(regNo)}</strong>`
    : `<span style="color:#b84a4a">登録番号: 未登録（設定で登録してください）</span>`;
  // お振込先（設定 appConfig/settings.billing* / 未設定なら従来の案内文言）
  const bankName=st.billingBankName||"", branch=st.billingBranchName||"", acctType=st.billingAccountType||"普通", acctNo=st.billingAccountNumber||"", acctHolder=st.billingAccountHolder||"";
  const hasBank = bankName && acctNo;
  const payInner = hasBank
    ? `<div style="font-size:13px;line-height:1.7">${esc(bankName)}　${esc(branch)}　${esc(acctType)} ${esc(acctNo)}<br>口座名義：${esc(acctHolder)}</div><div style="font-size:12px;color:var(--muted);margin-top:4px">※ 軽減税率対象品目はありません（すべて10%対象）。お支払期限：請求書発行月の翌月末。恐れ入りますが振込手数料は御社にてご負担ください。</div>`
    : `<div style="font-size:12px;color:var(--muted)">※ 軽減税率対象品目はありません（すべて10%対象）。振込先口座は別途ご案内します。お支払期限：請求書発行月の翌月末。</div>`;
  // 適格請求書: 各明細に適用税率を表示
  const rows2=items.map(i=>`<tr><td>${esc(i.name)}</td><td class="num">10%</td><td class="num">${i.qty}</td><td class="num">${yen(i.unitPrice)}</td><td class="num">${yen((Number(i.unitPrice)||0)*(Number(i.qty)||0))}</td></tr>`).join("")
    + (shipFeeIncl>0 ? `<tr><td>${esc(s.shippingLabel||"送料")}</td><td class="num">10%</td><td class="num">1</td><td class="num">${yen(shipExcl)}</td><td class="num">${yen(shipExcl)}</td></tr>` : "");
  return `
    <div class="inv">
      <div class="doc-head"><div></div>
        <div class="issuer-wrap">
          <div class="issuer"><div class="org">${esc(issuerName)}</div>介護情報基盤伴走支援事業<br>${regLine}<br>kjk-staff@tadakayo.jp<br>発行日: ${today}</div>
          <img class="seal-kaku-img" src="${st.poSealImage || "/images/seal-tadakayo.png"}" alt="タダカヨの角印">
        </div></div>
      <h1 class="inv-title">請　求　書</h1>
      <div class="to">${esc(billName)} 御中</div>
      <div class="meta">請求書番号: ${esc(invNo)}　／　対応出荷: ${esc(s.soNumber)}（${esc(s.shipDate||"")}）</div>
      <div class="meta">納品先: ${esc(s.company?s.company+" / ":"")}${esc(s.officeName||"")}</div>
      <p style="margin:16px 0 6px">下記のとおりご請求申し上げます。</p>
      <div class="grand">ご請求金額（税込）　<strong>${yen(total)}</strong></div>
      <table class="items"><thead><tr><th>品名</th><th style="width:56px">税率</th><th style="width:56px">数量</th><th style="width:104px">単価(税抜)</th><th style="width:116px">金額(税抜)</th></tr></thead>
        <tbody>${rows2}</tbody></table>
      <table class="po-sum" style="margin-top:10px"><tbody>
        <tr><td class="lbl">10%対象 小計（税抜）</td><td class="num">${yen(sub)}</td></tr>
        <tr><td class="lbl">消費税額（10%）</td><td class="num">${yen(tax)}</td></tr>
        <tr class="grand"><td class="lbl">合計（税込）</td><td class="num"><strong>${yen(total)}</strong></td></tr>
      </tbody></table>
      <div class="pay">
        <div style="font-weight:700;margin-bottom:4px">お振込先</div>
        ${payInner}
      </div>
      <div class="footer">${esc(issuerName)}　介護情報基盤伴走支援事業${regNo?`　登録番号 ${esc(regNo)}`:""}</div>
    </div>`;
}

// 領収書（請求書と同じ発行元・角印・登録番号。入金済み出荷に対し発行。
//   印影＝設定のpoSealImage、無ければ実際のタダカヨ印影 /images/seal-tadakayo.png を常に表示。
//   内訳＝見積のような編集可能な明細表（伴走支援サポート費など行を追加できる）。）
// 用途区分（助成金: A=カードリーダー / B=接続サポート等経費 / X=対象外）
const RCPT_KINDS=[["A","カードリーダー"],["B","接続サポート等経費"],["X","対象外(送料等)"]];
function rcptRow(r){
  r=r||{};
  const opts=RCPT_KINDS.map(([v,l])=>`<option value="${v}"${(r.kind||"A")===v?" selected":""}>${l}</option>`).join("");
  return `<tr>
      <td class="rcpt-noprint"><select class="ri-kind">${opts}</select></td>
      <td><input class="ri-name" value="${esc(r.name||"")}"></td>
      <td><input class="ri-qty num" type="number" min="0" step="1" value="${Number(r.qty)||0}"></td>
      <td><input class="ri-price num" type="number" min="0" step="1" value="${Number(r.price)||0}"></td>
      <td class="num ri-amt"></td>
      <td class="rcpt-noprint"><button type="button" class="ri-del" aria-label="行を削除"><i class="ti ti-x"></i></button></td>
    </tr>`;
}
function renderReceipt(s, st){
  st = st || {};
  const items=s.items||[];
  // 初期明細＝出荷の商品（A:カードリーダー・型名/用途を明記）＋送料（X:対象外）。あとから編集・行追加できる
  const rowsInit = items.map(i=>({
    kind:"A",
    name: i.sku ? `カードリーダー（型名: ${i.sku}・マイナ資格確認アプリ対応）` : (i.name||"カードリーダー"),
    qty:Number(i.qty)||0, price:Number(i.unitPrice)||0,
  }));
  if(Number(s.shippingFee)>0) rowsInit.push({kind:"X", name:s.shippingLabel||"送料", qty:1, price:Math.round(Number(s.shippingFee)/1.1)});
  const rcptNo=(s.soNumber||"").replace(/^SH/,"RCPT");
  const toName = s.shipType==="dropship" ? (s.partnerName||"") : (s.company||s.officeName||"");
  const issuerName = st.invoiceIssuerName || "NPO法人タダカヨ";
  const regNo = st.invoiceRegNo || "";
  const regLine = regNo
    ? `登録番号: <strong>${esc(regNo)}</strong>`
    : `<span style="color:#b84a4a">登録番号: 未登録（設定で登録してください）</span>`;
  const issueDate = s.paidAt ? esc(s.paidAt) : today;
  const sealSrc = st.poSealImage || "/images/seal-tadakayo.png";
  return `
    <div class="inv">
      <div class="doc-head"><div></div>
        <div class="issuer-wrap">
          <div class="issuer"><div class="org">${esc(issuerName)}</div>介護情報基盤伴走支援事業<br>${regLine}<br>kjk-staff@tadakayo.jp<br>発行日: ${issueDate}</div>
          <img class="seal-kaku-img" src="${sealSrc}" alt="タダカヨの角印">
        </div></div>
      <h1 class="inv-title">領　収　書</h1>
      <div class="to">${esc(toName)} 御中</div>
      <div class="meta">領収書番号: ${esc(rcptNo)}　／　対応出荷: ${esc(s.soNumber)}（${esc(s.shipDate||"")}）</div>
      <div class="grand">領収金額（税込）　<strong id="rcptTotal">¥0</strong></div>
      <p style="margin:14px 0 4px">但　<span id="rcptNoteText">介護情報基盤の導入（カードリーダー・接続サポート等経費）として</span></p>
      <p style="margin:4px 0 12px">上記正に領収いたしました。</p>
      <table class="items rcpt-items"><thead><tr>
        <th class="rcpt-noprint" style="width:150px">用途区分</th>
        <th>品名（型名・用途）</th>
        <th style="width:60px">数量</th>
        <th style="width:104px">単価(税抜)</th>
        <th style="width:116px">金額(税抜)</th>
        <th class="rcpt-noprint" style="width:38px"></th>
      </tr></thead>
        <tbody id="rcptItems">${rowsInit.map(rcptRow).join("")}</tbody></table>
      <div class="rcpt-noprint" style="margin:6px 0 2px"><button type="button" id="rcptAddRow" class="btn btn-secondary" style="font-size:12px;padding:5px 10px"><i class="ti ti-plus"></i> 行を追加</button></div>
      <div style="display:flex;gap:20px;align-items:flex-start">
        <table class="po-sum rcpt-sum" style="flex:1"><thead><tr><th>区分</th><th class="num">税抜</th><th class="num">消費税(10%)</th><th class="num">税込</th></tr></thead>
        <tbody>
          <tr><td class="lbl">カードリーダー費（対象A）</td><td class="num" id="aExcl">¥0</td><td class="num" id="aTax">¥0</td><td class="num" id="aIncl">¥0</td></tr>
          <tr><td class="lbl">接続サポート等経費（対象B）</td><td class="num" id="bExcl">¥0</td><td class="num" id="bTax">¥0</td><td class="num" id="bIncl">¥0</td></tr>
          <tr id="xRow" style="display:none"><td class="lbl">対象外（送料等）</td><td class="num" id="xExcl">¥0</td><td class="num" id="xTax">¥0</td><td class="num" id="xIncl">¥0</td></tr>
          <tr class="grand"><td class="lbl">合計（税込）</td><td class="num"></td><td class="num"></td><td class="num"><strong id="rcptGrand">¥0</strong></td></tr>
        </tbody></table>
        <div id="rcptStamp" style="display:none;border:1px solid var(--muted);width:120px;height:80px;align-items:center;justify-content:center;text-align:center;font-size:11px;color:var(--muted)">収入印紙<br>（5万円以上を紙で<br>発行する場合に貼付）</div>
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:8px">※ 助成金の申請額は「カードリーダー費（対象A・税込）」＋「接続サポート等経費（対象B・税込）」です（対象外の送料等は申請対象に含みません）。カードリーダーはマイナ資格確認アプリ対応品です。</p>
      <div class="footer">${esc(issuerName)}　介護情報基盤伴走支援事業${regNo?`　登録番号 ${esc(regNo)}`:""}</div>
    </div>`;
}

// 領収書の明細表を編集可能にし、用途区分A/B/対象外ごとの税込小計・領収金額・収入印紙欄を自動再計算する
function wireReceiptEditor(){
  const tbody=document.getElementById("rcptItems"); if(!tbody) return;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=yen(v); };
  const incl=e=>e+Math.floor(e*0.1), taxOf=e=>Math.floor(e*0.1);
  function recompute(){
    const sub={A:0,B:0,X:0};
    tbody.querySelectorAll("tr").forEach(tr=>{
      const k=tr.querySelector(".ri-kind")?.value||"A";
      const q=Number(tr.querySelector(".ri-qty")?.value)||0;
      const p=Number(tr.querySelector(".ri-price")?.value)||0;
      const amt=q*p; sub[k]=(sub[k]||0)+amt;
      const cell=tr.querySelector(".ri-amt"); if(cell) cell.textContent=yen(amt);
    });
    set("aExcl",sub.A); set("aTax",taxOf(sub.A)); set("aIncl",incl(sub.A));
    set("bExcl",sub.B); set("bTax",taxOf(sub.B)); set("bIncl",incl(sub.B));
    const xRow=document.getElementById("xRow"); if(xRow) xRow.style.display = sub.X>0 ? "" : "none";
    set("xExcl",sub.X); set("xTax",taxOf(sub.X)); set("xIncl",incl(sub.X));
    const total=incl(sub.A)+incl(sub.B)+incl(sub.X);
    set("rcptGrand",total); set("rcptTotal",total);
    const stamp=document.getElementById("rcptStamp"); if(stamp) stamp.style.display = total>=50000 ? "flex" : "none";
  }
  tbody.addEventListener("input", recompute);
  tbody.addEventListener("change", recompute);
  tbody.addEventListener("click", e=>{ const b=e.target.closest(".ri-del"); if(b){ b.closest("tr").remove(); recompute(); } });
  const add=document.getElementById("rcptAddRow");
  if(add) add.addEventListener("click", ()=>{
    tbody.insertAdjacentHTML("beforeend", rcptRow({kind:"B",name:"",qty:1,price:0}));
    recompute();
    const last=tbody.querySelector("tr:last-child .ri-name"); if(last) last.focus();
  });
  recompute();
}

const TITLES={po:"発注書 ",ship:"送付状 ",letterpack:"宛名 ",plabel:"宛名 ",invoice:"請求書 ",receipt:"領収書 "};
onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user))) return;
  document.getElementById("printBtn").addEventListener("click",()=>{ try{ document.activeElement&&document.activeElement.blur(); }catch(_){} window.print(); });
  // 「供給管理へ」の戻り先を、この帳票を開いた元タブにする（一覧へ戻す）
  const backTab = { po:"orders", invoice:"shipments", receipt:"shipments", ship:"shipments", letterpack:"shipments", plabel:"partners" }[type];
  const backBtn = document.querySelector(".btn-back");
  if (backBtn && backTab) backBtn.href = `/supply.html?tab=${backTab}`;
  const docId = type==="plabel" ? params.get("pid") : id;
  if(!type||!docId){ document.getElementById("loadingEl").textContent="パラメータが不正です"; return; }
  try{
    const col = type==="po"?"purchaseOrders" : type==="plabel"?"partners" : "shipments";
    const snap = await getDoc(doc(db,col,docId));
    if(!snap.exists()){ document.getElementById("loadingEl").textContent="データが見つかりません"; return; }
    const d=snap.data();
    document.getElementById("loadingEl").style.display="none";
    document.getElementById("body").style.display="block";
    document.title = (TITLES[type]||"")+(d.poNumber||d.soNumber||"");

    if(type==="letterpack" || type==="plabel"){
      // plabel=認定事業所宛（partners/{pid}）／letterpack=出荷のお届け先
      let toObj = d;
      if(type==="plabel"){
        toObj = { company:d.corpName||"", officeName:d.partnerName||"", postal:d.postal||"", address:d.address||"", phone:d.phone||"" };
      }
      let settings={}; try{ const ss=await getDoc(doc(db,"appConfig","settings")); settings=ss.exists()?ss.data():{}; }catch(_){}
      let senders = Array.isArray(settings.senders)?settings.senders:[];
      if(!senders.length && settings.senderName) senders=[{name:settings.senderName,postal:settings.senderPostal||"",address:settings.senderAddress||"",phone:settings.senderPhone||""}];
      const ctrl=document.getElementById("lpControls"); ctrl.style.display="flex";
      const selS=document.getElementById("lpSender");
      selS.innerHTML = senders.length
        ? senders.map((s,i)=>`<option value="${i}">${(s.name||"(無名)").replace(/</g,"&lt;")}</option>`).join("")
        : `<option value="-1">（設定で差出人を登録してください）</option>`;
      const draw=()=>{
        const v=document.getElementById("lpVariant").value;
        const idx=parseInt(selS.value,10);
        document.getElementById("body").innerHTML = renderLetterpack(toObj, senders[idx]||{}, v);
      };
      document.getElementById("lpVariant").addEventListener("change",draw);
      selS.addEventListener("change",draw);
      draw();
      return;
    }

    if(type==="po" || type==="invoice" || type==="receipt"){
      let settings={}; try{ const ss=await getDoc(doc(db,"appConfig","settings")); settings=ss.exists()?ss.data():{}; }catch(_){}
      document.getElementById("body").innerHTML =
        type==="po" ? renderPO(d, settings)
        : type==="invoice" ? renderInvoice(d, settings)
        : renderReceipt(d, settings);
      // 領収書: 明細表を編集可能に（行追加で伴走支援サポート費など見積内容を記載）＋但し書き編集
      if(type==="receipt"){
        wireReceiptEditor();
        const out=document.getElementById("rcptNoteText");
        const ctrl=document.getElementById("rcptControls");
        const inp=document.getElementById("rcptNote");
        if(out && ctrl && inp){
          ctrl.style.display="flex";
          inp.value = out.textContent;
          inp.addEventListener("input", ()=>{ out.textContent = inp.value; });
        }
      }
      return;
    }
    document.getElementById("body").innerHTML = renderShip(d);
  }catch(e){ document.getElementById("loadingEl").textContent=`読み込み失敗: ${e.message}`; }
});
