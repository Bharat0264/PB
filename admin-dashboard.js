// /admin reads the real database; /admin-preview.html keeps the sample data. Same screens either way.
const live = document.body.dataset.portal === 'admin';
const source = await import(live ? './admin-live-data.js' : './admin-data.js');
const {orders, products, activity, traffic, targets, today} = source;

import {addOfflineOrderFields, pickupMapUrl} from './admin-records.js';

import {buildLedger} from './admin-ledger.js?v=mobile-layout';
import {mountSupport, supportBadge, supportNotifications} from './admin-support.js?v=2';
import {buildPricingForm} from './admin-pricing.js';
import {previewPricingUrl, readPreviewPricing, savePreviewPricing} from './pricing-preview.js';

const $ = id => document.getElementById(id);
const root = $('dashboard');
const money = new Intl.NumberFormat('en-IN', {style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2}).format;
const number = new Intl.NumberFormat('en-IN').format;
const colors = ['accent','lavender','mint','peach','sky','pink','track'].map(name => 'var(--' + name + ')');
const sections = {
  dashboard: ['Dashboard', 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'],
  orders: ['Orders', 'M4 7h16v14H4z M8 7V5h8v2 M9 12h6'],
  support: ['Support', 'M4 5h16v11H9l-5 4z M8 9.5h8 M8 12.5h5'],
  customers: ['Customers', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M22 21v-2a4 4 0 0 0-3-4 M17 3a4 4 0 0 1 0 8'],
  analytics: ['Analytics', 'M3 3v18h18 M7 15l4-5 4 2 5-7'],
  pricing: ['Pricing', 'M6 3h12 M6 8h12 M14 21l-8-8h3a5 5 0 0 0 0-10'],
  ledger: ['Ledger', 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5'],
  inventory: ['Inventory', 'M3 9h18v12H3z M5 9V4h14v5 M9 14h6'],
  partners: ['Delivery Partners', 'M3 6h12v11H3z M15 9h4l3 4v4h-7 M6 17a2 2 0 1 0 4 0 M17 17a2 2 0 1 0 4 0'],
  warehouses: ['Warehouses', 'M3 21V8l9-5 9 5v13z M7 21V11h10v10 M7 15h10 M7 18h10'],
};
if (live) sections.inventory[0] = 'Print services';
if (!live) delete sections.support;          // the sample dashboard has no tickets: never show mock numbers
const oldSections = {reports:'orders', products:'inventory', revenue:'analytics'};
const icon = path => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const partners = live ? source.partners : [{name:'Ananya Roy', email:'ananya.rider@example.com'}];
const warehouses = live ? source.warehouses : [{name:'Main campus print room', location:'SRM Main Campus', address:'SRM Institute of Science and Technology, Kattankulathur', email:'warehouse@example.com'}];
const orderWindowDays = 30;
const state = { period:'Daily', query:'', filter:'', sort:'date', direction:-1, page:0};
const getStored = key => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

// This switch pauses new website orders independently of each warehouse's switch.
let savingOrdering = false;
function renderOrdering() {
  const button = $('ordering-control');
  if (!button || savingOrdering) return;
  const ordering = source.info?.ordering;
  button.disabled = !ordering;
  if (!ordering) return;
  const paused = ordering.orderingPaused;
  button.setAttribute('aria-pressed', String(paused));
  button.dataset.state = paused ? 'paused' : 'open';
  button.title = button.ariaLabel = paused ? 'Resume website orders' : 'Pause website orders';
  button.innerHTML = icon(paused ? 'm9 5 11 7-11 7z' : 'M8 5v14 M16 5v14');
  const status = $('ordering-status');
  status.hidden = ordering.serviceOpen;
  status.textContent = paused ? 'Website orders paused · Tap the play button to resume.' :
    'All warehouses are closed · New website orders are unavailable.';
}
if ($('ordering-control')) $('ordering-control').onclick = async () => {
  const button = $('ordering-control');
  if (savingOrdering || !source.info?.ordering) return;
  savingOrdering = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    source.info.ordering = await source.api('/api/admin/ordering', {paused: !source.info.ordering.orderingPaused});
    $('notice').textContent = source.info.ordering.orderingPaused ?
      'New website orders are paused. Existing orders can still be fulfilled.' :
      source.info.ordering.serviceOpen ? 'Website orders are open.' : 'Pause removed. Orders will reopen when a warehouse opens.';
  } catch (error) {
    $('notice').textContent = error.message;
  } finally {
    savingOrdering = false;
    button.removeAttribute('aria-busy');
    renderOrdering();
  }
};

function day(offset) {
  const date = new Date(today);
  date.setDate(date.getDate() - offset);
  return date;
}

function selectedOrders() {
  return orders.filter(order => order.date > day(orderWindowDays));
}

function aggregate(items, key, amount = () => 1) {
  const totals = new Map();
  for (const item of items) totals.set(item[key], (totals.get(item[key]) || 0) + amount(item));
  return [...totals].sort((a,b) => b[1] - a[1]);
}

const notSales = new Set(['cancelled','refunded','pending','refund_pending','refund_failed']);
const isPending = order => live ? order.statusKey === 'pending' : order.status === 'Pending';
const profitOf = items => items.filter(order => order.statusKey === 'delivered').reduce((sum, order) => sum + order.total - order.tax - order.payout, 0);
const partnerPayOf = items => items.filter(order => order.statusKey === 'delivered').reduce((sum, order) => sum + order.payout, 0);
function sales(items) {
  return items.filter(order => live ? !notSales.has(order.statusKey) : !['Cancelled','Refunded','Pending'].includes(order.status));
}

function metrics(items, length) {
  const booked = sales(items);
  const revenue = booked.reduce((sum, order) => sum + order.total, 0);
  const active = aggregate(items,'customer');
  const refunds = items.filter(order => ['Refunded','Cancelled'].includes(order.status)).length;
  const signups = live ? profitOf(items) : Math.round(length * 7.1 + items.length / 11);
  return [revenue, items.length, active.length, signups, revenue, booked.length, active.filter(([,count]) => count > 1).length / (active.length || 1) * 100,
    refunds / (items.length || 1) * 100, items.filter(isPending).length,
    live ? partnerPayOf(items) : (items.length ? 98 - refunds / items.length * 26 : 0)];
}

const metricLabels = ['Total revenue','Total orders','Active customers','New signups',"Today’s revenue","Today’s orders",'Repeat customer rate','Refund / cancellation rate','Pending orders','Customer satisfaction'];
const metricFormats = [money,number,number,number,money,number,percent,percent,number,percent];
function percent(n) { return n.toFixed(1) + '%'; }
if (live) {   // the database has no signup or satisfaction figures, so show real profit and partner pay
  metricLabels[3] = 'Profit (delivered)';
  metricLabels[9] = 'Partner pay';
  metricFormats[3] = metricFormats[9] = money;
}

function points(values, width, height, high = Math.max(...values, 1), pad = 3) {
  return values.map((v,i) => [pad + (width - 2 * pad) * i / Math.max(1, values.length - 1), height - pad - (height - pad * 2) * v / high]);
}

function buckets(items, period) {
  const formats = {
    Daily: date => date.toLocaleDateString('en-IN',{day:'numeric',month:'short'}),
    Weekly: date => 'Week of ' + date.toLocaleDateString('en-IN',{day:'numeric',month:'short'}),
    Monthly: date => date.toLocaleDateString('en-IN',{month:'short',year:'numeric'}),
    Yearly: date => String(date.getFullYear()),
  };
  const groups = new Map();
  for (const order of [...items].sort((a,b) => a.date - b.date)) {
    const date = new Date(order.date);
    if (period === 'Weekly') date.setDate(date.getDate() - (date.getDay() + 6) % 7);
    const label = formats[period](date);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(order);
  }
  return [...groups];
}

function card(title, inner, size = '', extra = '') {
  return `<section class="card ${size}"><div class="card-head"><h2>${title}</h2>${extra}</div>${inner}</section>`;
}

function kpis(items) {
  const values = metrics(items,orderWindowDays);
  const prior = metrics(orders.filter(o => o.date <= day(orderWindowDays) && o.date > day(orderWindowDays * 2)),orderWindowDays);
  const timeline = buckets(items,'Weekly').map(([,group]) => metrics(group,7));
  const daily = Array.from({length:7}, (_, index) => {
    const end = day(6 - index);
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    return metrics(orders.filter(order => order.date >= start && order.date <= end), 1);
  });
  // Lead with today's activity, then period totals, the order queue, and customer metrics.
  const displayOrder = [4, 5, 0, 1, 8, 2, 3, 6, 7, 9];
  return `<div class="metrics">${displayOrder.map(i => {
    const isDaily = i === 4 || i === 5;
    const value = isDaily ? daily.at(-1)[i] : values[i];
    const baseline = isDaily ? daily.at(-2)[i] : prior[i];
    const change = baseline ? (value / baseline - 1) * 100 : null;
    const negative = change !== null && ([7,8].includes(i) ? change > 0 : change < 0);
    const dots = points((isDaily ? daily : timeline).map(group => group[i]),110,26);
    return `<section class="card metric"><h2>${metricLabels[i]}</h2><strong data-metric="${i}" data-value="${value}">${metricFormats[i](value)}</strong>
      <span class="change ${negative ? 'negative' : ''}">${change === null ? 'No prior baseline' : (change === 0 ? '&ndash; ' : change < 0 ? '&#8595; ' : '&#8593; ') + Math.abs(change).toFixed(1) + (isDaily ? '% vs yesterday' : '% vs prior period')}</span>
      <svg class="spark" viewBox="0 0 110 26" preserveAspectRatio="none" aria-hidden="true"><polyline points="${dots.join(' ')}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></section>`;
  }).join('')}</div>`;
}

function lineChart(id, labels, series, format) {
  const w = 540, h = 162;
  const high = Math.max(1, ...series.flatMap(entry => entry.values));
  return `<div class="chart"><div class="tooltip" hidden></div><svg viewBox="0 0 ${w} ${h}" role="group" aria-label="${id} chart">
    <defs><linearGradient id="${id}-fill" x1="0%" y1="0%" x2="0%" y2="100%"><stop stop-color="${colors[0]}" stop-opacity=".75"/><stop offset="100%" stop-color="${colors[0]}" stop-opacity="0"/></linearGradient></defs>
    ${[30,70,110,150].map(y => `<path d="M0 ${y}H${w}" stroke="var(--track)" stroke-dasharray="3 5"/>`).join('')}
    ${series.map((entry,i) => {
      const coords = points(entry.values,w,h,high,8);
      if (!coords.length) return '';
      return `${i === 0 ? `<polygon points="${coords[0][0]},${h} ${coords.join(' ')} ${coords.at(-1)[0]},${h}" fill="url(#${id}-fill)"/>` : ''}
        <polyline points="${coords.join(' ')}" fill="none" stroke="${entry.color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        ${coords.map(([x,y],j) => {
          const info = escape(labels[j] + ' / ' + entry.name + ': ' + format(entry.values[j]));
          return `<circle class="chart-point" tabindex="0" aria-label="${info}" data-tip="${info}" cx="${x}" cy="${y}" r="5" fill="${entry.color}" stroke="var(--surface)" stroke-width="2"/>`;
        }).join('')}`;
    }).join('')}</svg><div class="chart-meta"><span>${escape(labels[0] || '')}</span><span>${format(high)}</span><span>${escape(labels.at(-1) || '')}</span></div>
    <ul class="legend">${series.map(entry => `<li><span class="swatch" style="background:${entry.color}"></span>${escape(entry.name)}</li>`).join('')}</ul></div>`;
}

function revenueChart(items) {
  const grouped = buckets(items,state.period);
  const tabs = `<div class="segment" aria-label="Revenue interval">${['Daily','Weekly','Monthly','Yearly'].map(period => `<button type="button" data-period="${period}" aria-pressed="${state.period === period}">${period}</button>`).join('')}</div>`;
  return card('Revenue over time',lineChart('revenue',grouped.map(([label]) => label),[{name:'Revenue',color:'#b67b24',values:grouped.map(([,group]) => metrics(group,1)[0])}],money),'wide',tabs);
}

function donut(items, label, hole = true) {
  const total = items.reduce((sum,[,v]) => sum + v,0);
  let offset = 0;
  const arcs = items.map(([,v],i) => {
    const start = offset;
    offset += v / (total || 1) * 100;
    return colors[i % colors.length] + ' ' + start + '% ' + offset + '%';
  });
  return `<div class="donut" aria-hidden="true" style="background:radial-gradient(circle at 27% 20%,#ffffff70,transparent 58%),${arcs.length && total ? 'conic-gradient(' + arcs.join(',') + ')' : 'var(--track)'}">${hole ? `<strong>${label}</strong>` : ''}</div>`;
}

function breakdown(title,items,hole = true) {
  return card(title,`<div class="donut-wrap">${donut(items,number(items.reduce((sum,[,v]) => sum+v,0)),hole)}<ul class="legend">${items.map(([name,value],i) => `<li><span class="swatch" style="background:${colors[i % colors.length]}"></span>${escape(name)} <strong>${number(value)}</strong></li>`).join('')}</ul></div>`);
}

function bars(title,items,format = number,size = '',funnel = false) {
  const high = Math.max(...items.map(([,v]) => v),1);
  return card(title,`<ol class="rank ${funnel ? 'funnel' : ''}">${items.map(([name,value],i) => `<li><div class="bar-label"><span>${escape(name)}</span><strong>${format(value)}</strong></div><div class="bar" aria-hidden="true"><span style="width:${100*value/high}%;background:${colors[i%colors.length]}"></span></div></li>`).join('')}</ol>`,size);
}

function growth(items) {
  const seen = new Set();
  const grouped = buckets(items,'Weekly');
  const counts = grouped.map(([,group]) => {
    const buyers = [...new Set(group.map(o => o.customer))];
    const returning = buyers.filter(c => seen.has(c)).length;
    buyers.forEach(c => seen.add(c));
    return [buyers.length - returning, returning];
  });
  return card('Customer growth',lineChart('customers',grouped.map(([label]) => label),[
    {name:'New customers',color:'#b67b24',values:counts.map(c => c[0])},
    {name:'Returning customers',color:'#699678',values:counts.map(c => c[1])},
  ],number),'wide');
}

function heatmap(items) {
  const weekdays = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const hours = [8,10,12,14,16,18,20];
  const cells = hours.map(hour => weekdays.map((_,index) => items.filter(o => (o.date.getDay()+6)%7 === index && Math.floor(o.date.getHours()/2)*2 === hour).length));
  const high = Math.max(1,...cells.flat());
  return card('Peak order hours',`<div class="chart"><div class="tooltip" hidden></div><div class="heatmap"><span></span>${weekdays.map(d => '<span>'+d+'</span>').join('')}${cells.map((row,i) => `<span>${hours[i]}:00</span>${row.map((v,j) => `<button type="button" class="heat-cell" style="--heat:${Math.round(v/high*100)}%" data-tip="${weekdays[j]} ${hours[i]}:00: ${v} orders" aria-label="${weekdays[j]} ${hours[i]}:00: ${v} orders"></button>`).join('')}`).join('')}</div></div>`);
}

function goals(values) {
  return card('Monthly goals',`<div class="goals">${[['Revenue',values[0],targets.revenue],['Orders',values[1],targets.orders],['Satisfaction',values[9],targets.satisfaction]].map(([label,value,target]) => {
    const pct = Math.round(value / target * 100);
    return `<div><span class="sr-only">${pct}% of goal</span>${donut([['Complete',Math.min(pct,100)],['Remaining',Math.max(0,100-pct)]],pct+'%')}<small>${label}</small></div>`;
  }).join('')}</div>`);
}

function feed() {
  return `<ul class="activity" id="notification-list">${activity.map(([title,detail,time]) => `<li><strong>${escape(title)}</strong><span>${escape(detail)}</span><small>${escape(time)}</small></li>`).join('')}</ul>`;
}

function refreshFeed() {
  const list = $('notification-list');
  if (list) list.outerHTML = feed();
}

function stock() {
  const low = products.filter(p => p.stock <= 15).sort((a,b) => a.stock - b.stock);
  return card('Low stock',low.length ? `<ul class="activity">${low.map(p => `<li><strong>${escape(p.name)}</strong><small>${p.stock} units left</small></li>`).join('')}</ul>` : '<p class="muted">Stock levels are healthy.</p>');
}

function orderTable() {
  const options = [...new Set(orders.map(order => order.status))];
  const columns = [['id','Order'],['customer','Customer'],['product','Product'],['date','Date'],['status','Status'],['total','Total']];
  const sorts = columns.flatMap(([key,label]) => [
    [key + ':1', label + (key === 'date' ? ' ↑ Oldest' : ' ↑')],
    [key + ':-1', label + (key === 'date' ? ' ↓ Newest' : ' ↓')],
  ]);
  return card('Recent orders',`<div class="table-controls"><input id="order-search" type="search" aria-label="Search recent orders" placeholder="Order, customer or product"><select id="order-filter" aria-label="Filter by order status"><option value="">All statuses</option>${options.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('')}</select><select class="mobile-sort" id="order-sort" aria-label="Sort orders">${sorts.map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Recent orders table"><table class="admin-record-table" role="table"><thead><tr>${columns.map(([key,label]) => `<th scope="col"><button type="button" data-sort="${key}">${label}</button></th>`).join('')}<th scope="col">Action</th></tr></thead><tbody id="order-rows" role="rowgroup"></tbody></table></div>
    <div class="pagination"><button type="button" id="prev">Previous</button><span id="page-count" aria-live="polite"></span><button type="button" id="next">Next</button></div>`,'full');
}

function matchingOrders() {
  const query = state.query.trim().toLowerCase();
  return selectedOrders().filter(o => (!state.filter || o.status === state.filter) && [o.id,o.customer,o.product].some(text => text.toLowerCase().includes(query))).sort((a,b) => {
    const key = state.sort;
    return state.direction * (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]);
  });
}

function updateTable() {
  if (!$('order-rows')) return;
  const filtered = matchingOrders();
  const pageSize = 7;
  const pages = Math.max(1,Math.ceil(filtered.length/pageSize));
  state.page = Math.min(state.page,pages-1);
  const statuses = ['Pending','Printing','Delivered','Out for delivery','Packed','Refunded','Cancelled','Awaiting payment','Paid','Ready for pickup','Undeliverable','Refund pending','Refund needs assistance','Offline'];
  $('order-rows').innerHTML = filtered.slice(state.page*pageSize,(state.page+1)*pageSize).map(o => `<tr role="row">
    <td role="cell" data-label="Order"><strong>${escape(o.id)}</strong></td><td role="cell" data-label="Customer">${escape(o.customer)}</td><td role="cell" data-label="Product">${escape(o.product)}</td><td role="cell" data-label="Date">${o.date.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</td>
    <td role="cell" data-label="Status"><span class="chip" style="--chip:${colors[Math.max(0, statuses.indexOf(o.status)) % colors.length]}">${escape(o.status)}</span></td><td role="cell" data-label="Total">${money(o.total)}</td><td role="cell"><button type="button" data-view="${escape(o.id)}" aria-label="View ${escape(o.id)}">View order</button></td></tr>`).join('') || '<tr role="row"><td role="cell" colspan="7">No matching orders.</td></tr>';
  $('order-sort').value = state.sort + ':' + state.direction;
  $('page-count').textContent = filtered.length ? 'Page ' + (state.page+1) + ' of ' + pages + ' / ' + number(filtered.length) + ' orders' : '0 orders';
  $('prev').disabled = state.page === 0;
  $('next').disabled = state.page >= pages-1;
  root.querySelectorAll('[data-sort]').forEach(button => {
    const th = button.closest('th');
    if (button.dataset.sort === state.sort) th.setAttribute('aria-sort',state.direction === 1 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
}

function productList() {
  const row = p => {
    const unit = p.category === 'Binding' ? 'per copy' : live ? 'per page' : 'INR';
    const note = live ? unit : unit + (p.stock != null ? ' · ' + p.stock + ' in stock' : '');
    return `<li class="svc"><span class="svc-name"><strong>${escape(p.name)}</strong><small>${escape(p.category)}</small></span>
      <span class="svc-price"><b>&#8377;${p.price.toFixed(2)}</b><small>${escape(note)}</small></span>
      ${p.removeKey ? `<button type="button" class="svc-remove" data-remove-service="${escape(p.removeKey)}" data-label="${escape(p.removeLabel)}" aria-label="Remove ${escape(p.removeLabel)}">Remove</button>` : ''}</li>`;
  };
  const groups = [...new Set(products.map(p => p.category))];
  return groups.map(name => {
    const list = products.filter(p => p.category === name);
    return card(name, `<ul class="svc-grid">${list.map(row).join('')}</ul>`, 'full', `<span class="svc-head-end">${live ? `<button type="button" class="primary svc-add" data-add-service="${name === 'Binding' ? 'binding' : 'paper'}">${name === 'Binding' ? '+ Add binding' : '+ Add printing'}</button>` : ''}<span class="svc-count">${list.length} ${list.length === 1 ? 'rate' : 'rates'}</span></span>`);
  }).join('');
}

function directory(title, records, details, status = '') {
  return card(title, `<ul class="activity admin-directory">${records.map(record =>
    `<li><strong>${escape(record.name)}</strong>${details(record)}${status}</li>`).join('')}</ul>`, 'full');
}

async function refresh() {
  await source.load();
  renderOrdering();
  render();
  refreshFeed();
}

// Auto-refresh when the live feed reports a change: never while an editor is open or you are typing.
async function softRefresh() {
  if (document.hidden || $('editor').open || (root.contains(document.activeElement) && document.activeElement !== root)) return;
  try { await source.load(); } catch { return; }
  renderOrdering();
  if (!['pricing', 'ledger', 'warehouses'].includes(location.hash.slice(1)) && !location.hash.startsWith('#support')) render();
  refreshFeed();
}

async function runLive(task, done) {
  try {
    await task();
    $('editor').close();
    await refresh();
    $('notice').textContent = done;
  } catch (error) {
    $('notice').textContent = error.message;
  }
}

function liveActions(order) {
  const box = document.createElement('div');
  box.className = 'actions';
  const add = (label, path, done, question = '') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = () => { if (!question || window.confirm(question)) runLive(() => source.api('/api/admin/orders/' + order.uid + path, {}), done); };
    box.append(button);
  };
  const key = order.statusKey;
  if (key === 'out_for_delivery') {
    add('Renew delivery code', '/renew-code', 'The customer can refresh their order to see the new code.');
    add('Mark undeliverable', '/undeliverable', 'Marked undeliverable.', 'Mark this delivery as undeliverable?');
  }
  if (key === 'undeliverable' || (key === 'packed' && order.partner)) add('Reassign delivery', '/reassign', 'The order is back in the pool for delivery partners.');
  if (key === 'paid' && !order.captured) add('Cancel order', '/cancel', 'Order cancelled.', 'Cancel this unprinted order?');
  if ((order.captured || source.info.paymentMode === 'test') && ['paid', 'undeliverable', 'refund_pending'].includes(key)) {
    add(key === 'refund_pending' ? 'Reconcile refund' : 'Refund order', '/refund', 'Refund requested.', key === 'refund_pending' ? '' : 'Request a full refund and stop fulfilment?');
  }
  if (!box.children.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No actions are available for this order.';
    box.append(none);
  }
  return box;
}

const servicePapers = {A3: 'A3 printing', A5: 'A5 printing'};
const serviceBindings = {spiral: 'Spiral binding', staple: 'Staple binding'};
const serviceRateLabels = ['B&W single-sided', 'B&W double-sided', 'Colour single-sided', 'Colour double-sided'];

let serviceFilter = '';   // 'paper' or 'binding': which Add button opened the editor

function availableServices() {
  const terms = source.info.terms;
  return [
    ...(serviceFilter === 'binding' ? [] : Object.entries(servicePapers).filter(([key]) => !terms.paperRates[key]).map(([key, label]) => ['paper:' + key, label])),
    ...(serviceFilter === 'paper' ? [] : Object.entries(serviceBindings).filter(([key]) => !(key in terms.bindingRates)).map(([key, label]) => ['binding:' + key, label])),
  ];
}

function serviceEditorFields() {
  const options = availableServices();
  if (!options.length) return '<p class="muted">All available ' + (serviceFilter === 'binding' ? 'binding options' : serviceFilter === 'paper' ? 'printing options' : 'services') + ' are already offered. Use the Pricing page to change their rates.</p>';
  return `<label>Service<select name="service">${options.map(([value, label]) => `<option value="${value}">${escape(label)}</option>`).join('')}</select></label>
    <div id="service-paper-rates">${serviceRateLabels.map((label, i) => `<label>${label} (INR per page)<input name="rate${i}" type="number" min="1" step="0.01" inputmode="decimal"></label>`).join('')}</div>
    <div id="service-binding-rate"><label>Price (INR per copy)<input name="bindingRate" type="number" min="0" step="0.01" inputmode="decimal"></label></div>`;
}

function wireServiceEditor() {
  const select = $('editor-form').elements.service;
  if (!select) { $('save-editor').hidden = true; return; }
  const sync = () => {
    const paper = select.value.startsWith('paper:');
    $('service-paper-rates').hidden = !paper;
    $('service-binding-rate').hidden = paper;
    for (const input of $('service-paper-rates').querySelectorAll('input')) input.required = paper;
    $('service-binding-rate').querySelector('input').required = !paper;
  };
  select.onchange = sync;
  sync();
}

// Publishes a new pricing version with a service added or removed (everything else stays as it is).
async function changeServices(change) {
  const terms = source.info.terms;
  const changes = {paperRates: {...terms.paperRates}, bindingRates: {...terms.bindingRates}};
  change(changes);
  const result = await source.api('/api/admin/pricing', {version: source.info.pricingVersion, changes});
  source.info.pricingVersion = result.version;
}

const paise = value => Math.round(Number(value) * 100);

function livePartners() {
  const rows = partners.map(partner => {
    const who = String(partner.name || partner.email || partner.id || '?');
    return `<li class="partner-row"><span class="partner-avatar" aria-hidden="true">${escape(who[0].toUpperCase())}</span>
      <span class="partner-main"><strong>${escape(who)}</strong><small>${escape(partner.email || '')}${partner.phone ? ' · ' + escape(partner.phone) : ''}</small><small>${number(partner.deliveries)} deliveries &middot; earned ${money(partner.accrued / 100)} &middot; unsettled ${money(partner.outstanding / 100)}</small></span>
      <span class="partner-side"><span class="directory-verified">Verified</span>${partner.removable ? `<button type="button" class="partner-remove" data-remove-partner="${escape(partner.email)}">Remove access</button>` : ''}</span></li>`;
  }).join('');
  return card('Delivery partners', rows ? `<ul class="partner-list">${rows}</ul>` : '<p class="muted">No delivery partners yet. Use “Add verified partner” to give someone access with their Google email.</p>', 'full') +
    card('Partner settlements', source.payouts.length ? '<div id="live-settlements" class="settlements"></div>' : '<p class="muted">No outstanding settlements.</p>', 'full');
}

function buildSettlements(host) {
  for (const payout of source.payouts) {
    const row = document.createElement('div');
    row.className = 'table-controls';
    const amount = document.createElement('strong');
    amount.textContent = money(payout.amount / 100) + ' · ' + payout.partner;
    const reference = document.createElement('input');
    reference.maxLength = 100;
    reference.placeholder = 'Transfer reference';
    reference.setAttribute('aria-label', 'Transfer reference for ' + payout.partner);
    const record = document.createElement('button');
    record.type = 'button';
    record.textContent = 'Record settlement';
    record.onclick = async () => {
      if (!reference.value.trim()) { $('notice').textContent = 'Enter the completed transfer reference.'; return; }
      try {
        await source.api('/api/admin/payouts/' + payout.order_id + '/record', {reference: reference.value});
        await refresh();
        $('notice').textContent = 'Settlement recorded.';
      } catch (error) { $('notice').textContent = error.message; }
    };
    row.append(amount, reference, record);
    host.append(row);
  }
}

function liveWarehouses() {
  return directory('Warehouse directory', warehouses, warehouse =>
    `<span>${escape(warehouse.address)}</span><small>${escape(warehouse.email)}${warehouse.is_default ? ' &middot; Default pickup' : ''}</small><dl class="warehouse-revenue"><div><dt>Online revenue</dt><dd>${money((warehouse.revenue || 0) / 100)}</dd></div><div><dt>Paid orders</dt><dd>${number(warehouse.paidOrders || 0)}</dd></div></dl><small>Paid online orders linked to this store. Excludes cancellations and refunds.</small><span class="wh-row-actions"><a href="${escape(pickupMapUrl(warehouse.address))}" target="_blank" rel="noopener">Pickup on Google Maps</a><button type="button" class="partner-remove" data-remove-warehouse="${warehouse.id}" data-label="${escape(warehouse.name)}">Remove warehouse</button></span>`);
}

function previewLedger(page, filter) {
  const totals = {payment:0, offline:0, refund:0, payout:0};
  const rows = [];
  function add(order, kind, amount, description) {
    rows.push({order_number:order.id, kind, amount, description, reference:'', date:order.date.getTime() / 1000});
    totals[kind] += amount;
  }
  for (const order of orders) {
    if (['Pending','Cancelled'].includes(order.status)) continue;
    const amount = Math.round(order.total * 100);
    if (order.status === 'Offline') add(order,'offline',amount,order.product);
    else {
      add(order,'payment',amount,'Sample online payment');
      if (order.status === 'Refunded') add(order,'refund',-amount,'Sample refund');
    }
  }
  const matching = rows.filter(row => !filter || row.kind === filter).sort((a,b) => b.date-a.date);
  const pages = Math.max(1, Math.ceil(matching.length / 25));
  page = Math.min(page,pages);
  return {totals,page,pages,entries:matching.slice((page - 1) * 25,page * 25)};
}

let supportCleanup = null;
function render(animate = false) {
  supportCleanup?.();
  supportCleanup = null;
  const [slug, subRoute = ''] = location.hash.slice(1).split('/');
  const route = Object.hasOwn(sections, slug) ? slug : Object.hasOwn(oldSections, slug) ? oldSections[slug] : 'dashboard';
  if (slug && slug !== route) history.replaceState(history.state, '', '#' + route);
  const items = selectedOrders(), paid = sales(items), values = metrics(items,orderWindowDays);
  const productsRank = aggregate(paid,'product',o => o.total).slice(0,5);
  const customersRank = aggregate(paid,'customer',o => o.total).slice(0,5);
  const regionRank = aggregate(items,'region');
  let widgets;
  switch (route) {
    case 'ledger': widgets = card('Transactions', '<div id="preview-ledger" class="ledger-panel"></div>', 'full'); break;
    case 'pricing': widgets = card('Checkout rates', '<div id="pricing-form"></div>', 'full'); break;
    case 'orders': widgets = orderTable(); break;
    case 'support': widgets = '<section class="card full sp-shell"><div id="support-host"></div></section>'; break;
    case 'customers': widgets = growth(items) + bars('Top 5 customers',customersRank,money) + bars('Delivery regions',regionRank); break;
    case 'inventory': widgets = live ? productList() : productList() + stock(); break;
    case 'analytics':
      widgets = live ? revenueChart(items) + bars('Sales by category',aggregate(paid,'category',o => o.total),money) + heatmap(items) + breakdown('Orders by status',aggregate(items,'status'))
        : revenueChart(items) + bars('Sales by category',aggregate(paid,'category',o => o.total),money) +
        bars('Top 5 products',productsRank,money) + goals(metrics(orders.filter(o => o.date > day(orderWindowDays)),orderWindowDays)) + heatmap(items) +
        breakdown('Traffic sources',traffic,false) +
        bars('Conversion funnel',[['Visitors',orderWindowDays*333],['Signups',values[3]],['Orders',paid.length],['Repeat customers',Math.min(paid.length,Math.round(values[6]*values[2]/100))]],number,'',true);
      break;
    case 'partners': widgets = live ? livePartners() : directory('Verified delivery partners', partners, partner =>
      `<span>${escape(partner.email)}</span>`, '<small class="directory-verified">Verified</small>'); break;
    case 'warehouses': widgets = live ? liveWarehouses() : directory('Warehouse directory', warehouses, warehouse =>
      `<span>${escape(warehouse.location)}</span><small>${escape(warehouse.email)}</small><a href="${escape(pickupMapUrl(warehouse.address))}" target="_blank" rel="noopener">Pickup on Google Maps</a>`); break;
    default:
      widgets = kpis(items) + revenueChart(items) + breakdown('Orders by status',aggregate(items,'status'));
  }
  $('page-title').textContent = sections[route][0];
  $('page-description').hidden = route !== 'dashboard';
  document.querySelectorAll('[data-page-actions]').forEach(group => {
    group.hidden = group.dataset.pageActions !== route;
  });
  document.querySelectorAll('[data-nav]').forEach(link => {
    if (link.dataset.nav === route) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  root.innerHTML = `<div class="grid${animate ? ' arrive' : ''}">${widgets}</div>`;
  if (live && route === 'support') supportCleanup = mountSupport($('support-host'), subRoute);
  if (route === 'ledger') {
    if (live) buildLedger($('preview-ledger'), (page, kind) => source.api('/api/admin/ledger?' + new URLSearchParams({page, kind})))();
    else buildLedger($('preview-ledger'), previewLedger, {demo:true})();
  }
  if (live && route === 'inventory') {
    for (const button of document.querySelectorAll('[data-remove-service]')) {
      button.onclick = () => {
        const [type, key] = button.dataset.removeService.split(':');
        if (!window.confirm('Stop offering ' + button.dataset.label + ' at checkout? Existing orders are not affected.')) return;
        runLive(() => changeServices(changes => { delete changes[type === 'paper' ? 'paperRates' : 'bindingRates'][key]; }), button.dataset.label + ' removed.');
      };
    }
  }
  if (live && route === 'warehouses') {
    for (const button of document.querySelectorAll('[data-remove-warehouse]')) {
      button.onclick = () => {
        if (window.confirm('Remove warehouse ' + button.dataset.label + '? Its staff email loses warehouse access.')) {
          runLive(() => source.api('/api/admin/warehouses/remove', {id: Number(button.dataset.removeWarehouse)}), 'Warehouse removed.');
        }
      };
    }
  }
  if (live && route === 'partners') {
    if ($('live-settlements')) buildSettlements($('live-settlements'));
    for (const button of document.querySelectorAll('[data-remove-partner]')) {
      button.onclick = () => {
        if (window.confirm('Remove delivery access for ' + button.dataset.removePartner + '?')) {
          runLive(() => source.api('/api/admin/partners/remove', {email: button.dataset.removePartner}), 'Partner access removed.');
        }
      };
    }
  }
  if (route === 'pricing' && live) {
    $('pricing-form').append(buildPricingForm(source.info.terms, async changes => {
      const result = await source.api('/api/admin/pricing', {version: source.info.pricingVersion, changes});
      source.info.pricingVersion = result.version;
      return 'Pricing version ' + result.version + ' published.';
    }));
  } else if (route === 'pricing') {
    const customerPreview = document.createElement('a');
    customerPreview.href = previewPricingUrl;
    customerPreview.target = '_blank';
    customerPreview.rel = 'noopener';
    customerPreview.textContent = 'Open customer pricing preview';
    $('pricing-form').append(buildPricingForm(readPreviewPricing(), changes => {
      savePreviewPricing(changes);
      return 'Preview pricing saved in this browser.';
    }, {demo:true}), customerPreview);
  }
  root.removeAttribute('aria-busy');
  if ($('order-search')) {
    $('order-search').value = state.query;
    $('order-filter').value = state.filter;
    updateTable();
  }
  if (animate && !reduced.matches) {
    root.querySelectorAll('.grid > *, .metric').forEach((el,i) => el.style.setProperty('--index',Math.min(i,12)));
    const start = performance.now();
    const values = [...root.querySelectorAll('[data-metric]')];
    function frame(now) {
      const t = Math.min(1,(now-start)/450);
      values.forEach(el => { el.textContent = metricFormats[el.dataset.metric](Number(el.dataset.value) * (1-(1-t)**3)); });
      if (t < 1) requestAnimationFrame(frame);
    }
    if (values.length) requestAnimationFrame(frame);
  }
}

function navLink(route) {
  const [label, glyph] = sections[route];
  const badge = route === 'support' ? '<i class="nav-badge" id="support-badge" hidden></i>' : '';
  return `<a class="nav-link" data-nav="${route}" href="#${route}" aria-label="${label}" title="${label}">${icon(glyph)}<span>${label}</span>${badge}</a>`;
}

const routes = Object.keys(sections);
$('sidebar-nav').innerHTML = routes.map(navLink).join('');
$('sidebar-nav').querySelectorAll('.nav-link').forEach((link, i) => link.style.setProperty('--n', i));
$('notification-list').outerHTML = feed();
$('notifications').innerHTML = icon('M18 8a6 6 0 0 0-12 0v5l-2 3h16l-2-3z M10 20h4');

const phone = matchMedia('(max-width: 850px)');
const menuGlyph = '<img src="printbee-header-bee.webp" width="32" height="29" alt=""><span>PrintBee</span>', panelGlyph = icon('M4 5h16v14H4z M9 5v14');
const setNav = open => {
  document.body.classList.toggle('nav-open', open);
  $('collapse').setAttribute('aria-expanded', String(phone.matches ? open : !document.querySelector('.workspace').classList.contains('compact')));
  $('collapse').setAttribute('aria-label', phone.matches ? (open ? 'Close menu' : 'Open menu') : 'Collapse sidebar');
};
const syncNavButton = () => { $('sidebar-nav').querySelectorAll('.nav-link').forEach(link => phone.matches ? link.removeAttribute('title') : link.setAttribute('title', link.getAttribute('aria-label'))); $('collapse').innerHTML = phone.matches ? menuGlyph : panelGlyph; setNav(false); };
phone.addEventListener('change', syncNavButton);
syncNavButton();
$('collapse').onclick = () => {
  if (phone.matches) return setNav(!document.body.classList.contains('nav-open'));
  const compact = document.querySelector('.workspace').classList.toggle('compact');
  $('collapse').setAttribute('aria-expanded',String(!compact));
  $('collapse').setAttribute('aria-label',compact ? 'Expand sidebar' : 'Collapse sidebar');
};
$('sidebar-nav').addEventListener('click', event => { if (event.target.closest('a')) setNav(false); });
document.getElementById('nav-close')?.addEventListener('click', () => setNav(false));
document.getElementById('nav-scrim')?.addEventListener('click', () => setNav(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('nav-open')) setNav(false); });

const popovers = [['notifications','notification-panel'],['profile','profile-panel']];
function closePopovers() {
  popovers.forEach(([button,panel]) => { $(panel).hidden=true; $(button).setAttribute('aria-expanded','false'); });
}
popovers.forEach(([button,panel]) => {
  $(button).onclick = () => {
    const open = $(panel).hidden;
    closePopovers();
    $(panel).hidden = !open;
    $(button).setAttribute('aria-expanded',String(open));
  };
});
document.addEventListener('click',event => {
  if (!popovers.some(([button,panel]) => $(button).contains(event.target) || $(panel).contains(event.target))) closePopovers();
});
document.addEventListener('keydown',event => {
  if (event.key !== 'Escape') return;
  const open = popovers.find(([,panel]) => !$(panel).hidden);
  if (open) {
    closePopovers();
    $(open[0]).focus();
  }
});

addEventListener('hashchange',() => {
  closePopovers();
  render(true);
  $('main').focus({preventScroll:true});
  $('admin-workarea').scrollTop = 0;
  scrollTo(0,0);
});
root.addEventListener('input',event => {
  if (event.target.id === 'order-search') { state.query = event.target.value; state.page = 0; updateTable(); }
  if (event.target.id === 'order-filter') { state.filter = event.target.value; state.page = 0; updateTable(); }
  if (event.target.id === 'order-sort') {
    const [key, direction] = event.target.value.split(':');
    state.sort = key;
    state.direction = Number(direction);
    state.page = 0;
    updateTable();
  }
});

const directoryEditors = {
  partner: {
    title:'Add verified delivery partner',
    fields:'<label>Full name<input name="name" autocomplete="name" required maxlength="70"></label><label>Google account email<input name="email" type="email" autocomplete="off" required maxlength="254"></label><label>Phone number<input name="phone" type="tel" autocomplete="tel" pattern="[+0-9 ()-]{7,20}" required maxlength="20"></label><label>SRM roll number (optional)<input name="rollNo" maxlength="40"></label><label>Driving licence number<input name="licence" required maxlength="40"></label><label>Payout UPI ID<input name="payout" placeholder="name@bank" required maxlength="150"></label><label>Vehicle name<input name="vehicle" placeholder="Vehicle model or name" required maxlength="100"></label><label class="directory-confirm"><input name="verified" type="checkbox" required> I have verified this delivery partner’s identity and driving licence.</label>',
  },
  warehouse: {
    title:'Add warehouse',
    fields:'<label>Warehouse name<input name="name" required maxlength="70"></label><label>Campus or location<input name="location" required maxlength="140"></label><label>Google Maps pickup address or coordinates<input name="address" required maxlength="500"></label><label>Staff Google account email<input name="email" type="email" autocomplete="off" required maxlength="254"></label>',
  },
};

if (live) directoryEditors.product = {title: 'Add print service', fields: ''};
if (live) directoryEditors.warehouse.fields = '<label>Warehouse name<input name="name" required maxlength="70"></label><label>Google Maps pickup address or coordinates<input name="address" required maxlength="500"></label><label>Staff Google account email<input name="email" type="email" autocomplete="off" required maxlength="254"></label><label class="directory-confirm"><input name="useForPickup" type="checkbox"> Use for new order pickups</label>';

let readOfflineOrders;

function openEditor(kind, id) {
  $('editor-error').textContent = '';
  const isOrder = kind === 'order';
  const existing = id && orders.find(o => o.id === id);
  const directoryEditor = directoryEditors[kind];
  $('editor-title').textContent = existing?.id || directoryEditor?.title || (isOrder ? 'Add offline orders' : 'Add sample product');
  $('editor-form').dataset.kind = kind;
  $('save-editor').hidden = Boolean(existing);
  $('editor-fields').innerHTML = existing ? `<p><strong>${escape(existing.customer)}</strong></p><p>${escape(existing.product)} &middot; ${money(existing.total)}</p><p>${escape(existing.status)} &middot; ${escape(existing.region)}</p>` :
    directoryEditor?.fields ?? (isOrder ? '' :
    '<label>Product name<input name="name" required maxlength="70"></label><label>Category<input name="category" required maxlength="70"></label><label>Price (INR)<input name="price" type="number" min=".01" max="999999" step=".01" required></label><label>Stock<input name="stock" type="number" min="0" max="999999" required></label>');
  if (live && kind === 'product') {
    $('editor-title').textContent = serviceFilter === 'binding' ? 'Add binding' : serviceFilter === 'paper' ? 'Add printing service' : 'Add print service';
    $('editor-fields').innerHTML = serviceEditorFields();
    wireServiceEditor();
  }
  if (live && existing) $('editor-fields').append(liveActions(existing));
  if (isOrder && !existing) readOfflineOrders = addOfflineOrderFields($('editor-fields'), products);
  $('editor').showModal();
}

root.addEventListener('click',event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.period) {
    state.period = button.dataset.period;
    render();
    root.querySelector('[aria-pressed="true"][data-period]')?.focus();
  }
  if (button.dataset.sort) {
    const key = button.dataset.sort;
    state.direction = state.sort === key ? -state.direction : 1;
    state.sort = key;
    state.page = 0;
    updateTable();
  }
  if (button.id === 'prev' || button.id === 'next') { state.page += button.id === 'prev' ? -1 : 1; updateTable(); }
  if (button.dataset.view) openEditor('order',button.dataset.view);
  if (button.dataset.addService) { serviceFilter = button.dataset.addService; openEditor('product'); }
});

function tooltip(event,show) {
  const mark = event.target.closest('[data-tip]');
  if (!mark) return;
  const tip = mark.closest('.chart').querySelector('.tooltip');
  tip.hidden = !show;
  if (show) tip.textContent = mark.dataset.tip;
}
for (const [event,show] of [['pointerover',true],['pointerout',false],['focusin',true],['focusout',false]]) root.addEventListener(event,e => tooltip(e,show));
$('add-order').onclick = () => openEditor('order');
$('add-product').onclick = () => { serviceFilter = live ? 'paper' : ''; openEditor('product'); };
if ($('add-binding')) $('add-binding').onclick = () => { serviceFilter = 'binding'; openEditor('product'); };
$('add-partner').onclick = () => openEditor('partner');
$('add-warehouse').onclick = () => openEditor('warehouse');
$('close-editor').onclick = () => $('editor').close();
$('editor-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  function invalid(field, message) {
    field.setCustomValidity(message);
    field.reportValidity();
    field.addEventListener('input', () => field.setCustomValidity(''), {once:true});
  }
  for (const field of form.querySelectorAll('input:not([type="number"], [type="checkbox"])')) {
    if (!field.required || field.value.trim()) continue;
    invalid(field, 'Enter a value.');
    return;
  }
  const kind = form.dataset.kind;
  if (live) {
    try {
      if (kind === 'product') {
        const [type, key] = data.get('service').split(':');
        await changeServices(changes => {
          if (type === 'paper') changes.paperRates[key] = [0, 1, 2, 3].map(i => paise(data.get('rate' + i)));
          else changes.bindingRates[key] = paise(data.get('bindingRate'));
        });
        $('notice').textContent = 'Service added. Customers can choose it at checkout now.';
      } else if (kind === 'partner') {
        await source.api('/api/admin/partners', {...Object.fromEntries(['name','email','phone','rollNo','licence','payout','vehicle'].map(key => [key, data.get(key).trim()])), verified:data.has('verified')});
        $('notice').textContent = '';   // the new partner appears in the list below
      } else if (kind === 'warehouse') {
        await source.api('/api/admin/warehouses', {name: data.get('name').trim(), address: data.get('address').trim(), email: data.get('email').trim().toLowerCase(), useForPickup: data.has('useForPickup') || !warehouses.length});
        $('notice').textContent = '';   // the warehouse appears in the list below
      } else if (kind === 'order') {
        const result = await source.api('/api/admin/offline-orders', {orders: readOfflineOrders()});
        $('notice').textContent = result.saved ? 'Offline orders saved.' : 'These orders are already saved.';
      }
      $('editor').close();
      await refresh();
    } catch (error) {
      $('editor-error').textContent = error.message;
    }
    return;
  }
  if (kind === 'partner') {
    if (!data.has('verified')) return;
    const email = data.get('email').trim().toLowerCase();
    if (partners.some(partner => partner.email === email)) {
      invalid(form.elements.email, 'This partner is already in the directory.');
      return;
    }
    partners.push({...Object.fromEntries(['name','phone','rollNo','licence','payout','vehicle'].map(key => [key, data.get(key).trim()])), email});
  } else if (kind === 'warehouse') {
    warehouses.push({name:data.get('name').trim(), location:data.get('location').trim(), address:data.get('address').trim(), email:data.get('email').trim().toLowerCase()});
  } else if (kind === 'order') {
    const batch = readOfflineOrders().map(order => {
      const product = products.find(item => item.name === order.product);
      return {id:'PB-DEMO-' + order.id.slice(0,8).toUpperCase(),customer:order.customer,
        product:product.name,category:product.category,region:'Offline',date:new Date(),
        total:Number(order.amount),status:'Offline'};
    });
    orders.unshift(...batch);
    $('editor').close();
    $('notice').textContent = batch.length + ' offline ' + (batch.length === 1 ? 'order' : 'orders') + ' added for this session.';
    render();
    return;
  } else {
    products.push({name:data.get('name').trim(),category:data.get('category').trim(),price:Number(data.get('price')),stock:Number(data.get('stock'))});
  }
  $('editor').close();
  $('notice').textContent = 'Sample ' + (kind === 'partner' ? 'delivery partner' : kind) + ' added for this session.';
  render();
};

function csvCell(value) {
  const text = String(value);
  return '"' + (/^[=+@\-\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"','""') + '"';
}

$('export-csv').onclick = () => {
  const rows = [['Order','Customer','Service','Date','Status','Total (INR)'],...matchingOrders().map(o => [o.id,o.customer,o.product,o.date.toISOString(),o.status,o.total])];
  const url = URL.createObjectURL(new Blob([rows.map(row => row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = live ? 'printbee-orders.csv' : 'printbee-sample-orders.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
};
$('export-pdf').onclick = () => window.print();

if (live) {
  const workspace = document.querySelector('.workspace');
  workspace.hidden = true;
  document.querySelector('[data-page-actions="inventory"]')?.remove();   // the Add buttons live on their own cards
  let feedConnection;
  connectPortal('admin', $('ops-status'), async () => {
    await source.load();
    renderOrdering();
    workspace.hidden = false;
    document.querySelector('.live-gate').hidden = true;
    refreshFeed();
    render(true);
    const supportPoll = () => { supportBadge(); supportNotifications(); };
    supportPoll();
    setInterval(supportPoll, 45000);
    // Orders and statuses update the moment they change; the timer is only a safety net.
    feedConnection = window.PrintBeeLive?.start({as: 'admin', onSync: softRefresh});
    setInterval(softRefresh, 45000);
  }, () => feedConnection?.stop());
} else {
  requestAnimationFrame(() => render(true));
}
