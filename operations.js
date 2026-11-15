import {addOfflineOrderFields, pickupMapUrl} from './admin-records.js';

import {buildLedger} from './admin-ledger.js?v=mobile-layout';
import {buildPricingForm} from './admin-pricing.js';

const portal = document.body.dataset.portal;
const statusLine = document.querySelector('#ops-status');
const content = document.querySelector('#ops-content');
let locationWatch;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

async function api(path, data) {
  const post = data !== undefined;
  const response = await fetch(path, {
    method: post ? 'POST' : 'GET',
    headers: {'Content-Type': 'application/json'},
    body: post ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function action(label, run) {
  const button = element('button', label);
  button.type = 'button';
  button.className = 'clay-button';
  button.onclick = async () => {
    button.disabled = true;
    statusLine.textContent = '';
    try { await run(); }
    catch (error) { statusLine.textContent = error.message; }
    finally { button.disabled = false; }
  };
  return button;
}

async function partnerOrders() {
  const {orders, available, earnings} = await api('/api/partner/orders');
  const cards = orders.map(order => {
    const card = element('article');
    card.className = 'clay-card';
    const path = '/api/partner/orders/' + order.id + '/';
    card.append(element('h2', order.order_number || 'PB-' + order.id.slice(0, 8).toUpperCase()));
    if (!order.partner) {
      card.append(action('Accept delivery', async () => { await api(path + 'accept', {}); await partnerOrders(); }));
    } else if (order.status === 'delivered') {
      card.append(element('p', 'Delivered'));
    } else {
      const map = element('a', 'Navigate to customer');
      const destination = order.address.match(/Delivery pin: (-?[\d.]+,\s*-?[\d.]+)/i)?.[1] || order.address;
      map.href = 'https://www.google.com/maps/dir/?' + new URLSearchParams({api: 1, destination});
      map.target = '_blank';
      map.rel = 'noopener noreferrer';
      const phone = element('a', 'Call customer');
      phone.href = 'tel:' + order.phone.replace(/[^+0-9]/g, '');
      card.append(element('p', order.address), map, element('p'), phone);
      if (order.notes) card.append(element('p', order.notes));
      const controls = element('div');
      controls.className = 'order-actions';
      if (order.status === 'packed') {
        controls.append(action('Confirm pickup', async () => { await api(path + 'pickup', {}); await partnerOrders(); }));
      } else {
        const label = element('label', 'Customer delivery code');
        const input = element('input');
        input.inputMode = 'numeric';
        input.maxLength = 4;
        input.className = 'clay-input';
        label.append(input);
        controls.append(label, action('Confirm delivery', async () => {
          if (!/^\d{4}$/.test(input.value)) throw new Error('Enter the four-digit code.');
          await api(path + 'deliver', {code: input.value});
          stopSharing();
          await partnerOrders();
        }), action('Share location', () => {
          if (!navigator.geolocation) throw new Error('Location is unavailable on this device.');
          stopSharing();
          let lastUpdate = 0;
          locationWatch = navigator.geolocation.watchPosition(({coords}) => {
            if (Date.now() - lastUpdate < 5000) return;
            lastUpdate = Date.now();
            api(path + 'location', {lat: coords.latitude, lng: coords.longitude})
              .catch(error => { statusLine.textContent = error.message; });
          }, () => { statusLine.textContent = 'Location permission is unavailable.'; }, {enableHighAccuracy: true});
          statusLine.textContent = 'Sharing location for this delivery.';
        }), action('Stop sharing', stopSharing));
      }
      card.append(controls);
    }
    return card;
  });
  const controls = [action('Refresh deliveries', partnerOrders),
    action(available ? 'Go offline' : 'Go online', async () => {
      await api('/api/partner/availability', {available: !available});
      await partnerOrders();
    })];
  const money = value => new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR'}).format(value / 100);
  content.replaceChildren(...controls, element('p', money(earnings.lifetime) + ' earned · ' +
    money(earnings.outstanding) + ' awaiting settlement'),
    ...(cards.length ? cards : [element('p', 'No deliveries available.')]));
}

function stopSharing() {
  if (locationWatch !== undefined) navigator.geolocation.clearWatch(locationWatch);
  locationWatch = undefined;
}

const money = new Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'}).format;
let liveOrders;
let adminRevision = 0;
let refreshingOrders = false;
let adminTimer;
let refreshLedger;
let staffDock;

function syncAdminSection() {
  const tab = location.hash.slice(1);
  const section = ['pricing','ledger'].includes(tab) ? tab : 'dashboard';
  content.dataset.section = section;
  staffDock?.setActive(tab === 'orders' ? tab : section);
  for (const link of document.querySelectorAll('#admin-sections a')) {
    if (link.hash === '#' + section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (section === 'ledger') refreshLedger?.();
  if (tab === 'orders') document.getElementById('orders')?.scrollIntoView();
}

function orderNumber(order) {
  return order.order_number || 'PB-' + order.id.slice(0, 8).toUpperCase();
}

function buildEditor(section, title, endpoint, addFields, savedMessage) {
  const editor = element('dialog');
  editor.className = 'clay-card admin-record-editor';
  const heading = element('h2', title);
  heading.id = endpoint.split('/').at(-1) + '-title';
  editor.setAttribute('aria-labelledby', heading.id);
  const form = element('form');
  const fields = element('fieldset');
  fields.className = 'admin-record-fields';
  let read = addFields(fields);
  const notice = element('p');
  notice.setAttribute('role', 'status');
  const close = action('Close', () => editor.close());
  const save = element('button', 'Save');
  save.type = 'submit';
  save.className = 'clay-button';
  const actions = element('div');
  actions.className = 'record-actions';
  actions.append(close, save);
  form.append(fields, notice, actions);
  editor.append(heading, form);
  editor.addEventListener('cancel', event => {
    if (save.disabled) event.preventDefault();
  });
  form.onsubmit = async event => {
    event.preventDefault();
    const data = read();
    fields.disabled = save.disabled = close.disabled = true;
    notice.textContent = 'Saving…';
    try {
      const result = await api(endpoint, data);
      editor.close();
      fields.replaceChildren();
      read = addFields(fields);
      notice.textContent = '';
      statusLine.textContent = savedMessage(result);
      try {
        await admin();
      } catch {
        statusLine.textContent += ' Refresh the dashboard to see the update.';
        return;
      }
      // The successful refresh rebuilt the form and its order IDs.
      content.querySelector('[data-editor="' + heading.id + '"]')?.focus();
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      fields.disabled = save.disabled = close.disabled = false;
    }
  };
  const open = action(title, () => editor.showModal());
  open.dataset.editor = heading.id;
  section.append(open, editor);
}

function buildWarehouses(records) {
  const card = element('section');
  card.className = 'clay-card warehouse-directory';
  card.append(element('h2', 'Warehouses'));
  buildEditor(card, 'Add warehouse', '/api/admin/warehouses', fields => {
    const textField = (title, type, length) => {
      const label = element('label', title);
      const input = element('input');
      Object.assign(input, {type, maxLength:length, required:true, className:'clay-input'});
      label.append(input);
      fields.append(label);
      return input;
    };
    const name = textField('Warehouse name', 'text', 70);
    const address = textField('Google Maps pickup address or coordinates', 'text', 500);
    const email = textField('Staff Google account email', 'email', 254);
    const pickup = element('label', 'Use for new order pickups');
    pickup.className = 'pickup-default';
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !records.length;
    pickup.prepend(checkbox);
    fields.append(pickup);
    return () => ({name:name.value, address:address.value, email:email.value, useForPickup:checkbox.checked});
  }, () => 'Warehouse saved.');
  const list = element('ul');
  for (const warehouse of records) {
    const row = element('li');
    const map = element('a', warehouse.address);
    map.href = pickupMapUrl(warehouse.address);
    map.target = '_blank';
    map.rel = 'noopener';
    row.append(element('strong', warehouse.name + (warehouse.is_default ? ' · Default pickup' : '')),
      element('span', warehouse.email), map);
    list.append(row);
  }
  if (records.length) card.append(list);
  return card;
}

function buildLiveOrders(section, data) {
  const search = element('input');
  search.type = 'search';
  search.className = 'clay-input';
  search.placeholder = 'Order number or customer';
  search.setAttribute('aria-label', 'Search live orders');
  const list = element('ul');
  let orders = [];
  let snapshot;
  const matching = () => {
    const query = search.value.trim().toLowerCase();
    return orders.filter(order => [orderNumber(order), order.customer || ''].some(value => value.toLowerCase().includes(query)));
  };
  function render() {
    list.replaceChildren();
    const results = matching();
    if (!results.length) list.append(element('li', search.value.trim() ? 'No matching orders.' : 'No orders yet.'));
    appendOrderRows(list, results);
  }
  search.addEventListener('input', render);
  const csv = action('Export recent orders CSV', () => {
    const rows = matching().map(order => [orderNumber(order), order.status, order.total]);
    const blob = new Blob([['Order,Status,Total (paise)', ...rows.map(row => row.join(','))].join('\r\n')],
      {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = 'printbee-orders.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const controls = element('div');
  controls.className = 'live-order-controls';
  controls.append(search, csv);
  section.append(element('h2', 'Orders'), controls);
  buildEditor(section, 'Add offline orders', '/api/admin/offline-orders', fields => {
    const read = addOfflineOrderFields(fields);
    return () => ({orders:read()});
  }, result => result.saved ? 'Offline orders saved.' : 'These orders are already saved.');
  section.append(list);
  function update(next) {
    const fingerprint = JSON.stringify(next);
    if (fingerprint === snapshot) return;
    if (list.contains(document.activeElement)) return;
    orders = next;
    snapshot = fingerprint;
    render();
  }
  update(data);
  return update;
}

function appendOrderRows(list, orders) {
  for (const order of orders) {
    const row = element('li');
    row.className = 'live-order-row';
    const details = element('div');
    details.className = 'live-order-details';
    details.append(element('strong', orderNumber(order)), element('span', money(order.total / 100)),
      element('span', [order.customer, order.product].filter(Boolean).join(' · ')),
      element('span', order.status.replaceAll('_', ' ')));
    row.append(details);
    if (order.status === 'out_for_delivery') row.append(action('Renew delivery code', async () => {
      await api('/api/admin/orders/' + order.id + '/renew-code', {});
      statusLine.textContent = 'The customer can refresh their order to see the new code.';
    }));
    if (order.status === 'paid' && !order.captured) row.append(action('Cancel order', async () => {
      if (!window.confirm('Cancel this unprinted order?')) return;
      await api('/api/admin/orders/' + order.id + '/cancel', {});
      await admin();
    }));
    if (order.captured && ['paid', 'refund_pending'].includes(order.status)) {
      row.append(action(order.status === 'paid' ? 'Refund order' : 'Reconcile refund', async () => {
        if (order.status === 'paid' && !window.confirm('Request a full refund and stop fulfilment?')) return;
        const result = await api('/api/admin/orders/' + order.id + '/refund', {});
        await admin();
        statusLine.textContent = 'Refund ' + result.state + '.';
      }));
    }
    list.append(row);
  }
}

async function admin() {
  const revision = ++adminRevision;
  const data = await api('/api/admin');
  if (revision !== adminRevision) return;
  const totals = element('section');
  totals.className = 'clay-card';
  const captured = element('p');
  const counts = element('ul');
  const daily = element('dl');
  daily.className = 'daily-overview';
  const revenue = element('dd');
  const todayOrders = element('dd');
  daily.append(element('dt', 'Today’s revenue'), revenue, element('dt', 'Today’s orders'), todayOrders);
  totals.append(element('h2', 'Order overview'), daily, captured, counts);
  const orders = element('section');
  orders.className = 'clay-card';
  orders.id = 'orders';
  const updateOrders = buildLiveOrders(orders, data.orders);
  let lastTotals;
  function updateOverview(next) {
    const signature = JSON.stringify([next.counts, next.captured, next.today]);
    if (signature === lastTotals) return;
    lastTotals = signature;
    revenue.textContent = money(next.today.revenue / 100);
    todayOrders.textContent = new Intl.NumberFormat('en-IN').format(next.today.orders);
    captured.textContent = money(next.captured / 100) + ' captured in Razorpay';
    counts.replaceChildren(...Object.entries(next.counts).map(([state, count]) =>
      element('li', state.replaceAll('_', ' ') + ' · ' + count)));
  }
  const update = next => { updateOverview(next); updateOrders(next.orders); };
  update(data);
  const pricing = element('section');
  pricing.className = 'clay-card pricing-panel';
  let pricingVersion = data.pricingVersion;
  pricing.append(element('h2', 'Pricing'), buildPricingForm(data.terms, async changes => {
    const result = await api('/api/admin/pricing', {version:pricingVersion, changes});
    pricingVersion = result.version;
    return 'Pricing version ' + result.version + ' published.';
  }));
  const audit = element('section');
  audit.className = 'clay-card';
  audit.append(element('h2', 'Activity'));
  const history = element('ul');
  for (const entry of data.audit) history.append(element('li', [
    new Date(entry.created * 1000).toLocaleString(), entry.actor, entry.action.replaceAll('_', ' '),
  ].join(' · ')));
  audit.append(history);
  const settlements = element('section');
  settlements.className = 'clay-card';
  settlements.append(element('h2', 'Partner settlements'));
  if (!data.payouts.length) settlements.append(element('p', 'No outstanding settlements.'));
  for (const payout of data.payouts) {
    const row = element('div');
    row.className = 'order-actions';
    const label = element('label', 'Transfer reference for ' + payout.partner);
    const reference = element('input');
    reference.maxLength = 100;
    reference.className = 'clay-input';
    label.append(reference);
    row.append(element('p', money(payout.amount / 100)), label, action('Record settlement', async () => {
      if (!reference.value.trim()) throw new Error('Enter the completed transfer reference.');
      await api('/api/admin/payouts/' + payout.order_id + '/record', {reference: reference.value});
      await admin();
    }));
    settlements.append(row);
  }
  const ledger = element('section');
  ledger.className = 'clay-card ledger-panel';
  ledger.append(element('h2','Ledger'));
  refreshLedger = buildLedger(ledger, (page, kind) => api('/api/admin/ledger?' + new URLSearchParams({page,kind})));
  content.replaceChildren(action('Refresh dashboard', admin), totals, orders, settlements, audit, buildWarehouses(data.warehouses), pricing, ledger);
  syncAdminSection();
  liveOrders = update;
}

async function refreshLiveOrders() {
  if (document.hidden || refreshingOrders || !liveOrders) return;
  const revision = adminRevision;
  const update = liveOrders;
  refreshingOrders = true;
  try {
    const data = await api('/api/admin');
    if (revision === adminRevision && update === liveOrders) update(data);
  } catch {
    // Keep the last successful view. The next poll or manual refresh can retry.
  } finally {
    refreshingOrders = false;
  }
}

async function startAdmin() {
  await admin();
  const navigation = document.querySelector('#admin-sections');
  navigation.hidden = false;
  const nav = document.getElementById('admin-staff-dock');
  const go = tab => () => {
    location.hash = tab;
    if (tab === 'orders') document.getElementById('orders')?.scrollIntoView();
    else scrollTo(0,0);
  };
  staffDock = window.createStaffDock(nav, [
    {id:'dashboard',label:'Home',icon:'home',select:go('dashboard')},
    {id:'orders',label:'Orders',icon:'orders',select:go('orders')},
    {id:'add',label:'Add',icon:'plus',center:true,select:() => {
      location.hash = 'orders';
      syncAdminSection();
      content.querySelector('[data-editor="offline-orders-title"]')?.click();
    }},
    {id:'ledger',label:'Ledger',icon:'ledger',select:go('ledger')},
    {id:'pricing',label:'Pricing',icon:'orders',select:go('pricing')},
  ]);
  nav.hidden = false;
  window.addEventListener('hashchange', syncAdminSection);
  syncAdminSection();
  adminTimer = setInterval(refreshLiveOrders, 10000);
}

if (portal === 'partner') connectPortal(portal, statusLine, partnerOrders, stopSharing);
else connectPortal(portal, statusLine, startAdmin, () => clearInterval(adminTimer));
