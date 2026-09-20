// 合計見積書（法人まとめ）— admin/quote-group-print.html から使う。
//
// 何をするファイルか:
//   同一法人の複数事業所を「まとめて」見積もったとき（quotes.groupId / cases.quoteGroupId が同じ）、
//   事業所ごとの見積書の**最新版**を集めて、法人あての1枚の合計見積書に組み立てる。
//
// 設計の決まり（2026-09-20）:
//   ・グループの「所属」は cases.quoteGroupId で決める（見積もりの版を上げても案件は同じなので、
//     スタッフの改版（reviseQuote / staffCreateQuote）で groupId が引き継がれなくても漏れない）
//   ・各事業所の「最新版」は cases.latestQuoteId。それが無い古いデータは quotes.groupId から
//     superseded 以外の最大 version を採る（保険）
//   ・金額は quotes.amounts を足すだけ。ここで再計算しない（quote-doc.js と同じ方針・正本はサーバ）
//   ・通し番号は振らない。見積番号欄には子の見積番号の範囲（EST-2026-0101〜0104）を出す
//     （法人へ正式に出す「番号付きの書類」にするかは次田さん判断待ち。いまは各見積書のまとめ）
//
// 使い方:
//   import { QUOTE_GROUP_DOC_STYLE, loadQuoteGroupData, renderQuoteGroupDocHtml } from "/js/quote-group-doc.js";
//   const data = await loadQuoteGroupData(db, groupId);
//   el.innerHTML = renderQuoteGroupDocHtml(data);

import { doc, getDoc, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function yen(n) { return `¥${(Number(n) || 0).toLocaleString("ja-JP")}`; }
function toDate(ts) {
  try { const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null); return d && !Number.isNaN(d.getTime()) ? d : null; } catch { return null; }
}
function ymdJp(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" }) : "";
}

const PLAN_SHORT = { houmon: "訪問・通所系", kyojyu: "居住・入所系", other: "その他" };
const PLAN_LABELS = { houmon: "訪問・通所・短期滞在系（居宅介護支援を含む）", kyojyu: "居住・入所系", other: "その他" };
const STATUS_LABELS = { issued: "発行済み", accepted: "申込済み", superseded: "旧版", expired: "期限切れ" };

// ---- Firestore からこのグループに要るものを一括取得 ----
export async function loadQuoteGroupData(db, groupId) {
  const gid = String(groupId || "");
  if (!gid) return null;

  // 1) 所属する案件（正）
  const casesSnap = await getDocs(query(collection(db, "cases"), where("quoteGroupId", "==", gid)));
  let kases = casesSnap.docs.map((d) => ({ _id: d.id, ...d.data() }));

  // 2) グループIDを持つ見積もり（保険・古いデータや案件側の欠落に備える）
  const quotesSnap = await getDocs(query(collection(db, "quotes"), where("groupId", "==", gid)));
  const groupQuotes = quotesSnap.docs.map((d) => ({ _id: d.id, ...d.data() }));

  // 案件が引けなかった caseId を見積もり側から補う
  const knownCaseIds = new Set(kases.map((k) => k._id));
  for (const q of groupQuotes) {
    if (q.caseId && !knownCaseIds.has(q.caseId)) {
      try {
        const cs = await getDoc(doc(db, "cases", q.caseId));
        if (cs.exists()) { kases.push({ _id: cs.id, ...cs.data() }); knownCaseIds.add(cs.id); }
      } catch (_) { /* 読めなければ見積もり側のスナップショットで出す */ }
    }
  }
  if (!kases.length && !groupQuotes.length) return null;

  // 3) 事業所ごとの最新版
  const rows = [];
  for (const kase of kases) {
    let quote = null;
    if (kase.latestQuoteId) {
      try {
        const qs = await getDoc(doc(db, "quotes", kase.latestQuoteId));
        if (qs.exists()) quote = { _id: qs.id, ...qs.data() };
      } catch (_) { quote = null; }
    }
    if (!quote) {
      quote = groupQuotes
        .filter((q) => q.caseId === kase._id && q.status !== "superseded")
        .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))[0] || null;
    }
    if (!quote) continue;
    // 表示順のため: スタッフの改版は groupIndex を持たないので、同じ案件の Web 作成分から引き継ぐ
    if (quote.groupIndex == null) {
      const src = groupQuotes.find((q) => q.caseId === kase._id && q.groupIndex != null);
      if (src) quote = { ...quote, groupIndex: src.groupIndex };
    }
    let office = null;
    try {
      const oid = quote.officeId || kase.officeId;
      if (oid) { const os = await getDoc(doc(db, "offices", oid)); if (os.exists()) office = { _id: os.id, ...os.data() }; }
    } catch (_) { office = null; }
    rows.push({ kase, quote, office });
  }
  // 案件側に無いが見積もりだけある caseId（保険の保険）
  const rowCaseIds = new Set(rows.map((r) => r.kase._id));
  const orphanByCase = new Map();
  for (const q of groupQuotes) {
    if (!q.caseId || rowCaseIds.has(q.caseId) || q.status === "superseded") continue;
    const cur = orphanByCase.get(q.caseId);
    if (!cur || (Number(q.version) || 0) > (Number(cur.version) || 0)) orphanByCase.set(q.caseId, q);
  }
  for (const q of orphanByCase.values()) rows.push({ kase: { _id: q.caseId, corpName: q.corpName, officeName: q.officeName }, quote: q, office: null });

  // 表示順: グループ内の並び（groupIndex）→ 見積番号
  rows.sort((a, b) => {
    const ai = a.quote.groupIndex ?? 999, bi = b.quote.groupIndex ?? 999;
    if (ai !== bi) return ai - bi;
    return String(a.quote.estNo || "").localeCompare(String(b.quote.estNo || ""));
  });

  const corpName = rows.map((r) => r.quote.corpName || r.kase.corpName).find(Boolean) || "";
  const contactName = rows.map((r) => r.quote.contactName || r.kase.contactName).find(Boolean) || "";
  const contactEmail = rows.map((r) => r.quote.contactEmail || r.kase.contactEmail).find(Boolean) || "";
  const contactTel = rows.map((r) => r.kase.contactPhone).find(Boolean) || "";
  return { groupId: gid, corpName, contactName, contactEmail, contactTel, rows };
}

