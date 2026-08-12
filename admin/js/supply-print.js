import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole } from "/js/role.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderPOHtml } from "/js/po-doc.js";
import { renderInvoiceHtml } from "/js/invoice-doc.js";

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

// 請求書の描画は invoice-doc.js の renderInvoiceHtml に統合（経理報告のPDF生成と共通化）
function renderInvoice(s, st){ return renderInvoiceHtml(s, st, { issueDate: today }); }

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
function renderReceipt(s, st, saved){
  st = st || {};
  const items=s.items||[];
  // 明細: 発行を記録済みならその内容を復元（同じ領収書を再発行できる）。無ければ出荷から組み立てる
  let rowsInit;
  if(saved && Array.isArray(saved.items) && saved.items.length){
    rowsInit = saved.items.map(r=>({ kind:r.usage||"A", name:r.name||"", qty:Number(r.qty)||0, price:Number(r.unitPrice)||0 }));
  }else{
    // 初期明細＝出荷の商品（A:カードリーダー・型名/用途を明記）＋送料（X:対象外）。あとから編集・行追加できる
    rowsInit = items.map(i=>({
      kind:"A",
      name: i.sku ? `カードリーダー（型名: ${i.sku}・マイナ資格確認アプリ対応）` : (i.name||"カードリーダー"),
      qty:Number(i.qty)||0, price:Number(i.unitPrice)||0,
    }));
    if(Number(s.shippingFee)>0) rowsInit.push({kind:"X", name:s.shippingLabel||"送料", qty:1, price:Number(s.shippingFee)}); // 税抜で保存（2026-07-28 統一）
  }
  const rcptNo=(s.soNumber||"").replace(/^SH/,"RCPT");
  const toName = s.shipType==="dropship" ? (s.partnerName||"") : (s.company||s.officeName||"");
  const issuerName = st.invoiceIssuerName || "NPO法人タダカヨ";
  const regNo = st.invoiceRegNo || "";
  const regLine = regNo
    ? `登録番号: <strong>${esc(regNo)}</strong>`
    : `<span style="color:#b84a4a">登録番号: 未登録（設定で登録してください）</span>`;
  // 発行日: 記録済みならその発行日（再発行しても同じ日付）→ 入金日 → 今日
  const issueDate = saved?.issuedAt ? esc(saved.issuedAt) : (s.paidAt ? esc(s.paidAt) : today);
  // 領収金額（2026-08-12 変更）: 明細合計の従属値ではなく「実際に受け取った額」を初期値にする。
  // 純入金（入金−返金）と請求額（充当後）の小さい方＝過入金は領収額に含めない・一部入金はその額で内金として出す。
  const net = netPaidOf(s), billable = billableInclOf(s);
  const autoAmount = Math.max(0, Math.min(net, billable));
  const initAmount = Number(saved?.amountIncl)>0 ? Number(saved.amountIncl) : autoAmount;
  const isPartial = autoAmount>0 && autoAmount<billable;
  const overpay = Math.max(0, net-billable);
  const noteText = saved?.note || (isPartial
    ? "介護情報基盤の導入（カードリーダー・接続サポート等経費）の内金として"
    : "介護情報基盤の導入（カードリーダー・接続サポート等経費）として");
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
      <div class="grand">領収金額（税込）　<strong id="rcptTotal">${yen(initAmount)}</strong></div>
      <!-- 実入金との突き合わせ。画面だけの案内で印刷には出さない -->
      <div class="rcpt-noprint" id="rcptPayInfo" style="font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.8">
        入金合計 ${yen(payListOf(s).reduce((a,p)=>a+(Number(p.amount)||0),0))}
        ${(Array.isArray(s.refunds)?s.refunds:[]).length?`／返金 −${yen((s.refunds||[]).reduce((a,r)=>a+(Number(r.amount)||0),0))}`:""}
        ／純入金 <strong>${yen(net)}</strong>　／　請求額（充当後）${yen(billable)}
        ${Number(s.creditApplied)>0?`（過入金の充当 −${yen(Number(s.creditApplied))} 済み）`:""}
        <br>領収金額は実入金から自動で入れています（純入金と請求額の小さい方）。必要なら下の入力欄で直せます。
        ${isPartial?`<br><strong style="color:#c87a1f">一部入金のため「内金として」で発行します（請求額との差 ${yen(billable-autoAmount)}）</strong>`:""}
        ${overpay>0?`<br><strong style="color:#c87a1f">過入金 ${yen(overpay)} は領収金額に含めていません（次回請求への充当または返金の対象）</strong>`:""}
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
          <label for="rcptAmountInput">領収金額（税込・円）</label>
          <input id="rcptAmountInput" type="number" min="0" step="1" value="${initAmount}"
                 data-credit="${Number(s.creditApplied)||0}" data-billable="${billable}"
                 style="width:140px;padding:8px;min-height:40px;border:1px solid var(--line);border-radius:6px">
          <button type="button" id="rcptAmountAuto" class="btn btn-secondary" data-v="${autoAmount}" style="font-size:12px;padding:6px 10px">実入金に戻す（${yen(autoAmount)}）</button>
          <button type="button" id="rcptAmountItems" class="btn btn-secondary" style="font-size:12px;padding:6px 10px">明細合計に合わせる</button>
          <span id="rcptDiffInfo"></span>
        </div>
      </div>
      <p style="margin:14px 0 4px">但　<span id="rcptNoteText">${esc(noteText)}</span></p>
      <p style="margin:4px 0 12px">上記正に領収いたしました。</p>
      <!-- 明細合計と領収金額がずれる理由（過入金の充当・内金）は書面にも印字する -->
      <p id="rcptAdjNote" style="margin:0 0 10px;font-size:12px;color:var(--muted)"></p>
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
          <tr class="grand"><td class="lbl">明細合計（税込）</td><td class="num"></td><td class="num"></td><td class="num"><strong id="rcptGrand">¥0</strong></td></tr>
        </tbody></table>
        <div id="rcptStamp" style="display:none;border:1px solid var(--muted);width:120px;height:80px;align-items:center;justify-content:center;text-align:center;font-size:11px;color:var(--muted)">収入印紙<br>（5万円以上を紙で<br>発行する場合に貼付）</div>
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:8px">※ 助成金の申請額は「カードリーダー費（対象A・税込）」＋「接続サポート等経費（対象B・税込）」です（対象外の送料等は申請対象に含みません）。カードリーダーはマイナ資格確認アプリ対応品です。</p>
      <div class="footer">${esc(issuerName)}　介護情報基盤伴走支援事業${regNo?`　登録番号 ${esc(regNo)}`:""}</div>
    </div>`;
}

// ===== 返金明細書（2026-08-12 追加）=====
// 過入金の返金・返品やキャンセルに伴う返金の「相手に渡す証憑」。
// 領収書と違い当方が支払う側の書面なので、金額の内訳（請求額・入金額・返金額）を並べて経緯が追えるようにする。
function renderRefundStatement(s, st){
  st = st || {};
  const refunds = Array.isArray(s.refunds) ? s.refunds : [];
  const paid = payListOf(s).reduce((a,p)=>a+(Number(p.amount)||0),0);
  const refundTotal = refunds.reduce((a,r)=>a+(Number(r.amount)||0),0);
  const billable = billableInclOf(s);
  const stNo = (s.soNumber||"").replace(/^SH/,"RFND");
  const toName = s.shipType==="dropship" ? (s.partnerName||"") : (s.company||s.officeName||"");
  const issuerName = st.invoiceIssuerName || "NPO法人タダカヨ";
  const regNo = st.invoiceRegNo || "";
  const issueDate = s.refundStatementIssuedAt ? esc(s.refundStatementIssuedAt) : today;
  const lastDate = refunds.length ? (refunds[refunds.length-1].date||"") : "";
  const rows = refunds.map(r=>`<tr>
      <td>${esc(r.date||"")}</td>
      <td>${esc(r.method||"振込")}</td>
      <td>${esc(r.note||"")}</td>
      <td class="num">${yen(Number(r.amount)||0)}</td>
    </tr>`).join("");
  return `
    <div class="inv">
      <div class="doc-head"><div></div>
        <div class="issuer-wrap">
          <div class="issuer"><div class="org">${esc(issuerName)}</div>介護情報基盤伴走支援事業<br>${regNo?`登録番号: <strong>${esc(regNo)}</strong>`:""}<br>kjk-staff@tadakayo.jp<br>発行日: ${issueDate}</div>
          <img class="seal-kaku-img" src="${st.poSealImage || "/images/seal-tadakayo.png"}" alt="タダカヨの角印">
        </div></div>
      <h1 class="inv-title">返 金 明 細 書</h1>
      <div class="to">${esc(toName)} 御中</div>
      <div class="meta">返金明細書番号: ${esc(stNo)}　／　対応出荷: ${esc(s.soNumber)}（${esc(s.shipDate||"")}）　／　請求書番号: ${esc((s.soNumber||"").replace(/^SH/,"INV"))}</div>
      <p style="margin:16px 0 6px">下記のとおりご返金いたしましたので、ご連絡申し上げます。</p>
      <div class="grand">返金金額（税込）　<strong>${yen(refundTotal)}</strong></div>
      <table class="items" style="margin-top:10px"><thead><tr>
        <th style="width:120px">返金日</th><th style="width:110px">返金方法</th><th>摘要</th><th style="width:130px">金額（税込）</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="4">返金の記録がありません</td></tr>`}</tbody></table>
      <table class="po-sum" style="margin-top:10px"><tbody>
        <tr><td class="lbl">ご請求金額（税込）</td><td class="num">${yen(billable)}</td></tr>
        <tr><td class="lbl">ご入金額（税込・合計）</td><td class="num">${yen(paid)}</td></tr>
        <tr><td class="lbl">返金額（税込・合計）</td><td class="num">−${yen(refundTotal)}</td></tr>
        <tr class="grand"><td class="lbl">差引後のご入金額（税込）</td><td class="num"><strong>${yen(paid-refundTotal)}</strong></td></tr>
      </tbody></table>
      <p style="font-size:12px;color:var(--muted);margin-top:10px">※ 本書は当方からのご返金の明細です（領収書ではありません）。${lastDate?`最終の返金日は ${esc(lastDate)} です。`:""}お振込の場合、着金までお時間をいただくことがあります。</p>
      <div class="footer">${esc(issuerName)}　介護情報基盤伴走支援事業${regNo?`　登録番号 ${esc(regNo)}`:""}　／　お問い合わせ: kjk-staff@tadakayo.jp</div>
    </div>`;
}
// 返金明細書の発行記録（誰にいつ何円の明細を出したかを出荷側に残す）
async function saveRefundStatementIssue(s, shipmentId, userEmail){
  const btn=document.getElementById("rfSaveBtn");
  const info=document.getElementById("rfSaveInfo");
  const refunds = Array.isArray(s.refunds)?s.refunds:[];
  const amount = refunds.reduce((a,r)=>a+(Number(r.amount)||0),0);
  if(!(amount>0)){ if(info) info.textContent="返金の記録がありません"; return; }
  const no=(s.soNumber||"").replace(/^SH/,"RFND");
  const issuedAt=new Date().toISOString().slice(0,10);
  btn.disabled=true;
  try{
    await updateDoc(doc(db,"shipments",shipmentId),{
      refundStatementNo:no, refundStatementIssuedAt:issuedAt, refundStatementIssuedBy:userEmail,
      refundStatementAmount:amount, updatedAt:serverTimestamp(),
    });
    if(info) info.textContent=`発行を記録しました（${no}・${issuedAt}・${yen(amount)}）`;
    btn.innerHTML='<i class="ti ti-device-floppy"></i> 記録を更新';
  }catch(e){ if(info) info.textContent=`記録に失敗: ${e.message}`; }
  finally{ btn.disabled=false; }
}

