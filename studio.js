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

const cartCheckout = document.querySelector('#cart-checkout');
const cartCount = document.querySelector('#cart-count');
const cartEmpty = document.querySelector('#cart-empty');
if (form && location.hash === '#cart') window.top.location.replace('/cart');
const maxOrderFiles = 100;

async function addToCart(entries) {
  await queueAction('readwrite', store => {
    const requests = entries.map(entry => store.add(entry));
    return requests.at(-1);
  });
}

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
  cartCheckout.hidden = entries.length === 0;
  if (cartEmpty) cartEmpty.hidden = entries.length > 0;
  cartCount.textContent = fileCount(entries);
  cartCheckout.querySelector('button').onclick = async () => {
    if (entries.length > maxOrderFiles) {
      status.textContent = 'An order can contain up to 100 files. Remove files to continue.';
      return;
    }
    if (await pricingAvailable()) openCheckout(entries);
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
        await showQueue();
        status.textContent = 'Document removed.';
      } catch {
        status.textContent = 'Could not remove this document.';
      }
    });
    row.append(name, settings, download, remove);
    queueList.append(row);
  }
}

const fileInput = document.querySelector('#document-file');
const review = document.querySelector('#file-review');
const reviewGrid = document.querySelector('#review-grid');
const reviewSettings = document.querySelector('#review-settings');
const saveButton = review?.querySelector('button[type="submit"]');
const maxFileSize = 50 * 1024 * 1024;
const imageFormats = new Map([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['bmp', 'image/bmp'],
  ['avif', 'image/avif'],
]);
let draftFiles = [];
let nextDraftId = 0;
let pdfPageQueue = Promise.resolve();

function updateDraftTotal() {
  const items = readPrintItems(form, draftFiles);
  document.querySelector('#review-count').textContent = fileCount(draftFiles);
  document.querySelector('#review-total').textContent = items.includes(null)
    ? 'Check print settings'
    : rupees.format(items.reduce((sum, item) => sum + item.subtotal, 0) / 100);
}

function addDraft(file) {
  const id = 'draft-' + nextDraftId++;
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const isPdf = file.type === 'application/pdf' || extension === 'pdf';
  const previewType = isPdf ? 'application/pdf' : imageFormats.get(extension);
  const tile = document.createElement('article');
  tile.className = 'review-tile';
  const visual = document.createElement('div');
  visual.className = 'review-tile-visual';
  const fallback = document.createElement('span');
  fallback.textContent = (extension ? extension.slice(0, 8).toUpperCase() + ' file' : 'Document') + ' · Preview unavailable';
  visual.append(fallback);
  let url;
  if (previewType) {
    url = URL.createObjectURL(file.slice(0, file.size, previewType));
    const media = document.createElement(isPdf ? 'iframe' : 'img');
    if (isPdf) {
      media.title = 'PDF preview of ' + file.name;
      media.src = url + '#toolbar=0&navpanes=0&view=Fit';
    } else {
      media.alt = 'Preview of ' + file.name;
      media.src = url;
    }
    media.loading = 'lazy';
    fallback.hidden = true;
    media.addEventListener('error', () => {
      media.remove();
      fallback.hidden = false;
    });
    visual.append(media);
  }
  const title = document.createElement('strong');
  title.textContent = file.name;
  const options = createPrintOptions(id, {file}, updateDraftTotal);
  if (['pdf', 'docx'].includes(extension)) {
    const pagesInput = options.querySelector(`[name="pages-${id}"]`);
    const hint = document.createElement('small');
    hint.textContent = 'Counting document pages…';
    pagesInput.after(hint);
    let manuallyEdited = false;
    pagesInput.addEventListener('input', () => { manuallyEdited = true; });
    pdfPageQueue = pdfPageQueue.then(async () => {
      if (!options.isConnected) return;
      const {pages} = await orderRequest('/api/checkout/pages?format=' + extension, null, {method: 'POST', body: file});
      if (!options.isConnected) return;
      if (pages === null) {
        hint.textContent = 'Enter the page count from your document.';
        return;
      }
      pagesInput.max = pages;
      if (!manuallyEdited) pagesInput.value = pages;
      hint.textContent = pages + (pages === 1 ? ' page detected' : ' pages detected');
      updateDraftTotal();
    }).catch(() => { hint.textContent = 'Could not count pages. Check that the file opens.'; });
  }
  const remove = queueButton('×', () => {
    draftFiles = draftFiles.filter(([key]) => key !== id);
    tile.remove();
    options.remove();
    if (url) URL.revokeObjectURL(url);
    review.hidden = draftFiles.length === 0;
    if (review.hidden) fileInput.focus();
    else addMore.focus();
    updateDraftTotal();
  });
  remove.className = 'review-remove';
  remove.setAttribute('aria-label', 'Remove ' + file.name);
  tile.append(visual, remove, title);
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open preview ↗';
    tile.append(link);
  }
  reviewGrid.insertBefore(tile, addMore);
  reviewSettings.append(options);
  draftFiles.push([id, {file, url}]);
}