// ---- 合計（quotes.amounts を足すだけ） ----
export function sumGroupAmounts(rows) {
  const keys = ["readers", "accompanyFee", "discount", "extraPartTotal", "totalIncl", "grantAmt", "selfPay"];
  const t = Object.fromEntries(keys.map((k) => [k, 0]));
  let units = 0, extraUnits = 0;
  for (const { quote: q } of rows) {
    const a = q.amounts || {};
    for (const k of keys) t[k] += Number(a[k]) || 0;
    for (const it of (Array.isArray(q.items) ? q.items : [])) {
      units += Number(it?.subsidyQty) || 0;
      extraUnits += Number(it?.extraQty) || 0;
    }
  }
  return { ...t, units, extraUnits };
}

// 見積番号の範囲表示（EST-2026-0101〜0104。連番でなければ列挙）
function estNoRange(rows) {
  const nos = rows.map((r) => r.quote.estNo).filter(Boolean);
  if (!nos.length) return "—";
  if (nos.length === 1) return nos[0];
  const m = nos.map((n) => String(n).match(/^(.*?)(\d+)$/));
  if (m.every(Boolean) && m.every((x) => x[1] === m[0][1])) {
    const nums = m.map((x) => Number(x[2])).sort((a, b) => a - b);
    const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    if (consecutive) return `${m[0][1]}${String(nums[0]).padStart(m[0][2].length, "0")}〜${String(nums[nums.length - 1]).padStart(m[0][2].length, "0")}`;
  }
  return nos.join("、");
}

