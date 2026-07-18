# タダカヨの介護情報基盤伴走支援 LP / CRM 申し送り — 2026-07-18

> handoff-id: tadakayo
> サービス名: **タダカヨの介護情報基盤伴走支援**（サブ：タダサポ＋ シリーズ）
> 旧セッション（④〜⑬）の詳細は `HANDOFF_ARCHIVE.md` へ移動済み（2026-07-18）

---

## 現在の状態

- LP（https://kjk.tadakayo.jp）・CRM管理画面（https://kjk-tadakayo-admin.web.app）とも本番稼働中。
- **リポジトリは GitHub組織 `npo-tadakayo/kjk-tadakayo` に移譲済み**（2026-07-18・旧 tsuku-29/kjk-tadakayo はリダイレクト）。ローカル origin も新URLに更新済み。
- 未コミット0・全push済み（最新 `b0d637c`）。

## 今セッション（⑭・2026-07-02〜03 作業＋2026-07-18 移譲）でやったこと

- **領収書発行機能**（`e713f30`）: 入金済み出荷に「領収書」ボタン → `supply-print.html?type=receipt`。編集可能な明細（行追加・削除。Firestoreには保存しない印刷用一時編集）・助成金用途区分 A=カードリーダー / B=接続サポート等経費 / X=対象外(送料等) ごとの税込小計自動計算・但し書き編集・税込5万円以上で収入印紙欄・実印影 `admin/images/seal-tadakayo.png`（請求書も同印影に統一）。
- **帳票デザインをタダカヨ赤に統一**（同 `e713f30`）: supply-print / report のリブランド漏れ（旧・緑 `#238e3a`）を `#E33535` に。CSS疑似印の色を朱色 `#D3381C` に。Noto Serif/Sans JP webフォント読込追加。未定義だった `.btn-secondary` の定義追加（実バグ修正）。
- **CRMの赤を正本値へ統一**（`04c763a`）: crm.css を `#E03030`→`#E33535` / dark `#c02828` / soft `#FFE4EC`（ブランド指示書の正本値・WCAG AA計算済み）。LPは元々 `#E33535` で変更不要 → **LP・CRM・帳票の赤が一本化**。
- ドキュメント反映（`9d8c9b0`）: MANUAL.md / ENGINEERING_NOTES.md §16 / アプリ内 manual・engineering（§7に領収書仕様追記）。
- デプロイ: hosting:admin をプレビュー（`receipt-0702` → `brand-e33535-0703`）→ curl検証 → live昇格。本番配信確認済み。
- **リポジトリ移譲**: tsuku-29 個人 → 組織 `npo-tadakayo`（`gh api repos/.../transfer`・即時完了・承認待ちなし）。`git remote set-url origin https://github.com/npo-tadakayo/kjk-tadakayo.git` 済み・fetch疎通OK。
- （並行セッション分・push済み）LPブラッシュアップ `52b4286`〜`b0d637c`: 導入の流れ6ステップ・FAQ3問追加・Tablerフォント自己ホスト化・キャラ画像WebP化・キャラ画像の縦横比/キャッシュ/横潰れ修正。

## 次回やること（優先順）

1. **次田さんの実機確認（@tadakayo）**: 入金済み出荷で領収書を開く → 明細編集・行追加（伴走支援サポート費をB区分で）→ 区分別小計連動 → 印刷プレビューで編集枠が消えること。CRM全画面の新しい赤（アクティブナビ=ピンク地 `#FFE4EC`）の見え方確認。
2. **ドキュメント内の旧リポジトリパス一括置換**: `tsuku-29/kjk-tadakayo` → `npo-tadakayo/kjk-tadakayo`（HANDOFF_ARCHIVE / ENGINEERING_NOTES / memory 等。リダイレクトが効くため緊急ではない）。
3. （残タスク・アーカイブ参照）多田佳代ちゃんのCRM追加箇所（トースト等・やり過ぎ注意）／ Gemini 2.5→3 移行（2026-10-16 retire）／ firebase-functions + Node 22 更新（2026-10-30）。

## 重要な合意事項（蒸し返し禁止）

- **赤の正本は `#E33535`（タダカヨレッド）＋ `#FFE4EC`（ピンク）**（ブランド指示書）。セッション⑬の `#E03030` 案は 2026-07-03 に正本値へ統一して解消。白文字ボタン・ピンク面の文字は `#c02828`（コントラスト確保）。
- 領収書の明細編集は**印刷用の一時編集**（Firestore保存しない）で確定。
- 認定事業所卸は `appConfig.settings.partnerPricing`（非パススルー）・請求書送料は税抜換算1行計上（アーカイブ⑩⑫参照）。

## ハマりポイント・注意事項

- **push手順**: origin は `npo-tadakayo/kjk-tadakayo`（https）。gh のアクティブが `ytsukuda4470` だと403 → `gh auth switch -u tsuku-29` → push → `gh auth switch -u ytsukuda4470` で戻す。
- **firebase CLI**: このディレクトリは `firebase login:use yoshinao-tsukuda@tadakayo.jp` 設定済み。デプロイは rule05 二段階（`hosting:channel:deploy {ch} --only admin` → curl検証 → `hosting:clone …:live`）。
- firebase MCP は別プロジェクト接続のため kjk-tadakayo の Firestore 操作に使わない（ADC＋スクリプトで）。
- 帳票ページ（supply-print / report）は crm.css を読まない独立CSS。ブランド色を変える時は両方直す。

## 再開コマンド

cd ~/Projects/tadakayo/01_システム開発/tadakayo-kiban && claude

## 関連URL・リソース

- LP本番: https://kjk.tadakayo.jp ／ CRM本番: https://kjk-tadakayo-admin.web.app
- GitHub: https://github.com/npo-tadakayo/kjk-tadakayo
- 仕様書: `ENGINEERING_NOTES.md`（正本）／ `MANUAL.md` ／ アプリ内 `/manual` `/engineering`
- アクセス解析: Clarity `wax7x03bg8` ／ GA4 `G-V70326L8MW`（タダカヨ側プロパティ 541485334）
- 旧セッション詳細: `HANDOFF_ARCHIVE.md`
