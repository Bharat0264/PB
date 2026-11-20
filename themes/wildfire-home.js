/* Wildfire homepage: the cinematic hero and its supporting sections.
   Only runs while Wildfire is the active theme and the page is the home page (it has <main id="main"> with a .hero).
   It adds a Wildfire-only layer in front of the normal content and hides the PrintBee hero and "How it works" block with CSS
   (see wildfire.css, html.wf-home-on). The real price table, links and every route are the site's own; nothing here talks to
   an API. destroy() removes everything it added and frees the 3D scene. */
const IMG = '/themes/img/';
const view = (src, w, h, alt = '') => `<img src="${IMG}${src}.webp?v=1" width="${w}" height="${h}" alt="${alt}" loading="lazy" decoding="async">`;

const HERO = `
<section class="wf-hero" aria-labelledby="wf-hero-title">
  <div class="wf-stage" data-wf-stage><div class="wf-vignette" aria-hidden="true"></div></div>
  <h1 id="wf-hero-title" class="wf-sr">PrintBee. Your local print studio.</h1>
  <div class="wf-hero-copy">
    <p class="wf-tagline">Rule your own world.</p>
    <p class="wf-sub">Your notes, assignments and ideas. Keep your print documents together in one place.</p>
    <div class="wf-actions">
      <a class="pill yellow" href="queue.html">Upload your design <span aria-hidden="true">↘</span></a>
      <a class="wf-link" href="/pricing.html">View prices <span aria-hidden="true">↓</span></a>
    </div>
  </div>
  <a class="wf-scroll" href="#wf-intro" aria-label="Scroll to the introduction"><span aria-hidden="true"></span></a>
</section>`;

const SECTIONS = `
<section class="wf-section wf-intro" id="wf-intro" aria-labelledby="wf-intro-title">
  <figure class="wf-figure wf-reveal">${view('wf-press', 760, 754, 'An antique printing press with brass wheels')}</figure>
  <div class="wf-copy wf-reveal">
    <p class="wf-eyebrow">PrintBee · SRM University</p>
    <h2 id="wf-intro-title">Your notes, printed like they matter.</h2>
    <p>Upload your documents, choose Normal A4 or Bond paper, add a binding if you want one, and follow your order until it reaches you.</p>
    <div class="wf-actions"><a class="pill yellow" href="queue.html">Upload your design <span aria-hidden="true">↘</span></a><a class="wf-link" href="/pricing.html">View prices <span aria-hidden="true">↓</span></a></div>
  </div>
</section>

<section class="wf-section wf-journey" id="wf-how" aria-labelledby="wf-how-title">
  <h2 id="wf-how-title" class="wf-reveal">How it <span>works</span></h2>
  <ol class="wf-steps" role="list">
    <li class="wf-step wf-reveal"><span class="wf-num" aria-hidden="true">01</span><h3>Upload and review</h3><p>Add PDF, Word or image files, up to 50 MB each, and check every file before you save it.</p></li>
    <li class="wf-step wf-reveal"><span class="wf-num" aria-hidden="true">02</span><h3>Choose print settings</h3><p>Pick the paper, colour, sides and binding for each file. The price is worked out for you.</p></li>
    <li class="wf-step wf-reveal"><span class="wf-num" aria-hidden="true">03</span><h3>Track your delivery</h3><p>Follow every step from the Orders page, from printing to the door.</p></li>
  </ol>
</section>

<section class="wf-section wf-explore" aria-labelledby="wf-explore-title">
  <div class="wf-copy wf-reveal">
    <p class="wf-eyebrow">Explore</p>
    <h2 id="wf-explore-title">Paper that suits the job.</h2>
    <p>Normal A4 sheets for everyday notes. Bond paper sheets, recommended for major project reports. Glossy or blue binding to finish. Live prices are below.</p>
    <div class="wf-actions"><a class="pill yellow" href="/pricing.html">See every price <span aria-hidden="true">↗</span></a></div>
  </div>
  <figure class="wf-figure wf-reveal">${view('wf-signpost', 760, 760, 'A wooden forest signpost reading Forest Route')}</figure>
</section>`;

