/* PrintBee theme registry.
   Every theme the customer can choose is one object in this list. Adding a theme means adding an object here
   (and, if it needs identity-specific CSS or fonts, one file in /themes/). Nothing else in the site changes.
   See THEMES.md for the full guide and the token reference.

   Theme definition:
   {
     id:          'kebab-case-id',                // unique, becomes <html data-pb-theme="id">
     name:        'Display name',
     tagline:     'Short line under the name in the gallery',
     description: 'One or two sentences for the gallery card',
     modes:       ['light', 'dark'],              // which Sun/Moon modes it supports (a single mode locks the page to it)
     preview:     {light: {page, surface, ink, accent}, dark: {...}},   // swatches for the gallery thumbnail
     tokens:      {light: {...}, dark: {...}},    // semantic tokens, see REQUIRED_TOKENS in theme-engine.js
     stylesheet:  '/themes/id.css',               // optional: extra CSS loaded only while this theme is active
   }
*/
(window.PrintBeeThemeDefs = window.PrintBeeThemeDefs || []).push(
  {
    id: 'printbee',
    name: 'PrintBee',
    tagline: 'Warm honey clay',
    description: 'The original PrintBee look: soft clay surfaces, honey yellow and a calm cream backdrop.',
    default: true,
    modes: ['light', 'dark'],
    // The default theme draws its tokens from the existing stylesheets (theme-engine.css), so the site looks
    // exactly as it always has. These swatches only feed the gallery thumbnail.
    preview: {
      light: {page: '#EDE5D3', surface: '#FFFFFF', ink: '#2A2112', accent: '#F5C542'},
      dark: {page: '#17120A', surface: '#231B0F', ink: '#FFF3D6', accent: '#F5C542'},
    },
    tokens: null,
  },
  {
    // Wildfire: a night-forest identity. Obsidian and charcoal surfaces, deep forest greens, ember orange for action,
    // antique gold for fine detail. Dark only. Atmosphere lives in /themes/wildfire.css (forest, grain, glow) and
    // /themes/wildfire.js (rising embers, paused for reduced motion).
    id: 'wildfire',
    name: 'Wildfire',
    tagline: 'Night forest, rising embers',
    description: 'A cinematic dark theme: obsidian surfaces, deep forest green, antique gold detail and ember-orange light.',
    modes: ['dark'],
    stylesheet: '/themes/wildfire.css?v=6',
    script: '/themes/wildfire.js?v=3',
    palette: ['#100E0C', '#191511', '#111A14', '#17442E', '#236B46', '#C49A52', '#D68A32', '#F05A24', '#F2E9D9'],
    preview: {
      dark: {
        page: '#100E0C', surface: '#191511', ink: '#F2E9D9', accent: '#F05A24', nav: '#17442E',
        // the real hero picture, so the gallery shows what the site actually looks like
        art: 'url("/themes/img/wf-hero-wide.webp?v=2") center / cover no-repeat',
      },
    },
    tokens: {
      dark: {
        page: '#100E0C', surface: '#191511', 'surface-2': '#221B15',
        ink: '#F2E9D9', muted: '#B9AA90', border: '#3A2C1F',
        accent: '#F05A24', 'accent-strong': '#E8A04A', 'accent-ink': '#140B06',
        success: '#4DBA82', warning: '#E0A03A', danger: '#EE6A55', info: '#7FB4C8',
        'radius-card': '22px', 'radius-control': '12px', 'radius-pill': '999px',
        'shadow-raised': '0 0 0 1px rgba(196,154,82,.20), inset 0 1px 0 rgba(242,222,180,.07), 0 12px 30px rgba(0,0,0,.55)',
        'shadow-inset': 'inset 0 2px 7px rgba(0,0,0,.62), inset 0 0 0 1px rgba(196,154,82,.14)',
        'shadow-pressed': 'inset 0 3px 9px rgba(0,0,0,.68), 0 0 0 1px rgba(196,154,82,.2)',
        'font-body': 'Manrope, system-ui, sans-serif',
        'font-display': 'Georgia, "Times New Roman", serif',
      },
    },
  }
);
