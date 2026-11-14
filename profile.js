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

const addressForm = document.querySelector('#address-form');
if (addressForm) {
  const saved = readProfile();
  const addresses = saved.addresses || (saved.address ? [
    {address: saved.address, delivery: saved.delivery}
  ] : []);
  let defaultIndex = saved.defaultAddressIndex ?? 0;
  let editing = addresses.length ? defaultIndex : -1;
  const fields = ['building', 'locality', 'city', 'region', 'pin', 'landmark'];
  const locationStatus = document.querySelector('#location-status');
  const useLocation = document.querySelector('#use-location');
  const clearLocation = document.querySelector('#clear-location');
  const list = document.querySelector('#saved-addresses');
  const status = document.querySelector('#profile-status');
  let locationPin = '';

  function editAddress(index) {
    editing = index;
    const entry = addresses[index];
    for (const name of fields) addressForm.elements[name].value = entry?.delivery?.[name] || '';
    if (entry && !entry.delivery) addressForm.elements.building.value = entry.address;
    locationPin = entry?.delivery?.locationPin || '';
    showLocation();
  }

  function persistAddresses(entries, index) {
    const selected = entries[index];
    localStorage.setItem(profileKey, JSON.stringify({...readProfile(),
      addresses: entries, defaultAddressIndex:index, address:selected.address, delivery:selected.delivery}));
  }

  function renderAddresses() {
    list.replaceChildren();
    addresses.forEach((entry, index) => {
      const card = document.createElement('article');
      card.className = 'raised table-card';
      const description = document.createElement('p');
      description.textContent = entry.address + (index === defaultIndex ? ' (Default)' : '');
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'pill raised';
      edit.textContent = 'Edit address';
      edit.onclick = () => { editAddress(index); addressForm.elements.building.focus(); };
      card.append(description, edit);
      if (index !== defaultIndex) {
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'pill raised';
        use.textContent = 'Set as default';
        use.onclick = () => {
          try {
            persistAddresses(addresses, index);
            defaultIndex = index;
            renderAddresses();
            document.querySelector('#add-address').focus();
            status.textContent = 'Default address updated.';
          } catch {
            status.textContent = 'Your browser could not save the default address.';
          }
        };
        card.append(use);
      }
      list.append(card);
    });
  }

  document.querySelector('#add-address').onclick = () => {
    editAddress(-1);
    addressForm.elements.building.focus();
  };

  function showLocation() {
    clearLocation.hidden = !locationPin;
    locationStatus.textContent = locationPin
      ? 'Delivery pin: ' + locationPin
      : 'Optional. Add a location pin for delivery.';
  }

  editAddress(editing);
  renderAddresses();
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
      const index = editing < 0 ? addresses.length : editing;
      const entries = [...addresses];
      entries[index] = {address, delivery: {...delivery, locationPin}};
      persistAddresses(entries, defaultIndex);
      addresses[index] = entries[index];
      editing = index;
      renderAddresses();
      status.textContent = 'Address saved on this browser.';
    } catch {
      status.textContent = 'Your browser could not save the address.';
    }
  });
}
