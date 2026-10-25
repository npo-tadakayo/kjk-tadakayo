#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""動画マニュアルの動画を共有ドライブ（正本）から Firebase Storage `training/` に置き直す。

使い方（タダカヨの gcloud 認証で）:
  zsh -ic 'gcp tadakayo && python3 scripts/sync-training-videos.py'                 # 全部
  zsh -ic 'gcp tadakayo && python3 scripts/sync-training-videos.py --only u5'       # 単元5だけ
  zsh -ic 'gcp tadakayo && python3 scripts/sync-training-videos.py --only g0 g1 g2 g3 annai --dry-run'

やること:
  1. 下の FILES に書いた最新版の mp4 と字幕の元（srt、または動画パイプラインの timeline.json）を取る
  2. mp4 は ffmpeg で `-movflags +faststart`（moov を先頭へ。再生がすぐ始まるように）。再エンコードはしない
  3. 字幕 → vtt（srt はカンマ→ピリオド。timeline.json は文ごとにまとめて作る）
  4. gs://kjk-tadakayo.firebasestorage.app/training/{名前}.mp4 / .vtt へアップロード（content-type と cache-control 付き）
  5. 終わったら admin/js/video-catalog.js の version / duration / updated を手で直す（このスクリプトは触らない）

前提: storage.rules の `training/` は @tadakayo.jp read（練習生も）・write false。アップロードは gcloud（バケット権限）で行う。
バケットの CORS（admin ドメイン 3つ）は 2026-09-06 に設定済み。変えるときは `gcloud storage buckets update --cors-file`。
"""
import argparse, json, os, pathlib, re, shutil, subprocess, sys, tempfile

DRIVE = pathlib.Path(os.path.expanduser("~/Library/CloudStorage/GoogleDrive-yoshinao-tsukuda@tadakayo.jp"))
TRAINING = DRIVE / "共有ドライブ/TM_介護情報基盤を広め隊/02_マニュアル・ガイドブック/研修動画"
CRM = TRAINING / "CRM操作説明_全7単元"
KIBAN = DRIVE / "マイドライブ/タダカヨ_project/06_介護情報基盤事業"
BUCKET = "gs://kjk-tadakayo.firebasestorage.app/training"

# Storage 上の名前 → (mp4, 字幕の元)。版を上げたらここを直す（video-catalog.js の file と同じ名前）
FILES = {f"crm-u{n}": (CRM / f"{b}.mp4", CRM / f"{b}.srt") for n, b in {
    1: "介護情報基盤CRM_単元1_はじめに_v1.2",
    2: "介護情報基盤CRM_単元2_案件を進める_v1.2",
    3: "介護情報基盤CRM_単元3_発注と出荷_v1.2",
    4: "介護情報基盤CRM_単元4_請求と領収_v1.2",
    5: "介護情報基盤CRM_単元5_認定事業者_v1.3",
    6: "介護情報基盤CRM_単元6_設定と管理_v1.2",
    7: "介護情報基盤CRM_単元7_伴走支援の記録_v1.2",
    8: "介護情報基盤CRM_単元8_Web申し込み_v1.2",
    9: "介護情報基盤CRM_単元9_10月の改修_v1.0",
    10: "介護情報基盤CRM_単元10_事業所の編集と統合_v1.0",
}.items()}
# 伴走支援ガイドブックの解説動画（2026-10-24 育成コースのために追加）
for p in range(4):
    b = TRAINING / f"介護情報基盤_伴走支援ガイドブック_PART{p}"
    FILES[f"guide-part{p}"] = (b.with_suffix(".mp4"), b.with_suffix(".srt"))
# 事業所向け「伴走支援のご案内」（共有ドライブに正本が無いので制作フォルダの完成品。字幕は timeline.json から作る）
_annai = KIBAN / "動画_事業所向け_伴走支援のご案内_20261013"
FILES["guide-annai"] = (_annai / "out.mp4", _annai / "timeline.json")
# 育成コース STEP1 の新しい動画（2026-10-24）。ご案内と同じく制作フォルダの完成品・字幕は timeline.json から作る
_intro = KIBAN / "動画_育成_伴走支援者になるまで_20261024"
FILES["learn-intro"] = (_intro / "out.mp4", _intro / "timeline.json")
_pledge = KIBAN / "動画_育成_伴走支援者の約束_20261024"
FILES["learn-pledge"] = (_pledge / "out.mp4", _pledge / "timeline.json")
# 育成コースの使い方（2026-10-25）。操作動画スキルの modern で作ったので字幕は映像に焼き込み済み → vtt は置かない（None）
_course = KIBAN / "動画_育成_コースの進め方_20261025"
FILES["learn-course"] = (_course / "out.mp4", None)
_trainer = KIBAN / "動画_育成_新人の見守り方_20261025"
FILES["learn-trainer"] = (_trainer / "out.mp4", None)
# --only の短い呼び名（u5・g0・annai・intro・pledge）
ALIAS = {**{f"u{n}": f"crm-u{n}" for n in range(1, 11)}, **{f"g{p}": f"guide-part{p}" for p in range(4)},
         "annai": "guide-annai", "intro": "learn-intro", "pledge": "learn-pledge",
         "course": "learn-course", "trainer": "learn-trainer"}


def ts(sec: float) -> str:
    ms = int(round(sec * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def srt_to_vtt(srt: str) -> str:
    body = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", srt)
    return "WEBVTT\n\n" + body.strip() + "\n"


def timeline_to_vtt(tl: dict) -> str:
    """動画パイプラインの timeline.json（場面ごとの長さ D と、句ごとの開始・終了 est）→ vtt。
    場面は番号順に連結されている（seg/list.txt の順）。句は「。」までを1つの字幕にまとめる。"""
    cues, offset = [], 0.0
    for key in sorted(tl):
        scene = tl[key]
        buf, start = "", None
        for ph in scene["est"]:
            if start is None:
                start = ph["s"]
            buf += ph["p"]
            if buf.endswith("。"):
                cues.append((offset + start, offset + ph["e"], buf))
                buf, start = "", None
        if buf:
            cues.append((offset + start, offset + scene["est"][-1]["e"], buf))
        offset += scene["D"]
    out = ["WEBVTT", ""]
    for i, (s, e, t) in enumerate(cues, 1):
        out += [str(i), f"{ts(s)} --> {ts(max(e, s + 0.8))}", t, ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="名前（crm-u5 / u5・guide-part0 / g0・annai・intro・pledge・course・trainer）。省略で全部")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    names = [ALIAS.get(x, x) for x in a.only] if a.only else list(FILES)
    unknown = [x for x in names if x not in FILES]
    if unknown:
        sys.exit(f"🔴 知らない名前: {unknown}（使える名前: {', '.join(FILES)}）")
    work = pathlib.Path(tempfile.mkdtemp(prefix="training-"))
    for name in names:
        mp4, sub = FILES[name]
        if not mp4.exists() or (sub is not None and not sub.exists()):
            sys.exit(f"🔴 正本が見つかりません: {mp4} / {sub}")
        out_mp4, out_vtt = work / f"{name}.mp4", work / f"{name}.vtt"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-c", "copy", "-movflags", "+faststart", str(out_mp4)], check=True)
        if sub is None:
            vtt = None  # 字幕が映像に焼き込み済み。vtt を付けると画面に字幕が二重に出る
        elif sub.suffix == ".json":
            vtt = timeline_to_vtt(json.loads(sub.read_text(encoding="utf-8")))
        else:
            vtt = srt_to_vtt(sub.read_text(encoding="utf-8"))
        if vtt is not None:
            out_vtt.write_text(vtt, encoding="utf-8")
        print(f"{name}: {mp4.name} → {out_mp4.stat().st_size // 1024} KB (faststart)" + (f" + vtt {vtt.count(' --> ')} 行" if vtt else "（字幕は焼き込み・vtt なし）"))
        if a.dry_run:
            continue
        subprocess.run(["gcloud", "storage", "cp", str(out_mp4), f"{BUCKET}/", "--content-type=video/mp4",
                        "--cache-control=private, max-age=86400"], check=True)
        if vtt is not None:
            subprocess.run(["gcloud", "storage", "cp", str(out_vtt), f"{BUCKET}/", "--content-type=text/vtt; charset=utf-8",
                            "--cache-control=private, max-age=86400"], check=True)
    if a.dry_run:
        print(f"（dry-run: 作業フォルダ {work} に残しています）")
    else:
        subprocess.run(["gcloud", "storage", "ls", "-l", f"{BUCKET}/"], check=False)
        shutil.rmtree(work, ignore_errors=True)
    print("✅ 完了。admin/js/video-catalog.js の version/duration/updated を確認して直すこと")


if __name__ == "__main__":
    main()
