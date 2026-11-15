/* PrintBeeStatus: the shared status vocabulary for every portal.
 * Labels, tones and wording come from the server (GET /api/status-model), which reads the one
 * definition in order_status.py. Portals never invent their own status wording.
 *
 *   PrintBeeStatus.ready.then(model => ...)
 *   PrintBeeStatus.label('packed')        -> "Ready for pickup"
 *   PrintBeeStatus.badge('delivered')     -> <span class="pb-status" data-tone="success">Delivered</span>
 *   PrintBeeStatus.eventLabel('paid')     -> "Payment received"
 */
(() => {
  'use strict';
  let model = null;
  const humanise = key => String(key || '').replace(/[_.]/g, ' ').replace(/^./, c => c.toUpperCase());
  const api = {
    get model() { return model; },
    label: key => model?.statuses[key]?.label || humanise(key),
    tone: key => model?.statuses[key]?.tone || 'neutral',
    colour: key => model?.statuses[key]?.colour || '#7A6A4A',
    customer: key => model?.statuses[key]?.customer || '',
    stage: key => model?.statuses[key]?.stage || String(key || '').toUpperCase(),
    eventLabel: key => model?.events[key] || humanise(key),
    flow: () => model?.flow || ['pending', 'paid', 'printing', 'packed', 'out_for_delivery', 'delivered'],
    badge(key) {
      const element = document.createElement('span');
      element.className = 'pb-status';
      element.dataset.tone = api.tone(key);
      element.dataset.status = key;
      element.textContent = api.label(key);
      return element;
    },
  };
  api.ready = fetch('/api/status-model', {cache: 'no-store'})
    .then(response => response.json())
    .then(data => { model = data; return data; })
    .catch(() => null);
  window.PrintBeeStatus = api;
})();
