/* Wildfire home page: the SAME page, dressed differently.
   Nothing is moved, added or removed from the PrintBee layout. The hero keeps its card, its text on the left and its picture
   on the right; "How it works" keeps its three steps; the prices and footer stay where they are. What changes:
     1. the printer picture in the hero is replaced, in exactly the same box, by the 3D emblem and title scene;
     2. each step's small icon is replaced, in the same spot, by a 3D medallion (press, signpost, brass marker).
   Everything else is styling (themes/wildfire.css). destroy() puts the original picture and icons back and frees the 3D scene.
   Only runs while Wildfire is the active theme and the page has the PrintBee hero; no API calls. */
const IMG = '/themes/img/';
const MEDALLIONS = ['wf-step-press', 'wf-step-signpost', 'wf-step-marker'];

export async function mount() {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
  const main = document.querySelector('main#main');
  const picture = main?.querySelector(':scope > .hero img.hero-illustration');
  if (!main || !picture || main.dataset.wfHome) return {destroy() {}};
  main.dataset.wfHome = 'true';
  const root = document.documentElement;
  root.classList.add('wf-home-on');

  // 1. the hero picture slot: same classes, so it takes exactly the box the printer picture took
  const stage = document.createElement('div');
  stage.className = 'hero-illustration wf-stage';
  stage.dataset.wfStage = '';
  stage.setAttribute('role', 'img');
  stage.setAttribute('aria-label', 'The PrintBee emblem and title');
  stage.style.setProperty('--wf-poster', `url("${IMG}wf-hero-card.webp?v=2")`);
  stage.style.aspectRatio = `${picture.getAttribute('width') || 1572} / ${picture.getAttribute('height') || 1001}`;
  picture.insertAdjacentElement('beforebegin', stage);
  picture.style.display = 'none';        // (the picture's own display:block would beat the hidden attribute)

  // 2. the step icons
  const medallions = [];
  main.querySelectorAll('#how .step').forEach((step, index) => {
    const art = document.createElement('img');
    art.className = 'wf-medallion';
    art.src = `${IMG}${MEDALLIONS[index % MEDALLIONS.length]}.webp?v=1`;
    art.width = 320; art.height = 320; art.alt = ''; art.decoding = 'async'; art.loading = 'lazy';
    step.append(art);
    step.classList.add('wf-has-medallion');
    medallions.push([step, art]);
  });

  // the 3D scene loads after the page has settled, never at page load
  let scene, destroyed = false;
  const start = async () => {
    if (destroyed) return;
    try {
      const {mountHero} = await import('/themes/wildfire-hero.js?v=6');
      if (destroyed) return;
      scene = mountHero(stage, {transparent: true, frame: {wide: 5.4, tall: 4.3}, drop: 0, scrollFade: false});
      stage.__wf = scene;                                       // handle for reviews: stage.__wf.seek(seconds)
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
      scene?.destroy();
      stage.remove();
      picture.style.display = '';
      for (const [step, art] of medallions) { art.remove(); step.classList.remove('wf-has-medallion'); }
      root.classList.remove('wf-home-on');
      delete main.dataset.wfHome;
    },
  };
}
