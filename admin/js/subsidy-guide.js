// 助成金申請の手順（A4・8ページ）— 領収証メールに任意で同封する
//   2026-09-30 1枚版を作成 → 同日「実際の画面を入れて、枚数が増えてもよい」（次田さん）で8ページに拡張
//
// 正本: 国民健康保険中央会「助成金申請の手引き（令和8年度）」令和8年7月版
//   https://www.kaigo-kiban-portal.jp/assets/pdf/r8_jyoseikin_tebiki.pdf
// 画面の画像は同手引きからの引用（admin/images/subsidy-guide/ ・ファイル名の pNN が手引きのページ）。
//   ガイドブック（介護情報基盤編）と同じく「公式マニュアル画面の引用＋出典明記」の方針（2026-08-07 合意）。
//   手引きが改訂されたら、画像と文面を両方見直すこと（年度・申請期間・振込時期・画面）。
//
// 領収証の金額（対象A・対象B・台数・型名）を差し込み、申請画面の「どの欄に何を入れるか」を示す。
// 金額はここで計算しない。領収証画面に表示中の値（aIncl / bIncl）をそのまま受け取る。

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function yen(n) { const v = Number(n || 0); return (v < 0 ? "−" : "") + "¥" + Math.abs(v).toLocaleString("ja-JP"); }

const IMG = "/images/subsidy-guide/";
const SRC = "国民健康保険中央会「助成金申請の手引き（令和8年度）」";
const TOTAL = 8;

function fig(file, page, width, alt) {
  return `<figure class="sg-fig" style="width:${width}mm">
    <img src="${IMG}${file}" alt="${esc(alt)}" crossorigin="anonymous">
    <figcaption>出典: ${SRC} P.${page}</figcaption></figure>`;
}
function head(n, sec) {
  return `<div class="sg-bar"><span class="sg-bar-t">介護情報基盤 助成金の申請手順</span><span class="sg-bar-s">${esc(sec)}</span><span class="sg-bar-n">${n} / ${TOTAL}</span></div>`;
}
function foot() {
  return `<div class="sg-pfoot">分からないところは NPO法人タダカヨ（介護情報基盤伴走支援事業）へ　TEL 050-6872-9884 ／ kjk-staff@tadakayo.jp</div>`;
}
// 入力する値の吹き出し
function val(label, v) { return `<div class="sg-val"><div class="k">${label}</div><div class="v">${v}</div></div>`; }

