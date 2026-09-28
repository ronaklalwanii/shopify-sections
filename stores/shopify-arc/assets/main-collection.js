(() => {
  'use strict';

  class CollectionFilterDrawer extends theme.DrawerComponent {
    connectedCallback() {
      super.connectedCallback();
      this.applyButtons = this.querySelectorAll('[data-drawer-apply]');
      this.applyButtons.forEach((btn) => btn.addEventListener('click', () => this.close()));
    }
  }

  if (!customElements.get('collection-filter-drawer')) {
    customElements.define('collection-filter-drawer', CollectionFilterDrawer);
  }

  class CollectionContainer extends HTMLElement {
    constructor() {
      super();
      this.sectionId = this.dataset.sectionId;
      this.debouncedOnInput = theme.utils.debounce(this.onInput.bind(this), 350);
      this.debouncedOnSearch = theme.utils.debounce(this.onSearchInput.bind(this), 150);
    }

    connectedCallback() {
      this.productGridContainer = this.querySelector('#ProductGridContainer');
      this.statusEl = this.querySelector('[data-filter-status]');
      this.drawer = document.querySelector(`collection-filter-drawer[id="CollectionFiltersDrawer-${this.sectionId}"]`) || document.querySelector('collection-filter-drawer');

      this.initEvents();
      this.initPriceSliders();
      this.restoreViewPreference();

      window.addEventListener('popstate', this.onHistoryChange.bind(this));
    }

    disconnectedCallback() {
      window.removeEventListener('popstate', this.onHistoryChange.bind(this));
    }

    initEvents() {
      this.addEventListener('change', this.onChange.bind(this));
      this.addEventListener('input', this.handleInputEvents.bind(this));
      this.addEventListener('click', this.onClick.bind(this));
      this.addEventListener('keydown', this.onKeyDown.bind(this));

      // Also listen on drawer if it lives outside container in DOM
      if (this.drawer && !this.contains(this.drawer)) {
        this.drawer.addEventListener('change', this.onChange.bind(this));
        this.drawer.addEventListener('input', this.handleInputEvents.bind(this));
        this.drawer.addEventListener('click', this.onClick.bind(this));
        this.drawer.addEventListener('keydown', this.onKeyDown.bind(this));
      }
    }

    handleInputEvents(event) {
      const target = event.target;
      if (target.matches('[data-collection-search-input]')) {
        this.debouncedOnSearch(target);
        return;
      }
      if (target.matches('[data-min-input]') || target.matches('[data-max-input]')) {
        this.debouncedOnInput(event);
      }
    }

    onKeyDown(event) {
      if (event.key === 'Enter' && event.target.matches('[data-collection-search-input]')) {
        event.preventDefault();
        this.onSearchInput(event.target);
      }
    }

    onChange(event) {
      const target = event.target;

      // Handle Sorting Change
      if (target.matches('[data-collection-sort]')) {
        const sortValue = target.value;
        document.querySelectorAll('[data-collection-sort]').forEach((select) => {
          if (select !== target) select.value = sortValue;
        });
        this.submitFilters(sortValue);
        return;
      }

      // Handle Checkboxes & Radios
      if (target.matches('input[type="checkbox"]') || target.matches('input[type="radio"]')) {
        this.submitFilters();
      }
    }

    onInput(event) {
      const target = event.target;
      if (target.matches('[data-min-input]') || target.matches('[data-max-input]')) {
        this.syncInputToSlider(target);
        this.submitFilters();
      }
    }

    onSearchInput(input) {
      const query = (input.value || '').trim().toLowerCase();

      // Synchronize all search input elements on the page
      document.querySelectorAll('[data-collection-search-input]').forEach((el) => {
        if (el !== input) el.value = input.value;
      });

      // Toggle clear button
      document.querySelectorAll('[data-collection-search-clear]').forEach((btn) => {
        btn.hidden = query.length === 0;
      });

      // Filter visible products in product grid
      const cards = this.querySelectorAll('#ProductGrid .product-card');
      let visibleCount = 0;

      cards.forEach((card) => {
        const text = (card.textContent || '').toLowerCase();
        if (!query || text.includes(query)) {
          card.removeAttribute('hidden');
          card.style.display = '';
          visibleCount++;
        } else {
          card.setAttribute('hidden', '');
          card.style.display = 'none';
        }
      });

      // Handle empty search result message
      let emptyMsg = this.querySelector('#ProductGrid .collection-search-empty');
      if (query && visibleCount === 0 && cards.length > 0) {
        if (!emptyMsg) {
          emptyMsg = document.createElement('div');
          emptyMsg.className = 'collection-search-empty';
          emptyMsg.style.cssText = 'grid-column: 1 / -1; text-align: center; padding: 4rem 1rem;';
          emptyMsg.innerHTML = `<p style="font-size: 1.125rem; opacity: 0.8; margin-bottom: 1rem;">No products match "${input.value}"</p>`;
          this.querySelector('#ProductGrid')?.appendChild(emptyMsg);
        }
      } else if (emptyMsg) {
        emptyMsg.remove();
      }

      // Update counter
      const countEl = this.querySelector('[data-product-count]');
      if (countEl) {
        countEl.textContent = query
          ? `${visibleCount} ${visibleCount === 1 ? 'PRODUCT' : 'PRODUCTS'} FOUND`
          : countEl.dataset.originalCount || countEl.textContent;
      }
    }

    clearSearch() {
      document.querySelectorAll('[data-collection-search-input]').forEach((input) => {
        input.value = '';
      });
      document.querySelectorAll('[data-collection-search-clear]').forEach((btn) => {
        btn.hidden = true;
      });
      const cards = this.querySelectorAll('#ProductGrid .product-card');
      cards.forEach((card) => {
        card.removeAttribute('hidden');
        card.style.display = '';
      });
      const emptyMsg = this.querySelector('#ProductGrid .collection-search-empty');
      if (emptyMsg) emptyMsg.remove();

      const countEl = this.querySelector('[data-product-count]');
      if (countEl && countEl.dataset.originalCount) {
        countEl.textContent = countEl.dataset.originalCount;
      }
    }

    onClick(event) {
      // Search Clear Button
      const searchClear = event.target.closest('[data-collection-search-clear]');
      if (searchClear) {
        event.preventDefault();
        this.clearSearch();
        return;
      }

      // Filter Remove Tag
      const removeBtn = event.target.closest('[data-filter-remove]');
      if (removeBtn) {
        event.preventDefault();
        const url = new URL(removeBtn.getAttribute('href'), window.location.origin);
        const activeSort = this.getActiveSortValue();
        if (activeSort && !url.searchParams.has('sort_by')) {
          url.searchParams.set('sort_by', activeSort);
        }
        this.renderFromUrl(url);
        return;
      }

      // Filter Clear All
      const clearAllBtn = event.target.closest('[data-filter-clear-all]');
      if (clearAllBtn) {
        event.preventDefault();
        const url = new URL(clearAllBtn.getAttribute('href'), window.location.origin);
        const activeSort = this.getActiveSortValue();
        if (activeSort && !url.searchParams.has('sort_by')) {
          url.searchParams.set('sort_by', activeSort);
        }
        this.clearSearch();
        this.renderFromUrl(url);
        return;
      }

      // Pagination Links
      const pageLink = event.target.closest('[data-pagination-link]');
      if (pageLink) {
        event.preventDefault();
        const url = new URL(pageLink.getAttribute('href'), window.location.origin);
        this.renderFromUrl(url, { scrollToTop: true });
        return;
      }

      // Load More Button
      const loadMoreBtn = event.target.closest('[data-load-more]');
      if (loadMoreBtn) {
        event.preventDefault();
        const nextUrl = loadMoreBtn.dataset.nextUrl;
        if (nextUrl) {
          const url = new URL(nextUrl, window.location.origin);
          this.loadMoreProducts(url, loadMoreBtn);
        }
        return;
      }

      // View Density Switcher
      const viewBtn = event.target.closest('[data-view-columns]');
      if (viewBtn) {
        event.preventDefault();
        const cols = viewBtn.dataset.viewColumns;
        this.setGridColumns(cols);
      }
    }

    getActiveSortValue() {
      const activeSelect = document.querySelector('[data-collection-sort]');
      if (activeSelect && activeSelect.value) {
        return activeSelect.value;
      }
      const urlParams = new URLSearchParams(window.location.search);
      return urlParams.get('sort_by') || '';
    }

    setGridColumns(cols) {
      const grids = this.querySelectorAll('.product-grid');
      grids.forEach((grid) => {
        grid.setAttribute('data-columns-desktop', cols);
      });

      this.querySelectorAll('[data-view-columns]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.viewColumns === cols);
      });

      try {
        sessionStorage.setItem('arc:collection:columns', cols);
      } catch (e) {}
    }

    restoreViewPreference() {
      try {
        const savedCols = sessionStorage.getItem('arc:collection:columns');
        if (savedCols) {
          this.setGridColumns(savedCols);
        }
      } catch (e) {}
    }

    buildSearchParams(explicitSortValue) {
      const forms = [];
      const mainForm = this.querySelector('#CollectionFiltersForm');
      if (mainForm) forms.push(mainForm);

      if (this.drawer) {
        const drawerForm = this.drawer.querySelector('form');
        if (drawerForm && drawerForm !== mainForm) forms.push(drawerForm);
      }

      const params = new URLSearchParams();

      forms.forEach((form) => {
        const formData = new FormData(form);
        for (const [key, value] of formData.entries()) {
          // Exclude sort_by and empty values
          if (key === 'sort_by') continue;
          if (value !== '' && value !== null) {
            params.append(key, value);
          }
        }
      });

      // Synchronize Sort By
      const sortValue = explicitSortValue !== undefined ? explicitSortValue : this.getActiveSortValue();
      if (sortValue) {
        params.set('sort_by', sortValue);
      }

      return params;
    }

    submitFilters(explicitSortValue) {
      const params = this.buildSearchParams(explicitSortValue);
      const url = new URL(window.location.pathname, window.location.origin);
      url.search = params.toString();
      this.renderFromUrl(url);
    }

    async renderFromUrl(url, options = {}) {
      this.setLoading(true);

      try {
        const fetchUrl = new URL(url.pathname, window.location.origin);
        fetchUrl.search = url.search;
        fetchUrl.searchParams.set('section_id', this.sectionId);

        const response = await fetch(fetchUrl.toString());
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);

        const text = await response.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');

        this.updateDOM(doc, url);

        window.history.pushState({ url: url.href }, '', url.href);

        if (options.scrollToTop) {
          this.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        this.announceResults();
      } catch (error) {
        console.error('Collection filter error:', error);
      } finally {
        this.setLoading(false);
      }
    }

    async loadMoreProducts(url, button) {
      button.classList.add('is-loading');

      try {
        const fetchUrl = new URL(url.pathname, window.location.origin);
        fetchUrl.search = url.search;
        fetchUrl.searchParams.set('section_id', this.sectionId);

        const response = await fetch(fetchUrl.toString());
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);

        const text = await response.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');

        // Append products
        const newProducts = doc.querySelectorAll('#ProductGrid .product-card');
        const currentGrid = this.querySelector('#ProductGrid');
        if (currentGrid && newProducts.length) {
          newProducts.forEach((card) => currentGrid.appendChild(card));
        }

        // Update pagination container
        const newPagination = doc.querySelector('#CollectionPagination');
        const currentPagination = this.querySelector('#CollectionPagination');
        if (currentPagination && newPagination) {
          currentPagination.innerHTML = newPagination.innerHTML;
        }

        // Update URL state without page reload
        window.history.replaceState({ url: url.href }, '', url.href);

        if (this.statusEl) {
          const totalCount = this.querySelector('[data-load-more-count]')?.textContent;
          if (totalCount) this.statusEl.textContent = totalCount;
        }
      } catch (error) {
        console.error('Load more error:', error);
        button.classList.remove('is-loading');
      }
    }

    updateDOM(doc, url) {
      // 1. Update Product Grid
      const newGridContainer = doc.querySelector('#ProductGridContainer');
      if (this.productGridContainer && newGridContainer) {
        this.productGridContainer.innerHTML = newGridContainer.innerHTML;
      }

      // 2. Update Active Filters (in page and toolbar)
      const newActiveFilters = doc.querySelector('#CollectionActiveFilters');
      const currentActiveFilters = this.querySelector('#CollectionActiveFilters');
      if (currentActiveFilters && newActiveFilters) {
        currentActiveFilters.outerHTML = newActiveFilters.outerHTML;
      }

      // 3. Update Toolbar Counts and Badges
      const newCount = doc.querySelector('[data-product-count]');
      const currentCount = this.querySelector('[data-product-count]');
      if (currentCount && newCount) {
        currentCount.innerHTML = newCount.innerHTML;
        currentCount.dataset.originalCount = newCount.innerHTML;
      }

      const newToolbarFilterCount = doc.querySelector('[data-filter-active-count]');
      const currentToolbarFilterCount = this.querySelector('[data-filter-active-count]');
      if (currentToolbarFilterCount && newToolbarFilterCount) {
        currentToolbarFilterCount.innerHTML = newToolbarFilterCount.innerHTML;
        currentToolbarFilterCount.hidden = newToolbarFilterCount.hasAttribute('hidden');
      }

      // 4. Update Sort Selects to reflect active sort option
      const activeSort = url?.searchParams?.get('sort_by') || doc.querySelector('[data-collection-sort]')?.value;
      if (activeSort) {
        document.querySelectorAll('[data-collection-sort]').forEach((select) => {
          select.value = activeSort;
        });
      }

      // 5. Update Filter Drawer Content (keeps facet counts & disabled states fresh)
      if (this.drawer) {
        const newDrawerBody = doc.querySelector(`collection-filter-drawer[id="CollectionFiltersDrawer-${this.sectionId}"] .collection-filter-drawer__body`) || doc.querySelector('.collection-filter-drawer__body');
        const currentDrawerBody = this.drawer.querySelector('.collection-filter-drawer__body');
        if (currentDrawerBody && newDrawerBody) {
          const openIndices = new Set();
          currentDrawerBody.querySelectorAll('details[open]').forEach((d) => {
            if (d.dataset.filterIndex) openIndices.add(d.dataset.filterIndex);
          });

          currentDrawerBody.innerHTML = newDrawerBody.innerHTML;

          currentDrawerBody.querySelectorAll('details').forEach((d) => {
            if (openIndices.has(d.dataset.filterIndex)) d.setAttribute('open', '');
          });

          if (activeSort) {
            const drawerSort = currentDrawerBody.querySelector('[data-collection-sort]');
            if (drawerSort) drawerSort.value = activeSort;
          }
        }
      }

      // 6. Update Desktop Sidebar / Horizontal filters if present
      const newSidebar = doc.querySelector('.collection-sidebar');
      const currentSidebar = this.querySelector('.collection-sidebar');
      if (currentSidebar && newSidebar) {
        currentSidebar.innerHTML = newSidebar.innerHTML;
      }

      const newHorizontal = doc.querySelector('.collection-filters--horizontal');
      const currentHorizontal = this.querySelector('.collection-filters--horizontal');
      if (currentHorizontal && newHorizontal) {
        currentHorizontal.innerHTML = newHorizontal.innerHTML;
      }

      // 7. Update Pagination
      const newPagination = doc.querySelector('#CollectionPagination');
      const currentPagination = this.querySelector('#CollectionPagination');
      if (currentPagination && newPagination) {
        currentPagination.innerHTML = newPagination.innerHTML;
      }

      // Re-initialize dynamic behaviors
      this.initPriceSliders();
      this.restoreViewPreference();
    }

    onHistoryChange(event) {
      const url = new URL(window.location.href);
      this.renderFromUrl(url);
    }

    setLoading(isLoading) {
      this.classList.toggle('is-loading', isLoading);
      if (this.productGridContainer) {
        this.productGridContainer.setAttribute('aria-busy', isLoading ? 'true' : 'false');
      }
    }

    announceResults() {
      if (!this.statusEl) return;
      const countEl = this.querySelector('[data-product-count]') || this.querySelector('#ProductGridContainer');
      const countText = countEl ? countEl.textContent.trim() : '';
      if (countText) {
        this.statusEl.textContent = countText;
      }
    }

    initPriceSliders() {
      const sliders = this.querySelectorAll('[data-price-slider]');
      sliders.forEach((slider) => {
        const minRange = slider.querySelector('[data-slider-min]');
        const maxRange = slider.querySelector('[data-slider-max]');
        const progress = slider.querySelector('[data-slider-progress]');
        const container = slider.closest('[data-price-range]');
        const minInput = container?.querySelector('[data-min-input]');
        const maxInput = container?.querySelector('[data-max-input]');

        if (!minRange || !maxRange || !progress) return;

        const maxBound = parseFloat(slider.dataset.max) || 1000;

        const updateProgress = () => {
          let minVal = parseFloat(minRange.value) || 0;
          let maxVal = parseFloat(maxRange.value) || maxBound;

          if (minVal > maxVal) {
            const temp = minVal;
            minVal = maxVal;
            maxVal = temp;
          }

          const leftPct = (minVal / maxBound) * 100;
          const rightPct = 100 - (maxVal / maxBound) * 100;

          progress.style.left = `${leftPct}%`;
          progress.style.right = `${rightPct}%`;
        };

        minRange.addEventListener('input', () => {
          if (parseFloat(minRange.value) > parseFloat(maxRange.value)) {
            minRange.value = maxRange.value;
          }
          if (minInput) minInput.value = minRange.value;
          updateProgress();
        });

        maxRange.addEventListener('input', () => {
          if (parseFloat(maxRange.value) < parseFloat(minRange.value)) {
            maxRange.value = minRange.value;
          }
          if (maxInput) maxInput.value = maxRange.value;
          updateProgress();
        });

        minRange.addEventListener('change', () => this.submitFilters());
        maxRange.addEventListener('change', () => this.submitFilters());

        updateProgress();
      });
    }

    syncInputToSlider(input) {
      const container = input.closest('[data-price-range]');
      if (!container) return;

      const slider = container.querySelector('[data-price-slider]');
      if (!slider) return;

      const minRange = slider.querySelector('[data-slider-min]');
      const maxRange = slider.querySelector('[data-slider-max]');
      const progress = slider.querySelector('[data-slider-progress]');
      const maxBound = parseFloat(slider.dataset.max) || 1000;

      if (input.matches('[data-min-input]') && minRange) {
        minRange.value = input.value || 0;
      } else if (input.matches('[data-max-input]') && maxRange) {
        maxRange.value = input.value || maxBound;
      }

      if (progress && minRange && maxRange) {
        const minVal = parseFloat(minRange.value) || 0;
        const maxVal = parseFloat(maxRange.value) || maxBound;
        progress.style.left = `${(minVal / maxBound) * 100}%`;
        progress.style.right = `${100 - (maxVal / maxBound) * 100}%`;
      }
    }
  }

  if (!customElements.get('collection-container')) {
    customElements.define('collection-container', CollectionContainer);
  }
})();
