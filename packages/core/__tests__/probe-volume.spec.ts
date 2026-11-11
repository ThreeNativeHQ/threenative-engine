import {
  Box3,
  BoxGeometry,
  Color,
  Data3DTexture,
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPUCoordinateSystem,
} from "three";
import type { Node } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { FrameBudget } from "../src/frame-budget.js";
import { GPUSceneBVH } from "../src/gpu-scene-bvh.js";
import {
  ATLAS_PADDING,
  type IProbeVolumeCoefficient,
  PROBE_VOLUME_MARKER,
  ProbeVolume,
  readProbeVolumeObservation,
} from "../src/render/probe-volume.js";
import { RadianceCache } from "../src/render/radiance-cache.js";
import type { IRendererLike } from "../src/renderer.js";

const bounds = new Box3(new Vector3(0, 0, 0), new Vector3(2, 2, 2));

function coefficient(r: number, g: number, b: number): IProbeVolumeCoefficient[] {
  return Array.from({ length: 9 }, () => ({ r, g, b }));
}

function volume(options: Partial<ConstructorParameters<typeof ProbeVolume>[0]> = {}): ProbeVolume {
  return new ProbeVolume({
    bounds,
    density: 1,
    maxTextureDimension3D: 128,
    ...options,
  });
}

interface ITexture3DNode extends Node {
  readonly isTexture3DNode?: boolean;
  readonly uvNode?: unknown;
  readonly referenceNode?: ITexture3DNode;
  readonly value?: unknown;
}

function samplerTextureDimensions(node: Node): readonly string[] {
  const dimensions = new Set<string>();
  node.traverse((child) => {
    const textureNode = child as ITexture3DNode;
    if (textureNode.isTexture3DNode !== true) return;
    const texture = (textureNode.referenceNode ?? textureNode).value;
    if (texture instanceof Data3DTexture) {
      dimensions.add(`${texture.image.width}x${texture.image.height}x${texture.image.depth}`);
    }
  });
  return [...dimensions];
}

function webgpuRenderer(overrides: Record<string, unknown> = {}): IRendererLike {
  const raw = {
    coordinateSystem: WebGPUCoordinateSystem,
    copyTextureToTexture: vi.fn(),
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getRenderTarget: () => null,
    isWebGLRenderer: false,
    render: vi.fn(),
    reversedDepthBuffer: false,
    setRenderTarget: vi.fn(),
    xr: { enabled: false },
    ...overrides,
  };
  return { kind: "webgpu", raw } as unknown as IRendererLike;
}

