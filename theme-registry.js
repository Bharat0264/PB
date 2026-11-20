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
  }
);