const AFTER_PRICES = `
<section class="wf-section wf-track" aria-labelledby="wf-track-title">
  <figure class="wf-figure wf-truck wf-reveal">${view('wf-truck', 636, 417, 'A cargo truck loaded with timber')}</figure>
  <div class="wf-copy wf-reveal">
    <p class="wf-eyebrow">Order tracking</p>
    <h2 id="wf-track-title">Follow your order to the door.</h2>
    <p>Pay securely online, then we print and deliver. Every step, from the print room to your address, is on your Orders page.</p>
    <div class="wf-actions"><a class="pill yellow" href="orders.html">Track my orders <span aria-hidden="true">↗</span></a></div>
  </div>
</section>

<section class="wf-section wf-benefits" aria-labelledby="wf-benefits-title">
  <h2 id="wf-benefits-title" class="wf-reveal">Why <span>PrintBee</span></h2>
  <ul class="wf-tiles" role="list">
    <li class="wf-tile wf-reveal">${view('wf-logs', 760, 638)}<h3>Bond paper for big work</h3><p>Choose a Bond paper sheet for major project reports.</p></li>
    <li class="wf-tile wf-reveal">${view('wf-crate', 640, 418)}<h3>Packed and paid online</h3><p>Pay securely online, then we print and deliver.</p></li>
    <li class="wf-tile wf-reveal">${view('wf-marker', 640, 638)}<h3>Delivered on campus</h3><p>On-campus and outside-campus delivery, with your saved addresses.</p></li>
  </ul>
</section>

<section class="wf-section wf-final" aria-labelledby="wf-final-title">
  <h2 id="wf-final-title" class="wf-reveal">Rule your own world.</h2>
  <div class="wf-actions wf-reveal"><a class="pill yellow" href="queue.html">Upload your design <span aria-hidden="true">↘</span></a></div>
</section>`;

export async function mount() {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
  const main = document.querySelector('main#main');
  if (!main || !main.querySelector(':scope > .hero') || main.dataset.wfHome) return {destroy() {}};
  main.dataset.wfHome = 'true';
  const root = document.documentElement;
  root.classList.add('wf-home-on');

  const added = [];
  const place = (html, where, anchor) => {
    const holder = document.createElement('div');
    holder.className = 'wf-layer';
    holder.innerHTML = html;
    anchor.insertAdjacentElement(where, holder);
    added.push(holder);
    return holder;
  };
  const hero = place(HERO, 'afterbegin', main);
  const first = main.querySelector(':scope > .hero');
  place(SECTIONS, 'afterend', first);
  const prices = main.querySelector('#pricing');
  place(AFTER_PRICES, prices ? 'afterend' : 'beforeend', prices || main);

  // reveal-on-scroll (off for reduced motion: everything is simply visible)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let observer;
  if (reduced || !('IntersectionObserver' in window)) {
    main.querySelectorAll('.wf-reveal').forEach(node => node.classList.add('wf-in'));
  } else {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('wf-in'); observer.unobserve(entry.target); }
    }, {rootMargin: '0px 0px -8% 0px', threshold: .12});
    main.querySelectorAll('.wf-reveal').forEach(node => observer.observe(node));
  }

  // the 3D scene loads after the page has settled, never at page load
  let scene, destroyed = false;
  const stage = hero.querySelector('[data-wf-stage]');
  const start = async () => {
    if (destroyed) return;
    try {
      const {mountHero} = await import('/themes/wildfire-hero.js?v=3');
      if (!destroyed) { scene = mountHero(stage); stage.__wf = scene; }   // handle for reviews: stage.__wf.seek(seconds)
    } catch (error) {
      console.warn('[Wildfire] the 3D title could not start; showing the still picture.', error);
      stage.classList.add('wf-static');
    }
  };
  // idle callbacks can starve on a busy or backgrounded page, so give them a deadline
  const idle = fn => (window.requestIdleCallback ? window.requestIdleCallback(fn, {timeout: 1200}) : setTimeout(fn, 250));
  if (document.readyState === 'complete') idle(start); else addEventListener('load', () => idle(start), {once: true});

  return {
    destroy() {
      destroyed = true;
      observer?.disconnect();
      scene?.destroy();
      for (const node of added) node.remove();
      root.classList.remove('wf-home-on');
      delete main.dataset.wfHome;
    },
  };
}
