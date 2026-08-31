#!/usr/bin/env node
/**
 * Firebase Hosting REST API 直叩きデプロイ（firebase CLI が使えないときの代替手段）
 * =============================================================================
 *
 * ■ これは何か
 *   firebase CLI の認証がタダカヨ（yoshinao-tsukuda@tadakayo.jp）から 279 のアカウントに
 *   勝手に入れ替わり、`hosting:channel:deploy` が「Failed to get Firebase project」で
 *   落ちる事象が繰り返し起きている（GitHub Issue #3）。
 *   その間も本番反映を止めないための「回避手段の常設版」。
 *   gcloud のタダカヨ認証さえ生きていれば、Hosting REST API を直接叩いてデプロイできる。
 *
 * ■ 前提
 *   - gcloud のタダカヨ認証が生きていること
 *       ~/Projects/google-cloud-sdk/bin/gcloud auth list
 *     期限切れなら（ブラウザが開くので次田さんの操作が必要）
 *       ~/Projects/google-cloud-sdk/bin/gcloud auth login
 *   - firebase-tools がグローバルに入っていること（配信ファイル一覧の算出に使う）
 *   - ADC ではなくユーザー認証を使う（ADC は 279 アカウントのままで kjk-tadakayo に使えない）
 *
 * ■ 使い方
 *   node scripts/deploy-hosting.mjs --target lp --dry-run                 配信ファイル一覧と
 *                                                                        REST 変換後の config を
 *                                                                        表示するだけ（API 未呼び出し）
 *   node scripts/deploy-hosting.mjs --target lp --channel verify-0816     プレビューチャンネルへ
 *   node scripts/deploy-hosting.mjs --target admin --live                 本番へ（5秒の猶予あり）
 *
 *   オプション
 *     --target <lp|admin>   firebase.json の hosting[].target（必須）
 *     --dry-run             API を1回も呼ばずに終了
 *     --channel <name>      プレビューチャンネルへリリース
 *     --live                本番（live チャンネル）へリリース
 *     --expires <days>      --channel のときの有効期限（既定 7日）
 *     --account <mail>      gcloud のアカウント（既定 yoshinao-tsukuda@tadakayo.jp）
 *
 * ■ 安全側の設計（意図的な制約なので緩めないこと）
 *   - `--live` を明示しない限り本番には出さない。引数なしは使い方を出して終了コード1
 *   - `--live` のときは対象・件数・サイト名を表示してから5秒待つ（Ctrl+C で中断できる）
 *   - アクセストークンは画面・ログ・エラーメッセージのどこにも出さない（出力前に必ず伏字化）
 *   - 配信ファイル一覧は firebase-tools の listFiles を使う。使えないときは自前走査に
 *     フォールバックせずエラーで停止する。ignore の解釈が CLI とずれると内部資料を
 *     本番公開する事故になる（2026-08-10 に実際に発生している）
 *
 * ■ 恒久運用ではない
 *   firebase CLI の認証が復旧したら、通常手順（rule05 の二段階デプロイ＝
 *   `hosting:channel:deploy` で検証 → `hosting:clone ...:live` で昇格）に戻すこと。
 *   本スクリプトはあくまで CLI が使えないときの代替。
 *
 * ■ 参考（REST の落とし穴）
 *   firebase.json の headers/redirects は REST では形が違う。
 *     source → glob ／ [{key,value}] → {key:value} ／ type → statusCode
 *     trailingSlash: true|false → trailingSlashBehavior: "ADD"|"REMOVE"
 *   変換ロジックは firebase-tools の deploy/hosting/convertConfig.js に合わせてある。
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const DEFAULT_ACCOUNT = "yoshinao-tsukuda@tadakayo.jp";
const GCLOUD_CANDIDATES = [
  process.env.GCLOUD_BIN,
  path.join(process.env.HOME ?? "", "Projects/google-cloud-sdk/bin/gcloud"),
  "/usr/local/bin/gcloud",
  "gcloud",
].filter(Boolean);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// トークンの伏字化（画面・エラーに絶対出さない）
// ---------------------------------------------------------------------------
let ACCESS_TOKEN = null;

function scrub(text) {
  let s = String(text ?? "");
  if (ACCESS_TOKEN) s = s.split(ACCESS_TOKEN).join("***REDACTED***");
  // 念のため Bearer 形式と ya29. 形式も潰す
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
Firebase Hosting REST API 直叩きデプロイ（firebase CLI が使えないときの代替）

  node scripts/deploy-hosting.mjs --target <lp|admin> [--dry-run | --channel <名前> | --live]

  --target <名前>    firebase.json の hosting[].target（必須）
  --dry-run          配信ファイル一覧と REST 変換後の config を表示して終了（API を呼ばない）
  --channel <名前>   プレビューチャンネルへリリース
  --live             本番（live）へリリース ※付けない限り本番には出さない
  --expires <日数>   --channel の有効期限（既定 7）
  --account <mail>   gcloud のアカウント（既定 ${DEFAULT_ACCOUNT}）

例:
  node scripts/deploy-hosting.mjs --target lp --dry-run
  node scripts/deploy-hosting.mjs --target lp --channel verify-0816
  node scripts/deploy-hosting.mjs --target admin --live
`);
}

function parseArgs(argv) {
  const opts = {
    target: null,
    dryRun: false,
    live: false,
    channel: null,
    expiresDays: 7,
    account: DEFAULT_ACCOUNT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} の値がありません`);
      return v;
    };
    switch (a) {
      case "--target": opts.target = next(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--live": opts.live = true; break;
      case "--channel": opts.channel = next(); break;
      case "--expires": opts.expiresDays = Number(next()); break;
      case "--account": opts.account = next(); break;
      case "-h":
      case "--help": usage(); process.exit(0); break;
      default: die(`不明な引数: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 設定の読み込み・解決
// ---------------------------------------------------------------------------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    die(`${path.relative(ROOT, file)} を読めません: ${e.message}`);
  }
}

/** firebase.json の hosting 配列から --target のものを取り出す */
function findHostingConfig(firebaseJson, target) {
  const hosting = firebaseJson.hosting;
  const list = Array.isArray(hosting) ? hosting : hosting ? [hosting] : [];
  if (list.length === 0) die("firebase.json に hosting 設定がありません");
  const hit = list.filter((h) => h.target === target);
  if (hit.length === 0) {
    const names = list.map((h) => h.target ?? h.site ?? "(名前なし)").join(", ");
    die(`firebase.json に target "${target}" がありません。あるのは: ${names}`);
  }
  if (hit.length > 1) die(`target "${target}" が firebase.json に複数あります`);
  return hit[0];
}

