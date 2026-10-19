import { MOVING_PIXELS, REPROJECTION_PIXELS, createTemporalAAFixture } from "./temporal-aa-fixture.js";
import { assertRejectionCounts, assertScaledTransition } from "./temporal-aa-scaled.js";
import { assertCondition, startVisualScene } from "./scene-support.js";

// One bounded lifecycle route on the shared fixture: the height-only display resize at 20 the
// scaled rows already prove, then an authored teleport at 24, an authored projection change at 28
// that requests no reset anywhere, and an input-only scale change at 32 that leaves the physical
// display raster exactly where it is. The pose keeps moving through all of them, so the skinned limb
// and the instances are still moving when every history decision is taken.
const DIAGNOSTIC_FRAMES = 36;
const STEPS = [
  [20, "resize"],
  [24, "camera-cut"],
  [28, "projection-change"],
  [32, "resize"],
];
const REASONS = ["initial", "resize", "camera-cut", "projection-change", "resize"];
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 480;
const SCALED_INPUT_WIDTH = 640;
const SCALED_INPUT_HEIGHT = 240;
/** The tracked points this route measures, in the order the assertions read them. */
const TRACKED = ["instance", "skinned"];

/** The route, its assertions and its own frames, so the zero-velocity control drives exactly these
 * assertions rather than a second and looser copy of them. */
