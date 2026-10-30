// 出荷の状態と、状態ごとに「押せるボタン・在庫の扱い・表示」を決める純粋関数（2026-10-21 出荷の二段階化・案B）。
// firebase を import しない（node の単体テスト scripts/test-ship-flow.mjs から直接読むため）。
// 画面（supply.js・case-detail.js・dashboard.js）はここを正本として使い、判定を自前に持たない。
//
// 流れ:
//   下書き(draft) ─「出荷を依頼する」→ 依頼済(requested) ─「発送済にする」→ 発送済(shipped) → 請求済(invoiced) → 入金済(paid)
//                  出荷指示を投稿する                      在庫を引き落とす・請求の起点（dueRule:'net14'）
//   下書き ─「すでに発送済（記録のみ）」→ 発送済（出荷指示は送らない）
//   依頼済 ─「依頼を取り消す」→ 下書き（出荷指示の投稿の印を消す。取り消しの連絡は人が行う）
//
// ⚠️ 出荷指示を投稿してよい状態（NOTIFY_STATUSES）は functions/index.js の notifyShipment にも同じ値を複製している
//    （Functions は CommonJS でこのファイルを require できないため）。変えるときは両方を直すこと。
// 設計: docs/CRM改善_設計_20261021.md §1・§2・§9、docs/出荷の二段階化_設計_20261020.md

export const SHIP_STATUSES = ["draft", "requested", "shipped", "invoiced", "paid", "canceled"];
export const SHIP_STATUS_LABEL = {
  draft: "下書き", requested: "依頼済", shipped: "発送済", invoiced: "請求済", paid: "入金済", canceled: "キャンセル",
};
// バッジの色番号（admin/css/crm.css の .badge-N）
export const SHIP_STATUS_BADGE = { draft: 2, requested: 5, shipped: 7, invoiced: 9, paid: 3, canceled: 4 };
// 出荷指示を投稿してよい状態（functions/index.js の NOTIFY_STATUSES と同じ値にしておく）
export const NOTIFY_STATUSES = ["requested", "shipped", "invoiced", "paid"];

// 状態。未設定は古いデータ（下書きの仕組みが無かった頃に登録した発送済の出荷）なので shipped とみなす
export function shipStatusOf(s) { return (s && s.status) || "shipped"; }

// 自社の倉庫（保管場所）を通る出荷か。発送元の欄・「自社在庫から発送」のバッジはこれで出し分ける。
//   fulfillment:"direct"    … 直送発注から自動生成（AB Circle から認定事業者へ直接）。自社在庫を通らない
//   fulfillment:"warehouse" … 出荷モーダルなどから登録。自社在庫から出す
//   未設定                  … 古いデータ・Web申込の下書き。自社在庫から出す（従来どおり）
export function usesWarehouse(s) { return ((s && s.fulfillment) || "warehouse") !== "direct"; }

// 在庫をすでに引き落としてある出荷か。**在庫を戻す・差分を動かすのはこれが真のときだけ**。
// 下書き・依頼済はまだ引いていない（発送済にした時点で引く）。キャンセル済は戻し終わっている。
export function stockDeducted(s) {
  const st = shipStatusOf(s);
  return (st === "shipped" || st === "invoiced" || st === "paid") && usesWarehouse(s);
}

