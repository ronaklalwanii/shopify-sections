/* Sleek hero core — extracted from Sleek v2.2.0 theme.js
   Includes: FoxTheme.config / a11y / utils / pubsub / Carousel,
   <video-element> and <motion-element>. Swiper itself lives in sleek-hero-vendor.js.

   NOT verbatim. Three deliberate divergences from Sleek, marked inline — do not
   undo them when re-syncing against a newer Sleek release:
     1. Sleek's global `touchend` fast-click handler is removed (it hijacked taps
        on every button and link in the Change theme).
     2. The whole file is wrapped in the load-once guard below, so a page with two
        hero sections doesn't re-declare VideoElement/MotionElement or call
        customElements.define twice.
     3. The two translateY(2.5rem) motion offsets are rebased to 1.5625rem to
        match sleek-hero.css against Change's 16px root. */
if (!window.__sleekHeroCoreLoaded) {
  window.__sleekHeroCoreLoaded = true;

window.FoxTheme = window.FoxTheme || {};
FoxTheme.config = {
  hasLocalStorage: false,
  mqlMobile: false,
  mqlTablet: false,
  mediaQueryMobile: 'screen and (max-width: 767px)',
  mediaQueryTablet: 'screen and (max-width: 1023px)',
  motionReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  isTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0,
  isRTL: document.documentElement.getAttribute('dir') === 'rtl',
};
(function () {
  // Detect browser has support local storage.
  try {
    const key = 'sleek:test';
    window.localStorage.setItem(key, 'test');
    window.localStorage.removeItem(key);
    FoxTheme.config.hasLocalStorage = true;
  } catch (err) {}

  FoxTheme.DOMready = function (callback) {
    document.readyState != 'loading' ? callback() : document.addEventListener('DOMContentLoaded', callback);
  };

  FoxTheme.a11y = {
    trapFocusHandlers: {},
    getFocusableElements: (container) => {
      return Array.from(
        container.querySelectorAll(
          "summary, a[href], button:enabled, [tabindex]:not([tabindex^='-']), [draggable], area, input:not([type=hidden]):enabled, select:enabled, textarea:enabled, object, iframe"
        )
      );
    },
    trapFocus: (container, elementToFocus = container) => {
      var elements = FoxTheme.a11y.getFocusableElements(container);
      var first = elements[0];
      var last = elements[elements.length - 1];

      FoxTheme.a11y.removeTrapFocus();

      FoxTheme.a11y.trapFocusHandlers.focusin = (event) => {
        if (event.target !== container && event.target !== last && event.target !== first) return;

        document.addEventListener('keydown', FoxTheme.a11y.trapFocusHandlers.keydown);
      };

      FoxTheme.a11y.trapFocusHandlers.focusout = function () {
        document.removeEventListener('keydown', FoxTheme.a11y.trapFocusHandlers.keydown);
      };

      FoxTheme.a11y.trapFocusHandlers.keydown = function (event) {
        if (event.code.toUpperCase() !== 'TAB') return; // If not TAB key
        // On the last focusable element and tab forward, focus the first element.
        if (event.target === last && !event.shiftKey) {
          event.preventDefault();
          first.focus();
        }

        //  On the first focusable element and tab backward, focus the last element.
        if ((event.target === container || event.target === first) && event.shiftKey) {
          event.preventDefault();
          last.focus();
        }
      };

      document.addEventListener('focusout', FoxTheme.a11y.trapFocusHandlers.focusout);
      document.addEventListener('focusin', FoxTheme.a11y.trapFocusHandlers.focusin);

      elementToFocus.focus();

      if (
        elementToFocus.tagName === 'INPUT' &&
        ['search', 'text', 'email', 'url'].includes(elementToFocus.type) &&
        elementToFocus.value
      ) {
        elementToFocus.setSelectionRange(0, elementToFocus.value.length);
      }
    },
    removeTrapFocus: (elementToFocus = null) => {
      document.removeEventListener('focusin', FoxTheme.a11y.trapFocusHandlers.focusin);
      document.removeEventListener('focusout', FoxTheme.a11y.trapFocusHandlers.focusout);
      document.removeEventListener('keydown', FoxTheme.a11y.trapFocusHandlers.keydown);

      if (elementToFocus) elementToFocus.focus();
    },
  };

  FoxTheme.utils = {
    throttle: (callback) => {
      let requestId = null,
        lastArgs;
      const later = (context) => () => {
        requestId = null;
        callback.apply(context, lastArgs);
      };
      const throttled = (...args) => {
        lastArgs = args;
        if (requestId === null) {
          requestId = requestAnimationFrame(later(this));
        }
      };
      throttled.cancel = () => {
        cancelAnimationFrame(requestId);
        requestId = null;
      };
      return throttled;
    },
    setScrollbarWidth: () => {
      const scrollbarWidth = window.innerWidth - document.body.clientWidth;
      scrollbarWidth > 0 && document.documentElement.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
    },
    waitForEvent: (element, eventName) => {
      return new Promise((resolve) => {
        // Event handler that checks if the event target is the expected element
        const eventHandler = (event) => {
          if (event.target === element) {
            element.removeEventListener(eventName, eventHandler); // Clean up listener
            resolve(event); // Resolve the promise with the event
          }
        };

        // Attach the event handler to the element
        element.addEventListener(eventName, eventHandler);
      });
    },
    queryDomNodes: (selectors = {}, context = document) => {
      const domNodes = Object.entries(selectors).reduce((acc, [name, selector]) => {
        const findOne = typeof selector === 'string';
        const queryMethod = findOne ? 'querySelector' : 'querySelectorAll';
        const sl = findOne ? selector : selector[0];

        acc[name] = context && context[queryMethod](sl);
        if (!findOne && acc[name]) {
          acc[name] = [...acc[name]];
        }
        return acc;
      }, {});
      return domNodes;
    },
    addEventDelegate: ({ context = document.documentElement, event = 'click', selector, handler, capture = false }) => {
      const listener = function (e) {
        // loop parent nodes from the target to the delegation node
        for (let target = e.target; target && target !== this; target = target.parentNode) {
          if (target.matches(selector)) {
            handler.call(target, e, target);
            break;
          }
        }
      };
      context.addEventListener(event, listener, capture);
      return () => {
        context.removeEventListener(event, listener, capture);
      };
    },
    getSectionId: (element) => {
      if (element.hasAttribute('data-section-id')) {
        return element.dataset.sectionId;
      } else {
        if (!element.classList.contains('shopify-section')) {
          element = element.closest('.shopify-section');
        }
        return element.id.replace('shopify-section-', '');
      }
    },
    debounce: (fn, wait) => {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
      };
    },
    fetchConfig: (type = 'json', method = 'POST') => {
      return {
        method,
        headers: { 'Content-Type': 'application/json', Accept: `application/${type}` },
      };
    },
    /**
     * Store key-value pair with expiration time in localStorage
     * Use storage instead of cookie to make it work properly on Safari IOS (in iframe).
     */
    setStorage(key, value, expiryInDays) {
      if (!FoxTheme.config.hasLocalStorage) return;

      const now = new Date();
      const item = {
        value: value,
        expiry: now.getTime() + expiryInDays * 86400000,
      };
      window.localStorage.setItem(key, JSON.stringify(item));
    },
    getStorage(key) {
      if (!FoxTheme.config.hasLocalStorage) return null;

      const itemStr = window.localStorage.getItem(key);
      // If the item doesn't exist, return null.
      if (!itemStr) {
        return null;
      }
      const item = JSON.parse(itemStr);
      const now = new Date();
      // Compare the expiry time of the item with the current time.
      if (now.getTime() > item.expiry) {
        // If the item has expired, remove it from storage and return null.
        window.localStorage.removeItem(key);
        return null;
      }
      return item.value;
    },
    postLink: (path, options) => {
      options = options || {};
      const method = options['method'] || 'post';
      const params = options['parameters'] || {};

      const form = document.createElement('form');
      form.setAttribute('method', method);
      form.setAttribute('action', path);

      for (const key in params) {
        for (const index in params[key]) {
          for (const key2 in params[key][index]) {
            const hiddenField = document.createElement('input');
            hiddenField.setAttribute('type', 'hidden');
            hiddenField.setAttribute('name', `${key}[${index}][${key2}]`);
            hiddenField.setAttribute('value', params[key][index][key2]);
            form.appendChild(hiddenField);
          }
        }
      }
      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);
    },
    imageReady: (imageOrArray) => {
      if (!imageOrArray) {
        return Promise.resolve();
      }
      imageOrArray = imageOrArray instanceof Element ? [imageOrArray] : Array.from(imageOrArray);
      return Promise.all(
        imageOrArray.map((image) => {
          return new Promise((resolve) => {
            if ((image.tagName === 'IMG' && image.complete) || !image.offsetParent) {
              resolve();
            } else {
              image.onload = () => resolve();
            }
          });
        })
      );
    },
    displayedMedia: (media) => {
      return Array.from(media).find((item) => {
        const style = window.getComputedStyle(item);
        return style.display !== 'none';
      });
    },
    getGridColumnGap: (container) => {
      const gapByDevice = {};
      const gapCSSVariables = {
        desktop: '--column-gap',
        tabletLarge: '--column-gap-tablet-large',
        tablet: '--column-gap-tablet',
        mobile: '--column-gap-mobile',
      };

      const computedStyles = window.getComputedStyle(container);

      for (const [device, cssVar] of Object.entries(gapCSSVariables)) {
        const rawValue = computedStyles.getPropertyValue(cssVar).trim();
        const match = rawValue.match(/^(\d*\.?\d+)(px|rem)$/);

        let numericGap = 0;
        if (match) {
          const [originalValue, numberStr, unit] = match;
          numericGap = unit === 'rem' ? parseFloat(numberStr) * 10 : parseFloat(numberStr);
        }

        gapByDevice[device] = numericGap;
      }

      return gapByDevice;
    },
  };

  FoxTheme.pubsub = {
    PUB_SUB_EVENTS: {
      cartUpdate: 'cart-update',
      quantityUpdate: 'quantity-update',
      quantityRules: 'quantity-rules',
      quantityBoundries: 'quantity-boundries',
      variantChange: 'variant-change',
      cartError: 'cart-error',
      facetUpdate: 'facet-update',
      optionValueSelectionChange: 'option-value-selection-change',
    },
    subscribers: {},
    subscribe: (eventName, callback) => {
      if (FoxTheme.pubsub.subscribers[eventName] === undefined) {
        FoxTheme.pubsub.subscribers[eventName] = [];
      }

      FoxTheme.pubsub.subscribers[eventName] = [...FoxTheme.pubsub.subscribers[eventName], callback];

      return function unsubscribe() {
        FoxTheme.pubsub.subscribers[eventName] = FoxTheme.pubsub.subscribers[eventName].filter((cb) => {
          return cb !== callback;
        });
      };
    },

    publish: (eventName, data) => {
      if (FoxTheme.pubsub.subscribers[eventName]) {
        FoxTheme.pubsub.subscribers[eventName].forEach((callback) => {
          callback(data);
        });
      }
    },
  };

  FoxTheme.focusVisiblePolyfill = function () {
    const navKeys = [
      'ARROWUP',
      'ARROWDOWN',
      'ARROWLEFT',
      'ARROWRIGHT',
      'TAB',
      'ENTER',
      'SPACE',
      'ESCAPE',
      'HOME',
      'END',
      'PAGEUP',
      'PAGEDOWN',
    ];
    let currentFocusedElement = null;
    let mouseClick = null;

    window.addEventListener('keydown', (event) => {
      if (navKeys.includes(event.code.toUpperCase())) {
        mouseClick = false;
      }
    });

    window.addEventListener('mousedown', (event) => {
      mouseClick = true;
    });

    window.addEventListener(
      'focus',
      () => {
        if (currentFocusedElement) currentFocusedElement.classList.remove('focused');

        if (mouseClick) return;

        currentFocusedElement = document.activeElement;
        currentFocusedElement.classList.add('focused');
      },
      true
    );
  };

  FoxTheme.Carousel = (function () {
    class Carousel {
      constructor(container, options, modules = null) {
        this.container = container;
        let defaultModules = [
          FoxTheme.Swiper.Navigation,
          FoxTheme.Swiper.Pagination,
          FoxTheme.Swiper.Keyboard,
          FoxTheme.Swiper.Mousewheel,
        ];
        if (modules) {
          defaultModules = defaultModules.concat(modules);
        }

        this.options = {
          modules: defaultModules,
          ...options,
        };
      }

      init() {
        this.slider = new FoxTheme.Swiper.Swiper(this.container, this.options);
      }
    }
    return Carousel;
  })();

  FoxTheme.delayUntilInteraction = (function () {
    class ScriptLoader {
      constructor(callback, delay = 5000) {
        this.loadScriptTimer = setTimeout(callback, delay);
        this.userInteractionEvents = [
          'mouseover',
          'mousemove',
          'keydown',
          'touchstart',
          'touchend',
          'touchmove',
          'wheel',
        ];

        this.onScriptLoader = this.triggerScriptLoader.bind(this, callback);
        this.userInteractionEvents.forEach((event) => {
          window.addEventListener(event, this.onScriptLoader, {
            passive: !0,
          });
        });
      }

      triggerScriptLoader(callback) {
        callback();
        clearTimeout(this.loadScriptTimer);
        this.userInteractionEvents.forEach((event) => {
          window.removeEventListener(event, this.onScriptLoader, {
            passive: !0,
          });
        });
      }
    }

    return ScriptLoader;
  })();

  FoxTheme.Currency = (function () {
    const moneyFormat = '${{amount}}'; // eslint-disable-line camelcase

    function formatMoney(cents, format) {
      if (typeof cents === 'string') {
        cents = cents.replace('.', '');
      }
      let value = '';
      const placeholderRegex = /\{\{\s*(\w+)\s*\}\}/;
      const formatString = format || moneyFormat;

      function formatWithDelimiters(number, precision, thousands, decimal) {
        thousands = thousands || ',';
        decimal = decimal || '.';

        if (isNaN(number) || number === null) {
          return 0;
        }

        number = (number / 100.0).toFixed(precision);

        const parts = number.split('.');
        const dollarsAmount = parts[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1' + thousands);
        const centsAmount = parts[1] ? decimal + parts[1] : '';

        return dollarsAmount + centsAmount;
      }

      switch (formatString.match(placeholderRegex)[1]) {
        case 'amount':
          value = formatWithDelimiters(cents, 2);
          break;
        case 'amount_no_decimals':
          value = formatWithDelimiters(cents, 0);
          break;
        case 'amount_with_comma_separator':
          value = formatWithDelimiters(cents, 2, '.', ',');
          break;
        case 'amount_no_decimals_with_comma_separator':
          value = formatWithDelimiters(cents, 0, '.', ',');
          break;
        case 'amount_no_decimals_with_space_separator':
          value = formatWithDelimiters(cents, 0, ' ');
          break;
        case 'amount_with_apostrophe_separator':
          value = formatWithDelimiters(cents, 2, "'");
          break;
      }

      return formatString.replace(placeholderRegex, value);
    }

    function getBaseUnit(variant) {
      if (!variant) {
        return;
      }

      if (!variant.unit_price_measurement || !variant.unit_price_measurement.reference_value) {
        return;
      }

      return variant.unit_price_measurement.reference_value === 1
        ? variant.unit_price_measurement.reference_unit
        : variant.unit_price_measurement.reference_value + variant.unit_price_measurement.reference_unit;
    }

    return {
      formatMoney: formatMoney,
      getBaseUnit: getBaseUnit,
    };
  })();

  new FoxTheme.delayUntilInteraction(() => {
    document.body.removeAttribute('data-initializing');
  });

  // DIVERGENCE 1 (see file header): Sleek's document-level fast-click handler
  // was removed here. It intercepted `touchend` on every `button, a` in the
  // whole page and re-dispatched a synthetic click, which hijacked taps across
  // the rest of the Change theme. Modern browsers have no 300ms delay to fix.

  FoxTheme.DOMready(FoxTheme.utils.setScrollbarWidth);
  // window.addEventListener('resize', FoxTheme.utils.throttle(FoxTheme.utils.setScrollbarWidth));

  const mql = window.matchMedia(FoxTheme.config.mediaQueryMobile);
  FoxTheme.config.mqlMobile = mql.matches;
  mql.onchange = (event) => {
    if (event.matches) {
      FoxTheme.config.mqlMobile = true;
      document.dispatchEvent(new CustomEvent('matchMobile'));
    } else {
      FoxTheme.config.mqlMobile = false;
      document.dispatchEvent(new CustomEvent('unmatchMobile'));
    }
  };

  const mqlTablet = window.matchMedia(FoxTheme.config.mediaQueryTablet);
  FoxTheme.config.mqlTablet = mqlTablet.matches;
  mqlTablet.onchange = (event) => {
    if (event.matches) {
      FoxTheme.config.mqlTablet = true;
      document.dispatchEvent(new CustomEvent('matchTablet'));
    } else {
      FoxTheme.config.mqlTablet = false;
      document.dispatchEvent(new CustomEvent('unmatchTablet'));
    }
  };
})();

