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
  const surface = svg({class:'staff-dock-surface', viewBox:'0 0 360 90', preserveAspectRatio:'none'});
  const path = document.createElementNS(ns,'path');
  path.setAttribute('d','M30 14H138C156 14 161 0 180 0S204 14 222 14H330Q360 14 360 44V60Q360 90 330 90H30Q0 90 0 60V44Q0 14 30 14Z');
  surface.append(path);
  const dot = document.createElement('i');
  dot.className = 'staff-dock-dot';
  dot.setAttribute('aria-hidden','true');
  const items = document.createElement('div');
  items.className = 'staff-dock-items';
  const menu = document.createElement('div');
  menu.className = 'staff-dock-menu';
  menu.id = nav.id + '-menu';
  menu.hidden = true;
  nav.replaceChildren(surface,dot,items,menu);
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
    const picture = svg({viewBox:'0 0 24 24', fill:'none', stroke:'currentColor',
      'stroke-width':1.75, 'stroke-linecap':'round','stroke-linejoin':'round'});
    picture.innerHTML = icons[icon];
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
      if (center) {
        iconWrap.classList.remove('staff-dock-pressed');
        void iconWrap.offsetWidth;
        iconWrap.classList.add('staff-dock-pressed');
      }
      select();
    };
    items.append(button);
    return {id,button,badge,label,children};
  });

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
      nav.style.setProperty('--dock-active',index);
      nav.classList.toggle('staff-dock-has-active',index >= 0);
      buttons.forEach(({button}, position) => {
        if (position === index) button.setAttribute('aria-current','page');
        else button.removeAttribute('aria-current');
      });
      for (const [key,option] of menuButtons) {
        if (key === id) option.setAttribute('aria-current','page');
        else option.removeAttribute('aria-current');
      }
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
