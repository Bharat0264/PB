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

function showAccount(email) {
  accountEmail.textContent = email ? 'Signed in as ' + email : '';
  signOut.hidden = !email;
  signIn.hidden = Boolean(email);
  googleSignIn.hidden = Boolean(email);
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
  submitLogin(signOut, () => authRequest('logout', {}), () => showAccount(null));
});

const googleMessages = {
  '#google-unavailable': 'Google sign-in is unavailable. You can sign in by email.',
  '#google-failed': 'Google sign-in could not be completed. Please try again.',
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
    submitLogin(confirmSignIn, () => authRequest('verify', {token: match[1]}), ({email}) => {
      confirmSignIn.hidden = true;
      showAccount(email);
      loginStatus.textContent = 'You’re signed in. Return to Upload to place an order.';
    });
  });
} else {
  authRequest('session').then(({email}) => showAccount(email)).catch(() => {
    loginStatus.textContent = 'Could not check your sign-in status.';
  });
}
