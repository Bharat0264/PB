/* Progressive enhancements for the Terms page only. The legal copy stays in HTML. */
(() => {
  'use strict';
  const main = document.querySelector('.legal-main');
  if (!main) return;
  const sections = [...main.querySelectorAll('[data-legal-section]')];
  const toc = main.querySelector('.legal-toc');
  const links = [...toc.querySelectorAll('a')];
  const search = main.querySelector('#legal-query');
  const results = main.querySelector('#legal-results');
  const backTop = document.querySelector('.legal-backtop');
  const progress = document.querySelector('.legal-progress');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = matchMedia('(max-width: 850px)');
  let current, queued = 0;
  const behavior = () => reduced.matches ? 'instant' : 'smooth';

  function selectSection(section) {
    const link = links[sections.indexOf(section)];
    if (!link) { toc.style.visibility = 'hidden'; return; }
    toc.style.visibility = '';
    for (const item of links) {
      if (item === link) item.setAttribute('aria-current', 'location');
      else item.removeAttribute('aria-current');
    }
    toc.style.setProperty('--toc-y', link.offsetTop + 'px');
    toc.style.setProperty('--toc-h', link.offsetHeight + 'px');
    toc.style.setProperty('--toc-x', link.offsetLeft + 'px');
    toc.style.setProperty('--toc-w', link.offsetWidth + 'px');
    if (mobile.matches && current !== section.id) {
      toc.scrollTo({left: Math.max(0, link.offsetLeft - (toc.clientWidth - link.offsetWidth) / 2), behavior: behavior()});
    }
    current = section.id;
  }
  function readPosition() {
    queued = 0;
    const available = sections.filter(section => !section.hidden);
    const headerHeight = parseFloat(getComputedStyle(document.body).getPropertyValue('--legal-header')) || 80;
    const threshold = headerHeight + (mobile.matches ? 104 : 48);
    let active = available[0];
    for (const section of available) if (section.getBoundingClientRect().top <= threshold) active = section;
    selectSection(active);
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.setProperty('--legal-progress', Math.max(0, Math.min(1, max > 0 ? scrollY / max : 0)));
    backTop.hidden = scrollY < innerHeight;
  }
  function schedulePosition() { if (!queued) queued = requestAnimationFrame(readPosition); }
  addEventListener('scroll', schedulePosition, {passive: true});
  addEventListener('resize', schedulePosition);
  if ('ResizeObserver' in window) new ResizeObserver(schedulePosition).observe(main);

  // Preserve real anchor URLs and keyboard focus, including the older shared links.
  for (const link of [...links, backTop]) link.addEventListener('click', event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(link.hash.slice(1));
    if (!target) return;
    event.preventDefault();
    target.classList.remove('is-reveal-pending');
    history.pushState(null, '', link.hash);
    target.scrollIntoView({behavior: behavior(), block: 'start'});
    if (target.matches('[data-legal-section]')) {
      const heading = target.querySelector('h2');
      heading.tabIndex = -1;
      heading.focus({preventScroll: true});
    }
  });

  // Native details provide keyboard behavior and a complete no-JS reading experience.
  const disclosureAnimations = new Map();
  const disclosures = [...main.querySelectorAll('.legal-disclosure')];
  for (const details of disclosures) {
    const summary = details.querySelector('summary');
    summary.addEventListener('click', event => {
      event.preventDefault();
      const opening = !details.open || details.hasAttribute('data-closing');
      const start = details.getBoundingClientRect().height;
      disclosureAnimations.get(details)?.cancel();
      disclosureAnimations.delete(details);
      details.toggleAttribute('data-closing', !opening);
      summary.setAttribute('aria-expanded', String(opening));
      if (opening) details.open = true;
      if (reduced.matches) { details.open = opening; details.removeAttribute('data-closing'); details.style.overflow = ''; return; }
      const end = opening ? details.scrollHeight + 2 : summary.getBoundingClientRect().height + 2;
      details.style.overflow = 'hidden';
      const animation = details.animate([{height: start + 'px'}, {height: end + 'px'}], {duration: 240, easing: 'cubic-bezier(.22,1,.36,1)'});
      disclosureAnimations.set(details, animation);
      animation.finished.then(() => {
        if (disclosureAnimations.get(details) !== animation) return;
        details.open = opening;
        details.removeAttribute('data-closing');
        details.style.overflow = '';
        disclosureAnimations.delete(details);
        schedulePosition();
      }, () => {});
    });
    details.addEventListener('toggle', () => {
      if (!disclosureAnimations.has(details)) summary.setAttribute('aria-expanded', String(details.open));
      schedulePosition();
    });
  }

  // Match literal text; never insert the search query as HTML or as a regular expression.
  function clearHighlights() {
    for (const mark of main.querySelectorAll('mark')) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    }
  }
  function highlight(root, query) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.textContent, lower = text.toLocaleLowerCase();
      let offset = 0, at = lower.indexOf(query);
      if (at < 0) continue;
      const fragment = document.createDocumentFragment();
      while (at >= 0) {
        fragment.append(document.createTextNode(text.slice(offset, at)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(at, at + query.length);
        fragment.append(mark);
        offset = at + query.length;
        at = lower.indexOf(query, offset);
      }
      fragment.append(document.createTextNode(text.slice(offset)));
      node.replaceWith(fragment);
    }
  }
  search.addEventListener('input', () => {
    clearHighlights();
    const query = search.value.trim().toLocaleLowerCase();
    let count = 0;
    sections.forEach((section, index) => {
      const matches = !query || section.textContent.toLocaleLowerCase().includes(query);
      section.hidden = links[index].hidden = !matches;
      if (!matches) return;
      count++;
      section.classList.remove('is-reveal-pending');
      if (query) {
        for (const copy of section.querySelectorAll('[data-search-copy]')) highlight(copy, query);
        for (const details of section.querySelectorAll('details')) {
          disclosureAnimations.get(details)?.cancel();
          disclosureAnimations.delete(details);
          details.style.overflow = '';
          details.removeAttribute('data-closing');
          details.open = true;
          details.querySelector('summary').setAttribute('aria-expanded', 'true');
        }
      }
    });
    results.textContent = query ? `${count} ${count === 1 ? 'section matches' : 'sections match'} “${search.value.trim()}”` : '10 sections · A clear guide to your order';
    main.querySelector('.legal-no-results').hidden = count !== 0;
    schedulePosition();
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      search.scrollIntoView({block: 'center', behavior: 'instant'});
      search.focus({preventScroll: true}); search.select();
    } else if (event.key === 'Escape' && document.activeElement === search && search.value) {
      search.value = ''; search.dispatchEvent(new Event('input'));
    }
  });
  for (const button of main.querySelectorAll('[data-copy-section]')) button.addEventListener('click', async () => {
    const url = new URL(location.href); url.hash = button.dataset.copySection;
    const status = document.querySelector('#legal-copy-status');
    try { await navigator.clipboard.writeText(url.href); status.textContent = 'Section link copied.'; }
    catch { status.textContent = 'Section link: ' + url.href; }
  });

  // Reveal only off-screen sections, so above-the-fold content never waits on JS.
  if ('IntersectionObserver' in window && !reduced.matches) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        entry.target.classList.remove('is-reveal-pending'); observer.unobserve(entry.target);
      }
    }, {threshold: .06});
    for (const section of sections) if (section.getBoundingClientRect().top > innerHeight) {
      section.classList.add('is-reveal-pending'); observer.observe(section);
    }
    reduced.addEventListener('change', () => {
      if (reduced.matches) { observer.disconnect(); sections.forEach(section => section.classList.remove('is-reveal-pending')); }
    });
  }
  let printState;
  addEventListener('beforeprint', () => {
    if (!printState) printState = disclosures.map(details => details.open);
    for (const details of disclosures) {
      disclosureAnimations.get(details)?.cancel(); disclosureAnimations.delete(details);
      details.removeAttribute('data-closing'); details.style.overflow = ''; details.open = true;
    }
  });
  addEventListener('afterprint', () => {
    disclosures.forEach((details, index) => { details.open = printState?.[index] ?? true; });
    printState = undefined;
    schedulePosition();
  });
  readPosition();
})();
