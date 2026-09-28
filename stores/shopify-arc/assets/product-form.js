(() => {
  // The Animated button style keeps its label in a .btn-animated__text--static span
  // plus a duplicate per-character .btn-animated__text--reveal span (see
  // snippets/button-animated-content.liquid); a plain `button.textContent = text`
  // would blow that structure away on the first variant change. These helpers read
  // from / write to the static span when present, and fall back to plain textContent
  // for every other button style.
  function getButtonLabel(button) {
    const staticLabel = button.querySelector('.btn-animated__text--static');
    return staticLabel ? staticLabel.textContent : button.textContent;
  }

  function setButtonLabel(button, text) {
    const staticLabel = button.querySelector('.btn-animated__text--static');
    const reveal = button.querySelector('.btn-animated__text--reveal');
    if (!staticLabel || !reveal) {
      button.textContent = text;
      return;
    }
    staticLabel.textContent = text;
    reveal.innerHTML = '';
    [...text].forEach((char, i) => {
      const span = document.createElement('span');
      span.className = 'btn-animated__char';
      span.style.setProperty('--i', i);
      span.textContent = char === ' ' ? ' ' : char;
      reveal.appendChild(span);
    });
  }

  class VariantPicker extends HTMLElement {
    connectedCallback() {
      this.variantData = JSON.parse(this.querySelector('[data-variant-data]')?.textContent || '[]');
      // Blocks are siblings within .product, not necessarily nested in the <form> -
      // resolve the form by id (data-form-id) when set, falling back to DOM containment.
      this.container = this.closest('.product') || document;
      this.form = this.dataset.formId
        ? document.getElementById(this.dataset.formId)
        : this.closest('[data-product-form]');
      this.idInput = this.form?.querySelector('input[name="id"]');
      this.submitButton = this.form?.querySelector('[type="submit"]');

      this.addEventListener('change', (event) => {
        if (event.target.matches('input[type="radio"], select')) this.updateVariant();
      });
    }

    getSelectedOptions() {
      const fieldsets = [...this.querySelectorAll('.variant-picker__option')].sort(
        (a, b) => Number(a.dataset.optionPosition) - Number(b.dataset.optionPosition)
      );
      return fieldsets.map((fieldset) => {
        const select = fieldset.querySelector('select');
        if (select) {
          const label = fieldset.querySelector('[data-selected-value]');
          if (label) label.textContent = select.value;
          return select.value;
        }
        const checked = fieldset.querySelector('input:checked');
        const label = fieldset.querySelector('[data-selected-value]');
        if (checked && label) label.textContent = checked.value;
        return checked ? checked.value : null;
      });
    }

    // The optional "Add to cart · £2,400.00" format appends the live variant
    // price to the base label; sold-out/unavailable states never show a price.
    atcLabelText(button, variant) {
      if (variant.available && button.dataset.atcShowPrice === 'true') {
        return `${button.dataset.addText} \u00B7 ${variant.price_formatted}`;
      }
      if (!variant.available) return button.dataset.soldOutText || 'Sold out';
      return button.dataset.addText || getButtonLabel(button);
    }

    updateVariant() {
      const selected = this.getSelectedOptions();
      const variant = this.variantData.find((v) => v.options.every((opt, i) => opt === selected[i]));

      if (!variant) {
        if (this.submitButton) {
          this.submitButton.disabled = true;
          setButtonLabel(this.submitButton, this.submitButton.dataset.unavailableText || getButtonLabel(this.submitButton));
        }
        return;
      }

      if (this.idInput) this.idInput.value = variant.id;

      const priceSource = this.querySelector(`[data-price-source="${variant.id}"]`);
      const priceTarget = this.container.querySelector('[data-variant-price]');
      if (priceSource && priceTarget) priceTarget.innerHTML = priceSource.innerHTML;

      if (this.submitButton) {
        this.submitButton.disabled = !variant.available;
        setButtonLabel(this.submitButton, this.atcLabelText(this.submitButton, variant));
      }

      this.dispatchEvent(new CustomEvent('variant:change', { detail: { variant }, bubbles: true }));
    }
  }
  customElements.define('variant-picker', VariantPicker);
})();
