(function () {
  'use strict';

  function initSection(sectionEl) {
    if (!sectionEl) return;

    const sectionId = sectionEl.dataset.sectionId;
    if (!sectionId) return;

    const statItems = sectionEl.querySelectorAll('.wb-stats-banner__item');

    if (statItems.length > 0 && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry, index) {
            if (entry.isIntersecting) {
              setTimeout(function () {
                entry.target.classList.add('is-visible');
              }, index * 80);
              observer.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15 }
      );

      statItems.forEach(function (item) {
        observer.observe(item);
      });

      sectionEl._wbObserver = observer;
    } else {
      statItems.forEach(function (item) {
        item.classList.add('is-visible');
      });
    }
  }

  function destroySection(sectionEl) {
    if (!sectionEl) return;
    if (sectionEl._wbObserver) {
      sectionEl._wbObserver.disconnect();
      delete sectionEl._wbObserver;
    }
  }

  document.addEventListener('shopify:section:load', function (event) {
    var sectionId = event.detail.sectionId;
    var sectionEl = document.querySelector('[data-section-id="' + sectionId + '"]');
    if (sectionEl && sectionEl.classList.contains('wb-section')) {
      initSection(sectionEl);
    }
  });

  document.addEventListener('shopify:section:unload', function (event) {
    var sectionId = event.detail.sectionId;
    var sectionEl = document.querySelector('[data-section-id="' + sectionId + '"]');
    if (sectionEl && sectionEl.classList.contains('wb-section')) {
      destroySection(sectionEl);
    }
  });

  document.addEventListener('shopify:section:select', function (event) {
    var sectionId = event.detail.sectionId;
    var sectionEl = document.querySelector('[data-section-id="' + sectionId + '"]');
    if (sectionEl && sectionEl.classList.contains('wb-section')) {
      initSection(sectionEl);
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    var sections = document.querySelectorAll('.wb-section[data-section-id]');
    sections.forEach(function (sectionEl) {
      initSection(sectionEl);
    });
  });
})();