/* Printers in the warehouse panel: the Printers page, the "Add printer" sheet, the "Print to" choice and "Send to another printer".
 * Loaded before warehouse.js and used by it (node, button, chip, icon, announce, render... come from there at run time).
 * Everything a printer or the print agent sends is shown with textContent, never as HTML. */

let fleetInfo = {inventory: {printers: [], errors: [], scannedAt: null, scanning: false}, agent: {online: false, lastSeen: null}, alerts: []};
let fleetStamp = 0, fleetBusy = false, scanTimer = 0, addFlow = null, alertWired = false;
const CHOICE_KEY = 'printbee-warehouse-print-choice';
const CONNECTION = {usb: ['USB', 'usb'], network: ['Wi-Fi or network', 'wifi'], pc: ['Installed on this PC', 'monitor']};

// ---- talking to the server (and a pretend server for the sample panel) ------------------------------------------------

async function printerCall(path, body) {
  if (preview) return demoPrinterCall(path, body);
  let response;
  try {
    response = await fetch(path, {method: body ? 'POST' : 'GET', cache: 'no-store', headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  } catch { throw new Error('Connection unavailable. Check your network and try again.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || (response.status === 403 ? 'Your warehouse session may have expired. Sign in again.' : 'That could not be saved. Try again.'));
    error.status = response.status;
    throw error;
  }
  return data;
}
function applyFleet(data) {
  if (!data || !Array.isArray(data.printers)) return;
  printers = data.printers;
  if (data.inventory) fleetInfo = {inventory: data.inventory, agent: data.agent || fleetInfo.agent, alerts: data.alerts || []};
}
async function loadPrinters() {
  try { applyFleet(await printerCall('/api/staff/printers')); } catch { /* the Printers page shows the error when it is opened */ }
  updatePrinterAlert();
}
async function refreshFleet(force = false) {
  if (fleetBusy || (!force && Date.now() - fleetStamp < 10000)) return;
  fleetBusy = true;
  fleetStamp = Date.now();
  try {
    const before = JSON.stringify([printers, fleetInfo.alerts, fleetInfo.agent.online]);
    applyFleet(await printerCall('/api/staff/printers'));
    updatePrinterAlert();
    const quiet = view === 'Printers' && !byId('warehouse-printer-sheet').open && !board.contains(document.activeElement);
    if (quiet && before !== JSON.stringify([printers, fleetInfo.alerts, fleetInfo.agent.online])) render(false);
  } catch { /* the next poll tries again */ }
  finally { fleetBusy = false; }
}
async function changePrinters(path, body, message) {
  applyFleet(await printerCall(path, body));
  announce(message, true);
  updatePrinterAlert();
  render();
}
function updatePrinterAlert() {
  const chipEl = byId('printer-alert');
  if (!chipEl) return;
  if (!alertWired) { alertWired = true; chipEl.addEventListener('click', () => go('Printers')); }
  const list = fleetInfo.alerts || [];
  chipEl.hidden = !list.length;
  if (!list.length) return;
  chipEl.textContent = list.length === 1 ? list[0].text : list.length + ' printer alerts';
  chipEl.classList.toggle('wh-bad', list.some(item => item.level === 'bad'));
  chipEl.classList.toggle('wh-attention', !list.some(item => item.level === 'bad'));
}

// ---- small helpers ----------------------------------------------------------------------------------------------------

function timeAgo(seconds) {
  if (!seconds) return 'never';
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  if (minutes < 1440) return Math.round(minutes / 60) + ' h ago';
  return Math.round(minutes / 1440) + ' d ago';
}
const STATE_WORD = {ready: 'Ready', busy: 'Printing', offline: 'Offline', 'paper-out': 'Out of paper', 'toner-low': 'Toner low', error: 'Needs attention'};
function dot(state) {
  const el = node('span', null, 'wh-dot wh-dot-' + (STATE_WORD[state] ? state : 'ready'));
  el.setAttribute('aria-hidden', 'true');
  return el;
}
function statusLine(entry) {
  const line = node('span', null, 'wh-pr-status');
  const word = !entry.enabled ? 'Paused' : STATE_WORD[entry.state] || 'Ready';
  line.append(dot(entry.enabled ? entry.state : 'offline'), node('span', word));
  if (entry.enabled && entry.reasonText && entry.reasonText !== word) line.append(node('small', entry.reasonText, 'wh-muted'));
  return line;
}
function capabilityChips(caps, extra = []) {
  const out = [];
  if (caps) {
    out.push(chip(caps.colour ? 'Colour' : 'Black & white'));
    if (caps.duplex) out.push(chip('Double-sided'));
    if (caps.maxSize) out.push(chip(caps.paperSizes && caps.paperSizes.length > 1 ? caps.paperSizes.join(' · ') : caps.maxSize));
  }
  return out.concat(extra);
}
function connectionTile(entry) {
  const tile = node('span', null, 'wh-pr-tile');
  tile.append(icon('printer'));
  const badge = node('span', null, 'wh-pr-conn');
  badge.title = (CONNECTION[entry.connection] || [''])[0] || '';
  badge.append(icon((CONNECTION[entry.connection] || ['', 'printer'])[1]));
  tile.append(badge);
  return tile;
}
function printerName(id) { return id == null ? null : (printers.find(entry => entry.id === id)?.name ?? null); }
function suppliesBlock(entry) {
  const shown = (entry.supplies || []).filter(item => item.level !== null && item.level !== undefined).slice(0, 5);
  if (!shown.length) return null;
  const wrap = node('div', null, 'wh-supplies');
  for (const item of shown) {
    const row = node('span', null, 'wh-supply');
    const bar = node('span', null, 'wh-supply-bar' + (item.level <= 10 ? ' wh-supply-low' : ''));
    const fill = node('span');
    fill.style.width = item.level + '%';
    bar.append(fill);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', item.name + ' ' + item.level + ' percent');
    row.append(node('small', item.name), bar, node('small', item.level + '%'));
    wrap.append(row);
  }
  return wrap;
}

// ---- the Printers page ------------------------------------------------------------------------------------------------

function agentCard() {
  const up = connected && online;
  const card = node('section', null, 'clay-card wh-pr-agent');
  const text = node('div');
  const line = node('div', null, 'wh-meta');
  const state = !connected || !online ? 'Offline' : paused ? 'Paused' : 'Online';
  line.append(node('h2', 'Print agent'), chip(state, 'wh-agent ' + (state === 'Online' ? 'wh-good' : state === 'Paused' ? 'wh-attention' : 'wh-bad')));
  const seen = fleetInfo.agent && fleetInfo.agent.lastSeen;
  text.append(line, node('p', up ? 'The program on the print-room computer is running' + (seen ? '. Last seen ' + timeAgo(seen) + '.' : '.') :
    'The program on the print-room computer is not running' + (seen ? '. Last seen ' + timeAgo(seen) + '.' : '.'), 'wh-muted'));
  if (!up) {
    const steps = node('ol', null, 'wh-agent-steps');
    ['Switch on the print-room computer.', 'Open the PrintBee Print Agent on it.', 'Wait a few seconds. This page turns Online by itself.'].forEach(step => steps.append(node('li', step)));
    text.append(node('h3', 'Start the agent', 'wh-agent-help'), steps);
  }
  if (preview) {
    const controls = node('div', null, 'wh-tool-actions');
    controls.append(button(paused ? 'Resume mock queue' : 'Pause mock queue', () => { paused = !paused; updateTop(); render(); }));
    text.append(controls);
  }
  card.append(icon('monitor'), text);
  return card;
}
function alertsStrip() {
  const list = fleetInfo.alerts || [];
  if (!list.length) return null;
  const strip = node('section', null, 'wh-pr-alerts');
  strip.setAttribute('aria-label', 'Printers that need attention');
  strip.append(node('h2', 'Needs attention'));
  const ul = node('ul');
  for (const item of list) {
    const li = node('li', null, item.level === 'bad' ? 'wh-alert-bad' : 'wh-alert-warn');
    li.append(icon('warning'), node('span', item.text));
    ul.append(li);
  }
  strip.append(ul);
  return strip;
}
function renderPrinters() {
  const wrap = node('div', null, 'wh-printers');
  wrap.append(agentCard());
  const strip = alertsStrip();
  if (strip) wrap.append(strip);
  const head = node('div', null, 'wh-pr-head');
  const title = node('div');
  title.append(node('h2', 'Your printers'));
  if (printers.length) title.append(node('p', printers.length + (printers.length === 1 ? ' printer' : ' printers'), 'wh-muted'));
  head.append(title);
  const add = button('', () => openAddPrinter(), 'clay-button wh-primary wh-pr-add');
  add.append(icon('plus'), node('span', 'Add printer'));
  head.append(add);
  wrap.append(head);
  if (!printers.length) {
    const empty = node('div', null, 'clay-card wh-empty');
    empty.append(icon('printer'), node('h3', 'No printers yet'), node('p', 'Press Add printer and PrintBee will look for the printers around your print-room computer.'));
    wrap.append(empty);
  }
  for (const entry of printers) wrap.append(printerCard(entry));
  const help = node('details', null, 'wh-pr-help');
  help.append(node('summary', 'How printers connect'),
    node('p', 'The PrintBee agent runs on the computer next to your printers. It looks for printers on that computer, on its USB ports and on the same Wi-Fi or network, and tells this page. Nothing prints on a printer until you add it here.'));
  wrap.append(help);
  board.append(wrap);
}
function printerCard(entry) {
  const card = node('section', null, 'clay-card wh-pr-card' + (entry.enabled === false ? ' wh-pr-paused' : ''));
  const legacy = !entry.deviceId;
  const body = node('div', null, 'wh-pr-body');
  const nameRow = node('div', null, 'wh-pr-name');
  nameRow.append(node('strong', entry.name));
  if (legacy) { if (entry.isDefault) nameRow.append(chip('Default', 'wh-good')); }
  else {
    if (entry.defaultMono) nameRow.append(chip('Default for black & white', 'wh-good'));
    if (entry.defaultColour) nameRow.append(chip('Default for colour', 'wh-good'));
    if (entry.enabled === false) nameRow.append(chip('Paused', 'wh-attention'));
  }
  body.append(nameRow, node('small', legacy ? entry.systemName : (entry.model || entry.systemName), 'wh-pr-sys'));
  if (!legacy) {
    body.append(statusLine(entry));
    const chips = node('div', null, 'wh-chips');
    capabilityChips(entry.capabilities).forEach(item => chips.append(item));
    body.append(chips);
    const supplies = suppliesBlock(entry);
    if (supplies) body.append(supplies);
    const stats = [entry.lastUsed ? 'Last used ' + timeAgo(entry.lastUsed) : 'Not used yet', (entry.jobsToday || 0) + (entry.jobsToday === 1 ? ' job today' : ' jobs today')];
    if (entry.queued) stats.push(entry.queued + ' waiting');
    body.append(node('small', stats.join(' · '), 'wh-muted'));
  }
  const actions = node('div', null, 'wh-pr-tools');
  const tool = (glyph, label, run, cls = '') => {
    const b = button('', run, 'wh-pr-tool wh-pr-tool-text ' + cls);
    b.setAttribute('aria-label', label + ', ' + entry.name);
    b.append(icon(glyph), node('span', label));
    return b;
  };
  if (!legacy) actions.append(tool('printer', 'Test print', async () => {
    const result = await printerCall('/api/staff/printers/' + entry.id + '/test', {});
    announce(result.queued ? 'Test page sent to ' + entry.name + '.' : 'A test page is already on its way to ' + entry.name + '.', true);
  }));
  else if (!entry.isDefault) actions.append(tool('star', 'Make default', () => changePrinters('/api/staff/printers', {id: entry.id, name: entry.name, systemName: entry.systemName, isDefault: true}, entry.name + ' is now the default.')));
  actions.append(tool('pencil', 'Rename', () => openRename(entry)));
  if (!legacy) actions.append(tool(entry.enabled === false ? 'play' : 'pause', entry.enabled === false ? 'Resume' : 'Pause', () =>
    changePrinters('/api/staff/printers/' + entry.id + '/update', {enabled: entry.enabled === false}, entry.name + (entry.enabled === false ? ' resumed.' : ' paused.'))));
  actions.append(tool('trash', 'Remove', () => openRemove(entry), 'wh-pr-danger'));
  card.append(connectionTile(entry), body, actions);
  return card;
}

// ---- the sheet (a dialog) used by add, rename, remove and send-to-another-printer ---------------------------------------

function sheetEl() { return byId('warehouse-printer-sheet'); }
function openSheet(title, build, onClose) {
  const dialog = sheetEl();
  byId('psheet-title').textContent = title;
  dialog.dataset.step = '';
  dialog._rebuild = build;
  dialog._onClose = onClose || null;
  byId('psheet-body').replaceChildren(build());
  if (!dialog.open) dialog.showModal();
  setTimeout(() => (dialog.querySelector('[data-autofocus]') || byId('psheet-close')).focus({preventScroll: true}), 0);
}
function redrawSheet(title) {
  const dialog = sheetEl();
  if (title) byId('psheet-title').textContent = title;
  byId('psheet-body').replaceChildren(dialog._rebuild());
  const focus = dialog.querySelector('[data-autofocus]');
  if (focus) focus.focus({preventScroll: true});
}
function closeSheetDialog() { const dialog = sheetEl(); if (dialog.open) dialog.close(); }
function wireSheet() {
  const dialog = sheetEl();
  if (!dialog || dialog._wired) return;
  dialog._wired = true;
  byId('psheet-close').append(icon('close'));
  byId('psheet-close').addEventListener('click', closeSheetDialog);
  dialog.addEventListener('click', event => { if (event.target === dialog) closeSheetDialog(); });
  dialog.addEventListener('close', () => {
    clearTimeout(scanTimer);
    addFlow = null;
    byId('psheet-body').replaceChildren();
    if (dialog._onClose) dialog._onClose();
    if (view === 'Printers') render(false);
  });
}
function sheetActions(...controls) { const row = node('div', null, 'wh-pr-actions wh-psheet-actions'); controls.forEach(c => row.append(c)); return row; }
function formError(host, message) {
  let line = host.querySelector('.wh-form-error');
  if (!line) { line = node('p', null, 'wh-form-error'); line.setAttribute('role', 'alert'); host.prepend(line); }
  line.textContent = message || '';
  line.hidden = !message;
}
function checkbox(label, checked, help) {
  const row = node('label', null, 'wh-check');
  const input = node('input');
  input.type = 'checkbox';
  input.checked = checked;
  const copy = node('span');
  copy.append(node('strong', label));
  if (help) copy.append(node('small', help, 'wh-muted'));
  row.append(input, copy);
  return [row, input];
}

// ---- rename / defaults, and remove ---------------------------------------------------------------------------------------

function openRename(entry) {
  openSheet('Rename printer', () => {
    const form = node('form', null, 'wh-pr-form');
    const wrap = node('label', null, 'wh-pr-field'), input = node('input', null, 'clay-input');
    input.value = entry.name; input.maxLength = 40; input.autocomplete = 'off'; input.dataset.autofocus = '1';
    wrap.append(node('span', 'Name'), input);
    form.append(wrap);
    let mono = null, colourBox = null;
    if (entry.deviceId) {
      let row;
      [row, mono] = checkbox('Use for black and white jobs by default', Boolean(entry.defaultMono));
      form.append(row);
      if (entry.capabilities && entry.capabilities.colour) { [row, colourBox] = checkbox('Use for colour jobs by default', Boolean(entry.defaultColour)); form.append(row); }
    }
    const save = node('button', 'Save', 'clay-button wh-primary');
    save.type = 'submit';
    form.append(sheetActions(save, button('Cancel', closeSheetDialog)));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        if (entry.deviceId) {
          const body = {name: input.value};
          if (mono.checked !== Boolean(entry.defaultMono)) body.defaultMono = mono.checked;
          if (colourBox && colourBox.checked !== Boolean(entry.defaultColour)) body.defaultColour = colourBox.checked;
          await changePrinters('/api/staff/printers/' + entry.id + '/update', body, 'Saved.');
        } else {
          await changePrinters('/api/staff/printers', {id: entry.id, name: input.value, systemName: entry.systemName, isDefault: entry.isDefault}, 'Saved.');
        }
        closeSheetDialog();
      } catch (error) { formError(form, error.message); save.disabled = false; }
    });
    return form;
  });
}
function openRemove(entry) {
  openSheet('Remove ' + entry.name + '?', () => {
    const box = node('div', null, 'wh-pr-form');
    box.append(node('p', 'Files already sent to it are not affected.' + (entry.queued ? ' ' + entry.queued + (entry.queued === 1 ? ' file is' : ' files are') + ' still waiting for it and will move to your default printer.' : '') +
      ' You can add it again later by scanning.'));
    const remove = button('Remove printer', async () => {
      await changePrinters(entry.deviceId ? '/api/staff/printers/' + entry.id + '/remove' : '/api/staff/printers/remove', entry.deviceId ? {} : {id: entry.id}, entry.name + ' removed.');
      closeSheetDialog();
    }, 'clay-button wh-primary wh-danger-button');
    remove.dataset.autofocus = '1';
    box.append(sheetActions(remove, button('Keep it', closeSheetDialog)));
    return box;
  });
}

