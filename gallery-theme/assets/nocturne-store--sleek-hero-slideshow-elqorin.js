/* Elqorin hero controls (Editorial + Dark styles).
   Prefers the theme's Swiper instance; if it never shows up, a minimal
   internal driver keeps the slides moving so the section never locks up. */
(function () {
  'use strict';

  var RETRY_MS = 150;
  var RETRY_LIMIT = 40; /* ~6s before the fallback driver takes over */

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function init(root) {
    if (!root) return;
    if (
      !root.classList.contains('sleek-hero-section--elqorin-editorial') &&
      !root.classList.contains('sleek-hero-section--elqorin-dark')
    )
      return;
    if (root.dataset.elqorinControlsReady === 'true') return;

    var component = root.querySelector('slideshow-component');
    var controls = root.querySelector('.elqorin-hero-controls');
    if (!component || !controls) return;

    var prev = controls.querySelector('[data-elqorin-prev]');
    var next = controls.querySelector('[data-elqorin-next]');
    var current = controls.querySelector('[data-elqorin-current]');
    var total = controls.querySelector('[data-elqorin-total]');
    var progress = controls.querySelector('[data-elqorin-progress]');
    var count =
      Number(component.dataset.items) ||
      component.querySelectorAll('.swiper-slide').length ||
      1;

    if (total) total.textContent = pad(count);

    var started = false;

    function render(index) {
      if (current) current.textContent = pad(index + 1);
      if (progress) progress.style.width = ((index + 1) / count) * 100 + '%';
    }

    function findSwiper() {
      var candidate =
        component.sliderInstance &&
        (component.sliderInstance.slider || component.sliderInstance);
      if (candidate && typeof candidate.slideNext === 'function') return candidate;
      if (component.swiper && typeof component.swiper.slideNext === 'function')
        return component.swiper;
      var inner = component.querySelector('.swiper');
      if (inner && inner.swiper && typeof inner.swiper.slideNext === 'function')
        return inner.swiper;
      return null;
    }

    function startWithSwiper(slider) {
      if (started) return;
      started = true;
      root.dataset.elqorinControlsReady = 'true';

      var index = function () {
        return Number(slider.realIndex != null ? slider.realIndex : slider.activeIndex) || 0;
      };

      if (prev)
        prev.addEventListener('click', function () {
          slider.slidePrev();
          setTimeout(function () {
            render(index());
          }, 60);
        });
      if (next)
        next.addEventListener('click', function () {
          slider.slideNext();
          setTimeout(function () {
            render(index());
          }, 60);
        });

      if (typeof slider.on === 'function') {
        slider.on('realIndexChange', function () {
          render(index());
        });
        slider.on('slideChange', function () {
          render(index());
        });
      }

      render(index());
    }

    /* --- Fallback driver: used only if the theme's Swiper never appears --- */
    function startFallback() {
      if (started) return;
      started = true;
      root.dataset.elqorinControlsReady = 'true';

      var wrapper = component.querySelector('.swiper-wrapper');
      var slides = wrapper ? Array.prototype.slice.call(wrapper.children) : [];
      var index = 0;
      var timer = null;
      var autoplayDelay = Number(component.dataset.autoplay) || 0;

      function apply() {
        slides.forEach(function (slide, i) {
          slide.classList.toggle('swiper-slide-active', i === index);
          slide.classList.toggle('swiper-slide-visible', i === index);
        });
        if (wrapper) {
          wrapper.style.transition = 'transform .6s cubic-bezier(.4, 0, .2, 1)';
          wrapper.style.transform = 'translateX(-' + index * 100 + '%)';
        }
        render(index);
      }

      function go(target) {
        index = (target + slides.length) % slides.length;
        apply();
        restartAutoplay();
      }

      function restartAutoplay() {
        if (timer) clearInterval(timer);
        if (autoplayDelay > 0) {
          timer = setInterval(function () {
            go(index + 1);
          }, autoplayDelay);
        }
      }

      if (prev) prev.addEventListener('click', function () { go(index - 1); });
      if (next) next.addEventListener('click', function () { go(index + 1); });

      apply();
      restartAutoplay();

      /* If the theme's Swiper appears late, hand control back to it. */
      var recheck = setInterval(function () {
        var slider = findSwiper();
        if (!slider) return;
        clearInterval(recheck);
        if (timer) clearInterval(timer);
        if (wrapper) {
          wrapper.style.transform = '';
          wrapper.style.transition = '';
        }
        started = false;
        startWithSwiper(slider);
      }, 1000);
      setTimeout(function () {
        clearInterval(recheck);
      }, 30000);
    }

    var tries = 0;
    var poll = setInterval(function () {
      tries += 1;
      var slider = findSwiper();
      if (slider) {
        clearInterval(poll);
        startWithSwiper(slider);
      } else if (tries >= RETRY_LIMIT) {
        clearInterval(poll);
        startFallback();
      }
    }, RETRY_MS);

    if (!customElements.get('slideshow-component')) {
      customElements.whenDefined('slideshow-component').then(function () {
        /* polling continues and will pick the instance up once created */
      });
    }
  }

  function scan() {
    document
      .querySelectorAll(
        '.sleek-hero-section--elqorin-editorial, .sleek-hero-section--elqorin-dark'
      )
      .forEach(init);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  document.addEventListener('shopify:section:load', scan);
})();
