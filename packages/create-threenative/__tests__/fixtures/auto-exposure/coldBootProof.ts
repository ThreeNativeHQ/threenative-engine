import { exposureSettings } from "../../../template-assets/exposure.js";
import {
  assertExposureClock,
  assertExposureProof,
  assertExposureRuntime,
  pairedExposureSamples,
} from "./proof.js";

type ColdBootReport = Parameters<typeof assertExposureRuntime>[0] & {
  observations?: { tone?: readonly { code: string; atStep?: string; p99?: number }[] };
};
const timingFields = [
  "updates",
  "consumedSeconds",
  "realConsumedSeconds",
  "nodeTime",
  "nodeFrameId",
  "deltaSeconds",
  "clock",
] as const;

function marker(entries: readonly { text: string }[], prefix: string) {
  const matches = entries.filter(({ text }) => text.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`Cold boot needs exactly one ${prefix} marker.`);
  const entry = matches[0];
  if (entry === undefined) throw new Error("Cold-boot marker missing.");
  return { value: JSON.parse(entry.text.slice(prefix.length)), index: entries.indexOf(entry) };
}

const initialTiming = {
  updates: 0,
  consumedSeconds: 0,
  realConsumedSeconds: 0,
  nodeFrameId: 0,
  nodeTime: 0,
  deltaSeconds: 0,
  clock: "live",
};

/** The producer submits one update, accepts its readback, then permits the next update. */
function orderedColdBootTimings(entries: readonly { text: string }[]) {
  const kinds = ["TN_EXPOSURE_TIMING", "TN_AUTO_EXPOSURE", "TN_EXPOSURE_SAMPLE"] as const;
  const timings: Record<string, unknown>[] = [];
  let eventCount = 0;
  let currentTiming: Record<string, unknown> = initialTiming;
  for (const { text } of entries) {
    const separator = text.indexOf(":");
    const kind = text.slice(0, separator);
    if (kind === "TN_EXPOSURE_BOOT_READY") {
      const ready = JSON.parse(text.slice(separator + 1));
      if (
        ready.updates !== timings.length ||
        ready.sampleFrames !== Math.floor(eventCount / 3) ||
        ready.cutSampleFrames !== 0 ||
        timingFields.some((key) => ready[key] !== currentTiming[key])
      )
        throw new Error("Cold-boot readiness age is inconsistent with actual render progress.");
      continue;
    }
    if (!kinds.some((value) => value === kind)) continue;
    if (kind !== kinds[eventCount % 3])
      throw new Error("Cold-boot event order must be timing, accepted measurement, then sample.");
    if (kind === "TN_EXPOSURE_TIMING") {
      currentTiming = JSON.parse(text.slice(separator + 1));
      timings.push(currentTiming);
    }
    eventCount++;
  }
  if (eventCount % 3 !== 0) throw new Error("Cold-boot update lacks its accepted sample.");
  return timings;
}

function validLiveElapsed(
  sample: { nodeTime: number; nodeFrameId: number },
  previous: { nodeTime: number; nodeFrameId: number },
  delta: number,
): boolean {
  // NodeFrame.time accumulates every renderer delta. Readback waits can skip frames,
  // so elapsed may exceed this sample's delta; consecutive frame IDs must agree.
  const elapsed = sample.nodeTime - previous.nodeTime;
  return (
    delta <= elapsed + 1e-9 &&
    (sample.nodeFrameId > previous.nodeFrameId + 1 || Math.abs(elapsed - delta) <= 1e-9)
  );
}

