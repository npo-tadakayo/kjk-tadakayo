const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const { GoogleAuth } = require("google-auth-library");

admin.initializeApp();
const db = admin.firestore();

const CHAT_WEBHOOK_URL = defineString("CHAT_WEBHOOK_URL");

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
const VERTEX_LOCATION = process.env.VERTEX_AI_LOCATION || "global";
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

// LP 問い合わせ Webhook（index.html のお問い合わせフォームから）
exports.webhookLpInquiry = onRequest(
  { region: "asia-northeast1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      const body = req.body;
      const now = admin.firestore.FieldValue.serverTimestamp();

      // 重複チェック（同じメール+時刻5分以内）
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
        if (Date.now() - lastTime.getTime() < 5 * 60 * 1000) {
          res.status(200).json({ status: "duplicate" });
          return;
        }
      }

      const caseNumber = await getNextCaseNumber();

      const officeData = {
        corpName: body.corpName || "",
        officeName: body.officeName || body.name || "",
        phone: body.phone || "",
        website: body.website || "",
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

      res.status(200).json({ status: "ok", caseId: caseRef.id, caseNumber });
    } catch (e) {
      console.error("webhookLpInquiry error:", e);
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);

// 見積もりツール 成約 Webhook（mitsumori.html から）
exports.webhookMitsumori = onRequest(
  { region: "asia-northeast1", cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      const body = req.body;
      const now = admin.firestore.FieldValue.serverTimestamp();

      // 重複チェック（同じメール+5分以内）
      const recentSnap = await db
        .collection("cases")
        .where("contactEmail", "==", body.email || "")
        .where("source", "==", "mitsumori_quote")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get();

      if (!recentSnap.empty) {
        const lastCase = recentSnap.docs[0].data();
        const lastTime = lastCase.receivedAt?.toDate?.() || new Date(0);
        if (Date.now() - lastTime.getTime() < 5 * 60 * 1000) {
          res.status(200).json({ status: "duplicate" });
          return;
        }
      }

      const caseNumber = await getNextCaseNumber();

      const officeData = {
        corpName: body.corpName || "",
        officeName: body.officeName || "",
        address: body.address || "",
        phone: body.phone || "",
        website: body.website || "",
        createdAt: now,
        updatedAt: now,
      };

      const officeRef = await db.collection("offices").add(officeData);

      // カードリーダー構成
      const cardReaders = [];
      if (body.btSubsidyQty > 0 || body.btExtraQty > 0) {
        cardReaders.push({ type: "BT", subsidyQty: Number(body.btSubsidyQty) || 0, extraQty: Number(body.btExtraQty) || 0 });
      }
      if (body.usbSubsidyQty > 0 || body.usbExtraQty > 0) {
        cardReaders.push({ type: "USB", subsidyQty: Number(body.usbSubsidyQty) || 0, extraQty: Number(body.usbExtraQty) || 0 });
      }

      const caseData = {
        caseNumber,
        officeId: officeRef.id,
        officeName: officeData.officeName,
        corpName: officeData.corpName,
        contactName: body.contactName || "",
        contactEmail: body.email || "",
        contactPhone: body.phone || "",
        source: "mitsumori_quote",
        status: STATUS.NEW,
        assignedUserId: null,
        receivedAt: now,
        updatedAt: now,
        subsidyPlan: body.subsidyPlan || "",
        cardReaders,
        subsidyCategory: body.subsidyCategory || null,
        expectedSubsidyAmount: Number(body.subsidyAmount) || null,
        totalAmount: Number(body.totalAmount) || null,
        specialDiscount: Number(body.specialDiscount) || null,
        selfPay: Number(body.selfPay) || null,
        lostReason: null,
        orderedAt: null,
        completedAt: null,
      };

      const caseRef = await db.collection("cases").add(caseData);

      await db.collection("activities").add({
        caseId: caseRef.id,
        type: "memo",
        occurredAt: now,
        userId: "system",
        subject: "見積もりツールから成約",
        body: `補助金プラン: ${body.subsidyPlan || ""}\nカードリーダー構成: ${JSON.stringify(cardReaders)}\n合計金額: ¥${(body.totalAmount || 0).toLocaleString()}`,
        attachmentUrls: [],
      });

      const crSummary = cardReaders
        .map((cr) => `${cr.type}×${cr.subsidyQty + cr.extraQty}台`)
        .join(", ");

      const chatWebhook = await getChatWebhook();
      await notifyChat(
        chatWebhook,
        `🎉 見積もり成約！ [案件 #${caseNumber}]\n事業所: ${officeData.officeName} (${officeData.corpName})\n担当者: ${body.contactName || ""}\nTEL: ${body.phone || ""}\nメール: ${body.email || ""}\nプラン: ${body.subsidyPlan || ""}\n構成: ${crSummary}\n金額: ¥${Number(body.totalAmount || 0).toLocaleString()}`
      );

      res.status(200).json({ status: "ok", caseId: caseRef.id, caseNumber });
    } catch (e) {
      console.error("webhookMitsumori error:", e);
      res.status(500).json({ status: "error", message: e.message });
    }
  }
);

// 設定画面からのChatテスト通知
exports.testChatNotify = onCall({ region: "asia-northeast1" }, async (request) => {
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
  { schedule: "0 9 * * *", timeZone: "Asia/Tokyo", region: "asia-northeast1" },
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
  { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB" },
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

function buildRawMessage({ to, subject, body, sender }) {
  const mime = [
    `From: ${encWord("タダカヨ事務局")} <${sender}>`,
    `To: ${to}`,
    `Subject: ${encWord(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(body),
  ].join("\r\n");
  return Buffer.from(mime, "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

exports.sendCaseEmail = onCall(
  { region: "asia-northeast1", timeoutSeconds: 60 },
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
