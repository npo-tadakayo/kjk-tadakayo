# CRM セットアップ手順書

デプロイ前に次田さんが Firebase Console で行う作業をまとめています。

---

## Step 1: Firebase Console でサービスを有効化

https://console.firebase.google.com/project/kjk-tadakayo

### 1-1. Firestore Database を有効化
1. 左メニュー「Firestore Database」→「データベースを作成」
2. **本番環境モード** を選択
3. リージョン: `asia-northeast1`（東京）

### 1-2. Authentication を有効化
1. 左メニュー「Authentication」→「始める」
2. 「Sign-in method」→「Google」を有効化
3. プロジェクトのサポートメール: `yoshinao-tsukuda@tadakayo.jp`

### 1-3. Cloud Storage を有効化
1. 左メニュー「Storage」→「始める」
2. 本番環境モード・リージョン `asia-northeast1`

---

## Step 2: ウェブアプリを追加して firebase-config.js を更新

1. Firebase Console 左メニュー上の「プロジェクトの設定（歯車）」
2. 「マイアプリ」→「アプリを追加」→「ウェブ（</>）」
3. アプリのニックネーム: `kjk-crm-admin`
4. 「Firebase Hosting も設定する」は**チェックしない**
5. 表示された設定をコピーして `admin/js/firebase-config.js` の REPLACE_WITH_ACTUAL_* を書き換える

```js
const firebaseConfig = {
  apiKey: "AIza...",          // ← ここを差し替え
  authDomain: "kjk-tadakayo.firebaseapp.com",
  projectId: "kjk-tadakayo",
  storageBucket: "kjk-tadakayo.firebasestorage.app",
  messagingSenderId: "123456789",  // ← ここを差し替え
  appId: "1:123456789:web:abc..."  // ← ここを差し替え
};
```

---

## Step 3: Hosting サイトを追加作成

Firebase Console の「Hosting」では、LPと管理画面で**2つのサイト**を使います。

### Firebase CLI で実行（ターミナル）
```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 20
cd ~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp/マイドライブ/開発/tadakiayo-kiban

# 管理画面用の Hosting サイトを追加（1度だけ実行）
firebase hosting:sites:create kjk-tadakayo-admin --project kjk-tadakayo
```

---

## Step 4: デプロイ

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 20
cd ~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp/マイドライブ/開発/tadakiayo-kiban

# Functions の依存ライブラリをインストール（初回のみ）
cd functions && npm install && cd ..

# デプロイ（LP + 管理画面 + Functions + Rules）
firebase deploy --project kjk-tadakayo
```

デプロイ完了後:
- LP: https://kjk-tadakayo.web.app（既存）
- 管理画面: https://kjk-tadakayo-admin.web.app

---

## Step 5: 動作確認

1. https://kjk-tadakayo-admin.web.app にアクセス
2. `@tadakayo.jp` アカウントでログイン → 案件一覧が表示される
3. `@tadakayo.jp` 以外でログイン → エラーが表示されること

---

## Step 6: （オプション）Cloudflare Access 設定

`admin.kjk.tadakayo.jp` でアクセスできるようにするには別途 Cloudflare 設定が必要。
現時点では `kjk-tadakayo-admin.web.app` ドメインで動作確認できます。

Cloudflare 設定は `CRM_DESIGN.md § Phase 0` を参照。

---

## Functions の環境変数設定

Google Chat Webhook URL を Functions に設定します:

```bash
# .env ファイルを作成（functions/ ディレクトリ内）
echo 'CHAT_WEBHOOK_URL=https://chat.googleapis.com/...' > functions/.env
```

または Firebase Console → Functions → 設定 → 環境変数 で設定。

---

## mitsumori.html の Webhook URL 更新（デプロイ後）

デプロイ後、`mitsumori.html` の `WEBHOOK_URL` を Cloud Functions の URL に変更します:

```
https://asia-northeast1-kjk-tadakayo.cloudfunctions.net/webhookMitsumori
```

`index.html` の `CONTACT_WEBHOOK_URL` は変更不要（Formspree + Google Chat Webhook のまま）。
