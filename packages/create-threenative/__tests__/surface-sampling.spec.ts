import { afterEach, describe, expect, it, vi } from "vitest";

type Sampling = {
  surfaceSampling: { mipBias: "auto" | number };
  updateSurfaceSampling(scale: number): number;
};

afterEach(() => vi.restoreAllMocks());

for (const kit of ["collectathon", "adventure"] as const) {
  describe(`${kit} authored surface sampling`, () => {
    const load = async () => {
      vi.resetModules();
      const surface =
        kit === "collectathon"
          ? await import("../templates/collectathon/src/render/surface.js")
          : await import("../templates/adventure/src/render/surface.js");
      expect(surface).toHaveProperty("updateSurfaceSampling");
      expect(surface).toHaveProperty("surfaceSampling");
      return surface as unknown as Sampling;
    };

    it("preserves full resolution and compensates reduced input footprints", async () => {
      const surface = await load();
      expect(surface.updateSurfaceSampling(1)).toBe(0);
      expect(surface.updateSurfaceSampling(0.72)).toBeCloseTo(-0.773931188, 8);
      expect(surface.updateSurfaceSampling(0.27)).toBe(-2);
      expect(surface.updateSurfaceSampling(1)).toBe(0);
    });

    it("honors and reports a zero override once instead of treating it as auto", async () => {
      const surface = await load();
      const report = vi.spyOn(console, "info").mockImplementation(() => {});
      surface.surfaceSampling.mipBias = 0;
      expect(surface.updateSurfaceSampling(0.72)).toBe(0);
      expect(surface.updateSurfaceSampling(0.27)).toBe(0);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0]?.[0]).toContain('"mipBias":0');
    });

    it("rejects invalid input fractions even with an explicit override", async () => {
      const surface = await load();
      surface.surfaceSampling.mipBias = 0;
      for (const scale of [0, -1, 1.01, Number.NaN, Number.POSITIVE_INFINITY])
        expect(() => surface.updateSurfaceSampling(scale)).toThrow(/scale/i);
    });

    it("rejects nonfinite overrides and bounds finite sampler bias", async () => {
      const surface = await load();
      vi.spyOn(console, "info").mockImplementation(() => {});
      for (const bias of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
        surface.surfaceSampling.mipBias = bias;
        expect(() => surface.updateSurfaceSampling(0.72)).toThrow(/mipBias/i);
      }
      surface.surfaceSampling.mipBias = -8;
      expect(surface.updateSurfaceSampling(0.72)).toBe(-4);
      surface.surfaceSampling.mipBias = 8;
      expect(surface.updateSurfaceSampling(0.72)).toBe(4);
    });
  });
}