export async function runTemporalLifecycle({ renderer, scene, camera }, variant, label) {
  const fixture = createTemporalAAFixture(renderer, scene, camera, variant, true, 36);
  const probes = [];
  for (let frame = 0; frame < DIAGNOSTIC_FRAMES; frame += 1) {
    // A real frame boundary before every diagnostic render, as the scaled rows await: a temporal
    // node's own frame update waits on the animation clock, so back-to-back renders never advance it.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fixture.render();
    await fixture.sampleVelocity();
    probes.push(fixture.observation().resolveProbe);
  }
  assertCondition(probes[0] !== null, `${label}: scaled resolve readbacks are unavailable.`);
  // The height-only transition this route starts from, measured exactly as the scaled rows measure it.
  assertScaledTransition(probes[0], probes[20], label);
  const observed = fixture.observation();
  assertRejectionCounts(observed, label, REASONS.length);
  REASONS.forEach((reason, index) => {
    assertCondition(
      observed.rejectionCold[index]?.resetReason === reason,
      `${label}: reset frame ${index} reported ${observed.rejectionCold[index]?.resetReason}, not the ${reason} this route made.`,
    );
  });
  // Each reset governs its own frame and no other: the frame after it reuses history again.
  for (const [frame, reason] of STEPS) {
    assertCondition(
      observed.rejectionFrames[frame].historyValid === false,
      `${label}: the ${reason} frame ${frame} reused history instead of invalidating it.`,
    );
    assertCondition(
      observed.rejectionFrames[frame + 1].historyValid === true,
      `${label}: the ${reason} reset at frame ${frame} still invalidated history at frame ${frame + 1}.`,
    );
    assertCondition(
      observed.rejectionFrames[frame + 1].fraction < 1,
      `${label}: frame ${frame + 1} rejected its whole display after the ${reason} reset at frame ${frame}.`,
    );
  }
  const settled = probes.at(-1);
  assertCondition(
    settled.coldFrames.length === REASONS.length,
    `${label}: ${settled.coldFrames.length} reset frames were compared against the whole display, not the ${REASONS.length} this route makes.`,
  );
  for (const [index, cold] of settled.coldFrames.slice(1).entries()) {
    const samples = cold.width * cold.height * 3;
    assertCondition(
      cold.pixels === samples,
      `${label}: reset frame ${index + 1} compared ${cold.pixels} samples, not the whole display's ${samples}.`,
    );
    assertCondition(
      cold.outside === 0,
      `${label}: the ${REASONS[index + 1]} reset frame published ${cold.outside} samples outside the oracle.`,
    );
    assertCondition(
      cold.jitterMatchesInput === true,
      `${label}: the ${REASONS[index + 1]} reset frame jitted ${cold.viewWidth}x${cold.viewHeight} against a ${cold.inputWidth}x${cold.inputHeight} input raster.`,
    );
  }
  // The input-only step moved the pass raster and nothing else.
  assertCondition(
    settled.displayWidth === DISPLAY_WIDTH && settled.displayHeight === DISPLAY_HEIGHT,
    `${label}: the input-only step moved the display raster to ${settled.displayWidth}x${settled.displayHeight}, not ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}.`,
  );
  assertCondition(
    settled.inputWidth === SCALED_INPUT_WIDTH && settled.inputHeight === SCALED_INPUT_HEIGHT,
    `${label}: the authored half scale left a ${settled.inputWidth}x${settled.inputHeight} input raster, not ${SCALED_INPUT_WIDTH}x${SCALED_INPUT_HEIGHT}.`,
  );
  const [, , , , scaleCold] = settled.coldFrames;
  assertCondition(
    scaleCold.viewWidth === SCALED_INPUT_WIDTH && scaleCold.viewHeight === SCALED_INPUT_HEIGHT,
    `${label}: the input-scale frame jitted a ${scaleCold.viewWidth}x${scaleCold.viewHeight} lattice against the pass's own ${scaleCold.inputWidth}x${scaleCold.inputHeight} raster.`,
  );
  // The tracked objects' history coordinates, reconstructed from the measured MRT velocity and
  // compared against where each point independently projected last frame. The independent expected
  // motion comes first: with nothing read, or nothing that moved, every number below is meaningless.
  for (const name of TRACKED) {
    const witness = observed.historyWitness[name];
    assertCondition(witness.samples > 0, `${label}: no ${name} history sample was read, so nothing was measured.`);
    assertCondition(
      witness.maxExpectedPixels >= MOVING_PIXELS,
      `${label}: the ${name} moved at most ${witness.maxExpectedPixels} px, so its history coordinate is untested.`,
    );
  }
  // Every tracked object in one fail-closed condition, ahead of the measured-velocity guards below: a
  // history coordinate that lands in the wrong place has to fail here, where the message still carries
  // each point's own independent expected motion, and not at a later report of no measured motion.
  const missed = TRACKED.filter((name) => observed.historyWitness[name].maxMisregistration > REPROJECTION_PIXELS);
  assertCondition(
    missed.length === 0,
    `${label}: ${missed
      .map((name) => {
        const witness = observed.historyWitness[name];
        return `the ${name} missed its independently projected previous location by ${witness.maxMisregistration} px at frame ${witness.maxMisregistrationFrame}, over the ${REPROJECTION_PIXELS} px bound, while the point moved ${witness.maxExpectedPixels} px`;
      })
      .join("; ")}.`,
  );
  for (const name of TRACKED) {
    const witness = observed.historyWitness[name];
    assertCondition(
      witness.movingFrames > 0,
      `${label}: the ${name}'s measured vector never reached the ${MOVING_PIXELS} px moving threshold on any of its ${witness.samples} samples.`,
    );
    assertCondition(
      witness.maxMeasuredPixels >= MOVING_PIXELS,
      `${label}: the ${name}'s measured MRT velocity peaked at ${witness.maxMeasuredPixels} px, under the ${MOVING_PIXELS} px moving threshold.`,
    );
  }
  // All five reset frames and every tracked point have been read, so the capture holds this route's
  // last real frame rather than whichever later frame each host happened to stop on.
  fixture.freeze();
  return {
    ...fixture,
    detail: {
      milestone: "temporal-history-lifecycle",
      qualification: "experimental",
      resets: observed.resets,
      input: `${settled.inputWidth}x${settled.inputHeight}`,
      display: `${settled.displayWidth}x${settled.displayHeight}`,
      reasons: REASONS,
      misregistration: TRACKED.map((name) => observed.historyWitness[name].maxMisregistration),
    },
  };
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "temporal-aa-lifecycle", (context) =>
    runTemporalLifecycle(context, "scaled-lifecycle", "temporal lifecycle"),
  );
}