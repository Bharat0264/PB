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

async function admin() {
  const data = await api('/api/admin');
  const money = value => new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR'}).format(value / 100);
  const totals = element('section');
  totals.className = 'clay-card';
  totals.append(element('h2', 'Order overview'), element('p', money(data.captured) + ' captured in Razorpay'));
  const counts = element('ul');
  for (const [state, count] of Object.entries(data.counts)) counts.append(element('li', state.replaceAll('_', ' ') + ' · ' + count));
  totals.append(counts);
  const orders = element('section');
  orders.className = 'clay-card';
  orders.append(element('h2', 'Recent orders'));
  const list = element('ul');
  for (const order of data.orders) {
    const row = element('li', [
      order.order_number || 'PB-' + order.id.slice(0, 8).toUpperCase(),
      order.status.replaceAll('_', ' '), money(order.total),
    ].join(' · '));
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
  const csv = action('Export recent orders CSV', () => {
    const rows = data.orders.map(order => [order.order_number || order.id, order.status, order.total]);
    const blob = new Blob([['Order,Status,Total (paise)', ...rows.map(row => row.join(','))].join('\r\n')],
      {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = 'printbee-orders.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  orders.append(csv);
  orders.append(list);
  const pricing = element('section');
  pricing.className = 'clay-card';
  const label = element('label', 'Checkout pricing');
  const editor = element('textarea');
  editor.className = 'clay-input';
  editor.rows = 14;
  editor.value = JSON.stringify(data.terms, null, 2);
  label.append(editor);
  pricing.append(label, action('Publish pricing', async () => {
    const result = await api('/api/admin/pricing', JSON.parse(editor.value));
    statusLine.textContent = 'Pricing version ' + result.version + ' published.';
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
    row.append(element('p', money(payout.amount)), label, action('Record settlement', async () => {
      if (!reference.value.trim()) throw new Error('Enter the completed transfer reference.');
      await api('/api/admin/payouts/' + payout.order_id + '/record', {reference: reference.value});
      await admin();
    }));
    settlements.append(row);
  }
  content.replaceChildren(action('Refresh dashboard', admin), totals, orders, pricing, settlements, audit);
}

connectPortal(portal, statusLine, portal === 'partner' ? partnerOrders : admin, stopSharing);
