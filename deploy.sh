#!/bin/bash
# 介護情報基盤LP デプロイスクリプト
# 実行前に: firebase login:add で yoshinao-tsukuda@tadakayo.jp を追加しておくこと

set -e

echo "=== 介護情報基盤LP デプロイ ==="
firebase deploy --only hosting --project kjk-tadakayo
echo "=== デプロイ完了 ==="
echo "https://kjk-tadakayo.web.app"
