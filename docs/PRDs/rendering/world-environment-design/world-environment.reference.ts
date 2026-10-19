/**
 * NOT EXPORTED FROM `src/index.ts`, AND MUST NOT BE UNTIL AN OWNER DECIDES.
 *
 * `CHARTER.md` lists **"Post-processing composition"** in the *framework must never own*
 * column, and states that the column is a narrowing by *kind*, not a widening by degree.
 * This module composes a post-processing order, so it lands on the wrong side of that line
 * by name — even though it passes the charter's own hard veto test, because a game using it
 * still chooses every stage, strength, colour, exposure and tone curve, and can change the
 * appearance completely without editing framework code.
 *
 * That tension is real and is not mine to resolve. It is written up in
 * `docs/PRDs/lighting/PRD-266`, with the evidence in
 * `docs/verification/lighting-chain-2026-08-30.md`: four upstream defaults that each read as
 * "the stage is on and does nothing", and a node-graph shape that renders a blank frame. The
 * argument for the framework owning this is that no game can be expected to discover any of
 * them, and every game that composes these nodes hits all of them. The argument against is
 * the charter sentence above. `packages/core/AGENTS.md` says the closed list changes only
 * with a PRD *and* a line in `CHARTER.md`; the PRD exists and the charter line does not.
 *
 * Until then this file is proof that the design works and nothing more: it is unreachable
 * from the public API, and its tests are the specification of what the framework version
 * would have to guarantee.
 *
 * ---
 *
 * `WorldEnvironment` — which lighting stages a scene runs, in what order, and an honest
 * report of which of them actually ran.
 *
 * The name is Godot's, and so are the property names wherever Godot has one: its
 * `WorldEnvironment` node holds exactly this — the set of effects a scene is lit through and
 * how strong each is. Three.js's node names win for stages Godot has no equivalent for
 * (`ssgi`, `gtao`). Nothing here is a new word. `Environment` alone was rejected because
 * `scene.environment` in Three.js is a texture.
 *
 * **This module owns no appearance.** Which stages a game turns on, at what strength, in
 * what colour, and how it tonemaps, are all arguments supplied by generated game source in
 * `src/render/`. What lives here is the part no game should have to write twice: the
 * canonical order, the capability check, the quality ladder, and the reporting.
 *
 * The planner below is deliberately pure — no renderer, no nodes, no GPU. That is what
 * makes the ordering and the fail-closed behaviour testable in a node environment, and it
 * is where every rule that matters actually lives.
 */

/**
 * The canonical order, and the only order.
 *
 * Ambient occlusion has to reach the GI gather, the gather has to reach the denoiser, the
 * denoiser has to precede the temporal resolve, and everything has to precede tonemapping.
 * Getting it wrong produces a frame that is dim, or noisy, or ghosting, with nothing in it
 * to say which — so the caller does not get to choose.
 */
export const WORLD_ENVIRONMENT_STAGES = [
  "gtao",
  "ssgi",
  "denoise",
  "godrays",
  "ssr",
  "bloom",
] as const;

export type WorldEnvironmentStage = (typeof WORLD_ENVIRONMENT_STAGES)[number];

/** Godot's `Environment.tonemap_mode`, restricted to the curves Three.js ships. */
export type TonemapMode = "aces" | "agx" | "neutral";

export type QualityTier = "high" | "medium" | "low" | "off";

/**
 * The quality ladder, pre-registered in one constant block.
 *
 * Same shape as `RESOLUTION_SCALER`'s rungs and for the same reason: a controller tuned
 * inside its own implementation until a playtest went green is a controller nobody can
 * argue with afterwards. The SSGI numbers are the presets `SSGINode`'s own documentation
 * recommends for the temporally-filtered case, not values invented here.
 */
export const WORLD_ENVIRONMENT_TIERS = {
  high: {
    ssgi: { sliceCount: 3, stepCount: 16 },
    godrays: { steps: 60 },
    ssr: { resolutionScale: 1 },
  },
  medium: {
    ssgi: { sliceCount: 2, stepCount: 8 },
    godrays: { steps: 32 },
    ssr: { resolutionScale: 0.5 },
  },
  low: {
    ssgi: { sliceCount: 1, stepCount: 12 },
    godrays: { steps: 16 },
    ssr: { resolutionScale: 0.5 },
  },
  off: {
    ssgi: { sliceCount: 1, stepCount: 12 },
    godrays: { steps: 12 },
    ssr: { resolutionScale: 0.5 },
  },
} as const;

/**
 * Upstream defaults that are wrong for any scene larger than a tabletop.
 *
 * Each of these was found by building a real interior and watching a stage do nothing:
 *
 * - `SSRNode.maxDistance` defaults to `1` — one world unit. Every reflection ray dies
 *   within a metre of its origin, so nothing stands in the floor.
 * - `SSRNode` `reflectNonMetals` defaults to `false`. Polished stone is not a metal, so
 *   even with the ray distance corrected nothing reflects.
 *
 * A game cannot be expected to know either. The correct thing is the default here.
 */
export const SSR_DEFAULTS = {
  /** Multiplied by the caller's scene radius; upstream's `1` is the bug this replaces. */
  maxDistance: 1,
  reflectNonMetals: true,
} as const;

export interface IStageRequest {
  /** Quality tier for stages that take sample counts. Defaults to the environment's tier. */
  readonly quality?: QualityTier;
  /** `ssr` only: how far a reflection ray may travel, in world units. */
  readonly sceneRadius?: number;
  /** `godrays` only: whether the light it marches against casts a shadow map. */
  readonly lightCastsShadow?: boolean;
  /** `godrays` only: named in the drop reason, so the report points at a specific light. */
  readonly lightName?: string;
}

