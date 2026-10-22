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

/** sRGB display level to linear light, the same transfer for the reference and for what the spec compares. */
const linear = (level: number): number => {
  const v = level / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** The share of the light left t frames after the switch: what the first bounce shows and what the later bounces show. */
const left = (
  response: ILightResponse,
  area: number,
  frames: number[],
): { first: number[]; rest: number[] } => {
  const fade = new LightFade(response, area);
  fade.set([0, 0, 0]);
  const first: number[] = [];
  const rest: number[] = [];
  for (let frame = 0; frame <= Math.max(...frames); frame += 1) {
    const shown = fade.step();
    first.push(shown.first[0] as number);
    rest.push(shown.rest[0] as number);
  }
  return {
    first: frames.map((t) => first[t] as number),
    rest: frames.map((t) => rest[t] as number),
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
    const fade = new LightFade(EPIC, CORNELL_AREA);
    expect(fade.settled).toBe(true);
    expect(fade.step()).toEqual({ first: [1, 1, 1], rest: [1, 1, 1] });
  });

  it("the first bounce follows the pixel history alone when the cache refreshes in a frame", () => {
    const fade = new LightFade(EPIC, CORNELL_AREA);
    expect(fade.refreshFrames).toBe(1);
    fade.set([0, 0, 0]);
    // 1 / (1 + 10) of the gap closes each frame: after n frames (10 / 11) ** n of the light is left.
    for (let n = 1; n <= 30; n += 1) expect(fade.step().first[0]).toBeCloseTo((10 / 11) ** n, 10);
  });

  it("later bounces lag the first: the radiosity history holds them 4 frames behind", () => {
    const fade = new LightFade(EPIC, CORNELL_AREA);
    fade.set([0, 0, 0]);
    for (let n = 1; n <= 40; n += 1) {
      const { first, rest } = fade.step();
      expect(rest[0]).toBeGreaterThan(first[0] as number);
    }
  });

  it("settles at the new scale and never overshoots, going down and coming back up", () => {
    const fade = new LightFade(EPIC, CORNELL_AREA);
    fade.set([0, 0, 0]);
    let before = 1;
    for (let n = 0; n < 400; n += 1) {
      const { first, rest } = fade.step();
      expect(first[0]).toBeLessThanOrEqual(before + 1e-9);
      expect(rest[0]).toBeGreaterThanOrEqual(0);
      before = first[0] as number;
    }
    expect(fade.settled).toBe(true);
    fade.set([1, 1, 1]);
    expect(fade.settled).toBe(false);
    for (let n = 0; n < 400; n += 1) {
      const { first, rest } = fade.step();
      expect(first[0]).toBeLessThanOrEqual(1 + 1e-9);
      expect(rest[0]).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(fade.settled).toBe(true);
  });

  it("fades a scene with a long refresh cycle slower than a small one", () => {
    const small = left(EPIC, CORNELL_AREA, [20]).rest[0] as number;
    const large = left(EPIC, 40_000, [20]).rest[0] as number;
    expect(large).toBeGreaterThan(small + 0.2);
  });

  it("a response of no history in a one-frame cache follows at once", () => {
    const now: ILightResponse = {
      ...EPIC,
      updateFactor: 1,
      radiosityUpdateFactor: 1,
      radiosityFramesAccumulated: 0,
      framesAccumulated: 0,
    };
    expect(left(now, CORNELL_AREA, [1]).rest[0]).toBeCloseTo(0, 12);
  });

  it("refuses a factor under 1 and a negative history", () => {
    expect(() => checkLightResponse({ ...EPIC, updateFactor: 0 })).toThrow(/TN_GI_LIGHT_RESPONSE/u);
    expect(() => checkLightResponse({ ...EPIC, framesAccumulated: -1 })).toThrow(
      /TN_GI_LIGHT_RESPONSE/u,
    );
    expect(() => checkLightResponse({ ...EPIC, atlasSize: 0 })).toThrow(/TN_GI_LIGHT_RESPONSE/u);
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
  it.each(Object.entries(MEASURED))(
    "%s: the measured share left lies between the first-bounce and the later-bounce curve",
    (_name, { levels, after }) => {
      const base = linear(levels[0] as number) - linear(after);
      const { first, rest } = left(EPIC, CORNELL_AREA, FRAMES);
      levels.forEach((level, i) => {
        const measured = (linear(level) - linear(after)) / base;
        expect(measured).toBeGreaterThan((first[i] as number) - 0.04);
        expect(measured).toBeLessThan((rest[i] as number) + 0.04);
      });
    },
  );

  it("the old 32-frame cycle fails the same pin: it holds the light where Unreal has dropped it", () => {
    const { first } = left({ ...EPIC, radiosityFramesAccumulated: 0 }, 40_000, FRAMES);
    const floor = MEASURED.Floor as { levels: number[]; after: number };
    const measured =
      (linear(floor.levels[5] as number) - linear(floor.after)) / (linear(127) - linear(0));
    expect(first[5]).toBeGreaterThan(measured + 0.2);
  });
});
