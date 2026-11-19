/* The 3D bee for the Buzz support button. Loaded on demand by buzz-chat.js (never on the portals for staff).
 *
 * The model is /buzz-bee.glb: your Bee.glb, simplified for the web (about 19,000 triangles and 512 px textures, 0.8 MB instead of 58 MB).
 * Its surface is /buzz-bee-clay.webp, a retouched copy of the original colour texture in the soft clay style of the PrintBee logo mascot
 * (lemon-yellow, cream wings, warm near-black stripes, the lighting that was baked into the picture eased), drawn with a matte clay material.
 * It is one solid mesh without a skeleton or animation clips, so the wings cannot flap on their own. Everything you see move is done
 * here: a float, a left-right tilt, a tiny squash and stretch, an occasional attention hop, a look-at-the-cursor on hover and a
 * fly-around when it is clicked. The loop runs at 30 frames a second when the bee is just floating and only goes faster during a hop,
 * a hover or a click. It stops while the tab is hidden or the bee is not shown, and with "reduce motion" it draws one still picture.
 */
import * as THREE from '/vendor/three/three.module.js';
import {GLTFLoader} from '/vendor/three/GLTFLoader.js';
import {RoomEnvironment} from '/vendor/three/RoomEnvironment.js';

const MODEL = '/buzz-bee.glb?v=1';
const CLAY_TEXTURE = '/buzz-bee-clay.webp?v=1';
const FIT = 1.62;                      // the bee's longest side, in world units (the view is 1.985 units tall for the button's box): leaves room to hop and spin
const FACE_YAW = 0;                    // turn the model so it looks at the customer (set after checking the model's orientation)
const IDLE_FPS = 30;
const BASE_DISTANCE = 4.3;             // how far the camera sits when the canvas is exactly the size of the bee's box
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const ease = t => 1 - Math.pow(1 - t, 3);

