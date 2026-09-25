/* interactivity: wishlist-toggle
   Wires [data-wishlist] hearts rendered by snippets/product-card.liquid.
   Shares the same persisted store as the project-cards section script.
   Idempotent: delegated listener binds once, survives shopify:section:load. */
(function () {
  'use strict';
  var KEY = 'atelier-wishlist-v1';
  var STYLE_ID = 'wishlist-toggle-styles';
  function readStore() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  }
  function writeStore(store) {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
  }
  function productKey(btn) {
    var card = btn.closest('[data-product-id], .card, article, li');
    var id = card && (card.getAttribute('data-product-id') || card.getAttribute('id'));
    var handle = btn.getAttribute('data-wish-key');
    if (handle) { return handle; }
    if (id) { return id; }
    var img = card && card.querySelector('img');
    return (img && img.getAttribute('src')) || btn.getAttribute('aria-label') || 'item';
  }
  function sync(btn) {
    var on = !!readStore()[productKey(btn)];
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? '\u2665' : '\u2661';
  }
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) { return; }
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '[data-wishlist]{cursor:pointer}' +
      '[data-wishlist]:focus-visible{outline:2px solid currentColor;outline-offset:2px}' +
      '[data-wishlist][aria-pressed="true"]{color:#d6336c}';
    document.head.appendChild(style);
  }
  function init() {
    injectStyles();
    document.querySelectorAll('[data-wishlist]').forEach(function (btn) {
      if (!btn.getAttribute('aria-pressed')) { btn.setAttribute('aria-pressed', 'false'); }
      sync(btn);
    });
  }
  if (!document.documentElement.dataset.wishlistBound) {
    document.documentElement.dataset.wishlistBound = '1';
    document.addEventListener('click', function (evt) {
      var btn = evt.target.closest && evt.target.closest('[data-wishlist]');
      if (!btn) { return; }
      evt.preventDefault();
      var key = productKey(btn);
      var store = readStore();
      if (store[key]) { delete store[key]; } else { store[key] = true; }
      writeStore(store);
      document.querySelectorAll('[data-wishlist]').forEach(function (b) { sync(b); });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  document.addEventListener('shopify:section:load', init);
})();
