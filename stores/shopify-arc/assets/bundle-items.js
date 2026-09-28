(() => {
  function formatMoney(cents) {
    const format = (window.themeSettings && window.themeSettings.moneyFormat) || '${{amount}}';
    const amount = (cents / 100).toFixed(2).replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
    return format.replace(/\{\{\s*amount\s*\}\}/, amount);
  }

  function initBundle(root) {
    const selections = new Map();
    const enableDiscount = root.dataset.discountType !== undefined;
    const discountType = root.dataset.discountType;
    const discountValue = parseFloat(root.dataset.discountValue || '0');
    const discountMinItems = parseInt(root.dataset.discountMinItems || '0', 10);
    const minItems = parseInt(root.dataset.bundleMinItems || '0', 10);
    const maxItems = parseInt(root.dataset.bundleMaxItems || '0', 10);

    const totalEl = root.querySelector('[data-bundle-total]');
    const cartLabelEl = root.querySelector('[data-bundle-cart-label]');
    const addToCartBtn = root.querySelector('[data-bundle-add-to-cart]');
    const removeAllBtn = root.querySelector('[data-bundle-remove-all]');
    const discountNoteEl = root.querySelector('[data-bundle-discount-note]');
    const minNoteEl = root.querySelector('[data-bundle-min-note]');

    // Caps how many "+" buttons can be active at once so a merchant-set max
    // can't be exceeded - disables every not-yet-added button once the cap
    // is hit, re-enables them as soon as a slot frees up.
    function updateMaxLimit() {
      if (!maxItems) return;
      const atMax = selections.size >= maxItems;
      root.querySelectorAll('[data-bundle-add]').forEach((button) => {
        const index = Number(button.dataset.index);
        if (selections.has(index)) return;
        button.disabled = atMax;
        button.classList.toggle('is-limit-reached', atMax);
      });
    }

    function updateSlot(index) {
      const slot = root.querySelector(`[data-bundle-slot][data-index="${index}"]`);
      if (!slot) return;
      const entry = selections.get(index);

      if (!entry) {
        slot.classList.remove('is-filled');
        slot.innerHTML = '<span class="bundle-items__slot-plus" data-bundle-slot-plus aria-hidden="true">+</span>';
        return;
      }

      slot.classList.add('is-filled');
      slot.innerHTML = `
        <img class="bundle-items__slot-image" src="${entry.image}" alt="" width="44" height="44" loading="lazy">
        <span class="bundle-items__slot-info">
          <span class="bundle-items__slot-title">${entry.productTitle}</span>
          <span class="bundle-items__slot-variant">${entry.variantTitle}</span>
        </span>
        <button type="button" class="bundle-items__slot-remove" data-bundle-slot-remove data-index="${index}" aria-label="Remove">&times;</button>
      `;
    }

    function updateAddButton(index) {
      const button = root.querySelector(`[data-bundle-add][data-index="${index}"]`);
      if (button) button.classList.toggle('is-added', selections.has(index));
    }

    function computeTotals() {
      const items = Array.from(selections.values());
      const subtotal = items.reduce((sum, item) => sum + item.price, 0);

      let total = subtotal;
      let discountActive = false;

      if (enableDiscount && items.length >= discountMinItems && discountMinItems > 0) {
        discountActive = true;
        if (discountType === 'percent') {
          total = subtotal - subtotal * (discountValue / 100);
        } else {
          total = Math.max(0, subtotal - discountValue * 100);
        }
      }

      if (totalEl) totalEl.textContent = formatMoney(total);
      if (cartLabelEl) cartLabelEl.textContent = `${formatMoney(total)}: Add to cart`;

      if (discountNoteEl) {
        if (discountActive) {
          const label = discountType === 'percent' ? `${discountValue}%` : formatMoney(discountValue * 100);
          discountNoteEl.textContent = `Bundle discount applied: ${label} off`;
          discountNoteEl.hidden = false;
        } else {
          discountNoteEl.hidden = true;
        }
      }

      const hasItems = items.length > 0;
      const meetsMinimum = items.length >= minItems;
      if (addToCartBtn) {
        addToCartBtn.disabled = !hasItems || !meetsMinimum;
        addToCartBtn.dataset.items = JSON.stringify(
          items.map((item) => ({ id: item.variantId, quantity: 1 }))
        );
      }
      if (removeAllBtn) removeAllBtn.disabled = !hasItems;

      if (minNoteEl) {
        if (hasItems && !meetsMinimum) {
          const remaining = minItems - items.length;
          minNoteEl.textContent = `Add ${remaining} more item${remaining === 1 ? '' : 's'} to enable checkout`;
          minNoteEl.hidden = false;
        } else {
          minNoteEl.hidden = true;
        }
      }

      updateMaxLimit();
    }

    root.addEventListener('click', (event) => {
      const addButton = event.target.closest('[data-bundle-add]');
      if (addButton) {
        const index = addButton.dataset.index;
        const select = root.querySelector(`[data-bundle-select][data-index="${index}"]`);
        if (!select || !select.value) return;
        const option = select.options[select.selectedIndex];

        selections.set(Number(index), {
          variantId: select.value,
          price: parseInt(option.dataset.price, 10) || 0,
          variantTitle: option.dataset.title || '',
          productTitle: addButton.dataset.productTitle || '',
          image: option.dataset.image || '',
        });

        updateSlot(Number(index));
        updateAddButton(Number(index));
        computeTotals();
        return;
      }

      const removeButton = event.target.closest('[data-bundle-slot-remove]');
      if (removeButton) {
        const index = Number(removeButton.dataset.index);
        selections.delete(index);
        updateSlot(index);
        updateAddButton(index);
        computeTotals();
        return;
      }

      if (event.target.closest('[data-bundle-remove-all]')) {
        const indexes = Array.from(selections.keys());
        selections.clear();
        indexes.forEach((index) => {
          updateSlot(index);
          updateAddButton(index);
        });
        computeTotals();
      }
    });

    document.addEventListener('bundle:added', (event) => {
      if (!root.contains(event.detail.button)) return;
      const indexes = Array.from(selections.keys());
      selections.clear();
      indexes.forEach((index) => {
        updateSlot(index);
        updateAddButton(index);
      });
      computeTotals();
      if (addToCartBtn) addToCartBtn.disabled = true;
    });

    computeTotals();
  }

  document.querySelectorAll('[data-bundle]').forEach(initBundle);
})();
