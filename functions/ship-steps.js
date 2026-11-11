// カードリーダーの発送の5段（依頼 → 受付 → 確認 → 発送準備 → 発送完了）の Callable と通知（2026-11-12）。
// 藤田千晶さんの要望「発送の管理を CRM に、Chat は通知だけ」。計画 06_介護情報基盤事業/docs/CRM改善2_計画_20261112.md §3.1。
// 判定は ship-steps-rules.mjs（正本 admin/js/ship-steps-rules.js のバイト単位で同じコピー）。
//
// 倉庫の人（role "warehouse"）は Firestore を直接読み書きできないので、倉庫の操作は Callable だけで書く（firestore.rules は変えない）。
//   warehouseAccept … 受付（STEP2）。発送可／発送可だが入荷待ち／発送不可 を記録して、依頼者へ Chat でメンション
//   shipStepDone    … 発送完了（STEP5）の知らせ。供給管理の「発送済にする」から呼ぶ（倉庫の画面の warehouseShip / warehouseHandover は
//                     index.js から notifyShipDone を直接呼ぶ）。依頼者へメンション＋案件の対応記録に1行。二重に知らせない（shipDoneNotifiedAt）
// 依頼者の最終確認（STEP3）は依頼者（職員）の画面から直接書く（供給管理。職員は今も出荷を書ける・ルールは変えない）。
//
// index.js から require("./ship-steps")(deps) で作る（index.js の db・認可・投稿先・地域の部品を共有するため）。
// 投稿先は今のまま（出荷指示と同じ shipping）。Webhook の URL はログにも戻り値にも出さない。
const { onCall, HttpsError } = require("firebase-functions/v2/https");

let _ss;
const loadShipSteps = () => (_ss ||= import("./ship-steps-rules.mjs"));

