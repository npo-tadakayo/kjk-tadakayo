// 案件の見出しに出す事業所の住所（admin/js/case-detail-util.js の officeAddressText / mapsSearchUrl）のテスト。
// node scripts/test-case-address.mjs
import assert from "node:assert/strict";
import { officeAddressText, mapsSearchUrl } from "../admin/js/case-detail-util.js";

let n = 0;
const t = (name, fn) => { fn(); n++; };

t("address と郵便番号", () => {
  assert.equal(officeAddressText({ address: "宮崎県児湯郡新富町大字上富田3349-1", postalCode: "889-1403" }), "〒889-1403 宮崎県児湯郡新富町大字上富田3349-1");
});
t("郵便番号なし", () => {
  assert.equal(officeAddressText({ address: "沖縄県那覇市銘苅3-20-22" }), "沖縄県那覇市銘苅3-20-22");
});
t("address が無ければ都道府県・市区町村・番地から組み立てる", () => {
  assert.equal(officeAddressText({ prefecture: "沖縄県", city: "中頭郡北中城村", addressDetail: "渡口473-4 1F" }), "沖縄県中頭郡北中城村渡口473-4 1F");
});
t("住所が無ければ空（郵便番号だけでも空）", () => {
  assert.equal(officeAddressText({}), "");
  assert.equal(officeAddressText({ postalCode: "900-0001" }), "");
  assert.equal(officeAddressText(null), "");
  assert.equal(officeAddressText({ address: "   " }), "");
});
t("地図のURLは郵便番号を外して検索する", () => {
  const u = mapsSearchUrl("〒889-1403 宮崎県児湯郡新富町大字上富田3349-1");
  assert.ok(u.startsWith("https://www.google.com/maps/search/?api=1&query="));
  assert.equal(decodeURIComponent(u.split("query=")[1]), "宮崎県児湯郡新富町大字上富田3349-1");
});
t("住所が空なら地図のURLも空", () => {
  assert.equal(mapsSearchUrl(""), "");
});

console.log(`OK test-case-address: ${n} 件合格`);
