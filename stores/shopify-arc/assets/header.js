(() => {
  class StickyHeader extends HTMLElement {
    connectedCallback() {
      this.mode = this.dataset.sticky;
      this.announcementBar = document.querySelector('.announcement-bar');
      this.lastScroll = window.scrollY;
      this.ticking = false;

      // `position: sticky` doesn't work here: Shopify wraps each section-group
      // member (announcement bar, header) in its own snug shopify-section div,
      // so the header's sticky containing block is only ever as tall as the
      // header itself — it has zero room to actually stay pinned once you
      // scroll past that div, and just scrolls away like a static element
      // (confirmed via getBoundingClientRect while scrolled). `position: fixed`
      // has no such containing-block limitation, so the header/announcement
      // bar use that instead, with JS measuring real heights and reserving
      // the equivalent space via CSS custom properties (see header.css) —
      // and because `position` itself never changes at any scroll threshold,
      // there's no layout-shift jank switching between modes.
      this.updateHeightVars();
      window.addEventListener('resize', () => this.updateHeightVars());
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => this.updateHeightVars());
        ro.observe(this);
        if (this.announcementBar) ro.observe(this.announcementBar);
      }

      this.handleScroll();
      if (this.mode !== 'none') {
        window.addEventListener(
          'scroll',
          () => {
            if (this.ticking) return;
            this.ticking = true;
            requestAnimationFrame(() => {
              this.handleScroll();
              this.ticking = false;
            });
          },
          { passive: true }
        );
      }
    }

    updateHeightVars() {
      document.documentElement.style.setProperty('--header-height', `${this.offsetHeight}px`);
      document.documentElement.style.setProperty(
        '--announcement-height',
        `${this.announcementBar ? this.announcementBar.offsetHeight : 0}px`
      );
    }

    handleScroll() {
      const scrollY = window.scrollY;
      this.classList.toggle('is-scrolled', scrollY > 10);
      // Past this threshold the transparent header's ::before solid layer
      // fades in (header.css) — matches King's 100px handoff.
      this.classList.toggle('is-sticky', scrollY > 100);
      if (this.mode === 'on-scroll-up') {
        const hide = scrollY > this.lastScroll && scrollY > 150;
        this.classList.toggle('is-hidden', hide);
        this.announcementBar?.classList.toggle('is-hidden', hide);
      }
      this.lastScroll = scrollY;
    }
  }
  customElements.define('sticky-header', StickyHeader);

  // Shared WAAPI helper: element.animate() replays cleanly from scratch on
  // every call regardless of prior DOM/animation state, unlike a CSS
  // transition keyed to an attribute/class on content a native <details>
  // has just unhidden — that only ever plays on the very first open because
  // there's no fresh "before" paint to transition from on repeat opens.
  // Ported from Sleek's FoxTheme.Motion.animate wrapper (ownership: this is
  // the layer that owns the mega-menu's open/close animation).
  function animate(el, keyframes, options) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return el.animate(keyframes, { ...options, duration: reduced ? 0 : options.duration });
  }

  class DetailsDropdown extends HTMLElement {
    connectedCallback() {
      this.details = this.querySelector('details');
      this.summary = this.querySelector('summary');
      if (!this.details || !this.summary) return;

      this.trigger = theme.isTouch ? 'click' : this.dataset.trigger || 'click';

      this.summary.addEventListener('click', (event) => {
        event.preventDefault();
        if (this.trigger !== 'hover') this.toggle();
      });

      if (this.trigger === 'hover') {
        this.addEventListener('mouseenter', () => {
          clearTimeout(this._hoverCloseTimer);
          this.open();
        });
        this.addEventListener('mouseleave', () => {
          // This element's own hoverable box (the link/summary) sits inside
          // the header's padded content row and doesn't reach down to where
          // the panel actually starts (position: absolute, top: 100% of the
          // header) — moving the cursor from the link text toward the panel
          // briefly crosses that gap, which belongs to neither this element
          // nor any of its descendants, so a real mouseleave fires before
          // the cursor ever reaches the panel. Deferring the close (and
          // cancelling it above if mouseenter fires again once the cursor
          // reaches the panel, since the panel is a descendant of this
          // element) bridges that gap without fighting the header's
          // flex/padding layout to close it geometrically.
          clearTimeout(this._hoverCloseTimer);
          this._hoverCloseTimer = setTimeout(() => this.close(), 250);
        });
        this.addEventListener('focusin', () => this.open());
      }

      this.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.details.open) {
          this.close();
          this.summary.focus();
        }
      });

      // Bound once and stored so disconnectedCallback can remove it again.
      // The other listeners above are attached directly to `this` and get
      // garbage-collected along with the element automatically; this one is
      // on `document`, which outlives the element, so an anonymous handler
      // here leaked one closure per reconnect (e.g. every Shopify
      // theme-editor / theme-dev hot-reload re-render of the section).
      this.handleOutsideClick = this.handleOutsideClick.bind(this);
      document.addEventListener('click', this.handleOutsideClick);
    }

    disconnectedCallback() {
      document.removeEventListener('click', this.handleOutsideClick);
      clearTimeout(this._hoverCloseTimer);
    }

    handleOutsideClick(event) {
      if (this.details.open && !this.contains(event.target)) this.close();
    }

    toggle() {
      this.details.open ? this.close() : this.open();
    }

    open() {
      document.querySelectorAll('details-dropdown, details-mega').forEach((el) => {
        if (el !== this) el.close?.();
      });
      this.details.open = true;
      this.closest('.header-wrapper')?.classList.add('has-open-menu');
    }

    close() {
      this.details.open = false;
      this.updateOpenMenuState();
    }

    updateOpenMenuState() {
      const stillOpen = document.querySelector(
        'details-dropdown > details[open], details-mega > details[open]'
      );
      if (!stillOpen) this.closest('.header-wrapper')?.classList.remove('has-open-menu');
    }
  }
  customElements.define('details-dropdown', DetailsDropdown);

  customElements.define(
    'details-mega',
    class extends DetailsDropdown {
      // The panel to slide/fade is .mega-menu itself — rendered by
      // snippets/mega-menu.liquid as the sole element after <summary>.
      get panel() {
        return this.details.lastElementChild;
      }

      constructor() {
        super();
        // Theme-editor convenience (same as Sleek): selecting a mega block in
        // the editor opens its panel so merchants see edits live. The width
        // guard matters because the panel is display:none below 990px —
        // opening it there would look like a dead click in narrow editor
        // panes. Deselect stays unconditional: closing an already-closed
        // menu is a no-op, and skipping it would leak stale open state when
        // the pane is later widened.
        if (Shopify.designMode) {
          this.addEventListener('shopify:block:select', () => {
            if (window.innerWidth >= 990) this.open();
          });
          this.addEventListener('shopify:block:deselect', () => this.close());
        }
      }

      open() {
        if (this.details.open) return;
        document.querySelectorAll('details-dropdown, details-mega').forEach((el) => {
          if (el !== this) el.close?.();
        });
        if (this._closeAnimation) {
          this._closeAnimation.cancel();
          this._closeAnimation = null;
        }
        this.details.open = true;

        // Native <details> hides non-summary children until first opened,
        // so starting the WAAPI animation in the very same tick as setting
        // `open` can run before the browser has committed a first paint of
        // the (now-unhidden) hidden state — the 100ms delay gives it that
        // real elapsed-time gap, same fix used by Sleek's own details-mega.
        // The `.has-open-menu` add moved INTO this timer deliberately: it is
        // the transition trigger for mega-menu.css's child-item cascade,
        // which needs one committed "hidden" frame under `details[open]`
        // before `.has-open-menu` lands, or the items would jump instead of
        // staggering in. Plain dropdowns keep their synchronous add (see
        // DetailsDropdown.open above) — they have no cascade.
        clearTimeout(this._revealTimer);
        this._revealTimer = setTimeout(() => {
          this.closest('.header-wrapper')?.classList.add('has-open-menu');
          document.body.classList.add('mega-open');
          this.playOpenAnimation();
        }, 100);
      }

      playOpenAnimation() {
        const panel = this.panel;
        panel.style.visibility = 'visible';
        panel.style.pointerEvents = 'auto';
        if (this._openAnimation) this._openAnimation.cancel();
        this._openAnimation = animate(
          panel,
          [
            { opacity: 0, transform: 'translateY(-24px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 500, easing: 'cubic-bezier(0.39, 0.575, 0.565, 1)', fill: 'forwards' }
        );
      }

      async close() {
        if (!this.details.open) return;
        clearTimeout(this._revealTimer);
        if (this._openAnimation) {
          this._openAnimation.cancel();
          this._openAnimation = null;
        }
        const panel = this.panel;
        this._closeAnimation = animate(
          panel,
          [
            { opacity: 1, transform: 'translateY(0)' },
            { opacity: 0, transform: 'translateY(-24px)' },
          ],
          { duration: 350, easing: 'cubic-bezier(0.39, 0.575, 0.565, 1)', fill: 'forwards' }
        );
        await this._closeAnimation.finished.catch(() => {});
        this._closeAnimation?.cancel();
        this._closeAnimation = null;
        panel.style.visibility = '';
        panel.style.pointerEvents = '';
        // Don't clear the native `open` attribute until the close animation
        // has actually finished — clearing it early snaps native <details>
        // content-hiding in mid-animation and cuts the fade/slide short.
        this.details.open = false;
        this.updateOpenMenuState();
        // Drop the page dim only when no other mega menu is still open
        // (plain dropdowns never set it, so they're excluded here).
        if (!document.querySelector('details-mega > details[open]')) {
          document.body.classList.remove('mega-open');
        }
      }
    }
  );

  class MenuDrawerDetails extends HTMLElement {
    connectedCallback() {
      this.details = this.querySelector(':scope > details');
      this.summary = this.querySelector(':scope > details > summary');
      this.backButton = this.querySelector(':scope > details > .menu-drawer__submenu > .menu-drawer__back-link');
      if (!this.details || !this.summary) return;

      this.summary.addEventListener('click', (event) => {
        event.preventDefault();
        this.openLevel();
      });
      this.backButton?.addEventListener('click', () => this.closeLevel());
    }

    openLevel() {
      this.details.open = true;
      clearTimeout(this._activeTimer);
      clearTimeout(this._closeTimer);
      this._activeTimer = setTimeout(() => {
        this.classList.add('menu-drawer-details--active');
        this.summary.setAttribute('aria-expanded', 'true');
      }, 100);
    }

    closeLevel() {
      clearTimeout(this._activeTimer);
      this.classList.remove('menu-drawer-details--active');
      this.summary.setAttribute('aria-expanded', 'false');
      // Matches the CSS transition duration on .menu-drawer__submenu — wait
      // for the slide-out to finish before collapsing the native <details>,
      // same reasoning as details-mega's WAAPI .finished gate above.
      clearTimeout(this._closeTimer);
      this._closeTimer = setTimeout(() => {
        this.details.open = false;
      }, 400);
    }

    resetImmediately() {
      clearTimeout(this._activeTimer);
      clearTimeout(this._closeTimer);
      this.classList.remove('menu-drawer-details--active');
      this.summary?.setAttribute('aria-expanded', 'false');
      if (this.details) this.details.open = false;
    }
  }
  customElements.define('menu-drawer-details', MenuDrawerDetails);

  class MenuDrawer extends theme.DrawerComponent {
    onClose() {
      this.querySelectorAll('menu-drawer-details').forEach((el) => el.resetImmediately?.());
    }
  }
  customElements.define('menu-drawer', MenuDrawer);

  class MenuProductList extends HTMLElement {
    connectedCallback() {
      this.track = this.querySelector('[data-product-track]');
      const header = this.closest('.mega-menu__products')?.querySelector('.mega-menu__products-header');
      this.counter = header?.querySelector('[data-product-counter]');
      this.prevBtn = header?.querySelector('[data-product-prev]');
      this.nextBtn = header?.querySelector('[data-product-next]');
      this.total = Number(this.dataset.count) || this.track?.children.length || 0;
      if (!this.track || this.total < 2) return;

      this.prevBtn?.addEventListener('click', () => this.step(-1));
      this.nextBtn?.addEventListener('click', () => this.step(1));
      this.track.addEventListener('scroll', () => this.updateCounter(), { passive: true });
    }

    step(direction) {
      const card = this.track.children[0];
      if (!card) return;
      const amount = card.getBoundingClientRect().width + parseFloat(getComputedStyle(this.track).columnGap || 0);
      this.track.scrollBy({ left: amount * direction, behavior: 'smooth' });
    }

    updateCounter() {
      if (!this.counter) return;
      const card = this.track.children[0];
      if (!card) return;
      const amount = card.getBoundingClientRect().width + parseFloat(getComputedStyle(this.track).columnGap || 0);
      const index = Math.min(this.total - 1, Math.round(this.track.scrollLeft / amount));
      this.counter.textContent = `${index + 1}/${this.total}`;
    }
  }
  customElements.define('menu-product-list', MenuProductList);

  document.addEventListener('cart:updated', (event) => {
    document.querySelectorAll('cart-count').forEach((el) => {
      const count = event.detail.item_count;
      el.textContent = count;
      el.classList.toggle('cart-count--empty', count === 0);
    });
  });
})();
