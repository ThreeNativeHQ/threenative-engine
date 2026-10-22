import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Box3,
  BoxGeometry,
  Color,
  Data3DTexture,
  DepthTexture,
  DirectionalLight,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  RenderTarget,
  Scene,
  Texture,
  Vector3,
} from "three";
import { pass, texture3D } from "three/tsl";
import {
  ConditionalNode,
  type Node,
  type NodeBuilder,
  OperatorNode,
  WGSLNodeBuilder,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { setupSky } from "../templates/starter/src/render/sky.js";
import {
  type IVolumetricFogOptions,
  createVolumetricFog,
} from "../templates/starter/src/render/volumetricFog.js";

import { type OutputRenderer, WorldEnvironment } from "../template-assets/worldEnvironment.js";

/**
 * The owned engine's TSL front-end takes a node, a number, a string, a colour or a Vector2 to 4 as a uniform value
 * (packages/three-native/src/browser-tsl.ts, `argument`). A Matrix4 or a Box3 stops the game at start with
 * TN_TSL uniform, so every value the fog hands to `uniform()` is recorded here. The same front-end does not export
 * `getViewPosition` (the catalog marks it unsupported), so a call to it is recorded too.
 */
const refused: string[] = [];
vi.mock("three/tsl", async (importOriginal) => {
  const real = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
  return {
    ...real,
    getViewPosition: () => {
      refused.push("getViewPosition");
      return (real.vec3 as (...args: unknown[]) => unknown)(0);
    },
    uniform: (
      value: { [flag: string]: unknown } | number | string | null | undefined,
      ...rest: unknown[]
    ) => {
      const taken =
        value == null ||
        typeof value === "number" ||
        typeof value === "string" ||
        ["isNode", "isColor", "isVector2", "isVector3", "isVector4"].some(
          (flag) => (value as { [flag: string]: unknown })[flag] === true,
        );
      if (!taken) refused.push(String((value as object).constructor.name));
      return (real.uniform as (...args: unknown[]) => unknown)(value, ...rest);
    },
  };
});

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
function settings(): IVolumetricFogOptions {
  return {
    enabled: true,
    renderer: "webgpu",
    steps: 32,
    resolutionScale: 1,
    volumes: [
      {
        bounds: new Box3(new Vector3(-2, -1, -8), new Vector3(2, 3, -2)),
        density: 0.2,
        baseHeight: 0,
        heightFalloff: 0,
      },
    ],
    albedo: new Color(0.8, 0.8, 0.8),
    ambient: new Color(0.1, 0.1, 0.1),
    anisotropy: 0,
    environment: { aerialPerspective: false, godRays: false },
  };
}

describe("opt-in generated volumetric fog", () => {
  it.each(["disabled", "unsupported", "zero", "empty"])(
    "%s returns no controller before graph allocation",
    (reason) => {
      const options = settings();
      if (reason === "disabled") options.enabled = false;
      if (reason === "unsupported") options.renderer = "webgl2";
      if (reason === "zero") required(options.volumes[0]).density = 0;
      if (reason === "empty") options.volumes = [];
      expect(createVolumetricFog(new Scene(), new PerspectiveCamera(), options)).toBeUndefined();
    },
  );
  it.each([0, -1, 8.5, 129, Number.NaN])("rejects invalid steps %s", (steps) => {
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), { ...settings(), steps }),
    ).toThrow(/steps/);
  });
  it.each([0, 0.25, 2, Number.NaN])("rejects unsupported resolution %s", (resolutionScale) => {
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), { ...settings(), resolutionScale }),
    ).toThrow(/resolutionScale/);
  });
  it("refuses unqualified camera and depth encodings", () => {
    expect(() =>
      createVolumetricFog(
        new Scene(),
        new OrthographicCamera() as unknown as PerspectiveCamera,
        settings(),
      ),
    ).toThrow(/perspective/);
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), {
        ...settings(),
        logarithmicDepth: true,
      }),
    ).toThrow(/depth/);
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), {
        ...settings(),
        reversedDepth: true,
      }),
    ).toThrow(/depth/);
  });
  it("rejects double-counted atmosphere or shafts before allocation", () => {
    for (const name of ["aerialPerspective", "godRays"] as const) {
      const options = settings();
      options.environment[name] = true;
      expect(() => createVolumetricFog(new Scene(), new PerspectiveCamera(), options)).toThrow(
        /same medium/,
      );
    }
  });
  it("rejects invalid density, bounds, albedo and phase", () => {
    const options = settings();
    required(options.volumes[0]).density = -1;
    expect(() => createVolumetricFog(new Scene(), new PerspectiveCamera(), options)).toThrow(
      /density/,
    );
    required(options.volumes[0]).density = 0.2;
    required(options.volumes[0]).bounds.makeEmpty();
    expect(() => createVolumetricFog(new Scene(), new PerspectiveCamera(), options)).toThrow(
      /bounds/,
    );
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), { ...settings(), anisotropy: 1 }),
    ).toThrow(/anisotropy/);
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), {
        ...settings(),
        albedo: new Color(2, 0, 0),
      }),
    ).toThrow(/albedo/);
  });
  it("refuses missing directional maps and unsupported local-light shadows", () => {
    const sun = new DirectionalLight();
    sun.castShadow = true;
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), { ...settings(), sun }),
    ).toThrow(/shadow map/);
    const point = new PointLight();
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), { ...settings(), points: [point] }),
    ).toThrow(/finite-range/);
    point.distance = 5;
    point.castShadow = true;
    expect(() =>
      createVolumetricFog(new Scene(), new PerspectiveCamera(), { ...settings(), points: [point] }),
    ).toThrow(/unshadowed/);
  });
  it("owns the scene's fog while it lives and puts the authored fog back", () => {
    // The starter's `sky.ts` installs a FogExp2 on `scene.fog`; two air densities would double it.
    const scene = new Scene();
    const authored = new FogExp2(0xcfd8e3, 0.003);
    scene.fog = authored;
    const camera = new PerspectiveCamera();
    const fog = required(createVolumetricFog(scene, camera, settings()));
    expect(scene.fog).toBeNull();
    expect(() => fog.compose(pass(scene, camera))).not.toThrow();
    fog.dispose();
    expect(scene.fog).toBe(authored);
  });
  it("clears the height-fog node with the distance fog and restores both (one fog owner)", () => {
    const scene = new Scene();
    setupSky(scene, new Texture());
    const { fog: distance, fogNode: node } = scene;
    expect(distance).not.toBeNull();
    expect(node).toBeTruthy();
    const camera = new PerspectiveCamera();
    const medium = required(createVolumetricFog(scene, camera, settings()));
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).toBeNull();
    expect(() => medium.compose(pass(scene, camera))).not.toThrow();
    medium.dispose();
    expect(scene.fog).toBe(distance);
    expect(scene.fogNode).toBe(node);
  });
  it("rejects a compose while a height-fog node is still the scene's fog", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const medium = required(createVolumetricFog(scene, camera, settings()));
    setupSky(scene, new Texture());
    scene.fog = null;
    expect(() => medium.compose(pass(scene, camera))).toThrow(/duplicates the same medium/);
  });
  it("leaves a fog the game authored while the medium lived", () => {
    const scene = new Scene();
    scene.fog = new FogExp2(0xcfd8e3, 0.003);
    const camera = new PerspectiveCamera();
    const fog = required(createVolumetricFog(scene, camera, settings()));
    expect(() => fog.compose(pass(scene, camera))).not.toThrow();
    const later = new FogExp2(0x101418, 0.02);
    scene.fog = later;
    fog.dispose();
    expect(scene.fog).toBe(later);
  });
  it("owns no history and disposes its own target and material exactly once", () => {
    const camera = new PerspectiveCamera();
    const scene = new Scene();
    const fog = required(createVolumetricFog(scene, camera, settings()));
    const scenePass = pass(scene, camera);
    expect(fog.compose(scenePass)).toBeDefined();
    expect(fog.diagnostics()).toMatchObject({
      steps: 32,
      resolutionScale: 1,
      history: false,
      volumes: 1,
      localLights: 0,
    });
    const targetDispose = vi.spyOn(required(fog.target), "dispose");
    const materialDispose = vi.spyOn(required(fog.material), "dispose");
    const depthDispose = vi.spyOn(required(scenePass.renderTarget.depthTexture), "dispose");
    fog.dispose();
    fog.dispose();
    expect(targetDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(depthDispose).not.toHaveBeenCalled();
    expect(() => fog.compose(scenePass)).toThrow(/disposed/);
    scenePass.dispose();
  });
});

