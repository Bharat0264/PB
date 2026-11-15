/* PrintBee Partner · "The Hive"
 * UI layer for /partner (Cockpit, Earnings, Profile). The data layer (API calls, polling, GPS,
 * sample mode, OTP rules, CSV export, sign-in) is unchanged from the previous portal.
 *
 * Sections: utils → icons/art → data layer → map (vector campus + hex demand + bee) →
 * components (slide, jar, comb, OTP, tickets, chart, badge, QR) → pages → shell (dock, sheet,
 * palette, Buzz, theme) → boot.
 */
'use strict';

/* ======================================================================= utils */
const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).get('preview') === '1';
const content = $('rider-content');
const status = $('ops-status');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const inr = new Intl.NumberFormat('en-IN', {maximumFractionDigits: 0});
const money = paise => '₹' + inr.format(Math.round((paise || 0) / 100));
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el[k] = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
function saved(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch {} }
// Haptics only after a real tap (browsers reject vibrate() before user activation).
const buzzVibrate = ms => { try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(ms); } catch {} };
const viewport = () => innerWidth >= 1280 ? 'desktop' : innerWidth >= 768 ? 'tablet' : 'mobile';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const HEX_CLIP = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)';

/* ================================================================ icons & art */
// Custom icon set: hex-leaning strokes, 24px grid.
const ICON = {
  Cockpit: '<path d="M12 2.8l7.8 4.5v9.4L12 21.2l-7.8-4.5V7.3z"/><path d="M12 7.5a3.2 3.2 0 0 1 3.2 3.2c0 2.3-3.2 5.3-3.2 5.3s-3.2-3-3.2-5.3A3.2 3.2 0 0 1 12 7.5z"/><circle cx="12" cy="10.7" r=".9" fill="currentColor"/>',
  Earnings: '<path d="M8 4h8M8.6 4v2.4C6 7.4 5 9.4 5 12v5.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V12c0-2.6-1-4.6-3.6-5.6V4"/><path d="M5.2 12.5c2.3 1.2 4.4-1 6.8 0s4.5-1.2 6.8 0"/>',
  Profile: '<rect x="4" y="3" width="16" height="18" rx="4"/><path d="M9.5 3v2h5V3"/><circle cx="12" cy="11" r="2.6"/><path d="M7.8 17.2c.8-1.8 2.3-2.7 4.2-2.7s3.4.9 4.2 2.7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/>',
  bell: '<path d="M18 9a6 6 0 0 0-12 0c0 6.5-2.5 7.5-2.5 8.5h17c0-1-2.5-2-2.5-8.5"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  nav: '<path d="M4 11l16-7-7 16-2-7z"/>',
  locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  flip: '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2"/><path d="M20 4v4h-4M4 20v-4h4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
};
const icon = (name, size = 24) => {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
  return span.firstElementChild;
};
// The PrintBee mascot, flat 2D, built to animate (wings are separate groups).
const BEE = (cls = '') => `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <g class="wing wing-l"><ellipse cx="26" cy="20" rx="9" ry="13" transform="rotate(-24 26 20)" fill="#FFFFFF" fill-opacity=".92" stroke="#D9C9A3" stroke-width="1.4"/></g>
  <g class="wing wing-r"><ellipse cx="37" cy="19" rx="8" ry="12" transform="rotate(20 37 19)" fill="#FFFFFF" fill-opacity=".85" stroke="#D9C9A3" stroke-width="1.4"/></g>
  <g class="bee-body">
    <path d="M12 38l-7 3 7 3z" fill="#2A2112"/>
    <ellipse cx="30" cy="38" rx="18" ry="13" fill="#F5C542"/>
    <path d="M22 26.5c-2 3.4-2 19.6 0 23M30 25c-2 4-2 22 0 26M38 26.5c-1.6 3.4-1.6 19.6 0 23" stroke="#2A2112" stroke-width="5" stroke-linecap="round"/>
    <ellipse cx="30" cy="38" rx="18" ry="13" fill="none" stroke="#B9831A" stroke-width="1.5"/>
    <circle cx="48" cy="33" r="10" fill="#F7CF54" stroke="#B9831A" stroke-width="1.5"/>
    <circle cx="51" cy="31" r="2.4" fill="#2A2112"/><circle cx="51.8" cy="30.2" r=".8" fill="#fff"/>
    <path d="M47 37.5c1.6 1.4 3.6 1.4 5.2 0" stroke="#2A2112" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M46 24c-1-4 1-7 4-8M50 24.5c1-3.6 3.6-5.6 6.6-5.2" stroke="#2A2112" stroke-width="1.6" stroke-linecap="round" fill="none"/>
    <circle cx="50" cy="16" r="1.8" fill="#2A2112"/><circle cx="56.6" cy="19.3" r="1.8" fill="#2A2112"/>
    <ellipse cx="25" cy="31" rx="6" ry="2.2" fill="#fff" fill-opacity=".35" transform="rotate(-12 25 31)"/>
  </g></svg>`;
const FLOWER = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 40c0 10 0 16-2 22" stroke="#5F8F4A" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M31 54c-6-1-10-5-11-9 5 0 9 3 11 9z" fill="#7DB35F"/>${[0, 72, 144, 216, 288].map(a => `<ellipse cx="32" cy="22" rx="8" ry="12" transform="rotate(${a} 32 34)" fill="#FFF6E2" stroke="#EAD9B5" stroke-width="1.2"/>`).join('')}<circle cx="32" cy="34" r="7" fill="#F5C542" stroke="#B9831A" stroke-width="1.4"/></svg>`;
const PIN = (fill, inner) => `<svg viewBox="0 0 44 52" aria-hidden="true"><path d="M22 51C12 39 4 31 4 21a18 18 0 0 1 36 0c0 10-8 18-18 30z" fill="${fill}" stroke="#2A2112" stroke-opacity=".2" stroke-width="1.5"/>${inner}</svg>`;
const HIVE_PIN = PIN('#F5C542', '<path d="M14 15h16M12 21h20M14 27h16" stroke="#8A5E0B" stroke-width="3" stroke-linecap="round"/><path d="M19 31h6" stroke="#2A2112" stroke-width="3" stroke-linecap="round"/>');
const FLOWER_PIN = PIN('#3E8E5A', '<circle cx="22" cy="21" r="5" fill="#F5C542"/>' + [0, 72, 144, 216, 288].map(a => `<ellipse cx="22" cy="13" rx="3.4" ry="5" transform="rotate(${a} 22 21)" fill="#fff"/>`).join(''));
const EMPTY_COMB = `<svg viewBox="0 0 120 96" aria-hidden="true">${[[30, 26], [60, 26], [90, 26], [45, 52], [75, 52], [60, 78]].map(([x, y], i) => `<path d="M${x} ${y - 16}l14 8v16l-14 8-14-8v-16z" fill="${i === 4 ? '#FBE08A' : 'none'}" stroke="#E2C88A" stroke-width="2.4" stroke-linejoin="round"/>`).join('')}</svg>`;
const SLEEPY = `<svg viewBox="0 0 120 96" aria-hidden="true"><g transform="translate(18 18) scale(1.2)">${BEE().replace(/<svg[^>]*>|<\/svg>/g, '')}</g><text x="88" y="24" font-weight="800" font-size="16" fill="#B9831A">z</text><text x="98" y="12" font-weight="800" font-size="12" fill="#B9831A">z</text></svg>`;

/* ================================================================ data layer */
const DAY = 86400000;
const seed = () => {
  const now = Date.now();
  const hist = (n, ago, to, payout, settled) => ({id: 'sample-' + n, order_number: 'PB-DEMO-' + n, status: 'delivered', partner: 'sample', payout, completedAt: now - ago, from: 'Print room', to, settled});
  return {
    available: false, step: 0, failures: 0, unlock: 0,
    earnings: {lifetime: 3700 + 4600 + 3900 + 5200 + 4100 + 3600 + 4800, outstanding: 3700},
    orders: [
      {id: 'sample-1', order_number: 'PB-DEMO-4101', status: 'packed', payout: 4200, summary: '0.6 km to pickup · 1.4 km to drop · 11 min · 2 packets', urgent: true, address: 'North Hostel reception, SRM campus', to: 'North Hostel', dest: 'hostel', customer: 'Sample customer', notes: 'Meet at reception.', km: 2.0, eta: 11, packets: 2},
      {id: 'sample-2', order_number: 'PB-DEMO-4102', status: 'packed', payout: 3800, summary: '0.9 km to pickup · 1.1 km to drop · 12 min · 1 packet', address: 'Engineering block, SRM campus', to: 'Engineering block', dest: 'engg', customer: 'Sample customer', km: 2.0, eta: 12, packets: 1},
      hist(4100, 35 * 60000, 'Library foyer', 3700, false),
      hist(4099, 2.4 * 3600000, 'North Hostel', 4600, true),
      hist(4098, 5.1 * 3600000, 'Tech Park, gate 2', 3900, true),
      hist(4096, 1.2 * DAY, 'Engineering block', 5200, true),
      hist(4094, 2.6 * DAY, 'Main gate kiosk', 4100, true),
      hist(4091, 4.3 * DAY, 'Library foyer', 3600, true),
      hist(4087, 6.2 * DAY, 'North Hostel', 4800, true),
    ],
  };
};
let state = {available: false, orders: [], earnings: {}};
const scene = demo ? new URLSearchParams(location.search).get('scene') : null;
if (demo) {
  state = seed();
  try { state = JSON.parse(saved('printbee-partner-hive')) || state; } catch {}
  // ?scene=active / ?scene=online: a fixed sample state for reviews and screenshots (not saved).
  if (scene) {
    state = seed(); state.available = true; state.shiftSince = Date.now() - 104 * 60000;
    if (scene === 'active') { Object.assign(state.orders[0], {partner: 'sample', status: 'out_for_delivery'}); state.step = 2; }
  }
}
let tab = ['Cockpit', 'Earnings', 'Profile'].find(name => name === new URLSearchParams(location.search).get('tab')) || 'Cockpit', completed, busy = false, reading, interval, localStep = 0;
let watch, lastSent = 0, point, sending = false, wakeLock, offerIds;
let shiftSince = demo ? state.shiftSince : null;
let notices = [], unread = 0;
const skipped = new Set();
let profile = {name: 'Aarav Kumar', vehicle: 'TN 19 AB 4821 · Electric scooter', payout: 'aarav@upi', language: 'English', alerts: true};
if (demo) { try { profile = {...profile, ...JSON.parse(saved('printbee-rider-profile'))}; } catch {} }
const goals = {day: 30000, week: 280000};

