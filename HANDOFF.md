# タダサポ 介護情報基盤版 LP 申し送り — 2026-05-08（継続中）

> handoff-id: tadakayo

---

## 現在の状態

index.html 本体は完成・本番稼働中。SEO基盤・フォーム・OGP・Search Console すべて設定済み。
カスタムドメイン `kjk.tadakayo.jp` は稼働中（SSL証明書有効）。
フォーム送信テストも完了（2026-05-08 確認）。

---

## 今セッションでやったこと

| 作業 | 内容 | コミット |
|---|---|---|
| Formspree フォーム設定 | form ID `xjglevjk` を index.html に設定、送信先 kjk@tadakayo.jp | - |
| Clarity / GA4 差し替え | `wax7x03bg8` / `G-0NZY6PM3FG` に設定済み | - |
| OGP 画像生成・タグ追加 | images/ogp.png（1200×630px）生成・og:image/twitter:card タグ追加 | - |
| SEO 基盤整備 | sitemap.xml / robots.txt 追加・canonical タグ追加 | - |
| Google Search Console 登録 | kjk.tadakayo.jp 認証完了（HTML ファイル方式）・sitemap.xml 送信済み | - |
| フォームメールフィールド修正 | name="メールアドレス" → name="email"（Formspree が認識できなかった） | 2b6beb2 |
| フォーム送信テスト完了 | 「送信できました！」表示確認（2026-05-08） | - |

---

## 残タスク（優先順）

### 🟢 軽微な改善（任意）

- [ ] alt plans（居住・入所系 / その他）のプランカードをタダサポ本体カードと同様の詳細度に仕上げる
- [ ] ENGINEERING_NOTES.md の §13 進捗・§16 変更履歴を更新

### 📊 運用・モニタリング

- [ ] Clarity（wax7x03bg8）でヒートマップ確認（数日後以降）
- [ ] GA4（G-0NZY6PM3FG）でアクセス確認
- [ ] Search Console でインデックス状況確認（1〜数日後）
- [ ] Formspree（xjglevjk）で問い合わせ受信確認

---

## 重要な合意事項（決定済み・蒸し返し禁止）

- サービス名: **タダサポ 介護情報基盤版**
- キャッチフレーズ: **「タダカヨのサポートだから、タダサポ。」**
- 価格設計: CIR415A ¥9,000/台 × 3台 ＋ サポート費 ¥30,000 = **¥57,000（税別）= ¥62,700（税込）**
- 助成金枠: 介護情報基盤助成金（定額型）を使用。ICT補助金（割合型）は不採用。
- 全6パターンすべて自己負担¥0設計（PRICING.md 参照）
- 単一HTMLファイル構成（LP は index.html のみ）
- 見積書ツール: mitsumori.html（スタンドアロン・サーバー不要）
- 補助金申請サポートは¥0（無料）、伴走支援費は事業所種別別（¥28,000〜¥31,000税別）

---

## ハマりポイント・注意事項

### Firebase デプロイ
```bash
# Node 20 必須（v18 だと Firebase CLI v15 がエラー）
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh" && nvm use 20
bash deploy.sh
```

### GitHub Push
```bash
# macOS Keychain が別アカウントを掴むので PAT を URL に直接埋め込む
# PAT は Claude のメモリ（feedback_deploy.md）に保存済み
git push "https://<PAT>@github.com/tsuku-29/kjk-tadakayo.git" main
```

### Formspree フォーム
- フォーム ID: `xjglevjk`
- 送信先: kjk@tadakayo.jp（yoshinao-tsukuda@tadakayo.jp で管理）
- 注意: email フィールドは必ず `name="email"` にする（日本語名だと Formspree が認識しない）

### Google Search Console
- 認証方法: HTML ファイル（`google1d7d28761b295e68.html`）→ Firebase に永続配置
- 認証ファイルを削除しないこと

### 画像背景透過処理（Pillow）
```python
from PIL import Image
import numpy as np
img = Image.open("target.png").convert("RGBA")
data = np.array(img)
white = (data[:,:,0] > 235) & (data[:,:,1] > 235) & (data[:,:,2] > 235)
data[white, 3] = 0
Image.fromarray(data).save("target.png")
```

---

## 技術構成（現時点）

| 項目 | 値 |
|---|---|
| 本番 URL | https://kjk.tadakayo.jp |
| Firebase プロジェクト | kjk-tadakayo（yoshinao-tsukuda@tadakayo.jp） |
| GitHub | https://github.com/tsuku-29/kjk-tadakayo（tsuku-29） |
| Formspree | xjglevjk（yoshinao-tsukuda@tadakayo.jp） |
| Microsoft Clarity | wax7x03bg8 |
| GA4 | G-0NZY6PM3FG |
| Search Console | 登録・認証済み・sitemap 送信済み |
| ブランドカラー | #E33535（赤）/ #FFE4EC（ピンク） |
| フォント | Noto Sans JP |
| アイコン | Tabler Icons v3.24.0+ |

---

## 再開コマンド

```bash
cd ~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp/マイドライブ/開発/tadakiayo-kiban
# または
cd ~/Projects/tadakayo/tadakiayo-kiban
```

---

## 関連リソース

- 料金設計書: [PRICING.md](./PRICING.md)
- エンジニアノート: [ENGINEERING_NOTES.md](./ENGINEERING_NOTES.md)
- Firebase Console: https://console.firebase.google.com/project/kjk-tadakayo/overview
- Formspree: https://formspree.io/forms/xjglevjk
- Search Console: https://search.google.com/search-console?resource_id=https%3A%2F%2Fkjk.tadakayo.jp%2F
