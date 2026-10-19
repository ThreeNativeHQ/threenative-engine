/**
 * Records RenderChain's ordering and per-stage decisions as a C++ table the native test compares
 * against (PRD-526 phase 1). Each configuration is driven through the real `RenderChain` with a
 * fake renderer, and the applied report (or the constructor's refusal message) is emitted as data.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/chain/chain-reference.ts
 *   ... -- --check   (fails when a committed table is not what chain.ts produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type IRenderChainRenderer,
  type IRenderChainStage,
  RenderChain,
} from "../../../../core/src/render/chain.js";
import { mrtVelocity } from "../../../../core/src/render/velocity.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "chain_reference.inc");

type Tier = "high" | "medium" | "low" | "off";
type Build = "same" | "new" | "nothing" | { throws: string; asError?: boolean };

interface IStageSpec {
  name: string;
  before?: string;
  after?: string;
  minimumTier?: Tier;
  available?: false | string;
  build?: Build;
}

interface IVelocitySpec {
  source?: "mrt" | "per-object";
  pass?: boolean;
  mrt?: boolean;
  objectFlags?: boolean;
  perObject?: boolean;
}

interface IConfig {
  name: string;
  rendererKind?: string;
  tier?: Tier;
  velocity?: IVelocitySpec;
  input?: unknown;
  stages: IStageSpec[];
  request: string[];
}

const fakePass = {
  getMRT: () => null,
  getTextureNode: () => ({}) as never,
  setMRT: () => undefined,
};

/** The minimal renderer the chain seam needs; `raw` has no MRT velocity. */
function fakeRenderer(kind: string): IRenderChainRenderer {
  return {
    kind: kind as never,
    raw: { mrt: new Set<string>() },
    setOutputNode: () => undefined,
  };
}

function toStage(spec: IStageSpec): IRenderChainStage {
  const kind = spec.build ?? "new";
  const build = (input: unknown): unknown => {
    if (kind === "same") return input;
    if (kind === "nothing") return undefined;
    if (typeof kind === "object") {
      if (kind.asError) throw new Error(kind.throws);
      throw kind.throws;
    }
    return { input, name: spec.name };
  };
  let available: IRenderChainStage["available"];
  if (spec.available === false) available = () => false;
  else if (typeof spec.available === "string") {
    const reason = spec.available;
    available = () => reason;
  }
  return {
    build,
    name: spec.name,
    ...(spec.before === undefined ? {} : { before: spec.before }),
    ...(spec.after === undefined ? {} : { after: spec.after }),
    ...(spec.minimumTier === undefined ? {} : { minimumTier: spec.minimumTier }),
    ...(available === undefined ? {} : { available }),
  };
}

interface IRecorded {
  refused: boolean;
  error: string;
  requested: string[];
  stages: string[];
  dropped: Array<{ name: string; reason: string }>;
  contributions: Array<{ name: string; graphOutputChanged: boolean }>;
  tier: Tier;
  velocityProvisioned: boolean;
  velocityRequired: boolean;
  velocitySource: string;
}

function record(config: IConfig): IRecorded {
  const velocity: Record<string, unknown> = {};
  if (config.velocity?.source !== undefined) velocity.source = config.velocity.source;
  // A game that hands the chain its scene pass also hands it core's velocity provision.
  if (config.velocity?.pass === true)
    Object.assign(velocity, { pass: fakePass, provision: mrtVelocity() });
  if (config.velocity?.mrt === true) velocity.mrt = true;
  if (config.velocity?.objectFlags === true) velocity.objectFlags = true;
  if (config.velocity?.perObject === true) velocity.perObject = true;

  try {
    const chain = new RenderChain(fakeRenderer(config.rendererKind ?? "webgpu"), {
      ...(config.input === undefined ? {} : { input: config.input }),
      report: () => undefined,
      request: { stages: config.request, tier: config.tier ?? "high", velocity },
      stages: config.stages.map(toStage),
    });
    const applied = chain.applied;
    return {
      contributions: applied.contributions.map((entry) => ({ ...entry })),
      dropped: applied.dropped.map((entry) => ({ ...entry })),
      error: "",
      refused: false,
      requested: [...applied.requested],
      stages: [...applied.stages],
      tier: applied.tier,
      velocityProvisioned: applied.velocity.provisioned,
      velocityRequired: applied.velocity.required,
      velocitySource: applied.velocity.source ?? "",
    };
  } catch (error) {
    return {
      contributions: [],
      dropped: [],
      error: `TN_RENDER_CHAIN_ORDER: ${error instanceof Error ? error.message : String(error)}`,
      refused: true,
      requested: [],
      stages: [],
      tier: config.tier ?? "high",
      velocityProvisioned: false,
      velocityRequired: false,
      velocitySource: "",
    };
  }
}

