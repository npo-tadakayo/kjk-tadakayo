const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const CHAT_WEBHOOK_URL = defineString("CHAT_WEBHOOK_URL");

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
