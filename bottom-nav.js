import {navTokens as theme} from './nav-tokens.js';

const tabs = [
  ['profile', 'Profile', '/profile.html', '<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/>'],
  ['saved', 'Saved', '/queue.html?embedded=saved', '<path d="M6 4h12v16l-6-4-6 4z"/>'],
  ['add', 'Add', '/queue.html', '<path d="M12 5v14M5 12h14"/>'],
  ['track', 'Track', '/orders.html', '<path d="M20 10c0 5-8 10-8 10S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>'],
  ['more', 'More', null, '<path d="M5 6h14M5 12h14M5 18h14"/>'],
];
const addIndex = 2;
const svgNS = 'http://www.w3.org/2000/svg';
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const easing = 'cubic-bezier(.215,.61,.355,1)';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function notchPath(width, height, cx, radius, fillet) {
  const r = Math.max(0, Math.min(radius, cx, width - cx));
  const f = Math.max(0, Math.min(fillet, cx - r, width - cx - r));
  const depth = radius + 6;
  const k = .55228475;
  return `M0 0 H${cx-r-f} C${cx-r} 0 ${cx-r} 3 ${cx-r} 6
    C${cx-r} ${6+radius*k} ${cx-r*k} ${depth} ${cx} ${depth}
    C${cx+r*k} ${depth} ${cx+r} ${6+radius*k} ${cx+r} 6
    C${cx+r} 3 ${cx+r} 0 ${cx+r+f} 0 H${width} V${height} H0 Z`;
}

