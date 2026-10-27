import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SPRINT_SPEED, WALK_SPEED } from "../templates/shooter/src/entities/FpsPlayer.js";
import { locomotion } from "../templates/shooter/src/entities/Rifle.js";

const GLB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "template-assets",
  "assets",
  "player-viewmodel.glb",
);

/** Read each clip's authored length from the GLB's JSON chunk, as the shader-less browser does. */
function clipSeconds(): Map<string, number> {
  const glb = readFileSync(GLB);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as {
    animations: { name: string; samplers: { input: number }[] }[];
    accessors: { max?: number[] }[];
  };
  const lengths = new Map<string, number>();
  for (const animation of json.animations) {
    const end = Math.max(
      ...animation.samplers.map((sampler) => json.accessors[sampler.input]?.max?.[0] ?? 0),
    );
    lengths.set(animation.name, end);
  }
  return lengths;
}

const DURATIONS = clipSeconds();

it("measures the shipped hands clips", () => {
  expect(DURATIONS.get("Walk")).toBeCloseTo(0.8175, 3);
  expect(DURATIONS.get("Run")).toBeCloseTo(0.6507, 3);
});

// Owner, 2026-10-26: the hands looked "like you're having a seizure" while sprinting. A
// first-person locomotion cycle reads as calm at one to two cycles a second, the authored rate.
it.each([
  ["walking", "Walk", WALK_SPEED, false],
  ["sprinting", "Run", SPRINT_SPEED, true],
] as const)("%s plays %s no faster than authored", (_label, clip, speed, sprinting) => {
  const gait = locomotion(speed, sprinting);
  expect(gait.clip).toBe(clip);
  const cyclesPerSecond = gait.timeScale / (DURATIONS.get(clip) as number);
  expect(cyclesPerSecond).toBeGreaterThanOrEqual(0.8);
  expect(cyclesPerSecond).toBeLessThanOrEqual(1.8);
  expect(gait.bobScale).toBe(0);
});

it("slows the clip while the body eases in, never below a walk's read", () => {
  expect(locomotion(WALK_SPEED * 0.5, false).timeScale).toBeCloseTo(0.6, 5);
  expect(locomotion(WALK_SPEED * 0.8, false).timeScale).toBeCloseTo(0.8, 5);
});

it("leaves the procedural bob to the idle clip alone", () => {
  const gait = locomotion(0, false);
  expect(gait.clip).toBe("Idle");
  expect(gait.bobScale).toBe(1);
});