describe("ProbeVolume", () => {
  it("rejects malformed density, bounds, and atlas limits at construction", () => {
    expect(() => volume({ density: 0 })).toThrow(/density/u);
    expect(() => volume({ density: -1 })).toThrow(/density/u);
    expect(
      () =>
        new ProbeVolume({
          bounds: new Box3(new Vector3(2, 0, 0), new Vector3(1, 2, 2)),
          density: 1,
        }),
    ).toThrow(/bounds/u);
    expect(
      () =>
        new ProbeVolume({
          bounds: new Box3(new Vector3(0, 0, 0), new Vector3(2, 2, 0)),
          density: 1,
        }),
    ).toThrow(/bounds/u);
    expect(() => volume({ maxTextureDimension3D: 16 })).toThrow(/maxTextureDimension3D/u);
  });

  it("normalizes per-axis density and rejects invalid bake camera options", () => {
    const subject = volume({
      density: [0.5, 1, 1.5],
      deviceTextureLimit: 42,
      bounces: 2,
      cubemapSize: 4,
      far: 20,
      near: 0.5,
    });
    expect(subject.resolution).toEqual(new Vector3(2, 3, 4));
    expect(subject.paddedSlices).toBe(6);
    expect(subject.atlasDepth).toBe(42);
    expect(subject.maximumDimension).toBe(42);
    expect(subject.observation.bakeProgress.passes).toBe(3);

    expect(() => volume({ density: { x: 0.5, y: 1, z: 1.5 } })).not.toThrow();
    expect(() => volume({ bakeBudgetMs: 0 })).toThrow(/bakeBudgetMs/u);
    expect(() => volume({ maxWorkItemsPerFrame: 1.5 })).toThrow(/maxWorkItemsPerFrame/u);
    expect(() => volume({ cubemapSize: 0 })).toThrow(/cubemapSize/u);
    expect(() => volume({ near: 0 })).toThrow(/near/u);
    expect(() => volume({ far: 0.5, near: 0.5 })).toThrow(/far/u);
    expect(() => volume({ bounces: -1 })).toThrow(/bounces/u);
    expect(() => volume({ maxTextureDimension3D: 1.5 })).toThrow(/maxTextureDimension3D/u);
  });

  it("samples both sides of every packed sub-volume seam through the public sampler", () => {
    const subject = volume({ report: () => undefined });
    expect(subject.probeCount).toBe(27);
    expect(subject.atlasDepth).toBe(7 * (3 + 2 * ATLAS_PADDING));
    expect(subject.atlasBytes).toBe(
      3 * 3 * subject.atlasDepth * 4 * Float32Array.BYTES_PER_ELEMENT,
    );

    const distinctCoefficients = Array.from({ length: 9 }, (_, index) => ({
      b: 40 + index,
      g: 20 + index,
      r: 1 + index,
    }));
    for (let iz = 0; iz < subject.resolution.z; iz += 1) {
      for (let iy = 0; iy < subject.resolution.y; iy += 1) {
        for (let ix = 0; ix < subject.resolution.x; ix += 1) {
          subject.setProbeCoefficients(ix, iy, iz, distinctCoefficients);
        }
      }
    }
    const normal = new Vector3(0, 1, 0);
    const centre = subject.sampleIrradiance(new Vector3(1, 1, 1), normal);
    const lowerSide = subject.sampleIrradiance(new Vector3(1, 1, 0), normal);
    const upperSide = subject.sampleIrradiance(new Vector3(1, 1, 2), normal);

    expect(lowerSide.distanceTo(centre)).toBeLessThan(0.00001);
    expect(upperSide.distanceTo(centre)).toBeLessThan(0.00001);
  });

  it("returns the emissive hue through the numeric probe diagnostic", () => {
    const subject = volume({ report: () => undefined });
    subject.setProbeCoefficients(0, 0, 0, coefficient(0.8, 0.05, 0.02));
    subject.setProbeCoefficients(2, 2, 2, coefficient(0.8, 0.05, 0.02));
    const irradiance = subject.sampleIrradiance(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    expect(irradiance.x).toBeGreaterThan(irradiance.y * 3);
    expect(irradiance.x).toBeGreaterThan(irradiance.z * 3);
  });

  it("keeps numeric and node sampling overloads on the same public seam", () => {
    const subject = volume({ report: () => undefined });
    subject.setProbeCoefficients(0, 0, 0, coefficient(0.3, 0.2, 0.1));

    const numeric = subject.sample(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    expect(numeric).toBeInstanceOf(Vector3);
    expect(numeric.x).toBeGreaterThan(numeric.z);
    expect(subject.sample()).toBeDefined();
    expect(subject.sample(new Vector3(0, 0, 0))).toBeDefined();
    expect(subject.sampleNode()).toBeDefined();
    expect(subject.probePosition(0, 0, 0)).toEqual(new Vector3(0, 0, 0));

    expect(() => subject.sampleIrradiance({} as Vector3, new Vector3())).toThrow(/Vector3/u);
    expect(() => subject.sampleIrradiance(new Vector3(), {} as Vector3)).toThrow(/Vector3/u);
  });

  it("reads the irradiance averaged over every normal for translucent surfaces and fog (PRD-643)", () => {
    const subject = volume({ report: () => undefined });
    // A strong L0 and distinct, signed L1 and L2 slots: only L0 may reach the non-directional read, and every axis
    // stays positive, because `sampleIrradiance` clamps each normal's value at zero.
    const skewed = Array.from({ length: 9 }, (_, index) =>
      index === 0
        ? { b: 0.5, g: 0.8, r: 1.2 }
        : {
            b: (index % 2 === 0 ? 1 : -1) * 0.02 * index,
            g: (index % 3 === 0 ? -1 : 1) * 0.03 * index,
            r: (index % 2 === 0 ? -1 : 1) * 0.04 * index,
          },
    );
    for (let iz = 0; iz < subject.resolution.z; iz += 1)
      for (let iy = 0; iy < subject.resolution.y; iy += 1)
        for (let ix = 0; ix < subject.resolution.x; ix += 1)
          subject.setProbeCoefficients(
            ix,
            iy,
            iz,
            skewed.map((c) => ({ b: c.b * (1 + ix), g: c.g * (1 + iy), r: c.r * (1 + iz) })),
          );
    const at = new Vector3(0.7, 1.2, 0.4);
    const axes = [
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(0, 0, 1),
      new Vector3(0, 0, -1),
    ];
    // The six axes integrate the L2 basis exactly, so their mean is the sphere's mean: the L0 term.
    const mean = axes
      .reduce((sum, n) => sum.add(subject.sampleIrradiance(at, n)), new Vector3())
      .divideScalar(axes.length);
    const flat = subject.sampleNonDirectional(at);
    expect(flat).toBeInstanceOf(Vector3);
    expect(flat.distanceTo(mean)).toBeLessThan(1e-4);
    expect(flat.x).toBeGreaterThan(0);
  });

  it("reads the radiance along a direction, not the cosine-smoothed irradiance (PRD-831)", () => {
    const subject = volume({ report: () => undefined });
    // L0 1 and an L1 slot along +y of 0.5: radiance along +y is c0 Y00 + c2 Y1 = 0.282095 + 0.5 x 0.488603, and the
    // irradiance keeps only 2/3 of the L1 band (pi x 0.282095 + 2 pi / 3 x 0.5 x 0.488603).
    const seeded = Array.from({ length: 9 }, (_, index) => {
      const value = index === 0 ? 1 : index === 1 ? 0.5 : 0;
      return { b: value, g: value, r: value };
    });
    for (let iz = 0; iz < subject.resolution.z; iz += 1)
      for (let iy = 0; iy < subject.resolution.y; iy += 1)
        for (let ix = 0; ix < subject.resolution.x; ix += 1)
          subject.setProbeCoefficients(ix, iy, iz, seeded);
    const at = new Vector3(0.7, 1.2, 0.4);
    const up = new Vector3(0, 1, 0);
    expect(subject.sampleRadiance(at, up).x).toBeCloseTo(0.282095 + 0.5 * 0.488603, 4);
    expect(subject.sampleRadiance(at, up.clone().negate()).x).toBeCloseTo(
      0.282095 - 0.5 * 0.488603,
      4,
    );
    expect(subject.sampleIrradiance(at, up).x).toBeCloseTo(0.886227 + 0.5 * 1.023328, 4);
    expect(subject.sampleRadianceNode()).toBeDefined();
  });

  it("reads radiance from the octahedral map when the volume keeps one, else from the SH (PRD-831)", () => {
    const mapTextures = (node: Node): string[] => {
      const sizes = new Set<string>();
      node.traverse((child) => {
        const value = (child as { value?: unknown }).value;
        if (value instanceof DataTexture) sizes.add(`${value.image.width}x${value.image.height}`);
      });
      return [...sizes];
    };
    const plain = volume({ report: () => undefined });
    expect(mapTextures(plain.sampleRadianceNode())).toEqual([]);
    expect(samplerTextureDimensions(plain.sampleRadianceNode())).toEqual(["3x3x35"]);
    const mapped = volume({ radianceProbeResolution: 4, report: () => undefined });
    const { x, y, z } = mapped.resolution;
    expect(mapTextures(mapped.sampleRadianceNode())).toEqual([`${x * 4}x${y * z * 4}`]);
    expect(() => volume({ radianceProbeResolution: -1 })).toThrow();
  });

  it("depth-tests the eight corner probes only when the volume keeps a map and asks for visibility (PRD-831)", () => {
    const mapTextures = (node: Node): number => {
      const reads = new Set<unknown>();
      node.traverse((child) => {
        if ((child as { value?: unknown }).value instanceof DataTexture) reads.add(child);
      });
      return reads.size;
    };
    // The plain read blends the probes with the atlas's own trilinear filter and reads no depth.
    expect(
      mapTextures(volume({ radianceProbeResolution: 4, report: () => undefined }).sampleNode()),
    ).toBe(0);
    const tested = volume({
      radianceProbeResolution: 4,
      probeVisibility: true,
      report: () => undefined,
    });
    // One depth read per corner probe, in the irradiance read and in the radiance read.
    expect(mapTextures(tested.sampleNode())).toBe(8);
    expect(mapTextures(tested.sampleRadianceNode())).toBeGreaterThanOrEqual(8);
    expect(() => volume({ probeVisibility: true })).toThrow(/radianceProbeResolution/);
  });

  it("reads the non-directional value with one atlas fetch, not seven (PRD-643)", () => {
    const subject = volume({ report: () => undefined });
    const fetches = (node: Node): number => {
      const seen = new Set<unknown>();
      node.traverse((child) => {
        const sampled = child as ITexture3DNode;
        // A fetch is a sample node with its own uv; the shared base node has none.
        if (sampled.isTexture3DNode === true && sampled.uvNode != null) seen.add(sampled);
      });
      return seen.size;
    };
    expect(fetches(subject.sampleNode())).toBe(7);
    expect(fetches(subject.sampleNonDirectional())).toBe(1);
    expect(samplerTextureDimensions(subject.sampleNonDirectional())).toEqual(["3x3x35"]);
  });

  it("rejects invalid coefficient edits at the public data seam", () => {
    const subject = volume({ report: () => undefined });
    const valid = coefficient(0.1, 0.2, 0.3);

    expect(() => subject.setProbeCoefficients(-1, 0, 0, valid)).toThrow(/ix/u);
    expect(() => subject.setProbeCoefficients(0, subject.resolution.y, 0, valid)).toThrow(/iy/u);
    expect(() => subject.setProbeCoefficients(0, 0, 0.5, valid)).toThrow(/iz/u);
    expect(() => subject.setProbeCoefficients(0, 0, 0, valid.slice(0, 8))).toThrow(/9/u);

    const nonFinite = valid.slice();
    nonFinite[0] = { b: 0.3, g: Number.POSITIVE_INFINITY, r: 0.1 };
    expect(() => subject.setProbeCoefficients(0, 0, 0, nonFinite)).toThrow(/finite/u);
  });

  it("coalesces pending bakes and closes every detached public seam", async () => {
    const subject = volume({ report: () => undefined });
    const scene = new Scene();
    const bake = subject.requestBake(scene);

    expect(subject.requestBake(scene)).toBe(bake);
    expect(() => subject.requestBake({} as Scene)).toThrow(/Scene/u);
    expect(() => subject.requestBake(scene, { bounces: -1 })).toThrow(/bounces/u);
    expect(() => subject.setProbeCoefficients(0, 0, 0, coefficient(1, 1, 1))).toThrow(/bake/u);

    subject.detach();
    expect(subject.released).toBe(true);
    await expect(bake).rejects.toThrow(/detached/u);
    expect(() => subject.attachRenderer(webgpuRenderer())).toThrow(/detach/u);
    expect(() => subject.requestBake(scene)).toThrow(/detach/u);
    expect(() => subject.process(webgpuRenderer())).toThrow(/detach/u);
    subject.detach();
  });

  it("dispatches bake overloads only for a complete renderer-shaped first argument", async () => {
    const scene = new Scene();
    const sceneBake = volume({ report: () => undefined });
    const scenePromise = sceneBake.bake(scene);
    expect(sceneBake.bake(scene)).toBe(scenePromise);
    sceneBake.detach();
    await expect(scenePromise).rejects.toThrow(/detached/u);

    for (const candidate of [null, "renderer", { kind: "webgpu" }]) {
      const subject = volume({ report: () => undefined });
      expect(() => subject.bake(candidate as unknown as Scene)).toThrow(/Scene/u);
    }

    const rendererBake = volume({ report: () => undefined });
    const rendererPromise = rendererBake.bake(webgpuRenderer(), scene);
    expect(rendererBake.observation.status).toBe("baking");
    rendererBake.detach();
    await expect(rendererPromise).rejects.toThrow(/detached/u);
  });

  it("reports an unbaked sample instead of hiding it as black", () => {
    const lines: string[] = [];
    const subject = volume({ report: (line) => lines.push(line) });
    const observation = subject.observation;
    expect(observation.marker).toBe(PROBE_VOLUME_MARKER);
    expect(observation.stale).toBe(true);
    expect(observation.unbaked).toBe(true);
    expect(observation.bakeProgress.completed).toBe(0);
    expect(lines.at(-1)).toMatch(/^TN_PROBE_VOLUME:/u);
  });

  it("rejects marker observations that omit staleness or progress data", () => {
    const subject = volume({ report: () => undefined });
    const observation = subject.observation;

    expect(readProbeVolumeObservation(observation)).toBe(observation);
    expect(
      readProbeVolumeObservation({
        ...observation,
        stalenessFrames: undefined,
      }),
    ).toBeUndefined();
    expect(
      readProbeVolumeObservation({
        ...observation,
        bakeProgress: { ...observation.bakeProgress, completed: Number.NaN },
      }),
    ).toBeUndefined();
  });

  it("rejects malformed scalar, atlas, and progress fields instead of accepting partial evidence", () => {
    const observation = volume({ report: () => undefined }).observation;
    const withPatch = (patch: Record<string, unknown>): unknown => ({ ...observation, ...patch });
    const invalidObservations: unknown[] = [
      null,
      [],
      withPatch({ marker: "TN_PROBE_VOLUME_OLD" }),
      withPatch({ status: "finished" }),
      withPatch({ stale: "false" }),
      withPatch({ unbaked: 0 }),
      withPatch({ stalenessFrames: -1 }),
      withPatch({ probeCount: 0 }),
      withPatch({ atlasBytes: 0 }),
      withPatch({ bakeCostMs: Number.NaN }),
      withPatch({ bakeBudgetMs: 0 }),
      withPatch({ samplingIsolated: null }),
      withPatch({ atlas: { ...observation.atlas, width: 1 } }),
      withPatch({ atlas: { ...observation.atlas, depth: observation.atlas.depth + 1 } }),
      withPatch({ bakeProgress: { ...observation.bakeProgress, fraction: 2 } }),
    ];

    for (const invalid of invalidObservations) {
      expect(readProbeVolumeObservation(invalid)).toBeUndefined();
    }
  });

  it("accepts a complete ready observation only when its age and sampling state are present", () => {
    const observation = volume({ report: () => undefined }).observation;
    const ready = {
      ...observation,
      status: "ready" as const,
      stale: false,
      unbaked: false,
      stalenessFrames: 0,
      samplingIsolated: false,
      bakeProgress: {
        ...observation.bakeProgress,
        completed: observation.bakeProgress.total,
        fraction: 1,
        probesCompleted: observation.bakeProgress.probesTotal,
        pass: observation.bakeProgress.passes - 1,
      },
    };

    expect(readProbeVolumeObservation(ready)).toBe(ready);
    expect(readProbeVolumeObservation({ ...ready, stalenessFrames: null })).toBeUndefined();
    expect(readProbeVolumeObservation({ ...ready, samplingIsolated: true })).toBeUndefined();
  });

  it("rejects malformed nested atlas and progress records", () => {
    const observation = volume({ report: () => undefined }).observation;
    expect(readProbeVolumeObservation({ ...observation, atlas: null })).toBeUndefined();
    expect(
      readProbeVolumeObservation({
        ...observation,
        atlas: { ...observation.atlas, depth: 21 },
      }),
    ).toBeUndefined();
    expect(readProbeVolumeObservation({ ...observation, bakeProgress: null })).toBeUndefined();
  });

  it("accepts a baking observation at the capture-to-repack boundary", () => {
    const observation = volume({ report: () => undefined }).observation;
    const completedCapture = observation.probeCount * 8;
    const baking = {
      ...observation,
      samplingIsolated: true,
      stale: true,
      status: "baking" as const,
      unbaked: false,
      bakeProgress: {
        ...observation.bakeProgress,
        completed: completedCapture,
        fraction: completedCapture / observation.bakeProgress.total,
        pass: 0,
        probesCompleted: observation.probeCount,
      },
    };

    expect(readProbeVolumeObservation(baking)).toBe(baking);
    expect(
      readProbeVolumeObservation({
        ...baking,
        bakeProgress: { ...baking.bakeProgress, completed: baking.bakeProgress.total, fraction: 1 },
      }),
    ).toBeUndefined();
  });

  it("rejects status, stale, and unbaked combinations the producer cannot emit", () => {
    const observation = volume({ report: () => undefined }).observation;
    const invalidStates = [
      ["unbaked", true, false],
      ["unbaked", false, true],
      ["unbaked", false, false],
      ["baking", false, false],
      ["baking", false, true],
      ["baking", true, true],
      ["ready", true, false],
      ["ready", false, true],
      ["ready", true, true],
    ] as const;

    for (const [status, stale, unbaked] of invalidStates) {
      expect(
        readProbeVolumeObservation({
          ...observation,
          stale,
          status,
          unbaked,
        }),
      ).toBeUndefined();
    }
  });

  it("rejects an isolated-state contradiction during the first bake pass", () => {
    const observation = volume({ report: () => undefined }).observation;

    expect(
      readProbeVolumeObservation({
        ...observation,
        samplingIsolated: false,
        status: "baking",
        stale: true,
        unbaked: false,
      }),
    ).toBeUndefined();
  });

  it("rejects inconsistent bake progress and pass relationships", () => {
    const observation = volume({ report: () => undefined }).observation;
    const progress = observation.bakeProgress;
    const invalidProgress = [
      { ...progress, fraction: 1 },
      { ...progress, passes: 0 },
      { ...progress, pass: progress.passes },
      { ...progress, total: 0 },
      {
        ...progress,
        completed: 1,
        fraction: 1 / progress.total,
        probesCompleted: 1,
      },
      { ...progress, probesTotal: progress.probesTotal + 1 },
      { ...progress, passes: progress.passes + 1, pass: progress.pass + 1 },
    ];

    for (const bakeProgress of invalidProgress) {
      expect(
        readProbeVolumeObservation({
          ...observation,
          bakeProgress,
        }),
      ).toBeUndefined();
    }
  });

  it("rejects progress that moves backwards across a bake pass", () => {
    const subject = volume({ report: () => undefined });
    void subject.requestBake(new Scene(), { bounces: 1 });
    const observation = subject.observation;
    const progress = observation.bakeProgress;
    const workPerPass = progress.total / progress.passes;
    const movedBackwards = {
      ...progress,
      completed: workPerPass,
      fraction: workPerPass / progress.total,
      pass: 1,
      probesCompleted: 0,
    };

    expect(
      readProbeVolumeObservation({
        ...observation,
        bakeProgress: movedBackwards,
      }),
    ).toBeUndefined();
  });

  it("guards renderer ownership and observes ready-volume staleness per idle frame", () => {
    const webgl = { kind: "webgl2", raw: {} } as unknown as IRendererLike;
    expect(() => volume({ report: () => undefined }).attachRenderer(webgl)).toThrow(
      /WebGPURenderer/u,
    );

    const deviceLimited = webgpuRenderer({ device: { limits: { maxTextureDimension3D: 34 } } });
    expect(() => volume({ report: () => undefined }).attachRenderer(deviceLimited)).toThrow(
      /device texture limit/u,
    );

    const subject = volume({ report: () => undefined });
    subject.setProbeCoefficients(0, 0, 0, coefficient(1, 1, 1));
    const first = webgpuRenderer();
    const second = webgpuRenderer();
    subject.attachRenderer(first);
    subject.attachRenderer(first);
    subject.process(first);
    expect(subject.observation.stalenessFrames).toBe(1);
    subject.process(first);
    expect(subject.observation.stalenessFrames).toBe(2);
    expect(() => subject.attachRenderer(second)).toThrow(/two renderers/u);
    expect(() => subject.process(second)).toThrow(/different renderer/u);
    expect(() => subject.process(webgl)).toThrow(/WebGPURenderer/u);
    subject.detach();
  });

  it("warms private bake shaders before charging bounded render slices", async () => {
    let nowMs = 0;
    const compiled = new Set<object>();
    const subject = volume({ bakeBudgetMs: 3, now: () => nowMs, report: () => undefined });
    const renderer = webgpuRenderer({
      render: vi.fn((scene: Scene) => {
        const material = (scene.children[0] as Mesh | undefined)?.material;
        const cold = material !== undefined && !compiled.has(material);
        if (material !== undefined) compiled.add(material);
        nowMs += cold ? 12 : 0.05;
      }),
    });
    subject.attachRenderer(renderer);
    nowMs = 0;
    const bake = subject.requestBake(new Scene());
    void bake.catch(() => undefined);
    for (let item = 0; item < subject.totalWork; item += 1) {
      expect(() => subject.process(renderer)).not.toThrow();
      expect(subject.observation.bakeCostMs).toBeLessThanOrEqual(3);
    }
    await bake;
    expect(subject.observation.status).toBe("ready");
    subject.detach();
  });

  it("keeps a large bake incremental across process calls", () => {
    let nowMs = 0;
    const subject = volume({
      bakeBudgetMs: 1,
      maxWorkItemsPerFrame: 1,
      now: () => nowMs,
      report: () => undefined,
    });
    const raw = {
      coordinateSystem: WebGPUCoordinateSystem,
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      isWebGLRenderer: false,
      copyTextureToTexture: vi.fn(),
      reversedDepthBuffer: false,
      setRenderTarget: vi.fn(),
      render: vi.fn(() => {
        nowMs += 0.25;
      }),
      xr: { enabled: false },
    };
    const renderer = { kind: "webgpu" as const, raw } as unknown as IRendererLike;
    subject.attachRenderer(renderer);
    nowMs = 0;
    void subject.requestBake(new Scene());
    const initialBakeObservation = subject.observation;
    expect(readProbeVolumeObservation(initialBakeObservation)).toBe(initialBakeObservation);
    subject.process(renderer);
    const inProgressObservation = subject.observation;
    expect(readProbeVolumeObservation(inProgressObservation)).toBe(inProgressObservation);
    expect(subject.observation.bakeProgress.completed).toBeLessThan(subject.probeCount);
    expect(subject.observation.bakeProgress.completed).toBeGreaterThan(0);
    subject.process(renderer);
    expect(subject.observation.bakeProgress.completed).toBeGreaterThan(1);
  });

  it("keeps each incremental bake slice inside the registered render budget", () => {
    const bakeBudgetMs = 3;
    let nowMs = 0;
    const subject = volume({
      bakeBudgetMs,
      maxWorkItemsPerFrame: Number.MAX_SAFE_INTEGER,
      now: () => nowMs,
      report: () => undefined,
    });
    const raw = {
      coordinateSystem: WebGPUCoordinateSystem,
      copyTextureToTexture: vi.fn(() => {
        nowMs += 0.25;
      }),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      isWebGLRenderer: false,
      reversedDepthBuffer: false,
      setRenderTarget: vi.fn(),
      render: vi.fn(() => {
        nowMs += 1;
      }),
      xr: { enabled: false },
    };
    const renderer = { kind: "webgpu" as const, raw } as unknown as IRendererLike;
    subject.attachRenderer(renderer);
    nowMs = 0;
    const bake = subject.requestBake(new Scene());
    const budget = new FrameBudget({ reportEvery: Number.MAX_SAFE_INTEGER });
    const samples: Array<{ readonly render: number }> = [];
    let timestampMs = 0;
    for (let frame = 0; frame < 100 && subject.observation.status === "baking"; frame += 1) {
      nowMs += 16;
      timestampMs += 16;
      budget.beginFrame(timestampMs, nowMs);
      budget.markSimulationEnd(nowMs, 0);
      const renderStart = nowMs;
      subject.process(renderer);
      budget.addRender(nowMs - renderStart);
      const sample = budget.endFrame(nowMs);
      if (sample !== undefined) samples.push({ render: sample.render });
    }
    void bake;

    expect(subject.observation.status).toBe("ready");
    expect(Math.max(...samples.map((sample) => sample.render))).toBeLessThanOrEqual(bakeBudgetMs);
    expect(samples.length).toBeGreaterThan(1);
  });

  it("fails closed when the first bake work item exceeds its render budget", async () => {
    const bakeBudgetMs = 3;
    let nowMs = 0;
    const subject = volume({
      bakeBudgetMs,
      maxWorkItemsPerFrame: Number.MAX_SAFE_INTEGER,
      now: () => nowMs,
      report: () => undefined,
    });
    const raw = {
      coordinateSystem: WebGPUCoordinateSystem,
      copyTextureToTexture: vi.fn(),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      isWebGLRenderer: false,
      reversedDepthBuffer: false,
      setRenderTarget: vi.fn(),
      render: vi.fn(() => {
        nowMs += 4;
      }),
      xr: { enabled: false },
    };
    const renderer = { kind: "webgpu" as const, raw } as unknown as IRendererLike;
    subject.attachRenderer(renderer);
    nowMs = 0;
    const bake = subject.requestBake(new Scene());

    expect(() => subject.process(renderer)).toThrow(/exceeds bakeBudgetMs/u);
    await expect(bake).rejects.toThrow(/exceeds bakeBudgetMs/u);
    expect(subject.observation.status).toBe("unbaked");
  });

  it("keeps baking, and reports the overrun, when a CPU rasteriser outruns the render budget", async () => {
    let nowMs = 0;
    const subject = volume({
      bakeBudgetMs: 3,
      maxWorkItemsPerFrame: 1,
      now: () => nowMs,
      report: () => undefined,
    });
    const raw = {
      coordinateSystem: WebGPUCoordinateSystem,
      copyTextureToTexture: vi.fn(),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      isWebGLRenderer: false,
      reversedDepthBuffer: false,
      setRenderTarget: vi.fn(),
      render: vi.fn(() => {
        nowMs += 14;
      }),
      xr: { enabled: false },
    };
    const renderer = {
      kind: "webgpu" as const,
      raw,
      softwareAdapter: "swiftshader",
    } as unknown as IRendererLike;
    subject.attachRenderer(renderer);
    nowMs = 0;
    const bake = subject.requestBake(new Scene());

    expect(() => subject.process(renderer)).not.toThrow();
    expect(subject.observation.bakeProgress.completed).toBe(1);
    expect(subject.observation.bakeCostMs).toBeGreaterThan(subject.observation.bakeBudgetMs);
    subject.detach();
    await expect(bake).rejects.toThrow(/detached/u);
  });

  it("fails closed when a later individual work item exceeds its render budget", async () => {
    const bakeBudgetMs = 3;
    let nowMs = 0;
    const renderCosts: number[] = [];
    const subject = volume({
      bakeBudgetMs,
      maxWorkItemsPerFrame: 1,
      now: () => nowMs,
      report: () => undefined,
    });
    const raw = {
      coordinateSystem: WebGPUCoordinateSystem,
      copyTextureToTexture: vi.fn(),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      isWebGLRenderer: false,
      reversedDepthBuffer: false,
      setRenderTarget: vi.fn(),
      render: vi.fn(() => {
        nowMs += renderCosts.shift() ?? 0;
      }),
      xr: { enabled: false },
    };
    const renderer = { kind: "webgpu" as const, raw } as unknown as IRendererLike;
    subject.attachRenderer(renderer);
    renderCosts.push(1, 4);
    nowMs = 0;
    const bake = subject.requestBake(new Scene());
    subject.process(renderer);

    expect(subject.observation.status).toBe("baking");
    expect(() => subject.process(renderer)).toThrow(/exceeds bakeBudgetMs/u);
    await expect(bake).rejects.toThrow(/exceeds bakeBudgetMs/u);
    expect(subject.observation.status).toBe("unbaked");
  });

  it("keeps depth testing enabled for cube-camera captures", () => {
    let cubeDepthBuffer: boolean | undefined;
    const subject = volume({ now: () => 0, report: () => undefined });
    const raw = {
      coordinateSystem: WebGPUCoordinateSystem,
      copyTextureToTexture: vi.fn(),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      isWebGLRenderer: false,
      reversedDepthBuffer: false,
      setRenderTarget: vi.fn((target: unknown) => {
        if (
          typeof target === "object" &&
          target !== null &&
          (target as { readonly isCubeRenderTarget?: boolean }).isCubeRenderTarget === true
        ) {
          cubeDepthBuffer = (target as { readonly depthBuffer?: boolean }).depthBuffer;
        }
      }),
      render: vi.fn(),
      xr: { enabled: false },
    };
    const renderer = { kind: "webgpu" as const, raw } as unknown as IRendererLike;
    subject.attachRenderer(renderer);
    void subject.requestBake(new Scene());
    subject.process(renderer);

    expect(cubeDepthBuffer).toBe(true);
  });

  it("isolates the previous atlas while pass zero removes lighting during a re-bake", async () => {
    // A fixed clock, for the same reason the budget tests inject one: `process` fails closed when
    // a single work item outruns `bakeBudgetMs`, and with the real clock that verdict depends on
    // how loaded the machine is. This test is about which atlas the sampler reads during a
    // re-bake, and it was failing in CI on `work item cost 22.667ms exceeds bakeBudgetMs 16ms` —
    // a wall-clock measurement taken by a test that measures nothing about time. The guard itself
    // stays exercised, deterministically, by the two tests that advance this clock on purpose.
    const subject = volume({
      bakeBudgetMs: 16,
      maxWorkItemsPerFrame: 3,
      now: () => 0,
      report: () => undefined,
    });
    subject.setProbeCoefficients(0, 0, 0, coefficient(1, 0, 0));
    const samplePosition = new Vector3(0, 0, 0);
    const sampleNormal = new Vector3(0, 1, 0);
    expect(subject.sampleIrradiance(samplePosition, sampleNormal).x).toBeGreaterThan(0);

    const scene = new Scene();
    const samplesDuringCapture: Vector3[] = [];
    const samplerTexturesDuringCapture: string[] = [];
    const sampleNode = subject.sampleNode();
    const raw = {
      coordinateSystem: WebGPUCoordinateSystem,
      copyTextureToTexture: vi.fn(),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      isWebGLRenderer: false,
      reversedDepthBuffer: false,
      setRenderTarget: vi.fn(),
      render: vi.fn((renderedScene: Scene) => {
        if (renderedScene === scene) {
          samplesDuringCapture.push(subject.sampleIrradiance(samplePosition, sampleNormal));
          samplerTexturesDuringCapture.push(...samplerTextureDimensions(sampleNode));
        }
      }),
      xr: { enabled: false },
    };
    const renderer = { kind: "webgpu" as const, raw } as unknown as IRendererLike;
    subject.attachRenderer(renderer);
    const bake = subject.requestBake(scene);

    expect(subject.observation).toMatchObject({ samplingIsolated: true });
    const rebakeObservation = subject.observation;
    expect(readProbeVolumeObservation(rebakeObservation)).toBe(rebakeObservation);
    for (let frame = 0; frame < 300 && subject.observation.status === "baking"; frame += 1) {
      subject.process(renderer);
      await Promise.resolve();
    }
    expect(subject.observation).toMatchObject({
      bakeProgress: { completed: subject.totalWork },
      status: "ready",
    });
    await bake;

    expect(samplesDuringCapture.length).toBeGreaterThan(0);
    expect(samplesDuringCapture.every((sample) => sample.lengthSq() === 0)).toBe(true);
    expect(new Set(samplerTexturesDuringCapture)).toEqual(new Set(["1x1x1"]));
    expect(subject.sampleIrradiance(samplePosition, sampleNormal).lengthSq()).toBe(0);
    expect(samplerTextureDimensions(sampleNode)).toEqual(["3x3x35"]);
    expect(raw.setRenderTarget).toHaveBeenCalled();
    expect(
      raw.setRenderTarget.mock.calls.some(
        ([target]) =>
          (target as { isWebGLRenderTarget?: boolean } | null)?.isWebGLRenderTarget === true,
      ),
    ).toBe(false);
    expect(subject.observation).toMatchObject({ samplingIsolated: false, status: "ready" });
  });

  describe("atlas render target", () => {
    const RENDER_ATTACHMENT = 0x10;

    interface IDeviceStub {
      readonly createTexture: ReturnType<typeof vi.fn>;
      readonly popErrorScope: ReturnType<typeof vi.fn>;
      readonly pushErrorScope: ReturnType<typeof vi.fn>;
    }

    /** A device whose 3D render attachment is rejected (`rejects`) or accepted, like wgpu-native vs Dawn. */
    function deviceStub(rejects: boolean): IDeviceStub {
      return {
        createTexture: vi.fn(() => ({ destroy: vi.fn() })),
        popErrorScope: vi.fn(async () => (rejects ? { message: "RENDER_ATTACHMENT D3" } : null)),
        pushErrorScope: vi.fn(),
      };
    }

    async function bakeOn(device: IDeviceStub | undefined, options = {}) {
      const subject = volume({ now: () => 0, report: () => undefined, ...options });
      const targets: unknown[] = [];
      const renderer = webgpuRenderer({
        backend: device === undefined ? undefined : { device },
        initTexture: vi.fn(),
        setRenderTarget: vi.fn((target: unknown) => targets.push(target)),
      });
      subject.attachRenderer(renderer);
      const bake = subject.requestBake(new Scene());
      const progress: number[] = [];
      for (let frame = 0; frame < 400 && subject.observation.status === "baking"; frame += 1) {
        subject.process(renderer);
        progress.push(subject.observation.bakeProgress.completed);
        await Promise.resolve();
      }
      await bake;
      return {
        progress,
        copies: (renderer.raw as { copyTextureToTexture: ReturnType<typeof vi.fn> })
          .copyTextureToTexture,
        subject,
        targets,
      };
    }

    const isRenderTarget3D = (target: unknown) =>
      (target as { isRenderTarget3D?: boolean } | null)?.isRenderTarget3D === true;
    const zOf = (call: unknown[]) => (call[3] as { z?: number } | undefined)?.z;

    it("renders into a 2D slice target and copies each slice when the device rejects a 3D render attachment", async () => {
      const device = deviceStub(true);
      const { copies, subject, targets } = await bakeOn(device);
      expect(device.createTexture).toHaveBeenCalledWith(
        expect.objectContaining({ dimension: "3d", usage: expect.any(Number) }),
      );
      expect(device.createTexture.mock.calls[0]?.[0].usage & RENDER_ATTACHMENT).toBe(
        RENDER_ATTACHMENT,
      );
      expect(subject.atlasTarget).toBe("copy");
      expect(subject.observation.status).toBe("ready");
      expect(targets.some(isRenderTarget3D)).toBe(false);
      const sliceCopies = copies.mock.calls.filter((call) => zOf(call) !== undefined);
      expect(sliceCopies.map((call) => zOf(call))).toEqual(
        Array.from({ length: subject.atlasDepth }, (_, slice) => slice),
      );
      expect(samplerTextureDimensions(subject.sampleNode())).toEqual([`3x3x${subject.atlasDepth}`]);
    });

    it("keeps the 3D render target where the device accepts it", async () => {
      const { copies, subject, targets } = await bakeOn(deviceStub(false));
      expect(subject.atlasTarget).toBe("render3d");
      expect(targets.some(isRenderTarget3D)).toBe(true);
      expect(copies.mock.calls.some((call) => zOf(call) !== undefined)).toBe(false);
    });

    it("runs the same bake schedule on both atlas paths, so the native schedule model holds for each", async () => {
      const options = { maxWorkItemsPerFrame: 3 };
      const render3d = await bakeOn(undefined, { ...options, atlasTarget: "render3d" });
      const copy = await bakeOn(undefined, { ...options, atlasTarget: "copy" });
      expect(copy.progress).toEqual(render3d.progress);
      expect(copy.progress.at(-1)).toBe(copy.subject.totalWork);
    });

    it("keeps the 3D render target on a host with no error scopes, and obeys the named override", async () => {
      expect((await bakeOn(undefined)).subject.atlasTarget).toBe("render3d");
      const device = deviceStub(false);
      const forced = await bakeOn(device, { atlasTarget: "copy" });
      expect(forced.subject.atlasTarget).toBe("copy");
      expect(device.createTexture).not.toHaveBeenCalled();
    });
  });

  describe("traced refresh (PRD-603)", () => {
    function emitterScene(): Scene {
      const scene = new Scene();
      const emitter = new Mesh(
        new BoxGeometry(0.5, 0.5, 0.5),
        new MeshBasicMaterial({ color: 0xff0000 }),
      );
      emitter.position.set(1, 1, 1);
      scene.add(emitter);
      scene.updateMatrixWorld(true);
      return scene;
    }

    /** A renderer that runs no GPU: `readback` answers a field whose every probe holds `c0 = rgb`. */
    function traceRenderer(
      rgb: readonly [number, number, number],
      gpuComputeMs?: () => number | undefined,
    ) {
      const compute = vi.fn();
      const readback = vi.fn(async (attribute: { array: Float32Array }) => {
        const field = new Float32Array(attribute.array.length);
        for (let at = 0; at < field.length; at += 36) field.set([...rgb, 0], at);
        return field.buffer;
      });
      const raw = {
        coordinateSystem: WebGPUCoordinateSystem,
        render: vi.fn(),
        setRenderTarget: vi.fn(),
      };
      const renderer = {
        compute,
        gpuComputeMs,
        kind: "webgpu",
        raw,
        readback,
      } as unknown as IRendererLike;
      return { compute, raw, readback, renderer };
    }

    function traced(options: Partial<ConstructorParameters<typeof ProbeVolume>[0]> = {}) {
      const scene = emitterScene();
      const sun = { color: new Color(1, 1, 1), direction: new Vector3(0, 1, 0), intensity: 0 };
      const subject = volume({
        report: () => undefined,
        trace: { bvh: new GPUSceneBVH(scene), sky: new Color(0, 0, 0), sun },
        ...options,
      });
      return { scene, subject, sun };
    }

    async function settle(subject: ProbeVolume, renderer: IRendererLike, frames: number) {
      for (let frame = 0; frame < frames; frame += 1) {
        subject.process(renderer);
        await Promise.resolve();
        await Promise.resolve();
      }
    }

    it("refreshes a probe with no scene draw, where capture draws the scene six times a probe", async () => {
      const capture = volume({ maxWorkItemsPerFrame: 1000, now: () => 0, report: () => undefined });
      const captureRaw = webgpuRenderer();
      const scene = emitterScene();
      capture.attachRenderer(captureRaw);
      const captureBake = capture.requestBake(scene);
      for (let frame = 0; frame < 50 && capture.observation.status === "baking"; frame += 1) {
        capture.process(captureRaw);
        await Promise.resolve();
      }
      await captureBake;
      const sceneDraws = (
        captureRaw.raw as { render: ReturnType<typeof vi.fn> }
      ).render.mock.calls.filter(([drawn]) => drawn === scene).length;
      expect(sceneDraws).toBe(6 * capture.probeCount);
      expect(capture.totalWork).toBe(capture.probeCount * 8 + 7 * capture.paddedSlices);

      const { subject } = traced();
      const { compute, raw, renderer } = traceRenderer([1, 0, 0]);
      const bake = subject.requestBake(new Scene());
      await settle(subject, renderer, 4);
      await bake;
      expect(raw.render).not.toHaveBeenCalled();
      expect(raw.setRenderTarget).not.toHaveBeenCalled();
      // With no GPU timing, a frame traces its start of 16 probes: 27 probes are two traces and two projections,
      // after the empty dispatch of each kernel that builds its pipeline outside a refresh slice.
      expect(compute).toHaveBeenCalledTimes(6);
      expect(subject.observation).toMatchObject({
        status: "ready",
        update: "trace",
        oldestProbeAgeFrames: expect.any(Number),
      });
      expect(readProbeVolumeObservation(subject.observation)).toBeDefined();
      // The read-back field lands in the same atlas `sampleNode` and `sampleIrradiance` read.
      const sample = subject.sampleIrradiance(new Vector3(1, 1, 1), new Vector3(0, 0, 1));
      expect(sample.x).toBeCloseTo(0.886227, 5);
      expect(sample.y).toBe(0);
    });

    it("gives a rejected probe depth 0, so the visibility test never weights a probe inside a solid (PRD-831)", async () => {
      const { subject } = traced({ radianceProbeResolution: 2, probeVisibility: true });
      const cells = 4;
      const { renderer } = traceRenderer([1, 0, 0]);
      (renderer as unknown as { readback: unknown }).readback = vi.fn(
        async (attribute: { array: Float32Array }) => {
          const field = new Float32Array(attribute.array.length);
          if (field.length === subject.probeCount * cells * 4) {
            // The map: every cell 3 m deep.
            for (let at = 3; at < field.length; at += 4) field[at] = 3;
          } else {
            // The SH: probe 0 met every ray from behind (share 1), the others none.
            for (let at = 0; at < field.length; at += 36)
              field.set([1, 0, 0, at === 0 ? 1 : 0], at);
          }
          return field.buffer;
        },
      );
      const bake = subject.requestBake(new Scene());
      await settle(subject, renderer, 4);
      await bake;
      let map: DataTexture | undefined;
      subject.sampleRadianceNode().traverse((child) => {
        const value = (child as { value?: unknown }).value;
        if (value instanceof DataTexture) map = value;
      });
      const data = map?.image.data as Float32Array;
      const { x: nx } = subject.resolution;
      const depthAt = (ix: number, iy: number, cell: number) =>
        data[((iy * 2 + Math.floor(cell / 2)) * nx * 2 + ix * 2 + (cell % 2)) * 4 + 3];
      expect([0, 1, 2, 3].map((cell) => depthAt(0, 0, cell))).toEqual([0, 0, 0, 0]);
      expect([0, 1, 2, 3].map((cell) => depthAt(1, 0, cell))).toEqual([3, 3, 3, 3]);
    });

    it("traces at most the budget a frame and resolves the bake once every probe refreshed", async () => {
      const { subject } = traced({ numProbesToTraceBudget: 10 });
      const { compute, renderer } = traceRenderer([0, 1, 0]);
      let resolved = false;
      void subject.requestBake(new Scene()).then(() => {
        resolved = true;
      });
      const traced27: number[] = [];
      for (let frame = 0; frame < 3; frame += 1) {
        await settle(subject, renderer, 1);
        traced27.push(subject.observation.probesTraced ?? -1);
        expect(readProbeVolumeObservation(subject.observation)).toBeDefined();
      }
      expect(traced27).toEqual([10, 10, 7]);
      // Three traces and three projections, after the two warm-up dispatches.
      expect(compute).toHaveBeenCalledTimes(8);
      await settle(subject, renderer, 2);
      expect(resolved).toBe(true);
      expect(subject.observation.bakeProgress.fraction).toBe(1);
    });

    it("serves a small sun drift from the old field and re-traces every probe on a lighting step", async () => {
      const { subject, sun } = traced({ numProbesToTraceBudget: 5 });
      const { renderer } = traceRenderer([2, 0, 0]);
      sun.intensity = 1;
      const bake = subject.requestBake(new Scene());
      await settle(subject, renderer, 10);
      await bake;
      expect(subject.observation.status).toBe("ready");
      const turn = (degrees: number) =>
        sun.direction.set(
          Math.sin((degrees * Math.PI) / 180),
          Math.cos((degrees * Math.PI) / 180),
          0,
        );
      turn(0);
      await settle(subject, renderer, 1);
      turn(0.6);
      await settle(subject, renderer, 3);
      expect(subject.observation.status).toBe("ready");
      // Past one degree from the sun at the last step: every probe is stale, the budget stays at 5 a frame.
      turn(1.5);
      await settle(subject, renderer, 1);
      expect(subject.observation.status).toBe("baking");
      expect(subject.observation.probesTraced).toBe(5);
      expect(
        subject.sampleIrradiance(new Vector3(1, 1, 1), new Vector3(0, 1, 0)).x,
      ).toBeGreaterThan(1);
      await settle(subject, renderer, 8);
      expect(subject.observation.status).toBe("ready");
      // A brightest-channel change beyond 4x steps too; 3x does not.
      sun.intensity = 3;
      await settle(subject, renderer, 2);
      expect(subject.observation.status).toBe("ready");
      sun.intensity = 5;
      await settle(subject, renderer, 1);
      expect(subject.observation.status).toBe("baking");
    });

    it("sizes a frame's batch by the measured GPU cost against the bake budget", async () => {
      // 0.25 ms a probe: the 2 ms budget fits 8.
      const slow = traced({ bounds: new Box3(new Vector3(-4, -4, -4), new Vector3(4, 4, 4)) });
      const slowRenderer = traceRenderer([1, 0, 0], () => 0.25 * slowLast);
      let slowLast = 0;
      const slowCounts: number[] = [];
      void slow.subject.requestBake(new Scene());
      for (let frame = 0; frame < 4; frame += 1) {
        await settle(slow.subject, slowRenderer.renderer, 1);
        slowLast = slow.subject.observation.probesTraced ?? 0;
        slowCounts.push(slowLast);
      }
      expect(slowCounts).toEqual([16, 8, 8, 8]);
      // 0.000625 ms a probe fits far more than the budget: it doubles a frame, never past the budget of 100.
      const fast = traced({ bounds: new Box3(new Vector3(-3, -3, -3), new Vector3(3, 3, 3)) });
      const fastRenderer = traceRenderer([1, 0, 0], () => 0.000625 * fastLast);
      let fastLast = 0;
      const fastCounts: number[] = [];
      void fast.subject.requestBake(new Scene());
      for (let frame = 0; frame < 4; frame += 1) {
        await settle(fast.subject, fastRenderer.renderer, 1);
        fastLast = fast.subject.observation.probesTraced ?? 0;
        fastCounts.push(fastLast);
      }
      expect(fastCounts).toEqual([16, 32, 64, 100]);
    });

    it("builds a RadianceCache that always updates by trace", async () => {
      const cache = new RadianceCache({
        bounds,
        density: 1,
        maxTextureDimension3D: 128,
        report: () => undefined,
        trace: {
          bvh: new GPUSceneBVH(emitterScene()),
          sky: new Color(0, 0, 0),
          sun: { color: new Color(1, 1, 1), direction: new Vector3(0, 1, 0), intensity: 0 },
        },
      });
      const { raw, renderer } = traceRenderer([1, 0, 0]);
      const bake = cache.requestBake(new Scene());
      await settle(cache, renderer, 4);
      await bake;
      expect(cache.observation.update).toBe("trace");
      expect(raw.render).not.toHaveBeenCalled();
    });

    it("keeps the old field readable while a new request refreshes it", async () => {
      const { subject } = traced({ numProbesToTraceBudget: 5 });
      const { renderer } = traceRenderer([2, 0, 0]);
      const bake = subject.requestBake(new Scene());
      await settle(subject, renderer, 8);
      await bake;
      void subject.requestBake(new Scene());
      expect(subject.observation.status).toBe("baking");
      expect(subject.observation.samplingIsolated).toBe(false);
      expect(readProbeVolumeObservation(subject.observation)).toBeDefined();
      expect(
        subject.sampleIrradiance(new Vector3(1, 1, 1), new Vector3(0, 1, 0)).x,
      ).toBeGreaterThan(1);
    });

    it("refreshes every probe by itself when the game switches a lamp off", async () => {
      const { scene, subject } = traced({ numProbesToTraceBudget: 10 });
      const { compute, renderer } = traceRenderer([1, 0, 0]);
      const bake = subject.requestBake(new Scene());
      await settle(subject, renderer, 5);
      await bake;
      await settle(subject, renderer, 2);
      const before = compute.mock.calls.length;
      ((scene.children[0] as Mesh).material as MeshBasicMaterial).color.setRGB(0, 0, 0);
      subject.process(renderer);
      expect(subject.observation.status).toBe("baking");
      expect(compute.mock.calls.length).toBe(before + 2);
      await settle(subject, renderer, 4);
      expect(subject.observation.status).toBe("ready");
    });

    it("traces a fixed batch a frame when probesPerFrame is set, whatever the GPU reports", () => {
      const fixed = volume({
        numProbesToTraceBudget: 10,
        probesPerFrame: 4,
        report: () => undefined,
        trace: {
          bvh: new GPUSceneBVH(emitterScene()),
          sky: new Color(0, 0, 0),
          sun: { color: new Color(1, 1, 1), direction: new Vector3(0, 1, 0), intensity: 0 },
        },
      });
      void fixed.requestBake(new Scene());
      expect(fixed.selectStaleProbes()).toEqual([0, 1, 2, 3]);
    });

    it("refreshes never-traced probes first, then the probes in view the longest since their trace", async () => {
      // A narrow view down -z through x = 1, y = 1 sees probes 4, 13 and 22 of the 3 x 3 x 3 grid.
      const camera = new PerspectiveCamera(10, 1, 0.1, 100);
      camera.position.set(1, 1, 6);
      camera.lookAt(1, 1, 0);
      camera.updateMatrixWorld(true);
      const lazy = volume({
        numProbesToTraceBudget: 10,
        report: () => undefined,
        trace: {
          bvh: new GPUSceneBVH(emitterScene()),
          camera,
          sky: new Color(0, 0, 0),
          sun: { color: new Color(1, 1, 1), direction: new Vector3(0, 1, 0), intensity: 0 },
        },
      });
      void lazy.requestBake(new Scene());
      expect(lazy.selectStaleProbes()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const { renderer } = traceRenderer([1, 1, 1]);
      // Frames 1-3 trace probes 0-9, 10-19 and 20-26; frames 4-6 only mark the probes in view as used.
      await settle(lazy, renderer, 6);
      expect(lazy.observation.status).toBe("ready");
      void lazy.requestBake(new Scene());
      // In view, the oldest trace first (4, then 13, then 22); out of view, the oldest trace first.
      expect(lazy.selectStaleProbes()).toEqual([4, 13, 22, 0, 1, 2, 3, 5, 6, 7]);
    });
  });
});
