// 供給（発注・出荷）の価格・送料の定数とロジック（state非依存の純粋関数）。
// supply.js から切り出し（C2 / 挙動不変）。appConfig や DOM に依存しないものだけをここに置く。

// AB Circle 送料表（税別・全国送料一覧 離島込み・発注用）。memory reference_abcircle と一致させること
export const SHIPPING_FEES = [
  { region:"北海道", fee:1500, note:"北海道" },
  { region:"北東北", fee:1000, note:"青森・岩手・秋田" },
  { region:"南東北", fee:1000, note:"宮城・山形・福島" },
  { region:"関東", fee:900, note:"東京・神奈川・千葉・埼玉・茨城・栃木・群馬" },
  { region:"甲信越", fee:1000, note:"山梨・新潟・長野" },
  { region:"北陸・中部", fee:1000, note:"富山・石川・福井・静岡・愛知・岐阜・三重" },
  { region:"関西", fee:1100, note:"大阪・京都・兵庫・奈良・滋賀・和歌山" },
  { region:"中国・四国", fee:1200, note:"広島・岡山・山口・鳥取・島根・香川・愛媛・高知・徳島" },
  { region:"九州", fee:1300, note:"福岡・佐賀・長崎・熊本・大分・宮崎・鹿児島" },
  { region:"沖縄", fee:1500, note:"沖縄" },
  { region:"その他離島", fee:2500, note:"離島" },
];

// 数量帯別の卸単価（AB Circle価格表: 1台 / 2-10台 / 11-30台 / 31台以上）
export function unitPriceFor(p, qty){
  if(!p) return 0;
  if(qty>=31) return Number(p.wholesale31 ?? p.wholesale11_30 ?? p.wholesale2_10 ?? 0);
  if(qty>=11) return Number(p.wholesale11_30 ?? p.wholesale2_10 ?? 0);
  if(qty>=2)  return Number(p.wholesale2_10 ?? 0);
  return Number(p.wholesale1 ?? p.wholesale2_10 ?? 0);
}

// 認定事業所卸の数量帯index（partnerPricing配列の並び: [1台, 2〜10台, 11〜30台, 31台〜]）
export function partnerTierIndex(qty){
  if(qty>=31) return 3;
  if(qty>=11) return 2;
  if(qty>=2)  return 1;
  return 0;
}

// 出荷の送料デフォルト（appConfig 未設定時のフォールバック。pricing.html と一致させること）
export const LETTERPACK_FEE_DEF = 600;
export const YUPACK_SIZES_DEF = ["60","80","100","120","140","160","170"];
export const YUPACK_REGIONS_DEF = ["近畿","北陸・東海・中国","関東・信越・四国・九州","東北","北海道","沖縄"];
export const YUPACK_ROWS_DEF = {
  "60":[820,920,1020,1120,1520,1360], "80":[1130,1240,1350,1470,1930,1760],
  "100":[1450,1570,1700,1810,2330,2170], "120":[1770,1900,2040,2170,2750,2570],
  "140":[2040,2210,2360,2500,3120,3000], "160":[2290,2470,2630,2800,3460,3410],
  "170":[2620,2810,2980,3170,3860,3880],
};
