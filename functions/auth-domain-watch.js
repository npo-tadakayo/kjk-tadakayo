// 毎朝の承認済みドメイン点検（dailyAuthDomainCheck）の判定と文面（純粋関数・テスト scripts/test-auth-domain-watch.mjs）
//
// なぜあるか（2026-11-11）: 11/9 に Firebase Auth の承認済みドメインが壊れたが、前からログインしていた人は
// 保存されたログイン状態のまま使えたため誰も気づかず、新しくログインする人だけが3日間入れなかった。
// 承認済みドメインはログインする瞬間にしか確かめられないので、使っている人の目では見つからない。→ 毎朝機械で見る。
//
// 必須4件は scripts/lib/auth-domains-core.mjs の REQUIRED_DOMAINS と同じ（テストで一致を検査する）。

const REQUIRED_DOMAINS = Object.freeze([
  "kjk-tadakayo.firebaseapp.com",
  "kjk-tadakayo.web.app",
  "kjk-tadakayo-admin.web.app",
  "kjk-tadakayo-admin.firebaseapp.com",
]);

function missingRequired(list) {
  const have = new Set((list || []).map((d) => String(d).toLowerCase()));
  return REQUIRED_DOMAINS.filter((d) => !have.has(d));
}

/** Identity Toolkit の config 応答から一覧を取り出す。形が違えば例外（空の一覧と取り違えない） */
function domainsFromConfig(json) {
  if (!json || !/^projects\/[^/]+\/config$/.test(String(json.name || ""))) {
    throw new Error(`想定外の応答です（name=${json && json.name}）`);
  }
  return Array.isArray(json.authorizedDomains) ? json.authorizedDomains : [];
}

/**
 * 点検結果から Chat の本文を作る。正常なら null（知らせない＝毎朝の雑音にしない）。
 *   result: { list } または { error }
 */
function alertText(result) {
  const head = "【CRM ログイン設定の点検】";
  const fix = "直し方（次田さんの判断で）: リポジトリで `node scripts/auth-domains.mjs check` → `node scripts/auth-domains.mjs add --yes`。" +
    "curl で updateMask=authorizedDomains に手書きの配列を PATCH しないこと（一覧が丸ごと置き換わる）。";
  if (result && result.error) {
    return `${head}\n⚠️ 承認済みドメインを読めず、点検できませんでした。\n` +
      `理由: ${String(result.error).slice(0, 300)}\n` +
      "点検用の権限（fn-batch-sa の roles/firebaseauth.viewer）が外れていないかを確認してください。";
  }
  const miss = missingRequired(result && result.list);
  if (!miss.length) return null;
  return `${head}\n🔴 Firebase Auth の承認済みドメインから、本番に必要なアドレスが ${miss.length} 件抜けています。\n` +
    `抜けている: ${miss.join(", ")}\n` +
    "この状態では、前からログインしている人は使えますが、新しくログインする人（初めての人・別のPC・ログアウトした人）は入れません（auth/unauthorized-domain）。\n" +
    fix;
}

module.exports = { REQUIRED_DOMAINS, missingRequired, domainsFromConfig, alertText };
