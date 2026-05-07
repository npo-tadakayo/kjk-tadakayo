# タダサポ 介護情報基盤版 LP 申し送り — 2026-05-07（継続中）

> handoff-id: tadakayo

---

## 現在の状態

index.html 本体は完成。Firebase Hosting にデプロイ済み。
プレースホルダー3箇所（Formspree / Clarity / GA4）が未差し替えで、カスタムドメインのDNS設定待ち。

---

## 今セッションでやったこと

| コミット | 内容 |
|---|---|
| `70b1bd3` | PRICING.md 作成（全6パターン自己負担¥0） |
| `72536ed` | サービス名を「タダサポ 介護情報基盤版」にリブランド・価格を¥57,000(税別)に更新 |
| `a482372` | 製品写真を images/ フォルダに追加（CIR415A・CIR315A 各2枚 WebP） |
| `e664c3d` | キャラクター画像（chara_1〜11）追加・製品スペック修正（唯一の認定モデルバッジ等） |
| `1f12a22` | ヘッダーロゴを tadakayo_logo.png に差し替え（赤い「タ」バッジを廃止） |
| `7ba3c5b` | ロゴ画像の白背景を透過処理（Pillow） |
| `74a72d1` | キャラクター画像11枚の白背景を透過処理（Pillow） |
| `eda5676` | 助成金早見表：居住・入所系/その他にBT/USB両プランと¥0バッジを追加 |
| `39d9f31` | 助成金早見表：訪問・通所系にもBT/USB両プランを追加（3行統一） |

---

## 残タスク（優先順）

### 🔴 必須（公開前）

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

### 🟡 DNS（藤田さん対応待ち）

- [ ] **カスタムドメイン**: お名前.com で `kjk.tadakayo.jp` に CNAME レコードを追加
  - TYPE: CNAME / ホスト: `kjk` / VALUE: `kjk-tadakayo.web.app`
  - 担当: h.fujita@tadakayo.jp に依頼中

### 🟢 あとで

- [ ] ENGINEERING_NOTES.md の §13 進捗・§16 変更履歴を更新
- [ ] alt plans（居住・入所系 / その他）のプランカードをタダサポ本体カードと同様の詳細度に仕上げる
- [ ] OGP画像（og:image）の作成・設定

---

## 重要な合意事項（決定済み・蒸し返し禁止）

- サービス名: **タダサポ 介護情報基盤版**
- キャッチフレーズ: **「タダカヨのサポートだから、タダサポ。」**
- 価格設計: CIR415A ¥9,000/台 × 3台 ＋ サポート費 ¥30,000 = **¥57,000（税別）= ¥62,700（税込）**
- 助成金枠: 介護情報基盤助成金（定額型）を使用。ICT補助金（割合型）は不採用。
- 全6パターンすべて自己負担¥0設計（PRICING.md 参照）
- 単一HTMLファイル構成（index.html のみ）

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
| カスタムドメイン | https://kjk.tadakayo.jp（DNS設定待ち） |
| Firebase プロジェクト | kjk-tadakayo（yoshinao-tsukuda@tadakayo.jp） |
| GitHub | https://github.com/tsuku-29/kjk-tadakayo（tsuku-29） |
| ブランドカラー | #E33535（赤）/ #FFE4EC（ピンク） |
| フォント | Noto Sans JP |
| アイコン | Tabler Icons v3.24.0+ |
| キャラクター | images/chara_1〜11.png（背景透過済み） |
| ロゴ | images/tadakayo_logo.png（背景透過済み） |
| 製品画像 | images/cir415a_product/scene.webp, cir315a_product/scene.webp |

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
