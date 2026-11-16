// Fills the signed-in account card on the profile page from the "Signed in as ..." line the sign-in script writes.
const line = document.querySelector('#account-email');
const page = document.querySelector('.profile-page');

function update() {
  const match = /^Signed in as (.+)$/.exec(line.textContent.trim());
  const email = match ? match[1] : '';
  page.classList.toggle('is-signed-in', Boolean(email));
  document.querySelector('#account-home').hidden = !email;
  if (!email) return;
  const word = email.split('@')[0].replace(/[^A-Za-z]+/g, ' ').trim().split(' ')[0] || 'there';
  const name = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  document.querySelector('#account-name').textContent = name;
  document.querySelector('#account-mail').textContent = email;
  document.querySelector('#account-avatar').textContent = name.charAt(0).toUpperCase();
}

if (line && page) {
  new MutationObserver(update).observe(line, {childList: true, characterData: true, subtree: true});
  update();
}