const CONFIGS: IConfig[] = [
  {
    name: "canonical-order",
    stages: [{ name: "ssgi" }, { name: "denoise" }, { name: "traa" }],
    request: ["traa", "ssgi", "denoise"],
    tier: "high",
    velocity: { mrt: true },
  },
  {
    name: "authored-after-builtin",
    stages: [{ name: "bloom" }, { name: "outline", after: "bloom" }, { name: "ssgi" }],
    request: ["outline", "bloom", "ssgi"],
  },
  {
    name: "authored-before-builtin",
    stages: [{ name: "bloom" }, { name: "outline", before: "bloom" }, { name: "ssgi" }],
    request: ["outline", "bloom", "ssgi"],
  },
  {
    name: "authored-after-authored",
    stages: [
      { name: "bloom" },
      { name: "outline", after: "bloom" },
      { name: "ink", after: "outline" },
    ],
    request: ["ink", "outline", "bloom"],
  },
  {
    name: "siblings-one-anchor",
    stages: [{ name: "bloom" }, { name: "paint", after: "bloom" }, { name: "ink", after: "bloom" }],
    request: ["ink", "paint", "bloom"],
  },
  {
    name: "tier-off",
    stages: [{ name: "ssgi" }, { name: "traa" }],
    request: ["ssgi", "traa"],
    tier: "off",
  },
  { name: "provider-missing", stages: [], request: ["ssgi"] },
  {
    name: "renderer-not-webgpu",
    rendererKind: "webgl2",
    stages: [{ name: "ssgi" }],
    request: ["ssgi"],
  },
  {
    name: "minimum-tier",
    stages: [{ name: "ssgi", minimumTier: "high" }],
    request: ["ssgi"],
    tier: "low",
  },
  // Every tier against every minimum: the drop happens exactly when the tier ranks below it.
  ...(["high", "medium", "low"] as const).flatMap((tier) =>
    (["high", "medium", "low"] as const).map((minimumTier) => ({
      name: `tier-${tier}-minimum-${minimumTier}`,
      stages: [{ name: "ssgi", minimumTier }],
      request: ["ssgi"],
      tier,
    })),
  ),
  { name: "velocity-missing", stages: [{ name: "traa" }], request: ["traa"] },
  {
    name: "velocity-source-explicit",
    stages: [{ name: "traa" }],
    request: ["traa"],
    velocity: { source: "mrt" },
  },
  {
    name: "velocity-source-per-object",
    stages: [{ name: "traa" }],
    request: ["traa"],
    velocity: { source: "per-object" },
  },
  {
    name: "velocity-mrt-flag",
    stages: [{ name: "taa" }],
    request: ["taa"],
    velocity: { mrt: true },
  },
  {
    name: "velocity-pass-flag",
    stages: [{ name: "traa" }],
    request: ["traa"],
    velocity: { pass: true },
  },
  {
    name: "velocity-per-object-flag",
    stages: [{ name: "motionBlur" }],
    request: ["motionBlur"],
    velocity: { perObject: true },
  },
  {
    name: "unavailable-false",
    stages: [{ name: "denoise", available: false }],
    request: ["denoise"],
  },
  {
    name: "unavailable-string",
    stages: [{ name: "bloom", available: "gpu:missing" }],
    request: ["bloom"],
  },
  {
    name: "build-throws-error",
    stages: [{ name: "bloom", build: { throws: "chain boom", asError: true } }],
    request: ["bloom"],
  },
  {
    name: "build-throws-string",
    stages: [{ name: "bloom", build: { throws: "boom-string" } }],
    request: ["bloom"],
  },
  {
    name: "build-returns-nothing",
    stages: [{ name: "bloom", build: "nothing" }],
    request: ["bloom"],
  },
  {
    name: "contributions",
    input: { name: "scene" },
    stages: [
      { name: "bloom", build: "same" },
      { name: "outline", after: "bloom" },
    ],
    request: ["outline", "bloom"],
  },
  {
    name: "partial-drop",
    stages: [
      { name: "bloom" },
      { name: "outline", after: "bloom", build: { throws: "outline boom", asError: true } },
      { name: "ssgi" },
    ],
    request: ["outline", "bloom", "ssgi"],
  },
  {
    name: "named-reasons",
    stages: [
      { name: "ssgi", minimumTier: "high" },
      { name: "denoise", available: false },
      { name: "bloom", available: "gpu:missing" },
    ],
    request: ["ssgi", "denoise", "bloom"],
    tier: "low",
  },
  {
    name: "anchor-cycle",
    stages: [
      { name: "ink", after: "paint" },
      { name: "paint", after: "ink" },
    ],
    request: ["ink", "paint"],
  },
  { name: "missing-definition", stages: [], request: ["outline"] },
];

