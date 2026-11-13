import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export async function createBeeScene({ overlay, paths, base, signal, onModelSettled, onContextLost }) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.8, 1.8, 1.5, -1.5, .1, 30);
  camera.position.z = 9;
  const art = overlay.querySelector('.pb-art');
  const tiny = overlay.querySelector('.pb-tiny-bee');
  const miniCanvas = document.createElement('canvas');
  const miniContext = miniCanvas.getContext('2d');
  miniCanvas.width = miniCanvas.height = 128;
  const miniScene = new THREE.Scene();
  const miniCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 30);
  miniCamera.position.z = 9;
  const manager = new THREE.LoadingManager();
  const draco = new DRACOLoader(manager).setDecoderPath(new URL('public/draco/', base).href);
  const loader = new GLTFLoader(manager).setDRACOLoader(draco);
  const models = [];
  let frame = 0;
  let disposed = false;
  let mouseX = 0, mouseY = 0;
  const pointer = event => {
    mouseX = (event.clientX / innerWidth - .5) * .25;
    mouseY = (event.clientY / innerHeight - .5) * .18;
  };

  function disposeModel(model) {
    model.traverse(object => {
      object.geometry?.dispose();
      for (const material of [object.material].flat().filter(Boolean)) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', pointer);
    for (const model of models) disposeModel(model);
    draco.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    miniCanvas.remove();
  }
  signal.addEventListener('abort', dispose, { once: true });
  renderer.domElement.addEventListener('webglcontextlost', event => {
    if (disposed) return;
    event.preventDefault();
    dispose();
    onContextLost();
  });

  function studio(target) {
    target.add(new THREE.HemisphereLight(0xfffaf2, 0xc3b6a3, 2.1));
    const key = new THREE.DirectionalLight(0xffecd1, 2.4);
    key.position.set(-3, 5, 6);
    target.add(key);
  }
  studio(scene);
  studio(miniScene);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth <= 600 ? 1.5 : 2));
  renderer.domElement.className = 'pb-canvas';

  function load(name, size) {
    return loader.loadAsync(new URL(paths[name], base).href).then(({ scene: model }) => {
      if (disposed) {
        disposeModel(model);
        throw new Error('Preloader closed');
      }
      models.push(model);
      const bounds = new THREE.Box3().setFromObject(model);
      const dimensions = bounds.getSize(new THREE.Vector3());
      if (!Number.isFinite(dimensions.length()) || dimensions.lengthSq() === 0) {
        throw new Error('Empty PrintBee model');
      }
      const pivot = new THREE.Group();
      model.position.sub(bounds.getCenter(new THREE.Vector3()));
      pivot.add(model);
      pivot.scale.setScalar(size / Math.max(dimensions.x, dimensions.y, dimensions.z));
      return pivot;
    }).then(model => {
      onModelSettled(name, true);
      return model;
    }, error => {
      onModelSettled(name, false);
      throw error;
    });
  }

  try {
    // Each completed GLTFLoader request includes its textures and Draco decoding.
    const main = load('main', 2.43);
    const paper = load('paper', .85);
    const mini = load('mini', 1.55);
    const [bee, sheet, smallBee] = await Promise.all([main, paper, mini]);
    if (signal.aborted) return;
    scene.add(bee, sheet);
    smallBee.rotation.y = -Math.PI / 2;
    sheet.rotation.y = -Math.PI / 2;
    miniScene.add(smallBee);
    art.append(renderer.domElement);
    tiny.replaceChildren(miniCanvas);
    overlay.classList.add('pb-webgl');
    window.addEventListener('pointermove', pointer, { passive: true });
    const flight = overlay.querySelector('.pb-bee-flight');
    const pose = overlay.querySelector('.pb-bee-pose');
    const bob = overlay.querySelector('.pb-bee-bob');
    const page = overlay.querySelector('.pb-paper');
    const chips = [...overlay.querySelectorAll('.pb-chip')];
    const chipLights = [0x0bcaff, 0xff3394, 0xffc629, 0xc5bddc].map((colour, index) => {
      const light = new THREE.PointLight(colour, 0, .32, 2);
      scene.add(light);
      return { light, anchor: new THREE.Vector3(.42 + .143 * index, -.65 - .031 * index, .54) };
    });
    const read = element => element.transform.baseVal.numberOfItems ? element.transform.baseVal.getItem(0).matrix : null;
    bee.rotation.y = -Math.PI / 2;
    const mainScale = bee.scale.x;
    const sheetScale = sheet.scale.x;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.6, .4), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 uvPosition; void main(){uvPosition=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec2 uvPosition; void main(){float d=length((uvPosition-.5)*2.);gl_FragColor=vec4(.35,.25,.13,.13*(1.-smoothstep(0.,1.,d)));}'
    }));
    models.push(shadow);
    scene.add(shadow);
    shadow.position.set(0, -1.1, -1.2);

    let width = 0;
    function render(time) {
      if (disposed) return;
      const size = Math.max(1, Math.round(art.clientWidth));
      if (width !== size) {
        width = size;
        renderer.setSize(width, Math.round(width * 5 / 6), false);
      }
      const flightMatrix = read(flight);
      const poseMatrix = read(pose);
      const bobMatrix = read(bob);
      const opacity = Number(flight.style.opacity || 0);
      const sheetTravel = read(page)?.f || 0;
      const pulse = Math.sin(time * .012) * .018;
      bee.visible = opacity > .015;
      shadow.visible = bee.visible;
      bee.position.set((flightMatrix?.e || 0) / 100, -(flightMatrix?.f || 0) / 100 - (bobMatrix?.f || 0) / 100, 0);
      bee.rotation.x += (mouseY - bee.rotation.x) * .08;
      bee.rotation.y += (-Math.PI / 2 + mouseX - bee.rotation.y) * .08;
      bee.rotation.z = poseMatrix ? -Math.atan2(poseMatrix.b, poseMatrix.a) : 0;
      const scale = Math.max(.05, opacity) * mainScale;
      bee.scale.set(scale * (1 + pulse), scale * (1 - pulse), scale);
      bee.updateMatrixWorld();
      chipLights.forEach(({ light, anchor }, index) => {
        const opacity = Number(chips[index].style.opacity);
        const phase = THREE.MathUtils.clamp((opacity - .15) / .85, 0, 1);
        light.intensity = bee.visible ? Math.sin(phase * Math.PI) * .16 : 0;
        bee.localToWorld(light.position.copy(anchor).divideScalar(mainScale));
      });
      sheet.visible = sheetTravel > 1;
      sheet.position.set(.72, -.45 - sheetTravel / 46, 1.8);
      sheet.rotation.z = -.17;
      sheet.scale.setScalar(sheetScale * Math.min(1, sheetTravel / 10));
      renderer.setScissorTest(false);
      renderer.render(scene, camera);
      // Copy the mini-bee render before restoring the main scene in the same frame.
      if (Number(tiny.style.opacity || 0) > .02 && miniContext) {
        smallBee.rotation.z = Math.sin(time * .032) * .12;
        renderer.render(miniScene, miniCamera);
        miniContext.clearRect(0, 0, 128, 128);
        const canvas = renderer.domElement;
        const side = Math.min(canvas.width, canvas.height);
        miniContext.drawImage(canvas, (canvas.width - side) / 2, (canvas.height - side) / 2, side, side, 0, 0, 128, 128);
        renderer.render(scene, camera);
      }
      frame = requestAnimationFrame(render);
    }
    frame = requestAnimationFrame(render);
  } catch (error) {
    dispose();
    throw error;
  }
}
