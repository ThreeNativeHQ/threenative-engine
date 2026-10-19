import { Group } from "three";
import { describe, expect, it } from "vitest";
import {
  type ISpectralOceanOptions,
  cascadeBands,
  initialSpectrumData,
  phillipsEnergy,
  sampleGrid,
} from "../src/ocean/spectral.js";
import type { IRendererLike } from "../src/renderer.js";

const TUNING = {
  amplitude: 4e-4,
  directionality: 2,
  gravity: 9.81,
  seed: 1234,
  smallWaveCutoff: 0.4,
  windDirection: 0.6,
  windSpeed: 12,
} as const;

function options(overrides: Partial<ISpectralOceanOptions> = {}): ISpectralOceanOptions {
  return {
    ...TUNING,
    cascades: [{ patchSize: 200 }, { patchSize: 40 }],
    choppiness: 1.1,
    readbackEveryFrames: 4,
    readbackResolution: 16,
    resolution: 16,
    ...overrides,
  };
}

describe("cascadeBands", () => {
  it("should partition the spectrum so no wavelength is simulated twice", () => {
    const cascades = [{ patchSize: 200 }, { patchSize: 40 }, { patchSize: 8 }];
    const bands = cascadeBands(64, cascades);
    expect(bands).toHaveLength(3);
    // Each band starts exactly where the previous one's Nyquist ended: contiguous, non-overlapping.
    expect(bands[0]?.kMin).toBe(0);
    expect(bands[0]?.kMax).toBeCloseTo(bands[1]?.kMin as number, 12);
    expect(bands[1]?.kMax).toBeCloseTo(bands[2]?.kMin as number, 12);
    // The smallest patch keeps the tail, so no energy falls off the end of the cascade list.
    expect(bands[2]?.kMax).toBe(Number.POSITIVE_INFINITY);
  });

  it("should give a single cascade the whole spectrum", () => {
    const bands = cascadeBands(64, [{ patchSize: 100 }]);
    expect(bands[0]).toStrictEqual({ kMin: 0, kMax: Number.POSITIVE_INFINITY });
  });
});

describe("phillipsEnergy", () => {
  const band = { kMin: 0, kMax: Number.POSITIVE_INFINITY };

  it("should hold no energy at zero wavenumber", () => {
    expect(phillipsEnergy(0, 0, { ...TUNING, ...band })).toBe(0);
  });

  it("should hold no energy in waves running against the wind", () => {
    const withWind = phillipsEnergy(Math.cos(0.6), Math.sin(0.6), { ...TUNING, ...band });
    const againstWind = phillipsEnergy(-Math.cos(0.6), -Math.sin(0.6), { ...TUNING, ...band });
    expect(withWind).toBeGreaterThan(0);
    expect(againstWind).toBe(0);
  });

  it("should fall off with the directional spread exponent", () => {
    const oblique = { kx: Math.cos(1.4), kz: Math.sin(1.4) };
    const loose = phillipsEnergy(oblique.kx, oblique.kz, {
      ...TUNING,
      ...band,
      directionality: 1,
    });
    const tight = phillipsEnergy(oblique.kx, oblique.kz, {
      ...TUNING,
      ...band,
      directionality: 6,
    });
    expect(tight).toBeLessThan(loose);
  });

  it("should hold no energy outside its own cascade band", () => {
    const inside = phillipsEnergy(0.5, 0.3, { ...TUNING, kMin: 0, kMax: 10 });
    const belowBand = phillipsEnergy(0.5, 0.3, { ...TUNING, kMin: 5, kMax: 10 });
    const aboveBand = phillipsEnergy(0.5, 0.3, { ...TUNING, kMin: 0, kMax: 0.1 });
    expect(inside).toBeGreaterThan(0);
    expect(belowBand).toBe(0);
    expect(aboveBand).toBe(0);
  });

  it("should suppress tiny waves and exclude both band endpoints", () => {
    expect(phillipsEnergy(5e-7, 0, { ...TUNING, ...band })).toBe(0);
    const bounded = { ...TUNING, kMin: 1, kMax: 2 };
    expect(phillipsEnergy(0.999, 0, bounded)).toBe(0);
    expect(phillipsEnergy(1, 0, bounded)).toBeGreaterThan(0);
    expect(phillipsEnergy(2, 0, bounded)).toBe(0);
    expect(phillipsEnergy(1.5, 0, bounded)).toBeGreaterThan(0);
  });

  it("should carry more energy in a stronger wind", () => {
    const breeze = phillipsEnergy(0.2, 0.1, { ...TUNING, ...band, windSpeed: 4 });
    const gale = phillipsEnergy(0.2, 0.1, { ...TUNING, ...band, windSpeed: 20 });
    expect(gale).toBeGreaterThan(breeze);
  });
});

