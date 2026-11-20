/* Change Theme gallery: lists the registered themes, previews them live, applies or cancels.
   All theme logic lives in theme-engine.js; this file is only the interface. */
(() => {
  'use strict';
  const engine = window.PrintBeeThemes;
  const gallery = document.getElementById('theme-gallery');
  if (!engine || !gallery) return;

  const bar = document.getElementById('theme-bar');
  const barName = document.getElementById('theme-bar-name');
  const status = document.getElementById('theme-status');
  const root = document.documentElement;
  const isDark = () => ['dark', 'moon'].includes(root.dataset.theme);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const say = message => { status.textContent = ''; setTimeout(() => { status.textContent = message; }, 30); };

  function swatches(theme) {
    const wanted = isDark() ? 'dark' : 'light';
    const set = theme.preview?.[wanted] || theme.preview?.light || theme.preview?.dark || {};
    return {page: set.page, surface: set.surface, ink: set.ink, accent: set.accent, nav: set.nav, art: set.art};
  }

  function thumbnail(theme) {
    const thumb = make('div', 'theme-thumb');
    thumb.setAttribute('aria-hidden', 'true');
    const colours = swatches(theme);
    for (const [name, value] of Object.entries(colours)) if (value) thumb.style.setProperty('--t-' + name, value);
    if (colours.art) thumb.dataset.art = 'true';
    const top = make('span', 'theme-thumb-top');
    top.append(make('i'), make('i'), make('i'));
    const card = make('span', 'theme-thumb-card');
    card.append(make('i'), make('i'), make('i'));
    thumb.append(top, card, make('span', 'theme-thumb-button'));
    return thumb;
  }

  function card(theme) {
    const applied = engine.saved() === theme.id;
    const previewed = engine.isPreviewing() && engine.current() === theme.id;
    const item = make('li', 'theme-card');
    item.dataset.themeId = theme.id;
    if (applied) item.classList.add('is-applied');
    if (previewed) item.classList.add('is-previewing');

    const info = make('div', 'theme-info');
    const title = make('h2', 'theme-name', theme.name);
    title.id = 'theme-name-' + theme.id;
    const badges = make('span', 'theme-badges');
    if (applied) badges.append(make('span', 'theme-badge theme-badge-applied', 'Applied'));
    if (previewed) badges.append(make('span', 'theme-badge theme-badge-preview', 'Previewing'));
    if (theme.default) badges.append(make('span', 'theme-badge', 'Default'));
    if (theme.modes.length === 1) badges.append(make('span', 'theme-badge', theme.modes[0] === 'dark' ? 'Dark only' : 'Light only'));
    const head = make('div', 'theme-head');
    head.append(title, badges);
    info.append(head, make('p', 'theme-tagline', theme.tagline), make('p', 'theme-desc', theme.description));
    if (theme.palette?.length) {
      const palette = make('ul', 'theme-palette');
      palette.setAttribute('aria-label', theme.name + ' colour identity');
      for (const colour of theme.palette) {
        const dot = make('li');
        dot.style.setProperty('--c', colour);
        dot.title = colour;
        palette.append(dot);
      }
      info.append(palette);
    }

    const actions = make('div', 'theme-actions');
    const preview = make('button', 'theme-btn', previewed ? 'Previewing' : 'Preview');
    preview.type = 'button';
    preview.disabled = applied && !engine.isPreviewing() || previewed;
    preview.setAttribute('aria-describedby', title.id);
    preview.addEventListener('click', () => {
      engine.preview(theme.id).then(() => say('Previewing ' + theme.name + '. Nothing is saved yet.'));
    });
    const apply = make('button', 'theme-btn theme-btn-primary', applied && !engine.isPreviewing() ? 'Applied' : 'Apply');
    apply.type = 'button';
    apply.disabled = applied && !engine.isPreviewing();
    apply.setAttribute('aria-describedby', title.id);
    apply.setAttribute('aria-pressed', String(applied));
    apply.addEventListener('click', () => {
      engine.apply(theme.id).then(() => say(theme.name + ' theme applied.'));
    });
    actions.append(preview, apply);

    item.setAttribute('aria-labelledby', title.id);
    item.append(thumbnail(theme), info, actions);
    return item;
  }

  function soon() {
    const item = make('li', 'theme-card theme-soon');
    item.append(make('span', 'theme-soon-mark', '+'), make('h2', 'theme-name', 'More themes are coming'),
      make('p', 'theme-desc', 'New looks for PrintBee will show up here as they are released.'));
    return item;
  }

  function render() {
    const previewing = engine.isPreviewing();
    const focused = document.activeElement?.closest?.('.theme-card')?.dataset.themeId;
    const role = document.activeElement?.classList.contains('theme-btn-primary') ? 'apply' : 'preview';
    gallery.replaceChildren(...engine.list().map(card), ...(engine.list().length < 3 ? [soon()] : []));
    bar.hidden = !previewing;
    if (previewing) barName.textContent = engine.get(engine.current())?.name || '';
    if (focused) {
      const buttons = gallery.querySelectorAll('[data-theme-id="' + focused + '"] .theme-btn');
      const target = role === 'apply' ? buttons[1] : buttons[0];
      (target && !target.disabled ? target : buttons[1] && !buttons[1].disabled ? buttons[1] : buttons[0])?.focus({preventScroll: true});
    }
  }

  document.getElementById('theme-bar-apply').addEventListener('click', () => {
    const name = engine.get(engine.current())?.name;
    engine.commitPreview().then(() => say((name || 'Theme') + ' theme applied.'));
  });
  document.getElementById('theme-bar-cancel').addEventListener('click', () => {
    engine.cancelPreview().then(() => say('Preview cancelled. Your theme is unchanged.'));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && engine.isPreviewing()) {
      engine.cancelPreview().then(() => say('Preview cancelled. Your theme is unchanged.'));
    }
  });

  engine.onChange(render);
  new MutationObserver(render).observe(root, {attributes: true, attributeFilter: ['data-theme']});   // Sun/Moon changes the thumbnails
  render();
})();
