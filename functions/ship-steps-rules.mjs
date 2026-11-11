// カードリーダーの発送の5段（依頼 → 受付 → 確認 → 発送準備 → 発送完了）の判定（純粋 ESM・2026-11-12）。
// 藤田千晶さんの要望「発送の管理を CRM に、Chat は通知だけ」。計画: 06_介護情報基盤事業/docs/CRM改善2_計画_20261112.md §3.1（送1〜送7）。
// firebase を import しない（node の単体テスト scripts/test-ship-steps.mjs と Functions から直接読むため）。
// ⚠️ 正本はこのファイル。functions/ship-steps-rules.mjs はバイト単位で同じコピー（scripts/check-shared-sync.sh で照合）。
//    直したら cp admin/js/ship-steps-rules.js functions/ship-steps-rules.mjs で揃える。
//
// 出荷の状態（status: draft / requested / shipped / invoiced / paid / canceled）は今のまま変えない（請求・入金の計算はそのまま）。
// 5段は「依頼済（requested）の中の段」として、次の項目から読むときに決める（移行のための書き換えはしない）:
//   acceptStatus   … 倉庫の受付の結果 "ok"（発送可）／"wait"（発送可だが入荷待ち）。無ければ受付待ち
//   warehouseIssue … 倉庫の「発送不可」（既存の「出荷できない」と同じ項目・理由は ISSUE_REASONS）
//   finalConfirmedAt … 依頼者の最終確認（OK）
//   finalConfirmSkipped … 受付のときに最終確認を省いた（設定 shipFinalConfirm が「行わない」だった）
//
//   段（stepOf）:
//     draft    下書き（依頼の前）
//     accept   受付（倉庫が在庫と照らして「発送可／入荷待ち／発送不可」を選ぶ）… 新しい項目の無い既存の依頼済もここ
//     wait     入荷待ち（依頼は出したまま）
//     ng       発送不可（依頼者が倉庫を選び直す・入力を直す）
//     confirm  確認待ち（依頼者の最終確認）
//     prepare  発送準備（宛名印刷・梱包・発送）。持ち出し・直送は受付と確認を省いてここ
//     done     完了（発送済・受け渡し済・請求済・入金済）
//     canceled キャンセル

export const STEP_KEYS = ["draft", "accept", "wait", "ng", "confirm", "prepare", "done", "canceled"];
export const STEP_LABEL = {
  draft: "下書き", accept: "受付", wait: "入荷待ち", ng: "発送不可", confirm: "確認待ち",
  prepare: "発送準備", done: "完了", canceled: "キャンセル",
};
// 一覧の切り替え（タブ・チップ）の並び。下書きは供給管理だけで使う
export const STEP_LISTS = ["accept", "confirm", "wait", "ng", "prepare", "done", "canceled"];
// バッジの色番号（admin/css/crm.css の .badge-N）
export const STEP_BADGE = { draft: 2, accept: 5, wait: 1, ng: 1, confirm: 6, prepare: 3, done: 7, canceled: 4 };

const str = (v) => (v == null ? "" : String(v));
const NON_SHIP_SKUS = ["support-fee", "discount"];

// 最終確認を行う設定か（appConfig/settings.shipFinalConfirm。未設定は「行う」＝送3）
export function finalConfirmOn(settings) {
  return !(settings && settings.shipFinalConfirm === false);
}

function statusOf(s) { return (s && s.status) || "shipped"; } // 未設定は古い発送済（ship-flow.js と同じ）
function isPickupOf(s) { return !!s && s.deliveryMode === "pickup" && s.fulfillment !== "direct"; }
function isDirect(s) { return !!s && s.fulfillment === "direct"; }

