import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { assertCaptureNotBlank } from "../packages/playtest/dist/capture.js";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import {
  requireTemporalRenderEvidence,
  writeTemporalMotionSummary,
} from "./temporal-aa-evidence.js";
import {
  type ILinearFrame,
  linearFrame,
  measureBlueProfile,
  measureCausalReveal,
  measureSequence,
} from "./temporal-aa-quality.js";

interface IVelocityProbe {
  projectionError: number | null;
  samples: Array<{ name: string; errorPixels: number }>;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW4 = process.env.TN_RAW4 === "1";
const output = path.join(root, `artifacts/temporal-aa/motion${RAW4 ? "-raw4" : ""}`);
const scenario = JSON.parse(
  await readFile(
    path.join(root, "examples/abyss-framework/playtests/temporal-motion.playtest.json"),
    "utf8",
  ),
);
// Qualified hardware WebGPU. Without the Vulkan and ANGLE flags below a headless Linux run never
// reaches the driver and silently serves WebGPU from SwiftShader: nothing errors, and the numbers
// become a CPU rasteriser's. `adapter.info` reads swiftshader/google without them and
// nvidia/turing with them, and every arm's adapter is published in the summary either way.
const QUALIFIED_WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--use-vulkan",
  "--disable-vulkan-surface",
  "--no-sandbox",
];
// The one policy that replaces the resolve's whole fragment after setup, so no pixel it draws came
// from the instrumented predicate the rejection counter samples. Its counter share is unavailable and
// is reported as such: the arm is still qualified, by the staleness of the 95% blend it really drew.
const FRAGMENT_OVERRIDDEN = "unchecked-history";
/** Both families' uncontrolled arms reduce to the same policy name, as the fixture itself does. */
const overridesFragment = (variant: string) =>
  variant.replace(/^quality-/u, "").replace(/-open$/u, "") === FRAGMENT_OVERRIDDEN;
const frames: Record<string, ILinearFrame[]> = {};
const provenance = [];
const rasters: Record<string, unknown> = {};
const counters: Record<string, unknown> = {};
const qualityCorpus: Record<string, unknown> = {};
const velocityDiagnostics: Record<
  string,
  Array<{ label: string; velocity: IVelocityProbe | null }>
