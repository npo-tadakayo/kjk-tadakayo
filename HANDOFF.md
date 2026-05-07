# タダサポ 介護情報基盤版 LP 申し送り — 2026-05-08（実質完成）

> handoff-id: tadakayo

---

## 現在の状態

LP 本体・SEO・フォーム・アナリティクスすべて設定済み。本番稼働中。
コード作業は実質完了。残りは運用・広報対応のみ。

---

## 今セッションでやったこと

| 作業 | 内容 | コミット |
|---|---|---|
| フォームメールフィールド修正 | name="email" 修正・送信テスト完了 | 2b6beb2 |
| Google Search Console | HTML ファイル認証・sitemap.xml 送信済み | - |
| 構造化データ JSON-LD | Organization / Service / WebPage / FAQPage スキーマ追加 | 843ced5 |
| パフォーマンス改善 | フォント・Tabler Icons 非同期化・画像 lazy load / fetchpriority | 6ee21e9 |
| FAQPage スキーマ | 既存FAQ5問をリッチリザルト対応 → テスト合格 | 43966c1 |
| PageSpeed 改善結果 | モバイル 55 → 87（FCP 12.1秒 → 1.2秒） | - |

---

## 残タスク（コード作業なし・運用のみ）

### 広報担当への依頼（送付済み）
- [ ] tadakayo.jp 本体サイトの「事業紹介」等に kjk.tadakayo.jp へのリンク追加
- [ ] SNS で kjk.tadakayo.jp をシェア投稿（インデックス促進）

### 1〜2週間後に確認
- [ ] Search Console で検索表示・クリック数を確認
- [ ] Clarity・GA4 でアクセスデータ確認
- [ ] Formspree でお問い合わせ受信状況確認
- [ ] Google ビジネスプロフィール登録（NPO法人タダカヨ）

---

## SEO 対策 完了ステータス

| 項目 | 状態 |
|---|---|
| canonical / sitemap.xml / robots.txt | 完了 |
| OGP 画像・タグ | 完了 |
| Google Search Console 登録・認証 | 完了 |
| 構造化データ（JSON-LD） | 完了 |
| FAQPage リッチリザルト | 完了（テスト合格） |
| PageSpeed モバイル | 87点（FCP 1.2秒） |
| Microsoft Clarity | wax7x03bg8 設定済み |
| GA4 | G-0NZY6PM3FG 設定済み |
| Formspree フォーム | xjglevjk・送信テスト完了 |

---

## 重要な合意事項（決定済み・蒸し返し禁止）

- サービス名: **タダサポ 介護情報基盤版**
- キャッチフレーズ: **「タダカヨのサポートだから、タダサポ。」**
- 価格設計: CIR415A ¥9,000/台 × 3台 ＋ サポート費 ¥30,000 = **¥57,000（税別）= ¥62,700（税込）**
- 助成金枠: 介護情報基盤助成金（定額型）を使用
- 全6パターンすべて自己負担¥0設計
- 単一HTMLファイル構成（LP は index.html のみ）

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
# PAT は Claude のメモリ（feedback_deploy.md）に保存済み
```

### Formspree
- フォーム ID: `xjglevjk` / 送信先: kjk@tadakayo.jp
- email フィールドは必ず `name="email"`（日本語名だと Formspree が認識しない）

### Google Search Console
- 認証ファイル `google1d7d28761b295e68.html` を削除しないこと

---

## 技術構成

| 項目 | 値 |
|---|---|
| 本番 URL | https://kjk.tadakayo.jp |
| Firebase プロジェクト | kjk-tadakayo（yoshinao-tsukuda@tadakayo.jp） |
| GitHub | https://github.com/tsuku-29/kjk-tadakayo（tsuku-29） |
| Formspree | xjglevjk |
| Clarity | wax7x03bg8 |
| GA4 | G-0NZY6PM3FG |

---

## 再開コマンド

```bash
cd ~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp/マイドライブ/開発/tadakiayo-kiban
```