module.exports = function makeShipSteps(deps) {
  const {
    db, admin, requireWarehouse, requireStaff, getWebhook, getSettings, clearSettingsCache, postChatCard,
    chatMentionFor, regionOfShipment, loadWarehouseRules, warehouseLocations, CRM_BASE_URL, SA_BATCH,
  } = deps;

  const SHIP_DONE_WINDOW_MS = 24 * 3600 * 1000;
  const supplyUrl = (so) => `${CRM_BASE_URL}/supply.html?tab=shipments&so=${encodeURIComponent(so || "")}`;
  const STATUS_LABEL = { draft: "下書き", requested: "依頼済", shipped: "発送済", invoiced: "請求済", paid: "入金済", canceled: "キャンセル" };
  const staleMsg = (cur) => `この出荷はすでに「${STATUS_LABEL[cur.status] || cur.status || "発送済"}」です（別の人が先に操作した可能性があります）。画面を更新してください`;
  function shipmentIdOf(data) {
    const { shipmentId } = data || {};
    if (!shipmentId || typeof shipmentId !== "string" || shipmentId.includes("/")) throw new HttpsError("invalid-argument", "出荷IDは必須です");
    return shipmentId;
  }
  async function finalConfirmSetting() {
    const ss = await loadShipSteps();
    clearSettingsCache(); // 設定画面で直した直後でも最新を使う
    return ss.finalConfirmOn(await getSettings());
  }
  // 出荷の投稿先（今のまま shipping）へ。届かなくても止めない（記録は残っている）。投稿できたら true
  async function postShipping(text) {
    clearSettingsCache();
    const url = await getWebhook("shipping");
    if (!url) return false;
    try {
      await postChatCard(url, { text });
      return true;
    } catch (e) {
      console.error("ship-steps chat failed:", String(e.message || e).replace(/https?:\/\/\S+/g, "(URL)").slice(0, 200));
      return false;
    }
  }
  async function addActivity(caseId, me, subject, body) {
    if (!caseId) return;
    try {
      await db.collection("activities").add({
        caseId, type: "memo", occurredAt: admin.firestore.FieldValue.serverTimestamp(), userId: me.uid || "", userName: me.name || me.email || "",
        subject, body, attachmentUrls: [],
      });
    } catch (e) { console.warn("ship-steps activity failed:", e.message); }
  }
  async function ctxOf(s, ss) {
    return {
      soNumber: s.soNumber || "",
      region: await regionOfShipment(s),
      qty: ss.readerQty(s.items),
      desiredDeliveryDate: s.desiredDeliveryDate || (s.deliveryMode === "pickup" ? s.pickupDate : "") || "",
      requester: await chatMentionFor(s.requestedByEmail, s.requestedBy),
      url: supplyUrl(s.soNumber),
    };
  }

  // 入力 { shipmentId, decision:"ok"|"wait"|"ng", reason?, note?, shipDate? } → { ok:true, step, notified }
  //   ok   … 発送可。設定 shipFinalConfirm が「行う」なら依頼者の確認待ちへ、「行わない」なら発送準備へ。shipDate は出荷予定日（任意）
  //   wait … 発送可だが入荷待ち（依頼は出したまま）
  //   ng   … 発送不可（理由 shortage＝在庫がなく納品希望日に間に合わない／address＝入力の不備／other）。既存の warehouseIssue に書く
  // 受付・入荷待ちの段の出荷だけ（持ち出し・直送は受付を省く）。保管場所の権限はサーバーで確かめる
  const warehouseAccept = onCall(
    { region: "asia-northeast1", timeoutSeconds: 60, serviceAccount: SA_BATCH },
    async (request) => {
      const me = await requireWarehouse(request); // 認可を最初に（入力を見る前に）
      const data = request.data || {};
      const shipmentId = shipmentIdOf(data);
      const ss = await loadShipSteps();
      const wr = await loadWarehouseRules();
      const v = ss.validateAccept(data, wr.ISSUE_REASONS);
      if (!v.ok) throw new HttpsError("invalid-argument", v.error);
      const fc = await finalConfirmSetting();
      const locs = await warehouseLocations();
      const ref = db.collection("shipments").doc(shipmentId);
      const now = admin.firestore.FieldValue.serverTimestamp();
      let s, after;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "この出荷は削除されています。画面を更新してください");
        const cur = snap.data();
        if (cur.status !== "requested") throw new HttpsError("failed-precondition", staleMsg(cur));
        if (cur.fulfillment === "direct") throw new HttpsError("failed-precondition", "直送（AB Circleから直接）の出荷は倉庫で扱いません");
        const locId = cur.originLocationId || locs.defaultId;
        if (!wr.canUseLocation(me.user, locId)) throw new HttpsError("permission-denied", "この保管場所の出荷を扱う権限がありません");
        if (!ss.canAccept(cur, { finalConfirm: fc })) {
          const k = ss.stepOf(cur, { finalConfirm: fc });
          throw new HttpsError("failed-precondition", k === "prepare" && cur.deliveryMode === "pickup"
            ? "持ち出しは受付を省きます。受け渡したら「受け渡し済にする」を押してください"
            : `この出荷はいま「${ss.STEP_LABEL[k] || k}」の段です（受付・入荷待ちの出荷だけ選べます）。画面を更新してください`);
        }
        const patch = ss.acceptPatchOf(v, { finalConfirm: fc });
        if (v.decision === "ng") {
          patch.warehouseIssue = { ...patch.warehouseIssue, at: now, byEmail: me.email, byName: me.name };
        } else {
          Object.assign(patch, {
            acceptedAt: now, acceptedByEmail: me.email, acceptedByName: me.name,
            // 倉庫の「一覧」タブの「確認済み」とつじつまを合わせる（受付をした＝依頼の内容を確かめた）
            warehouseConfirmedAt: now, warehouseConfirmedBy: me.name,
          });
        }
        tx.update(ref, { ...patch, updatedAt: now });
        s = cur;
        after = { ...cur, ...patch, finalConfirmedAt: cur.finalConfirmedAt };
      });
      const step = ss.stepOf(after, { finalConfirm: fc });
      const ctx = await ctxOf(s, ss);
      const reasonLabel = v.decision === "ng" ? wr.ISSUE_REASONS[v.reason] : "";
      if (v.decision === "ng") {
        await addActivity(s.caseId, me, `倉庫から：発送不可（${reasonLabel}）（${s.soNumber || ""}）`,
          `倉庫の${me.name}さんから、出荷 ${s.soNumber || ""} は発送できないと連絡がありました。\n理由: ${reasonLabel}${v.note ? `\nメモ: ${v.note}` : ""}`);
      }
      const text = ss.shipStepChatText(v.decision, { ...ctx, reasonLabel, note: v.note, finalConfirm: step === "confirm" });
      const notified = await postShipping(text);
      return { ok: true, step, notified };
    }
  );

  // 発送完了の知らせ（STEP5・送5）。依頼者へ Chat でメンション＋案件の対応記録に1行。事業所へのメールは送らない。
  // 1つの出荷で1回だけ（shipDoneNotifiedAt をトランザクションで付けた呼び出しだけが知らせる）。戻り値 { notified, skipped? }
  async function notifyShipDone(shipmentId, me) {
    const ss = await loadShipSteps();
    const ref = db.collection("shipments").doc(shipmentId);
    let s = null;
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return "not-found";
      const cur = snap.data();
      if (ss.stepOf(cur) !== "done") return "not-done";
      if (cur.shipDoneNotifiedAt) return "already";
      // 発送済にしてから24時間以内の出荷だけ（昔の発送済の出荷に知らせを流せないように・PR #76 レビュー 低1）
      const at = cur.shippedAt || cur.handedOverAt;
      const ms = at && typeof at.toMillis === "function" ? at.toMillis() : 0;
      if (!ms || Date.now() - ms > SHIP_DONE_WINDOW_MS) return "old";
      tx.update(ref, { shipDoneNotifiedAt: admin.firestore.FieldValue.serverTimestamp() });
      s = cur;
      return "ok";
    });
    if (claimed !== "ok") return { notified: false, skipped: claimed };
    const pickup = s.deliveryMode === "pickup" && s.fulfillment !== "direct";
    const packLabel = ss.PACK_TYPES[ss.packTypeOf(s)] || "";
    const tn = String(s.trackingNumber || "");
    await addActivity(s.caseId, me, `${pickup ? "受け渡し済" : "発送完了"}（${s.soNumber || ""}）`,
      pickup
        ? `出荷 ${s.soNumber || ""} を受け渡しました（受け渡し日 ${s.shipDate || ""}・${me.name}）。`
        : `出荷 ${s.soNumber || ""} を発送しました（発送日 ${s.shipDate || ""}・種別 ${packLabel}${tn ? `・問い合わせ番号 ${tn}` : ""}・${me.name}）。`);
    const ctx = await ctxOf(s, ss);
    const notified = await postShipping(ss.shipStepChatText("done", {
      ...ctx, pickup, packLabel, trackingNumber: tn, shipDate: s.shipDate || "",
    }));
    return { notified };
  }

  // 入力 { shipmentId } → { notified, skipped? }。供給管理の「発送済にする」「受け渡し済にする」のあとに呼ぶ（職員だけ）
  const shipStepDone = onCall(
    { region: "asia-northeast1", timeoutSeconds: 60, serviceAccount: SA_BATCH },
    async (request) => {
      const me = await requireStaff(request, { allow: "editor" });
      const shipmentId = shipmentIdOf(request.data);
      return notifyShipDone(shipmentId, me);
    }
  );

  // 出荷の依頼（STEP1）の知らせの文面（notifyShipment から使う・送6）
  async function requestChatText(s, { resend = false, pickupMention = "", locationName = "" } = {}) {
    const ss = await loadShipSteps();
    const ctx = await ctxOf(s, ss);
    const pickup = s.deliveryMode === "pickup" && s.fulfillment !== "direct";
    return ss.shipStepChatText("request", {
      ...ctx, resend, pickup, pickupBy: pickupMention, locationName,
      url: `${CRM_BASE_URL}/warehouse`, // 依頼の知らせは倉庫の人が見る
    });
  }

  return { warehouseAccept, shipStepDone, notifyShipDone, requestChatText, loadShipSteps };
};
