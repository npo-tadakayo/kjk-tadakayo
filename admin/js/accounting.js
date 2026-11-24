// 経理への期末報告（admin/accounting.html・管理者だけ・2026-11-24）。
// 集計は accounting-rules.js（純粋関数・scripts/test-accounting-rules.mjs）。この画面は読むだけで、何も書き込まない。
// 本番の記録だけを読む（練習モード中でも getProdFirestore。練習データ _practiceBy は集計側でも除く）。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getProdFirestore, collection, getDocs, isPracticeMode } from "/js/fs.js";
import { gateRole } from "/js/role.js";
import { buildReport, reportCsvFiles, defaultPeriodStart, DEFAULT_CUTOFF, UNSET_LOCATION, IN_TRANSIT_LOCATION } from "/js/accounting-rules.js";
import { accountingPdfHtml, ACCOUNTING_PDF_OPTIONS } from "/js/accounting-pdf.js";
import { zipStore } from "/js/zip-store.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const prod = getProdFirestore(app);

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
const yen = (n) => (n == null ? "未確認" : `${Number(n) < 0 ? "−" : ""}¥${Math.abs(Number(n) || 0).toLocaleString("ja-JP")}`);
const qty = (n) => `${Number(n || 0).toLocaleString("ja-JP")}台`;
const neg = (n) => (Number(n) < 0 ? ' class="num acc-neg"' : ' class="num"');
function toast(m) { const t = $("toast"); t.textContent = m; t.style.display = "block"; clearTimeout(t._t); t._t = setTimeout(() => (t.style.display = "none"), 2500); }

let rep = null;
let data = null;

async function loadAll() {
  const names = ["shipments", "purchaseOrders", "inventoryMovements", "locations", "products"];
  const snaps = await Promise.all(names.map((c) => getDocs(collection(prod, c))));
  const rows = snaps.map((s) => s.docs.map((d) => ({ _id: d.id, ...d.data() })));
  return { shipments: rows[0], purchaseOrders: rows[1], movements: rows[2], locations: rows[3], products: rows[4].map((p) => ({ ...p, id: p._id })) };
}

// ===== 描画 =====
function table(head, body, foot) {
  return `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th${h.startsWith("#") ? ' class="num"' : ""}>${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead>
    <tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}</table></div>`;
}
function section(no, title, sub, inner, csvKey) {
  return `<div class="card acc-sec" id="sec${no}">
    <div class="card-header" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <h2>${no}. ${esc(title)}</h2>${csvKey ? `<button class="btn btn-secondary acc-csv" type="button" data-csv="${csvKey}"><i class="ti ti-download" aria-hidden="true"></i>CSV</button>` : ""}
    </div>
    ${sub ? `<p class="acc-note" style="margin-top:12px">${sub}</p>` : ""}${inner}</div>`;
}
const empty = (msg) => `<div class="acc-empty">${esc(msg)}</div>`;