const addMore = fileInput ? queueButton('＋ Add files', () => fileInput.click()) : null;
if (addMore) {
  addMore.className = 'review-add';
  reviewGrid.append(addMore);
}
function reviewFiles(files) {
  if (fileInput.disabled) return;
  if (!files.length) return;
  const invalid = files.find(file => !file.size || file.size > maxFileSize);
  if (invalid || draftFiles.length + files.length > maxOrderFiles) {
    status.textContent = invalid ? invalid.name + ' must be non-empty and no larger than 50 MB.' : 'You can review up to 100 files at a time.';
    return;
  }
  for (const file of files) addDraft(file);
  review.hidden = false;
  status.textContent = '';
  updateDraftTotal();
}
fileInput?.addEventListener('change', async () => {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  if (await pricingAvailable()) reviewFiles(files);
});
form?.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
form?.addEventListener('drop', async event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer.files);
  if (await pricingAvailable()) reviewFiles(files);
});
reviewSettings?.addEventListener('input', updateDraftTotal);

form?.addEventListener('submit', async event => {
  event.preventDefault();
  if (saveButton.disabled || !draftFiles.length) return;
  const items = readPrintItems(form, draftFiles);
  if (items.includes(null)) {
    form.reportValidity();
    return;
  }
  saveButton.disabled = fileInput.disabled = addMore.disabled = true;
  const removeButtons = [...reviewGrid.querySelectorAll('.review-remove')];
  removeButtons.forEach(button => { button.disabled = true; });
  try {
    await addToCart(items.map(({id, file, subtotal, ...printOptions}) =>
      ({file, settings: 'Saved document', printOptions})));
    for (const [, {url}] of draftFiles) if (url) URL.revokeObjectURL(url);
    draftFiles = [];
    reviewGrid.replaceChildren(addMore);
    reviewSettings.replaceChildren();
    review.hidden = true;
    status.textContent = fileCount(items) + ' added to cart.';
  } catch {
    status.textContent = 'Could not update your cart. Try again.';
  } finally {
    saveButton.disabled = fileInput.disabled = addMore.disabled = false;
    removeButtons.forEach(button => { button.disabled = false; });
  }
});

const checkout = document.querySelector('#checkout');
const checkoutForm = document.querySelector('#checkout-form');
const checkoutFiles = document.querySelector('#checkout-files');
const checkoutTotal = document.querySelector('#checkout-total');
const checkoutError = document.querySelector('#checkout-error');
const checkoutClose = document.querySelector('#checkout-close');
const checkoutSubmit = checkoutForm?.querySelector('[type="submit"]');
const orderHistory = document.querySelector('#order-history');
let paperRates = {};
let bindingRates = {};
const bindingNames = {none: 'No binding', glossy: 'Glossy soft binding', blue: 'Blue sheet binding',
  spiral: 'Spiral binding', staple: 'Staple binding'};
const rupees = new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR'});
let checkoutEntries = [];
let paymentStep = false;
let paymentMode = 'disabled';
let mapsReady = false;
let activeBill;
let appliedCoupon = '';
let quoteVersion = 0;
let quoteTimer;
let quotedAddress = '';
let placingOrder = false;
let queuedConfig;

function updatePrintOptions(group) {
  const id = group.dataset.printId;
  const paper = group.querySelector('select');
  const sizes = Object.keys(paperRates);
  const selectedPaper = paper.value;
  if (sizes.join() !== [...paper.options].filter(option => option.value).map(option => option.value).join()) {
    const options = sizes.map(size => new Option(size, size));
    if (!sizes.includes(selectedPaper)) options.unshift(new Option('Choose a paper size', ''));
    paper.replaceChildren(...options);
    paper.value = sizes.includes(selectedPaper) ? selectedPaper : '';
  }
  const oldBinding = group.querySelector('.binding-options');
  const selectedBinding = oldBinding.querySelector('input:checked')?.value;
  const binding = bindingChoices(id);
  for (const input of binding.querySelectorAll('input')) input.checked = input.value === selectedBinding;
  if (!Object.hasOwn(bindingRates, selectedBinding)) binding.querySelector('input').required = true;
  if (oldBinding.contains(document.activeElement)) {
    const focused = document.activeElement.value;
    oldBinding.replaceWith(binding);
    [...binding.querySelectorAll('input')].find(input => input.value === focused)?.focus();
  } else {
    oldBinding.replaceWith(binding);
  }
}

function applyCheckoutConfig(config) {
  if (placingOrder) {
    queuedConfig = config;
    return;
  }
  const {mode, terms, maps} = config;
  const printChanged = JSON.stringify([paperRates,bindingRates]) !== JSON.stringify([terms.paperRates,terms.bindingRates]);
  paperRates = terms.paperRates;
  bindingRates = terms.bindingRates;
  if (printChanged) {
    for (const group of document.querySelectorAll('.print-options')) updatePrintOptions(group);
    if (draftFiles.length) updateDraftTotal();
  }
  if (!checkoutForm) return;
  paymentMode = mode;
  const slot = checkoutForm.elements.slot;
  if (JSON.stringify([...slot.options].map(option => option.value)) !== JSON.stringify(terms.slots)) {
    const selected = slot.value;
    slot.replaceChildren(...terms.slots.map(label => new Option(label, label)));
    if (terms.slots.includes(selected)) slot.value = selected;
  }
  slot.disabled = terms.slots.length === 0;
  slot.closest('label').hidden = slot.disabled;
  if (maps && !mapsReady) {
    setupDeliveryMap(maps);
    mapsReady = true;
  }
  if (!checkout.open) return;
  if (!paymentStep) {
    updateCheckoutTotal();
  } else if (checkoutItems().includes(null)) {
    setCheckoutStep(false);
    checkoutError.textContent = 'Print options changed. Review your selected settings.';
  } else {
    refreshBill();
  }
}

