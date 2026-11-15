const printCatalog = document.querySelector('[data-print-catalog]');
if (printCatalog) {
  const picker = printCatalog.querySelector('[data-paper-picker]');
  const status = printCatalog.querySelector('[data-price-status]');
  const currency = new Intl.NumberFormat('en-IN', {style:'currency',currency:'INR',minimumFractionDigits:0,maximumFractionDigits:2});
  let catalog;

  function renderPaper() {
    const rates = catalog.paperRates[picker.value];
    printCatalog.querySelector('#print-rates-title').textContent = picker.value + ' printing';
    for (const cell of printCatalog.querySelectorAll('[data-print-rate]')) {
      cell.textContent = currency.format(rates[Number(cell.dataset.printRate)] / 100);
    }
  }

  picker.addEventListener('change', renderPaper);
  window.printbeePricing.subscribe(({terms}) => {
    catalog = terms;
    const papers = Object.keys(terms.paperRates);
    if (papers.join() !== [...picker.options].map(option => option.value).join()) {
      const selected = picker.value;
      picker.replaceChildren(...papers.map(size => new Option(size, size)));
      picker.value = papers.includes(selected) ? selected : 'A4';
    }
    picker.closest('label').hidden = papers.length <= 1;
    renderPaper();
    for (const value of printCatalog.querySelectorAll('[data-binding-rate]')) {
      const amount = terms.bindingRates[value.dataset.bindingRate];
      value.parentElement.hidden = amount === undefined;
      if (amount !== undefined) value.textContent = '+' + currency.format(amount / 100);
    }
    status.textContent = '';
    status.hidden = true;
  }).then(config => {
    if (!config) status.textContent = 'Current prices are temporarily unavailable.';
  });
}
