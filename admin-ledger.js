const labels = {payment:'Online payments', offline:'Offline sales', refund:'Refunds', payout:'Partner payouts'};
const money = new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format;
const date = new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'});

function element(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

export function buildLedger(section, load, {demo = false} = {}) {
  const summary = element('dl');
  summary.className = 'ledger-summary ledger-equation';
  const amounts = {};
  for (const [key,label] of Object.entries({...labels,net:'Net recorded movement'})) {
    const value = element('dd', '—');
    const item = element('div');
    item.append(element('dt', label), value);
    summary.append(item);
    amounts[key] = value;
  }

  const filterLabel = element('label','Transaction type');
  const filter = element('select');
  filter.className = 'clay-input';
  filter.append(new Option('All transactions', ''), ...Object.entries(labels).map(([key,label]) => new Option(label,key)));
  filterLabel.append(filter);

  const button = text => {
    const control = element('button',text);
    control.type = 'button';
    control.className = 'clay-button';
    return control;
  };
  const refresh = button('Refresh ledger');
  const controls = element('div');
  controls.className = 'ledger-controls';
  const chips = element('div');
  chips.className = 'type-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Filter by type');
  for (const [key, text] of [['', 'All'], ['payment', 'Online'], ['offline', 'Offline'], ['refund', 'Refunds'], ['payout', 'Payouts']]) {
    const chip = button(text);
    chip.className = 'type-chip';
    chip.dataset.kind = key;
    chip.setAttribute('aria-pressed', String(key === ''));
    chip.onclick = () => { filter.value = key; filter.onchange(); };
    chips.append(chip);
  }
  controls.append(chips, filterLabel, refresh);

  const status = element('p');
  status.setAttribute('role', 'status');
  const table = element('table');
  table.className = 'admin-record-table';
  table.setAttribute('role','table');
  table.setAttribute('aria-label','Ledger transactions');
  const scroll = element('div');
  scroll.className = 'ledger-table';
  scroll.tabIndex = 0;
  scroll.setAttribute('role','region');
  scroll.setAttribute('aria-label','Scrollable ledger transactions');
  const headers = table.createTHead().insertRow();
  const columns = ['Date (IST)','Type','Order','Description','Reference','Amount'];
  for (const title of columns) {
    const header = element('th',title);
    header.scope = 'col';
    headers.append(header);
  }
  const body = table.createTBody();
  body.setAttribute('role','rowgroup');
  scroll.append(table);

  const pagination = element('div');
  pagination.className = 'ledger-controls ledger-pagination';
  const previous = button('Previous');
  const next = button('Next');
  const caption = element('span');
  pagination.append(previous, caption, next);
  previous.disabled = next.disabled = true;
  section.append(element('p',demo ? 'Sample ledger. Figures are for preview only.' :
    'All-time totals for captured payments, offline sales, processed refunds and recorded partner payouts.'),
    summary, controls, status, scroll, pagination);

  let page = 1;
  let revision = 0;
  async function update(target = page) {
    const id = ++revision;
    status.textContent = 'Loading ledger…';
    previous.disabled = next.disabled = true;
    try {
      const data = await load(target, filter.value);
      if (id !== revision) return;
      page = data.page;
      caption.textContent = 'Page ' + page + ' of ' + data.pages;
      for (const [key,value] of Object.entries(data.totals)) amounts[key].textContent = money(value / 100);
      amounts.net.textContent = money(Object.values(data.totals).reduce((total,value) => total + value,0) / 100);
      body.replaceChildren();
      for (const entry of data.entries) {
        const row = body.insertRow();
        const values = [entry.date == null ? 'Unavailable' : date.format(entry.date * 1000),
          labels[entry.kind], entry.order_number, entry.description, entry.reference || '—',
          money(entry.amount / 100)];
        row.setAttribute('role','row');
        values.forEach((value,index) => {
          const cell = row.insertCell();
          cell.setAttribute('role','cell');
          cell.dataset.label = columns[index];
          cell.textContent = value;
          if (index === 1) cell.className = 'type-' + entry.kind;
          if (index === 5) cell.className = entry.amount < 0 ? 'amount neg' : 'amount';
        });
      }
      if (!data.entries.length) {
        const empty = body.insertRow().insertCell();
        empty.colSpan = columns.length;
        empty.className = 'empty-cell';
        empty.textContent = 'No transactions match this selection.';
      }
      status.textContent = '';
      previous.disabled = page <= 1;
      next.disabled = page >= data.pages;
    } catch (error) {
      if (id === revision) status.textContent = error.message || 'Could not load the ledger. Try again.';
    }
  }

  filter.onchange = () => {
    page = 1;
    chips.querySelectorAll('.type-chip').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.kind === filter.value)));
    update();
  };
  refresh.onclick = () => update();
  previous.onclick = () => update(page - 1);
  next.onclick = () => update(page + 1);
  return update;
}
