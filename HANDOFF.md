# タダカヨの介護情報基盤伴走支援 LP / CRM 申し送り — 2026-08-11

> handoff-id: tadakayo
> サービス名: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）
> 旧セッション（④〜⑮）の詳細は `HANDOFF_ARCHIVE.md` へ移動済み

---

## 現在の状態

- LP（https://kjk.tadakayo.jp）・CRM管理画面（https://kjk-tadakayo-admin.web.app）とも本番稼働中。**LPは2026-08-10 に動画セクション＋公開設定修正を live 反映済み**。
- リポジトリは GitHub組織 `npo-tadakayo/kjk-tadakayo`。未コミット0・push済み（`dffbd8a` + 本申し送り更新）。
- **CRMのメール送信元は `kjk-staff@tadakayo.jp`**（From: `タダカヨ事務局 <kjk-staff@tadakayo.jp>`）。変更はCRMの設定画面「メール送信元アドレス」から可（コード修正・デプロイ不要）。ただし**実在のメールボックスであること**が必須（委任はユーザーとして送る方式のためエイリアス不可）。
- **過入金の充当・返金の記録は本番反映済み**（2026-08-08 の hosting デプロイで main ごと昇格。preview `undo-draft-0730` は役目終了）。
- **請求4件（¥2,643,872）はすべて入金済・未集金 ¥0**。SH-2026-0001 の過入金 **¥93** は**次田さんが返金処理して解消済み**（2026-08-12・充当ではなく返金を選択）。
- **入金まわりの3機能（グループ会社間の過入金充当／返金明細書／領収書への実入金反映）は 2026-08-12 に本番反映済み**。ただし**実データでの実機操作は未実施**（充当は同一請求先に過入金がある状態でないと画面が開かない）。
- Cloud Function `sendPartnerMail`（催促メール）は**本番作成済み**（gcfv2 / asia-northeast1）。
- **経理への請求書発行報告（⑲・2026-08-11）は Functions・ルール・UI・設定すべて本番反映済み＝使える状態**。ただし**実際の送信検証は未実施**（本番送信が田中さんに届くため）。次回まず1件流して確認する。

## 今セッション（⑳・2026-08-12）でやったこと

- **未決だった入金まわり3件を実装・本番反映**（`e320496` / admin live version `86ba31770138fad3`・release `1786530245266000`）
  1. **過入金の充当で充当元を選べるように**（グループ会社間の充当に対応）: `openCreditModal()`＋`doApplyCredit()`。同一請求先は既定チェック＋FIFO自動配分で従来と同結果、`crossCreditSourcesFor()` の別請求先は「別請求先」バッジ・**既定オフ**・`confirm()` 必須。`creditFrom[]` に `fromBillTo`/`crossBillTo` を記録し請求書の充当行に充当元の請求先名を印字。自動サジェストは同一請求先のみ
  2. **返金明細書を追加**（`type=refund`・番号 RFND）: 返金全件＋請求/入金/返金/差引後の内訳・領収書ではない旨を明記・`refundStatementIssuedAt` で発行記録。返金がある行にボタン表示
  3. **領収書の領収金額に実入金を自動反映**: 初期値 `min(netPaid, billableIncl)`。`#rcptGrand`（明細合計）と `#rcptTotal`（領収金額）を分離・入力欄で上書き可。一部入金は但し書き「内金として」自動化、充当分・内金分の理由を書面に印字、印紙判定も領収金額基準
