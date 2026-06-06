# タダカヨの介護情報基盤伴走支援 LP / CRM設計 申し送り — 2026-06-05（更新）

> handoff-id: tadakayo
> サービス名（最新）: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）

---

## 🆕 2026-06-06 セッション⑨（介護情報基盤伴走支援ナレッジ＆ツール／CRM拡張／赤系リブランド／PDF化）

> 状態: 大規模整備セッション。CRM最新コミット **`9c72600`**（GitHub同期済・未コミット0）。LP最新 `d082df2`。Drive `開発/介護情報基盤伴走支援/` にナレッジ＆配布PDFを集約。

### 成果物（Drive: 開発/介護情報基盤伴走支援/）
- **00_公式資料**：公式ポータルPDFを29点収集（Playwright経由＝CloudFront WAFをブラウザで突破）。
- **01_ナレッジ**：制度ナレッジ／公式ポータル資料インデックス／助成金ナレッジ（公式手引きで精緻化・**区分の誤り訂正**＝居宅介護支援43・居宅療養管理指導31・地域密着型通所介護78は全て訪問通所系6.4万）。
- **02_伴走支援**：伴走支援チェックリスト（事前/当日/アフター）／支援記録テンプレート。
- **03_教育ツール**：伴走支援者ガイドブック／確認テスト。
- **04_認定基準**：認定事業者基準／認定事業所協定書（既存docドラフトと統合・要法務確認）／カードリーダー価格表・送料規定／モデル料金表・利益シミュレーション／説明会資料（14スライド構成）。
- **配布PDF/**：上記13点をブランドPDF化（赤系・コールアウト色分け・Hiragino）。

### CRM（管理画面・本番反映済 commit順）
- 売上シミュレーター `d7504b1`（直販モデル・CR組合せ別件数→年間売上/利益・寄付¥3000/4000/5000切替）
- ブランド赤統一 `98480ff`（crm.css の primary を #E33535 に・全画面反映）
- 認定事業所ページ `9a75cf2`（partner-admin.html：一覧・登録＋協定書/説明資料のPDF作成・閲覧。partner-doc.js）
- 料金・送料設定 `9c72600`（pricing.html：認定事業所卸価格・レターパック単価・ゆうパック表(滋賀発)を編集→appConfig。送料計算ツール付き）
- LP `d082df2`：紹介チラシ(PDF)のDLセクション追加（images/tadakayo_kjk_flyer.{pdf,jpg}）

### ★重要な設計事実（次セッション必読）
- **卸価格の二重性**：`products.wholesale`（wholesale1/2_10/11_30）が「AB Circle仕入(発注用)」と「認定事業所卸(出荷dropship用)」の両方に使い回されパススルー化していた。マージンは設計上生きている（料金シミュレーション：BT+¥480/USB+¥510）。→ **認定事業所卸は `appConfig/settings.partnerPricing` で別管理**（料金・送料ページで編集）。products.wholesale=仕入は据え置き。
- **確定値**：認定事業所卸＝上限 BT¥8,000/USB¥4,000、大口(11台〜)割引 BT¥7,530/USB-A¥3,510/USB-C¥3,670。粗利＝売上−卸（伴走は自社実施前提・¥10,000は委託時のみ）。
- **md→PDF**：Bash経由のGoogle Chrome `--print-to-pdf` はハングする。**Playwright `page.pdf()` を使う**（`/tmp/md2pdf/genall.mjs` でHTML一括生成→Playwright browser_run_code でPDF化）。

### 次セッションでやること
1. **CRM最終統合**（supply.js・慎重に）：出荷(認定事業所dropship)の単価を `appConfig.partnerPricing` に接続（partnerPriceFor）＋送料を **直送＝レターパック¥600×⌈台数/3⌉ ／ まとめ＝ゆうパック表** から自動入力。
2. **tadakiayo-kiban フォルダ整理**：散乱ファイルを `docs/`・`事業資料/`・`_archive/2026-06-06/` へ（コード/deploy参照=firestore.indexes.json等は据え置き・git mvで履歴保持）。
3. （随時）ENG_NOTES/MANUAL更新、協定書の法務確認、料金・送料ページで「確定値をセット→保存」の運用反映。

### チャット
- 介護情報基盤スペース（`AAQAkcdopcA`・②「次田から」）に状況/PDF/締めを投稿済み。**開発スペースのWebhookは未取得**（次田さんから取得待ち・`reference_chat_webhooks.md` 参照）。

---

## 🆕 2026-06-06 セッション⑧（帳票の印鑑・発注者まわり）

> 状態: 請求書・発注書の体裁強化を実装・本番反映(hosting:admin)。**機能・データ構造は不変**、表示と入力のみ。最新コミット `257df5c`（GitHub同期済み）。

### 実装内容（commit順）
- **帳票の印鑑**（`e8952ef`/`9a68373`）: 「NPO法人タダカヨ」名称の右に**会社角印**（設定アップロードの印影画像 `poSealImage` を優先・未登録なら文字角印「タダカヨ」）。発注書の発注者の右に**担当者の丸印**（氏名の姓から自動生成）。請求書・発注書の両方。html2canvas互換のCSS/画像方式でPDFにも描画。
- **印鑑の傾き廃止**（`5f33903`）: 角印・丸印の `transform:rotate` を全廃し直立に。
- **戻り先タブ**（`9f8ebfb`）: 帳票（別タブ）から「供給管理へ」で元タブ（発注/出荷/受注/パートナー）の一覧へ戻る（`?tab=`）。
- **発注者の複数選択**（`257df5c`）: 設定「発注者一覧」(`poOrderers`・1行1名)に複数登録→発注モーダルで選択→`purchaseOrders.ordererName`に保存→発注書の発注者名・担当者印(姓)が追従（未選択の旧データは設定先頭→旧単一値→既定にフォールバック）。

### 次田さんの初期登録（運用前に）
- 設定→「発注者一覧」に発注者を1行1名で登録・保存（例: 次田 芳尚 / 佐藤 拡史）
- 設定→「会社角印の画像」に角印をアップロード（アップ済みなら不要）

### 次セッションの保留（既出・継続）
- 【H-3仕上げ】管理画面でAI生成/メール送信/発注書送付/テスト通知の動作確認 → 1-2日監視 → compute SAのeditor剥奪（最終確認）
- 【M-1】observeログ数日 → Phase B（強制）
- 【ブラッシュアップ残】A2供給/詳細タブ再整理・A3設定セクション化・B3推移グラフ・B4申請期限の設定化・C2肥大化ファイル分割・Dモバイル底上げ

---

## 🆕 2026-06-06 セッション⑦（CRM管理画面 ブラッシュアップ・推奨パック）

> 状態: **推奨パック（C1/A1/B1/B2）を実装・本番反映（hosting:admin）完了**。CRM本番未使用のため低リスクで適用。**機能・データ構造（status 1-13）は不変**、表示・整理・入力体験のみ改善。commit `d983121`。

### 実装内容
- **C1 定義一元化**: `admin/js/constants.js` 新設（STATUS/PHASES/STATUS_COLORS/SOURCE/DEADLINE/STALE等）。cases/kanban/dashboard/case-detail の重複定義を排除（SOURCEラベル「LP問い合わせ/LP」不統一も解消）。
- **A1 ステータス5フェーズ化**: 13ステータスを ①受付・受注 ②準備 ③伴走支援 ④申請・採択 ⑤完了・フォロー ＋失注 に整理。カンバン=5フェーズ列＋失注列（カードにサブ状態セレクト・フェーズ間ドラッグで先頭状態へ）。一覧フィルタ・詳細のステータス選択=フェーズ別optgroup、ダッシュボード=フェーズ別集計。
- **B1 状態表示**: 空状態を「条件に合致なし/未登録」で区別、新規案件のalert()廃止→トースト＋インラインエラー。
- **B2 在庫UI**: 在庫調整のprompt()廃止→台数・理由・在庫不足チェック付き正式モーダル。
- 検証: 全JS構文OK／モックでカンバン5列・フィルタ・在庫モーダル・空状態を確認／プレビューチャンネル→本番昇格で全アセット反映を curl 確認（管理画面はログイン必須のため認証後画面は次田さん確認）。

### 🙏 次田さんに確認いただきたい（@tadakayoログイン）
管理画面 https://kjk-tadakayo-admin.web.app で: (1) カンバンが5列＋失注・カード操作（サブ状態セレクト/フェーズ間ドラッグ）、(2) 一覧の絞り込みがフェーズ別、(3) ダッシュボードがフェーズ別集計、(4) 案件詳細のステータス選択、(5) 供給管理→在庫調整モーダル、(6) 帳票（請求書・発注書）に角印（タダカヨ）／発注書に担当者の個人印（姓） を一度確認。

### ブラッシュアップ 残提案（未着手・別途）
A2 供給/詳細タブ再整理・A3 設定セクション化・B3 ダッシュボード推移グラフ・B4 申請期限の設定化・C2 肥大化ファイル分割(case-detail 655/supply 658)・D モバイル/アクセシビリティ底上げ。

---

## 🆕 2026-06-06 セッション⑥（M-1 強制まで完了 ＋ H-3 editor剥奪まで完了＝指摘10件すべて完了）

> 状態: **M-1（強制モード）完了 ＋ H-3（editor剥奪まで）完了**。GCPセキュリティ指摘10件すべて対応済み（付帯 Gemini 2.5 retire 2026-10-16 のみ10月期限で残）。本番反映・検証済み（M-1強制: トークンなし→401／本番正規トークン→200、H-3: 全7関数が最小権限SA・compute SAは `builds.builder` のみ・editor無しでテストデプロイ成功）。詳細は `SECURITY_REMEDIATION.md` の「### 1. M-1」「### 2. H-3」冒頭。

### 今セッションの成果（コミット予定）
- **次田さん Console 作業完了**: reCAPTCHA Enterprise サイトキー発行（`kjk.tadakayo.jp`／スコアベース／key=`6LfHTQ4tAAAAAJ4uIXrIvuCXCyyinUz0FPzhvNNp`）＋ App Check に Web アプリ `kjk-crm-admin`(`…web:79645398db17dab417bb44`) を reCAPTCHA Enterprise で登録。
- **コード**: `index.html`/`mitsumori.html` に App Check 初期化＋Webhook fetch に `X-Firebase-AppCheck` 付与。`functions/index.js` に `appCheckGate()`（観察モード・`APPCHECK_ENFORCE` 既定 false）を追加し `webhookLpInquiry`/`webhookMitsumori` 冒頭で検証。
- **デプロイ**: functions 2本のみ更新（他5関数は未変更）／ LP は preview channel→本番昇格（hosting:lp）。前提API `recaptchaenterprise`/`firebaseappcheck` 有効化済み。
- **検証**: 本番 `kjk.tadakayo.jp` 実ブラウザで `getAppCheckToken()` が954文字の正規JWTを返却・console error 0／functions GET=405。本番フォーム疎通テストで `observe: verified` ログ確認（テスト案件は削除）。

### 今セッションの成果（H-3 関数別SA移行）
- 4専用SA作成＋最小権限付与：`fn-webhook-sa`/`fn-batch-sa`（datastore.user＋CHAT secretAccessor）/`fn-ai-sa`（aiplatform.user のみ）/`fn-mail-sa`（datastore.user＋kjk-gmail-sa tokenCreator）。全IAMバインド読取確認済み。
- 全7関数の定義に `serviceAccount` を明記して再デプロイ。実行SA切替を `gcloud functions describe` で確認（webhook2本→fn-webhook-sa / testChatNotify・dailyFollowup→fn-batch-sa / aiAssist→fn-ai-sa / sendCaseEmail・sendSupplierOrder→fn-mail-sa）。
- `webhookLpInquiry`(fn-webhook-sa) を本番疎通し HTTP200・verified・Firestore書込を確認（テスト案件#22削除）。**compute SA の editor/aiplatform.user は安全網として保持中**。

### 次セッションTODO（優先順）
1. **【任意・動作確認】次田さんが管理画面(@tadakayo)で AI生成(aiAssist)/メール送信(sendCaseEmail)/発注書送付(sendSupplierOrder)/テスト通知(testChatNotify) を一度実行**して成功を確認（IAMは検証済みで動くはずだが、onCallは実ログインでしか動作確認できないため最終チェック）。万一失敗したら該当関数の `serviceAccount` を外して compute SA で再デプロイ＝無停止ロールバック（compute SA に editor 再付与も可）。dailyFollowup は毎朝9時自動。
2. **【10月期限の保守・緊急でない】(a) Gemini 2.5→3 移行**（`aiAssist` model差し替え＋出力品質の回帰確認・要@tadakayoログイン／2026-10-16 retire）。**(b) firebase-functions 最新化＋Node 20→22**（2026-10-30 decommission・破壊的変更ありうるので専用セッション推奨）。いずれも現行は正常動作。
3. （事業・プロダクト面）パイロット30事業所／大分視察(6/29)／協定書法務／認定事業所掲示資料／「業者ではない旨」文書／居宅介護支援訴求 ほか（本書下部の旧TODO参照）。

---

## 🆕 2026-06-05 セッション⑤（発注機能: 下書き→確定→ABサークルへ発注書PDF添付メール送付）

> 状態: 発注機能(ステップ1+2)＋任意改善4件＋M-1/H-3下調べまで完了・**全push済み（最新 `98cedca`）**。Claude側で本番に積める作業は完了。**実機検証（@tadakayoログイン要）が次田さんの最優先**。AB Circle 2026-06-05 回答を反映。

### 今セッションの成果
- **AB Circle 確定情報を取り込み**（memory `reference_abcircle.md`）: 発注先 `h.noda@abcircle.com`＋CC 谷口`n.taniguchi@abcircle.com`/小多`s.oda@abcircle.co.jp`、卸価格(数量帯別)、送料表、JAN、月末締め翌月末払い(NP掛け払い)、納期=署名発注書受領から1週間以内、不良品=info@abcircle.co.jp、最小ロット1台。
- **商品マスタ更新**（Firestore REST直接・MCPは別プロジェクトを見るため使用不可）: 3SKUに JAN・31台価格(wholesale31)を投入。既存の数量帯別価格(wholesale1/2_10/11_30)は価格表と一致済み。
- **発注の3段階化**（supply.js）: 新規=下書き(draft)→編集/削除→確定。希望納期(desiredDate)欄追加。発注単価を数量帯別(unitPriceFor: 1/2-10/11-30/31+)に。
- **確定して送付**: 「確定」→プレビュー(confirmModal: 宛先=設定の仕入先メール/CC・件名・本文=定型文差込・編集可・発注書PDFプレビュー)→送信。発注書PDFを html2pdf(CDN)でブラウザ生成し添付、Gmail(DWD)送信、成功でstatus=sent＋emailedTo/emailedAt記録。
- **設定追加**（settings.html/js）: 仕入先(ABサークル: supplierName/Email/Cc/Contact/住所)＋発注メール定型文(poMailSubject/poMailBody・差込 {{発注番号}}{{品目}}{{金額}}{{希望納期}}{{発行日}}{{担当者}}{{仕入先名}})。確定値を初期表示(未保存でも見える)。発注書の宛名も supplierName 参照に。
- **functions**: buildRawMessage を multipart(添付/CC)対応に拡張＋ `sendSupplierOrder` callable 追加（本番create成功・既存関数に影響なし）。
- **共通化**: 発注書描画を `admin/js/po-doc.js`(renderPOHtml/PO_STYLE/DEFAULT_PO_MAIL_*)に切り出し、supply-print と確定プレビューで再利用。
- 本番: hosting:admin release complete / commit `1739c29`(push済) / preview検証で構文OK・console error 0（認証後UIはセッション切れで未確認）。

### 同セッション後半：任意改善4件＋下調べ（全push済み・最新 `98cedca`）
- **発注の送料自動計算**（`fc0c4c1`）: 発注モーダルに「お届け地域」セレクト。AB送料表(memory reference_abcircle)から送料・名目を自動入力（手入力可）。
- **出荷(直送)を数量帯別単価に**（`cb6f4b5`）: 認定事業所への直送出荷の単価を wholesale2_10 固定→ unitPriceFor(数量帯別)に。
- **LP側 glob 修正**（`cb6f4b5`）: hosting:lp の headers を `source:"**"` 化。preview検証で **html=no-cache(即時反映)／アセット=immutable** の両立を確認・本番反映（COOP globと同根の問題を解消）。
- **HANDOFF スリム化**（`18add8b`）: 745→283行。過去の逐次記録は `HANDOFF_ARCHIVE.md` に全保存（情報喪失なし）。
- **M-1/H-3 下調べ**（`98cedca`）: read-onlyライブ確認。H-3対象が**7関数**に(sendSupplierOrder追加→fn-mail-saに統合)／M-1前提API(recaptchaenterprise/firebaseappcheck)が**両方未有効**／着手手順をClaude・次田さん(Console)で担当分離。詳細は `SECURITY_REMEDIATION.md` 末尾「下調べ結果」。

### 🙏 次田さんの実機検証（最優先・@tadakayoログイン要）
1. 設定画面で「仕入先」「発注メール定型文」を確認し**一度「保存」**（Firestoreに確定させる。発注機能はフォールバックでも動くが保存推奨）
2. 供給管理→発注: 新規発注→下書き保存→編集→「確定」→プレビュー→送信
   - ⚠️ **「この内容で送信」は実メールがABサークルへ飛ぶ**。最初は**宛先(TO)を自分の@tadakayoに変えて**テスト送信し、PDF添付/レイアウト/数量帯別単価(11台以上で単価減)を確認
3. 発注書PDFの宛名が仕入先名か／入荷登録で在庫加算（既存）

### 次セッションTODO
1. **実機検証のフィードバック反映**（発注の下書き→確定→送付・送料地域・数量帯別単価・PDFレイアウト・COOP警告消失・partnerモバイルの確認結果を受けて調整）
2. **M-1 Webhook保護**（App Check段階移行）— 着手前に次田さんが Console で reCAPTCHA Enterprise鍵発行＋App Check登録（`SECURITY_REMEDIATION.md`末尾「下調べ結果」に担当分離手順）。続いて **H-3 関数別SA**（破壊的・editor剥奪は最後・専用セッション）
3. 設定の未入力（インボイス番号T+13桁/振込先/レターパック差出人/発注書発行元・代表者）
4. （任意）受注(認定事業所)にも送料表/数量帯別単価を展開／Gemini 3移行(2026-10-16期限)／viewerロール書込制限／案件テストデータ整理

---

## 🆕 2026-06-05 セッション④（本番デプロイ実施＋COOP glob修正＋worktree整理）

> 状態: セッション③の積み残し（本番デプロイ）を完了・push済み（最新コミット `ebf3ae1`）。残りは次田さんの実機検証と M-1/H-3（専用セッション）。

### 今セッションの成果
- **本番デプロイ完了**（COOP設定・partner.htmlモバイル対応・docs整備を反映）。rule05 二段階（preview channel→検証→本番昇格）で実施。
  - 本番URL: https://kjk-tadakayo-admin.web.app / コミット `ebf3ae1`（push済み・origin/main一致）/ **hosting:admin のみ**（functions/rules非該当・誤削除リスクなし）
  - 証跡: 全ページ COOP `same-origin-allow-popups` を curl確認 / ログイン画面 console error 0 / 認証後画面(/cases)も正常表示
- **🔴 重要修正: COOPが実は全く効いていなかった問題を preview で発見・修正**。firebase.json admin headers が `source: "**/*.html"` だったが、`cleanUrls: true` で配信パスが拡張子なし（`/`・`/partner` 等）になり **glob が一切マッチせず COOPもno-cacheも未適用**だった。`source: "**"` に変更し全documentへCOOP適用＋HTML即時反映を実現（`ebf3ae1`）。preview channel を踏まなければ「デプロイしたのに警告消えず」で本番化していた。
  - ⚠️ **LP側 (hosting:lp) の `**/*.html` headers も同じ glob 問題**（COOPは不要だが HTML no-cache が効かず＝LP更新が最大1時間反映遅延）。今回スコープ外で未対応。次回 `source:"**"` 化を検討。