// 段を決める。opts.finalConfirm … 最終確認を行う設定か（finalConfirmOn の値。省略は true）
export function stepOf(s, opts = {}) {
  if (!s) return "draft";
  const st = statusOf(s);
  if (st === "canceled") return "canceled";
  if (st === "shipped" || st === "invoiced" || st === "paid") return "done";
  if (st === "draft") return "draft";
  if (st !== "requested") return "draft";
  // 持ち出し（納品希望日に持ち出しをチェック → そのまま完了へ）と直送（AB Circle から直接）は、倉庫の受付・依頼者の確認を省く
  if (isPickupOf(s) || isDirect(s)) return "prepare";
  if (s.warehouseIssue) return "ng";
  if (s.acceptStatus === "wait") return "wait";
  if (s.acceptStatus === "ok") {
    const need = opts.finalConfirm !== false && !s.finalConfirmSkipped && !s.finalConfirmedAt;
    return need ? "confirm" : "prepare";
  }
  return "accept";
}

// 段ごとの件数（STEP_KEYS すべてのキー）
export function stepCounts(list, opts = {}) {
  const c = Object.fromEntries(STEP_KEYS.map((k) => [k, 0]));
  for (const s of Array.isArray(list) ? list : []) c[stepOf(s, opts)]++;
  return c;
}

// ---- 依頼（STEP1）の必須項目 ----
// 担当者名だけ任意。ほかは1つでも欠けたら依頼できない（藤田さんの図）。
// 発送: カードリーダーの種類・台数／事業所名・郵便番号・住所・電話番号／送付元の倉庫（直送は除く）／納品希望日／依頼者名
// 持ち出し: 事業所名／送付元の倉庫／納品希望日（＝持ち出し予定日）／持ち出す人／依頼者名（郵便番号・住所・電話は使わない）
// 戻り値: 欠けている項目の名前の配列（そろっていれば空）
export function validYmd(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}
export function readerQty(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && !i.nonStock && !NON_SHIP_SKUS.includes(str(i.sku)) && Number(i.qty) > 0)
    .reduce((a, i) => a + Number(i.qty), 0);
}
export function requestMissing(s) {
  const d = s || {};
  const out = [];
  const pickup = isPickupOf(d);
  if (!(readerQty(d.items) > 0)) out.push("カードリーダーの種類・台数");
  if (!str(d.officeName).trim() && !str(d.company).trim()) out.push("事業所名");
  if (!pickup) {
    if (!str(d.postal || d.postalCode).trim()) out.push("郵便番号");
    if (!str(d.address).trim()) out.push("住所");
    if (!str(d.phone).trim()) out.push("電話番号");
  }
  if (!isDirect(d) && !str(d.originLocationId).trim()) out.push("送付元の倉庫");
  if (!validYmd(str(d.desiredDeliveryDate))) out.push(pickup ? "持ち出し予定日（納品希望日）" : "納品希望日");
  if (pickup && !str(d.pickupByEmail).trim()) out.push("持ち出す人");
  if (!str(d.requestedBy).trim() && !str(d.requestedByEmail).trim()) out.push("依頼者名");
  return out;
}
export function requestMissingText(missing) {
  return missing && missing.length ? `依頼に必要な項目が足りません: ${missing.join("・")}` : "";
}

