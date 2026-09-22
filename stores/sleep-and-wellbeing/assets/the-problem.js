/**
 * The Problem — scroll reveal + pointer tilt.
 * Reveal only activates once this script adds [data-tp-reveal-ready],
 * so content is never hidden when JS fails to load.
 */
(function () {
  'use strict';

  var ROOT_SELECTOR = '[data-tp-section]';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  function reveal(root) {
    if (root.dataset.reveal !== 'true') return;

    var items = root.querySelectorAll('[data-tp-reveal]');
    if (!items.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      items.forEach(function (el) {
        el.classList.add('tp-is-visible');
      });
      return;
    }

    root.setAttribute('data-tp-reveal-ready', '');

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('tp-is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    items.forEach(function (el, index) {
      if (el.classList.contains('tp-is-visible')) return;
      el.style.setProperty('--tp-delay', Math.min(index * 90, 540) + 'ms');
      observer.observe(el);
    });
  }

  function tilt(root) {
    if (root.dataset.hoverAnimation !== 'tilt') return;
    if (reduceMotion.matches || !finePointer.matches) return;

    root.querySelectorAll('[data-tp-card]').forEach(function (card) {
      if (card.dataset.tiltBound === 'true') return;
      card.dataset.tiltBound = 'true';

      var max = parseFloat(card.dataset.tiltMax || '6');
      var frame = 0;

      card.addEventListener('pointermove', function (event) {
        if (frame) return;
        frame = requestAnimationFrame(function () {
          frame = 0;
          var rect = card.getBoundingClientRect();
          var px = (event.clientX - rect.left) / rect.width - 0.5;
          var py = (event.clientY - rect.top) / rect.height - 0.5;
          card.style.setProperty('--tp-tilt-x', (-py * 2 * max).toFixed(2) + 'deg');
          card.style.setProperty('--tp-tilt-y', (px * 2 * max).toFixed(2) + 'deg');
        });
      });

      card.addEventListener('pointerleave', function () {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        card.style.setProperty('--tp-tilt-x', '0deg');
        card.style.setProperty('--tp-tilt-y', '0deg');
      });
    });
  }

  function init(root) {
    if (!root || root.dataset.tpInit === 'true') return;
    root.dataset.tpInit = 'true';
    reveal(root);
    tilt(root);
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
    var cell = event.target.closest('[data-tp-reveal]');
    if (!cell) return;
    cell.classList.add('tp-is-visible');
    if (cell.scrollIntoView) {
      cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
})();