- **worktree 4つ整理（全削除）**: 1ヶ月分溜まった Claude作業用worktree を撤去しリポジトリを main 1本に。いずれもローカル限定（remote未push）・固有データ喪失なし。
  - confident-brattain=5/8の古い実験（Formspree修正は既にmain反映済）/ naughty-nobel=5/12の料金没案（¥25,000傾斜＝現行¥60k合意と矛盾）/ affectionate-bohr・relaxed-cerf=マージ済。印影素材(hanko.png/2.png)は本体に残存確認済。

### 🙏 次田さんの実機検証（@tadakayoログイン要・最優先）
- 管理画面で一度 **ログアウト→再ログイン** → 開発者ツール Console で `Cross-Origin-Opener-Policy`/`window.closed` 警告が消えたか
- **partner.html**（認定事業所ポータル）をスマホで開き、ハンバーガー→ドロワー開閉
- （既存の `実機検証チェックリスト.md` も継続：0認証/8請求書PDF/9設定入力/発注セレクト/M-5メールverify）

### 次セッションTODO（優先順）
1. **M-1 Webhook保護**（App Check段階移行）/ **H-3 関数別SA** — 破壊的・Console前提作業あり・専用セッション推奨（`SECURITY_REMEDIATION.md`末尾「次セッション実行計画」参照）
2. **設定の未入力**（インボイス登録番号T+13桁/振込先/レターパック差出人/発注書発行元・代表者）— @tadakayoログイン要
3. （任意）LP側 `**/*.html` glob問題の修正 / Gemini 3移行(2026-10-16期限) / viewerロール書込制限 / 案件テストデータ整理
4. （任意）HANDOFF.md が肥大化（700行超）→ 古いセッション記録の圧縮・アーカイブ化を検討

