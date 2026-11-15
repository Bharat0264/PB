/* PrintBee "Hive" theme helper — presentation only.
 * 1. Applies the saved theme before first paint (no flash). Pages without a theme toggle
 *    follow the device setting unless a choice was saved.
 * 2. Adds decorative hooks: page class, sun/moon switch class, gliding nav indicator.
 * 3. Plays a circular reveal around the existing theme toggle (View Transitions), by replaying
 *    the page's own click inside the transition. No text, data or behaviour changes.
 */
(() => {
  'use strict';
  const KEY = 'printbee-admin-theme';
  const script = document.currentScript;
  const followSystem = script?.dataset.followSystem !== 'false';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const apply = dark => { root.dataset.theme = dark ? 'dark' : 'light'; };
  const choice = stored();
  apply(choice ? choice === 'dark' : followSystem && system.matches);
  root.classList.add('hv-page');
  if (followSystem) system.addEventListener('change', e => { if (!stored()) apply(e.matches); });
  // Keep pages in sync when the choice changes in another tab.
  addEventListener('storage', e => { if (e.key === KEY && e.newValue) apply(e.newValue === 'dark'); });

  // Circular reveal from the toggle that was pressed (fade fallback via CSS transitions).
  // Skipped when the page can't render (hidden tab) or a reveal is already running, so a
  // click is never delayed or lost.
  let revealing = false;
  document.addEventListener('click', event => {
    if (event.hvReplay) return;
    const toggle = event.target.closest?.('#theme, #settings-theme');
    if (!toggle || !document.startViewTransition || reduced.matches || revealing || document.visibilityState !== 'visible' || !innerWidth) return;
    event.stopPropagation();
    event.preventDefault();
    const origin = (toggle.id === 'theme' ? toggle : document.getElementById('theme') || toggle).getBoundingClientRect();
    const x = origin.left + origin.width / 2, y = origin.top + origin.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    revealing = true;
    const transition = document.startViewTransition(() => {
      const replay = new MouseEvent('click', {bubbles: true, cancelable: true, view: window});
      replay.hvReplay = true;
      toggle.dispatchEvent(replay);
    });
    transition.finished.finally(() => { revealing = false; });
    transition.ready.then(() => root.animate(
      {clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]},
      {duration: 600, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)'})).catch(() => {});
  }, true);

  // Gliding active indicator behind the current nav item (decorative, aria-hidden).
  function glide(nav) {
    if (!nav) return;
    nav.classList.add('hv-glide-host');
    const pill = document.createElement('span');
    pill.className = 'hv-glide';
    pill.setAttribute('aria-hidden', 'true');
    nav.prepend(pill);
    const place = () => {
      const current = nav.querySelector('[aria-current]:not(.hv-glide)');
      const visible = current && current.offsetParent !== null;
      pill.style.opacity = visible ? '1' : '0';
      if (!visible) return;
      pill.style.width = current.offsetWidth + 'px';
      pill.style.height = current.offsetHeight + 'px';
      pill.style.transform = `translate(${current.offsetLeft}px, ${current.offsetTop}px)`;
    };
    new MutationObserver(place).observe(nav, {subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current']});
    new ResizeObserver(place).observe(nav);
    addEventListener('resize', place);
    place();
  }
  const ready = () => {
    document.getElementById('theme')?.classList.add('hv-switch');
    glide(document.getElementById('sidebar-nav'));
    glide(document.getElementById('warehouse-nav'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once: true});
  else ready();
})();
