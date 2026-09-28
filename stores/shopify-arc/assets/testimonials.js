(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.querySelectorAll('[data-testimonials]').forEach((wrapper) => {
    const thumbs = [...wrapper.querySelectorAll('[data-testimonial-thumb]')];
    const contents = [...wrapper.querySelectorAll('[data-testimonial-content]')];
    const thumbsRail = wrapper.querySelector('.testimonials__thumbs');
    if (!thumbs.length) return;

    const showProgress = wrapper.dataset.progress === 'true' && !reduceMotion;

    let activeIndex = thumbs.findIndex((t) => t.classList.contains('is-active'));
    if (activeIndex < 0) activeIndex = 0;

    let timer = null;

    function restartProgress(index) {
      if (!showProgress) return;
      thumbs.forEach((t) => t.classList.remove('is-ticking'));
      const activeThumb = thumbs.find((t) => Number(t.dataset.index) === index);
      if (!activeThumb) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          activeThumb.classList.add('is-ticking');
        });
      });
    }

    function setActive(index) {
      activeIndex = index;
      thumbs.forEach((t) => t.classList.toggle('is-active', Number(t.dataset.index) === index));
      contents.forEach((c) => c.classList.toggle('is-active', Number(c.dataset.index) === index));
      restartProgress(index);
    }

    function next() {
      setActive((activeIndex + 1) % thumbs.length);
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      wrapper.classList.add('is-paused');
    }

    function start() {
      wrapper.classList.remove('is-paused');
      if (reduceMotion || thumbs.length < 2) return;
      const speed = parseInt(wrapper.dataset.autorotateSpeed, 10) || 6000;
      if (timer) clearInterval(timer);
      timer = setInterval(next, speed);
    }

    thumbs.forEach((thumb) => {
      thumb.addEventListener('click', () => {
        setActive(Number(thumb.dataset.index));
        if (wrapper.dataset.autorotate === 'true') start();
      });
    });

    if (showProgress) restartProgress(activeIndex);

    if (wrapper.dataset.autorotate === 'true') {
      start();
      // Pause only while hovering the thumbnail/avatar rail, not the quote
      // panel - reading the content shouldn't stall the rotation.
      if (thumbsRail) {
        thumbsRail.addEventListener('mouseenter', stop);
        thumbsRail.addEventListener('mouseleave', start);
      }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop();
        else start();
      });
    }
  });
})();