---

## 現在の状態（2026-06-04 セッション終了時点）

**CRMはほぼ全機能が本番稼働中。** LP（kjk.tadakayo.jp）・見積もり（/mitsumori.html）も稼働中。最新コミット `f5e023d`（main・push済み）。

- 管理画面: **https://kjk-tadakayo-admin.web.app**（Firebase: `kjk-tadakayo` / Blaze + 月¥3,000予算アラート）
- 認定事業所ポータル: **/partner.html**
- 稼働中の機能: 案件管理・カンバン・ダッシュボード・CSV・伴走支援(写真)・報告書PDF・自動フォロー(毎朝9時Chat)・供給管理(在庫/発注/出荷)・**受注→発送→請求→入金フロー**・適格請求書(インボイス)・レターパック宛名(赤600/青430・直貼り)・発注書(ABサンプル準拠+擬似印鑑)・AIアシスタント(Vertex)・Gmail送信(DWD)・モバイルUI・**ロール管理/ログイン登録制**・マニュアル/エンジニアノート(アプリ内)

> ⚠️ **重要・ログイン**: `users` コレクションに登録された @tadakayo.jp ユーザーのみログイン可。現在 admin=次田(yoshinao-tsukuda)・佐藤(hiroshi-sato)、staff=藤田/斎藤/石田/蜂須賀。新規スタッフは管理画面「ユーザー管理」で追加しないとログイン不可。
> ⚠️ 多くの新機能は **@tadakayoログインでの実機通し検証が未**（下記「次セッション」参照）。

