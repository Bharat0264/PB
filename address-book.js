/* The browser address book keeps the same address string used by checkout. */
(() => {
  const byId = id => document.getElementById(id);
  const form = byId('address-form');
  const fields = form.elements;
  const composer = byId('address-composer');
  const narrow = matchMedia('(max-width: 600px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const addressFields = ['building','locality','city','region','pin','landmark'];
  const postalFields = ['locality','city','region','pin'];
  const handover = {room:'At my room door',entrance:'Block entrance',gate:'Main gate'};
  const profile = readProfile();
  let entries = (profile.addresses || (profile.address ? [{address: profile.address, delivery: profile.delivery}] : []))
    .map(entry => ({...entry,type:entry.type === 'campus' ? 'campus' : 'standard'}));
  let defaultIndex = entries[profile.defaultAddressIndex] ? profile.defaultAddressIndex : 0;
  let selected = defaultIndex;                 // the starred address is the one used (and highlighted) everywhere
  let editing = -1, showAll = false, pin = '', campuses = [], postalEdit, manualBuilding, suggestion, dismissed, request = 0;
  let previewAnimated;
  let focusSource;
  let standardPostal, campusPostal;
  let serviceArea;
  const value = key => fields[key].value.trim();
  const campusMode = () => value('type') === 'campus';
  const campus = () => campuses.find(item => item.id === value('campusId'));
  const status = byId('profile-status');
  const errors = byId('address-errors');
  const locationStatus = byId('location-status');

  function element(tag, text, cls) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function action(text, run, label) {
    const button = element('button',text,'address-action');
    button.type = 'button';
    if (label) button.setAttribute('aria-label', label);
    button.addEventListener('click',run);
    return button;
  }
  function persist(next, preferred, current) {
    const entry = next[current];
    const known = readProfile();
    localStorage.setItem(profileKey, JSON.stringify({...known,addresses:next,
      customer:entry?.customer || known.customer || '',phone:entry?.phone || known.phone || '',    // checkout fills the name and phone of the chosen address
      defaultAddressIndex:preferred,selectedAddressIndex:current,address:entry?.address || '',
      delivery:entry?.delivery || null,deliveryType:entry?.type || 'standard',campus:entry?.campus || null}));
    entries = next;
    defaultIndex = preferred;
    selected = current;
  }
  function updateSelection(next, preferred, current, message, focus) {
    try {
      persist(next, preferred, current);
      renderAddresses();
      (focus?.() || byId('add-address')).focus({preventScroll:true});
      status.textContent = message;
    } catch {
      status.textContent = 'Your browser could not update this address.';
    }
  }
  function renderAddresses(animated = -1) {
    const list = byId('saved-addresses');
    list.replaceChildren();
    if (!entries.length) {
      const symbol = element('span',null,'address-empty-icon customer-tab-icon');
      symbol.setAttribute('aria-hidden','true');
      const pin = document.createElementNS('http://www.w3.org/2000/svg','svg');
      for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round'})) pin.setAttribute(key,value);
      const outline = document.createElementNS(pin.namespaceURI,'path');
      outline.setAttribute('d','M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z');
      const center = document.createElementNS(pin.namespaceURI,'circle');
      center.setAttribute('cx','12'); center.setAttribute('cy','10'); center.setAttribute('r','2.5');
      pin.append(outline,center);
      symbol.append(pin);
      const empty = element('div',null,'address-empty');
      empty.append(symbol,element('h3','No saved addresses yet'));
      list.append(empty);
    }
    entries.slice(0,showAll?entries.length:5).forEach((entry,index) => {
      const card = element('article',null,'address-card');
      card.id = 'saved-address-'+index;
      card.dataset.selected = String(index === selected);
      if (index === animated) card.classList.add('address-card-enter');
      const meta = element('div',null,'address-card-meta');
      const label = entry.label || (entry.type === 'campus' ? 'Campus address' : 'Delivery address');
      meta.append(element('strong',label),element('span',entry.type === 'campus' ? 'Campus' : 'Outside','address-badge'));
      if (index === defaultIndex) meta.append(element('span','Default','address-badge address-badge-default'));
      const star = action(index === defaultIndex ? '★' : '☆', () => {
        updateSelection(entries,index,index,'Default address set. It will be used for delivery.',() => byId(card.id)?.querySelector('.address-star'));
      },'Set as default, '+label);
      star.classList.add('address-star');
      star.setAttribute('aria-pressed',String(index === defaultIndex));
      star.title = index === defaultIndex ? 'Default address' : 'Set as default';
      const details = element('p',entry.address.split('\n')[0]);
      const content = element('div',null,'address-card-content');
      content.append(meta);
      const who = [entry.customer,entry.phone].filter(Boolean).join(' · ');
      if (who) content.append(element('p',who,'address-contact-line'));
      content.append(details);
      const controls = element('div',null,'address-card-actions');
      const pencil = action('',event => edit(index,event.currentTarget),'Edit address, '+label);
      pencil.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
      const trash = action('',() => {
          const remaining = entries.filter((_,i) => i !== index);
          const map = i => i === index ? 0 : i > index ? i-1 : i;
          const preferred = map(defaultIndex);
          const current = selected === index ? preferred : map(selected);
          updateSelection(remaining,preferred,current,'Address deleted.');
          if (composer.open && editing === index) setOpen(false);
          else if (editing > index) editing--;
        },'Delete address, '+label);
      trash.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
      trash.classList.add('address-trash');
      pencil.classList.add('address-edit');
      const utilities = element('div',null,'address-card-tools');
      utilities.append(star,pencil,trash);
      controls.append(utilities);
      const ticketIcon = element('span',null,'address-ticket-icon');
      ticketIcon.setAttribute('aria-hidden','true');
      ticketIcon.innerHTML = entry.type === 'campus'
        ? '<svg viewBox="0 0 24 24"><path d="M3 10 12 4l9 6M5 10v9h14v-9M9 19v-5h6v5"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
      card.append(ticketIcon,content,controls);
      list.append(card);
    });
    const more = byId('show-addresses');
    more.hidden = entries.length <= 5;
    more.textContent = showAll ? 'Show less' : 'Show all';
    more.setAttribute('aria-expanded',String(showAll));
  }
  function syncComposer() {
    byId('add-address').setAttribute('aria-expanded',String(composer.open));
  }
  function setOpen(open, focus) {
    if (open && !composer.open) {
      if (narrow.matches) composer.showModal();
      else composer.setAttribute('open','');
    } else if (!open && composer.open) {
      if (composer.matches(':modal')) composer.close();
      else composer.removeAttribute('open');
    }
    syncComposer();
    if (open && focus) (value('customer') ? (campusMode()?fields.campusId:fields.building) : fields.customer).focus();
  }
  function fillCampus(clear = false) {
    const selectedCampus = campus();
    byId('campus-blocks').replaceChildren(...(selectedCampus?.blocks || []).map(block => new Option(block,block)));
    if (!clear) return;
    for (const key of postalFields) fields[key].value = selectedCampus?.[key] || '';
    postalEdit = !selectedCampus;
  }
  function readPostal() {
    return Object.fromEntries(postalFields.map(key => [key,value(key)]));
  }
  function writePostal(postal) {
    for (const key of postalFields) fields[key].value = postal?.[key] || '';
  }
  function updateBuilding() {
    if (!campusMode() || manualBuilding) return;
    const suggested = [value('block'),value('room') && 'Room '+value('room')].filter(Boolean).join(', ');
    if (suggested) fields.building.value = suggested;
  }
  function updatePreview() {
    byId('preview-type').textContent = campusMode() ? 'Campus' : 'Outside';
    const who = [value('customer'),value('phone')].filter(Boolean).join(' · ');
    byId('preview-who').textContent = who || 'Your name · phone';
    byId('preview-who').classList.toggle('is-empty',!who);
    byId('preview-line').textContent = value('building') || 'Your delivery address';
    const postal = postalFields.map(value).filter(Boolean).join(', ');
    byId('preview-postal').textContent = postal || 'Street, city, state and PIN';
    byId('campus-postal').textContent = postal;
  }
  function updateMode(animate = false) {
    const isCampus = campusMode();
    byId('campus-fields').hidden = !isCampus;
    byId('campus-summary').hidden = !isCampus || postalEdit;
    byId('address-postal').hidden = isCampus && !postalEdit;
    if (animate && !reduced.matches) form.animate([{opacity:.72},{opacity:1}],{duration:200,easing:'ease-out'});
    updatePreview();
    showPin();
  }
  function edit(index, trigger) {
    request++;
    byId('use-location').disabled = false;
    focusSource = trigger;
    editing = index;
    const entry = entries[index];
    form.reset();
    fields.type.value = entry?.type || 'standard';
    fields.customer.value = entry?.customer || readProfile().customer || '';      // a new address starts with the name and phone used before
    fields.phone.value = entry?.phone || readProfile().phone || '';
    for (const key of addressFields) fields[key].value = entry?.delivery?.[key] || '';
    if (entry && !entry.delivery) fields.building.value = entry.address;
    fields.campusId.value = campuses.some(item => item.id === entry?.campus?.campusId) ? entry.campus.campusId : campuses[0]?.id || '';
    for (const key of ['block','floor','room']) fields[key].value = entry?.campus?.[key] || '';
    fields.handoverPoint.value = entry?.campus?.handoverPoint || 'room';
    fields.label.value = entry?.label || '';
    fields.makeDefault.checked = !entries.length || (index >= 0 && index === defaultIndex);
    pin = entry?.delivery?.locationPin || '';
    manualBuilding = Boolean(entry?.delivery?.building);
    dismissed = false;
    postalEdit = !campus() || Boolean(entry?.campus && postalFields.some(key => !entry.delivery?.[key]));
    standardPostal = undefined;
    campusPostal = undefined;
    errors.textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach(input => setError(input,''));
    fillCampus(false);
    updateMode();
    setOpen(true, Boolean(trigger));
  }

  function switchMode() {
    const before = form.getBoundingClientRect().height;
    if (campusMode()) {
      standardPostal = readPostal();
      fillCampus(!campusPostal);
      if (campusPostal) {
        writePostal(campusPostal.fields);
        postalEdit = campusPostal.editing;
      }
      updateBuilding();
    } else {
      campusPostal = {fields:readPostal(), editing:postalEdit};
      writePostal(standardPostal);
    }
    form.querySelectorAll('[aria-invalid]').forEach(input => setError(input,''));
    errors.textContent = '';
    updateMode(true);
    const target = byId('campus-fields');
    const after = form.getBoundingClientRect().height;
    if (!reduced.matches && after !== before) {
      form.animate([{height:before+'px',overflow:'clip'},{height:after+'px',overflow:'clip'}],{duration:200,easing:'ease-out'});
    }
    if (!reduced.matches && campusMode() && after !== before) {
      target.animate([{opacity:0,transform:'translateY(-5px)'},{opacity:1,transform:'none'}],{duration:200,easing:'ease-out'});
    }
  }
  function distance(lat,lng,place) {
    const rad = Math.PI / 180;
    const dlat = (lat-place.latitude)*rad, dlng = (lng-place.longitude)*rad;
    const a = Math.sin(dlat/2)**2 + Math.cos(lat*rad)*Math.cos(place.latitude*rad)*Math.sin(dlng/2)**2;
    return 12742000*Math.asin(Math.sqrt(Math.min(1,a)));
  }
  function showPin() {
    if (fields.locationPin !== document.activeElement) fields.locationPin.value = pin;
    const issue = pinError(pin);
    byId('clear-location').hidden = !pin;
    byId('pin-preview').hidden = !pin || Boolean(issue);
    locationStatus.textContent = issue || (serviceArea ? 'Within our 5 km delivery area ✓' : 'Delivery pin: '+pin);
    const [lat,lng] = pin.split(',').map(Number);
    suggestion = pin && campuses.find(place => place.radiusMeters && distance(lat,lng,place)<=place.radiusMeters);
    byId('campus-suggestion').hidden = !suggestion || dismissed || campusMode();
  }
  function pinError(text) {
    if (!text) return 'Add your delivery pin. Use current location or paste latitude, longitude from Google Maps.';
    if (!/^-?\d{1,3}(?:\.\d+)?,\s*-?\d{1,3}(?:\.\d+)?$/.test(text)) return 'Enter coordinates as latitude, longitude.';
    const [lat,lng] = text.split(',').map(Number);
    if (Math.abs(lat)>90 || Math.abs(lng)>180) return 'Enter a valid latitude and longitude.';
    if (serviceArea && distance(lat,lng,serviceArea) > serviceArea.radiusMeters + 1e-6) return 'Outside our delivery area. Choose a delivery point within 5 km of our service location.';
    return '';
  }
  function setError(input, message) {
    const id = input.id+'-error';
    let error = byId(id);
    if (!message) {
      input.removeAttribute('aria-invalid');
      if (input.name === 'locationPin') input.setAttribute('aria-describedby','location-status');
      else input.removeAttribute('aria-describedby');
      error?.remove();
      return;
    }
    if (!error) {
      error = element('small',null,'address-error'); error.id = id; error.setAttribute('aria-live','polite');
      input.after(error);
    }
    error.textContent = message;
    input.setAttribute('aria-invalid','true');
    input.setAttribute('aria-describedby',input.name === 'locationPin' ? 'location-status '+id : id);
  }
  function validate(input) {
    const text = input.value.trim();
    const error = input.name === 'locationPin' ? pinError(text) : input.required && !text ? 'This field is required.' :
      input.name === 'pin' && !/^[1-9][0-9]{5}$/.test(text) ? 'Enter a valid 6-digit PIN code.' :
      input.name === 'phone' && (!/^[+0-9 ()-]{7,20}$/.test(text) || text.replace(/\D/g,'').length < 7) ? 'Enter a valid phone number.' : '';
    setError(input,error);
    return !error;
  }

  byId('add-address').onclick = event => edit(-1,event.currentTarget);
  byId('close-address').onclick = () => { setOpen(false); (focusSource || byId('add-address')).focus({preventScroll:true}); };
  composer.addEventListener('cancel',event => {event.preventDefault();byId('close-address').click();});
  narrow.addEventListener('change',() => {
    if (!composer.open) return;
    setOpen(false);
    setOpen(true);
  });
  byId('show-addresses').onclick = () => {showAll=!showAll;renderAddresses();};
  byId('edit-postal').onclick = () => {postalEdit=true;updateMode();fields.locality.focus();};
  form.addEventListener('focusout',event => {
    if (event.target.required && event.target.getClientRects().length) validate(event.target);
  });
  form.addEventListener('input',event => {
    if (event.target.name === 'locationPin') {pin=value('locationPin');dismissed=false;showPin();}
    if (event.target.name === 'building') manualBuilding = Boolean(value('building'));
    if (['block','room'].includes(event.target.name)) updateBuilding();
    if (event.target.hasAttribute('aria-invalid')) validate(event.target);
    updatePreview();
    const preview = byId('address-label-preview');
    if (!previewAnimated && event.target.matches('input[type="text"],input:not([type])')) {
      previewAnimated = true;
      if (!reduced.matches) preview.animate([{opacity:.6,transform:'translateY(-5px)'},{opacity:1,transform:'none'}],{duration:200});
    }
  });
  form.addEventListener('change',event => {
    if (event.target.name === 'type') switchMode();
    if (event.target.name === 'campusId') {fillCampus(true);updateMode(true);}
  });
  byId('use-location').onclick = () => {
    if (!navigator.geolocation) {locationStatus.textContent = 'Location is unavailable here. Paste delivery coordinates from Google Maps.';return;}
    const id = ++request;
    byId('use-location').disabled = true;
    locationStatus.textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(({coords}) => {
      if (request !== id) return;
      pin = coords.latitude.toFixed(5)+', '+coords.longitude.toFixed(5);
      dismissed = false;
      byId('use-location').disabled = false;
      showPin();
    }, error => {
      if (request !== id) return;
      byId('use-location').disabled = false;
      locationStatus.textContent = error.code === 1 ? 'Location permission was denied. Paste delivery coordinates from Google Maps.' :
        'Could not get your location. Try again or paste delivery coordinates from Google Maps.';
    },{enableHighAccuracy:true,timeout:10000,maximumAge:0});
  };
  byId('clear-location').onclick = () => {pin='';showPin();byId('use-location').focus();};
  byId('dismiss-campus').onclick = () => {dismissed=true;showPin();byId('use-location').focus();};
  byId('accept-campus').onclick = () => {
    fields.campusId.value = suggestion.id;
    fields.type.value = 'campus';
    switchMode();
    fields.block.focus();
  };
  form.addEventListener('submit',event => {
    event.preventDefault();
    const required = ['customer','phone','building',...postalFields,'locationPin',...(campusMode()?['campusId','block','room']:[])];
    const invalid = required.map(name => fields[name]).filter(input=>!validate(input));
    if (invalid.length) {
      if (postalFields.includes(invalid[0].name)) {postalEdit=true;updateMode();}
      errors.textContent = 'Check the highlighted address fields.';
      invalid[0].focus();
      return;
    }
    const delivery = Object.fromEntries(addressFields.map(name => [name,value(name)]));
    const type = value('type');
    const campusDetails = campusMode() ? Object.fromEntries(['campusId','block','floor','room','handoverPoint'].map(key => [key,value(key)])) : null;
    const lines = [delivery.building,
      campusDetails && [campus()?.name,campusDetails.floor && 'Floor '+campusDetails.floor,handover[campusDetails.handoverPoint]].filter(Boolean).join(', '),
      delivery.locality,delivery.city,delivery.region+' '+delivery.pin,delivery.landmark && 'Landmark: '+delivery.landmark];
    const address = lines.filter(Boolean).join(', ')+(pin?'\nDelivery pin: '+pin:'');
    if (address.length > 500) {errors.textContent = 'Shorten the address to 500 characters or fewer.';return;}
    const index = editing < 0 ? entries.length : editing;
    const next = [...entries];
    next[index] = {address,type,customer:value('customer'),phone:value('phone'),label:value('label'),delivery:{...delivery,locationPin:pin},...(campusDetails?{campus:campusDetails}:{})};
    const save = form.querySelector('[type="submit"]');
    save.disabled = true;
    try {
      const preferred = fields.makeDefault.checked || next.length===1 ? index : defaultIndex;
      persist(next,preferred,preferred);          // saving another address never moves the highlight off the starred one
      if (index>=5) showAll=true;
      setOpen(false);
      renderAddresses(index);
      byId('saved-address-'+index)?.querySelector('.address-edit')?.focus({preventScroll:true});
      status.textContent = '✓ Address saved on this browser.';
    } catch {
      errors.textContent = 'Your browser could not save the address.';
    } finally {
      save.disabled = false;
    }
  });
  const previewQuery = matchMedia('(max-width: 740px)');
  const preview = byId('address-label-preview');
  function fitPreview() {preview.open = !previewQuery.matches;}
  previewQuery.addEventListener('change',fitPreview);
  fitPreview();
  if (entries.length && (!profile.addresses || profile.addresses.some(entry => !entry.type))) {
    try { persist(entries,defaultIndex,selected); } catch { /* Read-only storage still shows saved addresses. */ }
  }
  renderAddresses();
  window.printbeePricing.refresh().then(config => {
    serviceArea = config?.terms?.serviceArea;
    showPin();
    campuses = config?.terms?.campuses || [];
    const select = fields.campusId;
    select.replaceChildren(...campuses.map(item=>new Option(item.name,item.id)));
    if (entries[editing]?.campus) select.value = entries[editing].campus.campusId;
    if (!select.value && campuses.length) select.value = campuses[0].id;
    fillCampus(campusMode() && !entries[editing]);
    updateMode();
  });
})();
