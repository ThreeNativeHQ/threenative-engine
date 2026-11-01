// PRD-633: the starter's sky is Unreal's default level sky, and it lights the scene.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type DataTexture, type FogExp2, Scene, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bakeSkyRadiance } from "../templates/starter/src/render/atmosphere.js";
import { cloudTextures } from "../templates/starter/src/render/clouds.js";
import { setupLighting } from "../templates/starter/src/render/lighting.js";
import { SKY_OPTIONS, SUN_DIRECTION, setupSky } from "../templates/starter/src/render/sky.js";

// The spy wraps the real bake: it counts the ray marches and changes none of them.
vi.mock("../templates/starter/src/render/atmosphere.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../templates/starter/src/render/atmosphere.js")>();
  return { ...actual, bakeSkyRadiance: vi.fn(actual.bakeSkyRadiance) };
});

const renderer = { shadowMap: { enabled: false, type: 0 } };
const defaultSun = SUN_DIRECTION.clone();

/** Mean sRGB bytes of one environment row; row 0 of the data texture is the nadir. */
function row(texture: DataTexture, y: number): number[] {
  const { data, width } = texture.image as { data: Uint8Array; width: number };
  const sum = [0, 0, 0];
  for (let x = 0; x < width; x++)
    for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (data[(y * width + x) * 4 + c] ?? 0);
  return sum.map((v) => v / width);
}

describe("starter atmosphere sky", () => {
  afterEach(() => {
    SKY_OPTIONS.sky = "atmosphere";
    SKY_OPTIONS.ground = true;
    SUN_DIRECTION.copy(defaultSun);
  });

  it("lights the scene with a blue sky computed from the atmosphere, not the photograph", () => {
    const scene = new Scene();
    setupSky(scene, undefined, false, true, false);
    const environment = scene.environment as DataTexture;
    expect(environment.image.width).toBe(64);
    const height = environment.image.height;
    const zenith = row(environment, height - 1);
    const horizon = row(environment, height / 2);
    // Rayleigh sky: blue overhead, paler toward the horizon.
    expect(zenith[2]).toBeGreaterThan((zenith[0] ?? 0) * 1.3);
    expect((horizon[0] ?? 0) / (horizon[2] ?? 1)).toBeGreaterThan(
      (zenith[0] ?? 0) / (zenith[2] ?? 1),
    );
    // Below the horizon, the sunlit ground: a warm grey that lifts shadow sides and that a mirror
    // reflects, not black.
    const nadir = row(environment, 0);
    expect(Math.min(...nadir)).toBeGreaterThan(40);
    expect(nadir[0]).toBeGreaterThanOrEqual(nadir[2] ?? 0);
    // The fog has no colour of its own: it takes the sky's, a blue-grey, not the photo palette grey.
    const fog = (scene.fog as FogExp2).color;
    expect(fog.b).toBeGreaterThan(fog.r);
    expect(scene.backgroundNode).not.toBeNull();
  });

  it("draws Unreal's dark nadir when the game turns the ground stand-in off", () => {
    SKY_OPTIONS.ground = false;
    const scene = new Scene();
    setupSky(scene, undefined, false, true, false);
    expect(Math.max(...row(scene.environment as DataTexture, 0))).toBeLessThan(8);
  });

  it("tints the sun by the air it crosses: pale yellow high, orange at 4 degrees", () => {
    const high = setupLighting(new Scene(), renderer).key.color.clone();
    SUN_DIRECTION.set(Math.cos((4 * Math.PI) / 180), Math.sin((4 * Math.PI) / 180), 0);
    const low = setupLighting(new Scene(), renderer).key.color.clone();
    expect(high.b / high.r).toBeGreaterThan(0.6);
    expect(low.b / low.r).toBeLessThan(0.3);
    expect(low.g / low.r).toBeLessThan(high.g / high.r);
  });

  it("keeps the photograph as the named override", () => {
    SKY_OPTIONS.sky = "photo";
    const scene = new Scene();
    const photo = new Texture();
    setupSky(scene, photo);
    expect(scene.background).toBe(photo);
    expect(scene.environment).toBe(photo);
    expect(setupLighting(new Scene(), renderer).key.color.getHex()).toBe(0xfff1e0);
    expect(() => setupSky(new Scene())).toThrow(/sky\.jpg/u);
  });
});

