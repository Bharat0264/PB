/* PrintBee Theme Engine: registry access, provider, persistence, preview/apply.
   Load it in <head>, after theme-registry.js and before hive-theme.js, so the saved theme is on <html>
   before the first paint (no flash). It never reloads the page and touches no business logic.

   Public API (window.PrintBeeThemes):
     list() / get(id) / current() / saved() / defaultId
     apply(id)            switch and remember the choice
     preview(id)          switch temporarily, nothing is remembered
     cancelPreview()      go back to the remembered theme
     commitPreview()      keep the previewed theme
     isPreviewing()
     register(def)        add a theme at runtime (returns true, or false with a console error)
     onChange(fn)         fn({id, previous, preview}); returns an unsubscribe function
     validate(def)        list of problems with a definition (empty when it is valid)
*/
(() => {
  'use strict';
  if (window.PrintBeeThemes) return;

  const KEY = 'printbee-theme';
  const MODE_KEY = 'printbee-admin-theme';          // the Sun/Moon choice saved by hive-theme.js
  const DEFAULT_ID = 'printbee';
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const system = matchMedia('(prefers-color-scheme: dark)');

  // Every non-default theme must provide all of these (without the --pb- prefix) for each mode it supports.
  const REQUIRED_TOKENS = [
    'page', 'surface', 'surface-2', 'ink', 'muted', 'border',
    'accent', 'accent-strong', 'accent-ink',
    'success', 'warning', 'danger', 'info',
    'radius-card', 'radius-control', 'radius-pill',
    'shadow-raised', 'shadow-inset', 'shadow-pressed',
    'font-body', 'font-display',
  ];
  const ID = /^[a-z][a-z0-9-]{1,31}$/;
  const darkMode = () => ['dark', 'moon'].includes(root.dataset.theme);
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage may be blocked */ } };

  const themes = new Map();
  const listeners = new Set();
  let current = DEFAULT_ID;
  let remembered = DEFAULT_ID;
  let previewing = false;
  let forcedMode = '';                              // set while a single-mode theme overrides Sun/Moon
  let styleTag;

  function validate(def) {
    const problems = [];
    if (!def || typeof def !== 'object') return ['Definition must be an object.'];
    if (!ID.test(def.id || '')) problems.push('id must be kebab-case, 2-32 characters.');
    if (themes.has(def.id)) problems.push('id "' + def.id + '" is already registered.');
    for (const field of ['name', 'tagline', 'description']) {
      if (typeof def[field] !== 'string' || !def[field].trim()) problems.push(field + ' is required.');
    }
    const modes = def.modes;
    if (!Array.isArray(modes) || !modes.length || modes.some(mode => !['light', 'dark'].includes(mode))) {
      problems.push('modes must list "light" and/or "dark".');
    } else if (!def.default) {
      for (const mode of modes) {
        const set = def.tokens?.[mode];
        if (!set) { problems.push('tokens.' + mode + ' is missing.'); continue; }
        for (const name of REQUIRED_TOKENS) if (typeof set[name] !== 'string' || !set[name]) problems.push('tokens.' + mode + '.' + name + ' is missing.');
      }
    }
    if (def.stylesheet && !/^\/themes\/[a-z0-9-]+\.css(\?v=[\w.-]+)?$/.test(def.stylesheet)) problems.push('stylesheet must be /themes/<name>.css (optionally with ?v=version).');
    if (def.script && !/^\/themes\/[a-z0-9-]+\.js(\?v=[\w.-]+)?$/.test(def.script)) problems.push('script must be /themes/<name>.js (optionally with ?v=version).');
    if (def.palette && (!Array.isArray(def.palette) || def.palette.length > 10 || def.palette.some(c => typeof c !== 'string'))) problems.push('palette must be up to 10 colour strings.');
    return problems;
  }

  const rule = (selector, tokens, scheme) =>
    selector + '{' + Object.entries(tokens).map(([name, value]) => '--pb-' + name + ':' + value + ';').join('') + 'color-scheme:' + scheme + '}';

  function cssFor(def) {
    if (!def.tokens) return '';
    const base = ':root[data-pb-theme="' + def.id + '"]';
    const dark = ':is([data-theme="dark"],[data-theme="moon"])';
    const parts = [];
    if (def.modes.includes('light')) parts.push(rule(base + ':not(' + dark + ')', def.tokens.light, 'light'));
    if (def.modes.includes('dark')) parts.push(rule(base + dark, def.tokens.dark, 'dark'));
    return parts.join('\n');
  }

  function rebuildStyles() {
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'pb-theme-tokens';
      document.head.append(styleTag);
    }
    styleTag.textContent = [...themes.values()].map(cssFor).join('\n');
  }

  function register(def) {
    const problems = validate(def);
    if (problems.length) {
      console.error('[PrintBeeThemes] "' + (def && def.id) + '" was not registered:\n - ' + problems.join('\n - '));
      return false;
    }
    themes.set(def.id, Object.freeze({...def}));
    if (styleTag || document.head) rebuildStyles();
    return true;
  }

  // Sun/Moon mode handling for themes that support only one mode.
  function preferredMode() {
    const saved = read(MODE_KEY);
    return saved ? saved === 'dark' : system.matches;
  }
  function enforceMode() {
    const def = themes.get(current);
    if (!def) return;
    const only = def.modes.length === 1 ? def.modes[0] : '';
    if (only) {
      forcedMode = only;
      root.dataset.pbModeLocked = only;
      const wanted = only === 'dark' ? 'dark' : 'light';
      if (root.dataset.theme !== wanted) root.dataset.theme = wanted;
    } else if (forcedMode) {
      forcedMode = '';
      delete root.dataset.pbModeLocked;
      root.dataset.theme = preferredMode() ? 'dark' : 'light';
    }
  }
  new MutationObserver(() => {
    if (forcedMode && root.dataset.theme !== (forcedMode === 'dark' ? 'dark' : 'light')) enforceMode();
  }).observe(root, {attributes: true, attributeFilter: ['data-theme']});

  // Optional per-theme stylesheet, loaded only while that theme is active.
  function loadStylesheet(def, wait) {
    for (const link of document.querySelectorAll('link[data-pb-theme-css]')) link.disabled = link.dataset.pbThemeCss !== def.id;
    if (!def.stylesheet) return Promise.resolve();
    let link = document.querySelector('link[data-pb-theme-css="' + def.id + '"]');
    if (link) { link.disabled = false; return Promise.resolve(); }
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = def.stylesheet;
    link.dataset.pbThemeCss = def.id;
    const done = new Promise(resolve => { link.onload = link.onerror = resolve; setTimeout(resolve, 2500); });
    document.head.append(link);
    return wait ? done : Promise.resolve();
  }

  // Optional per-theme effects (animation, particles). The script registers
  // window.PrintBeeThemeEffects[id] = {start(), stop()}; the engine starts it while the theme is current and stops it after.
  function switchEffects(previousId, def) {
    const effects = () => window.PrintBeeThemeEffects || {};
    if (previousId && previousId !== def.id) { try { effects()[previousId]?.stop(); } catch (error) { console.error(error); } }
    if (!def.script) return;
    const start = () => { if (current === def.id) { try { effects()[def.id]?.start(); } catch (error) { console.error(error); } } };
    if (effects()[def.id]) { start(); return; }
    if (document.querySelector('script[data-pb-theme-js="' + def.id + '"]')) return;
    const script = document.createElement('script');
    script.src = def.script;
    script.async = true;
    script.dataset.pbThemeJs = def.id;
    script.onload = start;
    document.head.append(script);
  }

  function set(id, {persist, preview, initial}) {
    const def = themes.get(id) || themes.get(DEFAULT_ID);
    const previous = current;
    const change = () => {
      current = def.id;
      root.dataset.pbTheme = def.id;
      enforceMode();
    };
    const finish = () => {
      previewing = Boolean(preview);
      if (persist) { remembered = def.id; write(KEY, def.id); }
      if (!preview && !persist) remembered = def.id;
      if (!initial) {
        for (const fn of listeners) { try { fn({id: def.id, previous, preview: Boolean(preview)}); } catch (error) { console.error(error); } }
      }
    };
    const run = () => {
      if (!initial && document.startViewTransition && !reduced.matches && !document.hidden && previous !== def.id) {
        // The cross-fade is a nicety: if the browser does not run it promptly (hidden tab, busy page) switch anyway.
        let ran = false;
        const once = () => { if (!ran) { ran = true; change(); } };
        const fade = document.startViewTransition(once);
        fade.ready.catch(() => {}); fade.finished.catch(() => {});      // a skipped fade is not an error
        return Promise.race([fade.updateCallbackDone, new Promise(resolve => setTimeout(resolve, 300))])
          .catch(() => {}).then(once);
      }
      change();
      return Promise.resolve();
    };
    if (initial) { loadStylesheet(def, false); change(); finish(); switchEffects(null, def); return Promise.resolve(); }
    return loadStylesheet(def, true).then(run).then(finish).then(() => switchEffects(previous, def));
  }

  const api = {
    defaultId: DEFAULT_ID,
    requiredTokens: REQUIRED_TOKENS.slice(),
    list: () => [...themes.values()],
    get: id => themes.get(id),
    current: () => current,
    saved: () => remembered,
    isPreviewing: () => previewing,
    register,
    validate,
    apply: id => set(id, {persist: true}),
    preview: id => set(id, {persist: false, preview: true}),
    cancelPreview: () => previewing ? set(remembered, {persist: false, preview: false}) : Promise.resolve(),
    commitPreview: () => previewing ? set(current, {persist: true, preview: false}) : Promise.resolve(),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  Object.freeze(api);
  window.PrintBeeThemes = api;

  for (const def of window.PrintBeeThemeDefs || []) register(def);
  if (!themes.has(DEFAULT_ID)) {
    console.error('[PrintBeeThemes] The default "' + DEFAULT_ID + '" theme is missing from the registry.');
    register({id: DEFAULT_ID, name: 'PrintBee', tagline: 'Default', description: 'Default theme.', default: true, modes: ['light', 'dark'], tokens: null});
  }
  window.PrintBeeThemeDefs = {push: def => register(def)};   // themes registered after load still work

  const stored = read(KEY);
  remembered = themes.has(stored) ? stored : DEFAULT_ID;
  set(remembered, {persist: false, initial: true});

  addEventListener('storage', event => {
    if (event.key !== KEY || previewing) return;
    const id = themes.has(event.newValue) ? event.newValue : DEFAULT_ID;
    if (id !== current) set(id, {persist: false});
    remembered = id;
  });
})();
