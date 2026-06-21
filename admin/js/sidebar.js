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
      ["/partner-admin.html", "ti-certificate", "認定事業所"],
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
    return '<a class="nav-item' + active + '" href="' + it[0] + '">'
      + '<i class="ti ' + it[1] + '" aria-hidden="true"></i>' + it[2] + '</a>';
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

  // 他JSから明示的に呼べるよう公開（任意）
  window.renderCrmNav = render;

  if (document.readyState !== "loading") render();
  else document.addEventListener("DOMContentLoaded", render);
})();
