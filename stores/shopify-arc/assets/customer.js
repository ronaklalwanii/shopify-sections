/**
 * Customer account pages: address management helpers.
 *
 * Self-contained on purpose — the theme's global.js does not ship Shopify's
 * country/province selector or postLink helpers, so they are defined here and
 * only loaded on templates/customers/* (via sections/main-addresses.liquid).
 */
window.Shopify = window.Shopify || {};

Shopify.addListener = function (target, eventName, callback) {
  target.addEventListener
    ? target.addEventListener(eventName, callback, false)
    : target.attachEvent('on' + eventName, callback);
};

Shopify.bind = function (fn, scope) {
  return function () {
    return fn.apply(scope, arguments);
  };
};

Shopify.setSelectorByValue = function (selector, value) {
  for (let i = 0, count = selector.options.length; i < count; i++) {
    const option = selector.options[i];
    if (value === option.value || value === option.innerHTML) {
      selector.selectedIndex = i;
      return i;
    }
  }
};

Shopify.postLink = function (path, options) {
  options = options || {};
  const method = options.method || 'post';
  const params = options.parameters || {};

  const form = document.createElement('form');
  form.setAttribute('method', method);
  form.setAttribute('action', path);

  for (const key in params) {
    const hiddenField = document.createElement('input');
    hiddenField.setAttribute('type', 'hidden');
    hiddenField.setAttribute('name', key);
    hiddenField.setAttribute('value', params[key]);
    form.appendChild(hiddenField);
  }
  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
};

Shopify.CountryProvinceSelector = function (countryDomId, provinceDomId, options) {
  this.countryEl = document.getElementById(countryDomId);
  this.provinceEl = document.getElementById(provinceDomId);
  this.provinceContainer = document.getElementById(options.hideElement || provinceDomId);

  Shopify.addListener(this.countryEl, 'change', Shopify.bind(this.countryHandler, this));

  this.initCountry();
  this.initProvince();
};

Shopify.CountryProvinceSelector.prototype = {
  initCountry() {
    const value = this.countryEl.getAttribute('data-default');
    Shopify.setSelectorByValue(this.countryEl, value);
    this.countryHandler();
  },

  initProvince() {
    const value = this.provinceEl.getAttribute('data-default');
    if (value && this.provinceEl.options.length > 0) {
      Shopify.setSelectorByValue(this.provinceEl, value);
    }
  },

  countryHandler() {
    const opt = this.countryEl.options[this.countryEl.selectedIndex];
    const provinces = JSON.parse(opt.getAttribute('data-provinces'));

    this.clearOptions(this.provinceEl);
    if (provinces && provinces.length === 0) {
      this.provinceContainer.style.display = 'none';
    } else {
      for (let i = 0; i < provinces.length; i++) {
        const option = document.createElement('option');
        option.value = provinces[i][0];
        option.innerHTML = provinces[i][1];
        this.provinceEl.appendChild(option);
      }
      this.provinceContainer.style.display = '';
    }
  },

  clearOptions(selector) {
    while (selector.firstChild) {
      selector.removeChild(selector.firstChild);
    }
  },
};

const customerSelectors = {
  customerAddresses: '[data-customer-addresses]',
  addressCountrySelect: '[data-address-country-select]',
  addressContainer: '[data-address]',
  toggleAddressButton: 'button[aria-expanded]',
  cancelAddressButton: 'button[type="reset"]',
  deleteAddressButton: 'button[data-confirm-message]',
};

class CustomerAddresses {
  constructor() {
    this.elements = this.getElements();
    if (Object.keys(this.elements).length === 0) return;
    this.setupCountries();
    this.setupEventListeners();
  }

  getElements() {
    const container = document.querySelector(customerSelectors.customerAddresses);
    return container
      ? {
          container,
          addressContainer: container.querySelector(customerSelectors.addressContainer),
          toggleButtons: document.querySelectorAll(customerSelectors.toggleAddressButton),
          cancelButtons: container.querySelectorAll(customerSelectors.cancelAddressButton),
          deleteButtons: container.querySelectorAll(customerSelectors.deleteAddressButton),
          countrySelects: container.querySelectorAll(customerSelectors.addressCountrySelect),
        }
      : {};
  }

  setupCountries() {
    if (Shopify && Shopify.CountryProvinceSelector) {
      // eslint-disable-next-line no-new
      new Shopify.CountryProvinceSelector('AddressCountryNew', 'AddressProvinceNew', {
        hideElement: 'AddressProvinceContainerNew',
      });
      this.elements.countrySelects.forEach((select) => {
        const formId = select.dataset.formId;
        // eslint-disable-next-line no-new
        new Shopify.CountryProvinceSelector(`AddressCountry_${formId}`, `AddressProvince_${formId}`, {
          hideElement: `AddressProvinceContainer_${formId}`,
        });
      });
    }
  }

  setupEventListeners() {
    this.elements.toggleButtons.forEach((element) => {
      element.addEventListener('click', this.handleAddEditButtonClick);
    });
    this.elements.cancelButtons.forEach((element) => {
      element.addEventListener('click', this.handleCancelButtonClick);
    });
    this.elements.deleteButtons.forEach((element) => {
      element.addEventListener('click', this.handleDeleteButtonClick);
    });
  }

  toggleExpanded(target) {
    const expanded = target.getAttribute('aria-expanded') === 'true';
    target.setAttribute('aria-expanded', (!expanded).toString());

    // Keep the controlled form panel in sync with the button state. Done in JS
    // (instead of sibling CSS selectors) so the toggle survives any wrapper
    // markup around the buttons.
    const controlledId = target.getAttribute('aria-controls');
    if (controlledId) {
      const panel = document.getElementById(controlledId);
      if (panel) panel.hidden = expanded;
    }
  }

  handleAddEditButtonClick = ({ currentTarget }) => {
    this.toggleExpanded(currentTarget);
  };

  handleCancelButtonClick = ({ currentTarget }) => {
    this.toggleExpanded(
      currentTarget.closest(customerSelectors.addressContainer).querySelector('[aria-expanded]')
    );
  };

  handleDeleteButtonClick = ({ currentTarget }) => {
    // eslint-disable-next-line no-alert
    if (confirm(currentTarget.getAttribute('data-confirm-message'))) {
      Shopify.postLink(currentTarget.dataset.target, {
        parameters: { _method: 'delete' },
      });
    }
  };
}

if (document.querySelector(customerSelectors.customerAddresses)) {
  new CustomerAddresses();
}
