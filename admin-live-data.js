/* Live admin data: the same shapes admin-data.js uses for the sample dashboard, filled from the
 * real database through GET /api/admin. admin-dashboard.js imports this on /admin and the sample
 * module on /admin-preview.html, so both screens render identically.
 *
 * The arrays are updated in place (load() replaces their contents), because the dashboard keeps
 * references to them.
 */
export const orders = [];
export const products = [];
export const activity = [];
export const partners = [];
export const warehouses = [];
export const payouts = [];
export const traffic = [];
export const targets = {revenue: 0, orders: 0, satisfaction: 0};
export const today = new Date();
today.setHours(23, 59, 59, 999);
export const info = {terms: null, paymentMode: 'disabled', pricingVersion: 0, finance: null, counts: {}, attention: []};

export async function api(path, data) {
  const post = data !== undefined;
  const response = await fetch(path, {
    method: post ? 'POST' : 'GET', cache: 'no-store',
    headers: {'Content-Type': 'application/json'}, body: post ? JSON.stringify(data) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

const humanise = key => String(key).replace(/[_.]/g, ' ').replace(/^./, c => c.toUpperCase());
const statusLabel = key => key === 'offline' ? 'Offline' : (window.PrintBeeStatus?.model ? PrintBeeStatus.label(key) : humanise(key));
const eventLabel = key => window.PrintBeeStatus?.model ? PrintBeeStatus.eventLabel(key) : humanise(key);

function ago(seconds) {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  if (minutes < 1440) return Math.round(minutes / 60) + ' h ago';
  return new Date(seconds * 1000).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'});
}

function toOrder(row) {
  const stamp = row.created || row.placed;
  const number = row.order_number || 'PB-' + String(row.id).slice(0, 8).toUpperCase();
  return {
    id: number, uid: row.id, statusKey: row.status, status: statusLabel(row.status),
    customer: row.customer || 'Customer', email: row.email || '', product: row.product || 'Print order',
    category: row.category || 'Printing', region: row.region || 'Delivery',
    total: (row.total || 0) / 100, tax: (row.tax || 0) / 100, payout: (row.payout || 0) / 100,
    date: stamp ? new Date(stamp * 1000) : new Date(), captured: Boolean(row.captured), partner: row.partner || null,
  };
}

// Rates the customers are charged, shown as the print services list (paper rates are paise per page).
function servicesFrom(terms) {
  const list = [];
  const kinds = ['Black & white', 'Black & white, double-sided', 'Colour', 'Colour, double-sided'];
  for (const [paper, rates] of Object.entries(terms.paperRates || {})) {
    rates.forEach((paise, index) => list.push({name: `${paper} ${kinds[index]}`, category: 'Document printing', price: paise / 100,
      removeKey: index === 0 && paper !== 'A4' ? 'paper:' + paper : null, removeLabel: paper + ' printing'}));
  }
  const bindings = {glossy: 'Glossy soft binding', blue: 'Blue sheet cover binding', spiral: 'Spiral binding', staple: 'Staple binding'};
  for (const [key, paise] of Object.entries(terms.bindingRates || {})) {
    if (key !== 'none') list.push({name: bindings[key] || humanise(key), category: 'Binding', price: paise / 100,
      removeKey: ['spiral', 'staple'].includes(key) ? 'binding:' + key : null, removeLabel: bindings[key] || humanise(key)});
  }
  return list;
}

export async function load() {
  await window.PrintBeeStatus?.ready;
  const data = await api('/api/admin');
  orders.splice(0, orders.length, ...data.orders.map(toOrder));
  products.splice(0, products.length, ...servicesFrom(data.terms));
  activity.splice(0, activity.length, ...data.audit.slice(0, 12).map(entry => [
    eventLabel(entry.action), entry.actor, ago(entry.created),
  ]));
  partners.splice(0, partners.length, ...data.partners);
  warehouses.splice(0, warehouses.length, ...data.warehouses);
  payouts.splice(0, payouts.length, ...data.payouts);
  Object.assign(info, {terms: data.terms, paymentMode: data.paymentMode, pricingVersion: data.pricingVersion,
    ordering: data.ordering,
    testDeliveries: data.testDeliveries || [],
    finance: data.finance, counts: data.counts, attention: data.attention || [], captured: data.captured, today: data.today});
  return data;
}