async function pricingAvailable() {
  const config = await window.printbeePricing.refresh();
  if (config) return true;
  status.textContent = 'Current prices are temporarily unavailable. Try again.';
  return false;
}

if (form || checkout) window.printbeePricing.subscribe(applyCheckoutConfig);

function fileCount(files) {
  return files.length + (files.length === 1 ? ' file' : ' files');
}

function showOrderBill(items) {
  const bill = document.querySelector('#checkout-bill');
  const list = bill.querySelector('ul');
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    const price = document.createElement('strong');
    name.textContent = item.file.name;
    price.textContent = rupees.format(item.subtotal / 100);
    row.append(name, price);
    list.append(row);
  }
  for (const [key, label] of Object.entries({
    printing: 'Printing', binding: 'Binding', packing: 'Packing fee',
    platform: 'Platform fee', delivery: 'Delivery fee', surge: 'Surge fee', discount: 'Coupon discount', tax: 'Taxes',
  })) {
    if (!activeBill || (!(key in activeBill) || (!activeBill[key] && key === 'discount'))) continue;
    const row = document.createElement('li');
    const name = document.createElement('span');
    const price = document.createElement('strong');
    name.textContent = label;
    price.textContent = rupees.format(activeBill[key] / (key === 'discount' ? -100 : 100));
    row.append(name, price);
    list.append(row);
  }
  document.querySelector('#checkout-page-count').textContent = fileCount(items);
  checkoutTotal.value = activeBill ? rupees.format(activeBill.total / 100) : 'Updating total…';
}

async function refreshBill({useCouponField = false} = {}) {
  clearTimeout(quoteTimer);
  const version = ++quoteVersion;
  const items = checkoutItems();
  activeBill = null;
  checkoutSubmit.disabled = true;
  checkoutError.textContent = '';
  showOrderBill(items);
  try {
    const coupon = useCouponField ? checkoutForm.elements.coupon.value.trim().toUpperCase() : appliedCoupon;
    const address = checkoutForm.elements.address.value.trim();
    const bill = await orderRequest('/api/checkout/quote', null, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({items: orderDocuments(items), coupon, address}),
    });
    if (version !== quoteVersion) return;
    activeBill = bill;
    appliedCoupon = coupon;
    quotedAddress = address;
    showOrderBill(items);
    const couponChanged = checkoutForm.elements.coupon.value.trim().toUpperCase() !== appliedCoupon;
    checkoutSubmit.disabled = paymentMode === 'disabled' || couponChanged;
    if (couponChanged) checkoutError.textContent = 'Apply the coupon code to update your total.';
  } catch (error) {
    if (version !== quoteVersion) return;
    checkoutTotal.value = 'Check your order';
    checkoutError.textContent = error.message;
  }
}

const applyCoupon = document.querySelector('#apply-coupon');
applyCoupon?.addEventListener('click', () => refreshBill({useCouponField:true}));
checkoutForm?.elements.address.addEventListener('input', () => {
  if (!paymentStep || placingOrder) return;
  quoteVersion++;
  activeBill = null;
  checkoutSubmit.disabled = true;
  showOrderBill(checkoutItems());
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshBill, 300);
});
checkoutForm?.elements.coupon.addEventListener('input', () => {
  quoteVersion++;
  checkoutSubmit.disabled = true;
  checkoutError.textContent = 'Apply the coupon code to update your total.';
});

function setCheckoutStep(payment) {
  clearTimeout(quoteTimer);
  paymentStep = payment;
  quoteVersion++;
  activeBill = null;
  checkoutFiles.hidden = payment;
  document.querySelector('#checkout-bill').hidden = !payment;
  if (payment) showOrderBill(checkoutItems());
  else updateCheckoutTotal();
  const delivery = document.querySelector('#checkout-delivery');
  delivery.hidden = !payment;
  delivery.disabled = !payment;
  const paymentNote = document.querySelector('#checkout-payment-note');
  paymentNote.hidden = !payment;
  paymentNote.textContent = {
    test: 'Local test payment. No money is charged.',
    razorpay: 'Pay once for all files using Razorpay.',
    disabled: 'Payments are currently unavailable.',
  }[paymentMode];
  document.querySelector('#checkout-back').hidden = !payment;
  document.querySelector('#checkout-title').textContent = payment ? 'Delivery and payment' : 'Print settings';
  checkoutSubmit.textContent = payment ? (paymentMode === 'test' ? 'Place test order' : 'Pay for order') : 'Review order';
  checkoutSubmit.disabled = payment;
  checkoutError.textContent = '';
  if (payment) refreshBill();
}

document.querySelector('#checkout-back')?.addEventListener('click', () => {
  setCheckoutStep(false);
  checkout.scrollTop = 0;
  checkoutFiles.querySelector('input')?.focus();
});