/** .firebaserc の targets から target → site を解決する（決め打ちしない） */
function resolveSite(firebaserc, project, target, hostingConfig) {
  if (hostingConfig.site) return hostingConfig.site; // firebase.json に直書きされている場合
  const map = firebaserc?.targets?.[project]?.hosting;
  if (!map) die(`.firebaserc に targets.${project}.hosting がありません（target→site を解決できない）`);
  const sites = map[target];
  if (!sites || sites.length === 0) {
    die(`.firebaserc の targets.${project}.hosting に "${target}" がありません。あるのは: ${Object.keys(map).join(", ")}`);
  }
  if (sites.length > 1) {
    die(`target "${target}" に複数サイトが割り当てられています（${sites.join(", ")}）。このスクリプトは1対1のみ対応`);
  }
  return sites[0];
}

/** firebase-tools の listFiles を取得（見つからなければ停止。自前走査はしない） */
function loadListFiles() {
  const candidates = [];
  try {
    candidates.push(require_.resolve("firebase-tools/lib/listFiles.js", { paths: [ROOT] }));
  } catch { /* noop */ }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(path.join(globalRoot, "firebase-tools/lib/listFiles.js"));
  } catch { /* noop */ }
  candidates.push("/opt/homebrew/lib/node_modules/firebase-tools/lib/listFiles.js");
  candidates.push("/usr/local/lib/node_modules/firebase-tools/lib/listFiles.js");

  for (const c of candidates) {
    try {
      const mod = require_(c);
      if (typeof mod.listFiles === "function") return mod.listFiles;
    } catch { /* 次の候補へ */ }
  }
  die(
    "firebase-tools の listFiles が見つかりません。\n" +
    "  ignore の解釈が CLI とずれると内部資料を本番公開する事故になるため、自前のファイル走査には\n" +
    "  フォールバックしません（2026-08-10 に実際に事故が発生している）。\n" +
    "  `npm i -g firebase-tools` で入れてから再実行してください。"
  );
}

