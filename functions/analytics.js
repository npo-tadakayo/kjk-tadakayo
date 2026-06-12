// functions/analytics.js — LP アクセス解析の日次収集
// GA4 Data API（閲覧数・流入）＋ Google Search Console API（検索/SEO）を
// サービスアカウント認証で取得し、Firestore に保存する。
//
// 設定は Firestore appConfig/analytics で行う（再デプロイ不要）:
//   { enabled: true,
//     ga4PropertyId: "123456789",                 // GA4「プロパティID」(数値。測定ID G-... ではない)
//     scSiteUrl: "sc-domain:tadakayo.jp" }         // または "https://kjk.tadakayo.jp/"
//
// 必要な事前準備（GCP/各ツール側・別途 runbook 参照）:
//   - GA4 Data API / Search Console API を有効化
//   - 下記 SA を GA4 プロパティに「閲覧者」、Search Console に「ユーザー」として追加
//   - SA に datastore.user（Firestore 書き込み）

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { defineSecret } = require("firebase-functions/params");

const REGION = "asia-northeast1";
const SA_ANALYTICS = "fn-analytics-sa@kjk-tadakayo.iam.gserviceaccount.com";

// GA4 UI / gcloud では SA を GA4・Search Console に追加できないため、
// GA4プロパティ管理者(次田さん)のユーザーOAuthトークンで Data API / SC を読む。
// Secret 値 = JSON {refresh_token, client_id, client_secret}（analytics.readonly + webmasters.readonly）
const ANALYTICS_OAUTH_TOKEN = defineSecret("ANALYTICS_OAUTH_TOKEN");

async function accessToken() {
  const cfg = JSON.parse(ANALYTICS_OAUTH_TOKEN.value());
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.client_id, client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token, grant_type: "refresh_token",
    }).toString(),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error("OAuth refresh failed: " + JSON.stringify(t).slice(0, 200));
  return t.access_token;
}

