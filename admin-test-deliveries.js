/* Practice orders use the real partner flow and remain separate from sales. */
export function setupTestDeliveries(source, refresh) {
  const dialog = document.createElement('dialog');
  dialog.id = 'test-delivery-dialog';
  dialog.setAttribute('aria-labelledby', 'test-delivery-title');
  document.body.append(dialog);
  const make = (tag, text, attrs = {}) => Object.assign(document.createElement(tag), {textContent: text, ...attrs});
  const close = () => make('button', 'Close', {type: 'button', onclick: () => dialog.close()});
  function show(title) {
    const heading = make('h2', title, {id: 'test-delivery-title'});
    dialog.replaceChildren(heading);
    if (!dialog.open) dialog.showModal();
  }
  function view(order) {
    show(order.number);
    dialog.append(make('p', 'Practice only. No customer, payment, printing or travel required.'));
    const status = make('p', '', {role: 'status'});
    const code = make('strong', '', {id: 'test-delivery-code'});
    const error = make('p', '', {role: 'alert'});
    function paint(current) {
      order = current;
      status.textContent = 'Status: ' + (window.PrintBeeStatus?.label(current.status) || current.status);
      code.textContent = current.code ? 'Test delivery OTP: ' + current.code : current.status === 'delivered' ?
        'Test complete. No payout was created.' : current.status === 'out_for_delivery' ?
        'Code unavailable. Renew the code below if it expired or was locked.' :
        'Go online in the selected partner account, accept this PB-TEST order and confirm pickup. Then refresh here for the OTP.';
      code.dataset.hasCode = String(Boolean(current.code));
      renew.hidden = current.status !== 'out_for_delivery';
    }
    const reload = make('button', 'Refresh status / OTP', {type: 'button', onclick: async () => {
      reload.disabled = true;
      error.textContent = '';
      try { paint(await source.api('/api/admin/test-deliveries/' + order.id)); }
      catch (failure) { error.textContent = failure.message; }
      finally { reload.disabled = false; }
    }});
    const renew = make('button', 'Renew test OTP', {type: 'button', onclick: async () => {
      renew.disabled = true;
      try {
        await source.api('/api/admin/orders/' + order.id + '/renew-code', {});
        paint(await source.api('/api/admin/test-deliveries/' + order.id));
      } catch (failure) { error.textContent = failure.message; }
      finally { renew.disabled = false; }
    }});
    const actions = make('div', '', {className: 'actions'});
    actions.append(reload, renew, close());
    dialog.append(status, code, error, actions);
    paint(order);
  }
  document.getElementById('create-test-delivery').onclick = () => {
    show('Create test delivery');
    const form = make('form', '');
    const label = make('label', 'Delivery partner');
    const select = make('select', '', {required: true, id: 'test-delivery-partner'});
    select.append(new Option('Choose a partner', ''));
    for (const partner of source.partners) select.append(new Option(partner.name || partner.email || partner.id, partner.id));
    label.append(select);
    const error = make('p', '', {role: 'alert'});
    const submit = make('button', 'Create test delivery', {type: 'submit', className: 'primary'});
    const actions = make('div', '', {className: 'actions'});
    actions.append(close(), submit);
    form.append(make('p', 'Creates a separate PB-TEST order for this partner only. It starts ready for pickup and does not count toward sales or earnings.'), label, error, actions);
    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        const order = await source.api('/api/admin/test-deliveries', {partner: select.value});
        await refresh();
        view(order);
      } catch (failure) { error.textContent = failure.message; }
      finally { submit.disabled = false; }
    };
    dialog.append(form);
  };
  return function renderTests() {
    const host = document.getElementById('test-deliveries-list');
    if (!host) return;
    const list = source.info.testDeliveries || [];
    if (!list.length) host.append(make('li', 'No test deliveries yet. Use Create test delivery above.'));
    for (const order of list) {
      const row = make('li', '');
      const button = make('button', order.number + ' · ' + (window.PrintBeeStatus?.label(order.status) || order.status), {
        type: 'button', onclick: async () => {
          button.disabled = true;
          try { view(await source.api('/api/admin/test-deliveries/' + order.id)); }
          catch (failure) { document.getElementById('notice').textContent = failure.message; }
          finally { button.disabled = false; }
        },
      });
      row.append(button);
      host.append(row);
    }
  };
}