describe("initialSpectrumData", () => {
  const band = { kMin: 0, kMax: Number.POSITIVE_INFINITY };

  it("should produce the same field for the same seed", () => {
    // A stochastic ocean is untestable, and an ocean that is different every reload cannot have a
    // regression. Determinism here is what makes every assertion downstream mean anything.
    const first = initialSpectrumData(16, 100, band, TUNING);
    const second = initialSpectrumData(16, 100, band, TUNING);
    expect([...first]).toStrictEqual([...second]);
  });

  it("should produce a different field for a different seed", () => {
    const first = initialSpectrumData(16, 100, band, TUNING);
    const second = initialSpectrumData(16, 100, band, { ...TUNING, seed: 99 });
    expect([...first]).not.toStrictEqual([...second]);
  });

  it("should pack four floats per texel", () => {
    expect(initialSpectrumData(8, 100, band, TUNING)).toHaveLength(8 * 8 * 4);
  });

  it("should be Hermitian, which is what makes the transformed height real", () => {
    // h0 at the mirrored texel must be the conjugate this texel carries in its second half. If it
    // is not, the inverse transform leaves an imaginary part nothing reads and the surface is
    // silently wrong in a way that still animates and still looks like water.
    const resolution = 16;
    const data = initialSpectrumData(resolution, 100, band, TUNING);
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const index = y * resolution + x;
        const mirror =
          ((resolution - y) % resolution) * resolution + ((resolution - x) % resolution);
        expect(data[index * 4 + 2]).toBeCloseTo(data[mirror * 4] as number, 6);
        expect(data[index * 4 + 3]).toBeCloseTo(-(data[mirror * 4 + 1] as number), 6);
      }
    }
  });

  it("should leave self-mirrored Nyquist rows empty", () => {
    const resolution = 8;
    const data = initialSpectrumData(resolution, 100, band, TUNING);
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        if (x !== 0 && y !== 0) continue;
        const index = y * resolution + x;
        expect([...data.slice(index * 4, index * 4 + 4)].every((value) => value === 0)).toBe(true);
      }
    }
  });

  it("should not change the sea's energy when the game raises the grid resolution", () => {
    // `resolution` is a quality knob: a finer grid resolves shorter waves, it does not build a
    // bigger sea. The energy the field carries has to converge as the grid gets finer, not scale
    // with it — otherwise every game that improves its ocean's detail silently flattens it, and
    // the fix looks like "the amplitude needs tuning".
    // Averaged over seeds. Most of the sea's energy sits in a handful of modes near the spectral
    // peak, and those modes draw different random samples at each resolution, so a single seed
    // swings tens of percent on noise alone and would prove nothing either way.
    const energy = (resolution: number, seed: number) => {
      const data = initialSpectrumData(resolution, 200, band, { ...TUNING, seed });
      let total = 0;
      for (let index = 0; index < data.length; index += 4) {
        total += (data[index] as number) ** 2 + (data[index + 1] as number) ** 2;
      }
      return total;
    };
    const mean = (resolution: number) => {
      let total = 0;
      for (let seed = 0; seed < 24; seed += 1) total += energy(resolution, 1_000 + seed * 101);
      return total / 24;
    };
    const coarse = mean(32);
    const fine = mean(128);
    // Sixteen times the modes, and the added ones are all short waves the spectrum barely feeds,
    // so the energy converges instead of scaling with the grid.
    expect(fine).toBeGreaterThan(coarse * 0.75);
    expect(fine).toBeLessThan(coarse * 1.4);
  });

  it("should scale with the patch it tiles, which is what gives amplitude a meaning", () => {
    const energy = (patchSize: number) => {
      const data = initialSpectrumData(64, patchSize, band, TUNING);
      let total = 0;
      for (let index = 0; index < data.length; index += 4) {
        total += (data[index] as number) ** 2 + (data[index + 1] as number) ** 2;
      }
      return total;
    };
    // A different patch is a different stretch of sea, not the same sea drawn differently.
    expect(energy(400)).not.toBeCloseTo(energy(100), 6);
  });

  it("should hold nothing outside the cascade's band", () => {
    const resolution = 16;
    const patchSize = 100;
    // A band above every wavenumber this grid can resolve leaves the whole cascade empty rather
    // than quietly folding the energy into the nearest bin.
    const empty = initialSpectrumData(
      resolution,
      patchSize,
      { kMin: 1e6, kMax: Number.POSITIVE_INFINITY },
      TUNING,
    );
    expect([...empty].every((value) => value === 0)).toBe(true);
    const filled = initialSpectrumData(
      resolution,
      patchSize,
      { kMin: 0, kMax: Number.POSITIVE_INFINITY },
      TUNING,
    );
    expect([...filled].some((value) => value !== 0)).toBe(true);
  });
});