describe("atmosphere CPU bake cost", () => {
  afterEach(() => {
    SUN_DIRECTION.copy(defaultSun);
  });

  // The starter calls setupSky in load and again in enter; each call used to march the same 2048 rays,
  // seconds of one thread on QuickJS arm64 (CI: the playtest mailbox gave up at 15 s).
  it("bakes the environment once for two skies with the same sun, and again when the sun moves", () => {
    const bakes = vi.mocked(bakeSkyRadiance);
    SUN_DIRECTION.set(0.31, 0.62, 0.72).normalize();
    const before = bakes.mock.calls.length;
    setupSky(new Scene(), undefined, true, true, false);
    setupSky(new Scene(), undefined, true, true, false);
    expect(bakes.mock.calls.length - before).toBe(1);
    SUN_DIRECTION.set(0.31, 0.64, 0.72).normalize();
    setupSky(new Scene(), undefined, true, true, false);
    expect(bakes.mock.calls.length - before).toBe(2);
  });

  it("keeps a cached bake apart from a sky with other inputs", () => {
    SUN_DIRECTION.set(0.2, 0.7, 0.4).normalize();
    const clear = new Scene();
    const cloudy = new Scene();
    setupSky(clear, undefined, true, true, false);
    setupSky(cloudy, undefined, true, true, true);
    const clearPixels = (clear.environment as DataTexture).image.data as Uint8Array;
    const cloudyPixels = (cloudy.environment as DataTexture).image.data as Uint8Array;
    expect(Buffer.from(cloudyPixels).equals(Buffer.from(clearPixels))).toBe(false);
  });

  // Captured from the code before the noise loops were hoisted: the same bytes are the same pixels.
  // sha256 over each texture's float32 bytes.
  it("generates the cloud textures byte for byte as before", () => {
    const { pattern, volume } = cloudTextures();
    const sha = (texture: Float32Array) =>
      createHash("sha256")
        .update(new Uint8Array(texture.buffer, texture.byteOffset, texture.byteLength))
        .digest("hex");
    expect(sha(pattern)).toBe("0f45fa26ee5cb45723570fb2bb3f316dccb19b21480fd3cc618f78999ce590dd");
    expect(sha(volume)).toBe("1165a61000c67b8c68958279b4cb0c095d8a264e3e8d80705accbf9215c04b85");
  });
});

describe("atmosphere model copies", () => {
  it("ships the starter's model files byte for byte in every kit that has them", () => {
    const root = path.join(import.meta.dirname, "..", "templates");
    const kits = readdirSync(root).filter((kit) =>
      existsSync(path.join(root, kit, "src/render/atmosphere.ts")),
    );
    expect(kits.length).toBeGreaterThan(1);
    for (const file of ["atmosphere.ts", "clouds.ts", "gpuSky.ts"]) {
      const starter = readFileSync(path.join(root, "starter/src/render", file), "utf8");
      for (const kit of kits)
        expect(
          readFileSync(path.join(root, kit, "src/render", file), "utf8"),
          `${kit}/${file}`,
        ).toBe(starter);
    }
  });
});

describe("atmosphere kits on a software adapter", () => {
  // CI run 41178046079: five kits called `setupSky(scene, photo)` and never told the sky it ran on a
  // CPU rasteriser, so engine "threejs" compiled the LUT and cloud passes for 150 s and drew nothing.
  // The starter passes the flag; every scene that calls `setupSky` must.
  it("passes the software flag from every scene that sets the sky up", () => {
    const root = path.join(import.meta.dirname, "..", "templates");
    const calls: string[] = [];
    for (const kit of readdirSync(root)) {
      if (!existsSync(path.join(root, kit, "src/render/atmosphere.ts"))) continue;
      const scenes = path.join(root, kit, "src/scenes");
      for (const file of readdirSync(scenes).filter((name) => name.endsWith(".ts"))) {
        const source = readFileSync(path.join(scenes, file), "utf8");
        for (const call of source.matchAll(/\bsetupSky\(([^;]*)\);/gu))
          calls.push(`${kit}/${file}: ${call[0]}`);
      }
    }
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) expect(call, call).toMatch(/softwareAdapter/u);
  });
});
