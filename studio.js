const form = document.querySelector('#queue-form');
const queueList = document.querySelector('#queue-list');
const status = document.querySelector('#queue-status') || document.querySelector('#order-status');
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('printbee-local', 2);
  request.onupgradeneeded = event => {
    if (event.oldVersion < 1) request.result.createObjectStore('documents', {autoIncrement: true});
    request.result.createObjectStore('orders', {keyPath: 'id'});
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function queueAction(mode, action) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('documents', mode);
    const request = action(transaction.objectStore('documents'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

function queueButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

const batchOrder = document.querySelector('#batch-order');
const orderSelected = document.querySelector('#order-selected');
const selectAll = document.querySelector('#select-all');
const selectedIds = new Set();

async function showQueue() {
  if (!queueList) return;
  const db = await database;
  const entries = await new Promise((resolve, reject) => {
    const transaction = db.transaction('documents');
    const cursor = transaction.objectStore('documents').openCursor(null, 'prev');
    const results = [];
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      results.push([cursor.result.key, cursor.result.value]);
      cursor.result.continue();
    };
    transaction.oncomplete = () => resolve(results);
    transaction.onabort = () => reject(transaction.error);
  });
  queueList.replaceChildren();
  batchOrder.hidden = entries.length === 0;
  const controls = [];

  function updateSelection() {
    const selected = entries.filter(([id]) => selectedIds.has(id));
    orderSelected.hidden = selected.length === 0;
    orderSelected.textContent = 'Continue to checkout (' + selected.length + ')';
    orderSelected.onclick = () => openCheckout(selected);
    selectAll.textContent = selected.length === entries.length ? 'Clear selection' : 'Select all';
  }

  selectAll.onclick = () => {
    const checked = controls.some(([, input]) => !input.checked);
    for (const [id, input] of controls) {
      input.checked = checked;
      if (checked) selectedIds.add(id);
      else selectedIds.delete(id);
    }
    updateSelection();
  };
  for (const [id, entry] of entries) {
    const row = document.createElement('li');
    const name = document.createElement('strong');
    const settings = document.createElement('small');
    name.textContent = entry.file.name;
    settings.textContent = entry.settings;
    const download = queueButton('Download', () => {
      const url = URL.createObjectURL(entry.file);
      const link = document.createElement('a');
      link.href = url;
      link.download = entry.file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const remove = queueButton('Remove', async () => {
      try {
        await queueAction('readwrite', store => store.delete(id));
        selectedIds.delete(id);
        await showQueue();
        status.textContent = 'Document removed.';
      } catch {
        status.textContent = 'Could not remove this document.';
      }
    });
    const order = queueButton('Checkout', () => openCheckout([[id, entry]]));
    const label = document.createElement('label');
    label.className = 'queue-selection';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(id);
    checkbox.setAttribute('aria-label', 'Select ' + entry.file.name + ' for printing');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateSelection();
    });
    controls.push([id, checkbox]);
    label.append(checkbox, name);
    row.append(label, settings, order, download, remove);
    queueList.append(row);
  }
  updateSelection();
}

const fileInput = document.querySelector('#document-file');
const review = document.querySelector('#file-review');
const preview = document.querySelector('#review-preview');
const reviewFile = document.querySelector('#review-file');
const reviewPicker = document.querySelector('#review-picker');
const openPreview = document.querySelector('#review-open');
const previewFallback = document.querySelector('#review-fallback');
const saveButton = review?.querySelector('button[type="submit"]');
const maxFileSize = 50 * 1024 * 1024;
const imageFormats = new Map([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['bmp', 'image/bmp'],
  ['avif', 'image/avif'],
]);
let previewUrl;

function clearPreview() {
  preview.replaceChildren();
  openPreview.hidden = true;
  openPreview.removeAttribute('href');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
}

function clearReview() {
  clearPreview();
  review.hidden = true;
  reviewFile.replaceChildren();
}

function previewFile(file) {
  clearPreview();
  const extension = file.name.split('.').pop().toLowerCase();
  const isPdf = file.type === 'application/pdf' || extension === 'pdf';
  const imageType = imageFormats.get(extension);
  document.querySelector('#review-name').textContent = file.name;
  document.querySelector('#review-details').textContent = file.size >= 1024 * 1024
    ? (file.size / (1024 * 1024)).toFixed(2) + ' MB'
    : Math.max(1, Math.ceil(file.size / 1024)) + ' KB';
  previewFallback.hidden = Boolean(isPdf || imageType);
  if (isPdf || imageType) {
    previewUrl = URL.createObjectURL(file.slice(0, file.size, isPdf ? 'application/pdf' : imageType));
    const visual = document.createElement(isPdf ? 'iframe' : 'img');
    if (isPdf) {
      visual.title = 'PDF preview for ' + file.name;
    } else {
      visual.alt = 'Preview of ' + file.name;
      visual.addEventListener('error', () => {
        if (!preview.contains(visual)) return;
        visual.remove();
        openPreview.hidden = true;
        previewFallback.hidden = false;
      });
    }
    visual.src = previewUrl;
    preview.append(visual);
    openPreview.href = previewUrl;
    openPreview.hidden = false;
  }
}

fileInput?.addEventListener('change', () => {
  clearReview();
  status.textContent = '';
  const files = Array.from(fileInput.files);
  if (!files.length) return;
  const invalid = files.find(file => !file.size || file.size > maxFileSize);
  if (invalid) {
    status.textContent = invalid.name + ' must be non-empty and no larger than 50 MB. Choose the files again.';
    return;
  }
  files.forEach((file, index) => reviewFile.add(new Option(file.name, String(index))));
  reviewPicker.hidden = files.length < 2;
  previewFile(files[0]);
  review.hidden = false;
  status.textContent = files.length + (files.length === 1 ? ' file ready to review.' : ' files ready to review.');
});

reviewFile?.addEventListener('change', () => previewFile(fileInput.files[reviewFile.selectedIndex]));

document.querySelector('#review-change')?.addEventListener('click', () => fileInput.click());

form?.addEventListener('submit', async event => {
  event.preventDefault();
  const files = Array.from(fileInput.files);
  if (!files.length || files.some(file => !file.size || file.size > maxFileSize)) {
    status.textContent = 'Choose non-empty files up to 50 MB each.';
    return;
  }
  saveButton.disabled = true;
  fileInput.disabled = true;
  review.querySelector('#review-change').disabled = true;
  const settings = 'Saved document';
  try {
    await queueAction('readwrite', store => {
      const requests = files.map(file => store.add({file, settings}));
      return requests.at(-1);
    });
    form.reset();
    clearReview();
    await showQueue();
    status.textContent = files.length === 1 ? 'Document saved locally.' : files.length + ' documents saved locally.';
  } catch {
    status.textContent = 'Could not save this document in the browser.';
  } finally {
    saveButton.disabled = false;
    fileInput.disabled = false;
    review.querySelector('#review-change').disabled = false;
  }
});




const checkout = document.querySelector('#checkout');
const checkoutForm = document.querySelector('#checkout-form');
const checkoutFiles = document.querySelector('#checkout-files');
const checkoutTotal = document.querySelector('#checkout-total');
const checkoutError = document.querySelector('#checkout-error');
const checkoutClose = document.querySelector('#checkout-close');
const checkoutSubmit = checkoutForm.querySelector('[type="submit"]');
const orderHistory = document.querySelector('#order-history');
const orderStatus = document.querySelector('#order-status');
const rates = [175, 300, 850, 1400];
const bindingRates = {none: 0, glossy: 5000, blue: 4000};
const rupees = new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR'});
let checkoutEntries = [];
let legacyOrder;
let paymentStep = false;

function setCheckoutStep(payment) {
  paymentStep = payment;
  checkoutFiles.hidden = payment;
  const delivery = document.querySelector('#checkout-delivery');
  delivery.hidden = !payment;
  delivery.disabled = !payment;
  document.querySelector('#checkout-payment-note').hidden = !payment;
  document.querySelector('#checkout-back').hidden = !payment || Boolean(legacyOrder);
  document.querySelector('#checkout-title').textContent = payment ? 'Delivery and payment' : 'Print settings';
  checkoutSubmit.textContent = payment ? 'Place test order' : 'Proceed to payment';
  checkoutError.textContent = '';
}

document.querySelector('#checkout-back').addEventListener('click', () => {
  setCheckoutStep(false);
  checkout.scrollTop = 0;
  checkoutFiles.querySelector('input')?.focus();
});

function legacyItems(order) {
  return order.items.map(item => {
    const colourCount = item.colourPages?.length ?? (item.colour ? item.pages : 0);
    const sides = Number(Boolean(item.duplex));
    const subtotal = item.copies * ((item.pages - colourCount) * rates[sides]
      + colourCount * rates[2 + sides] + (bindingRates[item.binding] ?? 0));
    return {...item, orientation: item.orientation || 'Portrait', subtotal};
  });
}

function resumeOrder(order) {
  if (checkout.open) return;
  legacyOrder = order;
  checkoutEntries = [];
  pendingOrder = undefined;
  checkoutForm.reset();
  fillProfile(checkoutForm);
  checkoutFiles.replaceChildren();
  checkoutTotal.value = rupees.format(legacyItems(order).reduce((sum, item) => sum + item.subtotal, 0) / 100);
  document.querySelector('#checkout-page-count').textContent = '';
  setCheckoutStep(true);
  checkout.showModal();
  checkoutForm.elements.customer.focus();
}

function openCheckout(entries) {
  if (!entries.length || checkout.open) return;
  legacyOrder = undefined;
  checkoutEntries = entries;
  checkoutForm.reset();
  fillProfile(checkoutForm);
  checkoutError.textContent = '';
  pendingOrder = undefined;
  checkoutFiles.replaceChildren();
  for (const [id, entry] of entries) {
    const group = document.createElement('fieldset');
    group.className = 'checkout-fields print-options';
    const title = document.createElement('legend');
    title.textContent = entry.file.name;
    group.append(title);
    const quantity = document.createElement('div');
    quantity.className = 'print-quantity';
    quantity.innerHTML = `
      <label>Pages per copy<input name="pages-${id}" type="number" min="1" max="10000" value="1" required></label>
      <div><label for="copies-${id}">Number of copies</label>
        <div class="copy-stepper">
          <button type="button" aria-label="Decrease copies">−</button>
          <input id="copies-${id}" name="copies-${id}" type="number" min="1" max="100" value="1" required>
          <button type="button" aria-label="Increase copies">+</button>
        </div>
      </div>`;
    const copies = quantity.querySelector('.copy-stepper input');
    quantity.querySelectorAll('button').forEach((button, index) => {
      button.addEventListener('click', () => {
        copies.value = Math.min(100, Math.max(1, (copies.valueAsNumber || 1) + (index ? 1 : -1)));
        updateCheckoutTotal();
      });
    });
    group.append(quantity,
      printChoices('Choose print colour', 'ink-' + id, ['Black & white', 'Colour', 'Select colour pages']),
      colourPageField(id),
      printChoices('Choose print orientation', 'orientation-' + id, ['Portrait', 'Landscape']),
      printChoices('Choose print sides', 'sides-' + id, ['Single-sided', 'Double-sided']), bindingChoices(id));
    checkoutFiles.append(group);
  }
  checkoutFiles.insertAdjacentHTML('beforeend', '<p>Enter the number of pages you want printed in each file. A4 rates apply.</p>');
  updateCheckoutTotal();
  setCheckoutStep(false);
  checkout.showModal();
}

function printChoices(title, name, options) {
  const group = document.createElement('fieldset');
  group.className = 'print-choices';
  const legend = document.createElement('legend');
  legend.textContent = title;
  group.append(legend);
  options.forEach((text, index) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = String(index);
    input.checked = index === 0;
    const caption = document.createElement('span');
    caption.textContent = text;
    label.append(input, caption);
    group.append(label);
  });
  return group;
}

function colourPageField(id) {
  const label = document.createElement('label');
  label.className = 'colour-pages-field';
  label.hidden = true;
  label.innerHTML = '<strong>Colour page numbers</strong><input placeholder="1-5, 8, 12-15"><small>All remaining pages print in B&amp;W.</small>';
  label.querySelector('input').name = 'colour-pages-' + id;
  return label;
}

function bindingChoices(id) {
  const group = printChoices('Binding', 'binding-' + id, ['No binding', 'Soft Binding Glossy paper SRM', 'Soft Binding Blue Sheet SRM']);
  group.classList.add('binding-options');
  const descriptions = ['', 'White transparent sheet', 'Blue sheet'];
  group.querySelectorAll('label').forEach((label, index) => {
    const key = Object.keys(bindingRates)[index];
    label.querySelector('input').value = key;
    if (key === 'none') return;
    const detail = document.createElement('small');
    detail.textContent = descriptions[index] + ' · +' + rupees.format(bindingRates[key] / 100) + ' per copy';
    label.querySelector('span').append(detail);
  });
  return group;
}

function parseColourPages(text, pages) {
  const selected = new Set();
  for (const part of text.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Use page numbers or ranges, like 1-5, 8.');
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last > pages || last > 10000) {
      throw new Error('Enter page numbers within the selected page count.');
    }
    for (let page = first; page <= last; page++) {
      if (selected.has(page)) throw new Error('A colour page can only be selected once.');
      selected.add(page);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

function checkoutItems() {
  const data = new FormData(checkoutForm);
  return checkoutEntries.map(([id, entry]) => {
    const pages = Number(data.get('pages-' + id));
    const copies = Number(data.get('copies-' + id));
    const ink = data.get('ink-' + id);
    const field = checkoutForm.elements.namedItem('colour-pages-' + id);
    field.closest('label').hidden = ink !== '2';
    field.setCustomValidity('');
    let colourPages = null;
    if (ink === '2') {
      try {
        colourPages = parseColourPages(field.value, pages);
      } catch (error) {
        field.setCustomValidity(error.message);
        return null;
      }
    }
    const colour = ink === '1';
    const binding = data.get('binding-' + id);
    const duplex = Number(data.get('sides-' + id));
    const colourCount = colourPages?.length ?? (colour ? pages : 0);
    const subtotal = copies * ((pages - colourCount) * rates[duplex] + colourCount * rates[2 + duplex] + bindingRates[binding]);
    return {id, file: entry.file, pages, copies, colour, binding, colourPages,
      duplex: Boolean(duplex), orientation: data.get('orientation-' + id) === '1' ? 'Landscape' : 'Portrait', subtotal};
  });
}

function updateCheckoutTotal() {
  const items = checkoutItems();
  if (items.includes(null)) {
    checkoutTotal.value = 'Check colour pages';
    document.querySelector('#checkout-page-count').textContent = '';
    return;
  }
  const printedPages = items.reduce((sum, item) => sum + item.pages * item.copies, 0);
  document.querySelector('#checkout-page-count').textContent = printedPages + (printedPages === 1 ? ' printed page' : ' printed pages');
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  checkoutTotal.value = rupees.format(subtotal / 100);
}

checkoutFiles.addEventListener('input', updateCheckoutTotal);
checkoutClose.addEventListener('click', () => checkout.close());
checkout.addEventListener('cancel', event => {
  if (checkoutSubmit.disabled) event.preventDefault();
});

async function saveOrder(order, previousOrderId) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['documents', 'orders'], 'readwrite');
    const documents = transaction.objectStore('documents');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    if (previousOrderId) {
      const orders = transaction.objectStore('orders');
      const previous = orders.getKey(previousOrderId);
      previous.onsuccess = () => {
        if (previous.result === undefined) transaction.abort();
        else orders.delete(previousOrderId);
      };
    }
    for (const item of previousOrderId ? [] : order.items) {
      const check = documents.getKey(item.id);
      check.onsuccess = () => {
        if (check.result === undefined) transaction.abort();
        else documents.delete(item.id);
      };
    }
    transaction.objectStore('orders').add(order);
  });
}

