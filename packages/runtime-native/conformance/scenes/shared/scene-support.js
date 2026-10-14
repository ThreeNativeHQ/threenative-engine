import * as THREE from "three/webgpu";

export { THREE };

export function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function startVisualScene(canvas, dimensions, type, build, options = {}) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(dimensions.width, dimensions.height, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? 0x18202f);
  const camera = options.camera
    ? options.camera(dimensions)
    : new THREE.PerspectiveCamera(55, dimensions.width / dimensions.height, 0.1, 100);
  if (!options.camera) camera.position.set(0, 0.25, 3.2);

  const subject = await build({ renderer, scene, camera, dimensions });
  const renderFrame = typeof subject?.render === "function"
    ? () => subject.render()
    : () => renderer.render(scene, camera);
  function frame() {
    if (options.awaitRender === true) {
      Promise.resolve(renderFrame()).then(() => requestAnimationFrame(frame));
      return;
    }
    renderFrame();
    requestAnimationFrame(frame);
  }
  if (options.deferInitialRender !== true) await Promise.resolve(renderFrame());
  requestAnimationFrame(frame);
  globalThis.__TN_CONFORMANCE = { ok: true, type, detail: subject?.detail ?? null };
  return { renderer, scene, camera, subject };
}

export async function startBehaviorScene(canvas, dimensions, type, verify) {
  const detail = await verify();
  return startVisualScene(canvas, dimensions, type, ({ scene }) => {
    const card = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.95, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x2f855a }),
    );
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.24, 0.08, 12, 32),
      new THREE.MeshBasicMaterial({ color: 0x90cdf4 }),
    );
    marker.position.set(0.42, 0.08, 0.15);
    card.add(marker);
    scene.add(card);
    return { detail, card, marker };
  });
}
