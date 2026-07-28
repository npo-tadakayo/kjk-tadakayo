/**
 * 認定事業所からの発注ファイル（CSV / JSON）のパース
 *
 * 仕様: `認定事業所向け_発注受注管理仕様書.md` §3（2026-05-27 発行・認定事業所へ配布済み）
 *   - CSV: 1行 = 1品番。同じ partner_order_no の複数行は 1受注にまとめる
 *   - JSON: 1ファイル = 1受注（items 配列）
 *
 * 副作用なし（DOM・Firestore に触れない）。取込前のプレビューと検証に使う。
 */

/** 仕様書§3-1 のヘッダー（この並び・名称で配布済み。勝手に変えない） */
export const CSV_HEADERS = [
  "partner_id", "partner_order_no", "order_date", "contact_name", "contact_phone", "contact_email",
  "sku", "qty", "desired_delivery_date", "shipping_type", "shipping_postal_code", "shipping_address",
  "shipping_company", "shipping_office_name", "shipping_contact_name", "shipping_contact_phone",
  "is_subsidy_applied", "subsidy_category", "notes",
];

export const SHIPPING_TYPES = ["partner", "direct", "other"];
export const SUBSIDY_CATEGORIES = ["houmon", "kyojyu", "other"];

/** RFC4180 相当の最小CSVパーサ（引用符・埋め込みカンマ・CRLF・BOM に対応） */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  // 全セル空の行は捨てる（末尾の改行・Excelが付ける空行）
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

const truthy = (v) => ["true", "1", "はい", "yes", "y"].includes(String(v).trim().toLowerCase());
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CSVテキスト → 受注の配列。
 * @param {string} text
 * @param {(sku:string)=>({id:string,name:string}|undefined)} findProduct 商品マスタ参照
 * @returns {{orders:object[], errors:string[]}}
 */
