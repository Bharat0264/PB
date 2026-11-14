const statusLine = document.querySelector('#staff-status');
const orders = document.querySelector('#staff-orders');
const filters = document.querySelector('#warehouse-filters');
const search = document.querySelector('#warehouse-search');
const stateFilter = document.querySelector('#warehouse-state');
const actions = {
  warehouse: {paid: 'Start printing', printing: 'Mark packed'},
  delivery: {packed: 'Collect for delivery', out_for_delivery: 'Mark delivered'},
};
const labels = {
  paid: 'Payment confirmed', printing: 'Printing', packed: 'Packed',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered',
};

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

async function downloadFile(path, filename) {
  const response = await request(path);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

async function loadOrders() {
  const response = await request('/api/staff/orders');
  const data = await response.json();
  orders.replaceChildren();
  filters.hidden = false;
  statusLine.textContent = data.orders.length + ' orders · Print agent ' + (data.agentOnline ? 'online' : 'offline');
  for (const order of data.orders) {
    const card = document.createElement('article');
    card.className = 'clay-card';
    const title = document.createElement('h2');
    title.textContent = order.number || 'PB-' + order.id.slice(0, 8).toUpperCase();
    card.dataset.number = title.textContent.toLowerCase();
    card.dataset.status = order.status;
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
          item.duplex ? 'Double-sided' : 'Single-sided', item.orientation, item.paper || 'A4',
          {glossy: 'Glossy binding · White transparent sheet', blue: 'Blue sheet binding',
            spiral: 'Spiral binding', staple: 'Staple binding'}[item.binding] || 'No binding',
        ].filter(Boolean).join(' · ');
        row.append(spec, button('Download print file', () =>
          downloadFile('/api/staff/files/' + order.id + '/' + index, item.name)));
        const job = order.jobs.find(entry => entry.position === index);
        if (job) {
          const result = document.createElement('p');
          result.textContent = 'Job ' + job.id + ' · ' + job.state + (job.error ? ' · ' + job.error : '');
          row.append(result);
        }
        if (['paid', 'printing'].includes(order.status) && (!job || job.state === 'failed')) {
          row.append(button(job ? 'Retry print' : 'Print file', async () => {
            await request('/api/staff/orders/' + order.id + '/print/' + index, {method: 'POST'});
            await loadOrders();
          }));
          row.append(button('Confirm manually printed', async () => {
            await request('/api/staff/orders/' + order.id + '/printed/' + index, {method: 'POST'});
            await loadOrders();
          }));
        }
        files.append(row);
      });
      card.append(files);
      if (['paid', 'printing'].includes(order.status)) card.append(button('Print all', async () => {
        await request('/api/staff/orders/' + order.id + '/print/all', {method: 'POST'});
        await loadOrders();
      }));
      if (order.status === 'packed') card.append(button('Download packing label', () =>
        downloadFile('/api/staff/orders/' + order.id + '/label', title.textContent + '-packing.pdf')));
    }
    const action = actions[data.role][order.status];
    if (action) card.append(button(action, async () => {
      await request('/api/staff/orders/' + order.id + '/advance', {
        method: 'POST', headers: {'X-Order-Status': order.status},
      });
      await loadOrders();
    }));
    orders.append(card);
  }
  filterOrders();
}

function filterOrders() {
  const query = search.value.trim().toLowerCase();
  for (const card of orders.children) {
    card.hidden = !card.dataset.number.includes(query) ||
      (stateFilter.value !== '' && card.dataset.status !== stateFilter.value);
  }
}

filters.addEventListener('input', filterOrders);

connectPortal('warehouse', statusLine, async () => {
  await loadOrders();
  setInterval(() => {
    if (!document.hidden && !orders.contains(document.activeElement)) {
      loadOrders().catch(() => { statusLine.textContent = 'Could not refresh orders.'; });
    }
  }, 10000);
});
