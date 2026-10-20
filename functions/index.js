const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");

// 金額の桁区切り。Cloud Functions の実行環境では Number#toLocaleString が桁区切りを付けないことがある（2026-09-14 実測: ロケール指定でも "64000"）。
// Intl に依存せず正規表現で付ける。
function fmtNum(n) {
  const v = Math.round(Number(n) || 0);
  const sign = v < 0 ? "-" : "";
  return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const { GoogleAuth } = require("google-auth-library");
const Pricing = require("./estimate-pricing"); // 見積もりの価格ロジック（公開ページと同じ計算）
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { checkStaffAccept, STAFF_ACCEPT_CHANNELS } = require("./accept-rules"); // スタッフ受注の拒否条件（純粋関数）
const Flow = require("./accept-flow"); // 受注確定・通知・認可の判定（純粋関数・テスト scripts/test-functions-wiring.mjs）
// 通知の分類と文面（純粋 ESM）。CommonJS からは import() で遅延ロードする
let _nt;
const loadNotify = () => (_nt ||= import("./notify-text.mjs"));

admin.initializeApp();
const db = admin.firestore();

const CHAT_WEBHOOK_URL = defineSecret("CHAT_WEBHOOK_URL");

// H-3 関数別の専用SA（最小権限・SECURITY_REMEDIATION H-3）。compute SA(editor)依存を解消。
const SA_WEBHOOK = "fn-webhook-sa@kjk-tadakayo.iam.gserviceaccount.com"; // datastore.user + CHAT secretAccessor
                                                                        // + kjk-gmail-sa tokenCreator（2026-09-09・問い合わせ通知メール用。宛先は自分たちの受信箱に固定）
const SA_BATCH   = "fn-batch-sa@kjk-tadakayo.iam.gserviceaccount.com";   // datastore.user + CHAT secretAccessor
const SA_AI      = "fn-ai-sa@kjk-tadakayo.iam.gserviceaccount.com";      // aiplatform.user のみ
// ⚠️ デプロイ手順（2026-10-21）: aiAssist は requireStaff で users を読むので、fn-ai-sa に Firestore の読み取り権限
//    （roles/datastore.viewer 以上）が要る。無いと aiAssist が「権限の確認に失敗しました」（internal）になる。→ 2026-10-21 付与済み
//    gcloud projects add-iam-policy-binding kjk-tadakayo --member=serviceAccount:fn-ai-sa@kjk-tadakayo.iam.gserviceaccount.com --role=roles/datastore.viewer
const SA_MAIL    = "fn-mail-sa@kjk-tadakayo.iam.gserviceaccount.com";    // datastore.user + kjk-gmail-sa tokenCreator

// アプリ設定（Firestore appConfig/settings）を読む。60秒キャッシュ・未設定は.env/既定にフォールバック
let _settingsCache = null, _settingsAt = 0;
async function getSettings() {
  if (_settingsCache && Date.now() - _settingsAt < 60000) return _settingsCache;
  try {
    const snap = await db.collection("appConfig").doc("settings").get();
    _settingsCache = snap.exists ? snap.data() : {};
  } catch (e) {
    console.warn("getSettings failed:", e.message);
    _settingsCache = _settingsCache || {};
  }
  _settingsAt = Date.now();
  return _settingsCache;
}
// 投稿先の解決（2026-10-19 Webhook設定メニュー）。kind: 'crm' | 'pm' | 'shipping' | 'accounting'
// 停止スイッチ（<kind>ChatWebhookEnabled）が false のとき、または URL が空のときは '' を返す。未定義は「有効」扱い。
// crm だけは従来どおり Secret CHAT_WEBHOOK_URL へのフォールバックを残す（設定が空でも通知を止めない）。
const WEBHOOK_FIELDS = {
  crm: { url: "chatWebhookUrl", enabled: "chatWebhookEnabled" },
  pm: { url: "pmChatWebhookUrl", enabled: "pmChatWebhookEnabled" },
  shipping: { url: "shippingChatWebhookUrl", enabled: "shippingChatWebhookEnabled" },
  accounting: { url: "accountingChatWebhookUrl", enabled: "accountingChatWebhookEnabled" },
};
function resolveWebhook(kind, s, secretValue) {
  const f = WEBHOOK_FIELDS[kind];
  if (!f) return "";
  const st = s || {};
  if (st[f.enabled] === false) return "";
  const url = String(st[f.url] || "").trim();
  if (url) return url;
  return kind === "crm" ? (secretValue || "") : "";
}
async function getWebhook(kind) {
  const s = await getSettings();
  return resolveWebhook(kind, s, kind === "crm" ? CHAT_WEBHOOK_URL.value() : "");
}

// 通知本文用の地域ラベル「【大阪府 豊中市】」。住所が手元になければ offices から引く。取れなければ「（地域不明）」。
// 利用者・被保険者の情報は扱わない（事業所の都道府県・市区町村のみ）。
// 住所の先頭から「都道府県」「市区町村」を拾う。offices には prefecture/city が無く address しか無いことが多い。
// 政令市は「大阪市北区」まで、郡部は「八重瀬町」（郡名を除く）。「大和郡山市」のように市名に「郡」を含む場合は市を優先。
// 取れなければ空オブジェクト
function regionFromAddress(addr) {
  const a = String(addr || "").replace(/^\s*〒?\s*\d{3}-?\d{4}\s*/, "").replace(/\s+/g, "");
  const m = /^(東京都|北海道|(?:京都|大阪)府|.{2,3}?県)/.exec(a);
  if (!m) return {};
  const rest = a.slice(m[1].length);
  const iShi = rest.indexOf("市"), iGun = rest.indexOf("郡");
  let city = "";
  if (iGun > 0 && (iShi < 0 || iGun < iShi)) {
    const g = /^.+?郡(.+?[町村])/.exec(rest);
    if (g && !g[1].includes("市")) city = g[1]; // 「大和郡山市…町」を郡として読まない
  }
  if (!city) {
    const c = /^(.+?市.+?区|.+?[市区町村])/.exec(rest);
    if (c) city = c[1];
    // 「○○市△△区」は政令市のときだけ区まで残す（「市川市八幡」等で誤って区まで伸ばさない）
    if (/^.+?市.+?区$/.test(city) && !/^(札幌|仙台|さいたま|千葉|横浜|川崎|相模原|新潟|静岡|浜松|名古屋|京都|大阪|堺|神戸|岡山|広島|北九州|福岡|熊本)市/.test(city)) {
      city = city.replace(/^(.+?市).*$/, "$1");
    }
  }
  return { prefecture: m[1], city };
}
function formatRegion(prefecture, city) {
  const t = [prefecture, city].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
  return t ? `【${t}】` : "（地域不明）";
}
async function officeRegionLabel({ prefecture, city, officeId } = {}) {
  let pref = prefecture, cty = city;
  if (!(pref || cty) && officeId) {
    try {
      const od = await db.collection("offices").doc(String(officeId)).get();
      if (od.exists) {
        const o = od.data();
        pref = o.prefecture; cty = o.city;
        if (!(pref || cty)) { const r = regionFromAddress(o.address); pref = r.prefecture; cty = r.city; }
      }
    } catch (e) { console.warn("officeRegionLabel failed:", e.message); }
  }
  return formatRegion(pref, cty);
}

// ===== Vertex AI (Gemini) — SA認証/ADC・鍵なし =====
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "kjk-tadakayo";

// 送付日・報告日は JST の日付で記録する（new Date().toISOString() は UTC なので、
// JSTの深夜0〜9時台に送ると前日の日付になってしまう。2026-09-06 実機テストで発覚）
function todayJst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

// データレジデンシー(個人情報の国内処理)のため既定を asia-northeast1 とする。
// global は data residency 非対応のため使用しない（開発チーム指摘 H-5）。
const VERTEX_LOCATION = process.env.VERTEX_AI_LOCATION || "asia-northeast1";
let _genai;
function genai() {
  if (!_genai) {
    _genai = new GoogleGenAI({ vertexai: true, project: VERTEX_PROJECT, location: VERTEX_LOCATION });
  }
  return _genai;
}

// ステータス定数
const STATUS = {
  NEW: 1,          // 新規受信
  CONFIRMING: 2,   // 確認中
  ORDERED: 3,      // 受注確定
  LOST: 4,         // 失注
  ASSIGNED: 5,     // 担当者決定
  PREPARING: 6,    // 事前準備中
  WAITING: 7,      // 伴走支援待ち
  SUPPORTED: 8,    // 伴走支援実施済
  GUIDING: 9,      // 書類準備完了・申請ガイド中
  APPLIED: 10,     // 申請完了・採択待ち
  ADOPTED: 11,     // 採択・入金待ち
  FOLLOWUP: 12,    // アフターフォロー中
  COMPLETED: 13,   // 案件完了
};

// 練習生（users.role == "trainee"）は本番の Callable を使えない（2026-10-20 テストモード）。
// 画面は練習中に Functions を呼ばない（admin/js/fn.js）が、SDK から直接呼べば届いてしまうので、ここでも止める。
// Admin SDK は Firestore ルールを迂回するため、ルールの拒否だけでは足りない（Codex レビュー指摘）。
// 未登録の人の扱いは各関数の従来どおり（ここでは練習生だけを止める）。
// 2026-10-21 統合: requireStaff（下）が練習生も拒否するので、requireStaff を使う Callable はそちらだけを呼ぶ。
// rejectTrainee は独自の権限確認を持つ notifyShipment だけが使う。
async function rejectTrainee(request) {
  const email = request.auth?.token?.email || "";
  if (!email) return;
  const u = await db.collection("users").doc(email).get();
  if (u.exists && u.data().role === "trainee") {
    throw new HttpsError("permission-denied", "練習生のアカウントでは本番の操作はできません（練習モードで操作してください）");
  }
}

// 案件番号の自動採番
async function getNextCaseNumber() {
  const counterRef = db.collection("_counters").doc("cases");
  const result = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const next = (doc.exists ? doc.data().value : 0) + 1;
    tx.set(counterRef, { value: next });
    return next;
  });
  return result;
}

// 見積番号の採番（年ごとに 0001 から）: EST-2026-0001
async function getNextQuoteNumber() {
  const year = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 4);
  const counterRef = db.collection("_counters").doc(`quotes_${year}`);
  const next = await db.runTransaction(async (tx) => {
    const d = await tx.get(counterRef);
    const n = (d.exists ? d.data().value : 0) + 1;
    tx.set(counterRef, { value: n });
    return n;
  });
  return `EST-${year}-${String(next).padStart(4, "0")}`;
}

// 問い合わせの「ご希望」（2026-09-05 MTG §6・決定事項10）。不正・欠落は consult 扱い。
const INQUIRY_INTENTS = ["consult", "quote", "order"];
const INQUIRY_INTENT_LABEL = {
  consult: "まず相談したい",
  quote: "見積書がほしい",
  order: "正式に申込みたい",
};
const INQUIRY_INTENT_EMOJI = { consult: "📥", quote: "📝", order: "🛒" };
function normalizeIntent(v) {
  return INQUIRY_INTENTS.includes(v) ? v : "consult";
}

// 推測不能なトークン（128bit）。leadTokens のID・見積もりの accessToken に使う
function newToken() {
  return require("crypto").randomBytes(16).toString("hex");
}
function daysFromNow(n) {
  return admin.firestore.Timestamp.fromDate(new Date(Date.now() + n * 24 * 60 * 60 * 1000));
}

// 同じメール＋同じ事業所名で、まだ動いている案件（失注・完了以外）があれば返す。
// 問い合わせ→見積もりと進んだ事業所の案件が2件に割れないようにするため（2026-09-06）。
// contactEmail の等価条件だけで引き、並べ替えは手元で行う（複合インデックス不要）。
async function findActiveCase(email, officeName) {
  if (!email) return null;
  // 同じメールの案件が多い事業所でも取りこぼさないよう、受信日の新しい順に全件見る
  // （contactEmail の等価 + receivedAt の並べ替えは単一フィールドの複合なので既定インデックスで通る）
  const snap = await db.collection("cases")
    .where("contactEmail", "==", email)
    .orderBy("receivedAt", "desc")
    .get();
  const hit = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .find((c) => (c.officeName || "") === (officeName || "")
      && c.status !== STATUS.LOST && c.status !== STATUS.COMPLETED);
  return hit || null;
}

// 継続トークンを発行して、その後の見積もり・申し込みを同じ案件に繋ぐ
async function issueLeadToken(caseId, officeId, prefill) {
  const token = newToken();
  await db.collection("leadTokens").doc(token).set({
    caseId, officeId, email: prefill.email || "",
    prefill,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: daysFromNow(30),
    usedFor: [],
  });
  return token;
}
async function readLeadToken(token) {
  if (!token || typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  const d = await db.collection("leadTokens").doc(token).get();
  if (!d.exists) return null;
  const t = d.data();
  if (t.expiresAt && t.expiresAt.toMillis() < Date.now()) return null;
  return { id: d.id, ...t };
}

// LP問い合わせの通知メール（事務局宛）。
// 2026-09-09 まで、この通知は外部サービス（Formspree）が担っていた。そこへ問い合わせの内容
// （氏名・連絡先・住所）がそのまま渡っていたため、タダカヨのサーバーから送る形に置き換えた。
// ⚠️ 宛先は設定の送信元アドレス（＝自分たちの受信箱）に固定する。入力値を宛先にしない
//    （公開エンドポイントなので、宛先を外から指定できると迷惑メールの踏み台になる）。
// 送信に失敗しても問い合わせの受付そのものは止めない（Chat通知と同じ扱い）。
async function notifyInquiryMail({ officeName, corpName, name, phone, email, postalCode,
                                   prefecture, city, addressDetail, message, caseNumber, caseId, existing }) {
  try {
    const box = (await getSettings()).gmailSender || GMAIL_SENDER;
    const addr = [postalCode ? `〒${postalCode}` : "", prefecture, city, addressDetail]
      .filter(Boolean).join(" ");
    const head = existing
      ? `既存の案件 #${caseNumber} に追記されました（同じ事業所からの再問い合わせ）`
      : `新しい案件 #${caseNumber} として登録しました`;
    await sendGmail({
      to: box,
      subject: `【LP問い合わせ】${officeName || "（事業所名なし）"}（案件 #${caseNumber}）`,
      body:
        `${head}\n\n` +
        `法人名: ${corpName || "—"}\n` +
        `事業所名: ${officeName || "—"}\n` +
        `ご担当者: ${name || "—"}\n` +
        `電話: ${phone || "—"}\n` +
        `メール: ${email || "—"}\n` +
        `住所: ${addr || "—"}\n\n` +
        `ご相談内容:\n${message || "（記載なし）"}\n\n` +
        `--- CRM で開く ---\n` +
        `https://kjk-tadakayo-admin.web.app/case-detail.html?id=${caseId}\n`,
    });
  } catch (e) {
    console.error("問い合わせ通知メールの送信に失敗:", e.message);
  }
}

// Google Chat に通知
async function notifyChat(webhookUrl, message) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (e) {
    console.error("Chat通知失敗:", e.message);
  }
}

