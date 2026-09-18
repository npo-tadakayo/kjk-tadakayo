#!/usr/bin/env node
// 見積書の前に付ける「合計お見積もりのご案内（法人内ご決裁用）」を作る。
//   node scripts/quote-cover/build.mjs 入力.json 出力.html
//   → 続けて python3 scripts/quote-cover/topdf.py 出力.html 出力.pdf でPDF化（A4横）
//
// 入力JSON（scripts/quote-cover/sample.json 参照）:
//   corpName / issuedAt / validUntil / staff / offices[{name, service, plan, bt, usb, btExtra, usbExtra, estNo, version}]
// 金額は正本 functions/estimate-pricing.js の computeAmounts で計算する（手計算を持ち込まない）。
// ブランド: タダカヨ（_ブランド素材/TADAKAYO_design_instructions.md）。色は 5色のみ。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const require = createRequire(import.meta.url);
const P = require(path.join(repo, "functions", "estimate-pricing.js"));

const [,, inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: build.mjs 入力.json 出力.html"); process.exit(1); }
const input = JSON.parse(fs.readFileSync(inPath, "utf8"));

// ---- ブランド素材（data URI で埋め込む＝HTML単体で完結）----
const BRAND = path.join(os.homedir(), "Projects", "tadakayo", "_ブランド素材");
const dataUri = (p) => `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
const LOGO  = dataUri(path.join(BRAND, "ロゴ", "tadakayo_logo_remove.png"));
const CHARA = (n) => dataUri(path.join(BRAND, "多田佳代ちゃん", `chara_${n}.png`));

// ---- 計算 ----
const yen = (n) => "¥" + Math.round(Number(n) || 0).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ymdJp = (s) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : s || "—"; };
const PLAN_SHORT = { houmon: "訪問・通所系", kyojyu: "居住・入所系", other: "その他" };

const rows = input.offices.map((o) => {
  const a = P.computeAmounts(o.plan, o.bt, o.usb, o.btExtra, o.usbExtra);
  return { ...o, a };
});
const sum = (k) => rows.reduce((s, r) => s + r.a[k], 0);
const T = { total: sum("totalIncl"), grant: sum("grantAmt"), self: sum("selfPay"),
            dev: sum("devSubsidyIncl") + sum("extraPartTotal"), fee: sum("accFeeIncl"), disc: sum("discount"),
            units: rows.reduce((s, r) => s + r.a.subsidyTotal + r.a.extraTotal, 0) };
const n = rows.length;
const zeroAll = T.self === 0;

// ---- HTML ----
const css = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Noto+Serif+JP:wght@700;900&display=swap');
:root{--red:#E33535;--pink:#FFE4EC;--gray:#F5F5F5;--ink:#000;--muted:#555;--line:#E5E5E5;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:var(--ink);font-family:"Noto Sans JP","Hiragino Sans",sans-serif;font-size:11pt;line-height:1.6}
.slide{width:297mm;height:210mm;position:relative;overflow:hidden;page-break-after:always;break-after:page;background:#fff;padding:14mm 18mm 16mm}
.slide:last-child{page-break-after:auto;break-after:auto}
h1,h2,h3{font-family:"Noto Serif JP","Noto Sans JP",serif;letter-spacing:.02em;text-wrap:balance;word-break:keep-all}
.title{color:var(--red);font-size:22pt;font-weight:900;line-height:1.3;margin-bottom:3mm}
.lead{font-size:11.5pt;color:#333;margin-bottom:6mm}
.footer{position:absolute;left:18mm;right:18mm;bottom:8mm;border-top:2px solid var(--red);padding-top:2.5mm;display:flex;justify-content:space-between;font-size:8.5pt;color:var(--muted)}
.footer img{height:7mm}
.pn{font-weight:700;color:var(--red)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8mm}
.card{background:var(--gray);border-radius:10px;padding:5mm 6mm}
.card.pink{background:var(--pink)}
.card h3{color:var(--red);font-size:12.5pt;margin-bottom:2mm}
.kv{display:grid;grid-template-columns:repeat(4,1fr);gap:4mm}
.kv .card{text-align:center;padding:4mm 3mm}
.kv .lbl{font-size:9.5pt;color:var(--muted)}
.kv .val{font-size:19pt;font-weight:900;color:var(--red);line-height:1.2;font-family:"Noto Sans JP";letter-spacing:-.01em}
.kv .val.ink{color:var(--ink)}
.kv .sub{font-size:8.5pt;color:var(--muted);margin-top:1mm}
table{border-collapse:collapse;width:100%;font-size:9.5pt}
th,td{padding:2.2mm 2.5mm;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{background:var(--pink);color:#7a1b1b;font-weight:700;font-size:9pt}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr.total td{background:var(--gray);font-weight:900;border-top:2px solid var(--red);border-bottom:none;font-size:11pt}
tr.total td.red{color:var(--red)}
.note{font-size:8.5pt;color:var(--muted);line-height:1.6}
.callout{border-left:5px solid var(--red);background:var(--pink);padding:3.5mm 5mm;border-radius:0 8px 8px 0;font-size:10.5pt}
.callout strong{color:var(--red)}
.steps{display:grid;grid-template-columns:repeat(7,1fr);gap:2.5mm;margin-top:3mm}
.step{background:var(--gray);border-radius:10px;padding:3.5mm 3mm 3mm;display:flex;flex-direction:column;min-height:66mm}
.step .no{width:9mm;height:9mm;border-radius:50%;background:var(--red);color:#fff;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:11pt;margin-bottom:2mm}
.step h4{font-size:10pt;line-height:1.35;margin-bottom:1.5mm;word-break:keep-all;text-wrap:balance}
.step p{font-size:8.3pt;line-height:1.5;color:#333;margin-bottom:2mm}
.step .who{margin-top:auto;font-size:7.8pt;color:#fff;background:#333;border-radius:4px;padding:.6mm 1.5mm;text-align:center}
.step .who.t{background:var(--red)}
.step.hl{background:var(--pink);outline:2px solid var(--red)}
.tl{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin-top:4mm}
.tl .m{background:#fff;border:1.5px solid var(--red);border-radius:8px;padding:2.5mm 3mm;font-size:9pt}
.tl .m b{display:block;color:var(--red);font-size:10pt}
.chk li{list-style:none;display:flex;gap:3mm;align-items:flex-start;padding:2.4mm 0;border-bottom:1px dashed var(--line);font-size:10.3pt}
.chk li::before{content:"";flex:0 0 5mm;height:5mm;border:2px solid var(--red);border-radius:3px;margin-top:1mm;background:#fff}
.chk li b{color:var(--red)}
.chara{position:absolute;pointer-events:none}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}
.plan{border:2px solid var(--red);border-radius:10px;overflow:hidden;background:#fff}
.plan .h{background:var(--red);color:#fff;font-weight:700;padding:2mm 3mm;font-size:10pt;text-align:center}
.plan .b{padding:3mm;text-align:center}
.plan .b .lim{font-size:20pt;font-weight:900;color:var(--red);line-height:1.2}
.plan .b .q{font-size:9pt;color:var(--muted)}
.bar{display:flex;height:11mm;border-radius:8px;overflow:hidden;font-size:9pt;color:#fff;font-weight:700;margin:3mm 0 1.5mm}
.bar div{display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.2}
.legend{display:flex;gap:6mm;font-size:8.8pt;color:#333}
.legend span::before{content:"";display:inline-block;width:3.2mm;height:3.2mm;border-radius:2px;margin-right:1.5mm;vertical-align:-0.4mm;background:var(--c)}
.cover{padding:0}
.cover .top{height:120mm;background:var(--pink);padding:14mm 18mm;position:relative}
.cover .bottom{height:90mm;background:var(--red);color:#fff;padding:12mm 18mm 10mm;position:relative}
.cover .top img.logo{height:16mm;position:absolute;right:18mm;top:12mm}
.cover .kicker{color:var(--red);font-weight:700;font-size:12pt;letter-spacing:.08em;margin-top:18mm}
.cover h1{color:var(--red);font-size:36pt;line-height:1.25;margin-top:3mm;font-weight:900}
.cover .sub{font-size:15pt;color:#333;margin-top:4mm;font-weight:500}
.cover .to{font-size:20pt;font-weight:700;border-bottom:2px solid #fff;display:inline-block;padding-bottom:1.5mm;margin-bottom:5mm}
.cover .meta{font-size:11pt;line-height:1.9;opacity:.95}
.cover .meta b{display:inline-block;min-width:24mm;font-weight:500;opacity:.85}
.cover .issuer{position:absolute;right:18mm;bottom:12mm;text-align:right;font-size:10pt;line-height:1.7}
.cover .issuer .nm{font-size:14pt;font-weight:700}
.spk{position:absolute;background:#fff;border:2px solid var(--red);border-radius:12px;padding:3mm 4mm;font-size:9.8pt;line-height:1.5;max-width:62mm}
.spk::after{content:"";position:absolute;left:-7px;top:40%;border:7px solid transparent;border-right-color:var(--red);border-left:0}
.hd{display:flex;align-items:baseline;gap:4mm}
.hd .n{font-family:"Noto Sans JP";font-size:26pt;font-weight:900;color:var(--red);line-height:1}
`;

const footer = (i) => `<div class="footer"><span>特定非営利活動法人タダカヨ　介護情報基盤 伴走支援事業　｜　${esc(input.corpName)} 様　合計お見積もりのご案内（${ymdJp(input.issuedAt)}）</span><span class="pn">${i} / 8</span></div>`;

const officeRows = rows.map((r, i) => `
  <tr>
    <td>${i + 1}</td>
    <td><b>${esc(r.name)}</b><br><span style="font-size:8.3pt;color:var(--muted)">${esc(r.service)}　／　${esc(r.estNo)}${r.version > 1 ? `（第${r.version}版）` : ""}</span></td>
    <td>${PLAN_SHORT[r.plan]}</td>
    <td class="num">${r.a.subsidyTotal}台${r.a.extraTotal ? `<br><span style="color:var(--muted);font-size:8.3pt">＋対象外${r.a.extraTotal}台</span>` : ""}</td>
    <td class="num">${yen(r.a.totalIncl)}</td>
    <td class="num">−${yen(r.a.grantAmt)}</td>
    <td class="num" style="font-weight:700;${r.a.selfPay === 0 ? "color:var(--red)" : ""}">${yen(r.a.selfPay)}</td>
  </tr>`).join("");

const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${esc(input.corpName)} 様 合計お見積もりのご案内</title><style>${css}</style></head><body>

<!-- 1 表紙 -->
<section class="slide cover">
  <div class="top">
    <img class="logo" src="${LOGO}" alt="NPO法人タダカヨ">
    <div class="kicker">介護情報基盤 伴走支援事業</div>
    <h1>介護情報基盤への対応<br>伴走支援のご提案</h1>
    <div class="sub">合計お見積もりのご案内（法人内ご決裁用）</div>
    <img class="chara" src="${CHARA(2)}" alt="" style="right:30mm;top:50mm;height:92mm;z-index:2">
  </div>
  <div class="bottom">
    <div class="to">${esc(input.corpName)} ${esc(input.corpHonorific || "御中")}</div>
    <div class="meta">
      <div><b>発行日</b>${ymdJp(input.issuedAt)}</div>
      <div><b>有効期限</b>${ymdJp(input.validUntil)}（添付の各見積書に準じます）</div>
      <div><b>対象</b>${n}事業所　／　カードリーダー 計${T.units}台　／　添付の見積書 ${n}通</div>
    </div>
    <div class="issuer">
      <div class="nm">特定非営利活動法人タダカヨ</div>
      〒143-0014 東京都大田区大森中2-1-20-1001<br>TEL 050-6872-9884　担当: ${esc(input.staff || "佐藤拡史")}<br>https://kjk.tadakayo.jp
    </div>
  </div>
</section>

<!-- 2 要旨 -->
<section class="slide">
  <h2 class="title">ご提案の要旨　—　この1枚でご判断いただけます</h2>
  <p class="lead">${n}事業所のカードリーダー導入と伴走支援を、国の「介護情報基盤 助成金」を使って進めます。${zeroAll ? "<strong style='color:var(--red)'>助成金の上限内に収めたため、法人さまの自己負担は ¥0 です。</strong>" : "助成金の対象外となる台数分のみ、法人さまのご負担となります。"}</p>
  <div class="kv" style="margin-bottom:5mm">
    <div class="card"><div class="lbl">お見積合計（税込）</div><div class="val ink">${yen(T.total)}</div><div class="sub">機器 ${yen(T.dev)} ＋ 伴走支援費 ${yen(T.fee)}${T.disc ? ` − 調整 ${yen(T.disc)}` : ""}</div></div>
    <div class="card"><div class="lbl">介護情報基盤 助成金（見込み）</div><div class="val ink">−${yen(T.grant)}</div><div class="sub">定額型・申請の翌々月に事業所口座へ振込</div></div>
    <div class="card pink"><div class="lbl">法人さまの実質ご負担</div><div class="val">${yen(T.self)}</div><div class="sub">${zeroAll ? "助成金の上限ぴったりに設計" : "助成対象外の台数分"}</div></div>
    <div class="card"><div class="lbl">助成金の申請期限</div><div class="val ink" style="font-size:15pt;padding-top:1.5mm">2027年<br>3月12日</div><div class="sub">令和8年度・2026年5月7日受付開始</div></div>
  </div>
  <table>
    <thead><tr><th style="width:6mm">#</th><th>事業所（サービス種別／見積番号）</th><th style="width:26mm">助成区分</th><th class="num" style="width:26mm">台数</th><th class="num" style="width:26mm">見積額</th><th class="num" style="width:26mm">助成金</th><th class="num" style="width:26mm">ご負担額</th></tr></thead>
    <tbody>${officeRows}
      <tr class="total"><td></td><td>合計（${n}事業所）</td><td></td><td class="num">${T.units}台</td><td class="num">${yen(T.total)}</td><td class="num">−${yen(T.grant)}</td><td class="num red">${yen(T.self)}</td></tr>
    </tbody>
  </table>
  <p class="note" style="margin-top:2mm">※ 金額はすべて消費税10%を含む税込です。助成金の額は各事業所が申請要件を満たし、審査で認められた場合の見込みです。詳細は添付の見積書（事業所ごと）をご覧ください。</p>
  <div class="callout" style="margin-top:3.5mm"><strong>ご決裁いただきたいこと</strong>　① 上記${n}事業所の伴走支援（添付見積書）のお申し込み　② お支払い方法の選択（伴走支援後のお支払い／前払い）　③ 各事業所での助成金申請の実施</div>
  ${footer(2)}
</section>

<!-- 3 なぜ今か -->
<section class="slide">
  <h2 class="title">なぜ今、進めるのか　—　3つの理由</h2>
  <p class="lead">介護情報基盤は、利用者さんの介護保険資格・要介護認定情報・主治医意見書をオンラインで確認できる国の仕組みです。準備には、マイナンバーカードを読み取るカードリーダーが必要になります。</p>
  <div class="grid2" style="grid-template-columns:1fr 1fr 1fr;gap:5mm">
    <div class="card"><div class="hd"><span class="n">1</span><h3>令和9年1月に<br>ケアプランデータ連携も統合</h3></div><p style="margin-top:2mm;font-size:10pt">2027年1月、ケアプランデータ連携システムの入口が介護情報基盤に統合されます。カードリーダーは統合後も同じものを使い続けられるため、いま整えておけば二度手間になりません。</p></div>
    <div class="card"><div class="hd"><span class="n">2</span><h3>助成金は「定額型」で<br>いまが申請期間</h3></div><p style="margin-top:2mm;font-size:10pt">介護事業所向けの「介護情報基盤 助成金」は補助率の定めがなく、上限額まで実費を全額助成します（ICT補助金は最大3/4の割合型）。申請受付は <strong style="color:var(--red)">2026年5月7日〜2027年3月12日</strong>。予算枠のある制度のため、早めの申請が安心です。</p></div>
    <div class="card pink"><div class="hd"><span class="n">3</span><h3>機器代とサポート費の<br>両方が助成対象</h3></div><p style="margin-top:2mm;font-size:10pt">助成対象は「①カードリーダー購入経費」＋「②介護情報基盤との接続サポート等経費」の合計。タダカヨの伴走支援はこの①②に合わせて組み立てており、<strong style="color:var(--red)">上限内に収めれば実質¥0</strong>で導入できます。</p></div>
  </div>
  <div style="display:flex;gap:6mm;align-items:center;margin-top:7mm">
    <img src="${CHARA(4)}" alt="" style="height:44mm">
    <div class="spk" style="position:static;max-width:none;flex:1">「うちの事業所は対象？」「どの機種を何台？」——そこからご一緒します。助成金の区分・台数・申請の手順まで、添付の見積書と合わせてこの資料でご確認いただけるようにまとめました。</div>
  </div>
  ${footer(3)}
</section>

<!-- 4 ご提供内容 -->
<section class="slide">
  <h2 class="title">ご提供内容　—　機器・セットアップ・1年間の伴走をひとまとめに</h2>
  <div class="grid2" style="grid-template-columns:1.15fr 1fr">
    <div>
      <table>
        <thead><tr><th style="width:34mm">区分</th><th>内容</th><th style="width:30mm">助成対象</th></tr></thead>
        <tbody>
          <tr><td><b>① カードリーダー</b></td><td>AB Circle CIR415A（Bluetooth・${yen(P.BT_PRICE)}/台）または CIR315A（USB・${yen(P.USB_PRICE)}/台）。事業所ごとの端末環境に合わせて機種と台数を選び、各事業所へお届けします。</td><td>①購入経費</td></tr>
          <tr><td><b>② 伴走支援</b><br><span class="note">（初回セットアップ 90〜120分）</span></td><td>電子請求受付システム等のID確認 → 介護情報基盤ポータルの初回登録 → 機器の接続・マイナ資格確認アプリの設定 → 動作確認。介護現場を知るスタッフが同席し、その場で助成金のオンライン申請までご一緒します。</td><td>②接続サポート等経費</td></tr>
          <tr><td><b>③ 1年間の運用サポート</b></td><td>導入後1年間、チャット・メール・電話でご相談いただけます。振込の確認、運用の困りごと、職員の入れ替わり時のご質問にも対応します。</td><td>②に含む</td></tr>
          <tr><td><b>金額調整</b></td><td>①＋②の合計が助成上限を超える分は「特別割引」で調整し、上限ぴったりに収めます（見積書の「金額調整」行）。</td><td>—</td></tr>
        </tbody>
      </table>
      <p class="note" style="margin-top:2mm">※ 助成対象は「介護情報基盤 助成金」の対象経費区分に基づく整理です。助成対象を超える台数は通常価格でのご購入（自己負担）となります。</p>
    </div>
    <div>
      <div class="card pink" style="margin-bottom:4mm"><h3>タダカヨが行うこと</h3><ul style="padding-left:5mm;font-size:10pt;line-height:1.7"><li>助成区分・台数の整理と見積書の発行</li><li>事前のID・パスワード類の確認（当日「進められない」を防ぐ）</li><li>機器のお届けと初回セットアップ</li><li>助成金オンライン申請の<b>支援</b>（画面を一緒に進めます）</li><li>1年間の運用相談</li></ul></div>
      <div class="card"><h3 style="color:#333">事業所さまにお願いすること</h3><ul style="padding-left:5mm;font-size:10pt;line-height:1.7"><li>介護情報基盤ポータルの利用登録（事業所名義）</li><li>助成金の<b>申請者は事業所さま</b>です（タダカヨは支援を行い、代行はいたしません）</li><li>領収書・請求書の保管（申請に使います）</li><li>セットアップ当日の担当者さまの同席（90〜120分）</li></ul></div>
    </div>
  </div>
  ${footer(4)}
</section>

<!-- 5 費用の仕組み -->
<section class="slide">
  <h2 class="title">費用の仕組み　—　助成金の上限に合わせて組み立てています</h2>
  <p class="lead">助成上限はサービス種別ごとに決まっています。上限の範囲では「機器代 ＋ 伴走支援費 − 金額調整 ＝ 上限額」となり、助成金で全額がまかなわれます。</p>
  <div class="plans" style="margin-bottom:6mm">
    ${Object.entries(P.PLANS).map(([k, p]) => `<div class="plan"><div class="h">${esc(PLAN_SHORT[k])}</div><div class="b"><div class="lim">${yen(p.limit)}</div><div class="q">助成対象 ${p.maxQty}台まで　／　伴走支援費 ${yen(P.ACCOMPANY_FEE[p.maxQty])}</div><div class="note" style="margin-top:1.5mm">${esc(p.label)}</div></div></div>`).join("")}
  </div>
  <div class="grid2">
    <div class="card">
      <h3>例：訪問・通所系で Bluetooth 3台の場合</h3>
      ${(() => { const a = P.computeAmounts("houmon", 3, 0, 0, 0); const w = (v) => (v / a.subsidyPartSubtotal * 100).toFixed(1) + "%"; return `
      <div class="bar">
        <div style="width:${w(a.devSubsidyIncl)};background:#333">機器<br>${yen(a.devSubsidyIncl)}</div>
        <div style="width:${w(a.accFeeIncl - a.discount)};background:var(--red)">伴走支援費<br>${yen(a.accFeeIncl)}</div>
        <div style="width:${w(a.discount)};background:#bbb;color:#333">調整<br>−${yen(a.discount)}</div>
      </div>
      <div class="legend"><span style="--c:#333">機器代</span><span style="--c:var(--red)">伴走支援費</span><span style="--c:#bbb">金額調整（特別割引）</span></div>
      <p style="font-size:10pt;margin-top:2.5mm">合計 <b>${yen(a.totalIncl)}</b> − 助成金 <b>${yen(a.grantAmt)}</b> ＝ ご負担 <b style="color:var(--red)">${yen(a.selfPay)}</b></p>`; })()}
    </div>
    <div class="card pink">
      <h3>ご負担が発生するケース</h3>
      <ul style="padding-left:5mm;font-size:10pt;line-height:1.75">
        <li><b>助成対象を超える台数</b>（例：居住・入所系で3台目）は、機器代を通常価格でご負担いただきます。</li>
        <li>複数のサービス種別を持つ事業所は、種別ごとの上限を<b>合算</b>できます（見積時に整理します）。</li>
        <li>助成金は<b>後払い精算</b>です。お支払いから振込まで、一時的な立て替えが生じます（次ページ）。</li>
        <li>すべて税込表示。助成金の上限額にも消費税分が含まれています。</li>
      </ul>
    </div>
  </div>
  ${footer(5)}
</section>

<!-- 6 流れ -->
<section class="slide">
  <h2 class="title">お申し込みから助成金の入金まで　—　7つのステップ</h2>
  <p class="lead" style="margin-bottom:2mm">赤のラベルはタダカヨが主に動くステップ、黒のラベルは事業所さまにお願いするステップです。どのステップも、タダカヨが横について進めます。</p>
  <div class="steps">
    <div class="step"><div class="no">1</div><h4>お申し込み</h4><p>添付の見積書の内容でご承認いただき、見積書のリンクまたはメールでお申し込み。事業所ごとに申し込めます。</p><div class="who">法人・事業所さま</div></div>
    <div class="step"><div class="no">2</div><h4>事前確認・日程調整</h4><p>電子請求受付システムのID等がお手元に揃っているか一緒に確認。不足があれば再発行の手順をご案内。</p><div class="who t">タダカヨ</div></div>
    <div class="step"><div class="no">3</div><h4>お届け・セットアップ</h4><p>カードリーダーをお届けし、ポータルの初回登録・機器接続・アプリ設定を90〜120分でご一緒に。</p><div class="who t">タダカヨ</div></div>
    <div class="step"><div class="no">4</div><h4>お支払い</h4><p>伴走支援後のお支払いか前払いかを選べます。前払いなら当日その場で申請支援まで進められます。</p><div class="who">事業所さま</div></div>
    <div class="step hl"><div class="no">5</div><h4>助成金の申請</h4><p>領収書をもとに、介護情報基盤ポータル（国保中央会）からオンライン申請。画面はタダカヨが一緒に進めます。</p><div class="who">事業所さま（支援あり）</div></div>
    <div class="step"><div class="no">6</div><h4>審査・振込</h4><p>申請月の翌月に審査、翌々月に事業所の指定口座へ振込（後払い精算）。振込の確認までサポートします。</p><div class="who">国保中央会</div></div>
    <div class="step"><div class="no">7</div><h4>1年間の伴走</h4><p>導入後1年、チャット・メール・電話で運用のご相談に対応。2027年1月の統合時のご案内も行います。</p><div class="who t">タダカヨ</div></div>
  </div>
  <h3 style="color:var(--red);font-size:12pt;margin-top:5mm">お金の流れ（目安）</h3>
  <div class="tl">
    <div class="m"><b>お支払い（月0）</b>セットアップ後、請求書に基づき事業所さまがお支払い</div>
    <div class="m"><b>申請（同月）</b>領収書を添えてポータルから申請。前払いなら当日に完了</div>
    <div class="m"><b>審査（翌月）</b>国保中央会が要件を確認</div>
    <div class="m"><b>振込（翌々月）</b>助成金が事業所口座へ。立て替え期間は約2か月</div>
  </div>
  ${footer(6)}
</section>

<!-- 7 確認事項 -->
<section class="slide">
  <h2 class="title">ご決裁の前にご確認いただきたいこと</h2>
  <div class="grid2" style="grid-template-columns:1.2fr 1fr">
    <ul class="chk">
      <li><span><b>申請の主体は各事業所さまです。</b>助成金の支給には、事業所が申請要件を満たしている必要があります。タダカヨは申請手続きの支援を行い、代行はいたしません。</span></li>
      <li><span><b>見積書の有効期限は ${ymdJp(input.validUntil)} です。</b>期限後は台数・機種を再確認のうえ、版を改めて発行します。</span></li>
      <li><span><b>お申し込み後も、台数・機種の変更ができます。</b>日程調整の際にご相談ください（変更後は見積書を改版します）。</span></li>
      <li><span><b>お支払い方法を選べます。</b>伴走支援後のお支払い、または前払い。前払いの場合はセットアップ当日にその場で申請支援まで進められます。</span></li>
      <li><span><b>助成金は事業所の指定口座へ、申請の翌々月に振り込まれます。</b>お支払いから約2か月の立て替えが生じます。</span></li>
      <li><span><b>セットアップ当日に必要なもの：</b>電子請求受付システムのID・パスワード、介護情報基盤ポータルの利用登録、担当者さまの同席（90〜120分）、カードリーダーを接続する端末。</span></li>
      <li><span><b>個人情報の取扱い：</b>ご提供いただく情報は本事業の連絡・機器のお届け・申請支援にのみ使用します（タダカヨはプライバシーマーク取得法人です）。</span></li>
    </ul>
    <div>
      <div class="card pink" style="margin-bottom:4mm"><h3>添付書類</h3>
        <table style="font-size:9.3pt"><thead><tr><th>見積番号</th><th>事業所</th><th class="num">ご負担額</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.estNo)}</td><td>${esc(r.name)}</td><td class="num">${yen(r.a.selfPay)}</td></tr>`).join("")}
        </tbody></table>
        <p class="note" style="margin-top:2mm">本資料のあとに、事業所ごとの見積書 ${n}通が続きます。</p>
      </div>
      <div class="card"><h3 style="color:#333">お問い合わせ</h3><p style="font-size:10pt;line-height:1.8">特定非営利活動法人タダカヨ　介護情報基盤 伴走支援事業<br>担当: ${esc(input.staff || "佐藤拡史")}<br>TEL 050-6872-9884　／　kjk@tadakayo.jp<br>https://kjk.tadakayo.jp</p></div>
    </div>
  </div>
  ${footer(7)}
</section>

<!-- 8 締め -->
<section class="slide">
  <h2 class="title">最後に　—　導入して終わりではなく、1年間そばにいます</h2>
  <div class="grid2" style="grid-template-columns:1.3fr 1fr;align-items:center;height:140mm">
    <div>
      <p style="font-size:13pt;line-height:1.9;margin-bottom:6mm">介護情報基盤への対応は、「機器を買う」ことよりも「現場が使い始められる」ことがゴールです。<br>タダカヨは介護現場を知るスタッフが、<strong style="color:var(--red)">対象確認から申請、その後の運用まで</strong>ご一緒します。</p>
      <div class="kv" style="grid-template-columns:repeat(3,1fr)">
        <div class="card"><div class="lbl">支援実績</div><div class="val ink">3,200<span style="font-size:11pt">事業所以上</span></div><div class="sub">全国40自治体・令和7年度ケアプランデータ連携</div></div>
        <div class="card"><div class="lbl">法人さまの実質ご負担</div><div class="val">${yen(T.self)}</div><div class="sub">${n}事業所・${T.units}台</div></div>
        <div class="card"><div class="lbl">申請期限</div><div class="val ink" style="font-size:15pt;padding-top:1.5mm">2027年<br>3月12日</div><div class="sub">早めのお申し込みが安心です</div></div>
      </div>
      <p class="note" style="margin-top:4mm">※ 支援実績は令和7年度ケアプランデータ連携システム導入支援の件数です。</p>
    </div>
    <div style="text-align:center"><img src="${CHARA(11)}" alt="" style="height:120mm"></div>
  </div>
  ${footer(8)}
</section>
</body></html>`;

fs.writeFileSync(outPath, html);
console.log(`wrote ${outPath}  offices=${n} total=${yen(T.total)} grant=${yen(T.grant)} self=${yen(T.self)}`);
