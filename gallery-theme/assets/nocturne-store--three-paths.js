/**
 * Three Paths — staggered scroll reveal.
 * Reveal only activates once this script adds [data-paths-reveal-ready],
 * so content is never hidden when JS fails to load. Card hover states
 * are pure CSS.
 */
(function () {
  'use strict';

  var ROOT_SELECTOR = '[data-paths-section]';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function reveal(root) {
    if (root.dataset.reveal !== 'true') return;

    var items = root.querySelectorAll('[data-paths-reveal]');
    if (!items.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      items.forEach(function (el) {
        el.classList.add('paths-is-visible');
      });
      return;
    }

    root.setAttribute('data-paths-reveal-ready', '');

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('paths-is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    items.forEach(function (el, index) {
      if (el.classList.contains('paths-is-visible')) return;
      el.style.setProperty('--paths-delay', Math.min(index * 90, 540) + 'ms');
      observer.observe(el);
    });
  }

  function init(root) {
    if (!root || root.dataset.pathsInit === 'true') return;
    root.dataset.pathsInit = 'true';
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
    var card = event.target.closest('[data-paths-reveal]');
    if (!card) return;
    card.classList.add('paths-is-visible');
    if (card.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
})();