/** A request is a partial map of stage to its settings. Absent means "not requested". */
export type WorldEnvironmentRequest = Partial<Record<WorldEnvironmentStage, IStageRequest>>;

export interface ITargetCapabilities {
  /** `renderer.kind` — only `"webgpu"` can execute a TSL node graph. */
  readonly rendererKind: string;
}

export interface IAppliedStage {
  readonly stage: WorldEnvironmentStage;
  readonly settings: Readonly<Record<string, number | boolean>>;
}

export interface IDroppedStage {
  readonly stage: WorldEnvironmentStage;
  /** Never blank. A dropped stage that does not say why is indistinguishable from an unused one. */
  readonly reason: string;
}

export interface IWorldEnvironmentPlan {
  readonly tier: QualityTier;
  readonly applied: readonly IAppliedStage[];
  readonly dropped: readonly IDroppedStage[];
}

const STAGE_SET = new Set<string>(WORLD_ENVIRONMENT_STAGES);

function stageOrder(stage: WorldEnvironmentStage): number {
  return WORLD_ENVIRONMENT_STAGES.indexOf(stage);
}

type Preset = (typeof WORLD_ENVIRONMENT_TIERS)[QualityTier];

/**
 * Fail closed on anything the caller could have typo'd.
 *
 * A typo that silently became `medium` is a quality setting nobody can trust afterwards and
 * no gate can catch, so an unknown name throws rather than being skipped or clamped.
 */
function assertRequestIsKnown(request: WorldEnvironmentRequest, tier: QualityTier): void {
  const tiers = Object.keys(WORLD_ENVIRONMENT_TIERS).join(", ");
  for (const [name, settings] of Object.entries(request)) {
    if (!STAGE_SET.has(name)) {
      throw new Error(
        `Unknown WorldEnvironment stage '${name}'. Known stages: ${WORLD_ENVIRONMENT_STAGES.join(", ")}.`,
      );
    }
    const quality = settings?.quality;
    if (quality !== undefined && WORLD_ENVIRONMENT_TIERS[quality] === undefined) {
      throw new Error(`Unknown quality '${quality}' on stage '${name}'. Known tiers: ${tiers}.`);
    }
  }
  if (WORLD_ENVIRONMENT_TIERS[tier] === undefined) {
    throw new Error(`Unknown WorldEnvironment tier '${tier}'. Known tiers: ${tiers}.`);
  }
}

/** Why this stage cannot run, or `undefined` when it can. Never returns a blank reason. */
function dropReason(
  stage: WorldEnvironmentStage,
  settings: IStageRequest,
  ssgiRequested: boolean,
): string | undefined {
  if (stage === "denoise" && !ssgiRequested) {
    return "nothing to denoise: ssgi was not requested";
  }
  if (stage === "godrays" && settings.lightCastsShadow === false) {
    // The pass raymarches the light's shadow map — the shaft is the volume the map reports
    // as lit. A light that casts no shadow yields a black pass, which would read as
    // "godrays are on and do nothing".
    const name = settings.lightName ?? "unnamed";
    return `light '${name}' does not cast shadows, so there is no shadow map to raymarch`;
  }
  return undefined;
}

/** The settings a stage runs with, resolved from its tier and the game's own arguments. */
function stageSettings(
  stage: WorldEnvironmentStage,
  settings: IStageRequest,
  preset: Preset,
): Readonly<Record<string, number | boolean>> {
  if (stage === "ssgi") {
    return { sliceCount: preset.ssgi.sliceCount, stepCount: preset.ssgi.stepCount };
  }
  if (stage === "godrays") return { steps: preset.godrays.steps };
  if (stage === "ssr") {
    return {
      // Scene-scaled, because upstream's default of 1 world unit is the difference between
      // reflections and no reflections on any real interior.
      maxDistance: settings.sceneRadius ?? SSR_DEFAULTS.maxDistance,
      reflectNonMetals: SSR_DEFAULTS.reflectNonMetals,
      resolutionScale: preset.ssr.resolutionScale,
    };
  }
  return {};
}

/** Resolves a request against a target into an ordered plan. */
export function planWorldEnvironment(
  request: WorldEnvironmentRequest,
  capabilities: ITargetCapabilities,
  tier: QualityTier = "medium",
): IWorldEnvironmentPlan {
  assertRequestIsKnown(request, tier);

  const requested = (Object.keys(request) as WorldEnvironmentStage[]).sort(
    (a, b) => stageOrder(a) - stageOrder(b),
  );
  if (requested.length === 0) return { tier: "off", applied: [], dropped: [] };

  // Everything below is a TSL node graph installed through `setOutputNode`, which throws on
  // any renderer that is not WebGPU. Say so once per requested stage rather than returning
  // in silence, which is what the templates did before this existed.
  if (capabilities.rendererKind !== "webgpu") {
    const reason = `renderer kind is '${capabilities.rendererKind}', not 'webgpu'`;
    return { tier: "off", applied: [], dropped: requested.map((stage) => ({ stage, reason })) };
  }

  const applied: IAppliedStage[] = [];
  const dropped: IDroppedStage[] = [];
  const ssgiRequested = request.ssgi !== undefined;

  for (const stage of requested) {
    const settings = request[stage] ?? {};
    const reason = dropReason(stage, settings, ssgiRequested);
    if (reason !== undefined) {
      dropped.push({ stage, reason });
      continue;
    }
    const preset = WORLD_ENVIRONMENT_TIERS[settings.quality ?? tier];
    applied.push({ stage, settings: stageSettings(stage, settings, preset) });
  }

  return { tier, applied, dropped };
}
