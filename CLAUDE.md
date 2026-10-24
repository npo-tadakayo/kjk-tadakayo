# 介護情報基盤 伴走支援（tadakayo-kiban / CRM）— プロジェクトのルール

（親の `タダカヨ_project/CLAUDE.md` のルールに加えて、このプロジェクトだけの決めごと）

## Chat スペースの呼び名（2026-10-24 次田さん決定）

このプロジェクトで「PM」「TM」と言われたら、次の Chat スペースを指す。

| 呼び名 | スペース名 | space ID |
|---|---|---|
| **PM** | 介護情報基盤普及推進室_PM | `AAQAkcdopcA` |
| **TM** | TM_介護情報基盤普及推進室 | `AAQAsxvbafY` |

- 「PMに投稿」「PMを確認」＝上の PM、「TMに投稿」「TMを確認」＝上の TM。聞き返さない。
- 「OP」（`OP_出荷依頼`・`AAQATYcfc5E`）は出荷指示の自動投稿先。PM/TM とは別。
- 読む: `python3 ~/Projects/tadakayo/_tools/chat_read.py read <space ID> --days N`（スレッドの返信まで読む）
- 書く: `_tools/chat_write.py`（`--send` が要る。次田さん名義。文面は先に見せて了承を得てから送る）
