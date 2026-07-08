// boot.js — script di avvio (splash + blocco zoom). Estratto dagli inline di index.html
// per permettere una CSP stretta (script-src 'self', senza 'unsafe-inline').
(function () {
  // ---- Splash: nasconde l'overlay al mount di React (rispettando una durata minima) ----
  var s = document.getElementById('hq-splash');
  if (s) {
    try { if (localStorage.getItem('hq-theme') === 'light') s.classList.add('hq-light'); } catch (e) {}
    var done = false;
    var startedAt = Date.now();
    var MIN_MS = 1300;
    function reallyHide() {
      if (done) return; done = true;
      s.classList.add('hq-hide');
      setTimeout(function () { if (s && s.parentNode) s.parentNode.removeChild(s); }, 680);
    }
    function hide() {
      var wait = Math.max(0, MIN_MS - (Date.now() - startedAt));
      if (wait > 0) setTimeout(reallyHide, wait); else reallyHide();
    }
    window.__hqHideSplash = hide;
    var v = document.getElementById('hq-vault-video');
    var hasVideo = false;
    if (v) {
      v.addEventListener('loadeddata', function () { v.classList.add('vl-on'); });
      v.addEventListener('playing', function () { hasVideo = true; });
      v.addEventListener('ended', hide);
    }
    setTimeout(function () { if (!hasVideo) hide(); }, 1500);
    setTimeout(hide, 3500);
  }

  // ---- Blocca pinch-to-zoom / double-tap zoom su iOS Safari ----
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', function (e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  var lastTap = 0;
  document.addEventListener('touchend', function (e) {
    var now = Date.now();
    if (now - lastTap < 300) e.preventDefault();
    lastTap = now;
  }, { passive: false });
})();
