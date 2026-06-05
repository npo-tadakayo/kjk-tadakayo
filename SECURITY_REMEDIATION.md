# GCPセキュリティ改修 対応状況レポート（kjk-tadakayo）

> 対象プロジェクト: `kjk-tadakayo`（Firebase / Cloud Run Functions v2 / asia-northeast1）
> 起点: 開発チームからのセキュリティ指摘 10件（高 H / 中 M）
> 最終更新: 2026-06-05
> 操作アカウント: `yoshinao-tsukuda@tadakayo.jp`（gcloud config `tadakayo`）

---

## サマリー

10件中 **8件が対応完了**（うち H-4 は調査の結果リスクが存在せず実態クリア、M-5 は 2026-06-05 実装完了、M-3 は管理画面が Google SSO 一本のため Workspace 2段階認証で充足）。残り **2件＋付帯1件**。本番影響・破壊性の大きいもの（H-3 / M-1）は段階・専用対応とする。

| # | 重大度 | 項目 | 状態 | 反映方法 |
|---|---|---|---|---|
| H-1 | 高 | Firestore Delete Protection | ✅ 完了 | DB設定 |
| H-2 | 高 | Firestore PITR（7日復元） | ✅ 完了 | DB設定 |
| H-5 | 高 | Vertex AI location=asia-northeast1 | ✅ 完了 | コード`8568249`＋env |
| M-2 | 中 | Chat Webhook URL を Secret Manager 化 | ✅ 完了 | コード`2dff953` |
| M-4 | 中 | authorized_domains から localhost 削除 | ✅ 完了 | Auth設定 |
| H-4 | 高 | kjk-gmail-sa の鍵廃止 | 🟢 実態クリア | 鍵ゼロを確認 |
| M-5 | 中 | Cloud Monitoring アラート | ✅ 完了 | gcloud |
| H-3 | 高 | 関数別SA・最小権限 | 🟡 SA移行済・editor剥奪待ち（2026-06-05） | IAM＋再デプロイ |
| M-1 | 中 | Webhook 保護（App Check） | 🟡 Phase A 実装・観察中（2026-06-05） | App Check |
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

### 1. M-1 Webhook保護（App Check・段階移行）【次の最有力】

> ✅ **Phase A（観察モード）実装・本番反映・検証まで完了（2026-06-05 セッション⑥）**
> - reCAPTCHA Enterprise サイトキー発行（表示名 `kjk-tadakayo-lp` / ドメイン `kjk.tadakayo.jp` / スコアベース・チェックボックスなし）。サイトキー = `6LfHTQ4tAAAAAJ4uIXrIvuCXCyyinUz0FPzhvNNp`（公開キー・ページ埋込）。
> - Firebase App Check に Web アプリ `kjk-crm-admin`（App ID `1:677262660109:web:79645398db17dab417bb44`）を **reCAPTCHA Enterprise** プロバイダ＋上記サイトキーで登録済み（TTL 1時間）。**API タブの各サービス Enforce は未設定（=他機能に影響なし）**。
> - 前提 API `recaptchaenterprise` / `firebaseappcheck` を有効化済み。
> - コード: `index.html` / `mitsumori.html` に App Check（compat SDK + ReCaptchaEnterpriseProvider）初期化＋Webhook fetch に `X-Firebase-AppCheck` ヘッダ付与（`getAppCheckToken()`・取得失敗時 null）。`functions/index.js` に `appCheckGate()` を追加し `webhookLpInquiry`/`webhookMitsumori` 冒頭で検証。`APPCHECK_ENFORCE`（既定 false=観察）。
> - デプロイ: functions 2本のみ更新（他5関数は未変更）/ LP は preview channel → 本番昇格（hosting:lp）。
> - **検証**: 本番 `kjk.tadakayo.jp` の実ブラウザで `getAppCheckToken()` が 954文字の正規 App Check JWT を返却・console error 0。functions は GET で 405（稼働確認・案件未作成）。両LP（`/`・`/mitsumori`）HTTP 200・コード搭載確認。
> - **残: Phase B（強制）** = 数日 observe ログ（`[AppCheck][...] observe` の `verified`/`missing-token` 比率）を確認し、正規フォームのトークン付与率が十分高ければ functions に `APPCHECK_ENFORCE=true`（`--set-env-vars` or functions/.env）を設定して2本を再デプロイ。手元 curl（トークンなし）が 401／正規フォームが 200・Firestore `cases` 登録、で確認。ロールバックは `APPCHECK_ENFORCE=false` で再デプロイ。

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

> 🟡 **SA移行まで完了（2026-06-05 セッション⑥）／ editor剥奪のみ残**
> - 4つの専用SAを作成し最小権限を付与：`fn-webhook-sa`(datastore.user＋CHAT secretAccessor) / `fn-batch-sa`(同) / `fn-ai-sa`(aiplatform.user のみ) / `fn-mail-sa`(datastore.user＋kjk-gmail-sa への serviceAccountTokenCreator)。全IAMバインド読み取り確認済み。
> - 全7関数の定義に `serviceAccount` を明記（コード化＝再デプロイで維持）して再デプロイ済み。実行SA切替を `gcloud functions describe` で確認：webhook2本→fn-webhook-sa / testChatNotify・dailyFollowup→fn-batch-sa / aiAssist→fn-ai-sa / sendCaseEmail・sendSupplierOrder→fn-mail-sa。
> - **検証済**: `webhookLpInquiry`(fn-webhook-sa) を本番疎通テストし HTTP200・`observe: verified`・Firestore書込・Chat通知・secret読取が全て機能（テスト案件は削除）。fn-batch-sa は fn-webhook-sa と同一ロールのため等価。
> - **compute SA(`677262660109-compute`) の `roles/editor`＋`roles/aiplatform.user` は安全網として保持中**（まだ剥奪していない）。
> - **残（次セッション）**:
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
