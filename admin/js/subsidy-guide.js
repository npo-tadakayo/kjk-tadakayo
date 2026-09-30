// 助成金申請の手順（A4 1枚）— 領収証メールに任意で同封する（2026-09-30 次田さん依頼）
//
// 正本: 国民健康保険中央会「助成金申請の手引き（令和8年度）」
//   https://www.kaigo-kiban-portal.jp/assets/pdf/r8_jyoseikin_tebiki.pdf
//   （必要書類4点 P7・領収書の書き方 P12・入力項目 P15〜22・申請後の流れ P29〜30）
// 手引きが改訂されたら、この文面も見直すこと（年度・申請期間・振込時期）。
//
// 領収証の金額（対象A・対象B・台数）を差し込み、申請画面の「どの欄に何を入れるか」を1枚で示す。
// 金額はここで計算しない。領収証画面に表示中の値（aIncl / bIncl）をそのまま受け取る。

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function yen(n) { const v = Number(n || 0); return (v < 0 ? "−" : "") + "¥" + Math.abs(v).toLocaleString("ja-JP"); }

export function renderSubsidyGuideHtml(g) {
  const a = Number(g.aIncl) || 0, b = Number(g.bIncl) || 0;
  return `
  <div class="sg">
    <div class="sg-head">
      <img src="/images/tadakayo_logo.png" alt="タダカヨ" class="sg-logo" onerror="this.remove()">
      <div>
        <div class="sg-title">介護情報基盤 助成金の申請手順</div>
        <div class="sg-sub">カードリーダーの購入費・接続サポート等経費（介護事業所向け・令和8年度）</div>
      </div>
    </div>
    <div class="sg-to">${esc(g.corpName || "")}${g.officeName ? `　${esc(g.officeName)}` : ""} 様　／　同封の領収証 ${esc(g.rcptNo || "")}</div>

    <div class="sg-keys">
      <div><b>申請期間</b>令和8年5月7日〜令和9年3月12日（予定）</div>
      <div><b>申請先</b>介護情報基盤ポータル → マイページ「各種申請」</div>
      <div><b>結果と振込</b>審査・通知は申請の翌月、振込は翌々月末まで</div>
      <div><b>注意</b>申請は<strong>1回限り</strong>。予算に達すると受付が終わることがあります</div>
    </div>

    <h2><span>1</span>申請の前に、次の4点をファイル（写真またはスキャンのPDF）にしておきます</h2>
    <table class="sg-t">
      <tr><td class="n">①</td><td><b>通帳の写し</b>　口座名義（カタカナ）・銀行コード・店番・口座番号が見えるページ</td></tr>
      <tr><td class="n">②</td><td><b>サービス種類が分かる書類</b>　指定通知書など（申請時点で有効なもの。複数サービスはそれぞれ）</td></tr>
      <tr class="hl"><td class="n">③</td><td><b>領収書の写し</b>　<strong>同封の領収証（PDF）をそのまま使えます</strong>。型名・台数・金額内訳・用途を記載済みです</td></tr>
      <tr><td class="n">④</td><td><b>介護WEBサービスの画面コピー</b>　管理者ユーザ（または一般ユーザ）でログインした「管理メニュー画面」。事業所番号と事業所名が写った状態で保存します（事業所ユーザの画面は認められない場合があります）</td></tr>
    </table>

    <h2><span>2</span>ポータルで申請します（入力する金額は領収証と同じにします）</h2>
    <ol class="sg-steps">
      <li>介護情報基盤ポータルにログインし、マイページの「<b>各種申請</b>」を押す</li>
      <li>「<b>カードリーダーの購入及び介護情報基盤との接続サポート等に係る経費</b>」を選び、事前確認画面の「申請する」を押す</li>
      <li>基本情報（事業所名・所在地・電話）を確認し、<b>サービス種類コード</b>を選ぶ</li>
      <li>金額などを下の表のとおり入力する</li>
      <li>口座情報を入力し、①〜④のファイルを添付する（最大5ファイル）</li>
      <li>「確認画面へ進む」→ 内容を確かめて「<b>申請する</b>」で完了（途中は「一時保存する」も可）</li>
    </ol>
    <table class="sg-t sg-amt">
      <thead><tr><th>申請画面の欄</th><th>入れる内容</th><th>領収証のどこか</th></tr></thead>
      <tr><td>カードリーダー購入費用（税込の総額）</td><td class="v">${yen(a)}</td><td>カードリーダー費の合計（対象A）</td></tr>
      <tr><td>カードリーダーの台数</td><td class="v">${esc(g.units ?? "")} 台</td><td>明細のカードリーダーの数量</td></tr>
      <tr><td>カードリーダーの種類</td><td class="v small">${esc(g.readerName || "マイナ資格確認アプリ対応のカードリーダー")}</td><td>明細の品名</td></tr>
      <tr><td>介護情報基盤との接続サポート費用（税込の総額）</td><td class="v">${yen(b)}</td><td>伴走支援費・接続サポート等経費の合計（対象B）</td></tr>
    </table>
    <p class="sg-note">総事業費・助成限度額・交付額は、画面で自動表示されます（交付額は千円未満切り捨て）。</p>

    <h2><span>3</span>申請のあと</h2>
    <ul class="sg-after">
      <li>国民健康保険中央会が審査し、<b>申請の翌月</b>に結果がメールで届きます。<b>翌々月末まで</b>に登録した口座へ振り込まれます</li>
      <li>書類に不備があると翌月にメールで連絡が来ます。直して<b>申請し直す</b>必要があり、受付はそこから翌月以降になります。申請後もメールを確認してください</li>
      <li>パソコン・タブレット、中古品・リース品は対象外です</li>
    </ul>

    <div class="sg-foot">
      <div>分からないところは、NPO法人タダカヨ（介護情報基盤伴走支援事業）へお気軽にどうぞ。申請画面を一緒に進めます。<br>
      TEL 050-6872-9884　／　kjk-staff@tadakayo.jp</div>
      <div class="sg-src">出典: 国民健康保険中央会「助成金申請の手引き（令和8年度）」。最新の要件は介護情報基盤ポータルのお知らせで確認してください。</div>
    </div>
  </div>`;
}

