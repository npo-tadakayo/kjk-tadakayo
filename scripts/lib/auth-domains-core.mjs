/**
 * Firebase Auth「承認済みドメイン」(authorizedDomains) を安全に扱う部品
 * =============================================================================
 *
 * ■ なぜこれがあるか（2026-11-09 の事故）
 *   Identity Toolkit の config を `?updateMask=authorizedDomains` で PATCH すると、
 *   送った配列で一覧が「丸ごと置き換わる」（追記ではない）。
 *   2026-11-09 17:13 JST に別セッションが一覧を空にしてしまい、その後のプレビュー版の
 *   デプロイで CLI がチャンネルのアドレスだけを足したため、本番の
 *   kjk-tadakayo-admin.web.app が一覧から抜けたままになった。
 *   11/9〜11/11 は新しくログインする人全員が auth/unauthorized-domain で入れなかった。
 *
 * ■ この部品の約束
 *   - 書き込みは必ず「今の一覧を GET → 和集合（または差集合）を作る → PATCH → 読み戻して確認」
 *   - 正常時の4件（REQUIRED_DOMAINS）は、足す操作では必ず含め、消す操作では消せない
 *   - 計算（plan*）は純粋関数にして、ネットワーク無しでテストできるようにする
 *     → scripts/test-auth-domains.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const PROJECT = "kjk-tadakayo";

/** 正常時に必ず入っている4件。これが1件でも欠けると本番でログインできなくなる */
export const REQUIRED_DOMAINS = Object.freeze([
  "kjk-tadakayo.firebaseapp.com",
  "kjk-tadakayo.web.app",
  "kjk-tadakayo-admin.web.app",
  "kjk-tadakayo-admin.firebaseapp.com",
]);

