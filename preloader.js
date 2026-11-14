(() => {
  'use strict';

  // Timing is in milliseconds. The hard limit includes dependency loading and exit.
  const CONFIG = {
    minimum: 1800,
    duration: 3100,
    maximum: 6000,
    repeat: 600,
    exit: 720,
    colours: { yellow: '#F5B82E', charcoal: '#3A3835', cream: '#F4EFE4', white: '#FFFFFF' },
    sessionKey: 'printbee:preloader:seen:v2',
    modelDeadline: 3400,
    models: {
      main: 'public/models/bee_main.glb',
      paper: 'public/models/paper_sheet.glb',
      mini: 'public/models/bee_mini.glb',
    },
  };
  if (window.PrintBeePreloader || window.parent !== window) return;
  // Let internal page switches paint immediately. Direct visits and reloads keep the loader.
  if (document.referrer && performance.getEntriesByType('navigation')[0]?.type === 'navigate') {
    const previous = new URL(document.referrer);
    if (previous.origin === location.origin && previous.pathname !== location.pathname) return;
  }

  const root = document.documentElement;
  const base = new URL('.', document.currentScript.src);
  const started = performance.now();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const timers = new Set();
  const animations = new Set();
  const inertElements = new Map();
  const extraAssets = [];
  const disposers = [];
  let loader, gsap, intro, animationStarted = 0, finished = false, exiting = false, sealed = false;
  let mode = 'full', loaded = 0, total = 0, failed = 0, progress = 0;
  let previousFocus = null;
  let observer;
  const sceneLifetime = new AbortController();
  const oldBusy = root.getAttribute('aria-busy');
  try { if (sessionStorage.getItem(CONFIG.sessionKey)) mode = 'repeat'; } catch (_) { /* Private mode can block storage. */ }
  if (motion.matches && mode !== 'repeat') mode = 'reduced';

  const api = window.PrintBeePreloader = {
    config: CONFIG,
    // Register model/environment loader promises before DOMContentLoaded.
    track(promise, label = 'Scene asset') {
      if (sealed || finished) return false;
      extraAssets.push({ label, promise: Promise.resolve(promise).then(() => true, () => false) });
      return true;
    },
    get state() { return { mode, progress, loaded, total, failed, finished, reason: api.reason || null }; },
  };

  function later(fn, delay) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.max(0, delay));
    timers.add(timer);
    return timer;
  }

  // This tiny inline style works even when the full stylesheet or GSAP fails.
  const critical = document.createElement('style');
  critical.textContent = `html.pb-loading{overflow:hidden!important;background:#fff;scrollbar-gutter:stable}
    .pb-loading body{overflow:hidden!important;visibility:hidden}
    #pb-loader{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:#fff;visibility:visible;color:#3a3835}
    #pb-loader .pb-content{text-align:center}#pb-loader .pb-art:empty{display:none}
    #pb-loader .pb-wordmark{font-weight:800}#pb-loader .pb-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
    #pb-loader .pb-wipe{position:absolute;inset:0;transform:translateY(100%);pointer-events:none}`;
  document.head.append(critical);
  root.classList.add('pb-loading');
  root.setAttribute('aria-busy', 'true');
  later(() => finish(mode === 'repeat' ? 'repeat' : 'timeout'), mode === 'repeat' ? CONFIG.repeat : CONFIG.maximum);
  const onPageShow = event => { if (event.persisted) finish('history'); };
  window.addEventListener('pageshow', onPageShow);
  disposers.push(() => window.removeEventListener('pageshow', onPageShow));

  function resource(file, type) {
    return new Promise(resolve => {
      const element = document.createElement(type === 'style' ? 'link' : 'script');
      if (type === 'style') { element.rel = 'stylesheet'; element.href = new URL(file, base); }
      else { element.src = new URL(file, base); element.async = true; }
      element.onload = () => resolve(true);
      element.onerror = () => resolve(false);
      document.head.append(element);
    });
  }
  const styles = resource('preloader.css?v=2', 'style');
  const art = resource('preloader-art.js?v=1', 'script');
  const engine = resource('gsap-3.13.0.min.js', 'script');
  const domReady = document.readyState === 'loading'
    ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();

  function mount() {
    if (finished || loader) return;
    previousFocus = document.activeElement;
    loader = document.createElement('div');
    loader.id = 'pb-loader';
    loader.className = 'pb-loader';
    loader.dataset.mode = mode;
    if (mode === 'full') loader.dataset.preparing = '';
    loader.setAttribute('aria-label', 'PrintBee is loading');
    for (const [name, colour] of Object.entries(CONFIG.colours)) loader.style.setProperty(`--pb-${name}`, colour);
    const letters = [...'PrintBee'].map((letter, i) => `<span class="pb-letter">${letter}${i === 7 ? '<span class="pb-tiny-bee"></span>' : ''}</span>`).join('');
    loader.innerHTML = `<div class="pb-content">
      <div class="pb-art" aria-hidden="true"></div>
      <div class="pb-wordmark" aria-label="PrintBee"><span class="pb-sr-only">PrintBee</span><span style="display:contents" aria-hidden="true">${letters}</span></div>
      <div class="pb-tagline" aria-hidden="true"><span class="pb-stage">Upload.</span><span class="pb-stage">Print.</span><span class="pb-stage">Delivered.</span></div>
      <div class="pb-progress"><div class="pb-progress-track" role="progressbar" aria-label="Loading PrintBee assets" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="pb-progress-fill"></div></div>
      <div class="pb-progress-caption" aria-hidden="true"><span>Getting things ready</span><span class="pb-percent">0%</span></div></div>
      <span class="pb-sr-only" role="status" aria-live="polite">Loading PrintBee.</span>
    </div><div class="pb-wipe pb-wipe-yellow"></div><div class="pb-wipe pb-wipe-white"></div>`;
    document.body.prepend(loader);
    const lock = node => {
      if (node.nodeType === 1 && node !== loader && !['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName)) {
        if (!inertElements.has(node)) inertElements.set(node, node.inert);
        node.inert = true;
      }
    };
    [...document.body.children].forEach(lock);
    observer = new MutationObserver(records => records.forEach(record => [...record.addedNodes].forEach(lock)));
    observer.observe(document.body, { childList: true });
    const preventScroll = event => event.preventDefault();
    document.addEventListener('touchmove', preventScroll, { passive: false });
    document.addEventListener('wheel', preventScroll, { passive: false });
    disposers.push(() => document.removeEventListener('touchmove', preventScroll), () => document.removeEventListener('wheel', preventScroll));
    updateProgress();
  }

  function animate(animation) { animations.add(animation); return animation; }
  function updateProgress() {
    if (finished || !loader) return;
    progress = total ? Math.round(loaded / total * 100) : 0;
    const bar = loader.querySelector('.pb-progress-track');
    bar.setAttribute('aria-valuenow', progress);
    bar.setAttribute('aria-valuetext', `${loaded} of ${total} assets checked${failed ? `; ${failed} unavailable` : ''}`);
    loader.querySelector('.pb-percent').textContent = `${progress}%`;
    const fill = loader.querySelector('.pb-progress-fill');
    if (gsap && mode === 'full') gsap.to(fill, { scaleX: progress / 100, duration: .2, overwrite: true, ease: 'power1.out' });
    else fill.style.transform = `scaleX(${progress / 100})`;
    const stage = progress < 33 ? 0 : progress < 66 ? 1 : 2;
    loader.querySelectorAll('.pb-stage').forEach((word, i) => word.classList.toggle('is-active', i === stage));
  }

  function loadImage(image) {
    return new Promise(resolve => {
      const done = async () => {
        image.removeEventListener('load', done);
        image.removeEventListener('error', done);
        try { await image.decode(); resolve(image.naturalWidth > 0); } catch (_) { resolve(false); }
      };
      if (image.complete) done();
      else {
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
        disposers.push(() => { image.removeEventListener('load', done); image.removeEventListener('error', done); });
      }
    });
  }

  async function collectAssets(modelTasks = []) {
    const unique = new Map();
    document.querySelectorAll('img:not([loading="lazy"])').forEach(image => unique.set(image.currentSrc || image.src, image));
    const fonts = styles.then(async ok => {
      if (!ok || !document.fonts) return ok;
      try {
        const results = await Promise.allSettled([
          document.fonts.load('700 64px "PrintBee Fredoka"', 'PrintBee'),
          document.fonts.load('400 16px Manrope'),
          document.fonts.load('700 16px Manrope'),
          document.fonts.load('800 16px Manrope'),
        ]);
        await document.fonts.ready;
        return results.every(result => result.status === 'fulfilled');
      } catch (_) { return false; }
    });
    // Asset completion (including handled failures), never a simulated time counter.
    const tasks = [styles, art, engine, fonts, ...modelTasks, ...[...unique.values()].map(loadImage), ...extraAssets.map(item => item.promise)];
    sealed = true;
    total = tasks.length;
    await Promise.all(tasks.map(task => Promise.resolve(task).then(ok => {
      if (!finished) { loaded++; if (!ok) failed++; updateProgress(); }
    }, () => { if (!finished) { loaded++; failed++; updateProgress(); } })));
  }

  function showFallback() {
    loader.removeAttribute('data-preparing');
    loader.classList.add('pb-logo-fallback');
    const image = document.createElement('img');
    image.src = new URL('printbee-loading-logo.webp', base);
    image.alt = 'PrintBee';
    loader.querySelector('.pb-art').replaceChildren(image);
  }

  function startAnimation() {
    if (finished || !loader) return;
    gsap = window.gsap;
    if (!gsap || !window.PrintBeePreloaderArt) {
      loader.removeAttribute('data-preparing');
      return;
    }
    animationStarted = performance.now() - started;
    const select = selector => loader.querySelectorAll(selector);
    if (mode !== 'full') {
      animate(gsap.fromTo(select('.pb-content'), { opacity: 0 }, { opacity: 1, duration: mode === 'repeat' ? .16 : .35 }));
      return;
    }
    const yellowPath = loader.querySelector('.pb-orbit-yellow path');
    const darkPath = loader.querySelector('.pb-orbit-dark path');
    [yellowPath, darkPath].forEach(path => {
      const length = path.getTotalLength();
      gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
    });
    gsap.set(select('.pb-letter, .pb-stage, .pb-progress, .pb-tiny-bee, .pb-bee-flight'), { opacity: 0 });
    gsap.set(select('.pb-chip'), { opacity: .15, scale: .8, transformOrigin: 'center' });
    loader.removeAttribute('data-preparing');
    intro = animate(gsap.timeline());
    // Dash offset is the only paint animation; all moving parts use transforms/opacity.
    intro.to(yellowPath, { strokeDashoffset: 0, duration: .85, ease: 'power2.inOut' }, .05)
      .to(darkPath, { strokeDashoffset: 0, duration: .65, ease: 'power2.inOut' }, .2);
    const flight = loader.querySelector('.pb-bee-flight');
    const pathLength = yellowPath.getTotalLength();
    const end = yellowPath.getPointAtLength(pathLength);
    const points = Array.from({ length: 81 }, (_, i) => yellowPath.getPointAtLength(pathLength * i / 80));
    const position = { value: 0 };
    // Sample the orbit once, rather than querying SVG geometry every frame.
    intro.to(position, { value: 80, duration: 1.05, ease: 'power2.out', onUpdate() {
      const i = Math.min(79, Math.floor(position.value)), mix = position.value - i;
      gsap.set(flight, { x: points[i].x * (1 - mix) + points[i + 1].x * mix - end.x,
        y: points[i].y * (1 - mix) + points[i + 1].y * mix - end.y });
    } }, .28).to(flight, { opacity: 1, duration: .2 }, .28)
      .fromTo(select('.pb-bee-pose'), { rotation: -25, scale: .7, svgOrigin: '180 155' },
        { rotation: 0, scale: 1, duration: .8, ease: 'power2.out' }, .28);
    select('.pb-wing').forEach((wing, i) => {
      animate(gsap.to(wing, { rotation: i % 2 ? -18 : 15, scaleY: .72, svgOrigin: wing.dataset.origin,
        duration: .075 + i * .01, repeat: -1, yoyo: true, ease: 'sine.inOut', delay: .3 }));
    });
    animate(gsap.to(select('.pb-bee-bob'), { y: -4, rotation: 1.2, svgOrigin: '180 155', duration: .65, repeat: -1, yoyo: true, ease: 'sine.inOut', delay: 1.2 }));
    animate(gsap.fromTo(select('.pb-speed'), { x: 3, opacity: .9 }, { x: -9, opacity: .25, duration: .32, stagger: .08, repeat: -1, ease: 'power1.out', delay: .45 }));
    intro.to(select('.pb-chip'), { opacity: 1, scale: 1, duration: .19, stagger: .14, ease: 'back.out(2)' }, .95)
      .fromTo(select('.pb-letter'), { y: 20, scaleY: .65, scaleX: 1.12, opacity: 0 },
        { y: 0, scaleY: 1, scaleX: 1, opacity: 1, duration: .48, stagger: .065, ease: 'back.out(2.2)' }, 1.12)
      .fromTo(select('.pb-tiny-bee'), { x: 26, y: -30, rotation: -30, opacity: 0 },
        { x: 0, y: 0, rotation: 13, opacity: 1, duration: .45, ease: 'back.out(1.6)' }, 1.82)
      .fromTo(select('.pb-stage'), { y: 7, opacity: 0 }, { y: 0, opacity: 1, duration: .25, stagger: .13 }, 1.65)
      .fromTo(select('.pb-progress'), { opacity: 0 }, { opacity: 1, duration: .3 }, 1.7);
    select('.pb-tiny-wing').forEach(wing => animate(gsap.to(wing, { rotation: 16, scaleY: .7, svgOrigin: wing.dataset.origin,
      duration: .1, yoyo: true, repeat: 5, delay: 2.15, ease: 'sine.inOut' })));
  }

  function restorePage() {
    root.classList.remove('pb-loading');
    if (oldBusy === null) root.removeAttribute('aria-busy'); else root.setAttribute('aria-busy', oldBusy);
    observer?.disconnect();
    inertElements.forEach((value, element) => { element.inert = value; });
    inertElements.clear();
    disposers.splice(0).forEach(dispose => dispose());
  }

  function finish(reason) {
    if (finished) return;
    finished = true;
    sceneLifetime.abort();
    api.reason = reason;
    timers.forEach(clearTimeout);
    timers.clear();
    animations.forEach(animation => animation.kill());
    if (gsap && loader) gsap.killTweensOf(loader.querySelectorAll('*'));
    animations.clear();
    restorePage();
    loader?.remove();
    critical.remove();
    try { sessionStorage.setItem(CONFIG.sessionKey, '1'); } catch (_) { /* Loading still completes without storage. */ }
    if (previousFocus && previousFocus !== document.body && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent('printbee:ready', { detail: { reason, failed, duration: performance.now() - started } }));
  }

  function exit(reason = 'ready') {
    if (finished || exiting) return;
    exiting = true;
    if (!gsap || mode !== 'full' || !loader.classList.contains('pb-webgl')) {
      if (loader && gsap) animate(gsap.to(loader, { opacity: 0, duration: .18, onComplete: () => finish(reason) }));
      else finish(reason);
      return;
    }
    intro?.kill();
    const content = loader.querySelector('.pb-content');
    const yellow = loader.querySelector('.pb-wipe-yellow');
    const white = loader.querySelector('.pb-wipe-white');
    gsap.set([yellow, white], { yPercent: 100, y: 0 });
    // The screen wipe protects the reveal while the homepage becomes visible.
    const timeline = animate(gsap.timeline({ onComplete: () => finish(reason) }));
    timeline.to(loader.querySelector('.pb-paper'), { y: 34, opacity: 0, duration: .22, ease: 'power2.in' }, 0)
      .to(content, { y: -12, opacity: 0, duration: .22 }, .09)
      .to(yellow, { yPercent: 0, duration: .26, ease: 'power2.inOut' }, .1)
      .to(white, { yPercent: 0, duration: .24, ease: 'power2.inOut' }, .2)
      .call(() => {
        restorePage();
        loader.style.background = 'transparent';
        const hero = document.querySelector('.hero .intro') || document.querySelector('main');
        if (hero) {
          const tween = gsap.fromTo(hero, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .32, clearProps: 'opacity,transform' });
          // Not killed with the overlay: this finishes the page reveal.
          tween.eventCallback('onInterrupt', () => gsap.set(hero, { clearProps: 'opacity,transform' }));
        }
      }, null, .44)
      .to(yellow, { yPercent: -100, duration: .28, ease: 'power2.inOut' }, .36)
      .to(white, { yPercent: -100, duration: .28, ease: 'power2.inOut' }, .44);
  }

  const onMotion = event => { if (event.matches && !finished) finish('reduced-motion-change'); };
  motion.addEventListener('change', onMotion);
  disposers.push(() => motion.removeEventListener('change', onMotion));
  domReady.then(async () => {
    if (finished) return;
    mount();
    if (mode !== 'full') {
      showFallback();
      const assetsReady = mode === 'reduced' ? collectAssets() : null;
      await Promise.all([styles, engine]);
      if (finished) return;
      gsap = window.gsap;
      if (gsap) animate(gsap.fromTo(loader.querySelector('.pb-content'), { opacity: 0 }, { opacity: 1, duration: .16 }));
      if (mode === 'repeat') {
        later(exit, CONFIG.repeat - 180 - (performance.now() - started));
      } else {
        await assetsReady;
        if (!finished) later(exit, CONFIG.minimum - (performance.now() - started));
      }
      return;
    }

    showFallback();
    loader.classList.add('pb-pending-model');
    const settled = new Map();
    const modelTasks = Object.keys(CONFIG.models).map(name => new Promise(resolve => settled.set(name, resolve)));
    const settleModel = (name, ok) => {
      settled.get(name)?.(ok);
      settled.delete(name);
    };
    const fallbackToLogo = () => {
      sceneLifetime.abort();
      loader.classList.remove('pb-pending-model', 'pb-webgl');
      showFallback();
      gsap = window.gsap;
    };
    const sceneReady = Promise.all([art, styles, engine, import(new URL('preloader-3d.bundle.js', base))])
      .then(async ([hasArt, hasStyles, hasEngine, scene]) => {
        if (finished || sceneLifetime.signal.aborted || !hasArt || !hasStyles || !hasEngine) return false;
        // Keep the static logo visible until the 3D renderer can take over.
        const fallback = loader.querySelector('.pb-art img');
        fallback.className = 'pb-pending-logo';
        loader.querySelector('.pb-art').innerHTML = window.PrintBeePreloaderArt;
        loader.querySelector('.pb-art').append(fallback);
        await scene.createBeeScene({ overlay: loader, paths: CONFIG.models, base, signal: sceneLifetime.signal,
          onModelSettled: settleModel, onContextLost: fallbackToLogo,
        });
        if (finished || sceneLifetime.signal.aborted) return false;
        loader.classList.remove('pb-logo-fallback', 'pb-pending-model');
        fallback.remove();
        startAnimation();
        return true;
      }).catch(() => false);
    const sceneBudget = new Promise(resolve => later(() => resolve(false), CONFIG.modelDeadline - (performance.now() - started)));
    const sceneResult = Promise.race([sceneReady, sceneBudget]);
    const assetsReady = collectAssets([...modelTasks, sceneResult]);
    const rendered = await sceneResult;
    if (finished || exiting) return;
    if (!rendered) {
      fallbackToLogo();
      for (const name of settled.keys()) settleModel(name, false);
    }
    await assetsReady;
    if (finished) return;
    const target = mode === 'reduced' ? CONFIG.minimum : Math.max(CONFIG.minimum, CONFIG.duration - CONFIG.exit, animationStarted ? animationStarted + 2270 : 0);
    later(exit, target - (performance.now() - started));
    // Start the exit soon enough that slow assets never extend the six-second cap.
  }).catch(() => finish('fallback'));
  if (mode !== 'repeat') later(() => exit('timeout'), CONFIG.maximum - CONFIG.exit);
})();
