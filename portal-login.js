async function connectPortal(portal, status, onReady, onSignOut = () => {}) {
  const login = document.querySelector('#portal-login');
  const logout = document.querySelector('#portal-logout');
  const hash = location.hash;
  const messages = {
    '#google-unavailable': 'Google sign-in has not been configured on this server.',
    '#google-failed': 'Google sign-in could not be completed. Try again.',
    '#google-denied': 'This Google account does not have access to this portal.',
  };
  if (messages[hash]) {
    status.textContent = messages[hash];
    history.replaceState(null, '', location.pathname + location.search);
  }
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      const response = await fetch('/api/auth/portal/logout', {method: 'POST'});
      if (!response.ok) throw new Error();
      onSignOut();
      location.reload();
    } catch {
      logout.disabled = false;
      status.textContent = 'Could not sign out. Try again.';
    }
  });
  try {
    const response = await fetch('/api/auth/portal?portal=' + portal);
    if (!response.ok) throw new Error('Could not check the portal session.');
    const {signedIn} = await response.json();
    if (signedIn) {
      login.hidden = true;
      logout.hidden = false;
      try { await onReady(); } finally { window.PBLoader?.done(); }
    } else {
      // One sign-in page for everyone: the welcome page sends staff on to their portal after Google sign-in.
      location.replace('/' + (messages[hash] ? hash : ''));
    }
  } catch {
    // Could not check the session: the one sign-in page is the safe place to land.
    location.replace('/');
  }
}