const lit = (value: string | undefined | null): string =>
  value === undefined || value === null
    ? "nullptr"
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const stringArray = (values: string[]): string =>
  values.length === 0 ? "{nullptr}" : `{${values.map((value) => lit(value)).join(", ")}}`;

const lines = [
  "// Generated by packages/runtime-native/tests/native-engine/chain/chain-reference.ts from",
  "// packages/core/src/render/chain.ts. Do not edit: rerun the generator.",
  "// Each configuration is one real RenderChain run with a fake renderer; refusals carry the",
  "// TN_RENDER_CHAIN_ORDER code prefix.",
];

for (const [i, config] of CONFIGS.entries()) {
  const result = record(config);
  const velocity = config.velocity ?? {};
  lines.push(`static const char* const kRequested${i}[] = ${stringArray(config.request)};`);
  const stages = config.stages
    .map((stage) => {
      const availability =
        stage.available === false ? 1 : typeof stage.available === "string" ? 2 : 0;
      const buildKind = stage.build ?? "new";
      const build =
        typeof buildKind === "object"
          ? 2
          : buildKind === "same"
            ? 0
            : buildKind === "nothing"
              ? 3
              : 1;
      const buildError = typeof buildKind === "object" ? buildKind.throws : undefined;
      return `    {${lit(stage.name)}, ${lit(stage.before)}, ${lit(stage.after)}, ${lit(
        stage.minimumTier,
      )}, ${availability}, ${lit(typeof stage.available === "string" ? stage.available : undefined)}, ${build}, ${lit(
        buildError,
      )}, -1},`;
    })
    .join("\n");
  lines.push(
    `static const StageRow kStages${i}[] = {`,
    ...(config.stages.length === 0
      ? ["    {nullptr, nullptr, nullptr, nullptr, 0, nullptr, 1, nullptr, -1},"]
      : [stages]),
    "};",
    `static const char* const kRequestedOrder${i}[] = ${stringArray(result.requested)};`,
    `static const char* const kApplied${i}[] = ${stringArray(result.stages)};`,
    `static const DroppedRow kDropped${i}[] = {${
      result.dropped.length === 0
        ? "{nullptr, nullptr}"
        : result.dropped.map((entry) => `{${lit(entry.name)}, ${lit(entry.reason)}}`).join(", ")
    }};`,
    `static const ContributionRow kContribution${i}[] = {${
      result.contributions.length === 0
        ? "{nullptr, false}"
        : result.contributions
            .map((entry) => `{${lit(entry.name)}, ${entry.graphOutputChanged ? "true" : "false"}}`)
            .join(", ")
    }};`,
  );
  lines.push(
    `static const ChainCase kCase${i} = {${lit(config.name)}, ${lit(
      config.rendererKind ?? "webgpu",
    )}, ${lit(config.tier ?? "high")}, ${velocity.source !== undefined ? "true" : "false"}, ${lit(
      velocity.source,
    )}, ${velocity.pass === true ? "true" : "false"}, ${velocity.mrt === true ? "true" : "false"}, ${
      velocity.objectFlags === true ? "true" : "false"
    }, ${velocity.perObject === true ? "true" : "false"}, kRequested${i}, ${config.request.length}, kStages${i}, ${config.stages.length}, ${
      result.refused ? "true" : "false"
    }, ${lit(result.error)}, kRequestedOrder${i}, ${result.requested.length}, kApplied${i}, ${result.stages.length}, kDropped${i}, ${result.dropped.length}, kContribution${i}, ${result.contributions.length}, ${lit(
      result.tier,
    )}, ${result.velocityProvisioned ? "true" : "false"}, ${
      result.velocityRequired ? "true" : "false"
    }, ${lit(result.velocitySource)}};`,
  );
}
lines.push("static const ChainCase kCases[] = {");
for (const [i] of CONFIGS.entries()) lines.push(`    kCase${i},`);
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error("TN_FIXTURE_STALE: chain_reference.inc is not what chain.ts produces");
    process.exit(1);
  }
  console.log("current: chain_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
