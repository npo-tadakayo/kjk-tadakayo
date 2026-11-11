// ボタンの説明の吹き出し（admin/js/tooltip.js・2026-11-12）のテスト。node scripts/test-tooltip.mjs
// ①位置の計算など純粋な部分 ②案件詳細の画面のボタン（HTML と、後から描く JS）に data-tip が付いているか
// 依存なし。ブラウザの部分（イベント）は読み込むだけで動かさない（document が無いので何もしない）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  placeTip, movedTooFar, withDescToken, tipText, DESC_PREFIX,
  SHOW_DELAY_MS, LONG_PRESS_MS,
} from "../admin/js/tooltip.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); throw e; }
};

const VP = { width: 1280, height: 800 };
const TIP = { width: 200, height: 60 };

// ---- ① 位置の計算 ----
t("上に余裕があれば、ボタンの上・中央に出す", () => {
  const p = placeTip({ anchor: { left: 500, top: 300, width: 100, height: 30 }, tip: TIP, viewport: VP });
  assert.equal(p.placement, "top");
  assert.equal(p.top, 300 - 8 - 60);
  assert.equal(p.left, 550 - 100);
  assert.equal(p.arrowX, 100);
});

t("上に入らなければ下に出す", () => {
  const p = placeTip({ anchor: { left: 500, top: 20, width: 100, height: 30 }, tip: TIP, viewport: VP });
  assert.equal(p.placement, "bottom");
  assert.equal(p.top, 20 + 30 + 8);
});

t("左端のボタンでも画面の左からはみ出さない（矢印はボタンの中心を指す）", () => {
  const p = placeTip({ anchor: { left: 2, top: 300, width: 40, height: 30 }, tip: TIP, viewport: VP });
  assert.equal(p.left, 8);
  assert.equal(p.arrowX, 22 - 8);
  assert.ok(p.left >= 8 && p.left + TIP.width <= VP.width - 8);
});

t("右端のボタンでも画面の右からはみ出さない", () => {
  const p = placeTip({ anchor: { left: 1250, top: 300, width: 28, height: 30 }, tip: TIP, viewport: VP });
  assert.equal(p.left + TIP.width, VP.width - 8);
  assert.ok(p.arrowX <= TIP.width - 12);
});

t("矢印は吹き出しの角から 12px 以上内側", () => {
  const p = placeTip({ anchor: { left: 0, top: 300, width: 4, height: 30 }, tip: TIP, viewport: VP });
  assert.equal(p.arrowX, 12);
});

t("スマホの幅（375px）で、幅いっぱい近い吹き出しでも左右に収まる", () => {
  const vp = { width: 375, height: 700 };
  const tip = { width: 359, height: 90 };
  for (const left of [0, 100, 300, 340]) {
    const p = placeTip({ anchor: { left, top: 400, width: 35, height: 44 }, tip, viewport: vp });
    assert.ok(p.left >= 8 && p.left + tip.width <= vp.width - 8, `left=${left} → ${p.left}`);
  }
});

t("上下どちらにも入らないときは広い方に出し、縦も画面の中に収める", () => {
  const vp = { width: 375, height: 200 };
  const tip = { width: 200, height: 150 };
  const p = placeTip({ anchor: { left: 100, top: 120, width: 50, height: 30 }, tip, viewport: vp });
  assert.equal(p.placement, "top");             // 上 112px ＞ 下 42px
  assert.ok(p.top >= 8 && p.top + tip.height <= vp.height - 8 + 0.5);
});

t("吹き出しが画面より広くても左端（余白 8px）から置く", () => {
  const p = placeTip({ anchor: { left: 100, top: 300, width: 50, height: 30 }, tip: { width: 500, height: 50 }, viewport: { width: 320, height: 600 } });
  assert.equal(p.left, 8);
});

// ---- 長押し・読み上げの説明・表示する文 ----
t("長押しの途中で 10px を超えて動いたらスクロールとみなす", () => {
  assert.equal(movedTooFar(3, 4), false);   // 5px
  assert.equal(movedTooFar(6, 8), false);   // 10px ちょうどは許す
  assert.equal(movedTooFar(8, 8), true);    // 約11.3px
  assert.equal(movedTooFar(0, -30), true);
});

t("長押しは約0.5秒、マウスは少し待ってから出す", () => {
  assert.ok(LONG_PRESS_MS >= 400 && LONG_PRESS_MS <= 700);
  assert.ok(SHOW_DELAY_MS >= 200 && SHOW_DELAY_MS <= 800);
});

t("aria-describedby: ほかの id は残し、古い説明の id は入れ替える", () => {
  assert.equal(withDescToken(null, `${DESC_PREFIX}1`), `${DESC_PREFIX}1`);
  assert.equal(withDescToken("hint-a", `${DESC_PREFIX}2`), `hint-a ${DESC_PREFIX}2`);
  assert.equal(withDescToken(`hint-a ${DESC_PREFIX}1  hint-b`, `${DESC_PREFIX}3`), `hint-a hint-b ${DESC_PREFIX}3`);
  assert.equal(withDescToken(`${DESC_PREFIX}3`, `${DESC_PREFIX}3`), `${DESC_PREFIX}3`);
});

t("title が付いているボタンは、その文を吹き出しの2行目に出す（ブラウザの小窓と二重にしない）", () => {
  assert.equal(tipText("押すと保存します。", null), "押すと保存します。");
  assert.equal(tipText("押すと保存します。", "閲覧のみの権限では操作できません"), "押すと保存します。\n（閲覧のみの権限では操作できません）");
  assert.equal(tipText("同じ文", "同じ文"), "同じ文");
  assert.equal(tipText("", "title だけ"), "title だけ");
});

