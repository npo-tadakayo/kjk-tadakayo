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
  // モーダル共通a11y（全画面・rule26 / WCAG 2.1.2・2.4.3）: Escで閉じる＋Tabフォーカストラップ＋開いたら初期フォーカス
  function modalA11y(){
    document.addEventListener("keydown", function(e){
      var modal=document.querySelector(".modal-overlay.open");
      if(!modal) return;
      if(e.key==="Escape"){ modal.classList.remove("open"); return; }
      if(e.key==="Tab"){
        var f=modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
        var vis=Array.prototype.filter.call(f,function(el){return el.offsetParent!==null;});
        if(!vis.length) return;
        var first=vis[0], last=vis[vis.length-1];
        if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
        else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
      }
    });
    var obs=new MutationObserver(function(muts){
      muts.forEach(function(m){
        var t=m.target;
        if(t.classList && t.classList.contains("modal-overlay") && t.classList.contains("open")){
          var f=t.querySelector('input:not([disabled]),select,textarea,button');
          if(f) setTimeout(function(){ try{ f.focus(); }catch(_){} },50);
        }
      });
    });
    document.querySelectorAll(".modal-overlay").forEach(function(m){ obs.observe(m,{attributes:true,attributeFilter:["class"]}); });
  }
  function start(){ init(); modalA11y(); }
  if(document.readyState!=="loading") start();
  else document.addEventListener("DOMContentLoaded", start);
})();
