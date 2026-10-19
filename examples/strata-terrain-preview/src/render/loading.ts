import type { IAssetLoader, ICtx } from "@threenative/core";
import {
  type Camera,
  CanvasTexture,
  ClampToEdgeWrapping,
  Mesh,
  MeshBasicMaterial,
  type OrthographicCamera,
  PlaneGeometry,
  type Scene,
  type Texture,
} from "three";
import type { IPropPreparationProgress } from "./propProgress.js";
const palette = { skyLow: 0x142321, skyHigh: 0x304636, accent: 0xb6c586 };

type SpawnStartup = Pick<
  ICtx["startup"],
  "phase" | "progress" | "compileSettled" | "timeline" | "warmup"
>;

function startupSnapshot(startup: SpawnStartup) {
  const warmup = startup.warmup;
  const timeline = startup.timeline;
  return {
    phase: startup.phase,
    progress: startup.progress,
    compileSettled: startup.compileSettled,
    timeline: {
      loadStartedMs: timeline.loadStartedMs,
      enteredMs: timeline.enteredMs,
      compileSettledMs: timeline.compileSettledMs,
      frameworkReadyMs: timeline.frameworkReadyMs,
      readyMs: timeline.readyMs,
    },
    warmup: warmup && {
      status: warmup.status,
      attempted: warmup.attempted,
      candidates: warmup.candidates,
      created: warmup.observed?.created,
      failed: warmup.observed?.failed,
      pending: warmup.observed?.pending,
    },
  };
}

function worldSnapshot(world: IPropPreparationProgress["worlds"][number]) {
  const stats = world.stats();
  return {
    generation: world.uuid.slice(0, 64),
    name: world.name.slice(0, 64),
    parent: world.parent?.uuid.slice(0, 64) ?? null,
    released: world.released,
    residentCells: stats.residentCells,
    loadedCells: stats.loadedCells,
    loadsInFlight: stats.loadsInFlight,
    loadsQueued: stats.loadsQueued,
    pendingPrewarm: stats.pendingPrewarm,
    prewarmMinted: stats.prewarmMinted,
    failures: stats.failures,
    admission: {
      spentMs: stats.admission.spentMs,
      backlog: stats.admission.backlog,
      deferred: stats.admission.deferred,
    },
  };
}

/** A bounded value receipt taken by the spawn gate before rejection or scene teardown. */
export function spawnReadinessSnapshot(input: {
  readonly reason: string;
  readonly atMs: number;
  readonly world: string;
  readonly sceneUuid: string;
  readonly released: boolean;
  readonly gate: { readonly ready: boolean; readonly error: string };
  readonly stage: string;
  readonly propsSettled: boolean;
  readonly preparation?: IPropPreparationProgress;
  readonly coverage?: {
    readonly required: number;
    readonly loaded: number;
    readonly failures: number;
    readonly ready: boolean;
  };
  readonly assets: IAssetLoader["progress"];
  readonly startup: SpawnStartup;
}) {
  const preparation = input.preparation;
  return {
    version: 1,
    reason: input.reason.slice(0, 256),
    atMs: input.atMs,
    world: input.world.slice(0, 64),
    sceneUuid: input.sceneUuid.slice(0, 64),
    released: input.released,
    gate: { ready: input.gate.ready, error: input.gate.error.slice(0, 256) },
    coverage: input.coverage && {
      required: input.coverage.required,
      loaded: input.coverage.loaded,
      failures: input.coverage.failures,
      ready: input.coverage.ready,
    },
    preparation: {
      stage: input.stage.slice(0, 64),
      propsSettled: input.propsSettled,
      phase: preparation?.phase,
      bucket: preparation?.bucket.slice(0, 64),
      added: preparation?.added,
      total: preparation?.total,
      worldCount: preparation?.worlds.length ?? 0,
      prewarmedWorlds: preparation?.prewarmedWorlds ?? 0,
    },
    assets: {
      requested: input.assets.requested,
      settled: input.assets.settled,
      requestedBytes: input.assets.requestedBytes,
      settledBytes: input.assets.settledBytes,
      pendingCount: input.assets.pending.length,
      pending: input.assets.pending.slice(0, 4).map((path) => path.slice(0, 128)),
    },
    startup: startupSnapshot(input.startup),
    worlds: (preparation?.worlds ?? []).slice(0, 4).map(worldSnapshot),
  };
}