function notify(message, live = false) {
  status.textContent = '';
  requestAnimationFrame(() => { status.textContent = message; });
  notices = [{message, at: Date.now()}, ...notices.filter(item => item.message !== message)].slice(0, 12);
  unread++;
  updateBell();
  if (live) $('hive-live').textContent = message;
}
async function run(action, control) {
  if (busy) return;
  busy = true;
  if (control) control.disabled = true;
  try { await action(); }
  catch (error) { notify(error.message); }
  finally { busy = false; if (control) control.disabled = false; }
}
function orderNo(order) { return order.order_number || 'PB-' + order.id.slice(0, 8).toUpperCase(); }
function active() { return state.orders.find(o => o.partner && ['packed', 'out_for_delivery'].includes(o.status)); }
function offers() { return state.orders.filter(o => !o.partner && o.status === 'packed'); }
function delivered() { return state.orders.filter(o => o.status === 'delivered'); }
function persist() { if (demo && !scene) save('printbee-partner-hive', JSON.stringify(state)); }
function changed() { persist(); render(); }
async function request(path, data) {
  const response = await fetch(path, {method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: {'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Delivery service unavailable.');
  return body;
}
function orderAction(order, action, data = {}) { return request('/api/partner/orders/' + order.id + '/' + action, data); }
async function refresh() {
  if (reading) { await reading.catch(() => {}); if (!busy) return; }
  const snapshot = request('/api/partner/orders');
  reading = snapshot;
  try {
    const data = await snapshot;
    const old = active()?.id;
    const nextOffers = data.orders.filter(o => !o.partner && o.status === 'packed').map(o => o.id);
    if (offerIds && data.available && nextOffers.some(id => !offerIds.includes(id))) {
      notify('New delivery available.', true);
      buzzVibrate(70);
    }
    offerIds = nextOffers;
    const updated = JSON.stringify(state) !== JSON.stringify(data);
    if (!state.available && data.available) shiftSince = Date.now();
    if (!data.available) shiftSince = null;
    state = data;
    if (old && old !== active()?.id) {
      localStep = 0;
      stopLocation();
      if (!completed) notify('This delivery is no longer assigned to you. Contact PrintBee.');
    }
    if (state.available && active()?.status === 'out_for_delivery') startLocation();
    else stopLocation();
    $('network').hidden = true;
    if (updated || !content.dataset.ready) render();
  } catch (error) {
    $('network').hidden = false;
    if (!content.dataset.ready) content.replaceChildren(errorState(refresh));
    throw error;
  } finally { if (reading === snapshot) reading = null; }
}
function stopLocation() {
  if (watch !== undefined) navigator.geolocation.clearWatch(watch);
  watch = undefined; point = null; lastSent = 0;
  if (wakeLock && !wakeLock.released) wakeLock.release().catch(() => {});
  wakeLock = null;
}
async function keepAwake() {
  if (!demo && state.available && active()?.status === 'out_for_delivery' && navigator.wakeLock && !document.hidden && (!wakeLock || wakeLock.released)) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
}
async function sendLocation() {
  const order = active(), latest = point;
  if (!latest || !navigator.onLine || !state.available || order?.status !== 'out_for_delivery' || sending || Date.now() - lastSent < 5000) return;
  lastSent = Date.now(); sending = true;
  try { await orderAction(order, 'location', latest); if (point === latest) point = null; }
  catch { if (state.available && order.id === active()?.id) notify('Location update paused. Retrying when connected.'); }
  finally { sending = false; }
}
let gps = null;
function startLocation() {
  if (demo || watch !== undefined || !navigator.geolocation) return;
  watch = navigator.geolocation.watchPosition(({coords}) => {
    if (coords.accuracy > 100) return;
    point = {lat: coords.latitude, lng: coords.longitude}; gps = point; sendLocation();
  }, () => { notify('Allow location access to share your progress.'); }, {enableHighAccuracy: true, maximumAge: 5000, timeout: 15000});
  keepAwake();
}
async function toggleOnline() {
  const next = !state.available;
  if (demo) { state.available = next; shiftSince = next ? Date.now() : null; state.shiftSince = shiftSince; changed(); notify(next ? 'You’re online. Offers will buzz in.' : 'You’re offline. Rest well.'); return; }
  if (next) {
    if (!navigator.geolocation) throw new Error('Location is unavailable on this device.');
    await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
      () => reject(new Error('Allow location access before going online.')), {maximumAge: 15000, timeout: 12000}));
  }
  await request('/api/partner/availability', {available: next});
  await refresh();
}
function stepOf(order) {
  const s = demo ? state.step : localStep;
  return order.status === 'packed' ? (s === 1 ? 1 : 0) : (s === 3 ? 3 : 2);
}
function navigateUrl(order) {
  if (!order) return null;
  const destination = order.status === 'packed' ? 'SRM Institute of Science and Technology, Kattankulathur'
    : order.address?.match(/Delivery pin: (-?[\d.]+,\s*-?[\d.]+)/i)?.[1] || order.address || 'SRM Institute of Science and Technology';
  return 'https://www.google.com/maps/dir/?' + new URLSearchParams({api: 1, destination, travelmode: 'two-wheeler'});
}
const etaOf = order => order?.eta || Number(order?.summary?.match(/(\d+)\s*min/)?.[1]) || null;
function todayEarned() {
  if (!demo) return state.earnings.today ?? null;
  const since = new Date(); since.setHours(0, 0, 0, 0);
  return delivered().filter(o => (o.completedAt || 0) >= since.getTime()).reduce((sum, o) => sum + (o.payout || 0), 0);
}
function weekEarned() {
  if (!demo) return state.earnings.week ?? null;
  return delivered().filter(o => Date.now() - (o.completedAt || 0) < 7 * DAY).reduce((sum, o) => sum + (o.payout || 0), 0);
}
function exportDeliveries() {
  const csv = value => '"' + String(value).replace(/^[=+@\-]/, "'$&").replaceAll('"', '""') + '"';
  const rows = [['Order ID', 'From', 'To', 'Completed', 'Amount INR', 'Status'], ...ticketRows().map(o => [orderNo(o), o.from || 'Print room', o.to || o.address || '', o.completedAt ? new Date(o.completedAt).toISOString() : '', (o.payout || 0) / 100, settledOf(o) ? 'Settled' : 'Awaiting'])];
  const url = URL.createObjectURL(new Blob([rows.map(row => row.map(csv).join(',')).join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  const a = h('a', {href: url, download: 'printbee-deliveries.csv'}); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('Deliveries exported as CSV.');
}
const settledOf = o => demo ? Boolean(o.settled) : false;

/* ====================================================================== map */
// Illustrated SRM campus in metres (x east, y south); origin = PrintBee print room (the hive).
const ORIGIN = {lat: 12.8231, lng: 80.0444};
const M_PER_DEG = 111320;
const toMeters = ({lat, lng}) => ({x: (lng - ORIGIN.lng) * M_PER_DEG * Math.cos(ORIGIN.lat * Math.PI / 180), y: (ORIGIN.lat - lat) * M_PER_DEG});
const POI = {
  hive: {x: 0, y: 0, label: 'PrintBee hive'},
  hostel: {x: -430, y: -590, label: 'North Hostel'},
  engg: {x: 610, y: -230, label: 'Engineering block'},
  library: {x: 300, y: 300, label: 'Library'},
  gate: {x: -260, y: 700, label: 'Main gate'},
  tech: {x: 900, y: 520, label: 'Tech Park'},
  garden: {x: -110, y: 120, label: ''},
};
const ROUTES = {
  hostel: [[0, 0], [0, -230], [-260, -230], [-260, -560], [-430, -590]],
  engg: [[0, 0], [0, -230], [610, -230]],
  other: [[0, 0], [0, 360], [700, 360], [900, 520]],
};
const ROADS = [
  {w: 26, pts: [[-2200, 380], [-900, 370], [0, 360], [1100, 380], [2200, 400]]},
  {w: 22, pts: [[-260, -2200], [-260, -560], [-260, 360], [-240, 1400], [-200, 2200]]},
  {w: 14, pts: [[-260, -230], [0, -230], [610, -230], [980, -260], [1600, -300]]},
  {w: 14, pts: [[0, -760], [0, -230], [0, 360]]},
  {w: 12, pts: [[-260, -560], [-430, -590], [-900, -620], [-1700, -700]]},
  {w: 12, pts: [[610, -230], [700, 360], [740, 1100]]},
  {w: 10, pts: [[700, 360], [900, 520], [1300, 760]]},
  {w: 10, pts: [[-260, 700], [300, 700], [740, 700]]},
  {w: 10, pts: [[-900, -1500], [-260, -1000], [400, -1000], [1200, -1100]]},
  {w: 18, pts: [[-1500, 1300], [-240, 1400], [800, 1500], [2000, 1700]]},
];
const BLOCKS = [[-1900, -1450, -330, -680], [-200, -1450, 1100, -1080], [-200, -930, -60, -300], [70, -680, 560, -300], [680, -930, 1500, -320],
  [-1900, -540, -330, 290], [-190, -160, -70, 280], [80, -160, 560, 280], [780, -180, 1600, 300], [-1900, 450, -330, 1250],
  [-160, 440, 650, 620], [-160, 780, 650, 1300], [820, 640, 1700, 1300], [-1900, 1480, 1700, 2100], [1200, -1450, 2100, -1150]];
function rng(seedValue) { let s = seedValue >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function createMap(host) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const layer = cls => { const g = document.createElementNS(NS, 'g'); g.setAttribute('class', cls); svg.append(g); return g; };
  const base = layer('map-base'), hexLayer = layer('map-hexes'), routeLayer = layer('map-routes');
  const overlay = h('div', {class: 'map-overlay'});
  host.replaceChildren(svg, overlay);
  host.tabIndex = 0;
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'Delivery map. Use arrow keys to pan and plus or minus to zoom.');
  host.removeAttribute('aria-hidden');
  svg.setAttribute('aria-hidden', 'true');

  // --- base map (static, metres)
  const path = d => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); return p; };
  const add = (g, el, cls, attrs = {}) => { el.setAttribute('class', cls); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); g.append(el); return el; };
  add(base, document.createElementNS(NS, 'rect'), 'map-land', {x: -3000, y: -3000, width: 6000, height: 6000});
  const r = rng(7);
  for (const [x0, y0, x1, y1] of BLOCKS) {
    add(base, document.createElementNS(NS, 'rect'), 'map-block', {x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 26});
    // buildings: shelf-packed rectangles with a lighter roof
    for (let y = y0 + 24; y < y1 - 60; y += 70 + r() * 50) {
      for (let x = x0 + 24; x < x1 - 60;) {
        const w = 50 + r() * 110, hh = 40 + r() * 46;
        if (x + w > x1 - 24) break;
        if (r() > .28) {
          add(base, document.createElementNS(NS, 'rect'), 'map-bld', {x, y, width: w, height: hh, rx: 6});
          add(base, document.createElementNS(NS, 'rect'), 'map-bld-top', {x: x + 4, y: y + 4, width: w - 8, height: hh - 12, rx: 4});
        }
        x += w + 18 + r() * 30;
      }
    }
  }
  add(base, path('M-1450 640c180-90 420-40 520 90s20 330-210 360-460-60-470-210 30-160 160-240z'), 'map-water');
  add(base, path('M-120 60c60-50 170-40 200 20s-20 140-110 140-150-50-140-100 20-40 50-60z'), 'map-park');
  add(base, path('M240 160c120-40 260 0 280 70s-60 120-190 110-170-60-150-110 20-60 60-70z'), 'map-park');
  add(base, path('M-1700 -1350c200-60 520-30 560 100s-150 230-380 220-330-90-290-200 60-90 110-120z'), 'map-park');
  add(base, path('M1250 -900c150-40 330 10 340 110s-130 160-280 140-200-70-170-150z'), 'map-park');
  const line = pts => 'M' + pts.map(p => p.join(' ')).join('L');
  for (const road of ROADS) add(base, path(line(road.pts)), 'map-road-edge', {'stroke-width': road.w + 8});
  for (const road of ROADS) add(base, path(line(road.pts)), 'map-road', {'stroke-width': road.w});

  // --- H3-style demand hexes (pointy-top, 170 m circumradius)
  const R = 125, SQ3 = Math.sqrt(3);
  const hotspots = [[610, -230, 1, 330], [-430, -590, .85, 300], [300, 300, .7, 260], [900, 520, .55, 380], [-260, 700, .4, 260]];
  const hexes = [];
  let theme = null;
  for (let q = -13; q <= 13; q++) for (let rr = -12; rr <= 12; rr++) {
    const cx = R * SQ3 * (q + rr / 2), cy = R * 1.5 * rr;
    if (Math.abs(cx) > 1900 || Math.abs(cy) > 1700) continue;
    let d = 0;
    for (const [hx, hy, a, s] of hotspots) d += a * Math.exp(-((cx - hx) ** 2 + (cy - hy) ** 2) / (2 * s * s));
    d += (Math.sin(q * 12.9898 + rr * 78.233) * 43758.5453 % 1 + 1) % 1 * .12;
    d = clamp(d, 0, 1);
    const corners = Array.from({length: 6}, (_, i) => { const a = Math.PI / 180 * (60 * i - 30); return [cx + (R - 5) * Math.cos(a), cy + (R - 5) * Math.sin(a)]; });
    const el = add(hexLayer, path('M' + corners.map(c => c.join(' ')).join('L') + 'Z'), 'map-hex' + (d > .68 ? ' is-hot' : ''), {'vector-effect': 'non-scaling-stroke'});
    const zone = String.fromCharCode(77 + rr) + '-' + (q + 14);
    const hex = {q, r: rr, cx, cy, d, el, zone};
    el.addEventListener('click', event => { if (!moved) { event.stopPropagation(); selectHex(hex); } });
    hexes.push(hex);
  }
  function colourHexes() {
    const css = getComputedStyle(document.documentElement);
    const lo = css.getPropertyValue('--hex-low').split(',').map(Number), hi = css.getPropertyValue('--hex-high').split(',').map(Number);
    theme = document.documentElement.dataset.theme;
    for (const hex of hexes) {
      const t = hex.d;
      const c = lo.map((v, i) => Math.round(v + (hi[i] - v) * t));
      // Quiet cells nearly vanish; only real demand glows (gentler on the dark Moon map).
      const a = theme === 'moon' ? .02 + Math.pow(t, 2.2) * .42 : .03 + Math.pow(t, 1.8) * .55;
      hex.el.setAttribute('fill', `rgb(${c.join(',')})`);
      hex.el.style.setProperty('--a', a.toFixed(2));
      hex.el.setAttribute('fill-opacity', a.toFixed(2));
    }
  }
  colourHexes();

  // --- view: metres-per-pixel + top-left world position
  let W = 0, H = 0, view = {x: -800, y: -600, mpp: 2};
  const focusArea = () => {
    const mode = viewport();
    if (mode === 'desktop') {
      const left = 112 + 400 + 24, right = innerWidth - 32 - 380 - 24;
      return {x: (left + right) / 2, y: innerHeight * .48};
    }
    if (mode === 'tablet') return {x: innerWidth / 2, y: innerHeight * .26};
    const sheet = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-px')) || innerHeight * .4;
    return {x: innerWidth / 2, y: (innerHeight - sheet) / 2 + 30};
  };
  function apply() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${W * view.mpp} ${H * view.mpp}`);
    placeOverlay();
  }
  function resize() {
    W = host.clientWidth; H = host.clientHeight;
    apply();
  }
  function focus(p, mpp = view.mpp, animate = false) {
    const f = focusArea();
    const target = {x: p.x - f.x * mpp, y: p.y - f.y * mpp, mpp};
    if (!animate || reduced.matches) { view = target; apply(); return; }
    const from = {...view}, start = performance.now();
    const stepAnim = now => {
      const t = Math.min(1, (now - start) / 600), e = 1 - Math.pow(1 - t, 3);
      view = {x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, mpp: from.mpp + (target.mpp - from.mpp) * e};
      apply();
      if (t < 1) requestAnimationFrame(stepAnim);
    };
    requestAnimationFrame(stepAnim);
  }
  function zoomAt(factor, sx = focusArea().x, sy = focusArea().y) {
    const mpp = clamp(view.mpp * factor, .6, 6);
    const wx = view.x + sx * view.mpp, wy = view.y + sy * view.mpp;
    view = {x: wx - sx * mpp, y: wy - sy * mpp, mpp};
    apply();
  }
  const toScreen = p => ({x: (p.x - view.x) / view.mpp, y: (p.y - view.y) / view.mpp});

  // --- pointer pan / pinch / wheel / keys
  const pointers = new Map();
  let moved = false, last = null, pinch = null;
  host.addEventListener('pointerdown', e => {
    if (e.target.closest('.hex-pop, .map-pin')) return;
    host.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    moved = false; last = {x: e.clientX, y: e.clientY};
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  host.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(pinch / dist, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch = dist; moved = true; return;
    }
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; host.classList.add('is-dragging'); }
    if (moved) { view.x -= dx * view.mpp; view.y -= dy * view.mpp; apply(); }
    last = {x: e.clientX, y: e.clientY};
  });
  const end = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; host.classList.remove('is-dragging'); setTimeout(() => { moved = false; }, 0); };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.exp(e.deltaY * .0015), e.clientX - host.getBoundingClientRect().left, e.clientY - host.getBoundingClientRect().top); }, {passive: false});
  host.addEventListener('keydown', e => {
    const step = 60 * view.mpp;
    const keys = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]};
    if (keys[e.key]) { view.x += keys[e.key][0]; view.y += keys[e.key][1]; apply(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { zoomAt(.8); e.preventDefault(); }
    else if (e.key === '-') { zoomAt(1.25); e.preventDefault(); }
    else if (e.key === 'Escape') closePop();
  });
  host.addEventListener('click', e => { if (!moved && !e.target.closest('.hex-pop')) closePop(); });

  // --- overlay: labels, pins, bee, trail
  const labels = Object.entries(POI).filter(([, p]) => p.label && p !== POI.hive).map(([, p]) => {
    const el = h('span', {class: 'map-pin-label', style: {position: 'absolute', transform: 'translate(-50%,-50%)', bottom: 'auto', left: 0, top: 0, pointerEvents: 'none', opacity: '.92'}}, p.label);
    overlay.append(el); return {el, p};
  });
  const hivePin = h('div', {class: 'map-pin', html: HIVE_PIN, title: 'PrintBee hive (pickup)'});
  hivePin.append(h('span', {class: 'map-pin-label'}, 'Pickup · Print room'));
  const destPin = h('div', {class: 'map-pin', html: FLOWER_PIN, hidden: true});
  const destLabel = h('span', {class: 'map-pin-label'});
  destPin.append(destLabel);
  const flower = h('div', {class: 'map-pin', html: FLOWER, style: {transform: 'translate(-50%,-46%)'}});
  flower.firstElementChild.style.cssText = 'width:72px;height:72px';
  const trailDots = Array.from({length: 12}, () => h('i', {class: 'map-trail'}));
  const bee = h('div', {class: 'map-bee', html: BEE()});
  const zzz = h('div', {style: {position: 'absolute', left: '28px', top: '-30px'}}, h('span', {class: 'map-zzz'}, 'Z'), h('span', {class: 'map-zzz', style: {left: '10px', top: '-8px', position: 'absolute'}}, 'z'), h('span', {class: 'map-zzz', style: {left: '18px', top: '-16px', position: 'absolute'}}, 'z'));
  bee.append(zzz);
  overlay.append(flower, hivePin, destPin, ...trailDots, bee);
  let pop = null, selected = null;
  function selectHex(hex) {
    closePop();
    selected = hex; hex.el.classList.add('is-selected');
    const level = hex.d > .68 ? 'Hot' : hex.d > .45 ? 'Busy' : hex.d > .25 ? 'Steady' : 'Quiet';
    const perHour = Math.max(1, Math.round(1 + hex.d * 6));
    pop = h('div', {class: 'hex-pop', role: 'dialog', 'aria-label': 'Zone ' + hex.zone},
      h('h3', {}, 'Zone ' + hex.zone, h('span', {class: 'tag' + (level === 'Hot' ? ' tag-hot' : '')}, level)),
      h('dl', {}, h('dt', {}, 'Expected orders'), h('dd', {}, `~${perHour}/hr`), h('dt', {}, 'Expected earnings'), h('dd', {}, `${money(perHour * 4100)}/hr`),
        h('dt', {}, 'From the hive'), h('dd', {}, (Math.hypot(hex.cx, hex.cy) / 1000).toFixed(1) + ' km')),
      level === 'Hot' ? h('p', {class: 'bonus'}, 'Hot zone: +₹15 bonus per order') : null,
      h('button', {type: 'button', 'aria-label': 'Close zone details', onclick: closePop}, '✕'));
    host.append(pop);
    placeOverlay();
    pop.querySelector('button').focus({preventScroll: true});
  }
  function closePop() { pop?.remove(); pop = null; selected?.el.classList.remove('is-selected'); selected = null; }

  let beePos = {...POI.hive}, heading = 0, asleep = true, trail = [], route = null, dest = null;
  function placeOverlay() {
    const at = (el, p) => { const s = toScreen(p); el.style.left = s.x + 'px'; el.style.top = s.y + 'px'; };
    for (const {el, p} of labels) at(el, {x: p.x, y: p.y + 70});
    at(hivePin, POI.hive);
    at(flower, POI.garden);
    if (dest) at(destPin, dest);
    const b = toScreen(beePos);
    bee.style.transform = `translate(${b.x}px, ${b.y}px)`;
    bee.style.left = bee.style.top = '0';
    const flipX = Math.cos(heading) < 0;
    bee.firstElementChild.style.transform = `rotate(${flipX ? heading * 180 / Math.PI + 180 : heading * 180 / Math.PI}deg) scaleX(${flipX ? -1 : 1})`;
    trailDots.forEach((dot, i) => {
      const p = trail[trail.length - 1 - i];
      if (!p || asleep) { dot.style.opacity = '0'; return; }
      const s = toScreen(p); dot.style.left = s.x + 'px'; dot.style.top = s.y + 'px';
      dot.style.opacity = String((1 - i / trailDots.length) * .8);
      dot.style.transform = `scale(${1 - i / 18})`;
    });
    if (pop && selected) at(pop, {x: selected.cx, y: selected.cy - 60});
  }
  function setRoute(pts, destPoint, label) {
    routeLayer.replaceChildren();
    route = pts; dest = destPoint;
    destPin.hidden = !destPoint;
    if (label) destLabel.textContent = label;
    if (pts) {
      const d = line(pts);
      add(routeLayer, path(d), 'map-route-base', {'vector-effect': 'non-scaling-stroke'});
      add(routeLayer, path(d), 'map-route', {'vector-effect': 'non-scaling-stroke'});
    }
    placeOverlay();
  }
  function setBee(p, opts = {}) {
    if (opts.heading != null) heading = opts.heading;
    const prev = beePos;
    beePos = {x: p.x, y: p.y};
    if (opts.trail !== false && Math.hypot(prev.x - p.x, prev.y - p.y) > 4) {
      trail.push({...prev});
      if (trail.length > 24) trail.shift();
    }
    placeOverlay();
  }
  function setAsleep(value) {
    asleep = value;
    bee.classList.toggle('is-asleep', value);
    zzz.hidden = !value;
    flower.hidden = !value;
    if (value) { beePos = {x: POI.garden.x + 4, y: POI.garden.y - 10}; heading = 0; trail = []; }
    placeOverlay();
  }
  addEventListener('resize', resize);
  resize();
  focus(POI.hive, innerWidth < 768 ? 2.4 : 1.9);
  return {resize, focus, zoomAt, setRoute, setBee, setAsleep, colourHexes, closePop, get bee() { return beePos; }, get hexes() { return hexes; }, selectHex, get theme() { return theme; }};
}

/* Demo flight: the bee moves along routes in a time-lapse; live mode follows GPS. */
let map = null, flightRaf = 0, flight = {pts: null, t: 0, speed: 0};
function routeLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; }
function pointAt(pts, dist) {
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (dist <= seg) { const t = dist / seg; return {x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, heading: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0])}; }
    dist -= seg;
  }
  const n = pts.length - 1;
  return {x: pts[n][0], y: pts[n][1], heading: Math.atan2(pts[n][1] - pts[n - 1][1], pts[n][0] - pts[n - 1][0]), done: true};
}
function syncMap() {
  if (!map) return;
  const order = active();
  const offline = !state.available;
  map.setAsleep(offline && !order);
  cancelAnimationFrame(flightRaf);
  if (!order) map.setRoute(null, null);
  if (offline && !order) return;
  let mode = 'hover', pts = null;
  if (order) {
    const key = order.dest || 'other';
    const full = ROUTES[key] || ROUTES.other;
    const end = full[full.length - 1];
    map.setRoute(full, {x: end[0], y: end[1]}, order.to || 'Drop-off');
    const step = stepOf(order);
    if (step === 0) { mode = 'fly'; pts = [[map.bee.x, map.bee.y], [0, 0]]; }
    else if (step === 1) mode = 'hover-hive';
    else if (step === 2) { mode = 'fly'; pts = full; }
    else mode = 'hover-dest';
  }
  if (!demo) {
    // Live: follow the latest accurate GPS fix, otherwise rest at the hive.
    const p = gps ? toMeters(gps) : POI.hive;
    map.setBee(p, {trail: Boolean(gps)});
    return;
  }
  if (reduced.matches) {
    const p = pts ? pointAt(pts, Infinity) : mode === 'hover-dest' && order ? (() => { const e = (ROUTES[order.dest] || ROUTES.other).slice(-1)[0]; return {x: e[0], y: e[1]}; })() : POI.hive;
    map.setBee(p, {trail: false});
    return;
  }
  const centre = mode === 'hover-dest' ? (() => { const e = (ROUTES[order.dest] || ROUTES.other).slice(-1)[0]; return {x: e[0], y: e[1]}; })() : {x: 40, y: -60};
  let startT = performance.now(), dist = 0, lastT = startT;
  const loop = now => {
    const dt = Math.min(.05, (now - lastT) / 1000); lastT = now;
    if (mode === 'fly' && pts) {
      dist += dt * 70;
      const p = pointAt(pts, dist);
      map.setBee(p, {heading: p.heading});
      if (p.done) { mode = 'hover'; }
    } else {
      const t = (now - startT) / 1000, rad = mode === 'hover' ? 70 : 26;
      const x = centre.x + Math.cos(t * .6) * rad, y = centre.y + Math.sin(t * .6) * rad * .6;
      map.setBee({x, y}, {heading: Math.atan2(Math.cos(t * .6) * rad * .6, -Math.sin(t * .6) * rad)});
    }
    flightRaf = requestAnimationFrame(loop);
  };
  flightRaf = requestAnimationFrame(loop);
}

/* =============================================================== components */
// Slide-to-act: drag the thumb to the end (spring back if released early).
// Keyboard: Enter/Space confirms; arrows move. Screen readers get a plain button label.
function slideToAct({label, done = false, onConfirm, thumb = BEE(), ariaLabel}) {
  // p = progress toward confirming (0 → 1). A "done" slider starts at the right and confirms leftwards.
  const fill = h('div', {class: 'slide-fill'});
  const text = h('div', {class: 'slide-label'}, h('span', {}, label));
  const knob = h('button', {type: 'button', class: 'slide-thumb', html: thumb, 'aria-label': ariaLabel || label + '. Slide, or press Enter.'});
  const track = h('div', {class: 'slide' + (done ? ' is-on' : '')}, fill, text, knob);
  let p = 0, max = 0, startX = 0, startP = 0, dragging = false, ticked = false;
  const measure = () => { max = Math.max(1, track.clientWidth - knob.offsetWidth - 12); };
  const draw = () => {
    knob.style.setProperty('--x', (done ? max * (1 - p) : max * p) + 'px');
    track.style.setProperty('--p', done ? 1 - p : p);
  };
  const set = value => { measure(); p = clamp(value, 0, 1); draw(); };
  requestAnimationFrame(() => set(0));
  new ResizeObserver(() => { if (!dragging) set(p); }).observe(track);
  const confirm = () => {
    knob.classList.add('is-settling');
    set(1);
    track.classList.add('is-done');
    buzzVibrate(25);
    setTimeout(() => run(onConfirm, knob).finally(() => {
      if (knob.isConnected) { track.classList.remove('is-done'); set(0); }
    }), 220);
  };
  knob.addEventListener('pointerdown', e => {
    measure(); dragging = true; ticked = false; startX = e.clientX; startP = p;
    knob.classList.remove('is-settling'); knob.setPointerCapture(e.pointerId); e.preventDefault();
  });
  knob.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    set(startP + (done ? -dx : dx) / max);
    if (!ticked && p > .5) { ticked = true; buzzVibrate(8); }     // haptic tick at the halfway mark
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    if (p > .82) confirm();
    else { knob.classList.add('is-settling'); set(0); }            // spring back
  };
  knob.addEventListener('pointerup', release);
  knob.addEventListener('pointercancel', release);
  knob.addEventListener('click', e => { if (e.detail === 0) confirm(); });   // Enter / Space
  knob.addEventListener('keydown', e => {
    const forward = done ? 'ArrowLeft' : 'ArrowRight', back = done ? 'ArrowRight' : 'ArrowLeft';
    if (e.key !== forward && e.key !== back) return;
    e.preventDefault();
    knob.classList.add('is-settling');
    set(p + (e.key === forward ? .25 : -.25));
    if (p >= 1) confirm();
  });
  return track;
}

// Honey jar: SVG glass with a two-layer wave; the honey group translates up as it fills.
function honeyJar(value, goal, {big = false, label = 'Earned today'} = {}) {
  const pct = goal ? clamp(value / goal, 0, 1) : 0;
  const id = 'jar' + Math.random().toString(36).slice(2, 7);
  const wave = (y, amp) => { let d = `M-120 ${y}`; for (let x = -120; x <= 240; x += 30) d += ` Q${x + 15} ${y - amp} ${x + 30} ${y} T${x + 60} ${y}`; return d + ' V200 H-120Z'; };
  const jar = h('div', {class: 'jar', role: 'img', 'aria-label': `${label}: ${money(value)}, ${Math.round(pct * 100)}% of the ${money(goal)} goal`});
  jar.innerHTML = `<svg viewBox="0 0 120 140" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="M28 30h64c6 0 9 6 9 12v72c0 12-9 20-21 20H40c-12 0-21-8-21-20V42c0-6 3-12 9-12z"/></clipPath>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD866"/><stop offset="1" stop-color="#E39B1D"/></linearGradient></defs>
    <g clip-path="url(#${id})"><g class="honey" style="transform: translateY(${(1 - pct) * 104 + 2}px)">
      <path class="wave-b" d="${wave(28, 4)}" fill="#F5C542"/>
      <path class="wave-a" d="${wave(30, 5)}" fill="url(#${id}g)"/></g></g>
    <path class="glass" d="M28 30h64c6 0 9 6 9 12v72c0 12-9 20-21 20H40c-12 0-21-8-21-20V42c0-6 3-12 9-12z"/>
    <rect class="lid" x="24" y="14" width="72" height="18" rx="7"/><rect x="30" y="17" width="60" height="4" rx="2" fill="#fff" fill-opacity=".35"/>
    <path class="shine" d="M30 48c0-4 2-7 5-7v62c-3 0-5-3-5-6z"/>
    <path class="drip" d="M60 4c3 4 5 7 5 9a5 5 0 0 1-10 0c0-2 2-5 5-9z"/></svg>`;
  jar.append(h('span', {class: 'jar-amount num'}, money(value)));
  if (big) jar.style.cssText = '';
  return jar;
}
function comb(filled, total) {
  const wrap = h('div', {class: 'comb', role: 'img', 'aria-label': `${filled} of ${total} weekly goal cells filled`});
  for (let i = 0; i < total; i++) { const cell = h('i', {class: i < filled ? 'is-full' : ''}); cell.style.setProperty('--i', i); wrap.append(cell); }
  return wrap;
}
function countUp(el, to, fmt = v => inr.format(Math.round(v))) {
  if (reduced.matches) { el.textContent = fmt(to); return; }
  const start = performance.now(), dur = 900;
  const tick = now => { const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3); el.textContent = fmt(to * e); if (t < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
function burstHexes(x, y) {
  if (reduced.matches) return;
  const layer = h('div', {class: 'burst', 'aria-hidden': 'true'});
  const colours = ['#F5C542', '#FBE08A', '#E9A928', '#3E8E5A', '#FFFFFF', '#B9831A'];
  for (let i = 0; i < 34; i++) {
    const a = Math.random() * Math.PI * 2, d = 120 + Math.random() * 220;
    const piece = h('i');
    for (const [k, v] of Object.entries({'--x': x + 'px', '--y': y + 'px', '--dx': Math.cos(a) * d + 'px', '--dy': Math.sin(a) * d - 80 + 'px', '--r': (Math.random() * 540 - 270) + 'deg', '--s': (8 + Math.random() * 14) + 'px', '--c': colours[i % colours.length]})) piece.style.setProperty(k, v);
    layer.append(piece);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1300);
}
// OTP as four clay keys: auto-advance, paste, shake on wrong code.
function otpKeys(order) {
  const keys = h('div', {class: 'otp-keys', role: 'group', 'aria-label': 'Customer’s four-digit delivery code'});
  const error = h('p', {class: 'otp-error', role: 'alert'});
  const inputs = Array.from({length: 4}, (_, i) => {
    const input = h('input', {type: 'text', inputmode: 'numeric', autocomplete: i === 0 ? 'one-time-code' : 'off', maxlength: '1', 'aria-label': `Digit ${i + 1}`, pattern: '[0-9]'});
    const wrap = h('div', {class: 'otp-key'}, input);
    keys.append(wrap);
    return input;
  });
  const value = () => inputs.map(i => i.value).join('');
  const sync = () => inputs.forEach(i => i.parentElement.classList.toggle('is-filled', Boolean(i.value)));
  const cooldown = h('p', {class: 'otp-note'});
  function lockTick() {
    const seconds = demo ? Math.max(0, Math.ceil((state.unlock - Date.now()) / 1000)) : 0;
    cooldown.textContent = seconds ? `Too many attempts. Try again in ${seconds}s.` : demo ? 'Demo code: 4816' : 'Ask the customer for the code shown in their PrintBee app.';
    inputs.forEach(i => { i.disabled = Boolean(seconds); });
    if (seconds) setTimeout(() => { if (keys.isConnected) lockTick(); }, 1000);
  }
  async function submit() {
    const code = value();
    if (code.length < 4) return;
    await run(async () => {
      try {
        if (demo) {
          if (Date.now() < state.unlock) throw new Error('Wait before trying again.');
          if (code !== '4816') {
            state.failures++;
            if (state.failures >= 3) { state.failures = 0; state.unlock = Date.now() + 60000; }
            persist(); buzzVibrate([60, 40, 60]);
            throw new Error(state.unlock > Date.now() ? 'Too many attempts. Try again in 60 seconds.' : 'Wrong code. ' + (3 - state.failures) + ' tries left.');
          }
          order.status = 'delivered'; order.completedAt = Date.now(); order.from = 'Print room'; order.settled = false;
          state.earnings.lifetime += order.payout; state.earnings.outstanding += order.payout; state.step = 0;
          persist();
        } else {
          await orderAction(order, 'deliver', {code});
          stopLocation();
          state.orders = state.orders.map(item => item.id === order.id ? {...item, status: 'delivered'} : item);
          refresh().catch(() => {});
        }
        completed = order;
        const r = keys.getBoundingClientRect();
        burstHexes(r.left + r.width / 2, r.top + r.height / 2);
        buzzVibrate([20, 40, 20]);
        $('hive-live').textContent = 'Delivered! ' + money(order.payout) + ' earned.';
        dripNext = true;
        render();
      } catch (err) {
        error.textContent = err.message;
        keys.classList.remove('is-wrong'); void keys.offsetWidth; keys.classList.add('is-wrong');
        inputs.forEach(i => { i.value = ''; }); sync(); lockTick();
        if (!inputs[0].disabled) inputs[0].focus();
      }
    });
  }
  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '');
      if (digits.length > 1) { digits.slice(0, 4 - i).split('').forEach((d, k) => { inputs[i + k].value = d; }); }
      else input.value = digits;
      error.textContent = ''; keys.classList.remove('is-wrong'); sync();
      const next = inputs.find(x => !x.value);
      if (next) { if (input.value) next.focus(); } else submit();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i) { inputs[i - 1].value = ''; inputs[i - 1].focus(); sync(); e.preventDefault(); }
      if (e.key === 'ArrowLeft' && i) inputs[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 3) inputs[i + 1].focus();
    });
    input.addEventListener('paste', e => {
      const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 4);
      if (!digits) return;
      e.preventDefault(); digits.split('').forEach((d, k) => { inputs[k].value = d; }); sync();
      if (digits.length === 4) submit(); else inputs[digits.length].focus();
    });
  });
  lockTick();
  setTimeout(() => { if (keys.isConnected && !inputs[0].disabled && viewport() !== 'mobile') inputs[0].focus({preventScroll: true}); }, 350);
  return h('div', {class: 'otp'}, keys, error, cooldown);
}

/* ---- tiny QR encoder (byte mode, versions 1–3, error correction M, mask 0) ----
   Enough for the partner pickup code. Format/RS follow ISO/IEC 18004. */
const QR = (() => {
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
  function rs(data, ecLen) {
    let gen = [1];
    for (let i = 0; i < ecLen; i++) { const next = new Array(gen.length + 1).fill(0); gen.forEach((g, j) => { next[j] ^= g; next[j + 1] ^= mul(g, EXP[i]); }); gen = next; }
    const res = new Array(ecLen).fill(0);
    for (const byte of data) { const f = byte ^ res.shift(); res.push(0); gen.slice(1).forEach((g, j) => { res[j] ^= mul(g, f); }); }
    return res;
  }
  const SPEC = {1: [16, 10], 2: [28, 16], 3: [44, 26]};
  function encode(text) {
    const bytes = [...new TextEncoder().encode(text)];
    const version = [1, 2, 3].find(v => bytes.length + 2 <= SPEC[v][0]);
    if (!version) throw new Error('QR payload too long');
    const [dataLen, ecLen] = SPEC[version], size = 17 + 4 * version;
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, 8); bytes.forEach(b => put(b, 8));
    put(0, Math.min(4, dataLen * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xEC; data.length < dataLen; pad ^= 0xEC ^ 0x11) data.push(pad);
    const codewords = data.concat(rs(data, ecLen));
    const m = Array.from({length: size}, () => new Array(size).fill(false));
    const fn = Array.from({length: size}, () => new Array(size).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); }
      }
    }
    for (let i = 0; i < size; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
    if (version > 1) { const c = size - 7; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
    const format = mask => {
      const dataBits = (0 << 3) | mask;            // EC level M = 00
      let rem = dataBits;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((dataBits << 10) | rem) ^ 0x5412;
      const bit = i => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    format(0);
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) { m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
    format(0);
    return m;
  }
  function svg(text) {
    const m = encode(text), n = m.length, q = 4;
    let d = '';
    m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + q} ${y + q}h1v1h-1z`; }));
    return `<svg viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges" role="img" aria-label="Pickup QR code for ${text}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#2A2112"/></svg>`;
  }
  return {encode, svg, rs};
})();

