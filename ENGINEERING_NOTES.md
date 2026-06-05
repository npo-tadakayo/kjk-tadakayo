# 科学的介護情報基盤 普及推進支援LP — エンジニアノート

> プロジェクト: kjk-tadakayo  
> 担当: NPO法人タダカヨ / 次田芳尚  
> 最終更新: 2026-05-27

---

## Part A — 経営層向け

### §0 コンセプト

2026年4月から開始した「介護情報基盤」のマイナ資格確認対応を支援するランディングページ。
AB Circle製カードリーダーの販売と、補助金申請を含む伴走型サポートパック（¥61,000税別）の獲得をコンバージョンゴールとする。

### §1 背景

- 介護情報基盤：マイナンバーカードで介護保険資格をオンライン確認する仕組み（2026年4月開始）
- 2026年5月7日より介護情報基盤向け助成金の申請受付開始（申請期限：2027年3月12日）
- 助成金の存在・申請方法を知らない介護事業所が多く、タダカヨが伴走支援することで差別化

### §2 効果（期待値）

- 訪問・通所系3台構成：¥61,000（税別）= 税込¥67,100 → 助成金¥64,000 → **自己負担¥3,100**
- 「3,100円で整う、介護情報基盤。」をキャッチコピーとしてコンバージョン率向上を狙う

### §3 ユースケース

```mermaid
flowchart LR
    A[介護事業所] -->|LPを見る| B[kjk.tadakayo.jp]
    B -->|問い合わせ| C[タダカヨ]
    C -->|伴走サポート| D[カードリーダー導入]
    C -->|助成金申請代行| E[助成金受給]
    D --> F[マイナ資格確認 稼働]
```

### §4 マニュアル

→ README.md 参照（作成予定）

---

## Part B — エンジニア向け

### §5 技術スタック

#### LP（ランディングページ）
| 項目 | 内容 |
|---|---|
| フロントエンド | 単一HTML（index.html）/ インラインCSS+JS |
| フォント | Google Fonts — Noto Sans JP |
| アイコン | Tabler Icons v3.24.0+ (CDN) |
| フォーム送信 | Formspree（xjglevjk） |
| アクセス解析 | Microsoft Clarity (wax7x03bg8) + GA4 (G-0NZY6PM3FG) |
| ホスティング | Firebase Hosting target: `lp`（kjk-tadakayo.web.app） |
| ドメイン | kjk.tadakayo.jp（お名前.com管理） |

#### CRM 管理画面（Phase 1 / 2026-05-27 実装）
| 項目 | 内容 |
|---|---|
| フロントエンド | Vanilla JS (ES Module) + Firebase SDK v10 CDN |
| フォント | Noto Serif JP（見出し）/ Inter・Noto Sans JP（本文） |
| アイコン | Tabler Icons v3.24.0+ (CDN) |
| 認証 | Firebase Auth (Google / @tadakayo.jp ドメイン制限) |
| データベース | Cloud Firestore (asia-northeast1) |
| ストレージ | Cloud Storage (asia-northeast1) |
| バックエンド | Cloud Functions v2 (Node 20 / asia-northeast1) |
| ホスティング | Firebase Hosting target: `admin`（kjk-tadakayo-admin.web.app） |
| セキュリティ | Firestore Rules + Storage Rules (@tadakayo.jp 制限) |

共通
| 項目 | 内容 |
|---|---|
| Firebase プロジェクト | kjk-tadakayo |
| リポジトリ | https://github.com/tsuku-29/kjk-tadakayo |

### §6 アーキテクチャ図

```mermaid
flowchart LR
    User[介護事業所\nブラウザ] -->|HTTPS| LP[kjk.tadakayo.jp]
    LP -->|フォーム送信| Formspree[Formspree API]
    Formspree -->|メール通知| Admin[タダカヨ担当者]
    LP -->|見積もり完了| Fn2[Cloud Functions\nwebhookMitsumori]
    LP -->|問い合わせ| Fn1[Cloud Functions\nwebhookLpInquiry]
    Fn1 --> FS[Cloud Firestore\ncases / offices]
    Fn2 --> FS
    Fn1 -->|Chat通知| GChat[Google Chat\nスペース AAQAkcdopcA]
    Fn2 --> GChat
    Staff[スタッフ\nブラウザ] -->|Google認証| CRM[kjk-tadakayo-admin.web.app]
    CRM -->|リアルタイム購読| FS
    LP -->|計測| Clarity[Clarity / GA4]
```

### §7 ファイル構成