describe("sampleGrid", () => {
  it("should return the stored value at a grid corner", () => {
    const grid = Float32Array.from([0, 1, 2, 3]);
    expect(sampleGrid(grid, 2, 4, 0, 0)).toBeCloseTo(0, 12);
    expect(sampleGrid(grid, 2, 4, 2, 0)).toBeCloseTo(1, 12);
    expect(sampleGrid(grid, 2, 4, 0, 2)).toBeCloseTo(2, 12);
  });

  it("should interpolate between corners", () => {
    const grid = Float32Array.from([0, 1, 2, 3]);
    expect(sampleGrid(grid, 2, 4, 1, 0)).toBeCloseTo(0.5, 12);
    expect(sampleGrid(grid, 2, 4, 0, 1)).toBeCloseTo(1, 12);
  });

  it("should wrap, because the patch tiles rather than ending", () => {
    const grid = Float32Array.from([0, 1, 2, 3]);
    expect(sampleGrid(grid, 2, 4, 4, 4)).toBeCloseTo(sampleGrid(grid, 2, 4, 0, 0), 12);
    expect(sampleGrid(grid, 2, 4, -4, 0)).toBeCloseTo(sampleGrid(grid, 2, 4, 0, 0), 12);
  });

  it("should interpolate across both wrapped edges", () => {
    const grid = Float32Array.from([0, 1, 2, 3]);
    expect(sampleGrid(grid, 2, 4, -0.5, -0.5)).toBeCloseTo(0.75, 12);
  });
});

describe("SpectralOcean options", () => {
  /**
   * Construction touches `three/tsl`, which builds real nodes, so these run against the module
   * under a node environment that has no GPU. Every case here fails before a node is built.
   */
  async function construct(overrides: Partial<ISpectralOceanOptions>) {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    return () => new SpectralOcean(options(overrides));
  }

  it("should refuse a resolution that is not a power of two", async () => {
    expect(await construct({ resolution: 100 }).then((build) => build)).toThrow(
      "must be a power of two",
    );
  });

  it("should refuse an empty cascade list", async () => {
    expect(await construct({ cascades: [] }).then((build) => build)).toThrow(
      "at least one cascade",
    );
  });

  it("should refuse cascades that are not ordered largest patch first", async () => {
    expect(
      await construct({ cascades: [{ patchSize: 40 }, { patchSize: 200 }] }).then((build) => build),
    ).toThrow("largest patchSize to smallest");
  });

  it("should refuse tuning numbers it has no defensible default for", async () => {
    expect(await construct({ windSpeed: 0 }).then((build) => build)).toThrow(
      "windSpeed must be a positive number",
    );
    expect(await construct({ amplitude: Number.NaN }).then((build) => build)).toThrow(
      "amplitude must be a positive number",
    );
    expect(await construct({ directionality: -1 }).then((build) => build)).toThrow(
      "directionality must be a positive number",
    );
    expect(
      await construct({ windDirection: Number.POSITIVE_INFINITY }).then((build) => build),
    ).toThrow("windDirection must be a finite number");
    expect(await construct({ choppiness: Number.NaN }).then((build) => build)).toThrow(
      "choppiness must be a finite number",
    );
  });

  it("should reject an invalid cadence", async () => {
    expect(
      await construct({ cadence: "invalid" as "fixed" | "render" }).then((build) => build),
    ).toThrow('must be "fixed" or "render"');
  });

  it("should refuse a readback cadence it cannot honour", async () => {
    expect(await construct({ readbackEveryFrames: 0 }).then((build) => build)).toThrow(
      "readbackEveryFrames must be a positive integer",
    );
    expect(await construct({ readbackResolution: -4 }).then((build) => build)).toThrow(
      "readbackResolution must be a non-negative integer",
    );
    expect(await construct({ readbackResolution: 6 }).then((build) => build)).toThrow(
      "must be a power of two",
    );
    expect(await construct({ readbackEveryFrames: 1.5 }).then((build) => build)).toThrow(
      "readbackEveryFrames must be a positive integer",
    );
  });
});

