#!/bin/bash
# 画面（admin）と Functions で共有する純粋関数のコピーが一致しているか（check-pricing-sync.sh と同じ方式）。
#   ・functions/first-contact.mjs … 初期連絡の超過判定。正本は admin/js/first-contact.js（画面の案件一覧と同じ判定を日次まとめで使う）
#   ・functions/office-merge.mjs … 事業所の編集・統合の判定。正本は admin/js/office-merge.js（画面の重複候補・練習モードと Functions の統合で同じ判定を使う）
#   ・functions/warehouse-rules.mjs … 倉庫の画面と倉庫の Callable の判定。正本は admin/js/warehouse-rules.js（2026-10-24）
#   ・functions/trainer-rules.mjs … トレーナー認定の判定。正本は admin/js/trainer-rules.js（2026-11-12）
#   ・functions/ship-steps-rules.mjs … 発送の5段（依頼→受付→確認→発送準備→発送完了）の判定。正本は admin/js/ship-steps-rules.js（2026-11-12）
#   ・functions/pm-discount.mjs … 伴走支援費の PM 値引きの判定。正本は admin/js/pm-discount.js（2026-11-13）
#     functions は CommonJS で ESM の admin 側を require できないため、拡張子だけ .mjs にしたバイト単位で同じコピーを置く。
# 違っていたら正本（admin 側）からコピーし直して揃える。
cd "$(dirname "$0")/.."
ok=1
if cmp -s admin/js/first-contact.js functions/first-contact.mjs; then
  echo "OK: admin/js/first-contact.js と functions/first-contact.mjs は一致"
else
  echo "NG: admin/js/first-contact.js と functions/first-contact.mjs が違う。cp admin/js/first-contact.js functions/first-contact.mjs"
  ok=0
fi
if cmp -s admin/js/office-merge.js functions/office-merge.mjs; then
  echo "OK: admin/js/office-merge.js と functions/office-merge.mjs は一致"
else
  echo "NG: admin/js/office-merge.js と functions/office-merge.mjs が違う。cp admin/js/office-merge.js functions/office-merge.mjs"
  ok=0
fi
if cmp -s admin/js/warehouse-rules.js functions/warehouse-rules.mjs; then
  echo "OK: admin/js/warehouse-rules.js と functions/warehouse-rules.mjs は一致"
else
  echo "NG: admin/js/warehouse-rules.js と functions/warehouse-rules.mjs が違う。cp admin/js/warehouse-rules.js functions/warehouse-rules.mjs"
  ok=0
fi
if cmp -s admin/js/trainer-rules.js functions/trainer-rules.mjs; then
  echo "OK: admin/js/trainer-rules.js と functions/trainer-rules.mjs は一致"
else
  echo "NG: admin/js/trainer-rules.js と functions/trainer-rules.mjs が違う。cp admin/js/trainer-rules.js functions/trainer-rules.mjs"
  ok=0
fi
if cmp -s admin/js/ship-steps-rules.js functions/ship-steps-rules.mjs; then
  echo "OK: admin/js/ship-steps-rules.js と functions/ship-steps-rules.mjs は一致"
else
  echo "NG: admin/js/ship-steps-rules.js と functions/ship-steps-rules.mjs が違う。cp admin/js/ship-steps-rules.js functions/ship-steps-rules.mjs"
  ok=0
fi
if cmp -s admin/js/pm-discount.js functions/pm-discount.mjs; then
  echo "OK: admin/js/pm-discount.js と functions/pm-discount.mjs は一致"
else
  echo "NG: admin/js/pm-discount.js と functions/pm-discount.mjs が違う。cp admin/js/pm-discount.js functions/pm-discount.mjs"
  ok=0
fi
[ "$ok" = "1" ] && exit 0 || exit 1
