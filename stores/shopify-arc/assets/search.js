(() => {
  class SearchDrawerElement extends theme.DrawerComponent {
    connectedCallback() {
      super.connectedCallback();
      this.input = this.querySelector('[data-predictive-search-input]');
      this.resultsEl = this.querySelector('[data-predictive-search-results]');
      this.suggested = this.querySelector('[data-search-suggested]');
      this.enabled = Boolean(window.themeSettings && window.themeSettings.predictiveSearchEnabled);

      if (this.input) {
        this.input.addEventListener('input', theme.utils.debounce((event) => this.search(event.target.value), 300));
      }

      this.querySelectorAll('[data-suggested-keyword]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.input.value = btn.textContent.trim();
          this.search(this.input.value);
          this.input.focus();
        });
      });
    }

    onOpen() {
      this.input?.focus();
    }

    search(query) {
      if (!this.enabled || !this.resultsEl) return;

      if (!query) {
        this.resultsEl.innerHTML = '';
        this.suggested?.removeAttribute('hidden');
        return;
      }

      this.suggested?.setAttribute('hidden', '');

      const limit = window.themeSettings.predictiveSearchLimit || 6;
      const url =
        `${window.Shopify.routes.root}search/suggest?q=${encodeURIComponent(query)}` +
        `&section_id=predictive-search&resources[type]=product&resources[limit]=${limit}`;

      this.activeQuery = query;
      fetch(url)
        .then((res) => res.text())
        .then((text) => {
          if (this.activeQuery !== query) return;
          const doc = new DOMParser().parseFromString(text, 'text/html');
          const results = doc.querySelector('[data-predictive-search-results]');
          this.resultsEl.innerHTML = results ? results.innerHTML : '';
        })
        .catch(() => {});
    }
  }

  customElements.define('search-drawer', SearchDrawerElement);
})();