// ===== Callable の共通認可（2026-10-21 設計 §4 P）=====
// users/{email} に登録があり active===true の人だけ通す。allow:
//   "viewer" … 登録済み・有効なら誰でも／"editor" … 閲覧のみ（viewer）以外／"admin" … 管理者のみ
// firestore.rules の isRegistered / isEditor / isAdmin と同じ考え方。users の doc id はログインのメール
// （rules と同じ）。大文字が混じる登録に備えて小文字でも引く。
// ⚠️ 呼び出す関数の SA に Firestore の読み取り権限が要る（fn-ai-sa は aiplatform.user のみだったので追加が必要）。
async function requireStaff(request, { allow = "editor" } = {}) {
  const email = String(request.auth?.token?.email || "").trim();
  if (!email || !email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
  let snap;
  try {
    snap = await db.collection("users").doc(email).get();
    if (!snap.exists && email.toLowerCase() !== email) snap = await db.collection("users").doc(email.toLowerCase()).get();
  } catch (e) {
    // 実行 SA に Firestore の読み取り権限が無いと PERMISSION_DENIED(7) の素の例外になる。画面には分かる文言で返す（レビュー指摘 9）
    console.error("requireStaff: users の読み取りに失敗", e && e.code, (e && e.message) || e);
    throw new HttpsError("internal", "権限の確認に失敗しました（サービスアカウントの Firestore 読み取り権限を確認）");
  }
  const user = snap.exists ? snap.data() : null;
  // 練習生（trainee）は本番の Callable をどれも使えない（2026-10-20 テストモードの rejectTrainee をここに統合。
  // Flow.roleAllows も trainee を通さないが、分かる文言で返すため先に判定する）
  if (user && user.role === "trainee") {
    throw new HttpsError("permission-denied", "練習生のアカウントでは本番の操作はできません（練習モードで操作してください）");
  }
  if (!Flow.roleAllows(user, allow)) {
    const msg = allow === "admin" ? "この操作は管理者だけができます"
      : allow === "editor" ? "この操作をする権限がありません（閲覧のみの利用者・未登録・無効の利用者はできません）"
        : "このアプリの利用権限がありません";
    throw new HttpsError("permission-denied", msg);
  }
  return { email, uid: request.auth.uid, user, name: user.name || user.displayName || request.auth?.token?.name || email };
}

// ===== App Check 手動検証（M-1 Webhook保護・段階移行 / SECURITY_REMEDIATION M-1） =====
// onRequest(HTTP) は callable と違い App Check の自動強制が効かないため、
// クライアントが付与した X-Firebase-AppCheck ヘッダを admin.appCheck().verifyToken() で手動検証する。
// 既定で強制モード（検証失敗を 401 で弾く・fail-secure）。観察モードへ戻すには env APPCHECK_ENFORCE=false を設定。
const APPCHECK_ENFORCE = process.env.APPCHECK_ENFORCE !== "false";

async function verifyAppCheck(req) {
  const token = req.header("X-Firebase-AppCheck");
  if (!token) return { ok: false, reason: "missing-token" };
  try {
    await admin.appCheck().verifyToken(token);
    return { ok: true, reason: "verified" };
  } catch (e) {
    return { ok: false, reason: "invalid:" + ((e.errorInfo && e.errorInfo.code) || e.code || e.message || "unknown") };
  }
}

// App Check ゲート。観察モード(enforce=false)の間は弾かず、検証結果をログするのみ。
// 戻り値 true = 既にレスポンス送信済み（呼び出し側は return して処理を中断する）。
async function appCheckGate(req, res, label) {
  const r = await verifyAppCheck(req);
  if (r.ok) {
    // 観察モード中は成功も記録し、verified/failed 比率を見て Phase B 切替を判断する。
    if (!APPCHECK_ENFORCE) console.log(`[AppCheck][${label}] observe: verified`);
    return false;
  }
  if (APPCHECK_ENFORCE) {
    console.warn(`[AppCheck][${label}] reject(enforce): ${r.reason}`);
    res.status(401).json({ status: "unauthorized", reason: "app-check-failed" });
    return true;
  }
  console.warn(`[AppCheck][${label}] observe(pass-through): ${r.reason}`);
  return false;
}

// LP 問い合わせ Webhook（index.html のお問い合わせフォームから）
exports.webhookLpInquiry = onRequest(
  { region: "asia-northeast1", cors: true, secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_WEBHOOK },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // App Check 検証（観察モード: APPCHECK_ENFORCE=false の間は弾かず warn のみ）
    if (await appCheckGate(req, res, "webhookLpInquiry")) return;

    try {
      const body = req.body;
      const now = admin.firestore.FieldValue.serverTimestamp();
      const officeName = body.officeName || body.name || "";
      // ご希望（まず相談したい/見積書がほしい/正式に申込みたい）。不正・欠落は consult 扱い（2026-09-05 MTG §6）。
      const intent = normalizeIntent(body.intent);

      // 重複チェック（同じメール＋同じ事業所名＋5分以内）。
      // 事業所名を見ずに時刻だけで判定すると、同じ担当者が別事業所の分を
      // 続けて送ったときに2件目が誤って捨てられていた（2026-09-06 修正）。
      const recentSnap = await db
        .collection("cases")
        .where("contactEmail", "==", body.email || "")
        .where("source", "==", "lp_inquiry")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get();

      if (!recentSnap.empty) {
        const lastCase = recentSnap.docs[0].data();
        const lastTime = lastCase.receivedAt?.toDate?.() || new Date(0);
        const sameOffice = (lastCase.officeName || "") === officeName;
        if (sameOffice && Date.now() - lastTime.getTime() < 5 * 60 * 1000) {
          res.status(200).json({ status: "duplicate" });
          return;
        }
      }

      const prefill = {
        corpName: body.corpName || "", officeName, contactName: body.name || "",
        phone: body.phone || "", email: body.email || "",
        postalCode: body.postalCode || "", prefecture: body.prefecture || "", city: body.city || "",
        addressDetail: body.addressDetail || "",
      };

      // 同じ事業所の動いている案件があれば、新しく作らずそこに追記する（案件が2件に割れない）
      const existing = await findActiveCase(body.email || "", officeName);
      if (existing) {
        const token = await issueLeadToken(existing.id, existing.officeId || "", prefill);
        await db.collection("activities").add({
          caseId: existing.id, type: "memo", occurredAt: now, userId: "system",
          subject: "LP問い合わせ受信（同じ事業所からの再問い合わせ）",
          body: `ご希望: ${INQUIRY_INTENT_LABEL[intent]}\n${body.message || ""}`, attachmentUrls: [],
        });
        // 同じ事業所からの再問い合わせは、最新の希望を採用する（既存案件の inquiryIntent を更新）
        await db.collection("cases").doc(existing.id)
          .update({ updatedAt: now, message: body.message || existing.message || "", inquiryIntent: intent });
        const chatWebhook = await getWebhook("crm");
        const regionLp = await officeRegionLabel({ prefecture: body.prefecture, city: body.city, officeId: existing.officeId });
        await notifyChat(
          chatWebhook,
          `${INQUIRY_INTENT_EMOJI[intent]} LP問い合わせ（既存の案件 #${existing.caseNumber} に追記）\nご希望: ${INQUIRY_INTENT_LABEL[intent]}\n事業所: ${regionLp}${officeName}\n担当者: ${body.name || ""}\nメッセージ: ${body.message || ""}`
        );
        await notifyInquiryMail({
          officeName, corpName: body.corpName || "", name: body.name || "", phone: body.phone || "",
          email: body.email || "", postalCode: body.postalCode || "", prefecture: body.prefecture || "",
          city: body.city || "", addressDetail: body.addressDetail || "", message: body.message || "",
          caseNumber: existing.caseNumber, caseId: existing.id, existing: true,
        });
        res.status(200).json({ status: "ok", caseId: existing.id, caseNumber: existing.caseNumber, token, existing: true, intent });
        return;
      }

      const caseNumber = await getNextCaseNumber();

      // 住所は「都道府県／市町村／建物名等」の3カラムで受け、表示用に結合した文字列も持つ
      // （2026-09-06 フォームに追加。offices.address は既存の読み手（出荷先プリフィル等）が
      //   結合済み文字列を前提にしているため、結合形は変えずに残す）
      const prefecture = body.prefecture || "";
      const city = body.city || "";
      const addressDetail = body.addressDetail || "";
      const officeData = {
        corpName: body.corpName || "",
        officeName,
        phone: body.phone || "",
        website: body.website || "",
        postalCode: body.postalCode || "",
        prefecture,
        city,
        addressDetail,
        address: [prefecture, city, addressDetail].filter(Boolean).join(""),
        createdAt: now,
        updatedAt: now,
      };

      const officeRef = await db.collection("offices").add(officeData);

      const caseData = {
        caseNumber,
        officeId: officeRef.id,
        officeName: officeData.officeName,
        corpName: officeData.corpName,
        contactName: body.name || "",
        contactEmail: body.email || "",
        contactPhone: body.phone || "",
        source: "lp_inquiry",
        // ご希望（まず相談したい/見積書がほしい/正式に申込みたい）。2026-09-05 MTG §6・決定事項10。
        inquiryIntent: intent,
        // 紹介元（営業上の紹介元）は未設定で作る。フォームからは判別できないため決め打ちしない。
        referralSource: null,
        status: STATUS.NEW,
        assignedUserId: null,
        receivedAt: now,
        updatedAt: now,
        message: body.message || "",
        cardReaders: [],
        subsidyCategory: null,
        expectedSubsidyAmount: null,
        lostReason: null,
        orderedAt: null,
        completedAt: null,
      };

      const caseRef = await db.collection("cases").add(caseData);

      // タイムラインに自動記録
      await db.collection("activities").add({
        caseId: caseRef.id,
        type: "memo",
        occurredAt: now,
        userId: "system",
        subject: "LP問い合わせ受信",
        body: `ご希望: ${INQUIRY_INTENT_LABEL[intent]}\n${body.message || ""}`,
        attachmentUrls: [],
      });

      const chatWebhook = await getWebhook("crm");
      await notifyChat(
        chatWebhook,
        `${INQUIRY_INTENT_EMOJI[intent]} 新規LP問い合わせ [案件 #${caseNumber}]\nご希望: ${INQUIRY_INTENT_LABEL[intent]}\n事業所: ${formatRegion(prefecture, city)}${officeData.officeName}\n担当者: ${body.name || ""}\nTEL: ${body.phone || ""}\nメール: ${body.email || ""}\nメッセージ: ${body.message || ""}`
      );
      await notifyInquiryMail({
        officeName: officeData.officeName, corpName: body.corpName || "", name: body.name || "",
        phone: body.phone || "", email: body.email || "", postalCode: body.postalCode || "",
        prefecture: body.prefecture || "", city: body.city || "", addressDetail: body.addressDetail || "",
        message: body.message || "", caseNumber, caseId: caseRef.id, existing: false,
      });

      // 送信完了画面の「今すぐ見積もりを作る」用の継続トークン
      const token = await issueLeadToken(caseRef.id, officeRef.id, prefill);
      res.status(200).json({ status: "ok", caseId: caseRef.id, caseNumber, token, intent });
    } catch (e) {
      console.error("webhookLpInquiry error:", e);
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);

// 見積もりツール Webhook（mitsumori.html から）— 2026-09-06 改修
// 「成約」ではなく「見積もりを作った」段階。案件は 1組織1件に寄せ、見積もりは quotes に版として残す。
//   1. 継続トークン（LP問い合わせ→見積もり）があればその案件、無ければメール＋事業所名で動いている案件、それも無ければ新規
//   2. 金額はサーバで再計算（ブラウザの値を信用しない）
//   3. quotes を作成（estNo をサーバ採番・版・品番ベースの明細・有効期限30日）。前の版は superseded
//   4. PDFの保存とメール送付は別関数 sendQuotePdf（SA_MAIL）で行う。ここでは accessToken を返す
// 利用者が見積もり画面でどの操作をしたか（2026-09-09・藤田副理事長の改修提案）。
// 同意チェックでは何も起きず、下の操作を押したときだけ記録・送付が動く。
const INTENT_LABEL = {
  download: "（PDFをダウンロード）",
  mail: "（メールで受け取る）",
  order: "（お申し込みの確認へ）",
};

// ---- 見積もり1件分の処理（案件決定・金額再計算・quotes作成）----
// 単一事業所（webhookMitsumori 従来経路）・複数事業所（offices[]経路）の両方から呼ぶ共通コア。
// groupMeta を渡すと quotes/cases に横断グループの目印だけ追加で書く（無いときは今までと同じフィールド構成のまま）。
function validateMitsumoriOfficeInput(o) {
  const planKey = ["houmon", "kyojyu", "other"].includes(o.subsidyCategory) ? o.subsidyCategory : null;
  if (!planKey) return { ok: false, message: "プランの指定が不正です" };
  const usbConnector = o.usbConnector != null && !["A", "C"].includes(o.usbConnector) ? null : (o.usbConnector || null);
  return {
    ok: true, planKey,
    btQty: Number(o.btSubsidyQty) || 0, usbQty: Number(o.usbSubsidyQty) || 0,
    btExtra: Number(o.btExtraQty) || 0, usbExtra: Number(o.usbExtraQty) || 0,
    usbConnector: ["A", "C"].includes(o.usbConnector) ? o.usbConnector : null,
  };
}

async function createOrUpdateMitsumoriQuote(input, groupMeta) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const officeName = input.officeName || "";
  const email = input.email || "";

  const v = validateMitsumoriOfficeInput(input);
  if (!v.ok) return { ok: false, message: v.message };
  const { planKey, btQty, usbQty, btExtra, usbExtra, usbConnector } = v;
  const calc = Pricing.computeAmounts(planKey, btQty, usbQty, btExtra, usbExtra);
  const items = Pricing.buildItems({ btQty, usbQty, btExtra, usbExtra, usbConnector });
  const amounts = {
    readers: calc.devSubsidyIncl, accompanyFee: calc.accFeeIncl, discount: calc.discount,
    subsidyPartTotal: calc.subsidyPartTotal, extraPartTotal: calc.extraPartTotal,
    totalIncl: calc.totalIncl, grantAmt: calc.grantAmt, selfPay: calc.selfPay,
  };
  // 旧フィールド互換（cases.cardReaders は BT/USB の形で読んでいる画面がある）
  const cardReaders = [];
  if (btQty > 0 || btExtra > 0) cardReaders.push({ type: "BT", subsidyQty: btQty, extraQty: btExtra });
  if (usbQty > 0 || usbExtra > 0) cardReaders.push({ type: "USB", subsidyQty: usbQty, extraQty: usbExtra, connector: usbConnector });

  // ---- 案件を決める（トークン → 既存 → 新規）----
  let caseId = null, caseNumber = null, officeId = null, lead = null, created = false;
  lead = await readLeadToken(input.token);
  if (lead) { caseId = lead.caseId; officeId = lead.officeId || null; }
  if (!caseId) {
    const existing = await findActiveCase(email, officeName);
    if (existing) { caseId = existing.id; officeId = existing.officeId || null; caseNumber = existing.caseNumber; }
  }
  if (caseId && caseNumber == null) {
    const cd = await db.collection("cases").doc(caseId).get();
    if (cd.exists) caseNumber = cd.data().caseNumber; else caseId = null;
  }

  const prefecture = input.prefecture || "", city = input.city || "", addressDetail = input.addressDetail || "";
  if (!caseId) {
    created = true;
    caseNumber = await getNextCaseNumber();
    const officeData = {
      corpName: input.corpName || "", officeName,
      postalCode: input.postalCode || "", prefecture, city, addressDetail,
      address: [prefecture, city, addressDetail].filter(Boolean).join(""),
      phone: input.phone || "", website: input.website || "",
      createdAt: now, updatedAt: now,
    };
    const officeRef = await db.collection("offices").add(officeData);
    officeId = officeRef.id;
    const caseRef = await db.collection("cases").add({
      caseNumber, officeId, officeName, corpName: officeData.corpName,
      contactName: input.contactName || "", contactEmail: email, contactPhone: input.phone || "",
      source: "mitsumori_quote", referralSource: null,
      status: STATUS.CONFIRMING, assignedUserId: null,
      receivedAt: now, updatedAt: now,
      subsidyPlan: calc.plan.label, cardReaders, subsidyCategory: planKey,
      expectedSubsidyAmount: calc.grantAmt, totalAmount: calc.totalIncl,
      specialDiscount: calc.discount, selfPay: calc.selfPay,
      lostReason: null, orderedAt: null, completedAt: null,
    });
    caseId = caseRef.id;
  }

  // ---- 直近5分に「まったく同じ内容」の見積もりがあればそれを返す（二重送信の抑止） ----
  // 金額だけで判定すると、USBの口を変えた・補助対象と追加の内訳を入れ替えた等で
  // 合計が同額になる別構成まで握りつぶしてしまうため、プランと明細も突き合わせる。
  const sameConfig = (q) => q.plan === planKey
    && JSON.stringify((q.items || []).map((i) => [i.sku, i.connector || null, Number(i.subsidyQty) || 0, Number(i.extraQty) || 0]))
       === JSON.stringify(items.map((i) => [i.sku, i.connector || null, Number(i.subsidyQty) || 0, Number(i.extraQty) || 0]))
    && q.amounts?.totalIncl === amounts.totalIncl;
  const prevSnap = await db.collection("quotes").where("caseId", "==", caseId).get();
  const prevQuotes = prevSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.version || 0) - (a.version || 0));
  const latest = prevQuotes[0] || null;
  if (latest && latest.createdAt && Date.now() - latest.createdAt.toMillis() < 5 * 60 * 1000
      && sameConfig(latest)) {
    return {
      ok: true, duplicate: true, created, caseId, caseNumber, officeName,
      groupId: latest.groupId || null,   // 既存の版を返すときは、その版が持つグループIDを応答に使う（新採番とズレないように）
      quoteId: latest.id, estNo: latest.estNo, version: latest.version, quoteToken: latest.accessToken,
      validUntil: latest.validUntil?.toDate?.() || null, calc, cardReaders,
    };
  }

  // ---- 見積もりを作成（前の版は superseded） ----
  // 見積番号は案件ごとに引き継ぎ、版だけ上げる。
  // 事業所は「EST-… の第2版」として受け取れる（番号が毎回変わると、どれが最新か分からなくなる）。
  const version = (latest?.version || 0) + 1;
  const estNo = latest?.estNo || await getNextQuoteNumber();
  const accessToken = newToken();
  const validUntil = daysFromNow(30);
  const batch = db.batch();
  for (const q of prevQuotes) {
    if (q.status === "issued") batch.update(db.collection("quotes").doc(q.id), { status: "superseded", supersededAt: now });
  }
  const quoteRef = db.collection("quotes").doc();
  const quoteData = {
    caseId, officeId, caseNumber, estNo, version, plan: planKey, planLabel: calc.plan.label,
    items, amounts, status: "issued", supersedes: latest ? latest.id : null,
    validUntil, createdVia: "web", createdAt: now,
    contactEmail: email, contactName: input.contactName || "", officeName, corpName: input.corpName || "",
    accessToken, pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null,
    leadToken: lead ? lead.id : null,
  };
  if (groupMeta) Object.assign(quoteData, { groupId: groupMeta.groupId, groupIndex: groupMeta.groupIndex, groupSize: groupMeta.groupSize });
  // 出荷の参照（shipmentId/shipmentNo）は新しい版に引き継がない（2026-10-21 レビュー指摘 3）。
  // 二重の下書きの再発防止は、申込のトランザクションが案件の出荷を見て使い直すこと（Flow.planWebShipment）で行う。
  // 引き継ぐと、未申込の版で reviseQuote したときに申込済みの出荷の下書きが上書きされる。
  batch.set(quoteRef, quoteData);
  const caseUpdate = {
    latestQuoteId: quoteRef.id, quoteIssuedAt: now, updatedAt: now,
    subsidyPlan: calc.plan.label, cardReaders, subsidyCategory: planKey,
    expectedSubsidyAmount: calc.grantAmt, totalAmount: calc.totalIncl,
    specialDiscount: calc.discount, selfPay: calc.selfPay,
  };
  if (groupMeta) caseUpdate.quoteGroupId = groupMeta.groupId;
  if (!created) {
    const cd = await db.collection("cases").doc(caseId).get();
    if (cd.exists && cd.data().status === STATUS.NEW) caseUpdate.status = STATUS.CONFIRMING;
    // 事業所の住所が空なら見積もりフォームの入力で埋める
    if (officeId && prefecture) {
      const od = await db.collection("offices").doc(officeId).get();
      if (od.exists && !od.data().prefecture) {
        batch.update(db.collection("offices").doc(officeId), {
          postalCode: input.postalCode || "", prefecture, city, addressDetail,
          address: [prefecture, city, addressDetail].filter(Boolean).join(""), updatedAt: now,
        });
      }
    }
  }
  batch.update(db.collection("cases").doc(caseId), caseUpdate);
  batch.set(db.collection("activities").doc(), {
    caseId, type: "memo", occurredAt: now, userId: "system",
    subject: `見積もりを作成（${estNo}・v${version}）`,
    body: `プラン: ${calc.plan.label}\n構成: ${cardReaders.map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`).join(", ")}${usbConnector ? `（USB ${usbConnector === "C" ? "Type-C" : "Type-A"}）` : ""}\n合計（税込）: ¥${fmtNum(calc.totalIncl)}／自己負担: ¥${fmtNum(calc.selfPay)}`,
    attachmentUrls: [],
  });
  if (lead) batch.update(db.collection("leadTokens").doc(lead.id), { usedFor: admin.firestore.FieldValue.arrayUnion("quote") });
  await batch.commit();

  const crSummary = cardReaders.map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`).join(", ");
  return {
    ok: true, duplicate: false, created, caseId, caseNumber, officeName, officeId, prefecture, city,
    quoteId: quoteRef.id, estNo, version, quoteToken: accessToken, validUntil: validUntil.toDate(),
    calc, cardReaders, crSummary,
  };
}

// 見積もりツール Webhook（mitsumori.html から）— 2026-09-06 改修・2026-09-14 複数事業所対応
// 「成約」ではなく「見積もりを作った」段階。案件は 1組織1件に寄せ、見積もりは quotes に版として残す。
//   1. 継続トークン（LP問い合わせ→見積もり）があればその案件、無ければメール＋事業所名で動いている案件、それも無ければ新規
//   2. 金額はサーバで再計算（ブラウザの値を信用しない）
//   3. quotes を作成（estNo をサーバ採番・版・品番ベースの明細・有効期限30日）。前の版は superseded
//   4. PDFの保存とメール送付は別関数 sendQuotePdf（SA_MAIL）で行う。ここでは accessToken を返す
// body.offices（配列・2〜10件）があるときは複数事業所一括経路。無いときは従来どおりの1事業所経路（挙動は変えない）。

