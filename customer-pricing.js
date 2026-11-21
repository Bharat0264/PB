/* All customer price displays read the published checkout catalog.
 *
 * One fetch per page load, kept in sessionStorage for a minute so moving between pages does not refetch.
 * After that the prices refresh only while the tab is visible, at most once a minute, or when the tab
 * regains focus. Placing an order still calls refresh() directly, so the bill is always checked fresh.
 */
window.printbeePricing = (() => {
  const CACHE_KEY = 'printbee-checkout-config';
  const MAX_AGE = 60 * 1000;                 // a cached copy is good for a minute
  const FOCUS_GAP = 15 * 1000;               // regaining focus refreshes if the copy is older than this
  const listeners = new Set();
  let current, fingerprint, request, fetchedAt = 0;

  try {
    const saved = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if (saved && saved.config && Date.now() - saved.at < MAX_AGE) {
      current = saved.config;
      fingerprint = JSON.stringify(current);
      fetchedAt = saved.at;
    }
  } catch { /* no storage: just fetch */ }

  function refresh() {
    if (request) return request;
    request = fetch('/api/checkout', {cache:'no-store'}).then(async response => {
      if (!response.ok) return current;
      const config = await response.json();
      const next = JSON.stringify(config);
      current = config;
      fetchedAt = Date.now();
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({at: fetchedAt, config})); } catch { /* storage is optional */ }
      if (next !== fingerprint) {
        fingerprint = next;
        for (const listener of listeners) listener(current);
      }
      return current;
    }).catch(() => current).finally(() => { request = null; });
    return request;
  }

  const refreshIfOlderThan = age => { if (!document.hidden && Date.now() - fetchedAt >= age) refresh(); };

  return {
    refresh,
    subscribe(listener) {
      if (!listeners.size) {
        setInterval(() => refreshIfOlderThan(MAX_AGE - 5000), MAX_AGE);
        document.addEventListener('visibilitychange', () => refreshIfOlderThan(FOCUS_GAP));
        window.addEventListener('focus', () => refreshIfOlderThan(FOCUS_GAP));
        window.addEventListener('online', () => refreshIfOlderThan(0));
      }
      listeners.add(listener);
      if (current) listener(current);
      return Date.now() - fetchedAt < MAX_AGE && current ? Promise.resolve(current) : refresh();
    },
  };
})();
