import type { IPlaytestFootSlipObservation } from "../assertion-report.js";
import { isRecord } from "../assertion-report.js";
import type { IEvaluationContext } from "./context.js";
import { NO_FOOT_PLANT_DETAIL, runtimeGameplaySamples, strideHasNoFootPlant, strideReading } from "./families-observation.js";

/** Below this the step did not move the subject enough to tell a planted foot from a dragged one. */
export const FOOT_SLIP_MIN_TRAVEL_M = 0.5;
/** A foot counts as planted while it is in the lowest quarter of the height it lifts to. */
export const FOOT_SLIP_CONTACT_BAND = 0.25;
const MIN_CONTACT_PAIRS = 4;

/** The engine's default fixed step; an assertion names `stepSeconds` when the game sets another. */
const DEFAULT_STEP_SECONDS = 1 / 60;

export interface IFootSlipMeasure {
  contactPairs: number;
  /** Planted-foot world speed in m/s: its travel over the time those planted ticks took. */
  speed?: number;
  /** Planted-foot travel over body travel across the same ticks. */
  slip?: number;
  lift: number;
  name: string;
}

/**
 * Feet planted on the ground do not move while the body passes over them: the world-space travel
 * of a planted foot over the body's travel is 0 for a stride that matches the ground, about 1 for
 * a foot that skates with the body, and grows as the legs cycle faster or slower than the ground.
 * A foot that never lifts is planted on every tick, so a rig that slides flat-footed reads ~1 too.
 */
export function measureFootSlip(observation: IPlaytestFootSlipObservation, stepSeconds = DEFAULT_STEP_SECONDS): { feet: IFootSlipMeasure[]; travel: number; unobserved?: string } {
  const { samples } = observation;
  let travel = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1]!.body;
    const after = samples[index]!.body;
    if (before !== null && after !== null) travel += Math.hypot(after[0] - before[0], after[2] - before[2]);
  }
  if (samples.length < 2 || samples.some(({ body }) => body === null))
    return { feet: [], travel, unobserved: `the subject '${observation.entity}' was not reported on every tick` };
  const missing = observation.feet.filter((_name, foot) => samples.some((sample) => sample.feet[foot] === null));
  if (missing.length > 0)
    return { feet: [], travel, unobserved: `no node named ${missing.map((name) => `'${name}'`).join(", ")} was found on every tick; name the sole nodes (Object3D.name) the scenario lists` };
  if (travel < FOOT_SLIP_MIN_TRAVEL_M)
    return { feet: [], travel, unobserved: `the subject moved ${travel.toFixed(2)} m during the step, under ${FOOT_SLIP_MIN_TRAVEL_M} m; drive it before bounding its feet` };
  const feet = observation.feet.map((name, foot): IFootSlipMeasure => {
    // Height above the body, not the world: on a bank the ground itself rises and falls.
    const heights = samples.map((sample) => sample.feet[foot]![1] - sample.body![1]);
    const low = Math.min(...heights);
    const lift = Math.max(...heights) - low;
    const planted = heights.map((height) => height <= low + FOOT_SLIP_CONTACT_BAND * lift);
    let footTravel = 0;
    let bodyTravel = 0;
    let contactPairs = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (!planted[index - 1] || !planted[index]) continue;
      const [fx0, , fz0] = samples[index - 1]!.feet[foot]!;
      const [fx1, , fz1] = samples[index]!.feet[foot]!;
      const [bx0, , bz0] = samples[index - 1]!.body!;
      const [bx1, , bz1] = samples[index]!.body!;
      footTravel += Math.hypot(fx1 - fx0, fz1 - fz0);
      bodyTravel += Math.hypot(bx1 - bx0, bz1 - bz0);
      contactPairs += 1;
    }
    return {
      contactPairs,
      lift,
      name,
      ...(contactPairs < MIN_CONTACT_PAIRS || bodyTravel <= 0 ? {} : { slip: footTravel / bodyTravel, speed: footTravel / (contactPairs * stepSeconds) }),
    };
  });
  return { feet, travel };
}

