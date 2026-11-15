/* PrintBeeLive: one subscription to the server's order feed, for any portal.
 *
 *   PrintBeeLive.start({as: 'warehouse', onSync: refresh, onEvent: event => {...}, onState: state => {...}})
 *
 * - Server-Sent Events from /api/events?as=<role>. The browser reconnects by itself and sends
 *   Last-Event-ID, so events missed while offline are replayed.
 * - If SSE is unavailable (blocked, closed, 403) it falls back to polling /api/events?poll=1.
 * - `onSync` is called (debounced) after any event, after a reconnect and every 45 s as a safety
 *   net: portals re-read their own state from the API. The feed only says "something changed".
 * - `onState('live' | 'polling' | 'offline')` drives optional "Live" indicators.
 */
(() => {
  'use strict';
  const DEBOUNCE = 250, SAFETY = 45000, POLL = 5000;

  function start({as, onSync = () => {}, onEvent = () => {}, onState = () => {}} = {}) {
    let source, timer, pollTimer, safety, last = null, opened = false, stopped = false, state = '';
    const set = value => { if (value !== state) { state = value; onState(value); } };
    const sync = () => { clearTimeout(timer); timer = setTimeout(() => { if (!stopped) onSync(); }, DEBOUNCE); };
    const url = (extra = '') => '/api/events?as=' + encodeURIComponent(as) + extra;

    function poll() {
      clearTimeout(pollTimer);
      if (stopped) return;
      fetch(url('&poll=1' + (last != null ? '&since=' + last : '')), {cache: 'no-store'})
        .then(response => {
          if (response.status === 403) { set('offline'); stopped = true; return null; }
          return response.ok ? response.json() : Promise.reject(new Error('feed'));
        })
        .then(data => {
          if (!data) return;
          for (const event of data.events) onEvent(event);
          if (data.events.length) sync();
          last = data.latest;
          set('polling');
        })
        .catch(() => set('offline'))
        .finally(() => { if (!stopped) pollTimer = setTimeout(poll, POLL); });
    }

    function connect() {
      if (!window.EventSource) { poll(); return; }
      source = new EventSource(url());
      source.addEventListener('hello', event => {
        last = JSON.parse(event.data).latest;
        set('live');
        if (opened) sync();            // reconnected: re-read state in case anything slipped past
        opened = true;
      });
      source.onmessage = event => {
        const data = JSON.parse(event.data);
        last = data.id;
        onEvent(data);
        sync();
      };
      source.onerror = () => {
        set('offline');
        if (source.readyState === EventSource.CLOSED) {   // not signed in, or the server refused the stream
          source.close();
          poll();
        }
      };
    }

    connect();
    safety = setInterval(() => { if (!document.hidden && !stopped) onSync(); }, SAFETY);
    const visible = () => { if (!document.hidden && !stopped) sync(); };
    document.addEventListener('visibilitychange', visible);
    return {
      stop() {
        stopped = true;
        source?.close();
        clearTimeout(timer); clearTimeout(pollTimer); clearInterval(safety);
        document.removeEventListener('visibilitychange', visible);
      },
    };
  }

  window.PrintBeeLive = {start};
})();
