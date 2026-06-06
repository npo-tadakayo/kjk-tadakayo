// 発注書（PO）の描画を supply-print（印刷ページ）と確定プレビュー（供給管理）で共有する共通モジュール。
// CSS は supply-print.html の <style> 内 .po-* と内容を一致させること（あちらは請求書等と同居のため別管理）。
export const PO_DEFAULT = {
  issuerName: "NPO法人タダカヨ",
  issuerAddrLabel: "事務所所在地：",
  issuerAddr: "東京都大田区大森中二丁目1番20-1001号",
  issuerRep: "理事長：佐藤 拡史",
  ordererName: "次田 芳尚",
  sealText: "次田",
};
function esc(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function yen(n){ return "¥"+Number(n||0).toLocaleString("ja-JP"); }

// 角印（会社印・四角）を生成。最大4字を2x2に配置。CSS div方式（html2canvasでも描画される）。
export function sealKakuHtml(text){
  const t = String(text || "タダカヨ");
  const chars = [...t].slice(0, 4);
  return `<div class="seal-kaku" role="img" aria-label="${esc(t)}の角印">${chars.map(c=>`<span>${esc(c)}</span>`).join("")}</div>`;
}
// 氏名から姓（空白前）を取り出す。「次田 芳尚」→「次田」
export function surnameOf(name){
  const s = String(name || "").trim();
  return s ? s.split(/[\s　]+/)[0] : "";
}

export function renderPOHtml(o, st){
  st = st || {};
  const issuerName = st.poIssuerName || PO_DEFAULT.issuerName;
  const issuerAddr = st.poIssuerAddr || PO_DEFAULT.issuerAddr;
  const issuerRep  = st.poIssuerRep  || PO_DEFAULT.issuerRep;
  // 発注者: 注文ごとに選択(o.ordererName)を優先。なければ設定の先頭→旧単一値→既定
  const ordererName = o.ordererName || (Array.isArray(st.poOrderers) && st.poOrderers[0]) || st.poOrdererName || PO_DEFAULT.ordererName;
  const sealName = surnameOf(ordererName) || st.poSealText || PO_DEFAULT.sealText;
  const items = (o.items||[]).slice();
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
          <div class="po-to-name">${esc(st.supplierName||o.supplier||"AB Circle Japan 株式会社")}　御中</div>
          <p style="margin:18px 0 0">下記の通り発注申し上げます。</p>
          <div class="po-total"><span>TOTAL</span> <strong>${yen(total)}</strong></div>
        </div>
        <div class="po-issuer">
          <div class="po-no"><span>NO.</span> ${esc(String(no))}</div>
          <div class="po-no"><span>発行日</span> ${esc(o.orderDate||"")}</div>
          <div class="po-company">
            <div class="po-company-info">
              <div class="po-org">${esc(issuerName)}</div>
              <div>${esc(PO_DEFAULT.issuerAddrLabel)}</div>
              <div>${esc(issuerAddr)}</div>
              <div>${esc(issuerRep)}</div>
            </div>
            ${st.poSealImage
              ? `<img class="seal-kaku-img" src="${st.poSealImage}" alt="タダカヨの角印">`
              : sealKakuHtml(st.poSealKakuText || "タダカヨ")}
          </div>
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
      <div class="po-orderer">
        <div class="po-orderer-name">発注者　${esc(ordererName)}</div>
        <div class="po-seal" aria-label="担当者印">${esc(sealName)}</div>
      </div>
    </div>`;
}

// 確定プレビュー（supply.html）で .po 要素単体に発注書スタイルを完結させるCSS（PDF生成対象）。
export const PO_STYLE = `
.po{background:#fff;color:#2C2416;font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;font-size:13px;line-height:1.7;padding:32px 36px;width:720px;}
.po *{box-sizing:border-box;}
.po .num{text-align:right;}
.po-title{text-align:center;font-family:"Noto Serif JP",serif;font-size:26px;letter-spacing:.4em;font-weight:700;margin:0 0 28px;}
.po-head{display:flex;justify-content:space-between;gap:24px;margin-bottom:28px;}
.po-to{flex:1;}
.po-to-name{font-size:18px;font-weight:600;}
.po-total{margin-top:24px;font-size:14px;color:#6a5e48;}
.po-total strong{font-size:30px;color:#2C2416;margin-left:14px;font-weight:700;}
.po-issuer{flex:0 0 300px;font-size:12px;color:#444;line-height:1.7;}
.po-no{font-size:13px;color:#2C2416;margin-bottom:2px;}
.po-no span{color:#6a5e48;margin-right:18px;}
.po-org{font-weight:600;font-size:13px;margin:10px 0 2px;color:#2C2416;}
table.po-items{width:100%;border-collapse:collapse;margin-bottom:10px;}
table.po-items th{border-bottom:1.5px solid #888;padding:8px 6px;font-size:12px;color:#6a5e48;font-weight:500;text-align:left;}
table.po-items td{border-bottom:1px solid #E8E4DC;padding:14px 6px;font-size:14px;vertical-align:top;}
table.po-items .num{text-align:right;}
table.po-sum{margin-left:auto;width:300px;border-collapse:collapse;}
table.po-sum td{padding:8px 6px;font-size:14px;border-bottom:1px solid #E8E4DC;}
table.po-sum td.lbl{color:#6a5e48;}
table.po-sum td.num{text-align:right;}
table.po-sum tr.grand td{font-size:16px;border-bottom:none;border-top:1.5px solid #888;}
.po-note{margin-top:24px;font-size:12px;color:#555;}
.po-orderer{display:flex;justify-content:flex-end;align-items:center;gap:16px;margin-top:36px;}
.po-orderer-name{font-size:15px;}
.po-seal{width:64px;height:64px;border:2.5px solid #c0392b;border-radius:50%;color:#c0392b;display:flex;align-items:center;justify-content:center;font-family:"Noto Serif JP",serif;font-weight:700;font-size:18px;line-height:1.05;writing-mode:vertical-rl;letter-spacing:3px;}
.po-seal-img{width:72px;height:72px;object-fit:contain;}
.seal-kaku{width:78px;height:78px;flex:0 0 auto;display:flex;flex-wrap:wrap;border:3px solid #c0392b;border-radius:6px;color:#c0392b;font-family:"Noto Serif JP",serif;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.seal-kaku span{width:50%;height:50%;display:flex;align-items:center;justify-content:center;font-size:23px;line-height:1;}
.po-company{display:flex;align-items:center;gap:10px;margin-top:8px;}
.po-company-info{flex:1;}
.po-company-info .po-org{margin-top:0;}
.seal-kaku-img{width:82px;height:82px;object-fit:contain;flex:0 0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
`;

// 発注メール定型文のデフォルト（settings.js の同名定数と内容を一致させること）
export const DEFAULT_PO_MAIL_SUBJECT = "【発注書送付】NPO法人タダカヨ（{{発注番号}}）";
export const DEFAULT_PO_MAIL_BODY = `{{仕入先名}}
{{担当者}}

平素より大変お世話になっております。NPO法人タダカヨ 介護情報基盤伴走支援事業でございます。

下記のとおり発注いたします。発注書を添付いたしましたので、ご確認のほどよろしくお願いいたします。

■ 発注番号: {{発注番号}}
■ 品目: {{品目}}
■ 金額（税別）: {{金額}}
■ 希望納期: {{希望納期}}

お手数ですが、発注書にご署名・ご捺印の上、ご返送いただけますと幸いです。
何卒よろしくお願い申し上げます。

NPO法人タダカヨ 介護情報基盤伴走支援事業`;