export function parseOrderCsv(text, findProduct) {
  const rows = parseCsv(text);
  const errors = [];
  if (!rows.length) return { orders: [], errors: ["ファイルが空です。"] };

  const header = rows[0].map((h) => h.trim());
  const missing = CSV_HEADERS.filter((h) => !header.includes(h));
  if (missing.length) {
    return { orders: [], errors: [`ヘッダー行に必須の列がありません: ${missing.join(", ")}`] };
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (r, key) => String(r[idx[key]] ?? "").trim();

  // partner_order_no ごとに1受注へまとめる（仕様書§3-1 の「複数品番は同じ番号で2行」）
  const byOrderNo = new Map();
  rows.slice(1).forEach((r, n) => {
    const line = n + 2; // 1始まり＋ヘッダー行
    const orderNo = get(r, "partner_order_no");
    const sku = get(r, "sku");
    const qty = Number(get(r, "qty"));
    const shippingType = get(r, "shipping_type");

    if (!orderNo) { errors.push(`${line}行目: partner_order_no が空です。`); return; }
    const product = findProduct ? findProduct(sku) : undefined;
    if (!sku) errors.push(`${line}行目: sku が空です。`);
    else if (findProduct && !product) errors.push(`${line}行目: 商品マスタにない sku です（${sku}）。`);
    if (!Number.isFinite(qty) || qty < 1) errors.push(`${line}行目: qty は1以上の整数で入力してください（${get(r, "qty")}）。`);
    if (shippingType && !SHIPPING_TYPES.includes(shippingType)) {
      errors.push(`${line}行目: shipping_type は ${SHIPPING_TYPES.join(" / ")} のいずれかです（${shippingType}）。`);
    }
    if ((shippingType === "direct" || shippingType === "other") && !get(r, "shipping_address")) {
      errors.push(`${line}行目: shipping_type が ${shippingType} の場合は shipping_address が必須です。`);
    }
    const orderDate = get(r, "order_date");
    if (orderDate && !ISO_DATE.test(orderDate)) errors.push(`${line}行目: order_date は YYYY-MM-DD 形式で入力してください（${orderDate}）。`);
    const desired = get(r, "desired_delivery_date");
    if (desired && !ISO_DATE.test(desired)) errors.push(`${line}行目: desired_delivery_date は YYYY-MM-DD 形式で入力してください（${desired}）。`);
    const subsidyApplied = truthy(get(r, "is_subsidy_applied"));
    const subsidyCategory = get(r, "subsidy_category");
    if (subsidyApplied && !SUBSIDY_CATEGORIES.includes(subsidyCategory)) {
      errors.push(`${line}行目: is_subsidy_applied=true の場合 subsidy_category は ${SUBSIDY_CATEGORIES.join(" / ")} が必須です。`);
    }

    const item = { sku, name: product?.name || sku, qty: Number.isFinite(qty) ? qty : 0 };
    const existing = byOrderNo.get(orderNo);
    if (existing) {
      existing.items.push(item);
      return; // 2行目以降は明細だけ足す（ヘッダー項目は1行目を正とする）
    }
    byOrderNo.set(orderNo, {
      partnerOrderNo: orderNo,
      partnerId: get(r, "partner_id"),
      partnerEmail: get(r, "contact_email"),
      partnerName: "", // 取込時に partners マスタから解決
      orderDate,
      contact: { name: get(r, "contact_name"), phone: get(r, "contact_phone"), email: get(r, "contact_email") },
      items: [item],
      desiredDeliveryDate: desired,
      shipping: {
        type: shippingType,
        postal: get(r, "shipping_postal_code"),
        address: get(r, "shipping_address"),
        company: get(r, "shipping_company"),
        officeName: get(r, "shipping_office_name"),
        contactName: get(r, "shipping_contact_name"),
        phone: get(r, "shipping_contact_phone"),
      },
      isSubsidyApplied: subsidyApplied,
      subsidyCategory: subsidyApplied ? subsidyCategory : "",
      note: get(r, "notes"),
      source: "csv",
    });
  });

  return { orders: [...byOrderNo.values()], errors };
}

/**
 * JSONテキスト → 受注の配列（仕様書§3-2。1ファイル1受注だが配列も受ける）。
 * @returns {{orders:object[], errors:string[]}}
 */
export function parseOrderJson(text, findProduct) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { orders: [], errors: [`JSONとして読めません: ${e.message}`] };
  }
  const list = Array.isArray(data) ? data : [data];
  const errors = [];
  const orders = [];

  list.forEach((d, n) => {
    const at = list.length > 1 ? `${n + 1}件目: ` : "";
    const orderNo = String(d.partner_order_no ?? "").trim();
    if (!orderNo) errors.push(`${at}partner_order_no が空です。`);
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) errors.push(`${at}items が空です。`);

    const parsedItems = items.map((it) => {
      const sku = String(it.sku ?? "").trim();
      const qty = Number(it.qty);
      const product = findProduct ? findProduct(sku) : undefined;
      if (!sku) errors.push(`${at}items に sku のない明細があります。`);
      else if (findProduct && !product) errors.push(`${at}商品マスタにない sku です（${sku}）。`);
      if (!Number.isFinite(qty) || qty < 1) errors.push(`${at}qty は1以上の整数で入力してください（${it.qty}）。`);
      return { sku, name: product?.name || sku, qty: Number.isFinite(qty) ? qty : 0 };
    });

    const sh = d.shipping || {};
    const shippingType = String(sh.type ?? "").trim();
    if (shippingType && !SHIPPING_TYPES.includes(shippingType)) {
      errors.push(`${at}shipping.type は ${SHIPPING_TYPES.join(" / ")} のいずれかです（${shippingType}）。`);
    }
    if ((shippingType === "direct" || shippingType === "other") && !sh.address) {
      errors.push(`${at}shipping.type が ${shippingType} の場合は shipping.address が必須です。`);
    }
    const subsidy = d.subsidy || {};
    const applied = subsidy.is_applied === true;
    if (applied && !SUBSIDY_CATEGORIES.includes(String(subsidy.category ?? ""))) {
      errors.push(`${at}subsidy.is_applied=true の場合 subsidy.category は ${SUBSIDY_CATEGORIES.join(" / ")} が必須です。`);
    }
    const contact = d.contact || {};

    orders.push({
      partnerOrderNo: orderNo,
      partnerId: String(d.partner_id ?? "").trim(),
      partnerEmail: String(contact.email ?? "").trim(),
      partnerName: "",
      orderDate: String(d.order_date ?? "").trim(),
      contact: { name: String(contact.name ?? ""), phone: String(contact.phone ?? ""), email: String(contact.email ?? "") },
      items: parsedItems,
      desiredDeliveryDate: String(d.desired_delivery_date ?? "").trim(),
      shipping: {
        type: shippingType,
        postal: String(sh.postal_code ?? ""),
        address: String(sh.address ?? ""),
        company: String(sh.company ?? ""),
        officeName: String(sh.office_name ?? ""),
        contactName: String(sh.contact_name ?? ""),
        phone: String(sh.contact_phone ?? ""),
      },
      isSubsidyApplied: applied,
      subsidyCategory: applied ? String(subsidy.category ?? "") : "",
      note: String(d.notes ?? ""),
      source: "json",
    });
  });

  return { orders, errors };
}

/** 拡張子で振り分け（.json 以外はCSVとして読む） */
export function parseOrderFile(fileName, text, findProduct) {
  return /\.json$/i.test(fileName)
    ? parseOrderJson(text, findProduct)
    : parseOrderCsv(text, findProduct);
}
