# タダカヨの介護情報基盤伴走支援 LP / CRM設計 申し送り — 2026-06-05（更新）

> handoff-id: tadakayo
> サービス名（最新）: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）

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
- M-1 / H-3 は専用セッション推奨。
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
