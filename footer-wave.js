(() => {
  const panel = document.querySelector('.footer-wave');
  if (!panel) return;
  const letters = [...panel.querySelectorAll('.footer-wave-word span')];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const mouse = matchMedia('(hover: hover) and (pointer: fine)');
  const compress = [1, .59, .45, .61, .9, 1.036, 1].map((height, index) => ({
    offset: [0, .2, .36, .52, .7, .86, 1][index],
    transform: `scaleY(${height})`,
  }));
  const motions = new WeakMap();
  let entered = false;
  let previousLetter = null;

  function squash(letter, delay = 0) {
    if (reducedMotion.matches || motions.get(letter)?.playState === 'running') return;
    motions.set(letter, letter.animate(compress, {duration: 610, delay, easing: 'ease-in-out'}));
  }

  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) letters.forEach(letter => motions.get(letter)?.cancel());
  });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      entered = true;
      observer.disconnect();
      letters.forEach((letter, index) => squash(letter, index * 58));
    }, {threshold: .45});
    observer.observe(panel);
  } else {
    entered = true;
  }

  // Layout coordinates stay stable while the rendered letters squash.
  panel.addEventListener('pointermove', event => {
    if (!entered || !mouse.matches || event.pointerType !== 'mouse') return;
    const word = letters[0].parentElement.getBoundingClientRect();
    const x = event.clientX - word.left;
    const letter = letters.find(item => x >= item.offsetLeft && x < item.offsetLeft + item.offsetWidth);
    if (!letter || letter === previousLetter) return;
    previousLetter = letter;
    squash(letter);
  }, {passive: true});
  panel.addEventListener('pointerleave', () => { previousLetter = null; });
})();
