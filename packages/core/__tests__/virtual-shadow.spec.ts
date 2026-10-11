import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  FloatType,
  Frustum,
  HalfFloatType,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  type OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  RenderTarget,
  Scene,
  Sphere,
  SphereGeometry,
  type Texture,
  Vector3,
} from "three";
// @ts-expect-error Three's private texture manager has no public declaration; this test must exercise it directly.
import Textures from "three/src/renderers/common/Textures.js";
import {
  Fn,
  float,
  lightingContext,
  lights,
  mix,
  nodeObject,
  property,
  renderGroup,
  vec3,
  vec4,
} from "three/tsl";
import {
  DirectionalLightNode,
  LightingModel,
  type Node,
  type NodeBuilder,
  type NodeFrame,
  PhysicalLightingModel,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { VIRTUAL_SHADOW_MOVER_LAYER as PUBLIC_VIRTUAL_SHADOW_MOVER_LAYER } from "../src/index.js";
import {
  DISCRETE_LOD_SCHEMA_VERSION,
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  lodChainOf,
} from "../src/model-lod.js";
import { noteShadowRedrawGpuMs } from "../src/render-pass-budget.js";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_GATE_MARKER,
  VIRTUAL_SHADOW_MARKER,
  VIRTUAL_SHADOW_MOVER_LAYER,
  VIRTUAL_SHADOW_REFRESH_MARKER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  VirtualShadowNode,
  readVirtualShadowMarker,
} from "../src/render/virtual-shadow.js";
import { WorldImpostorSurface } from "../src/render/world-impostor-surface.js";
import { WorldImpostorAtlas } from "../src/render/world-impostor.js";
import { Heightfield } from "../src/world.js";

/**
 * The mechanism, without a GPU: level windows snap to their own texel grid, cached levels stay
 * stable while tracked casters render through mover maps, and the counters say so.
 */

