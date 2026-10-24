#!/usr/bin/env node
/**
 * セキュリティルールの本番反映（Firebase Rules REST API 直叩き）
 * =============================================================================
 *
 * ■ これは何か
 *   firestore.rules / firestore.practice.rules / storage.rules を本番に出すための常設の道具。
 *   deploy-hosting.mjs と同じ理由で firebase CLI は使わない（CLI の認証が 279 の
 *   アカウントに入れ替わり「Failed to get Firebase project」で落ちる・GitHub Issue #3）。
 *   これまでは毎回その場で curl を組み立てていたため、手順がぶれ、戻し先の ruleset 名も
 *   記憶頼みだった。それをこの1本にまとめる。
 *
 * ■ 使い方
 *   node scripts/deploy-rules.mjs --target firestore --check     本番と手元の差分を見るだけ（書き込まない）
 *   node scripts/deploy-rules.mjs --target firestore --live      本番へ（差分表示 → 5秒の猶予 → 反映 → 一致確認）
 *   node scripts/deploy-rules.mjs --target firestore --rollback <rulesetId>   指定の ruleset に戻す
 *
 *   --target <firestore|practice|storage>
 *       firestore = (default) DB の firestore.rules
 *       practice  = practice DB（練習モード）の firestore.practice.rules
 *       storage   = storage.rules
 *   --account <mail>   gcloud のアカウント（既定 yoshinao-tsukuda@tadakayo.jp）
 *
 * ■ 安全側の設計（意図的な制約なので緩めないこと）
 *   - `--live` / `--rollback` を明示しない限り何も書き込まない。引数なしは使い方を出して終了コード1
 *   - `--live` はコミット済みのルールしか出さない（手元で未コミットの変更があれば止める）。
 *     「main にない変更が本番に出ていた」を起こさないため、origin/main と違えば警告も出す
 *   - 反映前に「いまの本番の ruleset ID」を必ず表示する（＝そのまま戻し先になる）
 *   - 反映後に本番の release を読み直し、中身が手元のファイルと一致することを確かめる
 *   - 文法エラーは ruleset 作成の時点で API が弾く（release は差し替わらない）
 *   - アクセストークンは画面・ログ・エラーのどこにも出さない
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RULES_API = "https://firebaserules.googleapis.com/v1";
const DEFAULT_ACCOUNT = "yoshinao-tsukuda@tadakayo.jp";
const GCLOUD_CANDIDATES = [
  process.env.GCLOUD_BIN,
  path.join(process.env.HOME ?? "", "Projects/google-cloud-sdk/bin/gcloud"),
  "/usr/local/bin/gcloud",
  "gcloud",
].filter(Boolean);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// トークンの伏字化（画面・エラーに絶対出さない）
// ---------------------------------------------------------------------------
let ACCESS_TOKEN = null;

function scrub(text) {
  let s = String(text ?? "");
  if (ACCESS_TOKEN) s = s.split(ACCESS_TOKEN).join("***REDACTED***");
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer ***REDACTED***");
  s = s.replace(/ya29\.[A-Za-z0-9._\-]+/g, "***REDACTED***");
  return s;
}

function log(...args) {
  console.log(...args.map((a) => (typeof a === "string" ? scrub(a) : a)));
}

function die(message) {
  console.error("エラー: " + scrub(message));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
function usage() {
  console.log(`
セキュリティルールの本番反映（Firebase Rules REST API）

  node scripts/deploy-rules.mjs --target <firestore|practice|storage> [--check | --live | --rollback <rulesetId>]

  --target <名前>         firestore（本番DB）/ practice（練習モードDB）/ storage
  --check                 本番と手元の差分を表示して終了（書き込まない）
  --live                  本番へ反映 ※付けない限り本番には出さない
  --rollback <rulesetId>  release を指定の ruleset に戻す
  --account <mail>        gcloud のアカウント（既定 ${DEFAULT_ACCOUNT}）

例:
  node scripts/deploy-rules.mjs --target firestore --check
  node scripts/deploy-rules.mjs --target firestore --live
  node scripts/deploy-rules.mjs --target firestore --rollback 7713c823-8279-46e5-a7fe-03110234b1a6
`);
}

function parseArgs(argv) {
  const opts = { target: null, check: false, live: false, rollback: null, account: DEFAULT_ACCOUNT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} の値がありません`);
      return v;
    };
    switch (a) {
      case "--target": opts.target = next(); break;
      case "--check": opts.check = true; break;
      case "--live": opts.live = true; break;
      case "--rollback": opts.rollback = next(); break;
      case "--account": opts.account = next(); break;
      case "-h":
      case "--help": usage(); process.exit(0); break;
      default: die(`不明な引数: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 設定の解決（ファイル名・release 名は firebase.json から引く。決め打ちしない）
// ---------------------------------------------------------------------------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    die(`${path.relative(ROOT, file)} を読めません: ${e.message}`);
  }
}

/** target → { file, releaseId }。storage の releaseId は本番の release 一覧から決める */
function resolveTarget(firebaseJson, target) {
  if (target === "firestore" || target === "practice") {
    const db = target === "firestore" ? "(default)" : "practice";
    const list = Array.isArray(firebaseJson.firestore) ? firebaseJson.firestore : [firebaseJson.firestore];
    const hit = list.filter((f) => f && (f.database ?? "(default)") === db);
    if (hit.length !== 1) die(`firebase.json の firestore に database "${db}" が1件ありません`);
    return { file: hit[0].rules, releaseId: db === "(default)" ? "cloud.firestore" : `cloud.firestore/${db}` };
  }
  if (target === "storage") {
    const rules = firebaseJson.storage?.rules;
    if (!rules) die("firebase.json に storage.rules がありません");
    return { file: rules, releaseId: null };
  }
  die(`--target は firestore / practice / storage のいずれかです（指定: ${target}）`);
}

