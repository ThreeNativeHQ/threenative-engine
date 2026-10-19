import { Group, Vector3 } from "three";
import { float, vec2, vec3, vec4 } from "three/tsl";
import { describe, expect, it } from "vitest";
import {
  Atmosphere,
  type IAtmosphereParameters,
  directionFromSolarPosition,
  directionalTransmittance,
  resolveAtmosphereParameters,
  solarPosition,
  updateAtmosphereParameters,
  zenithTransmittance,
} from "../src/atmosphere/index.js";
import { resolveAtmosphereLutResolutions } from "../src/atmosphere/luts.js";
import type { IRendererLike } from "../src/renderer.js";

const earth: IAtmosphereParameters = {
  rayleigh: [0.005802, 0.013558, 0.0331],
  mie: [0.00444, 0.00444, 0.00444],
  ozone: [0.00065, 0.001881, 0.000085],
  planetRadius: 6360,
  atmosphereRadius: 6460,
};

function renderer(dispatched: unknown[]): IRendererLike {
  const canvas = new EventTarget() as HTMLCanvasElement;
  return {
    compileAsync: async () => undefined,
    compute: (node) => dispatched.push(node),
    dispose: () => undefined,
    domElement: canvas,
    info: {},
    kind: "webgpu",
    raw: {},
    render: () => undefined,
    readback: async () => new ArrayBuffer(0),
    renderOverlay: () => undefined,
    setOutputNode: () => undefined,
    setSize: () => undefined,
    gpuFrameMs: () => undefined,
    resolveGpuFrame: () => undefined,
    setResolutionScale: () => undefined,
    surface: () => ({
      atFloor: false,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scaleSource: "pinned" as const,
    }),
  };
}

describe("Atmosphere", () => {
  it("matches the Earth zenith transmittance fixture", () => {
    expect(zenithTransmittance(earth)).toEqual([
      0.9403587505338243, 0.8676155338551922, 0.7623099761372392,
    ]);
  });

  it("requires every physical coefficient and radius", () => {
    for (const field of ["rayleigh", "mie", "ozone", "planetRadius", "atmosphereRadius"]) {
      const incomplete = { ...earth } as Record<string, unknown>;
      delete incomplete[field];
      expect(() => new Atmosphere(incomplete as never)).toThrow(`Atmosphere.${field}`);
    }
  });

  it("bakes three LUT nodes once, then only rebakes after a parameter change", () => {
    const dispatched: unknown[] = [];
    const atmosphere = new Atmosphere(earth);
    const parent = new Group();
    parent.add(atmosphere);

    expect(atmosphere.warmupNodes).toHaveLength(3);
    expect(atmosphere.luts.transmittance.image).toMatchObject({ width: 256, height: 64 });
    atmosphere.attachRenderer(renderer(dispatched));
    expect(dispatched).toHaveLength(3);

    atmosphere.process();
    expect(dispatched).toHaveLength(3);
    atmosphere.setAtmosphere({ rayleigh: [0.008, 0.016, 0.04] });
    atmosphere.process();
    expect(dispatched).toHaveLength(6);

    parent.remove(atmosphere);
    expect(atmosphere.released).toBe(true);
    expect(() => atmosphere.process()).not.toThrow();
  });

  it("changes its LUT identity when the supplied planet changes", () => {
    const thicker = new Atmosphere({
      ...earth,
      rayleigh: [0.012, 0.027, 0.066],
      ozone: [0, 0, 0],
    });

    expect(thicker.luts.hash).not.toBe(new Atmosphere(earth).luts.hash);
  });

  it("changes the numeric horizon radiance when scattering changes", () => {
    const atmosphere = new Atmosphere(earth);
    const thicker = new Atmosphere({
      ...earth,
      rayleigh: [0.012, 0.027, 0.066],
    });
    const direction = new Vector3(0, 0, 1);

    expect((thicker.radiance(direction) as Vector3).toArray()).not.toEqual(
      (atmosphere.radiance(direction) as Vector3).toArray(),
    );
  });

  it("samples atmosphere LUTs through their linear filter at an explicit mip level", () => {
    const atmosphere = new Atmosphere(earth);
    for (const sample of [
      atmosphere.luts.sampleSkyView(vec2(0.5, 0.5)),
      atmosphere.luts.sampleTransmittance(vec2(0.5, 0.5)),
    ]) {
      expect(sample.sampler).toBe(true);
      expect(sample.levelNode).not.toBeNull();
    }
  });

  it("exposes TSL nodes for radiance, sun transmittance, and depth haze", () => {
    const atmosphere = new Atmosphere(earth);
    const direction = vec3(0, 1, 0);
    const colour = atmosphere.radiance(direction);
    const transmittance = atmosphere.sunTransmittance(direction);
    const scenePass = {
      getTextureNode: () => vec4(0.2, 0.3, 0.4, 1),
    };

    expect((colour as { isNode?: boolean }).isNode).toBe(true);
    expect((transmittance as { isNode?: boolean }).isNode).toBe(true);
    expect(
      (atmosphere.aerialPerspective(scenePass, float(10)) as { isNode?: boolean }).isNode,
    ).toBe(true);
  });

  it("returns physical sun transmittance for numeric directions", () => {
    const atmosphere = new Atmosphere(earth);
    const transmittance = atmosphere.sunTransmittance(new Vector3(0, 1, 0));

    expect(transmittance).toBeInstanceOf(Vector3);
    expect(transmittance.x).toBeCloseTo(0.9403586, 6);
    expect(transmittance.z).toBeCloseTo(0.76231, 6);
  });

  it("rejects a zero direction before normalizing it", () => {
    expect(() => directionalTransmittance(earth, new Vector3())).toThrow(
      "Atmosphere direction must be finite and non-zero",
    );
  });

  it("rejects malformed numeric sun and depth inputs", () => {
    const atmosphere = new Atmosphere(earth);
    expect(() =>
      (atmosphere as unknown as { setSunDirection: (elevation: number) => void }).setSunDirection(
        45,
      ),
    ).toThrow("Atmosphere sun direction requires elevation and azimuth");
    expect(() =>
      atmosphere.aerialPerspective({ getTextureNode: () => vec4(0, 0, 0, 1) }, Number.NaN),
    ).toThrow("Atmosphere depth must be finite");
  });
});

