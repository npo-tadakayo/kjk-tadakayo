// お振込方法のご案内（A4・1枚）— 請求書メールに任意で同封する（2026-10-03 次田さん要望）
// ねらい: 似た法人名からの入金を取り違えないよう、ご依頼人名の前に請求書番号の末尾4桁を付けていただく。
// ネットバンキング・ATM・銀行窓口・ゆうちょ銀行（郵便局）それぞれでの書き方を案内する。
// 振込先は設定（appConfig/settings.billing*）、番号は invoice-doc.js の payerCodeOf を使う。
import { payerCodeOf, invoiceNoOf, invoiceTotals, buildOnePagePdf } from "/js/invoice-doc.js";

function esc(v){ return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
const yen = (n) => "¥" + Math.round(Number(n)||0).toLocaleString("ja-JP");

export const FURIKOMI_STYLE = `
.fg{width:190mm;box-sizing:border-box;background:#fff;color:#000;font-family:"Noto Sans JP","Hiragino Sans",system-ui,sans-serif;font-size:10.5pt;line-height:1.65;padding:4mm 6mm;}
.fg h1{font-size:17pt;color:#E33535;margin:0 0 1mm;font-weight:700;}
.fg .fg-sub{font-size:9.5pt;color:#555;margin:0 0 4mm;}
.fg .fg-to{font-size:10pt;border-bottom:1px solid #e3dcd0;padding-bottom:2mm;margin-bottom:4mm;}
.fg .fg-key{background:#FFE4EC;border-radius:3mm;padding:4mm 5mm;margin-bottom:4mm;}
.fg .fg-key .lbl{font-size:9.5pt;color:#555;}
.fg .fg-key .big{font-size:20pt;font-weight:700;letter-spacing:.05em;}
.fg .fg-key .big b{color:#E33535;}
.fg .fg-key p{margin:1mm 0 0;font-size:10pt;}
.fg h2{font-size:12pt;border-left:4px solid #E33535;padding-left:2.5mm;margin:5mm 0 2.5mm;}
.fg table{width:100%;border-collapse:collapse;font-size:9.8pt;}
.fg th,.fg td{border:1px solid #e3dcd0;padding:2mm 2.5mm;vertical-align:top;text-align:left;}
.fg th{background:#F5F5F5;width:30%;font-weight:700;}
.fg .bank td{font-size:10.5pt;}
.fg ul{margin:1mm 0 0;padding-left:5mm;}
.fg .note{font-size:9pt;color:#555;margin-top:2mm;}
.fg .foot{margin-top:5mm;padding-top:2mm;border-top:1px solid #e3dcd0;font-size:9pt;color:#555;}
`;

export function renderFurikomiGuideHtml(s, st) {
  st = st || {};
  const code = payerCodeOf(s);
  const to = s.company || s.officeName || "";
  const issuer = st.invoiceIssuerName || "NPO法人タダカヨ";
  const bank = [st.billingBankName, st.billingBranchName, `${st.billingAccountType || "普通"} ${st.billingAccountNumber || ""}`].filter(Boolean).join("　");
  const holder = st.billingAccountHolder || "";
  const amt = invoiceTotals(s).payable;
  return `
<div class="fg">
  <h1>お振込方法のご案内</h1>
  <p class="fg-sub">${esc(issuer)}　介護情報基盤伴走支援事業</p>
  <div class="fg-to">${esc(to)} 様　／　請求書番号 ${esc(invoiceNoOf(s))}　／　ご請求金額（税込）<strong>${yen(amt)}</strong></div>

  <div class="fg-key">
    <div class="lbl">お振込のときの「ご依頼人名」</div>
    <div class="big"><b>${esc(code)}</b>　＋　御社名（カナ）</div>
    <p>例：<strong>${esc(code)} ユ）○○○○</strong>　（数字の後ろは、いつもの御社名のままで構いません）</p>
    <p>似たお名前の法人さまが多く、どの請求書へのお振込みかを確実に確かめるためのお願いです。</p>
  </div>

  <h2>お振込先</h2>
  <table class="bank"><tbody>
    <tr><th>口座</th><td>${esc(bank)}</td></tr>
    <tr><th>口座名義</th><td>${esc(holder)}</td></tr>
    <tr><th>お支払期限</th><td>請求書発行月の翌月末（振込手数料は御社でご負担ください）</td></tr>
  </tbody></table>

  <h2>振込のしかた別の書き方</h2>
  <table><tbody>
    <tr><th>インターネットバンキング</th><td>振込内容を入れる画面で「依頼人名」（「振込依頼人名」「依頼人名の変更」など）を開き、お名前の前に <strong>${esc(code)}</strong> と半角スペースを入れてください。</td></tr>
    <tr><th>ATM</th><td>「振込依頼人名」を入れる画面で、お名前の前に <strong>${esc(code)}</strong> を入れてください（電話番号の入力画面とは別です）。</td></tr>
    <tr><th>銀行の窓口（振込用紙）</th><td>振込用紙の「ご依頼人」欄に、お名前の前へ <strong>${esc(code)}</strong> と書いてください。</td></tr>
    <tr><th>ゆうちょ銀行・郵便局</th><td>ゆうちょダイレクト・ゆうちょ銀行のATM・窓口の振込依頼書のどれでも、ご依頼人名の前に <strong>${esc(code)}</strong> を入れてください。
      <div class="note">※ 郵便局の青い「払込取扱票」は、ゆうちょ銀行の口座あての用紙のため、上記の口座へはお使いいただけません。</div></td></tr>
  </tbody></table>

  <h2>こんなときは</h2>
  <ul>
    <li><strong>複数の請求書をまとめてお振込みいただくとき</strong>：番号を並べてください（例：${esc(code)} ○○○○ ユ）○○○○）。入りきらないときは、下のメールでお知らせください。</li>
    <li><strong>ご依頼人名を変えられないとき</strong>（法人のネットバンキングなどで、登録名から変更できない場合）：お振込みのあと、日付・金額・番号を下のメールでお知らせください。</li>
  </ul>

  <div class="foot">ご不明な点は ${esc(issuer)}（介護情報基盤伴走支援事業）へ　TEL 050-6872-9884　／　kjk-staff@tadakayo.jp</div>
</div>`;
}

// A4・1枚の PDF（base64）を作る。window.html2pdf が読み込まれている前提（supply-print.html）
export async function buildFurikomiGuidePdf(s, st) {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:190mm;background:#fff";
  const style = document.createElement("style"); style.textContent = FURIKOMI_STYLE;
  holder.appendChild(style);
  holder.insertAdjacentHTML("beforeend", renderFurikomiGuideHtml(s, st));
  document.body.appendChild(holder);
  try {
    const uri = await buildOnePagePdf(holder.querySelector(".fg"));
    return String(uri || "").split(",")[1] || "";
  } finally { holder.remove(); }
}
