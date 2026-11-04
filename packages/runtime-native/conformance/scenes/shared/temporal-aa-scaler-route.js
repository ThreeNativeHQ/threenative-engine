import { SCALER_ROUTE, createTemporalAAFixture } from "./temporal-aa-fixture.js";
import { assertRejectionCounts } from "./temporal-aa-scaled.js";
import { assertCondition, startVisualScene } from "./scene-support.js";

// One scripted three-scale input route on the shared fixture. The display raster never moves: only
// the pass's input raster steps between 1, 0.75 and 0.5, twice, so every history invalidation is the
// input raster's own and every allocation the step makes has to return to its starting count.
const LABEL = "temporal scaler route";
const DIAGNOSTIC_FRAMES = 72;
const BASELINE_FRAME = 7;
const CYCLE_FRAMES = [39, 71];
const STEP_FRAMES = new Set(SCALER_ROUTE.map(([frame]) => frame));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function scaleAt(frame) {
  let scale = 1;
  for (const [stepFrame, stepScale] of SCALER_ROUTE) if (frame > stepFrame) scale = stepScale;
  return scale;
}

/** Every step invalidates history on its own frame only, and moves only the input raster. */
function assertRoute(observed, raster) {
  assertRejectionCounts(observed, LABEL, SCALER_ROUTE.length + 1);
  const display = raster[0];
  for (const [frame, scale] of SCALER_ROUTE) {
    const reset = observed.rejectionFrames[frame];
    assertCondition(
      reset?.historyValid === false,
      `${LABEL}: the scale step at frame ${frame} reused history instead of invalidating it.`,
    );
    assertCondition(
      reset?.resetReason === "resize",
      `${LABEL}: the scale step at frame ${frame} reported ${String(reset?.resetReason)}, not resize.`,
    );
    const next = observed.rejectionFrames[frame + 1];
    assertCondition(
      next?.historyValid === true,
      `${LABEL}: the reset at frame ${frame} still invalidated history at frame ${frame + 1}.`,
    );
    assertCondition(
      typeof next?.fraction === "number" && Number.isFinite(next.fraction) && next.fraction < 1,
      `${LABEL}: frame ${frame + 1} rejected ${String(next?.fraction)} of its display, so it held no history to reuse.`,
    );
    // PassNode.setSize floors each axis of the display raster times the pass's scale.
    const inputWidth = Math.floor(display.displayWidth * scale);
    const inputHeight = Math.floor(display.displayHeight * scale);
    assertCondition(
      raster[frame].inputWidth === inputWidth && raster[frame].inputHeight === inputHeight,
      `${LABEL}: frame ${frame} rendered a ${raster[frame].inputWidth}x${raster[frame].inputHeight} input raster, not the ${inputWidth}x${inputHeight} the ${scale} scale asks for.`,
    );
    assertCondition(
      raster[frame].displayWidth === display.displayWidth &&
        raster[frame].displayHeight === display.displayHeight,
      `${LABEL}: frame ${frame} moved the display raster to ${raster[frame].displayWidth}x${raster[frame].displayHeight}, not ${display.displayWidth}x${display.displayHeight}.`,
    );
  }
}

/** Each full cycle returns the live counts to baseline, and no step costs more than a full frame. */
function assertSteady(memory, gpuMs) {
  const baseline = memory[BASELINE_FRAME];
  for (const frame of CYCLE_FRAMES) {
    for (const field of ["textures", "geometries"]) {
      assertCondition(
        memory[frame][field] === baseline[field],
        `${LABEL}: ${field} at frame ${frame} is ${memory[frame][field]}, not the ${baseline[field]} baseline at frame ${BASELINE_FRAME}; a cycle leaked allocations.`,
      );
    }
  }
  // The load must be raster bound, or a scale step saves nothing and the spike budget proves nothing.
  const steady = steadyGpu(gpuMs);
  assertCondition(
    steady["0.5"] < steady["1"] * 0.75,
    `${LABEL}: half scale costs ${steady["0.5"].toFixed(3)} ms against ${steady["1"].toFixed(3)} ms at full scale; the route is not raster bound.`,
  );
  // A spike is the step frame against the frames around it: a GPU clock or contention change hits
  // them all (one shared-GPU run read 1.9 ms on frames 63-66 around the step at 64), a reset does not.
  // Raster bound, this budget sits under the raster cost a downward step saves.
  for (const frame of STEP_FRAMES) {
    const budget = median([-2, -1, 1, 2, 3].map((offset) => gpuMs[frame + offset])) * 1.1 + 0.05;
    assertCondition(
      gpuMs[frame] <= budget,
      `${LABEL}: frame ${frame} took ${gpuMs[frame].toFixed(3)} ms of GPU time, over the ${budget.toFixed(3)} ms budget from its neighbour frames; frames: ${gpuMs.map((ms) => ms.toFixed(2)).join(" ")}.`,
    );
  }
}