interface IOceanRendererControl {
  readonly renderer: IRendererLike;
  readonly dispatched: unknown[];
  /** How many `compute()` calls carried them: three submits one command buffer per call. */
  readonly computeCalls: () => number;
  readonly readbackCalls: number;
  land(bytes: Float32Array): void;
}

function oceanRenderer(): IOceanRendererControl {
  const dispatched: unknown[] = [];
  let computeCalls = 0;
  const pending: ((bytes: ArrayBuffer) => void)[] = [];
  const canvas = new EventTarget() as HTMLCanvasElement;
  const renderer = {
    compileAsync: async () => undefined,
    compute: (node: unknown) => {
      computeCalls += 1;
      dispatched.push(...(Array.isArray(node) ? node : [node]));
    },
    dispose: () => undefined,
    domElement: canvas,
    info: {},
    kind: "webgpu" as const,
    raw: {},
    readback: () => new Promise<ArrayBuffer>((resolve) => pending.push(resolve)),
    render: () => undefined,
    renderOverlay: () => undefined,
    setOutputNode: () => undefined,
    setSize: () => undefined,
    gpuFrameMs: () => undefined,
    resolveGpuFrame: () => undefined,
    setResolutionScale: () => undefined,
    surface: () => ({
      atFloor: false,
      devicePixelRatio: 1,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scale: 1,
      scaleSource: "auto" as const,
    }),
  } satisfies IRendererLike;
  return {
    renderer,
    dispatched,
    computeCalls: () => computeCalls,
    get readbackCalls() {
      return pending.length;
    },
    land(bytes) {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no readback in flight");
      resolve(bytes.buffer as ArrayBuffer);
    },
  };
}

