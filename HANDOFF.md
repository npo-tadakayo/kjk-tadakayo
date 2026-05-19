# タダサポ＋ LP 申し送り — 2026-05-15（名称変更・新価格反映・見積書ツール改修）

> handoff-id: tadakayo

---

## 現在の状態

LP（kjk.tadakayo.jp）と見積書作成ツール（kjk.tadakayo.jp/mitsumori.html）を「タダサポ＋」ブランドへ全面リブランド完了。新価格テーブル（補助金上限ぴったり方式）反映済み。

---

## 今セッションでやったこと（2026-05-15）

| 作業 | 成果物 | コミット |
|---|---|---|
| 「タダサポ」→「タダサポ＋」全置換 | index.html, mitsumori.html | d617f7d |
| LP 料金欄を新価格テーブルで復活 | index.html | d617f7d |
| 見積書ツール 連絡先必須化＋メール送信機能削除 | mitsumori.html | d617f7d |
| Google Chat Webhook 通知実装（PDFダウンロード時） | mitsumori.html | d617f7d |

---

## 確定した価格設計（補助金上限ぴったり方式）

### カードリーダー（税込・定価）
- BT CIR415A: **¥14,500/台**
- USB CIR315A: **¥5,000/台**

### 伴走支援費（税込・補助対象台数別）
- 1台構成: **¥60,000**
- 2台構成: **¥55,000**
- 3台構成: **¥50,000**

### 特別割引（出精値引き）
- 計算式: `特別割引 = CR定価合計 + 伴走支援費 − 補助金上限`
- 全パターンで「**合計＝補助金上限＝自己負担¥0**」を実現

### 補助金上限（サービス種別別）
| 種別 | 上限 | 最大台数 |
|---|---|---|
| 訪問・通所・短期滞在系 | ¥64,000 | 3台 |
| 居住・入所系 | ¥55,000 | 2台 |
| その他（居宅介護支援等） | ¥42,000 | 1台 |

---

## 見積書ツールの主な変更点

### 入力フォーム（必須項目を拡張）
- 法人名・事業所名（必須）
- ご担当者名（必須・新規）
- 電話番号（必須・新規）
- メールアドレス（必須・新規）
- 住所（任意・新規）

### 機能
- PDFダウンロード前にバリデーション → 必須未入力時はエラー表示
- ダウンロード時に Google Chat Webhook で通知
  - Webhook URL: `https://chat.googleapis.com/v1/spaces/AAQAkcdopcA/messages?key=...&token=...`
  - 通知内容: 見積番号 / 事業所名 / 担当者 / 連絡先 / 構成 / 合計 / 特別割引 / 自己負担
- メール送信モーダル機能は削除（ダウンロード形式に統一）

### ⚠️ 既知の制約（要注意）
- Webhook URL（key/token）が JS に直接埋め込まれているため、ブラウザのDevToolsで見える状態。
- 漏洩したURLからスパム投稿される可能性あり → 漏洩時は Google Chat スペース管理画面で Webhook を再発行 → mitsumori.html の `WEBHOOK_URL` 定数を差し替え。

---

## 議事録ベースの決定事項（2026-05-19議事録より）

- ✅ 事業名称: **タダサポ＋** で確定
- ✅ LP に料金復活（議事録の「料金外す」決定を上書きする方針で次田さん承認）
- ✅ 見積もり: メール送信廃止 → ダウンロード形式に統一
- ✅ Webhook通知（依頼受領通知）
- ⏳ パイロット運用 30事業所（8月まで）
- ⏳ 大分・別府市視察（6/29候補）

---

## 次セッションでやること（優先順）

1. **本番動作確認**: タダサポ＋表記・新価格・見積書ダウンロード・Webhook通知の実機テスト
2. **Webhook通知のテスト送信**: 実際に見積書ツールでダウンロードしてGoogle Chatに通知が届くか確認
3. **協定書ドラフトの法務確認**（弁護士・税理士） — handoff前回からの継続
4. **認定事業所向け資料の準備** — 議事録：「認定事業所の掲示に必要な内容」を藤田さん/蜂須賀さんに依頼
5. **業者ではない旨を伝える文書**（議事録より）— 見積書添付用テキスト整備

---

## 重要な合意事項（決定済み・蒸し返し禁止）

- サービス名: **タダサポ＋**（介護情報基盤対応・有償・都度型）
- 無償版「タダサポ」（介護情報基盤以外）は別事業として継続
- カードリーダー定価: BT ¥14,500 / USB ¥5,000（税込・AB Circle Japan の意向で市場相場準拠）
- 伴走支援費は補助金上限に合わせて高めに設定（1台¥60k/2台¥55k/3台¥50k 税込）
- 「特別割引（出精値引き）」で補助金上限ぴったりに調整
- 寄付バックは任意推奨型
- 単一HTMLファイル構成（LP は index.html / 見積書ツールは mitsumori.html）

---

## 未決事項

- [ ] Bluetooth 3台導入時の現地支援の可否（オンラインのみ vs タダメン現地）
- [ ] カードリーダーの仕入れ方法（デポジット制 vs 発注分前払い・31台以上の大量仕入れ価格）
- [ ] 「タダサポ」と「タダサポ＋」の有料サポート（講師派遣など）の線引き
- [ ] 認定NPO法人申請のタイムライン
- [ ] LP 夜間メンテナンスモード化の対応（議事録の決定事項 / 未実施）

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
# PAT は memory/feedback_deploy.md に保存済み（2026-08-06まで有効）
```

### Webhook 通知の動作確認
ブラウザのコンソールで以下を実行すると、`no-cors`モードのためレスポンス本文は読めないが、Network タブで `messages` POST が 200 で返ることを確認可能：
```javascript
fetch(WEBHOOK_URL, { method: 'POST', mode: 'no-cors', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text: 'テスト通知'}) })
```

---

## 技術構成

| 項目 | 値 |
|---|---|
| 本番 URL | https://kjk.tadakayo.jp |
| 見積書ツール | https://kjk.tadakayo.jp/mitsumori.html |
| Firebase プロジェクト | kjk-tadakayo（yoshinao-tsukuda@tadakayo.jp） |
| GitHub | https://github.com/tsuku-29/kjk-tadakayo（tsuku-29） |
| Formspree（問い合わせ） | xjglevjk |
| Google Chat Webhook（見積書通知） | スペース AAQAkcdopcA |
| Clarity | wax7x03bg8 |
| GA4 | G-0NZY6PM3FG |

---

## 再開コマンド

```bash
cd ~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp/マイドライブ/開発/tadakiayo-kiban
```