describe("solarPosition", () => {
  it("computes a known solstice elevation from date, latitude, and longitude", () => {
    const position = solarPosition({
      date: new Date("2024-06-21T12:00:00.000Z"),
      latitude: 45,
      longitude: 0,
    });

    expect(position.elevation).toBeCloseTo(68.44, 1);
    expect(position.azimuth).toBeCloseTo(179, 0);
  });

  it("accepts the positional overload", () => {
    const position = solarPosition(new Date("2024-06-21T12:00:00.000Z"), 45, 0);
    expect(position.elevation).toBeCloseTo(68.44, 1);
  });

  it("treats a negative UTC offset as west of UTC", () => {
    const position = solarPosition({
      dayOfYear: 172,
      timeOfDay: 6,
      latitude: 49.28,
      longitude: -123.12,
      utcOffset: -8,
    });

    expect(position.elevation).toBeCloseTo(15.4, 1);
  });

  it("writes changing numeric inputs into a retained result target", () => {
    const input = {
      dayOfYear: 172,
      timeOfDay: 6,
      latitude: 49.28,
      longitude: -123.12,
      utcOffset: -8,
    };
    const target = { azimuth: 0, elevation: 0 };

    expect(solarPosition(input, target)).toBe(target);
    const first = { ...target };
    input.timeOfDay += 1;
    expect(solarPosition(input, target)).toBe(target);
    expect(target).not.toEqual(first);
  });

  it("derives normalized directions from solar elevation and azimuth", () => {
    const overhead = directionFromSolarPosition(90, 0);
    expect(overhead.x).toBeCloseTo(0);
    expect(overhead.y).toBeCloseTo(1);
    expect(overhead.z).toBeCloseTo(0);

    const east = directionFromSolarPosition(0, 90);
    expect(east.x).toBeCloseTo(1);
    expect(east.y).toBeCloseTo(0);
    expect(east.z).toBeCloseTo(0);

    const north = directionFromSolarPosition(0, 0);
    expect(north.z).toBeCloseTo(1);
    expect(north.length()).toBeCloseTo(1);
  });

  it("rejects non-finite elevation or azimuth", () => {
    for (const [elevation, azimuth] of [
      [Number.NaN, 0],
      [0, Number.POSITIVE_INFINITY],
    ]) {
      expect(() => directionFromSolarPosition(elevation as number, azimuth as number)).toThrow(
        "solarPosition elevation and azimuth must be finite",
      );
    }
  });

  it("parses a date string and rejects an invalid date", () => {
    const fromString = solarPosition({
      date: "2024-06-21T12:00:00.000Z",
      latitude: 45,
      longitude: 0,
    });
    expect(fromString.elevation).toBeCloseTo(68.44, 1);

    expect(() => solarPosition({ date: "not-a-date", latitude: 45, longitude: 0 })).toThrow(
      "solarPosition.date must be valid",
    );
  });

  it("requires all three positional arguments", () => {
    expect(() => solarPosition(new Date("2024-06-21T12:00:00Z"), 45, undefined as never)).toThrow(
      "solarPosition positional form requires date, latitude, and longitude",
    );
  });

  it("rejects out-of-range or non-finite location inputs", () => {
    const base = { latitude: 0, longitude: 0 };
    expect(() => solarPosition({ ...base, latitude: 91 })).toThrow("solarPosition.latitude");
    expect(() => solarPosition({ ...base, latitude: Number.NaN })).toThrow(
      "solarPosition.latitude",
    );
    expect(() => solarPosition({ ...base, longitude: -181 })).toThrow("solarPosition.longitude");
    expect(() => solarPosition({ ...base, utcOffset: 25 })).toThrow("solarPosition.utcOffset");
    expect(() => solarPosition({ ...base, utcOffset: Number.NaN })).toThrow(
      "solarPosition.utcOffset",
    );
  });

  it("rejects missing or non-finite day and time inputs", () => {
    expect(() => solarPosition({ timeOfDay: 12, latitude: 0, longitude: 0 })).toThrow(
      "solarPosition requires date or dayOfYear and timeOfDay",
    );
    expect(() =>
      solarPosition({ dayOfYear: Number.NaN, timeOfDay: 12, latitude: 0, longitude: 0 }),
    ).toThrow("solarPosition dayOfYear and timeOfDay must be finite");
  });
});

