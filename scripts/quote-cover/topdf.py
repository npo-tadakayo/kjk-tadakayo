#!/usr/bin/env python3
"""build.mjs が出した HTML を A4横の PDF にする（Playwright / Chromium）。
   python3 scripts/quote-cover/topdf.py 入力.html 出力.pdf
Web フォント（Noto Sans JP / Noto Serif JP）の読み込みを待ってから印刷する。
"""
import sys, os, pathlib
from playwright.sync_api import sync_playwright

src, dst = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    exe = os.environ.get("CHROME_EXE")  # 例: ~/Library/Caches/ms-playwright/chromium_headless_shell-*/…/chrome-headless-shell か Google Chrome.app 本体
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    pg = b.new_page(viewport={"width": 1123, "height": 794})
    pg.goto(pathlib.Path(src).resolve().as_uri(), wait_until="networkidle")
    pg.evaluate("document.fonts.ready")
    pg.wait_for_timeout(800)
    pg.pdf(path=dst, width="297mm", height="210mm", print_background=True,
           margin={"top": "0", "right": "0", "bottom": "0", "left": "0"}, prefer_css_page_size=False)
    b.close()
print("wrote", dst)
