#!/bin/bash
# 見積もり価格ロジックの正本（functions/estimate-pricing.js）と公開側コピー（js/estimate-pricing.js）が一致しているか。
# 違っていたら `cp functions/estimate-pricing.js js/estimate-pricing.js` で揃える（正本は functions 側）。
cd "$(dirname "$0")/.."
if cmp -s functions/estimate-pricing.js js/estimate-pricing.js; then echo "OK: estimate-pricing.js は一致"; else echo "NG: functions/estimate-pricing.js と js/estimate-pricing.js が違う。cp functions/estimate-pricing.js js/estimate-pricing.js" ; exit 1; fi