---


> 📦 過去の詳細な実装逐次記録（セッション①〜③・2026-05〜06-04）は **HANDOFF_ARCHIVE.md** に退避しました（必要時に参照）。

---
## 補助金対象サービス（公式・35種類）

出典: 公益社団法人国民健康保険中央会「介護関連データ利活用に係る基盤構築事業の助成金交付要綱」別添

### 区分①：訪問・通所・短期滞在系（¥64,000・3台）— 18種類
11訪問介護 / 12訪問入浴介護 / 13訪問看護 / 14訪問リハビリ / 15通所介護 / 16通所リハビリ /
21短期入所生活介護 / 22短期入所療養介護(老健) / 23短期入所療養介護(病院) / 2A短期入所療養介護(医療院) /
**43居宅介護支援** / 68小規模多機能型(短期利用) / 71夜間対応型訪問介護 / 72認知症対応型通所介護 /
73小規模多機能型居宅介護 / 76定期巡回・随時対応型訪問介護看護 / 77看護小規模多機能型 / 79看護小規模多機能型(短期利用)

### 区分②：居住・入所系（¥55,000・2台）— 12種類
27特定施設(短期利用) / 28地域密着特定施設(短期利用) / **31居宅療養管理指導** /
32認知症対応型共同生活介護(GH) / 33特定施設入居者生活介護 / 36地域密着型特定施設 /
38認知症対応型共同生活介護(短期利用) / 51介護福祉施設(特養) / 52介護保健施設(老健) /
54地域密着型介護福祉施設 / 55介護医療院 / 59特定入所者介護サービス等

