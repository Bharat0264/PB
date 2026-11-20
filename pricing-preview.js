export const previewPricingKey = 'printbee-customer-pricing-preview-v1';
export const previewPricingUrl = '/pricing.html?pricing-preview=1';

export function readPreviewPricing() {
  try {
    const saved = JSON.parse(localStorage.getItem(previewPricingKey));
    if (saved?.paperRates?.A4 && saved?.bindingRates) return saved;
  } catch {
    // Use the sample rates if storage is unavailable.
  }
  return {
    paperRates:{A4:[175,300,850,1400],'A4 Bond':[300,550,1200,2000]},
    bindingRates:{glossy:5000,blue:4000},
    platform:0, packing:0, surge:0, delivery:0, deliveryPerKm:0,
  };
}

export function savePreviewPricing(terms) {
  try {
    localStorage.setItem(previewPricingKey, JSON.stringify(terms));
  } catch {
    throw new Error('This browser blocked preview storage. Allow site storage and try again.');
  }
}