exports.webhookMitsumori = onRequest(
  { region: "asia-northeast1", cors: true, secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_WEBHOOK },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    if (await appCheckGate(req, res, "webhookMitsumori")) return;

    try {
      const body = req.body || {};

      // ===== 複数事業所（offices[]）経路 =====
      if (Array.isArray(body.offices)) {
        const offices = body.offices;
        if (offices.length < 2 || offices.length > 10) {
          res.status(400).json({ status: "error", message: "offices は2〜10件で指定してください" });
          return;
        }
        // 金額計算の入力（プラン・USB口）が不正なものが1件でもあれば、書き込み前に全件検証して弾く
        for (const o of offices) {
          const v = validateMitsumoriOfficeInput(o);
          if (!v.ok) {
            res.status(400).json({ status: "error", message: `事業所「${o.officeName || ""}」: ${v.message}` });
            return;
          }
        }

        const groupId = newToken();
        const results = [];
        for (let i = 0; i < offices.length; i++) {
          const o = offices[i];
          try {
            const r = await createOrUpdateMitsumoriQuote({
              officeName: o.officeName || "", email: body.email || "",
              corpName: body.corpName || "", contactName: body.contactName || "",
              phone: o.phone || body.phone || "",
              postalCode: o.postalCode || "", prefecture: o.prefecture || "", city: o.city || "",
              addressDetail: o.addressDetail || "", website: o.website || "",
              subsidyCategory: o.subsidyCategory, btSubsidyQty: o.btSubsidyQty, usbSubsidyQty: o.usbSubsidyQty,
              btExtraQty: o.btExtraQty, usbExtraQty: o.usbExtraQty, usbConnector: o.usbConnector,
              token: i === 0 ? body.token : null,
            }, { groupId, groupIndex: i, groupSize: offices.length });
            results.push(r.ok ? { ...r, officeName: o.officeName || "" } : { ok: false, officeName: o.officeName || "", message: r.message });
          } catch (e) {
            console.error("webhookMitsumori(group) office error:", o.officeName, e);
            results.push({ ok: false, officeName: o.officeName || "", message: e.message });
          }
        }

        const oks = results.filter((r) => r.ok);
        const allDuplicate = oks.length > 0 && oks.every((r) => r.duplicate) && oks.length === results.length;

        // Chat 通知はグループで1通（設定 notifyQuoteChat が true のときだけ・新規作成分のみ対象に整理）
        const notifySettings = await getSettings();
        if (notifySettings.notifyQuoteChat === true && oks.some((r) => !r.duplicate)) {
          const created = oks.filter((r) => !r.duplicate);
          const chatWebhook = await getWebhook("crm");
          const regions = await Promise.all(created.map((r) => officeRegionLabel(r)));
          await notifyChat(
            chatWebhook,
            `📝 見積もり作成（${created.length}事業所・${body.corpName || ""}）\n`
            + created.map((r, i) => `・${r.estNo} ${regions[i]}${r.officeName}（${r.calc.plan.label}）¥${fmtNum(r.calc.totalIncl)}`).join("\n")
          );
        }

        // 一部の事業所だけ失敗したときは "partial"、全件失敗は "error" にして、画面が「全件成功」と誤表示しないようにする（Codex レビュー P1・2026-09-14）
        const failedOffices = results.filter((r) => !r.ok);
        const groupStatus = allDuplicate ? "duplicate" : failedOffices.length === 0 ? "ok" : oks.length > 0 ? "partial" : "error";
        res.status(groupStatus === "error" ? 500 : 200).json({
          status: groupStatus,
          message: failedOffices.length ? `${failedOffices.length}件の事業所の見積もりを作成できませんでした（${failedOffices.map((r) => r.officeName || "事業所").join("、")}）` : undefined,
          // 全件が既存の版（duplicate）なら、その版に保存されている groupId を返す（今回採番した値は書き込まれていない）
          groupId: (allDuplicate && oks[0]?.groupId) ? oks[0].groupId : groupId,
          quotes: results.map((r) => r.ok
            ? {
                caseId: r.caseId, caseNumber: r.caseNumber, quoteId: r.quoteId, estNo: r.estNo, version: r.version,
                quoteToken: r.quoteToken, validUntil: r.validUntil ? r.validUntil.toISOString() : null, officeName: r.officeName,
              }
            : { officeName: r.officeName, error: r.message }),
        });
        return;
      }

      // ===== 従来の1事業所経路（挙動は変えない）=====
      const email = body.email || "";
      const r = await createOrUpdateMitsumoriQuote({
        officeName: body.officeName || "", email,
        corpName: body.corpName || "", contactName: body.contactName || "", phone: body.phone || "",
        postalCode: body.postalCode || "", prefecture: body.prefecture || "", city: body.city || "",
        addressDetail: body.addressDetail || "", website: body.website || "",
        subsidyCategory: body.subsidyCategory, btSubsidyQty: body.btSubsidyQty, usbSubsidyQty: body.usbSubsidyQty,
        btExtraQty: body.btExtraQty, usbExtraQty: body.usbExtraQty, usbConnector: body.usbConnector,
        token: body.token,
      });
      if (!r.ok) { res.status(400).json({ status: "error", message: r.message }); return; }

      if (r.duplicate) {
        res.status(200).json({
          status: "duplicate", caseId: r.caseId, caseNumber: r.caseNumber, quoteId: r.quoteId, estNo: r.estNo,
          version: r.version, quoteToken: r.quoteToken, validUntil: r.validUntil ? r.validUntil.toISOString() : null,
        });
        return;
      }

      // 見積もりを受け取っただけの段階では Chat に流さない（2026-09-11 次田さん判断・藤田副理事長の改修提案 REQ-03）。
      // 設定画面の「見積もりが作られたときも Chat に通知する」を入れたときだけ送る。**既定は送らない**。
      // 相談・お申し込みの通知（webhookLpInquiry・acceptQuote）はこの設定に関係なく従来どおり送る。
      const notifySettings = await getSettings();
      if (notifySettings.notifyQuoteChat === true) {
        const chatWebhook = await getWebhook("crm");
        const regionQ = await officeRegionLabel(r);
        await notifyChat(
          chatWebhook,
          `📝 見積もり作成 ${r.estNo}（v${r.version}）${INTENT_LABEL[body.intent] || ""} [案件 #${r.caseNumber}${r.created ? "・新規" : ""}]\n事業所: ${regionQ}${r.officeName} (${body.corpName || ""})\n担当者: ${body.contactName || ""}\nメール: ${email}\nプラン: ${r.calc.plan.label}\n構成: ${r.crSummary}\n金額: ¥${fmtNum(r.calc.totalIncl)}（自己負担 ¥${fmtNum(r.calc.selfPay)}）`
        );
      }

      res.status(200).json({ status: "ok", caseId: r.caseId, caseNumber: r.caseNumber, quoteId: r.quoteId, estNo: r.estNo, version: r.version,
        quoteToken: r.quoteToken, validUntil: r.validUntil.toISOString() });
    } catch (e) {
      console.error("webhookMitsumori error:", e);
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);

// ===== 見積書PDFの保存と事業所へのメール送付（2026-09-06）=====
// PDF は見積もりページ（ブラウザ）が html2pdf で作って base64 で送る（領収書メールと同じ経路）。
// SA_WEBHOOK には Gmail/Storage の権限が無いので、SA_MAIL で動く別関数にしている。
// 呼び出しの正当性は quotes.accessToken（webhookMitsumori が返した quoteToken）で確認する。
const QUOTE_BUCKET = `${VERTEX_PROJECT}.firebasestorage.app`;
async function storeQuotePdfFile(caseId, filename, pdfBase64) {
  const token = require("crypto").randomUUID();
  const path = `quotes/${caseId}/${filename}`;
  const file = admin.storage().bucket(QUOTE_BUCKET).file(path);
  await file.save(Buffer.from(pdfBase64, "base64"), {
    resumable: false,
    metadata: { contentType: "application/pdf", metadata: { firebaseStorageDownloadTokens: token } },
  });
  const url = `https://firebasestorage.googleapis.com/v0/b/${QUOTE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { path, url };
}
function quoteMailText(q, { resend = false } = {}) {
  const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
  const until = q.validUntil?.toDate ? q.validUntil.toDate().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }) : "";
  const to = [q.corpName, q.officeName].filter(Boolean).join("　");
  return {
    subject: `${resend ? "【再送】" : ""}【NPO法人タダカヨ】お見積書（${q.estNo}）をお送りします`,
    body:
      `${to} 御中\n${q.contactName ? q.contactName + " 様" : "ご担当者様"}\n\n` +
      `NPO法人タダカヨです。介護情報基盤伴走支援のお見積書をPDFで添付しました。\n\n` +
      `見積番号: ${q.estNo}（第${q.version}版）\n` +
      `プラン: ${q.planLabel || ""}\n` +
      `合計（税込）: ${yen(q.amounts?.totalIncl)}　／　助成金充当: ${yen(q.amounts?.grantAmt)}　／　自己負担: ${yen(q.amounts?.selfPay)}\n` +
      (until ? `有効期限: ${until}\n` : "") +
      `\nこの見積もりは仮のものではなく、そのままお申し込みいただけます。\n` +
      `台数や機種（Bluetooth／USB、USBの口の形）は、支援の日程を調整する際に変更できますので、\n` +
      `いまの時点で決めきれなくても大丈夫です。\n\n` +
      `ご不明な点は、このメールへの返信でお知らせください。\n` +
      `導入のご相談や、この内容でのお申し込みをご希望の場合も、ご返信いただければ承ります。\n\n` +
      `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`,
  };
}
async function sendGmail({ to, cc, subject, body, attachments }) {
  const sender = (await getSettings()).gmailSender || GMAIL_SENDER;
  const token = await gmailAccessToken(sender);
  const raw = buildRawMessage({ to, cc, subject, body, sender, attachments });
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sender)}/messages/send`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw }) }
  );
  if (!res.ok) {
    const t = await res.text();
    console.error("Gmail send (quote) failed:", res.status, t);
    throw new Error(`Gmail送信に失敗しました（${res.status}）`);
  }
  return { sender, id: (await res.json()).id };
}

exports.sendQuotePdf = onRequest(
  { region: "asia-northeast1", cors: true, timeoutSeconds: 120, memory: "512MiB", serviceAccount: SA_MAIL },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
    if (await appCheckGate(req, res, "sendQuotePdf")) return;
    try {
      const body = req.body || {};
      const wantsMail = body.mail !== false;

      // ===== 複数事業所分をまとめて1通で送る（body.pdfs 経路）=====
      if (Array.isArray(body.pdfs)) {
        const pdfs = body.pdfs;
        if (!pdfs.length || pdfs.length > 10) {
          res.status(400).json({ status: "error", message: "pdfs は1〜10件で指定してください" });
          return;
        }
        let totalLen = 0;
        for (const p of pdfs) {
          if (!p || !p.quoteId || !p.quoteToken || typeof p.pdfBase64 !== "string") {
            res.status(400).json({ status: "error", message: "quoteId・quoteToken・pdfBase64 は必須です" });
            return;
          }
          totalLen += p.pdfBase64.length;
        }
        if (totalLen > 13_400_000) { res.status(400).json({ status: "error", message: "PDFが大きすぎます（合計10MB以下）" }); return; }

        const quotes = [];
        for (const p of pdfs) {
          const ref = db.collection("quotes").doc(String(p.quoteId));
          const snap = await ref.get();
          if (!snap.exists) { res.status(404).json({ status: "error", message: "見積もりが見つかりません" }); return; }
          const q = { id: snap.id, ...snap.data() };
          if (!q.accessToken || q.accessToken !== p.quoteToken) { res.status(403).json({ status: "error", message: "この見積もりを操作する権限がありません" }); return; }
          quotes.push({ ref, q, pdfBase64: p.pdfBase64 });
        }
        if (wantsMail && quotes.every(({ q }) => q.mailedAt)) {
          res.status(200).json({ status: "already", pdfUrls: quotes.map(({ q }) => q.pdfUrl || null) });
          return;
        }

        const saves = [];
        for (const item of quotes) {
          const filename = `${item.q.estNo}-v${item.q.version}.pdf`;
          const saved = await storeQuotePdfFile(item.q.caseId, filename, item.pdfBase64);
          saves.push({ ...item, saved });
        }

        const first = saves[0].q;
        const to = first.contactEmail || "";
        const mismatched = saves.some(({ q }) => (q.contactEmail || "") !== to);
        if (mismatched) console.warn("sendQuotePdf(group): 宛先メールが揃っていません。先頭を採用します。", to);

        let mailed = false, mailError = null;
        if (wantsMail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
          const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
          try {
            const lines = saves.map(({ q }) =>
              `・${q.estNo}（${q.officeName || ""}） 合計 ${yen(q.amounts?.totalIncl)}／自己負担 ${yen(q.amounts?.selfPay)}`).join("\n");
            const grandTotal = saves.reduce((a, { q }) => a + (Number(q.amounts?.totalIncl) || 0), 0);
            const corp = first.corpName || "";
            const subject = `【NPO法人タダカヨ】お見積書（${saves.length}事業所分）をお送りします`;
            const body =
              `${corp} 御中\n${first.contactName ? first.contactName + " 様" : "ご担当者様"}\n\n` +
              `NPO法人タダカヨです。介護情報基盤伴走支援のお見積書をPDFで添付しました。\n\n` +
              `${lines}\n\n法人合計（税込）: ${yen(grandTotal)}\n\n` +
              `この見積もりは仮のものではなく、そのままお申し込みいただけます。\n` +
              `台数や機種（Bluetooth／USB、USBの口の形）は、支援の日程を調整する際に変更できますので、\n` +
              `いまの時点で決めきれなくても大丈夫です。\n\n` +
              `ご不明な点は、このメールへの返信でお知らせください。\n` +
              `導入のご相談や、この内容でのお申し込みをご希望の場合も、ご返信いただければ承ります。\n\n` +
              `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`;
            const attachments = saves.map(({ q, pdfBase64 }) => ({ filename: `${q.estNo}.pdf`, mimeType: "application/pdf", contentBase64: pdfBase64 }));
            const sent = await sendGmail({ to, cc: GMAIL_SENDER, subject, body, attachments });
            mailed = true;
            for (const { q, saved } of saves) {
              await db.collection("activities").add({
                caseId: q.caseId, type: "gmail_sent", occurredAt: admin.firestore.FieldValue.serverTimestamp(),
                userId: "system", userName: sent.sender,
                subject: `メール送信: ${subject}`, body: `宛先: ${to}（見積書PDF添付・自動送付・${saves.length}事業所分）`, attachmentUrls: [saved.url],
              });
            }
          } catch (e) { mailError = e.message; console.error("sendQuotePdf(group) mail error:", e); }
        }
        for (const { ref, saved } of saves) {
          const update = { pdfPath: saved.path, pdfUrl: saved.url };
          if (wantsMail) Object.assign(update, {
            mailedAt: mailed ? admin.firestore.FieldValue.serverTimestamp() : null,
            mailedTo: mailed ? to : null, mailError: mailError || null,
          });
          await ref.update(update);
        }
        res.status(200).json({ status: "ok", mailed: wantsMail ? mailed : false, pdfUrls: saves.map(({ saved }) => saved.url) });
        return;
      }

      // ===== 従来の単一見積もり経路（挙動は変えない。mail:false のときだけ保存のみ）=====
      const { quoteId, quoteToken, pdfBase64 } = body;
      if (!quoteId || !quoteToken || !pdfBase64) { res.status(400).json({ status: "error", message: "quoteId・quoteToken・pdfBase64 は必須です" }); return; }
      if (typeof pdfBase64 !== "string" || pdfBase64.length > 13_400_000) { res.status(400).json({ status: "error", message: "PDFが大きすぎます（10MB以下）" }); return; }
      const ref = db.collection("quotes").doc(String(quoteId));
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ status: "error", message: "見積もりが見つかりません" }); return; }
      const q = { id: snap.id, ...snap.data() };
      if (!q.accessToken || q.accessToken !== quoteToken) { res.status(403).json({ status: "error", message: "この見積もりを操作する権限がありません" }); return; }
      if (wantsMail && q.mailedAt) { res.status(200).json({ status: "already", pdfUrl: q.pdfUrl || null }); return; }

      const filename = `${q.estNo}-v${q.version}.pdf`;
      const saved = await storeQuotePdfFile(q.caseId, filename, pdfBase64);
      const to = q.contactEmail || "";
      let mailed = false, mailError = null;
      if (wantsMail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        try {
          const m = quoteMailText(q);
          const sent = await sendGmail({ to, cc: GMAIL_SENDER, subject: m.subject, body: m.body,
            attachments: [{ filename: `${q.estNo}.pdf`, mimeType: "application/pdf", contentBase64: pdfBase64 }] });
          mailed = true;
          await db.collection("activities").add({
            caseId: q.caseId, type: "gmail_sent", occurredAt: admin.firestore.FieldValue.serverTimestamp(),
            userId: "system", userName: sent.sender,
            subject: `メール送信: ${m.subject}`, body: `宛先: ${to}（見積書PDF添付・自動送付）`, attachmentUrls: [saved.url],
          });
        } catch (e) { mailError = e.message; console.error("sendQuotePdf mail error:", e); }
      }
      const update = { pdfPath: saved.path, pdfUrl: saved.url };
      if (wantsMail) Object.assign(update, {
        mailedAt: mailed ? admin.firestore.FieldValue.serverTimestamp() : null,
        mailedTo: mailed ? to : null, mailError: mailError || null,
      });
      await ref.update(update);
      res.status(200).json({ status: "ok", mailed: wantsMail ? mailed : false, pdfUrl: saved.url });
    } catch (e) {
      console.error("sendQuotePdf error:", e);
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);

// ===== 申し込みを受ける（2026-09-06・Phase 2）=====
// 事業所が見積もりページで「この内容で申し込む」を押したときの受け口。
//   1. 見積もりの accessToken で本人確認（ログインの仕組みを事業所に強いない）
//   2. 見積もりを accepted、案件を「受注確定」に
//   3. 出荷の下書きを自動で作る（スタッフは在庫から出すか AB Circle へ発注するかを選ぶだけにする）
//   4. 事業所へ確認メール、Chat へ通知
//
// 出荷の下書きに入れる明細は、見積書と同じ構成（カードリーダー＋伴走支援費＋金額調整）にする。
// そうしないと、そのまま発行した請求書の金額が見積書と合わない。
// 伴走支援費・金額調整は在庫のある品物ではないので nonStock: true を付け、在庫処理から外す。
function shipmentItemsFromQuote(q) {
  const items = [];
  for (const it of (q.items || [])) {
    const qty = (Number(it.subsidyQty) || 0) + (Number(it.extraQty) || 0);
    if (qty <= 0) continue;
    const unitPrice = it.sku === Pricing.SKU.BT ? Pricing.BT_PRICE : Pricing.USB_PRICE;
    items.push({ sku: it.sku, name: PRODUCT_NAMES[it.sku] || it.sku, qty, unitPrice, connection: CONNECTION_LABELS[it.sku] || "" });
  }
  const fee = Number(q.amounts?.accompanyFee) || 0;
  if (fee > 0) {
    const n = (q.items || []).reduce((a, i) => a + (Number(i.subsidyQty) || 0), 0);
    items.push({ sku: "support-fee", name: `伴走支援費（補助対象${n}台）`, qty: 1, unitPrice: fee, nonStock: true });
  }
  const discount = Number(q.amounts?.discount) || 0;
  if (discount > 0) {
    items.push({ sku: "discount", name: "金額調整", qty: 1, unitPrice: -discount, nonStock: true });
  }
  return items;
}
const PRODUCT_NAMES = {
  "cir415a-01": "介護情報基盤 汎用カードリーダ CIR415A",
  "cir315a-02": "介護情報基盤 汎用カードリーダ CIR315A（Type-A）",
  "cir315a-04": "介護情報基盤 汎用カードリーダ CIR315A（Type-C）",
};
const CONNECTION_LABELS = {
  "cir415a-01": "Bluetooth／USB Type-C",
  "cir315a-02": "USB Type-A",
  "cir315a-04": "USB Type-C",
};
const PAY_LABELS = { after: "伴走支援の後にお支払い", before: "先にお支払い（前払い）" };

// 出荷番号の年（JST）。以前は "SH-2026-" の固定文字列だった。
function shipmentNumberPrefix() {
  return `SH-${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 4)}-`;
}