/* ==================================================================== cells */
let dripNext = false, ticketFilter = 'All', period = 'Week';
function cell(title, ...kids) {
  const c = h('section', {class: 'cell'});
  if (title) c.append(h('div', {class: 'cell-head'}, h('h2', {}, h('span', {class: 'hexdot', 'aria-hidden': 'true'}), title)));
  c.append(...kids.flat().filter(Boolean));
  return c;
}
function statusCell() {
  const on = state.available;
  const time = h('span', {class: 'muted', 'data-shift-time': ''});
  const pill = h('span', {class: 'status-pill' + (on ? ' is-on' : '')}, on ? 'Online' : 'Offline');
  const c = h('section', {class: 'cell'},
    h('div', {class: 'status-row'}, h('div', {class: 'cockpit-greet'}, h('h1', {}, (on ? 'Fly safe, ' : 'Hi, ') + (demo ? profile.name.split(' ')[0] : 'partner')), time), pill),
    slideToAct({label: on ? 'Slide back to go offline' : 'Slide to go online', done: on, onConfirm: toggleOnline,
      ariaLabel: (on ? 'Go offline' : 'Go online') + '. Drag the bee, or press Enter.',
      thumb: on ? `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#2A2112" stroke-width="2" stroke-linecap="round"><path d="M12 4v8M7 7a7 7 0 1 0 10 0"/></svg>` : BEE()}));
  return c;
}
function jarCell() {
  const today = todayEarned();
  const value = today ?? state.earnings.outstanding ?? 0;
  const label = today == null ? 'Awaiting settlement' : 'Earned today';
  const jar = honeyJar(value, goals.day, {label});
  if (dripNext && !reduced.matches) { dripNext = false; requestAnimationFrame(() => { jar.classList.add('is-dripping'); }); }
  const pct = Math.round(clamp(value / goals.day, 0, 1) * 100);
  const week = weekEarned();
  const amount = h('span', {class: 'num big'});
  countUp(amount, value / 100, v => '₹' + inr.format(Math.round(v)));
  const bar = h('div', {class: 'goal-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Daily goal'}, h('i'));
  requestAnimationFrame(() => bar.firstChild.style.setProperty('--w', pct + '%'));
  const kids = [h('div', {class: 'jar-cell'}, jar, h('div', {class: 'jar-meta'},
    h('span', {class: 'muted'}, label), amount,
    h('span', {class: 'muted'}, h('b', {class: 'num'}, pct + '%'), ` of ${money(goals.day)} daily goal`), bar))];
  if (week != null) {
    const cells = 14, filled = Math.floor(clamp(week / goals.week, 0, 1) * cells);
    kids.push(h('div', {style: {display: 'grid', gap: '8px', marginTop: '20px'}}, h('div', {class: 'cell-head', style: {margin: 0}}, h('h3', {}, 'Weekly comb'), h('span', {class: 'muted num'}, `${money(week)} / ${money(goals.week)}`)), comb(filled, cells)));
  }
  return cell('Honey jar', ...kids);
}
function kpiCells() {
  const done = delivered();
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const todayCount = demo ? done.filter(o => (o.completedAt || 0) >= since.getTime()).length : done.length;
  const minutes = shiftSince ? Math.floor((Date.now() - shiftSince) / 60000) : 0;
  const items = [
    [demo ? 'Deliveries today' : 'Recent deliveries', todayCount, v => inr.format(Math.round(v)), demo ? '+1 vs yesterday' : ''],
    ['On shift', minutes, v => `${Math.floor(v / 60)}h ${Math.round(v) % 60}m`, state.available ? 'Live now' : 'Offline'],
    ['Rating', demo ? 4.9 : null, v => v.toFixed(1), demo ? 'Top 10% this week' : 'Not rated yet'],
    ['Acceptance', demo ? 96 : null, v => Math.round(v) + '%', demo ? 'Keep above 90%' : ''],
  ];
  return h('div', {class: 'kpis'}, items.map(([label, value, fmt, delta]) => {
    const v = h('span', {class: 'value num'}, value == null ? '—' : fmt(0));
    if (value != null) countUp(v, value, fmt);
    return h('div', {class: 'kpi'}, h('span', {class: 'label'}, label), v, delta ? h('span', {class: 'delta'}, delta) : null);
  }));
}
function offerCard(order) {
  const hot = order.urgent;
  const pay = h('span', {class: 'offer-pay num'}, money(order.payout));
  return h('article', {class: 'offer', 'aria-label': `${orderNo(order)}, ${money(order.payout)}`},
    h('div', {class: 'offer-top'}, h('div', {}, h('div', {class: 'offer-id'}, orderNo(order)), pay), hot ? h('span', {class: 'tag tag-hot'}, 'Hot zone +₹15') : null),
    h('div', {class: 'offer-route'}, h('i'), h('span', {}, 'Print room, PrintBee hive'), h('i', {class: 'to'}), h('span', {}, order.to || order.address || 'Customer')),
    h('div', {class: 'offer-meta'}, ...(order.summary || '').split(' · ').filter(Boolean).slice(1).map(t => h('span', {class: 'tag'}, t))),
    slideToAct({label: 'Slide to accept', ariaLabel: `Accept ${orderNo(order)} for ${money(order.payout)}. Drag, or press Enter.`,
      thumb: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#2A2112" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
      onConfirm: async () => {
        if (active()) throw new Error('Finish your current delivery first.');
        if (demo) { order.partner = 'sample'; state.step = 0; state.failures = 0; state.unlock = 0; changed(); }
        else { await orderAction(order, 'accept'); await refresh(); }
        notify('Delivery accepted. Head to the hive.', true);
      }}),
    demo ? h('button', {class: 'skip', type: 'button', onclick: () => { skipped.add(order.id); render(); notify('Offer skipped.'); }}, 'Skip this one') : null);
}
const STEPS = ['Pickup', 'In transit', 'Arrived', 'OTP'];
function stepper(step) {
  // Pickup (0–1) → In transit (2) → Arrived/OTP (3)
  const current = step <= 1 ? 0 : step === 2 ? 1 : 3;
  return h('ol', {class: 'stepper', 'aria-label': 'Delivery progress'}, STEPS.map((s, i) => h('li', {class: i < current ? 'is-done' : '', 'aria-current': i === current ? 'step' : null}, s)));
}
function activeCell(order) {
  const step = stepOf(order);
  const advance = next => { if (demo) state.step = next; else localStep = next; changed(); };
  const title = ['Fly to the hive', 'Collect the packets', 'Deliver to ' + (order.to || 'customer'), 'Verify the delivery code'][step];
  const body = [];
  if (step === 0) body.push(h('p', {class: 'active-meta'}, 'PrintBee print room, SRM campus'), slideToAct({label: 'Slide when you’ve arrived', onConfirm: () => advance(1), ariaLabel: 'I’ve arrived at the hive. Drag, or press Enter.'}));
  if (step === 1) {
    const checks = h('fieldset', {class: 'checks'}, h('legend', {}, 'Before you leave'),
      ...['Packet count matches', 'Labels match this order'].map(t => h('label', {}, h('input', {type: 'checkbox'}), t)));
    body.push(checks, slideToAct({label: 'Slide to confirm pickup', ariaLabel: 'Confirm pickup. Drag, or press Enter.', onConfirm: async () => {
      if (checks.querySelector('input:not(:checked)')) throw new Error('Check the packets and labels first.');
      if (demo) { order.status = 'out_for_delivery'; advance(2); }
      else { await orderAction(order, 'pickup'); localStep = 2; await refresh(); }
      notify('Pickup confirmed. Fly safe!');
    }}));
  }
  if (step === 2) {
    body.push(h('div', {class: 'active-meta'}, h('strong', {style: {color: 'var(--ink)'}}, order.customer || 'Customer'), h('span', {}, order.address || ''), order.notes ? h('span', {}, '“' + order.notes + '”') : null));
    if (!demo && order.phone) body.push(h('a', {class: 'hive-btn hive-btn-small', href: 'tel:' + order.phone.replace(/[^+0-9]/g, '')}, 'Call customer'));
    body.push(slideToAct({label: 'Slide when you’re with the customer', onConfirm: () => advance(3), ariaLabel: 'I’m with the customer. Drag, or press Enter.'}));
  }
  if (step === 3) body.push(otpKeys(order));
  return h('section', {class: 'cell active-cell'},
    h('div', {class: 'cell-head'}, h('h2', {}, h('span', {class: 'hexdot', 'aria-hidden': 'true'}), 'Active delivery'), h('span', {class: 'tag'}, orderNo(order))),
    stepper(step), h('h3', {}, title), ...body);
}
function deliveredCell() {
  return h('section', {class: 'cell delivered'},
    h('div', {class: 'delivered-hex', 'aria-hidden': 'true'}, '✓'),
    h('h3', {}, 'Delivered!'), h('p', {class: 'muted'}, orderNo(completed) + ' · ' + money(completed.payout) + ' added to your jar'),
    h('button', {class: 'hive-btn hive-btn-primary', type: 'button', onclick: () => { completed = null; render(); }}, 'Find the next order'));
}
function deliveriesCell() {
  if (completed) return deliveredCell();
  const order = active();
  if (order) return activeCell(order);
  const list = offers().filter(o => !skipped.has(o.id));
  const c = cell('Available deliveries');
  c.setAttribute('aria-live', 'polite');
  if (!state.available) c.append(emptyState(SLEEPY, 'You’re resting', 'Go online to see offers buzzing in.'));
  else if (!list.length) c.append(emptyState(EMPTY_COMB, 'The comb is empty', 'New orders will buzz in here. Hot zones fill fastest.'));
  else c.append(...list.map(offerCard));
  return c;
}
function emptyState(art, title, text) { return h('div', {class: 'empty'}, h('div', {html: art}), h('strong', {}, title), h('span', {}, text)); }
function errorState(retry) {
  return h('section', {class: 'cell'}, emptyState(SLEEPY, 'The hive is unreachable', 'Deliveries could not load. Check your connection.'),
    h('div', {style: {display: 'grid', placeItems: 'center'}}, h('button', {class: 'hive-btn hive-btn-primary', type: 'button', onclick: () => run(retry)}, 'Try again')));
}
function legend() {
  const hot = map ? [...map.hexes].sort((a, b) => b.d - a.d).slice(0, 3) : [];
  return h('div', {class: 'map-legend', role: 'region', 'aria-label': 'Demand legend'},
    h('strong', {}, h('span', {class: 'hexdot', 'aria-hidden': 'true'}), 'Demand'),
    h('div', {class: 'map-legend-bar', 'aria-hidden': 'true'}),
    h('div', {class: 'map-legend-scale'}, h('span', {}, 'Quiet'), h('span', {}, 'Hot zone: +₹15 bonus')),
    h('p', {class: 'muted', style: {fontSize: '12px'}}, 'Tap a hex for expected orders. Hot zones:'),
    h('div', {class: 'zones'}, hot.map(hex => h('button', {type: 'button', onclick: () => { map.focus({x: hex.cx, y: hex.cy}, undefined, true); setTimeout(() => map.selectHex(hex), 350); }}, 'Zone ' + hex.zone))));
}
function mapControls() {
  const btn = (label, name, fn) => { const b = h('button', {type: 'button', 'aria-label': label, onclick: fn}); b.append(icon(name, 20)); return b; };
  return h('div', {class: 'map-ctrl'}, btn('Zoom in', 'plus', () => map.zoomAt(.8)), btn('Zoom out', 'minus', () => map.zoomAt(1.25)), btn('Centre on my bee', 'locate', () => map.focus(map.bee, undefined, true)));
}

