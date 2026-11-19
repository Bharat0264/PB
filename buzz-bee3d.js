/* The 3D bee for the Buzz support button. Loaded on demand by buzz-chat.js (never on the portals for staff).
 *
 * The model is /buzz-bee.glb: your Bee.glb, simplified for the web (about 19,000 triangles and 512 px textures, 0.8 MB instead of 58 MB).
 * It is one solid mesh without a skeleton or animation clips, so the wings cannot flap on their own. Everything you see move is done
 * here: a float, a left-right tilt, a tiny squash and stretch, an occasional attention hop, a look-at-the-cursor on hover and a
 * fly-around when it is clicked. The loop runs at 30 frames a second when the bee is just floating and only goes faster during a hop,
 * a hover or a click. It stops while the tab is hidden or the bee is not shown, and with "reduce motion" it draws one still picture.
 */
import * as THREE from '/vendor/three/three.module.js';
import {GLTFLoader} from '/vendor/three/GLTFLoader.js';
import {RoomEnvironment} from '/vendor/three/RoomEnvironment.js';

const MODEL = '/buzz-bee.glb?v=1';
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
  scene.environmentIntensity = 0.75;
  room.dispose();
  const key = new THREE.DirectionalLight(0xfff3dc, 1.35);
  key.position.set(1.6, 2.4, 2.6);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xffe2a0, 0.55));

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  camera.position.set(0, 0.05, BASE_DISTANCE);
  camera.lookAt(0, 0, 0);

  const gltf = await new GLTFLoader().loadAsync(MODEL);
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  model.position.sub(centre);
  const fit = 1.78 / Math.max(size.x, size.y, size.z);
  const pivot = new THREE.Group();                      // everything that moves (float, tilt, squash) moves this
  const holder = new THREE.Group();                     // and this one turns the bee to face the camera
  holder.rotation.y = FACE_YAW;
  holder.add(model);
  pivot.add(holder);
  pivot.scale.setScalar(fit);
  scene.add(pivot);
  model.traverse(node => { if (node.isMesh) { node.frustumCulled = false; } });

  let width = 0, height = 0;
  function resize() {
    const w = canvas.clientWidth || 96, h = canvas.clientHeight || 96;
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // The canvas is 32 px bigger than the bee's box (16 px of room on every side), so a hop or a flying loop is never cut off at the edge.
    // Pull the camera back by the same ratio and the bee stays exactly the size it was.
    camera.position.z = BASE_DISTANCE * h / Math.max(60, h - 32);
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
    pivot.position.y = y;
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
    dispose() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      scene.traverse(node => { if (node.isMesh) { node.geometry.dispose(); for (const m of [].concat(node.material)) { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); m.dispose(); } } });
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
