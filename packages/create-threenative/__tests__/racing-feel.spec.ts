import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { audioPass } from "@threenative/assets";
import type { IAudioConfig } from "@threenative/assets";
import { describe, expect, it } from "vitest";
import { ENGINE_SOUND, engineRate } from "../templates/racing/src/audio/engine.js";
import { FEEL } from "../templates/racing/src/entities/CarBody.js";
import { DRIFT, Drift } from "../templates/racing/src/entities/Drift.js";
import { NITRO, Nitro } from "../templates/racing/src/entities/Nitro.js";
import { GAUGES, Gauges, gearBand, rpmIn } from "../templates/racing/src/gauges.js";
import config from "../templates/racing/threenative.config.js";

/**
 * The racing kit's race feel — the rev counter, the nitro tank and the engine's pitch — as maths,
 * and the three clips it plays through the shared audio pass.
 *
 * The playtests prove the wiring on a real browser (`playtests/hud.playtest.json` sees the engine
 * rate rise with speed, `playtests/nitro.playtest.json` sees a drift fill the tank). This file
 * proves the laws those measurements rest on, so a scenario that passes says something stronger
 * than "some number moved".
 */

const TEMPLATE = path.resolve("packages/create-threenative/templates/racing");
const TICK = 1 / 60;

describe("the rev counter", () => {
  it("uses the whole box on one pull and never leaves its band", () => {
    const gauges = new Gauges();
    const gears = new Set<number>();
    let previous = 0;
    for (let tick = 0; tick < 900; tick += 1) {
      // A pull from rest to the top speed over fifteen seconds, well past the car's own pace, so
      // the box has to be climbed rather than skipped.
      gauges.update(Math.min(FEEL.topSpeed, tick * 0.03), TICK);
      gears.add(gauges.gear);
      expect(gauges.rpm).toBeGreaterThanOrEqual(0);
      expect(gauges.rpm).toBeLessThanOrEqual(1);
      // A gear decides which band the needle reads, so the gear tracks the speed within one gear:
      // a box that ran ahead would pin the needle at zero in second at four metres per second.
      const span = FEEL.topSpeed / GAUGES.gears;
      const belongs = Math.min(
        GAUGES.gears,
        1 + Math.floor(Math.min(FEEL.topSpeed, tick * 0.03) / span),
      );
      expect(Math.abs(gauges.gear - belongs)).toBeLessThanOrEqual(1);
      expect(Math.abs(gauges.gear - previous)).toBeLessThanOrEqual(1);
      previous = gauges.gear;
    }
    expect([...gears].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("falls at a capped rate and is blended, not stepped, when the throttle closes", () => {
    const gauges = new Gauges();
    for (let tick = 0; tick < 200; tick += 1) gauges.update(FEEL.topSpeed, TICK);
    const held = gauges.rpm;
    gauges.update(0, TICK);
    // One tick of a closed throttle: 55% of a fall capped at `fallPerSecond`, not a jump to idle.
    const floor = held - GAUGES.newShare * GAUGES.fallPerSecond * TICK;
    expect(gauges.rpm).toBeLessThan(held);
    expect(gauges.rpm).toBeGreaterThanOrEqual(floor - 1e-9);
    // And it does arrive: a second off the throttle is idle, in first, with a downshift on the way.
    for (let tick = 0; tick < 120; tick += 1) gauges.update(0, TICK);
    expect(gauges.gear).toBe(1);
    expect(gauges.rpm).toBeGreaterThanOrEqual(GAUGES.idle);
    expect(gauges.rpm).toBeLessThan(GAUGES.idle + 0.02);
  });

  it("reads reverse as idle in first rather than a negative band", () => {
    expect(rpmIn(-6, 1)).toBe(0);
    expect(Math.max(0, -6)).toBe(0);
    const gauges = new Gauges();
    gauges.update(-6, TICK);
    expect(gauges.gear).toBe(1);
    expect(gauges.rpm).toBeGreaterThanOrEqual(GAUGES.idle);
  });
});

describe("the nitro tank", () => {
  it("fills four times faster in a drift than it does coasting, at the same speed", () => {
    const drifting = new Nitro();
    const coasting = new Nitro();
    drifting.tank = 0.2;
    coasting.tank = 0.2;
    // Three seconds at the same road speed. The passive refill waits out the disengage delay first.
    for (let tick = 0; tick < 180; tick += 1) {
      drifting.update(false, 15, true, TICK);
      coasting.update(false, 15, false, TICK);
    }
    expect(coasting.driftGain).toBe(0);
    expect(drifting.driftGain).toBeGreaterThan(NITRO.driftRefillPerSecond * 2.5);
    expect(drifting.tank).toBeGreaterThan(coasting.tank + 0.5);
  });

  it("engages at speed, stays engaged down to half of it, and waits before refilling", () => {
    const nitro = new Nitro();
    nitro.update(true, NITRO.engageSpeed * 0.9, false, TICK);
    expect(nitro.engaged).toBe(false);
    nitro.update(true, 12, false, TICK);
    expect(nitro.engaged).toBe(true);
    // Down to half the engage speed it holds; below that it lets go.
    nitro.update(true, NITRO.engageSpeed * 0.6, false, TICK);
    expect(nitro.engaged).toBe(true);
    nitro.update(true, NITRO.engageSpeed * 0.4, false, TICK);
    expect(nitro.engaged).toBe(false);
    // The delay runs before any refill, drifting or not: NFS `EngineRacer.cpp:926-976`.
    const afterRelease = nitro.tank;
    for (let tick = 0; tick < Math.floor((NITRO.disengageDelay / TICK) * 0.5); tick += 1)
      nitro.update(false, 15, false, TICK);
    expect(nitro.tank).toBe(afterRelease);
    expect(nitro.refillGain).toBe(0);
  });
});

describe("the engine's pitch", () => {
  it("is the needle's, geometrically", () => {
    expect(engineRate(0)).toBeCloseTo(ENGINE_SOUND.idleRate, 10);
    expect(engineRate(1)).toBeCloseTo(ENGINE_SOUND.redlineRate, 10);
    let previous = 0;
    for (let step = 0; step <= 20; step += 1) {
      const rate = engineRate(step / 20);
      expect(rate).toBeGreaterThan(previous);
      previous = rate;
    }
    // Half revs is the geometric mean, not the arithmetic one, because pitch is logarithmic.
    expect(engineRate(0.5)).toBeCloseTo(
      Math.sqrt(ENGINE_SOUND.idleRate * ENGINE_SOUND.redlineRate),
      10,
    );
  });

  it("is out of the box below the engine's idle and above it at the limit", () => {
    expect(engineRate(0)).toBeLessThan(1);
    expect(engineRate(1)).toBeGreaterThan(2);
    // Clamped outside the needle's range rather than extrapolated into an inaudible chipmunk.
    expect(engineRate(-1)).toBe(engineRate(0));
    expect(engineRate(2)).toBe(engineRate(1));
  });
});

describe("the racing clips through the shared audio pass", () => {
  const overrides: NonNullable<IAudioConfig["overrides"]> =
    config.assets?.audio === undefined || config.assets.audio === "none"
      ? []
      : (config.assets.audio.overrides ?? []);
  const looped = overrides
    .filter((override) => override.loop !== undefined && override.loop !== false)
    .map((override) => override.glob)
    .sort();

  it("declares both beds as loops and no cross-fade, because the bake's seam is exact", () => {
    expect(looped).toEqual(["engine-loop.wav", "tyre-squeal.wav"]);
    for (const override of overrides)
      if (override.loop !== undefined && override.loop !== false)
        expect(override.loop).toEqual({ crossFadeMs: 0 });
  });

  it.each(["engine-loop.wav", "tyre-squeal.wav", "nitro-burst.wav"])(
    "ships %s as a clip the pass will not reject",
    async (name) => {
      const input = await readFile(path.join(TEMPLATE, "assets", name));
      const output = await audioPass({ overrides }).apply(input, name);
      expect(Buffer.isBuffer(output)).toBe(false);
      const cooked = output as { buffer: Buffer; entry?: { audio?: Record<string, unknown> } };
      expect(cooked.buffer.length).toBeGreaterThan(0);
      const audio = cooked.entry?.audio ?? {};
      const loop = looped.includes(name);
      expect(audio.loop).toBe(loop);
      // The seam ratio is what the pass fails a build on, and it is measured after the clip's own
      // codec round trip — so this is the loop a device decodes, not the one the tool wrote.
      expect(audio.seamRatio).toBeLessThanOrEqual(1);
      expect(audio.conditioned).toBe(true);
      expect(audio.frames).toBeGreaterThan(0);
      expect(audio.sampleRate).toBe(44100);
    },
  );

  it("ships the bytes the checked-in tool bakes, so the clips are not hand-edited", () => {
    // `--check` re-bakes from the seed and compares against `assets/`, and it also re-asserts the
    // tool's own gates: the seam, the pitch bin, the peak and run-to-run determinism.
    expect(() =>
      execFileSync("node", [path.join(TEMPLATE, "tools", "make-racing-audio.mjs"), "--check"], {
        cwd: TEMPLATE,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});

describe("the banked-score popup", () => {
  /** The parts of the car a drift reads, so the clock can be driven without a Rapier body. */
  const stubCar = (rearSlip: number) => {
    const grips: number[] = [];
    return {
      body: {
        setWheelFrictionSlip: (index: number, value: number) => {
          grips[index] = value;
        },
        wheelContact: () => true,
      },
      grips,
      groundSpeed: 20,
      rearSlip,
      teleports: 0,
    };
  };

  it("is the drift's clock in game seconds, so a pause freezes it rather than ageing it", () => {
    const dt = 1 / 60;
    const car = stubCar(0.5);
    const drift = new Drift();
    // Hold the slide past the bank threshold, then straighten: the score banks on that tick.
    for (let index = 0; index < 30; index += 1) drift.update(car as never, false, 0, dt);
    expect(drift.popup, "the popup stays shut until a drift banks").toBe(0);
    car.rearSlip = 0;
    drift.update(car as never, false, 0, dt);
    expect(drift.banked).toBe(1);
    expect(drift.popup, "a banked score arms the popup").toBe(DRIFT.popupSeconds);
    // The clock is only advanced by `update`, which is what a pause stops: reading it again, or
    // waiting in wall clock, must not age it.
    expect(drift.popup, "an unticked frame does not age the popup").toBe(DRIFT.popupSeconds);
    const ticks = Math.ceil(DRIFT.popupSeconds / dt);
    for (let index = 0; index < ticks - 1; index += 1) drift.update(car as never, false, 0, dt);
    expect(drift.popup, "a tick short of the duration still shows").toBeGreaterThan(0);
    drift.update(car as never, false, 0, dt);
    expect(drift.popup, "the popup ends on the last tick of its duration").toBe(0);
  });
});

describe("the rear grip's easing", () => {
  const stubCar = (rearSlip: number) => {
    const grips: number[] = [];
    return {
      body: {
        setWheelFrictionSlip: (index: number, value: number) => {
          grips[index] = value;
        },
        wheelContact: () => true,
      },
      grips,
      groundSpeed: 20,
      rearSlip,
      teleports: 0,
    };
  };

  it("falls to a lower target over several ticks, never in one", () => {
    const dt = 1 / 60;
    const car = stubCar(0.5);
    const drift = new Drift();
    const start = drift.grip;
    // A held slide with a full lock: the target drops to `holdGrip`, about 3 m/s² of grip.
    let previous = drift.grip;
    let biggestStep = 0;
    for (let index = 0; index < 40; index += 1) {
      drift.update(car as never, false, 1, dt);
      biggestStep = Math.max(biggestStep, Math.abs(drift.grip - previous));
      previous = drift.grip;
    }
    // One tick of the fall is 13.5 * dt / 0.05 s = 4.5; the old code jumped the whole 13.5 at once.
    expect(biggestStep, "the grip's biggest single-tick change").toBeLessThan(start * 0.5);
    expect(drift.grip, "a held slide still lets the rear go").toBeLessThan(start * 0.2);
  });
});