// ---------------------------------------------------------------------------
// git（--live はコミット済みのものしか出さない）
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function checkCommitted(file) {
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", file], { cwd: ROOT, stdio: "ignore" });
  } catch {
    die(`${file} に未コミットの変更があります。コミットしてから出してください（main にない変更を本番に出さないため）。`);
  }
  try {
    git(["fetch", "-q", "origin", "main"]);
    const same = git(["rev-parse", `HEAD:${file}`]) === git(["rev-parse", `origin/main:${file}`]);
    if (!same) log(`⚠ ${file} が origin/main と違います（マージ前のブランチから出そうとしていませんか）。`);
    return same;
  } catch {
    log("⚠ origin/main との照合ができませんでした（fetch に失敗）。");
    return false;
  }
}

// ---------------------------------------------------------------------------
// 認証（deploy-hosting.mjs と同じ順: ADC → gcloud ユーザー認証）
// ---------------------------------------------------------------------------
async function getAccessTokenViaAdc() {
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(process.env.HOME ?? "", ".config/gcloud-tadakayo/application_default_credentials.json");
  if (!fs.existsSync(adcPath)) return null;
  const c = JSON.parse(fs.readFileSync(adcPath, "utf8"));
  if (!c.refresh_token || !c.client_id || !c.client_secret) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.client_id, client_secret: c.client_secret,
      refresh_token: c.refresh_token, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.access_token || null;
}

function getAccessToken(account) {
  for (const bin of GCLOUD_CANDIDATES) {
    try {
      const out = execFileSync(bin, ["auth", "print-access-token", "--account", account], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out) return out;
    } catch (e) {
      const detail = scrub(e.stderr?.toString?.() ?? e.message ?? "");
      if (bin === GCLOUD_CANDIDATES[GCLOUD_CANDIDATES.length - 1]) {
        die(
          `gcloud のアクセストークンを取得できません（account=${account}）。\n` +
          `  ${detail}\n` +
          `  認証が切れている場合は \`gcloud auth login\`（ブラウザ操作が必要）を実行してください。`
        );
      }
    }
  }
  die(`gcloud が見つかりません（試したパス: ${GCLOUD_CANDIDATES.join(", ")}）`);
}

