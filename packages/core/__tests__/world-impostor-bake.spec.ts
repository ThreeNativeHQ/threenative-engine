import {
  Box3,
  BufferGeometry,
  Color,
  Matrix4,
  type Mesh,
  MeshStandardMaterial,
  NoBlending,
  Scene,
  Texture,
  Vector3,
} from "three";
import type { NodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import {
  type IImpostorPart,
  type IImpostorRawRenderer,
  IMPOSTOR_FRAME_PIXELS,
  IMPOSTOR_VIEWS,
  IMPOSTOR_VIEW_GRID,
  VIEW_DIRECTIONS,
  WorldImpostorAtlas,
  WorldImpostorBaker,
  impostorBounds,
  impostorViewWeights,
  octahedralViewOf,
} from "../src/render/world-impostor.js";

interface IStubRenderer {
  readonly renderer: IImpostorRawRenderer;
  readonly events: string[];
  readonly targetCalls: readonly unknown[][];
  readonly mipFlags: boolean[];
  readonly setRenderTarget: ReturnType<typeof vi.fn>;
  readonly setMRT: ReturnType<typeof vi.fn>;
  readonly setClearAlpha: ReturnType<typeof vi.fn>;
  readonly setClearColor: ReturnType<typeof vi.fn>;
  readonly initRenderTarget: ReturnType<typeof vi.fn>;
}

function stubRenderer(
  options: {
    readonly throwOnRender?: number;
    readonly mipProbe?: () => boolean;
  } = {},
): IStubRenderer {
  const events: string[] = [];
  const targetCalls: unknown[][] = [];
  const mipFlags: boolean[] = [];
  const previousColor = { clone: () => ({ r: 0.1, g: 0.2, b: 0.3 }), r: 0.1, g: 0.2, b: 0.3 };
  let renders = 0;
  const nextRender = () => {
    renders += 1;
    events.push(`render:${renders}`);
    if (options.mipProbe !== undefined) mipFlags.push(options.mipProbe());
    if (options.throwOnRender === renders) throw new Error("capture failed");
  };
  const setRenderTarget = vi.fn((...args: unknown[]) => {
    targetCalls.push(args);
    events.push("target");
  });
  const setMRT = vi.fn();
  const setClearAlpha = vi.fn();
  const setClearColor = vi.fn();
  const initRenderTarget = vi.fn(() => events.push("init"));
  const renderer: IImpostorRawRenderer = {
    autoClear: true,
    getActiveCubeFace: () => 3,
    getActiveMipmapLevel: () => 2,
    getClearAlpha: () => 0.75,
    getClearColor: (target) => {
      // Three's public `getClearColor(target)` requires a real `Color`; the baker must pass one.
      expect(target).toBeInstanceOf(Color);
      return previousColor;
    },
    getMRT: () => "previous-mrt",
    getRenderTarget: () => "previous-target",
    initRenderTarget,
    render: nextRender,
    setClearAlpha,
    setClearColor,
    setMRT,
    setRenderTarget,
    xr: { enabled: true },
  };
  return {
    events,
    initRenderTarget,
    mipFlags,
    renderer,
    setClearAlpha,
    setClearColor,
    setMRT,
    setRenderTarget,
    targetCalls,
  };
}

function boxedGeometry(min: Vector3, max: Vector3): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.boundingBox = new Box3(min, max);
  return geometry;
}

function part(
  geometry: BufferGeometry,
  local: Matrix4,
  material: MeshStandardMaterial = new MeshStandardMaterial(),
): IImpostorPart {
  return { geometry, local, material };
}