function icon(index) {
  const svg = document.createElementNS(svgNS, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  svg.innerHTML = tabs[index][3];
  return svg;
}

function routeIndex() {
  const path = location.pathname.replace(/\/$/, '');
  const index = tabs.findIndex(([route]) => path === '/' + route);
  return index < 0 ? 0 : index;
}

export class BottomNav {
  constructor(bar) {
    this.bar = bar;
    this.bar.setAttribute('role', 'tablist');
    this.links = tabs.map(([route, label], index) => {
      const tab = document.createElement('a');
      tab.id = 'tab-' + route;
      tab.href = '/' + route;
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
    this.path = document.createElementNS(svgNS, 'path');
    this.shape.append(this.path);
    this.bubble = document.createElement('div');
    this.bubble.className = 'nav-bubble';
    this.bubble.setAttribute('aria-hidden', 'true');
    this.ghosts = [.25, .12].map(() => {
      const ghost = document.createElement('div');
      ghost.className = 'nav-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      return ghost;
    });
    bar.replaceChildren(this.shape, ...this.links, ...this.ghosts, this.bubble);
    const style = document.documentElement.style;
    const variables = {ink: theme.ink, surface: theme.bar, bubble: theme.bubble, shadow: theme.shadow,
      size: theme.diameter + 'px', lift: theme.lift + 'px',
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

  center() { return this.width * (this.index + .5) / 5; }

  measure() {
    cancelAnimationFrame(this.frame);
    this.width = this.bar.clientWidth;
    this.height = this.bar.clientHeight;
    this.x = this.center();
    this.velocity = 0;
    this.trail = [];
    this.paint();
  }

  paint(time) {
    const margin = this.width / 10;
    const x = clamp(this.x, margin - 5, this.width - margin + 5);
    const stretch = motion.matches ? 0 : Math.min(.25, Math.abs(this.velocity) / 3600);
    this.path.setAttribute('d', notchPath(this.width, this.height, x, theme.radius * (1 + stretch * .7), theme.fillet));
    this.bubble.style.transform = `translate3d(${x}px,0,0) scale(${1+stretch},${1-.6*stretch})`;
    if (time) {
      this.trail.push({x, time});
      while (time - this.trail[0].time >= 120) this.trail.shift();
    }
    this.ghosts.forEach((ghost, index) => {
      const point = this.trail.findLast(entry => time - entry.time >= 20 + index * 24);
      ghost.style.opacity = point && stretch > .015 ? (index ? .12 : .25) : 0;
      ghost.style.transform = `translate3d(${point?.x ?? x}px,0,0)`;
    });
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
    const rotation = index === addIndex ? 45 : 0;
    next.style.transform = `rotate(${rotation}deg)`;
    this.bubble.replaceChildren(next);
    if (animate && !motion.matches) {
      if (previous) {
        this.bubble.prepend(previous);
        previous.animate([{scale: 1, opacity: 1}, {scale: .65, opacity: 0}],
          {duration: 90, fill: 'forwards'}).finished.then(() => previous.remove(), () => {});
      }
      next.animate([{opacity: 0, transform: `rotate(${rotation-18}deg) scale(.65)`},
        {opacity: 1, transform: `rotate(${rotation}deg) scale(1)`}], {duration: 125, delay: 85, fill: 'backwards'});
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

const bar = document.querySelector('#bottom-nav');
if (bar) mountLayout(bar);
else {
  const dock = document.querySelector('.mobile-dock');
  if (dock && window.parent === window) {
    const label = dock.getAttribute('aria-label');
    dock.innerHTML = tabs.map(([route, name], i) =>
      `<a href="/${route}"><span class="dock-icon" aria-hidden="true">${icon(i).outerHTML}</span>${name}</a>`).join('');
    dock.setAttribute('aria-label', label);
  }
}

function mountLayout(bar) {
  const nav = new BottomNav(bar);
  const screens = document.querySelector('#tab-screens');
  const sheet = document.querySelector('#sheet-layer');
  const close = document.querySelector('#close-sheet');
  const panels = new Map();
  let active = routeIndex();
  let underlying = active === addIndex ? (history.state?.underlying ?? 1) : active;
  let outgoing = [];

  function panelFor(index) {
    if (panels.has(index)) return panels.get(index);
    const [route, label, source] = tabs[index];
    const panel = document.createElement('section');
    panel.className = 'tab-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'tab-' + route);
    panel.id = 'panel-' + route;
    if (source) {
      const frame = document.createElement('iframe');
      frame.title = label;
      const url = new URL(source, location.origin);
      url.searchParams.set('embedded', route);
      if (index === routeIndex()) {
        for (const [key, value] of new URLSearchParams(location.search)) {
          if (key !== 'embedded') url.searchParams.set(key, value);
        }
        url.hash = location.hash;
      }
      frame.src = url;
      panel.append(frame);
    } else {
      panel.classList.add('more-panel');
      panel.innerHTML = '<h1>More</h1><a href="/index.html">Home</a><a href="/address.html">Delivery address</a><a href="/pricing.html">Print prices</a><a href="https://wa.me/919347541419">Help on WhatsApp</a>';
    }
    panel.hidden = true;
    panel.inert = true;
    (index === addIndex ? sheet : screens).append(panel);
    panels.set(index, panel);
    return panel;
  }

  function show(index, initial = false) {
    for (const animation of outgoing) animation.cancel();
    outgoing = [];
    const prior = active;
    const wasSheet = prior === addIndex;
    const isSheet = index === addIndex;
    const previous = panelFor(underlying);
    const next = panelFor(isSheet ? underlying : index);
    panels.forEach((panel, key) => {
      panel.hidden = key !== (isSheet ? underlying : index) && key !== addIndex;
      panel.inert = panel.hidden || (isSheet && key !== addIndex);
    });
    const options = {duration: motion.matches ? theme.reducedTransition : theme.transition, easing};
    if (!initial && previous !== next && !isSheet && !wasSheet) {
      const distance = motion.matches ? 0 : (index > prior ? 24 : -24);
      previous.hidden = false;
      previous.inert = true;
      previous.classList.add('is-closing');
      const exit = previous.animate([{opacity: 1, transform: 'none'},
        {opacity: 0, transform: `translateX(${-distance}px)`}], options);
      exit.finished.then(() => {
        if (active !== prior) previous.hidden = true;
        previous.classList.remove('is-closing');
      }, () => previous.classList.remove('is-closing'));
      outgoing.push(exit, next.animate([{opacity: 0, transform: `translateX(${distance}px)`},
        {opacity: 1, transform: 'none'}], options));
    }
    if (isSheet) {
      const add = panelFor(addIndex);
      add.hidden = false;
      add.inert = false;
      add.querySelector('iframe').contentWindow?.postMessage('printbee:tab-shown', location.origin);
      sheet.hidden = false;
      sheet.inert = false;
      if (!initial && !wasSheet) {
        outgoing.push(sheet.animate([{opacity: 0, transform: motion.matches ? 'none' : 'translateY(100%)'},
          {opacity: 1, transform: 'none'}], options));
      }
      close.focus({preventScroll: true});
    } else if (!initial && wasSheet) {
      sheet.inert = true;
      const exit = sheet.animate([{opacity: 1, transform: 'none'},
        {opacity: 0, transform: motion.matches ? 'none' : 'translateY(100%)'}], options);
      exit.finished.then(() => { if (active !== addIndex) sheet.hidden = true; }, () => {});
      outgoing.push(exit);
    } else {
      sheet.hidden = true;
    }
    if (!initial && isSheet !== wasSheet) {
      outgoing.push(bar.animate(isSheet
        ? [{translate: '0 0', opacity: 1}, {translate: motion.matches ? '0 0' : '0 115%', opacity: 0}]
        : [{translate: motion.matches ? '0 0' : '0 115%', opacity: 0}, {translate: '0 0', opacity: 1}],
      {...options, fill: 'both'}));
    }
    bar.inert = isSheet;
    bar.style.visibility = initial && isSheet ? 'hidden' : '';
    if (!isSheet) {
      underlying = index;
      next.querySelector('iframe')?.contentWindow?.postMessage('printbee:tab-shown', location.origin);
    }
    active = index;
    nav.select(index, !initial);
    document.title = tabs[index][1] + ' · PrintBee';
  }

  nav.onSelect = index => {
    if (index === active) {
      const panel = panelFor(index);
      panel.scrollTop = 0;
      try { panel.querySelector('iframe')?.contentWindow.scrollTo(0, 0); } catch {}
      nav.pulse();
      return;
    }
    if (!motion.matches) navigator.vibrate?.(8);
    history.pushState({underlying}, '', '/' + tabs[index][0]);
    show(index);
  };
  close.addEventListener('click', () => {
    if (history.state?.underlying !== undefined) history.back();
    else {
      history.replaceState(null, '', '/' + tabs[underlying][0]);
      show(underlying);
    }
  });
  document.addEventListener('keydown', event => {
    if (active === addIndex && event.key === 'Escape') close.click();
  });
  addEventListener('message', event => {
    if (event.origin !== location.origin ||
        event.source !== panelFor(active).querySelector('iframe')?.contentWindow) return;
    if (event.data === 'printbee:close-sheet' && active === addIndex) close.click();
  });
  addEventListener('popstate', () => {
    const exitingSheet = active === addIndex && routeIndex() !== addIndex;
    show(routeIndex());
    if (exitingSheet) nav.links[active].focus({preventScroll: true});
  });
  show(active, true);
  const warmPanels = () => {
    for (const index of [0, 1, 3]) panelFor(index);
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warmPanels, {timeout: 1500});
  else window.setTimeout(warmPanels, 500);
}
