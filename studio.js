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
  const cartPage = Boolean(document.querySelector('.cart-page'));
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
    if (!cartPage) {
      row.append(name, settings, download, remove);
    } else {
      row.className = 'cart-item';
      const extension = (entry.file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
      const badge = document.createElement('span');
      badge.className = 'cart-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = extension;
      const body = document.createElement('div');
      body.className = 'cart-item-body';
      const chips = document.createElement('div');
      chips.className = 'cart-chips';
      for (const text of printSummary(entry)) {
        const chip = document.createElement('span');
        chip.textContent = text;
        chips.append(chip);
      }
      body.append(name, chips);
      const actions = document.createElement('div');
      actions.className = 'cart-item-actions';
      download.setAttribute('aria-label', 'Download ' + entry.file.name);
      remove.setAttribute('aria-label', 'Remove ' + entry.file.name);
      download.classList.add('cart-download');
      remove.classList.add('cart-remove');
      actions.append(download, remove);
      row.append(badge, body, actions);
    }
    queueList.append(row);
  }
}

function printSummary(entry) {
  const options = entry.printOptions;
  if (!options) return [entry.settings || 'Saved document'];
  const pages = Number(options.pages) || 1;
  const copies = Number(options.copies) || 1;
  const parts = [
    pages + (pages === 1 ? ' page' : ' pages') + (copies > 1 ? ' × ' + copies + ' copies' : ''),
    options.paper === 'A4 Bond' ? 'Bond paper' : options.paper || 'A4',
    options.colourPages?.length ? 'Colour on ' + options.colourPages.length + ' pages' : options.colour ? 'Colour' : 'Black & white',
    options.duplex ? 'Double-sided' : 'Single-sided',
  ];
  if (options.orientation === 'Landscape') parts.push('Landscape');
  if (options.binding && options.binding !== 'none') parts.push(bindingNames[options.binding] || options.binding);
  return parts;
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
// Friendly early check. The server repeats it (upload_types.py) and is the one that counts.
const allowedFiles = new Map([
  ['pdf', ['application/pdf']], ['docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['jpg', ['image/jpeg']], ['jpeg', ['image/jpeg']], ['png', ['image/png']],
]);
const looksReal = {
  pdf: bytes => new TextDecoder('latin1').decode(bytes).includes('%PDF-'),
  docx: bytes => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4,
  jpg: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  png: bytes => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value),
};
async function fileProblem(file) {
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const types = allowedFiles.get(extension);
  const unsupported = ' can’t be added. Only PDF, DOCX, JPG and PNG files are supported.';
  if (!types) return '“' + file.name + '”' + unsupported;
  if (file.type && file.type !== 'application/octet-stream' && !types.includes(file.type)) return '“' + file.name + '”' + unsupported;
  const kind = extension === 'jpeg' ? 'jpg' : extension;
  const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (!looksReal[kind](bytes)) return '“' + file.name + '” is not a real ' + kind.toUpperCase() + ' file, so it can’t be added.';
  return '';
}

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
async function reviewFiles(chosen) {
  if (fileInput.disabled) return;
  if (!chosen.length) return;
  const refused = [];
  const files = [];
  for (const file of chosen) {
    const problem = await fileProblem(file);
    if (problem) refused.push(problem); else files.push(file);
  }
  const invalid = files.find(file => !file.size || file.size > maxFileSize);
  if (invalid || draftFiles.length + files.length > maxOrderFiles) {
    status.textContent = invalid ? invalid.name + ' must be non-empty and no larger than 50 MB.' : 'You can review up to 100 files at a time.';
    return;
  }
  for (const file of files) addDraft(file);
  review.hidden = draftFiles.length === 0;
  status.textContent = refused.join(' ');
  if (files.length) updateDraftTotal();
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
  if (!await pricingAvailable()) return;
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
const paperNames = {A4: 'Normal A4 sheet', 'A4 Bond': 'Bond paper sheet (recommended for major project reports)'};
const paperLabel = size => paperNames[size] || size;
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
let quotedDelivery = {};
let deliveryCampuses = [];

function checkoutDelivery(address) {
  const profile = readProfile();
  const withoutPin = text => text.replace(/\nDelivery pin:[^\n]*$/i,'').trim();
  return profile.deliveryType === 'campus' && profile.campus?.campusId &&
    withoutPin(address) === withoutPin(profile.address || '') ?
    {deliveryType:'campus',campusId:profile.campus.campusId} : {};
}

function showDeliveryLabel() {
  const label = document.querySelector('#checkout-label');
  if (!label || !checkoutForm) return;
  const f = checkoutForm.elements;
  const who = [f.customer.value.trim(),f.phone.value.trim()].filter(Boolean).join(' · ');
  const lines = f.address.value.replace(/\nDelivery pin:[^\n]*$/i,'').trim().split('\n').filter(Boolean);
  label.querySelector('.checkout-label-type').textContent = document.querySelector('#checkout-delivery-type')?.textContent.split(' · ')[0] || '';
  label.querySelector('.checkout-label-who').textContent = who || 'Your name · phone';
  label.querySelector('.checkout-label-line').textContent = lines[0] || 'Your delivery address';
  label.querySelector('.checkout-label-rest').textContent = lines.slice(1).join(', ');
  label.classList.toggle('is-empty',!who && !lines.length);
}
document.addEventListener('input',event => { if (event.target.closest?.('#checkout-delivery')) showDeliveryLabel(); });

function showDeliveryType(address) {
  const hint = document.querySelector('#checkout-delivery-type');
  if (!hint) return;
  const choice = checkoutDelivery(address);
  const campus = deliveryCampuses.find(item => item.id === choice.campusId);
  hint.textContent = choice.deliveryType === 'campus' ?
    ['On-campus delivery',campus?.eta].filter(Boolean).join(' · ') : 'Outside-campus delivery';
  showDeliveryLabel();
}
let placingOrder = false;
let queuedConfig;

function updatePrintOptions(group) {
  const id = group.dataset.printId;
  const paper = group.querySelector('select');
  const sizes = Object.keys(paperRates);
  const selectedPaper = paper.value;
  if (sizes.join() !== [...paper.options].filter(option => option.value).map(option => option.value).join()) {
    const options = sizes.map(size => new Option(paperLabel(size), size));
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
  const closed = document.querySelector('#warehouse-closed');
  const unavailable = config.serviceOpen === false;
  if (closed) closed.hidden = !unavailable;
  const workspace = document.querySelector('#upload-workspace');
  if (workspace) workspace.hidden = unavailable;
  if (fileInput) fileInput.disabled = unavailable;
  const message = document.querySelector('#upload-break-message');
  if (message) message.textContent = config.orderingPaused ?
    'We’re taking a short break from new orders. Please check back soon.' :
    'Our warehouses are closed right now. Please check back soon to place your order.';
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
  deliveryCampuses = terms.campuses || [];
  showDeliveryType(checkoutForm.elements.address.value);
  const slot = checkoutForm.elements.slot;
  if (JSON.stringify([...slot.options].map(option => option.value)) !== JSON.stringify(terms.slots)) {
    const selected = slot.value;
    slot.replaceChildren(...terms.slots.map(label => new Option(label, label)));
    if (terms.slots.includes(selected)) slot.value = selected;
  }
  slot.disabled = terms.slots.length === 0;
  slot.closest('label').hidden = slot.disabled;
  if (maps && !mapsReady) {
    setupDeliveryMap(maps, terms.serviceArea);
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
  if (config?.serviceOpen === false) {
    if (status) status.textContent = 'We’ll be back soon. New orders are temporarily unavailable.';
    return false;
  }
  if (config) return true;
  status.textContent = 'Current prices are temporarily unavailable. Try again.';
  return false;
}

if (form || checkout) window.printbeePricing.subscribe(applyCheckoutConfig);
// A newly opened Upload page must check availability even when prices are cached.
if (form) window.printbeePricing.refresh();

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
    const delivery = checkoutDelivery(address);
    showDeliveryType(address);
    const bill = await orderRequest('/api/checkout/quote', null, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({items: orderDocuments(items), coupon, address, ...delivery}),
    });
    if (version !== quoteVersion) return;
    activeBill = bill;
    appliedCoupon = coupon;
    quotedAddress = address;
    quotedDelivery = delivery;
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
  showDeliveryType(checkoutForm.elements.address.value);
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
  paymentNote.textContent = {
    test: 'Local test payment. No money is charged.',
    disabled: 'Payments are currently unavailable.',
  }[paymentMode] || '';
  paymentNote.hidden = !payment || !paymentNote.textContent;
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
  const f = checkoutForm.elements;
  document.querySelector('#checkout-delivery')?.classList.toggle('has-saved', Boolean(f.customer.value.trim() && f.phone.value.trim() && f.address.value.trim()));
  showDeliveryType(checkoutForm.elements.address.value);
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
  paperSelect.append(...Object.keys(paperRates).map(size => new Option(paperLabel(size), size)));
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
  if (!window.PrintBeeTracking || window.PrintBeeTracking.active) return;
  const errorPanel = document.querySelector('#orders-error');
  let accountOrders = [];
  let accountUnavailable = false;
  status.textContent = '';
  try {
    // Signed out: there is no account history to ask for (and asking would log a 401).
    const signedIn = Boolean((await (window.PrintBeeWho || Promise.resolve({email: 'unknown'}))).email);
    const response = signedIn ? await fetch('/api/orders') : {ok: false, status: 401};
    if (response.ok) {
      const data = await response.json();
      if (!Array.isArray(data.orders)) throw new Error('Invalid order list');
      accountOrders = data.orders;
      loadOrderUpdates().catch(() => {});
    } else if (response.status !== 401) {
      throw new Error('Order history unavailable');
    }
  } catch {
    accountUnavailable = true;
  }
  const accountIds = new Set(accountOrders.map(order => order.id));
  if (accountIds.size) startOrderFeed();
  const legacyOrders = await getLegacyOrders(accountIds).catch(() => []);
  const tracker = window.PrintBeeTracking;
  const filters = document.querySelector('#order-filters');
  const orders = [...accountOrders, ...legacyOrders];
  await removeDeliveredLocalFiles(orders.filter(order => order.status === 'delivered').map(order => order.id)).catch(() => {});
  orders.sort((left, right) => Number(tracker.isActive(right.status)) - Number(tracker.isActive(left.status)));
  orderHistory.replaceChildren();
  filters.hidden = !orders.length;
  let section;
  for (const order of orders) {
    const active = tracker.isActive(order.status);
    if (active !== section) {
      section = active;
      const heading = document.createElement('li');
      heading.className = 'track-list-heading';
      heading.dataset.group = active ? 'active' : 'past';
      const title = document.createElement('h2');
      title.textContent = active ? 'Active orders' : 'Past orders';
      heading.append(title);
      orderHistory.append(heading);
    }
    const row = tracker.orderRow(order, displayOrderNumber(order));
    const actions = row.querySelector('.order-actions');
    if (accountIds.has(order.id)) {
      const invoice = document.createElement('a');
      invoice.href = '/api/orders/' + order.id + '/invoice';
      invoice.textContent = 'Invoice';
      actions.append(invoice);
      const help = document.createElement('a');
      help.className = 'order-help';
      help.href = '/help.html#/new?order=' + encodeURIComponent(order.id);
      help.setAttribute('aria-label', 'Need help with ' + displayOrderNumber(order) + '?');
      // Buzz answers first, with this order selected. Without Buzz the link still opens a ticket.
      help.addEventListener('click', event => {
        if (window.PrintBeeBuzz && window.PrintBeeBuzz.open({orderNumber: displayOrderNumber(order)})) event.preventDefault();
      });
      const beeIcon = document.createElement('img');
      beeIcon.src = '/printbee-header-bee.webp';
      beeIcon.alt = '';
      beeIcon.width = 22;
      beeIcon.height = 20;
      help.append(beeIcon, document.createTextNode('Need help?'));
      actions.append(help);
    }
    const reorder = queueButton('Reorder', async () => {
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
    if (order.status === 'delivered') {
      const removed = document.createElement('small');
      removed.textContent = 'Files deleted after delivery verification.';
      actions.append(removed);
    } else if (!active) actions.append(reorder);
    orderHistory.append(row);
  }
  errorPanel.hidden = !accountUnavailable;
  if (!accountUnavailable && !orders.length) orderHistory.append(tracker.emptyOrders());
  tracker.applyFilter();

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

async function removeDeliveredLocalFiles(ids) {
  if (!ids.length) return;
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('orders', 'readwrite');
    const store = transaction.objectStore('orders');
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => {
        const order = request.result;
        if (!order?.items?.some(item => item.file)) return;
        store.put({...order, status:'delivered', items:order.items.map(({file,...item}) => ({...item,name:item.name || file?.name}))});
      };
    }
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
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
// Re-read account orders after events so active cards and filters follow the live list.
let orderFeed;
function startOrderFeed() {
  if (orderFeed || !window.PrintBeeLive) return;
  orderFeed = PrintBeeLive.start({
    as: 'customer',
    onSync: () => { if (!document.hidden) showOrders().catch(() => {}); },
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
      slot: order.slot, notes: order.notes, coupon: order.coupon, items, expectedTotal: order.total, ...order.delivery}),
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
    const signatureText = JSON.stringify({fields: [...data], ids: items.map(item => item.id), delivery: quotedDelivery});
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
    const order = {...attempt, customer, phone, address, items, delivery:quotedDelivery,
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
  window.top.location.assign('/orders/' + placedId + '?placed=1');
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

if (window.PrintBeeTracking?.active) {
  window.PrintBeeTracking.start(async id => {
    const db = await database;
    return new Promise((resolve, reject) => {
      const request = db.transaction('orders').objectStore('orders').get(id);
      request.onsuccess = () => resolve(request.result?.orderKey);
      request.onerror = () => reject(request.error);
    });
  });
}

Promise.all([showQueue(), showOrders()]).catch(() => {
  status.textContent = 'Local file storage is unavailable in this browser.';
});

if (queueList) {
  window.addEventListener('pageshow', event => {
    if (event.persisted) showQueue().catch(() => {});
  });
  window.addEventListener('message', event => {
    if (window.parent !== window && event.source === window.parent &&
        event.origin === location.origin && event.data === 'printbee:tab-shown') {
      showQueue().catch(() => {});
    }
  });
}
