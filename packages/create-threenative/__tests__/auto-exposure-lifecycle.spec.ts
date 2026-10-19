import { expect, it } from "vitest";
import { qualifyExposureLifecycle } from "./fixtures/auto-exposure/lifecycleProof.js";

function report() {
  const entries: { text: string }[] = [];
  const emit = (name: string, value: unknown) =>
    entries.push({ text: `${name}:${JSON.stringify(value)}` });
  emit("TN_EXPOSURE_CLOCK", { mode: "fixed-step" });
  emit("TN_EXPOSURE_SETUP", { setupCount: 1, updates: 0 });
  for (let updates = 1; updates <= 720; updates++) {
    const timing = {
      updates,
      consumedSeconds: updates / 60,
      realConsumedSeconds: updates / 60,
      nodeFrameId: updates * 2,
      nodeTime: updates / 30,
      clock: "deterministic-per-render",
      deltaSeconds: 1 / 60,
      width: updates <= 360 ? 640 : 320,
      height: updates <= 360 ? 360 : 180,
      setupCount: updates <= 180 ? 1 : 2,
    };
    const goal = updates <= 540 ? -4.4355 : 6.5519;
    const measurement = {
      measured: true,
      applied: true,
      luminance: updates <= 540 ? 3.895 : 0.001918,
      exposureStops: goal,
      targetStops: goal,
      settled: true,
    };
    emit("TN_EXPOSURE_TIMING", timing);
    emit("TN_AUTO_EXPOSURE", measurement);
    emit("TN_EXPOSURE_SAMPLE", { ...timing, measurement });
    if (updates === 180) {
      emit("TN_EXPOSURE_REBUILD", timing);
      emit("TN_EXPOSURE_SETUP", { updates, setupCount: 2 });
    }
    if (updates === 360) emit("TN_EXPOSURE_RESIZE", timing);
    if (updates === 540) emit("TN_EXPOSURE_RESET_CUT", timing);
  }
  return {
    pass: true,
    diagnostics: [],
    capture: { rendererKind: "webgpu", adapter: { vendor: "nvidia" } },
    observations: { console: entries },
  };
}
it("requires all actual lifecycle operations and 720 paired completed samples", () => {
  expect(qualifyExposureLifecycle(report()).updates).toBe(720);
});
for (const marker of ["REBUILD", "RESIZE", "RESET_CUT"])
  it(`rejects a missing ${marker} operation`, () => {
    const input = report();
    input.observations.console = input.observations.console.filter(
      ({ text }) => !text.startsWith(`TN_EXPOSURE_${marker}:`),
    );
    expect(() => qualifyExposureLifecycle(input)).toThrow();
  });
for (const field of [
  "deltaSeconds",
  "consumedSeconds",
  "realConsumedSeconds",
  "nodeFrameId",
  "nodeTime",
  "setupCount",
  "width",
  "height",
])
  it(`rejects missing ${field} provenance`, () => {
    const input = report();
    for (const entry of input.observations.console)
      if (
        entry.text.startsWith("TN_EXPOSURE_SAMPLE:") ||
        entry.text.startsWith("TN_EXPOSURE_TIMING:")
      ) {
        const split = entry.text.indexOf(":");
        const value = JSON.parse(entry.text.slice(split + 1));
        delete value[field];
        entry.text = `${entry.text.slice(0, split + 1)}${JSON.stringify(value)}`;
      }
    expect(() => qualifyExposureLifecycle(input)).toThrow();
  });
for (const mode of ["rebuild", "resize", "reset", "null", "truthy"])
  it(`rejects a ${mode} history/measurement mutation`, () => {
    const input = report();
    for (const entry of input.observations.console) {
      const split = entry.text.indexOf(":");
      const value = JSON.parse(entry.text.slice(split + 1));
      if (mode === "rebuild" && "setupCount" in value) value.setupCount = 1;
      if (mode === "resize" && "width" in value) {
        value.width = 640;
        value.height = 360;
      }
      if (
        mode === "reset" &&
        (value.updates === 541 || entry.text.startsWith("TN_AUTO_EXPOSURE:"))
      ) {
        if (value.measurement) value.measurement.exposureStops = -4.4355;
        else if (value.targetStops === 6.5519) value.exposureStops = -4.4355;
      }
      if (mode === "null") {
        if (value.measurement) value.measurement.exposureStops = null;
        else if ("exposureStops" in value) value.exposureStops = null;
      }
      if (mode === "truthy") {
        if (value.measurement) value.measurement.settled = 1;
        else if ("settled" in value) value.settled = 1;
      }
      entry.text = `${entry.text.slice(0, split + 1)}${JSON.stringify(value)}`;
    }
    expect(() => qualifyExposureLifecycle(input)).toThrow();
  });
it("rejects stale progress that omits a complete lifecycle phase", () => {
  const input = report();
  let updates = 0;
  input.observations.console = input.observations.console.filter(({ text }) => {
    if (text.startsWith("TN_EXPOSURE_TIMING:"))
      updates = JSON.parse(text.slice("TN_EXPOSURE_TIMING:".length)).updates;
    if (
      ["TN_EXPOSURE_TIMING:", "TN_AUTO_EXPOSURE:", "TN_EXPOSURE_SAMPLE:"].some((prefix) =>
        text.startsWith(prefix),
      )
    )
      return updates <= 360 || updates > 540;
    return true;
  });
  expect(() => qualifyExposureLifecycle(input)).toThrow(/720/);
});
