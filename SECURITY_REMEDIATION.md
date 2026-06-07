# GCPセキュリティ改修 対応状況レポート（kjk-tadakayo）

> 対象プロジェクト: `kjk-tadakayo`（Firebase / Cloud Run Functions v2 / asia-northeast1）
> 起点: 開発チームからのセキュリティ指摘 10件（高 H / 中 M）
> 最終更新: 2026-06-05
> 操作アカウント: `yoshinao-tsukuda@tadakayo.jp`（gcloud config `tadakayo`）

---

## サマリー

10件中 **8件が対応完了**（うち H-4 は調査の結果リスクが存在せず実態クリア、M-5 は 2026-06-05 実装完了、M-3 は管理画面が Google SSO 一本のため Workspace 2段階認証で充足）。**2026-06-06 に M-1・H-3 まで完了し、指摘10件すべて対応済み**。H-3 は **2026-06-07 に開発（システム開発担当）が GCP 実機で完全クローズを確認**（appspot editor・旧 compute→kjk-gmail-sa tokenCreator いずれも消滅／全7関数が fn-*-sa 配下で ACTIVE）。M-1 は **2026-06-07 に開発判断で観察フェーズへ移行**（App Check の本対応＝強制は保留・`APPCHECK_ENFORCE=false`／代替＝Cloud Monitoring 異常トラフィックアラート＋データ層保護[PITR/Delete Protection]）。付帯の Gemini 2.5 retire（2026-10-16）のみ10月期限で残（現行モデルは正常動作）。

| # | 重大度 | 項目 | 状態 | 反映方法 |
|---|---|---|---|---|
| H-1 | 高 | Firestore Delete Protection | ✅ 完了 | DB設定 |
| H-2 | 高 | Firestore PITR（7日復元） | ✅ 完了 | DB設定 |
| H-5 | 高 | Vertex AI location=asia-northeast1 | ✅ 完了 | コード`8568249`＋env |
| M-2 | 中 | Chat Webhook URL を Secret Manager 化 | ✅ 完了 | コード`2dff953` |
| M-4 | 中 | authorized_domains から localhost 削除 | ✅ 完了 | Auth設定 |
| H-4 | 高 | kjk-gmail-sa の鍵廃止 | 🟢 実態クリア | 鍵ゼロを確認 |
| M-5 | 中 | Cloud Monitoring アラート | ✅ 完了 | gcloud |
| H-3 | 高 | 関数別SA・最小権限 | ✅ 完全クローズ（2026-06-07・appspot editor＋compute→gmail tokenCreator も剥奪・**開発がGCP実機で確認**） | IAM＋再デプロイ |
| M-1 | 中 | Webhook 保護（App Check） | ✅ 対応（2026-06-07・**観察フェーズ**／開発判断・`APPCHECK_ENFORCE=false`／代替=Monitoringアラート） | App Check（観察）＋Monitoring |
| M-3 | 中 | 管理者MFA | ✅ 充足 | Workspace 2段階認証（管理画面は Google SSO 一本） |
| 付帯 | — | Gemini 2.5 retire（2026-10-16） | 🟡 計画 | Gemini 3 移行 |

---

## 完了6件の証跡

### H-1 / H-2 Firestore Delete Protection・PITR
ライブ確認（read-only）:
```bash
gcloud firestore databases describe --database="(default)" --project=kjk-tadakayo \
  --account=yoshinao-tsukuda@tadakayo.jp \
  --format="value(deleteProtectionState,pointInTimeRecoveryEnablement,locationId)"
# => DELETE_PROTECTION_ENABLED  POINT_IN_TIME_RECOVERY_ENABLED  asia-northeast1
```
- Delete Protection 有効（誤削除防止）
- PITR 有効（7日 = 604800s の任意時点復元）

### H-5 Vertex AI データレジデンシー
- `functions/index.js`: `VERTEX_LOCATION = process.env.VERTEX_AI_LOCATION || "asia-northeast1"`（既定値を global→asia-northeast1 に変更・コミット `8568249`）
- 個人情報を含むAI処理を国内リージョンで実行。`global` はデータレジデンシー非対応のため不使用。

### M-2 Chat Webhook URL の Secret Manager 化
- `functions/index.js`: `const CHAT_WEBHOOK_URL = defineSecret("CHAT_WEBHOOK_URL")`。4関数（webhookLpInquiry / webhookMitsumori / testChatNotify / dailyFollowup）が `secrets:[CHAT_WEBHOOK_URL]` で参照（コミット `2dff953`）。
- 平文 env を廃止。`testChatNotify` 実機OK。

### M-4 authorized_domains から localhost 削除
- 本番5ドメインのみ維持（admin.web.app / admin.firebaseapp.com / admin.kjk.tadakayo.jp 等）。localhost を削除済み。

