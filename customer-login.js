const signIn = document.querySelector('#email-sign-in');
const googleSignIn = document.querySelector('#google-sign-in');
const signOut = document.querySelector('#email-sign-out');
const confirmSignIn = document.querySelector('#email-sign-in-confirm');
const accountEmail = document.querySelector('#account-email');
const loginStatus = document.querySelector('#email-login-status');

async function authRequest(action, data) {
  const options = data === undefined ? {} : {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data),
  };
  const response = await fetch('/api/auth/' + action, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Email sign-in is unavailable.');
  return result;
}

const onWelcome = document.body.classList.contains('welcome-page');
const signOutAll = document.querySelector('#email-sign-out-all');

function showAccount(email) {
  accountEmail.textContent = email ? 'Signed in as ' + email : '';
  signOut.hidden = !email;
  if (signOutAll) signOutAll.hidden = !email;
  signIn.hidden = Boolean(email);
  googleSignIn.hidden = Boolean(email);
}

// Route guard: someone who is already signed in never sees the sign-in card again.
// (The local demo keeps the page so you can switch roles.)
async function leaveWelcomeIfSignedIn(email) {
  if (!onWelcome || !email) return false;
  try {
    // Only a developer's own machine can be the demo; elsewhere skip the (404) check.
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && (await fetch('/api/dev/roles', {cache: 'no-store'})).ok) return false;
  } catch { /* not the demo */ }
  location.replace('/index.html');
  return true;
}

function readExpiredFlag() {
  if (!/(?:^|; )printbee_expired=1/.test(document.cookie)) return false;
  document.cookie = 'printbee_expired=; Path=/; Max-Age=0';
  return true;
}

async function submitLogin(form, action, update) {
  const button = form.querySelector('button');
  button.disabled = true;
  loginStatus.textContent = '';
  try {
    update(await action());
  } catch (error) {
    loginStatus.textContent = error.message;
    if (form === confirmSignIn) {
      signIn.hidden = false;
      googleSignIn.hidden = false;
    }
  } finally {
    button.disabled = false;
  }
}

signIn.addEventListener('submit', event => {
  event.preventDefault();
  submitLogin(signIn, () => authRequest('request', {email: signIn.elements.email.value}), () => {
    loginStatus.textContent = 'Check your inbox for a sign-in link. It expires in 15 minutes.';
  });
});

signOut.addEventListener('submit', event => {
  event.preventDefault();
  submitLogin(signOut, () => authRequest('logout', {}), () => {
    showAccount(null);
    window.PrintBeeSession?.announce('logout');
  });
});

signOutAll?.addEventListener('submit', event => {
  event.preventDefault();
  submitLogin(signOutAll, () => authRequest('logout-all', {}), () => {
    showAccount(null);
    loginStatus.textContent = 'You are signed out of every device.';
    window.PrintBeeSession?.announce('logout');
  });
});

const googleMessages = {
  '#google-unavailable': 'Google sign-in is unavailable. You can sign in by email.',
  '#google-failed': 'Google sign-in could not be completed. Please try again.',
  '#google-denied': 'This Google account does not have access to that portal. Ask the admin to add it.',
};
if (Object.hasOwn(googleMessages, location.hash)) {
  loginStatus.textContent = googleMessages[location.hash];
  history.replaceState(null, '', location.pathname + location.search);
}
const match = location.hash.match(/^#sign-in=([A-Za-z0-9_-]{43})$/);
if (match) {
  history.replaceState(null, '', location.pathname + location.search);
  signIn.hidden = true;
  googleSignIn.hidden = true;
  confirmSignIn.hidden = false;
  confirmSignIn.addEventListener('submit', event => {
    event.preventDefault();
    submitLogin(confirmSignIn, () => authRequest('verify', {token: match[1]}), () => {
      window.PrintBeeSession?.announce('login');
      if (window.parent !== window) window.parent.location.replace('/index.html');
      else location.replace('/index.html');
    });
  });
} else {
  authRequest('session').then(async ({email}) => {
    if (await leaveWelcomeIfSignedIn(email)) return;
    showAccount(email);
    if (!email) readExpiredFlag();
  }).catch(() => {
    if (!loginStatus.textContent) loginStatus.textContent = 'Could not check your sign-in status.';
  }).finally(() => document.body.classList.add('auth-ready'));
}
