import { createTemporalAAFixture } from "./temporal-aa-fixture.js";
import { assertCondition, startVisualScene } from "./scene-support.js";

// The host calls render() once per frame and never the fixture's async sampleVelocity, so the
// readbacks the reset proof needs cannot run from the frame loop. The build callback is the
// supported async seam — offscreen-screenshot reads a render target there — so the diagnostic
// frames run inside it and every frame is asserted before the scene starts.
const DIAGNOSTIC_FRAMES = 22;
const SCALE = 2 / 3;

/** The raster pair a display-sized reconstruction must publish at the fixture's own transition. */
export function assertScaledTransition(opening, resized, label) {
  const inputWidth = Math.floor(opening.displayWidth * SCALE);
  const inputHeight = Math.floor(opening.displayHeight * SCALE);
  assertCondition(inputWidth > 0 && inputHeight > 0, `${label}: opening input raster is empty.`);
  for (const [field, width, height] of [
    ["input", opening.inputWidth, opening.inputHeight],
    ["depth history", opening.depthHistoryWidth, opening.depthHistoryHeight],
  ]) {
    assertCondition(
      width === inputWidth && height === inputHeight,
      `${label}: ${field} is ${width}x${height}, not the input raster ${inputWidth}x${inputHeight}.`,
    );
  }
  const displayHeight = Math.round(opening.displayHeight * SCALE);
  for (const [field, width, height] of [
    ["display", opening.displayWidth, opening.displayHeight],
    ["resolve", opening.resolveWidth, opening.resolveHeight],
    ["history", opening.historyWidth, opening.historyHeight],
  ]) {
    assertCondition(
      width === opening.displayWidth && height === opening.displayHeight,
      `${label}: ${field} is ${width}x${height}, not the display raster.`,
    );
  }
  assertCondition(
    resized.displayWidth === opening.displayWidth,
    `${label}: the display resized its width, so this is not the height-only transition.`,
  );
  assertCondition(
    resized.displayHeight === displayHeight,
    `${label}: display height is ${resized.displayHeight}, not ${displayHeight}.`,
  );
  for (const [field, width, height] of [
    ["input", resized.inputWidth, resized.inputHeight],
    ["depth history", resized.depthHistoryWidth, resized.depthHistoryHeight],
  ]) {
    assertCondition(
      width === inputWidth && height === Math.floor(displayHeight * SCALE),
      `${label}: ${field} is ${width}x${height} after the transition.`,
    );
  }
  for (const [field, width, height] of [
    ["display", resized.displayWidth, resized.displayHeight],
    ["resolve", resized.resolveWidth, resized.resolveHeight],
    ["history", resized.historyWidth, resized.historyHeight],
  ]) {
    assertCondition(
      width === resized.displayWidth && height === resized.displayHeight,
      `${label}: ${field} is ${width}x${height}, not the resized display raster.`,
    );
  }
  assertCondition(
    resized.farBorderBeyondInput === true && resized.farBorderMax > 0.01,
    `${label}: the far border of the display raster did not answer a display-sized resolve.`,
  );
}

/**
 * The measured per-pixel history rejection, on the frames where the answer is checkable. A reset
 * frame carries no legal history at any pixel, so the whole display must be counted as rejected and
 * the GPU must say it visited exactly that many pixels. Every later frame must publish a finite
 * share with a stated age, and no frame may publish one it has not measured. `expectedCold` is how
 * many resets the calling route makes: two for the scaled rows, five for the lifecycle route.
 */
export function assertRejectionCounts(observed, label, expectedCold = 2) {
  const cold = observed.rejectionCold;
  assertCondition(
    cold.length === expectedCold,
    `${label}: ${cold.length} reset frames reported a rejection count, not the ${expectedCold} this route makes.`,
  );
  for (const row of cold) {
    const pixels = row.displayWidth * row.displayHeight;
    assertCondition(
      row.visited === pixels,
      `${label}: the ${row.resetReason} reset frame visited ${row.visited} of ${pixels} display pixels.`,
    );
    assertCondition(
      row.fraction === 1,
      `${label}: the ${row.resetReason} reset frame rejected ${row.fraction} of its display, not all of it.`,
    );
    assertCondition(
      row.historyValid === false,
      `${label}: the ${row.resetReason} counted frame reports legal history, so the whole-raster share is not the reset's.`,
    );
  }
  for (const row of observed.rejectionFrames) {
    assertCondition(
      typeof row.fraction === "number" && Number.isFinite(row.fraction) && row.fraction >= 0 && row.fraction <= 1,
      `${label}: frame ${row.frame} reported the rejection fraction ${String(row.fraction)}.`,
    );
    assertCondition(
      Number.isInteger(row.staleFrames) && row.staleFrames >= 0,
      `${label}: frame ${row.frame} reported the age ${String(row.staleFrames)} of its own count.`,
    );
  }
}

export function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "temporal-aa-scaled",
    async ({ renderer, scene, camera }) => {
      // The pose settles on the raster transition, so the browser and native captures are one frame.
      const fixture = createTemporalAAFixture(renderer, scene, camera, "scaled", true, 20);
      const observations = [];
      for (let frame = 0; frame < DIAGNOSTIC_FRAMES; frame += 1) {
        // A real frame boundary before every diagnostic render: a temporal node's own frame update
        // waits on the animation clock, so renders issued back-to-back inside one turn never advance it.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        fixture.render();
        await fixture.sampleVelocity();
        const probe = fixture.observation().resolveProbe;
        assertCondition(probe !== null, "scaled resolve readbacks are unavailable.");
        observations.push(probe);
      }
      const opening = observations[0];
      const resized = observations.at(-1);
      assertScaledTransition(opening, resized, "scaled reconstruction");
      assertRejectionCounts(fixture.observation(), "scaled reconstruction");
      assertCondition(
        resized.coldFrames.length === 2,
        `scaled reconstruction: ${resized.coldFrames.length} reset frames were compared, not the opening and resize pair.`,
      );
      const [openingCold, resizeCold] = resized.coldFrames;
      for (const [cold, label] of [
        [openingCold, "opening"],
        [resizeCold, "resize"],
      ]) {
        const samples = cold.width * cold.height * 3;
        assertCondition(
          cold.pixels === samples,
          `scaled reconstruction: the ${label} reset frame compared ${cold.pixels} samples, not the whole display's ${samples}.`,
        );
        assertCondition(
          cold.outside === 0,
          `scaled reconstruction: the ${label} reset frame published ${cold.outside} samples outside the oracle.`,
        );
      }
      assertCondition(
        openingCold.viewEnabled === false,
        "scaled reconstruction: the opening frame carried a jitter lattice instead of no lattice.",
      );
      assertCondition(
        resizeCold.jitterMatchesInput === true,
        `scaled reconstruction: the resize frame jitted ${resizeCold.viewWidth}x${resizeCold.viewHeight} against a ${resizeCold.inputWidth}x${resizeCold.inputHeight} input raster.`,
      );
      // Every diagnostic render and readback is done, so the capture holds this route's last real
      // frame instead of whichever later frame each host happened to stop on.
      fixture.freeze();
      return {
        ...fixture,
        detail: {
          milestone: "display-sized-temporal-reconstruction",
          qualification: "experimental",
          resetFrames: resized.coldFrames.length,
          input: `${resized.inputWidth}x${resized.inputHeight}`,
          display: `${resized.displayWidth}x${resized.displayHeight}`,
          outsideSamples: openingCold.outside + resizeCold.outside,
        },
      };
    },
  );
}