### H-4 kjk-gmail-sa の鍵廃止 → 実態クリア（重要）
調査の結果、**流出リスクのあるユーザー管理鍵（ダウンロード可能鍵）は全SAに1つも存在しない**ことを確認:
```bash
for SA in kjk-tadakayo@appspot.gserviceaccount.com \
          kjk-gmail-sa@kjk-tadakayo.iam.gserviceaccount.com \
          677262660109-compute@developer.gserviceaccount.com; do
  gcloud iam service-accounts keys list --iam-account=$SA \
    --project=kjk-tadakayo --account=yoshinao-tsukuda@tadakayo.jp --managed-by=user
done
# => すべて空（USER_MANAGED 鍵ゼロ）
```
- kjk-gmail-sa にあるのは Google 自動管理の SYSTEM_MANAGED 鍵のみ（DL不可・自動ローテーション・流出リスクなし・削除不可）。
- Gmail送信はキーレスDWD（`iamcredentials.signJwt` → jwt-bearer）で実装され、SA鍵を発行・保存していない。
- **結論: 追加対応は不要。** 今後もユーザー管理鍵を発行しない運用を継続する。

---

## 残件の対応計画

### ✅ M-5 Cloud Monitoring アラート（2026-06-05 完了）
**作成済みリソース**:
- 通知チャンネル(メール): `projects/kjk-tadakayo/notificationChannels/17803807182395282661`（yoshinao-tsukuda@tadakayo.jp）
- アラートポリシー: `projects/kjk-tadakayo/alertPolicies/17664915398047705537`「Cloud Run(関数) 5xxエラー検知」（5分で5xxが3件以上 → メール通知・ENABLED）

> [!WARN]
> メール通知チャンネルは初回に確認メールが届く場合があります。届いたら本文リンクで verify してください（未verifyだと通知が飛びません）。

**当初の現状（参考）/ 再現手順**:
- 当初: アラートポリシー 0件・通知チャンネル 0件（予算アラート¥3,000のみ別途設定済み）
- 再現手順:
1. 通知チャンネルを作成（既存の Chat Webhook を再利用 or メール）
```bash
# 例: メール通知チャンネル
gcloud beta monitoring channels create \
  --display-name="タダカヨ運用アラート" --type=email \
  --channel-labels=email_address=yoshinao-tsukuda@tadakayo.jp \
  --project=kjk-tadakayo --account=yoshinao-tsukuda@tadakayo.jp
```
2. アラートポリシー（Cloud Functions エラー / 実行失敗）を作成
   - 指標: `cloudfunctions.googleapis.com/function/execution_count`（status=error）の急増
   - 5xx率・実行回数異常（DoS兆候）
   - しきい値・通知先を上記チャンネルに紐付け

> [!TIP]
> 通知先は M-2 で Secret 化済みの Chat Webhook を Google Chat チャンネルとして登録すれば、既存の運用Chatにアラートを集約できる。

### 🟠 H-3 関数別SA・最小権限（本丸・破壊的）
**現状（ライブ確認済み）**: 6関数すべてが既定の `677262660109-compute@developer.gserviceaccount.com` を共有。このSAは **`roles/editor`（プロジェクトほぼ全権）＋ `roles/aiplatform.user`** を保持。1関数の侵害で全権限が露出する構造。

**理想構成（関数ごとに専用SA・最小権限）**:
| 関数 | 必要権限 |
|---|---|
| webhookLpInquiry / webhookMitsumori | Firestore 書込のみ（datastore.user） |
| aiAssist | aiplatform.user のみ |
| sendCaseEmail | 自SAへの iam.serviceAccountTokenCreator（signJwt）＋ Firestore |
| dailyFollowup / testChatNotify | Firestore 読取＋Secret 参照 |

**リスク**: IAM変更＋全関数の再デプロイを伴い、権限不足だと関数が起動失敗 → CRM全停止。**`roles/editor` の剥奪は最後**。Preview的にステージングSAで検証してから本番適用。専用セッションで慎重に。

### 🟠 M-1 Webhook 保護（App Check・段階移行）
**現状**: `webhookLpInquiry` / `webhookMitsumori` は `cors:true` の認証なし公開HTTPエンドポイント。誰でも偽案件をPOST可能（重複チェックは同一メール5分以内のみ）。

**方針**: HMACは公開LPフォームだと鍵がクライアントに露出するため不適 → **Firebase App Check（reCAPTCHA Enterprise / v3）**。
- 必須: reCAPTCHAサイトキー作成 → LP（index.html / mitsumori.html）にApp Checkトークン付与 → Functions側で `req` のApp Checkトークン検証
- **段階移行（非強制→観察→強制）が必須**。いきなり強制するとトークン未付与のLPフォームが全件弾かれ、問い合わせ・見積もりのリードを喪失する。
- 観察モードでメトリクスを見てから強制に切替。**専用セッション推奨**。

