/* Wildfire effects: a quiet field of rising embers plus film grain.
   Registered with the Theme Engine (window.PrintBeeThemeEffects.wildfire). The engine calls start() when Wildfire
   becomes the active theme and stop() when another theme takes over, so nothing runs or stays in the page otherwise.
   Cost control: one small canvas, pre-rendered sprites, capped pixel ratio, paused while the tab is hidden or
   the person prefers reduced motion, and the particle count halves itself if frames run slow. */
(() => {
  'use strict';
  const registry = (window.PrintBeeThemeEffects = window.PrintBeeThemeEffects || {});
  if (registry.wildfire) return;

  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const COLOURS = ['#F05A24', '#D68A32', '#C49A52', '#FF8A3D'];

  let canvas, ctx, grain, sprites, particles, frame, last, running = false, width = 0, height = 0, ratio = 1, slow = 0, resizeTimer, home;

  function makeSprites() {
    return COLOURS.map(colour => {
      const sprite = document.createElement('canvas');
      sprite.width = sprite.height = 32;
      const c = sprite.getContext('2d');
      const glow = c.createRadialGradient(16, 16, 0, 16, 16, 16);
      glow.addColorStop(0, '#FFE2B0');
      glow.addColorStop(.18, colour);
      glow.addColorStop(.55, colour + '55');
      glow.addColorStop(1, colour + '00');
      c.fillStyle = glow;
      c.fillRect(0, 0, 32, 32);
      return sprite;
    });
  }

  const target = () => Math.round(Math.min(46, Math.max(16, width / 40)));

  function spawn(initial) {
    return {
      x: Math.random() * width,
      y: initial ? Math.random() * height : height + 10 + Math.random() * 60,
      size: 3 + Math.random() * 7,
      speed: 14 + Math.random() * 30,
      sway: 6 + Math.random() * 18,
      phase: Math.random() * Math.PI * 2,
      rate: .4 + Math.random() * .9,
      flicker: Math.random() * Math.PI * 2,
      sprite: sprites[Math.floor(Math.random() * sprites.length)],
      peak: .35 + Math.random() * .55,
    };
  }

  function resize() {
    if (!canvas) return;
    ratio = Math.min(devicePixelRatio || 1, 1.5);
    width = innerWidth;
    height = innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const wanted = target() >> slow;
    while (particles.length < wanted) particles.push(spawn(true));
    particles.length = Math.min(particles.length, wanted);
  }
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); };

  function draw(time) {
    frame = requestAnimationFrame(draw);
    const dt = Math.min(.05, (time - (last || time)) / 1000);
    last = time;
    if (dt > .034) { if (++slow > 40 && particles.length > 10) { particles.length = Math.round(particles.length / 2); slow = 0; } }
    else if (slow > 0) slow -= .02;
    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.y -= p.speed * dt;
      p.phase += p.rate * dt;
      p.flicker += dt * (3 + p.rate * 4);
      if (p.y < -20) Object.assign(p, spawn(false));
      const x = p.x + Math.sin(p.phase) * p.sway;
      const fade = Math.min(1, p.y / (height * .35), (height - p.y) / 50);          // glow out near the top, in at the bottom
      const alpha = Math.max(0, p.peak * fade * (.72 + .28 * Math.sin(p.flicker)));
      if (alpha < .02) continue;
      ctx.globalAlpha = alpha;
      ctx.drawImage(p.sprite, x - p.size, p.y - p.size, p.size * 2, p.size * 2);
    }
    ctx.globalAlpha = 1;
  }

  function play() {
    if (running || !canvas || reduced.matches || document.hidden) return;
    running = true;
    last = 0;
    frame = requestAnimationFrame(draw);
  }
  function pause() { running = false; cancelAnimationFrame(frame); }
  const onVisibility = () => (document.hidden ? pause() : play());
  const onMotion = () => { if (reduced.matches) { pause(); ctx?.clearRect(0, 0, width, height); } else play(); };

  function start() {
    if (canvas) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', start, {once: true}); return; }
    sprites = makeSprites();
    particles = [];
    canvas = document.createElement('canvas');
    canvas.className = 'wf-embers';
    canvas.setAttribute('aria-hidden', 'true');
    ctx = canvas.getContext('2d');
    grain = document.createElement('div');
    grain.className = 'wf-grain';
    grain.setAttribute('aria-hidden', 'true');
    document.body.append(grain, canvas);
    resize();
    addEventListener('resize', onResize, {passive: true});
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onMotion);
    root.classList.add('wf-igniting');
    setTimeout(() => root.classList.remove('wf-igniting'), 1500);
    play();
    // The cinematic home page exists only on the home page. It must wait until the page is fully parsed: when this script
    // comes from the cache it can start before <main> exists, and the check would wrongly say "not the home page".
    // It loads lazily and stop() removes it again.
    const startHome = () => {
      if (!canvas || home || !document.querySelector('main#main > .hero')) return;
      import('/themes/wildfire-home.js?v=5')
        .then(module => module.mount())
        .then(api => { if (canvas && !home) home = api; else api.destroy(); })
        .catch(error => console.warn('[Wildfire] the home layer did not start', error));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startHome, {once: true}); else startHome();
  }

  function stop() {
    home?.destroy();
    home = null;
    pause();
    removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener('change', onMotion);
    canvas?.remove();
    grain?.remove();
    canvas = ctx = grain = sprites = particles = null;
    root.classList.remove('wf-igniting');
  }

  registry.wildfire = {start, stop};
})();