// お申し込みの確認メール（事業所宛）の本文。Web の申込（単一）とスタッフの受注確定で共用する（2026-10-21 切り出し）。
function acceptMailText({ q, agreedName, payKey, delivery, preferredDate }) {
  const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
  const d = delivery || {};
  return {
    subject: `【NPO法人タダカヨ】お申し込みを受け付けました（${q.estNo}）`,
    body:
      `${[q.corpName, q.officeName].filter(Boolean).join("　")} 御中\n${String(agreedName).trim()} 様\n\n` +
      `お申し込みをいただき、ありがとうございます。以下の内容で承りました。\n\n` +
      `見積番号: ${q.estNo}（第${q.version}版）\n` +
      `合計（税込）: ${yen(q.amounts?.totalIncl)}　／　助成金充当: ${yen(q.amounts?.grantAmt)}　／　自己負担: ${yen(q.amounts?.selfPay)}\n` +
      `お支払い: ${PAY_LABELS[payKey]}\n` +
      `お届け先: ${[d.postalCode ? "〒" + d.postalCode : "", d.company, d.officeName, d.address].filter(Boolean).join(" ")}\n` +
      (preferredDate ? `ご希望日: ${preferredDate}\n` : "") +
      `\nこのあと担当スタッフから、カードリーダーの発送と伴走支援の日程についてご連絡します。\n` +
      `台数や機種（Bluetooth／USB、USBの口の形）は、日程の調整をする際に変更できます。\n` +
      `お気づきの点は、このメールへの返信でお知らせください。\n\n` +
      `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`,
  };
}
// 複数事業所分をまとめた確認メール（Web の一括申込・スタッフのグループ受注確定で共用）。items = [{q, soNumber}]
function acceptMailTextGroup({ items, agreedName, payKey, preferredDate }) {
  const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
  const first = items[0].q;
  const lines = items.map((r) => `・${r.q.estNo}（${r.q.officeName || ""}） 出荷 ${r.soNumber} — 合計 ${yen(r.q.amounts?.totalIncl)}（自己負担 ${yen(r.q.amounts?.selfPay)}）`).join("\n");
  return {
    subject: `【NPO法人タダカヨ】お申し込みを受け付けました（${items.length}事業所分）`,
    body:
      `${first.corpName || ""} 御中\n${String(agreedName).trim()} 様\n\n` +
      `お申し込みをいただき、ありがとうございます。以下の内容で承りました。\n\n` +
      `${lines}\n\n` +
      `お支払い: ${PAY_LABELS[payKey]}\n` +
      (preferredDate ? `ご希望日: ${preferredDate}\n` : "") +
      `\nこのあと担当スタッフから、カードリーダーの発送と伴走支援の日程についてご連絡します。\n` +
      `台数や機種（Bluetooth／USB、USBの口の形）は、日程の調整をする際に変更できます。\n` +
      `お気づきの点は、このメールへの返信でお知らせください。\n\n` +
      `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`,
  };
}

// 出荷の「使い直し・重複」の Chat 用の注記（Web・スタッフ共通）
function acceptShipNote(r) {
  const re = r.reopenedFrom ? `🔁 ${Flow.reopenLabel(r.reopenedFrom)}（案件を「受注確定」に戻しました）。` : "";
  return [re, acceptShipNoteBody(r)].filter(Boolean).join(" ");
}
function acceptShipNoteBody(r) {
  if (r.reused) {
    return `既存の出荷 ${r.soNumber}（${r.reusedStatus === "requested" ? "依頼済み" : "下書き"}）を新しい内容に更新しました（新しい下書きは作っていません）。`
      + (r.reusedStatus === "requested" ? " ⚠️ 出荷指示は投稿済みです。内容が変わる場合はセンターへ連絡してください。" : "");
  }
  if (r.duplicateWarning) {
    return `⚠️ この案件には既に発送済みの出荷 ${r.existingNos.join("・") || "（番号なし）"} があります。重複していないか確認してください（出荷 ${r.soNumber} の下書きを作りました）。`;
  }
  return "";
}

// お申し込み1件分の状態確認と書き込み（トランザクション本体）。Web（単一・複数）とスタッフの受注確定から呼ぶ共通コア。
// 二重送信（ボタン連打・回線の再送）で出荷の下書きが2つできるのを防ぐため、必ずトランザクションでまとめる。
// actor（2026-10-21 設計 §5 A）:
//   {kind:"web"}（既定）… 事業所の申込。quoteToken で本人確認する
//   {kind:"staff", email, uid, name, channel, receivedDate, acceptedName} … 電話・メール等で受けた申込をスタッフが確定。トークン確認なし
// 共通: tx 内で案件の出荷を読み、
//   Web   … 生きている draft/requested があれば新しく作らず使い直す（新規作成と同じ申込の項目〔届け先・明細・補助区分と台数・
//            希望日・支払方法・メモ・見積番号〕を Flow.shipmentFieldsFromAccept で書き直す。soNumber・状態・出荷元は既存のまま）。
//            発送済以降だけがあれば作成は続け、出荷に duplicateWarning:true（Chat に注記）
//   Staff … checkStaffAccept（キャンセル以外の出荷があれば拒否・旧版・期限切れ〔受付日で比較〕など）
// 案件の状態: 1・2 → 3。3・5〜12 は据え置き。4（失注）・13（完了）は再申込として受け付けて 3 に戻す（2026-10-21 レビュー指摘 4。
//            活動の件名に「再申込で再開（失注から／完了から）」・cases.reopenedFrom/reopenedAt を記録）。
async function acceptQuoteTransaction({ quoteId, quoteToken, delivery, payKey, preferredDate, note, agreedName, agreedPolicy, actor }) {
  const who = actor && actor.kind === "staff" ? actor : { kind: "web" };
  const staff = who.kind === "staff";
  const qRef = db.collection("quotes").doc(String(quoteId));
  const now = admin.firestore.FieldValue.serverTimestamp();
  const d = delivery || {};
  const name = String(staff ? who.acceptedName : agreedName).trim();
  const out = { q: null, soNumber: null, alreadyAccepted: false, shipRefId: null,
    reused: false, reusedStatus: null, duplicateWarning: false, existingNos: [], caseStatusTo: null,
    reopenedFrom: null, caseContactEmail: "" };
  await db.runTransaction(async (tx) => {
    // ---- 読み取り（tx は読み取りを書き込みより前に済ませる）----
    const snap = await tx.get(qRef);
    if (!snap.exists) throw new HttpsError("not-found", "見積もりが見つかりません");
    const q = { id: snap.id, ...snap.data() };
    out.q = q;
    if (!staff) {
      if (q.accessToken !== quoteToken) throw new HttpsError("permission-denied", "この見積もりを操作する権限がありません");
      if (q.status === "accepted") { out.alreadyAccepted = true; return; }
      if (q.status !== "issued") throw new HttpsError("failed-precondition", "この見積もりは現在お申し込みいただけません（新しい見積もりが発行されている可能性があります）");
      if (q.validUntil && q.validUntil.toMillis() < Date.now()) throw new HttpsError("failed-precondition", "この見積もりは有効期限が切れています。お手数ですが、もう一度お見積もりをお作りください");
    }
    const caseRef = db.collection("cases").doc(String(q.caseId));
    const caseSnap = await tx.get(caseRef);
    const kase = caseSnap.exists ? caseSnap.data() : null;
    const shipSnap = await tx.get(db.collection("shipments").where("caseId", "==", q.caseId));
    const shipments = shipSnap.docs.map((x) => ({ id: x.id, ...x.data() }));

    let plan;
    if (staff) {
      const sibSnap = await tx.get(db.collection("quotes").where("caseId", "==", q.caseId));
      const chk = checkStaffAccept({
        quote: q, siblings: sibSnap.docs.map((x) => ({ id: x.id, ...x.data() })), kase, shipments,
        receivedDate: who.receivedDate, todayYmd: todayJst(), acceptedName: name, channel: who.channel,
      });
      if (!chk.ok) throw new HttpsError("failed-precondition", chk.message, { code: chk.code });
      plan = { reuse: null, duplicateWarning: false, existingNos: [] };
    } else {
      if (!kase) throw new HttpsError("failed-precondition", "この見積もりは現在お申し込みいただけません（案件が見つかりません）。お手数ですがお問い合わせください");
      plan = Flow.planWebShipment(shipments, kase.shipmentId || null);
    }
    const stPlan = Flow.caseStatusOnAccept(kase && kase.status); // 4・13 も受け付けて 3 に戻す（reopenedFrom）
    out.reopenedFrom = stPlan.reopenedFrom || null;
    out.caseContactEmail = (kase && kase.contactEmail) || "";
    let n = null;
    const cRef = db.collection("_counters").doc("shipments");
    if (!plan.reuse) {
      // 採番はトランザクションの中で行う（採番だけ進んで書き込みが失敗する事故を避ける）
      const cSnap = await tx.get(cRef);
      n = (cSnap.exists ? cSnap.data().value : 0) + 1;
    }

    // ---- 書き込み ----
    // 申込の内容から決まる出荷の項目（新規作成と使い直しで同じもの。2026-10-21 レビュー指摘 1）
    const orderFields = Flow.shipmentFieldsFromAccept({
      q, delivery: d, shipItems: shipmentItemsFromQuote(q), btSku: Pricing.SKU.BT, preferredDate, payKey, note,
    });
    let shipId;
    if (plan.reuse) {
      shipId = plan.reuse.id;
      out.soNumber = plan.reuse.soNumber || "";
      out.reused = true;
      out.reusedStatus = plan.reuse.status || "draft";
      // 状態・番号・出荷元・作成日時は既存のまま。requested のときは Chat に「センターへ連絡」を注記（acceptShipNote）
      tx.update(db.collection("shipments").doc(shipId), {
        ...orderFields, updatedAt: now,
        updatedBy: "web（事業所のお申し込み・既存の出荷を使い直し）",
      });
    } else {
      tx.set(cRef, { value: n });
      out.soNumber = `${shipmentNumberPrefix()}${String(n).padStart(4, "0")}`;
      const shipRef = db.collection("shipments").doc();
      shipId = shipRef.id;
      const shipDoc = {
        soNumber: out.soNumber, status: "draft", shipType: "direct", partnerEmail: "", partnerName: "",
        caseId: q.caseId, ...orderFields,
        shippingMethod: "manual", shippingFee: 0, shippingLabel: "",
        shipDate: todayJst(),
        createdAt: now, createdBy: staff ? Flow.staffCreatedBy(who.channel, who.email) : "web（事業所のお申し込み）",
      };
      if (plan.duplicateWarning) Object.assign(shipDoc, { duplicateWarning: true, duplicateOf: plan.existingNos });
      tx.set(shipRef, shipDoc);
      out.duplicateWarning = !!plan.duplicateWarning;
      out.existingNos = plan.existingNos || [];
    }
    out.shipRefId = shipId;

    const deliveryRec = { company: d.company || "", officeName: d.officeName || "", postalCode: d.postalCode || "",
      address: d.address || "", contactName: d.contactName || "", phone: d.phone || "" };
    const quoteUpdate = {
      status: "accepted", acceptedAt: now, shipmentId: shipId, shipmentNo: out.soNumber,
      acceptedBy: name.slice(0, 100), payMethod: payKey, delivery: deliveryRec,
    };
    if (staff) {
      Object.assign(quoteUpdate, {
        acceptedVia: "staff", acceptedChannel: who.channel, acceptedReceivedDate: who.receivedDate,
        acceptedByStaff: who.email, agreedName: name.slice(0, 100),
        agreedPolicy: null, // 同意の画面を通っていないので「同意した」とは記録しない（偽装しない）
      });
    } else {
      Object.assign(quoteUpdate, {
        acceptedVia: "web",
        // 申し込み画面で「プライバシーポリシー・利用規約に同意」に入れたかどうかを残す（監査用）
        agreedPolicy: agreedPolicy === true, agreedPolicyAt: now,
      });
    }
    tx.update(qRef, quoteUpdate);

    const caseUpdate = { updatedAt: now, shipmentId: shipId, payMethod: payKey };
    if (stPlan.status != null) { caseUpdate.status = stPlan.status; out.caseStatusTo = stPlan.status; }
    if (stPlan.reopenedFrom) Object.assign(caseUpdate, { reopenedFrom: stPlan.reopenedFrom, reopenedAt: now });
    if (staff) {
      Object.assign(caseUpdate, { orderedVia: "staff", orderConfirmedAt: now, orderConfirmedBy: who.email });
      // 受注日は最初の申込の日を保つ（Web と同じ。2026-10-21 レビュー指摘 5）。無ければ受付日（JST 0時）
      const oMs = Flow.staffOrderedAtMs(kase, who.receivedDate);
      if (oMs != null) caseUpdate.orderedAt = admin.firestore.Timestamp.fromMillis(oMs);
    } else {
      // 受注日は最初の申込の日を保つ（進んだ案件に再度の申込があっても月ごとの集計を動かさない）
      if (!kase.orderedAt) caseUpdate.orderedAt = now;
      caseUpdate.orderedVia = kase.orderedVia || "web";
    }
    tx.update(caseRef, caseUpdate);

    const shipLine = out.reused
      ? `既存の出荷 ${out.soNumber}（${out.reusedStatus === "requested" ? "依頼済み" : "下書き"}）を新しい内容に更新（新しい下書きは作っていません）`
      : `出荷 ${out.soNumber} の下書きを作成${out.duplicateWarning ? `（⚠️ 発送済みの出荷 ${out.existingNos.join("・")} があります。重複の確認を）` : ""}`;
    const stLine = stPlan.status != null ? "" : `案件の状態は据え置き（${kase && kase.status}）\n`;
    if (staff) {
      tx.set(db.collection("activities").doc(), {
        caseId: q.caseId, type: "memo", occurredAt: now, userId: who.uid || null, userName: who.email,
        subject: Flow.staffAcceptSubject(who.channel, q.estNo, out.soNumber, out.reused, out.reopenedFrom),
        body: `申込者: ${name}\n受付方法: ${STAFF_ACCEPT_CHANNELS[who.channel] || who.channel}\n受付日: ${who.receivedDate}\n`
          + `支払方法: ${PAY_LABELS[payKey]}\n${shipLine}\n${stLine}`
          + (preferredDate ? `ご希望日: ${preferredDate}\n` : "")
          + (note ? `メモ: ${note}\n` : ""),
        attachmentUrls: [],
      });
    } else {
      tx.set(db.collection("activities").doc(), {
        caseId: q.caseId, type: "memo", occurredAt: now, userId: "system",
        subject: Flow.webAcceptSubject(q.estNo, out.soNumber, out.reused, out.reopenedFrom),
        body: `お申し込み者: ${name}\n支払方法: ${PAY_LABELS[payKey]}\n`
          + `届け先: ${[d.postalCode ? "〒" + d.postalCode : "", d.company, d.officeName, d.address].filter(Boolean).join(" ")}\n`
          + `${shipLine}\n${stLine}`
          + (preferredDate ? `ご希望日: ${preferredDate}\n` : "")
          + (note ? `ご要望: ${note}\n` : ""),
        attachmentUrls: [],
      });
    }
  });
  return out;
}

// 「各事業所の住所へ」用に、見積もりに紐づく事業所の住所を届け先へ変換する（無ければ見積もりの事業所名だけ使う）
async function deliveryFromOfficeForQuote(q) {
  let office = null;
  if (q.officeId) {
    const od = await db.collection("offices").doc(q.officeId).get();
    if (od.exists) office = od.data();
  }
  return {
    company: q.corpName || (office && office.corpName) || "",
    officeName: q.officeName || (office && office.officeName) || "",
    postalCode: (office && office.postalCode) || "",
    address: (office && office.address) || "",
    contactName: q.contactName || "",
    phone: (office && office.phone) || "",
  };
}

const MAX_ACCEPT_QUOTES = 20;

exports.acceptQuote = onRequest(
  { region: "asia-northeast1", cors: true, timeoutSeconds: 120, secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_MAIL },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
    if (await appCheckGate(req, res, "acceptQuote")) return;
    try {
      const body = req.body || {};

      // ===== 複数事業所を一括で申し込む（body.quotes 経路）=====
      if (Array.isArray(body.quotes)) {
        const list = body.quotes;
        if (!list.length || list.length > MAX_ACCEPT_QUOTES) {
          res.status(400).json({ status: "error", message: `quotes は1〜${MAX_ACCEPT_QUOTES}件で指定してください` });
          return;
        }
        if (!body.agreedName || !String(body.agreedName).trim()) {
          res.status(400).json({ status: "error", message: "お申し込み者のお名前をご入力ください" });
          return;
        }
        const payKey = body.payMethod === "before" ? "before" : "after";
        const deliveryMode = body.deliveryMode === "single" ? "single" : "each";

        const results = [];
        for (const item of list) {
          try {
            if (!item || !item.quoteId || !item.quoteToken) throw new Error("quoteId・quoteToken は必須です");
            let delivery = body.delivery || {};
            if (deliveryMode === "each") {
              const preSnap = await db.collection("quotes").doc(String(item.quoteId)).get();
              if (!preSnap.exists) throw new HttpsError("not-found", "見積もりが見つかりません");
              delivery = await deliveryFromOfficeForQuote({ id: preSnap.id, ...preSnap.data() });
            }
            const r = await acceptQuoteTransaction({
              quoteId: item.quoteId, quoteToken: item.quoteToken, delivery, payKey,
              preferredDate: body.preferredDate, note: body.note,
              agreedName: body.agreedName, agreedPolicy: body.agreedPolicy,
            });
            results.push({ ...r, quoteId: item.quoteId, ok: true, soNumber: r.soNumber || r.q.shipmentNo || "" });
          } catch (e) {
            const msg = e instanceof HttpsError ? e.message : (e.message || String(e));
            console.error("acceptQuote(group) item error:", item && item.quoteId, e);
            results.push({ quoteId: item && item.quoteId, ok: false, error: msg });
          }
        }

        // 事業所への確認メール・Chat通知はまとめて1通（新規に受け付けた分だけを対象にする。二重受付は対象外）
        const newly = results.filter((r) => r.ok && !r.alreadyAccepted);
        if (newly.length) {
          const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
          const first = newly[0].q;
          const to = first.contactEmail || "";
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
            try {
              const m = acceptMailTextGroup({ items: newly, agreedName: body.agreedName, payKey, preferredDate: body.preferredDate });
              await sendGmail({ to, cc: GMAIL_SENDER, subject: m.subject, body: m.body });
            } catch (e) { console.error("acceptQuote(group) mail error:", e); }
          }

          const chatWebhook = await getWebhook("crm");
          const regionsA = await Promise.all(newly.map((r) => officeRegionLabel({ officeId: r.q.officeId })));
          await notifyChat(
            chatWebhook,
            `🛒 お申し込み（${newly.length}事業所・${first.corpName || ""}）\n`
            + newly.map((r, i) => `・#${r.q.caseNumber} ${regionsA[i]}${r.q.officeName}（${r.q.estNo}）出荷 ${r.soNumber} ${yen(r.q.amounts?.totalIncl)}`
              + (acceptShipNote(r) ? `\n　${acceptShipNote(r)}` : "")).join("\n")
            + `\nお支払い: ${PAY_LABELS[payKey]}\n供給管理から「在庫から発送」か「AB Circle へ発注」を選んでください。`
          );
        }

        // 一部失敗は "partial"、全件失敗は "error"。"ok" は全件受け付けたときだけ（Codex レビュー P1・2026-09-14）
        const okResults = results.filter((r) => r.ok), ngResults = results.filter((r) => !r.ok);
        const groupStatus = ngResults.length === 0 ? "ok" : okResults.length > 0 ? "partial" : "error";
        res.status(groupStatus === "error" ? 400 : 200).json({
          status: groupStatus,
          message: ngResults.length
            ? `${ngResults.length}件の事業所のお申し込みを受け付けられませんでした（${ngResults.map((r) => r.error).join("／")}）`
            : undefined,
          results: results.map((r) => r.ok
            ? { quoteId: r.quoteId, caseNumber: r.q.caseNumber, shipmentNo: r.soNumber }
            : { quoteId: r.quoteId, error: r.error }),
        });
        return;
      }

      // ===== 従来の単一見積もり経路（挙動は変えない）=====
      const { quoteId, quoteToken, delivery, payMethod, preferredDate, note, agreedName, agreedPolicy } = body;
      if (!quoteId || !quoteToken) { res.status(400).json({ status: "error", message: "quoteId・quoteToken は必須です" }); return; }
      if (!agreedName || !String(agreedName).trim()) { res.status(400).json({ status: "error", message: "お申し込み者のお名前をご入力ください" }); return; }
      const payKey = payMethod === "before" ? "before" : "after";
      const d = delivery || {};

      const acc = await acceptQuoteTransaction({
        quoteId, quoteToken, delivery, payKey, preferredDate, note, agreedName, agreedPolicy,
      });
      const { q, soNumber, alreadyAccepted } = acc;

      if (alreadyAccepted) {
        res.status(200).json({ status: "already", soNumber: q.shipmentNo || "", caseNumber: q.caseNumber });
        return;
      }

      // 事業所へ確認メール
      const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
      const to = q.contactEmail || "";
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        try {
          const m = acceptMailText({ q, agreedName, payKey, delivery: d, preferredDate });
          await sendGmail({ to, cc: GMAIL_SENDER, subject: m.subject, body: m.body });
        } catch (e) { console.error("acceptQuote mail error:", e); }
      }

      const chatWebhook = await getWebhook("crm");
      const regionAq = await officeRegionLabel({ officeId: q.officeId });
      await notifyChat(
        chatWebhook,
        `🎉 お申し込みを受け付けました [案件 #${q.caseNumber}]\n見積: ${q.estNo}（v${q.version}）\n事業所: ${regionAq}${q.officeName}（${q.corpName || ""}）\n`
        + `金額: ${yen(q.amounts?.totalIncl)}（自己負担 ${yen(q.amounts?.selfPay)}）\nお支払い: ${PAY_LABELS[payKey]}\n`
        + (acc.reused || acc.duplicateWarning ? `${acceptShipNote(acc)}\n` : `${acc.reopenedFrom ? `${acceptShipNote(acc)} ` : ""}出荷 ${soNumber} の下書きを作りました。`)
        + `供給管理から「在庫から発送」か「AB Circle へ発注」を選んでください。`
      );

      res.status(200).json({ status: "ok", soNumber, caseNumber: q.caseNumber });
    } catch (e) {
      // トランザクション内で投げた HttpsError は、事業所に見せてよい文言なのでそのまま返す
      if (e instanceof HttpsError) {
        const code = e.code === "not-found" ? 404 : (e.code === "permission-denied" ? 403 : 409);
        res.status(code).json({ status: "error", message: e.message });
        return;
      }
      console.error("acceptQuote error:", e);
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);