it.each([false, true])("builds the actual depth-clipped transport WGSL (lights=%s)", (lights) => {
  const camera = new PerspectiveCamera();
  const options = settings();
  if (lights) {
    const sun = new DirectionalLight();
    sun.castShadow = true;
    sun.shadow.map = new RenderTarget(32, 32);
    sun.shadow.map.depthTexture = new DepthTexture(32, 32);
    options.sun = sun;
    options.points = [new PointLight(0xffffff, 1, 4)];
  }
  const fog = required(createVolumetricFog(new Scene(), camera, options));
  const scenePass = pass(new Scene(), camera);
  fog.compose(scenePass);
  const object = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      capabilities: { getUniformBufferLimit: () => 65_536 },
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    coordinateSystem: 2001,
    hasCompatibility: () => true,
    hasFeature: () => false,
    getRenderTarget: () => null,
    getOutputBufferType: () => 1016,
    samples: 0,
    getMRT: () => null,
    library: { fromMaterial: () => null },
    shadowMap: { enabled: true, type: 1 },
  };
  const builder = new WGSLNodeBuilder(object, renderer as never) as unknown as {
    camera: PerspectiveCamera;
    setShaderStage(stage: string): void;
    flowStagesNode(node: Node, output: string): { code: string };
  };
  builder.camera = camera;
  builder.setShaderStage("fragment");
  const flow = builder.flowStagesNode(required(fog.transport), "vec4");
  expect(flow.code).toContain("exp(");
  expect(flow.code).toContain("for (");
  expect(flow.code).toContain("32");
  if (lights) {
    expect(flow.code).toContain("textureSampleCompare");
    const sampled = /([A-Za-z_][A-Za-z_0-9]*) = textureSampleCompare/.exec(flow.code)?.[1];
    const visibility = new RegExp(`([A-Za-z_][A-Za-z_0-9]*) = ${sampled};`).exec(flow.code)?.[1];
    expect(visibility).toBeDefined();
    // Match the actual generated shader default, not a second JavaScript implementation.
    // Outside ordinary shadow coverage the directional source stays unshadowed, like Three.
    expect(flow.code).toContain(`${visibility} = 1.0;`);
  }
  fog.dispose();
  scenePass.dispose();
  options.sun?.shadow.map?.dispose();
});

