const login = document.querySelector('#staff-login');
const statusLine = document.querySelector('#staff-status');
const orders = document.querySelector('#staff-orders');
const keyField = document.querySelector('#staff-key');
const actions = {
  warehouse: {paid: 'Start printing', printing: 'Mark packed'},
  delivery: {packed: 'Collect for delivery', out_for_delivery: 'Mark delivered'},
};
const labels = {
  paid: 'Paid in test checkout', printing: 'Printing', packed: 'Packed',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered',
};

async function request(path, key, options = {}) {
  const response = await fetch(path, {...options, headers: {'X-Staff-Key': key, ...options.headers}});
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

function button(text, action) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'clay-button';
  control.textContent = text;
  control.addEventListener('click', async () => {
    control.disabled = true;
    try {
      await action();
    } catch (error) {
      statusLine.textContent = error.message;
    } finally {
      control.disabled = false;
    }
  });
  return control;
}

async function loadOrders(key) {
  const response = await request('/api/staff/orders', key);
  const data = await response.json();
  orders.replaceChildren();
  statusLine.textContent = (data.role === 'warehouse' ? 'Warehouse' : 'Delivery') + ' · ' + data.orders.length + ' orders';
  for (const order of data.orders) {
    const card = document.createElement('article');
    card.className = 'clay-card';
    const title = document.createElement('h2');
    title.textContent = order.number || 'PB-' + order.id.slice(0, 8).toUpperCase();
    const badge = document.createElement('span');
    badge.className = 'clay-badge';
    badge.textContent = labels[order.status];
    const customer = document.createElement('p');
    customer.textContent = [order.customer, order.phone, order.address].join(' · ');
    card.append(title, badge, customer);
    if (order.slot || order.notes) {
      const delivery = document.createElement('p');
      delivery.textContent = [order.slot, order.notes].filter(Boolean).join(' · ');
      card.append(delivery);
    }
    if (data.role === 'warehouse') {
      const files = document.createElement('ul');
      order.items.forEach((item, index) => {
        const row = document.createElement('li');
        const spec = document.createElement('p');
        spec.textContent = [
          item.name, item.pages + ' pages × ' + item.copies + ' copies',
          item.pageRange && 'Print pages ' + item.pageRange.join(', '),
          item.colourPages ? 'Colour pages ' + item.colourPages.join(', ') + ' · remaining B&W' : item.colour ? 'Colour' : 'Black & white',
          item.duplex ? 'Double-sided' : 'Single-sided', item.orientation,
          {glossy: 'Glossy binding · White transparent sheet', blue: 'Blue sheet binding'}[item.binding] || 'No binding',
        ].filter(Boolean).join(' · ');
        row.append(spec, button('Download print file', async () => {
          const response = await request('/api/staff/files/' + order.id + '/' + index, key);
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement('a');
          link.href = url;
          link.download = item.name;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }));
        files.append(row);
      });
      card.append(files);
    }
    const action = actions[data.role][order.status];
    if (action) card.append(button(action, async () => {
      await request('/api/staff/orders/' + order.id + '/advance', key, {
        method: 'POST', headers: {'X-Order-Status': order.status},
      });
      await loadOrders(key);
    }));
    orders.append(card);
  }
}

login.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await loadOrders(keyField.value);
  } catch (error) {
    orders.replaceChildren();
    statusLine.textContent = error.message || 'Could not load orders.';
  }
});
