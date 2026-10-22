import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JITTER_PERIOD,
  JITTER_PHASE,
  JITTER_SWITCH,
  MIN_STEPS,
  RENDERER_LOST,
  SETTLE_STEPS,
  atFixedJitterPhase,
  atJitterPhase,
  jitterOf,
} from "../unreal-look/jitterPhase.js";

/** A page whose engine draws `drawsPerStep` frames a step and reports the jitter of the frame it drew last. */
function fakePage(
  start: number,
  options: {
    drawsPerStep?: number;
    active?: boolean;
    frozen?: boolean;
    declineFirst?: number;
  } = {},
) {
  const { drawsPerStep = 1, active = true, frozen = false } = options;
  const state = { frame: start, held: false, released: 0, steps: 0, declined: 0 };
  const reading = () => ({
    active,
    frame: state.frame,
    jitter: jitterOf(((state.frame % JITTER_PERIOD) + JITTER_PERIOD) % JITTER_PERIOD),
  });
  const page = {
    state,
    async evaluate(script: string): Promise<unknown> {
      if (script.includes("__tnGate.hold")) {
        state.held = true;
        return 1;
      }
      if (script.includes("__tnGate.release")) {
        state.held = false;
        state.released += 1;
        return undefined;
      }
      if (script.includes("__tnGate.step")) {
        if (!state.held) throw new Error("a step ran outside the held loop");
        if (state.declined < (options.declineFirst ?? 0)) {
          state.declined += 1;
          return { callbacks: 1, drawn: 0, skipped: 1 };
        }
        state.steps += 1;
        if (!frozen) state.frame += drawsPerStep;
        return { callbacks: 1, drawn: frozen ? 0 : drawsPerStep, skipped: 0 };
      }
      if (script.includes("info.engine?.temporal")) return reading();
      throw new Error(`unexpected page script: ${script}`);
    },
    async waitForTimeout(): Promise<void> {},
  };
  return page;
}

afterEach(() => {
  delete process.env[JITTER_SWITCH];
});

describe("the jitter sequence", () => {
  it("is the engine's 31-point Halton sequence, 2 and 3, centred on the pixel", () => {
    // Pinned from traa_reference_test.mjs (the engine's traaJitter equals three's TRAANode over 96 frames).
    expect(jitterOf(0)).toEqual([0, 1 / 3 - 0.5]);
    expect(jitterOf(1)).toEqual([0.25 - 0.5, 2 / 3 - 0.5]);
    expect(jitterOf(2)[0]).toBeCloseTo(0.25, 12);
    expect(jitterOf(2)[1]).toBeCloseTo(1 / 9 - 0.5, 12);
    expect(new Set(Array.from({ length: JITTER_PERIOD }, (_, i) => jitterOf(i).join())).size).toBe(
      JITTER_PERIOD,
    );
  });

  it("rejects a phase outside the sequence", () => {
    expect(() => jitterOf(JITTER_PERIOD)).toThrow("TN_UNREAL_LOOK_BAD_INPUT");
    expect(() => jitterOf(-1)).toThrow("TN_UNREAL_LOOK_BAD_INPUT");
  });

  it("names a frame's phase from the offset the engine drew it with, and nothing else", () => {
    const frame = (phase: number, active = true) => ({
      active,
      frame: 99,
      jitter: jitterOf(phase),
    });
    expect(atJitterPhase(frame(JITTER_PHASE))).toBe(true);
    expect(atJitterPhase(frame(JITTER_PHASE + 1))).toBe(false);
    expect(atJitterPhase(frame(JITTER_PHASE, false))).toBe(false);
    expect(atJitterPhase(undefined)).toBe(false);
  });
});