function world(): { light: DirectionalLight; scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const light = new DirectionalLight(0xffffff, 1);
  light.position.set(0, 100, 0);
  light.target.position.set(0, 0, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(64, 64);
  scene.add(light);
  scene.add(light.target);
  const camera = new PerspectiveCamera(60, 1, 0.1, 500);
  scene.add(camera);
  return { camera, light, scene };
}

/** The two calls a frame makes on three's private texture manager for a shadow map. */
interface IThreeTextures {
  updateTexture(texture: Texture): void;
  updateRenderTarget(target: RenderTarget): void;
}

/** The stock shadow node's target factory, which three calls from `setupShadow`. */
interface IStockShadowTarget {
  readonly shadow: unknown;
  setupRenderTarget(
    shadow: unknown,
    builder: unknown,
  ): { depthTexture: Texture; shadowMap: RenderTarget };
}

/** The builder `setup` needs: a shadow-enabled renderer and an empty material context. */
const builder = {
  context: {},
  material: {},
  renderer: { shadowMap: { enabled: true } },
} as unknown as NodeBuilder;

/**
 * The engine frame clock this harness hands the node, in seconds. It advances a second per frame so
 * that every `invalidationDelay` is behind us from the second frame on — which is the behaviour the
 * node had before the delay existed, and so what the tests written against it mean. A test that is
 * *about* the delay passes its own times instead.
 */
let clock = 0;

function frameFor(camera: PerspectiveCamera, time?: number): NodeFrame {
  // A renderer, because a level only re-renders and only settles its window on a frame that can
  // draw: a frame with none never holds a window, and a node asked twice renders twice.
  clock += 1;
  return { camera, renderer: {}, time: time ?? clock } as unknown as NodeFrame;
}

function setupNode(light: DirectionalLight, options = {}): VirtualShadowNode {
  const node = new VirtualShadowNode(light, { marker: false, ...options });
  node.setup(builder);
  // The real render belongs to three's renderer: a level render is what a frame with a renderer
  // asks for, and this is the draw that is not the node's business under test. The tests that
  // watch the draw spy on these.
  stubLevelRenders(node);
  return node;
}

/** The real render belongs to three's renderer; the draw itself is not what these tests measure. */
function stubLevelRenders(node: VirtualShadowNode): void {
  for (const levelNode of [...node.levelNodes, ...node.moverNodes]) {
    (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () =>
      undefined;
  }
}

/**
 * Run frames until no level is waiting for the frame's single render.
 *
 * The node renders at most one level per frame, finest first, so a fresh node needs one frame per
 * level before every map holds something. A test about what a steady walk costs starts here; a
 * test about the scheduling itself counts the frames instead.
 */
function settle(node: VirtualShadowNode, camera: PerspectiveCamera): number {
  let frames = 0;
  do {
    node.updateBefore(frameFor(camera));
    frames += 1;
  } while (node.stats.deferred > 0 && frames < 16);
  return frames;
}

interface IShaderGraphBuilder extends NodeBuilder {
  setShaderStage(shaderStage: "fragment"): void;
  flowStagesNode(node: Node, output: "vec4"): { code: string };
}

function shadowGraphBuilder(reversedDepthBuffer = false): IShaderGraphBuilder {
  const object = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    reversedDepthBuffer,
    hasCompatibility: () => true,
    hasFeature: () => false,
    library: { fromMaterial: () => null },
    shadowMap: { enabled: true, type: 1 },
  };
  const graphBuilder = new WGSLNodeBuilder(
    object,
    renderer as never,
  ) as unknown as IShaderGraphBuilder;
  graphBuilder.setShaderStage("fragment");
  return graphBuilder;
}

/** Compile the real selection and stock frustum filter, without textures or a GPU. */
function levelDebugGraph(
  search: string,
  uv = [0.25, 0.75],
  options = {},
  reversedDepthBuffer = false,
  capture?: (built: Set<Node>) => void,
) {
  vi.stubGlobal("location", { search });
  const { light } = world();
  const node = new VirtualShadowNode(light, {
    clipExtents: [8, 32, 128, 512],
    marker: false,
    ...options,
  });
  const graphBuilder = shadowGraphBuilder(reversedDepthBuffer);
  const outgoingLight = property("vec3", "testOutgoingLight");
  const lightingModel = new LightingModel();
  graphBuilder.context = { lightingModel, outgoingLight };
  const root = node.setup(graphBuilder) as Node;
  for (const shadowNode of [...node.levelNodes, ...node.moverNodes]) {
    const stock = shadowNode as Node & {
      setup: (builder: NodeBuilder) => Node;
      setupShadowFilter: (builder: NodeBuilder, inputs: object) => Node;
    };
    vi.spyOn(stock, "setup").mockImplementation(() =>
      vec4(
        stock.setupShadowFilter(graphBuilder, {
          filterFn: ({ shadowCoord }: { shadowCoord: ReturnType<typeof vec3> }) =>
            float(0.6).add(shadowCoord.z.mul(0.01)),
          shadowCoord: vec3(uv[0], uv[1], 0.5),
        }) as never,
      ),
    );
  }
  const flow = graphBuilder.flowStagesNode(
    Fn(() => {
      const value = vec4(root as never).toVar("testShadowResult");
      outgoingLight.assign(vec3(0.4, 0.5, 0.6).mul(value.rgb));
      lightingModel.finish(graphBuilder);
      return vec4(outgoingLight, value.a);
    })() as unknown as Node,
    "vec4",
  );
  node.dispose();
  capture?.((graphBuilder as unknown as { nodes: Set<Node> }).nodes);
  return {
    code: flow.code.replace(/virtualShadowReceiverSlope\d+/gu, "virtualShadowReceiverSlope"),
    nodes: (graphBuilder as unknown as { nodes: Set<Node> }).nodes.size,
  };
}

it("keeps every receiver uniform in the render group, where a settled static receiver still reads it", () => {
  // The patched renderer skips object-group uploads for a settled static object, so a window
  // centre, mapped flag or offset in that group froze at the value the receiver settled with.
  let built = new Set<Node>();
  levelDebugGraph("", undefined, undefined, undefined, (nodes) => {
    built = nodes;
  });
  // Scalar and vector values the node writes from the CPU. Matrices are three's per-object inputs,
  // which belong to the object and stay right when it settles.
  const uniforms = [...built].filter((n) => {
    const value = (n as { value?: unknown }).value;
    return (
      (n as { isUniformNode?: boolean }).isUniformNode === true &&
      (typeof value === "number" ||
        (value as { isVector2?: boolean } | null)?.isVector2 === true ||
        (value as { isVector3?: boolean } | null)?.isVector3 === true)
    );
  });
  expect(uniforms.length).toBeGreaterThan(0);
  for (const node of uniforms) expect((node as { groupNode?: Node }).groupNode).toBe(renderGroup);
});

it("blends the fine shadow contribution continuously before its guard edge", () => {
  const flow = levelDebugGraph("").code;
  expect(flow).toContain("smoothstep(");
  expect(flow).toMatch(/virtualShadowValue = mix\(/u);
});

it.each([false, true])(
  "biases coarse PCF comparisons by measured receiver slope (reversed depth: %s)",
  (reversed) => {
    const code = levelDebugGraph("", [0.25, 0.75], {}, reversed).code;
    expect(code).toContain("virtualShadowReceiverSlope");
    expect(code).toContain("dpdx(");
    expect(code).toContain("dpdy(");
    expect(code.indexOf("dpdx(")).toBeLessThan(code.indexOf("if ("));
    expect(code).toMatch(
      reversed ? /\.z \+ .*virtualShadowReceiverSlope/u : /\.z - .*virtualShadowReceiverSlope/u,
    );
    const optedOut = levelDebugGraph("", [0.25, 0.75], { receiverPlaneBias: false }).code;
    expect(optedOut).not.toContain("virtualShadowReceiverSlope");
    expect(optedOut).not.toContain("dpdx(");
  },
);

describe("virtual shadow level diagnostic", () => {
  it.each([{ transmission: 0.8 }, { alphaTest: 0.5 }])(
    "should declare tint before every use in physical material builds (%j)",
    (parameters) => {
      vi.stubGlobal("location", { search: "?tnShadowLevels=1" });
      const { light, camera, scene } = world();
      const node = new VirtualShadowNode(light, { clipExtents: [8, 32], marker: false });
      node.setup(builder);
      light.shadow.shadowNode = node;
      const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
      renderer.shadowMap.enabled = true;
      vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
      vi.spyOn(renderer, "hasCompatibility").mockReturnValue(true);
      vi.spyOn(
        Reflect.get(renderer.backend, "capabilities"),
        "getUniformBufferLimit",
      ).mockReturnValue(65_536);
      for (const stock of [...node.levelNodes, ...node.moverNodes]) {
        const sampler = stock as Node & {
          setup: (builder: NodeBuilder) => Node;
          setupShadowFilter: (builder: NodeBuilder, inputs: object) => Node;
        };
        vi.spyOn(sampler, "setup").mockImplementation((materialBuilder) =>
          vec4(
            sampler.setupShadowFilter(materialBuilder, {
              filterFn: () => float(0.6),
              shadowCoord: vec3(0.25, 0.75, 0.5),
            }) as never,
          ),
        );
      }
      try {
        // The same shadow node is shared by independently compiled imported materials.
        for (let index = 0; index < 2; index += 1) {
          const material = new MeshPhysicalMaterial(parameters);
          const mesh = new Mesh(new BoxGeometry(), material);
          mesh.receiveShadow = true;
          // A real material build, reached through the same cast this file's other builders use:
          // the members a full material drives are not on the builder's published type.
          const materialBuilder = new WGSLNodeBuilder(mesh, renderer) as unknown as {
            build(): void;
            camera: PerspectiveCamera;
            fragmentShader: string;
            lightsNode: Node;
            scene: Scene;
          };
          materialBuilder.camera = camera;
          materialBuilder.scene = scene;
          materialBuilder.lightsNode = lights([light]);
          materialBuilder.build();
          const code = materialBuilder.fragmentShader;
          expect(code.match(/^\s*virtualShadowLevelTint\w*;\s*$/mu)).toBeNull();
          const uses = [...code.matchAll(/\bvirtualShadowLevelTint\w*\b/gu)];
          expect(uses.length).toBeGreaterThan(1);
          // Three declares a fragment `toVar` in module scope with an address space, so the
          // declaration reads `var<private> name : type;` and the bare `var name` this used to
          // look for was a shape three never emits — for any tint, correct or not.
          for (const use of uses.slice(1)) {
            expect(code.slice(0, use.index)).toContain(`var<private> ${use[0]} : vec3<f32>;`);
          }
          mesh.geometry.dispose();
          material.dispose();
        }
      } finally {
        node.dispose();
        vi.unstubAllGlobals();
      }
    },
  );

  it("should preserve the original graph when the URL flag is off", () => {
    try {
      const original = levelDebugGraph("");
      expect(original.nodes).toBeGreaterThan(0);
      expect(original.code).not.toContain("virtualShadowLevelTint");
      expect(levelDebugGraph("?tnShadowLevels=0")).toEqual(original);
      expect(levelDebugGraph("?tnShadowLevels=false")).toEqual(original);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should tint the selected sampler lookup without changing its shadow factor", () => {
    try {
      const original = levelDebugGraph("");
      const debug = levelDebugGraph("?scene=map-walk&tnShadowLevels=1");
      expect(debug.nodes).toBeGreaterThan(original.nodes);
      expect(debug.code).toContain("virtualShadowLevelTint");
      for (const rgb of ["1.0, 0.0, 0.0", "0.0, 1.0, 0.0", "0.0, 0.0, 1.0", "1.0, 1.0, 0.0"]) {
        expect(debug.code).toContain(`vec3<f32>( ${rgb} )`);
      }
      expect(debug.code).toContain("vec3<f32>( 0.0, 1.0, 1.0 )");
      expect(debug.code).toContain("vec3<f32>( 1.0, 0.0, 1.0 )");
      expect(
        debug.code.replace(/nodeVar\d+/gu, "nodeVar").match(/virtualShadowValue = [^;]+;/gu),
      ).toEqual(
        original.code.replace(/nodeVar\d+/gu, "nodeVar").match(/virtualShadowValue = [^;]+;/gu),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should read the URL once at setup, before the shader graph is built", () => {
    let reads = 0;
    vi.stubGlobal("location", {
      get search() {
        reads += 1;
        return "?tnShadowLevels=1";
      },
    });
    const { light } = world();
    const node = new VirtualShadowNode(light, { marker: false });
    try {
      node.setup(builder);
      node.setup(builder);
      expect(reads).toBe(1);
    } finally {
      node.dispose();
      vi.unstubAllGlobals();
    }
  });

  it.each(["basic", "physical"] as const)(
    "should overlay the final colour through Three's %s lighting context",
    (mode) => {
      vi.stubGlobal("location", { search: "?tnShadowLevels=1" });
      const { light, camera } = world();
      const node = new VirtualShadowNode(light, { clipExtents: [8], marker: false });
      const graphBuilder = shadowGraphBuilder();
      (graphBuilder as unknown as { camera: PerspectiveCamera }).camera = camera;
      graphBuilder.context = {
        setupNormal: () => vec3(0, 1, 0),
        setupClearcoatNormal: () => vec3(0, 1, 0),
        setupPositionView: () => vec3(0, 0, -1),
        setupModelViewProjection: () => vec4(0, 0, 0, 1),
      };
      node.setup(graphBuilder);
      light.shadow.shadowNode = node;
      graphBuilder.object.receiveShadow = true;
      const renderer = graphBuilder.renderer as unknown as {
        library: { getLightNodeClass: () => typeof DirectionalLightNode };
      };
      renderer.library.getLightNodeClass = () => DirectionalLightNode;
      for (const stock of [...node.levelNodes, ...node.moverNodes]) {
        vi.spyOn(
          stock as Node & { setup: (builder: NodeBuilder) => Node },
          "setup",
        ).mockReturnValue(vec4(0.6));
      }
      const model = mode === "physical" ? new PhysicalLightingModel(true) : new LightingModel();
      if (mode === "basic") {
        model.direct = ({ lightColor, reflectedLight }) => {
          nodeObject(reflectedLight.directDiffuse as Node<"vec3">).addAssign(lightColor as never);
        };
      }
      try {
        const flow = graphBuilder.flowStagesNode(
          vec4(lightingContext(lights([light]), model) as never, 1) as unknown as Node,
          "vec4",
        );
        expect(flow.code).toMatch(
          /(nodeVar\d+) = mix\( outgoingLight, virtualShadowLevelTint\w*, 0\.5 \);\s*outgoingLight = \1;\s*$/u,
        );
      } finally {
        node.dispose();
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("VirtualShadowNode", () => {
  it("should expose the mover layer from the main core entry point", () => {
    expect(PUBLIC_VIRTUAL_SHADOW_MOVER_LAYER).toBe(VIRTUAL_SHADOW_MOVER_LAYER);
  });

  it("should reject a non-positive map size and a non-increasing clip list by name", () => {
    const { light } = world();
    expect(() => new VirtualShadowNode(light, { mapSize: 0 })).toThrow(
      /TN_VIRTUAL_SHADOW_INVALID/u,
    );
    expect(() => new VirtualShadowNode(light, { moverMapSize: 0 })).toThrow(/moverMapSize/u);
    expect(() => new VirtualShadowNode(light, { clipExtents: [40, 10] })).toThrow(/increase/u);
    expect(() => new VirtualShadowNode(light, { lightDistance: -1 })).toThrow(/lightDistance/u);
  });

  it("should build one cached level per clip extent and add its lights beside the source light", () => {
    const { camera, light, scene } = world();
    const node = setupNode(light, { clipExtents: [8, 32, 128] });
    expect(node.levelLights).toHaveLength(3);
    node.updateBefore(frameFor(camera));
    for (const level of node.levelLights) expect(level.parent).toBe(scene);
    // One level per frame, finest first: the first frame renders the finest and defers the rest.
    expect(node.stats).toMatchObject({ cached: 2, levels: 3, rendered: 1, deferred: 2 });
    // The finest is the one whose map a fragment under the camera samples, so it is never the one
    // held back: the two coarse levels follow, one frame each, until nothing is deferred.
    expect(settle(node, camera)).toBe(2);
    expect(node.stats).toMatchObject({ levels: 3, rendered: 1, deferred: 0 });
    node.dispose();
    expect(
      scene.children.filter((child) => child.name.startsWith("VirtualShadowLevel")),
    ).toHaveLength(0);
  });

  it("should serve every level from cache while the camera stays inside its texel", () => {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    settle(node, camera);
    camera.position.set(0.02, 5, 0.02);
    node.updateBefore(frameFor(camera));
    camera.position.set(0.12, 5, 0.12);
    node.updateBefore(frameFor(camera));
    // The second frame spent its render on the coarse level the first one deferred; the third has
    // nothing left to do, which is the state this test is about.
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 2, moved: 0, rendered: 0 });
    const targets = node.levelLights.map((level) =>
      (level as unknown as { target: { position: { clone(): unknown } } }).target.position.clone(),
    );
    camera.position.set(0.2, 5, 0.2);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 2, moved: 0, rendered: 0 });
    node.levelLights.forEach((level, index) => {
      expect((level as unknown as { target: { position: unknown } }).target.position).toEqual(
        targets[index],
      );
    });
  });

  it("should invalidate cached levels when a caster is tracked or untracked", () => {
    const { camera, light, scene } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    settle(node, camera);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 2, rendered: 0 });

    const caster = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    scene.add(caster);
    node.trackCaster(caster);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({
      cached: 1,
      invalidated: 2,
      movers: 1,
      moverRenders: 2,
      rendered: 1,
      deferred: 1,
    });
    settle(node, camera);

    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 2, rendered: 0 });

    expect(node.untrackCaster(caster)).toBe(true);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({
      cached: 1,
      invalidated: 2,
      movers: 0,
      moverRenders: 0,
      rendered: 1,
      deferred: 1,
    });
    expect(settle(node, camera)).toBe(1);
  });

  it("should copy source shadow settings to cached and mover shadow nodes", () => {
    const { camera, light } = world();
    const filterNode = vi.fn();
    light.shadow.bias = -0.003;
    light.shadow.normalBias = 0.17;
    light.shadow.intensity = 0.35;
    light.shadow.radius = 3;
    light.shadow.blurSamples = 5;
    light.shadow.mapType = HalfFloatType;
    light.shadow.biasNode = float(0.01);
    (light.shadow as unknown as { filterNode: unknown }).filterNode = filterNode;
    const node = setupNode(light, { clipExtents: [8], mapSize: 64 });

    const shadowNodes = [...node.levelNodes, ...node.moverNodes];
    for (const shadowNode of shadowNodes) {
      const shadow = (shadowNode as unknown as { shadow: DirectionalLight["shadow"] }).shadow;
      expect(shadow).toMatchObject({
        bias: -0.003,
        blurSamples: 5,
        intensity: 0.35,
        mapType: HalfFloatType,
        normalBias: 0.17,
        radius: 3,
      });
      expect(shadow.biasNode).toBe(light.shadow.biasNode);
      expect((shadow as unknown as { filterNode: unknown }).filterNode).toBe(filterNode);
    }

    light.shadow.bias = 0.004;
    light.shadow.normalBias = 0.23;
    light.shadow.intensity = 0.62;
    light.shadow.radius = 6;
    light.shadow.blurSamples = 11;
    light.shadow.mapType = FloatType;
    const updatedFilterNode = vi.fn();
    light.shadow.biasNode = float(0.02);
    (light.shadow as unknown as { filterNode: unknown }).filterNode = updatedFilterNode;
    node.updateBefore(frameFor(camera));

    for (const shadowNode of shadowNodes) {
      const shadow = (shadowNode as unknown as { shadow: DirectionalLight["shadow"] }).shadow;
      expect(shadow).toMatchObject({
        bias: 0.004,
        blurSamples: 11,
        intensity: 0.62,
        mapType: FloatType,
        normalBias: 0.23,
        radius: 6,
      });
      expect(shadow.biasNode).toBe(light.shadow.biasNode);
      expect((shadow as unknown as { filterNode: unknown }).filterNode).toBe(updatedFilterNode);
    }
  });

  it("should combine stock intensity-adjusted shadow factors by the darker result", () => {
    const { light } = world();
    light.shadow.intensity = 0.35;
    const node = new VirtualShadowNode(light, { clipExtents: [8, 32], marker: false });
    const graphBuilder = shadowGraphBuilder();
    const root = node.setup(graphBuilder);
    expect(root).not.toBeNull();

    // ShadowNode already turns a raw factor into mix(1, raw, shadow.intensity). If the same
    // intensity is applied again by this node, two identical adjusted factors multiply instead
    // of preserving the darker one. The mocked stock nodes keep this test on the graph contract
    // while leaving their renderer-owned setup out of the unit test.
    const rawFactors = [0.2, 0.6, 0.2, 0.6];
    [...node.levelNodes, ...node.moverNodes].forEach((shadowNode, index) => {
      const raw = rawFactors[index];
      if (raw === undefined) return;
      vi.spyOn(
        shadowNode as Node & { setup: (builder: NodeBuilder) => Node },
        "setup",
      ).mockImplementation(() => vec4(mix(1, float(raw), float(light.shadow.intensity))));
    });

    const flow = graphBuilder.flowStagesNode(root as Node, "vec4");
    const adjusted = rawFactors.map((raw) => 1 - (1 - raw) * light.shadow.intensity);
    expect(Math.min(adjusted[0] ?? 1, adjusted[1] ?? 1)).toBeCloseTo(0.72);
    expect(Math.min(adjusted[0] ?? 1, adjusted[1] ?? 1)).not.toBeCloseTo(0.72 * 0.86);
    expect(flow.code).toMatch(/min\(/u);
    expect(flow.code).not.toMatch(/vec4<f32>[^\n]*\*\s*vec4<f32>/u);
    expect(flow.code).toContain("0.35");
    expect(flow.code).toContain("vec4<f32>( 1.0, 1.0, 1.0, 1.0 )");
  });

  it("should register every level target as three creates it, so a first render destroys no bound depth map", () => {
    // three's own texture manager, on a backend that records what it destroys. three re-versions a
    // target's depth texture on the target's first registration; when a bind group built during the
    // material build already holds that texture, the re-version destroys it and every later submit
    // through that bind group is `Destroyed texture [Texture "ShadowDepthTexture"] used in a submit`.
    const destroyed: string[] = [];
    const backend = {
      createDefaultTexture: () => undefined,
      createTexture: () => undefined,
      destroyTexture: (texture: { name: string }) => destroyed.push(texture.name),
      generateMipmaps: () => undefined,
      get: () => ({}),
      updateTexture: () => undefined,
    };
    const info = {
      createTexture: () => undefined,
      destroyTexture: () => undefined,
      memory: { renderTargets: 0 },
    };
    const textures = new Textures({}, backend, info) as IThreeTextures;
    const { light } = world();
    const node = new VirtualShadowNode(light, { clipExtents: [8, 32], mapSize: 64, marker: false });
    node.setup(builder);
    const targetBuilder = {
      createRenderTarget: (width: number, height: number) => new RenderTarget(width, height),
      renderer: { _textures: textures, reversedDepthBuffer: false },
    };
    const stockNodes = [...node.levelNodes, ...node.moverNodes] as unknown as IStockShadowTarget[];
    expect(stockNodes).toHaveLength(4);
    for (const stock of stockNodes) {
      // The order a frame runs in: the material build creates the target, the main pass binds its
      // depth texture, and only then does the level's first shadow render register the target.
      const { depthTexture, shadowMap } = stock.setupRenderTarget(stock.shadow, targetBuilder);
      textures.updateTexture(depthTexture);
      textures.updateRenderTarget(shadowMap);
    }
    expect(destroyed).toEqual([]);
  });

  it.each(["receiver", "heightfield"] as const)(
    "centres fine levels on a 120 m aerial camera's view focus using %s height",
    (surface) => {
      const { camera, light, scene } = world();
      const groundY = 20;
      if (surface === "heightfield") {
        scene.add(
          Heightfield.fromSampler({
            rows: 3,
            columns: 3,
            width: 512,
            depth: 512,
            origin: { x: 0, z: 0 },
            sampleHeight: (_x, z) => groundY - z * 0.05,
          }),
        );
      } else {
        const ground = new Mesh(new BoxGeometry(512, 1, 512), new MeshBasicMaterial());
        ground.position.y = groundY - 0.5;
        ground.receiveShadow = true;
        scene.add(ground);
      }
      const focus = new Vector3(0, surface === "heightfield" ? 27.5 : groundY, -150);
      camera.position.set(0, groundY + 120, 0);
      camera.lookAt(focus);
      scene.updateMatrixWorld(true);
      const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 512 });
      settle(node, camera);
      const expected = node.clipmap.project(focus);
      expect(node.clipmap.centerLight.u).toBeCloseTo(expected.u, 2);
      expect(
        node.clipmap.centerLight.v,
        "the fine window follows the framed ground, not the eye",
      ).toBeCloseTo(expected.v, 2);
      expect(node.clipmap.centerLight.w).toBeCloseTo(expected.w, 2);
      node.updateBefore(frameFor(camera));
      expect(node.stats.rendered).toBe(0);
      node.dispose();
    },
  );

  it("measures an aerial view focus without raycasting received triangles each frame", () => {
    // A streamed world holds thousands of receiving meshes: a per-frame triangle raycast over
    // them blocked Machinefall's main thread for seconds on its aerial views.
    const { camera, light, scene } = world();
    const ground = new Mesh(new BoxGeometry(512, 1, 512), new MeshBasicMaterial());
    ground.position.y = 19.5;
    ground.receiveShadow = true;
    scene.add(ground);
    camera.position.set(0, 140, 0);
    camera.lookAt(0, 20, -150);
    scene.updateMatrixWorld(true);
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 512 });
    const raycast = vi.spyOn(Mesh.prototype, "raycast");
    settle(node, camera);
    for (let frame = 0; frame < 10; frame += 1) node.updateBefore(frameFor(camera));
    expect(raycast, "aerial focus must not raycast every receiving mesh").not.toHaveBeenCalled();
    const expected = node.clipmap.project(new Vector3(0, 20, -150));
    expect(node.clipmap.centerLight.v).toBeCloseTo(expected.v, 2);
    raycast.mockRestore();
    node.dispose();
  });

  it("keeps a walking camera on eye follow with unchanged render and draw counts", () => {
    const { camera, light, scene } = world();
    scene.add(
      Heightfield.fromSampler({
        rows: 3,
        columns: 3,
        width: 512,
        depth: 512,
        origin: { x: 0, z: 0 },
        sampleHeight: () => 70,
      }),
    );
    const trunk = new Mesh(new BoxGeometry(8, 20, 8), new MeshBasicMaterial());
    trunk.position.set(8, 80, 0);
    trunk.castShadow = true;
    scene.add(trunk);
    scene.updateMatrixWorld(true);
    camera.position.set(0, 72, 0);
    camera.lookAt(0, 70, -150);
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 512 });
    settle(node, camera);
    const renders = node.stats.rendersTotal;
    for (let frame = 0; frame < 60; frame += 1) {
      node.updateBefore(frameFor(camera));
      expect(node.clipmap.centerLight).toEqual(node.clipmap.project(camera.position));
      expect(node.stats.rendered).toBe(0);
      expect(node.stats.perLevel.map((level) => level.draws)).toEqual([0, 0, 0]);
    }
    expect(node.stats.rendersTotal).toBe(renders);
    const eyeFollow = setupNode(light, {
      clipExtents: [24, 96, 320],
      mapSize: 512,
      followViewFocus: false,
      receiverPlaneBias: false,
    });
    settle(eyeFollow, camera);
    let draws = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      camera.position.x = frame * 0.5;
      node.updateBefore(frameFor(camera));
      eyeFollow.updateBefore(frameFor(camera));
      draws += node.stats.perLevel.reduce((total, level) => total + level.draws, 0);
      expect(node.stats.rendered).toBe(eyeFollow.stats.rendered);
      expect(node.stats.rendered).toBeLessThanOrEqual(1);
      expect(node.stats.perLevel.map((level) => level.draws)).toEqual(
        eyeFollow.stats.perLevel.map((level) => level.draws),
      );
      expect(node.clipmap.centerLight).toEqual(node.clipmap.project(camera.position));
    }
    expect(draws).toBeGreaterThan(0);
    eyeFollow.dispose();
    node.dispose();
  });

  it("should re-render only the level whose window moved by a whole texel", () => {
    const { camera, light } = world();
    // `refreshStep: 0` keeps the one-texel step this measures; the default holds the window still
    // until the centre has moved a fraction of the extent, which the test below covers.
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64, refreshStep: 0 });
    camera.position.set(0, 5, 0);
    settle(node, camera);
    // 0.3 crosses the finest texel (0.25) but not the coarse one (1.0).
    camera.position.set(0.3, 5, 0);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 1, deferred: 0, moved: 1, rendered: 1 });
    // Negative control: a level that never moves is never re-rendered.
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 2, rendered: 0 });
  });

  it("should hold a window still until the centre has moved `refreshStep` of its extent", () => {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    camera.position.set(0, 5, 0);
    settle(node, camera);
    // The finest extent is 8 m and the default step is an eighth of it, so 0.5 m is a fifth of a
    // step: the window holds and the level is served from cache.
    camera.position.set(0.5, 5, 0);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ moved: 0, rendered: 0, cached: 2 });
    // Past the step it re-renders, on the fixed world grid the step is a whole number of texels of.
    camera.position.set(1.5, 5, 0);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ moved: 1, rendered: 1 });
  });

  it("should keep stationary windows cached when their refresh steps change", () => {
    const { camera, light } = world();
    const node = setupNode(light, {
      clipExtents: [96, 320],
      mapSize: 512,
      refreshStep: [0.128, 0.128],
      adaptiveRefresh: false,
    });
    camera.position.copy(node.clipmap.unproject({ u: 100, v: -100 }));
    settle(node, camera);
    const origins = node.options.clipExtents.map((_, level) => node.clipmap.getWindow(level));
    const renders = node.stats.rendersTotal;
    try {
      for (const step of [0.164, 0.128, 0]) {
        node.clipmap.setRefreshStep(1, step);
        node.updateBefore(frameFor(camera));
        expect(node.stats, `stationary refreshStep=${String(step)}`).toMatchObject({
          moved: 0,
          rendered: 0,
          deferred: 0,
          rendersTotal: renders,
        });
        for (const [level, origin] of origins.entries()) {
          expect(node.clipmap.getWindow(level)).toMatchObject({
            minX: origin.minX,
            minY: origin.minY,
          });
        }
      }
    } finally {
      node.dispose();
    }
  });

  it("should re-render after moving exactly a refresh step plus one texel", () => {
    const { camera, light } = world();
    const extent = 320;
    const step = 0.164;
    const node = setupNode(light, {
      clipExtents: [extent],
      mapSize: 512,
      refreshStep: step,
      adaptiveRefresh: false,
    });
    camera.position.copy(node.clipmap.unproject({ u: 100, v: -100 }));
    settle(node, camera);
    const origin = node.clipmap.getWindow(0);
    const renders = node.stats.rendersTotal;
    try {
      camera.position.copy(
        node.clipmap.unproject({ u: 100 + step * extent + origin.pageWorldSize, v: -100 }),
      );
      node.updateBefore(frameFor(camera));
      expect(node.stats).toMatchObject({ moved: 1, rendered: 1, rendersTotal: renders + 1 });
      expect(node.clipmap.getWindow(0).minX).not.toBe(origin.minX);
      expect(node.clipmap.getWindow(0).minY).toBe(origin.minY);
      node.updateBefore(frameFor(camera));
      expect(node.stats).toMatchObject({ moved: 0, rendered: 0, cached: 1 });
    } finally {
      node.dispose();
    }
  });

  it("should default adaptiveRefresh off under ?tnAdaptiveRefresh=0 and keep an explicit value", () => {
    const { light } = world();
    const nodes: VirtualShadowNode[] = [];
    try {
      vi.stubGlobal("location", { search: "?tnAdaptiveRefresh=0" });
      const defaulted = setupNode(light, { clipExtents: [320] });
      nodes.push(defaulted);
      const explicit = setupNode(light, { clipExtents: [320], adaptiveRefresh: true });
      nodes.push(explicit);
      expect(defaulted.options.adaptiveRefresh).toBe(false);
      expect(explicit.options.adaptiveRefresh).toBe(true);
      vi.stubGlobal("location", { search: "?tnAdaptiveRefresh=1" });
      const other = setupNode(light, { clipExtents: [320] });
      nodes.push(other);
      expect(other.options.adaptiveRefresh).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      for (const node of nodes) node.dispose();
    }
  });

  it("should count window travel in pages whatever the frames sampled, where byMove counts renders", () => {
    const { camera, light } = world();
    const extent = 320;
    const step = 0.164;
    const options = {
      clipExtents: [extent],
      mapSize: 512,
      refreshStep: step,
      adaptiveRefresh: false,
    };
    const walk = (frames: number): { byMove: number; windowSteps: number } => {
      const node = setupNode(light, options);
      try {
        camera.position.copy(node.clipmap.unproject({ u: 100, v: -100 }));
        settle(node, camera);
        const before = node.stats;
        const stride = 4 * (step * extent + node.clipmap.getWindow(0).pageWorldSize);
        for (let frame = 1; frame <= frames; frame += 1) {
          camera.position.copy(
            node.clipmap.unproject({ u: 100 + (stride * frame) / frames, v: -100 }),
          );
          node.updateBefore(frameFor(camera));
        }
        return {
          byMove: node.stats.byMove - before.byMove,
          windowSteps: node.stats.windowSteps - before.windowSteps,
        };
      } finally {
        node.dispose();
      }
    };
    const once = walk(1);
    const sampled = walk(4);
    // One frame or four over the same path: four move renders against one, the same travel.
    expect(sampled.byMove).toBe(4);
    expect(once.byMove).toBe(1);
    expect(once.windowSteps).toBeGreaterThan(0);
    expect(sampled.windowSteps).toBe(once.windowSteps);
  });

  it("should refuse a refreshStep that would cost the selection guard its trailing edge", () => {
    const { light } = world();
    expect(() => setupNode(light, { clipExtents: [8, 32], refreshStep: 0.9 })).toThrow(RangeError);
  });

  it("should keep the mover contribution neutral and skip mover renders with no tracked casters", () => {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    for (const levelNode of node.levelNodes) {
      vi.spyOn(
        levelNode as Node & { updateShadow(frame: NodeFrame): void },
        "updateShadow",
      ).mockImplementation(() => undefined);
    }
    const moverSpies = node.moverNodes.map((moverNode) =>
      vi
        .spyOn(moverNode as Node & { updateShadow(frame: NodeFrame): void }, "updateShadow")
        .mockImplementation(() => undefined),
    );

    node.updateBefore({ camera, renderer: {} } as unknown as NodeFrame);

    expect(node.stats).toMatchObject({ movers: 0, moverRenders: 0 });
    expect(moverSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("should spend one level render per presented frame, not per render call", () => {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    // Three calls `updateBefore` once per `render()`, and a level render *is* a render, so the draw
    // the budget grants re-enters this method with a new render id. Every level is due on the first
    // frame of a fresh node, which is the case that spent three level renders in one presented frame
    // on `?scene=map-walk`.
    let reentered = 0;
    for (const levelNode of [...node.levelNodes, ...node.moverNodes]) {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        if (reentered < 4) {
          reentered += 1;
          node.updateBefore(frameFor(camera));
        }
      };
    }
    node.updateBefore(frameFor(camera));
    expect(reentered).toBeGreaterThan(0);
    expect(node.stats).toMatchObject({ deferred: 1, levels: 2, rendered: 1 });
    // Per level, finest first: the one that took the render, and the one held behind it. No caster
    // meshes are in this world, so the granted level reports a bill of zero.
    const noDraws = { chunkProxy: 0, cluster: 0, keys: 0, layer0: 0, small: 0, wide: 0 };
    expect(node.stats.perLevel).toEqual([
      {
        deferred: 0,
        draws: 0,
        drawsBy: noDraws,
        extent: 8,
        gateHidden: 0,
        gateScale: 1,
        invalidated: 0,
        moved: 1,
        rendered: 1,
      },
      {
        deferred: 1,
        draws: 0,
        drawsBy: noDraws,
        extent: 32,
        gateHidden: 0,
        gateScale: 1,
        invalidated: 0,
        moved: 1,
        rendered: 0,
      },
    ]);
    // The next presented frame spends its single render on the level the first one deferred, and
    // the frame after that has nothing left to do.
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ deferred: 0, rendered: 1 });
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 2, deferred: 0, rendered: 0 });
    expect(node.stats.perLevel.every((level) => level.rendered === 0)).toBe(true);
    node.dispose();
  });

  it("should draw a tracked caster through the mover layer every frame and leave the cached levels alone", () => {
    const { camera, light, scene } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    const mover = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const hoof = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    mover.add(hoof);
    scene.add(mover);
    node.trackCaster(mover);
    expect(hoof.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(true);
    camera.position.set(0, 5, 0);
    node.updateBefore(frameFor(camera));
    node.updateBefore(frameFor(camera));
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ movers: 1, moverRenders: 2, rendered: 0, deferred: 0 });
    // A step — and a breathing idle would do the same — is a mover-map render, never a level one.
    mover.position.set(2, 0, 2);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ cached: 2, moverRenders: 2, rendered: 0 });
    // Three frames, two level renders — the second one the frame after the first, because the node
    // renders one level per frame — and six level serves.
    expect(node.stats.reuseRatio).toBeCloseTo(6 / 8);
    expect(node.untrackCaster(mover)).toBe(true);
    expect(hoof.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(false);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({
      cached: 1,
      invalidated: 2,
      moverRenders: 0,
      movers: 0,
      rendered: 1,
      deferred: 1,
    });
  });

  it("should restore a mover's pre-existing layer when it is untracked", () => {
    const { light } = world();
    const node = setupNode(light, { clipExtents: [8] });
    const mover = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mover.layers.enable(VIRTUAL_SHADOW_MOVER_LAYER);
    node.trackCaster(mover);
    expect(node.untrackCaster(mover)).toBe(true);
    expect(mover.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(true);
  });

  it("should keep explicit tracker invalidation working for existing callers", () => {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    settle(node, camera);
    node.tracker.update("manual", {
      min: { x: 0.2, y: 0, z: -0.8 },
      max: { x: 0.8, y: 2, z: -0.2 },
    });
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ invalidated: 2, rendered: 1, deferred: 1 });
    // The level the budget skipped stays due on the next frame: the reason it was due is cleared,
    // and only a sticky flag keeps it in the queue.
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ invalidated: 0, rendered: 1, deferred: 0 });
  });

  it("should keep a tracked caster out of the cached level render and put it back afterwards", () => {
    const { camera, light, scene } = world();
    const node = setupNode(light, { clipExtents: [8], mapSize: 64 });
    const mover = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mover.castShadow = true;
    scene.add(mover);
    node.trackCaster(mover);
    const seen: boolean[] = [];
    const levelNode = node.levelNodes[0] as unknown as { updateShadow(frame: NodeFrame): void };
    const moverNode = node.moverNodes[0] as unknown as { updateShadow(frame: NodeFrame): void };
    vi.spyOn(levelNode, "updateShadow").mockImplementation(() => seen.push(mover.castShadow));
    const moverSpy = vi.spyOn(moverNode, "updateShadow").mockImplementation(() => undefined);
    camera.position.set(0, 5, 0);
    node.updateBefore({ camera, renderer: {} } as unknown as NodeFrame);
    // The first frame places the level and renders it once, without the mover in it.
    expect(seen).toEqual([false]);
    expect(mover.castShadow).toBe(true);
    expect(moverSpy).toHaveBeenCalledTimes(1);
  });

  it("should re-render every level once after invalidateAll and count it as invalidated", () => {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    camera.position.set(0, 5, 0);
    settle(node, camera);
    node.invalidateAll();
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ invalidated: 2, rendered: 1, deferred: 1 });
    expect(settle(node, camera)).toBe(1);
    expect(node.stats).toMatchObject({ invalidated: 0, rendered: 1, deferred: 0 });
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ invalidated: 0, rendered: 0 });
  });

  it("should print the marker on the first frame and parse it back", () => {
    const { camera, light } = world();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const node = new VirtualShadowNode(light, { clipExtents: [8], marker: 2 });
      node.setup(builder);
      stubLevelRenders(node);
      node.updateBefore(frameFor(camera));
      node.updateBefore(frameFor(camera));
      const lines = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith(VIRTUAL_SHADOW_MARKER));
      expect(lines).toHaveLength(2);
      expect(readVirtualShadowMarker(lines[1] ?? "")).toMatchObject({
        frame: 2,
        levels: 1,
        rendered: 0,
      });
      expect(readVirtualShadowMarker("TN_FRAME_BUDGET:{}")).toBeUndefined();
      expect(readVirtualShadowMarker(`${VIRTUAL_SHADOW_MARKER}:{bad`)).toBeUndefined();
      expect(readVirtualShadowMarker(`${VIRTUAL_SHADOW_MARKER}:null`)).toBeUndefined();
      expect(readVirtualShadowMarker(`${VIRTUAL_SHADOW_MARKER}:{}`)).toBeUndefined();
      expect(
        readVirtualShadowMarker(
          `${VIRTUAL_SHADOW_MARKER}:${JSON.stringify({
            cached: 0,
            deferred: 0,
            frame: "2",
            invalidated: 0,
            levels: 1,
            moved: 1,
            moverRenders: 1,
            movers: 1,
            rendered: 1,
            reuseRatio: 0,
          })}`,
        ),
      ).toBeUndefined();
      expect(
        readVirtualShadowMarker(
          `${VIRTUAL_SHADOW_MARKER}:${JSON.stringify({
            cached: 0,
            deferred: 0,
            frame: 2,
            invalidated: 0,
            levels: 1,
            moved: 1,
            moverRenders: 1,
            movers: 1,
            rendered: 1,
          })}`,
        ),
      ).toBeUndefined();
      // `deferred` is part of the shape, so a marker from a node that does not report it — an
      // older log read by a newer harness, or one sliced in half — parses as nothing.
      expect(
        readVirtualShadowMarker(
          `${VIRTUAL_SHADOW_MARKER}:${JSON.stringify({
            cached: 0,
            frame: 2,
            invalidated: 0,
            levels: 1,
            moved: 1,
            moverRenders: 1,
            movers: 1,
            rendered: 1,
            reuseRatio: 0,
          })}`,
        ),
      ).toBeUndefined();
    } finally {
      info.mockRestore();
    }
  });

  it("should keep the measurement when the marker is silenced", () => {
    const { camera, light } = world();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const node = setupNode(light, { clipExtents: [8] });
      node.updateBefore(frameFor(camera));
      expect(info).not.toHaveBeenCalled();
      expect(node.stats.frame).toBe(1);
    } finally {
      info.mockRestore();
    }
  });

  it("should print the marker every 60 frames while ?tnShadowStats=1 is on the URL", () => {
    const { camera, light } = world();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("location", { search: "?scene=map-walk&tnShadowStats=1" });
    try {
      // The URL switch has to work on a launch that silenced the marker, or walking a world with
      // `marker: false` — which is what the harness passes — could not be measured at all.
      const node = new VirtualShadowNode(light, { clipExtents: [8], marker: false });
      node.setup(builder);
      stubLevelRenders(node);
      for (let frame = 0; frame < 180; frame += 1) node.updateBefore(frameFor(camera));
      const lines = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith(VIRTUAL_SHADOW_MARKER));
      // 180 frames at one line per 60 is three, and the last one is the frame itself.
      expect(lines).toHaveLength(3);
      expect(readVirtualShadowMarker(lines[2] ?? "")).toMatchObject({
        byInvalidation: 0,
        byMove: 1,
        coalesced: 0,
        frame: 180,
        held: 0,
        rendersTotal: 1,
      });
    } finally {
      vi.unstubAllGlobals();
      info.mockRestore();
    }
  });
});

