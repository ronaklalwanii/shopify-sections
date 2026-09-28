/* Moving the pointer over a card moves the single "active" state to it.
   The active card stays open after the pointer leaves — there is no
   restore-to-first behavior; the state only moves on the next activation.
   Delegated at document level so theme-editor re-renders need no
   re-initialization. */
(() => {
  function activate(card) {
    if (card.classList.contains('reveal-card--active')) return;
    const section = card.closest('.reveal-cards');
    if (!section) return;
    section.querySelectorAll('.reveal-card').forEach((item) => {
      item.classList.remove('reveal-card--active');
    });
    card.classList.add('reveal-card--active');
  }

  document.addEventListener('mouseover', (event) => {
    const card = event.target.closest('.reveal-card');
    if (card) activate(card);
  });

  // Keyboard parity: focusing a card (or its content) moves the active state.
  document.addEventListener('focusin', (event) => {
    const card = event.target.closest('.reveal-card');
    if (card) activate(card);
  });
})();