// ---- 合計見積書のHTML本体（.qdoc 配下。quote-doc.js の体裁を継ぐ） ----
export function renderQuoteGroupDocHtml(data) {
  if (!data || !data.rows?.length) return `<p style="padding:40px;text-align:center;color:var(--color-ink-muted)">まとめ見積もりが見つかりません。</p>`;
  const { corpName, contactName, contactEmail, contactTel, rows } = data;
  const T = sumGroupAmounts(rows);
  const n = rows.length;

  // 日付: 見積日＝最新版の発行日のうち最も新しいもの、有効期限＝最も早いもの
  const issued = rows.map((r) => toDate(r.quote.createdAt)).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const valid = rows.map((r) => toDate(r.quote.validUntil)).filter(Boolean).sort((a, b) => a - b)[0] || null;
  const isExpired = !!(valid && valid.getTime() < Date.now());
  const hasAccepted = rows.some((r) => r.quote.status === "accepted");
  const allAccepted = rows.every((r) => r.quote.status === "accepted");

  const contactLines = [];
  if (contactName) contactLines.push(`ご担当：${esc(contactName)} 様`);
  const tel = [];
  if (contactTel) tel.push(`TEL: ${esc(contactTel)}`);
  if (contactEmail) tel.push(esc(contactEmail));
  if (tel.length) contactLines.push(tel.join(" ／ "));

  const banner = isExpired
    ? `<div class="qdoc-expired-banner"><i class="ti ti-alert-triangle" aria-hidden="true"></i> 含まれる見積書のいずれかが有効期限を過ぎています。お申し込みの際は内容の再確認をお願いします。</div>`
    : "";

  const trs = rows.map((r, i) => {
    const q = r.quote, a = q.amounts || {};
    const units = (q.items || []).reduce((s, it) => s + (Number(it?.subsidyQty) || 0), 0);
    const extra = (q.items || []).reduce((s, it) => s + (Number(it?.extraQty) || 0), 0);
    const st = STATUS_LABELS[q.status] || "";
    const stTag = q.status === "accepted" ? `<span class="qgdoc-tag on">申込済み</span>` : (q.status && q.status !== "issued" ? `<span class="qgdoc-tag">${esc(st)}</span>` : "");
    const service = r.kase?.serviceType || r.office?.serviceType || "";
    return `<tr>
      <td class="c">${i + 1}</td>
      <td><div class="qgdoc-office">${esc(q.officeName || r.kase?.officeName || "（事業所名未登録）")}${stTag}</div>
          <div class="qdoc-sub-note">${esc(q.estNo || "—")}（第${esc(q.version ?? 1)}版）${service ? `　／　${esc(service)}` : ""}</div></td>
      <td>${esc(PLAN_SHORT[q.plan] || q.plan || "—")}</td>
      <td class="c">${units}台${extra ? `<div class="qdoc-sub-note" style="color:#b27800">＋対象外${extra}台</div>` : ""}</td>
      <td class="r">${yen(a.totalIncl)}</td>
      <td class="r">−${yen(a.grantAmt)}</td>
      <td class="r ${Number(a.selfPay) === 0 ? "zero" : "self"}">${yen(a.selfPay)}</td>
    </tr>`;
  }).join("");

  const zeroBadge = T.selfPay === 0 ? `<span class="qdoc-badge-zero">自己負担 ¥0</span>` : "";
  const discountRow = T.discount > 0 ? `<div class="qdoc-total-row sub" style="color:#c02828"><span>金額調整（合計）</span><span>−${yen(T.discount)}</span></div>` : "";
  const extraRow = T.extraPartTotal > 0 ? `<div class="qdoc-total-row sub" style="color:#b27800"><span>補助対象外（自己負担）合計</span><span>${yen(T.extraPartTotal)}</span></div>` : "";
  const plansUsed = [...new Set(rows.map((r) => r.quote.plan))].map((p) => PLAN_LABELS[p] || p).join("／");

  return `
    ${banner}
    <div class="qdoc est-doc-like qgdoc">
      <div class="qdoc-head">
        <div style="flex:0 0 auto">
          <img src="/images/tadakayo_logo.png" alt="タダカヨ" class="qdoc-logo"
               onerror="this.outerHTML='&lt;div class=&quot;qdoc-logo-ph&quot;&gt;特定非営利活動法人タダカヨ&lt;/div&gt;'">
        </div>
        <div class="qdoc-title-wrap"><div class="qdoc-title">合計見積書</div><div class="qgdoc-subtitle">法人まとめ（${n}事業所）</div></div>
        <div class="qdoc-hanko-wrap" aria-hidden="true"></div>
      </div>

      <div class="qdoc-meta">
        <div>
          <div class="qdoc-to-name">${esc(corpName || "（法人名未登録）")}</div>
          <div class="qdoc-to-honorific">御中</div>
          <div class="qdoc-contact">${contactLines.join("<br>")}</div>
        </div>
        <table class="qdoc-info-table">
          <tr><td class="lbl">見積番号</td><td class="val">${esc(estNoRange(rows))}</td></tr>
          <tr><td class="lbl">見積日</td><td class="val">${esc(ymdJp(issued)) || "—"}</td></tr>
          <tr><td class="lbl">有効期限</td><td class="val">${esc(ymdJp(valid)) || "—"}</td></tr>
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

      <p class="qgdoc-lead">下記のとおり、${n}事業所ぶんをまとめてお見積もりいたします。事業所ごとの内訳は、添付の各見積書をご覧ください。</p>

      <table class="qdoc-table qgdoc-table">
        <thead><tr>
          <th class="c" style="width:6%">#</th>
          <th style="text-align:left">事業所（見積番号・版）</th>
          <th style="width:15%">助成区分</th>
          <th class="c" style="width:10%">台数</th>
          <th class="r" style="width:13%">見積額</th>
          <th class="r" style="width:13%">助成金</th>
          <th class="r" style="width:13%">ご負担額</th>
        </tr></thead>
        <tbody>${trs}</tbody>
        <tfoot><tr class="qgdoc-total">
          <td></td><td>合計（${n}事業所）</td><td></td>
          <td class="c">${T.units}台${T.extraUnits ? `<div class="qdoc-sub-note" style="color:#b27800">＋対象外${T.extraUnits}台</div>` : ""}</td>
          <td class="r">${yen(T.totalIncl)}</td><td class="r">−${yen(T.grantAmt)}</td><td class="r self">${yen(T.selfPay)}</td>
        </tr></tfoot>
      </table>

      <div class="qdoc-totals-wrap">
        <div class="qdoc-totals">
          <div class="qdoc-total-row sub"><span>補助対象パート 機器小計（税込・定価）</span><span>${yen(T.readers)}</span></div>
          <div class="qdoc-total-row sub"><span>伴走支援費（税込）</span><span>${yen(T.accompanyFee)}</span></div>
          ${discountRow}
          ${extraRow}
          <div class="qdoc-total-row grand"><span>合計（税込）</span><span>${yen(T.totalIncl)}</span></div>
          <div class="qdoc-total-row sub-grant"><span>介護情報基盤助成金（合計）</span><span>−${yen(T.grantAmt)}</span></div>
          <div class="qdoc-total-row self"><span>法人さまご負担額（自己負担）</span><span>${yen(T.selfPay)}${zeroBadge}</span></div>
        </div>
      </div>

      <div class="qdoc-notes">
        <strong>備考・ご案内</strong><br>
        ・助成区分：<strong>${esc(plansUsed)}</strong>。助成金は<strong>事業所ごと</strong>に、各事業所さまが申請します（タダカヨは申請手続きの支援を行います。代行はいたしません）。<br>
        ・本書の金額はすべて消費税10%を含む税込金額で、添付の各見積書（${esc(estNoRange(rows))}）の最新版を合計したものです。各見積書の内容が変わったときは本書も変わります。<br>
        ・本書の有効期限は、含まれる見積書のうち最も早い期限（<strong>${esc(ymdJp(valid)) || "—"}</strong>）に合わせています。<br>
        ・お申し込みは事業所ごとに承ります。申し込み後も、支援の日程調整の際に台数や機種の変更ができます。
        ${hasAccepted ? `<br>・${allAccepted ? "すべての事業所" : "「申込済み」の事業所"}はお申し込みを受け付けています。` : ""}
      </div>
    </div>`;
}