function openCheckout(entries) {
  if (!entries.length || checkout.open || placingOrder) return;
  checkoutEntries = entries;
  checkoutForm.reset();
  appliedCoupon = '';
  fillProfile(checkoutForm);
  checkoutError.textContent = '';
  pendingOrder = undefined;
  checkoutFiles.replaceChildren();
  for (const [id, entry] of entries) {
    checkoutFiles.append(createPrintOptions(id, entry, updateCheckoutTotal));
  }
  checkoutFiles.insertAdjacentHTML('beforeend', '<p>Enter the number of pages you want printed in each file.</p>');
  setCheckoutStep(false);
  checkout.showModal();
}

function createPrintOptions(id, entry, onChange) {
  const group = document.createElement('fieldset');
  group.className = 'checkout-fields print-options';
  group.dataset.printId = id;
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
      onChange();
    });
  });
  const paper = document.createElement('label');
  paper.textContent = 'Paper size';
  const paperSelect = document.createElement('select');
  paperSelect.name = 'paper-' + id;
  paperSelect.required = true;
  paperSelect.append(...Object.keys(paperRates).map(size => new Option(size, size)));
  paper.append(paperSelect);
  group.append(quantity, paper,
    pageRangeField(id),
    printChoices('Choose print colour', 'ink-' + id, ['Black & white', 'Colour', 'Select colour pages']),
    colourPageField(id),
    printChoices('Choose print orientation', 'orientation-' + id, ['Portrait', 'Landscape']),
    printChoices('Choose print sides', 'sides-' + id, ['Single-sided', 'Double-sided']), bindingChoices(id));
  const saved = entry.printOptions;
  if (saved) {
    paperSelect.value = Object.hasOwn(paperRates, saved.paper) ? saved.paper : 'A4';
    for (const [key, value] of Object.entries({
      pages: saved.pages, copies: saved.copies, 'colour-pages': saved.colourPages?.join(', ') || '',
      'page-range': saved.pageRange?.join(', ') || '',
    })) group.querySelector(`[name="${key}-${id}"]`).value = value;
    const choices = {
      ink: saved.colourPages ? 2 : Number(saved.colour),
      orientation: Number(saved.orientation === 'Landscape'),
      sides: Number(saved.duplex),
      binding: saved.binding,
    };
    if (!Object.hasOwn(bindingRates, choices.binding)) choices.binding = 'none';
    for (const input of group.querySelectorAll('input[type="radio"]')) {
      const key = input.name.slice(0, -String(id).length - 1);
      input.checked = input.value === String(choices[key]);
    }
  }
  if (/\.(?:png|jpe?g)$/i.test(entry.file.name)) {
    quantity.querySelector(`[name="pages-${id}"]`).max = 1;
  }
  return group;
}

function pageRangeField(id) {
  const label = document.createElement('label');
  label.innerHTML = '<strong>Print page range (optional)</strong><input placeholder="1–5, 8, 12" maxlength="300"><small>Leave blank to print from page 1. Colour page numbers refer to positions in the selected range.</small>';
  label.querySelector('input').name = 'page-range-' + id;
  return label;
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
  const keys = Object.keys(bindingRates);
  const group = printChoices('Binding', 'binding-' + id, keys.map(key => bindingNames[key]));
  group.classList.add('binding-options');
  group.querySelectorAll('label').forEach((label, index) => {
    const key = keys[index];
    label.querySelector('input').value = key;
    if (key === 'none') return;
    const detail = document.createElement('small');
    detail.textContent = '+' + rupees.format(bindingRates[key] / 100) + ' per copy';
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
  return readPrintItems(checkoutForm, checkoutEntries);
}

function readPrintItems(settingsForm, entries) {
  const data = new FormData(settingsForm);
  return entries.map(([id, entry]) => {
    let pages = Number(data.get('pages-' + id));
    const range = settingsForm.elements.namedItem('page-range-' + id);
    const pageLimit = Number(settingsForm.elements.namedItem('pages-' + id).max);
    let pageRange;
    range.setCustomValidity('');
    if (range.value.trim()) {
      try {
        pageRange = parseColourPages(range.value.replaceAll('–', '-'), pageLimit);
        pages = pageRange.length;
      } catch {
        range.setCustomValidity('Enter print pages within the document page count.');
        return null;
      }
    }
    const copies = Number(data.get('copies-' + id));
    const ink = data.get('ink-' + id);
    const field = settingsForm.elements.namedItem('colour-pages-' + id);
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
    if (!Number.isInteger(pages) || pages < 1 || pages > pageLimit || !Number.isInteger(copies) || copies < 1 || copies > 100) return null;
    const colour = ink === '1';
    const binding = data.get('binding-' + id);
    const paper = data.get('paper-' + id);
    const rates = paperRates[paper];
    if (!rates || !Object.hasOwn(bindingRates, binding)) return null;
    const duplex = Number(data.get('sides-' + id));
    const colourCount = colourPages?.length ?? (colour ? pages : 0);
    const subtotal = copies * ((pages - colourCount) * rates[duplex] + colourCount * rates[2 + duplex] + bindingRates[binding]);
    return {id, file: entry.file, pages, copies, colour, binding, colourPages, pageRange, paper,
      duplex: Boolean(duplex), orientation: data.get('orientation-' + id) === '1' ? 'Landscape' : 'Portrait', subtotal};
  });
}

function updateCheckoutTotal() {
  const items = checkoutItems();
  if (items.includes(null)) {
    checkoutTotal.value = 'Check print settings';
    document.querySelector('#checkout-page-count').textContent = '';
    return;
  }
  const printedPages = items.reduce((sum, item) => sum + item.pages * item.copies, 0);
  document.querySelector('#checkout-page-count').textContent = fileCount(items) + ' · ' + printedPages + (printedPages === 1 ? ' printed page' : ' printed pages');
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  checkoutTotal.value = rupees.format(subtotal / 100);
}

checkoutFiles?.addEventListener('input', updateCheckoutTotal);
checkoutClose?.addEventListener('click', () => checkout.close());
checkout?.addEventListener('cancel', event => {
  if (checkoutSubmit.disabled) event.preventDefault();
});

async function saveOrder(order) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['documents', 'orders'], 'readwrite');
    const documents = transaction.objectStore('documents');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    for (const item of order.items) {
      const check = documents.getKey(item.id);
      check.onsuccess = () => {
        if (check.result === undefined) transaction.abort();
        else documents.delete(item.id);
      };
    }
    transaction.objectStore('orders').put({id: order.id, placed: true, accountOrder: true});
  });
}