// ---- Add printer: 1 Find, 2 Name, 3 Done ---------------------------------------------------------------------------------

function openAddPrinter() {
  addFlow = {step: 1, picked: null, scanning: false, error: '', notice: '', manual: false, added: null, testSent: false};
  openSheet('Add a printer', renderAddStep);
  void startScan();
}
function stepper(step) {
  const list = node('ol', null, 'wh-steps');
  ['Find', 'Name', 'Done'].forEach((label, index) => {
    const item = node('li', null, index + 1 < step ? 'is-done' : index + 1 === step ? 'is-now' : '');
    if (index + 1 === step) item.setAttribute('aria-current', 'step');
    item.append(node('span', index + 1 < step ? '✓' : String(index + 1)), node('b', label));
    list.append(item);
  });
  return list;
}
function renderAddStep() {
  const wrap = node('div', null, 'wh-add');
  if (!addFlow) return wrap;
  wrap.append(stepper(addFlow.step));
  if (addFlow.step === 1) wrap.append(renderFind());
  else if (addFlow.step === 2) wrap.append(renderName());
  else wrap.append(renderDone());
  return wrap;
}
async function startScan(address) {
  if (!addFlow) return;
  Object.assign(addFlow, {scanning: true, error: '', notice: ''});
  redrawSheet();
  try {
    const result = await printerCall('/api/staff/printers/scan', address ? {address} : {});
    if (result.agent && !result.agent.online) {
      Object.assign(addFlow, {scanning: false, error: 'The print agent is not running, so nothing can be found yet.'});
      fleetInfo.agent = result.agent;
      redrawSheet();
      return;
    }
  } catch (error) {
    if (!addFlow) return;
    Object.assign(addFlow, {scanning: false, notice: error.status === 429 ? error.message : '', error: error.status === 429 ? '' : error.message});
    redrawSheet();
    return;
  }
  pollScan();
}
function pollScan() {
  clearTimeout(scanTimer);
  const started = Date.now();
  const tick = async () => {
    if (!addFlow || !sheetEl().open) return;
    try { applyFleet(await printerCall('/api/staff/printers')); } catch { /* try again */ }
    if (!addFlow) return;
    if (!fleetInfo.inventory.scanning || Date.now() - started > 25000) {
      addFlow.scanning = false;
      if (fleetInfo.inventory.scanning) addFlow.error = 'The print computer did not answer. Check the agent is running and try again.';
      redrawSheet();
      return;
    }
    scanTimer = setTimeout(tick, 1500);
  };
  scanTimer = setTimeout(tick, 1200);
}
function radar() {
  const box = node('div', null, 'wh-radar');
  box.setAttribute('role', 'status');
  const rings = node('span', null, 'wh-radar-rings');
  rings.setAttribute('aria-hidden', 'true');
  rings.append(node('i'), node('i'), node('i'));
  const bee = node('img', null, 'wh-radar-bee');
  bee.src = '/printbee-header-bee.webp'; bee.alt = ''; bee.width = 72; bee.height = 64;
  box.append(rings, bee, node('p', 'Looking for printers…'), node('small', 'This takes a few seconds.', 'wh-muted'));
  return box;
}
function foundCard(found) {
  const card = node('button', null, 'wh-found' + (found.alreadyAdded ? ' is-added' : ''));
  card.type = 'button';
  card.disabled = found.alreadyAdded;
  const [label, glyph] = CONNECTION[found.connection] || CONNECTION.pc;
  const tile = node('span', null, 'wh-pr-tile');
  tile.append(icon(glyph));
  const copy = node('span', null, 'wh-found-copy');
  const top = node('span', null, 'wh-found-top');
  top.append(node('strong', found.model), statusLine({...found, enabled: true, reasonText: ''}));
  const chips = node('span', null, 'wh-chips');
  capabilityChips(found.capabilities, found.alreadyAdded ? [chip('Already added', 'wh-good')] : []).forEach(item => chips.append(item));
  copy.append(top, node('small', label + (found.host ? ' · ' + found.host : ''), 'wh-muted'), chips);
  card.append(tile, copy);
  card.addEventListener('click', () => { addFlow.picked = found; addFlow.step = 2; redrawSheet(); });
  return card;
}
function renderFind() {
  const box = node('div', null, 'wh-find');
  box.append(node('h3', 'Find printers'));
  if (addFlow.scanning) { box.append(radar()); return box; }
  if (addFlow.error) {
    const problem = node('div', null, 'wh-find-problem');
    problem.setAttribute('role', 'alert');
    problem.append(icon('warning'), node('p', addFlow.error));
    if (!fleetInfo.agent.online) {
      const steps = node('ol', null, 'wh-agent-steps');
      ['Switch on the print-room computer.', 'Open the PrintBee Print Agent on it.', 'Press Scan again.'].forEach(step => steps.append(node('li', step)));
      problem.append(steps);
    }
    box.append(problem);
  }
  if (addFlow.notice) box.append(node('p', addFlow.notice, 'wh-muted'));
  const found = (fleetInfo.inventory.printers || []).slice().sort((a, b) => Number(a.alreadyAdded) - Number(b.alreadyAdded) || a.model.localeCompare(b.model));
  if (found.length) {
    const list = node('div', null, 'wh-found-list');
    found.forEach(item => list.append(foundCard(item)));
    box.append(list);
  } else if (!addFlow.error) {
    const none = node('div', null, 'wh-find-empty');
    none.append(icon('printer'), node('h3', 'No printers found'),
      node('p', 'Check the printer is switched on, and that it is on the same Wi-Fi as the print-room computer or plugged into it with a USB cable.'));
    box.append(none);
  }
  for (const message of fleetInfo.inventory.errors || []) box.append(node('small', message, 'wh-muted wh-find-note'));
  const scanAgain = button('', () => startScan(), 'clay-button');
  scanAgain.append(icon('refresh'), node('span', 'Scan again'));
  const manual = button("Can't find it? Enter IP address", () => { addFlow.manual = !addFlow.manual; redrawSheet(); }, 'wh-text-link wh-linkbutton');
  box.append(sheetActions(scanAgain, manual));
  if (addFlow.manual) {
    const form = node('form', null, 'wh-pr-form wh-manual');
    const wrap = node('label', null, 'wh-pr-field'), input = node('input', null, 'clay-input');
    input.placeholder = '192.168.1.40'; input.maxLength = 100; input.autocomplete = 'off'; input.inputMode = 'url'; input.dataset.autofocus = '1';
    wrap.append(node('span', 'Printer IP address or name'), input, node('small', 'On the printer, look in its network or Wi-Fi settings.', 'wh-muted'));
    const go = node('button', 'Look for it', 'clay-button wh-primary');
    go.type = 'submit';
    form.append(wrap, sheetActions(go));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value || /\s|\//.test(value)) { formError(form, 'Enter an IP address or name, like 192.168.1.40.'); return; }
      addFlow.manual = false;
      void startScan(value);
    });
    box.append(form);
  }
  return box;
}
function suggestName(found) {
  const base = String(found.model || 'Printer').replace(/\s+/g, ' ').trim().slice(0, 36) || 'Printer';
  const taken = new Set(printers.map(entry => entry.name.toLowerCase()));
  let name = base, n = 2;
  while (taken.has(name.toLowerCase())) name = base.slice(0, 36 - String(n).length - 1) + ' ' + n++;
  return name;
}
function renderName() {
  const found = addFlow.picked;
  const form = node('form', null, 'wh-pr-form wh-name');
  form.append(node('h3', 'Name it'));
  const wrap = node('label', null, 'wh-pr-field'), input = node('input', null, 'clay-input');
  input.value = suggestName(found); input.maxLength = 40; input.autocomplete = 'off'; input.dataset.autofocus = '1';
  wrap.append(node('span', 'Printer name'), input);
  const kind = node('p', null, 'wh-kind');
  kind.append(icon('printer'), node('span', found.capabilities.colour ? 'Colour printer' : 'Black and white printer'), node('small', 'found automatically', 'wh-muted'));
  form.append(wrap, kind);
  const [monoRow, mono] = checkbox('Use for black and white jobs by default', !printers.some(entry => entry.defaultMono));
  form.append(monoRow);
  let colourBox = null;
  if (found.capabilities.colour) {
    const [colourRow, box] = checkbox('Use for colour jobs by default', !printers.some(entry => entry.defaultColour));
    colourBox = box;
    form.append(colourRow);
  }
  const add = node('button', 'Add printer', 'clay-button wh-primary');
  add.type = 'submit';
  const test = node('button', 'Add and print a test page', 'clay-button');
  test.type = 'button';
  const back = button('Back', () => { addFlow.step = 1; redrawSheet(); });
  const submit = async withTest => {
    add.disabled = test.disabled = true;
    try {
      applyFleet(await printerCall('/api/staff/printers', {deviceId: found.id, name: input.value, defaultMono: mono.checked, defaultColour: Boolean(colourBox && colourBox.checked)}));
      addFlow.added = printers.find(entry => entry.deviceId === found.id) || null;
      if (withTest && addFlow.added) addFlow.testSent = await sendTest(addFlow.added);
      updatePrinterAlert();
      addFlow.step = 3;
      if (view === 'Printers') render(false);
      redrawSheet();
    } catch (error) { formError(form, error.message); add.disabled = test.disabled = false; }
  };
  form.addEventListener('submit', event => { event.preventDefault(); void submit(false); });
  test.addEventListener('click', () => void submit(true));
  form.append(sheetActions(add, test, back));
  return form;
}
async function sendTest(entry) {
  try { const result = await printerCall('/api/staff/printers/' + entry.id + '/test', {}); void result; return true; }
  catch (error) { announce(error.message, true); return false; }
}
function renderDone() {
  const box = node('div', null, 'wh-done');
  const mark = node('span', null, 'wh-done-mark');
  mark.append(icon('check'));
  const name = addFlow.added ? addFlow.added.name : 'Your printer';
  box.append(mark, node('h3', name + ' is ready'), node('p', 'It now appears on the Printers page and in the Print to list.' + (addFlow.testSent ? ' A test page is on its way.' : ''), 'wh-muted'));
  const actions = [];
  if (addFlow.added && !addFlow.testSent) {
    const test = button('Print a test page', async () => { addFlow.testSent = await sendTest(addFlow.added); redrawSheet(); }, 'clay-button');
    actions.push(test);
  }
  const another = button('Add another', () => { addFlow.step = 1; addFlow.picked = null; redrawSheet(); void startScan(); });
  const done = button('Done', closeSheetDialog, 'clay-button wh-primary');
  done.dataset.autofocus = '1';
  box.append(sheetActions(...actions, another, done));
  return box;
}

