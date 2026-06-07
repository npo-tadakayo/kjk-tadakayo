# タダカヨの介護情報基盤伴走支援 LP / CRM設計 申し送り — 2026-06-07（更新）

> handoff-id: tadakayo
> サービス名（最新）: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）

---

## 🆕 2026-06-07 セッション⑪（CRM書類チェック追加 ＋ 開発回答対応：M-1観察フェーズ化／H-3 GCP確認反映）

> 状態: **CRM改修を本番反映済**（hosting:admin・rule05二段階：プレビュー `support-checklist-0607` → 静的アセットcurl検証 → live昇格・本番curlで新JS/HTML配信確認）。①CRM補助金書類チェックに公式必須書類④を追加／②開発回答を受け M-1 を観察フェーズへ（webhook 2本 `APPCHECK_ENFORCE=false` 本番再デプロイ・env確認済）／③ドキュメント反映（SECURITY_REMEDIATION.md・本書）／④**伴走チェックリスト（事前/当日/アフター）をアプリ内記録できる3タブを新設**／⑤検証で出来たテスト案件24を削除済。**開発スペースへ返信＋質問を投稿済**（`spaces/AAAAJTAWTVo` msg `mmBAh3is_gE`）。**残＝次田さんの @tadakayo 実機確認**（認証後UI）。

### ① CRM 補助金申請 書類チェックリストに公式必須書類④を追加（未コミット・未デプロイ）
- ドキュメント突合（`介護情報基盤伴走支援/01_ナレッジ/03_助成金ナレッジ.md §4-1`）で、CRM の書類チェック（案件詳細→書類チェックタブ）に**公式必須書類④「介護WEBサービス『管理メニュー画面』コピー（事業所番号・名称入り）」が欠落**していたのを発見。タダカヨは伴走支援費＝接続サポート費を必ず申請するため④は毎回必須（欠落＝不交付リスク）。
- 追加: [admin/case-detail.html](admin/case-detail.html)（`chk-webscreen`／`data-field="webScreenCopyReady"`）＋ [admin/js/case-detail.js](admin/js/case-detail.js)（`renderDocumentChecklist` のマッピング1行）。既存の `[data-field]` 汎用リスナで自動保存＝**追加のみ・既存挙動不変**。Firestore は新フィールド merge 追記のみ（マイグレーション不要）。JS構文OK。
- なお訪問チェックリスト（`02_伴走支援/01_伴走支援チェックリスト.md`）の方は B-4 で④を既に記載済み＝CRM側だけ欠落していた。
- **未対応**: hosting:admin への本番反映（rule05 二段階）＋コミット。

### ② M-1（webhook App Check）→ 観察フェーズへ戻す（開発判断・本番反映済）
- 開発回答: 「攻撃インセンティブ低（介護B2B）＋PITR/Delete Protectionでデータ層保護が厚い」ため **App Check 本対応（強制）は保留・観察フェーズへ移行**。代替＝Cloud Monitoring 異常トラフィックアラート設置済。
- 対応: `functions/.env` に `APPCHECK_ENFORCE=false` 追記 → webhook 2本（`webhookLpInquiry`/`webhookMitsumori`）のみ名前指定で **本番再デプロイ済**（Node20・firebase deploy --only "functions:..."）。`gcloud functions describe` で両関数 env `APPCHECK_ENFORCE=false` 確認。トークンなしPOSTが観察モードで通過（401でない）ことを確認。
- ⚠️ **観察モードはリクエストを処理まで通す**ため、検証curlで**空のテスト案件（案件番号24・cases/offices/activities 各1件）が生成**された。**削除は本番Firestore破壊的操作のため許可待ち**（次田さん承認後に Firestore REST DELETE で消す。cases/`yojPWNmR6t3AbtkoXqU0`・offices/`Tx9HTk6fldiq5i8FjqWN`・activities/`52t3ul8EFl3kzYPxyojY`）。今後の検証は env 確認のみに留める。
- 強制へ戻す場合: `.env` の該当行を削除 or true にして2本を再デプロイ。

### ③ H-3 GCP実機確認を反映
- 開発が GCP 実機で H-3 完全クローズを確認（appspot editor・旧 compute→kjk-gmail-sa tokenCreator いずれも消滅／全7関数 fn-*-sa で ACTIVE／sendSupplierOrder=fn-mail-sa で entryPoint正常）。SECURITY_REMEDIATION.md のサマリー・状態表に反映済。

