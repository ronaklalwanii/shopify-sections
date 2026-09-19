/**
 * Ritual Accessories — staggered scroll reveal + AJAX quick-add.
 * Reveal only activates once this script adds [data-ra-reveal-ready],
 * so content is never hidden when JS fails to load. The quick-add
 * form posts to /cart/add.js and shows an "Added" state; without JS
 * the form still works as a normal POST.
 */
(function () {
  'use strict';

  var ROOT_SELECTOR = '[data-ra-section]';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function reveal(root) {
    if (root.dataset.reveal !== 'true') return;

    var items = root.querySelectorAll('[data-ra-reveal]');
    if (!items.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      items.forEach(function (el) {
        el.classList.add('ra-is-visible');
      });
      return;
    }

    root.setAttribute('data-ra-reveal-ready', '');

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('ra-is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    items.forEach(function (el, index) {
      if (el.classList.contains('ra-is-visible')) return;
      el.style.setProperty('--ra-delay', Math.min(index * 80, 480) + 'ms');
      observer.observe(el);
    });
  }

  function quickAdd(root) {
    root.querySelectorAll('[data-ra-add]').forEach(function (form) {
      if (form.dataset.raAddBound === 'true') return;
      form.dataset.raAddBound = 'true';

      form.addEventListener('submit', function (event) {
        event.preventDefault();

        var button = form.querySelector('.ra-card__add');
        var label = form.querySelector('.ra-card__add-label');
        if (!button || button.dataset.busy === 'true') return;

        var original = label ? label.textContent : '';
        button.dataset.busy = 'true';
        button.style.opacity = '0.6';

        fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          headers: { Accept: 'application/javascript' }
        })
          .then(function (response) {
            if (!response.ok) throw new Error('add failed');
            if (label) label.textContent = 'Added ✓';
            button.classList.add('is-added');
            button.style.opacity = '';
            /* let theme cart drawers/counters react if they listen */
            document.documentElement.dispatchEvent(
              new CustomEvent('cart:refresh', { bubbles: true })
            );
            document.dispatchEvent(new CustomEvent('cart:refresh'));
            setTimeout(function () {
              if (label) label.textContent = original;
              button.classList.remove('is-added');
              button.dataset.busy = 'false';
            }, 2000);
          })
          .catch(function () {
            /* offline or validation error — fall back to a full page POST.
               form.submit() bypasses the submit event, so no loop. */
            button.dataset.busy = 'false';
            button.style.opacity = '';
            form.submit();
          });
      });
    });
  }

  function init(root) {
    if (!root || root.dataset.raInit === 'true') return;
    root.dataset.raInit = 'true';
    reveal(root);
    quickAdd(root);
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
    var card = event.target.closest('[data-ra-reveal]');
    if (!card) return;
    card.classList.add('ra-is-visible');
    if (card.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
})();