// Here run the querySelector to figure out if the browser supports :focus-visible or not and run code based on it.
try {
  document.querySelector(':focus-visible');
} catch (e) {
  FoxTheme.focusVisiblePolyfill();
}

class VideoElement extends HTMLElement {
  constructor() {
    super();

    if (this.posterElement) {
      this.posterElement.addEventListener('click', this.handlePosterClick.bind(this));
    }

    if (this.autoplay) {
      FoxTheme.Motion.inView(this, () => {
        if (!this.paused) {
          this.play();
        }

        return () => {
          this.pause();
        };
      });
    }
  }

  get posterElement() {
    return this.querySelector('[id^="DeferredPoster-"]');
  }

  get controlledElement() {
    return this.hasAttribute('aria-controls') ? document.getElementById(this.getAttribute('aria-controls')) : null;
  }

  get autoplay() {
    return this.hasAttribute('autoplay');
  }

  get playing() {
    return this.hasAttribute('playing');
  }

  get player() {
    return (this.playerProxy =
      this.playerProxy ||
      new Proxy(this.initializePlayer(), {
        get: (target, prop) => {
          return async () => {
            target = await target;
            this.handlePlayerAction(target, prop);
          };
        },
      }));
  }

  static get observedAttributes() {
    return ['playing'];
  }

  handlePosterClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (this.playing) {
      this.paused = true;
      this.pause();
    } else {
      this.paused = false;
      this.play();
    }
  }

  play() {
    if (!this.playing) {
      this.player.play();
    }
  }

  pause() {
    if (this.playing) {
      this.player.pause();
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'playing') {
      if (oldValue === null && newValue === '') {
        return this.dispatchEvent(new CustomEvent('video:play', { bubbles: true }));
      }

      if (newValue === null) {
        return this.dispatchEvent(new CustomEvent('video:pause', { bubbles: true }));
      }
    }
  }

  initializePlayer() {
    if (this.hasAttribute('source')) {
      this.setAttribute('loaded', '');
      this.closest('.media')?.classList.remove('loading');

      return new Promise(async (resolve) => {
        const templateElement = this.querySelector('template');
        if (templateElement) {
          templateElement.replaceWith(templateElement.content.firstElementChild.cloneNode(true));
        }
        const muteVideo = this.hasAttribute('autoplay') || window.matchMedia('screen and (max-width: 1023px)').matches;
        const script = document.createElement('script');
        script.type = 'text/javascript';
        if (this.getAttribute('source') === 'youtube') {
          if (!window.YT || !window.YT.Player) {
            script.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(script);
            await new Promise((resolve2) => {
              script.onload = resolve2;
            });
          }
          await onYouTubeApiLoaded;
          const player = new YT.Player(this.querySelector('iframe'), {
            events: {
              onReady: () => {
                if (muteVideo) {
                  player.mute();
                }
                resolve(player);
              },
              onStateChange: (event) => {
                if (event.data === YT.PlayerState.PLAYING) {
                  this.setAttribute('playing', '');
                } else if (event.data === YT.PlayerState.ENDED || event.data === YT.PlayerState.PAUSED) {
                  this.removeAttribute('playing');
                }
              },
            },
          });
        }
        if (this.getAttribute('source') === 'vimeo') {
          if (!window.Vimeo || !window.Vimeo.Player) {
            script.src = 'https://player.vimeo.com/api/player.js';
            document.head.appendChild(script);
            await new Promise((resolve2) => {
              script.onload = resolve2;
            });
          }
          const player = new Vimeo.Player(this.querySelector('iframe'));
          if (muteVideo) {
            player.setMuted(true);
          }
          player.on('play', () => {
            this.setAttribute('playing', '');
          });
          player.on('pause', () => this.removeAttribute('playing'));
          player.on('ended', () => this.removeAttribute('playing'));
          resolve(player);
        }
      });
    } else {
      this.appendChild(this.querySelector('template').content.firstElementChild.cloneNode(true));
      this.setAttribute('loaded', '');
      this.closest('.media')?.classList.remove('loading');

      const player = this.querySelector('video');
      player.addEventListener('play', () => {
        this.setAttribute('playing', '');
        this.removeAttribute('suspended');
      });
      player.addEventListener('pause', () => {
        if (!player.seeking && player.paused) {
          this.removeAttribute('playing');
        }
      });
      return player;
    }
  }

  handlePlayerAction(target, prop) {
    if (this.getAttribute('source') === 'youtube') {
      prop === 'play' ? target.playVideo() : target.pauseVideo();
    } else {
      if (prop === 'play' && !this.hasAttribute('source')) {
        target.play().catch((error) => {
          if (error.name === 'NotAllowedError') {
            this.setAttribute('suspended', '');
            target.controls = true;
            const replacementImageSrc = target.previousElementSibling?.currentSrc;
            if (replacementImageSrc) {
              target.poster = replacementImageSrc;
            }
          }
        });
      } else {
        target[prop]();
      }
    }
  }
}
customElements.define('video-element', VideoElement);