describe("WorldImpostorBaker octahedral frame", () => {
  it("places every view on the unit sphere with a full-sphere octahedral grid", () => {
    expect(VIEW_DIRECTIONS).toHaveLength(IMPOSTOR_VIEWS);
    for (const direction of VIEW_DIRECTIONS) expect(direction.length()).toBeCloseTo(1, 6);
    expect(octahedralViewOf(0, 0).z).toBeLessThan(0);
    expect(octahedralViewOf(IMPOSTOR_VIEW_GRID - 1, IMPOSTOR_VIEW_GRID - 1).z).toBeLessThan(0);
  });

  it("blends the three corners of a view's own cell with weight one at interior points", () => {
    for (let iy = 1; iy < IMPOSTOR_VIEW_GRID - 1; iy += 1) {
      for (let ix = 1; ix < IMPOSTOR_VIEW_GRID - 1; ix += 1) {
        const blend = impostorViewWeights(octahedralViewOf(ix, iy));
        const dominant = blend.weights.indexOf(Math.max(...blend.weights));
        expect(blend.nearest[dominant]).toBe(iy * IMPOSTOR_VIEW_GRID + ix);
        expect(blend.weights[dominant]).toBeCloseTo(1, 5);
      }
    }
  });

  it("keeps weights non-negative, normalized and continuous across the inner triangle seam", () => {
    // Walk the direction whose octahedral encoding is (t, t) through the cell that straddles
    // fx + fy = 1, where the two blend branches meet. Weights must not jump there, and the third
    // corner must actually take weight — the prior draft held it at zero everywhere.
    let previous: readonly number[] = [];
    let sawThirdCorner = false;
    for (let step = 0; step <= 600; step += 1) {
      const cell = Math.floor((IMPOSTOR_VIEW_GRID - 2) / 2);
      const t = (2 * (cell + step / 600)) / (IMPOSTOR_VIEW_GRID - 1) - 1;
      const direction = new Vector3(t, t, 1 - 2 * Math.abs(t)).normalize();
      const blend = impostorViewWeights(direction);
      const sum = blend.weights[0] + blend.weights[1] + blend.weights[2];
      expect(sum).toBeCloseTo(1, 6);
      for (const weight of blend.weights) expect(weight).toBeGreaterThanOrEqual(-1e-9);
      if (blend.weights[2] > 0.05) sawThirdCorner = true;
      if (step > 0)
        for (let index = 0; index < 3; index += 1)
          expect(
            Math.abs((blend.weights[index] as number) - (previous[index] as number)),
          ).toBeLessThan(0.05);
      expect(new Set(blend.nearest).size).toBe(3);
      previous = blend.weights;
    }
    expect(sawThirdCorner).toBe(true);
  });

  it("reconstructs the encoded grid coordinate from the corner weights when fx != fy", () => {
    // A direction with encoding (t, s) and z >= 0 encodes to exactly (t, s); walking an asymmetric
    // line exercises both triangles and separates the two upper-triangle weights a sums-only check
    // would miss.
    for (let step = -30; step <= 30; step += 1) {
      const t = step * 0.01;
      const s = t * 0.5;
      const direction = new Vector3(t, s, 1 - Math.abs(t) - Math.abs(s)).normalize();
      const blend = impostorViewWeights(direction);
      let gx = 0;
      let gy = 0;
      for (let index = 0; index < 3; index += 1) {
        const layer = blend.nearest[index] as number;
        const weight = blend.weights[index] as number;
        gx += weight * (layer % IMPOSTOR_VIEW_GRID);
        gy += weight * Math.floor(layer / IMPOSTOR_VIEW_GRID);
      }
      expect(gx).toBeCloseTo((t * 0.5 + 0.5) * (IMPOSTOR_VIEW_GRID - 1), 5);
      expect(gy).toBeCloseTo((s * 0.5 + 0.5) * (IMPOSTOR_VIEW_GRID - 1), 5);
    }
  });

  it("never returns the degenerate all-zero set the prior dot-product draft returned at a tie", () => {
    const tie = octahedralViewOf(0, 0).add(octahedralViewOf(0, 1)).normalize();
    const blend = impostorViewWeights(tie);
    const sum = blend.weights[0] + blend.weights[1] + blend.weights[2];
    expect(sum).toBeCloseTo(1, 6);
    expect(new Set(blend.nearest).size).toBe(3);
    for (const weight of blend.weights) expect(weight).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe("impostorBounds", () => {
  it("takes the true world AABB of rotated and translated parts", () => {
    const rotated = new Matrix4().makeRotationZ(Math.PI / 2);
    const translated = new Matrix4().makeTranslation(3, 0, 0);
    const parts = [
      part(boxedGeometry(new Vector3(-1, 0, -1), new Vector3(1, 2, 1)), rotated),
      part(boxedGeometry(new Vector3(0, 0, 0), new Vector3(1, 1, 1)), translated),
    ];
    const rotatedBefore = rotated.clone();
    const bounds = impostorBounds(parts);
    // Rotated part fills [-2,0]x[-1,1]x[-1,1]; translated part fills [3,4]x[0,1]x[0,1].
    expect(bounds.center.x).toBeCloseTo(1, 6);
    expect(bounds.center.y).toBeCloseTo(0, 6);
    expect(bounds.center.z).toBeCloseTo(0, 6);
    expect(bounds.radius).toBeCloseTo(Math.sqrt(11), 6);
    expect(rotated.equals(rotatedBefore)).toBe(true);
    expect(parts[0]?.geometry.boundingBox?.min.x).toBe(-1);
  });

  it("falls back to a unit sphere when no part has bounds", () => {
    const geometry = new BufferGeometry();
    geometry.boundingBox = null;
    const bounds = impostorBounds([part(geometry, new Matrix4())]);
    expect(bounds.center.length()).toBe(0);
    expect(bounds.radius).toBe(0.5);
  });
});

describe("WorldImpostorAtlas", () => {
  it("allocates two full-mip RGBA attachments with an exact byte estimate", () => {
    const atlas = new WorldImpostorAtlas(128);
    expect(atlas.pixels).toBe(128);
    expect(atlas.target.textures[0]?.name).toBe("output");
    expect(atlas.target.textures[1]?.name).toBe("normal");
    expect(atlas.color.generateMipmaps).toBe(true);
    // Two RGBA8 attachments, every view, and the full mip chain down to 1x1.
    let bytes = 0;
    for (let level = 0; level <= Math.floor(Math.log2(atlas.pixels)); level += 1) {
      const edge = Math.max(1, atlas.pixels >> level);
      bytes += 2 * edge * edge * IMPOSTOR_VIEWS * 4;
    }
    expect(atlas.bytes).toBe(bytes);
    atlas.dispose();
  });
});

describe("WorldImpostorBaker", () => {
  it("captures every view, stages every source part, and regenerates mips only last", () => {
    const sourceMap = new Texture();
    const source = new MeshStandardMaterial({ alphaTest: 0.4, map: sourceMap });
    const geometry = boxedGeometry(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const sourceDispose = vi.spyOn(source, "dispose");
    const parts = [
      part(geometry, new Matrix4(), source),
      part(
        boxedGeometry(new Vector3(0, 0, 0), new Vector3(0.5, 0.5, 0.5)),
        new Matrix4().makeTranslation(0, 2, 0),
      ),
    ];
    const baker = new WorldImpostorBaker();
    const pending = baker.begin("tree.glb", parts, { pixels: IMPOSTOR_FRAME_PIXELS });
    const atlas = pending.atlas;
    const atlasDispose = vi.spyOn(atlas, "dispose");
    const clones = pending.materials;
    const stub = stubRenderer({ mipProbe: () => atlas.color.generateMipmaps });

    expect(pending.scene).toBeInstanceOf(Scene);
    expect(pending.scene.children).toHaveLength(2);
    expect(((pending.scene.children[0] as Mesh).material as NodeMaterial).alphaTest).toBe(0.4);
    for (const child of pending.scene.children) {
      const material = (child as Mesh).material as NodeMaterial;
      expect(material.alphaTest).toBeGreaterThan(0);
      expect(material.blending).toBe(NoBlending);
      expect(material.mrtNode).not.toBeNull();
      expect(material).not.toBe(source);
    }
    expect((clones[0] as NodeMaterial & { map?: Texture }).map).toBe(sourceMap);

    const results = [];
    for (let view = 0; view < IMPOSTOR_VIEWS; view += 1) results.push(baker.step(stub.renderer));
    expect(results.slice(0, -1).every((result) => result === undefined)).toBe(true);
    expect(results[IMPOSTOR_VIEWS - 1]).toBe(atlas);

    const layers = stub.targetCalls
      .filter((call) => call[0] === atlas.target)
      .map((call) => call[1]);
    expect(layers).toEqual(Array.from({ length: IMPOSTOR_VIEWS }, (_, view) => view));

    // The chain is allocated once, through three's public init, before the first draw...
    expect(stub.initRenderTarget).toHaveBeenCalledTimes(1);
    expect(stub.initRenderTarget).toHaveBeenCalledWith(atlas.target);
    expect(stub.events.indexOf("init")).toBeLessThan(stub.events.indexOf("render:1"));
    // ...and mip generation is on for the final draw only, so three does not regenerate per view.
    expect(stub.mipFlags).toEqual([
      ...Array.from({ length: IMPOSTOR_VIEWS - 1 }, () => false),
      true,
    ]);

    expect(baker.pending).toBeUndefined();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(sourceDispose).not.toHaveBeenCalled();
    // The completed atlas is the caller's lease; the baker must not dispose it on success.
    expect(atlasDispose).not.toHaveBeenCalled();

    atlas.dispose();
    baker.dispose();
  });

  it("restores every touched renderer state in finally when a capture throws", () => {
    const parts = [
      part(boxedGeometry(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)), new Matrix4()),
    ];
    const baker = new WorldImpostorBaker();
    const pending = baker.begin("tree.glb", parts, { pixels: 32 });
    const atlas = pending.atlas;
    const atlasDispose = vi.spyOn(atlas, "dispose");
    const cloneDispose = pending.materials.map((material) => vi.spyOn(material, "dispose"));
    const stub = stubRenderer({ throwOnRender: 3 });
    baker.step(stub.renderer);
    baker.step(stub.renderer);

    expect(() => baker.step(stub.renderer)).toThrow("capture failed");

    const restore = stub.targetCalls.at(-1);
    expect(restore?.[0]).toBe("previous-target");
    expect(restore?.[1]).toBe(3);
    expect(restore?.[2]).toBe(2);
    expect(stub.setMRT).toHaveBeenLastCalledWith("previous-mrt");
    expect(stub.renderer.xr?.enabled).toBe(true);
    expect(stub.renderer.autoClear).toBe(true);
    expect(stub.setClearAlpha).toHaveBeenLastCalledWith(0.75);
    expect(stub.setClearColor).toHaveBeenLastCalledWith({ r: 0.1, g: 0.2, b: 0.3 }, 0.75);
    expect(stub.initRenderTarget).toHaveBeenCalledTimes(1);
    expect(atlasDispose).toHaveBeenCalledTimes(1);
    for (const dispose of cloneDispose) expect(dispose).toHaveBeenCalledTimes(1);
    expect(baker.pending).toBeUndefined();
  });

  it("leaves borrowed geometry and materials untouched and abort is idempotent", () => {
    const geometry = boxedGeometry(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    const material = new MeshStandardMaterial();
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");
    const baker = new WorldImpostorBaker();
    const pending = baker.begin("tree.glb", [part(geometry, new Matrix4(), material)]);
    const atlasDispose = vi.spyOn(pending.atlas, "dispose");
    const cloneDisposes = pending.materials.map((clone) => vi.spyOn(clone, "dispose"));

    baker.abort();
    baker.abort();
    baker.dispose();
    baker.dispose();

    expect(atlasDispose).toHaveBeenCalledTimes(1);
    for (const dispose of cloneDisposes) expect(dispose).toHaveBeenCalledTimes(1);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
    expect(() => baker.step(stubRenderer().renderer)).toThrow(/dispose/u);
  });
});
