if (!customElements.get('slideshow-component')) {
  customElements.define(
    'slideshow-component',
    class SlideshowComponent extends HTMLElement {
      constructor() {
        super();

        this.sliderControls = this.querySelector('.swiper-controls');
        this.sliderInstance = false;
        this.layout = this.dataset.layout;
        this.items = Number(this.dataset.items);
      }

      connectedCallback() {
        if (this.sliderInstance) return;

        this.initSlider();

        if (this.classList.contains('slideshow-height--adapt')) {
          this.calcSlideHeight();
        }
      }

      static get observedAttributes() {
        return ['selected-index'];
      }

      get selectedIndex() {
        return parseInt(this.getAttribute('selected-index')) || 0;
      }

      set selectedIndex(index) {
        this.setAttribute('selected-index', `${index}`);
      }

      initSlider() {
        const additionModules = [FoxTheme.Swiper.Autoplay, FoxTheme.Swiper.EffectFade];

        this.sliderOptions = {
          slidesPerView: 1,
          spaceBetween: 10,
          loop: true,
          grabCursor: true,
          allowTouchMove: true,
          threshold: 2,
          effect: 'fade',
          on: {
            init: this.handleAfterInit.bind(this),
          },
          fadeEffect: {
            crossFade: true,
          },
        };

        if (this.sliderControls) {
          this.sliderOptions.pagination = {
            el: this.sliderControls.querySelector('.swiper-pagination'),
            clickable: true,
          };
        }

        switch (this.layout) {
          case 'centered':
            this.sliderOptions = {
              ...this.sliderOptions,
              centeredSlides: true,
              slidesPerView: 'auto',
              effect: 'slide',
            };
            break;
        }

        if (this.layout !== 'centered' && this.items === 1) {
          this.sliderOptions.loop = false;
          this.classList.remove('slideshow-controls-visible--yes');
        }

        const autoplayDelay = parseInt(this.dataset.autoplay);
        if (autoplayDelay > 0) {
          this.sliderOptions = {
            ...this.sliderOptions,
            autoplay: {
              delay: autoplayDelay,
              disableOnInteraction: false,
            },
          };
        }

        this.sliderInstance = new window.FoxTheme.Carousel(this, this.sliderOptions, additionModules);
        this.sliderInstance.init();

        this.sliderInstance.slider.on('realIndexChange', this.handleSlideChange.bind(this));
        this.selectedIndex = this.sliderInstance.slider.realIndex;

        if (this.sliderInstance) {
          if (this.layout === 'centered' && !FoxTheme.config.mqlMobile) {
            const motionTextElements = Array.from(this.querySelectorAll('motion-element[data-text]'));
            motionTextElements &&
              motionTextElements.forEach((motionTextElement) => {
              if (
                typeof motionTextElement.resetAnimation === 'function' &&
                !motionTextElement.closest('.swiper-slide-active')
              ) {
                motionTextElement.resetAnimation();
              }
            });
          }
          this.selectedElement = this.sliderInstance.slider.slides[this.sliderInstance.slider.activeIndex];
          this.onReady(this.selectedElement, this.sliderInstance.slider.slides);
          // Fix accessibility
          const focusableElements = FoxTheme.a11y.getFocusableElements(this);
          if (this.layout === 'centered') {
            focusableElements.forEach((element) => {
              element.addEventListener('focusin', () => {
                const slide = element.closest('.swiper-slide');
                const slideToIndex = this.sliderInstance.slider.slides.indexOf(slide);
                this.sliderInstance.slider.slideToLoop(slideToIndex);
              });
            });
          } else {
            focusableElements.forEach((element) => {
              element.addEventListener('focusin', () => {
                const slide = element.closest('.swiper-slide');
                this.sliderInstance.slider.slideTo(this.sliderInstance.slider.slides.indexOf(slide));
              });
            });
          }
        }
      }

      onReady(selectedElement) {
        if (selectedElement.dataset.type === 'video') {
          const videoElement = FoxTheme.utils.displayedMedia(selectedElement.querySelectorAll('video-element'));
          videoElement?.play();
        }

        if (!FoxTheme.config.motionReduced) {
          const motionEls = selectedElement.querySelectorAll('motion-element');
          motionEls.forEach((motionEl) => {
            if (!motionEl || motionEl.classList.contains('is-animated')) return;

            motionEl.removeAttribute('hold');
            motionEl.preInitialize();

            setTimeout(() => {
              motionEl.initialize();
            });
          });
        }

        this.removeAttribute('data-media-loading');
      }

      handleAfterInit() {
        // Fix active bullet not transition on the first time.
        if (this.sliderControls) {
          const activeBullet = this.sliderControls.querySelector('.swiper-pagination-bullet-active');

          if (activeBullet) {
            activeBullet.classList.remove('swiper-pagination-bullet-active');
            activeBullet.offsetHeight; // Trigger reflow.
            activeBullet.classList.add('swiper-pagination-bullet-active');
          }
        }
      }

      handleSlideChange(swiper) {
        const { slides, realIndex, activeIndex } = swiper;
        this.selectedIndex = realIndex;

        this.updateControlsScheme(slides[activeIndex]);
      }

      attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'selected-index' && oldValue !== null && oldValue !== newValue) {
          const fromElements = this.querySelectorAll(`[data-swiper-slide-index="${oldValue}"]`);
          const toElements = this.querySelectorAll(`[data-swiper-slide-index="${newValue}"]`);

          fromElements.forEach((fromElement) => {
            if (fromElement.dataset.type === 'video') {
              const videoElement = FoxTheme.utils.displayedMedia([fromElement.querySelector('video-element')]);
              videoElement && videoElement.pause();
            }

            const motionEls = fromElement.querySelectorAll('motion-element');
            motionEls.forEach((motionEl) => {
              if (motionEl.hasAttribute('data-text')) {
                motionEl.resetAnimation();
              }
            });
          });

          toElements.forEach((toElement) => {
            setTimeout(() => {
              if (toElement.classList.contains('swiper-slide-active')) {
                if (toElement.dataset.type === 'video') {
                  const videoElement = FoxTheme.utils.displayedMedia([toElement.querySelector('video-element')]);
                  videoElement && videoElement.play();
                }

                const motionEls = toElement.querySelectorAll('motion-element');
                motionEls.forEach((motionEl) => {
                  motionEl && motionEl.refreshAnimation();
                });
              }
            });
          });
        }
      }

      updateControlsScheme(activeSlide) {
        if (this.sliderControls) {
          const classesToRemove = Array.from(this.sliderControls.classList).filter((className) =>
            className.startsWith('color-')
          );
          classesToRemove.forEach((className) => this.sliderControls.classList.remove(className));
          const colorScheme = activeSlide.dataset.colorScheme;
          this.sliderControls.classList.add(colorScheme);
        }
      }

      calcSlideHeight() {
        let maxHeight = 0;
        const slides = this.querySelectorAll('.swiper-slide');
        slides &&
          slides.forEach((slide) => {
            const slideText = slide.querySelector('.slideshow__text');
            if (slideText) {
              const slideTextHeight = slideText.offsetHeight;
              if (slideTextHeight > maxHeight) {
                maxHeight = slideTextHeight;
              }
            }
          });

        if (this.classList.contains('slideshow-controls-position--bottom')) {
          maxHeight += 100; // Avoid overlap with dots.
        }

        this.style.setProperty('--slide-height', maxHeight + 'px');
      }
    }
  );
}
