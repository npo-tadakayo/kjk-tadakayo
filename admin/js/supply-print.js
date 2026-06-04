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

function renderPO(o){
  const rows=(o.items||[]).map(i=>`<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${yen(i.unitPrice)}</td><td class="num">${yen(i.qty*i.unitPrice)}</td></tr>`).join("");
  return `
    <div class="doc-head"><div></div>
      <div class="issuer"><div class="org">NPO法人タダカヨ</div>介護情報基盤伴走支援事業<br>発行日: ${today}</div></div>
    <h1 class="title">発　注　書</h1>
    <div class="to">${esc(o.supplier||"AB Circle Japan 株式会社")} 御中</div>
    <div class="meta">発注番号: ${esc(o.poNumber)}　／　発注日: ${esc(o.orderDate||"")}</div>
    <p style="margin-top:16px">下記のとおり発注いたします。</p>
    <table class="items"><thead><tr><th>品番</th><th>商品名</th><th style="width:60px">数量</th><th style="width:110px">単価(税別)</th><th style="width:120px">金額(税別)</th></tr></thead>
      <tbody>${rows}
        <tr class="total-row"><td colspan="4" class="num">合計（税別）</td><td class="num">${yen(o.total)}</td></tr>
      </tbody></table>
    ${o.note?`<div class="note">備考: ${esc(o.note)}</div>`:""}
    <div class="footer">NPO法人タダカヨ　介護情報基盤伴走支援事業　／　本書はCRMにより自動生成されました。</div>`;
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

// レターパックプラス(赤) 宛名面（お届け先）。実封筒に合わせて余白調整が必要な場合あり
function zipBoxes(postal){
  const d=(postal||"").replace(/[^0-9]/g,"").padEnd(7," ").slice(0,7).split("");
  return `<span class="zip">${d.map(n=>`<span class="zbox">${n.trim()||"&nbsp;"}</span>`).join("")}</span>`;
}
function renderLetterpack(s){
  return `
    <div class="lp">
      <div class="lp-title">レターパック宛名（お届け先）</div>
      <div class="lp-block">
        <div class="lp-zip">〒 ${zipBoxes(s.postal)}</div>
        <div class="lp-addr">${esc(s.address||"")}</div>
        <div class="lp-name">${esc(s.company?s.company+" ":"")}${esc(s.officeName||"")}　御中</div>
        ${s.contactName?`<div class="lp-sub">${esc(s.contactName)} 様</div>`:""}
        ${s.phone?`<div class="lp-sub">TEL ${esc(s.phone)}</div>`:""}
        <div class="lp-sub">品名: 介護情報基盤 カードリーダー</div>
      </div>
      <div class="lp-from">
        <div style="font-size:12px;color:var(--muted)">ご依頼主</div>
        NPO法人タダカヨ（介護情報基盤伴走支援事業）<br>
        お問い合わせ: kjk-staff@tadakayo.jp
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:14px">※ レターパックプラス(赤)の宛名面に合わせています。印刷位置がずれる場合は、印刷ダイアログの余白設定で調整してください。宛名ラベルに印刷して貼り付けることもできます。</p>
    </div>`;
}

// 請求書（見積書の赤系を踏襲・認定事業所向け／卸価格・税別→税込）
function renderInvoice(s){
  const items=s.items||[];
  const sub=items.reduce((a,i)=>a+(Number(i.unitPrice)||0)*(Number(i.qty)||0),0);
  const tax=Math.floor(sub*0.1); const total=sub+tax;
  const rows=items.map(i=>`<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${yen(i.unitPrice)}</td><td class="num">${yen((Number(i.unitPrice)||0)*(Number(i.qty)||0))}</td></tr>`).join("");
  const invNo=(s.soNumber||"").replace(/^SH/,"INV");
  return `
    <div class="inv">
      <div class="doc-head"><div></div>
        <div class="issuer"><div class="org">NPO法人タダカヨ</div>介護情報基盤伴走支援事業<br>kjk-staff@tadakayo.jp<br>発行日: ${today}</div></div>
      <h1 class="inv-title">請　求　書</h1>
      <div class="to">${esc(s.partnerName||"")} 御中</div>
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

const TITLES={po:"発注書 ",ship:"送付状 ",letterpack:"宛名 ",invoice:"請求書 "};
onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  document.getElementById("printBtn").addEventListener("click",()=>window.print());
  if(!type||!id){ document.getElementById("loadingEl").textContent="パラメータが不正です"; return; }
  try{
    const col = type==="po"?"purchaseOrders":"shipments";
    const snap = await getDoc(doc(db,col,id));
    if(!snap.exists()){ document.getElementById("loadingEl").textContent="データが見つかりません"; return; }
    const d=snap.data();
    const render = {po:renderPO, ship:renderShip, letterpack:renderLetterpack, invoice:renderInvoice}[type] || renderShip;
    document.getElementById("body").innerHTML = render(d);
    document.title = (TITLES[type]||"")+(d.poNumber||d.soNumber||"");
    document.getElementById("loadingEl").style.display="none";
    document.getElementById("body").style.display="block";
  }catch(e){ document.getElementById("loadingEl").textContent=`読み込み失敗: ${e.message}`; }
});
