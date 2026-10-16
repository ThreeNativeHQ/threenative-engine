import { BoxGeometry, type BufferGeometry, Camera, Mesh, Scene } from "three";
// @ts-expect-error Three's private renderer module has no public declaration; this test must exercise it directly.
import RenderObjects from "three/src/renderers/common/RenderObjects.js";
import {
  FrontSide,
  MeshStandardNodeMaterial,
  NodeMaterial,
  PCFShadowMap,
  Renderer,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";

// Three.js draws every shadow caster of one light through a single shared override material and
// copies each caster's `alphaTest` onto it. `Material.alphaTest`'s setter bumps `version` whenever
// alpha-test-ness flips, so a scene that mixes alpha-tested casters (foliage) with opaque ones
// (trunks, terrain) moves that shared version several times per shadow pass. `RenderObjects.get`
// then fails `renderObject.version !== material.version` for every *other* render object drawn with
// the same override material and recomputes a full material cache key — an ~90-property walk plus
// `customProgramCacheKey` — that always matches, so nothing is rebuilt and the work is pure waste.
//
// Measured on the Wildwood sandbox game (RTX 2080, 1280x720, 30s steady-state CPU trace):
// 7.7 version flips and 162 wasted `getMaterialCacheKey` calls per frame, 11.1% of sampled CPU,
// with `dynamicOpen` and `clipOpen` both exactly zero — the version gate was the only one open.
// Evidence: artifacts/wildwood-performance/cache-gate/.
//
// The fix lives in `packages/core/patches/three@0.185.1.patch`: the per-object scratchpad write goes to the
// backing field so the shared version stops moving, and each render object tracks its own source
// material's version instead, which is the signal that actually belongs to it.

interface IDrawnMaterial {
  readonly alphaTest: number;
  readonly side: number;
}

interface IShadowRendererStub {
  readonly _cacheShadowNodes: WeakMap<object, unknown>;
  _currentSourceMaterial: unknown;
  readonly _getShadowNodes: unknown;
  readonly _handleObjectFunction: (
    object: unknown,
    material: IDrawnMaterial,
    scene: Scene,
    camera: Camera,
  ) => void;
  readonly shadowMap: { enabled: boolean; type: number };
}

type RenderObjectCall = (
  this: IShadowRendererStub,
  object: unknown,
  scene: Scene,
  camera: Camera,
  geometry: unknown,
  material: unknown,
  group: unknown,
  lightsNode: unknown,
  clippingContext: unknown,
  passId: unknown,
) => void;

function shadowPass(onDraw?: (mesh: Mesh, camera: Camera) => void): {
  drawn: IDrawnMaterial[];
  draw: (mesh: Mesh, camera?: Camera) => void;
  override: NodeMaterial;
} {
  const drawn: IDrawnMaterial[] = [];
  const rendererPrototype = Renderer.prototype as unknown as {
    _getShadowNodes: unknown;
    renderObject: RenderObjectCall;
  };
  const stub: IShadowRendererStub = {
    _cacheShadowNodes: new WeakMap<object, unknown>(),
    _currentSourceMaterial: null,
    _getShadowNodes: rendererPrototype._getShadowNodes,
    _handleObjectFunction: (object, material, _scene, camera) => {
      drawn.push({ alphaTest: material.alphaTest, side: material.side });
      onDraw?.(object as Mesh, camera);
    },
    shadowMap: { enabled: true, type: PCFShadowMap },
  };

  const override = new NodeMaterial();
  (override as NodeMaterial & { isShadowPassMaterial: boolean }).isShadowPassMaterial = true;
  override.name = "ShadowMaterial";
  const scene = new Scene();
  scene.overrideMaterial = override;
  const camera = new Camera();

  return {
    draw: (mesh, drawCamera = camera) =>
      rendererPrototype.renderObject.call(
        stub,
        mesh,
        scene,
        drawCamera,
        mesh.geometry,
        mesh.material,
        null,
        null,
        null,
        null,
      ),
    drawn,
    override,
  };
}

function caster(alphaTest: number): Mesh {
  const material = new MeshStandardNodeMaterial();
  material.alphaTest = alphaTest;
  material.side = FrontSide;
  return new Mesh(new BoxGeometry(1, 1, 1), material);
}

type InternalNodeMaterial = NodeMaterial & {
  _alphaTest: number;
  isShadowPassMaterial: boolean;
};

interface IRenderObjectProbe {
  readonly geometry: BufferGeometry;
  readonly _sourceMaterial: NodeMaterial | null;
  readonly sourceVersion: number;
  readonly version: number;
  readonly needsUpdate: boolean;
  getCacheKey: () => number;
  dispose: () => void;
}

interface IRenderObjectsProbe {
  get: (
    object: Mesh,
    material: NodeMaterial,
    scene: Scene,
    camera: Camera,
    lightsNode: unknown,
    renderContext: { id: number },
    clippingContext: null,
  ) => IRenderObjectProbe;
}

interface IRendererProbe {
  _currentSourceMaterial: NodeMaterial | null;
  readonly backend: { isWebGPUBackend: true };
  readonly contextNode: { id: number; version: number };
  readonly currentSamples: number;
  readonly getRenderTarget: () => { samples: number } | null;
}

function renderObjectsProbe(): {
  get: (object: Mesh, source: NodeMaterial, camera?: Camera) => IRenderObjectProbe;
  makeSource: (alphaTest: number) => MeshStandardNodeMaterial;
  makeObject: (source: NodeMaterial) => Mesh;
  override: InternalNodeMaterial;
  /** Mimic the engine's `compileAsync()` swap: a non-null framebuffer target while it compiles. */
  setRenderTargetSamples: (samples: number) => void;
} {
  let renderTarget: { samples: number } | null = null;
  const renderer: IRendererProbe = {
    _currentSourceMaterial: null,
    backend: { isWebGPUBackend: true },
    contextNode: { id: 1, version: 0 },
    currentSamples: 0,
    getRenderTarget: () => renderTarget,
  };
  const nodes = {
    delete: vi.fn(),
    getCacheKey: vi.fn(() => 0),
  };
  const pipelines = { delete: vi.fn() };
  const bindings = { deleteForRender: vi.fn() };
  const manager = new RenderObjects(
    renderer,
    nodes,
    { getIndex: () => null, releaseRenderObject: vi.fn() },
    pipelines,
    bindings,
    {},
  ) as unknown as IRenderObjectsProbe;
  const override = new NodeMaterial() as InternalNodeMaterial;
  override.isShadowPassMaterial = true;
  const scene = new Scene();
  const camera = new Camera();
  const renderContext = { id: 1 };
  const lightsNode = {};

  return {
    get: (object, source, drawCamera = camera) => {
      renderer._currentSourceMaterial = source;
      // This is the backing-field write performed by the patched Renderer during a shadow pass.
      override._alphaTest = source.alphaTest;
      return manager.get(object, override, scene, drawCamera, lightsNode, renderContext, null);
    },
    makeSource: (alphaTest) => {
      const source = new MeshStandardNodeMaterial();
      source.alphaTest = alphaTest;
      return source;
    },
    makeObject: (source) => new Mesh(new BoxGeometry(1, 1, 1), source),
    override,
    setRenderTargetSamples: (samples) => {
      renderTarget = samples === 0 ? null : { samples };
    },
  };
}

describe("three shadow override material cache", () => {
  it("fetches geometry swapped in onBeforeRender even when cameras share a render object", () => {
    const probe = renderObjectsProbe();
    const source = probe.makeSource(0);
    const object = probe.makeObject(source);
    const geometry = object.geometry;
    const geometries = [geometry, geometry.clone(), geometry.clone()];
    for (const held of geometries) held.setAttribute("position", geometry.getAttribute("position"));
    const cameras = [new Camera(), new Camera(), new Camera()];
    object.onBeforeRender = (_renderer, _scene, camera) => {
      object.geometry = geometries[cameras.indexOf(camera)] as BufferGeometry;
    };
    const fetched: IRenderObjectProbe[] = [];
    const { draw } = shadowPass((mesh, camera) => {
      const renderObject = probe.get(mesh, source, camera);
      expect(renderObject.geometry).toBe(geometries[cameras.indexOf(camera)]);
      expect(renderObject.geometry.getIndex()).toBe(mesh.geometry.getIndex());
      fetched.push(renderObject);
    });
    for (let frame = 0; frame < 3; frame += 1) for (const camera of cameras) draw(object, camera);
    expect(fetched).toHaveLength(9);
    expect(new Set(fetched).size).toBe(1);
    for (const held of geometries) held.dispose();
  });

  it("keeps the shared override material's version still across mixed alphaTest casters", () => {
    const { draw, override } = shadowPass();
    const foliage = caster(0.5);
    const trunk = caster(0);

    draw(foliage);
    const baseline = override.version;
    for (let frame = 0; frame < 3; frame += 1) {
      draw(trunk);
      draw(foliage);
    }

    // Every bump here invalidates the version gate for all 162 shadow render objects that share
    // this material, costing a full material cache key recompute per object per frame.
    expect(override.version - baseline).toBe(0);
  });

  it("still hands each caster's own alphaTest and side to the draw", () => {
    const { draw, drawn } = shadowPass();
    const foliage = caster(0.5);
    const trunk = caster(0);

    draw(foliage);
    draw(trunk);
    draw(foliage);

    // The material cache key reads `alphaTest` through its public getter, so suppressing the
    // version bump must not change the value the shadow draw sees.
    expect(drawn.map((entry) => entry.alphaTest)).toEqual([0.5, 0, 0.5]);
    expect(new Set(drawn.map((entry) => entry.side)).size).toBe(1);
  });

  it("restores the override material to its own alphaTest after the pass", () => {
    const { draw, override } = shadowPass();
    const baseline = override.alphaTest;

    draw(caster(0.5));

    expect(override.alphaTest).toBe(baseline);
  });
});

describe("three RenderObjects source invalidation", () => {
  it("does not validate an unchanged source and override pair", () => {
    const probe = renderObjectsProbe();
    const source = probe.makeSource(0.5);
    const object = probe.makeObject(source);
    const renderObject = probe.get(object, source);
    const getCacheKey = vi.spyOn(renderObject, "getCacheKey");

    expect(probe.get(object, source)).toBe(renderObject);
    expect(getCacheKey).not.toHaveBeenCalled();
  });

  it("keeps material groups alive until their shadow commands are submitted", () => {
    const probe = renderObjectsProbe();
    const top = probe.makeSource(0);
    const bottom = probe.makeSource(0);
    const wing = probe.makeObject(top);
    wing.material = [top, bottom];
    const topDraw = probe.get(wing, top);
    const dispose = vi.spyOn(topDraw, "dispose");
    const bottomDraw = probe.get(wing, bottom);

    expect(dispose).not.toHaveBeenCalled();
    expect(bottomDraw).not.toBe(topDraw);
    expect(probe.get(wing, top)).toBe(topDraw);
    expect(probe.get(wing, bottom)).toBe(bottomDraw);
    topDraw.dispose();
    expect(probe.get(wing, top)).not.toBe(topDraw);
    expect(probe.get(wing, bottom)).toBe(bottomDraw);
  });

  it("validates and recreates when source alpha-test state changes", () => {
    const probe = renderObjectsProbe();
    const source = probe.makeSource(0.5);
    const object = probe.makeObject(source);
    const renderObject = probe.get(object, source);
    const getCacheKey = vi.spyOn(renderObject, "getCacheKey");

    source.alphaTest = 0;
    const refreshed = probe.get(object, source);

    expect(source.version).toBeGreaterThan(renderObject.sourceVersion);
    expect(getCacheKey).toHaveBeenCalledTimes(1);
    expect(refreshed).not.toBe(renderObject);
    expect(refreshed._sourceMaterial).toBe(source);
  });

  it("validates a source needsUpdate change and settles when its key is stable", () => {
    const probe = renderObjectsProbe();
    const source = probe.makeSource(0.5);
    const object = probe.makeObject(source);
    const renderObject = probe.get(object, source);
    const getCacheKey = vi.spyOn(renderObject, "getCacheKey");

    source.needsUpdate = true;
    expect(probe.get(object, source)).toBe(renderObject);
    expect(getCacheKey).toHaveBeenCalledTimes(1);
    expect(probe.get(object, source)).toBe(renderObject);
    expect(getCacheKey).toHaveBeenCalledTimes(1);
  });

  it("recreates when the source material is replaced at the same version", () => {
    const probe = renderObjectsProbe();
    const firstSource = probe.makeSource(0.5);
    const replacement = probe.makeSource(0.5);
    const object = probe.makeObject(firstSource);
    const renderObject = probe.get(object, firstSource);
    const getCacheKey = vi.spyOn(renderObject, "getCacheKey");

    const refreshed = probe.get(object, replacement);

    expect(replacement.version).toBe(firstSource.version);
    expect(getCacheKey).not.toHaveBeenCalled();
    expect(refreshed).not.toBe(renderObject);
    expect(refreshed._sourceMaterial).toBe(replacement);
  });

  it("validates an override needsUpdate change and settles when its key is stable", () => {
    const probe = renderObjectsProbe();
    const source = probe.makeSource(0.5);
    const object = probe.makeObject(source);
    const renderObject = probe.get(object, source);
    const getCacheKey = vi.spyOn(renderObject, "getCacheKey");

    probe.override.needsUpdate = true;
    expect(probe.get(object, source)).toBe(renderObject);
    expect(getCacheKey).toHaveBeenCalledTimes(1);
    expect(probe.get(object, source)).toBe(renderObject);
    expect(getCacheKey).toHaveBeenCalledTimes(1);
  });

  it("keeps one caster's source change from invalidating another caster", () => {
    const probe = renderObjectsProbe();
    const firstSource = probe.makeSource(0.5);
    const secondSource = probe.makeSource(0.5);
    const firstObject = probe.makeObject(firstSource);
    const secondObject = probe.makeObject(secondSource);
    const firstRenderObject = probe.get(firstObject, firstSource);
    const secondRenderObject = probe.get(secondObject, secondSource);
    const firstGetCacheKey = vi.spyOn(firstRenderObject, "getCacheKey");
    const secondGetCacheKey = vi.spyOn(secondRenderObject, "getCacheKey");

    firstSource.alphaTest = 0;
    const refreshedFirst = probe.get(firstObject, firstSource);
    const unchangedSecond = probe.get(secondObject, secondSource);

    expect(firstGetCacheKey).toHaveBeenCalledTimes(1);
    expect(refreshedFirst).not.toBe(firstRenderObject);
    expect(unchangedSecond).toBe(secondRenderObject);
    expect(secondGetCacheKey).not.toHaveBeenCalled();
  });

  it("keeps a render object's key stable while a compile swaps the render target", () => {
    const probe = renderObjectsProbe();
    const source = probe.makeSource(0.5);
    const object = probe.makeObject(source);
    const renderObject = probe.get(object, source);

    // `compileAsync()` replaces `renderer.getRenderTarget()` with the framebuffer target for the
    // length of its slice, and a live frame then reads `currentSamples`. A dynamic key that reads
    // `getRenderTarget()` disagrees between the two, so `RenderObjects.get` disposes this object
    // and its pipeline is recompiled — the arm64 CI stall that took the playtest screenshot down.
    probe.setRenderTargetSamples(4);
    expect(probe.get(object, source)).toBe(renderObject);
    probe.setRenderTargetSamples(0);
    expect(probe.get(object, source)).toBe(renderObject);
  });
});