class MotionElement extends HTMLElement {
  constructor() {
    super();
    this.preInitialize();
  }

  connectedCallback() {
    if (FoxTheme.config.motionReduced) return;
    FoxTheme.Motion.inView(
      this,
      async () => {
        if (!this.isInstant && this.media) await FoxTheme.utils.imageReady(this.media);
        this.initialize();
      },
      { margin: '0px 0px -50px 0px' }
    );
  }

  get isHold() {
    return this.hasAttribute('hold');
  }

  get isInstant() {
    return this.hasAttribute('data-instantly');
  }

  get mediaElements() {
    return Array.from(this.querySelectorAll('img, iframe, svg'));
  }

  get animationType() {
    return this.dataset.motion || 'fade-up';
  }

  get animationDelay() {
    return parseInt(this.dataset.motionDelay || 0) / 1000;
  }

  preInitialize() {
    if (this.isHold || FoxTheme.config.motionReduced) return;
    switch (this.animationType) {
      case 'fade-in':
        FoxTheme.Motion.animate(this, { opacity: 0.01 }, { duration: 0 });
        break;

      case 'fade-up':
        FoxTheme.Motion.animate(this, { transform: 'translateY(1.5625rem)', opacity: 0.01 }, { duration: 0 });
        break;

      case 'zoom-in':
        FoxTheme.Motion.animate(this, { transform: 'scale(0.8)' }, { duration: 0 });
        break;
      case 'zoom-in-lg':
        FoxTheme.Motion.animate(this, { transform: 'scale(0)' }, { duration: 0 });
        break;

      case 'zoom-out':
        FoxTheme.Motion.animate(this, { transform: 'scale(1.3)' }, { duration: 0 });
        break;

      case 'zoom-out-sm':
        FoxTheme.Motion.animate(this, { transform: 'scale(1.1)' }, { duration: 0 });
    }
  }

