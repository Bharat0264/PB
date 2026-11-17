(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const view = byId('tracking-page');
  const route = location.pathname.match(/^\/orders\/([^/]+)\/?$/);
  const oldLink = location.hash.match(/^#track=([a-f0-9]{32})\.([a-f0-9]{64})$/);
  const placed = new URLSearchParams(location.search).get('placed');
  const orderId = route?.[1] || oldLink?.[1] || (/^[a-f0-9]{32}$/.test(placed || '') ? placed : '');
  const shared = Boolean(oldLink || location.hash.startsWith('#track='));
  const active = Boolean(route || shared || orderId);
  addEventListener('hashchange', () => {
    if (!shared && !location.hash.startsWith('#track=')) return;
    view.hidden = true;
    location.reload();
  });
  const states = {
    paid: ['Order placed', 'Payment received. Your files are in the print queue.'],
    printing: ['Printing', 'The warehouse is printing your order.'],
    packed: ['Packed & ready', 'Your order is packed and ready for pickup.'],
    out_for_delivery: ['Out for delivery', 'Your order is on its way.'],
    delivered: ['Delivered', 'Your order has arrived.'],
    pending: ['Awaiting payment', 'Check your payment before trying checkout again.'],
    cancelled: ['Cancelled', 'Contact PrintBee if you need help with this order.'],
    undeliverable: ['Delivery needs attention', 'Contact PrintBee to arrange the next step.'],
    refund_pending: ['Refund pending', 'Your refund is being processed.'],
    refunded: ['Refunded', 'Your refund has been processed.'],
    refund_failed: ['Refund needs assistance', 'Contact PrintBee for help with your refund.'],
    assigned: ['Helper assigned', 'Your delivery helper will collect your order.'],
  };
  const stages = ['paid', 'printing', 'packed', 'assigned', 'out_for_delivery', 'delivered'];
  const cancelled = ['cancelled', 'refunded', 'refund_pending', 'refund_failed'];
  const isActive = status => status !== 'delivered' && !cancelled.includes(status);
  const money = new Intl.NumberFormat('en-IN', {style:'currency',currency:'INR'});
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const binding = {glossy:'Glossy soft binding',blue:'Blue sheet binding',spiral:'Spiral binding',staple:'Staple binding'};
  const date = time => new Date(time * 1000).toLocaleString('en-IN', {dateStyle:'medium',timeStyle:'short'});
  const label = key => states[key]?.[0] || window.PrintBeeStatus?.label(key) || 'Status unavailable';
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function link(text, href) {
    const el = node('a', text, 'track-button');
    el.href = href;
    return el;
  }
  function button(text, run) {
    const el = node('button', text, 'track-button');
    el.type = 'button';
    el.addEventListener('click', run);
    return el;
  }
  function bee(className) {
    const el = node('img', '', className);
    el.src = '/printbee-header-bee.webp';
    el.width = el.height = 48;
    el.alt = '';
    return el;
  }
  function progress(target, keys, position) {
    target.replaceChildren(...keys.map((_, i) => {
      const cell = node('span', '', 'track-cell');
      if (i <= position) cell.dataset.filled = '';
      return cell;
    }));
  }
  const D = '#4a3b2a', H = '#f5b731', HL = '#ffd96a';
  const journeyIcons = [
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5 10h6l5 18h18l4-12H14" fill="none" stroke="${D}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><rect x="17" y="15" width="17" height="11" rx="3" fill="${HL}"/><circle cx="19" cy="37" r="3.2" fill="${D}"/><circle cx="32" cy="37" r="3.2" fill="${D}"/><circle cx="36" cy="14" r="8" fill="${H}"/><path d="m32 14 3 3 5-6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="15" y="6" width="18" height="8" rx="3" fill="none" stroke="${D}" stroke-width="3"/><rect x="5" y="14" width="38" height="20" rx="6" fill="${D}"/><rect x="13" y="26" width="22" height="15" rx="2" fill="${HL}"/><path d="M18 31h12M18 35h8" stroke="${H}" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="20" r="2" fill="${H}"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 6 41 14v20L24 43 7 34V14z" fill="${HL}"/><path d="M24 6 41 14 24 22 7 14z" fill="${H}"/><path d="M24 22v21L7 34V14z" fill="#f2c24a"/><path d="M17 10l17 8" stroke="#e59d12" stroke-width="5" stroke-linecap="round"/><ellipse cx="32" cy="30" rx="4" ry="5" fill="${D}"/><path d="M30 28h4M30 31h4" stroke="${H}" stroke-width="1.6"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M3 18h7M1 24h9M5 30h6" stroke="${H}" stroke-width="2.6" stroke-linecap="round"/><rect x="12" y="12" width="14" height="11" rx="3" fill="${H}"/><circle cx="19" cy="17" r="2.6" fill="${D}"/><path d="M14 27h18l4-9h4M30 18l3-6h4" fill="none" stroke="${D}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 27h20l1 7H16z" fill="${HL}"/><circle cx="16" cy="37" r="5" fill="${D}"/><circle cx="37" cy="37" r="5" fill="${D}"/><circle cx="16" cy="37" r="2" fill="#fff"/><circle cx="37" cy="37" r="2" fill="#fff"/></svg>`,
    `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 6 5 22h6v18h26V22h6z" fill="#fff4dc"/><path d="M24 4 3 22l3 3 18-15 18 15 3-3z" fill="${H}"/><rect x="20" y="26" width="9" height="14" rx="4" fill="${H}"/><circle cx="37" cy="36" r="8" fill="#2fb457"/><path d="m33 36 3 3 5-6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  ];
  const journeySteps = [['Order placed', ['paid']], ['Printing', ['printing']], ['Ready', ['packed', 'assigned']], ['On the way', ['out_for_delivery']], ['Delivered', ['delivered']]];
  const wave = 'M50 30' + [150, 250, 350, 450].map(x => ` C${x - 70} 2 ${x - 30} 2 ${x} 30`).join('');
  function orderJourney(status) {
    const at = journeySteps.findIndex(([, keys]) => keys.includes(status));
    if (at < 0) return null;
    const done = status === 'delivered';
    const list = node('ol', '', 'journey');
    list.setAttribute('aria-label', 'Order journey: ' + journeySteps[at][0]);
    list.style.setProperty('--progress', String(at / 4 * 100));
    list.insertAdjacentHTML('afterbegin', `<svg class="journey-wave" viewBox="0 0 500 40" preserveAspectRatio="none" aria-hidden="true"><path pathLength="100" d="${wave}" class="journey-track"/><path pathLength="100" d="${wave}" class="journey-fill"/></svg>`);
    journeySteps.forEach(([text], i) => {
      const step = node('li', '', 'journey-step');
      step.style.setProperty('--i', i);
      step.dataset.state = i < at ? 'done' : i === at ? (done ? 'final' : 'current') : 'todo';
      const tile = node('span', '', 'journey-tile');
      tile.innerHTML = journeyIcons[i];
      step.append(tile, node('span', '', 'journey-dot'), node('span', text, 'journey-label'));
      list.append(step);
    });
    return list;
  }
  function orderRow(order, number) {
    const row = node('li', '', 'track-list-row');
    row.dataset.status = order.status;
    row.dataset.group = isActive(order.status) ? 'active' : 'past';
    const content = node('div', '', 'track-list-content');
    const meta = [order.paidAt ? date(order.paidAt) : '',
      Number.isFinite(order.total) ? money.format(order.total / 100) : ''].filter(Boolean);
    const heading = node('div', '', 'track-list-meta');
    heading.append(node('strong', number, 'track-number'), node('span',label(order.status),'track-chip'));
    content.append(heading);
    if (meta.length) content.append(node('p', meta.join(' · ')));
    if (order.delivery?.etaMinutes > 0) content.append(node('p', 'About ' + order.delivery.etaMinutes + ' min'));
    const actions = node('div', '', 'order-actions');
    actions.append(link('Track', '/orders/' + encodeURIComponent(order.id)));
    row.append(content);
    const journey = orderJourney(order.status);
    if (journey) row.append(journey);
    row.append(actions);
    return row;
  }
  function emptyOrders() {
    const empty = node('li', '', 'orders-empty track-empty');
    empty.append(bee('track-empty-bee'), node('h2','Place your first print order'));
    return empty;
  }
  const filters = byId('order-filters');
  const filterMessage = node('p', 'No orders match this filter.', 'track-filter-empty');
  filterMessage.hidden = true;
  filters.after(filterMessage);
  function applyFilter() {
    const key = filters.querySelector('[aria-pressed="true"]').dataset.filter;
    const rows = [...document.querySelectorAll('.track-list-row')];
    for (const row of rows) {
      const matches = key === 'all' || (key === 'active' && row.dataset.group === 'active') ||
        (key === 'delivered' && row.dataset.status === 'delivered') ||
        (key === 'cancelled' && cancelled.includes(row.dataset.status));
      row.hidden = !matches;
    }
    for (const heading of document.querySelectorAll('.track-list-heading')) {
      heading.hidden = !rows.some(row => row.dataset.group === heading.dataset.group && !row.hidden);
    }
    filterMessage.hidden = !rows.length || rows.some(row => !row.hidden);
  }
  filters.addEventListener('click', event => {
    const next = event.target.closest('[data-filter]');
    if (!next) return;
    filters.querySelectorAll('button').forEach(el => el.setAttribute('aria-pressed', String(el === next)));
    applyFilter();
  });

  if (active) {
    document.body.classList.add('tracking-route');
    byId('orders').hidden = true;
    view.hidden = false;
    document.title = 'Track order · PrintBee';
  }
  const feedback = byId('tracking-feedback');
  const main = byId('tracking-body');
  const livePanel = byId('tracking-live');
  const openDelivery = byId('tracking-open-delivery');
  const sheet = byId('tracking-delivery-sheet');
  const compact = matchMedia('(max-width: 680px)');
  let lastView, updatedAt, lastStage, lastEvent, lastLive, lastReceipt, feed, reconnecting;
  let hiddenCode = false;
  const mascot = bee('track-bee');
  const map = node('div', '', 'track-map');
  let mapState, riderMarker, mapPosition, mapConfig, mapFrame, locationLink;
  openDelivery.onclick = () => {
    sheet.append(livePanel);
    livePanel.classList.remove('track-sheet-content');
    sheet.showModal();
  };
  sheet.addEventListener('close', () => {
    openDelivery.after(livePanel);
    livePanel.classList.toggle('track-sheet-content', !openDelivery.hidden);
    if (!openDelivery.hidden) openDelivery.focus();
  });
  compact.addEventListener('change', () => { if (!compact.matches && sheet.open) sheet.close(); });
  const sheetHeading = sheet.querySelector('.track-sheet-heading');
  let drag;
  sheetHeading.addEventListener('pointerdown', event => {
    if (!compact.matches || event.target.closest('button')) return;
    drag = event.clientY;
    sheetHeading.setPointerCapture(event.pointerId);
  });
  sheetHeading.addEventListener('pointerup', event => {
    if (drag !== undefined && event.clientY - drag > 55) sheet.close();
    drag = undefined;
  });
  sheetHeading.addEventListener('pointercancel', () => { drag = undefined; });
  function eventFor(events, key) {
    return events.find(event => event.to === key && event.from !== key);
  }
  function printIssue(data) {
    return data.status === 'printing' && (data.timeline || []).findLast(event =>
      ['print_failed','print_job_recovered','print_done','printed_manually','packed'].includes(event.event))?.event === 'print_failed';
  }
  function timelineOrder(data) {
    const events = data.timeline || [];
    const markers = Object.fromEntries(stages.map(key => [key,eventFor(events,key)]));
    markers.paid ||= data.summary?.paidAt ? {at:data.summary.paidAt} : null;
    markers.assigned = events.find(event => event.event === 'delivery_accepted');
    const current = data.status === 'packed' && data.delivery?.partner ? 'assigned' : data.status;
    const keys = stages.filter(key => key !== 'assigned' || markers.assigned || current === 'assigned');
    let position = keys.indexOf(current);
    if (position < 0) position = keys.findLastIndex(key => Boolean(markers[key]));
    return {markers,current,keys,position};
  }
  function renderJourney(data, plan) {
    const list = byId('tracking-steps');
    const old = mascot.isConnected ? mascot.getBoundingClientRect() : null;
    const moving = lastStage && lastStage !== plan.current;
    list.replaceChildren(...plan.keys.map((key, i) => {
      const step = node('li', '', 'track-step');
      const current = key === plan.current;
      if (current) step.setAttribute('aria-current', 'step');
      step.dataset.phase = current ? 'current' : i <= plan.position ? 'complete' : 'upcoming';
      const hex = node('span', step.dataset.phase === 'complete' ? '✓' : '', 'track-step-hex');
      hex.setAttribute('aria-hidden','true');
      const title = key === 'assigned' && data.summary?.deliveryType === 'campus' ? 'Campus helper assigned' : label(key);
      const detail = node('div');
      detail.append(node('strong', title));
      if (plan.markers[key]?.at) {
        const time = node('time', date(plan.markers[key].at));
        time.dateTime = new Date(plan.markers[key].at * 1000).toISOString();
        detail.append(time);
      }
      step.append(hex, detail);
      if (current) step.append(mascot);
      return step;
    }));
    progress(byId('tracking-progress'), plan.keys, plan.position);
    if (!moving || reduced.matches) return;
    if (old && mascot.isConnected) {
      const next = mascot.getBoundingClientRect();
      mascot.animate([{transform:'translate('+(old.left-next.left)+'px,'+(old.top-next.top)+'px)'},{transform:'none'}],
        {duration:400,easing:'cubic-bezier(.2,.75,.25,1)'});
    }
    byId('tracking-headline').animate([{opacity:.35},{opacity:1}],{duration:250});
    if (matchMedia('(pointer:coarse)').matches) navigator.vibrate?.(10);
  }
  function spec(item) {
    return [item.paper, typeof item.colour === 'boolean' ? (item.colour ? 'Colour' : 'Black & white') : '',
      typeof item.duplex === 'boolean' ? (item.duplex ? 'Double-sided' : 'Single-sided') : '',
      item.orientation, binding[item.binding]].filter(Boolean);
  }
  function receipt(data) {
    const details = byId('tracking-summary');
    const summary = data.summary;
    details.hidden = !summary;
    if (!summary) return;
    const body = byId('tracking-receipt');
    body.replaceChildren();
    const files = node('ul', '', 'track-files');
    for (const item of summary.items || []) {
      const row = node('li');
      row.append(node('strong',item.name));
      const qty = Number.isFinite(item.pages) ? item.pages + (item.pages === 1 ? ' page' : ' pages') : '';
      row.append(node('p',[qty, item.copies > 1 ? '× ' + item.copies + ' copies' : '', ...spec(item),
        item.pageRange?.length ? 'Print pages '+item.pageRange.join(', ') : '',
        item.colourPages?.length ? 'Colour pages '+item.colourPages.join(', ') : ''].filter(Boolean).join(' · ')));
      files.append(row);
    }
    body.append(files);
    if (summary.address) {
      body.append(node('h3','Delivery address'), node('p',summary.address.split('\n')[0]));
    }
    if (summary.bill) {
      const fees = node('dl', '', 'track-fees');
      const fields = {printing:'Printing',binding:'Binding',packing:'Packing fee',platform:'Platform fee',delivery:'Delivery fee',surge:'Surge fee',tax:'Tax',discount:'Discount',total:'Total'};
      for (const [key, name] of Object.entries(fields)) {
        if (!Number.isFinite(summary.bill[key])) continue;
        fees.append(node('dt',name),node('dd',money.format(summary.bill[key] * (key === 'discount' ? -1 : 1) / 100)));
      }
      body.append(fees);
    }
    const payment = summary.paidAt ? 'Payment confirmed' : '';
    if (payment) body.append(node('p',payment,'track-kicker'));
    if (data.trackingKey) body.append(link('Download invoice', '/api/orders/' + orderId + '/invoice'));
  }
  function updateMap(location) {
    mapPosition = location;
    if (locationLink) locationLink.href = 'https://www.google.com/maps/search/?'+new URLSearchParams({api:1,query:location.join(',')});
    if (!mapState) return;
    const to = {lat:location[0], lng:location[1]};
    if (!riderMarker?.position || reduced.matches) {
      if (riderMarker) riderMarker.position = to;
      mapState.setCenter(to);
      return;
    }
    cancelAnimationFrame(mapFrame);
    const start = riderMarker.position, began = performance.now();
    function frame(now) {
      const progress = Math.min(1, (now-began)/400);
      riderMarker.position = {lat:start.lat+(to.lat-start.lat)*progress,lng:start.lng+(to.lng-start.lng)*progress};
      if (progress < 1) mapFrame = requestAnimationFrame(frame);
    }
    mapFrame = requestAnimationFrame(frame);
  }
  async function openMap(button, address) {
    button.disabled = true;
    try {
      mapConfig ||= fetch('/api/checkout').then(response => response.ok ? response.json() : null);
      const config = (await mapConfig)?.maps;
      if (!config?.key || !config.id) throw new Error();
      const maps = await loadDeliveryMaps(config.key);
      const [{Map}, {AdvancedMarkerElement}] = await Promise.all([maps.importLibrary('maps'), maps.importLibrary('marker')]);
      if (!map.isConnected || !mapPosition) return;
      const center = {lat:mapPosition[0],lng:mapPosition[1]};
      map.hidden = false;
      mapState = new Map(map,{mapId:config.id,center,zoom:address?.deliveryType === 'campus' ? 17 : 15});
      riderMarker = new AdvancedMarkerElement({map:mapState,position:center,title:'Delivery helper',content:bee('track-map-bee')});
      const destination = address?.address?.match(/\nDelivery pin:\s*(-?[\d.]+),\s*(-?[\d.]+)\s*$/i);
      if (destination) {
        const point = {lat:Number(destination[1]),lng:Number(destination[2])};
        new AdvancedMarkerElement({map:mapState,position:point,title:'Delivery address'});
        const bounds = new maps.LatLngBounds();
        bounds.extend(center); bounds.extend(point);
        mapState.fitBounds(bounds, 32);
      }
      button.hidden = true;
    } catch {
      button.hidden = true;
      feedback.textContent = 'The embedded map is unavailable. Use the latest location link.';
    }
  }
  function renderLive(data, plan) {
    const campus = data.summary?.deliveryType === 'campus';
    const delivery = data.delivery;
    const needsHelp = printIssue(data);
    const signature = JSON.stringify([plan.current, delivery?.partner, delivery?.code, Boolean(delivery?.location),
      data.summary?.items, plan.markers.delivered?.at, reconnecting, needsHelp]);
    if (signature === lastLive) {
      if (delivery?.location && delivery.location.some((coordinate, i) => coordinate !== mapPosition?.[i])) updateMap(delivery.location);
      return;
    }
    lastLive = signature;
    locationLink = null;
    livePanel.replaceChildren();
    livePanel.hidden = true;
    if (needsHelp || ['undeliverable','refund_failed'].includes(plan.current)) {
      const attention = node('div','','track-paper track-ticket');
      attention.append(node('h2','Action needed'),
        node('p','Contact PrintBee for help with this order.'),
        button('Contact support', () => byId('tracking-help').click()));
      livePanel.append(attention);
    } else if (plan.current === 'printing') {
      const printing = node('div', '', 'track-paper track-printing');
      const printer = node('div', '', 'track-printer');
      printer.setAttribute('aria-hidden','true');
      printer.append(node('i'));
      printing.append(printer,node('h2','Printing in progress'));
      const specs = [...new Set((data.summary?.items || []).flatMap(spec))];
      const chips = node('div', '', 'track-specs');
      chips.append(...specs.map(text => node('span', text, 'track-chip')));
      if (specs.length) printing.append(chips);
      livePanel.append(printing);
    }
    if (plan.current === 'delivered') {
      const ticket = node('div', '', 'track-paper track-ticket is-delivered');
      ticket.append(node('strong','Delivered','track-stamp'));
      const time = plan.markers.delivered?.at;
      if (time) ticket.append(node('p',date(time)));
      if (lastStage && lastStage !== 'delivered' && !reduced.matches) {
        const burst = node('div', '', 'track-burst');
        burst.setAttribute('aria-hidden', 'true');
        for (const [x,y] of [[-44,-22],[-23,-41],[11,-45],[37,-29],[45,0],[-40,8]]) {
          const hex = node('i', '', 'track-cell');
          hex.setAttribute('data-filled','');
          hex.style.setProperty('--burst-x',x+'px');
          hex.style.setProperty('--burst-y',y+'px');
          burst.append(hex);
        }
        burst.addEventListener('animationend', () => burst.remove(), {once:true});
        ticket.append(burst);
      }
      livePanel.append(ticket);
    }
    if (delivery?.partner || plan.current === 'out_for_delivery') {
      const panel = node('div', '', 'track-paper track-helper');
      const name = delivery?.partner?.trim().split(/\s+/)[0];
      panel.append(bee('track-helper-bee'),node('h2',name || (plan.current === 'out_for_delivery' ? 'On the way' : 'Delivery helper')),
        node('p',campus ? 'Campus helper' : (name ? 'Delivery helper' : 'Your order is on its way.')));
      if (delivery?.location) {
        const pin = locationLink = link('Open latest location', '#');
        pin.target = '_blank'; pin.rel = 'noopener noreferrer';
        map.hidden = !mapState;
        updateMap(delivery.location);
        if (!mapState) panel.append(button('Show live map', event => openMap(event.currentTarget, data.summary)));
        panel.append(pin, map);
      } else {
        mapState = riderMarker = mapPosition = null;
        map.replaceChildren();
      }
      livePanel.append(panel);
    }
    if (delivery?.partner && !shared) {
      const ticket = node('div', '', 'track-paper track-ticket');
      ticket.append(node('h2','Delivery code'));
      if (delivery.code && !reconnecting) {
        const digits = node('p',hiddenCode ? '••••' : delivery.code,'track-digits');
        const toggle = button(hiddenCode ? 'Show code' : 'Hide code', () => {
          hiddenCode = !hiddenCode;
          digits.textContent = hiddenCode ? '••••' : delivery.code;
          toggle.textContent = hiddenCode ? 'Show code' : 'Hide code';
          toggle.setAttribute('aria-pressed',String(hiddenCode));
        });
        toggle.setAttribute('aria-pressed',String(hiddenCode));
        ticket.append(digits,node('p','Share this code only with your delivery helper.'),toggle);
      } else {
        ticket.append(node('p',reconnecting ? 'Reconnect to view your current code.' : 'Available when your helper is on the way.'));
      }
      livePanel.append(ticket);
    }
    livePanel.hidden = !livePanel.childElementCount;
    const hasDelivery = Boolean(delivery?.partner || plan.current === 'out_for_delivery');
    openDelivery.hidden = !hasDelivery;
    openDelivery.textContent = delivery?.code && !reconnecting ? 'View delivery code' : 'Delivery details';
    if (!hasDelivery && sheet.open) sheet.close();
    livePanel.classList.toggle('track-sheet-content', hasDelivery && !sheet.open);
  }
  function render(data) {
    const plan = timelineOrder(data);
    const number = data.number || 'Track order';
    byId('tracking-number').textContent = number;
    if (data.number) document.title = number+' · Track order · PrintBee';
    byId('tracking-copy').hidden = !data.number;
    byId('tracking-share').hidden = !data.trackingKey || shared;
    byId('tracking-type').textContent = data.summary?.deliveryType === 'campus' ? 'On campus' : 'Outside campus';
    byId('tracking-type').hidden = !data.summary;
    const headline = byId('tracking-headline');
    const latest = data.timeline?.at(-1);
    const reprint = printIssue(data);
    const stage = reprint ? 'Printing needs attention' : label(plan.current);
    byId('tracking-stage').textContent = stage;
    const pages = data.summary?.items?.reduce((total,item) => total + item.pages*item.copies,0);
    const headlineText = reprint ? 'We’re checking a print issue' :
      plan.current === 'printing' && pages > 0 ? 'Printing your '+pages+(pages === 1 ? ' page' : ' pages') :
      plan.current === 'assigned' && data.summary?.deliveryType === 'campus' ? 'Your campus helper is assigned' : stage;
    if (headline.textContent !== headlineText) headline.textContent = headlineText;
    const description = reprint ? 'Contact PrintBee if you need an update.' : states[plan.current]?.[1] || '';
    const placed = plan.markers.paid?.at;
    const files = data.summary?.items?.length;
    const paidDetails = plan.current === 'paid' ? [files ? files+' '+(files === 1 ? 'file' : 'files') : '', pages > 0 ? pages+' '+(pages === 1 ? 'page' : 'pages') : '', placed ? date(placed) : ''] : [];
    byId('tracking-description').textContent = [description, ...paidDetails].filter(Boolean).join(' · ');
    const eta = data.delivery?.etaMinutes;
    byId('tracking-eta').hidden = !(Number.isFinite(eta) && eta > 0);
    if (eta > 0) byId('tracking-eta').textContent = 'About '+eta+' min';
    const receiptSignature = JSON.stringify(data.summary);
    if (lastReceipt !== receiptSignature) {
      lastReceipt = receiptSignature;
      receipt(data);
    }
    const journeySignature = JSON.stringify([plan.current, plan.keys, plan.markers]);
    if (journeySignature !== lastView) {
      lastView = journeySignature;
      renderJourney(data,plan);
    }
    if (lastStage && (lastStage !== plan.current || lastEvent !== latest?.id)) {
      if (latest?.event === 'delivery_reassigned') feedback.textContent = 'Your delivery helper changed.';
      else if (lastStage !== plan.current) feedback.textContent = plan.current === 'out_for_delivery' && data.delivery?.code
        ? 'Your order is on its way. Keep your delivery code ready.' : stage;
    }
    renderLive(data,plan);
    lastStage = plan.current;
    lastEvent = latest?.id;
  }
  function error(text) {
    byId('tracking-skeleton').hidden = true;
    main.hidden = true;
    feedback.textContent = text;
  }
  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      feedback.textContent = message;
    } catch {
      feedback.textContent = 'Could not copy. Try again.';
    }
  }
  async function start(localKey) {
    if (!/^[a-f0-9]{32}$/.test(orderId) || (shared && (!oldLink || oldLink[1] !== orderId))) {
      error('This order is unavailable. Check the link or return to Your orders.');
      return;
    }
    const summary = byId('tracking-summary');
    summary.open = !matchMedia('(max-width: 680px)').matches;
    const headers = new Headers();
    if (shared) headers.set('X-Tracking-Key',oldLink[2]);
    else {
      const key = await localKey(orderId).catch(() => null);
      if (key) headers.set('X-Order-Key',key);
    }
    let order, inFlight = false, unavailable = false, paused = false;
    byId('tracking-copy').onclick = () => copy(order.number,'Order number copied.');
    byId('tracking-share').onclick = () => {
      const url = new URL('/orders/'+orderId,location.origin);
      url.hash = 'track='+orderId+'.'+order.trackingKey;
      copy(url.href,'Tracking link copied.');
    };
    byId('tracking-help').onclick = () => {
      byId('tracking-help-order').textContent = order.number || '';
      byId('tracking-contact').href = 'https://wa.me/919347541419?' + new URLSearchParams({text:'I need help with my PrintBee order'+(order.number ? ' '+order.number : '')+'.'});
      byId('tracking-help-sheet').showModal();
    };
    const banner = byId('tracking-offline');
    function showConnection(offline) {
      reconnecting = offline;
      banner.hidden = !offline;
      if (offline) {
        const minutes = Math.floor((Date.now()-updatedAt)/60000);
        banner.textContent = 'Reconnecting…'+ (order ? (minutes > 0 ? ' Updated '+minutes+' min ago.' : ' Updated just now.') : ' Waiting for order status.');
      }
    }
    async function refresh() {
      if (inFlight || unavailable || paused || document.hidden) return;
      inFlight = true;
      try {
        const response = await fetch('/api/orders/'+orderId,{headers,cache:'no-store'});
        if ([401,403,404].includes(response.status)) {
          unavailable = true;
          byId('tracking-copy').hidden = byId('tracking-share').hidden = true;
          livePanel.replaceChildren();
          if (sheet.open) sheet.close();
          byId('tracking-receipt').replaceChildren();
          byId('tracking-number').textContent = 'Track order';
          showConnection(false);
          error('This order is unavailable. Check the link or sign in to view your orders.');
          return;
        }
        if (!response.ok) throw new Error();
        order = await response.json();
        if (shared) order = {number:order.number,status:order.status};
        updatedAt = Date.now();
        showConnection(false);
        byId('tracking-skeleton').hidden = true;
        main.hidden = false;
        render(order);
        if (order.trackingKey && !shared && !feed && window.PrintBeeLive) {
          feed = window.PrintBeeLive.start({as:'customer',
            onEvent: event => { if (event.order === orderId) refresh(); },
            onSync: refresh});
        }
      } catch {
        showConnection(true);
        if (order) renderLive(order,timelineOrder(order));
      } finally {
        inFlight = false;
      }
    }
    let timer;
    function resume() {
      if (document.hidden || paused || unavailable) return;
      refresh();
      if (!timer) timer = setInterval(refresh,10000);
    }
    function stop() {
      clearInterval(timer);
      timer = undefined;
      feed?.stop();
      feed = undefined;
    }
    document.addEventListener('visibilitychange', () => document.hidden ? stop() : resume());
    addEventListener('offline', () => {
      showConnection(true);
      if (order) renderLive(order,timelineOrder(order));
    });
    addEventListener('online',resume);
    addEventListener('pagehide',() => { paused = true; stop(); });
    addEventListener('pageshow',() => { paused = false; resume(); });
    resume();
  }
  window.PrintBeeTracking = {active,start,isActive,orderRow,emptyOrders,applyFilter};
})();