/**
 * Invalidation coalescing: a streamed world asks its shadows for a redraw every residency update, and
 * a cell admitted at the ring edge lands in the coarsest window — the one level render that pays for
 * the whole ring's wide casters. So a dirty level waits out an `invalidationDelay` scaled by its own
 * extent before it redraws for an ask, and the cumulative counters say what that cost.
 */
describe("VirtualShadowNode invalidation coalescing", () => {
  /** The cascade the measurement used: delays of 0.25 s, 1 s and 3.33 s. */
  const CASCADE = { clipExtents: [24, 96, 320], mapSize: 64 };

  /**
   * One level render per frame, counted per level, so a test can say *which* level redrew. Call it
   * after the levels have settled: it replaces the draw for every frame from there on.
   */
  function countRenders(node: VirtualShadowNode): number[] {
    const counts = node.levelNodes.map(() => 0);
    node.levelNodes.forEach((levelNode, index) => {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        counts[index] = (counts[index] as number) + 1;
      };
    });
    return counts;
  }

  /**
   * Every level settled on a tight clock, one frame each 0.1 s apart, and the clock left at 0.4 s.
   * The harness clock steps a second per frame, which is past every delay; the delay is what these
   * tests are about, so they drive the engine's own `time` themselves.
   */
  function settleOnClock(node: VirtualShadowNode, camera: PerspectiveCamera): number {
    let time = 0;
    for (let frame = 0; frame < node.levelLights.length + 1; frame += 1) {
      time += 0.1;
      node.updateBefore(frameFor(camera, time));
    }
    return time;
  }

  /**
   * A region 250 m out, as `WorldCells` hands one over when a cell is admitted: inside the 640 m
   * window, outside the 192 m one. Whichever way the clipmap's axes fall, it is over 96 m out on
   * both, so only the coarse level is ever asked.
   */
  const RING_EDGE = { min: { x: 246, y: 0, z: -4 }, max: { x: 254, y: 8, z: 4 } };

  it("should turn 30 streamed invalidations of the coarse level in half a second into one render", () => {
    const { camera, light } = world();
    const node = setupNode(light, CASCADE);
    camera.position.set(0, 5, 0);
    let time = settleOnClock(node, camera);
    const renders = countRenders(node);
    const before = { ...node.stats };
    // A cell streaming in once a frame, half a second's worth.
    for (let ask = 0; ask < 30; ask += 1) {
      time += 1 / 60;
      node.invalidateRegion(RING_EDGE);
      node.updateBefore(frameFor(camera, time));
      expect(node.stats).toMatchObject({ held: 1, invalidated: 1, rendered: 0 });
    }
    expect(renders[2]).toBe(0);
    // Its own 3.33 s are what the level waits out, from its last render — so the first frame past
    // that redraws once, for all thirty asks.
    for (let step = 0; step < 40 && renders[2] === 0; step += 1) {
      time += 0.1;
      node.updateBefore(frameFor(camera, time));
    }
    expect(renders).toEqual([0, 0, 1]);
    expect(node.stats.rendersTotal - before.rendersTotal).toBe(1);
    expect(node.stats.byInvalidation - before.byInvalidation).toBe(1);
    // Twenty-nine asks merged into the one already waiting; the thirtieth is the render.
    expect(node.stats.coalesced - before.coalesced).toBe(29);
    expect(node.stats.byMove - before.byMove).toBe(0);
  });

  /**
   * One 500 m level, as Machinefall runs it, whose last redraw resolved at `redrawMs` of GPU. Returns
   * how long after the first of a stream of asks (one a frame) the level redrew for them.
   */
  function redrawAfter(redrawMs: number, options: { invalidationDelay?: number } = {}): number {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [250], mapSize: 64, ...options });
    camera.position.set(0, 5, 0);
    const renderer = {};
    const at = (time: number): NodeFrame => ({ camera, renderer, time }) as unknown as NodeFrame;
    let time = 0;
    for (let frame = 0; frame < 2; frame += 1) {
      time += 0.1;
      node.updateBefore(at(time));
    }
    noteShadowRedrawGpuMs(renderer, redrawMs);
    const renders = countRenders(node);
    const asked = time;
    for (let step = 0; step < 600 && renders[0] === 0; step += 1) {
      node.invalidateAll();
      time += 1 / 60;
      node.updateBefore(at(time));
    }
    expect(renders[0]).toBe(1);
    return time - asked;
  }

  it("should space a redraw that stalls a weak GPU to a tenth of the time", () => {
    // 300 ms of shadow GPU, as the Iris Xe measured: 3 s between redraws instead of 0.25 s.
    expect(redrawAfter(300)).toBeGreaterThan(2.8);
    expect(redrawAfter(300)).toBeLessThan(3.2);
  });

  it("should keep the base delay when a redraw is cheap or the game set its own", () => {
    // 5 ms is an RTX 2080's redraw: 50 ms of share, under the 0.25 s the level already waits.
    expect(redrawAfter(5)).toBeLessThan(0.3);
    expect(redrawAfter(300, { invalidationDelay: 0.25 })).toBeLessThan(0.3);
  });

  it("should still render the finest level within a quarter second of an invalidation", () => {
    const { camera, light } = world();
    const node = setupNode(light, CASCADE);
    camera.position.set(0, 5, 0);
    let time = settleOnClock(node, camera);
    const renders = countRenders(node);
    // The finest level rendered at 0.1 s, so its delay runs out at 0.35 s and the first frame at or
    // after that is its render. The coarse two are 1.2 s and 3.63 s away from their own.
    const asked = time;
    let finestAt: number | undefined;
    for (let step = 0; step < 20; step += 1) {
      time += 0.05;
      node.invalidateAll();
      node.updateBefore(frameFor(camera, time));
      if (finestAt === undefined && (renders[0] as number) > 0) finestAt = time;
    }
    expect(finestAt).toBeDefined();
    expect((finestAt as number) - asked).toBeLessThan(0.3);
    // It keeps answering rather than answering once, and the level the measurement is about — the
    // 3.33 s one, a whole second past the end of this run — has not rendered at all.
    expect(renders[0]).toBeGreaterThan(1);
    expect(renders[2]).toBe(0);
  });

  it("should not delay a render whose window moved", () => {
    const { camera, light } = world();
    const node = setupNode(light, { clipExtents: [8, 32], mapSize: 64, refreshStep: 0 });
    camera.position.set(0, 5, 0);
    settle(node, camera);
    const renders = countRenders(node);
    const before = { ...node.stats };
    // 0.3 crosses the finest texel (0.25) but not the coarse one (1.0): no invalidation anywhere.
    camera.position.set(0.3, 5, 0);
    node.updateBefore(frameFor(camera));
    expect(node.stats).toMatchObject({ moved: 1, rendered: 1 });
    expect(renders).toEqual([1, 0]);
    expect(node.stats.rendersTotal - before.rendersTotal).toBe(1);
    expect(node.stats.byMove - before.byMove).toBe(1);
    // An ask arriving on the frame a window moves is answered by that render rather than queued
    // behind the level's delay: the map it draws is already the new window's.
    node.invalidateAll();
    camera.position.set(0.6, 5, 0);
    node.updateBefore(frameFor(camera));
    expect(renders).toEqual([2, 0]);
    expect(node.stats.byMove - before.byMove).toBe(2);
    expect(node.stats.coalesced - before.coalesced).toBe(1);
    // And the ask is spent, so the level does not redraw a frame later for the same casters.
    node.updateBefore(frameFor(camera));
    expect(renders).toEqual([2, 1]);
    expect(node.stats.rendersTotal - before.rendersTotal).toBe(3);
    expect(node.stats.byInvalidation - before.byInvalidation).toBe(1);
  });

  it("should reproduce today's counts with invalidationDelay 0 and hold the level without it", () => {
    const { camera, light } = world();
    camera.position.set(0, 5, 0);
    // The same cascade twice, one switch off. Both nodes are on the same light: each owns its own
    // levels, so what the two of them do is comparable frame for frame.
    const off = setupNode(light, { clipExtents: [8, 32], mapSize: 64, invalidationDelay: 0 });
    const on = setupNode(light, { clipExtents: [8, 32], mapSize: 64 });
    expect(on.options.invalidationDelay).toEqual([0.25, 1]);
    expect(off.options.invalidationDelay).toEqual([0, 0]);
    for (const node of [off, on]) {
      for (let frame = 1; frame <= 4; frame += 1) node.updateBefore(frameFor(camera, frame * 0.1));
    }
    const offRenders = countRenders(off);
    const onRenders = countRenders(on);
    const offBefore = { ...off.stats };
    const onBefore = { ...on.stats };
    for (const node of [off, on]) node.invalidateAll();
    off.updateBefore(frameFor(camera, 0.5));
    on.updateBefore(frameFor(camera, 0.5));
    // The same asks and the same per-frame counters; the difference is entirely the coarse level's
    // 1 s delay, which holds it rather than deferring it behind the frame's budget.
    expect(off.stats).toMatchObject({ invalidated: 2, rendered: 1, deferred: 1, held: 0 });
    expect(on.stats).toMatchObject({ invalidated: 2, rendered: 1, deferred: 0, held: 1 });
    off.updateBefore(frameFor(camera, 0.6));
    on.updateBefore(frameFor(camera, 0.6));
    expect(offRenders).toEqual([1, 1]);
    expect(onRenders).toEqual([1, 0]);
    expect(off.stats.rendersTotal - offBefore.rendersTotal).toBe(2);
    expect(on.stats.rendersTotal - onBefore.rendersTotal).toBe(1);
  });

  it("should add up: every render is a move or an invalidation, every ask is answered or merged", () => {
    const { camera, light } = world();
    const node = setupNode(light, CASCADE);
    camera.position.set(0, 5, 0);
    let time = settleOnClock(node, camera);
    // A walk with a streaming world behind it: the windows keep moving and the levels keep being
    // asked, so both reasons and both halves of the invalidation accounting are exercised.
    let asks = 0;
    for (let step = 0; step < 200; step += 1) {
      time += 0.05;
      camera.position.set(step * 0.4, 5, 0);
      if (step % 3 === 0) node.invalidateAll();
      node.updateBefore(frameFor(camera, time));
      asks += node.stats.perLevel.filter((level) => level.invalidated === 1).length;
    }
    // Every ask has to be accounted for, so the run has to end with nothing still waiting: a level
    // still dirty at the end is an ask that has not been answered or merged yet, and the identity
    // below is only about asks that have been.
    for (let step = 0; step < 30; step += 1) {
      time += 0.5;
      node.updateBefore(frameFor(camera, time));
    }
    const { byInvalidation, byMove, coalesced, rendersTotal } = node.stats;
    expect(rendersTotal).toBe(byMove + byInvalidation);
    expect(byInvalidation + coalesced).toBe(asks);
    // Both halves really happened, or the identity above would pass on a node that did nothing.
    expect(byMove).toBeGreaterThan(0);
    expect(byInvalidation).toBeGreaterThan(0);
    expect(coalesced).toBeGreaterThan(0);
  });
});

