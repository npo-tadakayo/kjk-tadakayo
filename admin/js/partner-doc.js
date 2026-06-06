// 認定事業所向け書類（協定書・説明資料）のHTML生成。タダカヨ ブランドカラー（赤系）。
// html2pdf で PDF 化される前提（partner-admin.js から呼ぶ）。

const RED = "#E33535", DARK = "#c02828", LIGHT = "#FFE4EC", INK = "#1a1a1a", MUTED = "#555";
function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
const HOST = { name:"NPO法人タダカヨ", biz:"介護情報基盤伴走支援事業（タダサポ＋）" };

function styleBlock(){
  return `<style>
    .doc{font-family:'Noto Sans JP','Hiragino Sans',sans-serif;color:${INK};width:760px;margin:0 auto;background:#fff;line-height:1.7;font-size:13px}
    .doc h1,.doc h2,.doc h3{font-family:'Noto Serif JP',serif;margin:0}
    .doc .band{background:${RED};color:#fff;padding:18px 28px}
    .doc .band .host{font-size:12px;opacity:.92}
    .doc .band h1{font-size:20px;margin-top:4px}
    .doc .inner{padding:22px 30px 34px}
    .doc h2{font-size:15px;color:${RED};border-left:5px solid ${RED};padding-left:10px;margin:18px 0 8px}
    .doc h3{font-size:13px;margin:12px 0 4px;color:${DARK}}
    .doc p{margin:5px 0}
    .doc table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
    .doc th,.doc td{border:1px solid #e3ddd5;padding:6px 8px;text-align:left}
    .doc th{background:${LIGHT};color:${DARK};font-weight:600}
    .doc .muted{color:${MUTED};font-size:11px}
    .doc .art{margin:9px 0}
    .doc .art b{color:${INK}}
    .doc .note{background:#fff7f8;border:1px solid ${LIGHT};border-radius:8px;padding:10px 12px;font-size:11px;color:${MUTED};margin-top:14px}
    .doc .sign{margin-top:18px;border-top:1px solid #e3ddd5;padding-top:12px;font-size:12px}
    .doc .seg{display:flex;gap:10px;flex-wrap:wrap}
    .doc .chip{background:${LIGHT};color:${DARK};border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600}
    .doc .cover-to{font-size:15px;font-weight:600;margin:10px 0 2px}
    .pb{page-break-before:always}
    h2,h3{page-break-after:avoid}
    table{page-break-inside:avoid}
  </style>`;
}