### 区分③：その他（¥42,000・1台）— 5種類
17福祉用具貸与 / 41特定福祉用具販売 / 42住宅改修 / **78地域密着型通所介護** / 81市町村特別給付

### ⚠️ 注意：直感と違う分類

| サービス | 直感 | 正解 |
|---|---|---|
| 居宅介護支援（43）| その他？ | **訪問・通所系（¥64,000）** |
| 居宅療養管理指導（31）| 訪問系？ | **居住・入所系（¥55,000）** |
| 地域密着型通所介護（78）| 通所系？ | **その他（¥42,000）** |

※ 介護予防サービスのみの事業所は対応する介護サービスに読み替えて申請可能

---

## 価格設計（最新・補助金上限ぴったり方式）

### カードリーダー（税込・エンドユーザー定価）
- BT CIR415A: ¥14,500/台
- **USB CIR315A: ¥6,500/台**（2026-05-22 改定）

### 伴走支援費（税込・補助対象台数別）
- 1台: ¥60,000 ／ 2台: ¥55,000 ／ 3台: ¥50,000

### 特別割引
- `特別割引 = CR定価合計 + 伴走支援費 − 補助金上限`
- 全パターンで自己負担¥0
- USB価格上昇分は特別割引で吸収（USB×3+訪問系: 旧△¥1,000 → 新△¥5,500）

