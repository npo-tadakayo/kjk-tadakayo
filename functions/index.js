const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const { GoogleAuth } = require("google-auth-library");
const Pricing = require("./estimate-pricing"); // 見積もりの価格ロジック（公開ページと同じ計算）

admin.initializeApp();
const db = admin.firestore();

const CHAT_WEBHOOK_URL = defineSecret("CHAT_WEBHOOK_URL");

// H-3 関数別の専用SA（最小権限・SECURITY_REMEDIATION H-3）。compute SA(editor)依存を解消。
const SA_WEBHOOK = "fn-webhook-sa@kjk-tadakayo.iam.gserviceaccount.com"; // datastore.user + CHAT secretAccessor
const SA_BATCH   = "fn-batch-sa@kjk-tadakayo.iam.gserviceaccount.com";   // datastore.user + CHAT secretAccessor
const SA_AI      = "fn-ai-sa@kjk-tadakayo.iam.gserviceaccount.com";      // aiplatform.user のみ
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
async function getChatWebhook() {
  const s = await getSettings();
  return (s && s.chatWebhookUrl) || CHAT_WEBHOOK_URL.value() || "";
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
          body: body.message || "", attachmentUrls: [],
        });
        await db.collection("cases").doc(existing.id).update({ updatedAt: now, message: body.message || existing.message || "" });
        const chatWebhook = await getChatWebhook();
        await notifyChat(
          chatWebhook,
          `📥 LP問い合わせ（既存の案件 #${existing.caseNumber} に追記）\n事業所: ${officeName}\n担当者: ${body.name || ""}\nメッセージ: ${body.message || ""}`
        );
        res.status(200).json({ status: "ok", caseId: existing.id, caseNumber: existing.caseNumber, token, existing: true });
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
        body: body.message || "",
        attachmentUrls: [],
      });

      const chatWebhook = await getChatWebhook();
      await notifyChat(
        chatWebhook,
        `📥 新規LP問い合わせ [案件 #${caseNumber}]\n事業所: ${officeData.officeName}\n担当者: ${body.name || ""}\nTEL: ${body.phone || ""}\nメール: ${body.email || ""}\nメッセージ: ${body.message || ""}`
      );

      // 送信完了画面の「今すぐ見積もりを作る」用の継続トークン
      const token = await issueLeadToken(caseRef.id, officeRef.id, prefill);
      res.status(200).json({ status: "ok", caseId: caseRef.id, caseNumber, token });
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
      const now = admin.firestore.FieldValue.serverTimestamp();
      const officeName = body.officeName || "";
      const email = body.email || "";

      // ---- 金額をサーバで再計算 ----
      const planKey = ["houmon", "kyojyu", "other"].includes(body.subsidyCategory) ? body.subsidyCategory : null;
      if (!planKey) { res.status(400).json({ status: "error", message: "プランの指定が不正です" }); return; }
      const btQty = Number(body.btSubsidyQty) || 0, usbQty = Number(body.usbSubsidyQty) || 0;
      const btExtra = Number(body.btExtraQty) || 0, usbExtra = Number(body.usbExtraQty) || 0;
      const usbConnector = ["A", "C"].includes(body.usbConnector) ? body.usbConnector : null;
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
      lead = await readLeadToken(body.token);
      if (lead) { caseId = lead.caseId; officeId = lead.officeId || null; }
      if (!caseId) {
        const existing = await findActiveCase(email, officeName);
        if (existing) { caseId = existing.id; officeId = existing.officeId || null; caseNumber = existing.caseNumber; }
      }
      if (caseId && caseNumber == null) {
        const cd = await db.collection("cases").doc(caseId).get();
        if (cd.exists) caseNumber = cd.data().caseNumber; else caseId = null;
      }

      const prefecture = body.prefecture || "", city = body.city || "", addressDetail = body.addressDetail || "";
      if (!caseId) {
        created = true;
        caseNumber = await getNextCaseNumber();
        const officeData = {
          corpName: body.corpName || "", officeName,
          postalCode: body.postalCode || "", prefecture, city, addressDetail,
          address: [prefecture, city, addressDetail].filter(Boolean).join(""),
          phone: body.phone || "", website: body.website || "",
          createdAt: now, updatedAt: now,
        };
        const officeRef = await db.collection("offices").add(officeData);
        officeId = officeRef.id;
        const caseRef = await db.collection("cases").add({
          caseNumber, officeId, officeName, corpName: officeData.corpName,
          contactName: body.contactName || "", contactEmail: email, contactPhone: body.phone || "",
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
        res.status(200).json({ status: "duplicate", caseId, caseNumber, quoteId: latest.id, estNo: latest.estNo,
          version: latest.version, quoteToken: latest.accessToken, validUntil: latest.validUntil?.toDate?.().toISOString?.() || null });
        return;
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
      batch.set(quoteRef, {
        caseId, officeId, caseNumber, estNo, version, plan: planKey, planLabel: calc.plan.label,
        items, amounts, status: "issued", supersedes: latest ? latest.id : null,
        validUntil, createdVia: "web", createdAt: now,
        contactEmail: email, contactName: body.contactName || "", officeName, corpName: body.corpName || "",
        accessToken, pdfPath: null, pdfUrl: null, mailedAt: null, mailedTo: null,
        leadToken: lead ? lead.id : null,
      });
      const caseUpdate = {
        latestQuoteId: quoteRef.id, quoteIssuedAt: now, updatedAt: now,
        subsidyPlan: calc.plan.label, cardReaders, subsidyCategory: planKey,
        expectedSubsidyAmount: calc.grantAmt, totalAmount: calc.totalIncl,
        specialDiscount: calc.discount, selfPay: calc.selfPay,
      };
      if (!created) {
        const cd = await db.collection("cases").doc(caseId).get();
        if (cd.exists && cd.data().status === STATUS.NEW) caseUpdate.status = STATUS.CONFIRMING;
        // 事業所の住所が空なら見積もりフォームの入力で埋める
        if (officeId && prefecture) {
          const od = await db.collection("offices").doc(officeId).get();
          if (od.exists && !od.data().prefecture) {
            batch.update(db.collection("offices").doc(officeId), {
              postalCode: body.postalCode || "", prefecture, city, addressDetail,
              address: [prefecture, city, addressDetail].filter(Boolean).join(""), updatedAt: now,
            });
          }
        }
      }
      batch.update(db.collection("cases").doc(caseId), caseUpdate);
      batch.set(db.collection("activities").doc(), {
        caseId, type: "memo", occurredAt: now, userId: "system",
        subject: `見積もりを作成（${estNo}・v${version}）`,
        body: `プラン: ${calc.plan.label}\n構成: ${cardReaders.map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`).join(", ")}${usbConnector ? `（USB ${usbConnector === "C" ? "Type-C" : "Type-A"}）` : ""}\n合計（税込）: ¥${calc.totalIncl.toLocaleString()}／自己負担: ¥${calc.selfPay.toLocaleString()}`,
        attachmentUrls: [],
      });
      if (lead) batch.update(db.collection("leadTokens").doc(lead.id), { usedFor: admin.firestore.FieldValue.arrayUnion("quote") });
      await batch.commit();

      const crSummary = cardReaders.map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`).join(", ");
      const chatWebhook = await getChatWebhook();
      await notifyChat(
        chatWebhook,
        `📝 見積もり作成 ${estNo}（v${version}） [案件 #${caseNumber}${created ? "・新規" : ""}]\n事業所: ${officeName} (${body.corpName || ""})\n担当者: ${body.contactName || ""}\nメール: ${email}\nプラン: ${calc.plan.label}\n構成: ${crSummary}\n金額: ¥${calc.totalIncl.toLocaleString()}（自己負担 ¥${calc.selfPay.toLocaleString()}）`
      );

      res.status(200).json({ status: "ok", caseId, caseNumber, quoteId: quoteRef.id, estNo, version,
        quoteToken: accessToken, validUntil: validUntil.toDate().toISOString() });
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
async function saveQuotePdf(caseId, filename, pdfBase64) {
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
  const yen = (n) => `¥${Number(n || 0).toLocaleString()}`;
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
      `このあと担当スタッフから2営業日以内にご連絡します。ご不明な点はこのメールへの返信でお知らせください。\n\n` +
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
      const { quoteId, quoteToken, pdfBase64 } = req.body || {};
      if (!quoteId || !quoteToken || !pdfBase64) { res.status(400).json({ status: "error", message: "quoteId・quoteToken・pdfBase64 は必須です" }); return; }
      if (typeof pdfBase64 !== "string" || pdfBase64.length > 13_400_000) { res.status(400).json({ status: "error", message: "PDFが大きすぎます（10MB以下）" }); return; }
      const ref = db.collection("quotes").doc(String(quoteId));
      const snap = await ref.get();
      if (!snap.exists) { res.status(404).json({ status: "error", message: "見積もりが見つかりません" }); return; }
      const q = { id: snap.id, ...snap.data() };
      if (!q.accessToken || q.accessToken !== quoteToken) { res.status(403).json({ status: "error", message: "この見積もりを操作する権限がありません" }); return; }
      if (q.mailedAt) { res.status(200).json({ status: "already", pdfUrl: q.pdfUrl || null }); return; }

      const filename = `${q.estNo}-v${q.version}.pdf`;
      const saved = await saveQuotePdf(q.caseId, filename, pdfBase64);
      const to = q.contactEmail || "";
      let mailed = false, mailError = null;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
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
      await ref.update({
        pdfPath: saved.path, pdfUrl: saved.url,
        mailedAt: mailed ? admin.firestore.FieldValue.serverTimestamp() : null,
        mailedTo: mailed ? to : null, mailError: mailError || null,
      });
      res.status(200).json({ status: "ok", mailed, pdfUrl: saved.url });
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
// 出荷の下書きに入れる明細は、見積書と同じ構成（カードリーダー＋伴走支援費＋特別割引）にする。
// そうしないと、そのまま発行した請求書の金額が見積書と合わない。
// 伴走支援費・特別割引は在庫のある品物ではないので nonStock: true を付け、在庫処理から外す。
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
    items.push({ sku: "support-fee", name: `伴走支援費（1年間・補助対象${n}台）`, qty: 1, unitPrice: fee, nonStock: true });
  }
  const discount = Number(q.amounts?.discount) || 0;
  if (discount > 0) {
    items.push({ sku: "discount", name: "特別割引（出精値引き）", qty: 1, unitPrice: -discount, nonStock: true });
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

exports.acceptQuote = onRequest(
  { region: "asia-northeast1", cors: true, timeoutSeconds: 120, secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_MAIL },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }
    if (await appCheckGate(req, res, "acceptQuote")) return;
    try {
      const { quoteId, quoteToken, delivery, payMethod, preferredDate, note, agreedName } = req.body || {};
      if (!quoteId || !quoteToken) { res.status(400).json({ status: "error", message: "quoteId・quoteToken は必須です" }); return; }
      if (!agreedName || !String(agreedName).trim()) { res.status(400).json({ status: "error", message: "お申し込み者のお名前をご入力ください" }); return; }
      const payKey = payMethod === "before" ? "before" : "after";

      const qRef = db.collection("quotes").doc(String(quoteId));
      const now = admin.firestore.FieldValue.serverTimestamp();
      const d = delivery || {};

      // 状態の確認と書き込みをトランザクションでまとめる。
      // 二重送信（ボタン連打・回線の再送）で出荷の下書きが2つできるのを防ぐ。
      let q = null, soNumber = null, alreadyAccepted = false, shipRefId = null;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(qRef);
        if (!snap.exists) throw new HttpsError("not-found", "見積もりが見つかりません");
        q = { id: snap.id, ...snap.data() };
        if (q.accessToken !== quoteToken) throw new HttpsError("permission-denied", "この見積もりを操作する権限がありません");
        if (q.status === "accepted") { alreadyAccepted = true; return; }
        if (q.status !== "issued") throw new HttpsError("failed-precondition", "この見積もりは現在お申し込みいただけません（新しい見積もりが発行されている可能性があります）");
        if (q.validUntil && q.validUntil.toMillis() < Date.now()) throw new HttpsError("failed-precondition", "この見積もりは有効期限が切れています。お手数ですが、もう一度お見積もりをお作りください");

        // 採番はトランザクションの中で行う（採番だけ進んで書き込みが失敗する事故を避ける）
        const cRef = db.collection("_counters").doc("shipments");
        const cSnap = await tx.get(cRef);
        const n = (cSnap.exists ? cSnap.data().value : 0) + 1;
        tx.set(cRef, { value: n });
        soNumber = `SH-2026-${String(n).padStart(4, "0")}`;

        const items = shipmentItemsFromQuote(q);
        const shipRef = db.collection("shipments").doc();
        shipRefId = shipRef.id;
        tx.set(shipRef, {
        soNumber, status: "draft", shipType: "direct", partnerEmail: "", partnerName: "",
        caseId: q.caseId, caseNumber: q.caseNumber || null, quoteId: q.id, estNo: q.estNo || "",
        company: d.company || q.corpName || "", officeName: d.officeName || q.officeName || "",
        postal: d.postalCode || "", address: d.address || "",
        contactName: d.contactName || q.contactName || "", phone: d.phone || "",
        items, shippingMethod: "manual", shippingFee: 0, shippingLabel: "",
        shipDate: todayJst(), preferredDate: preferredDate || "", payMethod: payKey,
        orderNote: String(note || "").slice(0, 1000),
        createdAt: now, createdBy: "web（事業所のお申し込み）",
      });
      tx.update(qRef, {
        status: "accepted", acceptedAt: now, shipmentId: shipRef.id, shipmentNo: soNumber,
        acceptedBy: String(agreedName).trim().slice(0, 100), payMethod: payKey,
        delivery: { company: d.company || "", officeName: d.officeName || "", postalCode: d.postalCode || "",
          address: d.address || "", contactName: d.contactName || "", phone: d.phone || "" },
      });
      tx.update(db.collection("cases").doc(q.caseId), {
        status: STATUS.ORDERED, orderedAt: now, orderedVia: "web", updatedAt: now,
        shipmentId: shipRef.id, payMethod: payKey,
      });
      tx.set(db.collection("activities").doc(), {
        caseId: q.caseId, type: "memo", occurredAt: now, userId: "system",
        subject: `お申し込みを受け付けました（${q.estNo}・出荷 ${soNumber} の下書きを作成）`,
        body: `お申し込み者: ${String(agreedName).trim()}\n支払方法: ${PAY_LABELS[payKey]}\n`
          + `届け先: ${[d.postalCode ? "〒" + d.postalCode : "", d.company, d.officeName, d.address].filter(Boolean).join(" ")}\n`
          + (preferredDate ? `ご希望日: ${preferredDate}\n` : "")
          + (note ? `ご要望: ${note}\n` : ""),
        attachmentUrls: [],
      });
      });

      if (alreadyAccepted) {
        res.status(200).json({ status: "already", soNumber: q.shipmentNo || "", caseNumber: q.caseNumber });
        return;
      }

      // 事業所へ確認メール
      const yen = (n) => `¥${Number(n || 0).toLocaleString()}`;
      const to = q.contactEmail || "";
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        try {
          await sendGmail({
            to, cc: GMAIL_SENDER,
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
          });
        } catch (e) { console.error("acceptQuote mail error:", e); }
      }

      const chatWebhook = await getChatWebhook();
      await notifyChat(
        chatWebhook,
        `🎉 お申し込みを受け付けました [案件 #${q.caseNumber}]\n見積: ${q.estNo}（v${q.version}）\n事業所: ${q.officeName}（${q.corpName || ""}）\n`
        + `金額: ${yen(q.amounts?.totalIncl)}（自己負担 ${yen(q.amounts?.selfPay)}）\nお支払い: ${PAY_LABELS[payKey]}\n`
        + `出荷 ${soNumber} の下書きを作りました。供給管理から「在庫から発送」か「AB Circle へ発注」を選んでください。`
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

// ===== 見積もりの改版（2026-09-06・Phase 2）=====
// 「見積もりを取ったあと、支援の調整で台数・タイプ・機種を変えたい」に応えるための関数。
// 前の版は superseded にして残し、新しい版を作る（何をいつ変えたかが追える）。
// 出荷が下書きのうちは、その明細も新しい版に合わせて作り直す。
// 出荷を確定したあとは触らない（請求済・入金済の金額が動くと事故になるため）。既存の「出荷の修正」で直す。
exports.reviseQuote = onCall(
  { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB", serviceAccount: SA_MAIL },
  async (request) => {
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
      validUntil: base.validUntil || daysFromNow(30),
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
        updatedAt: now, updatedBy: email,
      });
    }
    const before = (base.items || []).map((i) => `${i.sku}×${(Number(i.subsidyQty) || 0) + (Number(i.extraQty) || 0)}`).join("・");
    const after = items.map((i) => `${i.sku}×${(Number(i.subsidyQty) || 0) + (Number(i.extraQty) || 0)}`).join("・");
    batch.set(db.collection("activities").doc(), {
      caseId: base.caseId, type: "memo", occurredAt: now, userId: request.auth.uid, userName: email,
      subject: `見積もりを変更（${estNo} v${base.version} → v${version}）`,
      body: `理由: ${String(reason).trim()}\n変更前: ${before}（¥${Number(base.amounts?.totalIncl || 0).toLocaleString()}）\n`
        + `変更後: ${after}（¥${calc.totalIncl.toLocaleString()}）`
        + (shipmentId && shipStatus === "draft" ? `\n出荷 ${base.shipmentNo || ""} の下書きも新しい内容に更新しました。` : ""),
      attachmentUrls: [],
    });
    await batch.commit();

    // 事業所へ変更後の見積もりを知らせる（PDFはこの時点では無いので、金額と変更点をメールで伝える）
    let mailed = false;
    const to = base.contactEmail || "";
    if (sendMail !== false && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      const yen = (n) => `¥${Number(n || 0).toLocaleString()}`;
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

exports.testChatNotify = onCall({ region: "asia-northeast1", secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_BATCH }, async (request) => {
  const email = request.auth?.token?.email || "";
  if (!email.endsWith("@tadakayo.jp")) throw new HttpsError("permission-denied", "権限がありません");
  const url = await getChatWebhook();
  if (!url) throw new HttpsError("failed-precondition", "Chat Webhook URLが未設定です");
  _settingsCache = null; // 最新設定で送る
  await notifyChat(await getChatWebhook(), `✅ タダカヨCRM 設定テスト通知（送信者: ${email}）`);
  return { ok: true };
});

// ===== Phase 6: アフターフォロー自動化（日次・Chat通知）=====
const STATUS_LABELS_FN = {
  1: "新規受信", 2: "確認中", 3: "受注確定", 4: "失注", 5: "担当者決定",
  6: "事前準備中", 7: "伴走支援待ち", 8: "伴走支援実施済", 9: "書類準備完了・申請ガイド中",
  10: "申請完了・採択待ち", 11: "採択・入金待ち", 12: "アフターフォロー中", 13: "案件完了",
};
const FU_TERMINAL = [4, 13];
const FU_PRE_APPLY = [1, 2, 3, 5, 6, 7, 8, 9];
const FU_DEADLINE = new Date("2027-03-12T23:59:59+09:00");

function daysAgo(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

async function buildFollowupDigest() {
  const snap = await db.collection("cases").get();
  const cases = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const deadlineDays = Math.ceil((FU_DEADLINE - new Date()) / 86400000);

  const unassigned = cases.filter((c) => c.status === 1 && !c.assignedUserId);
  const stale = cases.filter((c) => !FU_TERMINAL.includes(c.status) && (daysAgo(c.updatedAt) ?? 0) >= 7);
  const deadlineNear = deadlineDays <= 30 ? cases.filter((c) => FU_PRE_APPLY.includes(c.status)) : [];
  const awaitingDeposit = cases.filter((c) => c.status === 11 && (daysAgo(c.updatedAt) ?? 0) >= 14);

  if (!unassigned.length && !stale.length && !deadlineNear.length && !awaitingDeposit.length) {
    return null; // 通知不要
  }
  const line = (c) => `・#${c.caseNumber || "?"} ${c.officeName || "(名称未登録)"}（${STATUS_LABELS_FN[c.status] || "?"}）`;
  const sec = (title, arr) => arr.length
    ? `\n*${title}（${arr.length}件）*\n${arr.slice(0, 10).map(line).join("\n")}${arr.length > 10 ? `\n…ほか${arr.length - 10}件` : ""}` : "";

  return [
    `🗓 *タダカヨCRM 日次フォローアップ*（申請期限まで残り ${deadlineDays} 日）`,
    sec("⏳ 未割当の新規案件", unassigned),
    sec("⚠️ 停滞案件（7日以上未更新）", stale),
    sec("📋 未申請（期限対応が必要）", deadlineNear),
    sec("💰 入金待ちが14日以上", awaitingDeposit),
    "\n👉 管理画面: https://kjk-tadakayo-admin.web.app/kanban",
  ].filter(Boolean).join("\n");
}

exports.dailyFollowup = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Tokyo", region: "asia-northeast1", secrets: [CHAT_WEBHOOK_URL], serviceAccount: SA_BATCH },
  async () => {
    try {
      const msg = await buildFollowupDigest();
      if (msg) await notifyChat(await getChatWebhook(), msg);
      console.log("dailyFollowup done:", msg ? "通知あり" : "通知不要");
    } catch (e) {
      console.error("dailyFollowup error:", e);
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
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) {
      throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    }
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
    const email = request.auth?.token?.email || "";
    if (!email.endsWith("@tadakayo.jp")) {
      throw new HttpsError("permission-denied", "このアプリの利用権限がありません");
    }
    const { to, cc, subject, body, shipmentId, kind, pdfBase64, filename } = request.data || {};
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
    // base64 は元の約1.37倍。13.4M文字 ≒ 10MB
    if (pdfBase64 && pdfBase64.length > 13_400_000) {
      throw new HttpsError("invalid-argument", "PDFが大きすぎます（10MB以下にしてください）");
    }
    try {
      const sender = (await getSettings()).gmailSender || GMAIL_SENDER;
      const token = await gmailAccessToken(sender);
      const attachments = pdfBase64
        ? [{ filename: safeAttachmentName(filename || "document.pdf"), mimeType: "application/pdf", contentBase64: pdfBase64 }]
        : undefined;
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
    const webhookUrl = st.accountingChatWebhookUrl || "";
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

// ===== LP アクセス解析（GA4 + Search Console 日次収集） =====
// 実装は ./analytics.js（このファイルを肥大化させないため分離）
const analytics = require("./analytics");
exports.collectAnalytics = analytics.collectAnalytics;
exports.collectAnalyticsNow = analytics.collectAnalyticsNow;