async function showOrders() {
  if (!orderHistory) return;
  const shared = location.hash.match(/^#track=([a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (shared) {
    status.textContent = '';
    const row = document.createElement('li');
    const line = document.createElement('p');
    async function refreshShared() {
      try {
        const {number, status} = await orderRequest('/api/orders/' + shared[1], null, {
          headers: {'X-Tracking-Key': shared[2]},
        });
        line.textContent = (number || 'PB-' + shared[1].slice(0, 8).toUpperCase()) + ' · ' + orderStates[status];
      } catch {
        line.textContent = 'This tracking link is unavailable.';
      }
    }
    row.append(line, queueButton('Refresh tracking', refreshShared));
    orderHistory.replaceChildren(row);
    await refreshShared();
    return;
  }
  const errorPanel = document.querySelector('#orders-error');
  let accountOrders = [];
  let accountUnavailable = false;
  status.textContent = '';
  try {
    const response = await fetch('/api/orders');
    if (response.ok) {
      const data = await response.json();
      if (!Array.isArray(data.orders)) throw new Error('Invalid order list');
      accountOrders = data.orders;
      loadOrderUpdates().catch(() => {});
    } else if (response.status === 401) {
      const signIn = document.createElement('a');
      signIn.href = 'profile.html';
      signIn.textContent = 'Sign in to see your account orders';
      status.replaceChildren(signIn);
    } else {
      throw new Error('Order history unavailable');
    }
  } catch {
    accountUnavailable = true;
  }
  const accountIds = new Set(accountOrders.map(order => order.id));
  if (accountIds.size) startOrderFeed();
  const legacyOrders = await getLegacyOrders(accountIds).catch(() => []);
  for (const details of orderHistory.querySelectorAll('details[open]')) details.open = false;
  orderHistory.replaceChildren();
  const confirmedId = new URLSearchParams(location.search).get('placed');
  const confirmed = accountOrders.find(order => order.id === confirmedId);
  if (confirmed) {
    const banner = document.querySelector('#order-confirmation');
    banner.textContent = 'Order placed · ' + displayOrderNumber(confirmed);
    banner.hidden = false;
  }
  for (const order of [...accountOrders, ...legacyOrders]) {
    const row = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = displayOrderNumber(order);
    details.open = confirmedId === order.id;
    const state = document.createElement('p');
    state.className = 'order-state';
    const steps = document.createElement('ol');
    steps.className = 'order-timeline';
    const deliveryInfo = document.createElement('div');
    const history = document.createElement('ol');
    history.className = 'order-events';
    history.setAttribute('aria-label', 'Order history');
    function showTimeline(events) {
      if (!events) return;
      history.replaceChildren(...events.map(event => {
        const row = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = window.PrintBeeStatus?.eventLabel(event.event) || event.event;
        const time = document.createElement('time');
        time.dateTime = new Date(event.at * 1000).toISOString();
        time.textContent = new Date(event.at * 1000).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
        row.append(name, time);
        return row;
      }));
    }
    function showDelivery(delivery) {
      deliveryInfo.replaceChildren();
      if (delivery?.partner) {
        const partner = document.createElement('p');
        partner.textContent = 'Delivery partner · ' + delivery.partner
          + (delivery.etaMinutes ? ' · about ' + delivery.etaMinutes + ' min away' : '');
        deliveryInfo.append(partner);
      }
      if (delivery?.code) {
        const code = document.createElement('p');
        code.className = 'raised table-card';
        code.textContent = 'Delivery code · ' + delivery.code;
        deliveryInfo.append(code);
      }
      if (delivery?.location) {
        const pin = document.createElement('a');
        pin.textContent = 'View latest delivery location';
        pin.href = 'https://www.google.com/maps/search/?' + new URLSearchParams({api: 1, query: delivery.location.join(',')});
        pin.rel = 'noopener noreferrer';
        pin.target = '_blank';
        deliveryInfo.append(pin);
      }
    }
    const stages = {paid: 'Order received', printing: 'Printing', packed: 'Packed',
      out_for_delivery: 'Out for delivery', delivered: 'Delivered'};
    function renderStage(currentStatus) {
      state.textContent = orderStates[currentStatus] || 'Delivery status unavailable.';
      steps.replaceChildren(...Object.entries(stages).map(([key, label]) => {
        const step = document.createElement('li');
        step.textContent = label;
        if (currentStatus === key) step.setAttribute('aria-current', 'step');
        return step;
      }));
    }
    renderStage(order.status);
    details.append(summary, state, steps, deliveryInfo, history);
    let updating = false;
    async function refreshStatus() {
      if (updating) return;
      updating = true;
      try {
        const {status: currentStatus, delivery, timeline} = await orderRequest('/api/orders/' + order.id, order.orderKey);
        if (state.textContent !== orderStates[currentStatus]) renderStage(currentStatus);
        showDelivery(delivery);
        showTimeline(timeline);
      } catch {
        deliveryInfo.replaceChildren();
        state.textContent = 'Could not refresh delivery status.';
      } finally {
        updating = false;
      }
    }
    let timer;
    details.addEventListener('toggle', () => {
      clearInterval(timer);
      liveRefreshers.delete(order.id);
      if (!details.open) return;
      refreshStatus();
      // Account orders update instantly through the shared live feed (startOrderFeed);
      // the timer is only a safety net. Orders tracked by key alone poll.
      if (accountIds.has(order.id)) liveRefreshers.set(order.id, refreshStatus);
      timer = setInterval(() => { if (!document.hidden) refreshStatus(); }, accountIds.has(order.id) ? 60000 : 15000);
    });
    details.append(queueButton('Refresh status', refreshStatus));
    const files = document.createElement('ul');
    for (const item of order.items) {
      const line = document.createElement('li');
      line.textContent = (item.name || item.file.name) + ' · ' + item.pages + ' pages × ' + item.copies + ' copies · '
        + (item.pageRange ? 'Print pages ' + item.pageRange.join(', ') + ' · ' : '')
        + (item.colourPages ? 'Colour pages ' + item.colourPages.join(', ') : item.colour ? 'Colour' : 'Black & white') + ' · ' + (item.duplex ? 'Double-sided' : 'Single-sided') + (item.orientation ? ' · ' + item.orientation : '')
        + ' · ' + (item.paper || 'A4') + (item.binding && item.binding !== 'none' ? ' · ' + bindingNames[item.binding] : '');
      files.append(line);
    }
    details.append(files);
    const actions = document.createElement('div');
    actions.className = 'order-actions';
    if (accountIds.has(order.id)) {
      const invoice = document.createElement('a');
      invoice.href = '/api/orders/' + order.id + '/invoice';
      invoice.textContent = 'Download order PDF';
      actions.append(invoice);
      actions.append(queueButton('Copy tracking link', async () => {
        try {
          const {trackingKey} = await orderRequest('/api/orders/' + order.id);
          const url = new URL('orders.html#track=' + order.id + '.' + trackingKey, location.href);
          await navigator.clipboard.writeText(url.href);
          status.textContent = 'Tracking link copied.';
        } catch {
          status.textContent = 'Could not copy the tracking link.';
        }
      }));
    }
    const reorder = queueButton('Add order to cart', async () => {
      reorder.disabled = true;
      try {
        const entries = [];
        for (const [index, item] of order.items.entries()) {
          let file = item.file;
          if (!file) {
            const response = await fetch('/api/orders/' + order.id + '/files/' + index);
            if (!response.ok) throw new Error('File unavailable');
            file = new File([await response.blob()], item.name);
          }
          entries.push({file, settings: 'Saved document', printOptions: item});
        }
        await addToCart(entries);
        window.top.location.assign('/cart');
      } catch {
        status.textContent = 'Could not add this order to the cart. Its files may no longer be available.';
        reorder.disabled = false;
      }
    });
    actions.append(reorder);
    details.append(actions);
    row.append(details);
    orderHistory.append(row);
  }
  errorPanel.hidden = !accountUnavailable;
  if (!accountUnavailable && !orderHistory.childElementCount && !status.textContent) {
    const empty = document.createElement('li');
    empty.textContent = 'Your placed orders will appear here.';
    orderHistory.append(empty);
  }
}

