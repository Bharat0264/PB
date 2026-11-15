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
  summary.className = 'ledger-summary';
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
  controls.append(filterLabel, refresh);

  const status = element('p');
  status.setAttribute('role', 'status');
  const table = element('table');
  table.setAttribute('aria-label','Ledger transactions');
  const scroll = element('div');
  scroll.className = 'ledger-table';
  scroll.tabIndex = 0;
  scroll.setAttribute('role','region');
  scroll.setAttribute('aria-label','Scrollable ledger transactions');
  const headers = table.createTHead().insertRow();
  for (const title of ['Date (IST)','Type','Order','Description','Reference','Amount']) {
    const header = element('th',title);
    header.scope = 'col';
    headers.append(header);
  }
  const body = table.createTBody();
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
        for (const value of values) row.insertCell().textContent = value;
      }
      status.textContent = data.entries.length ? '' : 'No transactions match this selection.';
      previous.disabled = page <= 1;
      next.disabled = page >= data.pages;
    } catch (error) {
      if (id === revision) status.textContent = error.message || 'Could not load the ledger. Try again.';
    }
  }

  filter.onchange = () => { page = 1; update(); };
  refresh.onclick = () => update();
  previous.onclick = () => update(page - 1);
  next.onclick = () => update(page + 1);
  return update;
}
