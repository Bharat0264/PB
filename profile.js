const profileKey = 'printbee-profile';
const profileFields = ['customer', 'phone', 'address'];

function readProfile() {
  try {
    return JSON.parse(localStorage.getItem(profileKey) || '{}') || {};
  } catch {
    return {};
  }
}

function fillProfile(form) {
  const profile = readProfile();
  for (const name of profileFields) {
    const field = form.elements[name];
    if (field) field.value = profile[name] || '';
  }
}
