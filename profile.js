const profileKey = 'printbee-profile';
const profileFields = ['customer', 'phone', 'address'];

function fillProfile(form) {
  try {
    const profile = JSON.parse(localStorage.getItem(profileKey) || '{}');
    for (const name of profileFields) {
      const field = form.elements[name];
      if (field) field.value = profile[name] || '';
    }
  } catch {
    // Checkout can still be filled manually when browser storage is unavailable.
  }
}

const profileForm = document.querySelector('#profile-form, #address-form');
if (profileForm) {
  fillProfile(profileForm);
  profileForm.addEventListener('submit', event => {
    event.preventDefault();
    const status = document.querySelector('#profile-status');
    const profile = Object.fromEntries(profileFields.filter(name => profileForm.elements[name]).map(name => [name, profileForm.elements[name].value.trim()]));
    if (Object.values(profile).some(value => !value) || (profile.phone && (!/^[+0-9 ()-]{7,20}$/.test(profile.phone) || profile.phone.replace(/\D/g, '').length < 7))) {
      status.textContent = 'Check the details and try again.';
      return;
    }
    try {
      localStorage.setItem(profileKey, JSON.stringify({...JSON.parse(localStorage.getItem(profileKey) || '{}'), ...profile}));
      status.textContent = profileForm.id === 'address-form' ? 'Address saved on this browser.' : 'Profile saved on this browser.';
    } catch {
      status.textContent = 'Your browser could not save the profile.';
    }
  });
}