async function loadOrderUpdates() {
  const panel = document.querySelector('#order-updates');
  const {updates} = await orderRequest('/api/orders/notifications');
  panel.hidden = !updates.length;
  if (!updates.length) return;
  const labels = {delivery_accepted: 'Delivery partner assigned', delivery_undeliverable: 'Could not be delivered',
    paid: 'Order received', printing: 'Printing', packed: 'Packed',
    delivery_picked_up: 'Out for delivery', delivery_completed: 'Delivered', order_cancelled: 'Cancelled',
    refund_requested: 'Refund requested', 'refund.processed': 'Refunded', 'refund.failed': 'Refund needs assistance'};
  const unread = updates.filter(update => update.unread).length;
  panel.querySelector('summary').textContent = unread ? 'Order updates (' + unread + ' new)' : 'Order updates';
  panel.querySelector('ul').replaceChildren(...updates.map(update => {
    const row = document.createElement('li');
    row.textContent = (update.order_number || 'PB-' + update.order_id.slice(0, 8).toUpperCase()) +
      ' · ' + (labels[update.action] || window.PrintBeeStatus?.eventLabel(update.action) || update.action) + ' · ' + new Date(update.created * 1000).toLocaleString();
    return row;
  }));
  panel.ontoggle = async () => {
    if (!panel.open || !unread) return;
    try {
      await orderRequest('/api/orders/notifications/read', null, {
        method: 'POST', headers: {'X-Notification-Cursor': updates[0].id},
      });
      panel.querySelector('summary').textContent = 'Order updates';
    } catch {
      status.textContent = 'Could not mark order updates as read.';
    }
  };
}

