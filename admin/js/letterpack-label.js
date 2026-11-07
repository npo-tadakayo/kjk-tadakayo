// レターパックの宛名ラベル（縦14.5cm×横12.5cm の宛名枠＋梱包の確認）を描く部品（2026-11-01 倉庫の統合で共通化）。
// 出荷の宛名印刷（letterpack-print.js）と倉庫の宛名印刷（warehouse-print.js）が同じものを使う。
// 見た目は /css/letterpack-label.css。宛名枠の中の並びは郵便局の依頼で お届け先 → ご依頼主 → 品名（台数）。
import { shipQtySummary } from "/js/ship-flow.js";

export const TYPE_LABEL = { light: "レターパックライト", plus: "レターパックプラス" };

function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

export function renderLabel(s, sender, type){
  sender = sender || {};
  const q = shipQtySummary(s.items); // 台数は宛名枠の品名の欄と梱包の確認に大きく出す（2026-10-30）
  const head = TYPE_LABEL[type] || "レターパック（種類が未選択です）";
  const postal = s.postal || s.postalCode || ""; // 倉庫の画面のデータは postalCode
  const zip = postal ? `〒${esc(postal)}` : "〒";
  const person = String(s.contactName || "").trim();
  const fromPostal = sender.postal || sender.postalCode || "";
  const fromZip = fromPostal ? `〒${esc(fromPostal)} ` : "";
  return `
    <div class="label">
      <div class="label-head"><span>${esc(head)}</span><small>宛名ラベル</small></div>
      <div class="to">
        <div class="sec">お届け先</div>
        <div class="zip">${zip}</div>
        <div class="addr">${esc(s.address || "")}</div>
        ${s.company ? `<div class="org">${esc(s.company)}</div>` : ""}
        ${s.officeName ? `<div class="org">${esc(s.officeName)}</div>` : ""}
        <div class="name">${person ? esc(person) : "ご担当者"}<span class="sama">様</span></div>
        <div class="tel">TEL ${esc(s.phone || "")}</div>
      </div>
      <div class="from">
        <div class="sec">ご依頼主</div>
        <div>${fromZip}${esc(sender.address || "")}</div>
        <div class="from-name">${esc(sender.name || "")}</div>
        ${sender.phone ? `<div>TEL ${esc(sender.phone)}</div>` : ""}
      </div>
      <div class="item">
        <div class="sec">品名</div>
        <div class="item-row">
          <div class="item-name"><b>カードリーダー</b><br>（介護情報基盤 マイナ資格確認用）<br>${q.lines.map((l)=>`${esc(l.label)}${q.lines.length > 1 ? ` × ${l.qty}` : ""}`).join("<br>")}</div>
          <div class="item-qty" aria-label="台数"><div class="num" data-qty-total>${q.total}<small>台</small></div></div>
        </div>
        <div class="item-so">出荷番号 ${esc(s.soNumber || "")}</div>
      </div>
    </div>
    <div class="cut"><span>✂ 上の枠（縦14.5cm×横12.5cm）を外枠に沿って切り取り、レターパックの宛名面の枠に貼ってください</span></div>
    <div class="pack">
      <div class="pack-title">梱包の確認（貼らない）<span>出荷番号 ${esc(s.soNumber || "")}${s.shipDate ? ` ／ 出荷日 ${esc(s.shipDate)}` : ""}${s.originLocationName ? ` ／ 出荷元 ${esc(s.originLocationName)}` : ""}</span></div>
      <div class="pack-qty">
        <div class="big">${q.total}<small>台</small></div>
        <div class="what"><b>${esc(q.detail || "—")}</b><br>この台数だけ入れてください。ほかの出荷と取り違えないように注意。</div>
      </div>
      <ul class="checks">
        <li><span class="box" aria-hidden="true"></span>箱に入れた台数を数えた（<b>${q.total}台</b>）</li>
        <li><span class="box" aria-hidden="true"></span>品番が合っている（${esc(q.lines.map((l)=>l.label).join("・") || "—")}）</li>
        <li><span class="box" aria-hidden="true"></span>宛名の事業所名と出荷番号が、この紙と合っている</li>
        <li><span class="box" aria-hidden="true"></span>レターパックの種類が合っている（${esc(TYPE_LABEL[type] || "未選択")}）</li>
      </ul>
      <div class="sign"><div>確認した人：</div><div>日付：　　月　　日</div></div>
    </div>`;
}

// 宛名枠は 145×125mm 固定（overflow:hidden）。住所・法人名・事業所名が長いと品名・台数が切れて印刷されるので、
// お届け先とご依頼主を収まるまで縮める（最小 70%）。それでも収まらなければ false（警告を出し、印刷前に確認）。Codex 指摘 #33
export function fitLabel(el){
  if (!el) return true;
  const parts = el.querySelectorAll(".to, .from");
  const last = el.querySelector(".item-so");
  el.classList.add("measure");
  const fits = () => last.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom - 2;
  let z = 1;
  parts.forEach((x) => { x.style.zoom = ""; });
  while (!fits() && z > 0.7) {
    z = Math.round((z - 0.05) * 100) / 100;
    parts.forEach((x) => { x.style.zoom = String(z); });
  }
  const ok = fits();
  el.classList.remove("measure");
  return ok;
}

