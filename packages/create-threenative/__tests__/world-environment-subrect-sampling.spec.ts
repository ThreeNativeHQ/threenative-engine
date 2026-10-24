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
  type NodeMaterial,
  type NodeUniform,
  RenderPipeline,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import {
  type OutputRenderer,
  WorldEnvironment,
} from "../../../test-support/isolated-world-environment.js";
import {
  type IResolutionTextureView,
  ResolutionSubrect,
} from "../../core/src/render/resolution-subrect.js";

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

const at = <T>(items: readonly T[], index: number): T => items[index] as T;

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
      // Every WGSL way of reading a texture: sample, biased, levelled, compared, gathered, loaded.
      new RegExp(`texture(?:Sample|Load|Gather)\\w*\\(\\s*(?:${textureNames.join("|")})\\b`, "g"),
    ),
  ].map((match) => balanced(wgsl, wgsl.indexOf("(", match.index ?? 0)));

/**
 * The uniform names a read is clamped by, or `undefined` when it is not clamped to a retained view.
 */
const retainedViewOf = (
  read: string,
  fraction: string[],
  half: string[],
): { fraction: string; half: string } | undefined => {
  const view = new RegExp(
    String.raw`^\(\s*\(.*\*\s*(?:object\.)?(${fraction.join("|")})\s*\)\s*,\s*(?:object\.)?(${half.join(
      "|",
    )})\s*,\s*\(\s*(?:object\.)?\1\s*-\s*(?:object\.)?\2\s*\)\s*\)$`,
    "s",
  );
  for (let open = read.indexOf("clamp("); open >= 0; open = read.indexOf("clamp(", open + 1)) {
    const match = view.exec(balanced(read, open + "clamp".length));
    if (match) return { fraction: match[1] as string, half: match[2] as string };
  }
  return undefined;
};

/** Uniform names whose live value is this exact vector, tolerating an absent one. */
const maybeNamesOf = (built: IBuilt, vectors: readonly Vector2[]): string[] =>
  built.uniforms.fragment
    .filter(
      (uniform) => uniform.node.value instanceof Vector2 && vectors.includes(uniform.node.value),
    )
    .map((uniform) => uniform.name);

const vectorOf = (built: IBuilt, name: string): unknown =>
  built.uniforms.fragment.find((entry) => entry.name === name)?.node.value;

/** Every texture a compiled stage material binds, by the name the compiler gave it. */
const boundTextures = (built: IBuilt): [string, Texture][] => [
  ...new Map(
    Object.values(built.bindings.fragment ?? {})
      .flat()
      .filter((binding) => binding.texture !== undefined)
      .map((binding) => [binding.name, binding.texture]),
  ).entries(),
];

/** Every read of a retained texture carries the clamp pair of that texture's own view. */
const expectOwnViewClamp = (built: IBuilt, view: IResolutionTextureView, sites: string[]): void => {
  const fraction = maybeNamesOf(built, [view.viewFraction]);
  const half = maybeNamesOf(built, [view.halfTexel]);
  for (const read of sites) {
    const pair = retainedViewOf(read, fraction, half);
    expect(pair).toBeDefined();
    if (pair === undefined) continue;
    // The pair is this texture's own view, not another target's.
    expect(vectorOf(built, pair.fraction)).toBe(view.viewFraction);
    expect(vectorOf(built, pair.half)).toBe(view.halfTexel);
  }
};

/**
 * Every read of a texture the controller owns carries the clamp pair of that texture's own view,
 * and no read of a texture it does not own carries any retained pair at all.
 */
const expectOwnViewClamps = (built: IBuilt, controller: ResolutionSubrect) => {
  const bound = boundTextures(built);
  const guarded = { fraction: [] as string[], half: [] as string[] };
  for (const [, texture] of bound) {
    const view = controller.textureView(texture);
    if (!view) continue;
    guarded.fraction.push(...maybeNamesOf(built, [view.viewFraction]));
    guarded.half.push(...maybeNamesOf(built, [view.halfTexel]));
  }
  let retained = 0;
  let whole = 0;
  for (const [name, texture] of bound) {
    const view = controller.textureView(texture);
    const sites = reads(built.fragmentShader, [name]);
    if (view === undefined) {
      whole += sites.length;
      if (guarded.fraction.length === 0) continue;
      for (const read of sites)
        expect(retainedViewOf(read, guarded.fraction, guarded.half)).toBeUndefined();
      continue;
    }
    retained += sites.length;
    expectOwnViewClamp(built, view, sites);
  }
  return { retained, whole };
};

