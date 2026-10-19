import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { classifyGpu } from "../../core/src/gpu-class.js";
import { evaluateRichPlaytestAssertions, loadPlaytestScenario } from "../src/index.js";
import { classifyAdapter, nativeCaptureProvenance } from "../src/evaluators/adapter-class.js";
import type { IPlaytestRenderChainObservation } from "../src/protocol.js";
import type { IPlaytestCaptureProvenance, IPlaytestReport } from "../src/report.js";

/** The two chains the starter's own quality policy ships, as CI observed them. */
const HIGH: IPlaytestRenderChainObservation = {
  contributions: [
    { graphOutputChanged: true, name: "ambientOcclusion" },
    { graphOutputChanged: true, name: "bloom" },
    { graphOutputChanged: true, name: "vignette" },
  ],
  dropped: [],
  requested: ["ambientOcclusion", "bloom", "vignette"],
  source: "pinned",
  stages: ["ambientOcclusion", "bloom", "vignette"],
  tier: "high",
  velocity: { measurementFrame: 4, provisioned: false, required: false, source: null },
};
const LOW: IPlaytestRenderChainObservation = {
  contributions: [
    { graphOutputChanged: true, name: "bloom" },
    { graphOutputChanged: true, name: "vignette" },
    { graphOutputChanged: true, name: "antialias" },
  ],
  dropped: [],
  requested: ["bloom", "vignette", "antialias"],
  source: "pinned",
  stages: ["bloom", "vignette", "antialias"],
  tier: "low",
  velocity: { measurementFrame: 4, provisioned: false, required: false, source: null },
};

const SWIFTSHADER: IPlaytestCaptureProvenance["adapter"] = {
  architecture: "swiftshader",
  vendor: "google",
};
const TURING: IPlaytestCaptureProvenance["adapter"] = {
  architecture: "turing",
  vendor: "nvidia",
};

function report(
  renderChain: IPlaytestRenderChainObservation | undefined,
  capture?: IPlaytestCaptureProvenance,
): IPlaytestReport {
  return {
    ...(capture === undefined ? {} : { capture }),
    diagnostics: [],
    distance: 0,
    entity: "proof",
    expectMoved: false,
    frames: 2,
    observations: {
      console: [],
      hud: {},
      network: [],
      resources: {},
      renderChain,
    },
    trivialityOptOuts: [],
  };
}

function capture(adapter: IPlaytestCaptureProvenance["adapter"]): IPlaytestCaptureProvenance {
  return {
    adapter,
    browserArgs: [],
    captureMethod: "page.screenshot",
    rendererKind: "webgpu",
    target: "browser",
    viewport: { height: 720, width: 1280 },
  };
}

async function load(value: unknown) {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const directory = await makeTempDir("tn-render-chain-adapter-");
  const file = join(directory, "scenario.json");
  await writeFile(file, JSON.stringify(value));
  return loadPlaytestScenario(directory, "scenario.json");
}

const SCENARIO = (renderChain: unknown) => ({
  assert: { renderChain },
  name: "starter-look",
  schemaVersion: 1,
  steps: [{ kind: "wait", label: "settles", release: true, waitTicks: 1 }],
  subject: "player",
  target: "web",
  viewport: { height: 720, width: 1280 },
  warmupFrames: 0,
});

/** The starter `look` shape: flat high for hardware, the existing low policy for software. */
const ASSERTION = {
  contributions: { graphOutputChanged: ["ambientOcclusion", "bloom", "vignette"] },
  perAdapter: {
    software: {
      contributions: { graphOutputChanged: ["bloom", "vignette", "antialias"] },
      stages: {
        includes: ["bloom", "vignette", "antialias"],
        order: ["bloom", "vignette", "antialias"],
      },
      tier: "low",
    },
  },
  stages: { includes: ["ambientOcclusion", "bloom", "vignette"], order: ["ambientOcclusion", "bloom", "vignette"] },
  tier: "high",
};