### ④ 伴走チェックリストをアプリ内で記録できる3タブを新設（本番反映済）
- 記録テンプレート（`介護情報基盤伴走支援/02_伴走支援/01_伴走支援チェックリスト.md`・`02_支援記録テンプレート.md`）をアプリ内記録化。案件詳細に **事前確認 / 当日 / アフター** の3タブを「書類チェック」前後（ライフサイクル順）に追加。
- 新規 [admin/js/support-checklist.js](admin/js/support-checklist.js)：チェックリスト定義＋描画＋`supportChecklists/{caseId}` 購読＋変更即保存（既存 `documentChecklists` と同パターン）。スケルトン1回描画＋populate（フォーカス中は上書きしない）＋change保存＋「保存しました HH:MM(JST)」表示。
- [admin/case-detail.html](admin/case-detail.html)：3タブのボタン＋空コンテナ。[admin/js/case-detail.js](admin/js/case-detail.js)：import＋`initSupportChecklist(db, caseId)` 1行。**既存タブ・既存コード不変**。firestore.rules は catch-all（登録スタッフ read/write）で `supportChecklists` を自動カバー＝ルール変更不要。
- 記録粒度（テンプレ忠実・次田さん選択）: 事前確認＝○/△/×＋メモ（8項目）／当日＝訪問日時・場所＋7工程チェック＋メモ＋所感／アフター＝審査・振込・データ移行確認＋経過・定着・満足度・次アクション・消費税報告メモ＋**個人情報取扱い確認3項目（Pマーク準拠）**。
- 検証: 全JS構文OK／renderスモークテスト（data-path数・aria-label整合）／プレビュー＆本番curlで support-checklist.js・case-detail.{js,html} の新マーカー配信確認。**Firestore保存・タブ切替・populate往復は @tadakayo ログイン必須＝次田さん確認**。

### ⑤ ケアプランデータ連携システムの整備（仕様収集→ナレッジ/記録類→CRM記録追加・本番反映済）
- **仕様収集（一次情報）**: 国保中央会 概要資料(2024/6/26版)＋Q&A(2023/5/26)を WebFetch→pdftotext で取得・突合。要点: 運営=国保中央会／令和5年4月本格運用／ライセンス**年21,000円(税込)・1事業所番号・自動更新なし毎年申請**／電子証明書は**介護保険証明書(既存)流用可・なければ請求委任事業所用ケアプラン証明書(無料)**／Win10/11・標準仕様対応介護ソフト必須／導入4要件(介護ソフト・クライアント・証明書・利用申請)。
- **ナレッジ/記録類を新規作成**（Drive `開発/ケアプランデータ連携支援/`・**本repo外**＝介護情報基盤伴走支援と同じ扱い）: `01_ナレッジ/01_制度・仕様ナレッジ.md`／`02_伴走支援/01_伴走支援チェックリスト.md`（事前/当日/アフター）／`02_伴走支援/02_支援記録テンプレート.md`／`README.md`。
- **CRM記録に追加**: 案件詳細に **「ケアプラン連携」タブ**を新設（support-checklist.js に `cp` セクション追加・`supportChecklists/{caseId}` 同一ドキュメント）。事前確認(介護ソフト標準仕様/電子請求有無/証明書種類/連携相手)＋導入作業6工程＋ライセンス/運用/アフター。hosting:admin 本番反映済（プレビュー `careplan-renkei-0607`→curl→live・本番curlで `renderCp`/`data-tab="cp"` 配信確認）。
- ★タダカヨ視点: 介護情報基盤を入れた事業所はKJ-ID・電子証明書が整い導入容易＝クロスセル導線（`01_制度・仕様ナレッジ.md §9`）。