/**
 * The two automatic fixes a level render makes for itself: a light-space depth derived from what can
 * actually shadow the window, and a caster size gate in texels of that level. Neither takes a game
 * value, so the world under them is the only thing that decides.
 */
/** Allocate the real stock target objects without registering anything with a GPU. */
function shadowTargets(node: VirtualShadowNode): RenderTarget[] {
  const graphBuilder = shadowGraphBuilder();
  return [...node.levelNodes, ...node.moverNodes].map((stock) => {
    const runtime = stock as Node & {
      shadow: DirectionalLight["shadow"];
      shadowMap: RenderTarget;
      setupRenderTarget(
        map: DirectionalLight["shadow"],
        builder: NodeBuilder,
      ): { shadowMap: RenderTarget };
    };
    const { shadowMap } = runtime.setupRenderTarget(runtime.shadow, graphBuilder);
    // The aliases established by stock setupShadow: both handles name the same target.
    runtime.shadowMap = shadowMap;
    runtime.shadow.map = shadowMap;
    return shadowMap;
  });
}

describe("virtual shadow target lifetime", () => {
  it.each(["node", "light"] as const)(
    "releases every cached and mover target exactly once on %s disposal",
    (owner) => {
      const { camera, light, scene } = world();
      const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 512 });
      const mover = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
      scene.add(mover);
      node.trackCaster(mover);
      settle(node, camera);
      const stocks = [...node.levelNodes, ...node.moverNodes];
      const targets = shadowTargets(node);
      const disposed = targets.map(() => 0);
      targets.forEach((target, index) =>
        target.addEventListener("dispose", () => {
          disposed[index] = (disposed[index] ?? 0) + 1;
        }),
      );
      if (owner === "node") node.dispose();
      else light.removeFromParent();
      expect(disposed, "each stock target has one owner, including light removal").toEqual([
        1, 1, 1, 1, 1, 1,
      ]);
      expect(node.levelNodes).toHaveLength(0);
      expect(node.moverNodes).toHaveLength(0);
      expect(scene.children.some((child) => child.name.startsWith("VirtualShadowLevel"))).toBe(
        false,
      );
      expect(mover.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(false);
      for (const stock of stocks)
        expect((stock as unknown as { shadow: DirectionalLight["shadow"] }).shadow.map).toBeNull();
      node.dispose();
      expect(disposed).toEqual([1, 1, 1, 1, 1, 1]);
    },
  );

  it.each([
    [[24, 96, 320], 512, 12],
    [[24, 320], 4096, 512],
  ] as const)(
    "accounts for the default PCF target storage of %s at %s",
    (clipExtents, mapSize, mebibytes) => {
      const { light } = world();
      const node = setupNode(light, { clipExtents, mapSize });
      const targets = shadowTargets(node);
      // RGBA8 colour + a 4-byte allowance for depth24plus (driver packing is implementation-specific).
      const bytes = targets.reduce((sum, target) => sum + target.width * target.height * 8, 0);
      expect(bytes / 1024 / 1024).toBe(mebibytes);
      expect(targets).toHaveLength(clipExtents.length * 2);
      for (const target of targets) {
        expect(target.texture.type).toBe(light.shadow.mapType);
        expect(target.depthTexture).not.toBeNull();
        expect(target.samples).toBe(0);
      }
      node.dispose();
    },
  );
});