// ---- 協定書 ----
export function agreementHTML(p, s = {}){
  const hostName = s.poIssuerName || HOST.name;
  const hostAddr = s.poIssuerAddr || "（甲の所在地）";
  const hostRep  = s.poIssuerRep  || "理事長";
  const otsu = esc(p.company || "（乙の法人名）");
  const A = (no, title, body) => `<div class="art"><b>第${no}条（${title}）</b><br>${body}</div>`;
  return `${styleBlock()}<div class="doc">
    <div class="band"><div class="host">${esc(hostName)} ／ ${HOST.biz}</div><h1>タダサポ 介護情報基盤版 パートナーシップ協定書</h1></div>
    <div class="inner">
      <p>${esc(hostName)}（以下「甲」という）と、<b>${otsu}</b>（以下「乙」という）は、タダサポ 介護情報基盤版プログラム（以下「本プログラム」）の普及・推進に関し、対等なパートナーとして協力するため、次のとおり協定を締結する。</p>
      ${A(1,"目的","介護事業所等の介護情報基盤への対応を支援するため、甲が乙にカードリーダー等の卸供給および支援プログラムを提供し、乙が地域で伴走支援を行うことにより、地域介護の質的向上に共同して貢献することを目的とする。")}
      ${A(2,"定義","本プログラム＝デバイス供給・設定支援・操作研修・助成金申請支援を含む一連のサービス。対象デバイス＝マイナ資格確認アプリ対応カードリーダー。エンド事業所＝乙が支援する介護事業所等。認定基準＝甲が定める別紙1。")}
      ${A(3,"乙の役割","(1)案内・説明 (2)申込支援 (3)デバイスの受取・配送/持参 (4)初期設定・操作研修 (5)助成金申請支援 (6)一次受付・甲へのエスカレーション (7)甲のパートナー研修の受講（年1回以上）と認定基準の継続遵守。")}
      ${A(4,"甲の役割","(1)対象デバイスの卸供給（別紙2） (2)マニュアル・申請テンプレ提供 (3)導入支援研修 (4)エスカレーション対応（原則3営業日以内） (5)制度改正・価格変更の適時通知。")}
      ${A(5,"デバイスの供給条件","卸価格・送料・発注受注は別紙2・別紙3による。乙はエンド事業所以外の第三者へ販売しない。製品保証は製造者の定めによる（納品後1年）。")}
      ${A(6,"支援費の設定","乙がエンド事業所から収受する伴走支援費は、デバイス代と合計して助成金上限を超えない範囲で乙が自由に設定できる。")}
      ${A(7,"任意寄付","乙は本プログラムの趣旨に賛同する場合に限り、任意で甲へ寄付できる（1件¥3,000〜¥5,000程度を目安として案内・義務ではない）。")}
      ${A(8,"遵守事項・禁止行為","(1)なりすまし禁止（本人の操作・申請を代行しない） (2)実質的還元・不当な利益供与の禁止 (3)虚偽説明の禁止（助成金交付を確約しない） (4)押し売りの禁止 (5)利用者の尊厳への配慮。")}
      ${A(9,"知的財産・商標","甲は乙に「タダサポ」「タダカヨ」「認定事業所」の名称・ロゴの非独占的使用を本プログラムの範囲で許諾する。「認定」は任意認定であり公的資格でない旨を誤認させない表示とする。")}
      ${A(10,"個人情報の取扱い","個人情報保護法および厚労省ガイダンスに従い適切に管理する。<b>乙は伴走支援の過程でエンド事業所のパスワード・暗証番号・口座情報を預からない／メモして持ち帰らない。</b>甲はPマーク認証規程に準拠する。")}
      ${A(11,"秘密保持","本協定の履行で知り得た相手方の秘密情報（卸価格等を含む）を、書面承諾なく第三者に開示・漏洩しない。本協定終了後も存続する。")}
      ${A(12,"免責","甲はデバイス製造者の品質・不具合、および助成金の採択・不採択について責任を負わない。")}
      ${A(13,"報告・モニタリング","乙は甲所定の様式により支援実績を定期報告する。甲は必要に応じ業務状況を確認でき、乙は協力する。")}
      ${A(14,"有効期間","締結日から1年間。満了1か月前までに書面の更新拒絶がなければ同一条件で1年自動更新し以降も同様。更新時、甲は認定基準の充足を再確認できる。")}
      ${A(15,"解除・認定取消","乙が認定基準・遵守事項・個人情報・秘密保持に重大に違反した場合、甲は催告なく認定の一時停止・取消および解除ができる。段階的措置は認定基準による。")}
      ${A(16,"反社会的勢力の排除","甲乙は自らが反社会的勢力でないことを表明・確約し、反した場合、相手方は催告なく解除できる。")}
      ${A(17,"権利義務の譲渡禁止","相手方の書面承諾なく本協定上の地位・権利義務を第三者に譲渡・承継させない。")}
      ${A(18,"協議・管轄・準拠法","定めのない事項は誠実に協議する。紛争は甲の所在地を管轄する地方裁判所を専属的合意管轄とし、日本国法に準拠する。")}
      <div class="sign">
        本協定の成立を証するため本書2通を作成し、甲乙記名押印のうえ各1通を保有する。<br><br>
        ${p.date ? esc(p.date) : "　　　　年　　月　　日"}<br><br>
        （甲）所在地：${esc(hostAddr)}　名称：${esc(hostName)}　代表者：${esc(hostRep)}　　　　　印<br><br>
        （乙）所在地：${esc(p.address || "")}　法人名：${otsu}　代表者：${esc(p.rep || "")}　　　　　印
      </div>
      <div class="note">本書は案（ドラフト）です。締結前に弁護士・税理士のリーガル/税務チェックを受けてください。別紙：1 認定事業者基準／2 カードリーダー価格表・送料規定／3 発注受注管理仕様書。</div>
    </div></div>`;
}