// ---- 受付（STEP2）----
export const ACCEPT_DECISIONS = { ok: "発送可", wait: "発送可だが入荷待ち", ng: "発送不可" };
// 受付で選べるか（受付・入荷待ちの段だけ。持ち出し・直送・発送不可・確認待ち・発送準備は選べない）
export function canAccept(s, opts = {}) {
  const k = stepOf(s, opts);
  return k === "accept" || k === "wait";
}
// 受付の入力 { decision, reason?, note?, shipDate? } の確かめ。ng は理由（ISSUE_REASONS のキー）が要る。
// shipDate は「発送可」のとき倉庫が決める出荷予定日（任意）
const ACCEPT_NOTE_MAX = 200;
export function validateAccept({ decision, reason, note, shipDate } = {}, issueReasons = {}) {
  if (!Object.prototype.hasOwnProperty.call(ACCEPT_DECISIONS, str(decision))) return { ok: false, error: "発送可・入荷待ち・発送不可のどれかを選んでください" };
  if (note != null && typeof note !== "string") return { ok: false, error: "メモの形が正しくありません" };
  const n = str(note).trim();
  if (n.length > ACCEPT_NOTE_MAX) return { ok: false, error: `メモは${ACCEPT_NOTE_MAX}字以内で入れてください` };
  if (decision === "ng") {
    if (!Object.prototype.hasOwnProperty.call(issueReasons, str(reason))) return { ok: false, error: "発送不可の理由を選んでください" };
    if (reason === "other" && !n) return { ok: false, error: "「その他」のときはメモに理由を書いてください" };
  }
  if (decision === "ok" && shipDate != null && shipDate !== "" && !validYmd(str(shipDate))) return { ok: false, error: "出荷予定日を YYYY-MM-DD で入れてください" };
  return { ok: true, decision, reason: decision === "ng" ? reason : "", note: n, shipDate: decision === "ok" && shipDate ? shipDate : "" };
}
// 受付の結果として出荷に書く項目（Functions と練習の代役で同じものを書く）。
// at・byName・byEmail は呼ぶ側が入れる（Functions は serverTimestamp）。ng は warehouseIssue を書く（既存の「出荷できない」と同じ形）
export function acceptPatchOf(v, { finalConfirm = true } = {}) {
  if (v.decision === "ok") {
    return {
      acceptStatus: "ok",
      acceptNote: v.note || "",
      ...(v.shipDate ? { shipDate: v.shipDate } : {}),
      finalConfirmSkipped: !finalConfirm, // 省いたかを受付の時点で残す（あとで設定を変えても、受付済みの出荷の段が戻らない）
    };
  }
  if (v.decision === "wait") return { acceptStatus: "wait", acceptNote: v.note || "" };
  return { warehouseIssue: { reason: v.reason, note: v.note || "" } };
}

// ---- 確認（STEP3）----
export function canFinalConfirm(s, opts = {}) { return stepOf(s, opts) === "confirm"; }

// ---- 発送準備・発送完了（STEP4・5）----
// 倉庫が「発送済にする」「受け渡し済にする」を押せるか（発送準備の段だけ）
export function canComplete(s, opts = {}) { return stepOf(s, opts) === "prepare"; }
export function completeBlockedText(s, opts = {}) {
  const k = stepOf(s, opts);
  if (k === "prepare") return "";
  return ({
    accept: "まだ受付をしていません。先に受付で「発送可」を選んでください",
    wait: "入荷待ちです。在庫がそろったら受付で「発送可」を選んでください",
    ng: "発送不可を連絡済みです。依頼者が直して依頼し直すのを待ってください",
    confirm: "依頼者の最終確認を待っています",
  })[k] || "この出荷はいま発送できる段ではありません。画面を更新してください";
}

// 梱包の種別（送4）。1〜6台＝レターパックプラス（1通に6台まで）、7台以上＝ゆうパック（元払い）。倉庫は変えられる
export const PACK_TYPES = { plus: "レターパックプラス", light: "レターパックライト", yupack: "ゆうパック（元払い）" };
export const LP_PER_PACK = 6;          // レターパックプラス1通に入る台数（2026-11-12 次田さん決定。以前は3台で1通）
export const YUPACK_FROM_QTY = 7;      // この台数からゆうパック
export function packTypeDefault(qty) { return Number(qty) >= YUPACK_FROM_QTY ? "yupack" : "plus"; }
// 出荷の種別（保存した packType → レターパックの種類 → 台数からの初期値の順）
export function packTypeOf(s) {
  const d = s || {};
  if (Object.prototype.hasOwnProperty.call(PACK_TYPES, str(d.packType))) return d.packType;
  if (d.letterPackType === "light" || d.letterPackType === "plus") return d.letterPackType;
  return packTypeDefault(readerQty(d.items));
}
// レターパックの通数（新しく作る・依頼する出荷の送料の初期値に使う。既存の出荷の送料は書き換えない）
export function letterpackCount(qty) { return Math.max(1, Math.ceil((Number(qty) || 0) / LP_PER_PACK)); }

