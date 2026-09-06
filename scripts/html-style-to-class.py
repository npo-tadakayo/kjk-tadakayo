#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成済み HTML の style="..." を CSS クラスにまとめ直してサイズを落とす。

見た目は変えない。Google ドキュメント取り込みで <style> のクラスが効くかは
1本アップロードして目視で確かめること。
"""
import re
import sys
import pathlib

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
html = src.read_text(encoding="utf-8")

styles = {}
order = []


def repl(m):
    s = m.group(1)
    if s not in styles:
        styles[s] = f"s{len(styles)}"
        order.append(s)
    return f'class="{styles[s]}"'


body = re.sub(r'style="([^"]*)"', repl, html)
css = "".join(f".{styles[s]}{{{s}}}" for s in order)
body = body.replace("</head>", f"<style>{css}</style></head>")
dst.write_text(body, encoding="utf-8")
print(f"{src.name}: {len(html)} -> {len(body)} ({len(styles)} classes)")
