// 倉庫の画面（/warehouse）と倉庫の Callable（functions/index.js の warehouse*）で共有する判定（純粋 ESM・2026-10-24）。
// firebase を import しない（node の単体テスト scripts/test-warehouse-rules.mjs と Functions から直接読むため）。
// ⚠️ 正本はこのファイル。functions/warehouse-rules.mjs はバイト単位で同じコピー（scripts/check-shared-sync.sh で照合）。
//    直したら cp admin/js/warehouse-rules.js functions/warehouse-rules.mjs で揃える。
// 設計: docs/倉庫メニュー_設計_20261024.md §9（確定設計）・§5.5（送付方法「持ち出し」）

// 送付方法。出荷の deliveryMode。未設定は "ship"（今までどおりの発送）
export const DELIVERY_MODES = { ship: "発送", pickup: "持ち出し" };
export function deliveryModeOf(s) {
  return s && s.deliveryMode === "pickup" ? "pickup" : "ship";
}
// 出荷の状態。未設定は古いデータ（下書きの仕組みが無かった頃の発送済）なので shipped とみなす
// （admin/js/ship-flow.js の shipStatusOf と同じ・2026-10-24 Codex 指摘3回目）
export function shipStatusOf(s) {
  return (s && s.status) || "shipped";
}

// 宛名ラベルの差出人（依頼主）。admin/js/letterpack-print.js の sendersOf と同じ順で決める:
// 設定 appConfig/settings の senders（名前か住所のあるもの）→ 旧形式 sender* → 請求書の発行者情報 → 既定（NPO法人タダカヨ）。
// 倉庫の画面で宛名を印刷するために warehouseList が返す（倉庫の人は appConfig を直接読めない）。
// 戻り値 { name, postalCode, address, phone }（1件目。印刷ページと同じく、複数あれば先頭）。名前も住所も無ければ null
const SENDER_DEFAULT = {
  name: "NPO法人タダカヨ　介護情報基盤伴走支援事業",
  postal: "",
  address: "東京都大田区大森中二丁目1番20-1001号",
  phone: "050-6872-9884",
};
export function senderForLabel(settings) {
  const st = settings || {};
  let list = Array.isArray(st.senders) ? st.senders.filter((x) => x && (x.name || x.address)) : [];
  if (!list.length && st.senderName) {
    list = [{ name: st.senderName, postal: st.senderPostal || "", address: st.senderAddress || "", phone: st.senderPhone || "" }];
  }
  if (!list.length) {
    list = [{
      name: st.invoiceIssuerName ? `${st.invoiceIssuerName}　介護情報基盤伴走支援事業` : SENDER_DEFAULT.name,
      postal: st.invoiceIssuerPostal || SENDER_DEFAULT.postal,
      address: st.invoiceIssuerAddress || SENDER_DEFAULT.address,
      phone: st.invoiceIssuerTel || SENDER_DEFAULT.phone,
    }];
  }
  const x = list[0];
  if (!x || !(x.name || x.address)) return null;
  return { name: str(x.name), postalCode: str(x.postal), address: str(x.address), phone: str(x.phone) };
}

// 持ち出しにできる出荷か。直送（fulfillment "direct"＝AB Circle から直接届く）は倉庫を通らないので持ち出しにできない
// （2026-10-24 Codex 指摘2回目）。依頼の画面・出荷指示（notifyShipment）・倉庫の Callable・練習の代役で同じ判定を使う
export function canPickup(s) {
  return !!s && s.fulfillment !== "direct";
}

// 倉庫からの差し戻し「出荷できない」の理由（warehouseIssue.reason）
export const ISSUE_REASONS = {
  shortage: "在庫が足りない",
  address: "届け先の情報が足りない・違う",
  other: "その他",
};
const ISSUE_NOTE_MAX = 200; // 「出荷できない」のメモの上限（字）

// 倉庫の人（role "warehouse"）か
export function isWarehouseRole(user) {
  return !!user && user.role === "warehouse";
}

// その保管場所を倉庫の画面で扱えるか（サーバーの認可と画面の場所選択で同じ判定を使う）。
//   倉庫の人 … 有効で、users.locationIds にその場所があるときだけ
//   管理者・スタッフ（role 未設定の既存登録者も含む）… 有効なら全保管場所
//   閲覧のみ・練習生・その他 … 使えない
export function canUseLocation(user, locationId) {
  if (!user || user.active !== true) return false;
  const loc = typeof locationId === "string" ? locationId : "";
  if (!loc) return false;
  const role = user.role == null ? "" : user.role;
  if (role === "warehouse") return Array.isArray(user.locationIds) && user.locationIds.includes(loc);
  return role === "admin" || role === "staff" || role === "";
}

// 保管場所の並び（有効なものだけ・sort の小さい順→名前順）。supply.js の locations の並べ方と同じ（2026-10-24 Codex 指摘3）。
// id は Firestore の文書ID（id か _id のどちらでもよい）
export function orderLocations(locations) {
  return (Array.isArray(locations) ? locations : [])
    .filter((l) => l && l.active !== false)
    .slice()
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name || "").localeCompare(String(b.name || "")));
}
// 既定の保管場所の ID（isDefault の付いたもの、無ければ並びの先頭）。出荷元が未設定の古い出荷はここから出すとみなす。
// supply.js の defaultLocationId・Functions の warehouse*・練習モードの代役で同じものを使う
export function defaultLocationIdOf(locations) {
  const a = orderLocations(locations);
  const l = a.find((x) => x.isDefault) || a[0];
  return l ? String(l.id || l._id || "") : "";
}

