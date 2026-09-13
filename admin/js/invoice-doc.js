// 請求書（INV）の描画を supply-print（印刷ページ）と経理報告のPDF生成（供給管理）で共有する共通モジュール。
// po-doc.js と同じ役割・同じ作法。CSS は supply-print.html の <style> 内 .inv-* と内容を一致させること
// （あちらは送付状・領収書等と同居のため別管理。こちらは .inv 配下で完結する自己完結版）。
function esc(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function yen(n){ return "¥"+Number(n||0).toLocaleString("ja-JP"); }

// 請求書番号（出荷番号 SH… → INV…）。Chatの報告本文・PDFファイル名でも同じ番号を使う
export function invoiceNoOf(s){ return String((s&&s.soNumber)||"").replace(/^SH/,"INV"); }

// 🔴 明細の単価が「税込」か「税抜」かは、請求先で変わる（2026-09-13 是正）。
//   ・事業所へ直接販売（direct）＝ 見積もりの定価をそのまま入れている。
//     見積もりの価格は **すべて税込**（js/estimate-pricing.js の BT_PRICE/ACCOMPANY_FEE のコメント参照）。
//     見積書にも「金額はすべて税込」と明記しているので、ここで10%を足すと二重課税になる。
//   ・認定事業者への卸（dropship / partnerEmail あり / 旧 shipType:"stock"）＝ 卸価格表は **税別**。
//     こちらは従来どおり小計に10%を足す。
//   判定は supply.js の billsPartner と同じにすること（ズレると請求書と一覧が食い違う）。
export function priceIsTaxIncluded(s){
  return !(((s&&s.shipType)==="dropship") || !!(s&&s.partnerEmail));
}

// 請求金額の計算。一覧・請求書・領収書・経理報告はすべてこの関数を通すこと。
// 送料は請求先によらず税抜で保存されている（2026-07-28 統一）。
// 消費税は「税率ごとに1回だけ」計算する（インボイス制度の端数処理）。
export function invoiceTotals(s){
  const items = (s&&s.items)||[];
  const goods = items.reduce((a,i)=>a+(Number(i.unitPrice)||0)*(Number(i.qty)||0),0);
  const shipExcl = Number(s&&s.shippingFee)||0;
  const taxIncluded = priceIsTaxIncluded(s);
  let goodsExcl, shipIncl, sub, tax, total;
  if (taxIncluded) {
    // 明細は税込。送料だけ税抜なので税込に直してから足し、消費税は合計から割り戻す
    shipIncl = Math.round(shipExcl * 1.1);
    total = goods + shipIncl;
    tax = Math.floor(total * 10 / 110);
    sub = total - tax;              // 税抜相当
    goodsExcl = goods - Math.floor(goods * 10 / 110);
  } else {
    goodsExcl = goods;
    shipIncl = shipExcl;
    sub = goodsExcl + shipExcl;
    tax = Math.floor(sub * 0.1);
    total = sub + tax;
  }
  // 過入金の充当（前回多くお振込みいただいた分を今回の請求から差し引く。税込金額に対する充当）
  const credit = Math.min(Number(s&&s.creditApplied)||0, total);
  return { taxIncluded, goods, goodsExcl, shipExcl, shipIncl, sub, tax, total, credit, payable: total-credit };
}

// 発行元の連絡先（設定で入れた分だけ出す）。請求書・領収証で同じ並びにする（2026-09-13 追加）
export function issuerContactHtml(st){
  st = st || {};
  const addr = [st.invoiceIssuerPostal ? `〒${esc(st.invoiceIssuerPostal)}` : "", esc(st.invoiceIssuerAddress||"")]
    .filter(Boolean).join(" ");
  const line2 = [st.invoiceIssuerTel ? `TEL: ${esc(st.invoiceIssuerTel)}` : "",
                 st.invoiceIssuerContact ? `担当: ${esc(st.invoiceIssuerContact)}` : ""]
    .filter(Boolean).join("　／　");
  return (addr ? `${addr}<br>` : "") + (line2 ? `${line2}<br>` : "");
}

// 品目の用途説明。助成金の申請で「何に使うものか」が書面から分かるように帳票へ出す（2026-09-13 追加）
export function itemPurposeNote(sku){
  const k = String(sku||"");
  if (k === "support-fee") return "導入設定・マイナ資格確認アプリ設定・介護DX証明書設定・1年間サポート";
  if (k === "discount") return "";
  if (/^cir/i.test(k)) return "介護情報基盤で使用するマイナ資格確認アプリ対応カードリーダー";
  return "";
}

// 請求先の表示名（直送＝認定事業者／直接＝事業所）。supply.js の billToKey と対象は同じ
export function billToNameOf(s){
  return (s&&s.shipType)==="dropship" ? ((s&&s.partnerName)||"") : ((s&&s.company)||(s&&s.officeName)||"");
}

// 請求書（見積書の赤系を踏襲・認定事業者向け／卸価格・税別→税込）
// st = appConfig/settings ／ opts.issueDate で発行日を上書きできる（既定は当日＝従来の挙動）
export function renderInvoiceHtml(s, st, opts){
  st = st || {}; opts = opts || {};
  const issueDate = opts.issueDate || new Date().toLocaleDateString("ja-JP",{year:"numeric",month:"long",day:"numeric"});
  const items = s.items||[];
  const { taxIncluded, shipExcl, shipIncl, sub, tax, total, credit, payable } = invoiceTotals(s);
  const shipFeeIncl = shipExcl; // 明細行を出すかの判定に使う
  const shipShown = taxIncluded ? shipIncl : shipExcl;   // 明細に出す送料（列の税基準に合わせる）
  const priceUnit = taxIncluded ? "税込" : "税抜";
  // 充当元の内訳。別請求先（グループ会社）からの充当は請求先名も出す＝どこの入金を回したかが書面で追える
  const creditFromList = (Array.isArray(s.creditFrom)?s.creditFrom:[]).filter(c=>c.soNumber);
  const creditFrom = creditFromList
    .map(c=>c.crossBillTo&&c.fromBillTo ? `${c.soNumber}／${c.fromBillTo}様` : c.soNumber)
    .join("・");
  const hasCrossCredit = creditFromList.some(c=>c.crossBillTo);
  const invNo = invoiceNoOf(s);
  const billName = billToNameOf(s);
  // 宛先の住所（見本の書式に合わせて記載。直送＝認定事業者宛のときは出荷の住所が届け先なので出さない）
  const billAddr = (s.shipType==="dropship" || s.partnerEmail) ? ""
    : [s.postal?`〒${esc(s.postal)}`:"", esc(s.address||"")].filter(Boolean).join(" ");
  const issuerName = st.invoiceIssuerName || "NPO法人タダカヨ";
  const regNo = st.invoiceRegNo || "";
  const regLine = regNo
    ? `登録番号: <strong>${esc(regNo)}</strong>`
    : `<span style="color:#b84a4a">登録番号: 未登録（設定で登録してください）</span>`;
  // お振込先（設定 appConfig/settings.billing* / 未設定なら従来の案内文言）
  const bankName=st.billingBankName||"", branch=st.billingBranchName||"", acctType=st.billingAccountType||"普通", acctNo=st.billingAccountNumber||"", acctHolder=st.billingAccountHolder||"";
  const hasBank = bankName && acctNo;
  const payInner = hasBank
    ? `<div style="font-size:13px;line-height:1.7">${esc(bankName)}　${esc(branch)}　${esc(acctType)} ${esc(acctNo)}<br>口座名義：${esc(acctHolder)}</div><div style="font-size:12px;color:#6a5e48;margin-top:4px">※ 軽減税率対象品目はありません（すべて10%対象）。お支払期限：請求書発行月の翌月末。恐れ入りますが振込手数料は御社にてご負担ください。</div>`
    : `<div style="font-size:12px;color:#6a5e48">※ 軽減税率対象品目はありません（すべて10%対象）。振込先口座は別途ご案内します。お支払期限：請求書発行月の翌月末。</div>`;
  // 適格請求書: 各明細に適用税率を表示
  // 品名だけでは USB か Bluetooth か（USBなら端子が A か C か）分からないので、明細に併記する。
  // 新しい明細は connection を持っている。古い明細は呼び出し側が products を渡してくれれば引ける。
  const connOf = (i) => {
    const saved = String(i?.connection || "").trim();
    if (saved) return saved;
    const list = Array.isArray(opts?.products) ? opts.products : [];
    const p = list.find(x => x.id === i?.sku || x.sku === i?.sku);
    if (!p) return "";
    const conn = String(p.connection || "").trim(), cn = String(p.connector || "").trim();
    if (/bluetooth/i.test(conn)) return cn ? `Bluetooth／${cn}` : "Bluetooth";
    return cn || conn;
  };
  const rows2 = items.map(i=>{
    const sub = [ connOf(i) ? `つなぎ方: ${esc(connOf(i))}` : "", esc(itemPurposeNote(i.sku)) ]
      .filter(Boolean).map(x=>`<div style="font-size:11px;color:#6a5e48">${x}</div>`).join("");
    return `<tr><td>${esc(i.name)}${sub}</td><td class="num">10%</td><td class="num">${i.qty}</td><td class="num">${yen(i.unitPrice)}</td><td class="num">${yen((Number(i.unitPrice)||0)*(Number(i.qty)||0))}</td></tr>`;
  }).join("")
    + (shipFeeIncl>0 ? `<tr><td>${esc(s.shippingLabel||"送料")}</td><td class="num">10%</td><td class="num">1</td><td class="num">${yen(shipShown)}</td><td class="num">${yen(shipShown)}</td></tr>` : "");
  return `
    <div class="inv">
      <div class="doc-head"><div></div>
        <div class="issuer-wrap">
          <div class="issuer"><div class="org">${esc(issuerName)}</div>介護情報基盤伴走支援事業<br>${regLine}<br>${issuerContactHtml(st)}kjk-staff@tadakayo.jp<br>発行日: ${esc(issueDate)}</div>
          <img class="seal-kaku-img" src="${st.poSealImage || "/images/seal-tadakayo.png"}" alt="タダカヨの角印">
        </div></div>
      <h1 class="inv-title">請　求　書</h1>
      <div class="to">${esc(billName)} 御中</div>
      ${billAddr ? `<div class="meta">${billAddr}</div>` : ""}
      <div class="meta">請求書番号: ${esc(invNo)}　／　対応出荷: ${esc(s.soNumber)}（${esc(s.shipDate||"")}）</div>
      <div class="meta">納品先: ${esc(s.company?s.company+" / ":"")}${esc(s.officeName||"")}</div>
      <p style="margin:16px 0 6px">下記のとおりご請求申し上げます。</p>
      <div class="grand">${credit>0?"今回お支払額（税込・充当後）":"ご請求金額（税込）"}　<strong>${yen(payable)}</strong></div>
      <table class="items"><thead><tr><th>品名</th><th style="width:56px">税率</th><th style="width:56px">数量</th><th style="width:104px">単価(${priceUnit})</th><th style="width:116px">金額(${priceUnit})</th></tr></thead>
        <tbody>${rows2}</tbody></table>
      <table class="po-sum" style="margin-top:10px"><tbody>
        ${taxIncluded
          ? `<tr><td class="lbl">税込小計</td><td class="num">${yen(total)}</td></tr>
             <tr><td class="lbl">うち消費税（10%）</td><td class="num">${yen(tax)}</td></tr>`
          : `<tr><td class="lbl">10%対象 小計（税抜）</td><td class="num">${yen(sub)}</td></tr>
             <tr><td class="lbl">消費税額（10%）</td><td class="num">${yen(tax)}</td></tr>`}
        <tr${credit>0?"":' class="grand"'}><td class="lbl">合計（税込）</td><td class="num"><strong>${yen(total)}</strong></td></tr>
        ${credit>0?`<tr><td class="lbl">${hasCrossCredit?"お預かり分の充当":"前回お預かり分の充当"}${creditFrom?`（${esc(creditFrom)} の過入金）`:""}</td><td class="num">−${yen(credit)}</td></tr>
        <tr class="grand"><td class="lbl">今回お支払額（税込）</td><td class="num"><strong>${yen(payable)}</strong></td></tr>`:""}
      </tbody></table>
      <div class="pay">
        <div style="font-weight:700;margin-bottom:4px">お振込先</div>
        ${payInner}
      </div>
      <div class="footer">${esc(issuerName)}　介護情報基盤伴走支援事業${regNo?`　登録番号 ${esc(regNo)}`:""}</div>
    </div>`;
}

// 経理報告のプレビュー（supply.html）で .inv 要素単体に請求書スタイルを完結させるCSS（PDF生成対象）。
// supply-print.html の同名クラスと見た目を一致させること。
export const INVOICE_STYLE = `
.inv{background:#fff;color:#2C2416;font-family:"Noto Sans JP","Hiragino Sans",system-ui,sans-serif;font-size:13px;line-height:1.7;padding:32px 36px;width:720px;}
.inv *{box-sizing:border-box;}
.inv .num{text-align:right;}
.inv .doc-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.inv .issuer-wrap{display:flex;align-items:flex-start;gap:12px;justify-content:flex-end;}
.inv .issuer{text-align:right;font-size:12px;color:#6a5e48;}
.inv .issuer .org{font-family:"Noto Serif JP",serif;font-size:14px;color:#2C2416;}
.inv .seal-kaku-img{width:82px;height:82px;object-fit:contain;flex:0 0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.inv .inv-title{font-family:"Noto Serif JP",serif;font-size:24px;letter-spacing:.3em;color:#E33535;border-bottom:3px solid #E33535;padding-bottom:8px;margin:0 0 20px;}
.inv .to{font-size:16px;font-weight:600;margin-bottom:6px;}
.inv .meta{font-size:12px;color:#6a5e48;}
.inv .grand{background:#FFE4EC;border:1px solid #E33535;border-radius:6px;padding:10px 14px;font-size:15px;margin:8px 0 16px;}
.inv .grand strong{font-size:20px;color:#c02828;}
.inv table.items{width:100%;border-collapse:collapse;margin:20px 0;}
.inv table.items th,.inv table.items td{border:1px solid #E8E4DC;padding:8px 10px;text-align:left;}
.inv table.items th{background:#FAFAF8;font-size:12px;}
.inv table.items td.num{text-align:right;}
.inv table.po-sum{margin-left:auto;width:300px;border-collapse:collapse;}
.inv table.po-sum td{padding:8px 6px;font-size:14px;border-bottom:1px solid #E8E4DC;}
.inv table.po-sum td.lbl{color:#6a5e48;}
.inv table.po-sum td.num{text-align:right;}
.inv table.po-sum tr.grand td{font-size:16px;border-bottom:none;border-top:1.5px solid #888;background:none;}
.inv .pay{margin-top:18px;border:1px dashed #E8E4DC;border-radius:6px;padding:12px;}
.inv .footer{margin-top:36px;padding-top:14px;border-top:1px solid #E8E4DC;font-size:11px;color:#6a5e48;text-align:center;}
`;

// 経理報告メールの定型文デフォルト（settings.js の初期表示と内容を一致させること）
export const DEFAULT_INVOICE_MAIL_SUBJECT = "【請求書発行のご報告】{{請求先}}（{{請求書番号}}）";
export const DEFAULT_INVOICE_MAIL_BODY = `{{経理担当}} さん

介護情報基盤伴走支援事業の請求書を発行しましたので、ご報告いたします。
請求書PDFを添付しております。

■ 請求書番号: {{請求書番号}}
■ 請求先: {{請求先}}
■ 納品先: {{納品先}}
■ 請求金額（税込）: {{請求金額}}
■ 支払期限: {{支払期限}}
■ 対応出荷: {{出荷番号}}（{{出荷日}}）

よろしくお願いいたします。

NPO法人タダカヨ 介護情報基盤伴走支援事業`;