### ✅ M-3 管理者MFA（Workspace 2段階認証で充足・2026-06-05）
- 管理画面ログインは Google プロバイダ（@tadakayo.jp SSO）一本（`admin/js/auth.js`・`signInWithPopup`＋`hd:tadakayo.jp`のみ・パスワードログインなし・裏取り済）。認証は Google 側で完結するため、組織の2段階認証がそのまま管理画面ログインの2要素を担保する。
- 次田さん（組織管理者）確認: タダカヨ Workspace は2段階認証（2要素認証）を運用済み（2026-06-05）。→ **Firebase 側の MFA 実装は不要**。
- 補足（証跡化・任意）: admin.google.com → セキュリティ → 2段階認証プロセスで「適用（強制）・例外なし」を一度確認しておくと監査証跡として万全。

### 🟡 付帯 Gemini 2.5 retire（2026-10-16）
- `aiAssist` が `gemini-2.5-flash` を使用。2026-10-16 に retire 予定。
- 10月までに Gemini 3 系（例: `gemini-3-flash`）へ移行。SDK（`@google/genai` / Vertex モード）は据え置きで model 名差し替え＋出力検証。

---

## 推奨実施順

1. ~~**M-5**~~ ✅ 完了（2026-06-05・監視の目を確保）
2. ~~**M-3**~~ ✅ 充足（Workspace 2段階認証・2026-06-05・アプリ改修不要）
3. **M-1**（リード保護のため段階移行で着実に・専用セッション）
4. **H-3**（破壊的・ステージング検証後に本番・専用セッション）
5. **付帯 Gemini移行**（10月期限・別途協議）

---

## 確認コマンド早見表（開発チーム再現用）

```bash
GCLOUD=~/Projects/google-cloud-sdk/bin/gcloud
ACCT=yoshinao-tsukuda@tadakayo.jp; PROJECT=kjk-tadakayo

# Firestore 保護（H-1/H-2）
$GCLOUD firestore databases describe --database="(default)" --project=$PROJECT --account=$ACCT \
  --format="value(deleteProtectionState,pointInTimeRecoveryEnablement)"
# SA一覧（H-3/H-4）
$GCLOUD iam service-accounts list --project=$PROJECT --account=$ACCT
# 関数別実行SA（H-3）
$GCLOUD functions list --project=$PROJECT --account=$ACCT --v2 \
  --format="table(name.basename(),serviceConfig.serviceAccountEmail.basename())"
# compute SA の保有ロール（H-3 過剰権限）
$GCLOUD projects get-iam-policy $PROJECT --account=$ACCT --flatten="bindings[].members" \
  --filter="bindings.members:677262660109-compute@developer.gserviceaccount.com" \
  --format="value(bindings.role)"
# ユーザー管理鍵の有無（H-4）
$GCLOUD iam service-accounts keys list \
  --iam-account=kjk-gmail-sa@$PROJECT.iam.gserviceaccount.com \
  --project=$PROJECT --account=$ACCT --managed-by=user
# 監視アラート/チャンネル（M-5）
$GCLOUD alpha monitoring policies list --project=$PROJECT --account=$ACCT
$GCLOUD alpha monitoring channels list --project=$PROJECT --account=$ACCT
```

---

## 次セッション実行計画（残4件・実行手順）

> ライブ裏取り（2026-06-05・read-only）で本文の現状記述と完全一致を確認:
> 6関数すべて `677262660109-compute` SA を共有 / 同SA = `roles/editor` + `roles/aiplatform.user` / `functions/index.js` に App Check 検証コードなし / `aiAssist` model = `gemini-2.5-flash`（index.js:422）/ `sendCaseEmail` は `kjk-gmail-sa` を `signJwt` で impersonate（index.js:436,449）。

### 推奨順序・所要・必要な認可

| 順 | 項目 | 破壊性 | 実作業目安 | 着手の前提 |
|---|---|---|---|---|
| 1 | M-1 Webhook保護（App Check 段階移行） | 低（段階移行で回避） | 0.5日＋観察数日 | 次田さんConsole（reCAPTCHA鍵・App Check登録） |
| 2 | H-3 関数別SA（最小権限） | 高（editor剥奪・全関数再デプロイ） | 0.5〜1日 | 番号単位の明示認可・gcloud `tadakayo` |
| 3 | 付帯 Gemini 3 移行 | 低 | 0.5日 | 2026-10-16期限・猶予あり |
| — | ~~M-3 管理者MFA~~ | — | 充足 | **Workspace 2段階認証で充足・対応不要**（2026-06-05・下記） |