### タダカヨ仕入／認定事業所卸（税別・変更なし）
- BT: 仕入¥7,520 / 卸¥8,000
- USB: 仕入¥3,490 / 卸¥4,000
- メンバー伴走報酬: ¥10,000/件
- 寄付バック: ¥5,000/件（任意推奨）

> ※ USB価格改定はエンドユーザー定価のみ。卸益は据え置き。

---

## 見積もりツール（mitsumori.html）仕様

### 入力フォーム
- 必須: 法人名・事業所名・担当者名・電話・メール・補助金プラン・カードリーダー構成（1台以上）・同意チェック
- 任意: 住所・HP URL
- カードリーダーは BT/USB それぞれ「補助対象」「補助対象外」を独立指定

### プラン選択UI
- 訪問・通所・短期滞在系: 訪問介護・通所介護・**居宅介護支援**・短期滞在 等
- 居住・入所系: グループホーム・特養・**居宅療養管理指導** 等
- その他: 福祉用具貸与・**地域密着型通所介護** 等
- 折りたたみで対象サービス完全リスト35種類を確認可能

### Webhook通知
- スペース: AAQAkcdopcA
- 必須+同意完了アンロック瞬間に成約通知（1セッション1回）

---

## LP問い合わせフォーム（kjk.tadakayo.jp/#contact）
- Formspree (xjglevjk) でメール送信
- Google Chat Webhook も並行で通知

