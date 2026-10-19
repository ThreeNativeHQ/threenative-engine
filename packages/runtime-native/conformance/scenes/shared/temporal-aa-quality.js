import { createTemporalAAFixture } from "./temporal-aa-fixture.js";
import { assertRejectionCounts } from "./temporal-aa-scaled.js";
import { assertCondition, startVisualScene } from "./scene-support.js";

// The Phase 2 quality corpus on the shared fixture, on the native lane. This row proves portability
// and counter truth only: that the same scene, poses, authored alpha-tested foliage, low-resolution
// input and display-sized resolve survive the native host. It says nothing about image quality — the
// browser scorer owns every quality gate, and those gates are currently red.
const DIAGNOSTIC_FRAMES = 36;
const SETTLE = 36;
const SCALE = 2 / 3;
// The conformance viewport, not the browser measurement raster. The input raster is derived from the
// display the host actually gave us, so a host that sizes differently fails instead of passing.
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 720;

/** One shared quality route, so a second row cannot quietly assert a looser version of these. */
async function runTemporalQuality({ renderer, scene, camera, dimensions }, label) {
  const fixture = createTemporalAAFixture(renderer, scene, camera, "quality-temporal", true, SETTLE);
  for (let frame = 0; frame < DIAGNOSTIC_FRAMES; frame += 1) {
    // A real frame boundary before every diagnostic render, as the other temporal rows await: a
    // temporal node's frame update waits on the animation clock.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fixture.render();
    await fixture.sampleVelocity();
  }
  const observed = fixture.observation();
  // The authored corpus reached the host: the same deterministic alpha-tested foliage, from a
  // DataTexture because the native host has no canvas.
  assertCondition(
    observed.quality?.foliageCards === 6 && observed.quality?.alphaTest === 0.5,
    `${label}: ${observed.quality?.foliageCards ?? 0} alpha-tested foliage cards at alphaTest ${String(observed.quality?.alphaTest)}, not the authored 6 at 0.5.`,
  );
  assertCondition(
    observed.quality?.leafTextureSize === 16,
    `${label}: the leaf mask is ${String(observed.quality?.leafTextureSize)}, not the authored 16x16 DataTexture.`,
  );
  // The low input is a strict fraction of the display, and the display is the whole display.
  const inputWidth = Math.floor(observed.raster.displayWidth * SCALE);
  const inputHeight = Math.floor(observed.raster.displayHeight * SCALE);
  assertCondition(
    observed.raster.inputWidth === inputWidth && observed.raster.inputHeight === inputHeight,
    `${label}: the input raster is ${observed.raster.inputWidth}x${observed.raster.inputHeight}, not the ${inputWidth}x${inputHeight} the authored ${SCALE} scale asks for.`,
  );
  assertCondition(
    observed.raster.inputWidth < observed.raster.displayWidth &&
      observed.raster.inputHeight < observed.raster.displayHeight,
    `${label}: the input raster ${observed.raster.inputWidth}x${observed.raster.inputHeight} is not below the display raster ${observed.raster.displayWidth}x${observed.raster.displayHeight}.`,
  );
  assertCondition(
    observed.aa?.outputWidth === observed.raster.displayWidth &&
      observed.aa?.outputHeight === observed.raster.displayHeight,
    `${label}: the resolve published ${observed.aa?.outputWidth}x${observed.aa?.outputHeight}, not the display raster ${observed.raster.displayWidth}x${observed.raster.displayHeight}.`,
  );
  // The reconstruction stage and its velocity MRT really ran on this host.
  assertCondition(
    observed.stages.length === 1 && observed.stages[0] === "traa",
    `${label}: installed stages are [${observed.stages.join(", ")}], not the single traa stage.`,
  );
  assertCondition(
    observed.velocity.source === "mrt",
    `${label}: the velocity source is ${String(observed.velocity.source)}, not the MRT output.`,
  );
  // The counter is real on this host: every reset frame visited the whole display, and every frame
  // published a finite share with a stated source age.
  assertRejectionCounts(observed, label, 1);
  const measured = observed.rejectionFrames.at(-1);
  assertCondition(
    measured?.visited === observed.raster.displayWidth * observed.raster.displayHeight,
    `${label}: the counter visited ${String(measured?.visited)} pixels, not the ${observed.raster.displayWidth * observed.raster.displayHeight} display pixels.`,
  );
  assertCondition(
    typeof measured?.staleFrames === "number" && Number.isFinite(measured.staleFrames),
    `${label}: the counter reported the source age ${String(measured?.staleFrames)} of its own count.`,
  );
  // History stayed valid after startup: this route requests no reset, so a reset here would be the
  // host invalidating it for a reason the route never caused.
  assertCondition(
    observed.resets === 1,
    `${label}: ${observed.resets} global history resets ran, not the single startup reset.`,
  );
  // The authored corpus has been measured on this host, so the capture holds this route's last real
  // frame rather than whichever later frame each host happened to stop on.
  fixture.freeze();
  return {
    ...fixture,
    detail: {
      milestone: "display-sized-temporal-reconstruction-quality",
      qualification: "experimental-portability-only",
      input: `${observed.raster.inputWidth}x${observed.raster.inputHeight}`,
      display: `${observed.raster.displayWidth}x${observed.raster.displayHeight}`,
      foliageCards: observed.quality?.foliageCards ?? 0,
      resets: observed.resets,
      rejectedFraction: measured?.fraction ?? null,
      counterVisited: measured?.visited ?? null,
      counterSourceAgeFrames: measured?.staleFrames ?? null,
    },
  };
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "temporal-aa-quality", (context) => {
    // The conformance page sizes its own canvas; the route asserts against the display the host
    // actually gave us, and this constant only names the lane it is expected to be.
    assertCondition(
      dimensions.width === DISPLAY_WIDTH && dimensions.height === DISPLAY_HEIGHT,
      `temporal quality: the host display is ${dimensions.width}x${dimensions.height}, not the conformance ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}.`,
    );
    return runTemporalQuality(context, "temporal quality");
  });
}