// ---- Print to: choose where files print ---------------------------------------------------------------------------------------

function printerProblem(entry, items) {
  if (entry.enabled === false) return 'Paused';
  const caps = entry.capabilities;
  if (caps) {
    if (items.some(item => item.colour) && !caps.colour) return 'No colour';
    if (items.some(item => item.duplex) && !caps.duplex) return 'No double-sided';
    const sizes = caps.paperSizes || [];
    const missing = items.map(item => item.paper || 'A4').find(size => sizes.length && !sizes.includes(size));
    if (missing) return 'No ' + missing;
  }
  if (entry.state === 'offline') return 'Offline';
  if (entry.state === 'paper-out') return 'Out of paper';
  if (entry.state === 'error') return 'Needs attention';
  return null;
}
function readChoices() { try { return JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}') || {}; } catch { return {}; } }
function bestPrinterFor(item) {
  const usable = printers.filter(entry => !printerProblem(entry, [item]));
  if (!usable.length) return null;
  const kind = item.colour ? 'colour' : 'mono';
  const remembered = usable.find(entry => entry.id === readChoices()[kind]);
  if (remembered) return remembered.id;
  const preferred = usable.find(entry => item.colour ? entry.defaultColour : (entry.defaultMono || entry.isDefault));
  if (preferred) return preferred.id;
  return usable.slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0].id;
}
function printPlanFor(order, selected) {
  const items = selected.map(index => order.items[index]);
  const plan = {ids: {}, none: !printers.length, rememberIt: false, picker: null};
  plan.blocked = () => plan.none ? null : (selected.some(index => plan.ids[index] == null || printerProblem(printers.find(p => p.id === plan.ids[index]) || {}, [order.items[index]]))
    ? 'No printer is ready for these files. Wait for one to be ready, or choose another.' : null);
  plan.remember = () => {
    if (!plan.rememberIt) return;
    const choices = readChoices();
    for (const index of selected) if (plan.ids[index] != null) choices[order.items[index].colour ? 'colour' : 'mono'] = plan.ids[index];
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify(choices)); } catch { /* not remembered */ }
  };
  if (plan.none) {
    plan.picker = node('p', preview ? 'Printer: Mock printer' : 'Printer: the agent’s default');
    plan.changed = () => {};
    return plan;
  }
  selected.forEach(index => { plan.ids[index] = bestPrinterFor(order.items[index]); });
  const picker = node('fieldset', null, 'wh-printto');
  picker.append(node('legend', 'Choose a printer'));
  const chipsBox = node('div', null, 'wh-pt-chips');
  const radios = [];
  const note = node('p', null, 'wh-pt-note');
  note.setAttribute('role', 'status');
  const selects = [];
  const sync = () => {
    const same = selected.every(index => plan.ids[index] === plan.ids[selected[0]]) ? plan.ids[selected[0]] : undefined;
    radios.forEach(([input, id]) => { input.checked = id === same; });
    selects.forEach(([select, index]) => { select.value = plan.ids[index] == null ? '' : String(plan.ids[index]); });
    const problem = plan.blocked();
    note.textContent = problem || (same === undefined ? 'Each file goes to its best match.' : printerName(same) + (items.length > 1 ? ' for all files.' : '.'));
    note.classList.toggle('is-problem', Boolean(problem));
    const slide = byId('floor-print-slide');
    if (slide) slide.disabled = Boolean(problem);
  };
  plan.changed = sync;
  for (const entry of printers) {
    const problem = printerProblem(entry, items);
    const row = node('label', null, 'wh-pt-chip' + (problem ? ' is-dim' : ''));
    const input = node('input');
    input.type = 'radio'; input.name = 'print-to'; input.disabled = Boolean(problem); input.value = String(entry.id);
    input.addEventListener('change', () => { selected.forEach(index => { plan.ids[index] = entry.id; }); sync(); });
    radios.push([input, entry.id]);
    const tile = node('span', null, 'wh-pt-tile');
    tile.append(icon('printer'));
    const copy = node('span', null, 'wh-pt-copy');
    copy.append(node('strong', entry.name));
    if (problem) copy.append(node('small', problem, 'wh-pt-reason')); else copy.append(node('small', entry.capabilities ? (entry.capabilities.colour ? 'Colour' : 'Black & white') : 'Ready', 'wh-muted'));
    row.append(input, tile, copy);
    chipsBox.append(row);
  }
  picker.append(chipsBox, note);
  if (selected.length > 1 && printers.length > 1) {
    const more = node('details', null, 'wh-pt-more');
    more.append(node('summary', 'Choose a printer for each file'));
    for (const index of selected) {
      const line = node('label', null, 'wh-pt-file');
      const select = node('select', null, 'clay-input');
      const blank = node('option', 'Pick a printer'); blank.value = '';
      select.append(blank);
      for (const entry of printers) {
        const problem = printerProblem(entry, [order.items[index]]);
        const option = node('option', entry.name + (problem ? ' (' + problem + ')' : '')); option.value = String(entry.id); option.disabled = Boolean(problem);
        select.append(option);
      }
      select.addEventListener('change', () => { plan.ids[index] = select.value ? Number(select.value) : null; sync(); });
      selects.push([select, index]);
      line.append(node('span', order.items[index].name), select);
      more.append(line);
    }
    picker.append(more);
  }
  const [rememberRow, rememberBox] = checkbox('Remember my choice', false);
  rememberBox.addEventListener('change', () => { plan.rememberIt = rememberBox.checked; });
  picker.append(rememberRow);
  plan.picker = picker;
  sync();
  return plan;
}
async function queueSelected(order, index, selected, plan) {
  let queued = 0;
  for (const position of selected) {
    const id = plan.ids[position];
    const result = await printerCall('/api/staff/orders/' + order.id + '/print/' + position, id == null ? {} : {printerId: id});
    queued += result.queued || 0;
  }
  return queued;
}
function jobPrinterChips(job) {
  if (!job) return [];
  const out = [];
  if (job.state === 'queued' && job.waiting) {
    out.push(chip('Waiting for printer', 'wh-attention'), node('small', job.waiting + (job.printerName ? ' · ' + job.printerName : ''), 'wh-muted wh-job-wait'));
  } else if (job.printerName) {
    out.push(chip((job.state === 'done' ? 'Printed on ' : 'On ') + job.printerName, 'wh-printer-chip'));
  }
  return out;
}