/** The real, canonical graph of one stage, its compiled output pass, and its controller. */
const canonical = (
  stageName: string,
  worldOptions: Record<string, unknown> = {},
  retained = true,
) => {
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
  let worldPass:
    | { getTextureNode(name: string): { value: Texture }; renderTarget: object }
    | undefined;
  const nodes: Node[] = [];
  const capture: OutputRenderer = {
    kind: "webgpu",
    raw: renderer,
    ...(retained ? { createResolutionSubrect: () => controller } : {}),
    createRenderChain(options) {
      worldPass = options.worldPass as typeof worldPass;
      const stage = options.stages?.find((entry) => entry.name === stageName);
      if (!stage) throw new Error(`Missing the canonical ${stageName} stage`);
      graph = stage.build(options.input, { tier: "high" }) as Node;
      graph.traverse((node) => {
        if (!nodes.includes(node)) nodes.push(node);
      });
      return { applied: { stages: [stageName], dropped: [] }, dispose() {} };
    },
  };
  const world = new WorldEnvironment({ gtaoEnabled: true, denoiseEnabled: true, ...worldOptions });
  const applied = world.apply(capture, scene, camera);
  controller.activate(0.72);
  controller.setSize(1280, 720);
  if (!graph) throw new Error(`Missing the composed ${stageName} graph`);
  if (!worldPass) throw new Error("Missing the scene pass");
  const view = (texture: Texture): IResolutionTextureView => {
    const found = controller.textureView(texture);
    if (!found) throw new Error("A texture this stage samples carries no retained view");
    return found;
  };
  // The renderer's own output-pipeline build is what gives the stage nodes their materials.
  const pipeline = new RenderPipeline(renderer as never, graph as never);
  Reflect.get(pipeline as object, "_update").call(pipeline);
  const outputQuad = Reflect.get(pipeline as object, "_quadMesh") as Mesh;
  const output = compile(renderer, outputQuad, camera, scene);
  const draw = (built: IBuilt): void => render(built, objectOf(built), renderer, camera, scene);
  // The first frame's per-render pass, as the renderer runs it before the material draws.
  draw(output);
  /** The one real node of the stage, by the internal target it owns. */
  const own = <T>(property: string, what: string): T => {
    const found = ownAll(property, what);
    if (found.length !== 1) throw new Error(`Expected one ${what}, found ${found.length}`);
    return found[0] as T;
  };
  const ownAll = <T>(property: string, what: string): T[] =>
    nodes.filter((node) => Reflect.get(node, property) !== undefined) as T[];
  /** The stage's own quad materials, compiled through the real WGSL builder. */
  const compileMaterial = (material: unknown): IBuilt => {
    const built = compile(
      renderer,
      new Mesh(new PlaneGeometry(), material as never),
      camera,
      scene,
    );
    draw(built);
    return built;
  };
  const close = (): void => {
    applied.dispose?.();
    controller.dispose();
    vi.unstubAllGlobals();
  };
  return {
    close,
    colour: worldPass.getTextureNode("output").value,
    compileMaterial,
    controller,
    depth: worldPass.getTextureNode("depth").value,
    draw,
    normal: worldPass.getTextureNode("normal").value,
    output,
    own,
    ownAll,
    view,
  };
};

const stage = (samples = 0) => {
  const proof = canonical("ambientOcclusion", { samples });
  const ao = proof.own<Node & { _aoRenderTarget: RenderTarget }>(
    "_aoRenderTarget",
    "real GTAO node",
  );
  const denoiser = proof.own<Node & { updateBefore(): void; _resolution: { value: Vector2 } }>(
    "_resolution",
    "real denoiser",
  );
  const gtao = proof.compileMaterial(Reflect.get(ao, "_material"));
  const depth = proof.depth;
  const normal = proof.normal;
  const occlusion = ao._aoRenderTarget.texture;
  const colour = proof.colour;
  // Every texture the controller retains, and therefore every binding that may carry a view clamp.
  const retained = [colour, depth, normal, occlusion];
  for (const texture of retained) proof.view(texture);
  const unretained = (built: IBuilt): string[] => {
    const kept = new Set(
      retained.flatMap((texture) =>
        Object.values(built.bindings.fragment ?? {})
          .flat()
          .filter((binding) => binding.texture === texture)
          .map((binding) => binding.name),
      ),
    );
    // A bound-but-unused texture performs no read; inspect every binding the shader actually samples.
    return allBindingNames(built).filter(
      (name) => !kept.has(name) && reads(built.fragmentShader, [name]).length > 0,
    );
  };
  return { ...proof, ao, depth, denoiser, gtao, normal, occlusion, unretained };
};

