// GA4 Data API / Search Console API 用の「ユーザーOAuthリフレッシュトークン」をローカルで取得する。
// タダカヨ内部OAuthクライアント(gcp-oauth.keys.json)を使い、loopbackフローで refresh_token を得る。
// 取得後 /tmp/ga_oauth_token.json に保存する（その後 Secret Manager に投入）。
const http = require("http");
const fs = require("fs");

const KEYS = JSON.parse(fs.readFileSync("/Users/yoshinaotsukuda/.gmail-mcp/gcp-oauth.keys.json", "utf8")).installed;
const PORT = 4571;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");

const authUrl = `${KEYS.auth_uri}?` + new URLSearchParams({
  client_id: KEYS.client_id,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: SCOPES,
  access_type: "offline",
  prompt: "consent",
  include_granted_scopes: "true",
}).toString();

console.log("AUTH_URL:");
console.log(authUrl);
console.log("（このURLをブラウザで開き、yoshinao-tsukuda@tadakayo.jp で承認してください。待機中…）");

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  const code = u.searchParams.get("code");
  const err = u.searchParams.get("error");
  if (err) {
    res.end(`認証エラー: ${err}。ターミナルに戻ってください。`);
    console.error("OAUTH_ERROR:", err); server.close(); process.exit(1); return;
  }
  if (!code) { res.statusCode = 400; res.end("no code"); return; }
  try {
    const r = await fetch(KEYS.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: KEYS.client_id, client_secret: KEYS.client_secret,
        redirect_uri: REDIRECT, grant_type: "authorization_code",
      }).toString(),
    });
    const tok = await r.json();
    if (!tok.refresh_token) {
      res.end("リフレッシュトークンが取得できませんでした。ターミナルを確認してください。");
      console.error("NO_REFRESH_TOKEN:", JSON.stringify(tok)); server.close(); process.exit(1); return;
    }
    fs.writeFileSync("/tmp/ga_oauth_token.json", JSON.stringify({
      refresh_token: tok.refresh_token, client_id: KEYS.client_id, client_secret: KEYS.client_secret,
    }));
    res.end("認証完了。このタブを閉じてターミナルに戻ってください。");
    console.log("REFRESH_TOKEN_OBTAINED scope=", tok.scope);
    server.close(); process.exit(0);
  } catch (e) {
    res.end("token exchange失敗"); console.error("EXCHANGE_ERR:", e.message); server.close(); process.exit(1);
  }
});
server.listen(PORT, () => console.log(`listening ${REDIRECT}`));