// ===== 電話・メール等で受けたお申し込みを、スタッフが「受注確定」にする（2026-10-21 設計 §5 A）=====
// admin/js/quote-admin.js の「受注確定にする（電話・メールで申込を受けた）」から呼ぶ（画面との約束: admin/js/screen-rules.js buildAcceptPayload）。
// 入力 {quoteId, acceptedName, channel:"phone"|"email"|"fax"|"other", receivedDate:"YYYY-MM-DD", payMethod:"after"|"before",
//       preferredDate?, note?, sendMail:boolean, groupQuoteIds?:string[]（対象以外の同じグループの見積もり）}
// 戻り値 {ok:true, results:[{quoteId, shipmentId, soNumber}], partial:boolean, errors:[{quoteId, code, message}],
//        mailed:boolean, mailError:string|null}（確認メールの宛先は案件の contactEmail → 見積もりの contactEmail の順）
// 全件が拒否されたときは HttpsError（failed-precondition）で返す（メッセージは checkStaffAccept の文言そのまま）。
// 確認メールは sendMail が真で宛先があるときだけ。Chat は常に投稿する（CRM通知の投稿先）。
exports.staffAcceptQuote = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB", secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_MAIL },
  async (request) => {
    const me = await requireStaff(request, { allow: "editor" });
    const { quoteId, acceptedName, channel, receivedDate, payMethod, preferredDate, note, sendMail, groupQuoteIds } = request.data || {};
    if (!quoteId || typeof quoteId !== "string") throw new HttpsError("invalid-argument", "quoteId は必須です");
    const name = String(acceptedName || "").trim().slice(0, 100);
    if (!name) throw new HttpsError("invalid-argument", "申込者のお名前を入れてください");
    if (!Object.prototype.hasOwnProperty.call(STAFF_ACCEPT_CHANNELS, channel)) throw new HttpsError("invalid-argument", "受付方法（電話・メール・FAX・その他）を選んでください");
    if (Flow.jstMidnightMs(receivedDate) == null) throw new HttpsError("invalid-argument", "受付日を正しく入れてください（YYYY-MM-DD）");
    if (preferredDate && Flow.jstMidnightMs(preferredDate) == null) throw new HttpsError("invalid-argument", "希望日を正しく入れてください（YYYY-MM-DD）");
    const payKey = payMethod === "before" ? "before" : "after";
    const memo = String(note || "").trim().slice(0, 1000);

    // 対象の一覧（同じグループの見積もりを同時に確定するとき）
    const extra = Array.isArray(groupQuoteIds) ? groupQuoteIds.filter((x) => typeof x === "string" && x && x !== quoteId) : [];
    const ids = [quoteId, ...new Set(extra)];
    if (ids.length > MAX_ACCEPT_QUOTES) throw new HttpsError("invalid-argument", `一度に受注確定にできるのは${MAX_ACCEPT_QUOTES}件までです`);
    const pre = await Promise.all(ids.map(async (id) => {
      const s = await db.collection("quotes").doc(id).get();
      return s.exists ? { id: s.id, ...s.data() } : null;
    }));
    // 1件だけならグループでなくてよい。groupQuoteIds があるのに対象がグループでなければ拒否（Flow.checkAcceptGroup）
    if (!pre[0]) throw new HttpsError("not-found", "見積もりが見つかりません");
    const g = Flow.checkAcceptGroup(pre, ids);
    if (!g.ok) throw new HttpsError("failed-precondition", g.message);

    const actor = { kind: "staff", email: me.email, uid: me.uid, name: me.name, channel, receivedDate, acceptedName: name };
    const done = [], errors = [];
    for (const pq of pre) {
      try {
        const delivery = await deliveryFromOfficeForQuote(pq);
        const r = await acceptQuoteTransaction({
          quoteId: pq.id, delivery, payKey, preferredDate: preferredDate || "", note: memo, actor,
        });
        done.push({ ...r, quoteId: pq.id });
      } catch (e) {
        if (!(e instanceof HttpsError)) console.error("staffAcceptQuote item error:", pq && pq.id, e);
        errors.push({ quoteId: pq.id, code: (e && e.details && e.details.code) || (e && e.code) || "error", message: e.message || String(e) });
      }
    }
    if (!done.length) {
      throw new HttpsError("failed-precondition", errors.map((e) => e.message).join("／"), { errors });
    }

    // 事業所への確認メール（任意）。宛先は案件の contactEmail を優先し、無ければ見積もりの contactEmail（レビュー指摘 6）
    // 戻り値の mailed（送れたか）・mailError（送らなかった／送れなかった理由。送れたか送る指定でなければ null）は画面が表示に使う
    let mailed = false, mailError = null;
    const first = done[0].q;
    const to = Flow.acceptMailTo(done[0].caseContactEmail, first.contactEmail);
    if (sendMail && !to) mailError = "宛先のメールアドレスが案件にも見積もりにも登録されていないため、確認メールは送っていません";
    if (sendMail && to) {
      try {
        const m = done.length === 1
          ? acceptMailText({ q: first, agreedName: name, payKey, delivery: await deliveryFromOfficeForQuote(first), preferredDate })
          : acceptMailTextGroup({ items: done, agreedName: name, payKey, preferredDate });
        const sent = await sendGmail({ to, cc: GMAIL_SENDER, subject: m.subject, body: m.body });
        mailed = true;
        for (const r of done) {
          await db.collection("activities").add({
            caseId: r.q.caseId, type: "gmail_sent", occurredAt: admin.firestore.FieldValue.serverTimestamp(),
            userId: me.uid, userName: me.email,
            subject: `メール送信: ${m.subject}`, body: `宛先: ${to}（受注確定の確認メール・送信元 ${sent.sender}）`, attachmentUrls: [],
          });
        }
      } catch (e) { mailError = String((e && e.message) || e || "送信に失敗しました"); console.error("staffAcceptQuote mail error:", e); }
    }

    // Chat（CRM通知の投稿先）。利用者の情報・申込者名・連絡先は載せない
    try {
      const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
      const regions = await Promise.all(done.map((r) => officeRegionLabel({ officeId: r.q.officeId })));
      await notifyChat(await getWebhook("crm"),
        `${Flow.staffAcceptChatHead(channel, me.name)}\n`
        + done.map((r, i) => `・#${r.q.caseNumber} ${regions[i]}${r.q.officeName || ""}（${r.q.estNo}）出荷 ${r.soNumber} ${yen(r.q.amounts?.totalIncl)}`
          + (acceptShipNote(r) ? `\n　${acceptShipNote(r)}` : "")).join("\n")
        + `\n受付日: ${receivedDate}／お支払い: ${PAY_LABELS[payKey]}`
        + (errors.length ? `\n⚠️ ${errors.length}件は受注確定にできませんでした（CRMで確認してください）` : "")
        + `\n供給管理から「在庫から発送」か「AB Circle へ発注」を選んでください。`);
    } catch (e) { console.error("staffAcceptQuote chat error:", e.message); }

    return {
      ok: true,
      results: done.map((r) => ({ quoteId: r.quoteId, shipmentId: r.shipRefId, soNumber: r.soNumber })),
      partial: errors.length > 0,
      errors,
      mailed: mailed === true, mailError: mailError || null,
    };
  }
);

// ===== 見積もりの改版（2026-09-06・Phase 2）=====
// 「見積もりを取ったあと、支援の調整で台数・タイプ・機種を変えたい」に応えるための関数。
// 前の版は superseded にして残し、新しい版を作る（何をいつ変えたかが追える）。
// 出荷が下書きのうちは、その明細も新しい版に合わせて作り直す。
// 出荷を確定したあとは触らない（請求済・入金済の金額が動くと事故になるため）。既存の「出荷の修正」で直す。
exports.reviseQuote = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB", serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    const { quoteId, plan, btQty, usbQty, btExtra, usbExtra, usbConnector, reason, sendMail } = request.data || {};
    if (!quoteId) throw new HttpsError("invalid-argument", "quoteId は必須です");
    if (!reason || !String(reason).trim()) throw new HttpsError("invalid-argument", "変更の理由をご入力ください（あとから経緯を追えるようにするためです）");

    const baseSnap = await db.collection("quotes").doc(String(quoteId)).get();
    if (!baseSnap.exists) throw new HttpsError("not-found", "見積もりが見つかりません");
    const base = { id: baseSnap.id, ...baseSnap.data() };

    const planKey = ["houmon", "kyojyu", "other"].includes(plan) ? plan : base.plan;
    const calc = Pricing.computeAmounts(planKey, btQty, usbQty, btExtra, usbExtra);
    if (calc.subsidyTotal < 1) throw new HttpsError("invalid-argument", "補助対象のカードリーダーを1台以上にしてください");
    if (calc.subsidyTotal > calc.plan.maxQty) throw new HttpsError("invalid-argument", `${calc.plan.label}の補助対象は最大${calc.plan.maxQty}台です`);
    const connector = ["A", "C"].includes(usbConnector) ? usbConnector : null;
    const items = Pricing.buildItems({ btQty, usbQty, btExtra, usbExtra, usbConnector: connector });
    const amounts = {
      readers: calc.devSubsidyIncl, accompanyFee: calc.accFeeIncl, discount: calc.discount,
      subsidyPartTotal: calc.subsidyPartTotal, extraPartTotal: calc.extraPartTotal,
      totalIncl: calc.totalIncl, grantAmt: calc.grantAmt, selfPay: calc.selfPay,
    };

    // 出荷の状態を確認（下書きなら作り直す・確定後は触らない）
    let shipmentId = base.shipmentId || null, shipStatus = null;
    if (shipmentId) {
      const sh = await db.collection("shipments").doc(shipmentId).get();
      shipStatus = sh.exists ? (sh.data().status || null) : null;
      // 依頼済（requested）も止める: 出荷指示をすでにセンターへ投稿しているため（2026-10-21 出荷の二段階化）
      if (sh.exists && shipStatus === "requested") {
        throw new HttpsError("failed-precondition",
          `この見積もりの出荷（${sh.data().soNumber}）はすでに出荷を依頼済みです（出荷指示を投稿済み）。見積もりを作り直すときは、先に供給管理の出荷一覧で「依頼を取り消す」（下書きへ戻す）をしてから、もう一度やり直してください。センターへの取り消しの連絡もお願いします。`);
      }
      if (sh.exists && shipStatus !== "draft") {
        throw new HttpsError("failed-precondition",
          `この見積もりの出荷（${sh.data().soNumber}）はすでに「${shipStatus}」です。見積もりの作り直しではなく、供給管理の「出荷の修正」で直してください。`);
      }
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const estNo = base.estNo; // 番号は引き継ぎ、版だけ上げる
    const version = (Number(base.version) || 1) + 1;
    const accessToken = newToken();
    const quoteRef = db.collection("quotes").doc();
    const cardReaders = [];
    const bt = Number(btQty) || 0, usb = Number(usbQty) || 0, btx = Number(btExtra) || 0, usbx = Number(usbExtra) || 0;
    if (bt > 0 || btx > 0) cardReaders.push({ type: "BT", subsidyQty: bt, extraQty: btx });
    if (usb > 0 || usbx > 0) cardReaders.push({ type: "USB", subsidyQty: usb, extraQty: usbx, connector });

    const batch = db.batch();
    // 同じ案件の生きている版はすべて superseded に
    const sibSnap = await db.collection("quotes").where("caseId", "==", base.caseId).get();
    for (const d of sibSnap.docs) {
      const st = d.data().status;
      if (st === "issued" || st === "accepted") batch.update(d.ref, { status: "superseded", supersededAt: now });
    }
    batch.set(quoteRef, {
      caseId: base.caseId, officeId: base.officeId || null, caseNumber: base.caseNumber || null,
      estNo, version, plan: planKey, planLabel: calc.plan.label, items, amounts,
      status: base.status === "accepted" ? "accepted" : "issued",
      supersedes: base.id, reason: String(reason).trim().slice(0, 500),
      validUntil: daysFromNow(30),   // 改版は新しい見積書なので有効期限を30日振り直す（2026-09-14）
      createdVia: "staff", createdBy: email, createdAt: now,
      contactEmail: base.contactEmail || "", contactName: base.contactName || "",
      officeName: base.officeName || "", corpName: base.corpName || "",
      accessToken, pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null,
      shipmentId: shipmentId || null, shipmentNo: base.shipmentNo || null,
      payMethod: base.payMethod || null, delivery: base.delivery || null,
      acceptedAt: base.acceptedAt || null, acceptedBy: base.acceptedBy || null,
    });
    batch.update(db.collection("cases").doc(base.caseId), {
      latestQuoteId: quoteRef.id, quoteIssuedAt: now, updatedAt: now,
      subsidyPlan: calc.plan.label, cardReaders, subsidyCategory: planKey,
      expectedSubsidyAmount: calc.grantAmt, totalAmount: calc.totalIncl,
      specialDiscount: calc.discount, selfPay: calc.selfPay,
    });
    // 下書きの出荷は最新の内容に作り直す（数量・品番・金額）
    if (shipmentId && shipStatus === "draft") {
      batch.update(db.collection("shipments").doc(shipmentId), {
        items: shipmentItemsFromQuote({ items, amounts }),
        quoteId: quoteRef.id, estNo,
        // 伴走支援費ブロックの復元に使う補助区分・台数も新しい版に合わせる（2026-10-21 レビュー指摘 2）
        subsidyCategory: planKey || null, subsidyQty: Flow.subsidyQtyFromItems(items, Pricing.SKU.BT),
        updatedAt: now, updatedBy: email,
      });
    }
    const before = (base.items || []).map((i) => `${i.sku}×${(Number(i.subsidyQty) || 0) + (Number(i.extraQty) || 0)}`).join("・");
    const after = items.map((i) => `${i.sku}×${(Number(i.subsidyQty) || 0) + (Number(i.extraQty) || 0)}`).join("・");
    batch.set(db.collection("activities").doc(), {
      caseId: base.caseId, type: "memo", occurredAt: now, userId: request.auth.uid, userName: email,
      subject: `見積もりを変更（${estNo} v${base.version} → v${version}）`,
      body: `理由: ${String(reason).trim()}\n変更前: ${before}（¥${fmtNum(Number(base.amounts?.totalIncl || 0))}）\n`
        + `変更後: ${after}（¥${fmtNum(calc.totalIncl)}）`
        + (shipmentId && shipStatus === "draft" ? `\n出荷 ${base.shipmentNo || ""} の下書きも新しい内容に更新しました。` : ""),
      attachmentUrls: [],
    });
    await batch.commit();

    // 事業所へ変更後の見積もりを知らせる（PDFはこの時点では無いので、金額と変更点をメールで伝える）
    let mailed = false;
    const to = base.contactEmail || "";
    if (sendMail !== false && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
      const diff = calc.totalIncl - (Number(base.amounts?.totalIncl) || 0);
      try {
        await sendGmail({
          to, cc: GMAIL_SENDER,
          subject: `【変更後】【NPO法人タダカヨ】お見積もりの内容を変更しました（${estNo}）`,
          body:
            `${[base.corpName, base.officeName].filter(Boolean).join("　")} 御中\n${base.contactName ? base.contactName + " 様" : "ご担当者様"}\n\n` +
            `お打ち合わせの内容にもとづき、お見積もりを変更しました。\n\n` +
            `見積番号: ${estNo}（第${version}版）\n` +
            `変更後の合計（税込）: ${yen(calc.totalIncl)}　／　助成金充当: ${yen(calc.grantAmt)}　／　自己負担: ${yen(calc.selfPay)}\n` +
            (diff !== 0 ? `前回との差額: ${diff > 0 ? "＋" : "−"}${yen(Math.abs(diff))}\n` : "") +
            `\n内容にお間違いがないか、ご確認をお願いします。相違があればこのメールへの返信でお知らせください。\n\n` +
            `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`,
        });
        mailed = true;
        await db.collection("activities").add({
          caseId: base.caseId, type: "gmail_sent", occurredAt: admin.firestore.FieldValue.serverTimestamp(),
          userId: request.auth.uid, userName: email,
          subject: `メール送信: 【変更後】お見積もり（${estNo} v${version}）`, body: `宛先: ${to}`, attachmentUrls: [],
        });
      } catch (e) { console.error("reviseQuote mail error:", e); }
    }
    return { ok: true, quoteId: quoteRef.id, version, totalIncl: calc.totalIncl, mailed, shipmentUpdated: !!(shipmentId && shipStatus === "draft") };
  }
);

// CRM から見積書PDFを再送（スタッフ操作・保存済みPDFを Storage から読んで添付）
exports.resendQuoteMail = onCall(
  { region: "asia-northeast1", timeoutSeconds: 60, memory: "512MiB", serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    const { quoteId, to: toOverride } = request.data || {};
    if (!quoteId) throw new HttpsError("invalid-argument", "quoteId は必須です");
    const ref = db.collection("quotes").doc(String(quoteId));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "見積もりが見つかりません");
    const q = { id: snap.id, ...snap.data() };
    if (!q.pdfPath) throw new HttpsError("failed-precondition", "この見積もりのPDFは保存されていません（事業所側でPDF作成が完了していない可能性）");
    const to = (toOverride || q.contactEmail || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpsError("invalid-argument", "宛先メールアドレスが不正です");
    try {
      const [buf] = await admin.storage().bucket(QUOTE_BUCKET).file(q.pdfPath).download();
      const m = quoteMailText(q, { resend: !!q.mailedAt });
      const sent = await sendGmail({ to, cc: GMAIL_SENDER, subject: m.subject, body: m.body,
        attachments: [{ filename: `${q.estNo}.pdf`, mimeType: "application/pdf", contentBase64: buf.toString("base64") }] });
      const now = admin.firestore.FieldValue.serverTimestamp();
      await ref.update({ mailedAt: now, mailedTo: to, mailError: null });
      await db.collection("activities").add({
        caseId: q.caseId, type: "gmail_sent", occurredAt: now, userId: request.auth.uid, userName: email,
        subject: `メール送信: ${m.subject}`, body: `宛先: ${to}（見積書PDF添付）`, attachmentUrls: q.pdfUrl ? [q.pdfUrl] : [],
      });
      await db.collection("cases").doc(q.caseId).update({ updatedAt: now });
      return { ok: true, id: sent.id };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("resendQuoteMail error:", e);
      throw new HttpsError("internal", `送信処理に失敗しました: ${e.message}`);
    }
  }
);