// 入金・返金・充当の共通計算（supply.js と同じ考え方。帳票側でも実入金を扱うため最小限だけ持つ）
function payListOf(s){
  if(Array.isArray(s.payments) && s.payments.length) return s.payments;
  if(Number(s.paymentAmount)>0) return [{ amount:Number(s.paymentAmount), date:s.paidAt||"" }];
  return [];
}
function netPaidOf(s){
  const paid=payListOf(s).reduce((a,p)=>a+(Number(p.amount)||0),0);
  const ref=(Array.isArray(s.refunds)?s.refunds:[]).reduce((a,r)=>a+(Number(r.amount)||0),0);
  return paid-ref;
}
// 請求額（税込・過入金の充当後）＝相手に実際に支払ってもらう額
function billableInclOf(s){
  const goods=(s.items||[]).reduce((a,i)=>a+(Number(i.unitPrice)||0)*(Number(i.qty)||0),0);
  const sub=goods+(Number(s.shippingFee)||0);
  const incl=sub+Math.floor(sub*0.1);
  return Math.max(0, incl-(Number(s.creditApplied)||0));
}

// 領収書の明細表を編集可能にし、用途区分A/B/対象外ごとの税込小計・領収金額・収入印紙欄を自動再計算する
function wireReceiptEditor(){
  const tbody=document.getElementById("rcptItems"); if(!tbody) return;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=yen(v); };
  const incl=e=>e+Math.floor(e*0.1), taxOf=e=>Math.floor(e*0.1);
  const amtInput=document.getElementById("rcptAmountInput");
  let itemsTotal=0;
  // 領収金額は明細合計と別建て（実入金を初期値にしている）。ズレは画面上で知らせる
  function syncAmount(){
    const v=Math.max(0, Number(amtInput?.value)||0);
    set("rcptTotal", v);
    const diff=v-itemsTotal;
    const info=document.getElementById("rcptDiffInfo");
    if(info) info.innerHTML = diff===0
      ? `<span style="color:#5a8a3a">明細合計と一致</span>`
      : `<strong style="color:#c87a1f">明細合計との差 ${diff>0?"+":"−"}${yen(Math.abs(diff))}</strong>`;
    // 書面に出す注記: 不足分は「過入金の充当」→ 残りは「内金」の順で説明する
    const note=document.getElementById("rcptAdjNote");
    if(note){
      const credit=Number(amtInput?.dataset.credit)||0;
      const short=itemsTotal-v;
      const parts=[];
      if(short>0 && credit>0) parts.push(`上記明細のうち ${yen(Math.min(short,credit))} は、過入金のお預かり分を充当させていただきました。`);
      const rest=short-Math.min(Math.max(short,0),credit);
      if(rest>0) parts.push(`今回のご入金分を内金として領収いたしました（残額 ${yen(rest)}）。`);
      if(short<0) parts.push(`領収金額が明細合計を上回っています（差 ${yen(-short)}）。明細をご確認ください。`);
      note.textContent = parts.length ? "※ "+parts.join(" ") : "";
    }
    const stamp=document.getElementById("rcptStamp"); if(stamp) stamp.style.display = v>=50000 ? "flex" : "none";
  }
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
    itemsTotal=incl(sub.A)+incl(sub.B)+incl(sub.X);
    set("rcptGrand",itemsTotal);
    syncAmount();
  }
  if(amtInput){
    amtInput.addEventListener("input", syncAmount);
    const auto=document.getElementById("rcptAmountAuto");
    const toItems=document.getElementById("rcptAmountItems");
    if(auto) auto.addEventListener("click", ()=>{ amtInput.value=String(auto.dataset.v||amtInput.dataset.auto||0); syncAmount(); });
    if(toItems) toItems.addEventListener("click", ()=>{ amtInput.value=String(itemsTotal); syncAmount(); });
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

// 領収書の発行記録: 画面の明細・但し書き・用途区分の集計を receipts/{出荷ID} にスナップショット保存し、
// 出荷側にも発行日を書き戻す（誰にいつ何を発行したか後から確認でき、再発行も同じ内容で出せる）
function collectReceiptSnapshot(){
  const tbody=document.getElementById("rcptItems");
  const num=(t)=>Number(String(t||"").replace(/[^0-9-]/g,""))||0;
  const items=[...(tbody?tbody.querySelectorAll("tr"):[])].map(tr=>({
    usage: tr.querySelector(".ri-kind")?.value||"A",
    name: tr.querySelector(".ri-name")?.value||"",
    qty: Number(tr.querySelector(".ri-qty")?.value)||0,
    unitPrice: Number(tr.querySelector(".ri-price")?.value)||0,
  })).filter(r=>r.name||r.qty);
  return {
    items,
    usageTotalsIncl: {
      A: num(document.getElementById("aIncl")?.textContent),
      B: num(document.getElementById("bIncl")?.textContent),
      X: num(document.getElementById("xIncl")?.textContent),
    },
    // 領収金額は明細合計ではなく画面の領収金額（実入金を初期値にした値）を保存する
    amountIncl: Number(document.getElementById("rcptAmountInput")?.value)||num(document.getElementById("rcptTotal")?.textContent),
    itemsTotalIncl: num(document.getElementById("rcptGrand")?.textContent),
    note: document.getElementById("rcptNoteText")?.textContent || "",
  };
}
async function saveReceiptIssue(s, shipmentId, userEmail){
  const btn=document.getElementById("rcptSaveBtn");
  const info=document.getElementById("rcptSaveInfo");
  const snap=collectReceiptSnapshot();
  if(!(snap.amountIncl>0)){ info.textContent="金額が0円です（明細を入力してください）"; return; }
  const rcptNo=(s.soNumber||"").replace(/^SH/,"RCPT");
  const issuedAt=new Date().toISOString().slice(0,10);
  btn.disabled=true;
  try{
    await setDoc(doc(db,"receipts",shipmentId),{
      receiptNo, shipmentId, soNumber:s.soNumber||"",
      billToName: s.shipType==="dropship" ? (s.partnerName||"") : (s.company||s.officeName||""),
      billToEmail: s.partnerEmail||"",
      // 実入金との関係も残す（あとで「なぜこの金額で出したか」を追えるようにする）
      netPaid: netPaidOf(s), billableIncl: billableInclOf(s),
      isPartial: snap.amountIncl < billableInclOf(s),
      ...snap, issuedAt, issuedBy:userEmail, updatedAt:serverTimestamp(),
    },{merge:true});
    await updateDoc(doc(db,"shipments",shipmentId),{
      receiptNo, receiptIssuedAt:issuedAt, receiptIssuedBy:userEmail,
      receiptAmountIncl:snap.amountIncl, updatedAt:serverTimestamp(),
    });
    info.textContent=`発行を記録しました（${rcptNo}・${issuedAt}・${yen(snap.amountIncl)}）`;
    btn.innerHTML='<i class="ti ti-device-floppy"></i> 記録を更新';
  }catch(e){ info.textContent=`記録に失敗: ${e.message}`; }
  finally{ btn.disabled=false; }
}

const TITLES={po:"発注書 ",ship:"送付状 ",letterpack:"宛名 ",plabel:"宛名 ",invoice:"請求書 ",receipt:"領収書 ",refund:"返金明細書 "};
onAuthStateChanged(auth, async (user)=>{
  if(!user || !user.email?.endsWith("@tadakayo.jp")){ location.href="/index.html"; return; }
  if(!(await gateRole(db,user))) return;
  document.getElementById("printBtn").addEventListener("click",()=>{ try{ document.activeElement&&document.activeElement.blur(); }catch(_){} window.print(); });
  // 「供給管理へ」の戻り先を、この帳票を開いた元タブにする（一覧へ戻す）
  const backTab = { po:"orders", invoice:"shipments", receipt:"shipments", refund:"shipments", ship:"shipments", letterpack:"shipments", plabel:"partners" }[type];
  const backBtn = document.querySelector(".btn-back");
  if (backBtn && backTab) backBtn.href = `/supply.html?tab=${backTab}`;
  const docId = type==="plabel" ? params.get("pid") : id;
  if(!type||!docId){ document.getElementById("loadingEl").textContent="パラメータが不正です"; return; }
  try{
    const col = type==="po"?"purchaseOrders" : type==="plabel"?"partners" : "shipments";
    // 返金明細書はデータの持ち主が shipments なので col はそのまま
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

    if(type==="po" || type==="invoice" || type==="receipt" || type==="refund"){
      let settings={}; try{ const ss=await getDoc(doc(db,"appConfig","settings")); settings=ss.exists()?ss.data():{}; }catch(_){}
      // 領収書: 発行を記録済みなら保存内容（明細・但し書き・発行日）を復元して同じものを再発行できるようにする
      let savedReceipt=null;
      if(type==="receipt"){
        try{ const rs=await getDoc(doc(db,"receipts",docId)); if(rs.exists()) savedReceipt=rs.data(); }catch(_){}
      }
      document.getElementById("body").innerHTML =
        type==="po" ? renderPO(d, settings)
        : type==="invoice" ? renderInvoice(d, settings)
        : type==="refund" ? renderRefundStatement(d, settings)
        : renderReceipt(d, settings, savedReceipt);
      // 返金明細書: 発行記録のボタンを出す（返金がある出荷のみ意味を持つ）
      if(type==="refund"){
        const ctrl=document.getElementById("rfControls");
        const btn=document.getElementById("rfSaveBtn");
        const info=document.getElementById("rfSaveInfo");
        if(ctrl) ctrl.style.display="flex";
        if(btn){
          if(d.refundStatementIssuedAt){
            btn.innerHTML='<i class="ti ti-device-floppy"></i> 記録を更新';
            if(info) info.textContent=`発行済 ${d.refundStatementIssuedAt}（${d.refundStatementNo||""}）`;
          }
          btn.addEventListener("click",()=>saveRefundStatementIssue(d, docId, user.email));
        }
        return;
      }
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
        // 発行記録（receipts コレクション）。既に発行済みなら日付を出して「記録を更新」に
        const saveBtn=document.getElementById("rcptSaveBtn");
        const saveInfo=document.getElementById("rcptSaveInfo");
        if(saveBtn){
          if(d.receiptIssuedAt){
            saveBtn.innerHTML='<i class="ti ti-device-floppy"></i> 記録を更新';
            if(saveInfo) saveInfo.textContent=`発行済 ${d.receiptIssuedAt}（${d.receiptNo||""}）`;
          }
          saveBtn.addEventListener("click",()=>saveReceiptIssue(d, docId, user.email));
        }
      }
      return;
    }
    document.getElementById("body").innerHTML = renderShip(d);
  }catch(e){ document.getElementById("loadingEl").textContent=`読み込み失敗: ${e.message}`; }
});