describe("VirtualShadowNode derived depth and caster size gate", () => {
  /** A sun 38 degrees up, over the +z horizon: shadows fall to -z. */
  const SUN = new Vector3(0, 0.6157, 0.788);

  interface ITestWorld {
    readonly camera: PerspectiveCamera;
    readonly casters: readonly Mesh[];
    readonly light: DirectionalLight;
    readonly scene: Scene;
    readonly mass: Mesh;
    readonly small: Mesh;
    readonly tall: Mesh;
    /** A tower just beyond the window's up-sun edge, whose shadow lands back inside it. */
    readonly upSun: Mesh;
  }

  /** The bounding-sphere radius of the `4 x 4 x n` boxes standing on the ground. */
  const TOWER_RADIUS = Math.hypot(2, 2, 2);
  const TALL_RADIUS = Math.hypot(2, 10, 2);

  /**
   * A floor of casting tiles, one 500 m floor slab under it, a 4 m caster, a 20 m tower and a
   * second tower beyond the window's up-sun edge. Every caster is inside the finest window's u/v
   * box, so the span the level must cover is the union of their own extents and nothing else.
   */
  function shadowWorld(): ITestWorld {
    const { camera, light, scene } = world();
    camera.position.set(0, 10, 0);
    light.position.copy(SUN).multiplyScalar(200);
    light.target.position.set(0, 0, 0);
    light.target.updateMatrixWorld(true);
    light.updateMatrixWorld(true);
    const solid = new MeshStandardMaterial();
    // One slab the whole world could be: it is how a terrain tile that dwarfs the window reaches
    // the level, and its own span along the light is 500 m of depth nobody asked for.
    const mass = new Mesh(new BoxGeometry(500, 2, 500), solid);
    mass.position.set(0, -1, 0);
    mass.castShadow = true;
    scene.add(mass);
    const tiles: Mesh[] = [];
    for (let x = -1; x <= 1; x += 1) {
      for (let z = -1; z <= 1; z += 1) {
        const tile = new Mesh(new BoxGeometry(8, 2, 8), solid);
        tile.position.set(x * 8, -1, z * 8);
        tile.castShadow = true;
        scene.add(tile);
        tiles.push(tile);
      }
    }
    const small = new Mesh(new BoxGeometry(4, 4, 4), solid);
    small.position.set(-10, 2, 0);
    small.castShadow = true;
    scene.add(small);
    const tall = new Mesh(new BoxGeometry(4, 20, 4), solid);
    tall.position.set(10, 10, 0);
    tall.castShadow = true;
    scene.add(tall);
    const upSun = new Mesh(new BoxGeometry(4, 20, 4), solid);
    upSun.position.set(0, 10, 24 * Math.SQRT2);
    upSun.castShadow = true;
    scene.add(upSun);
    scene.updateMatrixWorld(true);
    return {
      camera,
      casters: [mass, ...tiles, small, tall, upSun],
      light,
      scene,
      mass,
      small,
      tall,
      upSun,
    };
  }

  /** The level's own placeholder light, which is where its shadow camera is placed and aimed. */
  function levelLight(node: VirtualShadowNode, level: number): Object3D {
    const light = node.levelLights[level];
    if (light === undefined) throw new Error(`no level ${String(level)}`);
    return light;
  }

  function levelCamera(node: VirtualShadowNode, level: number): OrthographicCamera {
    return (levelLight(node, level) as unknown as { shadow: DirectionalLight["shadow"] }).shadow
      .camera;
  }

  /**
   * Whether a level's frustum holds a world point, through its own projection and the view the
   * renderer builds for a directional shadow camera: its light's position, aimed at its target.
   * That aiming is the renderer's to do, and this harness has no renderer.
   */
  function holds(node: VirtualShadowNode, level: number, point: Vector3): boolean {
    const light = levelLight(node, level) as unknown as DirectionalLight;
    _aim.position.copy(light.position);
    _aim.up.set(0, 1, 0);
    _aim.lookAt(light.target.position);
    _aim.updateMatrixWorld(true);
    const p = _projected
      .copy(point)
      .applyMatrix4(_view.copy(_aim.matrixWorld).invert())
      .applyMatrix4(levelCamera(node, level).projectionMatrix);
    return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z >= -1 && p.z <= 1;
  }
  const _aim = new PerspectiveCamera();
  const _view = new Matrix4();
  const _projected = new Vector3();

  it.each(["wide", "horizon"] as const)(
    "should retain a %s pine's receiver column at both window placements (PRD-478)",
    (kind) => {
      const { camera, light, scene } = world();
      const sun = new Vector3(0, 0.3, Math.sqrt(1 - 0.3 ** 2));
      light.position.copy(sun).multiplyScalar(200);
      const extent = 24;
      const pineZ = (30 * sun.z) / sun.y;
      const centreZ = kind === "wide" ? (10 * sun.z) / sun.y : pineZ * 2 + extent * Math.SQRT2;
      const centre = new Vector3(0, (centreZ * sun.y) / sun.z, centreZ);
      const geometry = new BoxGeometry(4, 30, 4);
      const material = new MeshStandardMaterial();
      const pine =
        kind === "wide" ? new InstancedMesh(geometry, material, 2) : new Mesh(geometry, material);
      if (pine instanceof InstancedMesh) {
        pine.setMatrixAt(0, new Matrix4().makeTranslation(0, 15, pineZ));
        pine.setMatrixAt(1, new Matrix4().makeTranslation(256, 15, pineZ));
      } else pine.position.set(0, 15, pineZ);
      pine.castShadow = true;
      // Keep a local depth contributor when the old ground-distance filter drops the pine.
      const anchor = new Mesh(new BoxGeometry(2, 2, 2), material);
      anchor.position.copy(centre).x = 12;
      anchor.castShadow = true;
      const receiver = new Mesh(new BoxGeometry(4, 2, 4), material);
      receiver.position.y = -1;
      receiver.castShadow = true;
      scene.add(pine, anchor, receiver);
      scene.updateMatrixWorld(true);
      const node = setupNode(light, {
        clipExtents: [extent],
        mapSize: 64,
        minCasterTexels: 0,
        adaptiveRefresh: false,
        adaptiveCasterGate: false,
      });
      const stock = node.levelNodes[0] as unknown as {
        light: DirectionalLight;
        shadow: DirectionalLight["shadow"];
        updateShadow(frame: NodeFrame): void;
      };
      const submitted: number[][] = [];
      const depths: number[][] = [];
      const points = [new Vector3(-2, 30, pineZ - 2), new Vector3(2, 30, pineZ + 2), new Vector3()];
      stock.updateShadow = () => {
        stock.shadow.updateMatrices(stock.light);
        const frustum = new Frustum().setFromProjectionMatrix(
          new Matrix4().multiplyMatrices(
            stock.shadow.camera.projectionMatrix,
            stock.shadow.camera.matrixWorldInverse,
          ),
        );
        submitted.push(
          [pine, anchor, receiver]
            .filter(
              (mesh) =>
                mesh.visible &&
                mesh.castShadow &&
                mesh.layers.test(stock.shadow.camera.layers) &&
                frustum.intersectsObject(mesh),
            )
            .map((mesh) => mesh.id),
        );
        depths.push(points.map((point) => point.clone().applyMatrix4(stock.shadow.matrix).z));
      };
      try {
        for (const shift of [-8, 8]) {
          camera.position.copy(centre).addScaledVector(new Vector3(0, sun.z, -sun.y), shift);
          node.invalidateAll();
          node.updateBefore(frameFor(camera));
          for (const point of points) {
            const projected = point.clone().sub(stock.light.target.position);
            expect(Math.abs(projected.dot(new Vector3(0, sun.z, -sun.y)))).toBeLessThan(extent);
          }
        }
        expect(submitted, "both windows must submit the pine above the shared receiver").toEqual([
          [pine.id, anchor.id, receiver.id],
          [pine.id, anchor.id, receiver.id],
        ]);
        for (const [placement, column] of depths.entries())
          for (const depth of column) {
            expect(
              depth,
              `placement ${String(placement)} clips the receiver column before near`,
            ).toBeGreaterThanOrEqual(0);
            expect(
              depth,
              `placement ${String(placement)} clips the receiver column beyond far`,
            ).toBeLessThanOrEqual(1);
          }
      } finally {
        node.dispose();
      }
    },
  );

  it.each([
    ["cached", 20],
    ["cached", -20],
    ["delayed", 20],
    ["delayed", -20],
    ["deferred", 20],
    ["deferred", -20],
  ] as const)(
    "should sample %s maps at their rendered depth after light-axis motion of %s",
    (mode, delta) => {
      const { camera, light, tall } = shadowWorld();
      const node = setupNode(light, {
        clipExtents: [24, 96, 320],
        mapSize: 64,
        adaptiveRefresh: false,
        invalidationDelay: [10, 10, 10],
      });
      node.trackCaster(tall);
      const rendered = new Map<Node, Matrix4>();
      for (const shadowNode of [...node.levelNodes, ...node.moverNodes]) {
        const stock = shadowNode as unknown as {
          light: DirectionalLight;
          shadow: DirectionalLight["shadow"];
          updateShadow(frame: NodeFrame): void;
        };
        // Keep three's real render-time camera/matrix update; stub only the GPU draw.
        stock.updateShadow = () => {
          stock.shadow.updateMatrices(stock.light);
          rendered.set(shadowNode, stock.shadow.matrix.clone());
        };
      }
      try {
        settle(node, camera);
        const time = clock + 20;
        node.invalidateAll();
        for (let frame = 0; frame < 3; frame += 1) node.updateBefore(frameFor(camera, time));
        const renders = node.stats.rendersTotal;
        const { x, y, z } = node.clipmap.basisW;
        camera.position.addScaledVector(new Vector3(x, y, z), delta);
        if (mode !== "cached") node.invalidateAll();
        node.updateBefore(frameFor(camera, time + (mode === "deferred" ? 20 : 0.01)));
        expect(node.stats).toMatchObject({
          moved: 0,
          rendered: mode === "deferred" ? 1 : 0,
          deferred: mode === "deferred" ? 2 : 0,
          held: mode === "delayed" ? 3 : 0,
          rendersTotal: renders + (mode === "deferred" ? 1 : 0),
          moverRenders: 3,
        });
        const receiver = new Vector3(0, 0, 0);
        for (const [index, shadowNode] of node.levelNodes.entries()) {
          const stock = shadowNode as unknown as {
            light: DirectionalLight;
            shadow: DirectionalLight["shadow"];
          };
          const drawn = rendered.get(shadowNode);
          expect(drawn).toBeDefined();
          const drawnDepth = receiver.clone().applyMatrix4(drawn as Matrix4).z;
          // Both stock nodes sample through light.shadow.matrix, including the mover map.
          const sampledDepth = receiver.clone().applyMatrix4(stock.light.shadow.matrix).z;
          const moverMatrix = rendered.get(node.moverNodes[index] as Node);
          expect(moverMatrix).toBeDefined();
          const moverDepth = receiver.clone().applyMatrix4(moverMatrix as Matrix4).z;
          expect(
            sampledDepth,
            `${mode} level ${String(index)} samples its rendered depth`,
          ).toBeCloseTo(drawnDepth, 12);
          expect(
            moverDepth,
            `${mode} level ${String(index)} mover map uses cached sampling depth`,
          ).toBeCloseTo(sampledDepth, 12);
          expect(new Vector3().setFromMatrixPosition(stock.light.matrixWorld)).toEqual(
            stock.shadow.camera.position,
          );
          expect(stock.shadow.matrix.elements).toEqual(drawn?.elements);
          expect(moverMatrix?.elements).toEqual(drawn?.elements);
        }
      } finally {
        node.dispose();
      }
    },
  );

  /** One level render per frame, recording which of the world's casters were visible for each. */
  function watchCasters(node: VirtualShadowNode, small: Mesh, tall: Mesh): string[] {
    const seen: string[] = [];
    stubLevelRenders(node);
    node.levelNodes.forEach((levelNode, index) => {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        seen.push(`${String(index)}:${small.visible ? "s" : "-"}${tall.visible ? "t" : "-"}`);
      };
    });
    return seen;
  }

  it("should bracket every caster that can reach the window, and no more of the column", () => {
    const { camera, casters, light, mass, tall } = shadowWorld();
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 64 });
    settle(node, camera);
    // The span the level must cover, derived here from the world's own numbers: the 500 m slab the
    // window is cut out of, which is only its 2 m of height, and every other caster's own extent.
    const centre = (node.levelLights[0] as unknown as { target: { position: Vector3 } }).target
      .position;
    const side = 24 * Math.SQRT2;
    const along = (point: Vector3): number => point.clone().sub(centre).dot(SUN);
    const spans = casters
      .filter((mesh) => mesh !== mass)
      .map((mesh) => {
        const radius = (mesh.geometry.boundingSphere as Sphere).radius;
        return [along(mesh.position) - radius, along(mesh.position) + radius] as const;
      });
    const low = Math.min(
      (mass.position.y - 1 - centre.y - 24 * 0.788) / 0.6157,
      ...spans.map(([from]) => from),
    );
    const high = Math.max(
      (mass.position.y + 1 - centre.y + 24 * 0.788) / 0.6157,
      ...spans.map(([, to]) => to),
    );
    expect(levelCamera(node, 0).far - levelCamera(node, 0).near).toBeCloseTo(high - low, 1);
    // Everything that can shadow the window is inside it: the ground the window is cut out of, the
    // tower standing in it, and the tower whose shadow lands in it from beyond the up-sun edge.
    expect(holds(node, 0, new Vector3(0, 0, 0))).toBe(true);
    expect(holds(node, 0, new Vector3(10, 10 + TALL_RADIUS, 0))).toBe(true);
    expect(holds(node, 0, new Vector3(0, 10 + TALL_RADIUS, side))).toBe(true);
    // A point just beyond the last caster's depth is outside, even at the window's u/v centre.
    expect(holds(node, 0, centre.clone().addScaledVector(SUN, low - 1))).toBe(false);
    node.dispose();
  });

  it("should widen a level's depth for a caster standing beyond its up-sun edge", () => {
    const { camera, light, upSun } = shadowWorld();
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 64 });
    settle(node, camera);
    const withTower = levelCamera(node, 0).far - levelCamera(node, 0).near;
    // The same window with the tower just outside its up-sun edge taken away: its shadow lands
    // inside the window, so the depth that covers the ground alone would drop it.
    upSun.removeFromParent();
    node.invalidateAll();
    settle(node, camera);
    const withoutTower = levelCamera(node, 0).far - levelCamera(node, 0).near;
    expect(withTower).toBeGreaterThan(withoutTower);
    expect(holds(node, 0, new Vector3(0, 10 + TALL_RADIUS, 24 * Math.SQRT2))).toBe(false);
    node.dispose();
  });

  it("shades both sides of the fine guard edge with the same canopy in every level under load", () => {
    const { camera, light, scene } = world();
    light.position.set(0, 100, 100);
    const canopy = new Mesh(new BoxGeometry(8, 8, 8), new MeshBasicMaterial({ alphaTest: 0.5 }));
    canopy.position.set(21.6, 20, 20);
    canopy.castShadow = true;
    const ground = new Mesh(new BoxGeometry(640, 1, 640), new MeshBasicMaterial());
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    ground.castShadow = true;
    scene.add(canopy, ground);
    scene.updateMatrixWorld(true);
    const node = setupNode(light, {
      clipExtents: [24, 96, 320],
      mapSize: 512,
      adaptiveRefresh: false,
      invalidationDelay: 0,
    });
    const receivers = [new Vector3(21.5, 0, 0), new Vector3(21.7, 0, 0)];
    const ray = new Raycaster();
    const sun = new Vector3(0, 1, 1).normalize();
    const shades: boolean[][] = [];
    let milliseconds = 0;
    const timer = vi.spyOn(performance, "now").mockImplementation(() => milliseconds);
    node.levelNodes.forEach((stock, index) => {
      (stock as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        const level = node.levelLights[index] as DirectionalLight;
        level.shadow.updateMatrices(level);
        const frustum = level.shadow.getFrustum();
        shades[index] = receivers.map((receiver) => {
          ray.set(receiver, sun);
          return (
            canopy.visible &&
            canopy.castShadow &&
            level.shadow.camera.layers.test(canopy.layers) &&
            frustum.containsPoint(receiver) &&
            ray.intersectObject(canopy).length > 0
          );
        });
        milliseconds += 20;
      };
    });
    try {
      for (let round = 0; round < 12; round += 1) {
        node.invalidateAll();
        settle(node, camera);
      }
      expect(
        shades,
        "a resolvable canopy must shadow receivers on both sides in every map",
      ).toEqual([
        [true, true],
        [true, true],
        [true, true],
      ]);
      expect(node.stats.perLevel.slice(1).map((level) => level.gateScale)).toEqual([1, 1]);
      node.updateBefore(frameFor(camera));
      expect(node.stats.rendered).toBe(0);
      expect(node.stats.perLevel.map((level) => level.draws)).toEqual([0, 0, 0]);
    } finally {
      timer.mockRestore();
      node.dispose();
    }
  });

  it("should drop a sub-texel caster from a coarse level and keep it in the fine one", () => {
    const { camera, light, small, tall } = shadowWorld();
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 64 });
    const seen = watchCasters(node, small, tall);
    settle(node, camera);
    // Finest first, one render each: the 4 m caster is 6.9 m across, which is more than 1.5 texels
    // of the 48 m window and less than 1.5 of the 640 m one. The 20 m tower is in every level.
    expect(seen).toEqual(["0:st", "1:st", "2:-t"]);
    // Hidden for the level render, put back for the next camera.
    expect(small.visible && tall.visible).toBe(true);
    node.dispose();
  });

  it("should gate an unbundled small caster but never a bundled one (PRD-473)", () => {
    const { camera, light, scene, small } = shadowWorld();
    // A twin of the small caster, bundled: a bundle's render list is frozen when it records, so the
    // gate has to leave a bundled mesh alone while it still drops the identical unbundled one.
    const bundled = new Mesh(small.geometry, small.material as MeshStandardMaterial);
    bundled.position.set(0, 2, 0);
    bundled.castShadow = true;
    bundled.userData.tnBundled = true;
    scene.add(bundled);
    scene.updateMatrixWorld(true);
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 64 });
    const seen: string[] = [];
    stubLevelRenders(node);
    node.levelNodes.forEach((levelNode, index) => {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        seen.push(`${String(index)}:${small.visible ? "s" : "-"}${bundled.visible ? "b" : "-"}`);
      };
    });
    settle(node, camera);
    // The same 6.9 m caster the test above drops from the 640 m level: unbundled it is hidden there,
    // bundled it stays — and in every level the tower does.
    expect(seen).toEqual(["0:sb", "1:sb", "2:-b"]);
    expect(small.visible && bundled.visible).toBe(true);
    node.dispose();
  });

  it("should gate a world cluster on its part's radius, not the grid square it spans (PRD-458)", () => {
    const { camera, light, scene } = shadowWorld();
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 64 });
    // What a `WorldCells` cluster is: one `InstancedMesh` covering a whole grid square, so its own
    // sphere is 24 m of square. A fern inside it is 0.3 m, and the published scale says so.
    const fern = new InstancedMesh(new SphereGeometry(0.15, 6, 4), new MeshStandardMaterial(), 64);
    fern.boundingSphere = new Sphere(new Vector3(0, 1, 0), 24);
    fern.boundingBox = new Box3(new Vector3(-12, 0, -12), new Vector3(12, 2, 12));
    fern.castShadow = true;
    // A 0.15 m part placed at scale 10: 3 m of ground cover under a 48 m grid square.
    (fern as InstancedMesh & { casterInstanceScale?: number }).casterInstanceScale = 10;
    fern.position.set(-6, 0, 0);
    scene.add(fern);
    scene.updateMatrixWorld(true);

    const seen: string[] = [];
    stubLevelRenders(node);
    node.levelNodes.forEach((levelNode, index) => {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        seen.push(`${String(index)}:${fern.visible ? "f" : "-"}`);
      };
    });
    settle(node, camera);
    // 3 m across is over 1.5 texels of the 48 m window and under 1.5 of the 192 m and 640 m ones, so
    // it leaves the two coarse levels and stays in the fine one. Gated on its cluster's 48 m sphere
    // it was kept by all three and submitted a fern draw to two levels that could not resolve a
    // fragment of it — the whole gate, dropping nothing at all.
    expect(seen).toEqual(["0:f", "1:-", "2:-"]);
    expect(fern.visible).toBe(true);
    node.dispose();
  });

  it.each([false, true])(
    "invalidates cached maps on admission flips (tree arrival=%s)",
    (arrival) => {
      const { camera, light, scene, tall } = shadowWorld();
      const half = tall as Mesh & { mainAdmitted?: boolean };
      half.mainAdmitted = false;
      const node = setupNode(light, {
        clipExtents: [24, 96, 320],
        invalidationDelay: 0,
        mapSize: 64,
      });
      settle(node, camera);
      const renders: number[] = [];
      const visible: boolean[] = [];
      for (const [index, levelNode] of node.levelNodes.entries()) {
        (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
          renders.push(index);
          visible.push(tall.visible);
        };
      }
      node.updateBefore(frameFor(camera));
      expect(node.stats.rendered).toBe(0);
      const before = node.stats.byInvalidation;
      for (const admitted of [true, false]) {
        half.mainAdmitted = admitted;
        if (arrival) {
          // A far-away arrival rebuilds the table but covers none of these windows. It must
          // not swallow the older half's admission change when table flags are reseeded.
          const far = new Mesh(tall.geometry, tall.material as Material);
          far.position.set(10_000, 0, 0);
          far.castShadow = true;
          scene.add(far);
          scene.updateMatrixWorld(true);
        }
        renders.length = 0;
        visible.length = 0;
        node.updateBefore(frameFor(camera));
        expect(node.stats).toMatchObject({ invalidated: 3, rendered: 1, deferred: 2, moved: 0 });
        expect(renders).toEqual([0]);
        settle(node, camera);
        expect(renders).toEqual([0, 1, 2]);
        expect(visible).toEqual([admitted, admitted, admitted]);
        expect(tall.visible).toBe(true);
        node.updateBefore(frameFor(camera));
        expect(node.stats.rendered).toBe(0);
      }
      expect(node.stats.byInvalidation - before).toBe(6);
      node.dispose();
    },
  );

  it("should not invalidate cached maps when a tnShadowSwap caster flips visibility", () => {
    const invalidatedBy = (swap: boolean): number => {
      const { camera, light, tall } = shadowWorld();
      tall.userData.tnShadowSwap = swap;
      const node = setupNode(light, {
        clipExtents: [24, 96, 320],
        invalidationDelay: 0,
        mapSize: 64,
      });
      settle(node, camera);
      tall.visible = false;
      node.updateBefore(frameFor(camera));
      const { invalidated } = node.stats;
      node.dispose();
      return invalidated;
    };
    expect(invalidatedBy(true)).toBe(0);
    expect(invalidatedBy(false)).toBe(3);
  });

  it("should not redraw cached maps for an arriving mesh that casts nothing or is a swap twin", () => {
    const invalidatedByArrival = (castShadow: boolean, swap: boolean): number => {
      const { camera, light, scene, tall } = shadowWorld();
      const node = setupNode(light, {
        clipExtents: [24, 96, 320],
        invalidationDelay: 0,
        mapSize: 64,
      });
      settle(node, camera);
      const arrival = new Mesh(tall.geometry, tall.material as MeshStandardMaterial);
      arrival.position.copy(tall.position);
      arrival.castShadow = castShadow;
      arrival.userData.tnShadowSwap = swap;
      scene.add(arrival);
      node.updateBefore(frameFor(camera));
      const { invalidated } = node.stats;
      node.dispose();
      return invalidated;
    };
    // A streamed caster is a change every level covering it must draw; a mesh that casts nothing,
    // or terrain's swap twin over the same ground, is not.
    expect(invalidatedByArrival(true, false)).toBe(3);
    expect(invalidatedByArrival(false, false)).toBe(0);
    expect(invalidatedByArrival(true, true)).toBe(0);
  });

  it("should drop a caster the main pass cannot draw, and leave every other draw alone", () => {
    const { camera, light, scene, tall } = shadowWorld();
    /**
     * A twin of the world's own tower, carrying the answer `WorldCells` publishes for a caster half.
     * With the GPU scene on, a dressed main mesh draws from the dispatch's record and a batch the
     * scene holds no placement for draws none of it, while the caster half — never narrowed,
     * `#clustered` is false for every role but `main` — goes on submitting all of its records.
     */
    const twin = new Mesh(tall.geometry, tall.material as MeshStandardMaterial);
    twin.position.copy(tall.position);
    twin.castShadow = true;
    const flag = twin as Mesh & { mainAdmitted?: boolean };
    /**
     * Every level's submitted casts, this scene, with the twin admitted or not. `draws` is a frame's
     * row and a fresh node renders one level a frame, so a level's own render is kept.
     */
    const bill = (admitted: boolean): number[] => {
      flag.mainAdmitted = admitted;
      scene.add(twin);
      scene.updateMatrixWorld(true);
      // Outside the main view but still a valid caster for the light's window.
      const mainFrustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      expect(mainFrustum.intersectsBox(new Box3().setFromObject(twin))).toBe(false);
      const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 64 });
      stubLevelRenders(node);
      // Observe the actual render boundary: omitting a mesh from the probe's bill does not
      // stop three from drawing a visible caster on the selected layer.
      const seen: boolean[] = [];
      for (const levelNode of node.levelNodes) {
        (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
          seen.push(twin.visible);
        };
      }
      const drawn = node.levelNodes.map(() => 0);
      let frames = 0;
      do {
        node.updateBefore(frameFor(camera));
        node.stats.perLevel.forEach((level, index) => {
          drawn[index] = Math.max(drawn[index] as number, level.draws);
        });
        frames += 1;
      } while (node.stats.deferred > 0 && frames < 16);
      expect(seen).toEqual([admitted, admitted, admitted]);
      expect(twin.visible).toBe(true);
      node.dispose();
      scene.remove(twin);
      return drawn;
    };

    const withAdmitted = bill(true);
    const withPending = bill(false);

    // The admitted half is one draw in each level that covers it, so the spot is in those windows;
    // the same half unadmitted submits none of it in any of them.
    expect(withAdmitted).toEqual([14, 14, 4]);
    expect(withPending).toEqual([13, 13, 3]);
    expect(bill(true)).toEqual(withAdmitted);
    // Held out of the render, never out of the world: `visible` is what the next camera reads.
    expect(twin.visible).toBe(true);
  });

  it("should take each level's cheaper caster granularity, not a fraction of the ring (PRD-458)", () => {
    const { camera, light, scene } = shadowWorld();
    const node = setupNode(light, { clipExtents: [24, 96, 320], mapSize: 2048 });
    const solid = new MeshStandardMaterial();
    // One world holding both halves of three keys, as `WorldCells` writes them: 25 cluster squares
    // of 128 m under the player, and two keys outside the ring, each with two squares and one
    // key-wide mesh covering its own. A cluster stands in for a square, so its sphere is the
    // square's centre — the same centre the level's window is measured from.
    const squares: { x: number; z: number }[] = [];
    const cluster = (x: number, z: number): void => {
      const mesh = new Mesh(new BoxGeometry(8, 8, 8), solid);
      mesh.position.set(x, 4, z);
      mesh.castShadow = true;
      mesh.layers.set(VIRTUAL_SHADOW_CASTER_LAYER);
      scene.add(mesh);
      squares.push({ x, z });
    };
    let wides = 0;
    const wide = (x: number, z: number): void => {
      const mesh = new Mesh(new BoxGeometry(200, 8, 200), solid);
      mesh.position.set(x, 4, z);
      mesh.castShadow = true;
      mesh.layers.set(VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
      scene.add(mesh);
      wides += 1;
    };
    for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) cluster(x * 128, z * 128);
    for (const at of [768, -768]) {
      cluster(at, 0);
      cluster(at, 128);
      wide(at, 64);
    }
    scene.updateMatrixWorld(true);
    settle(node, camera);

    // What each level would submit either way: the cluster squares its window covers, against the
    // key-wide meshes waiting for it. A square inside the window is within a half-diagonal of the
    // centre whichever way the light is turned, so `extent * sqrt(2)` is the bound that holds.
    for (const [level, extent] of [24, 96, 320].entries()) {
      const inWindow = squares.filter(
        (square) => Math.hypot(square.x, square.z) <= extent * Math.SQRT2,
      ).length;
      const cheaper =
        inWindow < wides ? VIRTUAL_SHADOW_CASTER_LAYER : VIRTUAL_SHADOW_WIDE_CASTER_LAYER;
      const mask = levelCamera(node, level).layers.mask;
      const both = (1 << VIRTUAL_SHADOW_CASTER_LAYER) | (1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
      // The 48 m window: 1 square against 3 key-wide meshes, so clusters. The 192 m: 5 against 3,
      // and the 640 m: 25 against 3, so one mesh per key. The fraction-of-the-ring rule read all
      // three as 36% of a 768 m ring and clustered even the coarsest, at 29 draws where 3 do.
      expect(mask & both, `level ${String(level)} took the wrong granularity`).toBe(1 << cheaper);
    }
    node.dispose();
  });

  it("should keep every level's depth off a fixed range when the game pins one", () => {
    const { camera, light } = shadowWorld();
    const node = setupNode(light, {
      clipExtents: [24, 96, 320],
      lightDistance: 200,
      depthRange: 400,
    });
    settle(node, camera);
    for (const level of [0, 1, 2]) {
      const cameraForLevel = levelCamera(node, level);
      expect(cameraForLevel.near).toBe(1);
      expect(cameraForLevel.far).toBe(600);
    }
    node.dispose();
  });
});

