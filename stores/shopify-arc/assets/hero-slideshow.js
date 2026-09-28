(() => {
  function initHeroSlideshow(el) {
    if (typeof Swiper === 'undefined') return;

    const autoplay = el.dataset.autoplay === 'true';
    const loop = el.dataset.loop === 'true';
    const pauseOnHover = el.dataset.pauseOnHover === 'true';
    const delay = parseInt(el.dataset.autoplaySpeed, 10) || 6000;
    const speed = parseInt(el.dataset.speed, 10) || 600;
    const allowedEffects = ['slide', 'fade', 'coverflow', 'creative'];
    const rawEffect = el.dataset.effect;
    const effect = allowedEffects.includes(rawEffect) ? rawEffect : 'slide';
    const slideCount = el.querySelectorAll('.swiper-slide').length;

    // Swiper's loop mode duplicates slides and misbehaves with exactly 2 of them
    // (duplicates flash during the wrap-around transition). rewind gives the same
    // seamless feel by animating straight back to the first slide instead.
    const canLoop = loop && slideCount > 2;

    const config = {
      loop: canLoop,
      rewind: loop && slideCount > 1 && !canLoop,
      effect,
      fadeEffect: { crossFade: true },
      speed,
      // Arrows work at every width. This used to disable them below tablet
      // width ("touch is natural on mobile"), but Swiper only removes the
      // click handlers there while the theme CSS (equal specificity, later
      // source order) defeats the .swiper-button-lock { display: none } hide —
      // leaving buttons visible on mobile that did nothing when tapped.
      navigation: {
        nextEl: el.querySelector('.hero-slideshow__next'),
        prevEl: el.querySelector('.hero-slideshow__prev'),
      },
      pagination: el.querySelector('.hero-slideshow__pagination')
        ? { el: el.querySelector('.hero-slideshow__pagination'), clickable: true }
        : false,
      a11y: { enabled: true },
      keyboard: { enabled: true },
    };

    if (autoplay && slideCount > 1) {
      config.autoplay = {
        delay,
        disableOnInteraction: false,
        pauseOnMouseEnter: pauseOnHover,
      };
    }

    // 3D effect params (King-parity). slideShadows off — they assume dark
    // themes and look muddy over light slides.
    if (effect === 'coverflow') {
      config.coverflowEffect = { rotate: 22, stretch: 0, depth: 120, modifier: 1.6, slideShadows: false };
      config.centeredSlides = true;
    }
    if (effect === 'creative') {
      config.creativeEffect = {
        prev: { shadow: false, translate: ['-115%', 0, -500], opacity: 0 },
        next: { shadow: false, translate: ['115%', 0, -500], opacity: 0 },
      };
    }

    // eslint-disable-next-line no-new
    const swiper = new Swiper(el, config);

    initSlideTextReveal(el, swiper);

    // Swiper's built-in resize handling can miss viewport changes (notably inside
    // the theme editor's preview iframe), leaving slides at their old width so
    // images and content overflow the viewport — re-measure manually, with a
    // late second pass for resizes that land mid-reflow.
    let resizeTimer = null;
    const syncSize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        swiper.update();
        resizeTimer = window.setTimeout(() => swiper.update(), 300);
      }, 100);
    };
    window.addEventListener('resize', syncSize);
    let containerObserver = null;
    if ('ResizeObserver' in window) {
      containerObserver = new ResizeObserver(syncSize);
      containerObserver.observe(el);
    }

    const onSectionUnload = (event) => {
      if (!event.target || !event.target.contains(el)) return;
      document.removeEventListener('shopify:section:unload', onSectionUnload);
      window.removeEventListener('resize', syncSize);
      if (containerObserver) containerObserver.disconnect();
      swiper.destroy(true, true);
    };
    document.addEventListener('shopify:section:unload', onSectionUnload);
  }

  // Drives .is-revealed explicitly instead of leaning on Swiper's own
  // swiper-slide-active class - see the comment above the CSS rules in
  // hero-slideshow.css for why: a transition keyed on swiper-slide-active never
  // has an observable "before" frame for whichever slide starts active, since
  // Swiper's init confirms that class synchronously, before the first paint.
  function initSlideTextReveal(el, swiper) {
    function revealSlide(slide) {
      if (!slide) return;
      slide.classList.remove('is-revealed');
      // Force a reflow so a repeat visit to the same slide (remove immediately
      // followed by add) restarts the transition instead of the browser
      // coalescing both class changes into a single no-op recalc.
      void slide.offsetWidth; // eslint-disable-line no-unused-expressions
      slide.classList.add('is-revealed');
    }

    swiper.on('slideChangeTransitionStart', () => {
      const active = swiper.slides[swiper.activeIndex];
      swiper.slides.forEach((slide) => {
        if (slide !== active) slide.classList.remove('is-revealed');
      });
      revealSlide(active);
    });

    // Double rAF so the active slide genuinely paints once in its hidden,
    // CSS-authored state before .is-revealed is added - required for the
    // transition to have something to animate from on first load.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => revealSlide(swiper.slides[swiper.activeIndex]));
    });
  }

  // Keeps the nav/pagination bottom offset clear of the translucent trust bar,
  // whose height varies with content (1 vs 2 text lines, mobile stacking, etc).
  function initTrustBarOffset(el) {
    const bar = el.querySelector('[data-hero-trust-bar]');
    if (!bar || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(() => {
      el.style.setProperty('--hero-trust-bar-height', `${bar.offsetHeight}px`);
    });
    observer.observe(bar);
  }

  // Magnetic pull (King's MagnetButton port): the button lerps toward the
  // cursor at ~15% of cursor offset; the inner content counter-moves at 20%
  // for parallax. Fine-pointer + motion-safe only — touch and reduced-motion
  // users just get the normal button.
  function initMagneticButtons(el) {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.querySelectorAll('[data-magnet]').forEach((btn) => {
      if (btn.dataset.magnetBound) return;
      btn.dataset.magnetBound = 'true';
      const child = btn.firstElementChild;
      let raf = null;
      let cx = 0, cy = 0, tx = 0, ty = 0;
      const animate = () => {
        const easing = 0.15;
        const dx = tx - cx, dy = ty - cy;
        cx += dx * easing;
        cy += dy * easing;
        btn.style.transform = `translate(${cx}px, ${cy}px)`;
        // No child counter-move: the icon circle centers itself with a CSS
        // transform that inline JS writes would fight and corrupt.
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
          raf = requestAnimationFrame(animate);
        } else {
          raf = null;
          if (cx === 0 && cy === 0) btn.style.transform = '';
        }
      };
      btn.addEventListener('mousemove', (e) => {
        const rect = btn.getBoundingClientRect();
        const mx = (e.clientX - rect.left) / rect.offsetWidth - 0.5;
        const my = (e.clientY - rect.top) / rect.offsetHeight - 0.5;
        tx = mx * 0.15 * rect.offsetWidth;
        ty = my * 0.15 * rect.offsetHeight;
        if (!raf) raf = requestAnimationFrame(animate);
      });
      btn.addEventListener('mouseleave', () => {
        tx = 0;
        ty = 0;
        if (!raf) raf = requestAnimationFrame(animate);
      });
    });
  }

  document.querySelectorAll('[data-hero-slideshow]').forEach((el) => {
    initHeroSlideshow(el);
    initTrustBarOffset(el);
    initMagneticButtons(el);
  });

  document.addEventListener('shopify:section:load', (event) => {
    const el = event.target.querySelector('[data-hero-slideshow]');
    if (el) {
      initHeroSlideshow(el);
      initTrustBarOffset(el);
      initMagneticButtons(el);
    }
  });
})();
