# PrintBee preloader

A 2D clay intro that hands off to the hero. No 3D, no WebGL, no models.

## Files

- `preloader.js`: the whole component. Edit the `CONFIG` object at the top for timing, beats, durations, float, tagline and session key.
- `preloader.css`: layout and look. Colours and sizes are custom properties on `#pb-loader`.
- `preloader-bee.webp` (440×406) and `preloader-wordmark.webp` (640×167): layers cut from the horizontal logo.
- `gsap-3.13.0.min.js`: loaded lazily by `preloader.js`.

Included with `<script src="/preloader.js?v=…"></script>` in the `<head>` of the customer pages and the `/home` tab shell (`navigation.html`). It never runs inside a tab iframe; on phones the direct pages redirect into the shell, so the shell shows it instead.

## Sequence

1. **0.0 s** Cream screen. The bee fades and springs in (scale 0.8 to 1), then floats (±6 px, slight tilt) over a breathing clay shadow. The logo is one flat image, so the wing buzz is a tiny rotate/scale pulse.
2. **0.4 s** A rounded yellow ring draws around the bee, with a head dot and a short dotted trail. A pill counter under it rolls its digits.
3. **0.8 s** The `PrintBee` wordmark slides up through a mask (700 ms, `cubic-bezier(.22,1,.36,1)`).
4. **1.4 s** `Upload. Print. Delivered.` rises word by word while the icon morphs document, printer, truck.
5. **Exit** once progress is 100% and at least 2.8 s have passed (or at 4 s at the latest): the ring closes, the bee arcs to the hero printer (or the header logo on pages without one), the cream then yellow curtain lifts (900 ms), and the hero arrives: navbar drops, headline lines slide up through masks, the hero card settles from 0.96.

## Progress

Real tasks only, weighted so the number never goes backwards: loader assets (GSAP, bee, wordmark) 30%, fonts 20%, eager hero images including decode 50%. The display eases toward the real value, creeps only inside the in-flight slice, and is paced so a cached page still shows one smooth sweep.

## Behaviour

- Full intro once per tab session (`sessionStorage`); repeat visits get a 600 ms fade.
- `prefers-reduced-motion`: no float, buzz or flight; the ring still shows progress and the loader fades out.
- No GSAP: a CSS bob and fade still exit on time.
- Safety net: the page is released by 6.6 s in every case (2 s on repeat visits), including background tabs where animation frames stop. A cut-short exit still restores the hero.
- Scroll is locked and the page is `inert` while loading; both are restored. Status text is announced politely at 25% steps.

## Check it

```js
sessionStorage.removeItem('printbee:preloader:v3'); location.reload();
```