function displayOrderNumber(order) {
  return order.number || 'PB-' + order.id.slice(0, 8).toUpperCase();
}

async function getLegacyOrders(accountIds) {
  const db = await database;
  const orders = await new Promise((resolve, reject) => {
    const request = db.transaction('orders').objectStore('orders').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const legacyOrders = orders.filter(order => order.orderKey && !order.accountOrder && !accountIds.has(order.id));
  legacyOrders.sort((a, b) => b.createdAt - a.createdAt);
  const placedOrders = await Promise.all(legacyOrders.map(async order => {
    try {
      const {status} = await orderRequest('/api/orders/' + order.id, order.orderKey);
      return Object.hasOwn(orderStates, status) ? {...order, status} : null;
    } catch {
      return order.placed ? order : null;
    }
  }));
  return placedOrders.filter(Boolean);
}

const orderStates = {
  paid: 'Order received · With warehouse',
  printing: 'Printing', packed: 'Packed · Awaiting delivery',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered',
  cancelled: 'Cancelled', undeliverable: 'Undeliverable',
  refund_pending: 'Refund pending', refund_failed: 'Refund needs assistance', refunded: 'Refunded',
};
// Wording comes from the one shared status model (order_status.py), so every portal says the same thing.
window.PrintBeeStatus?.ready.then(model => {
  if (model) for (const [key, value] of Object.entries(model.statuses)) if (Object.hasOwn(orderStates, key)) orderStates[key] = value.label;
});
// Live updates: one shared feed; each open order card registers a refresher here.
const liveRefreshers = new Map();
let orderFeed;
function startOrderFeed() {
  if (orderFeed || !window.PrintBeeLive) return;
  orderFeed = PrintBeeLive.start({
    as: 'customer',
    onEvent: event => liveRefreshers.get(event.order)?.(),
    onSync: () => { loadOrderUpdates().catch(() => {}); },
  });
}
const checkoutDraftKey = 'printbee-checkout-attempt';
let razorpayScript;

function loadRazorpay() {
  if (!razorpayScript) {
    razorpayScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      const failed = () => {
        script.remove();
        razorpayScript = null;
        reject(new Error('Could not load Razorpay. Please retry.'));
      };
      script.onload = () => window.Razorpay ? resolve(window.Razorpay) : failed();
      script.onerror = failed;
      document.head.append(script);
    });
  }
  return razorpayScript;
}

async function payWithRazorpay(payment) {
  const Razorpay = await loadRazorpay();
  checkout.close();
  try {
    await new Promise((resolve, reject) => {
      const instance = new Razorpay({
        key: payment.key, order_id: payment.order_id, amount: payment.amount, currency: payment.currency,
        name: 'PrintBee', retry: {enabled: true},
        handler: resolve,
        modal: {ondismiss: () => reject(new Error('Payment window closed. Retry this checkout or check Orders.'))},
      });
      instance.open();
    });
  } finally {
    checkout.showModal();
  }
}

async function orderRequest(path, key, options = {}) {
  const headers = new Headers(options.headers);
  if (key) headers.set('X-Order-Key', key);
  const response = await fetch(path, {...options, headers});
  const data = await response.json();
  if (response.status === 401) {
    throw Object.assign(new Error('Sign in by email before placing an order.'), {signInRequired: true});
  }
  if (!response.ok) {
    throw Object.assign(new Error(data.error || 'The order service is unavailable.'), {pricingChanged:data.pricingChanged === true});
  }
  return data;
}

function orderDocuments(items) {
  return items.map(({file, pages, copies, colour, duplex, orientation, binding, colourPages, pageRange, paper}) => ({
    name: file.name, size: file.size, pages, copies, colour, duplex, orientation, binding, colourPages, pageRange, paper,
  }));
}

