import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { IAssetLoader } from "@threenative/core";
import {
  BoxGeometry,
  type BufferAttribute,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector2,
  Vector3,
} from "three";
import type { MeshPhysicalNodeMaterial } from "three/webgpu";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { WorldName } from "../../../examples/strata-terrain-preview/src/render/biomes.js";
import {
  type ICanopyComparison,
  loadPack,
} from "../../../examples/strata-terrain-preview/src/render/pack.js";
import {
  createProps,
  createPropsInSlices,
  variantFor,
} from "../../../examples/strata-terrain-preview/src/render/props.js";
import { defineGame } from "../../core/src/game.js";
import { Scene, type SceneConstructor } from "../../core/src/scene.js";
import type { IPlacement } from "../src/index.js";

describe("canopy comparison scene lifetime", () => {
  const source = ts.createSourceFile(
    "game.ts",
    readFileSync(
      new URL("../../../examples/strata-terrain-preview/src/game.ts", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  let update = "";
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "update")
      update = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!update) throw new Error("Missing production Strata update method");
  it.each(["coastal", "coast"])(
    "retains comparison through actual ctx.goto: %s",
    async (action) => {
      const comparison = { normals: "authored", specular: "standard" } as const;
      const initialState = {
        canopyComparison: { normals: "radial", specular: "disabled" } as ICanopyComparison,
        worldReady: true,
        view: "player",
      };
      const exports: { Probe?: SceneConstructor<typeof initialState> } = {};
      // Execute the production controller; only player/water/rendering are replaced at their seams.
      runInNewContext(
        ts.transpileModule(
          `export class Probe extends Scene {
          static initialState = initialState;
          #elapsed = 0; #surfaces; #ocean; #river; #lake; #sky;
          #player = { velocity: { x: 0, y: 0, z: 0 }, moveAndSlide() {}, grounded: false };
          ${update}
        }`,
          { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
        ).outputText,
        { exports, Scene, initialState, world: "forest", BIOMES: { forest: {}, coastal: {} } },
      );
      if (!exports.Probe) throw new Error("Production controller did not load");
      const canvas = new EventTarget() as HTMLCanvasElement;
      Object.defineProperties(canvas, {
        clientHeight: { value: 180 },
        clientWidth: { value: 320 },
        parentElement: { value: null },
      });
      const game = defineGame({
        renderer: {
          canvas,
          preferWebGPU: false,
          webgl2Factory: () => ({
            dispose: () => undefined,
            domElement: canvas,
            render: () => undefined,
            setSize: () => undefined,
          }),
        },
        scenes: { forest: exports.Probe, coastal: exports.Probe },
        start: "forest",
      });
      try {
        await game.start();
        game.state.setState({ canopyComparison: comparison });
        const ctx = game.ctx;
        if (!ctx || !game.scene) throw new Error("Comparison scene failed to start");
        vi.spyOn(ctx.startup, "phase", "get").mockReturnValue("ready");
        vi.spyOn(ctx.input, "justPressed").mockImplementation((name) => name === action);
        vi.spyOn(ctx.input, "vector").mockReturnValue(new Vector2());
        const goto = vi.spyOn(ctx, "goto");
        game.scene.update(ctx, 1 / 60);
        expect(goto).toHaveBeenCalledOnce();
        await goto.mock.results[0]?.value;
        expect(game.sceneName).toBe("coastal");
        expect(game.state.getState().canopyComparison).toEqual(comparison);
      } finally {
        game.stop();
        vi.restoreAllMocks();
      }
    },
  );
});

describe("canopy comparison startup", () => {
  const code = ts.transpileModule(
    readFileSync(
      new URL("../../../examples/strata-terrain-preview/src/main.ts", import.meta.url),
      "utf8",
    ),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  async function boot(search: string) {
    let comparison: ICanopyComparison | undefined;
    let startedComparison: ICanopyComparison | undefined;
    const start = vi.fn(() => {
      startedComparison = comparison;
      return Promise.resolve();
    });
    const game = {
      state: {
        setState: (patch: { canopyComparison?: ICanopyComparison }) => {
          comparison = patch.canopyComparison ?? comparison;
        },
      },
      resumeScene: vi.fn(),
      start,
    };
    const pack = await import("../../../examples/strata-terrain-preview/src/render/pack.js");
    const imports: Record<string, unknown> = {
      "./game.js": { __esModule: true, default: game },
      "./render/biomes.js": { BIOMES: { forest: {}, coastal: {} } },
      "./render/pack.js": pack,
    };
    runInNewContext(code, {
      exports: {},
      location: { search },
      URLSearchParams,
      require: (name: string) => {
        if (!(name in imports)) throw new Error(`Unexpected startup dependency ${name}`);
        return imports[name];
      },
    });
    await Promise.resolve();
    return { comparison: startedComparison, game };
  }
  it.each([
    ["", { normals: "authored", specular: "disabled" }],
    ["?canopyNormals=radial", { normals: "radial", specular: "disabled" }],
    ["?canopyNormals=authored", { normals: "authored", specular: "disabled" }],
    ["?canopySpecular=standard", { normals: "authored", specular: "standard" }],
    [
      "?canopyNormals=authored&canopySpecular=standard&world=coastal&showcase=1",
      { normals: "authored", specular: "standard" },
    ],
  ] as const)("selects the same-tree comparison before loading %s", async (search, expected) => {
    const { comparison, game } = await boot(search);
    expect(comparison).toEqual(expected);
    expect(game.start).toHaveBeenCalledOnce();
    if (search.includes("world=coastal")) expect(game.resumeScene).toHaveBeenCalledWith("coastal");
  });
  it.each(["?canopyNormals=flat", "?canopySpecular=glossy", "?canopyNormals="])(
    "rejects unsupported comparison settings before startup %s",
    async (search) => {
      await expect(boot(search)).rejects.toThrow(/canopy/);
    },
  );
});

describe("preview prop distance bookkeeping", () => {
  it("finishes the same prop work through the installed slice scheduler", async () => {
    const material = new MeshBasicMaterial();
    const placements = [
      {
        id: "boulder:outcrop",
        asset: "boulder",
        position: [2, 0, 3],
        rotation: 0,
        scale: 1,
        normal: [0, 1, 0],
        alignToNormal: false,
      },
    ] as IPlacement[];
    const parts = new Map(
      Array.from({ length: 5 }, (_, variant) => [
        `boulder:${variant}`,
        [
          {
            geometry: new BoxGeometry(1, 2, 1),
            role: "stone" as const,
            material,
            variant,
          },
        ],
      ]),
    );
    const materials = {
      bark: material,
      crown: material,
      fern: material,
      grass: material,
      impostor: material,
      needles: material,
      petal: material,
      pine: material,
      stem: material,
      stone: material,
    };
    const ground = () => ({ height: 4, offset: 0 });
    const sync = createProps(placements, ground, parts, materials);
    const sliced = await createPropsInSlices(placements, ground, parts, materials);
    if (!sliced) throw new Error("Prop build stopped unexpectedly");
    expect([...sliced.byId.keys()]).toEqual([...sync.byId.keys()]);
    expect([...sliced.byId.values()].map((entry) => entry.pose.elements)).toEqual(
      [...sync.byId.values()].map((entry) => entry.pose.elements),
    );
    sync.dispose();
    sliced.dispose();
  });

  it("writes only band crossings and preserves the editor's instance slots", () => {
    const material = new MeshBasicMaterial();
    const sameVariantIds = Array.from({ length: 100 }, (_, i) => `spruce:${i}`).filter(
      (id) => variantFor({ id } as IPlacement, "spruce") === 0,
    );
    const placements = [10, 65, 200].map((x, i) => ({
      id: sameVariantIds[i] ?? "missing-id",
      asset: "spruce",
      position: [x, 0, 0],
      rotation: 0,
      scale: 1,
      normal: [0, 1, 0],
      alignToNormal: false,
    })) as IPlacement[];
    // All instances use variant 0, so each level has one draw.
    const parts = new Map(
      Array.from({ length: 5 }, (_, i) => [
        `spruce:${i}`,
        [0, 1, 2].map((level) => ({
          geometry: new BoxGeometry(1, 2, 1),
          material,
          role: "bark" as const,
          variant: i,
          level,
        })),
      ]),
    );
    const props = createProps(placements, () => ({ height: 0, offset: 0 }), parts, {
      bark: material,
      crown: material,
      fern: material,
      grass: material,
      impostor: material,
      needles: material,
      petal: material,
      pine: material,
      stem: material,
      stone: material,
    });
    props.setLevels(new Vector3());
    const writes = props.meshes.map((mesh) => vi.spyOn(mesh, "setMatrixAt"));
    const bounds = props.meshes.map((mesh) => vi.spyOn(mesh, "computeBoundingSphere"));
    props.setLevels(new Vector3(1, 0, 0));
    expect(writes.reduce((n, spy) => n + spy.mock.calls.length, 0)).toBe(0);
    expect(bounds.reduce((n, spy) => n + spy.mock.calls.length, 0)).toBe(0);
    for (const x of [20, 100, 300, 0]) {
      props.setLevels(new Vector3(x, 0, 0));
      for (const instance of props.byId.values()) {
        for (const part of instance.parts) {
          const position = new Vector3().setFromMatrixPosition(instance.pose);
          const drawn = new Vector3().fromArray(
            part.mesh.instanceMatrix.array,
            part.index * 16 + 12,
          );
          expect(drawn.distanceTo(position)).toBeLessThan(1e-6);
          expect(part.mesh.userData.placementIds[part.index]).toBe(instance.placement.id);
        }
      }
    }
    props.dispose();
  });
});

describe("licensed pack characterization", () => {
  function present<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("Missing characterized prop value");
    return value;
  }
  const image = () => new DataTexture(new Uint8Array([80, 150, 50, 255]), 1, 1);
  function fixture(
    options: { mapped?: boolean; array?: boolean; zeroNormal?: boolean; opaque?: boolean } = {},
  ) {
    const root = new Group();
    const geometry = new BoxGeometry(1, 2, 1).translate(0, 1, 0);
    if (options.zeroNormal) geometry.getAttribute("normal").setXYZ(1, 0, 0, 0);
    const material = new MeshStandardMaterial({
      map: options.mapped === false ? null : image(),
      normalMap: image(),
      alphaTest: options.opaque ? 0 : 0.33,
      color: 0x286a42,
    });
    if (options.array) {
      geometry.clearGroups();
      geometry.addGroup(0, 18, 0);
      geometry.addGroup(18, 18, 1);
    }
    const mesh = new Mesh(geometry, options.array ? [material, material.clone()] : material);
    mesh.position.set(2, 3, 4);
    root.add(mesh);
    return { root, mesh, geometry, material };
  }
  async function loaded(near?: Group, far?: Group, comparison?: ICanopyComparison) {
    const assets = {
      resolve: async () => [],
      model: async (path: string) => {
        if (near && /^temperate\/spruce\/\d\.glb$/.test(path)) return { scene: near };
        if (far && /^temperate\/spruce\/\d-far\.glb$/.test(path)) return { scene: far };
        throw new Error(`Missing optional fixture ${path}`);
      },
    } as unknown as IAssetLoader;
    return loadPack(assets, "forest", undefined, comparison);
  }
  it.each([undefined, {}, { specular: "standard" }] as const)(
    "preserves authored near/far crown normals when normals are omitted: %j",
    async (comparison) => {
      const near = fixture();
      const far = fixture({ mapped: false });
      const pack = await loaded(near.root, far.root, comparison);
      try {
        const parts = present(pack.parts.get("spruce:0"));
        expect(parts).toHaveLength(2);
        for (const [index, part] of parts.entries()) {
          const source = index === 0 ? near : far;
          expect(Array.from(part.geometry.getAttribute("normal").array)).toEqual(
            Array.from(source.geometry.getAttribute("normal").array),
          );
          expect(part.geometry.getAttribute("inner").count).toBe(
            part.geometry.getAttribute("position").count,
          );
          const material = part.material as MeshPhysicalNodeMaterial;
          expect(material.normalMap).toBe(near.material.normalMap);
          expect(material.normalNode).toBeNull();
          expect(material.aoNode).not.toBeNull();
          expect(material.alphaTest).toBe(near.material.alphaTest);
          expect(material.alphaToCoverage).toBe(true);
          expect(material.castShadowPositionNode).toBe(material.positionNode);
        }
      } finally {
        pack.dispose();
      }
    },
  );
  it.each([
    { normals: "radial", specular: "disabled" },
    { normals: "authored", specular: "disabled" },
    { normals: "radial", specular: "standard" },
    { normals: "authored", specular: "standard" },
  ] as const)(
    "isolates canopy comparison normals=$normals specular=$specular",
    async (comparison) => {
      const near = fixture();
      const far = fixture({ mapped: false });
      const authored = Array.from(near.geometry.getAttribute("normal").array);
      const baseline = await loaded(near.root, far.root, { normals: "radial" });
      const candidate = await loaded(near.root, far.root, comparison);
      try {
        expect([...candidate.parts.keys()]).toEqual([...baseline.parts.keys()]);
        const before = present(baseline.parts.get("spruce:0"));
        const after = present(candidate.parts.get("spruce:0"));
        expect(after.map((part) => [part.role, part.level, part.variant])).toEqual(
          before.map((part) => [part.role, part.level, part.variant]),
        );
        for (const [index, part] of after.entries()) {
          const original = present(before[index]);
          for (const key of ["position", "uv", "inner"]) {
            expect(Array.from(part.geometry.getAttribute(key).array)).toEqual(
              Array.from(original.geometry.getAttribute(key).array),
            );
          }
          expect(part.geometry.index?.array).toEqual(original.geometry.index?.array);
          expect(part.geometry.drawRange).toEqual(original.geometry.drawRange);
          const material = part.material as MeshPhysicalNodeMaterial;
          const current = original.material as MeshPhysicalNodeMaterial;
          expect(material.specularIntensity).toBe(comparison.specular === "standard" ? 1 : 0);
          expect(material.roughness).toBe(current.roughness);
          expect(material.normalMap).toBe(near.material.normalMap);
          expect(material.normalNode).toBeNull();
          for (const key of ["map", "alphaTest", "alphaToCoverage", "side", "shadowSide"] as const)
            expect(material[key]).toBe(current[key]);
          expect(material.castShadowPositionNode).toBe(material.positionNode);
          const footprint = new Set<string>();
          present(material.alphaTestNode).traverse((node) => {
            if ("method" in node && typeof node.method === "string") footprint.add(node.method);
          });
          expect(footprint).toContain("dFdx");
          expect(footprint).toContain("dFdy");
          const expectedNormals =
            comparison.normals === "authored"
              ? authored
              : Array.from(original.geometry.getAttribute("normal").array);
          expect(Array.from(part.geometry.getAttribute("normal").array)).toEqual(expectedNormals);
        }
        expect(present(after[0]).material).toBe(present(after[1]).material);
        expect(Array.from(near.geometry.getAttribute("normal").array)).toEqual(authored);
      } finally {
        candidate.dispose();
        baseline.dispose();
      }
    },
  );
  it("retains mapped near/far material identity and imported cutoff", async () => {
    const near = fixture();
    const pack = await loaded(near.root, fixture({ mapped: false }).root);
    try {
      const parts = present(pack.parts.get("spruce:0"));
      expect(parts).toHaveLength(2);
      expect(present(parts[0]).material).toBe(present(parts[1]).material);
      const material = present(parts[0]).material as MeshPhysicalNodeMaterial;
      expect(material.alphaTest).toBe(0.33);
      expect(material.map).toBe(near.material.map);
      expect(material.normalMap).toBe(near.material.normalMap);
    } finally {
      pack.dispose();
    }
  });
  it("keeps imported canopy alpha coverage responsive to texture minification", async () => {
    const near = fixture();
    const pack = await loaded(near.root);
    try {
      const part = present(present(pack.parts.get("spruce:0"))[0]);
      const material = part.material as MeshPhysicalNodeMaterial;
      const methods = new Set<string>();
      present(material.alphaTestNode).traverse((node) => {
        if ("method" in node && typeof node.method === "string") methods.add(node.method);
      });
      // Both screen axes must contribute to the pixel footprint; a constant source cutoff
      // rejects the averaged needle alpha at distance and erases the imported crown.
      expect(methods).toContain("dFdx");
      expect(methods).toContain("dFdy");
      expect(material.alphaTest).toBe(near.material.alphaTest);
    } finally {
      pack.dispose();
    }
  });
  it("shades imported forest crowns with coverage and interior depth", async () => {
    const near = fixture();
    const pack = await loaded(near.root);
    try {
      const material = present(present(pack.parts.get("spruce:0"))[0])
        .material as MeshPhysicalNodeMaterial;
      expect(material.alphaToCoverage).toBe(true);
      expect(material.aoNode).not.toBeNull();
      expect(material.specularIntensity).toBe(0);
    } finally {
      pack.dispose();
    }
  });
  it("keeps the imported normal map in the forest crown normal", async () => {
    const near = fixture();
    const pack = await loaded(near.root);
    try {
      const material = present(present(pack.parts.get("spruce:0"))[0])
        .material as MeshPhysicalNodeMaterial;
      // The bent crown normal is the geometry's own; the imported normal map perturbs it. A custom
      // `normalNode` replaces both, and the crown shades as one flat card.
      expect(material.normalNode).toBeNull();
      expect(material.normalMap).toBe(near.material.normalMap);
    } finally {
      pack.dispose();
    }
  });
  it("keeps radial crown normals as an explicit probe without changing cached imported normals", async () => {
    const near = fixture();
    const sourceNormals = Array.from(near.geometry.getAttribute("normal").array);
    const pack = await loaded(near.root, undefined, { normals: "radial" });
    try {
      const geometry = present(present(pack.parts.get("spruce:0"))[0]).geometry;
      const positions = geometry.getAttribute("position");
      const normals = geometry.getAttribute("normal");
      for (let i = 0; i < positions.count; i++) {
        const radial = new Vector3(positions.getX(i), 0, positions.getZ(i));
        const normal = new Vector3(normals.getX(i), normals.getY(i), normals.getZ(i));
        expect(normal.length()).toBeCloseTo(1, 5);
        expect(normal.y).toBeGreaterThan(0);
        expect(new Vector3(normal.x, 0, normal.z).normalize().dot(radial.normalize())).toBeCloseTo(
          1,
          5,
        );
      }
      expect(Array.from(near.geometry.getAttribute("normal").array)).toEqual(sourceNormals);
    } finally {
      pack.dispose();
    }
  });
  it("uses one whole-model base and scale for trunk and crown", async () => {
    const trunk = fixture();
    const crown = fixture();
    trunk.mesh.position.set(0, 3, 0);
    crown.mesh.position.set(0, 5, 0);
    trunk.root.add(crown.mesh);
    const pack = await loaded(trunk.root);
    try {
      const parts = present(pack.parts.get("spruce:0"));
      expect(parts).toHaveLength(2);
      for (const part of parts) part.geometry.computeBoundingBox();
      expect(
        parts.map((part) => [
          present(part.geometry.boundingBox).min.y,
          present(part.geometry.boundingBox).max.y,
        ]),
      ).toEqual([
        [0, 6],
        [6, 12],
      ]);
    } finally {
      pack.dispose();
    }
  });
  it("preserves cached source geometry and leaves source ownership with the loader", async () => {
    const near = fixture();
    const before = ["position", "normal", "uv"].map((key) =>
      Array.from((near.geometry.getAttribute(key) as BufferAttribute).array),
    );
    const indices = Array.from(present(near.geometry.index).array);
    const geometryDisposal = vi.fn();
    const materialDisposal = vi.fn();
    near.geometry.addEventListener("dispose", geometryDisposal);
    near.material.addEventListener("dispose", materialDisposal);
    const pack = await loaded(near.root);
    const geometry = present(present(pack.parts.get("spruce:0"))[0]).geometry;
    geometry.computeBoundingBox();
    expect(present(geometry.boundingBox).min.y).toBe(0);
    expect(present(geometry.boundingBox).max.y).toBe(12);
    expect(present(geometry.boundingBox).min.x).toBeCloseTo(10.08, 5);
    expect(
      ["position", "normal", "uv"].map((key) =>
        Array.from((near.geometry.getAttribute(key) as BufferAttribute).array),
      ),
    ).toEqual(before);
    expect(Array.from(present(near.geometry.index).array)).toEqual(indices);
    pack.dispose();
    expect(geometryDisposal).not.toHaveBeenCalled();
    expect(materialDisposal).not.toHaveBeenCalled();
  });
  it("keeps missing optional art available to the procedural fallback", async () => {
    const pack = await loaded();
    expect(pack.parts.size).toBe(0);
    pack.dispose();
  });
  it("retains material-array mesh sections", async () => {
    const near = fixture({ array: true });
    const sourceIndices = Array.from(present(near.geometry.index).array);
    const sourceGroups = near.geometry.groups.map((group) => ({ ...group }));
    const pack = await loaded(near.root);
    try {
      const parts = present(pack.parts.get("spruce:0"));
      expect(parts).toHaveLength(2);
      expect(parts.map((part) => part.geometry.drawRange)).toEqual([
        { start: 0, count: 18 },
        { start: 18, count: 18 },
      ]);
      expect(Array.from(present(near.geometry.index).array)).toEqual(sourceIndices);
      expect(near.geometry.groups).toEqual(sourceGroups);
    } finally {
      pack.dispose();
    }
  });
  it("retains a valid untextured near mesh", async () => {
    const near = fixture({ mapped: false, opaque: true });
    const pack = await loaded(near.root);
    try {
      const material = present(present(pack.parts.get("spruce:0"))[0])
        .material as MeshPhysicalNodeMaterial;
      expect(material.color.getHex()).toBe(near.material.color.getHex());
    } finally {
      pack.dispose();
    }
  });
  it("repairs zero normals beyond the first vertex", async () => {
    const near = fixture({ zeroNormal: true, opaque: true });
    near.geometry.getAttribute("normal").setXYZ(2, Number.NaN, 0, 0);
    const sourceNormals = Array.from(near.geometry.getAttribute("normal").array);
    const pack = await loaded(near.root);
    try {
      const normal = present(present(pack.parts.get("spruce:0"))[0]).geometry.getAttribute(
        "normal",
      );
      for (let i = 0; i < normal.count; i++) {
        const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
        expect(Number.isFinite(length)).toBe(true);
        expect(length).toBeGreaterThan(0.01);
      }
      expect(Array.from(near.geometry.getAttribute("normal").array)).toEqual(sourceNormals);
    } finally {
      pack.dispose();
    }
  });
  async function loadedWorld(world: WorldName, near: Group) {
    const assets = {
      resolve: async () => [],
      model: async (path: string) => (path.startsWith("temperate/") ? { scene: near } : undefined),
    } as unknown as IAssetLoader;
    return loadPack(assets, world);
  }
  it("applies each world's asset reshape on top of the shared whole-model scale", async () => {
    const forest = await loadedWorld("forest", fixture().root);
    const coastal = await loadedWorld("coastal", fixture().root);
    try {
      const box = (pack: Awaited<ReturnType<typeof loadedWorld>>) => {
        const part = present(present(pack.parts.get("grass:0"))[0]);
        part.geometry.computeBoundingBox();
        return present(part.geometry.boundingBox);
      };
      const plain = box(forest);
      const reshaped = box(coastal);
      // Coastal grass squashes in x/z and stretches in y; everything else is shared with forest.
      expect(reshaped.max.x - reshaped.min.x).toBeCloseTo((plain.max.x - plain.min.x) * 0.55, 5);
      expect(reshaped.max.y - reshaped.min.y).toBeCloseTo((plain.max.y - plain.min.y) * 1.35, 5);
      expect(reshaped.max.z - reshaped.min.z).toBeCloseTo((plain.max.z - plain.min.z) * 0.55, 5);
    } finally {
      forest.dispose();
      coastal.dispose();
    }
  });
  it("disposes shared near/far material once", async () => {
    const pack = await loaded(fixture().root, fixture({ mapped: false }).root);
    const unique = new Set([...pack.parts.values()].flat().map((part) => present(part.material)));
    const spies = [...unique].map((material) => {
      const spy = vi.fn();
      material.addEventListener("dispose", spy);
      return spy;
    });
    pack.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
