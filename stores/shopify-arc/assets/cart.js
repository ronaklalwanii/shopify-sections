(() => {
  function formatMoney(cents) {
    const format = (window.themeSettings && window.themeSettings.moneyFormat) || '${{amount}}';
    const amount = (cents / 100).toFixed(2).replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
    return format.replace(/\{\{\s*amount\s*\}\}/, amount);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  // Line item properties are customer-entered (e.g. monogramming), so they must
  // be escaped. Underscore-prefixed and empty properties stay hidden.
  function cartItemPropertiesMarkup(item) {
    const properties = item.properties || {};
    const rows = Object.keys(properties)
      .filter((name) => name && !name.startsWith('_') && properties[name] !== null && properties[name] !== undefined && properties[name] !== '')
      .map((name) => `<div class="cart-item__property"><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(properties[name])}</dd></div>`)
      .join('');
    return rows ? `<dl class="cart-item__properties">${rows}</dl>` : '';
  }

  function cartItemDiscountsMarkup(item) {
    const discounts = item.line_level_discount_allocations || [];
    if (!discounts.length) return '';
    const rows = discounts
      .map((discount) => {
        const title = (discount.discount_application && discount.discount_application.title) || '';
        return `<li>${escapeHtml(title)} (&minus;${formatMoney(discount.amount)})</li>`;
      })
      .join('');
    return `<ul class="cart-item__discounts">${rows}</ul>`;
  }

  function cartLevelDiscountsMarkup(cart) {
    const applications = cart.cart_level_discount_applications || [];
    return applications
      .map((discount) => {
        return `<div class="cart-drawer__discount"><span>${escapeHtml(discount.title)}</span><span>&minus;${formatMoney(discount.total_allocated_amount)}</span></div>`;
      })
      .join('');
  }

  function cartItemMarkup(item) {
    const variant =
      item.variant_title && item.variant_title !== 'Default Title'
        ? `<p class="cart-item__variant">${escapeHtml(item.variant_title)}</p>`
        : '';
    const image = item.image ? `<img src="${item.image}" alt="" width="100" loading="lazy">` : '';
    const originalPrice = item.original_line_price || 0;
    const price = originalPrice > item.final_line_price
      ? `<s>${formatMoney(originalPrice)}</s> ${formatMoney(item.final_line_price)}`
      : formatMoney(item.final_line_price);
    return `
      <li class="cart-item" data-cart-item data-line-key="${item.key}">
        <a href="${item.url}" class="cart-item__image-link">${image}</a>
        <div class="cart-item__details">
          <a href="${item.url}" class="cart-item__title">${escapeHtml(item.product_title)}</a>
          ${variant}
          ${cartItemPropertiesMarkup(item)}
          <p class="cart-item__price" data-line-price>${price}</p>
          ${cartItemDiscountsMarkup(item)}
          <div class="cart-item__quantity">
            <button type="button" data-quantity-decrease aria-label="Decrease quantity">&minus;</button>
            <input type="number" min="0" value="${item.quantity}" data-quantity-input aria-label="Quantity">
            <button type="button" data-quantity-increase aria-label="Increase quantity">&plus;</button>
          </div>
        </div>
        <button type="button" class="cart-item__remove" data-remove-item aria-label="Remove">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="icon"><path d="m5 5 14 14"></path><path d="m19 5-14 14"></path></svg>
        </button>
      </li>`;
  }

  class CartDrawerElement extends theme.DrawerComponent {
    connectedCallback() {
      super.connectedCallback();

      this.addEventListener('input', (event) => {
        if (event.target.matches('[data-quantity-input]')) {
          theme.utils.debounce(() => this.changeLine(event.target), 400)();
        }
        if (event.target.matches('[data-cart-note]')) {
          theme.utils.debounce(() => theme.cart.updateNote(event.target.value), 500)();
        }
      });

      this.addEventListener('click', (event) => {
        const decrease = event.target.closest('[data-quantity-decrease]');
        const increase = event.target.closest('[data-quantity-increase]');
        const remove = event.target.closest('[data-remove-item]');
        if (decrease) this.stepLine(decrease, -1);
        if (increase) this.stepLine(increase, 1);
        if (remove) this.removeLine(remove);
      });
    }

    stepLine(button, delta) {
      const input = button.parentElement.querySelector('[data-quantity-input]');
      const newQuantity = Math.max(0, parseInt(input.value, 10) + delta);
      input.value = newQuantity;
      this.changeLine(input, newQuantity);
    }

    removeLine(button) {
      const row = button.closest('[data-cart-item]');
      theme.cart
        .change(row.dataset.lineKey, 0)
        .then((cart) => this.render(cart))
        .catch((err) => this.handleCartError(err));
    }

    changeLine(input, quantity) {
      const row = input.closest('[data-cart-item]');
      const value = quantity !== undefined ? quantity : parseInt(input.value, 10) || 0;
      theme.cart
        .change(row.dataset.lineKey, value)
        .then((cart) => this.render(cart))
        .catch((err) => this.handleCartError(err));
    }

    // A failed change (e.g. HTTP 422 when requesting more units than inventory
    // allows) must resync the drawer to the server's cart, otherwise the UI
    // keeps showing the rejected quantity.
    handleCartError(err) {
      this.showError((err && (err.description || err.message)) || 'Unable to update cart.');
      theme.cart
        .get()
        .then((cart) => this.render(cart))
        .catch(() => {});
    }

    showError(message) {
      const errorEl = this.querySelector('[data-cart-error]');
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.hidden = false;
      clearTimeout(this.errorTimeout);
      this.errorTimeout = setTimeout(() => {
        errorEl.hidden = true;
      }, 5000);
    }

    render(cart) {
      document.dispatchEvent(new CustomEvent('cart:updated', { detail: { item_count: cart.item_count, cart } }));

      const emptyEl = this.querySelector('[data-cart-empty]');
      const filledEl = this.querySelector('[data-cart-filled]');
      const footerEl = this.querySelector('[data-cart-footer]');
      const isEmpty = cart.item_count === 0;

      if (emptyEl) emptyEl.hidden = !isEmpty;
      if (filledEl) filledEl.hidden = isEmpty;
      if (footerEl) footerEl.hidden = isEmpty;

      if (isEmpty) return;

      const itemsEl = this.querySelector('[data-cart-items]');
      if (itemsEl) itemsEl.innerHTML = cart.items.map(cartItemMarkup).join('');

      const discountsEl = this.querySelector('[data-cart-discounts]');
      if (discountsEl) discountsEl.innerHTML = cartLevelDiscountsMarkup(cart);

      const priceEl = this.querySelector('[data-cart-subtotal]');
      if (priceEl) priceEl.textContent = formatMoney(cart.total_price);

      const fill = this.querySelector('[data-shipping-fill]');
      const bar = this.querySelector('[data-free-shipping-bar]');
      if (fill && bar) {
        const threshold = parseInt(bar.dataset.threshold, 10);
        const progress = Math.min(100, (cart.items_subtotal_price / threshold) * 100);
        fill.style.width = `${progress}%`;
      }
    }

    open(trigger) {
      super.open(trigger);
    }
  }
  customElements.define('cart-drawer', CartDrawerElement);

  theme.cart = {
    get() {
      return fetch(`${window.Shopify.routes.root}cart.js`, { headers: { Accept: 'application/json' } }).then((res) => {
        if (!res.ok) return res.json().then((err) => Promise.reject(err));
        return res.json();
      });
    },
    change(key, quantity) {
      return fetch(`${window.Shopify.routes.root}cart/change.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id: key, quantity }),
      }).then((res) => {
        if (!res.ok) return res.json().then((err) => Promise.reject(err));
        return res.json();
      });
    },
    updateNote(note) {
      return fetch(`${window.Shopify.routes.root}cart/update.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ note }),
      }).then((res) => {
        if (!res.ok) return res.json().then((err) => Promise.reject(err));
        return res.json();
      });
    },
    add(formData) {
      return fetch(`${window.Shopify.routes.root}cart/add.js`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: formData,
      }).then((res) => {
        if (!res.ok) return res.json().then((err) => Promise.reject(err));
        return res.json();
      });
    },
    addVariant(variantId, quantity) {
      return fetch(`${window.Shopify.routes.root}cart/add.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id: variantId, quantity: quantity || 1 }),
      }).then((res) => {
        if (!res.ok) return res.json().then((err) => Promise.reject(err));
        return res.json();
      });
    },
    addMultiple(items) {
      return fetch(`${window.Shopify.routes.root}cart/add.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items }),
      }).then((res) => {
        if (!res.ok) return res.json().then((err) => Promise.reject(err));
        return res.json();
      });
    },
  };

  function refreshCartState(openTrigger) {
    return theme.cart.get().then((cart) => {
      const drawer = document.getElementById('CartDrawer');
      if (drawer) {
        drawer.render(cart);
        if (openTrigger !== false) drawer.open(openTrigger);
      }
      return cart;
    });
  }

  // Order-note autosave for surfaces outside the cart drawer (the cart page);
  // the drawer binds its own note field in connectedCallback.
  document.addEventListener('input', (event) => {
    if (!event.target.matches('[data-cart-note]') || event.target.closest('cart-drawer')) return;
    theme.utils.debounce(() => {
      theme.cart.updateNote(event.target.value).catch((err) => console.error('Failed to save cart note:', err));
    }, 500)();
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-quick-add]');
    if (!button || button.disabled) return;
    // Multi-variant triggers (data-product-url, no variant id) open the quick
    // add drawer instead — handled by the delegated listener in product-card.js.
    if (!button.dataset.variantId) return;
    button.disabled = true;
    if (theme.cardButtonState) theme.cardButtonState(button, 'loading');
    theme.cart
      .addVariant(button.dataset.variantId)
      .then(() => {
        if (window.themeSettings && window.themeSettings.cartType === 'page') {
          window.location.href = `${window.Shopify.routes.root}cart`;
          return;
        }
        if (theme.cardButtonState) theme.cardButtonState(button, 'success');
        return refreshCartState(button);
      })
      .catch((err) => {
        if (theme.cardButtonState) {
          theme.cardButtonState(button, 'error');
        } else {
          console.error('Quick add failed:', err);
        }
      })
      .finally(() => {
        button.disabled = false;
        if (theme.cardButtonRevert) theme.cardButtonRevert(button);
      });
  });

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form.matches('[data-product-form]')) return;
    event.preventDefault();

    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;

    theme.cart
      .add(new FormData(form))
      .then(() => {
        // A submit from inside the quick add drawer should hand over to the
        // cart drawer rather than stacking two open drawers.
        const quickAddDrawer = document.getElementById('QuickAddDrawer');
        if (quickAddDrawer && quickAddDrawer.hasAttribute('open') && form.closest('quick-add-drawer')) {
          quickAddDrawer.close();
        }
        if (window.themeSettings && window.themeSettings.cartType === 'page') {
          window.location.href = `${window.Shopify.routes.root}cart`;
          return;
        }
        return refreshCartState(submitButton);
      })
      .catch((err) => {
        const errorEl = form.querySelector('[data-form-error]');
        if (errorEl) errorEl.textContent = err.description || err.message || 'Unable to add to cart.';
      })
      .finally(() => {
        if (submitButton) submitButton.disabled = false;
      });
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-bundle-add-to-cart]');
    if (!button || button.disabled) return;

    let items = [];
    try {
      items = JSON.parse(button.dataset.items || '[]');
    } catch (err) {
      items = [];
    }
    if (!items.length) return;

    button.disabled = true;
    theme.cart
      .addMultiple(items)
      .then(() => {
        if (window.themeSettings && window.themeSettings.cartType === 'page') {
          window.location.href = `${window.Shopify.routes.root}cart`;
          return;
        }
        return refreshCartState(button);
      })
      .then(() => {
        document.dispatchEvent(new CustomEvent('bundle:added', { detail: { button } }));
      })
      .catch(() => {
        button.disabled = false;
      });
  });
})();
