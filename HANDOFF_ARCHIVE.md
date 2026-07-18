# タダカヨの介護情報基盤伴走支援 LP / CRM設計 申し送り — 2026-06-05（更新）

> handoff-id: tadakayo
> サービス名（最新）: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）

---

## 🆕 2026-06-05 セッション⑤（発注機能: 下書き→確定→ABサークルへ発注書PDF添付メール送付）

> 状態: ステップ1＋2を実装・本番反映・push 済み（コミット `1739c29`）。**実機検証（@tadakayoログイン要）が次田さんの最優先**。AB Circle 2026-06-05 回答を反映。

### 今セッションの成果
- **AB Circle 確定情報を取り込み**（memory `reference_abcircle.md`）: 発注先 `h.noda@abcircle.com`＋CC 谷口`n.taniguchi@abcircle.com`/小多`s.oda@abcircle.co.jp`、卸価格(数量帯別)、送料表、JAN、月末締め翌月末払い(NP掛け払い)、納期=署名発注書受領から1週間以内、不良品=info@abcircle.co.jp、最小ロット1台。
- **商品マスタ更新**（Firestore REST直接・MCPは別プロジェクトを見るため使用不可）: 3SKUに JAN・31台価格(wholesale31)を投入。既存の数量帯別価格(wholesale1/2_10/11_30)は価格表と一致済み。
- **発注の3段階化**（supply.js）: 新規=下書き(draft)→編集/削除→確定。希望納期(desiredDate)欄追加。発注単価を数量帯別(unitPriceFor: 1/2-10/11-30/31+)に。
- **確定して送付**: 「確定」→プレビュー(confirmModal: 宛先=設定の仕入先メール/CC・件名・本文=定型文差込・編集可・発注書PDFプレビュー)→送信。発注書PDFを html2pdf(CDN)でブラウザ生成し添付、Gmail(DWD)送信、成功でstatus=sent＋emailedTo/emailedAt記録。
- **設定追加**（settings.html/js）: 仕入先(ABサークル: supplierName/Email/Cc/Contact/住所)＋発注メール定型文(poMailSubject/poMailBody・差込 {{発注番号}}{{品目}}{{金額}}{{希望納期}}{{発行日}}{{担当者}}{{仕入先名}})。確定値を初期表示(未保存でも見える)。発注書の宛名も supplierName 参照に。
- **functions**: buildRawMessage を multipart(添付/CC)対応に拡張＋ `sendSupplierOrder` callable 追加（本番create成功・既存関数に影響なし）。
- **共通化**: 発注書描画を `admin/js/po-doc.js`(renderPOHtml/PO_STYLE/DEFAULT_PO_MAIL_*)に切り出し、supply-print と確定プレビューで再利用。
- 本番: hosting:admin release complete / commit `1739c29`(push済) / preview検証で構文OK・console error 0（認証後UIはセッション切れで未確認）。

### 🙏 次田さんの実機検証（最優先・@tadakayoログイン要）
1. 設定画面で「仕入先」「発注メール定型文」を確認し**一度「保存」**（Firestoreに確定させる。発注機能はフォールバックでも動くが保存推奨）
2. 供給管理→発注: 新規発注→下書き保存→編集→「確定」→プレビュー→送信
   - ⚠️ **「この内容で送信」は実メールがABサークルへ飛ぶ**。最初は**宛先(TO)を自分の@tadakayoに変えて**テスト送信し、PDF添付/レイアウト/数量帯別単価(11台以上で単価減)を確認
3. 発注書PDFの宛名が仕入先名か／入荷登録で在庫加算（既存）

### 次セッションTODO
1. 実機検証のフィードバック反映（発注書PDFレイアウト調整・文面調整など）
2. M-1 Webhook保護 / H-3 関数別SA（専用セッション・`SECURITY_REMEDIATION.md`参照）
3. 設定の未入力（インボイス番号T+13桁/振込先/レターパック差出人）
4. （任意）受注(認定事業所)・出荷にも送料表/数量帯別単価を展開、LP側 `**/*.html` glob修正

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

## 🆕 2026-06-05 セッション③（セキュリティ計画＋M-3クリア＋開発4タスク＋Chat報告）

> 状態: 当セッションのコミット `09db9a3`（security docs）/ `7cb9355`（admin開発）＋本HANDOFF更新を main に push 済み。**本番デプロイは次セッションで一気に実施**。

### 今セッションの成果
- **セキュリティ残件の棚卸し＋実行計画**: `SECURITY_REMEDIATION.md` 末尾に「次セッション実行計画」（M-1/H-3/Gemini移行の手順・認可・ロールバック・前提Console作業）を追記。ライブ read-only で裏取り済（6関数が compute SA 共有＝editor+aiplatform.user / App Check 未実装 / aiAssist=gemini-2.5-flash）。
- **M-3 管理者MFA を充足クリア**: 管理画面ログインは Google SSO 一本（`admin/js/auth.js`・パスワードなし・裏取り済）＝組織の Workspace 2段階認証で2要素を担保。Firebase MFA 実装不要。→ セキュリティ 10件中 **8件完了・残コード作業2件（M-1/H-3）＋付帯Gemini**。
- **開発チームへ Chat 報告**: 対応状況を開発報告用スペース（`DEV_CHAT_WEBHOOK_URL`＝spaces/AAAAJTAWTVo）へ投稿（messageID `UnQZwMQQ69Y`）。
- **開発4タスク完了**（`7cb9355`）:
  1. `.gitignore` 整理（検証スクショ `admin-*.png`/gdoc/議事録 を除外）
  2. `partner.html` モバイル対応（共通 mobilenav.js 横展開・appView 時のみヘッダー表示・タイトル「認定事業所ポータル」。preview 検証済＝loginViewヘッダー非表示／ドロワー開閉。共通 CSS/JS は不変）
  3. COOP 設定（`firebase.json` admin に `Cross-Origin-Opener-Policy: same-origin-allow-popups`・signInWithPopup の window.closed 警告抑制。**本番デプロイ後に有効**）
  4. docs SSOT（`MANUAL.md` 新規＋`ENGINEERING_NOTES.md` に CRM 技術仕様＝FLOW/ARCH/ER/SEQ 4図・コレクション・認証・デプロイを統合。両 html の参照修正）

### 次セッションで「一気に最後まで仕上げる」TODO
1. **本番デプロイ**（rule05: preview channel→認証正常確認→本番昇格）。COOP・partner.html・docs を反映。
   - デプロイ後検証: `curl -sI https://kjk-tadakayo-admin.web.app/ | grep -i cross-origin-opener`（→ same-origin-allow-popups）／ ログインで console の COOP 警告消失／ partner.html 実機ドロワー（要パートナーアカウント）
2. **実機検証チェックリスト**（@tadakayo ログイン: 認証／請求書PDF／設定入力／発注セレクト／M-5 メール verify）
3. **M-1 Webhook保護**（App Check 段階移行）— 前提: 次田さんが Console で reCAPTCHA Enterprise 鍵発行＋App Check 登録 → Phase A 観察→Phase B 強制（`SECURITY_REMEDIATION.md` 実行計画参照）
4. **H-3 関数別SA**（破壊的・番号単位認可要・同上参照）
5. **設定の未入力**（レターパック差出人／発注書 発行元・代表者／インボイス登録番号 T+13桁／振込先）
6. （任意）Gemini 3 移行（2026-10-16期限）／ viewer ロール書込制限／案件テストデータ整理

---

## 現在の状態（2026-06-04 セッション終了時点）

**CRMはほぼ全機能が本番稼働中。** LP（kjk.tadakayo.jp）・見積もり（/mitsumori.html）も稼働中。最新コミット `f5e023d`（main・push済み）。

- 管理画面: **https://kjk-tadakayo-admin.web.app**（Firebase: `kjk-tadakayo` / Blaze + 月¥3,000予算アラート）
- 認定事業所ポータル: **/partner.html**
- 稼働中の機能: 案件管理・カンバン・ダッシュボード・CSV・伴走支援(写真)・報告書PDF・自動フォロー(毎朝9時Chat)・供給管理(在庫/発注/出荷)・**受注→発送→請求→入金フロー**・適格請求書(インボイス)・レターパック宛名(赤600/青430・直貼り)・発注書(ABサンプル準拠+擬似印鑑)・AIアシスタント(Vertex)・Gmail送信(DWD)・モバイルUI・**ロール管理/ログイン登録制**・マニュアル/エンジニアノート(アプリ内)