describe("a still is taken on a fixed jitter phase", () => {
  it("lands on the phase from every start of the loop, and gives the loop back", async () => {
    for (let start = 0; start < 2 * JITTER_PERIOD; start++) {
      const page = fakePage(start);
      const seen: number[] = [];
      await atFixedJitterPhase(page, async () => {
        seen.push(page.state.frame % JITTER_PERIOD);
      });
      expect(seen, `start ${start}`).toEqual([JITTER_PHASE]);
      expect(page.state.held).toBe(false);
      expect(page.state.steps).toBeGreaterThanOrEqual(MIN_STEPS);
    }
  });

  it("runs the exposure's five seconds of the gate's clock first on a metered frame", async () => {
    expect(SETTLE_STEPS).toBe(150);
    for (let start = 0; start < JITTER_PERIOD; start++) {
      const page = fakePage(start);
      let frame = -1;
      await atFixedJitterPhase(
        page,
        async () => {
          frame = page.state.frame;
        },
        { minSteps: SETTLE_STEPS },
      );
      expect(page.state.steps, `start ${start}`).toBeGreaterThanOrEqual(SETTLE_STEPS);
      expect(frame % JITTER_PERIOD).toBe(JITTER_PHASE);
    }
  });

  it("lands when a step draws two frames, so a count of steps would drift", async () => {
    for (let start = 0; start < JITTER_PERIOD; start++) {
      const page = fakePage(start, { drawsPerStep: 2 });
      let frame = -1;
      await atFixedJitterPhase(page, async () => {
        frame = page.state.frame;
      });
      expect(frame % JITTER_PERIOD, `start ${start}`).toBe(JITTER_PHASE);
    }
  });

  it("repeats a step the engine declined instead of counting it", async () => {
    const page = fakePage(5, { declineFirst: 3 });
    let frame = -1;
    await atFixedJitterPhase(page, async () => {
      frame = page.state.frame;
    });
    expect(page.state.declined).toBe(3);
    expect(frame % JITTER_PERIOD).toBe(JITTER_PHASE);
  });

  it("hands the loop back when the screenshot throws", async () => {
    const page = fakePage(0);
    await expect(
      atFixedJitterPhase(page, async () => {
        throw new Error("no screenshot");
      }),
    ).rejects.toThrow("no screenshot");
    expect(page.state.held).toBe(false);
    expect(page.state.released).toBe(1);
  });

  it("fails closed when the loop never reaches the phase", async () => {
    const page = fakePage(7, { frozen: true });
    await expect(atFixedJitterPhase(page, async () => undefined)).rejects.toThrow(
      "TN_UNREAL_LOOK_JITTER_PHASE: the jitter never reached phase 0",
    );
    expect(page.state.steps).toBe(MIN_STEPS + 3 * JITTER_PERIOD);
    expect(page.state.held).toBe(false);
  });

  it("fails when the loop draws a frame while the screenshot is taken", async () => {
    const page = fakePage(0);
    await expect(
      atFixedJitterPhase(page, async () => {
        page.state.frame += 1;
      }),
    ).rejects.toThrow("the loop moved");
  });

  it("takes a page with no temporal pass as it is, with no steps", async () => {
    const page = fakePage(3, { active: false });
    let taken = false;
    await atFixedJitterPhase(page, async () => {
      taken = true;
    });
    expect(taken).toBe(true);
    expect(page.state.steps).toBe(0);
    expect(page.state.held).toBe(false);
  });

  it("keeps the old behaviour for a BEFORE arm: TN_UNREAL_LOOK_JITTER=free never holds the loop", async () => {
    process.env[JITTER_SWITCH] = "free";
    const page = fakePage(3);
    await atFixedJitterPhase(page, async () => undefined);
    expect(page.state.steps).toBe(0);
    expect(page.state.released).toBe(0);
  });
});

describe("a lost renderer is a failed capture", () => {
  it("names the facade's lost-renderer and device-error lines", () => {
    expect(
      RENDERER_LOST.test("TN_WASM_RENDERER_LOST: this renderer draws nothing after this call."),
    ).toBe(true);
    expect(
      RENDERER_LOST.test(
        "TN_WASM_DEVICE_ERROR: vkAllocateMemory failed with VK_ERROR_OUT_OF_DEVICE_MEMORY",
      ),
    ).toBe(true);
    expect(
      RENDERER_LOST.test(
        "TN_WASM_DEVICE_LOST: A valid external Instance reference no longer exists.",
      ),
    ).toBe(true);
    expect(RENDERER_LOST.test("TN_AUTO_EXPOSURE:{}")).toBe(false);
  });

  for (const name of ["capture-threenative.ts", "capture-gi-threenative.ts"])
    it(`${name} counts it as a page error`, () => {
      expect(
        readFileSync(path.join(import.meta.dirname, "../unreal-look", name), "utf8"),
      ).toContain("if (RENDERER_LOST.test(message.text())) errors.push(message.text());");
    });
});

describe("both captures take their stills through the phase gate", () => {
  const dir = path.join(import.meta.dirname, "../unreal-look");
  const source = (name: string) => readFileSync(path.join(dir, name), "utf8");

  for (const name of ["capture-threenative.ts", "capture-gi-threenative.ts"]) {
    it(`${name}: no still is written outside atFixedJitterPhase`, () => {
      const text = source(name);
      const shots = [...text.matchAll(/page\.screenshot\(/gu)];
      expect(shots.length).toBeGreaterThan(0);
      for (const shot of shots) {
        const before = text.slice(Math.max(0, (shot.index ?? 0) - 240), shot.index);
        expect(before, `${name} at ${shot.index}`).toContain("atFixedJitterPhase(");
      }
      expect(text).toContain("addInitScript(FRAME_GATE)");
      expect(text).toContain("minSteps: metered ? SETTLE_STEPS : MIN_STEPS");
    });
  }

  it("the gate hands the loop back and keeps the page clock continuous", () => {
    const gate = source("capture-motion-threenative.ts");
    expect(gate).toContain("gate.release = ");
    expect(gate).toContain("realNow() + gate.offset");
  });
});
