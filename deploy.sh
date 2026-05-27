#!/bin/bash
# タダカヨ kjk デプロイスクリプト
# 実行前に: firebase login:add で yoshinao-tsukuda@tadakayo.jp を追加しておくこと
# 初回デプロイ前: CRM_SETUP_GUIDE.md の手順を完了させること

set -e

# LP のみデプロイ（CRM 未セットアップ時）
if [ "$1" = "--lp-only" ]; then
  echo "=== LP のみデプロイ ==="
  firebase deploy --only hosting:lp --project kjk-tadakayo
  echo "https://kjk-tadakayo.web.app"
  exit 0
fi

# 全体デプロイ（LP + 管理画面 + Functions + Rules）
echo "=== タダカヨ kjk 全体デプロイ ==="
firebase deploy --project kjk-tadakayo
echo "=== デプロイ完了 ==="
echo "LP:   https://kjk-tadakayo.web.app"
echo "管理: https://kjk-tadakayo-admin.web.app"
