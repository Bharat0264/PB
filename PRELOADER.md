# PrintBee 3D preloader

The six customer pages load the shared preloader from the document head. The site is plain HTML, CSS and JavaScript. Start it with Start PrintBee.cmd or run python server.py and open http://127.0.0.1:4188/.

- preloader.js handles the GSAP timeline, loading progress, session behavior, fallback and scroll restoration. Edit CONFIG at the top to change the duration, model deadline, asset paths or colors. Timings are milliseconds.
- preloader-3d.mjs contains the Three.js scene. preloader-3d.bundle.js is the bundled version served to the browser. The scene uses a transparent canvas, two studio lights, a soft shadow and pointer parallax. It releases the renderer and model resources on exit.
- preloader.css styles the logo fallback, wordmark, progress bar and canvas. preloader-art.js supplies the orbit paths and motion guides.
- public/models contains the Draco-compressed GLBs with WebP textures capped at 1024 px. public/draco contains the local decoder.

To rebuild the scene bundle after editing its source, install three@0.179.1 and esbuild locally, then run:

    npx esbuild preloader-3d.mjs --bundle --format=esm --minify --outfile=preloader-3d.bundle.js

Restart the Python server after rebuilding so it refreshes the compressed bundle it serves.

| GLB | Bytes | Tripo credits |
| --- | ---: | ---: |
| bee_main.glb | 149,360 | 30 |
| paper_sheet.glb | 99,688 | 20 |
| bee_mini.glb | 114,592 | 20 |
| Total | 363,640 | 70 |

The main bee came back with its wings and paper intact. The scene uses squash and stretch on the combined model, with a separate paper model for the exit and colored light pulses over the baked CMYK chips. Three Tripo generations were used, with no retries.

Progress uses completed model requests and decoding, font readiness and eager images. The first visit has a 1.8-second minimum and a six-second watchdog. The 3D sequence itself runs for about three seconds after the models are ready. Reloading in the same tab shows a short logo fade. Navigation between PrintBee pages skips the loader. For a full replay, use a fresh session or clear the sessionStorage key printbee:preloader:seen:v2. Reduced motion uses a static logo and bar. A failed model, unavailable WebGL or an exceeded model deadline uses the bobbing logo and bar.

Local Chrome checks covered desktop and mobile 3D, repeat visits, reduced motion and a blocked model request. With a cold cache and simulated Fast 3G (150 ms latency, 1.6 Mbps download, 750 kbps upload), the logo fallback revealed the homepage at about 5.5 seconds. The hero image was complete by the reveal. Unthrottled Chrome with software WebGL showed the complete 3D sequence and revealed the homepage at about 5.0 seconds from preloader startup.
