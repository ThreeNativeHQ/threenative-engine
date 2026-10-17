import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  ENGINE_PARITY_THRESHOLD,
  KNOWN_GAPS,
  parityScore,
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
    const [gap] = Object.keys(KNOWN_GAPS);
    expect(gap).toBeDefined();
    expect(verdict(gap as string, 0.85).ok).toBe(true);
    expect(verdict(gap as string, 0.01)).toMatchObject({ ok: false });
    expect(verdict(gap as string, 0.01).message).toContain("TN_ENGINE_PARITY_GAP_CLOSED");
    expect(verdict("starter", 0.2).message).toContain("TN_ENGINE_PARITY:");
    expect(verdict("starter", 0.05).ok).toBe(true);
  });

  it("sets the engine on a pinned config and on one that names none", () => {
    expect(
      withEngine('export default {\n  engine: "threejs",\n  app: {},\n};\n', "threenative"),
    ).toBe('export default {\n  engine: "threenative",\n  app: {},\n};\n');
    expect(withEngine("export default defineConfig({ app: {} });\n", "threejs")).toBe(
      'export default defineConfig({\n  engine: "threejs", app: {} });\n',
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
