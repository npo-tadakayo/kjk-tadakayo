// ===== ボタンの説明の吹き出し（2026-11-12 次田さん決定・まず案件詳細の画面から） =====
//
// 使い方: ボタン（や a.btn・select）に data-tip="説明文" を付けるだけ。このファイルを読み込んだ画面で効く。
//   <button class="btn" data-tip="押すと〜します。">…</button>
//
// 出し方:
//   ・マウス: 乗せて少し待つ（SHOW_DELAY_MS）と出る。離すと消える（吹き出しの上にマウスを移しても消えない）
//   ・キーボード: Tab でフォーカスすると出る。フォーカスが外れると消える
//   ・Esc で消える（吹き出しが出ているときの Esc は吹き出しを消すだけに使う。もう一度 Esc で画面の動き）
//   ・スマホ・タブレット（指で触る端末）: 長押し（LONG_PRESS_MS）で出る。ほかを触ると消える。
//     長押しで出したときは、そのあとに来るクリックを発火させない（普通のタップはそのままボタンが押せる）
//   ・後から JS で描かれるボタンにも効くよう、イベントは document で拾う（委譲）
//
// 読み上げ: data-tip の文は、画面の外の隠れた要素（#kjk-tip-descs の中）に置き、
//   ボタンの aria-describedby からつなぐ（吹き出しを出す前から説明として読める）。
//   吹き出しそのものは aria-hidden（同じ文を2回読ませない）。title 属性は使わない（ブラウザの小窓と二重に出るため）。
//   すでに title が付いている要素（閲覧のみの権限で無効化されたボタンなど）は、吹き出しを出している間だけ
//   title を外し、その文を吹き出しの2行目に出す（消すときに戻す）。
//
// ボタンの動き（押したときの処理）は一切変えない。説明を出すだけ。
// 位置の計算（placeTip）・長押しの判定（movedTooFar）・aria-describedby の付け替え（withDescToken）は純粋関数で、
// scripts/test-tooltip.mjs で確かめている。

export const SHOW_DELAY_MS = 400;   // マウスを乗せてから出すまで
export const HIDE_DELAY_MS = 120;   // マウスが離れてから消すまで（吹き出しへ移る間に消さない）
export const LONG_PRESS_MS = 500;   // 指の長押しとみなす時間
export const MOVE_TOLERANCE_PX = 10; // 長押し中にこれ以上動いたらスクロールとみなしてやめる
export const DESC_PREFIX = "kjk-tip-d-";

/**
 * 吹き出しの位置を決める（position: fixed の座標＝画面の左上が 0,0）。
 * 上に出せるなら上、無理なら下。どちらも足りなければ広い方。左右は画面の端からはみ出さないよう寄せる。
 * @param {{anchor:{left:number,top:number,width:number,height:number},
 *          tip:{width:number,height:number}, viewport:{width:number,height:number},
 *          gap?:number, margin?:number}} p
 * @returns {{left:number, top:number, placement:"top"|"bottom", arrowX:number}}
 *   arrowX は吹き出しの左端から見た、ボタンの中心の位置（矢印を置く場所。吹き出しの角から 12px 以上内側）
 */
export function placeTip({ anchor, tip, viewport, gap = 8, margin = 8 }) {
  const vw = Math.max(0, viewport.width), vh = Math.max(0, viewport.height);
  const tw = Math.max(0, tip.width), th = Math.max(0, tip.height);
  const spaceAbove = anchor.top - margin;
  const spaceBelow = vh - (anchor.top + anchor.height) - margin;
  let placement;
  if (spaceAbove >= th + gap) placement = "top";
  else if (spaceBelow >= th + gap) placement = "bottom";
  else placement = spaceAbove >= spaceBelow ? "top" : "bottom";

  let top = placement === "top" ? anchor.top - gap - th : anchor.top + anchor.height + gap;
  // 縦も画面の中に収める（どちらにも入りきらないとき）
  top = Math.min(Math.max(top, margin), Math.max(margin, vh - margin - th));

  const center = anchor.left + anchor.width / 2;
  let left = center - tw / 2;
  const maxLeft = vw - margin - tw;
  if (maxLeft < margin) left = margin;           // 画面より広い吹き出し（ふつうは max-width で起きない）
  else left = Math.min(Math.max(left, margin), maxLeft);

  const arrowX = Math.min(Math.max(center - left, 12), Math.max(12, tw - 12));
  return { left: Math.round(left), top: Math.round(top), placement, arrowX: Math.round(arrowX) };
}

/** 長押しの途中で指が動きすぎたか（スクロールとみなす） */
export function movedTooFar(dx, dy, tol = MOVE_TOLERANCE_PX) {
  return Math.hypot(dx, dy) > tol;
}