```
tadakiayo-kiban/
├── index.html                # LP本体
├── mitsumori.html            # 見積もりツール
├── firebase.json             # multi-site hosting + functions + rules
├── .firebaserc               # LP(lp) / CRM管理(admin) target設定
├── firestore.rules           # @tadakayo.jp 制限セキュリティルール
├── storage.rules             # @tadakayo.jp 制限ストレージルール
├── deploy.sh                 # デプロイスクリプト（--lp-only オプションあり）
├── admin/                    # CRM管理画面（static）
│   ├── index.html            # ログイン画面
│   ├── cases.html            # 案件一覧
│   ├── case-detail.html      # 案件詳細（タイムライン/書類チェック/申請情報）
│   ├── js/
│   │   ├── firebase-config.js  # Firebase設定（REPLACE_WITH_ACTUAL_* 要差し替え）
│   │   ├── auth.js            # 共通認証ガード（現在はindex.htmlに統合）
│   │   ├── cases.js           # 案件一覧ロジック
│   │   └── case-detail.js     # 案件詳細ロジック
│   └── css/
│       └── crm.css            # CRM専用スタイル（v4デザインシステム準拠）
├── functions/                 # Cloud Functions v2
│   ├── package.json
│   └── index.js               # webhookLpInquiry / webhookMitsumori
├── images/                    # LP用画像
└── ENGINEERING_NOTES.md
```

### §8 LPセクション構成

| セクション | 内容 |
|---|---|
| ヘッダー（固定） | タダカヨロゴ / 無料相談ボタン（#contactへ） |
| 緊急バナー | 助成金申請開始日・期限の強調 |
| ヒーロー | キャッチ「3,100円で整う」/ 計算カード / CTA×2 |
| 問題提起 | 介護情報基盤とは / 未対応リスク |
| 助成金比較 | 介護情報基盤助成金 vs ICT補助金の優位性 |
| 助成金早見表 | 3種別 × 上限額 × 台数 |
| 製品紹介 | CIR415A（Bluetooth）/ CIR315A（USB） |
| おまかせパック | ¥61,000内訳 / 実質負担額 |
| タダカヨの強み | NPO非営利 / 介護DX専門 / 1年伴走 |
| FAQ | 4問 |
| お問い合わせ | Formspreeフォーム（#contact） |
| フッター | タダカヨ情報 |

### §9 助成金ロジック（重要）

**なぜ¥61,000が最適か：**

- 介護情報基盤助成金（定額型）：訪問・通所系3台 → 上限¥64,000（税込）
- ICT導入支援事業（割合型3/4）：同額なら補助額¥45,750 → 自己負担¥15,250と大幅に不利
- ¥61,000（税別）= ¥67,100（税込）→ 助成金¥64,000を引くと自己負担**¥3,100**
- 「定額型助成金の上限内に税込価格を収める」設計

### §10 デプロイ

```bash
# yoshinao-tsukuda@tadakayo.jp アカウントでログイン済みであること
bash deploy.sh
# または
firebase deploy --only hosting --project kjk-tadakayo
```

- 本番URL: https://kjk-tadakayo.web.app
- カスタムドメイン: https://kjk.tadakayo.jp（DNS設定後）

### §11 DNS設定（お名前.com）

| TYPE | ホスト名 | VALUE |
|---|---|---|
| CNAME | `kjk` | `kjk-tadakayo.web.app` |

### §12 プレースホルダー一覧（要差し替え）

| 場所 | プレースホルダー | 取得先 |
|---|---|---|
| フォームaction | `PLACEHOLDER` | https://formspree.io |
| Clarity | `CLARITY_PROJECT_ID` | https://clarity.microsoft.com → wax7x03bg8 |
| GA4 | `G-XXXXXXXXXX` | analytics.google.com → G-0NZY6PM3FG |

---

## Part C — 記録

### §13 現在の状態（2026-06-02 更新）

#### LP / 見積もりツール
- 本番稼働中: https://kjk.tadakayo.jp / https://kjk.tadakayo.jp/mitsumori.html
- 令和8年度申請期間（2026-05-07〜2027-03-12）・USB¥6,500・全35サービス対応済み
- **2026-06-02 本番動作確認 PASS**（Playwrightで観察検証）: 申請期間・メーカー価格（¥17,380/¥7,150）・補助金区分（¥64,000/¥55,000/¥42,000）・見積もり計算5パターン（補助対象は自己負担¥0／補助対象外は自己負担計上）・Clarity/GA4 を確認
- **2026-06-02 補助金完全リストを35コード逐語化**（LP表＋見積もり折りたたみ）: 区分① 18 / 区分② 12 / 区分③ 5。短期入所療養介護の3種別・各「短期利用」バリアントを明示。それ以前は28行の集約表示だった
- **2026-06-02 favicon/apple-touch-icon に `images/tadakayo_logo.png` を設定**（favicon.ico 404 を解消）
- **2026-06-02 見積書の税表記を修正**: 明細テーブル見出しを「単価/金額（税別）」→「（税込）」に修正。定数・計算・備考（行1420「本見積書の金額はすべて消費税10%を含む税込金額で表示」）はすべて税込ベースで、消費税の別途加算は無し。見出しのみラベル誤りだった

#### CRM 管理画面（Phase 1 実装完了・デプロイ待ち）
- **コード実装完了** (コミット `307a01b`, CSSfix `1d4efda`)
- **Firebase Console の設定待ち** → `CRM_SETUP_GUIDE.md` 参照
- デプロイ後 URL: https://kjk-tadakayo-admin.web.app
- `admin/js/firebase-config.js` の `REPLACE_WITH_ACTUAL_*` を Firebase Console で差し替え必須