async function submitOrder(order) {
  const items = orderDocuments(order.items);
  const quote = await orderRequest('/api/orders', order.orderKey, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: order.id, customer: order.customer, phone: order.phone, address: order.address,
      slot: order.slot, notes: order.notes, coupon: order.coupon, items, expectedTotal: order.total}),
  });
  if (quote.total !== order.total) throw new Error('The price changed. Review the current rates before paying.');
  const path = '/api/orders/' + order.id;
  const current = await orderRequest(path, order.orderKey);
  if (current.status !== 'pending') return;
  if (!current.paymentStarted) {
    const uploadPanel = document.querySelector('#checkout-upload');
    const uploadStatus = document.querySelector('#checkout-upload-status');
    const progress = document.querySelector('#checkout-progress');
    progress.max = order.items.length;
    progress.value = 0;
    uploadPanel.hidden = false;
    for (const [index, item] of order.items.entries()) {
      uploadStatus.textContent = 'Uploading file ' + (index + 1) + ' of ' + order.items.length + '…';
      await orderRequest(path + '/files/' + index, order.orderKey, {method: 'POST', body: item.file});
      progress.value = index + 1;
    }
    uploadPanel.hidden = true;
  }
  const payment = await orderRequest(path + '/payment', order.orderKey, {method: 'POST'});
  if (payment.status !== 'pending') return;
  await payWithRazorpay(payment);
  checkoutError.textContent = 'Waiting for payment confirmation…';
  for (let attempt = 0; attempt < 15; attempt++) {
    const {status} = await orderRequest(path, order.orderKey);
    if (status !== 'pending') return;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error('Payment confirmation is pending. Check Orders before retrying this checkout.');
}

checkoutForm?.addEventListener('submit', async event => {
  event.preventDefault();
  if (checkoutSubmit.disabled) return;
  if (!paymentStep) {
    if (checkoutItems().includes(null)) return;
    checkoutSubmit.disabled = true;
    setCheckoutStep(true);
    checkout.scrollTop = 0;
    checkoutForm.elements.customer.focus();
    return;
  }
  const data = new FormData(checkoutForm);
  if (!activeBill || data.get('coupon').trim().toUpperCase() !== appliedCoupon) return;
  const customer = data.get('customer').trim();
  const phone = data.get('phone').trim();
  const address = data.get('address').trim();
  if (address !== quotedAddress) {
    refreshBill();
    return;
  }
  if (!customer || !address || phone.replace(/\D/g, '').length < 7) {
    checkoutError.textContent = 'Enter your name, a valid phone number and a delivery address.';
    return;
  }
  const items = checkoutItems();
  if (items.includes(null)) {
    setCheckoutStep(false);
    checkoutForm.reportValidity();
    return;
  }
  checkoutSubmit.disabled = true;
  checkoutClose.disabled = true;
  placingOrder = true;
  applyCoupon.disabled = true;
  checkoutForm.elements.coupon.readOnly = true;
  const back = document.querySelector('#checkout-back');
  back.disabled = true;
  checkoutError.textContent = '';
  let placedId;
  let reprice = false;
  try {
    const signatureText = JSON.stringify({fields: [...data], ids: items.map(item => item.id)});
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signatureText));
    const signature = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    let attempt = JSON.parse(sessionStorage.getItem(checkoutDraftKey));
    if (attempt?.signature !== signature) {
      attempt = {
        signature,
        id: crypto.randomUUID().replaceAll('-', ''),
        orderKey: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
      };
      sessionStorage.setItem(checkoutDraftKey, JSON.stringify(attempt));
    }
    const order = {...attempt, customer, phone, address, items,
      slot: data.get('slot') || '', notes: data.get('notes'), coupon: appliedCoupon, total: activeBill.total};
    await submitOrder(order);
    await saveOrder(order);
    sessionStorage.removeItem(checkoutDraftKey);
    placedId = order.id;
  } catch (error) {
    reprice = error.pricingChanged === true;
    checkoutError.textContent = error.message || 'Could not complete checkout. Try again.';
    if (error.signInRequired) {
      const link = document.createElement('a');
      link.href = 'profile.html';
      link.textContent = 'Sign in from your Profile';
      checkoutError.append(' ', link);
    }
    return;
  } finally {
    document.querySelector('#checkout-upload').hidden = true;
    back.disabled = false;
    checkoutSubmit.disabled = false;
    checkoutClose.disabled = false;
    placingOrder = false;
    applyCoupon.disabled = false;
    checkoutForm.elements.coupon.readOnly = false;
    const next = queuedConfig;
    queuedConfig = undefined;
    if (!placedId) {
      if (next) applyCheckoutConfig(next);
      else if (reprice) {
        checkoutSubmit.disabled = true;
        const previousQuote = quoteVersion;
        await window.printbeePricing.refresh();
        if (paymentStep && previousQuote === quoteVersion) refreshBill();
      }
    }
  }
  checkout.close();
  if (window.parent !== window) window.parent.location.assign('/orders?placed=' + placedId + '#orders');
  else location.assign('orders.html?placed=' + placedId + '#orders');
});

const ordersRefresh = document.querySelector('#orders-refresh');
ordersRefresh?.addEventListener('click', async () => {
  if (ordersRefresh.disabled) return;
  const label = ordersRefresh.querySelector('span');
  ordersRefresh.disabled = true;
  label.textContent = 'Refreshing…';
  try {
    await showOrders();
    if (ordersRefresh.closest('[hidden]')) document.querySelector('#orders-card').focus();
  } catch {
    status.textContent = 'Could not refresh orders. Try again.';
  } finally {
    ordersRefresh.disabled = false;
    label.textContent = 'Refresh Orders';
  }
});

Promise.all([showQueue(), showOrders()]).catch(() => {
  status.textContent = 'Local file storage is unavailable in this browser.';
});

if (queueList) {
  window.addEventListener('pageshow', event => {
    if (event.persisted) showQueue().catch(() => {});
  });
}
