import { describe, expect, it } from "vitest";
import { contactGap, floorEdges, matchedWidths, pairedPenumbra } from "../unreal-look/penumbra.js";

const WIDTH = 160;
/** One row repeated, lit 1.0 on the left, 0.1 on the right, a linear ramp `ramp` px wide at x = 80. */
function image(ramp: number, lit = 1, dark = 0.1) {
  const row = Float64Array.from({ length: WIDTH }, (_, x) => {
    const t = Math.min(1, Math.max(0, (x - 80) / Math.max(ramp, 1e-6)));
    return lit + (dark - lit) * t;
  });
  const lum = new Float64Array(WIDTH * 16);
  for (let y = 0; y < 16; y++) lum.set(row, y * WIDTH);
  return { lum, floor: new Uint8Array(WIDTH * 16).fill(1) };
}

describe("floorEdges", () => {
  it("reads the 10 to 90 percent width of a linear ramp", () => {
    const { lum, floor } = image(5);
    const edges = floorEdges(lum, WIDTH, 16, floor);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(edge.width).toBeCloseTo(4, 0);
  });

  it("separates a soft edge from a hard one", () => {
    const hard = image(1);
    const soft = image(9);
    const a = floorEdges(hard.lum, WIDTH, 16, hard.floor);
    const b = floorEdges(soft.lum, WIDTH, 16, soft.floor);
    expect(matchedWidths(a, b).other / matchedWidths(a, b).unreal).toBeGreaterThan(5);
  });

  it("finds no edge in a flat floor or in a step weaker than 35 percent", () => {
    const flat = image(4, 1, 1);
    const weak = image(4, 1, 0.8);
    expect(floorEdges(flat.lum, WIDTH, 16, flat.floor)).toEqual([]);
    expect(floorEdges(weak.lum, WIDTH, 16, weak.floor)).toEqual([]);
  });

  it("ignores pixels outside the floor mask", () => {
    const { lum } = image(4);
    expect(floorEdges(lum, WIDTH, 16, new Uint8Array(WIDTH * 16))).toEqual([]);
  });
});

describe("pairedPenumbra", () => {
  /** An RGBA frame of `image(ramp)`'s luminance as grey sRGB. */
  function frame(ramp: number) {
    const { lum } = image(ramp);
    const data = new Uint8Array(lum.length * 4);
    lum.forEach((v, i) => {
      const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
      data.fill(Math.round(s * 255), i * 4, i * 4 + 3);
      data[i * 4 + 3] = 255;
    });
    return { data, width: WIDTH, height: 16 };
  }
  const floor = new Uint8Array(WIDTH * 16).fill(1);

  it("reads a ratio of 1 for equal edges and above 1 for the softer arm", () => {
    expect(pairedPenumbra(frame(6), frame(6), floor)?.ratio).toBeCloseTo(1, 5);
    expect(pairedPenumbra(frame(3), frame(9), floor)?.ratio).toBeGreaterThan(2);
  });

  it("reports nothing when the arms share no edge", () => {
    expect(pairedPenumbra(frame(6), frame(6), new Uint8Array(WIDTH * 16))).toBeUndefined();
  });
});

describe("a wide penumbra (a lamp with a source radius)", () => {
  const W = 520;
  /** A grey sRGB frame, 16 rows of one luminance ramp `ramp` px wide, centred on x = 280. */
  function frame(ramp: number) {
    const data = new Uint8Array(W * 16 * 4);
    for (let i = 0; i < W * 16; i++) {
      const t = Math.min(1, Math.max(0, ((i % W) - (280 - ramp / 2)) / ramp));
      const v = 1 + (0.1 - 1) * t;
      data.fill(
        Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255),
        i * 4,
        i * 4 + 3,
      );
      data[i * 4 + 3] = 255;
    }
    return { data, width: W, height: 16 };
  }
  const floor = new Uint8Array(W * 16).fill(1);

  it("is not an edge at the default scale, and reads 80 percent of the ramp at scale 3", () => {
    expect(pairedPenumbra(frame(25), frame(25), floor)).toBeUndefined();
    const m = pairedPenumbra(frame(25), frame(25), floor, 3);
    expect(m?.unreal).toBeCloseTo(20, 0);
    expect(m?.ratio).toBeCloseTo(1, 5);
  });

  it("reads an edge at a scale whose windows are not whole pixels", () => {
    const m = pairedPenumbra(frame(10), frame(10), floor, 1.3);
    expect(m?.unreal).toBeCloseTo(8, 0);
    expect(m?.ratio).toBeCloseTo(1, 5);
  });

  it("tells a penumbra twice as wide apart", () => {
    expect(pairedPenumbra(frame(20), frame(40), floor, 3)?.ratio).toBeCloseTo(2, 1);
  });
});

describe("contactGap", () => {
  const W = 40;
  const H = 100;
  /** A caster 10 rows tall ends at row 29; the floor below is lit until `shadowFrom`, then dark. */
  function scene(shadowFrom: number) {
    const lum = new Float64Array(W * H).fill(1);
    const caster = new Uint8Array(W * H);
    const floor = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 10; x < 30; x++) {
        if (y >= 20 && y < 30) caster[y * W + x] = 1;
        else if (y >= 30) {
          floor[y * W + x] = 1;
          if (y >= shadowFrom) lum[y * W + x] = 0.05;
        }
      }
    for (let y = 30; y < H; y++) for (let x = 0; x < W; x++) floor[y * W + x] = 1;
    return { caster, floor, lum };
  }

  it("reads 0 when the shadow starts at the caster's base and grows with the gap", () => {
    const rows = [30, 34, 42].map((from) => {
      const { caster, floor, lum } = scene(from);
      return contactGap(lum, W, H, caster, floor);
    });
    expect(rows).toEqual([0, 4, 12]);
  });

  it("reads nothing when the floor under the caster stays lit", () => {
    const { caster, floor, lum } = scene(H);
    expect(contactGap(lum, W, H, caster, floor)).toBeUndefined();
  });
});
