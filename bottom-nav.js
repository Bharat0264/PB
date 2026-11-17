import {navTokens as theme} from './nav-tokens.js?v=hive-clay';

export const tabs = [
  {key:'home', label:'Home', path:'/home', page:'/index.html', icon:'<path d="m3 10 9-7 9 7v10h-6v-6H9v6H3z"/>'},
  {key:'orders', label:'Orders', path:'/orders', page:'/orders.html', icon:'<path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M7.5 5l9 4"/>'},
  {key:'upload', label:'Upload', path:'/upload', page:'/queue.html', icon:'<path d="M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5"/>'},
  {key:'address', label:'Address', path:'/address', page:'/address.html', icon:'<path d="M20 10c0 5-8 10-8 10s-8-5-8-10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>'},
  {key:'profile', label:'Profile', path:'/profile', page:'/profile.html', icon:'<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/>'},
];
const uploadIndex = tabs.findIndex(tab => tab.key === 'upload');
const svgNS = 'http://www.w3.org/2000/svg';
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const easing = 'cubic-bezier(.215,.61,.355,1)';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function notchPath(width, height, cx, radius, fillet) {
  const edge = Math.min(cx, width - cx);
  const y = theme.diameter / 2 - theme.lift;
  const r = Math.min(radius, edge);
  if (r <= y) return `M0 14 Q0 0 14 0 H${width-14} Q${width} 0 ${width} 14 V${height} H0 Z`;
  // The outer arcs are tangent to the top edge and the circular cut-out.
  const f = clamp((edge * edge + y * y - r * r) / (2 * (r + y)), 0, fillet);
  const offset = Math.sqrt((r + f) ** 2 - (y - f) ** 2);
  const x = offset * r / (r + f);
  const join = y + (f - y) * r / (r + f);
  const left = f ? `A${f} ${f} 0 0 1 ${cx-x} ${join}` : '';
  const right = f ? `A${f} ${f} 0 0 1 ${cx+offset} 0` : '';
  const start = clamp(cx - offset, 0, 14);
  const end = clamp(width - cx - offset, 0, 14);
  return `M0 ${start} Q0 0 ${start} 0 H${cx-offset} ${left} A${r} ${r} 0 ${join < y ? 1 : 0} 0 ${cx+x} ${join} ${right} H${width-end} Q${width} 0 ${width} ${end} V${height} H0 Z`;
}