// ===== スタッフが電話等で受けた相談から、最初の見積もりを作る（2026-09-14）=====
// admin/js/quote-admin.js の「見積もりを作る」から呼ぶ。reviseQuote と同じ版管理（estNo引き継ぎ・supersede）を使うが、
// 変更理由の入力は求めない（最初の1件を作るだけのため）。PDFはこの時点では作らず、金額と内容だけをメールで知らせる。
exports.staffCreateQuote = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB", serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    const { caseId, plan, btQty, usbQty, btExtra, usbExtra, usbConnector, note, sendMail } = request.data || {};
    if (!caseId) throw new HttpsError("invalid-argument", "caseId は必須です");

    const caseSnap = await db.collection("cases").doc(String(caseId)).get();
    if (!caseSnap.exists) throw new HttpsError("not-found", "案件が見つかりません");
    const kase = { id: caseSnap.id, ...caseSnap.data() };

    const planKey = ["houmon", "kyojyu", "other"].includes(plan) ? plan : null;
    if (!planKey) throw new HttpsError("invalid-argument", "プランの指定が不正です");
    const calc = Pricing.computeAmounts(planKey, btQty, usbQty, btExtra, usbExtra);
    if (calc.subsidyTotal < 1) throw new HttpsError("invalid-argument", "補助対象のカードリーダーを1台以上にしてください");
    if (calc.subsidyTotal > calc.plan.maxQty) throw new HttpsError("invalid-argument", `${calc.plan.label}の補助対象は最大${calc.plan.maxQty}台です`);
    const connector = ["A", "C"].includes(usbConnector) ? usbConnector : null;
    const items = Pricing.buildItems({ btQty, usbQty, btExtra, usbExtra, usbConnector: connector });
    const amounts = {
      readers: calc.devSubsidyIncl, accompanyFee: calc.accFeeIncl, discount: calc.discount,
      subsidyPartTotal: calc.subsidyPartTotal, extraPartTotal: calc.extraPartTotal,
      totalIncl: calc.totalIncl, grantAmt: calc.grantAmt, selfPay: calc.selfPay,
    };
    const cardReaders = [];
    const bt = Number(btQty) || 0, usb = Number(usbQty) || 0, btx = Number(btExtra) || 0, usbx = Number(usbExtra) || 0;
    if (bt > 0 || btx > 0) cardReaders.push({ type: "BT", subsidyQty: bt, extraQty: btx });
    if (usb > 0 || usbx > 0) cardReaders.push({ type: "USB", subsidyQty: usb, extraQty: usbx, connector });

    // 案件の既存 quotes を version 降順で見る。あれば estNo・番号を引き継いで版を上げ、生きている前版は supersede
    const sibSnap = await db.collection("quotes").where("caseId", "==", kase.id).get();
    const siblings = sibSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.version || 0) - (a.version || 0));
    const latest = siblings[0] || null;
    // 申し込み済み（accepted）の版がある案件は、出荷下書きとの同期が要るので「内容を変更する」（reviseQuote）側で扱う
    if (siblings.some((s) => s.status === "accepted")) {
      throw new HttpsError("failed-precondition", "この案件は申し込み済みの見積もりがあります。見積もりカードの「内容を変更する」から改版してください。");
    }

    // 事業所（案件に無ければ offices から補う）
    let office = null;
    if (kase.officeId) {
      const od = await db.collection("offices").doc(kase.officeId).get();
      if (od.exists) office = od.data();
    }
    const corpName = kase.corpName || (office && office.corpName) || "";
    const officeName = kase.officeName || (office && office.officeName) || "";
    const contactEmail = kase.contactEmail || "";
    const contactName = kase.contactName || "";

    const now = admin.firestore.FieldValue.serverTimestamp();
    const estNo = latest?.estNo || await getNextQuoteNumber();
    const version = (latest?.version || 0) + 1;
    const accessToken = newToken();
    const quoteRef = db.collection("quotes").doc();

    const batch = db.batch();
    for (const s of siblings) {
      if (s.status === "issued") batch.update(db.collection("quotes").doc(s.id), { status: "superseded", supersededAt: now });
    }
    batch.set(quoteRef, {
      caseId: kase.id, officeId: kase.officeId || null, caseNumber: kase.caseNumber || null,
      estNo, version, plan: planKey, planLabel: calc.plan.label, items, amounts,
      status: "issued", supersedes: latest ? latest.id : null,
      validUntil: daysFromNow(30), createdVia: "staff", createdBy: email, createdAt: now,
      contactEmail, contactName, officeName, corpName,
      accessToken, pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null,
      note: String(note || "").slice(0, 1000),
    });
    const caseUpdate = {
      latestQuoteId: quoteRef.id, quoteIssuedAt: now, updatedAt: now,
      subsidyPlan: calc.plan.label, cardReaders, subsidyCategory: planKey,
      expectedSubsidyAmount: calc.grantAmt, totalAmount: calc.totalIncl,
      specialDiscount: calc.discount, selfPay: calc.selfPay,
    };
    if (kase.status === STATUS.NEW) caseUpdate.status = STATUS.CONFIRMING;
    batch.update(db.collection("cases").doc(kase.id), caseUpdate);
    batch.set(db.collection("activities").doc(), {
      caseId: kase.id, type: "memo", occurredAt: now, userId: request.auth.uid, userName: email,
      subject: `見積もりを作成（${estNo}・v${version}・スタッフ）`,
      body: `プラン: ${calc.plan.label}\n構成: ${cardReaders.map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`).join(", ")}${connector ? `（USB ${connector === "C" ? "Type-C" : "Type-A"}）` : ""}\n合計（税込）: ¥${fmtNum(calc.totalIncl)}／自己負担: ¥${fmtNum(calc.selfPay)}`
        + (note ? `\nメモ: ${String(note).trim()}` : ""),
      attachmentUrls: [],
    });
    await batch.commit();

    // メールでの案内（PDFはまだ無いので、内容と有効期限をテキストで知らせる。追ってPDFを送る旨を添える）
    let mailed = false;
    if (sendMail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      const yen = (n) => `¥${fmtNum(Number(n || 0))}`;
      const crSummary = cardReaders.map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`).join(", ");
      const until = daysFromNow(30).toDate().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      try {
        await sendGmail({
          to: contactEmail, cc: GMAIL_SENDER,
          subject: `【NPO法人タダカヨ】お見積り内容のご案内（${estNo}）`,
          body:
            `${[corpName, officeName].filter(Boolean).join("　")} 御中\n${contactName ? contactName + " 様" : "ご担当者様"}\n\n` +
            `NPO法人タダカヨです。お見積り内容をご案内します。\n\n` +
            `見積番号: ${estNo}（第${version}版）\n` +
            `プラン: ${calc.plan.label}\n` +
            `構成: ${crSummary}\n` +
            `合計（税込）: ${yen(calc.totalIncl)}　／　助成金充当: ${yen(calc.grantAmt)}　／　自己負担: ${yen(calc.selfPay)}\n` +
            `有効期限: ${until}\n\n` +
            `PDFの見積書は追ってお送りします。\n` +
            `このメールへの返信でご相談・お申し込みを承ります。\n\n` +
            `NPO法人タダカヨ 介護情報基盤伴走支援事業\nkjk-staff@tadakayo.jp`,
        });
        mailed = true;
        // sendQuotePdf/saveQuotePdf の mailedAt（PDF送付済み判定）とは別物にする
        await quoteRef.update({ noticeMailedAt: admin.firestore.FieldValue.serverTimestamp(), noticeMailedTo: contactEmail });
        await db.collection("activities").add({
          caseId: kase.id, type: "gmail_sent", occurredAt: admin.firestore.FieldValue.serverTimestamp(),
          userId: request.auth.uid, userName: email,
          subject: `メール送信: お見積り内容のご案内（${estNo} v${version}）`, body: `宛先: ${contactEmail}`, attachmentUrls: [],
        });
      } catch (e) { console.error("staffCreateQuote mail error:", e); }
    }

    return { ok: true, quoteId: quoteRef.id, estNo, version, totalIncl: calc.totalIncl, mailed };
  }
);

// ===== CRMから見積書PDFを保存・送付（スタッフ操作・quote-print.html から）=====
// admin用の callable 版。onRequest の sendQuotePdf（事業所側・quoteToken確認）とは別物で、
// こちらは @tadakayo.jp のスタッフ認証で操作する。ヘルパー名の衝突を避けるため storeQuotePdfFile を使う。
exports.saveQuotePdf = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB", serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    const { quoteId, pdfBase64, mail } = request.data || {};
    if (!quoteId || !pdfBase64) throw new HttpsError("invalid-argument", "quoteId・pdfBase64 は必須です");
    if (typeof pdfBase64 !== "string" || pdfBase64.length > 13_400_000) throw new HttpsError("invalid-argument", "PDFが大きすぎます（10MB以下）");

    const ref = db.collection("quotes").doc(String(quoteId));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "見積もりが見つかりません");
    const q = { id: snap.id, ...snap.data() };

    const filename = `${q.estNo}-v${q.version}.pdf`;
    const saved = await storeQuotePdfFile(q.caseId, filename, pdfBase64);
    const wantsMail = mail !== false;

    if (wantsMail && q.mailedAt) {
      await ref.update({ pdfPath: saved.path, pdfUrl: saved.url });
      return { ok: true, status: "already", pdfUrl: saved.url, mailed: false };
    }

    let mailed = false;
    const now = admin.firestore.FieldValue.serverTimestamp();
    if (wantsMail) {
      const to = q.contactEmail || "";
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        try {
          const m = quoteMailText(q);
          const sent = await sendGmail({ to, cc: GMAIL_SENDER, subject: m.subject, body: m.body,
            attachments: [{ filename: `${q.estNo}.pdf`, mimeType: "application/pdf", contentBase64: pdfBase64 }] });
          mailed = true;
          await ref.update({ pdfPath: saved.path, pdfUrl: saved.url, mailedAt: now, mailedTo: to, mailError: null });
          await db.collection("activities").add({
            caseId: q.caseId, type: "gmail_sent", occurredAt: now, userId: request.auth.uid, userName: sent.sender,
            subject: `メール送信: ${m.subject}`, body: `宛先: ${to}（見積書PDF添付・スタッフ送付）`, attachmentUrls: [saved.url],
          });
        } catch (e) {
          console.error("saveQuotePdf mail error:", e);
          await ref.update({ pdfPath: saved.path, pdfUrl: saved.url, mailError: e.message });
        }
      } else {
        await ref.update({ pdfPath: saved.path, pdfUrl: saved.url });
      }
    } else {
      await ref.update({ pdfPath: saved.path, pdfUrl: saved.url });
    }
    return { ok: true, status: "ok", pdfUrl: saved.url, mailed };
  }
);

