// Runs one arm's route and reports the frame it produced. Exists so the number PRD-280 opens or
// closes the batch on can be re-taken by CI or by another agent with one command, rather than
// recovered by hand out of a log — every number in this repository's Android-fps hunt was read out
// of these markers by hand once, and that is what `playtest perf` was written to stop.
//
//   pnpm --filter quarry measure -- --arm dense --url http://127.0.0.1:5191
//   pnpm --filter quarry measure -- --displacement-probe     (PRD-668 Phase 1, offline)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Group, type Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
// The probe reads core's source, as the loader spec does: `VirtualGeometryPlugin` is not exported.
import { ClusteredBatch } from "../../../packages/core/src/clustered-batch.js";
import {
  ClusteredMesh,
  VirtualGeometryPlugin,
  updateClusteredMeshes,
} from "../../../packages/core/src/clustered-mesh.js";
import {
  type IOcclusionBuffer,
  occlusionBuffer,
  priceDisplacedSurface,
} from "../../../packages/core/src/displaced-surface.js";
import { InstancedBatch } from "../../../packages/core/src/instanced-batch.js";
import { QUARRY_ARMS, type QuarryArm, bodiesModelPath, parseArm } from "../src/quarry/arm.js";
import { BOULDER_SUBDIVISIONS, boulderPlacements } from "../src/quarry/bodies.js";
import { ROUTE_MARKS, routePose } from "../src/quarry/route.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");

interface IPhase {
  readonly p50: number;
  readonly p95: number;
  readonly samples: number;
}

interface IFrameBudgetWindow {
  readonly fps: number;
  readonly frame: IPhase;
  readonly gpuMs?: number;
  readonly phases: Readonly<Record<string, IPhase>>;
  readonly presented?: IPhase;
  readonly surface?: { readonly drawingBufferHeight: number; readonly drawingBufferWidth: number };
  readonly window: number;
}

export interface IArmMeasurement {
  readonly adapter: unknown;
  readonly arm: QuarryArm;
  readonly target: string;
  readonly drawCalls: number;
  readonly framePresentedMsP50: number;
  readonly fps: number;
  readonly gpuMs: number | null;
  readonly hostGapMsP50: number;
  readonly recut: IRecutMeasurement | null;
  readonly renderMsP50: number;
  readonly renderMsP95: number;
  readonly steadyWindows: number;
  readonly triangles: number;
  readonly view: IViewMeasurement | null;
  readonly viewCull: string;
  readonly viewport: string;
}

/** What the view does not hold, and what it costs to drop it — PRD-600's Phase 1 numbers. */
export interface IViewMeasurement {
  /** Submitted triangles whose cluster bounds or copy sphere lie wholly outside the frustum. */
  readonly outsideTriangles: number;
  /** That, as a share of the triangles the clustered meshes and batch copies submit. */
  readonly outsideShare: number;
  /** Submitted triangles from clustered meshes and batch copies. */
  readonly triangles: number;
  /** Batch copies and how many of them lie outside. */
  readonly copies: number;
  readonly outsideCopies: number;
}

/** The cost of one re-cut: the `#compact` copy and the index upload along the route. */
export interface IRecutMeasurement {
  readonly samples: number;
  readonly ms: number;
  readonly megabytesPerSecond: number;
}

/** One `TN_CLUSTER_VIEW` marker the quarry prints: what the view holds, on a 30-frame cadence. */
interface IViewWindow {
  readonly copies: number;
  readonly frame: number;
  readonly outsideClusters: number;
  readonly outsideCopies: number;
  readonly outsideTriangles: number;
  readonly recutBytes: number;
  readonly recutMs: number;
  readonly recutSamples: number;
  readonly triangles: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("TN_QUARRY_NO_SAMPLES: nothing to take a median of.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`TN_QUARRY_MEASURE_MISSING_ARG: --${name} is required.`);
  }
  return value;
}