// ---- ② 案件詳細の画面のボタンに data-tip が付いているか ----
// テンプレート文字列の ${…} の中の > で切れないように、開きタグを1つずつ取り出す
function openTags(src, re) {
  const tags = [];
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "$" && src[i + 1] === "{") { depth++; i++; continue; }
      if (depth && src[i] === "}") { depth--; continue; }
      if (!depth && src[i] === ">") break;
    }
    tags.push(src.slice(m.index, i + 1));
  }
  return tags;
}
const buttonTags = (src) => openTags(src, /<button\b/g);
const btnLinkTags = (src) => openTags(src, /<a\b(?=[^>]*\bclass="btn\b)/g);
const hasTip = (tag) => /\bdata-tip="[^"]{8,}"/.test(tag) || /\$\{tipAttr\}/.test(tag);

const FILES = [
  "admin/case-detail.html",
  "admin/js/case-detail.js",
  "admin/js/quote-admin.js",
  "admin/js/consent-admin.js",
  "admin/js/pre-guide.js",
  "admin/js/support-checklist.js",
  "admin/js/case-detail-util.js",
];

for (const f of FILES) {
  const src = read(f);
  t(`${f}: すべてのボタン（<button>・a.btn）に data-tip がある`, () => {
    const tags = [...buttonTags(src), ...btnLinkTags(src)];
    assert.ok(tags.length > 0, "ボタンが見つからない");
    const missing = tags.filter((x) => !hasTip(x));
    assert.deepEqual(missing, [], `data-tip が無い: \n${missing.join("\n")}`);
  });
  t(`${f}: 説明は title 属性で出さない（data-tip と二重に出るため）`, () => {
    const withTitle = [...buttonTags(src), ...btnLinkTags(src)].filter((x) => /\stitle="/.test(x));
    assert.deepEqual(withTitle, []);
  });
}

t("押すと結果が大きいボタンには、取り消せるか・何が残るかを書いている", () => {
  const html = read("admin/case-detail.html");
  const cd = read("admin/js/case-detail.js");
  const qa = read("admin/js/quote-admin.js");
  const ca = read("admin/js/consent-admin.js");
  const pg = read("admin/js/pre-guide.js");
  const sc = read("admin/js/support-checklist.js");
  const tipOf = (src, marker) => {
    const tag = [...buttonTags(src), ...btnLinkTags(src), ...openTags(src, /<select\b/g)].find((x) => x.includes(marker));
    assert.ok(tag, `見つからない: ${marker}`);
    const m = tag.match(/data-tip="([^"]+)"/);
    assert.ok(m, `data-tip が無い: ${marker}`);
    return m[1];
  };
  const must = [
    [html, 'id="archiveBtn"', /対象外を解除/],
    [html, 'id="deleteBtn"', /元に戻せません/],
    [html, 'id="shipFromCaseBtn"', /出荷/],
    [html, 'id="copyCaseBtn"', /コピーしません/],
    [html, 'id="statusSelect"', /対応記録/],
    [html, 'id="sendMailBtn"', /取り消せません/],
    [html, 'id="archiveConfirmBtn"', /対象外/],
    [cd, "data-merge=", /元に戻せません/],
    [cd, "sess-delete", /元に戻せません/],
    [qa, "data-accept-id=", /Chat/],
    [qa, 'id="acceptSubmit"', /受注確定/],
    [qa, "data-resend-id=", /取り消せません/],
    [ca, 'id="consentMailSend"', /取り消せません/],
    [ca, 'id="consentCancelBtn"', /元に戻せません/],
    [pg, 'id="pgSend"', /取り消せません/],
    [sc, 'id="sc-copy-run"', /置き換えます/],
    [sc, 'id="sc-onsite-confirm"', /対応記録/],
  ];
  for (const [src, marker, re] of must) assert.match(tipOf(src, marker), re, marker);
});

t("出荷のお金の流れのボタン（請求書を出す など）にも説明がある", () => {
  const cd = read("admin/js/case-detail.js");
  for (const label of ["出荷を依頼する", "請求書を出す", "入金を記録する", "領収証を出す"]) {
    assert.match(cd, new RegExp(`"${label}": "[^"]{10,}"`), label);
  }
  // shipNextAction が返すボタン（待ちの案内 waiting は文だけでボタンではない）と説明の表がずれていないか
  const labels = [...cd.matchAll(/return \{ label: "([^"]+)", icon: "[^"]+", url: [^,]+, external: (?:true|false) \};/g)].map((m) => m[1]);
  assert.equal(labels.length, 4);
  for (const l of labels) assert.match(cd, new RegExp(`"${l}": "`), `説明が無い: ${l}`);
});

t("案件詳細の画面で吹き出しの部品を読み込んでいる", () => {
  const html = read("admin/case-detail.html");
  assert.match(html, /<script src="\/js\/tooltip\.js" type="module"><\/script>/);
  const css = read("admin/css/crm.css");
  assert.match(css, /\.kjk-tip \{/);
  assert.match(css, /background: var\(--color-ink\);/);
});

t("説明文に、HTML を壊す文字（\" < >）や改行を入れていない", () => {
  for (const f of FILES) {
    const src = read(f);
    for (const m of src.matchAll(/data-tip="([^"]*)"/g)) {
      assert.ok(!/[<>\n]/.test(m[1]), `${f}: ${m[1]}`);
    }
  }
});

console.log(`ok ${n} tests`);
