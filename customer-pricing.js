/* All customer price displays read the published checkout catalog. */
window.printbeePricing = (() => {
  const listeners = new Set();
  let current, fingerprint, request;

  function refresh() {
    if (request) return request;
    request = fetch('/api/checkout', {cache:'no-store'}).then(async response => {
      if (!response.ok) return current;
      const config = await response.json();
      const next = JSON.stringify(config);
      current = config;
      if (next !== fingerprint) {
        fingerprint = next;
        for (const listener of listeners) listener(current);
      }
      return current;
    }).catch(() => current).finally(() => { request = null; });
    return request;
  }

  function refreshVisible() {
    if (!document.hidden) refresh();
  }

  return {
    refresh,
    subscribe(listener) {
      if (!listeners.size) {
        setInterval(refreshVisible, 5000);
        document.addEventListener('visibilitychange', refreshVisible);
        window.addEventListener('focus', refreshVisible);
        window.addEventListener('online', refreshVisible);
      }
      listeners.add(listener);
      if (current) listener(current);
      return refresh();
    },
  };
})();
