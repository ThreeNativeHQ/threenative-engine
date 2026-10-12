/**
 * The in-page half of a render golden: build the fixture's scene and draw exactly one frame.
 *
 * The harness (`render-reference.ts`) serves this module and `three.webgpu.js` from one origin,
 * injects the fixture, and screenshots the canvas once this resolves. Anything that cannot be
 * drawn throws here and becomes a failed reference run — never a golden nobody drew.
 */

import * as three from "/build/three.webgpu.js";

/** The value behind `{ "num": "NaN" }` and its three siblings. */
function namedNumber(name) {
  if (name === "NaN") return Number.NaN;
  if (name === "Infinity") return Number.POSITIVE_INFINITY;
  if (name === "-Infinity") return Number.NEGATIVE_INFINITY;
  return -0;
}

function argument(arg, bound) {
  if (arg !== null && typeof arg === "object") {
    if ("ref" in arg) {
      const found = bound.get(arg.ref);
      if (found === undefined) throw new Error(`TN_FIXTURE_UNBOUND: ${arg.ref} has no value`);
      return found;
    }
    if ("refs" in arg) return arg.refs.map((id) => argument({ ref: id }, bound));
    if ("array" in arg) return new globalThis[arg.type](arg.array);
    return namedNumber(arg.num);
  }
  return arg;
}

function writePath(root, dotted, value) {
  const segments = dotted.split(".");
  const last = segments.pop();
  let current = root;
  for (const segment of segments) {
    const next = current[segment];
    if (next === null || next === undefined)
      throw new Error(`TN_FIXTURE_PATH_MISSING: ${dotted} leaves ${String(next)}`);
    current = next;
  }
  current[last] = value;
}

/** Executes the fixture's ops in `three`, the same reads the Node reference makes. */
async function build(fixture, renderer, request) {
  const bound = new Map();
  for (const op of fixture.ops) {
    if (op.op === "tsl") {
      // The named TSL program, applied to the bound material with the renderer that draws it.
      const { programs } = await import("/tsl-programs.js");
      const program = programs[op.program];
      if (typeof program !== "function") throw new Error(`TN_FIXTURE_TSL_UNKNOWN: ${op.program}`);
      // A program may draw the frame itself (a RenderPipeline): it returns that `render`.
      const drawn = await program({
        target: bound.get(op.id),
        renderer,
        scene: bound.get(request.scene),
        camera: bound.get(request.camera),
        width: request.width,
        height: request.height,
        traaDump: request.traaDump,
      });
      if (drawn?.render !== undefined) bound.set("\u0001render", drawn.render);
      continue;
    }
    if (op.op === "gltf") {
      // three's own loader on the served repository file; its default scene is the bound value.
      const { GLTFLoader } = await import("/addons/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().loadAsync(`/files/${op.file}`);
      bound.set(op.id, gltf.scene);
      (op.clips ?? []).forEach((clip, i) => bound.set(clip, gltf.animations[i]));
      continue;
    }
    if (op.op === "new") {
      const Constructor = three[op.class];
      if (typeof Constructor !== "function")
        throw new Error(`TN_FIXTURE_CLASS_UNKNOWN: ${op.class} is not exported by three/webgpu`);
      const args = op.args.map((arg) => argument(arg, bound));
      // A CanvasTexture fixture names its canvas by its pixels, as the engine back ends pass them
      // (pixels, width, height, ...): the reference draws them into a real canvas first.
      if (op.class === "CanvasTexture") {
        const [pixels, width, height, ...rest] = args;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas
          .getContext("2d")
          .putImageData(new ImageData(Uint8ClampedArray.from(pixels), width, height), 0, 0);
        bound.set(op.id, new Constructor(canvas, ...rest));
        continue;
      }
      bound.set(op.id, new Constructor(...args));
      continue;
    }
    const target = bound.get(op.id);
    if (target === undefined) throw new Error(`TN_FIXTURE_UNBOUND: ${op.id} has no value`);
    if (op.op === "set") {
      writePath(target, op.path, argument(op.value, bound));
      continue;
    }
    const method = target[op.method];
    if (typeof method !== "function")
      throw new Error(`TN_FIXTURE_METHOD_UNKNOWN: ${op.id}.${op.method} is not callable`);
    const returned = method.apply(
      target,
      op.args.map((arg) => argument(arg, bound)),
    );
    if (op.result !== undefined) bound.set(op.result, returned);
  }
  return bound;
}

/** What `navigator.gpu` reported for the adapter that drew the frame, not for a fresh request. */
function adapterInfo(renderer) {
  const info = renderer.backend.adapter?.info ?? {};
  return {
    architecture: info.architecture ?? "",
    description: info.description ?? "",
    device: info.device ?? "",
    vendor: info.vendor ?? "",
  };
}

export async function renderFixture(request) {
  const renderer = new three.WebGPURenderer({
    canvas: document.getElementById("c"),
    antialias: false,
    forceWebGL: false,
  });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(request.width, request.height, false);
  renderer.toneMapping = three[request.toneMappingConstant];
  renderer.toneMappingExposure = request.toneMappingExposure;
  renderer.outputColorSpace = three[request.outputColorSpaceConstant];
  renderer.shadowMap.enabled = request.shadowMap === true;
  renderer.shadowMap.type = three[request.shadowMapType ?? "PCFShadowMap"];

  const bound = await build(request.fixture, renderer, request);
  const render = bound.get("\u0001render");
  if (render !== undefined) await render();
  else renderer.render(bound.get(request.scene), bound.get(request.camera));
  // The harness screenshots the presented frame, so wait for the work to land and for the
  // compositor to hold it before the page reports back.
  await renderer.backend.device.queue.onSubmittedWorkDone();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { adapter: adapterInfo(renderer) };
}

/** Hands the outcome to the harness and waits: it owns the capture, this owns the frame. */
export function reportOutcome(request) {
  renderFixture(request).then(
    (result) => globalThis.__tnRenderDone({ adapter: result.adapter }),
    (error) => globalThis.__tnRenderDone({ error: String(error?.stack ?? error) }),
  );
}
