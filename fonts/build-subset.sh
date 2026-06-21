#!/bin/bash
# Noto Sans JP 自己ホスト用サブセット生成（タダカヨ・Pマーク: Google CDN非経由）
# 対外HTML（index.html / mitsumori.html）で使う文字＋かな/英数/記号レンジに絞った
# 可変woff2（全ウェイト1ファイル）を fonts/NotoSansJP-subset.woff2 に出力する。
# ★対外HTMLの文言を追加・変更したら本スクリプトを再実行すること（新しい漢字がフォールバックになるのを防ぐ）。
#
# 必要: python3 + fontTools + brotli（無ければ: pip3 install fonttools brotli）
set -euo pipefail
cd "$(dirname "$0")/.."   # リポジトリルート（index.html がある場所）

SRC="${TMPDIR:-/tmp}/NotoSansJP[wght].ttf"
if [ ! -f "$SRC" ]; then
  echo "可変TTFを取得..."
  curl -s -L -o "$SRC" "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"
fi

USED="${TMPDIR:-/tmp}/tadakayo-used.txt"
python3 - "$USED" <<'PY'
import sys
chars=set()
for f in ["index.html","mitsumori.html"]:
    chars |= set(open(f, encoding="utf-8").read())
for c in ("\n","\r"): chars.discard(c)
open(sys.argv[1],"w",encoding="utf-8").write("".join(sorted(chars)))
print("ユニーク文字数:", len(chars))
PY

python3 -m fontTools.subset "$SRC" \
  --text-file="$USED" \
  --unicodes="U+0020-007F,U+00A0-00FF,U+2000-206F,U+2070-209F,U+20A0-20BF,U+2100-214F,U+2190-21FF,U+2460-24FF,U+25A0-25FF,U+2600-26FF,U+3000-303F,U+3040-309F,U+30A0-30FF,U+FF00-FFEF" \
  --layout-features='*' --flavor=woff2 \
  --output-file=fonts/NotoSansJP-subset.woff2

ls -l fonts/NotoSansJP-subset.woff2 | awk '{printf "出力: %s (%d KB)\n", $NF, $5/1024}'
echo "完了。index.html / mitsumori.html は fonts/NotoSansJP-subset.woff2 を @font-face で参照。"
