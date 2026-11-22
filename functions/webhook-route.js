// Google Chat の投稿先の解決（2026-10-19 Webhook設定メニュー／2026-11-22 受付通知・今日の対応を追加）。
// 判定だけを持つ（Firestore・Secret には触れない）。テスト: node scripts/test-webhook-route.mjs
//
// kind:
//   crm        … CRM通知（従来の投稿先＝TM。設定が空なら Secret CHAT_WEBHOOK_URL）
//   reception  … 受付通知（LP問い合わせ・お申し込み・発注・受注確定・担当決定・承諾書の署名）
//   daily      … 今日の対応（毎朝9時の日次フォローアップ）
//   pm / shipping / accounting … 従来どおり
//
// 停止スイッチ（<kind>ChatWebhookEnabled）が false なら '' を返す（未定義は「有効」扱い）。
// URL が空のとき: reception・daily は crm の送り先へ回す（設定を入れる前に通知が止まらないように）。
//   crm は Secret の値へ。pm・shipping・accounting は ''（従来どおり）。
const WEBHOOK_FIELDS = {
  crm: { url: "chatWebhookUrl", enabled: "chatWebhookEnabled" },
  reception: { url: "receptionChatWebhookUrl", enabled: "receptionChatWebhookEnabled" },
  daily: { url: "dailyChatWebhookUrl", enabled: "dailyChatWebhookEnabled" },
  pm: { url: "pmChatWebhookUrl", enabled: "pmChatWebhookEnabled" },
  shipping: { url: "shippingChatWebhookUrl", enabled: "shippingChatWebhookEnabled" },
  accounting: { url: "accountingChatWebhookUrl", enabled: "accountingChatWebhookEnabled" },
};
// URL が空のときに回す先
const WEBHOOK_FALLBACK = { reception: "crm", daily: "crm" };
// Secret CHAT_WEBHOOK_URL を読む kind（自分か回す先が crm のもの）。この kind の通知を出す関数は secrets に CHAT_WEBHOOK_URL が要る
const KINDS_USING_CRM_SECRET = ["crm", "reception", "daily"];

function resolveWebhook(kind, s, secretValue) {
  const f = WEBHOOK_FIELDS[kind];
  if (!f) return "";
  const st = s || {};
  if (st[f.enabled] === false) return "";
  const url = String(st[f.url] || "").trim();
  if (url) return url;
  if (WEBHOOK_FALLBACK[kind]) return resolveWebhook(WEBHOOK_FALLBACK[kind], st, secretValue);
  return kind === "crm" ? (secretValue || "") : "";
}

module.exports = { WEBHOOK_FIELDS, WEBHOOK_FALLBACK, KINDS_USING_CRM_SECRET, resolveWebhook };