export function renderSubsidyGuideHtml(g) {
  const a = Number(g.aIncl) || 0, b = Number(g.bIncl) || 0;
  const units = esc(g.units ?? "");
  const reader = esc(g.readerName || "マイナ資格確認アプリ対応のカードリーダー");
  const to = `${esc(g.corpName || "")}${g.officeName ? `　${esc(g.officeName)}` : ""}`;

  const p1 = `
  <section class="sgp">
    <div class="sg-cover">
      <img src="/images/tadakayo_logo.png" alt="タダカヨ" class="sg-logo" crossorigin="anonymous" onerror="this.remove()">
      <div>
        <div class="sg-title">介護情報基盤 助成金の申請手順</div>
        <div class="sg-sub">カードリーダーの購入費・接続サポート等経費（介護事業所向け・令和8年度）</div>
      </div>
    </div>
    <div class="sg-to">${to} 様　／　同封の領収証 ${esc(g.rcptNo || "")}</div>
    <p class="sg-lead">導入おつかれさまでした。この冊子は、同封の領収証を使って<strong>介護情報基盤ポータルから助成金を申請する手順</strong>を、実際の画面で説明したものです。上から順に進めれば、1回で申請が終わるように作っています。</p>

    <div class="sg-keys">
      <div><b>申請期間</b>令和8年5月7日〜令和9年3月12日（予定）</div>
      <div><b>申請先</b>介護情報基盤ポータル → マイページ「各種申請」</div>
      <div><b>結果と振込</b>審査・通知は申請の翌月、振込は翌々月末まで</div>
      <div><b>注意</b>申請は<strong>1事業所1回限り</strong>。予算に達すると受付が終わることがあります</div>
    </div>

    <h2 class="sg-h">申請の流れ</h2>
    <div class="sg-flow">
      <div><span>1</span>書類を4点<br>そろえる<small>P.2〜3</small></div><i>›</i>
      <div><span>2</span>ポータルで<br>入力する<small>P.4〜6</small></div><i>›</i>
      <div><span>3</span>書類を添付して<br>申請する<small>P.7</small></div><i>›</i>
      <div><span>4</span>翌月 審査<br>翌々月末 振込<small>P.8</small></div>
    </div>

    <h2 class="sg-h">あなたの申請で入力する数字（同封の領収証と同じです）</h2>
    <table class="sg-t sg-amt">
      <thead><tr><th>申請画面の欄</th><th>入れる内容</th><th>領収証のどこか</th><th>頁</th></tr></thead>
      <tr><td>カードリーダー購入費用（税込の総額）</td><td class="v">${yen(a)}</td><td>カードリーダー費の合計（対象A）</td><td class="c">P.5</td></tr>
      <tr><td>カードリーダーの台数</td><td class="v">${units} 台</td><td>明細のカードリーダーの数量</td><td class="c">P.5</td></tr>
      <tr><td>カードリーダーの種類</td><td class="v small">「マイナ資格確認アプリに対応したカードリーダーである」にチェック<br>（${reader}）</td><td>明細の品名</td><td class="c">P.5</td></tr>
      <tr><td>介護情報基盤との接続サポート費用（税込の総額）</td><td class="v">${yen(b)}</td><td>伴走支援費・接続サポート等経費の合計（対象B）</td><td class="c">P.5</td></tr>
    </table>
    <p class="sg-note">総事業費（A＋B）・助成限度額・交付額は画面で自動表示されます。交付額は千円未満切り捨てです。金額は領収書と一致している必要があります。</p>

    <h2 class="sg-h">そろえる書類（4点・写真かスキャンのファイル）</h2>
    <div class="sg-docs">
      <label>□ ① 通帳の写し<small>P.2</small></label>
      <label>□ ② サービス種類が分かる書類（指定通知書など）<small>P.2</small></label>
      <label>□ ③ 領収書の写し ＝ <strong>同封の領収証 PDF</strong><small>P.3</small></label>
      <label>□ ④ 介護WEBサービスの「管理メニュー」の画面コピー<small>P.3</small></label>
    </div>
    <div class="sg-toc">
      <b>もくじ</b>　1 全体像 ／ 2 書類①通帳・サービス種類 ／ 3 書類②領収書・介護WEBの画面コピー ／ 4 申請の開始・基本情報 ／ 5 金額の入力 ／ 6 口座・書類の添付① ／ 7 書類の添付②と申請 ／ 8 申請のあと
    </div>
    ${foot()}
  </section>`;

  const p2 = `
  <section class="sgp">
    ${head(2, "書類の準備①")}
    <h2 class="sg-h">① 通帳の写し</h2>
    <p>口座名義（カタカナ）・銀行コード・店番・口座番号・預金種目（普通/当座）が見える部分を、写真かスキャンでファイルにします。キャッシュカード、通帳の見開き、ネット銀行の口座情報の画面のどれでも構いません。</p>
    ${fig("p09_tsucho.jpg", 9, 184, "通帳の写しの例")}
    <div class="sg-two">
      <div>
        <h2 class="sg-h">② サービス種類が分かる書類</h2>
        <p>指定通知書など、<strong>サービス種類（またはサービス種類コード）</strong>が書かれた書類です。写真かスキャンでファイルにします。</p>
        <ul class="sg-ul">
          <li>申請する時点で有効なものを使います</li>
          <li>複数のサービス種類で申請するときは、それぞれの書類を用意します</li>
          <li>指定のあとに事業所名や所在地が変わった場合は、変更届出書なども一緒に用意します</li>
        </ul>
      </div>
      ${fig("p10_shitei.jpg", 10, 62, "指定通知書の例")}
    </div>
    ${foot()}
  </section>`;

  const p3 = `
  <section class="sgp">
    ${head(3, "書類の準備②")}
    <h2 class="sg-h">③ 領収書の写し — <span class="sg-red">同封の領収証（PDF）をそのまま使えます</span></h2>
    <p>手引きでは、カードリーダーの<strong>型名（または商品名）・購入台数・金額内訳</strong>と、「接続サポート等経費」などの<strong>用途</strong>が書かれていることが求められています。同封の領収証は、この形で作っています。「〇〇一式」のような書き方は交付されない場合があります。</p>
    ${fig("p12_ryoshusho.jpg", 12, 184, "領収書の書き方の例")}
    <div class="sg-two">
      ${fig("p14_web_menu.jpg", 14, 108, "介護WEBサービスの管理メニュー画面")}
      <div>
        <h2 class="sg-h">④ 介護WEBサービスの画面コピー</h2>
        <ol class="sg-ol">
          <li>介護WEBサービスに<strong>管理者ユーザ（または一般ユーザ）</strong>でログインします</li>
          <li>「管理メニュー」画面を表示します</li>
          <li>画面の右上の<strong>事業所番号と事業所名</strong>が写るように画面コピーを保存します<br><small>Windows は「Windows＋Shift＋S」で範囲を選んで保存できます</small></li>
        </ol>
        <p class="sg-warn">事業所ユーザ（KJ始まりのID）の画面は、認められない場合があります。</p>
      </div>
    </div>
    ${foot()}
  </section>`;

  const p4 = `
  <section class="sgp">
    ${head(4, "申請の開始・基本情報")}
    <h2 class="sg-h">申請画面を開く</h2>
    <div class="sg-two">
      ${fig("p15_shinsei_kaishi.jpg", 15, 118, "各種申請から事前確認まで")}
      <ol class="sg-ol">
        <li>介護情報基盤ポータルに<strong>ログイン</strong>し、右上の人のマークから<strong>マイページ</strong>を開きます</li>
        <li>「申請情報」の<strong>「各種申請」</strong>を押します</li>
        <li>「助成金申請」の<strong>「カードリーダー等の購入及び介護情報基盤との接続サポート等に係る助成金」</strong>を押します</li>
        <li>事前確認の画面で、下の<strong>「申請する」</strong>を押します</li>
      </ol>
    </div>
    <h2 class="sg-h">基本情報を確かめる</h2>
    <div class="sg-two">
      ${fig("p16_kihon.jpg", 16, 118, "申請情報の入力 基本情報")}
      <div>
        <p>申請日・介護事業所番号は、はじめから表示されています。</p>
        <p>介護事業所名称・所在地・電話番号は、ポータルに登録した内容が入っています。<strong>変わっているところがあれば上書き</strong>してください。空欄があれば入力します。</p>
        ${val("介護事業所名称", esc(g.officeName || "") || "（事業所名）")}
      </div>
    </div>
    ${foot()}
  </section>`;

  const p5 = `
  <section class="sgp">
    ${head(5, "金額の入力")}
    <h2 class="sg-h">助成金情報・カードリーダー購入費用（A）</h2>
    <div class="sg-two">
      ${fig("p17_cardreader.jpg", 17, 118, "助成金情報とカードリーダー購入費用")}
      <div>
        <p><b>サービス種類コード</b>　補助対象（例: 訪問・通所・短期滞在系）とサービス種類を選びます。複数あるときは「追加する」で足します。</p>
        ${val("購入額（税込）", yen(a))}
        ${val("カードリーダーの種類", "「マイナ資格確認アプリに対応したカードリーダーである」にチェック")}
        ${val("カードリーダーの台数", `${units} 台`)}
      </div>
    </div>
    <h2 class="sg-h">介護情報基盤との接続サポート費用（B）と交付額</h2>
    <div class="sg-two">
      ${fig("p18_support.jpg", 18, 118, "接続サポート費用と交付額")}
      <div>
        ${val("サポート費用（税込）", yen(b))}
        <p>入力すると、①総事業費（A＋B）②助成限度額 ③選定額（①と②の低い方）④交付額（千円未満切り捨て）が自動で表示されます。</p>
        <p>備考は任意です。金額や添付書類で補足したいことがあれば書きます。</p>
      </div>
    </div>
    ${foot()}
  </section>`;

  const p6 = `
  <section class="sgp">
    ${head(6, "口座・書類の添付①")}
    <h2 class="sg-h">口座情報（助成金の振込先）</h2>
    <div class="sg-two">
      ${fig("p19_koza.jpg", 19, 118, "口座情報の入力")}
      <div>
        <ul class="sg-ul">
          <li>「銀行口座」か「ゆうちょ銀行」を選びます</li>
          <li>銀行名・支店名は、名前かコードを入れて候補から選びます</li>
          <li>口座番号は7桁の半角数字です</li>
          <li>口座名義はカタカナで入力します</li>
        </ul>
        <p class="sg-warn">必ず、添付する通帳の写し（P.2）を見ながら入力してください。</p>
      </div>
    </div>
    <h2 class="sg-h">必要書類の添付①　通帳の写し・サービス種類が分かる書類</h2>
    <div class="sg-two">
      ${fig("p21_tenpu1.jpg", 21, 118, "通帳の写しとサービス種類の書類の添付")}
      <div>
        <p>「ファイルを選択する」を押してファイルを選ぶか、枠の中へドラッグ＆ドロップします。</p>
        <ul class="sg-ul">
          <li>通帳の写し → P.2 の①</li>
          <li>サービス種類が分かる書類 → P.2 の②</li>
          <li>ファイルは PDF・JPG・PNG、1つ20MBまで</li>
        </ul>
      </div>
    </div>
    ${foot()}
  </section>`;

  const p7 = `
  <section class="sgp">
    ${head(7, "書類の添付②と申請")}
    <h2 class="sg-h">必要書類の添付②　領収書・介護WEBサービスの画面コピー → 申請</h2>
    <div class="sg-two">
      ${fig("p22_tenpu2.jpg", 22, 112, "領収書と画面コピーの添付、確認、申請")}
      <div>
        <ol class="sg-ol">
          <li><b>領収書等</b>に、<strong>同封の領収証（PDF）</strong>を添付します（P.3 の③）</li>
          <li><b>介護WEBサービスの画面コピー</b>に、P.3 の④で保存した画面を添付します</li>
          <li>途中で止めるときは「一時保存する」</li>
          <li>「<strong>確認画面へ進む</strong>」を押し、内容を確かめます</li>
          <li>いちばん下の「<strong>申請する</strong>」を押すと申請が完了します</li>
        </ol>
        <div class="sg-check">
          <b>申請する前のチェック</b>
          <label>□ 購入額 ${yen(a)}・台数 ${units} 台・サポート費用 ${yen(b)} が領収証と同じ</label>
          <label>□ 口座情報が通帳の写しと同じ</label>
          <label>□ 4つの書類をすべて添付した</label>
          <label>□ 事業所名・所在地・電話番号が最新</label>
        </div>
      </div>
    </div>
    <h2 class="sg-h">同封の領収証 PDF の保存のしかた</h2>
    <ol class="sg-ol">
      <li>このメールに添付されている<strong>領収証の PDF（RCPT-で始まる名前）</strong>を、パソコンに保存します（添付ファイルを開き、ダウンロードまたは「名前を付けて保存」）</li>
      <li>申請画面の「領収書等」で「ファイルを選択する」を押し、保存した PDF を選びます</li>
    </ol>
    <p class="sg-note">この冊子（助成金申請の手順）は添付しなくて構いません。</p>
    ${foot()}
  </section>`;

  const p8 = `
  <section class="sgp">
    ${head(8, "申請のあと")}
    <h2 class="sg-h">申請のあとの流れ</h2>
    <div class="sg-timeline">
      <div><b>申請した月</b>申請が受け付けられます</div><i>›</i>
      <div><b>翌月</b>国民健康保険中央会が審査し、結果がメールで届きます</div><i>›</i>
      <div><b>翌々月末まで</b>登録した口座に助成金が振り込まれます</div>
    </div>
    <p class="sg-note">令和9年2月1日〜3月12日（予定）の申請は、結果の通知が3月末まで、振込が4月末までです。</p>
    <h2 class="sg-h">申請した内容を確かめる・直す</h2>
    ${fig("p33_kakunin.jpg", 33, 184, "申請内容の確認と修正")}
    <p>マイページの「申請一覧」→「受付番号」で内容を確認できます。一定の期間は「申請内容を更新する」から直せます（直し方は新しく申請するときと同じです）。</p>
    <h2 class="sg-h">よくあること</h2>
    <ul class="sg-ul">
      <li><b>書類に不備があったとき</b>　翌月にメールで連絡が来ます。直して申請し直すと、受付はそこから翌月以降になります。申請後もメールを確認してください</li>
      <li><b>対象外のもの</b>　パソコン・タブレット・スマートフォン、中古品・リース品は対象外です</li>
      <li><b>予算</b>　予算に達すると、期間内でも受付が終わることがあります。お早めの申請をおすすめします</li>
    </ul>
    <div class="sg-help">申請画面で迷ったら、タダカヨがお電話で一緒に進めます。<br>NPO法人タダカヨ（介護情報基盤伴走支援事業）　TEL 050-6872-9884 ／ kjk-staff@tadakayo.jp</div>
    <div class="sg-src">画面の画像と手順は ${SRC}（令和8年7月版）から引用しています。最新の要件は介護情報基盤ポータルのお知らせで確認してください。</div>
  </section>`;

  return `<div class="sg">${p1}${p2}${p3}${p4}${p5}${p6}${p7}${p8}</div>`;
}

