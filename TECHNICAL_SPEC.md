# タダカヨの介護情報基盤伴走支援 — システム技術仕様書

> バージョン: 1.0（社内確認用）  
> 作成日: 2026-05-27  
> 作成者: 次田芳尚 ／ Claude  
> 対象読者: 事務局スタッフ・理事会・Pマーク担当者  
> 関連ドキュメント: `CRM_DESIGN.md`（詳細設計）、`HANDOFF.md`

---

## 目次

1. [システム全体概要](#1-システム全体概要)
2. [構成コンポーネント一覧](#2-構成コンポーネント一覧)
3. [アーキテクチャ図](#3-アーキテクチャ図)
4. [セキュリティ設計](#4-セキュリティ設計)
5. [個人情報・Pマーク対応](#5-個人情報pマーク対応)
6. [データ保管場所と管理体制](#6-データ保管場所と管理体制)
7. [障害対応・バックアップ](#7-障害対応バックアップ)
8. [利用コスト](#8-利用コスト)
9. [確認事項チェックリスト（社内確認用）](#9-確認事項チェックリスト社内確認用)

---

## 1. システム全体概要

### 1-1. 目的

「タダカヨの介護情報基盤伴走支援」（タダサポ＋）の問い合わせ受付から、助成金受領・アフターフォローまでの業務を一元管理するシステム。

### 1-2. 対象ユーザー

| ユーザー種別 | 利用箇所 | アクセス範囲 |
|---|---|---|
| 介護事業所（一般公開） | LP・見積もりツール | 公開ページのみ |
| タダカヨスタッフ | CRM管理画面 | @tadakayo.jp アカウントのみ |
| 認定事業所（将来） | B2Bポータル（Phase 12） | 専用アカウントのみ |

### 1-3. URL 構成

| URL | 公開範囲 | 用途 |
|---|---|---|
| `kjk.tadakayo.jp` | 誰でもアクセス可 | LP・補助金説明 |
| `kjk.tadakayo.jp/mitsumori.html` | 誰でもアクセス可 | 見積もりツール |
| `admin.kjk.tadakayo.jp` | @tadakayo.jp のみ | CRM管理画面 |

---

## 2. 構成コンポーネント一覧

すべてのサービスは Google Firebase（GCPプロジェクト: `kjk-tadakayo`）上で稼働。

| コンポーネント | サービス名 | 用途 |
|---|---|---|
| 静的ホスティング（LP） | Firebase Hosting | kjk.tadakayo.jp の配信 |
| 静的ホスティング（管理画面） | Firebase Hosting | admin.kjk.tadakayo.jp の配信 |
| ネットワーク防御 | Cloudflare Access（Zero Trust） | 管理画面への不正アクセス遮断 |
| ユーザー認証 | Firebase Authentication | Googleアカウントでのスタッフ認証 |
| データベース | Cloud Firestore | 案件・対応履歴・マスタデータ |
| ファイルストレージ | Cloud Storage for Firebase | 写真・PDF・書類ファイル |
| バックエンド処理 | Cloud Functions for Firebase (Node.js 20) | Webhook受信・メール送信・PDF生成・定期処理 |
| 定期実行 | Cloud Scheduler | フォローアップメール・期限アラートの自動実行 |
| メール送信 | Gmail API（OAuth 2.0） | 事業所へのメール送信 |
| スタッフ通知 | Google Chat Webhook | 新規案件受信・アラートの即時通知 |
| フォーム受信 | Formspree | LP問い合わせフォームのメール転送 |
| アクセス解析 | Microsoft Clarity + GA4 | LP訪問者の行動分析（個人情報収集なし） |
| 監視 | Cloud Logging + Monitoring | エラー・アクセスログの記録 |

---

## 3. アーキテクチャ図

```
【一般ユーザー（介護事業所）】
インターネット
    │
    ├── kjk.tadakayo.jp（LP）
    │       └── 問い合わせ → Formspree → メール通知
    │       └── 見積もり成約 → Cloud Functions (webhook) → Firestore + Google Chat
    │
    └── ※ admin.kjk.tadakayo.jp へのアクセスは不可（Cloudflareで完全遮断）

【タダカヨスタッフ】
インターネット
    │
    ▼
Cloudflare Access（第1層：ネットワーク防御）
    @tadakayo.jp のGoogleアカウントでない場合は遮断
    DDoS・ボット攻撃・不正スキャンを自動防御
    │
    ▼
admin.kjk.tadakayo.jp（CRM管理画面）
    │
    ▼
Firebase Authentication（第2層：アプリ認証）
    @tadakayo.jp のGoogleアカウントでのみログイン可
    セッション有効期限：24時間
    │
    ├── Cloud Firestore（案件データ・対応履歴）
    ├── Cloud Storage（写真・PDF・書類）
    ├── Cloud Functions（メール送信・PDF生成）
    │       └── Gmail API（メール送信）
    └── Google Chat Webhook（スタッフ通知）

【自動処理】
Cloud Scheduler（定期実行）
    └── Cloud Functions → Firestore 更新 + Gmail API + Google Chat
```

---

## 4. セキュリティ設計

### 4-1. アクセス制御の多層防御

管理画面へのアクセスは **2つの独立した防壁** で保護。

#### 第1層：Cloudflare Access（ネットワーク層）

- `admin.kjk.tadakayo.jp` へのリクエストはすべてCloudflareを経由
- `@tadakayo.jp` のGoogleアカウントでの認証に成功した場合のみ通過
- 未認証のアクセスには**HTMLすら返さない**（ページの存在を隠蔽）
- 自動でDDoS攻撃・ボット・不正スキャンを遮断
- 設定管理：Cloudflare Zero Trust ダッシュボード（次田さんのみ管理権限）

#### 第2層：Firebase Authentication（アプリ層）

- Googleプロバイダのみ有効（メール/パスワード認証は使用しない）
- ドメイン制限：`@tadakayo.jp` のアカウントのみ許可
- セッション有効期限：24時間（自動ログアウト）
- Cloudflare突破を万一された場合の最終防衛線

#### 効果の比較

| 攻撃シナリオ | Cloudflareのみ | 二重防御（本設計） |
|---|---|---|
| 総当たりログイン | △ 検知後遮断 | ✅ 第1層で完全遮断 |
| Cloudflare設定ミス | ❌ 突破される | ✅ 第2層で検知・遮断 |
| 外部からのURL直接アクセス | △ | ✅ HTMLすら返さない |
| DDoS | △ | ✅ Cloudflare自動対応 |

### 4-2. データベースアクセス制御（Firestore セキュリティルール）

```
・@tadakayo.jp のGoogleアカウントでFirebase認証を受けたユーザーのみ
  Firestore のすべてのコレクションへの読み書きを許可
・それ以外（未認証・他ドメイン）は一切のアクセスを拒否
・Cloud Functions からの書き込みは サービスアカウント（システム内部）経由のみ
```

### 4-3. ファイルストレージ アクセス制御（Cloud Storage）

```
・写真・PDFは @tadakayo.jp の認証済みユーザーのみ読み書き可能
・URLを知っていても認証なしではアクセス不可（署名付きURLを使用する場合を除く）
```

### 4-4. Webhook エンドポイント保護

- LP/見積もりツールからのWebhookは `事前共有秘密鍵` で正当性を検証
- 秘密鍵は **Google Secret Manager** で管理（コードに埋め込みなし）
- 秘密鍵が含まれないリクエストは即時拒否（エラーログに記録）

### 4-5. Gmail API トークン管理

- OAuth 2.0 リフレッシュトークンは **Google Secret Manager** で管理
- クライアントサイド（ブラウザが読み込むJS）には絶対に含めない
- 付与スコープ：`gmail.send` のみ（受信・削除・設定変更の権限は持たない）

### 4-6. 外部委託先（GCPプロジェクト）の管理権限

| 管理者 | 権限範囲 |
|---|---|
| 次田芳尚（理事長） | オーナー権限（全権限） |
| 開発担当 Claude | コードレビューのみ（実行権限なし）|

---

## 5. 個人情報・Pマーク対応

### 5-1. 収集する個人情報の種類

| 情報種別 | 収集元 | 保管場所 |
|---|---|---|
| 事業所担当者名・電話・メール | LP問い合わせフォーム / 見積もりツール | Firestore（暗号化保存） |
| 介護事業所番号 | スタッフ入力 | Firestore |
| 振込口座情報（事業所名義） | スタッフ入力（事業所から提供を受けて） | Firestore |
| 伴走支援時の写真（事業所内設備） | スタッフ撮影・アップロード | Cloud Storage |
| 対応履歴・メモ | スタッフ入力 | Firestore |

> ⚠️ 利用者（要介護者・要支援者）の個人情報は本システムでは**一切取り扱いません**。

### 5-2. 個人情報の利用目的

1. 介護情報基盤伴走支援サービスの提供
2. 助成金申請手続きのサポート
3. アフターフォロー（お礼・定期連絡）

### 5-3. 第三者提供・委託先

| 委託先 | 用途 | 個人情報の種類 |
|---|---|---|
| Google LLC（Firebase / GCP） | データ保管・処理基盤 | すべての保管データ |
| Google LLC（Gmail API） | メール送信 | 宛先メールアドレス・本文 |
| Cloudflare Inc. | ネットワーク防御 | アクセスIPアドレス・認証情報 |
| Formspree Inc. | 問い合わせフォーム受信 | 問い合わせ内容（名前・メール等） |

> 各社の個人情報保護方針はそれぞれの公式サイトを参照。

### 5-4. セキュリティ対策（Pマーク要求事項への対応）

| 要求事項 | 対応内容 | 状態 |
|---|---|---|
| アクセス制御 | Cloudflare + Firebase Auth の二重防御 | ✅ 設計済 |
| 監査ログ | `auditLogs` コレクションに全操作を記録 | ✅ 設計済 |
| 個人情報の暗号化保存 | Firestore・Cloud Storageの保存時暗号化（GCP標準機能） | ✅ 自動対応 |
| ログからの個人情報マスキング | Cloud Functions内でログ出力前にマスク処理 | ✅ 設計済 |
| データ削除対応 | 削除リクエストUIを実装（30日以内に物理削除） | ✅ Phase 8で実装 |
| 委託先管理 | 上記の委託先一覧を整備 | ✅ 本書に記載 |
| 保管場所の限定 | GCPプロジェクト `kjk-tadakayo` 内のみ | ✅ 設計済 |
| ログ保管期間 | Cloud Logging：30日間（GCPデフォルト） | ✅ |
| 外部持ち出し制限 | 管理画面からのダウンロードはCSV出力のみ（Phase 8） | ✅ 設計済 |

### 5-5. 残課題（Pマーク担当者確認事項）

| # | 確認事項 | 担当 |
|---|---|---|
| 1 | 本システムをPマーク規程の「委託先」として正式に登録するか | 事務局 |
| 2 | 介護事業所への「個人情報取扱いに関する同意」をLP/見積もりツールで取得しているか確認 | 事務局 |
| 3 | 写真（事業所内の設備・風景）がPマーク規程上の「個人情報」に該当するか確認 | Pマーク担当 |
| 4 | スタッフの操作ログは労働法上の観点から別途通知が必要かどうか確認 | 事務局 |
| 5 | Cloud Logging 30日保管で規程の「保管期間」を満たすか確認 | Pマーク担当 |

---

## 6. データ保管場所と管理体制

### 6-1. データの所在

```
GCPプロジェクト: kjk-tadakayo
リージョン: asia-northeast1（東京）

├── Firestore
│   ├── 案件情報（offices / cases / contacts）
│   ├── 対応履歴（activities / emailLogs）
│   ├── 伴走支援記録（supportSessions / sessionTasks）
│   ├── 補助金申請情報（subsidyApplications）
│   ├── マスタデータ（products / shippingRates / vendors）
│   ├── 在庫・発注（inventory / purchaseOrders / shipments）
│   └── 監査ログ（auditLogs）
│
├── Cloud Storage
│   ├── /sessions/{sessionId}/photos/  （伴走支援写真）
│   └── /reports/{reportId}/           （伴走支援レポートPDF・発注書PDF）
│
└── Cloud Logging
    └── Cloud Functionsの実行ログ（30日間保管）
```

### 6-2. データへのアクセス権限

| 役割 | Firestore | Cloud Storage | 管理コンソール |
|---|---|---|---|
| タダカヨスタッフ（@tadakayo.jp） | 読み書き | 読み書き | なし |
| 次田芳尚（理事長） | 読み書き | 読み書き | あり（オーナー） |
| Cloud Functions（システム） | 読み書き（サービスアカウント） | 読み書き | なし |
| その他 | 拒否 | 拒否 | なし |

### 6-3. データの物理的所在

- Firestore / Cloud Storage：Google のデータセンター（東京リージョン）に保管
- データは Google の基準でサーバー内暗号化済み
- 物理的なサーバーへのアクセスはGoogleが管理（タダカヨはアクセス不可）

---

## 7. 障害対応・バックアップ

### 7-1. Firestore の可用性・バックアップ

- 可用性：Google SLA 99.999%（月間ダウンタイム上限 約26秒）
- データ複製：Googleのデータセンター内で自動複製（3重以上）
- 定期バックアップ：Cloud Firestoreの「エクスポート機能」で月1回程度 Cloud Storage に出力（実装：Phase 8）
- データ損失時：Googleサポートへの問い合わせで時点回復が可能な場合あり

### 7-2. 障害発生時の連絡フロー

```
障害検知（スタッフ / Cloud Monitoringアラート）
    │
    ▼
次田芳尚（理事長）に連絡
    │
    ├── Firebase / GCP障害: Google Cloud Status を確認 → 復旧待ち
    ├── Cloudflare障害: Cloudflare Status を確認 → 一時的にCloudflare無効化（緊急）
    └── アプリバグ: 前バージョンへのロールバック（Firebase Hosting機能）
```

### 7-3. ロールバック手順

- Firebase Hosting: Firebaseコンソールから1クリックで前バージョンに戻せる
- Cloud Functions: デプロイ済み旧バージョンへの切り戻しが可能

---

## 8. 利用コスト

### 8-1. 月額コスト試算（運用規模：スタッフ20名以下・案件数100件/月程度）

| サービス | 無料枠 | 月額見込み |
|---|---|---|
| Firebase Hosting | 10GB/月・360MB/日 | **¥0** |
| Cloud Firestore | 読み取り50,000回/日・書き込み20,000回/日 | **¥0** |
| Cloud Functions | 125,000回/月・400,000 GB秒/月 | **¥0** |
| Cloud Storage | 5GB | **¥0**（5GB超過分 約¥3.5/GB） |
| Cloud Scheduler | 3 jobs 無料 | **¥0** |
| Firebase Authentication | 無制限 | **¥0** |
| Cloudflare Access | 50名まで無料 | **¥0** |
| Gmail API | 250通/日無料 | **¥0** |
| Formspree | 50件/月まで無料（Freeプラン） | **¥0〜¥2,200/月** |
| **合計** | | **¥0〜数百円/月** |

> 写真・PDFが月10GBを超えてきた場合、Cloud Storage 料金が発生（試算: 50GB/月 ≒ ¥160）。

### 8-2. コスト増加トリガー

- スタッフ数が51名以上 → Cloudflare Access は有料プラン（$7/名/月）
- Formspreeへの問い合わせが51件/月超 → 有料プラン移行（¥2,200/月）
- 写真・PDFが大量に蓄積 → Cloud Storage 追加費用

---

## 9. 確認事項チェックリスト（社内確認用）

### A. Pマーク・法務確認

- [ ] 介護事業所との契約書・利用規約に「クラウドサービス（GCP）への個人情報預託」の記載があるか
- [ ] Google LLC（Firebase/GCP）との間にある標準契約条項（SCC）がPマーク規程の「委託先管理」要件を満たすか確認
- [ ] Cloudflare Inc.へのアクセスログ（IPアドレス）の取り扱いについて確認
- [ ] 伴走支援時の写真撮影に関する事業所からの同意取得手順を確立しているか
- [ ] 監査ログの保管期間（現行30日）でPマーク規程の「保管期間」を満たすか

### B. セキュリティ確認

- [ ] Cloudflareのダッシュボードへのアクセスは次田さん1名のみか
- [ ] Firebase コンソールへのアクセスは次田さん1名のみか（スタッフへの権限付与は不要な範囲にとどめているか）
- [ ] Google Secret Managerの管理者は誰か明確になっているか
- [ ] 退職者のアカウント削除（@tadakayo.jpアカウントの無効化 = 自動的にCRMアクセス不可）の手順が確立しているか

### C. 運用確認

- [ ] スタッフへのCRM操作マニュアルを用意するか（Phase 1完了時に作成予定）
- [ ] Cloud Storageのバックアップ取得を月次で行う担当者は誰か
- [ ] 障害発生時の連絡先（次田さん）を全スタッフに周知しているか
- [ ] Formspreeの問い合わせ上限（50件/月）に近づいた場合の対応方針を決めておく

---

*Document version: 1.0 / 2026-05-27*  
*次回更新: Phase 1 実装完了後（Firebase設定・スタッフアカウント一覧の追記）*
