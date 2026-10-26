import { softwareAdapterName } from "./browser.js";
import {
  type IFootSlideReading,
  type ISceneRoomSummary,
  formatRoomLines,
  readSceneRoom,
  roomWarnings,
} from "./sceneRoom.js";
import type {
  IPlaytestBridgeDescription,
  IPlaytestEntityObservation,
  IPlaytestObservationSnapshot,
  IPlaytestStartupObservation,
} from "../protocol.js";

/**
 * The scene, in a glance — what `threenative-playtest doctor --url` reports once it can reach a
 * running game.
 *
 * Everything here is derived from one bridge sample, and nothing is inferred beyond it: what the
 * bridge does not report is listed as unobserved rather than guessed at, because a confident number
 * with nothing behind it is exactly the failure this harness exists to prevent.
 */

export interface ISceneFrameStats {
  readonly brightPixelRatio: number;
  readonly distinctColors: number;
  readonly height: number;
  readonly luminanceStdDev: number;
  readonly width: number;
}

export interface IScenePageProbe {
  readonly adapter?: string;
  /** Raw `adapter.info`, so the shared software-adapter detector decides rather than a new regex. */
  readonly adapterInfo?: Readonly<Record<string, string>>;
  readonly canvas?: { dpr: number; height: number; width: number };
  readonly consoleErrors: readonly string[];
}

export interface ISceneProjectionDiagnostic {
  readonly batches?: number;
  readonly projecting?: boolean;
  readonly reason?: string;
  readonly reasonCode?: string;
  readonly sourceRenderables?: number;
}

export interface ISceneObservation {
  /** The engine's own render-projection report, if the page printed one. */
  readonly projection?: ISceneProjectionDiagnostic;
  readonly description?: IPlaytestBridgeDescription | { engine?: string; name?: string; version?: string };
  /** A screenshot's statistics, which is how a blank screen is told from a rendered one. */
  readonly frame?: ISceneFrameStats;
  readonly page?: IScenePageProbe;
  /** An earlier sample, so the report can say whether anything is actually moving. */
  readonly previous?: IPlaytestObservationSnapshot;
  readonly snapshot: IPlaytestObservationSnapshot;
  readonly startup?: IPlaytestStartupObservation;
  readonly startupMs?: number;
  readonly url: string;
}

export interface ISceneAxisExtent {
  readonly max: number;
  readonly min: number;
  readonly size: number;
}

export interface ISceneOverview {
  readonly entities: { hidden: number; observed: number; visible: number };
  readonly liveness: { live: boolean; moved: number; ticks?: number };
  readonly page?: IScenePageProbe;
  readonly projection?: { batches?: number; projecting?: boolean; reason?: string; reasonCode?: string; renderables?: number };
  readonly screen?: { blank: boolean; brightPixelRatio: number; distinctColors: number };
  readonly startup?: IPlaytestStartupObservation;
  readonly startupMs?: number;
  readonly warnings: readonly string[];
  readonly extents?: { x: ISceneAxisExtent; y: ISceneAxisExtent; z: ISceneAxisExtent };
  readonly gameplay: {
    clipsAdvancing: readonly string[];
    states: number;
    tags: Record<string, number>;
  };
  readonly notObserved: readonly string[];
  /**
   * Lights, materials, fog, background and camera framing, plus what the feet are doing against
   * the ground. Absent when the bridge does not report the scene — unobserved, never empty.
   */
  readonly room?: { slides: readonly IFootSlideReading[]; summary: ISceneRoomSummary };
  readonly render: {
    drawCalls?: number;
    fps?: number;
    frameMs?: number;
    /** The last sampled frame's draw calls and triangles per render pass. */
    passes?: readonly { draws: number; kind: string; triangles: number }[];
    triangles?: number;
    /** True when the frame time sits on a display refresh interval, so it is a cap, not a cost. */
    vsyncLocked?: boolean;
  };
  readonly runtime: {
    clock: string;
    consoleErrors: number;
    core?: string;
    rapier?: string | null;
    seed?: number | null;
    tick?: number;
  };
  readonly scale: { largestEntityScale?: number; medianEntityScale?: number; verdict: string };
  readonly url: string;
}