function main(): void {
  const arm = parseArm(argument("arm"));
  const target = argument("target", "browser");
  if (target !== "browser" && target !== "desktop")
    throw new Error(
      `TN_QUARRY_MEASURE_TARGET: --target must be browser or desktop, not '${target}'.`,
    );
  const url = argument("url", "http://127.0.0.1:5191");
  // PRD-600's before/after: `--view-cull off` draws every cluster and every copy, exactly as the
  // route drew them before the cut was pruned by the view. The browser lane reads it from the URL;
  // the desktop host has no URL, so its arm is the shipped one and this flag is refused there
  // rather than silently measuring something else.
  const viewCull = argument("view-cull", "on");
  if (viewCull !== "on" && viewCull !== "off")
    throw new Error(
      `TN_QUARRY_MEASURE_VIEW_CULL: --view-cull must be on or off, not '${viewCull}'.`,
    );
  if (target === "desktop" && viewCull === "off")
    throw new Error(
      "TN_QUARRY_MEASURE_VIEW_CULL: the desktop lane has no URL to carry --view-cull; build the arm with it off instead.",
    );
  const artifacts = resolve(
    repositoryRoot,
    target === "browser" ? `artifacts/quarry/${arm}` : `artifacts/quarry/native-${arm}`,
  );
  mkdirSync(artifacts, { recursive: true });

  const browserArguments = [
    resolve(here, "../playtests/quarry-route.playtest.json"),
    "--url",
    `${url}/?arm=${arm}&viewCull=${viewCull}`,
    "--browser-recipe",
    "webgpu",
    // Headed against the real adapter: under the runner's private Xvfb a heavy scene can fall
    // back to SwiftShader, and a software adapter would invent a difference between the arms
    // out of nothing.
    "--headed",
  ];
  const desktopArguments = [
    "playtests/quarry-route-desktop.playtest.json",
    "--target",
    "desktop",
    "--executable",
    `dist-native/quarry-${arm}`,
    "--project",
    resolve(here, ".."),
  ];

  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve(repositoryRoot, "packages/playtest/dist/runner/cli.js"),
        ...(target === "browser" ? browserArguments : desktopArguments),
        "--timeout",
        // Long enough for a software adapter to finish the route. The quarry is bound on GPU work,
        // and on this stack a machine with no usable GPU falls back to SwiftShader, where a route of
        // 1,850 ticks takes minutes of presentation nobody budgeted for when this budget was 5.
        "900000",
        "--artifacts",
        artifacts,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        // The native host picks Wayland otherwise and then reports no display at all.
        env: { ...process.env, SDL_VIDEODRIVER: "x11" },
        maxBuffer: 256 * 1024 * 1024,
      },
    ),
  ) as {
    observations: {
      console: readonly { text: string }[];
      resourceSeries?: readonly { snapshots: Record<string, Record<string, number>> }[];
    };
    pass: boolean;
  };

  if (report.pass !== true)
    throw new Error(`TN_QUARRY_MEASURE_SCENARIO_FAILED: the ${arm} route did not pass.`);

  const windows: IFrameBudgetWindow[] = [];
  const viewWindows: IViewWindow[] = [];
  for (const line of report.observations.console) {
    const view = line.text.indexOf("TN_CLUSTER_VIEW:");
    if (view !== -1) {
      viewWindows.push(
        JSON.parse(line.text.slice(view + "TN_CLUSTER_VIEW:".length)) as IViewWindow,
      );
      continue;
    }
    // The browser lane reports the marker bare; the native host's console arrives through the
    // mailbox with a `[log] ` level prefix, so the marker is found rather than required at
    // column zero.
    const marker = line.text.indexOf("TN_FRAME_BUDGET:");
    if (marker === -1) continue;
    // Fails closed, like `playtest perf`: a marker whose JSON will not parse is a measurement
    // that did not happen, never a sample that quietly vanishes.
    windows.push(
      JSON.parse(line.text.slice(marker + "TN_FRAME_BUDGET:".length)) as IFrameBudgetWindow,
    );
  }
  // Window 1 always lies: it holds the load, the first shader compiles and the first uploads.
  const steady = windows.filter((entry) => entry.window > 1);
  if (steady.length < 2)
    throw new Error(
      `TN_QUARRY_MEASURE_NOT_ENOUGH_WINDOWS: ${steady.length} steady windows, need at least 2.`,
    );

  const last = report.observations.resourceSeries?.at(-1)?.snapshots.GameState;
  if (last === undefined)
    throw new Error("TN_QUARRY_MEASURE_NO_STATE: the run reported no game state.");

  const gpuSamples = steady
    .map((entry) => entry.gpuMs)
    .filter((value): value is number => typeof value === "number");
  const surface = steady[0]?.surface;
  // The view markers buckle to the same window count as the frame budget, so window 1 is dropped
  // for the same reason: it holds the load and the first cuts.
  const steadyViews = viewWindows.filter((entry) => entry.frame > 30);
  const viewOf = (pick: (window: IViewWindow) => number): number =>
    steadyViews.length === 0 ? 0 : median(steadyViews.map(pick));
  const viewTriangles = viewOf((window) => window.triangles);
  const recutSamples = steadyViews.reduce((sum, window) => sum + window.recutSamples, 0);
  const recutMs = steadyViews.reduce((sum, window) => sum + window.recutMs, 0);
  const recutBytes = steadyViews.reduce((sum, window) => sum + window.recutBytes, 0);
  const measurement: IArmMeasurement = {
    // The browser lane names its adapter in `capture.json`; the desktop lane's adapter is the one
    // the host printed into its own log, and claiming otherwise would be inventing evidence.
    adapter:
      target === "browser"
        ? (
            JSON.parse(readFileSync(resolve(artifacts, "capture.json"), "utf8")) as {
              adapter: unknown;
            }
          ).adapter
        : "packed Linux desktop native host (see the run's console.json)",
    arm,
    target,
    viewCull,
    drawCalls: last.drawCalls as number,
    framePresentedMsP50: median(
      steady.map((entry) => entry.presented?.p50).filter((v): v is number => v !== undefined),
    ),
    fps: median(steady.map((entry) => entry.fps)),
    gpuMs: gpuSamples.length === 0 ? null : median(gpuSamples),
    hostGapMsP50: median(steady.map((entry) => entry.phases.hostGap?.p50 ?? 0)),
    recut:
      recutSamples === 0
        ? null
        : {
            megabytesPerSecond:
              recutMs > 0 ? Math.round((recutBytes / 1e3 / recutMs) * 100) / 100 : 0,
            ms: Math.round((recutMs / recutSamples) * 1000) / 1000,
            samples: recutSamples,
          },
    renderMsP50: median(steady.map((entry) => entry.phases.render?.p50 ?? 0)),
    renderMsP95: median(steady.map((entry) => entry.phases.render?.p95 ?? 0)),
    steadyWindows: steady.length,
    triangles: last.triangles as number,
    view:
      steadyViews.length === 0
        ? null
        : {
            copies: Math.round(viewOf((window) => window.copies)),
            outsideCopies: Math.round(viewOf((window) => window.outsideCopies)),
            outsideShare:
              viewTriangles > 0
                ? Math.round(
                    (viewOf((window) => window.outsideTriangles) / viewTriangles) * 1_000,
                  ) / 1_000
                : 0,
            outsideTriangles: Math.round(viewOf((window) => window.outsideTriangles)),
            triangles: Math.round(viewTriangles),
          },
    viewport:
      surface === undefined
        ? "unknown"
        : `${surface.drawingBufferWidth}x${surface.drawingBufferHeight}`,
  };

  writeFileSync(
    resolve(artifacts, "measurement.json"),
    `${JSON.stringify(measurement, null, 2)}\n`,
  );
  console.log(JSON.stringify(measurement, null, 2));
}