describe("canonical ambient occlusion under a retained sub-rectangle", () => {
  it.each([0, 4])(
    "compiles unretained GTAO depth at %i samples without invalid mip arguments",
    (samples) => {
      const proof = canonical("ambientOcclusion", { samples }, false);
      try {
        const ao = proof.own<Node & { _material: unknown }>("_aoRenderTarget", "real GTAO node");
        const gtao = proof.compileMaterial(ao._material);
        const names = bindingNames(gtao, proof.depth);
        expect(names.length).toBeGreaterThan(0);
        expect(reads(gtao.fragmentShader, names).length).toBeGreaterThanOrEqual(9);
        if (samples > 0) {
          expect(gtao.fragmentShader).toContain("texture_depth_multisampled_2d");
          for (const name of names)
            expect(gtao.fragmentShader).not.toMatch(
              new RegExp(`textureDimensions\\(\\s*${name}\\s*,`),
            );
        }
      } finally {
        proof.close();
      }
    },
  );

  it.each([0, 4])("clamps every GTAO input read at %i samples to the retained view", (samples) => {
    const proof = stage(samples);
    try {
      const scene = proof.view(proof.depth);
      const fraction = namesOf(proof.gtao, [scene.viewFraction]);
      const half = namesOf(proof.gtao, [scene.halfTexel]);
      expect(fraction).not.toHaveLength(0);
      const depthNames = bindingNames(proof.gtao, proof.depth);
      if (samples > 0) {
        expect(proof.gtao.fragmentShader).toContain("texture_depth_multisampled_2d");
        for (const name of depthNames)
          expect(proof.gtao.fragmentShader).not.toMatch(
            new RegExp(`textureDimensions\\(\\s*${name}\\s*,`),
          );
      }
      const depthReads = reads(proof.gtao.fragmentShader, depthNames);
      // Core reconstructs AO normals from depth; the denoiser still samples the normal target.
      expect(depthReads.length).toBeGreaterThanOrEqual(9);
      if (samples > 0)
        for (const read of depthReads) expect(read).toMatch(/,\s*i32\(\s*0\s*\)\s*\)$/);
      const pairs = new Set(
        depthReads.map((read) => retainedViewOf(read, fraction, half)?.fraction),
      );
      // Every read is clamped by a live view uniform, and each sampler carries its own pair.
      expect(pairs.has(undefined)).toBe(false);
      // GTAO marches depth along its horizons, so every read site owns its own live pair.
      expect(pairs.size).toBe(depthReads.length);
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
      const activeExtent = proof.gtao.uniforms.fragment.find(
        (entry) =>
          entry.node.value instanceof Vector2 && entry.node.value.equals(new Vector2(928, 520)),
      )?.node.value;
      expect(activeExtent).toBeInstanceOf(Vector2);
      const capacity = [proof.ao._aoRenderTarget.width, proof.ao._aoRenderTarget.height];
      const reallocations = { count: 0 };
      proof.ao._aoRenderTarget.addEventListener("dispose", () => {
        reallocations.count += 1;
      });

      proof.controller.setScale(0.61);
      proof.draw(proof.output);
      proof.draw(proof.gtao);
      expect((activeExtent as Vector2).toArray()).toEqual([784, 440]);

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

interface IBlurMaterial extends NodeMaterial {
  colorTexture: { value: Texture | null };
  invSize: { value: Vector2 };
}
interface IBloom extends Node {
  _renderTargetBright: RenderTarget;
  _renderTargetsHorizontal: RenderTarget[];
  _renderTargetsVertical: RenderTarget[];
  _separableBlurMaterials: IBlurMaterial[];
  _highPassFilterMaterial: NodeMaterial;
  _compositeMaterial: NodeMaterial;
}
interface ISmaa extends Node {
  _renderTargetEdges: RenderTarget;
  _renderTargetWeights: RenderTarget;
  _renderTargetBlend: RenderTarget;
  _areaTexture: Texture;
  _searchTexture: Texture;
  _materialEdges: NodeMaterial;
  _materialWeights: NodeMaterial;
  _materialBlend: NodeMaterial;
}

describe("canonical bloom under a retained sub-rectangle", () => {
  it("clamps every bloom pass read to the view of the target that pass binds", () => {
    const proof = canonical("bloom");
    try {
      const bloom = proof.own<IBloom>("_renderTargetBright", "real bloom node");
      // The pass hands each blur material its colour texture while it runs. Binding the very
      // target it draws from is what lets the compiled shader name the texture it will sample.
      for (const [index, material] of bloom._separableBlurMaterials.entries()) {
        material.colorTexture.value = at(bloom._renderTargetsHorizontal, index).texture;
      }
      const passes: [string, IBuilt][] = [
        ["high pass", proof.compileMaterial(bloom._highPassFilterMaterial)],
        ...bloom._separableBlurMaterials.map((material, index): [string, IBuilt] => [
          `blur ${index}`,
          proof.compileMaterial(material),
        ]),
        ["composite", proof.compileMaterial(bloom._compositeMaterial)],
        ["output", proof.output],
      ];
      let retained = 0;
      for (const [name, built] of passes) {
        const count = expectOwnViewClamps(built, proof.controller);
        expect(count.retained, `${name} retained reads`).toBeGreaterThan(0);
        retained += count.retained;
      }
      // Five blur materials, the bright target they all trace back to, five vertical mips and
      // the composite output: the whole chain is sampled inside its own views.
      expect(retained).toBeGreaterThanOrEqual(10);
    } finally {
      proof.close();
    }
  });

  it("gives every mip its own view and a texel size that follows the view, not the capacity", () => {
    const proof = canonical("bloom");
    try {
      const bloom = proof.own<IBloom>("_renderTargetBright", "real bloom node");
      const fractions: number[] = [];
      for (const [index, material] of bloom._separableBlurMaterials.entries()) {
        const horizontal = at(bloom._renderTargetsHorizontal, index);
        const view = proof.view(horizontal.texture);
        const { width, height } = horizontal;
        expect(view.viewFraction.x).toBeLessThan(1);
        expect(view.viewFraction.y).toBeLessThan(1);
        // The capacity is whole; the viewport is the retained rectangle inside it.
        expect(horizontal.viewport.z).toBe(Math.round(view.viewFraction.x * width));
        expect(horizontal.viewport.w).toBe(Math.round(view.viewFraction.y * height));
        expect(horizontal.scissorTest).toBe(true);
        // One blur texel is one viewport texel, so the kernel width is the rectangle's.
        expect(material.invSize.value.x).toBeCloseTo(1 / horizontal.viewport.z, 6);
        expect(material.invSize.value.y).toBeCloseTo(1 / horizontal.viewport.w, 6);
        expect(view.halfTexel.toArray()).toEqual([0.5 / width, 0.5 / height]);
        fractions.push(view.viewFraction.x);
      }
      // Every mip halves the one above it, capacity and rectangle together.
      expect(new Set(fractions).size).toBe(1);
      const capacities = bloom._separableBlurMaterials.map(
        (_, index) => at(bloom._renderTargetsHorizontal, index).width,
      );
      expect(capacities).toEqual([640, 320, 160, 80, 40]);
      // The whole chain stays inside the half of the frame bloom resolves at.
      expect(bloom._renderTargetBright.width).toBe(640);
      expect(bloom._renderTargetBright.viewport.z).toBe(464);
    } finally {
      proof.close();
    }
  });

  it("moves a blur material's clamp to the new view when the pass rebinds its texture", () => {
    const proof = canonical("bloom");
    try {
      const bloom = proof.own<IBloom>("_renderTargetBright", "real bloom node");
      const material = at(bloom._separableBlurMaterials, 0);
      // The uniform a read is clamped by, and the view that uniform is carrying right now.
      const carried = (built: IBuilt, names: string[], view: IResolutionTextureView) => {
        const sites = reads(built.fragmentShader, names);
        expect(sites.length).toBeGreaterThan(0);
        const pair = retainedViewOf(
          sites[0] as string,
          maybeNamesOf(built, [view.viewFraction]),
          maybeNamesOf(built, [view.halfTexel]),
        );
        expect(pair).toBeDefined();
        return pair === undefined ? undefined : vectorOf(built, pair.fraction);
      };
      // The horizontal pass of mip 0 draws from the bright target...
      const bright = bloom._renderTargetBright.texture;
      material.colorTexture.value = bright;
      const horizontal = proof.compileMaterial(material);
      const textureNames = bindingNames(horizontal, bright);
      const brightView = proof.view(bright);
      expect(carried(horizontal, textureNames, brightView)).toBe(brightView.viewFraction);
      // ...and the vertical pass of the same material draws from its own horizontal mip. One
      // shader serves both, so the clamp can only follow the binding if the uniform is live.
      const mip = at(bloom._renderTargetsHorizontal, 0).texture;
      material.colorTexture.value = mip;
      proof.draw(horizontal);
      const mipView = proof.view(mip);
      expect(mipView).not.toBe(brightView);
      expect(carried(horizontal, textureNames, mipView)).toBe(mipView.viewFraction);
      expectOwnViewClamp(horizontal, mipView, reads(horizontal.fragmentShader, textureNames));
    } finally {
      proof.close();
    }
  });
});

describe("canonical spatial antialiasing under a retained sub-rectangle", () => {
  it("clamps every SMAA pass read to its own view and reads both LUTs whole", () => {
    const proof = canonical("antialias");
    try {
      const smaa = proof.own<ISmaa>("_renderTargetEdges", "real SMAA node");
      const passes: [string, IBuilt][] = [
        ["edges", proof.compileMaterial(smaa._materialEdges)],
        ["weights", proof.compileMaterial(smaa._materialWeights)],
        ["blend", proof.compileMaterial(smaa._materialBlend)],
        ["output", proof.output],
      ];
      let retained = 0;
      let whole = 0;
      for (const [name, built] of passes) {
        const count = expectOwnViewClamps(built, proof.controller);
        expect(count.retained, `${name} retained reads`).toBeGreaterThan(0);
        retained += count.retained;
        whole += count.whole;
      }
      expect(retained).toBeGreaterThanOrEqual(4);
      // The area and search tables are indexed by edge geometry, not by screen position.
      for (const lut of [smaa._areaTexture, smaa._searchTexture]) {
        expect(proof.controller.textureView(lut)).toBeUndefined();
      }
      // expectOwnViewClamps has already refused a retained clamp on every one of these reads.
      for (const lut of [smaa._areaTexture, smaa._searchTexture]) {
        const sites = passes.flatMap(([, built]) =>
          boundTextures(built)
            .filter(([, texture]) => texture === lut)
            .flatMap(([name]) => reads(built.fragmentShader, [name])),
        );
        expect(sites.length, lut.name).toBeGreaterThan(0);
      }
      expect(whole).toBeGreaterThan(0);
      // The three targets the pass owns each keep their own rectangle and capacity.
      const views = [
        smaa._renderTargetEdges,
        smaa._renderTargetWeights,
        smaa._renderTargetBlend,
      ].map((target) => proof.view(target.texture));
      for (const view of views) {
        expect(view.viewFraction.toArray()).toEqual([928 / 1280, 520 / 720]);
        expect(view.halfTexel.toArray()).toEqual([0.5 / 1280, 0.5 / 720]);
      }
    } finally {
      proof.close();
    }
  });

  it("scales FXAA's inverse size to the retained view, because FXAA owns no target", () => {
    const proof = canonical("antialias", { screenSpaceAA: "fxaa" });
    try {
      const fxaa = proof.own<Node & { _invSize: { value: Vector2 }; updateBefore(): void }>(
        "_invSize",
        "real FXAA node",
      );
      // FXAA samples the frame through the chain input, which the controller does retain.
      expect(proof.ownAll("_renderTargetEdges", "SMAA node FXAA must not build")).toHaveLength(0);
      const names = maybeNamesOf(proof.output, [fxaa._invSize.value]);
      expect(names.length).toBeGreaterThan(0);
      fxaa.updateBefore();
      expect(maybeNamesOf(proof.output, [fxaa._invSize.value])).toEqual(names);
      const input = Reflect.get(fxaa, "textureNode") as { value: { renderTarget: RenderTarget } };
      const view = proof.view(input.value.renderTarget.texture);
      expect(fxaa._invSize.value.x).toBeCloseTo(
        1 / input.value.renderTarget.width / view.viewFraction.x,
        6,
      );
      expect(fxaa._invSize.value.y).toBeCloseTo(
        1 / input.value.renderTarget.height / view.viewFraction.y,
        6,
      );
      expect(expectOwnViewClamps(proof.output, proof.controller).retained).toBeGreaterThan(0);
    } finally {
      proof.close();
    }
  });
});