// 発送準備リストの並び: 納品希望日の早い順（無いものは後ろ）→ 依頼の古い順
function msOf(t) {
  if (!t) return 0;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (t.seconds != null) return t.seconds * 1000;
  if (t._seconds != null) return t._seconds * 1000;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}
export function desiredKey(s) {
  const d = s || {};
  return str(d.desiredDeliveryDate || (isPickupOf(d) ? d.pickupDate : "")) || "9999-99-99";
}
export function sortByDesired(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) =>
    desiredKey(a).localeCompare(desiredKey(b)) || msOf(a && a.requestedAt) - msOf(b && b.requestedAt));
}

// ---- Chat の文面（送6）。誰の依頼・どこ宛て（市区町村まで）・何台・納品希望日 と CRM の画面へのリンクだけ ----
// 個人名は職員のメンション（依頼者・持ち出す人）だけ。事業所の担当者名・電話番号・番地は書かない。
// ctx: { soNumber, region（【府県 市区町村】まで）, qty, desiredDeliveryDate, requester（メンションか「名前さん」）,
//        pickup, pickupBy（メンション）, locationName, url, resend, reasonLabel, note, packLabel, trackingNumber, shipDate,
//        finalConfirm（発送可のとき最終確認を頼むか）}
export function shipStepChatText(kind, c = {}) {
  const so = str(c.soNumber);
  const where = str(c.region) || "（地域不明）";
  const qty = `${Number(c.qty) || 0}台`;
  const desired = str(c.desiredDeliveryDate) || "未入力";
  const link = c.url ? [`👉 CRMで見る: ${c.url}`] : [];
  const by = str(c.requester);
  if (kind === "request") {
    if (c.pickup) {
      return [
        `📦 【持ち出し】${c.resend ? "（再送）" : ""}${so} ${where} ${qty}`,
        `依頼: ${by}　持ち出す人: ${str(c.pickupBy) || "未設定"}`,
        `持ち出し予定日: ${desired}${c.locationName ? `　保管場所: ${c.locationName}` : ""}`,
        ...link,
      ].join("\n");
    }
    return [
      `📦 出荷の依頼${c.resend ? "（再送）" : ""} — ${so} ${where} ${qty}`,
      `依頼: ${by}　納品希望日: ${desired}${c.locationName ? `　送付元: ${c.locationName}` : ""}`,
      ...link,
    ].join("\n");
  }
  if (kind === "ok") {
    return [
      `✅ 発送可 — ${so} ${where} ${qty}`,
      c.finalConfirm
        ? `${by} 倉庫で発送できます。CRMで最終確認（OK／変更／キャンセル）をしてください。納品希望日: ${desired}`
        : `${by} 倉庫で発送できます。発送の準備に入ります。納品希望日: ${desired}`,
      ...link,
    ].join("\n");
  }
  if (kind === "wait") {
    return [
      `⏳ 入荷待ち — ${so} ${where} ${qty}`,
      `${by} 在庫の入荷を待ってから発送します（依頼はそのままです）。納品希望日: ${desired}${c.note ? `\nメモ: ${str(c.note).replace(/\n/g, " ／ ")}` : ""}`,
      ...link,
    ].join("\n");
  }
  if (kind === "ng") {
    return [
      `⚠️ 発送不可 — ${so} ${where} ${qty}`,
      `${by} 理由: ${str(c.reasonLabel)}${c.note ? `（${str(c.note).replace(/\n/g, " ／ ")}）` : ""}`,
      "CRMで倉庫を選び直すか、入力を直して依頼し直してください。",
      ...link,
    ].join("\n");
  }
  if (kind === "done") {
    const head = c.pickup ? "🤝 受け渡し済" : "🚚 発送完了";
    const detail = c.pickup
      ? `受け渡し日: ${str(c.shipDate)}`
      : `発送日: ${str(c.shipDate)}　種別: ${str(c.packLabel) || "—"}${c.trackingNumber ? `　問い合わせ番号: ${c.trackingNumber}` : ""}`;
    return [`${head} — ${so} ${where} ${qty}`, `${by} ${detail}`, ...link].join("\n");
  }
  return "";
}