> ⚠️ **重要・ログイン**: `users` コレクションに登録された @tadakayo.jp ユーザーのみログイン可。現在 admin=次田(yoshinao-tsukuda)・佐藤(hiroshi-sato)、staff=藤田/斎藤/石田/蜂須賀。新規スタッフは管理画面「ユーザー管理」で追加しないとログイン不可。
> ⚠️ 多くの新機能は **@tadakayoログインでの実機通し検証が未**（下記「次セッション」参照）。

---

## 🆕 2026-06-05 セッション②追記（振込先＋M-5監視＋発注モーダル＋H-4実態クリア）

### A. 請求書の振込先フィールド（完了・デプロイ/push済）
- 設定画面に振込先口座5項目（金融機関/支店/口座種別/口座番号/名義）を追加。請求書PDF（`supply-print.js renderInvoice`）が実口座を表示し、未設定なら従来の「別途ご案内します」文言にフォールバック。
- commit `226bced`（feat）/ `97ea077`（docs）。admin hosting 本番反映・curl で `billing*`/`payInner` 配信確認済。
- ⚠️ 実機検証: 設定で実口座を入力 → 請求書PDFで表示確認、は @tadakayo ログインが要るため次田さん（チェックリスト 8・9 項）。

### B. GCPセキュリティ続き（実質7件完了に）
- ✅ **M-5 Cloud Monitoring**: メール通知ch＋「Cloud Run(関数)5xxエラー検知」ポリシー作成（policy `17664915398047705537` / channel `17803807182395282661`・5分で5xxが3件以上→メール）。⚠️ メール確認（verify）リンクが届いたら次田さんが承認（未verifyだと通知が飛ばない）。
- 🟢 **H-4 実態クリア**: 全SA（appspot/gmail-sa/compute）で USER_MANAGED 鍵ゼロを確認（キーレスDWD運用）。追加対応不要。
- 📄 **SECURITY_REMEDIATION.md** 新規（開発チーム向け対応状況レポート・10件の状況/ライブ証跡/残件計画/確認コマンド集）。**実機検証チェックリスト.md** 新規（13セクション）。
- 残: **M-1**（Webhook App Check・段階移行・専用session）/ **H-3**（関数別SA・破壊的IAM）/ **M-3**（管理者MFA）/ 付帯 Gemini 2.5 retire（2026-10-16）→G3移行。

### C. 発注モーダルに認定事業所選択（完了・デプロイ/push済）
- 新規発注（→AB Circle）の送付先に「認定事業所から選ぶ（直送先・任意）」セレクトを追加。選択で送付先に 〒/住所/法人名・事業所名 を自動入力（手入力修正も可）。選択肢は active な partners（`activePartners`）。
- `supply.html`＋`supply.js`（`fillOrderShipTo`/`openOrder`）。commit `055ae42`・admin hosting 本番反映・curl確認済。
- ⚠️ 実機: 発注→新規発注でセレクトに認定事業所が並ぶか／選択で送付先が埋まるか（パートナー管理で住所未登録の事業所は名前のみ）。

### 次セッション/次田さん向け
- 実機検証チェックリスト.md を上から通す（特に 0 認証・8 請求書PDF・9 設定入力）。
- M-5 のメール通知 verify。
- 発注モーダルの認定事業所セレクト動作確認（C）。
- MANUAL.md（docs SSOT）は未着手（手元作業・任意）。
- **残3件（M-1/H-3/Gemini移行）の詳細実行計画**（手順・認可・ロールバック・前提Console作業）を `SECURITY_REMEDIATION.md` 末尾「次セッション実行計画」に追記済み（2026-06-05・ライブ裏取り済）。推奨順 M-1→H-3→Gemini。M-1/H-3 は専用セッション推奨。**M-3（管理者MFA）は Workspace 2段階認証で充足・対応不要**（管理画面は Google SSO 一本＝`admin/js/auth.js`裏取り済／次田さん確認 2026-06-05）。
- 未追跡: `admin-*.png`（6/5検証スクショ10枚）・gdoc・議事録/。コミット要否は判断待ち（不要なら .gitignore 追加）。

---

## 🆕 2026-06-05 セッション追記（実機検証＋印影＋GCPセキュリティ改修）

### A. 発注書の実印影対応（完了・デプロイ済 / commit `505832a`）
- 設定に「印影画像」アップロード欄を追加。アップロード時にブラウザ側で**黒背景→透過＋200px縮小**（alpha=最大ch）し `appConfig/settings.poSealImage`(data URI)へ保存。発注書(supply-print)は画像があれば `<img class=po-seal-img>` で角印描画、無ければ従来の文字印。
- 次田さんの実印影(2.png)を**本番設定に登録済み**（透過プレビュー確認済）。⚠️ 実発注(PO)が0件のため、**実発注書PDFでの角印目視は未**（初回発注時に確認）。

### B. GCPセキュリティ改修（開発チーム指摘 10件中 **5件完了**）
> 指示書プロンプトは「番号単位の明示認可」必須。gcloud は `--account=yoshinao-tsukuda@tadakayo.jp` で kjk-tadakayo 操作可。Functionsソースは本repo `functions/`。
- ✅ **H-1** Firestore Delete Protection 有効化（`DELETE_PROTECTION_ENABLED`）
- ✅ **H-5** Vertex AI Location=asia-northeast1（aiAssist env＋**コード既定値も** global→asia-northeast1 `8568249`。データレジデンシー）
- ✅ **M-4** authorized_domains から localhost 削除（本番5ドメイン維持）
- ✅ **H-2** Firestore PITR 有効化（7日復元・`604800s`）
- ✅ **M-2** CHAT_WEBHOOK_URL を Secret Manager 化（defineSecret・4関数 `2dff953`。平文env廃止・testChatNotify実機OK）
- ⏳ 残り5件（**番号単位認可が必要**）:
  - **M-1**（Webhook保護）: HMACは公開フォームに**不適**（鍵露出）。**Firebase App Checkで再設計**。reCAPTCHA鍵作成＋**段階移行(非強制→観察→強制)必須**＝**専用セッション**で実施（リード喪失防止）。
  - **H-3**（関数別SA・最小権限）/ **H-4**（kjk-gmail-sa キー廃止）= Phase4・高リスクIAM・破壊的。Phase1-3後に慎重に。
  - **M-5**（Cloud Monitoring アラート）/ **M-3**（管理者MFA・FE改修）= Phase5。
  - 付帯: **Gemini 2.5系は 2026-10-16 retire** → Gemini 3 移行計画を別途協議。
- ⚠️ 指示書の参照docs（architecture.html/ARCHITECTURE.md/gcp-inventory.yaml）は**本repoに不在**（別repo？要確認）。今回はライブGCP read-onlyで把握して実施。

### C. 実機検証で見つかった要対応（未処理）
- **設定の未入力**: レターパック差出人 / 発注書(発行元・住所・代表者・発注者氏名・印影文字) / インボイス(事業者名・登録番号T+13桁) が全て空（次田さん入力待ち。※印影画像は登録済）。
- **請求書の「振込先（口座）」フィールドが設定に無い**（請求書PDFにハードコードのプレースホルダの疑い→要調査・UI追加）。
- **ログインCOOP警告**（firebase-auth `window.closed`）。今は動作するがSafari等で要確認。
- 案件20件の多くは **@tadakayo.jp のテスト投入データ**（本番運用前に残す/消す判断）。
- スタッフ4名（蜂須賀/藤田/斎藤/石田）は姓のみ表示＝氏名要調整。

