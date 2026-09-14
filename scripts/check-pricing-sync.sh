#!/bin/bash
# 見積もり価格ロジックの正本（functions/estimate-pricing.js）と各コピーが一致しているか。
#   ・js/estimate-pricing.js       … 公開サイト（mitsumori.html）用コピー
#   ・admin/js/estimate-pricing.js … 供給管理（admin/supply.html）用コピー
# 違っていたら正本からコピーし直して揃える（正本は functions 側）。
cd "$(dirname "$0")/.."
ok=1
if cmp -s functions/estimate-pricing.js js/estimate-pricing.js; then
  echo "OK: functions/estimate-pricing.js と js/estimate-pricing.js は一致"
else
  echo "NG: functions/estimate-pricing.js と js/estimate-pricing.js が違う。cp functions/estimate-pricing.js js/estimate-pricing.js"
  ok=0
fi
if cmp -s functions/estimate-pricing.js admin/js/estimate-pricing.js; then
  echo "OK: functions/estimate-pricing.js と admin/js/estimate-pricing.js は一致"
else
  echo "NG: functions/estimate-pricing.js と admin/js/estimate-pricing.js が違う。cp functions/estimate-pricing.js admin/js/estimate-pricing.js"
  ok=0
fi
[ "$ok" = "1" ] && exit 0 || exit 1
