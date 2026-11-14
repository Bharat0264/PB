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

const profileForm = document.querySelector('#profile-form');
if (profileForm) {
  fillProfile(profileForm);
  profileForm.addEventListener('submit', event => {
    event.preventDefault();
    const status = document.querySelector('#profile-status');
    const customer = profileForm.elements.customer.value.trim();
    const phone = profileForm.elements.phone.value.trim();
    if (!customer || !/^[+0-9 ()-]{7,20}$/.test(phone) || phone.replace(/\D/g, '').length < 7) {
      status.textContent = 'Check the details and try again.';
      return;
    }
    try {
      localStorage.setItem(profileKey, JSON.stringify({...readProfile(), customer, phone}));
      status.textContent = 'Profile saved on this browser.';
    } catch {
      status.textContent = 'Your browser could not save the profile.';
    }
  });
}

const addressForm = document.querySelector('#address-form');
if (addressForm) {
  const saved = readProfile();
  const fields = ['building', 'locality', 'city', 'region', 'pin', 'landmark'];
  const locationStatus = document.querySelector('#location-status');
  const useLocation = document.querySelector('#use-location');
  const clearLocation = document.querySelector('#clear-location');
  let locationPin = saved.delivery?.locationPin || '';
  for (const name of fields) {
    addressForm.elements[name].value = saved.delivery?.[name] || '';
  }
  if (!saved.delivery && saved.address) {
    addressForm.elements.building.value = saved.address;
  }

  function showLocation() {
    clearLocation.hidden = !locationPin;
    locationStatus.textContent = locationPin
      ? 'Delivery pin: ' + locationPin
      : 'Optional. Add a location pin for delivery.';
  }

  showLocation();
  useLocation.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Location is unavailable here. Enter your address manually.';
      return;
    }
    useLocation.disabled = true;
    locationStatus.textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(({coords}) => {
      locationPin = coords.latitude.toFixed(5) + ', ' + coords.longitude.toFixed(5);
      useLocation.disabled = false;
      showLocation();
    }, error => {
      useLocation.disabled = false;
      locationStatus.textContent = error.code === 1
        ? 'Location permission was denied. You can still save your address.'
        : 'Could not get your location. Try again or save your address without a pin.';
    }, {enableHighAccuracy: true, timeout: 10000, maximumAge: 0});
  });

  clearLocation.addEventListener('click', () => {
    locationPin = '';
    showLocation();
  });

  addressForm.addEventListener('submit', event => {
    event.preventDefault();
    const status = document.querySelector('#profile-status');
    const delivery = Object.fromEntries(fields.map(name => [name, addressForm.elements[name].value.trim()]));
    const {building, locality, city, region, pin, landmark} = delivery;
    const address = [
      building, locality, city, region + ' ' + pin,
      landmark && 'Landmark: ' + landmark,
      locationPin && 'Delivery pin: ' + locationPin,
    ].filter(Boolean).join(', ');
    if (!building || !locality || !city || !region || !/^[1-9][0-9]{5}$/.test(pin)) {
      status.textContent = 'Fill in all required address fields.';
      return;
    }
    if (address.length > 500) {
      status.textContent = 'Shorten the address to 500 characters or fewer.';
      return;
    }
    try {
      localStorage.setItem(profileKey, JSON.stringify({...readProfile(), address, delivery: {...delivery, locationPin}}));
      status.textContent = 'Address saved for checkout on this browser.';
    } catch {
      status.textContent = 'Your browser could not save the address.';
    }
  });
}
