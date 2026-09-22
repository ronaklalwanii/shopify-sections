/**
 * The Reality — scroll reveal + count-up stats.
 * Reveal only activates once this script adds [data-tr-reveal-ready],
 * so content is never hidden when JS fails to load. Numbers are
 * rendered server-side and only replaced while animating.
 */
(function () {
  'use strict';

  var ROOT_SELECTOR = '[data-tr-section]';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function reveal(root) {
    if (root.dataset.reveal !== 'true') return;

    var items = root.querySelectorAll('[data-tr-reveal]');
    if (!items.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      items.forEach(function (el) {
        el.classList.add('tr-is-visible');
      });
      return;
    }

    root.setAttribute('data-tr-reveal-ready', '');

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('tr-is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    items.forEach(function (el, index) {
      if (el.classList.contains('tr-is-visible')) return;
      el.style.setProperty('--tr-delay', Math.min(index * 90, 540) + 'ms');
      observer.observe(el);
    });
  }

  /* "£1,234.5K+" -> { prefix: "£", value: 1234.5, decimals: 1, suffix: "K+" } */
  function parseStat(raw) {
    var match = String(raw).match(/^([^\d-]*)(-?[\d][\d.,]*)(.*)$/);
    if (!match) return null;

    var value = parseFloat(match[2].replace(/,/g, ''));
    if (isNaN(value)) return null;

    return {
      prefix: match[1],
      value: value,
      decimals: (match[2].split('.')[1] || '').length,
      suffix: match[3]
    };
  }

  function format(value, decimals) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function countUp(root) {
    if (root.dataset.countup !== 'true') return;
    if (reduceMotion.matches || !('IntersectionObserver' in window)) return;

    var duration = parseInt(root.dataset.countupDuration, 10) || 1800;

    var numbers = root.querySelectorAll('[data-tr-number]');
    if (!numbers.length) return;

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);

          var el = entry.target;
          var parsed = parseStat(el.dataset.trNumber);
          if (!parsed || parsed.value === 0) return;

          var start = performance.now();

          function frame(now) {
            var progress = Math.min((now - start) / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            el.textContent =
              parsed.prefix + format(parsed.value * eased, parsed.decimals) + parsed.suffix;
            if (progress < 1) requestAnimationFrame(frame);
          }

          requestAnimationFrame(frame);
        });
      },
      { threshold: 0.5 }
    );

    numbers.forEach(function (el) {
      if (el.dataset.countBound === 'true') return;
      el.dataset.countBound = 'true';
      observer.observe(el);
    });
  }

  function init(root) {
    if (!root || root.dataset.trInit === 'true') return;
    root.dataset.trInit = 'true';
    reveal(root);
    countUp(root);
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
    var stat = event.target.closest('[data-tr-reveal]');
    if (!stat) return;
    stat.classList.add('tr-is-visible');
  });
})();
