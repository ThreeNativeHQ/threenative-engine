import {
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  type RenderTarget,
  Scene,
  type Texture,
  Vector2,
} from "three";
import {
  type Node,
  NodeFrame,
  type NodeUniform,
  RenderPipeline,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import {
  type IResolutionTextureView,
  ResolutionSubrect,
} from "../../core/src/render/resolution-subrect.js";
import { type OutputRenderer, WorldEnvironment } from "../template-assets/worldEnvironment.js";

/** The real `WGSLNodeBuilder` output: shader proof only, never pixel proof. */
type IBuilt = WGSLNodeBuilder & {
  build(): void;
  fragmentShader: string;
  updateNodes: Node[];
  uniforms: { fragment: NodeUniform<string, unknown>[] };
  bindings: Record<string, Record<string, { name: string; texture: Texture }[]>>;
};

const realRenderer = (): WebGPURenderer => {
  const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
  Reflect.set(renderer.backend, "renderer", renderer);
  vi.spyOn(Reflect.get(renderer.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
    65536,
  );
  vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
  return renderer;
};

const compile = (
  renderer: WebGPURenderer,
  object: Mesh,
  camera: PerspectiveCamera,
  scene: Scene,
): IBuilt => {
  const builder = new WGSLNodeBuilder(object, renderer) as IBuilt;
  Reflect.set(builder, "camera", camera);
  Reflect.set(builder, "scene", scene);
  objects.set(builder as IBuilt, object);
  builder.build();
  return builder as IBuilt;
};

const objects = new WeakMap<IBuilt, Mesh>();

const objectOf = (built: IBuilt): Mesh => {
  const object = objects.get(built);
  if (!object) throw new Error("Shader was not compiled from a mesh");
  return object;
};

const render = (
  built: IBuilt,
  object: Mesh,
  renderer: WebGPURenderer,
  camera: PerspectiveCamera,
  scene: Scene,
): void => {
  const frame = new NodeFrame();
  Reflect.set(frame, "renderer", renderer);
  Reflect.set(frame, "camera", camera);
  Reflect.set(frame, "object", object);
  Reflect.set(frame, "scene", scene);
  // The first pass needs the render id the renderer has already advanced by the time a material draws.
  frame.renderId = 1;
  for (const node of built.updateNodes) frame.updateNode(node);
};

/** WGSL identifiers the real compiler gave the bindings that hold this exact texture. */
const bindingNames = (built: IBuilt, texture: Texture): string[] => {
  const names = Object.values(built.bindings.fragment ?? {})
    .flat()
    .filter((binding) => binding.texture === texture)
    .map((binding) => binding.name);
  if (names.length === 0) throw new Error("texture is not bound in the compiled fragment stage");
  return names;
};

/** WGSL names of the uniforms whose live value is this exact retained view vector. */
const namesOf = (built: IBuilt, vectors: readonly Vector2[]): string[] => {
  const names = built.uniforms.fragment
    .filter(
      (uniform) => uniform.node.value instanceof Vector2 && vectors.includes(uniform.node.value),
    )
    .map((uniform) => uniform.name);
  if (names.length === 0) throw new Error("no compiled uniform carries a retained view vector");
  return names;
};

const balanced = (source: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error("unbalanced WGSL argument list");
};

/** Every texture the compiled stage binds, by the name the compiler gave it. */
const allBindingNames = (built: IBuilt): string[] => [
  ...new Set(
    Object.values(built.bindings.fragment ?? {})
      .flat()
      .filter((binding) => binding.texture !== undefined)
      .map((binding) => binding.name),
  ),
];

/** Every argument list that reads one of these exact texture bindings. */
const reads = (wgsl: string, textureNames: string[]): string[] =>
  [
    ...wgsl.matchAll(
      new RegExp(`texture(?:Sample|Load|\\w*Level)\\(\\s*(?:${textureNames.join("|")})\\b`, "g"),
    ),
  ].map((match) => balanced(wgsl, wgsl.indexOf("(", match.index ?? 0)));

/**
 * The `viewFraction` a read is clamped by, or `undefined` when it is not clamped to a retained view.
 */
const retainedViewOf = (read: string, fraction: string[], half: string[]): string | undefined => {
  const view = new RegExp(
    String.raw`^\(\s*\(.*\*\s*(?:object\.)?(${fraction.join("|")})\s*\)\s*,\s*(?:object\.)?(${half.join(
      "|",
    )})\s*,\s*\(\s*(?:object\.)?\1\s*-\s*(?:object\.)?\2\s*\)\s*\)$`,
  );
  for (let open = read.indexOf("clamp("); open >= 0; open = read.indexOf("clamp(", open + 1)) {
    const match = view.exec(balanced(read, open + "clamp".length));
    if (match) return match[1];
  }
  return undefined;
};

const stage = () => {
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = () => {};
    },
  );
  const renderer = realRenderer();
  const controller = new ResolutionSubrect();
  const camera = new PerspectiveCamera();
  const scene = new Scene();
  let graph: Node | undefined;
  let ao: (Node & { _aoRenderTarget: RenderTarget }) | undefined;
  let denoiser: (Node & { updateBefore(): void; _resolution: { value: Vector2 } }) | undefined;
  let worldPass:
    | { getTextureNode(name: string): { value: Texture }; renderTarget: object }
    | undefined;
  const capture: OutputRenderer = {
    kind: "webgpu",
    raw: renderer,
    createResolutionSubrect: () => controller,
    createRenderChain(options) {
      worldPass = options.worldPass as typeof worldPass;
      const stage = options.stages?.find((entry) => entry.name === "ambientOcclusion");
      if (!stage) throw new Error("Missing the canonical ambient-occlusion stage");
      graph = stage.build(options.input, { tier: "high" }) as Node;
      graph.traverse((node) => {
        const pass = Reflect.get(node, "passNode") as Node | undefined;
        if (pass && Reflect.get(pass, "_aoRenderTarget") !== undefined) {
          ao = pass as typeof ao;
        }
        if (Reflect.get(node, "_resolution") !== undefined && Reflect.get(node, "textureNode")) {
          denoiser = node as typeof denoiser;
        }
      });
      return { applied: { stages: ["ambientOcclusion"], dropped: [] }, dispose() {} };
    },
  };
  const world = new WorldEnvironment({ gtaoEnabled: true, denoiseEnabled: true });
  const applied = world.apply(capture, scene, camera);
  controller.activate(0.72);
  controller.setSize(1280, 720);
  if (!graph) throw new Error("Missing the composed ambient-occlusion graph");
  if (!ao) throw new Error("Missing the real GTAO node");
  if (!worldPass) throw new Error("Missing the scene pass");
  const view = (texture: Texture): IResolutionTextureView => {
    const found = controller.textureView(texture);
    if (!found) throw new Error("A texture this stage samples carries no retained view");
    return found;
  };
  // The renderer's own output-pipeline build is what gives the GTAO node its fragment node.
  const pipeline = new RenderPipeline(renderer as never, graph as never);
  Reflect.get(pipeline as object, "_update").call(pipeline);
  const outputQuad = Reflect.get(pipeline as object, "_quadMesh") as Mesh;
  const gtaoQuad = new Mesh(new PlaneGeometry(), Reflect.get(ao, "_material") as never);
  const output = compile(renderer, outputQuad, camera, scene);
  const gtao = compile(renderer, gtaoQuad, camera, scene);
  const depth = worldPass.getTextureNode("depth").value;
  const normal = worldPass.getTextureNode("normal").value;
  const occlusion = ao._aoRenderTarget.texture;
  const colour = worldPass.getTextureNode("output").value;
  // Every texture the controller retains, and therefore every binding that may carry a view clamp.
  const retained = [colour, depth, normal, occlusion];
  for (const texture of retained) view(texture);
  const unretained = (built: IBuilt): string[] => {
    const kept = new Set(retained.flatMap((texture) => bindingNames(built, texture)));
    return allBindingNames(built).filter((name) => !kept.has(name));
  };
  const draw = (built: IBuilt): void => render(built, objectOf(built), renderer, camera, scene);
  // The first frame's per-render pass, as the renderer runs it before the material draws.
  draw(output);
  draw(gtao);
  const close = (): void => {
    applied.dispose?.();
    controller.dispose();
    vi.unstubAllGlobals();
  };
  return {
    ao,
    close,
    controller,
    denoiser,
    depth,
    draw,
    gtao,
    normal,
    occlusion,
    output,
    unretained,
    view,
  };
};

