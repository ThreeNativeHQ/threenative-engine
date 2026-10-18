import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  ENGINE_PARITY_THRESHOLD,
  KNOWN_GAPS,
  observedFixedStepSeconds,
  parityScore,
  sameFixedStepPose,
  sideBySide,
  verdict,
  withEngine,
} from "../engine-parity.js";

function frame(width: number, height: number, paint: (x: number, y: number) => number): PNG {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = paint(x, y);
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  return image;
}

describe("engine parity guard", () => {
  it("measures the pose interval from the bridge's fixed-step clock", () => {
    // This is the public sample clock emitted by a fixed-step Three bridge: no resources clock
    // is required for the elapsed simulation interval.
    const before = { mode: "fixed-step" as const, tick: 60 };
    const after = { mode: "fixed-step" as const, tick: 360 };
    expect(observedFixedStepSeconds(before, after)).toBe(5);
    expect(observedFixedStepSeconds(before, { ...after, tick: Number.NaN })).toBeNull();
    expect(observedFixedStepSeconds(before, { mode: "wall-clock", tick: 360 })).toBeNull();
    expect(observedFixedStepSeconds(before, { mode: "fixed-step" })).toBeNull();
  });

  it("rejects equal intervals that end at different observed scene ticks", () => {
    const firstBefore = { mode: "fixed-step" as const, tick: 60 };
    const firstAfter = { mode: "fixed-step" as const, tick: 360 };
    const secondBefore = { mode: "fixed-step" as const, tick: 120 };
    const secondAfter = { mode: "fixed-step" as const, tick: 420 };
    expect(observedFixedStepSeconds(firstBefore, firstAfter)).toBe(5);
    expect(observedFixedStepSeconds(secondBefore, secondAfter)).toBe(5);
    expect(sameFixedStepPose(firstAfter, secondAfter)).toBe(false);
    expect(sameFixedStepPose(firstAfter, { ...firstAfter })).toBe(true);
  });

  it("passes matching frames and fails sailing's measured brightness gap", () => {
    const threejs = frame(64, 32, () => 137);
    expect(
      parityScore(
        threejs,
        frame(64, 32, () => 139),
      ),
    ).toBeLessThan(ENGINE_PARITY_THRESHOLD);
    // Sailing 2026-10-17: mean 137 on threejs, 225 on threenative.
    expect(
      parityScore(
        threejs,
        frame(64, 32, () => 225),
      ),
    ).toBeGreaterThan(ENGINE_PARITY_THRESHOLD);
  });

  it("fails one wrong tile that a global mean would hide", () => {
    const threejs = frame(64, 64, () => 100);
    // A missing object in one corner tile: 1/16 of the frame, under 2% of the global mean.
    const threenative = frame(64, 64, (x, y) => (x < 16 && y < 16 ? 0 : 100));
    expect(parityScore(threejs, threenative)).toBeGreaterThan(ENGINE_PARITY_THRESHOLD);
  });

  it("refuses frames of different sizes", () => {
    expect(() =>
      parityScore(
        frame(8, 8, () => 0),
        frame(8, 4, () => 0),
      ),
    ).toThrow("TN_ENGINE_PARITY_SIZE");
  });

  it("passes a known gap and fails it once it closes, so the list cannot go stale", () => {
    const gaps = { sailing: "tracked elsewhere" };
    expect(verdict("sailing", 0.85, gaps).ok).toBe(true);
    expect(verdict("sailing", 0.01, gaps)).toMatchObject({ ok: false });
    expect(verdict("sailing", 0.01, gaps).message).toContain("TN_ENGINE_PARITY_GAP_CLOSED");
    expect(verdict("sailing", 0.85, KNOWN_GAPS).ok).toBe(false);
    expect(verdict("starter", 0.2).message).toContain("TN_ENGINE_PARITY:");
    expect(verdict("starter", 0.05).ok).toBe(true);
  });

  it("re-exports the config under one engine, overriding a pin, for any export shape", () => {
    const template =
      'const config = {\n  engine: "threejs",\n  app: {},\n};\n\nexport default config;\n';
    expect(withEngine(template, "threenative")).toBe(
      'const config = {\n  engine: "threejs",\n  app: {},\n};\n\nconst __engineParityBase = config;\n' +
        '\nexport default { ...__engineParityBase, engine: "threenative" };\n',
    );
    expect(withEngine("export default defineConfig({ app: {} });\n", "threejs")).toContain(
      "const __engineParityBase = defineConfig({ app: {} });",
    );
    expect(() => withEngine("module.exports = {};", "threejs")).toThrow("TN_ENGINE_PARITY_CONFIG");
  });

  it("lays the two frames side by side", () => {
    const out = sideBySide(
      frame(4, 3, () => 0),
      frame(5, 2, () => 255),
    );
    expect([out.width, out.height]).toEqual([4 + 16 + 5, 3]);
  });
});