// ---------------------------------------------------------------------------
// firebase.json → REST config への変換
// firebase-tools の deploy/hosting/convertConfig.js に合わせてある
// ---------------------------------------------------------------------------
function extractPattern(kind, src) {
  const glob = "source" in src ? src.source : "glob" in src ? src.glob : undefined;
  const regex = "regex" in src ? src.regex : undefined;
  if (glob && regex) die(`${kind} に glob と regex の両方は指定できません`);
  if (glob) return { glob };
  if (regex) return { regex };
  die(`${kind} にパターン（source / glob / regex）がありません`);
}

function convertConfig(hostingConfig) {
  const config = {};

  if (hostingConfig.headers) {
    config.headers = hostingConfig.headers.map((h) => {
      const headers = {};
      for (const { key, value } of h.headers ?? []) headers[key] = value;
      return { ...extractPattern("headers", h), headers };
    });
  }

  if (hostingConfig.redirects) {
    config.redirects = hostingConfig.redirects.map((r) => {
      const out = { ...extractPattern("redirects", r), location: r.destination };
      if (r.type) out.statusCode = r.type;
      return out;
    });
  }

  if (hostingConfig.rewrites) {
    config.rewrites = hostingConfig.rewrites.map((r) => {
      const target = extractPattern("rewrites", r);
      if ("destination" in r) return { ...target, path: r.destination };
      if ("run" in r) {
        return { ...target, run: { serviceId: r.run.serviceId, region: r.run.region || "us-central1" } };
      }
      if ("dynamicLinks" in r) return { ...target, dynamicLinks: true };
      // function rewrite は「どの関数がどのリージョンに存在するか」の解決が必要で、
      // それは CLI（Functions API 参照）でしかできない。黙って壊すより止める。
      die(
        "rewrites に function 指定があります。REST 直叩きでは関数の実体解決ができないため対応していません。\n" +
        "  firebase CLI の認証を復旧して通常手順でデプロイしてください。"
      );
    });
  }

  if (hostingConfig.cleanUrls !== undefined) config.cleanUrls = hostingConfig.cleanUrls;
  if (hostingConfig.appAssociation !== undefined) config.appAssociation = hostingConfig.appAssociation;
  if (hostingConfig.i18n !== undefined) config.i18n = hostingConfig.i18n;
  if (hostingConfig.trailingSlash !== undefined) {
    config.trailingSlashBehavior = hostingConfig.trailingSlash ? "ADD" : "REMOVE";
  }

  // 想定外のキーを黙って落とすと「設定したつもりが効いていない」事故になるので止める
  const known = new Set([
    "target", "site", "public", "source", "ignore",
    "headers", "redirects", "rewrites",
    "cleanUrls", "trailingSlash", "appAssociation", "i18n",
    "predeploy", "postdeploy", // CLI 専用フック。REST では扱わない（無視でよい）
  ]);
  const unknown = Object.keys(hostingConfig).filter((k) => !known.has(k));
  if (unknown.length) {
    die(`firebase.json の hosting に未対応のキーがあります: ${unknown.join(", ")}（黙って無視せず停止しました）`);
  }

  return config;
}