// 請求書を出した後（金額に関わる欄を触らせない）・キャンセル済
export function isLocked(s) {
  const st = shipStatusOf(s);
  return st === "invoiced" || st === "paid" || st === "canceled";
}
// 削除できるのは下書きだけ（依頼済は「依頼を取り消す」で下書きへ戻してから）
export function canDelete(s) { return !!s && shipStatusOf(s) === "draft"; }
// 入金の記録（旧形式 paymentAmount の1回きりも1件として読む。supply.js の payList と同じ）
export function paymentsOf(s) {
  if (!s) return [];
  if (Array.isArray(s.payments) && s.payments.length) return s.payments;
  if (Number(s.paymentAmount) > 0) return [{ amount: Number(s.paymentAmount), date: s.paidAt || "" }];
  return [];
}
// 返金していない入金（入金 − 返金）。0 より大きければ、お金を預かったまま
export function netPaidOf(s) {
  const pay = paymentsOf(s).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const ref = (s && Array.isArray(s.refunds) ? s.refunds : []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
  return pay - ref;
}
export const CANCEL_BLOCKED_BY_PAYMENT = "この出荷には返金していない入金があります。先に入金を取り消すか返金を記録してください";
// キャンセルにできるのは下書き・依頼済・発送済・請求済（入金済は返金の手続きが先）。
// 返金していない入金が残っている出荷はキャンセルにしない（請求前に銀行明細から入金を記録した発送済など・2026-10-21 Codex 指摘2）
export function canCancel(s) {
  const st = shipStatusOf(s);
  return !!s && (st === "draft" || st === "requested" || st === "shipped" || st === "invoiced") && !(netPaidOf(s) > 0);
}

// 遷移の表。許されない遷移は null を返す（画面は null なら何もしない・トランザクションの中でも同じ表で確かめる）
const TRANSITIONS = {
  request:       { from: ["draft"], to: "requested" },      // 出荷を依頼する
  markShipped:   { from: ["requested"], to: "shipped" },    // 発送済にする
  recordShipped: { from: ["draft"], to: "shipped" },        // すでに発送済（記録のみ）
  revertToDraft: { from: ["requested"], to: "draft" },      // 依頼を取り消す（下書きへ戻す）
  invoice:       { from: ["shipped"], to: "invoiced" },     // 請求済にする
  pay:           { from: ["invoiced"], to: "paid" },        // 入金を記録する（全額）
  cancel:        { from: ["draft", "requested", "shipped", "invoiced"], to: "canceled" },
};
export function nextStatus(from, action) {
  const t = TRANSITIONS[action];
  if (!t) return null;
  return t.from.includes(from || "shipped") ? t.to : null;
}
// その遷移で出荷指示を投稿するか（投稿するのは「出荷を依頼する」だけ。発送済にしたとき・記録のみは投稿しない）
export function notifyOnTransition(action) { return action === "request"; }
// その遷移で在庫を引き落とすか（発送済になる遷移で、自社在庫を通る出荷だけ）
export function deductsOnTransition(s, action) {
  return (action === "markShipped" || action === "recordShipped") && usesWarehouse(s);
}

// 出荷指示の投稿状況（投稿済・未投稿・送らない）を出すか。
// 依頼済は必ず出す。発送済以降は、出荷指示の仕組みができた後の出荷（dueRule:'net14'）か、投稿を試みた出荷だけ
// （それより前の出荷は仕組みが無かったので「未投稿」と出さない）
export function shipNotifyShown(s) {
  if (!s) return false;
  const st = shipStatusOf(s);
  if (st === "requested") return true;
  return (st === "shipped" || st === "invoiced" || st === "paid")
    && (!!s.shipNotifiedAt || s.dueRule === "net14" || !!s.shipNotifyStatus);
}

// 状態ごとの主ボタン（次の一手）。無いときは null
export function primaryAction(s) {
  if (!s) return null;
  const st = shipStatusOf(s);
  if (st === "draft") return { key: "request", label: "出荷を依頼する", icon: "send" };
  if (st === "requested") return { key: "markShipped", label: "発送済にする", icon: "truck-delivery" };
  if (st === "shipped") return { key: "invoice", label: "請求済にする", icon: "file-invoice" };
  if (st === "invoiced") return { key: "pay", label: "入金を記録する", icon: "cash" };
  if (st === "paid") return s.receiptIssuedAt ? null : { key: "receipt", label: "領収証を出す", icon: "receipt-2" };
  return null; // canceled
}

// 出荷一覧の行に出す操作（帳票のリンクは別）。並び順は画面側が決めるので、ここは「出してよいもの」の集合
//   request 出荷を依頼する / recordShipped すでに発送済（記録のみ） / markShipped 発送済にする
//   revertToDraft 依頼を取り消す / resendNotice 出荷指示を再送 / track 追跡番号の写真
//   invoice 請求済にする / pay 入金を記録する（入金の履歴を見る） / edit 送付先・数量を直す / changeType 請求先を変える
//   payHistory 入金の履歴（発送済で入金の記録があるとき）
//   cancel キャンセルにする / delete この出荷を削除
export function shipActions(s) {
  if (!s) return [];
  const st = shipStatusOf(s);
  const acts = [];
  if (st === "draft") acts.push("request", "recordShipped", "edit", "changeType");
  else if (st === "requested") acts.push("markShipped", "resendNotice", "edit", "changeType", "revertToDraft");
  // 発送済（未請求）でも入金の記録があれば「入金の履歴」を出す（銀行明細から先に記録した入金を確かめ・取り消せるように。
  // 状態は変えない・2026-10-21 Codex 指摘1）
  else if (st === "shipped") acts.push("invoice", "track", "edit", "changeType", ...(paymentsOf(s).length ? ["payHistory"] : []));
  else if (st === "invoiced") acts.push("pay", "track", "edit", "changeType");
  else if (st === "paid") acts.push("pay", "track", "edit", "changeType");
  if (st !== "requested" && shipNotifyShown(s)) acts.push("resendNotice");
  if (canCancel(s)) acts.push("cancel");
  if (canDelete(s)) acts.push("delete");
  return acts;
}

// 数量を直したときに在庫を動かす量（品番 → 増減。増やしたら正＝在庫から引く量）。
// before/after は品番ごとの数量 { sku: qty }。在庫をまだ引いていない出荷（下書き・依頼済・直送）は何も動かさない＝空。
// 0 の品番は入れない
export function qtyDelta(s, before, after) {
  if (!stockDeducted(s)) return {};
  const out = {};
  const b = before || {}, a = after || {};
  for (const sku of Object.keys({ ...b, ...a })) {
    const d = (Number(a[sku]) || 0) - (Number(b[sku]) || 0);
    if (d) out[sku] = d;
  }
  return out;
}

// 依頼済の出荷の数量・送付先を直したとき「出荷指示を再送しますか？」と聞くか
// （センターが古い内容で動かないように）。before は直す前の出荷、after は直した後（before に patch を重ねたもの）
// 出荷指示（Chat）に載る項目。依頼済でこれが変わったら再送を確認する（shipDate＝希望出荷日も 2026-10-21 Codex 指摘で追加）
const RESEND_FIELDS = ["postal", "company", "officeName", "address", "contactName", "phone", "shipDate"];
function itemsKey(items) {
  const m = {};
  (Array.isArray(items) ? items : []).forEach((i) => {
    if (!i || i.nonStock) return;
    m[i.sku] = (m[i.sku] || 0) + (Number(i.qty) || 0);
  });
  return JSON.stringify(Object.keys(m).sort().filter((k) => m[k]).map((k) => [k, m[k]]));
}
export function needsResendPrompt(before, after) {
  if (!before || !after) return false;
  if (shipStatusOf(before) !== "requested") return false;
  if (RESEND_FIELDS.some((f) => String(before[f] ?? "").trim() !== String(after[f] ?? "").trim())) return true;
  if (after.items && itemsKey(before.items) !== itemsKey(after.items)) return true;
  return false;
}

// 案件詳細のステッパー（5段: 依頼 → 発送 → 請求書 → 入金 → 領収証）の各段の完了判定。キャンセルは全部 false
export function shipStepsDone(s) {
  const st = shipStatusOf(s);
  if (st === "canceled") return { requested: false, shipped: false, invoiced: false, paid: false, receipt: false };
  const order = ["draft", "requested", "shipped", "invoiced", "paid"];
  const idx = order.indexOf(st);
  return {
    requested: idx >= 1,
    shipped: idx >= 2,
    invoiced: idx >= 3,
    paid: idx >= 4,
    receipt: st === "paid" && !!(s && s.receiptIssuedAt),
  };
}

// ホーム（今日やること）の件数。キャンセルは数えない
export function todoCounts(ships) {
  const c = { draft: 0, requested: 0, unbilled: 0, unpaid: 0, noReceipt: 0 };
  (Array.isArray(ships) ? ships : []).forEach((s) => {
    const st = shipStatusOf(s);
    if (st === "draft") c.draft++;
    else if (st === "requested") c.requested++;
    else if (st === "shipped") c.unbilled++;
    else if (st === "invoiced") c.unpaid++;
    else if (st === "paid" && !s.receiptIssuedAt) c.noReceipt++;
  });
  return c;
}

// 出荷指示を送信中か（notifyShipment がロックを取って60秒以内で、まだ投稿済みの印が無い）。
// 送信中に「依頼を取り消す」を通すと、送信側が後から結果を書き戻して再依頼の投稿が止まるので、画面は待ってもらう
// （functions/accept-flow.js の notifyInFlight と同じ判定・2026-10-21 Codex 指摘4）
export const NOTIFY_IN_FLIGHT_MSG = "出荷指示を送信中です。少し待ってからやり直してください";
export function notifyInFlight(s, nowMs = Date.now()) {
  if (!s || s.shipNotifiedAt) return false;
  const l = s.shipNotifyLockAt;
  const ms = l && typeof l.toMillis === "function" ? l.toMillis() : (typeof l === "number" ? l : 0);
  return !!ms && nowMs - ms < 60000;
}

// レターパックの種類の初期値。カードリーダーは厚さ3cmを超えてライト（青）では送れないため、
// 未設定ならプラス（赤）にする（2026-10-21 藤田さん提案・次田さん決定）。ライトを選んで保存したものはそのまま
export const DEFAULT_LETTERPACK = "plus";
export function letterPackOrDefault(v) {
  return v === "light" || v === "plus" ? v : DEFAULT_LETTERPACK;
}

// レターパックの注意（2026-10-27 次田さん決定）。滋賀（既定の保管場所・ロジスティックセンター）以外の保管場所のものは、
// 基本的に倉庫から持ち出す（郵送しない）。ただし郵送することが全くないわけではないので、レターパックは選べるままにし、
// 止めずに注意だけ出す。letterPack は「レターパックで送る選択になっているか」。
export const LP_PICKUP_NOTICE = "この保管場所のものは、基本的に倉庫からの持ち出しです。郵送でよいか確認してください";
export function lpPickupNotice({ originLocationId, defaultLocationId, letterPack }) {
  if (!letterPack || !originLocationId || !defaultLocationId) return "";
  return originLocationId === defaultLocationId ? "" : LP_PICKUP_NOTICE;
}

// 出荷する品の台数のまとめ（2026-10-30 次田さん決定・台数を目立たせる改修）。
// 出荷指示（functions/index.js の shipQtySummary）と宛名印刷で同じ数え方にする。
// 伴走支援費・金額調整・在庫を使わない行は数えない。label は品名から「介護情報基盤 汎用カードリーダ」を外した短い名前。
// ⚠️ functions/index.js に同じ中身を複製している（Functions は CommonJS で ESM を require できないため）。
//    BEGIN〜END の間を変えたら両方そろえること（scripts/test-ship-flow.mjs が一致を確かめる）。
// BEGIN shipQtySummary
export function shipQtySummary(items) {
  const lines = (Array.isArray(items) ? items : [])
    .filter((i) => i && !i.nonStock && !["support-fee", "discount"].includes(String(i.sku || "")) && Number(i.qty) > 0)
    .map((i) => {
      const name = String(i.name || "").replace(/^介護情報基盤\s*汎用カードリーダー?\s*/, "").trim();
      return { sku: String(i.sku || ""), label: name || String(i.sku || ""), qty: Number(i.qty) };
    });
  const total = lines.reduce((a, l) => a + l.qty, 0);
  const detail = lines.map((l) => `${l.label} × ${l.qty}`).join("・");
  return { lines, total, detail };
}
// END shipQtySummary
