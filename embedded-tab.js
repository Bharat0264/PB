if (window.parent !== window && new URLSearchParams(location.search).has('embedded')) {
  document.documentElement.classList.add('embedded-tab');
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    const href = link?.getAttribute('href');
    if (link && !link.target && !link.hasAttribute('download') && href && !href.startsWith('#')) link.target = '_top';
  });
}
