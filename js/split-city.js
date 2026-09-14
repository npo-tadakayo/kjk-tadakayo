// zipcloud の address2（市区町村）を「市」と「区」に分ける。LP（index.html）と見積もりツール（mitsumori.html）で共通。
// 例: "札幌市中央区" → { city: "札幌市", wardPrefix: "中央区" }（区は住所欄が空のときだけ補う）。
// 政令市以外・区が無い場合はそのまま city に入れる。
function splitCity(address2) {
  const m = String(address2 || '').match(/^(.+市)(.+区)$/);
  if (m) return { city: m[1], wardPrefix: m[2] };
  return { city: address2 || '', wardPrefix: '' };
}
window.splitCity = splitCity;
