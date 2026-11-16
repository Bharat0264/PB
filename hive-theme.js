/* Shared Sun Hive / Moon Hive controls and motion. */
(() => {
  'use strict';
  const KEY = 'printbee-admin-theme';
  const script = document.currentScript;
  const partner = script?.dataset.palette === 'partner';
  const override = partner ? new URLSearchParams(location.search).get('theme') : null;
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const selectors = '[data-hive-toggle]';
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const dark = () => ['dark','moon'].includes(root.dataset.theme);
  const followingSystem = script?.dataset.followSystem !== 'false';

  function syncControls() {
    const moon = dark();
    for (const toggle of document.querySelectorAll(selectors)) {
      toggle.setAttribute('aria-pressed', String(moon));
      toggle.setAttribute('aria-label', moon ? 'Switch to Sun Hive' : 'Switch to Moon Hive');
    }
    const chrome = document.querySelector('meta[name="theme-color"]');
    if (chrome) chrome.content = moon ? '#17120A' : '#FFF8E8';
  }

  function apply(moon) {
    root.dataset.theme = partner ? (moon ? 'moon' : 'sun') : (moon ? 'dark' : 'light');
    syncControls();
  }

  const saved = read(KEY);
  const partnerLegacy = partner ? read('printbee-rider-night') : null;
  apply(override ? override === 'moon' : saved ? saved === 'dark' :
    partnerLegacy !== null ? partnerLegacy === '1' : followingSystem && system.matches);
  if (!partner) root.classList.add('hv-page');
  if (!override && followingSystem) system.addEventListener('change', e => {
    if (!read(KEY) && (!partner || read('printbee-rider-night') === null)) apply(e.matches);
  });
  addEventListener('storage', e => {
    if (!override && e.key === KEY && e.newValue) apply(e.newValue === 'dark');
  });

  let reveal;
  function toggleTheme(toggle) {
    const update = () => {
      const moon = !dark();
      apply(moon);
      if (!override) {
        try { localStorage.setItem(KEY, moon ? 'dark' : 'light'); } catch {}
      }
    };
    const box = toggle?.getBoundingClientRect();
    if (!box?.width || !document.startViewTransition || reduced.matches || document.hidden) {
      update();
      return;
    }
    reveal?.skipTransition();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(update);
    reveal = transition;
    transition.finished.then(() => {
      if (reveal === transition) reveal = undefined;
    }, () => {
      if (reveal === transition) reveal = undefined;
    });
    transition.ready.then(() => root.animate(
      {clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)']},
      {duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)'})).catch(() => {});
  }
  window.PrintBeeTheme = {toggle: toggleTheme};
  document.addEventListener('click', event => {
    const toggle = event.target.closest?.(selectors);
    if (toggle) toggleTheme(toggle);
  });

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
    syncControls();
    glide(document.getElementById('sidebar-nav'));
    glide(document.getElementById('warehouse-nav'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once: true});
  else ready();
})();