/** A one-shot gameplay gate; streaming continues after its launch region is allowed to evict. */
export function createSpawnReadiness(
  label: string,
  budgetMs = 120_000,
  beforeFailure?: (reason: string) => void,
) {
  if (!label.trim() || !Number.isFinite(budgetMs) || budgetMs <= 0)
    throw new Error("Spawn readiness requires a label and positive budget.");
  let ready = false;
  let error = "";
  let cancelled = false;
  let capturingFailure = false;
  let resolve: () => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  function fail(reason: unknown): void {
    if (ready || error || cancelled || capturingFailure) return;
    const message =
      (reason instanceof Error ? reason.message : String(reason)) || `${label} failed`;
    capturingFailure = true;
    try {
      beforeFailure?.(message);
    } catch {
      // A diagnostic must never replace the admission failure or leave its promise pending.
    }
    capturingFailure = false;
    error = message;
    clearTimeout(timer);
    reject(new Error(error));
  }
  const timer = setTimeout(() => fail(`${label} admission exceeded ${budgetMs} ms`), budgetMs);
  return {
    promise,
    fail,
    get ready() {
      return ready;
    },
    get error() {
      return error;
    },
    observe(covered: boolean, failures = 0): void {
      if (ready || error || cancelled || capturingFailure) return;
      if (failures > 0) {
        fail(`${label} assets failed to load`);
        return;
      }
      if (covered) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    },
    cancel(): void {
      if (capturingFailure) return;
      clearTimeout(timer);
      if (!ready && !error && !cancelled) {
        cancelled = true;
        reject(new Error(`${label} cancelled`));
      }
    },
  };
}

/* BEGIN THREENATIVE LOADING APPEARANCE */
/** Edit these source constants for the starter's loading look. */
export const loading = {
  backgroundColor: palette.skyLow,
  backgroundImage: undefined as string | undefined,
  enabled: true,
  fillImage: undefined as string | undefined,
  logoImage: undefined as string | undefined,
  progressColor: palette.accent,
  showStatus: true,
  trackColor: palette.skyHigh,
  bar: { anchorX: 0.5, anchorY: 0.72, height: 12, maxWidth: 520, minWidth: 1, width: 0.62 },
} as const;
/* END THREENATIVE LOADING APPEARANCE */

interface ILoadingHost {
  readonly assets?: { texture(path: string): Promise<Texture> };
  readonly camera: Camera;
  readonly canvasLayer: {
    readonly camera: OrthographicCamera;
    readonly scene: Scene;
    opaque: boolean;
    keepWorldRendering?: boolean;
    renderWorldDuringStartup?: boolean;
  };
  /** Opt out while cold textures prepare; enable the layer again before draw-backed cell prewarm. */
  readonly keepWorldRendering?: boolean;
  readonly renderer: { compileAsync(scene: Scene, camera: Camera): Promise<void> };
  readonly scene: Scene;
  readonly startup: {
    readonly progress: number;
    readonly warmup?: { readonly status: "complete" | "incomplete" | "unavailable" };
    whenReady(): Promise<void>;
  };
  readonly viewport?: {
    readonly safeArea: { height: number; width: number; x: number; y: number };
  };
}

interface ILoadingController {
  update(): void;
  finish(): void;
}

function noOp(layer: ILoadingHost["canvasLayer"]): ILoadingController {
  layer.opaque = false;
  return { finish: () => undefined, update: () => undefined };
}

function meshFor(
  layer: ILoadingHost["canvasLayer"],
  material: MeshBasicMaterial,
  renderOrder: number,
): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  layer.scene.add(mesh);
  return mesh;
}

function imageAspect(texture: Texture | null | undefined): number {
  const image = texture?.image as { height?: number; width?: number } | undefined;
  const width = image?.width ?? 1;
  const height = image?.height ?? 1;
  return width > 0 && height > 0 ? width / height : 1;
}

function configureTexture(texture: Texture): void {
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
}

function setFillUv(geometry: PlaneGeometry, progress: number, base: readonly number[]): void {
  const uv = geometry.getAttribute("uv");
  for (let index = 0; index < uv.count; index += 1) uv.setX(index, (base[index] ?? 0) * progress);
  uv.needsUpdate = true;
}

function coverUv(
  geometry: PlaneGeometry,
  texture: Texture,
  width: number,
  height: number,
  baseU: readonly number[],
  baseV: readonly number[],
): void {
  const imageRatio = imageAspect(texture);
  const boxRatio = width / Math.max(1, height);
  const visibleU = imageRatio > boxRatio ? boxRatio / imageRatio : 1;
  const visibleV = imageRatio < boxRatio ? imageRatio / boxRatio : 1;
  const offsetU = (1 - visibleU) / 2;
  const offsetV = (1 - visibleV) / 2;
  const uv = geometry.getAttribute("uv");
  for (let index = 0; index < uv.count; index += 1) {
    uv.setX(index, offsetU + (baseU[index] ?? 0) * visibleU);
    uv.setY(index, offsetV + (baseV[index] ?? 0) * visibleV);
  }
  uv.needsUpdate = true;
}

