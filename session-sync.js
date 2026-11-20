/* Keeps every open PrintBee tab in step with the customer's session.
 *
 *  - Sign out in one tab signs out all tabs; sign in on the welcome page moves the other welcome tabs on.
 *  - While a page is open and the customer is clicking, typing or scrolling, a quiet ping (at most once every
 *    5 minutes) tells the server they are still here. The server slides the 7-day window forward, so active
 *    customers are never signed out and 7 idle days always are.
 *  - If the server says the session ended (idle 7 days, or "Log out of all devices" elsewhere), the page goes
 *    to the welcome page, which explains what happened.
 *
 * Tokens live only in an httpOnly cookie. Nothing secret is ever readable by this script.
 */
(() => {
  'use strict';
  const onWelcome = document.body.classList.contains('welcome-page');
  const PING_EVERY = 5 * 60 * 1000;
  let channel = null;
  try { channel = new BroadcastChannel('printbee-auth'); } catch { /* old browsers: pings still work */ }

  const resetGuestTheme = () => {
    try {
      sessionStorage.removeItem('printbee-theme-guest');
      sessionStorage.removeItem('printbee-admin-theme-guest');
    } catch {}
    window.PrintBeeThemes?.resetGuest();
  };
  const goWelcome = () => { resetGuestTheme(); if (!onWelcome) location.replace('/welcome.html'); };

  channel?.addEventListener('message', ({data}) => {
    if (data === 'logout') goWelcome();
    if (data === 'login' && onWelcome) location.replace('/index.html');
  });

  window.PrintBeeSession = {
    announce(kind) { if (kind === 'logout') resetGuestTheme(); try { channel?.postMessage(kind); } catch { /* ignore */ } },
  };

  document.querySelector('.welcome-guest')?.addEventListener('click', resetGuestTheme);

  let last = Date.now();
  let busy = false;
  async function ping() {
    if (busy || onWelcome || document.hidden) return;
    busy = true;
    try {
      const response = await fetch('/api/auth/session', {cache: 'no-store'});
      const state = await response.json();
      if (!state.email && /(?:^|; )printbee_expired=1/.test(document.cookie)) goWelcome();
    } catch { /* offline: try again on the next activity */ } finally {
      busy = false;
      last = Date.now();
    }
  }
  const activity = () => { if (Date.now() - last > PING_EVERY) ping(); };
  for (const type of ['pointerdown', 'keydown', 'scroll', 'visibilitychange']) {
    addEventListener(type, activity, {passive: true});
  }
  addEventListener('online', ping);
})();