// ---- 説明資料（配布用ドキュメント） ----
export function briefingHTML(p, s = {}){
  const to = p.company ? `${esc(p.company)} 御中` : "";
  return `${styleBlock()}<div class="doc">
    <div class="band"><div class="host">${HOST.name} ／ ${HOST.biz}</div><h1>介護情報基盤 伴走支援パートナー（認定事業所）募集のご案内</h1></div>
    <div class="inner">
      ${to ? `<div class="cover-to">${to}</div>` : ""}
      <p class="muted">介護現場が取り残されないために、地域で導入を支える仲間（認定事業所）を募集しています。エンド事業所は自己負担¥0で導入でき、認定事業所は伴走支援で収益化できます。</p>

      <h2>1. タダカヨとは</h2>
      <p>介護現場のデジタル化を<b>無償</b>で支援するNPO法人。営利目的でないからこそ、事業所に中立的に寄り添えます。</p>

      <h2>2. 介護情報基盤とは</h2>
      <p>令和8年（2026年）4月から順次稼働する国の仕組み。要介護認定情報・主治医意見書・ケアプラン・LIFE等を電子的に共有し、<b>認定情報や主治医意見書を役所に行かずPCで確認</b>できるようになります（運営：国民健康保険中央会）。</p>

      <h2>3. 現場のつまずき＝伴走の必要性</h2>
      <p>カードリーダー選定／電子証明書の取得／ID（電子請求受付システムのKJ＋12桁）の混同／アプリ設定／助成金申請…。多忙でITに不慣れな現場には、横について一緒に進める支援が必要です。</p>

      <h2>4. タダサポ＋（介護情報基盤伴走支援）</h2>
      <p>導入・助成金申請・実利用まで伴走。カードリーダー＋初期設定・操作研修・申請支援まで“まるごと”。<b>エンド事業所の自己負担は¥0</b>（補助金上限ぴったり方式）。</p>

      <h2>5. 助成金の仕組み</h2>
      <table><tr><th>区分</th><th>助成上限(税込)</th><th>最大台数</th></tr>
        <tr><td>訪問・通所・短期滞在系</td><td>¥64,000</td><td>3台</td></tr>
        <tr><td>居住・入所系</td><td>¥55,000</td><td>2台</td></tr>
        <tr><td>その他</td><td>¥42,000</td><td>1台</td></tr></table>
      <p class="muted">カードリーダー購入費＋接続サポート費が対象。後払い（買って・つないでから申請）。</p>

      <h2>6. 認定事業所の役割</h2>
      <p>地域の介護事業所に案内し、カードリーダー提供＋伴走支援（初期設定・研修・申請支援）を行います。研修・マニュアル・申請テンプレ・問い合わせ対応はタダカヨが支えます。</p>

      <h2>7. 収益モデル（1件あたりの粗利・自社で伴走の場合）</h2>
      <table><tr><th>区分</th><th>1件あたりの粗利（目安）</th></tr>
        <tr><td>訪問・通所系</td><td>約 ¥34,000〜¥54,000</td></tr>
        <tr><td>居住・入所系</td><td>約 ¥34,000〜¥46,000</td></tr>
        <tr><td>その他</td><td>約 ¥30,000〜¥34,000</td></tr></table>
      <p class="muted">カードリーダー卸価格（上限）：BT ¥8,000／USB ¥4,000（大口仕入はさらに割引）。伴走支援費：1台¥60,000／2台¥55,000／3台¥50,000。任意でタダカヨへ寄付（活動支援）。</p>

      <h2>8. 認定までの流れ</h2>
      <p>① お申し込み → ② 面談 → ③ 研修受講＋確認テスト → ④ 協定書の締結 → ⑤ 認定証・発注アカウント発行 → ⑥ 活動開始</p>

      <h2>9. 認定事業所の基準（安心のための約束）</h2>
      <p>法人格・実績・反社でないこと／研修修了／個人情報の適切な取扱い。<b>本人の操作を代行しない・パスワード等を預からない・「助成金は必ず出る」と言わない・押し売りしない</b>を遵守いただきます。</p>

      <h2>10. サポート体制</h2>
      <p>伴走支援者ガイドブック・チェックリスト（事前/当日/アフター）・確認テスト・公式資料インデックス・申請テンプレ・一次受付エスカレーション・専用CRM。</p>

      <h2>11. よくあるご質問</h2>
      <p><b>Q. 未経験でも？</b> 研修とマニュアルで支援。最初は同行も。<br>
      <b>Q. ノルマは？</b> ありません。寄付も任意。<br>
      <b>Q. 助成金は確実？</b> 予算・審査があり確約はできません（正直にご案内します）。<br>
      <b>Q. 在庫リスクは？</b> 必要数を都度発注（1台から）。</p>

      <h2>12. お申し込み・お問い合わせ</h2>
      <p>${HOST.name} ${HOST.biz}<br>担当：次田 芳尚 ／ yoshinao-tsukuda@tadakayo.jp<br>「まずは話を聞いてみたい」だけでも歓迎です。</p>

      <div class="note">本資料は説明用の概要です。助成金・制度は変更される場合があります。最新情報は介護情報基盤ポータル（kaigo-kiban-portal.jp）をご確認ください。</div>
    </div></div>`;
}
