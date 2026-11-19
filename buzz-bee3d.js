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

const MODEL = '/bee_hq.glb?v=1';                     // the improved model: smooth seam normals, four parts (body, eyes, wings, bubble), 2048 px WebP textures
const FALLBACK_MODEL = '/buzz-bee.glb?v=1';           // the original, used if the improved one cannot be loaded (it is never changed)
const CLAY_TEXTURE = '/buzz-bee-clay.webp?v=3';       // the original model's colour picture (only used with the fallback model)

// Every look value in one place. Change a number here and reload: nothing else needs touching.
// Material names match the four parts of bee_hq.glb. Values follow three.js MeshPhysicalMaterial.
export const BEE_LOOK = {
  render: {
    toneMapping: 'ACESFilmic',              // 'ACESFilmic' | 'AgX' | 'Neutral' | 'None'
    exposure: 0.98,                         // ACES darkens and shifts colour a little: this, the light, and each material's mapGlow keep the bee's colours as they were
    environment: 'studio',                  // the soft studio room that ships with three.js (RoomEnvironment), blurred like a studio HDRI
    environmentBlur: 0.04,
    environmentIntensity: 0.3,
    anisotropy: 'max',                      // 'max' or a number: keeps the texture sharp when the bee turns
    keyLight: {color: 0xfff1d6, intensity: 1.0, position: [1.6, 2.4, 2.6]},
    rimLight: {color: 0xffe3a8, intensity: 0.45, position: [-2.2, 1.2, -2]},
    fill: {sky: 0xfffaf0, ground: 0xffdca0, intensity: 0.68},
    normalScale: 0.6,
  },
  fallback: {roughness: 0.78, clearcoat: 0, sheen: 0.6, transmission: 0},     // the matte clay look used only if bee_hq.glb cannot load and the original model is shown
  materials: {
    body: {                                  // head, headphones, body, arms, stripes, antennae
      roughness: 0.35, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.45,
      sheen: 0.12, sheenRoughness: 0.5, sheenColor: 0xffc23a, envMapIntensity: 0.6, mapGlow: 0.3,
    },
    eyes: {                                  // glossy black with crisp white highlights
      roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
      specularIntensity: 1, envMapIntensity: 1.2, mapGlow: 0,
    },
    wings: {                                 // see-through, a little thick, glassy
      roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15,
      transmission: 0.55, thickness: 0.18, ior: 1.4, attenuationColor: 0xfff4dc, attenuationDistance: 0.6,
      sheen: 0.05, sheenColor: 0xffffff, sheenRoughness: 0.4, envMapIntensity: 1.0, mapGlow: 0.25, doubleSided: true,
    },
    bubble: {                                // soft glossy white
      roughness: 0.3, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.2,
      sheen: 0.1, sheenRoughness: 0.5, sheenColor: 0xffffff, envMapIntensity: 0.45, mapGlow: 0.62,   // mapGlow: how much of the picture's own colour is added back as light, so ACES and the gloss do not wash it out
    },
  },
};
const TONE_MAPPING = {ACESFilmic: THREE.ACESFilmicToneMapping, AgX: THREE.AgXToneMapping, Neutral: THREE.NeutralToneMapping, None: THREE.NoToneMapping};
const FIT = 1.62;                      // the bee's longest side, in world units (the view is 1.985 units tall for the button's box): leaves room to hop and spin
const FACE_YAW = 0;                    // turn the model so it looks at the customer (set after checking the model's orientation)
const IDLE_FPS = 30;
const BASE_DISTANCE = 4.3;             // how far the camera sits when the canvas is exactly the size of the bee's box
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const ease = t => 1 - Math.pow(1 - t, 3);

const FLOAT_RATE = (2 * Math.PI) / 3;  // one slow float up and down every 3 seconds