/* ==================================================================== pages */
function renderCockpit() {
  const mode = viewport();
  const left = [statusCell(), jarCell(), kpiCells()];
  const right = [deliveriesCell()];
  if (mode === 'desktop') return [h('div', {class: 'rail rail-left assemble'}, left), h('div', {class: 'rail rail-right assemble'}, right), legend(), mapControls()];
  if (mode === 'tablet') return [h('div', {class: 'cockpit-cols assemble'}, h('div', {}, left), h('div', {}, right)), legend(), mapControls()];
  // On mobile the map sits above a three-position bottom sheet.
  const order = active();
  const first = order || completed ? [activeBarInline(), deliveriesCell(), statusCell()] : [statusCell(), deliveriesCell()];
  return [legend(), mapControls(), sheet([...first, jarCell(), kpiCells()])];
}
function payoutTimeline() {
  const now = new Date();
  const next = new Date(now); next.setDate(now.getDate() + ((5 - now.getDay() + 7) % 7 || 7)); next.setHours(18, 0, 0, 0);
  const cycle = 7 * DAY, left = next - now, w = clamp(1 - left / cycle, .04, 1);
  const date = next.toLocaleDateString('en-IN', {weekday: 'short', day: 'numeric', month: 'short'});
  const today = todayEarned();
  const line = (pct) => { const l = h('div', {class: 'tl-line', 'aria-hidden': 'true'}, h('i')); l.style.setProperty('--w', (pct * 100).toFixed(1) + '%'); return l; };
  return h('section', {class: 'cell span-12', 'aria-label': 'Payout timeline'}, h('div', {class: 'timeline'},
    h('div', {class: 'tl-node'}, h('span', {class: 'lbl'}, 'Today'), h('span', {class: 'val num'}, today == null ? '—' : money(today))),
    line(Math.min(1, w * 1.6)),
    h('div', {class: 'tl-node'}, h('span', {class: 'lbl'}, 'Awaiting'), h('span', {class: 'val num'}, money(state.earnings.outstanding))),
    line(w),
    h('div', {class: 'tl-node', style: {textAlign: 'right'}}, h('span', {class: 'lbl'}, 'Next settlement'), h('span', {class: 'val num'}, demo ? date : 'Weekly'))));
}
const SERIES = {Today: [[0, '8a'], [600, '10a'], [1200, '12p'], [3700, '2p'], [4600, '4p'], [8300, '6p'], [9800, '8p']],
  Week: [[8200, 'Mon'], [12600, 'Tue'], [9100, 'Wed'], [15400, 'Thu'], [11800, 'Fri'], [17600, 'Sat'], [8300, 'Sun']],
  Month: [[42000, 'W1'], [51000, 'W2'], [47500, 'W3'], [63000, 'W4'], [58000, 'W5']]};
