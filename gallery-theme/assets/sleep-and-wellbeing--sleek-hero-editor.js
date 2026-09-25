/* Sleek hero — theme customizer support.
   Ported from Sleek v2.2.0 assets/theme-editor.js, trimmed to the two handlers
   the hero section needs.

   This MUST be loaded from layout/theme.liquid, not from the section itself.
   Shopify injects a re-rendered section as innerHTML, and the listener has to
   already exist at that moment — a copy living inside the section would not be
   registered yet the first time a merchant adds the hero to a page. */

document.addEventListener('shopify:section:load', (evt) => {
  const { target } = evt;

  // Scripts inserted via innerHTML are never executed by the browser. Re-append
  // them so a newly added section initializes without a full page reload.
  target.querySelectorAll('script[src]').forEach((script) => {
    const s = document.createElement('script');
    s.src = script.src;
    document.body.appendChild(s);
  });
});

document.addEventListener('shopify:block:select', (evt) => {
  const { target } = evt;

  if (!target.classList.contains('swiper-slide')) return;

  const sliderComponent = target.closest('slideshow-component');
  const slider = sliderComponent && sliderComponent.sliderInstance && sliderComponent.sliderInstance.slider;
  if (!slider) return;

  // Move the carousel to the slide the merchant selected in the sidebar.
  const index = target.dataset.swiperSlideIndex;
  if (slider.params.loop) {
    slider.slideToLoop(index);
  } else {
    slider.slideTo(index);
  }
});
