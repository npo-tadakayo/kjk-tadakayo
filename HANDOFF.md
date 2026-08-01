# タダカヨの介護情報基盤伴走支援 LP / CRM 申し送り — 2026-08-01

> handoff-id: tadakayo
> サービス名: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）
> 旧セッション（④〜⑮）の詳細は `HANDOFF_ARCHIVE.md` へ移動済み

---

## 現在の状態

- LP（https://kjk.tadakayo.jp）・CRM管理画面（https://kjk-tadakayo-admin.web.app）とも本番稼働中。
- リポジトリは GitHub組織 `npo-tadakayo/kjk-tadakayo`。未コミット0・push済み。
- ⚠️ **本番に出ていない変更が2つあります**（preview チャンネル `undo-draft-0730` にのみ配信済み）:
  **①過入金の次回請求への充当 ②返金の記録**。昇格コマンドは「次回やること1」。
- Cloud Function `sendPartnerMail`（催促メール）は**本番作成済み**（gcfv2 / asia-northeast1）。

## 今セッション（⑯・2026-07-30〜08-01）でやったこと

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

1. **過入金・返金の本番昇格**（未実施・これをやらないと2機能が使えない）
   `npx firebase-tools hosting:clone kjk-tadakayo-admin:undo-draft-0730 kjk-tadakayo-admin:live --project kjk-tadakayo`
   （preview は 2026-08-04 まで有効。切れたら `hosting:channel:deploy undo-draft-0730 --only admin` で作り直す）
2. **請求書4件の発行と入金確認**（¥2,643,779）。発送済の SH-0001/0002 を「請求済にする」→ 支払期限が付き未集金表・催促メールが動き出す
3. **200台の入荷登録**（PO-2026-0046）: 滋賀に届いたら在庫 20→220台。**PO-0047/0048 は直送なので入荷登録しない**（ボタンも出ない）
4. **直送2件の出荷確定**: AB Circle が発送したら SH-0003（279様200台）・SH-0004（プラスエス様60台）を「出荷を確定」→ 請求へ
5. 実機での取込確認（要ログイン）: 受注タブ →「発注ファイルを取り込む」→ `発注テンプレート.csv` → SO番号採番まで
6. （運用）CIR415A は半年に1度の通電をアナウンス（2026-07-24 林さん）

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

## 再開コマンド

cd ~/Projects/tadakayo/01_システム開発/tadakayo-kiban && claude

## 関連URL・リソース

- LP本番: https://kjk.tadakayo.jp ／ CRM本番: https://kjk-tadakayo-admin.web.app
- GitHub: https://github.com/npo-tadakayo/kjk-tadakayo
- 仕様書: `ENGINEERING_NOTES.md`（正本）／ `MANUAL.md` ／ アプリ内 `/manual` `/engineering`
- アクセス解析: Clarity `wax7x03bg8` ／ GA4 `G-V70326L8MW`（タダカヨ側プロパティ 541485334）
- 旧セッション詳細: `HANDOFF_ARCHIVE.md`