---

### 1. M-1 Webhook保護（App Check・段階移行）

> 🟢 **現状（2026-06-07）: 開発判断で観察フェーズに確定（強制は保留）**。
> 開発（システム開発担当）が「攻撃インセンティブが低い（介護B2B）＋ PITR/Delete Protection によるデータ層保護が十分に厚い」ことを踏まえ、**App Check の本対応（強制）は保留し観察フェーズへ移行**する判断。代替措置として **Cloud Monitoring に異常トラフィックアラートを設置**（発火条件の詳細＝メトリクス/しきい値/通知先は開発に確認中・回答後に追記）。
> - 対応: `functions/.env` に `APPCHECK_ENFORCE=false` を追記し webhook 2本（`webhookLpInquiry`/`webhookMitsumori`）のみ名前指定で本番再デプロイ（2026-06-07）。`gcloud functions describe` で両関数の env `APPCHECK_ENFORCE=false` を確認。トークンなし POST が 401 ではなく観察モードで通過することを確認（=正規LPフォームのリード喪失リスクなし）。
> - **観察モードはリクエストを処理まで通すため、env 確認以外の挙動 curl は空案件を生むので避ける**（検証は `describe` の env 確認に留める）。
> - 強制（fail-secure）へ戻す場合: `functions/.env` の `APPCHECK_ENFORCE=false` を削除 or `true` にして webhook 2本を再デプロイ。
>
> ---
> 以下は経緯の記録（2026-06-06 に一度 Phase B 強制まで実施 → 2026-06-07 に上記判断で観察へ戻した）。
>
> ◯ **Phase B（強制）を一度実施（2026-06-06）**: コード既定を fail-secure 強制（`APPCHECK_ENFORCE !== "false"`）にし2本を本番再デプロイ。トークンなし curl=401／本番ブラウザの正規トークン=200 を実証（テスト案件削除）。→ **2026-06-07 に観察へ戻した（上記）**。
>
> ✅ **Phase A（観察モード）実装・本番反映・検証まで完了（2026-06-05 セッション⑥）**
> - reCAPTCHA Enterprise サイトキー発行（表示名 `kjk-tadakayo-lp` / ドメイン `kjk.tadakayo.jp` / スコアベース・チェックボックスなし）。サイトキー = `6LfHTQ4tAAAAAJ4uIXrIvuCXCyyinUz0FPzhvNNp`（公開キー・ページ埋込）。
> - Firebase App Check に Web アプリ `kjk-crm-admin`（App ID `1:677262660109:web:79645398db17dab417bb44`）を **reCAPTCHA Enterprise** プロバイダ＋上記サイトキーで登録済み（TTL 1時間）。**API タブの各サービス Enforce は未設定（=他機能に影響なし）**。
> - 前提 API `recaptchaenterprise` / `firebaseappcheck` を有効化済み。
> - コード: `index.html` / `mitsumori.html` に App Check（compat SDK + ReCaptchaEnterpriseProvider）初期化＋Webhook fetch に `X-Firebase-AppCheck` ヘッダ付与（`getAppCheckToken()`・取得失敗時 null）。`functions/index.js` に `appCheckGate()` を追加し `webhookLpInquiry`/`webhookMitsumori` 冒頭で検証。`APPCHECK_ENFORCE`（既定 false=観察）。
> - デプロイ: functions 2本のみ更新（他5関数は未変更）/ LP は preview channel → 本番昇格（hosting:lp）。
> - **検証**: 本番 `kjk.tadakayo.jp` の実ブラウザで `getAppCheckToken()` が 954文字の正規 App Check JWT を返却・console error 0。functions は GET で 405（稼働確認・案件未作成）。両LP（`/`・`/mitsumori`）HTTP 200・コード搭載確認。
> - ✅ **Phase B（強制）完了（2026-06-06・上記）**。以下は当初計画の記録: 数日 observe ログ（`[AppCheck][...] observe` の `verified`/`missing-token` 比率）を確認し、正規フォームのトークン付与率が十分高ければ functions に `APPCHECK_ENFORCE=true`（`--set-env-vars` or functions/.env）を設定して2本を再デプロイ。手元 curl（トークンなし）が 401／正規フォームが 200・Firestore `cases` 登録、で確認。ロールバックは `APPCHECK_ENFORCE=false` で再デプロイ。

**技術判断**:
- `webhookLpInquiry` / `webhookMitsumori` は `onRequest`（HTTP）。callable と違い App Check の自動強制が効かない → Functions 側で `X-Firebase-AppCheck` ヘッダを `admin.appCheck().verifyToken()` で**手動検証**する。
- 公開LPフォームのため HMAC は鍵がクライアント露出して不可 → **reCAPTCHA Enterprise（スコアベース）**。