### ⑥ タブ整理（CPを各フェーズに統合）＋ ケアプラン連携 証憑写真（本番反映済・コミット `8f0...`）
- 次田さん指示「当日に介護情報基盤＋ケアプラン連携を両方行う」に合わせ、**独立「ケアプラン連携」タブを廃止し、事前確認/当日/アフターの各タブに統合**（9→8タブ）。各タブ内で「介護情報基盤 —」「ケアプラン連携 —」のカード見出しで区切り。当日タブ＝訪問情報＋介護情報基盤工程＋ケアプラン連携導入作業＋証憑写真。
- **証憑写真（1枠）**: ケアプラン連携の「ライセンス／電子証明書の有効期間」の写真を当日タブで複数枚アップロード可（`cp.evidencePhotos[]`）。Storage は既存許可パス **`documents/{caseId}/cp-evidence-...`** を再利用＝**storage.rules変更不要**。サムネ一覧・削除（Storageからも `deleteObject`）・進捗表示つき。`support-checklist.js` に `storage` を渡すよう case-detail.js を更新。
- 検証: 全JS構文OK／renderスモーク（事前2カード/当日4カード+写真/アフター3カード・data-path数整合）／プレビュー `tab-merge-0607`→本番curlで「cpタブ廃止・証憑写真配信」確認。**認証後の写真UP/保存は @tadakayo 実機で次田さん確認**。

### ⑦ 伴走支援ガイドブック（HTML＋編集可能PPTX）＋ 証明書名称/自動更新の訂正
- **ガイドブック2種を作成**（Drive・本repo外）。タダカヨ赤テンプレ＋公式キャラ（ケアプー＝`img_chara_main.svg`をsharpで透過PNG化／多田佳代ちゃん／正式ロゴ`NPO法人タダカヨロゴ.png`）。LAYOUT_WIDE・pptxgenjsでネイティブ生成＝**Googleスライドで編集可**。
  - `開発/ケアプランデータ連携支援/ガイドブック/`：`index.html`（20枚・実機レンダ確認）＋`ケアプランデータ連携_伴走支援ガイドブック.pptx`。B1〜B7（効果額/ライセンス料/連携データ/送受信ルール/証明書2種/1事業所1端末/算定メリット）を統合。
  - `開発/介護情報基盤伴走支援/ガイドブック/`：`介護情報基盤_伴走支援ガイドブック.pptx`（18枚・内容網羅確認）。事前/当日/アフター・電子証明書・ポータル初回登録・マイナ資格確認アプリ・介護WEBサービス・カードリーダー選定・助成金①②③・つまずき早見表・サポート。
  - 各 `build-pptx.cjs` で再生成可（`NODE_PATH=$(npm root -g) node build-pptx.cjs`／要 pptxgenjs・sharp グローバル）。
  - **実画面スクショ/図解を埋込**（2026-06-07 追加）：公式PDFから pdfimages で抽出・キュレーションし `assets/shots/` に保存。ケアプラン＝電子請求システム画面/お知らせ用紙/.NETダイアログ/受信・送信一覧/ライセンス確認（元ガイドブックPDF）。介護情報基盤＝概要図/証明書一覧/ポータル初回登録/マイナ申請フォーム/介護WEBメニュー（公式マニュアル）。`shot()` ヘルパで白フレーム＋影＋contain配置。
  - **LibreOffice復旧**（`brew reinstall --cask libreoffice`）→ 両PPTXを画像化しQAサブエージェントで全枚検査。検出された軽微な崩れ（ヘッダー副題折返し・表紙タグラインのキャラ重なり・キャプション位置）を全て修正→再QAクリーン。**ユーザー可視の不具合ゼロ**。
  - ⚠️ HTMLプレビューはテキスト版のまま（スクショはPPTX側に反映）。最終はGoogleスライド取込で実機確認推奨。
- **証明書名称・自動更新の訂正**（私の旧誤りを修正）:
  - CRMケアプラン連携タブの電子証明書プルダウンを「介護DX証明書」に修正・本番反映（コミット `fc4796c`）。
  - `ケアプランデータ連携支援/01_ナレッジ`・`02_伴走支援`・memory を「介護DX証明書」「2025/6/1以降は自動更新(解除可)」に訂正（残存ゼロ確認）。

