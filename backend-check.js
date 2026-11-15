/* Welcome page: if the sign-in service (the /api backend) cannot be reached, say so plainly
 * instead of leaving dead sign-in buttons. Does nothing when the backend answers.
 */
(async () => {
  'use strict';
  const notice = document.getElementById('backend-notice');
  if (!notice) return;
  try {
    const response = await fetch('/api/status-model', {cache: 'no-store'});
    if (response.ok && (response.headers.get('content-type') || '').includes('json')) return;
  } catch { /* fall through to the notice */ }
  notice.textContent = 'Sign-in is temporarily unavailable: the PrintBee server is not connected. Please try again soon.';
  notice.hidden = false;
})();
