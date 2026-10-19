// 見積書ドキュメント（CRM表示・印刷・PDF化用）— admin/quote-print.html から使う。
//
// 何をするファイルか:
//   quotes ドキュメント1件（＋案件・事業所）から、mitsumori.html の .est-doc と体裁を合わせた
//   見積書HTMLを組み立てる。金額は quotes.amounts をそのまま使い、ここでは一切計算しない
//   （正本はサーバ。CRM側で再計算すると mitsumori.html の値とズレる可能性があるため）。
//
// 使い方:
//   import { QUOTE_DOC_STYLE, renderQuoteDocHtml, loadQuoteDocData } from "/js/quote-doc.js";
//   const data = await loadQuoteDocData(db, quoteId);
//   el.innerHTML = renderQuoteDocHtml(data);

import { doc, getDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { connectionLabel, findProduct } from "/js/product-label.js";

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function yen(n) { return `¥${(Number(n) || 0).toLocaleString("ja-JP")}`; }

function ymdJp(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
}

const PLAN_LABELS = { houmon: "訪問・通所・短期滞在系（居宅介護支援を含む）", kyojyu: "居住・入所系", other: "その他" };

// 品番1件 → 表示名（products に無ければ sku のまま。品番からBluetooth/USBの別・端子の形が分かる）
function productDisplayName(sku, products) {
  const p = findProduct(sku, products);
  if (!p) return esc(sku);
  const label = connectionLabel(p);
  const name = p.name || sku;
  return label ? `${esc(name)}（${esc(label)}）` : esc(name);
}

// ---- Firestore からこの見積書に要るものを一括取得 ----
// quotes 自体に officeName/corpName/contactName/contactEmail が焼き込まれている（発行時点のスナップショット）ため、
// office ドキュメントは「発行後に事業所情報が変わっていないか」の補足程度。取得に失敗しても見積書は出す。
export async function loadQuoteDocData(db, quoteId) {
  const qSnap = await getDoc(doc(db, "quotes", String(quoteId)));
  if (!qSnap.exists()) return null;
  const quote = { _id: qSnap.id, ...qSnap.data() };

  let kase = null, office = null;
  try {
    if (quote.caseId) {
      const cSnap = await getDoc(doc(db, "cases", quote.caseId));
      if (cSnap.exists()) kase = { _id: cSnap.id, ...cSnap.data() };
    }
  } catch (_) { /* 案件が読めなくても見積書はquotesのスナップショットだけで出せる */ }
  try {
    if (quote.officeId) {
      const oSnap = await getDoc(doc(db, "offices", quote.officeId));
      if (oSnap.exists()) office = { _id: oSnap.id, ...oSnap.data() };
    }
  } catch (_) { /* 同上 */ }

  let products = [];
  try {
    const pSnap = await getDocs(collection(db, "products"));
    products = pSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (_) { products = []; }

  return { quote, kase, office, products };
}

// ---- 見積書のHTML本体（.qdoc 配下。印刷・PDF化はこの要素をそのまま渡す） ----
// 明細を「品名・数量・単価・金額」と「伴走支援費」「金額調整」の行で出す（見積もりページ mitsumori.html と同じ形・2026-10-20）。
// 金額は料金の正本 estimate-pricing.js（window.EstimatePricing）の computeAmounts だけで出し、自前で計算しない。
// 保存済みの合計（quotes.amounts）と一致しないとき（料金改定前の見積もり等）は null を返し、従来の簡易の形で出す。
function detailedQuoteRows(q, products) {
  const EP = (typeof window !== "undefined" && window.EstimatePricing) || null;
  if (!EP || !EP.PLANS[q.plan]) return null;
  let bt = 0, btx = 0, usb = 0, usbx = 0, usbSku = null;
  for (const it of (Array.isArray(q.items) ? q.items : [])) {
    const sub = Number(it?.subsidyQty) || 0, ext = Number(it?.extraQty) || 0;
    if (it?.sku === EP.SKU.BT) { bt += sub; btx += ext; }
    else if (it?.sku === EP.SKU.USB_A || it?.sku === EP.SKU.USB_C) { usb += sub; usbx += ext; usbSku = it.sku; }
    else return null; // 想定外の品番は簡易の形にする
  }
  const c = EP.computeAmounts(q.plan, bt, usb, btx, usbx);
  const a = q.amounts || {};
  if (c.totalIncl !== Number(a.totalIncl) || c.selfPay !== Number(a.selfPay) || c.discount !== Number(a.discount || 0)) return null;
  const btName = productDisplayName(EP.SKU.BT, products); // 中で esc 済み
  const usbName = productDisplayName(usbSku || EP.SKU.USB_A, products);
  const r = [];
  const row = (name, note, qty, unit, amount, style = "") =>
    `<tr${style ? ` style="${style}"` : ""}><td>${name}${note ? `<div class="qdoc-sub-note">${note}</div>` : ""}</td><td>${qty}</td><td class="qdoc-num">${unit}</td><td class="qdoc-num">${amount}</td></tr>`;
  if (bt > 0) r.push(row(btName, `補助対象 ${bt}台（伴走支援の対象）`, `${bt}台`, yen(EP.BT_PRICE), yen(c.btSubtotal)));
  if (usb > 0) r.push(row(usbName, `補助対象 ${usb}台（伴走支援の対象）`, `${usb}台`, yen(EP.USB_PRICE), yen(c.usbSubtotal)));
  if (c.subsidyTotal > 0) r.push(row(`伴走支援費<span class="qdoc-badge-free">申請手続きの支援を含む</span>`,
    "初期登録・機器接続・マイナ資格確認アプリ設定・介護DX証明書設定・申請手続きの支援・導入後の運用相談", "1式", yen(c.accFeeIncl), yen(c.accFeeIncl)));
  if (c.discount > 0) r.push(row(`<strong>金額調整</strong>`, "合計を助成金の上限ぴったりに収めるための調整", "1式", `−${yen(c.discount)}`, `−${yen(c.discount)}`, "color:#c02828"));
  if (btx > 0) r.push(row(btName, `補助対象外 ${btx}台（自己負担で追加）`, `${btx}台`, yen(EP.BT_PRICE), yen(c.btExtraSubtotal), "background:#fff8e1"));
  if (usbx > 0) r.push(row(usbName, `補助対象外 ${usbx}台（自己負担で追加）`, `${usbx}台`, yen(EP.USB_PRICE), yen(c.usbExtraSubtotal), "background:#fff8e1"));
  return r.join("");
}

// 見積書の発行元の担当（案件の担当営業が未割当のとき）
export const DEFAULT_ISSUER_STAFF = "次田芳尚";

export function renderQuoteDocHtml({ quote: q, kase, office, products }) {
  if (!q) return `<p style="padding:40px;text-align:center;color:var(--color-ink-muted)">見積もりが見つかりません。</p>`;

  const contactName = q.contactName || kase?.contactName || "";
  const contactEmail = q.contactEmail || kase?.contactEmail || "";
  const contactTel = kase?.contactPhone || office?.phone || "";
  const addr = office ? [office.prefecture, office.city, office.addressDetail].filter(Boolean).join("") : "";
  const postal = office?.postalCode || "";
  // 宛先は「法人名（1行目・小さめ）」と「事業所名＋御中（2行目・大きく）」に分ける。
  // 1つの見出しにつなげると、幅いっぱいで言葉の途中から折り返していた（例「…栄 / 寿園」・2026-10-20）
  const toCorp = q.corpName || kase?.corpName || "";
  const toOffice = q.officeName || kase?.officeName || "";
  const displayName = [toCorp, toOffice].filter(Boolean).join("　") || "（法人名・事業所名未登録）";

  // 発行元の担当＝案件の担当営業。未割当なら次田芳尚（2026-10-20 次田さん決定。以前は「佐藤拡史」を固定で表示していた）
  const issuerStaff = kase?.assignedUserName || DEFAULT_ISSUER_STAFF;

  const contactLines = [];
  if (postal) contactLines.push(`〒${esc(postal)}`);
  if (addr) contactLines.push(esc(addr));
  if (contactName) contactLines.push(`ご担当：${esc(contactName)} 様`);
  const tel = [];
  if (contactTel) tel.push(`TEL: ${esc(contactTel)}`);
  if (contactEmail) tel.push(esc(contactEmail));
  if (tel.length) contactLines.push(tel.join(" ／ "));

  const items = Array.isArray(q.items) ? q.items : [];
  const rows = items.map((it) => {
    const subsidyQty = Number(it?.subsidyQty) || 0;
    const extraQty = Number(it?.extraQty) || 0;
    const label = productDisplayName(it?.sku, products);
    const rowsHtml = [];
    if (subsidyQty > 0) {
      rowsHtml.push(`<tr>
        <td>${label}<div class="qdoc-sub-note">補助対象 ${subsidyQty}台（伴走支援の対象）</div></td>
        <td>${subsidyQty}台</td><td colspan="2" class="qdoc-note-cell">明細は税込・合計金額で記載</td>
      </tr>`);
    }
    if (extraQty > 0) {
      rowsHtml.push(`<tr style="background:#fff8e1">
        <td>${label}<div class="qdoc-sub-note" style="color:#b27800">補助対象外 ${extraQty}台（自己負担で追加）</div></td>
        <td>${extraQty}台</td><td colspan="2" class="qdoc-note-cell">明細は税込・合計金額で記載</td>
      </tr>`);
    }
    return rowsHtml.join("");
  }).join("");

  const detailRows = detailedQuoteRows(q, products);
  const a = q.amounts || {};
  const zeroBadge = Number(a.selfPay) === 0 ? `<span class="qdoc-badge-zero">自己負担 ¥0</span>` : "";
  const extraRow = Number(a.extraPartTotal) > 0
    ? `<div class="qdoc-total-row sub" style="color:#b27800"><span>補助対象外（自己負担）合計</span><span>${yen(a.extraPartTotal)}</span></div>` : "";
  const discountRow = Number(a.discount) > 0
    ? `<div class="qdoc-total-row sub" style="color:#c02828"><span>金額調整</span><span>−${yen(a.discount)}</span></div>` : "";

  const planLabel = q.planLabel || PLAN_LABELS[q.plan] || q.plan || "";
  const validUntilDate = q.validUntil?.toDate ? q.validUntil.toDate() : (q.validUntil ? new Date(q.validUntil) : null);
  const isExpired = !!(validUntilDate && !Number.isNaN(validUntilDate.getTime()) && validUntilDate.getTime() < Date.now());
  const expiredBanner = isExpired
    ? `<div class="qdoc-expired-banner"><i class="ti ti-alert-triangle" aria-hidden="true"></i> この見積もりは有効期限を過ぎています。お申し込みの際は内容の再確認をお願いします。</div>`
    : "";

  const createdViaLabel = q.createdVia === "staff" ? "スタッフ作成" : q.createdVia === "web" ? "Web作成" : (q.createdVia || "—");
  const createdByLine = q.createdVia === "staff" && q.createdBy
    ? `<div class="qdoc-meta-line">作成: ${esc(createdViaLabel)}（${esc(q.createdBy)}）</div>`
    : `<div class="qdoc-meta-line">作成: ${esc(createdViaLabel)}</div>`;

  return `
    ${expiredBanner}
    <div class="qdoc est-doc-like">
      <div class="qdoc-head">
        <div style="flex:0 0 auto">
          <img src="/images/tadakayo_logo.png" alt="タダカヨ" class="qdoc-logo"
               onerror="this.outerHTML='&lt;div class=&quot;qdoc-logo-ph&quot;&gt;NPO法人タダカヨ&lt;/div&gt;'">
        </div>
        <div class="qdoc-title-wrap"><div class="qdoc-title">見　積　書</div></div>
        <div class="qdoc-hanko-wrap" aria-hidden="true"></div>
      </div>

      <div class="qdoc-meta">
        <div>
          ${toCorp && toOffice ? `<div class="qdoc-to-corp">${esc(toCorp)}</div>` : ""}
          <div class="qdoc-to-name">${esc(toCorp && toOffice ? toOffice : displayName)}<span class="qdoc-to-honorific">御中</span></div>
          <div class="qdoc-contact">${contactLines.join("<br>")}</div>
        </div>
        <table class="qdoc-info-table">
          <tr><td class="lbl">見積番号</td><td class="val">${esc(q.estNo || "—")}（第${esc(q.version ?? 1)}版）</td></tr>
          <tr><td class="lbl">見積日</td><td class="val">${esc(ymdJp(q.createdAt)) || "—"}</td></tr>
          <tr><td class="lbl">有効期限</td><td class="val">${esc(ymdJp(q.validUntil)) || "—"}</td></tr>
        </table>
      </div>

      <div class="qdoc-issuer">
        <div class="qdoc-issuer-text">
          <div class="qdoc-issuer-name">NPO法人タダカヨ</div>
          <div style="font-size:9pt;color:var(--color-ink-muted);line-height:1.9">
            〒143-0014　東京都大田区大森中2-1-20-1001<br>
            TEL: 050-6872-9884　／　担当: ${esc(issuerStaff)}
          </div>
        </div>
        <img src="/images/seal-tadakayo.png" alt="タダカヨの角印" class="qdoc-hanko"
             onerror="this.outerHTML='&lt;div class=&quot;qdoc-hanko-ph&quot;&gt;印&lt;br&gt;鑑&lt;/div&gt;'">
      </div>

      <table class="qdoc-table">
        <thead><tr>
          ${detailRows ? `<th style="width:52%;text-align:left">品名・摘要</th>
          <th style="width:10%">数量</th>
          <th style="width:19%">単価（税込）</th>
          <th style="width:19%">金額（税込）</th>` : `<th style="width:46%;text-align:left">品名・摘要</th>
          <th style="width:14%">数量</th>
          <th style="width:40%" colspan="2">備考</th>`}
        </tr></thead>
        <tbody>${detailRows || rows || `<tr><td colspan="3" style="text-align:center;color:var(--color-ink-muted)">明細がありません</td></tr>`}</tbody>
      </table>

      <div class="qdoc-totals-wrap">
        <div class="qdoc-totals">
          ${detailRows ? "" : `<div class="qdoc-total-row sub"><span>補助対象パート 機器小計（税込・定価）</span><span>${yen(a.readers)}</span></div>
          <div class="qdoc-total-row sub"><span>伴走支援費（税込）</span><span>${yen(a.accompanyFee)}</span></div>
          ${discountRow}`}
          ${extraRow}
          <div class="qdoc-total-row grand"><span>合計（税込）</span><span>${yen(a.totalIncl)}</span></div>
          <div class="qdoc-total-row sub-grant"><span>介護情報基盤助成金（${esc(planLabel)}）</span><span>−${yen(a.grantAmt)}</span></div>
          <div class="qdoc-total-row self"><span>事業所さまご負担額（自己負担）</span><span>${yen(a.selfPay)}${zeroBadge}</span></div>
        </div>
      </div>

      <div class="qdoc-notes">
        <strong>備考・ご案内</strong><br>
        ・プラン：<strong>${esc(planLabel)}</strong><br>
        ・本見積書の金額はすべて消費税10%を含む税込金額で表示しています。<br>
        ・本見積書の有効期限は<strong>${esc(ymdJp(q.validUntil)) || "—"}</strong>までです。<br>
        ・申し込み後も、支援の日程調整の際に台数や機種の変更ができます。<br>
        ・助成金の支給には、事業所さまが申請の要件を満たしている必要があります。タダカヨは申請手続きの支援を行います（代行はいたしません）。
        ${createdByLine}
      </div>
    </div>`;
}

// 印刷・PDF化用の複製を作る（A4幅210mmに固定。mitsumori.html の quotePrintableClone と同じ作法）
export function quoteDocPrintableClone(hostId) {
  const src = document.getElementById(hostId);
  const clone = src.cloneNode(true);
  clone.style.width = "210mm";
  clone.style.maxWidth = "none";
  clone.style.boxShadow = "none";
  clone.style.margin = "0";
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:230mm;background:#fff;z-index:-1";
  holder.appendChild(clone);
  document.body.appendChild(holder);
  fitCloneToA4(clone, holder);
  return { clone, cleanup: () => holder.remove() };
}

// ── 1ページに収める（2026-09-30・mitsumori.html と同じ考え方）──
const PX_PER_MM = 96 / 25.4;
// PDF（html2pdf）: 複製の幅を広げて描き、A4幅に縮めて貼られる性質を使って高さを 295mm 以内にする
export function fitCloneToA4(clone, holder) {
  const MAX_H = 295;
  let w = 210;
  for (let i = 0; i < 4; i++) {
    const eff = (clone.getBoundingClientRect().height / PX_PER_MM) * 210 / w;
    if (eff <= MAX_H) break;
    w = w * (eff / MAX_H) * 1.01;
    clone.style.width = w + "mm";
    if (holder) holder.style.width = (w + 20) + "mm";
  }
}
// 印刷: 直前に .qdoc の本文の高さを測り、A4 − 上下15mm に収まる分だけ縮める。印刷ボタンのあるページで1回呼ぶ
export function installPrintFit(selector = ".qdoc") {
  const fit = () => document.querySelectorAll(selector).forEach((el) => {
    el.style.zoom = "";
    const cs = getComputedStyle(el);
    const h = (el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / PX_PER_MM;
    const sc = Math.min(1, (267 - 8) / h);   // 画面と印刷で行の折り返しが少し違うぶんの余裕
    if (sc < 1) el.style.zoom = String(Math.floor(sc * 1000) / 1000);
  });
  window.addEventListener("beforeprint", fit);
  window.addEventListener("afterprint", () => document.querySelectorAll(selector).forEach((el) => { el.style.zoom = ""; }));
}

// 見積書のCSS（mitsumori.html の .est-doc と見た目を一致させる。プレフィックスは .qdoc）
export const QUOTE_DOC_STYLE = `
.qdoc-expired-banner{max-width:210mm;margin:0 auto 10px;background:#FFF3E0;border:1px solid #c87a1f;color:#8a5a1f;border-radius:8px;padding:10px 14px;font-size:13px;display:flex;align-items:center;gap:8px}
.qdoc{width:210mm;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:18mm 18mm 16mm;font-size:10.5pt;font-family:"Noto Sans JP","Hiragino Sans",system-ui,sans-serif;color:#111;margin:0 auto;}
.qdoc-head{display:flex;align-items:center;margin-bottom:7mm;}
.qdoc-logo{height:44px;display:block;}
.qdoc-logo-ph{height:44px;display:flex;align-items:center;font-size:14px;font-weight:700;color:#c02828;}
.qdoc-title-wrap{flex:1;text-align:center;}
.qdoc-title{font-size:22pt;font-weight:900;letter-spacing:.3em;}
.qdoc-hanko-wrap{width:80px;display:flex;justify-content:flex-end;}
.qdoc-hanko{width:72px;height:72px;object-fit:contain;}
.qdoc-hanko-ph{width:72px;height:72px;border:2px solid #c02828;display:flex;align-items:center;justify-content:center;color:#c02828;font-size:11px;text-align:center;line-height:1.5;}
.qdoc-meta{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6mm;}
.qdoc-num{text-align:right;white-space:nowrap;}
.qdoc-badge-free{display:inline-block;background:#1f7a4d;color:#fff;font-size:8.5pt;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:5px;vertical-align:1px;}
.qdoc-to-corp{font-size:11pt;font-weight:600;color:#333;margin-bottom:2px;word-break:keep-all;overflow-wrap:anywhere;}
.qdoc-to-name{font-size:15pt;font-weight:700;border-bottom:1.5px solid #111;padding-bottom:3px;margin-bottom:3px;min-width:180px;max-width:105mm;word-break:keep-all;overflow-wrap:anywhere;line-height:1.4;}
.qdoc-to-honorific{font-size:11pt;font-weight:600;color:#111;margin-left:.6em;white-space:nowrap;}
.qdoc-contact{font-size:10pt;color:#6a5e48;margin-top:6px;line-height:1.7;}
.qdoc-info-table{font-size:9.5pt;line-height:1.9;text-align:right;}
.qdoc-info-table td{padding:0 0 0 12px;}
.qdoc-info-table .lbl{color:#6a5e48;white-space:nowrap;}
.qdoc-info-table .val{font-weight:600;white-space:nowrap;}
.qdoc-issuer{background:#fafafa;border:1px solid #E8E4DC;border-radius:8px;padding:8px 14px;margin-bottom:7mm;font-size:9.5pt;line-height:1.8;display:flex;align-items:center;gap:12px;}
.qdoc-issuer-text{flex:1;min-width:0;}
.qdoc-issuer .qdoc-hanko,.qdoc-issuer .qdoc-hanko-ph{flex:0 0 auto;margin-left:-4px;}
.qdoc-issuer-name{font-size:11pt;font-weight:700;margin-bottom:2px;}
.qdoc-table{width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:5mm;}
.qdoc-table th{background:#222;color:#fff;padding:7px 10px;font-size:9.5pt;font-weight:600;}
.qdoc-table th:nth-child(2){text-align:center;}
.qdoc-table td{padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;}
.qdoc-table tr:last-child td{border-bottom:none;}
.qdoc-table td:nth-child(2){text-align:center;}
.qdoc-note-cell{font-size:9pt;color:#6a5e48;}
.qdoc-sub-note{font-size:8.5pt;color:#6a5e48;margin-top:2px;padding-left:2px;}
.qdoc-badge-zero{display:inline-block;background:#1f7a4f;color:#fff;font-size:9pt;font-weight:700;padding:2px 10px;border-radius:20px;margin-left:7px;vertical-align:middle;}
.qdoc-totals-wrap{display:flex;justify-content:flex-end;margin-bottom:5mm;}
.qdoc-totals{width:330px;}
.qdoc-total-row>span:last-child{white-space:nowrap;margin-left:10px;}
.qdoc-total-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:10pt;}
.qdoc-total-row.sub{color:#6a5e48;font-size:9.5pt;}
.qdoc-total-row.grand{font-size:12.5pt;font-weight:700;border-top:2px solid #111;border-bottom:1px solid #111;padding:6px 0;margin:2px 0;}
.qdoc-total-row.sub-grant{color:#1f7a4f;font-weight:600;font-size:9.5pt;border-top:1px solid #eee;padding-top:6px;}
.qdoc-total-row.self{white-space:nowrap;font-size:14pt;font-weight:900;color:#c02828;border-top:2.5px solid #c02828;padding-top:7px;margin-top:2px;}
.qdoc-notes{font-size:8.5pt;color:#6a5e48;line-height:1.8;border-top:1px solid #E8E4DC;padding-top:4mm;margin-top:4mm;}
.qdoc-notes strong{color:#111;}
.qdoc-meta-line{margin-top:6px;color:#9a8e78;}
@media print{
  .qdoc{box-shadow:none;width:auto;padding:0;}
  @page{size:A4 portrait;margin:15mm;}
}
@media (max-width:820px){ .qdoc{width:100%;} }
`;