- **検証**: 充当ロジックのシナリオ24件（同一/別請求先・直送の請求先判定・FIFO順・キャンセル除外・返金後0・実データ SH-2026-0001 の¥93再現）全合格／帳票6ケースをブラウザ描画／充当モーダルのDOM挙動／`node --check`＋`getElementById` 185件の id 実在チェック／preview `nyukin-3ken` と本番で配信11項目を curl 検証
- **CRMのメール送信元を確認**: 依頼のあった `kjk-staff@tadakayo.jp` は既に設定済みで**変更不要**だった（Firestore `gmailSender`=2026-07-27保存／env 未設定／コード既定値も同じ・送信実績あり・エラー0件）
- 次田さんが**現状の過入金 ¥93 は返金処理で解消**（充当ではなく返金を選択）
- ⚠️ **firebase CLI の認証が再び279側に戻った**（次田さんの再ログイン直後は通ったが、その後 403）。今回のデプロイは Hosting REST API のスクリプトで実施 → **[Issue #3](https://github.com/npo-tadakayo/kjk-tadakayo/issues/3) で「スクリプトをrepoに置くか」を保留中**
- **[Issue #2](https://github.com/npo-tadakayo/kjk-tadakayo/issues/2) をクローズ**（請求書4件の発行・200台入荷・発注書の後追いはすべて完了済みだった。起票時の ¥1,763,779 は SH-0003 の 100→200台変更で実際は ¥2,643,872）

## 前セッション（⑲・2026-08-11）でやったこと

**請求書を発行したら経理へ報告する機能**を実装（コミット `1e6ddcb` / push済み）。

- 「請求済にする」→ **確認ダイアログ**。`経理へ報告する`（初期ON・**既報告済みならOFF**）で送信可否を選ぶ＝**再発行では送らない**運用。
- 送ると ①経理スペースへ Chat カード投稿（請求先・金額・支払期限＋「請求書PDFを開く」「CRMで開く」）②経理担当へ**請求書PDF添付メール**。Chat本文に「〇〇さんにもメールを送信しました」。
- **⚠️ Google Chat の Incoming Webhook はファイル添付不可**（添付の `media.upload` は**ユーザーOAuth認証のみ**対応でSA・Webhookは不可＝[公式ドキュメント](https://developers.google.com/workspace/chat/upload-media-attachments)で裏取り済み）。**この結論は蒸し返さない**。PDF本体はメール添付・ChatはStorageのPDFリンク（download token 付きURL）で代替した。
- 設定（`accountingChatWebhookUrl` / `accountingEmail` / `accountingContactName` / `accountingEmailCc` / `invoiceMailSubject` / `invoiceMailBody`）は**すべて設定画面から変更可**。LP通知用の `chatWebhookUrl` とは**別スペース**。
- 請求書描画を `admin/js/invoice-doc.js` に共通化（`po-doc.js` と同じ作法）。`supply-print.js` は委譲、`supply.js` は同じ関数でPDF生成。報告金額は一覧と同じ `billableIncl()` を正とする。
- メール／Chatは**片方失敗でも他方を続行**し `warnings[]` を返す。報告漏れ・失敗は請求済の行の**「経理へ報告」**ボタンで後追い可（ステータスは変えない）。

### デプロイ状況（⑲）— **すべて本番反映済み・使える状態**

| 対象 | 状態 |
|---|---|
| Function `reportInvoiceToAccounting` | ✅ 本番稼働（gcfv2 / asia-northeast1 / 256MB / nodejs20）。未認証POST→403「このアプリの利用権限がありません」で権限ゲート確認済み |
| `storage.rules`（`invoices/**` 追加） | ✅ 本番反映済み（compile OK・released） |
| 管理画面UI | ✅ **live 反映済み**（preview `keiri-report` で検証 → 次田さんが `hosting:clone` で昇格）。live で `invoice-doc.js` 200・モーダル13/13要素・設定6/6項目・callable参照・`supply-print.js` の委譲を curl 確認 |
| Storage 書き込み権限 | ✅ `fn-mail-sa` に `roles/storage.objectAdmin`（**もともと付与済みだった**＝追加付与は不要だった） |
| 設定（`appConfig/settings`） | ✅ 入力済み（Firestore REST で確認）: Chat Webhook＝スペース `AAAA8jZ0ZJk`（形式OK・**LP通知用 `chatWebhookUrl` とは別スペース**）／`accountingEmail`=hidetoshi-tanaka@tadakayo.jp ／`accountingContactName`=`田中（ヒデスさん）` ／CC空 ／件名・本文テンプレ保存済み |

### ⑲で未確認のこと（次回の最初に確認する）

- **実機の送信検証はしていない**。実際のChat投稿・メール送信は**実在の田中さん宛の本番送信**になるため Claude 側では打っていない。テスト用出荷1件で1回流して、Chatカードの見え方・メールの添付・PDFリンクが開けるかを確認する。
- **呼び名が `田中（ヒデスさん）`** なので、Chat本文は「**田中（ヒデスさん）さん**にもメールを送信しました」、メール宛名は「田中（ヒデスさん） さん」になる（「さん」は自動付与）。二重敬称が気になるなら設定画面で呼び名を短くする（保存だけ・デプロイ不要）。
- 文面・カードの項目を直したくなった場合、**件名・本文は設定画面で変更可**。Chatカードの構造だけは `functions/index.js` の `invoiceChatMessage()` 修正＋Functions再デプロイが必要。

## 前セッション（⑰・2026-08-08）でやったこと

- **入金・返金履歴の「取消」ボタンが押せない不具合を修正**（`b99c826`）: 履歴テーブルだけ `.table-wrap` 未適用でモーダル幅（560px）から備考列・取消列がはみ出していた。横スクロール化＋ボタンに「取消」文字ラベル追加。
- `firebase deploy --only hosting:admin` で**本番へ直接デプロイ**（操作不能バグ＋誤データ滞留のため二段階手順を省略・curl で反映確認済み）。副産物として preview 止まりだった過入金充当・返金も本番化。
- 次田さんが SH-2026-0001 の誤入金 ¥529,210（2026-08-05）を取消し、**SH-2026-0004 に正しく付け直し**（入金済 2026-08-06）。SH-2026-0003 も ¥1,760,000 入金済。実機画面で全件確認済み。
- **認定事業所への「発注方法のご案内メール」を追加**（`907cc11`・本番反映済み）: パートナー管理の「発注案内」ボタン → 宛先/CC/件名/本文をプレビューで編集して送信（基盤は `sendPartnerMail` 流用・Functions変更なし）。送信で `partners` に `guideSentAt`/`guideMailLog` 記録・ボタンに「済 月/日」。定型文は `appConfig.settings.guideMailSubject/guideMailBody` で差替可。preview `guide-mail` で検証→次田さんが live 昇格。
- **PO-2026-0046（200台）は入荷済を確認**（在庫220台）。PO-2026-0049（50台・8/5発注）が入荷待ちに追加。
- タダカヨの firebase CLI は次田さんが `firebase login --reauth` で復旧済み（gcloud はまだ）。
- **供給事業サマリー資料（PNG・ドキュメント貼付用）を作成**: 在庫220台／仕入累計¥402.4万（570台）／販売300台・粗利¥28.5万（2社別内訳）。正本 `タダカヨ_project/_アウトボックス/20260808_介護情報基盤_供給事業サマリー/`（HTML原本つき・数字が動いたらHTML修正→ヘッドレスChromeでPNG再生成）。データはCRM本番Firestoreから集計（ログイン済みブラウザの javascript_tool で Firebase SDK を dynamic import して読み取り）。

## 前セッション（⑯・2026-07-30〜08-01）でやったこと

### 1. 発注3件を再発注（Firestore直接＋メール送信）

PO-2026-0046/0047/0048 は「実は未発注」だったため下書きへ戻し、発注日を 2026-07-30 に変更して**3件とも実送信**（CC控えを受信箱で確認済み・17:00 JST）。備考の古い記述（「発注書送付済み」等）は次田さん指示で削除。

| 発注 | 台数 | 送料 | 区分 | 状態 |
|---|---|---|---|---|
| PO-2026-0046 滋賀（在庫） | 200台 | ¥0 | 自社入荷 | 発注済み・未入荷 |
| PO-2026-0047 札幌→279様 | **200台**（100→200に変更） | ¥0 | 直送 | 発注済み・未入荷 |
| PO-2026-0048 八尾→プラスエス様 | 60台 | ¥1,100 | 直送 | 発注済み・未入荷 |

AB Circle への支払は税別 ¥3,243,000＋送料 ¥1,100。
PO-0047/0048 に**直送フラグ・請求先・出荷下書きID**を紐付け、SH-2026-0003 を 100→200台（¥1,600,000／税込 ¥1,760,000）に修正、両出荷の予定日を 2026-07-30 に。**未請求は ¥2,643,779**（SH-0001 ¥88,919／SH-0002 ¥265,650／SH-0003 ¥1,760,000／SH-0004 ¥529,210）。

### 2. 入金・未集金・領収書・返金（`09da5d1`）

- **入金**: `payments[]` の履歴方式に（`prompt` 廃止→モーダル）。**部分入金・分割払い・複数回入金**に対応。残額0で `paid`／残ありは `invoiced` のまま。個別に取消可。旧 `paymentAmount/paidAt` は履歴1件として読替＝移行不要
- **返金**: `refunds[]`（振込／現金／相殺）。判定は**純入金＝入金合計−返金合計**。請求額まで返金すると `paid`→`invoiced` に戻る（取引取消は出荷削除）
- **過入金**: 返金せず**次回請求から差し引く**。`billToKey()` で同一請求先・古い分から FIFO・引ききれない分は残高として持ち越し。請求書に「前回お預かり分の充当 −¥X」「今回お支払額」を出力
- **未集金**: 支払期限＝**請求月の翌月末**を自動算出＋超過日数。請求先ごとの未集金表（残額／過入金／差引後／対象出荷／最長超過日数）。受注タブに「請求・入金」列
- **催促メール**: 新 callable `sendPartnerMail`（`sendSupplierOrder` と同じ SA_MAIL・DWDキーレス・`gmail.send`）。`mailLog[]`＋`dunningSentAt/dunningCount` に記録
- **領収書の発行記録**: `receipts/{出荷ID}` に番号・発行日・金額・但し書き・明細・用途区分集計を保存し、**再表示時に復元して同一内容で再発行**できる（一覧のボタンに「発行済 MM/DD」）

### 3. 発注まわりの改善（同 `09da5d1`）

- **発注済→下書きに戻す**（`revertedAt/revertedBy` 記録・入荷済は在庫が動いているため対象外）
- **直送発注は「入荷登録」を非表示**（自社在庫を経由しないので誤加算防止・状態欄に「直送（入荷なし）」）
- 送料の自動入力に「**1便100台以上は無料**」を反映

### 4. ドキュメント（`18009b8`）

`MANUAL.md`・`ENGINEERING_NOTES.md`（§C3 データモデル＋ER図＋変更履歴）・アプリ内 `admin/manual.html`・`admin/engineering.html` に上記すべてを反映。

### テスト

構文チェック＋id存在チェック（各デプロイ前）／期限計算8ケース（年末越え・月末・上書き・日付不明）／入金・返金・充当の通し4シナリオ（分割入金・二重入金→返金・一部返金＋充当・全額返金で未集金へ復帰）／preview 配信10項目＋本番配信10項目を curl 検証。すべて合格。

## 前セッション（⑱・2026-08-10）でやったこと

- **LPに動画セクション `#movie` を追加**（`b8fdffd`・**本番反映済み**）: YouTube「【5分でわかる】ケアプーが介護情報基盤にお引っ越し！？」（4:18・自社チャンネル・8/3公開）を「2026年4月から変わったこと」の直後に掲載。クリックするまでYouTubeへ通信しない click-to-play（サムネは自己ホスト `images/movie_kjk_2027.webp`・再生時のみ youtube-nocookie）。見どころ4点＋チャプター送り（1:30/1:57/3:04/3:25）＋出典・8/26説明会の注記。WHYからの導線・FAQ9件目・構造化データ VideoObject も追加
- 🔴 **本番LPから内部ファイルが公開されていたのを発見・修正**（`3ae3185`・**本番反映済み＝公開停止**）: `admin-*.png` 10件（実在の事業所名・担当者名・携帯番号・メールが写った管理画面スクショ）・パートナーシップ協定書ドラフト.docx・有償事業化企画書.docx・料金シミュレーション等のPDF・商品マスタ.csv・発注テンプレート.csv・firestore.rules・.DS_Store が 200 で取得できた。原因は hosting lp の `public` が `.`（リポジトリ直下）で、.gitignore 済みのファイルもデプロイされていたこと。firebase.json の ignore に追記
  - **公開期間: 2026-07-02（前回のLPリリース）〜2026-08-10 の約5週間**。live のファイル数は **252→36** に減った
- **デプロイ実施（二段階）**: preview `movie-2027`（version `5d9e8149b852ceec`）で verify → **live 昇格**（version `e786d17e993f002b` / release `1786354736157000` / 2026-08-10 18:38 JST）。本番で必要ファイル8件が200・内部ファイル**22件すべて404**・動画セクション要素11項目・キャッシュヘッダー・**再生前のYouTubeリクエスト0件**・チャプター送り（3:25で該当スライド表示）を確認
- **CRMのメール送信元を確認**: 依頼のあった `kjk-staff@tadakayo.jp` は既に設定済みだった（Firestore `appConfig/settings.gmailSender`=2026-07-27保存／env `GMAIL_SENDER` 未設定／コード既定値も同じ）。7-30・8-5 の発注メール送信実績あり・エラーログ0件。**変更不要**
- firebase CLI の認証が279と入れ替わっていたため Hosting REST API で直接デプロイした（回避策は下記）。**セッション終盤に次田さんが再ログインし、CLI は復旧済み**（`projects:list` に `kjk-tadakayo (current)`・`hosting:channel:list` も通る）→ 次回は通常の CLI 手順でよい

## 次回やること（優先順）

00. **経理への請求書発行報告の実機検証（⑲の続き・所要5分）**: 発送済の出荷1件で「請求済にする」→ ダイアログで「経理へ報告する」ON → 送信。①経理スペースのChatカードが出るか ②「請求書PDFを開く」で実際にPDFが開けるか（Storage の download token URL）③田中さんのメールにPDFが添付されて届くか ④一覧が「経理へ報告済み MM/DD」になるか を確認。**練習だけなら「経理へ報告する」を外せば送信なしで請求済にできる**。呼び名 `田中（ヒデスさん）` の二重敬称が気になるなら設定画面で短くする。
1. **PO-2026-0049（50台・8/5発注）の入荷登録**: 届いたら発注タブの「入荷登録」→ 在庫 220→270台
2. **入金まわり3機能の実機確認**（⑳の続き・要ログイン）: ①返金がある出荷（SH-2026-0001）の行に「返金明細書」が出るので開いて内容を確認 ②入金済の出荷で「領収書」を開き、領収金額に実入金が入っているか・「実入金に戻す／明細合計に合わせる」が効くかを確認 ③充当画面は**同一請求先に過入金がある状態でないと開けない**ため、次に過入金が出たときに確認する
3. 実機での取込確認（要ログイン）: 受注タブ →「発注ファイルを取り込む」→ `発注テンプレート.csv` → SO番号採番まで
4. （運用）CIR415A は半年に1度の通電をアナウンス（2026-07-24 林さん）

（完了済み: 過入金・返金の本番昇格／請求4件の発行・入金確認／直送2件の出荷確定／200台入荷 → セッション⑰）

**公開ファイル事故（2026-07-02〜08-10）は 2026-08-13 に対応完了・クローズ**。残っていた判断4件（Search Console／議事録PDFの扱い／Pマーク上の事故該当性／ローカル実体の扱い）はすべて次田さんが対処済み。調査結果の正本は `タダカヨ_project/_Pマーク/個人情報ファイル管理台帳.md` の「2026-08-12 の事後調査」節。**再発防止（firebase.json の ignore・version マニフェストでの確認）は下の「ハマりポイント」に残す**。

## 未決事項

（2026-08-12 に3件すべて実装・本番反映して解消。下の「重要な合意事項」へ移動）

## 重要な合意事項（蒸し返し禁止）

- **赤の正本は `#E33535`（タダカヨレッド）＋ `#FFE4EC`（ピンク）**。白文字ボタン・ピンク面の文字は `#c02828`
- 認定事業所卸は `appConfig.settings.partnerPricing`（非パススルー）。**CIR415Aは ¥8,000 固定**（2026-07-28）
- **送料は税抜で保存・入力**（発注・出荷とも）。請求書は税抜で積み上げ、消費税は小計に1回だけ
- **AB Circleの送料は1便100台以上が無料**（地域別は北海道¥1,500／関西¥1,100 ほか＝`supply-pricing.js`）
- **入金・未集金の管理単位は出荷(SH)単位**（月締めでまとめる方式は採らない・2026-07-30 次田さん）
- **過入金は返金より「次回請求から差し引く」が基本**（返金も選べる・2026-08-01 次田さん）
- 領収書の**明細編集**は印刷用の一時編集。ただし**発行記録**（番号・発行日・金額・明細）は `receipts` に保存する（2026-07-30 変更）
- **ICカードリーダーの供給・請求はこのCRMが正本**。ケアプー記録アプリには実装しない
- **過入金の充当は「充当元を人が選ぶ」方式**（2026-08-12 次田さん）。同一請求先は既定チェック＋古い順に自動配分＝従来と同結果。**別請求先（グループ会社）も選べるが既定はオフ・確認ダイアログ必須・自動では絶対に跨がない**。跨いだ場合は請求書に充当元の請求先名を印字する
- **返金の証憑は「返金明細書」**（`type=refund`・番号 RFND）。領収書ではなく当方が支払う側の書面なので印紙は不要。返金内容の正本は `shipments.refunds[]` で、別コレクションは作らない
- **領収書の領収金額は実入金から自動**（2026-08-12）＝`min(純入金, 請求額(充当後))`。過入金の超過分は含めない／一部入金は但し書きを「内金として」に自動変更／充当分は書面に注記。金額は画面で上書き可

## ハマりポイント・注意事項

- **Functions デプロイは Drive 上から不可**: `functions/node_modules` の読込に **12分23秒**（ローカルなら0.1秒）かかり、Firebase CLI の10秒制限に間に合わない（`Cannot determine backend specification. Timeout after 10000`）。手順は ①`rsync -a --exclude node_modules functions/ <ローカル>/functions/` ②`.firebaserc` コピー＋`firebase.json` は `{"functions":{"source":"functions"}}` ③`npm ci --omit=dev` ④`deploy --only "functions:名前" --account yoshinao-tsukuda@tadakayo.jp`。**`--account` 必須**（一時ディレクトリは `login:use` 未設定＝279アカウントで `iam.serviceAccounts.ActAs` 403）
- **push手順**: origin は `npo-tadakayo/kjk-tadakayo`。gh のアクティブが `ytsukuda4470` だと403 → `gh auth switch -u tsuku-29` → push
- ⚠️ **タダカヨ側の認証情報がセッション中に消えることがある**（2026-08-12 に firebase CLI と gh の両方で発生）。gh は `tsuku-29` が候補から消えて `gh auth switch -u tsuku-29` が「no accounts matched」になり、push が ytsukuda4470 名義で403になった。**復旧は `gh auth login`（ブラウザ＝次田さん操作）**。firebase CLI も同様に279へ入れ替わる（→ Issue #3）。同じ根っこ（279作業と共有の認証ストアが上書きされる）と見られる
- **firebase MCP は使わない**（279 の tougou-db に接続）。kjk-tadakayo の Firestore は**タダカヨのADCトークンで REST 直叩き**（`CLOUDSDK_ACTIVE_CONFIG_NAME=tadakayo` → `gcloud auth print-access-token` → `firestore.googleapis.com/v1/projects/kjk-tadakayo/...`）
- **デプロイは rule05 二段階**: `hosting:channel:deploy {ch} --only admin` → curl検証 → `hosting:clone …:live`（live 昇格は自動承認でブロックされるため次田さんが実行）
- 帳票ページ（supply-print / report）は crm.css を読まない独立CSS。ブランド色を変える時は両方直す
- `/supply.html` は 301 で `/supply` にリダイレクト（curl 検証時は `-L` を付ける）
- **「公開されているか」の確認は curl の目視ではなく version マニフェストで行う**（2026-08-12 に偽陰性を出した）。`GET https://firebasehosting.googleapis.com/v1beta1/sites/{site}/versions/{versionId}/files?pageSize=300` が**そのリリースで実際に配信されていた全ファイル**を返す。curl はファイル名にコロン・日本語・特殊文字が入ると照会が壊れて404になり「公開されていない」と誤読する
- **hosting lp の public は `.`（リポジトリ直下）**。git 管理外のファイルもデプロイされるので、**ルート直下に内部資料を置いたら firebase.json の ignore に必ず追記する**。確認は `node -e "const{listFiles}=require('/opt/homebrew/lib/node_modules/firebase-tools/lib/listFiles.js');console.log(listFiles('.',JSON.parse(require('fs').readFileSync('firebase.json','utf8')).hosting[0].ignore).sort().join('\n'))"`（hosting エミュレータは ignore を無視するので検証に使えない）
- **ignore に日本語パスを書くときは濁点に注意**: Drive上のフォルダ名は NFD（濁点分解）なので、JSON に NFC で書いた `議事録など/**` はマッチしない。濁点を含まない前方一致（`議事*/**`）にする
- **firebase CLI の認証情報が279のものと入れ替わることがある**（2026-08-10 発生・同日復旧済み）: 症状は「`login:list` は `yoshinao-tsukuda@tadakayo.jp` を active と表示するのに、`projects:list` に出るのは tougou-db / voice-memo など**279のプロジェクト**で kjk-tadakayo が無い」→ `hosting:channel:deploy` が「Failed to get Firebase project」で落ちる。**復旧は `firebase login --reauth --account yoshinao-tsukuda@tadakayo.jp`（ブラウザ＝次田さん操作）**。復旧確認は `projects:list` に `kjk-tadakayo (current)` が出ること＋`hosting:channel:list --site kjk-tadakayo` が通ること
  - **回避策（CLIが直せないとき）**: gcloud のタダカヨ認証が生きていれば、**Hosting REST API で直接デプロイできる**。`gcloud auth print-access-token --account yoshinao-tsukuda@tadakayo.jp` ＋ ヘッダー `x-goog-user-project: kjk-tadakayo`（これが無いと quota project 未設定で403）。versions作成 → populateFiles → gzipしたファイルをhash単位でアップロード → FINALIZE → releases。⚠️ **firebase.json の headers/redirects は REST では形が違う**（`source`→`glob`、`[{key,value}]`→`{k:v}`、`type`→`statusCode`）。スクリプトは `/private/tmp/.../scratchpad/deploy-hosting.mjs`（セッション破棄で消えるので必要なら repo に移す）
- **タダカヨの gcloud ユーザー認証が期限切れ**（2026-08-08 時点）。Firestore REST 直叩きの前に `gcloud auth login`（tadakayo 設定）を通す。ADC は 279 アカウント（y.tsukuda@279279.net）のままなので kjk-tadakayo には使えない

## 再開コマンド

cd ~/Projects/tadakayo/01_システム開発/tadakayo-kiban && claude

## 関連URL・リソース

- LP本番: https://kjk.tadakayo.jp ／ CRM本番: https://kjk-tadakayo-admin.web.app
- GitHub: https://github.com/npo-tadakayo/kjk-tadakayo
- 仕様書: `ENGINEERING_NOTES.md`（正本）／ `MANUAL.md` ／ アプリ内 `/manual` `/engineering`
- アクセス解析: Clarity `wax7x03bg8` ／ GA4 `G-V70326L8MW`（タダカヨ側プロパティ 541485334）
- 旧セッション詳細: `HANDOFF_ARCHIVE.md`