**前提（次田さん Console 作業・着手前に必要）**:
- [ ] Firebase Console → App Check → Web アプリ（App ID `1:677262660109:web:79645398db17dab417bb44`）を登録
- [ ] reCAPTCHA Enterprise サイトキー発行（対象ドメイン: kjk.tadakayo.jp）
- [ ] `recaptchaenterprise.googleapis.com` 有効化（gcloudでClaude代行可）

**実行（段階移行）**:
- Phase A 観察（弾かない）
  1. `index.html` / `mitsumori.html` に App Check SDK 初期化（reCAPTCHA Enterprise provider）。Webhook送信の fetch に App Check トークンを `X-Firebase-AppCheck` ヘッダで付与
  2. Functions: `verifyToken` を呼ぶが、失敗しても処理続行し `console.warn` のみ（弾かない）。環境フラグ `APPCHECK_ENFORCE=false`
  3. デプロイ → 数日メトリクス観察（正規フォームのトークン付与率・失敗率）
- Phase B 強制（弾く）
  4. 失敗率が十分低いと確認 → `APPCHECK_ENFORCE=true` で検証失敗時に 401 を返すよう切替・再デプロイ
  5. 検証: 手元 curl（トークンなし）→ 401 / ブラウザ正規フォーム → 200・Firestore `cases` に登録

**ロールバック**: `APPCHECK_ENFORCE=false` で即再デプロイ（弾かない状態へ戻す）

> [!WARN]
> いきなり強制すると問い合わせ・見積もりフォームが全件弾かれ**リード喪失**。必ず Phase A（観察）を経て、正規フォームのトークン付与を確認してから強制へ切替える。

---

### 2. H-3 関数別SA・最小権限【破壊的・editor剥奪は最後】

> ✅ **完了（2026-06-06）: SA移行＋editor剥奪まで実施。** compute SA は `roles/editor`＋`roles/aiplatform.user` を剥奪し、ビルド用 `roles/cloudbuild.builds.builder`（gen2ビルドが compute SA を使うため）のみに縮小。**editor無しでテストデプロイ成功＝ビルド能力維持を確認**。全7関数は最小権限の専用SAで稼働。ロールバックは compute SA に editor を再付与（無停止）。以下は移行の記録。
> - 4つの専用SAを作成し最小権限を付与：`fn-webhook-sa`(datastore.user＋CHAT secretAccessor) / `fn-batch-sa`(同) / `fn-ai-sa`(aiplatform.user のみ) / `fn-mail-sa`(datastore.user＋kjk-gmail-sa への serviceAccountTokenCreator)。全IAMバインド読み取り確認済み。
> - 全7関数の定義に `serviceAccount` を明記（コード化＝再デプロイで維持）して再デプロイ済み。実行SA切替を `gcloud functions describe` で確認：webhook2本→fn-webhook-sa / testChatNotify・dailyFollowup→fn-batch-sa / aiAssist→fn-ai-sa / sendCaseEmail・sendSupplierOrder→fn-mail-sa。
> - **検証済**: `webhookLpInquiry`(fn-webhook-sa) を本番疎通テストし HTTP200・`observe: verified`・Firestore書込・Chat通知・secret読取が全て機能（テスト案件は削除）。fn-batch-sa は fn-webhook-sa と同一ロールのため等価。
> - **compute SA(`677262660109-compute`) の `roles/editor`＋`roles/aiplatform.user` は安全網として保持中**（まだ剥奪していない）。
> - ✅ **2026-06-06 実施済み**（builds.builder付与→editor/aiplatform.user剥奪→テストデプロイでビルド成功を確認）。当初の残手順は以下（記録・任意の追加確認）:
>   1. 次田さんが管理画面(@tadakayoログイン)で **aiAssist(AI生成) / sendCaseEmail(メール送信) / sendSupplierOrder(発注書送付) / testChatNotify(設定のテスト通知)** を実行し成功を確認。dailyFollowup は毎朝9時に自動実行（または Scheduler force-run）。
>   2. 1〜2日 M-5 アラート(5xx)が増えないか監視。
>   3. 問題なければ **compute SA から editor と aiplatform.user を剥奪**（最終・不可逆。**着手前に最終確認を取る**）:
>      ```bash
>      GCLOUD=~/Projects/google-cloud-sdk/bin/gcloud; P=kjk-tadakayo
>      CSA=677262660109-compute@developer.gserviceaccount.com
>      $GCLOUD projects remove-iam-policy-binding $P --member="serviceAccount:$CSA" --role="roles/editor" --account=yoshinao-tsukuda@tadakayo.jp
>      $GCLOUD projects remove-iam-policy-binding $P --member="serviceAccount:$CSA" --role="roles/aiplatform.user" --account=yoshinao-tsukuda@tadakayo.jp
>      ```
>      剥奪後に全関数を再疎通確認。
> - **ロールバック**（ある関数が新SAで壊れた場合）: 該当関数の `serviceAccount` 行をコードから外して compute SA で再デプロイ／または不足ロールを新SAへ追加付与。editor 剥奪前なら無停止で戻せる。

