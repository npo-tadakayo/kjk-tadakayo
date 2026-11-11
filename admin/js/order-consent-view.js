// admin/js/order-consent-view.js — 承諾書を開くページ（consent.html）で、発注の承諾書（consentRequests の kind:"order"）を
// 表示するための部品（2026-11-12・承諾書のサイン＝発注 第2段）。純粋関数だけ（DOM・Firestore に触れない）。
// 設計: 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md §4 段2。テスト: node scripts/test-order-consent-web.mjs
//
// ・発注の承諾書は、受注確定と同じ処理の中でサーバーが「署名済み」で作る（Web の同意 web_order・紙の受け取り paper_order）。
//   このページは**読むだけ**（署名のボタンは出さない）。焼き込んだ見積もりの内容（見積番号・版・事業所・品目・台数・金額）と署名の情報を出す。
// ・伴走支援だけの承諾書（v1.1・kind なし）の署名ページの動きは consent-sign.js のまま変えない。
import { itemsText, ORDER_RECEIVED_VIA } from "./order-consent.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const yen = (n) => `¥${(Number(n) || 0).toLocaleString("ja-JP")}`;

function toDate(v) {
  try {
    if (v == null || v === "") return null;
    const d = typeof v.toDate === "function" ? v.toDate() : (v instanceof Date ? v : new Date(v));
    return Number.isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}
/** 日時（JST）「2026年11月12日 14:05」。取れなければ "" */
export function fmtJstDateTime(v) {
  const d = toDate(v);
  if (!d) return "";
  const j = new Date(d.getTime() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日 ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}
/** "YYYY-MM-DD" → 「2026年11月12日」 */
export function fmtYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : "";
}

/** 発注の承諾書か */
export function isOrderConsentRecord(data) { return !!data && data.kind === "order"; }

/**
 * 署名の情報（画面に出す項目の並び）。
 * Web（見積もりページで同意）: 署名者・同意した日時（サーバーの時刻）・方法「オンライン（見積もりページで同意）」
 * 紙: 署名者・受け取った日・方法「書面（受け取り方）」・記録した日時
 */
export function orderSignInfo(data) {
  const s = (data && data.signed) || {};
  const paper = s.method === "paper_order";
  const rows = [{ label: "署名者", value: s.name || "—" }];
  if (paper) {
    rows.push({ label: "受け取った日", value: fmtYmd(s.receivedDate) || "—" });
    rows.push({ label: "方法", value: `書面でご署名（${ORDER_RECEIVED_VIA[s.receivedVia] || "その他"}で受け取り）` });
    const rec = fmtJstDateTime(s.signedAt);
    if (rec) rows.push({ label: "記録した日時", value: rec });
  } else {
    rows.push({ label: "同意した日時", value: fmtJstDateTime(s.signedAt) || "—" });
    rows.push({ label: "方法", value: "オンラインで同意（見積もりページ）" });
  }
  return { paper, rows, methodNote: paper ? "書面で署名" : "オンラインで同意" };
}

/** 署名の情報の行の HTML（.signrow の中身） */
export function orderSignRowHtml(data) {
  return orderSignInfo(data).rows.map((r) => `<span>${esc(r.label)}　<b>${esc(r.value)}</b></span>`).join("");
}

/** 焼き込んだ見積もりの表（見積番号・版・事業所・品目・台数・金額。まとめは全事業所と合計） */
export function orderQuotesTableHtml(data) {
  const list = Array.isArray(data && data.quotes) ? data.quotes : [];
  if (!list.length) return `<p class="order-empty">発注の内容（見積もり）の記録がありません。お手数ですが、タダカヨの担当者へお問い合わせください。</p>`;
  let total = 0, self = 0;
  const rows = list.map((q) => {
    const a = q.amounts || {};
    total += Number(a.totalIncl) || 0; self += Number(a.selfPay) || 0;
    return `<tr>
        <td data-h="見積番号・版"><b>${esc(q.estNo || "")}</b><br><span class="sub">第${esc(q.version ?? "—")}版</span></td>
        <td data-h="事業所">${esc([q.corpName, q.officeName].filter(Boolean).join(" "))}</td>
        <td data-h="品目・台数">${esc(itemsText(q.items))}</td>
        <td data-h="金額（税込）" class="num"><b>${yen(a.totalIncl)}</b><br><span class="sub">助成金充当 ${yen(a.grantAmt)}／自己負担 ${yen(a.selfPay)}</span></td>
      </tr>`;
  }).join("");
  const foot = list.length > 1
    ? `<tfoot><tr><th colspan="3" class="r">合計（${list.length}事業所）</th><td class="num" data-h="合計"><b>${yen(total)}</b><br><span class="sub">自己負担 ${yen(self)}</span></td></tr></tfoot>`
    : "";
  return `<table class="order-table">
      <thead><tr><th>見積番号・版</th><th>事業所</th><th>品目・台数</th><th>金額（税込）</th></tr></thead>
      <tbody>${rows}</tbody>${foot}
    </table>`;
}

/**
 * 発注の承諾書の画面の HTML（読むだけ）。docHtml は consent-sign.js の documentHtml（条文の部分）の結果。
 * @param {object} data   consentRequests/{token} のデータ
 * @param {object} docu   parseEmbeddedDocument の結果
 * @param {string} docHtml
 */
export function orderConsentPageHtml(data, docu, docHtml) {
  const info = orderSignInfo(data);
  return `
    <div class="donecard">
      <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg></div>
      <div class="t">この承諾書（発注書を兼ねます）は署名済みです</div>
      <div class="d">発注の内容と署名の記録は下記のとおりです。このページは同じアドレスでいつでも開けます。</div>
      <div class="signrow">${orderSignRowHtml(data)}</div>
      ${data && data.retakeOf ? `<p class="keepnote">この承諾書は、受注のあとで見積もりの内容が変わったため、あらためていただいたものです。</p>` : ""}
      <div class="done-actions no-print">
        <button class="ghost" type="button" id="printBtn">この承諾書を印刷 / PDF保存</button>
      </div>
      <p class="keepnote no-print">控えが必要な場合は、印刷またはPDF保存のうえ保管してください。</p>
    </div>

    ${docHtml}

    <section class="order-box">
      <h2>本書に表示する見積書（発注の内容）</h2>
      ${orderQuotesTableHtml(data)}
      <p class="order-note">見積書の内容（品目・台数・金額）を変更する場合は、変更後の見積書について、あらためて本書による確認をお願いします（第6条）。</p>
    </section>

    <div class="consent-box" style="border-style:solid">
      <div class="lead">承諾文</div>
      <p class="statement" style="margin-bottom:12px">${esc(docu.consent_statement)}</p>
      <div class="signrow" style="border-top:none;padding-top:0;justify-content:flex-start">
        ${orderSignRowHtml(data)}
        <span style="color:var(--muted);font-size:12.5px">（${esc(info.methodNote)}・条文の版 ${esc(docu.version)}）</span>
      </div>
    </div>

    <p class="issuer">${esc(docu.issuer)}${docu.issuer_detail ? `<br>${esc(docu.issuer_detail)}` : ""}</p>
  `;
}
