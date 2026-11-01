// admin/js/service-types.js — 案件の「事業種別」（cases.serviceType）の選択肢の単一情報源（2026-11-01）
// 純粋な定義と関数だけ（import なし・DOM/Firestore に触れない）。Functions 側で使うときは
// first-contact.js と同じく、拡張子だけ .mjs にしたバイト単位のコピーを functions/ に置いて
// scripts/check-shared-sync.sh で照合する（第1弾では Functions は使わないのでコピーは置いていない）。
// テスト: node scripts/test-service-types.mjs
//
// 背景（藤田博之さん 10/27・次田さん決定 11/01）:
//   助成金は「事業所番号＋サービス種別（1事業）」ごとに申請する。福祉用具の貸与と販売の両方を行う事業所は2事業分。
//   そのため「1事業（事業種別）＝1案件」とし、案件に事業種別を持たせる。値は介護保険のサービスの種類の正式名。
//
// plan（助成金のプランの目安）は estimate-pricing.js の PLANS のキー:
//   houmon＝訪問・通所・短期滞在系（居宅介護支援を含む）／kyojyu＝居住・入所系／other＝その他
// 目安の根拠（どれもリポジトリ内の資料）:
//   ・index.html「助成上限額」の表（訪問・通所・短期滞在系／居住・入所系／その他 の対象サービス一覧）
//   ・料金シミュレーション_新案_認定事業所向け.md の区分①②③（サービスコード付き。国保中央会 交付要綱別添で確認とある）
//   ・同資料の「分類に注意するサービス」: 居宅介護支援(43)・居宅療養管理指導(31)・地域密着型通所介護(78) は houmon
//   ・同資料「介護予防サービスのみを実施している事業所は、対応する介護サービスに読み替えて申請可能」
// あくまで目安。案件詳細に「プランの目安」として出すだけで、subsidyCategory などを自動で書き換えない。

export const PLAN_LABELS = {
  houmon: "訪問・通所・短期滞在系（居宅介護支援を含む）",
  kyojyu: "居住・入所系",
  other: "その他",
};

// この順で選択肢に出す（国のサービスの種類の正式名。最後に「その他」）
export const SERVICE_TYPES = [
  { name: "居宅介護支援", plan: "houmon" },                 // コード43。資料の「分類に注意」で houmon と明記
  { name: "介護予防支援", plan: "houmon" },                 // 資料の一覧に無い。介護予防は対応する介護サービス（居宅介護支援）に読み替え＝houmon（推定）
  { name: "訪問介護", plan: "houmon" },                     // 11
  { name: "訪問入浴介護", plan: "houmon" },                 // 12
  { name: "訪問看護", plan: "houmon" },                     // 13
  { name: "訪問リハビリテーション", plan: "houmon" },       // 14
  { name: "居宅療養管理指導", plan: "houmon" },             // 31。資料の「分類に注意」で houmon と明記
  { name: "通所介護", plan: "houmon" },                     // 15
  { name: "地域密着型通所介護", plan: "houmon" },           // 78。資料の「分類に注意」で houmon と明記
  { name: "認知症対応型通所介護", plan: "houmon" },         // 72
  { name: "通所リハビリテーション", plan: "houmon" },       // 16
  { name: "短期入所生活介護", plan: "houmon" },             // 21
  { name: "短期入所療養介護", plan: "houmon" },             // 22・23・2A
  { name: "特定施設入居者生活介護", plan: "kyojyu" },       // 33（短期利用 27 も居住・入所系）
  { name: "福祉用具貸与", plan: "other" },                  // 17
  { name: "特定福祉用具販売", plan: "other" },              // 41
  { name: "定期巡回・随時対応型訪問介護看護", plan: "houmon" }, // 76
  { name: "夜間対応型訪問介護", plan: "houmon" },           // 71
  { name: "小規模多機能型居宅介護", plan: "houmon" },       // 73（短期利用 68 も houmon）
  { name: "看護小規模多機能型居宅介護", plan: "houmon" },   // 77（短期利用 79 も houmon）
  { name: "認知症対応型共同生活介護", plan: "kyojyu" },     // 32（短期利用 38 も居住・入所系）
  { name: "地域密着型特定施設入居者生活介護", plan: "kyojyu" }, // 36（短期利用 28 も居住・入所系）
  { name: "地域密着型介護老人福祉施設入所者生活介護", plan: "kyojyu" }, // 54
  { name: "介護老人福祉施設", plan: "kyojyu" },             // 51（介護福祉施設サービス）
  { name: "介護老人保健施設", plan: "kyojyu" },             // 52（介護保健施設サービス）
  { name: "介護医療院", plan: "kyojyu" },                   // 55
  // 総合事業は資料の3区分の一覧に載っていない（助成の対象か・どの区分かを確かめていない）→ 分からないので other
  { name: "介護予防・日常生活支援総合事業（訪問型サービス）", plan: "other" },
  { name: "介護予防・日常生活支援総合事業（通所型サービス）", plan: "other" },
  { name: "その他", plan: "other" },
];