// ---------------------------------------------------------------------------
// REST 呼び出し
// ---------------------------------------------------------------------------
async function api(url, { method = "GET", project, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      // これが無いと quota project 未設定で 403 になる
      "x-goog-user-project": project,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${scrub(url)} → HTTP ${res.status}\n${scrub(text).slice(0, 3000)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

const rulesetId = (name) => String(name ?? "").split("/").pop();

async function getRelease(project, releaseId) {
  return api(`${RULES_API}/projects/${project}/releases/${releaseId}`, { project });
}

async function getRulesetSource(project, name) {
  const rs = await api(`${RULES_API}/${name}`, { project });
  const files = rs.source?.files ?? [];
  if (files.length !== 1) die(`ruleset ${rulesetId(name)} のファイル数が ${files.length} 件です（1件を想定）`);
  return files[0].content;
}

async function findStorageRelease(project) {
  const res = await api(`${RULES_API}/projects/${project}/releases?pageSize=100`, { project });
  const hits = (res.releases ?? []).filter((r) => r.name.includes("/releases/firebase.storage/"));
  if (hits.length !== 1) die(`storage の release が ${hits.length} 件あります（1件を想定）`);
  return hits[0].name.split("/releases/")[1];
}

async function updateRelease(project, releaseId, rulesetName) {
  return api(`${RULES_API}/projects/${project}/releases/${releaseId}`, {
    method: "PATCH",
    project,
    body: { release: { name: `projects/${project}/releases/${releaseId}`, rulesetName } },
  });
}

/** 取り違え防止: firestore 用の ruleset を storage に（またはその逆に）当てない */
function checkService(src, releaseId, label) {
  const want = releaseId.startsWith("firebase.storage") ? "firebase.storage" : "cloud.firestore";
  if (!new RegExp(`service\\s+${want.replace(".", "\\.")}\\s*\\{`).test(src)) {
    die(`${label} は service ${want} のルールではありません（取り違えのおそれがあるので止めました）`);
  }
}

/** 差分の表示（ルールは秘密情報ではないので本文をそのまま出す） */
function showDiff(liveSrc, localSrc, file) {
  if (liveSrc === localSrc) {
    log("差分: なし（本番は手元のファイルと同じ）");
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-rules-"));
  const a = path.join(dir, "live"), b = path.join(dir, "local");
  fs.writeFileSync(a, liveSrc);
  fs.writeFileSync(b, localSrc);
  let out = "";
  try {
    execFileSync("diff", ["-u", "--label", "本番", "--label", file, a, b], { encoding: "utf8" });
  } catch (e) {
    out = e.stdout ?? "";
  }
  fs.rmSync(dir, { recursive: true, force: true });
  log("差分（- 本番 / + 手元）:");
  log(out.trimEnd());
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function countdown(message) {
  log(message);
  log("   中止する場合は 5 秒以内に Ctrl+C を押してください。");
  for (let i = 5; i > 0; i--) {
    process.stdout.write(`   ${i}...\n`);
    await sleep(1000);
  }
  log("   続行します。\n");
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    console.error("引数がありません。--target と、--check / --live / --rollback のいずれかを指定してください。");
    process.exit(1);
  }
  const opts = parseArgs(argv);
  if (!opts.target) {
    usage();
    console.error("--target が指定されていません。");
    process.exit(1);
  }
  const modes = [opts.check, opts.live, !!opts.rollback].filter(Boolean).length;
  if (modes !== 1) {
    usage();
    console.error("--check / --live / --rollback <rulesetId> のどれか1つを指定してください（既定では本番に出しません）。");
    process.exit(1);
  }

  const firebaseJson = readJson(path.join(ROOT, "firebase.json"));
  const project = readJson(path.join(ROOT, ".firebaserc"))?.projects?.default;
  if (!project) die(".firebaserc に projects.default がありません");
  const t = resolveTarget(firebaseJson, opts.target);
  const localPath = path.join(ROOT, t.file);
  if (!fs.existsSync(localPath)) die(`${t.file} がありません`);
  const localSrc = fs.readFileSync(localPath, "utf8");

  if (opts.live) checkCommitted(t.file);

  ACCESS_TOKEN = (await getAccessTokenViaAdc()) ?? getAccessToken(opts.account);
  const releaseId = t.releaseId ?? (await findStorageRelease(project));

  const before = await getRelease(project, releaseId);
  const liveSrc = await getRulesetSource(project, before.rulesetName);

  log("──────────────────────────────────────────────");
  log(`  プロジェクト   : ${project}`);
  log(`  target         : ${opts.target}（${t.file}）`);
  log(`  release        : ${releaseId}`);
  log(`  いまの本番     : ${rulesetId(before.rulesetName)}（${before.updateTime ?? "更新日時不明"}）`);
  log(`  手元のコミット : ${git(["rev-parse", "--short", "HEAD"])}`);
  log("──────────────────────────────────────────────");

  // --- check: 差分を見るだけ ---------------------------------------------
  if (opts.check) {
    const differs = showDiff(liveSrc, localSrc, t.file);
    log("\n※ --check のため何も書き込んでいません。");
    process.exit(differs ? 2 : 0); // 差分ありは 2（スクリプトから判定できるように）
  }

  // --- rollback: 指定の ruleset に戻す -----------------------------------
  if (opts.rollback) {
    const target = `projects/${project}/rulesets/${opts.rollback}`;
    const targetSrc = await getRulesetSource(project, target); // 存在しなければここで止まる
    checkService(targetSrc, releaseId, `ruleset ${opts.rollback}`);
    if (target === before.rulesetName) die("指定の ruleset はすでに本番です");
    showDiff(liveSrc, targetSrc, `ruleset ${opts.rollback}`);
    await countdown(`\n★ ${releaseId} を ruleset ${opts.rollback} に戻します。`);
    await updateRelease(project, releaseId, target);
    const after = await getRelease(project, releaseId);
    if (after.rulesetName !== target) die(`戻したはずが本番は ${rulesetId(after.rulesetName)} のままです`);
    log(`完了: ${releaseId} は ${opts.rollback} になりました（直前は ${rulesetId(before.rulesetName)}）。`);
    return;
  }

  // --- live: 反映 ---------------------------------------------------------
  checkService(localSrc, releaseId, t.file);
  if (!showDiff(liveSrc, localSrc, t.file)) {
    log("\n本番はすでに手元と同じなので、何もしません。");
    return;
  }
  await countdown(`\n★ ${t.file} を本番（${releaseId}）に反映します。`);

  // 文法エラーはここで HTTP 400 になり、release は差し替わらない
  let created;
  try {
    created = await api(`${RULES_API}/projects/${project}/rulesets`, {
      method: "POST",
      project,
      body: { source: { files: [{ name: path.basename(t.file), content: localSrc }] } },
    });
  } catch (e) {
    die(`ruleset を作れませんでした（本番は変わっていません）。\n${e.message}`);
  }
  log(`ruleset 作成: ${rulesetId(created.name)}`);

  await updateRelease(project, releaseId, created.name);

  // 読み直して、本番の中身が手元と一致するかを確かめる
  const after = await getRelease(project, releaseId);
  const afterSrc = await getRulesetSource(project, after.rulesetName);
  const ok = after.rulesetName === created.name && afterSrc === localSrc;

  log("\n──────────────── 完了 ────────────────");
  log(`  release        : ${releaseId}`);
  log(`  新しい本番     : ${rulesetId(after.rulesetName)}`);
  log(`  直前（戻し先） : ${rulesetId(before.rulesetName)}`);
  log(`  手元との一致   : ${ok ? "一致" : "★不一致"}`);
  log("──────────────────────────────────────");
  log("\n戻すとき:");
  log(`  node scripts/deploy-rules.mjs --target ${opts.target} --rollback ${rulesetId(before.rulesetName)}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("失敗しました: " + scrub(e?.stack ?? e?.message ?? e));
  process.exit(1);
});
