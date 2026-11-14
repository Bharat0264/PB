if (window.parent !== window && document.referrer && new URL(document.referrer).origin === location.origin) {
  const route = new URLSearchParams(location.search).get('embedded');
  document.documentElement.classList.add('embedded-tab');
  if (route === 'saved') {
    document.documentElement.dataset.tab = 'saved';
    const heading = document.querySelector('#queue h1');
    heading.textContent = 'Saved files';
    heading.nextElementSibling.textContent = 'Review the files saved in your print cart.';
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    const href = link?.getAttribute('href');
    if (href && !link.target && !href.startsWith('#')) link.target = '_top';
  });
  document.addEventListener('keydown', event => {
    if (route === 'add' && event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      window.parent.postMessage('printbee:close-sheet', location.origin);
    }
  });
}
