(() => {
  function initEditorialStrip(el) {
    if (typeof Swiper === 'undefined') return;
    if (el.dataset.swiperBound === 'true') return;

    const gap = parseInt(el.dataset.gap, 10) || 0;
    const speed = parseInt(el.dataset.speed, 10) || 600;

    const swiper = new Swiper(el, {
      slidesPerView: 'auto',
      spaceBetween: gap,
      speed,
      grabCursor: true,
      watchOverflow: true,
      // Deliberately no pagination, navigation, or autoplay — images sit side
      // by side and a tap brings the clicked one into view.
      a11y: { enabled: true },
      keyboard: { enabled: true },
      on: {
        // Swiper suppresses its click event after a drag, so this only fires
        // for genuine taps.
        click(swiperInstance, event) {
          const frame = event.target.closest('.editorial-strip__frame');
          if (!frame) return;
          const slide = frame.closest('.swiper-slide');
          const index = Array.from(swiperInstance.slides).indexOf(slide);
          if (index > -1) swiperInstance.slideTo(index, speed);
        },
      },
    });

    el.dataset.swiperBound = 'true';

    const onSectionUnload = (event) => {
      if (!event.target || !event.target.contains(el)) return;
      document.removeEventListener('shopify:section:unload', onSectionUnload);
      el.dataset.swiperBound = 'false';
      swiper.destroy(true, true);
    };
    document.addEventListener('shopify:section:unload', onSectionUnload);
  }

  document.querySelectorAll('[data-editorial-strip]').forEach(initEditorialStrip);

  document.addEventListener('shopify:section:load', (event) => {
    const el = event.target.querySelector('[data-editorial-strip]');
    if (el) initEditorialStrip(el);
  });
})();