function render() {
  const r = rep;
  const sum = r.summary.map((s) => `<tr><td>${s.no}</td><td>${esc(s.title)}</td>
    <td class="num">${s.count == null ? "未確認" : `${s.count.toLocaleString("ja-JP")}${s.unit || "件"}`}</td>
    <td${neg(s.amount)}>${yen(s.amount)}</td><td class="acc-sub">${esc(s.note)}</td></tr>`).join("");
  let html = section("", `要約（期首 ${r.start} 〜 締め日 ${r.cutoff}）`, "",
    table(["", "項目", "#件数・台数", "#金額", "メモ"], sum)).replace('<h2>. ', "<h2>");

  // 1 売上
  const S = r.sales;
  const mrow = (label, m) => `<tr><td>${esc(label)}</td><td class="num">${m.count}件</td><td class="num">${yen(m.total)}</td><td class="num">${yen(m.tax)}</td>
    <td class="num">${m.direct.count}件 ${yen(m.direct.total)}</td><td class="num">${m.partner.count}件 ${yen(m.partner.total)}</td></tr>`;
  html += section(1, "売上（期中）", "請求日（請求済にした日）が期首〜締め日の出荷です。直接＝事業所への請求、直送＝認定事業者への請求。金額は税込。請求したあとにキャンセルにした出荷は、ここ（過去の月の売上）からも消えます（経理へ報告済みの数字と合わないときは、キャンセルした出荷を確かめてください）。",
    S.count ? table(["月", "#件数", "#税込合計", "#うち消費税", "#直接（事業所）", "#直送（認定事業者）"],
      S.byMonth.map((m) => mrow(m.month, m)).join(""), `<tr class="acc-tot">${mrow("合計", S).replace(/^<tr>|<\/tr>$/g, "")}</tr>`)
      + `<details style="margin:0 16px 14px"><summary class="acc-sub" style="cursor:pointer">明細（${S.count}件）</summary>`
      + table(["請求日", "出荷番号", "請求先", "種類", "#税込", "#うち消費税"], S.rows.map((x) => `<tr><td>${esc(x.invoicedAt)}</td><td>${esc(x.soNumber)}</td>
        <td>${esc(x.billTo)}</td><td>${esc(x.kind)}</td><td class="num">${yen(x.total)}</td><td class="num">${yen(x.tax)}</td></tr>`).join("")) + `</details>`
      : empty("期中の売上はありません"), "sales");

  // 2 未収金
  const R = r.receivables;
  html += section(2, "未収金（売掛金）", "締め日までに請求し、締め日までの入金・返金・過入金の充当を差し引いても残っているお金です。「実際の入金日」はいまの記録で全額入金された日（締め日後に入金されたもの）。"
    + (R.undated.length ? `<br><strong>入金の日付が分からないため除いた出荷 ${R.undated.length}件</strong>: ${esc(R.undated.join("・"))}（入金の記録に日付を入れてから数え直してください）` : ""),
    R.count ? table(["出荷番号", "請求日", "請求先", "#請求額", "#締め日までの入金", "#残高", "支払期限", "実際の入金日"],
      R.rows.map((x) => `<tr><td>${esc(x.soNumber)}</td><td>${esc(x.invoicedAt)}</td><td>${esc(x.billTo)}</td><td class="num">${yen(x.billed)}</td>
        <td class="num">${yen(x.paid)}</td><td class="num">${yen(x.balance)}</td><td>${esc(x.dueDate)}</td><td>${esc(x.paidDate || "—")}</td></tr>`).join(""),
      `<tr class="acc-tot"><td colspan="5">合計 ${R.count}件</td><td class="num">${yen(R.total)}</td><td colspan="2"></td></tr>`)
      : empty("締め日時点の未収金はありません"), "receivables");

  // 3 未請求出荷
  const U = r.unbilled;
  html += section(3, "請求していない出荷", `締め日までに発送したのに、締め日の時点で請求していない出荷です（金額は見込み・税込）。締め日後に請求済 ${U.later.count}件 ${yen(U.later.total)}／いまも未請求 ${U.still.count}件 ${yen(U.still.total)}。`
    + (U.paidNoInvoice.length ? `<br><strong>入金済なのに請求日が空のため除いた出荷 ${U.paidNoInvoice.length}件</strong>: ${esc(U.paidNoInvoice.join("・"))}` : ""),
    U.count ? table(["出荷番号", "出荷日", "請求先", "種類", "#見込み金額", "区分", "請求日"],
      U.rows.map((x) => `<tr><td>${esc(x.soNumber)}</td><td>${esc(x.shipDate)}</td><td>${esc(x.billTo)}</td><td>${esc(x.kind)}</td><td class="num">${yen(x.total)}</td>
        <td>${x.later ? "締め日後に請求済" : '<span class="badge badge-4">いまも未請求</span>'}</td><td>${esc(x.invoicedAt || "—")}</td></tr>`).join(""),
      `<tr class="acc-tot"><td colspan="4">合計 ${U.count}件</td><td class="num">${yen(U.total)}</td><td colspan="2"></td></tr>`)
      : empty("該当する出荷はありません"), "unbilled");

  // 4 在庫
  const I = r.inventory;
  const iNote = [`締め日時点の保管場所別の台数です。在庫の記録を積み上げて数え、発注の入荷は「実際に届いた日」で数えます（${I.adjusted}件を届いた日で数えました）。金額＝台数 × 仕入単価（発注書の単価）。`];
  if (I.unset) iNote.push(`「${UNSET_LOCATION}」は保管場所を決めずに記録した分です${I.unset < 0 ? "（マイナスは記録のずれ。保管場所へ割り当てた台数が、未設定の記録より多い）" : ""}。`);
  if (I.transit) iNote.push(`「${IN_TRANSIT_LOCATION}」は保管場所の間で送っている途中の台数です。`);
  if (I.missingCost.length) iNote.push(`仕入単価が分からない品目: ${I.missingCost.join("・")}（金額に入れていません）。`);
  html += section(4, "在庫（棚卸）", esc(iNote.join("")),
    I.rows.length ? table(["保管場所", "品目", "#台数", "#仕入単価（発注書の単価）", "#金額"],
      I.rows.map((x) => `<tr><td>${esc(x.location)}</td><td>${esc(x.name)}<div class="acc-sub">${esc(x.sku)}</div></td><td${neg(x.qty)}>${qty(x.qty)}</td>
        <td class="num">${x.unitCost == null ? "—" : yen(x.unitCost)}</td><td${neg(x.amount)}>${x.amount == null ? "—" : yen(x.amount)}</td></tr>`).join(""),
      `<tr class="acc-tot"><td colspan="2">合計</td><td class="num">${qty(I.total)}</td><td></td><td class="num">${yen(I.amount)}</td></tr>`)
      : empty("締め日時点の在庫はありません"), "inventory");

  // 5 未着品
  const O = r.openOrders;
  html += section(5, "届いていない発注（未着品・発注残）", `締め日までに発注し、締め日の時点でまだ届いていない発注です。先方出荷済み・運送中 ${O.inTransit.count}件 ${qty(O.inTransit.qty)}／未出荷 ${O.notShipped.count}件 ${qty(O.notShipped.qty)}。金額は税別（品代＋送料）。`
    + (O.arrivedUnregistered.count ? `<br><strong>届いたが入荷登録前 ${O.arrivedUnregistered.count}件 ${qty(O.arrivedUnregistered.qty)}</strong>: 締め日までに届いているのに入荷登録していないため、在庫の表に入っていません。入荷登録をしてから数え直してください。` : ""),
    O.count ? table(["発注番号", "発注日", "区分", "先方出荷日", "到着日", "届け先", "#台数", "#金額"],
      O.rows.map((x) => `<tr><td>${esc(x.poNumber)}</td><td>${esc(x.orderDate)}</td><td>${esc(x.state)}</td><td>${esc(x.supplierShipDate || "—")}</td>
        <td>${esc(x.arrivedDate || "—")}${x.arrivalBasis ? `<div class="acc-sub">${esc(x.arrivalBasis)}</div>` : ""}</td><td>${esc(x.arrivedTo)}${x.dropship ? '<div class="acc-sub">直送</div>' : ""}</td>
        <td class="num">${qty(x.qty)}</td><td class="num">${yen(x.amount)}</td></tr>`).join(""),
      `<tr class="acc-tot"><td colspan="6">合計 ${O.count}件</td><td class="num">${qty(O.qty)}</td><td class="num">${yen(O.amount)}</td></tr>`)
      : empty("届いていない発注はありません"), "openOrders");

  // 6 仕入
  const P = r.purchases;
  html += section(6, "仕入（期中）", "届いた日（無ければ入荷登録の日、それも無ければ発注日）が期首〜締め日の発注です。品代と送料は分けています（どちらも税別・発注書の金額）。",
    P.count ? table(["発注番号", "発注日", "仕入の日", "日付の根拠", "届け先", "#台数", "#品代", "#送料"],
      P.rows.map((x) => `<tr><td>${esc(x.poNumber)}</td><td>${esc(x.orderDate)}</td><td>${esc(x.date)}</td><td class="acc-sub">${esc(x.dateBasis)}</td>
        <td>${esc(x.arrivedTo)}${x.dropship ? '<div class="acc-sub">直送</div>' : ""}</td><td class="num">${qty(x.qty)}</td><td class="num">${yen(x.goods)}</td><td class="num">${yen(x.shippingFee)}</td></tr>`).join(""),
      `<tr class="acc-tot"><td colspan="5">合計 ${P.count}件</td><td class="num">${qty(P.qty)}</td><td class="num">${yen(P.goods)}</td><td class="num">${yen(P.shippingFee)}</td></tr>`)
      : empty("期中の仕入はありません"), "purchases");

  // 7 買掛金
  const Y = r.payables;
  html += section(7, "仕入先への未払い（買掛金）", Y.recorded ? "締め日までに届いた発注の金額（税別）から、締め日までに支払った額を引いた残りです。" : "",
    !Y.recorded ? `<div class="acc-empty"><strong>支払いの記録は未登録</strong>です。仕入先への支払いをこの CRM に記録していないため、未払いの一覧と金額は「未確認」です（経理の帳簿で確かめてください）。</div>`
      : Y.count ? table(["発注番号", "仕入の日", "#金額", "#締め日までの支払い", "#未払い", "支払った日"],
        Y.rows.map((x) => `<tr><td>${esc(x.poNumber)}</td><td>${esc(x.date)}</td><td class="num">${yen(x.owed)}</td><td class="num">${yen(x.paid)}</td><td class="num">${yen(x.balance)}</td><td>${esc(x.paidDate || "—")}</td></tr>`).join(""),
        `<tr class="acc-tot"><td colspan="4">合計 ${Y.count}件</td><td class="num">${yen(Y.total)}</td><td></td></tr>`)
      : empty("締め日時点の未払いはありません"), "");

  // 8 返金・過入金
  const F = r.refunds;
  const frows = [
    ...F.refunds.map((x) => ["返金", x.date, x.soNumber, x.billTo, x.amount, x.method]),
    ...F.credits.map((x) => ["過入金の充当", x.date, x.soNumber, x.billTo, x.amount, x.from ? `充当元 ${x.from}` : ""]),
    ...F.overpaid.map((x) => ["締め日時点の過入金（未返金・未充当）", x.date, x.soNumber, x.billTo, x.amount, ""]),
  ];
  html += section(8, "返金・過入金", "締め日までの返金と、過入金を次の請求に充てた分（充てた日で数える）、締め日の時点で多く入金されたまま（返金も充当もしていない）分です。要約の金額はこの3つの合計です。",
    frows.length ? table(["種類", "日付", "出荷番号", "請求先", "#金額", "メモ"],
      frows.map((x) => `<tr><td>${esc(x[0])}</td><td>${esc(x[1])}</td><td>${esc(x[2])}</td><td>${esc(x[3])}</td><td class="num">${yen(x[4])}</td><td class="acc-sub">${esc(x[5])}</td></tr>`).join(""))
      : empty("返金・過入金はありません"), "refunds");

  $("report").innerHTML = html;
  document.querySelectorAll("[data-csv]").forEach((b) => b.addEventListener("click", () => downloadCsv(b.dataset.csv)));
}

