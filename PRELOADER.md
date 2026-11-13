# PrintBee preloader

Installed on Home, Address, Orders, Upload, Profile and Pricing. Staff tools keep their existing immediate entry. All animation assets are served locally; there are no CDN requests at runtime.

## Files

- `preloader.js`: bootstrap, GSAP timeline, loading progress, session behaviour, accessibility and cleanup. Durations and brand colours are in `CONFIG` at the top.
- `preloader.css`: responsive layout, rounded Fredoka wordmark, clay styling and progress bar.
- `preloader-art.js`: inline SVG bee, wings, orbit, paper, CMYK chips and tiny bee. Gradients and shadows are vector-based.
- `gsap-3.13.0.min.js`: pinned GSAP dependency, retaining its license header.
- `fredoka-printbee-700.woff2`: local font subset for the wordmark; `Fredoka-LICENSE.txt` contains the OFL license.
- Six customer HTML pages: shared head hook.
- `server.py`: explicit allowlist entries for the new scripts and stylesheet.

The complete runtime is approximately **106 KB uncompressed**, including GSAP, SVG artwork and the font. Existing website images/fonts are separate assets.

## Where to plug it in

This site is plain HTML/JavaScript. Each customer page includes this in `<head>`, before its existing stylesheet and deferred application scripts:

```html
<script src="preloader.js?v=1"></script>
```

Keep the five runtime files together. The script locates its assets relative to its own URL and injects the stylesheet, SVG module and GSAP. It does not change the upload, order or profile scripts. Open via the existing local server at `http://127.0.0.1:4188/`.

## Timing and progress

- First visit: approximately 3.1 seconds when assets are ready; minimum 1.8 seconds; six-second watchdog including exit.
- Further page loads in the same tab session: approximately 0.6-second static logo fade.
- Reduced motion: static logo fade and progress bar; no flight, flapping, bouncing, ring drawing or wipe.
- Stalled assets: reveal the website by six seconds. The bar is not forced to 100%.
- Failed assets: count as checked so a missing file cannot trap the visitor; failure counts are available in the diagnostic state.
- Progress measures completed asset tasks, not downloaded bytes: local loader dependencies, font readiness and unique eager images including image decoding. Lazy footer images are deliberately excluded.
- Tagline highlights use real progress: Upload below 33%, Print from 33% to below 66%, Delivered from 66% onwards. A cached visit may pass through the first two stages too quickly to see; there is no artificial progress delay.
- Transforms and opacity drive motion. The short orbit drawing uses SVG stroke-dashoffset, as requested. Filters and gradients are static.

The current site has no 3D model files. Register a future model-loading promise **before DOMContentLoaded** to include it in progress:

```js
const modelReady = loader.loadAsync('/assets/printer.glb');
window.PrintBeePreloader.track(modelReady, 'Printer model');
```

`track()` returns false if registration is already closed. Keep normal application handling for the promise. The preloader observes readiness; it does not create or display the model.

For diagnostics:

```js
window.PrintBeePreloader.state
// { mode, progress, loaded, total, failed, finished, reason }
window.addEventListener('printbee:ready', ({ detail }) => console.log(detail));
// { reason, failed, duration }
```

## Check it

1. First visit: open a fresh browser session or run the following once in DevTools, then reload:
   ```js
   sessionStorage.removeItem('printbee:preloader:seen:v1');
   location.reload();
   ```
   Watch the ring, flying bee, CMYK sequence, letters, tiny bee, tagline, page slide and yellow/white wipe.
2. Repeat: navigate to Upload or Profile. Only the short logo fade plays. Confirm the cart, file chooser and profile form remain usable afterwards.
3. Mobile: use a 390px viewport. The logo composition is about 70vw, remains centred and causes no horizontal scrolling.
4. Reduced motion: enable the OS setting or emulate `prefers-reduced-motion: reduce`, clear the session flag and reload. Only the fade and progress bar remain.
5. Loading: throttle the hero image. Progress stays below 100% until it loads and decodes. Block an image or font and confirm the page still opens.
6. Timeout: register an unresolved model promise before DOMContentLoaded. The page opens by six seconds, with an incomplete progress value and a timeout result.
7. Scroll/accessibility: the underlying page is inert while loading, then returns to its previous state. Wheel/touch scrolling and keyboard navigation work after exit. Disable JavaScript and the website remains visible.

Automated Chromium checks covered all six customer pages, desktop/mobile, repeat visits, reduced motion, a delayed hero, a stalled model, missing GSAP/font, a delayed animation engine and disabled JavaScript. Results are saved in `../printbee-preloader-checks.json`; the verification script is `../../work/test-preloader.py`.