/**
 * aria-describedby の値に、説明の要素の id を入れる（ほかの id は残す。古い説明の id は外す）。
 * @param {string|null} current いまの aria-describedby
 * @param {string} id 入れる id（DESC_PREFIX で始まる）
 */
export function withDescToken(current, id) {
  const others = String(current || "").split(/\s+/).filter((t) => t && !t.startsWith(DESC_PREFIX));
  return [...others, id].join(" ");
}

/** 吹き出しに出す文（data-tip と、一時的に外した title） */
export function tipText(tip, title) {
  const a = String(tip || "").trim();
  const b = String(title || "").trim();
  if (!a) return b;
  if (!b || b === a) return a;
  return `${a}\n（${b}）`;
}

// ---------------------------------------------------------------------------
// ここから下はブラウザでだけ動く（node のテストでは読み込むだけで何もしない）

let installed = false;

export function installTooltips(doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc || installed) return;
  installed = true;
  const win = doc.defaultView || window;

  // --- 読み上げ用の説明（隠れた要素）---
  const descHost = doc.createElement("div");
  descHost.id = "kjk-tip-descs";
  descHost.hidden = true;
  const descIds = new Map(); // 説明文 → 要素の id（同じ文は1つを使い回す）
  let descSeq = 0;
  function descIdFor(text) {
    let id = descIds.get(text);
    if (!id) {
      id = `${DESC_PREFIX}${++descSeq}`;
      const s = doc.createElement("span");
      s.id = id;
      s.textContent = text;
      descHost.appendChild(s);
      descIds.set(text, id);
    }
    return id;
  }
  function linkDesc(el) {
    const text = (el.getAttribute("data-tip") || "").trim();
    if (!text) return;
    const id = descIdFor(text);
    const cur = el.getAttribute("aria-describedby");
    const next = withDescToken(cur, id);
    if (cur !== next) el.setAttribute("aria-describedby", next);
  }
  function linkAll(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1 && root.hasAttribute("data-tip")) linkDesc(root);
    root.querySelectorAll?.("[data-tip]").forEach(linkDesc);
  }

  // --- 吹き出し（見える方）---
  const bubble = doc.createElement("div");
  bubble.className = "kjk-tip";
  bubble.setAttribute("role", "tooltip");
  bubble.setAttribute("aria-hidden", "true"); // 読み上げは aria-describedby の側で行う
  bubble.hidden = true;
  const bubbleText = doc.createElement("div");
  bubbleText.className = "kjk-tip-text";
  const arrow = doc.createElement("div");
  arrow.className = "kjk-tip-arrow";
  bubble.append(bubbleText, arrow);

  let current = null;        // 吹き出しを出しているボタン
  let stashedTitle = null;   // 出している間だけ外した title
  let showTimer = 0, hideTimer = 0;

  function clearTimers() { win.clearTimeout(showTimer); win.clearTimeout(hideTimer); showTimer = hideTimer = 0; }

  function restoreTitle() {
    if (current && stashedTitle !== null) current.setAttribute("title", stashedTitle);
    stashedTitle = null;
  }

  function show(el) {
    clearTimers();
    if (!el || !el.isConnected) return;
    const tip = el.getAttribute("data-tip");
    if (!tip || !tip.trim()) return;
    if (current && current !== el) hide();
    current = el;
    const title = el.getAttribute("title");
    if (title) { stashedTitle = title; el.removeAttribute("title"); }
    bubbleText.textContent = tipText(tip, title);
    bubble.hidden = false;
    bubble.style.left = "0px"; bubble.style.top = "0px";
    bubble.style.visibility = "hidden"; // 大きさを測ってから置く
    const r = el.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const pos = placeTip({
      anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
      tip: { width: b.width, height: b.height },
      viewport: { width: doc.documentElement.clientWidth || win.innerWidth, height: doc.documentElement.clientHeight || win.innerHeight },
    });
    bubble.style.left = `${pos.left}px`;
    bubble.style.top = `${pos.top}px`;
    bubble.dataset.placement = pos.placement;
    arrow.style.left = `${pos.arrowX}px`;
    bubble.style.visibility = "";
  }

  function hide() {
    clearTimers();
    restoreTitle();
    current = null;
    bubble.hidden = true;
  }

  function tipTarget(node) {
    const el = node && node.nodeType === 1 ? node : node?.parentElement;
    const t = el?.closest?.("[data-tip]");
    return t && t.getAttribute("data-tip")?.trim() ? t : null;
  }

  // --- マウス（ホバーがある端末）---
  let pendingEl = null; // 出す予定のボタン（待っている間）
  const inZone = (n) => !!n && ((current && current.contains(n)) || bubble.contains(n) || (pendingEl && pendingEl.contains(n)));
  doc.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    if (inZone(e.target) && (bubble.contains(e.target) || (current && current.contains(e.target)))) {
      win.clearTimeout(hideTimer); // ボタン・吹き出しの上に戻った
      return;
    }
    const t = tipTarget(e.target);
    if (!t || t === pendingEl) return;
    win.clearTimeout(showTimer);
    pendingEl = t;
    // すでに別の吹き出しが出ているときは、待たずに切り替える
    showTimer = win.setTimeout(() => { pendingEl = null; show(t); }, current ? 0 : SHOW_DELAY_MS);
  });
  doc.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    if (inZone(e.relatedTarget)) return; // ボタンの中・吹き出しへ移っただけ
    if (!pendingEl && !current) return;
    win.clearTimeout(showTimer);
    pendingEl = null;
    if (current) { win.clearTimeout(hideTimer); hideTimer = win.setTimeout(hide, HIDE_DELAY_MS); }
  });

  // --- キーボード ---
  doc.addEventListener("focusin", (e) => {
    const t = tipTarget(e.target);
    if (!t || t !== e.target) return;
    let keyboard = true;
    try { keyboard = t.matches(":focus-visible"); } catch (_) { keyboard = true; }
    if (keyboard) show(t);
  });
  doc.addEventListener("focusout", (e) => {
    if (current && e.target === current) hide();
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || bubble.hidden) return;
    hide();
    e.preventDefault();
    e.stopImmediatePropagation(); // 出ていた吹き出しを消すだけ（モーダルは閉じない）
  }, true);

  // --- 指（長押し）---
  let press = null;             // { el, x, y, timer }
  let suppressClickOn = null;   // 長押しで吹き出しを出したボタン（そのあとのクリックを止める）
  let suppressUntil = 0;
  doc.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") {
      // マウスで押したら消す（押した先でモーダルが開くときに、吹き出しが上に残らないように）
      if (!bubble.contains(e.target)) { win.clearTimeout(showTimer); pendingEl = null; if (current) hide(); }
      return;
    }
    // 吹き出しが出ているときに、ほかを触ったら消す
    if (current && !bubble.contains(e.target) && !current.contains(e.target)) hide();
    const t = tipTarget(e.target);
    if (!t) return;
    if (press) win.clearTimeout(press.timer);
    press = { el: t, x: e.clientX, y: e.clientY, timer: 0 };
    press.timer = win.setTimeout(() => {
      if (!press || press.el !== t) return;
      show(t);
      suppressClickOn = t;
      suppressUntil = Date.now() + 1500;
      press = null;
    }, LONG_PRESS_MS);
  }, true);
  const cancelPress = () => { if (press) { win.clearTimeout(press.timer); press = null; } };
  doc.addEventListener("pointermove", (e) => {
    if (!press || e.pointerType !== "touch") return;
    if (movedTooFar(e.clientX - press.x, e.clientY - press.y)) cancelPress();
  }, true);
  doc.addEventListener("pointerup", (e) => { if (e.pointerType === "touch") cancelPress(); }, true);
  doc.addEventListener("pointercancel", cancelPress, true);
  doc.addEventListener("click", (e) => {
    if (!suppressClickOn) return;
    const hit = suppressClickOn.contains(e.target);
    const fresh = Date.now() <= suppressUntil;
    suppressClickOn = null;
    if (hit && fresh) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // 長押しのメニュー（Android は長押しで contextmenu が来る）。長押し中なら、そのまま吹き出しを出してメニューは止める
  doc.addEventListener("contextmenu", (e) => {
    if (press && press.el.contains(e.target)) {
      const t = press.el;
      cancelPress();
      show(t);
      suppressClickOn = t;
      suppressUntil = Date.now() + 1500;
    }
    if (suppressClickOn && suppressClickOn.contains(e.target)) e.preventDefault();
  }, true);

  // --- 画面が動いたら消す（位置がずれるため）---
  win.addEventListener("scroll", () => { if (current) hide(); }, true);
  win.addEventListener("resize", () => { if (current) hide(); });

  // --- 後から描かれたボタンにも説明をつなぐ ---
  let pending = false;
  const queued = new Set();
  const flush = () => {
    pending = false;
    for (const n of queued) if (n.isConnected) linkAll(n);
    queued.clear();
    if (current && !current.isConnected) hide(); // 出していたボタンが描き直された
  };
  const mo = new win.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") queued.add(r.target);
      else r.addedNodes.forEach((n) => { if (n.nodeType === 1) queued.add(n); });
    }
    if (!pending) { pending = true; win.queueMicrotask ? win.queueMicrotask(flush) : win.setTimeout(flush, 0); }
  });

  const start = () => {
    doc.body.append(descHost, bubble);
    linkAll(doc.body);
    mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tip"] });
  };
  if (doc.body) start(); else doc.addEventListener("DOMContentLoaded", start, { once: true });
}

if (typeof document !== "undefined" && typeof window !== "undefined") installTooltips(document);
