import {previewPricingKey, readPreviewPricing} from './pricing-preview.js';

const printCatalog = document.querySelector('[data-print-catalog]');
if (printCatalog) {
  const status = printCatalog.querySelector('[data-price-status]');
  const currency = new Intl.NumberFormat('en-IN', {style:'currency',currency:'INR',minimumFractionDigits:0,maximumFractionDigits:2});
  function renderCatalog(terms) {
    for (const panel of printCatalog.querySelectorAll('[data-paper]')) panel.hidden = !terms.paperRates[panel.dataset.paper];
    for (const cell of printCatalog.querySelectorAll('[data-print-rate]')) {
      const rates = terms.paperRates[cell.closest('[data-paper]')?.dataset.paper || 'A4'] || [];
      const amount = rates[Number(cell.dataset.printRate)];
      cell.textContent = typeof amount === 'number' ? currency.format(amount / 100) : '—';
    }
    for (const value of printCatalog.querySelectorAll('[data-binding-rate]')) {
      const amount = terms.bindingRates[value.dataset.bindingRate];
      value.parentElement.hidden = amount === undefined;
      if (amount !== undefined) value.textContent = '+' + currency.format(amount / 100);
    }
  }

  if (new URLSearchParams(location.search).get('pricing-preview') === '1') {
    status.textContent = 'Preview prices for this browser. Live checkout uses published rates.';
    const fees = document.createElement('section');
    fees.className = 'price-panel price-binding';
    const heading = document.createElement('h3');
    heading.textContent = 'Preview checkout fees';
    const list = document.createElement('dl');
    fees.append(heading, list);
    printCatalog.querySelector('.price-grid').after(fees);
    function renderPreview() {
      const terms = readPreviewPricing();
      renderCatalog(terms);
      list.replaceChildren();
      for (const [key,label] of Object.entries({platform:'Platform fee',packing:'Packing fee',
        surge:'Surge fee',delivery:'Base delivery fee',deliveryPerKm:'Delivery rate'})) {
        const row = document.createElement('div');
        const name = document.createElement('dt');
        const amount = document.createElement('dd');
        name.textContent = label;
        amount.textContent = currency.format((terms[key] || 0) / 100) + (key === 'deliveryPerKm' ? ' / km' : '');
        row.append(name, amount);
        list.append(row);
      }
    }
    renderPreview();
    window.addEventListener('storage', event => {
      if (event.key === previewPricingKey || event.key === null) renderPreview();
    });
  } else {
    window.printbeePricing.subscribe(({terms}) => {
      renderCatalog(terms);
      status.hidden = true;
    }).then(config => {
      if (!config) status.textContent = 'Current prices are temporarily unavailable.';
    });
  }
}
