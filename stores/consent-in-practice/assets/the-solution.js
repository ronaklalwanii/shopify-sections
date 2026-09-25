/**
 * The Solution — scroll reveal.
 * Reveal only activates once this script adds [data-ts-reveal-ready],
 * so content is never hidden when JS fails to load.
 */
(function () {
  'use strict';

  var ROOT_SELECTOR = '[data-ts-section]';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function reveal(root) {
    if (root.dataset.reveal !== 'true') return;

    var items = root.querySelectorAll('[data-ts-reveal]');
    if (!items.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      items.forEach(function (el) {
        el.classList.add('ts-is-visible');
      });
      return;
    }

    root.setAttribute('data-ts-reveal-ready', '');

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('ts-is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    items.forEach(function (el, index) {
      if (el.classList.contains('ts-is-visible')) return;
      el.style.setProperty('--ts-delay', Math.min(index * 90, 540) + 'ms');
      observer.observe(el);
    });
  }

  function init(root) {
    if (!root || root.dataset.tsInit === 'true') return;
    root.dataset.tsInit = 'true';
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

  document.addEventListener('shopify:block:select', function (event) {
    var cell = event.target.closest('[data-ts-reveal]');
    if (!cell) return;
    cell.classList.add('ts-is-visible');
    if (cell.scrollIntoView) {
      cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
})();
