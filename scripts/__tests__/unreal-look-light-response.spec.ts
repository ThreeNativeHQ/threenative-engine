// PRD-641 AC-2: the cache's response to a changed light follows Unreal's three stages, not a count of frames.
import { describe, expect, it } from "vitest";
import {
  type ILightResponse,
  LightFade,
  checkLightResponse,
  surfaceCacheCycle,
} from "../unreal-look/scaffold/render/lightResponse.js";

/** Epic: `BaseScalability.ini` `[GlobalIlluminationQuality@3]`, lines 416-432, and the 5.8.3 defaults of the other two. */
const EPIC: ILightResponse = {
  updateFactor: 32,
  radiosityUpdateFactor: 64,
  radiosityFramesAccumulated: 4,
  framesAccumulated: 10,
  atlasSize: 4096,
};
/** The surfaces of the cornell calibration scene: room 162 m2, boxes and shade about 33 m2. */
const CORNELL_AREA = 195;
/** The neon corridor: five boxes of 3.4 x 3.4 x 9.2 m at most, 340 m2. */
const NEON_AREA = 340;

/** sRGB display level to linear light, the same transfer for the reference and for what the spec compares. */
const linear = (level: number): number => {
  const v = level / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** The bounces the harness cache keeps (`CalibrationScene.ts.in`, `bounces: 5`). */
const BOUNCES = 5;

/** The share of the light left t frames after the switch: what the first bounce shows and what the last one shows. */
const left = (
  response: ILightResponse,
  area: number,
  frames: number[],
  orders = BOUNCES,
): { first: number[]; last: number[] } => {
  const fade = new LightFade(response, area, orders);
  fade.set([0, 0, 0]);
  const first: number[] = [];
  const last: number[] = [];
  for (let frame = 0; frame <= Math.max(...frames); frame += 1) {
    const shown = fade.step();
    first.push(shown[0]?.[0] as number);
    last.push(shown[orders - 1]?.[0] as number);
  }
  return {
    first: frames.map((t) => first[t] as number),
    last: frames.map((t) => last[t] as number),
  };
};

describe("surfaceCacheCycle", () => {
  it("refreshes a small scene in one frame at Epic (cornell is 0.5% of the atlas, the factor is 32)", () => {
    expect(surfaceCacheCycle(CORNELL_AREA, 32, 4096)).toBe(1);
    expect(surfaceCacheCycle(CORNELL_AREA, 64, 4096)).toBe(1);
  });

  it("takes longer where the atlas is smaller and the factor larger (Medium: 2048, 128)", () => {
    expect(surfaceCacheCycle(CORNELL_AREA, 128, 2048)).toBe(3);
  });

  it("takes longer for a bigger scene, in proportion to its texels", () => {
    expect(surfaceCacheCycle(40_000, 32, 4096)).toBe(31);
    expect(surfaceCacheCycle(80_000, 32, 4096)).toBe(62);
  });

  it("updates at least one page a frame, so a tiny atlas does not stall", () => {
    expect(surfaceCacheCycle(1, 1024, 256)).toBe(1);
  });
});

describe("LightFade", () => {
  it("shows the baked light before any change, and is settled", () => {
    const fade = new LightFade(EPIC, CORNELL_AREA, 3);
    expect(fade.settled).toBe(true);
    expect(fade.step()).toEqual([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
  });

  it("the first bounce follows the pixel history alone when the cache refreshes in a frame", () => {
    const fade = new LightFade(EPIC, CORNELL_AREA);
    expect(fade.refreshFrames).toBe(1);
    fade.set([0, 0, 0]);
    // 1 / (1 + 10) of the gap closes each frame: after n frames (10 / 11) ** n of the light is left.
    for (let n = 1; n <= 30; n += 1) expect(fade.step()[0]?.[0]).toBeCloseTo((10 / 11) ** n, 10);
  });

  it("each later bounce lags one radiosity history more than the one before", () => {
    const fade = new LightFade(EPIC, CORNELL_AREA, 4);
    fade.set([0, 0, 0]);
    for (let n = 1; n <= 40; n += 1) {
      const shown = fade.step().map((order) => order[0] as number);
      for (let k = 1; k < shown.length; k += 1)
        expect(shown[k]).toBeGreaterThan(shown[k - 1] as number);
    }
  });

  it("settles at the new scale and never overshoots, going down and coming back up", () => {
    const fade = new LightFade(EPIC, CORNELL_AREA, 3);
    fade.set([0, 0, 0]);
    let before = 1;
    for (let n = 0; n < 600; n += 1) {
      const shown = fade.step();
      for (const order of shown) expect(order[0]).toBeGreaterThanOrEqual(0);
      expect(shown[0]?.[0]).toBeLessThanOrEqual(before + 1e-9);
      before = shown[0]?.[0] as number;
    }
    expect(fade.settled).toBe(true);
    fade.set([1, 1, 1]);
    expect(fade.settled).toBe(false);
    for (let n = 0; n < 600; n += 1)
      for (const order of fade.step()) expect(order[0]).toBeLessThanOrEqual(1 + 1e-9);
    expect(fade.settled).toBe(true);
  });

  it("fades a scene with a long refresh cycle slower than a small one", () => {
    const small = left(EPIC, CORNELL_AREA, [20]).last[0] as number;
    const large = left(EPIC, 40_000, [20]).last[0] as number;
    expect(large).toBeGreaterThan(small + 0.15);
  });

  it("a response of no history in a one-frame cache follows at once", () => {
    const now: ILightResponse = {
      ...EPIC,
      updateFactor: 1,
      radiosityUpdateFactor: 1,
      radiosityFramesAccumulated: 0,
      framesAccumulated: 0,
    };
    expect(left(now, CORNELL_AREA, [1]).last[0]).toBeCloseTo(0, 12);
  });

  it("refuses a factor under 1, a negative history and no orders", () => {
    expect(() => checkLightResponse({ ...EPIC, updateFactor: 0 })).toThrow(/TN_GI_LIGHT_RESPONSE/u);
    expect(() => checkLightResponse({ ...EPIC, framesAccumulated: -1 })).toThrow(
      /TN_GI_LIGHT_RESPONSE/u,
    );
    expect(() => checkLightResponse({ ...EPIC, atlasSize: 0 })).toThrow(/TN_GI_LIGHT_RESPONSE/u);
    expect(() => new LightFade(EPIC, CORNELL_AREA, 0)).toThrow(/TN_GI_LIGHT_RESPONSE/u);
  });
});

describe("the cornell switch run in Unreal 5.8.3 (L7-Epic-motion, frame 60 on, PRD-641 AC-2)", () => {
  // Display levels t = 0, 1, 2, 4, 6, 10, 15, 20, 30, 40 frames after the switch, and the level it settles at.
  const FRAMES = [0, 1, 2, 4, 6, 10, 15, 20, 30, 40];
  const MEASURED: Record<string, { levels: number[]; after: number }> = {
    Floor: { levels: [127, 125, 121, 113, 104, 88, 70, 54, 29, 13], after: 0 },
    Wall_Green: { levels: [135, 132, 127, 118, 110, 93, 74, 58, 34, 19], after: 1 },
    Box_Tall: { levels: [161, 159, 155, 147, 139, 122, 100, 81, 49, 27], after: 1 },
  };

  // The mix of first-bounce and later-bounce light differs per surface, and the cache weighs it by its own fields. So the
  // measured series has to lie between the two curves the model predicts, and nowhere else.
  const between = (area: number, levels: number[], after: number, frames = FRAMES) => {
    const base = linear(levels[0] as number) - linear(after);
    const { first, last } = left(EPIC, area, frames);
    levels.forEach((level, i) => {
      const measured = (linear(level) - linear(after)) / base;
      expect(measured).toBeGreaterThan((first[i] as number) - 0.04);
      expect(measured).toBeLessThan((last[i] as number) + 0.04);
    });
  };

  it.each(Object.entries(MEASURED))(
    "cornell %s: the measured share left lies between the first-bounce and the later-bounce curve",
    (_name, { levels, after }) => between(CORNELL_AREA, levels, after),
  );

  // The `neon` run (L7-Epic-motion, frame 60 on). The strips and the emitter stay lit, so each series settles above 0.
  // The last value is the level at frame 179; Unreal is still 2 to 5 levels above it at frame 100.
  const NEON: Record<string, { levels: number[]; after: number }> = {
    Floor: { levels: [118, 117, 116, 113, 111, 107, 104, 101, 97, 95], after: 93 },
    Ceiling: { levels: [73, 72, 70, 66, 63, 57, 52, 49, 44, 42], after: 39 },
    Wall_Left: { levels: [134, 133, 132, 130, 128, 125, 121, 119, 115, 113], after: 112 },
    Back: { levels: [149, 147, 145, 141, 137, 129, 122, 116, 109, 105], after: 100 },
  };

  it.each(Object.entries(NEON))(
    "neon %s: the same pin holds on a second scene, with no constant fitted to it",
    (_name, { levels, after }) => between(NEON_AREA, levels, after),
  );

  it("the old 32-frame cycle fails the same pin: it holds the light where Unreal has dropped it", () => {
    const { first } = left({ ...EPIC, radiosityFramesAccumulated: 0 }, 40_000, FRAMES);
    const floor = MEASURED.Floor as { levels: number[]; after: number };
    const measured =
      (linear(floor.levels[5] as number) - linear(floor.after)) / (linear(127) - linear(0));
    expect(first[5]).toBeGreaterThan(measured + 0.2);
  });
});
