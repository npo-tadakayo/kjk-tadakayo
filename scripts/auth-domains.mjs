#!/usr/bin/env node
/**
 * Firebase Auth の承認済みドメイン（authorizedDomains）を「読んでから足す」道具
 * =============================================================================
 *
 * ■ 使い方
 *   node scripts/auth-domains.mjs check
 *       今の一覧を表示し、正常時の4件がそろっているかを見る（読むだけ）
 *       そろっていれば終了コード0、欠けていれば2
 *
 *   node scripts/auth-domains.mjs add <ドメイン> [<ドメイン>...]          ← 計画を見せるだけ
 *   node scripts/auth-domains.mjs add <ドメイン> [<ドメイン>...] --yes    ← 実際に書き込む
 *       今の一覧を GET → 今の一覧 ∪ 正常時の4件 ∪ 追加分 を PATCH → 読み戻して確認
 *       ドメインを省略して `add --yes` とすると「4件が欠けていれば戻す」だけを行う
 *
 *   node scripts/auth-domains.mjs remove <ドメイン> [...] [--yes]
 *       プレビュー版のアドレスなど、不要になったものを消す。正常時の4件は消せない
 *
 *   オプション: --project <id>（既定 kjk-tadakayo）
 *
 * ■ 絶対にやらないこと
 *   curl などで `?updateMask=authorizedDomains` に手書きの配列を PATCH しない。
 *   一覧が丸ごと置き換わる（2026-11-09 に一覧を空にして、本番で3日間ログインできなくなった）。
 *
 * ■ 本番の設定変更なので
 *   `--yes` を付けた実行は、次田さんの指示があってから行う。
 */

import {
  PROJECT, REQUIRED_DOMAINS,
  getAccessToken, readAuthorizedDomains, writeAuthorizedDomains,
  missingRequired, planAdd, planRemove,
} from "./lib/auth-domains-core.mjs";

function usage() {
  console.log(`
承認済みドメイン（Firebase Auth）を安全に扱う

  node scripts/auth-domains.mjs check
  node scripts/auth-domains.mjs add <ドメイン>... [--yes]
  node scripts/auth-domains.mjs remove <ドメイン>... [--yes]

  --yes を付けない限り書き込まない（計画を表示するだけ）
  正常時の4件: ${REQUIRED_DOMAINS.join(", ")}
`);
}

function printList(title, list) {
  console.log(`\n[${title}] ${list.length} 件`);
  for (const d of list) {
    const mark = REQUIRED_DOMAINS.includes(d) ? "★" : "  ";
    console.log(`  ${mark} ${d}`);
  }
  console.log("  （★ = 正常時の必須4件）");
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") { usage(); process.exit(cmd ? 0 : 1); }

  let project = PROJECT;
  let yes = false;
  const domains = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") yes = true;
    else if (a === "--project") {
      project = argv[++i];
      if (!project) throw new Error("--project の値がありません");
      // 必須4件は kjk-tadakayo 専用。別プロジェクトに足してしまわないよう止める
      if (project !== PROJECT) throw new Error(`このスクリプトは ${PROJECT} 専用です（--project ${project} は扱いません）`);
    }
    else if (a.startsWith("--")) throw new Error(`不明なオプション: ${a}`);
    else domains.push(a);
  }

  if (!["check", "add", "remove"].includes(cmd)) { usage(); throw new Error(`不明なコマンド: ${cmd}`); }
  if (cmd === "check" && (domains.length || yes)) throw new Error("check は引数を取りません");
  if (cmd === "remove" && domains.length === 0) throw new Error("remove には消すドメインを指定してください");

  const token = await getAccessToken();
  const current = await readAuthorizedDomains(token, project);
  console.log(`プロジェクト: ${project}`);
  printList("今の一覧", current);

  if (cmd === "check") {
    const miss = missingRequired(current);
    if (miss.length) {
      console.log(`\n✗ 正常時の4件のうち ${miss.length} 件が欠けています: ${miss.join(", ")}`);
      console.log("  この状態では欠けたアドレスからログインできません（auth/unauthorized-domain）。");
      console.log("  戻すには（次田さんの指示のうえで）: node scripts/auth-domains.mjs add --yes");
      process.exit(2);
    }
    console.log("\n✓ 正常時の4件はそろっています。");
    return;
  }

  let plan;
  if (cmd === "add") {
    plan = planAdd(current, domains);
    if (plan.restoredRequired.length) console.log(`\n必須で欠けていたので戻す: ${plan.restoredRequired.join(", ")}`);
    if (plan.added.length) console.log(`\n足す: ${plan.added.join(", ")}`);
  } else {
    plan = planRemove(current, domains);
    if (plan.notFound.length) console.log(`\n一覧に無いので何もしない: ${plan.notFound.join(", ")}`);
    if (plan.removed.length) console.log(`\n消す: ${plan.removed.join(", ")}`);
  }

  if (!plan.changed) {
    console.log("\n変更はありません（書き込みしません）。");
    return;
  }

  printList("書き込み後の一覧（予定）", plan.next);

  if (!yes) {
    console.log("\n※ 計画を表示しただけで、書き込んでいません。実行するには --yes を付けてください。");
    return;
  }

  const after = await writeAuthorizedDomains(token, plan.next, project, { basedOn: current });
  printList("書き込み後に読み戻した一覧", after);
  console.log("\n✓ 書き込み・読み戻しとも一致しました。正常時の4件もそろっています。");
}

main().catch((e) => {
  console.error("\nエラー: " + String(e?.message ?? e).replace(/ya29\.[A-Za-z0-9._\-]+/g, "***REDACTED***"));
  process.exit(1);
});