// ===== CSV =====
function saveFile(filename, data, type) {
  const blob = new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// 項目ごとの CSV ボタン＝その1本。「CSVをすべて保存」＝7本を1つの ZIP にまとめて1回で保存する
// （続けて7回ダウンロードすると、ブラウザが2本目以降を止める・2026-11-24 preview で確認）
function downloadCsv(key) {
  if (!rep) return;
  const files = reportCsvFiles(rep);
  if (key) {
    const f = files.find((x) => x.key === key);
    if (f) { saveFile(f.filename, f.csv, "text/csv;charset=utf-8"); toast(`${f.filename} を保存しました`); }
    return;
  }
  const zip = zipStore(files.map((f) => ({ name: f.filename, data: f.csv })));
  const name = `経理報告_${rep.cutoff.replace(/-/g, "")}_CSV一式.zip`;
  saveFile(name, zip, "application/zip");
  toast(`CSV ${files.length}本を ${name} にまとめて保存しました`);
}

// ===== PDF（A4 縦・要約＋明細）=====
// 中身は accounting-pdf.js（表は列幅を固定して A4 縦の幅に収める）。画面外に組んでから html2pdf に渡す
async function savePdf() {
  if (!rep) return;
  if (typeof window.html2pdf !== "function") { alert("PDFの部品を読み込めませんでした。画面を読み込み直してください"); return; }
  const btn = $("pdfBtn"); btn.disabled = true;
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;width:186mm;background:#fff";
  holder.innerHTML = accountingPdfHtml(rep, new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "));
  document.body.appendChild(holder);
  const sx = window.scrollX, sy = window.scrollY;
  window.scrollTo(0, 0); // 画面を下へスクロールしたままだと白紙になる（invoice-doc.js の buildOnePagePdf と同じ手当て）
  try {
    await window.html2pdf().set(ACCOUNTING_PDF_OPTIONS(rep.cutoff)).from(holder.firstElementChild).save();
    toast("PDF を保存しました");
  } catch (e) { alert(`PDF を作れませんでした: ${e.message}`); }
  finally { window.scrollTo(sx, sy); holder.remove(); btn.disabled = false; }
}

// ===== 集計 =====
async function run(reload) {
  $("runErr").textContent = "";
  let period;
  try {
    period = { cutoff: $("cutoff").value, start: $("start").value };
    buildReport({}, period); // 期間の検査だけ先に
  } catch (e) { $("runErr").textContent = e.message; return; }
  $("loading").style.display = "block"; $("runBtn").disabled = true;
  try {
    if (reload || !data) data = await loadAll();
    rep = buildReport(data, period);
    render();
    $("pdfBtn").disabled = false; $("csvAllBtn").disabled = false;
  } catch (e) {
    $("runErr").textContent = `集計できませんでした: ${e.message}`;
  } finally { $("loading").style.display = "none"; $("runBtn").disabled = false; }
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  if (!(await gateRole(prod, user, { adminOnly: true }))) return;
  $("userEmail").textContent = user.displayName || user.email;
  $("logoutBtn").addEventListener("click", () => signOut(auth).then(() => (location.href = "/index.html")));
  if (isPracticeMode()) $("practiceNote").style.display = "";
  $("cutoff").value = DEFAULT_CUTOFF;
  $("start").value = defaultPeriodStart(DEFAULT_CUTOFF);
  $("cutoff").addEventListener("change", () => { const s = defaultPeriodStart($("cutoff").value); if (s) $("start").value = s; });
  $("runBtn").addEventListener("click", () => run(true));
  $("pdfBtn").addEventListener("click", savePdf);
  $("csvAllBtn").addEventListener("click", () => downloadCsv(""));
  $("gate").style.display = "none"; $("main").style.display = "block";
  run(true);
});
