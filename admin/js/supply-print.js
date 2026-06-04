import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
};
function renderPO(o, st){
  st = st || {};
  const issuerName = st.poIssuerName || PO_DEFAULT.issuerName;
  const issuerAddr = st.poIssuerAddr || PO_DEFAULT.issuerAddr;
  const issuerRep  = st.poIssuerRep  || PO_DEFAULT.issuerRep;
  const items = (o.items||[]).slice();
  // 送料を明細行として追加（あれば）
  const lines = items.map(i=>({ name:i.name, qty:i.qty, unitPrice:Number(i.unitPrice)||0, amount:(Number(i.unitPrice)||0)*(Number(i.qty)||0) }));
  if (Number(o.shippingFee)>0) lines.push({ name:o.shippingLabel||"送料", qty:1, unitPrice:Number(o.shippingFee), amount:Number(o.shippingFee), plain:true });
  const sub = lines.reduce((a,l)=>a+l.amount,0);
  const tax = Math.floor(sub*0.1);
  const total = sub + tax;
  const no = (o.poNo!=null && o.poNo!=="") ? o.poNo : (o.poNumber||"");
  const rows = lines.map(l=>`<tr>
    <td>${esc(l.name)}</td>
    <td class="num">${l.plain?l.qty:l.qty+" 個"}</td>
    <td class="num">${yen(l.unitPrice)}</td>
    <td class="num">${yen(l.amount)}</td></tr>`).join("");
  return `
    <div class="po">
      <h1 class="po-title">発　注　書</h1>
      <div class="po-head">
        <div class="po-to">
          <div class="po-to-name">${esc(o.supplier||"AB Circle Japan 株式会社")}　御中</div>
          <p style="margin:18px 0 0">下記の通り発注申し上げます。</p>
          <div class="po-total"><span>TOTAL</span> <strong>${yen(total)}</strong></div>
        </div>
        <div class="po-issuer">
          <div class="po-no"><span>NO.</span> ${esc(String(no))}</div>
          <div class="po-no"><span>発行日</span> ${esc(o.orderDate||"")}</div>
          <div class="po-org">${esc(issuerName)}</div>
          <div>${esc(PO_DEFAULT.issuerAddrLabel)}</div>
          <div>${esc(issuerAddr)}</div>
          <div>${esc(issuerRep)}</div>
          ${o.shipTo?`<div style="margin-top:10px">送付先：</div><div style="white-space:pre-line">${esc(o.shipTo)}</div>`:""}
        </div>
      </div>
      <table class="po-items"><thead><tr><th>品名</th><th class="num" style="width:64px">数量</th><th class="num" style="width:110px">単価</th><th class="num" style="width:120px">金額</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <table class="po-sum"><tbody>
        <tr><td class="lbl">小計</td><td class="num">${yen(sub)}</td></tr>
        <tr><td class="lbl">消費税 10%</td><td class="num">${yen(tax)}</td></tr>
        <tr class="grand"><td class="lbl">合計</td><td class="num"><strong>${yen(total)}</strong></td></tr>
      </tbody></table>
      ${o.note?`<div class="po-note">${esc(o.note)}</div>`:`<div class="po-note">※100台未満のご注文の場合、別途輸送費を申し受けます。</div>`}
    </div>`;
}

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
  const price = isLight ? "370円" : "520円";
  const colorName = isLight ? "青" : "赤";
  const fromName = sender.name || "";
  const fromPostal = sender.postal || "";
  const fromAddr = sender.address || "";
  const fromPhone = sender.phone || "";
  const toName = `${esc(s.company?s.company+"　":"")}${esc(s.officeName||"")}`;
  return `
    <div class="lp-note">切り取り線（- - -）で切り、${brandName}（${colorName}）の宛名面に貼り付けてご利用ください。</div>
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
function renderInvoice(s){
  const items=s.items||[];
  const sub=items.reduce((a,i)=>a+(Number(i.unitPrice)||0)*(Number(i.qty)||0),0);
  const tax=Math.floor(sub*0.1); const total=sub+tax;
  const rows=items.map(i=>`<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${yen(i.unitPrice)}</td><td class="num">${yen((Number(i.unitPrice)||0)*(Number(i.qty)||0))}</td></tr>`).join("");
  const invNo=(s.soNumber||"").replace(/^SH/,"INV");
  const billName = s.shipType==="dropship" ? (s.partnerName||"") : (s.company||s.officeName||"");
  return `
    <div class="inv">
      <div class="doc-head"><div></div>
        <div class="issuer"><div class="org">NPO法人タダカヨ</div>介護情報基盤伴走支援事業<br>kjk-staff@tadakayo.jp<br>発行日: ${today}</div></div>
      <h1 class="inv-title">請　求　書</h1>
      <div class="to">${esc(billName)} 御中</div>
      <div class="meta">請求書番号: ${esc(invNo)}　／　対応出荷: ${esc(s.soNumber)}（${esc(s.shipDate||"")}）</div>
      <div class="meta">納品先: ${esc(s.company?s.company+" / ":"")}${esc(s.officeName||"")}</div>
      <p style="margin:16px 0 6px">下記のとおりご請求申し上げます。</p>
      <div class="grand">ご請求金額（税込）　<strong>${yen(total)}</strong></div>
      <table class="items"><thead><tr><th>品名</th><th style="width:60px">数量</th><th style="width:110px">単価(税別)</th><th style="width:120px">金額(税別)</th></tr></thead>
        <tbody>${rows}
          <tr><td colspan="3" class="num">小計（税別）</td><td class="num">${yen(sub)}</td></tr>
          <tr><td colspan="3" class="num">消費税（10%）</td><td class="num">${yen(tax)}</td></tr>
          <tr class="total-row"><td colspan="3" class="num">合計（税込）</td><td class="num">${yen(total)}</td></tr>
        </tbody></table>
      <div class="pay">
        <div style="font-weight:700;margin-bottom:4px">お振込先</div>
        <div style="font-size:12px;color:var(--muted)">※ 振込先口座は別途ご案内します（設定でテンプレート化予定）。お支払期限: 請求書発行月の翌月末。</div>
      </div>
      <div class="footer">NPO法人タダカヨ　介護情報基盤伴走支援事業</div>
    </div>`;
}

const TITLES={po:"発注書 ",ship:"送付状 ",letterpack:"宛名 ",plabel:"宛名 ",invoice:"請求書 "};
onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  document.getElementById("printBtn").addEventListener("click",()=>window.print());
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

    if(type==="po"){
      let settings={}; try{ const ss=await getDoc(doc(db,"appConfig","settings")); settings=ss.exists()?ss.data():{}; }catch(_){}
      document.getElementById("body").innerHTML = renderPO(d, settings);
      return;
    }
    const render = {ship:renderShip, invoice:renderInvoice}[type] || renderShip;
    document.getElementById("body").innerHTML = render(d);
  }catch(e){ document.getElementById("loadingEl").textContent=`読み込み失敗: ${e.message}`; }
});