**設計（関数 → 専用SA → 最小ロール）**:

| 新SA | 担当関数 | 付与ロール |
|---|---|---|
| `fn-webhook-sa` | webhookLpInquiry / webhookMitsumori | `roles/datastore.user` + `CHAT_WEBHOOK_URL` の `secretmanager.secretAccessor` |
| `fn-ai-sa` | aiAssist | `roles/aiplatform.user`（必要なら `datastore.user`） |
| `fn-mail-sa` | sendCaseEmail | `kjk-gmail-sa` への `iam.serviceAccountTokenCreator` + `roles/datastore.user` |
| `fn-batch-sa` | dailyFollowup / testChatNotify | `roles/datastore.user` + `CHAT_WEBHOOK_URL` の `secretmanager.secretAccessor` |

> [!INFO]
> `sendCaseEmail` は `kjk-gmail-sa` を `signJwt` で impersonate するキーレスDWD構成（index.js:436,449）。現状は compute SA が `kjk-gmail-sa` への tokenCreator を持つ。新SA化では **`fn-mail-sa` に同 tokenCreator を付け替える**だけでよい。DWD client_id（`107379651912400439233`）は `kjk-gmail-sa` 側なので Workspace 再登録は不要。

**実行順序（安全策・editor は最後まで残す）**:
1. 新SA 4つ作成・上表の最小ロールを付与（この時点では compute SA の editor はそのまま）
2. 各関数を新SAで再デプロイ（gen2: `gcloud run services update <fn> --service-account=<sa>` または Functions の `serviceAccount` 指定）
3. 全関数の動作確認:
   - webhook 2本: curl で 200・Firestore `cases` 登録
   - aiAssist: 管理画面から生成（要 @tadakayoログイン）
   - sendCaseEmail: 自分宛てテスト送信成功
   - dailyFollowup: 手動trigger（Scheduler force run）でChat通知
   - testChatNotify: 設定画面からテスト通知
4. 1〜2日 M-5アラート（5xx）が増えないか監視
5. **最後に** compute SA から `roles/editor` を剥奪。`roles/aiplatform.user` も fn-ai-sa 移行済なら剥奪
6. 再度全関数を疎通確認

**ロールバック**: 各関数を compute SA に戻して再デプロイ／必要なら editor を再付与（剥奪前なら無停止で戻せる）

> [!DANGER]
> 権限不足のままだと関数が起動失敗し CRM 全停止（webhook受信・AI・メール・自動フォロー）。Step5（editor剥奪）は Step3-4 で新SA稼働を確実に確認してから。**番号単位の明示認可（「H-3を実施」）を取って着手**すること。

---

### M-3 管理者MFA【Workspace 2段階認証で充足・対応不要】

**結論（2026-06-05）**: 管理画面ログインは Google プロバイダ（@tadakayo.jp SSO）一本で、パスワードログインは存在しない（`admin/js/auth.js`・裏取り済）。認証は Google 側で完結するため、組織の2段階認証がそのまま管理画面ログインの2要素を担保する。次田さん（組織管理者）確認により**タダカヨ Workspace は2段階認証を運用済み** → **Firebase 側の MFA 実装は不要、M-3 はクリア**。

> [!TIP]
> 監査証跡として、admin.google.com → セキュリティ → 2段階認証プロセスで「適用（強制）・例外なし」を一度スクショ確認しておくと万全（任意）。

---

### 3. 付帯 Gemini 2.5 retire（2026-10-16）

- `aiAssist` の `model: "gemini-2.5-flash"`（index.js:422）が 2026-10-16 retire。SDK（`@google/genai`・Vertexモード）と location（asia-northeast1）は据え置きで **model名差し替え**が中心。
- 実行:
  1. asia-northeast1 で利用可能な後継 flash 系モデル名を Vertex リリースノートで確認
  2. model 名差し替え＋`thinkingConfig` 等 config の互換確認
  3. aiAssist の4タスク（reply_draft / summary_classify / session_report / assistant）で出力品質を回帰確認
- 猶予4ヶ月。M-1 / H-3 の後で可。retire 前月（2026-09）までに完了を目安。

