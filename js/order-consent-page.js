// js/order-consent-page.js — 見積もりページ（mitsumori.html）の「承諾書のサイン＝発注」第2段（2026-11-12）の表示部品。
// 設計: 06_介護情報基盤事業/docs/改善1_承諾書で発注_設計書_20261112.md §4 段2（決定 CRM改善2_計画_20261112.md §2.1 発1・発3・発6）。
//
// ・スイッチ appConfig/settings.orderByConsent がオンのときだけ使う。公開ページは appConfig を読めないので、スイッチの状態・
//   承諾書の条文（v1.2 の全文）・各見積もりの「承諾書に焼き込む形」は、見積もりの登録（webhookMitsumori）の応答で受け取る。
//   **条文の写しはこのページに置かない**（サーバーの正本 functions/consent-document.js をそのまま表示する＝見せた文面と記録する文面が同じ）。
// ・DOM にも通信にも触れない文字列の部品だけ（node でテストできる: scripts/test-order-consent-web.mjs）。
// ・外部の読み込みなし。画面からは window.OrderConsentPage で使う。
(function (root) {
  "use strict";

  // 品番 → 表示名（functions/index.js の PRODUCT_NAMES・admin/js/order-consent.js と同じ。テストで照合）
  var PRODUCT_NAMES = {
    "cir415a-01": "介護情報基盤 汎用カードリーダ CIR415A",
    "cir315a-02": "介護情報基盤 汎用カードリーダ CIR315A（Type-A）",
    "cir315a-04": "介護情報基盤 汎用カードリーダ CIR315A（Type-C）",
  };

  // スイッチがオンのときの画面の文言（オフのときは mitsumori.html の元の文言のまま）
  var TEXT = {
    ctaTitle: "この内容で発注しますか？",
    ctaNote: "次の画面で、お見積もりの内容と<b>承諾書（発注書を兼ねます）</b>をご確認ください。お名前を入れて同意すると、発注（受注確定）になります。"
      + "発注のあとで台数や機種を変える場合は、変更後のお見積書で、あらためて承諾書をご確認いただきます。",
    ctaButton: "この内容で発注へ進む",
    modalTitle: "ご発注の確認（承諾書への同意）",
    nameLabel: "承諾書に同意して発注される方のお名前（フルネーム）",
    nameNote: "ご入力のお名前で、上の承諾書（発注書を兼ねます）に署名したものとして記録します。署名の日時は送信した時刻です。",
    agreeText: "上の承諾書（発注書を兼ねます）の内容、利用規約・個人情報保護方針を確認し、同意して発注します",
    agreeMissing: "承諾書への同意にチェックをお願いします",
    submit: "承諾書に同意して発注する",
    sending: "送信中...",
  };

  function esc(t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function yen(n) { return "¥" + (Number(n) || 0).toLocaleString("ja-JP"); }

  /** 承諾書の条文として表示してよい形か（題名・版・条・同意文がそろっている） */
  function isValidDocument(d) {
    return !!d && typeof d === "object" && typeof d.version === "string" && !!d.version
      && typeof d.title === "string" && Array.isArray(d.sections) && d.sections.length > 0
      && d.sections.every(function (s) { return s && typeof s.title === "string" && typeof s.body === "string"; })
      && typeof d.consent_statement === "string" && !!d.consent_statement;
  }

  /** 見積もり1件の品目の行（「… CIR415A：3台（補助対象 2台＋追加 1台）」）。admin/js/order-consent.js の itemsText と同じ文面 */
  function itemsLines(items) {
    var list = Array.isArray(items) ? items : [];
    return list.map(function (i) {
      var sub = Number(i && i.subsidyQty) || 0, ext = Number(i && i.extraQty) || 0;
      if (sub + ext <= 0) return "";
      return (PRODUCT_NAMES[i.sku] || i.sku) + "：" + (sub + ext) + "台（補助対象 " + sub + "台" + (ext ? "＋追加 " + ext + "台" : "") + "）";
    }).filter(Boolean);
  }

  /**
   * 「本書に表示する見積書（発注の内容）」の HTML。entries は webhookMitsumori が返した consentEntry（承諾書に焼き込む形）。
   * 1件でも欠けていれば null（呼び出し側は申込の画面を開かない）。
   */
  function quotesHtml(entries) {
    var list = Array.isArray(entries) ? entries : [];
    if (!list.length || list.some(function (e) { return !e || !e.estNo || !e.amounts; })) return null;
    var total = 0, grant = 0, self = 0;
    var cards = list.map(function (e) {
      var a = e.amounts || {};
      total += Number(a.totalIncl) || 0; grant += Number(a.grantAmt) || 0; self += Number(a.selfPay) || 0;
      var lines = itemsLines(e.items);
      return '<div class="oc-quote">'
        + '<div class="oc-row"><span class="oc-k">見積番号</span><span class="oc-v"><b>' + esc(e.estNo) + "</b>（第" + esc(e.version) + "版）</span></div>"
        + '<div class="oc-row"><span class="oc-k">事業所</span><span class="oc-v">' + esc([e.corpName, e.officeName].filter(Boolean).join("　")) + "</span></div>"
        + '<div class="oc-row"><span class="oc-k">品目・台数</span><span class="oc-v">' + (lines.length ? lines.map(esc).join("<br>") : "—") + "</span></div>"
        + '<div class="oc-row"><span class="oc-k">金額（税込）</span><span class="oc-v"><b>' + yen(a.totalIncl) + "</b>"
        + '<span class="oc-sub">（うち伴走支援費 ' + yen(a.accompanyFee) + (Number(a.discount) ? "・金額調整 −" + yen(a.discount) : "") + "）</span>"
        + '<br><span class="oc-sub">助成金充当 ' + yen(a.grantAmt) + "　自己負担 " + yen(a.selfPay) + "</span></span></div>"
        + "</div>";
    }).join("");
    var sum = list.length > 1
      ? '<div class="oc-total">合計（' + list.length + "事業所）　<b>" + yen(total) + "</b>（助成金充当 " + yen(grant) + "／自己負担 " + yen(self) + "）</div>"
      : "";
    return '<div class="oc-head">本書に表示する見積書（発注の内容）</div>' + cards + sum
      + '<div class="oc-note">見積書の内容（品目・台数・金額）を変える場合は、「やめる」を押して、お見積もりの入力欄で選び直してください（新しい版のお見積書になります）。</div>';
  }

  /** 承諾書の全文（題名・前文・各条・利用規約とプライバシーポリシーのアドレス・発行者）の HTML */
  function documentHtml(d) {
    if (!isValidDocument(d)) return null;
    var secs = d.sections.map(function (s) {
      return '<section class="oc-sec"><h4>' + esc(s.title) + "</h4><p>" + esc(s.body) + "</p></section>";
    }).join("");
    var links = (d.terms_url ? '利用規約: <a href="' + esc(d.terms_url) + '" target="_blank" rel="noopener noreferrer">' + esc(d.terms_url) + "</a>" : "")
      + (d.privacy_url ? '<br>プライバシーポリシー: <a href="' + esc(d.privacy_url) + '" target="_blank" rel="noopener noreferrer">' + esc(d.privacy_url) + "</a>" : "");
    return '<div class="oc-doc-title">' + esc(d.title) + "</div>"
      + '<div class="oc-doc-ver">条文の版 ' + esc(d.version) + "</div>"
      + (d.preamble ? '<p class="oc-pre">' + esc(d.preamble) + "</p>" : "")
      + secs
      + (links ? '<p class="oc-links">' + links + "</p>" : "")
      + '<div class="oc-statement"><div class="oc-statement-h">確認・承諾</div><p>' + esc(d.consent_statement) + "</p></div>"
      + (d.issuer ? '<p class="oc-issuer">' + esc(d.issuer) + (d.issuer_detail ? "<br>" + esc(d.issuer_detail) : "") + "</p>" : "");
  }

  /** acceptQuote に足す同意の印 */
  function consentPayload(d) { return { agreed: true, version: String((d && d.version) || "") }; }

  /** 承諾書のアドレスとして載せてよいか（サーバーが返した consentUrl。https の /consent?t= だけ） */
  function safeConsentUrl(u) {
    var s = String(u || "");
    return /^https:\/\/[a-z0-9.-]+\/consent\?t=[A-Za-z0-9_-]{16,128}$/.test(s) ? s : "";
  }

  /**
   * 受け付けたあとの表示（承諾書のアドレス入り）。
   * mailed はサーバーの応答（受注確認のメールを送れたか）。false のときだけ「お送りしました」と書かず、担当から連絡すると書く
   * （送れなかったのに「お送りしました」と出さない・2026-11-12 スイッチ前の点検。未指定は従来の文言）。
   * already が true（同じ見積もりの二重送信。サーバーの応答 status:"already"）のときは「すでに受け付けています」と出し、
   * このときはメールを送っていないので「お送りしました」とは書かない（2026-11-12 画面確認 低-4）。
   */
  function doneHtml(p) {
    var o = p || {};
    var url = safeConsentUrl(o.consentUrl);
    var head = o.already
      ? "<b>このご発注（承諾書への同意）は、すでに受け付けています。</b>"
      : "<b>ご発注（承諾書への同意）を受け付けました。</b>";
    var mailLine = o.already ? "" : (o.mailed === false
      ? "受注確認のメールを自動でお送りできませんでした。担当スタッフから、あらためて受注確認のご連絡をいたします。<br>"
      : "受注確認のメールを " + esc(o.email || "") + " 宛にお送りしました。<br>");
    return head + (o.label ? "（" + esc(o.label) + "）" : "") + "<br>"
      + (o.listHtml ? o.listHtml + "<br>" : "")
      + (o.failedHtml ? o.failedHtml + "<br>" : "")
      + (url ? 'ご同意いただいた承諾書は、<a href="' + esc(url) + '" target="_blank" rel="noopener">こちらのアドレス</a>でいつでもご覧いただけます（印刷・PDF保存もできます）。<br>' : "")
      + mailLine
      + "このあと担当スタッフから、カードリーダーの発送と伴走支援の日程についてご連絡します。";
  }

  root.OrderConsentPage = {
    PRODUCT_NAMES: PRODUCT_NAMES, TEXT: TEXT, isValidDocument: isValidDocument, itemsLines: itemsLines,
    quotesHtml: quotesHtml, documentHtml: documentHtml, consentPayload: consentPayload, safeConsentUrl: safeConsentUrl, doneHtml: doneHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);