/**
 * The same threshold `threenative inspect` uses on an asset: past this, a "one unit is one metre"
 * reading stops being credible and centimetre-authored source is the likelier explanation.
 */
const CENTIMETRE_HEURISTIC_THRESHOLD = 10;

/** Fallback for a probe that only captured a joined adapter string. */
const SOFTWARE_ADAPTER_TEXT = /swiftshader|llvmpipe|lavapipe|software|basic render/iu;

/**
 * Common refresh intervals in milliseconds. A frame time sitting on one of these is the display
 * waiting, not the game costing — reporting it as cost has sent people optimising a scene that was
 * already idle most of the frame.
 */
const VSYNC_INTERVALS_MS = [8.33, 11.11, 16.67, 33.33] as const;

function onVsyncInterval(frameMs: number | undefined): boolean {
  return frameMs !== undefined && VSYNC_INTERVALS_MS.some((interval) => Math.abs(frameMs - interval) <= interval * 0.03);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function positions(entities: readonly IPlaytestEntityObservation[]): Array<[number, number, number]> {
  return entities
    .map(({ transform }) => transform?.position)
    .filter((position): position is [number, number, number] => Array.isArray(position) && position.length === 3);
}

function axisExtent(values: readonly number[]): ISceneAxisExtent {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { max, min, size: Number((max - min).toFixed(6)) };
}

function scaleMagnitudes(entities: readonly IPlaytestEntityObservation[]): number[] {
  return entities
    .map(({ transform }) => transform?.scale)
    .filter((scale): scale is [number, number, number] => Array.isArray(scale) && scale.length === 3)
    .map((scale) => Math.max(...scale.map((component) => Math.abs(component))));
}

function scaleVerdict(entities: readonly IPlaytestEntityObservation[]): ISceneOverview["scale"] {
  // A ground plane is legitimately huge, so the median entity carries the verdict and the largest
  // is reported beside it rather than deciding it.
  const magnitudes = scaleMagnitudes(entities);
  const middle = median(magnitudes);
  if (middle === undefined) return { verdict: "no entity scales observed" };
  const largest = Math.max(...magnitudes);
  return {
    largestEntityScale: largest,
    medianEntityScale: middle,
    verdict:
      middle > CENTIMETRE_HEURISTIC_THRESHOLD
        ? `median entity is ${middle}× — assets look centimetre-authored, so one unit is probably not one metre`
        : "consistent with metres",
  };
}

function countConsoleErrors(snapshot: IPlaytestObservationSnapshot): number {
  return (snapshot.diagnostics ?? []).filter((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const severity = (entry as { severity?: unknown }).severity;
    const type = (entry as { type?: unknown }).type;
    return severity === "error" || type === "error";
  }).length;
}

function entityPositions(
  snapshot: IPlaytestObservationSnapshot | undefined,
): Map<string, [number, number, number]> {
  const map = new Map<string, [number, number, number]>();
  for (const entity of snapshot?.entities ?? []) {
    const position = entity.transform?.position;
    if (Array.isArray(position) && position.length === 3) map.set(entity.id, position);
  }
  return map;
}

function liveness(observation: ISceneObservation): ISceneOverview["liveness"] {
  const { previous, snapshot } = observation;
  if (previous === undefined) return { live: true, moved: 0 };
  const before = entityPositions(previous);
  let moved = 0;
  for (const [id, position] of entityPositions(snapshot)) {
    const earlier = before.get(id);
    if (earlier === undefined) continue;
    if (position.some((value, axis) => Math.abs(value - (earlier[axis] as number)) > 1e-4)) moved += 1;
  }
  const ticks =
    snapshot.clock.tick === undefined || previous.clock.tick === undefined
      ? undefined
      : snapshot.clock.tick - previous.clock.tick;
  return { live: moved > 0 || (ticks ?? 0) > 0, moved, ...(ticks === undefined ? {} : { ticks }) };
}

/**
 * A frame with almost no distinct colours and no bright pixels is the black screen this harness
 * exists to catch — the failure that costs the most time because everything else reports fine.
 */
function screenVerdict(frame: ISceneFrameStats | undefined): ISceneOverview["screen"] {
  if (frame === undefined) return undefined;
  return {
    blank: frame.distinctColors <= 2 || (frame.brightPixelRatio <= 0.001 && frame.luminanceStdDev <= 0.01),
    brightPixelRatio: frame.brightPixelRatio,
    distinctColors: frame.distinctColors,
  };
}

function warningsFor(
  observation: ISceneObservation,
  overview: Omit<ISceneOverview, "warnings">,
): string[] {
  const warnings: string[] = [];
  if (overview.room !== undefined)
    warnings.push(...roomWarnings(overview.room.summary, overview.room.slides));
  if (overview.screen?.blank === true) {
    warnings.push("the frame is blank — the game is running but nothing reached the screen");
  }
  if (overview.render.drawCalls === 0) {
    warnings.push("0 draw calls: nothing drew in the sampled frame");
  }
  if (overview.render.vsyncLocked === true) {
    warnings.push(
      `${overview.render.frameMs?.toFixed(1)} ms/frame is a vsync interval, so it is the display's cap and not the game's cost — rerun with --browser-arg --disable-gpu-vsync --browser-arg --disable-frame-rate-limit to measure the real one`,
    );
  }
  if (observation.previous !== undefined && !overview.liveness.live) {
    warnings.push("the scene did not change between samples — the loop may be stopped or held");
  }
  if (overview.entities.observed > 0 && overview.entities.visible === 0) {
    warnings.push("every registered entity is invisible");
  }
  const software =
    softwareAdapterName(observation.page?.adapterInfo) ??
    (SOFTWARE_ADAPTER_TEXT.test(observation.page?.adapter ?? "") ? observation.page?.adapter : undefined);
  if (software !== undefined) {
    warnings.push(
      `${software} is a software renderer, so these numbers are not this machine's — run headed under a display (sh scripts/xvfb.sh) to reach the real GPU`,
    );
  }
  if (observation.page !== undefined && observation.page.canvas === undefined) {
    warnings.push("no canvas in the page — nothing can render at all");
  }
  const warmup = observation.startup?.warmup;
  if (warmup !== undefined && warmup.status !== "complete") {
    warnings.push(`warm-up coverage is ${warmup.status}; pipeline completion is not proven`);
  }
  for (const error of observation.page?.consoleErrors.slice(0, 3) ?? []) {
    warnings.push(`console error: ${error}`);
  }
  return warnings;
}

export function summariseScene(observation: ISceneObservation): ISceneOverview {
  const { snapshot } = observation;
  const room = readSceneRoom(snapshot);
  const entities = snapshot.entities ?? [];
  const visible = entities.filter(({ visible }) => visible !== false).length;
  const points = positions(entities);
  const frames = (snapshot.runtimeDiagnosticsSeries ?? []).map(({ frameMs }) => frameMs);
  const frameMs = median(frames);
  const passSplit = (snapshot.runtimeDiagnosticsSeries ?? []).at(-1)?.passes;
  const world = snapshot.gameplay?.world;
  const clips = Object.entries(snapshot.gameplay?.animation ?? {})
    .filter(([, animation]) => animation.advancedFrames > 0)
    .map(([entity, animation]) => `${entity}: ${animation.clip}`);
  const base = {
    entities: { hidden: entities.length - visible, observed: entities.length, visible },
    liveness: liveness(observation),
    ...(observation.page === undefined ? {} : { page: observation.page }),
    ...(observation.projection === undefined
      ? {}
      : {
          projection: {
            batches: observation.projection.batches,
            projecting: observation.projection.projecting,
            reason: observation.projection.reason,
            reasonCode: observation.projection.reasonCode,
            renderables: observation.projection.sourceRenderables,
          },
        }),
    screen: screenVerdict(observation.frame),
    ...(observation.startup === undefined ? {} : { startup: observation.startup }),
    ...(observation.startupMs === undefined ? {} : { startupMs: observation.startupMs }),
    extents:
      points.length === 0
        ? undefined
        : {
            x: axisExtent(points.map(([x]) => x)),
            y: axisExtent(points.map(([, y]) => y)),
            z: axisExtent(points.map(([, , z]) => z)),
          },
    gameplay: {
      clipsAdvancing: clips,
      states: Object.keys(snapshot.gameplay?.states ?? {}).length,
      tags: Object.fromEntries(
        Object.entries(snapshot.gameplay?.tags ?? {}).map(([tag, { count }]) => [tag, count]),
      ),
    },
    ...(room === undefined ? {} : { room }),
    // What is genuinely still dark, recomputed rather than fixed: a bridge that reports the scene
    // has answered two of these, and leaving them listed would send an agent to a screenshot for
    // something the report already holds.
    notObserved:
      room === undefined
        ? [
            "lights, materials and textures — the bridge reports entities, not renderer resources",
            "camera framing beyond its entity transform",
          ]
        : ["texture contents and shader graphs — the bridge counts materials, it does not read them"],
    render: {
      drawCalls: snapshot.performance?.drawCalls,
      fps: frameMs === undefined || frameMs <= 0 ? undefined : Math.round(1000 / frameMs),
      frameMs,
      ...(passSplit === undefined || passSplit.length === 0
        ? {}
        : { passes: passSplit.map(({ draws, kind, triangles }) => ({ draws, kind, triangles })) }),
      triangles: snapshot.performance?.triangles,
      ...(frameMs === undefined ? {} : { vsyncLocked: onVsyncInterval(frameMs) }),
    },
    runtime: {
      clock: snapshot.clock.mode,
      consoleErrors: countConsoleErrors(snapshot),
      core: world?.runtime?.core,
      rapier: world?.runtime?.rapier,
      seed: world?.seed,
      tick: snapshot.clock.tick,
    },
    scale: scaleVerdict(entities),
    url: observation.url,
  };
  return { ...base, warnings: warningsFor(observation, base) };
}

function extentLine(extents: ISceneOverview["extents"]): string {
  if (extents === undefined) return "  extents      not observed";
  // Full precision stays in the JSON; two decimals is what a glance can use.
  const round = (value: number): string => String(Number(value.toFixed(2)));
  const axis = (name: "x" | "y" | "z"): string => {
    const { max, min, size } = extents[name];
    return `${name} ${round(min)}..${round(max)} (${round(size)})`;
  };
  return `  extents      ${axis("x")} · ${axis("y")} · ${axis("z")}`;
}

function startupLine(overview: ISceneOverview): string | undefined {
  const parts: string[] = [];
  if (overview.startupMs !== undefined) parts.push(`bridge answered after ${(overview.startupMs / 1000).toFixed(1)} s`);
  const warmup = overview.startup?.warmup;
  if (warmup !== undefined) {
    const observed = warmup.observed;
    parts.push(
      observed === undefined
        ? `warm-up ${warmup.status}`
        : `warm-up ${warmup.status}: ${observed.created} created / ${warmup.candidates ?? "?"} candidates`,
    );
  }
  const canvas = overview.page?.canvas;
  parts.push(canvas === undefined ? "no canvas" : `canvas ${canvas.width}×${canvas.height} @${canvas.dpr}dpr`);
  if (overview.page?.adapter !== undefined) parts.push(`adapter ${overview.page.adapter}`);
  return overview.startupMs === undefined && overview.page === undefined && overview.startup === undefined
    ? undefined
    : `  startup      ${parts.join(" · ")}`;
}

/**
 * The reference link for the reveal estimate, in megabits per second: a modest home or mobile
 * connection (2.5 MB/s). It is printed with the figure so a reader can rescale it, and the JSON
 * carries the raw bytes. It reports a cost and gates nothing.
 */
export const REVEAL_ESTIMATE_LINK_MBIT = 20;

function revealLine(overview: ISceneOverview): string | undefined {
  const offscreen = overview.startup?.offscreenBytes;
  if (offscreen === undefined) return undefined;
  const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
  const seconds = (offscreen.awaitedBytes * 8) / (REVEAL_ESTIMATE_LINK_MBIT * 1_000_000);
  const parts = [
    `awaited ${mb(offscreen.awaitedBytes)}`,
    `off-screen ${mb(offscreen.offscreenBytes)}`,
    `est. reveal download ${seconds.toFixed(1)} s at ${REVEAL_ESTIMATE_LINK_MBIT} Mbit/s`,
  ];
  if (offscreen.unsizedFiles > 0) parts.push(`${offscreen.unsizedFiles} file(s) with no manifest size`);
  const worst = offscreen.top[0];
  const tail =
    offscreen.offscreenBytes > 0 && worst !== undefined
      ? `\n               largest off-screen: ${offscreen.top.map((file) => `${file.path} ${mb(file.bytes)} (${file.reason})`).join(", ")}${offscreen.warn ? `\n               warning: ${offscreen.fix}` : ""}`
      : "";
  return `  reveal       ${parts.join(" · ")}${tail}`;
}

function screenLine(overview: ISceneOverview): string | undefined {
  const { screen } = overview;
  if (screen === undefined) return undefined;
  return `  screen       ${screen.blank ? "BLANK" : "rendering"} — ${screen.distinctColors.toLocaleString("en-US")} distinct colours, ${(
    screen.brightPixelRatio * 100
  ).toFixed(0)}% bright pixels`;
}

/**
 * The entity count is what the game registered for assertions; this is what the renderer was
 * handed. A game can register two entities and draw fifteen hundred objects, and reading the first
 * number as the second is how a scene looks empty in a report and heavy on the GPU.
 */
function renderablesLine(overview: ISceneOverview): string | undefined {
  const { projection } = overview;
  if (projection?.renderables === undefined) return undefined;
  const state =
    projection.projecting === true
      ? `projection batching ${projection.batches ?? 0} groups`
      : `projection standing down${projection.reasonCode === undefined ? "" : ` (${projection.reasonCode})`}`;
  return `  renderables  ${projection.renderables.toLocaleString("en-US")} handed to the renderer · ${state}`;
}

/**
 * The per-pass split, so a one-shot look says whether the frame is really a colour pass or a
 * shadow/reflection lane the whole-frame draw count hid. Absent when the bridge reports no split.
 */
function passesLine(overview: ISceneOverview): string | undefined {
  const passes = overview.render.passes;
  if (passes === undefined) return undefined;
  const parts = passes.map(
    (pass) => `${pass.kind} ${pass.draws.toLocaleString("en-US")} draws / ${pass.triangles.toLocaleString("en-US")} tris`,
  );
  return `  passes       ${parts.join(" · ")}`;
}

function livenessLine(overview: ISceneOverview): string | undefined {
  const { liveness: state } = overview;
  if (state.ticks === undefined && state.moved === 0) return undefined;
  return `  liveness     ${state.ticks === undefined ? "" : `${state.ticks} ticks between samples · `}${
    state.moved
  } entities moved`;
}

const PROJECTION_PREFIX = "TN_RENDER_PROJECTION:";

/** Read the engine's projection report out of the page's console output. */
export function parseProjectionDiagnostic(
  consoleLines: readonly string[],
): ISceneProjectionDiagnostic | undefined {
  for (const line of [...consoleLines].reverse()) {
    const index = line.indexOf(PROJECTION_PREFIX);
    if (index === -1) continue;
    try {
      return JSON.parse(line.slice(index + PROJECTION_PREFIX.length)) as ISceneProjectionDiagnostic;
    } catch {
      // A truncated or reformatted line is not a diagnostic; keep looking rather than guessing.
    }
  }
  return undefined;
}

export function formatSceneOverview(overview: ISceneOverview): string {
  const { entities, gameplay, render, runtime, scale } = overview;
  const tags = Object.entries(gameplay.tags).map(([tag, count]) => `${tag} ${count}`);
  const lines = [
    `scene overview — ${overview.url}`,
    startupLine(overview),
    revealLine(overview),
    screenLine(overview),
    `  runtime      core ${runtime.core ?? "?"} · rapier ${runtime.rapier ?? "none"} · seed ${
      runtime.seed ?? "none"
    } · clock ${runtime.clock}${runtime.tick === undefined ? "" : ` at tick ${runtime.tick}`}`,
    entities.observed === 0
      ? "  entities     no entities observed — the game may register none, or the bridge sampled before startup"
      : `  entities     ${entities.observed} registered with the bridge, ${entities.visible} visible, ${entities.hidden} hidden`,
    extentLine(overview.extents),
    `  scale        ${scale.verdict}${
      scale.medianEntityScale === undefined
        ? ""
        : ` (median ${scale.medianEntityScale}×, largest ${scale.largestEntityScale}×)`
    }`,
    `  render       ${
      render.drawCalls === undefined ? "draw calls not observed" : `${render.drawCalls} draw calls`
    } · ${
      render.triangles === undefined
        ? "triangles not observed"
        : `${render.triangles.toLocaleString("en-US")} triangles`
    }${
      render.frameMs === undefined
        ? " · frame time not observed"
        : ` · ${render.frameMs.toFixed(1)} ms/frame (${render.fps} fps)`
    }`,
    renderablesLine(overview),
    passesLine(overview),
    ...(overview.room === undefined ? [] : formatRoomLines(overview.room)),
    livenessLine(overview),
    `  gameplay     ${gameplay.states} states · ${
      gameplay.clipsAdvancing.length === 0 ? "no clips advancing" : `clips ${gameplay.clipsAdvancing.join(", ")}`
    }${tags.length === 0 ? "" : ` · tags ${tags.join(", ")}`}`,
    `  console      ${runtime.consoleErrors} errors`,
    ...overview.warnings.map((warning) => `  ⚠  ${warning}`),
    ...overview.notObserved.map((entry) => `  not observed ${entry}`),
  ];
  return `${lines.filter((line): line is string => line !== undefined).join("\n")}\n`;
}

export interface IObserveSceneOptions {
  readonly browserArgs?: readonly string[];
  readonly headless?: boolean;
  /** How long the game runs freely between the two samples that decide whether it is live. */
  readonly settleMs?: number;
  readonly timeoutMs?: number;
  readonly warmupMs?: number;
}

/**
 * Launch a browser, reach the running game's bridge, take one sample, and leave. Nothing here
 * drives input or asserts anything: this reports the scene as found, and a scenario is still what
 * proves the game.
 */
export async function observeScene(
  url: string,
  options: IObserveSceneOptions = {},
): Promise<ISceneObservation> {
  const { chromium } = await import("playwright");
  const { connectPlaytestBridge } = await import("./bridgeClient.js");
  const { resolveBrowserArguments } = await import("./browser.js");
  const { inspectFrame } = await import("../capture.js");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const consoleErrors: string[] = [];
  const consoleLines: string[] = [];
  const browser = await chromium.launch({
    ...(options.browserArgs === undefined ? {} : { args: resolveBrowserArguments(options.browserArgs) }),
    // Headless Chromium serves WebGPU from SwiftShader even with the Vulkan flag, so a machine
    // that has a display gets a headed browser and the GPU its numbers claim to describe.
    headless: options.headless ?? process.env.DISPLAY === undefined,
  });
  try {
    const page = await browser.newPage({ viewport: { height: 720, width: 1280 } });
    page.on("console", (entry) => {
      const text = entry.text();
      consoleLines.push(text);
      if (entry.type() === "error") consoleErrors.push(text);
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
    // Entity registration and the first rendered frames land after the bridge appears, and an
    // overview taken before them reports an empty scene that is not empty.
    await page.waitForTimeout(options.warmupMs ?? 1_500);
    const bridge = await connectPlaytestBridge(
      page,
      {
        assert: { entities: [{ entity: "*", exists: true }] },
        name: "doctor",
        schemaVersion: 1,
        steps: [],
        target: "browser",
        viewport: { height: 720, width: 1280 },
        warmupFrames: 0,
      } as unknown as import("../scenario.js").IPlaytestScenario,
      timeoutMs,
    );
    if (bridge === undefined) {
      throw new Error(
        "TN_PLAYTEST_BRIDGE_MISSING: the page at this URL installs no playtest bridge, so its scene cannot be read. Install playtest() in defineGame, or installThreePlaytestBridge for a plain Three.js project.",
      );
    }
    const readiness = await bridge.readiness();
    const startupMs = Date.now() - startedAt;
    const include = ["diagnostics", "entities", "gameplay", "resources", "runtimeDiagnosticsSeries"];
    const previous = await bridge.sample({ include });
    // Let the game run on its own for a moment: the difference between the two samples is what
    // separates a live scene from one whose loop stopped, and reports a real rendered frame.
    await page.waitForTimeout(options.settleMs ?? 700);
    const snapshot = await bridge.sample({ include });
    const page_ = await pageProbe(page, consoleErrors);
    const frame = await screenshotStats(page, inspectFrame);
    await bridge.close();
    const projection = parseProjectionDiagnostic(consoleLines);
    return {
      description: bridge.description,
      ...(frame === undefined ? {} : { frame }),
      ...(projection === undefined ? {} : { projection }),
      page: page_,
      previous,
      snapshot,
      ...(readiness.startup === undefined ? {} : { startup: readiness.startup }),
      startupMs,
      url,
    };
  } finally {
    await browser.close();
  }
}

async function pageProbe(
  page: import("playwright").Page,
  consoleErrors: readonly string[],
): Promise<IScenePageProbe> {
  const probe = await page
    .evaluate(async () => {
      const canvas = document.querySelector("canvas");
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
      let adapter: string | undefined;
      let adapterInfo: Record<string, string> | undefined;
      if (gpu !== undefined) {
        const found = (await gpu.requestAdapter()) as { info?: Record<string, string> } | null;
        const info = found?.info;
        if (info !== undefined) {
          adapterInfo = Object.fromEntries(
            Object.entries(info).filter(([, value]) => typeof value === "string" && value.length > 0),
          ) as Record<string, string>;
          adapter = [info.vendor, info.architecture, info.device, info.description]
            .filter(Boolean)
            .join(" ")
            .trim();
        }
      }
      return {
        ...(adapter === undefined || adapter.length === 0 ? {} : { adapter }),
        ...(adapterInfo === undefined ? {} : { adapterInfo }),
        ...(canvas === null
          ? {}
          : {
              canvas: {
                dpr: globalThis.devicePixelRatio,
                height: canvas.height,
                width: canvas.width,
              },
            }),
      };
    })
    .catch(() => ({}));
  return { ...probe, consoleErrors: [...consoleErrors] };
}

async function screenshotStats(
  page: import("playwright").Page,
  inspectFrame: (png: Buffer) => ISceneFrameStats,
): Promise<ISceneFrameStats | undefined> {
  try {
    return inspectFrame(await page.screenshot({ type: "png" }));
  } catch {
    // A screenshot can fail on a crashed renderer; the rest of the report is still worth having.
    return undefined;
  }
}