describe("renderChain perAdapter selection", () => {
  it("holds a hardware run to the flat high policy", async () => {
    const scenario = await load(SCENARIO(ASSERTION));
    const result = evaluateRichPlaytestAssertions({ report: report(HIGH, capture(TURING)), scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
    expect(result.assertions).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({ adapterClass: "hardware" }),
        id: "renderChain.tier",
        pass: true,
      }),
    );
  });

  it("holds a software browser run to the software low policy, with its own provenance", async () => {
    const scenario = await load(SCENARIO(ASSERTION));
    const result = evaluateRichPlaytestAssertions({ report: report(LOW, capture(SWIFTSHADER)), scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
    // Every render row carries the harness's own reading, so a low tier on a software adapter is
    // distinguishable from a low tier a game chose for itself on a real GPU.
    for (const id of ["renderChain.tier", "renderChain.stages.order", "renderChain.contributions.graphOutputChanged"]) {
      expect(result.assertions).toContainEqual(
        expect.objectContaining({
          details: expect.objectContaining({ adapterClass: "software", softwareAdapter: "swiftshader" }),
          id,
          pass: true,
        }),
      );
    }
  });

  it("classifies a native run's software adapter the same way, from its own provenance", async () => {
    const scenario = await load({
      ...SCENARIO(ASSERTION),
      target: "desktop",
    });
    // The native host reports the same four adapter.info fields, so the classification is the
    // harness's and does not depend on which target produced the run.
    const native = { ...capture(SWIFTSHADER), target: "desktop" };
    const result = evaluateRichPlaytestAssertions({ report: report(LOW, native), scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
    expect(result.assertions).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({ adapterClass: "software" }),
        id: "renderChain.tier",
        pass: true,
      }),
    );
  });

  it("fails a software run that ran the hardware policy, rather than accepting either", async () => {
    const scenario = await load(SCENARIO(ASSERTION));
    const result = evaluateRichPlaytestAssertions({ report: report(HIGH, capture(SWIFTSHADER)), scenario });

    expect(result.assertions).toContainEqual(expect.objectContaining({ id: "renderChain.tier", pass: false }));
    expect(result.diagnostics.map((entry) => entry.code)).toContain("TN_PLAYTEST_RENDER_CHAIN_TIER_FAILED");
  });

  it("fails a hardware run whose chain dropped the asserted stages and their contributions", async () => {
    const scenario = await load(SCENARIO(ASSERTION));
    const partial = {
      ...HIGH,
      contributions: (HIGH.contributions ?? []).filter((entry) => entry.name !== "ambientOcclusion"),
      dropped: [{ name: "ambientOcclusion", reason: "budget" }],
      stages: ["bloom", "vignette"],
    };
    const result = evaluateRichPlaytestAssertions({ report: report(partial, capture(TURING)), scenario });

    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "renderChain.stages.includes", pass: false }),
    );
    expect(result.diagnostics.map((entry) => entry.code)).toContain("TN_PLAYTEST_RENDER_CHAIN_STAGES_FAILED");
  });

  it("fails a software run whose chain dropped a software-branch stage", async () => {
    const scenario = await load(SCENARIO(ASSERTION));
    const partial = {
      ...LOW,
      contributions: (LOW.contributions ?? []).filter((entry) => entry.name !== "antialias"),
      dropped: [{ name: "antialias", reason: "budget" }],
      stages: ["bloom", "vignette"],
    };
    const result = evaluateRichPlaytestAssertions({ report: report(partial, capture(SWIFTSHADER)), scenario });

    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "renderChain.stages.order", pass: false }),
    );
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "renderChain.contributions.graphOutputChanged", pass: false }),
    );
  });

  // `capture.rendererKind` is a fact about the canvas. Four provenance shapes carry that marker
  // without naming an adapter, and all four used to classify `hardware`. The last one is the shape
  // a real capture actually has: `readCaptureProvenance` adds `features` and `limit.*` beside the
  // four identity fields, so an object full of non-identity text is the common case, not a corner.
  it.each([
    ["no adapter object", undefined],
    ["an empty adapter object", {}],
    ["an adapter that named nothing", { architecture: "", description: "", device: "", vendor: "" }],
    [
      "only the metadata a real capture adds beside its identity fields",
      {
        architecture: "",
        description: "",
        device: "",
        features: "timestamp-query",
        "limit.maxBindGroups": "4",
        "limit.maxTextureDimension2D": "8192",
        vendor: "",
      },
    ],
  ])("refuses to call hardware a run whose capture reports %s", async (_name, adapter) => {
    const scenario = await load(SCENARIO(ASSERTION));
    const result = evaluateRichPlaytestAssertions({
      report: report(HIGH, {
        ...capture(TURING),
        adapter: adapter as IPlaytestCaptureProvenance["adapter"],
      }),
      scenario,
    });

    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "renderChain.adapterClass", pass: false }),
    );
    // No row may carry a hardware verdict from a provenance that observed nothing.
    expect(
      result.assertions.flatMap((row) => [row.details?.adapterClass]),
    ).not.toContain("hardware");
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "TN_PLAYTEST_RENDER_CHAIN_ADAPTER_UNCLASSIFIED",
    );
  });

  it("does not let an unclassified adapter satisfy the software branch", async () => {
    const scenario = await load(SCENARIO(ASSERTION));
    const result = evaluateRichPlaytestAssertions({ report: report(LOW, capture(TURING)), scenario });

    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "renderChain.tier", pass: false }),
    );
  });

  it("fails once, by name, when the run reported no adapter at all", async () => {
    const scenario = await load(SCENARIO(ASSERTION));
    const result = evaluateRichPlaytestAssertions({ report: report(LOW), scenario });

    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "renderChain.adapterClass", pass: false }),
    );
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "TN_PLAYTEST_RENDER_CHAIN_ADAPTER_UNCLASSIFIED",
    );
  });

  it("leaves a flat-only scenario alone when the run reported no adapter", async () => {
    const scenario = await load(SCENARIO({ tier: "high" }));
    const result = evaluateRichPlaytestAssertions({ report: report(HIGH), scenario });

    // No perAdapter means no adapter question was asked, so no adapterClass row is invented.
    expect(result.assertions.map((row) => row.id)).not.toContain("renderChain.adapterClass");
    expect(result.assertions).toContainEqual(expect.objectContaining({ id: "renderChain.tier", pass: true }));
  });

  // A typo one level down is the same defect as a typo at the top: it names no stage, no
  // contribution and no ceiling, while reading as an assertion that did. Every nested type is
  // checked on both the flat form and the branch, through the one shared check.
  it.each([
    ["stages", { includes: ["bloom"] }, "includess"],
    ["contributions", { graphOutputChanged: ["bloom"] }, "graphOutputchange"],
    ["velocity", { maxRejectionFraction: 0.5 }, "maxRejectionfraction"],
  ])("rejects a typo in nested %s on both the flat form and a branch", async (_name, nested, typo) => {
    await expect(load(SCENARIO({ stages: { [typo]: ["bloom"] } }))).rejects.toThrow(
      new RegExp(`stages\\.${typo}`, "u"),
    );
    await expect(load(SCENARIO({ contributions: { [typo]: ["bloom"] } }))).rejects.toThrow(
      new RegExp(`contributions\\.${typo}`, "u"),
    );
    await expect(load(SCENARIO({ velocity: { [typo]: 0.5 } }))).rejects.toThrow(
      new RegExp(`velocity\\.${typo}`, "u"),
    );
    await expect(
      load(SCENARIO({ perAdapter: { software: { stages: { [typo]: ["bloom"] } } } })),
    ).rejects.toThrow(new RegExp(`perAdapter\\.software\\.stages\\.${typo}`, "u"));
    await expect(
      load(SCENARIO({ perAdapter: { hardware: { contributions: { [typo]: ["bloom"] } } } })),
    ).rejects.toThrow(new RegExp(`perAdapter\\.hardware\\.contributions\\.${typo}`, "u"));
    await expect(
      load(SCENARIO({ perAdapter: { software: { velocity: { [typo]: 0.5 } } } })),
    ).rejects.toThrow(new RegExp(`perAdapter\\.software\\.velocity\\.${typo}`, "u"));
    expect(nested).toBeTruthy();
  });

  it("rejects an empty, unknown, nested, or mistyped per-adapter branch at load", async () => {
    const cases: [string, unknown, RegExp][] = [
      ["empty", {}, /must assert tier, stages, contributions, or velocity/u],
      ["empty perAdapter", { perAdapter: {} }, /must name at least one adapter class/u],
      ["unknown class", { perAdapter: { imaginary: { tier: "low" } } }, /perAdapter\.imaginary/u],
      ["unknown branch key", { perAdapter: { software: { tiers: "low" } } }, /perAdapter\.software\.tiers/u],
      [
        "nested",
        { perAdapter: { software: { perAdapter: { software: { tier: "low" } } } } },
        /perAdapter\.software\.perAdapter/u,
      ],
      ["wrong-typed branch", { perAdapter: { software: "low" } }, /perAdapter\.software' must be an object/u],
    ];
    for (const [name, renderChain, message] of cases) {
      await expect(load(SCENARIO(renderChain))).rejects.toThrow(message);
      expect(name).not.toBe("");
    }
  });

  it("rejects a perAdapter-only assertion that asserts nothing on any branch", async () => {
    await expect(load(SCENARIO({ perAdapter: { software: { tier: "low" } } }))).rejects.toThrow(
      /must assert tier, stages, contributions, or velocity/u,
    );
  });
  // A native run carries its adapter identity in the census the engine already built from its own
  // `requestAdapter().info` read, not in a browser capture session. Before this, `buildReport` was
  // called on the device path without a capture at all, so EVERY device run reached
  // `classifyAdapter` with nothing to read and `perAdapter` could never apply — the flat `high` was
  // used against a `low` tier a software adapter had legitimately produced. These are the real
  // shapes: the identity string core builds, on the snapshot that carries it.
  describe("native adapter provenance from the pipeline census", () => {
    const CENSUS_IDENTITY = [
      "webgpu:architecture=swiftshader",
      "description=Swift%20Shader%20Device%20(Subzero)",
      "device=llvmpipe",
      "vendor=google",
    ].join("|");

    function censusReport(
      identity: unknown,
      renderChain: IPlaytestRenderChainObservation = LOW,
    ): IPlaytestReport {
      return {
        capture: nativeCaptureProvenance(
          { adapter: { identity, thermal: "unavailable" } } as never,
          "desktop",
          { height: 720, width: 1280 },
        ),
        diagnostics: [],
        distance: 0,
        entity: "proof",
        expectMoved: false,
        frames: 2,
        observations: { console: [], hud: {}, network: [], resources: {}, renderChain },
        trivialityOptOuts: [],
      };
    }

    it("classifies a native software adapter and applies its own branch", async () => {
      const scenario = await load(SCENARIO(ASSERTION));
      const result = evaluateRichPlaytestAssertions({ report: censusReport(CENSUS_IDENTITY), scenario });

      expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
      expect(result.assertions).toContainEqual(
        expect.objectContaining({
          details: expect.objectContaining({ adapterClass: "software" }),
          id: "renderChain.tier",
          pass: true,
        }),
      );
    });

    it("classifies a native hardware adapter and keeps the flat high policy", async () => {
      const scenario = await load(SCENARIO(ASSERTION));
      const hardware = CENSUS_IDENTITY.replace(/swiftshader|llvmpipe|google|Subzero/gu, "x");
      const report = {
        ...censusReport("webgpu:architecture=turing|description=NVIDIA%3A%20615.71.09|device=NVIDIA%20GeForce%20RTX%202080|vendor=nvidia"),
        observations: { console: [], hud: {}, network: [], resources: {}, renderChain: HIGH },
      };
      expect(hardware).not.toBe(CENSUS_IDENTITY);
      const result = evaluateRichPlaytestAssertions({ report, scenario });

      expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
      expect(result.assertions).toContainEqual(
        expect.objectContaining({
          details: expect.objectContaining({ adapterClass: "hardware" }),
          id: "renderChain.tier",
          pass: true,
        }),
      );
    });

    // The writer omits a field the adapter left empty and emits the identity as soon as one field is
    // populated, so these are the shapes it really writes. Demanding all four refused the engine's
    // own report: a software host whose adapter names only `architecture` and `vendor` was left
    // unclassified, and the `low` tier it honestly produced was held to the flat `high`.
    it.each<[string, string, "hardware" | "software", IPlaytestRenderChainObservation]>([
      ["a two-field software identity", "webgpu:architecture=swiftshader|vendor=google", "software", LOW],
      ["a one-field hardware identity", "webgpu:vendor=nvidia", "hardware", HIGH],
      ["a three-field hardware identity", "webgpu:architecture=turing|description=NVIDIA|device=RTX", "hardware", HIGH],
    ])("classifies %s from the report the producer wrote", async (
      _name,
      identity,
      adapterClass,
      renderChain,
    ) => {
      const scenario = await load(SCENARIO(ASSERTION));
      const native = censusReport(identity, renderChain);
      const result = evaluateRichPlaytestAssertions({ report: native, scenario });

      expect(native.capture?.adapter).toEqual(
        Object.fromEntries(identity.slice("webgpu:".length).split("|").map((pair) => pair.split("="))),
      );
      expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
      expect(result.assertions).toContainEqual(
        expect.objectContaining({
          details: expect.objectContaining({ adapterClass }),
          id: "renderChain.tier",
          pass: true,
        }),
      );
    });

    // Malformed, empty or absent provenance is the unclassified answer, which fails a `perAdapter`
    // scenario closed. A fallback that guessed from those would hand a machine a hardware verdict
    // from a reading that observed nothing.
    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["not this shape", "turing"],
      ["another renderer kind", "webgl2:architecture=turing|description=x|device=y|vendor=nvidia"],
      ["an empty field", "webgpu:architecture=|description=NVIDIA|device=RTX|vendor=nvidia"],
      ["an undecodable value", "webgpu:architecture=%E0%A4%A|description=N|device=R|vendor=nvidia"],
      // A repeated key is the identity that names a CPU rasteriser first and a real GPU second.
      // Last-one-wins turned that into a hardware verdict off the fields that followed.
      [
        "a repeated field that would erase the software name",
        "webgpu:architecture=swiftshader|architecture=turing|description=NVIDIA|device=RTX|vendor=nvidia",
      ],
      [
        "a repeated field on a native identity that began on a GPU",
        "webgpu:architecture=turing|architecture=swiftshader|description=N|device=R|vendor=nvidia",
      ],
      ["an unknown key beside the four", "webgpu:architecture=swiftshader|description=x|device=y|vendor=google|features=timestamp-query"],
      ["a __proto__ pair beside the four", "webgpu:architecture=swiftshader|description=x|device=y|vendor=google|__proto__=bogus"],
    ])("leaves a native run with %s identity unclassified, and fails a perAdapter scenario", async (
      _name,
      identity,
    ) => {
      const scenario = await load(SCENARIO(ASSERTION));
      const report = censusReport(identity);
      expect(report.capture).toBeUndefined();

      const result = evaluateRichPlaytestAssertions({ report, scenario });
      expect(result.assertions).toContainEqual(
        expect.objectContaining({ id: "renderChain.adapterClass", pass: false }),
      );
    });

    // The browser path is untouched by this: a browser report without its own capture stays
    // unclassified, because nothing on it is an independent engine reading of the adapter.
    it("leaves a browser report with no capture of its own unclassified", async () => {
      const scenario = await load(SCENARIO(ASSERTION));
      const result = evaluateRichPlaytestAssertions({ report: report(LOW), scenario });

      expect(result.assertions).toContainEqual(
        expect.objectContaining({ id: "renderChain.adapterClass", pass: false }),
      );
    });
  });
});

