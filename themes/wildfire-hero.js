/* Wildfire hero: the cinematic title scene.
   The emblem (the supplied 3D model, reduced for the web) sits behind; the PrintBee title, extruded from the brand wordmark
   outlines, sits in front of it. Warm key light, orange rim, red fill, soft shadows, a dark forest tunnel behind, drifting
   smoke and rising embers (drawn from the supplied ember model's pictures). A short reveal plays once, then the scene idles.

   mountHero(host, options) -> {destroy()}   host: an element that already has the poster picture as its background.
   options: {capture: true}  keep the drawing buffer so a still can be saved (lab use)
            {still: true}    draw the final composition once, no animation (reduced motion, stills)
   Everything is disposed in destroy(). Large assets are fetched here, never at page load. */
import * as THREE from '/vendor/three/three.module.js';
import {GLTFLoader} from '/vendor/three/GLTFLoader.js';
import {TITLE} from './wildfire-title.js';

const MODEL = '/models/wildfire/emblem.glb?v=1';
const ATLAS = '/themes/img/wf-embers.webp?v=1';
const ATLAS_GRID = 5;
const ease = {
  out3: t => 1 - Math.pow(1 - t, 3),
  out4: t => 1 - Math.pow(1 - t, 4),
  inOut: t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: t => { const c = 1.35; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};
const clamp01 = v => Math.min(1, Math.max(0, v));
const span = (t, a, b) => clamp01((t - a) / (b - a));

// ---------- procedural pictures (small canvases, made once) ----------
function noiseCanvas(size, seed, scales) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(size, size);
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const layers = scales.map(scale => {
    const n = Math.ceil(size / scale) + 2, grid = Float32Array.from({length: n * n}, rand);
    return {scale, n, grid};
  });
  const sample = ({scale, n, grid}, x, y) => {
    const gx = x / scale, gy = y / scale, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (a, b) => grid[((iy + b) % n) * n + ((ix + a) % n)];
    return (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, amp = 1, total = 0;
    for (const layer of layers) { v += sample(layer, x, y) * amp; total += amp; amp *= .5; }
    const i = (y * size + x) * 4;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = Math.round((v / total) * 255);
    data.data[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

function smokeTexture() {
  const size = 256, noise = noiseCanvas(size, 77, [64, 32, 16, 8]).getContext('2d').getImageData(0, 0, size, size).data;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'), out = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x / size - .5) * 2, dy = (y / size - .5) * 2, fall = Math.max(0, 1 - Math.hypot(dx, dy));
    const i = (y * size + x) * 4, n = noise[i] / 255;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = 255;
    out.data[i + 3] = Math.round(255 * Math.pow(fall, 1.4) * Math.pow(n, 1.6) * 1.9);
  }
  ctx.putImageData(out, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function pineTexture(seed, tall) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  ctx.fillStyle = '#000';
  for (let x = -20; x < 1044; x += 20 + rand() * 26) {
    const h = (tall ? 140 : 90) + rand() * (tall ? 110 : 70), w = h * (.3 + rand() * .12);
    for (let tier = 0; tier < 5; tier++) {
      const top = 256 - h + tier * h * .17, base = 256 - h * .18 + tier * h * .03 - (4 - tier) * 0, half = w * (.3 + .7 * (tier + 1) / 5) / 2;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + half, Math.min(256, base + h * .1)); ctx.lineTo(x - half, Math.min(256, base + h * .1)); ctx.fill();
    }
    ctx.fillRect(x - 2, 256 - h * .14, 4, h * .14);
  }
  ctx.fillRect(0, 248, 1024, 8);
  const soft = document.createElement('canvas');
  soft.width = 1024; soft.height = 256;
  const sctx = soft.getContext('2d');
  sctx.filter = tall ? 'blur(3px)' : 'blur(1.4px)';
  sctx.drawImage(canvas, 0, 0);
  const texture = new THREE.CanvasTexture(soft);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// The carved, burnt-orange wood for the title face: grain, engraved ornament lines, scratches. Returns colour + height maps.
function carvedWood() {
  const size = 1024, colour = document.createElement('canvas'), height = document.createElement('canvas');
  colour.width = colour.height = height.width = height.height = size;
  const c = colour.getContext('2d'), h = height.getContext('2d');
  const grain = noiseCanvas(size, 4242, [160, 40, 12, 5]).getContext('2d').getImageData(0, 0, size, size).data;
  const out = c.createImageData(size, size), hout = h.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const stretch = grain[((Math.floor(y / 5) * 5 * size + x) * 4)] / 255;           // streaks along the grain
    const fine = grain[(((y * 7) % size) * size + x) * 4] / 255;
    const t = .45 * stretch + .55 * fine;
    // burnt orange body, darker in the grain valleys
    out.data[i] = 150 + t * 100; out.data[i + 1] = 50 + t * 52; out.data[i + 2] = 12 + t * 18; out.data[i + 3] = 255;
    const v = 90 + t * 120;
    hout.data[i] = hout.data[i + 1] = hout.data[i + 2] = v; hout.data[i + 3] = 255;
  }
  c.putImageData(out, 0, 0); h.putImageData(hout, 0, 0);
  let s = 99;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const stroke = (ctx, style, width, draw) => { ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath(); draw(ctx); ctx.stroke(); };
  // engraved ornament: parallel chisel lines and small scrolls
  for (let k = 0; k < 26; k++) {
    const y0 = rand() * size, x0 = rand() * size, len = 90 + rand() * 260, bend = (rand() - .5) * 80;
    stroke(c, 'rgba(46,14,4,.7)', 2 + rand() * 2, ctx => { ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x0 + len / 2, y0 + bend, x0 + len, y0 + bend * .2); });
    stroke(h, 'rgba(10,10,10,.95)', 3 + rand() * 2, ctx => { ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x0 + len / 2, y0 + bend, x0 + len, y0 + bend * .2); });
    stroke(c, 'rgba(255,170,90,.28)', 1.2, ctx => { ctx.moveTo(x0, y0 + 3); ctx.quadraticCurveTo(x0 + len / 2, y0 + bend + 3, x0 + len, y0 + bend * .2 + 3); });
  }
  for (let k = 0; k < 18; k++) {                                     // scrolls
    const x0 = rand() * size, y0 = rand() * size, r = 14 + rand() * 24;
    for (const [ctx, style, w] of [[c, 'rgba(52,16,5,.65)', 2.4], [h, 'rgba(8,8,8,.9)', 3.4]]) {
      stroke(ctx, style, w, p => { for (let a = 0; a < 9; a += .25) p.lineTo(x0 + Math.cos(a) * (r - a * 1.4), y0 + Math.sin(a) * (r - a * 1.4)); });
    }
  }
  for (let k = 0; k < 90; k++) {                                     // scratches
    const x0 = rand() * size, y0 = rand() * size, a = (rand() - .5) * .7, len = 30 + rand() * 120;
    stroke(c, 'rgba(255,214,160,.16)', 1, p => { p.moveTo(x0, y0); p.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len); });
    stroke(h, 'rgba(30,30,30,.7)', 1.2, p => { p.moveTo(x0, y0); p.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len); });
  }
  const map = new THREE.CanvasTexture(colour), bump = new THREE.CanvasTexture(height);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const t of [map, bump]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; }
  return {map, bump};
}

