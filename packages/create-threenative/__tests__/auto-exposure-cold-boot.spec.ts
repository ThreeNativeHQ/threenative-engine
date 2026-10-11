import { describe, expect, it } from "vitest";
import { qualifyColdBoot, qualifyColdBootSpread } from "./fixtures/auto-exposure/coldBootProof.js";

function report() {
  const measurement = {
    measured: true,
    applied: true,
    luminance: 3.0578835010528564,
    exposureStops: -4.2,
    targetStops: -4.436,
    settled: true,
  };
  const samples = [1, 2, 3].map((updates) => ({
    updates,
    consumedSeconds: updates * 0.07,
    realConsumedSeconds: updates * 0.07,
    nodeFrameId: updates * 2 + 6,
    nodeTime: updates * 0.08,
    deltaSeconds: 0.07,
    clock: "live",
    measurement,
  }));
  return {
    pass: true,
    capture: { rendererKind: "webgpu", adapter: { device: "test" } },
    diagnostics: [],
    observations: {
      startup: { phase: "ready" },
      console: [
        { text: 'TN_EXPOSURE_CLOCK:{"mode":"fixed-step"}' },
        ...samples.flatMap((sample) => [
          { text: `TN_EXPOSURE_TIMING:${JSON.stringify(sample)}` },
          { text: `TN_AUTO_EXPOSURE:${JSON.stringify(measurement)}` },
          { text: `TN_EXPOSURE_SAMPLE:${JSON.stringify(sample)}` },
          ...(sample.updates === 1
            ? [
                {
                  text: `TN_EXPOSURE_BOOT_READY:${JSON.stringify({ ...sample, sampleFrames: 1, cutSampleFrames: 0 })}`,
                },
              ]
            : []),
        ]),
        { text: `TN_EXPOSURE_BOOT_FROZEN:${JSON.stringify(samples[2])}` },
      ],
      tone: [{ code: "TN_TONE", label: "tone-0", atStep: "boot", p99: 168 }],
    },
  };
}