### 次セッションでやること（最優先＝実機検証）
1. **@tadakayo.jp でログインして全画面の通し確認**（特にロール管理・受注→請求→入金・宛名/請求書/発注書PDF・モバイル・カメラ撮影）
2. ユーザー管理で氏名/ロールを正しく調整（藤田/斎藤/石田/蜂須賀の漢字氏名は仮）
3. 設定画面で登録：**適格請求書の登録番号(T+13桁)**／**請求書の振込先**(現プレースホルダ)／差出人(レターパック)／発注書の発注者・印影
4. 残提供待ち：AB Circle回答（JANコード→商品マスタ、卸価格確定）
5. 任意：viewerロールの書込制限の厳密化／partner.htmlのモバイル対応／docs/*.md(SSOT)書き出し

### ✅ 今セッションで完了したこと（2026-06-04 終盤12）— ロール管理・ログイン登録制

| 項目 | 内容 |
|---|---|
| usersコレクション | email=ID / name / role(admin/staff/viewer) / active。既存6名を登録済（次田・佐藤=admin、他=staff）|
| ログイン登録制 | `auth.js login()` で users 未登録/停止はログイン不可。全画面ゲートで `role.js gateRole()` を呼び、未登録は拒否画面。設定・ユーザー管理は **adminOnly** |
| ユーザー管理画面 | `users.html`+`users.js`（管理者のみ）。追加/編集/削除・自己ロックアウト防止（自分の削除/停止/降格に確認）|
| Firestoreルール | `isRegistered()`(=@tadakayo.jp かつ users active) / `isAdmin()` を導入。全データは登録スタッフのみ。users は本人読取・admin管理。partners/partnerOrders/products は従来どおり |
| 共通 | `role.js`（getMyRole/showAccessDenied/gateRole）。全画面ナビに「ユーザー管理」追加 |

> ⚠️ ロックアウト防止のため6名を先に登録してからルール厳格化済み。新スタッフは「ユーザー管理」で追加しないとログインできない。
> 📌 viewer ロールは現状ログイン可（読み取り中心）。各書き込みのrole別細分化は未実装（必要なら次段階）。実機確認: 未登録@tadakayoでログイン→拒否 / 管理者で全画面 / staffで設定・ユーザー管理が拒否されるか。

### ✅ 今セッションで完了したこと（2026-06-04 終盤11）— 日付西暦化＋認定事業所の詳細情報

| 項目 | 内容 |
|---|---|
| 日付表示 | 案件一覧の受信日/最終更新・案件詳細タイムラインを **西暦 YYYY/MM/DD** 表示に統一 |
| 認定事業所 詳細 | partners に 法人名/郵便番号/住所/代表電話/代表メール/**担当者(複数 contacts[])** を追加。パートナー管理を**追加/編集モーダル**化（編集・担当者の追加削除可） |
| 宛名（認定事業所） | パートナー管理に「宛名」ボタン → `supply-print?type=plabel&pid=` で**登録済の住所/事業所名から**レターパック宛名を生成（赤/青・差出人選択も可） |

> ⚠️ 実機確認: パートナー管理→追加/編集（担当者複数）／宛名ボタンで登録住所が反映されるか／案件一覧の日付が西暦表示か。
> 📌 partnerOrders（ポータルからの受注）の送付先は従来どおり受注内容を使用。partners詳細は「認定事業所自身」への宛名・請求の宛先に活用。

### ✅ 今セッションで完了したこと（2026-06-04 終盤10）— モバイルUI＋カメラ撮影＋差出人複数＋レターパック青

| 項目 | 内容 |
|---|---|
| モバイルUI（rule25） | 管理画面はデスクトップ前提で**モバイル未対応だった**（768px以下でサイドバー消失）。`mobilenav.js`（共通・非module）＋crm.cssで**ハンバーガー＋スライドドロワー**を実装。ブレイクポイント1024px。8画面に適用 |
| 写真カメラ撮影 | case-detail 伴走支援タブ：「カメラで撮影」「写真を選択」ボタン。カメラは `capture="environment"` をJSで付与してスマホのカメラ起動。選択枚数表示 |
| 差出人 複数登録 | 設定の差出人を**リスト化(N件)**。追加/削除・旧単一値から移行。`appConfig/settings.senders[]` |
| レターパック赤/青 | 宛名印刷ページで種別（プラス赤520円/ライト青370円）＋差出人を選択→即再描画。実物準拠レイアウト・A4切り取り |

> ⚠️ モバイルドロワー実機確認は @tadakayo ログインが必要なため未。次田さんスマホで確認: ヘッダーのハンバーガー→ドロワー開閉／ナビ／伴走タブのカメラ撮影。
> 📌 partner.html とprint系にはモバイルヘッダー未適用（必要なら追加）。

### ✅ 今セッションで完了したこと（2026-06-04 終盤9）— 受注→発送→請求→入金 業務フロー

業務フローを2系統で統一実装（供給管理）:
- A. 直接支援事業所: 出荷(直接・**定価**) → 請求(事業所宛) → 入金
- B. 認定事業所: ポータル受注 → 受注タブ「出荷へ」(直送・**卸価格**) → 請求(認定事業所宛) → 入金

| 実装 | 内容 |
|---|---|
| 出荷ライフサイクル | `shipments.status`= shipped(発送済)→invoiced(請求済)→paid(入金済)/canceled。状態バッジ＋「請求済にする」「入金記録(金額・日付 prompt)」 |
| 単価出し分け | 直接=`listPrice`(エンドユーザー定価) / 直送=`wholesale2_10`(卸) を出荷itemにスナップショット |
| 請求書 | 両系統で発行可（直接→事業所御中 / 直送→認定事業所御中）。見積書の赤系踏襲・税別→税込 |
| 受注→発送変換 | 受注タブ「出荷へ」で partnerOrder から dropship 出荷を自動生成（在庫引落・partnerOrder.status=shipped・partnerOrderId 紐付け） |
| サマリー | 出荷タブ上部に 未請求(発送済)件数 / 請求済・未入金(税込) / 入金済(税込) |
| 入金記録 | `paymentAmount`/`paidAt` |

> ⚠️ 実機検証は未。次田さん確認: 受注タブ「出荷へ」→在庫減＆出荷生成 / 出荷タブで請求済→入金記録 / 請求書(直接=定価/直送=卸) / サマリー金額。
> 📌 請求書の振込先はプレースホルダー（設定でテンプレ化は今後）。

### ✅ 今セッションで完了したこと（2026-06-04 終盤8）— Webhook設定化・ドキュメント・ファビコン

| 項目 | 内容 |
|---|---|
| Webhook設定化 | Chat Webhook URL・メール送信元を `appConfig/settings`（Firestore）に移行。Functions は `getSettings()`（60秒キャッシュ・.envフォールバック）で参照。**コード変更/再デプロイなしで変更可能に** |
| 設定画面 | `admin/settings.html`+`js/settings.js`: Webhook URL・送信元の編集＋「Chatテスト通知」（`testChatNotify` callable）。@tadakayo限定 |
| エンジニアノート | `admin/engineering.html`（アプリ内表示・rule13）。**Mermaid 4図**（FLOW業務フロー/ARCH構成/ER データモデル/SEQ シーケンス・rule20）＋コレクション一覧・認証/デプロイ。mermaid@11 をCDN動的import |
| マニュアル | `admin/manual.html`（アプリ内・連番カード・FAQ・困ったとき） |
| 共通 | `js/docpage.js`（doc共通：認証ゲート＋ナビ＋Mermaid描画）。全画面サイドバーに「設定/マニュアル/エンジニアノート」追加（rule21 HelpNav） |
| ファビコン | `images/tadakayo_logo.png` を `admin/favicon.png` に配置し、全adminページに `<link rel="icon">`＋apple-touch-icon |

> ⚠️ 実機（@tadakayoログイン）検証は未。次田さん確認: ①設定画面でWebhook/送信元の編集＋テスト通知 ②エンジニアノートのMermaid図が描画されるか ③マニュアル表示 ④各画面のタブにロゴfavicon。
> 📌 docs/ENGINEERING_NOTES.md / docs/MANUAL.md（リポジトリSSOT）は未作成。アプリ内画面を先に作成済。必要なら次回 docs/ にも書き出す。
> 📌 settings変更は最大60秒で反映（Functionキャッシュ）。

### ✅ 今セッションで完了したこと（2026-06-04 終盤7）— Gmail送信 実機検証 + Phase 12 B2Bポータル

**Gmail送信 実機検証 完了** ✅
- 次田さんが `kjk-staff@tadakayo.jp` 作成＋Workspace管理コンソールでDWD登録（client_id `107379651912400439233`/`gmail.send`）完了
- キーレスDWD経由で実送信テスト成功（messageId `19e918c1e67f9716`・kjk-staff→yoshinao-tsukuda宛）。検証用の一時tokenCreatorはrevoke済（残るは compute SA のみ＝正常）
- → CRMの案件詳細AIタブのメール送信は本番稼働可能

**Phase 12: 認定事業所向け B2Bポータル**
| 項目 | 内容 |
|---|---|
| 認証 | Googleログイン＋**許可リスト**（`partners/{email}` に active:true がある人のみ）。@tadakayo以外の社外ユーザー対応 |
| Firestoreルール | `products`=認証済み読取/タダカヨ書込、`partners`=本人読取/タダカヨ管理、`partnerOrders`=本人作成&自分のみ閲覧/タダカヨ全件。他は従来通りタダカヨのみ。compile成功・deploy済 |
| パートナー画面 | `admin/partner.html`+`js/partner.js`: ログイン→許可確認→**発注フォーム**（商品数量+送付先+希望納期+補助金区分）+**自分の発注履歴**。URL https://kjk-tadakayo-admin.web.app/partner.html |
| 職員側 | `supply.html` に「受注（認定事業所）」タブ（partnerOrders一覧+ステータス更新）＋「パートナー管理」タブ（許可リストにメール+事業所名を追加/停止） |
| index | `partnerOrders`(partnerEmail+createdAt) 複合インデックス追加 |

> ⚠️ パートナー画面の実機検証は「許可リスト登録済みの認定事業所Googleアカウント」が必要なため未実施。使い方: 供給管理→パートナー管理 で認定事業所のログインメール＋名称を追加 → そのメールの本人が partner.html にGoogleログイン → 発注。
> 📌 ポータルは現状 admin Hosting 上（/partner.html）。将来 `partner.kjk.tadakayo.jp` 等の独立ドメイン化も可（Cloudflare/ドメイン設定が必要）。セキュリティはFirestoreルールで担保済み。
> 🎉 **これでCRM Phase 1〜12＋Vertex AI＋Gmail送信 すべて実装完了。**

### ✅ 今セッションで完了したこと（2026-06-04 終盤6）— Phase 6 / 9 / 10 / 11

| Phase | 内容 |
|---|---|
| 6 アフターフォロー自動化 | `dailyFollowup`（onSchedule・毎朝9時JST・asia-northeast1）。停滞(7日)・未割当新規・未申請(期限30日以内)・入金待ち14日超 を集計し**Chat通知**。0件なら通知しない。Cloud Scheduler `firebase-schedule-dailyFollowup` ENABLED |
| 9 発注＋商品マスタ | `products`(3SKU・固定ID=sku・stock付き) を投入。`supply.html`/`js/supply.js` の「発注」: 新規発注（数量入力）→ 自動採番 `PO-2026-NNNN`・status=sent。「入荷登録」で在庫加算+status=received。**発注書PDF**(`supply-print.html?type=po`) |
| 10 在庫管理 | supply「在庫・商品」: 3SKUの在庫表示＋手動±調整（`inventoryMovements`ログ）。発注入荷で+、出荷で−自動連動。`products.stock` を increment で更新 |
| 11 出荷・送付状 | supply「出荷」: 送付先（法人/事業所/住所/担当）＋数量 → 自動採番 `SH-2026-NNNN`・在庫から自動引落（在庫不足はブロック）。**送付状PDF**(`supply-print.html?type=ship`) |
| ナビ | 全画面サイドバーに「供給管理」追加（`ti-package`） |

> ⚠️ 実機（@tadakayoログイン）検証は未。次田さん確認: 供給管理→在庫±調整／新規発注→発注書PDF／入荷登録で在庫増／新規出荷→送付状PDF＆在庫減。
> 📌 商品マスタ初期値はCSV準拠（卸価格は税別・JANコードは要確認のまま）。AB Circle回答後に単価/JAN更新を。
> 📌 発注/出荷の採番は `_counters/purchaseOrders`・`_counters/shipments`（共に PO/SH-2026-NNNN）。

### ✅ 今セッションで完了したこと（2026-06-04 終盤5）— Phase 5 レポートPDF

| 項目 | 内容 |
|---|---|
| 出力方式 | `window.print()`（見積書と同方式・依存なし）。専用ページ `admin/report.html`+`js/report.js` |
| 内容 | 支援報告書（A4・ブランド準拠）: 事業所情報／案件概要（ステータス・補助金区分・想定額・CR構成）／補助金申請状況／伴走支援の記録（sessions）／対応履歴（activities）／発行日 |
| 動線 | 案件詳細ヘッダーに「報告書PDF」ボタン → `/report.html?id=...` を別タブで開く → 印刷/PDF保存 |
| 印刷CSS | toolbar非表示・A4余白・改ページ制御（@media print） |

> ⚠️ 実描画・印刷は @tadakayo ログイン必須のため未検証。次田さん確認: 案件詳細→報告書PDF→内容表示＆「印刷/PDF保存」でPDF化できるか。

### ✅ 今セッションで完了したこと（2026-06-04 終盤4）— Gmail実送信（キーレスDWD）

| 項目 | 内容 |
|---|---|
| 方式 | DWD（ドメイン全体委任）。**キーレス**＝SA鍵を発行/保存せず `iamcredentials.signJwt` で都度JWT署名 → jwt-bearerでアクセストークン取得（Pマーク配慮） |
| 基盤 | `gmail.googleapis.com`/`iamcredentials.googleapis.com` 有効化。専用SA `kjk-gmail-sa@kjk-tadakayo.iam.gserviceaccount.com` 作成。compute SA に `kjk-gmail-sa` への `serviceAccountTokenCreator` 付与 |
| 送信元 | `kjk-staff@tadakayo.jp`（コード default。env `GMAIL_SENDER` で上書き可）。差出人表示「タダカヨ事務局」 |
| Function | `sendCaseEmail`(onCall・asia-northeast1)。@tadakayo認証ガード。to/subject/body/caseId受領→Gmail送信→タイムラインに`gmail_sent`記録 |
| UI | case-detail AIタブに「メール送信」コンポーザー（宛先/件名/本文/送信）。AI返信下書き→「送信欄へ転記」で件名/本文を自動流し込み（宛先は問い合わせメール自動プリフィル） |
| スコープ | `gmail.send` のみ（送信専用） |

> ⛔ **次田さんの残作業（これが完了するまで送信は動かない）**:
>   1. **`kjk-staff@tadakayo.jp` を正規ユーザーアカウントとして作成**（グループ不可・メールボックス必須。Workspace for Nonprofits なら無償枠）
>   2. **Workspace管理コンソールでDWD登録**: https://admin.google.com/ac/owl/domainwidedelegation → 新しく追加 → クライアントID `107379651912400439233` / スコープ `https://www.googleapis.com/auth/gmail.send` → 承認
> 完了後、案件詳細→AIアシスタント→メール送信 でテスト（最初は自分宛てに送るのが安全）。失敗時は Functions ログ `sendCaseEmail` を確認。
> 📌 送信元アドレスを変える場合: `functions/.env` に `GMAIL_SENDER=...` を追記して再デプロイ。

### ✅ 今セッションで完了したこと（2026-06-04 終盤3）— Vertex AI（Gemini）AIアシスタント

| 項目 | 内容 |
|---|---|
| 方式 | **Vertex AI + ADC（SA認証・鍵なし）**。裸APIキーは不使用（rule03準拠・キー失効リスク回避） |
| 基盤 | `aiplatform.googleapis.com` 有効化、Functions実行SA（`677262660109-compute@…`）に `roles/aiplatform.user` 付与 |
| SDK | `functions` に `@google/genai`（^1.52.0）追加。`new GoogleGenAI({vertexai:true, project, location})` |
| location | **`global`**（asia-northeast1 はGeminiモデル可用性が不安定なため）。model `gemini-2.5-flash`・thinkingBudget:0 |
| Function | `aiAssist`（onCall・asia-northeast1）。`request.auth.token.email` が `@tadakayo.jp` でなければ拒否。task=reply_draft/summary_classify/session_report/assistant をプロンプト分岐 |
| UI | case-detail に「AIアシスタント」タブ。返信下書き/要約・分類/伴走報告文 の3ボタン＋自由質問。結果表示＋コピー。コンテキスト（案件情報＋対応履歴＋伴走メモ）を client から payload で渡す |
| 検証 | Vertex REST直叩きで `gemini-2.5-flash`/global/HTTP200/「テスト成功」応答を確認。aiAssist deploy済・JS構文OK・モジュール読込エラーなし |

> ⚠️ callable+クライアント連携の実動作は @tadakayo ログイン必須のため未検証。次田さん確認: 案件詳細→AIアシスタント→各ボタンで生成されるか。
> 💰 課金: Vertex従量（flash・低volumeで月数十円想定）。Blaze＋予算アラート¥3,000でカバー。
> 📌 これで Phase 3（メール送信）の「文面生成」部分は完成。残るは Gmail API での実送信（OAuth設定が前提）。

### ✅ 今セッションで完了したこと（2026-06-04 終盤2）— CRM Phase 7/8/4 並行実装

| Phase | 内容 |
|---|---|
| 8 CSV出力 | `cases.html`/`cases.js`：案件一覧に「CSV出力」ボタン。現在の絞り込み結果をUTF-8 BOM付きCSVで出力（Excel対応） |
| 7 ダッシュボード | `dashboard.html`+`js/dashboard.js` 新規。サマリー（総数/受注/申請/完了/失注/想定補助額合計/CR台数）・パイプラインファネル・ステータス別/流入元別バー。リアルタイム集計 |
| 4 伴走支援＋写真 | `case-detail`：新タブ「伴走支援」。実施日＋メモ＋写真（複数）を `sessions` コレクション＋Storage(`sessions/{id}/photos/`)に保存。タイムラインにも訪問記録として自動追加。写真サムネ表示（クリックで原寸） |
| ナビ | 全4画面サイドバーに「ダッシュボード/案件一覧/カンバン」統一 |
| インデックス | `activities`(caseId+occurredAt)・`sessions`(caseId+createdAt) 複合インデックス追加・READY確認。※activities indexは案件詳細タイムラインにも必要だった（今回同時に解消） |

> ⚠️ 実機（@tadakayoログイン）検証は未。次田さん確認項目: ①ダッシュボードの集計数が妥当 ②案件一覧CSV出力 ③案件詳細→伴走支援タブで写真アップロード→サムネ表示＆タイムライン反映。
> ⛔ 未着手: Phase 3 Gmail送信（Gmail API OAuth設定が前提）/ Phase 5 レポートPDF / Phase 6 アフターフォロー自動化 / Phase 9-12 発注・在庫・出荷・B2Bポータル。
> 📌 Phase 3 の前提=Gmail API OAuthクライアント作成（Console作業）。`Gmail_MCP_セットアップ手順.md` 参照。

### ✅ 今セッションで完了したこと（2026-06-04 終盤）— CRM Phase 2（カンバン＋全体アラート）

| 項目 | 内容 |
|---|---|
| カンバンボード | `admin/kanban.html` + `admin/js/kanban.js` 新規。13ステータスを列表示（パイプライン順、失注は末尾）。リアルタイム購読 |
| ドラッグ&ドロップ | カードを列間D&Dで status 変更（`updateDoc` + activities に「ステータス変更 旧→新（カンバンで変更）」を記録）。カードクリックで案件詳細へ |
| 全体アラート | 画面上部に3チップ: ①未割当の新規案件 ②未申請（期限対応必要・期限30日以内のとき） ③停滞案件（7日以上未更新）。停滞カードは左赤ライン+「停滞Nd」表示 |
| ナビ統一 | cases.html / case-detail.html / kanban.html のサイドバーに「案件一覧 / カンバン」リンク追加（`ti-layout-kanban`） |
| CSS | `admin/css/crm.css` に kanban / alert スタイル追記（フォント12px以上厳守） |
| デプロイ | hosting:admin デプロイ済。JS構文エラー0・auth ゲート正常を確認 |

> ⚠️ カンバンのD&D・アラート集計の実動作は **@tadakayo.jp ログインが必要なため Claude では未検証**。次田さんが https://kjk-tadakayo-admin.web.app → カンバン で、20件がステータス別に並ぶ／カードをドラッグして列移動でステータスが変わる／詳細のタイムラインに記録される、を確認してほしい（rule05 認証系は実機検証セット）。
> 📌 D&Dはデスクトップ前提（モバイルは未対応。カード→詳細→ステータス選択で代替可）。

### ✅ 今セッションで完了したこと（2026-06-04 後半）— Webhook配線切替 + 過去データ取り込み

| 項目 | 内容 |
|---|---|
| Webhook配線切替 | `mitsumori.html`/`index.html` の送信先を Chat直送 → **Cloud Functions**（`webhookMitsumori`/`webhookLpInquiry`）に変更。LP問い合わせ・見積もり成約が自動でFirestoreに案件登録されるように。Formspreeメール送信は継続。`no-cors`撤去（Functionは`cors:true`） |
| バグ修正 | Functionの重複チェッククエリに複合インデックスが必要で全Webhookが500になる状態だった。`firestore.indexes.json`（`contactEmail+source+receivedAt`）を作成・デプロイ（READY確認）。手元curlテストで事前検出 |
| 過去データ取り込み | デスクトップ「情報基盤問い合わせ」の21スクショ（見積もり成約/問い合わせ/名刺6枚）を読み取り、重複統合して **20事業所**をFirestoreに直接登録（Chat通知なし・受信日時は実日付JST→UTC変換）。`_counters/cases`=20、次の実案件は#21から |
| 名刺OCR | 名刺画像はGeminiで二重OCRして精度向上（rule07） |
| 要確認(後でCRM修正) | #1のさかえ(メール) / #8みそら(担当者名・メール) / #10清和園(事業所名・担当者名) / #12四季折々(法人/事業所名・担当者名) / 名刺#15ことり・#16希望館・#17ソアレ(メール) |

> ⚠️ Chat通知なしのため Webhook Function は使わず Firestore REST API で直接書き込んだ（`x-goog-user-project: kjk-tadakayo` ヘッダ必須）。個人情報を含む一時ファイルは作業後に削除済（Pマーク）。
> 📌 システム開発グループ Chat Webhook（開発報告用）: スペース `AAAAJTAWTVo`（key/token は通常の Chat Webhook URL）。

### ✅ 今セッションで完了したこと（2026-06-04）— クラウド環境セットアップ全完了

> 背景: 従来「Console操作はClaude代行不可（gcloudが279アカ）」だったが、本セッションで **gcloud に tadakayo アカウントを追加**（config `tadakayo`）し、ほぼ全工程をCLIで完遂した。Console操作が必要だったのは Auth Google プロバイダ有効化の1つだけ（OAuth自動生成APIが2026/3廃止のため）。

| 項目 | 内容 | 手段 |
|---|---|---|
| gcloud tadakayo化 | `gcloud config configurations create tadakayo` + `gcloud auth login yoshinao-tsukuda@tadakayo.jp` | CLI |
| API有効化 | firestore / firebase / identitytoolkit / storage / cloudfunctions / cloudbuild / artifactregistry / run / eventarc / pubsub / firebasestorage / billingbudgets / cloudbilling | gcloud |
| Firestore | `(default)` DB作成（本番・asia-northeast1）+ ルールデプロイ（@tadakayo.jp制限） | firebase CLI |
| Blaze | 次田さんがConsoleで請求先紐付け（請求先 `01F524-AB83CE-2DD2E2`） | Console（次田さん） |
| 予算アラート | 月¥3,000・50/90/100%通知（budget id `1affaa42-...`） | gcloud billing |
| Storage | defaultBucket作成 `kjk-tadakayo.firebasestorage.app`（asia-northeast1）+ ルールデプロイ | firebasestorage API + CLI |
| Functions | webhookLpInquiry / webhookMitsumori（v2・asia-northeast1）デプロイ | firebase CLI |
| Artifactクリーンアップ | gcf-artifacts（asia-northeast1）に 7日削除/直近3保持ポリシー | gcloud artifacts |
| Hosting | LP + admin 両サイト release complete（admin初回はcleanupエラーで未確定→再デプロイで確定） | firebase CLI |
| Auth Google | Console でGoogleプロバイダ有効化（clientId `677262660109-l68qjb2...`自動生成） | Console（次田さん） |
| Auth許可ドメイン | admin.web.app / admin.firebaseapp.com / admin.kjk.tadakayo.jp を追加（unauthorized-domain防止） | identitytoolkit API |
| 実機検証 | Playwrightで admin ログインページ表示→Googleログインフロー起動（hd=tadakayo.jp制限ヒント動作・次田芳尚アカウント認識）まで確認 | Playwright |

> ⚠️ admin Hosting の初回デプロイは末尾の Artifactクリーンアップ未設定エラーでコマンドが中断し、hosting release が未確定で404になった。`firebase functions:artifacts:setpolicy` は us-central1 を見るので **gcloud で asia-northeast1 の gcf-artifacts にポリシー適用** → `firebase deploy --only hosting` 再実行で確定した。
> ⚠️ Firebase Storage の defaultBucket は `POST firebasestorage.googleapis.com/v1beta/projects/{p}/defaultBucket` の **bodyに`{"location":"asia-northeast1"}`**（クエリ不可）で作成できる。

---

## 旧・現在の状態（2026-06-02時点・参考）

**2026-06-02: LP本番動作確認PASS＋補助金完全リスト35コード逐語化＋favicon追加＋見積書税表記修正を本番デプロイ済み（最新コミット `ca0f47f`・GitHub push済・実体確認済）。**
**CRM Phase 1 コード実装完了（コミット 307a01b）。→ 2026-06-04 デプロイ完了済。**

> 🎯 **CRM Phase 1 デプロイ = あと「次田さんのConsole 4トグル」だけ**（2026-06-02 Phase2 CLI準備完了）。
> ✅ Claude実行済み（CLI）: ウェブアプリ作成（App ID `1:677262660109:web:79645398db17dab417bb44`）／`firebase-config.js`実値化（commit `b8fe1c6`）／admin Hostingサイト `kjk-tadakayo-admin` 作成／`functions npm install`／`functions/.env`（CHAT_WEBHOOK_URL=①タダサポ＋）作成（gitignore済）。
> ⛔ 次田さんがConsoleで未実施（Claude代行不可・gcloudは279アカで権限なし）:
>   1. Firestore有効化（本番・asia-northeast1）2. Auth→Google有効化 3. Storage有効化 4. Blazeプラン
>   → 完了後Claudeが「プリフライト確認→`bash deploy.sh`→実機検証」を一気に実行。2026-06-02時点でFirestore APIは403（未有効）。
>
> ⏸ 2026-06-03: Console設定（特にBlaze=有料プラン切替）は **理事長への承認待ちで一旦保留**。非エンジニア向け説明文書 `クラウド利用料のご説明_理事長向け.md` を作成済み（費用は実質0円〜月数百円の見込み・予算アラート/アクセス制限で安全管理、と説明）。承認が下りたら次田さんがConsole 4トグル→Claudeがデプロイ。
>
> ⚠️ git 注意: push は PAT URL 直叩きのため `origin/main` 追跡参照が更新されず「ahead N」と誤表示される。実体は `git ls-remote <PAT-url> refs/heads/main` で裏取りすること（今回 `ca0f47f` で一致確認済）。

### ✅ 今セッションで完了したこと（2026-06-02）

| 項目 | 内容 |
|---|---|
| LP本番動作確認 | Playwrightで観察検証。申請期間・メーカー価格(¥17,380/¥7,150)・補助金区分(64k/55k/42k)・見積もり計算5パターン・Clarity/GA4 すべてPASS |
| 補助金35コード逐語化 | LP表＋見積もり折りたたみを公式35コードに（区分① 18/② 12/③ 5）。短期入所療養介護の3種別・各短期利用バリアントを明示（旧:28行集約）|
| favicon追加 | index/mitsumori に `images/tadakayo_logo.png` を icon/apple-touch-icon 設定 → 404解消 |
| 見積E2Eテスト | 同意アンロックで成約Webhook発火を確認。`mode:'no-cors'` 送信のため status は opaque(0)=送信成立。✅ Chatスペース AAQAkcdopcA への【動作確認テスト】通知の着弾を次田さんが確認（Webhook正常稼働の確証）|
| 見積書 税表記の修正 | ✅ 明細テーブル見出しを「単価/金額（税別）」→「（税込）」に修正。定数・計算・注記（行1420「すべて税込で表示」）と整合させた。消費税の別途加算処理は無く、見出しのラベル誤りのみだった |
| デプロイ | `deploy.sh --lp-only`（hosting:lp のみ・CRM admin非該当・Node20）を2回（35コード+favicon / 税表記修正）|
| コミット/push | `2dbe775`・`f4bbd85`・税表記修正分を tsuku-29 PAT で push 済 |

### ✅ 今セッションで完了したこと（2026-05-27 追記）

| ファイル | 内容 |
|---|---|
| `admin/index.html` | ログイン画面（Google / @tadakayo.jp 制限） |
| `admin/cases.html` | 案件一覧（検索・フィルタ・新規登録モーダル） |
| `admin/case-detail.html` | 案件詳細（タイムライン・書類チェック・申請情報タブ） |
| `admin/js/*.js` | Firebase Auth + Firestore リアルタイム購読 |
| `functions/index.js` | Webhook受信（LP問い合わせ・見積もり成約 → Firestore保存 + Chat通知） |
| `firestore.rules` / `storage.rules` | @tadakayo.jp 制限のセキュリティルール |
| `firebase.json` | multi-site hosting 構成（LP + 管理画面） |
| `CRM_SETUP_GUIDE.md` | デプロイ前の手順書 |

### ⛔ デプロイ前に次田さんの作業が必要

`CRM_SETUP_GUIDE.md` を参照。手順は以下の順番で:

1. Firebase Console → Firestore Database を有効化（本番モード・asia-northeast1）
2. Firebase Console → Authentication → Google プロバイダを有効化
3. Firebase Console → Storage を有効化
4. Firebase Console → ウェブアプリを追加 → `admin/js/firebase-config.js` の `REPLACE_WITH_ACTUAL_*` を差し替え
5. `firebase hosting:sites:create kjk-tadakayo-admin --project kjk-tadakayo`（ターミナルで1回だけ）
6. `cd functions && npm install && cd ..`（ターミナルで1回だけ）
7. `bash deploy.sh`（全体デプロイ）

### ⛔ 次セッション開始前に次田さんの作業が必要

| ステップ | 内容 | 場所 |
|---|---|---|
| 1 | Cloudflareアカウント作成 | [cloudflare.com](https://cloudflare.com) |
| 2 | `tadakayo.jp` をCloudflareに追加 | Cloudflare Dashboard |
| 3 | お名前.comのネームサーバーをCloudflareのものに変更 | お名前.com管理画面 |
| 4 | Zero Trust → Access → Applications で `admin.kjk.tadakayo.jp` を追加・@tadakayo.jp のみ許可 | Cloudflare Zero Trust |

> ⚠️ ネームサーバー変更は反映に最大48時間かかる場合あり。早めに実施推奨。
> 📌 **DNS管理先: お名前.com**（確認済み・2026-05-27）
> 📌 **Cloudflare Accessは無料（最大50ユーザー）**

LP・見積もりツール最新状態：
- **令和8年度 申請期間: 2026年5月7日〜2027年3月12日（予定）** ← 2026-05-27更新
- 助成対象: 令和8年4月1日以降に実施した導入に係る経費
- USB価格 ¥6,500 改定済
- カードリーダー価格は「メーカー公式販売店価格」表記に変更（CIR415A ¥17,380 / CIR315A ¥7,150）
- 補助金区分（居宅介護支援は¥64,000区分）を公式要項に基づき正しい配置に修正
- 補助金対象サービスの完全リスト（35種類）をすべての媒体に反映済
- 「分類に注意するサービス」（居宅介護支援/居宅療養管理指導/地域密着型通所介護）をハイライト

---

## 今セッションでやったこと（2026-05-27 全体まとめ）

| 領域 | 内容 | 状態 |
|---|---|---|
| 技術仕様書 | `TECHNICAL_SPEC.md` 新規作成（セキュリティ・Pマーク・コスト・委託先一覧） | ✅ |
| 工数試算書 | `工数試算書.md` 新規作成（フェーズ別・外部委託費用・Claude Code内製比較） | ✅ |
| PDF出力 | デスクトップに `タダカヨ_システム技術仕様・工数試算書_2026-05-27.pdf` 生成・社内共有済 | ✅ |
| 申請期間修正 | 令和7年度→令和8年度（5/7〜令和9年3/12）に更新・公式ポータルで裏付け確認済 | ✅ |
| 新要綱PDF取得 | r8_jyoseikin_youkou_01.pdf をプロジェクトフォルダに保存 | ✅ |
| LP修正 | 「本日」→「令和8年度 助成金申請受付中」に変更 | ✅ |
| 料金MD更新 | 申請期間を令和8年度版に明記 | ✅ |
| デプロイ | Firebase Hosting + git push | ✅ |
| CRM状況確認 | admin/フォルダなし・CRM_DESIGN.mdのみ・未実装 | 確認 |
| 認定事業所向け発注仕様書 | 商品マスタ・発注CSV/JSON仕様・フロー図を作成（MD+PDF+CSVテンプレート） | ✅ |
| 商品マスタ訂正 | USB品番がCIR315A-02（Type-A）とCIR315A-04（Type-C）の2種類と判明・修正 | ✅ |
| AB Circle 確認依頼文 | JANコード確認項目を追加・野田様へメール送信済（2026-05-27） | ✅ |
| CRM設計更新 | Cloudflare Access + Firebase Auth 二重防御構成に設計変更・Phase 0を追加 | ✅ |

## 今セッションでやったこと（2026-05-22）

| 領域 | 内容 | コミット |
|---|---|---|
| 補助金要項確認 | 国保中央会の交付要綱別添を取得 → 全35サービスの正式分類を確定 | (調査のみ) |
| 価格改定 | USBカードリーダー ¥5,000 → ¥6,500（税込）に変更 | 01929f8 |
| 区分修正 | 居宅介護支援を「その他」→「訪問・通所系」へ移動 | 01929f8 |
| 完全リスト反映 | LP補助金表/見積もりツール/料金表MD両方に35サービス全列挙 | 8b7b347 |
| PDF再生成 | 一般・認定事業所向け両方をmarkedベースで再生成 | 8b7b347 |

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

## 次セッションでやること（優先順）

### A. CRM設計の合意事項を確定（次田さん作業）
- メールテンプレート文面（7種類）
- 差出人名（タダカヨ事務局 / 個人 / 切替式）
- 写真保存期間（無期限 / 1年 / 完了後N日）
- 失注理由カテゴリ
- スタッフ初期メンバー
- 「タダカヨ→AB Circle」発注書のNO.連番開始番号（既存NO.43の次から?）
- 認定事業所→タダカヨ受注の寄付バック計算方法（件数 or 売上%）
- イーレシート停止のタイミング判断

### B. CRM Phase 1 着手前のFirebase設定（次田さん作業）
- Firebase Console で Firestore を有効化
- Firebase Auth で Google プロバイダ有効化
- ドメイン制限：@tadakayo.jp 承認
- Cloud Storage を有効化
- Gmail API OAuth クライアント作成（Phase 3着手前）
- Pマーク規程との照合確認

### C. CRM Phase 1〜12 段階的実装（Claudeセッション）
- Phase 1: MVP（受信＋案件一覧＋ステータス＋書類チェック＋申請追跡）— 1日
- Phase 2: カンバン＋全体アラート — 半日
- Phase 3: Gmail API送信＋テンプレート — 1日
- Phase 4: 伴走支援セッション＋写真 — 1日
- Phase 5: レポートPDF生成 — 半日
- Phase 6: アフターフォロー自動化 — 半日
- Phase 7: 補助金情報ダッシュボード＋集計 — 半日
- Phase 8: CSV出力 — 半日
- **Phase 9: 発注書作成＋マスタ管理（追加）— 1日**
- **Phase 10: 在庫管理（追加）— 半日**
- **Phase 11: 出荷・送付状作成（追加）— 半日**
- **Phase 12: 認定事業所チャネル（B2Bポータル）（追加）— 2日**

合計: 9〜10日

---

## 次セッション即着手タスク

### 🆕 次田さんがセッション間に対応中

1. **Gmail MCP セットアップ**
   - 手順書：`Gmail_MCP_セットアップ手順.md` を参照
   - OAuth設定 → MCP導入 → Claude Code 再起動
   - 完了後、Claude が Gmail下書き作成・受信メール読み取り可能になる

2. **AB Circle 様（野田様）への確認メール送信**
   - 依頼文ドラフト：`AB_Circle_確認事項_依頼文.md`
   - 確認内容：仕入条件（数量帯別単価・地域別送料）＋発注フロー（窓口・納期・支払・不良品対応など）
   - Gmail MCP セットアップ後は Claude で下書き作成・送信可

### 🆕 次セッションでClaude着手

3. AB Circle 様の回答を待って、CRM `shippingRates` / `products.unitPriceTiers` マスタの初期データを設計
4. 料金シミュレーションの「タダカヨ仕入」を実態（¥7,050）に合わせて更新するか判断
5. CRM Phase 1 着手の Firebase 設定（次田さん作業後）

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

---

<!-- ▼ 2026-07-18 アーカイブ移動分（旧 HANDOFF.md 全文・セッション⑤〜⑬） -->

# タダカヨの介護情報基盤伴走支援 LP / CRM設計 申し送り — 2026-06-13（更新）

> handoff-id: tadakayo
> サービス名（最新）: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）

---

## 🆕 2026-06-13 セッション⑬（CRM UIリブランド：タダカヨ赤＋多田佳代ちゃん 第1弾・本番反映/push済）

> 状態: **CRM管理画面（hosting:admin live）に本番反映・コミット `c46fc78`・origin push 済**。次田さん実機（@tadakayo）でログイン後UI確認済の流れで「本番へ」承認→昇格。

### やったこと（CRM `admin/` のみ・LPは未着手）
- **色トークンを #E03030 系へ統一**（[admin/css/crm.css](admin/css/crm.css)）: `--color-primary` `#E33535`→**`#E03030`** / `--color-primary-dark` `#c02828`→**`#b82626`** / `--color-primary-soft` ピンク`#FFE4EC`→赤淡色**`#fdecec`** / `--app-color` も #E03030。CSSトークンなので全管理画面に一括反映。
- **多田佳代ちゃんを控えめに3か所**（業務可読性維持）:
  - ログイン（[admin/index.html](admin/index.html)）= 指さしポーズ＋「タダカヨ」ロゴ＋「多田佳代ちゃんがお待ちしています」。`.login-logo` は淡赤の角丸パネル＋`object-fit:contain`（※初回は円形`overflow:hidden`で手が切れ→パネル化で修正済）。
  - サイドバー上部ロゴ = `.sidebar-brand::before` の背景画像でCSS注入＝**13ページのHTMLを触らず全画面反映**。
  - 案件一覧の空状態（[admin/cases.html](admin/cases.html)）= ノートPC操作の多田佳代ちゃん（`.empty-state-chara`・幅140px）。
- **素材を `admin/images/` に配置**（admin hosting はリポジトリ外Drive素材を配信不可）: `tadakayo_logo.png`(=images/tadakayo_logo_remove.png) / `chara_welcome.png`(=images/chara_11.png) / `chara_empty.png`(=images/chara_2.png)。元の `images/chara_*.png` は多田佳代ちゃん各ポーズ（LP流用）。
- **a11y（/design:accessibility-review 実施）**: アクティブなナビ `#E03030`/`#fdecec`=3.97:1（AA NG）→ `--color-primary-dark`(#b82626)=**5.49:1** に修正（[admin/css/crm.css:116](admin/css/crm.css)）。他（装飾画像 alt=""・ブランドロゴ alt・focus-visible・タップ44/48px・primaryボタン白文字6.28:1・リンク4.54:1）は合格。

### 検証
- rule05 二段階: プレビューチャネル `redbrand-0613`（https://kjk-tadakayo-admin--redbrand-0613-0feuo47g.web.app ・2026-06-27まで）→ Playwright実描画（ログイン全身表示・サイドバーロゴ・空状態・nav-active色）→ 本番curl（#E03030/nav-active=primary-dark/画像3枚200/参照あり）→ live昇格。
- **本番URL**: https://kjk-tadakayo-admin.web.app

### 次にやること（このリブランドの続き・任意）
1. **LP（kjk.tadakayo.jp / index.html）のリブランド**: 未着手。LPも primary `#E33535`→`#E03030` へ／キャラは既に多用（chara_*）なので色合わせ中心。hosting:lp。
2. **CRMへのキャラ追加（任意）**: トースト「保存しました」にOKポーズ（chara_8 = images/chara_8.png 相当）、ダッシュボード歓迎など。やり過ぎ注意。
3. キャラ素材の出どころ（リポジトリ外）: ケアプー `…/セミナー資料/共有して使う資料/ケアプー`（`img_chara_main.svg`等）／多田佳代ちゃん `…/タダカヨ`。使う物は `admin/images/`（or LP用 `images/`）へコピーして配信。

### push 手順メモ（重要・再発する）
- origin=`tsuku-29/kjk-tadakayo` だが git のhttps認証は `ytsukuda4470` で403。**`gh auth switch --user tsuku-29` → `gh auth setup-git` → `git push` → `gh auth switch --user ytsukuda4470`（元に戻す）** で成功。tsuku-29/ytsukuda4470 とも gh keyring 済。

---

## 🆕 2026-06-12 セッション⑫（案件の削除/統合/対象外・LPアクセス解析新設・卸価格新版反映）

> 状態: **3件すべて本番反映済**。コミット `e5bed9e`(CRM整理機能/解析ページ) / `80457ad`(価格) / `4ee5027`(解析OAuth+LP GA4差替) ＝ **3コミット未push**（origin=`tsuku-29/kjk-tadakayo`・現Git認証が `ytsukuda4470` のため403。tsuku-29 のPATで要push）。当日対応を**介護情報基盤スペース**（`AAQAkcdopcA`・次田から）へ投稿済。

### ① 案件の削除・重複統合・対象外化（hosting:admin 本番反映済）
- `cases.js/html`・`case-detail.js/html`・`constants.js`・`dashboard.js`・`kanban.js`。「対象外」＝ソフトアーカイブ（`archived`/`archivedReason`：test/duplicate/spam/not_adopted/other）。一覧は既定で非表示（「対象外も表示」チェック）。dashboard/kanban 集計からも除外。
- 重複候補：メール/電話/事業所名で自動検出（union-find）→ 一覧バナー＋詳細画面で「この案件に統合」（記録/セッションを付替・連絡先補完・統合元を対象外(duplicate)化・差分はタイムラインに保存）。
- 完全削除＝**管理者のみ**（クライアントgate）。⚠️ Firestoreルールは catch-all で登録スタッフ削除可のまま＝サーバ側admin限定にするには rules 再構成が別途必要（未対応）。
- テスト案件#26の削除はこの機能で次田さんが実施想定。

### ② LPアクセス解析ページ新設＋GA4/Search Console 日次収集（本番反映済・実データ稼働）
- 新規 `admin/analytics.html` + `admin/js/analytics.js`（KPI・PV推移SVG・人気ページ・検索クエリ・流入・直リンク・今すぐ更新）。サイドバー導線（dashboard/cases）。
- Functions 新規 `functions/analytics.js`：`collectAnalytics`（毎朝6:30 JST）/`collectAnalyticsNow`（onCall）。`index.js` で再export。
- **GA4はタダカヨ側に新プロパティを作成し差替**（旧 `G-0NZY6PM3FG` は279でもタダカヨでもない別アカウント）→ 新 **`G-V70326L8MW` / プロパティID `541485334`**。LP `index.html` の測定ID差替＋ hosting:lp 再デプロイ済。
- **認証方式＝ユーザーOAuthトークン**（GA4 UI/gcloud が SA を受け付けない/制限スコープ取得不可のため）。次田さん(プロパティ管理者)の refresh_token を **Secret Manager `ANALYTICS_OAUTH_TOKEN`**（JSON: refresh_token/client_id/client_secret・`analytics.readonly`+`webmasters.readonly`）に保管。関数は `defineSecret`＋`secrets:[...]`（SAアクセスは deploy 時に自動付与）。取得スクリプト `functions/ga-oauth.cjs`（loopback OAuth・再取得用）。
- 設定 `appConfig/analytics = { enabled:true, ga4PropertyId:"541485334", scSiteUrl:"https://kjk.tadakayo.jp/" }`。Search Console は `https://kjk.tadakayo.jp/`（siteOwner・検証済）を自動連携。
- 実行確認：scheduler 手動トリガで `analyticsSummary/latest` 書込（28日：**SEO クリック29/表示204/CTR14.2%/掲載順位3.0**・GA4は新規で0）。GA4 Data API/SC とも 200 を実測。
- SA `fn-analytics-sa@kjk-tadakayo.iam.gserviceaccount.com`（datastore.user）＋ API `analyticsdata`/`searchconsole`/`analyticsadmin` 有効化済。

### ③ カードリーダー卸価格（本番反映済）※当初パススルー化→2026-06-13 非パススルーへ訂正
- ⚠️ 経緯：当初279経由依頼で「卸＝仕入と同額（パススルー）」に設定したが、**これは既存設計（前セッションで確立：認定事業所卸=partnerPricing・数量帯別・卸益+¥480/¥510）を壊す誤り**だった。次田さん指摘で訂正。
- **確定（2026-06-13・コミット 3627fee）＝非パススルー**：卸はAB Circle仕入＋一定卸益の数量帯別テーブル。
  - `appConfig/settings.partnerPricing`（卸・実値）= BT `[8000,8000,7530,7530]`／USB-A `[4000,4000,3510,3460]`／USB-C `[4000,4000,3670,3610]`（税別）
  - `products.wholesale`（=AB Circle仕入原価・発注単価の基準）は据え置き：BT `7650/7520/7050/7050` 他 → 卸益 概ね BT¥480/USB¥510
  - `pricing.js` PRODUCTS 既定値も上記卸へ・`partner-doc.js` 例示も非パススルー表記・hosting:admin デプロイ済
  - 正本 `カードリーダー価格表・送料規定.md §2` を非パススルーに書き換え（仕入原価を内部参考併記）。`functions/update-prices.cjs` は旧パススルー版＝再実行禁止の注記
- エンド見積(mitsumori.html)＝補助金上限ぴったり方式（補助対象は自己負担¥0／補助枚数超過分は補助対象外で別自己負担）＝設計どおり（変更不要）。送料(SHIPPING_FEES/レターパック¥600/ゆうパック表)も正本一致。

### ④ 同セッション 追加対応（すべて本番反映・push済）
- **重複候補に「重複ではない」**：誤検知（別事業所がメール/電話/事業所名一致）を一覧モーダルのボタンで解除。`notDuplicates` にペア記録→重複判定/詳細候補から除外（`constants.js` pairKey・`cases.js`・`case-detail.js`／コミット 0e79752）。
- **アクセス解析ナビを全画面に統一**：HTML5枚＋JS NAV3（settings/users/docpage）に「アクセス解析」追加（コミット 9d934fc）。
- **見積ツール mitsumori.html にGA4+Clarity追加**：成約ページが未計測だった→ index と同じ `G-V70326L8MW`/`wax7x03bg8`（同 9d934fc・hosting:lp）。
- **carepoo（別アプリ tadakayo-carepoo）事業所フィルタを「選択時即絞り込み」へ**：`OfficeFilterForm.tsx`新規・Cloud Run二段階デプロイ済（repo tsuku-29/carepoo-kiroku・コミット 3461ab0）。
- 卸価格は ③ のとおり**非パススルーへ訂正**（当初パススルー化は誤り）。

### 重要な方針（今後）
- **今後タダカヨ作業で279アカウントを使わない**（次田さん指示・2026-06-12）。価格反映時に一時付与した `y.tsukuda@279279.net` の datastore.user は削除済。ローカルADCは `gcloud auth application-default login` でタダカヨに切替済。
- ⚠️ firebase MCP は別プロジェクト接続（kjk-tadakayo の products/appConfig が空で返る）＝MCPで書かない。Firestore直操作は ADC(タダカヨ)＋スクリプトで。

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

### 次にやること（優先順・2026-06-07 終了時点）
1. **両ガイドブックをGoogleスライドに取り込んで体裁の最終確認**（崩れがあれば修正）。場所＝Drive `開発/ケアプランデータ連携支援/ガイドブック/*.pptx`・`開発/介護情報基盤伴走支援/ガイドブック/*.pptx`。ローカルLibreOffice復旧済みで `build-pptx.cjs` から再生成＆画像QA可能。
2. **次田さんの @tadakayo 実機確認**: (a) 案件詳細の新タブ（事前/当日/アフター・ケアプラン連携）で入力→「保存しました」→再読込で保持 (b) 当日タブ→ケアプラン連携 証憑写真のアップ (c) 書類チェック④「管理メニュー画面コピー」表示 (d) M-1観察モード後もLP/見積もりフォームから案件が入るか
3. **E2E 残（@tadakayoログイン）**: ⏳ `sendSupplierOrder`（発注書PDF添付・宛先は自分宛に差し替えテスト）／直送発注→出荷下書き。※`sendCaseEmail` は 06-07 実機OK（案件#19→279宛着信確認）＝メール認証経路は実証済。
4. （任意）介護情報基盤HTMLにもスクショ反映／CRM事前確認タブに「サービス種別・事業所番号」項目追加／開発からのM-1再強制トリガー監視。

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