// ---------- the title: extruded outlines ----------
function titleGeometry(depth, bevel, grow = 0) {
  const scale = 1 / TITLE.unitsPerEm;
  let cursor = 0;
  const faces = [], sides = [];
  for (const glyph of TITLE.glyphs) {
    const shapes = glyph.shapes.map(({outer, holes}) => {
      const toPoints = flat => { const pts = []; for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(flat[i], flat[i + 1])); return pts; };
      const shape = new THREE.Shape(toPoints(outer));
      shape.holes = holes.map(h => new THREE.Path(toPoints(h)));
      return shape;
    });
    const geometry = new THREE.ExtrudeGeometry(shapes, {depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * (.8 + grow), bevelSegments: 5, curveSegments: 1, steps: 1});
    geometry.scale(scale, scale, scale);
    geometry.translate(cursor * scale, 0, 0);
    faces.push({geometry, cursor});
    cursor += glyph.advance + 6;
  }
  return {parts: faces, width: cursor * scale};
}

export function mountHero(host, options = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const still = options.still || reduced;
  const coarse = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
  const played = (() => { try { return sessionStorage.getItem('wf-intro') === '1'; } catch { return false; } })();
  const speed = played ? 2.6 : 1;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: Boolean(options.capture)});
  } catch (error) {
    host.classList.add('wf-static');
    return {destroy() {}};
  }
  const dpr = Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'wf-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0c0a09');
  scene.fog = new THREE.FogExp2('#0c0907', .035);
  const camera = new THREE.PerspectiveCamera(32, 1, .1, 60);
  const disposables = [];
  const track = item => { disposables.push(item); return item; };

  // Warm studio for the metal: a dark room with a golden softbox, an orange strip and a red kicker. Reflections only.
  {
    const room = new THREE.Scene();
    room.add(new THREE.Mesh(track(new THREE.SphereGeometry(20, 24, 12)), track(new THREE.MeshBasicMaterial({color: '#0b0706', side: THREE.BackSide}))));
    const panel = (color, w, h, pos, look, intensity) => {
      const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), track(new THREE.MeshBasicMaterial({color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide})));
      mesh.position.set(...pos); mesh.lookAt(...look); room.add(mesh);
    };
    panel('#ffd9a0', 8, 5, [-6, 7, 6], [0, 0, 0], 9);
    panel('#ff6a1f', 2, 10, [8, 1, -4], [0, 0, 0], 12);
    panel('#b3201a', 9, 2, [0, -6, 4], [0, 0, 0], 5);
    panel('#ffc678', 3, 3, [4, 5, 8], [0, 0, 0], 4);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(room, .035).texture;
    track(scene.environment);
    pmrem.dispose();
  }

  // ----- lights -----
  const key = new THREE.DirectionalLight('#ffd7a0', 3.4);
  key.position.set(-3.2, 4.2, 6.5);
  key.castShadow = true;
  key.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  Object.assign(key.shadow.camera, {left: -4, right: 4, top: 4, bottom: -4, near: .5, far: 20});
  key.shadow.radius = 5; key.shadow.bias = -.0004; key.shadow.normalBias = .03;
  const rim = new THREE.DirectionalLight('#ff6a1f', 4.2); rim.position.set(5, 1.8, -3.5);
  const rimLeft = new THREE.DirectionalLight('#ff8a3d', 1.6); rimLeft.position.set(-5, 2.5, -3);
  const fill = new THREE.PointLight('#b3201a', 14, 14, 1.8); fill.position.set(-2.4, -2.6, 3.2);
  const glowBack = new THREE.PointLight('#ff5a1f', 0, 12, 1.6); glowBack.position.set(0, .2, -1.6);
  const hemi = new THREE.HemisphereLight('#ffe2bd', '#1a0805', .35);
  scene.add(key, key.target, rim, rimLeft, fill, glowBack, hemi);

  // ----- the dark tunnel behind everything -----
  const backdrop = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), track(new THREE.ShaderMaterial({
    depthWrite: false, fog: false,
    uniforms: {uTime: {value: 0}, uGlow: {value: 0}, uBeam: {value: 0}, uAspect: {value: 1.6}, uImpact: {value: 0}},
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uTime, uGlow, uBeam, uAspect, uImpact;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        vec2 p = (vUv - vec2(.5, .47)) * vec2(uAspect, 1.0);
        float r = length(p);
        vec3 base = mix(vec3(.026,.021,.018), vec3(.012,.021,.016), smoothstep(.2, 1.1, r));     // charcoal with a forest tint at the edges
        float rings = pow(abs(sin(r * 15.0 - .4)), 28.0) * smoothstep(1.3, .25, r);              // circular architectural depth
        float ribs = pow(abs(sin(atan(p.y, p.x) * 12.0)), 60.0) * smoothstep(1.2, .3, r) * .5;
        vec3 col = base + vec3(.20,.065,.035) * rings * .16 * (.4 + uGlow) + vec3(.2,.08,.05) * ribs * .07 * uGlow;
        float halo = exp(-r * 2.1);
        col += vec3(.52,.14,.055) * halo * (.05 + .30 * uGlow) + vec3(.9,.38,.12) * exp(-r * 6.0) * .20 * uGlow;
        float beamW = mix(.02, .26, uBeam);
        col += vec3(1.0,.62,.30) * exp(-pow(p.x / beamW, 2.0)) * smoothstep(.9, 0., abs(p.y)) * .22 * uBeam * (1.0 - uGlow * .6);
        col += vec3(.7,.25,.08) * uImpact * exp(-r * 3.0) * .5;
        col *= smoothstep(1.35, .35, r) * .85 + .15;                                              // vignette
        col += (hash(vUv * 900.0 + uTime) - .5) * .012;                                            // film grain
        gl_FragColor = vec4(col, 1.0);
      }`,
  })));
  backdrop.position.z = -9;
  backdrop.renderOrder = -10;
  scene.add(backdrop);

  const forest = [];
  for (const [seed, z, tall, opacity, y] of [[7, -6.4, true, .6, -2.5], [19, -4.2, false, .85, -2.95]]) {
    const texture = track(pineTexture(seed, tall));
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), track(new THREE.MeshBasicMaterial({map: texture, transparent: true, opacity, depthWrite: false, color: '#050605', fog: false})));
    mesh.position.set(0, y, z); scene.add(mesh); forest.push({mesh, texture, baseY: y});
  }

  // ----- smoke -----
  const smokeMap = track(smokeTexture());
  const smoke = [];
  for (let i = 0; i < (coarse ? 4 : 7); i++) {
    const warm = i % 3 === 0;
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), track(new THREE.MeshBasicMaterial({
      map: smokeMap, transparent: true, depthWrite: false, opacity: 0, fog: false,
      color: warm ? '#ff7a35' : '#8c7a6a', blending: warm ? THREE.AdditiveBlending : THREE.NormalBlending,
    })));
    const z = -5 + i * 1.1;
    mesh.position.set((i - 3) * 1.4, -1.4 + (i % 3) * .9, z);
    mesh.scale.setScalar(6 + (i % 4) * 1.4);
    mesh.userData = {base: warm ? .05 : .1, spin: (i % 2 ? 1 : -1) * (.01 + i * .002), drift: .08 + i * .015, phase: i * 1.7};
    scene.add(mesh); smoke.push(mesh);
  }

  // ----- embers: the supplied ember pictures as sprites, plus fine sparks -----
  const emberCount = coarse ? 22 : 52, sparkCount = coarse ? 36 : 110;
  const emberGeometry = track(new THREE.BufferGeometry());
  const emberPos = new Float32Array(emberCount * 3), emberCell = new Float32Array(emberCount * 2), emberSize = new Float32Array(emberCount), emberSeed = new Float32Array(emberCount);
  const embers = [];
  const spawn = (list, i, spread, initial) => {
    const e = list[i] || (list[i] = {});
    e.x = (Math.random() - .5) * spread.x; e.y = initial ? (Math.random() - .5) * spread.y : -spread.y / 2 - Math.random() * .8;
    e.z = -2.5 + Math.random() * 6.2; e.speed = .16 + Math.random() * .38; e.sway = .15 + Math.random() * .5; e.phase = Math.random() * 6.28;
    e.rate = .5 + Math.random() * 1.2; e.life = Math.random(); return e;
  };
  const spread = {x: 11, y: 7.4};
  for (let i = 0; i < emberCount; i++) {
    spawn(embers, i, spread, true);
    const cell = Math.floor(Math.random() * 24);
    emberCell.set([cell % ATLAS_GRID, Math.floor(cell / ATLAS_GRID)], i * 2);
    emberSize[i] = .07 + Math.random() * .17 + (embers[i].z > 1.8 ? .06 : 0);
    emberSeed[i] = Math.random() * 100;
  }
  emberGeometry.setAttribute('position', new THREE.BufferAttribute(emberPos, 3).setUsage(THREE.DynamicDrawUsage));
  emberGeometry.setAttribute('aCell', new THREE.BufferAttribute(emberCell, 2));
  emberGeometry.setAttribute('aSize', new THREE.BufferAttribute(emberSize, 1));
  emberGeometry.setAttribute('aSeed', new THREE.BufferAttribute(emberSeed, 1));
  const atlas = track(new THREE.TextureLoader().load(ATLAS, () => { if (still) frame(0); }));
  atlas.colorSpace = THREE.SRGBColorSpace;
  const emberMaterial = track(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {uAtlas: {value: atlas}, uGrid: {value: ATLAS_GRID}, uTime: {value: 0}, uFade: {value: 0}, uScale: {value: 600}},
    vertexShader: `attribute vec2 aCell; attribute float aSize, aSeed; uniform float uScale, uTime; varying vec2 vCell; varying float vSeed; varying float vDepth;
      void main(){ vCell = aCell; vSeed = aSeed; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = clamp(-mv.z / 12.0, 0.0, 1.0);
        gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D uAtlas; uniform float uGrid, uTime, uFade; varying vec2 vCell; varying float vSeed, vDepth;
      void main(){
        vec2 uv = (vCell + vec2(gl_PointCoord.x, gl_PointCoord.y)) / uGrid;
        vec4 t = texture2D(uAtlas, uv);
        float flick = .75 + .25 * sin(uTime * (3.0 + vSeed * .07) + vSeed);
        float a = t.a * flick * uFade;
        if (a < .02) discard;
        gl_FragColor = vec4(t.rgb * (.7 + flick * .4) * vec3(1.0, .72, .5), a * .62);
      }`,
  }));
  const emberPoints = new THREE.Points(emberGeometry, emberMaterial);
  emberPoints.frustumCulled = false;
  scene.add(emberPoints);

  const sparks = [];
  const sparkGeometry = track(new THREE.BufferGeometry());
  const sparkPos = new Float32Array(sparkCount * 3), sparkSize = new Float32Array(sparkCount);
  for (let i = 0; i < sparkCount; i++) { spawn(sparks, i, spread, true); sparkSize[i] = .025 + Math.random() * .05; }
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setAttribute('aSize', new THREE.BufferAttribute(sparkSize, 1));
  const sparkMaterial = track(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {uFade: {value: 0}, uScale: {value: 600}},
    vertexShader: 'attribute float aSize; uniform float uScale; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uFade; void main(){ float d = length(gl_PointCoord - .5) * 2.0; float a = pow(max(0.0, 1.0 - d), 2.0) * uFade; if (a < .02) discard; gl_FragColor = vec4(1.0, .62, .26, a * .8); }',
  }));
  const sparkPoints = new THREE.Points(sparkGeometry, sparkMaterial);
  sparkPoints.frustumCulled = false;
  scene.add(sparkPoints);

  // ----- the emblem (behind) and the title (in front) -----
  const stage = new THREE.Group();
  const emblem = new THREE.Group();
  const title = new THREE.Group();
  stage.add(emblem, title);
  scene.add(stage);
  let emblemReady = false;

  const wood = carvedWood();
  track(wood.map); track(wood.bump);
  const faceMaterial = track(new THREE.MeshPhysicalMaterial({
    map: wood.map, bumpMap: wood.bump, bumpScale: 5.5, color: '#ff9c62', roughness: .46, metalness: .12,
    clearcoat: .45, clearcoatRoughness: .38, envMapIntensity: 1.25, emissive: '#6a1d05', emissiveIntensity: .3,
  }));
  wood.map.repeat.set(1 / 1100, 1 / 1100); wood.bump.repeat.copy(wood.map.repeat);
  const edgeMaterial = track(new THREE.MeshPhysicalMaterial({color: '#d49a46', metalness: .95, roughness: .26, envMapIntensity: 1.8, clearcoat: .3}));
  const outlineMaterial = track(new THREE.MeshStandardMaterial({color: '#150805', roughness: .85, metalness: .1}));

  const built = titleGeometry(150, 34);
  const outline = titleGeometry(60, 34, .9);
  const letters = [];
  const titleWidth = built.width;
  built.parts.forEach((part, index) => {
    const group = new THREE.Group();
    const solid = new THREE.Mesh(part.geometry, [faceMaterial, edgeMaterial]);
    solid.castShadow = true; solid.receiveShadow = true;
    const back = new THREE.Mesh(outline.parts[index].geometry, outlineMaterial);
    back.position.z = -.03; back.castShadow = true;
    group.add(back, solid);
    group.position.x = -titleWidth / 2;
    title.add(group);
    letters.push(group);
    track(part.geometry); track(outline.parts[index].geometry);
  });
  // centre vertically on the x-height and make the title tall and bold
  const lift = new THREE.Box3().setFromObject(title);
  const titleCenter = lift.getCenter(new THREE.Vector3());
  title.children.forEach(child => { child.position.y -= titleCenter.y; });
  const TITLE_SCALE = 4.5 / titleWidth;
  title.scale.setScalar(TITLE_SCALE);

  new GLTFLoader().load(MODEL, gltf => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.traverse(object => {
      if (!object.isMesh) return;
      object.castShadow = true; object.receiveShadow = true;
      object.material.envMapIntensity = 1.5;
      object.material.roughness = Math.min(1, (object.material.roughness ?? 1) * .92);
      track(object.geometry); track(object.material);
      for (const key of ['map', 'metalnessMap', 'normalMap']) if (object.material[key]) track(object.material[key]);
    });
    const holder = new THREE.Group();
    holder.add(model);
    holder.scale.setScalar(3.45 / size.y);
    emblem.add(holder);
    emblemReady = true;
    host.classList.add('wf-loaded');
    if (still) frame(0);
  }, undefined, () => { host.classList.add('wf-static'); });

  // ----- layout: portrait phones get a farther camera so the complete title always fits -----
  const final = {camZ: 8, camY: .08, drop: 0, titleZ: .72, titleRot: .15};
  let width = 1, height = 1;
  function resize() {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width)); height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const fovTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const needWide = 5.9, needTall = 5.1;                                  // world size that must stay visible at the emblem
    final.camZ = Math.max(needTall / (2 * fovTan), needWide / (camera.aspect * 2 * fovTan));
    // the scene sits a little above centre so the copy under it never covers the emblem or the title
    final.drop = (camera.aspect > .9 ? .125 : .05) * 2 * fovTan * final.camZ;
    camera.updateProjectionMatrix();
    const viewH = 2 * fovTan * (final.camZ + 9) * 1.15;
    backdrop.scale.set(viewH * camera.aspect * 1.2, viewH, 1);
    backdrop.material.uniforms.uAspect.value = camera.aspect;
    for (const f of forest) { f.mesh.scale.set(viewH * camera.aspect * 1.6, Math.min(viewH * .26, 4.4), 1); f.texture.repeat.set(Math.max(1.5, camera.aspect * 1.5), 1); }
    const px = height * dpr / (2 * fovTan);
    emberMaterial.uniforms.uScale.value = px; sparkMaterial.uniforms.uScale.value = px;
    if (still) frame(0);
  }

  // ----- the timeline -----
  const state = {t: 0, mx: 0, my: 0, smx: 0, smy: 0, scroll: 0, impact: 0, impacted: false, burst: 0, running: false, visible: true};
  const clock = new THREE.Clock();
  const dummy = new THREE.Vector3();

  function updateParticles(dt, fade, t) {
    const speedFactor = still ? 0 : 1;
    for (let i = 0; i < emberCount; i++) {
      const e = embers[i];
      e.y += e.speed * dt * speedFactor * (1 + state.burst * 1.4); e.phase += e.rate * dt * speedFactor;
      if (e.y > spread.y / 2 + .5) spawn(embers, i, spread, false);
      emberPos[i * 3] = e.x + Math.sin(e.phase) * e.sway; emberPos[i * 3 + 1] = e.y; emberPos[i * 3 + 2] = e.z;
    }
    for (let i = 0; i < sparkCount; i++) {
      const e = sparks[i];
      e.y += e.speed * 1.5 * dt * speedFactor; e.phase += e.rate * 1.3 * dt * speedFactor;
      if (e.y > spread.y / 2 + .5) spawn(sparks, i, spread, false);
      sparkPos[i * 3] = e.x + Math.sin(e.phase) * e.sway * 1.4; sparkPos[i * 3 + 1] = e.y; sparkPos[i * 3 + 2] = e.z;
    }
    emberGeometry.attributes.position.needsUpdate = true; sparkGeometry.attributes.position.needsUpdate = true;
    emberMaterial.uniforms.uTime.value = t; emberMaterial.uniforms.uFade.value = fade * .85; sparkMaterial.uniforms.uFade.value = fade;
  }

  function frame(dt) {
    const t = still ? 99 : state.t;
    const T = still ? 1 : speed;
    const s = still ? 99 : t * T;                                             // timeline seconds
    const embersIn = span(s, .15, 1.4), smokeIn = span(s, .9, 2.6), beam = span(s, 1.0, 2.2);
    const lightIn = ease.inOut(span(s, 1.7, 3.5)), push = ease.out3(span(s, 0, 4.9));
    const slam = ease.back(span(s, 3.4, 4.4));
    const idle = still ? 0 : Math.max(0, s - 4.4);

    // camera push-in, parallax, scroll
    state.smx += (state.mx - state.smx) * (1 - Math.exp(-dt * 4.2)); state.smy += (state.my - state.smy) * (1 - Math.exp(-dt * 4.2));
    const kick = state.impact * Math.sin(s * 38) * .018;
    camera.position.set(state.smx * .42, final.camY - final.drop + state.smy * .22 + kick + state.scroll * .5, final.camZ + (1 - push) * 1.35 + state.scroll * 1.8);
    camera.lookAt(state.smx * .06, .05 - final.drop + state.scroll * .3, 0);

    // emblem: emerges, then breathes; leans a little toward the pointer
    const em = ease.out3(span(s, 1.7, 4.2));
    emblem.scale.setScalar(.9 + .1 * em);
    emblem.position.set(0, Math.sin(idle * .55) * .035, -.25 * (1 - em) - .05);
    emblem.rotation.set(-state.smy * .045, -state.smx * .1 + Math.sin(idle * .3) * .012, 0);

    // title: flies in from the camera side, lands with a tiny rebound, letters one after another
    const base = final.titleZ;
    letters.forEach((letter, index) => {
      const local = ease.back(span(s, 3.35 + index * .05, 4.35 + index * .05));
      letter.position.z = (1 - local) * 3.4 / TITLE_SCALE * .55;
      letter.visible = s > 3.25 + index * .05;
      letter.rotation.z = (1 - local) * (index % 2 ? .06 : -.06);
    });
    title.position.set(state.smx * -.05, -.08 + Math.sin(idle * .7) * .012, base);
    title.rotation.set(-state.smy * .02, -.1 - state.smx * .06, final.titleRot + Math.sin(idle * .35) * .004);

    // impact flash when the title lands
    if (!still && !state.impacted && s >= 4.28) { state.impacted = true; state.impact = 1; state.burst = 1; try { sessionStorage.setItem('wf-intro', '1'); } catch { /* storage may be blocked */ } }
    state.impact = Math.max(0, state.impact - dt * 1.1); state.burst = Math.max(0, state.burst - dt * .9);
    const flicker = still ? 1 : .94 + .06 * Math.sin(t * 9.1) * Math.sin(t * 3.7);
    const gain = (still ? 1 : lightIn) * flicker;
    const flare = 1 + state.impact * 1.6;
    // lights follow the pointer and glide slowly so the metal catches changing highlights
    const sweep = still ? 0 : Math.sin(idle * .45);
    key.position.set(-3.2 + state.smx * 1.8 + sweep * .9, 4.2 + state.smy * .8, 6.5);
    key.intensity = 3.4 * gain; rim.intensity = 4.2 * gain * flare; rimLeft.intensity = 1.6 * gain * flare;
    fill.intensity = 14 * gain; glowBack.intensity = (still ? 22 : 22 * lightIn + state.impact * 34);
    hemi.intensity = .12 + .23 * gain;
    scene.environmentIntensity = (still ? 1 : .04 + .96 * lightIn) * (1 + state.impact * .5);
    renderer.toneMappingExposure = (still ? 1.18 : .55 + .63 * span(s, 0, 2.2)) * (1 + state.impact * .22) * (1 - state.scroll * .55);

    backdrop.material.uniforms.uTime.value = t;
    backdrop.material.uniforms.uGlow.value = still ? 1 : ease.inOut(span(s, 1.4, 3.8));
    backdrop.material.uniforms.uBeam.value = still ? 1 : beam;
    backdrop.material.uniforms.uImpact.value = state.impact;
    forest.forEach((f, i) => { f.mesh.position.x = state.smx * (i ? -.5 : -.25); f.mesh.material.opacity = (i ? .85 : .6) * (still ? 1 : span(s, 1.2, 3)); });
    smoke.forEach(m => {
      const d = m.userData;
      m.material.opacity = d.base * (still ? 1 : smokeIn) * (1 + state.impact * .8);
      m.rotation.z += d.spin * dt * (still ? 0 : 1);
      m.position.x = (smoke.indexOf(m) - 3) * 1.4 + Math.sin(t * d.drift + d.phase) * .7;
    });
    updateParticles(dt, still ? 1 : embersIn, t);
    renderer.render(scene, camera);
  }

  function loop() {
    if (!state.running) return;
    requestAnimationFrame(loop);
    if (!state.visible || document.hidden) { clock.getDelta(); return; }
    const dt = Math.min(.05, clock.getDelta());
    state.t += dt;
    frame(dt);
  }
  function play() {
    if (still || state.running) return;
    state.running = true; clock.getDelta(); loop();
  }

  // ----- inputs -----
  const onMove = event => { state.mx = (event.clientX / innerWidth - .5) * 2; state.my = -((event.clientY / innerHeight) - .5) * 2; };
  const onScroll = () => {
    const rect = host.getBoundingClientRect();
    state.scroll = clamp01(-rect.top / Math.max(1, rect.height * .8));
    state.visible = rect.bottom > -40 && rect.top < innerHeight + 40;
    if (still) frame(0);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  if (!coarse && !still) addEventListener('pointermove', onMove, {passive: true});
  addEventListener('scroll', onScroll, {passive: true});
  document.addEventListener('scroll', onScroll, {passive: true});
  resize();
  onScroll();
  if (still) frame(0); else play();

  return {
    canvas,
    renderStill() { frame(0); },
    /* Jump to a moment of the reveal (seconds) for review stills; replays the timeline in small steps. */
    seek(seconds) {
      state.t = 0; state.impact = 0; state.burst = 0; state.impacted = false;
      for (let at = 0; at < seconds; at += 1 / 30) { state.t = at / speed; frame(1 / 30); }
      state.t = seconds / speed; frame(1 / 30);
    },
    destroy() {
      state.running = false;
      removeEventListener('pointermove', onMove);
      removeEventListener('scroll', onScroll);
      document.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
      for (const item of disposables) { try { item.dispose?.(); } catch { /* already gone */ } }
      scene.traverse(object => { if (object.isMesh || object.isPoints) { object.geometry?.dispose?.(); const m = object.material; (Array.isArray(m) ? m : [m]).forEach(x => x?.dispose?.()); } });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      host.classList.remove('wf-loaded', 'wf-static');
    },
  };
}