#### GitHub
- 最新コミット: `2dbe775`（main / push済み 2026-06-02）
- push は fine-grained PAT（`tsuku-29/kjk-tadakayo` 限定・2026-08-06まで）をURL埋め込みで実行（memory `feedback_deploy.md` 参照）

#### 実装済み機能（Phase 1）
- ログイン画面（Google / @tadakayo.jp 制限・`signInWithPopup`）
- 案件一覧（リアルタイム購読・検索・フィルタ・新規登録モーダル・申請期限カウントダウン）
- 案件詳細（対応記録タイムライン / 書類チェック4項目+口座情報 / 申請情報7段階）
- Webhook受信（LP問い合わせ・見積もり成約 → Firestore自動登録・重複検出・Chat通知）
- Firestoreセキュリティルール (@tadakayo.jp 制限)
- Storageセキュリティルール (@tadakayo.jp 制限)

### §14 設計議論

**助成金フレームの選択（2026-05-07）**
ICT導入支援事業（割合型）と介護情報基盤助成金（定額型）を比較した結果、定額型が大幅に有利と判明。

| 比較 | 介護情報基盤 助成金（定額型）| ICT導入支援（割合型3/4） |
|---|---|---|
| 訪問・通所系3台 | **¥64,000（上限まで全額）** | ¥62,700×3/4=¥47,025 |
| 自己負担 | **¥0** | ¥15,675 |

**価格を¥61,000→¥57,000に変更した経緯（2026-05-07）**
当初は税込¥67,100（¥61,000税別）設計だったが、税込¥62,700（¥57,000税別）に変更することで助成金上限¥64,000以内に収まり、全パターン自己負担¥0を実現。サポート費を¥34,000→¥30,000(税別)に調整。

**全6パターン自己負担¥0の根拠（PRICING.md参照）**
- 訪問・通所系: BT×3台¥62,700 / USB×3台¥49,500 → 上限¥64,000以内
- 居住・入所系: BT×2台¥53,900 / USB×2台¥45,100 → 上限¥55,000以内
- その他: BT×1台¥40,700 / USB×1台¥36,300 → 上限¥42,000以内

### §15 ADR

- ADR-001: 単一HTMLファイル構成を採用（Next.js等不使用）→ Firebase Hostingへの直デプロイを優先、更新コストを最小化
- ADR-002: 画像は `images/` サブフォルダで管理 → Firebase Hosting で静的ファイルとして配信
- ADR-003: キャラクター画像はPillowで白背景透過処理 → OS間の描画差異をなくし、有色背景でも自然に表示

### §16 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-05-07 | index.html 初版作成・Firebase Hosting デプロイ・GitHub push |
| 2026-05-07 | ENGINEERING_NOTES.md / PRICING.md 作成 |
| 2026-05-07 | サービス名「タダサポ 介護情報基盤版」確定・価格¥57,000(税別)に変更 |
| 2026-05-07 | 製品写真・キャラクター画像追加、全画像白背景透過処理 |
| 2026-05-07 | ヘッダーロゴをタダカヨロゴ画像に差し替え |
| 2026-05-07 | 助成金早見表を3行すべてBT/USB両プラン表示に統一・HANDOFF.md 作成 |
| 2026-05-22 | USB価格¥6,500改定・居宅介護支援を¥64,000区分に修正・全35サービス完全リスト反映 |
| 2026-05-27 | CRM Phase 1 実装完了（admin/ + functions/ + firestore.rules + storage.rules + firebase.json multi-site化）|
| 2026-06-02 | LP本番動作確認PASS／補助金完全リストを35コード逐語化／favicon追加（`deploy.sh --lp-only` 本番デプロイ・コミット `2dbe775` push済）|
| 2026-06-02 | 見積書明細の税表記を「（税別）」→「（税込）」に修正（ラベル誤り・本番デプロイ済）|
| 2026-05-27 | TECHNICAL_SPEC.md・工数試算書.md 新規作成・社内PDF共有 |
| 2026-05-27 | 令和8年度申請期間（2026-05-07〜2027-03-12）に更新 |
| 2026-06-05 | 発注書の実印影対応（設定で印影画像アップロード→黒背景透過→`appConfig/settings.poSealImage`／supply-printが`<img>`描画・`505832a`）|
| 2026-06-05 | GCPセキュリティ改修5件: H-1 Delete Protection／H-5 Vertex AI=asia-northeast1（コード既定値含む`8568249`）／M-4 localhost削除／H-2 PITR(7日)／M-2 CHAT_WEBHOOK_URL Secret Manager化(`2dff953`) |
| 2026-06-05 | 残セキュリティ: M-1(App Check・専用session)／H-3,H-4(Phase4 IAM)／M-5,M-3(Phase5)。付帯: Gemini2.5 retire 2026-10-16→G3移行 |