describe("canonical ambient occlusion under a retained sub-rectangle", () => {
  it("clamps every GTAO input read to the retained view the controller owns", () => {
    const proof = stage();
    try {
      const scene = proof.view(proof.depth);
      const fraction = namesOf(proof.gtao, [scene.viewFraction]);
      const half = namesOf(proof.gtao, [scene.halfTexel]);
      expect(fraction).not.toHaveLength(0);
      const depthReads = reads(proof.gtao.fragmentShader, bindingNames(proof.gtao, proof.depth));
      const normalReads = reads(proof.gtao.fragmentShader, bindingNames(proof.gtao, proof.normal));
      expect(depthReads.length).toBeGreaterThan(0);
      expect(normalReads.length).toBeGreaterThan(0);
      const pairs = new Set(
        [...depthReads, ...normalReads].map((read) => retainedViewOf(read, fraction, half)),
      );
      // Every read is clamped by a live view uniform, and each sampler carries its own pair.
      expect(pairs.has(undefined)).toBe(false);
      // GTAO marches depth along its horizons, so every read site owns its own live pair.
      expect(pairs.size).toBe(depthReads.length + normalReads.length);
      expect(pairs.size).toBeGreaterThanOrEqual(4);
      // The half texel is the retained capacity's, not the viewport's.
      for (const name of half) {
        const uniform = proof.gtao.uniforms.fragment.find((entry) => entry.name === name);
        expect(uniform?.node.value).toBe(scene.halfTexel);
      }
      expect(scene.viewFraction.toArray()).toEqual([928 / 1280, 520 / 720]);
    } finally {
      proof.close();
    }
  });

  it("clamps the denoised occlusion reads to the AO target's own retained view", () => {
    const proof = stage();
    try {
      const view = proof.view(proof.occlusion);
      const fraction = namesOf(proof.output, [view.viewFraction]);
      const half = namesOf(proof.output, [view.halfTexel]);
      const occlusion = bindingNames(proof.output, proof.occlusion);
      const occlusionReads = reads(proof.output.fragmentShader, occlusion);
      expect(occlusionReads.length).toBeGreaterThan(1);
      for (const read of occlusionReads) {
        expect(retainedViewOf(read, fraction, half)).toBeDefined();
      }
      // The denoiser marches the AO texture in view pixels, so its resolution follows the rectangle.
      expect(proof.denoiser).toBeDefined();
      proof.denoiser?.updateBefore();
      expect(proof.denoiser?._resolution.value.toArray()).toEqual([928, 520]);
      // Every other sampled texture is not a retained target, so the shader reads it whole.
      const unretained = proof.unretained(proof.output);
      expect(unretained.length).toBeGreaterThan(0);
      for (const name of unretained) {
        const whole = reads(proof.output.fragmentShader, [name]);
        expect(whole.length).toBeGreaterThan(0);
        for (const read of whole) expect(retainedViewOf(read, fraction, half)).toBeUndefined();
      }
    } finally {
      proof.close();
    }
  });

  it("carries 0.72 to 0.61 into the same view uniforms without reallocating capacity", () => {
    const proof = stage();
    try {
      const view = proof.view(proof.occlusion);
      const fraction = namesOf(proof.output, [view.viewFraction]);
      const half = namesOf(proof.output, [view.halfTexel]);
      const live = (names: string[]): Vector2 => {
        const value = proof.output.uniforms.fragment.find((entry) => names.includes(entry.name))
          ?.node.value;
        if (!(value instanceof Vector2)) throw new Error("no live view uniform holds a vector");
        return value;
      };
      expect(live(fraction)).toBe(view.viewFraction);
      expect(live(fraction).toArray()).toEqual([928 / 1280, 520 / 720]);
      expect(live(half).toArray()).toEqual([0.5 / 1280, 0.5 / 720]);
      const capacity = [proof.ao._aoRenderTarget.width, proof.ao._aoRenderTarget.height];
      const reallocations = { count: 0 };
      proof.ao._aoRenderTarget.addEventListener("dispose", () => {
        reallocations.count += 1;
      });

      proof.controller.setScale(0.61);
      proof.draw(proof.output);

      expect(live(fraction)).toBe(view.viewFraction);
      expect(live(fraction).toArray()).toEqual([784 / 1280, 440 / 720]);
      expect(live(half).toArray()).toEqual([0.5 / 1280, 0.5 / 720]);
      expect([proof.ao._aoRenderTarget.width, proof.ao._aoRenderTarget.height]).toEqual(capacity);
      expect(reallocations.count).toBe(0);
      // The compiled shader is unchanged: the same names still carry the new rectangle.
      for (const read of reads(
        proof.output.fragmentShader,
        bindingNames(proof.output, proof.occlusion),
      )) {
        expect(retainedViewOf(read, fraction, half)).toBeDefined();
      }
      // An inactive controller keeps the ordinary full-texture sampling.
      proof.controller.deactivate();
      proof.draw(proof.output);
      expect(live(fraction).toArray()).toEqual([1, 1]);
      expect(live(half).toArray()).toEqual([0, 0]);
    } finally {
      proof.close();
    }
  });
});
