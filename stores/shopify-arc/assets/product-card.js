(() => {
  const QUICK_ADD_SECTION_ID = 'quick-add';

  // One drawer per page, content swapped per product. Fetches are cached per
  // product URL for the session; failures are not cached.
  const quickAddCache = new Map();

  class QuickAddDrawerElement extends theme.DrawerComponent {
    onOpen() {
      const content = this.querySelector('[data-drawer-content]');
      if (content) content.scrollTop = 0;
    }
  }
  customElements.define('quick-add-drawer', QuickAddDrawerElement);

  function fetchQuickAddContent(productUrl) {
    if (!quickAddCache.has(productUrl)) {
      const separator = productUrl.includes('?') ? '&' : '?';
      const request = fetch(`${productUrl}${separator}section_id=${QUICK_ADD_SECTION_ID}`).then((res) => {
        if (!res.ok) throw new Error(`Quick add request failed: ${res.status}`);
        return res.text();
      });
      request.catch(() => quickAddCache.delete(productUrl));
      quickAddCache.set(productUrl, request);
    }
    return quickAddCache.get(productUrl);
  }

  function openQuickAddDrawer(trigger) {
    const drawer = document.getElementById('QuickAddDrawer');
    if (!drawer) return;
    const content = drawer.querySelector('[data-drawer-content]');
    if (!content) return;

    drawer.open(trigger);
    content.innerHTML =
      '<div class="quick-add quick-add--loading"><div class="spinner" aria-hidden="true"></div></div>';

    fetchQuickAddContent(trigger.dataset.productUrl)
      .then((html) => {
        content.innerHTML = html;
      })
      .catch(() => {
        content.innerHTML = `
          <div class="quick-add quick-add--error">
            <p>${trigger.dataset.errorLabel || ''}</p>
            <a href="${trigger.dataset.productUrl}" class="btn btn--secondary">${trigger.dataset.detailsLabel || ''}</a>
          </div>
        `;
      });
  }

  // Shared quick add button state machine (idle -> loading -> success/error -> idle),
  // consumed by the delegated handlers here and in cart.js.
  const revertTimers = new WeakMap();

  function setButtonState(button, state) {
    button.dataset.state = state;
    const status = button.querySelector('[data-quick-add-status]');
    if (!status) return;
    if (state === 'loading') status.textContent = button.dataset.addingLabel || '';
    else if (state === 'success') status.textContent = button.dataset.addedLabel || '';
    else if (state === 'error') status.textContent = button.dataset.errorLabel || '';
    else status.textContent = '';
  }

  function flashButtonLabel(button) {
    const label = button.querySelector('.product-card__quick-add-label');
    if (!label || button.querySelector('.btn-animated__text--static')) return;
    const original = label.dataset.originalLabel || label.textContent;
    label.dataset.originalLabel = original;
    label.textContent = button.dataset.addedLabel || original;
  }

  function revertButton(button) {
    clearTimeout(revertTimers.get(button));
    revertTimers.set(
      button,
      setTimeout(() => {
        setButtonState(button, 'idle');
        const label = button.querySelector('.product-card__quick-add-label');
        if (label && label.dataset.originalLabel) {
          label.textContent = label.dataset.originalLabel;
          delete label.dataset.originalLabel;
        }
      }, 1600)
    );
  }

  theme.cardButtonState = setButtonState;
  theme.cardButtonRevert = revertButton;

  // Quick add triggers. Multi-variant products open the drawer; single-variant
  // buttons (data-variant-id) are handled by the delegated handler in cart.js.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-quick-add]');
    if (!button || button.disabled) return;
    if (button.dataset.productUrl) {
      event.preventDefault();
      openQuickAddDrawer(button);
    }
  });

  // Card swatches: selection swaps the card image and retargets the card links
  // to the selected variant. Delegated so AJAX-rendered cards work unchanged.
  document.addEventListener('change', (event) => {
    const input = event.target.closest('.product-card__swatches input[type="radio"]');
    if (!input) return;
    const card = input.closest('.product-card');
    if (!card) return;

    if (input.dataset.variantUrl) {
      card.querySelectorAll('.product-card__media-link, [data-card-title-link]').forEach((link) => {
        link.setAttribute('href', input.dataset.variantUrl);
      });
    }

    const primaryImage = card.querySelector('[data-card-primary-image]');
    if (primaryImage && input.dataset.variantImage) {
      primaryImage.removeAttribute('srcset');
      primaryImage.removeAttribute('loading');
      primaryImage.src = input.dataset.variantImage;
    }
  });
})();