async function apiPost(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ---- 日付ヘルパ（JST基準・SCは2〜3日遅延するので余裕を見て28日窓） ----
function ymd(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function ga4DateToIso(s) { return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; }

const RANGE_DAYS = 28;

async function fetchGa4(propertyId, token) {
  const base = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const dateRanges = [{ startDate: `${RANGE_DAYS - 1}daysAgo`, endDate: "yesterday" }];

  const daily = await apiPost(base, {
    dateRanges,
    dimensions: [{ name: "date" }],
    metrics: [{ name: "screenPageViews" }, { name: "sessions" }, { name: "totalUsers" }],
    orderBys: [{ dimension: { dimensionName: "date" } }],
  }, token);

  const pages = await apiPost(base, {
    dateRanges,
    dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
    metrics: [{ name: "screenPageViews" }],
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit: 10,
  }, token);

  const channels = await apiPost(base, {
    dateRanges,
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 8,
  }, token);

  const dailyRows = (daily.rows || []).map((r) => ({
    date: ga4DateToIso(r.dimensionValues[0].value),
    pv: Number(r.metricValues[0].value || 0),
    sessions: Number(r.metricValues[1].value || 0),
    users: Number(r.metricValues[2].value || 0),
  }));
  const topPages = (pages.rows || []).map((r) => ({
    path: r.dimensionValues[0].value,
    title: r.dimensionValues[1].value,
    pv: Number(r.metricValues[0].value || 0),
  }));
  const channelRows = (channels.rows || []).map((r) => ({
    channel: r.dimensionValues[0].value,
    sessions: Number(r.metricValues[0].value || 0),
  }));
  return { dailyRows, topPages, channelRows };
}

async function fetchSearchConsole(siteUrl, token) {
  const enc = encodeURIComponent(siteUrl);
  const base = `https://searchconsole.googleapis.com/webmasters/v3/sites/${enc}/searchAnalytics/query`;
  const startDate = ymd(daysAgo(RANGE_DAYS));
  const endDate = ymd(daysAgo(1));

  const daily = await apiPost(base, { startDate, endDate, dimensions: ["date"], rowLimit: 1000 }, token);
  const queries = await apiPost(base, { startDate, endDate, dimensions: ["query"], rowLimit: 10 }, token);

  const dailyRows = (daily.rows || []).map((r) => ({
    date: r.keys[0],
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));
  const topQueries = (queries.rows || []).map((r) => ({
    query: r.keys[0],
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));
  return { dailyRows, topQueries };
}

// GA4 と SC を日付でマージし、合計を出す
function buildSummary(ga4, sc) {
  const byDate = {};
  ga4.dailyRows.forEach((r) => { byDate[r.date] = { date: r.date, pv: r.pv, sessions: r.sessions, users: r.users, clicks: 0, impressions: 0 }; });
  sc.dailyRows.forEach((r) => {
    const e = byDate[r.date] || (byDate[r.date] = { date: r.date, pv: 0, sessions: 0, users: 0 });
    e.clicks = r.clicks; e.impressions = r.impressions; e.position = r.position;
  });
  const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
  const totalClicks = sum(sc.dailyRows, "clicks");
  const totalImpr = sum(sc.dailyRows, "impressions");
  // 平均掲載順位は表示回数で加重
  const wPos = totalImpr ? sc.dailyRows.reduce((s, x) => s + (x.position || 0) * (x.impressions || 0), 0) / totalImpr : 0;

  return {
    rangeDays: RANGE_DAYS,
    totals: {
      pv: sum(ga4.dailyRows, "pv"),
      sessions: sum(ga4.dailyRows, "sessions"),
      users: sum(ga4.dailyRows, "users"),
      clicks: totalClicks,
      impressions: totalImpr,
      ctr: totalImpr ? totalClicks / totalImpr : 0,
      position: wPos,
    },
    daily,
    topPages: ga4.topPages,
    topQueries: sc.topQueries,
    channels: ga4.channelRows,
  };
}

async function collectCore() {
  const db = admin.firestore();
  const cfgSnap = await db.collection("appConfig").doc("analytics").get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  if (cfg.enabled === false) return { skipped: "disabled" };
  if (!cfg.ga4PropertyId && !cfg.scSiteUrl) {
    return { skipped: "未設定（appConfig/analytics に ga4PropertyId / scSiteUrl を設定してください）" };
  }

  const token = await accessToken();
  const ga4 = cfg.ga4PropertyId
    ? await fetchGa4(String(cfg.ga4PropertyId), token)
    : { dailyRows: [], topPages: [], channelRows: [] };
  const sc = cfg.scSiteUrl
    ? await fetchSearchConsole(cfg.scSiteUrl, token)
    : { dailyRows: [], topQueries: [] };

  const summary = buildSummary(ga4, sc);
  summary.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  summary.range = { start: summary.daily[0]?.date || null, end: summary.daily.at(-1)?.date || null };

  await db.collection("analyticsSummary").doc("latest").set(summary);
  // 日次スナップショットも保存（履歴・後で長期グラフに使える）
  const batch = db.batch();
  summary.daily.forEach((d) => batch.set(db.collection("analyticsDaily").doc(d.date), d, { merge: true }));
  await batch.commit();

  return { ok: true, days: summary.daily.length, totals: summary.totals };
}

// 毎日 6:30 JST（GA4/SCの前日分が揃う頃）
exports.collectAnalytics = onSchedule(
  { schedule: "30 6 * * *", timeZone: "Asia/Tokyo", region: REGION, serviceAccount: SA_ANALYTICS, timeoutSeconds: 120, secrets: [ANALYTICS_OAUTH_TOKEN] },
  async () => { const r = await collectCore(); console.log("collectAnalytics:", JSON.stringify(r)); }
);

// 管理画面の「今すぐ更新」ボタン用（登録スタッフのみ）
exports.collectAnalyticsNow = onCall(
  { region: REGION, serviceAccount: SA_ANALYTICS, timeoutSeconds: 120, secrets: [ANALYTICS_OAUTH_TOKEN] },
  async (request) => {
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "権限がありません");
    try {
      return await collectCore();
    } catch (e) {
      throw new HttpsError("internal", String(e.message || e));
    }
  }
);