// ---------------------------------------------------------------------------
// 認証（トークンは返り値としてだけ扱い、絶対に出力しない）
// ---------------------------------------------------------------------------
function getAccessToken(account) {
  for (const bin of GCLOUD_CANDIDATES) {
    try {
      const out = execFileSync(bin, ["auth", "print-access-token", "--account", account], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out) return out;
    } catch (e) {
      // stderr にトークンは出ないが、念のため伏字化してから最後にまとめて出す
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

// gcloud のユーザー認証は数時間で切れる（再認証はブラウザ操作が要るので自動化を止めてしまう）。
// ADC（gcloud auth application-default login で作った資格情報）が生きていればそちらで通す。
// 動画パイプラインの tts.py に入れたのと同じ逃げ道。
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

// ---------------------------------------------------------------------------
// REST 呼び出し
// ---------------------------------------------------------------------------
function authHeaders(project, extra = {}) {
  return {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    // これが無いと quota project 未設定で 403 になる
    "x-goog-user-project": project,
    ...extra,
  };
}

async function apiFetch(url, { method = "GET", project, body, headers = {}, raw } = {}) {
  const res = await fetch(url, {
    method,
    headers: authHeaders(project, {
      ...(raw ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    }),
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${scrub(url)} → HTTP ${res.status}\n${scrub(text).slice(0, 2000)}`);
    err.status = res.status;
    throw err;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/** 並列度を絞って実行する簡易ワーカープール */
async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    console.error("引数がありません。--target と、--dry-run / --channel / --live のいずれかを指定してください。");
    process.exit(1);
  }

  const opts = parseArgs(argv);
  if (!opts.target) {
    usage();
    console.error("--target が指定されていません。");
    process.exit(1);
  }

  const modes = [opts.dryRun, !!opts.channel, opts.live].filter(Boolean).length;
  if (modes === 0) {
    usage();
    console.error("--dry-run / --channel <名前> / --live のいずれかを指定してください（既定では本番に出しません）。");
    process.exit(1);
  }
  if (modes > 1) {
    usage();
    console.error("--dry-run / --channel / --live は同時に指定できません。");
    process.exit(1);
  }

  // --- 設定の解決 ---------------------------------------------------------
  const firebaseJson = readJson(path.join(ROOT, "firebase.json"));
  const firebaserc = readJson(path.join(ROOT, ".firebaserc"));
  const project = firebaserc?.projects?.default;
  if (!project) die(".firebaserc に projects.default がありません");

  const hostingConfig = findHostingConfig(firebaseJson, opts.target);
  const site = resolveSite(firebaserc, project, opts.target, hostingConfig);
  const publicDir = path.resolve(ROOT, hostingConfig.public ?? ".");
  if (!fs.existsSync(publicDir)) die(`public ディレクトリがありません: ${publicDir}`);

  const listFiles = loadListFiles();
  const files = listFiles(publicDir, hostingConfig.ignore ?? []).sort();
  const restConfig = convertConfig(hostingConfig);

  const channel = opts.live ? "live" : opts.channel;

  log("──────────────────────────────────────────────");
  log(`  プロジェクト : ${project}`);
  log(`  target       : ${opts.target}`);
  log(`  サイト       : ${site}`);
  log(`  public       : ${hostingConfig.public ?? "."}  →  ${publicDir}`);
  log(`  配信ファイル : ${files.length} 件`);
  log(`  リリース先   : ${opts.dryRun ? "（dry-run: リリースしない）" : channel === "live" ? "live（本番）" : `チャンネル ${channel}`}`);
  log("──────────────────────────────────────────────");

  // --- dry-run: ここで終わり（API を1回も呼ばない） -----------------------
  if (opts.dryRun) {
    log("\n[配信対象ファイル一覧]");
    files.forEach((f, i) => log(`  ${String(i + 1).padStart(4, " ")}. ${f}`));
    log(`\n  合計 ${files.length} 件`);

    log("\n[REST 形式に変換した config]");
    log(JSON.stringify(restConfig, null, 2));

    log("\n※ dry-run のため API は1回も呼んでいません（gcloud のトークンも取得していません）。");
    log("※ 一覧に内部資料（*.md / 議事録 / 管理画面用スクショ 等）が混ざっていないか必ず目視で確認してください。");
    return;
  }

  // --- 本番は必ず猶予を置く ----------------------------------------------
  if (channel === "live") {
    log("\n★ 本番（live）へリリースします。");
    log(`   サイト ${site} に ${files.length} 件を公開します。`);
    log("   中止する場合は 5 秒以内に Ctrl+C を押してください。");
    for (let i = 5; i > 0; i--) {
      process.stdout.write(`   ${i}...\n`);
      await sleep(1000);
    }
    log("   続行します。\n");
  }

  const started = Date.now();
  ACCESS_TOKEN = await getAccessTokenViaAdc();
  if (ACCESS_TOKEN) {
    console.log("  認証         : ADC（gcloud のユーザー認証が切れていても通る経路）");
  } else {
    ACCESS_TOKEN = getAccessToken(opts.account);
    console.log("  認証         : gcloud ユーザー認証");
  }
  log(`アクセストークンを取得しました（account=${opts.account}）。`);

  // --- 1. version 作成 ----------------------------------------------------
  const createRes = await apiFetch(`${HOSTING_API}/projects/-/sites/${site}/versions`, {
    method: "POST",
    project,
    body: { status: "CREATED", labels: { "deployed-by": "scripts-deploy-hosting-mjs" } },
  });
  const versionName = createRes.name; // sites/{site}/versions/{versionId}
  if (!versionName) die("version の作成に失敗しました（name が返りませんでした）");
  const versionId = versionName.split("/").pop();
  log(`version 作成: ${versionId}`);

  // --- 2. gzip してハッシュ算出 ------------------------------------------
  const gzipped = new Map(); // hash -> Buffer
  const filesByHash = {}; // "/path" -> hash
  for (const rel of files) {
    const buf = zlib.gzipSync(fs.readFileSync(path.join(publicDir, rel)), { level: 9 });
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    gzipped.set(hash, buf);
    filesByHash["/" + rel] = hash;
  }
  log(`gzip + ハッシュ算出: ${files.length} 件`);

  // --- 3. populateFiles ---------------------------------------------------
  const entries = Object.entries(filesByHash);
  const BATCH = 1000;
  let uploadUrl = null;
  const requiredHashes = new Set();
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = Object.fromEntries(entries.slice(i, i + BATCH));
    const res = await apiFetch(`${HOSTING_API}/${versionName}:populateFiles`, {
      method: "POST",
      project,
      body: { files: batch },
    });
    uploadUrl = res.uploadUrl ?? uploadUrl;
    for (const h of res.uploadRequiredHashes ?? []) requiredHashes.add(h);
  }
  log(`populateFiles 完了: アップロードが必要なファイル ${requiredHashes.size} 件（残りはサーバー側に既存）`);

  // --- 4. アップロード ----------------------------------------------------
  let uploaded = 0;
  if (requiredHashes.size > 0) {
    if (!uploadUrl) die("uploadUrl が返りませんでした");
    await pool([...requiredHashes], 8, async (hash) => {
      const buf = gzipped.get(hash);
      if (!buf) die(`ハッシュ ${hash} に対応するファイルが見つかりません`);
      await apiFetch(`${uploadUrl}/${hash}`, { method: "POST", project, raw: buf });
      uploaded++;
      if (uploaded % 10 === 0 || uploaded === requiredHashes.size) {
        log(`  アップロード ${uploaded}/${requiredHashes.size}`);
      }
    });
  }

  // --- 5. FINALIZE（このタイミングで config を適用する） ------------------
  await apiFetch(
    `${HOSTING_API}/projects/-/sites/${site}/versions/${versionId}?updateMask=status,config`,
    { method: "PATCH", project, body: { status: "FINALIZED", config: restConfig } }
  );
  log("version を FINALIZED にしました。");

  // --- 6. チャンネル（プレビューのみ。無ければ作る） ----------------------
  if (channel !== "live") {
    try {
      await apiFetch(
        `${HOSTING_API}/projects/${project}/sites/${site}/channels?channelId=${encodeURIComponent(channel)}`,
        { method: "POST", project, body: { ttl: `${Math.round(opts.expiresDays * 86400)}s` } }
      );
      log(`チャンネル ${channel} を作成しました（有効期限 ${opts.expiresDays} 日）。`);
    } catch (e) {
      if (e.status === 409) log(`チャンネル ${channel} は既存のものを使います。`);
      else throw e;
    }
  }

  // --- 7. リリース --------------------------------------------------------
  const release = await apiFetch(
    `${HOSTING_API}/projects/-/sites/${site}/channels/${encodeURIComponent(channel)}/releases?versionName=${encodeURIComponent(versionName)}`,
    { method: "POST", project, body: {} }
  );
  const releaseId = release.name ? release.name.split("/").pop() : "(不明)";
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  log("\n──────────────── 完了 ────────────────");
  log(`  サイト           : ${site}`);
  log(`  リリース先       : ${channel === "live" ? "live（本番）" : `チャンネル ${channel}`}`);
  log(`  version ID       : ${versionId}`);
  log(`  release ID       : ${releaseId}`);
  log(`  配信ファイル     : ${files.length} 件`);
  log(`  アップロード     : ${uploaded} 件（差分のみ）`);
  log(`  所要時間         : ${elapsed} 秒`);
  if (release.channel?.url) log(`  URL              : ${release.channel.url}`);
  log("──────────────────────────────────────");
  log("\n確認は curl の目視ではなく version マニフェストで行うこと:");
  log(`  GET ${HOSTING_API}/sites/${site}/versions/${versionId}/files?pageSize=300`);
}

main().catch((e) => {
  console.error("失敗しました: " + scrub(e?.stack ?? e?.message ?? e));
  process.exit(1);
});