// The templates start each GPU family at its own tier (`START_TIER_BY_GPU_CLASS`), so a scenario
// that asserts a flat `high` for every real GPU fails on a laptop iGPU and on a phone. These rows
// are the family tiers the template table names, written in the scenario and never read back from
// what the game printed. `classifyAdapter` proves the family from the four `adapter.info` fields
// alone, with its own copy of the rules core's `classifyGpu` holds.
const MEDIUM: IPlaytestRenderChainObservation = { ...HIGH, tier: "medium" };
const FAMILY_ASSERTION = {
  perAdapter: {
    integrated: { tier: "medium" },
    "mobile-high": { tier: "medium" },
    "mobile-low": { tier: "low" },
    "mobile-mid": { tier: "low" },
    software: { tier: "low" },
  },
  tier: "high",
};

const IRIS_XE = { architecture: "gen-12lp", vendor: "intel" };
const ARC_A770 = { architecture: "xe-hpg", description: "Intel(R) Arc(tm) A770 Graphics", vendor: "intel" };
const MALI_G715 = { description: "Mali-G715-Immortalis MC11", vendor: "arm" };
const MALI_G78 = { architecture: "valhall", description: "Mali-G78", vendor: "arm" };
const MALI_G52 = { architecture: "bifrost", description: "Mali-G52 MC2", vendor: "arm" };
const APPLE = { architecture: "common-3", vendor: "apple" };

