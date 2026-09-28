(() => {
  const mobileQuery = window.matchMedia('(max-width: 749px)');

  function syncFooterDetails() {
    document.querySelectorAll('.footer__block-details').forEach((details) => {
      if (!mobileQuery.matches) details.open = true;
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.footer__block-details').forEach((details) => {
      const summary = details.querySelector('summary');
      if (!summary) return;
      summary.addEventListener('click', (event) => {
        if (!mobileQuery.matches) event.preventDefault();
      });
    });
    syncFooterDetails();
    mobileQuery.addEventListener('change', syncFooterDetails);
  });
})();