export const SUBSIDY_GUIDE_STYLE = `
.sg{width:210mm;color:#111;font-family:"Noto Sans JP","Hiragino Sans",system-ui,sans-serif;}
/* 高さを A4 ちょうど（297mm）にすると描画の端数で1pxはみ出し、各ページのあとに白紙が入る → 296mm */
.sgp{width:210mm;height:296mm;box-sizing:border-box;padding:11mm 12mm 9mm;background:#fff;position:relative;overflow:hidden;font-size:9.4pt;line-height:1.6;}
.sgp p{margin:0 0 5px;}
.sg-cover{display:flex;align-items:center;gap:12px;border-bottom:3px solid #E33535;padding-bottom:6px;margin-bottom:6px;}
.sg-logo{height:36px;}
.sg-title{font-size:17pt;font-weight:900;color:#E33535;letter-spacing:.02em;}
.sg-sub{font-size:9pt;color:#555;}
.sg-to{font-size:9pt;color:#333;margin:2px 0 6px;}
.sg-lead{font-size:9.6pt;}
.sg-bar{display:flex;align-items:baseline;gap:10px;border-bottom:2px solid #E33535;padding-bottom:4px;margin-bottom:6px;}
.sg-bar-t{font-weight:900;color:#E33535;font-size:10.5pt;}
.sg-bar-s{font-weight:700;font-size:10.5pt;}
.sg-bar-n{margin-left:auto;font-size:8.5pt;color:#666;}
.sg-keys{display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;background:#FFE4EC;border-radius:6px;padding:7px 10px;margin:6px 0 4px;font-size:9pt;}
.sg-keys b{display:inline-block;min-width:5.5em;color:#b02525;}
.sg-h{font-size:10.6pt;font-weight:800;margin:8px 0 4px;padding-left:7px;border-left:4px solid #E33535;line-height:1.35;}
.sg-red{color:#c02828;}
.sg-flow{display:flex;align-items:center;gap:4px;margin:4px 0 2px;}
.sg-flow>div{flex:1;background:#F5F5F5;border-radius:8px;padding:6px 6px 5px;text-align:center;font-size:9pt;font-weight:700;line-height:1.35;}
.sg-flow>div span{display:block;margin:0 auto 3px;width:20px;height:20px;border-radius:50%;background:#E33535;color:#fff;line-height:20px;font-size:9.5pt;}
.sg-flow>div small{display:block;color:#888;font-weight:400;font-size:7.8pt;margin-top:2px;}
.sg-flow>i{font-style:normal;color:#E33535;font-size:16pt;font-weight:900;}
.sg-t{width:100%;border-collapse:collapse;font-size:9pt;}
.sg-t td,.sg-t th{border:1px solid #e3dcd0;padding:4px 6px;vertical-align:middle;}
.sg-t th{background:#F5F5F5;text-align:left;font-weight:700;}
.sg-amt td.v{font-weight:800;white-space:nowrap;text-align:right;color:#b02525;font-size:10pt;}
.sg-amt td.v.small{white-space:normal;text-align:left;color:#111;font-weight:500;font-size:8.4pt;}
.sg-amt td.c{text-align:center;color:#666;width:34px;}
.sg-note{font-size:8.3pt;color:#555;}
.sg-docs{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;border:1px dashed #E33535;border-radius:6px;padding:6px 9px;font-size:9pt;}
.sg-docs small{color:#888;margin-left:6px;font-size:7.8pt;}
.sg-toc{margin-top:8px;background:#F5F5F5;border-radius:6px;padding:6px 9px;font-size:8.4pt;color:#333;}
.sg-fig{margin:4px 0 6px;flex:none;}
.sg-fig img{display:block;width:100%;height:auto;border:1px solid #d9d2c5;border-radius:3px;}
.sg-fig figcaption{font-size:7.2pt;color:#777;margin-top:2px;}
.sg-two{display:flex;gap:9px;align-items:flex-start;}
.sg-two>div,.sg-two>ol,.sg-two>ul{flex:1;min-width:0;}
.sg-ol,.sg-ul{margin:2px 0 5px;padding-left:17px;}
.sg-ol li,.sg-ul li{margin:2px 0;}
.sg-ol small{color:#666;font-size:8pt;}
.sg-warn{background:#FFF3E0;border-left:3px solid #c87a1f;padding:4px 7px;font-size:8.8pt;border-radius:0 4px 4px 0;}
.sg-val{border:1.5px solid #E33535;border-radius:6px;padding:4px 7px;margin:5px 0;background:#FFF6F8;}
.sg-val .k{font-size:8pt;color:#b02525;font-weight:700;}
.sg-val .v{font-size:11pt;font-weight:800;line-height:1.35;}
.sg-check{margin-top:6px;border:1px dashed #E33535;border-radius:6px;padding:6px 8px;font-size:8.8pt;}
.sg-check b{display:block;color:#b02525;margin-bottom:2px;}
.sg-check label{display:block;margin:2px 0;}
.sg-timeline{display:flex;align-items:stretch;gap:4px;}
.sg-timeline>div{flex:1;background:#F5F5F5;border-radius:8px;padding:6px 8px;font-size:8.8pt;}
.sg-timeline>div b{display:block;color:#b02525;font-size:10pt;}
.sg-timeline>i{align-self:center;font-style:normal;color:#E33535;font-size:16pt;font-weight:900;}
.sg-help{margin-top:6px;background:#FFE4EC;border-radius:6px;padding:7px 10px;font-size:9pt;}
.sg-src{font-size:7.6pt;color:#666;margin-top:5px;}
.sg-pfoot{position:absolute;left:12mm;right:12mm;bottom:6mm;border-top:1px solid #e3dcd0;padding-top:3px;font-size:7.6pt;color:#777;}
`;