export const SUBSIDY_GUIDE_STYLE = `
.sg{width:210mm;box-sizing:border-box;padding:12mm 13mm 10mm;background:#fff;color:#111;font-family:"Noto Sans JP","Hiragino Sans",system-ui,sans-serif;font-size:9.6pt;line-height:1.6;}
.sg-head{display:flex;align-items:center;gap:12px;border-bottom:3px solid #E33535;padding-bottom:6px;margin-bottom:6px;}
.sg-logo{height:34px;}
.sg-title{font-size:16pt;font-weight:900;color:#E33535;letter-spacing:.02em;}
.sg-sub{font-size:9pt;color:#555;}
.sg-to{font-size:9pt;color:#333;margin:2px 0 8px;}
.sg-keys{display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;background:#FFE4EC;border-radius:6px;padding:7px 10px;margin-bottom:8px;font-size:9pt;}
.sg-keys b{display:inline-block;min-width:5.5em;color:#b02525;}
.sg h2{font-size:10.5pt;margin:9px 0 4px;display:flex;align-items:center;gap:6px;}
.sg h2 span{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#E33535;color:#fff;font-size:9pt;flex:none;}
.sg-t{width:100%;border-collapse:collapse;font-size:9pt;}
.sg-t td,.sg-t th{border:1px solid #e3dcd0;padding:3px 6px;vertical-align:top;}
.sg-t th{background:#F5F5F5;text-align:left;font-weight:700;}
.sg-t td.n{width:18px;text-align:center;color:#E33535;font-weight:700;}
.sg-t tr.hl td{background:#FFF6F8;}
.sg-amt td.v{font-weight:700;white-space:nowrap;text-align:right;color:#b02525;}
.sg-amt td.v.small{white-space:normal;text-align:left;color:#111;font-weight:500;font-size:8.6pt;}
.sg-steps{margin:0 0 6px;padding-left:20px;font-size:9.2pt;}
.sg-steps li{margin:1px 0;}
.sg-note{font-size:8.4pt;color:#555;margin:3px 0 0;}
.sg-after{margin:0;padding-left:18px;font-size:9.2pt;}
.sg-after li{margin:1px 0;}
.sg-foot{margin-top:9px;border-top:1px solid #e3dcd0;padding-top:6px;font-size:8.8pt;}
.sg-src{font-size:7.8pt;color:#666;margin-top:3px;}
`;

// A4 1枚の PDF（base64）を作る。window.html2pdf が読み込まれている前提（supply-print.html）
export async function buildSubsidyGuidePdf(g) {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;background:#fff";
  const st = document.createElement("style"); st.textContent = SUBSIDY_GUIDE_STYLE;
  holder.appendChild(st);
  holder.insertAdjacentHTML("beforeend", renderSubsidyGuideHtml(g));
  document.body.appendChild(holder);
  try {
    const el = holder.querySelector(".sg");
    // 1ページに収める: 高さが A4 を超えたら、幅を広げて描いて A4 幅へ縮めて貼る（見積書と同じ方法）
    const PX = 96 / 25.4; let w = 210;
    for (let i = 0; i < 4; i++) {
      const eff = (el.getBoundingClientRect().height / PX) * 210 / w;
      if (eff <= 295) break;
      w = w * (eff / 295) * 1.01; el.style.width = w + "mm"; holder.style.width = w + "mm";
    }
    const opt = { margin: 0, image: { type: "jpeg", quality: 0.95 }, html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }, pagebreak: { mode: ["avoid-all", "css"] } };
    const uri = await window.html2pdf().set(opt).from(el).outputPdf("datauristring");
    return String(uri || "").split(",")[1] || "";
  } finally { holder.remove(); }
}