// ---- Send to another printer ---------------------------------------------------------------------------------------------------

function openReroute(order, index) {
  const item = order.items[index];
  const job = order.jobs.find(entry => entry.position === index);
  openSheet('Send to another printer', () => {
    const box = node('div', null, 'wh-pr-form');
    box.append(node('p', item.name + (job && job.waiting ? ' is waiting: ' + job.waiting + '.' : '.')));
    const list = node('div', null, 'wh-pt-chips');
    for (const entry of printers.filter(p => !job || p.id !== job.printerId)) {
      const problem = printerProblem(entry, [item]);
      const row = button('', async () => {
        if (preview) {
          if (job) { job.printerId = entry.id; job.printerName = entry.name; job.waiting = null; }
        } else {
          await printerCall('/api/staff/orders/' + order.id + '/print/' + index + '/reroute', {printerId: entry.id});
        }
        closeSheetDialog();
        await refreshAfterAction('Sent to ' + entry.name + '.');
      }, 'wh-pt-chip wh-pt-button' + (problem ? ' is-dim' : ''));
      row.disabled = Boolean(problem);
      const tile = node('span', null, 'wh-pt-tile');
      tile.append(icon('printer'));
      const copy = node('span', null, 'wh-pt-copy');
      copy.append(node('strong', entry.name), node('small', problem || 'Send here', problem ? 'wh-pt-reason' : 'wh-muted'));
      row.append(tile, copy);
      list.append(row);
    }
    box.append(list, sheetActions(button('Cancel', closeSheetDialog)));
    return box;
  });
}

