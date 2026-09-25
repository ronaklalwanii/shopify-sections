/**
 * EQ About Us — soft staggered scroll reveal.
 * Reveal only activates once this script adds [data-reveal-ready],
 * so content is never hidden when JS fails to load. Honors
 * prefers-reduced-motion (handled in CSS as well).
 */
(function () {
  'use strict';

  var ROOT_SELECTOR = '[data-eau-section]';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function reveal(root) {
    if (root.dataset.reveal !== 'true') return;

    var items = root.querySelectorAll('[data-eau-reveal]');
    if (!items.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      items.forEach(function (el) {
        el.classList.add('eau-is-visible');
      });
      return;
    }

    root.setAttribute('data-reveal-ready', '');

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('eau-is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' }
    );

    /* stagger within each viewport entry, capped so late sections
       don't inherit huge delays from earlier ones */
    items.forEach(function (el, index) {
      if (el.classList.contains('eau-is-visible')) return;
      el.style.setProperty('--eau-delay', Math.min((index % 8) * 90, 450) + 'ms');
      observer.observe(el);
    });
  }

  function init(root) {
    if (!root || root.dataset.eauInit === 'true') return;
    root.dataset.eauInit = 'true';
    reveal(root);
  }

  function initAll() {
    document.querySelectorAll(ROOT_SELECTOR).forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  document.addEventListener('shopify:section:load', function (event) {
    init(event.target.querySelector(ROOT_SELECTOR));
  });
})();
