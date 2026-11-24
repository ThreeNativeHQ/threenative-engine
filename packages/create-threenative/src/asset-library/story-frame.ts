// The code-story frame (PRD-915): one story module, rendered with the game's own `three/webgpu`
// (the plugin keeps every import here unresolved, so the game's aliases decide). The shell sends
// props; Vite's HMR hands a new story module to `replace`, which keeps the props.
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  type Material,
  type Mesh,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Sphere,
  Spherical,
  type Texture,
  Vector3,
} from "three";
import { WebGPURenderer } from "three/webgpu";
import type { IAssetStory } from "./types.js";

/** Estimated GPU bytes: geometry attributes plus each texture's base level and mips. */
function gpuBytes(root: Object3D): number {
  let bytes = 0;
  const seen = new Set<unknown>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    if (!seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      for (const attribute of Object.values(mesh.geometry.attributes))
        bytes += (attribute.array as ArrayLike<number> & { byteLength: number }).byteLength;
      bytes += mesh.geometry.index?.array.byteLength ?? 0;
    }
    for (const material of [mesh.material].flat() as (Material & Record<string, unknown>)[])
      for (const value of Object.values(material)) {
        const texture = value as Texture | undefined;
        if (!texture?.isTexture || seen.has(texture)) continue;
        seen.add(texture);
        const image = texture.image as { width?: number; height?: number } | undefined;
        bytes += ((image?.width ?? 0) * (image?.height ?? 0) * 4 * 4) / 3;
      }
  });
  return Math.round(bytes);
}

function triangles(root: Object3D): number {
  let count = 0;
  root.traverse((node) => {
    const mesh = node as Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh) return;
    const n = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0;
    count += (n / 3) * (mesh.isInstancedMesh ? (mesh.count ?? 1) : 1);
  });
  return Math.round(count);
}

export async function mountStory(
  first: IAssetStory,
): Promise<{ replace(next: IAssetStory): void }> {
  const post = (message: object) => window.parent.postMessage(message, "*");
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100%", height: "100%" });
  document.body.append(canvas);
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new Scene();
  scene.background = new Color(0x30353a);
  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(4, 8, 5);
  scene.add(sun, new HemisphereLight(0xdfe9ff, 0x4a4438, 0.9), new AmbientLight(0xffffff, 0.15));
  const grid = new GridHelper(20, 20, 0x55606a, 0x77818a);
  scene.add(grid);
  const camera = new PerspectiveCamera(40, 1, 0.05, 2000);
  const target = new Vector3();
  const orbit = new Spherical(6, 1.1, 0.6);

  let story = first;
  let props: Record<string, unknown> = {};
  let object: Object3D | undefined;
  let wire = false;
  let building = 0;
  let paused = false;

  const place = () => {
    camera.position.setFromSpherical(orbit).add(target);
    camera.lookAt(target);
  };
  const frameObject = () => {
    if (!object) return;
    const sphere = new Box3().setFromObject(object).getBoundingSphere(new Sphere());
    target.copy(sphere.center);
    orbit.radius = Math.max(0.5, sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.1;
    place();
  };
  const dress = () =>
    object?.traverse((node) => {
      for (const material of [(node as Mesh).material ?? []].flat() as (Material & {
        wireframe?: boolean;
      })[])
        if ("wireframe" in material) material.wireframe = wire;
    });

  const build = async () => {
    const mine = ++building;
    const started = performance.now();
    try {
      const next = await story.create(props);
      if (mine !== building) return;
      if (object) scene.remove(object);
      story.dispose?.();
      const first = object === undefined;
      object = next;
      scene.add(next);
      dress();
      if (first) frameObject();
      renderer.render(scene, camera);
      post({
        type: "tn-story:stats",
        triangles: triangles(next),
        drawCalls: renderer.info.render.drawCalls,
        bytes: gpuBytes(next),
        ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      post({
        type: "tn-story:error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const announce = () =>
    post({
      type: "tn-story:meta",
      title: story.title,
      category: story.category,
      controls: story.controls ?? [],
    });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || typeof event.data !== "object" || event.data === null)
      return;
    const message = event.data as { type?: string; props?: Record<string, unknown>; on?: boolean };
    if (message.type === "tn-story:props") {
      props = message.props ?? {};
      // A story with `update` takes new props live; one without is rebuilt from them.
      if (!story.update || !object) void build();
    } else if (message.type === "tn-story:wireframe") {
      wire = message.on === true;
      dress();
    } else if (message.type === "tn-story:sheet") void sheet();
    else if (message.type === "tn-asset-library:pause") paused = true;
    else if (message.type === "tn-asset-library:resume") paused = false;
  });

  // Orbit by drag, zoom by wheel: no addon import, so the frame binds only what the game binds.
  let drag: { x: number; y: number } | undefined;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("pointerup", () => {
    drag = undefined;
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    orbit.theta -= (e.clientX - drag.x) * 0.008;
    orbit.phi = Math.min(Math.PI - 0.05, Math.max(0.05, orbit.phi - (e.clientY - drag.y) * 0.008));
    drag = { x: e.clientX, y: e.clientY };
    place();
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      orbit.radius *= e.deltaY > 0 ? 1.1 : 0.9;
      place();
    },
    { passive: false },
  );

  async function sheet(): Promise<void> {
    const views: [string, number, number][] = [
      ["Front", 0, 1.45],
      ["Side", Math.PI / 2, 1.45],
      ["Back", Math.PI, 1.45],
      ["¾ Iso", 0.6, 1.0],
    ];
    const { width, height } = canvas;
    const out = document.createElement("canvas");
    out.width = width * 2;
    out.height = height * 2;
    const ctx = out.getContext("2d") as CanvasRenderingContext2D;
    const saved = orbit.clone();
    for (const [i, [label, theta, phi]] of views.entries()) {
      orbit.theta = theta;
      orbit.phi = phi;
      place();
      renderer.render(scene, camera);
      ctx.drawImage(canvas, (i % 2) * width, Math.floor(i / 2) * height);
      ctx.fillStyle = "rgba(2,4,7,0.72)";
      ctx.fillRect((i % 2) * width + 8, Math.floor(i / 2) * height + 8, 150, 30);
      ctx.fillStyle = "#e0fb50";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(label, (i % 2) * width + 16, Math.floor(i / 2) * height + 30);
    }
    orbit.copy(saved);
    place();
    post({ type: "tn-story:sheet", url: out.toDataURL("image/png") });
  }

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (paused || document.visibilityState === "hidden") return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    }
    story.update?.(dt, props);
    renderer.render(scene, camera);
  });
  place();
  announce();
  // Opened on its own (no shell around it), the story builds from its control defaults.
  if (window.parent === window) {
    props = Object.fromEntries((story.controls ?? []).map((c) => [c.key, c.default]));
    void build();
  }
  return {
    replace(next) {
      story = next;
      announce();
      void build();
    },
  };
}