// ---- a pretend printer system for the sample panel (?preview=1): no hardware needed -----------------------------------------------

const demo = {printers: null, inventory: null, scanUntil: 0, requestedAt: 0, next: 10};
function demoSetup() {
  if (demo.printers) return;
  const now = Math.floor(Date.now() / 1000);
  const mk = (id, device, name, model, connection, host, caps, state, extra = {}) => ({id, name, systemName: model, isDefault: false, deviceId: device, model, connection, host,
    capabilities: caps, defaultMono: false, defaultColour: false, enabled: true, state, reasons: [], reasonText: '', supplies: [], updatedAt: now, lastUsed: null, jobsToday: 0, queued: 0, ...extra});
  const mono = {colour: false, duplex: true, paperSizes: ['A4'], maxSize: 'A4', pdf: false};
  const col = {colour: true, duplex: true, paperSizes: ['A4', 'A3'], maxSize: 'A3', pdf: true};
  demo.inventory = [
    {id: 'p_000000000001', model: 'Mock LaserJet B&W', connection: 'usb', host: null, state: 'ready', capabilities: mono, supplies: [{name: 'Black toner', level: 72, type: 'toner'}]},
    {id: 'p_000000000002', model: 'Mock InkJet Colour', connection: 'network', host: '192.168.1.50', state: 'ready', capabilities: col, supplies: [{name: 'Black ink', level: 55, type: 'ink'}, {name: 'Cyan ink', level: 40, type: 'ink'}]},
    {id: 'p_000000000003', model: 'Mock Office Printer (off)', connection: 'pc', host: null, state: 'offline', capabilities: {...mono, duplex: false}, supplies: []},
    {id: 'p_000000000004', model: 'Mock Laser (no paper)', connection: 'network', host: '192.168.1.60', state: 'paper-out', capabilities: {...mono, duplex: false, pdf: true}, supplies: [{name: 'Black toner', level: 8, type: 'toner'}]},
  ];
  demo.printers = [
    mk(1, 'p_000000000001', 'Front desk printer', 'Mock LaserJet B&W', 'usb', null, mono, 'ready', {defaultMono: true, isDefault: true, supplies: demo.inventory[0].supplies, lastUsed: now - 420, jobsToday: 6}),
    mk(2, 'p_000000000002', 'Colour printer', 'Mock InkJet Colour', 'network', '192.168.1.50', col, 'ready', {defaultColour: true, supplies: demo.inventory[1].supplies, lastUsed: now - 3600, jobsToday: 2}),
  ];
}
function demoAlerts() {
  const words = {offline: 'Printer is offline', 'paper-out': 'Out of paper', 'toner-low': 'Toner low', error: 'Printer error'};
  return demo.printers.filter(p => p.enabled && words[p.state]).map(p => ({level: p.state === 'toner-low' ? 'attention' : 'bad', printerId: p.id, text: p.name + ': ' + words[p.state]}));
}
function demoView() {
  const now = Math.floor(Date.now() / 1000);
  const added = new Set(demo.printers.map(p => p.deviceId));
  return {printers: demo.printers.map(p => ({...p, reasonText: p.state === 'ready' || p.state === 'busy' ? '' : (STATE_WORD[p.state] || '')})), agent: {online: true, lastSeen: now},
    inventory: {printers: demo.inventory.map(p => ({...p, alreadyAdded: added.has(p.id)})), errors: [], scannedAt: now, scanning: Date.now() < demo.scanUntil}, alerts: demoAlerts()};
}
async function demoPrinterCall(path, body) {
  demoSetup();
  await new Promise(resolve => setTimeout(resolve, 80));
  if (!body) return demoView();
  const fail = message => { const error = new Error(message); error.status = 400; throw error; };
  const ident = path.match(/printers\/(\d+)\/(update|remove|test)$/);
  if (path.endsWith('/scan')) {
    demo.scanUntil = Date.now() + 1800;
    if (body.address) {
      const host = String(body.address);
      if (!demo.inventory.some(p => p.host === host)) demo.inventory.push({id: 'p_' + String(Date.now()).slice(-12).padStart(12, '0'), model: 'Printer at ' + host, connection: 'network', host, state: 'ready',
        capabilities: {colour: false, duplex: false, paperSizes: ['A4'], maxSize: 'A4', pdf: true}, supplies: []});
    }
    return {pending: true, requestedAt: Math.floor(Date.now() / 1000), agent: {online: true}};
  }
  if (ident) {
    const entry = demo.printers.find(p => p.id === Number(ident[1]));
    if (!entry) fail('That printer no longer exists.');
    if (ident[2] === 'test') return {queued: true};
    if (ident[2] === 'remove') demo.printers = demo.printers.filter(p => p !== entry);
    else {
      if ('name' in body) { const name = String(body.name).trim(); if (!name || name.length > 40) fail('Enter a printer name of up to 40 characters.'); entry.name = name; }
      if ('enabled' in body) entry.enabled = body.enabled;
      if (body.defaultMono === true) demo.printers.forEach(p => { p.defaultMono = p === entry; p.isDefault = p === entry; }); else if (body.defaultMono === false) entry.defaultMono = false;
      if (body.defaultColour === true) { if (!entry.capabilities.colour) fail("This printer can't print in colour, so it can't be the colour default."); demo.printers.forEach(p => { p.defaultColour = p === entry; }); }
      else if (body.defaultColour === false) entry.defaultColour = false;
    }
    return demoView();
  }
  if (body.deviceId) {
    const found = demo.inventory.find(p => p.id === body.deviceId);
    if (!found) fail('That printer was not found. Scan again and pick it from the list.');
    if (demo.printers.some(p => p.deviceId === found.id)) fail('That printer is already added.');
    const name = String(body.name || found.model).trim();
    if (!name || name.length > 40) fail('Enter a printer name of up to 40 characters.');
    if (demo.printers.some(p => p.name.toLowerCase() === name.toLowerCase())) fail('Another printer already has that name.');
    const entry = {id: demo.next++, name, systemName: found.model, isDefault: false, deviceId: found.id, model: found.model, connection: found.connection, host: found.host, capabilities: found.capabilities,
      defaultMono: false, defaultColour: false, enabled: true, state: found.state, reasons: [], reasonText: '', supplies: found.supplies, updatedAt: Math.floor(Date.now() / 1000), lastUsed: null, jobsToday: 0, queued: 0};
    demo.printers.push(entry);
    if (body.defaultMono) demo.printers.forEach(p => { p.defaultMono = p === entry; p.isDefault = p === entry; });
    if (body.defaultColour && found.capabilities.colour) demo.printers.forEach(p => { p.defaultColour = p === entry; });
    return demoView();
  }
  return demoView();
}
window.addEventListener('DOMContentLoaded', wireSheet);