const CONFIG_URL = (project) =>
  `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;

// ---------------------------------------------------------------------------
// 純粋関数（テスト対象）
// ---------------------------------------------------------------------------

/** "https://Foo.web.app/" のような入力をホスト名だけにそろえる。不正なら null */
export function normalizeDomain(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // スキーム
  s = s.replace(/[/?#].*$/, ""); // パス・クエリ
  s = s.replace(/:\d+$/, ""); // ポート（承認済みドメインはポートを持たない）
  s = s.replace(/\.$/, "");
  if (s === "localhost") return s;
  // ラベルは英数字とハイフン、2つ以上のラベル
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (!new RegExp(`^${label}(?:\\.${label})+$`).test(s)) return null;
  return s;
}

/**
 * 足してよいドメインか。承認済みドメインはサブドメインにも一致するため、
 * `web.app` のような広い名前を足すと他人のサイトまで OAuth の戻り先として承認されてしまう。
 * このプロジェクトのアドレス（プレビュー版を含む）・tadakayo.jp 配下・localhost に限る。
 */
export function isAllowedToAdd(domain) {
  if (domain === "localhost") return true;
  if (/^kjk-tadakayo(?:-[a-z0-9-]+)?\.(?:web\.app|firebaseapp\.com)$/.test(domain)) return true;
  if (/^[a-z0-9.-]+\.tadakayo\.jp$/.test(domain)) return true;
  return false;
}

/** 一覧から欠けている必須ドメイン */
export function missingRequired(list) {
  const have = new Set((list ?? []).map((d) => String(d).toLowerCase()));
  return REQUIRED_DOMAINS.filter((d) => !have.has(d));
}

/**
 * 足す計画。今の一覧 ∪ 必須4件 ∪ 追加分（順序は今の一覧を先頭に保つ）。
 * 戻り値 { next, added, restoredRequired, changed }
 */
export function planAdd(current, toAdd) {
  const cur = (current ?? []).map((d) => String(d).toLowerCase());
  const seen = new Set(cur);
  const next = [...cur];
  const restoredRequired = [];
  for (const d of REQUIRED_DOMAINS) {
    if (!seen.has(d)) { next.push(d); seen.add(d); restoredRequired.push(d); }
  }
  const added = [];
  for (const raw of toAdd ?? []) {
    const d = normalizeDomain(raw);
    if (!d) throw new Error(`ドメインの形が正しくありません: ${raw}`);
    if (!isAllowedToAdd(d)) {
      throw new Error(
        `${d} は足せません。足せるのは kjk-tadakayo のアドレス（プレビュー版を含む）・*.tadakayo.jp・localhost だけです` +
        "（承認済みドメインはサブドメインにも効くため、広い名前は他人のサイトまで承認してしまう）"
      );
    }
    if (!seen.has(d)) { next.push(d); seen.add(d); added.push(d); }
  }
  assertAddInvariant(cur, next);
  return { next, added, restoredRequired, changed: added.length + restoredRequired.length > 0 };
}

/**
 * 消す計画。必須4件は消せない（例外を投げる）。一覧に無いものは notFound に入れて無視。
 * 戻り値 { next, removed, notFound, changed }
 */
export function planRemove(current, toRemove) {
  const cur = (current ?? []).map((d) => String(d).toLowerCase());
  const targets = new Set();
  for (const raw of toRemove ?? []) {
    const d = normalizeDomain(raw);
    if (!d) throw new Error(`ドメインの形が正しくありません: ${raw}`);
    if (REQUIRED_DOMAINS.includes(d)) {
      throw new Error(`${d} は正常時の必須4件のひとつなので消せません（消すと本番でログインできなくなります）`);
    }
    targets.add(d);
  }
  const removed = cur.filter((d) => targets.has(d));
  const notFound = [...targets].filter((d) => !cur.includes(d));
  const next = cur.filter((d) => !targets.has(d));
  // 消す操作で必須が欠けた一覧を送らない（そもそも欠けていたら先に add で戻す）
  const miss = missingRequired(next);
  if (miss.length) {
    throw new Error(
      `今の一覧に必須ドメインが欠けています（${miss.join(", ")}）。消す前に add で戻してください`
    );
  }
  if (next.length !== cur.length - removed.length) throw new Error("内部エラー: 削除件数が合いません");
  return { next, removed, notFound, changed: removed.length > 0 };
}

/** 足す操作で「今あるものが1件でも消える」一覧は絶対に送らない */
function assertAddInvariant(cur, next) {
  const n = new Set(next);
  const lost = cur.filter((d) => !n.has(d));
  if (lost.length) throw new Error(`内部エラー: 足す操作で消えるドメインがあります: ${lost.join(", ")}`);
  const miss = missingRequired(next);
  if (miss.length) throw new Error(`内部エラー: 必須ドメインが欠けた一覧を作りました: ${miss.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 認証（トークンは返り値としてだけ扱い、画面に出さない）
// ---------------------------------------------------------------------------

/** タダカヨの ADC → gcloud ユーザー認証の順でアクセストークンを取る */
export async function getAccessToken({ account = "yoshinao-tsukuda@tadakayo.jp" } = {}) {
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(process.env.HOME ?? "", ".config/gcloud-tadakayo/application_default_credentials.json");
  if (fs.existsSync(adcPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(adcPath, "utf8"));
      if (c.refresh_token && c.client_id && c.client_secret) {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: c.client_id, client_secret: c.client_secret,
            refresh_token: c.refresh_token, grant_type: "refresh_token",
          }),
        });
        if (res.ok) {
          const j = await res.json();
          if (j.access_token) return j.access_token;
        }
      }
    } catch { /* gcloud にフォールバック */ }
  }
  const bins = [
    process.env.GCLOUD_BIN,
    path.join(process.env.HOME ?? "", "Projects/google-cloud-sdk/bin/gcloud"),
    "/usr/local/bin/gcloud",
    "gcloud",
  ].filter(Boolean);
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ["auth", "print-access-token", "--account", account], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out) return out;
    } catch { /* 次の候補へ */ }
  }
  throw new Error(
    `アクセストークンを取得できません（account=${account}）。` +
    "`zsh -ic 'gcp tadakayo && gcloud auth login'` で認証し直してください。"
  );
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