---

## 🔎 下調べ結果（2026-06-05 セッション⑤・read-only ライブ確認）

次セッションで M-1 / H-3 に着手する前提を最新化（read-only gcloud で裏取り）:

### H-3 対象が **7関数** に（`sendSupplierOrder` 追加）
本セッションで発注メール送付の `sendSupplierOrder` を追加。これも `677262660109-compute` SA を共有するため H-3 の対象。
- 確認: 全7関数（`aiAssist` / `dailyFollowup` / `sendCaseEmail` / `sendSupplierOrder` / `testChatNotify` / `webhookLpInquiry` / `webhookMitsumori`）が compute SA を共有。
- compute SA のロール = `roles/editor` + `roles/aiplatform.user`（過剰権限・計画通り）。
- **H-3 設計の更新**: `fn-mail-sa` の担当を **`sendCaseEmail` ＋ `sendSupplierOrder`** に（両者とも `kjk-gmail-sa` を `signJwt` で impersonate するキーレスDWDのメール送信関数。付与ロールは同じ＝`kjk-gmail-sa` への `iam.serviceAccountTokenCreator` + `roles/datastore.user`）。他3SA（fn-webhook-sa / fn-ai-sa / fn-batch-sa）は変更なし。

### M-1 前提 API は **未有効**（着手時に有効化）
- `recaptchaenterprise.googleapis.com` / `firebaseappcheck.googleapis.com` とも **2026-06-05 時点で未有効**を確認。
- M-1 着手時に有効化（Claude 代行可）:
```bash
gcloud services enable recaptchaenterprise.googleapis.com firebaseappcheck.googleapis.com \
  --project=kjk-tadakayo --account=yoshinao-tsukuda@tadakayo.jp
```

### M-1 着手の最小手順（担当を分離）
1. **（Claude）** 上記 API 2つを有効化
2. **（次田さん・Console）** reCAPTCHA Enterprise サイトキー発行（対象ドメイン `kjk.tadakayo.jp`）→ サイトキー文字列を共有
3. **（次田さん・Console）** Firebase Console → App Check → Web アプリ（App ID `1:677262660109:web:79645398db17dab417bb44`）を reCAPTCHA Enterprise プロバイダ＋上記サイトキーで登録
4. **（Claude）** `index.html` / `mitsumori.html` に App Check SDK 初期化、Webhook の fetch に `X-Firebase-AppCheck` ヘッダを付与（Phase A: `APPCHECK_ENFORCE=false`＝観察・弾かない）
5. **（Claude）** functions（`webhookLpInquiry` / `webhookMitsumori`）に `admin.appCheck().verifyToken()` の手動検証を実装（失敗しても warn のみ）→ デプロイ → 数日メトリクス観察
6. 失敗率が十分低ければ `APPCHECK_ENFORCE=true` で強制（Phase B）→ 手元 curl（トークンなし）が 401、正規フォームが 200 を確認

> [!INFO]
> M-1（リード保護・段階移行で低リスク）→ H-3（破壊的・editor 剥奪は最後）の順は変わらず。両者とも次田さんの着手指示（番号単位の明示認可）を得てから実施。H-3 は editor 剥奪前ならいつでも無停止ロールバック可。

---

## H-3 完全クローズ（2026-06-07・過剰権限2つの剥奪）

H-3 で関数別SA分離＋compute SA の `roles/editor`/`aiplatform.user` 剥奪は完了済みだったが、**どの Cloud Run/Functions からも参照されていない旧SAの過剰権限が2つ残存**していたため、システム開発担当の番号単位明示認可のもと剥奪した。

### 実施内容（dry-run → 適用 → 確認）
| # | 対象 | 剥奪したロール | 結果 |
|---|---|---|---|
| (a) | App Engine default SA `kjk-tadakayo@appspot.gserviceaccount.com` | `roles/editor` | ✅ 剥奪（残存ゼロ確認） |
| (b) | 旧 compute SA `677262660109-compute@developer.gserviceaccount.com` の `kjk-gmail-sa` への権限 | `roles/iam.serviceAccountTokenCreator` | ✅ 剥奪（残存ゼロ確認） |

### 事前裏取り（剥奪が安全な根拠）
- **全7関数(gen2/Cloud Run)の実行SAは `fn-*-sa` のみ**（aiassist=fn-ai-sa／dailyfollowup・testchatnotify=fn-batch-sa／sendcaseemail・sendsupplierorder=fn-mail-sa／webhook2本=fn-webhook-sa）。appspot SA・compute SA は実行に未使用。
- **`kjk-gmail-sa` への tokenCreator は `fn-mail-sa` が保持**しており、(b) で compute SA 分を剥奪してもメール送信（sendCaseEmail/sendSupplierOrder）の経路は無傷（実行SA=fn-mail-sa が impersonate）。

