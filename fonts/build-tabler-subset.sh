#!/bin/bash
# Tabler Icons を「index.html / mitsumori.html で使用中のアイコンのみ」にサブセットして自己ホスト化する。
# アイコンを追加・変更したら再実行すること（表示されないアイコン＝サブセット漏れ）。
# 依存: python3 + fontTools（Noto サブセットと同じ環境で動く）
set -euo pipefail
cd "$(dirname "$0")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -sL -o "$TMP/tabler-icons.min.css" "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.24.0/dist/tabler-icons.min.css"
curl -sL -o "$TMP/tabler-icons.woff2" "https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.24.0/dist/fonts/tabler-icons.woff2"

TMP="$TMP" python3 << 'EOF'
import re, os
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

tmp = os.environ["TMP"]
used = set()
for f in ["../index.html", "../mitsumori.html"]:
    with open(f, encoding="utf-8") as fp:
        used |= set(re.findall(r'ti ti-([a-z0-9-]+)', fp.read()))

css = open(f"{tmp}/tabler-icons.min.css", encoding="utf-8").read()
mapping = dict(re.findall(r'\.ti-([a-z0-9-]+)::?before\{content:"\\([0-9a-f]+)"\}', css))
missing = used - set(mapping)
if missing:
    raise SystemExit(f"公式CSSに存在しないアイコン: {missing}")
sel = {n: mapping[n] for n in used}
print(f"{len(sel)} アイコンをサブセット")

lines = ["""@font-face {
  font-family: "tabler-icons";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("tabler-icons-subset.woff2") format("woff2");
}
.ti {
  font-family: "tabler-icons" !important;
  speak: never;
  font-style: normal;
  font-weight: normal;
  font-variant: normal;
  text-transform: none;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}"""]
for name in sorted(sel):
    lines.append(f'.ti-{name}:before {{ content: "\\{sel[name]}"; }}')
open("tabler-icons-subset.css", "w", encoding="utf-8").write("\n".join(lines) + "\n")

# GSUB/GPOS はリガチャ用で codepoint 参照には不要（残すと fontTools がエラーになる）
font = TTFont(f"{tmp}/tabler-icons.woff2")
for t in ("GSUB", "GPOS"):
    if t in font:
        del font[t]
opts = Options()
opts.flavor = "woff2"
opts.layout_features = []
ss = Subsetter(options=opts)
ss.populate(unicodes=[int(c, 16) for c in sel.values()])
ss.subset(font)
font.save("tabler-icons-subset.woff2")
print("完了:", os.path.getsize("tabler-icons-subset.woff2"), "bytes")
EOF