/** The WGSL one fragment node builds to, on the same fake WebGPU renderer the transport tests use. */
function fragmentCode(camera: PerspectiveCamera, node: Node, output: "vec4"): string {
  const renderer = {
    backend: {
      isWebGPUBackend: true,
      capabilities: { getUniformBufferLimit: () => 65_536 },
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    coordinateSystem: 2001,
    hasCompatibility: () => true,
    hasFeature: () => false,
    getRenderTarget: () => null,
    getOutputBufferType: () => 1016,
    samples: 0,
    getMRT: () => null,
    library: { fromMaterial: () => null },
    shadowMap: { enabled: true, type: 1 },
  };
  const builder = new WGSLNodeBuilder(
    new Mesh(new BoxGeometry(), new MeshBasicMaterial()),
    renderer as never,
  ) as unknown as {
    camera: PerspectiveCamera;
    setShaderStage(stage: string): void;
    flowStagesNode(node: Node, output: string): { code: string };
  };
  builder.camera = camera;
  builder.setShaderStage("fragment");
  return builder.flowStagesNode(node, output).code;
}

it("scatters a field read at every step when the air is given an ambient node (PRD-643)", () => {
  const camera = new PerspectiveCamera();
  const field = new Data3DTexture(new Float32Array(4), 1, 1, 1);
  const wgsl = (ambientNode?: IVolumetricFogOptions["ambientNode"]): string => {
    const fog = required(createVolumetricFog(new Scene(), camera, { ...settings(), ambientNode }));
    const scenePass = pass(new Scene(), camera);
    fog.compose(scenePass);
    const code = fragmentCode(camera, required(fog.transport), "vec4");
    fog.dispose();
    scenePass.dispose();
    return code;
  };
  const plain = wgsl();
  const lit = wgsl((position) => texture3D(field).sample(position.mul(0.1)).rgb);
  // A 3D read is the only `vec3<u32>` texture load in the march (the scene depth is 2D).
  const read = /textureLoad\([^;]*vec3<u32>/;
  expect(plain).not.toMatch(read);
  // The field is read inside the march: after the loop header, not once before it.
  expect(lit.search(read)).toBeGreaterThan(lit.indexOf("for ("));
});

/** Builds the transport and the composed fog, at full and at half resolution (the half-resolution compose adds a depth test). */
function buildBothGraphs(): void {
  for (const resolutionScale of [1, 0.5]) {
    const camera = new PerspectiveCamera();
    const fog = required(
      createVolumetricFog(new Scene(), camera, { ...settings(), resolutionScale }),
    );
    const scenePass = pass(new Scene(), camera);
    const composed = fog.compose(scenePass);
    // A TSL function body runs when the shader builds, so build both graphs the game draws.
    fragmentCode(camera, required(fog.transport), "vec4");
    fragmentCode(camera, composed, "vec4");
    fog.dispose();
    scenePass.dispose();
  }
}

it("hands the owned engine's TSL only uniform values and functions it takes (PRD-643)", () => {
  refused.length = 0;
  buildBothGraphs();
  expect(refused).toEqual([]);
});

/**
 * The owned engine's shader IR compares two values of one type and selects on a bool scalar
 * (packages/runtime-native/src/engine/shader/ir.cpp: `less`, `equal`, `select`, `greaterEqual`). Three's WGSL builder
 * broadcasts a scalar against a vector, so the stock path builds what the owned engine refuses at its first draw:
 * `TN_TSL_TYPE: greaterEqual: takes two equal numeric values`. Every comparison and select the fog builds is checked
 * as it generates.
 */
it("compares two values of one type and selects on a bool scalar, as the owned engine's IR requires (PRD-643)", () => {
  const comparison = new Set(["==", "!=", "<", ">", "<=", ">="]);
  const wrong: string[] = [];
  const seen = { comparisons: 0, selects: 0 };
  const generateOperator = OperatorNode.prototype.generate;
  const generateConditional = ConditionalNode.prototype.generate;
  OperatorNode.prototype.generate = function (
    this: OperatorNode,
    builder: NodeBuilder,
    output?: string | null,
  ) {
    if (comparison.has(this.op)) {
      seen.comparisons += 1;
      const a = this.aNode.getNodeType(builder);
      const b = this.bNode.getNodeType(builder);
      if (a !== b) wrong.push(`${a} ${this.op} ${b}`);
    }
    return generateOperator.call(this, builder, output);
  };
  ConditionalNode.prototype.generate = function (
    this: ConditionalNode<string>,
    builder: NodeBuilder,
    output?: string | null,
  ) {
    seen.selects += 1;
    const type = this.condNode.getNodeType(builder);
    if (type !== "bool") wrong.push(`select on ${type}`);
    return generateConditional.call(this, builder, output);
  };
  try {
    buildBothGraphs();
  } finally {
    OperatorNode.prototype.generate = generateOperator;
    ConditionalNode.prototype.generate = generateConditional;
  }
  expect(wrong).toEqual([]);
  // Fail closed: a three upgrade that renames either method would otherwise leave this check empty.
  expect(seen.comparisons).toBeGreaterThan(0);
  expect(seen.selects).toBeGreaterThan(0);
});

/**
 * The shipped wiring, as source. Two ways this regressed are both silent at runtime: a look that
 * lives in a scene file breaks `src/render/` ownership, and a hardcoded backend builds a medium on
 * a WebGL fallback that then silently allocates nothing.
 */
describe("the starter's shipped mist", () => {
  const source = (relative: string) =>
    readFile(path.join("packages/create-threenative/templates/starter/src", relative), "utf8").then(
      (text) => text,
    );

  it("keeps its flag in the fog source and names no backend of its own", async () => {
    const fog = await source("render/volumetricFog.ts");
    expect(fog).toMatch(/export const STARTER_MIST: Omit<IVolumetricFogOptions, "renderer">/u);
    expect(fog).toMatch(/enabled: false/u);
    expect(fog).not.toMatch(/renderer: "webgpu"/u);
  });

  it("keeps the authored look out of the scene and wires the live backend once", async () => {
    const play = await source("scenes/Play.ts");
    expect(play).not.toMatch(/IVolumetricFogOptions|volumes:|albedo:/u);
    expect(play).toMatch(
      /createVolumetricFog\(ctx\.scene, ctx\.camera as PerspectiveCamera, \{\s*\.\.\.STARTER_MIST,\s*renderer: ctx\.renderer\.kind,?\s*\}\)/u,
    );
  });
});

it.each([false, true])(
  "composes fog before exposure and rebuilds both owned graphs (chain=%s)",
  (chain) => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const authoredFog = new FogExp2(0xcfd8e3, 0.003);
    scene.fog = authoredFog;
    let current: unknown;
    const receipts: ReturnType<typeof vi.fn>[] = [];
    const install = (node: unknown) => {
      current = node;
      const dispose = vi.fn(() => {
        if (current === node) current = undefined;
      });
      receipts.push(dispose);
      return { isCurrent: () => current === node, dispose };
    };
    const renderer: OutputRenderer = {
      kind: "webgpu",
      raw: {},
      setOutputNode: install,
      clearOutputNode: vi.fn(),
      createRenderChain: (options) => ({
        applied: { stages: ["bloom"], dropped: [] },
        dispose: install(options.input).dispose,
      }),
    };
    for (const size of [640, 320, 640]) {
      camera.aspect = size / 360;
      camera.updateProjectionMatrix();
      const fog = required(createVolumetricFog(scene, camera, settings()));
      let composed: Node<"vec4"> | undefined;
      let passDispose: ReturnType<typeof vi.fn> | undefined;
      const applied = new WorldEnvironment({
        autoExposureEnabled: true,
        bloomEnabled: chain,
        screenSpaceAA: "disabled",
      }).apply(renderer, scene, camera, {
        baseColour: (scenePass) => {
          passDispose = vi.spyOn(scenePass, "dispose");
          composed = fog.compose(scenePass);
          return composed;
        },
      });
      const exposure = required(applied.exposure);
      expect(Reflect.get(exposure.input, "node")).toBe(composed);
      const releaseExposure = vi.spyOn(exposure, "dispose");
      const releaseTarget = vi.spyOn(required(fog.target), "dispose");
      const releaseMaterial = vi.spyOn(required(fog.material), "dispose");
      applied.dispose?.();
      applied.dispose?.();
      fog.dispose();
      fog.dispose();
      expect(current).toBeUndefined();
      expect(receipts.at(-1)).toHaveBeenCalledTimes(1);
      expect(releaseExposure).toHaveBeenCalledTimes(1);
      expect(passDispose).toHaveBeenCalledTimes(1);
      expect(releaseTarget).toHaveBeenCalledTimes(1);
      expect(releaseMaterial).toHaveBeenCalledTimes(1);
      expect(scene.fog).toBe(authoredFog);
      expect(() => exposure.reset()).toThrow(/disposed/);
    }
  },
);