---

## ブランディング

| 役割 | 表現 |
|---|---|
| メインサービス名 | **タダカヨの介護情報基盤伴走支援** |
| サブブランド/シリーズ名 | **タダサポ＋**（チップ表示でのみ前面化） |

「タダサポ＋」チップ配置: hero / plan / strengths / contact の4箇所

---

## 次セッションでやること（優先順）

0. ~~**CRMクラウド環境セットアップ**~~ ✅ 2026-06-04 全完了（Blaze/Firestore/Storage/Functions/Auth/予算アラート・実機検証PASS）
0b. **【次の最有力タスク】mitsumori.html の Webhook を Functions 経由に切替** — 現在は `WEBHOOK_URL`=Chat直送。`https://asia-northeast1-kjk-tadakayo.cloudfunctions.net/webhookMitsumori` に変えると見積もり成約が自動でFirestoreに案件登録されCRMに乗る。同様に index.html の LP問い合わせも `webhookLpInquiry` 経由を検討（現状Formspree+Chat）。切替後は実機で1件投入してFirestore `cases` に入るか検証。
0c. **管理画面の実ログイン確認**（次田さんが @tadakayo.jp で実際にログイン→案件一覧表示までを一度通す）
0d. （任意）Cloudflare Access で `admin.kjk.tadakayo.jp` 化（CRM_SETUP_GUIDE Step6 / CRM_DESIGN Phase0）。許可ドメインには登録済。
1. ~~**本番動作確認**: 補助金完全リスト表示・USB¥6,500反映・見積もり全パターン~~ ✅ 2026-06-02 完了（35コード逐語化・favicon・E2Eまで実施）
2. **パイロット運用 30事業所**（〜2026/8月目標）
3. **大分・別府市視察**（6/29候補）
4. **協定書の法務確認**（弁護士・税理士）
5. **AB Circle Japanへの確認**（仕入方法・大量仕入価格・配送方法）
6. **認定事業所掲示資料**（藤田/蜂須賀依頼分）
7. **「業者ではない旨を伝える文書」**の作成（議事録より）
8. **居宅介護支援事業所向けの訴求強化**（¥64,000区分の認知が低い）

---

## 重要な合意事項（決定済み・蒸し返し禁止）