export const SERVICE_TYPE_NAMES = SERVICE_TYPES.map((t) => t.name);

/** 一覧にある事業種別か */
export function isServiceType(name) {
  return typeof name === "string" && SERVICE_TYPE_NAMES.includes(name);
}

/** 事業種別 → プランの目安のキー（houmon / kyojyu / other）。未設定・一覧に無い値は null */
export function planOfServiceType(name) {
  const t = SERVICE_TYPES.find((x) => x.name === name);
  return t ? t.plan : null;
}

/** 事業種別 → 「プランの目安」の表示文（未設定・一覧に無い値は空文字） */
export function planHintText(name) {
  const p = planOfServiceType(name);
  return p ? `プランの目安：${PLAN_LABELS[p]}` : "";
}

/** 案件の事業種別の表示名。未設定は「未設定」。一覧に無い値（将来の名称変更など）はそのまま出す */
export function serviceTypeLabel(c) {
  const v = c && typeof c.serviceType === "string" ? c.serviceType.trim() : "";
  return v || "未設定";
}

/**
 * 一覧・カンバン・事業所画面のラベル（バッジ）の HTML。esc はエスケープ関数（画面ごとのものを渡す）。
 * 未設定は控えめな色の「未設定」。
 */
export function serviceTypeBadge(c, esc) {
  const v = c && typeof c.serviceType === "string" ? c.serviceType.trim() : "";
  const e = typeof esc === "function" ? esc : (s) => String(s);
  return v
    ? `<span class="badge badge-svc" title="事業種別">${e(v)}</span>`
    : `<span class="badge badge-svc badge-svc-none" title="事業種別">未設定</span>`;
}

/**
 * 2件の案件が「別の事業種別」か（両方に事業種別が入っていて、違う）。
 * 同じ事業所の別事業の案件は、メール・電話・事業所名が同じなので重複の候補に出てしまう。
 * 意図して分けた案件なので、重複の候補にしない（constants.js の computeDuplicateGroups・案件詳細の重複候補）。
 * どちらかが未設定なら false（従来どおり重複の候補になりうる）。
 */
export function differentServiceTypes(a, b) {
  const x = a && typeof a.serviceType === "string" ? a.serviceType.trim() : "";
  const y = b && typeof b.serviceType === "string" ? b.serviceType.trim() : "";
  return !!x && !!y && x !== y;
}

/** select の option の HTML（先頭に「未設定」）。いまの値が一覧に無いときも選択肢に残す */
export function serviceTypeOptionsHtml(current, esc, { emptyLabel = "未設定" } = {}) {
  const e = typeof esc === "function" ? esc : (s) => String(s);
  let html = `<option value="">${e(emptyLabel)}</option>`
    + SERVICE_TYPE_NAMES.map((n) => `<option value="${e(n)}">${e(n)}</option>`).join("");
  if (current && !isServiceType(current)) html += `<option value="${e(current)}">${e(current)}（一覧にない値）</option>`;
  return html;
}
