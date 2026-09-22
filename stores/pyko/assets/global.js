/* ==========================================================================
   Atelier Four — global.js
   Vanilla JS: drawers, Ajax cart, carousels, slideshow. No dependencies.
   ========================================================================== */
(function () {
  'use strict';

  var config = window.themeSettings || { cartType: 'drawer', strings: {} };

  /* ---------- Drawer helpers ---------- */
  function openDrawer(el) {
    if (!el) return;
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer(el) {
    if (!el) return;
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.mobile-nav.is-open, .cart-drawer.is-open').forEach(closeDrawer);
    }
  });

  /* ---------- Mobile nav ---------- */
  document.addEventListener('click', function (e) {
    var burger = e.target.closest('[data-mobile-nav-open]');
    if (burger) {
      e.preventDefault();
      openDrawer(document.querySelector('.mobile-nav'));
      return;
    }
    if (e.target.closest('[data-mobile-nav-close]')) {
      closeDrawer(document.querySelector('.mobile-nav'));
    }
  });

  /* ---------- Cart drawer ---------- */
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-cart-open]');
    if (opener) {
      e.preventDefault();
      openDrawer(document.getElementById('CartDrawer'));
      return;
    }
    if (e.target.closest('[data-cart-close]')) {
      closeDrawer(document.getElementById('CartDrawer'));
    }
  });

  /* ---------- Cart operations (Ajax with graceful fallback) ---------- */
  function cartCount() {
    var el = document.querySelector('[data-cart-count]');
    return el ? el : null;
  }

  function updateCartCount(count) {
    var el = cartCount();
    if (!el) return;
    el.textContent = count;
    el.style.display = count > 0 ? '' : 'none';
  }

  function refreshCartDrawer() {
    fetch(window.Shopify && window.Shopify.routes ? window.Shopify.routes.root + '?section_id=cart-drawer-content' : window.location.href)
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var fresh = doc.querySelector('[data-cart-drawer-content]');
        var target = document.querySelector('[data-cart-drawer-body] [data-cart-drawer-content]');
        if (fresh && target) {
          target.innerHTML = fresh.innerHTML;
        }
        var count = doc.querySelector('[data-cart-count-value]');
        if (count) updateCartCount(parseInt(count.textContent, 10) || 0);
      })
      .catch(function () { window.location.reload(); });
  }
  window.refreshCartDrawer = refreshCartDrawer;

  function addToCart(form) {
    var button = form.querySelector('[type="submit"]');
    var originalLabel = button ? button.textContent : '';
    if (button) {
      button.classList.add('is-disabled');
      button.setAttribute('aria-busy', 'true');
    }
    var formData = new FormData(form);
    fetch('/cart/add.js', { method: 'POST', body: formData })
      .then(function (r) {
        if (!r.ok) throw new Error('add failed');
        return r.json();
      })
      .then(function () {
        return fetch('/cart.js').then(function (r) { return r.json(); });
      })
      .then(function (cart) {
        updateCartCount(cart.item_count);
        if (config.cartType === 'drawer') {
          refreshCartDrawer();
          openDrawer(document.getElementById('CartDrawer'));
        } else {
          window.location.href = '/cart';
        }
      })
      .catch(function () { alert(config.strings.error || 'Unable to add to cart'); })
      .finally(function () {
        if (button) {
          button.classList.remove('is-disabled');
          button.removeAttribute('aria-busy');
          button.textContent = originalLabel;
        }
      });
  }

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[action*="/cart/add"]');
    if (!form) return;
    e.preventDefault();
    addToCart(form);
  });

  document.addEventListener('click', function (e) {
    /* Drawer line-item quantity + remove */
    var qtyBtn = e.target.closest('[data-line-qty]');
    if (qtyBtn) {
      var line = qtyBtn.closest('[data-line-index]');
      var index = line ? line.getAttribute('data-line-index') : null;
      var input = line ? line.querySelector('.quantity__input') : null;
      if (!index || !input) return;
      var value = parseInt(input.value, 10) + (qtyBtn.getAttribute('data-line-qty') === 'plus' ? 1 : -1);
      if (value < 0) value = 0;
      fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: parseInt(index, 10), quantity: value })
      })
        .then(function (r) { return r.json(); })
        .then(function (cart) {
          updateCartCount(cart.item_count);
          refreshCartDrawer();
        });
      return;
    }
    var remove = e.target.closest('[data-line-remove]');
    if (remove) {
      var lineEl = remove.closest('[data-line-index]');
      if (!lineEl) return;
      fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: parseInt(lineEl.getAttribute('data-line-index'), 10), quantity: 0 })
      })
        .then(function (r) { return r.json(); })
        .then(function (cart) {
          updateCartCount(cart.item_count);
          refreshCartDrawer();
        });
    }
  });

  /* Quantity steppers on cart page / product page (plain form submit) */
  document.addEventListener('click', function (e) {
    var stepper = e.target.closest('[data-qty-step]');
    if (!stepper) return;
    var wrap = stepper.closest('.quantity, .product-form__quantity');
    var input = wrap ? wrap.querySelector('.quantity__input') : null;
    if (!input) return;
    var value = parseInt(input.value, 10) || 1;
    value += stepper.getAttribute('data-qty-step') === 'plus' ? 1 : -1;
    if (value < (parseInt(input.getAttribute('min'), 10) || 0)) value = parseInt(input.getAttribute('min'), 10) || 0;
    input.value = value;
    if (input.closest('form') && input.closest('form').classList.contains('cart-form')) {
      input.closest('form').submit();
    }
  });

  /* ---------- Card carousels ---------- */
  document.querySelectorAll('[data-carousel]').forEach(function (carousel) {
    var track = carousel.querySelector('.card-carousel__track');
    if (!track) return;
    var step = function () {
      var card = track.querySelector(':scope > *');
      return card ? card.getBoundingClientRect().width + parseFloat(getComputedStyle(track).gap || 0) : 240;
    };
    var prev = carousel.querySelector('[data-carousel-prev]');
    var next = carousel.querySelector('[data-carousel-next]');
    if (prev) prev.addEventListener('click', function () { track.scrollBy({ left: -step(), behavior: 'smooth' }); });
    if (next) next.addEventListener('click', function () { track.scrollBy({ left: step(), behavior: 'smooth' }); });
  });

  /* ---------- Slideshow ---------- */
  document.querySelectorAll('[data-slideshow]').forEach(function (slideshow) {
    var slides = slideshow.querySelectorAll('.slideshow__slide');
    var track = slideshow.querySelector('.slideshow__slides');
    var counter = slideshow.querySelector('[data-slideshow-counter]');
    if (!track || slides.length < 2) return;
    var index = 0;
    function goTo(i) {
      index = (i + slides.length) % slides.length;
      track.style.transform = 'translateX(-' + index * 100 + '%)';
      if (counter) counter.textContent = (index + 1 < 10 ? '0' + (index + 1) : index + 1) + ' / ' + (slides.length < 10 ? '0' + slides.length : slides.length);
    }
    var prev = slideshow.querySelector('[data-slideshow-prev]');
    var next = slideshow.querySelector('[data-slideshow-next]');
    if (prev) prev.addEventListener('click', function () { goTo(index - 1); });
    if (next) next.addEventListener('click', function () { goTo(index + 1); });
    var autoplay = parseInt(slideshow.getAttribute('data-slideshow-autoplay'), 10);
    if (autoplay > 0) {
      setInterval(function () { goTo(index + 1); }, autoplay);
    }
    goTo(0);
  });

  /* ---------- Product media gallery ---------- */
  document.querySelectorAll('[data-gallery]').forEach(function (gallery) {
    var main = gallery.querySelector('[data-gallery-main] img');
    var thumbs = gallery.querySelectorAll('[data-gallery-thumb]');
    thumbs.forEach(function (thumb) {
      thumb.addEventListener('click', function (e) {
        var src = thumb.getAttribute('data-gallery-thumb');
        if (!src || !main) return;
        e.preventDefault();
        main.src = src;
        main.removeAttribute('srcset');
        thumbs.forEach(function (t) { t.classList.toggle('is-active', t === thumb); });
      });
    });
  });
})();