describe("VirtualShadowNode shadow LOD bias and alpha-caster range", () => {
  interface IDraw {
    /** The level index whose render submitted this draw. */
    readonly level: number;
    readonly material: Material;
    readonly object: Mesh;
    /**
     * What three would actually draw: the cached render object is keyed on the object and re-reads
     * `object.geometry` itself, so the geometry argument is not what reaches the GPU.
     */
    readonly submitted: BufferGeometry;
  }

  type DrawGate = (
    object: Object3D,
    scene: Object3D,
    camera: unknown,
    geometry: BufferGeometry,
    material: Material,
  ) => void;

  /**
   * A renderer carrying an own-property `setRenderObjectFunction` that wraps whatever it is handed
   * and then draws through the function it captured when it was installed — which is what
   * `installDrawHook` in `renderer.ts` puts on a real renderer, and what this walk was measured on:
   * the function it is handed is never called, so a bias handed to this seam never runs.
   */
  function drawHost(): {
    readonly draws: IDraw[];
    /** The level whose pass is drawing, so the wrapper's own draw is recorded against it. */
    level: number;
    getRenderObjectFunction(): DrawGate | null;
    setRenderObjectFunction(fn: DrawGate | null): void;
  } {
    const draws: IDraw[] = [];
    let current: DrawGate | null = null;
    const host = {
      draws,
      level: -1,
      getRenderObjectFunction: () => current,
      setRenderObjectFunction: (fn: DrawGate | null) => {
        current = fn === null ? null : installed;
      },
    };
    const installed: DrawGate = (object, _scene, _camera, _geometry, material) => {
      const mesh = object as Mesh;
      // What three's own shadow gate reads, and where it reads the geometry from: the cached render
      // object is keyed on the object and re-reads `object.geometry` itself.
      if (mesh.castShadow !== true) return;
      draws.push({ level: host.level, material, object: mesh, submitted: mesh.geometry });
    };
    return host;
  }

  /** Wire each level node to the host, drawing the casters through whatever function is installed. */
  function watchDraws(
    node: VirtualShadowNode,
    host: ReturnType<typeof drawHost>,
    camera: PerspectiveCamera,
    casters: readonly Mesh[],
  ): void {
    const levels = [...node.levelNodes];
    for (const levelNode of levels) {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = (frame) => {
        const seam = frame.renderer as unknown as {
          getRenderObjectFunction(): DrawGate | null;
          setRenderObjectFunction(fn: DrawGate | null): void;
        };
        host.level = levels.indexOf(levelNode);
        const found = seam.getRenderObjectFunction();
        seam.setRenderObjectFunction(() => undefined);
        // Three draws through the function the renderer now holds, not the one it was handed.
        const installed = seam.getRenderObjectFunction();
        if (installed === null) throw new Error("the shadow pass installed no draw function.");
        for (const mesh of casters)
          installed(
            mesh,
            camera as unknown as Object3D,
            null,
            mesh.geometry,
            mesh.material as Material,
          );
        seam.setRenderObjectFunction(found);
      };
    }
  }

  /** A frame with the draw seam on it, which is the only frame a level renders on. */
  function drawFrame(camera: PerspectiveCamera, host: object): NodeFrame {
    return { camera, renderer: host, time: 0 } as unknown as NodeFrame;
  }

  /**
   * A grid over its own baked three-level chain, registered by the real plugin: the parser is the
   * only fake part, exactly as the chunk-merge fixture builds one.
   */
  async function chained(triangles = 8): Promise<Mesh> {
    const positions: number[] = [];
    for (let vertex = 0; vertex < triangles + 1; vertex += 1)
      positions.push(vertex / triangles, 0, 0, vertex / triangles, 1, 0);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(Float32Array.from(positions), 3));
    const indices = (count: number): Uint32Array => {
      const at = new Uint32Array(count * 3);
      for (let quad = 0; quad < count / 2; quad += 1) {
        const offset = quad * 6;
        at[offset] = quad * 2;
        at[offset + 1] = quad * 2 + 1;
        at[offset + 2] = quad * 2 + 2;
        at[offset + 3] = quad * 2 + 1;
        at[offset + 4] = quad * 2 + 3;
        at[offset + 5] = quad * 2 + 2;
      }
      return at;
    };
    geometry.setIndex(new BufferAttribute(indices(triangles), 1));
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    const plugin = new DiscreteLodPlugin();
    plugin.setParser({
      associations: new Map<object, { meshes: number; primitives: number }>([
        [mesh, { meshes: 0, primitives: 0 }],
      ]),
      getDependency: async (_type: string, index: number) => ({
        array: index === 0 ? indices(triangles / 2) : indices(triangles / 4),
      }),
      json: {
        meshes: [
          {
            primitives: [
              {
                extensions: {
                  [TN_DISCRETE_LOD]: {
                    absoluteErrors: [0.05, 0.2],
                    counts: [triangles / 2, triangles / 4],
                    errors: [0.05, 0.2],
                    indices: [0, 1],
                    lod0Triangles: triangles,
                    schemaVersion: DISCRETE_LOD_SCHEMA_VERSION,
                  },
                },
              },
            ],
          },
        ],
      },
    });
    await plugin.afterRoot({});
    plugin.attach(mesh, { hysteresis: 0.15, maxPixelError: 1 });
    return mesh;
  }

  /** Three levels, one render each: the finest first, so level `n` is drawn on frame `n`. */
  function renderAllLevels(node: VirtualShadowNode, camera: PerspectiveCamera, host: object): void {
    for (let frame = 0; frame < node.levelNodes.length; frame += 1)
      node.updateBefore(drawFrame(camera, host));
  }

  it("should draw a chained caster with its coarsest chain geometry on the coarse levels only", async () => {
    const { camera, light, scene } = world();
    const mesh = await chained();
    mesh.castShadow = true;
    scene.add(mesh);
    const chain = lodChainOf(mesh.geometry);
    if (chain === undefined) throw new Error("the plugin registered no chain.");
    const coarsest = chain.levels[chain.levels.length - 1] as BufferGeometry;
    expect(chain.levels).toHaveLength(3);
    const node = setupNode(light, { clipExtents: [24, 96, 320] });
    const host = drawHost();
    watchDraws(node, host, camera, [mesh]);
    renderAllLevels(node, camera, host);

    // Level 0 draws what the main pass draws; 96 m and 320 m windows cannot resolve LOD0, so they
    // draw the coarsest rung — the 2-triangle level, one draw over the mesh's own. This ran on the
    // renderer whose `setRenderObjectFunction` ignores the function it is handed, which is why it
    // holds where the draw-gate seam did not.
    expect(host.draws.map((draw) => draw.level)).toEqual([0, 1, 2]);
    expect(host.draws.map((draw) => draw.submitted)).toEqual([mesh.geometry, coarsest, coarsest]);
    // The mesh was never left on the coarse geometry: the swap lives inside one level's render.
    expect(mesh.geometry).toBe(chain.levels[0]);
    node.dispose();
  });

  it("should put every level back on full detail with shadowLodBias off", async () => {
    const { camera, light, scene } = world();
    const mesh = await chained();
    mesh.castShadow = true;
    scene.add(mesh);
    const node = setupNode(light, { clipExtents: [24, 96, 320], shadowLodBias: false });
    const host = drawHost();
    watchDraws(node, host, camera, [mesh]);
    renderAllLevels(node, camera, host);

    expect(host.draws.map((draw) => draw.submitted)).toEqual([
      mesh.geometry,
      mesh.geometry,
      mesh.geometry,
    ]);
    node.dispose();
  });

  it("should cast resolvable alpha-tested and opaque meshes into every level", () => {
    const { camera, light, scene } = world();
    // The two shapes `buildChunkShadowProxies` leaves behind: a cutout that keeps casting itself,
    // and the position-only proxy that stands in for a chunk's opaque half.
    const cutout = new Mesh(new BoxGeometry(4, 4, 4), new MeshBasicMaterial({ alphaTest: 0.5 }));
    cutout.position.set(-8, 2, 0);
    cutout.castShadow = true;
    const proxy = new Mesh(new BoxGeometry(64, 2, 64), new MeshBasicMaterial());
    proxy.position.set(0, -1, 0);
    proxy.castShadow = true;
    scene.add(cutout, proxy);
    const node = setupNode(light, { clipExtents: [24, 96, 320] });
    const host = drawHost();
    watchDraws(node, host, camera, [cutout, proxy]);
    renderAllLevels(node, camera, host);

    // Both kinds survive the handover; the size gate still removes sub-texel geometry.
    const levelsFor = (object: Mesh): number[] =>
      host.draws.filter((draw) => draw.object === object).map((draw) => draw.level);
    expect(levelsFor(cutout)).toEqual([0, 1, 2]);
    expect(levelsFor(proxy)).toEqual([0, 1, 2]);
    // The authored flags remain unchanged after every level.
    expect(cutout.castShadow).toBe(true);
    expect(proxy.castShadow).toBe(true);
    node.dispose();
  });

  it("should keep both whole-asset alpha impostors and resolvable source cutouts in coarse levels", () => {
    const { camera, light, scene } = world();
    // The three casters one biased window holds: an ordinary cutout card the coarse levels cannot
    // resolve, the opaque proxy that casts through its silhouette, and the world's whole-asset
    // impostor quad. The impostor's alpha-tested material looks like the card, but its cutout IS the
    // coarsest representation, so the biased skip must leave it in. `WorldImpostorSurface` marks its
    // own material; see `#probe`.
    const cutout = new Mesh(new BoxGeometry(4, 4, 4), new MeshBasicMaterial({ alphaTest: 0.5 }));
    cutout.position.set(-8, 2, 0);
    cutout.castShadow = true;
    const atlas = new WorldImpostorAtlas(8);
    const surface = new WorldImpostorSurface({
      atlas,
      center: new Vector3(0, 0, 0),
      radius: 6,
      source: new MeshBasicMaterial({ alphaTest: 0.5 }),
    });
    const whole = new Mesh(surface.geometry, surface.material);
    whole.position.set(8, 2, 0);
    whole.castShadow = true;
    const proxy = new Mesh(new BoxGeometry(64, 2, 64), new MeshBasicMaterial());
    proxy.position.set(0, -1, 0);
    proxy.castShadow = true;
    scene.add(cutout, whole, proxy);
    const node = setupNode(light, { clipExtents: [24, 96, 320] });
    const host = drawHost();
    watchDraws(node, host, camera, [cutout, whole, proxy]);
    renderAllLevels(node, camera, host);

    const levelsFor = (object: Mesh): number[] =>
      host.draws.filter((draw) => draw.object === object).map((draw) => draw.level);
    // The unmarked cutout still ends where the finest level's window ends...
    expect(levelsFor(cutout)).toEqual([0, 1, 2]);
    // ...but the marked whole-asset impostor casts through every biased level with the opaque proxy.
    expect(levelsFor(whole)).toEqual([0, 1, 2]);
    expect(levelsFor(proxy)).toEqual([0, 1, 2]);
    // Nothing was left disabled: the main pass and the next level's map still draw all three.
    expect(cutout.castShadow).toBe(true);
    expect(whole.castShadow).toBe(true);
    expect(proxy.castShadow).toBe(true);
    node.dispose();
    surface.dispose();
    atlas.dispose();
  });

  it("should draw both defaults off one walk, and leave the world exactly as authored", async () => {
    const { camera, light, scene } = world();
    // The two halves together, which is the shape a streamed chunk leaves behind: a chained mesh
    // that casts from its coarsest rung and a cutout that casts at all, in one window's walk.
    const tree = await chained();
    tree.position.set(12, 0, 0);
    tree.castShadow = true;
    const cutout = new Mesh(new BoxGeometry(4, 4, 4), new MeshBasicMaterial({ alphaTest: 0.5 }));
    cutout.position.set(-12, 2, 0);
    cutout.castShadow = true;
    scene.add(tree, cutout);
    const chain = lodChainOf(tree.geometry);
    if (chain === undefined) throw new Error("the plugin registered no chain.");
    const coarsest = chain.levels[chain.levels.length - 1] as BufferGeometry;
    const node = setupNode(light, { clipExtents: [24, 96, 320] });
    const host = drawHost();
    watchDraws(node, host, camera, [tree, cutout]);
    renderAllLevels(node, camera, host);

    const drawn = (object: Mesh): { level: number; submitted: BufferGeometry }[] =>
      host.draws
        .filter((draw) => draw.object === object)
        .map((draw) => ({ level: draw.level, submitted: draw.submitted }));
    // Level 0 is the main pass: both casters, both as authored. Level 1 is the first coarse one,
    // and it submits the coarsest rung while preserving the cutout.
    expect(drawn(tree)).toEqual([
      { level: 0, submitted: tree.geometry },
      { level: 1, submitted: coarsest },
      { level: 2, submitted: coarsest },
    ]);
    expect(drawn(cutout)).toEqual(
      [0, 1, 2].map((level) => ({ level, submitted: cutout.geometry })),
    );
    // Nothing left changed: the next level's map, the mover maps and the main pass draw the world
    // the game authored, which is what the walk cost has to be worth.
    expect(tree.geometry).toBe(chain.levels[0]);
    expect(tree.castShadow).toBe(true);
    expect(cutout.castShadow).toBe(true);
    node.dispose();
  });
});

