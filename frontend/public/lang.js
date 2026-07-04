/* HQVault — motore bilingue per le landing statiche.
   IT resta nel markup; l'inglese sta in window.HQ_EN = { chiave: 'testo EN' } definito in ogni pagina.
   Uso: <h1 data-i18n="hero">…IT…</h1>  +  input data-i18n-ph="…" per i placeholder.
   Il bottone #hqLangBtn (onclick="hqToggleLang()") alterna e ricorda la scelta (localStorage). */
(function () {
  function apply(lang) {
    var dict = window.HQ_EN || {};
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var k = el.getAttribute('data-i18n');
      if (el.__it == null) el.__it = el.innerHTML;               // cattura l'IT originale una volta
      el.innerHTML = (lang === 'en' && dict[k] != null) ? dict[k] : el.__it;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      var k = el.getAttribute('data-i18n-ph');
      if (el.__itph == null) el.__itph = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', (lang === 'en' && dict[k] != null) ? dict[k] : el.__itph);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var k = el.getAttribute('data-i18n-title');
      if (el.__ittl == null) el.__ittl = el.getAttribute('title') || '';
      el.setAttribute('title', (lang === 'en' && dict[k] != null) ? dict[k] : el.__ittl);
    });
    document.documentElement.lang = lang;
    try { localStorage.setItem('hqLang', lang); } catch (e) {}
    var b = document.getElementById('hqLangBtn');
    if (b) b.textContent = lang === 'en' ? 'IT' : 'EN';
  }
  window.hqToggleLang = function () {
    var cur = 'it';
    try { cur = localStorage.getItem('hqLang') || 'it'; } catch (e) {}
    apply(cur === 'en' ? 'it' : 'en');
  };
  function boot() {
    var saved = 'it';
    try { saved = localStorage.getItem('hqLang') || 'it'; } catch (e) {}
    apply(saved);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
