// admin/js/manual.js — マニュアルページの目次・現在位置・検索・画像の後始末・印刷前の展開
// 認証は docpage.js（別 module）が行い、通過後に #doc の display を block にする。ここは見た目の補助だけ。
(function () {
  "use strict";
  var doc = document.getElementById("doc");
  var toc = document.getElementById("mnToc");
  if (!doc || !toc) return;

  var chaps = Array.prototype.slice.call(doc.querySelectorAll(".chap"));
  var secs = Array.prototype.slice.call(doc.querySelectorAll(".sec[data-toc]"));

  // ---------- 目次を本文から組み立てる ----------
  var list = document.createElement("ol");
  chaps.forEach(function (ch) {
    var h2 = ch.querySelector("h2");
    var ico = ch.querySelector(".ico i");
    var li = document.createElement("li");
    li.dataset.chap = ch.id;
    var a = document.createElement("a");
    a.href = "#" + ch.id;
    a.dataset.target = ch.id;
    a.innerHTML = '<i class="' + (ico ? ico.className : "ti ti-point") + '" aria-hidden="true"></i><span></span>';
    a.lastChild.textContent = h2 ? h2.textContent : ch.id;
    li.appendChild(a);
    var subs = Array.prototype.slice.call(ch.querySelectorAll(".sec[data-toc]"));
    if (subs.length) {
      var ol = document.createElement("ol");
      subs.forEach(function (sc) {
        var sli = document.createElement("li");
        sli.dataset.sec = sc.id;
        var sa = document.createElement("a");
        sa.href = "#" + sc.id;
        sa.dataset.target = sc.id;
        sa.textContent = sc.dataset.toc;
        sli.appendChild(sa);
        ol.appendChild(sli);
      });
      li.appendChild(ol);
    }
    list.appendChild(li);
  });
  toc.appendChild(list);

  // ---------- 現在位置（IntersectionObserver） ----------
  var visible = new Set();
  var active = null;
  function setActive(id) {
    if (active === id) return;
    active = id;
    var secEl = document.getElementById(id);
    var chapEl = secEl && secEl.closest ? secEl.closest(".chap") : null;
    var chapId = chapEl ? chapEl.id : id;
    toc.querySelectorAll("a.active").forEach(function (x) { x.classList.remove("active"); });
    toc.querySelectorAll("li.open").forEach(function (x) { x.classList.remove("open"); });
    var ca = toc.querySelector('a[data-target="' + chapId + '"]');
    if (ca) { ca.classList.add("active"); ca.parentNode.classList.add("open"); }
    var sa = toc.querySelector('a[data-target="' + id + '"]');
    if (sa && sa !== ca) sa.classList.add("active");
  }
  var order = chaps.concat(secs);
  function pick() {
    var best = null, top = Infinity;
    visible.forEach(function (el) {
      var t = Math.abs(el.getBoundingClientRect().top - 80);
      if (t < top) { top = t; best = el; }
    });
    if (best) setActive(best.id);
  }
  function startObserver() {
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target); });
      // 章は「いま見えている小見出し」を優先。小見出しが無ければ章
      var secVisible = Array.prototype.slice.call(visible).filter(function (el) { return el.classList.contains("sec"); });
      if (secVisible.length) {
        var best = secVisible.sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; })[0];
        setActive(best.id);
      } else pick();
    }, { rootMargin: "-10% 0px -70% 0px", threshold: 0 });
    order.forEach(function (el) { io.observe(el); });
  }

  // ---------- 検索（章・見出し・本文の文字で絞り込む） ----------
  var input = document.getElementById("mnSearch");
  var count = document.getElementById("mnCount");
  var noRes = document.getElementById("mnNoResult");
  var news = document.getElementById("mnNews");
  function norm(s) { return (s || "").toLowerCase().replace(/\s+/g, ""); }
  secs.concat(Array.prototype.slice.call(doc.querySelectorAll(".sec:not([data-toc])"))).forEach(function (s) {
    s._txt = norm(s.textContent);
  });
  function runSearch() {
    var q = norm(input.value);
    var allSecs = Array.prototype.slice.call(doc.querySelectorAll(".sec"));
    if (!q) {
      allSecs.forEach(function (s) { s.hidden = false; });
      chaps.forEach(function (c) { c.hidden = false; });
      if (news) news.hidden = false;
      toc.querySelectorAll("li").forEach(function (li) { li.classList.remove("hide"); });
      count.textContent = "";
      noRes.style.display = "none";
      return;
    }
    var hits = 0;
    allSecs.forEach(function (s) {
      var hit = (s._txt || norm(s.textContent)).indexOf(q) >= 0;
      s.hidden = !hit;
      if (hit) hits++;
    });
    chaps.forEach(function (c) {
      var any = c.querySelector(".sec:not([hidden])");
      var titleHit = norm(c.querySelector("h2").textContent).indexOf(q) >= 0;
      if (titleHit && !any) { c.querySelectorAll(".sec").forEach(function (s) { s.hidden = false; }); any = c.querySelector(".sec"); hits++; }
      c.hidden = !any;
    });
    if (news) news.hidden = norm(news.textContent).indexOf(q) < 0;
    toc.querySelectorAll("li[data-chap]").forEach(function (li) {
      var c = document.getElementById(li.dataset.chap);
      li.classList.toggle("hide", !!c.hidden);
    });
    toc.querySelectorAll("li[data-sec]").forEach(function (li) {
      var s = document.getElementById(li.dataset.sec);
      li.classList.toggle("hide", !!s.hidden);
    });
    count.textContent = hits ? hits + " か所が見つかりました" : "";
    noRes.style.display = hits ? "none" : "block";
    // 検索中は FAQ も開いて本文を見せる
    doc.querySelectorAll("details.faq").forEach(function (d) {
      if (d.closest(".sec") && !d.closest(".sec").hidden) d.open = (d.textContent || "").toLowerCase().replace(/\s+/g, "").indexOf(q) >= 0;
    });
  }
  if (input) input.addEventListener("input", runSearch);

  // ---------- 画像が無いときは枠ごと隠す ----------
  function sweepImages() {
    doc.querySelectorAll("figure.shot img").forEach(function (img) {
      var fig = img.closest("figure");
      if (img.complete && img.naturalWidth === 0) fig.hidden = true;
      img.addEventListener("error", function () { fig.hidden = true; });
    });
  }
  sweepImages();

  // ---------- 印刷前に FAQ を全部開く ----------
  var opened = [];
  window.addEventListener("beforeprint", function () {
    opened = [];
    doc.querySelectorAll("details").forEach(function (d) { if (!d.open) { d.open = true; opened.push(d); } });
  });
  window.addEventListener("afterprint", function () { opened.forEach(function (d) { d.open = false; }); opened = []; });

  // ---------- 先頭へ戻るボタン ----------
  var topBtn = document.getElementById("mnTop");
  if (topBtn) {
    topBtn.addEventListener("click", function () { window.scrollTo({ top: 0 }); });
    window.addEventListener("scroll", function () { topBtn.classList.toggle("show", window.scrollY > 600); }, { passive: true });
  }

  // ---------- 認証を通って #doc が表示されたら、監視と #ハッシュ へのジャンプを始める ----------
  var started = false;
  function onShown() {
    if (started) return;
    if (getComputedStyle(doc).display === "none") return;
    started = true;
    startObserver();
    if (location.hash.length > 1) {
      var t = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (t) t.scrollIntoView();
    } else if (chaps.length) setActive(chaps[0].id);
  }
  onShown();
  if (!started) new MutationObserver(onShown).observe(doc, { attributes: true, attributeFilter: ["style"] });

  // 目次の「タップで開く」（スマホで長くなるので、小さい画面では折り畳み可）
  if (window.matchMedia("(max-width: 1100px)").matches) toc.classList.add("collapsible");
})();