describe("renderChain perAdapter GPU families", () => {
  it.each<[string, Record<string, string>, IPlaytestRenderChainObservation, string | undefined]>([
    ["an Intel Iris Xe laptop", IRIS_XE, MEDIUM, "integrated"],
    ["a Mali-G715 phone", MALI_G715, MEDIUM, "mobile-high"],
    ["a Mali-G78 phone", MALI_G78, LOW, "mobile-mid"],
    ["a Mali-G52 phone", MALI_G52, LOW, "mobile-low"],
    // An Arc card is `discrete`: no integrated row may catch it, and the flat `high` stays its policy.
    ["an Intel Arc card", ARC_A770, HIGH, "discrete"],
    ["an RTX card", TURING, HIGH, "discrete"],
    // No family rule names Apple Silicon, so it keeps the flat policy it had before families existed.
    ["an adapter no family rule names", APPLE, HIGH, undefined],
  ])("holds %s to the tier its family starts at", async (_name, adapter, renderChain, gpuFamily) => {
    const scenario = await load(SCENARIO(FAMILY_ASSERTION));
    const result = evaluateRichPlaytestAssertions({ report: report(renderChain, capture(adapter)), scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
    // No family is reported rather than a guessed one when no rule matched.
    const provenance = gpuFamily === undefined ? { adapterClass: "hardware" } : { adapterClass: "hardware", gpuFamily };
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ details: expect.objectContaining(provenance), id: "renderChain.tier", pass: true }),
    );
    if (gpuFamily === undefined) {
      expect(classifyAdapter(report(renderChain, capture(adapter)))).not.toHaveProperty("gpuFamily");
    }
  });

  // A family row replaces the flat policy for that family only, so the policy it replaced cannot
  // pass beside it: an iGPU that stayed on `high` is no longer the template's start.
  it.each<[string, Record<string, string>, IPlaytestRenderChainObservation]>([
    ["an integrated GPU on the flat high", IRIS_XE, HIGH],
    ["a mobile-high phone on the flat high", MALI_G715, HIGH],
    ["a mobile-low phone on medium", MALI_G52, MEDIUM],
    ["an Arc card dropped below high", ARC_A770, MEDIUM],
    ["an adapter no family rule names, below the flat high", APPLE, MEDIUM],
  ])("fails %s", async (_name, adapter, renderChain) => {
    const scenario = await load(SCENARIO(FAMILY_ASSERTION));
    const result = evaluateRichPlaytestAssertions({ report: report(renderChain, capture(adapter)), scenario });

    expect(result.assertions).toContainEqual(expect.objectContaining({ id: "renderChain.tier", pass: false }));
  });

  it("keeps a scenario with only hardware and software rows on its old selection", async () => {
    const scenario = await load(SCENARIO({ perAdapter: { software: { tier: "low" } }, tier: "high" }));
    // Without a family row an Iris Xe is the generic hardware policy, exactly as before families.
    const result = evaluateRichPlaytestAssertions({ report: report(HIGH, capture(IRIS_XE)), scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
    expect(result.assertions).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({ adapterClass: "hardware", gpuFamily: "integrated" }),
        id: "renderChain.tier",
        pass: true,
      }),
    );
  });

  it("lets a hardware row apply to a family it names no row for", async () => {
    const scenario = await load(
      SCENARIO({ perAdapter: { hardware: { tier: "medium" }, integrated: { tier: "low" } }, tier: "high" }),
    );
    const result = evaluateRichPlaytestAssertions({ report: report(MEDIUM, capture(TURING)), scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
  });

  // The shipped files, not a copy of their shape: the real `renderChain` block of the starter's
  // `play` and `look` scenarios goes through the real loader and the evaluator, against the adapter
  // fields the Iris Xe laptop and the Pixel 8 report. The flat `high` alone failed both.
  const LOOK_HIGH_STAGES = ["ambientOcclusion", "bloom", "vignette", "grade", "grain"];
  const LOOK_LOW_STAGES = ["bloom", "vignette", "antialias", "grade"];
  const lookChain = (tier: "high" | "low" | "medium"): IPlaytestRenderChainObservation => {
    const stages = tier === "low" ? LOOK_LOW_STAGES : LOOK_HIGH_STAGES;
    return {
      ...HIGH,
      contributions: stages.map((name) => ({ graphOutputChanged: true, name })),
      requested: stages,
      stages,
      tier,
    };
  };
  const shipped = async (relative: string) => {
    const { readFile } = await import("node:fs/promises");
    const file = fileURLToPath(new URL(`../../create-threenative/${relative}`, import.meta.url));
    const parsed = JSON.parse(await readFile(file, "utf8")) as { assert: { renderChain: unknown } };
    return load(SCENARIO(parsed.assert.renderChain));
  };
  const STARTER_PLAY = "templates/starter/playtests/play.playtest.json";
  const STARTER_LOOK = "template-playtests/starter/look.playtest.json";

  it.each<[string, string, Record<string, string>, IPlaytestRenderChainObservation, boolean]>([
    ["play on an Iris Xe", STARTER_PLAY, IRIS_XE, MEDIUM, true],
    ["play on a Mali-G715", STARTER_PLAY, MALI_G715, MEDIUM, true],
    ["play on a Mali-G78", STARTER_PLAY, MALI_G78, LOW, true],
    ["play on a Mali-G52", STARTER_PLAY, MALI_G52, LOW, true],
    ["play on an RTX card", STARTER_PLAY, TURING, HIGH, true],
    ["play on an Iris Xe that stayed on high", STARTER_PLAY, IRIS_XE, HIGH, false],
    ["look on an Iris Xe", STARTER_LOOK, IRIS_XE, lookChain("medium"), true],
    ["look on a Mali-G715", STARTER_LOOK, MALI_G715, lookChain("medium"), true],
    ["look on a Mali-G52", STARTER_LOOK, MALI_G52, lookChain("low"), true],
    ["look on an RTX card", STARTER_LOOK, TURING, lookChain("high"), true],
    ["look on an Iris Xe that stayed on high", STARTER_LOOK, IRIS_XE, lookChain("high"), false],
  ])("holds the shipped starter %s to its own table", async (_name, relative, adapter, renderChain, passes) => {
    const scenario = await shipped(relative);
    const result = evaluateRichPlaytestAssertions({ report: report(renderChain, capture(adapter)), scenario });
    const rows = result.assertions.filter((row) => row.id.startsWith("renderChain."));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.pass === true)).toBe(passes);
  });

  // The four scenarios that once asserted a flat `high` alone. Each reports the stages its own
  // template authors at that tier: the starter drops ambientOcclusion and grain at low, while
  // sailing's bloom and rain's stormPost run at every tier, so their rows keep the stage check.
  it.each<[string, string, string[], string[]]>([
    ["starter native render-chain", "templates/starter/native-playtests/render-chain.playtest.json", LOOK_HIGH_STAGES, ["bloom", "vignette", "antialias", "grade"]],
    ["sailing native survives", "templates/sailing/native-playtests/survives.playtest.json", ["bloom"], ["bloom"]],
    ["rain native boot", "templates/rain/native-playtests/boot.playtest.json", ["stormPost"], ["stormPost"]],
    ["rain performance", "templates/rain/playtests/performance.playtest.json", ["stormPost"], ["stormPost"]],
  ])("holds the shipped %s scenario to the tier each adapter starts on", async (_name, relative, upperStages, lowStages) => {
    const scenario = await shipped(relative);
    const observed = (tier: "high" | "low" | "medium"): IPlaytestRenderChainObservation => {
      const stages = tier === "low" ? lowStages : upperStages;
      return { ...HIGH, contributions: stages.map((name) => ({ graphOutputChanged: true, name })), requested: stages, stages, tier };
    };
    const verdicts = (adapter: Record<string, string>, tier: "high" | "low" | "medium") => {
      const result = evaluateRichPlaytestAssertions({ report: report(observed(tier), capture(adapter)), scenario });
      const rows = result.assertions.filter((row) => row.id.startsWith("renderChain."));
      expect(rows.length).toBeGreaterThan(0);
      return rows.every((row) => row.pass === true);
    };

    expect(verdicts(IRIS_XE, "medium")).toBe(true);
    expect(verdicts(MALI_G715, "medium")).toBe(true);
    expect(verdicts(MALI_G78, "low")).toBe(true);
    expect(verdicts(MALI_G52, "low")).toBe(true);
    expect(verdicts(SWIFTSHADER, "low")).toBe(true);
    expect(verdicts(TURING, "high")).toBe(true);
    expect(verdicts(IRIS_XE, "high")).toBe(false);
    expect(verdicts(SWIFTSHADER, "high")).toBe(false);
  });

  it("keeps the starter native low row from accepting a chain that still runs occlusion or grain", async () => {
    const scenario = await shipped("templates/starter/native-playtests/render-chain.playtest.json");
    const stages = LOOK_HIGH_STAGES;
    const heldHigh: IPlaytestRenderChainObservation = {
      ...HIGH,
      contributions: stages.map((name) => ({ graphOutputChanged: true, name })),
      requested: stages,
      stages,
      tier: "low",
    };
    const result = evaluateRichPlaytestAssertions({ report: report(heldHigh, capture(MALI_G52)), scenario });

    expect(result.assertions).toContainEqual(expect.objectContaining({ id: "renderChain.stages.excludes", pass: false }));
  });

  it("never lets a software adapter take a family row from its vendor", async () => {
    const scenario = await load(SCENARIO(FAMILY_ASSERTION));
    const software = { architecture: "swiftshader", vendor: "intel" };
    const result = evaluateRichPlaytestAssertions({ report: report(LOW, capture(software)), scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
    expect(result.assertions).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({ adapterClass: "software" }),
        id: "renderChain.tier",
        pass: true,
      }),
    );
    expect(classifyAdapter(report(LOW, capture(software)))).toEqual({
      adapterClass: "software",
      softwareAdapter: "swiftshader",
    });
  });

  it("proves a native run's family from the census identity it already carries", async () => {
    const scenario = await load(SCENARIO(FAMILY_ASSERTION));
    const native = report(MEDIUM, nativeCaptureProvenance(
      { adapter: { identity: "webgpu:description=Mali-G715-Immortalis%20MC11|vendor=arm" } },
      "android",
      { height: 720, width: 1280 },
    ));
    const result = evaluateRichPlaytestAssertions({ report: native, scenario });

    expect(result.assertions.filter((row) => row.pass === false)).toEqual([]);
    expect(classifyAdapter(native)).toEqual({ adapterClass: "hardware", gpuFamily: "mobile-high" });
  });

  // Missing fields prove nothing: a family rule that needs a field the platform did not report
  // never matches, and a run that named no adapter at all stays unclassified (fails closed).
  it.each<[string, Record<string, string>]>([
    ["only an unrecognised vendor", { vendor: "acme" }],
    ["a Tegra under an NVIDIA vendor", { description: "NVIDIA Tegra Orin", vendor: "nvidia" }],
    ["a Mali architecture with the vendor missing", { architecture: "bifrost" }],
    ["an Adreno family with no number", { description: "Adreno", vendor: "qualcomm" }],
    ["fields that are blank", { architecture: " ", description: "", device: "\t", vendor: " " }],
  ])("proves no family from %s", (_name, adapter) => {
    const classification = classifyAdapter(report(HIGH, capture(adapter)));

    expect(classification).not.toHaveProperty("gpuFamily");
  });

  it("leaves an adapter that named nothing unclassified, with no family", () => {
    expect(classifyAdapter(report(HIGH, capture({})))).toEqual({});
    expect(classifyAdapter(report(HIGH, capture({ architecture: "", vendor: "" })))).toEqual({});
  });

  // The copy in this package and core's table answer from the same fields, so the harness cannot
  // hold a run to a family the template did not start it at. `unknown` and `software` carry no family.
  it.each<[string, Record<string, string>]>([
    ["RTX 2080, Chrome", TURING],
    ["RTX 4090, native", { description: "NVIDIA GeForce RTX 4090", vendor: "NVIDIA" }],
    ["RTX 2080 on the Android emulator", { architecture: "unknown", description: "615.71.09", device: "NVIDIA GeForce RTX 2080", vendor: "NVIDIA" }],
    ["SwiftShader", SWIFTSHADER],
    ["llvmpipe", { description: "llvmpipe (LLVM 17)", vendor: "mesa" }],
    ["Iris Xe", IRIS_XE],
    ["Arc A770", ARC_A770],
    ["Intel with only a vendor", { vendor: "intel" }],
    ["Radeon RX 7800 XT", { architecture: "rdna-3", description: "AMD Radeon RX 7800 XT", vendor: "amd" }],
    ["Ryzen iGPU", { architecture: "rdna-2", description: "AMD Radeon(TM) Graphics", vendor: "amd" }],
    ["Mali-G715", MALI_G715],
    ["Mali-G52", MALI_G52],
    ["Mali-G78", MALI_G78],
    ["Mali by architecture only", { architecture: "bifrost", vendor: "arm" }],
    ["Adreno 5xx", { description: "Adreno (TM) 540", vendor: "qualcomm" }],
    ["Adreno 650", { description: "Adreno (TM) 650", vendor: "qualcomm" }],
    ["Adreno 618", { description: "Adreno (TM) 618", vendor: "qualcomm" }],
    ["Adreno 740 by architecture", { architecture: "adreno-7xx", vendor: "qualcomm" }],
    ["Adreno 4xx", { description: "Adreno (TM) 430", vendor: "qualcomm" }],
    ["Apple Silicon", APPLE],
    ["Tegra", { description: "NVIDIA Tegra Orin", vendor: "nvidia" }],
  ])("agrees with core's classifyGpu on %s", (_name, adapter) => {
    const core = classifyGpu(adapter).class;
    const classification = classifyAdapter(report(HIGH, capture(adapter)));

    if (core === "software") {
      expect(classification.adapterClass).toBe("software");
      expect(classification).not.toHaveProperty("gpuFamily");
    } else {
      expect(classification.adapterClass).toBe("hardware");
      expect(classification.gpuFamily).toBe(core === "unknown" ? undefined : core);
    }
  });

  it("accepts every family key beside hardware and software at load", async () => {
    const rows = Object.fromEntries(
      ["discrete", "hardware", "integrated", "mobile-high", "mobile-low", "mobile-mid", "software"].map(
        (key) => [key, { tier: "low" }],
      ),
    );
    await expect(load(SCENARIO({ perAdapter: rows, tier: "high" }))).resolves.toBeDefined();
  });

  it("rejects a mistyped family key, and a typo inside a family row, at load", async () => {
    await expect(load(SCENARIO({ perAdapter: { mobile_high: { tier: "medium" } } }))).rejects.toThrow(
      /perAdapter\.mobile_high/u,
    );
    await expect(load(SCENARIO({ perAdapter: { integrated: { tiers: "medium" } } }))).rejects.toThrow(
      /perAdapter\.integrated\.tiers/u,
    );
    await expect(
      load(SCENARIO({ perAdapter: { "mobile-high": { stages: { includess: ["bloom"] } } } })),
    ).rejects.toThrow(/perAdapter\.mobile-high\.stages\.includess/u);
  });
});
