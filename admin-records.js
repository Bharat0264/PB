// Reused by the demo editor and the signed-in offline-order form.
export function addOfflineOrderFields(container, products = []) {
  const rows = document.createElement('div');
  rows.className = 'offline-rows';
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '+ Add another order';
  add.className = 'clay-button';

  function update() {
    [...rows.children].forEach((row, index) => {
      row.querySelector('legend').textContent = 'Order ' + (index + 1);
      const remove = row.querySelector('button');
      remove.hidden = rows.childElementCount === 1;
      remove.setAttribute('aria-label', 'Remove order ' + (index + 1));
    });
    add.disabled = rows.childElementCount >= 25;
  }

  function rowField(row, title, name, control) {
    const label = document.createElement('label');
    label.textContent = title;
    control.name = name;
    control.required = true;
    control.className = 'clay-input';
    label.append(control);
    row.append(label);
  }

  function appendRow(focus = false) {
    const row = document.createElement('fieldset');
    row.className = 'offline-row';
    row.dataset.id = crypto.randomUUID();
    row.append(document.createElement('legend'));
    const customer = document.createElement('input');
    customer.maxLength = 70;
    rowField(row, 'Customer', 'customer', customer);
    const service = document.createElement(products.length ? 'select' : 'input');
    if (products.length) for (const product of products) service.add(new Option(product.name));
    else service.maxLength = 100;
    rowField(row, 'Product or service', 'product', service);
    const amount = document.createElement('input');
    Object.assign(amount, {type:'number', min:'0.01', max:'999999', step:'0.01'});
    rowField(row, 'Amount received (INR)', 'amount', amount);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'clay-button';
    remove.textContent = 'Remove';
    remove.onclick = () => { row.remove(); update(); add.focus(); };
    row.append(remove);
    rows.append(row);
    update();
    if (focus) customer.focus();
  }

  add.onclick = () => appendRow(true);
  container.append(rows, add);
  appendRow();
  return () => [...rows.children].map(row => {
    const value = name => row.querySelector('[name="' + name + '"]').value.trim();
    return {id:row.dataset.id, customer:value('customer'), product:value('product'), amount:value('amount')};
  });
}

export function pickupMapUrl(address) {
  return 'https://www.google.com/maps/search/?' + new URLSearchParams({api:1, query:address});
}
