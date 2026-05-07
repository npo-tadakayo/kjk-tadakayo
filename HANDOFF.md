# タダサポ 介護情報基盤版 LP 申し送り — 2026-05-08（継続中）

> handoff-id: tadakayo

---

## 現在の状態

index.html 本体は完成。Firebase Hosting にデプロイ済み。
カスタムドメイン `kjk.tadakayo.jp` の CNAME 設定・Firebase 登録が完了し、SSL 証明書発行中（数時間で完了）。
プレースホルダー3箇所（Formspree / Clarity / GA4）が未差し替え。

---

## 今セッションでやったこと

| 作業 | 内容 |
|---|---|
| WCAG 2.1 AA アクセシビリティ修正 | スキップリンク・`<main>`・`<nav>`・`:focus-visible`・`aria-invalid`・`aria-live`・`scope="col"`・`role="status"` |
| タダカヨ認定事業所セクション追加 | `#certified` セクション新設・株式会社２７９（#001）カード追加 |
| Firebase Hosting デプロイ | コミット `d0c02c` にて本番反映済み |
| カスタムドメイン DNS 設定 | GMO レンタルサーバー CP（cp.onamae.ne.jp）で CNAME 追加：`kjk.tadakayo.jp → kjk-tadakayo.web.app` |
| Firebase カスタムドメイン登録 | Firebase Console でクイックセットアップ完了・SSL 証明書発行中 |

---

## 残タスク（優先順）

### 🔴 必須（フォームが機能しない）

- [ ] **Formspree**: https://formspree.io でフォームを作成 → `index.html` の `PLACEHOLDER` を実IDに差し替え
  ```bash
  grep -n "PLACEHOLDER" index.html
  # → action="https://formspree.io/f/PLACEHOLDER" の箇所
  ```

- [ ] **Microsoft Clarity**: `CLARITY_PROJECT_ID` を `wax7x03bg8` に差し替え
  ```bash
  sed -i '' 's/CLARITY_PROJECT_ID/wax7x03bg8/g' index.html
  ```

- [ ] **GA4**: `G-XXXXXXXXXX` を `G-0NZY6PM3FG` に差し替え
  ```bash
  sed -i '' 's/G-XXXXXXXXXX/G-0NZY6PM3FG/g' index.html
  ```

### 🟡 SSL（自動完了待ち）

- [ ] **SSL 証明書**: Firebase が自動発行中。完了すると `kjk.tadakayo.jp` で🔒マーク表示。確認コマンド：
  ```bash
  curl -I https://kjk.tadakayo.jp
  # → HTTP/2 200 になれば完了
  ```

### 🟢 あとで

- [ ] ENGINEERING_NOTES.md の §13 進捗・§16 変更履歴を更新
- [ ] alt plans（居住・入所系 / その他）のプランカードをタダサポ本体カードと同様の詳細度に仕上げる
- [ ] OGP画像（og:image）の作成・設定
- [ ] mitsumori.html を Firebase Hosting にデプロイして本番URLで動作確認

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

### 画像背景透過処理（Pillow）
```python
# 白背景（RGB > 235）を透明化する共通レシピ
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
| 本番 URL | https://kjk-tadakayo.web.app |
| カスタムドメイン | https://kjk.tadakayo.jp（SSL証明書発行中・まもなく有効） |
| Firebase プロジェクト | kjk-tadakayo（yoshinao-tsukuda@tadakayo.jp） |
| GitHub | https://github.com/tsuku-29/kjk-tadakayo（tsuku-29） |
| ブランドカラー | #E33535（赤）/ #FFE4EC（ピンク） |
| フォント | Noto Sans JP |
| アイコン | Tabler Icons v3.24.0+ |
| キャラクター | images/chara_1〜11.png（背景透過済み） |
| ロゴ | images/tadakayo_logo.png（背景透過済み） |
| 製品画像 | images/cir415a_product/scene.webp, cir315a_product/scene.webp |
| 印鑑 | images/hanko.png（黒背景透過済み） |
| 見積書ツール | mitsumori.html（サーバー不要・静的HTML） |

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
- AB Circle 製品ページ: 参照資料は `ABサークル様資料/` フォルダ内