function statusMesh(layer: ILoadingHost["canvasLayer"]):
  | {
      mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
      texture: Texture;
      update(value: number | string): void;
    }
  | undefined {
  if (!loading.showStatus || typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 48;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  const texture = new CanvasTexture(canvas);
  const mesh = meshFor(
    layer,
    new MeshBasicMaterial({ depthTest: false, depthWrite: false, map: texture, transparent: true }),
    4,
  );
  let displayedText: string | undefined;
  const update = (value: number | string): void => {
    const text = typeof value === "string" ? value : `${Math.round(value * 100)}%`;
    if (text === displayedText) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.font = "700 20px monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, canvas.height / 2, 980);
    displayedText = text;
    texture.needsUpdate = true;
  };
  update(0);
  return { mesh, texture, update };
}

export function createLoadingScreen(host: ILoadingHost): ILoadingController {
  const layer = host.canvasLayer;
  const previousWorldRendering = layer.keepWorldRendering ?? false;
  const previousStartupRendering = layer.renderWorldDuringStartup ?? true;
  if (!loading.enabled) return noOp(layer);
  const camera = layer.camera;
  const backdrop = meshFor(
    layer,
    new MeshBasicMaterial({ color: loading.backgroundColor, depthTest: false, depthWrite: false }),
    0,
  );
  const track = meshFor(
    layer,
    new MeshBasicMaterial({ color: loading.trackColor, depthTest: false, depthWrite: false }),
    1,
  );
  const fill = meshFor(
    layer,
    new MeshBasicMaterial({ color: loading.progressColor, depthTest: false, depthWrite: false }),
    2,
  );
  const fillBaseU = Array.from({ length: fill.geometry.getAttribute("uv").count }, (_, index) =>
    fill.geometry.getAttribute("uv").getX(index),
  );
  const fillBaseV = Array.from({ length: fill.geometry.getAttribute("uv").count }, (_, index) =>
    fill.geometry.getAttribute("uv").getY(index),
  );
  const logo =
    loading.logoImage === undefined
      ? undefined
      : meshFor(
          layer,
          new MeshBasicMaterial({
            color: 0xffffff,
            depthTest: false,
            depthWrite: false,
            transparent: true,
          }),
          3,
        );
  const status = statusMesh(layer);
  const parts = [
    backdrop,
    track,
    fill,
    ...(logo === undefined ? [] : [logo]),
    ...(status === undefined ? [] : [status.mesh]),
  ];
  const ownedTextures = new Set<Texture>(status === undefined ? [] : [status.texture]);
  let width = 1;
  let height = 1;
  let barWidth = 1;
  let barHeight: number = loading.bar.height;
  let barX = 0;
  let barY = 0;
  let progress = 0;
  let done = false;
  let failed = false;
  let backdropTexture: Texture | undefined;

  const layout = (): void => {
    width = Math.max(1, camera.right - camera.left);
    height = Math.max(1, camera.top - camera.bottom);
    const safe = host.viewport?.safeArea ?? { height, width, x: 0, y: 0 };
    const safeWidth = Math.max(1, Math.min(width, safe.width));
    const safeHeight = Math.max(1, Math.min(height, safe.height));
    const safeX = Math.max(0, Math.min(width - safeWidth, safe.x));
    const safeY = Math.max(0, Math.min(height - safeHeight, safe.y));
    barWidth = Math.max(2, Math.min(loading.bar.maxWidth, safeWidth * loading.bar.width));
    barHeight = Math.max(2, Math.min(loading.bar.height, safeHeight * 0.05));
    barX = safeX + safeWidth * loading.bar.anchorX;
    barY = safeY + safeHeight * loading.bar.anchorY;
    const worldX = (screenX: number): number => camera.left + screenX;
    const worldY = (screenY: number): number => camera.top - screenY;
    const visibleWidth = Math.max(loading.bar.minWidth, barWidth * progress);
    backdrop.scale.set(width, height, 1);
    backdrop.position.set(worldX(width / 2), worldY(height / 2), 0);
    track.scale.set(barWidth, barHeight, 1);
    track.position.set(worldX(barX), worldY(barY), 0);
    fill.scale.set(visibleWidth, barHeight, 1);
    fill.position.set(worldX(barX - barWidth / 2 + visibleWidth / 2), worldY(barY), 0);
    if (logo?.visible) {
      const logoWidth = Math.min(safeWidth * 0.42, 280);
      logo.scale.set(
        logoWidth,
        Math.min(logoWidth / imageAspect(logo.material.map), safeHeight * 0.22),
        1,
      );
      logo.position.set(worldX(barX), worldY(Math.max(safeY, barY - safeHeight * 0.2)), 0);
    }
    if (status !== undefined) {
      status.mesh.scale.set(Math.min(180, safeWidth * 0.32), 48, 1);
      status.mesh.position.set(worldX(barX), worldY(Math.min(height, barY + barHeight * 2.5)), 0);
    }
    if (backdropTexture !== undefined)
      coverUv(backdrop.geometry, backdropTexture, width, height, fillBaseU, fillBaseV);
  };

  const updateProgress = (value: number): void => {
    const bounded = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    // A missing or incomplete backend observation cannot prove that all first-use work is done.
    // Keep the bar visibly indeterminate until readiness removes the cover; never turn unknown
    // coverage into a false 100% claim.
    const observationUnknown =
      host.startup.warmup !== undefined && host.startup.warmup.status !== "complete";
    progress = observationUnknown ? Math.min(0.9, bounded) : bounded;
    setFillUv(fill.geometry, progress, fillBaseU);
    status?.update(progress);
    layout();
  };

  const attachTexture = (mesh: Mesh<PlaneGeometry, MeshBasicMaterial>, texture: Texture): void => {
    if (done) return;
    configureTexture(texture);
    mesh.material.map = texture;
    mesh.material.color.set(0xffffff);
    mesh.material.needsUpdate = true;
    ownedTextures.add(texture);
    if (mesh === backdrop) backdropTexture = texture;
    layout();
    updateProgress(progress);
  };

  const load = (source: string | undefined, mesh: Mesh<PlaneGeometry, MeshBasicMaterial>): void => {
    if (source === undefined || host.assets === undefined) return;
    void host.assets
      .texture(source)
      .then((texture) => attachTexture(mesh, texture))
      .catch(() => undefined);
  };
  load(loading.backgroundImage, backdrop);
  load(loading.fillImage, fill);
  if (logo !== undefined && loading.logoImage !== undefined && host.assets !== undefined) {
    void host.assets
      .texture(loading.logoImage)
      .then((texture) => {
        if (done) return;
        configureTexture(texture);
        logo.material.map = texture;
        logo.material.needsUpdate = true;
        logo.visible = true;
        ownedTextures.add(texture);
        layout();
      })
      .catch(() => undefined);
  }

  layer.opaque = true;
  layer.keepWorldRendering = host.keepWorldRendering ?? true;
  layer.renderWorldDuringStartup = host.keepWorldRendering ?? true;
  layout();
  updateProgress(0);

  const finish = (): void => {
    if (done) return;
    done = true;
    for (const mesh of parts) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    for (const texture of ownedTextures) texture.dispose();
    layer.opaque = false;
    layer.keepWorldRendering = previousWorldRendering;
    layer.renderWorldDuringStartup = previousStartupRendering;
  };

  void (async () => {
    try {
      await host.startup.whenReady();
    } catch (error) {
      if (done) return;
      failed = true;
      layer.keepWorldRendering = previousWorldRendering;
      layer.renderWorldDuringStartup = previousStartupRendering;
      const message = error instanceof Error ? error.message : String(error);
      backdrop.userData.loadingError = message;
      fill.material.color.set(0xe36b5c);
      status?.update(message);
      console.error(`Strata loading failed: ${message}`);
      return;
    }
    if (done) return;
    // Prewarm the world's shaders, but do not wait for them here. `whenReady()` already means the
    // world is safe to show, and compiling a lit, post-processed scene takes far longer than the
    // launch window: hold the screen for it and a playtest — which advances a fixed step as fast
    // as the machine allows — runs an entire scenario behind the launch screen, so every capture
    // photographs the loading bar instead of the game. The prewarm still happens; it no longer
    // decides when the player sees the world.
    try {
      void host.renderer.compileAsync(host.scene, host.camera).catch(() => undefined);
    } catch {
      // A renderer without compileAsync is not a reason to keep the world hidden.
    }
    finish();
  })();

  return {
    finish,
    update(): void {
      if (!done && !failed) updateProgress(host.startup.progress);
    },
  };
}
