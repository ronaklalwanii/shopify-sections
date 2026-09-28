(() => {
  if (window.customElements.get('product-drawer')) return;

  class ProductDrawer extends theme.DrawerComponent {}
  customElements.define('product-drawer', ProductDrawer);

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  document.addEventListener('variant:change', (event) => {
    const picker = event.target.closest('.product');
    if (!picker) return;
    const variant = event.detail.variant;
    if (!variant) return;

    const inventoryTarget = picker.querySelector('[data-inventory-status]');
    const inventorySource = picker.querySelector(`[data-inventory-source="${variant.id}"]`);
    if (inventoryTarget && inventorySource) inventoryTarget.outerHTML = inventorySource.innerHTML;

    const pickupTarget = picker.querySelector('[data-pickup-wrapper]');
    const pickupSource = picker.querySelector(`[data-pickup-source="${variant.id}"]`);
    if (pickupTarget && pickupSource) pickupTarget.innerHTML = pickupSource.innerHTML;

    const quantityInput = picker.querySelector('[data-quantity-input]');
    if (quantityInput) {
      if (variant.quantity_rule_max) {
        quantityInput.max = variant.quantity_rule_max;
      } else {
        quantityInput.removeAttribute('max');
      }
    }

    const skuTarget = picker.querySelector('[data-variant-sku]');
    const skuSource = picker.querySelector(`[data-sku-source="${variant.id}"]`);
    if (skuTarget && skuSource) skuTarget.innerHTML = skuSource.innerHTML;

    // Sticky ATC bar lives outside .product (sibling), so look from the picker's section.
    const sectionRoot = picker.parentElement;
    if (sectionRoot) {
      const stickyPrice = sectionRoot.querySelector('[data-sticky-price]');
      const priceSource = event.target.querySelector(`[data-price-source="${variant.id}"]`);
      if (stickyPrice && priceSource) stickyPrice.innerHTML = priceSource.innerHTML;

      const stickyButton = sectionRoot.querySelector('[data-sticky-atc-button]');
      if (stickyButton) {
        stickyButton.disabled = !variant.available;
        stickyButton.textContent = variant.available
          ? stickyButton.dataset.addText || stickyButton.textContent
          : stickyButton.dataset.soldOutText || stickyButton.textContent;
      }
    }
  });

  document.addEventListener('click', (event) => {
    const stepper = event.target.closest('[data-quantity-step]');
    if (stepper) {
      const input = stepper.parentElement.querySelector('[data-quantity-input]');
      if (input) {
        const delta = Number(stepper.dataset.quantityStep);
        const min = Number(input.min) || 1;
        const max = input.max ? Number(input.max) : Infinity;
        const next = (parseInt(input.value, 10) || min) + delta;
        input.value = Math.min(max, Math.max(min, next));
      }
      return;
    }

    // Sticky bar ATC proxies the real form's submit button so quantity, variant
    // id and validation all flow through the normal add-to-cart path.
    const stickyButton = event.target.closest('[data-sticky-atc-button]');
    if (stickyButton) {
      const submit = document.querySelector('[data-buy-buttons-row] [type="submit"]');
      if (submit && !submit.disabled) submit.click();
    }
  });

  function initGallery(sectionRoot) {
    const media = sectionRoot.querySelector('.product__media');
    if (!media || media.dataset.galleryBound === 'true') return;
    media.dataset.galleryBound = 'true';

    const galleryScript = media.querySelector('[data-gallery-images]');
    const images = galleryScript ? JSON.parse(galleryScript.textContent) : null;
    if (!images) return;

    const counter = media.querySelector('[data-gallery-counter]');
    const counterCurrent = counter ? counter.querySelector('[data-counter-current]') : null;
    const dots = [...media.querySelectorAll('[data-gallery-dot]')];

    function updateCounter(index) {
      if (!counterCurrent) return;
      counterCurrent.textContent = String(((index % images.length) + images.length) % images.length + 1).padStart(2, '0');
    }

    function updateDots(index) {
      dots.forEach((dot) => dot.classList.toggle('is-active', Number(dot.dataset.index) === index));
    }

    const mainImg = media.querySelector('[data-gallery-main]');
    const thumbs = [...media.querySelectorAll('[data-gallery-thumb]')];

    const zoomRoot = sectionRoot.querySelector('[data-product-zoom]');
    const zoomImg = zoomRoot ? zoomRoot.querySelector('[data-zoom-image]') : null;

    function updateZoomImage(index) {
      if (!zoomImg) return;
      const target = images[index];
      zoomImg.src = target.zoom || target.src;
      zoomImg.alt = target.alt;
    }

    function showIndex(index) {
      const wrapped = ((index % images.length) + images.length) % images.length;
      updateCounter(wrapped);
      updateDots(wrapped);
      if (mainImg) {
        if (Number(mainImg.dataset.index) === wrapped) return;
        const target = images[wrapped];
        mainImg.classList.add('is-fading');
        window.setTimeout(() => {
          mainImg.src = target.src;
          mainImg.alt = target.alt;
          mainImg.dataset.index = String(wrapped);
          mainImg.classList.remove('is-fading');
        }, prefersReducedMotion.matches ? 0 : 200);
      }
      thumbs.forEach((thumb) => thumb.classList.toggle('is-active', Number(thumb.dataset.index) === wrapped));
      updateZoomImage(wrapped);
    }

    thumbs.forEach((thumb) => {
      thumb.addEventListener('click', () => showIndex(Number(thumb.dataset.index)));
      thumb.style.cursor = 'pointer';
    });
    dots.forEach((dot) => dot.addEventListener('click', () => showIndex(Number(dot.dataset.index))));

    const prevBtn = media.querySelector('[data-gallery-prev]');
    const nextBtn = media.querySelector('[data-gallery-next]');
    const currentIndex = () => (mainImg ? Number(mainImg.dataset.index) || 0 : 0);
    if (prevBtn) prevBtn.addEventListener('click', () => showIndex(currentIndex() - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => showIndex(currentIndex() + 1));

    updateCounter(0);
    updateDots(0);
    updateZoomImage(0);

    // Zoom lightbox
    const zoomTrigger = media.querySelector('[data-gallery-zoom]');
    if (zoomTrigger && zoomRoot) {
      const openZoom = () => {
        updateZoomImage(currentIndex());
        zoomRoot.hidden = false;
        document.documentElement.classList.add('product-zoom-open');
      };
      const closeZoom = () => {
        zoomRoot.hidden = true;
        document.documentElement.classList.remove('product-zoom-open');
      };
      zoomTrigger.addEventListener('click', openZoom);
      zoomRoot.querySelectorAll('[data-zoom-close]').forEach((el) => el.addEventListener('click', closeZoom));
      const zoomPrev = zoomRoot.querySelector('[data-zoom-prev]');
      const zoomNext = zoomRoot.querySelector('[data-zoom-next]');
      if (zoomPrev) zoomPrev.addEventListener('click', () => showIndex(currentIndex() - 1));
      if (zoomNext) zoomNext.addEventListener('click', () => showIndex(currentIndex() + 1));
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !zoomRoot.hidden) closeZoom();
      });
    }

    // Mobile swipeable gallery - Swiper below 750px, plain stacked markup above.
    // Initialized/destroyed on breakpoint change so the desktop fade gallery
    // and the swiper never fight over the same nodes.
    const swiperRoot = media.querySelector('[data-gallery-swiper]');
    let swiperInstance = null;

    function updateSwiper() {
      const isMobile = window.matchMedia('(max-width: 749px)').matches;
      if (isMobile && !swiperInstance && typeof Swiper !== 'undefined') {
        // eslint-disable-next-line no-new
        swiperInstance = new Swiper(swiperRoot, {
          slidesPerView: 1,
          speed: prefersReducedMotion.matches ? 0 : 400,
          grabCursor: true,
          watchOverflow: true,
          a11y: { enabled: true },
          keyboard: { enabled: true },
          on: {
            slideChange(instance) {
              updateCounter(instance.activeIndex);
              updateZoomImage(instance.activeIndex);
            },
          },
        });
      } else if (!isMobile && swiperInstance) {
        swiperInstance.destroy(true, true);
        swiperInstance = null;
        updateCounter(0);
      }
    }

    if (swiperRoot) {
      updateSwiper();
      window.matchMedia('(max-width: 749px)').addEventListener('change', updateSwiper);
    }
  }

  // Sticky ATC bar: appears once the buy area has scrolled out of view.
  function initStickyAtc(sectionRoot) {
    const bar = sectionRoot.querySelector('[data-sticky-atc]');
    const buyRow = sectionRoot.querySelector('[data-buy-buttons-row]');
    if (!bar || !buyRow || bar.dataset.stickyBound === 'true') return;
    bar.dataset.stickyBound = 'true';

    const button = bar.querySelector('[data-sticky-atc-button]');

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Show only once the buy area has scrolled PAST (above the viewport),
          // not when it simply hasn't been reached yet.
          bar.hidden = !(entry.boundingClientRect.top < 0 && !entry.isIntersecting);
        });
      },
      { threshold: 0 }
    );
    observer.observe(buyRow);

    const onSectionUnload = (event) => {
      if (!event.target || !event.target.contains(bar)) return;
      document.removeEventListener('shopify:section:unload', onSectionUnload);
      observer.disconnect();
    };
    document.addEventListener('shopify:section:unload', onSectionUnload);
  }

  function initSection(sectionRoot) {
    initGallery(sectionRoot);
    initStickyAtc(sectionRoot);
  }

  document.querySelectorAll('.product').forEach((product) => initSection(product.closest('[id]') || document));

  document.addEventListener('shopify:section:load', (event) => {
    const product = event.target.querySelector('.product');
    if (product) initSection(event.target);
  });
})();
