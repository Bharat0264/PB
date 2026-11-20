/* Wildfire effects: a quiet field of rising embers plus film grain, and the cinematic home page.
   Registered with the Theme Engine (window.PrintBeeThemeEffects.wildfire). The engine calls start() when Wildfire
   becomes the active theme and stop() when another theme takes over, so nothing runs or stays in the page otherwise.

   Cost control (the site must stay smooth, so the effects are the first thing to go):
   - the page-wide embers and grain are skipped on low-power devices and inside the embedded tab pages (the home page's own
     3D scene already has embers), and the page keeps a still forest background there;
   - otherwise one small canvas, drawn at 1x pixel ratio and at most 30 times a second, pre-rendered sprites, a small
     particle count that halves itself if frames run slow;
   - nothing is drawn while the tab is hidden or when the person prefers reduced motion. */
(() => {
  'use strict';
  const registry = (window.PrintBeeThemeEffects = window.PrintBeeThemeEffects || {});
  if (registry.wildfire) return;

  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const COLOURS = ['#F05A24', '#D68A32', '#C49A52', '#FF8A3D'];
  const FRAME = 1000 / 30;

  let active = false, canvas, ctx, grain, sprites, particles, frame, last, tick = 0, running = false, width = 0, height = 0, slow = 0, resizeTimer, home;

  const lowPower = () => Boolean(window.PrintBeeThemes && window.PrintBeeThemes.lowPower);
  const embedded = () => window.parent !== window;                  // a tab page shown inside the phone shell

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

  const target = () => Math.round(Math.min(26, Math.max(10, width / 55)));

  function spawn(initial) {
    return {
      x: Math.random() * width,
      y: initial ? Math.random() * height : height + 10 + Math.random() * 60,
      size: 3 + Math.random() * 6,
      speed: 14 + Math.random() * 30,
      sway: 6 + Math.random() * 18,
      phase: Math.random() * Math.PI * 2,
      rate: .4 + Math.random() * .9,
      flicker: Math.random() * Math.PI * 2,
      sprite: sprites[Math.floor(Math.random() * sprites.length)],
      peak: .35 + Math.random() * .5,
    };
  }

  function resize() {
    if (!canvas) return;
    width = innerWidth;
    height = innerHeight;
    canvas.width = width;                 // 1x: these are soft glows, they do not need a sharp pixel grid
    canvas.height = height;
    const wanted = target() >> slow;
    while (particles.length < wanted) particles.push(spawn(true));
    particles.length = Math.min(particles.length, wanted);
  }
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); };

  function draw(time) {
    frame = requestAnimationFrame(draw);
    if (time - tick < FRAME - 2) return;                           // at most about 30 frames a second
    const dt = Math.min(.08, (time - (last || time)) / 1000);
    tick = time;
    last = time;
    if (dt > .05) { if (++slow > 20 && particles.length > 8) { particles.length = Math.round(particles.length / 2); slow = 0; } }
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

  function startEmbers() {
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
    play();
  }

  function start() {
    if (active) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', start, {once: true}); return; }
    active = true;
    const light = lowPower() || embedded();
    root.classList.toggle('wf-lite', light);                         // still background, no page-wide animation
    if (!light) startEmbers();
    // The cinematic home page exists only on the home page. It must wait until the page is fully parsed: when this script
    // comes from the cache it can start before <main> exists, and the check would wrongly say "not the home page".
    // It loads lazily and stop() removes it again.
    const startHome = () => {
      if (!active || home || !document.querySelector('main#main > .hero')) return;
      import('/themes/wildfire-home.js?v=9')
        .then(module => module.mount())
        .then(api => { if (active && !home) home = api; else api.destroy(); })
        .catch(error => console.warn('[Wildfire] the home layer did not start', error));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startHome, {once: true}); else startHome();
  }

  function stop() {
    active = false;
    home?.destroy();
    home = null;
    pause();
    removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener('change', onMotion);
    canvas?.remove();
    grain?.remove();
    canvas = ctx = grain = sprites = particles = null;
    root.classList.remove('wf-lite');
  }

  registry.wildfire = {start, stop};
})();