function validateColdBootSamples(
  report: ColdBootReport,
  samples: ReturnType<typeof pairedExposureSamples>,
  timings: Record<string, unknown>[],
) {
  let previous = { consumedSeconds: 0, realConsumedSeconds: 0, nodeFrameId: 0, nodeTime: 0 };
  for (const [index, sample] of samples.entries()) {
    const delta = Reflect.get(sample, "deltaSeconds");
    if (
      sample.updates !== index + 1 ||
      sample.clock !== "live" ||
      !Number.isInteger(sample.nodeFrameId) ||
      sample.nodeFrameId <= previous.nodeFrameId ||
      !Number.isFinite(sample.nodeTime) ||
      sample.nodeTime <= previous.nodeTime ||
      !Number.isFinite(delta) ||
      delta < 0 ||
      !validLiveElapsed(sample, previous, delta) ||
      !Number.isFinite(sample.realConsumedSeconds) ||
      Math.abs(sample.realConsumedSeconds - previous.realConsumedSeconds - delta) > 1e-9 ||
      !Number.isFinite(sample.consumedSeconds) ||
      Math.abs(
        sample.consumedSeconds -
          previous.consumedSeconds -
          Math.min(delta, exposureSettings.maxDelta),
      ) > 1e-9 ||
      timingFields.some((key) => Reflect.get(sample, key) !== timings[index]?.[key])
    )
      throw new Error("Cold-boot GPU sample age or live-clock provenance is invalid.");
    assertExposureProof(
      {
        ...report,
        observations: {
          console: [{ text: `TN_AUTO_EXPOSURE:${JSON.stringify(sample.measurement)}` }],
        },
      },
      true,
      3.0578835010528564,
      false,
    );
    previous = sample;
  }
  return previous;
}

/** Capture the same early age without replacing real NodeFrame time or the GPU's output. */
export function qualifyColdBoot(report: ColdBootReport) {
  assertExposureRuntime(report);
  assertExposureClock(report, "fixed-step");
  const entries = report.observations?.console ?? [];
  marker(entries, "TN_EXPOSURE_CLOCK:");
  if (
    report.observations?.startup?.phase !== "ready" ||
    entries.some(({ text }) => text.startsWith("TN_EXPOSURE_WARMUP:"))
  )
    throw new Error("Cold boot needs real readiness without the controlled warmup hold.");
  const frozen = marker(entries, "TN_EXPOSURE_BOOT_FROZEN:");
  const ready = marker(entries, "TN_EXPOSURE_BOOT_READY:");
  const samples = pairedExposureSamples(entries);
  const timings = orderedColdBootTimings(entries);
  if (samples.length !== 3 || timings.length !== 3)
    throw new Error("Cold boot requires exactly three accepted GPU updates.");
  const previous = validateColdBootSamples(report, samples, timings);
  const terminal = samples.at(-1);
  if (
    entries.slice(0, frozen.index).filter(({ text }) => text.startsWith("TN_EXPOSURE_SAMPLE:"))
      .length !== 3 ||
    JSON.stringify(frozen.value) !== JSON.stringify(terminal) ||
    entries
      .slice(frozen.index + 1)
      .some(
        ({ text }) =>
          text.startsWith("TN_EXPOSURE_SAMPLE:") || text.startsWith("TN_EXPOSURE_TIMING:"),
      )
  )
    throw new Error("Cold-boot frozen output differs from the third accepted sample.");
  const tone = report.observations?.tone?.filter(
    (value) => value.code === "TN_TONE" && value.atStep === "boot",
  );
  if (
    tone?.length !== 1 ||
    !Number.isInteger(tone[0]?.p99) ||
    (tone[0]?.p99 ?? 0) <= 0 ||
    (tone[0]?.p99 ?? 256) > 255
  )
    throw new Error("Cold boot requires the shared assert.tone p99 for its named boot frame.");
  return { p99: tone[0]?.p99 as number, ...previous, updates: 3, readiness: ready.value, samples };
}

/** The predeclared band is (maximum - minimum) / minimum, across ten independent launches. */
export function qualifyColdBootSpread(runs: readonly { launch: number; p99: number }[]) {
  if (
    runs.length !== 10 ||
    new Set(runs.map(({ launch }) => launch)).size !== 10 ||
    runs.some(
      ({ launch, p99 }) =>
        !Number.isInteger(launch) ||
        launch < 0 ||
        launch > 9 ||
        !Number.isInteger(p99) ||
        p99 <= 0 ||
        p99 > 255,
    )
  )
    throw new Error(
      "Cold-boot spread needs ten distinct launches with valid shared tone observations.",
    );
  const values = runs.map(({ p99 }) => p99);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = (maximum - minimum) / minimum;
  return { pass: spread <= 0.1, spread, minimum, maximum, limit: 0.1 };
}
