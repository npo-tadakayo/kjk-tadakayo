# タダカヨの介護情報基盤伴走支援 LP / CRM 申し送り — 2026-09-06

## 伴走支援承諾書（2026-09-01 実装・本番反映済み）

- **オンライン署名一式が動いている**（コミット 5479c52）。案件詳細→事前確認タブ先頭のカードから
  発行→メール依頼／QR／URLコピー→事業所が /consent?t={token} で署名→カードが署名済みに変わる
- **条文は v1.1**（2026-09-02・利用規約/プライバシーポリシーと突合して改訂。v1.0 は CONSENT_ARCHIVE に凍結）。
  変えるときは version を上げて旧版を CONSENT_ARCHIVE に凍結（ケアプー docs/19 の作法）。**v1.0 で署名済みの1件は displayNo が ID断片（CST-I0Q1r3ILPeju）**＝表示番号だけなので直すなら Admin SDK で `CST-96` に（条文は触らない・要承認）
- ルールの検証は未認証RESTで実測済み（改ざん403・時刻偽装403・再署名403・正規署名○）
- 条文ドラフトPDF: 00_outbox/伴走支援承諾書ドラフト_介護情報基盤版_20260901/
- 検討の全文: 伴走支援承諾書_介護情報基盤版_検討.md
- 動画7単元は 2026-09-02 に v1.1 で作り直し済み（承諾書カード・事前送付・伴走支援記録の編集を反映）

> handoff-id: tadakayo
> サービス名: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）
> 旧セッション（④〜⑮）の詳細は `HANDOFF_ARCHIVE.md` へ移動済み

---

## 現在の状態

- LP（https://kjk.tadakayo.jp）・CRM管理画面（https://kjk-tadakayo-admin.web.app）とも本番稼働中。**LPは2026-08-10 に動画セクション＋公開設定修正を live 反映済み**。
- リポジトリは GitHub組織 `npo-tadakayo/kjk-tadakayo`。最新 live は `ecda41c`（2026-09-06・レビュー修正14件まで反映）。
- **CRMのメール送信元は `kjk-staff@tadakayo.jp`**（From: `タダカヨ事務局 <kjk-staff@tadakayo.jp>`）。変更はCRMの設定画面「メール送信元アドレス」から可（コード修正・デプロイ不要）。ただし**実在のメールボックスであること**が必須（委任はユーザーとして送る方式のためエイリアス不可）。
- **過入金の充当・返金の記録は本番反映済み**（2026-08-08 の hosting デプロイで main ごと昇格。preview `undo-draft-0730` は役目終了）。
- **請求4件（¥2,643,872）はすべて入金済・未集金 ¥0**。SH-2026-0001 の過入金 **¥93** は**次田さんが返金処理して解消済み**（2026-08-12・充当ではなく返金を選択）。
- **入金まわりの3機能（グループ会社間の過入金充当／返金明細書／領収書への実入金反映）は 2026-08-12 に本番反映済み**。ただし**実データでの実機操作は未実施**（充当は同一請求先に過入金がある状態でないと画面が開かない）。
- Cloud Function `sendPartnerMail`（催促メール）は**本番作成済み**（gcfv2 / asia-northeast1）。
- **経理への請求書発行報告（⑲・2026-08-11）は Functions・ルール・UI・設定すべて本番反映済み＝使える状態**。ただし**実際の送信検証は未実施**（本番送信が田中さんに届くため）。次回まず1件流して確認する。

## 今セッション（㉔・2026-09-01〜06）でやったこと

すべて **本番反映済み**（最終 live は `96734ff` の hosting 昇格）。詳細は各コミットと `docs/CRM改訂のお知らせ_20260902.md`。