/** Steady medians per scale, from the frames inside each scale's span and never the step itself. */
function steadyGpu(gpuMs) {
  const spans = new Map();
  for (let frame = 1; frame < DIAGNOSTIC_FRAMES; frame += 1) {
    if (STEP_FRAMES.has(frame)) continue;
    const scale = String(scaleAt(frame));
    if (!spans.has(scale)) spans.set(scale, []);
    spans.get(scale).push(gpuMs[frame]);
  }
  return Object.fromEntries([...spans].map(([scale, values]) => [scale, median(values)]));
}

export function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "temporal-aa-scaler-route",
    async ({ renderer, scene, camera }) => {
      const fixture = createTemporalAAFixture(
        renderer,
        scene,
        camera,
        "scaler-route",
        true,
        DIAGNOSTIC_FRAMES,
      );
      // Per-stage cost: three's inspector sees every render pass's timestamp uid with its scene and
      // camera, so the fixture's own scene pass is told apart from the reconstruction passes.
      const sceneUids = new Set();
      const beginRender = renderer.inspector.beginRender.bind(renderer.inspector);
      renderer.inspector.beginRender = (uid, drawn, eye, target) => {
        if (drawn === scene && eye === camera) sceneUids.add(uid);
        beginRender(uid, drawn, eye, target);
      };
      const gpuMs = [];
      const sceneMs = [];
      const memory = [];
      const raster = [];
      for (let frame = 0; frame < DIAGNOSTIC_FRAMES; frame += 1) {
        // A real frame boundary before every diagnostic render: a temporal node's own frame update
        // waits on the animation clock, so renders issued back-to-back never advance it.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        fixture.render();
        await fixture.sampleVelocity();
        // three's own per-frame query pair, in milliseconds, and the same value it publishes as
        // renderer.info.render.timestamp. A missing or zero number means the adapter cannot time.
        const measured = await renderer.resolveTimestampsAsync("render");
        assertCondition(
          typeof measured === "number" && Number.isFinite(measured) && measured > 0,
          `${LABEL}: frame ${frame} reported the GPU render time ${String(measured)} (timestamp-query ${renderer.hasFeature("timestamp-query")}, tracking ${renderer.backend.trackTimestamp}); this row requires a hardware adapter with timestamp-query.`,
        );
        const timed = [...renderer.backend.timestampQueryPool.render.timestamps].filter(([uid]) =>
          sceneUids.has(uid),
        );
        assertCondition(timed.length > 0, `${LABEL}: frame ${frame} timed no scene pass.`);
        const observed = fixture.observation();
        gpuMs.push(measured);
        sceneMs.push(timed.reduce((sum, [, ms]) => sum + ms, 0));
        memory.push(observed.memory);
        raster.push(observed.raster);
      }
      const observed = fixture.observation();
      assertRoute(observed, raster);
      assertSteady(memory, gpuMs);
      // Every diagnostic render and readback is done, so the capture holds this route's last real
      // frame instead of whichever later frame each host happened to stop on.
      fixture.freeze();
      const detail = {
        milestone: "temporal-scaler-route",
        qualification: "experimental",
        route: SCALER_ROUTE,
        baseline: { frame: BASELINE_FRAME, ...memory[BASELINE_FRAME] },
        cycles: CYCLE_FRAMES.map((frame) => ({ frame, ...memory[frame] })),
        gpuMs: {
          steady: steadyGpu(gpuMs),
          steps: SCALER_ROUTE.map(([frame]) => [frame, gpuMs[frame]]),
        },
        // The scene pass alone, and everything else (reconstruction, history resolve, present).
        sceneMs: {
          steady: steadyGpu(sceneMs),
          steps: SCALER_ROUTE.map(([frame]) => [frame, sceneMs[frame]]),
        },
        restMs: { steady: steadyGpu(gpuMs.map((ms, frame) => ms - sceneMs[frame])) },
      };
      // The runner keeps this line in the report (result.browser.routeDetail).
      console.info(`TN_ROUTE_DETAIL ${JSON.stringify(detail)}`);
      return { ...fixture, detail };
    },
    { renderer: { trackTimestamp: true } },
  );
}