describe("SpectralOcean lifetime", () => {
  it("should dispatch every pass of every cascade, then the height pass", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 4 }));
    const control = oceanRenderer();
    ocean.attachRenderer(control.renderer);
    ocean.advance(0.25);
    ocean.process();
    // Two cascades, each: evolve + row reverse + 3 row stages + column reverse + 3 column stages
    // + unpack = 10 passes. Then one height pass shared across both.
    expect(control.dispatched).toHaveLength(2 * 10 + 1);
    // ...in one `compute()`: three submits a command buffer per call, so a call per pass was 21
    // submits a frame, and a submit is where the GPU process makes the renderer wait.
    expect(control.computeCalls()).toBe(1);
    expect(ocean.steps).toBe(1);
    // Warmup covers every pass, so none of them compiles inside a frame the player is watching.
    expect(ocean.warmupNodes).toHaveLength(2 * 10 + 1);
    ocean.detach();
  });

  it("should advance on the game clock unless the game asks for the display's", async () => {
    // A sea whose height the game reads must not advance at whatever rate the display happens to
    // manage: `staleFrames` is reported in frames, and tying those frames to presentation makes
    // the same number mean a different amount of time on every machine. Caught by a playtest where
    // the fixed-step clock outran rendering ten to one and the sea effectively froze — while every
    // assertion about the field still passed, because the raft was moving across a frozen surface.
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const byGameClock = new SpectralOcean(options({ resolution: 8, readbackResolution: 4 }));
    expect(byGameClock.processCadence).toBe("fixed");
    const byDisplay = new SpectralOcean(
      options({ cadence: "render", resolution: 8, readbackResolution: 4 }),
    );
    expect(byDisplay.processCadence).toBe("render");
    byGameClock.detach();
    byDisplay.detach();
  });

  it("should refuse to run before it is attached", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 4 }));
    expect(() => ocean.process()).toThrow("not attached to a renderer");
    ocean.detach();
  });

  it("should answer undefined, never zero, before a height has landed", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 4 }));
    const control = oceanRenderer();
    ocean.attachRenderer(control.renderer);
    // A hull floating at zero is indistinguishable from a hull floating at sea level, so "no
    // height yet" must not read as "height is zero".
    expect(ocean.sampleHeight(0, 0)).toBeUndefined();
    ocean.process();
    expect(ocean.sampleHeight(0, 0)).toBeUndefined();
    ocean.detach();
  });

  it("should carry staleness on every height it hands back", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(
      options({ resolution: 8, readbackEveryFrames: 1, readbackResolution: 2 }),
    );
    const control = oceanRenderer();
    ocean.attachRenderer(control.renderer);
    ocean.process();
    control.land(Float32Array.from([0, -1, 2, -3, 4, -5, 6, -7]));
    await Promise.resolve();
    const fresh = ocean.sampleHeight(0, 0);
    expect(fresh?.height).toBeCloseTo(0, 12);
    expect(fresh?.staleFrames).toBe(0);
    expect(fresh?.verticalVelocity).toBe(-1);
    expect(ocean.sampleHeight(50, 50)?.height).toBeCloseTo(3, 12);
    expect(ocean.sampleHeight(50, 50)?.verticalVelocity).toBeCloseTo(-4, 12);
    expect(ocean.readbackFloats).toBe(8);
    ocean.process();
    ocean.process();
    const aged = ocean.sampleHeight(0, 0);
    expect(aged?.staleFrames).toBe(2);
    // Same bytes, older frame: the height did not change, the honesty about it did.
    expect(aged?.height).toBeCloseTo(fresh?.height as number, 12);
    ocean.detach();
  });

  it("should have no height query at all when the game did not ask for one", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 0 }));
    const control = oceanRenderer();
    ocean.attachRenderer(control.renderer);
    ocean.process();
    expect(ocean.sampleHeight(0, 0)).toBeUndefined();
    expect(ocean.staleFrames).toBeUndefined();
    expect(ocean.readbackFloats).toBe(0);
    // No height pass and no copy: a game that never floats anything pays nothing for the option.
    expect(control.readbackCalls).toBe(0);
    expect(control.dispatched).toHaveLength(2 * 10);
    ocean.detach();
  });

  it("should release every buffer once and stay released", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 4 }));
    const control = oceanRenderer();
    ocean.attachRenderer(control.renderer);
    ocean.detach();
    expect(ocean.released).toBe(true);
    ocean.detach();
    expect(() => ocean.attachRenderer(control.renderer)).toThrow(
      "cannot be attached after release",
    );
    // A released ocean stops dispatching rather than throwing, so a stale registry entry cannot
    // take a frame down with it.
    ocean.process();
    expect(control.dispatched).toHaveLength(0);
  });

  it("should reject non-finite time and unknown cascade accessors", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 4 }));
    expect(() => ocean.advance(Number.NaN)).toThrow("needs a finite time");
    expect(() => ocean.cascadePatchSize(-1)).toThrow("has no cascade -1");
    expect(() => ocean.cascadeDisplacement(2)).toThrow("has no cascade 2");
    ocean.detach();
  });

  it("should release when its parent removes it", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 0 }));
    const parent = new Group();
    parent.add(ocean);
    parent.remove(ocean);
    expect(ocean.released).toBe(true);
  });

  it("should name the cascade a game asks for and refuse one it does not have", async () => {
    const { SpectralOcean } = await import("../src/ocean/spectral.js");
    const ocean = new SpectralOcean(options({ resolution: 8, readbackResolution: 4 }));
    expect(ocean.cascadePatchSize(0)).toBe(200);
    expect(ocean.cascadePatchSize(1)).toBe(40);
    expect(ocean.cascadeDisplacement(0)).toBeDefined();
    expect(() => ocean.cascadeDisplacement(2)).toThrow("has no cascade 2");
    ocean.detach();
  });
});
