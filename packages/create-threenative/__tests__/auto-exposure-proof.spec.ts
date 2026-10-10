import { readFileSync } from "node:fs";
import { PerspectiveCamera, Scene } from "three";
import { describe, expect, it } from "vitest";
import { exposureSettings } from "../template-assets/exposure.js";
import { createFixedExposureRooms } from "./fixtures/auto-exposure/fixedRooms.js";
import { assertHistogramProbe } from "./fixtures/auto-exposure/histogramProof.js";
import {
  histogramCases,
  referenceClippedMean,
} from "./fixtures/auto-exposure/histogramReference.js";
import {
  assertDeterministicExposureBudget,
  assertExposureClock,
  assertExposureProof,
  exposureCutTiming,
  qualifyExposureCase,
} from "./fixtures/auto-exposure/proof.js";
import { qualifyExposureSnap } from "./fixtures/auto-exposure/snapProof.js";

function report() {
  return {
    pass: true,
    capture: { rendererKind: "webgpu", adapter: { architecture: "swiftshader" } },
    diagnostics: [] as { code: string }[],
    observations: {
      startup: { phase: "ready" },
      console: [
        {
          text: `TN_AUTO_EXPOSURE:${JSON.stringify({ measured: true, applied: true, luminance: 0.002, exposureStops: 6.5, targetStops: 6.6, settled: true })}`,
        },
      ],
    },
  };
}

function deterministicReport(settled = false) {
  const value = report();
  const warmupMeasurement = {
    measured: true,
    applied: true,
    luminance: 4,
    exposureStops: -4.5,
    targetStops: -4.5,
    settled: true,
  };
  const cut = {
    updates: 180,
    consumedSeconds: 3,
    realConsumedSeconds: 5,
    nodeTime: 8,
    nodeFrameId: 200,
    clock: "deterministic-per-render",
    ...warmupMeasurement,
  };
  value.observations.console = [
    { text: 'TN_EXPOSURE_CLOCK:{"mode":"fixed-step"}' },
    ...Array.from({ length: 180 }, (_, i) => {
      const sample = {
        ...cut,
        updates: i + 1,
        nodeFrameId: 21 + i,
        nodeTime: ((i + 1) * 8) / 180,
        consumedSeconds: (i + 1) / 60,
        realConsumedSeconds: ((i + 1) * 5) / 180,
        measurement: warmupMeasurement,
      };
      return [
        { text: `TN_AUTO_EXPOSURE:${JSON.stringify(warmupMeasurement)}` },
        { text: `TN_EXPOSURE_SAMPLE:${JSON.stringify(sample)}` },
      ];
    }).flat(),
    {
      text: `TN_EXPOSURE_WARMUP:${JSON.stringify({ ...cut, measurement: warmupMeasurement, elapsedMs: 1000 })}`,
    },
    { text: 'TN_EXPOSURE_READY:{"warmupComplete":true,"elapsedMs":1100}' },
    { text: `TN_EXPOSURE_CUT:${JSON.stringify(cut)}` },
    ...Array.from({ length: 180 }, (_, i) => {
      const measurement = {
        measured: true,
        applied: true,
        luminance: 0.002,
        exposureStops: settled ? 6.5 : 3,
        targetStops: 6.5,
        settled,
      };
      const timing = {
        ...cut,
        updates: 181 + i,
        consumedSeconds: 3 + (i + 1) / 60,
        realConsumedSeconds: 5 + (i + 1) / 30,
        nodeTime: 8 + (i + 1) / 20,
        nodeFrameId: 201 + i,
      };
      return [
        { text: `TN_EXPOSURE_TIMING:${JSON.stringify(timing)}` },
        { text: `TN_AUTO_EXPOSURE:${JSON.stringify(measurement)}` },
        { text: `TN_EXPOSURE_SAMPLE:${JSON.stringify({ ...timing, measurement })}` },
      ];
    }).flat(),
  ];
  return value;
}

const deterministicExpectation = {
  deterministic: true,
  applied: true,
  expectedLuminance: 0.002,
  cutStops: 11,
  reject: "TN_EXPOSURE_NOT_SETTLED",
};