### 剥奪コマンド（config: tadakayo）
```bash
GCLOUD=~/Projects/google-cloud-sdk/bin/gcloud
# (a) App Engine default SA から roles/editor
$GCLOUD projects remove-iam-policy-binding kjk-tadakayo \
  --member="serviceAccount:kjk-tadakayo@appspot.gserviceaccount.com" --role="roles/editor"
# (b) compute SA から kjk-gmail-sa への tokenCreator
$GCLOUD iam service-accounts remove-iam-policy-binding kjk-gmail-sa@kjk-tadakayo.iam.gserviceaccount.com \
  --member="serviceAccount:677262660109-compute@developer.gserviceaccount.com" --role="roles/iam.serviceAccountTokenCreator"
```

### 動作確認
- IAM状態: (a)(b)とも残存ゼロ／`fn-mail-sa` の tokenCreator 維持を `get-iam-policy` で確認済み。
- ⚠️ **管理画面からの実送信確認は @tadakayo ログイン操作が必要（次田さん）**: ①case-detail「AIアシスタント」タブのメール送信（sendCaseEmail）②供給管理→発注→確定送付（sendSupplierOrder）を1件ずつ送信し成功を確認。万一失敗時は compute SA に当該ロールを再付与で無停止ロールバック。

### ロールバック（必要時）
```bash
$GCLOUD projects add-iam-policy-binding kjk-tadakayo --member="serviceAccount:kjk-tadakayo@appspot.gserviceaccount.com" --role="roles/editor"
$GCLOUD iam service-accounts add-iam-policy-binding kjk-gmail-sa@kjk-tadakayo.iam.gserviceaccount.com --member="serviceAccount:677262660109-compute@developer.gserviceaccount.com" --role="roles/iam.serviceAccountTokenCreator"
```

これで **H-3 は完全クローズ**（関数別SA分離＋全過剰権限の剥奪が完了）。

---

## users コレクション 運用フロー（RBAC 運用手順・2026-06-07 文書化）

2026-06-04 のルール刷新（`isRegistered()` + `isAdmin()` の RBAC）に対応する `users` コレクションの運用手順。

### 前提（firestore.rules）
`match /users/{email}`:
- `read`: 本人（自分の登録）または `isAdmin()`
- `write`: **`isAdmin()` のみ**（＝ `role=='admin'` ＋ `active==true` ＋ `@tadakayo.jp` のユーザーだけが users を追加/編集/無効化できる）

`users/{email}` のフィールド: `role`（`admin` / `staff` / `viewer`）, `active`（bool）, `name`。
現 admin: `yoshinao-tsukuda@tadakayo.jp`（次田）/ `hiroshi-sato@tadakayo.jp`（佐藤理事長）。

### 1. 新規スタッフ追加
- **誰が**: 管理者（`role=='admin'`）
- **どこから**: 管理画面 `https://kjk-tadakayo-admin.web.app/users.html`（ユーザー管理）
- **手順**: ①対象者に `@tadakayo.jp` の Google アカウントを用意 → ②ユーザー管理で「メール・氏名・role」を登録（`active=true`）→ ③本人が Google ログイン（未登録だと `gateRole()` で弾かれる）
- **デフォルト role**: `staff`（一般スタッフ）。`viewer` は閲覧のみ。`admin` は下記基準を満たす場合のみ。

### 2. 退職者・異動者の無効化
- **誰が**: 管理者
- **トリガー**: 退職・異動の連絡を受けたら**即座**に（遅延させない＝アクセス残存を防ぐ）
- **手順**: ユーザー管理で対象を `active=false` に設定（削除ではなく無効化＝監査履歴を残す）。`active=false` で `isRegistered()` が false になり、全データアクセス・ログインが即時遮断される。個人情報削除要請等で完全削除が必要な場合のみ users ドキュメントを削除。

### 3. role=='admin' の付与基準と決裁者
- **付与基準**: 他スタッフの登録/無効化・role 変更・課金/インフラに準ずる運営判断を行う**運営責任者のみ**。原則として最小人数（現状2名）に限定。
- **決裁者**: NPO法人タダカヨ 理事長（佐藤 拡史）または 次田 芳尚 の承認。admin を増減する際は決裁記録（チャット等）を残す。

> [!WARN]
> `users` の `write` は admin のみ。**最後の admin を誤って `active=false`／削除すると、誰も users を編集できなくなる（ロックアウト）**。admin の無効化・削除は別の admin が在籍することを確認してから行う。復旧時は Firebase Console（プロジェクトのオーナー権限）から `users/{email}` を直接編集する。