export async function createBee(canvas, {reducedMotion = false} = {}) {
  const renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true, powerPreference: 'low-power'});
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  scene.environmentIntensity = 0.6;
  room.dispose();
  // soft, even light like a clay render: a gentle warm key, a strong sky/ground fill and a faint rim from behind
  const key = new THREE.DirectionalLight(0xfff1d6, 1.05);
  key.position.set(1.6, 2.4, 2.6);
  const rim = new THREE.DirectionalLight(0xffe3a8, 0.45);
  rim.position.set(-2.2, 1.2, -2);
  scene.add(key, rim, new THREE.HemisphereLight(0xfffaf0, 0xffdca0, 0.85));

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  camera.position.set(0, 0.05, BASE_DISTANCE);
  camera.lookAt(0, 0, 0);

  const [gltf, clay] = await Promise.all([
    new GLTFLoader().loadAsync(MODEL),
    new THREE.TextureLoader().loadAsync(CLAY_TEXTURE).catch(() => null),      // if the clay picture is missing the original texture is used
  ]);
  const model = gltf.scene;
  if (clay) { clay.flipY = false; clay.colorSpace = THREE.SRGBColorSpace; clay.anisotropy = 4; }
  model.traverse(node => {
    if (!node.isMesh) return;
    const original = node.material;
    // matte clay: no metal, a high roughness, a soft velvet sheen at the edges, and the baked-in bumps turned down so the surface looks smooth
    node.material = new THREE.MeshPhysicalMaterial({
      map: clay || original.map, normalMap: original.normalMap, normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.78, metalness: 0, sheen: 0.6, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xfff0c8), envMapIntensity: 0.8,
    });
    if (clay && original.map) original.map.dispose();
    for (const key of ['roughnessMap', 'metalnessMap', 'aoMap']) if (original[key]) original[key].dispose();
    original.dispose();
  });
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  model.position.sub(centre);
  const fit = FIT / Math.max(size.x, size.y, size.z);
  const pivot = new THREE.Group();                      // everything that moves (float, tilt, squash) moves this
  const holder = new THREE.Group();                     // and this one turns the bee to face the camera
  holder.rotation.y = FACE_YAW;
  holder.add(model);
  pivot.add(holder);
  pivot.scale.setScalar(fit);
  scene.add(pivot);
  model.traverse(node => { if (node.isMesh) { node.frustumCulled = false; } });

  let width = 0, height = 0, baseY = 0;
  const VIEW_HEIGHT = 2 * BASE_DISTANCE * Math.tan(THREE.MathUtils.degToRad(13));        // world height seen across the button's box
  function resize() {
    const w = canvas.clientWidth || 96, h = canvas.clientHeight || 96;
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // The canvas is bigger than the bee's box, with the most room above it (a hop or a flying loop goes up) and some at the sides. Pull the
    // camera back by the same ratio, and move the bee down by half the difference between the top and bottom room, so the bee stays exactly
    // the size and place it was designed to have inside its box, and nothing is ever cut off at an edge of the canvas.
    const box = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : null;
    const area = canvas.getBoundingClientRect();
    const boxH = box && box.height > 40 && box.height < h ? box.height : Math.max(60, h - 52);
    const roomTop = box && box.height > 40 ? Math.max(0, box.top - area.top) : 26, roomBottom = box && box.height > 40 ? Math.max(0, area.bottom - box.bottom) : 26;
    camera.position.z = BASE_DISTANCE * h / boxH;
    baseY = -((roomTop - roomBottom) / 2) * (VIEW_HEIGHT / boxH);
    camera.updateProjectionMatrix();
  }

  // ---- motion state ----
  const state = {t: 0, hover: false, lookX: 0, lookY: 0, smoothX: 0, smoothY: 0, grow: 1, hop: -1, nextHop: 6 + Math.random() * 3, fly: -1, wave: -1};
  const baseScale = fit;

  function pose(dt) {
    const t = state.t;
    const damp = 1 - Math.exp(-dt * 9);
    state.smoothX += (state.lookX - state.smoothX) * damp;
    state.smoothY += (state.lookY - state.smoothY) * damp;
    state.grow += ((state.hover ? 1.13 : 1) - state.grow) * damp;

    let y = Math.sin(t * 1.7) * 0.05;                               // float
    let roll = Math.sin(t * 0.85) * 0.12;                            // left-right tilt
    let yaw = Math.sin(t * 0.55) * 0.16;
    const wobble = Math.sin(t * 3.4) * 0.018;                        // tiny squash and stretch
    let stretch = 1 + wobble;
    let spin = 0;
    let jitter = 0;

    if (state.hop >= 0) {                                            // an occasional hop to say "I'm here"
      state.hop += dt / 0.95;
      const p = state.hop;
      if (p >= 1) state.hop = -1;
      else {
        const h = Math.abs(Math.sin(p * Math.PI * 2.2)) * (1 - p) * 0.22;
        y += h;
        stretch += (h > 0.02 ? 0.07 : -0.05) * (1 - p);
        roll += Math.sin(p * Math.PI * 4) * 0.1 * (1 - p);
        jitter = 0.5 * (1 - p);
      }
    }
    if (state.wave >= 0) {                                           // hovered: a gentle wave hello (a few quick tilts that settle)
      state.wave += dt / 0.95;
      const p = state.wave;
      if (p >= 1) state.wave = -1;
      else {
        const fade = 1 - p;
        roll += Math.sin(p * Math.PI * 5) * 0.2 * fade;
        yaw += Math.sin(p * Math.PI * 2.5) * 0.12 * fade;
        y += Math.sin(p * Math.PI) * 0.03;
      }
    }
    if (state.fly >= 0) {                                            // clicked: a quick flying loop
      state.fly += dt / 0.62;
      const p = Math.min(state.fly, 1);
      if (state.fly >= 1) state.fly = -1;
      y += Math.sin(p * Math.PI) * 0.34;
      spin = ease(p) * Math.PI * 2;
      stretch += Math.sin(p * Math.PI) * 0.1;
      roll += Math.sin(p * Math.PI * 2) * 0.22;
      jitter = Math.max(jitter, 1 - p);
    }

    const buzz = jitter ? Math.sin(t * 90) * 0.012 * jitter : 0;     // a little vibration while it flaps about
    pivot.position.y = baseY + y;
    pivot.rotation.set(-state.smoothY * 0.38, yaw + state.smoothX * 0.55 + spin, roll - state.smoothX * 0.12 + buzz, 'YXZ');
    const grow = state.grow * baseScale;
    pivot.scale.set(grow * (1 - (stretch - 1) * 0.5), grow * stretch, grow * (1 - (stretch - 1) * 0.5));
  }

  // ---- the loop: slow when idle, stops when hidden ----
  let running = false, raf = 0, last = 0, shown = true;
  function tick(now) {
    raf = 0;
    if (!running) return;
    const elapsed = (now - last) / 1000;
    const busy = state.hover || state.hop >= 0 || state.fly >= 0 || state.wave >= 0 || Math.abs(state.lookX - state.smoothX) > 0.01 || Math.abs(state.grow - (state.hover ? 1.13 : 1)) > 0.003;
    if (elapsed >= (busy ? 1 / 58 : 1 / IDLE_FPS) - 0.002) {
      const dt = Math.min(elapsed, 0.1);
      last = now;
      state.t += dt;
      state.nextHop -= dt;
      if (state.nextHop <= 0 && state.hop < 0 && state.fly < 0 && !state.hover) { state.hop = 0; state.nextHop = 9 + Math.random() * 5; }
      resize();
      pose(dt);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);
  }
  function drawOnce() {
    resize();
    state.t = 0.6;
    pose(0.016);
    renderer.render(scene, camera);
  }
  function start() {
    if (reducedMotion) { drawOnce(); return; }
    if (running || document.hidden || !shown) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', () => { if (reducedMotion) drawOnce(); });

  drawOnce();                                                         // the first picture is there even before the loop starts

  return {
    start, stop,
    show(on) { shown = on; if (on) start(); else stop(); },
    hover(on) { state.hover = on; if (on && !reducedMotion && state.fly < 0) state.wave = 0; if (!on) { state.lookX = state.lookY = 0; } if (reducedMotion) drawOnce(); },
    look(x, y) { if (!reducedMotion) { state.lookX = clamp(x, -1, 1); state.lookY = clamp(y, -1, 1); } },
    poke() { if (!reducedMotion) state.fly = 0; },
    greet() { if (!reducedMotion) state.hop = 0; },
    // A self-check: draws the bee in its most extreme poses (looking every way, the top of each hop, every moment of a wave and of a flying
    // loop, with and without the hover growth) and reports the strongest picture found on the canvas edge. 0 means nothing is ever cut off.
    probeEdges() {
      const gl = renderer.getContext();
      const saved = {...state};
      resize();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, pixels = new Uint8Array(w * h * 4);
      const worst = {alpha: 0, pose: 'none', poses: 0};
      const draw = name => {
        pose(0.016);
        renderer.render(scene, camera);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let top = 0;
        for (let band = 0; band < 2; band++) {
          for (let x = 0; x < w; x++) top = Math.max(top, pixels[(band * w + x) * 4 + 3], pixels[((h - 1 - band) * w + x) * 4 + 3]);
          for (let y = 0; y < h; y++) top = Math.max(top, pixels[(y * w + band) * 4 + 3], pixels[(y * w + (w - 1 - band)) * 4 + 3]);
        }
        worst.poses++;
        if (top > worst.alpha) { worst.alpha = top; worst.pose = name; }
      };
      const looks = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
      const phases = Array.from({length: 21}, (_, i) => i / 20);
      for (const hover of [false, true]) {
        for (const [lx, ly] of looks) {
          const base = {hover, lookX: lx, lookY: ly, smoothX: lx, smoothY: ly, grow: hover ? 1.13 : 1, hop: -1, fly: -1, wave: -1};
          for (const t of [0, 0.9, 1.9, 2.8, 3.7, 4.6]) { Object.assign(state, base, {t}); draw(`rest hover=${hover} look=${lx},${ly} t=${t}`); }
          for (const p of phases) {
            Object.assign(state, base, {t: p * 6, hop: p - 0.016 / 0.95}); draw(`hop ${p} hover=${hover} look=${lx},${ly}`);
            Object.assign(state, base, {t: p * 6, wave: p - 0.016 / 0.95}); draw(`wave ${p} hover=${hover} look=${lx},${ly}`);
            Object.assign(state, base, {t: p * 6, fly: p - 0.016 / 0.62}); draw(`fly ${p} hover=${hover} look=${lx},${ly}`);
          }
        }
      }
      Object.assign(state, saved);
      drawOnce();
      return worst;
    },
    dispose() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      scene.traverse(node => { if (node.isMesh) { node.geometry.dispose(); for (const m of [].concat(node.material)) { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); m.dispose(); } } });
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