export function emitFootSlip(ctx: IEvaluationContext): void {
  const assertions = ctx.scenarioAssertions.footSlip;
  if (assertions === undefined || assertions.length === 0) return;
  assertions.forEach((assertion, index) => {
    const id = `footSlip[${index}]`;
    const observation = ctx.input.report.observations?.footSlip?.find(({ label }) => label === assertion.atStep);
    const measure = observation === undefined ? undefined : measureFootSlip(observation, assertion.stepSeconds);
    const unmeasured = measure?.feet.find(({ slip }) => slip === undefined);
    const reason = observation === undefined
      ? "the run recorded no per-tick foot samples for this step; footSlip runs only on the browser target"
      : measure!.unobserved ?? (unmeasured === undefined ? undefined : `'${unmeasured.name}' was planted on fewer than ${MIN_CONTACT_PAIRS} consecutive ticks`);
    if (reason !== undefined) {
      ctx.assertions.push({ details: { atStep: assertion.atStep, reason, ...(measure === undefined ? {} : { travel: measure.travel }) }, id: `${id}.observed`, pass: false });
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_FOOT_SLIP_UNOBSERVED",
        message: `footSlip at '${assertion.atStep}' was not measured: ${reason}.`,
        observedRuntimePath: "observations.json/footSlip",
        severity: "error",
        suggestion: "Run on the browser target, name each sole node (Object3D.name, for example footL and footR), and make the step move the subject at a run.",
      });
      return;
    }
    // The stride the producer reported at this step: a moving character on a clip with no foot plant
    // has nothing for the slip number to be compared with, so a pass would be a measurement of nothing.
    const animation = runtimeGameplaySamples(ctx.input.report.observations?.runtimeObservations).find(({ label }) => label === assertion.atStep)?.gameplay.animation;
    const stride = isRecord(animation) ? strideReading(animation[observation!.entity]) : undefined;
    if (stride !== undefined && strideHasNoFootPlant(stride)) {
      ctx.assertions.push({ details: { atStep: assertion.atStep, reason: NO_FOOT_PLANT_DETAIL, stride, travel: measure!.travel }, id: `${id}.observed`, pass: false });
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_STRIDE_NO_FOOT_PLANT",
        message: `footSlip at '${assertion.atStep}' failed closed: ${NO_FOOT_PLANT_DETAIL}.`,
        observedRuntimePath: "observations.json/runtimeObservations",
        severity: "error",
        suggestion: "The clip has no root motion and its feet never plant, so stride sync cannot match it to the ground: author a clip whose feet plant, or drive the stride from distance travelled.",
      });
      return;
    }
    const worst = Math.max(...measure!.feet.map(({ slip }) => slip!));
    const worstSpeed = Math.max(...measure!.feet.map(({ speed }) => speed!));
    const slipPass = assertion.maxSlip === undefined || worst <= assertion.maxSlip;
    const speedPass = assertion.maxSlideSpeed === undefined || worstSpeed <= assertion.maxSlideSpeed;
    ctx.assertions.push({
      details: {
        atStep: assertion.atStep,
        expected: { maxSlideSpeed: assertion.maxSlideSpeed, maxSlip: assertion.maxSlip },
        feet: measure!.feet,
        travel: measure!.travel,
        worst,
        worstSpeed,
      },
      id: `${id}.slip`,
      pass: slipPass && speedPass,
    });
    if (!slipPass)
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_FOOT_SLIP",
        message: `A planted foot travelled ${worst.toFixed(2)} m per metre of body travel at '${assertion.atStep}', ceiling ${assertion.maxSlip}.`,
        observedRuntimePath: "observations.json/footSlip",
        severity: "error",
        suggestion: "Drive the stride from distance travelled, not from time: the cycle phase should advance by ground speed over stride length, so a planted foot stays put.",
      });
    if (!speedPass)
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_FOOT_SLIP",
        message: `A planted foot slid at ${worstSpeed.toFixed(2)} m/s at '${assertion.atStep}', ceiling ${assertion.maxSlideSpeed} m/s.`,
        observedRuntimePath: "observations.json/footSlip",
        severity: "error",
        suggestion: "Drive the stride from distance travelled, not from time: the cycle phase should advance by ground speed over stride length, so a planted foot stays put.",
      });
  });
}