// 倉庫がいま処理する出荷か（依頼済・直送でない・出荷元がその場所）。
// 出荷元が未設定の古い出荷は既定の場所から出すものとして扱う（supply.js の shipLocationOf と同じ）
export function warehouseActionable(s, locationId, defaultLocationId) {
  if (!s || !locationId) return false;
  if (s.status !== "requested") return false;
  if (s.fulfillment === "direct") return false;
  return (s.originLocationId || defaultLocationId || "") === locationId;
}

// Timestamp・Date・文字列 → ISO 文字列（Callable の戻り値で扱いやすい形）。無ければ null
function isoOf(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v;
  if (typeof v.toMillis === "function") return new Date(v.toMillis()).toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  return null;
}
const str = (v) => (v == null ? "" : String(v));

// 品物ではない明細（請求書の金額合わせの行）。倉庫には出さない（functions/index.js の NON_SHIP_SKUS と同じ）
const NON_SHIP_SKUS = ["support-fee", "discount"];

// 倉庫に返す出荷の形（W）。**ここに書いた項目以外は返さない**（金額・案件ID・請求・事業所の他の情報を出さない）
export function projectForWarehouse(s) {
  const d = s || {};
  const status = shipStatusOf(d); // 未設定は発送済（ship-flow.js と同じ）
  const requested = status === "requested";
  const items = (Array.isArray(d.items) ? d.items : [])
    .filter((i) => i && !i.nonStock && !NON_SHIP_SKUS.includes(str(i.sku)) && Number(i.qty) > 0)
    .map((i) => ({ sku: str(i.sku), name: str(i.name), qty: Number(i.qty) || 0 }));
  const wi = d.warehouseIssue && typeof d.warehouseIssue === "object" ? d.warehouseIssue : null;
  return {
    id: str(d.id || d._id),
    soNumber: str(d.soNumber),
    status,
    deliveryMode: deliveryModeOf(d),
    officeName: str(d.officeName),
    company: str(d.company),
    contactName: str(d.contactName),
    postalCode: str(d.postal || d.postalCode),
    address: str(d.address),
    phone: str(d.phone),
    items,
    // 依頼の時点の shipDate は希望出荷日（発送済にしたとき実際の発送日に置き換わる）
    desiredDate: requested ? str(d.shipDate) : "",
    letterPackType: str(d.letterPackType),
    note: str(d.shipNote || d.note || ""),
    requestedByName: str(d.requestedBy),
    requestedAt: isoOf(d.requestedAt),
    pickupByName: str(d.pickupByName),
    pickupDate: str(d.pickupDate),
    warehouseIssue: wi ? { reason: str(wi.reason), note: str(wi.note), at: isoOf(wi.at), byName: str(wi.byName) } : null,
    shipDate: requested ? "" : str(d.shipDate),
    trackingNumber: str(d.trackingNumber),
    handedOverAt: isoOf(d.handedOverAt),
    handedOverByName: str(d.handedOverByName),
  };
}

// 出荷元の在庫が足りない品目。productsBySku に無い品番（商品マスタに無い明細）と nonStock は在庫を動かさないので数えない
// （supply.js の stockItems と同じ）。戻り値 [{sku, name, need, have}]（足りていれば空）
export function stockShortage(items, productsBySku, locationId) {
  const map = productsBySku || {};
  const need = {};
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || i.nonStock) continue;
    const sku = str(i.sku);
    if (!sku || !map[sku]) continue;
    need[sku] = (need[sku] || 0) + (Number(i.qty) || 0);
  }
  const out = [];
  for (const [sku, n] of Object.entries(need)) {
    if (!(n > 0)) continue;
    const p = map[sku] || {};
    const have = Number((p.stockByLocation || {})[locationId]) || 0;
    if (have < n) out.push({ sku, name: str(p.name || sku), need: n, have });
  }
  return out;
}

// 存在する YYYY-MM-DD か
function validYmd(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

// 持ち出しの依頼の入力（持ち出す人のメール・予定日）
export function validatePickup({ pickupByEmail, pickupDate } = {}) {
  const e = str(pickupByEmail).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: "持ち出す人を選んでください" };
  if (!validYmd(pickupDate)) return { ok: false, error: "持ち出しの予定日を YYYY-MM-DD で入れてください" };
  return { ok: true };
}

// 「出荷できない」の入力（理由・メモ）。メモは200字まで。「その他」はメモ必須
export function validateIssue({ reason, note } = {}) {
  if (!Object.prototype.hasOwnProperty.call(ISSUE_REASONS, str(reason))) return { ok: false, error: "理由を選んでください" };
  if (note != null && typeof note !== "string") return { ok: false, error: "メモの形が正しくありません" };
  const n = str(note).trim();
  if (n.length > ISSUE_NOTE_MAX) return { ok: false, error: `メモは${ISSUE_NOTE_MAX}字以内で入れてください` };
  if (reason === "other" && !n) return { ok: false, error: "「その他」のときはメモに理由を書いてください" };
  return { ok: true, reason, note: n };
}