function areaChart() {
  const c = cell('Earnings trend');
  const seg = h('div', {class: 'seg', role: 'group', 'aria-label': 'Period'}, ['Today', 'Week', 'Month'].map(p => h('button', {type: 'button', 'aria-pressed': String(p === period), onclick: () => { period = p; render(); content.querySelector('.seg [aria-pressed=true]')?.focus(); }}, p)));
  c.querySelector('.cell-head').append(seg);
  if (!demo) { c.append(emptyState(EMPTY_COMB, 'Trend coming soon', 'Your trend appears after a week of deliveries.')); return c; }
  const data = SERIES[period], W = 640, H = 220, pad = {l: 44, r: 12, t: 16, b: 28};
  const max = Math.max(...data.map(d => d[0])) * 1.15;
  const xs = i => pad.l + i * (W - pad.l - pad.r) / (data.length - 1), ys = v => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const pts = data.map((d, i) => [xs(i), ys(d[0])]);
  // smooth (Catmull-Rom → Bézier)
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
  }
  const grid = [0, .5, 1].map(f => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${ys(max / 1.15 * f)}" y2="${ys(max / 1.15 * f)}"/><text x="${pad.l - 8}" y="${ys(max / 1.15 * f) + 4}" text-anchor="end">${money(max / 1.15 * f)}</text>`).join('');
  const wrap = h('div', {class: 'chart'});
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${period} earnings chart" preserveAspectRatio="none">
    <defs><linearGradient id="hive-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F5C542" stop-opacity=".55"/><stop offset="1" stop-color="#F5C542" stop-opacity="0"/></linearGradient></defs>
    <g class="grid axis">${grid}</g>
    <path class="area" d="${d} L${pts.at(-1)[0]} ${H - pad.b} L${pts[0][0]} ${H - pad.b}Z"/>
    <path class="line" d="${d}"/>
    <g class="axis">${data.map((v, i) => `<text x="${xs(i)}" y="${H - 6}" text-anchor="middle">${v[1]}</text>`).join('')}</g></svg>`;
  const svg = wrap.firstElementChild, tip = h('div', {class: 'chart-tip', hidden: true});
  const lineEl = svg.querySelector('.line');
  requestAnimationFrame(() => { const len = lineEl.getTotalLength(); lineEl.style.setProperty('--len', len); });
  pts.forEach(([x, y], i) => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [k, v] of Object.entries({cx: x, cy: y, r: 6, class: 'pt', tabindex: 0, 'aria-label': `${data[i][1]}: ${money(data[i][0])}`, 'vector-effect': 'non-scaling-stroke'})) dot.setAttribute(k, v);
    const show = () => { const r = svg.getBoundingClientRect(); tip.hidden = false; tip.textContent = `${data[i][1]} · ${money(data[i][0])}`; tip.style.left = (x / W * r.width) + 'px'; tip.style.top = (y / H * r.height) + 'px'; };
    dot.addEventListener('focus', show); dot.addEventListener('pointerenter', show);
    dot.addEventListener('blur', () => { tip.hidden = true; }); dot.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(dot);
  });
  wrap.append(tip);
  c.append(wrap);
  return c;
}
function ticketRows() {
  const range = {Today: 1, Week: 7, Month: 30}[period];
  return delivered().filter(o => !demo || !o.completedAt || Date.now() - o.completedAt < range * DAY)
    .filter(o => ticketFilter === 'All' || (ticketFilter === 'Settled') === settledOf(o))
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}
function ticket(order, i) {
  const settled = settledOf(order);
  const when = order.completedAt ? new Date(order.completedAt).toLocaleString('en-IN', {weekday: 'short', hour: 'numeric', minute: '2-digit'}) : 'Recently';
  const t = h('article', {class: 'ticket ' + (settled ? 'is-settled' : 'is-awaiting'), 'aria-label': `${orderNo(order)}, ${money(order.payout)}, ${settled ? 'settled' : 'awaiting settlement'}`},
    h('div', {class: 'ticket-main'},
      h('span', {class: 'ticket-id'}, orderNo(order)),
      h('div', {class: 'ticket-route'}, h('strong', {}, order.from || 'Print room'),
        h('span', {html: '<svg class="arrow" viewBox="0 0 40 12" aria-hidden="true"><path d="M2 6h32" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 4" stroke-linecap="round"/><path d="M31 2l5 4-5 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>', style: {color: 'var(--honey-700)'}}),
        h('strong', {class: 'to'}, order.to || (order.address || 'Customer').split(',')[0])),
      h('span', {class: 'ticket-when'}, when)),
    h('div', {class: 'ticket-stub'}, h('span', {class: 'amt num'}, money(order.payout)), h('span', {class: 'stamp'}, settled ? 'Settled' : 'Awaiting')));
  t.style.setProperty('--i', i);
  return t;
}
function ticketsCell() {
  const c = cell('Delivery receipts');
  const filters = h('div', {class: 'seg', role: 'group', 'aria-label': 'Filter receipts'}, ['All', 'Awaiting', 'Settled'].map(f => h('button', {type: 'button', 'aria-pressed': String(f === ticketFilter), onclick: () => { ticketFilter = f; render(); content.querySelector('.ticket-filters [aria-pressed=true]')?.focus(); }}, f)));
  const exportBtn = h('button', {class: 'hive-btn hive-btn-small', type: 'button', onclick: exportDeliveries}, icon('download', 18), 'Export CSV');
  const rows = ticketRows();
  c.append(h('div', {class: 'ticket-filters'}, filters, exportBtn),
    rows.length ? h('div', {class: 'tickets'}, rows.map(ticket)) : emptyState(EMPTY_COMB, 'No receipts here yet', 'Completed deliveries appear as tickets.'));
  return c;
}
function renderEarnings() {
  const today = todayEarned(), week = weekEarned();
  const value = today ?? state.earnings.outstanding ?? 0;
  const jar = honeyJar(value, goals.day, {label: today == null ? 'Awaiting settlement' : 'Earned today'});
  const fig = (label, val) => h('div', {class: 'figure'}, h('span', {class: 'lbl'}, label), h('span', {class: 'val num'}, val));
  const hero = cell(null, h('div', {class: 'earn-hero'}, jar, h('div', {style: {display: 'grid', gap: '16px', minWidth: 0}},
    h('div', {}, h('span', {class: 'muted'}, today == null ? 'Awaiting settlement' : 'Earned today'), h('div', {class: 'num', style: {fontSize: '40px', lineHeight: 1.15}}, money(value)),
      h('span', {class: 'muted'}, `${Math.round(clamp(value / goals.day, 0, 1) * 100)}% of your ${money(goals.day)} goal`)),
    h('div', {class: 'earn-figures'}, fig('This week', week == null ? '—' : money(week)), fig('Awaiting', money(state.earnings.outstanding)), fig('Lifetime', money(state.earnings.lifetime))),
    week != null ? comb(Math.floor(clamp(week / goals.week, 0, 1) * 14), 14) : null)));
  const head = h('div', {class: 'page-head span-12'}, h('div', {}, h('h1', {}, 'Earnings'), h('p', {}, demo ? 'Sample hive · amounts are illustrative' : 'Your payouts and receipts')));
  return [h('div', {class: 'grid-12 assemble'}, head, payoutTimeline(),
    h('div', {class: 'span-7 earn-split', style: {display: 'grid', gap: 'var(--gutter)', alignContent: 'start'}}, hero, areaChart()),
    h('div', {class: 'span-5'}, ticketsCell()))];
}
function badge() {
  const id = demo ? 'PB-R104' : 'PB-PARTNER';
  const stars = 4.9;
  const starcomb = h('div', {class: 'starcomb', 'aria-label': `Rating ${stars} out of 5`}, [1, 2, 3, 4, 5].map(i => h('i', {class: stars >= i ? 'on' : stars >= i - .5 ? 'half' : ''})), h('b', {class: 'num'}, demo ? stars.toFixed(1) : '—'));
  const photo = `<svg viewBox="0 0 88 100" aria-hidden="true"><rect width="88" height="100" fill="#FFF1D2"/><circle cx="44" cy="40" r="17" fill="#C68B59"/><path d="M27 37c0-12 8-19 17-19s17 7 17 19c-4-6-10-8-17-8s-13 2-17 8z" fill="#2A2112"/><path d="M12 100c2-20 15-31 32-31s30 11 32 31z" fill="#F5C542"/><path d="M36 70l8 10 8-10" fill="none" stroke="#B9831A" stroke-width="3"/></svg>`;
  const front = h('div', {class: 'badge-face'},
    h('div', {class: 'badge-band'}, h('span', {class: 'badge-slot'}), h('span', {class: 'badge-org'}, h('img', {src: '/printbee-header-bee.webp', alt: ''}), 'PrintBee Partner'), h('div', {class: 'badge-photo', html: photo})),
    h('div', {class: 'badge-body'},
      h('div', {class: 'badge-name'}, demo ? profile.name : 'Delivery partner'),
      h('div', {class: 'badge-role'}, 'Delivery partner · SRM campus hive'), starcomb,
      h('div', {class: 'badge-row'}, h('div', {class: 'badge-id'}, h('span', {class: 'lbl'}, 'Partner ID'), h('span', {class: 'val num'}, id), h('span', {class: 'lbl', style: {marginTop: '8px'}}, 'Valid through'), h('span', {class: 'num'}, 'Mar 2027')),
        h('div', {class: 'badge-qr', html: QR.svg('PRINTBEE:PARTNER:' + id)}))),
    h('div', {class: 'badge-holo', 'aria-hidden': 'true'}));
  const back = h('div', {class: 'badge-face badge-back'},
    h('div', {class: 'badge-band', style: {height: '22%'}}, h('span', {class: 'badge-slot'}), h('span', {class: 'badge-org'}, 'Vehicle & documents')),
    h('dl', {class: 'back-list'},
      ...[['Vehicle', profile.vehicle], ['Driving licence', 'Verified · exp 2031'], ['Vehicle RC', 'Verified'], ['Insurance', 'Valid · Aug 2027'], ['Payout account', profile.payout]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {class: /Verified|Valid/.test(v) ? 'doc-ok' : ''}, v)))),
    h('div', {class: 'badge-holo', 'aria-hidden': 'true'}));
  const card = h('div', {class: 'badge', role: 'group', 'aria-label': 'Partner ID card'}, front, back);
  let flipped = false;
  const flipBtn = h('button', {class: 'hive-btn', type: 'button', 'aria-pressed': 'false', onclick: () => { flipped = !flipped; card.style.setProperty('--flip', flipped ? '180deg' : '0deg'); flipBtn.setAttribute('aria-pressed', String(flipped)); flipBtn.lastChild.textContent = flipped ? 'Show front' : 'Show vehicle & documents'; }}, icon('flip', 18), h('span', {}, 'Show vehicle & documents'));
  const stage = h('div', {class: 'badge-stage'}, card);
  if (!reduced.matches) {
    stage.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
      card.classList.add('is-tilting');
      card.style.setProperty('--ry', (px * 18).toFixed(2) + 'deg'); card.style.setProperty('--rx', (-py * 14).toFixed(2) + 'deg');
    });
    stage.addEventListener('pointerleave', () => { card.classList.remove('is-tilting'); card.style.setProperty('--ry', '0deg'); card.style.setProperty('--rx', '0deg'); });
    const gyro = e => { if (!card.isConnected) return removeEventListener('deviceorientation', gyro); if (e.gamma == null) return; card.classList.add('is-tilting'); card.style.setProperty('--ry', clamp(e.gamma, -20, 20).toFixed(1) + 'deg'); card.style.setProperty('--rx', clamp((e.beta - 45) * -.4, -12, 12).toFixed(1) + 'deg'); };
    if ('DeviceOrientationEvent' in window && typeof DeviceOrientationEvent.requestPermission !== 'function') addEventListener('deviceorientation', gyro);
  }
  return h('section', {class: 'cell span-5', 'aria-label': 'Partner ID badge'}, stage, h('div', {class: 'badge-actions'}, flipBtn), h('p', {class: 'muted', style: {textAlign: 'center', marginTop: '12px', fontSize: '13px'}}, 'Show the QR code at the hive counter to collect packets.'));
}
function renderProfile() {
  const head = h('div', {class: 'page-head span-12'}, h('div', {}, h('h1', {}, 'Profile'), h('p', {}, demo ? 'Your sample partner identity' : 'Your PrintBee partner account')));
  const settings = cell('Account settings');
  if (demo) {
    const form = h('form', {class: 'form-grid'});
    for (const [key, title] of [['name', 'Display name'], ['vehicle', 'Vehicle'], ['payout', 'Payout account (UPI)'], ['language', 'Language']]) form.append(h('label', {}, title, h('input', {class: 'hive-input', name: key, value: profile[key], required: true, maxlength: 80})));
    const alerts = h('input', {type: 'checkbox', name: 'alerts'}); alerts.checked = profile.alerts;
    form.append(h('label', {class: 'toggle-row'}, 'Delivery notifications', alerts));
    const saveBtn = h('button', {class: 'hive-btn hive-btn-primary', type: 'submit', hidden: true}, 'Save changes');
    const payload = () => Object.fromEntries([...new FormData(form)].filter(([k]) => k !== 'alerts').map(([k, v]) => [k, String(v).trim()]));
    form.oninput = () => { saveBtn.hidden = JSON.stringify({...payload(), alerts: alerts.checked}) === JSON.stringify(profile); };
    form.onsubmit = e => {
      e.preventDefault();
      const updated = payload();
      if (Object.values(updated).some(v => !v)) { notify('Complete each field before saving.'); return; }
      profile = {...updated, alerts: alerts.checked}; save('printbee-rider-profile', JSON.stringify(profile)); render(); notify('Profile saved.');
    };
    form.append(h('div', {style: {gridColumn: '1 / -1'}}, saveBtn));
    settings.append(form);
  } else {
    settings.append(h('p', {class: 'muted'}, 'Manage account and payout details through PrintBee support.'), h('div', {class: 'row-actions'}, h('a', {class: 'hive-btn', href: 'mailto:printbee.co.in@gmail.com'}, 'Email PrintBee support')));
  }
  const docs = cell('Documents', h('div', {style: {display: 'grid', gap: '8px'}}, ...[['Driving licence', 'Verified'], ['Vehicle RC', 'Verified'], ['Insurance', 'Valid until Aug 2027']].map(([k, v]) => h('div', {class: 'toggle-row'}, k, h('span', {class: 'doc-ok'}, '✓ ' + v)))),
    demo ? h('div', {class: 'row-actions'}, h('button', {class: 'hive-btn', type: 'button', onclick: () => { state = seed(); shiftSince = null; skipped.clear(); completed = null; tab = 'Cockpit'; changed(); notify('Sample hive reset.'); }}, 'Reset sample deliveries'), h('a', {class: 'hive-btn', href: '/partner'}, 'Live partner sign-in')) : null);
  return [h('div', {class: 'grid-12 assemble'}, head, badge(), h('div', {class: 'span-7', style: {display: 'grid', gap: 'var(--gutter)', alignContent: 'start'}}, settings, docs))];
}

/* ==================================================================== shell */
function activeBarContent(order) {
  const step = stepOf(order), eta = etaOf(order);
  const done = step <= 1 ? 0 : step === 2 ? 1 : 3;
  const nav = h('a', {class: 'hive-btn', href: navigateUrl(order), target: '_blank', rel: 'noopener noreferrer'}, icon('nav', 18), 'Navigate');
  return [h('div', {class: 'ab-text'}, h('span', {class: 'ab-id'}, orderNo(order)), h('span', {class: 'ab-eta'}, (eta ? `ETA ${eta} min · ` : '') + STEPS[done])),
    h('div', {class: 'ab-steps', 'aria-hidden': 'true'}, STEPS.map((_, i) => h('i', {class: i <= done ? 'on' : ''}))), nav];
}
function activeBarInline() {
  const order = active();
  if (!order) return null;
  const bar = h('div', {class: 'hive-activebar', style: {position: 'static', display: 'flex'}, role: 'region', 'aria-label': 'Active delivery'}, activeBarContent(order));
  return bar;
}
function updateActiveBar() {
  const bar = $('hive-activebar'), order = active();
  bar.hidden = !order || !content.dataset.ready;
  if (order) { bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Active delivery'); bar.replaceChildren(...activeBarContent(order)); }
}
// Mobile bottom sheet with three snap points; the handle is a button for keyboard users.
let sheetSnap = 0;
function sheet(kids) {
  const snaps = () => { const H = innerHeight * .92; return [H - 240, H - innerHeight * .6, 0]; };   // peek · half · full
  const body = h('div', {class: 'sheet-body'}, kids);
  const handle = h('button', {class: 'sheet-handle', type: 'button', 'aria-label': 'Resize panel', 'aria-expanded': 'false'});
  const el = h('section', {class: 'sheet', 'aria-label': 'Cockpit panel'}, handle, body);
  const setY = (y, snap) => {
    el.style.setProperty('--sheet-y', y + 'px');
    document.documentElement.style.setProperty('--sheet-px', (innerHeight * .92 - y) + 'px');
    if (snap != null) { sheetSnap = snap; handle.setAttribute('aria-expanded', String(snap === 2)); handle.setAttribute('aria-label', ['Expand panel', 'Expand panel to full height', 'Collapse panel'][snap]); }
  };
  requestAnimationFrame(() => setY(snaps()[sheetSnap], sheetSnap));
  let startY = 0, startOff = 0, lastY = 0, lastT = 0, v = 0, dragging = false;
  const down = e => { dragging = true; startY = lastY = e.clientY; lastT = performance.now(); startOff = snaps()[sheetSnap]; el.classList.add('is-dragging'); e.currentTarget.setPointerCapture(e.pointerId); };
  const move = e => { if (!dragging) return; const now = performance.now(); v = (e.clientY - lastY) / Math.max(1, now - lastT); lastY = e.clientY; lastT = now; setY(clamp(startOff + e.clientY - startY, 0, snaps()[0] + 40)); };
  const up = e => {
    if (!dragging) return; dragging = false; el.classList.remove('is-dragging');
    const s = snaps(), y = startOff + e.clientY - startY;
    if (Math.abs(e.clientY - startY) < 4) { setY(s[(sheetSnap + 1) % 3], (sheetSnap + 1) % 3); return; }
    let target = s.map((p, i) => [Math.abs(p - (y + v * 160)), i]).sort((a, b) => a[0] - b[0])[0][1];
    setY(s[target], target);
  };
  handle.addEventListener('pointerdown', down); handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  handle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const n = (sheetSnap + 1) % 3; setY(snaps()[n], n); } });
  return el;
}
function renderDock() {
  const nav = $('rider-nav');
  if (!nav.childElementCount) {
    nav.append(h('span', {class: 'hive-dock-bee', 'aria-hidden': 'true'}));
    for (const name of ['Cockpit', 'Earnings', 'Profile']) {
      const b = h('button', {class: 'hive-tab', type: 'button', 'data-section': name, onclick: e => selectTab(name, e.currentTarget)}, icon(name), h('span', {}, name));
      nav.append(b);
    }
  }
  const tabs = [...nav.querySelectorAll('.hive-tab')];
  tabs.forEach(b => { if (b.dataset.section === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const current = tabs.find(b => b.dataset.section === tab);
  const indicator = nav.querySelector('.hive-dock-bee');
  requestAnimationFrame(() => { indicator.style.transform = viewport() === 'desktop' ? `translateY(${current.offsetTop - 12}px)` : `translateX(${current.offsetLeft - 8}px)`; });
}
function selectTab(next, from) {
  if (next === tab) return;
  if ($('rider-dialog').open) $('rider-dialog').close();
  // A soft ripple from the dock item accompanies the page transition.
  const ripple = $('hive-ripple');
  if (!reduced.matches && from) {
    const r = from.getBoundingClientRect();
    ripple.style.setProperty('--rx', r.left + r.width / 2 + 'px'); ripple.style.setProperty('--ry', r.top + r.height / 2 + 'px');
    ripple.classList.remove('is-on'); void ripple.offsetWidth; ripple.classList.add('is-on');
  }
  tab = next;
  render();
  scrollTo(0, 0);
  $('main').focus({preventScroll: true});
}
let lastMode = viewport();
function render() {
  document.body.dataset.page = tab;
  const mode = viewport();
  lastMode = mode;
  renderDock();
  const mapHost = $('hive-map');
  mapHost.hidden = tab !== 'Cockpit';
  if (tab === 'Cockpit') {
    if (!map) map = createMap(mapHost);
    else map.resize();
  } else cancelAnimationFrame(flightRaf);
  const nodes = tab === 'Cockpit' ? renderCockpit() : tab === 'Earnings' ? renderEarnings() : renderProfile();
  content.replaceChildren(...nodes);
  content.dataset.ready = '1';
  content.querySelectorAll('.assemble').forEach(g => [...g.children].forEach((c, i) => c.style.setProperty('--k', i)));
  if (tab === 'Cockpit') syncMap();
  updateActiveBar();
  updateClock();
  scheduleBuzz();
}
function updateClock() {
  const timer = content.querySelector('[data-shift-time]');
  if (!timer) return;
  const minutes = shiftSince ? Math.floor((Date.now() - shiftSince) / 60000) : 0;
  timer.textContent = state.available && shiftSince ? `${Math.floor(minutes / 60)}h ${minutes % 60}m on shift` : state.available ? 'Ready for offers' : 'The hive is waiting';
}
function updateBell() {
  const bell = $('rider-notifications');
  if (unread) bell.dataset.count = String(Math.min(9, unread)); else delete bell.dataset.count;
  bell.setAttribute('aria-label', unread ? `Notifications, ${unread} new` : 'Notifications');
}
function showDialog(title, populate) {
  const dialog = $('rider-dialog');
  $('rider-dialog-title').textContent = title;
  const body = $('rider-dialog-body');
  body.replaceChildren();
  $('portal-logout').classList.toggle('is-visible', title === 'Partner account');
  populate(body);
  if (!dialog.open) dialog.showModal();
}
function openNotifications() {
  unread = 0; updateBell();
  showDialog('Notifications', body => {
    for (const {message, at} of notices) body.append(h('div', {class: 'note-item'}, h('span', {class: 'hexdot', 'aria-hidden': 'true'}), h('span', {}, message, h('br'), h('small', {class: 'muted'}, new Date(at).toLocaleTimeString('en-IN', {hour: 'numeric', minute: '2-digit'})))));
    if (!notices.length) body.append(emptyState(EMPTY_COMB, 'All caught up', 'New offers and payouts appear here.'));
  });
}

// Command palette (Ctrl/Cmd+K)
function commands() {
  const list = [
    ['Go to Cockpit', 'Page', () => selectTab('Cockpit', document.querySelector('[data-section=Cockpit]'))],
    ['Go to Earnings', 'Page', () => selectTab('Earnings', document.querySelector('[data-section=Earnings]'))],
    ['Go to Profile', 'Page', () => selectTab('Profile', document.querySelector('[data-section=Profile]'))],
    [document.documentElement.dataset.theme === 'moon' ? 'Switch to Sun Hive' : 'Switch to Moon Hive', 'Theme', () => toggleTheme()],
    [state.available ? 'Go offline' : 'Go online', 'Shift', () => run(toggleOnline)],
    ['Export deliveries as CSV', 'Earnings', exportDeliveries],
  ];
  if (demo) list.push(['Reset sample deliveries', 'Sample', () => { state = seed(); shiftSince = null; skipped.clear(); completed = null; changed(); notify('Sample hive reset.'); }]);
  for (const order of state.orders.filter(o => o.partner || o.status === 'packed')) list.push([orderNo(order), order.status === 'delivered' ? 'Receipt' : 'Order', () => selectTab(order.status === 'delivered' ? 'Earnings' : 'Cockpit', document.querySelector(`[data-section=${order.status === 'delivered' ? 'Earnings' : 'Cockpit'}]`))]);
  return list;
}
function openPalette() {
  const dialog = $('hive-palette'), input = $('hive-palette-input'), list = $('hive-palette-list');
  let items = [], index = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = commands().filter(([name, kind]) => (name + ' ' + kind).toLowerCase().includes(q));
    index = clamp(index, 0, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map(([name, kind], i) => {
      const li = h('li', {role: 'option', id: 'cmd-' + i, 'aria-selected': String(i === index)}, h('span', {class: 'hexdot', 'aria-hidden': 'true'}), name, h('small', {}, kind));
      li.onclick = () => go(i); li.onpointermove = () => { if (index !== i) { index = i; draw(); } };
      return li;
    }));
    if (!items.length) list.append(h('li', {role: 'option', 'aria-disabled': 'true'}, 'No matches'));
    input.setAttribute('aria-activedescendant', items.length ? 'cmd-' + index : '');
  };
  const go = i => { const item = items[i]; if (!item) return; dialog.close(); item[2](); };
  input.value = ''; index = 0;
  input.oninput = () => { index = 0; draw(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { index = (index + 1) % Math.max(1, items.length); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { index = (index - 1 + items.length) % Math.max(1, items.length); draw(); e.preventDefault(); }
    if (e.key === 'Enter') { go(index); e.preventDefault(); }
  };
  draw();
  dialog.showModal();
  input.focus();
}

// Buzz, the co-pilot: one tip at a time, dismissable, rate-limited.
let buzzTimer = 0, buzzLast = 0, buzzDismissedUntil = 0, buzzShown = new Set();
function buzzTip() {
  const order = active();
  const streak = delivered().filter(o => Date.now() - (o.completedAt || 0) < DAY).length;
  const hot = map ? [...map.hexes].sort((a, b) => b.d - a.d)[0] : null;
  const dir = hot ? (() => { const dx = hot.cx - map.bee.x, dy = hot.cy - map.bee.y; const m = Math.round(Math.hypot(dx, dy) / 50) * 50; const card = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north'); return `${m} m ${card}`; })() : '';
  const tips = [];
  if (!state.available) tips.push(['offline', 'Hot zone near the Engineering block. Go online to catch +₹15 orders.']);
  if (state.available && !order && hot && tab === 'Cockpit') tips.push(['hot', `Hot zone ${dir}, +₹15 per order.`]);
  if (order && stepOf(order) === 2) tips.push(['rain', 'Light rain expected soon. Ride safe and keep packets covered.']);
  if (order && stepOf(order) === 3) tips.push(['otp', 'Ask for the 4-digit code in the customer’s PrintBee app.']);
  if (streak > 0 && streak < 5) tips.push(['streak', `${5 - streak} more deliveries today for your streak bonus.`]);
  if (tab === 'Earnings') tips.push(['settle', 'Awaiting payouts settle every Friday evening.']);
  return tips.find(([k]) => !buzzShown.has(k + tab + (order?.id || '')));
}
function scheduleBuzz() {
  clearTimeout(buzzTimer);
  const box = $('hive-buzz');
  if ($('rider-app').hidden) return;
  const wait = Math.max(2500, 30000 - (Date.now() - buzzLast), buzzDismissedUntil - Date.now());
  buzzTimer = setTimeout(() => {
    const tip = buzzTip();
    if (!tip) return;
    buzzShown.add(tip[0] + tab + (active()?.id || ''));
    buzzLast = Date.now();
    const close = h('button', {type: 'button', 'aria-label': 'Dismiss tip', onclick: () => { box.hidden = true; buzzDismissedUntil = Date.now() + 60000; }}, '✕');
    box.replaceChildren(h('div', {class: 'buzz-bee', html: BEE()}), h('div', {class: 'buzz-bubble'}, h('small', {}, 'Buzz · co-pilot'), tip[1], close));
    box.hidden = false;
    setTimeout(() => { if (box.firstChild && box.querySelector('.buzz-bubble')?.textContent.includes(tip[1])) box.hidden = true; }, 12000);
  }, buzzLast ? wait : 2500);
}

// Sun Hive ⇄ Moon Hive with a circular reveal from the toggle.
function applyTheme(moon) {
  document.documentElement.dataset.theme = moon ? 'moon' : 'sun';
  const t = $('night-mode');
  t.setAttribute('aria-pressed', String(moon));
  t.setAttribute('aria-label', moon ? 'Sun Hive (day theme)' : 'Moon Hive (night theme)');
  document.querySelector('meta[name=theme-color]').content = moon ? '#1A1209' : '#FFF8E8';
  if (!new URLSearchParams(location.search).get('theme')) save('printbee-rider-night', moon ? '1' : '0');
  map?.colourHexes();
}
function toggleTheme() {
  const moon = document.documentElement.dataset.theme !== 'moon';
  const r = $('night-mode').getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (!document.startViewTransition || reduced.matches) { applyTheme(moon); return; }
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const t = document.startViewTransition(() => applyTheme(moon));
  t.ready.then(() => document.documentElement.animate({clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]}, {duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)'})).catch(() => {});
}
/* ===================================================================== boot */
async function init() {
  $('rider-app').hidden = false;
  $('portal-login').hidden = true;
  for (const id of ['rider-nav', 'rider-search', 'rider-notifications', 'rider-avatar']) $(id).hidden = false;
  $('rider-search').replaceChildren(icon('search', 22));
  $('rider-notifications').replaceChildren(icon('bell', 22));
  $('rider-search').onclick = openPalette;
  $('rider-notifications').onclick = openNotifications;
  $('rider-avatar').textContent = (demo ? profile.name : 'Partner').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
  $('rider-avatar').onclick = () => showDialog('Partner account', body => body.append(
    h('p', {class: 'muted'}, demo ? profile.name + ' · PB-R104' : 'Signed in as a delivery partner'),
    h('button', {class: 'hive-btn', type: 'button', onclick: () => selectTab('Profile', document.querySelector('[data-section=Profile]'))}, 'Open profile')));
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); } });
  addEventListener('resize', () => { if (viewport() !== lastMode) render(); else renderDock(); });
  setInterval(updateClock, 30000);
  if (demo) { render(); return; }
  content.replaceChildren(h('div', {class: 'grid-12'}, h('div', {class: 'skel skel-cell span-5'}), h('div', {class: 'skel skel-cell span-7'}), h('div', {class: 'skel skel-cell span-12'})));
  function poll() { if (!busy) refresh().catch(() => {}); sendLocation(); if (tab === 'Cockpit') syncMap(); }
  addEventListener('online', poll);
  addEventListener('offline', () => { $('network').hidden = false; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); keepAwake(); } });
  try { await refresh(); } finally { interval = setInterval(poll, 5000); }
}

applyTheme(document.documentElement.dataset.theme === 'moon');
$('night-mode').onclick = toggleTheme;
reduced.addEventListener?.('change', () => { if (!$('rider-app').hidden) render(); });
if (demo) {
  $('portal-login').hidden = true;
  $('preview-chip').hidden = false;
  init();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/partner-sw.js').catch(() => {});
} else {
  connectPortal('partner', status, init, () => { clearInterval(interval); stopLocation(); });
  $('phone-login').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget, control = form.querySelector('button');
    run(async () => {
      const code = $('login-code'), phone = form.elements.phone.value.trim();
      if (code.hidden) {
        await request('/api/partner/auth/send', {phone});
        code.hidden = false; form.elements.code.required = true;
        form.elements.phone.readOnly = true;
        control.textContent = 'Verify code'; form.elements.code.focus();
      } else {
        await request('/api/partner/auth/check', {phone, code: form.elements.code.value.trim()});
        location.reload();
      }
    }, control);
  };
}
