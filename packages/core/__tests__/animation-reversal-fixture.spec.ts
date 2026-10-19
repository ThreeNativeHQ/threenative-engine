import { readFileSync } from "node:fs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, it, vi } from "vitest";
import { createReversalTrace } from "../../../examples/abyss-framework/src/render/animation-reversal-trace.js";

// Run the fixture against this checkout's real engine source, never a stale dist bundle.
vi.mock("@threenative/core", async () => import("../src/index.js"));

it("keeps the shipped CC0 mannequin's live gait continuous through nine reversals", async () => {
  const bytes = readFileSync(
    new URL("../../create-threenative/template-assets/assets/mannequin.glb", import.meta.url),
  );
  const model = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  const trace = createReversalTrace(model);
  for (let tick = 0; tick < 108; tick += 1) trace.step();
  const measured = trace.observation();
  expect(measured.tick).toBe(108);
  expect(measured.bones).toBeGreaterThan(60);
  expect(measured.reversals).toBe(9);
  expect(measured.returningRequests).toBeGreaterThanOrEqual(4);
  expect(measured.maxWeightError).toBeLessThan(1e-6);
  expect(measured.maxPhaseJump).toBeLessThan(1e-6);
  expect(measured.maxPoseJumpMetres).toBeLessThan(1e-6);
  expect(measured.maxPoseJumpRadians).toBeLessThan(1e-6);
  expect(measured.maxAnimatedRadians).toBeGreaterThan(0.2);
  expect(measured.activeActions).toBe(1);
  trace.player.dispose();
  expect(trace.player.mixer.stats.actions.total).toBe(0);
});

it("constructs the capture game before a browser starts", async () => {
  const { default: game } = await import(
    "../../../examples/abyss-framework/src/render/animation-reversal-game.js"
  );
  expect(game.ctx).toBeUndefined();
});
