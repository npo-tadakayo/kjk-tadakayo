// モバイル用ヘッダー＋ドロワー（rule25）。全管理画面で共通利用（非module）
(function(){
  function init(){
    if(document.querySelector(".mobile-header")) return;
    var layout=document.querySelector(".layout");
    var sidebar=document.querySelector(".sidebar");
    if(!layout || !sidebar) return;

    var hdr=document.createElement("div");
    hdr.className="mobile-header";
    hdr.innerHTML='<button class="mh-burger" type="button" aria-label="メニューを開く" aria-expanded="false" aria-controls="appSidebar"><i class="ti ti-menu-2" aria-hidden="true"></i></button>'
      +'<span class="mh-title">タダカヨ CRM</span>';
    document.body.insertBefore(hdr, document.body.firstChild);

    sidebar.id = sidebar.id || "appSidebar";
    var ov=document.createElement("div"); ov.className="nav-overlay"; document.body.appendChild(ov);
    var burger=hdr.querySelector(".mh-burger");

    function open(){
      sidebar.classList.add("open"); ov.classList.add("show");
      burger.setAttribute("aria-expanded","true"); document.body.style.overflow="hidden";
      var first=sidebar.querySelector("a,button"); if(first) first.focus();
    }
    function close(){
      sidebar.classList.remove("open"); ov.classList.remove("show");
      burger.setAttribute("aria-expanded","false"); document.body.style.overflow="";
    }
    burger.addEventListener("click", function(){ sidebar.classList.contains("open")?close():open(); });
    ov.addEventListener("click", close);
    document.addEventListener("keydown", function(e){ if(e.key==="Escape") close(); });
    // メニュー項目タップで閉じる
    sidebar.addEventListener("click", function(e){ if(e.target.closest(".nav-item")) close(); });
  }
  if(document.readyState!=="loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