describe("atmosphere coefficients", () => {
  it("rejects a zero or non-finite direction for transmittance", () => {
    expect(() => directionalTransmittance(earth, new Vector3())).toThrow(
      "Atmosphere direction must be finite and non-zero",
    );
    expect(() => directionalTransmittance(earth, new Vector3(Number.NaN, 1, 0))).toThrow(
      "Atmosphere direction must be finite and non-zero",
    );
  });

  it("keeps directional transmittance inside the physical unit interval", () => {
    for (const direction of [new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(1, 0.2, 0)]) {
      const transmittance = directionalTransmittance(earth, direction);
      for (const component of transmittance.toArray()) {
        expect(component).toBeGreaterThan(0);
        expect(component).toBeLessThanOrEqual(1);
      }
    }
  });

  it("applies a partial parameter patch without disturbing the rest", () => {
    const resolved = resolveAtmosphereParameters(earth);
    const patched = updateAtmosphereParameters(resolved, { rayleigh: [0.008, 0.016, 0.04] });

    expect(patched.rayleigh.toArray()).toEqual([0.008, 0.016, 0.04]);
    expect(patched.mie.toArray()).toEqual(resolved.mie.toArray());
    expect(patched.ozone.toArray()).toEqual(resolved.ozone.toArray());
    expect(patched.planetRadius).toBe(earth.planetRadius);
    expect(patched.atmosphereRadius).toBe(earth.atmosphereRadius);
  });

  it("rejects a patch that breaks physical validation", () => {
    const resolved = resolveAtmosphereParameters(earth);
    expect(() => updateAtmosphereParameters(resolved, { rayleigh: [-1, 0, 0] })).toThrow(
      "Atmosphere.rayleigh",
    );
    expect(() =>
      updateAtmosphereParameters(resolved, { atmosphereRadius: earth.planetRadius }),
    ).toThrow("Atmosphere.atmosphereRadius must be greater than planetRadius");
  });
});