const WEBHOOK_KIND_LABELS = { crm: "CRM通知", pm: "PM", shipping: "出荷指示", accounting: "経理" };
exports.testChatNotify = onCall({ region: "asia-northeast1", secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_BATCH }, async (request) => {
    await requireStaff(request, { allow: "admin" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
  const email = request.auth?.token?.email || "";
  if (!email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "権限がありません");
  const kind = (request.data && request.data.kind) || "crm";
  if (!WEBHOOK_KIND_LABELS[kind]) throw new HttpsError("invalid-argument", "投稿先の種類が不正です");
  _settingsCache = null; // 最新設定で送る
  const url = await getWebhook(kind);
  if (!url) throw new HttpsError("failed-precondition", `${WEBHOOK_KIND_LABELS[kind]}の投稿先は未設定、または停止中です`);
  await notifyChat(url, `✅ タダカヨCRM 設定テスト通知（${WEBHOOK_KIND_LABELS[kind]}の投稿先・送信者: ${email}）`);
  return { ok: true };
});

// ===== Phase 6: アフターフォロー自動化（日次・Chat通知）=====
// 2026-10-21 書き換え（設計 §3 N2・N3）: 分類と文面は notify-text.mjs（純粋 ESM）、投稿計画は accept-flow.js の planDailyPosts。
//   全体1通（初期連絡の超過・未割当の新規・受注確定以降の未割当・担当なしの停滞）＋担当ごとに1通（未対応が1件以上の人だけ・@メンション）。
//   期限は設定値（appConfig/settings.subsidyDeadline）。対象外（archived）は全項目で除外。
//   二重実行防止: _notifyLog/daily_YYYY-MM-DD（JST）を create（既にあれば何もしない）。投稿の間に 1.1 秒あける（Chat の毎秒の上限）。

// offices から地域ラベル「【大阪府 豊中市】」を引く関数を作る（officeRegionLabel と同じ規則を同期で）
function regionOfFromOffices(officeMap) {
  return (c) => {
    const o = officeMap.get(c.officeId) || {};
    if (o.prefecture || o.city) return formatRegion(o.prefecture, o.city);
    const r = regionFromAddress(o.address);
    return formatRegion(r.prefecture, r.city);
  };
}

// 日次まとめの本文を組み立てる（投稿はしない）。dailyFollowup と previewDailyFollowup で共用
// 読むのは本番の (default) データベースだけ（db = admin.firestore()）。練習DB（practice）は読まない（2026-10-21）。
// dailyFollowup・previewDailyFollowup の両方がここを通る。
async function buildDailyPlan(now = new Date()) {
  const nt = await loadNotify();
  _settingsCache = null; // 期限の設定を直した直後でも最新を使う
  const [caseSnap, officeSnap, userSnap, settings] = await Promise.all([
    db.collection("cases").get(), db.collection("offices").get(), db.collection("users").get(), getSettings(),
  ]);
  const cases = caseSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const users = userSnap.docs.map((d) => ({ ...d.data(), email: d.id }));
  const regionOf = regionOfFromOffices(new Map(officeSnap.docs.map((d) => [d.id, d.data()])));
  return Flow.planDailyPosts(nt, { cases, users, settings, now, regionOf });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Chat に文字だけを投稿（res.ok を確かめる。失敗は例外）。URL はログに出さない
async function postChatText(url, text) {
  await postChatCard(url, { text });
}
const maskUrl = (e) => String((e && e.message) || e).replace(/https?:\/\/\S+/g, "(URL)").slice(0, 200);

// _notifyLog/{id} を「最初の1回だけ」作る。既にあれば false（Firestore の ALREADY_EXISTS = 6）
async function claimNotifyLog(id, data) {
  try {
    await db.collection("_notifyLog").doc(id).create({ ...data, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  } catch (e) {
    if (e && (e.code === 6 || e.code === "already-exists" || /ALREADY_EXISTS/.test(String(e.message)))) return false;
    throw e;
  }
}

exports.dailyFollowup = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Tokyo", region: "asia-northeast1", secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_BATCH },
  async () => {
    const day = todayJst();
    const logId = `daily_${day}`;
    const logRef = db.collection("_notifyLog").doc(logId);
    let claimed = false, posted = 0;
    try {
      if (!(await claimNotifyLog(logId, { kind: "daily", day, status: "running" }))) {
        console.log("dailyFollowup: 本日分は実行済み", logId);
        return;
      }
      claimed = true;
      const plan = await buildDailyPlan(new Date());
      const posts = Flow.dailyPostTexts(plan);
      if (!posts.length) {
        await logRef.update({ status: "nothing", finishedAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log("dailyFollowup done: 通知不要");
        return;
      }
      const url = await getWebhook("crm");
      if (!url) {
        await logRef.update({ status: "no-webhook", finishedAt: admin.firestore.FieldValue.serverTimestamp() });
        console.warn("dailyFollowup: CRM通知の投稿先が未設定・停止中");
        return;
      }
      const errs = [];
      for (let i = 0; i < posts.length; i++) {
        if (i > 0) await sleep(1100);
        try { await postChatText(url, posts[i]); posted++; } catch (e) { errs.push(maskUrl(e)); }
      }
      // 全件の投稿に失敗した（503・429 など）ときは記録を消し、同じ日の再実行で投稿できるようにする（2026-10-21 Codex 指摘）
      if (Flow.dailyFailureAction({ claimed, posted }) === "delete" && errs.length) {
        console.error("dailyFollowup: 全件の投稿に失敗したため記録を消す（再実行で投稿できる）", errs.slice(0, 5));
        await logRef.delete();
        return;
      }
      await logRef.update({
        status: errs.length ? (posted ? "partial" : "error") : "posted",
        overall: !!plan.overall, assignees: plan.assignees.length, posted, errors: errs.slice(0, 5),
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`dailyFollowup done: 投稿 ${posted}/${posts.length}`);
    } catch (e) {
      console.error("dailyFollowup error:", e);
      // 記録を作ったあとの例外（組み立て・投稿先の取得・記録の更新）の後始末（2026-10-21 レビュー指摘 8）
      //   1件も投稿していない → 記録を消す（次の再実行で投稿できるように）／1件以上投稿済み → partial と error を残す（二重投稿を防ぐ）
      const act = Flow.dailyFailureAction({ claimed, posted });
      try {
        if (act === "delete") await logRef.delete();
        else if (act === "partial") {
          await logRef.update({ status: "partial", posted, error: maskUrl(e), finishedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      } catch (e2) {
        console.error(`dailyFollowup: _notifyLog/${logId} の後始末（${act}）に失敗`, e2);
      }
    }
  }
);

// 日次まとめのプレビュー（管理者のみ・投稿しない）。設定画面から本番データで文面を確かめる用（設計 §3）
// 戻り値 {overall: string|null, assignees: [{email, name, text}]}（admin/js/screen-rules.js dailyPreviewBlocks と約束）
exports.previewDailyFollowup = onCall(
  { region: "asia-northeast1", timeoutSeconds: 60, serviceAccount: SA_BATCH },
  async (request) => {
    await requireStaff(request, { allow: "admin" });
    const plan = await buildDailyPlan(new Date());
    return { overall: plan.overall, assignees: plan.assignees };
  }
);

// ===== N1 担当が決まったら本人に通知（2026-10-21 設計 §3）=====
// Firestore トリガー。画面（saveAssignee）だけでなく、他の経路の担当変更も拾う。
// 発火条件は Flow.shouldNotifyAssign（担当が変わった・空でない・対象外/統合元でない・assignedAt が変わった）。
// 二重防止: _notifyLog/assign_${event.id} を create してから投稿（再配信で同じ event.id が来ても1回だけ）。
// cases には書かない（このトリガーが自分を呼び直すループを作らない）。活動の記録は画面側がしている。
// 本番の (default) データベースだけに反応する（database を明示・2026-10-21）。練習DB（practice・テストモード）の
// 案件の担当変更・署名では動かない＝練習中の操作で Chat に通知が飛ばない。
// ⚠️ region は Firestore DB のロケーションに合わせる必要がある。asia-northeast1 で書いているが、デプロイ時に
//    `gcloud firestore databases describe --project kjk-tadakayo` の locationId を確認すること（違えばここを直す）。
exports.onCaseAssigned = onDocumentUpdated(
  { document: "cases/{caseId}", database: "(default)", region: "asia-northeast1", secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_BATCH },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    if (!Flow.shouldNotifyAssign(before, after)) return;
    const caseId = event.params.caseId;
    if (!(await claimNotifyLog(`assign_${event.id}`, { kind: "assign", caseId, assignee: after.assignedUserId, status: "running" }))) return;
    const logRef = db.collection("_notifyLog").doc(`assign_${event.id}`);
    try {
      const nt = await loadNotify();
      const getUser = async (email) => {
        const e = String(email || "").trim();
        if (!e) return null;
        let s = await db.collection("users").doc(e).get();
        if (!s.exists && e.toLowerCase() !== e) s = await db.collection("users").doc(e.toLowerCase()).get();
        return s.exists ? { ...s.data(), email: s.id } : null;
      };
      const assignee = (await getUser(after.assignedUserId))
        || { email: after.assignedUserId, displayName: after.assignedUserName || "" };
      // assignedBy は今回の変更で書かれたもの（assignedAt が変わっている）だけを使う
      const byEmail = String(after.assignedBy || "").trim();
      const by = byEmail ? ((await getUser(byEmail)) || { email: byEmail }) : null;
      const regionLabel = await officeRegionLabel({ officeId: after.officeId });
      const text = nt.assigneeNoticeText({ kase: { ...after, id: caseId }, assignee, assignedBy: by, regionLabel, caseId });
      const url = await getWebhook("crm");
      if (!url) { await logRef.update({ status: "no-webhook" }); return; }
      await postChatText(url, text);
      await logRef.update({ status: "posted", postedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      console.error("onCaseAssigned failed:", maskUrl(e));
      await logRef.update({ status: "error", error: maskUrl(e) }).catch(() => {});
    }
  }
);

// ===== N4 承諾書にオンラインで署名されたら通知（2026-10-21 設計 §3）=====
// 条件 Flow.shouldNotifyConsent（pending→signed・method==="web"・caseId あり）。紙の記録（新規作成で signed）は対象外。
// 案件の活動に記録し cases.updatedAt を更新。Chat（CRM通知）へ担当を @メンション。確認者名・連絡先は載せない。
// 投稿に失敗しても活動は残し、失敗したことを本文に書く。二重防止 _notifyLog/consent_${token}。
// ⚠️ region はデプロイ時に Firestore のロケーションを確認（onCaseAssigned の注記と同じ）。
exports.onConsentSigned = onDocumentUpdated(
  { document: "consentRequests/{token}", database: "(default)", region: "asia-northeast1", secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_BATCH },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    if (!Flow.shouldNotifyConsent(before, after)) return;
    const token = event.params.token;
    const caseId = String(after.caseId);
    if (!(await claimNotifyLog(`consent_${token}`, { kind: "consent", caseId, status: "running" }))) return;
    const logRef = db.collection("_notifyLog").doc(`consent_${token}`);
    let postErr = null;
    let kase = null;
    try {
      const cs = await db.collection("cases").doc(caseId).get();
      kase = cs.exists ? cs.data() : null;
      const nt = await loadNotify();
      let assignee = null;
      if (kase && kase.assignedUserId) {
        const e = String(kase.assignedUserId).trim();
        let us = await db.collection("users").doc(e).get();
        if (!us.exists && e.toLowerCase() !== e) us = await db.collection("users").doc(e.toLowerCase()).get();
        assignee = us.exists ? { ...us.data(), email: us.id } : { email: e, displayName: kase.assignedUserName || "" };
      }
      const regionLabel = await officeRegionLabel({ officeId: kase && kase.officeId });
      const text = nt.consentSignedText({ kase: { ...(kase || {}), id: caseId }, assignee, regionLabel, caseId });
      const url = await getWebhook("crm");
      if (!url) postErr = "CRM通知の投稿先が未設定・停止中";
      else await postChatText(url, text);
    } catch (e) {
      postErr = maskUrl(e);
      console.error("onConsentSigned chat failed:", postErr);
    }
    try {
      if (kase) {
        const now = admin.firestore.FieldValue.serverTimestamp();
        const batch = db.batch();
        batch.set(db.collection("activities").doc(), {
          caseId, type: "memo", occurredAt: now, userId: null, userName: "システム（署名の自動記録）",
          subject: "承諾書にオンラインで署名されました",
          body: `伴走支援の承諾書に、事業所の方がオンラインで署名しました${after.document && after.document.version ? `（条文の版 ${after.document.version}）` : ""}。`
            + "確認者名・署名日時は案件の「承諾書」の欄で確認できます。"
            + (postErr ? `\n※ Chat への通知に失敗しました（${postErr}）。` : ""),
          attachmentUrls: [],
        });
        batch.update(db.collection("cases").doc(caseId), { updatedAt: now });
        await batch.commit();
      }
      await logRef.update({ status: postErr ? "error" : "posted", error: postErr || null, caseFound: !!kase });
    } catch (e) {
      console.error("onConsentSigned record failed:", e);
      await logRef.update({ status: "error", error: maskUrl(e) }).catch(() => {});
    }
  }
);

// ===== AIアシスタント（Vertex AI / Gemini）=====
const SYSTEM_CONTEXT = `あなたは介護事業所向けサービス「タダカヨの介護情報基盤伴走支援」の事務局スタッフを補佐するアシスタントです。
本サービスは、介護事業所が「介護情報基盤」を導入する際の伴走支援（カードリーダー手配・助成金申請ガイド・設定支援）を提供します。NPO法人タダカヨが運営し、営利目的の業者ではありません。
介護現場の用語を正確に使い（利用者・事業所・ケアマネージャー等）、敬意あるていねいな日本語で回答してください。`;

function caseContextText(ctx = {}) {
  const lines = [
    `■ 事業所: ${ctx.officeName || "不明"}${ctx.corpName ? `（${ctx.corpName}）` : ""}`,
    `■ ご担当者: ${ctx.contactName || "不明"}`,
    `■ 流入元: ${ctx.source || "不明"} / ステータス: ${ctx.statusLabel || "不明"}`,
    ctx.subsidyPlan ? `■ 補助金プラン: ${ctx.subsidyPlan}` : "",
    ctx.cardReaders ? `■ カードリーダー: ${ctx.cardReaders}` : "",
    ctx.message ? `■ 問い合わせ/メモ:\n${ctx.message}` : "",
  ];
  if (Array.isArray(ctx.timeline) && ctx.timeline.length) {
    lines.push("■ 対応履歴:");
    ctx.timeline.slice(0, 15).forEach((t) => lines.push(`  - ${t}`));
  }
  if (Array.isArray(ctx.sessionNotes) && ctx.sessionNotes.length) {
    lines.push("■ 伴走支援メモ:");
    ctx.sessionNotes.slice(0, 15).forEach((s) => lines.push(`  - ${s}`));
  }
  return lines.filter(Boolean).join("\n");
}

function buildPrompt(task, ctx, question) {
  const c = caseContextText(ctx);
  switch (task) {
    case "reply_draft":
      return `${SYSTEM_CONTEXT}\n\n以下の案件情報をもとに、事業所のご担当者さま宛ての返信メール文面を作成してください。
件名と本文を出し、次のアクション（例: カードリーダー手配・日程調整・必要書類のご案内）を1つ添えてください。過度な売り込みは避け、安心感のある丁寧な文面に。\n\n【案件情報】\n${c}`;
    case "summary_classify":
      return `${SYSTEM_CONTEXT}\n\n以下の案件を事務局向けに整理してください。出力は次の形式で簡潔に:
【要約】2〜3行
【事業所種別の推定】（例: 居宅介護支援/通所介護/特養 等。不明なら「不明」）
【補助金区分の推定】訪問・通所系(¥64,000) / 居住・入所系(¥55,000) / その他(¥42,000) のいずれか or 不明
【緊急度】高/中/低 と理由
【カードリーダー希望】有/無/不明
【おすすめ次アクション】1〜2点\n\n【案件情報】\n${c}`;
    case "session_report":
      return `${SYSTEM_CONTEXT}\n\n以下の伴走支援メモをもとに、関係者に共有できる支援報告文を作成してください。出力形式:
【実施内容の要約】
【できたこと】
【次回までのTODO】
冗長にせず、現場で読みやすい箇条書き中心に。\n\n【案件情報】\n${c}`;
    case "assistant":
      return `${SYSTEM_CONTEXT}\n\n事務局スタッフからの質問に、案件情報をふまえて回答してください。助成金・申請・カードリーダー・設定など実務的な観点で、わからないことは「要確認」と明示してください。\n\n【案件情報】\n${c}\n\n【質問】\n${question || "この案件の状況を要約し、次にすべきことを教えてください。"}`;
    default:
      return null;
  }
}

exports.aiAssist = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB", serviceAccount: SA_AI },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否
    // 2026-10-21: fn-ai-sa に roles/datastore.viewer を付与済みなので、aiAssist も requireStaff で練習生を拒否する
    //   （2026-10-20 のテストモードでは SA が Firestore を読めないため対象外にしていた。練習中の画面は代役を使う）
    const email = request.auth?.token?.email || "";
    const { task, context, question } = request.data || {};
    const prompt = buildPrompt(task, context || {}, question);
    if (!prompt) throw new HttpsError("invalid-argument", `不明なタスク: ${task}`);

    try {
      const result = await genai().models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 2048, temperature: 0.4 },
      });
      return { text: result.text || "", task };
    } catch (e) {
      console.error("aiAssist error:", e);
      throw new HttpsError("internal", `AI処理に失敗しました: ${e.message}`);
    }
  }
);

// ===== Gmail送信（キーレスDWD：iamcredentials.signJwt → JWT bearer）=====
const GMAIL_SENDER = process.env.GMAIL_SENDER || "kjk-staff@tadakayo.jp";
const GMAIL_SA = `kjk-gmail-sa@${VERTEX_PROJECT}.iam.gserviceaccount.com`;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

async function gmailAccessToken(sender) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: GMAIL_SA, sub: sender, scope: GMAIL_SCOPE,
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  };
  // 鍵を持たず IAM Credentials API でJWTを署名
  const signRes = await client.request({
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GMAIL_SA}:signJwt`,
    method: "POST", data: { payload: JSON.stringify(claims) },
  });
  const tokenRes = await client.request({
    url: "https://oauth2.googleapis.com/token", method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signRes.data.signedJwt,
    }).toString(),
  });
  return tokenRes.data.access_token;
}

function b64(s) { return Buffer.from(s, "utf-8").toString("base64"); }
function encWord(s) { return `=?UTF-8?B?${b64(s)}?=`; }
function wrap76(s) { return String(s).replace(/[\r\n]/g, "").replace(/(.{76})/g, "$1\r\n"); }

// cc・添付（PDF等）に対応。attachments=[{filename, mimeType, contentBase64}]。なければ従来の text/plain。
// 添付ファイル名をMIMEヘッダーに入れる前に無害化する。
// 引用符・改行が入るとヘッダーが壊れる（ヘッダーインジェクション）。英数字・._- 以外は _ に、長さは80まで
function safeAttachmentName(name) {
  const raw = String(name || "file");
  const dot = raw.lastIndexOf(".");
  const ext = dot > 0 ? raw.slice(dot).replace(/[^\w.]/g, "").slice(0, 8) : "";
  let base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^\w.\-]/g, "_").slice(0, 70);
  if (!/[A-Za-z0-9]/.test(base)) base = "file"; // 全部記号や日本語だったら読める名前に
  return base + ext;
}

function buildRawMessage({ to, cc, subject, body, sender, attachments }) {
  const headers = [
    `From: ${encWord("タダカヨ事務局")} <${sender}>`,
    `To: ${to}`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  headers.push(`Subject: ${encWord(subject)}`, "MIME-Version: 1.0");
  let lines;
  if (attachments && attachments.length) {
    const bd = "tadakayo_po_mixed_boundary";
    lines = headers.concat([
      `Content-Type: multipart/mixed; boundary="${bd}"`, "",
      `--${bd}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64", "",
      wrap76(b64(body)),
    ]);
    for (const att of attachments) {
      lines.push(
        `--${bd}`,
        `Content-Type: ${att.mimeType || "application/pdf"}; name="${safeAttachmentName(att.filename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${safeAttachmentName(att.filename)}"`, "",
        wrap76(att.contentBase64),
      );
    }
    lines.push(`--${bd}--`);
  } else {
    lines = headers.concat([
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64", "",
      wrap76(b64(body)),
    ]);
  }
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

exports.sendCaseEmail = onCall(
  { region: "asia-northeast1", timeoutSeconds: 60, serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) {
      throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    }
    const { to, subject, body, caseId } = request.data || {};
    if (!to || !subject || !body) {
      throw new HttpsError("invalid-argument", "宛先・件名・本文は必須です");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpsError("invalid-argument", "宛先メールアドレスの形式が不正です");
    }

    try {
      const sender = (await getSettings()).gmailSender || GMAIL_SENDER;
      const token = await gmailAccessToken(sender);
      const raw = buildRawMessage({ to, subject, body, sender });
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sender)}/messages/send`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw }) }
      );
      if (!res.ok) {
        const t = await res.text();
        console.error("Gmail send failed:", res.status, t);
        throw new HttpsError("internal", `Gmail送信に失敗しました（${res.status}）。DWD登録と送信元アカウントをご確認ください`);
      }
      const sent = await res.json();

      // タイムラインに送信記録
      if (caseId) {
        const now = admin.firestore.FieldValue.serverTimestamp();
        await db.collection("activities").add({
          caseId, type: "gmail_sent", occurredAt: now,
          userId: request.auth.uid, userName: email,
          subject: `メール送信: ${subject}`, body: `宛先: ${to}\n\n${body}`, attachmentUrls: [],
        });
        await db.collection("cases").doc(caseId).update({ updatedAt: now });
      }
      return { ok: true, id: sent.id };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("sendCaseEmail error:", e);
      throw new HttpsError("internal", `送信処理に失敗しました: ${e.message}`);
    }
  }
);

// 発注書PDFを添付してABサークルへ送付（確定して送付）。送信成功で発注を発注済へ更新
exports.sendSupplierOrder = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) {
      throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    }
    const { to, cc, subject, body, pdfBase64, filename, poId } = request.data || {};
    if (!to || !subject || !body) {
      throw new HttpsError("invalid-argument", "宛先・件名・本文は必須です");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpsError("invalid-argument", "宛先メールアドレスの形式が不正です");
    }
    try {
      const sender = (await getSettings()).gmailSender || GMAIL_SENDER;
      const token = await gmailAccessToken(sender);
      const attachments = pdfBase64
        ? [{ filename: filename || "order.pdf", mimeType: "application/pdf", contentBase64: pdfBase64 }]
        : [];
      const raw = buildRawMessage({ to, cc, subject, body, sender, attachments });
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sender)}/messages/send`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw }) }
      );
      if (!res.ok) {
        const t = await res.text();
        console.error("Gmail send (supplier) failed:", res.status, t);
        throw new HttpsError("internal", `Gmail送信に失敗しました（${res.status}）。DWD登録と送信元をご確認ください`);
      }
      const sent = await res.json();
      if (poId) {
        const now = admin.firestore.FieldValue.serverTimestamp();
        await db.collection("purchaseOrders").doc(poId).update({
          status: "sent", emailedTo: to, emailedCc: cc || "", emailedAt: now, confirmedAt: now,
        });
      }
      return { ok: true, id: sent.id };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("sendSupplierOrder error:", e);
      throw new HttpsError("internal", `送信処理に失敗しました: ${e.message}`);
    }
  }
);

// 認定事業者・事業所へのメール送付（未集金の催促など）。送信成功で出荷に送信履歴を記録
exports.sendPartnerMail = onCall(
  { region: "asia-northeast1", timeoutSeconds: 60, serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) {
      throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    }
    const { to, cc, subject, body, shipmentId, kind, pdfBase64, filename, extraAttachments } = request.data || {};
    if (!to || !subject || !body) {
      throw new HttpsError("invalid-argument", "宛先・件名・本文は必須です");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpsError("invalid-argument", "宛先メールアドレスの形式が不正です");
    }
    // 請求書・領収書はPDF添付が本体。添付なしで送ると請求書が届かないので必須にする
    const KINDS = ["invoice", "receipt", "dunning", "guide"];
    if (kind !== undefined && kind !== "" && !KINDS.includes(kind)) {
      throw new HttpsError("invalid-argument", "kind の値が不正です");
    }
    if ((kind === "invoice" || kind === "receipt") && !pdfBase64) {
      throw new HttpsError("invalid-argument", "帳票PDFの生成に失敗しています（添付なしでは送信しません）");
    }
    // 請求書に支援報告書などを同封する（2026-09-12 追加）。帳票本体に続けて添付する
    const extras = Array.isArray(extraAttachments) ? extraAttachments.filter((a) => a && a.contentBase64) : [];
    if (extras.length > 3) {
      throw new HttpsError("invalid-argument", "同封できる書類は3つまでです");
    }
    // base64 は元の約1.37倍。13.4M文字 ≒ 10MB。同封ぶんも足して超えないか見る
    const totalB64 = (pdfBase64 ? pdfBase64.length : 0) + extras.reduce((n, a) => n + String(a.contentBase64).length, 0);
    if (totalB64 > 13_400_000) {
      throw new HttpsError("invalid-argument", "添付の合計が大きすぎます（10MB以下にしてください）");
    }
    try {
      const sender = (await getSettings()).gmailSender || GMAIL_SENDER;
      const token = await gmailAccessToken(sender);
      const attachList = [];
      if (pdfBase64) {
        attachList.push({ filename: safeAttachmentName(filename || "document.pdf"), mimeType: "application/pdf", contentBase64: pdfBase64 });
      }
      for (const a of extras) {
        attachList.push({ filename: safeAttachmentName(a.filename || "attachment.pdf"), mimeType: "application/pdf", contentBase64: a.contentBase64 });
      }
      const attachments = attachList.length ? attachList : undefined;
      const raw = buildRawMessage({ to, cc, subject, body, sender, attachments });
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sender)}/messages/send`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw }) }
      );
      if (!res.ok) {
        const t = await res.text();
        console.error("Gmail send (partner) failed:", res.status, t);
        throw new HttpsError("internal", `Gmail送信に失敗しました（${res.status}）。DWD登録と送信元をご確認ください`);
      }
      const sent = await res.json();
      if (shipmentId) {
        const now = admin.firestore.FieldValue.serverTimestamp();
        const day = todayJst();
        const log = { kind: kind || "mail", to, subject, sentAt: day, sentBy: email };
        const update = {
          mailLog: admin.firestore.FieldValue.arrayUnion(log),
          updatedAt: now,
        };
        if ((kind || "") === "dunning") {
          update.dunningSentAt = day;
          update.dunningCount = admin.firestore.FieldValue.increment(1);
        }
        // 請求先へ帳票を送った日を出荷に残す（一覧で「送付済み」と分かるようにする）
        if ((kind || "") === "invoice") { update.invoiceMailedAt = day; update.invoiceMailedTo = to; }
        if ((kind || "") === "receipt") { update.receiptMailedAt = day; update.receiptMailedTo = to; }
        await db.collection("shipments").doc(shipmentId).update(update);
      }
      return { ok: true, id: sent.id };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("sendPartnerMail error:", e);
      throw new HttpsError("internal", `送信処理に失敗しました: ${e.message}`);
    }
  }
);

// ===== 経理への請求書発行報告（2026-08-11 追加）=====
// 請求書を発行（出荷を「請求済にする」）したとき、経理へ Chat + メールで報告する。
// ⚠️ Google Chat の Incoming Webhook は仕様上ファイルを添付できない
//   （添付アップロード media.upload はユーザーOAuth認証のみ対応・SAもWebhookも不可）ため、
//   PDF本体はメールに添付し、Chat には Storage 上のPDFへのリンクを載せる。
const CRM_BASE_URL = "https://kjk-tadakayo-admin.web.app";
const INVOICE_BUCKET = `${VERTEX_PROJECT}.firebasestorage.app`;

// 請求書PDFを Storage に保存し、恒久ダウンロードURL（Firebaseのdownload token方式）を返す。
// token は推測不可のUUID。漏れた場合は shipments.invoicePdfPath のオブジェクトのメタデータを差し替えれば無効化できる。
async function saveInvoicePdf(shipmentId, filename, pdfBase64) {
  const token = require("crypto").randomUUID();
  const path = `invoices/${shipmentId}/${filename}`;
  const file = admin.storage().bucket(INVOICE_BUCKET).file(path);
  await file.save(Buffer.from(pdfBase64, "base64"), {
    resumable: false,
    metadata: {
      contentType: "application/pdf",
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  const url = `https://firebasestorage.googleapis.com/v0/b/${INVOICE_BUCKET}`
    + `/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { path, url };
}

// 経理スペースへ投稿するカード。cardsV2 は Webhook でも使える（添付だけが不可）
function invoiceChatMessage(d) {
  const rows = [
    ["ti", "請求先", d.billName],
    ["ti", "納品先", d.deliverTo],
    ["ti", "請求金額（税込）", d.amountText],
    ["ti", "支払期限", d.dueDate || "（未設定）"],
    ["ti", "対応出荷", d.soNumber ? `${d.soNumber}${d.shipDate ? `（${d.shipDate}）` : ""}` : ""],
  ].filter((r) => r[2]);
  const buttons = [];
  if (d.pdfUrl) buttons.push({ text: "請求書PDFを開く", onClick: { openLink: { url: d.pdfUrl } } });
  buttons.push({ text: "CRMで開く", onClick: { openLink: { url: `${CRM_BASE_URL}/supply-print.html?type=invoice&id=${d.shipmentId}` } } });
  // メール送信の有無を報告文に明記（「田中さんにもメールを送信しました」）
  const mailNote = d.mailedToName
    ? `${d.mailedToName}さんにもメールを送信しました（請求書PDFを添付）。`
    : "※ 経理担当のメールアドレスが未設定のため、メールは送信していません。";
  const notes = [mailNote];
  if (!d.pdfUrl) notes.push("※ 請求書PDFの保存に失敗したため、リンクは付いていません。");
  return {
    // 通知・一覧で意味が分かるようテキストも併記する
    text: `🧾 請求書を発行しました — ${d.billName}（${d.invNo}／${d.amountText}）`,
    cardsV2: [{
      cardId: `invoice-${d.shipmentId}`,
      card: {
        header: {
          title: "請求書を発行しました",
          subtitle: `${d.invNo}　発行者: ${d.issuedBy}`,
        },
        sections: [
          {
            widgets: rows.map(([, label, value]) => ({
              decoratedText: { topLabel: label, text: String(value) },
            })),
          },
          { widgets: [{ buttonList: { buttons } }] },
          { widgets: notes.map((t) => ({ textParagraph: { text: t } })) },
        ],
      },
    }],
  };
}

async function postChatCard(webhookUrl, message) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Chat投稿に失敗しました（${res.status}）: ${t.slice(0, 200)}`);
  }
}