describe("cold-boot exposure proof", () => {
  it("uses shared named-frame tone after exactly three accepted live-clock samples", () => {
    expect(qualifyColdBoot(report())).toMatchObject({
      p99: 168,
      updates: 3,
      consumedSeconds: 3 * 0.07,
      readiness: { sampleFrames: 1 },
    });
  });
  function entry(value: ReturnType<typeof report>, prefix: string, at = 0) {
    const found = value.observations.console.filter(({ text }) => text.startsWith(prefix))[at];
    if (found === undefined) throw new Error(`Test fixture missing ${prefix}`);
    return found;
  }
  function remove(value: ReturnType<typeof report>, prefix: string) {
    const entries = value.observations.console;
    entries.splice(entries.indexOf(entry(value, prefix)), 1);
  }
  function changeSample(value: ReturnType<typeof report>, key: string, replacement: unknown) {
    const found = entry(value, "TN_EXPOSURE_SAMPLE:", 1);
    found.text = `TN_EXPOSURE_SAMPLE:${JSON.stringify({ ...JSON.parse(found.text.slice(19)), [key]: replacement })}`;
  }
  const initialTiming = {
    updates: 0,
    consumedSeconds: 0,
    realConsumedSeconds: 0,
    nodeFrameId: 0,
    nodeTime: 0,
    deltaSeconds: 0,
    clock: "live",
    sampleFrames: 0,
    cutSampleFrames: 0,
  };
  function readyBeforeRendering(value: ReturnType<typeof report>, timing: Record<string, unknown>) {
    remove(value, "TN_EXPOSURE_BOOT_READY:");
    value.observations.console.unshift({
      text: `TN_EXPOSURE_BOOT_READY:${JSON.stringify(timing)}`,
    });
  }
  function changeTiming(
    value: ReturnType<typeof report>,
    change: (timing: Record<string, number>) => void,
  ) {
    for (const row of value.observations.console) {
      if (!/^TN_EXPOSURE_(TIMING|SAMPLE|BOOT_READY|BOOT_FROZEN):/.test(row.text)) continue;
      const colon = row.text.indexOf(":");
      const timing = JSON.parse(row.text.slice(colon + 1));
      change(timing);
      row.text = `${row.text.slice(0, colon + 1)}${JSON.stringify(timing)}`;
    }
  }
  it("accepts readiness before rendering only at the exact initial timing state", () => {
    const value = report();
    readyBeforeRendering(value, initialTiming);
    expect(qualifyColdBoot(value).readiness).toEqual(initialTiming);
  });
  it.each([
    ["all ages missing", { updates: 0, sampleFrames: 0, cutSampleFrames: 0, clock: "live" }],
    ["consumed time", { ...initialTiming, consumedSeconds: 99 }],
    ["real consumed time", { ...initialTiming, realConsumedSeconds: -1 }],
    ["frame id", { ...initialTiming, nodeFrameId: -17 }],
    ["node time", { ...initialTiming, nodeTime: "nonsense" }],
    ["delta", { ...initialTiming, deltaSeconds: null }],
  ])("rejects zero-update readiness with %s", (_name, timing) => {
    const value = report();
    readyBeforeRendering(value, timing as Record<string, unknown>);
    expect(() => qualifyColdBoot(value)).toThrow();
  });
  it.each(["short-total", "short-interval", "consecutive-gap"])(
    "rejects inconsistent NodeFrame chronology: %s",
    (kind) => {
      const value = report();
      changeTiming(value, (timing) => {
        const updates = timing.updates ?? 0;
        if (kind === "short-total") timing.nodeTime = updates * 0.001;
        if (kind === "short-interval")
          timing.nodeTime = updates === 1 ? 0.08 : 0.08 + (updates - 1) * 0.001;
        if (kind === "consecutive-gap") timing.nodeFrameId = updates + 7;
      });
      expect(() => qualifyColdBoot(value)).toThrow();
    },
  );
  it("accepts consecutive frames with roundoff and skipped frames with elapsed headroom", () => {
    const value = report();
    changeTiming(value, (timing) => {
      const updates = timing.updates ?? 0;
      timing.nodeFrameId = updates;
      timing.nodeTime = updates * 0.07 - 1e-12;
    });
    expect(qualifyColdBoot(value).updates).toBe(3);
    expect(qualifyColdBoot(report()).updates).toBe(3);
  });
  it.each(["fixed-step", "wall-clock"])("rejects an extra earlier %s bridge marker", (mode) => {
    const value = report();
    value.observations.console.unshift({ text: `TN_EXPOSURE_CLOCK:${JSON.stringify({ mode })}` });
    expect(() => qualifyColdBoot(value)).toThrow();
  });
  function moveRelative(
    value: ReturnType<typeof report>,
    moving: { text: string },
    target: { text: string },
    after: boolean,
  ) {
    const rows = value.observations.console;
    rows.splice(rows.indexOf(moving), 1);
    rows.splice(rows.indexOf(target) + Number(after), 0, moving);
  }
  it.each([
    "sample-before-timing",
    "acceptance-before-timing",
    "next-timing-before-sample",
    "next-timing-before-acceptance",
    "impossible-readiness",
  ])("rejects impossible event order: %s", (kind) => {
    const value = report();
    readyBeforeRendering(value, initialTiming);
    const firstTiming = entry(value, "TN_EXPOSURE_TIMING:");
    const firstSample = entry(value, "TN_EXPOSURE_SAMPLE:");
    const firstAccepted = entry(value, "TN_AUTO_EXPOSURE:");
    if (kind === "sample-before-timing") moveRelative(value, firstTiming, firstSample, true);
    if (kind === "acceptance-before-timing") moveRelative(value, firstTiming, firstAccepted, true);
    if (kind === "next-timing-before-sample")
      moveRelative(value, entry(value, "TN_EXPOSURE_TIMING:", 1), firstSample, false);
    if (kind === "next-timing-before-acceptance")
      moveRelative(value, entry(value, "TN_EXPOSURE_TIMING:", 1), firstAccepted, false);
    if (kind === "impossible-readiness") {
      const ready = entry(value, "TN_EXPOSURE_BOOT_READY:");
      ready.text = `TN_EXPOSURE_BOOT_READY:${JSON.stringify({ ...initialTiming, sampleFrames: 1 })}`;
      moveRelative(value, ready, firstSample, true);
      moveRelative(value, firstTiming, ready, true);
    }
    expect(() => qualifyColdBoot(value)).toThrow();
  });
  it.each(
    [1, 2, 3].flatMap((update) =>
      ["timing", "accepted", "sample"].map((after) => ({ update, after })),
    ),
  )("accepts readiness after update $update's $after marker", ({ update, after }) => {
    const value = report();
    const timing = JSON.parse(
      entry(value, "TN_EXPOSURE_TIMING:", update - 1).text.slice("TN_EXPOSURE_TIMING:".length),
    );
    const ready = entry(value, "TN_EXPOSURE_BOOT_READY:");
    ready.text = `TN_EXPOSURE_BOOT_READY:${JSON.stringify({ ...timing, sampleFrames: after === "sample" ? update : update - 1, cutSampleFrames: 0 })}`;
    const prefix =
      after === "timing"
        ? "TN_EXPOSURE_TIMING:"
        : after === "accepted"
          ? "TN_AUTO_EXPOSURE:"
          : "TN_EXPOSURE_SAMPLE:";
    moveRelative(value, ready, entry(value, prefix, update - 1), true);
    expect(qualifyColdBoot(value).readiness.sampleFrames).toBe(
      after === "sample" ? update : update - 1,
    );
  });
  const corruptions: Record<string, (value: ReturnType<typeof report>) => void> = {
    missing: (value) => remove(value, "TN_EXPOSURE_SAMPLE:"),
    duplicate: (value) => value.observations.console.push(entry(value, "TN_EXPOSURE_SAMPLE:")),
    "synthetic-clock": (value) => changeSample(value, "clock", "deterministic-per-render"),
    "stale-frame": (value) => changeSample(value, "nodeFrameId", 8),
    "time-jump": (value) => changeSample(value, "consumedSeconds", 99),
    "not-frozen": (value) => remove(value, "TN_EXPOSURE_BOOT_FROZEN:"),
    "wrong-freeze": (value) => {
      entry(value, "TN_EXPOSURE_BOOT_FROZEN:").text = 'TN_EXPOSURE_BOOT_FROZEN:{"updates":3}';
    },
    "bad-ready": (value) => {
      entry(value, "TN_EXPOSURE_BOOT_READY:").text =
        'TN_EXPOSURE_BOOT_READY:{"updates":99,"sampleFrames":99}';
    },
    "extra-update": (value) =>
      value.observations.console.push({ text: 'TN_EXPOSURE_TIMING:{"updates":4}' }),
    "warmup-hold": (value) => value.observations.console.push({ text: "TN_EXPOSURE_WARMUP:{}" }),
    "wrong-meter": (value) => {
      for (const row of value.observations.console)
        row.text = row.text.replaceAll("3.0578835010528564", "99");
    },
    unpaired: (value) => remove(value, "TN_AUTO_EXPOSURE:"),
    "device-loss": (value) =>
      Object.assign(value, { diagnostics: [{ code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" }] }),
    "no-tone": (value) => {
      value.observations.tone = [];
    },
  };
  it.each(Object.entries(corruptions))("rejects %s evidence", (_name, corrupt) => {
    const value = report();
    corrupt(value);
    expect(() => qualifyColdBoot(value)).toThrow();
  });
  it("requires exactly ten launches and the predeclared ten-percent band", () => {
    expect(
      qualifyColdBootSpread(
        Array.from({ length: 10 }, (_, index) => ({ launch: index, p99: 100 + index })),
      ),
    ).toMatchObject({ pass: true, spread: 0.09 });
    expect(
      qualifyColdBootSpread(
        Array.from({ length: 10 }, (_, index) => ({ launch: index, p99: 100 + index * 2 })),
      ),
    ).toMatchObject({ pass: false, spread: 0.18 });
    expect(() => qualifyColdBootSpread([{ launch: 0, p99: 100 }])).toThrow();
    expect(() =>
      qualifyColdBootSpread(Array.from({ length: 10 }, () => ({ launch: 0, p99: 100 }))),
    ).toThrow();
    expect(() =>
      qualifyColdBootSpread(Array.from({ length: 10 }, (_, launch) => ({ launch, p99: 0 }))),
    ).toThrow();
  });
});