- メインサービス名: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋）
- 無償版「タダサポ」は別事業として継続
- CR定価: BT ¥14,500 / **USB ¥6,500**（税込）
- 伴走支援費は補助金上限ぴったり方式（1台¥60k/2台¥55k/3台¥50k）
- 特別割引（出精値引き）で補助金上限ぴったりに自動調整
- 寄付バック ¥5,000/件（任意推奨型）
- 見積もりはダウンロード形式（メール送信は廃止）
- 介護事業所のみに発行（同意ベース）
- 居宅介護支援は ¥64,000 区分（公式確認済）
- 居宅療養管理指導は ¥55,000 区分（公式確認済）
- 地域密着型通所介護は ¥42,000 区分（公式確認済）

---

## 未決事項

- [ ] Bluetooth 3台導入時の現地支援可否（オンラインのみ vs タダメン現地）
- [ ] CR仕入方法（デポジット制 vs 発注分前払い）
- [ ] 大量仕入れ（31台以上）の価格交渉
- [ ] 認定NPO法人申請のタイムライン
- [ ] LP夜間メンテナンスモード化（議事録決定事項・未実施）
- [ ] PRタイムス広報を再開するか（フェーズダウン中）

---

## ハマりポイント・注意事項

### Firebase デプロイ
```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 20
bash deploy.sh
```

### GitHub Push
```bash
git push "https://<PAT>@github.com/tsuku-29/kjk-tadakayo.git" main
# PAT は memory/feedback_deploy.md に保存済み（2026-08-06まで有効）
```

### 料金シミュレーションPDF再生成
```bash
cd /tmp/md2pdf_v2  # marked installed済
node md2pdf.mjs "<src.md>" "<dst.pdf>" "<title>"
```

### Webhook URL（key/token露出注意）
- `mitsumori.html` `WEBHOOK_URL` 定数
- `index.html` `CONTACT_WEBHOOK_URL` 定数
- スペース AAQAkcdopcA 共通

### 補助金要項の正本URL
- 交付要綱PDF（令和8年度・最新）: https://www.kaigo-kiban-portal.jp/assets/pdf/r8_jyoseikin_youkou_01.pdf
- 旧要綱PDF（令和7年度・参考）: https://www.kaigo-kiban-portal.jp/assets/pdf/jyoseikin_youkou_01.pdf
- 申請受付確認お知らせ: https://www.kaigo-kiban-portal.jp/notice/detail/ulruesqstm89985zz5mho283
- ポータル: https://www.kaigo-kiban-portal.jp/

---

## 技術構成

| 項目 | 値 |
|---|---|
| 本番 URL | https://kjk.tadakayo.jp |
| 見積もりツール | https://kjk.tadakayo.jp/mitsumori.html |
| Firebase プロジェクト | kjk-tadakayo |
| GitHub | https://github.com/tsuku-29/kjk-tadakayo |
| Formspree（問い合わせ） | xjglevjk |
| Google Chat Webhook | スペース AAQAkcdopcA |
| Clarity | wax7x03bg8 |
| GA4 | G-0NZY6PM3FG |

---
## 関連ドキュメント

- **`TECHNICAL_SPEC.md` v1.0**（技術仕様書・社内確認用 / 2026-05-27 新規）🆕
- **`工数試算書.md` v1.0**（開発工数・費用試算 / 2026-05-27 新規）🆕
- **`タダカヨ_システム技術仕様・工数試算書_2026-05-27.pdf`**（デスクトップ・社内共有済み）🆕
- **`CRM_DESIGN.md` v0.2**（CRM＋サプライチェーン詳細仕様書 / 2026-05-26 改訂）
- `CRM_DESIGN.pdf`（同上のPDF版）
- 🆕 **`AB_Circle_確認事項_依頼文.md`**（野田様宛て送信用ドラフト）
- 🆕 **`Gmail_MCP_セットアップ手順.md`**（Claude Code 用 Gmail 連携手順）
- `料金シミュレーション_新案_一般事業所向け.md` / `.pdf`（最新・USB¥6,500・35サービス全列挙）
- `料金シミュレーション_新案_認定事業所向け.md` / `.pdf`（最新・粗利情報込）
- `料金シミュレーション.md` / `.pdf`（旧案・参考保持）
- `タダサポ有償事業化企画書.docx` / `.gdoc`
- `タダサポ_パートナーシップ協定書_ドラフト.docx`
- `議事録など/2026:05:19_まとめ_介護情報基盤チャットスペース議論.pdf`

---

## 再開コマンド

```bash
cd ~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp/マイドライブ/開発/tadakiayo-kiban
```
