const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");

admin.initializeApp();
const db = admin.firestore();

const CHAT_WEBHOOK_URL = defineString("CHAT_WEBHOOK_URL");

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

      const chatWebhook = CHAT_WEBHOOK_URL.value();
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

      const chatWebhook = CHAT_WEBHOOK_URL.value();
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