describe("runtime exposure proof", () => {
  it.each(["repeated-frame", "live-clock", "jumped-time"] as const)(
    "rejects %s in the warmup sequence",
    (fault) => {
      const value = deterministicReport(true);
      const boundary = value.observations.console.findIndex(({ text }) =>
        text.startsWith("TN_EXPOSURE_WARMUP:"),
      );
      value.observations.console = value.observations.console.map(({ text }, index) => {
        if (index >= boundary || !text.startsWith("TN_EXPOSURE_SAMPLE:")) return { text };
        const sample = JSON.parse(text.slice(19));
        const overrides = {
          "repeated-frame": { nodeFrameId: 200 },
          "live-clock": { clock: "live" },
          "jumped-time": { consumedSeconds: sample.updates === 180 ? 3 : 0 },
        };
        return { text: `TN_EXPOSURE_SAMPLE:${JSON.stringify({ ...sample, ...overrides[fault] })}` };
      });
      expect(() =>
        qualifyExposureCase(value, { ...deterministicExpectation, reject: undefined }),
      ).toThrow(/warmup|FRAME_BUDGET/i);
    },
  );
  it.each(["nodeFrameId", "nodeTime", "realConsumedSeconds"] as const)(
    "binds the cut %s to the accepted warmup terminal",
    (field) => {
      const value = deterministicReport(true);
      const cut = value.observations.console.find(({ text }) =>
        text.startsWith("TN_EXPOSURE_CUT:"),
      );
      if (cut === undefined) throw new Error("cut missing");
      const parsed = JSON.parse(cut.text.slice(16));
      parsed[field] -= 1;
      cut.text = `TN_EXPOSURE_CUT:${JSON.stringify(parsed)}`;
      expect(() =>
        qualifyExposureCase(value, { ...deterministicExpectation, reject: undefined }),
      ).toThrow(/warmup/);
    },
  );
  it.each(["nodeTime", "realConsumedSeconds"] as const)(
    "binds the warmup marker %s to its accepted sample",
    (field) => {
      const value = deterministicReport(true);
      const marker = value.observations.console.find(({ text }) =>
        text.startsWith("TN_EXPOSURE_WARMUP:"),
      );
      if (marker === undefined) throw new Error("warmup missing");
      const parsed = JSON.parse(marker.text.slice(19));
      parsed[field] -= 1;
      marker.text = `TN_EXPOSURE_WARMUP:${JSON.stringify(parsed)}`;
      expect(() =>
        qualifyExposureCase(value, { ...deterministicExpectation, reject: undefined }),
      ).toThrow(/warmup/);
    },
  );
  it("requires actual warmup evidence before readiness, including an unexpired hold", () => {
    for (const mode of ["missing", "expired", "early-ready"] as const) {
      const value = deterministicReport(true);
      if (mode === "missing")
        value.observations.console = value.observations.console.filter(
          ({ text }) => !text.startsWith("TN_EXPOSURE_WARMUP:"),
        );
      if (mode === "expired")
        value.observations.console = value.observations.console.map(({ text }) =>
          text.startsWith("TN_EXPOSURE_WARMUP:")
            ? {
                text: `TN_EXPOSURE_WARMUP:${JSON.stringify({ ...JSON.parse(text.slice(19)), elapsedMs: 60_001 })}`,
              }
            : { text },
        );
      if (mode === "early-ready")
        value.observations.console = value.observations.console.map(({ text }) =>
          text.startsWith("TN_EXPOSURE_READY:")
            ? { text: 'TN_EXPOSURE_READY:{"warmupComplete":false}' }
            : { text },
        );
      expect(() =>
        qualifyExposureCase(value, { ...deterministicExpectation, reject: undefined }),
      ).toThrow(/warmup|readiness/i);
    }
  });
  it.each(["missing-sample", "stale", "order"] as const)("rejects %s warmup evidence", (fault) => {
    const value = deterministicReport(true);
    if (fault === "missing-sample") value.observations.console.splice(1, 2);
    if (fault === "stale") {
      const warmup = value.observations.console.find(({ text }) =>
        text.startsWith("TN_EXPOSURE_WARMUP:"),
      );
      if (warmup === undefined) throw new Error("warmup missing");
      const parsed = JSON.parse(warmup.text.slice(19));
      warmup.text = `TN_EXPOSURE_WARMUP:${JSON.stringify({ ...parsed, measurement: { ...parsed.measurement, exposureStops: 99 } })}`;
    }
    if (fault === "order") {
      const index = value.observations.console.findIndex(({ text }) =>
        text.startsWith("TN_EXPOSURE_READY:"),
      );
      const [ready] = value.observations.console.splice(index, 1);
      if (ready === undefined) throw new Error("ready missing");
      value.observations.console.unshift(ready);
    }
    expect(() =>
      qualifyExposureCase(value, { ...deterministicExpectation, reject: undefined }),
    ).toThrow(/warmup|readiness/i);
  });
  it("keeps the deterministic bridge clock distinct from the live-clock arm", () => {
    const value = deterministicReport(true);
    const expectation = { ...deterministicExpectation, reject: undefined };
    expect(qualifyExposureCase(value, expectation)).toMatchObject({
      measurement: { settled: true },
    });
    value.observations.console[0] = { text: 'TN_EXPOSURE_CLOCK:{"mode":"wall-clock"}' };
    expect(() => qualifyExposureCase(value, expectation)).toThrow(/TN_EXPOSURE_WRONG_CLOCK/);
  });
  it("requires a valid terminal observation before accepting the settlement mutation", () => {
    expect(qualifyExposureCase(deterministicReport(), deterministicExpectation)).toMatchObject({
      expectedFailure: expect.stringContaining("TN_EXPOSURE_NOT_SETTLED:"),
    });
    for (const changes of [
      { measured: false },
      { applied: false },
      { luminance: 99 },
      { targetStops: -4.5 },
    ]) {
      const value = deterministicReport();
      value.observations.console = value.observations.console.map(({ text }) => {
        if (text.startsWith("TN_AUTO_EXPOSURE:"))
          return {
            text: `TN_AUTO_EXPOSURE:${JSON.stringify({ ...JSON.parse(text.slice(17)), ...changes })}`,
          };
        if (text.startsWith("TN_EXPOSURE_SAMPLE:")) {
          const sample = JSON.parse(text.slice(19));
          return {
            text: `TN_EXPOSURE_SAMPLE:${JSON.stringify({ ...sample, measurement: { ...sample.measurement, ...changes } })}`,
          };
        }
        return { text };
      });
      expect(() => qualifyExposureCase(value, deterministicExpectation)).toThrow();
    }
  });
  it("rejects sample stamps without accepted exposure observations in a negative arm", () => {
    const value = deterministicReport();
    value.observations.console = value.observations.console.filter(
      ({ text }) => !text.startsWith("TN_AUTO_EXPOSURE:"),
    );
    expect(() => qualifyExposureCase(value, deterministicExpectation)).toThrow(
      /paired|measurement/i,
    );
  });
  it("requires the terminal accepted observation even if an early sample was settled", () => {
    const value = deterministicReport(true);
    const expectation = { ...deterministicExpectation, reject: undefined };
    expect(qualifyExposureCase(value, expectation)).toMatchObject({
      measurement: { settled: true },
    });
    value.observations.console.splice(-2, 1);
    expect(() => qualifyExposureCase(value, expectation)).toThrow(/paired|terminal/i);
  });
  it("rejects an unpaired or stale terminal sample observation", () => {
    for (const changes of [{ exposureStops: 99 }, { targetStops: -4.5 }]) {
      const value = deterministicReport(true);
      const last = value.observations.console.at(-1);
      if (last === undefined) throw new Error("terminal missing");
      const sample = JSON.parse(last.text.slice(19));
      last.text = `TN_EXPOSURE_SAMPLE:${JSON.stringify({ ...sample, measurement: { ...sample.measurement, ...changes } })}`;
      expect(() =>
        qualifyExposureCase(value, { ...deterministicExpectation, reject: undefined }),
      ).toThrow(/paired|terminal/i);
    }
  });
  it("requires the fixed warmup and terminal update identities, not a shifted 180-sample window", () => {
    const value = deterministicReport(true);
    value.observations.console = value.observations.console.map(({ text }) => {
      const prefix = ["TN_EXPOSURE_CUT:", "TN_EXPOSURE_TIMING:", "TN_EXPOSURE_SAMPLE:"].find(
        (prefix) => text.startsWith(prefix),
      );
      if (prefix === undefined) return { text };
      const observation = JSON.parse(text.slice(prefix.length));
      return {
        text: `${prefix}${JSON.stringify({ ...observation, updates: observation.updates + 1 })}`,
      };
    });
    expect(() => assertDeterministicExposureBudget(value)).toThrow(/warmup|terminal/i);
  });
  it("refuses a clock mutation accompanied by an unrelated missing measurement", () => {
    const value = report();
    value.observations.console = [{ text: 'TN_EXPOSURE_CLOCK:{"mode":"fixed-step"}' }];
    expect(() =>
      qualifyExposureCase(value, {
        applied: true,
        expectedLuminance: 0.002,
        reject: "TN_EXPOSURE_WRONG_CLOCK",
      }),
    ).toThrow(/TN_EXPOSURE_MEASUREMENT_MISSING/);
  });
  it("requires the same 180 completed GPU readbacks under the declared render clock", () => {
    const value = deterministicReport(true);
    expect(assertDeterministicExposureBudget(value).renderedUpdates).toBe(180);
    const terminal = value.observations.console.at(-1);
    if (terminal === undefined) throw new Error("fixture samples missing");
    const sample = JSON.parse(terminal.text.slice(19));
    terminal.text = `TN_EXPOSURE_SAMPLE:${JSON.stringify({ ...sample, updates: 359 })}`;
    expect(() => assertDeterministicExposureBudget(value)).toThrow(/Mismatched GPU updates/);
    terminal.text = `TN_EXPOSURE_SAMPLE:${JSON.stringify(sample)}`;
    value.observations.console.splice(-3);
    expect(() => assertDeterministicExposureBudget(value)).toThrow(/TN_EXPOSURE_FRAME_BUDGET/);
    const cut = value.observations.console.find(({ text }) => text.startsWith("TN_EXPOSURE_CUT:"));
    if (cut === undefined) throw new Error("cut missing");
    cut.text = cut.text.replace("deterministic-per-render", "live");
    expect(() => assertDeterministicExposureBudget(value)).toThrow(/clock provenance/);
  });
  it("accepts only the named mutation failure after clean runtime proof", () => {
    const value = report();
    value.observations.console = [{ text: 'TN_EXPOSURE_CLOCK:{"mode":"wall-clock"}' }];
    expect(
      qualifyExposureCase(value, {
        applied: false,
        expectedLuminance: 0.002,
        reject: "TN_EXPOSURE_MEASUREMENT_MISSING",
      }),
    ).toEqual({
      expectedFailure: "TN_EXPOSURE_MEASUREMENT_MISSING: GPU exposure observation missing.",
    });
    value.pass = false;
    value.diagnostics.push({ code: "TN_BROWSER_CONSOLE_ERROR" });
    expect(() =>
      qualifyExposureCase(value, {
        applied: false,
        expectedLuminance: 0.002,
        reject: "TN_EXPOSURE_MEASUREMENT_MISSING",
      }),
    ).toThrow(/scenario failed/);
  });
  it("refuses an unrelated negative-arm failure and a mutation that unexpectedly passes", () => {
    const value = report();
    value.observations.console.push({ text: 'TN_EXPOSURE_CLOCK:{"mode":"wall-clock"}' });
    expect(() =>
      qualifyExposureCase(value, {
        applied: true,
        expectedLuminance: 0.002,
        reject: "TN_EXPOSURE_METER_RANGE",
      }),
    ).toThrow(/unexpectedly passed/);
    expect(() =>
      qualifyExposureCase(value, {
        applied: false,
        expectedLuminance: 0.001,
        reject: "TN_EXPOSURE_METER_RANGE",
      }),
    ).toThrow(/measurement failed/);
  });
  it("rejects the real bridge reporting simulated ticks as the render clock", () => {
    const value = report();
    value.observations.console.push({ text: 'TN_EXPOSURE_CLOCK:{"mode":"fixed-step"}' });
    expect(() => assertExposureClock(value)).toThrow(/TN_EXPOSURE_WRONG_CLOCK/);
    value.observations.console.push({ text: 'TN_EXPOSURE_CLOCK:{"mode":"wall-clock"}' });
    expect(() => assertExposureClock(value)).not.toThrow();
  });
  it("rejects a missing observed render clock", () => {
    expect(() => assertExposureClock(report())).toThrow(/TN_EXPOSURE_CLOCK_MISSING/);
  });
  it("rejects a doubled meter even if its adaptation claims to be settled", () => {
    expect(() => assertExposureProof(report(), true, 0.001)).toThrow(/TN_EXPOSURE_METER_RANGE/);
    expect(() => assertExposureProof(report(), true, 0.002)).not.toThrow();
  });
  it("counts actual GPU updates to the first settled new target and reports consumed time", () => {
    const value = report();
    value.observations.console = [
      {
        text: 'TN_EXPOSURE_CUT:{"updates":30,"consumedSeconds":2,"targetStops":6.5,"settled":true}',
      },
      { text: 'TN_AUTO_EXPOSURE:{"targetStops":6.5,"settled":true}' },
      { text: 'TN_EXPOSURE_TIMING:{"updates":47,"consumedSeconds":3.1}' },
      { text: 'TN_AUTO_EXPOSURE:{"targetStops":-4.5,"settled":true}' },
    ];
    expect(exposureCutTiming(value, 11, 180)).toEqual({
      renderedUpdates: 17,
      consumedSeconds: 1.1,
    });
  });
  it("rejects a stale settled readback from before the cut", () => {
    const value = report();
    value.observations.console = [
      {
        text: 'TN_EXPOSURE_CUT:{"updates":30,"consumedSeconds":2,"targetStops":6.5,"settled":true}',
      },
      { text: 'TN_EXPOSURE_TIMING:{"updates":47,"consumedSeconds":3.1}' },
      { text: 'TN_AUTO_EXPOSURE:{"targetStops":6.5,"settled":true}' },
    ];
    expect(() => exposureCutTiming(value, 11, 180)).toThrow(/did not settle.*17.*1.1/);
  });
  it("rejects settling after the authored rendered-frame budget", () => {
    const value = report();
    value.observations.console = [
      {
        text: 'TN_EXPOSURE_CUT:{"updates":30,"consumedSeconds":2,"targetStops":6.5,"settled":true}',
      },
      { text: 'TN_EXPOSURE_TIMING:{"updates":211,"consumedSeconds":5}' },
      { text: 'TN_AUTO_EXPOSURE:{"targetStops":-4.5,"settled":true}' },
    ];
    expect(() => exposureCutTiming(value, 11, 180)).toThrow(/181.*180/);
  });
  it("owns its favicon without an unrequested missing /favicon.ico request", () => {
    const html = readFileSync(
      new URL("./fixtures/auto-exposure/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain('<link rel="icon" href="data:,">');
  });
  it("accepts a settled, observed GPU measurement with declared software provenance", () => {
    expect(assertExposureProof(report(), true).exposureStops).toBe(6.5);
  });
  it("rejects software device loss even when the runner passes its downgraded warning", () => {
    const value = report();
    value.diagnostics.push({ code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" });
    expect(() => assertExposureProof(value, true)).toThrow(/device loss/i);
  });
  it("rejects failed unrelated diagnostics instead of accepting the visible frame", () => {
    const value = report();
    value.pass = false;
    value.diagnostics.push({ code: "TN_BROWSER_CONSOLE_ERROR" });
    expect(() => assertExposureProof(value, true)).toThrow(/failed/i);
  });
  it("rejects missing adapter provenance", () => {
    const value = report();
    value.capture.adapter.architecture = "";
    expect(() => assertExposureProof(value, true)).toThrow(/provenance/i);
  });
  it("rejects missing exposure measurement", () => {
    const value = report();
    value.observations.console = [];
    expect(() => assertExposureProof(value, true)).toThrow(/missing/i);
  });
  it("rejects a disabled graph that claims adaptation was applied", () => {
    expect(() => assertExposureProof(report(), false)).toThrow(/measurement/i);
  });
});

describe("approved first-update snap acceptance", () => {
  function snapReport(errorStops: number) {
    const value = deterministicReport(true);
    const rooms = createFixedExposureRooms(
      new Scene(),
      new PerspectiveCamera(48, 16 / 9, 0.1, 100),
      11,
    );
    rooms.setPose(true);
    const before = rooms.snapshot();
    rooms.setPose(false);
    const after = rooms.snapshot();
    rooms.dispose();
    let postCut = false;
    value.observations.console = value.observations.console.map(({ text }) => {
      const separator = text.indexOf(":");
      const kind = text.slice(0, separator);
      const data = JSON.parse(text.slice(separator + 1));
      if (kind === "TN_EXPOSURE_CUT") {
        data.cameraCut = { before, after };
        postCut = true;
      }
      if (kind === "TN_EXPOSURE_SAMPLE") data.cameraPose = postCut ? after : before;
      if (kind === "TN_EXPOSURE_SAMPLE" || kind === "TN_EXPOSURE_TIMING")
        data.deltaSeconds = 1 / 60;
      return { text: `${kind}:${JSON.stringify(data)}` };
    });
    const firstIndex = value.observations.console.findIndex(
      ({ text }) =>
        text.startsWith("TN_EXPOSURE_SAMPLE:") && JSON.parse(text.slice(19)).updates === 181,
    );
    for (const index of [firstIndex - 1, firstIndex]) {
      const entry = value.observations.console[index];
      if (entry === undefined) throw new Error("First snap pair missing.");
      const separator = entry.text.indexOf(":");
      const data = JSON.parse(entry.text.slice(separator + 1));
      const measurement = data.measurement ?? data;
      measurement.exposureStops = measurement.targetStops - errorStops;
      measurement.settled = errorStops <= 0.25;
      entry.text = `${entry.text.slice(0, separator)}:${JSON.stringify(data)}`;
    }
    return value;
  }
  it("uses the same accuracy gate for the positive and zero-gain arms", () => {
    expect(qualifyExposureSnap(snapReport(0.1), 1).errorStops).toBeCloseTo(0.1);
    expect(qualifyExposureSnap(snapReport(10), 0).expectedFailure).toContain(
      "TN_EXPOSURE_SNAP_RESPONSE_MISSING",
    );
    expect(() => qualifyExposureSnap(snapReport(10), 1)).toThrow(
      "TN_EXPOSURE_SNAP_RESPONSE_MISSING",
    );
    expect(() => qualifyExposureSnap(snapReport(0.1), 0)).toThrow("unexpectedly met");
  });
  it.each([undefined, 0, 1 / 30, Number.NaN])(
    "rejects an undeclared first-update delta %s",
    (delta) => {
      const value = snapReport(0.1);
      const entry = value.observations.console.find(
        ({ text }) =>
          text.startsWith("TN_EXPOSURE_SAMPLE:") && JSON.parse(text.slice(19)).updates === 181,
      );
      if (entry === undefined) throw new Error("First snap sample missing.");
      const data = JSON.parse(entry.text.slice(19));
      data.deltaSeconds = delta;
      entry.text = `TN_EXPOSURE_SAMPLE:${JSON.stringify(data)}`;
      expect(() => qualifyExposureSnap(value, 1)).toThrow(/first paired sample/);
    },
  );
});

describe("histogram probe qualification", () => {
  const reference = () =>
    histogramCases.map(({ name, bins, lowPercent, highPercent }) => {
      const { logMean, kept } = referenceClippedMean(bins, lowPercent, highPercent);
      const goal = Math.min(
        exposureSettings.maxStops,
        Math.max(exposureSettings.minStops, Math.log2(exposureSettings.key) - logMean),
      );
      return kept > 0 ? { name, luminance: 2 ** logMean, goal } : { name, luminance: -1, goal: 0 };
    });
  const lines = (values: unknown) => [{ text: `TN_EXPOSURE_HISTOGRAM:${JSON.stringify(values)}` }];
  it("accepts values that match the CPU reference", () => {
    expect(assertHistogramProbe(lines(reference()))).toBe(histogramCases.length);
  });
  it("rejects a bright tail that moved the mean", () => {
    const wrong = reference().map((item) =>
      item.name === "bright-tail-clipped" ? { ...item, luminance: item.luminance * 1.5 } : item,
    );
    expect(() => assertHistogramProbe(lines(wrong))).toThrow(/bright-tail-clipped/);
  });
  it("rejects a metered luminance for an empty clip, and a missing marker", () => {
    const wrong = reference().map((item) =>
      item.name === "empty" ? { ...item, luminance: 0.5 } : item,
    );
    expect(() => assertHistogramProbe(lines(wrong))).toThrow(/kept no weight/);
    expect(() => assertHistogramProbe([])).toThrow(/TN_HISTOGRAM_MISSING/);
  });
});
