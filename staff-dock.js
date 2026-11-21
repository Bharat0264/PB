/* Staff-only navigation. The portals own routes and pass their current section here. */
window.createStaffDock = function createStaffDock(nav, tabs) {
  const ns = 'http://www.w3.org/2000/svg';
  // Lucide-style outline geometry. The active state fills the primary shape.
  const icons = {
    home:'<path class="fill" d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path class="detail" d="M9 21v-7h6v7"/>',
    orders:'<rect class="fill" x="4" y="4" width="16" height="17" rx="2"/><path class="detail" d="M8 9h8m-8 4h8m-8 4h4"/>',
    ledger:'<path class="fill" d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path class="detail" d="M7 7h8M7 11h8m-8 4h6"/>',
    more:'<circle class="fill" cx="5" cy="12" r="1"/><circle class="fill" cx="12" cy="12" r="1"/><circle class="fill" cx="19" cy="12" r="1"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    power:'<path d="M12 3v9M6.3 5.8a8.5 8.5 0 1 0 11.4 0"/>',
    ready:'<circle class="fill" cx="12" cy="12" r="9"/><path class="detail" d="m8 12 3 3 5-6"/>',
    history:'<circle class="fill" cx="12" cy="12" r="9"/><path class="detail" d="M12 7v5l3 2"/>',
    earnings:'<rect class="fill" x="3" y="5" width="18" height="14" rx="3"/><path class="detail" d="M3 10h18m-13 5h4"/>',
    inbox:'<path class="fill" d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/>',
    profile:'<circle class="fill" cx="12" cy="7" r="4"/><path class="fill" d="M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2z"/>',
  };

  function svg(attributes) {
    const node = document.createElementNS(ns, 'svg');
    node.setAttribute('aria-hidden','true');
    for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,value);
    return node;
  }
  const surface = svg({class:'staff-dock-surface', preserveAspectRatio:'none'});
  const path = document.createElementNS(ns,'path');
  surface.append(path);

  const items = document.createElement('div');
  items.className = 'staff-dock-items';
  const knob = document.createElement('div');
  knob.className = 'staff-dock-knob';
  knob.setAttribute('aria-hidden','true');
  const wheel = document.createElement('div');
  wheel.className = 'staff-dock-wheel';
  const face = document.createElement('div');
  face.className = 'staff-dock-face';
  const glyphs = document.createElement('div');
  glyphs.className = 'staff-dock-knob-glyphs';
  face.append(glyphs);
  wheel.append(face);
  knob.append(wheel);

  function pictureFor(icon) {
    const picture = svg({viewBox:'0 0 24 24', fill:'none', stroke:'currentColor',
      'stroke-width':1.75, 'stroke-linecap':'round','stroke-linejoin':'round'});
    picture.innerHTML = icons[icon];
    return picture;
  }
  const menu = document.createElement('div');
  menu.className = 'staff-dock-menu';
  menu.id = nav.id + '-menu';
  menu.hidden = true;
  nav.replaceChildren(surface,items,knob,menu);
  nav.classList.add('staff-dock');
  document.body.classList.add('has-staff-dock');

  let menuTrigger;
  let selectedAt = 0;
  function closeMenu(restore = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuTrigger.setAttribute('aria-expanded','false');
    if (restore) menuTrigger.focus();
  }

  const menuButtons = new Map();
  const buttons = tabs.map(({id,label,icon,center,select,children}, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'staff-dock-tab' + (center ? ' staff-dock-center' : '');
    button.style.setProperty('--dock-order',index);
    const picture = pictureFor(icon);
    const iconWrap = document.createElement('span');
    iconWrap.className = 'staff-dock-symbol';
    iconWrap.append(picture);
    const badge = document.createElement('i');
    badge.className = 'staff-dock-badge';
    badge.setAttribute('aria-hidden','true');
    badge.hidden = true;
    iconWrap.append(badge);
    const text = document.createElement('span');
    text.className = 'staff-dock-label';
    text.textContent = label;
    button.append(iconWrap,text);
    if (children) {
      menuTrigger = button;
      button.setAttribute('aria-expanded','false');
      button.setAttribute('aria-controls',menu.id);
      for (const item of children) {
        const option = document.createElement('button');
        option.type = 'button';
        option.textContent = item.label;
        option.onclick = () => {
          selectedAt = performance.now();
          closeMenu(true);
          item.select();
        };
        menuButtons.set(item.id,option);
        menu.append(option);
      }
    }
    button.onclick = () => {
      selectedAt = performance.now();
      if (children) {
        const opening = menu.hidden;
        closeMenu();
        if (opening) {
          menu.hidden = false;
          button.setAttribute('aria-expanded','true');
        }
        return;
      }
      closeMenu();
      if (button.hasAttribute('aria-current')) {
        wheel.classList.remove('staff-dock-pressed');
        void wheel.offsetWidth;
        wheel.classList.add('staff-dock-pressed');
      }
      select();
    };
    items.append(button);
    return {id,button,badge,label,children,icon};
  });

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0;
  let knobDiameter = 48;
  let centers = [];
  let x = 0;
  let rotation = 0;
  let velocity = 0;
  let frame = 0;
  let selectedIndex = -1;
  let displayedIcon;

  function drawSurface(center) {
    // Keep both end caps fixed. Ease the crest down near an end instead of
    // squeezing the corner into a sharp shoulder as the indicator passes it.
    const corner = 30;
    const leftShoulder = Math.min(54, Math.max(0, center - corner));
    const rightShoulder = Math.min(54, Math.max(0, width - center - corner));
    const room = Math.min(leftShoulder, rightShoulder);
    const t = Math.min(1, room / 38);
    const crest = 14 - 12 * t * t * (3 - 2 * t);
    const round = value => Number(value.toFixed(2));
    path.setAttribute('d', [
      'M30 14 H' + round(center - leftShoulder),
      'C' + round(center - leftShoulder * .5) + ' 14 ' + round(center - leftShoulder * .5) + ' ' + round(crest) + ' ' + round(center) + ' ' + round(crest),
      'C' + round(center + rightShoulder * .5) + ' ' + round(crest) + ' ' + round(center + rightShoulder * .5) + ' 14 ' + round(center + rightShoulder) + ' 14',
      'H' + round(width - corner) + ' A30 30 0 0 1 ' + width + ' 44',
      'V60 A30 30 0 0 1 ' + (width - 30) + ' 90 H30 A30 30 0 0 1 0 60',
      'V44 A30 30 0 0 1 30 14 Z',
    ].join(' '));
  }

  function placeKnob(next, speed = 0, roll = true) {
    const position = Math.max(knobDiameter / 2, Math.min(width - knobDiameter / 2, next));
    if (roll) rotation += (position - x) / (Math.PI * knobDiameter) * 360;
    x = position;
    const stretch = motion.matches ? 0 : Math.min(1, Math.abs(speed) / 1400);
    knob.style.setProperty('--knob-x',x + 'px');
    knob.style.setProperty('--wheel-angle',rotation + 'deg');
    knob.style.setProperty('--wheel-counter-angle',-rotation + 'deg');
    knob.style.setProperty('--wheel-sx',1 + stretch * .04);
    knob.style.setProperty('--wheel-sy',1 - stretch * .035);
    drawSurface(x);
  }

  function swapIcon(icon, animate) {
    if (displayedIcon === icon) return;
    const next = pictureFor(icon);
    const previous = glyphs.lastElementChild;
    displayedIcon = icon;
    if (!animate || !previous) {
      glyphs.replaceChildren(next);
      return;
    }
    glyphs.replaceChildren(previous,next);
    previous.setAttribute('class','staff-dock-glyph-out');
    next.setAttribute('class','staff-dock-glyph-in');
  }

  function measureDock() {
    const rect = nav.getBoundingClientRect();
    if (!rect.width) return;
    width = rect.width;
    knobDiameter = parseFloat(getComputedStyle(nav).getPropertyValue('--dock-knob-size')) || 48;
    surface.setAttribute('viewBox', '0 0 ' + width + ' 90');
    centers = buttons.map(({button}) => {
      const bounds = button.getBoundingClientRect();
      return bounds.left - rect.left + bounds.width / 2;
    });
    cancelAnimationFrame(frame);
    velocity = 0;
    rotation = 0;
    if (selectedIndex >= 0) {
      placeKnob(centers[selectedIndex], 0, false);
      swapIcon(buttons[selectedIndex].icon, false);
    }
  }
  new ResizeObserver(measureDock).observe(nav);
  motion.addEventListener('change',measureDock);

  function moveKnob(index, initial) {
    if (!width || initial) {
      measureDock();
      return;
    }
    cancelAnimationFrame(frame);
    const target = centers[index];
    const icon = buttons[index].icon;
    const start = x;
    const distance = target - start;
    if (Math.abs(distance) < .5) {
      velocity = 0;
      placeKnob(target, 0, false);
      swapIcon(icon, true);
      return;
    }
    const started = performance.now();
    let last = started;
    function step(now) {
      const elapsed = now - started;
      let next;
      if (motion.matches) {
        const t = Math.min(1, elapsed / 150);
        next = start + distance * (1 - (1 - t) ** 3);
      } else {
        // Integrate the spring in small steps, keeping the same position for the wheel and SVG.
        let dt = Math.min(.032,(now - last)/1000);
        next = x;
        while (dt > 0) {
          const tick = Math.min(dt, 1 / 120);
          velocity += ((target - next) * 340 - velocity * 34) * tick;
          next += velocity * tick;
          dt -= tick;
        }
      }
      last = now;
      placeKnob(next, velocity, !motion.matches);
      if ((x - start) / distance >= .5) swapIcon(icon, true);
      const done = motion.matches ? elapsed >= 150 :
        (Math.abs(x - target) < .45 && Math.abs(velocity) < 9) || elapsed >= 520;
      if (!done) {
        frame = requestAnimationFrame(step);
        return;
      }
      velocity = 0;
      placeKnob(target, 0, !motion.matches);
      swapIcon(icon, true);
    }
    frame = requestAnimationFrame(step);
  }

  const mobile = matchMedia('(max-width: 850px)');
  let previous = Math.max(0,window.scrollY);
  let scrollDistance = 0;
  window.addEventListener('scroll', () => {
    const top = Math.max(0,window.scrollY);
    const delta = top - previous;
    previous = top;
    if (!mobile.matches || nav.hidden) return;
    if (Math.sign(scrollDistance) !== Math.sign(delta)) scrollDistance = 0;
    scrollDistance += delta;
    if (top < 32 || scrollDistance < -12 || performance.now() - selectedAt < 360) nav.classList.remove('staff-dock-away');
    else if (scrollDistance > 18 && menu.hidden && !nav.querySelector(':focus-visible')) {
      nav.classList.add('staff-dock-away');
    }
  }, {passive:true});
  nav.addEventListener('focusin',()=> nav.classList.remove('staff-dock-away'));
  document.addEventListener('pointerdown', event => { if (!nav.contains(event.target)) closeMenu(); });
  nav.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.stopPropagation();
      closeMenu(true);
    }
  });
  mobile.addEventListener('change',()=> {
    nav.classList.remove('staff-dock-away');
    if (!mobile.matches) closeMenu();
  });

  let active;
  return {
    setActive(id) {
      if (id === active) return;
      active = id;
      const index = buttons.findIndex(item => item.id === id || item.children?.some(child => child.id === id));
      const initial = selectedIndex < 0;
      selectedIndex = index;
      nav.classList.toggle('staff-dock-selected', index >= 0);
      buttons.forEach(({button}, position) => {
        if (position === index) button.setAttribute('aria-current','page');
        else button.removeAttribute('aria-current');
      });
      for (const [key,option] of menuButtons) {
        if (key === id) option.setAttribute('aria-current','page');
        else option.removeAttribute('aria-current');
      }
      if (index >= 0) moveKnob(index, initial);
      nav.classList.remove('staff-dock-away');
    },
    setBadge(id, count) {
      const item = buttons.find(button => button.id === id);
      if (!item) return;
      item.badge.hidden = !count;
      item.button.setAttribute('aria-label',count ? item.label + ', ' + count + ' new' : item.label);
    },
    setLabel(id, label) {
      const item = buttons.find(button => button.id === id);
      if (item) {
        item.label = label;
        item.button.querySelector('.staff-dock-label').textContent = label;
      }
    },
  };
};