// quote-doc.js の QUOTE_DOC_STYLE に足す分だけ
export const QUOTE_GROUP_DOC_STYLE = `
.qgdoc .qdoc-totals{width:340px;}
.qgdoc .qdoc-total-row span:first-child{white-space:nowrap;}
.qgdoc .qdoc-total-row.self{font-size:13pt;}
.qgdoc .qdoc-total-row.self span:last-child{white-space:nowrap;}
.qgdoc .qdoc-badge-zero{font-size:8.5pt;padding:1px 8px;}
.qgdoc-subtitle{font-size:10pt;color:#6a5e48;letter-spacing:.1em;margin-top:2px;}
.qgdoc-lead{font-size:10pt;margin:0 0 4mm;}
.qgdoc-table th.c,.qgdoc-table td.c{text-align:center;}
.qgdoc-table th.r,.qgdoc-table td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.qgdoc-table td:nth-child(2){text-align:left;}
.qgdoc-table td.self{font-weight:700;color:#c02828;}
.qgdoc-table td.zero{font-weight:700;color:#1f7a4f;}
.qgdoc-office{font-weight:600;}
.qgdoc-tag{display:inline-block;font-size:8pt;font-weight:600;padding:0 7px;border-radius:10px;margin-left:6px;vertical-align:1px;background:#F1EEE7;color:#7d715b;}
.qgdoc-tag.on{background:#1f7a4f;color:#fff;}
.qgdoc-table tfoot td{border-top:2px solid #111;border-bottom:none;font-weight:700;background:#fafafa;padding:9px 10px;}
.qgdoc-table tbody tr{break-inside:avoid;}
`;
