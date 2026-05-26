# Gmail MCP セットアップ手順（Claude Code 用）

> 目的: y.tsukuda@tadakayo.jp の Gmail を Claude Code から読み書きできるようにする
> 推奨パッケージ: [@gongrzhe/server-gmail-autoauth-mcp](https://github.com/GongRzhe/Gmail-MCP-Server)
> 作成: 2026-05-26

---

## 完了後にできること

- Claude が Gmail の下書きを自動作成（送信前に次田さんが確認）
- 特定の送信者・件名のメールを検索・要約
- 受信メールの内容を案件カードに自動取り込み（将来の CRM 連携）

---

## セットアップ手順

### 1. Google Cloud Console で OAuth 設定（10分）

```
1. https://console.cloud.google.com/ にアクセス
   ※ y.tsukuda@tadakayo.jp でログイン

2. プロジェクトを選択 or 新規作成
   既存: kjk-tadakayo
   新規: 「tadakayo-gmail-mcp」など

3. 「APIとサービス」→「ライブラリ」
   → 「Gmail API」を検索 → 有効化

4. 「APIとサービス」→「OAuth同意画面」を構成
   - User Type: 内部（@tadakayo.jp の Google Workspace ユーザーのみ）
     ※ 外部にすると審査が必要
   - アプリ名: タダカヨ Gmail MCP
   - サポートメール: y.tsukuda@tadakayo.jp
   - スコープ: 以下を追加
     * https://www.googleapis.com/auth/gmail.send（送信）
     * https://www.googleapis.com/auth/gmail.compose（下書き）
     * https://www.googleapis.com/auth/gmail.modify（既読・ラベル）
     * https://www.googleapis.com/auth/gmail.readonly（読み取り）
   - テストユーザー（必要なら）: y.tsukuda@tadakayo.jp

5. 「APIとサービス」→「認証情報」→「認証情報を作成」
   →「OAuth 2.0 クライアントID」
   - アプリケーションタイプ: デスクトップアプリ
   - 名前: claude-code-gmail-mcp

6. ダウンロードボタン → JSON をダウンロード
   - ファイル名: client_secret_XXXXX.json

7. 以下に配置（フォルダがなければ作成）
   mkdir -p ~/.gmail-mcp
   mv ~/Downloads/client_secret_XXXXX.json ~/.gmail-mcp/gcp-oauth.keys.json
```

### 2. MCP サーバーをインストール

```bash
# Node.js 20 推奨
npm install -g @gongrzhe/server-gmail-autoauth-mcp
```

### 3. 初回認証（1回だけ・ブラウザが開く）

```bash
npx @gongrzhe/server-gmail-autoauth-mcp auth
```

- ブラウザが開く → y.tsukuda@tadakayo.jp でログイン
- 警告が出たら「詳細」→「移動」→ 許可
- 認証成功 → ターミナルに完了メッセージ

### 4. Claude Code に MCP 設定を追加

設定ファイル: `~/.claude/settings.json`

既存の設定に `mcpServers` 配下に gmail を追加：

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["@gongrzhe/server-gmail-autoauth-mcp"]
    }
  }
}
```

※ すでに他の MCP（playwright・github・firebase 等）が設定されている場合は、同じ `mcpServers` 配下に追記してください。

### 5. Claude Code を再起動

```bash
# 現在のセッションを終了
exit

# 再起動
claude
```

### 6. 動作確認

Claude Code 起動後、以下を試す：

- 「Gmail で最新のメール10件を見せて」
- 「野田さん からのメールを検索して」
- 「下書きを作って：宛先 noda@abcircle.co.jp / 件名 テスト / 本文 テストです」

---

## セキュリティ注意事項

- `~/.gmail-mcp/gcp-oauth.keys.json` は git にコミットしない
- 認証トークン（`~/.gmail-mcp/credentials.json` 等）もローカルのみ保存
- Pマーク規程との照合：
  - 個人情報（顧客メール）を Claude に渡すのは「業務委託先（Google Cloud / Anthropic）への取り扱い委託」に該当
  - タダカヨの個人情報取扱規程に「業務委託先」として明記する必要があるか確認

---

## トラブルシューティング

### 認証で「アクセスがブロックされました」エラー

- OAuth同意画面で「内部」を選んでいるか確認
- 外部の場合は「テストモード」で進めるか、Google Cloud のアプリ審査が必要

### MCP が Claude Code で認識されない

- `claude --version` で バージョン確認（MCP対応版か）
- `~/.claude/settings.json` の JSON 構文エラーチェック
- Claude Code の起動ログを確認

### npm install で エラー

- Node.js のバージョンが 20 以上か確認
- nvm use 20 で切り替え

---

## 関連リソース

- パッケージ: https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp
- GitHub: https://github.com/GongRzhe/Gmail-MCP-Server
- Model Context Protocol: https://modelcontextprotocol.io/

---

*次田芳尚 / NPO法人タダカヨ / 2026-05-26*