/**
 * Adaptive refresh: a level whose own render costs a large share of the frame re-renders less often,
 * up to the widest trail its window can hold without the camera's own view of the level leaving the
 * map that view is served from. The walk is the one the measurement came from — a 20 m/s flyover at
 * 60 Hz over the 24 / 96 / 320 cascade, where the finest level is the one a camera re-renders most.
 */
describe("VirtualShadowNode adaptive refresh", () => {
  const CASCADE = { clipExtents: [24, 96, 320], mapSize: 64 };
  const PERIOD = 1 / 60;
  const SPEED = 20;
  const FRAMES = 115;
  /** Every level's step as configured: an eighth of its own extent. */
  const BASE = 0.125;
  /**
   * The half-width of the region a level serves around the window it was rendered with, as a share of
   * its extent: the configured guard of 0.9 less its step. What a window can trail by without
   * leaving the camera outside that region — the margin the widening is capped at — is the rest of
   * the extent.
   */
  const SERVED = 0.775;
  const SAFE = 1 - SERVED;
  /** Over the 0.4 share of a 16.7 ms frame by more than twice, so the widening runs to its cap. */
  const EXPENSIVE_MS = 15;

  interface IWalk {
    /** Level renders per level over the walk, settle included. */
    readonly renders: number[];
    /** The `TN_SHADOW_REFRESH` lines the walk printed. */
    readonly notes: string[];
    /** The widest trail each level's rendered window held from the camera, as a share of its extent. */
    readonly maxTrail: number[];
  }

  /**
   * A 20 m/s flyover, with `charges[i]` milliseconds charged to level `i`'s render. The draws are the
   * clock, so what the node measures around a render is that render's own cost.
   *
   * Every frame asserts the two things the widening owes, for every level: the camera is still inside
   * the region its own level serves (`trail <= extent * guard`), and that region is inside the
   * window the level rendered (`trail <= extent * (1 - guard)`). The second is the bound the cap is
   * written from; the first is what a trail past the margin would break, a level that has stopped
   * serving the ground the player is standing on.
   */
  function walk(charges: readonly number[], options: object = {}): IWalk {
    const { camera, light } = world();
    const node = setupNode(light, { ...CASCADE, ...options });
    const clock = { ms: 0 };
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const renders = node.levelNodes.map(() => 0);
    node.levelNodes.forEach((levelNode, index) => {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        renders[index] = (renders[index] as number) + 1;
        clock.ms += charges[index] ?? 0;
      };
    });
    const maxTrail = node.levelNodes.map(() => 0);
    let time = 0;
    try {
      for (let frame = 0; frame < FRAMES; frame += 1) {
        time += PERIOD;
        const walked = time * SPEED;
        camera.position.set(walked, 5, walked);
        node.updateBefore({
          camera,
          renderer: {},
          time,
          deltaTime: PERIOD,
        } as unknown as NodeFrame);
        const here = node.clipmap.project(camera.position);
        for (const [index, level] of node.levelLights.entries()) {
          const centre = (level as unknown as { target: { position: Vector3 } }).target.position;
          const there = node.clipmap.project(centre);
          const trail = Math.max(Math.abs(here.u - there.u), Math.abs(here.v - there.v));
          const extent = node.options.clipExtents[index] as number;
          const where = `level ${String(index)} at frame ${String(frame)}`;
          expect(
            trail,
            `${where} left the camera outside the region it serves`,
          ).toBeLessThanOrEqual(extent * SERVED);
          expect(
            trail,
            `${where} uncovered the region it serves from the map it is served out of`,
          ).toBeLessThanOrEqual(extent * SAFE);
          maxTrail[index] = Math.max(maxTrail[index] as number, trail / extent);
        }
      }
      return {
        maxTrail,
        notes: info.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith(VIRTUAL_SHADOW_REFRESH_MARKER)),
        renders,
      };
    } finally {
      now.mockRestore();
      info.mockRestore();
      node.dispose();
    }
  }

  /** The trail a `TN_SHADOW_REFRESH` line reports, as a number. */
  function trailOf(line: string): number {
    return Number(/ trail=([\d.]+)/u.exec(line)?.[1]);
  }

  it("should widen an expensive level's trail and re-render it less often over the walk", () => {
    const adapted = walk([EXPENSIVE_MS, 0, 0]);
    const today = walk([EXPENSIVE_MS, 0, 0], { adaptiveRefresh: false });
    // The same walk, the same costs, the same configured steps — and the fine level draws about
    // half as often, because the coarse two were already too wide to be what a walk re-renders.
    expect(adapted.renders[0]).toBeGreaterThan(0);
    expect(adapted.renders[0]).toBeLessThan(today.renders[0] as number);
    // It widened, and it widened to the margin rather than past it: the cap is what keeps the
    // camera's view inside the map, so a level four times over the share does not buy four times
    // the trail.
    expect(adapted.maxTrail[0]).toBeGreaterThan(BASE);
    expect(adapted.maxTrail[0]).toBeLessThanOrEqual(SAFE);
    expect(adapted.notes.length).toBeGreaterThan(0);
    for (const line of adapted.notes) {
      expect(line).toMatch(/^TN_SHADOW_REFRESH level=0 width=48 ms=\d+\.\d trail=[\d.]+$/u);
      expect(trailOf(line)).toBeGreaterThan(BASE);
      expect(trailOf(line)).toBeLessThanOrEqual(SAFE);
    }
    // At most one line a second for the level, so 1.92 s of walk prints two or fewer.
    expect(adapted.notes.length).toBeLessThanOrEqual(2);
  });

  it("should leave a cheap level exactly as it was, and say nothing about it", () => {
    const adapted = walk([EXPENSIVE_MS, 0, 0]);
    const allCheap = walk([0, 0, 0]);
    // Levels 1 and 2 are measured every frame and always under the share, so they are stepped with
    // the number they were configured with and render on exactly today's cadence.
    expect(adapted.renders.slice(1)).toEqual(allCheap.renders.slice(1));
    for (const index of [1, 2]) {
      expect(adapted.maxTrail[index]).toBeLessThanOrEqual(BASE);
    }
    // Nothing widened, so nothing is printed: the marker names a level that changed, not every one.
    expect(adapted.notes.some((line) => / level=1 | level=2 /u.test(line))).toBe(false);
    expect(allCheap.notes).toEqual([]);
  });

  it("should keep the camera inside what every level serves, and that inside its map, at every step", () => {
    // `walk` asserts both bounds on every frame of this walk, so this test is about the walk having
    // something to assert: a trail past `extent * (1 - guard)` is what leaves a fragment sampling
    // outside the map it is selected from, and one past `extent * guard` is what leaves the player
    // standing on a level that no longer serves them.
    const adapted = walk([EXPENSIVE_MS, 0, 0]);
    expect(adapted.maxTrail[0]).toBeGreaterThan(BASE);
    expect(adapted.maxTrail.every((trail) => trail <= SAFE && trail <= SERVED)).toBe(true);
  });

  it("should count today's renders with adaptiveRefresh off, expensive or not", () => {
    const off = walk([EXPENSIVE_MS, 0, 0], { adaptiveRefresh: false });
    const allCheap = walk([0, 0, 0]);
    const { camera, light } = world();
    const node = setupNode(light, { ...CASCADE, adaptiveRefresh: false });
    expect(node.options.adaptiveRefresh).toBe(false);
    // A level that costs 15 ms a render re-renders exactly as often as one that costs nothing: the
    // switch is the measurement's own, and without it the step is the configured one.
    expect(off.renders).toEqual(allCheap.renders);
    expect(off.maxTrail).toEqual(allCheap.maxTrail);
    expect(off.notes).toEqual([]);
    node.dispose();
  });

  it("should refuse a share of the frame period that is not a share of it", () => {
    const { light } = world();
    expect(() => setupNode(light, { expensiveRefreshShare: 0 })).toThrow(/expensiveRefreshShare/u);
    expect(() => setupNode(light, { expensiveRefreshShare: 1.5 })).toThrow(
      /TN_VIRTUAL_SHADOW_INVALID/u,
    );
    expect(setupNode(light).options.expensiveRefreshShare).toBe(0.4);
  });

  it("should default adaptiveRefresh to true", () => {
    const { light } = world();
    const node = setupNode(light);
    expect(node.options.adaptiveRefresh).toBe(true);
    node.dispose();
  });
});

/**
 * Adaptive caster gate: a level whose own render is over the frame's affordable share raises the
 * size a caster must be before it draws there, shedding its tiniest props until it is affordable
 * again and halving back once it is. The gate is a size test only, so a building never trips it, and
 * a level that is cheap is never touched. Same flyover as adaptive refresh, with a cast test in it.
 */
