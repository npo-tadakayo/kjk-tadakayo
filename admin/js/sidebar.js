// admin/js/sidebar.js — サイドメニューの単一情報源（SSOT・非module・全画面共通）
// 旧: docpage.js / settings.js / users.js / 各HTML直書き に重複していた NAV をここへ集約。
// <nav class="sidebar-nav" id="nav"></nav> を見つけて、4グループ＋ヘルプを描画する。
// 現在地は location.pathname から自動でハイライト。mobilenav.js はイベント委譲なので順序非依存。
(function () {
  // ===== グループ定義（ここだけ直せば全画面に反映）=====
  var GROUPS = [
    { title: "案件", items: [
      ["/dashboard.html", "ti-chart-bar", "ダッシュボード"],
      ["/cases.html", "ti-layout-list", "案件一覧"],
      ["/kanban.html", "ti-layout-kanban", "カンバン"],
    ]},
    { title: "受発注・物品", items: [
      ["/supply.html", "ti-package", "供給管理"],
      ["/partner-admin.html", "ti-certificate", "認定事業者"],
      ["/pricing.html", "ti-coin", "料金・送料"],
      ["/simulator.html", "ti-calculator", "売上シミュレーター"],
    ]},
    { title: "分析", items: [
      ["/analytics.html", "ti-chart-arcs", "アクセス解析"],
    ]},
    { title: "管理", items: [
      ["/settings.html", "ti-settings", "設定"],
      ["/users.html", "ti-users", "ユーザー管理"],
    ]},
  ];
  var HELP = [
    ["/manual.html", "ti-book-2", "マニュアル"],
    ["/videos.html", "ti-video", "動画マニュアル"],
    ["/engineering.html", "ti-notebook", "エンジニアノート"],
  ];

  function isActive(href, path) {
    // 詳細画面は親メニューをハイライト
    if (path.indexOf("case-detail") >= 0) return href === "/cases.html";
    if (path.indexOf("partner") >= 0) return href === "/partner-admin.html";
    // 末尾のファイル名で厳密一致（/cases.html・/cases いずれも可）
    var file = (path.split("/").pop() || "dashboard.html").replace(/\.html$/, "") || "dashboard";
    return href === "/" + file + ".html";
  }
  function link(it, path) {
    var active = isActive(it[0], path) ? " active" : "";
    // 折り畳み時にラベルだけ隠せるよう span で包む。title は畳んだときの吹き出しになる。
    return '<a class="nav-item' + active + '" href="' + it[0] + '" title="' + it[2] + '">'
      + '<i class="ti ' + it[1] + '" aria-hidden="true"></i><span>' + it[2] + '</span></a>';
  }
  function render() {
    var el = document.getElementById("nav");
    if (!el) return;
    var path = location.pathname;
    var html = "";
    GROUPS.forEach(function (g) {
      html += '<div class="nav-section">' + g.title + '</div>';
      g.items.forEach(function (it) { html += link(it, path); });
    });
    html += '<div class="nav-divider-line"></div>';
    HELP.forEach(function (it) { html += link(it, path); });
    el.innerHTML = html;
  }

  // ===== 折り畳み（箱型）=====
  // 状態は localStorage に持ち、全画面で共通にする。
  // モバイル（1024px以下）はドロワー方式なので、畳んだ状態でも幅は変えない（CSS側で分岐）。
  var KEY = "crmNavCollapsed";

  function applyCollapsed(on) {
    var layout = document.querySelector(".layout");
    if (layout) layout.classList.toggle("nav-collapsed", !!on);
    var btn = document.getElementById("navToggleBtn");
    if (btn) {
      btn.setAttribute("aria-expanded", on ? "false" : "true");
      btn.setAttribute("aria-label", on ? "メニューを広げる" : "メニューを畳む");
      btn.title = on ? "メニューを広げる" : "メニューを畳む";
      var ic = btn.querySelector("i");
      if (ic) ic.className = "ti " + (on ? "ti-layout-sidebar-left-expand" : "ti-layout-sidebar-left-collapse");
    }
  }

  function mountToggle() {
    var brand = document.querySelector(".sidebar-brand");
    if (!brand || document.getElementById("navToggleBtn")) return;
    var row = document.createElement("div");
    row.className = "nav-toggle-row";
    row.innerHTML = '<span class="nav-toggle-label">メニュー</span>'
      + '<button type="button" id="navToggleBtn" class="nav-toggle" style="margin-left:auto">'
      + '<i class="ti ti-layout-sidebar-left-collapse" aria-hidden="true"></i></button>';
    brand.insertAdjacentElement("afterend", row);
    document.getElementById("navToggleBtn").addEventListener("click", function () {
      var now = !document.querySelector(".layout").classList.contains("nav-collapsed");
      try { localStorage.setItem(KEY, now ? "1" : "0"); } catch (e) {}
      applyCollapsed(now);
    });
  }

  // ログアウトボタンのラベルは各HTMLに素のテキストで書かれていて、畳んだときに
  // CSS で隠せない（折り返して崩れる）。16枚のHTMLを直すより、ここで span に包む。
  function wrapLogoutLabel() {
    var btn = document.getElementById("logoutBtn");
    if (!btn || btn.querySelector("span")) return;
    var nodes = Array.prototype.filter.call(btn.childNodes, function (n) {
      return n.nodeType === 3 && n.textContent.trim();
    });
    nodes.forEach(function (n) {
      var sp = document.createElement("span");
      sp.textContent = n.textContent.trim();
      n.parentNode.replaceChild(sp, n);
    });
    if (!btn.getAttribute("title")) btn.setAttribute("title", "ログアウト");
  }

  function boot() {
    render();
    mountToggle();
    wrapLogoutLabel();
    var on = false;
    try { on = localStorage.getItem(KEY) === "1"; } catch (e) {}
    applyCollapsed(on);
  }

  // 他JSから明示的に呼べるよう公開（任意）
  window.renderCrmNav = render;

  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