/**
 * PRD-668 Phase 1: what Nanite-style dicing would add at each route mark, before a dice pass exists.
 *
 * Offline and read-only: the baked `.glb` files, the same scene `src/game.ts` assembles, the same
 * cut at 1920x1080, then `priceDisplacedSurface` over every triangle the cut submits.
 *
 *   pnpm --filter quarry bake && pnpm --filter quarry measure -- --displacement-probe
 */
async function displacementProbe(): Promise<void> {
  const arm = parseArm(argument("arm", "virtual"));
  const assets = resolve(here, "../public/assets");
  const parse = async (file: string): Promise<Group> => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(assets, file));
    } catch {
      throw new Error(
        `TN_QUARRY_PROBE_NOT_BAKED: ${file} is missing; run pnpm --filter quarry bake.`,
      );
    }
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.register((parser) => new VirtualGeometryPlugin(parser as never) as never);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new Promise<{ scene: Group }>((done, fail) =>
      loader.parse(data as ArrayBuffer, "", done as never, fail),
    );
    return gltf.scene;
  };
  const [floorModel, bodiesModel] = await Promise.all([
    parse("quarry-floor.glb"),
    parse(bodiesModelPath(arm).replace("assets/", "")),
  ]);
  const named = (root: Group, name: string): Mesh => {
    const found = root.getObjectByName(name) as Mesh | undefined;
    if (found?.isMesh !== true) throw new Error(`TN_QUARRY_BODY_MISSING: no mesh named '${name}'.`);
    return found;
  };

  // The scene `src/game.ts` enter() assembles, without its look: the price reads geometry only.
  const scene = new Scene();
  const material = new MeshBasicMaterial();
  for (const [root, name] of [
    [floorModel, "floor"],
    [bodiesModel, "cliff"],
    [bodiesModel, "gantry"],
    [bodiesModel, "grating"],
  ] as const)
    scene.add(named(root, name));
  const placements = boulderPlacements();
  for (let source = 0; source < BOULDER_SUBDIVISIONS.length; source += 1) {
    const template = named(bodiesModel, `boulder-${source}`);
    const batch =
      template instanceof ClusteredMesh
        ? new ClusteredBatch({ geometry: template.geometry, material, table: template.table })
        : new InstancedBatch({ geometry: template.geometry, material });
    for (const placement of placements)
      if (placement.source === source)
        batch.place({
          position: [placement.x, placement.y, placement.z],
          rotation: [0, placement.rotationY, 0],
          scale: placement.scale,
        });
    batch.build({ name: `boulders-${source}`, parent: scene });
  }

  // The game's camera: core's default 60-degree lens, the look's near and far, a 1080p view.
  const width = 1920;
  const height = 1080;
  const camera = new PerspectiveCamera(60, width / height, 0.08, 420);
  const rows = ROUTE_MARKS.map((mark) => {
    const pose = routePose(mark.frame);
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    updateClusteredMeshes(scene, camera, height);
    // Rock displaces: the floor, the cliff and the boulders. The gantry and its grating are metal
    // and alpha-cut, so they are submitted but never diced.
    const submitted = priceDisplacedSurface(scene, camera, height).triangles;
    const rock = scene.children.filter((body) => body.name !== "gantry" && body.name !== "grating");
    // Unreal culls every patch against its HZB; this buffer is a conservative stand-in, a quarter
    // of the view on each axis, rasterized from everything the cut submits.
    const occlusion = occlusionBuffer(scene, camera, width / 4, height / 4);
    const sum = (fadeOutPixels: number, occlusion?: IOcclusionBuffer) => {
      const total = { added: 0, diced: 0, fadeDistance: 0, micro: 0, patches: 0, visible: 0 };
      const by: Record<string, number> = {};
      for (const body of rock) {
        const price = priceDisplacedSurface(body, camera, height, {
          fadeOutPixels,
          ...(occlusion === undefined ? {} : { occlusion }),
        });
        const key = body.name.startsWith("boulders-") ? "boulders" : body.name;
        by[key] = (by[key] ?? 0) + price.addedMicroTriangles;
        total.added += price.addedMicroTriangles;
        total.diced += price.dicedTriangles;
        total.micro += price.microTriangles;
        total.patches += price.patches;
        total.visible += price.visibleTriangles;
        total.fadeDistance = price.fadeDistance;
      }
      return { ...total, by };
    };
    const stock = sum(0, occlusion);
    const faded = sum(1, occlusion);
    const unoccluded = sum(0);
    return {
      added: stock.added,
      addedBy: stock.by,
      addedFadeOn: faded.added,
      addedNoOcclusion: unoccluded.added,
      dicedTriangles: stock.diced,
      fadeDistance: Math.round(faded.fadeDistance * 100) / 100,
      frame: mark.frame,
      microTriangles: stock.micro,
      passes: stock.added <= submitted,
      patches: stock.patches,
      pose: mark.label,
      ratio: Math.round((stock.added / submitted) * 1000) / 1000,
      submitted,
      visibleRock: stock.visible,
    };
  });
  const report = {
    arm,
    diceRatePixels: 2,
    gate: rows.every((row) => row.passes) ? "PASS" : "FAIL",
    magnitudeMetres: 0.04,
    rows,
    rule: "added micro-triangles <= submitted triangles in every pose (Unreal stock: fade off; patches culled by frustum and a conservative occlusion buffer)",
    viewport: `${width}x${height}`,
  };
  const out = resolve(repositoryRoot, "artifacts/quarry/displacement-probe.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.table(rows);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv.includes("--displacement-probe")) await displacementProbe();
else {
  if (!QUARRY_ARMS.includes(process.argv[process.argv.indexOf("--arm") + 1] as QuarryArm))
    throw new Error(`TN_QUARRY_MEASURE_ARM: --arm must be one of ${QUARRY_ARMS.join(", ")}.`);
  main();
}
