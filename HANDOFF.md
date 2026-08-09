# タダカヨの介護情報基盤伴走支援 LP / CRM 申し送り — 2026-08-08

> handoff-id: tadakayo
> サービス名: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）
> 旧セッション（④〜⑮）の詳細は `HANDOFF_ARCHIVE.md` へ移動済み

---

## 現在の状態

- LP（https://kjk.tadakayo.jp）・CRM管理画面（https://kjk-tadakayo-admin.web.app）とも本番稼働中。
- リポジトリは GitHub組織 `npo-tadakayo/kjk-tadakayo`。未コミット0・push済み。
- **過入金の充当・返金の記録は本番反映済み**（2026-08-08 の hosting デプロイで main ごと昇格。preview `undo-draft-0730` は役目終了）。
- **請求4件（¥2,643,872）はすべて入金済・未集金 ¥0**。残るのは SH-2026-0001 の実過入金 **¥93**（請求 ¥88,919 に対し ¥89,012 入金）のみ＝次回請求で充当か放置で可。
- Cloud Function `sendPartnerMail`（催促メール）は**本番作成済み**（gcfv2 / asia-northeast1）。

## 今セッション（⑰・2026-08-08）でやったこと

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

## 次回やること（優先順）

1. **PO-2026-0049（50台・8/5発注）の入荷登録**: 届いたら発注タブの「入荷登録」→ 在庫 220→270台
2. **過入金 ¥93 の処理**: プラスエスさんへの次回請求で「過入金を充当」（急がない・放置でも実害なし）
3. 実機での取込確認（要ログイン）: 受注タブ →「発注ファイルを取り込む」→ `発注テンプレート.csv` → SO番号採番まで
4. （運用）CIR415A は半年に1度の通電をアナウンス（2026-07-24 林さん）

（完了済み: 過入金・返金の本番昇格／請求4件の発行・入金確認／直送2件の出荷確定／200台入荷 → セッション⑰）

## 未決事項

- **過入金の充当は「同一請求先内のみ」**で実装（直送=`partnerEmail`／直接=事業所名で判定）。グループ会社間で回す運用が必要か次田さん確認待ち。
- **返金の証憑（返金明細書）は未作成**。相手に渡す書面が必要なら追加する。
- **領収書は入金額を自動反映しない**（明細を画面で編集する方式のため）。過入金・一部入金を含む場合は明細を実領収額に直してから「発行を記録」する。

## 重要な合意事項（蒸し返し禁止）

- **赤の正本は `#E33535`（タダカヨレッド）＋ `#FFE4EC`（ピンク）**。白文字ボタン・ピンク面の文字は `#c02828`
- 認定事業所卸は `appConfig.settings.partnerPricing`（非パススルー）。**CIR415Aは ¥8,000 固定**（2026-07-28）
- **送料は税抜で保存・入力**（発注・出荷とも）。請求書は税抜で積み上げ、消費税は小計に1回だけ
- **AB Circleの送料は1便100台以上が無料**（地域別は北海道¥1,500／関西¥1,100 ほか＝`supply-pricing.js`）
- **入金・未集金の管理単位は出荷(SH)単位**（月締めでまとめる方式は採らない・2026-07-30 次田さん）
- **過入金は返金より「次回請求から差し引く」が基本**（返金も選べる・2026-08-01 次田さん）
- 領収書の**明細編集**は印刷用の一時編集。ただし**発行記録**（番号・発行日・金額・明細）は `receipts` に保存する（2026-07-30 変更）
- **ICカードリーダーの供給・請求はこのCRMが正本**。ケアプー記録アプリには実装しない

## ハマりポイント・注意事項

- **Functions デプロイは Drive 上から不可**: `functions/node_modules` の読込に **12分23秒**（ローカルなら0.1秒）かかり、Firebase CLI の10秒制限に間に合わない（`Cannot determine backend specification. Timeout after 10000`）。手順は ①`rsync -a --exclude node_modules functions/ <ローカル>/functions/` ②`.firebaserc` コピー＋`firebase.json` は `{"functions":{"source":"functions"}}` ③`npm ci --omit=dev` ④`deploy --only "functions:名前" --account yoshinao-tsukuda@tadakayo.jp`。**`--account` 必須**（一時ディレクトリは `login:use` 未設定＝279アカウントで `iam.serviceAccounts.ActAs` 403）
- **push手順**: origin は `npo-tadakayo/kjk-tadakayo`。gh のアクティブが `ytsukuda4470` だと403 → `gh auth switch -u tsuku-29` → push
- **firebase MCP は使わない**（279 の tougou-db に接続）。kjk-tadakayo の Firestore は**タダカヨのADCトークンで REST 直叩き**（`CLOUDSDK_ACTIVE_CONFIG_NAME=tadakayo` → `gcloud auth print-access-token` → `firestore.googleapis.com/v1/projects/kjk-tadakayo/...`）
- **デプロイは rule05 二段階**: `hosting:channel:deploy {ch} --only admin` → curl検証 → `hosting:clone …:live`（live 昇格は自動承認でブロックされるため次田さんが実行）
- 帳票ページ（supply-print / report）は crm.css を読まない独立CSS。ブランド色を変える時は両方直す
- `/supply.html` は 301 で `/supply` にリダイレクト（curl 検証時は `-L` を付ける）
- **タダカヨの gcloud ユーザー認証が期限切れ**（2026-08-08 時点）。Firestore REST 直叩きの前に `gcloud auth login`（tadakayo 設定）を通す。ADC は 279 アカウント（y.tsukuda@279279.net）のままなので kjk-tadakayo には使えない

## 再開コマンド

cd ~/Projects/tadakayo/01_システム開発/tadakayo-kiban && claude

## 関連URL・リソース

- LP本番: https://kjk.tadakayo.jp ／ CRM本番: https://kjk-tadakayo-admin.web.app
- GitHub: https://github.com/npo-tadakayo/kjk-tadakayo
- 仕様書: `ENGINEERING_NOTES.md`（正本）／ `MANUAL.md` ／ アプリ内 `/manual` `/engineering`
- アクセス解析: Clarity `wax7x03bg8` ／ GA4 `G-V70326L8MW`（タダカヨ側プロパティ 541485334）
- 旧セッション詳細: `HANDOFF_ARCHIVE.md`
