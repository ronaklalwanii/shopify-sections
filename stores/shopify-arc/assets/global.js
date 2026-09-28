window.theme = window.theme || {};
theme.isTouch = matchMedia('(hover: none)').matches;

theme.utils = {
  debounce(fn, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  },
};

theme.a11y = {
  trapFocus(container, elementToFocus) {
    const focusable = container.querySelectorAll(
      'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    container.removeEventListener('keydown', container._trapHandler || (() => {}));
    container._trapHandler = (event) => {
      if (event.key !== 'Tab') return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', container._trapHandler);
    (elementToFocus || first).focus();
  },
  removeTrapFocus(container) {
    if (container && container._trapHandler) {
      container.removeEventListener('keydown', container._trapHandler);
    }
  },
};

/**
 * Shared base for slide-out drawers (cart, search, mobile menu).
 * Subclasses call super.connectedCallback() and implement onOpen/onClose if needed.
 */
theme.DrawerComponent = class DrawerComponent extends HTMLElement {
  connectedCallback() {
    this.triggers = document.querySelectorAll(`[aria-controls="${this.id}"]`);
    this.triggers.forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        this.open(trigger);
      });
    });

    this.closeButtons = this.querySelectorAll('[data-drawer-close]');
    this.closeButtons.forEach((btn) => btn.addEventListener('click', () => this.close()));

    this.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
    this.addEventListener('click', (event) => {
      if (event.target === this) this.close();
    });
  }

  open(trigger) {
    this.activeTrigger = trigger;
    this.setAttribute('open', '');
    document.body.classList.add('drawer-open');
    if (this.triggers) {
      this.triggers.forEach((t) => t.setAttribute('aria-expanded', 'true'));
    }
    theme.a11y.trapFocus(this);
    if (typeof this.onOpen === 'function') this.onOpen();
  }

  close() {
    this.removeAttribute('open');
    document.body.classList.remove('drawer-open');
    if (this.triggers) {
      this.triggers.forEach((t) => t.setAttribute('aria-expanded', 'false'));
    }
    theme.a11y.removeTrapFocus(this);
    if (this.activeTrigger) this.activeTrigger.focus();
    if (typeof this.onClose === 'function') this.onClose();
  }
};

if (document.body.hasAttribute('data-page-transition-enabled')) {
  requestAnimationFrame(() => document.body.removeAttribute('data-page-transitioning'));

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (
      !link ||
      link.target === '_blank' ||
      link.hasAttribute('download') ||
      event.metaKey ||
      event.ctrlKey ||
      link.origin !== window.location.origin ||
      (link.pathname === window.location.pathname && link.hash)
    ) {
      return;
    }
    event.preventDefault();
    document.body.setAttribute('data-page-transitioning', '');
    setTimeout(() => {
      window.location.href = link.href;
    }, 150);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const backToTop = document.querySelector('[data-back-to-top]');
  if (backToTop) {
    window.addEventListener(
      'scroll',
      () => backToTop.classList.toggle('is-visible', window.scrollY > 600),
      { passive: true }
    );
    backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  const animated = document.querySelectorAll('[data-animate]');
  if (animated.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
    animated.forEach((el) => observer.observe(el));
  }

  // Country selector flag — built from the ISO code via Unicode regional
  // indicator symbols rather than a bitmap/lookup table, so it covers every
  // country Shopify supports with no asset or maintenance cost.
  document.querySelectorAll('[data-country-select]').forEach((select) => {
    const flagEl = select.closest('.localization-form__select-wrapper')?.querySelector('[data-country-flag]');
    if (!flagEl) return;
    const setFlag = () => {
      const code = select.value;
      if (code && code.length === 2) {
        const base = 0x1f1e6;
        flagEl.textContent = String.fromCodePoint(
          ...code.toUpperCase().split('').map((c) => base + (c.charCodeAt(0) - 65))
        );
      }
    };
    setFlag();
    select.addEventListener('change', setFlag);
  });
});
