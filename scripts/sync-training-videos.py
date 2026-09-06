#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""動画マニュアルの動画を共有ドライブ（正本）から Firebase Storage `training/` に置き直す。

使い方（タダカヨの gcloud 認証で）:
  zsh -ic 'gcp tadakayo && python3 scripts/sync-training-videos.py'          # 全8本
  zsh -ic 'gcp tadakayo && python3 scripts/sync-training-videos.py --only 5'  # 単元5だけ

やること:
  1. 共有ドライブ「研修動画/CRM操作説明_全7単元/」から、下の FILES に書いた最新版の mp4/srt を取る
  2. mp4 は ffmpeg で `-movflags +faststart`（moov を先頭へ。再生がすぐ始まるように）。再エンコードはしない
  3. srt → vtt（WEBVTT ヘッダ＋カンマ→ピリオド）
  4. gs://kjk-tadakayo.firebasestorage.app/training/crm-u{n}.mp4 / .vtt へアップロード（content-type と cache-control 付き）
  5. 終わったら admin/js/video-catalog.js の version / duration / updated を手で直す（このスクリプトは触らない）

前提: storage.rules の `training/` は @tadakayo.jp read・write false。アップロードは gcloud（バケット権限）で行う。
バケットの CORS（admin ドメイン 3つ）は 2026-09-06 に設定済み。変えるときは `gcloud storage buckets update --cors-file`。
"""
import argparse, os, pathlib, re, shutil, subprocess, sys, tempfile

SRC = pathlib.Path(os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp/共有ドライブ/"
    "TM_介護情報基盤を広め隊/02_マニュアル・ガイドブック/研修動画/CRM操作説明_全7単元"))
BUCKET = "gs://kjk-tadakayo.firebasestorage.app/training"
# 単元番号 → 共有ドライブ上のファイル名（拡張子なし）。版を上げたらここを直す
FILES = {
    1: "介護情報基盤CRM_単元1_はじめに_v1.0",
    2: "介護情報基盤CRM_単元2_案件を進める_v1.0",
    3: "介護情報基盤CRM_単元3_発注と出荷_v1.0",
    4: "介護情報基盤CRM_単元4_請求と領収_v1.0",
    5: "介護情報基盤CRM_単元5_認定事業者_v1.2",
    6: "介護情報基盤CRM_単元6_設定と管理_v1.0",
    7: "介護情報基盤CRM_単元7_伴走支援の記録_v1.0",
    8: "介護情報基盤CRM_単元8_Web申し込み_v1.0",
}


def srt_to_vtt(srt: str) -> str:
    body = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", srt)
    return "WEBVTT\n\n" + body.strip() + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=int, nargs="*", help="単元番号（省略で全部）")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    nums = a.only or sorted(FILES)
    work = pathlib.Path(tempfile.mkdtemp(prefix="training-"))
    for n in nums:
        base = FILES[n]
        mp4, srt = SRC / f"{base}.mp4", SRC / f"{base}.srt"
        if not mp4.exists() or not srt.exists():
            sys.exit(f"🔴 正本が見つかりません: {mp4} / {srt}")
        out_mp4, out_vtt = work / f"crm-u{n}.mp4", work / f"crm-u{n}.vtt"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-c", "copy", "-movflags", "+faststart", str(out_mp4)], check=True)
        out_vtt.write_text(srt_to_vtt(srt.read_text(encoding="utf-8")), encoding="utf-8")
        print(f"u{n}: {base} → {out_mp4.stat().st_size // 1024} KB (faststart) + vtt")
        if a.dry_run:
            continue
        subprocess.run(["gcloud", "storage", "cp", str(out_mp4), f"{BUCKET}/", "--content-type=video/mp4",
                        "--cache-control=private, max-age=86400"], check=True)
        subprocess.run(["gcloud", "storage", "cp", str(out_vtt), f"{BUCKET}/", "--content-type=text/vtt; charset=utf-8",
                        "--cache-control=private, max-age=86400"], check=True)
    if not a.dry_run:
        subprocess.run(["gcloud", "storage", "ls", "-l", f"{BUCKET}/"], check=False)
    shutil.rmtree(work, ignore_errors=True)
    print("✅ 完了。admin/js/video-catalog.js の version/duration/updated を確認して直すこと")


if __name__ == "__main__":
    main()