function icon(index) {
  const svg = document.createElementNS(svgNS, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  svg.innerHTML = tabs[index].icon;
  return svg;
}

function routeIndex() {
  const path = location.pathname.replace(/\/$/, '');
  const index = tabs.findIndex(tab => path === tab.path || path === tab.page);
  return index < 0 ? 0 : index;
}

export class BottomNav {
  constructor(bar) {
    this.bar = bar;
    this.bar.setAttribute('role', 'tablist');
    this.links = tabs.map(({key:route, label, path}, index) => {
      const tab = document.createElement('a');
      tab.id = 'tab-' + route;
      tab.href = path;
      tab.setAttribute('aria-label', label);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'panel-' + route);
      const picture = document.createElement('span');
      picture.className = 'tab-icon';
      picture.append(icon(index));
      tab.append(picture, document.createTextNode(label));
      tab.addEventListener('click', event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        this.onSelect(index);
      });
      return tab;
    });
    this.shape = document.createElementNS(svgNS, 'svg');
    this.shape.setAttribute('class', 'nav-shape');
    this.shape.setAttribute('aria-hidden', 'true');
    this.shape.innerHTML = '<defs><linearGradient id="customer-nav-clay" x2="0" y2="1"><stop class="nav-glaze" offset="0%"/><stop class="nav-surface" offset="26%"/><stop class="nav-depth" offset="100%"/></linearGradient></defs>';
    this.path = document.createElementNS(svgNS, 'path');
    this.shape.append(this.path);
    this.bubble = document.createElement('div');
    this.bubble.className = 'nav-bubble';
    this.bubble.setAttribute('aria-hidden', 'true');
    this.ghost = document.createElement('div');
    this.ghost.className = 'nav-ghost';
    this.ghost.setAttribute('aria-hidden', 'true');
    bar.replaceChildren(this.shape, ...this.links, this.ghost, this.bubble);
    const style = document.documentElement.style;
    const variables = {size: theme.diameter + 'px', lift: theme.lift + 'px',
      height: `calc(${theme.height}px + env(safe-area-inset-bottom, 0px))`};
    Object.entries(variables).forEach(([key, value]) => style.setProperty('--nav-' + key, value));
    this.index = routeIndex();
    this.velocity = 0;
    this.trail = [];
    this.select(this.index, false);
    new ResizeObserver(() => this.measure()).observe(bar);
    motion.addEventListener('change', () => this.measure());
    bar.addEventListener('keydown', event => {
      const current = this.links.indexOf(document.activeElement);
      if (current < 0) return;
      const moves = {ArrowLeft: (current + 4) % 5, ArrowRight: (current + 1) % 5, Home: 0, End: 4};
      if (event.key in moves) {
        event.preventDefault();
        this.links[moves[event.key]].focus();
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        this.onSelect(current);
      }
    });
  }

  center() { return this.width * (this.index + .5) / tabs.length; }

  measure() {
    cancelAnimationFrame(this.frame);
    this.width = this.bar.clientWidth;
    this.height = this.bar.clientHeight;
    if (!this.width) return;
    this.x = this.center();
    this.velocity = 0;
    this.trail = [];
    this.paint();
    this.bar.classList.add('is-ready');
  }

  paint(time) {
    const margin = this.width / (2 * tabs.length);
    const x = clamp(this.x, margin, this.width - margin);
    const edge = Math.min(x, this.width - x);
    const stretch = motion.matches ? 0 : Math.min(.2, Math.abs(this.velocity) / 3600, Math.max(0, (edge - 3) / 28 - 1));
    const radius = this.bar.classList.contains('off-tab') ? 0 : theme.radius * (1 + stretch);
    this.path.setAttribute('d', notchPath(this.width, this.height, x, radius, theme.fillet));
    if (!radius) return;
    this.bubble.style.transform = `translate3d(${x}px,0,0) scale(${1+stretch},${1-.6*stretch})`;
    if (time) {
      this.trail.push({x, time});
      while (time - this.trail[0].time >= 120) this.trail.shift();
    }
    const point = this.trail.findLast(entry => time - entry.time >= 24);
    this.ghost.style.opacity = point && stretch > .015 ? .15 : 0;
    this.ghost.style.transform = `translate3d(${point?.x ?? x}px,0,0)`;
  }

  slide() {
    cancelAnimationFrame(this.frame);
    let previous = performance.now();
    const step = time => {
      let remaining = Math.min((time - previous) / 1000, .04);
      previous = time;
      const target = this.center();
      const {stiffness, damping, mass} = theme.spring;
      while (remaining > 0) {
        const delta = Math.min(remaining, 1 / 120);
        this.velocity += (stiffness * (target - this.x) - damping * this.velocity) / mass * delta;
        this.x += this.velocity * delta;
        remaining -= delta;
      }
      if (Math.abs(target - this.x) < .15 && Math.abs(this.velocity) < 4) {
        this.x = target;
        this.velocity = 0;
        this.trail = [];
        this.paint();
      } else {
        this.paint(time);
        this.frame = requestAnimationFrame(step);
      }
    };
    this.frame = requestAnimationFrame(step);
  }

  select(index, animate = true) {
    this.index = index;
    this.links.forEach((link, i) => {
      link.setAttribute('aria-selected', String(i === index));
      link.tabIndex = i === index ? 0 : -1;
    });
    const previous = this.bubble.lastElementChild;
    this.bubble.getAnimations({subtree: true}).forEach(animation => animation.cancel());
    const next = icon(index);
    const rotation = 0; // the upload arrow stays straight
    next.style.transform = `rotate(${rotation}deg)`;
    this.bubble.replaceChildren(next);
    if (animate && !motion.matches && this.width) {
      if (previous) {
        this.bubble.prepend(previous);
        previous.animate([{scale: 1}, {scale: .65}],
          {duration: 90, fill: 'forwards'}).finished.then(() => previous.remove(), () => {});
      }
      next.animate([{opacity: 0, transform: `rotate(${rotation-18}deg) scale(.65)`},
        {opacity: 1, transform: `rotate(${rotation}deg) scale(.74)`, offset: .18},
        {opacity: 1, transform: `rotate(${rotation}deg) scale(1)`}], {duration: 110, delay: 70, fill: 'backwards'});
      this.slide();
    } else {
      this.measure();
    }
  }

  pulse() {
    if (!motion.matches) this.bubble.animate([{scale: 1}, {scale: 1.08}, {scale: 1}],
      {duration: 240, easing});
  }
}

if (window.parent !== window && document.documentElement.classList.contains('embedded-tab')) {
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        link.hasAttribute('download') || (link.target && link.target !== '_top') || link.getAttribute('href').startsWith('#')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin) return;
    const tab = tabs.find(tab => tab.page === url.pathname || tab.path === url.pathname);
    if (!tab) return;
    event.preventDefault();
    url.searchParams.delete('embedded');
    window.parent.postMessage({printbeeNavigate:tab.path + url.search + url.hash}, location.origin);
  });
}

