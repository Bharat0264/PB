/* Welcome page form: sign in / sign up toggle copy, friendly inline validation, a gentle shake on errors.
 * The actual sign-in (Google and the emailed link) is handled by customer-login.js. */
(() => {
  'use strict';
  const toggle = document.querySelector('.clay-toggle');
  const heading = document.querySelector('#signin-title');
  const lede = document.querySelector('#mode-lede');
  const submit = document.querySelector('#email-submit');
  const form = document.querySelector('#email-sign-in');
  const email = document.querySelector('#welcome-email');
  const hint = document.querySelector('#email-hint');
  const card = document.querySelector('.welcome-sign-in');
  if (!toggle || !form || !email) return;
  // Our own friendly messages replace the browser's default validation bubble.
  form.noValidate = true;

  const copy = {
    in: ['Welcome back', 'Pick up where you left off. No password to remember.', 'Email me a sign-in link'],
    up: ['Create your account', 'New here? Use Google or your email and you are in. We never ask for a password.', 'Email me a sign-up link'],
  };
  function setMode(mode) {
    toggle.dataset.mode = mode;
    [heading.textContent, lede.textContent, submit.textContent] = copy[mode];
  }
  toggle.addEventListener('change', event => setMode(event.target.value));

  const valid = value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
  function show(message, ok = false) {
    hint.textContent = message;
    hint.dataset.state = ok ? 'ok' : message ? 'error' : '';
    email.setAttribute('aria-invalid', String(Boolean(message) && !ok));
  }
  function shake() {
    card.classList.remove('is-shaking');
    void card.offsetWidth;
    card.classList.add('is-shaking');
  }

  email.addEventListener('input', () => {
    if (!email.value) return show('');
    if (valid(email.value)) show('Looks good.', true);
    else if (hint.dataset.state === 'error') show('Almost there. Try something like name@college.edu');
  });
  email.addEventListener('blur', () => {
    if (email.value && !valid(email.value)) show('That does not look like an email yet. Try name@college.edu');
  });
  // Runs before customer-login.js sends the request, so a bad address never reaches the server.
  form.addEventListener('submit', event => {
    if (!valid(email.value)) {
      event.stopImmediatePropagation();
      event.preventDefault();
      show(email.value ? 'Check the spelling. It should look like name@college.edu' : 'Add your email and we will send you a link.');
      shake();
      email.focus();
    }
  }, true);

  // Friendly failures from the server shake the card too.
  const status = document.querySelector('#email-login-status');
  if (status) new MutationObserver(() => {
    if (status.textContent && !/inbox/i.test(status.textContent)) shake();
  }).observe(status, {childList: true, characterData: true, subtree: true});
  addEventListener('printbee:link-sent', () => {
    card.classList.add('is-done');
    show('Link sent. Check your inbox.', true);
  });
})();
