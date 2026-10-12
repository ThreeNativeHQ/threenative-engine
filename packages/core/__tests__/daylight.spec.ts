import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Color,
  FogExp2,
  Object3D,
  Scene,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { Daylight, type IDaylightOptions } from "../src/render/daylight.js";
import type { VirtualShadowNode } from "../src/render/virtual-shadow.js";

function options(follow: Object3D, overrides: Partial<IDaylightOptions> = {}): IDaylightOptions {
  return {
    exposure: 2 ** -0.6,
    fill: { ground: new Color(0x5b5540), intensity: 1.1, sky: new Color(0xa9c1dc) },
    follow,
    haze: { color: new Color(0xb4c3d1), density: 0.0011 },
    shadowExtents: [24, 96, 320],
    sky: { mieCoefficient: 0.004, mieDirectionalG: 0.8, rayleigh: 1.4, turbidity: 3.2 },
    skySize: 1600,
    sunColor: new Color(1, 0.93, 0.82),
    sunDirection: new Vector3(-0.507, 0.616, 0.604),
    sunIntensity: 4,
    ...overrides,
  };
}

describe("Daylight", () => {
  it("keeps the sky, the sun and its target on the eye as the eye moves", () => {
    const eye = new Object3D();
    const daylight = new Daylight(options(eye));
    eye.position.set(800, 40, -600);
    eye.updateMatrixWorld();
    daylight.process();
    expect(daylight.sky.position.toArray()).toEqual([800, 40, -600]);
    expect(daylight.sun.target.position.toArray()).toEqual([800, 40, -600]);
    const toSun = daylight.sun.position.clone().sub(daylight.sun.target.position).normalize();
    expect(toSun.distanceTo(new Vector3(-0.507, 0.616, 0.604).normalize())).toBeLessThan(1e-6);
    expect(daylight.sun.castShadow).toBe(true);
    expect(daylight.sun.shadow.shadowNode).toBeDefined();
  });

  it("sets the tone curve, exposure, shadow map and haze from the game's values on attach", () => {
    const scene = new Scene();
    const daylight = new Daylight(options(new Object3D()));
    scene.add(daylight);
    const raw = { shadowMap: { enabled: false }, toneMapping: 0, toneMappingExposure: 1 };
    daylight.attachRenderer({ raw } as never);
    expect(raw.toneMapping).toBe(AgXToneMapping);
    expect(raw.toneMappingExposure).toBeCloseTo(2 ** -0.6);
    expect(raw.shadowMap.enabled).toBe(true);
    expect(scene.fog).toBeInstanceOf(FogExp2);
    expect((scene.fog as FogExp2).density).toBe(0.0011);
    daylight.detach();
    expect(scene.fog).toBeNull();
    expect(daylight.released).toBe(true);
  });

  it("uses the game's tone curve when it names one", () => {
    const daylight = new Daylight({
      ...options(new Object3D()),
      toneMapping: ACESFilmicToneMapping,
    });
    const raw = { shadowMap: { enabled: false }, toneMapping: 0, toneMappingExposure: 1 };
    daylight.attachRenderer({ raw } as never);
    expect(raw.toneMapping).toBe(ACESFilmicToneMapping);
  });

  it("keeps its own sky out of its own haze", () => {
    // The dome sits half a sky size from the eye; at any useful haze density that distance is fully
    // fogged, and a fogged dome is a flat haze-coloured sky instead of the physical one.
    const daylight = new Daylight(options(new Object3D()));
    expect((daylight.sky.material as { fog: boolean }).fog).toBe(false);
  });

  it("gives every shadow level the game's map size, and the light's own when it names none", () => {
    const sized = new Daylight(
      options(new Object3D(), { shadowExtents: [250], shadowMapSize: 4096 }),
    );
    expect((sized.sun.shadow.shadowNode as VirtualShadowNode).options.mapSize).toBe(4096);
    const stock = new Daylight(options(new Object3D()));
    expect((stock.sun.shadow.shadowNode as VirtualShadowNode).options.mapSize).toBe(
      stock.sun.shadow.mapSize.width,
    );
  });

  it("names the sky box as the sky in the frame budget's per-source split", () => {
    // One draw, on the main camera's own layer, and no world system would otherwise claim it — which
    // is why a rig like this one was a line item in the `other` bucket PRD-494 reads.
    const daylight = new Daylight(options(new Object3D()));

    expect(daylight.sky.layers.mask).toBe(1);
    expect(daylight.sky.userData.tnDrawSource).toBe("sky");
    daylight.detach();
  });

  it("refuses a missing exposure or sky size instead of inventing one", () => {
    expect(() => new Daylight(options(new Object3D(), { exposure: 0 }))).toThrow(/exposure/u);
    expect(() => new Daylight(options(new Object3D(), { skySize: 0 }))).toThrow(/skySize/u);
  });
});