### 開発スペースへの投稿（`spaces/AAAAJTAWTVo`・webhook③・「次田から」名義）
- 返信＋質問2点を投稿（msg `mmBAh3is_gE`）→ **開発から回答受領・記録済**（msg `cZNKrFiTpkU` で受領返信）。
  - M-1 = 「**管理状態**（App Check強制せず暫定運用＋Monitoring補償統制・残リスク明示・H-3完全クローズと区別）」で確定。
  - 補償統制アラート: Policy `4495119028582973062`／`run.googleapis.com/request_count` > 100/h × 5分連続（webhookLpInquiry・webhookMitsumori 各独立）→ 通知 `17803807182395282661`（運用アラートメール）。
  - enforce復帰トリガー: ①alert発火 ②LP問合せ10x ③類似攻撃事例。1〜2か月後めどに閾値再評価。強制移行時は GCP側整理＋webhook側SDK組込・再デプロイを別途依頼。
  - → SECURITY_REMEDIATION.md（サマリー・状態表・M-1詳細）に全反映済。H-3 は先方 ARCHITECTURE.md §8.1 / CLAUDE.md と「完全クローズ」表記が一致。

### 次にやること（優先順）
1. **次田さんの @tadakayo 実機確認**: (a) 案件詳細の新4タブ（事前/当日/アフター/**ケアプラン連携**）で入力→「保存しました」表示→再読込で保持されるか (b) 書類チェックに④「介護WEBサービス管理メニュー画面コピー」が出るか (c) M-1観察モード後もLP/見積もりフォームから正常に案件が入るか
2. 開発からの質問回答を反映（M-1 補償統制＝アラート条件の詳細を SECURITY_REMEDIATION.md M-1 へ追記）
3. E2E 残（@tadakayoログイン）:
   - ✅ **`sendCaseEmail` 実機確認OK（2026-06-07 20:58）**: 案件#19から `y.tsukuda@279279.net` 宛にテスト送信→CRM「送信しました」＋本人受信トレイに `kjk-staff@tadakayo.jp` 差出で着信を確認。**fn-mail-sa→kjk-gmail-sa→Gmail送信の経路がH-3後も正常**（= `sendSupplierOrder` も同一 SA_MAIL・同一 gmailAccessToken のため認証経路は実証済。残差分は PDF添付のみ）。
   - ⏳ `sendSupplierOrder`（発注書PDF添付送付）／直送発注→出荷下書き の実機確認

### 本セッションで完了済（参考）
- ✅ テスト案件24＋office＋activity 削除（Firestore REST・HTTP200・最新は実データ#19に戻った）
- ✅ CRM書類チェック④追加・伴走チェックリスト3タブ新設 → hosting:admin 本番反映（プレビュー→curl→live）
- ✅ M-1 観察モード（webhook 2本 enforce=false 本番再デプロイ）
- ✅ ドキュメント反映＋開発スペース投稿＋コミット/push

---

## 🆕 2026-06-06 セッション⑩（CRM最終統合＝出荷の認定事業所卸/送料・請求書計上 ＋ 申請期限の設定化 ＋ 月次推移グラフ）

> 状態: **本日(2026-06-07) CRM大規模改修を完了・全て本番反映**（#1出荷統合／B3推移グラフ・B4期限設定化／docpage修正＋ドキュメント／Dモバイル・a11y／C2分割／補助金区分訂正／アクセシビリティ監査修正／**H-3完全クローズ**(過剰権限2つ剥奪)／users運用フロー文書化／**直送発注→出荷下書き自動生成**／本日機能をマニュアル/エンジニアノートに反映）。最新コミット `4c2965a`（main・本日12コミット・GitHub同期済）。全JS構文OK・本番curl/Playwright実機検証済み。**残＝次田さんの @tadakayo 実機操作**: ①出荷の送料計算・請求書PDF ②H-3後のメール実送信(sendCaseEmail/sendSupplierOrder) ③直送発注のE2E(確定→draft自動生成→確定)。

### 実装（本番反映済み）
- **#1 出荷の最終統合**（`aa12722` / supply.js・supply.html・supply-print.js）:
  - 認定事業所直送(dropship)の単価を **商品マスタ仕入のパススルー(unitPriceFor)→ 認定事業所卸(appConfig.settings.partnerPricing・数量帯別 partnerPriceFor)** に接続。「卸価格の二重性」を解消し、認定事業所への請求が正しい卸価格になる（仕入¥7,520→卸¥8,000＝卸益+¥480/台が乗る・料金シミュレーションと一致）。partnerPricing未設定時は従来の商品マスタ卸にフォールバック（無停止）。受注→出荷変換(shipFromOrder)も同様。
  - 出荷モーダルに **配送方法** を追加：レターパック(直送)=`letterpackFee × ⌈総台数/3⌉` ／ ゆうパック(まとめ)=`yupackTable[サイズ][地域]`（滋賀発）／手入力。数量変更で自動再計算・受注→出荷もレターパック送料を自動付与。
  - 送料を **税込実費→税抜換算して請求書に10%対象明細1行で計上**。出荷サマリー(未請求/請求済/入金済)も送料込みに統一（請求書と税計算一致：sub=商品税抜+送料税抜、tax=floor(sub*0.1)、total=sub+tax）。
- **B4 申請期限の設定化**（`965a857` / constants.js・settings.html/js・dashboard/cases/kanban.js）: 設定画面に「助成金の申請期限」を追加（`appConfig.settings.subsidyDeadline`）。ダッシュボード/案件一覧/カンバンの3バナーが設定値に追従。期限文字列も `deadlineLabel()` で動的化（年度更新時にコード修正不要）。未設定時は既定 2027-03-12。`daysUntilDeadline(deadline)` を引数対応（後方互換）。
- **B3 月次推移グラフ**（`965a857` / dashboard.html/js）: ダッシュボードに直近6か月の月次新規案件数の棒グラフ（receivedAt基準・依存ライブラリ追加なし・データ無しは空状態表示）。
- **ドキュメント＆重大バグ修正**（`67ce049` / docpage.js・manual.html・engineering.html）: docpage.js の `db`(getFirestore) が未定義で `gateRole` がエラー→`showAccessDenied` が呼ばれ「アクセス権限がありません」となり**マニュアル/エンジニアノートがログイン後も閲覧不能だった**のを修正（`getFirestore` import + `const db` 追加）。両ドキュメントに今回の機能（認定事業所卸/配送方法・送料/請求書送料計上/申請期限設定/月次グラフ）を反映。engineering に §7「供給・請求の単価と送料」新設。**本番でログイン状態のブラウザ（Playwright）にて両ドキュメントの閲覧確認済み**（doc=block / Mermaid4図 SVG描画 / hasAccessDenied=false / console error0）。

- **D モバイル/アクセシビリティ底上げ**（`ef22f0e` / crm.css・dashboard/users/supply.js）: rule26＝`.btn`/`.filter-bar`入力の `min-height` を 44px に（行内ミニアクション含むタップターゲット）・`:focus-visible` グローバル追加・画面UIの 11px→12px（印刷物 partner-doc/supply-print は対象外）。rule25整合＝モバイル(1024px以下)でフォーム2カラム→1列（768px から昇格）。**本番ログイン状態のブラウザ（Playwright）で desktop/モバイル(390×844)両方を実機確認**（モバイルヘッダー表示・ドロワー隠れ・コンテンツ1列・月次推移グラフ表示・崩れなし・error0）。crm.css 既存のモバイル基盤（ヘッダー56px・ドロワー280px/240ms・分岐1024px・table-wrap横スクロール）は元から rule25 準拠だった。
- **C2 肥大化ファイル分割**（`1a7abdf` / `supply-pricing.js`・`case-detail-util.js` 新設）: 機能別分割（発注/出荷を別ファイル）は共有state(products/appSettings/activePartners)・onSnapshot・DOM依存が密でリスク高につき見送り、**state非依存の純粋ロジック/定数/ユーティリティのみ切り出し**（supply.js 798→749行＋pricing45行 ／ case-detail.js 650→592行＋util55行・`SOURCE_LABELS`は`constants.js`へ統合してC1重複排除）。挙動完全不変。**本番ログイン状態のブラウザで供給管理・案件詳細を実機検証**（console error0・全タブ描画・escHtml等のimport解決・アクセス拒否0）。
- **補助金区分の誤り訂正**（`71a5fa4` / index.html・mitsumori.html・料金md×2・本書）: 令和8年度 交付要綱別添(`r8_jyoseikin.pdf`)と突合し、**居宅療養管理指導(31)・地域密着型通所介護(78)は訪問・通所系¥64,000・3台**と確認（旧資料は居住系¥55,000/その他¥42,000に誤分類＝利用者へ過小案内していた）。LP早見表・注意書き／見積もりカード・35種リスト／料金md／本書の区分表・合意事項を訂正。**LP+見積もりを本番反映(hosting:lp)・curl全項目検証**。見積もりの計算ロジック(区分→上限額)は不変＝サービスの振り分けのみ修正。memory `reference_subsidy_categories.md` に正の区分を記録。介護情報基盤スペースへ告知済み（msg `0SHVO1lHmAg`）。⚠️**過去に居宅療養管理指導/地域密着型通所介護の事業所へ見積もりしていた場合は金額が変わるため要見直し**。
- **A2/A3 画面整理**: 調査の結果、設定7セクション・供給5タブ・案件詳細6タブで既に十分整理済み＝**達成済みと判断**（追加の意味ある整理なし・本番稼働中につき無理な微調整は見送り）。
- **アクセシビリティ監査の指摘を修正（WCAG 2.1 AA・`22443a4`）**: `/design:accessibility-review` 監査でCritical/Major検出→修正。①案件一覧の行(`tr onclick`)を**キーボード操作可能化**（`tabindex=0`/`role="link"`/`aria-label`/Enter・Space遷移・WCAG2.1.1）②全画面共通(`mobilenav.js`)のモーダルに**Escクローズ＋Tabフォーカストラップ＋初期フォーカス**(2.1.2/2.4.3)③`.btn-primary`を`#E33535`(白文字4.39:1)→`primary-dark #c02828`(5.85:1)に(1.4.3)。**本番ログイン状態のブラウザで実機検証**(Tab→案件行→Enterで詳細遷移／発注モーダルEscで閉じ／btn背景=rgb(192,40,40)確認)。カンバンのドラッグ移動(代替=サブ状態セレクトでキーボード可)・`--color-ink-light`(装飾のみ)はMinorで見送り。
- **直送発注→出荷下書き自動生成（2段階・`371331f`）**: 発注モーダルに「**認定事業所へ直送する**」チェック＋請求先の認定事業所セレクト（直送時必須・届け先住所は自動/手入力）。発注「確定して送付」時、直送指定なら `shipments` を **draft で自動生成**（shipType=dropship・単価=認定事業所卸 `partnerPricing`・品目数量は発注から引継ぎ・**在庫は経由しない**・発注に `shipmentId` 記録で二重防止）。`shipments` に **draft 状態を新設**。出荷タブで「下書き」表示＋サマリーに直送・下書き件数 → 「**出荷を確定**」で shipped(在庫動かさず) → 請求書/送付状。本番でUI実機確認（直送チェック表示・チェックONで請求先必須マーク連動・認定事業所3件ロード）。⚠️ **E2E（発注確定→draft生成→確定）は実メール送信を伴うため次田さんがテスト宛先で確認**。設計合意: 請求先=常に認定事業所／届け先=認定事業所orエンド事業所(大ロット時)／在庫経由なし／2段階(draft→確定)。
- **H-3 完全クローズ（セキュリティ・システム開発担当の指示対応）**: App Engine default SA(`appspot`)の `roles/editor`・旧 compute SA→`kjk-gmail-sa` の `tokenCreator` を剥奪（dry-run→裏取り[全関数fn-*-sa・fn-mail-sa維持]→剥奪→確認）。詳細・ロールバック手順は **SECURITY_REMEDIATION.md**。あわせて **users 運用フロー**（新規追加/退職者active=false/admin付与基準・write=isAdminのみ）を文書化。⚠️ 実機メール送信確認(sendCaseEmail/sendSupplierOrder)は次田さん。
- **本日機能をドキュメントに反映（`4c2965a`）**: MANUAL.md/manual.html(現場)＋ENGINEERING_NOTES.md/engineering.html(技術)に直送フロー等を**既存と重複なく**追記。ENG_NOTES §16 に本日全改修のサマリー。アプリ内は本番反映・curl確認済み。

### デプロイ
- 本番URL: https://kjk-tadakayo-admin.web.app（hosting:admin のみ・functions/rules不変＝誤削除リスクなし）
- rule05二段階: プレビュー `supply-b34-0606` → curl検証 → 本番昇格。本番 curl で新コード7種配信確認・HTTP200。
- ロールバック（万一実機で不具合時）: `firebase hosting:rollback --project kjk-tadakayo`

### 🙏 次田さんの実機確認（@tadakayoログイン要・最優先）
1. **料金・送料ページで「確定値をセット→保存」**（partnerPricing/letterpackFee/yupackTable を appConfig に確定。未保存でもフォールバックで動くが、認定事業所卸を正しく出すため保存推奨）
2. **供給管理→新規出荷**: 出荷種別=「認定事業所からの依頼(直送)」→配送方法でレターパック/ゆうパックを選び送料が自動入力されるか／単価が認定事業所卸(BT¥8,000等)になっているか
3. **請求書**（出荷の「請求書」ボタン）: 送料が10%対象明細として1行入り、合計が送料込みになっているか
4. **設定→助成金の申請期限** を設定→保存し、ダッシュボード等のバナー日付が変わるか
5. **ダッシュボード** の月次推移グラフ表示

### 次セッション（残ブラッシュアップ・本セッション見送り分）
- **A3/A2 はほぼ達成済み**（設定は7セクションに区切り済み・供給は5タブ整理済み）。残は case-detail のタブ整理程度＝効果小。
- **D モバイル/アクセシビリティ底上げ**: crm.css は @media 768/1024 の2本＋`.table-wrap`横スクロール済み。rule25(md→lg統一)・rule26(`min-height:36px`箇所→44px・最小フォント)に沿った底上げ。本番稼働中のため慎重に。
- **C2 肥大化ファイル分割**（supply.js 約800行 / case-detail.js 650行）: 高リスク・効果は保守性のみ。#1直後の大改造は避け **専用セッション推奨**。

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

### 区分①：訪問・通所・短期滞在系（¥64,000・3台）— 20種類
11訪問介護 / 12訪問入浴介護 / 13訪問看護 / 14訪問リハビリ / 15通所介護 / 16通所リハビリ /
21短期入所生活介護 / 22短期入所療養介護(老健) / 23短期入所療養介護(病院) / 2A短期入所療養介護(医療院) /
**31居宅療養管理指導** / **43居宅介護支援** / 68小規模多機能型(短期利用) / 71夜間対応型訪問介護 / 72認知症対応型通所介護 /
73小規模多機能型居宅介護 / 76定期巡回・随時対応型訪問介護看護 / 77看護小規模多機能型 / **78地域密着型通所介護** / 79看護小規模多機能型(短期利用)

### 区分②：居住・入所系（¥55,000・2台）— 11種類
27特定施設(短期利用) / 28地域密着特定施設(短期利用) /
32認知症対応型共同生活介護(GH) / 33特定施設入居者生活介護 / 36地域密着型特定施設 /
38認知症対応型共同生活介護(短期利用) / 51介護福祉施設(特養) / 52介護保健施設(老健) /
54地域密着型介護福祉施設 / 55介護医療院 / 59特定入所者介護サービス等

### 区分③：その他（¥42,000・1台）— 4種類
17福祉用具貸与 / 41特定福祉用具販売 / 42住宅改修 / 81市町村特別給付

### ⚠️ 注意：直感と違う分類

| サービス | 直感 | 正解 |
|---|---|---|
| 居宅介護支援（43）| その他？ | **訪問・通所系（¥64,000）** |
| 居宅療養管理指導（31）| 居住系？ | **訪問・通所系（¥64,000）**（要綱別添で確認。旧資料の¥55,000は誤り・2026-06-07訂正） |
| 地域密着型通所介護（78）| その他？ | **訪問・通所系（¥64,000）**（要綱別添で確認。旧資料の¥42,000は誤り・2026-06-07訂正） |

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
- 訪問・通所・短期滞在系: 訪問介護・通所介護・**居宅介護支援・居宅療養管理指導・地域密着型通所介護** 等
- 居住・入所系: グループホーム・特養・特定施設 等
- その他: 福祉用具貸与・特定福祉用具販売・住宅改修 等
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
- 居宅介護支援は ¥64,000 区分（要綱別添で確認）
- 居宅療養管理指導は ¥64,000 区分（要綱別添で確認・旧「¥55,000」は誤りだった／2026-06-07訂正）
- 地域密着型通所介護は ¥64,000 区分（要綱別添で確認・旧「¥42,000」は誤りだった／2026-06-07訂正）

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
