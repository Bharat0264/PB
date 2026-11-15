const printLabels = ['B&W single-sided', 'B&W double-sided', 'Colour single-sided', 'Colour double-sided'];
const bindings = {glossy:'Glossy soft binding', blue:'Blue sheet binding', spiral:'Spiral binding', staple:'Staple binding'};
const feeLabels = {platform:'Platform fee', packing:'Packing fee', surge:'Surge fee',
  delivery:'Base delivery fee', deliveryPerKm:'Delivery rate (₹/km)'};

export function buildPricingForm(terms, save, {demo = false} = {}) {
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const form = element('form');
  form.className = 'admin-pricing-form';
  function group(title) {
    const set = element('fieldset');
    const fields = element('div');
    fields.className = 'pricing-fields';
    set.append(element('legend', title), fields);
    form.append(set);
    return fields;
  }
  function rate(fields, title, value, {min = 0, required = true} = {}) {
    const label = element('label', title);
    const input = element('input');
    Object.assign(input, {type:'number', inputMode:'decimal', step:'0.01', min, required,
      value:value == null ? '' : String(value / 100), className:'clay-input'});
    label.append(input);
    fields.append(label);
    return input;
  }
  const toPaise = input => {
    const paise = Math.round(Number(input.value) * 100);
    if (!Number.isSafeInteger(paise)) throw new Error('Enter a smaller amount.');
    return paise;
  };
  form.append(element('p', demo ? 'Preview changes apply to this session only.' : 'Enter amounts in rupees. Published rates apply to new checkout orders.'));
  const papers = {};
  for (const paper of ['A4','A3','A5']) {
    const fields = group(paper + ' printing · ₹ per page');
    const prices = terms.paperRates[paper];
    papers[paper] = printLabels.map((label, index) => rate(fields, label, prices?.[index], {min:1, required:paper === 'A4'}));
    if (paper !== 'A4') {
      const help = element('p', 'Leave all four rates blank to hide ' + paper + ' at checkout.');
      fields.before(help);
      for (const input of papers[paper]) input.addEventListener('input', () => {
        const enabled = papers[paper].some(field => field.value !== '');
        for (const field of papers[paper]) field.required = enabled;
      });
    }
  }
  const bindingFields = group('Binding · ₹ per copy');
  const bindingInputs = Object.entries(bindings).map(([key, label]) => [key, rate(bindingFields,
    label, terms.bindingRates[key], {required:key === 'glossy' || key === 'blue'})]);
  bindingFields.before(element('p', 'Leave spiral or staple blank to hide that option.'));
  const feeFields = group('Fees');
  feeFields.before(element('p', 'Delivery uses the base fee plus the straight-line distance from the default warehouse to the customer’s pin. Use warehouse coordinates to enable a per-km rate.'));
  const feeInputs = Object.entries(feeLabels).map(([key, label]) => [key, rate(feeFields, label, terms[key] ?? 0)]);
  let advanced;
  if (!demo) {
    const settings = element('details');
    settings.append(element('summary', 'Advanced checkout settings'));
    const label = element('label', 'Tax, coupons, delivery slots, partner payout and auto-dispatch (JSON)');
    advanced = element('textarea');
    advanced.rows = 8;
    advanced.className = 'clay-input';
    advanced.value = JSON.stringify(Object.fromEntries(['taxBasisPoints','coupons','slots','partnerPayout','autoDispatch']
      .map(key => [key, terms[key]])), null, 2);
    label.append(advanced);
    settings.append(label);
    form.append(settings);
  }
  const submit = element('button', demo ? 'Save preview pricing' : 'Publish pricing');
  submit.type = 'submit';
  submit.className = 'clay-button primary';
  const notice = element('p');
  notice.setAttribute('role','status');
  form.append(submit, notice);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    notice.textContent = '';
    try {
      const extras = advanced ? JSON.parse(advanced.value) : {};
      if (!extras || Array.isArray(extras) || typeof extras !== 'object') throw new Error('Enter a JSON object for advanced settings.');
      const changes = Object.fromEntries(Object.entries(extras)
        .filter(([key]) => ['taxBasisPoints','coupons','slots','partnerPayout','autoDispatch'].includes(key)));
      changes.paperRates = Object.fromEntries(Object.entries(papers)
        .filter(([,inputs]) => inputs.some(input => input.value !== ''))
        .map(([paper, inputs]) => [paper, inputs.map(toPaise)]));
      changes.bindingRates = Object.fromEntries(bindingInputs
        .filter(([,input]) => input.value !== '').map(([key,input]) => [key,toPaise(input)]));
      for (const [key,input] of feeInputs) changes[key] = toPaise(input);
      notice.textContent = await save(changes);
    } catch (error) {
      notice.textContent = error instanceof SyntaxError ? 'Check the advanced settings JSON.' : error.message;
    } finally {
      submit.disabled = false;
    }
  };
  return form;
}
