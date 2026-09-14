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
export function renderQuoteDocHtml({ quote: q, kase, office, products }) {
  if (!q) return `<p style="padding:40px;text-align:center;color:var(--color-ink-muted)">見積もりが見つかりません。</p>`;

  const contactName = q.contactName || kase?.contactName || "";
  const contactEmail = q.contactEmail || kase?.contactEmail || "";
  const contactTel = kase?.contactPhone || office?.phone || "";
  const addr = office ? [office.prefecture, office.city, office.addressDetail].filter(Boolean).join("") : "";
  const postal = office?.postalCode || "";
  const displayName = [q.corpName || kase?.corpName, q.officeName || kase?.officeName].filter(Boolean).join("　") || "（法人名・事業所名未登録）";

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
               onerror="this.outerHTML='&lt;div class=&quot;qdoc-logo-ph&quot;&gt;特定非営利活動法人タダカヨ&lt;/div&gt;'">
        </div>
        <div class="qdoc-title-wrap"><div class="qdoc-title">見　積　書</div></div>
        <div class="qdoc-hanko-wrap" aria-hidden="true"></div>
      </div>

      <div class="qdoc-meta">
        <div>
          <div class="qdoc-to-name">${esc(displayName)}</div>
          <div class="qdoc-to-honorific">御中</div>
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
          <div class="qdoc-issuer-name">特定非営利活動法人タダカヨ</div>
          <div style="font-size:9pt;color:var(--color-ink-muted);line-height:1.9">
            〒143-0014　東京都大田区大森中2-1-20-1001<br>
            TEL: 050-6872-9884　／　担当: 佐藤拡史
          </div>
        </div>
        <img src="/images/seal-tadakayo.png" alt="タダカヨの角印" class="qdoc-hanko"
             onerror="this.outerHTML='&lt;div class=&quot;qdoc-hanko-ph&quot;&gt;印&lt;br&gt;鑑&lt;/div&gt;'">
      </div>

      <table class="qdoc-table">
        <thead><tr>
          <th style="width:46%;text-align:left">品名・摘要</th>
          <th style="width:14%">数量</th>
          <th style="width:40%" colspan="2">備考</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="3" style="text-align:center;color:var(--color-ink-muted)">明細がありません</td></tr>`}</tbody>
      </table>

      <div class="qdoc-totals-wrap">
        <div class="qdoc-totals">
          <div class="qdoc-total-row sub"><span>補助対象パート 機器小計（税込・定価）</span><span>${yen(a.readers)}</span></div>
          <div class="qdoc-total-row sub"><span>伴走支援費（税込）</span><span>${yen(a.accompanyFee)}</span></div>
          ${discountRow}
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
  return { clone, cleanup: () => holder.remove() };
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
.qdoc-to-name{font-size:15pt;font-weight:700;border-bottom:1.5px solid #111;padding-bottom:3px;margin-bottom:3px;min-width:180px;}
.qdoc-to-honorific{font-size:10pt;color:#6a5e48;}
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
.qdoc-totals{width:270px;}
.qdoc-total-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:10pt;}
.qdoc-total-row.sub{color:#6a5e48;font-size:9.5pt;}
.qdoc-total-row.grand{font-size:12.5pt;font-weight:700;border-top:2px solid #111;border-bottom:1px solid #111;padding:6px 0;margin:2px 0;}
.qdoc-total-row.sub-grant{color:#1f7a4f;font-weight:600;font-size:9.5pt;border-top:1px solid #eee;padding-top:6px;}
.qdoc-total-row.self{font-size:14pt;font-weight:900;color:#c02828;border-top:2.5px solid #c02828;padding-top:7px;margin-top:2px;}
.qdoc-notes{font-size:8.5pt;color:#6a5e48;line-height:1.8;border-top:1px solid #E8E4DC;padding-top:4mm;margin-top:4mm;}
.qdoc-notes strong{color:#111;}
.qdoc-meta-line{margin-top:6px;color:#9a8e78;}
@media print{
  .qdoc{box-shadow:none;}
  @page{size:A4 portrait;margin:15mm;}
}
@media (max-width:820px){ .qdoc{width:100%;} }
`;