describe("Atmosphere instance surface", () => {
  it("returns a defensive clone of its resolved parameters", () => {
    const atmosphere = new Atmosphere(earth);
    const expected = resolveAtmosphereParameters(earth).rayleigh.toArray();
    const parameters = atmosphere.parameters;
    expect(parameters.rayleigh.toArray()).toEqual(expected);

    parameters.rayleigh.set(9, 9, 9);
    expect(atmosphere.parameters.rayleigh.toArray()).toEqual(expected);
    expect(atmosphere.released).toBe(false);
    expect(atmosphere.hash).toBe(atmosphere.luts.hash);
  });

  it("evaluates the numeric radiance branch from the supplied coefficients", () => {
    const atmosphere = new Atmosphere(earth);
    const resolved = resolveAtmosphereParameters(earth);
    const radiance = atmosphere.radiance(new Vector3(0, 1, 0)) as Vector3;

    expect(radiance).toBeInstanceOf(Vector3);
    expect(radiance.x).toBeCloseTo(resolved.rayleigh.x * 0.75 + resolved.mie.x);
    expect(radiance.y).toBeCloseTo(resolved.rayleigh.y * 0.75 + resolved.mie.y);
    expect(radiance.z).toBeCloseTo(resolved.rayleigh.z * 0.75 + resolved.mie.z);
    expect(() => atmosphere.radiance([0, 0, 0] as const)).toThrow(
      "Atmosphere direction must not be zero",
    );
  });

  it("accepts every setSunDirection overload and reports it back", () => {
    const atmosphere = new Atmosphere(earth);

    atmosphere.setSunDirection(90, 0);
    expect(atmosphere.getSunDirection().y).toBeCloseTo(1);

    atmosphere.setSunDirection(new Vector3(1, 0, 0));
    expect(atmosphere.getSunDirection().x).toBeCloseTo(1);

    atmosphere.setSunDirection({ elevation: 0, azimuth: 90 });
    expect(atmosphere.getSunDirection().x).toBeCloseTo(1);

    const target = new Vector3();
    expect(atmosphere.getSunDirection(target)).toBe(target);
  });

  it("validates malformed numeric directions on the sampling paths", () => {
    const atmosphere = new Atmosphere(earth);
    expect(() => atmosphere.sunTransmittance(new Vector3(0, 0, 0))).toThrow(
      "Atmosphere direction must not be zero",
    );
    expect(() => atmosphere.radiance([Number.NaN, 1, 0] as const)).toThrow(
      "Atmosphere direction must contain finite numbers",
    );
  });

  it("treats a Vector3 direction like the array form: finite, non-zero, normalized", () => {
    const atmosphere = new Atmosphere(earth);
    expect(() => atmosphere.setSunDirection(new Vector3(0, 0, 0))).toThrow(
      "Atmosphere direction must not be zero",
    );
    expect(() => atmosphere.radiance(new Vector3(Number.NaN, 1, 0))).toThrow(
      "Atmosphere direction must contain finite numbers",
    );

    atmosphere.setSunDirection(new Vector3(0, 2, 0));
    expect(atmosphere.getSunDirection().length()).toBeCloseTo(1);
    expect((atmosphere.radiance(new Vector3(0, 2, 0)) as Vector3).toArray()).toEqual(
      (atmosphere.radiance([0, 1, 0] as const) as Vector3).toArray(),
    );
  });

  it("dispatches once per renderer and rebakes after a coefficient change", () => {
    const dispatched: unknown[] = [];
    const target = renderer(dispatched);
    const atmosphere = new Atmosphere(earth);
    atmosphere.attachRenderer(target);
    expect(dispatched).toHaveLength(3);

    atmosphere.attachRenderer(target);
    expect(dispatched).toHaveLength(3);

    atmosphere.setCoefficients({ mie: [0, 0, 0] });
    atmosphere.process();
    expect(dispatched).toHaveLength(6);

    atmosphere.detach();
    atmosphere.detach();
    atmosphere.process();
    expect(atmosphere.released).toBe(true);
    expect(() => new Atmosphere(earth).process()).toThrow(
      "Atmosphere is not attached to a renderer",
    );
  });

  it("refuses to change or attach after release", () => {
    const atmosphere = new Atmosphere(earth);
    atmosphere.detach();
    expect(atmosphere.released).toBe(true);
    expect(() => atmosphere.setAtmosphere({ rayleigh: [0, 0, 0] })).toThrow(
      "Atmosphere cannot change after release",
    );
    expect(() => atmosphere.attachRenderer(renderer([]))).toThrow(
      "Atmosphere cannot be attached after release",
    );
  });
});

describe("resolveAtmosphereLutResolutions", () => {
  it("throws on zero, NaN and fractional LUT resolutions", () => {
    expect(() => resolveAtmosphereLutResolutions({ skyView: { width: 0, height: 72 } })).toThrow(
      /resolution must contain positive integers/,
    );
    expect(() =>
      resolveAtmosphereLutResolutions({ skyView: { width: Number.NaN, height: 72 } }),
    ).toThrow(/resolution must contain positive integers/);
    expect(() =>
      resolveAtmosphereLutResolutions({ skyView: { width: 128.5, height: 72 } }),
    ).toThrow(/resolution must contain positive integers/);
    expect(() =>
      resolveAtmosphereLutResolutions({ transmittance: { width: 256, height: -4 } }),
    ).toThrow(/resolution must contain positive integers/);
    expect(() =>
      resolveAtmosphereLutResolutions({ multiScattering: { width: Number.NaN, height: 32 } }),
    ).toThrow(/resolution must contain positive integers/);
  });

  it("keeps the shipped defaults and accepts positive integer sizes", () => {
    const defaults = resolveAtmosphereLutResolutions(undefined);
    expect(defaults.skyView).toEqual({ width: 192, height: 108 });
    expect(
      resolveAtmosphereLutResolutions({ skyView: { width: 128, height: 72 } }).skyView,
    ).toEqual({ width: 128, height: 72 });
  });
});