describe("VirtualShadowNode adaptive caster gate", () => {
  const CASCADE = { clipExtents: [24, 96], mapSize: 64 };
  const PERIOD = 1 / 60;
  const SPEED = 20;
  const FRAMES = 115;
  /** Over the 0.4 share of a 16.7 ms frame by more than twice. */
  const EXPENSIVE_MS = 15;

  interface IGateWalk {
    /** The gate scale each level held at the end of every frame, in order. */
    readonly scales: number[][];
    /** The casters each level's gate hid, as reported per frame; zero on a frame it did not render. */
    readonly hidden: number[][];
    /** Each level's reported draws per frame; zero on a frame it did not render. */
    readonly draws: number[][];
    /** The `TN_SHADOW_GATE` lines the walk printed. */
    readonly notes: string[];
    /** The `TN_SHADOW_REFRESH` lines the walk printed. */
    readonly refreshNotes: string[];
    /** Whether the tiny caster was ever hidden mid-render, across the whole walk. */
    readonly smallHidden: boolean;
    /** Whether the big caster was ever hidden mid-render — it must never be. */
    readonly bigHidden: boolean;
  }

  /**
   * A 20 m/s flyover over a two-level cascade with two casters under it. The 0.8 m box is ~1.39 m
   * across: over the fine level's 1.125 m base gate, so kept at scale 1, and under its 1.69 m gate at
   * scale 1.5, so the first over-budget render sheds it. The 20 m box is ~34.6 m across — larger than
   * the cap's 9 m gate — so it must never be in reach, whatever the scale. `charge` is the fake clock
   * each level's own render costs; the fine level is the expensive one.
   */
  function gateWalk(
    charge: (frame: number, level: number) => number,
    options: object = {},
    delta = PERIOD,
  ): IGateWalk {
    const { camera, light, scene } = world();
    const small = new Mesh(new BoxGeometry(0.8, 0.8, 0.8), new MeshStandardMaterial());
    small.position.set(0, 0.4, 0);
    small.castShadow = true;
    scene.add(small);
    const big = new Mesh(new BoxGeometry(20, 20, 20), new MeshStandardMaterial());
    big.position.set(0, 10, 0);
    big.castShadow = true;
    scene.add(big);
    scene.updateMatrixWorld(true);

    const node = setupNode(light, { ...CASCADE, ...options });
    const levels = node.levelNodes.length;
    const clock = { ms: 0 };
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let frame = 0;
    let smallHidden = false;
    let bigHidden = false;
    node.levelNodes.forEach((levelNode, index) => {
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        if (index === 0) {
          smallHidden ||= small.visible === false;
          bigHidden ||= big.visible === false;
        }
        clock.ms += charge(frame, index);
      };
    });

    const scales: number[][] = Array.from({ length: levels }, () => []);
    const hidden: number[][] = Array.from({ length: levels }, () => []);
    const draws: number[][] = Array.from({ length: levels }, () => []);
    const time = { value: 0 };
    try {
      for (frame = 0; frame < FRAMES; frame += 1) {
        time.value += PERIOD;
        const walked = time.value * SPEED;
        camera.position.set(walked, 5, walked);
        node.updateBefore({
          camera,
          renderer: {},
          time: time.value,
          deltaTime: delta,
        } as unknown as NodeFrame);
        node.stats.perLevel.forEach((stat, index) => {
          scales[index]?.push(stat.gateScale);
          hidden[index]?.push(stat.gateHidden);
          if (stat.rendered === 1) draws[index]?.push(stat.draws);
        });
      }
      const lines = info.mock.calls.map((call) => String(call[0]));
      return {
        bigHidden,
        draws,
        hidden,
        notes: lines.filter((line) => line.startsWith(VIRTUAL_SHADOW_GATE_MARKER)),
        refreshNotes: lines.filter((line) => line.startsWith(VIRTUAL_SHADOW_REFRESH_MARKER)),
        scales,
        smallHidden,
      };
    } finally {
      now.mockRestore();
      info.mockRestore();
      node.dispose();
    }
  }

  it("should raise an expensive level's gate, shed its tiniest caster and never the building", () => {
    const adapted = gateWalk((_frame, level) => (level === 0 ? EXPENSIVE_MS : 0));
    const pinned = gateWalk((_frame, level) => (level === 0 ? EXPENSIVE_MS : 0), {
      adaptiveCasterGate: false,
    });
    // The fine level rose past its base gate, and the tiny caster left its bill; the building never.
    expect(Math.max(...(adapted.scales[0] as number[]))).toBeGreaterThan(1);
    expect(adapted.smallHidden).toBe(true);
    expect(adapted.bigHidden).toBe(false);
    // It starts at the full bill and drops to the building alone once the gate passes the tiny one.
    expect(Math.max(...(adapted.draws[0] as number[]))).toBe(2);
    expect(Math.min(...(adapted.draws[0] as number[]))).toBe(1);
    // Today's counts, with the switch off: the tiny caster draws every time.
    expect((pinned.draws[0] as number[]).every((count) => count === 2)).toBe(true);
    expect(adapted.notes.length).toBeGreaterThan(0);
    for (const line of adapted.notes) {
      expect(line).toMatch(/^TN_SHADOW_GATE level=0 width=48 ms=\d+\.\d scale=[\d.]+ hidden=\d+$/u);
    }
  });

  it("should leave a cheap level at scale 1 and count exactly as adaptiveCasterGate off", () => {
    const adapted = gateWalk((_frame, level) => (level === 0 ? EXPENSIVE_MS : 0));
    const pinned = gateWalk((_frame, level) => (level === 0 ? EXPENSIVE_MS : 0), {
      adaptiveCasterGate: false,
    });
    // Level 1 is measured every frame and always under the share, so it is never adapted: scale 1,
    // and its draws are today's with or without the switch.
    expect((adapted.scales[1] as number[]).every((scale) => scale === 1)).toBe(true);
    expect(adapted.draws[1]).toEqual(pinned.draws[1]);
    expect((adapted.draws[1] as number[]).every((count) => count === 1)).toBe(true);
    expect(adapted.notes.some((line) => / level=1 /u.test(line))).toBe(false);
  });

  it("should decay the gate back toward 1 once the render becomes affordable", () => {
    // Expensive for the first 40 frames, then free: the smoothed cost halves each render, and the
    // gate halves back toward 1 only once that cost is under half the share.
    const adapted = gateWalk((frame, level) => (level === 0 && frame < 40 ? EXPENSIVE_MS : 0));
    expect(Math.max(...(adapted.scales[0] as number[]))).toBeGreaterThan(1);
    expect(adapted.scales[0]?.at(-1)).toBe(1);
  });

  it("should reproduce today's counts exactly with adaptiveCasterGate off", () => {
    const pinned = gateWalk((_frame, level) => (level === 0 ? EXPENSIVE_MS : 0), {
      adaptiveCasterGate: false,
    });
    expect(pinned.scales.every((level) => level.every((scale) => scale === 1))).toBe(true);
    // Level 0's base gate keeps both casters and hides neither; level 1's 4.5 m base gate already
    // hides the tiny one and keeps the building, exactly as before this gate existed.
    expect((pinned.hidden[0] as number[]).every((count) => count === 0)).toBe(true);
    expect((pinned.draws[0] as number[]).every((count) => count === 2)).toBe(true);
    expect((pinned.draws[1] as number[]).every((count) => count === 1)).toBe(true);
    expect(pinned.notes).toEqual([]);
  });

  it("should judge the budget against the 60 fps frame, not the frame the level inflated", () => {
    // The frame reads 50 ms because the level's own 9 ms render is in it. Read against that delta
    // the budget is 20 ms and 9 ms passes, so nothing widened — the bug. Capped at the 60 fps frame
    // the budget is 6.7 ms, 9 ms is over it, and the gate rises until the tiny caster leaves the
    // bill. A 120 Hz frame is stricter still; this is the same level under a long frame.
    const adapted = gateWalk((_frame, level) => (level === 0 ? 9 : 0), {}, 0.05);
    const pinned = gateWalk(
      (_frame, level) => (level === 0 ? 9 : 0),
      { adaptiveCasterGate: false },
      0.05,
    );
    expect(Math.max(...(adapted.scales[0] as number[]))).toBeGreaterThan(1);
    expect(adapted.smallHidden).toBe(true);
    expect(Math.min(...(adapted.draws[0] as number[]))).toBe(1);
    expect(pinned.scales[0]?.every((scale) => scale === 1)).toBe(true);
  });

  it("should ignore a level's first cold renders and never adapt from warm-up", () => {
    // The first two renders of a level compile its shaders and read 60 ms however cheap it is; the
    // rest cost 2 ms. Seeding the cost with a cold render would raise the gate and widen the trail
    // for a level that is not expensive at all. Both read the same cost, so the gate standing at 1
    // across the walk and no refresh line is the whole claim.
    const perLevel = new Map<number, number>();
    const cold = (_frame: number, level: number): number => {
      const seen = (perLevel.get(level) ?? 0) + 1;
      perLevel.set(level, seen);
      return level === 0 && seen <= 2 ? 60 : 2;
    };
    const adapted = gateWalk(cold);
    expect(adapted.scales[0]?.every((scale) => scale === 1)).toBe(true);
    expect(adapted.notes).toEqual([]);
    expect(adapted.refreshNotes).toEqual([]);
    expect(adapted.smallHidden).toBe(false);
  });
});

/**
 * PRD-572: casters sort themselves into static and moving. The node measures each layer-0 caster
 * every frame, so a game that never calls `trackCaster` still gets a shadow that follows a mover.
 */
describe("VirtualShadowNode automatic movers", () => {
  const OPTIONS = { clipExtents: [8, 32], mapSize: 64, staticAfterFrames: 3 };

  function scene20(): ReturnType<typeof world> & { node: VirtualShadowNode; mesh: Mesh } {
    const built = world();
    built.camera.position.set(0, 5, 0);
    const node = setupNode(built.light, OPTIONS);
    // Beyond the fine level's extent, inside the coarse one: a redraw that names the right
    // region asks one level, and a blanket invalidation asks both.
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mesh.castShadow = true;
    mesh.position.set(20, 0.5, 0);
    built.scene.add(mesh);
    return { ...built, mesh, node };
  }

  /** What the renderer does before a frame: compose the world matrices, then run the node. */
  function step(built: ReturnType<typeof scene20>): void {
    built.scene.updateMatrixWorld(true);
    built.node.updateBefore(frameFor(built.camera));
  }

  function steady(built: ReturnType<typeof scene20>): void {
    step(built);
    for (let i = 0; i < 4; i += 1) step(built);
    expect(built.node.stats).toMatchObject({ autoMovers: 0, autoTransitions: 0, rendered: 0 });
  }

  it("should make a moved caster a mover in that frame and redraw only where it stood", () => {
    const built = scene20();
    steady(built);
    built.mesh.position.x = 21;
    step(built);
    expect(built.node.stats).toMatchObject({
      autoMovers: 1,
      autoTransitions: 1,
      invalidated: 1,
      moverRenders: 2,
      movers: 0,
      rendered: 1,
    });
    // Only the coarse level covers x = 20; the fine one keeps its map.
    expect(built.node.stats.perLevel.map((level) => level.invalidated)).toEqual([0, 1]);
    expect(built.mesh.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(true);
    expect(built.mesh.castShadow).toBe(true);
  });

  it("should redraw every level that selects a caster's old spot on the frame it starts to move", () => {
    const built = scene20();
    // 7.5 m out: inside the fine level's 8 m extent but past its 6.2 m guarded window, so the old
    // blob is partly read from the coarse level. Both maps must lose it that frame, or the stale
    // blob and the mover's new one overlap into a double shadow until the coarse level catches up.
    built.mesh.position.x = 7.5;
    steady(built);
    built.mesh.position.x = 8.5;
    step(built);
    expect(built.node.stats.perLevel.map((level) => level.rendered)).toEqual([1, 1]);
    expect(built.node.stats.rendered).toBe(2);
  });

  it("should keep one render for a caster whose old spot the fine level holds alone", () => {
    const built = scene20();
    built.mesh.position.x = 2;
    steady(built);
    built.mesh.position.x = 3;
    step(built);
    // Level 0 holds the whole blob inside its guarded window, so the coarse level never selects
    // it; that level waits behind the frame's one render as before.
    expect(built.node.stats.perLevel.map((level) => level.rendered)).toEqual([1, 0]);
  });

  it("should give a mover the same texel density as the cached levels by default", () => {
    const built = scene20();
    expect(built.node.options.moverMapSize).toBe(OPTIONS.mapSize);
  });

  it("should keep a mover out of the cached level render while it moves", () => {
    const built = scene20();
    steady(built);
    const seen: boolean[] = [];
    const coarse = built.node.levelNodes[1] as unknown as { updateShadow(frame: NodeFrame): void };
    vi.spyOn(coarse, "updateShadow").mockImplementation(() => seen.push(built.mesh.castShadow));
    built.mesh.position.x = 21;
    step(built);
    expect(seen).toEqual([false]);
  });

  it("should send a quiet mover back to static with one redraw of where it stands", () => {
    const built = scene20();
    steady(built);
    built.mesh.position.x = 21;
    step(built);
    const quiet: number[] = [];
    for (let frame = 0; frame < 3; frame += 1) {
      step(built);
      quiet.push(built.node.stats.invalidated);
    }
    expect(built.node.stats).toMatchObject({ autoMovers: 0, autoTransitions: 2 });
    // The return asks the one level around x = 21 once, on the third quiet frame.
    expect(quiet).toEqual([0, 0, 1]);
    expect(built.node.stats.perLevel.map((level) => level.invalidated)).toEqual([0, 1]);
    // Its mover draw ended only once that redraw had taken it.
    expect(built.mesh.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(false);
    step(built);
    expect(built.node.stats).toMatchObject({ invalidated: 0, moverRenders: 0, rendered: 0 });
  });

  it("should draw a returning caster into the cached level that is asked for it", () => {
    const built = scene20();
    steady(built);
    built.mesh.position.x = 21;
    step(built);
    step(built);
    step(built);
    const seen: boolean[] = [];
    const coarse = built.node.levelNodes[1] as unknown as { updateShadow(frame: NodeFrame): void };
    vi.spyOn(coarse, "updateShadow").mockImplementation(() => seen.push(built.mesh.castShadow));
    step(built);
    expect(seen).toEqual([true]);
  });

  it("should make a caster that moves again while returning a mover in that frame", () => {
    const built = scene20();
    steady(built);
    built.mesh.position.x = 21;
    step(built);
    for (let frame = 0; frame < 3; frame += 1) step(built);
    built.mesh.position.x = 22;
    step(built);
    expect(built.node.stats).toMatchObject({ autoMovers: 1, autoTransitions: 3 });
  });

  it("should leave a pinned caster, a tracked caster and a non-casting one alone", () => {
    const built = scene20();
    const pinned = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    pinned.castShadow = true;
    pinned.position.set(-20, 0.5, 0);
    const tracked = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    tracked.castShadow = true;
    tracked.position.set(0, 0.5, 20);
    const quiet = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    quiet.castShadow = false;
    quiet.position.set(0, 0.5, -20);
    built.scene.add(pinned, tracked, quiet);
    built.node.pinStatic(pinned);
    built.node.trackCaster(tracked);
    steady(built);
    expect(built.node.stats).toMatchObject({ movers: 1 });
    for (const mesh of [pinned, tracked, quiet]) mesh.position.y += 1;
    step(built);
    expect(built.node.stats).toMatchObject({ autoMovers: 0, autoTransitions: 0, movers: 1 });
    expect(pinned.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(false);
    expect(quiet.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER)).toBe(false);
  });

  it("should treat a deforming mesh as moving every frame it is visible", () => {
    const built = scene20();
    steady(built);
    built.mesh.morphTargetInfluences = [0.5];
    for (let frame = 0; frame < 6; frame += 1) step(built);
    expect(built.node.stats).toMatchObject({ autoMovers: 1, autoTransitions: 1 });
    built.mesh.morphTargetInfluences = [0];
    for (let frame = 0; frame < 3; frame += 1) step(built);
    expect(built.node.stats).toMatchObject({ autoMovers: 0, autoTransitions: 2 });
  });

  it("should read an instance matrix change as movement and ask every level", () => {
    const built = scene20();
    const crowd = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
    crowd.castShadow = true;
    built.scene.add(crowd);
    steady(built);
    crowd.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
    crowd.instanceMatrix.needsUpdate = true;
    step(built);
    expect(built.node.stats).toMatchObject({ autoMovers: 1, invalidated: 2 });
  });

  it("should not call an arriving caster a mover", () => {
    const built = scene20();
    steady(built);
    const arrival = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    arrival.castShadow = true;
    arrival.position.set(20, 0.5, 5);
    built.scene.add(arrival);
    step(built);
    expect(built.node.stats).toMatchObject({ autoMovers: 0, autoTransitions: 0 });
  });

  it("should ask only the levels around a tracked caster, not all of them", () => {
    const built = scene20();
    steady(built);
    built.node.trackCaster(built.mesh);
    step(built);
    expect(built.node.stats.perLevel.map((level) => level.invalidated)).toEqual([0, 1]);
    built.node.untrackCaster(built.mesh);
    step(built);
    expect(built.node.stats.perLevel.map((level) => level.invalidated)).toEqual([0, 1]);
  });

  it("should reject a staticAfterFrames that is not a positive integer", () => {
    const { light } = world();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new VirtualShadowNode(light, { staticAfterFrames: bad })).toThrow(
        /TN_VIRTUAL_SHADOW_INVALID: staticAfterFrames/,
      );
    }
  });

  it("should carry the automatic counters through the marker", () => {
    const built = scene20();
    steady(built);
    built.mesh.position.x = 21;
    step(built);
    const parsed = readVirtualShadowMarker(
      `${VIRTUAL_SHADOW_MARKER}:${JSON.stringify(built.node.stats)}`,
    );
    expect(parsed).toMatchObject({ autoMovers: 1, autoTransitions: 1 });
    expect(built.node.stats.autoScanMs).toBeGreaterThanOrEqual(0);
  });
});