function headers(token, project) {
  return {
    Authorization: `Bearer ${token}`,
    "x-goog-user-project": project, // これが無いと quota project 未設定で 403
    "Content-Type": "application/json",
  };
}

function scrubToken(text, token) {
  let s = String(text ?? "");
  if (token) s = s.split(token).join("***REDACTED***");
  return s.replace(/ya29\.[A-Za-z0-9._\-]+/g, "***REDACTED***");
}

/** 今の承認済みドメイン一覧を読む */
export async function readAuthorizedDomains(token, project = PROJECT) {
  const res = await fetch(CONFIG_URL(project), { headers: headers(token, project) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`承認済みドメインを読めません（HTTP ${res.status}）: ${scrubToken(text, token).slice(0, 500)}`);
  }
  const j = JSON.parse(text);
  // 想定外の形の応答を「空の一覧」と取り違えると、和集合が既存分を落とす。config 本体かを確かめる
  // name はプロジェクト番号で返る（例 projects/677262660109/config）ので形だけを見る
  if (!/^projects\/[^/]+\/config$/.test(String(j?.name ?? ""))) {
    throw new Error(`承認済みドメインの応答が想定外の形です（name=${j?.name ?? "なし"}）。書き込みを中止します`);
  }
  return Array.isArray(j.authorizedDomains) ? j.authorizedDomains : [];
}

/**
 * 一覧を書き込む（丸ごと置き換え）。直接呼ばないこと。必ず planAdd / planRemove の結果を渡す。
 * 書いたあと読み戻して、送った一覧と完全に一致するかを確かめる。
 */
export async function writeAuthorizedDomains(token, next, project = PROJECT, { basedOn } = {}) {
  const miss = missingRequired(next);
  if (miss.length) throw new Error(`必須ドメインが欠けた一覧は送りません: ${miss.join(", ")}`);
  if (!Array.isArray(next) || next.length === 0) throw new Error("空の一覧は送りません");
  if (!Array.isArray(basedOn)) throw new Error("内部エラー: 計画の元にした一覧（basedOn）がありません");

  // 計画を立てたあとに誰か（CLI のプレビューデプロイ等）が一覧を変えていたら、上書きで消さないよう中止する
  const fresh = await readAuthorizedDomains(token, project);
  const same = (a, b) => {
    const x = [...a].map((d) => d.toLowerCase()).sort();
    const y = [...b].map((d) => d.toLowerCase()).sort();
    return x.length === y.length && x.every((d, i) => d === y[i]);
  };
  if (!same(fresh, basedOn)) {
    throw new Error("計画を立てたあとに承認済みドメインが変わりました。書き込まずに中止します。もう一度実行してください");
  }

  const res = await fetch(`${CONFIG_URL(project)}?updateMask=authorizedDomains`, {
    method: "PATCH",
    headers: headers(token, project),
    body: JSON.stringify({ authorizedDomains: next }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`承認済みドメインの書き込みに失敗（HTTP ${res.status}）: ${scrubToken(text, token).slice(0, 500)}`);
  }

  const after = await readAuthorizedDomains(token, project);
  const a = new Set(after.map((d) => d.toLowerCase()));
  const notApplied = next.filter((d) => !a.has(d));
  const missAfter = missingRequired(after);
  // 足す操作なら「書く前の一覧 ⊆ 読み戻し」、消す操作なら「残すはずのもの ⊆ 読み戻し」= next に含まれる元の分
  const lost = fresh.map((d) => d.toLowerCase()).filter((d) => next.includes(d) && !a.has(d));
  if (notApplied.length || missAfter.length || lost.length) {
    throw new Error(
      "書き込み後の読み戻しで一致しません。至急 `node scripts/auth-domains.mjs check` で確認してください。\n" +
      `  反映されていない: ${notApplied.join(", ") || "なし"}\n` +
      `  元からあったのに消えた: ${lost.join(", ") || "なし"}\n` +
      `  必須で欠けている: ${missAfter.join(", ") || "なし"}`
    );
  }
  return after;
}