exports.reportInvoiceToAccounting = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, serviceAccount: SA_MAIL },
  async (request) => {
    await requireStaff(request, { allow: "editor" }); // 登録・有効・ロール（設計 §4）＋練習生（trainee）の拒否（2026-10-20 テストモード）を1か所で
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) {
      throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    }
    const {
      shipmentId, pdfBase64, filename, subject, body,
      invNo, billName, deliverTo, amountText, dueDate, soNumber, shipDate,
    } = request.data || {};
    if (!shipmentId) throw new HttpsError("invalid-argument", "出荷IDは必須です");
    if (!pdfBase64) throw new HttpsError("invalid-argument", "請求書PDFの生成に失敗しています");
    if (!subject || !body) throw new HttpsError("invalid-argument", "件名・本文は必須です");

    const st = await getSettings();
    const webhookUrl = resolveWebhook("accounting", st, ""); // 停止中・空欄なら '' （メールだけ送る）
    const to = (st.accountingEmail || "").trim();
    const cc = (st.accountingEmailCc || "").trim();
    const contactName = (st.accountingContactName || "").trim();
    if (!webhookUrl && !to) {
      throw new HttpsError("failed-precondition",
        "経理への報告先が未設定です。「設定」画面で Chat Webhook URL または経理のメールアドレスを登録してください");
    }
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new HttpsError("invalid-argument", "設定の経理メールアドレスの形式が不正です");
    }

    const pdfName = filename || `${invNo || shipmentId}.pdf`;
    const result = { ok: true, mailed: false, posted: false, pdfUrl: "", warnings: [] };

    // 1) PDFをStorageへ（失敗してもメール添付は成立するので処理は続ける）
    let saved = null;
    try {
      saved = await saveInvoicePdf(shipmentId, pdfName, pdfBase64);
      result.pdfUrl = saved.url;
    } catch (e) {
      console.error("saveInvoicePdf failed:", e);
      result.warnings.push(`請求書PDFの保存に失敗しました（Chatのリンクは省略されます）: ${e.message}`);
    }

    // 2) 経理へPDF添付メール
    if (to) {
      try {
        const sender = st.gmailSender || GMAIL_SENDER;
        const token = await gmailAccessToken(sender);
        const raw = buildRawMessage({
          to, cc, subject, body, sender,
          attachments: [{ filename: pdfName, mimeType: "application/pdf", contentBase64: pdfBase64 }],
        });
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sender)}/messages/send`,
          { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ raw }) }
        );
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`Gmail送信に失敗しました（${res.status}）: ${t.slice(0, 200)}`);
        }
        result.mailed = true;
      } catch (e) {
        console.error("reportInvoiceToAccounting mail failed:", e);
        result.warnings.push(`経理へのメール送信に失敗しました: ${e.message}`);
      }
    }

    // 3) 経理スペースへChat投稿（メールを送れた場合だけ「メールも送りました」と書く）
    if (webhookUrl) {
      try {
        await postChatCard(webhookUrl, invoiceChatMessage({
          shipmentId, invNo: invNo || shipmentId, billName: billName || "（請求先未設定）",
          deliverTo: deliverTo || "", amountText: amountText || "", dueDate: dueDate || "",
          soNumber: soNumber || "", shipDate: shipDate || "",
          issuedBy: email,
          mailedToName: result.mailed ? (contactName || to) : "",
          pdfUrl: result.pdfUrl,
        }));
        result.posted = true;
      } catch (e) {
        console.error("reportInvoiceToAccounting chat failed:", e);
        result.warnings.push(`Chatへの投稿に失敗しました: ${e.message}`);
      }
    }

    if (!result.mailed && !result.posted) {
      throw new HttpsError("internal", `経理への報告がすべて失敗しました。${result.warnings.join(" / ")}`);
    }

    // 4) 出荷に報告履歴を記録（再発行時に「報告済み」と分かるようにする）
    try {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const day = todayJst();
      const update = {
        accountingReportedAt: day,
        accountingReportedBy: email,
        accountingReportCount: admin.firestore.FieldValue.increment(1),
        accountingReportLog: admin.firestore.FieldValue.arrayUnion({
          reportedAt: day, reportedBy: email, mailed: result.mailed, mailedTo: result.mailed ? to : "",
          posted: result.posted, invNo: invNo || "", amountText: amountText || "",
        }),
        updatedAt: now,
      };
      if (saved) { update.invoicePdfUrl = saved.url; update.invoicePdfPath = saved.path; }
      await db.collection("shipments").doc(shipmentId).update(update);
    } catch (e) {
      console.error("reportInvoiceToAccounting record failed:", e);
      result.warnings.push(`報告履歴の記録に失敗しました: ${e.message}`);
    }

    return result;
  }
);

// ===== 出荷指示の投稿（2026-10-19 CRM改修 #4・#4b／2026-10-21 出荷の二段階化） =====
// 「出荷を依頼する」を押した時点（requested になった直後）で、設定の「出荷指示の投稿先」（getWebhook('shipping')）へ投稿する。
// 「発送済にする」では投稿しない（呼び出し側が呼ばない）。受注時点・下書きでは投稿しない。
// 投稿先が空欄・停止中なら投稿せず、依頼の操作自体は止めない（呼び出し側は結果だけ見る）。
// 投稿してよい状態は NOTIFY_STATUSES。⚠️ admin/js/ship-flow.js の NOTIFY_STATUSES と同じ値にしておくこと
// （Functions は CommonJS で ESM の ship-flow.js を require できないため複製している）。
// 依頼を取り消す（requested → draft）ときは画面側が shipNotifiedAt/shipNotifyStatus/shipNotifyLockAt を消すので、再依頼でまた投稿される。
// 二重投稿の防止: shipments.shipNotifiedAt があれば投稿しない（resend:true の再送ボタンだけは再投稿する）。
// 載せるのは出荷に必要な事業所側の情報（宛名・住所・電話・ご担当者名）だけ。出荷データに利用者・被保険者の情報は無い。
// ⚠️ Webhook の URL はログにも戻り値にも出さない。
const LETTERPACK_LABELS = { light: "レターパックライト（青）", plus: "レターパックプラス（赤）" };
const NON_SHIP_SKUS = new Set(["support-fee", "discount"]);
const NOTIFY_STATUSES = ["requested", "shipped", "invoiced", "paid"]; // admin/js/ship-flow.js と同じ値
function shipmentChatMessage(s, shipmentId, o) {
  const items = (Array.isArray(s.items) ? s.items : [])
    .filter((i) => i && !i.nonStock && !NON_SHIP_SKUS.has(String(i.sku || "")) && Number(i.qty) > 0)
    .map((i) => `${i.sku}${i.name && i.name !== i.sku ? `（${i.name}）` : ""} × ${Number(i.qty)}台`);
  const toAddr = [s.postal ? `〒${s.postal}` : "", s.address || ""].filter(Boolean).join(" ");
  // 依頼の時点の shipDate は「希望出荷日」（発送済にしたとき実際の発送日に置き換わる）
  const requested = s.status === "requested";
  const rows = [
    ["出荷番号", s.soNumber || shipmentId],
    ["地域", o.region],
    [requested ? "希望出荷日" : "出荷日", s.shipDate || ""],
    ["出荷元", s.originLocationName || (s.fulfillment === "direct" ? "AB Circleから直送（自社在庫を通さない）" : "")],
    ["レターパックの種類", LETTERPACK_LABELS[s.letterPackType] || "未選択"],
    ["届け先の住所", toAddr],
    ["会社名", s.company || ""],
    ["事業所名", s.officeName || ""],
    ["宛名", s.contactName ? `${s.contactName} 様` : `${s.officeName || ""} ご担当者様`],
    ["電話", s.phone || ""],
    ["品目", items.join("\n")],
    ["希望到着日", s.desiredDeliveryDate || ""],
    ["追跡番号", s.trackingNumber || ""],
    ["追跡番号の写真", Array.isArray(s.trackingPhotos) && s.trackingPhotos.length ? `あり（${s.trackingPhotos.length}枚・CRMで確認）` : ""],
    ["依頼した人", s.requestedBy || (requested ? o.byName : "")],
    // 依頼の段階を通らなかった古い出荷は、今までどおり押した人を「発送済にした人」として出す
    ["発送済にした人", requested ? "" : (s.shippedBy || (s.requestedBy ? "" : o.byName))],
  ].filter((r) => String(r[1] || "").trim());
  const printUrl = `${CRM_BASE_URL}/letterpack-print.html?id=${encodeURIComponent(shipmentId)}`;
  const crmUrl = `${CRM_BASE_URL}/supply.html?tab=shipments&so=${encodeURIComponent(s.soNumber || "")}`;
  const head = o.resend ? "📦 出荷指示（再送）" : "📦 出荷指示";
  // テキストにも全項目を載せる（カードが表示されない端末・通知のプレビュー・検索のため）
  const text = [
    `${head} — ${s.soNumber || shipmentId} ${o.region || ""}${s.officeName || ""}`,
    ...rows.map(([k, v]) => `■ ${k}: ${String(v).replace(/\n/g, " ／ ")}`),
    `🖨 レターパックの宛名印刷: ${printUrl}`,
    `👉 CRMの出荷: ${crmUrl}`,
  ].join("\n");
  return {
    text,
    cardsV2: [{
      cardId: `shipment-${shipmentId}`,
      card: {
        header: { title: o.resend ? "出荷指示（再送）" : "出荷指示", subtitle: `${s.soNumber || shipmentId}　${s.officeName || ""}` },
        sections: [
          { widgets: rows.map(([label, value]) => ({ decoratedText: { topLabel: label, text: String(value).replace(/\n/g, "<br>"), wrapText: true } })) },
          { widgets: [{ buttonList: { buttons: [
            { text: "宛名を印刷（A4）", onClick: { openLink: { url: printUrl } } },
            { text: "CRMで開く", onClick: { openLink: { url: crmUrl } } },
          ] } }] },
        ],
      },
    }],
  };
}

exports.notifyShipment = onCall(
  { region: "asia-northeast1", timeoutSeconds: 60, serviceAccount: SA_BATCH },
  async (request) => {
    await rejectTrainee(request); // 練習生は本番の Functions を使えない（2026-10-20 テストモード）
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) {
      throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    }
    // 発送済にできる人（firestore.rules の isEditor 相当＝登録済み・有効・閲覧のみでない）だけが投稿できる
    const u = await db.collection("users").doc(email).get();
    const ud = u.exists ? u.data() : null;
    if (!ud || ud.active !== true || ud.role === "viewer") {
      throw new HttpsError("permission-denied", "出荷指示を投稿する権限がありません");
    }
    const { shipmentId, resend } = request.data || {};
    if (!shipmentId || typeof shipmentId !== "string") throw new HttpsError("invalid-argument", "出荷IDは必須です");
    const ref = db.collection("shipments").doc(shipmentId);
    const byName = request.auth?.token?.name || email;
    const now = admin.firestore.FieldValue.serverTimestamp();

    // 二重投稿の防止（同時に2回押されたときも1回にするため、トランザクションで「投稿中」の印を付ける）
    let s;
    const lockTs = admin.firestore.Timestamp.now(); // この送信が付けたロック（古い送信の後始末で、自分のロックだけ外すため）
    const gate = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { stop: "not-found" };
      const d = snap.data();
      if (!NOTIFY_STATUSES.includes(d.status)) return { stop: "not-shipped" };
      if (d.shipNotifiedAt && !resend) return { stop: "already" };
      const lockAt = d.shipNotifyLockAt && d.shipNotifyLockAt.toMillis ? d.shipNotifyLockAt.toMillis() : 0;
      if (lockAt && Date.now() - lockAt < 60000) return { stop: "busy" };
      tx.update(ref, { shipNotifyLockAt: lockTs });
      s = d;
      return { seq: Flow.requestSeqOf(d) }; // この依頼の番号を控える（取り消し→再依頼の後に古い送信が結果を書き戻さないように）
    });
    if (gate.stop === "not-found") throw new HttpsError("not-found", "出荷が見つかりません");
    if (gate.stop === "not-shipped") throw new HttpsError("failed-precondition", "出荷を依頼していない出荷（下書き・キャンセル）は投稿できません");
    if (gate.stop === "already") return { posted: false, reason: "already" };
    if (gate.stop === "busy") return { posted: false, reason: "busy" };

    // 投稿の結果を出荷に書く。まだ依頼済以上で requestSeq が同じときだけ（Codex 指摘4）。書かなかったら false
    const writeResult = async (patch) => db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const cur = snap.data();
      if (!Flow.notifyResultWritable(cur, gate.seq, NOTIFY_STATUSES)) {
        // 古い送信: 結果は書かない。ただし自分が付けたロックが残っていれば外す（残すと再依頼の投稿が60秒「投稿中」で止まる）
        if (Flow.ownsNotifyLock(cur, lockTs)) tx.update(ref, { shipNotifyLockAt: null });
        return false;
      }
      tx.update(ref, patch);
      return true;
    });
    const STALE_NOTE = "送信の途中で依頼が取り消された（または依頼し直された）ため、取り消し後の古い送信として出荷には記録しません。";
    // 活動記録（案件にひも付いている出荷だけ。案件が無い出荷は出荷側の記録だけ残る）
    const logActivity = async (subject, body) => {
      if (!s.caseId) return;
      try {
        await db.collection("activities").add({
          caseId: s.caseId, type: "memo", occurredAt: now, userId: request.auth.uid, userName: email,
          subject, body, attachmentUrls: [],
        });
      } catch (e) { console.warn("notifyShipment activity failed:", e.message); }
    };

    _settingsCache = null; // 設定画面で直した直後でも最新の投稿先を使う
    const st = await getSettings();
    const url = await getWebhook("shipping");
    if (!url) {
      const reason = st.shippingChatWebhookEnabled === false ? "disabled" : "unset";
      const why = reason === "disabled" ? "停止中" : "未設定";
      if (!(await writeResult({ shipNotifyStatus: reason, shipNotifyAttemptAt: now, shipNotifyLockAt: null }))) {
        await logActivity(`出荷指示: 取り消し後の古い送信のため記録しない（${s.soNumber || ""}）`, STALE_NOTE);
        return { posted: false, reason: "stale" };
      }
      await logActivity(`出荷指示: 未投稿（${s.soNumber || ""}）`,
        `出荷指示の投稿先が${why}のため、投稿していません。設定で投稿先を有効にしてから、出荷の画面の「再送」で投稿できます。`);
      return { posted: false, reason };
    }

    try {
      const officeRegion = s.officeId ? await officeRegionLabel({ officeId: s.officeId }) : "";
      const region = officeRegion && officeRegion !== "（地域不明）"
        ? officeRegion
        : (() => { const r = regionFromAddress(s.address); return r.prefecture ? formatRegion(r.prefecture, r.city) : ""; })();
      await postChatCard(url, shipmentChatMessage(s, shipmentId, { region, byName, resend: !!resend }));
    } catch (e) {
      // Chat の応答本文に URL は含まれないが、念のためメッセージは先頭だけ・URL らしき文字列は伏せて残す
      const msg = String(e.message || e).replace(/https?:\/\/\S+/g, "(URL)").slice(0, 200);
      console.error("notifyShipment chat failed:", msg);
      if (!(await writeResult({ shipNotifyStatus: "error", shipNotifyError: msg, shipNotifyAttemptAt: now, shipNotifyLockAt: null }))) {
        await logActivity(`出荷指示: 取り消し後の古い送信のため記録しない（${s.soNumber || ""}）`, STALE_NOTE);
        return { posted: false, reason: "stale" };
      }
      await logActivity(`出荷指示: 投稿に失敗（${s.soNumber || ""}）`,
        `出荷指示の投稿に失敗しました（${msg}）。出荷の画面の「再送」でやり直せます。出荷の記録（依頼済・発送済）はそのままです。`);
      return { posted: false, reason: "error" };
    }

    const wrote = await writeResult({
      shipNotifiedAt: now, shipNotifiedBy: byName, shipNotifiedByEmail: email,
      shipNotifyStatus: "posted", shipNotifyError: admin.firestore.FieldValue.delete(),
      shipNotifyAttemptAt: now, shipNotifyLockAt: null,
      shipNotifyCount: admin.firestore.FieldValue.increment(1),
    });
    if (!wrote) {
      await logActivity(`出荷指示: 取り消し後の古い送信のため記録しない（${s.soNumber || ""}）`,
        `出荷 ${s.soNumber || ""} の出荷指示は投稿しましたが、${STALE_NOTE}センターへ取り消しの連絡をしてください。`);
      return { posted: true, stale: true, resent: !!resend };
    }
    await logActivity(`出荷指示: 投稿しました${resend ? "（再送）" : ""}（${s.soNumber || ""}）`,
      `出荷指示の投稿先へ、出荷 ${s.soNumber || ""} の指示を投稿しました（投稿者: ${byName}）。`);
    return { posted: true, resent: !!resend };
  }
);

// ===== LP アクセス解析（GA4 + Search Console 日次収集） =====
// 実装は ./analytics.js（このファイルを肥大化させないため分離）
const analytics = require("./analytics");
exports.collectAnalytics = analytics.collectAnalytics;
exports.collectAnalyticsNow = analytics.collectAnalyticsNow;

// ===== 学習用テストモード：練習DB（practice）の初期化（2026-10-20）=====
// 実装は ./practice.js。練習DBにだけ書く（本番DBは読み取りのみ）。
const practice = require("./practice");
exports.resetPractice = practice.resetPractice;
exports.nightlyPracticeReset = practice.nightlyPracticeReset;
