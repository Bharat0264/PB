/* Portal loading screen (admin, warehouse, partner).
 * Shows straight away on reload so the page is never blank while the session and data load.
 * The bee floats inside a clay bubble, honey hexagons orbit it, and a soft bar glides underneath.
 * portal-login.js calls PBLoader.done() when the workspace is ready (or when an error needs showing).
 */
(() => {
  'use strict';
  if (window.PBLoader) return;
  const portal = /^\/(admin|warehouse|partner)/.test(location.pathname) || location.pathname === '/staff.html';
  if (!portal) {
    // Customer pages: direct visits and reloads only. Never inside the tab shell iframes, and not on page-to-page clicks.
    if (window.parent !== window) return;
    const nav = performance.getEntriesByType('navigation')[0];
    if (document.referrer && nav?.type === 'navigate') {
      const previous = new URL(document.referrer);
      if (previous.origin === location.origin && previous.pathname !== location.pathname) return;
    }
    const shell = ['/', '/index.html', '/orders.html', '/queue.html', '/address.html', '/profile.html'];
    if (shell.includes(location.pathname) && matchMedia('(max-width: 700px)').matches) return;
  }
  const css = `
  #pb-loader{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;align-content:center;gap:26px;
    background:var(--hv-page-bg,#ece4d3);color:var(--hv-ink,#2a2112);font:700 16px/1.4 Manrope,system-ui,sans-serif;
    transition:opacity .4s ease,visibility .4s}
  #pb-loader[data-done]{opacity:0;visibility:hidden;pointer-events:none}
  #pb-loader .pbl-stage{position:relative;width:176px;height:176px;display:grid;place-items:center}
  #pb-loader .pbl-bubble{position:relative;z-index:1;display:grid;place-items:center;width:112px;height:112px;border-radius:50%;
    background:linear-gradient(150deg,#fffaf0,#f3e3b6);
    box-shadow:10px 14px 28px rgba(110,80,28,.24),-7px -7px 18px rgba(255,252,244,.8),inset -5px -6px 12px rgba(167,116,32,.14),inset 5px 6px 12px rgba(255,253,246,.9);
    animation:pbl-float 2.6s ease-in-out infinite}
  #pb-loader .pbl-bubble img{width:72px;height:auto;display:block}
  #pb-loader .pbl-ring{position:absolute;inset:0;animation:pbl-spin 3.2s linear infinite}
  #pb-loader .pbl-ring i{position:absolute;left:50%;top:50%;width:20px;height:22px;margin:-11px 0 0 -10px;background:#f5c542;
    clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);filter:drop-shadow(0 2px 3px rgba(185,131,26,.5))}
  #pb-loader .pbl-ring i:nth-child(1){transform:rotate(0deg) translateY(-82px)}
  #pb-loader .pbl-ring i:nth-child(2){transform:rotate(120deg) translateY(-82px);opacity:.72}
  #pb-loader .pbl-ring i:nth-child(3){transform:rotate(240deg) translateY(-82px);opacity:.45}
  #pb-loader .pbl-pulse{position:absolute;inset:26px;border-radius:50%;border:2px solid rgba(245,197,66,.55);animation:pbl-pulse 2.6s ease-out infinite}
  #pb-loader .pbl-pulse:nth-of-type(2){animation-delay:1.3s}
  #pb-loader .pbl-text{display:grid;gap:4px;justify-items:center;text-align:center}
  #pb-loader .pbl-text strong{font-size:20px;letter-spacing:-.02em}
  #pb-loader .pbl-text span{color:var(--hv-muted,#6e5e3e);font-size:14px;font-weight:600}
  #pb-loader .pbl-text span::after{content:"";display:inline-block;width:1.2em;text-align:left;animation:pbl-dots 1.4s steps(4,end) infinite}
  #pb-loader .pbl-bar{position:relative;width:min(220px,60vw);height:8px;border-radius:999px;overflow:hidden;
    background:rgba(110,80,28,.12);box-shadow:inset 2px 2px 4px rgba(110,80,28,.18)}
  #pb-loader .pbl-bar::after{content:"";position:absolute;top:0;bottom:0;width:42%;border-radius:999px;
    background:linear-gradient(90deg,#ffe49a,#f5c542);animation:pbl-glide 1.5s cubic-bezier(.65,0,.35,1) infinite}
  @keyframes pbl-float{50%{transform:translateY(-8px)}}
  @keyframes pbl-spin{to{transform:rotate(360deg)}}
  @keyframes pbl-pulse{0%{transform:scale(.8);opacity:.9}100%{transform:scale(1.55);opacity:0}}
  @keyframes pbl-glide{0%{left:-45%}100%{left:103%}}
  @keyframes pbl-dots{0%{content:""}25%{content:"."}50%{content:".."}75%,100%{content:"..."}}
  [data-theme="dark"] #pb-loader .pbl-bubble{background:linear-gradient(150deg,#3a2e18,#2b2112);box-shadow:8px 12px 24px rgba(0,0,0,.45),inset 3px 4px 8px rgba(255,243,214,.08)}
  [data-theme="dark"] #pb-loader .pbl-bar{background:rgba(255,243,214,.12);box-shadow:none}
  @media (prefers-reduced-motion:reduce){
    #pb-loader .pbl-bubble,#pb-loader .pbl-ring,#pb-loader .pbl-pulse,#pb-loader .pbl-bar::after,#pb-loader .pbl-text span::after{animation:none}
    #pb-loader .pbl-bar::after{left:0;width:60%}
  }`;
  const label = portal ? 'Opening your ' + (({admin: 'admin workspace', warehouse: 'print floor', partner: 'delivery hive'})[
    (location.pathname.match(/warehouse|partner|admin/) || ['warehouse'])[0]] || 'workspace') : 'Getting your print studio ready';
  const style = document.createElement('style');
  style.textContent = css;
  const box = document.createElement('div');
  box.id = 'pb-loader';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.innerHTML = `<div class="pbl-stage" aria-hidden="true"><span class="pbl-pulse"></span><span class="pbl-pulse"></span>
      <div class="pbl-ring"><i></i><i></i><i></i></div>
      <div class="pbl-bubble"><img src="/printbee-header-bee.webp" alt="" width="72" height="57"></div></div>
    <div class="pbl-text"><strong>PrintBee</strong><span>${label}</span></div>
    <div class="pbl-bar" aria-hidden="true"></div>`;
  document.head.append(style);
  document.documentElement.append(box);
  const finish = () => {
    box.dataset.done = '';
    setTimeout(() => box.remove(), 500);
  };
  // If something goes wrong and nobody calls done(), never trap the user behind the loader.
  const safety = setTimeout(finish, portal ? 20000 : 4000);
  window.PBLoader = {done() { clearTimeout(safety); finish(); }};
  if (!portal) {
    // Customer pages have no session gate: show the loader for a short, smooth moment and until the page has loaded.
    const started = performance.now();
    const leave = () => setTimeout(window.PBLoader.done, Math.max(0, 750 - (performance.now() - started)));
    if (document.readyState === 'complete') leave(); else addEventListener('load', leave, {once: true});
  }
})();