async function showOrders() {
  if (!orderHistory) return;
  const db = await database;
  const orders = await new Promise((resolve, reject) => {
    const request = db.transaction('orders').objectStore('orders').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  orderHistory.replaceChildren();
  if (!orders.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Your orders will appear here.';
    orderHistory.append(empty);
  }
  orders.sort((a, b) => b.createdAt - a.createdAt);
  for (const order of orders) {
    const row = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const reference = order.id.slice(0, 8).toUpperCase();
    const label = order.orderKey ? 'PB-' + reference : order.id;
    const state = document.createElement('p');
    summary.textContent = label + ' · ' + rupees.format(order.subtotal / 100);
    state.textContent = 'Payment pending';
    if (order.orderKey) {
      const refresh = async () => {
        try {
          const result = await orderRequest('/api/orders/' + order.id, order.orderKey);
          state.textContent = orderStates[result.status] || result.status;
        } catch {
          state.textContent = 'Status unavailable. Try refreshing.';
        }
      };
      void refresh();
      details.append(summary, state, queueButton('Refresh status', refresh));
    } else {
      details.append(summary, state, queueButton('Proceed to payment', () => resumeOrder(order)));
    }
    const files = document.createElement('ul');
    for (const item of order.items) {
      const line = document.createElement('li');
      line.textContent = item.file.name + ' · ' + item.pages + ' pages × ' + item.copies + ' copies · '
        + (item.colourPages ? 'Colour pages ' + item.colourPages.join(', ') : item.colour ? 'Colour' : 'Black & white') + ' · ' + (item.duplex ? 'Double-sided' : 'Single-sided') + (item.orientation ? ' · ' + item.orientation : '')
        + ({glossy: ' · Glossy binding', blue: ' · Blue sheet binding'}[item.binding] || '');
      files.append(line);
    }
    details.append(files);
    row.append(details);
    orderHistory.append(row);
  }
}

const orderStates = {
  pending: 'Payment pending', paid: 'Test payment confirmed · With warehouse',
  printing: 'Printing', packed: 'Packed · Awaiting delivery',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered',
};
let pendingOrder;

async function orderRequest(path, key, options = {}) {
  const response = await fetch(path, {...options, headers: {'X-Order-Key': key, ...options.headers}});
  const data = await response.json();
  if (response.status === 401) {
    throw Object.assign(new Error('Sign in by email before placing an order.'), {signInRequired: true});
  }
  if (!response.ok) throw new Error(data.error || 'The order service is unavailable.');
  return data;
}

async function submitTestOrder(order) {
  const items = order.items.map(({file, pages, copies, colour, duplex, orientation, binding, colourPages}) => ({
    name: file.name, size: file.size, pages, copies, colour, duplex, orientation, binding, colourPages,
  }));
  const quote = await orderRequest('/api/orders', order.orderKey, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: order.id, customer: order.customer, phone: order.phone, address: order.address, items}),
  });
  if (quote.subtotal !== order.subtotal) throw new Error('The print price changed. Review the current rates before paying.');
  const path = '/api/orders/' + order.id;
  const current = await orderRequest(path, order.orderKey);
  if (current.status !== 'pending') return;
  for (const [index, item] of order.items.entries()) {
    checkoutError.textContent = 'Uploading file ' + (index + 1) + ' of ' + order.items.length + '…';
    await orderRequest(path + '/files/' + index, order.orderKey, {method: 'POST', body: item.file});
  }
  await orderRequest(path + '/test-payment', order.orderKey, {method: 'POST'});
}

checkoutForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (checkoutSubmit.disabled) return;
  if (!paymentStep) {
    setCheckoutStep(true);
    checkout.scrollTop = 0;
    checkoutForm.elements.customer.focus();
    return;
  }
  const data = new FormData(checkoutForm);
  const customer = data.get('customer').trim();
  const phone = data.get('phone').trim();
  const address = data.get('address').trim();
  if (!customer || !address || phone.replace(/\D/g, '').length < 7) {
    checkoutError.textContent = 'Enter your name, a valid phone number and a delivery address.';
    return;
  }
  const items = legacyOrder ? legacyItems(legacyOrder) : checkoutItems();
  if (items.includes(null)) {
    setCheckoutStep(false);
    checkoutForm.reportValidity();
    return;
  }
  const signature = JSON.stringify([...data]);
  if (pendingOrder?.signature !== signature) pendingOrder = {signature, order: {
    id: crypto.randomUUID().replaceAll('-', ''),
    orderKey: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
    createdAt: Date.now(), customer, phone, address, items,
    subtotal: items.reduce((sum, item) => sum + item.subtotal, 0),
  }};
  const {order} = pendingOrder;
  checkoutSubmit.disabled = true;
  checkoutClose.disabled = true;
  checkoutError.textContent = '';
  try {
    await submitTestOrder(order);
    await saveOrder(order, legacyOrder?.id);
  } catch (error) {
    checkoutError.textContent = error.message || 'Could not complete checkout. Try again.';
    if (error.signInRequired) {
      const link = document.createElement('a');
      link.href = 'profile.html';
      link.textContent = 'Sign in from your Profile';
      checkoutError.append(' ', link);
    }
    return;
  } finally {
    checkoutSubmit.disabled = false;
    checkoutClose.disabled = false;
  }
  for (const item of items) selectedIds.delete(item.id);
  checkout.close();
  if (!orderHistory) {
    location.assign('orders.html#orders');
    return;
  }
  orderStatus.textContent = 'Test order placed and sent to the warehouse.';
  document.querySelector('#orders').scrollIntoView();
  await Promise.all([showQueue(), showOrders()]).catch(() => {
    orderStatus.textContent = 'Order ' + order.id + ' was saved. Reload to refresh your orders.';
  });
});

Promise.all([showQueue(), showOrders()]).catch(() => {
  status.textContent = 'Local file storage is unavailable in this browser.';
});