// options: reducedMotion (draw one still picture), onFrame(lift) (called every drawn frame with how high the bee is, -0.3 to 1, so the
// shadow under it can squash and fade in time), and, only when making the still pictures: exact (the canvas IS the bee's box), pixelRatio
// and scale (make the bee a little smaller so no pose touches the edge of its picture).
export async function createBee(canvas, {reducedMotion = false, exact = false, pixelRatio = null, onFrame = null, scale = 1} = {}) {
  const renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true, powerPreference: 'default'});
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(pixelRatio || Math.min(Math.max((window.devicePixelRatio || 1) * 1.5, 2), 3));   // drawn 1.5x bigger than the screen needs, then shrunk by the browser: smooth, sharp edges
  renderer.toneMapping = TONE_MAPPING[BEE_LOOK.render.toneMapping] ?? THREE.NoToneMapping;
  renderer.toneMappingExposure = BEE_LOOK.render.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, BEE_LOOK.render.environmentBlur).texture;
  scene.environmentIntensity = BEE_LOOK.render.environmentIntensity;
  room.dispose();
  // soft, even light like a clay render: a gentle warm key, a strong sky/ground fill and a faint rim from behind
  const L = BEE_LOOK.render;
  const key = new THREE.DirectionalLight(L.keyLight.color, L.keyLight.intensity);
  key.position.set(...L.keyLight.position);
  const rim = new THREE.DirectionalLight(L.rimLight.color, L.rimLight.intensity);
  rim.position.set(...L.rimLight.position);
  scene.add(key, rim, new THREE.HemisphereLight(L.fill.sky, L.fill.ground, L.fill.intensity));

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  camera.position.set(0, 0.05, BASE_DISTANCE);
  camera.lookAt(0, 0, 0);

  let gltf, clay = null, hq = true;
  try { gltf = await new GLTFLoader().loadAsync(MODEL); }
  catch {                                                      // no improved model: the original, with the clay colour picture
    hq = false;
    [gltf, clay] = await Promise.all([new GLTFLoader().loadAsync(FALLBACK_MODEL), new THREE.TextureLoader().loadAsync(CLAY_TEXTURE).catch(() => null)]);
  }
  const model = gltf.scene;
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const anisotropy = L.anisotropy === 'max' ? maxAnisotropy : Math.min(maxAnisotropy, Number(L.anisotropy) || 1);
  if (clay) { clay.flipY = false; clay.colorSpace = THREE.SRGBColorSpace; }
  model.traverse(node => {
    if (!node.isMesh) return;
    const original = node.material;
    const look = {...(BEE_LOOK.materials[original.name] || BEE_LOOK.materials.body)};   // the original model has one material: it gets the body look
    const {doubleSided = false, mapGlow = 0, ...values} = look;
    for (const key of ['color', 'sheenColor', 'attenuationColor']) if (key in values) values[key] = new THREE.Color(values[key]);
    const map = clay || original.map;
    for (const texture of [map, original.normalMap]) if (texture) texture.anisotropy = anisotropy;
    node.material = new THREE.MeshPhysicalMaterial({
      ...values, map, normalMap: original.normalMap, normalScale: new THREE.Vector2(L.normalScale, L.normalScale),
      side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      ...(mapGlow ? {emissive: new THREE.Color(0xffffff), emissiveMap: map, emissiveIntensity: mapGlow} : {}),
    });
    if (hq === false) Object.assign(node.material, BEE_LOOK.fallback);          // the original look, matte clay
    if (clay && original.map) original.map.dispose();
    for (const key of ['roughnessMap', 'metalnessMap', 'aoMap']) if (original[key]) original[key].dispose();
    original.dispose();
  });
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  model.position.sub(centre);
  const fit = (FIT * scale) / Math.max(size.x, size.y, size.z);
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
    if (exact) { camera.position.z = BASE_DISTANCE; baseY = 0; camera.updateProjectionMatrix(); return; }
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

    let y = Math.sin(t * FLOAT_RATE) * 0.05;                         // float (a 3 second loop)
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
    if (onFrame) onFrame(clamp(y / 0.22, -0.3, 1));
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
    // For making the still pictures (see tools/): draws one fixed pose at the canvas size. idle = the resting frame, wave = the hover
    // hello, typing = leaning in toward the chat. All three use the same camera and anchor, so swapping between them never jumps or clips.
    exportPose(kind) {
      const rest = {t: 0.6, hover: false, lookX: 0, lookY: 0, smoothX: 0, smoothY: 0, grow: 1, hop: -1, fly: -1, wave: -1};
      const poses = {
        idle: rest,
        wave: {...rest, hover: true, grow: 1.08, lookX: 0.4, lookY: -0.2, smoothX: 0.4, smoothY: -0.2, wave: 0.13 - 0.016 / 0.95},
        typing: {...rest, grow: 1, lookX: 0.3, lookY: 0.3, smoothX: 0.3, smoothY: 0.3},
      };
      Object.assign(state, poses[kind] || rest);
      resize();
      pose(0.016);
      renderer.render(scene, camera);
      return kind;
    },
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