  async initialize() {
    if (this.isHold || this._animating || FoxTheme.config.motionReduced) return;
    this._animating = true;

    switch (this.animationType) {
      case 'fade-in':
        await FoxTheme.Motion.animate(
          this,
          { opacity: 1 },
          { duration: 1.5, delay: this.animationDelay, easing: [0, 0, 0.3, 1] }
        ).finished;
        break;

      case 'fade-up':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'translateY(0)', opacity: 1 },
          { duration: 0.5, delay: this.animationDelay, easing: [0, 0, 0.3, 1] }
        ).finished;
        break;

      case 'zoom-in':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(1)' },
          { duration: 1.3, delay: this.animationDelay, easing: [0, 0, 0.3, 1] }
        ).finished;
        break;

      case 'zoom-in-lg':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(1)' },
          { duration: 0.5, delay: this.animationDelay, easing: [0, 0, 0.3, 1] }
        ).finished;
        break;

      case 'zoom-out':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(1)' },
          { duration: 1.5, delay: this.animationDelay, easing: [0, 0, 0.3, 1] }
        ).finished;
        break;

      case 'zoom-out-sm':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(1)' },
          { duration: 1, delay: this.animationDelay, easing: [0, 0, 0.3, 1] }
        ).finished;
        break;
    }

    this._animating = false;
    this.classList.add('is-animated');
  }

  async resetAnimation(duration) {
    switch (this.animationType) {
      case 'fade-in':
        await FoxTheme.Motion.animate(
          this,
          { opacity: 0 },
          {
            duration: duration ? duration : 1.5,
            delay: this.animationDelay,
            easing: duration ? 'none' : [0, 0, 0.3, 1],
          }
        ).finished;
        break;

      case 'fade-up':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'translateY(1.5625rem)', opacity: 0 },
          {
            duration: duration ? duration : 0.5,
            delay: this.animationDelay,
            easing: duration ? 'none' : [0, 0, 0.3, 1],
          }
        ).finished;
        break;

      case 'zoom-in':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(0)' },
          {
            duration: duration ? duration : 1.3,
            delay: this.animationDelay,
            easing: duration ? 'none' : [0, 0, 0.3, 1],
          }
        ).finished;
        break;

      case 'zoom-in-lg':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(0)' },
          {
            duration: duration ? duration : 1.3,
            delay: this.animationDelay,
            easing: duration ? 'none' : [0, 0, 0.3, 1],
          }
        ).finished;
        break;

      case 'zoom-out':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(0)' },
          {
            duration: duration ? duration : 1.3,
            delay: this.animationDelay,
            easing: duration ? 'none' : [0.16, 1, 0.3, 1],
          }
        ).finished;
        break;

      case 'zoom-out-sm':
        await FoxTheme.Motion.animate(
          this,
          { transform: 'scale(0)' },
          {
            duration: duration ? duration : 1.3,
            delay: this.animationDelay,
            easing: duration ? 'none' : [0.16, 1, 0.3, 1],
          }
        ).finished;
        break;
    }
  }

  refreshAnimation() {
    this._animating = false;
    this.removeAttribute('hold');
    this.preInitialize();
    setTimeout(() => {
      this.initialize();
    }, 50); // Delay a bit to make animation re init properly.
  }
}
customElements.define('motion-element', MotionElement);


} // end load-once guard (see divergence 2 in the file header)