const canonical = tabs.find(tab => tab.page === location.pathname || (tab.key === 'home' && location.pathname === '/'));
if (window.parent === window && canonical && matchMedia('(max-width: 700px)').matches) {
  location.replace(canonical.path + location.search + location.hash);
}
const bar = document.querySelector('#bottom-nav');
if (bar) mountLayout(bar);
else if (window.parent === window) {
  const dock = document.querySelector('.mobile-dock');
  if (dock) {
    dock.className = 'bottom-nav direct-nav';
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/navigation.css?v=hive-clay';
    document.head.append(css);
    const nav = new BottomNav(dock);
    document.body.classList.add('has-direct-nav');
    for (const link of nav.links) link.removeAttribute('aria-controls');
    if (!tabs.some(tab => tab.page === location.pathname || tab.path === location.pathname || (tab.key === 'home' && location.pathname === '/'))) {
      nav.links.forEach((link, i) => {
        link.setAttribute('aria-selected', 'false');
        link.tabIndex = i === 0 ? 0 : -1;
      });
      dock.classList.add('off-tab');
    }
    nav.onSelect = index => {
      if (nav.links[index].getAttribute('aria-selected') === 'true') {
        window.scrollTo(0, 0);
        nav.pulse();
      } else location.assign(tabs[index].path);
    };
  }
}

function mountLayout(bar) {
  const nav = new BottomNav(bar);
  const screens = document.querySelector('#tab-screens');
  const panels = new Map();
  let previousIndex = routeIndex();
  let activePanel;
  let animations = [];

  function panelFor(index) {
    const tab = tabs[index];
    const url = new URL(tab.page, location.origin);
    if (index === routeIndex()) {
      url.search = location.search;
      url.hash = location.hash;
    }
    url.searchParams.set('embedded', tab.key);
    const key = url.href;
    if (panels.has(key)) return panels.get(key);
    const panel = document.createElement('section');
    panel.className = 'tab-panel';
    panel.id = 'panel-' + tab.key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'tab-' + tab.key);
    panel.hidden = panel.inert = true;
    const frame = document.createElement('iframe');
    frame.title = tab.label;
    frame.src = url;
    panel.append(frame);
    screens.append(panel);
    panels.set(key, panel);
    return panel;
  }

  function show(initial = false) {
    animations.forEach(animation => animation.cancel());
    animations = [];
    const index = routeIndex();
    const next = panelFor(index);
    const previous = activePanel;
    const panelId = 'panel-' + tabs[index].key;
    for (const panel of panels.values()) {
      panel.hidden = panel.inert = panel !== next;
      if (panel !== next && panel.id === panelId) panel.removeAttribute('id');
    }
    next.id = panelId;
    activePanel = next;
    if (!initial && previous !== next) {
      const distance = motion.matches || index === previousIndex ? 0 : index > previousIndex ? 24 : -24;
      const options = {duration: motion.matches ? theme.reducedTransition : theme.transition, easing};
      previous.hidden = false;
      const exit = previous.animate([{opacity: 1}, {opacity: 0, transform: `translateX(${-distance}px)`}], options);
      exit.finished.then(() => { if (activePanel !== previous) previous.hidden = true; }, () => {});
      animations.push(exit, next.animate([{opacity: 0, transform: `translateX(${distance}px)`}, {opacity: 1, transform:'none'}], options));
    }
    next.querySelector('iframe').contentWindow?.postMessage('printbee:tab-shown', location.origin);
    const changed = previousIndex !== index;
    previousIndex = index;
    nav.select(index, !initial && changed);
    document.title = tabs[index].label + ' · PrintBee';
  }

  function navigate(url) {
    if (url === location.pathname + location.search + location.hash) return;
    history.pushState(null, '', url);
    show();
  }

  nav.onSelect = index => {
    if (index === routeIndex()) {
      try { activePanel.querySelector('iframe').contentWindow.scrollTo(0, 0); } catch {}
      nav.pulse();
      return;
    }
    if (!motion.matches) navigator.vibrate?.(8);
    navigate(tabs[index].path);
  };
  addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== activePanel?.querySelector('iframe').contentWindow) return;
    const href = event.data?.printbeeNavigate;
    if (typeof href !== 'string') return;
    const url = new URL(href, location.origin);
    const tab = tabs.find(tab => tab.path === url.pathname);
    if (tab && url.origin === location.origin) navigate(tab.path + url.search + url.hash);
  });
  addEventListener('popstate', () => show());
  show(true);
  const warm = () => tabs.forEach((_, i) => { if (i !== routeIndex()) panelFor(i); });
  if ('requestIdleCallback' in window) requestIdleCallback(warm, {timeout:1500});
  else setTimeout(warm, 500);
}
