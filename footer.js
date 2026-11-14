(() => {
  const footer = document.querySelector('.printbee-footer');
  if (!footer) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  const top = footer.querySelector('.printbee-footer-top');
  const wordmark = footer.querySelector('.printbee-footer-wordmark');
  const status = footer.querySelector('.printbee-footer-status');
  const statusText = footer.dataset.status?.trim();
  if (statusText) {
    status.querySelector('span').textContent = statusText;
    status.hidden = false;
  }

  top.addEventListener('click', event => {
    if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    const target = document.getElementById('home');
    if (target) {
      target.tabIndex = -1;
      target.focus({preventScroll: true});
    }
    scrollTo({top: 0, behavior: reduced.matches ? 'instant' : 'smooth'});
  });

  let inView = false;
  let revealed = false;
  let frame = 0;
  function parallax() {
    frame = 0;
    if (!inView || reduced.matches) return;
    const center = wordmark.getBoundingClientRect().top + wordmark.offsetHeight / 2;
    const progress = Math.min(1, Math.max(0, 1 - center / innerHeight));
    wordmark.style.setProperty('--wordmark-y', (5 - progress * 13) + 'px');
    wordmark.style.setProperty('--wordmark-scale', 1 + progress * .02);
  }
  addEventListener('scroll', () => {
    if (inView && !reduced.matches && !frame) frame = requestAnimationFrame(parallax);
  }, {passive: true});
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      wordmark.style.removeProperty('--wordmark-y');
      wordmark.style.removeProperty('--wordmark-scale');
      for (const animation of footer.getAnimations({subtree: true})) animation.cancel();
    }
  });

  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    footer.classList.toggle('is-in-view', inView);
    if (!inView || reduced.matches) return;
    parallax();
    if (revealed) return;
    revealed = true;
    const easing = 'cubic-bezier(.22,.7,.25,1)';
    footer.animate([{opacity: .4, transform: 'translateY(24px)'}, {opacity: 1, transform: 'none'}],
      {duration: 430, easing});
    footer.querySelectorAll('[data-footer-reveal]').forEach((item, index) => {
      item.animate([{opacity: .35, transform: 'translateY(14px)'}, {opacity: 1, transform: 'none'}],
        {duration: 360, delay: index * 60, easing, fill: 'backwards'});
    });
  }, {threshold: .12}).observe(footer);

  for (const button of footer.querySelectorAll('.footer-cta')) {
    let bounds;
    button.addEventListener('pointerenter', () => { bounds = button.getBoundingClientRect(); });
    button.addEventListener('pointermove', event => {
      if (!bounds || !pointer.matches || reduced.matches || event.pointerType !== 'mouse') return;
      const x = Math.max(-8, Math.min(8, (event.clientX - bounds.left - bounds.width / 2) * .045));
      const y = Math.max(-8, Math.min(8, (event.clientY - bounds.top - bounds.height / 2) * .16));
      button.style.translate = x + 'px ' + y + 'px';
    });
    button.addEventListener('pointerleave', () => { button.style.translate = ''; });
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || reduced.matches) return;
      const bounds = button.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'footer-ripple';
      ripple.style.left = event.clientX - bounds.left + 'px';
      ripple.style.top = event.clientY - bounds.top + 'px';
      button.prepend(ripple);
      ripple.animate([{scale: 0, opacity: .65}, {scale: 8, opacity: 0}], {duration: 470})
        .finished.then(() => ripple.remove(), () => ripple.remove());
    });
  }
})();
