/* PrintBee preloader
 * One continuous story: the bee arrives, a progress ring (real load progress) draws around it,
 * the wordmark slides up, the tagline rises with a doc → printer → truck icon, then the ring
 * closes, the bee flies to the hero printer and a clay curtain lifts to reveal the page.
 *
 * Loaded as a classic <script> in <head>. Works on direct pages and inside the /home tab shell
 * (where the hero lives in the active iframe). GSAP is loaded lazily from this folder; if it
 * fails, a CSS fallback still exits on time. All motion uses transform, opacity or clip-path.
 */
(() => {
  'use strict';

  /* ---------- Edit here ---------- */
  const CONFIG = {
    minimum: 2800,        // ms: full intro never ends before this
    maximum: 4000,        // ms: exit starts by this point even if assets are still loading
    repeat: 600,          // ms: total length of the repeat-visit fade
    reducedExit: 400,     // ms: reduced-motion fade out
    sessionKey: 'printbee:preloader:v3',
    gsap: 'gsap-3.13.0.min.js',
    bee: 'preloader-bee.webp',
    wordmark: 'preloader-wordmark.webp',
    // Seconds on the master timeline.
    beats: { enter: 0, ring: .4, wordmark: .8, tagline: 1.4 },
    durations: { enter: .9, wordmark: .7, word: .55, ringClose: .45, curtain: .9, flight: .95, hero: .85 },
    float: { y: 6, tilt: 2, period: 1.6 },
    tagline: ['Upload.', 'Print.', 'Delivered.'],
    // Pages the mobile tab shell takes over (bottom-nav.js redirects these at ≤700px).
    shellPages: ['/', '/index.html', '/orders.html', '/queue.html', '/address.html', '/profile.html'],
  };
  /* -------------------------------- */

  // Never inside a tab iframe: the shell's own loader covers it.
  if (window.PrintBeePreloader || window.parent !== window) return;
  // Internal page-to-page clicks paint straight away; direct visits and reloads get the loader.
  const nav = performance.getEntriesByType('navigation')[0];
  if (document.referrer && nav?.type === 'navigate') {
    const previous = new URL(document.referrer);
    if (previous.origin === location.origin && previous.pathname !== location.pathname) return;
  }
  // On phones these pages immediately redirect into the shell, which shows the loader instead.
  if (CONFIG.shellPages.includes(location.pathname) && matchMedia('(max-width: 700px)').matches) return;

  const root = document.documentElement;
  const base = new URL('.', document.currentScript.src);
  const asset = file => new URL(file, base).href;
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let mode = 'full';
  try { if (sessionStorage.getItem(CONFIG.sessionKey)) mode = 'repeat'; } catch (_) { /* storage blocked */ }
  if (reduceMotion && mode === 'full') mode = 'reduced';

  /* cubic-bezier(.22,1,.36,1) as a GSAP ease function (no CustomEase plugin needed). */
  function bezier(x1, y1, x2, y2) {
    const a = (p1, p2) => 1 - 3 * p2 + 3 * p1, b = (p1, p2) => 3 * p2 - 6 * p1, c = p1 => 3 * p1;
    const at = (t, p1, p2) => ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t;
    const slope = (t, p1, p2) => 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1);
    return x => {
      let t = x;
      for (let i = 0; i < 6; i++) { const s = slope(t, x1, x2); if (!s) break; t -= (at(t, x1, x2) - x) / s; }
      return at(Math.min(1, Math.max(0, t)), y1, y2);
    };
  }
  const EASE = bezier(.22, 1, .36, 1);
  // Curtain shapes: same structure and units so GSAP can interpolate every number.
  const CLIP_OPEN = 'inset(0% 0% 0% 0% round 0% 0% 0% 0%)';
  const CLIP_LIFTED = 'inset(0% 0% 100% 0% round 0% 0% 50% 50%)';

  /* ---------- DOM ---------- */
  const ICONS = `
    <svg viewBox="0 0 24 24" data-i="0"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path class="acc" d="M10 12h5M10 15h5M10 18h3"/></svg>
    <svg viewBox="0 0 24 24" data-i="1"><path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="2.5"/><path d="M8 14h8v6H8z"/><path class="acc" d="M16.5 11.5h.01"/></svg>
    <svg viewBox="0 0 24 24" data-i="2"><path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle class="acc" cx="7" cy="17.5" r="1.8"/><circle class="acc" cx="17" cy="17.5" r="1.8"/></svg>`;
  const digit = () => `<span class="pbl-digit"><span>${[...'0123456789'].map(n => `<span>${n}</span>`).join('')}</span></span>`;
  const RING_R = 92, RING_LEN = 2 * Math.PI * RING_R;

  const loader = document.createElement('div');
  loader.id = 'pb-loader';
  loader.dataset.mode = mode;
  loader.innerHTML = `
    <div class="pbl-layer pbl-yellow" aria-hidden="true"></div>
    <div class="pbl-layer pbl-cream" aria-hidden="true"></div>
    <div class="pbl-stage">
      <div class="pbl-emblem" aria-hidden="true">
        <svg class="pbl-ring" viewBox="0 0 200 200">
          <defs><linearGradient id="pbl-arc-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#FFD978"/><stop offset=".55" stop-color="#F4B63F"/><stop offset="1" stop-color="#E29A1E"/>
          </linearGradient></defs>
          <circle class="pbl-track" cx="100" cy="100" r="${RING_R}"/>
          <circle class="pbl-track-hi" cx="100" cy="100" r="${RING_R}"/>
          <circle class="pbl-arc" cx="100" cy="100" r="${RING_R}" stroke-dasharray="${RING_LEN}" stroke-dashoffset="${RING_LEN}"/>
          ${[0, 1, 2, 3, 4].map(i => `<circle class="pbl-dot" cx="${200 - 8}" cy="100" r="${2.1 - i * .3}" opacity="0"/>`).join('')}
          <circle class="pbl-head" cx="${200 - 8}" cy="100" r="4.2" opacity="0"/>
        </svg>
        <div class="pbl-shadow"></div>
        <div class="pbl-fly"><div class="pbl-float"><img class="pbl-bee" src="${asset(CONFIG.bee)}" alt="" width="440" height="406" decoding="async"></div></div>
      </div>
      <div class="pbl-count" aria-hidden="true">${digit()}${digit()}${digit()}<span class="pbl-pct">%</span></div>
      <div class="pbl-mask"><img class="pbl-word" src="${asset(CONFIG.wordmark)}" alt="PrintBee" width="640" height="167" decoding="async"></div>
      <p class="pbl-tagline" aria-hidden="true"><span class="pbl-icon">${ICONS}</span><span class="pbl-words">${
        CONFIG.tagline.map((w, i) => `<span class="pbl-w${i === 1 ? ' is-honey' : ''}">${w}</span>`).join('')}</span></p>
      <span class="pbl-sr" role="status" aria-live="polite">Loading PrintBee</span>
    </div>`;
  const $ = s => loader.querySelector(s);
  const $$ = s => [...loader.querySelectorAll(s)];
  const el = {
    yellow: $('.pbl-yellow'), cream: $('.pbl-cream'), emblem: $('.pbl-emblem'), ring: $('.pbl-ring'),
    arc: $('.pbl-arc'), dots: $$('.pbl-dot'), head: $('.pbl-head'), shadow: $('.pbl-shadow'),
    fly: $('.pbl-fly'), float: $('.pbl-float'), bee: $('.pbl-bee'), count: $('.pbl-count'),
    digits: $$('.pbl-digit'), word: $('.pbl-word'), mask: $('.pbl-mask'), tagline: $('.pbl-tagline'),
    icons: $$('.pbl-icon svg'), words: $$('.pbl-w'), status: $('.pbl-sr'),
  };

  // Critical CSS: the loader is usable before preloader.css arrives; scroll is locked.
  const critical = document.createElement('style');
  critical.textContent = `html.pbl-lock,html.pbl-lock body{overflow:hidden!important}
    #pb-loader{position:fixed;inset:0;z-index:10000}
    #pb-loader .pbl-layer{position:absolute;inset:0}#pb-loader .pbl-yellow{background:#F4B63F}#pb-loader .pbl-cream{background:#F6EFE0}
    #pb-loader .pbl-stage{position:absolute;inset:0;display:grid;place-content:center;justify-items:center}
    #pb-loader .pbl-ring,#pb-loader .pbl-count,#pb-loader .pbl-tagline,#pb-loader .pbl-shadow{opacity:0}
    #pb-loader .pbl-bee{width:clamp(128px,30vmin,300px);height:auto;opacity:0}
    #pb-loader .pbl-word{width:clamp(196px,52vmin,420px);height:auto;opacity:0}
    #pb-loader .pbl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}`;
  document.head.append(critical);
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = asset('preloader.css?v=7');
  document.head.append(css);
  root.classList.add('pbl-lock');
  root.setAttribute('aria-busy', 'true');
  root.append(loader);   // child of <html>: visible before <body> exists, no flash of the page

  /* ---------- Progress (real) ---------- */
  // Weighted groups so the number only ever grows: loader assets, fonts, then hero images.
  const groups = { core: { done: 0, total: 3, weight: .3 }, fonts: { done: 0, total: 1, weight: .2 }, hero: { done: 0, total: 0, weight: .5, known: false } };
  let target = 0, shown = 0, heroReady = false, gsap = null;
  function settle(group, promise) {
    Promise.resolve(promise).catch(() => {}).then(() => { groups[group].done++; recompute(); });
  }
  function recompute() {
    let value = 0;
    for (const g of Object.values(groups)) {
      const frac = g.total ? g.done / g.total : (g.known ? 1 : 0);
      value += g.weight * Math.min(1, frac);
    }
    target = Math.max(target, value * 100);
    if (groups.hero.known && groups.hero.done >= groups.hero.total && groups.fonts.done >= groups.fonts.total && groups.core.done >= groups.core.total) heroReady = true;
  }
  const imageReady = img => (img.complete ? Promise.resolve() : new Promise(r => {
    img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true });
  })).then(() => img.decode?.()).catch(() => {});

  const gsapReady = new Promise(resolve => {
    if (window.gsap) return resolve(window.gsap);
    const s = document.createElement('script');
    s.src = asset(CONFIG.gsap);
    s.onload = () => resolve(window.gsap || null);
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
  settle('core', gsapReady);
  settle('core', imageReady(el.bee));
  settle('core', imageReady(el.word));
  settle('fonts', (document.fonts?.ready || Promise.resolve()));

  // Find the document whose hero we hand off to: this page, or the shell's active tab iframe.
  const domReady = document.readyState === 'loading'
    ? new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true })) : Promise.resolve();
  let heroDoc = document, heroFrame = null;
  const heroDocReady = domReady.then(() => new Promise(resolve => {
    const shell = document.getElementById('tab-screens');
    if (!shell) return resolve(document);
    const pick = () => [...shell.querySelectorAll('.tab-panel')].find(p => !p.hidden)?.querySelector('iframe');
    const wait = () => {
      const frame = pick();
      if (!frame) return requestAnimationFrame(wait);
      heroFrame = frame;
      const done = () => { try { resolve(frame.contentDocument || document); } catch (_) { resolve(document); } };
      const doc = (() => { try { return frame.contentDocument; } catch (_) { return null; } })();
      if (doc && doc.readyState !== 'loading' && doc.URL !== 'about:blank') done();
      else frame.addEventListener('load', done, { once: true });
    };
    wait();
  }));
  heroDocReady.then(doc => {
    heroDoc = doc;
    const images = [...doc.querySelectorAll('img')].filter(img => img.loading !== 'lazy');
    groups.hero.total = images.length;
    groups.hero.known = true;
    images.forEach(img => settle('hero', imageReady(img)));
    if (doc !== document) { groups.fonts.total = 2; settle('fonts', doc.fonts?.ready); }
    recompute();
  });

  /* Render shown progress: ring, trail, counter, status. */
  let lastInt = -1, lastSpoken = -1;
  function render() {
    const p = shown / 100;
    el.arc.setAttribute('stroke-dashoffset', (RING_LEN * (1 - p)).toFixed(2));
    // A zero-length dash still paints its round cap as a dot, so hide the arc until it has length.
    el.arc.setAttribute('opacity', p > .005 ? '1' : '0');
    const angle = p * 360;
    el.head.style.transform = `rotate(${angle}deg)`;
    el.dots.forEach((dot, i) => {
      dot.style.transform = `rotate(${Math.max(0, angle - (i + 1) * 9)}deg)`;
      dot.setAttribute('opacity', p > .02 ? (0.75 - i * .14).toFixed(2) : '0');
    });
    el.head.setAttribute('opacity', p > .005 ? '1' : '0');
    const n = Math.min(100, Math.floor(shown + .0001));
    if (n !== lastInt) {
      lastInt = n;
      const parts = [Math.floor(n / 100), Math.floor(n / 10) % 10, n % 10];
      el.digits.forEach((d, i) => {
        d.firstElementChild.style.transform = `translateY(${-parts[i] * 10}%)`;
        d.classList.toggle('is-hidden', (i === 0 && n < 100) || (i === 1 && n < 10));
      });
      const spoken = n === 100 ? 100 : Math.floor(n / 25) * 25;
      if (spoken !== lastSpoken) { lastSpoken = spoken; el.status.textContent = `Loading PrintBee, ${spoken}%`; }
    }
  }
  // Ease shown toward target; creep inside the current slice so it never looks stalled,
  // but never past what has really loaded plus the in-flight slice, and never backwards.
  // The display is also paced, so a fully cached page still shows the ring drawing in one
  // smooth sweep. Pacing only ever holds the number back; it never runs ahead of real loading.
  function pace() {
    const from = CONFIG.beats.ring * 1000 + 150, span = CONFIG.minimum - from - 450;
    const t = Math.min(1, Math.max(0, (elapsed() - from) / span));
    return 100 * (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  }
  function step(dt) {
    const slice = groups.hero.total ? 50 / groups.hero.total : 10;
    const ceiling = Math.min(pace(), heroReady ? 100 : Math.min(99, target + slice * .8));
    const goal = Math.min(ceiling, heroReady ? 100 : Math.max(target, shown + dt * 6));
    shown = Math.min(100, Math.max(shown, shown + (goal - shown) * (1 - Math.exp(-dt * 9))));
    if (heroReady && goal === 100 && 100 - shown < .4) shown = 100;
    render();
  }

  /* ---------- Page lock / restore ---------- */
  const inertMap = new Map();
  domReady.then(() => {
    if (finished) return;
    [...document.body.children].forEach(node => { inertMap.set(node, node.inert); node.inert = true; });
  });
  let finished = false;
  function finish(reason) {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    gsap?.ticker.remove(tick);
    if (gsap) gsap.killTweensOf(loader.querySelectorAll('*'));
    master?.kill();
    // If the exit was cut short (safety net, background tab), put the hero back as authored.
    try { restoreHero?.(); } catch (_) { /* never block the page */ }
    loader.remove();
    critical.remove();
    root.classList.remove('pbl-lock');
    root.removeAttribute('aria-busy');
    inertMap.forEach((value, node) => { node.inert = value; });
    try { sessionStorage.setItem(CONFIG.sessionKey, '1'); } catch (_) { /* fine */ }
    window.dispatchEvent(new CustomEvent('printbee:ready', { detail: { reason, mode, duration: Math.round(elapsed()) } }));
  }
  // Absolute safety net: whatever happens, the page is usable shortly after the cap.
  let safety = setTimeout(() => finish('safety'), mode === 'repeat' ? CONFIG.repeat + 1400 : CONFIG.maximum + 2600);
  let restoreHero = null;
  window.addEventListener('pageshow', e => { if (e.persisted) finish('history'); });

  /* ---------- Animation ---------- */
  let master = null, exiting = false;
  function tick(_, deltaMs) {
    step(Math.min(.1, deltaMs / 1000));
    const ready = heroReady && shown >= 100;
    if (!exiting && mode !== 'repeat' && ((ready && elapsed() >= CONFIG.minimum) || elapsed() >= CONFIG.maximum)) exit(ready ? 'ready' : 'timeout');
  }

  gsapReady.then(g => {
    gsap = g;
    if (finished) return;
    if (!gsap) return cssFallback();
    gsap.ticker.lagSmoothing(500, 33);
    if (mode === 'repeat') return repeatIntro();
    intro();
    gsap.ticker.add(tick);
  });

  function intro() {
    const { beats, durations: d, float } = CONFIG;
    const still = mode === 'reduced';
    master = gsap.timeline();
    gsap.set([el.ring, el.count, el.tagline, el.shadow], { opacity: 0 });
    gsap.set(el.word, { yPercent: 110, opacity: 1 });
    gsap.set(el.words, { yPercent: 70, opacity: 0 });
    gsap.set(el.icons, { opacity: 0, scale: .6, transformOrigin: '50% 50%' });

    master.addLabel('enter', beats.enter)
      .fromTo(el.bee, { opacity: 0, scale: still ? 1 : .8 }, { opacity: 1, scale: 1, duration: d.enter, ease: still ? 'none' : 'back.out(1.7)' }, 'enter')
      .to(el.shadow, { opacity: 1, duration: .6, ease: 'sine.out' }, 'enter+=.2')
      .addLabel('ring', beats.ring)
      .fromTo(el.ring, { opacity: 0, scale: still ? 1 : .94 }, { opacity: 1, scale: 1, duration: .6, ease: EASE }, 'ring')
      .fromTo(el.count, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .5, ease: EASE }, 'ring+=.15')
      .addLabel('wordmark', beats.wordmark)
      .to(el.word, { yPercent: 0, duration: d.wordmark, ease: EASE }, 'wordmark')
      .addLabel('tagline', beats.tagline)
      .set(el.tagline, { opacity: 1 }, 'tagline');
    // Words rise one by one; the icon morphs doc → printer → truck in step with them.
    el.words.forEach((word, i) => {
      const at = `tagline+=${i * .22}`;
      master.to(word, { yPercent: 0, opacity: 1, duration: d.word, ease: EASE }, at)
        .to(el.icons[i], { opacity: 1, scale: 1, rotation: 0, duration: .45, ease: 'back.out(2)' }, at);
      if (i) master.to(el.icons[i - 1], { opacity: 0, scale: .6, rotation: -12, duration: .3, ease: 'power2.in' }, at);
    });

    if (still) return;
    // Gentle float with a breathing contact shadow (one loop, not timers).
    gsap.to(el.float, { y: -float.y, rotation: -float.tilt, duration: float.period / 2, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: .5 });
    gsap.to(el.shadow, { scaleX: .82, opacity: .55, duration: float.period / 2, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: .5 });
    // Wing buzz stand-in: a tiny, fast rotate pulse on the whole bee (the logo is one flat image).
    gsap.to(el.bee, { rotation: .7, scale: 1.006, duration: .09, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: d.enter });
  }

  function repeatIntro() {
    // Logo is already composed and visible; a short fade hands off to the page.
    gsap.set([el.bee, el.word], { opacity: 1 });
    const fade = Math.min(.35, CONFIG.repeat / 1000);
    gsap.to(loader, { opacity: 0, duration: fade, ease: 'power1.inOut', delay: Math.max(0, CONFIG.repeat / 1000 - fade - elapsed() / 1000), onComplete: () => finish('repeat') });
  }

  function cssFallback() {
    loader.classList.add('pbl-css');
    [el.bee, el.word, el.ring, el.count].forEach(n => { n.style.opacity = '1'; });
    el.word.style.transform = 'none';
    let last = performance.now();
    const loop = now => {
      if (finished) return;
      step(Math.min(.1, (now - last) / 1000)); last = now;
      const done = (heroReady && shown >= 100 && elapsed() >= CONFIG.minimum) || elapsed() >= CONFIG.maximum || mode === 'repeat';
      if (done) { loader.classList.add('is-out'); loader.addEventListener('transitionend', () => finish('css'), { once: true }); setTimeout(() => finish('css'), 600); return; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /* ---------- Exit: ring closes, bee flies to the printer, curtain lifts, hero arrives ---------- */
  function exit(reason) {
    exiting = true;
    // The exit takes ~1.8 s; if frames stall (hidden tab), still release the page shortly after.
    clearTimeout(safety);
    safety = setTimeout(() => finish('safety'), 2600);
    if (mode === 'reduced') {
      return gsap.to(loader, { opacity: 0, duration: CONFIG.reducedExit / 1000, ease: 'power1.inOut', onComplete: () => finish(reason) });
    }
    const d = CONFIG.durations;
    master.kill();
    gsap.killTweensOf([el.float, el.shadow, el.bee]);
    const hero = prepareHero();
    restoreHero = hero.restore;
    const flight = flightPath();
    const tl = gsap.timeline({ onComplete: () => finish(reason) });

    tl.addLabel('close')
      .to(el.float, { y: 0, rotation: 0, duration: .3, ease: 'power2.out' }, 'close')
      .to(el.bee, { rotation: 0, scale: 1, duration: .2 }, 'close')
      .to(el.ring, { scale: 1.08, opacity: 0, duration: d.ringClose, ease: 'power2.in' }, 'close+=.05')
      .to([el.count, el.shadow], { opacity: 0, duration: .25 }, 'close')
      .to([el.mask, el.tagline], { y: -14, opacity: 0, duration: .35, ease: 'power2.in', stagger: .05 }, 'close+=.05')
      .addLabel('flight', 'close+=.2')
      .to(flight.state, { p: 1, duration: d.flight, ease: 'power2.inOut', onUpdate: flight.update }, 'flight')
      .to(el.fly, { opacity: 0, duration: .28, ease: 'power1.in' }, `flight+=${d.flight - .28}`)
      .addLabel('curtain', 'close+=.3')
      .fromTo([el.cream, el.yellow], { clipPath: CLIP_OPEN }, { clipPath: CLIP_LIFTED, duration: d.curtain, ease: 'power3.inOut', stagger: .14 }, 'curtain')
      .add(hero.reveal(), 'curtain+=.55');
  }

  // Arc flight from the bee's resting spot toward the hero printer (or the header logo).
  function flightPath() {
    const from = el.fly.getBoundingClientRect();
    let to = null;
    try {
      const target = heroDoc.querySelector('.hero-illustration') || heroDoc.querySelector('.brand-logo');
      if (target) {
        const r = target.getBoundingClientRect();
        const offset = heroFrame ? heroFrame.getBoundingClientRect() : { left: 0, top: 0 };
        if (r.width && r.bottom > 0 && r.top < (heroDoc.defaultView?.innerHeight || innerHeight)) {
          to = { x: offset.left + r.left + r.width * .5, y: offset.top + r.top + r.height * .38, size: Math.min(r.width, r.height) * .42 };
        }
      }
    } catch (_) { /* cross-document access can fail; fall back below */ }
    if (!to) to = { x: from.left + from.width / 2, y: -from.height, size: from.width * .4 };
    const dx = to.x - (from.left + from.width / 2), dy = to.y - (from.top + from.height / 2);
    const endScale = Math.max(.22, Math.min(.6, to.size / from.width));
    const lift = Math.min(180, Math.abs(dx) * .35 + 70);   // height of the arc above the straight line
    const state = { p: 0 };
    const update = () => {
      const p = state.p;
      gsap.set(el.fly, { x: dx * p, y: dy * p - Math.sin(Math.PI * p) * lift, scale: 1 + (endScale - 1) * p, rotation: Math.sin(Math.PI * p) * (dx >= 0 ? 10 : -10) });
    };
    return { state, update };
  }

  // Hero hand-off: navbar drops, headline lines slide up through masks, card settles in.
  function prepareHero() {
    const g = gsap, doc = heroDoc;
    const heroCard = doc.querySelector('.hero');
    const title = doc.querySelector('.hero h1') || doc.querySelector('main h1');
    const intro = heroCard ? [...heroCard.querySelectorAll('.intro > :not(h1)')] : [];
    const top = doc.querySelector('header.top');
    const dock = document.getElementById('bottom-nav');
    const original = title ? title.innerHTML : '';
    let lines = [];
    if (title && title.innerHTML.includes('<br')) {
      // Wrap each <br>-separated line in a mask. Block lines keep the exact same layout.
      title.innerHTML = title.innerHTML.split(/<br\s*\/?>/i)
        .map(html => `<span style="display:block;overflow:hidden;padding-bottom:.12em;margin-bottom:-.12em"><span style="display:block">${html.trim()}</span></span>`).join('');
      lines = [...title.querySelectorAll(':scope > span > span')];
    } else if (title) lines = [title];
    const all = [heroCard, top, dock, ...lines, ...intro].filter(Boolean);
    if (heroCard) g.set(heroCard, { opacity: 0, scale: .96, transformOrigin: '50% 40%' });
    if (top) g.set(top, { opacity: 0, y: -18 });
    if (dock) g.set(dock, { opacity: 0, y: 22 });
    g.set(lines, { yPercent: 105 });
    g.set(intro, { opacity: 0, y: 14 });
    return {
      reveal() {
        const d = CONFIG.durations.hero, tl = g.timeline();
        if (heroCard) tl.to(heroCard, { opacity: 1, scale: 1, duration: d, ease: EASE }, 0);
        if (top) tl.to(top, { opacity: 1, y: 0, duration: .7, ease: EASE }, .05);
        if (dock) tl.to(dock, { opacity: 1, y: 0, duration: .7, ease: EASE }, .1);
        tl.to(lines, { yPercent: 0, duration: d, ease: EASE, stagger: .09 }, .12)
          .to(intro, { opacity: 1, y: 0, duration: .7, ease: EASE, stagger: .07 }, .3);
        return tl;
      },
      restore() {
        // Leave the hero exactly as authored once it has arrived (safe to call twice).
        g.killTweensOf(all);
        g.set(all, { clearProps: 'opacity,transform,transformOrigin' });
        if (title && lines.length && lines[0] !== title && title.innerHTML !== original) title.innerHTML = original;
      },
    };
  }

  window.PrintBeePreloader = { config: CONFIG, get state() { return { mode, progress: Math.round(shown), target: Math.round(target), heroReady, finished }; } };
})();