// 画像の読み込みを待つ（html2canvas は描画時点で読めていない画像を空白にする）
async function waitImages(root) {
  // 読み込み済み（成功・失敗とも complete=true）は待たない。失敗済みの画像はイベントが二度と来ないため
  // 念のため上限8秒で打ち切る（画像が1枚欠けても PDF 自体は作れるように）
  const each = [...root.querySelectorAll("img")].map((im) => im.complete
    ? Promise.resolve()
    : new Promise((r) => { im.addEventListener("load", r, { once: true }); im.addEventListener("error", r, { once: true }); }));
  await Promise.race([Promise.all(each), new Promise((r) => setTimeout(r, 8000))]);
}

// A4・8ページの PDF（base64）を作る。window.html2pdf が読み込まれている前提（supply-print.html）
export async function buildSubsidyGuidePdf(g) {
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;background:#fff";
  const st = document.createElement("style"); st.textContent = SUBSIDY_GUIDE_STYLE;
  holder.appendChild(st);
  holder.insertAdjacentHTML("beforeend", renderSubsidyGuideHtml(g));
  document.body.appendChild(holder);
  try {
    await waitImages(holder);
    const pages = [...holder.querySelectorAll(".sgp")];
    const opt = { margin: 0, image: { type: "jpeg", quality: 0.9 }, html2canvas: { scale: 1.8, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" } };
    // 1ページずつ描いて足す（CSSの改ページに頼ると、端数で白紙ページが挟まることがあるため）
    let worker = window.html2pdf().set(opt).from(pages[0]).toPdf();
    for (const p of pages.slice(1)) {
      worker = worker.get("pdf").then((pdf) => { pdf.addPage(); }).from(p).toContainer().toCanvas().toPdf();
    }
    const uri = await worker.outputPdf("datauristring");
    return String(uri || "").split(",")[1] || "";
  } finally { holder.remove(); }
}
