import { createTemporalAAFixture } from "./temporal-aa-fixture.js";
import { assertScaledTransition } from "./temporal-aa-scaled.js";
import { assertCondition, startVisualScene } from "./scene-support.js";

// The host calls render() once per frame and never the fixture's async sampleVelocity, so the
// readbacks the reset proof needs cannot run from the frame loop. The build callback is the
// supported async seam, exactly as in the positive row, so both arms compare one frame-for-frame
// measurement of the same two cold frames.
const DIAGNOSTIC_FRAMES = 22;

// Fixture-only negative control: the same display-sized reconstruction with the reset gate removed,
// so each cold frame blends whatever the unwritten history buffer holds. It is not a product mode.
// Its only job is to make the positive row's outside===0 mean something.
export function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "temporal-aa-scaled-unchecked-reset",
    async ({ renderer, scene, camera }) => {
      const fixture = createTemporalAAFixture(
        renderer,
        scene,
        camera,
        "scaled-unchecked-reset",
        true,
        20,
      );
      const observations = [];
      for (let frame = 0; frame < DIAGNOSTIC_FRAMES; frame += 1) {
        // The positive row's own frame boundary, so both arms measure one frame-for-frame pair.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        fixture.render();
        await fixture.sampleVelocity();
        const probe = fixture.observation().resolveProbe;
        assertCondition(probe !== null, "scaled control resolve readbacks are unavailable.");
        observations.push(probe);
      }
      const resized = observations.at(-1);
      // The rasters and the lattice are the provider's own behaviour, so the control asserts the
      // identical transition the positive row asserts. Only the reset gate differs.
      assertScaledTransition(observations[0], resized, "scaled unchecked-reset control");
      assertCondition(
        resized.coldFrames.length === 2,
        `scaled unchecked-reset control: ${resized.coldFrames.length} reset frames were compared, not the opening and resize pair.`,
      );
      let contaminated = 0;
      for (const [index, cold] of resized.coldFrames.entries()) {
        const samples = cold.width * cold.height * 3;
        assertCondition(
          cold.pixels === samples,
          `scaled unchecked-reset control: cold frame ${index} compared ${cold.pixels} samples, not the whole display's ${samples}.`,
        );
        assertCondition(
          cold.outside >= 1,
          `scaled unchecked-reset control: cold frame ${index} published 0 samples outside the oracle, so the removed gate changed nothing and the control proves nothing.`,
        );
        contaminated += cold.outside;
      }
      const [openingCold, resizeCold] = resized.coldFrames;
      assertCondition(
        openingCold.viewEnabled === false,
        "scaled unchecked-reset control: the opening frame carried a jitter lattice instead of no lattice.",
      );
      assertCondition(
        openingCold.historyValid === false,
        "scaled unchecked-reset control: the opening frame reported valid history, so it was not a reset frame at all.",
      );
      assertCondition(
        resizeCold.jitterMatchesInput === true,
        `scaled unchecked-reset control: the resize frame jitted ${resizeCold.viewWidth}x${resizeCold.viewHeight} against a ${resizeCold.inputWidth}x${resizeCold.inputHeight} input raster.`,
      );
      // The same counter runs in this arm, over the same two rasters. It must still visit every
      // display pixel and publish a finite share with a stated age; the removed gate is a shader
      // concern, so no value of its own is claimed here — the positive row owns the whole-raster one.
      for (const [index, row] of fixture.observation().rejectionCold.entries()) {
        const pixels = row.displayWidth * row.displayHeight;
        assertCondition(
          row.visited === pixels,
          `scaled unchecked-reset control: reset frame ${index} visited ${row.visited} of ${pixels} display pixels.`,
        );
        assertCondition(
          typeof row.fraction === "number" && Number.isFinite(row.fraction) && row.fraction >= 0 && row.fraction <= 1,
          `scaled unchecked-reset control: reset frame ${index} reported the rejection fraction ${String(row.fraction)}.`,
        );
        assertCondition(
          Number.isInteger(row.staleFrames) && row.staleFrames >= 0,
          `scaled unchecked-reset control: reset frame ${index} reported the age ${String(row.staleFrames)} of its own count.`,
        );
      }
      // The control's diagnostics are finished, so its capture holds its own last real frame too.
      fixture.freeze();
      return {
        ...fixture,
        detail: {
          milestone: "display-sized-temporal-reconstruction-unchecked-reset",
          qualification: "experimental",
          resetFrames: resized.coldFrames.length,
          input: `${resized.inputWidth}x${resized.inputHeight}`,
          display: `${resized.displayWidth}x${resized.displayHeight}`,
          outsideSamples: contaminated,
        },
      };
    },
  );
}