> = {};
let poses: unknown[] | undefined;
let recompileObserved = false;
// Each family scores against its own 4x supersampled reference: the quality family adds authored
// alpha-tested foliage, so a reference without it would score that content as pure error.
const FAMILIES: Record<string, string[]> = {
  motion: [
    "supersampled",
    "reference",
    "temporal",
    "zero-velocity",
    "unchecked-history",
    "dynamic-instances",
    "strict-rejection",
    "recompile",
    "temporal-open",
    "strict-rejection-open",
    "unchecked-history-open",
    "nearest-history",
    "nearest-history-open",
    "resolve-linear",
    "resolve-cubic",
    "resolve-cubic-open",
    "resolve-cubic-strict",
    "resolve-cubic-strict-open",
    "resolve-cubic-strict-zero",
    "resolve-cubic-strict-ordinary",
    "resolve-cubic-strict-ordinary-open",
    "resolve-cubic-strict-ordinary-zero",
  ],
  quality: [
    "quality-supersampled",
    "quality-reference",
    "quality-spatial",
    "quality-temporal",
    "quality-zero-velocity",
    "quality-unchecked-history",
    "quality-temporal-open",
    "quality-zero-velocity-open",
    "quality-unchecked-history-open",
  ],
};
const REFERENCE: Record<string, string> = {
  motion: "supersampled",
  quality: "quality-supersampled",
};
const CAUSAL: Record<string, string[]> = {
  motion: [
    "temporal",
    "strict-rejection",
    "unchecked-history",
    "nearest-history",
    "resolve-cubic",
    "resolve-cubic-strict",
    "resolve-cubic-strict-ordinary",
  ],
  quality: ["quality-temporal", "quality-zero-velocity", "quality-unchecked-history"],
};
for (const [family, arms] of Object.entries(FAMILIES))
  for (const variant of arms) {
    const artifactDirectory = path.join(output, variant);
    await mkdir(artifactDirectory, { recursive: true });
    const scale = variant.endsWith("supersampled") ? 4 : 1;
    // One declared raster per arm, from the fixture's own roles. The off roles request no stage and
    // no velocity MRT at all; the spatial role still renders and presents its low input, so its
    // input raster is the low one rather than absent.
    const role = variant.replace(/^quality-/u, "").replace(/-open$/u, "");
    const spatial = family === "quality" && role === "spatial";
    const off = role === "reference" || role === "supersampled" || spatial;
    const input: [number, number] =
      family === "quality" && role !== "reference" && role !== "supersampled"
        ? [426, 240]
        : [640 * scale, 360 * scale];
    const scenarioPath = path.join(artifactDirectory, "scenario.json");
    await writeFile(
      scenarioPath,
      JSON.stringify(
        { ...scenario, viewport: { width: 640 * scale, height: 360 * scale } },
        null,
        2,
      ),
    );
    const report = await runStandalonePlaytest({
      allowSoftwareAdapter: true,
      artifactDirectory,
      browserArgs: [...WEBGPU_BROWSER_ARGS, ...QUALIFIED_WEBGPU_ARGS],
      headless: false,
      port: 0,
      projectPath: path.join(root, "examples/abyss-framework"),
      scenarioPath,
      server: {
        command:
          "pnpm exec vite build --config temporal.vite.config.ts && pnpm exec vite preview --config temporal.vite.config.ts --host 127.0.0.1 --port $PORT --strictPort",
        timeoutMs: 60_000,
      },
      timeoutMs: 120_000,
      trace: false,
      url: `http://127.0.0.1:5173/temporal.html?measure&variant=${variant}${RAW4 ? "&raw4" : ""}`,
    }).catch(async (error: unknown) => {
      await writeFile(
        path.join(artifactDirectory, "failure.json"),
        JSON.stringify(
          { variant, error: error instanceof Error ? error.stack : String(error) },
          null,
          2,
        ),
      );
      throw error;
    });
    await writeFile(path.join(artifactDirectory, "report.json"), JSON.stringify(report, null, 2));
    requireTemporalRenderEvidence(report, variant);
    const series = report.observations?.resourceSeries;
    assert.ok(series);
    assert.equal(series.length, 16, `${variant}: every captured frame needs an observation`);
    const currentPoses = [];
    const hashes = [];
    const currentFrames: ILinearFrame[] = [];
    frames[variant] = currentFrames;
    for (let index = 0; index < 16; index++) {
      const frame = index + 21;
      const sample:
        | { label: string; tick: number; snapshots: Record<string, unknown> }
        | undefined = series[index];
      assert.ok(sample);
      const observed = sample.snapshots.temporal as {
        frame: number;
        pose: unknown;
        occluderVisible: boolean;
        raster: {
          displayWidth: number;
          displayHeight: number;
          inputWidth: number | null;
          inputHeight: number | null;
        };
        quality: {
          role: string;
          foliageCards: number;
          alphaTest: number;
          leafTextureSize: number;
        } | null;
        stages: string[];
        velocity: { source: string | null };
        rejectionFrames: Array<{
          frame: number;
          displayWidth: number;
          displayHeight: number;
          fraction: number | null;
          visited: number | null;
          staleFrames: number | null;
        }>;
        aa: {
          frame: number;
          inputWidth: number;
          inputHeight: number;
          outputWidth: number;
          outputHeight: number;
          resetReason: string | null;
          rejectionUnavailable?: string;
        } | null;
      };
      assert.equal(sample.label, `frame-${frame}`);
      assert.equal(sample.tick, frame);
      assert.equal(observed.frame, frame);
      assert.equal(observed.occluderVisible, frame <= 28 && !variant.endsWith("-open"));
      // The actual physical rasters, not the scale that was requested.
      assert.deepEqual(
        [observed.raster.displayWidth, observed.raster.displayHeight],
        [640 * scale, 360 * scale],
        `${variant}: display raster`,
      );
      assert.deepEqual(
        [observed.raster.inputWidth, observed.raster.inputHeight],
        input,
        `${variant}: input raster`,
      );
      // An off role must genuinely request nothing: no installed stage and no velocity MRT.
      assert.deepEqual(observed.stages, off ? [] : ["traa"], `${variant}: installed stages`);
      assert.equal(observed.velocity.source, off ? null : "mrt", `${variant}: velocity MRT source`);
      // The counter is this frame's own settled GPU measurement, and its visited count is the
      // display raster the resolve actually walked. Two roles legitimately carry none: an off role
      // has no resolve at all, and the fragment-overridden control drew pixels the instrumented
      // predicate never evaluated. Every other temporal arm must still publish a real one, so a
      // default sample that went missing fails instead of passing as unavailable.
      const rejection = observed.rejectionFrames.at(-1);
      if (off) {
        assert.equal(rejection, undefined, `${variant}: no resolve means no rejection counter`);
        assert.equal(
          observed.aa?.rejectionUnavailable,
          undefined,
          `${variant}: an off role has no fragment override to blame`,
        );
      } else if (overridesFragment(variant)) {
        assert.equal(
          rejection,
          undefined,
          `${variant}: a fragment-overridden control must publish no counter share`,
        );
        // The fixture owns the reason text, so the scorer checks that one was published rather than
        // repeating a string here and letting the two drift.
        assert.equal(
          typeof observed.aa?.rejectionUnavailable === "string" &&
            observed.aa.rejectionUnavailable.length > 0,
          true,
          `${variant}: the unavailable counter must name why`,
        );
      } else {
        assert.equal(rejection?.frame, frame, `${variant}: counter must belong to this frame`);
        assert.equal(rejection?.fraction !== null && rejection?.fraction !== undefined, true);
        assert.equal(
          rejection?.visited,
          640 * 360,
          `${variant}: counter must count display pixels`,
        );
        assert.deepEqual(
          [rejection?.displayWidth, rejection?.displayHeight],
          [640, 360],
          `${variant}: counted raster`,
        );
        assert.equal(
          observed.aa?.rejectionUnavailable,
          undefined,
          `${variant}: an instrumented resolve must not report its counter unavailable`,
        );
      }
      // The quality corpus is the only added content: authored alpha-tested foliage, no canvas.
      if (family === "quality") {
        // The 4x arm is the family's reference role rendered at four times the display raster.
        assert.equal(
          observed.quality?.role,
          role === "supersampled" ? "reference" : role,
          `${variant}: quality role`,
        );
        assert.ok(
          (observed.quality?.foliageCards ?? 0) > 0 && (observed.quality?.alphaTest ?? 0) > 0,
          `${variant}: alpha-tested foliage required`,
        );
      } else assert.equal(observed.quality, null, `${variant}: quality corpus must stay isolated`);
      currentPoses.push(observed.pose);
      if (off) {
        assert.equal(observed.aa, null, `${variant}: an off role has no provider report`);
      } else {
        assert.ok(observed.aa);
        assert.equal(observed.aa.frame, frame, `${variant}: actual resolves must match simulation`);
        assert.deepEqual(
          [observed.aa.inputWidth, observed.aa.inputHeight],
          input,
          `${variant}: resolve input raster`,
        );
        assert.deepEqual(
          [observed.aa.outputWidth, observed.aa.outputHeight],
          [640, 360],
          `${variant}: a low input must still present the display raster`,
        );
        assert.equal(
          observed.aa.resetReason,
          null,
          "Disocclusion must not be hidden by a global reset",
        );
      }
      const filename = `frame-${frame}.png`;
      const bytes = await readFile(path.join(artifactDirectory, filename));
      const stats = assertCaptureNotBlank(bytes, `${variant}/${filename}`);
      assert.deepEqual([stats.width, stats.height], [640 * scale, 360 * scale]);
      currentFrames.push(linearFrame(PNG.sync.read(bytes), 640, 360));
      hashes.push({ frame, filename, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    if (poses)
      assert.deepEqual(currentPoses, poses, `${variant}: exact same camera/object poses required`);
    else poses = currentPoses;
    const last = series.at(-1)?.snapshots.temporal as {
      setupCount: number;
      setupDuringJitter: number;
      raster: unknown;
      rejectionFrames: Array<{
        frame: number;
        fraction: number | null;
        visited: number | null;
        staleFrames: number | null;
      }>;
      aa: { rejectionUnavailable?: string } | null;
      quality: unknown;
    };
    rasters[variant] = last.raster;
    // The published counter trace states the unavailability instead of an empty series a reader could
    // mistake for a frame that counted nothing.
    counters[variant] = overridesFragment(variant)
      ? { unavailable: last.aa?.rejectionUnavailable ?? null }
      : last.rejectionFrames.map(({ frame, fraction, visited, staleFrames }) => ({
          frame,
          fraction,
          visited,
          staleFrames,
        }));
    qualityCorpus[variant] = last.quality;
    velocityDiagnostics[variant] = series.map(({ label, snapshots }) => ({
      label,
      velocity: (snapshots.temporal as { velocityProbe: IVelocityProbe | null }).velocityProbe,
    }));
    if (variant === "recompile") {
      const observed = series.at(-1)?.snapshots.temporal as {
        setupCount: number;
        setupDuringJitter: number;
      };
      recompileObserved = observed.setupCount > 1 && observed.setupDuringJitter > 0;
    }
    provenance.push({ variant, capture: report.capture, hashes });
  }
const results: Record<string, ReturnType<typeof measureSequence>> = {};
const causalReveals: Record<string, ReturnType<typeof measureCausalReveal>> = {};
for (const [family, arms] of Object.entries(FAMILIES)) {
  const referenceName = REFERENCE[family];
  const reference = referenceName === undefined ? undefined : frames[referenceName];
  assert.ok(referenceName && reference);
  for (const variant of arms) {
    if (variant === referenceName || variant.endsWith("-open")) continue;
    const sequence = frames[variant];
    assert.ok(sequence);
    results[variant] = measureSequence(reference, sequence, 8);
  }
  for (const policy of CAUSAL[family] ?? []) {
    const candidate = frames[policy];
    const open = frames[`${policy}-open`];
    assert.ok(candidate && open, `Matched open-history control missing: ${policy}`);
    causalReveals[policy] = measureCausalReveal(reference, candidate, open, 8);
  }
}
const temporal = results.temporal;
const baseline = results.reference;
const unchecked = results["unchecked-history"]?.reveal[1];
const zeroVelocity = results["zero-velocity"];
assert.ok(temporal && baseline && unchecked && zeroVelocity);
assert.ok(
  temporal.movingEdgeError !== null && zeroVelocity.movingEdgeError !== null,
  "Moving-object edges must be measurable",
);
const temporalVelocity = velocityDiagnostics.temporal;
assert.ok(temporalVelocity && temporalVelocity.length === 16);
for (const { velocity } of temporalVelocity) {
  assert.ok(velocity && velocity.samples.length === 3, "Three actual MRT surface probes required");
  assert.ok(velocity.samples.every((sample) => Number.isFinite(sample.errorPixels)));
}
// The quality family holds every original threshold: 5% edge and instability improvement over its
// own full-resolution no-AA arm, at most 1% stale interior pixels after one frame, and both negative
// controls. Its one new named comparison is the one its Phase 2 box states: temporal against the
// low-resolution spatial arm, on the same input raster, content, timings and seed.
const qualityTemporal = results["quality-temporal"];
const qualityBaseline = results["quality-reference"];
const qualitySpatial = results["quality-spatial"];
const qualityUnchecked = results["quality-unchecked-history"]?.reveal[1];
const qualityZeroVelocity = results["quality-zero-velocity"];
assert.ok(
  qualityTemporal && qualityBaseline && qualitySpatial && qualityUnchecked && qualityZeroVelocity,
  "Quality family measurements required",
);
assert.ok(
  qualityTemporal.movingEdgeError !== null && qualityZeroVelocity.movingEdgeError !== null,
  "Quality moving-object edges must be measurable",
);
// Pinned before the first runtime measurement. These are a narrow-fixture experimental bar,
// not a claim of general image quality, native qualification or saved GPU time.
const checks = {
  causalNegativeControl:
    causalReveals["unchecked-history"]?.every((frame) => frame.redTintFraction > 0.1) === true,
  recompileObserved,
  recompileVelocity:
    velocityDiagnostics.recompile?.every(({ velocity }) => {
      const rigid = velocity?.samples.find(({ name }) => name === "rigid");
      return velocity?.projectionError === 0 && rigid !== undefined && rigid.errorPixels < 0.01;
    }) === true,
  velocityProjection: temporalVelocity.every(({ velocity }) => {
    const rigid = velocity?.samples.find(({ name }) => name === "rigid");
    return velocity?.projectionError === 0 && rigid !== undefined && rigid.errorPixels < 0.01;
  }),
  edgeImprovement: temporal.edgeError < baseline.edgeError * 0.95,
  stabilityImprovement: temporal.residualInstability < baseline.residualInstability * 0.95,
  revealRecovery: temporal.reveal.slice(1).every((frame) => frame.staleFraction <= 0.01),
  uncheckedHistoryDetected: unchecked.staleFraction > 0.1,
  zeroVelocityDetected: zeroVelocity.movingEdgeError > temporal.movingEdgeError * 1.02,
  qualityEdgeImprovement: qualityTemporal.edgeError < qualityBaseline.edgeError * 0.95,
  qualityStabilityImprovement:
    qualityTemporal.residualInstability < qualityBaseline.residualInstability * 0.95,
  qualityBeatsSpatialStability:
    qualityTemporal.residualInstability < (qualitySpatial.residualInstability ?? 0) * 0.95,
  qualityRevealRecovery: qualityTemporal.reveal
    .slice(1)
    .every((frame) => frame.staleFraction <= 0.01),
  qualityUncheckedHistoryDetected: qualityUnchecked.staleFraction > 0.1,
  qualityZeroVelocityDetected:
    (qualityZeroVelocity.movingEdgeError ?? 0) >
    (qualityTemporal.movingEdgeError ?? Number.POSITIVE_INFINITY) * 1.02,
};
const linearProof = provenance.find((arm) => arm.variant === "resolve-linear");
const installedProof = provenance.find((arm) => arm.variant === "temporal");
assert.ok(linearProof && installedProof);
const authoredLinearEquivalent = linearProof.hashes.every(
  (frame, index) => frame.sha256 === installedProof.hashes[index]?.sha256,
);
const candidates = Object.fromEntries(
  ["resolve-cubic", "resolve-cubic-strict", "resolve-cubic-strict-ordinary"].map((name) => {
    const result = results[name];
    assert.ok(result);
    return [
      name,
      {
        qualification:
          name === "resolve-cubic"
            ? "Diagnostic only: no matched zero-velocity control; excluded from qualification"
            : name === "resolve-cubic-strict-ordinary"
              ? "Diagnostic ordinary-blend experiment with matched open-history and zero-velocity controls; all original quality bars retained"
              : "Candidate measurement with a matched zero-velocity control; all reported checks still required",
        authoredLinearEquivalent,
        edgeImprovement: result.edgeError < baseline.edgeError * 0.95,
        stabilityImprovement: result.residualInstability < baseline.residualInstability * 0.95,
        revealRecovery: result.reveal.slice(1).every((frame) => frame.staleFraction <= 0.01),
        causalRedRecovery: causalReveals[name]
          ?.slice(1)
          .every((frame) => frame.redTintFraction <= 0.01),
        // Both comparisons are reported: a sharper edge alone is insufficient for qualification.
        excursionsNoWorseThanNoAA:
          result.neighbourhoodOvershootFraction <= baseline.neighbourhoodOvershootFraction,
        excursionsNoWorseThanInstalled:
          result.neighbourhoodOvershootFraction <= temporal.neighbourhoodOvershootFraction,
        matchedZeroVelocityDetected:
          name !== "resolve-cubic"
            ? (results[`${name}-zero`]?.movingEdgeError ?? 0) >
              (result.movingEdgeError ?? Number.POSITIVE_INFINITY) * 1.02
            : null,
      },
    ];
  }),
);
const fenceRegion = { x: 165, y: 140, width: 55, height: 55 };
// Each arm's fence profile is measured against its own family's supersampled reference.
const fenceProfiles = Object.fromEntries(
  Object.entries(frames).map(([name, sequence]) => [
    name,
    sequence.map((frame, index) => {
      const family = name.startsWith("quality-") ? "quality" : "motion";
      const referenceName = REFERENCE[family];
      const reference = referenceName === undefined ? undefined : frames[referenceName];
      return {
        frame: index + 21,
        ...measureBlueProfile(frame, fenceRegion, reference?.[index]?.rgb[2] ?? Number.NaN),
      };
    }),
  ]),
);
const summary = {
  qualification:
    "Matched full-resolution AA measurement, plus the bounded quality family (authored alpha-tested foliage, a low-resolution spatial input and a low-input temporal resolve). Software WebGPU only; no native, reconstruction or GPU performance claim.",
  method: {
    width: 640,
    height: 360,
    referenceRasterScale: 4,
    qualityFamily:
      "One family on the same scene, poses, occluder and frame schedule: display raster 640x360 for every arm, input raster 426x240 (2/3) for the spatial and temporal roles and their controls, 1:1 for the full-resolution no-AA role, and 4x supersampled reference arms downsampled by the scorer. The off roles install no reconstruction stage and no velocity MRT at all.",
    colourSpace: "linear RGB decoded from opaque sRGB screenshots",
    frames: [21, 36],
    revealFrame: 29,
    edgeGradientThreshold: 0.08,
    neighbourhoodExcursionTolerance: 0.01,
    neighbourhoodExcursionRegion:
      "pre-reveal pixels, local 3x3 reference RGB bounds; diagnostic proxy, not causal ringing classification",
    ghostInteriorInset: 2,
    staleColourWeightThreshold: 0.1,
    minimumRelativeImprovement: 0.05,
    maximumStaleFractionAfterOneFrame: 0.01,
    zeroVelocityMinimumRelativeDegradation: 0.02,
    movingEdgeRegion: "reference RGB saturation above 0.25 excluding the red reveal marker",
    maximumRigidVelocityErrorPixels: 0.01,
    fenceProfile: {
      region: fenceRegion,
      method:
        "Diagnostic only: mean linear blue per column, then sum(columnMean - matching reference pixel(0,0).blue); signed deficits are not clamped. All 16 frames reported; no change to quality gates.",
    },
  },
  negativeControl:
    "unchecked-history renders a 95% unchecked history blend; it bypasses both depth rejection and neighbourhood clipping and does not isolate their individual effects",
  counterAvailability:
    "Every temporal arm publishes its real per-frame GPU rejection share (source frame, visited display pixels, finite source age). The two unchecked-history arms publish none: that control replaces the resolve fragment outright, so its pixels never evaluated the instrumented history-validity predicate the counter samples. Their counters[variant] carries the reason instead of a share, which is why their counters[variant] is an object rather than a series. This is an unavailable measurement, not a measured zero.",
  causalMethod:
    "Each policy is paired with the same temporal sequence whose red marker was never drawn. Positive red excess subtracts any positive shared green/blue change, normalised by marker red minus control red. This diagnostic separates red tint from neutral brightening/darkening; the original projection score and gate remain unchanged.",
  ordinaryBlendExperiment:
    "resolve-cubic-strict-ordinary changes only the final blend from luminance-reweighted flickerReduction to mix(clippedHistoryColor, currentColor, currentWeight). The previously computed currentWeight, sampling, clipping, rejection, jitter and history are identical. Fence profiles are diagnostic; a local contrast gain cannot qualify the whole image.",
  authoredLinearEquivalent,
  candidates,
  fenceProfiles,
  checks,
  results,
  causalReveals,
  rasters,
  counters,
  qualityCorpus,
  provenance,
  velocityDiagnostics,
};
console.log(
  JSON.stringify({ checks, authoredLinearEquivalent, candidates, results, causalReveals }, null, 2),
);
await writeTemporalMotionSummary(path.join(output, "summary.json"), summary);