1. **伴走支援承諾書のオンライン署名**（`5479c52`）→ 利用規約・プライバシーポリシーと突合して **v1.1**（`6ee0a0f`）。Pマーク提出用の突合文書と v1.1 単体PDFを `00_outbox/` に配置（`84d8415` `a924994`）
2. **サイドバーを箱型に畳める／案件一覧に 地域・都道府県・市町村・担当者**（絞り込み＋並び替え・`cd27d64`）。住所は `admin/js/area.js` が案件・事業所の住所文字列から推定
3. **出荷の修正・削除／品番に「つなぎ方」（USB Type-A / Type-C / Bluetooth）併記**（`30eee69` `6a71c50` `6a8f358` `96734ff`）。請求済・入金済は送付先だけ直せる
4. **資料の事前送付／承諾書URL送付／請求書・領収書のメール送付（PDF添付）**（`08adc72`）。`sendPartnerMail` が添付対応
5. **伴走支援の記録を後から編集・削除**（藤田さん要望・`c8e9f4d`）
6. マニュアル・アプリ内ヘルプ・CRM動画7単元を v1.1 に作り直し → `00_outbox/介護情報基盤_資料一式_20260902/`（旧版は削除済み）
7. 看板（ロールアップバナー 850×2000・説明会用2本）企画と入稿PDF → `06_介護情報基盤事業/看板企画_20260903/`
8. **コードレビュー（/code-review）の指摘14件を全部修正**（2026-09-06・本コミット）。内容と検証結果は `docs/レビュー指摘の修正案_20260903.md` の「適用結果」節
   - 🔴 領収書メールのPDFに編集UIが写る → 印刷と同じ見え方の複製をPDF化（ハーネスで input/select/編集UI 0件を確認）
   - 🔴 承諾書の文書番号が `caseNo`（存在しない項目）→ `caseNumber`
   - 🟠 出荷修正の在庫差分を `runTransaction` 化（開いた後に他人が変えていたら止める）／ロック時は出荷日も固定／添付ファイル名の無害化／ほか低優先9件
   - **領収書メール送付を本番画面から実機テスト済み**（2026-09-06 01:12〜01:14 JST・SH-2026-0004 を kjk-staff@ と自分宛に送信）。届いたPDF（A4 1ページ・335KB）に編集UIが写っていないことを目視確認。テストで付いた `receiptMailedAt/To`・`mailLog` は Firestore REST で削除して元に戻した。**テストメール2通は kjk-staff@tadakayo.jp と yoshinao-tsukuda@tadakayo.jp の受信箱に残っている**（件名「【テスト送信】」「【テスト送信2】」・不要なら削除）
   - **2026-09-06 01:00 JST に本番反映済み**（`ecda41c`）: hosting live（version `e08b00e13835cfec`）／firestore.rules／Functions 3本（sendPartnerMail・reportInvoiceToAccounting・sendSupplierOrder）。承諾書の表示番号は既発行5件を `CST-{案件番号}` に修正（署名済みは #125・#129・#2、未署名 #32・#1。当初「#96」と見込んだのは誤り）


## 次回やること（優先順）

（UTC日付のバグは下記§で修正・実機再テストで解消を確認済み）
-0.5. **問い合わせ・見積もりフォームの住所分割**（都道府県／市町村／住所を別カラム・必須化・`offices` スキーマと既存データの移行）— 次田さん依頼「検討して」の段階。設計案を出してから着手
-0.3. `functions/index.js` webhookMitsumori の重複判定が事業所名を見ていない（前セッションからの持ち越し）
-0.2. 「CRM改訂のお知らせ」（`docs/CRM改訂のお知らせ_20260902.md`）の周知先・Chat投稿の要否を確認
0. **説明動画シリーズの続き** → 正本は `06_介護情報基盤事業/ガイドブック動画_パイプライン/HANDOFF.md`。
   単元1の撮影から再開するか、6単元の台本を先に作るかを決めてから着手
0.1. **蜂須賀さんへの返信**（下書き `06_介護情報基盤事業/伴走支援ガイドブック_HTML/連絡文_蜂須賀さんへ返信_20260809.txt`）。**8/9から17日そのまま**。現地でフィードバックをくれた方に反映済みであることを伝えていない。出すなら冒頭に「お返事が遅くなりました」の一文を足す。`chat_post.py --space kiban` で投稿可
0.5. **CRM操作説明の動画**（担当営業の割り当て・紹介元・統合時の選択の3手順）。スライド方式なら `06_介護情報基盤事業/ガイドブック動画_パイプライン/` を流用できる。**画面写真はダミーデータで撮ること**（事業所名・担当者名が映るため）

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

