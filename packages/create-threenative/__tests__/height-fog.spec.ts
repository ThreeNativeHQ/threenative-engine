import { readFile } from "node:fs/promises";
import path from "node:path";
import { type FogExp2, Scene, Texture } from "three";
import { describe, expect, it } from "vitest";
import {
  HEIGHT_FOG,
  type HeightFogParams,
  heightFogDepth,
} from "../templates/starter/src/render/heightFog.js";
import { setupSky } from "../templates/starter/src/render/sky.js";

const params: HeightFogParams = { ...HEIGHT_FOG };

const transmittance = (p: HeightFogParams, cameraY: number, fragmentY: number, length: number) =>
  Math.max(2 ** -heightFogDepth(p, cameraY, fragmentY, length), 1 - p.maxOpacity);

/** Midpoint march of the same density along the ray, base-2 optical depth. */
function march(p: HeightFogParams, cameraY: number, fragmentY: number, length: number): number {
  const steps = 4096;
  let depth = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * length;
    const y = cameraY + ((fragmentY - cameraY) * t) / length;
    const exponent = Math.min(127, Math.max(-127, -p.heightFalloff * (y - p.fogHeight)));
    if (t >= p.startDistance) depth += p.density * 2 ** exponent * (length / steps);
  }
  return depth;
}

describe("height fog", () => {
  it("should match a 4096-step march for cameras below, inside and above the layer", () => {
    const cases: [number, number, number][] = [];
    for (const cameraY of [-30, 0, 2, 40, 300]) {
      for (const degrees of [-89, -45, -10, 0, 10, 45, 89]) {
        for (const length of [5, 150, 1000]) {
          cases.push([cameraY, cameraY + length * Math.sin((degrees * Math.PI) / 180), length]);
        }
      }
    }
    for (const [cameraY, fragmentY, length] of cases) {
      const closed = heightFogDepth(params, cameraY, fragmentY, length);
      const numeric = march(params, cameraY, fragmentY, length);
      expect(Math.abs(closed - numeric)).toBeLessThanOrEqual(
        0.01 * Math.max(numeric, 1e-9) + 1e-12,
      );
    }
  });

  it("should stay finite at the exponent clamp", () => {
    const steep = { ...params, heightFalloff: 5 };
    const depth = heightFogDepth(steep, -1000, 1000, 2000);
    expect(Number.isFinite(depth)).toBe(true);
    expect(transmittance(steep, -1000, 1000, 2000)).toBe(0);
  });

  it("should fog low ground more than a ridge at the same distance", () => {
    const low = transmittance(params, 2, 2, 400);
    const ridge = transmittance(params, 2, 150, 400);
    expect(low).toBeLessThan(ridge);
  });

  it("should keep the old eye-level haze within 2%", () => {
    const scene = new Scene();
    setupSky(scene, new Texture());
    const dist = (scene.fog as FogExp2).density;
    expect(scene.fogNode).toBeTruthy();
    const total = Math.exp(-((dist * 150) ** 2)) * transmittance(params, 2, 2, 150);
    expect(Math.abs(total - Math.exp(-((0.003 * 150) ** 2)))).toBeLessThan(
      0.02 * Math.exp(-((0.003 * 150) ** 2)),
    );
  });

  it("should never be more transparent than the distance term, and stay opaque where it is", () => {
    // PRD-461 recipe: linear near 128 m, far 256 m. The product is 0 at far from far above the layer.
    const smooth = (near: number, far: number, z: number) => {
      const x = Math.min(1, Math.max(0, (z - near) / (far - near)));
      return x * x * (3 - 2 * x);
    };
    for (const cameraY of [0, 500]) {
      const distanceT = 1 - smooth(128, 256, 256);
      const combined = distanceT * transmittance(params, cameraY, cameraY, 256);
      expect(combined).toBe(0);
    }
    for (const z of [10, 130, 200]) {
      const distanceT = 1 - smooth(128, 256, z);
      expect(distanceT * transmittance(params, 2, 2, z)).toBeLessThanOrEqual(distanceT);
    }
  });
});

// Every FogExp2 kit keeps the eye-level haze its fog had before the height term: at the
// `EYE_LEVEL` distance and camera height, the distance term and the height term together transmit
// what the old FogExp2 did, within 2%.
const FOG_KITS = [
  "action-rpg",
  "minimal",
  "platformer",
  "puzzle",
  "racing",
  "rts",
  "runner",
  "sailing",
  "shooter",
  "snow",
  "starter",
] as const;

/** The kits whose old fog was 0.003 at 150 m from 2 m up: height fog carries most of that haze. */
const CONTRAST_KITS = [
  "action-rpg",
  "minimal",
  "platformer",
  "runner",
  "sailing",
  "shooter",
  "starter",
] as const;

async function loadKit(kit: string) {
  const root = path.join(import.meta.dirname, "..", "templates", kit, "src", "render");
  const sky = await readFile(path.join(root, "sky.ts"), "utf8");
  const eye = /EYE_LEVEL = \{ density: ([\w.]+), distance: (\d+), cameraHeight: (\d+) \}/u.exec(
    sky,
  );
  expect(eye, `${kit} must name its eye-level fog`).not.toBeNull();
  const named = new RegExp(`${eye?.[1]} = (\\d+(?:\\.\\d+)?);`, "u").exec(sky);
  const { HEIGHT_FOG: kitParams, heightFogDepth: depth } = (await import(
    /* @vite-ignore */ path.join(root, "heightFog.ts")
  )) as typeof import("../templates/starter/src/render/heightFog.js");
  const mod = (await import(/* @vite-ignore */ path.join(root, "sky.ts"))) as {
    loadSky?: (assets: { texture(path: string): Promise<Texture> }) => Promise<void>;
    setupSky: (scene: Scene, arg?: unknown) => unknown;
  };
  await mod.loadSky?.({ texture: async () => new Texture() });
  const scene = new Scene();
  mod.setupSky(scene, new Texture());
  const distanceFog = scene.fog as FogExp2 | null;
  expect(distanceFog, `${kit} keeps FogExp2 as the distance term`).toBeTruthy();
  expect(scene.fogNode).toBeTruthy();
  return {
    cameraHeight: Number(eye?.[3]),
    depth,
    distance: Number(eye?.[2]),
    distanceDensity: distanceFog?.density ?? 0,
    old: Number(named?.[1] ?? eye?.[1]),
    params: { ...kitParams } as HeightFogParams,
  };
}

describe.each(FOG_KITS)("%s height fog", (kit) => {
  it("should keep its old eye-level haze within 2%", async () => {
    const k = await loadKit(kit);
    const total =
      Math.exp(-((k.distanceDensity * k.distance) ** 2)) *
      2 ** -k.depth(k.params, k.cameraHeight, k.cameraHeight, k.distance);
    const before = Math.exp(-((k.old * k.distance) ** 2));
    expect(Math.abs(total - before)).toBeLessThan(0.02 * before);
  });
});

describe.each(CONTRAST_KITS)("%s ridge contrast", (kit) => {
  it("should fog low ground at least 10 points more than a ridge 330 m away", async () => {
    const k = await loadKit(kit);
    const fog = (fragmentY: number) => {
      const length = Math.hypot(330, fragmentY - 3);
      const distanceFog = (k.distanceDensity * length) ** 2;
      return 1 - Math.exp(-distanceFog) * 2 ** -k.depth(k.params, 3, fragmentY, length);
    };
    // A 30 m block on the ground (centre 15 m) against the same block 70 m higher (centre 85 m).
    expect(fog(15) - fog(85)).toBeGreaterThanOrEqual(0.1);
  });
});
