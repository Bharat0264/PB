/* Optional Google Places search and delivery pin picker. */
let mapsLibrary;

function loadDeliveryMaps(key) {
  if (!mapsLibrary) {
    mapsLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      window.printBeeMapsReady = () => {
        delete window.printBeeMapsReady;
        resolve(window.google.maps);
      };
      const query = new URLSearchParams({key, loading: 'async', callback: 'printBeeMapsReady'});
      script.src = 'https://maps.googleapis.com/maps/api/js?' + query;
      script.onerror = () => {
        delete window.printBeeMapsReady;
        script.remove();
        mapsLibrary = null;
        reject(new Error('Could not load the map.'));
      };
      document.head.append(script);
    });
  }
  return mapsLibrary;
}

function setupDeliveryMap(config, serviceArea) {
  if (!config) return;
  const address = document.querySelector('#checkout-form [name="address"]');
  const toggle = document.querySelector('#open-delivery-map');
  const preview = document.querySelector('#delivery-map');
  const search = document.querySelector('#delivery-place-search');
  const message = document.querySelector('#delivery-map-status');
  toggle.hidden = false;
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    message.textContent = 'Loading address search…';
    try {
      const googleMaps = await loadDeliveryMaps(config.key);
      const [{Map, Circle}, {PlaceAutocompleteElement}, {AdvancedMarkerElement}] = await Promise.all(
        ['maps', 'places', 'marker'].map(name => googleMaps.importLibrary(name))
      );
      const picker = new PlaceAutocompleteElement({includedRegionCodes: ['in']});
      search.append(picker);
      preview.hidden = false;
      const center = serviceArea ? {lat: serviceArea.latitude, lng: serviceArea.longitude} : {lat: 12.82, lng: 80.04};
      const map = new Map(preview, {mapId: config.id, center, zoom: 13});
      if (serviceArea) new Circle({map, center, radius: serviceArea.radiusMeters, clickable: false,
        fillColor: '#F5C542', fillOpacity: .12, strokeColor: '#B9831A', strokeWeight: 2});
      const marker = new AdvancedMarkerElement({map, title: 'Delivery location'});
      function setPin(position) {
        marker.position = position;
        const {lat, lng} = position.toJSON();
        address.value = address.value.replace(/\s*Delivery pin: -?[\d.]+, -?[\d.]+\s*$/, '').trim()
          + '\nDelivery pin: ' + lat.toFixed(6) + ', ' + lng.toFixed(6);
        address.dispatchEvent(new Event('input', {bubbles:true}));
        message.textContent = 'Delivery pin added. Include your room, building or landmark in the address.';
      }
      picker.addEventListener('gmp-select', async ({placePrediction}) => {
        try {
          const place = placePrediction.toPlace();
          await place.fetchFields({fields: ['formattedAddress', 'location']});
          if (!place.location) throw new Error('Location missing');
          if (place.formattedAddress) address.value = place.formattedAddress;
          map.panTo(place.location);
          map.setZoom(17);
          setPin(place.location);
        } catch {
          message.textContent = 'Could not load that address. Enter it manually or choose a pin.';
        }
      });
      map.addListener('click', ({latLng}) => { if (latLng) setPin(latLng); });
      message.textContent = 'Search for an address or choose a point on the map.';
      toggle.hidden = true;
    } catch {
      message.textContent = 'The map is unavailable. Add a pin on the Address page, or add Delivery pin: latitude, longitude as the last line of your address.';
    } finally {
      toggle.disabled = false;
    }
  });
}
