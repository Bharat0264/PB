/* The welcome page's clay bee: its eyes follow the pointer, it covers its eyes while you type your email,
 * and it cheers when the sign-in link has been sent. Only transforms are animated (cheap, smooth). */
(() => {
  'use strict';
  const mascot = document.querySelector('.mascot');
  if (!mascot) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const pupils = [...mascot.querySelectorAll('.pupil')];
  let frame = 0;

  function look(x, y) {
    if (reduce.matches) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const pupil of pupils) {
        const box = pupil.parentElement.getBoundingClientRect();
        const dx = x - (box.left + box.width / 2);
        const dy = y - (box.top + box.height / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, distance / 220) * 6.5;
        pupil.style.transform = `translate(${(dx / distance) * reach}px, ${(dy / distance) * reach}px)`;
      }
    });
  }
  addEventListener('pointermove', event => look(event.clientX, event.clientY), {passive: true});

  // Look down at the form while typing, cover the eyes on focus.
  const email = document.querySelector('#welcome-email');
  email?.addEventListener('focus', () => mascot.classList.add('is-hiding'));
  email?.addEventListener('blur', () => mascot.classList.remove('is-hiding'));

  function cheer() {
    mascot.classList.remove('is-hiding');
    mascot.classList.add('is-happy');
    setTimeout(() => mascot.classList.remove('is-happy'), 2600);
  }
  addEventListener('printbee:link-sent', cheer);
})();