- **html2canvas（html2pdf）は `@media print` を見ない**。画面の DOM をそのまま渡すと `.rcpt-noprint` や `<input>` が PDF に写る。帳票のメール添付は `printableClone()`（supply-print.js）で複製を整えてから渡す（2026-09-06）
- **プレビューチャンネルでログインするには Firebase Auth の承認済みドメインに追加が必要**（localhost も未登録）。`PATCH identitytoolkit.googleapis.com/admin/v2/projects/kjk-tadakayo/config?updateMask=authorizedDomains`（ヘッダー `x-goog-user-project: kjk-tadakayo`）。既に登録済みのチャンネル名（`sess-edit` 等）を再利用すると手間が省ける
- **Functions デプロイは `NODE_OPTIONS=--max-old-space-size=8192 FUNCTIONS_DISCOVERY_TIMEOUT=180`** を付ければ Drive 上からでも通る（node_modules 読込 58秒・既定10秒で落ちる。2026-09-06 は CLI が Node ヒープ不足で落ちたのでヒープも広げる）。`zsh -ic 'gcp tadakayo && …'` で1回にまとめる。**成否は `gcloud functions describe … --format="value(updateTime)"` で確認**（`| tail` を挟むと exit code 0 に見える）
- **Playwright MCP のブラウザ（user-data-dir `~/Library/Caches/ms-playwright-mcp/`）に CRM のログインセッションが残っている**（2026-09-06・次田芳尚でログイン）。実機テストはまず `browser_navigate` で本番 URL を開いて試す。ログイン画面が出たら Google のポップアップで次田さんがサインインする必要がある（Claude は資格情報を入力しない）
- **AppleScript から Chrome に流す JS は分離ワールド**（ページの `window` が見えない）。ページの値が要るときは inline `<script>` を注入して `document.body.dataset` 経由で受け取る。ログイン済み窓が無いときは Playwright MCP も Google 認証を通せない（資格情報入力は不可）→ **ローカルハーネス＋Firestore エミュレータ**で検証する（2026-09-06 実施。ルールの境界テストは `firebase emulators:start --only firestore --project demo-kjk` に REST で当てる）
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
  - **回避策は 2026-08-13 にスクリプト化してリポジトリに常設した**（`scripts/deploy-hosting.mjs`・Issue #3 クローズ）。まず `node scripts/deploy-hosting.mjs --target lp --dry-run` で配信対象を確認し、`--channel {名前}` でプレビュー → 確認後に `--live`。以下は同スクリプトが内部でやっていることの説明:
  - gcloud のタダカヨ認証が生きていれば、**Hosting REST API で直接デプロイできる**。`gcloud auth print-access-token --account yoshinao-tsukuda@tadakayo.jp` ＋ ヘッダー `x-goog-user-project: kjk-tadakayo`（これが無いと quota project 未設定で403）。versions作成 → populateFiles → gzipしたファイルをhash単位でアップロード → FINALIZE → releases。⚠️ **firebase.json の headers/redirects は REST では形が違う**（`source`→`glob`、`[{key,value}]`→`{k:v}`、`type`→`statusCode`）。スクリプトは `/private/tmp/.../scratchpad/deploy-hosting.mjs`（セッション破棄で消えるので必要なら repo に移す）
- **タダカヨの gcloud ユーザー認証が期限切れ**（2026-08-08 時点）。Firestore REST 直叩きの前に `gcloud auth login`（tadakayo 設定）を通す。ADC は 279 アカウント（y.tsukuda@279279.net）のままなので kjk-tadakayo には使えない

## 再開コマンド

cd ~/Projects/tadakayo/01_システム開発/tadakayo-kiban && claude

## 関連URL・リソース

- LP本番: https://kjk.tadakayo.jp ／ CRM本番: https://kjk-tadakayo-admin.web.app
- GitHub: https://github.com/npo-tadakayo/kjk-tadakayo
- 仕様書: `ENGINEERING_NOTES.md`（正本）／ `MANUAL.md` ／ アプリ内 `/manual` `/engineering`
- アクセス解析: Clarity `wax7x03bg8` ／ GA4 `G-V70326L8MW`（タダカヨ側プロパティ 541485334）
- 旧セッション詳細: `HANDOFF_ARCHIVE.md`
